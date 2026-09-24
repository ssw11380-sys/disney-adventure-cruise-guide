import { router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMarketIndices } from "@/api/hooks";
import type { MarketIndex } from "@/api/types";
import { formatPct } from "@/lib/format";
import { clockLabel, indexLive, indicesAsOf } from "@/lib/freshness";
import { useNow } from "@/lib/useNow";
import { changeColor, font, space, touch, useTheme } from "@/theme";
import { sentence, speakRate } from "@/lib/a11y";

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
  // 기준 시각은 서버가 출처에서 받은 시각 (앱이 응답을 받은 시각이 아니라). 출처 조회가 실패 중인 항목이 있으면 경고색
  const basis = indicesAsOf(list, q.dataUpdatedAt);
  const warn = basis.stale || q.isError || q.failureCount > 0;
  return (
    <View style={[styles.wrap, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      <ScrollView ref={scroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {list.map((i, n) => {
          const c = changeColor(t, i.change);
          const on = selected === i.code;
          const live = indexLive(i);
          return (
            <Pressable
              key={i.code}
              onPress={() => open(i.code)}
              onLayout={selected ? (e) => {
                const x = e.nativeEvent.layout.x;
                setXs((prev) => (prev[i.code] === x ? prev : { ...prev, [i.code]: x }));
              } : undefined}
              accessibilityRole="button"
              accessibilityLabel={sentence([i.kind === "fx" ? `${i.name} 시장` : i.name, formatIndexValue(i.value), speakRate(i.changeRate), live ? "장중" : null, i.stale ? "시세 지연" : null])}
              accessibilityHint="차트 보기"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                styles.item,
                n > 0 && { borderLeftColor: t.line, borderLeftWidth: StyleSheet.hairlineWidth },
                { backgroundColor: pressed ? t.surfaceAlt : on ? t.surfaceAlt : "transparent" },
                on && { borderBottomColor: t.accent, borderBottomWidth: 2 },
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <Text style={{ color: on ? t.ink : t.muted, fontSize: font.tiny, fontWeight: "600" }}>
                  {i.name}
                  {/* 잔고 패널의 "토스 적용 환율"과 구분 */}
                  {i.kind === "fx" ? <Text style={{ fontWeight: "400" }}> 시장</Text> : null}
                </Text>
                {/* 초록 점 = 장중 확인, 경고색 점 = 출처 조회 실패로 마지막 값 */}
                {live ? <View style={[styles.dot, { backgroundColor: t.live }]} /> : i.stale ? <View style={[styles.dot, { backgroundColor: t.warn }]} /> : null}
              </View>
              <Text style={[styles.value, { color: c }]}>{formatIndexValue(i.value)}</Text>
              <Text style={[styles.rate, { color: c }]}>
                {i.change > 0 ? "▲" : i.change < 0 ? "▼" : ""}
                {formatIndexValue(Math.abs(i.change))} {formatPct(i.changeRate)}
              </Text>
            </Pressable>
          );
        })}
        {/* 띠 끝에 기준 시각 (지수는 30초마다 받음). 서버가 출처에서 새로 받지 못하는 동안은 마지막으로 받은 시각이 남는다 */}
        {basis.at !== null ? (
          <View style={[styles.item, styles.asOf, { borderLeftColor: t.line }]} accessible accessibilityLabel={sentence([`지수 기준 시각 ${clockLabel(basis.at, now)}`, basis.stale ? "시세 지연" : null])}>
            <Text style={{ color: warn ? t.warn : t.muted, fontSize: font.tiny }}>{clockLabel(basis.at, now)}</Text>
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
  item: { minHeight: touch.min, paddingVertical: space.sm, paddingHorizontal: space.md, gap: space.xxs, minWidth: 104 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  asOf: { minWidth: 0, justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth },
  value: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rate: { fontSize: font.tiny, fontVariant: ["tabular-nums"] },
});
