import React from "react";
import { FlexWidget, TextWidget, type FlexWidgetStyle } from "react-native-android-widget";
import { sentence } from "@/lib/a11y";
import { space } from "@/tokens";
import { BOARD_TITLE, boardColumns, boardTiles, type BoardTile } from "./board";
import { BOARD_GAP, MARKER_GAP, PAD, planMarket, STALE_TEXT, WIDE, type MarketPlan } from "./layout";
import { asOfVariants, failureText, HOME_URI, tone } from "./model";
import type { WidgetIndex } from "./payload";
import { WIDGET_BOARD as BOARD, WIDGET_COLORS, WIDGET_FONT as F, WIDGET_TOUCH as TOUCH, type WidgetPalette } from "./palette";
import { WIDGET_CLICK, type WidgetFrame } from "./widgets";

/**
 * 지수·환율 위젯 (APK 1.4.0, 플래그 widgetMarket): 국내 | 미국 | 환율 세 구역을 세로 칸으로 나란히.
 *  - 칸: 이름(+장중 초록 점 · "지연") / 큰 값 / 등락("▲63.01 +0.90%"). 값·등락 표기와 색은 앱 지수 띠(MarketStrip)와 같다.
 *    낮은 크기(4×3 등)는 두 줄 칸: 이름 ··· 등락률 / 큰 값 — 어느 크기에서도 ▲/▼(부호)와 색이 있는 등락률이 보인다
 *  - 크기별(layout.ts planMarket): 4×3 이상은 9개 모두, 4×2 는 코스피·코스닥·나스닥·S&P500·원/달러·원/100엔(3×2), 더 낮으면 3개.
 *    구역 폭은 필요한 만큼(이름이 긴 미국이 조금 넓다), 남는 높이는 칸 사이 여백으로
 *  - 다크: 패널색 → 한 단계 깊은 색으로 비스듬한 그라데이션 카드, 라이트: 흰 카드에 얇은 테두리 (palette.ts)
 *  - 칸을 누르면 그 지수·환율 차트(market/[code]), 머리를 누르면 앱, ↻ 는 새로고침(48dp, 누르면 바로 "갱신 중")
 *  - 출처 조회가 실패한 항목은 마지막 값을 흐리게 + "지연", 위젯 조회가 실패하면 마지막 값을 두고 머리에 "갱신 실패 …"
 *  - 플래그가 꺼져 있거나 모르면(예전 서버) 값 대신 짧은 안내
 *  - 넓은 위젯(3-42 폴드, 다듬은 모습 widgetPolish 만 · 폭 WIDE.boardMin 이상): 구역 안에서도 칸을 가로로 놓아 낮고 넓은 위젯에도 9개 모두, 값은 더 크게 (layout.ts planMarketWide)
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
  /**
   * 다듬은 모습 (widgetPolish, 3-42): 넓은 위젯(폴드 안쪽 화면에 늘린 위젯 등)은 구역 안에서도 칸을 가로로 놓아 9개 모두·큰 값.
   * 꺼져 있거나 모르면(예전 서버), 또는 폭이 WIDE.boardMin 미만이면 지금 모습 그대로
   */
  polish?: boolean;
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

/** 작은 점 (장중 초록 · 지연 경고색) */
const Dot = ({ color }: { color: WidgetPalette["live"] }) => (
  <FlexWidget style={{ width: BOARD.dot, height: BOARD.dot, borderRadius: BOARD.dot / 2, backgroundColor: color, marginLeft: MARKER_GAP }} />
);

/**
 * 한 칸. 지연·값 없음은 회색.
 *  - full: 이름(+장중 점·"지연") / 값 / 등락 줄
 *  - inline: 이름(+장중 점) ··· 등락률 / 값      - brief: 이름(+장중 점) ··· ▲/▼ / 값   (지연 항목은 오른쪽에 "지연")
 * 이름은 다 들어가면 글자 폭대로 두어 점·"지연"이 이름 바로 뒤에 붙는다 (줄일 때만 폭을 준다)
 */
function Tile({ t, plan, first, last, width, c }: { t: BoardTile; plan: MarketPlan; first: boolean; last: boolean; width?: number; c: WidgetPalette }) {
  const color = t.stale || !t.has ? c.muted : tone(t.change, c);
  const mark = plan.mark[t.code] ?? null;
  const change = plan.change[t.code] ?? null;
  const nameW = plan.nameW[t.code] ?? null;
  const full = plan.shape === "full";
  const style: FlexWidgetStyle = {
    // 넓은 위젯의 가로 칸은 정해진 폭 (가로 줄에서 match_parent 는 뒤 칸을 밀어낸다)
    width: width ?? "match_parent",
    flexDirection: "column",
    paddingTop: first ? 0 : plan.rowPad,
    paddingBottom: last ? 0 : plan.rowPad,
    ...(first ? {} : { borderTopWidth: BOARD.hairline, borderTopColor: c.line }),
  };
  const staleWord = (lead: boolean) => (
    <TextWidget text={STALE_TEXT} maxLines={1} style={{ color: c.warn, fontSize: plan.nameFont, fontWeight: "700", ...(lead ? { marginLeft: MARKER_GAP } : {}) }} />
  );
  const name = (
    <FlexWidget style={{ flexDirection: "row", alignItems: "center" }}>
      <TextWidget text={t.label} maxLines={1} truncate="END" style={{ color: c.sub, fontSize: plan.nameFont, fontWeight: "600", ...(nameW !== null ? { width: nameW } : {}) }} />
      {mark === "live" ? <Dot color={c.live} /> : mark === "staleDot" ? <Dot color={c.warn} /> : mark === "staleText" && full ? staleWord(true) : null}
    </FlexWidget>
  );
  const value = <TextWidget text={t.value} maxLines={1} style={{ color, fontSize: plan.valueFont, fontWeight: "700" }} />;
  if (!full) {
    const right = mark === "staleText" ? staleWord(false) : change ? <TextWidget text={change} maxLines={1} style={{ color, fontSize: plan.nameFont, fontWeight: "700" }} /> : null;
    return (
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: t.uri }} accessibilityLabel={t.speech} style={style}>
        <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          {name}
          {right}
        </FlexWidget>
        {value}
      </FlexWidget>
    );
  }
  return (
    <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: t.uri }} accessibilityLabel={t.speech} style={style}>
      {name}
      {value}
      {/* 등락이 없는 칸(한 번도 못 받음)도 줄 높이를 지켜 옆 구역과 줄이 맞게 */}
      <TextWidget text={change ?? " "} maxLines={1} style={{ color, fontSize: plan.changeFont, fontWeight: "700" }} />
    </FlexWidget>
  );
}

/** 구역 한 줄(세로 칸): [구역 이름] + 칸들. 첫 구역 뒤로는 왼쪽에 머리카락 구분선 */
function Column({ col, index, count, plan, tiles, c }: { col: MarketPlan["columns"][number]; index: number; count: number; plan: MarketPlan; tiles: Map<string, BoardTile>; c: WidgetPalette }) {
  const first = index === 0;
  const lastCol = index === count - 1;
  const width = col.width + (first ? 0 : BOARD_GAP + BOARD.hairline) + (lastCol ? 0 : BOARD_GAP);
  const style: FlexWidgetStyle = {
    width,
    height: "match_parent",
    flexDirection: "column",
    paddingLeft: first ? 0 : BOARD_GAP,
    paddingRight: lastCol ? 0 : BOARD_GAP,
    ...(first ? {} : { borderLeftWidth: BOARD.hairline, borderLeftColor: c.line }),
  };
  const shown = col.codes.map((code) => tiles.get(code)).filter((t): t is BoardTile => !!t);
  const per = col.cols ?? 1;
  // 넓은 위젯(3-42): 구역 안에서도 칸을 가로로 per 개씩 (왼쪽 → 오른쪽, 위 → 아래). 칸마다 따로 누르고 따로 읽는다
  const lines: BoardTile[][] = [];
  if (per > 1) for (let k = 0; k < shown.length; k += per) lines.push(shown.slice(k, k + per));
  return (
    <FlexWidget style={style}>
      {plan.captions ? <TextWidget text={col.label} maxLines={1} style={{ color: c.gold, fontSize: F.xs, fontWeight: "700", marginBottom: plan.captionGap }} /> : null}
      {per > 1
        ? lines.map((line, n) => (
            <FlexWidget key={line.map((t) => t.code).join("-")} style={{ width: "match_parent", flexDirection: "row", flexGap: WIDE.tileGap }}>
              {line.map((t) => (
                <Tile key={t.code} t={t} plan={plan} first={n === 0} last={n === lines.length - 1} width={col.tileW} c={c} />
              ))}
            </FlexWidget>
          ))
        : shown.map((t, n) => <Tile key={t.code} t={t} plan={plan} first={n === 0} last={n === shown.length - 1} c={c} />)}
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
  // 넓은 위젯 모양(구역 안 옆 칸)은 다듬은 모습일 때만, 폴드 위젯 2차가 준 폭(바깥 화면에 보일 수 있으면 0)이 허락할 때만 (frame.ts)
  const wide = props.polish === true && !(props.wideWidth !== undefined && props.wideWidth < WIDE.boardMin);
  const plan = planMarket({ width, height, scale, title: BOARD_TITLE, sub, columns: hasData ? boardColumns(tiles) : [], wide });
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
