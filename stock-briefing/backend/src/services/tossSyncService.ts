import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { TossHolding, TossOpenApiProvider } from "../providers/market/tossOpenApi.js";
import { toMarket } from "../providers/market/kisMaster.js";
import { ProviderError, within } from "../lib/errors.js";
import { holdingsWriteLock } from "../lib/mutex.js";
import { ACCOUNT_GONE_MS, KrwCostBook, RateNotFoundError, type AccountForBook, type OverviewForBook, type SetExactResult } from "./krwCostBook.js";

/**
 * 토스증권 계좌의 보유 종목을 registered_stocks 로 가져온다.
 *  - 보유 중인 종목: 없으면 등록, 있으면 수량·평단(·이름)을 토스 값으로 맞춘다. 메모는 유지.
 *  - 지난 동기화 때 토스에 있었는데 이번에 없는 종목(전량 매도): 지우지 않고 수량·평단을 비워 관심 종목으로 남긴다.
 *    실수로 사라진 것처럼 보이지 않게 하고, 브리핑·차트는 계속 볼 수 있게 하기 위해서다.
 *    계좌가 목록에서 빠졌거나 보유 목록이 계좌 요약과 맞지 않게 비면 일시 오류일 수 있어, 그 계좌가 갖고 있던 종목은
 *    그런 응답이 24시간 넘게·두 번 이상 이어질 때 확정한다 (요약에 달러 매입금액이 없어 확인할 수 없으면 30분, 다른 계좌의 전량 매도는 바로 반영).
 *    그동안 다른 계좌에도 있는 그 종목의 수량·평단은 그 계좌 몫이 빠진 합계로 바꾸지 않는다.
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
/**
 * 계좌별로 지난번 토스에서 본 종목(held)과, 응답을 아직 믿지 않는 계좌(목록에서 빠짐·요약과 맞지 않는 빈 보유 목록)를
 * 처음 본 시각·연속 횟수(doubt). 믿지 않는 계좌가 지난번 갖고 있던 종목만 전량 매도 처리를 미룬다
 */
export const ACCOUNTS_KEY = "toss_holdings_accounts";
/** 믿지 않는 계좌 응답이 처음 본 뒤 이만큼 넘게, 두 번 이상 이어져야 그대로 받아들인다 (원화 장부의 계좌 해지 판단과 같은 24시간) */
export const DOUBT_MS = ACCOUNT_GONE_MS;
/**
 * 보유 목록이 비었고 요약의 원화 매입금액은 0 인데 달러 매입금액이 빠져 확인할 수 없는 응답은 이만큼만 기다린다.
 * 요약이 통째로 빠진 일시 오류와 구별할 수 없어 한 번에 믿지는 않지만, 전부 판 계좌를 하루씩 붙잡아 두지 않게
 */
export const UNSURE_MS = 30 * 60_000;
type AccountsState = { held: Record<string, string[]>; doubt: Record<string, { since: string; count: number }> };

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

/** 저장된 종목별 평가 기준 (DETAIL_KEY 값). 없거나 깨진 값이면 빈 맵 */
export function parseTossDetail(value: string | null | undefined): Map<string, TossHoldingDetail> {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value) as { items?: Record<string, TossHoldingDetail> } | null;
    return new Map(Object.entries(parsed?.items ?? {}));
  } catch {
    return new Map();
  }
}

/**
 * 등록 종목 평가에 쓰는 토스 기준(매입금액·비용 비율, 해외 종목은 원화 장부까지). 토스에서 가져온 수량과 같을 때만 쓴다.
 * 사용자가 수량을 바꿨거나 잠금 밖에서 수량·평단을 직접 고쳐 기준이 지워졌으면(PF-05) null → 직접 넣은 값으로 계산
 */
export function tossBasisFor(quantity: number | null, detail: TossHoldingDetail | null | undefined): TossHoldingDetail | null {
  return detail && quantity !== null && Math.abs(detail.quantity - quantity) < 1e-9 ? detail : null;
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
    private readonly log?: { warn(obj: Record<string, unknown>, msg: string): void },
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

  /** 저장된 계좌별 상태. 없거나 깨졌으면 null (이 기록이 생기기 전 서버에서 넘어온 첫 동기화 등) */
  private async accountsState(): Promise<AccountsState | null> {
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", ACCOUNTS_KEY).executeTakeFirst();
    if (!row) return null;
    try {
      const v = JSON.parse(row.value) as { held?: Record<string, unknown>; doubt?: Record<string, { since?: unknown; count?: unknown } | null> } | null;
      const out: AccountsState = { held: {}, doubt: {} };
      for (const [a, codes] of Object.entries(v?.held ?? {})) if (Array.isArray(codes)) out.held[a] = codes.filter((x): x is string => typeof x === "string");
      for (const [a, d] of Object.entries(v?.doubt ?? {}))
        if (typeof d?.since === "string" && typeof d.count === "number") out.doubt[a] = { since: d.since, count: d.count };
      return out;
    } catch {
      return null;
    }
  }

  /** keep: 전량 매도·수량 반영을 미룬 종목 — 지난 평가 기준을 그대로 둔다 */
  private async saveDetail(holdings: TossHolding[], keep: string[] = []): Promise<void> {
    const detail: Record<string, TossHoldingDetail> = {};
    if (keep.length) {
      const row = await this.db.selectFrom("meta").select("value").where("key", "=", DETAIL_KEY).executeTakeFirst();
      const old = parseTossDetail(row?.value);
      for (const c of keep) {
        const d = old.get(c);
        if (d) detail[c] = d;
      }
    }
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
    // 여기부터 DB 쓰기: 앱의 등록·수정·삭제와 겹치지 않게 한 줄로
    const result = await holdingsWriteLock.run(() => this.applyHoldings(accounts.map((a) => a.accountSeq), holdings, infos, perAccount));
    // 원화 장부는 토스(주문 내역·과거 환율)를 부르므로 쓰기 잠금 밖에서 한다 — 토스가 느려도 앱의 등록·수정·삭제가 기다리지 않게.
    // 장부는 자기 잠금으로 한 줄로 저장하고, 등록 종목 쓰기와는 겹치는 데이터가 없다
    await this.updateCostBook(perAccount);
    return result;
  }

  private async applyHoldings(accountSeqs: number[], holdings: TossHolding[], infos: Map<string, unknown>, perAccount: PerAccount[]): Promise<ImportResult> {
    const result: ImportResult = { accounts: accountSeqs.length, added: [], updated: [], unchanged: [], removed: [], excluded: [], holdings: [] };
    const ts = seoulIso(this.now());
    const excluded = await this.excluded();
    const nowCodes = new Set(holdings.map((h) => h.code));
    const snapshot = await this.lastSnapshot();
    // 계좌마다 이번 응답을 그 계좌의 보유로 믿을 수 있는지 본다. 계좌가 목록에서 빠졌거나, 보유 목록이 비었는데 요약의
    // 매입금액이 0 이 아니거나 모르면(원화 장부도 이때는 지우지 않는다) 일시 오류일 수 있어, 그 계좌가 지난번 갖고 있던 종목은
    // 처음 본 뒤 DOUBT_MS(달러 매입금액만 모르면 UNSURE_MS) 넘게·두 번 이상 이어질 때까지 믿지 않는다 (동기화가 몇 초 간격으로 몰려도 확정되지 않게)
    const saved = await this.accountsState();
    const prev: AccountsState = saved ?? { held: {}, doubt: {} };
    const nowMs = this.now().getTime();
    const listed = new Map(perAccount.map((a) => [a.account, a]));
    const next: AccountsState = { held: {}, doubt: {} };
    for (const acct of new Set([...listed.keys(), ...Object.keys(prev.held).map(Number)])) {
      const a = listed.get(acct);
      const codes = a ? a.holdings.filter((h) => h.quantity > 0).map((h) => h.code) : [];
      const clear = !!a && (codes.length > 0 || (a.overview.purchaseUsd === 0 && a.overview.purchaseKrw === 0));
      const unsure = !!a && codes.length === 0 && a.overview.purchaseKrw === 0 && a.overview.purchaseUsd === null;
      // 계좌별 기록이 없으면(첫 동기화) 지난 스냅샷 중 지금 어느 계좌에도 없는 종목을 요약과 맞지 않는 빈 계좌 몫으로 본다
      // (달러 요약만 없는 빈 계좌는 늘 빈 계좌일 수 있어 다른 계좌의 전량 매도를 붙잡지 않는다)
      const kept = saved ? prev.held[String(acct)] ?? [] : unsure ? [] : snapshot.filter((c) => !nowCodes.has(c));
      if (!clear && kept.length > 0) {
        const d = prev.doubt[String(acct)];
        const doubt = d ? { since: d.since, count: d.count + 1 } : { since: seoulIso(this.now()), count: 1 };
        if (!(doubt.count >= 2 && nowMs - Date.parse(doubt.since) >= (unsure ? UNSURE_MS : DOUBT_MS))) {
          next.held[String(acct)] = kept;
          next.doubt[String(acct)] = doubt;
          continue;
        }
      }
      // 믿을 수 있는 응답(또는 오래 이어진 응답): 이번 보유가 그 계좌의 보유다. 목록에서 사라진 계좌는 기록을 지운다
      if (a) next.held[String(acct)] = codes;
    }
    /** 믿지 않는 계좌가 지난번 갖고 있던 종목 (이번 합계에서 그 계좌 몫이 빠졌을 수 있어 지난 값·평가 기준·제외 목록을 그대로 둔다) */
    const guarded = new Set(Object.keys(next.doubt).flatMap((a) => next.held[a] ?? []));
    /** 다른 계좌에서는 보이지만 믿지 않는 계좌 몫이 빠졌을 수 있어 수량·평단을 고치지 않은 종목 */
    const frozen: string[] = [];
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
      } else if (guarded.has(h.code)) {
        frozen.push(h.code);
        result.unchanged.push(h.code);
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
    // 전량 매도: 지난번엔 토스에 있었는데 지금은 없는 종목 → 보유 정보만 비운다 (믿지 않는 계좌 몫은 미룬다)
    const pending = [...guarded].filter((c) => !nowCodes.has(c)).sort();
    for (const code of snapshot) {
      if (nowCodes.has(code) || excluded.has(code) || guarded.has(code)) continue;
      const existing = await this.db.selectFrom("registered_stocks").select(["code", "quantity"]).where("code", "=", code).executeTakeFirst();
      if (!existing || !existing.quantity) continue;
      await this.db.updateTable("registered_stocks").set({ quantity: null, avg_price: null, updated_at: ts }).where("code", "=", code).execute();
      result.removed.push(code);
    }
    if (pending.length || frozen.length)
      this.log?.warn({ codes: pending, frozen, doubt: next.doubt }, "토스 계좌 응답이 목록·요약과 맞지 않아 그 계좌 종목의 전량 매도·수량 반영을 미룸");
    await this.saveSnapshot([...nowCodes, ...pending]);
    // 토스에서 전량 매도된(확정된) 종목은 제외 목록에서도 뺀다 — 나중에 다시 사면 다시 가져온다
    const keep = [...excluded].filter((c) => nowCodes.has(c) || guarded.has(c));
    if (keep.length !== excluded.size) {
      const value = JSON.stringify(keep.sort());
      await this.db.insertInto("meta").values({ key: EXCLUDED_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    }
    const state = JSON.stringify(next);
    if (!saved || state !== JSON.stringify(prev))
      await this.db.insertInto("meta").values({ key: ACCOUNTS_KEY, value: state }).onConflict((oc) => oc.column("key").doUpdateSet({ value: state })).execute();
    const frozenSet = new Set(frozen);
    await this.saveDetail(holdings.filter((h) => !frozenSet.has(h.code)), [...pending, ...frozen]);
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
    const result = await this.costBook.setExact(values, async () => {
      snap.last = await this.readAccounts();
      return forBook(snap.last);
    });
    if (snap.last.length > 0) await this.updateCostBook(snap.last);
    return this.deferManual(result);
  }

  /**
   * 직접 넣은 수량·평단으로 평가 중인 등록 종목(토스 기준이 없거나 수량이 다름)은 원화 장부를 평가에 쓰지 않는다 (PF-05).
   * 값은 장부에 그대로 두고(다음 동기화가 토스 값·기준을 다시 채우면 쓴다) applied 대신 skipped(manual)로 돌려준다
   * → 앱이 "원화 손익이 토스 앱과 같은 기준으로 계산됩니다"라고 안내하지 않게. 등록하지 않은 종목은 전처럼 applied
   */
  private async deferManual(result: SetExactResult): Promise<SetExactResult> {
    if (!result.applied.length) return result;
    const [rows, detailRow] = await Promise.all([
      this.db.selectFrom("registered_stocks").select(["code", "quantity"]).where("code", "in", result.applied).execute(),
      this.db.selectFrom("meta").select("value").where("key", "=", DETAIL_KEY).executeTakeFirst(),
    ]);
    const detail = parseTossDetail(detailRow?.value);
    const manual = new Set(rows.filter((s) => !tossBasisFor(s.quantity, detail.get(s.code))).map((s) => s.code));
    if (!manual.size) return result;
    return {
      applied: result.applied.filter((c) => !manual.has(c)),
      skipped: [...result.skipped, ...result.applied.filter((c) => manual.has(c)).map((code) => ({ code, reason: "manual" as const }))],
    };
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
      /** 동기화가 성공할 때마다 (토스 대조 등). 실패해도 동기화는 성공으로 둔다 */
      onResult?: (r: ImportResult) => Promise<void>;
      intervalMin: number;
      idleIntervalMin?: number;
      startupDelayMs?: number;
      /** 정기 브리핑 직전 동기화를 기다리는 최대 시간(ms). 기본 30초 */
      briefingWaitMs?: number;
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

  /** 정기 브리핑 직전 동기화. 토스가 느려도 브리핑이 오래 밀리지 않게 briefingWaitMs 까지만 기다린다 (동기화는 뒤에서 마저 끝난다) */
  async beforeBriefing(): Promise<void> {
    await within(this.run("briefing"), this.deps.briefingWaitMs ?? 30_000, null);
  }

  /**
   * 한 번 동기화. 이미 실행 중이면 그 결과를 같이 기다린다. 실패해도 던지지 않고 lastError 에 남긴다(manual 은 던짐).
   * 자동 동기화를 껐으면(intervalMin 0) 수동 실행만 한다 — 꺼져 있으면 잠그지 않아 직접 고친 수량·평단을 브리핑 직전 동기화가 덮어쓰지 않게
   */
  async run(trigger: SyncTrigger): Promise<ImportResult | null> {
    if (!this.enabled && trigger !== "manual") return null;
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
        // 대조처럼 시세를 다시 받는 뒷일은 기다리지 않는다 (수동 동기화·브리핑 전 동기화가 느려지지 않게)
        void this.deps.onResult?.(r).catch((e: unknown) => this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, "동기화 후 처리 실패"));
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
