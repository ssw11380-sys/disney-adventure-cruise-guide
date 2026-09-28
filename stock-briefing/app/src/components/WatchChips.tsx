import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/ui";
import { groupHeadSpeech, type WatchChip, type WatchSelected } from "@/lib/watchGroups";
import { font, fontCap, space, touch, useTheme } from "@/theme";
import { CHIP_H, CHIP_SLOP, ChipStrip } from "./chart/ChipStrip";

/**
 * 잔고 관심 칸 머리의 칩 줄 (3-34, 기능 플래그 watchGroups): [전체 9] [반도체 4] [배당 3] [그룹 없음 2] … + 오른쪽 끝 고정 [그룹·순서].
 *  - 칩은 옆으로 넘긴다 (차트 칩과 같은 ChipStrip — 끝 흐림, 칩 보이는 높이 32 + 누르는 영역 44). 칩을 누르면 폰에 있는 값으로 바로 그 그룹만
 *  - 줄 높이 44 (촘촘에서도). 글자는 표 줄과 같은 상한(140%) — 넘치면 옆으로 넘김
 *  - 휴대폰은 '관심 9' 머리 줄과 표 머리 사이, 넓은 표는 표 머리 아래 (화면 읽기가 '관심 9' 제목을 먼저 읽고 칩을 읽게)
 */
export function WatchChips({ chips, onPick, onEdit, pad, backdrop }: { chips: WatchChip[]; onPick: (key: WatchSelected) => void; onEdit: () => void; pad: number; backdrop: string }) {
  const t = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: backdrop, paddingLeft: pad }]}>
      <ChipStrip backdrop={backdrop} style={styles.grow}>
        {chips.map((c) => (
          <Pressable
            key={String(c.key)}
            onPress={() => onPick(c.key)}
            hitSlop={CHIP_SLOP}
            accessibilityRole="button"
            accessibilityLabel={c.speech}
            accessibilityState={{ selected: c.selected }}
            style={[styles.chip, { borderColor: c.selected ? t.accent : t.line, backgroundColor: c.selected ? t.surfaceAlt : "transparent" }]}
          >
            <Text style={{ color: c.selected ? t.ink : t.sub, fontSize: font.small, fontWeight: c.selected ? "700" : "500" }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
              {c.label}
              <Text style={{ color: t.muted, fontWeight: "500" }}> {c.count}</Text>
            </Text>
          </Pressable>
        ))}
      </ChipStrip>
      <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel="관심 그룹과 순서 편집" style={[styles.edit, { paddingRight: pad, borderLeftColor: t.line }]}>
        <Ionicons name="folder-outline" size={font.body} color={t.accent} />
        <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          그룹·순서
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * 관심 칸 '전체'의 그룹 머리 줄 (휴대폰·넓은 표 공통, 높이 44 · 줄 전체가 누르는 곳): '▾ 반도체 · 4' — 누르면 접고 편다 (이 기기에 기억).
 * 화면 읽기 '반도체 그룹, 4종목, 펼쳐짐' · 상태 expanded · 힌트 '두 번 탭하면 접습니다'
 */
export function WatchGroupHead({ name, groupId, count, collapsed, onToggle, pad }: { name: string; groupId: number | null; count: number; collapsed: boolean; onToggle: () => void; pad: number }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={groupHeadSpeech(name, groupId, count, collapsed)}
      accessibilityState={{ expanded: !collapsed }}
      accessibilityHint={collapsed ? "두 번 탭하면 펼칩니다" : "두 번 탭하면 접습니다"}
      style={({ pressed }) => [styles.head, { paddingHorizontal: pad, backgroundColor: pressed ? t.rowPressed : t.bg, borderBottomColor: t.line }]}
    >
      <Ionicons name={collapsed ? "chevron-forward" : "chevron-down"} size={font.small} color={t.muted} />
      <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700", flexShrink: 1 }} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
        {name}
      </Text>
      <Text style={{ color: t.muted, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
        · {count}
      </Text>
    </Pressable>
  );
}

/** 고른 그룹이 비었을 때 칩 줄 아래 한 칸 */
export function WatchEmptyGroup({ onOpen }: { onOpen: () => void }) {
  const t = useTheme();
  return (
    <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
        이 그룹에 종목이 없습니다
      </Text>
      <Text style={{ color: t.muted, fontSize: font.small }}>관심 종목 줄을 길게 눌러 ‘그룹 옮기기’를 고르거나, 아래 버튼으로 옮기세요.</Text>
      <View style={styles.emptyActions}>
        <Button title="그룹·순서 열기" icon="folder-outline" variant="secondary" onPress={onOpen} style={styles.grow} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", minHeight: touch.min },
  grow: { flex: 1 },
  chip: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth, minHeight: CHIP_H, justifyContent: "center" },
  // 칩 띠와 겹치지 않는 고정 버튼 (높이 44, 왼쪽 가는 선으로 칩과 나눔)
  edit: { flexDirection: "row", alignItems: "center", gap: space.xxs, minHeight: touch.min, paddingLeft: space.sm, marginLeft: space.xs, borderLeftWidth: StyleSheet.hairlineWidth, flexShrink: 0 },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { margin: space.lg, padding: space.lg, gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  emptyActions: { flexDirection: "row", marginTop: space.sm },
});
