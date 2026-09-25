import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMarketCandles, useMarketIndices } from "@/api/hooks";
import type { CandlePeriod } from "@/api/types";
import { CandleChart } from "@/components/CandleChart";
import { usePull } from "@/components/Freshness";
import { formatIndexValue, MarketStrip } from "@/components/MarketStrip";
import { Screen } from "@/components/Screen";
import { DetailHeader, FillChart, type StateLine } from "@/components/StockDetailParts";
import { sentence, speakRate } from "@/lib/a11y";
import { CANDLE_COUNT } from "@/lib/chartPrefs";
import { detailMode, shortStamp } from "@/lib/detailLayout";
import { formatDateKo, formatPct } from "@/lib/format";
import { indexSessionLabel } from "@/lib/freshness";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { changeColor, font, space, useTheme } from "@/theme";

const US_INDEX = new Set(["NASDAQ", "SPX", "DJI", "SOX"]);

/**
 * 지수·환율 차트 (홈 상단 지수 띠에서 들어온다): 값·등락 머리 → 캔들 차트(분·일·주·월, 이평·지표) → 기준 안내.
 * 위쪽 띠에서 다른 지수·환율을 누르면 이 화면 안에서 바로 바뀐다.
 * 넓은 창(3-42 웨이브 C, 기능 플래그 foldLayout)에서는 값 머리를 종목 상세와 같은 한 줄 머리로 합치고,
 * 넓고 낮은 가로 창(펼친 폴드8 가로·울트라 가로)은 차트를 남은 높이에 맞춰 날짜 줄·지표 칩까지 스크롤 없이 보인다.
 * 플래그가 꺼져 있거나 좁은 창이면 지금 화면 그대로다.
 * 앱은 화면 끝까지 그리므로(edge-to-edge) 넓은 창 배치는 아래 작업 표시줄·좌우 카메라 구멍 여백(safe area)을 직접 비운다 —
 * 지표 칩과 출처 줄이 작업 표시줄 밑에 가려 보이지도 눌리지도 않는 일이 없게
 */
export default function MarketIndexScreen() {
  const t = useTheme();
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = (raw ?? "").toUpperCase();
  const [period, setPeriod] = useState<CandlePeriod>("D");
  const indices = useMarketIndices();
  const candles = useMarketCandles(code, period, CANDLE_COUNT[period]);
  const fold = useFoldLayout();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const mode = detailMode(fold, win);
  // 넓은 창에서 Stack 머리를 숨긴 적이 있으면, 다시 좁아질 때 머리를 되살린다 (화면 옵션은 합쳐지므로 숨김이 남는다)
  const [hidHeader, setHidHeader] = useState(false);
  if (mode !== "phone" && !hidHeader) setHidHeader(true);
  // 좌우 배치(넓고 낮은 가로 창): 지수 띠 아래 남은 높이 (차트를 이 높이에 맞춘다)
  const [bodyH, setBodyH] = useState<number | null>(null);
  const idx = indices.data?.indices.find((i) => i.code === code) ?? null;
  const fx = idx?.kind === "fx" || code.endsWith("KRW");
  // 장중·장 마감. 서버가 출처에서 새로 받지 못한 값(stale)이면 옛 장중 대신 "시세 지연"
  const session = idx ? indexSessionLabel({ ...idx, kind: fx ? "fx" : "index" }) : null;
  const intraday = period === "1m" || period === "5m" || period === "30m";
  const up = changeColor(t, idx?.change);
  // 거래량이 없는 시계열(환율, 필라반도체처럼 소스가 0만 주는 지수)은 거래량 칸을 숨긴다
  const hasVolume = !fx && (candles.data ? candles.data.candles.some((c) => c.volume > 0) : true);
  // 차트 오른쪽 현재가 태그와 전일 기준선에 쓰는 값
  const { pulling, onPull } = usePull(() => Promise.all([indices.refetch(), candles.refetch()]));
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

  if (mode === "phone")
    return (
      <Screen
        refreshing={pulling}
        onRefresh={onPull}
      >
        <Stack.Screen options={{ ...(hidHeader ? { headerShown: true } : {}), title: idx?.name ?? code }} />
        <MarketStrip selected={code} onSelect={(c) => router.setParams({ code: c })} />

        <View style={[styles.head, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
          <Text style={{ color: t.muted, fontSize: font.small }}>
            {idx?.name ?? code}
            {fx ? (code === "JPYKRW" ? " · 100엔당 원" : " · 원") : ""}
            {session ? <Text style={idx?.stale ? { color: t.warn } : null}> · {session}</Text> : null}
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
              {/* 출처의 시세 시각 (없으면 서버가 받은 시각). 앱이 응답을 받은 시각이 아니다 */}
              <Text style={{ color: t.muted, fontSize: font.small }}>{formatDateKo(idx.asOf ?? idx.fetchedAt, true)} 기준</Text>
            </>
          ) : (
            <Text style={{ color: t.muted, fontSize: font.small, marginTop: space.xs }}>{indices.isLoading ? "불러오는 중…" : "시세를 불러오지 못했습니다"}</Text>
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

  // ── 넓은 창 (3-42 웨이브 C): 종목 상세와 같은 한 줄 머리 ──
  const asOf = idx ? (idx.asOf ?? idx.fetchedAt) : null;
  const move = idx ? `${idx.change > 0 ? "▲" : idx.change < 0 ? "▼" : ""}${formatIndexValue(Math.abs(idx.change))}` : "";
  const state: StateLine[] = idx
    ? [...(session ? [{ text: session, color: idx.stale ? t.warn : undefined }] : []), { text: `${formatDateKo(asOf, true)} 기준`, short: `${shortStamp(asOf)} 기준` }]
    : [];
  const header = (
    <DetailHeader
      name={idx?.name ?? code}
      sub={`${code}${fx ? (code === "JPYKRW" ? " · 100엔당 원" : " · 원") : ""}`}
      quote={
        idx
          ? {
              value: idx.value,
              price: formatIndexValue(idx.value),
              unit: fx ? "원" : "",
              change: move,
              rate: formatPct(idx.changeRate),
              priceColor: up,
              changeColor: up,
              rateColor: up,
              a11y: sentence([`${idx.name} ${formatIndexValue(idx.value)}${fx ? "원" : ""}`, speakRate(idx.changeRate), session]),
            }
          : null
      }
      quoteError={indices.isLoading ? "불러오는 중…" : "시세를 불러오지 못했습니다"}
      state={state}
      nav={null}
      onPrev={noop}
      onNext={noop}
      onBack={() => (router.canGoBack() ? router.back() : router.dismissTo("/"))}
      action={null}
    />
  );
  const chartBody = (height?: number) => (
    <>
      <CandleChart
        candles={candles.data?.candles}
        period={period}
        onPeriodChange={setPeriod}
        loading={candles.isLoading}
        currency="PT"
        quote={quote}
        hasVolume={hasVolume}
        height={height}
      />
      {candles.isError ? <Text style={{ color: t.danger, fontSize: font.small }}>{candles.error instanceof Error ? candles.error.message : "차트를 불러오지 못했습니다"}</Text> : null}
      {note ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{note}</Text> : null}
      <Text style={{ color: t.muted, fontSize: font.tiny }}>출처: 네이버 증권</Text>
    </>
  );
  // 좌우 여백 (가로로 든 폴드의 카메라 구멍 쪽)
  const sides = { paddingLeft: insets.left, paddingRight: insets.right };
  const strip = (
    <View style={sides}>
      <MarketStrip selected={code} onSelect={(c) => router.setParams({ code: c })} />
    </View>
  );

  if (mode === "split")
    return (
      <Screen scroll={false} top={header}>
        <Stack.Screen options={{ headerShown: false }} />
        {strip}
        {/* 지수 띠 아래 남은 높이(아래 작업 표시줄 여백을 뺀)에 차트를 맞춘다. 창이 아주 낮으면 이 칸만 스크롤된다 */}
        <View style={[styles.fill, sides, { paddingBottom: insets.bottom }]}>
          <View
            style={styles.fill}
            onLayout={(e) => {
              const h = Math.round(e.nativeEvent.layout.height);
              if (h !== bodyH) setBodyH(h);
            }}
          >
            <ScrollView
              style={styles.fill}
              refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} />}
            >
              <FillChart height={bodyH} style={{ backgroundColor: t.surface }} render={(h) => chartBody(h)} />
            </ScrollView>
          </View>
        </View>
      </Screen>
    );

  // 한 단(폴드8 펼침 세로 · 울트라 펼침 세로): 끝까지 내리면 출처 줄이 아래 작업 표시줄 위에 온다
  return (
    <Screen refreshing={pulling} onRefresh={onPull} top={header} contentStyle={{ paddingBottom: space.xl + insets.bottom }}>
      <Stack.Screen options={{ headerShown: false }} />
      {strip}
      <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line, paddingLeft: space.lg + insets.left, paddingRight: space.lg + insets.right }]}>{chartBody()}</View>
    </Screen>
  );
}

/** 지수 상세에는 이전·다음이 없다 (머리의 ‹ › 를 그리지 않는다) */
const noop = () => undefined;

const styles = StyleSheet.create({
  head: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.xxs },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: space.s, marginTop: space.xxs },
  bigPrice: { fontSize: font.hero, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
  change: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  panel: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm, marginTop: space.sm },
  fill: { flex: 1 },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
