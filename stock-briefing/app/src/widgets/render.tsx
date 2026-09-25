import React from "react";
import { FlexWidget, TextWidget } from "react-native-android-widget";
import { space } from "@/tokens";
import type { WidgetData } from "./data";
import type { PnlMode } from "./model";
import { WIDGET_FONT, WIDGET_PALETTES, WIDGET_RADIUS, type WidgetPalette } from "./palette";
import { MarketWidget } from "./marketWidget";
import { agedIndices } from "./payload";
import { AssetWidget, BriefingWidget, HoldingsWidget, WIDGET_NAMES } from "./widgets";

/**
 * 위젯 한 개를 라이트·다크 두 벌로 그린다 (3-23). 안드로이드가 시스템 테마에 맞는 쪽을 보여 주므로
 * 테마를 바꿔도 서버를 다시 부르지 않고 바로 바뀐다. 태스크 핸들러·앱 즉시 갱신·오류 화면이 모두 이것을 쓴다.
 */

export interface RenderOpts {
  /** widgetInfo 의 폭·높이 (dp) */
  width: number;
  height: number;
  /** 시스템 글자 크기 배율 (100% = 1) */
  fontScale: number;
  /** 그리는 시각 */
  now: number;
  /** 잔고 위젯 손익 칸: 누적(기본) · 당일 */
  pnlMode: PnlMode;
  /** ↻ 를 누른 직후 "갱신 중" */
  refreshing?: boolean;
}

export interface Rendered {
  light: React.JSX.Element;
  dark: React.JSX.Element;
}

export function renderOne(name: string, data: WidgetData, o: RenderOpts, palette: WidgetPalette): React.JSX.Element {
  const frame = { width: o.width, height: o.height, fontScale: o.fontScale, palette };
  switch (name) {
    case WIDGET_NAMES.briefing:
      return <BriefingWidget briefings={data.briefings} fetchedAt={data.fetchedAt} error={data.error} now={o.now} market={data.market} refreshing={o.refreshing} brief={data.brief ?? null} {...frame} />;
    case WIDGET_NAMES.asset:
      return <AssetWidget stocks={data.stocks} showKrw={data.showKrw} afterCost={data.afterCost} fetchedAt={data.fetchedAt} error={data.error} filled={data.filled} now={o.now} market={data.market} {...frame} />;
    case WIDGET_NAMES.market:
      // 판을 받은 지 3시간(서버 지연 한도)이 넘으면 모든 칸을 "지연"으로
      return (
        <MarketWidget
          board={agedIndices(data.board, data.boardAt, o.now)}
          boardAt={data.board ? (data.boardAt ?? data.fetchedAt) : null}
          enabled={data.features.market}
          error={data.error}
          now={o.now}
          refreshing={o.refreshing}
          // 넓은 위젯 모양은 다듬은 모습(widgetPolish)과 함께 (3-42 폴드 — 꺼져 있으면 지금 모습 그대로)
          polish={data.features.polish}
          {...frame}
        />
      );
    default:
      return (
        <HoldingsWidget
          stocks={data.stocks}
          showKrw={data.showKrw}
          afterCost={data.afterCost}
          fetchedAt={data.fetchedAt}
          error={data.error}
          filled={data.filled}
          now={o.now}
          market={data.market}
          pnlToggle={data.features.pnlToggle}
          pnlMode={o.pnlMode}
          indexLine={data.features.indexLine}
          indices={agedIndices(data.indices, data.indicesAt, o.now)}
          refreshing={o.refreshing}
          polish={data.features.polish}
          rowKrw={data.rowKrw !== false}
          {...frame}
        />
      );
  }
}

export function renderBoth(name: string, data: WidgetData, o: RenderOpts): Rendered {
  return { light: renderOne(name, data, o, WIDGET_PALETTES.light), dark: renderOne(name, data, o, WIDGET_PALETTES.dark) };
}

function ErrorView({ message, c }: { message: string; c: WidgetPalette }) {
  return (
    <FlexWidget style={{ height: "match_parent", width: "match_parent", backgroundColor: c.bg, borderRadius: WIDGET_RADIUS, padding: space.md, flexDirection: "column", justifyContent: "center" }} clickAction="OPEN_APP" accessibilityLabel="위젯을 그리지 못했습니다. 눌러서 앱 열기">
      <TextWidget text="위젯을 그리지 못했습니다" style={{ color: c.ink, fontSize: WIDGET_FONT.base, fontWeight: "700" }} />
      <TextWidget text={message} style={{ color: c.muted, fontSize: WIDGET_FONT.sm }} maxLines={3} />
      <TextWidget text="눌러서 앱 열기" style={{ color: c.link, fontSize: WIDGET_FONT.sm, marginTop: space.xs }} />
    </FlexWidget>
  );
}

/** 렌더 중 예외가 나면 위젯이 빈 채로 남으므로 오류를 글로 보여 준다 (라이트·다크 둘 다) */
export function errorView(e: unknown): Rendered {
  const message = String(e instanceof Error ? e.message : e).slice(0, 120);
  return { light: <ErrorView message={message} c={WIDGET_PALETTES.light} />, dark: <ErrorView message={message} c={WIDGET_PALETTES.dark} /> };
}
