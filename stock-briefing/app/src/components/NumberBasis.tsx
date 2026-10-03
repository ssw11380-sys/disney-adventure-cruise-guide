import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFeature, useReconcileBadge } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { fxNote, type AccountData } from "@/components/AccountBand";
import { BASIS_FOOT, basisRows, reconcileBadge, type BasisRow } from "@/lib/numberBasis";
import { useNow } from "@/lib/useNow";
import { font, fontCap, layout, slopFor, space, touch, useFontScale, useTheme } from "@/theme";

/**
 * 잔고 계좌 합계 옆 '숫자 기준' 점 + 짧은 글 (3-32, 기능 플래그 numberBasis — 켜졌을 때만 잔고 화면이 그린다).
 *  - 점(지름 layout.basisDot) + 토스 대조 결과 한 마디(토스와 0.1% 이내 · 토스와 차이 0.12% · 토스와 수량 다름 · 토스 대조 대기 · 토스 대조 12:50 · 숫자 기준).
 *    dotOnly(좁은 한 줄 계좌 띠)는 점만 — 화면 읽기는 같은 문장
 *  - 누르는 칸은 44×44 (보이는 점이 6 이어도). 옆 '비중' 버튼과 누르는 곳이 겹치지 않게 hitSlop 은 주지 않는다
 *  - 누르면 아래에서 '숫자 기준' 창 (창의 줄은 열려 있을 때만 계산)
 * 배지 조회(useReconcileBadge)는 이 부품 안에서만 부른다 — 끄면 이 부품이 없어 조회도 없다
 */
export function BasisMark({ stocks, account, dotOnly = false }: { stocks: readonly RegisteredWithQuote[]; account: AccountData; dotOnly?: boolean }) {
  const t = useTheme();
  const q = useReconcileBadge();
  const tossSnapshotOn = useFeature("tossAccountSnapshot", false);
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const badge = reconcileBadge(q.data, now, { showComparedScope: tossSnapshotOn });
  const color = badge.tone === "ok" ? t.accent : badge.tone === "warn" ? t.warn : t.muted;
  const rows = open ? basisRows({ stocks, afterCost: account.afterCost, fxNote: fxNote(account), excluded: account.excluded, reconcile: q.data, now }) : [];
  return (
    <>
      {/* 창(Modal)은 자리를 차지하지 않는다. 점 앞에 두어 점이 바로 뒤 '비중' 버튼의 앞 형제가 되게 한다 */}
      <BasisSheet visible={open} rows={rows} onClose={() => setOpen(false)} />
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`숫자 기준 보기, ${badge.speech}`} style={styles.mark}>
        {/* 점은 글자 기호가 아니라 View (Freshness 의 상태 점과 같은 방식) */}
        <View style={[styles.dot, { backgroundColor: color }]} />
        {dotOnly ? null : (
          <Text style={[styles.text, { color }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
            {badge.text}
          </Text>
        )}
      </Pressable>
    </>
  );
}

/** '숫자 기준' 창: 아래에서 올라오는 창 (넓은 창에서는 읽기 폭 가운데). 줄마다 이름 | 글, 한 줄 = 화면 읽기 한 문장. 끝에 안내 한 줄 */
export function BasisSheet({ visible, rows, onClose }: { visible: boolean; rows: BasisRow[]; onClose: () => void }) {
  const t = useTheme();
  const scale = useFontScale(fontCap.row);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* 바깥을 누르면 닫힘. 창을 감싸면 화면 읽기가 창 전체를 한 덩어리로 읽으므로 뒤에 따로 깐다 (잔고 정렬 창과 같은 방식) */}
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="숫자 기준 닫기" />
        <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.lineStrong }]}>
          <View style={styles.head}>
            <Text accessibilityRole="header" style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>
              숫자 기준
            </Text>
            <Pressable onPress={onClose} hitSlop={CLOSE_SLOP} accessibilityRole="button" accessibilityLabel="숫자 기준 닫기" style={styles.close}>
              <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "700" }}>닫기</Text>
            </Pressable>
          </View>
          {/* 글자가 커져 줄이 넘치면 창 안에서 스크롤 */}
          <ScrollView contentContainerStyle={styles.body}>
            {rows.map((r) => (
              <View key={r.key} accessible accessibilityLabel={`${r.label}, ${r.lines.join(", ")}`} style={[styles.row, { borderTopColor: t.line }]}>
                <Text style={{ color: t.muted, fontSize: font.small, width: layout.basisLabelW * scale }}>{r.label}</Text>
                <View style={styles.lines}>
                  {r.lines.map((line, i) => (
                    <Text key={i} style={{ color: r.muted?.includes(i) ? t.muted : r.warn ? t.warn : t.ink, fontSize: font.small }}>
                      {line}
                    </Text>
                  ))}
                </View>
              </View>
            ))}
            <Text style={[styles.foot, { color: t.muted }]}>{BASIS_FOOT}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** 창 머리 '닫기' 글자(보이는 높이 약 font.body × 1.35)의 누르는 곳: 위아래는 hitSlop 으로 44, 폭은 칸 자체가 44 (styles.close — 글자는 오른쪽 끝 그대로) */
const CLOSE_SLOP = slopFor(font.body * 1.35);

const styles = StyleSheet.create({
  // 누르는 칸 44×44 (점만 있을 때도). 한 줄이어야 a11y 검사가 minHeight: touch.min 을 찾는다
  mark: { minWidth: touch.min, minHeight: touch.min, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs },
  dot: { width: layout.basisDot, height: layout.basisDot, borderRadius: layout.basisDot / 2 },
  text: { fontSize: font.tiny, fontWeight: "700" },
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { width: "100%", maxWidth: layout.readableMax, alignSelf: "center", maxHeight: "85%", borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xl },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md },
  close: { minWidth: touch.min, alignItems: "flex-end" },
  body: { paddingHorizontal: space.lg },
  row: { flexDirection: "row", gap: space.sm, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  lines: { flex: 1, gap: space.xxs },
  foot: { fontSize: font.tiny, paddingTop: space.sm },
});
