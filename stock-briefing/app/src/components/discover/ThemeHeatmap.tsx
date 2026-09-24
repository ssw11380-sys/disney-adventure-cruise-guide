import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThemeSummary } from "@/api/types";
import { formatPct } from "@/lib/format";
import { font, space, useTheme } from "@/theme";

import { HEAT_TILE_H, heatColor } from "@/lib/heat";

export { HEAT_MAX, HEAT_TILE_H, heatColor } from "@/lib/heat";

/** 히트맵 타일 하나: 테마명 · 등락률 · 오른/내린 종목 수 */
export const HeatTile = memo(function HeatTile({ theme, max, onPress }: { theme: ThemeSummary; max: number; onPress: (t: ThemeSummary) => void }) {
  const t = useTheme();
  const c = heatColor(t, theme.changeRate, max);
  return (
    <Pressable
      onPress={() => onPress(theme)}
      accessibilityRole="button"
      accessibilityLabel={`${theme.name} ${formatPct(theme.changeRate)}`}
      style={({ pressed }) => [styles.tile, { backgroundColor: c.bg, opacity: pressed ? 0.75 : 1, borderColor: t.bg }]}
    >
      <Text style={[styles.name, { color: c.fg }]} numberOfLines={2}>
        {theme.name}
      </Text>
      <View style={styles.bottom}>
        <Text style={[styles.rate, { color: c.fg }]}>{formatPct(theme.changeRate)}</Text>
        {theme.up + theme.flat + theme.down > 0 ? (
          <Text style={[styles.counts, { color: c.sub }]}>
            ▲{theme.up} ▼{theme.down}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

/** 색 범례: -max … 0 … +max */
export function HeatLegend({ max }: { max: number }) {
  const t = useTheme();
  const stops = [-1, -0.7, -0.45, -0.2, 0, 0.2, 0.45, 0.7, 1];
  return (
    <View style={styles.legend}>
      <Text style={[styles.legendLabel, { color: t.down }]}>-{max}%</Text>
      <View style={styles.legendBar}>
        {stops.map((s) => (
          <View key={s} style={{ flex: 1, backgroundColor: heatColor(t, s * max, max).bg }} />
        ))}
      </View>
      <Text style={[styles.legendLabel, { color: t.up }]}>+{max}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // 폭을 1/3 로 고정 (flex:1 이면 마지막 줄 타일이 가로로 늘어난다)
  tile: { width: "33.333%", height: HEAT_TILE_H, padding: space.s, justifyContent: "space-between", borderWidth: 1, borderRadius: 4 },
  name: { fontSize: font.small, fontWeight: "700", lineHeight: 16 },
  bottom: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.xs },
  rate: { fontSize: font.body, fontWeight: "800", fontVariant: ["tabular-nums"] },
  counts: { fontSize: font.tiny, fontWeight: "600", fontVariant: ["tabular-nums"] },
  legend: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.lg, paddingVertical: space.s },
  legendBar: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row" },
  legendLabel: { fontSize: font.tiny, fontVariant: ["tabular-nums"], fontWeight: "700" },
});
