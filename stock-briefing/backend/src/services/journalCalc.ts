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
 *  - 같은 두 기준점 사이 반대 방향 몫 가운데 체결 시각(filled)이 아닌 것이 있으면 순서를 모른다 → 매수 먼저·매도 먼저로 계산해
 *    값이 1원·1센트 넘게 다르면 매수 먼저 값 + 'order-uncertain' (매수 먼저가 뒤 기록과 맞지 않고 매도 먼저만 맞으면 매도 먼저 값)
 *
 * 보수 규칙 (검토 반영 7차 — 기록된 체결과 토스 기록으로 다 설명하지 못하는 숫자는 넣지 않는다):
 *  - 두 기록 사이 구간은, 앞 기록(토스 수량·매입금액)에서 기록된 체결을 돌려 뒤 기록의 수량(±0.000001주)과 토스 매입금액
 *    (±0.5% — 매도는 이동평균으로 줄인 값)이 나올 때만 '설명됨'. 가진 수량보다 많이 판 매도가 끼거나 뒤 기록에 매입금액이 없으면 설명되지 않음.
 *  - 설명되지 않은 구간(주문 내역에 없는 입고·출고, 분할, 병합, 무상증자, 주식배당, 분사, 늦게 들어온 새 주식, 빠진 체결 — 까닭과 상관없이):
 *    그 구간 매도는 'unexplained'(손익 숫자 없음 — 실현손익·양도세 합계에서 빠지고 '계산에서 뺀 매도'로 따로, 무엇이 달라졌는지 문장과 함께),
 *    그 구간 매수의 '이 매수 뒤 평균'도 없음, 수익률은 그 구간을 건너뛴다(skips). 원가는 뒤 기록(토스 매입금액)에서 다시 출발하므로 그 뒤 매도는 보통 계산.
 *    결제일 원화 취득가(양도세)는 토스가 주지 않아 그 뒤로 모른다('changed' — 전부 판 뒤 새로 산 몫부터는 처음부터 온전한 원장).
 *  - 큰 주가 변화: 한 거래일(그 시장 휴장일 목록으로 셈 — 추석·노동절 다음 날도 한 거래일) 사이 주가가 ±35%(한국 — 하루 가격 제한 30% 밖)·
 *    ±60%(미국) 넘게 바뀌었거나 그날 체결 가격이 앞 기록 주가에서 그만큼 벗어나면,
 *    수량이 설명돼도 분할·무상증자 같은 변화일 수 있다(권리락 날 가격이 먼저 내리고 새 주식은 몇 주 뒤). 그 구간부터 설명되지 않은 수량 변화가 있는
 *    구간까지(90일 안 — 기록이 그 안에서 끝나면 지금까지) 같은 규칙. 90일 안에 수량 변화가 없고 기록이 이어지면 그 구간만.
 *    그 사이 0주가 되면 거기까지 — 0주에서 새로 산 몫은 권리락 뒤에 산 것이라 보통 계산.
 *  - 끝 기록이 0주인 구간은 매입금액을 맞춰 볼 수 없다. 그래서 끝이 0주이고 매도가 있는 구간은 다음 둘 가운데 하나면 설명되지 않음:
 *    ① 같은 계좌·같은 구간에 다른 종목이 주문 없이 새로 들어옴(분사·합병의 흔적 — 들어온 몫의 토스 매입금액이 그 종목 매입금액의 0.5% 이상,
 *       opts.arrivals) ② 0주가 된 뒤 90일 안에 같은 종목이 주문 없이 들어옴(늦게 들어온 새 주식 — 첫 기록이 0주면 그 전 매도도).
 *  - 같은 시각에 체결된 매수·매도는 순서를 모르는 몫으로 본다 (매수 먼저·매도 먼저로 계산 — 저장 순서로 정하지 않음).
 *  - 비율 짐작('1→4 분할로 보여요(추정)')은 이름표로만 — 어떤 숫자에도 쓰지 않는다.
 * 미국 종목은 토스 원화 보기처럼 매수 당시 환율(토스 매수 환율 usdKrwAt)로 원화 매입금액도 이동평균으로 함께 쌓는다(추정).
 * 해외 양도세(journalTax)는 같은 원장을 결제일 기준환율(stdAt)로 한 번 더 쌓는다 — 처음부터 온전한 주문 내역이 있을 때만.
 * 화면 문장(REASONS)은 여기 한 곳에서 만든다 (문구 검사 — 권유 표현 없음)
 */

import { isKrTradingDate, isUsTradingDate, tradingDate } from "./marketContext.js";

export type Cur = "KRW" | "USD";
export type Side = "BUY" | "SELL";
export type TimeBasis = "filled" | "ordered" | "seen";
export type RealizedStatus = "ok" | "unknown-cost" | "order-uncertain" | "unexplained";
export type RealizedBasis = "snapshot" | "history-checked" | "history-only";

/** 화면에 그대로 쓰는 쉬운 문장 (서버 한 곳 — 문구 검사) */
export const REASONS = {
  beforeRecord: "기록 시작 전에 산 몫이라 평균 구매가를 몰라요.",
  oversold: "기록된 수량보다 많이 판 매도라 평균 구매가를 몰라요.",
  noAvg: "토스 잔고에 매입금액이 없어 평균 구매가를 몰라요.",
  orderUncertain: "같은 날 사고판 순서를 몰라 추정했어요.",
  unexplained: "이 기간은 주식 수·매입금액이 기록과 달라 손익을 계산하지 않았어요.",
  possibleAction: "이 기간은 주가가 한 번에 크게 바뀌어(분할·무상증자 같은 변화일 수 있어요) 손익을 계산하지 않았어요.",
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
  /** 그 스냅샷 그 종목 한 주 가격 (정규장 종가, 없으면 그때 현재가 — 종목 통화). 큰 주가 변화를 볼 때만 쓴다. 모르면 null·없음 */
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
  /** 'unexplained' 일 때만: 무엇이 달라졌는지 (화면에 그대로 — '수량 1,000 → 3,995주 · 기록된 매매대로라면 995주') */
  change?: string;
  /** 'unexplained' 일 때만: 비율 짐작 이름표 ('1→4 분할로 보여요(추정)') — 숫자에 쓰지 않음. 없으면 null */
  guess?: string | null;
}

/**
 * 해외 양도세용: 결제일 기준환율로 쌓은 원화 (양도가액·취득가액). missing:
 *  cost = 원가를 모름(기록 전 몫) · fx = 결제일 환율 없음 · changed = 주문 내역으로 설명되지 않은 변화 뒤라 결제일 원화 취득가를 모름 ·
 *  unexplained = 이 매도가 설명되지 않은 구간에 있음 (손익을 계산하지 않음)
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

/** 주문 내역으로 설명되지 않은 구간 (목록의 '기록과 다름' 줄) · 큰 주가 변화 구간 */
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
  /** 설명되지 않은 구간 수 */
  unexplained: number;
  /** 큰 주가 변화 구간 수 */
  priceJumps: number;
}

export interface PairResult {
  fills: Map<string, FillResult>;
  changes: ChangeRow[];
  skips: SkipSpan[];
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
  /**
   * 같은 계좌·같은 시장에서 주문 없이 새로 들어온 다른 종목 (분사·합병의 흔적): 들어온 것을 본 기록의 asOf → 들어온 몫의 토스 매입금액 합
   * (종목 통화, 모르면 null). 그 구간에 이 종목을 모두 판 매도는 매입금액을 맞춰 볼 수 없어 계산하지 않는다
   */
  arrivals?: ReadonlyMap<string, number | null>;
}

const EPS = 1e-6;
/** 설명된 구간으로 볼 토스 매입금액 차이 (±0.5%) */
export const COST_TOL = 0.005;
/** 큰 주가 변화: 한 구간 주가·체결 가격이 앞 기록 주가에서 이만큼 넘게 벗어남 (한국 하루 가격 제한 30% 밖 · 미국) */
export const PRICE_JUMP = { KRW: 0.35, USD: 0.6 } as const;
/** 큰 주가 변화 뒤 새 주식을 기다리는 기간 */
export const JUMP_WINDOW_DAYS = 90;

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
    // 가진 수량보다 많이 판 매도: 값을 지어내지 않는다
    out.set(f.key, {
      realized: { ...blank(costs), status: "unknown-cost", reason: REASONS.oversold },
      ...(opts.stdAt ? { std: { proceeds: std !== null ? f.amount * std : null, cost: null, missing: "cost" as const } } : {}),
    });
    if (s.anchored) {
      // 기준점 뒤: 0 으로 되돌리지 않는다 — 그 구간은 설명되지 않은 구간이 된다 (부른 쪽이 'unexplained' 로 고친다)
      s.over = true;
      s.qty = round6(s.qty - f.quantity);
      Object.assign(s, { cost: null, costWhy: REASONS.oversold, krw: null, krwWhy: REASONS.krwNoBook, std: null, stdWhy: "cost" });
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

/**
 * 앞 날짜 초과 ~ 뒤 날짜 이하의 그 시장 거래일 수 (주말·휴장일 목록 KR_HOLIDAYS·US_HOLIDAYS 를 뺌 — 추석 연휴 다음 날도 1, 2 넘으면 더 세지 않음).
 * 목록에 없는 해는 평일로 센다
 */
function tradingDaysAfter(from: string, to: string, cur: Cur): number {
  const open = cur === "KRW" ? isKrTradingDate : isUsTradingDate;
  let n = 0;
  const end = Date.parse(`${to}T12:00:00Z`);
  for (const d = new Date(`${from}T12:00:00Z`); n < 2; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getTime() > end) break;
    if (open(d.toISOString().slice(0, 10))) n++;
  }
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

/** 구간 하나 (기준점 i → i+1, 마지막은 i → 지금) */
interface Span {
  from: LedgerAnchor;
  /** 뒤 기록 (마지막 구간은 null) */
  to: LedgerAnchor | null;
  seg: LedgerFill[];
  state: "ok" | "unexplained" | "jump";
  /** 무엇이 달라졌는지 · 비율 짐작 (ok 면 빈 값) */
  text: string;
  guess: string | null;
  uncertain: Set<string>;
  expectedQty: number;
}

/**
 * (계좌, 종목) 짝 하나의 원장. fills·anchors 는 순서가 없어도 된다 (시각 순으로 늘어놓음 — 같은 시각이면 몫이 기준점 앞: at ≤ asOf 는 그 스냅샷에 든 체결)
 */
export function replayPair(fillsIn: LedgerFill[], anchorsIn: LedgerAnchor[], opts: LedgerOptions): PairResult {
  const cur = opts.currency;
  const jumpTol = PRICE_JUMP[cur];
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
  const check: PairCheck = { anchors: anchors.length, preAnchor: "none", drift: 0, unexplained: 0, priceJumps: 0 };
  const sellKeys = (seg: LedgerFill[]) => seg.filter((f) => f.side === "SELL").map((f) => f.key);

  // ── 첫 기준점 전 (0주에서) ──
  let s: State = { qty: 0, cost: 0, krw: 0, krwEst: false, krwWhy: null, std: 0, stdWhy: null, neg: false, over: false, anchored: false, costWhy: null, ratio: null };
  const firstEnd = anchors[0] ? t(anchors[0].asOf) : Infinity;
  const pre = runSegment(s, segs[0]!, -Infinity, firstEnd, opts, out);
  s = pre.state;
  const a1 = anchors[0];
  const preOk = (() => {
    if (s.neg) return false;
    if (!a1) return true;
    if (Math.abs(s.qty - a1.quantity) > EPS) return false;
    if (a1.cost === null || s.cost === null) return a1.cost === null; // 스냅샷 매입금액을 모르면 수량만
    return costClose(s.cost, a1.cost, a1.quantity, cur);
  })();
  if (segs[0]!.length) check.preAnchor = !a1 ? (preOk ? "history-only" : "incomplete") : preOk ? "checked" : "mismatch";
  for (const k of sellKeys(segs[0]!)) {
    const res = out.get(k);
    const r = res?.realized;
    if (!r) continue;
    if (preOk && r.status !== "unknown-cost") {
      r.basis = a1 ? "history-checked" : "history-only";
      r.anchorDate = a1?.date ?? null;
    } else {
      // 첫 스냅샷과 맞지 않음(앞부분 주문 내역이 없음): 그 전 매도는 값을 지어내지 않는다
      Object.assign(r, { ...blank(r.costs), status: "unknown-cost", reason: REASONS.beforeRecord });
      if (res.std) res.std = { ...res.std, cost: null, missing: "cost" };
    }
  }
  if (preOk) for (const k of pre.uncertain) tagUncertain(out, k);

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
  const hasSell = (seg: LedgerFill[]) => seg.some((f) => f.side === "SELL");
  /**
   * 같은 계좌·같은 구간(끝 기록 b)에 다른 종목이 주문 없이 들어왔음: 들어온 몫의 토스 매입금액이 이 종목이 그 구간에 가졌던 매입금액
   * (앞 기록 + 구간 매수)의 0.5% 이상이면 (모르면 늘). 0.5% 보다 작으면 분사였어도 매입금액 차이가 설명된 구간의 허용폭 안이다 (토스 이벤트 주식 1주 등)
   */
  const siblingArrived = (a: LedgerAnchor, b: LedgerAnchor, seg: LedgerFill[]): boolean => {
    const arr = opts.arrivals?.get(b.asOf);
    if (arr === undefined) return false;
    if (arr === null || a.cost === null) return true;
    return arr >= (a.cost + seg.reduce((s, f) => s + (f.side === "BUY" ? f.amount : 0), 0)) * COST_TOL;
  };
  /** 체결의 거래일 (한국 종목은 서울 날짜, 미국 종목은 뉴욕 날짜 — marketContext.tradingDate) */
  const fillDate = (f: LedgerFill) => tradingDate(f.at, cur === "KRW");
  /**
   * 큰 주가 변화: 한 거래일 사이 뒤 기록 주가 · 그날 체결 가격이 앞 기록 주가에서 벗어난 폭 (문장·짐작). 휴장일은 세지 않는다 (추석 뒤 첫 거래일도 하루).
   * 기록이 빠져 여러 거래일에 걸친 구간·여러 거래일 뒤 체결은 보지 않는다 (한국 하한가 두 번처럼 실제로 날 수 있는 변화)
   */
  const jumpOf = (a: LedgerAnchor, b: LedgerAnchor | null, seg: LedgerFill[]): { text: string; guess: string | null } | null => {
    const p0 = okPrice(a.price);
    if (p0 === null) return null;
    const off = (r: number) => r > 1 + jumpTol || r < 1 - jumpTol;
    const p1 = b && b.quantity > EPS && tradingDaysAfter(a.date, b.date, cur) <= 1 ? okPrice(b.price) : null;
    if (b && p1 !== null && off(p1 / p0)) {
      const same = Math.abs(b.quantity - a.quantity) <= EPS ? ` · 주식 수 ${fmtQty(a.quantity)}주 그대로` : "";
      return { text: `주가 ${fmtMoney(p0, cur, true)} → ${fmtMoney(p1, cur, true)} (${fmtPct(p1 / p0)})${same}`, guess: ratioLabel(p0 / p1, 0.1, true)?.label ?? null };
    }
    for (const f of seg) {
      if (!(f.quantity > EPS && f.amount > 0)) continue;
      const px = f.amount / f.quantity;
      // 가격이 벗어난 체결만 거래일을 센다 (날짜 계산이 가장 비싼 몫)
      if (off(px / p0) && tradingDaysAfter(a.date, fillDate(f), cur) <= 1) return { text: `${f.side === "SELL" ? "매도" : "매수"} 가격 ${fmtMoney(px, cur, true)} · 직전 기록 주가 ${fmtMoney(p0, cur, true)}보다 ${fmtPct(px / p0)}`, guess: ratioLabel(p0 / px, 0.1, true)?.label ?? null };
    }
    return null;
  };

  // ── 기준점마다: 구간을 기록대로 돌려 뒤 기록과 맞춰 본다 ──
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
    for (const k of sellKeys(seg)) {
      const x = out.get(k)?.realized;
      if (!x || x.status === "unknown-cost") continue;
      x.basis = "snapshot";
      x.anchorDate = a.date;
    }
    const e = run.state;
    // 끝이 0주면 매입금액을 맞춰 볼 수 없다: 같은 구간에 다른 종목이 주문 없이 들어왔으면(분사 등) 설명되지 않음
    const sibling = !!b && fits(e, b) && b.quantity <= EPS && hasSell(seg) && siblingArrived(a, b, seg);
    const explained = b ? fits(e, b) && !sibling : !e.over;
    const span: Span = { from: a, to: b, seg, state: "ok", text: "", guess: null, uncertain: run.uncertain, expectedQty: e.qty };
    if (!explained) {
      span.state = "unexplained";
      span.guess = b ? guessOf(a, b, seg) : null;
      if (e.over) span.text = `기록된 매도가 그때 가진 수량보다 많았어요 · ${b ? `수량 ${fmtQty(a.quantity)} → ${fmtQty(b.quantity)}주` : `${md(a.date)} 기록 ${fmtQty(a.quantity)}주`}`;
      else if (b && Math.abs(e.qty - b.quantity) > EPS)
        span.text = `수량 ${fmtQty(a.quantity)} → ${fmtQty(b.quantity)}주 · ${seg.length ? `기록된 매매대로라면 ${fmtQty(e.qty)}주` : "그 사이 기록된 매매 없음"}`;
      else if (sibling) span.text = `수량 ${fmtQty(a.quantity)} → 0주 · 같은 기간 다른 종목이 주문 없이 들어와(분사 등일 수 있어요) 매입금액을 맞춰 보지 못했어요`;
      else if (b && b.cost === null) span.text = `토스 잔고에 매입금액이 없어 기록과 맞춰 보지 못했어요 (수량 ${fmtQty(b.quantity)}주)`;
      else if (b) span.text = `토스 매입금액 ${fmtMoney(b.cost!, cur)} · 기록된 매매대로라면 ${fmtMoney(e.cost!, cur)} (수량 ${fmtQty(b.quantity)}주는 같아요)`;
    } else {
      const j = jumpOf(a, b, seg);
      if (j) Object.assign(span, { state: "jump", text: j.text, guess: j.guess });
      if (b && b.cost !== null && e.cost !== null && b.quantity > EPS && !costClose(e.cost, b.cost, b.quantity, cur)) check.drift++;
    }
    spans.push(span);
    prev = e;
    carry = explained;
  }

  // ── 큰 주가 변화 뒤 새 주식을 기다리는 창: 설명되지 않은 수량 변화가 있는 구간까지 (90일 안), 기록이 그 안에서 끝나면 지금까지.
  //    그 사이 0주가 되면 거기까지 (0주에서 시작한 구간의 몫은 권리락 뒤에 산 것 — 새 주식은 그 전 몫의 것) ──
  const windowOf = new Map<number, Span>();
  /** 창이 찾은 설명되지 않은 구간 (큰 주가 변화 뒤 늦게 들어온 새 주식 — 아래 '0주 뒤 입고'가 다시 보지 않음) */
  const claimed = new Set<number>();
  const windowMs = JUMP_WINDOW_DAYS * 86_400_000;
  spans.forEach((sp, j) => {
    if (sp.state !== "jump" || !sp.to) return;
    const seen = t(sp.to.asOf);
    let held = j + 1;
    while (held < spans.length && spans[held]!.from.quantity > EPS) held++;
    const put = (upTo: number) => {
      for (let m = j + 1; m < Math.min(upTo, held); m++) if (!windowOf.has(m)) windowOf.set(m, sp);
    };
    for (let k = j + 1; k < spans.length; k++) {
      const x = spans[k]!;
      if (t(x.from.asOf) - seen > windowMs) return;
      if (x.state === "unexplained") {
        claimed.add(k);
        put(k);
        return;
      }
      if (!x.to) put(k + 1);
    }
  });

  // ── 0주에서 같은 종목이 주문 없이 들어옴 (판 뒤 늦게 들어온 새 주식일 수 있음): 그 앞 90일 안에 끝이 0주인 구간(매입금액을 맞춰 보지 못한 구간)의
  //    매도는 계산하지 않는다. 첫 기록이 0주이고 90일 안이면 첫 기록 전 매도도 (첫 기록 전에는 주가가 없어 큰 주가 변화도 볼 수 없다) ──
  let preArrival: string | null = null;
  for (let k = 0; k < spans.length; k++) {
    const x = spans[k]!;
    if (x.state !== "unexplained" || claimed.has(k) || !x.to || x.from.quantity > EPS || !(x.to.quantity > x.expectedQty + EPS)) continue;
    const what = `${md(x.to.date)} 기록에서 주문 없이 ${fmtQty(round6(x.to.quantity - x.expectedQty))}주가 들어왔어요(판 뒤 늦게 들어온 새 주식일 수 있어요)`;
    const since = t(x.from.asOf);
    for (let j = k - 1; j >= 0; j--) {
      const sp = spans[j]!;
      if (since - t(sp.to!.asOf) > windowMs) break;
      if (sp.state === "ok" && !windowOf.has(j) && hasSell(sp.seg) && sp.to!.quantity <= EPS)
        Object.assign(sp, { state: "unexplained", text: `${sp.from.quantity > EPS ? `수량 ${fmtQty(sp.from.quantity)} → 0주` : "0주에서 사고팔아 다시 0주"} · ${what}`, guess: null });
    }
    if (a1 && a1.quantity <= EPS && since - t(a1.asOf) <= windowMs) preArrival ??= `첫 기록(${md(a1.date)}) 0주 · ${what}`;
  }
  if (preArrival && preOk) {
    // 첫 기록까지 0주: 첫 기록 전 매도(0주에서 돌려 첫 기록과 맞춘 것)도 계산하지 않는다 — 첫 기록 전에는 주가가 없어 큰 주가 변화도 볼 수 없다
    for (const f of segs[0]!) {
      const r = out.get(f.key)?.realized;
      if (f.side === "BUY" || (r && r.status !== "unknown-cost")) exclude(out, f, REASONS.unexplained, preArrival, null);
    }
  }

  // ── 마무리: 설명되지 않은 구간·큰 주가 변화 창의 매도는 계산하지 않는다 ──
  const changes: ChangeRow[] = [];
  const skips: SkipSpan[] = [];
  spans.forEach((sp, idx) => {
    const src = sp.state !== "ok" ? sp : windowOf.get(idx);
    if (!src) {
      for (const k of sp.uncertain) tagUncertain(out, k);
      return;
    }
    if (sp.state === "unexplained") check.unexplained++;
    if (sp.state === "jump") check.priceJumps++;
    const reason = src.state === "unexplained" ? REASONS.unexplained : REASONS.possibleAction;
    const change = src === sp || !src.to ? src.text : `${md(src.to.date)} 기록: ${src.text}`;
    for (const f of sp.seg) exclude(out, f, reason, change, src.guess);
    if (sp.to && sp.state !== "ok")
      changes.push({
        at: sp.to.asOf,
        date: sp.to.date,
        fromDate: sp.from.date,
        kind: sp.state === "unexplained" ? "unexplained" : "possible-action",
        fromQty: sp.from.quantity,
        toQty: sp.to.quantity,
        expectedQty: sp.expectedQty,
        text: sp.text,
        guess: sp.guess,
      });
    const last = skips.at(-1);
    if (last && last.to === sp.from.asOf) last.to = sp.to?.asOf ?? null;
    else skips.push({ from: sp.from.asOf, to: sp.to?.asOf ?? null });
  });

  return {
    fills: out,
    changes,
    skips,
    check,
    holding: { quantity: prev.qty, avgCost: prev.qty > EPS && prev.cost !== null ? round4(prev.cost / prev.qty) : null },
  };
}

/** 계산하지 않는 몫: 매도는 손익 숫자 없이 'unexplained'(까닭·바뀐 것·이름표), 매수는 '이 매수 뒤 평균' 없음 */
function exclude(out: Out, f: LedgerFill, reason: string, change: string, guess: string | null): void {
  const res = out.get(f.key);
  if (!res) return;
  if (f.side === "BUY") {
    out.set(f.key, { afterBuy: null });
    return;
  }
  const costs = res.realized?.costs ?? { fee: null, tax: null, total: null, source: null };
  out.set(f.key, {
    realized: { ...blank(costs), status: "unexplained", reason, change, guess },
    ...(res.std ? { std: { proceeds: res.std.proceeds, cost: null, missing: "unexplained" as const } } : {}),
  });
}

function tagUncertain(out: Out, key: string): void {
  const r = out.get(key)?.realized;
  if (!r || r.status !== "ok") return;
  r.status = "order-uncertain";
  r.reason = REASONS.orderUncertain;
}
