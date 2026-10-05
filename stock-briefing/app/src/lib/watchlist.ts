/** 구매희망 가격까지 현재가가 얼마나 변해야 하는지 표시한다. */
export function watchDifference(current: number | null | undefined, desired: number) {
  if (!current || !Number.isFinite(current) || current <= 0 || !Number.isFinite(desired) || desired <= 0) return null;
  return { amount: desired - current, percent: (desired - current) / current * 100, reached: current <= desired };
}
export function watchPriceInput(raw: string, currency: "KRW" | "USD"): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return currency === "KRW" ? (Number.isInteger(n) && n <= 100_000_000 ? n : null)
    : (Math.round(n * 100) / 100 === n && n <= 1_000_000 ? n : null);
}
