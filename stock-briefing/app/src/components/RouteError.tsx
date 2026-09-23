import { router, type ErrorBoundaryProps } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/ui";
import { font, space, useTheme } from "@/theme";

/**
 * 화면 단위 오류 복구. expo-router 는 라우트 파일이 ErrorBoundary 를 내보내면 그 화면에서 난 렌더 오류를
 * 여기로 돌린다 → 앱 전체가 꺼지지 않고 이 화면만 "다시 시도"로 바뀐다.
 * 사용: 라우트 파일에서 `export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";`
 */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]} accessibilityRole="alert">
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>화면을 표시하지 못했습니다</Text>
      <Text style={{ color: t.muted, fontSize: font.small, textAlign: "center" }} numberOfLines={4}>
        {error?.message || "알 수 없는 오류"}
      </Text>
      <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
        <Button title="다시 시도" compact onPress={() => void retry()} />
        <Button title="잔고로" variant="secondary" compact onPress={() => router.replace("/")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.xl },
});
