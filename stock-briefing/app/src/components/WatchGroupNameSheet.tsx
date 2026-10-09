import React, { useEffect, useRef, useState } from "react";
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { groupNameCheck, nameLength, NAME_ERROR_TEXT, WATCH_GROUP_NAME_MAX, type WatchGroup } from "@/lib/watchGroups";
import type { NameSave } from "@/lib/watchGroupsQuery";
import { font, radius, space, touch, useTheme } from "@/theme";
import { tossSheet } from "@/tokens";

/** 자판 이벤트가 오지 않을 때 시트 최대 높이 (창 높이 비율 — 360×752 에서 338, 자판 약 300 위에 남는 곳 안) */
const KB_GUESS_SHEET = 0.45;

/**
 * 관심 그룹 이름 창 (3-34, 기능 플래그 watchGroups) — Alert.prompt 는 iOS 전용이라 시트로 만든다.
 *  - 제목 '새 그룹' / '그룹 이름 바꾸기', 입력칸 자리 글자 '예: 반도체, 배당', 오른쪽 아래 글자 수 '3/10' (코드 포인트)
 *  - [취소] [만들기|바꾸기] — 저장하는 동안 '만드는 중'/'바꾸는 중', 두 번 누르기 막음
 *  - 앱이 먼저 검사하고(빔·10자·예약어·같은 이름·12개 — 서버와 같은 규칙) 서버도 다시 검사한다. 서버가 거절하면 그 글을 입력칸 아래 빨간 글로
 *  - 입력칸이 열리자마자 자판이 뜬다. 자판이 열리면 시트를 위쪽에 붙이고 높이를 자판 위까지로 줄인다 — edge-to-edge 라 창이 자판만큼
 *    줄어드는 동작(KeyboardAvoidingView·adjustResize)에 기대지 않는다 (가격 알림 시트와 같은 방식). 넘치면 위쪽 글만 스크롤, 버튼은 늘 보임.
 *    Modal 창에는 자판 이벤트가 오지 않을 수 있어(폰 확인 전) 입력칸 초점으로 한 번 더 대비한다 (아래 guess — 한 번 위로 가면 창을 닫을 때까지 그 자리)
 *  - 저장하는 동안 창을 닫으면(바깥·뒤로 가기·취소) 응답이 와도 onDone 을 부르지 않는다 (닫은 뒤 종목이 몰래 옮겨지지 않게)
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
  /** 저장이 끝난 뒤 (만들기면 만든 그룹). 그 전에 창을 닫았으면 부르지 않는다 */
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
  // 사용자가 창을 닫았거나 화면이 사라짐 → 늦게 온 저장 응답은 버린다
  const closedRef = useRef(false);
  // 자판 높이 (0 = 닫힘). 창이 열려 있는 동안만 구독한다
  const [kb, setKb] = useState(0);
  // 자판 이벤트를 한 번이라도 받았는지 · 입력칸에 초점이 있는지 (아래 대비책)
  const [kbEvents, setKbEvents] = useState(false);
  const [focused, setFocused] = useState(false);
  // 대비책으로 한 번 위로 올렸는지 — 창이 열려 있고 자판 이벤트가 오지 않는 동안 그 자리를 지킨다 (아래 guess)
  const [held, setHeld] = useState(false);
  useEffect(() => {
    // 개발 모드(StrictMode)는 붙였다 떼었다 다시 붙인다 — 다시 붙을 때 '닫힘'을 풀어 둔다
    closedRef.current = false;
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setKbEvents(true);
      setKb(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setKb(0));
    return () => {
      closedRef.current = true;
      show.remove();
      hide.remove();
    };
  }, []);
  const count = nameLength(text);
  const create = mode === "create";
  // 대비책 (3-34 검토): RN 0.86 은 자판 이벤트를 앱 본 창에서만 보내는데 이 입력칸은 Modal(다른 창) 안이라, 이벤트가 오지 않으면 시트가 자판에 가린다.
  // 입력칸에 초점이 있는데 자판 이벤트를 아직 한 번도 받지 못했으면 자판이 떠 있다고 보고, 위쪽에 붙이고 창 높이의 45%까지로 줄인다.
  // 이벤트가 오면 그 높이를 쓰고(자판이 닫히면 아래로 — 지금 그대로). 초점이 빠져도 창을 닫을 때까지(만들어 닫힘 · 취소 · 바깥 · 뒤로) 그 자리 (3-34 3차 검토):
  // [만들기]를 누르면 초점이 버튼으로 옮겨 가는데(웹 · 외부 자판), 그 순간 시트가 아래로 내려가면 누른 자리에서 버튼이 빠져 눌리지 않았고 '같은 이름' 글도 보이지 않았다
  const guess = kb === 0 && !kbEvents && (focused || held);
  const up = kb > 0 || guess;
  const maxH = kb > 0 ? win.height - kb - insets.top - space.md * 2 : guess ? Math.round(win.height * KB_GUESS_SHEET) : undefined;

  const close = () => {
    closedRef.current = true;
    onClose();
  };

  const submit = async () => {
    if (busyRef.current || closedRef.current) return;
    const check = groupNameCheck(text, groups, create ? undefined : exceptId);
    if (!check.ok) {
      setError(NAME_ERROR_TEXT[check.error]);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const res = await onSubmit(check.name);
    busyRef.current = false;
    if (closedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone?.(res);
    close();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={[styles.backdrop, { justifyContent: up ? "flex-start" : wide ? "center" : "flex-end", paddingTop: up ? insets.top + space.md : 0 }]}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={close} accessibilityRole="button" accessibilityLabel="이름 창 닫기" />
        <View
          testID="watch-name-sheet"
          style={[
            styles.sheet,
            wide || up ? styles.sheetFloat : styles.sheetBottom,
            { backgroundColor: t.surface, borderColor: t.lineStrong, maxHeight: maxH, paddingBottom: wide || up ? space.lg : insets.bottom + space.lg },
          ]}
        >
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled" bounces={false}>
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
              onFocus={() => {
                setFocused(true);
                setHeld(true);
              }}
              onBlur={() => setFocused(false)}
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
          </ScrollView>
          <View style={styles.actions}>
            <Button title="취소" variant="secondary" onPress={close} style={styles.grow} />
            <Button title={busy ? (create ? "만드는 중" : "바꾸는 중") : create ? "만들기" : "바꾸기"} loading={busy} onPress={() => void submit()} style={styles.grow} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center" },
  sheet: { width: "100%", maxWidth: tossSheet.maxW, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm, overflow: "hidden" },
  sheetBottom: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetFloat: { borderRadius: radius.lg },
  // 자판 때문에 창이 낮아지면 위쪽(제목·입력칸·글자 수)만 스크롤 — 버튼 줄은 늘 보인다
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollBody: { gap: space.sm },
  title: { fontSize: font.h2, fontWeight: "700" },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: font.body },
  under: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  error: { flex: 1, fontSize: font.small },
  actions: { flexDirection: "row", gap: space.sm, paddingTop: space.xs },
  grow: { flex: 1 },
});
