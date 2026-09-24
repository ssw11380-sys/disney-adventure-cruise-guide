import React from "react";
import { FlexWidget, ListWidget, TextWidget, type FlexWidgetStyle } from "react-native-android-widget";
import type { Currency, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { formatPct, formatPrice, toDisplay } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import { fxOf, totals } from "@/lib/portfolio";
import { DISCLAIMER_SHORT } from "@/lib/disclaimer";
import { asOfLabel, asOfMs, assetLine, excludedCount, failureText, HOME_URI, isHeld, tone, widgetOrder } from "./model";
import { currentMarket, isDelayed, openMarketAsOf, type WidgetMarket } from "./payload";
import { space } from "@/tokens";
import { WIDGET_COLORS, WIDGET_FONT } from "./palette";

export { totals, type Totals } from "@/lib/portfolio";

/**
 * 홈 화면 위젯 3종. react-native-android-widget 프리미티브만 쓴다(RN 컴포넌트 불가, 색은 hex/rgba 문자열).
 *  - HoldingsWidget (4x2~): 총 평가·당일 손익 + 등록 종목 전체(보유 → 관심, 평가금액 순)를 스크롤 목록으로.
 *    종목을 누르면 상세로, 헤더를 누르면 앱으로. 위젯 높이를 늘리면 한 번에 더 많이 보인다.
 *  - BriefingWidget (4x2): 보유 비중 상위 3종목의 최신 브리핑 한 줄씩 + 고지 한 줄. 누르면 브리핑 상세로.
 *  - AssetWidget (2x1): 총 평가금액과 오늘 손익만 크게.
 * 새로고침 아이콘은 clickAction "REFRESH" 로 태스크 핸들러에 전달된다.
 */

export const WIDGET_NAMES = { holdings: "Holdings", briefing: "Briefing", asset: "Asset" } as const;

// 색·글자 크기는 위젯 팔레트에서 (앱 다크 테마와 같은 톤, 3-20)
const C = WIDGET_COLORS;
const F = WIDGET_FONT;

const DEEP_LINK = HOME_URI;

function money(n: number | null | undefined, currency: Currency | undefined, fx: number | null, showKrw: boolean, sign = false): string {
  const d = toDisplay(n, currency, fx, showKrw);
  return formatPrice(d.value, d.currency, { sign });
}

const root: FlexWidgetStyle = {
  height: "match_parent",
  width: "match_parent",
  backgroundColor: C.bg,
  borderRadius: 14,
  padding: space.md,
  flexDirection: "column",
};

/** 장 상태 칩 (장중은 금색, 그 밖은 회색) */
function MarketChip({ market }: { market: WidgetMarket | null | undefined }) {
  if (!market) return null;
  return (
    <FlexWidget style={{ borderRadius: 6, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderWidth: 1, borderColor: market.open ? C.gold : C.line }}>
      <TextWidget text={market.label} style={{ color: market.open ? C.gold : C.muted, fontSize: F.xs, fontWeight: "700" }} />
    </FlexWidget>
  );
}

/** 헤더를 누르면 잔고 탭으로 (OPEN_APP 은 마지막으로 보던 화면을 연다) */
function Header({ title, subtitle, market, delayed }: { title: string; subtitle?: string; market?: WidgetMarket | null; delayed?: boolean }) {
  return (
    <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.s }} clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }}>
        <TextWidget text={title} style={{ color: C.ink, fontSize: F.title, fontWeight: "700" }} />
        <MarketChip market={market} />
        {subtitle ? <TextWidget text={subtitle} style={{ color: C.muted, fontSize: F.sm }} /> : null}
        {delayed ? <TextWidget text="지연" style={{ color: C.warn, fontSize: F.sm, fontWeight: "700" }} /> : null}
      </FlexWidget>
      <FlexWidget clickAction="REFRESH" style={{ padding: space.xs }}>
        <TextWidget text="↻" style={{ color: C.muted, fontSize: F.icon }} />
      </FlexWidget>
    </FlexWidget>
  );
}

/** 합계 아래 회색 한 줄: 갱신 실패·이전 값·합계에서 빠진 종목 */
function notes(error: string | null, filled: number, excluded: number): string | null {
  const parts = [failureText(error), filled ? `${filled}종목 이전 값` : null, excluded ? `일부 제외 ${excluded}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

type StockWidgetProps = {
  stocks: RegisteredWithQuote[];
  showKrw: boolean;
  afterCost?: boolean;
  fetchedAt: number;
  error: string | null;
  filled?: string[];
  height?: number;
  /** 그리는 시각 (기준 시각에 날짜를 붙일지 판단). 부르는 쪽에서 넘긴다 */
  now: number;
  /** 장 상태 칩 (없으면 칩 없이) */
  market?: WidgetMarket | null;
};

export function HoldingsWidget({ stocks, showKrw, afterCost = true, fetchedAt, error, filled = [], now, market: given }: StockWidgetProps) {
  const t = totals(stocks, showKrw, afterCost);
  const rows = widgetOrder(stocks, fxOf);
  const note = notes(error, filled.length, excludedCount(stocks));
  const asOf = asOfMs(stocks, fetchedAt);
  const market = currentMarket(given, now);
  const delayed = isDelayed({ openAsOf: openMarketAsOf(stocks, market), fetchedAt, error, now });
  return (
    <FlexWidget style={root}>
      <Header title={`잔고 ${rows.length}`} subtitle={asOfLabel(asOf, now)} market={market} delayed={delayed} />
      {t ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: space.xs, marginBottom: space.xs }} clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }}>
          <TextWidget text={formatPrice(t.value, t.currency)} style={{ color: C.ink, fontSize: F.big, fontWeight: "800" }} />
          <TextWidget text={`당일 ${formatPrice(t.day, t.currency, { sign: true })}`} style={{ color: tone(t.day) as `#${string}`, fontSize: F.md, fontWeight: "700" }} />
        </FlexWidget>
      ) : null}
      {note ? <TextWidget text={note} maxLines={1} truncate="END" style={{ color: C.muted, fontSize: F.sm }} /> : null}
      {rows.length === 0 && !error ? <TextWidget text="등록된 종목이 없습니다" style={{ color: C.muted, fontSize: F.md }} /> : null}
      {rows.length === 0 && error ? <TextWidget text="잔고를 불러오지 못했습니다. ↻ 로 다시 시도" style={{ color: C.muted, fontSize: F.md }} /> : null}
      {rows.length > 0 ? (
        <ListWidget style={{ height: "match_parent", width: "match_parent" }}>
          {rows.map((s) => {
            const q = s.quote;
            const fx = fxOf(s);
            const ev = evalView(s.evaluation, { afterCost, toKrw: showKrw, currency: q?.currency, fx });
            // 시세를 못 받은 보유 종목은 "관심"이 아니라 "시세 없음"
            const old = filled.includes(s.code) ? "이전 값 · " : "";
            const sub = ev ? `${old}${formatPct(ev.profitRate)} ${formatPrice(ev.profit, ev.currency, { sign: true })}` : isHeld(s) ? `${Number((s.quantity ?? 0).toFixed(4))}주 · 시세 없음` : "관심";
            return (
              <FlexWidget
                key={s.code}
                clickAction="OPEN_URI"
                clickActionData={{ uri: `${DEEP_LINK}stocks/${s.code}` }}
                style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: space.xs, borderTopWidth: 1, borderTopColor: C.line }}
              >
                <FlexWidget style={{ flexDirection: "column", width: 118 }}>
                  <TextWidget text={s.name} truncate="END" maxLines={1} style={{ color: C.ink, fontSize: F.base, fontWeight: "600" }} />
                  <TextWidget
                    text={sub}
                    truncate="END"
                    maxLines={1}
                    style={{ color: ev ? (tone(ev.profit) as `#${string}`) : C.muted, fontSize: F.sm }}
                  />
                </FlexWidget>
                {q ? (
                  <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.sm }}>
                    <TextWidget text={money(q.price, q.currency, fx, showKrw)} style={{ color: tone(q.change) as `#${string}`, fontSize: F.base, fontWeight: "700" }} />
                    <TextWidget text={formatPct(q.changeRate)} style={{ color: tone(q.change) as `#${string}`, fontSize: F.md, fontWeight: "700", width: 56, textAlign: "right" }} />
                  </FlexWidget>
                ) : (
                  <TextWidget text="-" style={{ color: C.muted, fontSize: F.md }} />
                )}
              </FlexWidget>
            );
          })}
        </ListWidget>
      ) : null}
    </FlexWidget>
  );
}

/** 브리핑: 서버가 고른 보유 비중 상위 3종목(예전 서버면 최신 3개)의 요약 첫 줄 + 고지 한 줄 (항상) */
export function BriefingWidget({ briefings, fetchedAt, error, now, market }: { briefings: LatestBriefing[]; fetchedAt: number; error: string | null; now: number; market?: WidgetMarket | null }) {
  // 받은 순서 그대로(새 서버: 보유 비중 순, 예전 서버: data.ts 가 최신 순으로 정렬)
  const items = briefings.filter((b) => b.latest && b.latest.status === "ok").slice(0, 3);
  return (
    <FlexWidget style={root}>
      <Header title="브리핑" subtitle={asOfLabel(fetchedAt, now)} market={currentMarket(market, now)} delayed={isDelayed({ openAsOf: null, fetchedAt, error, now })} />
      {items.length ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column", marginTop: space.xs, flexGap: space.xxs }}>
          {items.map((it) => {
            const b = it.latest!;
            const first = b.summary.split("\n").find(Boolean) ?? "";
            return (
              <FlexWidget key={b.id} clickAction="OPEN_URI" clickActionData={{ uri: `${DEEP_LINK}briefings/${b.id}` }} style={{ width: "match_parent", flexDirection: "column" }}>
                <TextWidget text={`${it.name} · ${b.date.slice(5).replace("-", "/")} ${b.session === "morning" ? "오전" : "오후"}`} maxLines={1} truncate="END" style={{ color: C.gold, fontSize: F.sm, fontWeight: "700" }} />
                <TextWidget text={first} maxLines={1} truncate="END" style={{ color: C.ink, fontSize: F.base }} />
              </FlexWidget>
            );
          })}
        </FlexWidget>
      ) : (
        <TextWidget text={error ? `${failureText(error)} · ↻ 로 다시 시도` : "아직 브리핑이 없습니다. 평일 08:30·16:00 에 생성됩니다."} style={{ color: C.muted, fontSize: F.md, marginTop: space.s }} />
      )}
      <TextWidget text={DISCLAIMER_SHORT} maxLines={1} style={{ color: C.muted, fontSize: F.xs, marginTop: space.xs }} />
    </FlexWidget>
  );
}

export function AssetWidget({ stocks, showKrw, afterCost = true, fetchedAt, error, filled = [], now, market: given }: StockWidgetProps) {
  const t = totals(stocks, showKrw, afterCost);
  const note = notes(error, filled.length, excludedCount(stocks));
  const line = t ? assetLine(t.day, t.profit, (n) => formatPrice(n, t.currency, { sign: true })) : null;
  const asOf = asOfMs(stocks, fetchedAt);
  const market = currentMarket(given, now);
  const delayed = isDelayed({ openAsOf: openMarketAsOf(stocks, market), fetchedAt, error, now });
  return (
    <FlexWidget style={{ ...root, padding: space.md, justifyContent: "center" }} clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }}>
      <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.xs }}>
          <TextWidget text="총 평가" style={{ color: C.muted, fontSize: F.sm, fontWeight: "700" }} />
          <MarketChip market={market} />
        </FlexWidget>
        <TextWidget text={delayed ? `지연 · ${asOfLabel(asOf, now)}` : asOfLabel(asOf, now)} style={{ color: delayed ? C.warn : C.muted, fontSize: F.xs }} />
      </FlexWidget>
      {t && line ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column", marginTop: space.xxs }}>
          <TextWidget text={formatPrice(t.value, t.currency)} maxLines={1} style={{ color: C.ink, fontSize: F.bigger, fontWeight: "800", adjustsFontSizeToFit: true }} />
          {/* 오늘 손익과 총손익은 각자 부호 색 (예전에는 둘 다 오늘 색이었다) */}
          <FlexWidget style={{ flexDirection: "row", flexGap: space.xs }}>
            <TextWidget text={line.day.text} maxLines={1} style={{ color: line.day.color as `#${string}`, fontSize: F.sm, fontWeight: "700" }} />
            <TextWidget text="·" style={{ color: C.muted, fontSize: F.sm }} />
            <TextWidget text={line.total.text} maxLines={1} truncate="END" style={{ color: line.total.color as `#${string}`, fontSize: F.sm, fontWeight: "700" }} />
          </FlexWidget>
          {note ? <TextWidget text={note} maxLines={1} truncate="END" style={{ color: C.muted, fontSize: F.xs }} /> : null}
        </FlexWidget>
      ) : (
        <TextWidget
          text={error ? `${failureText(error)} · 눌러서 앱 열기` : excludedCount(stocks) ? `시세 없음 · ${excludedCount(stocks)}종목` : "보유 종목 없음"}
          style={{ color: C.muted, fontSize: F.md }}
        />
      )}
    </FlexWidget>
  );
}
