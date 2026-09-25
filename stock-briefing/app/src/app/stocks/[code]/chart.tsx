import { Ionicons } from "@expo/vector-icons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCandles, useStock } from "@/api/hooks";
import type { CandlePeriod } from "@/api/types";
import { CandleChart } from "@/components/CandleChart";
import { ChartNotice } from "@/components/Freshness";
import { ChangeText, ErrorView } from "@/components/ui";
import { CHART_ICON_BTN, chartHeaderLayout } from "@/lib/chartLayout";
import { CANDLE_COUNT, parseCandlePeriod } from "@/lib/chartPrefs";
import { currencyOfMarket, formatPct, formatPrice } from "@/lib/format";
import { parseStockCode } from "@/lib/freshness";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { font, fontCap, slopFor, space, useTheme } from "@/theme";

/**
 * 전체 화면 차트. 앱은 세로 고정이라 "가로" 버튼을 누르면 화면을 90도 돌려 그린다(가로 모드처럼 넓게).
 * 제스처 좌표는 회전된 뷰 기준으로 들어오므로 그대로 동작한다.
 *
 * 창이 이미 가로면 돌리지 않는다. 안드로이드 16 부터 큰 화면(펼친 접는 폰 안쪽 화면 등)은 앱의 세로 고정을 무시하고
 * 폰을 따라 가로로 돈다 → 거기서 또 90도 돌리면 차트가 옆으로 눕는다. 가로 창에서는 창을 그대로 쓰고 가로 버튼을 끈다.
 * 넓은 창 배치(3-42, 플래그 foldLayout)가 켜져 있으면 꺼진 버튼을 흐리게 두지 않고 아예 숨겨 닫기만 남긴다 (폴드 진단 26번).
 *
 * 머리(폴드 진단 8번): 이름이 길면 이름만 '…'로 줄이고 가격·등락은 한 줄 그대로. 그래도 좁으면(바깥 화면 + 큰 글씨)
 * 가격·등락을 이름 아래 둘째 줄로 내린다. 머리 높이는 최소 44 에 글자 배율(fontCap.chrome 까지)을 반영한다 (lib/chartLayout).
 * 한 번 두 줄이 되면 같은 창·글자 크기·종목에서는 시세가 바뀌어도 두 줄 그대로 둔다 (머리·차트 높이가 틱마다 뛰지 않게)
 */
export default function FullscreenChartScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH, fontScale } = useWindowDimensions();
  const fold = useFoldLayout();
  const { code, period: initial } = useLocalSearchParams<{ code: string; period?: string }>();
  // 다른 앱·웹 페이지도 이 주소를 열 수 있다 → 상세 화면처럼 검증을 통과한 코드만 서버에 묻고, 모르는 기간은 일봉으로 (BH-36)
  const c = parseStockCode(code) ?? "";
  const [period, setPeriod] = useState<CandlePeriod>(() => parseCandlePeriod(initial));
  const winLandscape = winW > winH;
  // 가로 창에서 돌리기 버튼: 플래그가 꺼져 있으면 지금처럼 흐리게 꺼 두고, 켜져 있으면 숨긴다
  const hideRotate = fold.on && winLandscape;
  // 가로 버튼 상태와 그때의 창 크기. 창이 바뀌면(폰을 돌림·접음·폄·창 크기 조절) 그리는 중에 바로 돌리기를 푼다
  // → 가로 창에서 두 번 돌지 않고, 같은 크기의 세로 창으로 돌아와도 옆으로 누운 차트가 갑자기 나오지 않는다
  const winKey = `${Math.round(winW)}x${Math.round(winH)}`;
  const [rotation, setRotation] = useState({ on: false, win: winKey });
  if (rotation.win !== winKey) setRotation({ on: false, win: winKey });
  const landscape = !winLandscape && rotation.on && rotation.win === winKey;
  // 차트 아래·위 도구 모음(기간·봉 수·읽기 줄·오버레이 줄)의 실제 높이. 글자 크기·화면 폭에 따라 달라지므로 그려 본 뒤 잰다.
  // 늘어날 때만 반영한다(방향·폭이 바뀌면 새로) → 십자선을 움직일 때 읽기 줄이 한 줄 늘었다 줄었다 해도 차트 높이가 흔들리지 않는다
  const [chrome, setChrome] = useState<{ key: string; h: number }>({ key: "", h: 170 });
  // 머리를 두 줄로 정했는지와 그때의 배치(창 폭·글자 배율·버튼 수·이름). 같은 배치에서 두 줄이 되면 시세가 바뀌어도 두 줄로 둔다
  // (등락 +990원 ↔ +1,000원을 오갈 때마다 머리 44 ↔ 62, 차트 높이가 뛰지 않게). 배치가 바뀌면 새로 정한다
  const [headMemo, setHeadMemo] = useState<{ key: string; twoLines: boolean }>({ key: "", twoLines: false });
  const stock = useStock(c);
  const candles = useCandles(c, period, CANDLE_COUNT[period]);
  const s = stock.data;
  const q = s?.quote ?? null;
  const cur = q?.currency ?? currencyOfMarket(s?.market);
  const name = s?.name ?? c;
  const priceText = q ? formatPrice(q.price, cur) : null;
  const changeText = q ? `${formatPrice(q.change, cur, { sign: true })} (${formatPct(q.changeRate)})` : null;

  const pad = space.md;
  // 상태바·내비게이션 바·화면 구멍 영역은 피한다 (가로 창에서는 왼쪽·오른쪽에 올 수 있다)
  const frameW = winW - insets.left - insets.right;
  const frameH = winH - insets.top - insets.bottom;
  // 돌려 그리면 폭·높이가 바뀐다
  const availW = landscape ? frameH : frameW;
  const availH = landscape ? frameW : frameH;
  const chartW = availW - pad * 2;
  // 머리: 한 줄에 다 들어가는지, 가격·등락을 둘째 줄로 내릴지, 높이 (글자 배율은 fontCap.chrome 까지)
  const headButtons = hideRotate ? 1 : 2;
  const headKey = `${Math.round(chartW)}:${fontScale}:${headButtons}:${name}`;
  const head = chartHeaderLayout({
    width: chartW,
    fontScale,
    name,
    price: priceText,
    change: changeText,
    buttons: headButtons,
    prevTwoLines: headMemo.key === headKey ? headMemo.twoLines : undefined,
  });
  // 그리는 중에 바로 기억한다 (위 rotation 과 같은 방식 — 같은 값이면 다시 그리지 않는다)
  if (headMemo.key !== headKey || headMemo.twoLines !== head.twoLines) setHeadMemo({ key: headKey, twoLines: head.twoLines });
  const headerH = head.height;
  // 남는 높이에서 도구 모음 높이를 뺀 만큼만 차트로 → 하단 토글이 화면 밖으로 잘리지 않는다
  const layoutKey = `${landscape ? "L" : "P"}:${Math.round(chartW)}`;
  const chromeH = chrome.key === layoutKey ? chrome.h : 170;
  const chartH = Math.max(160, availH - headerH - chromeH - space.sm);

  if (!c) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
        <ErrorView error={new Error("종목 주소가 올바르지 않습니다")} retryLabel="잔고로" onRetry={() => router.dismissTo("/")} />
      </View>
    );
  }

  // 이름은 먼저 줄어들고('…'), 가격·등락은 줄지 않는다. 머리 글자는 fontCap.chrome(150%) 까지만 커진다
  const nameText = (
    <Text style={[styles.name, { color: t.ink }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome}>
      {name}
    </Text>
  );
  const quoteTexts = q ? (
    <>
      <Text style={[styles.price, { color: t.ink }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome}>
        {priceText}
      </Text>
      <ChangeText value={q.change} text={changeText ?? ""} style={styles.change} numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome} />
    </>
  ) : null;
  const buttons = (
    <View style={styles.buttons}>
      {hideRotate ? null : (
        // 이미 가로 창이면 돌릴 것이 없어 끈다 (화면 읽기로는 까닭을 말한다). 넓은 창 배치가 켜져 있으면 위 hideRotate 로 숨긴다
        <Pressable
          onPress={() => setRotation({ on: !landscape, win: winKey })}
          disabled={winLandscape}
          accessibilityRole="button"
          accessibilityLabel={landscape ? "세로로 보기" : "가로로 보기"}
          accessibilityHint={winLandscape ? "이미 가로 화면이라 차트를 돌리지 않습니다" : undefined}
          accessibilityState={{ disabled: winLandscape }}
          hitSlop={slopFor(CHART_ICON_BTN, space.xs)}
          style={[styles.iconBtn, { borderColor: t.line, opacity: winLandscape ? OFF_OPACITY : 1 }]}
        >
          <Ionicons name={landscape ? "phone-portrait-outline" : "phone-landscape-outline"} size={18} color={winLandscape ? t.muted : t.ink} />
        </Pressable>
      )}
      <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="차트 닫기" hitSlop={slopFor(CHART_ICON_BTN, space.xs)} style={[styles.iconBtn, { borderColor: t.line }]}>
        <Ionicons name="close" size={18} color={t.ink} />
      </Pressable>
    </View>
  );

  const body = (
    <View style={{ width: availW, height: availH, backgroundColor: t.bg, paddingHorizontal: pad }}>
      {/* 머리: 높이는 최소값(겹치지 않게 글자에 맞춰 늘어날 수 있다). 두 줄이면 [이름 · 버튼] 아래 [가격 · 등락] */}
      <View style={[styles.header, { minHeight: headerH }]}>
        {head.twoLines ? (
          <>
            <View style={styles.headerRow}>
              {nameText}
              {buttons}
            </View>
            <View style={styles.quoteRow}>{quoteTexts}</View>
          </>
        ) : (
          <View style={styles.headerRow}>
            <View style={styles.titleRow}>
              {nameText}
              {quoteTexts}
            </View>
            {buttons}
          </View>
        )}
      </View>
      <View
        onLayout={(e) => {
          // 도구 모음 높이 = 전체 높이 − 차트 높이. 새 배치면 그대로, 같은 배치면 1px 넘게 늘었을 때만(무한 반복·흔들림 방지)
          const next = Math.ceil(e.nativeEvent.layout.height - chartH);
          if (next <= 0) return;
          if (chrome.key !== layoutKey || next > chrome.h + 1) setChrome({ key: layoutKey, h: next });
        }}
      >
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
        backdrop={t.bg}
      />
      </View>
      <ChartNotice query={candles} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }}>
      <Stack.Screen options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
      {landscape ? (
        <View style={{ width: frameW, height: frameH, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: availW, height: availH, transform: [{ rotate: "90deg" }] }}>{body}</View>
        </View>
      ) : (
        body
      )}
    </View>
  );
}

/** 꺼진 버튼 흐림 (ui 의 Button 과 같은 값) */
const OFF_OPACITY = 0.45;

const styles = StyleSheet.create({
  header: { justifyContent: "center", gap: space.xxs },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  // 한 줄 머리의 글자 묶음: 버튼 자리를 뺀 폭 안에서 줄어든다 (그 안에서는 이름만 줄어든다)
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: space.sm, flexShrink: 1 },
  // 두 줄 머리의 둘째 줄: 가격·등락. 아주 좁은 창이면 등락을 가격 아래로 (숫자를 자르지 않게)
  quoteRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm },
  name: { fontSize: font.h2, fontWeight: "700", flexShrink: 1 },
  price: { fontSize: font.body, fontVariant: ["tabular-nums"], flexShrink: 0 },
  change: { fontSize: font.small, flexShrink: 0 },
  buttons: { flexDirection: "row", gap: space.sm, flexShrink: 0 },
  iconBtn: { width: CHART_ICON_BTN, height: CHART_ICON_BTN, borderRadius: CHART_ICON_BTN / 2, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
