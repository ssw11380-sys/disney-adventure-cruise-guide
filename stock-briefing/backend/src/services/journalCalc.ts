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
 *    회사 행동은 행동 시점을 사이 몫의 앞(처음 가정)·몫 사이(판 가격도 맞을 때 — 시간외 매매 뒤 행동)·뒤(끝 가정)마다 계산해 토스 매입금액에
 *    가장 가까운 쪽을 고르고(같으면 흔한 배수 모양 → 이른 시점), 행동 뒤 몫은 행동 뒤 수량으로 다시 계산한다
 *    (1→4 분할 날 판 5주가 분할 전 평균으로 계산되어 가짜 손실이 나지 않게).
 *    순서를 모르는 몫이 섞인 구간은 매수 먼저·매도 먼저 두 순서로 맞춰 보고(어느 한쪽만 맞아도 받아들임), 그 매도의 '순서 추정'은 그대로 둔다.
 *    다음 스냅샷이 0주(행동 뒤 같은 구간에 전부 팖)면 매입금액으로 맞춰 볼 수 없어: ① 행동 시점마다 행동 뒤 수량(그 뒤 판 수량 − 산 수량)이
 *    흔한 배수(COMMON_RATIOS — 1주 미만 끝수는 현금으로 받아 내림, 병합만 올림도)이고, 판 가격이 그 배수와 맞으며(직전 기록 가격 — 권리락 뒤 늦게
 *    들어온 새 주식은 앞 기록에서 한 번에 그 배수만큼 내린 가격까지. 이웃한 흔한 배수가 더 가까우면 아님), 그 수량으로 다시 돌려 많이 판 매도 없이
 *    딱 0주에서 끝나면 회사 행동. 가격을 모르면 받아들이지 않는다. 1.02~1.10 같은 작은 배수는 가격의 하루 움직임과 구별되지 않아 'order-uncertain'.
 *    ② 흔하지 않은 큰 배수인데 판 가격이 따라가면 행동으로 계산하되 'order-uncertain' ③ 판 가격이 직전 가격 쪽이면 이관 'estimated'
 *    ④ 그 밖은 이관 + 구간 매도 모두 'order-uncertain' (방향과 상관없이 — 양도세 합계에서는 기본으로 뺀다. 수익률은 그 구간을 건너뛴다)
 *  - 매입금액으로도 흔한 배수로도 맞지 않으면 가격 비율로 먼저 정한 큰 배수(분할·병합)로 구간 처음에 행동이 있었다고 보고, 남는 수량만 이관으로 나눈다
 *    (분할과 같은 구간의 입고·출고). 들어온 몫이 있으면 구간 매도는 'order-uncertain'
 *  - 수량은 같은데 토스 매입금액이 0.5% 넘게 달라지면(분사 등) 결제일 원화 매입금액도 같은 비율로 고치고 그 뒤 매도의 양도세 줄을 추정으로 표시.
 *    그 구간에 매도가 있으면 구간 처음에 매입금액을 비율로 바꿔 다시 돌리고(달라진 때를 몰라) 그 매도는 'order-uncertain'
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
  splitUncertain: "분할·병합·감자 같은 주식 수 변화로 보이지만 비율이 흔하지 않아 평균 구매가를 추정했어요.",
  changeUncertain: "주문 내역에 없는 주식 수 변화(분할·병합·입고·출고 등)를 확인하지 못해 평균 구매가를 추정했어요.",
  costChanged: "수량은 그대로인데 토스 매입금액이 달라져(분사 등) 원화 취득가를 같은 비율로 추정했어요.",
  costChangedSell: "토스 매입금액이 달라진(분사 등) 구간의 매도라, 달라진 때를 몰라 평균 구매가를 토스 매입금액 비율로 추정했어요.",
  smallChange: "주식배당·무상증자 같은 작은 주식 수 변화로 보이지만 주문 내역에 없는 입고와 구별하기 어려워 평균 구매가를 추정했어요.",
  splitTransfer: "분할·병합과 주문 내역에 없는 입고가 함께 있어 평균 구매가를 추정했어요.",
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
  /** 취득가를 토스 매입금액 비율로 고쳐 추정함 (수량은 같은데 매입금액이 달라짐 — 분사 등). 아니면 없음 */
  estimated?: true;
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
  /**
   * 이관 줄이고 그 기록에 종목이 없을 때(0주) 그 구간 매도의 평균 판 가격 (종목 통화). 수익률의 이관 흐름 값에 쓴다 —
   * 분할을 알아보지 못한 입고를 분할 전 가격으로 재면 몇 배로 부풀기 때문. 없으면 없음
   */
  sellPx?: number;
  /**
   * 이관 줄인데 주식 수 변화를 확인하지 못함(④ — 병합·감자를 알아보지 못했을 수 있음). 수익률은 그 기록까지의 구간을 건너뛴다
   * (이관 흐름 값이 한 주 값과 크게 달라 가짜 수익률이 됨). 아니면 없음
   */
  uncertain?: true;
}

/** 수량은 같은데 토스 매입금액이 0.5% 넘게 달라진 기록 (분사 등) — 수익률에서 분사로 나온 새 종목 입고를 짝지을 때 */
export interface CostShift {
  at: string;
  date: string;
  /** 토스 매입금액이 줄어든 만큼 (종목 통화, 늘었으면 음수). 구간에 매매가 있으면 달라진 때(구간 처음)의 값 */
  amount: number;
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
  costShifts: CostShift[];
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
  /** 결제일 원화 매입금액을 토스 매입금액 비율로 고친 적이 있음 (추정 — 분사 등) */
  stdEst: boolean;
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
    s.stdEst = false;
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
      stdOut = { proceeds, cost: cs, missing: proceeds === null ? "fx" : null, ...(s.stdEst ? { estimated: true as const } : {}) };
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
    s.stdEst = false;
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
    stdOut =
      known && s.std !== null
        ? { proceeds, cost: share(s.std), missing: proceeds === null ? "fx" : null, ...(s.stdEst ? { estimated: true as const } : {}) }
        : { proceeds, cost: null, missing: known ? (s.stdWhy ?? "cost") : "cost" };
  }
  s.qty = round6(s.qty - f.quantity);
  s.cost = null;
  s.costWhy = REASONS.oversold;
  s.krw = null;
  s.krwWhy = REASONS.krwNoBook;
  s.std = null;
  s.stdWhy = "cost";
  s.stdEst = false;
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
 * 값은 매수 먼저 쪽을 쓴다 (sellFirst 면 매도 먼저 쪽 — 회사 행동 뒤 토스 매입금액과 매도 먼저 순서만 맞을 때).
 * ambiguous = 두 순서로 돌렸음 (순서를 모르는 몫이 있음)
 */
function runSegment(
  s: State,
  fills: LedgerFill[],
  startMs: number,
  endMs: number,
  opts: LedgerOptions,
  out: Out,
  sellFirst = false,
): { state: State; uncertain: Set<string>; ambiguous: boolean } {
  const uncertainFill = (f: LedgerFill) => f.basis !== "filled";
  const both = fills.some((f) => f.side === "BUY") && fills.some((f) => f.side === "SELL");
  if (!both || !fills.some(uncertainFill)) {
    for (const f of fills) apply(s, f, opts, out);
    return { state: s, uncertain: new Set(), ambiguous: false };
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
  for (const [k, v] of sellFirst ? outB : outA) out.set(k, v);
  return { state: sellFirst ? b : a, uncertain, ambiguous: true };
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

/** 분할 N · 병합 1/N 에 쓰는 N (미국 병합에 흔한 35·60·75·80·150·200·250·300·500·1000 포함) */
const SPLIT_N = [...Array.from({ length: 19 }, (_, i) => i + 2), 25, 30, 35, 40, 50, 60, 75, 80, 100, 150, 200, 250, 300, 500, 1000];
/**
 * 회사 행동 뒤 같은 구간에 전부 팔아 토스 매입금액으로 맞춰 볼 수 없을 때 받아들이는 흔한 배수 —
 * 분할 N · 병합 1/N (N = SPLIT_N), 무상증자·주식배당 1.02~1.10(1% 단위) · 1.15 · 1.2 · 1.25 · 1.3 · 1.4 · 1.5 · 2.5
 */
export const COMMON_RATIOS: readonly number[] = [...SPLIT_N, ...SPLIT_N.map((n) => 1 / n), 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 2.5];

/**
 * fromQty 주가 회사 행동 뒤 toQty 주가 되었다고 볼 수 있는 흔한 배수들 (COMMON_RATIOS 가운데, 실제 배수에 가까운 순 — 없으면 빈 목록).
 * 행동 뒤 수량은 딱 배수만큼이거나, 정수 주식으로 받았다면 1주 미만 끝수를 현금으로 받아 내린 값(333주 × 1.05 = 349.65 → 349주 ·
 * 소수 주식 10.5주 1/10 병합 = 1.05 → 1주)이다. 끝수를 올려 주는 것은 병합뿐이다(미국 병합에 흔함 — 1,003주 1/8 병합 = 125.375 → 126주).
 * 분할·무상증자·주식배당(배수 > 1)은 내림만 — 10주에 입고 1주가 1.02~1.10 주식배당으로 보이지 않게 (검토 반영 6차).
 * 끝수 때문에 여럿이 맞으면(적은 수량) 판 가격으로 고른다 (priceFit). 수량 변화 2% 미만(CORP_MIN_CHANGE)은 보지 않는다
 */
export function commonRatios(fromQty: number, toQty: number): number[] {
  if (!(fromQty > EPS) || !(toQty > EPS)) return [];
  const k = toQty / fromQty;
  if (Math.abs(k - 1) < CORP_MIN_CHANGE) return [];
  const wholeTo = Math.abs(toQty - Math.round(toQty)) <= EPS;
  const out: number[] = [];
  for (const r of COMMON_RATIOS) {
    const exact = fromQty * r;
    const tol = 1e-6 + exact * 1e-9;
    const upper = r > 1 ? exact + tol : Math.ceil(exact - tol) + tol;
    const fits = Math.abs(toQty - exact) <= tol || (wholeTo && toQty >= Math.floor(exact + tol) - tol && toQty <= upper);
    if (fits) out.push(r);
  }
  return out.sort((x, y) => Math.abs(Math.log(x / k)) - Math.abs(Math.log(y / k))).map(tidyRatio);
}

/**
 * 가격으로 가려낼 수 있는 흔한 배수 — 1.02~1.10(1% 간격)은 가격의 하루 움직임보다 촘촘해 뺀다. 판 가격이 배수 r 과 맞는지 볼 때
 * 이 가운데 r 보다 가까운 배수가 있으면 r 이 아니다 (1→4 분할 뒤 1,000주 출고 + 3,000주를 4분의 1 가격에 팖이 1→3 으로 보이지 않게)
 */
const PRICE_RATIOS: readonly number[] = COMMON_RATIOS.filter((r) => r < 1 || r >= 1.15);
/** 작은 배수 (주식배당·무상증자 1.02~1.10): 판 가격으로 입고와 구별하기 어렵다 — 받아들여도 'order-uncertain' */
const smallRatio = (r: number | undefined) => r !== undefined && r > 1 && r <= 1.1 + 1e-9;

/** 가격 비율 x 에 PRICE_RATIOS 가운데 r 보다 가까운 배수가 없는지 (r 은 목록에 없어도 된다 · 1% 안은 같은 배수 — 정리한 0.0286 = 1/35) */
function nearestOk(x: number, r: number): boolean {
  const off = Math.abs(Math.log(x / r));
  return !PRICE_RATIOS.some((c) => Math.abs(Math.log(c / r)) > 0.01 && Math.abs(Math.log(x / c)) < off - 1e-12);
}

const LN15 = Math.log(1.5);
/** 늦게 들어온 새 주식을 찾을 때 거슬러 보는 기간 (권리락 → 신주 상장 약 한 달, 미국 주식배당 배당락 → 지급 몇 주) */
const REF_DAYS = 120;
const okPrice = (p: number | null | undefined): number | null => (p !== null && p !== undefined && Number.isFinite(p) && p > 0 ? p : null);

/** 가격 비율 x(행동 전 가격 ÷ 판 가격)가 배수 r 쪽: 1(행동 없음)보다 r 에 가깝고 r 의 ×1.5·÷1.5 안. 맞으면 로그 거리, 아니면 null */
function towardR(x: number, r: number): number | null {
  const off = Math.abs(Math.log(x / r));
  return off < Math.abs(Math.log(x)) && off <= LN15 ? off : null;
}

/** 가격 비율 x 가 행동 없음(1) 쪽: 배수 r 보다 1 에 가깝고 ×1.5·÷1.5 안 (r = Infinity 면 ×1.5 안이기만) */
function towardOne(x: number, r: number): number | null {
  const off = Math.abs(Math.log(x));
  return off < Math.abs(Math.log(x / r)) && off <= LN15 ? off : null;
}

/** 몫들의 평균 가격 (수량·금액이 없으면 null) */
function avgPx(fs: LedgerFill[]): number | null {
  const q = fs.reduce((s, f) => s + f.quantity, 0);
  const amt = fs.reduce((s, f) => s + f.amount, 0);
  return q > EPS && amt > 0 ? amt / q : null;
}

/**
 * 매도 묶음의 판 가격이 기준 가격 base 에서 배수 r 쪽(none 이면 행동 없음 쪽)인지: 평균 판 가격의 비율이 그쪽이고
 * 매도마다 목표(r 또는 1)의 ×1.5·÷1.5 안 — 분할 전·뒤 매도가 섞여 평균만 우연히 맞는 경우(500주 1,000원 + 2,000주 250원 → 평균 400원 = 2.5배)를 막는다.
 * strict 면 배수 쪽일 때 이웃한 흔한 배수(PRICE_RATIOS)가 r 보다 가깝지 않아야 한다 (nearestOk). 맞으면 평균의 로그 거리, 아니면 null
 */
function groupFit(fs: LedgerFill[], base: number, r: number, none: boolean, strict = false): number | null {
  const avg = avgPx(fs);
  if (avg === null) return null;
  const off = none ? towardOne(base / avg, r) : towardR(base / avg, r);
  if (off === null) return null;
  if (strict && !none && !nearestOk(base / avg, r)) return null;
  const target = none ? 1 : r;
  for (const f of fs) if (!(f.quantity > EPS && f.amount > 0) || Math.abs(Math.log(base / (f.amount / f.quantity) / target)) > LN15) return null;
  return off;
}

/**
 * 판 가격이 배수 r 의 회사 행동과 맞는지 (행동 뒤 같은 구간에 전부 판 경우의 교차 확인). refs = 행동 전 기록의 한 주 가격들
 * (가장 최근이 먼저 — 수량이 같던 기록만, REF_DAYS 안). 행동 앞 매도(pre)는 refs[0] 에서 행동 없음 쪽, 행동 뒤 매도(post)는 배수 쪽이어야 한다.
 *  - 바로: refs[0] ÷ 판 가격이 r 쪽 — 1,000원 종목을 250원에 팔았으면 4배 분할
 *  - 늦게 들어온 새 주식(r > 1 — 무상증자·주식배당: 권리락·배당락 날 가격이 먼저 내리고 새 주식은 몇 주 뒤): 판 가격은 refs[0] 과 같은 쪽이고,
 *    앞 기록 사이에서 가격이 한 번에 r 만큼 내렸으며(이웃한 흔한 배수가 더 가까우면 아님 — 10% 내린 날이 1.2배로 보이지 않게), 내리기 전 가격 ÷ 판 가격이 r 쪽
 * 행동 뒤 매도는 이웃한 흔한 배수가 r 보다 가까우면 받아들이지 않는다 (가격 비율 4 인데 수량이 1→3 인 경우).
 * 가격을 모르면(refs 가 비면) 맞춰 볼 수 없다 (null — 수량만 보고 받아들이지 않는다). 맞으면 수량으로 무게를 준 로그 거리
 */
function priceFit(r: number, refs: number[], pre: LedgerFill[], post: LedgerFill[]): number | null {
  const ref = refs[0];
  if (ref === undefined || !post.length) return null;
  let postErr = groupFit(post, ref, r, false, true);
  if (postErr === null && r > 1 && groupFit(post, ref, r, true) !== null) {
    for (let m = 0; m + 1 < refs.length; m++) {
      const drop = refs[m + 1]! / refs[m]!;
      if (towardR(drop, r) === null || !nearestOk(drop, r)) continue;
      const e = groupFit(post, refs[m + 1]!, r, false, true);
      if (e !== null && (postErr === null || e < postErr)) postErr = e;
    }
  }
  if (postErr === null) return null;
  const preErr = pre.length ? groupFit(pre, ref, r, true) : 0;
  if (preErr === null) return null;
  const qPre = pre.reduce((s, f) => s + f.quantity, 0);
  const qPost = post.reduce((s, f) => s + f.quantity, 0);
  return (preErr * qPre + postErr * qPost) / (qPre + qPost);
}

/** 매입금액으로 맞춘 가운데 시점 행동의 판 가격 확인: 매도가 없으면 통과, 있으면 가격을 알아야 하고 앞 매도는 행동 없음 쪽 · 뒤 매도는 배수 쪽 */
function midPriceOk(k: number, refs: number[], pre: LedgerFill[], post: LedgerFill[]): boolean {
  if (!pre.length && !post.length) return true;
  const ref = refs[0];
  if (ref === undefined) return false;
  if (pre.length && groupFit(pre, ref, k, true) === null) return false;
  return !post.length || priceFit(k, refs, [], post) !== null;
}

/** 회사 행동 후보: 구간 몫 p 바로 앞에서 fromQty → toQty (p = 몫 수면 구간 끝) */
interface Cand {
  p: number;
  k: number;
  fromQty: number;
  toQty: number;
  /** 토스 매입금액과의 차이 (0주로 끝난 구간은 0) */
  diff: number;
  state: State;
  /** 다시 돌린 결과 (끝 가정은 이미 적힌 그대로라 null) */
  out: Out | null;
  /** 흔한 배수 (0주로 끝난 구간) */
  ratio?: number;
  /** 판 가격 로그 거리 (0주로 끝난 구간) */
  err?: number;
}

/**
 * 매입금액으로 고른 두 후보 가운데 x 가 나은지: 토스 매입금액에 더 가까운 쪽, 같으면(1원·1센트 안 — 매수만 있는 구간) 배수가 흔한 모양인 쪽,
 * 그래도 같으면 이른 시점 (회사 행동은 장 시작 전에 반영되므로 구간 몫은 행동 뒤인 경우가 많다 — 1→4 분할 날 판 5주가 분할 전 평균으로 계산되어 가짜 손실이 나지 않게)
 */
function betterCand(x: Cand, y: Cand, cur: Cur): boolean {
  if (x.diff < y.diff - unit(cur)) return true;
  if (Math.abs(x.diff - y.diff) > unit(cur)) return false;
  const sx = simpleRatio(x.k);
  const sy = simpleRatio(y.k);
  return sx !== sy ? sx : x.p < y.p;
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
  let s: State = { qty: 0, cost: 0, krw: 0, krwEst: false, krwWhy: null, std: 0, stdWhy: null, stdEst: false, neg: false, anchored: false, costWhy: null, ratio: null };
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

  /**
   * 기준점 i 뒤 구간(segs[i + 1])을 start 에서 돌려 target 에 적는다 (출발 기준점 표시 · 순서 모름 꼬리표까지). start 는 바꾸지 않는다.
   * at 을 주면 회사 행동이 그 구간 몫 at.p 바로 앞에 있었다고 보고, 그때 수량을 at.toQty 로 바꿔 이어 돌린다 (매입금액은 그대로).
   * sellFirst 면 순서를 모르는 몫은 매도 먼저 값으로 적는다. ambiguous = 순서를 모르는 몫이 있어 두 순서로 돌렸음
   */
  const runAfter = (i: number, start: State, target: Out, at?: { p: number; toQty: number }, sellFirst = false): { state: State; ambiguous: boolean } => {
    const a = anchors[i]!;
    const seg = segs[i + 1]!;
    const begin = t(a.asOf);
    const end = anchors[i + 1] ? t(anchors[i + 1]!.asOf) : Infinity;
    const uncertain: string[] = [];
    let st: State;
    let ambiguous: boolean;
    if (!at) {
      const r = runSegment(clone(start), seg, begin, end, opts, target, sellFirst);
      st = r.state;
      ambiguous = r.ambiguous;
      uncertain.push(...r.uncertain);
    } else {
      const before = seg.slice(0, at.p);
      const after = seg.slice(at.p);
      const r1 = runSegment(clone(start), before, begin, after[0] ? t(after[0].at) : end, opts, target, sellFirst);
      const r2 = runSegment({ ...r1.state, qty: at.toQty }, after, before.length ? t(before[before.length - 1]!.at) : begin, end, opts, target, sellFirst);
      st = r2.state;
      ambiguous = r1.ambiguous || r2.ambiguous;
      uncertain.push(...r1.uncertain, ...r2.uncertain);
    }
    for (const k of sellKeys(seg)) {
      const x = target.get(k)?.realized;
      if (!x || x.status === "unknown-cost") continue;
      x.basis = "snapshot";
      x.anchorDate = a.date;
    }
    for (const k of uncertain) tagUncertain(target, k);
    return { state: st, ambiguous };
  };

  /** 기준점 j 에서 거슬러 수량이 같던 기록들의 한 주 가격 (가장 최근이 먼저, REF_DAYS 안). 기준점 j 가격을 모르면 빈 목록 */
  const priceRefs = (j: number): number[] => {
    const base = anchors[j]!;
    const p0 = okPrice(base.price);
    if (p0 === null) return [];
    const refs = [p0];
    for (let m = j - 1; m >= 0; m--) {
      const x = anchors[m]!;
      if (Math.abs(x.quantity - base.quantity) > EPS || t(base.asOf) - t(x.asOf) > REF_DAYS * 86_400_000) break;
      const p = okPrice(x.price);
      if (p !== null) refs.push(p);
    }
    return refs;
  };

  /**
   * 수량은 같은데 토스 매입금액이 달라진 구간(분사 등)에 매매가 있을 때: 달라진 때를 몰라 구간 처음이라고 보고, 처음 매입금액(원화 장부·결제일 원화 포함)을
   * f 배로 바꿔 다시 돌린다. 이동평균의 끝 매입금액은 처음 매입금액에 대해 선형(E(f) = f·X + Y)이라 0 배·1 배로 돌려 f 를 구한다.
   * 끝 매입금액이 토스 값과 맞으면 결과, 아니면(처음 몫을 모두 팔고 다시 산 구간 등) null
   */
  const costScale = (i: number, start: State, target: number): { state: State; out: Out; shift: number } | null => {
    const c0 = start.cost;
    if (c0 === null || !(c0 > 0) || !(start.qty > EPS)) return null;
    const scaled = (f: number): State => ({
      ...start,
      cost: c0 * f,
      krw: start.krw !== null ? start.krw * f : null,
      krwEst: start.krw !== null ? true : start.krwEst,
      std: start.std !== null ? start.std * f : null,
      stdEst: start.std !== null ? true : start.stdEst,
    });
    const y = runAfter(i, scaled(0), new Map()).state.cost;
    const e1 = runAfter(i, scaled(1), new Map()).state.cost;
    if (y === null || e1 === null || !(e1 - y > unit(cur))) return null;
    const f = (target - y) / (e1 - y);
    if (!(f > 0)) return null;
    const tmp: Out = new Map();
    const e = runAfter(i, scaled(f), tmp).state;
    if (e.cost === null || !costClose(e.cost, target, e.qty, cur)) return null;
    return { state: e, out: tmp, shift: c0 * (1 - f) };
  };

  // ── 기준점마다 ──
  const costShifts: CostShift[] = [];
  /** 지금 구간이 출발한 원장 (회사 행동 시점을 바꿔 구간을 다시 돌릴 때) */
  let segStart: State | null = null;
  /** 지금 구간에 순서를 모르는 몫이 있어 두 순서로 돌렸음 (끝 가정도 매도 먼저로 맞춰 본다) */
  let segAmbiguous = false;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    /** 앞 구간의 수량 변화가 회사 행동(분할·무상증자 등)으로 설명됨 — 결제일 원화·원화 장부를 이어 쓴다 */
    let corp = false;
    /** 수량은 같은데 토스 매입금액이 달라짐(분사 등): 결제일 원화 매입금액에 곱할 비율 */
    let stdScale: number | null = null;
    if (i > 0) {
      // 앞 구간 끝 원장과 이 스냅샷 대조
      const seg = segs[i]!;
      const prevSells = sellKeys(seg);
      const start0 = segStart;
      const qtyMatch = Math.abs(s.qty - a.quantity) <= EPS;
      if (!qtyMatch) {
        const n = seg.length;
        const refs = priceRefs(i - 1);
        const sellsIn = (from: number, to: number) => seg.slice(from, to).filter((f) => f.side === "SELL");
        /** 구간 몫 [0, p) 를 적용한 수량 (행동 전 — 많이 판 매도가 끼면 null) */
        const qtyBefore = (p: number): number | null => {
          let q = start0!.qty;
          for (let j = 0; j < p; j++) {
            const f = seg[j]!;
            q = round6(q + (f.side === "BUY" ? f.quantity : -f.quantity));
            if (q < -EPS) return null;
          }
          return q;
        };
        /** 몫 [p, n) 의 판 수량 − 산 수량 */
        const netSold = (p: number) => round6(seg.slice(p).reduce((acc, f) => acc + (f.side === "SELL" ? f.quantity : -f.quantity), 0));
        /** 다시 돌린 구간에 많이 판 매도·평균 모름이 없음 */
        const noOversold = (tmp: Out) => ![...tmp.values()].some((v) => v.realized && (v.realized.status === "unknown-cost" || v.realized.reason === REASONS.oversoldAfter));
        /**
         * 가격으로 먼저 정한 배수 (검토 반영 6차 — 분할·병합과 같은 구간의 입고·출고): x = 직전 기록 가격 ÷ 이 기록 가격(0주면 구간 평균 판 가격).
         * r = PRICE_RATIOS 의 큰 배수(×1.5 이상·1/1.5 이하) 가운데 x 에 가장 가까운 것 — 1 보다 r 에 가깝고 ×1.5 안, 수량만 본 배수(k0)보다 x 에 가깝거나 같고,
         * 구간 매도는 모두 r 쪽 가격. 구간 처음에 행동이 있었다고 보고 다시 돌려(많이 판 매도 없이) 남는 수량(rest)은 이관 — 행동이 만든 수량 변화의 절반 이하.
         * 출고면 토스 매입금액이 평균 그대로 줄었는지, 입고면 들어온 몫의 평균(토스 매입금액 − 원장 매입금액)이 행동 뒤 가격의 ×2·÷2 안인지 본다
         * (주가가 크게 내린 날의 입고·출고를 분할로 잘못 보지 않게). 입고가 있으면 구간 매도는 '순서 추정'(들어온 몫의 평균·때를 모름).
         * 토스 매입금액으로 가려낼 수 없는데(없음 · 0주) 수량만 보면 다른 흔한 배수와 딱 맞으면(1→3 수량인데 가격은 4배 · 1/10 병합 뒤 크게 내림)
         * 어느 쪽인지 모른다: 구간 매도는 '순서 추정', 이관 줄은 확인하지 못함(수익률은 그 구간을 건너뜀)
         */
        const priceFirst = (): { cand: Cand; rest: number; unsure: string | null; unseen: boolean } | null => {
          if (!start0 || !(start0.qty > EPS) || start0.cost === null || !refs.length) return null;
          const sells = sellsIn(0, n);
          const px = okPrice(a.quantity > EPS ? a.price : null) ?? avgPx(sells);
          if (px === null) return null;
          const x = refs[0]! / px;
          let r: number | null = null;
          for (const c of PRICE_RATIOS) if (Math.abs(Math.log(c)) >= LN15 - 1e-9 && (r === null || Math.abs(Math.log(x / c)) < Math.abs(Math.log(x / r)))) r = c;
          if (r === null || towardR(x, r) === null) return null;
          const qtyTo = round6(a.quantity + netSold(0));
          const k0 = qtyTo / start0.qty;
          if (k0 > EPS && Math.abs(Math.log(x / r)) > Math.abs(Math.log(x / k0)) + 1e-9) return null;
          const rivals = a.cost === null || a.quantity <= EPS ? commonRatios(start0.qty, qtyTo) : [];
          const rival = rivals.length > 0 && !rivals.some((c) => Math.abs(Math.log(c / r!)) <= 0.01);
          if (sells.length && groupFit(sells, refs[0]!, r, false, true) === null) return null;
          const whole = Math.abs(start0.qty - Math.round(start0.qty)) <= EPS;
          const toQty = whole ? (r > 1 ? Math.floor(start0.qty * r + 1e-9) : Math.round(start0.qty * r)) : round6(start0.qty * r);
          if (!(toQty > EPS)) return null;
          const tmp: Out = new Map();
          const e = runAfter(i - 1, start0, tmp, { p: 0, toQty }).state;
          if (e.cost === null || e.qty < -EPS || !noOversold(tmp)) return null;
          const rest = round6(a.quantity - e.qty);
          if (Math.abs(rest) > Math.abs(toQty - start0.qty) / 2) return null;
          let why: string | null = null;
          if (rest > EPS) {
            if (a.cost !== null) {
              const inAvg = (a.cost - e.cost) / rest;
              if (!(inAvg > 0) || Math.abs(Math.log(inAvg / (refs[0]! / r))) > Math.LN2) return null;
            }
            why = REASONS.splitTransfer;
          } else if (rest < -EPS) {
            if (a.quantity > EPS && a.cost !== null && e.qty > EPS && !(Math.abs((e.cost * a.quantity) / e.qty - a.cost) <= a.cost * CORP_COST_TOL + unit(cur))) return null;
          } else if (a.cost !== null) {
            // 수량은 배수와 딱 맞는데 토스 매입금액이 맞지 않음 (corpFit 을 지나지 못함) — 확인하지 못함
            why = REASONS.changeUncertain;
          }
          // 토스 매입금액이 없어 남는 수량(입고·출고)을 맞춰 보지 못함 — 주가가 크게 움직인 날의 이관일 수도 있다
          const unchecked = a.quantity > EPS && a.cost === null && Math.abs(rest) > EPS;
          if (rival || (unchecked && !why)) why = REASONS.changeUncertain;
          return { cand: { p: 0, k: r, fromQty: start0.qty, toQty, diff: 0, state: e, out: tmp, ratio: tidyRatio(r) }, rest, unsure: why, unseen: rival || unchecked };
        };
        let pick: Cand | null = null;
        /** 가격으로 먼저 정한 배수 뒤에 남는 수량 (이관 — 0 이면 없음) */
        let rest = 0;
        /** 회사 행동을 확인하지 못해 구간 매도를 '순서 추정'(양도세 합계에서 뺌)으로 둘 까닭 */
        let unsure: string | null = null;
        /** ④ 주식 수 변화를 확인하지 못한 이관 (수익률은 그 구간을 건너뜀) */
        let unseen = false;
        if (a.quantity > EPS) {
          // 행동 시점 p 마다 (p = 0 은 처음 가정 — 행동이 구간 처음, p = n 은 끝 가정 — 구간 몫은 행동 전 수량으로 계산한 그대로):
          // 그때 수량을 행동 뒤 수량으로 바꿔 구간을 다시 돌려 스냅샷(수량·매입금액)과 맞춰 본다.
          // 가운데 시점(시간외 NXT·미국 애프터마켓 뒤 행동, 기록이 빠진 날)은 판 가격도 맞아야 한다 (행동 전 매도는 직전 가격 쪽 · 뒤 매도는 배수 쪽).
          // 순서를 모르는 몫이 있으면 매수 먼저·매도 먼저 둘 다 맞춰 본다 (같으면 매수 먼저 — 그 매도의 '순서 추정'은 그대로)
          const cands: Cand[] = [];
          if (start0 && n && start0.cost !== null && a.cost !== null) {
            for (let p = 0; p < n; p++) {
              const q = qtyBefore(p);
              if (q === null || !(q > EPS)) continue;
              const toQty = round6(a.quantity + netSold(p));
              const k = toQty / q;
              if (!(k > 0) || Math.abs(k - 1) <= 1e-4) continue;
              if (p > 0 && !midPriceOk(k, refs, sellsIn(0, p), sellsIn(p, n))) continue;
              for (const sellFirst of [false, true]) {
                const tmp: Out = new Map();
                const run = runAfter(i - 1, start0, tmp, { p, toQty }, sellFirst);
                const e = run.state;
                const diff = e.cost !== null && Math.abs(e.qty - a.quantity) <= EPS ? corpFit(k, a.cost, e.cost) : null;
                if (diff !== null) cands.push({ p, k, fromQty: q, toQty, diff, state: e, out: tmp });
                if (!run.ambiguous) break;
              }
            }
          }
          const endK = s.qty > EPS ? a.quantity / s.qty : 0;
          const endDiff = s.cost !== null && a.cost !== null ? corpFit(endK, a.cost, s.cost) : null;
          if (endDiff !== null) cands.push({ p: n, k: endK, fromQty: s.qty, toQty: a.quantity, diff: endDiff, state: s, out: null });
          if (segAmbiguous && start0 && a.cost !== null) {
            const tmp: Out = new Map();
            const e = runAfter(i - 1, start0, tmp, undefined, true).state;
            const k = e.qty > EPS ? a.quantity / e.qty : 0;
            const diff = e.cost !== null ? corpFit(k, a.cost, e.cost) : null;
            if (diff !== null) cands.push({ p: n, k, fromQty: e.qty, toQty: a.quantity, diff, state: e, out: tmp });
          }
          for (const c of cands) if (!pick || betterCand(c, pick, cur)) pick = c;
          if (!pick) {
            // 매입금액으로 맞지 않음(분할과 같은 구간의 입고·출고) · 토스 매입금액이 없음: 가격으로 먼저 정한 배수
            const pf = priceFirst();
            if (pf) ({ cand: pick, rest, unsure, unseen } = pf);
          }
          // 그래도 이관인데 판 가격이 직전 가격에서 ×1.5·÷1.5 밖이면 알아보지 못한 회사 행동일 수 있다: 행동 전 평균으로 계산한 매도는 '순서 추정'
          const sells = sellsIn(0, n);
          if (!pick && sells.length && refs.length && groupFit(sells, refs[0]!, Infinity, true) === null) unsure = REASONS.changeUncertain;
        } else if (start0 && n && start0.qty > EPS && start0.cost !== null) {
          // 전부 판 경우 (스냅샷 0주·0원): 매입금액으로 맞춰 볼 수 없다.
          // ① 행동 시점 p 마다: 그때 수량 → 행동 뒤 수량(몫 [p, n) 의 판 − 산)이 흔한 배수(끝수 현금 내림 · 병합은 올림도)이고 판 가격이 맞으며(priceFit),
          //    다시 돌려 많이 판 매도 없이 딱 0주에서 끝나면 회사 행동 — 판 가격이 가장 잘 맞는 것 (같으면 이른 시점).
          //    1.02~1.10 같은 작은 배수는 판 가격으로 입고와 구별되지 않아 '순서 추정'
          const clean = (e: State, tmp: Out) => Math.abs(e.qty) <= EPS && e.cost !== null && noOversold(tmp);
          if (refs.length) {
            for (let p = 0; p < n; p++) {
              const q = qtyBefore(p);
              if (q === null || !(q > EPS)) continue;
              const toQty = netSold(p);
              for (const r of commonRatios(q, toQty)) {
                const err = priceFit(r, refs, sellsIn(0, p), sellsIn(p, n));
                if (err === null || (pick && err >= pick.err! - 1e-9)) continue;
                const tmp: Out = new Map();
                const e = runAfter(i - 1, start0, tmp, { p, toQty }).state;
                if (clean(e, tmp)) pick = { p, k: toQty / q, fromQty: q, toQty, diff: 0, state: e, out: tmp, ratio: r, err };
              }
            }
          }
          if (pick && smallRatio(pick.ratio)) unsure = REASONS.smallChange;
          const sells = sellsIn(0, n);
          if (!pick && sells.length) {
            // 가격으로 먼저 정한 큰 배수 + 남는 수량은 출고 (1→4 분할 뒤 1,000주 출고 + 3,000주 매도가 1→3 으로 보이지 않게)
            const pf = priceFirst();
            if (pf) ({ cand: pick, rest, unsure, unseen } = pf);
          }
          if (!pick && sells.length) {
            // ② 흔하지 않은 큰 배수(1.5배 이상 · 1/1.5 이하 — 10주 → 3주 감자, 입고가 섞인 분할 등)인데 판 가격이 그 배수를 따라가면
            //    행동으로 계산하되 '순서 추정'(양도세 합계에서 뺌)
            // ③ 판 가격이 직전 가격 쪽이면 이관 (부분 매도 뒤 출고, 입고 뒤 매도) — 지금처럼 '추정'
            // ④ 그 밖(가격을 모름 · 어느 쪽도 아님)은 이관으로 두고 구간 매도를 모두 '순서 추정' — 방향과 상관없이
            //    (병합을 놓친 매도의 가짜 이익·분할을 놓친 매도의 가짜 손실이 양도세 합계에 조용히 들지 않게. 수익률은 그 구간을 건너뜀)
            const toQty0 = netSold(0);
            const k0 = toQty0 / start0.qty;
            let transferOk = false;
            if (refs.length) {
              if (k0 > EPS && Math.abs(Math.log(k0)) >= LN15 && groupFit(sells, refs[0]!, k0, false) !== null) {
                const tmp: Out = new Map();
                const e = runAfter(i - 1, start0, tmp, { p: 0, toQty: toQty0 }).state;
                if (clean(e, tmp)) {
                  pick = { p: 0, k: k0, fromQty: start0.qty, toQty: toQty0, diff: 0, state: e, out: tmp };
                  unsure = REASONS.splitUncertain;
                }
              }
              if (!pick) transferOk = groupFit(sells, refs[0]!, k0 > EPS && Math.abs(k0 - 1) >= CORP_MIN_CHANGE ? k0 : Infinity, true) !== null;
            }
            if (!pick && !transferOk) {
              unsure = REASONS.changeUncertain;
              unseen = true;
            }
          }
        }
        const transferRow = (): EstimatedRow => {
          const row: EstimatedRow = { at: a.asOf, date: a.date, qty: round6(a.quantity - s.qty), fromQty: s.qty, toQty: a.quantity, reason: "transfer" };
          const px = a.quantity <= EPS ? avgPx(sellsIn(0, n)) : null;
          if (px !== null) row.sellPx = round4(px);
          if (unseen) row.uncertain = true;
          return row;
        };
        if (pick) {
          if (pick.out) for (const [key, v] of pick.out) out.set(key, v);
          s = pick.state;
          estimated.push({ at: a.asOf, date: a.date, qty: round6(pick.toQty - pick.fromQty), fromQty: pick.fromQty, toQty: pick.toQty, reason: "split", ratio: pick.ratio ?? tidyRatio(pick.k) });
          check.splits++;
          // 가격으로 먼저 정한 배수 뒤에 남는 수량: 이관 줄을 따로 (결제일 원화는 이관처럼 모름으로)
          if (Math.abs(rest) > EPS) {
            estimated.push(transferRow());
            check.transfers++;
          } else corp = true;
        } else {
          estimated.push(transferRow());
          check.transfers++;
        }
        const split = pick !== null;
        mark(prevSells, (r) => {
          // 많이 판 매도·같은 날 순서 모름의 '순서 추정'은 그대로 둔다 (그 까닭이 더 가깝다 — 양도세 합계에서 빼는 것도 그대로)
          if (r.status === "unknown-cost" || r.reason === REASONS.oversoldAfter || r.reason === REASONS.orderUncertain) return;
          if (unsure) {
            r.status = "order-uncertain";
            r.reason = unsure;
            return;
          }
          r.status = "estimated";
          r.reason = split ? REASONS.split : REASONS.transfer;
        });
      } else if (segAmbiguous && start0 && a.cost !== null && s.cost !== null && !costClose(s.cost, a.cost, a.quantity, cur)) {
        // 수량은 같다. 순서를 모르는 몫이 있어 매수 먼저 값이 토스 매입금액과 맞지 않으면 매도 먼저로도 맞춰 본다 (맞으면 그 값 — '순서 추정'은 그대로)
        const tmp: Out = new Map();
        const e = runAfter(i - 1, start0, tmp, undefined, true).state;
        if (e.cost !== null && Math.abs(e.qty - a.quantity) <= EPS && costClose(e.cost, a.cost, a.quantity, cur)) {
          for (const [key, v] of tmp) out.set(key, v);
          s = e;
        }
      }
      if (qtyMatch && a.cost !== null && s.cost !== null && !costClose(s.cost, a.cost, a.quantity, cur)) {
        check.drift++;
        // 수량은 같은데 토스 매입금액이 0.5% 넘게 달라짐(분사 등 — 토스가 매입금액을 나눠 적음): 결제일 원화 취득가도 같은 비율로 고친다 (추정).
        // 그 구간에 매도가 있으면 달라진 때를 몰라: 구간 처음에 매입금액을 비율로 바꿔 다시 돌리고(다음 날 판 것과 같은 값), 그 매도는 '순서 추정'
        // (행동 전 평균으로 계산한 양도차익이 아무 표시 없이 합계에 들지 않게 — 검토 반영 6차)
        if (s.cost > 0 && a.cost >= 0 && Math.abs(a.cost / s.cost - 1) > CORP_COST_TOL) {
          let shift = s.cost - a.cost;
          stdScale = a.cost / s.cost;
          if (prevSells.length) {
            const fixed = start0 ? costScale(i - 1, start0, a.cost) : null;
            if (fixed) {
              for (const [key, v] of fixed.out) out.set(key, v);
              s = fixed.state;
              stdScale = null;
              shift = fixed.shift;
            }
            mark(prevSells, (r) => {
              if (r.status === "unknown-cost" || r.status === "order-uncertain") return;
              r.status = "order-uncertain";
              r.reason = REASONS.costChangedSell;
            });
          }
          costShifts.push({ at: a.asOf, date: a.date, amount: shift });
        }
      }
    }
    // 스냅샷 값으로 맞춘다 (원화 매입금액은 토스 원화 장부 값, 없으면 수량이 맞거나 회사 행동일 때만 쌓아 온 값)
    const sameQty = Math.abs(s.qty - a.quantity) <= EPS;
    const carry = (sameQty && (i > 0 || preOk)) || corp;
    const keepStd = a.quantity > EPS && carry;
    const next: State = {
      qty: a.quantity,
      cost: a.quantity <= EPS ? 0 : (a.cost ?? (carry && s.cost !== null ? s.cost : null)),
      krw: a.quantity <= EPS ? 0 : (a.costKrw ?? (carry && s.krw !== null ? s.krw : null)),
      krwEst: a.costKrw !== null ? a.costKrwEstimated : s.krwEst,
      krwWhy: a.quantity <= EPS || a.costKrw !== null ? null : carry && s.krw !== null ? null : REASONS.krwNoBook,
      // 결제일 원화: 스냅샷은 모른다 — 수량이 맞으면(첫 기준점은 기록 전 원장이 맞을 때만) 쌓아 온 값(토스 매입금액이 달라졌으면 그 비율로 고친 추정),
      // 회사 행동이면 그대로, 이관이면 모름
      std: a.quantity <= EPS ? 0 : carry ? (s.std !== null && stdScale !== null ? s.std * stdScale : s.std) : null,
      stdWhy: a.quantity <= EPS ? null : carry ? s.stdWhy : "cost",
      stdEst: keepStd && s.std !== null && (s.stdEst || stdScale !== null),
      neg: false,
      anchored: true,
      costWhy: null,
      ratio: a.costRatio,
    };
    // 구간을 돌리면 원장이 바뀌므로 출발 값은 따로 둔다
    segStart = clone(next);
    const run = runAfter(i, next, out);
    s = run.state;
    segAmbiguous = run.ambiguous;
    // 기준점에 매입금액이 없어 구간 매도를 모름: 까닭은 apply 가 적었다 (noAvg)
  }
  return {
    fills: out,
    estimated,
    costShifts,
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
