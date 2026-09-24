import React from "react";
import { FlexWidget, ListWidget, TextWidget, type FlexWidgetStyle } from "react-native-android-widget";
import type { Currency, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { formatPct, formatPrice, toDisplay } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import { fxOf, totals } from "@/lib/portfolio";
import { DISCLAIMER_SHORT } from "@/lib/disclaimer";
import { sentence, speakAmount, speakProfit } from "@/lib/a11y";
import {
  asOfMs,
  asOfVariants,
  assetLine,
  excludedCount,
  failureText,
  HOME_URI,
  indexItems,
  indexSpeech,
  isHeld,
  pnlLine,
  pnlSpeech,
  rowSpeech,
  tone,
  widgetOrder,
  type IndexItemText,
  type PnlLine,
  type PnlMode,
} from "./model";
import { currentMarket, isDelayed, openMarketAsOf, type WidgetIndex, type WidgetMarket } from "./payload";
import { EMPTY_LINES, PAD, planAsset, planBriefing, planHoldings, textWidth, type HeaderPlan, type IndexPlan, type RowInput, type RowsPlan, type TotalPlan } from "./layout";
import { space } from "@/tokens";
import { CHIP_RADIUS, WIDGET_COLORS, WIDGET_FONT as F, WIDGET_RADIUS, WIDGET_TOUCH as TOUCH, type WidgetPalette } from "./palette";

export { totals, type Totals } from "@/lib/portfolio";

/**
 * 홈 화면 위젯 3종. react-native-android-widget 프리미티브만 쓴다(RN 컴포넌트 불가, 색은 hex/rgba 문자열).
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

export const WIDGET_NAMES = { holdings: "Holdings", briefing: "Briefing", asset: "Asset" } as const;

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

/** 장 상태 칩 (장중은 금색, 그 밖은 회색). 없을 때는 부르는 쪽에서 넣지 않는다 */
function Chip({ market, c }: { market: WidgetMarket; c: WidgetPalette }) {
  return (
    <FlexWidget style={{ borderRadius: CHIP_RADIUS, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderWidth: 1, borderColor: market.open ? c.gold : c.line }}>
      <TextWidget text={market.label} maxLines={1} style={{ color: market.open ? c.gold : c.muted, fontSize: F.xs, fontWeight: "700" }} />
    </FlexWidget>
  );
}

/**
 * 머리 줄 (48dp): 왼쪽 묶음을 누르면 잔고 탭으로, 오른쪽 ↻ 칸(48×48dp)은 새로고침.
 * 갱신 중이면 기준 시각 자리에 "갱신 중"
 */
function Header({ title, plan, market, refreshing, label, c }: { title: string; plan: HeaderPlan; market: WidgetMarket | null; refreshing: boolean; label: string; c: WidgetPalette }) {
  return (
    <FlexWidget style={{ width: "match_parent", height: TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <FlexWidget clickAction="OPEN_URI" clickActionData={{ uri: HOME_URI }} accessibilityLabel={label} style={{ height: TOUCH, flexDirection: "row", alignItems: "center", flexGap: space.s }}>
        <TextWidget text={title} maxLines={1} style={{ color: c.ink, fontSize: F.title, fontWeight: "700" }} />
        {plan.chip && market ? <Chip market={market} c={c} /> : null}
        {plan.sub ? <TextWidget text={plan.sub} maxLines={1} style={{ color: refreshing ? c.accent : c.muted, fontSize: F.sm }} /> : null}
        {plan.delayed ? <TextWidget text="지연" maxLines={1} style={{ color: c.warn, fontSize: F.sm, fontWeight: "700" }} /> : null}
      </FlexWidget>
      <FlexWidget
        clickAction={WIDGET_CLICK.refresh}
        accessibilityLabel={refreshing ? "갱신 중" : "새로 고침"}
        style={{ width: TOUCH, height: TOUCH, flexDirection: "column", alignItems: "center", justifyContent: "center" }}
      >
        <TextWidget text="↻" style={{ color: refreshing ? c.accent : c.muted, fontSize: F.icon }} />
      </FlexWidget>
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
}

interface RowView extends RowInput {
  code: string;
  hasQuote: boolean;
  change: number;
  subColor: `#${string}`;
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
  return {
    code: s.code,
    name: s.name,
    price,
    rate: q ? formatPct(q.changeRate) : null,
    subs: [...new Set(subs)],
    hasQuote: !!q,
    change: q?.change ?? 0,
    subColor: ev ? tone(ev.profit, c) : c.muted,
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

/** 지수 한 항목: 이름(회색) 값 등락률(등락색). 출처 조회가 실패한 항목은 모두 회색 + "지연" */
function indexNodes(it: IndexItemText, first: boolean, font: number, c: WidgetPalette): React.JSX.Element[] {
  const color = it.stale ? c.muted : tone(it.change, c);
  const out: React.JSX.Element[] = [];
  if (!first) out.push(<TextWidget key={`${it.code}-sep`} text="·" style={{ color: c.muted, fontSize: font }} />);
  out.push(<TextWidget key={`${it.code}-label`} text={it.label} maxLines={1} style={{ color: c.muted, fontSize: font }} />);
  out.push(<TextWidget key={`${it.code}-value`} text={it.value} maxLines={1} style={{ color, fontSize: font, fontWeight: "700" }} />);
  if (it.rate) out.push(<TextWidget key={`${it.code}-rate`} text={it.rate} maxLines={1} style={{ color, fontSize: font, fontWeight: "700" }} />);
  if (it.stale) out.push(<TextWidget key={`${it.code}-stale`} text="지연" maxLines={1} style={{ color: c.muted, fontSize: font }} />);
  return out;
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
  const price = <TextWidget text={r.price} maxLines={1} style={{ color, fontSize: F.base, fontWeight: "700" }} />;
  const rate = <TextWidget text={r.rate ?? "-"} maxLines={1} style={{ color, fontSize: F.md, fontWeight: "700", width: rows.rateW, textAlign: "right" }} />;
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

export function HoldingsWidget(props: StockWidgetProps & WidgetFrame & HoldingsExtra) {
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
                  {subText ? <TextWidget text={subText} maxLines={1} style={{ color: r.subColor, fontSize: plan.rows.subFont }} /> : null}
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

/** 브리핑: 서버가 고른 보유 비중 상위 3종목(예전 서버면 최신 3개)의 요약 첫 줄 + 고지 한 줄 (항상) */
export function BriefingWidget(props: { briefings: LatestBriefing[]; fetchedAt: number; error: string | null; now: number; market?: WidgetMarket | null; refreshing?: boolean } & WidgetFrame) {
  const { briefings, fetchedAt, error, now } = props;
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
  return (
    <FlexWidget style={listRootStyle(c)}>
      <Header title="브리핑" plan={plan.header} market={market} refreshing={refreshing} label={headerLabel} c={c} />
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
      ) : refreshing ? null : (
        <TextWidget
          text={error ? `${failureText(error)} · ↻ 로 다시 시도` : "아직 브리핑이 없습니다. 평일 08:30·16:00 에 생성됩니다."}
          maxLines={plan.messageLines}
          style={{ color: c.muted, fontSize: F.md, marginTop: plan.messageGap, marginRight: PAD }}
        />
      )}
      <TextWidget text={DISCLAIMER_SHORT} maxLines={1} style={{ color: c.muted, fontSize: F.xs, marginTop: space.xs, marginRight: PAD }} />
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
