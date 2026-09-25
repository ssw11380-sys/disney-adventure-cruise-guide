import { Ionicons } from "@expo/vector-icons";
import { router, Tabs } from "expo-router";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { headerH, TAB_ICON as ICON, tabBarH } from "@/lib/textScale";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide, railWidth } from "@/lib/windowClass";
import { font, fontCap, slopFor, space, useFontScale, useTheme } from "@/theme";

/**
 * 넓은 창(폭 등급 중간 이상 + 플래그 foldLayout)에서 탭 화면 머리(52)를 숨기는 탭 (3-42 공통 틀).
 * 숨기는 탭은 제 화면 안에 이름·검색을 직접 그린다 — 잔고: 맨 위 띠 오른쪽 끝의 검색 버튼 (app/(tabs)/index).
 * 아직 넓은 창 배치가 없는 탭은 머리를 그대로 둔다 (제 화면을 넓은 창용으로 바꿀 때 여기서 켠다)
 */
const WIDE_HEADERLESS: Readonly<Record<"index" | "discover" | "briefings" | "settings", boolean>> = { index: true, discover: false, briefings: false, settings: false };

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // 탭 이름은 150% 까지 키우고 그만큼 탭 바를 높인다 → 200% 에서도 이름이 잘리지 않는다. 머리 제목은 상한 없이 200% 까지 (lib/textScale)
  const scale = useFontScale();
  const tabH = tabBarH(scale);
  const headH = headerH(scale);
  // 넓고 높이가 짧은 창(펼친 폴드8 가로 933×704 등)은 탭을 왼쪽 세로 막대로 옮겨 세로 공간을 되찾는다 (3-42, 플래그 foldLayout).
  // 플래그가 꺼져 있거나 그 밖의 창은 지금처럼 아래 탭 바
  const fold = useFoldLayout();
  const { rail } = fold;
  const wide = fold.on && isWide(fold);
  // 탭마다: 넓은 창이면 머리를 숨길지, 세로 막대면 탭 묶음을 막대 세로 가운데로 (첫 탭 위·마지막 탭 아래 여백을 자동으로 나눠 가짐 —
  // 라이브러리의 세로 막대 안쪽 칸이 flex:1 세로 줄이라 margin 'auto' 로 가운데에 모인다. 직접 그리는 탭 막대는 필요 없다)
  const perTab = (name: keyof typeof WIDE_HEADERLESS, edge?: "first" | "last") => ({
    ...(wide && WIDE_HEADERLESS[name] ? { headerShown: false } : null),
    ...(rail && edge ? { tabBarItemStyle: edge === "first" ? { marginTop: "auto" as const } : { marginBottom: "auto" as const } } : null),
  });
  const icon = (name: keyof typeof Ionicons.glyphMap, onPress: () => void, label: string) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={slopFor(ICON, space.sm)} style={{ paddingHorizontal: space.sm }}>
      <Ionicons name={name} size={ICON} color={t.ink} />
    </Pressable>
  );
  const bar = rail
    ? {
        tabBarPosition: "left" as const,
        // 세로 막대에서 이름을 아이콘 아래에 두려면 material 모양이어야 한다 (uikit 은 옆으로만 — 라이브러리가 오류를 낸다)
        tabBarVariant: "material" as const,
        tabBarActiveBackgroundColor: t.surfaceAlt,
        // 높이·위아래 여백은 주지 않는다: 세로 막대는 화면 높이를 다 쓰고, 라이브러리가 위아래·왼쪽 화면 여백을 더한다. 폭에는 왼쪽 여백을 더한다
        tabBarStyle: { backgroundColor: t.surface, borderColor: t.line, width: railWidth(scale) + insets.left },
        // 아래 탭 바가 없으니 시스템 내비게이션 바(제스처·3버튼·작업 표시줄) 자리는 탭 화면 아래 여백으로 비운다
        // → 브리핑 탭 고지 한 줄과 잔고·발견·설정 목록의 끝이 그 밑에 깔리지 않는다 (고지는 탭 안에서 이 여백을 믿고 작은 여백만 둔다 — components/Screen Disclaimer)
        sceneStyle: { backgroundColor: t.bg, paddingBottom: insets.bottom },
        // 화면 머리: 왼쪽 화면 여백(카메라 구멍 등)은 세로 막대가 이미 차지했으므로, 라이브러리가 머리 왼쪽에 또 더하는 여백을 뺀다
        headerLeftContainerStyle: { marginStart: 0 },
      }
    : {
        // 고정 height 를 주면 시스템 내비게이션 바(제스처/3버튼) 영역이 무시되어 탭이 그 밑에 깔린다 → 인셋만큼 더한다
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line, height: tabH + insets.bottom, paddingTop: space.s, paddingBottom: insets.bottom + space.s },
        sceneStyle: { backgroundColor: t.bg },
      };
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface, height: headH + insets.top },
        headerTintColor: t.ink,
        headerTitleAlign: "left",
        headerTitleStyle: { fontWeight: "700", fontSize: font.h2 },
        headerShadowVisible: false,
        ...bar,
        // 탭 이름은 늘 아이콘 아래 (3-42 버그 수정, 플래그와 상관없음): 정하지 않으면 라이브러리가 창 폭 768dp 이상에서 아이콘 옆으로 옮겨,
        // 펼친 폴드8 을 돌릴 때마다(704 ↔ 933) 탭 바 모양이 바뀌었다
        tabBarLabelPosition: "below-icon",
        // 탭 이름: 글자 확대는 150% 까지, 폭이 모자라면 줄여서 한 줄에 (말줄임 없이)
        tabBarLabel: ({ color, children }) => (
          // flexShrink 0: 탭 칸이 좁아도 글자 높이를 눌러 자르지 않는다
          <Text style={{ color, fontSize: font.tiny, fontWeight: "600", flexShrink: 0 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} maxFontSizeMultiplier={fontCap.chrome}>
            {children}
          </Text>
        ),
        tabBarActiveTintColor: t.ink,
        tabBarInactiveTintColor: t.muted,
        // 보이지 않는 탭은 얼려 둔다: 체결·폴링으로 캐시가 바뀌어도 숨은 탭은 다시 그리지 않는다 (3-17)
        freezeOnBlur: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "잔고",
          tabBarAccessibilityLabel: "잔고",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "wallet" : "wallet-outline"} size={ICON} color={color} />,
          headerRight: () => <View style={{ flexDirection: "row", marginRight: space.sm }}>{icon("search", () => router.push("/stocks/add"), "종목 검색")}</View>,
          ...perTab("index", "first"),
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: "발견",
          tabBarAccessibilityLabel: "발견",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "compass" : "compass-outline"} size={ICON + 1} color={color} />,
          headerRight: () => <View style={{ flexDirection: "row", marginRight: space.sm }}>{icon("search", () => router.push("/stocks/add"), "종목 검색")}</View>,
          ...perTab("discover"),
        }}
      />
      <Tabs.Screen
        name="briefings"
        options={{
          title: "브리핑",
          tabBarAccessibilityLabel: "브리핑",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "document-text" : "document-text-outline"} size={ICON} color={color} />,
          ...perTab("briefings"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "설정",
          tabBarAccessibilityLabel: "설정",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "options" : "options-outline"} size={ICON} color={color} />,
          ...perTab("settings", "last"),
        }}
      />
    </Tabs>
  );
}

// 레이아웃 자체(탭 머리·공통 제공자)에서 난 렌더 오류도 앱을 끄지 않고 "다시 시도" 화면으로, 서버에 보고
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
