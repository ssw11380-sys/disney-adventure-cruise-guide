import type { RegisteredWithQuote } from "@/api/types";
import { isKrCode } from "@/lib/marketTime";
import { excludedLabel, isHolding, noExcluded, type Totals } from "@/lib/portfolio";
import { asOfLabel } from "./model";
import { currentMarket, STALE_MS, type WidgetMarket } from "./payload";

/** 휴장일·지난 세션 가격도 포함하므로 달력의 '오늘'로 부르지 않는다. */
export const WIDGET_CHANGE_LABEL = "전일 대비";

/** 시세 시각과 조회 시각을 분리한다. 좁아도 지난 날짜·시각 종류를 지운 후보는 만들지 않는다. */
export function widgetTimeVariants(at: number, now: number, kind: "quote" | "received"): string[] {
  const label = kind === "quote" ? "시세" : "조회";
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return [`${label} 시각 미확인`];
  return [`${label} ${asOfLabel(at, now).replace(/ 기준$/, "")}`];
}

/**
 * 금액과 같은 계산의 제외 사유를 쓰고, 보유 시세는 하나씩 판정한다.
 * 최신 종목 하나가 지난 값을 가리거나 시세 통화가 섞여 환율 없는 종목이 조용히 빠지는 것을 막는다.
 * 조회·재계산·저장은 하지 않는다. 플래그를 켠 화면만 이 결과를 표시한다.
 */
export function widgetClarity(stocks: RegisteredWithQuote[], total: Totals | null, market: WidgetMarket | null, now: number, filled: readonly string[] = []) {
  const held = stocks.filter(isHolding);
  const excluded = total?.excluded ?? noExcluded();
  if (!total) {
    for (const s of held) {
      if (!s.quote) excluded.noQuote += 1;
      else if (!s.evaluation) excluded.noEval += 1;
    }
  }
  const excludedCount = excluded.noQuote + excluded.noEval + excluded.noFx;
  const activeMarket = currentMarket(market, now);
  const filledSet = new Set(filled);
  const staleCodes: string[] = [];
  const quoteTimes: number[] = [];
  for (const s of held) {
    if (!s.quote) continue;
    const at = Date.parse(s.quote.asOf);
    if (Number.isFinite(at)) quoteTimes.push(at);
    const us = s.quote.currency === "USD" || (!s.quote.currency && !isKrCode(s.code));
    const open = us ? activeMarket?.us || activeMarket?.ext?.us : activeMarket?.kr || activeMarket?.ext?.kr;
    const session = s.quote.session;
    const until = session?.until ? Date.parse(session.until) : null;
    // 같은 시장에서도 연장 거래 미지원·거래정지 종목은 가격이 멈추는 것이 정상이다.
    const trading = session ? session.open === true && session.eligible === true && session.halted !== true
      && (until === null || (Number.isFinite(until) && now < until)) : open;
    if (s.quote.stale || filledSet.has(s.code) || !Number.isFinite(at) || (trading && now - at > STALE_MS)) staleCodes.push(s.code);
  }
  return {
    partial: excludedCount > 0,
    excludedCount,
    exclusionNote: excludedLabel(excluded),
    staleCodes,
    staleCount: staleCodes.length,
    staleNote: staleCodes.length ? `시세 확인 필요 ${staleCodes.length}종목` : null,
    earliestQuoteAt: quoteTimes.length ? Math.min(...quoteTimes) : null,
    latestQuoteAt: quoteTimes.length ? Math.max(...quoteTimes) : null,
  };
}
