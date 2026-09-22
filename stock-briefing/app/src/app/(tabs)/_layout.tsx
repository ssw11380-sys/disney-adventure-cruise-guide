import { Ionicons } from "@expo/vector-icons";
import { router, Tabs } from "expo-router";
import React from "react";
import { Pressable } from "react-native";
import { useTheme } from "@/theme";

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.ink,
        headerTitleStyle: { fontWeight: "800", fontSize: 20, letterSpacing: -0.3 },
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line, height: 60, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600", marginBottom: 6 },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.muted,
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "내 종목",
          tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? "briefcase" : "briefcase-outline"} size={size} color={color} />,
          // 목록 위에 떠 있던 + 버튼이 종목 행을 가려서 헤더 오른쪽으로 옮겼다
          headerRight: () => (
            <Pressable onPress={() => router.push("/stocks/add")} accessibilityRole="button" accessibilityLabel="종목 등록" hitSlop={8} style={{ marginRight: 16, width: 34, height: 34, borderRadius: 17, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="add" size={22} color={t.accentInk} />
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="briefings"
        options={{ title: "브리핑", tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? "newspaper" : "newspaper-outline"} size={size} color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "설정", tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? "settings" : "settings-outline"} size={size} color={color} /> }}
      />
    </Tabs>
  );
}
