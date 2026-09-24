import React from "react";
import { FlexWidget, TextWidget, type FlexWidgetStyle } from "react-native-android-widget";
import { sentence } from "@/lib/a11y";
import { space } from "@/tokens";
import { BOARD_TITLE, boardColumns, boardTiles, type BoardTile } from "./board";
import { BOARD_GAP, CAPTION_GAP, MARKER_GAP, PAD, planMarket, type MarketPlan } from "./layout";
import { asOfVariants, failureText, HOME_URI, tone } from "./model";
import type { WidgetIndex } from "./payload";
import { WIDGET_BOARD as BOARD, WIDGET_COLORS, WIDGET_FONT as F, WIDGET_TOUCH as TOUCH, type WidgetPalette } from "./palette";
import { WIDGET_CLICK, type WidgetFrame } from "./widgets";

/**
 * 지수·환율 위젯 (APK 1.4.0, 플래그 widgetMarket): 국내 | 미국 | 환율 세 구역을 세로 칸으로 나란히.
 *  - 칸: 이름(+장중 초록 점 · "지연") / 큰 값 / 등락("▲63.01 +0.90%"). 값·등락 표기와 색은 앱 지수 띠(MarketStrip)와 같다
 *  - 크기별(layout.ts planMarket): 4×3 이상은 9개 모두, 4×2 는 코스피·코스닥·나스닥·S&P500·원/달러·원/100엔(3×2), 더 낮으면 3개
 *  - 다크: 패널색 → 한 단계 깊은 색으로 비스듬한 그라데이션 카드, 라이트: 흰 카드에 얇은 테두리 (palette.ts)
 *  - 칸을 누르면 그 지수·환율 차트(market/[code]), 머리를 누르면 앱, ↻ 는 새로고침(48dp, 누르면 바로 "갱신 중")
 *  - 출처 조회가 실패한 항목은 마지막 값을 흐리게 + "지연", 위젯 조회가 실패하면 마지막 값을 두고 머리에 "갱신 실패 …"
 *  - 플래그가 꺼져 있거나 모르면(예전 서버) 값 대신 짧은 안내
 * 라이브러리가 null 을 돌려주는 컴포넌트를 다룰 수 없으므로 조건부 칸은 부모에서 `cond ? <X/> : null` 로 넣는다 (widgets.tsx 와 같은 규칙)
 */

/** 부르는 쪽이 크기를 주지 않을 때 (테스트·미리보기): 흔한 4×2 */
const DEFAULT = { width: 330, height: 180 } as const;
const dp = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback);

export const MARKET_OFF_TEXT = "지금은 지수·환율을 표시할 수 없습니다";
export const MARKET_EMPTY_TEXT = "지수·환율을 불러오지 못했습니다. ↻ 로 다시 시도";

export interface MarketWidgetProps extends WidgetFrame {
  /** 지수·환율 판 (서버 board 또는 앱 지수 띠, 3시간 넘게 못 받았으면 모두 stale) */
  board: WidgetIndex[] | null;
  /** 판을 받은 시각 (머리의 기준 시각) */
  boardAt: number | null;
  /** 플래그 widgetMarket (꺼져 있거나 모르면 false) */
  enabled: boolean;
  /** 이번 조회 실패 사유 (마지막 값은 그대로 보인다) */
  error: string | null;
  now: number;
  refreshing?: boolean;
}

const rootStyle = (c: WidgetPalette): FlexWidgetStyle => ({
  height: "match_parent",
  width: "match_parent",
  backgroundColor: c.bg,
  // 다크: 비스듬한 그라데이션 (안드로이드는 그라데이션이 테두리를 덮는다 — 테두리는 라이트에서만 보인다)
  ...(c.gradient ? { backgroundGradient: { from: c.gradient.from, to: c.gradient.to, orientation: "TL_BR" as const } } : {}),
  borderRadius: BOARD.radius,
  borderWidth: BOARD.border,
  borderColor: c.edge,
  flexDirection: "column",
  paddingLeft: PAD,
  paddingBottom: PAD,
});

/** 한 칸: 이름(+표시) / 값 / 등락. 지연·값 없음은 회색 */
function Tile({ t, plan, first, last, c }: { t: BoardTile; plan: MarketPlan; first: boolean; last: boolean; c: WidgetPalette }) {
  const color = t.stale || !t.has ? c.muted : tone(t.change, c);
  const change = plan.shape === "full" ? plan.change[t.code] : null;
  const style: FlexWidgetStyle = {
    width: "match_parent",
    flexDirection: "column",
    paddingTop: first ? 0 : plan.rowPad,
    paddingBottom: last ? 0 : plan.rowPad,
    ...(first ? {} : { borderTopWidth: BOARD.hairline, borderTopColor: c.line }),
  };
  return (
    <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: t.uri }} accessibilityLabel={t.speech} style={style}>
      <FlexWidget style={{ flexDirection: "row", alignItems: "center" }}>
        <TextWidget text={t.label} maxLines={1} truncate="END" style={{ color: c.sub, fontSize: plan.nameFont, fontWeight: "600", width: plan.nameW[t.code] ?? 0 }} />
        {t.live ? <FlexWidget style={{ width: BOARD.dot, height: BOARD.dot, borderRadius: BOARD.dot / 2, backgroundColor: c.live, marginLeft: MARKER_GAP }} /> : null}
        {t.stale ? <TextWidget text="지연" maxLines={1} style={{ color: c.warn, fontSize: plan.nameFont, fontWeight: "700", marginLeft: MARKER_GAP }} /> : null}
      </FlexWidget>
      <TextWidget text={t.value} maxLines={1} style={{ color, fontSize: plan.valueFont, fontWeight: "700" }} />
      {change ? <TextWidget text={change} maxLines={1} style={{ color, fontSize: plan.changeFont, fontWeight: "700" }} /> : null}
    </FlexWidget>
  );
}

/** 구역 한 줄(세로 칸): [구역 이름] + 칸들. 첫 구역 뒤로는 왼쪽에 머리카락 구분선 */
function Column({ col, index, count, plan, tiles, c }: { col: MarketPlan["columns"][number]; index: number; count: number; plan: MarketPlan; tiles: Map<string, BoardTile>; c: WidgetPalette }) {
  const first = index === 0;
  const lastCol = index === count - 1;
  const width = plan.colW + (first ? 0 : BOARD_GAP + BOARD.hairline) + (lastCol ? 0 : BOARD_GAP);
  const style: FlexWidgetStyle = {
    width,
    height: "match_parent",
    flexDirection: "column",
    paddingLeft: first ? 0 : BOARD_GAP,
    paddingRight: lastCol ? 0 : BOARD_GAP,
    ...(first ? {} : { borderLeftWidth: BOARD.hairline, borderLeftColor: c.line }),
  };
  const shown = col.codes.map((code) => tiles.get(code)).filter((t): t is BoardTile => !!t);
  return (
    <FlexWidget style={style}>
      {plan.captions ? <TextWidget text={col.label} maxLines={1} style={{ color: c.gold, fontSize: F.xs, fontWeight: "700", marginBottom: CAPTION_GAP }} /> : null}
      {shown.map((t, n) => (
        <Tile key={t.code} t={t} plan={plan} first={n === 0} last={n === shown.length - 1} c={c} />
      ))}
    </FlexWidget>
  );
}

export function MarketWidget(props: MarketWidgetProps) {
  const c = props.palette ?? WIDGET_COLORS;
  const width = dp(props.width, DEFAULT.width);
  const height = dp(props.height, DEFAULT.height);
  const scale = props.fontScale ?? 1;
  const refreshing = props.refreshing === true;
  const tiles = boardTiles(props.board);
  const hasData = props.enabled && tiles.some((t) => t.has);
  const fail = failureText(props.error);
  // 제목 옆: 갱신 중 → 갱신 실패(마지막 값을 두고) → 기준 시각 (판을 받은 시각)
  const sub = refreshing ? ["갱신 중"] : fail ? [fail, "갱신 실패"] : hasData && props.boardAt ? asOfVariants(props.boardAt, props.now) : [];
  const byCode = new Map(tiles.map((t) => [t.code, t]));
  const plan = planMarket({ width, height, scale, title: BOARD_TITLE, sub, columns: hasData ? boardColumns(tiles) : [] });
  const headerLabel = sentence([BOARD_TITLE, refreshing ? "갱신 중" : sub[0]]);
  // 판이 없을 때: 플래그 꺼짐·모름 → 짧은 안내, 켜져 있는데 못 받음 → 다시 시도 안내 (갱신 중에는 비움)
  const message = !props.enabled ? MARKET_OFF_TEXT : hasData || refreshing ? null : MARKET_EMPTY_TEXT;
  return (
    <FlexWidget style={rootStyle(c)}>
      <FlexWidget style={{ width: "match_parent", height: TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={headerLabel} style={{ height: TOUCH, flexDirection: "row", alignItems: "center", flexGap: space.s }}>
          <FlexWidget style={{ width: BOARD.mark.width, height: BOARD.mark.height, borderRadius: BOARD.mark.radius, backgroundColor: c.gold }} />
          <TextWidget text={BOARD_TITLE} maxLines={1} style={{ color: c.ink, fontSize: F.title, fontWeight: "700" }} />
          {plan.sub ? <TextWidget text={plan.sub} maxLines={1} style={{ color: refreshing ? c.accent : c.muted, fontSize: F.sm }} /> : null}
        </FlexWidget>
        <FlexWidget
          clickAction={WIDGET_CLICK.refresh}
          accessibilityLabel={refreshing ? "갱신 중" : "새로 고침"}
          style={{ width: TOUCH, height: TOUCH, flexDirection: "column", alignItems: "center", justifyContent: "center" }}
        >
          <TextWidget text="↻" style={{ color: refreshing ? c.accent : c.muted, fontSize: F.icon }} />
        </FlexWidget>
      </FlexWidget>
      {plan.columns.length ? (
        <FlexWidget style={{ width: "match_parent", height: "match_parent", flexDirection: "row", paddingRight: PAD }}>
          {plan.columns.map((col, n) => (
            <Column key={col.key} col={col} index={n} count={plan.columns.length} plan={plan} tiles={byCode} c={c} />
          ))}
        </FlexWidget>
      ) : message ? (
        <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={message} style={{ width: "match_parent", height: "match_parent", flexDirection: "column", justifyContent: "center", paddingRight: PAD }}>
          <TextWidget text={message} maxLines={plan.messageLines} style={{ color: c.muted, fontSize: F.md }} />
        </FlexWidget>
      ) : null}
    </FlexWidget>
  );
}
