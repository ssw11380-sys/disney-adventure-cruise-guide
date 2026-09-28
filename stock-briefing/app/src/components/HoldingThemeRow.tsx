import { router } from "expo-router";
import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThemeRowView } from "@/lib/holdingThemes";
import { changeColor, font, space, touch, useTheme } from "@/theme";

/**
 * 내 종목 테마 한 줄 (3-35 설계 2.2 ⑤): 테마 이름 + 등락률(색) / 종류 · 오른·내린·보합 / 거래대금 평소 대비 / 내 종목과 오늘 등락률.
 * 누르면 발견 탭 테마 상세. 누르는 높이 44 이상, 이름·숫자는 말줄임 없이 줄바꿈. 화면 읽기는 한 줄 한 문장(row.speech).
 * 색은 등락률 글자에만 (거래대금 비율·종목 수·이름에는 칠하지 않음)
 */
export const HoldingThemeRow = memo(function HoldingThemeRow({ row, first = false }: { row: ThemeRowView; first?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => router.push(row.href as never)}
      accessibilityRole="button"
      accessibilityLabel={row.speech}
      style={({ pressed }) => [styles.row, { borderTopColor: t.line, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
    >
      <View style={styles.head}>
        <Text style={[styles.name, { color: t.ink }]}>{row.name}</Text>
        <Text style={[styles.rate, { color: changeColor(t, row.rate) }]}>{row.rateText}</Text>
      </View>
      <Text style={[styles.sub, { color: t.muted }]}>{row.kindLine}</Text>
      {row.tvLine ? <Text style={[styles.sub, { color: t.muted }]}>{row.tvLine}</Text> : null}
      <View style={styles.mine}>
        <Text style={[styles.sub, { color: t.sub, fontWeight: "600" }]}>내 종목</Text>
        {row.holdings.map((h, i) => (
          <Text key={`${h.label}:${i}`} style={[styles.sub, { color: t.ink }]}>
            {h.label} <Text style={{ color: changeColor(t, h.rate), fontVariant: ["tabular-nums"] }}>{h.rateText}</Text>
            {h.note ? <Text style={{ color: t.muted, fontSize: font.tiny }}> · {h.note}</Text> : null}
            {i < row.holdings.length - 1 || row.more ? " ·" : ""}
          </Text>
        ))}
        {row.more ? <Text style={[styles.sub, { color: t.muted }]}>외 {row.more}종목</Text> : null}
      </View>
      {row.note ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{row.note}</Text> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { minHeight: touch.min, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xxs },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  // 이름은 두 줄까지가 아니라 필요한 만큼 줄바꿈 (말줄임 없음), 등락률 칸은 늘 보인다
  name: { flex: 1, fontSize: font.body, fontWeight: "700" },
  rate: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 0 },
  sub: { fontSize: font.small },
  mine: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs, rowGap: space.xxs, alignItems: "baseline" },
});
