import { router } from "expo-router";
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSessionVersion } from "@/lib/account";
import { dismissInitialPasswordPrompt, initialPasswordPromptPending, sessionFor } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { font, fontCap, radius, space, touch, useTheme } from "@/theme";
import { authLayout } from "@/tokens";

/**
 * 처음 비밀번호(1111)로 로그인한 직후 한 번 보이는 권유 시트. 억지로 바꾸게 하지 않는다 — [나중에] 를 누르면 닫히고, 설정 맨 위 띠는 바꿀 때까지 남는다
 */
export function InitialPasswordSheet() {
  const t = useTheme();
  const { apiUrl } = useSettings();
  useSessionVersion();
  const s = sessionFor(apiUrl);
  const open = initialPasswordPromptPending() && !!s?.user.usingInitialPassword;
  if (!open) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismissInitialPasswordPrompt} statusBarTranslucent>
      <View style={[styles.scrim, { backgroundColor: t.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.line }]} accessibilityViewIsModal>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header" maxFontSizeMultiplier={fontCap.chrome}>
            처음 비밀번호를 쓰고 있어요
          </Text>
          <Text style={{ color: t.sub, fontSize: font.body, lineHeight: 21 }} maxFontSizeMultiplier={fontCap.chrome}>
            다른 사람도 알 수 있는 비밀번호예요. 지금 바꾸는 것을 권해요.
          </Text>
          <View style={styles.buttons}>
            <Pressable
              onPress={() => {
                dismissInitialPasswordPrompt();
                router.push("/account/password");
              }}
              accessibilityRole="button"
              accessibilityLabel="비밀번호 바꾸기"
              style={({ pressed }) => [styles.button, { backgroundColor: t.accent, opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={{ color: t.accentInk, fontSize: font.body, fontWeight: "700" }}>비밀번호 바꾸기</Text>
            </Pressable>
            <Pressable onPress={dismissInitialPasswordPrompt} accessibilityRole="button" accessibilityLabel="나중에" style={({ pressed }) => [styles.button, { borderColor: t.lineStrong, borderWidth: 1, opacity: pressed ? 0.8 : 1 }]}>
              <Text style={{ color: t.ink, fontSize: font.body }}>나중에</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: "flex-end" },
  // 넓은 창(펼친 폴드)에서도 입력 묶음 폭으로 가운데
  sheet: { width: "100%", maxWidth: authLayout.formMaxW + space.xl * 2, alignSelf: "center", borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.xl, gap: space.md },
  buttons: { gap: space.sm, marginTop: space.sm },
  button: { minHeight: touch.min + space.xs, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
});
