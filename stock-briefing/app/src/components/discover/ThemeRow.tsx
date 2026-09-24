import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThemeSummary } from "@/api/types";
import { RateBox } from "@/components/ui";
import { formatPct } from "@/lib/format";
import { changeColor, font, space, useTheme } from "@/theme";

export const THEME_ROW_H = 72;

/**
 * 테마 한 줄: 순위 · 테마명 / 대표 종목 · 상승·보합·하락 비율 막대 | 테마 등락률 상자.
 * 막대는 구성 종목 중 오른 종목(빨강)·보합(회색)·내린 종목(파랑)의 비율이라, 등락률과 함께 테마 전체의 힘을 보여 준다.
 */
export const ThemeRow = memo(function ThemeRow({ theme, rank, kindWord = "테마", onPress }: { theme: ThemeSummary; rank: number; kindWord?: string; onPress: (t: ThemeSummary) => void }) {
  const t = useTheme();
  const total = theme.up + theme.flat + theme.down;
  return (
    <Pressable
      onPress={() => onPress(theme)}
      accessibilityRole="button"
      accessibilityLabel={`${rank}위 ${theme.name} ${kindWord} ${formatPct(theme.changeRate)}${total > 0 ? `, 상승 ${theme.up} 하락 ${theme.down}` : ""}`}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderBottomColor: t.line }]}
    >
      <Text style={[styles.rank, { color: rank <= 3 ? t.ink : t.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {rank}
      </Text>
      <View style={styles.body}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} numberOfLines={1}>
          {theme.name}
          {theme.adjusted ? <Text style={{ color: t.muted, fontWeight: "400" }}> *</Text> : null}
        </Text>
        <Text style={{ color: t.muted, fontSize: font.tiny }} numberOfLines={1}>
          {theme.leaders.length
            ? theme.leaders.map((l, i) => (
                <Text key={l.code}>
                  {i > 0 ? " · " : ""}
                  {l.name}
                  {l.changeRate !== null ? <Text style={{ color: changeColor(t, l.changeRate) }}> {formatPct(l.changeRate)}</Text> : null}
                </Text>
              ))
            : "대표 종목 없음"}
        </Text>
        {total > 0 ? (
          <View style={styles.barRow}>
            <View style={[styles.bar, { backgroundColor: t.surfaceAlt }]}>
              {theme.up ? <View style={{ flex: theme.up, backgroundColor: t.up }} /> : null}
              {theme.flat ? <View style={{ flex: theme.flat, backgroundColor: t.lineStrong }} /> : null}
              {theme.down ? <View style={{ flex: theme.down, backgroundColor: t.down }} /> : null}
            </View>
            <Text style={[styles.counts, { color: t.muted }]}>
              <Text style={{ color: t.up }}>▲{theme.up}</Text> <Text style={{ color: t.down }}>▼{theme.down}</Text>
            </Text>
          </View>
        ) : null}
      </View>
      <RateBox value={theme.changeRate} text={formatPct(theme.changeRate)} style={styles.rate} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", height: THEME_ROW_H, paddingHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm },
  rank: { width: 28, fontSize: font.small, fontWeight: "800", fontVariant: ["tabular-nums"] },
  body: { flex: 1, gap: space.xxs },
  barRow: { flexDirection: "row", alignItems: "center", gap: space.s },
  bar: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden", flexDirection: "row" },
  counts: { fontSize: font.tiny, fontVariant: ["tabular-nums"], minWidth: 56, textAlign: "right" },
  rate: { minWidth: 72 },
});
