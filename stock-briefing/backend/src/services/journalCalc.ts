/**
 * 매매일지 원장 (3-37, 플래그 tradeJournal) — 순수 계산. 시각·환율은 모두 인자로 받는다 (테스트는 고정 값).
 *
 * 평균 구매가는 이동평균법(토스증권 방식 — 산 금액 합을 수량으로 나눈 값)으로, (계좌, 종목) 짝마다 체결 몫(fills)을 시각 순으로 다시 돌린다.
 * 계산은 저장하지 않고 요청 때마다 돌린다 (수백 건이라 수 ms).
 *  - 매수: 수량 += q, 매입금액 += a (수수료는 넣지 않음 — 토스 '평균 구매가'처럼. 표본으로 확인할 것)
 *  - 매도: 팔린 몫의 원가 = 매입금액 × q ÷ 수량 (마지막 매도는 남은 매입금액 전부), 실현손익(비용 전) = a − 원가
 *  - 기준점(anchor) = 스냅샷(토스 보유 조회의 수량·매입금액). 그 뒤 매도는 'snapshot' — 토스 평단에서 출발
 *  - 첫 기준점 전 매도: 0주에서 돌린 결과가 첫 기준점과 맞으면 'history-checked' · 기준점이 없는 짝은 'history-only'(토스 잔고와 맞춰 보지 못함)
 *  - 같은 두 기준점 사이 반대 방향 몫 가운데 체결 시각(filled)이 아니거나 반대 방향 몫과 체결 시각이 똑같은 것이 있으면 순서를 모른다 →
 *    매수 먼저·매도 먼저로 계산해 값이 1원·1센트 넘게 다르면 매수 먼저 값 + 'order-uncertain' (매수 먼저가 뒤 기록과 맞지 않고 매도 먼저만 맞으면 매도 먼저 값)
 *
 * 보수 규칙 (검토 반영 10차 — 종목·해 단위, 안전이 먼저): (계좌, 종목) 짝의 한 해(그 시장 거래일 기준 1/1~12/31)는 그해에 — 또는 해가 바뀌는
 * 앞뒤 30일 안에 — 아래 가운데 하나라도 있으면 통째로 '확인 필요'다:
 *  ① 기록된 체결로 설명되지 않는 구간: 앞 기록(토스 수량·매입금액)에서 체결을 돌려 뒤 기록의 수량(±0.000001주)·토스 매입금액(±0.5% — 매도는
 *     이동평균으로 줄인 값)이 나오지 않음. 가진 수량보다 많이 판 매도, 뒤 기록에 매입금액이 없음, 주문 없이 들어온 주식(0→N·수량 늘어남)도 여기
 *  ② 한 구간(앞 기록 → 뒤 기록 주가, 앞 기록 주가 → 그 구간 체결 가격)의 주가가 ±25% 넘게 바뀜 — 3거래일 넘게 걸친 구간은 ±20% (한국·미국 같게,
 *     거래일은 그 시장 휴장일 목록으로 셈)
 *  ③ 한 구간 주가(앞 기록 ÷ 뒤 기록)가 흔한 분할·병합·주식배당 비율과 ±4% 안인데, 그 구간이나 뒤 30일 안에 주문 없는 주식 수 변화(①의 수량 차이)가 있음.
 *     분할·병합 비율(2·3·4·5·8·10·15·20 과 그 역수, 1.5)은 ±4% 안이면 늘 ±30% 넘는 변화라 ②가 먼저 잡으므로, 여기서는 주식배당·무상증자 비율
 *     1.02~1.10 만 본다 (±4% 를 늘어난 몫에 적용해 1.0192~1.104 — 주가가 그대로인 날은 아님)
 *  ④ 이 종목을 0주까지 판 뒤 30일 안에 같은 계좌·같은 시장에 다른 종목이 주문 없이 들어옴 (분사 모양 — opts.arrivals, 크기와 상관없이)
 *  ⑤ 첫 기록 전 매도가 있는데 첫 기록 전 주문 내역을 0주부터 돌린 결과가 첫 기록(수량·매입금액)과 그대로 맞지 않음 (기록이 없는 짝은 가진 것보다 많이 판 매도)
 * 확인 필요인 해: 그해 그 종목의 모든 매도는 'unexplained'(화면의 '확인 필요' — 손익 숫자 없음, 실현손익·양도세 합계에서 빠지고 까닭 문장과 함께 따로),
 * 매수의 '이 매수 뒤 평균'도 없음, 그해 그 종목이 든 기록 구간은 수익률에서 건너뜀(skips). 그 밖은 지금처럼 계산한다(이동평균·환율·양도세).
 * 설명되지 않은 구간 뒤 원가는 뒤 기록(토스 매입금액)에서 다시 출발하고, 결제일 원화 취득가는 그 뒤로 모른다('changed' — 모두 판 뒤 새로 산 몫부터 다시 앎).
 * 비율 짐작('1→4 분할로 보여요(추정)')은 이름표로만 — 어떤 숫자에도 쓰지 않는다.
 * 미국 종목은 토스 원화 보기처럼 매수 당시 환율(토스 매수 환율 usdKrwAt)로 원화 매입금액도 이동평균으로 함께 쌓는다(추정).
 * 해외 양도세(journalTax)는 같은 원장을 결제일 기준환율(stdAt)로 한 번 더 쌓는다 — 처음부터 온전한 주문 내역이 있을 때만.
 * 화면 문장(REASONS)은 여기 한 곳에서 만든다 (문구 검사 — 권유 표현 없음)
 */

import { isKrTradingDate, isUsTradingDate, tradingDate } from "./marketContext.js";
import { addDays } from "./tradeRecordCalc.js";

export type Cur = "KRW" | "USD";
export type Side = "BUY" | "SELL";
export type TimeBasis = "filled" | "ordered" | "seen";
/** unexplained = 확인 필요 (그해 그 종목에 기록으로 설명되지 않는 일이 있음 — 손익 숫자 없음) */
export type RealizedStatus = "ok" | "unknown-cost" | "order-uncertain" | "unexplained";
export type RealizedBasis = "snapshot" | "history-checked" | "history-only";

/** 화면에 그대로 쓰는 쉬운 문장 (서버 한 곳 — 문구 검사) */
export const REASONS = {
  needsCheck: "그해 이 종목에 주문 내역으로 설명되지 않는 변화가 있어 이 매도의 손익을 계산하지 않았어요.",
  noAvg: "토스 잔고에 매입금액이 없어 평균 구매가를 몰라요.",
  orderUncertain: "같은 날 사고판 순서를 몰라 추정했어요.",
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
  /** 그 스냅샷 그 종목 한 주 가격 (정규장 종가, 없으면 그때 현재가 — 종목 통화). 주가 변화 규칙(②③)에만 쓴다. 모르면 null·없음 */
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
  /** 'unexplained'(확인 필요) 일 때만: 그해 무엇이 있었는지 (화면에 그대로 — '10월 7일 기록: 수량 10 → 36주 · 기록된 매매대로라면 9주 / …') */
  change?: string;
  /** 'unexplained' 일 때만: 비율 짐작 이름표 ('1→4 분할로 보여요(추정)') — 숫자에 쓰지 않음. 없으면 null */
  guess?: string | null;
}

/**
 * 해외 양도세용: 결제일 기준환율로 쌓은 원화 (양도가액·취득가액). missing:
 *  cost = 원가를 모름(기록 전 몫) · fx = 결제일 환율 없음 · changed = 주문 내역으로 설명되지 않은 변화 뒤라 결제일 원화 취득가를 모름 ·
 *  unexplained = 이 매도가 확인 필요인 해에 있음 (손익을 계산하지 않음)
 */
export interface StdValue {
  proceeds: number | null;
  cost: number | null;
  missing: null | "cost" | "fx" | "changed" | "unexplained";
}

export interface FillResult {
  realized?: Realized;
  afterBuy?: { avgCost: number; quantity: number } | null;
  std?: StdValue;
}

/** 목록의 '기록과 다름'(①) · '큰 주가 변화'(②) 줄 — 뒤 기록마다 하나 */
export interface ChangeRow {
  /** 뒤 기록 (여기서 달라진 것을 봤음) */
  at: string;
  date: string;
  /** 앞 기록 날짜 */
  fromDate: string;
  kind: "unexplained" | "possible-action";
  /** 앞 기록 수량 · 뒤 기록 수량 */
  fromQty: number;
  toQty: number;
  /** 앞 기록에서 기록된 체결대로 돌린 끝 수량 (가진 것보다 많이 판 매도가 있으면 음수일 수 있음) */
  expectedQty: number;
  /** 무엇이 달라졌는지 (화면에 그대로) */
  text: string;
  /** 비율 짐작 이름표 — 숫자에 쓰지 않음. 없으면 null */
  guess: string | null;
}

/** 수익률에서 건너뛸 구간: 앞 기록 시각 초과 ~ 뒤 기록 시각 이하 (to null = 지금까지) */
export interface SkipSpan {
  from: string;
  to: string | null;
}

export interface PairCheck {
  anchors: number;
  preAnchor: "none" | "checked" | "mismatch" | "history-only" | "incomplete";
  /** 설명된 구간 가운데 토스 매입금액과 1원·1센트(평균) 넘게 달라 토스 값으로 맞춘 수 (0.5% 안) */
  drift: number;
  /** 설명되지 않은 구간 수 (①) */
  unexplained: number;
  /** 주가가 크게 바뀐 구간 수 (②) */
  priceJumps: number;
  /** 확인 필요인 해 */
  doubtYears: number[];
}

export interface PairResult {
  fills: Map<string, FillResult>;
  changes: ChangeRow[];
  skips: SkipSpan[];
  check: PairCheck;
  /** 원장 끝 상태 (지금 보유 — 기준점·주문 내역 기준) */
  holding: { quantity: number; avgCost: number | null };
}

/** 같은 계좌·같은 시장에 주문 없이 들어온 다른 종목: 들어왔을 수 있는 때 = 앞 기록 시각 초과 ~ 뒤 기록 시각 이하 (to null = 마지막 기록 뒤) */
export interface ArrivalSpan {
  from: string;
  to: string | null;
}

export interface LedgerOptions {
  currency: Cur;
  /** 미국: 그 시각의 토스 매수 환율 (저장한 값 — 없으면 null) */
  fxAt?: (at: string) => number | null;
  /** 해외 양도세: 그 몫의 결제일 기준환율 (없으면 null). 주면 몫마다 std 를 붙인다 */
  stdAt?: (f: LedgerFill) => number | null;
  /** 같은 계좌·같은 시장에 주문 없이 들어온 다른 종목 (④ 분사 모양) */
  arrivals?: ReadonlyArray<ArrivalSpan>;
}

const EPS = 1e-6;
/** 설명된 구간으로 볼 토스 매입금액 차이 (±0.5%) */
export const COST_TOL = 0.005;
/** ② 한 구간 주가 변화 한도: 3거래일까지 ±25%, 그보다 길게 걸친 구간 ±20% */
export const PRICE_MOVE = { short: 0.25, long: 0.2, shortDays: 3 } as const;
/** ③ 주식배당·무상증자 비율 범위 (앞 주가 ÷ 뒤 주가) · 허용폭 — 분할·병합 비율은 ②가 먼저 잡는다 */
const BONUS_RANGE = [1.02, 1.1] as const;
const RATIO_TOL = 0.04;
/** 해가 바뀌는 앞뒤로 함께 보는 날 · ③ 주식 수 변화를 기다리는 날 · ④ 0주 뒤 다른 종목을 보는 날 */
export const DOUBT_DAYS = 30;
const DAY_MS = 86_400_000;

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

/** 매입금액 둘이 ±0.5% 안 (1원·1센트 여유) */
const costWithin = (a: number, b: number, cur: Cur) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * COST_TOL + unit(cur);

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
  stdWhy: "cost" | "fx" | "changed" | null;
  /** 원장보다 많이 판 매도가 있었음 (기준점 전 — 앞부분 기록 없음) */
  neg: boolean;
  /** 기준점 뒤 가진 수량보다 많이 판 매도가 있었음 — 그 구간은 설명되지 않음 */
  over: boolean;
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
  if (f.quantity > s.qty + EPS) {
    // 가진 수량보다 많이 판 매도: 값을 지어내지 않는다 (그 해는 늘 확인 필요가 된다 — ①·⑤)
    out.set(f.key, {
      realized: { ...blank(costs), status: "unknown-cost", reason: REASONS.needsCheck },
      ...(opts.stdAt ? { std: { proceeds: std !== null ? f.amount * std : null, cost: null, missing: "cost" as const } } : {}),
    });
    if (s.anchored) {
      // 기준점 뒤: 0 으로 되돌리지 않는다 — 그 구간은 설명되지 않은 구간이 된다 (①)
      s.over = true;
      s.qty = round6(s.qty - f.quantity);
      Object.assign(s, { cost: null, costWhy: REASONS.needsCheck, krw: null, krwWhy: REASONS.krwNoBook, std: null, stdWhy: "cost" });
      return;
    }
    s.neg = true;
    Object.assign(s, { qty: 0, cost: 0, krw: 0, krwWhy: null, krwEst: false, std: 0, stdWhy: null });
    return;
  }
  const last = Math.abs(s.qty - f.quantity) <= EPS;
  const share = (v: number) => (last ? v : (v * f.quantity) / s.qty);
  let realized: Realized;
  if (s.cost === null) {
    realized = { ...blank(costs), status: "unknown-cost", reason: s.costWhy ?? REASONS.noAvg };
  } else {
    const c = share(s.cost);
    const gross = roundMoney(f.amount - c, cur);
    realized = {
      status: "ok",
      reason: null,
      basis: null,
      anchorDate: null,
      avgCost: round4(s.cost / s.qty),
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
    Object.assign(s, { cost: 0, krw: 0, krwEst: false, krwWhy: null, std: 0, stdWhy: null, costWhy: null });
  }
  out.set(f.key, { realized, ...(stdOut ? { std: stdOut } : {}) });
}

/** 원화 손익을 뺀 까닭: 빠진 환율을 바로 (매수 때 · 판매 때 · 둘 다), 그 밖은 원화 장부 없음 */
function krwReason(s: State, fx: number | null): string {
  const buyMissing = s.krw === null && s.krwWhy === REASONS.krwNoBuyFx;
  if (fx === null) return buyMissing ? REASONS.krwNoBothFx : REASONS.krwNoFx;
  return s.krwWhy ?? REASONS.krwNoBook;
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
 * 한 구간(두 기준점 사이)의 몫을 적용. 반대 방향 몫이 있고 체결 시각(filled)이 아닌 몫이나 반대 방향 몫과 체결 시각이 똑같은 몫이 섞이면
 * 순서를 모른다 (같은 시각은 저장 순서로 정하지 않음 — 토스 주문 목록은 새것부터 옴) →
 * 매수 먼저(불확실한 매수는 가장 이르게·매도는 가장 늦게)와 매도 먼저로 돌려, 매도 실현손익이 1원·1센트 넘게 다른 매도에 'order-uncertain'.
 * 값은 매수 먼저 쪽을 쓴다 (sellFirst 면 매도 먼저 쪽). ambiguous = 두 순서로 돌렸음 (순서를 모르는 몫이 있음)
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
  const sidesAt = new Map<number, Set<Side>>();
  for (const f of fills) sidesAt.set(t(f.at), (sidesAt.get(t(f.at)) ?? new Set<Side>()).add(f.side));
  const uncertainFill = (f: LedgerFill) => f.basis !== "filled" || sidesAt.get(t(f.at))!.size > 1;
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


// ── 화면 문장 조각 (서버 한 곳 — '수량 1,000 → 3,995주') ──

const okPrice = (p: number | null | undefined): number | null => (p !== null && p !== undefined && Number.isFinite(p) && p > 0 ? p : null);
const fmtQty = (q: number) => `${q < 0 ? "−" : ""}${Number(Math.abs(q).toFixed(6)).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
function fmtMoney(v: number, cur: Cur, perShare = false): string {
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (cur === "KRW") return `${sign}${Math.round(a).toLocaleString("en-US")}원`;
  return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: perShare ? 4 : 2 })}`;
}
/** 바뀐 비율 r(뒤 ÷ 앞) → '−50%' · '+300%' (10% 넘으면 정수, 아니면 소수 한 자리) */
function fmtPct(r: number): string {
  const p = (r - 1) * 100;
  const abs = Math.abs(p);
  return `${p >= 0 ? "+" : "−"}${abs >= 10 ? Math.round(abs) : abs.toFixed(1)}%`;
}
/** '9월 28일' */
const md = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
const yearOf = (date: string) => Number(date.slice(0, 4));

/**
 * 앞 날짜 초과 ~ 뒤 날짜 이하의 그 시장 거래일 수 (주말·휴장일 목록 KR_HOLIDAYS·US_HOLIDAYS 를 뺌 — 추석 연휴 다음 날도 1).
 * PRICE_MOVE.shortDays 를 넘으면 더 세지 않는다. 목록에 없는 해는 평일로 센다
 */
function tradingDaysAfter(from: string, to: string, cur: Cur): number {
  const open = cur === "KRW" ? isKrTradingDate : isUsTradingDate;
  let n = 0;
  for (let d = addDays(from, 1); d <= to && n <= PRICE_MOVE.shortDays; d = addDays(d, 1)) if (open(d)) n++;
  return n;
}

/**
 * 주식 수 배수 k 의 이름표 (짐작 — 숫자에 쓰지 않음): 정수 N 근처(tol 비율 안)는 '1→N 분할', 1/N 근처는 'N→1 병합',
 * 1.01~2 는 무상증자·주식배당. price 면 주가로 본 짐작이라 '…일 수 있어요'. 이름표와 그 배수(N · 1/N · k)를 준다
 */
function ratioLabel(k: number, tol: number, price = false): { label: string; ratio: number } | null {
  if (!(k > 0) || !Number.isFinite(k)) return null;
  const n = Math.round(k);
  if (n >= 2 && Math.abs(k - n) <= n * tol) return { label: price ? `1→${n} 분할·무상증자일 수 있어요(추정)` : `1→${n} 분할로 보여요(추정)`, ratio: n };
  const m = Math.round(1 / k);
  if (m >= 2 && Math.abs(1 / k - m) <= m * tol) return { label: price ? `${m}→1 병합일 수 있어요(추정)` : `${m}→1 병합으로 보여요(추정)`, ratio: 1 / m };
  if (!price && k >= 1.01 && k < 2) return { label: `무상증자·주식배당(주식 수 ×${Number(k.toFixed(3))})으로 보여요(추정)`, ratio: k };
  return null;
}

/**
 * 설명되지 않은 구간의 비율 짐작 (이름표로만 — 숫자에 쓰지 않음):
 *  - 뒤 기록에 수량이 있고 구간에 매수가 없으면: 앞·뒤 토스 평균 구매가의 비율(매도는 평균을 바꾸지 않으므로 분할·병합·무상증자면 그 배수)이
 *    흔한 모양이고, 뒤 수량이 그 배수로 설명되는 범위(판 몫이 모두 행동 전 ~ 모두 행동 뒤) 안일 때
 *  - 뒤 기록이 0주면: 판 수량 − 산 수량을 행동 뒤 수량으로 본 배수 — 앞 기록 주가 ÷ 평균 판 가격이 1보다 그 배수에 가깝고 ×1.15 안일 때만
 *    (보통 가격에 판 출고·입고는 짐작하지 않음)
 */
function guessOf(a: LedgerAnchor, b: LedgerAnchor, seg: LedgerFill[]): string | null {
  const sells = seg.filter((f) => f.side === "SELL");
  const sold = sells.reduce((acc, f) => acc + f.quantity, 0);
  if (b.quantity > EPS) {
    if (seg.some((f) => f.side === "BUY") || !(a.quantity > EPS) || !(a.cost !== null && a.cost > 0) || !(b.cost !== null && b.cost > 0)) return null;
    const g = ratioLabel(a.cost / a.quantity / (b.cost / b.quantity), 0.03);
    if (!g) return null;
    const lo = (a.quantity - sold) * g.ratio;
    const hi = a.quantity * g.ratio - sold;
    const tol = Math.max(1, b.quantity * 0.01);
    return b.quantity >= lo - tol && b.quantity <= hi + tol ? g.label : null;
  }
  const p0 = okPrice(a.price);
  const net = seg.reduce((acc, f) => acc + (f.side === "SELL" ? f.quantity : -f.quantity), 0);
  const amt = sells.reduce((acc, f) => acc + f.amount, 0);
  if (p0 === null || !(a.quantity > EPS) || !(net > EPS) || !(sold > EPS) || !(amt > 0)) return null;
  const k = net / a.quantity;
  const x = p0 / (amt / sold);
  const off = Math.abs(Math.log(x / k));
  return off < Math.abs(Math.log(x)) && off <= Math.log(1.15) ? (ratioLabel(k, 0.03)?.label ?? null) : null;
}

/** ③ 앞 주가 ÷ 뒤 주가가 주식배당·무상증자 비율(1.02~1.10, ±4%)이면 이름표, 아니면 null */
function bonusRatio(r: number): string | null {
  const lo = 1 + (BONUS_RANGE[0] - 1) * (1 - RATIO_TOL);
  const hi = 1 + (BONUS_RANGE[1] - 1) * (1 + RATIO_TOL);
  return r >= lo && r <= hi ? `무상증자·주식배당(주식 수 ×${Number(r.toFixed(2))})일 수 있어요(추정)` : null;
}

/** 그해를 확인 필요로 만든 일 하나 (①~⑤). from~to: 일어났을 수 있는 날 (그 시장 거래일) — 앞뒤 30일까지의 해가 확인 필요 */
interface DoubtEvent {
  from: string;
  to: string;
  /** 본 기록 날짜 (문장 앞 '10월 7일 기록: ') — 체결·첫 기록 전 일은 null (문장에 날짜가 있음) */
  seen: string | null;
  text: string;
  guess: string | null;
}

/** 기록 구간 하나 (기준점 i → i+1, 마지막은 i → 지금) */
interface Span {
  a: LedgerAnchor;
  /** 뒤 기록 (마지막 구간은 null) */
  b: LedgerAnchor | null;
  seg: LedgerFill[];
  /** ①의 수량 차이 (주문 없는 주식 수 변화 — 가진 것보다 많이 판 매도 포함) */
  orderless: boolean;
  /** ② 주가가 크게 바뀐 구간 (③은 같은 까닭을 두 번 적지 않는다) */
  moved: boolean;
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
  const check: PairCheck = { anchors: anchors.length, preAnchor: "none", drift: 0, unexplained: 0, priceJumps: 0, doubtYears: [] };
  /** 체결의 거래일 (한국 종목은 서울 날짜, 미국 종목은 뉴욕 날짜 — marketContext.tradingDate) */
  const fillDate = (f: LedgerFill) => tradingDate(f.at, cur === "KRW");
  const events: DoubtEvent[] = [];
  const changes: ChangeRow[] = [];
  /** 0주까지 판 매도 (④) — 시각 순으로 수량만 돌려 본다 */
  const zeroSells: LedgerFill[] = [];
  const findZeroSells = (seg: LedgerFill[], start: number) => {
    let q = start;
    for (const f of seg) {
      q = round6(q + (f.side === "BUY" ? f.quantity : -f.quantity));
      if (f.side === "SELL" && q <= EPS) zeroSells.push(f);
    }
  };

  // ── 첫 기준점 전 (0주에서) ──
  let s: State = { qty: 0, cost: 0, krw: 0, krwEst: false, krwWhy: null, std: 0, stdWhy: null, neg: false, over: false, anchored: false, costWhy: null, ratio: null };
  const a1 = anchors[0];
  const pre = runSegment(s, segs[0]!, -Infinity, a1 ? t(a1.asOf) : Infinity, opts, out);
  s = pre.state;
  const preOk = (() => {
    if (s.neg) return false;
    if (!a1) return true;
    if (Math.abs(s.qty - a1.quantity) > EPS) return false;
    if (a1.cost === null || s.cost === null) return a1.cost === null; // 스냅샷 매입금액을 모르면 수량만
    return costClose(s.cost, a1.cost, a1.quantity, cur);
  })();
  if (segs[0]!.length) check.preAnchor = !a1 ? (preOk ? "history-only" : "incomplete") : preOk ? "checked" : "mismatch";
  const preSells = segs[0]!.filter((f) => f.side === "SELL");
  if (preOk) {
    for (const f of preSells) {
      const r = out.get(f.key)?.realized;
      if (!r || r.status === "unknown-cost") continue;
      r.basis = a1 ? "history-checked" : "history-only";
      r.anchorDate = a1?.date ?? null;
    }
    for (const k of pre.uncertain) tagUncertain(out, k);
  } else {
    // 앞부분 주문 내역이 없음: 0주에서 돌린 값은 지어낸 값이다 (매수 뒤 평균도)
    for (const f of segs[0]!) if (f.side === "BUY") out.set(f.key, { afterBuy: null });
    // ⑤ 그 전 매도가 있으면 그 해들은 확인 필요
    if (preSells.length)
      events.push({
        from: fillDate(preSells[0]!),
        to: fillDate(preSells.at(-1)!),
        seen: null,
        text: a1 ? `첫 기록(${md(a1.date)} ${fmtQty(a1.quantity)}주) 전 주문 내역이 그 기록과 맞지 않아요` : "주문 내역에 그때 가진 수량보다 많이 판 매도가 있어요",
        guess: null,
      });
  }
  findZeroSells(segs[0]!, 0);

  /** 기준점 a 에서 출발하는 원장 (carry = 앞 원장이 이 기준점과 맞음 — 원화 장부·결제일 원화를 이어 쓴다) */
  const fromAnchor = (a: LedgerAnchor, prev: State, carry: boolean, first: boolean): State => {
    const zero = a.quantity <= EPS;
    return {
      qty: a.quantity,
      cost: zero ? 0 : (a.cost ?? (carry && prev.cost !== null ? prev.cost : null)),
      krw: zero ? 0 : (a.costKrw ?? (carry && prev.krw !== null ? prev.krw : null)),
      krwEst: a.costKrw !== null ? a.costKrwEstimated : prev.krwEst,
      krwWhy: zero || a.costKrw !== null || (carry && prev.krw !== null) ? null : REASONS.krwNoBook,
      // 결제일 원화: 스냅샷은 모른다 — 앞 원장이 맞으면 쌓아 온 값, 아니면 모름 (첫 기준점은 기록 전 몫 · 그 뒤는 설명되지 않은 변화)
      std: zero ? 0 : carry ? prev.std : null,
      stdWhy: zero ? null : carry ? prev.stdWhy : first ? "cost" : "changed",
      neg: false,
      over: false,
      anchored: true,
      costWhy: null,
      ratio: a.costRatio,
    };
  };
  /** 기록대로 돌린 끝 원장 e 가 뒤 기록 b 와 맞는지 (많이 판 매도 없음 · 수량 · 토스 매입금액 ±0.5%) */
  const fits = (e: State, b: LedgerAnchor): boolean => {
    if (e.over || Math.abs(e.qty - b.quantity) > EPS) return false;
    if (b.quantity <= EPS || e.cost === null) return true; // 앞 매입금액을 모르면 그 구간 매도는 이미 '모름'
    return b.cost !== null && costWithin(e.cost, b.cost, cur);
  };
  /**
   * ② 한 구간의 주가 변화: 뒤 기록 주가 · 그 구간 체결 가격이 앞 기록 주가에서 ±25%(3거래일 넘게 걸쳤으면 ±20%) 넘게 벗어남.
   * 거래일은 그 시장 휴장일을 빼고 센다 (추석 연휴 다음 날도 하루)
   */
  const priceMove = (a: LedgerAnchor, b: LedgerAnchor | null, seg: LedgerFill[]): { to: string; seen: string | null; text: string; guess: string | null } | null => {
    const p0 = okPrice(a.price);
    if (p0 === null) return null;
    const off = (r: number, to: string) => {
      const m = Math.abs(r - 1);
      return m > PRICE_MOVE.short || (m > PRICE_MOVE.long && tradingDaysAfter(a.date, to, cur) > PRICE_MOVE.shortDays);
    };
    const p1 = b && b.quantity > EPS ? okPrice(b.price) : null;
    if (b && p1 !== null && off(p1 / p0, b.date)) {
      const same = Math.abs(b.quantity - a.quantity) <= EPS ? ` · 주식 수 ${fmtQty(a.quantity)}주 그대로` : "";
      return { to: b.date, seen: b.date, text: `주가 ${fmtMoney(p0, cur, true)} → ${fmtMoney(p1, cur, true)} (${fmtPct(p1 / p0)})${same}`, guess: ratioLabel(p0 / p1, 0.1, true)?.label ?? null };
    }
    for (const f of seg) {
      if (!(f.quantity > EPS && f.amount > 0)) continue;
      const px = f.amount / f.quantity;
      const d = fillDate(f);
      if (off(px / p0, d))
        return { to: d, seen: null, text: `${md(d)} ${f.side === "SELL" ? "매도" : "매수"} 가격 ${fmtMoney(px, cur, true)} · 직전 기록 주가 ${fmtMoney(p0, cur, true)}보다 ${fmtPct(px / p0)}`, guess: ratioLabel(p0 / px, 0.1, true)?.label ?? null };
    }
    return null;
  };

  // ── 기준점마다: 구간을 기록대로 돌려 뒤 기록과 맞춰 본다 (원가는 늘 앞 기록의 토스 값에서) ──
  const spans: Span[] = [];
  let prev = s;
  let carry = preOk;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1] ?? null;
    const seg = segs[i + 1]!;
    const start = fromAnchor(a, prev, carry, i === 0);
    const begin = t(a.asOf);
    const end = b ? t(b.asOf) : Infinity;
    let tmp: Out = new Map();
    let run = runSegment(clone(start), seg, begin, end, opts, tmp);
    if (b && !fits(run.state, b) && run.ambiguous) {
      // 순서를 모르는 몫: 매도 먼저로도 맞춰 본다 (맞으면 그 값 — '순서 추정'은 그대로)
      const tmpB: Out = new Map();
      const runB = runSegment(clone(start), seg, begin, end, opts, tmpB, true);
      if (fits(runB.state, b)) {
        tmp = tmpB;
        run = runB;
      }
    }
    for (const [k, v] of tmp) out.set(k, v);
    for (const f of seg) {
      const x = f.side === "SELL" ? out.get(f.key)?.realized : null;
      if (!x || x.status === "unknown-cost") continue;
      x.basis = "snapshot";
      x.anchorDate = a.date;
    }
    const e = run.state;
    const explained = b ? fits(e, b) : !e.over;
    if (explained) {
      for (const k of run.uncertain) tagUncertain(out, k);
      if (b && b.cost !== null && e.cost !== null && b.quantity > EPS && !costClose(e.cost, b.cost, b.quantity, cur)) check.drift++;
    } else {
      // ① 기록된 체결로 설명되지 않는 구간
      check.unexplained++;
      let text = "";
      if (e.over) text = `기록된 매도가 그때 가진 수량보다 많았어요 · ${b ? `수량 ${fmtQty(a.quantity)} → ${fmtQty(b.quantity)}주` : `${md(a.date)} 기록 ${fmtQty(a.quantity)}주`}`;
      else if (b && Math.abs(e.qty - b.quantity) > EPS) text = `수량 ${fmtQty(a.quantity)} → ${fmtQty(b.quantity)}주 · ${seg.length ? `기록된 매매대로라면 ${fmtQty(e.qty)}주` : "그 사이 기록된 매매 없음"}`;
      else if (b && b.cost === null) text = `토스 잔고에 매입금액이 없어 기록과 맞춰 보지 못했어요 (수량 ${fmtQty(b.quantity)}주)`;
      else if (b) text = `토스 매입금액 ${fmtMoney(b.cost!, cur)} · 기록된 매매대로라면 ${fmtMoney(e.cost!, cur)} (수량 ${fmtQty(b.quantity)}주는 같아요)`;
      const guess = b ? guessOf(a, b, seg) : null;
      events.push({ from: a.date, to: b ? b.date : seg.length ? fillDate(seg.at(-1)!) : a.date, seen: b?.date ?? null, text, guess });
      if (b) changes.push({ at: b.asOf, date: b.date, fromDate: a.date, kind: "unexplained", fromQty: a.quantity, toQty: b.quantity, expectedQty: e.qty, text, guess });
    }
    // ② 주가가 크게 바뀐 구간
    const move = priceMove(a, b, seg);
    if (move) {
      check.priceJumps++;
      events.push({ from: a.date, ...move });
      if (b && explained) changes.push({ at: b.asOf, date: b.date, fromDate: a.date, kind: "possible-action", fromQty: a.quantity, toQty: b.quantity, expectedQty: e.qty, text: move.text, guess: move.guess });
    }
    spans.push({ a, b, seg, orderless: !explained && (e.over || (!!b && Math.abs(e.qty - b.quantity) > EPS)), moved: !!move });
    findZeroSells(seg, a.quantity);
    prev = e;
    carry = explained;
  }

  // ③ 주식배당·무상증자 비율만큼 주가가 내린 구간 — 그 구간이나 뒤 30일 안에 주문 없는 주식 수 변화가 있으면 (②로 이미 적은 구간은 빼고)
  spans.forEach((sp, i) => {
    const p0 = okPrice(sp.a.price);
    const p1 = sp.b && sp.b.quantity > EPS ? okPrice(sp.b.price) : null;
    if (sp.moved || p0 === null || p1 === null) return;
    const guess = bonusRatio(p0 / p1);
    const until = t(sp.b!.asOf) + DOUBT_DAYS * DAY_MS;
    if (guess === null || !spans.slice(i).some((x) => x.orderless && t(x.a.asOf) <= until)) return;
    events.push({ from: sp.a.date, to: sp.b!.date, seen: sp.b!.date, text: `주가 ${fmtMoney(p0, cur, true)} → ${fmtMoney(p1, cur, true)} (${fmtPct(p1 / p0)}) · 그 구간이나 30일 안에 주문 없이 주식 수가 바뀌었어요`, guess });
  });

  // ④ 0주까지 판 뒤 30일 안에 같은 계좌에 다른 종목이 주문 없이 들어옴 (들어온 때가 판 때보다 확실히 앞이면 아님)
  for (const f of zeroSells) {
    const at = t(f.at);
    if (!(opts.arrivals ?? []).some((x) => (x.to === null || t(x.to) >= at) && t(x.from) <= at + DOUBT_DAYS * DAY_MS)) continue;
    const d = fillDate(f);
    events.push({ from: d, to: d, seen: null, text: `${md(d)} 모두 판 뒤 30일 안에 같은 계좌에 다른 종목이 주문 없이 들어왔어요(분사 등일 수 있어요)`, guess: null });
  }

  // ── 확인 필요인 해: 일이 있었을 수 있는 날의 앞뒤 30일이 닿는 해 ──
  const doubt = new Map<number, DoubtEvent[]>();
  for (const e of [...events].sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0)))
    for (let y = yearOf(addDays(e.from, -DOUBT_DAYS)); y <= yearOf(addDays(e.to, DOUBT_DAYS)); y++) doubt.set(y, [...(doubt.get(y) ?? []), e]);
  check.doubtYears = [...doubt.keys()].sort((x, y) => x - y);
  for (const f of fills) {
    const ev = doubt.get(yearOf(fillDate(f)));
    if (ev) exclude(out, f, ev);
  }

  // ── 수익률: 확인 필요인 해에 걸친, 이 종목이 든 기록 구간은 건너뛴다 ──
  const skips: SkipSpan[] = [];
  for (const sp of spans) {
    if (!(sp.a.quantity > EPS || (sp.b?.quantity ?? 0) > EPS || sp.seg.length)) continue;
    const last = sp.b ? sp.b.date : sp.seg.length ? fillDate(sp.seg.at(-1)!) : sp.a.date;
    let bad = false;
    for (let y = yearOf(sp.a.date); y <= yearOf(last); y++) bad ||= doubt.has(y);
    if (!bad) continue;
    const tail = skips.at(-1);
    if (tail && tail.to === sp.a.asOf) tail.to = sp.b?.asOf ?? null;
    else skips.push({ from: sp.a.asOf, to: sp.b?.asOf ?? null });
  }

  return {
    fills: out,
    changes,
    skips,
    check,
    holding: { quantity: prev.qty, avgCost: prev.qty > EPS && prev.cost !== null ? round4(prev.cost / prev.qty) : null },
  };
}

/** 확인 필요인 해의 몫: 매도는 손익 숫자 없이 'unexplained'(까닭 · 그해 있었던 일 · 이름표), 매수는 '이 매수 뒤 평균' 없음 */
function exclude(out: Out, f: LedgerFill, events: DoubtEvent[]): void {
  const res = out.get(f.key);
  if (f.side === "BUY") {
    out.set(f.key, { afterBuy: null });
    return;
  }
  const lines = [...new Set(events.map((e) => (e.seen ? `${md(e.seen)} 기록: ${e.text}` : e.text)))];
  const change = lines.length > 3 ? `${lines.slice(0, 3).join(" / ")} / 그 밖 ${lines.length - 3}가지` : lines.join(" / ");
  const costs = res?.realized?.costs ?? { fee: null, tax: null, total: null, source: null };
  out.set(f.key, {
    realized: { ...blank(costs), status: "unexplained", reason: REASONS.needsCheck, change, guess: events.find((e) => e.guess)?.guess ?? null },
    ...(res?.std ? { std: { proceeds: res.std.proceeds, cost: null, missing: "unexplained" as const } } : {}),
  });
}

function tagUncertain(out: Out, key: string): void {
  const r = out.get(key)?.realized;
  if (!r || r.status !== "ok") return;
  r.status = "order-uncertain";
  r.reason = REASONS.orderUncertain;
}
