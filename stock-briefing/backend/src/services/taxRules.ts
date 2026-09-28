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
 *    한국 은행 영업일은 주말·KR_HOLIDAYS 를 빼되, 12/31 '연말'은 거래소만 쉬는 날이라 영업일로 본다. 휴장일 목록이 없는 해(2026 전)는 하루 틀릴 수 있다
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

/** 한국 은행 영업일 (주말·공휴일 아님. 12/31 '연말'은 거래소만 쉬어 영업일) */
export function isKrBankDay(date: string): boolean {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return false;
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
  excluded: null | "cost" | "fx";
  /** 결제일 환율을 받는 중 (배경 작업이 곧 받는다) */
  pending: boolean;
  /** 평균 구매가를 추정한 매도 (분할·이관 전후 'estimated' · 순서 모름 'order-uncertain') — 합계에 넣고 '추정 포함'으로 따로 센다 */
  estimate?: { status: "estimated" | "order-uncertain"; reason: string } | null;
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
  /** 평균 구매가를 추정한 매도일 때만 */
  estimate?: { status: "estimated" | "order-uncertain"; reason: string };
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

/**
 * 그해(결제일 기준) 합계 · 매도별 계산 · 빠진 매도 · 추정이 들어간 매도(합계에 들어 있음 — 건수와 종목·까닭). 매도마다 원 단위로 먼저 반올림한 값의 합이 합계
 */
export function taxSummary(
  year: number,
  items: TaxSellInput[],
): {
  totals: TaxTotals;
  items: TaxItemView[];
  excluded: Array<{ code: string; name: string; count: number; reason: string }>;
  complete: boolean;
  fxPending: number;
  estimatedIncluded: number;
  estimatedSells: Array<{ code: string; name: string; count: number; reason: string }>;
} {
  const mine = items.filter((x) => Number(x.settleDate.slice(0, 4)) === year);
  const views: TaxItemView[] = [];
  const out = new Map<string, { code: string; name: string; count: number; reason: string }>();
  const est = new Map<string, { code: string; name: string; count: number; reason: string }>();
  let pending = 0;
  for (const x of mine) {
    if (!x.gainParts) {
      if (x.pending) {
        pending++;
        continue;
      }
      const reason = TAX_EXCLUDE_REASON[x.excluded ?? "cost"];
      const k = `${x.code}|${reason}`;
      const e = out.get(k) ?? { code: x.code, name: x.name, count: 0, reason };
      e.count++;
      out.set(k, e);
      continue;
    }
    const proceedsKrw = Math.round(x.gainParts.proceeds);
    const costKrw = Math.round(x.gainParts.cost);
    const costsKrw = x.gainParts.costs === null ? null : Math.round(x.gainParts.costs);
    const { gainParts: _g, excluded: _e, pending: _p, estimate, ...rest } = x;
    views.push({ ...rest, proceedsKrw, costKrw, costsKrw, gainKrw: proceedsKrw - costKrw - (costsKrw ?? 0), ...(estimate ? { estimate } : {}) });
    if (estimate) {
      const k = `${x.code}|${estimate.reason}`;
      const e = est.get(k) ?? { code: x.code, name: x.name, count: 0, reason: estimate.reason };
      e.count++;
      est.set(k, e);
    }
  }
  const gains = views.reduce((s, v) => s + (v.gainKrw > 0 ? v.gainKrw : 0), 0);
  const losses = views.reduce((s, v) => s + (v.gainKrw < 0 ? v.gainKrw : 0), 0);
  const net = gains + losses;
  return {
    totals: { gains, losses: losses === 0 ? 0 : losses, net, ...taxFor(net), sells: views.length },
    items: views,
    // 건수 많은 순 (같으면 종목 코드 순)
    excluded: [...out.values()].sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    complete: out.size === 0 && pending === 0,
    fxPending: pending,
    estimatedIncluded: views.filter((v) => v.estimate).length,
    estimatedSells: [...est.values()].sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
  };
}
