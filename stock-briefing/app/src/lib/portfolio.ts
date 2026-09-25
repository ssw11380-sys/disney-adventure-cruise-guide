import type { Currency, RegisteredWithQuote } from "@/api/types";
import { shownAmount } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import type { SortKey } from "@/lib/settings";

/**
 * 잔고 합계 계산. 홈(잔고) 화면과 홈 화면 위젯이 같은 함수를 쓰도록 순수 함수로 모아 둔다 (RN 의존 없음 → 단위 테스트 가능).
 * 기준은 토스 앱과 같다: 평가금액은 (설정 시) 수수료·세금 차감 후, 해외 종목 원화 손익은 매수 당시 환율의 원화 매입금액 기준.
 */

/** 종목의 원화 환율: 시세에 실린 환율, 없으면 원화 환산가 ÷ 가격 */
export function fxOf(s: RegisteredWithQuote): number | null {
  return s.quote?.fxRate ?? (s.quote?.priceKrw && s.quote.price ? s.quote.priceKrw / s.quote.price : null);
}

/**
 * 목록 전체에서 쓸 달러 환율 (BH-04): 어느 달러 시세(관심 종목 포함)에든 실린 환율, 없으면 달러 시세의 원화 환산가 ÷ 가격.
 * 달러 환율은 종목마다 같다 → 환율이 빠진 달러 시세(서버 보강이 시간 초과로 끝난 시세 등)를 합계에서 빼지 않고 이 값으로 환산한다
 */
export function sharedFx(list: RegisteredWithQuote[]): number | null {
  const usd = list.filter((s) => s.quote?.currency === "USD");
  return usd.find((s) => s.quote!.fxRate)?.quote!.fxRate ?? usd.map(fxOf).find((x) => x) ?? null;
}

/** 원화 환산에 쓸 환율: 그 종목 시세의 환율, 없으면(달러 종목) 목록 공용 환율 */
const fxWith = (s: RegisteredWithQuote, shared: number | null): number | null => fxOf(s) ?? (s.quote?.currency === "USD" ? shared : null);

/**
 * 보유 종목: 수량이 있거나 평가가 있다 (발견 탭 useMarks 와 같은 기준).
 * 평단이 없거나 첫 시세를 아직 못 받아 평가가 없어도 관심으로 내리지 않는다 — 합계에서 뺀 수는 따로 알린다 (BH-26 · BH-30)
 */
export function isHolding(s: Pick<RegisteredWithQuote, "quantity" | "evaluation">): boolean {
  return (s.quantity ?? 0) > 0 || !!s.evaluation;
}

/** 잔고 표 구역: 보유(수량 있음) / 관심 — 순서는 그대로 */
export function splitHoldings<T extends RegisteredWithQuote>(list: T[]): { held: T[]; watch: T[] } {
  return { held: list.filter(isHolding), watch: list.filter((s) => !isHolding(s)) };
}

/** 합계에서 뺀 보유 종목 수: 시세 없음 · 평가 없음(평단 없음) · 환율 없음 */
export interface Excluded {
  noQuote: number;
  noEval: number;
  noFx: number;
}
export const noExcluded = (): Excluded => ({ noQuote: 0, noEval: 0, noFx: 0 });

/** 합계 제외 안내: "시세 없음 1종목 · 평단 없음 1종목 · 환율 없음 1종목 제외". 뺀 종목이 없으면 null */
export function excludedLabel(ex: Excluded): string | null {
  const parts = [ex.noQuote ? `시세 없음 ${ex.noQuote}종목` : null, ex.noEval ? `평단 없음 ${ex.noEval}종목` : null, ex.noFx ? `환율 없음 ${ex.noFx}종목` : null].filter(
    (p): p is string => !!p,
  );
  return parts.length ? `${parts.join(" · ")} 제외` : null;
}

/** 보유 종목 중 합계에 넣을 수 있는 것(시세·평가가 모두 있음)만 고르고, 뺀 것은 이유별로 센다 */
function countable(list: RegisteredWithQuote[], excluded: Excluded): RegisteredWithQuote[] {
  const out: RegisteredWithQuote[] = [];
  for (const s of list) {
    if (!isHolding(s)) continue;
    if (!s.quote) excluded.noQuote += 1;
    else if (!s.evaluation) excluded.noEval += 1;
    else out.push(s);
  }
  return out;
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
  /** 보유 종목 수 (평단·시세가 없어 합계에서 뺀 종목 포함) */
  held: number;
  watch: number;
  /** 통화별 (원래 통화 그대로) */
  byCur: Record<Currency, Bucket>;
  /** 해외 종목만 원화 환산 */
  usdInKrw: Bucket;
  /** 전체 원화 환산. 환율을 끝내 모르는 해외 종목이 있으면 null */
  krw: Bucket | null;
  fx: number | null;
  /** 원화 손익 중 추정치가 섞였는지 */
  estimated: boolean;
  /** 원화 매입금액을 현재 환율로 환산한 종목 수 (장부 없음) */
  currentBasis: number;
  /** 합계(원화)에서 뺀 보유 종목 수 — 계좌 패널이 excludedLabel 로 알린다 */
  excluded: Excluded;
}

/** 홈(잔고) 화면 상단의 계좌 평가 */
export function summarize(list: RegisteredWithQuote[], afterCost: boolean): HoldingsSummary {
  const owned = list.filter(isHolding).length;
  const excluded = noExcluded();
  const held = countable(list, excluded);
  const shared = sharedFx(list);
  const byCur: Record<Currency, Bucket> = { KRW: zeroBucket(), USD: zeroBucket() };
  const usdInKrw = zeroBucket();
  const krw = zeroBucket();
  let convertible = true;
  let estimated = false;
  let currentBasis = 0;
  for (const s of held) {
    const cur = s.quote!.currency ?? "KRW";
    const fx = fxWith(s, shared);
    const day = s.quote!.change * (s.quantity ?? 0);
    const native = evalView(s.evaluation, { afterCost, toKrw: false, currency: cur, fx })!;
    byCur[cur].value += native.marketValue;
    byCur[cur].cost += native.costBasis;
    byCur[cur].day += day;
    byCur[cur].count += 1;
    if (cur === "USD" && !fx) {
      convertible = false;
      excluded.noFx += 1;
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
  const fx = held.map(fxOf).find((x) => x) ?? (held.some((s) => s.quote!.currency === "USD") ? shared : null);
  return {
    held: owned,
    byCur: { KRW: shownBucket(byCur.KRW, "KRW"), USD: shownBucket(byCur.USD, "USD") },
    usdInKrw: shownBucket(usdInKrw, "KRW"),
    krw: convertible && owned ? shownBucket(krw, "KRW") : null,
    fx,
    estimated,
    currentBasis,
    watch: list.length - owned,
    excluded,
  };
}

export interface Totals {
  value: number;
  day: number;
  profit: number;
  currency: Currency;
  mixed: boolean; // 통화가 섞여 원화 환산이 안 된 경우
  /** 합계에서 뺀 보유 종목 수 (시세·평단·환율 없음). 위젯 합계 옆 안내는 excludedLabel 로 */
  excluded: Excluded;
}

/**
 * 위젯용 보유 종목 합계 (앱 잔고 화면과 같은 기준).
 * 원화 종목만 있거나 달러 종목만 있고 원화 표시가 꺼져 있으면 그 통화로, 아니면 원화로 합친다.
 * 달러 종목만 있는데 환율을 끝내 모르면 0원 대신 달러 그대로 (BH-04)
 */
export function totals(stocks: RegisteredWithQuote[], showKrw: boolean, afterCost = true): Totals | null {
  const excluded = noExcluded();
  const held = countable(stocks, excluded);
  if (held.length === 0) return null;
  const shared = sharedFx(stocks);
  const currencies = new Set(held.map((s) => s.quote!.currency ?? "KRW"));
  const native = currencies.size === 1 && (currencies.has("KRW") || !showKrw || shared === null);
  let value = 0, day = 0, cost = 0, mixed = false;
  for (const s of held) {
    const cur = s.quote!.currency ?? "KRW";
    const fx = fxWith(s, shared);
    if (!native && cur === "USD" && !fx) {
      mixed = true;
      excluded.noFx += 1;
      continue;
    }
    const v = evalView(s.evaluation, { afterCost, toKrw: !native, currency: cur, fx })!;
    value += v.marketValue;
    cost += v.costBasis;
    day += s.quote!.change * (s.quantity ?? 0) * (!native && cur === "USD" ? fx! : 1);
  }
  const currency: Currency = native ? ((currencies.values().next().value as Currency) ?? "KRW") : "KRW";
  // 잔고 화면(summarize)과 같게: 표시 단위로 반올림, 손익 = 반올림한 평가금액 − 반올림한 매입금액 (BH-38)
  const shownValue = shown(value, currency);
  return { value: shownValue, day: shown(day, currency), profit: shownValue - shown(cost, currency) || 0, currency, mixed, excluded };
}

/**
 * 잔고 표 정렬 (홈 화면, 원래 목록은 그대로). 평가손익·평가금액은 통화를 맞춰야 비교되므로 늘 원화 환산 금액으로 —
 * '평가손익'은 손익 금액 순이다 (BH-51: 예전에는 수익률로 비교해 +10만 원(+40%)이 +300만 원(+10%)보다 위에 왔다). 시세·평가가 없으면 뒤로
 */
export function sortHoldings<T extends RegisteredWithQuote>(list: T[], sort: SortKey, afterCost: boolean): T[] {
  const out = [...list];
  const shared = sharedFx(list);
  const num = (s: T, k: "changeRate" | "profit" | "value"): number => {
    const q = s.quote;
    if (!q) return Number.NEGATIVE_INFINITY;
    if (k === "changeRate") return q.changeRate;
    const v = evalView(s.evaluation, { afterCost, toKrw: true, currency: q.currency, fx: fxWith(s, shared) });
    if (!v) return Number.NEGATIVE_INFINITY;
    return k === "profit" ? v.profit : v.marketValue;
  };
  switch (sort) {
    case "name":
      return out.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    case "market":
      return out.sort((a, b) => a.market.localeCompare(b.market) || a.name.localeCompare(b.name, "ko"));
    case "changeRate":
    case "profit":
    case "value":
      return out.sort((a, b) => num(b, sort) - num(a, sort));
    default:
      return out;
  }
}
