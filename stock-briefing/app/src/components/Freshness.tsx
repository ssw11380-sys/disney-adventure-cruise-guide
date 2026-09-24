import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { clockLabel, connection, liveLabel, staleBanner, streamFresh, type QueryLike } from "@/lib/freshness";
import { useLiveStream } from "@/lib/liveStream";
import { useNow } from "@/lib/useNow";
import { font, space, useTheme } from "@/theme";

/**
 * 끊김·지연 띠: "연결 끊김 · 14:03:21 기준 · 다시 연결 중". 값은 그대로 두고 위에 한 줄만 얹는다.
 * 시간이 지나 "지연"으로 바뀌는 판단은 이 작은 컴포넌트 안에서만 5초마다 다시 그린다(화면 전체를 다시 그리지 않게).
 * maxAgeMs 를 주지 않으면 끊김만 본다(브리핑처럼 시세가 아닌 화면).
 */
export function StaleBanner({ query, open = false, maxAgeMs }: { query: QueryLike; open?: boolean; maxAgeMs?: number | ((fresh: boolean) => number) }) {
  const t = useTheme();
  const stream = useLiveStream();
  const now = useNow(maxAgeMs === undefined ? 60_000 : 5_000);
  const limit = typeof maxAgeMs === "function" ? maxAgeMs(streamFresh(stream, now)) : (maxAgeMs ?? Number.POSITIVE_INFINITY);
  const conn = connection(query, now, limit);
  // 토큰이 틀려 실패 중이면 "다시 연결 중" 대신 무엇을 고쳐야 하는지
  const auth = conn.offline && (query as { error?: { status?: number } | null }).error?.status === 401;
  const text = auth ? `토큰 확인 필요 · ${clockLabel(conn.asOf!, now)} 기준 · 설정에서 토큰 입력` : staleBanner(conn, { open, now });
  if (!text) return null;
  const color = conn.offline ? t.danger : t.warn;
  return (
    <View style={[styles.bar, { backgroundColor: t.surfaceAlt, borderBottomColor: t.line }]} accessible accessibilityRole="alert" accessibilityLiveRegion="polite" accessibilityLabel={text}>
      <Ionicons name={conn.offline ? "cloud-offline-outline" : "time-outline"} size={14} color={color} />
      <Text style={{ color, fontSize: font.small, fontWeight: "600" }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/**
 * 잔고 패널의 상태 점 + 글자: "실시간 · 14:03:21 · 보유 17". 체결이 30초 끊기면 5초 안에 "지연 3초"/"지연"으로 바뀐다.
 */
export function LiveStatus({ query, open, closedLabel, maxAgeMs, suffix }: { query: QueryLike; open: boolean; closedLabel: string; maxAgeMs: (fresh: boolean) => number; suffix: string }) {
  const t = useTheme();
  const stream = useLiveStream();
  const now = useNow(5_000);
  const fresh = streamFresh(stream, now);
  const conn = connection(query, now, maxAgeMs(fresh));
  const s = liveLabel({ open, closedLabel, streamFresh: fresh, offline: conn.offline, stale: conn.stale });
  const warn = s.tone === "offline" || (s.tone === "delayed" && conn.stale);
  const text = `${s.text}${conn.asOf ? ` · ${clockLabel(conn.asOf, now)}` : ""} · ${suffix}`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 }} accessible accessibilityLabel={text}>
      <View style={[styles.dot, { backgroundColor: s.tone === "live" ? t.live : warn ? t.warn : t.muted }]} />
      <Text style={{ color: warn ? t.warn : t.muted, fontSize: font.tiny, flexShrink: 1 }}>{text}</Text>
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
  bar: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.lg, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
