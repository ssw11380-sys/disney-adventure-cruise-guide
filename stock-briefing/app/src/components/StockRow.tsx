import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { formatPct, formatWon } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";
import { ChangeText, Muted } from "./ui";

/** 종목 목록 한 줄: 이름/코드, 현재가/등락, 보유 평가손익 */
export function StockRow({ stock, onPress }: { stock: RegisteredWithQuote; onPress: () => void }) {
  const t = useTheme();
  const q = stock.quote;
  const ev = stock.evaluation;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.line }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }} numberOfLines={1}>
          {stock.name}
        </Text>
        <Muted>
          {stock.code} · {stock.market}
          {stock.quantity ? ` · ${stock.quantity}주` : " · 관심"}
        </Muted>
      </View>
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        {q ? (
          <>
            <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatWon(q.price)}</Text>
            <ChangeText value={q.change} text={`${formatWon(q.change, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.small }} />
            {ev ? <ChangeText value={ev.profit} text={`평가 ${formatWon(ev.profit, { sign: true })} (${formatPct(ev.profitRate)})`} style={{ fontSize: font.tiny }} /> : null}
          </>
        ) : (
          <Muted>{stock.quoteError ? "시세 미확인" : "-"}</Muted>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
