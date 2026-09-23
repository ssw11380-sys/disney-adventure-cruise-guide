import { router } from "expo-router";
import React, { useCallback, useMemo } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useStockMutations, useStocks } from "@/api/hooks";
import type { DiscoverStock } from "@/api/types";
import { formatDateKo } from "@/lib/format";
import { font, space, useTheme } from "@/theme";
import type { HoldingMark } from "./DiscoverRow";

/** 등록 종목 코드 → 보유/관심 표시 */
export function useMarks(): Map<string, HoldingMark> {
  const stocks = useStocks();
  return useMemo(() => new Map((stocks.data ?? []).map((s) => [s.code, (s.quantity ?? 0) > 0 ? "보유" : "관심"] as const)), [stocks.data]);
}

/** 길게 누르면 관심 종목 추가 */
export function useAddWatch(): (item: DiscoverStock) => void {
  const { register } = useStockMutations();
  const marks = useMarks();
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
            register.mutate(
              { code: item.code },
              {
                onSuccess: () => Alert.alert("추가했습니다", `${item.name} 을(를) 관심 종목에 넣었습니다. 잔고 탭 아래쪽에서 볼 수 있습니다.`),
                onError: (e) => Alert.alert("추가 실패", e instanceof Error ? e.message : String(e)),
              },
            ),
        },
      ]);
    },
    [marks, register],
  );
}

export function openStock(item: DiscoverStock): void {
  router.push(`/stocks/${item.code}`);
}

/** "● 장중 · 14:52 기준" / "장 마감 · 9월 22일 (월) 16:00 기준" */
export function StatusLine({ open, asOf, note }: { open: boolean; asOf: string | null; note?: string | null }) {
  const t = useTheme();
  return (
    <View style={[styles.status, { borderBottomColor: t.line, backgroundColor: t.bg }]}>
      <View style={[styles.dot, { backgroundColor: open ? t.up : t.muted }]} />
      <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1 }} numberOfLines={2}>
        {open ? "장중 · 30초마다 갱신" : "장 마감 · 직전 정규장 기준"}
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
