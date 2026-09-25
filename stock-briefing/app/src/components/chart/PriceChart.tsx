import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Line, Path, Rect, Svg, Text as SvgText } from "react-native-svg";
import type { Candle, CandlePeriod, ChartUnit } from "@/api/types";
import { axisWidth, labelSide, readoutBasis, textWidth, volumeBars } from "@/lib/chartBasis";
import { formatChartValue, maLegendItems } from "@/lib/chartLayout";
import { formatPct, formatVolume, shownSign } from "@/lib/format";
import { bollinger, macd, niceTicks, rsi, sma, type Series } from "@/lib/indicators";
import { changeColor, font, space, useFontScale, useTheme, type Theme } from "@/theme";

/**
 * 직접 그리는 캔들 차트 (react-native-svg + gesture-handler).
 *  - 오른쪽 가격 축·아래 날짜 축, 거래량 pane, 선택한 보조지표 pane(RSI/MACD)
 *  - 이동평균·볼린저 오버레이, 내 평단선·현재가선·52주 고/저 표시(축에 태그)
 *  - 한 손가락 드래그 = 과거/최신 이동, 두 손가락 = 확대/축소, 길게 누른 뒤 드래그 = 십자선(시·고·저·종·거래량 읽기)
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
}

const X_AXIS_H = 18;
const PANE_GAP = 6;

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
  // ── 지표 (전체 시계열로 계산해 구간 첫 봉부터 선이 보이게) ──
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const mas = useMemo(() => p.maPeriods.map((per) => ({ period: per, values: sma(closes, per) })), [closes, p.maPeriods]);
  const bb = useMemo(() => (p.showBollinger ? bollinger(closes, 20, 2) : null), [closes, p.showBollinger]);
  const rsiS = useMemo(() => (p.indicator === "rsi" ? rsi(closes, 14) : null), [closes, p.indicator]);
  const macdS = useMemo(() => (p.indicator === "macd" ? macd(closes) : null), [closes, p.indicator]);

  // ── 가격 도메인 ──
  const domain = useMemo<[number, number]>(() => {
    if (n === 0) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    for (const c of visible) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    const inRange = (s: Series | undefined) => {
      if (!s) return;
      for (let i = start; i < end; i++) {
        const v = s[i];
        if (v !== null && v !== undefined) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    };
    for (const m of mas) inRange(m.values);
    if (bb) {
      inRange(bb.upper);
      inRange(bb.lower);
    }
    if (p.currentPrice && view.offset === 0) {
      lo = Math.min(lo, p.currentPrice);
      hi = Math.max(hi, p.currentPrice);
    }
    // 평단은 범위에서 너무 멀면(±25% 밖) 축을 망가뜨리므로 넣지 않고 가장자리 태그로만 알린다
    const band = (hi - lo) * 0.25;
    if (p.avgPrice && p.avgPrice > lo - band && p.avgPrice < hi + band) {
      lo = Math.min(lo, p.avgPrice);
      hi = Math.max(hi, p.avgPrice);
    }
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.01 || 1;
    return [lo - pad, hi + pad];
  }, [visible, n, mas, bb, start, end, p.currentPrice, p.avgPrice, view.offset]);

  const priceTicks = useMemo(() => niceTicks(domain[0], domain[1], 5).filter((v) => v > domain[0] && v < domain[1]), [domain]);
  // 지수·환율 축 눈금: 간격이 1 미만이면 소수 자리를 늘린다 (원/위안 201.5, 201.6 …)
  const tickStep = priceTicks.length > 1 ? priceTicks[1]! - priceTicks[0]! : 1;
  const tickDigits = tickStep >= 1 ? 0 : tickStep >= 0.1 ? 1 : 2;
  const maxVol = useMemo(() => (p.showVolume ? Math.max(1, ...visible.map((c) => c.volume)) : 1), [visible, p.showVolume]);
  // 오른쪽 가격 축 폭은 눈금·현재가·십자선 값·거래량 최대값 중 가장 긴 글자에 맞춘다 (고정 폭이면 짧은 값에서 빈칸, 긴 값은 잘림)
  const axisW = axisWidth([
    ...priceTicks.map((v) => axisPrice(v, currency, tickDigits)),
    axisPrice(domain[1], currency),
    axisPrice(domain[0], currency),
    p.currentPrice ? axisPrice(p.currentPrice, currency) : "",
    p.showVolume ? formatVolume(maxVol) : "",
  ]);
  const plotW = Math.max(width - axisW, 10);
  const step = n ? plotW / n : plotW;
  const bodyW = Math.max(1, Math.min(step * 0.7, 14));

  const yOf = useCallback((v: number) => priceH - ((v - domain[0]) / (domain[1] - domain[0])) * priceH, [domain, priceH]);
  const xOf = useCallback((i: number) => i * step + step / 2, [step]);

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
  const ctx = useRef({ view, start: view, step, total, minCount, maxCount, onViewChange, setCrossAt, clear: () => setCross(null) });
  useEffect(() => {
    ctx.current = { ...ctx.current, view, step, total, minCount, maxCount, onViewChange, setCrossAt };
  }, [view, step, total, minCount, maxCount, onViewChange, setCrossAt]);
  /* eslint-disable react-hooks/refs */
  const gesture = useMemo(() => {
    const scroll = Gesture.Pan()
      .runOnJS(true)
      .minDistance(8)
      .maxPointers(1)
      .onBegin(() => {
        ctx.current.start = ctx.current.view;
      })
      .onUpdate((e) => {
        const c = ctx.current;
        const next = clampView({ count: c.start.count, offset: c.start.offset + Math.round(e.translationX / c.step) }, c.total, c.minCount, c.maxCount);
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
  // 52주 글자 상자는 오른쪽 끝, 최신 봉을 가리면 왼쪽 끝으로 (lib/chartBasis)
  const avgY = avgIn ? yOf(p.avgPrice!) : avgOut === "above" ? 8 : avgOut ? priceH - 8 : null;
  const side52 = (v: number) =>
    labelSide({ y: yOf(v), plotW, avoidY: avgY, bars: visible.map((c, i) => ({ left: xOf(i) - bodyW / 2, right: xOf(i) + bodyW / 2, top: yOf(c.high), bottom: yOf(c.low) })) });

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
            {/* 가격 눈금 */}
            {priceTicks.map((v) => (
              <React.Fragment key={v}>
                <Line x1={0} x2={plotW} y1={yOf(v)} y2={yOf(v)} stroke={t.line} strokeWidth={StyleSheet.hairlineWidth} />
                {/* 현재가 태그에 가려지거나 맨 위에 붙어 잘리는 눈금 숫자는 그리지 않는다 */}
                {(showCurrent && Math.abs(yOf(v) - yOf(p.currentPrice!)) < 13) || yOf(v) < 5 ? null : (
                  <SvgText x={plotW + 4} y={yOf(v) + 3.5} fill={t.muted} fontSize={font.tiny}>
                    {axisPrice(v, currency, tickDigits)}
                  </SvgText>
                )}
              </React.Fragment>
            ))}
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
            {/* 52주 고/저 */}
            {p.high52w && p.high52w > domain[0] && p.high52w < domain[1] ? <Tag y={yOf(p.high52w)} plotW={plotW} axisW={axisW} label="52주 최고" color={t.muted} dotted inside={side52(p.high52w)} /> : null}
            {p.low52w && p.low52w > domain[0] && p.low52w < domain[1] ? <Tag y={yOf(p.low52w)} plotW={plotW} axisW={axisW} label="52주 최저" color={t.muted} dotted inside={side52(p.low52w)} /> : null}
            {/* 평단선 */}
            {avgIn ? (
              // 평단 글자는 오른쪽 축이 아니라 선 위 왼쪽에 적는다 → 축 폭에 잘리거나 현재가 태그와 겹치지 않는다
              <Tag y={yOf(p.avgPrice!)} plotW={plotW} axisW={axisW} label={`평단 ${axisPrice(p.avgPrice!, currency)}`} color={t.gold} dashed inside="left" topLimit={12} />
            ) : null}
            {avgOut ? (
              // 범위 밖 평단은 왼쪽 끝에 (오른쪽 끝의 52주 글자·최신 봉과 겹치지 않게)
              <SvgText x={5} y={avgOut === "above" ? 12 : priceH - 4} fill={t.gold} fontSize={font.tiny}>
                {avgOut === "above" ? "평단(범위 위) " : "평단(범위 아래) "}
                {axisPrice(p.avgPrice!, currency)}
              </SvgText>
            ) : null}
            {/* 현재가선 */}
            {showCurrent ? <Tag y={yOf(p.currentPrice!)} plotW={plotW} axisW={axisW} label={axisPrice(p.currentPrice!, currency)} color={curColor} dashed filled /> : null}
            {/* 거래량 */}
            {volPaths ? (
              <>
                <Path d={volPaths.up} fill={upColor} fillOpacity={0.55} />
                <Path d={volPaths.down} fill={downColor} fillOpacity={0.55} />
                {volPaths.unknown ? <Path d={volPaths.unknown} stroke={t.muted} strokeWidth={1} strokeDasharray="2 2" fill="none" /> : null}
                <SvgText x={plotW + 4} y={volTop + 9} fill={t.muted} fontSize={font.tiny}>
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
                  <SvgText key={v} x={plotW + 4} y={yInd(v) + 3} fill={t.muted} fontSize={font.tiny}>
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
                <SvgText x={plotW + 4} y={cross.y + 3.5} fill={t.bg} fontSize={font.tiny} fontWeight="700">
                  {axisPrice(domain[0] + (1 - cross.y / priceH) * (domain[1] - domain[0]), currency)}
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
          <MaLine mas={mas} index={cross ? start + cross.i : end - 1} currency={currency} period={p.period} />
        </>
      ) : null}
    </View>
  );
}

function reversePath(d: string): string {
  // "M.. L.. L.." 을 뒤에서부터 L 로 이어 닫힌 영역을 만든다
  const pts = d.match(/[ML]([\d.]+) ([\d.]+)/g) ?? [];
  return pts
    .reverse()
    .map((s) => `L${s.slice(1)}`)
    .join("");
}

function fmtNum(v: number | null | undefined, digits: number): string {
  return v === null || v === undefined ? "-" : v.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** 가로 기준선 + 오른쪽 축 태그 */
function Tag({
  y,
  plotW,
  axisW,
  label,
  color,
  dashed,
  dotted,
  filled,
  inside,
  topLimit = 12,
}: {
  y: number;
  plotW: number;
  axisW: number;
  label: string;
  color: string;
  dashed?: boolean;
  dotted?: boolean;
  filled?: boolean;
  /** 글자를 축이 아니라 그림 안 선 위에 적는다 (왼쪽 끝 또는 오른쪽 끝) */
  inside?: "left" | "right";
  topLimit?: number;
}) {
  const t = useTheme();
  const textW = textWidth(label) + 6;
  // 그림 맨 위 가까이면 선 아래에 적는다
  const ty = inside ? (y - 4 < topLimit ? y + 12 : y - 4) : y + 3.5;
  return (
    <>
      <Line x1={0} x2={plotW} y1={y} y2={y} stroke={color} strokeWidth={dotted ? 0.8 : 1} strokeDasharray={dashed ? "5 3" : dotted ? "1.5 3" : undefined} strokeOpacity={dotted ? 0.7 : 0.9} />
      {filled ? <Rect x={plotW} y={y - 8} width={axisW} height={16} fill={color} rx={3} /> : null}
      {inside ? <Rect x={inside === "left" ? 2 : plotW - textW - 2} y={ty - 10} width={textW} height={13} fill={t.bg} fillOpacity={0.75} rx={2} /> : null}
      <SvgText x={inside === "left" ? 5 : inside === "right" ? plotW - 5 : plotW + 4} y={ty} textAnchor={inside === "right" ? "end" : "start"} fill={filled ? t.bg : color} fontSize={font.tiny} fontWeight={dotted ? "400" : "700"}>
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
 * 항목('■ 120일 77,120원')마다 따로 묶어 줄바꿈 줄(flexWrap)에 놓는다 → 글자를 키워도 항목 단위로만 다음 줄로 가고,
 * '120일'과 값이 떨어지거나 색 네모만 윗줄에 남지 않는다 (폴드 진단 24번, lib/chartLayout maLegendItems)
 */
function MaLine({ mas, index, currency, period }: { mas: { period: number; values: Series }[]; index: number; currency: ChartUnit; period: CandlePeriod }) {
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
  // 이동평균 값 줄: 항목 사이는 예전 두 칸 띄어쓰기만큼, 네모와 글자 사이는 한 칸만큼
  maLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.s, rowGap: space.xxs },
  maItem: { flexDirection: "row", alignItems: "center", gap: space.xxs },
});
