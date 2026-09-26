import React from "react";
import { FlexWidget, TextWidget } from "react-native-android-widget";
import { space } from "@/tokens";
import type { WidgetData } from "./data";
import { frameFor, type BoxInfo, type SeenBy } from "./frame";
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
  /** 배치를 고를 폭·높이 (dp) — 보통 widgetInfo 의 크기. widgetFoldBoth 로 두 화면에 맞추면 두 화면에 모두 들어가는 크기 (frame.ts) */
  width: number;
  height: number;
  /** 넓은 모습(평가금액 칸·두 열·지수 옆 칸)을 고를 때 쓰는 가장 넓은 폭 (frame.ts "wide" — 0 이면 넓은 모습 없음). 없으면 width */
  wideWidth?: number;
  /**
   * 실제 그림 크기 (widgetInfo, dp). width·height 보다 크면 카드는 width × height 로 왼쪽 위에 두고 남는 곳은 투명 (frame.ts "both", widgetFoldBoth —
   * 한 그림이 폴드 바깥·안쪽 두 화면에 번갈아 보여도 같은 카드). 없으면 width·height 와 같다
   */
  outerWidth?: number;
  outerHeight?: number;
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
  return fitted(widgetOf(name, data, o, palette), o);
}

/**
 * 그림이 배치 크기보다 크면 (폴드 위젯 2차, frame.ts "both"): 카드는 배치 크기로 왼쪽 위에, 남는 오른쪽·아래는 투명.
 * 그림이 잘려 보이는 좁은 화면에서도 카드가 다 보이고, 넓은 화면에서도 같은 카드다 (빈 카드 바탕이 늘어나지 않는다).
 * 크기가 같으면 감싸지 않는다 — 트리가 예전과 같다
 */
function fitted(el: React.JSX.Element, o: RenderOpts): React.JSX.Element {
  const ow = o.outerWidth ?? o.width;
  const oh = o.outerHeight ?? o.height;
  if (!(ow > o.width || oh > o.height)) return el;
  // 위젯 전체의 화면 읽기 이름(맨 바깥 칸의 이름표 — 자산 위젯)은 감싼 칸으로 옮긴다 (라이브러리는 맨 바깥 칸의 것만 위젯 설명으로 쓴다)
  const label = rootLabel(el);
  return (
    <FlexWidget style={{ width: "match_parent", height: "match_parent", flexDirection: "column" }} {...(label ? { accessibilityLabel: label } : {})}>
      <FlexWidget style={{ width: Math.floor(o.width), height: Math.floor(o.height), flexDirection: "column" }}>{el}</FlexWidget>
    </FlexWidget>
  );
}

/** 위젯 부품이 그리는 맨 바깥 칸의 이름표 (라이브러리 buildWidgetTree 처럼 함수 부품을 펼쳐 본다 — 위젯 부품은 훅이 없는 순수 함수) */
function rootLabel(el: React.JSX.Element): string | undefined {
  let e = el;
  for (let i = 0; i < 4 && typeof e.type === "function" && !(e.type as { __name__?: string }).__name__; i++) e = (e.type as (p: unknown) => React.JSX.Element)(e.props);
  const label = (e.props as { accessibilityLabel?: unknown } | null)?.accessibilityLabel;
  return typeof label === "string" && label ? label : undefined;
}

function widgetOf(name: string, data: WidgetData, o: RenderOpts, palette: WidgetPalette): React.JSX.Element {
  const frame = { width: o.width, height: o.height, fontScale: o.fontScale, palette, ...(o.wideWidth !== undefined ? { wideWidth: o.wideWidth } : {}) };
  switch (name) {
    case WIDGET_NAMES.briefing:
      // 제목·안내 문구를 누르면 브리핑 탭은 다듬은 모습(widgetPolish)에서만 (위젯 검토 7번 — 꺼져 있으면 지금처럼 잔고 탭)
      return <BriefingWidget briefings={data.briefings} fetchedAt={data.fetchedAt} error={data.error} now={o.now} market={data.market} refreshing={o.refreshing} brief={data.brief ?? null} polish={data.features.polish} {...frame} />;
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

/**
 * 위젯 하나를 그 위젯의 지금 크기(box — widgetInfo: 번호·크기·화면)로 그린다. 폴드 위젯 2차(widgetFoldFit)가 켜져 있으면
 * 접는 폰의 바깥 화면에 넓은 모습이 나오지 않게 고르고(widgets/frame.ts), widgetFoldBoth 도 켜져 있으면 두 화면에 들어가는 카드로 그린다.
 * 태스크 핸들러·앱 즉시 갱신·다시 그리기가 모두 이것을 쓴다. 크기 기억의 시각은 o.now (그리는 시각).
 * seenBy: 크기를 알게 된 길 — 크기 변경 알림(resize)·위젯 추가(add)만 기억한 크기를 바꿀 수 있다 (frame.ts remember). 없으면 draw
 */
export async function renderFor(
  name: string,
  data: WidgetData,
  box: BoxInfo,
  opts: Omit<RenderOpts, "width" | "height" | "wideWidth" | "outerWidth" | "outerHeight"> & { seenBy?: SeenBy },
): Promise<Rendered> {
  const { seenBy, ...o } = opts;
  const f = await frameFor(box, { fit: data.features.foldFit === true, both: data.features.foldBoth === true }, o.now, seenBy ?? "draw");
  return renderBoth(name, data, {
    ...o,
    width: f.width,
    height: f.height,
    ...(f.wideWidth !== undefined ? { wideWidth: f.wideWidth } : {}),
    ...(f.outerWidth > f.width || f.outerHeight > f.height ? { outerWidth: f.outerWidth, outerHeight: f.outerHeight } : {}),
  });
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
