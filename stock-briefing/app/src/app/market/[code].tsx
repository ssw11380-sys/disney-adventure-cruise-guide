import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMarketCandles, useMarketIndices } from "@/api/hooks";
import type { CandlePeriod } from "@/api/types";
import { CandleChart } from "@/components/CandleChart";
import { formatIndexValue, MarketStrip } from "@/components/MarketStrip";
import { Screen } from "@/components/Screen";
import { CANDLE_COUNT } from "@/lib/chartPrefs";
import { formatDateKo, formatPct } from "@/lib/format";
import { changeColor, font, space, useTheme } from "@/theme";

const US_INDEX = new Set(["NASDAQ", "SPX", "DJI", "SOX"]);

/**
 * 지수·환율 차트 (홈 상단 지수 띠에서 들어온다): 값·등락 머리 → 캔들 차트(분·일·주·월, 이평·지표) → 기준 안내.
 * 위쪽 띠에서 다른 지수·환율을 누르면 이 화면 안에서 바로 바뀐다.
 */
export default function MarketIndexScreen() {
  const t = useTheme();
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = (raw ?? "").toUpperCase();
  const [period, setPeriod] = useState<CandlePeriod>("D");
  const indices = useMarketIndices();
  const candles = useMarketCandles(code, period, CANDLE_COUNT[period]);
  const idx = indices.data?.indices.find((i) => i.code === code) ?? null;
  const fx = idx?.kind === "fx" || code.endsWith("KRW");
  const intraday = period === "1m" || period === "5m" || period === "30m";
  const up = changeColor(t, idx?.change);
  // 거래량이 없는 시계열(환율, 필라반도체처럼 소스가 0만 주는 지수)은 거래량 칸을 숨긴다
  const hasVolume = !fx && (candles.data ? candles.data.candles.some((c) => c.volume > 0) : true);
  // 차트 오른쪽 현재가 태그와 전일 기준선에 쓰는 값
  const quote = idx ? { price: idx.value, prevClose: idx.value - idx.change, high52w: null, low52w: null, live: false, fxRate: null, priceKrw: null } : null;

  const note = fx
    ? intraday
      ? "하나은행 고시 회차 기준 · 시각은 한국 시간"
      : period === "M"
        ? "하나은행 매매기준율 종가 기준 (시가는 직전 종가 · 1년 이전 월봉은 주별 종가로 만든 근사)"
        : "하나은행 매매기준율 종가 기준 (시가는 직전 종가)"
    : US_INDEX.has(code) && intraday
      ? "직전·당일 정규장 1분 시세 기준 · 시각은 뉴욕 현지"
      : null;

  return (
    <Screen
      refreshing={candles.isRefetching || indices.isRefetching}
      onRefresh={() => {
        void indices.refetch();
        void candles.refetch();
      }}
    >
      <Stack.Screen options={{ title: idx?.name ?? code }} />
      <MarketStrip selected={code} onSelect={(c) => router.setParams({ code: c })} />

      <View style={[styles.head, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <Text style={{ color: t.muted, fontSize: font.small }}>
          {idx?.name ?? code}
          {fx ? (code === "JPYKRW" ? " · 100엔당 원" : " · 원") : idx ? (idx.open ? " · 장중" : " · 장 마감") : ""}
        </Text>
        {idx ? (
          <>
            <View style={styles.priceRow}>
              <Text style={[styles.bigPrice, { color: up }]}>{formatIndexValue(idx.value)}</Text>
              {fx ? <Text style={{ color: t.muted, fontSize: font.body }}>원</Text> : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text style={[styles.change, { color: up }]}>
                {idx.change > 0 ? "▲" : idx.change < 0 ? "▼" : ""}
                {formatIndexValue(Math.abs(idx.change))}
              </Text>
              <Text style={[styles.change, { color: up }]}>{formatPct(idx.changeRate)}</Text>
            </View>
            <Text style={{ color: t.muted, fontSize: font.small }}>{formatDateKo(idx.asOf, true)} 기준</Text>
          </>
        ) : (
          <Text style={{ color: t.muted, fontSize: font.small, marginTop: 4 }}>{indices.isLoading ? "불러오는 중…" : "시세를 불러오지 못했습니다"}</Text>
        )}
      </View>

      <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
        <CandleChart
          candles={candles.data?.candles}
          period={period}
          onPeriodChange={setPeriod}
          loading={candles.isLoading}
          currency="PT"
          quote={quote}
          hasVolume={hasVolume}
        />
        {candles.isError ? <Text style={{ color: t.danger, fontSize: font.small }}>{candles.error instanceof Error ? candles.error.message : "차트를 불러오지 못했습니다"}</Text> : null}
        {note ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{note}</Text> : null}
      </View>
      <Text style={{ color: t.muted, fontSize: font.tiny, paddingHorizontal: space.lg, paddingTop: space.sm }}>출처: 네이버 증권</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  bigPrice: { fontSize: 30, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
  change: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  panel: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm, marginTop: space.sm },
});
