import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { Candle, CandlePeriod, ChartUnit, Currency, Quote } from "@/api/types";
import { PERIOD_OPTIONS, UNIT, WINDOWS, useChartPrefs } from "@/lib/chartPrefs";
import { formatNumber } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { font, radius, slopFor, space, useTheme } from "@/theme";
import { clampView, maColor, PriceChart, type ChartView, type IndicatorKind } from "./chart/PriceChart";

/**
 * 종목 상세·전체 화면에서 쓰는 차트 묶음: 기간(분·일·주·월) → 보이는 봉 수 칩 + 과거/최신 버튼 → 차트 → 오버레이·지표 토글.
 * 보이는 구간(count, offset)은 여기서 들고 PriceChart 에 넘긴다. 제스처(드래그·핀치·십자선)는 PriceChart 안에서 처리한다.
 */

const MA_CHOICES = [5, 10, 20, 60, 120, 200];
/** 칩·아이콘 버튼의 보이는 크기 (3-22: 24 → 32). 누르는 영역은 위아래로 넓혀 44, 좌우는 버튼 간격(6)의 절반만 — 이웃 버튼과 겹치지 않게 */
const CHIP_H = 32;
const ICON = 32;
const SLOP = slopFor(ICON, space.s / 2);
const CHIP_SLOP = slopFor(CHIP_H, space.s / 2);
/** 기간 칩을 화면 읽기로 읽을 때 */
const PERIOD_SPEECH: Record<CandlePeriod, string> = { "1m": "1분봉", "5m": "5분봉", "30m": "30분봉", D: "일봉", W: "주봉", M: "월봉" };
/** 조작 줄 순서: 자주 쓰는 일·주·월 먼저, 분봉은 뒤 (가로로 넘겨서) */
const TOOL_ORDER = (["D", "W", "M", "1m", "5m", "30m"] as CandlePeriod[]).map((v) => PERIOD_OPTIONS.find((o) => o.value === v)!);

/** 국내 종목 시세 시각의 한국 날짜 (일봉 날짜와 비교). 해외는 거래소 날짜가 달라 쓰지 않는다 */
function kstDate(asOf: string | null | undefined): string | null {
  const ms = asOf ? Date.parse(asOf) : NaN;
  return Number.isFinite(ms) ? new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10) : null;
}

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
  compact = false,
  hasVolume = true,
}: {
  candles: Candle[] | undefined;
  period: CandlePeriod;
  onPeriodChange: (p: CandlePeriod) => void;
  loading?: boolean;
  /** 값 단위: KRW·USD 통화, PT = 지수·환율 */
  currency?: ChartUnit;
  avgPrice?: number | null;
  quote?: Pick<Quote, "price" | "prevClose" | "high52w" | "low52w" | "live" | "fxRate" | "priceKrw"> & { asOf?: string | null } | null;
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

  const periodChip = (o: (typeof PERIOD_OPTIONS)[number]) => (
    <Pressable key={o.value} onPress={() => onPeriodChange(o.value)} accessibilityRole="button" accessibilityLabel={PERIOD_SPEECH[o.value]} accessibilityState={{ selected: o.value === period }} hitSlop={CHIP_SLOP} style={chipStyle(o.value === period)}>
      <Text style={chipText(o.value === period)}>{o.label}</Text>
    </Pressable>
  );
  const chipStyle = (active: boolean) => [styles.chip, { borderColor: active ? t.accent : t.line, backgroundColor: active ? t.surfaceAlt : "transparent" }];
  const chipText = (active: boolean) => ({ color: active ? t.ink : t.muted, fontSize: font.tiny, fontWeight: active ? ("700" as const) : ("500" as const) });
  const overlayChips = (
    <>
        {MA_CHOICES.map((per) => {
          const on = prefs.maPeriods.includes(per);
          return (
            <Pressable key={per} onPress={() => toggleMa(per)} accessibilityRole="switch" accessibilityLabel={`${per} 이동평균선`} accessibilityState={{ checked: on }} hitSlop={CHIP_SLOP} style={[styles.chip, { borderColor: on ? maColor(t, per) : t.line, opacity: on ? 1 : 0.6 }]}>
              <View style={[styles.swatch, { backgroundColor: maColor(t, per) }]} />
              <Text style={chipText(on)}>{per}</Text>
            </Pressable>
          );
        })}
        <Pressable onPress={() => setPrefs({ bollinger: !prefs.bollinger })} accessibilityRole="switch" accessibilityLabel="볼린저 밴드" accessibilityState={{ checked: prefs.bollinger }} hitSlop={CHIP_SLOP} style={chipStyle(prefs.bollinger)}>
          <Text style={chipText(prefs.bollinger)}>볼린저</Text>
        </Pressable>
        {hasVolume ? (
          <Pressable onPress={() => setPrefs({ volume: !prefs.volume })} accessibilityRole="switch" accessibilityLabel="거래량" accessibilityState={{ checked: prefs.volume }} hitSlop={CHIP_SLOP} style={chipStyle(prefs.volume)}>
            <Text style={chipText(prefs.volume)}>거래량</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={cycleIndicator}
          accessibilityRole="button"
          accessibilityLabel={`보조 지표: ${prefs.indicator === "none" ? "끔" : prefs.indicator.toUpperCase()}. 누르면 ${prefs.indicator === "none" ? "RSI" : prefs.indicator === "rsi" ? "MACD" : "끄기"}`}
          hitSlop={CHIP_SLOP}
          style={chipStyle(prefs.indicator !== "none")}
        >
          <Text style={chipText(prefs.indicator !== "none")}>{prefs.indicator === "none" ? "RSI/MACD" : prefs.indicator === "rsi" ? "RSI (다음 MACD)" : "MACD (다음 끄기)"}</Text>
        </Pressable>
    </>
  );

  return (
    <View style={{ gap: space.s }}>
      {/* 조작 한 줄 (3-21): [일 주 월 | 봉 수 | 1분 5분 30분] 은 가로로 넘기고, 과거·최신·크게 보기는 오른쪽에 고정.
          자주 쓰는 일·주·월과 봉 수를 앞에 둔다 (분봉은 넘겨서) */}
      <View style={styles.toolRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.chipScroll, { flex: 1 }]} contentContainerStyle={styles.chips}>
          {TOOL_ORDER.slice(0, 3).map((o) => periodChip(o))}
          <Pressable
            onPress={() => pickWindow((windowIdx + 1) % WINDOWS[period].length)}
            accessibilityRole="button"
            hitSlop={CHIP_SLOP}
            accessibilityLabel={`보이는 봉 ${Math.min(clamped.count, all.length)}개${clamped.offset > 0 ? `, 최신보다 ${clamped.offset}${UNIT[period]} 전` : ""}. 눌러서 바꾸기`}
            style={[chipStyle(true), { borderStyle: "dashed" }]}
          >
            {/* 실제로 보이는 봉 수 (확대·축소하거나 봉이 적으면 칩 값과 다르다), 과거로 옮겼으면 몇 봉 전인지 */}
            <Text style={chipText(true)}>
              {Math.min(clamped.count, all.length) || WINDOWS[period][windowIdx]}
              {UNIT[period]}
              {clamped.offset > 0 ? ` · ${clamped.offset}${UNIT[period]} 전` : ""}
            </Text>
            <Ionicons name="swap-horizontal" size={font.tiny} color={t.muted} />
          </Pressable>
          {TOOL_ORDER.slice(3).map((o) => periodChip(o))}
          {compact ? overlayChips : null}
        </ScrollView>
        <Pressable onPress={() => shift(1)} disabled={clamped.offset >= maxOffset} accessibilityRole="button" accessibilityState={{ disabled: clamped.offset >= maxOffset }} accessibilityLabel="과거로" hitSlop={SLOP} style={[styles.icon, { borderColor: t.line, opacity: clamped.offset >= maxOffset ? 0.4 : 1 }]}>
          <Ionicons name="chevron-back" size={font.small} color={t.ink} />
        </Pressable>
        <Pressable onPress={() => shift(-1)} disabled={clamped.offset === 0} accessibilityRole="button" accessibilityState={{ disabled: clamped.offset === 0 }} accessibilityLabel={clamped.offset > 0 ? `최신으로 (지금 ${clamped.offset}${UNIT[period]} 전)` : "최신으로"} hitSlop={SLOP} style={[styles.icon, { borderColor: clamped.offset > 0 ? t.accent : t.line, opacity: clamped.offset === 0 ? 0.4 : 1 }]}>
          <Ionicons name="chevron-forward" size={font.small} color={t.ink} />
        </Pressable>
        {onFullscreen ? (
          <Pressable onPress={onFullscreen} accessibilityRole="button" accessibilityLabel="차트 크게 보기" hitSlop={SLOP} style={[styles.icon, { borderColor: t.line }]}>
            <Ionicons name="expand-outline" size={font.small} color={t.ink} />
          </Pressable>
        ) : null}
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
          latestDate={currency === "KRW" ? kstDate(quote?.asOf) : null}
          high52w={conv(quote?.high52w)}
          low52w={conv(quote?.low52w)}
          showMaValues={!compact}
        />
      )}

      {/* 오버레이 · 지표 (전체 화면이면 위 조작 줄 안으로 합쳐 차트를 더 크게, 3-21) */}
      {compact ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
          {overlayChips}
        </ScrollView>
      )}
      {toKrw ? <Text style={{ color: t.muted, fontSize: font.tiny }}>원화 환산 · 1달러 {formatNumber(fx, 2)}원 (과거 봉 동일 환율)</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  toolRow: { flexDirection: "row", alignItems: "center", gap: space.s },
  // 가로 스크롤 안의 칩은 스크롤 영역 밖 터치를 받지 못한다(안드로이드) → 영역을 위아래 6씩 넓혀 칩 hitSlop(44)이 들어가게 하고,
  // 같은 만큼 음수 여백을 줘서 보이는 배치(조작 줄 32)는 그대로 둔다 (3-22 리뷰)
  chipScroll: { marginVertical: -CHIP_SLOP.top },
  chips: { flexDirection: "row", gap: space.s, alignItems: "center", paddingVertical: CHIP_SLOP.top },
  chip: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, minHeight: CHIP_H },
  icon: { width: ICON, height: ICON, alignItems: "center", justifyContent: "center", borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  swatch: { width: 8, height: 2 },
});
