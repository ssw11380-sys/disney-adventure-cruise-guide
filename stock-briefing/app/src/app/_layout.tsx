import { focusManager, QueryClient, useIsRestoring, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import React, { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NotificationBridge } from "@/components/NotificationBridge";
import { WidgetBridge } from "@/components/WidgetBridge";
import { ensureBackgroundTaskRegistered } from "@/lib/backgroundBriefings";
import { installErrorHandlers, setCurrentScreen } from "@/lib/errorReport";
import { LiveStreamProvider } from "@/lib/liveStream";
import { PERSIST_BUSTER, PERSIST_MAX_AGE_MS, queryPersister, shouldPersist } from "@/lib/queryPersist";
import { SettingsProvider, useSettings } from "@/lib/settings";
import { font, useTheme } from "@/theme";

// 가장 먼저: 이후 어디서 난 JS 오류든 서버로 보고한다 (토큰·금액은 지운 뒤)
installErrorHandlers();

// 저장된 설정(라이트/다크)과 마지막 잔고를 읽을 때까지 스플래시를 둔다 → 라이트 모드에서 어두운 첫 화면이 번쩍이지 않게.
// 읽기가 늦어도 1.5초 뒤에는 연다
void SplashScreen.preventAutoHideAsync().catch(() => undefined);
let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  try {
    SplashScreen.hide();
  } catch {
    /* 웹 등 */
  }
}
setTimeout(hideSplash, 1_500);

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

/** 설정·저장된 캐시를 다 읽으면 스플래시를 내린다 */
function SplashGate() {
  const { ready } = useSettings();
  const restoring = useIsRestoring();
  useEffect(() => {
    if (ready && !restoring) hideSplash();
  }, [ready, restoring]);
  return null;
}

/**
 * 토큰을 바꾸면 이전 토큰으로 받은 캐시(401 오류 포함)를 버리고 새로 받는다.
 * 쿼리 키에 토큰을 넣지 않는 대신 여기서 처리한다(토큰이 저장 캐시 키에 남지 않게).
 */
function CredentialWatcher() {
  const { apiToken, ready } = useSettings();
  const qc = useQueryClient();
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (prev.current !== null && prev.current !== apiToken) {
      // 이전 토큰으로 받은 캐시를 비우고(기기에 저장된 것도) 보고 있는 화면은 새 토큰으로 다시 받는다
      void queryPersister.removeClient();
      void qc.resetQueries();
    }
    prev.current = apiToken;
  }, [apiToken, ready, qc]);
  return null;
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
        headerTitleStyle: { fontWeight: "700", fontSize: font.h2 },
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
      <Stack.Screen name="briefings/account/[id]" options={{ title: "계좌 브리핑" }} />
      <Stack.Screen name="market/[code]" options={{ title: "지수" }} />
      <Stack.Screen name="discover/theme/[id]" options={{ title: "테마" }} />
      <Stack.Screen name="portfolio/allocation" options={{ title: "비중" }} />
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
          <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{
              persister: queryPersister,
              maxAge: PERSIST_MAX_AGE_MS,
              buster: PERSIST_BUSTER,
              dehydrateOptions: { shouldDehydrateQuery: (q) => shouldPersist(q.queryKey, q.state, Date.now()), shouldDehydrateMutation: () => false },
            }}
          >
            <SplashGate />
            <CredentialWatcher />
            <LiveStreamProvider>
              <ThemedStatusBar />
              <NotificationBridge />
              <WidgetBridge />
              <ScreenTracker />
              <Navigator />
            </LiveStreamProvider>
          </PersistQueryClientProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// 레이아웃 자체(탭 머리·공통 제공자)에서 난 렌더 오류도 앱을 끄지 않고 "다시 시도" 화면으로, 서버에 보고
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
