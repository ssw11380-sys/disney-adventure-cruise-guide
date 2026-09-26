import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { ClipPath, Defs, G, Line, Path, Rect, Svg, Text as SvgText } from "react-native-svg";
import type { Candle, CandlePeriod, ChartUnit } from "@/api/types";
import { AXIS_GAP_R, axisWidth, fitAxisWidth, LABEL_PAD, placeInsideLabels, priceDomain, readoutBasis, volumeBars, type InsideLabel, type LabelSpot } from "@/lib/chartBasis";
import { formatChartValue, maLegendItems } from "@/lib/chartLayout";
import { formatPct, formatVolume, shownSign } from "@/lib/format";
import { bollinger, macd, niceTicks, rsi, sma, type Series } from "@/lib/indicators";
import { changeColor, font, radius, space, useFontScale, useTheme, type Theme } from "@/theme";

/**
 * 직접 그리는 캔들 차트 (react-native-svg + gesture-handler).
 *  - 오른쪽 가격 축·아래 날짜 축, 거래량 pane, 선택한 보조지표 pane(RSI/MACD)
 *  - 이동평균·볼린저 오버레이, 내 평단선·현재가선·52주 고/저 표시(축에 태그)
 *  - 한 손가락 가로 드래그 = 과거/최신 이동(세로로 먼저 움직이면 화면 스크롤 — chartPanConfig), 두 손가락 = 확대/축소,
 *    길게 누른 뒤 드래그 = 십자선(시·고·저·종·거래량 읽기)
 *  - 부모가 전체 시계열과 보이는 구간(count, offset)을 들고 있고, 여기서는 그리기와 제스처만 담당
 */

/** 이동평균선 색 (테마의 차트 색 — 상승·하락색과 겹치지 않게 고른 값, 3-20) */
export function maColor(t: Theme, period: number): string {
  return t.chart.ma[period] ?? t.muted;
}
export type IndicatorKind = "none" | "rsi" | "macd";

export interface ChartView {
  count: number; // 보이는 봉 수
  offset: number; // 최신에서 몇 봉 앞으로 갔는지
}

export interface PriceChartProps {
  candles: Candle[];
  period: CandlePeriod;
  /** 값 단위: KRW·USD 통화, PT = 지수·환율(소수 둘째 자리) */
  currency: ChartUnit;
  width: number;
  height: number;
  view: ChartView;
  onViewChange: (v: ChartView) => void;
  maPeriods: number[];
  showBollinger: boolean;
  /** 차트 아래 이동평균 값 줄 (전체 화면은 끔 — 칩 색으로 구분) */
  showMaValues?: boolean;
  /**
   * 이동평균 값 줄을 항목('■ 120일 77,120원') 단위로 줄바꿈 (폴드 진단 24번 — 넓은 창만, CandleChart 가 정한다).
   * 끄면(기본 — 휴대폰·접힌 화면·플래그 꺼짐) 3-42 이전과 똑같은 한 줄 글자 (사용자 결정 '접은 화면은 지금 그대로')
   */
  maItems?: boolean;
  showVolume: boolean;
  /** 거래량이 없는 시계열(환율)이면 false: 읽기 줄에서 거래량을 뺀다 */
  hasVolume?: boolean;
  indicator: IndicatorKind;
  avgPrice?: number | null;
  currentPrice?: number | null;
  prevClose?: number | null;
  /** 전일 종가(prevClose)가 기준인 거래일 (YYYY-MM-DD). 마지막 봉 날짜와 다르면 읽기 줄은 직전 봉 종가를 쓴다 */
  latestDate?: string | null;
  high52w?: number | null;
  low52w?: number | null;
  /** 십자선이 잡은 봉 (부모가 헤더에 쓰고 싶을 때) */
  onCrosshair?: (c: Candle | null) => void;
  minCount?: number;
  maxCount?: number;
  /** 차트 뒤 바탕색 (그림 안 평단·52주 글자의 바탕 상자를 이 색으로 옅게 깐다). 기본 패널 색 t.surface */
  labelBg?: string;
  /**
   * 맞춘 가격 축 (기능 플래그 detailPolish — CandleChart 가 정한다): 축 글자를 그림 오른쪽 끝에 붙여 오른쪽 맞춤으로 적고,
   * 축 칸은 가장 긴 글자 + 좌우 틈(4·2)만큼 → 축 글자 오른쪽에 빈 띠가 없다 (lib/chartBasis fitAxisWidth).
   * 끄면 예전 그대로 (축 칸 왼쪽 + 4 에 왼쪽 맞춤, 넉넉한 어림 — 오른쪽에 약 8dp 빈칸)
   */
  fitAxis?: boolean;
}

const X_AXIS_H = 18;
const PANE_GAP = 6;
/** 그림 안 글자 바탕 상자의 불투명도 (바탕색 토큰 위에 옅게 — 뒤의 봉·선이 살짝 비친다) */
const LABEL_BG_OPACITY = 0.85;
/** 예전 가격 축 글자 x (축 칸 왼쪽에서 띄우는 거리, 왼쪽 맞춤) */
const AXIS_TEXT_X = 4;
/**
 * 한 손가락 드래그(과거/최신 이동) 제스처가 시작되는 조건 (2026-09-26 RGTX 캡처 '120일 · 2일 전' — 세로로 스크롤하던 손가락이
 * 옆으로 조금 흔들리면 차트가 과거로 옮겨졌다. 예전에는 어느 쪽으로든 8dp 만 움직이면 시작했다):
 *  - 가로로 activeX(14dp) 이상 움직여야 시작
 *  - 그 전에 세로로 failY(10dp) 이상 움직이면 드래그를 포기 → 화면 스크롤이 가져간다
 * 시작하는 순간까지 움직인 거리(14dp)는 이동에 넣지 않는다 (시작할 때 봉 몇 개가 한꺼번에 튀지 않게 — 안드로이드 스크롤과 같은 방식).
 * 두 손가락 확대·축소와 길게 누른 뒤 십자선은 그대로
 */
export const chartPanConfig = { activeX: 14, failY: 10 } as const;
/**
 * 가격 칸 아래로 글자 상자가 넘어가도 되는 폭 (오늘 52주 신저가 — 52주 최저선이 바닥에 붙고 현재가선이 바로 위에 있으면 선 아래가 유일한 자리):
 * 아래에 거래량·지표 칸이 있으면 칸 사이 틈(6)을 지나 그 칸 맨 위 2 까지(칸 이름 '거래량'·'RSI' 는 왼쪽 끝, 최댓값은 축에 있다),
 * 날짜 줄뿐이면 날짜 글자 위까지
 */
const LABEL_SLACK_PANE = PANE_GAP + 2;
const LABEL_SLACK_AXIS = 5;
/** 가장자리 고정 글자(범위 밖 평단 · 벗어난 이동평균)의 기준선: 맨 위는 위에서 12, 맨 아래는 아래에서 4 */
const EDGE_TOP_Y = 12;
const EDGE_BOTTOM_Y = 4;
/** 벗어난 이동평균 표시 앞의 색 네모 (칩의 색 줄과 같은 모양): 폭 8 · 높이 3, 글자와 3 띄움 */
const MA_SWATCH_W = 8;
const MA_SWATCH_H = 3;
const MA_SWATCH_GAP = 3;

export function clampView(v: ChartView, total: number, minCount = 15, maxCount = 500): ChartView {
  const count = Math.max(minCount, Math.min(maxCount, Math.min(v.count, Math.max(total, minCount))));
  const offset = Math.max(0, Math.min(v.offset, Math.max(total - count, 0)));
  return { count, offset };
}

/** 축·태그 값. PT 는 digits(눈금 간격에 맞춘 소수 자리, 없으면 2) */
function axisPrice(v: number, currency: ChartUnit, digits?: number): string {
  if (currency === "PT") {
    const d = digits ?? 2;
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  if (currency === "USD") return v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2);
  return Math.round(v).toLocaleString("ko-KR");
}

/** 읽기 줄의 값 (통화는 원·달러 표기, PT 는 소수 둘째 자리). 순수 함수는 lib/chartLayout 에 있다 */
export { formatChartValue };

function labelOf(c: Candle, period: CandlePeriod, prev: Candle | undefined, dense: boolean): string {
  if (c.time) {
    const hm = c.time.slice(11, 16);
    const newDay = !prev || prev.date !== c.date;
    return newDay ? `${c.date.slice(5).replace("-", "/")} ${hm}` : hm;
  }
  if (period === "M" || dense) return `${c.date.slice(2, 4)}.${c.date.slice(5, 7)}`;
  return `${c.date.slice(5, 7)}.${c.date.slice(8, 10)}`;
}

export function PriceChart(p: PriceChartProps) {
  const t = useTheme();
  const { candles, width, height, currency } = p;
  const total = candles.length;
  const view = clampView(p.view, total, p.minCount, p.maxCount);
  const end = total - view.offset;
  const start = Math.max(end - view.count, 0);
  const visible = useMemo(() => candles.slice(start, end), [candles, start, end]);
  const n = visible.length;

  const volH = p.showVolume ? Math.round(height * 0.16) : 0;
  const indH = p.indicator === "none" ? 0 : Math.round(height * 0.2);
  const priceH = height - X_AXIS_H - volH - indH - (volH ? PANE_GAP : 0) - (indH ? PANE_GAP : 0);
  const volTop = priceH + PANE_GAP;
  const indTop = volTop + volH + (volH ? PANE_GAP : 0);
  // 가격 칸은 그림 맨 위부터 (과거 구간 안내는 차트 위 조작 줄에 있어 가격 칸을 줄이지 않는다 — 안내가 생길 때 축이 튀지 않게, 2026-09-26)
  // 가격 칸 자르기 틀 id: 차트마다 따로 (웹은 id 가 문서 전체에서 하나라, 상세 위에 전체 화면 차트가 올라오면 앞 차트의 틀 크기로 잘렸다)
  const clipId = `priceClip${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  // ── 지표 (전체 시계열로 계산해 구간 첫 봉부터 선이 보이게) ──
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const mas = useMemo(() => p.maPeriods.map((per) => ({ period: per, values: sma(closes, per) })), [closes, p.maPeriods]);
  const bb = useMemo(() => (p.showBollinger ? bollinger(closes, 20, 2) : null), [closes, p.showBollinger]);
  const rsiS = useMemo(() => (p.indicator === "rsi" ? rsi(closes, 14) : null), [closes, p.indicator]);
  const macdS = useMemo(() => (p.indicator === "macd" ? macd(closes) : null), [closes, p.indicator]);

  // ── 가격 도메인 (lib/chartBasis priceDomain) ──
  // 봉 + 현재가(최신 구간일 때) + 평단(±25% 안쪽)으로 정하고, 이동평균·볼린저 선은 그 범위에서 조금(LINE_OVERSHOOT)까지만 넓힌다.
  // 넘는 선은 가격 칸에서 잘라 그린다 (아래 ClipPath) — 크게 떨어진 종목의 120일선 옛 값이 봉을 차트 바닥에 눌러 두지 않게
  const domain = useMemo<[number, number]>(() => {
    const lines: Series[] = [...mas.map((m) => m.values.slice(start, end)), ...(bb ? [bb.upper.slice(start, end), bb.lower.slice(start, end)] : [])];
    return priceDomain({ bars: visible, lines, current: view.offset === 0 ? p.currentPrice : null, avg: p.avgPrice });
  }, [visible, mas, bb, start, end, p.currentPrice, p.avgPrice, view.offset]);

  const priceTicks = useMemo(() => niceTicks(domain[0], domain[1], 5).filter((v) => v > domain[0] && v < domain[1]), [domain]);
  // 지수·환율 축 눈금: 간격이 1 미만이면 소수 자리를 늘린다 (원/위안 201.5, 201.6 …)
  const tickStep = priceTicks.length > 1 ? priceTicks[1]! - priceTicks[0]! : 1;
  const tickDigits = tickStep >= 1 ? 0 : tickStep >= 0.1 ? 1 : 2;
  const maxVol = useMemo(() => (p.showVolume ? Math.max(1, ...visible.map((c) => c.volume)) : 1), [visible, p.showVolume]);
  // 오른쪽 가격 축 폭은 눈금·현재가·십자선 값·거래량 최대값 중 가장 긴 글자에 맞춘다 (고정 폭이면 짧은 값에서 빈칸, 긴 값은 잘림).
  // 맞춘 축(fitAxis — detailPolish)은 글자를 그림 오른쪽 끝에 붙여 오른쪽 맞춤, 칸은 가장 긴 글자 + 좌우 틈만큼 (lib/chartBasis fitAxisWidth)
  const axisLabels = [
    ...priceTicks.map((v) => axisPrice(v, currency, tickDigits)),
    axisPrice(domain[1], currency),
    axisPrice(domain[0], currency),
    p.currentPrice ? axisPrice(p.currentPrice, currency) : "",
    p.showVolume ? formatVolume(maxVol) : "",
  ];
  const fit = !!p.fitAxis;
  const axisW = fit ? fitAxisWidth(axisLabels) : axisWidth(axisLabels);
  const plotW = Math.max(width - axisW, 10);
  // 축 글자 자리: 예전은 축 칸 왼쪽 + 4 에 왼쪽 맞춤, 맞춘 축은 그림 오른쪽 끝 − 2 에 오른쪽 맞춤
  const axisText = fit ? { x: plotW + axisW - AXIS_GAP_R, textAnchor: "end" as const } : { x: plotW + AXIS_TEXT_X, textAnchor: "start" as const };
  const step = n ? plotW / n : plotW;
  const bodyW = Math.max(1, Math.min(step * 0.7, 14));

  const yOf = useCallback((v: number) => priceH - ((v - domain[0]) / (domain[1] - domain[0])) * priceH, [domain, priceH]);
  const xOf = useCallback((i: number) => i * step + step / 2, [step]);
  // 보이는 봉의 상자 (그림 안 글자가 봉을 가리지 않는 자리를 고를 때)
  const barBoxes = useMemo(() => visible.map((c, i) => ({ left: xOf(i) - bodyW / 2, right: xOf(i) + bodyW / 2, top: yOf(c.high), bottom: yOf(c.low) })), [visible, xOf, yOf, bodyW]);

  // ── 캔들 path (상승/하락 각각 몸통·꼬리 하나의 path 로) ──
  const candlePaths = useMemo(() => {
    let upBody = "", upWick = "", downBody = "", downWick = "";
    for (let i = 0; i < n; i++) {
      const c = visible[i]!;
      const x = xOf(i);
      const up = c.close >= c.open;
      const yo = yOf(c.open), yc = yOf(c.close), yh = yOf(c.high), yl = yOf(c.low);
      const top = Math.min(yo, yc);
      const h = Math.max(Math.abs(yo - yc), 1);
      const body = `M${(x - bodyW / 2).toFixed(1)} ${top.toFixed(1)}h${bodyW.toFixed(1)}v${h.toFixed(1)}h${(-bodyW).toFixed(1)}z`;
      const wick = `M${x.toFixed(1)} ${yh.toFixed(1)}V${yl.toFixed(1)}`;
      if (up) {
        upBody += body;
        upWick += wick;
      } else {
        downBody += body;
        downWick += wick;
      }
    }
    return { upBody, upWick, downBody, downWick };
  }, [visible, n, xOf, yOf, bodyW]);

  const linePath = useCallback(
    (s: Series, y: (v: number) => number) => {
      let d = "";
      let pen = false;
      for (let i = start; i < end; i++) {
        const v = s[i];
        if (v === null || v === undefined) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${xOf(i - start).toFixed(1)} ${y(v).toFixed(1)}`;
        pen = true;
      }
      return d;
    },
    [start, end, xOf],
  );

  const xTicks = useMemo(() => {
    if (n === 0) return [] as { i: number; label: string }[];
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
    const out: { i: number; label: string }[] = [];
    for (let i = n - 1; i >= 0; i -= every) out.push({ i, label: labelOf(visible[i]!, p.period, visible[i - 1], n > 200) });
    return out.reverse();
  }, [visible, n, plotW, p.period]);

  // 거래량을 모르는 임시 봉(실시간 체결로 만든 봉)은 0 처럼 비워 두지 않고 점선 빈 막대로 (PF-04)
  const volPaths = useMemo(
    () => (p.showVolume ? volumeBars(visible, { maxVol, top: volTop, height: volH, barW: bodyW, xOf }) : null),
    [visible, maxVol, volH, volTop, xOf, bodyW, p.showVolume],
  );

  // ── 보조지표 pane ──
  const indScale = useMemo(() => {
    if (p.indicator === "rsi") return { lo: 0, hi: 100 };
    if (p.indicator === "macd" && macdS) {
      let lo = 0, hi = 0;
      for (let i = start; i < end; i++) for (const s of [macdS.macd, macdS.signal, macdS.hist]) {
        const v = s[i];
        if (v !== null && v !== undefined) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      const pad = (hi - lo) * 0.1 || 1;
      return { lo: lo - pad, hi: hi + pad };
    }
    return { lo: 0, hi: 1 };
  }, [p.indicator, macdS, start, end]);
  const yInd = useCallback((v: number) => indTop + indH - ((v - indScale.lo) / (indScale.hi - indScale.lo)) * indH, [indTop, indH, indScale]);

  // ── 십자선 ──
  // 구간(start~end)이 바뀌면 인덱스가 어긋나므로 그 구간에서 찍은 십자선만 유효하다
  const [crossState, setCross] = useState<{ i: number; y: number; start: number; end: number } | null>(null);
  const cross = crossState && crossState.start === start && crossState.end === end ? crossState : null;
  const crossCandle = cross ? visible[cross.i] : undefined;
  const setCrossAt = useCallback(
    (x: number, y: number) => {
      if (n === 0) return;
      const i = Math.max(0, Math.min(n - 1, Math.floor(x / step)));
      setCross((prev) => (prev && prev.i === i && Math.abs(prev.y - y) < 1 ? prev : { i, y: Math.max(0, Math.min(priceH, y)), start, end }));
    },
    [n, step, priceH, start, end],
  );
  const onCrosshair = p.onCrosshair;
  useEffect(() => {
    onCrosshair?.(crossCandle ?? null);
  }, [crossCandle, onCrosshair]);

  // ── 제스처 ──
  // 제스처 콜백은 터치 이벤트 때 최신 값(view·step·콜백)을 읽어야 해서 ref 상자에 두고 effect 에서 갱신한다.
  // 제스처 객체 자체는 한 번만 만든다(렌더마다 새로 만들면 진행 중인 드래그가 끊긴다). 아래 콜백은 렌더 중 실행되지 않으므로
  // "렌더 중 ref 접근" 규칙의 예외로 둔다.
  const onViewChange = p.onViewChange;
  const minCount = p.minCount ?? 15, maxCount = p.maxCount ?? 500;
  const ctx = useRef({ view, start: view, tx0: 0, step, total, minCount, maxCount, onViewChange, setCrossAt, clear: () => setCross(null) });
  useEffect(() => {
    ctx.current = { ...ctx.current, view, step, total, minCount, maxCount, onViewChange, setCrossAt };
  }, [view, step, total, minCount, maxCount, onViewChange, setCrossAt]);
  /* eslint-disable react-hooks/refs */
  const gesture = useMemo(() => {
    // 한 손가락 드래그: 가로로 14dp 움직여야 시작, 그 전에 세로로 10dp 움직이면 포기 (chartPanConfig — 세로 스크롤 중 차트가 옮겨지지 않게)
    const scroll = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-chartPanConfig.activeX, chartPanConfig.activeX])
      .failOffsetY([-chartPanConfig.failY, chartPanConfig.failY])
      .maxPointers(1)
      .onStart((e) => {
        // 시작하는 순간의 구간·손가락 위치에서부터 옮긴다 (시작 조건 14dp 만큼 봉이 한꺼번에 튀지 않게)
        ctx.current.start = ctx.current.view;
        ctx.current.tx0 = e.translationX;
      })
      .onUpdate((e) => {
        const c = ctx.current;
        const next = clampView({ count: c.start.count, offset: c.start.offset + Math.round((e.translationX - c.tx0) / c.step) }, c.total, c.minCount, c.maxCount);
        if (next.offset !== c.view.offset) {
          c.view = next;
          c.onViewChange(next);
        }
      });
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onBegin(() => {
        ctx.current.start = ctx.current.view;
      })
      .onUpdate((e) => {
        const c = ctx.current;
        const count = Math.round(c.start.count / Math.max(e.scale, 0.05));
        // 오른쪽(최신) 가장자리를 고정한 채 확대/축소
        const next = clampView({ count, offset: c.start.offset }, c.total, c.minCount, c.maxCount);
        if (next.count !== c.view.count) {
          c.view = next;
          c.onViewChange(next);
        }
      });
    const crosshair = Gesture.Pan()
      .runOnJS(true)
      .activateAfterLongPress(220)
      .maxPointers(1)
      .onStart((e) => {
        void Haptics.selectionAsync();
        ctx.current.setCrossAt(e.x, e.y);
      })
      .onUpdate((e) => ctx.current.setCrossAt(e.x, e.y));
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd(() => ctx.current.clear());
    return Gesture.Race(crosshair, Gesture.Simultaneous(pinch, scroll), tap);
  }, []);
  /* eslint-enable react-hooks/refs */

  const upColor = t.up, downColor = t.down;
  const last = visible[n - 1];
  const showCurrent = p.currentPrice !== null && p.currentPrice !== undefined && view.offset === 0 && p.currentPrice > domain[0] && p.currentPrice < domain[1];
  const avgIn = p.avgPrice !== null && p.avgPrice !== undefined && p.avgPrice > domain[0] && p.avgPrice < domain[1];
  const avgOut = p.avgPrice !== null && p.avgPrice !== undefined && !avgIn ? (p.avgPrice >= domain[1] ? "above" : "below") : null;
  // 보합(0)은 앱 전체와 같은 기본 글자색 (예전에는 현재가 태그만 빨강)
  const curColor = p.prevClose && p.currentPrice ? changeColor(t, p.currentPrice - p.prevClose) : t.accent;
  const isLatest = cross ? start + cross.i === total - 1 : view.offset === 0;
  const high52In = !!p.high52w && p.high52w > domain[0] && p.high52w < domain[1];
  const low52In = !!p.low52w && p.low52w > domain[0] && p.low52w < domain[1];
  const currentY = showCurrent ? yOf(p.currentPrice!) : null;
  // 보이는 구간 내내 가격 칸 위(또는 아래)로 벗어난 이동평균: 선이 칸 가장자리에서 잘려 하나도 안 보인다 → 가장자리에 '120일선(범위 위)' 표시.
  // 칩은 켜져 있고 차트 아래 값 줄에도 값이 있는데 선만 없어 고장처럼 보이지 않게 (크게 떨어진 종목을 확대했을 때 — RGTX)
  const maWord = p.period === "W" ? "주" : p.period === "M" ? "월" : p.period === "D" ? "일" : "봉";
  const maOff = useMemo(() => {
    const out: { period: number; side: "above" | "below" }[] = [];
    for (const m of mas) {
      let count = 0, above = 0, below = 0;
      for (let i = start; i < end; i++) {
        const v = m.values[i];
        if (v === null || v === undefined) continue;
        count++;
        if (v >= domain[1]) above++;
        else if (v <= domain[0]) below++;
      }
      if (count && above === count) out.push({ period: m.period, side: "above" });
      else if (count && below === count) out.push({ period: m.period, side: "below" });
    }
    return out;
  }, [mas, start, end, domain]);
  // 그림 안 글자(평단 → 52주 최고 → 52주 최저 → 벗어난 이동평균) 자리 (lib/chartBasis placeInsideLabels): 선 위·아래를 가로로 훑어
  // 봉·다른 글자·현재가선을 가리지 않는 곳, 최신 봉은 특히 덮지 않는다. 마땅한 자리가 없으면 글자를 빼고 선만 (평단은 늘 적는다).
  // 범위 밖 평단·벗어난 이동평균은 선 없이 맨 위·맨 아래 가장자리 글자 (가로로만 옮긴다)
  const inside = useMemo(() => {
    const want: (InsideLabel & { key: string; ma?: number })[] = [];
    if (avgIn) want.push({ key: "avg", y: yOf(p.avgPrice!), text: `평단 ${axisPrice(p.avgPrice!, currency)}`, prefer: "left", keep: true });
    else if (avgOut)
      want.push({
        key: "avg",
        y: avgOut === "above" ? EDGE_TOP_Y : priceH - EDGE_BOTTOM_Y,
        text: `${avgOut === "above" ? "평단(범위 위)" : "평단(범위 아래)"} ${axisPrice(p.avgPrice!, currency)}`,
        prefer: "left",
        fixed: true,
        keep: true,
      });
    if (high52In) want.push({ key: "h52", y: yOf(p.high52w!), text: "52주 최고", prefer: "right" });
    if (low52In) want.push({ key: "l52", y: yOf(p.low52w!), text: "52주 최저", prefer: "right" });
    for (const m of maOff)
      want.push({
        key: `ma${m.period}`,
        ma: m.period,
        y: m.side === "above" ? EDGE_TOP_Y : priceH - EDGE_BOTTOM_Y,
        text: `${m.period}${maWord}선(범위 ${m.side === "above" ? "위" : "아래"})`,
        prefer: "right",
        fixed: true,
        lead: MA_SWATCH_W + MA_SWATCH_GAP,
      });
    if (!want.length) return [];
    // 글자 상자는 가격 칸 아래 틈까지 (오늘 52주 신저가 — 선이 바닥에 붙어도 현재가선을 끊지 않고 선 아래에)
    const placed = placeInsideLabels({
      plotW,
      plotH: priceH,
      bottomSlack: volH || indH ? LABEL_SLACK_PANE : LABEL_SLACK_AXIS,
      bars: barBoxes,
      labels: want,
      lines: currentY === null ? [] : [currentY],
    });
    return want.flatMap((w, i) => (placed[i] ? [{ key: w.key, ma: w.ma, text: w.text, spot: placed[i]! }] : []));
  }, [avgIn, avgOut, high52In, low52In, p.avgPrice, p.high52w, p.low52w, maOff, maWord, yOf, priceH, volH, indH, plotW, barBoxes, currentY, currency]);
  const labelBg = p.labelBg ?? t.surface;

  return (
    <View style={{ width, gap: space.xs }}>
      <Readout
        candle={crossCandle}
        prev={cross ? visible[cross.i - 1] ?? candles[start + cross.i - 1] : visible[n - 2] ?? candles[end - 2]}
        latestBase={p.period === "D" ? p.prevClose : null}
        latestDate={p.latestDate}
        isLatest={isLatest}
        last={last}
        currency={currency}
        period={p.period}
        showVolume={p.hasVolume !== false}
        part={p.showMaValues === false ? "all" : "top"}
      />
      <GestureDetector gesture={gesture}>
        <View style={{ width, height }} collapsable={false}>
          <Svg width={width} height={height}>
            <Defs>
              <ClipPath id={clipId}>
                <Rect x={0} y={0} width={plotW} height={priceH} />
              </ClipPath>
            </Defs>
            {/* 가격 눈금 */}
            {priceTicks.map((v) => (
              <React.Fragment key={v}>
                <Line x1={0} x2={plotW} y1={yOf(v)} y2={yOf(v)} stroke={t.line} strokeWidth={StyleSheet.hairlineWidth} />
                {/* 현재가 태그에 가려지거나 맨 위에 붙어 잘리는 눈금 숫자는 그리지 않는다 */}
                {(showCurrent && Math.abs(yOf(v) - yOf(p.currentPrice!)) < 13) || yOf(v) < 5 ? null : (
                  <SvgText {...axisText} y={yOf(v) + 3.5} fill={t.muted} fontSize={font.tiny}>
                    {axisPrice(v, currency, tickDigits)}
                  </SvgText>
                )}
              </React.Fragment>
            ))}
            {/* 가격 칸 안에만 그리는 것 (선이 축 범위를 넘으면 칸 가장자리에서 잘린다 — 거래량 칸·날짜 줄로 나가지 않게) */}
            <G clipPath={`url(#${clipId})`}>
              {/* 볼린저 */}
              {bb ? (
                <>
                  <Path d={`${linePath(bb.upper, yOf)}${reversePath(linePath(bb.lower, yOf))}Z`} fill={t.chart.band} fillOpacity={0.07} />
                  <Path d={linePath(bb.upper, yOf)} stroke={t.chart.band} strokeOpacity={0.6} strokeWidth={1} fill="none" />
                  <Path d={linePath(bb.lower, yOf)} stroke={t.chart.band} strokeOpacity={0.6} strokeWidth={1} fill="none" />
                </>
              ) : null}
              {/* 캔들 */}
              <Path d={candlePaths.upWick} stroke={upColor} strokeWidth={1} />
              <Path d={candlePaths.downWick} stroke={downColor} strokeWidth={1} />
              <Path d={candlePaths.upBody} fill={upColor} />
              <Path d={candlePaths.downBody} fill={downColor} />
              {/* 이동평균 */}
              {mas.map((m) => (
                <Path key={m.period} d={linePath(m.values, yOf)} stroke={maColor(t, m.period)} strokeWidth={1.2} fill="none" />
              ))}
            </G>
            {/* 52주 고/저 · 평단 · 현재가 선 (글자는 선을 모두 그린 뒤에 — 다른 선이 글자를 가로지르지 않게) */}
            {high52In ? <Tag y={yOf(p.high52w!)} plotW={plotW} axisW={axisW} color={t.muted} dotted /> : null}
            {low52In ? <Tag y={yOf(p.low52w!)} plotW={plotW} axisW={axisW} color={t.muted} dotted /> : null}
            {avgIn ? <Tag y={yOf(p.avgPrice!)} plotW={plotW} axisW={axisW} color={t.gold} dashed /> : null}
            {showCurrent ? <Tag y={yOf(p.currentPrice!)} plotW={plotW} axisW={axisW} label={axisPrice(p.currentPrice!, currency)} labelAt={axisText} color={curColor} dashed filled /> : null}
            {/* 그림 안 글자 (평단 · 52주 · 벗어난 이동평균): 봉·서로·현재가선을 가리지 않는 자리에 옅은 바탕 상자와 함께 (inside).
                평단 글자는 오른쪽 축이 아니라 그림 안 선 곁에 적는다 → 축 폭에 잘리거나 현재가 태그와 겹치지 않는다 */}
            {inside.map((l) => (
              <LabelText
                key={l.key}
                spot={l.spot}
                label={l.text}
                color={l.key === "avg" ? t.gold : t.muted}
                bg={labelBg}
                bold={l.key === "avg" && avgIn}
                swatch={l.ma !== undefined ? maColor(t, l.ma) : undefined}
              />
            ))}
            {/* 거래량 */}
            {volPaths ? (
              <>
                <Path d={volPaths.up} fill={upColor} fillOpacity={0.55} />
                <Path d={volPaths.down} fill={downColor} fillOpacity={0.55} />
                {volPaths.unknown ? <Path d={volPaths.unknown} stroke={t.muted} strokeWidth={1} strokeDasharray="2 2" fill="none" /> : null}
                <SvgText {...axisText} y={volTop + 9} fill={t.muted} fontSize={font.tiny}>
                  {formatVolume(maxVol)}
                </SvgText>
                <SvgText x={2} y={volTop + 9} fill={t.muted} fontSize={font.tiny}>
                  거래량
                </SvgText>
              </>
            ) : null}
            {/* RSI */}
            {rsiS ? (
              <>
                {[30, 70].map((v) => (
                  <Line key={v} x1={0} x2={plotW} y1={yInd(v)} y2={yInd(v)} stroke={t.line} strokeDasharray="3 3" />
                ))}
                <Path d={linePath(rsiS, yInd)} stroke={t.chart.rsi} strokeWidth={1.2} fill="none" />
                <SvgText x={2} y={indTop + 9} fill={t.muted} fontSize={font.tiny}>
                  RSI(14) {fmtNum(rsiS[end - 1], 1)}
                </SvgText>
                {[30, 70].map((v) => (
                  <SvgText key={v} {...axisText} y={yInd(v) + 3} fill={t.muted} fontSize={font.tiny}>
                    {v}
                  </SvgText>
                ))}
              </>
            ) : null}
            {/* MACD */}
            {macdS ? (
              <>
                <Line x1={0} x2={plotW} y1={yInd(0)} y2={yInd(0)} stroke={t.line} />
                {(() => {
                  let up = "", down = "";
                  for (let i = start; i < end; i++) {
                    const v = macdS.hist[i];
                    if (v === null || v === undefined) continue;
                    const y0 = yInd(0), y1 = yInd(v);
                    const d = `M${(xOf(i - start) - bodyW / 2).toFixed(1)} ${Math.min(y0, y1).toFixed(1)}h${bodyW.toFixed(1)}v${Math.max(Math.abs(y1 - y0), 0.5).toFixed(1)}h${(-bodyW).toFixed(1)}z`;
                    if (v >= 0) up += d;
                    else down += d;
                  }
                  return (
                    <>
                      <Path d={up} fill={upColor} fillOpacity={0.5} />
                      <Path d={down} fill={downColor} fillOpacity={0.5} />
                    </>
                  );
                })()}
                <Path d={linePath(macdS.macd, yInd)} stroke={t.chart.macd} strokeWidth={1.2} fill="none" />
                <Path d={linePath(macdS.signal, yInd)} stroke={t.chart.signal} strokeWidth={1.2} fill="none" />
                <SvgText x={2} y={indTop + 9} fill={t.muted} fontSize={font.tiny}>
                  MACD(12,26,9) {fmtNum(macdS.macd[end - 1], currency === "KRW" ? 0 : 2)} · 시그널 {fmtNum(macdS.signal[end - 1], currency === "KRW" ? 0 : 2)}
                </SvgText>
              </>
            ) : null}
            {/* 날짜 축 */}
            {xTicks.map((tk) => (
              <SvgText key={tk.i} x={xOf(tk.i)} y={height - 4} fill={t.muted} fontSize={font.tiny} textAnchor="middle">
                {tk.label}
              </SvgText>
            ))}
            {/* 십자선 */}
            {cross && crossCandle ? (
              <>
                <Line x1={xOf(cross.i)} x2={xOf(cross.i)} y1={0} y2={height - X_AXIS_H} stroke={t.ink} strokeOpacity={0.5} strokeDasharray="3 3" />
                <Line x1={0} x2={plotW} y1={cross.y} y2={cross.y} stroke={t.ink} strokeOpacity={0.5} strokeDasharray="3 3" />
                <Rect x={plotW} y={cross.y - 8} width={axisW} height={16} fill={t.ink} rx={3} />
                <SvgText {...axisText} y={cross.y + 3.5} fill={t.bg} fontSize={font.tiny} fontWeight="700">
                  {axisPrice(domain[0] + ((priceH - cross.y) / priceH) * (domain[1] - domain[0]), currency)}
                </SvgText>
                <Rect x={Math.min(Math.max(xOf(cross.i) - 40, 0), plotW - 80)} y={height - X_AXIS_H} width={80} height={X_AXIS_H - 2} fill={t.ink} rx={3} />
                <SvgText x={Math.min(Math.max(xOf(cross.i), 40), plotW - 40)} y={height - 5} fill={t.bg} fontSize={font.tiny} fontWeight="700" textAnchor="middle">
                  {crossCandle.time ? `${crossCandle.date.slice(5).replace("-", "/")} ${crossCandle.time.slice(11, 16)}` : crossCandle.date}
                </SvgText>
              </>
            ) : null}
          </Svg>
        </View>
      </GestureDetector>
      {/* 이동평균 값은 차트 아래 (위쪽 조작·읽기 줄을 한 줄로 유지, 3-21) */}
      {p.showMaValues !== false ? (
        <>
          <Readout
          candle={crossCandle}
          prev={cross ? visible[cross.i - 1] ?? candles[start + cross.i - 1] : visible[n - 2] ?? candles[end - 2]}
          latestBase={p.period === "D" ? p.prevClose : null}
          latestDate={p.latestDate}
          isLatest={isLatest}
          last={last}
          currency={currency}
          period={p.period}
          showVolume={p.hasVolume !== false}
          part="bottom"
          />
          {p.maItems ? (
            <MaItems mas={mas} index={cross ? start + cross.i : end - 1} currency={currency} period={p.period} />
          ) : (
            <MaLine mas={mas} index={cross ? start + cross.i : end - 1} currency={currency} period={p.period} />
          )}
        </>
      ) : null}
    </View>
  );
}

/**
 * "M.. L.. L.." 을 뒤에서부터 L 로 이어 닫힌 영역을 만든다 (볼린저 밴드 채움).
 * 좌표는 음수일 수 있다 — 선이 가격 칸 위로 벗어나면(축을 봉 기준으로 정한 뒤 — 급락 직후의 볼린저) y 가 0 보다 작다.
 * 예전 정규식은 음수를 건너뛰어 채움 영역에서 점이 빠졌다 (2026-09-26 검증)
 */
export function reversePath(d: string): string {
  const pts = d.match(/[ML](-?[\d.]+) (-?[\d.]+)/g) ?? [];
  return pts
    .reverse()
    .map((s) => `L${s.slice(1)}`)
    .join("");
}

function fmtNum(v: number | null | undefined, digits: number): string {
  return v === null || v === undefined ? "-" : v.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/**
 * 가로 기준선. label 이 있으면 오른쪽 축 태그(현재가 — filled 면 색 상자 위 글자).
 * 그림 안 글자(평단·52주)는 선을 모두 그린 뒤 LabelText 로 따로 그린다 (다른 선이 글자를 가로지르지 않게)
 */
function Tag({
  y,
  plotW,
  axisW,
  label,
  labelAt,
  color,
  dashed,
  dotted,
  filled,
}: {
  y: number;
  plotW: number;
  axisW: number;
  label?: string;
  /** 축 글자 자리 (맞춘 축은 그림 오른쪽 끝에 오른쪽 맞춤). 없으면 예전처럼 축 칸 왼쪽 + 4 */
  labelAt?: { x: number; textAnchor: "start" | "end" };
  color: string;
  dashed?: boolean;
  dotted?: boolean;
  filled?: boolean;
}) {
  const t = useTheme();
  return (
    <>
      <Line x1={0} x2={plotW} y1={y} y2={y} stroke={color} strokeWidth={dotted ? 0.8 : 1} strokeDasharray={dashed ? "5 3" : dotted ? "1.5 3" : undefined} strokeOpacity={dotted ? 0.7 : 0.9} />
      {label ? (
        <>
          {filled ? <Rect x={plotW} y={y - 8} width={axisW} height={16} fill={color} rx={3} /> : null}
          <SvgText {...(labelAt ?? { x: plotW + AXIS_TEXT_X, textAnchor: "start" as const })} y={y + 3.5} fill={filled ? t.bg : color} fontSize={font.tiny} fontWeight="700">
            {label}
          </SvgText>
        </>
      ) : null}
    </>
  );
}

/**
 * 그림 안 글자 한 개: 바탕색 토큰으로 옅게 깐 상자 + 글자 (뒤의 봉·선을 가려 글자가 읽히게).
 * swatch 가 있으면 글자 앞에 그 색 네모 (벗어난 이동평균 — 칩의 색 줄과 같은 모양, 글자는 대비가 보장되는 muted)
 */
function LabelText({ spot, label, color, bg, bold, swatch }: { spot: LabelSpot; label: string; color: string; bg: string; bold: boolean; swatch?: string }) {
  const b = spot.box;
  return (
    <>
      <Rect x={b.left} y={b.top} width={b.right - b.left} height={b.bottom - b.top} fill={bg} fillOpacity={LABEL_BG_OPACITY} rx={radius.sm / 2} />
      {swatch ? <Rect x={b.left + LABEL_PAD} y={spot.ty - 4 - MA_SWATCH_H / 2} width={MA_SWATCH_W} height={MA_SWATCH_H} fill={swatch} /> : null}
      <SvgText
        x={swatch ? b.left + LABEL_PAD + MA_SWATCH_W + MA_SWATCH_GAP : spot.x}
        y={spot.ty}
        textAnchor={!swatch && spot.side === "right" ? "end" : "start"}
        fill={color}
        fontSize={font.tiny}
        fontWeight={bold ? "700" : "400"}
      >
        {label}
      </SvgText>
    </>
  );
}

/** 읽기 줄: 십자선이 잡은 봉(없으면 마지막 봉)의 종가·등락·고·저 (차트 위), 등락 기준·시가·거래량 (차트 아래) */
function Readout({
  candle,
  prev,
  latestBase,
  latestDate,
  isLatest,
  last,
  currency,
  period,
  showVolume,
  part,
}: {
  candle: Candle | undefined;
  prev: Candle | undefined;
  /** 최신 일봉을 볼 때의 전일 종가(현재가 헤더와 같은 기준) */
  latestBase?: number | null;
  latestDate?: string | null;
  /** 보고 있는 봉이 전체 시계열의 최신 봉인지 */
  isLatest: boolean;
  last: Candle | undefined;
  currency: ChartUnit;
  period: CandlePeriod;
  showVolume: boolean;
  /** top = 차트 위 한 줄, bottom = 차트 아래(기준·시가·거래량), all = 위 한 줄에 전부(전체 화면) */
  part: "top" | "bottom" | "all";
}) {
  const t = useTheme();
  // 100% 는 한 줄(좁으면 뒤부터 잘림, 3-21). 글자를 키우면 두 줄까지 — 종가·등락이 잘리지 않게 (3-22)
  const lines = useFontScale() > 1 ? 2 : 1;
  const c = candle ?? last;
  if (!c) return <Text style={{ color: t.muted, fontSize: font.tiny }}>차트 데이터가 없습니다</Text>;
  // 등락 기준(lib/chartBasis): 최신 일봉은 십자선이어도 헤더와 같은 전일 종가, 지난 봉은 직전 봉 종가, 분봉은 봉 시가
  const basis = readoutBasis({ period, isLatest, latestBase, latestDate, candleDate: c.date, prevClose: prev?.close, open: c.open });
  const chg = basis.base ? ((c.close - basis.base) / basis.base) * 100 : null;
  // 등락 색은 보이는 등락률로 — "(0.00%)" 로 보이는 1센트 미만 움직임을 손실·이익 색으로 칠하지 않게 (BH-38)
  const color = chg === null ? t.muted : changeColor(t, shownSign(chg, formatPct(chg)));
  // 날짜는 짧게(연도 빼고), 분봉은 시각까지. 값은 단위(원) 없이 — 한 줄에 종가·등락·고·저가 들어가게 (3-21 리뷰)
  // 분봉은 시각만 (날짜는 차트 아래 축에 있다) — 십자선으로 옮겨도 한 줄에 들어가게
  const when = c.time ? c.time.slice(11, 16) : c.date.slice(5);
  const v = (x: number) => formatChartValue(x, currency).replace(/원$/, "");
  // 실시간 체결로 만든 임시 봉은 거래량을 모른다 — 0 으로 보이지 않게 (PF-04, 서버 봉을 다시 받으면 채워진다)
  const vol = showVolume ? (c.volumeUnknown ? "거래량 집계 중" : `거래량 ${formatVolume(c.volume)}`) : "";
  const a11y = [`${c.date}${c.time ? ` ${c.time.slice(11, 16)}` : ""}`, `종가 ${formatChartValue(c.close, currency)}`, chg !== null ? `${basis.label} ${formatPct(chg)}` : "", `고가 ${v(c.high)}`, `저가 ${v(c.low)}`, `시가 ${v(c.open)}`, vol]
    .filter(Boolean)
    .join(", ");
  if (part === "bottom") {
    // 차트 아래 줄: 등락 기준 · 시가 · 거래량 (위 줄에 다 들어가지 않는 것)
    return (
      <Text style={[styles.readoutText, { color: t.muted }]} numberOfLines={lines} importantForAccessibility="no" accessibilityElementsHidden>
        {chg !== null ? `${basis.label} · ` : ""}시 {v(c.open)}
        {vol ? ` · ${vol}` : ""}
      </Text>
    );
  }
  // 위 줄: 날짜 · 종가(등락) · 고 · 저 (전체 화면은 아래 줄이 없으므로 시가·거래량까지, 좁으면 뒤부터 잘린다)
  return (
    <View style={styles.readout}>
      <Text style={[styles.readoutText, { color: t.muted }]} numberOfLines={lines} accessibilityLabel={a11y}>
        {when}
 · 종 <Text style={{ color, fontWeight: "700" }}>{v(c.close)}</Text>
        {chg !== null ? <Text style={{ color }}> ({formatPct(chg)})</Text> : null}
        <Text style={{ color: t.ink }}>
          {" "}
          고 {v(c.high)} 저 {v(c.low)}
          {part === "all" ? ` 시 ${v(c.open)}` : ""}
        </Text>
        {part === "all" && vol ? ` · ${vol}` : ""}
      </Text>
    </View>
  );
}

/**
 * 차트 아래 이동평균 값 (십자선이 잡은 봉, 없으면 마지막 봉). 색은 네모에만 — 선 색은 글자 대비 4.5 를 보장하지 않는다.
 * 휴대폰·접힌 화면(넓은 창이 아님): 3-42 이전과 똑같은 한 줄 글자 (두 줄까지, 공백에서 줄이 바뀐다)
 */
function MaLine({ mas, index, currency, period }: { mas: { period: number; values: Series }[]; index: number; currency: ChartUnit; period: CandlePeriod }) {
  const t = useTheme();
  if (!mas.length) return null;
  const unit = period === "W" ? "주" : period === "M" ? "월" : period === "D" ? "일" : "봉";
  return (
    <Text style={[styles.readoutText, { color: t.muted }]} numberOfLines={2}>
      {mas.map((m) => {
        const v = m.values[index];
        return (
          <Text key={m.period}>
            <Ionicons name="square" size={font.tiny} color={maColor(t, m.period)} /> {m.period}
            {unit} {v === null || v === undefined ? "-" : formatChartValue(v, currency)}{"  "}
          </Text>
        );
      })}
    </Text>
  );
}

/**
 * 넓은 창의 이동평균 값 (폴드 진단 24번). 항목('■ 120일 77,120원')마다 따로 묶어 줄바꿈 줄(flexWrap)에 놓는다 →
 * 글자를 키워도 항목 단위로만 다음 줄로 가고, '120일'과 값이 떨어지거나 색 네모만 윗줄에 남지 않는다 (lib/chartLayout maLegendItems)
 */
function MaItems({ mas, index, currency, period }: { mas: { period: number; values: Series }[]; index: number; currency: ChartUnit; period: CandlePeriod }) {
  const t = useTheme();
  if (!mas.length) return null;
  return (
    <View style={styles.maLine}>
      {maLegendItems(mas, index, currency, period).map((it) => (
        <View key={it.period} style={styles.maItem}>
          <Ionicons name="square" size={font.tiny} color={maColor(t, it.period)} />
          <Text style={[styles.readoutText, { color: t.muted }]}>{it.text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { minHeight: 16, justifyContent: "center" },
  readoutText: { fontSize: font.tiny, fontVariant: ["tabular-nums"] },
  // 넓은 창 이동평균 값 줄: 항목 사이는 예전 두 칸 띄어쓰기만큼, 네모와 글자 사이는 한 칸만큼. 줄 사이 간격은 두지 않는다
  maLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.s, rowGap: 0 },
  maItem: { flexDirection: "row", alignItems: "center", gap: space.xxs },
});
