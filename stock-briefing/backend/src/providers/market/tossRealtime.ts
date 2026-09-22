import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { TOSS_OPENAPI_WS, type TossOpenApiClient, type TossOpenApiLogger } from "./tossOpenApi.js";

/**
 * 토스증권 Open API 웹소켓(실시간 체결) 구독.
 *  - 연결: Authorization: Bearer 토큰 헤더. 계정당 동시 연결 2개, 연결당 구독 100건.
 *  - 구독 선언은 배열 1개가 곧 전체(full-replace). 종목 목록이 바뀌면 배열을 다시 보낸다.
 *  - 서버는 180초간 수신이 없으면 끊으므로 60초마다 텍스트 "PING" 을 보낸다.
 *  - 시세는 LOSSY(밀리면 유실) — 마지막 값만 들고 있으면 되는 용도(현재가 표시)에 맞다.
 * 받은 마지막 체결가는 메모리에만 두고, StockService 가 현재가에 덮어쓴다.
 */

export interface LiveTick {
  code: string;
  price: number;
  volume: number | null; // 해당 체결 수량
  timestamp: string; // ISO (+09:00)
  receivedAt: number; // epoch ms
}

export interface LiveTicks {
  get(code: string): LiveTick | null;
  setCodes(codes: string[]): void;
  status(): { enabled: boolean; connected: boolean; subscribed: string[]; lastMessageAt: string | null; lastError: string | null };
}

/** 테스트에서 가짜 소켓을 넣기 위한 최소 인터페이스 */
export interface SocketLike extends EventEmitter {
  send(data: string): void;
  close(): void;
  readyState?: number;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

const defaultSocketFactory: SocketFactory = (url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike;

export class TossRealtime extends EventEmitter implements LiveTicks {
  private socket: SocketLike | null = null;
  private codes: string[] = [];
  private subscribed: string[] = [];
  private readonly ticks = new Map<string, LiveTick>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 5000;
  private stopped = false;
  private connected = false;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly client: TossOpenApiClient,
    private readonly opts: {
      log?: TossOpenApiLogger;
      socketFactory?: SocketFactory;
      url?: string;
      pingIntervalMs?: number;
      now?: () => Date;
    } = {},
  ) {
    super();
  }

  private get log(): TossOpenApiLogger {
    return this.opts.log ?? { warn: () => {} };
  }

  get(code: string): LiveTick | null {
    return this.ticks.get(normalizeCode(code)) ?? null;
  }

  status() {
    return { enabled: !this.stopped, connected: this.connected, subscribed: [...this.subscribed], lastMessageAt: this.lastMessageAt, lastError: this.lastError };
  }

  /** 구독할 종목 전체 목록(등록 종목). 100건 초과분은 버린다. 연결돼 있으면 바로 재선언한다. */
  setCodes(codes: string[]): void {
    const next = [...new Set(codes.map(normalizeCode))].slice(0, 100);
    const same = next.length === this.codes.length && next.every((c, i) => c === this.codes[i]);
    this.codes = next;
    if (same) return;
    for (const c of [...this.ticks.keys()]) if (!next.includes(c)) this.ticks.delete(c);
    if (this.connected) this.declare();
    else if (!this.socket && !this.stopped && next.length > 0) void this.connect();
  }

  start(): void {
    this.stopped = false;
    if (this.codes.length > 0 && !this.socket) void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    let token: string;
    try {
      token = await this.client.getToken();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.scheduleReconnect();
      return;
    }
    const factory = this.opts.socketFactory ?? defaultSocketFactory;
    const socket = factory(this.opts.url ?? TOSS_OPENAPI_WS, { authorization: `Bearer ${token}` });
    this.socket = socket;
    socket.on("open", () => {
      this.connected = true;
      this.backoffMs = 5000;
      this.lastError = null;
      this.declare();
      this.pingTimer = setInterval(() => {
        try {
          socket.send("PING");
        } catch {
          /* close 이벤트에서 처리 */
        }
      }, this.opts.pingIntervalMs ?? 60_000);
      this.emit("open");
    });
    socket.on("message", (data: unknown) => this.onMessage(String(data)));
    socket.on("error", (err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: this.lastError }, "토스증권 실시간 소켓 오류");
    });
    socket.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
      this.lastError = `handshake HTTP ${res?.statusCode ?? "?"}${res?.statusCode === 403 ? " (허용 IP 미등록?)" : res?.statusCode === 401 ? " (토큰 무효)" : ""}`;
      if (res?.statusCode === 401) this.client.getToken(true).catch(() => undefined);
    });
    socket.on("close", () => {
      this.connected = false;
      this.subscribed = [];
      this.socket = null;
      this.clearTimers();
      this.emit("close");
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 120_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  /** 현재 종목 목록으로 구독 선언(배열 1개 = 전체) */
  private declare(): void {
    if (!this.socket || !this.connected) return;
    const kr = this.codes.filter(isKrCode);
    const us = this.codes.filter((c) => !isKrCode(c));
    const decl: Array<Record<string, unknown>> = [{ id: `sub-${Date.now()}` }];
    if (kr.length) decl.push({ type: "trade:kr", codes: kr });
    if (us.length) decl.push({ type: "trade:us", codes: us });
    try {
      this.socket.send(JSON.stringify(decl));
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; topic?: string; data?: Record<string, unknown>; subscribed?: string[]; rejected?: Array<{ code?: string; symbol?: string; topic?: string }>; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // pong 외 텍스트 등
    }
    const nowIso = (this.opts.now ?? (() => new Date()))().toISOString();
    if (msg.type === "subscriptions") {
      this.subscribed = msg.subscribed ?? [];
      if (msg.rejected?.length) this.log.warn({ rejected: msg.rejected }, "토스증권 실시간 구독 일부 거부");
      this.emit("subscriptions", msg);
      return;
    }
    if (msg.type === "error") {
      this.lastError = `${msg.error?.code ?? "error"}: ${msg.error?.message ?? ""}`;
      this.log.warn({ err: this.lastError }, "토스증권 실시간 오류 프레임");
      return;
    }
    if (msg.type !== "message" || !msg.topic || !msg.data) return;
    const parts = msg.topic.split(":"); // trade:us:AAPL
    if (parts[0] !== "trade" || parts.length < 3) return;
    const code = normalizeCode(parts.slice(2).join(":"));
    const price = Number(msg.data["price"]);
    if (!Number.isFinite(price)) return;
    const volume = Number(msg.data["volume"]);
    const tick: LiveTick = {
      code,
      price,
      volume: Number.isFinite(volume) ? volume : null,
      timestamp: typeof msg.data["timestamp"] === "string" ? msg.data["timestamp"] : nowIso,
      receivedAt: Date.now(),
    };
    this.ticks.set(code, tick);
    this.lastMessageAt = nowIso;
    this.emit("tick", tick);
  }
}
