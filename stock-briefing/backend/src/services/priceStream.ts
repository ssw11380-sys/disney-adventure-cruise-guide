import type { EventEmitter } from "node:events";
import { normalizeCode } from "../lib/codes.js";
import type { LiveTick, LiveTicks, QuickPriceSource } from "../providers/market/tossRealtime.js";
import type { ChainLogger } from "../providers/market/chain.js";

/**
 * 서버 → 앱 실시간 가격 스트림 (웹소켓 /api/stream).
 *  - 토스 Open API 웹소켓(TossRealtime)이 있으면 체결 이벤트를 그대로 받아 연결된 앱 전부에 뿌린다.
 *  - 없으면(또는 보조로) 앱이 하나라도 붙어 있는 동안만 quickPrices(토스 웹 stock-prices) 를 pollMs 마다 읽어
 *    바뀐 가격만 보낸다. 아무도 안 붙어 있으면 폴링도 멈춰 외부 호출을 만들지 않는다.
 *  - 메시지: {type:"snapshot", ticks:[...]} 접속 직후 1회, 가격 변동은 조용할 땐 바로·몰리면 250ms 마다 모아서, {type:"ping"} 25초마다.
 *    앱이 {type:"hello", batch:true} 를 보내면 {type:"ticks", ticks:[...]} 한 통으로(초당 최대 4통), 아니면(예전 앱) 종목별 {type:"tick"} 으로.
 *    같은 종목의 체결이 250ms 안에 여러 번 오면 마지막 값만 보낸다 (장중 체결이 몰려도 앱이 초당 4번만 다시 그리게, 3-17)
 *  - 토스 웹소켓이 붙어 있으면 웹소켓이 구독한 종목은 폴링하지 않고, 두 시장이 모두 닫혀 있으면 폴링을 30초로 늦춘다.
 *  - 앱은 tick 의 price 로 등락·환산가를 스스로 계산한다(prevClose·환율은 이미 받은 시세에 있음).
 */

export interface StreamTick {
  code: string;
  price: number;
  volume: number | null;
  timestamp: string;
  source: string;
}

export interface StreamSocket {
  send(data: string): void;
  close(): void;
  on(event: "close" | "error" | "message", listener: (...args: unknown[]) => void): unknown;
  readyState?: number;
}

export interface PriceStreamDeps {
  live?: (LiveTicks & EventEmitter) | null;
  quickPrices?: QuickPriceSource | null;
  /** 폴링할 종목 목록 (등록 종목) */
  codes: () => Promise<string[]>;
  pollMs?: number;
  pingMs?: number;
  /** 체결을 모아 보내는 간격 (기본 250ms) */
  batchMs?: number;
  /** 한 시장이라도 열려 있는지 (없으면 늘 열린 것으로). 닫혀 있으면 폴링을 closedPollMs 로 늦춘다 */
  marketOpen?: () => Promise<boolean>;
  closedPollMs?: number;
  log?: ChainLogger;
}

export class PriceStream {
  private readonly clients = new Set<StreamSocket>();
  /** {type:"hello", batch:true} 를 보낸 앱 (한 통에 여러 종목) */
  private readonly batchClients = new WeakSet<StreamSocket>();
  /** 다음 묶음에 보낼 종목별 마지막 체결 */
  private readonly pending = new Map<string, StreamTick>();
  private flushTimer: NodeJS.Timeout | null = null;
  private lastFlushAt = 0;
  private lastPollAt = 0;
  private readonly sent = { messages: 0, bytes: 0 };
  private readonly last = new Map<string, StreamTick>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly onLiveTick = (tick: LiveTick) => this.publish({ ...tick, source: "toss-openapi" });

  constructor(private readonly deps: PriceStreamDeps) {
    deps.live?.on("tick", this.onLiveTick);
  }

  status() {
    return { clients: this.clients.size, polling: this.pollTimer !== null, tracked: this.last.size, sent: { ...this.sent } };
  }

  attach(socket: StreamSocket): void {
    this.clients.add(socket);
    const drop = () => this.detach(socket);
    socket.on("close", drop);
    socket.on("error", drop);
    socket.on("message", (raw: unknown) => {
      try {
        const m = JSON.parse(String(raw)) as { type?: string; batch?: boolean };
        if (m.type === "hello" && m.batch) this.batchClients.add(socket);
      } catch {
        /* 모르는 메시지는 무시 */
      }
    });
    if (this.clients.size === 1) this.startTimers();
    void this.sendSnapshot(socket);
  }

  /** 접속 직후: 웹소켓이 들고 있는 마지막 체결 + 지금까지 보낸 값 전부를 한 번에. 그 뒤 폴링 소스가 있으면 바로 한 번 읽는다 */
  private async sendSnapshot(socket: StreamSocket): Promise<void> {
    try {
      for (const code of await this.deps.codes()) {
        const t = this.deps.live?.get(code);
        if (t) this.remember({ ...t, source: "toss-openapi" });
      }
    } catch {
      /* 종목 목록을 못 읽어도 스냅샷은 보낸다 */
    }
    this.safeSend(socket, JSON.stringify({ type: "snapshot", ticks: [...this.last.values()] }));
    void this.poll();
  }

  private detach(socket: StreamSocket): void {
    if (!this.clients.delete(socket)) return;
    if (this.clients.size === 0) this.stopTimers();
  }

  stop(): void {
    this.stopTimers();
    this.deps.live?.off("tick", this.onLiveTick);
    for (const c of this.clients) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private startTimers(): void {
    if (this.deps.quickPrices && !this.pollTimer) this.pollTimer = setInterval(() => void this.poll(), this.deps.pollMs ?? 3000);
    if (!this.pingTimer) this.pingTimer = setInterval(() => this.broadcast(JSON.stringify({ type: "ping", at: Date.now() })), this.deps.pingMs ?? 25_000);
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.pollTimer = null;
    this.pingTimer = null;
    this.flushTimer = null;
    this.pending.clear();
  }

  /** quickPrices 로 등록 종목 가격을 읽어 바뀐 것만 보낸다. 웹소켓이 살아 있는 종목은 웹소켓 값이 우선이다 */
  async poll(): Promise<void> {
    const q = this.deps.quickPrices;
    if (!q || this.polling || this.clients.size === 0) return;
    this.polling = true;
    try {
      // 두 시장이 모두 닫혀 있으면 closedPollMs(기본 30초)에 한 번만
      const open = this.deps.marketOpen ? await this.deps.marketOpen().catch(() => true) : true;
      if (!open && Date.now() - this.lastPollAt < (this.deps.closedPollMs ?? 30_000)) return;
      this.lastPollAt = Date.now();
      // 토스 웹소켓이 살아 있으면(최근 90초 안에 메시지) 구독한 종목은 체결을 바로 받으므로 폴링하지 않는다
      const covered = wsCovered(this.deps.live?.status() ?? null, Date.now());
      const codes = (await this.deps.codes()).filter((c) => !covered?.has(c));
      if (codes.length === 0) return;
      const ticks = await q.getMany(codes);
      for (const [code, tick] of ticks) {
        const ws = this.deps.live?.get(code);
        // 웹소켓 체결이 폴링 값보다 새로우면 폴링 값은 버린다
        if (ws && Date.parse(ws.timestamp) >= Date.parse(tick.timestamp)) continue;
        this.publish({ code, price: tick.price, volume: tick.volume, timestamp: tick.timestamp, source: q.name });
      }
    } catch (e) {
      this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, "실시간 스트림 폴링 실패");
    } finally {
      this.polling = false;
    }
  }

  /** 마지막 값 갱신. 가격이 실제로 바뀌었을 때만 true (같은 가격의 새 체결은 시각만 갱신) */
  private remember(tick: StreamTick): boolean {
    const prev = this.last.get(tick.code);
    if (prev && prev.timestamp > tick.timestamp) return false;
    this.last.set(tick.code, tick);
    return !prev || prev.price !== tick.price;
  }

  /** 앱에 알림만 보낸다 (예: 잔고가 바뀌었으니 다시 받아 가라) */
  notify(type: "holdings"): void {
    this.broadcast(JSON.stringify({ type, at: Date.now() }));
  }

  private publish(tick: StreamTick): void {
    if (!this.remember(tick) || this.clients.size === 0) return;
    this.pending.set(tick.code, tick);
    if (this.flushTimer) return;
    // 조용하던 중 첫 체결은 바로 보내고(지연 없음), 그 뒤 250ms 안의 체결만 모은다 → 초당 최대 4통
    const batchMs = this.deps.batchMs ?? 250;
    // 시계가 뒤로 가도(NTP) 한 묶음 간격보다 오래 붙잡지 않게
    const wait = Math.min(this.lastFlushAt + batchMs - Date.now(), batchMs);
    if (wait <= 0) this.flush();
    else this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  /** 모아 둔 체결을 한 번에: 새 앱에는 한 통, 예전 앱에는 종목별로 (어느 쪽이든 종목마다 마지막 값 하나) */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    this.lastFlushAt = Date.now();
    const ticks = [...this.pending.values()];
    this.pending.clear();
    const batch = JSON.stringify({ type: "ticks", ticks });
    const singles = ticks.map((t) => JSON.stringify({ type: "tick", ...t }));
    for (const c of this.clients) {
      if (this.batchClients.has(c)) this.safeSend(c, batch);
      else for (const m of singles) this.safeSend(c, m);
    }
  }

  private broadcast(data: string): void {
    for (const c of this.clients) this.safeSend(c, data);
  }

  private safeSend(socket: StreamSocket, data: string): void {
    try {
      if (socket.readyState !== undefined && socket.readyState !== 1) return;
      socket.send(data);
      this.sent.messages++;
      this.sent.bytes += data.length;
    } catch {
      this.detach(socket);
    }
  }
}

/** 구독 목록("trade:kr:005930" 같은 토픽 또는 코드)을 종목 코드로 */
export function topicCode(topic: string): string {
  const parts = topic.split(":");
  return normalizeCode(parts[parts.length - 1] ?? topic);
}

/**
 * 웹소켓이 체결을 주고 있다고 볼 종목들. 연결돼 있고 마지막 신호(체결·주문 또는 60초마다 보내는 PING 의 응답)가 90초 안일 때만
 * (반쯤 끊긴 연결이면 폴링이 계속 뒤를 받친다). 연결 단위 판단이라 구독만 되고 체결이 안 오는 종목까지 가려내지는 못한다
 */
export function wsCovered(live: { connected: boolean; subscribed: string[]; lastMessageAt: string | null; lastAliveAt?: string | null } | null, now: number): Set<string> | null {
  const alive = live?.lastAliveAt ?? live?.lastMessageAt ?? null;
  if (!live?.connected || !alive) return null;
  const last = Date.parse(alive);
  if (!Number.isFinite(last) || now - last > 90_000) return null;
  return new Set(live.subscribed.map(topicCode));
}
