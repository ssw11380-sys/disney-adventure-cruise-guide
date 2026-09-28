import { router } from "expo-router";
import React from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { useSessionVersion } from "@/lib/account";
import { dismissInitialPasswordPrompt, initialPasswordPromptPending, sessionFor } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { authColors as C, authFont, authLayout, fontCap, radius, space } from "@/tokens";
import { AuthButton } from "./AuthParts";

/**
 * 처음 비밀번호(1111)로 로그인한 직후 한 번 보이는 권유 시트. 억지로 바꾸게 하지 않는다 — [나중에] 를 누르면 닫히고, 설정 맨 위 띠는 바꿀 때까지 남는다.
 * 로그인 화면과 같은 어두운 색·금색 버튼 (앱 테마와 상관없이 — 검증 4차: 밝은 테마에서는 로그인 직후 흰 시트가 튀어 보였다)
 */
export function InitialPasswordSheet() {
  const { apiUrl } = useSettings();
  useSessionVersion();
  const s = sessionFor(apiUrl);
  const open = initialPasswordPromptPending() && !!s?.user.usingInitialPassword;
  if (!open) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={dismissInitialPasswordPrompt} statusBarTranslucent>
      <View style={[styles.scrim, { backgroundColor: C.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: C.sheet, borderColor: C.fieldLine }]} accessibilityViewIsModal>
          <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={fontCap.chrome}>
            처음 비밀번호를 쓰고 있어요
          </Text>
          <Text style={styles.body} maxFontSizeMultiplier={fontCap.chrome}>
            다른 사람도 알 수 있는 비밀번호예요. 지금 바꾸는 것을 권해요.
          </Text>
          <View style={styles.buttons}>
            <AuthButton
              title="비밀번호 바꾸기"
              onPress={() => {
                dismissInitialPasswordPrompt();
                router.push("/account/password");
              }}
            />
            <AuthButton title="나중에" variant="secondary" onPress={dismissInitialPasswordPrompt} />
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
  title: { color: C.ink, fontSize: authFont.title, fontWeight: "700", letterSpacing: -0.2 },
  body: { color: C.sub, fontSize: authFont.check, lineHeight: 20 },
  buttons: { gap: authLayout.fieldGap, marginTop: space.sm },
});
