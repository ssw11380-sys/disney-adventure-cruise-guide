import { Ionicons } from "@expo/vector-icons";
import { router, Tabs } from "expo-router";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { headerH, TAB_ICON as ICON, tabBarH } from "@/lib/textScale";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { railWidth } from "@/lib/windowClass";
import { font, fontCap, slopFor, space, useFontScale, useTheme } from "@/theme";

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // 탭 이름은 150% 까지 키우고 그만큼 탭 바를 높인다 → 200% 에서도 이름이 잘리지 않는다. 머리 제목은 상한 없이 200% 까지 (lib/textScale)
  const scale = useFontScale();
  const tabH = tabBarH(scale);
  const headH = headerH(scale);
  // 넓고 높이가 짧은 창(펼친 폴드8 가로 933×704 등)은 탭을 왼쪽 세로 막대로 옮겨 세로 공간을 되찾는다 (3-42, 플래그 foldLayout).
  // 플래그가 꺼져 있거나 그 밖의 창은 지금처럼 아래 탭 바
  const { rail } = useFoldLayout();
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
      }
    : {
        // 고정 height 를 주면 시스템 내비게이션 바(제스처/3버튼) 영역이 무시되어 탭이 그 밑에 깔린다 → 인셋만큼 더한다
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line, height: tabH + insets.bottom, paddingTop: space.s, paddingBottom: insets.bottom + space.s },
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
        sceneStyle: { backgroundColor: t.bg },
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
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: "발견",
          tabBarAccessibilityLabel: "발견",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "compass" : "compass-outline"} size={ICON + 1} color={color} />,
          headerRight: () => <View style={{ flexDirection: "row", marginRight: space.sm }}>{icon("search", () => router.push("/stocks/add"), "종목 검색")}</View>,
        }}
      />
      <Tabs.Screen
        name="briefings"
        options={{ title: "브리핑", tabBarAccessibilityLabel: "브리핑", tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "document-text" : "document-text-outline"} size={ICON} color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "설정", tabBarAccessibilityLabel: "설정", tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "options" : "options-outline"} size={ICON} color={color} /> }}
      />
    </Tabs>
  );
}

// 레이아웃 자체(탭 머리·공통 제공자)에서 난 렌더 오류도 앱을 끄지 않고 "다시 시도" 화면으로, 서버에 보고
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
