import type { Currency, RegisteredWithQuote } from "@/api/types";
import { shownAmount } from "@/lib/format";
import { evalView } from "@/lib/liveTick";

/**
 * 잔고 합계 계산. 홈(잔고) 화면과 홈 화면 위젯이 같은 함수를 쓰도록 순수 함수로 모아 둔다 (RN 의존 없음 → 단위 테스트 가능).
 * 기준은 토스 앱과 같다: 평가금액은 (설정 시) 수수료·세금 차감 후, 해외 종목 원화 손익은 매수 당시 환율의 원화 매입금액 기준.
 */

/** 종목의 원화 환율: 시세에 실린 환율, 없으면 원화 환산가 ÷ 가격 */
export function fxOf(s: RegisteredWithQuote): number | null {
  return s.quote?.fxRate ?? (s.quote?.priceKrw && s.quote.price ? s.quote.priceKrw / s.quote.price : null);
}

/** 통화 하나로 모은 합계 */
export interface Bucket {
  value: number;
  cost: number;
  day: number;
  count: number;
}
export const zeroBucket = (): Bucket => ({ value: 0, cost: 0, day: 0, count: 0 });

/**
 * 합계는 표시 단위(원은 정수, 달러는 센트)로 반올림해 돌려준다 — 1원·1센트 미만 합계가 "0원" 인데 손실·이익 색으로 칠해지지 않게 (BH-38).
 * 손익(평가 − 매입)도 반올림한 두 금액의 차라 화면의 평가·매입금액과 맞는다
 */
const shown = (n: number, cur: Currency) => shownAmount(n, cur) ?? n;
const shownBucket = (b: Bucket, cur: Currency): Bucket => ({ ...b, value: shown(b.value, cur), cost: shown(b.cost, cur), day: shown(b.day, cur) });

export interface HoldingsSummary {
  held: number;
  watch: number;
  /** 통화별 (원래 통화 그대로) */
  byCur: Record<Currency, Bucket>;
  /** 해외 종목만 원화 환산 */
  usdInKrw: Bucket;
  /** 전체 원화 환산. 환율을 모르는 해외 종목이 있으면 null */
  krw: Bucket | null;
  fx: number | null;
  /** 원화 손익 중 추정치가 섞였는지 */
  estimated: boolean;
  /** 원화 매입금액을 현재 환율로 환산한 종목 수 (장부 없음) */
  currentBasis: number;
}

/** 홈(잔고) 화면 상단의 계좌 평가 */
export function summarize(list: RegisteredWithQuote[], afterCost: boolean): HoldingsSummary {
  const held = list.filter((s) => s.evaluation && s.quote);
  const byCur: Record<Currency, Bucket> = { KRW: zeroBucket(), USD: zeroBucket() };
  const usdInKrw = zeroBucket();
  const krw = zeroBucket();
  let convertible = true;
  let estimated = false;
  let currentBasis = 0;
  for (const s of held) {
    const cur = s.quote!.currency ?? "KRW";
    const fx = fxOf(s);
    const day = s.quote!.change * (s.quantity ?? 0);
    const native = evalView(s.evaluation, { afterCost, toKrw: false, currency: cur, fx })!;
    byCur[cur].value += native.marketValue;
    byCur[cur].cost += native.costBasis;
    byCur[cur].day += day;
    byCur[cur].count += 1;
    if (cur === "USD" && !fx) {
      convertible = false;
      continue;
    }
    const k = evalView(s.evaluation, { afterCost, toKrw: true, currency: cur, fx })!;
    if (k.estimated) estimated = true;
    if (k.krwBasis === "current") currentBasis += 1;
    const dayKrw = cur === "USD" ? day * fx! : day;
    krw.value += k.marketValue;
    krw.cost += k.costBasis;
    krw.day += dayKrw;
    krw.count += 1;
    if (cur === "USD") {
      usdInKrw.value += k.marketValue;
      usdInKrw.cost += k.costBasis;
      usdInKrw.day += dayKrw;
      usdInKrw.count += 1;
    }
  }
  const fx = held.map(fxOf).find((x) => x) ?? null;
  return {
    held: held.length,
    byCur: { KRW: shownBucket(byCur.KRW, "KRW"), USD: shownBucket(byCur.USD, "USD") },
    usdInKrw: shownBucket(usdInKrw, "KRW"),
    krw: convertible && held.length ? shownBucket(krw, "KRW") : null,
    fx,
    estimated,
    currentBasis,
    watch: list.length - held.length,
  };
}

export interface Totals {
  value: number;
  day: number;
  profit: number;
  currency: Currency;
  mixed: boolean; // 통화가 섞여 원화 환산이 안 된 경우
}

/**
 * 위젯용 보유 종목 합계 (앱 잔고 화면과 같은 기준).
 * 원화 종목만 있거나 달러 종목만 있고 원화 표시가 꺼져 있으면 그 통화로, 아니면 원화로 합친다.
 */
export function totals(stocks: RegisteredWithQuote[], showKrw: boolean, afterCost = true): Totals | null {
  const held = stocks.filter((s) => s.evaluation && s.quote);
  if (held.length === 0) return null;
  const currencies = new Set(held.map((s) => s.quote!.currency ?? "KRW"));
  const native = currencies.size === 1 && (currencies.has("KRW") || !showKrw);
  let value = 0, day = 0, cost = 0, mixed = false;
  for (const s of held) {
    const cur = s.quote!.currency ?? "KRW";
    const fx = fxOf(s);
    const v = evalView(s.evaluation, { afterCost, toKrw: !native, currency: cur, fx });
    if (!v || (!native && cur === "USD" && !fx)) {
      mixed = true;
      continue;
    }
    value += v.marketValue;
    cost += v.costBasis;
    day += s.quote!.change * (s.quantity ?? 0) * (!native && cur === "USD" ? fx! : 1);
  }
  const currency: Currency = native ? ((currencies.values().next().value as Currency) ?? "KRW") : "KRW";
  // 잔고 화면(summarize)과 같게: 표시 단위로 반올림, 손익 = 반올림한 평가금액 − 반올림한 매입금액 (BH-38)
  const shownValue = shown(value, currency);
  return { value: shownValue, day: shown(day, currency), profit: shownValue - shown(cost, currency) || 0, currency, mixed };
}
