import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { TossHolding, TossOpenApiProvider } from "../providers/market/tossOpenApi.js";
import { toMarket } from "../providers/market/kisMaster.js";

/**
 * 토스증권 계좌의 보유 종목을 registered_stocks 로 가져온다.
 *  - 보유 중인 종목: 없으면 등록, 있으면 수량·평단(·이름)을 토스 값으로 맞춘다. 메모는 유지.
 *  - 지난 동기화 때 토스에 있었는데 이번에 없는 종목(전량 매도): 지우지 않고 수량·평단을 비워 관심 종목으로 남긴다.
 *    실수로 사라진 것처럼 보이지 않게 하고, 브리핑·차트는 계속 볼 수 있게 하기 위해서다.
 *  - 토스에서 가져온 적 없는 등록 종목은 건드리지 않는다(관심 종목이거나 다른 증권사 보유일 수 있으므로).
 * 마지막으로 토스에서 본 종목 목록은 meta 테이블(toss_holdings_codes)에 남겨 재시작 후에도 전량 매도를 알아본다.
 */
export interface ImportResult {
  accounts: number;
  added: string[];
  updated: string[];
  unchanged: string[];
  /** 전량 매도로 관심 종목으로 바뀐 종목 */
  removed: string[];
  holdings: Array<TossHolding & { market: string }>;
}

const SNAPSHOT_KEY = "toss_holdings_codes";

export class TossSyncService {
  constructor(
    private readonly db: Db,
    private readonly toss: TossOpenApiProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async lastSnapshot(): Promise<string[]> {
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", SNAPSHOT_KEY).executeTakeFirst();
    if (!row) return [];
    try {
      const v = JSON.parse(row.value) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private async saveSnapshot(codes: string[]): Promise<void> {
    const value = JSON.stringify(codes);
    await this.db
      .insertInto("meta")
      .values({ key: SNAPSHOT_KEY, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();
  }

  async importHoldings(): Promise<ImportResult> {
    const accounts = await this.toss.accounts();
    const merged = new Map<string, TossHolding>();
    for (const a of accounts) {
      for (const h of await this.toss.holdings(a.accountSeq)) {
        const prev = merged.get(h.code);
        if (!prev) merged.set(h.code, h);
        else {
          // 여러 계좌에 같은 종목이 있으면 수량 합산, 평단은 수량 가중 평균
          const q = prev.quantity + h.quantity;
          const avg = prev.avgPrice !== null && h.avgPrice !== null ? (prev.avgPrice * prev.quantity + h.avgPrice * h.quantity) / q : prev.avgPrice ?? h.avgPrice;
          merged.set(h.code, { ...prev, quantity: q, avgPrice: avg === null ? null : Math.round(avg * 100) / 100 });
        }
      }
    }
    const holdings = [...merged.values()].filter((h) => h.quantity > 0);
    const infos = holdings.length ? await this.toss.stockInfos(holdings.map((h) => h.code)).catch(() => new Map()) : new Map();
    const result: ImportResult = { accounts: accounts.length, added: [], updated: [], unchanged: [], removed: [], holdings: [] };
    const ts = seoulIso(this.now());
    for (const h of holdings) {
      const info = infos.get(h.code) as { name?: string; market?: string } | undefined;
      const name = info?.name || h.name || h.code;
      const market = toMarket(info?.market ?? (h.currency === "USD" ? "US" : "UNKNOWN"));
      result.holdings.push({ ...h, name, market });
      const existing = await this.db.selectFrom("registered_stocks").selectAll().where("code", "=", h.code).executeTakeFirst();
      if (!existing) {
        await this.db
          .insertInto("registered_stocks")
          .values({ code: h.code, name, market, quantity: h.quantity, avg_price: h.avgPrice, memo: null, created_at: ts, updated_at: ts })
          .execute();
        result.added.push(h.code);
      } else if (existing.quantity !== h.quantity || existing.avg_price !== h.avgPrice || existing.name !== name) {
        await this.db
          .updateTable("registered_stocks")
          .set({ quantity: h.quantity, avg_price: h.avgPrice, name, market, updated_at: ts })
          .where("code", "=", h.code)
          .execute();
        result.updated.push(h.code);
      } else {
        result.unchanged.push(h.code);
      }
    }
    // 전량 매도: 지난번엔 토스에 있었는데 지금은 없는 종목 → 보유 정보만 비운다
    const nowCodes = new Set(holdings.map((h) => h.code));
    for (const code of await this.lastSnapshot()) {
      if (nowCodes.has(code)) continue;
      const existing = await this.db.selectFrom("registered_stocks").select(["code", "quantity"]).where("code", "=", code).executeTakeFirst();
      if (!existing || !existing.quantity) continue;
      await this.db.updateTable("registered_stocks").set({ quantity: null, avg_price: null, updated_at: ts }).where("code", "=", code).execute();
      result.removed.push(code);
    }
    await this.saveSnapshot([...nowCodes]);
    return result;
  }
}

export type SyncTrigger = "startup" | "schedule" | "briefing" | "manual";

export interface AutoSyncStatus {
  enabled: boolean;
  intervalMin: number;
  idleIntervalMin: number;
  running: boolean;
  lastRunAt: string | null;
  lastTrigger: SyncTrigger | null;
  lastError: string | null;
  lastChanges: { added: number; updated: number; removed: number; holdings: number } | null;
  nextRunAt: string | null;
}

/**
 * 보유 종목 자동 동기화. 장중(한국·미국 중 하나라도 거래 시간)에는 intervalMin 마다, 장 밖에는 idleIntervalMin 마다,
 * 서버 시작 직후와 정기 브리핑 직전에도 한 번씩 토스 계좌를 읽어 등록 종목의 수량·평단을 맞춘다.
 * 그래서 토스 앱에서 사고팔면 늦어도 10분 안에 이 앱에도 반영된다.
 */
export class HoldingsAutoSync {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ImportResult | null> | null = null;
  private stopped = true;
  private lastRunAt: string | null = null;
  private lastTrigger: SyncTrigger | null = null;
  private lastError: string | null = null;
  private lastChanges: AutoSyncStatus["lastChanges"] = null;
  private nextRunAt: string | null = null;

  constructor(
    private readonly deps: {
      sync: TossSyncService;
      calendar?: MarketCalendar | null;
      /** 동기화가 실제로 무언가를 바꿨을 때 (실시간 구독 갱신 등) */
      afterSync?: (r: ImportResult) => Promise<void>;
      intervalMin: number;
      idleIntervalMin?: number;
      startupDelayMs?: number;
      log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
      now?: () => Date;
    },
  ) {}

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  get enabled(): boolean {
    return this.deps.intervalMin > 0;
  }

  status(): AutoSyncStatus {
    return {
      enabled: this.enabled && !this.stopped,
      intervalMin: this.deps.intervalMin,
      idleIntervalMin: this.deps.idleIntervalMin ?? 60,
      running: this.running !== null,
      lastRunAt: this.lastRunAt,
      lastTrigger: this.lastTrigger,
      lastError: this.lastError,
      lastChanges: this.lastChanges,
      nextRunAt: this.nextRunAt,
    };
  }

  start(): void {
    if (!this.enabled) return;
    this.stopped = false;
    this.schedule(this.deps.startupDelayMs ?? 15_000, "startup");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** 다음 실행까지 기다릴 시간: 장중이면 intervalMin, 아니면 idleIntervalMin */
  async nextDelayMs(): Promise<number> {
    const idle = (this.deps.idleIntervalMin ?? 60) * 60_000;
    const active = this.deps.intervalMin * 60_000;
    if (!this.deps.calendar) return active;
    try {
      const s = await this.deps.calendar.status();
      return s.KR.isOpen || s.US.isOpen ? active : idle;
    } catch {
      return active;
    }
  }

  private schedule(delayMs: number, trigger: SyncTrigger): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = new Date(this.now.getTime() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(trigger).finally(() => void this.nextDelayMs().then((d) => this.schedule(d, "schedule")));
    }, delayMs);
  }

  /** 한 번 동기화. 이미 실행 중이면 그 결과를 같이 기다린다. 실패해도 던지지 않고 lastError 에 남긴다(manual 은 던짐) */
  async run(trigger: SyncTrigger): Promise<ImportResult | null> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const r = await this.deps.sync.importHoldings();
        this.lastError = null;
        this.lastChanges = { added: r.added.length, updated: r.updated.length, removed: r.removed.length, holdings: r.holdings.length };
        if (r.added.length || r.updated.length || r.removed.length) {
          this.deps.log?.info({ trigger, added: r.added, updated: r.updated, removed: r.removed }, "토스 보유 종목 동기화");
          await this.deps.afterSync?.(r);
        }
        return r;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.deps.log?.warn({ trigger, err: this.lastError }, "토스 보유 종목 동기화 실패");
        if (trigger === "manual") throw e;
        return null;
      } finally {
        this.lastRunAt = seoulIso(this.now);
        this.lastTrigger = trigger;
      }
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }
}
