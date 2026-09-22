import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { afterMarketLabel, formatMoney, formatPct, isUsMarket } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";
import { FlashPrice } from "./FlashPrice";
import { ChangeText, Muted } from "./ui";

/**
 * 종목 목록 한 줄.
 *  왼쪽: 시장 배지 + 이름, 코드·수량   오른쪽: 현재가(실시간 깜빡임), 등락, 평가손익
 *  showKrw 면 미국 종목을 원화로 환산해 보여준다. 길게 누르면 삭제 등 메뉴.
 */
export function StockRow({ stock, onPress, onLongPress, showKrw }: { stock: RegisteredWithQuote; onPress: () => void; onLongPress?: () => void; showKrw: boolean }) {
  const t = useTheme();
  const q = stock.quote;
  const ev = stock.evaluation;
  const cur = q?.currency;
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const nxt = q?.afterMarket ?? null;
  const us = isUsMarket(stock.market);
  const money = (n: number | null | undefined, opts?: { sign?: boolean }) => formatMoney(n, cur, fx, showKrw, opts);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.line, shadowColor: t.shadow }]}
    >
      <View style={[styles.marketMark, { backgroundColor: us ? `${t.accent}18` : `${t.gold}22` }]}>
        <Text style={{ color: us ? t.accent : t.gold, fontSize: font.tiny, fontWeight: "800" }}>{us ? "US" : "KR"}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} numberOfLines={1}>
          {stock.name}
        </Text>
        <Muted style={{ fontSize: font.tiny }}>
          {stock.code} · {stock.market}
          {stock.quantity ? ` · ${stock.quantity}주` : " · 관심"}
        </Muted>
      </View>
      <View style={{ alignItems: "flex-end", gap: 1 }}>
        {q ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {q.live ? <View style={[styles.liveDot, { backgroundColor: t.accent }]} accessibilityLabel="실시간" /> : null}
              <FlashPrice value={q.price} text={money(q.price)} style={{ color: t.ink, fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] }} />
            </View>
            <ChangeText value={q.change} text={`${money(q.change, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.small }} />
            {nxt && nxt.price !== q.price ? <ChangeText value={nxt.change} text={`${afterMarketLabel(nxt)} ${money(nxt.price)} (${formatPct(nxt.changeRate)})`} style={{ fontSize: font.tiny }} /> : null}
            {ev ? <ChangeText value={ev.profit} text={`평가 ${money(ev.profit, { sign: true })} (${formatPct(ev.profitRate)})`} style={{ fontSize: font.tiny }} /> : null}
          </>
        ) : (
          <Muted>{stock.quoteError ? "시세 미확인" : "-"}</Muted>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color={t.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  marketMark: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
});
