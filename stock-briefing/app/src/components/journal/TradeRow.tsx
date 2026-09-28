import React from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import type { JournalItem } from "@/api/types";
import { detailLine, extraLines, rightSign, rightText, rowSpeech, titleText } from "@/lib/journal";
import { isBigText } from "@/lib/textScale";
import { changeColor, font, radius, space, useTheme } from "@/theme";

/**
 * 체결 한 줄 (3-37 매매일지 기록 탭, 최소 높이 56):
 *   [매도] SOXL                          +$17.43 (+10.25%)
 *   5주 · 평균 $37.50 · 23:10 · 판매 금액 $187.50
 *   메모: 실적 발표 뒤 일부 정리            (한 줄 말줄임)
 * 기록과 다른 변화 줄('[기록과 다름] NAVER' · '[큰 주가 변화] …' — 무엇이 달라졌는지, 그 기간은 계산하지 않았다는 말)은 누를 수 없다.
 * 계산에서 뺀 매도는 오른쪽에 숫자 대신 '계산에서 뺌'(흐린 색). 화면 읽기는 한 줄 한 문장(lib/journal rowSpeech).
 * 종목 이름은 한 줄 말줄임, 큰 글씨(100% 초과)에서는 잔고 목록처럼 두 줄까지. 변화 줄 제목(오른쪽 숫자 없음)은 잘리지 않게 줄바꿈
 */
export function TradeRow({ item, selected, onPress }: { item: JournalItem; selected?: boolean; onPress?: (item: JournalItem) => void }) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const est = item.kind === "change";
  const sell = item.side === "SELL";
  const sign = rightSign(item);
  const unknown = sell && (!item.realized || item.realized.status === "unknown-cost" || item.realized.status === "unexplained");
  const body = (
    <>
      <View style={styles.line1}>
        {!est ? (
          <View style={[styles.tag, { borderColor: sell ? t.down : t.up }]}>
            <Text style={{ color: sell ? t.down : t.up, fontSize: font.tiny, fontWeight: "700" }}>{sell ? "매도" : "매수"}</Text>
          </View>
        ) : null}
        <Text style={[styles.name, { color: est ? t.sub : t.ink }]} numberOfLines={est ? undefined : isBigText(fontScale) ? 2 : 1}>
          {titleText(item)}
        </Text>
        {!est ? (
          <Text style={[styles.right, { color: unknown ? t.muted : sell ? changeColor(t, sign) : t.ink }]} numberOfLines={1}>
            {rightText(item)}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: t.muted, fontSize: font.small }}>{detailLine(item)}</Text>
      {/* 까닭 문장은 줄바꿈(잘리지 않게), 메모는 한 줄 말줄임 */}
      {extraLines(item).map((l) => (
        <Text key={l} style={{ color: t.sub, fontSize: font.small }} numberOfLines={l.startsWith("메모: ") ? 1 : undefined}>
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
  // 이름과 오른쪽 숫자가 한 줄에 안 들어가면(큰 글씨) 숫자가 다음 줄 오른쪽으로 — 숫자를 줄이거나 자르지 않는다
  line1: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.s, rowGap: space.xxs },
  tag: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.xs, paddingVertical: space.xxs },
  name: { flexShrink: 1, fontSize: font.body, fontWeight: "700" },
  right: { marginLeft: "auto", flexShrink: 0, fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right" },
});
