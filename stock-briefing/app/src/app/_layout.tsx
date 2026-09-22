import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SettingsProvider } from "@/lib/settings";
import { useTheme } from "@/theme";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Navigator() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.ink,
        headerTitleStyle: { fontWeight: "700" },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.bg },
        headerBackTitle: "뒤로",
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="stocks/add" options={{ title: "종목 등록", presentation: "modal" }} />
      <Stack.Screen name="stocks/[code]/index" options={{ title: "종목" }} />
      <Stack.Screen name="stocks/[code]/edit" options={{ title: "보유 정보 수정", presentation: "modal" }} />
      <Stack.Screen name="briefings/[id]" options={{ title: "브리핑" }} />
    </Stack>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SettingsProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            <Navigator />
          </QueryClientProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
