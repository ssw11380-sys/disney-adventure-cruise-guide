import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useStockMutations, useStocks } from "@/api/hooks";
import type { DiscoverMarket, DiscoverSession, DiscoverStock } from "@/api/types";
import { formatDateKo } from "@/lib/format";
import { font, space, useTheme } from "@/theme";
import type { HoldingMark } from "./DiscoverRow";

/**
 * 등록 종목 코드 → 보유/관심 표시.
 * 시세가 바뀔 때마다(장중 3초) 새 Map 을 만들면 목록 행이 모두 다시 그려지므로, 보유 여부가 바뀔 때만 새로 만든다.
 */
export function useMarks(): Map<string, HoldingMark> {
  const stocks = useStocks();
  const sig = (stocks.data ?? []).map((s) => `${s.code}:${(s.quantity ?? 0) > 0 ? 1 : 0}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig 가 바뀔 때만 (시세 변화는 무시)
  return useMemo(() => new Map((stocks.data ?? []).map((s) => [s.code, (s.quantity ?? 0) > 0 ? "보유" : "관심"] as const)), [sig]);
}

/** 길게 누르면 관심 종목 추가 */
export function useAddWatch(): (item: DiscoverStock) => void {
  const { register } = useStockMutations();
  // marks 는 보유 여부가 바뀔 때만 새로 만들어지고 mutate 는 고정이라, 시세가 바뀌어도 이 함수는 그대로다 (목록 행 memo 유지)
  const marks = useMarks();
  const mutate = register.mutate;
  return useCallback(
    (item: DiscoverStock) => {
      if (marks.has(item.code)) {
        Alert.alert(item.name, `이미 ${marks.get(item.code) === "보유" ? "보유" : "관심"} 종목입니다.`);
        return;
      }
      Alert.alert(item.name, "관심 종목에 추가할까요?", [
        { text: "취소", style: "cancel" },
        {
          text: "추가",
          onPress: () =>
            mutate(
              { code: item.code },
              {
                onSuccess: () => Alert.alert("추가했습니다", `${item.name} 을(를) 관심 종목에 넣었습니다. 잔고 탭 아래쪽에서 볼 수 있습니다.`),
                onError: (e) =>
                  e instanceof Error && /이미 등록/.test(e.message)
                    ? Alert.alert(item.name, "이미 관심 종목입니다.")
                    : Alert.alert("추가 실패", e instanceof Error ? e.message : String(e)),
              },
            ),
        },
      ]);
    },
    [marks, mutate],
  );
}

/**
 * 당겨서 새로고침 상태. 자동 갱신(30초)마다 스피너가 뜨지 않도록, 사용자가 당겼을 때만 돌린다.
 */
export function usePull(refetch: () => Promise<unknown>): { pulling: boolean; onPull: () => void } {
  const [pulling, setPulling] = useState(false);
  const onPull = useCallback(() => {
    setPulling(true);
    void refetch().finally(() => setPulling(false));
  }, [refetch]);
  return { pulling, onPull };
}

export function openStock(item: DiscoverStock): void {
  router.push(`/stocks/${item.code}`);
}

/** 상태 줄 첫머리: 값이 바뀌는 중인지, 아니면 어느 시점 값인지 */
function statusLabel(market: DiscoverMarket, open: boolean, session: DiscoverSession | undefined, live: boolean | undefined, paused: boolean): string {
  const s: DiscoverSession = session ?? (open ? "regular" : "closed"); // 옛 서버는 session 이 없다
  const every = paused ? "자동 갱신 멈춤 (당겨서 새로고침)" : "30초마다 갱신";
  if (s === "regular") return `장중 · ${every}`;
  if (s === "extended") return `시간외 거래 반영 중 · ${every}`;
  if (s === "pre") return "장 시작 전 · 직전 거래일 기준";
  if (live) return "장외 시간 · 현재가 기준";
  return market === "US" ? "장 마감 · 직전 정규장 기준" : "장 마감 · 마지막 거래 기준";
}

/**
 * "● 장중 · 30초마다 갱신 · 14:52 기준" / "장 마감 · 직전 정규장 기준 · 9월 23일 (수) 05:00 기준".
 * 미국 값은 정규장 기준이라 장 밖에서는 "직전 정규장", 한국은 15:30 뒤에도 시간외 거래로 값이 바뀌어 20:00 까지 "시간외 거래 반영 중".
 */
export function StatusLine({
  open,
  asOf,
  note,
  market = "KR",
  session,
  live,
  paused = false,
}: {
  open: boolean;
  asOf: string | null;
  note?: string | null;
  market?: DiscoverMarket;
  session?: DiscoverSession;
  live?: boolean;
  /** 자동 갱신을 멈춘 목록(깊이 내려 둔 순위) — "30초마다 갱신"이라고 하지 않는다 */
  paused?: boolean;
}) {
  const t = useTheme();
  const moving = session ? session === "regular" || session === "extended" : open;
  return (
    <View style={[styles.status, { borderBottomColor: t.line, backgroundColor: t.bg }]}>
      <View style={[styles.dot, { backgroundColor: moving ? t.up : t.muted }]} />
      <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1 }} numberOfLines={2}>
        {statusLabel(market, open, session, live, paused)}
        {asOf ? ` · ${formatDateKo(asOf, true)} 기준` : ""}
        {note ? ` · ${note}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.lg, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
