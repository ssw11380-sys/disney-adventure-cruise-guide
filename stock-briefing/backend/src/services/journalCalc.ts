/**
 * 매매일지 원장 (3-37, 플래그 tradeJournal) — 순수 계산. 시각·환율은 모두 인자로 받는다 (테스트는 고정 값).
 *
 * 평균 구매가는 이동평균법(토스증권 방식 — 산 금액 합을 수량으로 나눈 값)으로, (계좌, 종목) 짝마다 체결 몫(fills)을 시각 순으로 다시 돌린다.
 * 계산은 저장하지 않고 요청 때마다 돌린다 (수백 건이라 수 ms).
 *  - 매수: 수량 += q, 매입금액 += a (수수료는 넣지 않음 — 토스 '평균 구매가'처럼. 표본으로 확인할 것)
 *  - 매도: 팔린 몫의 원가 = 매입금액 × q ÷ 수량 (마지막 매도는 남은 매입금액 전부), 실현손익(비용 전) = a − 원가
 *  - 기준점(anchor) = 스냅샷(토스 보유 조회의 수량·매입금액). 그 뒤 매도는 'snapshot' — 토스 평단에서 출발
 *  - 첫 기준점 전 매도: 0주에서 돌린 결과가 첫 기준점과 맞으면 'history-checked', 맞지 않으면 모름(unknown-cost)
 *  - 기준점이 없는 짝: 0주에서 음수 없이 돌면 'history-only'(토스 잔고와 맞춰 보지 못함), 음수면 모름
 *  - 기준점마다 대조: 수량이 다르면 분할(매입금액 같고 수량 N배·1/N) 또는 이관(그 밖) 추정 줄 + 사이 매도는 'estimated'
 *  - 같은 두 기준점 사이 반대 방향 몫 가운데 체결 시각(filled)이 아닌 것이 있으면 순서를 모른다 → 매수 먼저·매도 먼저로 계산해
 *    값이 1원·1센트 넘게 다르면 매수 먼저 값 + 'order-uncertain'
 * 미국 종목은 토스 원화 보기처럼 매수 당시 환율(토스 매수 환율 usdKrwAt)로 원화 매입금액도 이동평균으로 함께 쌓는다(추정).
 * 해외 양도세(journalTax)는 같은 원장을 결제일 기준환율(stdAt)로 한 번 더 쌓는다 — 처음부터 온전한 주문 내역이 있을 때만.
 * 화면 문장(REASONS)은 여기 한 곳에서 만든다 (문구 검사 — 권유 표현 없음)
 */

export type Cur = "KRW" | "USD";
export type Side = "BUY" | "SELL";
export type TimeBasis = "filled" | "ordered" | "seen";
export type RealizedStatus = "ok" | "unknown-cost" | "order-uncertain" | "estimated";
export type RealizedBasis = "snapshot" | "history-checked" | "history-only";

/** 화면에 그대로 쓰는 쉬운 문장 (서버 한 곳 — 문구 검사) */
export const REASONS = {
  beforeRecord: "기록 시작 전에 산 몫이라 평균 구매가를 몰라요.",
  oversold: "기록된 수량보다 많이 판 매도라 평균 구매가를 몰라요.",
  noAvg: "토스 잔고에 매입금액이 없어 평균 구매가를 몰라요.",
  orderUncertain: "같은 날 사고판 순서를 몰라 추정했어요.",
  split: "분할·병합 전후라 평균 구매가를 추정했어요.",
  transfer: "주문 내역에 없는 수량 변화가 있어 평균 구매가를 추정했어요.",
  krwNoFx: "판매 때 환율을 받지 못해 원화 손익은 빼요.",
  krwNoBook: "원화 매입금액을 몰라 원화 손익은 빼요.",
} as const;

/** 원장에 넣는 체결 한 몫 (저장한 체결의 fills 한 칸) */
export interface LedgerFill {
  /** `${account}:${orderId}:${몫 번호}` */
  key: string;
  account: number;
  orderId: string;
  code: string;
  side: Side;
  quantity: number;
  /** 종목 통화 금액 */
  amount: number;
  /** 몫의 체결 시각 (basis 가 filled 가 아니면 주문 시각이나 그 확인의 스냅샷 시각) */
  at: string;
  basis: TimeBasis;
  /** 주문 전체 체결 수량 (주문 단위 비용을 몫 비율로 나눌 때) */
  orderQuantity: number;
  /** 주문 전체의 토스 비용 (수수료·세금 — 토스 주문 원본에 칸이 있을 때만). 없으면 null */
  orderCosts?: { fee: number | null; tax: number | null } | null;
  /** 같은 시각일 때 순서 (저장 순서) */
  seq: number;
}

/** 기준점 = 그 계좌가 목록에 있고 의심 없이 저장된 스냅샷의 그 종목 (없으면 0주) */
export interface LedgerAnchor {
  asOf: string;
  /** 스냅샷 날짜 (그 시장 거래일) */
  date: string;
  quantity: number;
  /** 매입금액 (종목 통화 — 토스 purchaseAmount, 없으면 평단 × 수량). 모르면 null */
  cost: number | null;
  /** 원화 매입금액 (미국 — 토스 원화 장부, 매수 당시 환율). 모르면 null */
  costKrw: number | null;
  costKrwEstimated: boolean;
  /** 그 스냅샷 그 종목의 1 − 비용 차감 후 평가금액 ÷ 평가금액 (토스 평가금액의 '비용 차감' 비율). 없으면 null */
  costRatio: number | null;
}

export interface RealizedKrw {
  gross: number | null;
  /** 팔린 몫의 원화 원가 (매수 당시 환율로 쌓은 원화 평균 구매가 기준) */
  costKrw: number | null;
  sellFx: number | null;
  fxSource: "toss" | null;
  estimated: boolean;
  reason: string | null;
}

export interface Realized {
  status: RealizedStatus;
  reason: string | null;
  basis: RealizedBasis | null;
  /** 출발한 스냅샷 날짜 (history-checked 는 맞춰 본 첫 스냅샷) */
  anchorDate: string | null;
  avgCost: number | null;
  costAmount: number | null;
  gross: number | null;
  /** 퍼센트 (소수 둘째 자리) */
  rate: number | null;
  costs: { fee: number | null; tax: number | null; total: number | null; source: "toss" | "estimated" | null };
  net: number | null;
  krw: RealizedKrw | null;
}

/** 해외 양도세용: 결제일 기준환율로 쌓은 원화 (양도가액·취득가액) */
export interface StdValue {
  proceeds: number | null;
  cost: number | null;
  /** 원가를 모름(기록 전 몫) · 결제일 환율 없음 */
  missing: null | "cost" | "fx";
}

export interface FillResult {
  realized?: Realized;
  afterBuy?: { avgCost: number; quantity: number } | null;
  std?: StdValue;
}

export interface EstimatedRow {
  at: string;
  date: string;
  /** 주문 내역으로 설명되지 않는 수량 (+ 늘어남 · − 줄어듦) */
  qty: number;
  fromQty: number;
  toQty: number;
  reason: "split" | "transfer";
  /** 분할·병합 배수 (1→4 면 4, 4→1 이면 0.25) */
  ratio?: number;
}

export interface PairCheck {
  anchors: number;
  preAnchor: "none" | "checked" | "mismatch" | "history-only" | "incomplete";
  drift: number;
  splits: number;
  transfers: number;
}

export interface PairResult {
  fills: Map<string, FillResult>;
  estimated: EstimatedRow[];
  check: PairCheck;
  /** 원장 끝 상태 (지금 보유 — 기준점·주문 내역 기준) */
  holding: { quantity: number; avgCost: number | null };
}

export interface LedgerOptions {
  currency: Cur;
  /** 미국: 그 시각의 토스 매수 환율 (저장한 값 — 없으면 null) */
  fxAt?: (at: string) => number | null;
  /** 해외 양도세: 그 몫의 결제일 기준환율 (없으면 null). 주면 몫마다 std 를 붙인다 */
  stdAt?: (f: LedgerFill) => number | null;
}

const EPS = 1e-6;
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** 원 1원 · 달러 1센트 (−0 없이) */
export const roundMoney = (n: number, cur: Cur) => {
  const v = cur === "KRW" ? Math.round(n) : Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};
const round2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
};
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** 순서가 달라 값이 다르다고 볼 차이 (1원 · 1센트) */
const unit = (cur: Cur) => (cur === "KRW" ? 1 : 0.01);

/** 원장 매입금액과 스냅샷 매입금액이 맞는지: 평균 구매가 차이 ≤ 1원 · $0.0001 (매입금액 반올림 1원 · 1센트까지) */
function costClose(a: number, b: number, qty: number, cur: Cur): boolean {
  const avgTol = cur === "KRW" ? 1 : 0.0001;
  return Math.abs(a - b) <= Math.max(avgTol * qty, unit(cur)) + 1e-9;
}

/**
 * 토스 주문 원본(raw)의 수수료·세금 (주문 전체, 종목 통화). 칸 이름은 운영 원본으로 확인 전이라 흔한 이름을 모두 본다 —
 * 숫자(또는 숫자 글, { amount })이고 0 이상일 때만. 둘 다 없으면 null ('토스가 주지 않음'). DB 의 fee·tax 칸은 고쳐 쓰지 않는다
 */
export function tossCosts(raw: unknown): { fee: number | null; tax: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ex = r["execution"] && typeof r["execution"] === "object" ? (r["execution"] as Record<string, unknown>) : {};
  const pick = (names: string[]): number | null => {
    for (const src of [ex, r]) {
      for (const n of names) {
        const v = numOf(src[n]);
        if (v !== null) return v;
      }
    }
    return null;
  };
  const fee = pick(["commission", "fee", "fees", "tradingFee", "brokerageFee", "commissionAmount", "feeAmount"]);
  const tax = pick(["tax", "taxes", "taxAmount", "transactionTax", "securitiesTax", "sellTax"]);
  return fee === null && tax === null ? null : { fee, tax };
}

function numOf(v: unknown): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return numOf((v as Record<string, unknown>)["amount"] ?? (v as Record<string, unknown>)["value"]);
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface State {
  qty: number;
  /** 매입금액 (종목 통화) — 모르면 null */
  cost: number | null;
  /** 원화 매입금액 (미국, 토스 매수 환율) — 모르면 null */
  krw: number | null;
  krwEst: boolean;
  /** 원화 매입금액을 모르는 까닭 (기준점에 원화 장부가 없음 · 매수 환율 없음) */
  krwWhy: string | null;
  /** 해외 양도세: 결제일 기준환율로 쌓은 원화 매입금액 — 모르면 null */
  std: number | null;
  stdWhy: "cost" | "fx" | null;
  /** 원장보다 많이 판 매도가 있었음 (앞부분 기록 없음) */
  neg: boolean;
  /** 직전 기준점의 비용 차감 비율 */
  ratio: number | null;
}

type Out = Map<string, FillResult>;

const t = (iso: string) => Date.parse(iso);

/** 한 몫 적용 (결과는 out 에). 매도의 상태·기준은 부른 쪽이 나중에 고친다 */
function apply(s: State, f: LedgerFill, opts: LedgerOptions, out: Out): void {
  const cur = opts.currency;
  const fx = cur === "USD" && opts.fxAt ? opts.fxAt(f.at) : null;
  const std = opts.stdAt ? opts.stdAt(f) : null;
  if (f.side === "BUY") {
    s.qty = round6(s.qty + f.quantity);
    s.cost = s.cost === null ? null : s.cost + f.amount;
    if (cur === "USD") {
      if (s.krw !== null && fx !== null) s.krw += f.amount * fx;
      else if (s.krw !== null) {
        s.krw = null;
        s.krwWhy = REASONS.krwNoFx;
      }
    }
    if (opts.stdAt) {
      if (s.std !== null && std !== null) s.std += f.amount * std;
      else if (s.std !== null) {
        s.std = null;
        s.stdWhy = "fx";
      }
    }
    out.set(f.key, { afterBuy: s.cost !== null && s.qty > EPS ? { avgCost: round4(s.cost / s.qty), quantity: s.qty } : null });
    return;
  }
  // 매도
  const costs = sellCosts(f, s, cur);
  if (f.quantity > s.qty + EPS) {
    s.neg = true;
    out.set(f.key, {
      realized: { ...blank(costs), status: "unknown-cost", reason: REASONS.oversold },
      ...(opts.stdAt ? { std: { proceeds: std !== null ? f.amount * std : null, cost: null, missing: "cost" as const } } : {}),
    });
    s.qty = 0;
    s.cost = 0;
    s.krw = 0;
    s.krwWhy = null;
    s.krwEst = false;
    s.std = 0;
    s.stdWhy = null;
    return;
  }
  const last = Math.abs(s.qty - f.quantity) <= EPS;
  const share = (v: number) => (last ? v : (v * f.quantity) / s.qty);
  let realized: Realized;
  if (s.cost === null) {
    realized = { ...blank(costs), status: "unknown-cost", reason: REASONS.noAvg };
  } else {
    const avg = s.cost / s.qty;
    const c = share(s.cost);
    const gross = roundMoney(f.amount - c, cur);
    realized = {
      status: "ok",
      reason: null,
      basis: null,
      anchorDate: null,
      avgCost: round4(avg),
      costAmount: roundMoney(c, cur),
      gross,
      rate: c > 0 ? round2(((f.amount - c) / c) * 100) : null,
      costs,
      net: costs.total !== null ? roundMoney(gross - costs.total, cur) : null,
      krw: null,
    };
    s.cost = last ? 0 : s.cost - c;
  }
  if (cur === "USD") {
    if (s.krw !== null && fx !== null) {
      const ck = share(s.krw);
      realized.krw = { gross: realized.gross === null ? null : Math.round(f.amount * fx - ck), costKrw: Math.round(ck), sellFx: fx, fxSource: "toss", estimated: s.krwEst, reason: null };
      s.krw = last ? 0 : s.krw - ck;
    } else {
      realized.krw = { gross: null, costKrw: null, sellFx: fx, fxSource: fx !== null ? "toss" : null, estimated: s.krwEst, reason: fx === null ? REASONS.krwNoFx : (s.krwWhy ?? REASONS.krwNoBook) };
      if (s.krw !== null) s.krw = last ? 0 : s.krw - share(s.krw);
    }
  }
  let stdOut: StdValue | undefined;
  if (opts.stdAt) {
    // 양도가액 (비용은 세액 계산 쪽이 토스 값일 때만 따로 뺀다)
    const proceeds = std !== null ? f.amount * std : null;
    if (s.std !== null) {
      const cs = share(s.std);
      stdOut = { proceeds, cost: cs, missing: proceeds === null ? "fx" : null };
      s.std = last ? 0 : s.std - cs;
    } else stdOut = { proceeds, cost: null, missing: s.stdWhy ?? "cost" };
  }
  s.qty = last ? 0 : round6(s.qty - f.quantity);
  if (last) {
    // 전부 팔았다: 다음 매수부터는 처음부터 온전한 원장 (원화·결제일 원화도 다시 안다)
    s.cost = 0;
    s.krw = 0;
    s.krwEst = false;
    s.krwWhy = null;
    s.std = 0;
    s.stdWhy = null;
  }
  out.set(f.key, { realized, ...(stdOut ? { std: stdOut } : {}) });
}

function sellCosts(f: LedgerFill, s: State, cur: Cur): Realized["costs"] {
  const oc = f.orderCosts;
  if (oc && (oc.fee !== null || oc.tax !== null)) {
    const part = f.orderQuantity > 0 ? f.quantity / f.orderQuantity : 1;
    const fee = oc.fee !== null ? roundMoney(oc.fee * part, cur) : null;
    const tax = oc.tax !== null ? roundMoney(oc.tax * part, cur) : null;
    return { fee, tax, total: roundMoney((fee ?? 0) + (tax ?? 0), cur), source: "toss" };
  }
  if (s.ratio !== null && s.ratio >= 0) return { fee: null, tax: null, total: roundMoney(f.amount * s.ratio, cur), source: "estimated" };
  return { fee: null, tax: null, total: null, source: null };
}

function blank(costs: Realized["costs"]): Realized {
  return { status: "unknown-cost", reason: null, basis: null, anchorDate: null, avgCost: null, costAmount: null, gross: null, rate: null, costs, net: null, krw: null };
}

const clone = (s: State): State => ({ ...s });

/**
 * 한 구간(두 기준점 사이)의 몫을 적용. 반대 방향 몫이 있고 체결 시각(filled)이 아닌 몫이 섞이면 순서를 모른다 →
 * 매수 먼저(불확실한 매수는 가장 이르게·매도는 가장 늦게)와 매도 먼저로 돌려, 매도 실현손익이 1원·1센트 넘게 다른 매도에 'order-uncertain'.
 * 값은 매수 먼저 쪽을 쓴다
 */
function runSegment(s: State, fills: LedgerFill[], startMs: number, endMs: number, opts: LedgerOptions, out: Out): { state: State; uncertain: Set<string> } {
  const uncertainFill = (f: LedgerFill) => f.basis !== "filled";
  const both = fills.some((f) => f.side === "BUY") && fills.some((f) => f.side === "SELL");
  if (!both || !fills.some(uncertainFill)) {
    for (const f of fills) apply(s, f, opts, out);
    return { state: s, uncertain: new Set() };
  }
  // 몫이 있을 수 있는 가장 이른·늦은 때: 'ordered' 는 주문 시각 ~ 다음 기준점, 'seen' 은 앞 기준점 ~ 그 시각
  const early = (f: LedgerFill) => (f.basis === "ordered" ? t(f.at) : f.basis === "seen" ? startMs : t(f.at));
  const late = (f: LedgerFill) => (f.basis === "ordered" ? endMs : t(f.at));
  const order = (buyFirst: boolean) =>
    [...fills]
      .map((f) => ({
        f,
        k: !uncertainFill(f) ? t(f.at) : (f.side === "BUY") === buyFirst ? early(f) : late(f),
      }))
      .sort((x, y) => x.k - y.k || (x.f.side === y.f.side ? 0 : (x.f.side === "BUY") === buyFirst ? -1 : 1) || x.f.seq - y.f.seq)
      .map((x) => x.f);
  const outA: Out = new Map();
  const outB: Out = new Map();
  const a = clone(s);
  const b = clone(s);
  for (const f of order(true)) apply(a, f, opts, outA);
  for (const f of order(false)) apply(b, f, opts, outB);
  const uncertain = new Set<string>();
  for (const f of fills) {
    if (f.side !== "SELL") continue;
    const ga = outA.get(f.key)?.realized?.gross ?? null;
    const gb = outB.get(f.key)?.realized?.gross ?? null;
    if (ga !== null && gb !== null && Math.abs(ga - gb) >= unit(opts.currency) - 1e-9) uncertain.add(f.key);
  }
  for (const [k, v] of outA) out.set(k, v);
  return { state: a, uncertain };
}

/** 스냅샷과 원장의 수량이 다를 때: 매입금액이 거의 같고(±0.5%) 수량 비율이 정수 N 또는 1/N(±0.1%)이면 분할·병합 */
function splitRatio(replayQty: number, replayCost: number | null, a: LedgerAnchor): number | null {
  if (!(replayQty > EPS) || !(a.quantity > EPS) || replayCost === null || a.cost === null || !(replayCost > 0)) return null;
  if (Math.abs(a.cost - replayCost) > replayCost * 0.005) return null;
  const r = a.quantity / replayQty;
  const near = (x: number) => Math.abs(x - Math.round(x)) <= Math.round(x) * 0.001 && Math.round(x) >= 2;
  if (near(r)) return Math.round(r);
  if (near(1 / r)) return round4(1 / Math.round(1 / r));
  return null;
}

/**
 * (계좌, 종목) 짝 하나의 원장. fills·anchors 는 순서가 없어도 된다 (시각 순으로 늘어놓음 — 같은 시각이면 몫이 기준점 앞: at ≤ asOf 는 그 스냅샷에 든 체결)
 */
export function replayPair(fillsIn: LedgerFill[], anchorsIn: LedgerAnchor[], opts: LedgerOptions): PairResult {
  const cur = opts.currency;
  const fills = [...fillsIn].sort((x, y) => t(x.at) - t(y.at) || x.seq - y.seq);
  const anchors = [...anchorsIn].sort((x, y) => t(x.asOf) - t(y.asOf));
  const segs: LedgerFill[][] = anchors.map(() => []);
  segs.push([]);
  for (const f of fills) {
    let i = 0;
    while (i < anchors.length && t(anchors[i]!.asOf) < t(f.at)) i++;
    segs[i]!.push(f);
  }
  const out: Out = new Map();
  const estimated: EstimatedRow[] = [];
  const check: PairCheck = { anchors: anchors.length, preAnchor: "none", drift: 0, splits: 0, transfers: 0 };
  const sellKeys = (seg: LedgerFill[]) => seg.filter((f) => f.side === "SELL").map((f) => f.key);
  const mark = (keys: string[], fn: (r: Realized, res: FillResult) => void) => {
    for (const k of keys) {
      const res = out.get(k);
      if (res?.realized) fn(res.realized, res);
    }
  };

  // ── 첫 기준점 전 (0주에서) ──
  let s: State = { qty: 0, cost: 0, krw: 0, krwEst: false, krwWhy: null, std: 0, stdWhy: null, neg: false, ratio: null };
  const firstEnd = anchors[0] ? t(anchors[0].asOf) : Infinity;
  const pre = runSegment(s, segs[0]!, -Infinity, firstEnd, opts, out);
  s = pre.state;
  const preSells = sellKeys(segs[0]!);
  const a1 = anchors[0];
  const preOk = (() => {
    if (s.neg) return false;
    if (!a1) return true;
    if (Math.abs(s.qty - a1.quantity) > EPS) return false;
    if (a1.cost === null || s.cost === null) return a1.cost === null; // 스냅샷 매입금액을 모르면 수량만
    return costClose(s.cost, a1.cost, a1.quantity, cur);
  })();
  if (segs[0]!.length) check.preAnchor = !a1 ? (preOk ? "history-only" : "incomplete") : preOk ? "checked" : "mismatch";
  mark(preSells, (r, res) => {
    if (preOk && r.status !== "unknown-cost") {
      r.basis = a1 ? "history-checked" : "history-only";
      r.anchorDate = a1?.date ?? null;
    } else {
      // 첫 스냅샷과 맞지 않음(앞부분 주문 내역이 없음): 그 전 매도는 값을 지어내지 않는다
      Object.assign(r, { ...blank(r.costs), status: "unknown-cost", reason: REASONS.beforeRecord });
      if (res.std) res.std = { ...res.std, cost: null, missing: "cost" };
    }
  });
  // 순서 모름 꼬리표 (기록 전 구간)
  if (preOk) for (const k of pre.uncertain) tagUncertain(out, k);

  // ── 기준점마다 ──
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    if (i > 0) {
      // 앞 구간 끝 원장과 이 스냅샷 대조
      const prevSells = sellKeys(segs[i]!);
      if (Math.abs(s.qty - a.quantity) > EPS) {
        const ratio = splitRatio(s.qty, s.cost, a);
        const row: EstimatedRow = { at: a.asOf, date: a.date, qty: round6(a.quantity - s.qty), fromQty: s.qty, toQty: a.quantity, reason: ratio !== null ? "split" : "transfer" };
        if (ratio !== null) row.ratio = ratio;
        estimated.push(row);
        if (ratio !== null) check.splits++;
        else check.transfers++;
        mark(prevSells, (r) => {
          if (r.status === "unknown-cost") return;
          r.status = "estimated";
          r.reason = ratio !== null ? REASONS.split : REASONS.transfer;
        });
      } else if (a.cost !== null && s.cost !== null && !costClose(s.cost, a.cost, a.quantity, cur)) check.drift++;
    }
    // 스냅샷 값으로 맞춘다 (원화 매입금액은 토스 원화 장부 값, 없으면 수량이 맞을 때만 쌓아 온 값)
    const sameQty = Math.abs(s.qty - a.quantity) <= EPS;
    const ratioSplit = i > 0 && !sameQty ? splitRatio(s.qty, s.cost, a) : null;
    const next: State = {
      qty: a.quantity,
      cost: a.quantity <= EPS ? 0 : a.cost ?? (sameQty && s.cost !== null && (i > 0 || preOk) ? s.cost : null),
      krw: a.quantity <= EPS ? 0 : a.costKrw ?? (sameQty && s.krw !== null && (i > 0 || preOk) ? s.krw : null),
      krwEst: a.costKrw !== null ? a.costKrwEstimated : s.krwEst,
      krwWhy: a.quantity <= EPS || a.costKrw !== null ? null : sameQty && s.krw !== null ? null : REASONS.krwNoBook,
      // 결제일 원화: 스냅샷은 모른다 — 수량이 맞으면(첫 기준점은 기록 전 원장이 맞을 때만) 쌓아 온 값, 분할이면 그대로, 이관이면 모름
      std: a.quantity <= EPS ? 0 : (sameQty && (i > 0 || preOk)) || ratioSplit !== null ? s.std : null,
      stdWhy: a.quantity <= EPS ? null : (sameQty && (i > 0 || preOk)) || ratioSplit !== null ? s.stdWhy : "cost",
      neg: false,
      ratio: a.costRatio,
    };
    const end = anchors[i + 1] ? t(anchors[i + 1]!.asOf) : Infinity;
    const seg = segs[i + 1]!;
    const r = runSegment(next, seg, t(a.asOf), end, opts, out);
    s = r.state;
    mark(sellKeys(seg), (x) => {
      if (x.status === "unknown-cost") return;
      x.basis = "snapshot";
      x.anchorDate = a.date;
    });
    for (const k of r.uncertain) tagUncertain(out, k);
    // 기준점에 매입금액이 없어 구간 매도를 모름: 까닭은 apply 가 적었다 (noAvg)
  }
  return {
    fills: out,
    estimated,
    check,
    holding: { quantity: s.qty, avgCost: s.qty > EPS && s.cost !== null ? round4(s.cost / s.qty) : null },
  };
}

function tagUncertain(out: Out, key: string): void {
  const r = out.get(key)?.realized;
  if (!r || r.status !== "ok") return;
  r.status = "order-uncertain";
  r.reason = REASONS.orderUncertain;
}
