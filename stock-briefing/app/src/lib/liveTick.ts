import type { Currency, Evaluation, Quote, RegisteredStock } from "@/api/types";
import { sameTradingDay } from "./marketTime";

/** 서버 /api/stream 이 보내는 체결 1건 */
export interface StreamTick {
  code: string;
  price: number;
  volume: number | null;
  timestamp: string;
  source: string;
}

export type StreamMessage =
  | { type: "snapshot"; ticks: StreamTick[] }
  | { type: "ticks"; ticks: StreamTick[] }
  | ({ type: "tick" } & StreamTick)
  | { type: "ping"; at: number }
  | { type: "holdings"; at: number };

/** 같은 종목 체결이 여러 개면 가장 늦은 것 하나만 (묶음 적용 전에) */
export function latestPerCode(ticks: StreamTick[]): Map<string, StreamTick> {
  const out = new Map<string, StreamTick>();
  for (const t of ticks) {
    const prev = out.get(t.code);
    if (!prev || Date.parse(prev.timestamp) <= Date.parse(t.timestamp)) out.set(t.code, t);
  }
  return out;
}

/**
 * 잔고 목록에 체결 묶음을 한 번에 적용 (3-17). 값이 바뀐 종목만 새 객체, 나머지는 그대로(참조 유지 → 그 줄은 다시 그리지 않음).
 * 바뀐 게 없으면 목록 자체도 그대로 돌려준다. 거래일이 바뀌어 보류한 종목 코드는 held 에 모은다 (시세를 다시 받게)
 */
export function applyTicksToList<T extends { code: string; quote: Quote | null; quantity: number | null; avgPrice: number | null; evaluation?: Evaluation | null }>(list: T[], ticks: Map<string, StreamTick>, held?: Set<string>): T[] {
  let changed = false;
  const next = list.map((s) => {
    const tick = ticks.get(s.code);
    if (!tick) return s;
    if (held && newTradingDay(s.quote, tick)) held.add(s.code);
    const quote = applyTick(s.quote, tick);
    if (quote === s.quote) return s;
    changed = true;
    return { ...s, quote, evaluation: evaluate(s, quote, s.evaluation) };
  });
  return changed ? next : list;
}

/**
 * 체결이 받아 둔 시세보다 새 거래일의 것인지 (PF-01). 한국은 서울 날짜, 미국은 뉴욕 날짜 — 뉴욕 20:00 이후 주간거래는 다음 거래일
 * (애프터마켓 시세의 전일 종가는 그날 정규장 전날 것이라 주간거래 체결에 대면 이틀치 등락이 된다).
 * 이때 전일 종가·고가·저가는 지난 거래일 기준이라 섞지 않고, 새 거래일 시세를 다시 받아야 한다
 */
export function newTradingDay(quote: Quote | null, tick: StreamTick): boolean {
  if (!quote || quote.code !== tick.code) return false;
  const tickAt = Date.parse(tick.timestamp);
  const quoteAt = Date.parse(quote.asOf);
  return !Number.isNaN(tickAt) && !Number.isNaN(quoteAt) && tickAt >= quoteAt && !sameTradingDay(quote.asOf, tick.timestamp, quote.code);
}

/**
 * 체결가를 이미 받아 둔 시세에 덮어쓴다 (서버 StockService.applyLive 와 같은 규칙).
 * 등락은 전일 종가 기준으로 다시 계산하고, 미국 종목은 환율로 원화 환산가도 갱신한다.
 * 시세보다 오래된 체결이거나 값이 같으면 원본을 그대로 돌려준다(참조 유지 → 리렌더 없음).
 * 시세와 거래일이 다른 체결도 그대로 둔다 — 어제 시세의 전일 종가에 오늘 체결을 대면 등락이 이틀치가 된다 (서버 sameTradingDay 와 같다)
 */
export function applyTick(quote: Quote | null, tick: StreamTick): Quote | null {
  if (!quote || quote.code !== tick.code) return quote;
  const tickAt = Date.parse(tick.timestamp);
  const quoteAt = Date.parse(quote.asOf);
  if (Number.isNaN(tickAt) || (!Number.isNaN(quoteAt) && tickAt < quoteAt) || tick.price === quote.price) return quote;
  if (!sameTradingDay(quote.asOf, tick.timestamp, quote.code)) return quote;
  const prevClose = quote.prevClose ?? (quote.change ? quote.price - quote.change : null);
  const change = prevClose !== null ? Math.round((tick.price - prevClose) * 100) / 100 : quote.change;
  const changeRate = prevClose ? Math.round((change / prevClose) * 10000) / 100 : quote.changeRate;
  const fx = quote.fxRate ?? (quote.priceKrw && quote.price ? quote.priceKrw / quote.price : null);
  const priceKrw = fx ? Math.round(tick.price * fx) : (quote.priceKrw ?? null);
  return {
    ...quote,
    price: tick.price,
    change,
    changeRate,
    high: quote.high !== null ? Math.max(quote.high, tick.price) : null,
    low: quote.low !== null ? Math.min(quote.low, tick.price) : null,
    asOf: tick.timestamp,
    priceKrw,
    live: true,
  };
}

/**
 * 서버 evaluate() 와 같은 계산. prev(직전 평가)가 있으면 토스 기준(매입금액·예상 비용 비율)을 이어받아
 * 실시간 가격에서도 토스 앱과 같은 "비용 차감 후" 평가를 유지한다.
 */
export function evaluate(s: Pick<RegisteredStock, "quantity" | "avgPrice">, q: Quote | null, prev?: Evaluation | null): Evaluation | null {
  if (!q || s.quantity === null || s.avgPrice === null || s.quantity <= 0) return null;
  const marketValue = q.price * s.quantity;
  const costBasis = prev?.costBasis ?? s.avgPrice * s.quantity;
  const profit = marketValue - costBasis;
  const pct = (p: number) => (costBasis > 0 ? Math.round((p / costBasis) * 10000) / 100 : 0);
  const costRate = prev?.costRate ?? null;
  const after = costRate !== null && costRate !== undefined ? marketValue * (1 - costRate) : null;
  return {
    marketValue,
    costBasis,
    profit,
    profitRate: pct(profit),
    costRate,
    afterCost: after !== null ? { marketValue: after, profit: after - costBasis, profitRate: pct(after - costBasis) } : null,
    costBasisKrw: prev?.costBasisKrw ?? null,
    krwCostSource: prev?.krwCostSource ?? null,
  };
}

/** 화면에 보여줄 평가 한 벌 (통화 포함) */
export interface EvalView {
  marketValue: number;
  costBasis: number;
  profit: number;
  profitRate: number;
  currency: Currency;
  /** 원화 손익이 추정치인지 (해외 종목 원화 매입금액이 장부 추정값이거나 현재 환율 환산인 경우) */
  estimated: boolean;
  /** 해외 종목 원화 매입금액 기준: 매수 당시 환율(장부) / 현재 환율 환산(장부 없음). 원화 환산이 아니면 null */
  krwBasis: "purchase" | "current" | null;
}

/**
 * 토스 앱과 같은 방식으로 평가를 고른다.
 *  - afterCost: 매도 예상 수수료·세금을 뺀 평가금액 (토스 비용 비율이 있을 때)
 *  - 해외 종목을 원화로 볼 때: 평가금액은 현재 표시 환율로, 매입금액은 매수 당시 환율의 원화 매입금액으로 → 환차손익 포함 손익
 */
export function evalView(
  ev: Evaluation | null | undefined,
  opts: { afterCost: boolean; toKrw: boolean; currency: Currency | undefined; fx: number | null | undefined },
): EvalView | null {
  if (!ev) return null;
  const native = opts.afterCost && ev.afterCost ? ev.afterCost.marketValue : ev.marketValue;
  const cur = opts.currency ?? "KRW";
  if (cur === "USD" && opts.toKrw && opts.fx) {
    const value = native * opts.fx;
    const cost = ev.costBasisKrw ?? ev.costBasis * opts.fx;
    const profit = value - cost;
    return {
      marketValue: value,
      costBasis: cost,
      profit,
      profitRate: cost > 0 ? (profit / cost) * 100 : 0,
      currency: "KRW",
      estimated: ev.costBasisKrw == null || ev.krwCostSource === "estimated",
      krwBasis: ev.costBasisKrw == null ? "current" : "purchase",
    };
  }
  const profit = native - ev.costBasis;
  return { marketValue: native, costBasis: ev.costBasis, profit, profitRate: ev.costBasis > 0 ? (profit / ev.costBasis) * 100 : 0, currency: cur, estimated: false, krwBasis: null };
}

/** 웹소켓 주소: http(s) → ws(s), 토큰은 헤더와 ?token= 둘 다 (React Native 는 헤더를 붙일 수 있지만 프록시가 떼는 경우 대비) */
export function streamUrl(apiUrl: string, apiToken: string): string {
  const base = apiUrl.replace(/\/+$/, "").replace(/^http/i, "ws");
  const q = apiToken ? `?token=${encodeURIComponent(apiToken)}` : "";
  return `${base}/api/stream${q}`;
}
