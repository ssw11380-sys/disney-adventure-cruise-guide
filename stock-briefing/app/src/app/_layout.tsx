import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import React, { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NotificationBridge } from "@/components/NotificationBridge";
import { ensureBackgroundTaskRegistered } from "@/lib/backgroundBriefings";
import { installErrorHandlers, setCurrentScreen } from "@/lib/errorReport";
import { LiveStreamProvider } from "@/lib/liveStream";
import { SettingsProvider } from "@/lib/settings";
import { useTheme } from "@/theme";

// 가장 먼저: 이후 어디서 난 JS 오류든 서버로 보고한다 (토큰·금액은 지운 뒤)
installErrorHandlers();

/**
 * 위젯·알림 딥링크로 상세 화면부터 열어도 그 아래에 탭(잔고)을 깔아 둔다 → 뒤로 가면 앱이 닫히지 않고 잔고로 간다.
 */
export const unstable_settings = { anchor: "(tabs)" };

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** 상태바 글자색 + 루트 배경(화면 전환·키보드 뒤로 비치는 색)을 테마에 맞춘다 */
function ThemedStatusBar() {
  const t = useTheme();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.bg).catch(() => undefined);
  }, [t.bg]);
  return <StatusBar style={t.dark ? "light" : "dark"} />;
}

/** 오류 보고에 "어느 화면에서" 를 붙이기 위해 현재 경로를 알려 둔다 */
function ScreenTracker() {
  const path = usePathname();
  useEffect(() => setCurrentScreen(path), [path]);
  return null;
}

function Navigator() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.ink,
        headerTitleStyle: { fontWeight: "700", fontSize: 17 },
        headerTitleAlign: "left",
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.bg },
        headerBackTitle: "뒤로",
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="stocks/add" options={{ title: "종목 검색", presentation: "modal" }} />
      <Stack.Screen name="stocks/[code]/index" options={{ title: "종목" }} />
      <Stack.Screen name="stocks/[code]/edit" options={{ title: "잔고 수정", presentation: "modal" }} />
      <Stack.Screen name="stocks/[code]/chart" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
      <Stack.Screen name="briefings/[id]" options={{ title: "브리핑" }} />
      <Stack.Screen name="market/[code]" options={{ title: "지수" }} />
      <Stack.Screen name="discover/theme/[id]" options={{ title: "테마" }} />
    </Stack>
  );
}

export default function RootLayout() {
  // 앱이 뒤로 가면 react-query 의 주기적 갱신(실시간 시세 3초)을 멈추고, 다시 열면 재개한다
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => focusManager.setFocused(state === "active"));
    void ensureBackgroundTaskRegistered();
    return () => sub.remove();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SettingsProvider>
          <QueryClientProvider client={queryClient}>
            <LiveStreamProvider>
              <ThemedStatusBar />
              <NotificationBridge />
              <ScreenTracker />
              <Navigator />
            </LiveStreamProvider>
          </QueryClientProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
