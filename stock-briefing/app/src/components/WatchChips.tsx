import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View, type ScrollView } from "react-native";
import { Button } from "@/components/ui";
import { chipRevealX, emptyGroupTitle, groupHeadSpeech, type WatchChip, type WatchSelected } from "@/lib/watchGroups";
import { font, fontCap, space, touch, useTheme } from "@/theme";
import { CHIP_H, CHIP_SLOP, ChipStrip, FADE_W } from "./chart/ChipStrip";

/**
 * 잔고 관심 칸 머리의 칩 줄 (3-34, 기능 플래그 watchGroups): [전체 9] [반도체 4] [배당 3] [그룹 없음 2] … + 오른쪽 끝 고정 [그룹·순서].
 *  - 칩은 옆으로 넘긴다 (차트 칩과 같은 ChipStrip — 끝 흐림, 칩 보이는 높이 32 + 누르는 영역 44). 칩을 누르면 폰에 있는 값으로 바로 그 그룹만
 *  - 줄 높이 44 (촘촘에서도). 글자는 표 줄과 같은 상한(140%) — 넘치면 옆으로 넘김
 *  - 휴대폰은 '관심 9' 머리 줄과 표 머리 사이, 넓은 표는 표 머리 아래 (화면 읽기가 '관심 9' 제목을 먼저 읽고 칩을 읽게)
 *  - 고른 칩이 지금 보이는 곳 밖(칩 줄 오른쪽 밖 · [그룹·순서] 밑 · 흐림 밑)이면 그릴 때 한 번 그 칩까지 넘긴다 — 기기에 저장한 칩으로 앱을 다시 열어도 무엇으로 걸렀는지 보이게.
 *    고른 칩마다 한 번만 (사용자가 넘겨 둔 칩 줄을 개수가 바뀔 때마다 되돌리지 않게), 지금 넘겨 둔 만큼을 보고 이미 다 보이면 넘기지 않는다 (보이는 칩을 누를 때마다 줄이 튀지 않게)
 */
export function WatchChips({ chips, onPick, onEdit, pad, backdrop }: { chips: WatchChip[]; onPick: (key: WatchSelected) => void; onEdit: () => void; pad: number; backdrop: string }) {
  const t = useTheme();
  const scroll = useRef<ScrollView>(null);
  const seen = useRef({ view: 0, x: 0, chips: new Map<string, { x: number; w: number }>(), done: null as string | null });
  const picked = String(chips.find((c) => c.selected)?.key ?? "all");
  const reveal = () => {
    const s = seen.current;
    const chip = s.chips.get(picked);
    if (s.done === picked || !s.view || !chip) return;
    s.done = picked;
    const x = chipRevealX(chip, s.view, FADE_W, s.x);
    if (x === null) return;
    s.x = x;
    scroll.current?.scrollTo({ x, animated: false });
  };
  // 고른 칩이 바뀌면(자리는 이미 잰 칩) 한 번 확인
  useEffect(() => reveal());
  return (
    <View style={[styles.row, { backgroundColor: backdrop, paddingLeft: pad }]}>
      <ChipStrip
        backdrop={backdrop}
        style={styles.grow}
        scrollRef={scroll}
        onViewWidth={(w) => {
          seen.current.view = w;
          reveal();
        }}
        onScrollX={(x) => {
          seen.current.x = x;
        }}
      >
        {chips.map((c) => (
          <Pressable
            key={String(c.key)}
            onLayout={(e) => {
              seen.current.chips.set(String(c.key), { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width });
              reveal();
            }}
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
 * 화면 읽기 '반도체 그룹, 4종목' + 값 '펼쳐짐'/'접힘' + 상태 expanded · 힌트 '두 번 탭하면 접습니다'.
 * 값을 따로 주는 까닭 (3-34 검토): RN 0.86 안드로이드는 expanded 를 펼치기·접기 동작으로만 붙이고 읽을 글을 만들지 않아, 사용법 힌트를 끈 TalkBack 은
 * 접혔는지 몰랐다. accessibilityValue.text 는 이름표 뒤에 붙어('반도체 그룹, 4종목, 접힘') 바뀔 때마다 새 글로 읽히고, 칩 이름표('반도체 그룹, 4종목')와도 갈린다.
 * 동작 (3-34 3차 검토): 안드로이드는 expanded 상태가 있으면 TalkBack 동작 메뉴에 '펼치기'/'접기'를 넣지만, accessibilityActions 에 없으면 JS 로 알리지 않아
 * 골라도 아무 일이 없었다 → 지금 할 수 있는 쪽 하나(펼쳐져 있으면 collapse, 접혀 있으면 expand)와 두 번 탭(activate)을 넣고 모두 접고 펴기로.
 * activate 를 넣으면 두 번 탭이 onPress 대신 onAccessibilityAction 으로 온다 (RN ReactAccessibilityDelegate)
 */
export function WatchGroupHead({ name, groupId, count, collapsed, onToggle, pad }: { name: string; groupId: number | null; count: number; collapsed: boolean; onToggle: () => void; pad: number }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={groupHeadSpeech(name, groupId, count)}
      accessibilityState={{ expanded: !collapsed }}
      accessibilityValue={{ text: collapsed ? "접힘" : "펼쳐짐" }}
      accessibilityHint={collapsed ? "두 번 탭하면 펼칩니다" : "두 번 탭하면 접습니다"}
      accessibilityActions={collapsed ? EXPAND_ACTIONS : COLLAPSE_ACTIONS}
      onAccessibilityAction={(e) => {
        const name = e.nativeEvent.actionName;
        if (name === "activate" || (name === "expand" && collapsed) || (name === "collapse" && !collapsed)) onToggle();
      }}
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

const EXPAND_ACTIONS = [{ name: "activate" }, { name: "expand", label: "펼치기" }];
const COLLAPSE_ACTIONS = [{ name: "activate" }, { name: "collapse", label: "접기" }];

/** 고른 그룹이 비었을 때 칩 줄 아래 한 칸 — 제목에 고른 그룹 이름 ('‘반도체’ 그룹에 종목이 없습니다') */
export function WatchEmptyGroup({ name, groupId, onOpen }: { name: string; groupId: number | null; onOpen: () => void }) {
  const t = useTheme();
  return (
    <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
        {emptyGroupTitle(name, groupId)}
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
