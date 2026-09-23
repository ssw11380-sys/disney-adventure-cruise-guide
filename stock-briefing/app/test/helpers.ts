import type { Evaluation, Quote, RegisteredWithQuote } from "@/api/types";
import { evaluate } from "@/lib/liveTick";

export function quote(code: string, price: number, extra: Partial<Quote> = {}): Quote {
  return {
    code,
    currency: "KRW",
    price,
    change: 0,
    changeRate: 0,
    open: null,
    high: null,
    low: null,
    prevClose: null,
    volume: null,
    marketCap: null,
    per: null,
    pbr: null,
    eps: null,
    bps: null,
    high52w: null,
    low52w: null,
    asOf: "2026-09-23T10:00:00+09:00",
    source: "test",
    ...extra,
  } as Quote;
}

/** 보유 종목 (수량·평단이 있으면 평가까지 채운다) */
export function holding(
  code: string,
  q: Quote | null,
  quantity: number | null,
  avgPrice: number | null,
  ev?: Partial<Evaluation>,
  name = code,
): RegisteredWithQuote {
  const s = { code, name, market: (q?.currency === "USD" ? "NASDAQ" : "KOSPI") as RegisteredWithQuote["market"], quantity, avgPrice, memo: null, createdAt: "", updatedAt: "" };
  const base = evaluate(s, q);
  return { ...s, quote: q, quoteError: null, evaluation: base ? { ...base, ...ev } : null };
}
