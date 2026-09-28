import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RegisteredWithQuote } from "@/api/types";
import { haptic } from "@/lib/haptics";
import { movedSpeech, movedToGroupSpeech, NONE_NAME, posLine, WATCH_GROUP_LIMIT, type WatchModel } from "@/lib/watchGroups";
import { useWatchGroups, type WatchOps } from "@/lib/watchGroupsQuery";
import { font, radius, space, touch, useTheme } from "@/theme";
import { tossSheet } from "@/tokens";
import { WatchGroupNameSheet } from "./WatchGroupNameSheet";

/** 시트 한 줄: 누르는 항목 또는 흐린 안내 줄 */
export type SheetItem =
  | { kind?: "item"; key: string; label: string; icon: keyof typeof Ionicons.glyphMap; danger?: boolean; disabled?: boolean; chevron?: boolean; onPress: () => void }
  | { kind: "note"; key: string; label: string };

/** 그룹 고르기 칸 (그룹 순서대로 + 그룹 없음) */
export interface SheetGroup {
  id: number | null;
  name: string;
}

/**
 * 관심 줄 메뉴 시트 (3-34, 기능 플래그 watchGroups — 잔고 탭 관심 줄 길게 누르기·밀기 '그룹'·화면 읽기 '그룹 옮기기', '관심 그룹·순서' 화면 ⋯).
 * 휴대폰은 아래에 붙이고 넓은 창은 가운데 최대 560 (토스 앱 시트와 같은 틀). 안드로이드 Alert 는 버튼이 3개까지라 시트로 만든다.
 *  1. 메뉴: 제목(종목 이름) · '지금: 반도체 · 2번째 (4종목 중)' · 항목들(부르는 쪽이 정함) · 닫기
 *  2. 그룹 고르기: '‘삼성전자’ 옮길 그룹' · 그룹마다 라디오(지금 그룹은 '(지금)') · '＋ 새 그룹 만들고 옮기기'(12개면 흐린 안내) · 닫기.
 *     다른 그룹을 고르면 그 그룹 맨 끝으로 옮기고 닫힌다 (부르는 쪽 onPickGroup)
 * 바깥(어두운 곳)·뒤로 가기·닫기로 닫힌다. 항목 높이 최소 44
 */
export function WatchRowSheet({
  title,
  subtitle,
  items,
  groups,
  currentGroupId,
  initialStep = "menu",
  onPickGroup,
  onCreateGroup,
  onClose,
}: {
  title: string;
  subtitle?: string;
  items: SheetItem[];
  groups: SheetGroup[];
  currentGroupId: number | null;
  initialStep?: "menu" | "groups";
  onPickGroup: (id: number | null, name: string) => void;
  /** 새 그룹 만들고 옮기기 (그룹이 12개면 없음 → 흐린 안내 줄) */
  onCreateGroup?: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const [step, setStep] = useState(initialStep);
  const wide = win.width >= tossSheet.maxW + space.xl * 2;
  const tint = (pressed: boolean) => ({ borderTopColor: t.line, backgroundColor: pressed ? t.surfaceAlt : "transparent" });
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { justifyContent: wide ? "center" : "flex-end" }]}>
        {/* 바깥을 누르면 닫힘. 시트를 감싸면 화면 읽기가 시트 전체를 한 덩어리로 읽으므로 뒤에 따로 깐다 (정렬·토스 앱 시트와 같음) */}
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="메뉴 닫기" />
        <View
          testID="watch-row-sheet"
          style={[
            styles.sheet,
            wide ? styles.sheetFloat : styles.sheetBottom,
            { backgroundColor: t.surface, borderColor: t.lineStrong, paddingBottom: wide ? space.sm : insets.bottom + space.sm, maxHeight: Math.round(win.height * 0.85) },
          ]}
        >
          <ScrollView bounces={false}>
            {step === "menu" ? (
              <>
                <View style={styles.head}>
                  <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
                    {title}
                  </Text>
                  {subtitle ? <Text style={{ color: t.muted, fontSize: font.small }}>{subtitle}</Text> : null}
                </View>
                {items.map((it) =>
                  it.kind === "note" ? (
                    <Text key={it.key} style={[styles.note, { color: t.muted, borderTopColor: t.line }]}>
                      {it.label}
                    </Text>
                  ) : (
                    <Pressable
                      key={it.key}
                      onPress={() => (it.chevron ? setStep("groups") : it.onPress())}
                      disabled={it.disabled}
                      accessibilityRole="button"
                      accessibilityLabel={it.label}
                      accessibilityState={{ disabled: !!it.disabled }}
                      style={({ pressed }) => [styles.item, tint(pressed), it.disabled ? styles.off : null]}
                    >
                      <Ionicons name={it.icon} size={font.h2} color={it.danger ? t.danger : t.sub} />
                      <Text style={[styles.itemText, { color: it.danger ? t.danger : t.ink }]}>{it.label}</Text>
                      {it.chevron ? <Ionicons name="chevron-forward" size={font.h2} color={t.muted} /> : null}
                    </Pressable>
                  ),
                )}
              </>
            ) : (
              <>
                <View style={styles.head}>
                  <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
                    ‘{title}’ 옮길 그룹
                  </Text>
                </View>
                {groups.map((g) => {
                  const now = g.id === currentGroupId;
                  return (
                    <Pressable
                      key={String(g.id)}
                      onPress={() => (now ? onClose() : onPickGroup(g.id, g.name))}
                      accessibilityRole="radio"
                      accessibilityLabel={now ? `${g.name}, 지금 그룹` : g.name}
                      accessibilityState={{ checked: now }}
                      style={({ pressed }) => [styles.item, tint(pressed)]}
                    >
                      <Ionicons name={now ? "radio-button-on" : "radio-button-off"} size={font.h2} color={now ? t.accent : t.muted} />
                      <Text style={[styles.itemText, { color: t.ink, fontWeight: now ? "700" : "400" }]}>
                        {g.name}
                        {now ? <Text style={{ color: t.muted, fontWeight: "400" }}> (지금)</Text> : null}
                      </Text>
                    </Pressable>
                  );
                })}
                {onCreateGroup ? (
                  <Pressable onPress={onCreateGroup} accessibilityRole="button" accessibilityLabel="새 그룹 만들고 옮기기" style={({ pressed }) => [styles.item, tint(pressed)]}>
                    <Ionicons name="add" size={font.h2} color={t.accent} />
                    <Text style={[styles.itemText, { color: t.accent, fontWeight: "700" }]}>새 그룹 만들고 옮기기</Text>
                  </Pressable>
                ) : (
                  <Text style={[styles.note, { color: t.muted, borderTopColor: t.line }]}>그룹은 12개까지 만들 수 있습니다</Text>
                )}
              </>
            )}
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="닫기" style={({ pressed }) => [styles.item, tint(pressed), styles.close]}>
              <Text style={[styles.itemText, { color: t.sub, textAlign: "center" }]}>닫기</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** 그룹 고르기 칸: 그룹 순서대로 + 그룹 없음 (늘 맨 끝) */
export function sheetGroups(groups: readonly { id: number; name: string }[]): SheetGroup[] {
  return [...groups.map((g) => ({ id: g.id as number | null, name: g.name })), { id: null, name: NONE_NAME }];
}

// ── 관심 줄 메뉴 (잔고 탭 · 편집 화면 공통) ──

/** 같은 그룹 안에서 to 자리로 (범위 밖은 끝으로 맞춤). 옮겼으면 true — 화면 읽기에 '삼성전자를 반도체 1번째로 옮겼습니다' */
export function moveWithin(ops: WatchOps, model: WatchModel, stock: { code: string; name: string }, to: number): boolean {
  const p = model.pos.get(stock.code);
  if (!p) return false;
  const target = Math.max(0, Math.min(to, p.count - 1));
  if (target === p.index) return false;
  haptic("select");
  ops.move(stock, p.groupId, target, movedSpeech(stock.name, p.groupName, target, model.hasGroups));
  return true;
}

/** 다른 그룹 맨 끝으로 — '삼성전자를 배당 그룹 맨 끝으로 옮겼습니다' */
export function moveToGroup(ops: WatchOps, model: WatchModel, stock: { code: string; name: string }, groupId: number | null, name: string): void {
  const count = model.buckets.find((b) => b.groupId === groupId)?.stocks.filter((s) => s.code !== stock.code).length ?? 0;
  haptic("select");
  ops.move(stock, groupId, count, movedToGroupSpeech(stock.name, name, groupId));
}

export interface WatchMenuTarget {
  stock: RegisteredWithQuote;
  /** 메뉴부터 · 그룹 고르기부터 (밀기 '그룹'·화면 읽기 '그룹 옮기기') */
  step: "menu" | "groups";
}

/**
 * 관심 줄 메뉴를 띄우는 곳 (시트 + 새 그룹 이름 창). 잔고 탭(holdings)은 그룹 옮기기 · 위로 · 아래로(내 순서일 때만, 아니면 안내 한 줄) · 수정 · 관심 해제,
 * 편집 화면(editor)은 그룹 옮기기 · 맨 위로 · 맨 아래로
 */
export function WatchMenuHost({
  target,
  model,
  mine,
  variant,
  removeText,
  onEdit,
  onRemove,
  onClose,
}: {
  target: WatchMenuTarget | null;
  model: WatchModel | null;
  /** 내 순서(정렬 '등록순')인지 — 위로·아래로를 보일지 */
  mine: boolean;
  variant: "holdings" | "editor";
  /** 잔고 탭: 지우기 버튼 이름 (관심 해제 · 동기화 제외 — lib/rowActions removeLabel) */
  removeText?: string;
  onEdit?: (s: RegisteredWithQuote) => void;
  onRemove?: (s: RegisteredWithQuote) => void;
  onClose: () => void;
}) {
  const wg = useWatchGroups();
  const [naming, setNaming] = useState<RegisteredWithQuote | null>(null);
  if (naming)
    return (
      <WatchGroupNameSheet
        mode="create"
        groups={wg.layout.groups}
        onSubmit={wg.ops.create}
        onDone={(res) => {
          // 만든 그룹은 비어 있어 맨 끝 = 0번째
          if (res.created) {
            haptic("select");
            wg.ops.move(naming, res.created.id, 0, movedToGroupSpeech(naming.name, res.created.name, res.created.id));
          }
        }}
        onClose={() => {
          setNaming(null);
          onClose();
        }}
      />
    );
  if (!target || !model) return null;
  const s = target.stock;
  const p = model.pos.get(s.code);
  if (!p) return null;
  const close = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const items: SheetItem[] = [{ key: "group", label: "그룹 옮기기", icon: "folder-outline", chevron: true, onPress: () => {} }];
  if (variant === "editor") {
    items.push(
      { key: "top", label: "맨 위로 옮기기", icon: "arrow-up", disabled: p.index === 0, onPress: close(() => moveWithin(wg.ops, model, s, 0)) },
      { key: "bottom", label: "맨 아래로 옮기기", icon: "arrow-down", disabled: p.index === p.count - 1, onPress: close(() => moveWithin(wg.ops, model, s, p.count - 1)) },
    );
  } else {
    if (mine)
      items.push(
        { key: "up", label: "위로 옮기기", icon: "arrow-up", disabled: p.index === 0, onPress: close(() => moveWithin(wg.ops, model, s, p.index - 1)) },
        { key: "down", label: "아래로 옮기기", icon: "arrow-down", disabled: p.index === p.count - 1, onPress: close(() => moveWithin(wg.ops, model, s, p.index + 1)) },
      );
    else items.push({ kind: "note", key: "sortNote", label: "순서 옮기기는 정렬이 ‘등록순’일 때 쓸 수 있습니다" });
    if (onEdit) items.push({ key: "edit", label: "수정", icon: "create-outline", onPress: close(() => onEdit(s)) });
    if (onRemove) items.push({ key: "remove", label: removeText ?? "관심 해제", icon: "star-outline", danger: true, onPress: close(() => onRemove(s)) });
  }
  return (
    <WatchRowSheet
      key={`${s.code}:${target.step}`}
      title={s.name}
      subtitle={posLine(p)}
      items={items}
      groups={sheetGroups(wg.layout.groups)}
      currentGroupId={p.groupId}
      initialStep={target.step}
      onPickGroup={(id, name) => {
        onClose();
        moveToGroup(wg.ops, model, s, id, name);
      }}
      {...(wg.layout.groups.length < WATCH_GROUP_LIMIT ? { onCreateGroup: () => setNaming(s) } : null)}
      onClose={onClose}
    />
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center" },
  sheet: { width: "100%", maxWidth: tossSheet.maxW, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  sheetBottom: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetFloat: { borderRadius: radius.lg },
  head: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: space.xxs },
  title: { fontSize: font.h2, fontWeight: "700" },
  item: { minHeight: touch.min, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  itemText: { flex: 1, fontSize: font.body },
  note: { fontSize: font.small, paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  off: { opacity: 0.45 },
  close: { justifyContent: "center" },
});
