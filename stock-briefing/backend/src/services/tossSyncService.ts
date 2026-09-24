import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { TossHolding, TossOpenApiProvider } from "../providers/market/tossOpenApi.js";
import { toMarket } from "../providers/market/kisMaster.js";
import { ProviderError } from "../lib/errors.js";
import { KrwCostBook, RateNotFoundError, type AccountForBook, type OverviewForBook, type SetExactResult } from "./krwCostBook.js";

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
  /** 토스에는 있지만 사용자가 동기화에서 뺀 종목 (건드리지 않음) */
  excluded: string[];
  holdings: Array<TossHolding & { market: string }>;
}

export const SNAPSHOT_KEY = "toss_holdings_codes";
/** 사용자가 "동기화 제외"한 종목 (앱에서 삭제한 토스 종목). 동기화가 다시 넣지 않는다 */
export const EXCLUDED_KEY = "toss_sync_excluded";

export function parseCodes(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
export const DETAIL_KEY = "toss_holdings_detail";

/**
 * 토스가 계산한 종목별 평가 기준 (동기화 때마다 저장). 실시간 가격에 그대로 적용해 토스 앱과 같은 숫자를 낸다.
 *  - purchaseAmount: 매입금액 (종목 통화)
 *  - costRate: 매도 시 예상 수수료·세금 비율 = (평가금액 − 비용 차감 평가금액) / 평가금액. 수수료·거래세는 매도 금액에 비례한다.
 */
export interface TossHoldingDetail {
  quantity: number;
  purchaseAmount: number | null;
  costRate: number | null;
  currency: "KRW" | "USD";
}

export class TossSyncService {
  /** 해외 종목 원화 매입금액 장부 (토스 앱의 원화 손익과 맞추기 위해) */
  readonly costBook: KrwCostBook;
  private accountSeqs: number[] = [];

  constructor(
    private readonly db: Db,
    private readonly toss: TossOpenApiProvider,
    private readonly now: () => Date = () => new Date(),
    /** 토스가 원화 평가에 쓰는 표시 환율 (없으면 원화 장부 보정을 건너뛴다) */
    private readonly displayFx: (() => Promise<number | null>) | null = null,
    log?: { warn(obj: Record<string, unknown>, msg: string): void },
  ) {
    this.costBook = new KrwCostBook({
      db,
      now,
      orders: (account, symbol) => this.toss.ordersForBook(account, symbol),
      rateAt: (iso) => this.rateAt(iso),
      ...(log ? { log } : {}),
    });
  }

  // 과거 환율 조회는 MARKET_INFO 한도(초당 3회) 안에서 천천히, 같은 분은 한 번만. 실패는 던진다(장부가 다음에 다시 시도).
  // 토스에 아예 없는 시각(404, 앞 시각들도 없음)은 RateNotFoundError 로 바꾸고 6시간 기억해 매 동기화마다 다시 묻지 않는다
  private readonly rateCache = new Map<string, number>();
  private readonly rateMissing = new Map<string, number>();
  private rateGate: Promise<unknown> = Promise.resolve();
  private rateAt(iso: string): Promise<number> {
    const minute = iso.slice(0, 16);
    const cached = this.rateCache.get(minute);
    if (cached !== undefined) return Promise.resolve(cached);
    const missingAt = this.rateMissing.get(minute);
    if (missingAt !== undefined && this.now().getTime() - missingAt < 6 * 3_600_000) return Promise.reject(new RateNotFoundError(iso));
    const run = this.rateGate.then(async () => {
      const hit = this.rateCache.get(minute);
      if (hit !== undefined) return hit;
      try {
        const rate = await this.toss.usdKrwAt(iso);
        this.rateCache.set(minute, rate);
        return rate;
      } catch (e) {
        if (e instanceof ProviderError && e.message.includes("exchange-rate-not-found")) {
          this.rateMissing.set(minute, this.now().getTime());
          throw new RateNotFoundError(iso);
        }
        throw e;
      } finally {
        await new Promise((r) => setTimeout(r, 400));
      }
    });
    this.rateGate = run.catch(() => undefined);
    return run;
  }

  /** 계좌 목록이 확인될 때마다 호출 (실시간 체결 구독 갱신용) */
  onAccounts: ((seqs: number[]) => void) | null = null;

  /** 계좌 목록 (실시간 주문 체결 구독에 쓴다). importHoldings 를 한 번 부른 뒤에 채워진다 */
  get accounts(): number[] {
    return [...this.accountSeqs];
  }

  private async lastSnapshot(): Promise<string[]> {
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", SNAPSHOT_KEY).executeTakeFirst();
    return parseCodes(row?.value);
  }

  private async excluded(): Promise<Set<string>> {
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", EXCLUDED_KEY).executeTakeFirst();
    return new Set(parseCodes(row?.value));
  }

  private async saveSnapshot(codes: string[]): Promise<void> {
    const value = JSON.stringify(codes);
    await this.db
      .insertInto("meta")
      .values({ key: SNAPSHOT_KEY, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();
  }

  private async saveDetail(holdings: TossHolding[]): Promise<void> {
    const detail: Record<string, TossHoldingDetail> = {};
    for (const h of holdings) {
      const mv = h.marketValue ?? null, after = h.marketValueAfterCost ?? null;
      detail[h.code] = {
        quantity: h.quantity,
        purchaseAmount: h.purchaseAmount ?? null,
        costRate: mv && after !== null && mv > 0 ? Math.max(0, (mv - after) / mv) : null,
        currency: h.currency,
      };
    }
    const value = JSON.stringify({ syncedAt: seoulIso(this.now()), items: detail });
    await this.db.insertInto("meta").values({ key: DETAIL_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }

  async importHoldings(): Promise<ImportResult> {
    const accounts = await this.toss.accounts();
    // 계좌 목록이 비면 일시 오류로 본다 (그대로 진행하면 토스에서 가져온 종목이 전부 전량 매도로 처리된다)
    if (accounts.length === 0) throw emptyAccounts();
    this.accountSeqs = accounts.map((a) => a.accountSeq);
    this.onAccounts?.(this.accountSeqs);
    const merged = new Map<string, TossHolding>();
    const perAccount: PerAccount[] = [];
    for (const a of accounts) {
      // 보유 종목과 계좌 요약을 한 응답에서 (원화 장부 보정은 둘이 같은 시점이어야 맞는다)
      const { items, overview } = await this.toss.holdingsWithOverview(a.accountSeq);
      perAccount.push({ account: a.accountSeq, holdings: items, overview });
      for (const h of items) {
        const prev = merged.get(h.code);
        if (!prev) merged.set(h.code, h);
        else {
          // 여러 계좌에 같은 종목이 있으면 수량 합산, 평단은 수량 가중 평균
          const q = prev.quantity + h.quantity;
          const avg = prev.avgPrice !== null && h.avgPrice !== null ? (prev.avgPrice * prev.quantity + h.avgPrice * h.quantity) / q : prev.avgPrice ?? h.avgPrice;
          const add = (a: number | null | undefined, b: number | null | undefined) => (a !== null && a !== undefined && b !== null && b !== undefined ? a + b : null);
          merged.set(h.code, {
            ...prev,
            quantity: q,
            avgPrice: avg === null ? null : Math.round(avg * 100) / 100,
            purchaseAmount: add(prev.purchaseAmount, h.purchaseAmount),
            marketValue: add(prev.marketValue, h.marketValue),
            marketValueAfterCost: add(prev.marketValueAfterCost, h.marketValueAfterCost),
          });
        }
      }
    }
    const holdings = [...merged.values()].filter((h) => h.quantity > 0);
    const infos = holdings.length ? await this.toss.stockInfos(holdings.map((h) => h.code)).catch(() => new Map()) : new Map();
    const result: ImportResult = { accounts: accounts.length, added: [], updated: [], unchanged: [], removed: [], excluded: [], holdings: [] };
    const ts = seoulIso(this.now());
    const excluded = await this.excluded();
    for (const h of holdings) {
      const info = infos.get(h.code) as { name?: string; market?: string } | undefined;
      const name = info?.name || h.name || h.code;
      const market = toMarket(info?.market ?? (h.currency === "USD" ? "US" : "UNKNOWN"));
      result.holdings.push({ ...h, name, market });
      // 앱에서 "동기화 제외"(토스 종목 삭제)한 종목은 다시 넣거나 고치지 않는다
      if (excluded.has(h.code)) {
        result.excluded.push(h.code);
        continue;
      }
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
      if (nowCodes.has(code) || excluded.has(code)) continue;
      const existing = await this.db.selectFrom("registered_stocks").select(["code", "quantity"]).where("code", "=", code).executeTakeFirst();
      if (!existing || !existing.quantity) continue;
      await this.db.updateTable("registered_stocks").set({ quantity: null, avg_price: null, updated_at: ts }).where("code", "=", code).execute();
      result.removed.push(code);
    }
    await this.saveSnapshot([...nowCodes]);
    await this.saveDetail(holdings);
    await this.updateCostBook(perAccount);
    return result;
  }

  /** 해외 종목 원화 매입금액 장부 갱신. 실패해도 동기화 자체는 성공으로 둔다(장부는 다음 동기화에서 다시) */
  private async updateCostBook(perAccount: PerAccount[]): Promise<void> {
    try {
      // 계좌 수익률은 계좌마다 따로라 합칠 수 없다 → 계좌가 하나일 때만 계좌 합계로 보정한다
      const overview = perAccount.length === 1 ? perAccount[0]!.overview : null;
      const fx = this.displayFx ? await this.displayFx().catch(() => null) : null;
      await this.costBook.update(forBook(perAccount), overview, fx);
    } catch {
      /* 원화 장부는 다음 동기화에서 다시 시도 */
    }
  }

  private async readAccounts(): Promise<PerAccount[]> {
    const out: PerAccount[] = [];
    const accounts = await this.toss.accounts();
    if (accounts.length === 0) throw emptyAccounts();
    for (const a of accounts) {
      const { items, overview } = await this.toss.holdingsWithOverview(a.accountSeq);
      out.push({ account: a.accountSeq, holdings: items, overview });
    }
    return out;
  }

  /**
   * 토스 앱에서 본 해외 종목 원화 매입금액(원화 보기의 평가금액 − 평가손익)을 정확한 값으로 넣는다.
   * 장부가 잠금 안에서 토스 보유를 새로 읽어(보유 → 주문 → 보유) 그 사이 체결이 없었던 종목만 저장한다.
   * 넣은 뒤 마지막으로 읽은 보유로 장부를 한 번 갱신해 계좌 합계 보정도 다시 계산한다. 반환: 저장한 종목과 못 한 종목·이유
   */
  async setExactKrw(values: Record<string, number>): Promise<SetExactResult> {
    const snap: { last: PerAccount[] } = { last: [] };
    const applied = await this.costBook.setExact(values, async () => {
      snap.last = await this.readAccounts();
      return forBook(snap.last);
    });
    if (snap.last.length > 0) await this.updateCostBook(snap.last);
    return applied;
  }
}

type PerAccount = { account: number; holdings: TossHolding[]; overview: OverviewForBook & { purchaseUsd: number | null } };

function emptyAccounts(): ProviderError {
  return new ProviderError("toss-openapi", "토스 계좌 목록이 비었습니다 (일시 오류일 수 있어 이번 동기화는 건너뜁니다)");
}

function forBook(perAccount: PerAccount[]): AccountForBook[] {
  return perAccount.map((a) => ({
    account: a.account,
    purchaseUsd: a.overview.purchaseUsd,
    holdings: a.holdings.map((h) => ({ code: h.code, currency: h.currency, quantity: h.quantity, purchaseAmount: h.purchaseAmount ?? null })),
  }));
}

export type SyncTrigger = "startup" | "schedule" | "briefing" | "manual" | "order";

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
  /** 실행 중에 체결 알림이 오면, 이번 실행이 체결 전 잔고를 읽었을 수 있어 끝난 뒤 한 번 더 돈다 */
  private rerun = false;
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
    this.rerun = false;
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
      void this.run(trigger)
        .catch(() => null)
        .finally(() => void this.nextDelayMs().then((d) => this.schedule(d, "schedule")));
    }, delayMs);
  }

  /** 한 번 동기화. 이미 실행 중이면 그 결과를 같이 기다린다. 실패해도 던지지 않고 lastError 에 남긴다(manual 은 던짐) */
  async run(trigger: SyncTrigger): Promise<ImportResult | null> {
    if (this.running) {
      // 수동 실행은 자기 결과(와 오류)를 받아야 한다 → 진행 중인 실행이 끝나면 새로 한 번
      if (trigger === "manual") {
        await this.running.catch(() => null);
        return this.run("manual");
      }
      if (trigger === "order") this.rerun = true;
      // 수동 실행이 실패하면 그 실행은 던진다. 같이 기다리던 자동 실행에는 넘기지 않는다(처리 안 된 거부로 서버가 죽지 않게)
      return this.running.catch(() => null);
    }
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
      if (this.rerun) {
        this.rerun = false;
        void this.run("order").catch(() => null);
      }
    }
  }
}
