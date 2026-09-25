import { Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Quote } from "@/api/types";
import { chartNotice, clockLabel, connection, liveLabel, OPEN_MAX_AGE_MS, staleBanner, streamFresh, type LiveTone, type QueryLike } from "@/lib/freshness";
import { feedHealthy, liveCounts, marketSessions, recheckIn, sessionStatus } from "@/lib/liveDot";
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
 * 초록 점을 켤 때 쓰는 시각과 앱 수신 상태 (lib/liveDot quoteLive 에 그대로 넘긴다).
 *  - feedOk: 앱이 값을 제때 받고 있는지 (feedHealthy — 체결 스트림 연결 또는 폴링 15초 안, 오프라인 아님)
 *  - now: 결과가 바뀔 수 있는 때(받은 값이 15초가 되는 때 · 가장 가까운 세션 경계)에만 새로 읽는다 → 화면 전체를 몇 초마다 다시 그리지 않는다
 *    (그 사이 새 값을 받으면 그 값은 방금 받은 것이라 지연이 아니다). 잔고 줄은 점 값(불리언)만 받아 점이 바뀐 줄만 다시 그린다
 * streamed=false: 체결 스트림이 이 값을 고쳐 주지 않는다(미등록 종목 상세) → 스트림 연결은 보지 않고 폴링 값만 본다
 */
export function useFeedState(query: QueryLike, quotes: readonly (Quote | null | undefined)[], streamed = true): { now: number; feedOk: boolean } {
  const connected = useLiveStream().connected && streamed;
  const [now, setNow] = useState(() => Date.now());
  const { dataUpdatedAt } = query;
  useEffect(() => {
    const due = recheckIn(now, Date.now(), dataUpdatedAt, quotes, OPEN_MAX_AGE_MS);
    if (due === null) return;
    const id = setTimeout(() => setNow(Date.now()), due);
    return () => clearTimeout(id);
  }, [dataUpdatedAt, quotes, now]);
  return { now, feedOk: feedHealthy(connected, connection(query, now, OPEN_MAX_AGE_MS)) };
}

/**
 * 잔고 패널의 상태 점 + 글자.
 *  - 새 서버(종목별 세션이 있음): "미국 주간거래 · 한국 휴장 · 실시간 9종목 · 14:03:21 · 보유 10" (lib/liveDot sessionStatus).
 *    초록 점은 점이 켜진 종목이 있고 앱이 값을 제때 받을 때만
 *  - 예전 서버: "실시간 · 14:03:21 · 보유 17". 체결이 30초 끊기면 5초 안에 "지연 3초"/"지연"으로 바뀐다
 */
export function LiveStatus({ query, open, closedLabel, maxAgeMs, suffix, quotes }: { query: QueryLike; open: boolean; closedLabel: string; maxAgeMs: (fresh: boolean) => number; suffix: string; quotes?: readonly (Quote | null)[] }) {
  const t = useTheme();
  const stream = useLiveStream();
  const now = useNow(5_000);
  const fresh = streamFresh(stream, now);
  const conn = connection(query, now, maxAgeMs(fresh));
  const sessions = quotes ? marketSessions(quotes, now) : [];
  let s: { text: string; tone: LiveTone };
  let warn: boolean;
  if (sessions.length > 0) {
    // 줄의 점과 같은 기준 (useFeedState · quoteLive)
    const feedOk = feedHealthy(stream.connected, connection(query, now, OPEN_MAX_AGE_MS));
    const counts = liveCounts(quotes ?? [], now, feedOk);
    s = sessionStatus({ sessions, liveCount: counts.live, eligibleCount: counts.eligible, feedOk, offline: conn.offline });
    warn = s.tone === "offline" || s.tone === "delayed";
  } else {
    s = liveLabel({ open, closedLabel, streamFresh: fresh, offline: conn.offline, stale: conn.stale });
    warn = s.tone === "offline" || (s.tone === "delayed" && conn.stale);
  }
  const text = `${s.text}${conn.asOf ? ` · ${clockLabel(conn.asOf, now)}` : ""} · ${suffix}`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 }} accessible accessibilityLabel={text}>
      <View style={[styles.dot, { backgroundColor: s.tone === "live" ? t.live : warn ? t.warn : t.muted }]} />
      <Text style={{ color: warn ? t.warn : t.muted, fontSize: font.tiny, flexShrink: 1 }}>{text}</Text>
    </View>
  );
}

/**
 * 차트 아래 한 줄 (lib/freshness 의 chartNotice): 봉을 처음 불러오지 못했으면 오류, 받은 봉이 있는데 주기 갱신이 실패하면
 * "차트 갱신 지연 · 14:03:21 기준" 만 — 그려진 차트는 그대로 둔다. 실패 여부는 errorUpdatedAt 으로 본다 (체결 캐시 쓰기가 isError 를 지운다)
 */
export function ChartNotice({ query }: { query: QueryLike & { error?: unknown; errorUpdatedAt: number } }) {
  const t = useTheme();
  const now = useNow(60_000);
  const n = chartNotice(query, now);
  if (!n) return null;
  return <Text style={{ color: n.error ? t.danger : t.muted, fontSize: font.small }}>{n.text}</Text>;
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
