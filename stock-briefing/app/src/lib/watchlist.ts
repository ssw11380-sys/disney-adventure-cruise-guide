import { formatNumber, formatPrice } from "./format";

/** 구매희망 가격까지 현재가가 얼마나 변해야 하는지 표시한다. */
export function watchDifference(current: number | null | undefined, desired: number) {
  if (!current || !Number.isFinite(current) || current <= 0 || !Number.isFinite(desired) || desired <= 0) return null;
  return { amount: desired - current, percent: (desired - current) / current * 100, reached: current <= desired };
}
/** 부호 대신 차이의 방향을 쓴다. 비율의 분모는 현재가다. */
export function watchDifferenceLabel(current: number | null | undefined, desired: number, currency: "KRW" | "USD"): string {
  const diff = watchDifference(current, desired);
  if (!diff) return "현재가 확인 후 희망가 차이를 표시합니다";
  if (diff.amount === 0) return "현재가가 구매희망 가격과 같습니다";
  const amount = formatPrice(Math.abs(diff.amount), currency);
  const percent = `${formatNumber(Math.abs(diff.percent), 2)}%`;
  return diff.reached ? `희망가보다 ${amount} 낮음 · 차이 ${percent} (현재가 대비)` : `${amount} (${percent}) 하락하면 희망가 · 현재가 대비`;
}
export function watchPriceInput(raw: string, currency: "KRW" | "USD"): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return currency === "KRW" ? (Number.isInteger(n) && n <= 100_000_000 ? n : null)
    : (Math.round(n * 100) / 100 === n && n <= 1_000_000 ? n : null);
}
