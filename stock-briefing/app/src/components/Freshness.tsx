import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { connection, staleBanner, type Connection, type QueryLike } from "@/lib/freshness";
import { useNow } from "@/lib/useNow";
import { font, space, useTheme } from "@/theme";

/** 쿼리의 연결 상태(끊김·지연·기준 시각). 5초마다 다시 계산한다 */
export function useConnection(q: QueryLike, maxAgeMs: number): Connection & { now: number } {
  const now = useNow(5_000);
  return { ...connection(q, now, maxAgeMs), now };
}

/**
 * 끊김·지연 띠: "연결 끊김 · 14:03:21 기준 · 다시 연결 중". 값은 그대로 두고 위에 한 줄만 얹는다.
 * 보여 줄 게 없으면 아무것도 그리지 않는다.
 */
export function StaleBanner({ conn, open }: { conn: Connection & { now: number }; open: boolean }) {
  const t = useTheme();
  const text = staleBanner(conn, { open, now: conn.now });
  if (!text) return null;
  const color = conn.offline ? t.danger : t.warn;
  return (
    <View style={[styles.bar, { backgroundColor: t.surfaceAlt, borderBottomColor: t.line }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Ionicons name={conn.offline ? "cloud-offline-outline" : "time-outline"} size={14} color={color} />
      <Text style={{ color, fontSize: font.small, fontWeight: "600" }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/**
 * 당겨서 새로고침 전용 상태. 자동 갱신(3초 폴링) 때는 스피너를 띄우지 않고, 사용자가 당겼을 때만 돈다.
 * 여러 쿼리를 함께 새로 받을 때는 refetch 에서 Promise.all 로 묶어 넘긴다.
 */
export function usePull(refetch: () => Promise<unknown>): { pulling: boolean; onPull: () => void } {
  const [pulling, setPulling] = useState(false);
  const onPull = useCallback(() => {
    setPulling(true);
    void refetch().finally(() => setPulling(false));
  }, [refetch]);
  return { pulling, onPull };
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.lg, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
});
