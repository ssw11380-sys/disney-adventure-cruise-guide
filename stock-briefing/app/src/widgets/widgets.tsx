import React from "react";
import { FlexWidget, ListWidget, TextWidget, type FlexWidgetStyle } from "react-native-android-widget";
import type { Currency, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { formatPct, formatPrice, shownSign, toDisplay } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import { fxOf, totals } from "@/lib/portfolio";
import { DISCLAIMER_SHORT } from "@/lib/disclaimer";
import { sentence, speakAmount, speakProfit } from "@/lib/a11y";
import {
  accountMix,
  asOfMs,
  asOfVariants,
  assetLine,
  briefingEmptyText,
  chipTexts,
  DAY_LABEL,
  excludedCount,
  failureText,
  holdingsTitles,
  HOME_URI,
  indexItems,
  indexSpeech,
  isHeld,
  pnlLine,
  pnlSpeech,
  polishedIndexItems,
  polishedRowSpeech,
  rowSpeech,
  tone,
  widgetOrder,
  type IndexItemText,
  type ChipText,
  type PnlLine,
  type PnlMode,
} from "./model";
import { currentMarket, isDelayed, openMarketAsOf, type WidgetBrief, type WidgetIndex, type WidgetMarket } from "./payload";
import { marketUri } from "./board";
import {
  CHIP_PAD_Y,
  EMPTY_LINES,
  GLYPH_GAP,
  indexItemWidth,
  indexTag,
  PAD,
  planAsset,
  planBriefing,
  planHoldings,
  planHoldingsPolished,
  PNL_GLYPH,
  POLISH_BOTTOM,
  POLISH_ROW_PAD,
  POLISH_SEP_GAP,
  POLISH_TOP,
  textWidth,
  VALUE_LABEL,
  type HeaderPlan,
  type IndexInput,
  type IndexPlan,
  type RowInput,
  type RowsPlan,
  type TitlePlan,
  type TotalPlan,
} from "./layout";
import { space } from "@/tokens";
import { CHIP_RADIUS, WIDGET_COLORS, WIDGET_FONT as F, WIDGET_RADIUS, WIDGET_TOUCH as TOUCH, type WidgetPalette } from "./palette";

export { totals, type Totals } from "@/lib/portfolio";

/**
 * 홈 화면 위젯 3종 (+ 지수·환율 위젯은 marketWidget.tsx). react-native-android-widget 프리미티브만 쓴다(RN 컴포넌트 불가, 색은 hex/rgba 문자열).
 *  - HoldingsWidget (4x2~): 총 평가·누적 손익(금액·수익률) + 지수 한 줄 + 등록 종목 전체(보유 → 관심, 평가금액 순)를 스크롤 목록으로.
 *    종목을 누르면 상세로, 합계를 누르면 앱으로, 손익을 누르면 누적 ↔ 당일 (widgetPnlToggle).
 *    높이가 모자라면 전환 칸 → 메모 → 목록 순으로 뺀다 (목록은 높이 0 이면 그려지지 않으므로 자리가 있을 때만, layout.ts planHoldings).
 *  - BriefingWidget (4x2): 보유 비중 상위 3종목의 최신 브리핑 한 줄씩 + 고지 한 줄. 누르면 브리핑 상세로.
 *  - AssetWidget (2x1): 총 평가금액과 오늘 손익만 크게.
 * 새로고침(↻, 48dp 칸)은 clickAction "REFRESH", 손익 전환은 "PNL_TOGGLE" 로 태스크 핸들러에 전달된다.
 * 크기별 배치·글자 폭은 layout.ts (숫자는 자르지 않는다), 색은 palette.ts 의 라이트·다크 팔레트 (3-23).
 *
 * 주의: 라이브러리가 트리를 만들 때 null 을 돌려주는 컴포넌트·Fragment 를 다룰 수 없다.
 * 조건부 칸은 부모에서 `cond ? <X/> : null` 로 넣고, map 결과에는 null 을 넣지 않는다.
 */

/** 위젯 이름 (app.json 의 react-native-android-widget 플러그인 widgets[].name 과 같다). market = 지수·환율 위젯 (APK 1.4.0, marketWidget.tsx) */
export const WIDGET_NAMES = { holdings: "Holdings", briefing: "Briefing", asset: "Asset", market: "Market" } as const;

/** 태스크 핸들러로 오는 누름 (OPEN_URI 딥링크는 오지 않는다) */
export const WIDGET_CLICK = { refresh: "REFRESH", pnlToggle: "PNL_TOGGLE" } as const;

const DEEP_LINK = HOME_URI;

/** 부르는 쪽이 크기를 주지 않을 때 (테스트·미리보기): 흔한 4×2 · 2×1 크기 */
const DEFAULT_LIST = { width: 320, height: 200 } as const;
const DEFAULT_ASSET = { width: 200, height: 90 } as const;

/** 런처가 크기를 아직 모를 때(0) 흔한 크기로 */
const dp = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback);

/** 위젯 크기(widgetInfo dp)·시스템 글자 배율·팔레트 */
export interface WidgetFrame {
  width?: number;
  height?: number;
  fontScale?: number;
  palette?: WidgetPalette;
  /**
   * 넓은 모습(잔고 평가금액 칸·두 열, 지수·환율 옆 칸)을 고를 때 쓰는 가장 넓은 폭 (폴드 위젯 2차 — frame.ts "wide":
   * 같은 위젯이 더 좁은 바깥 화면에도 보이면 그 폭). 없으면 width
   */
  wideWidth?: number;
}

function money(n: number | null | undefined, currency: Currency | undefined, fx: number | null, showKrw: boolean, sign = false): string {
  const d = toDisplay(n, currency, fx, showKrw);
  return formatPrice(d.value, d.currency, { sign });
}

const rootStyle = (c: WidgetPalette): FlexWidgetStyle => ({
  height: "match_parent",
  width: "match_parent",
  backgroundColor: c.bg,
  borderRadius: WIDGET_RADIUS,
  flexDirection: "column",
});

/** 잔고·브리핑: ↻ 칸이 오른쪽 위 끝에 붙게 위·오른쪽 여백은 두지 않는다 (본문이 오른쪽 여백을 따로 둔다) */
const listRootStyle = (c: WidgetPalette): FlexWidgetStyle => ({ ...rootStyle(c), paddingLeft: PAD, paddingBottom: PAD });

/**
 * 장 상태 칩 (장중은 금색, 그 밖은 회색). 없을 때는 부르는 쪽에서 넣지 않는다.
 * chip: 다듬은 모습의 글자와 색 (보이는 시장으로 고른 것 — model.chipTexts). 없으면 market.label · market.open
 */
function Chip({ market, chip, c }: { market: WidgetMarket; chip?: ChipText; c: WidgetPalette }) {
  const open = chip ? chip.open : market.open;
  return (
    <FlexWidget style={{ borderRadius: CHIP_RADIUS, paddingHorizontal: space.xs, paddingVertical: CHIP_PAD_Y, borderWidth: 1, borderColor: open ? c.gold : c.line }}>
      <TextWidget text={chip ? chip.text : market.label} maxLines={1} style={{ color: open ? c.gold : c.muted, fontSize: F.xs, fontWeight: "700" }} />
    </FlexWidget>
  );
}

/** ↻ 칸 (48×48dp): 누르면 새로고침, 갱신 중이면 강조색 */
function RefreshBox({ refreshing, c }: { refreshing: boolean; c: WidgetPalette }) {
  return (
    <FlexWidget
      clickAction={WIDGET_CLICK.refresh}
      accessibilityLabel={refreshing ? "갱신 중" : "새로 고침"}
      style={{ width: TOUCH, height: TOUCH, flexDirection: "column", alignItems: "center", justifyContent: "center" }}
    >
      <TextWidget text="↻" style={{ color: refreshing ? c.accent : c.muted, fontSize: F.icon }} />
    </FlexWidget>
  );
}

/** 브리핑 탭 딥링크 (앱 라우트 (tabs)/briefings). 다듬은 모습(widgetPolish)의 브리핑 위젯 제목·안내 문구가 연다 (위젯 검토 7번) */
export const BRIEFINGS_URI = `${DEEP_LINK}briefings`;

/**
 * 머리 줄 (48dp): 왼쪽 묶음을 누르면 uri(기본 잔고 탭)로, 오른쪽 ↻ 칸(48×48dp)은 새로고침.
 * 다듬은 모습의 브리핑 위젯은 브리핑 탭(BRIEFINGS_URI)을 연다 — 제목이 "브리핑"인데 잔고 탭이 열리지 않게 (위젯 검토 7번).
 * 갱신 중이면 기준 시각 자리에 "갱신 중"
 */
function Header({ title, plan, market, refreshing, label, uri = HOME_URI, c }: { title: string; plan: HeaderPlan; market: WidgetMarket | null; refreshing: boolean; label: string; uri?: string; c: WidgetPalette }) {
  return (
    <FlexWidget style={{ width: "match_parent", height: TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri }} accessibilityLabel={label} style={{ height: TOUCH, flexDirection: "row", alignItems: "center", flexGap: space.s }}>
        <TextWidget text={title} maxLines={1} style={{ color: c.ink, fontSize: F.title, fontWeight: "700" }} />
        {plan.chip && market ? <Chip market={market} c={c} /> : null}
        {plan.sub ? <TextWidget text={plan.sub} maxLines={1} style={{ color: refreshing ? c.accent : c.muted, fontSize: F.sm }} /> : null}
        {plan.delayed ? <TextWidget text="지연" maxLines={1} style={{ color: c.warn, fontSize: F.sm, fontWeight: "700" }} /> : null}
      </FlexWidget>
      <RefreshBox refreshing={refreshing} c={c} />
    </FlexWidget>
  );
}

/** 합계 아래 회색 한 줄 조각: 갱신 실패·이전 값·합계에서 빠진 종목 (앞의 것이 더 중요) */
function noteParts(error: string | null, filled: number, excluded: number): string[] {
  return [failureText(error), filled ? `${filled}종목 이전 값` : null, excluded ? `일부 제외 ${excluded}` : null].filter((x): x is string => !!x);
}

type StockWidgetProps = {
  stocks: RegisteredWithQuote[];
  showKrw: boolean;
  afterCost?: boolean;
  fetchedAt: number;
  error: string | null;
  filled?: string[];
  /** 그리는 시각 (기준 시각에 날짜를 붙일지 판단). 부르는 쪽에서 넘긴다 */
  now: number;
  /** 장 상태 칩 (없으면 칩 없이) */
  market?: WidgetMarket | null;
};

export interface HoldingsExtra {
  /** 손익을 눌러 누적 ↔ 당일 (widgetPnlToggle). 꺼져 있으면 예전처럼 누적만, 누르면 앱 */
  pnlToggle?: boolean;
  pnlMode?: PnlMode;
  /** 지수 줄 (widgetIndexLine). 켜져 있고 서버가 지수를 준 때만 보인다 */
  indexLine?: boolean;
  indices?: WidgetIndex[] | null;
  /** ↻ 를 누른 직후 "갱신 중" */
  refreshing?: boolean;
  /** 다듬은 모습 (widgetPolish). 꺼져 있거나 모르면(예전 서버) 예전 모습 그대로 */
  polish?: boolean;
  /** 다듬은 모습의 종목 줄 손익 금액을 원화로 (설정 "위젯 종목 금액", 기본 원화). 가격 칸은 showKrw 를 따른다 */
  rowKrw?: boolean;
}

interface RowView extends RowInput {
  code: string;
  hasQuote: boolean;
  change: number;
  /** 등락률 글자의 부호 — "0.00%" 로 보이면 0 (앱 잔고 줄과 같게, BH-38) */
  rateSign: number;
  /** 고른 아랫줄의 색: 그 줄에 보이는 값의 부호로 ("0.00% $0.00"·"0.00% 0원" 은 기본 글자색, BH-38) */
  subColor: (text: string) => `#${string}`;
  speech: string;
}

function rowView(s: RegisteredWithQuote, filled: string[], showKrw: boolean, afterCost: boolean, c: WidgetPalette): RowView {
  const q = s.quote;
  const fx = fxOf(s);
  const ev = evalView(s.evaluation, { afterCost, toKrw: showKrw, currency: q?.currency, fx });
  // 시세를 못 받은 보유 종목은 "관심"이 아니라 "시세 없음"
  const old = filled.includes(s.code) ? "이전 값 · " : "";
  let subs: string[];
  if (ev) {
    const pct = formatPct(ev.profitRate);
    subs = [`${old}${pct} ${formatPrice(ev.profit, ev.currency, { sign: true })}`, `${old}${pct}`, pct];
  } else if (isHeld(s)) subs = [`${Number((s.quantity ?? 0).toFixed(4))}주 · 시세 없음`, "시세 없음"];
  else subs = ["관심"];
  const price = q ? money(q.price, q.currency, fx, showKrw) : "-";
  const rate = q ? formatPct(q.changeRate) : null;
  return {
    code: s.code,
    name: s.name,
    price,
    rate,
    subs: [...new Set(subs)],
    hasQuote: !!q,
    change: q?.change ?? 0,
    rateSign: q && rate ? shownSign(q.changeRate, rate) : 0,
    subColor: (text) => (ev ? tone(shownSign(ev.profit, text), c) : c.muted),
    speech: rowSpeech(s.name, q ? price : null, q?.changeRate),
  };
}

/**
 * 합계·손익 줄. 손익 전환 칸이 있으면(plan.toggle) 합계(앱 열기)와 손익(전환, 48dp 높이)을 따로 누른다.
 * 플래그가 켜져 있어도 위젯이 낮아 칸을 뺐으면(layout.ts) 예전처럼 줄 전체가 앱 열기
 */
function TotalRow({ plan, total, pnl, c }: { plan: TotalPlan; total: string; pnl: PnlLine; c: WidgetPalette }) {
  const toggle = plan.toggle;
  const color = tone(pnl.sign, c);
  const totalLabel = `총 평가 ${speakAmount(total)}`;
  const pnlLabel = pnlSpeech(pnl, toggle);
  const row: FlexWidgetStyle = plan.inline
    ? { width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: plan.gapY, marginBottom: plan.gapY }
    : { width: "match_parent", flexDirection: "column", alignItems: "flex-start", marginTop: plan.gapY, marginBottom: plan.gapY };
  const pnlBoxStyle: FlexWidgetStyle = { height: plan.pnlH, paddingHorizontal: plan.pnlPadX, flexDirection: "column", justifyContent: "center", alignItems: plan.inline ? "flex-end" : "flex-start" };
  const totalText = <TextWidget text={total} maxLines={1} style={{ color: c.ink, fontSize: plan.totalFont, fontWeight: "800" }} />;
  const pnlTexts = plan.pnl.map((line) => <TextWidget key={line} text={line} maxLines={1} style={{ color, fontSize: plan.pnlFont, fontWeight: "700" }} />);
  if (!toggle) {
    // 예전과 같이 줄 전체가 앱 열기, 손익은 누적
    return (
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={`${totalLabel}, ${pnlLabel}`} style={row}>
        {totalText}
        <FlexWidget style={pnlBoxStyle}>{pnlTexts}</FlexWidget>
      </FlexWidget>
    );
  }
  return (
    <FlexWidget style={row}>
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={totalLabel} style={{ height: plan.totalH, flexDirection: "column", justifyContent: "center" }}>
        {totalText}
      </FlexWidget>
      {/* 보여 주는 쪽을 함께 보낸다: 태스크 핸들러가 그 반대로 저장한다 (잔고 위젯이 둘 이상이어도 누른 위젯이 바로 바뀌게) */}
      <FlexWidget clickAction={WIDGET_CLICK.pnlToggle} clickActionData={{ mode: pnl.mode }} accessibilityLabel={pnlLabel} style={pnlBoxStyle}>
        {pnlTexts}
      </FlexWidget>
    </FlexWidget>
  );
}

/**
 * 지수 한 항목의 글자: 이름(회색) 값 등락률(등락색). 출처 조회가 실패한 항목은 모두 회색 + "지연".
 * 다듬은 모습은 지난 세션 값도 모두 회색 + 그 날짜("9/23"), 좁으면 값을 뺀 짧은 모양(short)
 */
function indexParts(it: IndexItemText, font: number, c: WidgetPalette): React.JSX.Element[] {
  const color = it.stale ? c.muted : tone(it.change, c);
  const tag = indexTag(it);
  const out: React.JSX.Element[] = [];
  out.push(<TextWidget key={`${it.code}-label`} text={it.label} maxLines={1} style={{ color: c.muted, fontSize: font }} />);
  if (!it.short) out.push(<TextWidget key={`${it.code}-value`} text={it.value} maxLines={1} style={{ color, fontSize: font, fontWeight: "700" }} />);
  if (it.rate) out.push(<TextWidget key={`${it.code}-rate`} text={it.rate} maxLines={1} style={{ color, fontSize: font, fontWeight: "700" }} />);
  if (tag) out.push(<TextWidget key={`${it.code}-stale`} text={tag} maxLines={1} style={{ color: c.muted, fontSize: font }} />);
  return out;
}

/** 항목 사이 " · " */
const indexSep = (code: string, font: number, c: WidgetPalette) => <TextWidget key={`${code}-sep`} text="·" style={{ color: c.muted, fontSize: font }} />;

function indexNodes(it: IndexItemText, first: boolean, font: number, c: WidgetPalette): React.JSX.Element[] {
  return [...(first ? [] : [indexSep(it.code, font, c)]), ...indexParts(it, font, c)];
}

/** 합계 아래 지수·환율 한 줄 (large 는 두 줄까지). 누르면 앱 (홈 지수 띠), 화면 읽기는 한 문장 */
function IndexLine({ plan, items, c }: { plan: IndexPlan<IndexItemText>; items: IndexItemText[]; c: WidgetPalette }) {
  const shown = plan.lines.flat();
  return (
    <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={indexSpeech(shown.length ? shown : items)} style={{ width: "match_parent", flexDirection: "column", marginBottom: space.xs }}>
      {plan.lines.map((line) => (
        <FlexWidget key={line.map((i) => i.code).join("-")} style={{ flexDirection: "row", alignItems: "center", flexGap: space.xs }}>
          {line.flatMap((it, n) => indexNodes(it, n === 0, plan.font, c))}
        </FlexWidget>
      ))}
    </FlexWidget>
  );
}

function RowRight({ r, rows, c }: { r: RowView; rows: RowsPlan; c: WidgetPalette }) {
  if (!r.hasQuote) return <TextWidget text="-" maxLines={1} style={{ color: c.muted, fontSize: F.md }} />;
  const color = tone(r.change, c);
  // 현재가는 전일 대비 방향 색, 등락률은 보이는 값의 부호 색 — 1센트 움직인 230달러 종목의 "0.00%" 는 기본 글자색 (앱 잔고 줄과 같게, BH-38)
  const price = <TextWidget text={r.price} maxLines={1} style={{ color, fontSize: F.base, fontWeight: "700" }} />;
  const rate = <TextWidget text={r.rate ?? "-"} maxLines={1} style={{ color: tone(r.rateSign, c), fontSize: F.md, fontWeight: "700", width: rows.rateW, textAlign: "right" }} />;
  return rows.stacked ? (
    <FlexWidget style={{ flexDirection: "column", alignItems: "flex-end" }}>
      {price}
      {rate}
    </FlexWidget>
  ) : (
    <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.sm }}>
      {price}
      {rate}
    </FlexWidget>
  );
}

// ── 다듬은 잔고 위젯 (widgetPolish) ────────────────────────────────────

interface PolishedRow extends RowView {
  /** 등락률 앞 작은 글자 ("오늘", 시세가 없으면 없음) */
  label: string | null;
  /** 평가금액 (손익 줄과 같은 통화 — 넓은 위젯의 평가금액 칸에만 보인다). 평가가 없으면(관심·시세 없음) null */
  value: string | null;
}

/**
 * 다듬은 모습의 종목 한 줄: 왼쪽 아래는 "수익 +12.34% +1,234,000원"(누적, 합계와 같은 원화 기준 — 설정 "위젯 종목 금액"이 종목 통화면 그 통화),
 * 오른쪽은 가격(원화 표시 설정 그대로)과 "오늘 +1.20%"
 */
function polishedRowView(s: RegisteredWithQuote, filled: string[], showKrw: boolean, rowKrw: boolean, afterCost: boolean, c: WidgetPalette): PolishedRow {
  const q = s.quote;
  const fx = fxOf(s);
  const ev = evalView(s.evaluation, { afterCost, toKrw: rowKrw, currency: q?.currency, fx });
  const old = filled.includes(s.code) ? "이전 값 · " : "";
  let subs: string[];
  if (ev) {
    const pct = formatPct(ev.profitRate);
    subs = [`${old}수익 ${pct} ${formatPrice(ev.profit, ev.currency, { sign: true })}`, `${old}수익 ${pct}`, `수익 ${pct}`, pct];
  } else if (isHeld(s)) subs = [`${Number((s.quantity ?? 0).toFixed(4))}주 · 시세 없음`, "시세 없음"];
  else subs = ["관심"];
  const price = q ? money(q.price, q.currency, fx, showKrw) : "-";
  const rate = q ? formatPct(q.changeRate) : null;
  return {
    code: s.code,
    name: s.name,
    price,
    rate,
    subs: [...new Set(subs)],
    hasQuote: !!q,
    change: q?.change ?? 0,
    // 예전 줄과 같이 보이는 값의 부호로 색 ("수익 0.00% 0원"·"오늘 0.00%" 는 기본 글자색, BH-38)
    rateSign: q && rate ? shownSign(q.changeRate, rate) : 0,
    subColor: (text) => (ev ? tone(shownSign(ev.profit, text), c) : c.muted),
    speech: polishedRowSpeech(s.name, q ? price : null, q?.changeRate, ev?.profitRate),
    label: q ? DAY_LABEL : null,
    value: ev ? formatPrice(ev.marketValue, ev.currency) : null,
  };
}

/**
 * 다듬은 지수 줄의 누르는 칸 (위젯 검토 7번 — 예전: 줄 전체가 잔고 탭): 보이는 항목이 모두 48dp(WIDGET_TOUCH) 넘게 넓으면 한 줄이든 두 줄이든
 * 항목마다 그 지수·환율 차트("each"). 하나라도 좁으면(아주 작은 글자 배율 등) 따로 누르기 어려우므로 줄 전체를 한 칸으로 해 첫 항목의 차트를 연다
 * ({ single } — 차트 화면 위 띠에서 다른 지수·환율로 바로 바꿀 수 있다).
 * 두 줄(4x3 이상·폴드8 커버 4x2 크게)을 한 칸으로 묶으면 사용자의 주 크기에서 '코스피'·'원/달러'를 눌러도 '나스닥'이 열려(검증 지적 2차) 항목마다 둔다.
 * 줄 높이(글자 한 줄 약 10~15dp)가 48dp 보다 낮은 것은 한 줄일 때와 같은 예외다 — 줄 전체가 잔고 탭을 열던 때·종목 줄(약 38dp)처럼
 */
export function indexLineTargets(plan: IndexPlan<IndexInput & { code: string }>, scale: number): "each" | { single: string } {
  const shown = plan.lines.flat();
  if (shown.every((it) => indexItemWidth(it, plan.font, scale) >= TOUCH)) return "each";
  return { single: shown[0]!.code };
}

/**
 * 다듬은 지수 줄 (한 줄, 큰 위젯은 두 줄까지 · 아래 여백 0): 항목마다 묶고, 항목 사이 " · " 는 좁게(POLISH_SEP_GAP — layout polishedSepWidth).
 * 항목을 누르면 그 지수·환율 차트(market/코드 — 지수·환율 위젯 칸과 같은 곳), 화면 읽기도 항목마다 (두 줄이어도).
 * 항목이 좁으면 줄 전체가 첫 항목의 차트 한 칸이고 보이는 항목을 한 문장으로 읽는다 (indexLineTargets)
 */
function PolishedIndexLine({ plan, scale, c }: { plan: IndexPlan<IndexItemText>; scale: number; c: WidgetPalette }) {
  const target = indexLineTargets(plan, scale);
  const single = target === "each" ? null : target.single;
  const itemStyle: FlexWidgetStyle = { flexDirection: "row", alignItems: "center", flexGap: space.xs };
  const lines = plan.lines.map((line) => (
    <FlexWidget key={line.map((i) => i.code).join("-")} style={{ flexDirection: "row", alignItems: "center", flexGap: POLISH_SEP_GAP }}>
      {line.flatMap((it, n) => [
        ...(n ? [indexSep(it.code, plan.font, c)] : []),
        single ? (
          <FlexWidget key={it.code} style={itemStyle}>
            {indexParts(it, plan.font, c)}
          </FlexWidget>
        ) : (
          <FlexWidget key={it.code} clickAction="OPEN_URI" clickActionData={{ uri: marketUri(it.code) }} accessibilityLabel={indexSpeech([it])} style={itemStyle}>
            {indexParts(it, plan.font, c)}
          </FlexWidget>
        ),
      ])}
    </FlexWidget>
  ));
  return single ? (
    <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: marketUri(single) }} accessibilityLabel={indexSpeech(plan.lines.flat())} style={{ width: "match_parent", flexDirection: "column" }}>
      {lines}
    </FlexWidget>
  ) : (
    <FlexWidget style={{ width: "match_parent", flexDirection: "column" }}>{lines}</FlexWidget>
  );
}

/**
 * 제목 · 칩 · 기준 시각 · 지연 (누르면 잔고 탭). 다듬은 모습의 제목 줄과 48dp 머리 줄이 같이 쓴다.
 * chips: 칩 글자 후보와 색 (plan.chip 이 고른 글자의 색으로). padTop: 제목 줄 위 여백도 누르는 칸에 넣는다 — 바로 아래 합계 칸(같은 곳을 연다)과 이어져
 * 하나의 큰 칸이 된다
 */
function TitleGroup({ plan, chips, market, refreshing, label, height, padTop, c }: { plan: TitlePlan; chips: ChipText[]; market: WidgetMarket | null; refreshing: boolean; label: string; height?: number; padTop?: number; c: WidgetPalette }) {
  const chip = chips.find((x) => x.text === plan.chip);
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: HOME_URI }}
      accessibilityLabel={label}
      style={{ ...(height ? { height } : {}), ...(padTop ? { paddingTop: padTop } : {}), flexDirection: "row", alignItems: "center", flexGap: space.s }}
    >
      <TextWidget text={plan.title} maxLines={1} style={{ color: c.ink, fontSize: F.title, fontWeight: "700" }} />
      {chip && market ? <Chip market={market} chip={chip} c={c} /> : null}
      {plan.sub ? <TextWidget text={plan.sub} maxLines={1} style={{ color: refreshing ? c.accent : c.muted, fontSize: F.sm }} /> : null}
      {plan.delayed ? <TextWidget text="지연" maxLines={1} style={{ color: c.warn, fontSize: F.sm, fontWeight: "700" }} /> : null}
    </FlexWidget>
  );
}

/**
 * 다듬은 합계 줄: 합계(누르면 앱) · 손익(⇅ + 누적/오늘, 누르면 전환 — 플래그가 꺼져 있거나 낮은 위젯이면 앱) · [↻ (48×48)].
 * refresh: 누르는 칸 둘(손익 전환·↻)을 한 줄(48dp)에 모아 머리 줄 48dp 를 줄인 모양. 아니면 ↻ 는 48dp 머리 줄에 있다. 좁으면 합계 아래에 손익
 */
function TopRow({ plan, total, pnl, refresh, refreshing, c }: { plan: TotalPlan; total: string; pnl: PnlLine; refresh: boolean; refreshing: boolean; c: WidgetPalette }) {
  const toggle = plan.toggle;
  const color = tone(pnl.sign, c);
  const totalLabel = `총 평가 ${speakAmount(total)}`;
  const totalBox = (
    <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={totalLabel} style={{ height: plan.totalH, flexDirection: "column", justifyContent: "center" }}>
      <TextWidget text={total} maxLines={1} style={{ color: c.ink, fontSize: plan.totalFont, fontWeight: "800" }} />
    </FlexWidget>
  );
  const lines = plan.pnl.map((line) => <TextWidget key={line} text={line} maxLines={1} style={{ color, fontSize: plan.pnlFont, fontWeight: "700" }} />);
  const pnlStyle: FlexWidgetStyle = { height: plan.pnlH, paddingHorizontal: plan.pnlPadX, flexDirection: "row", alignItems: "center", flexGap: GLYPH_GAP };
  const pnlBox = toggle ? (
    // 보여 주는 쪽을 함께 보낸다: 태스크 핸들러가 그 반대로 저장한다
    <FlexWidget clickAction={WIDGET_CLICK.pnlToggle} clickActionData={{ mode: pnl.mode }} accessibilityLabel={pnlSpeech(pnl, true, true)} style={pnlStyle}>
      <TextWidget text={PNL_GLYPH} maxLines={1} style={{ color: c.muted, fontSize: plan.pnlFont, fontWeight: "700" }} />
      <FlexWidget style={{ flexDirection: "column", alignItems: plan.inline ? "flex-end" : "flex-start" }}>{lines}</FlexWidget>
    </FlexWidget>
  ) : (
    <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={pnlSpeech(pnl, false)} style={pnlStyle}>
      <FlexWidget style={{ flexDirection: "column", alignItems: plan.inline ? "flex-end" : "flex-start" }}>{lines}</FlexWidget>
    </FlexWidget>
  );
  const row: FlexWidgetStyle = { width: "match_parent", height: plan.height, flexDirection: "row", justifyContent: "space-between", marginTop: plan.gapY, marginBottom: plan.gapY };
  if (plan.inline) {
    return (
      <FlexWidget style={{ ...row, alignItems: "center" }}>
        {totalBox}
        <FlexWidget style={{ flexDirection: "row", alignItems: "center" }}>
          {pnlBox}
          {refresh ? <RefreshBox refreshing={refreshing} c={c} /> : null}
        </FlexWidget>
      </FlexWidget>
    );
  }
  return (
    <FlexWidget style={{ ...row, alignItems: "flex-start" }}>
      <FlexWidget style={{ flexDirection: "column" }}>
        {totalBox}
        {pnlBox}
      </FlexWidget>
      {refresh ? <RefreshBox refreshing={refreshing} c={c} /> : null}
    </FlexWidget>
  );
}

/** 다듬은 종목 줄 오른쪽: 가격(전일 대비 방향 색) · 작은 "오늘"(회색) + 등락률(보이는 값의 부호 색, BH-38) */
function PolishedRowRight({ r, rows, c }: { r: PolishedRow; rows: RowsPlan; c: WidgetPalette }) {
  if (!r.hasQuote) return <TextWidget text="-" maxLines={1} style={{ color: c.muted, fontSize: F.md }} />;
  const color = tone(r.change, c);
  const price = <TextWidget text={r.price} maxLines={1} style={{ color, fontSize: F.base, fontWeight: "700" }} />;
  const rate = (
    <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.xxs }}>
      {r.label ? <TextWidget text={r.label} maxLines={1} style={{ color: c.muted, fontSize: F.xs }} /> : null}
      <TextWidget text={r.rate ?? "-"} maxLines={1} style={{ color: tone(r.rateSign, c), fontSize: F.md, fontWeight: "700", width: rows.rateW, textAlign: "right" }} />
    </FlexWidget>
  );
  return rows.stacked ? (
    <FlexWidget style={{ flexDirection: "column", alignItems: "flex-end" }}>
      {price}
      {rate}
    </FlexWidget>
  ) : (
    <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.sm }}>
      {price}
      {rate}
    </FlexWidget>
  );
}

/**
 * 다듬은 잔고 위젯의 종목 줄을 누르면 여는 곳: 예전처럼 그 종목 상세. 줄은 약 38dp 로 48dp 보다 낮지만
 * (같은 크기에 종목이 더 보이게) 예전 줄(약 37dp)도 줄마다 종목을 열었고, 위젯에서 종목으로 바로 가는 길을 없애지 않는다
 */
export const polishedRowUri = (code: string) => `${DEEP_LINK}stocks/${code}`;

/**
 * 다듬은 종목 한 칸 (누르면 그 종목 상세): 왼쪽 이름 · 손익 줄, [평가금액 칸 — 넓은 위젯만], 오른쪽 가격 · 오늘 등락률.
 * width: 두 열(넓은 위젯)이면 한 열 폭, 아니면 지금처럼 목록 폭 전체
 */
function PolishedCell({ r, sub, rows, width, c }: { r: PolishedRow; sub: string | null; rows: RowsPlan; width?: number; c: WidgetPalette }) {
  const valueShown = !!rows.valueW && !!r.value;
  // 평가금액 칸이 보이면 화면 읽기에도 (보이는 것과 읽는 것을 같게)
  const label = valueShown ? sentence([r.speech, `${VALUE_LABEL} ${speakAmount(r.value!)}`]) : r.speech;
  const right = <PolishedRowRight r={r} rows={rows} c={c} />;
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: polishedRowUri(r.code) }}
      accessibilityLabel={label}
      style={{ width: width ?? "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: POLISH_ROW_PAD, borderTopWidth: 1, borderTopColor: c.line }}
    >
      <FlexWidget style={{ flexDirection: "column", width: rows.leftW }}>
        <TextWidget text={r.name} truncate="END" maxLines={1} style={{ color: c.ink, fontSize: F.base, fontWeight: "600" }} />
        {sub ? <TextWidget text={sub} maxLines={1} style={{ color: r.subColor(sub), fontSize: rows.subFont }} /> : null}
      </FlexWidget>
      {rows.valueW ? (
        <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.sm }}>
          {/* 평가금액 칸: 작은 회색 "평가금액" 위에 금액 (관심·시세 없음은 빈 칸 — 줄마다 가격 칸이 같은 자리에 오게) */}
          {valueShown ? (
            <FlexWidget style={{ width: rows.valueW, flexDirection: "column", alignItems: "flex-end" }}>
              <TextWidget text={VALUE_LABEL} maxLines={1} style={{ color: c.muted, fontSize: F.xs }} />
              <TextWidget text={r.value!} maxLines={1} style={{ color: c.ink, fontSize: F.base, fontWeight: "600" }} />
            </FlexWidget>
          ) : (
            <FlexWidget style={{ width: rows.valueW, flexDirection: "column" }}>
              <TextWidget text=" " maxLines={1} style={{ color: c.muted, fontSize: F.xs }} />
            </FlexWidget>
          )}
          {/* 오른쪽 칸은 정해진 폭(rightW)에 오른쪽 맞춤 — 줄마다 가격 폭이 달라도 평가금액 칸이 같은 자리에 */}
          <FlexWidget style={{ width: rows.rightW ?? 0, flexDirection: "row", alignItems: "center", justifyContent: "flex-end" }}>{right}</FlexWidget>
        </FlexWidget>
      ) : (
        right
      )}
    </FlexWidget>
  );
}

/**
 * 다듬은 잔고 위젯 (widgetPolish, 2026-09-25 위젯 검토 "전부 수정해줘"):
 *  1. 칩에 두 시장의 지금 세션 — 원화 보유액이 큰 시장부터 ("미국 주간거래 · 한국 휴장"), 좁으면 앞 시장만. 보이는 시장 중 장중(달력)이 있을 때만 금색
 *  2. 지수 줄: 계좌 비중 순서(미국이 크면 나스닥·S&P500 먼저), 원/달러는 끝·등락률까지, 지난 세션 값은 흐리게 + 날짜.
 *     좁으면 둘째 지수부터 빼고 지수는 등락률만 — 시장마다 하나와 원/달러는 330dp 에도 보인다. 4×3 이상은 두 줄까지
 *  3. 종목 줄: 왼쪽 "수익 …"(누적, 합계와 같은 통화 — 기본 원화), 오른쪽 "오늘 …". 누르면 예전처럼 그 종목 상세 (polishedRowUri)
 *  4. 손익 전환 칸에 ⇅ 와 "누적"/"오늘", 화면 읽기는 "눌러서 당일 손익 보기"
 *  5. 제목 "보유 17 · 관심 1" (좁으면 "보유 17")
 *  6. 세로 빈칸 줄이기: ↻ 를 합계 줄로 옮겨 머리 줄을 글자 높이로, 지수 줄·종목 줄·아래 여백을 줄인다 (layout.ts planHoldingsPolished)
 */
function PolishedHoldingsWidget(props: StockWidgetProps & WidgetFrame & HoldingsExtra) {
  const { stocks, showKrw, afterCost = true, fetchedAt, error, filled = [], now, market: given } = props;
  const c = props.palette ?? WIDGET_COLORS;
  const width = dp(props.width, DEFAULT_LIST.width);
  const height = dp(props.height, DEFAULT_LIST.height);
  const scale = props.fontScale ?? 1;
  const refreshing = props.refreshing === true;
  const t = totals(stocks, showKrw, afterCost);
  const signed = (n: number) => formatPrice(n, t?.currency, { sign: true });
  const pct = (n: number) => formatPct(n);
  const cum = t ? pnlLine("cumulative", t, signed, pct, DAY_LABEL) : null;
  const chosen = t && props.pnlToggle === true ? pnlLine(props.pnlMode ?? "cumulative", t, signed, pct, DAY_LABEL) : null;
  const total = t ? formatPrice(t.value, t.currency) : null;
  // 종목 줄 손익은 합계와 같은 통화로 (설정 "위젯 종목 금액" 기본 원화). 합계가 달러면(모두 미국 종목·원화 표시 꺼짐) 줄도 달러 — 합계 $ 옆 줄만 원이 되지 않게
  const rowKrw = props.rowKrw !== false && t?.currency !== "USD";
  const rows = widgetOrder(stocks, fxOf).map((s) => polishedRowView(s, filled, showKrw, rowKrw, afterCost, c));
  const asOf = asOfMs(stocks, fetchedAt);
  const market = currentMarket(given, now);
  const delayed = isDelayed({ openAsOf: openMarketAsOf(stocks, market), fetchedAt, error, now });
  const mix = accountMix(stocks, fxOf);
  const usFirst = mix.us > mix.kr;
  const items = props.indexLine ? polishedIndexItems(props.indices, now, usFirst) : [];
  const head = holdingsTitles(stocks);
  const chips = chipTexts(market, stocks, usFirst);
  const sub = refreshing ? ["갱신 중"] : asOfVariants(asOf, now);
  const alert = !refreshing && failureText(error) ? "갱신 실패" : null;
  const plan = planHoldingsPolished({
    width,
    height,
    scale,
    title: { titles: head.titles, chips: chips.map((x) => x.text), sub, delayed },
    total: total && cum ? { total, fixed: { amount: cum.amount, rate: cum.rate }, toggle: chosen ? { amount: chosen.amount, rate: chosen.rate } : null } : null,
    indices: items,
    rows,
    rowLabel: DAY_LABEL,
    note: noteParts(refreshing ? null : error, filled.length, excludedCount(stocks)),
    alert,
    // 넓은 위젯(3-42)의 평가금액 칸 — 좁은 위젯에서는 쓰지 않는다 (layout.ts planRowsWide)
    values: rows.map((r) => r.value),
    // 폴드 위젯 2차: 더 좁은 화면에도 보이는 위젯이면 넓은 모습은 그 폭까지 (frame.ts)
    ...(props.wideWidth !== undefined ? { wideMax: props.wideWidth } : {}),
  });
  const pnl = plan.total?.toggle ? chosen : cum;
  const headerLabel = sentence([head.speech, chips[0]?.text, alert && plan.title.sub === alert ? alert : null, refreshing ? "갱신 중" : sub[0], delayed ? "시세 지연" : null]);
  const titleGroup = (
    <TitleGroup plan={plan.title} chips={chips} market={market} refreshing={refreshing} label={headerLabel} {...(plan.compact ? { padTop: POLISH_TOP } : { height: TOUCH })} c={c} />
  );
  return (
    <FlexWidget style={{ ...rootStyle(c), paddingLeft: PAD, paddingBottom: POLISH_BOTTOM }}>
      {plan.compact ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "row", paddingRight: PAD }}>{titleGroup}</FlexWidget>
      ) : (
        <FlexWidget style={{ width: "match_parent", height: TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          {titleGroup}
          <RefreshBox refreshing={refreshing} c={c} />
        </FlexWidget>
      )}
      {plan.compact && plan.total && total && pnl ? <TopRow plan={plan.total} total={total} pnl={pnl} refresh refreshing={refreshing} c={c} /> : null}
      <FlexWidget style={{ width: "match_parent", flexDirection: "column", paddingRight: PAD }}>
        {!plan.compact && plan.total && total && pnl ? <TopRow plan={plan.total} total={total} pnl={pnl} refresh={false} refreshing={refreshing} c={c} /> : null}
        {plan.index ? <PolishedIndexLine plan={plan.index} scale={scale} c={c} /> : null}
        {plan.note ? <TextWidget text={plan.note} maxLines={1} style={{ color: c.muted, fontSize: F.sm }} /> : null}
        {rows.length === 0 && !error && !refreshing ? <TextWidget text="등록된 종목이 없습니다" maxLines={EMPTY_LINES} style={{ color: c.muted, fontSize: F.md }} /> : null}
        {rows.length === 0 && error && !refreshing ? <TextWidget text="잔고를 불러오지 못했습니다. ↻ 로 다시 시도" maxLines={EMPTY_LINES} style={{ color: c.muted, fontSize: F.md }} /> : null}
      </FlexWidget>
      {/* 목록은 첫 줄이 보일 높이가 있을 때만 (높이 0 인 목록은 라이브러리가 그리지 못해 위젯이 갱신되지 않는다) */}
      {plan.list && rows.length > 0 ? (
        <ListWidget style={{ height: "match_parent", width: "match_parent", marginRight: PAD }}>
          {plan.wide
            ? // 넓은 위젯(3-42): 줄마다 두 종목 (왼쪽 → 오른쪽, 평가금액 순서 그대로). 칸마다 따로 누르고 따로 읽는다
              pairs(rows).map(([a, b], n) => (
                <FlexWidget key={`${a.code}-${b?.code ?? ""}`} style={{ width: "match_parent", flexDirection: "row", flexGap: plan.wide!.gap }}>
                  <PolishedCell r={a} sub={plan.rows.sub[n * 2] ?? null} rows={plan.rows} width={plan.wide!.columnW} c={c} />
                  {b ? <PolishedCell r={b} sub={plan.rows.sub[n * 2 + 1] ?? null} rows={plan.rows} width={plan.wide!.columnW} c={c} /> : null}
                </FlexWidget>
              ))
            : rows.map((r, n) => <PolishedCell key={r.code} r={r} sub={plan.rows.sub[n] ?? null} rows={plan.rows} c={c} />)}
        </ListWidget>
      ) : null}
    </FlexWidget>
  );
}

/** 둘씩 묶기 (마지막이 하나면 [a, null]) */
function pairs<T>(xs: readonly T[]): [T, T | null][] {
  const out: [T, T | null][] = [];
  for (let k = 0; k < xs.length; k += 2) out.push([xs[k]!, xs[k + 1] ?? null]);
  return out;
}

export function HoldingsWidget(props: StockWidgetProps & WidgetFrame & HoldingsExtra) {
  // 다듬은 모습 (widgetPolish). 꺼져 있으면 아래 예전 모습 그대로
  if (props.polish) return <PolishedHoldingsWidget {...props} />;
  const { stocks, showKrw, afterCost = true, fetchedAt, error, filled = [], now, market: given } = props;
  const c = props.palette ?? WIDGET_COLORS;
  const width = dp(props.width, DEFAULT_LIST.width);
  const height = dp(props.height, DEFAULT_LIST.height);
  const scale = props.fontScale ?? 1;
  const refreshing = props.refreshing === true;
  const t = totals(stocks, showKrw, afterCost);
  // 합계 옆은 누적 손익 (사용자 요청 2026-09-24, 토스 "내 투자"처럼 금액과 수익률). 손익 전환이 켜져 있으면 저장된 쪽(누적·당일)
  const signed = (n: number) => formatPrice(n, t?.currency, { sign: true });
  const pct = (n: number) => formatPct(n);
  const cum = t ? pnlLine("cumulative", t, signed, pct) : null;
  const chosen = t && props.pnlToggle === true ? pnlLine(props.pnlMode ?? "cumulative", t, signed, pct) : null;
  const total = t ? formatPrice(t.value, t.currency) : null;
  const ordered = widgetOrder(stocks, fxOf);
  const rows = ordered.map((s) => rowView(s, filled, showKrw, afterCost, c));
  const asOf = asOfMs(stocks, fetchedAt);
  const market = currentMarket(given, now);
  const delayed = isDelayed({ openAsOf: openMarketAsOf(stocks, market), fetchedAt, error, now });
  const items = props.indexLine ? indexItems(props.indices) : [];
  const title = `잔고 ${rows.length}`;
  const sub = refreshing ? ["갱신 중"] : asOfVariants(asOf, now);
  // 메모 줄이 들어갈 높이가 없으면 머리 줄에 "갱신 실패" (갱신 중일 때는 "갱신 중"이 먼저)
  const alert = !refreshing && failureText(error) ? "갱신 실패" : null;
  const plan = planHoldings({
    width,
    height,
    scale,
    header: { title, chip: market?.label ?? null, sub, delayed },
    total: total && cum ? { total, fixed: { amount: cum.amount, rate: cum.rate }, toggle: chosen ? { amount: chosen.amount, rate: chosen.rate } : null } : null,
    indices: items,
    rows,
    // 갱신 중에는 지난 실패 문구를 빼고 "갱신 중"만 (둘이 함께 보이지 않게)
    note: noteParts(refreshing ? null : error, filled.length, excludedCount(stocks)),
    alert,
  });
  // 전환 칸을 둔 배치면 저장된 쪽, 아니면(플래그 꺼짐·낮은 위젯) 누적
  const pnl = plan.total?.toggle ? chosen : cum;
  const headerLabel = sentence([`잔고 ${rows.length}종목`, market?.label, alert && plan.header.sub === alert ? alert : null, refreshing ? "갱신 중" : sub[0], delayed ? "시세 지연" : null]);
  return (
    <FlexWidget style={listRootStyle(c)}>
      <Header title={title} plan={plan.header} market={market} refreshing={refreshing} label={headerLabel} c={c} />
      <FlexWidget style={{ width: "match_parent", flexDirection: "column", paddingRight: PAD }}>
        {plan.total && total && pnl ? <TotalRow plan={plan.total} total={total} pnl={pnl} c={c} /> : null}
        {plan.index ? <IndexLine plan={plan.index} items={items} c={c} /> : null}
        {plan.note ? <TextWidget text={plan.note} maxLines={1} style={{ color: c.muted, fontSize: F.sm }} /> : null}
        {rows.length === 0 && !error && !refreshing ? <TextWidget text="등록된 종목이 없습니다" maxLines={EMPTY_LINES} style={{ color: c.muted, fontSize: F.md }} /> : null}
        {rows.length === 0 && error && !refreshing ? <TextWidget text="잔고를 불러오지 못했습니다. ↻ 로 다시 시도" maxLines={EMPTY_LINES} style={{ color: c.muted, fontSize: F.md }} /> : null}
      </FlexWidget>
      {/* 목록은 첫 줄이 보일 높이가 있을 때만 (높이 0 인 목록은 라이브러리가 그리지 못해 위젯이 갱신되지 않는다) */}
      {plan.list && rows.length > 0 ? (
        <ListWidget style={{ height: "match_parent", width: "match_parent", marginRight: PAD }}>
          {rows.map((r, n) => {
            const subText = plan.rows.sub[n];
            return (
              <FlexWidget
                key={r.code}
                clickAction="OPEN_URI"
                clickActionData={{ uri: `${DEEP_LINK}stocks/${r.code}` }}
                accessibilityLabel={r.speech}
                style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: space.xs, borderTopWidth: 1, borderTopColor: c.line }}
              >
                <FlexWidget style={{ flexDirection: "column", width: plan.rows.leftW }}>
                  <TextWidget text={r.name} truncate="END" maxLines={1} style={{ color: c.ink, fontSize: F.base, fontWeight: "600" }} />
                  {subText ? <TextWidget text={subText} maxLines={1} style={{ color: r.subColor(subText), fontSize: plan.rows.subFont }} /> : null}
                </FlexWidget>
                <RowRight r={r} rows={plan.rows} c={c} />
              </FlexWidget>
            );
          })}
        </ListWidget>
      ) : null}
    </FlexWidget>
  );
}

/** "2026-09-24" + 오후 → 읽기용 "9월 24일 오후" */
function speakDate(date: string, session: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}월 ${Number(d)}일 ${session}`;
}

/**
 * 브리핑: 서버가 고른 보유 비중 상위 3종목(예전 서버면 최신 3개)의 요약 첫 줄 + 고지 한 줄 (항상).
 * 보여 줄 브리핑이 없으면 안내 문구 — 서버가 준 브리핑 시간·최신 브리핑 실패 수(brief)로 (BH-68).
 * 다듬은 모습(polish = widgetPolish, 위젯 검토 7번): 제목(48dp 머리 줄)과 안내 문구("브리핑 생성 실패 …"·"아직 브리핑이 없습니다 …")를 누르면
 * 브리핑 탭 (예전: 제목은 잔고 탭, 안내는 누르는 칸이 아님). 안내 문구 칸은 머리 줄 아래 남는 곳 전체(고지 줄·빈 곳 포함)다.
 * 조회 실패 안내("… ↻ 로 다시 시도")는 ↻ 를 누르라는 말이라 그대로 둔다
 */
export function BriefingWidget(
  props: { briefings: LatestBriefing[]; fetchedAt: number; error: string | null; now: number; market?: WidgetMarket | null; refreshing?: boolean; brief?: WidgetBrief | null; polish?: boolean } & WidgetFrame,
) {
  const { briefings, fetchedAt, error, now } = props;
  const polish = props.polish === true;
  const c = props.palette ?? WIDGET_COLORS;
  const width = dp(props.width, DEFAULT_LIST.width);
  const height = dp(props.height, DEFAULT_LIST.height);
  const scale = props.fontScale ?? 1;
  const refreshing = props.refreshing === true;
  // 받은 순서 그대로(새 서버: 보유 비중 순, 예전 서버: data.ts 가 최신 순으로 정렬)
  const items = briefings.filter((b) => b.latest && b.latest.status === "ok").slice(0, 3);
  const market = currentMarket(props.market, now);
  const delayed = isDelayed({ openAsOf: null, fetchedAt, error, now });
  const sub = refreshing ? ["갱신 중"] : asOfVariants(fetchedAt, now);
  const plan = planBriefing({ width, height, scale, header: { title: "브리핑", chip: market?.label ?? null, sub, delayed }, count: items.length });
  const content = width - PAD * 2;
  const headerLabel = sentence(["브리핑", market?.label, refreshing ? "갱신 중" : sub[0], delayed ? "시세 지연" : null]);
  const message = briefingEmptyText(error, props.brief);
  // 다듬은 모습에서 안내 문구가 누르는 칸인지 (보여 줄 브리핑이 없고, 갱신 중·조회 실패가 아닐 때 — 조회 실패 안내는 ↻ 를 누르라는 말)
  const noticeTap = polish && !items.length && !refreshing && !error;
  return (
    <FlexWidget style={listRootStyle(c)}>
      <Header title="브리핑" plan={plan.header} market={market} refreshing={refreshing} label={headerLabel} uri={polish ? BRIEFINGS_URI : HOME_URI} c={c} />
      {items.length ? (
        plan.items ? (
          <FlexWidget style={{ width: "match_parent", flexDirection: "column", paddingRight: PAD, flexGap: space.xxs }}>
            {items.slice(0, plan.items).map((it) => {
              const b = it.latest!;
              const first = b.summary.split("\n").find(Boolean) ?? "";
              const session = b.session === "morning" ? "오전" : "오후";
              const itemProps = {
                clickAction: "OPEN_URI",
                clickActionData: { uri: `${DEEP_LINK}briefings/${b.id}` },
                accessibilityLabel: sentence([`${it.name} ${speakDate(b.date, session)} 브리핑`, first]),
              };
              if (plan.item === "line") {
                // 낮은 위젯: 이름(최대 40%)과 요약을 한 줄에. 날짜는 뺀다 (숫자를 자르지 않게)
                const nameW = Math.max(0, Math.floor(Math.min(textWidth(it.name, F.sm, scale, true), content * 0.4)));
                return (
                  <FlexWidget key={b.id} {...itemProps} style={{ width: "match_parent", flexDirection: "row", alignItems: "center", flexGap: space.xs }}>
                    <TextWidget text={it.name} maxLines={1} truncate="END" style={{ color: c.gold, fontSize: F.sm, fontWeight: "700", width: nameW }} />
                    <TextWidget text={first} maxLines={1} truncate="END" style={{ color: c.ink, fontSize: F.base, width: Math.max(0, Math.floor(content - nameW - space.xs)) }} />
                  </FlexWidget>
                );
              }
              // 날짜는 자르지 않는다: 이름 칸만 남는 폭 안에서 끝을 줄인다
              const date = ` · ${b.date.slice(5).replace("-", "/")} ${session}`;
              const nameW = Math.max(0, Math.floor(Math.min(textWidth(it.name, F.sm, scale, true), content - textWidth(date, F.sm, scale, true))));
              return (
                <FlexWidget key={b.id} {...itemProps} style={{ width: "match_parent", flexDirection: "column" }}>
                  <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center" }}>
                    <TextWidget text={it.name} maxLines={1} truncate="END" style={{ color: c.gold, fontSize: F.sm, fontWeight: "700", width: nameW }} />
                    <TextWidget text={date} maxLines={1} style={{ color: c.gold, fontSize: F.sm, fontWeight: "700" }} />
                  </FlexWidget>
                  <TextWidget text={first} maxLines={plan.summaryLines} truncate="END" style={{ color: c.ink, fontSize: F.base }} />
                </FlexWidget>
              );
            })}
          </FlexWidget>
        ) : null
      ) : refreshing ? null : noticeTap ? (
        // 안내 문구 칸 — 누르면 브리핑 탭. 글자 자리는 예전과 같고(여백은 칸 바깥에), 칸은 머리 줄 아래 남는 높이를 모두 차지한다(flex):
        // 한 줄(약 13dp)만 누르는 칸이면 아래 100dp 넘는 빈 곳을 눌러도 아무 일이 없어 초보 사용자가 겨누기 어렵다 (검증 지적).
        // 그래서 고지 한 줄도 이 칸 안에 같은 자리로 둔다 (고지를 눌러도 브리핑 탭).
        // 화면 읽기는 누르는 칸의 이름표만 읽으므로(칸 안 글자는 읽지 않음) 고지 문구도 이름표에 넣는다 (검증 지적 2차).
        // 안내가 한 줄뿐인 크기(4x1·글자 130%)에서 문장이 말줄임 없이 잘리지 않게 끝을 '…'로 줄인다 (검증 지적 2차 — 누르면 브리핑 탭에서 전체를 본다)
        <FlexWidget
          clickAction="OPEN_URI"
          clickActionData={{ uri: BRIEFINGS_URI }}
          accessibilityLabel={sentence([message, DISCLAIMER_SHORT])}
          style={{ width: "match_parent", flex: 1, flexDirection: "column", marginTop: plan.messageGap, paddingRight: PAD }}
        >
          <TextWidget text={message} maxLines={plan.messageLines} truncate="END" style={{ color: c.muted, fontSize: F.md }} />
          <TextWidget text={DISCLAIMER_SHORT} maxLines={1} style={{ color: c.muted, fontSize: F.xs, marginTop: space.xs }} />
        </FlexWidget>
      ) : (
        <TextWidget text={message} maxLines={plan.messageLines} style={{ color: c.muted, fontSize: F.md, marginTop: plan.messageGap, marginRight: PAD }} />
      )}
      {noticeTap ? null : <TextWidget text={DISCLAIMER_SHORT} maxLines={1} style={{ color: c.muted, fontSize: F.xs, marginTop: space.xs, marginRight: PAD }} />}
    </FlexWidget>
  );
}

export function AssetWidget(props: StockWidgetProps & WidgetFrame) {
  const { stocks, showKrw, afterCost = true, fetchedAt, error, filled = [], now, market: given } = props;
  const c = props.palette ?? WIDGET_COLORS;
  const width = dp(props.width, DEFAULT_ASSET.width);
  const height = dp(props.height, DEFAULT_ASSET.height);
  const scale = props.fontScale ?? 1;
  const t = totals(stocks, showKrw, afterCost);
  const fmt = (n: number) => formatPrice(n, t?.currency, { sign: true });
  const line = t ? assetLine(t.day, t.profit, fmt) : null;
  const asOf = asOfMs(stocks, fetchedAt);
  const market = currentMarket(given, now);
  const delayed = isDelayed({ openAsOf: openMarketAsOf(stocks, market), fetchedAt, error, now });
  const variants = asOfVariants(asOf, now);
  const asOfTexts = delayed ? [...variants.map((v) => `지연 · ${v}`), "지연"] : variants;
  const total = t && line ? formatPrice(t.value, t.currency) : null;
  const plan = planAsset({
    width,
    height,
    scale,
    label: "총 평가",
    chip: market?.label ?? null,
    asOf: asOfTexts,
    total,
    day: t && line ? { text: line.day.text, value: fmt(t.day) } : null,
    cum: line?.total.text ?? null,
    note: noteParts(error, filled.length, excludedCount(stocks)),
  });
  const empty = error ? `${failureText(error)} · 눌러서 앱 열기` : excludedCount(stocks) ? `시세 없음 · ${excludedCount(stocks)}종목` : "보유 종목 없음";
  // 위젯 전체가 한 칸(앱 열기)이라 화면 읽기는 가려진 칸까지 한 문장으로
  const label =
    t && total
      ? sentence([`총 평가 ${speakAmount(total)}`, `오늘 ${speakProfit(fmt(t.day), t.day)}`, `총 손익 ${speakProfit(fmt(t.profit), t.profit)}`, market?.label, asOfTexts[0]])
      : sentence(["총 평가", empty]);
  // 오늘 손익과 총손익은 각자 부호 색 (이 팔레트의 등락색)
  const dayColor = tone(t?.day ?? 0, c);
  const dayText = (text: string) => <TextWidget text={text} maxLines={1} style={{ color: dayColor, fontSize: plan.lineFont, fontWeight: "700" }} />;
  return (
    <FlexWidget
      style={{ ...rootStyle(c), paddingHorizontal: plan.pad, paddingVertical: space.s, justifyContent: "center" }}
      clickAction="OPEN_URI"
      clickActionData={{ uri: HOME_URI }}
      accessibilityLabel={label}
    >
      {plan.top ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: space.xs }}>
            {plan.top.label ? <TextWidget text="총 평가" maxLines={1} style={{ color: c.muted, fontSize: F.sm, fontWeight: "700" }} /> : null}
            {plan.top.chip && market ? <Chip market={market} c={c} /> : null}
          </FlexWidget>
          {plan.top.asOf ? <TextWidget text={plan.top.asOf} maxLines={1} style={{ color: delayed ? c.warn : c.muted, fontSize: F.xs }} /> : null}
        </FlexWidget>
      ) : null}
      {t && line && total ? (
        <FlexWidget style={{ width: "match_parent", flexDirection: "column", marginTop: space.xxs }}>
          <TextWidget text={total} maxLines={1} style={{ color: c.ink, fontSize: plan.totalFont, fontWeight: "800" }} />
          {/* 오늘 손익과 총손익은 각자 부호 색 (예전에는 둘 다 오늘 색이었다) */}
          {plan.line === "both" ? (
            <FlexWidget style={{ flexDirection: "row", flexGap: space.xs }}>
              {dayText(line.day.text)}
              <TextWidget text="·" style={{ color: c.muted, fontSize: plan.lineFont }} />
              <TextWidget text={line.total.text} maxLines={1} style={{ color: tone(t.profit, c), fontSize: plan.lineFont, fontWeight: "700" }} />
            </FlexWidget>
          ) : null}
          {plan.line === "day" ? dayText(line.day.text) : null}
          {plan.line === "dayValue" ? dayText(fmt(t.day)) : null}
          {plan.note ? <TextWidget text={plan.note} maxLines={1} style={{ color: c.muted, fontSize: F.xs }} /> : null}
        </FlexWidget>
      ) : (
        <TextWidget text={empty} maxLines={2} style={{ color: c.muted, fontSize: F.sm }} />
      )}
    </FlexWidget>
  );
}
