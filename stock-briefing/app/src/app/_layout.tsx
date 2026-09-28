import { focusManager, QueryClient, useIsRestoring, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack, usePathname } from "expo-router";
import * as Haptics from "expo-haptics";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import React, { useEffect, useRef } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
// 계정 A단계: 로그인 세션 저장소(AsyncStorage)를 가장 먼저 끼우고 읽기 시작한다 (첫 요청부터 세션을 붙이게)
import "@/lib/sessionStorage";
import { AuthBridge } from "@/components/AuthBridge";
import { InitialPasswordSheet } from "@/components/auth/InitialPasswordSheet";
import { NotificationBridge } from "@/components/NotificationBridge";
import { PriceAlertProvider } from "@/components/PriceAlertProvider";
import { ConnectionWordingBridge, FirstRunGate, GuideMarksProvider, HapticsBridge, UxFlagsProvider } from "@/components/UxBridge";
import { WidgetBridge } from "@/components/WidgetBridge";
import { ensureBackgroundTaskRegistered } from "@/lib/backgroundBriefings";
import { installErrorHandlers, setCurrentScreen } from "@/lib/errorReport";
import { installHaptics, type HapticEngine } from "@/lib/haptics";
import { LiveStreamProvider } from "@/lib/liveStream";
import { useAccountView } from "@/lib/account";
import { useAuthGate } from "@/lib/authGate";
import { setBeforeLogout, setPushRebind } from "@/lib/logout";
import { detachPush, postPriceAlert, rebindPush } from "@/lib/notifications";
import { onAccountChange, persistsPersonal } from "@/lib/session";
import { clearWidgetAccountData, signedOutWidgetData } from "@/widgets/data";
import { redrawAllWidgets } from "@/widgets/redraw";
import { installPriceAlertNotifier } from "@/lib/priceAlerts";
import { PERSIST_BUSTER, PERSIST_MAX_AGE_MS, queryPersister, shouldPersist } from "@/lib/queryPersist";
import { SettingsProvider, useSettings } from "@/lib/settings";
import { font, useTheme } from "@/theme";
import { authColors } from "@/tokens";

// 가장 먼저: 이후 어디서 난 JS 오류든 서버로 보고한다 (토큰·금액은 지운 뒤)
installErrorHandlers();
// 햅틱 엔진 (3-24): expo-haptics 는 APK 에 이미 있다(차트 십자선이 써 왔음). 울릴지는 lib/haptics 가 플래그·설정으로 정한다
installHaptics(Haptics as unknown as HapticEngine, Platform.OS);
// 가격 알림(3-29)을 휴대폰 알림 목록에 올리는 함수 (권한이 이미 있을 때만, 소리 없이). 울릴지는 PriceAlertProvider 가 플래그로 정한다
installPriceAlertNotifier(postPriceAlert);
// 주인 계정이 로그아웃하면 이 기기의 알림 등록을 먼저 서버에서 뺀다 (로그아웃한 폰으로 브리핑 알림이 가지 않게, 계정 A단계).
// 기기에 적어 둔 알림 토큰은 남겨, 주인으로 다시 로그인하면(또는 비밀번호를 바꾸면) 새 세션으로 다시 등록한다
setBeforeLogout((api) => detachPush(api));
setPushRebind((api) => rebindPush(api));
// 계정이 바뀌면(로그아웃·세션 끊김·다른 사람 로그인) 위젯이 적어 둔 앞 사람의 잔고·브리핑을 지우고 '로그인 필요' 빈 위젯으로 다시 그린다.
// 새 계정의 잔고를 받으면 WidgetBridge 가 다시 채운다 (react-query 캐시 비우기는 AuthBridge 가 같은 자리에서)
onAccountChange(() => void clearWidgetAccountData().then(() => redrawAllWidgets(signedOutWidgetData())));

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

/** 설정·저장된 캐시·로그인 세션을 다 읽으면 스플래시를 내린다 */
function SplashGate() {
  const { ready } = useSettings();
  const restoring = useIsRestoring();
  const gate = useAuthGate();
  useEffect(() => {
    if (ready && !restoring && gate.ready) hideSplash();
  }, [ready, restoring, gate.ready]);
  return null;
}

/** 첫 실행 안내(3-24)는 로그인한 뒤에만, 주인 아닌 계정에는 띄우지 않는다 (위젯·알림·토스 이야기라 — 계정 A단계) */
function FirstRunAfterLogin() {
  const gate = useAuthGate();
  const { member } = useAccountView();
  if (gate.needsLogin || member) return null;
  return <FirstRunGate />;
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
      // 이전 토큰으로 받은 캐시를 비우고(기기에 저장된 것도) 보고 있는 화면은 새 토큰으로 다시 받는다.
      // 다시 받기는 이번 그리기의 효과가 모두 끝난 뒤에 — 화면의 쿼리가 새 토큰의 요청 함수를 받기 전에 다시 받으면 옛 토큰으로 묻는다 (검증 지적)
      void queryPersister.removeClient();
      setTimeout(() => void qc.resetQueries(), 0);
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

/**
 * 화면 목록. 계정 A단계(플래그 accounts): 로그인이 필요하면(세션 없음 + 계정 모드) 앱 화면을 닫고 로그인·회원가입만 연다 (Stack.Protected —
 * 로그인하면 저절로 앱으로). '서버 설정'은 로그인 없이도 열린다. 플래그가 꺼져 있거나 예전 서버면 로그인 화면이 없다 (지금과 같음)
 */
function Navigator() {
  const t = useTheme();
  const gate = useAuthGate();
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
      <Stack.Protected guard={!gate.needsLogin}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="stocks/add" options={{ title: "종목 검색", presentation: "modal" }} />
      <Stack.Screen name="stocks/[code]/index" options={{ title: "종목" }} />
      <Stack.Screen name="stocks/[code]/edit" options={{ title: "잔고 수정", presentation: "modal" }} />
      <Stack.Screen name="stocks/[code]/chart" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
      <Stack.Screen name="briefings/[id]" options={{ title: "브리핑" }} />
      <Stack.Screen name="briefings/account/[id]" options={{ title: "계좌 브리핑" }} />
      <Stack.Screen name="briefings/market/[id]" options={{ title: "시장 요약" }} />
      <Stack.Screen name="market/[code]" options={{ title: "지수" }} />
      <Stack.Screen name="discover/theme/[id]" options={{ title: "테마" }} />
      <Stack.Screen name="portfolio/allocation" options={{ title: "비중" }} />
      {/* 이동평균선 기간·색 (3-39, 기능 플래그 maCustom — 꺼져 있으면 화면 안에 안내만) */}
      <Stack.Screen name="chart-lines" options={{ title: "이동평균선", presentation: "modal" }} />
      {/* 첫 실행 안내 (3-24, 플래그 firstRun): 머리 없이 한 화면, 뒤로 가기·'시작하기'로 닫힌다 */}
      <Stack.Screen name="welcome" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
      {/* 비밀번호 바꾸기 (설정 > 계정) */}
      <Stack.Screen name="account/password" options={{ title: "비밀번호 바꾸기" }} />
      </Stack.Protected>
      <Stack.Protected guard={gate.needsLogin}>
        {/* 로그인·회원가입: 늘 어두운 고급 화면, 머리 없음 */}
        <Stack.Screen name="login" options={{ headerShown: false, animation: "fade", contentStyle: { backgroundColor: authColors.bgBottom } }} />
        <Stack.Screen name="signup" options={{ headerShown: false, contentStyle: { backgroundColor: authColors.bgBottom } }} />
      </Stack.Protected>
      <Stack.Screen name="server" options={{ title: "서버 설정" }} />
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
              dehydrateOptions: { shouldDehydrateQuery: (q) => shouldPersist(q.queryKey, q.state, Date.now(), persistsPersonal), shouldDehydrateMutation: () => false },
            }}
          >
            <SplashGate />
            <CredentialWatcher />
            <AuthBridge />
            <LiveStreamProvider>
              {/* 3-24 플래그(oneHand·firstRun·emptyGuide)를 한 번 받아 아래 화면에 내려 준다 */}
              <UxFlagsProvider>
                <GuideMarksProvider>
                  {/* 가격 알림 (3-29, 플래그 priceAlerts): 조건 목록·확인 엔진·화면 위 알림 카드·알림 시트. 꺼져 있으면 아래를 그대로 그리기만 한다 */}
                  <PriceAlertProvider>
                    <ThemedStatusBar />
                    <NotificationBridge />
                    <WidgetBridge />
                    <ScreenTracker />
                    <HapticsBridge />
                    <ConnectionWordingBridge />
                    <Navigator />
                    <FirstRunAfterLogin />
                    <InitialPasswordSheet />
                  </PriceAlertProvider>
                </GuideMarksProvider>
              </UxFlagsProvider>
            </LiveStreamProvider>
          </PersistQueryClientProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// 레이아웃 자체(탭 머리·공통 제공자)에서 난 렌더 오류도 앱을 끄지 않고 "다시 시도" 화면으로, 서버에 보고
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
