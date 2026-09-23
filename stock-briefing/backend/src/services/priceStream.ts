import type { EventEmitter } from "node:events";
import type { LiveTick, LiveTicks, QuickPriceSource } from "../providers/market/tossRealtime.js";
import type { ChainLogger } from "../providers/market/chain.js";

/**
 * 서버 → 앱 실시간 가격 스트림 (웹소켓 /api/stream).
 *  - 토스 Open API 웹소켓(TossRealtime)이 있으면 체결 이벤트를 그대로 받아 연결된 앱 전부에 뿌린다.
 *  - 없으면(또는 보조로) 앱이 하나라도 붙어 있는 동안만 quickPrices(토스 웹 stock-prices) 를 pollMs 마다 읽어
 *    바뀐 가격만 보낸다. 아무도 안 붙어 있으면 폴링도 멈춰 외부 호출을 만들지 않는다.
 *  - 메시지: {type:"snapshot", ticks:[...]} 접속 직후 1회, {type:"tick", ...} 가격 변동마다, {type:"ping"} 25초마다.
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
  log?: ChainLogger;
}

export class PriceStream {
  private readonly clients = new Set<StreamSocket>();
  private readonly last = new Map<string, StreamTick>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly onLiveTick = (tick: LiveTick) => this.publish({ ...tick, source: "toss-openapi" });

  constructor(private readonly deps: PriceStreamDeps) {
    deps.live?.on("tick", this.onLiveTick);
  }

  status() {
    return { clients: this.clients.size, polling: this.pollTimer !== null, tracked: this.last.size };
  }

  attach(socket: StreamSocket): void {
    this.clients.add(socket);
    const drop = () => this.detach(socket);
    socket.on("close", drop);
    socket.on("error", drop);
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
    this.pollTimer = null;
    this.pingTimer = null;
  }

  /** quickPrices 로 등록 종목 가격을 읽어 바뀐 것만 보낸다. 웹소켓이 살아 있는 종목은 웹소켓 값이 우선이다 */
  async poll(): Promise<void> {
    const q = this.deps.quickPrices;
    if (!q || this.polling || this.clients.size === 0) return;
    this.polling = true;
    try {
      const codes = await this.deps.codes();
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

  private publish(tick: StreamTick): void {
    if (!this.remember(tick) || this.clients.size === 0) return;
    this.broadcast(JSON.stringify({ type: "tick", ...tick }));
  }

  private broadcast(data: string): void {
    for (const c of this.clients) this.safeSend(c, data);
  }

  private safeSend(socket: StreamSocket, data: string): void {
    try {
      if (socket.readyState !== undefined && socket.readyState !== 1) return;
      socket.send(data);
    } catch {
      this.detach(socket);
    }
  }
}
