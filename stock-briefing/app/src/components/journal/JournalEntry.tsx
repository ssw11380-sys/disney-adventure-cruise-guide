import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useJournalStock } from "@/api/hooks";
import { Button } from "@/components/ui";
import { JOURNAL, journalHref, stockPanelText } from "@/lib/journal";
import { font, space, touch, useTheme } from "@/theme";

/**
 * 매매일지 입구 (3-37, 기능 플래그 tradeJournal · tradeRecords — 부르는 화면이 켜져 있을 때만 그린다).
 *  - JournalButton: 잔고 계좌 패널 '비중' 줄의 [매매일지] (작은 버튼, 보이는 높이 32 + hitSlop 44)
 *  - JournalIconButton: 촘촘 구역 머리·넓은 계좌 띠의 아이콘만 44×44
 *  - JournalStockRow: 종목 상세 휴대폰 '잔고' 칸 맨 아래 '이 종목 매매 기록 ›' 한 줄 (높이 44). 넓은 창도 '내 보유' 제목 줄에
 *    숫자 기준 안내('매도 비용 차감 · 토스 기준')가 있으면 그 안내를 자르지 않게 칸 맨 아래 이 줄로
 *  - JournalStockLink: 넓은 창 '내 보유' 제목 오른쪽 '매매 기록 ›' (제목 줄에 안내 글이 없을 때만)
 *  - JournalStockPanel: 지금 안 갖고 있지만 기록이 있는 종목 — '매매 기록 · 보유 없음 · 저장된 체결 3건 ›' (서버에 한 번 묻는다)
 */

/** 매매일지 화면 열기 (code: 그 종목으로 거른 기록). 잔고 탭의 토스 계좌 요약 '매매일지 보기'도 쓴다 */
export const openJournal = (code?: string) => router.push(journalHref(code ? { code } : {}) as never);

export function JournalButton() {
  return <Button title={JOURNAL.title} icon="book-outline" variant="secondary" compact accessibilityLabel={JOURNAL.open} onPress={() => openJournal()} />;
}

/** 아이콘만 44×44 (hitSlop 없음 — 촘촘 머리(높이 44)·계좌 띠 밖으로 누르는 곳이 나가지 않게) */
export function JournalIconButton() {
  const t = useTheme();
  return (
    <Pressable onPress={() => openJournal()} accessibilityRole="button" accessibilityLabel={JOURNAL.open} style={({ pressed }) => [styles.icon, { opacity: pressed ? 0.6 : 1 }]} testID="journal-icon">
      <Ionicons name="book-outline" size={font.h2} color={t.muted} />
    </Pressable>
  );
}

export function JournalStockRow({ code }: { code: string }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => openJournal(code)}
      accessibilityRole="button"
      accessibilityLabel={JOURNAL.stockRowA11y}
      style={({ pressed }) => [styles.row, { borderTopColor: t.line, opacity: pressed ? 0.7 : 1 }]}
      testID="journal-stock-row"
    >
      <Ionicons name="book-outline" size={font.body} color={t.accent} />
      <Text style={[styles.rowText, { color: t.accent }]}>{JOURNAL.stockRow}</Text>
      <Ionicons name="chevron-forward" size={font.body} color={t.accent} />
    </Pressable>
  );
}

/** push: 제목 줄 오른쪽 끝으로 민다 (제목 줄에 안내 글이 없을 때) */
export function JournalStockLink({ code, push = true }: { code: string; push?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => openJournal(code)}
      accessibilityRole="button"
      accessibilityLabel={JOURNAL.stockRowA11y}
      hitSlop={{ top: space.md, bottom: space.md, left: space.sm, right: space.sm }}
      style={[styles.link, push ? styles.push : styles.after]}
      testID="journal-stock-link"
    >
      <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }} numberOfLines={1}>
        {JOURNAL.stockLink}
      </Text>
      <Ionicons name="chevron-forward" size={font.small} color={t.accent} />
    </Pressable>
  );
}

/** 보유가 없는 종목: 저장된 체결이 있을 때만 작은 칸 */
export function JournalStockPanel({ code }: { code: string }) {
  const t = useTheme();
  const q = useJournalStock(code, true);
  const d = q.data;
  if (!d || !d.enabled || d.orders <= 0 || d.holding) return null;
  return (
    <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]} testID="journal-stock-panel">
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">
        {JOURNAL.stockPanelTitle}
      </Text>
      <Pressable onPress={() => openJournal(code)} accessibilityRole="button" accessibilityLabel={`${JOURNAL.stockRowA11y}, ${stockPanelText(d.orders)}`} style={({ pressed }) => [styles.panelRow, { opacity: pressed ? 0.7 : 1 }]}>
        <Text style={{ color: t.sub, fontSize: font.body, flex: 1 }}>{stockPanelText(d.orders)}</Text>
        <Ionicons name="chevron-forward" size={font.body} color={t.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, borderTopWidth: StyleSheet.hairlineWidth, marginTop: space.xs },
  rowText: { flex: 1, fontSize: font.body, fontWeight: "700" },
  link: { flexDirection: "row", alignItems: "center", gap: space.xxs, paddingVertical: space.xxs },
  push: { marginLeft: "auto" },
  after: { marginLeft: space.sm },
  panel: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.xxs },
  panelRow: { flexDirection: "row", alignItems: "center", minHeight: touch.min },
});
