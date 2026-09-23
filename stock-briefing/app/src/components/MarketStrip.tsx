import { router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMarketIndices } from "@/api/hooks";
import type { MarketIndex } from "@/api/types";
import { clockLabel } from "@/lib/freshness";
import { useNow } from "@/lib/useNow";
import { changeColor, font, space, useTheme } from "@/theme";

/** 지수·환율 값: 1,000 이상은 콤마, 소수 둘째 자리 */
export function formatIndexValue(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 홈 상단 지수 띠: 지수명 / 값 / 등락률. 옆으로 밀어 보고, 누르면 그 지수·환율 차트로 간다.
 * selected·onSelect 를 주면(지수 차트 화면) 고른 항목을 표시하고 화면을 바꾸지 않고 전환한다.
 */
export function MarketStrip({ selected, onSelect }: { selected?: string; onSelect?: (code: string) => void } = {}) {
  const t = useTheme();
  const q = useMarketIndices();
  const now = useNow(30_000);
  const list: MarketIndex[] = q.data?.indices ?? [];
  // 고른 항목이 화면 밖(오른쪽)에 있으면 보이도록 띠를 민다
  const scroll = useRef<ScrollView>(null);
  const [xs, setXs] = useState<Record<string, number>>({});
  const selectedX = selected ? xs[selected] : undefined;
  useEffect(() => {
    if (selectedX !== undefined) scroll.current?.scrollTo({ x: Math.max(0, selectedX - 40), animated: true });
  }, [selectedX]);
  if (list.length === 0) return null;
  const open = (code: string) => (onSelect ? onSelect(code) : router.push(`/market/${code}` as never));
  return (
    <View style={[styles.wrap, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {list.map((i, n) => {
          const c = changeColor(t, i.change);
          const on = selected === i.code;
          return (
            <Pressable
              key={i.code}
              onPress={() => open(i.code)}
              onLayout={selected ? (e) => {
                const x = e.nativeEvent.layout.x;
                setXs((prev) => (prev[i.code] === x ? prev : { ...prev, [i.code]: x }));
              } : undefined}
              accessibilityRole="button"
              accessibilityLabel={`${i.name} 차트 보기`}
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                styles.item,
                n > 0 && { borderLeftColor: t.line, borderLeftWidth: StyleSheet.hairlineWidth },
                { backgroundColor: pressed ? t.surfaceAlt : on ? t.surfaceAlt : "transparent" },
                on && { borderBottomColor: t.accent, borderBottomWidth: 2 },
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text style={{ color: on ? t.ink : t.muted, fontSize: font.tiny, fontWeight: "600" }}>{i.name}</Text>
                {i.open && i.kind !== "fx" ? <View style={[styles.dot, { backgroundColor: t.up }]} /> : null}
              </View>
              <Text style={[styles.value, { color: c }]}>{formatIndexValue(i.value)}</Text>
              <Text style={[styles.rate, { color: c }]}>
                {i.change > 0 ? "▲" : i.change < 0 ? "▼" : ""}
                {Math.abs(i.change).toLocaleString("en-US", { maximumFractionDigits: 2 })} {i.changeRate > 0 ? "+" : ""}
                {i.changeRate.toFixed(2)}%
              </Text>
            </Pressable>
          );
        })}
        {/* 띠 끝에 기준 시각 (지수는 30초마다 받음). 받지 못하는 동안은 마지막으로 받은 시각이 남는다 */}
        {q.dataUpdatedAt ? (
          <View style={[styles.item, styles.asOf, { borderLeftColor: t.line }]} accessibilityLabel={`지수 기준 시각 ${clockLabel(q.dataUpdatedAt, now)}`}>
            <Text style={{ color: q.isError || q.failureCount > 0 ? t.warn : t.muted, fontSize: font.tiny }}>{clockLabel(q.dataUpdatedAt, now)}</Text>
            <Text style={{ color: t.muted, fontSize: font.tiny }}>기준</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { paddingHorizontal: space.sm },
  item: { paddingVertical: 8, paddingHorizontal: space.md, gap: 1, minWidth: 104 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  asOf: { minWidth: 0, justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth },
  value: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rate: { fontSize: font.tiny, fontVariant: ["tabular-nums"] },
});
