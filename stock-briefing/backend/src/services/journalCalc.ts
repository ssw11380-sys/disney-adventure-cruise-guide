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
 *  - 기준점마다 대조: 수량이 다르면 회사 행동(분할·병합·무상증자·주식배당 — 비율과 상관없이 토스 매입금액이 그대로, 사이 매도만큼 줄어든 값.
 *    수량 변화 2% 이상 · 매입금액 차이 0.5% 이하이면서 수량 변화의 1/10 이하) 또는 이관(그 밖) 추정 줄 + 사이 매도는 'estimated'.
 *    회사 행동은 사이 몫의 뒤(끝 가정)·앞(처음 가정) 둘 다 계산해 토스 매입금액에 더 가까운 쪽을 고르고(같으면 흔한 배수 모양 → 처음 가정),
 *    처음 가정이면 사이 몫을 행동 뒤 수량으로 다시 계산한다 (1→4 분할 날 판 5주가 분할 전 평균으로 계산되어 가짜 손실이 나지 않게).
 *    다음 스냅샷이 0주(행동 뒤 같은 구간에 전부 팖)면 매입금액으로 맞춰 볼 수 없어: 행동 뒤 수량(판 수량 − 산 수량)이 흔한 배수(COMMON_RATIOS,
 *    1주 미만 끝수 현금 포함)이고, 판 가격이 그 배수와 맞으며(직전 스냅샷 가격을 알 때 — 모르면 수량이 늘어나는 쪽만), 그 수량으로 다시 돌려
 *    많이 판 매도 없이 딱 0주에서 끝나면 회사 행동(처음 가정). 아니면 이관 추정 + 많이 판 매도는 'order-uncertain' (양도세 합계에서는 기본으로 뺀다)
 *  - 기준점 뒤 기록된 수량보다 많이 판 매도: 0 으로 되돌리지 않고 수량을 음수로 둔다 → 다음 기준점의 이관 추정이 빠진 입고만큼 나온다.
 *    그 매도는 기준점 평균으로 추정한 'order-uncertain', 그 구간의 다음 매도는 평균을 모름
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
  split: "분할·무상증자 같은 주식 수 변화 전후라 평균 구매가를 추정했어요.",
  oversoldAfter: "기록된 수량보다 많이 판 매도라 평균 구매가를 추정했어요 (주문 순서나 주문 내역에 없는 입고를 몰라요).",
  transfer: "주문 내역에 없는 수량 변화가 있어 평균 구매가를 추정했어요.",
  krwNoFx: "판매 때 환율을 받지 못해 원화 손익은 빼요.",
  krwNoBuyFx: "매수 때 환율을 받지 못해 원화 손익은 빼요.",
  krwNoBothFx: "매수·판매 때 환율을 받지 못해 원화 손익은 빼요.",
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
  /**
   * 그 스냅샷 그 종목 한 주 가격 (정규장 종가, 없으면 그때 현재가 — 종목 통화). 회사 행동 뒤 같은 구간에 전부 판 경우
   * 판 가격이 배수와 맞는지 볼 때 쓴다 (분할 전 1,000원 → 1→4 분할 뒤 약 250원). 모르면 null·없음
   */
  price?: number | null;
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
  /** 분할·병합·무상증자 배수 (1→4 면 4, 4→1 이면 0.25, 10→15 면 1.5) */
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
  /** 기준점(스냅샷)에서 출발한 원장 — 많이 판 매도를 0 으로 되돌리지 않는다 */
  anchored: boolean;
  /** 매입금액을 모르는 까닭 (null 이면 토스 잔고에 매입금액 없음) */
  costWhy: string | null;
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
        s.krwWhy = REASONS.krwNoBuyFx;
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
  if (f.quantity > s.qty + EPS && s.anchored) {
    oversoldAfter(s, f, fx, std, costs, opts, out);
    return;
  }
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
    realized = { ...blank(costs), status: "unknown-cost", reason: s.costWhy ?? REASONS.noAvg };
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
      realized.krw = { gross: null, costKrw: null, sellFx: fx, fxSource: fx !== null ? "toss" : null, estimated: s.krwEst, reason: krwReason(s, fx) };
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
    s.costWhy = null;
  }
  out.set(f.key, { realized, ...(stdOut ? { std: stdOut } : {}) });
}

/** 원화 손익을 뺀 까닭: 빠진 환율을 바로 (매수 때 · 판매 때 · 둘 다), 그 밖은 원화 장부 없음 */
function krwReason(s: State, fx: number | null): string {
  const buyMissing = s.krw === null && s.krwWhy === REASONS.krwNoBuyFx;
  if (fx === null) return buyMissing ? REASONS.krwNoBothFx : REASONS.krwNoFx;
  return s.krwWhy ?? REASONS.krwNoBook;
}

/**
 * 기준점 뒤 기록된 수량보다 많이 판 매도: 주문 순서가 틀렸거나(늦게 적힌 매수) 주문 내역에 없는 입고가 있었다.
 * 값은 지금 평균 구매가로 판 수량 전부를 추정('order-uncertain'), 수량은 음수로 두어 다음 기준점의 이관 추정이 빠진 입고만큼 나오게 한다.
 * 그 구간의 다음 매도는 평균 구매가를 모른다 (다음 기준점에서 다시 안다)
 */
function oversoldAfter(s: State, f: LedgerFill, fx: number | null, std: number | null, costs: Realized["costs"], opts: LedgerOptions, out: Out): void {
  const cur = opts.currency;
  const known = s.qty > EPS && s.cost !== null;
  const share = (v: number) => (v * f.quantity) / s.qty;
  let realized: Realized;
  if (known) {
    const c = share(s.cost!);
    const gross = roundMoney(f.amount - c, cur);
    realized = {
      status: "order-uncertain",
      reason: REASONS.oversoldAfter,
      basis: null,
      anchorDate: null,
      avgCost: round4(s.cost! / s.qty),
      costAmount: roundMoney(c, cur),
      gross,
      rate: c > 0 ? round2(((f.amount - c) / c) * 100) : null,
      costs,
      net: costs.total !== null ? roundMoney(gross - costs.total, cur) : null,
      krw: null,
    };
  } else realized = { ...blank(costs), status: "unknown-cost", reason: s.costWhy ?? (s.cost === null ? REASONS.noAvg : REASONS.oversold) };
  if (cur === "USD") {
    if (known && s.krw !== null && fx !== null) {
      const ck = share(s.krw);
      realized.krw = { gross: Math.round(f.amount * fx - ck), costKrw: Math.round(ck), sellFx: fx, fxSource: "toss", estimated: true, reason: null };
    } else realized.krw = { gross: null, costKrw: null, sellFx: fx, fxSource: fx !== null ? "toss" : null, estimated: true, reason: known ? krwReason(s, fx) : REASONS.krwNoBook };
  }
  let stdOut: StdValue | undefined;
  if (opts.stdAt) {
    const proceeds = std !== null ? f.amount * std : null;
    stdOut = known && s.std !== null ? { proceeds, cost: share(s.std), missing: proceeds === null ? "fx" : null } : { proceeds, cost: null, missing: known ? (s.stdWhy ?? "cost") : "cost" };
  }
  s.qty = round6(s.qty - f.quantity);
  s.cost = null;
  s.costWhy = REASONS.oversold;
  s.krw = null;
  s.krwWhy = REASONS.krwNoBook;
  s.std = null;
  s.stdWhy = "cost";
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

/** 회사 행동으로 볼 매입금액 차이: 토스 매입금액이 원장 값의 ±0.5% 안 */
const CORP_COST_TOL = 0.005;
/**
 * 회사 행동으로 볼 가장 작은 수량 변화 |배수 − 1| (2%). 매입금액 허용폭(0.5%)보다 충분히 커야 한다 —
 * 300주 가운데 1주 출고(−0.33%)·1000주에 3주 입고(+0.3%) 같은 작은 이관이 '병합·무상증자'로 보이지 않게
 */
export const CORP_MIN_CHANGE = 0.02;

/**
 * 배수 k 로 수량이 바뀌었을 때 토스 매입금액 a 가 원장 매입금액 b 와 맞는지. 맞으면 차이(원·달러), 아니면 null.
 *  - 수량 변화 |k − 1| ≥ CORP_MIN_CHANGE
 *  - 매입금액 차이 ≤ 0.5%, 그리고 수량 변화의 1/10 이하 — 평균 구매가로 나간 출고는 매입금액이 수량만큼 줄어 회사 행동으로 보지 않는다
 */
function corpFit(k: number, a: number, b: number): number | null {
  if (!(k > 0) || !(b > 0)) return null;
  const change = Math.abs(k - 1);
  const diff = Math.abs(a - b);
  return change >= CORP_MIN_CHANGE && diff <= b * Math.min(CORP_COST_TOL, change / 10) ? diff : null;
}

/** 정수 N·1/N 근처(±0.1%) */
const nearWhole = (x: number) => Math.round(x) >= 2 && Math.abs(x - Math.round(x)) <= Math.round(x) * 0.001;

/** 배수 정리: 정수 N·1/N 근처(±0.1%)는 딱 맞춘 값, 그 밖(무상증자 1.5 등)은 넷째 자리 */
function tidyRatio(r: number): number {
  if (nearWhole(r)) return Math.round(r);
  if (nearWhole(1 / r)) return round4(1 / Math.round(1 / r));
  return round4(r);
}

/** 흔한 배수 모양: N·1/N 이거나 소수 둘째 자리까지 (1.5 · 1.05 · 0.25) — 두 가정의 매입금액이 같을 때 고르는 데 쓴다 */
function simpleRatio(r: number): boolean {
  return nearWhole(r) || nearWhole(1 / r) || Math.abs(r * 100 - Math.round(r * 100)) <= r * 100 * 1e-4;
}

/** 분할 N · 병합 1/N 에 쓰는 N */
const SPLIT_N = [...Array.from({ length: 19 }, (_, i) => i + 2), 25, 30, 40, 50, 100];
/**
 * 회사 행동 뒤 같은 구간에 전부 팔아 토스 매입금액으로 맞춰 볼 수 없을 때 받아들이는 흔한 배수 —
 * 분할 N · 병합 1/N (N = 2~20 · 25 · 30 · 40 · 50 · 100), 무상증자·주식배당 1.02~1.10(1% 단위) · 1.15 · 1.2 · 1.25 · 1.3 · 1.4 · 1.5 · 2.5
 */
export const COMMON_RATIOS: readonly number[] = [...SPLIT_N, ...SPLIT_N.map((n) => 1 / n), 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 2.5];

/**
 * fromQty 주가 회사 행동 뒤 toQty 주가 되었다고 볼 흔한 배수 (COMMON_RATIOS 가운데 — 없으면 null). 행동 뒤 수량은 딱 배수만큼이거나,
 * 온 주식 수(정수)였다면 1주 미만 끝수를 현금으로 받아 내린 값이다 (333주 × 1.05 = 349.65 → 349주). 여럿이 맞으면 실제 배수에 가장 가까운 것.
 * 수량 변화 2% 미만(CORP_MIN_CHANGE)은 보지 않는다
 */
export function commonRatio(fromQty: number, toQty: number): number | null {
  if (!(fromQty > EPS) || !(toQty > EPS)) return null;
  const k = toQty / fromQty;
  if (Math.abs(k - 1) < CORP_MIN_CHANGE) return null;
  const whole = Math.abs(fromQty - Math.round(fromQty)) <= EPS;
  let best: number | null = null;
  for (const r of COMMON_RATIOS) {
    const exact = fromQty * r;
    const tol = 1e-6 + exact * 1e-9;
    const fits = Math.abs(toQty - exact) <= tol || (whole && toQty >= Math.floor(exact + tol) - tol && toQty <= exact + tol);
    if (fits && (best === null || Math.abs(Math.log(r / k)) < Math.abs(Math.log(best / k)))) best = r;
  }
  return best === null ? null : tidyRatio(best);
}

/**
 * 판 가격이 배수 r 와 맞는지 (회사 행동 뒤 같은 구간에 전부 판 경우의 교차 확인). implied = 직전 스냅샷 가격 ÷ 그 구간 평균 판 가격.
 *  - 가격을 알면: implied 가 1(행동 없음)보다 r 에 가깝고(로그 거리) r 의 1.5배·1/1.5배 안 — 1,000원 종목을 250원에 팔았으면 4배 분할
 *  - 가격을 모르면: 수량이 늘어나는 쪽(분할·무상증자 — 원장은 이미 '많이 판 매도'라 순서 추정)만 배수 모양으로 받아들인다.
 *    줄어드는 쪽(병합)은 부분 매도 뒤 출고와 구별할 수 없어 받아들이지 않는다 (가짜 손실을 만들지 않게)
 */
function priceFits(r: number, refPrice: number | null | undefined, sells: LedgerFill[]): boolean {
  const q = sells.reduce((s, f) => s + f.quantity, 0);
  const amt = sells.reduce((s, f) => s + f.amount, 0);
  if (!(q > EPS) || !(amt > 0)) return false;
  if (refPrice === null || refPrice === undefined || !(refPrice > 0) || !Number.isFinite(refPrice)) return r > 1;
  const implied = refPrice / (amt / q);
  const off = Math.abs(Math.log(implied / r));
  return off < Math.abs(Math.log(implied)) && off <= Math.log(1.5);
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
  let s: State = { qty: 0, cost: 0, krw: 0, krwEst: false, krwWhy: null, std: 0, stdWhy: null, neg: false, anchored: false, costWhy: null, ratio: null };
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

  // 기준점 i 뒤 구간(segs[i + 1])을 start 에서 돌려 target 에 적는다 (출발 기준점 표시 · 순서 모름 꼬리표까지)
  const runAfter = (i: number, start: State, target: Out): State => {
    const a = anchors[i]!;
    const seg = segs[i + 1]!;
    const end = anchors[i + 1] ? t(anchors[i + 1]!.asOf) : Infinity;
    const r = runSegment(start, seg, t(a.asOf), end, opts, target);
    for (const k of sellKeys(seg)) {
      const x = target.get(k)?.realized;
      if (!x || x.status === "unknown-cost") continue;
      x.basis = "snapshot";
      x.anchorDate = a.date;
    }
    for (const k of r.uncertain) tagUncertain(target, k);
    return r.state;
  };

  // ── 기준점마다 ──
  /** 지금 구간이 출발한 원장 (회사 행동 '처음 가정'으로 구간을 다시 돌릴 때) */
  let segStart: State | null = null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    /** 앞 구간의 수량 변화가 회사 행동(분할·무상증자 등)으로 설명됨 — 결제일 원화·원화 장부를 이어 쓴다 */
    let corp = false;
    if (i > 0) {
      // 앞 구간 끝 원장과 이 스냅샷 대조
      const prevSells = sellKeys(segs[i]!);
      if (Math.abs(s.qty - a.quantity) > EPS) {
        // 끝 가정: 행동이 구간 끝에 있었다 — 구간 몫은 행동 전 수량으로 계산한 그대로, 수량만 바뀜
        const endK = s.qty > EPS && a.quantity > EPS ? a.quantity / s.qty : 0;
        const endDiff = s.cost !== null && a.cost !== null ? corpFit(endK, a.cost, s.cost) : null;
        // 처음 가정: 행동이 구간 처음에 있었다 — 행동 뒤 수량으로 구간을 다시 돌려 스냅샷(수량·매입금액)과 맞춰 본다
        let start: { k: number; toQty: number; diff: number; state: State; out: Out; fromQty: number; ratio?: number } | null = null;
        if (segStart && segs[i]!.length && segStart.qty > EPS && segStart.cost !== null && a.cost !== null && a.quantity > EPS) {
          const k = (a.quantity - (s.qty - segStart.qty)) / segStart.qty;
          if (k > 0 && Math.abs(k - 1) > 1e-4) {
            const toQty = round6(segStart.qty * k);
            const scaled: State = { ...segStart, qty: toQty };
            const tmp: Out = new Map();
            const e = runAfter(i - 1, scaled, tmp);
            const diff = e.cost !== null && Math.abs(e.qty - a.quantity) <= EPS ? corpFit(k, a.cost, e.cost) : null;
            if (diff !== null) start = { k, toQty, diff, state: e, out: tmp, fromQty: segStart.qty };
          }
        }
        // 전부 판 경우 (스냅샷 0주·0원): 매입금액으로 맞춰 볼 수 없다 — 행동 뒤 수량(= 판 수량 − 산 수량)이 흔한 배수이고,
        // 판 가격이 그 배수와 맞으며(직전 종가를 알 때), 그 수량으로 다시 돌려 많이 판 매도 없이 딱 0주에서 끝나면 회사 행동 (처음 가정).
        // 아니면 예전처럼 이관 + 많이 판 매도는 '순서 추정' (양도세 합계에서는 뺀다 — taxSummary)
        if (segStart && segs[i]!.length && segStart.qty > EPS && segStart.cost !== null && a.quantity <= EPS) {
          const toQty = round6(segStart.qty - s.qty);
          const ratio = commonRatio(segStart.qty, toQty);
          if (ratio !== null && priceFits(ratio, anchors[i - 1]!.price, segs[i]!.filter((f) => f.side === "SELL"))) {
            const tmp: Out = new Map();
            const e = runAfter(i - 1, { ...segStart, qty: toQty }, tmp);
            const clean = Math.abs(e.qty) <= EPS && e.cost !== null && ![...tmp.values()].some((v) => v.realized && (v.realized.status === "unknown-cost" || v.realized.reason === REASONS.oversoldAfter));
            if (clean) start = { k: toQty / segStart.qty, toQty, diff: 0, state: e, out: tmp, fromQty: segStart.qty, ratio };
          }
        }
        // 둘 다 맞으면 토스 매입금액에 더 가까운 쪽. 매입금액이 같으면(매수만 있는 구간) 배수가 흔한 모양인 쪽, 그래도 같으면 처음 가정
        // (회사 행동은 장 시작 전에 반영되므로 구간 몫은 행동 뒤인 경우가 많다) — 1→4 분할 날 판 5주가 분할 전 평균으로 계산되어 가짜 손실이 나지 않게
        const useStart =
          start !== null &&
          (endDiff === null ||
            start.diff < endDiff - unit(cur) ||
            (Math.abs(start.diff - endDiff) <= unit(cur) && (simpleRatio(start.k) || !simpleRatio(endK))));
        let row: EstimatedRow;
        if (useStart) {
          for (const [key, v] of start!.out) out.set(key, v);
          row = { at: a.asOf, date: a.date, qty: round6(start!.toQty - start!.fromQty), fromQty: start!.fromQty, toQty: start!.toQty, reason: "split", ratio: start!.ratio ?? tidyRatio(start!.k) };
          s = start!.state;
        } else if (endDiff !== null) row = { at: a.asOf, date: a.date, qty: round6(a.quantity - s.qty), fromQty: s.qty, toQty: a.quantity, reason: "split", ratio: tidyRatio(endK) };
        else row = { at: a.asOf, date: a.date, qty: round6(a.quantity - s.qty), fromQty: s.qty, toQty: a.quantity, reason: "transfer" };
        estimated.push(row);
        corp = row.reason === "split";
        if (corp) check.splits++;
        else check.transfers++;
        mark(prevSells, (r) => {
          // 많이 판 매도의 '순서 추정'은 그대로 둔다 (그 까닭이 더 가깝다)
          if (r.status === "unknown-cost" || r.reason === REASONS.oversoldAfter) return;
          r.status = "estimated";
          r.reason = corp ? REASONS.split : REASONS.transfer;
        });
      } else if (a.cost !== null && s.cost !== null && !costClose(s.cost, a.cost, a.quantity, cur)) check.drift++;
    }
    // 스냅샷 값으로 맞춘다 (원화 매입금액은 토스 원화 장부 값, 없으면 수량이 맞거나 회사 행동일 때만 쌓아 온 값)
    const sameQty = Math.abs(s.qty - a.quantity) <= EPS;
    const carry = (sameQty && (i > 0 || preOk)) || corp;
    const next: State = {
      qty: a.quantity,
      cost: a.quantity <= EPS ? 0 : (a.cost ?? (carry && s.cost !== null ? s.cost : null)),
      krw: a.quantity <= EPS ? 0 : (a.costKrw ?? (carry && s.krw !== null ? s.krw : null)),
      krwEst: a.costKrw !== null ? a.costKrwEstimated : s.krwEst,
      krwWhy: a.quantity <= EPS || a.costKrw !== null ? null : carry && s.krw !== null ? null : REASONS.krwNoBook,
      // 결제일 원화: 스냅샷은 모른다 — 수량이 맞으면(첫 기준점은 기록 전 원장이 맞을 때만) 쌓아 온 값, 회사 행동이면 그대로, 이관이면 모름
      std: a.quantity <= EPS ? 0 : carry ? s.std : null,
      stdWhy: a.quantity <= EPS ? null : carry ? s.stdWhy : "cost",
      neg: false,
      anchored: true,
      costWhy: null,
      ratio: a.costRatio,
    };
    // 구간을 돌리면 원장이 바뀌므로 출발 값은 따로 둔다
    segStart = clone(next);
    s = runAfter(i, next, out);
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
