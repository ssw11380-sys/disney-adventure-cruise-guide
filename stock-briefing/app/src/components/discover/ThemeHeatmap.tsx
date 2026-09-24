import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThemePeriod, ThemeSummary } from "@/api/types";
import { formatPct } from "@/lib/format";
import { contrast, hexRgb, rgbHex, type Rgb } from "@/lib/color";
import { font, space, useTheme, type Theme } from "@/theme";

/** 기간별 색 눈금의 끝값(%): 하루 ±5%, 1주 ±10%, 1개월 ±20% 에서 가장 진하다 */
export const HEAT_MAX: Record<ThemePeriod, number> = { day: 5, week: 10, month: 20 };
export const HEAT_TILE_H = 72;

/**
 * 등락률 → 타일 배경색·글자색. 0 근처는 회색, 멀어질수록 빨강(상승)·파랑(하락)이 진해진다.
 * 글자색은 실제 배경(바탕 위에 겹친 색)과의 명도 대비가 더 큰 쪽(흰색 또는 짙은 글자)을 고른다 — 라이트·다크 모두 4.5:1 이상이 되게
 */
export function heatColor(t: Theme, rate: number, max: number): { bg: string; fg: string; sub: string } {
  const r = Math.max(-1, Math.min(1, rate / max));
  const mag = Math.abs(r);
  if (mag < 0.03) return { bg: t.surfaceAlt, fg: t.ink, sub: t.ink };
  // 5단계로 끊어 읽기 쉽게 (연속 색보다 구분이 잘 된다)
  const step = mag < 0.15 ? 0.28 : mag < 0.35 ? 0.45 : mag < 0.6 ? 0.62 : mag < 0.85 ? 0.8 : 1;
  const base = hexRgb(r > 0 ? t.up : t.down);
  const under = hexRgb(t.bg);
  const mixed = base.map((c, i) => Math.round(c * step + under[i]! * (1 - step))) as Rgb;
  const bg = rgbHex(mixed);
  const useWhite = contrast(mixed, t.onFill) >= contrast(mixed, t.inkOnLight);
  // 오른·내린 종목 수도 같은 색 (반투명으로 흐리게 하면 작은 글자 대비가 4.5:1 밑으로 떨어진다)
  const fg = useWhite ? t.onFill : t.inkOnLight;
  return { bg, fg, sub: fg };
}

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
