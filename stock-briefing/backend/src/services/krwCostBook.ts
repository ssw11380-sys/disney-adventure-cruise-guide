import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";

/**
 * 해외(달러) 보유 종목의 "원화 매입금액" 장부.
 *
 * 토스 앱은 원화 보기에서 해외 주식 손익을 매수 당시 환율 기준 원화 매입금액으로 계산한다(환차손익 포함).
 * 공식 Open API 는 종목별 원화 매입금액을 주지 않고 달러 매입금액만 준다. 대신
 *  - 계좌 전체 수익률(profitLoss.rateAfterCost, 소수 4자리)이 토스 내부 원화 매입금액 기준으로 나온다(실측 확인).
 *    → 계좌 전체 원화 매입금액 ≈ 비용 차감 후 원화 평가금액 / (1 + rateAfterCost)  (토스 표시 환율로 환산, ±0.01%)
 *  - 주문 내역(주문 하나 = 한 줄, 부분 체결은 누적)과 과거 환율(exchange-rate?dateTime=)을 준다.
 *
 * 장부 항목은 (계좌, 종목) 별이고 원화 매입금액을 두 부분으로 나눠 든다.
 *  - krwExact: 토스 앱 값을 사용자가 넣은 몫. 이후 매도만 있으면 이동평균이라 비율대로 줄 뿐 계속 정확하다.
 *  - krwEst:   체결 시각의 토스 환율로 계산한 몫(새 매수분, 또는 토스 값이 없을 때 전체). 계좌 합계에 맞춰 보정 비율을 곱한다.
 * 새 체결은 orderId 별로 "이미 반영한 수량·금액"을 기억해 차이만 반영한다(시각 비교 없음 → 동기화 도중 체결도 놓치지 않는다).
 * 조회 실패(429·네트워크·환율 없음)는 항목을 건드리지 않고 다음 동기화에서 다시 시도한다.
 */

export interface KrwCostEntry {
  account: number;
  code: string;
  quantity: number;
  usdCost: number;
  krwExact: number;
  krwEst: number;
  /** orderId → 이미 반영한 누적 체결 수량·금액 */
  applied: Record<string, { q: number; amt: number }>;
  /** 주문 내역으로 맞출 수 없어 표시 환율로 임시 계산한 항목 (다음 동기화마다 다시 시도) */
  fallback?: boolean;
  updatedAt: string;
}

export interface KrwCostBookState {
  version: 2;
  items: Record<string, KrwCostEntry>;
  /** 계좌 전체 원화 매입금액 구간. 보유 구성(hash)이 그대로인 동안 동기화마다 좁혀진다 */
  calib: { hash: string; lo: number; hi: number; samples: number } | null;
  /** krwEst 에만 곱하는 보정 비율과, 그 비율을 계산한 보유 구성 */
  factor: number;
  factorHash: string | null;
}

export interface BookOrder {
  orderId: string;
  side: "BUY" | "SELL";
  quantity: number; // 누적 체결 수량
  amount: number; // 누적 체결 금액 (USD)
  at: string; // 마지막 체결 시각 (없으면 주문 시각)
}

export interface HoldingForBook {
  code: string;
  currency: "KRW" | "USD";
  quantity: number;
  purchaseAmount: number | null;
}

export interface OverviewForBook {
  /** 국내(원화) 종목 매입금액 합계 */
  purchaseKrw: number;
  /** 비용 차감 후 평가금액 (원화 종목 / 달러 종목) */
  afterCostKrw: number;
  afterCostUsd: number;
  rateAfterCost: number | null;
}

export interface CostBookDeps {
  db: Db;
  /** (계좌, 종목)의 체결된 주문. 실패하면 던진다 */
  orders: (account: number, symbol: string) => Promise<BookOrder[]>;
  /** 과거 시점의 토스 매수 환율. 실패하면 던진다 */
  rateAt: (iso: string) => Promise<number>;
  now?: () => Date;
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

export type KrwCost = { krw: number; source: "exact" | "estimated"; quantity: number; usdCost: number };

const KEY = "krw_cost_book";
const keyOf = (account: number, code: string) => `${account}:${code}`;
const empty = (): KrwCostBookState => ({ version: 2, items: {}, calib: null, factor: 1, factorHash: null });

export class KrwCostBook {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CostBookDeps) {}

  private get nowIso(): string {
    return seoulIso((this.deps.now ?? (() => new Date()))());
  }

  /** load → 수정 → save 를 한 번에 하나씩 (동기화와 사용자 입력이 서로 덮어쓰지 않게) */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<KrwCostBookState> {
    return KrwCostBook.read(this.deps.db);
  }

  /** 저장된 장부 (없거나 이전 형식·깨진 값이면 빈 장부) */
  static async read(db: Db): Promise<KrwCostBookState> {
    const row = await db.selectFrom("meta").select("value").where("key", "=", KEY).executeTakeFirst();
    if (!row) return empty();
    try {
      const s = JSON.parse(row.value) as Partial<KrwCostBookState>;
      if (s.version !== 2) return empty();
      return { version: 2, items: s.items ?? {}, calib: s.calib ?? null, factor: typeof s.factor === "number" && s.factor > 0 ? s.factor : 1, factorHash: s.factorHash ?? null };
    } catch {
      return empty();
    }
  }

  private async save(state: KrwCostBookState): Promise<void> {
    const value = JSON.stringify(state);
    await this.deps.db.insertInto("meta").values({ key: KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }

  /** 종목별 원화 매입금액 (계좌 합산). estimated 몫에만 보정 비율을 곱한다 */
  static summarize(state: KrwCostBookState): Map<string, KrwCost> {
    const out = new Map<string, KrwCost>();
    for (const e of Object.values(state.items)) {
      const krw = e.krwExact + e.krwEst * state.factor;
      const prev = out.get(e.code);
      const estimated = e.krwEst > 0.5 || !!e.fallback;
      out.set(e.code, {
        krw: (prev?.krw ?? 0) + krw,
        quantity: (prev?.quantity ?? 0) + e.quantity,
        usdCost: (prev?.usdCost ?? 0) + e.usdCost,
        source: prev?.source === "estimated" || estimated ? "estimated" : "exact",
      });
    }
    return out;
  }

  /** 주문의 누적 체결량과 이미 반영한 양의 차이만 이동평균으로 반영한다 */
  private async applyOrders(
    start: { quantity: number; usdCost: number; krwExact: number; krwEst: number; applied: Record<string, { q: number; amt: number }> },
    orders: BookOrder[],
  ): Promise<{ quantity: number; usdCost: number; krwExact: number; krwEst: number; applied: Record<string, { q: number; amt: number }> }> {
    let { quantity: qty, usdCost: usd, krwExact, krwEst } = start;
    const applied = { ...start.applied };
    const deltas = orders
      .map((o) => ({ o, dq: o.quantity - (applied[o.orderId]?.q ?? 0), damt: o.amount - (applied[o.orderId]?.amt ?? 0) }))
      .filter((d) => d.dq > 1e-12)
      .sort((a, b) => Date.parse(a.o.at) - Date.parse(b.o.at));
    for (const { o, dq, damt } of deltas) {
      if (o.side === "BUY") {
        const rate = await this.deps.rateAt(o.at); // 실패하면 던져서 이 종목은 이번에 건너뛴다
        qty += dq;
        usd += damt;
        krwEst += damt * rate;
      } else if (qty > 0) {
        const keep = Math.max(qty - dq, 0) / qty;
        qty = Math.max(qty - dq, 0);
        usd *= keep;
        krwExact *= keep;
        krwEst *= keep;
      }
      applied[o.orderId] = { q: o.quantity, amt: o.amount };
    }
    return { quantity: qty, usdCost: usd, krwExact, krwEst, applied };
  }

  /** 달러 매입금액이 토스 값과 맞는지 (분할·병합은 수량만 바뀌고 매입금액은 같으므로 금액으로 본다) */
  private static matches(usd: number, target: number): boolean {
    return Math.abs(usd - target) < Math.max(0.05, target * 1e-4);
  }

  /**
   * 토스 앱에서 본 원화 매입금액을 정확한 값으로 넣는다 (종목 합계. 여러 계좌면 달러 매입금액 비율로 나눈다).
   * 지금의 주문 상태를 "이미 반영"으로 기록하므로 이후 새 체결만 더해진다.
   */
  setExact(values: Record<string, number>, accounts: Array<{ account: number; holdings: HoldingForBook[] }>): Promise<string[]> {
    return this.exclusive(async () => {
      const state = await this.load();
      const done: string[] = [];
      for (const [code, krw] of Object.entries(values)) {
        if (!(krw > 0) || !Number.isFinite(krw)) continue;
        const rows = accounts.flatMap((a) => a.holdings.filter((h) => h.code === code && h.currency === "USD" && h.purchaseAmount !== null && h.quantity > 0).map((h) => ({ a: a.account, h })));
        const totalUsd = rows.reduce((s, r) => s + r.h.purchaseAmount!, 0);
        if (!rows.length || !(totalUsd > 0)) continue;
        const next: Record<string, KrwCostEntry> = {};
        let ok = true;
        for (const { a, h } of rows) {
          let orders: BookOrder[];
          try {
            orders = await this.deps.orders(a, code);
          } catch (e) {
            this.deps.log?.warn({ code, err: e instanceof Error ? e.message : String(e) }, "원화 매입금액 저장: 주문 내역 조회 실패");
            ok = false;
            break;
          }
          next[keyOf(a, code)] = {
            account: a,
            code,
            quantity: h.quantity,
            usdCost: h.purchaseAmount!,
            krwExact: krw * (h.purchaseAmount! / totalUsd),
            krwEst: 0,
            applied: Object.fromEntries(orders.map((o) => [o.orderId, { q: o.quantity, amt: o.amount }])),
            updatedAt: this.nowIso,
          };
        }
        if (!ok) continue;
        Object.assign(state.items, next);
        done.push(code);
      }
      await this.save(state);
      return done;
    });
  }

  /**
   * 동기화 때마다 호출. accounts: 계좌별 보유 종목(같은 /holdings 응답). overview: 계좌가 하나일 때 그 계좌 요약.
   * displayFx: 토스가 원화 평가에 쓰는 표시 환율.
   */
  update(accounts: Array<{ account: number; holdings: HoldingForBook[] }>, overview: OverviewForBook | null, displayFx: number | null): Promise<KrwCostBookState> {
    return this.exclusive(async () => {
      const state = await this.load();
      const present = new Set<string>();
      for (const { account, holdings } of accounts) {
        for (const h of holdings) {
          if (h.currency !== "USD" || !(h.quantity > 0)) continue;
          const key = keyOf(account, h.code);
          present.add(key);
          if (h.purchaseAmount === null) continue; // 금액이 잠깐 비어도 기존 항목은 그대로 둔다
          const target = h.purchaseAmount;
          const e = state.items[key];
          if (e && !e.fallback && Math.abs(e.quantity - h.quantity) < 1e-9 && KrwCostBook.matches(e.usdCost, target)) continue;
          try {
            const orders = await this.deps.orders(account, h.code);
            if (e && !e.fallback) {
              const cont = await this.applyOrders(e, orders);
              if (KrwCostBook.matches(cont.usdCost, target)) {
                state.items[key] = { ...e, ...cont, quantity: h.quantity, usdCost: target, updatedAt: this.nowIso };
                continue;
              }
            }
            const rebuilt = await this.applyOrders({ quantity: 0, usdCost: 0, krwExact: 0, krwEst: 0, applied: {} }, orders);
            if (KrwCostBook.matches(rebuilt.usdCost, target)) {
              state.items[key] = { account, code: h.code, ...rebuilt, quantity: h.quantity, usdCost: target, updatedAt: this.nowIso };
              continue;
            }
            // 주문 내역으로 설명되지 않는다(이관·권리 등). 모르는 종목이면 표시 환율로 임시 계산해 두고 다음에 다시 시도
            this.deps.log?.warn({ code: h.code, target, rebuilt: rebuilt.usdCost }, "원화 장부: 주문 내역과 매입금액이 맞지 않음");
            if (!e && displayFx) {
              state.items[key] = { account, code: h.code, quantity: h.quantity, usdCost: target, krwExact: 0, krwEst: target * displayFx, applied: {}, fallback: true, updatedAt: this.nowIso };
            }
          } catch (err) {
            // 조회 실패: 기존 항목을 그대로 두고 다음 동기화에서 다시
            this.deps.log?.warn({ code: h.code, err: err instanceof Error ? err.message : String(err) }, "원화 장부: 조회 실패, 다음 동기화에서 재시도");
          }
        }
      }
      // 이번 응답에 없는(전량 매도한) 계좌·종목만 지운다. 계좌 응답이 통째로 비었으면 일시 오류일 수 있어 지우지 않는다
      const accountsWithRows = new Set(accounts.filter((a) => a.holdings.length > 0).map((a) => a.account));
      for (const [key, e] of Object.entries(state.items)) {
        if (!present.has(key) && accountsWithRows.has(e.account)) delete state.items[key];
      }
      this.calibrate(state, overview, displayFx);
      await this.save(state);
      return state;
    });
  }

  /** 계좌 전체 원화 매입금액 구간을 좁히고, estimated 몫(krwEst)의 합을 거기에 맞춘다 */
  private calibrate(state: KrwCostBookState, overview: OverviewForBook | null, displayFx: number | null): void {
    const entries = Object.values(state.items);
    const hash = JSON.stringify([overview?.purchaseKrw ?? null, entries.map((e) => [e.account, e.code, e.quantity, Math.round(e.usdCost * 100)]).sort()]);
    const reset = () => {
      // 보정할 수 없는데 보유 구성이 바뀌었으면 예전 비율을 버린다 (다른 구성에서 구한 비율을 쓰지 않게)
      if (state.factorHash !== hash) {
        state.factor = 1;
        state.factorHash = hash;
      }
    };
    if (!overview || overview.rateAfterCost === null || !displayFx || entries.some((e) => e.fallback && e.krwEst <= 0)) return reset();
    const value = overview.afterCostKrw + overview.afterCostUsd * displayFx;
    const r = overview.rateAfterCost;
    // 소수 4자리(0.01%p). 반올림·버림 어느 쪽이든 담기도록 ±1e-4
    const lo = value / (1 + r + 1e-4);
    const hi = value / (1 + r - 1e-4);
    if (state.calib && state.calib.hash === hash) {
      const nlo = Math.max(state.calib.lo, lo), nhi = Math.min(state.calib.hi, hi);
      state.calib = nlo <= nhi ? { hash, lo: nlo, hi: nhi, samples: state.calib.samples + 1 } : { hash, lo, hi, samples: 1 };
    } else {
      state.calib = { hash, lo, hi, samples: 1 };
    }
    const target = (state.calib.lo + state.calib.hi) / 2;
    const exact = overview.purchaseKrw + entries.reduce((s, e) => s + e.krwExact, 0);
    const est = entries.reduce((s, e) => s + e.krwEst, 0);
    if (est <= 0) {
      state.factor = 1;
      state.factorHash = hash;
      return;
    }
    const factor = (target - exact) / est;
    // 체결 시각 환율과 토스 적용 환율 차이는 수 % 이내. 그 밖이면 기준이 맞지 않는 것으로 보고 보정하지 않는다
    state.factor = factor > 0.95 && factor < 1.05 ? factor : 1;
    state.factorHash = hash;
  }
}
