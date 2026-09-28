import { isUsTradingDate, KR_HOLIDAYS } from "./marketContext.js";
import { addDays } from "./tradeRecordCalc.js";

/**
 * 해외주식 양도세 추정 규칙 (3-37, 참고용 — 세무 조언이 아님). 세율·공제는 2026년 세법 기준으로 넣은 값이고 여기 한 곳에만 둔다.
 *  - 매도마다 양도차익(원) = 양도가액(판매 달러 × 매도 결제일 기준환율) − 취득가액(이동평균 원화 매입금액 중 팔린 몫 — 매수마다 달러 × 매수 결제일 기준환율)
 *    − 비용(토스 수수료·세금 × 매도 결제일 기준환율, 토스 값이 있을 때만). 매도마다 원 단위로 먼저 반올림한다
 *  - 한 해 = 결제일이 그해 1/1~12/31 인 매도. 이익과 손실을 더한 뒤(손익통산) 기본공제 250만 원을 빼고 20%(원 단위 끝수 10원 미만 버림),
 *    지방소득세는 그 세액의 10%(10원 미만 버림). 합이 약 22%
 *  - 결제일(추정): 토스증권 미국주식은 현지 T+1 · 국내 T+2 (2024-05-28 매매분부터) → '미국 거래일 다음 미국 결제일' 다음의 한국 은행 영업일.
 *    미국 결제일은 거래소 휴장일과 은행 휴일(콜럼버스 데이·재향군인의 날 — 거래소는 열지만 결제가 없음)을 뺀다.
 *    한국 은행 영업일은 주말·KR_HOLIDAYS(2026~)·KR_BANK_HOLIDAYS_PAST(2022~2025)를 빼되, 12/31 '연말'은 거래소만 쉬는 날이라 영업일로 본다
 */

export const TAX_RULES = {
  rate: 0.22,
  nationalRate: 0.2,
  localRateOfNational: 0.1,
  deduction: 2_500_000,
  method: "moving-average",
  lawYear: 2026,
} as const;

/** 미국 은행 휴일 가운데 거래소는 여는 날 (그날은 결제가 없다) — 해마다 추가 */
export const US_SETTLEMENT_EXTRA_HOLIDAYS: ReadonlySet<string> = new Set(["2026-10-12", "2026-11-11", "2027-10-11", "2027-11-11"]);

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export function isUsSettlementDay(date: string): boolean {
  return isUsTradingDate(date) && !US_SETTLEMENT_EXTRA_HOLIDAYS.has(date);
}

/**
 * 2026 전 한국 평일 공휴일 (은행·외환시장이 쉬는 날 — 서울 날짜). KR_HOLIDAYS(거래소 휴장일, 앱과 같은 목록)는 2026 부터라 그 전 해는 여기 둔다.
 * 거래소만 쉬는 연말 휴장(2022-12-30 · 2023-12-29 · 2024-12-31 · 2025-12-31)은 은행 영업일이라 넣지 않는다.
 * 이 목록이 없으면 추석·설 연휴(평일 4~5일)가 '고시가 빠진 은행 영업일'로 세어져 그 사이 결제일이 받아 본 기간이 되지 못하고
 * 직전 고시도 쓰지 못해 양도세 추정에서 빠졌다 (결제일도 휴일 위에 잡혔다)
 */
export const KR_BANK_HOLIDAYS_PAST: ReadonlySet<string> = new Set([
  // 2022
  "2022-01-31", "2022-02-01", "2022-02-02", "2022-03-01", "2022-03-09", "2022-05-05", "2022-06-01", "2022-06-06", "2022-08-15",
  "2022-09-09", "2022-09-12", "2022-10-03", "2022-10-10",
  // 2023
  "2023-01-23", "2023-01-24", "2023-03-01", "2023-05-01", "2023-05-05", "2023-05-29", "2023-06-06", "2023-08-15",
  "2023-09-28", "2023-09-29", "2023-10-02", "2023-10-03", "2023-10-09", "2023-12-25",
  // 2024
  "2024-01-01", "2024-02-09", "2024-02-12", "2024-03-01", "2024-04-10", "2024-05-01", "2024-05-06", "2024-05-15", "2024-06-06",
  "2024-08-15", "2024-09-16", "2024-09-17", "2024-09-18", "2024-10-01", "2024-10-03", "2024-10-09", "2024-12-25",
  // 2025
  "2025-01-01", "2025-01-27", "2025-01-28", "2025-01-29", "2025-01-30", "2025-03-03", "2025-05-01", "2025-05-05", "2025-05-06",
  "2025-06-03", "2025-06-06", "2025-08-15", "2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09", "2025-12-25",
]);

/** 한국 은행 영업일 (주말·공휴일 아님. 12/31 '연말'은 거래소만 쉬어 영업일) */
export function isKrBankDay(date: string): boolean {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return false;
  if (KR_BANK_HOLIDAYS_PAST.has(date)) return false;
  return !(date in KR_HOLIDAYS) || date.slice(5) === "12-31";
}

/** 미국 거래일(뉴욕 날짜) → 현지 결제일과 국내 결제일 (추정) */
export function usSettleDate(tradeDate: string): { us: string; kr: string } {
  let us = addDays(tradeDate, 1);
  for (let i = 0; i < 10 && !isUsSettlementDay(us); i++) us = addDays(us, 1);
  let kr = addDays(us, 1);
  for (let i = 0; i < 15 && !isKrBankDay(kr); i++) kr = addDays(kr, 1);
  return { us, kr };
}

/** 원 단위 끝수: 10원 미만 버림 (국고금 끝수 규칙) */
export function floor10(n: number): number {
  return n > 0 ? Math.floor(n / 10) * 10 : 0;
}

export function taxFor(net: number): { base: number; nationalTax: number; localTax: number; tax: number } {
  const base = Math.max(0, Math.round(net) - TAX_RULES.deduction);
  const nationalTax = floor10(base * TAX_RULES.nationalRate);
  const localTax = floor10(nationalTax * TAX_RULES.localRateOfNational);
  return { base, nationalTax, localTax, tax: nationalTax + localTax };
}

/** 계산에서 뺀 까닭 (화면에 그대로) */
export const TAX_EXCLUDE_REASON = {
  cost: "기록 시작 전에 산 몫이라 취득가를 몰라요",
  fx: "결제일 환율을 받지 못했어요",
  changed: "주문 내역에 없는 주식 수·매입금액 변화 뒤라 결제일 환율로 잰 취득가를 몰라요",
  unexplained: "그해 이 종목에 주문 내역으로 설명되지 않는 변화가 있어 확인이 필요한 매도라 계산하지 않았어요",
  uncertain: "같은 날 사고판 순서를 몰라 취득가가 확실하지 않아 합계에서 뺐어요",
} as const;

export interface TaxFx {
  rate: number;
  /** smbs = 서울외국환중개 매매기준율 · naver-hana = 하나은행 고시(네이버)로 대신 */
  source: string;
  /** 실제로 쓴 고시일 (결제일에 고시가 없으면 직전 고시일) */
  date: string;
  /** 결제일이 아직 오지 않아 최근 고시 값으로 잠정 계산 */
  provisional: boolean;
}

/** 매도 한 건 (결제일 기준 원화) */
export interface TaxSellInput {
  key: string;
  code: string;
  name: string;
  tradeDate: string;
  settleDate: string;
  settleSource: "toss" | "estimated";
  quantity: number;
  proceedsUsd: number;
  costsUsd: number | null;
  fxSell: TaxFx | null;
  /** 결제일 원화: 양도가액·취득가액(원 단위 전)·비용 원화. 계산할 수 없으면 null (excluded 에 까닭) */
  gainParts: { proceeds: number; cost: number; costs: number | null } | null;
  /**
   * 계산할 수 없는 까닭: cost = 기록 전 몫 · fx = 결제일 환율 없음 · changed = 주문 내역으로 설명되지 않은 변화 뒤라 결제일 원화 취득가를 모름 ·
   * unexplained = 확인이 필요한 매도 (그해 그 종목에 기록으로 설명되지 않는 일이 있음 — unexplained 에 까닭·그해 있었던 일·이름표)
   */
  excluded: null | "cost" | "fx" | "changed" | "unexplained";
  /** 결제일 환율을 받는 중 (배경 작업이 곧 받는다) */
  pending: boolean;
  /** 같은 날 사고판 순서를 몰라 추정한 매도 — 기본으로 합계에서 빼고 까닭과 매도별 계산을 따로 준다 (가짜 손익이 세액을 몰래 바꾸지 않게) */
  estimate?: { status: "order-uncertain"; reason: string } | null;
  /** excluded 'unexplained' 일 때: 까닭 · 그해 무엇이 있었는지 · 비율 짐작 이름표(숫자에 쓰지 않음) */
  unexplained?: { reason: string; change: string | null; guess: string | null } | null;
}

/** 합계에서 뺀, 확인이 필요한 매도 (숫자 없음 — 토스증권 앱에서 확인) */
export interface TaxUnexplainedSell {
  key: string;
  code: string;
  name: string;
  tradeDate: string;
  settleDate: string;
  quantity: number;
  proceedsUsd: number;
  reason: string;
  change: string | null;
  guess: string | null;
}

export interface TaxItemView {
  key: string;
  code: string;
  name: string;
  tradeDate: string;
  settleDate: string;
  settleSource: "toss" | "estimated";
  quantity: number;
  proceedsUsd: number;
  costsUsd: number | null;
  fxSell: TaxFx | null;
  proceedsKrw: number;
  costKrw: number;
  costsKrw: number | null;
  gainKrw: number;
  /** 같은 날 사고판 순서를 몰라 추정한 매도일 때만 */
  estimate?: { status: "order-uncertain"; reason: string };
}

export interface TaxTotals {
  gains: number;
  losses: number;
  net: number;
  base: number;
  nationalTax: number;
  localTax: number;
  tax: number;
  sells: number;
}

/** 순서 모름 매도를 합계에 넣을지 (기본: 넣지 않음) */
export interface TaxSummaryOptions {
  includeUncertain?: boolean;
}

/**
 * 그해(결제일 기준) 합계 · 매도별 계산 · 빠진 매도(종목·건수·까닭). 매도마다 원 단위로 먼저 반올림한 값의 합이 합계.
 *  - 확인이 필요한 매도(unexplained — 그해 그 종목에 기록으로 설명되지 않는 일이 있음)는 늘 합계에서 빼고 숫자 없이 따로 준다 (unexplainedSells — 까닭·그해 있었던 일·이름표)
 *  - 같은 날 사고판 순서를 모르는 매도(order-uncertain)는 기본으로 합계에서 빼고 건수·추정 양도차익 합·매도별 계산(uncertainItems)을 따로 준다.
 *    includeUncertain 이면 합계에 넣고 '추정 포함'으로 센다 (estimatedIncluded · estimatedSells)
 */
export function taxSummary(
  year: number,
  items: TaxSellInput[],
  opts: TaxSummaryOptions = {},
): {
  totals: TaxTotals;
  items: TaxItemView[];
  excluded: Array<{ code: string; name: string; count: number; reason: string }>;
  complete: boolean;
  fxPending: number;
  estimatedIncluded: number;
  estimatedSells: Array<{ code: string; name: string; count: number; reason: string }>;
  includeUncertain: boolean;
  /** 합계에서 뺀 순서 모름 매도 수 · 그 추정 양도차익 합(참고, 없으면 null) · 매도별 계산 */
  uncertainExcluded: number;
  uncertainGainKrw: number | null;
  uncertainItems: TaxItemView[];
  unexplainedSells: TaxUnexplainedSell[];
} {
  const includeUncertain = opts.includeUncertain === true;
  const mine = items.filter((x) => Number(x.settleDate.slice(0, 4)) === year);
  const views: TaxItemView[] = [];
  const uncertain: TaxItemView[] = [];
  const unexplained: TaxUnexplainedSell[] = [];
  const out = new Map<string, { code: string; name: string; count: number; reason: string }>();
  const est = new Map<string, { code: string; name: string; count: number; reason: string }>();
  const count = (m: typeof out, code: string, name: string, reason: string) => {
    const k = `${code}|${reason}`;
    const e = m.get(k) ?? { code, name, count: 0, reason };
    e.count++;
    m.set(k, e);
  };
  let pending = 0;
  for (const x of mine) {
    if (x.excluded === "unexplained") {
      // 확인이 필요한 매도: 받는 중인 환율과 상관없이 늘 빠진 매도 (숫자 없음)
      count(out, x.code, x.name, TAX_EXCLUDE_REASON.unexplained);
      const w = x.unexplained;
      unexplained.push({ key: x.key, code: x.code, name: x.name, tradeDate: x.tradeDate, settleDate: x.settleDate, quantity: x.quantity, proceedsUsd: x.proceedsUsd, reason: w?.reason ?? TAX_EXCLUDE_REASON.unexplained, change: w?.change ?? null, guess: w?.guess ?? null });
      continue;
    }
    if (!x.gainParts) {
      if (x.pending) {
        pending++;
        continue;
      }
      count(out, x.code, x.name, TAX_EXCLUDE_REASON[x.excluded ?? "cost"]);
      continue;
    }
    const proceedsKrw = Math.round(x.gainParts.proceeds);
    const costKrw = Math.round(x.gainParts.cost);
    const costsKrw = x.gainParts.costs === null ? null : Math.round(x.gainParts.costs);
    const { gainParts: _g, excluded: _e, pending: _p, estimate, unexplained: _u, ...rest } = x;
    const view: TaxItemView = { ...rest, proceedsKrw, costKrw, costsKrw, gainKrw: proceedsKrw - costKrw - (costsKrw ?? 0), ...(estimate ? { estimate } : {}) };
    if (estimate?.status === "order-uncertain" && !includeUncertain) {
      uncertain.push(view);
      count(out, x.code, x.name, TAX_EXCLUDE_REASON.uncertain);
      continue;
    }
    views.push(view);
    if (estimate) count(est, x.code, x.name, estimate.reason);
  }
  const gains = views.reduce((s, v) => s + (v.gainKrw > 0 ? v.gainKrw : 0), 0);
  const losses = views.reduce((s, v) => s + (v.gainKrw < 0 ? v.gainKrw : 0), 0);
  const net = gains + losses;
  // 건수 많은 순 (같으면 종목 코드 순)
  const byCount = (a: { count: number; code: string }, b: { count: number; code: string }) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return {
    totals: { gains, losses: losses === 0 ? 0 : losses, net, ...taxFor(net), sells: views.length },
    items: views,
    excluded: [...out.values()].sort(byCount),
    complete: out.size === 0 && pending === 0,
    fxPending: pending,
    estimatedIncluded: views.filter((v) => v.estimate).length,
    estimatedSells: [...est.values()].sort(byCount),
    includeUncertain,
    uncertainExcluded: uncertain.length,
    uncertainGainKrw: uncertain.length ? uncertain.reduce((s, v) => s + v.gainKrw, 0) : null,
    uncertainItems: uncertain,
    unexplainedSells: unexplained,
  };
}
