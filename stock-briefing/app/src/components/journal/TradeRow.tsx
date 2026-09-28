import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { JournalItem } from "@/api/types";
import { detailLine, extraLines, rightSign, rightText, rowSpeech, titleText } from "@/lib/journal";
import { changeColor, font, radius, space, useTheme } from "@/theme";

/**
 * 체결 한 줄 (3-37 매매일지 기록 탭, 최소 높이 56):
 *   [매도] SOXL                          +$17.43 (+10.25%)
 *   5주 · 평균 $37.50 · 23:10 · 판매 금액 $187.50
 *   메모: 실적 발표 뒤 일부 정리            (한 줄 말줄임)
 * 추정 줄([추정] 수량 변화)은 누를 수 없다. 화면 읽기는 한 줄 한 문장(lib/journal rowSpeech)
 */
export function TradeRow({ item, selected, onPress }: { item: JournalItem; selected?: boolean; onPress?: (item: JournalItem) => void }) {
  const t = useTheme();
  const est = item.kind === "estimated";
  const sell = item.side === "SELL";
  const sign = rightSign(item);
  const unknown = sell && (!item.realized || item.realized.status === "unknown-cost");
  const body = (
    <>
      <View style={styles.line1}>
        {!est ? (
          <View style={[styles.tag, { borderColor: sell ? t.down : t.up }]}>
            <Text style={{ color: sell ? t.down : t.up, fontSize: font.tiny, fontWeight: "700" }}>{sell ? "매도" : "매수"}</Text>
          </View>
        ) : null}
        <Text style={[styles.name, { color: est ? t.sub : t.ink }]} numberOfLines={1}>
          {titleText(item)}
        </Text>
        {!est ? (
          <Text style={[styles.right, { color: unknown ? t.muted : sell ? changeColor(t, sign) : t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {rightText(item)}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: t.muted, fontSize: font.small }}>{detailLine(item)}</Text>
      {extraLines(item).map((l) => (
        <Text key={l} style={{ color: t.sub, fontSize: font.small }} numberOfLines={1}>
          {l}
        </Text>
      ))}
    </>
  );
  if (est || !onPress)
    return (
      <View style={[styles.row, { borderBottomColor: t.line }]} accessible accessibilityLabel={rowSpeech(item)}>
        {body}
      </View>
    );
  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={rowSpeech(item)}
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [styles.row, { borderBottomColor: t.line, backgroundColor: selected ? t.surfaceAlt : pressed ? t.rowPressed : t.surface }]}
      testID={`trade-${item.key}`}
    >
      {body}
    </Pressable>
  );
}

/** 줄 최소 높이 (누르는 곳 44 이상 — 세 줄까지 담는다) */
const LINE_H = 56;

const styles = StyleSheet.create({
  row: { minHeight: LINE_H, paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth, justifyContent: "center" },
  line1: { flexDirection: "row", alignItems: "center", gap: space.s },
  tag: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.xs, paddingVertical: space.xxs },
  name: { flexShrink: 1, fontSize: font.body, fontWeight: "700" },
  right: { marginLeft: "auto", flexShrink: 0, maxWidth: "60%", fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right" },
});
