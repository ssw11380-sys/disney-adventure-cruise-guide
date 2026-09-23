import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useMarketIndices } from "@/api/hooks";
import { changeColor, font, space, useTheme } from "@/theme";

/** 홈 상단 지수 띠: 지수명 / 값 / 등락률. 옆으로 밀어 본다 */
export function MarketStrip() {
  const t = useTheme();
  const q = useMarketIndices();
  const list = q.data?.indices ?? [];
  if (list.length === 0) return null;
  return (
    <View style={[styles.wrap, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {list.map((i, n) => {
          const c = changeColor(t, i.change);
          const digits = i.code === "USDKRW" || i.value < 10000 ? 2 : 2;
          return (
            <View key={i.code} style={[styles.item, n > 0 && { borderLeftColor: t.line, borderLeftWidth: StyleSheet.hairlineWidth }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text style={{ color: t.muted, fontSize: font.tiny, fontWeight: "600" }}>{i.name}</Text>
                {i.open ? <View style={[styles.dot, { backgroundColor: t.up }]} /> : null}
              </View>
              <Text style={[styles.value, { color: c }]}>{i.value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}</Text>
              <Text style={[styles.rate, { color: c }]}>
                {i.change > 0 ? "▲" : i.change < 0 ? "▼" : ""}
                {Math.abs(i.change).toLocaleString("en-US", { maximumFractionDigits: 2 })} {i.changeRate > 0 ? "+" : ""}
                {i.changeRate.toFixed(2)}%
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { paddingHorizontal: space.sm },
  item: { paddingVertical: 8, paddingHorizontal: space.md, gap: 1, minWidth: 104 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  value: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rate: { fontSize: font.tiny, fontVariant: ["tabular-nums"] },
});
