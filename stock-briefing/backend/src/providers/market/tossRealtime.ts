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
  status(): { enabled: boolean; connected: boolean; subscribed: string[]; lastMessageAt: string | null; lastError: string | null; lastAliveAt?: string | null };
}

/** 웹소켓 없이 REST 로 여러 종목 현재가를 한 번에 받는 소스 (토스 웹 stock-prices 등) */
export interface QuickPriceSource {
  readonly name: string;
  getMany(codes: string[]): Promise<Map<string, LiveTick>>;
  /**
   * 종목별 세션 사실 (초록 점 판단용, services/liveSession). 받아 둔 값만 바로 돌려주고, 없거나 오래됐으면 뒤에서 새로 받는다.
   * 없는 소스(예전·가짜)면 세션은 시각·달력만으로, 자격은 모름(null)으로 본다
   */
  sessionFacts?(codes: string[]): Map<string, StockSessionFacts>;
}

/** 종목 하나의 세션 사실. 모르는 칸은 null (토스 웹 비공식 응답이라 칸이 빠질 수 있다 → 모름으로, 아무 값으로나 채우지 않는다) */
export interface StockSessionFacts {
  /** 미국 주간거래(데이마켓) 대상 — 토스 stock-infos daytimePriceSupported */
  daytime: boolean | null;
  /** 넥스트레이드(NXT) 거래 대상 — stock-infos nxtSupported */
  nxt: boolean | null;
  /** 거래정지 (tradingSuspended·krxTradingSuspended) */
  halted: boolean | null;
  /** NXT 거래정지 (nxtTradingSuspended) */
  nxtHalted: boolean | null;
  /** ETF·ETN (stock-infos group.code EF·EN) — 한국거래소 애프터마켓(16:00~20:00)에서 거래되지 않는다. 모르면 null */
  etp: boolean | null;
  /** 토스 시세의 거래소 구분: "integrated"(KRX+NXT) · "krx"(KRX 만). 모르면 null */
  exchange: string | null;
  /** 토스 웹 일괄 시세로 이 종목 가격을 마지막으로 받은 시각(ms). 그 뒤 일괄 조회가 실패했거나 받은 적 없으면 null */
  pricedAt: number | null;
}

/** 테스트에서 가짜 소켓을 넣기 위한 최소 인터페이스 */
export interface SocketLike extends EventEmitter {
  send(data: string): void;
  close(): void;
  /** 핸드셰이크 중이어도 바로 끊는다 (ws). 없으면 close() */
  terminate?(): void;
  readyState?: number;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

/** 핸드셰이크 응답을 기다리는 최대 시간. 넘으면 ws 가 끊고 close 를 낸다 (멈춘 핸드셰이크가 소켓을 붙잡지 않게) */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** 첫 재연결 대기. 실패할 때마다 두 배, 최대 2분 */
const RECONNECT_MS = 5_000;

export class TossRealtime extends EventEmitter implements LiveTicks {
  private socket: SocketLike | null = null;
  /** 토큰을 받는 중 (연결 시도는 한 번에 하나 — 겹치면 소켓이 둘 생겨 옛 소켓의 close 가 살아 있는 연결을 끊긴 것으로 만든다) */
  private connecting = false;
  /**
   * 핸드셰이크가 401(토큰 무효)로 거절된 토큰 → 다음 연결은 이보다 새 토큰으로 (REST 가 그 사이 새로 받았으면 그것을, 아니면 한 번 새로 받는다).
   * 조건 없이 새로 받으면 REST 요청들이 방금 받은 토큰을 무효로 만든다 (클라이언트당 토큰 1개)
   */
  private rejectedToken: string | null = null;
  private codes: string[] = [];
  /** 내 주문·체결 이벤트(personal:order)를 받을 계좌 */
  private accounts: string[] = [];
  private subscribed: string[] = [];
  private lastAliveAt: string | null = null;
  private readonly ticks = new Map<string, LiveTick>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
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
      /** 첫 재연결 대기 (기본 5초) */
      reconnectMs?: number;
      /** 핸드셰이크 응답 대기 (기본 10초, 기본 소켓만) */
      handshakeTimeoutMs?: number;
      now?: () => Date;
    } = {},
  ) {
    super();
    this.backoffMs = opts.reconnectMs ?? RECONNECT_MS;
  }

  private get log(): TossOpenApiLogger {
    return this.opts.log ?? { warn: () => {} };
  }

  get(code: string): LiveTick | null {
    return this.ticks.get(normalizeCode(code)) ?? null;
  }

  status() {
    return { enabled: !this.stopped, connected: this.connected, subscribed: [...this.subscribed], lastMessageAt: this.lastMessageAt, lastError: this.lastError, lastAliveAt: this.lastAliveAt };
  }

  /** 구독할 종목 전체 목록(등록 종목). 100건 초과분은 버린다. 연결돼 있으면 바로 재선언한다. */
  setCodes(codes: string[]): void {
    const next = [...new Set(codes.map(normalizeCode))].slice(0, 100);
    const same = next.length === this.codes.length && next.every((c, i) => c === this.codes[i]);
    this.codes = next;
    if (same) return;
    for (const c of [...this.ticks.keys()]) if (!next.includes(c)) this.ticks.delete(c);
    if (this.connected) this.declare();
    else if (!this.socket && !this.stopped && (next.length > 0 || this.accounts.length > 0)) void this.connect();
  }

  /** 계좌를 알려주면 내 주문 체결 이벤트도 구독한다 (토스 앱에서 사고팔면 즉시 "order" 이벤트) */
  setAccounts(seqs: number[]): void {
    const next = [...new Set(seqs.map(String))].sort();
    if (next.length === this.accounts.length && next.every((c, i) => c === this.accounts[i])) return;
    this.accounts = next;
    if (this.connected) this.declare();
    // 보유·관심 종목이 하나도 없어도 첫 매수를 바로 알 수 있게 연결한다
    else if (!this.socket && !this.stopped && next.length > 0) void this.connect();
  }

  start(): void {
    this.stopped = false;
    if ((this.codes.length > 0 || this.accounts.length > 0) && !this.socket) void this.connect();
  }

  stop(): void {
    this.stopped = true;
    const socket = this.socket;
    if (socket) this.detach(socket);
    this.clearTimers();
    try {
      socket?.close();
    } catch {
      /* 이미 닫힘 */
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  /** 연결 시도. 이미 소켓이 있거나 토큰을 받는 중이면 아무것도 하지 않는다 (setCodes·setAccounts·재연결 타이머가 겹쳐도 소켓은 하나) */
  private async connect(): Promise<void> {
    if (this.stopped || this.socket || this.connecting) return;
    this.connecting = true;
    let token: string;
    try {
      // 401 로 거절된 뒤면 거절된 토큰은 다시 쓰지 않는다
      token = await this.client.getToken(this.rejectedToken ?? undefined);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.scheduleReconnect();
      return;
    } finally {
      this.connecting = false;
    }
    // 토큰을 기다리는 사이 멈췄으면 만들지 않는다
    if (this.stopped || this.socket) return;
    this.rejectedToken = null;
    const factory: SocketFactory =
      this.opts.socketFactory ?? ((url, headers) => new WebSocket(url, { headers, handshakeTimeout: this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS }) as unknown as SocketLike);
    const socket = factory(this.opts.url ?? TOSS_OPENAPI_WS, { authorization: `Bearer ${token}` });
    this.socket = socket;
    // 이벤트는 지금 소켓의 것만 처리한다 — 버린 소켓(멈춤·거절)의 늦은 close·오류가 새 연결의 상태·핑 타이머를 건드리지 않게
    socket.on("open", () => {
      if (this.socket !== socket) return this.hangUp(socket);
      this.connected = true;
      this.backoffMs = this.opts.reconnectMs ?? RECONNECT_MS;
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
    socket.on("message", (data: unknown) => {
      if (this.socket === socket) this.onMessage(String(data));
    });
    socket.on("error", (err: unknown) => {
      if (this.socket !== socket) return; // 핸드셰이크를 직접 끊을 때 나는 오류가 거절 까닭(lastError)을 덮지 않게
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: this.lastError }, "토스증권 실시간 소켓 오류");
    });
    socket.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
      if (this.socket !== socket) return;
      const status = res?.statusCode;
      this.lastError = `handshake HTTP ${status ?? "?"}${status === 403 ? " (허용 IP 미등록?)" : status === 401 ? " (토큰 무효)" : ""}`;
      this.log.warn({ err: this.lastError }, "토스증권 실시간 핸드셰이크 거절");
      if (status === 401) this.rejectedToken = token;
      // 이 이벤트를 들으면 ws 는 핸드셰이크를 끊지 않고 close 도 내지 않는다 → 직접 버리고 끊은 뒤 기다렸다 다시 연결
      // (예전: 소켓이 연결 중 상태로 남아 서버를 다시 켤 때까지 다시 연결하지 않았다)
      this.detach(socket);
      this.hangUp(socket);
    });
    socket.on("close", () => this.detach(socket));
  }

  /** 지금 소켓을 버린다: 연결 상태·구독·타이머를 정리하고 (멈춘 게 아니면) 재연결을 건다. 이미 버린 소켓이면 아무것도 하지 않는다 */
  private detach(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    this.subscribed = [];
    this.clearTimers();
    this.emit("close");
    if (!this.stopped) this.scheduleReconnect();
  }

  /** 소켓을 끊는다 (핸드셰이크 중이어도 — ws terminate, 없으면 close). 끊다 나는 오류는 무시 */
  private hangUp(socket: SocketLike): void {
    try {
      if (socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      /* 이미 닫힘 */
    }
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
    // 연결당 구독 한도는 토픽 100개(종목 + 계좌 합산). 넘으면 선언 전체가 거절되므로 계좌 몫을 먼저 뺀다
    const codes = this.codes.slice(0, Math.max(0, 100 - this.accounts.length));
    const kr = codes.filter(isKrCode);
    const us = codes.filter((c) => !isKrCode(c));
    const decl: Array<Record<string, unknown>> = [{ id: `sub-${Date.now()}` }];
    if (kr.length) decl.push({ type: "trade:kr", codes: kr });
    if (us.length) decl.push({ type: "trade:us", codes: us });
    if (this.accounts.length) decl.push({ type: "personal:order", codes: this.accounts });
    try {
      this.socket.send(JSON.stringify(decl));
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  private onMessage(raw: string): void {
    // 체결이 없어도 PING 응답(pong)까지 포함해 연결이 살아 있다는 신호 (폴링을 맡길지 판단용)
    this.lastAliveAt = (this.opts.now ?? (() => new Date()))().toISOString();
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
    if (msg.topic.startsWith("personal:order")) {
      // { event: PENDING|PARTIAL_FILL|FILL|CANCELED|..., accountSeq, order{...} }
      this.lastMessageAt = nowIso;
      this.emit("order", msg.data);
      return;
    }
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
