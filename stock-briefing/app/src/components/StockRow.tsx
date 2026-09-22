import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { afterMarketLabel, formatPct, formatPrice } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";
import { FlashPrice } from "./FlashPrice";
import { ChangeText, Muted } from "./ui";

/** 종목 목록 한 줄: 이름/코드, 현재가/등락, 보유 평가손익, (한국) NXT 야간 가격 */
export function StockRow({ stock, onPress }: { stock: RegisteredWithQuote; onPress: () => void }) {
  const t = useTheme();
  const q = stock.quote;
  const ev = stock.evaluation;
  const cur = q?.currency;
  const nxt = q?.afterMarket ?? null;
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
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {q.live ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.accent }} accessibilityLabel="실시간" /> : null}
              <FlashPrice value={q.price} text={formatPrice(q.price, cur)} style={{ color: t.ink, fontSize: font.body, fontWeight: "600", fontVariant: ["tabular-nums"] }} />
            </View>
            <ChangeText value={q.change} text={`${formatPrice(q.change, cur, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.small }} />
            {q.priceKrw ? <Muted style={{ fontSize: font.tiny }}>≈ {formatPrice(q.priceKrw, "KRW")}</Muted> : null}
            {nxt && nxt.price !== q.price ? <ChangeText value={nxt.change} text={`${afterMarketLabel(nxt)} ${formatPrice(nxt.price, cur)} (${formatPct(nxt.changeRate)})`} style={{ fontSize: font.tiny }} /> : null}
            {ev ? <ChangeText value={ev.profit} text={`평가 ${formatPrice(ev.profit, cur, { sign: true })} (${formatPct(ev.profitRate)})`} style={{ fontSize: font.tiny }} /> : null}
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
