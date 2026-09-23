import { Ionicons } from "@expo/vector-icons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCandles, useStock } from "@/api/hooks";
import type { CandlePeriod } from "@/api/types";
import { CandleChart } from "@/components/CandleChart";
import { ChangeText } from "@/components/ui";
import { CANDLE_COUNT } from "@/lib/chartPrefs";
import { currencyOfMarket, formatPct, formatPrice } from "@/lib/format";
import { font, space, useTheme } from "@/theme";

/**
 * 전체 화면 차트. 앱은 세로 고정이라 "가로" 버튼을 누르면 화면을 90도 돌려 그린다(가로 모드처럼 넓게).
 * 제스처 좌표는 회전된 뷰 기준으로 들어오므로 그대로 동작한다.
 */
export default function FullscreenChartScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const { code, period: initial } = useLocalSearchParams<{ code: string; period?: string }>();
  const c = code ?? "";
  const [period, setPeriod] = useState<CandlePeriod>((initial as CandlePeriod) || "D");
  const [landscape, setLandscape] = useState(false);
  const stock = useStock(c);
  const candles = useCandles(c, period, CANDLE_COUNT[period]);
  const s = stock.data;
  const q = s?.quote ?? null;
  const cur = q?.currency ?? currencyOfMarket(s?.market);

  const pad = space.md;
  // 회전하면 폭·높이가 바뀐다. 상태바·내비게이션 영역은 피한다
  const availW = landscape ? winH - insets.top - insets.bottom : winW;
  const availH = landscape ? winW : winH - insets.top - insets.bottom;
  const headerH = 44;
  const chartW = availW - pad * 2;
  const chartH = Math.max(220, availH - headerH - 150); // 도구 모음 2줄 + 오버레이 줄

  const body = (
    <View style={{ width: availW, height: availH, backgroundColor: t.bg, paddingHorizontal: pad }}>
      <View style={[styles.header, { height: headerH }]}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, flexShrink: 1 }}>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} numberOfLines={1}>
            {s?.name ?? c}
          </Text>
          {q ? (
            <>
              <Text style={{ color: t.ink, fontSize: font.body, fontVariant: ["tabular-nums"] }}>{formatPrice(q.price, cur)}</Text>
              <ChangeText value={q.change} text={`${formatPrice(q.change, cur, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.small }} />
            </>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Pressable onPress={() => setLandscape((v) => !v)} accessibilityLabel={landscape ? "세로로 보기" : "가로로 보기"} hitSlop={8} style={[styles.iconBtn, { borderColor: t.line }]}>
            <Ionicons name={landscape ? "phone-portrait-outline" : "phone-landscape-outline"} size={18} color={t.ink} />
          </Pressable>
          <Pressable onPress={() => router.back()} accessibilityLabel="닫기" hitSlop={8} style={[styles.iconBtn, { borderColor: t.line }]}>
            <Ionicons name="close" size={18} color={t.ink} />
          </Pressable>
        </View>
      </View>
      <CandleChart
        candles={candles.data?.candles}
        period={period}
        onPeriodChange={setPeriod}
        loading={candles.isLoading}
        currency={cur}
        avgPrice={s?.avgPrice ?? null}
        quote={q}
        width={chartW}
        height={chartH}
        compact
      />
      {candles.isError ? <Text style={{ color: t.danger, fontSize: font.small }}>{candles.error instanceof Error ? candles.error.message : "차트 실패"}</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <Stack.Screen options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
      {landscape ? (
        <View style={{ width: winW, height: winH - insets.top - insets.bottom, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: availW, height: availH, transform: [{ rotate: "90deg" }] }}>{body}</View>
        </View>
      ) : (
        body
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  iconBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
