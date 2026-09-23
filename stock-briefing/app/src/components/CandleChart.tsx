import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { Candle, CandlePeriod, ChartUnit, Currency, Quote } from "@/api/types";
import { PERIOD_OPTIONS, UNIT, WINDOWS, useChartPrefs } from "@/lib/chartPrefs";
import { formatNumber } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { font, radius, space, useTheme } from "@/theme";
import { clampView, MA_COLORS, PriceChart, type ChartView, type IndicatorKind } from "./chart/PriceChart";

/**
 * 종목 상세·전체 화면에서 쓰는 차트 묶음: 기간(분·일·주·월) → 보이는 봉 수 칩 + 과거/최신 버튼 → 차트 → 오버레이·지표 토글.
 * 보이는 구간(count, offset)은 여기서 들고 PriceChart 에 넘긴다. 제스처(드래그·핀치·십자선)는 PriceChart 안에서 처리한다.
 */

const MA_CHOICES = [5, 10, 20, 60, 120, 200];

export function CandleChart({
  candles,
  period,
  onPeriodChange,
  loading,
  currency = "KRW",
  avgPrice,
  quote,
  height,
  width: widthProp,
  onFullscreen,
  compact: _compact,
  hasVolume = true,
}: {
  candles: Candle[] | undefined;
  period: CandlePeriod;
  onPeriodChange: (p: CandlePeriod) => void;
  loading?: boolean;
  /** 값 단위: KRW·USD 통화, PT = 지수·환율 */
  currency?: ChartUnit;
  avgPrice?: number | null;
  quote?: Pick<Quote, "price" | "prevClose" | "high52w" | "low52w" | "live" | "fxRate" | "priceKrw"> | null;
  height?: number;
  width?: number;
  onFullscreen?: () => void;
  /** 전체 화면: 도구 모음을 한 줄로 줄인다 */
  compact?: boolean;
  /** 거래량이 없는 시계열(환율)이면 false: 거래량 pane·토글·읽기를 뺀다 */
  hasVolume?: boolean;
}) {
  const t = useTheme();
  const { width: winW } = useWindowDimensions();
  const width = widthProp ?? Math.min(winW - space.lg * 2 - space.lg * 2, 720);
  const chartH = height ?? Math.round(width * 0.62);
  const [prefs, setPrefs] = useChartPrefs();
  // 설정 "미국 주식 원화로 보기"가 켜져 있으면 차트도 원화로. 과거 봉도 현재 환율로 환산한다(당시 환율 아님)
  const { showKrw } = useSettings();
  const fx = quote?.fxRate ?? (quote?.priceKrw && quote.price ? quote.priceKrw / quote.price : null);
  const toKrw = currency === "USD" && showKrw && !!fx;
  const k = toKrw ? fx! : 1;
  const conv = (v: number | null | undefined) => (v === null || v === undefined ? null : v * k);
  const chartCurrency: ChartUnit = toKrw ? ("KRW" as Currency) : currency;
  // 보이는 구간은 기간별로 따로 기억한다. 기간이 바뀌면 그 기간의 기본 칩(최신 구간)에서 시작
  const defaultView = (per: CandlePeriod): ChartView => ({ count: WINDOWS[per][1] ?? 120, offset: 0 });
  const [vs, setVs] = useState<{ period: CandlePeriod; windowIdx: number; view: ChartView }>(() => ({ period, windowIdx: 1, view: defaultView(period) }));
  const cur = vs.period === period ? vs : { period, windowIdx: 1, view: defaultView(period) };
  const windowIdx = cur.windowIdx;
  const view = cur.view;
  const setView = (next: ChartView | ((v: ChartView) => ChartView)) =>
    setVs((prev) => {
      const base = prev.period === period ? prev : { period, windowIdx: 1, view: defaultView(period) };
      return { ...base, view: typeof next === "function" ? next(base.view) : next };
    });
  const all = useMemo(
    () => (candles ?? []).map((c) => (k === 1 ? c : { ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k })),
    [candles, k],
  );

  const clamped = clampView(view, all.length);
  const maxOffset = Math.max(all.length - clamped.count, 0);
  const shift = (dir: -1 | 1) => setView((v) => clampView({ count: v.count, offset: v.offset + dir * Math.round(v.count / 2) }, all.length));
  const pickWindow = (i: number) => {
    setVs((prev) => {
      const base = prev.period === period ? prev : { period, windowIdx: 1, view: defaultView(period) };
      return { ...base, windowIdx: i, view: clampView({ count: WINDOWS[period][i] ?? base.view.count, offset: base.view.offset }, all.length) };
    });
  };
  const toggleMa = (per: number) => {
    const has = prefs.maPeriods.includes(per);
    setPrefs({ maPeriods: has ? prefs.maPeriods.filter((x) => x !== per) : [...prefs.maPeriods, per].sort((a, b) => a - b) });
  };
  const cycleIndicator = () => {
    const order: IndicatorKind[] = ["none", "rsi", "macd"];
    setPrefs({ indicator: order[(order.indexOf(prefs.indicator) + 1) % order.length]! });
  };

  const chipStyle = (active: boolean) => [styles.chip, { borderColor: active ? t.accent : t.line, backgroundColor: active ? t.surfaceAlt : "transparent" }];
  const chipText = (active: boolean) => ({ color: active ? t.ink : t.muted, fontSize: font.tiny, fontWeight: active ? ("700" as const) : ("500" as const) });

  return (
    <View style={{ gap: space.sm }}>
      {/* 기간 */}
      <View style={styles.toolbar}>
        <View style={styles.chips}>
          {PERIOD_OPTIONS.map((o) => (
            <Pressable key={o.value} onPress={() => onPeriodChange(o.value)} accessibilityRole="button" accessibilityState={{ selected: o.value === period }} style={chipStyle(o.value === period)}>
              <Text style={chipText(o.value === period)}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
        {onFullscreen ? (
          <Pressable onPress={onFullscreen} accessibilityLabel="차트 크게 보기" hitSlop={8} style={[styles.chip, { borderColor: t.line }]}>
            <Ionicons name="expand-outline" size={14} color={t.ink} />
          </Pressable>
        ) : null}
      </View>
      {/* 보이는 봉 수 + 이동 */}
      <View style={styles.toolbar}>
        <View style={styles.chips}>
          {WINDOWS[period].map((w, i) => (
            <Pressable key={w} onPress={() => pickWindow(i)} accessibilityRole="button" style={chipStyle(i === windowIdx && clamped.count === Math.min(w, Math.max(all.length, 15)))}>
              <Text style={chipText(i === windowIdx)}>
                {w}
                {UNIT[period]}
              </Text>
            </Pressable>
          ))}
          <Text style={{ color: t.muted, fontSize: font.tiny, alignSelf: "center" }}>
            {clamped.count}봉{clamped.offset > 0 ? ` · 최신보다 ${clamped.offset}${UNIT[period]} 전` : ""}
          </Text>
        </View>
        <View style={styles.chips}>
          <Pressable onPress={() => shift(1)} disabled={clamped.offset >= maxOffset} accessibilityLabel="과거로" style={[styles.chip, { borderColor: t.line, opacity: clamped.offset >= maxOffset ? 0.4 : 1 }]}>
            <Text style={{ color: t.ink, fontSize: font.tiny }}>◀</Text>
          </Pressable>
          <Pressable onPress={() => shift(-1)} disabled={clamped.offset === 0} accessibilityLabel="최신으로" style={[styles.chip, { borderColor: t.line, opacity: clamped.offset === 0 ? 0.4 : 1 }]}>
            <Text style={{ color: t.ink, fontSize: font.tiny }}>▶</Text>
          </Pressable>
        </View>
      </View>

      {all.length < 2 ? (
        <View style={[styles.placeholder, { height: chartH, borderColor: t.line, backgroundColor: t.surfaceAlt }]}>
          <Text style={{ color: t.muted, textAlign: "center" }}>
            {loading ? "차트 불러오는 중…" : all.length === 1 ? "봉이 하나뿐입니다 (상장 첫날 등)\n분봉(1분·5분)에서 볼 수 있습니다" : "차트 데이터가 없습니다"}
          </Text>
        </View>
      ) : (
        <PriceChart
          candles={all}
          period={period}
          currency={chartCurrency}
          width={width}
          height={chartH}
          view={clamped}
          onViewChange={setView}
          maPeriods={prefs.maPeriods}
          showBollinger={prefs.bollinger}
          showVolume={prefs.volume && hasVolume}
          hasVolume={hasVolume}
          indicator={prefs.indicator}
          avgPrice={conv(avgPrice)}
          currentPrice={conv(quote?.price)}
          prevClose={conv(quote?.prevClose)}
          high52w={conv(quote?.high52w)}
          low52w={conv(quote?.low52w)}
        />
      )}

      {/* 오버레이 · 지표 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {MA_CHOICES.map((per) => {
          const on = prefs.maPeriods.includes(per);
          return (
            <Pressable key={per} onPress={() => toggleMa(per)} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, { borderColor: on ? MA_COLORS[per] : t.line, opacity: on ? 1 : 0.6 }]}>
              <View style={[styles.swatch, { backgroundColor: MA_COLORS[per] }]} />
              <Text style={chipText(on)}>{per}</Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => setPrefs({ bollinger: !prefs.bollinger })} accessibilityRole="button" style={chipStyle(prefs.bollinger)}>
          <Text style={chipText(prefs.bollinger)}>볼린저</Text>
        </Pressable>
        {hasVolume ? (
          <Pressable onPress={() => setPrefs({ volume: !prefs.volume })} accessibilityRole="button" style={chipStyle(prefs.volume)}>
            <Text style={chipText(prefs.volume)}>거래량</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={cycleIndicator} accessibilityRole="button" style={chipStyle(prefs.indicator !== "none")}>
          <Text style={chipText(prefs.indicator !== "none")}>{prefs.indicator === "none" ? "RSI/MACD" : prefs.indicator === "rsi" ? "RSI ▸ MACD" : "MACD ▸ 끄기"}</Text>
        </Pressable>
      </ScrollView>
      {toKrw ? <Text style={{ color: t.muted, fontSize: font.tiny }}>원화 환산 · 1달러 {formatNumber(fx, 2)}원 (과거 봉 동일 환율)</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  toolbar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  chips: { flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap" },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  swatch: { width: 8, height: 2 },
});
