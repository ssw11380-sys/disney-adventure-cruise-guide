import type { Evaluation, Quote, RegisteredStock } from "@/api/types";

/** 서버 /api/stream 이 보내는 체결 1건 */
export interface StreamTick {
  code: string;
  price: number;
  volume: number | null;
  timestamp: string;
  source: string;
}

export type StreamMessage = { type: "snapshot"; ticks: StreamTick[] } | ({ type: "tick" } & StreamTick) | { type: "ping"; at: number };

/**
 * 체결가를 이미 받아 둔 시세에 덮어쓴다 (서버 StockService.applyLive 와 같은 규칙).
 * 등락은 전일 종가 기준으로 다시 계산하고, 미국 종목은 환율로 원화 환산가도 갱신한다.
 * 시세보다 오래된 체결이거나 값이 같으면 원본을 그대로 돌려준다(참조 유지 → 리렌더 없음).
 */
export function applyTick(quote: Quote | null, tick: StreamTick): Quote | null {
  if (!quote || quote.code !== tick.code) return quote;
  const tickAt = Date.parse(tick.timestamp);
  const quoteAt = Date.parse(quote.asOf);
  if (Number.isNaN(tickAt) || (!Number.isNaN(quoteAt) && tickAt < quoteAt) || tick.price === quote.price) return quote;
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

/** 서버 evaluate() 와 같은 계산 */
export function evaluate(s: Pick<RegisteredStock, "quantity" | "avgPrice">, q: Quote | null): Evaluation | null {
  if (!q || s.quantity === null || s.avgPrice === null || s.quantity <= 0) return null;
  const marketValue = q.price * s.quantity;
  const costBasis = s.avgPrice * s.quantity;
  const profit = marketValue - costBasis;
  return { marketValue, costBasis, profit, profitRate: costBasis > 0 ? Math.round((profit / costBasis) * 10000) / 100 : 0 };
}

/** 웹소켓 주소: http(s) → ws(s), 토큰은 헤더와 ?token= 둘 다 (React Native 는 헤더를 붙일 수 있지만 프록시가 떼는 경우 대비) */
export function streamUrl(apiUrl: string, apiToken: string): string {
  const base = apiUrl.replace(/\/+$/, "").replace(/^http/i, "ws");
  const q = apiToken ? `?token=${encodeURIComponent(apiToken)}` : "";
  return `${base}/api/stream${q}`;
}
