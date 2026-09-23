import { Ionicons } from "@expo/vector-icons";
import { router, Tabs } from "expo-router";
import React from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme";

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const icon = (name: keyof typeof Ionicons.glyphMap, onPress: () => void, label: string) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={10} style={{ paddingHorizontal: 8 }}>
      <Ionicons name={name} size={21} color={t.ink} />
    </Pressable>
  );
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface, height: 52 + insets.top },
        headerTintColor: t.ink,
        headerTitleAlign: "left",
        headerTitleStyle: { fontWeight: "700", fontSize: 17 },
        headerShadowVisible: false,
        // 고정 height 를 주면 시스템 내비게이션 바(제스처/3버튼) 영역이 무시되어 탭이 그 밑에 깔린다 → 인셋만큼 더한다
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line, height: 58 + insets.bottom, paddingTop: 6, paddingBottom: insets.bottom + 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarActiveTintColor: t.ink,
        tabBarInactiveTintColor: t.muted,
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "잔고",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "wallet" : "wallet-outline"} size={21} color={color} />,
          headerRight: () => <View style={{ flexDirection: "row", marginRight: 8 }}>{icon("search", () => router.push("/stocks/add"), "종목 검색")}</View>,
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: "발견",
          tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "compass" : "compass-outline"} size={22} color={color} />,
          headerRight: () => <View style={{ flexDirection: "row", marginRight: 8 }}>{icon("search", () => router.push("/stocks/add"), "종목 검색")}</View>,
        }}
      />
      <Tabs.Screen
        name="briefings"
        options={{ title: "브리핑", tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "document-text" : "document-text-outline"} size={21} color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "설정", tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? "options" : "options-outline"} size={21} color={color} /> }}
      />
    </Tabs>
  );
}

// 레이아웃 자체(탭 머리·공통 제공자)에서 난 렌더 오류도 앱을 끄지 않고 "다시 시도" 화면으로, 서버에 보고
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
