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
 * 조회 실패(429·네트워크·환율 없음)는 항목을 건드리지 않고 다음 동기화에서 다시 시도한다(몇 번이든).
 * 조회는 됐는데 주문 내역이 보유 달러 매입금액을 설명하지 못하면(이관 입고, 체결 순서가 엇갈린 주문, 주문 목록 지연) 기다리고(pending),
 * PENDING_MS 넘게 계속되면 가진 정보로 보유와 맞춘다: 모자란 달러 매입금액은 표시 환율로 채우고, 남으면 비율대로 줄인다(추정 표시).
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
  /** 주문 내역으로 다 설명되지 않아(이관·체결 순서) 표시 환율로 채우거나 비율로 맞춘 항목, 또는 여러 계좌에 나눠 넣은 토스 값 → 추정 */
  approx?: boolean;
  updatedAt: string;
}

export interface KrwCostBookState {
  version: 2;
  items: Record<string, KrwCostEntry>;
  /** 아직 맞추지 못한 (계좌:종목) → 처음 본 시각 */
  pending: Record<string, string>;
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

/** 계좌 하나의 보유 (같은 /holdings 응답). purchaseUsd: 계좌 요약의 달러 매입금액 합계(모르면 null) — 목록이 비었을 때 정말 없는지 확인용 */
export interface AccountForBook {
  account: number;
  holdings: HoldingForBook[];
  purchaseUsd?: number | null;
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

type Position = { quantity: number; usdCost: number; krwExact: number; krwEst: number; applied: Record<string, { q: number; amt: number }> };

const KEY = "krw_cost_book";
/** 주문 내역이 보유를 설명하지 못하는 상태가 이만큼 계속되면 가진 정보로 맞춘다 (주문 목록이 잠깐 늦는 경우는 기다린다) */
export const PENDING_MS = 20 * 60_000;
const keyOf = (account: number, code: string) => `${account}:${code}`;
const empty = (): KrwCostBookState => ({ version: 2, items: {}, pending: {}, calib: null, factor: 1, factorHash: null });
const EMPTY_POSITION: Position = { quantity: 0, usdCost: 0, krwExact: 0, krwEst: 0, applied: {} };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class KrwCostBook {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CostBookDeps) {}

  private get nowDate(): Date {
    return (this.deps.now ?? (() => new Date()))();
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
      return {
        version: 2,
        items: s.items ?? {},
        pending: s.pending ?? {},
        calib: s.calib ?? null,
        factor: typeof s.factor === "number" && s.factor > 0 ? s.factor : 1,
        factorHash: s.factorHash ?? null,
      };
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
      const estimated = e.krwEst > 0.5 || !!e.approx;
      out.set(e.code, {
        krw: (prev?.krw ?? 0) + krw,
        quantity: (prev?.quantity ?? 0) + e.quantity,
        usdCost: (prev?.usdCost ?? 0) + e.usdCost,
        source: prev?.source === "estimated" || estimated ? "estimated" : "exact",
      });
    }
    return out;
  }

  /** 아직 반영하지 않은 체결(주문별 누적량과 반영한 양의 차이)을 체결 시각 순으로 */
  private static deltas(applied: Record<string, { q: number; amt: number }>, orders: BookOrder[]) {
    return orders
      .map((o) => ({ o, dq: o.quantity - (applied[o.orderId]?.q ?? 0), damt: o.amount - (applied[o.orderId]?.amt ?? 0) }))
      .filter((d) => d.dq > 1e-12)
      .sort((a, b) => (Date.parse(a.o.at) || 0) - (Date.parse(b.o.at) || 0));
  }

  /** 환율 없이 수량·달러 매입금액만 이동평균으로 (주문 내역이 보유를 설명하는지 확인용) */
  private static usdAfter(start: { quantity: number; usdCost: number; applied: Record<string, { q: number; amt: number }> }, orders: BookOrder[]): number {
    let qty = start.quantity;
    let usd = start.usdCost;
    for (const { o, dq, damt } of KrwCostBook.deltas(start.applied, orders)) {
      if (o.side === "BUY") {
        qty += dq;
        usd += damt;
      } else if (qty > 0) {
        usd *= Math.max(qty - dq, 0) / qty;
        qty = Math.max(qty - dq, 0);
      }
    }
    return usd;
  }

  /** 주문의 누적 체결량과 이미 반영한 양의 차이만 이동평균으로 반영한다. 환율 조회 실패는 던진다 */
  private async applyOrders(start: Position, orders: BookOrder[]): Promise<Position> {
    const applied = { ...start.applied };
    const deltas = KrwCostBook.deltas(applied, orders);
    // 뒤에서 전량 매도되는 매수분은 원화 금액이 0 이 되므로 환율을 조회하지 않는다 (오래된 시점 환율이 없어도 막히지 않게)
    let simQty = start.quantity;
    let lastZero = -1;
    deltas.forEach((d, i) => {
      if (d.o.side === "BUY") simQty += d.dq;
      else if (simQty > 0) {
        simQty = Math.max(simQty - d.dq, 0);
        if (simQty <= 1e-9) lastZero = i;
      }
    });
    let { quantity: qty, usdCost: usd, krwExact, krwEst } = start;
    for (const [i, { o, dq, damt }] of deltas.entries()) {
      if (o.side === "BUY") {
        const rate = i > lastZero ? await this.deps.rateAt(o.at) : 0;
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

  private static sameQty(a: number, b: number): boolean {
    return Math.abs(a - b) < 1e-9;
  }

  /**
   * 토스 앱에서 본 원화 매입금액을 정확한 값으로 넣는다 (종목 합계).
   * read 는 토스에서 보유를 새로 읽는다. 장부 잠금 안에서 보유 → 주문 → 보유 순으로 읽어, 그 사이 체결이 없었던 종목만 저장한다
   * (그래야 "이미 반영한 주문"이 저장하는 수량·매입금액과 정확히 짝이 맞는다). 반환: 저장된 종목 코드
   * 여러 계좌에 나눠 있으면 장부가 아는 계좌별 원화 금액(없으면 달러 매입금액) 비율로 나누고, 계좌별 값은 모르므로 추정으로 둔다.
   */
  setExact(values: Record<string, number>, read: () => Promise<AccountForBook[]>): Promise<string[]> {
    return this.exclusive(async () => {
      const codes = Object.entries(values).filter(([, v]) => v > 0 && Number.isFinite(v));
      if (!codes.length) return [];
      const state = await this.load();
      const first = await read();
      type Row = { account: number; h: HoldingForBook; applied: Record<string, { q: number; amt: number }>; weight: number | null };
      const prepared = new Map<string, Row[]>();
      let fetched = false;
      for (const [code] of codes) {
        const rows = first.flatMap((a) =>
          a.holdings.filter((h) => h.code === code && h.currency === "USD" && h.purchaseAmount !== null && h.quantity > 0).map((h) => ({ account: a.account, h })),
        );
        if (!rows.length) continue;
        const out: Row[] = [];
        let ok = true;
        for (const { account, h } of rows) {
          const e = state.items[keyOf(account, code)];
          if (e && KrwCostBook.sameQty(e.quantity, h.quantity) && KrwCostBook.matches(e.usdCost, h.purchaseAmount!)) {
            // 장부가 이미 이 보유와 맞으면 그 반영 기록을 그대로 쓴다
            out.push({ account, h, applied: e.applied, weight: e.krwExact + e.krwEst * state.factor });
            continue;
          }
          let orders: BookOrder[];
          try {
            orders = await this.deps.orders(account, code);
            fetched = true;
          } catch (err) {
            this.deps.log?.warn({ code, err: errText(err) }, "원화 매입금액 저장: 주문 내역 조회 실패");
            ok = false;
            break;
          }
          // 읽은 주문이 이 보유를 설명해야 "이미 반영"으로 기록할 수 있다 (주문 목록이 늦으면 빠진 체결이 영영 반영되지 않는다).
          // 오래 설명되지 않는 보유(이관 등)는 동기화가 가진 값으로 맞춰 둔 뒤라야 저장된다
          const target = h.purchaseAmount!;
          const explained =
            KrwCostBook.matches(KrwCostBook.usdAfter({ quantity: 0, usdCost: 0, applied: {} }, orders), target) ||
            (!!e && KrwCostBook.matches(KrwCostBook.usdAfter(e, orders), target));
          if (!explained) {
            this.deps.log?.warn({ code, account, target }, "원화 매입금액 저장: 주문 내역이 아직 보유와 맞지 않아 건너뜀");
            ok = false;
            break;
          }
          out.push({ account, h, applied: Object.fromEntries(orders.map((o) => [o.orderId, { q: o.quantity, amt: o.amount }])), weight: null });
        }
        if (ok) prepared.set(code, out);
      }
      // 주문을 새로 읽은 경우, 그 사이 체결이 있었는지 보유를 한 번 더 읽어 확인한다
      const second = fetched ? await read() : first;
      const done: string[] = [];
      const iso = seoulIso(this.nowDate);
      for (const [code, rows] of prepared) {
        const holdingsNow = second.flatMap((a) => a.holdings.filter((h) => h.code === code && h.currency === "USD" && h.quantity > 0).map((h) => ({ account: a.account, h })));
        const stable =
          holdingsNow.length === rows.length &&
          rows.every((r) => {
            const h2 = holdingsNow.find((x) => x.account === r.account)?.h;
            return !!h2 && h2.purchaseAmount !== null && KrwCostBook.sameQty(h2.quantity, r.h.quantity) && KrwCostBook.matches(h2.purchaseAmount, r.h.purchaseAmount!);
          });
        if (!stable) {
          this.deps.log?.warn({ code }, "원화 매입금액 저장: 저장하는 동안 체결이 있어 건너뜀");
          continue;
        }
        const krw = values[code]!;
        const byBook = rows.every((r) => r.weight !== null && r.weight > 0);
        const weightOf = (r: Row) => (byBook ? r.weight! : r.h.purchaseAmount!);
        const total = rows.reduce((s, r) => s + weightOf(r), 0);
        if (!(total > 0)) continue;
        for (const r of rows) {
          const key = keyOf(r.account, code);
          state.items[key] = {
            account: r.account,
            code,
            quantity: r.h.quantity,
            usdCost: r.h.purchaseAmount!,
            krwExact: krw * (weightOf(r) / total),
            krwEst: 0,
            applied: r.applied,
            ...(rows.length > 1 ? { approx: true } : {}),
            updatedAt: iso,
          };
          delete state.pending[key];
        }
        done.push(code);
      }
      await this.save(state);
      return done;
    });
  }

  /**
   * 동기화 때마다 호출. accounts: 계좌별 보유(같은 /holdings 응답, 조회에 성공한 계좌 전부). overview: 계좌가 하나일 때 그 계좌 요약.
   * displayFx: 토스가 원화 평가에 쓰는 표시 환율.
   */
  update(accounts: AccountForBook[], overview: OverviewForBook | null, displayFx: number | null): Promise<KrwCostBookState> {
    return this.exclusive(async () => {
      const state = await this.load();
      const present = new Set<string>();
      let complete = true;
      for (const { account, holdings } of accounts) {
        for (const h of holdings) {
          if (h.currency !== "USD" || !(h.quantity > 0)) continue;
          present.add(keyOf(account, h.code));
          if (!(await this.syncHolding(state, account, h, displayFx))) complete = false;
        }
      }
      // 이번 응답에 없는(전량 매도한) 계좌·종목은 지운다. 단 그 계좌 응답에 보유가 있거나, 계좌 요약이 달러 매입금액 0 을 분명히 줬을 때만.
      // 계좌가 목록에서 빠졌거나 응답이 통째로 비면 일시 오류일 수 있어 둔다(사용자가 넣은 토스 값은 다시 만들 수 없다)
      const confirmed = new Set(accounts.filter((a) => a.holdings.length > 0 || a.purchaseUsd === 0).map((a) => a.account));
      for (const [key, e] of Object.entries(state.items)) {
        if (!present.has(key) && confirmed.has(e.account)) delete state.items[key];
      }
      for (const key of Object.keys(state.pending)) if (!present.has(key)) delete state.pending[key];
      this.calibrate(state, accounts, present, overview, displayFx, complete);
      await this.save(state);
      return state;
    });
  }

  /** 보유 한 건을 장부에 맞춘다. 반환: 이제 장부가 이 보유(수량·달러 매입금액)와 맞는지 */
  private async syncHolding(state: KrwCostBookState, account: number, h: HoldingForBook, displayFx: number | null): Promise<boolean> {
    const key = keyOf(account, h.code);
    const e = state.items[key];
    const now = this.nowDate;
    if (h.purchaseAmount === null) return !!e && KrwCostBook.sameQty(e.quantity, h.quantity); // 금액이 잠깐 비어도 기존 항목은 그대로 둔다
    const target = h.purchaseAmount;
    if (e && KrwCostBook.sameQty(e.quantity, h.quantity) && KrwCostBook.matches(e.usdCost, target)) {
      delete state.pending[key];
      return true;
    }
    const since = state.pending[key] ? Date.parse(state.pending[key]) : now.getTime();
    const overdue = now.getTime() - since >= PENDING_MS;
    const wait = (reason: string, extra: Record<string, unknown> = {}) => {
      state.pending[key] ??= seoulIso(now);
      this.deps.log?.warn({ code: h.code, account, target, ...extra }, `원화 장부: ${reason}, 다음 동기화에서 다시`);
      return false;
    };
    const write = (p: Position, approx: boolean) => {
      state.items[key] = {
        account,
        code: h.code,
        quantity: h.quantity,
        usdCost: target,
        krwExact: p.krwExact,
        krwEst: p.krwEst,
        applied: p.applied,
        ...(approx ? { approx: true } : {}),
        updatedAt: seoulIso(now),
      };
      delete state.pending[key];
      return true;
    };
    let orders: BookOrder[];
    try {
      orders = await this.deps.orders(account, h.code);
    } catch (err) {
      this.deps.log?.warn({ code: h.code, account, err: errText(err) }, "원화 장부: 주문 내역 조회 실패, 다음 동기화에서 다시");
      return false;
    }
    // 환율 조회 실패는 몇 번이든 다시 시도한다(표시 환율로 굳히지 않는다). 기다림(pending)은 "설명되지 않음"에만 센다
    let cont: Position | null = null;
    let rebuilt: Position;
    try {
      // 1) 기존 항목에 새 체결만 이어 붙인다 (토스 값·exact 몫이 그대로 남는다)
      if (e) {
        cont = await this.applyOrders(e, orders);
        if (KrwCostBook.matches(cont.usdCost, target)) return write(cont, !!e.approx);
      }
      // 2) 주문 내역 전체로 다시 계산
      rebuilt = await this.applyOrders(EMPTY_POSITION, orders);
    } catch (err) {
      this.deps.log?.warn({ code: h.code, account, err: errText(err) }, "원화 장부: 환율 조회 실패, 다음 동기화에서 다시");
      return false;
    }
    // 토스 값이 든 항목은 곧바로 재계산 값으로 바꾸지 않는다 (주문 목록이 잠깐 늦는 경우 등). 오래 계속되면 바꾼다
    if (KrwCostBook.matches(rebuilt.usdCost, target) && (!e || e.krwExact <= 0 || overdue)) return write(rebuilt, false);
    if (!overdue) return wait("주문 내역과 매입금액이 맞지 않음", { rebuilt: rebuilt.usdCost, cont: cont?.usdCost ?? null });
    // 3) 오래 맞지 않음(이관·체결 순서 등): 가진 값으로 보유에 맞춘다. 모자란 달러는 표시 환율로, 남으면 비율대로 줄인다
    const base = cont ?? rebuilt;
    const residual = target - base.usdCost;
    if (residual > 0) {
      if (!displayFx) return wait("표시 환율 없음");
      return write({ ...base, krwEst: base.krwEst + residual * displayFx }, true);
    }
    const k = base.usdCost > 0 ? target / base.usdCost : 0;
    return write({ ...base, krwExact: base.krwExact * k, krwEst: base.krwEst * k }, true);
  }

  /** 계좌 전체 원화 매입금액 구간을 좁히고, 장부가 보유 전부와 맞을 때만 estimated 몫(krwEst)의 합을 거기에 맞춘다 */
  private calibrate(
    state: KrwCostBookState,
    accounts: AccountForBook[],
    present: Set<string>,
    overview: OverviewForBook | null,
    displayFx: number | null,
    complete: boolean,
  ): void {
    // 보유 구성(장부가 아니라 토스 응답 기준): 이게 같으면 계좌 원화 매입금액도 같다
    const rows = accounts
      .flatMap((a) =>
        a.holdings
          .filter((h) => h.currency === "USD" && h.quantity > 0)
          .map((h) => `${a.account}:${h.code}:${h.quantity}:${h.purchaseAmount === null ? "-" : Math.round(h.purchaseAmount * 100)}`),
      )
      .sort();
    const hash = JSON.stringify([overview?.purchaseKrw ?? null, rows]);
    if (!overview || overview.rateAfterCost === null || !displayFx) {
      // 보정할 수 없는데 보유 구성이 바뀌었으면 예전 비율을 버린다 (다른 구성에서 구한 비율을 쓰지 않게)
      if (state.factorHash !== hash) {
        state.factor = 1;
        state.factorHash = hash;
      }
      return;
    }
    const value = overview.afterCostKrw + overview.afterCostUsd * displayFx;
    const r = overview.rateAfterCost;
    // 소수 4자리(0.01%p). 반올림·버림 어느 쪽이든 담기도록 ±1e-4
    const lo = value / (1 + r + 1e-4);
    const hi = value / (1 + r - 1e-4);
    if (state.calib && state.calib.hash === hash) {
      const nlo = Math.max(state.calib.lo, lo);
      const nhi = Math.min(state.calib.hi, hi);
      state.calib = nlo <= nhi ? { hash, lo: nlo, hi: nhi, samples: state.calib.samples + 1 } : { hash, lo, hi, samples: 1 };
    } else {
      state.calib = { hash, lo, hi, samples: 1 };
    }
    // 장부에 빠지거나 안 맞는 보유가 있으면 그 원화 금액이 다른 종목 보정에 섞이므로 보정하지 않는다
    if (!complete) {
      state.factor = 1;
      state.factorHash = null;
      return;
    }
    const entries = Object.entries(state.items)
      .filter(([key]) => present.has(key))
      .map(([, e]) => e);
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
