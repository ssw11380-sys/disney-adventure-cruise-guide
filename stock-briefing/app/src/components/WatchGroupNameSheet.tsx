import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { groupNameCheck, nameLength, NAME_ERROR_TEXT, WATCH_GROUP_NAME_MAX, type WatchGroup } from "@/lib/watchGroups";
import type { NameSave } from "@/lib/watchGroupsQuery";
import { font, radius, space, touch, useTheme } from "@/theme";
import { tossSheet } from "@/tokens";

/**
 * 관심 그룹 이름 창 (3-34, 기능 플래그 watchGroups) — Alert.prompt 는 iOS 전용이라 시트로 만든다.
 *  - 제목 '새 그룹' / '그룹 이름 바꾸기', 입력칸 자리 글자 '예: 반도체, 배당', 오른쪽 아래 글자 수 '3/10' (코드 포인트)
 *  - [취소] [만들기|바꾸기] — 저장하는 동안 '만드는 중'/'바꾸는 중', 두 번 누르기 막음
 *  - 앱이 먼저 검사하고(빔·10자·예약어·같은 이름·12개 — 서버와 같은 규칙) 서버도 다시 검사한다. 서버가 거절하면 그 글을 입력칸 아래 빨간 글로
 */
export function WatchGroupNameSheet({
  mode,
  initial = "",
  groups,
  exceptId,
  onSubmit,
  onDone,
  onClose,
}: {
  mode: "create" | "rename";
  initial?: string;
  groups: readonly WatchGroup[];
  /** 이름을 바꾸는 그룹 (자기 이름과는 겹쳐도 된다) */
  exceptId?: number;
  onSubmit: (name: string) => Promise<NameSave>;
  /** 저장이 끝난 뒤 (만들기면 만든 그룹) */
  onDone?: (res: NameSave & { ok: true }) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const wide = win.width >= tossSheet.maxW + space.xl * 2;
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const count = nameLength(text);
  const create = mode === "create";

  const submit = async () => {
    if (busyRef.current) return;
    const check = groupNameCheck(text, groups, create ? undefined : exceptId);
    if (!check.ok) {
      setError(NAME_ERROR_TEXT[check.error]);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const res = await onSubmit(check.name);
    busyRef.current = false;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone?.(res);
    onClose();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.backdrop, { justifyContent: wide ? "center" : "flex-end" }]}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="이름 창 닫기" />
        <View
          testID="watch-name-sheet"
          style={[styles.sheet, wide ? styles.sheetFloat : styles.sheetBottom, { backgroundColor: t.surface, borderColor: t.lineStrong, paddingBottom: wide ? space.lg : insets.bottom + space.lg }]}
        >
          <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
            {create ? "새 그룹" : "그룹 이름 바꾸기"}
          </Text>
          <TextInput
            value={text}
            onChangeText={(v) => {
              setText(v);
              setError(null);
            }}
            placeholder="예: 반도체, 배당"
            placeholderTextColor={t.muted}
            accessibilityLabel={`그룹 이름, ${WATCH_GROUP_NAME_MAX}자까지`}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            style={[styles.input, { color: t.ink, borderColor: error ? t.danger : t.lineStrong, backgroundColor: t.bg }]}
          />
          <View style={styles.under}>
            <Text style={[styles.error, { color: t.danger }]} accessibilityLiveRegion="polite" accessibilityRole={error ? "alert" : undefined}>
              {error ?? ""}
            </Text>
            <Text style={{ color: count > WATCH_GROUP_NAME_MAX ? t.danger : t.muted, fontSize: font.small }} accessibilityLabel={`${count}자, ${WATCH_GROUP_NAME_MAX}자까지`}>
              {count}/{WATCH_GROUP_NAME_MAX}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button title="취소" variant="secondary" onPress={onClose} style={styles.grow} />
            <Button title={busy ? (create ? "만드는 중" : "바꾸는 중") : create ? "만들기" : "바꾸기"} loading={busy} onPress={() => void submit()} style={styles.grow} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center" },
  sheet: { width: "100%", maxWidth: tossSheet.maxW, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm },
  sheetBottom: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetFloat: { borderRadius: radius.lg },
  title: { fontSize: font.h2, fontWeight: "700" },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: font.body },
  under: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  error: { flex: 1, fontSize: font.small },
  actions: { flexDirection: "row", gap: space.sm, paddingTop: space.xs },
  grow: { flex: 1 },
});
