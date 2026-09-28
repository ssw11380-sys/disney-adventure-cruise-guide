import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React, { useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useApi } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { Button, Card, Muted, SectionTitle } from "@/components/ui";
import { AUTH_TEXT, authErrorView } from "@/lib/authErrors";
import { confirmError, fieldMessage, HELP, passwordError } from "@/lib/authRules";
import { rebindPushNow } from "@/lib/logout";
import { sessionFor, updateSessionUser } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { font, fontCap, radius, space, touch, useTheme } from "@/theme";

type Field = "current" | "next" | "nextConfirm";
const LABEL: Record<Field, string> = { current: "지금 비밀번호", next: "새 비밀번호", nextConfirm: "새 비밀번호 확인" };

/**
 * 비밀번호 바꾸기 (계정 A단계, 설정 > 계정). 지금 비밀번호 · 새 비밀번호 · 새 비밀번호 확인 (눈 모양으로 보기).
 * 바꾸면 이 기기는 그대로 로그인되어 있고 다른 기기는 로그아웃된다. 처음 비밀번호(1111) 표시가 사라진다
 */
export default function PasswordScreen() {
  const t = useTheme();
  const api = useApi();
  const { apiUrl } = useSettings();
  const [v, setV] = useState<Record<Field, string>>({ current: "", next: "", nextConfirm: "" });
  const [shown, setShown] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const loginId = sessionFor(apiUrl)?.user.loginId ?? "";

  const submit = async () => {
    if (busy) return;
    const local: Partial<Record<Field, string>> = {};
    if (!v.current) local.current = fieldMessage("current", "required");
    const n = passwordError(v.next, loginId);
    if (n) local.next = fieldMessage("next", n);
    const c = confirmError(v.next, v.nextConfirm);
    if (c) local.nextConfirm = fieldMessage("nextConfirm", c);
    setMessage(null);
    if (Object.keys(local).length) {
      setErrors(local);
      AccessibilityInfo.announceForAccessibility(Object.values(local)[0]!);
      return;
    }
    setBusy(true);
    try {
      const r = await api.changePassword({ current: v.current, next: v.next, nextConfirm: v.nextConfirm });
      await updateSessionUser(apiUrl, r.user);
      // 서버는 다른 세션과 계정 전(세션 없이) 등록한 알림 기기를 지운다 → 이 기기에서 알림을 켜 두었으면 지금 세션으로 다시 등록
      void rebindPushNow(api);
      setErrors({});
      setDone(true);
      AccessibilityInfo.announceForAccessibility(AUTH_TEXT.passwordChanged);
    } catch (e) {
      const view = authErrorView(e);
      setErrors(view.fields as Partial<Record<Field, string>>);
      setMessage(view.message);
      const say = view.message ?? Object.values(view.fields)[0];
      if (say) AccessibilityInfo.announceForAccessibility(say);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <Card>
          <View style={styles.doneRow}>
            <Ionicons name="checkmark-circle-outline" size={22} color={t.live} />
            <Text style={{ color: t.ink, fontSize: font.body, flex: 1 }} accessibilityLiveRegion="polite">
              {AUTH_TEXT.passwordChanged}
            </Text>
          </View>
          <Button title="설정으로 돌아가기" onPress={() => (router.canGoBack() ? router.back() : router.replace("/settings"))} style={{ marginTop: space.md }} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <SectionTitle
          right={
            <Pressable onPress={() => setShown((s) => !s)} accessibilityRole="button" accessibilityLabel={shown ? "비밀번호 숨기기" : "비밀번호 보기"} style={styles.eye} hitSlop={space.sm}>
              <Ionicons name={shown ? "eye-off-outline" : "eye-outline"} size={20} color={t.muted} />
            </Pressable>
          }
        >
          비밀번호 바꾸기
        </SectionTitle>
        <View style={{ gap: space.md }}>
          {(Object.keys(LABEL) as Field[]).map((k) => (
            <View key={k} style={{ gap: space.xs }}>
              <Muted>{LABEL[k]}</Muted>
              <TextInput
                value={v[k]}
                onChangeText={(text) => {
                  setV((o) => ({ ...o, [k]: text }));
                  if (errors[k]) setErrors((o) => ({ ...o, [k]: undefined }));
                }}
                secureTextEntry={!shown}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={k === "current" ? "current-password" : "new-password"}
                accessibilityLabel={LABEL[k]}
                accessibilityHint={errors[k]}
                maxFontSizeMultiplier={fontCap.chrome}
                style={[styles.input, { color: t.ink, borderColor: errors[k] ? t.danger : t.line, backgroundColor: t.surfaceAlt }]}
              />
              {errors[k] ? (
                <Text style={{ color: t.danger, fontSize: font.small }} accessibilityLiveRegion="polite">
                  {errors[k]}
                </Text>
              ) : k === "next" ? (
                <Muted style={{ fontSize: font.tiny }}>{HELP.password}</Muted>
              ) : null}
            </View>
          ))}
          {message ? <Text style={{ color: t.danger, fontSize: font.small }}>{message}</Text> : null}
          <Button title="비밀번호 바꾸기" onPress={() => void submit()} loading={busy} />
          <Muted style={{ fontSize: font.tiny }}>바꾸면 이 기기는 그대로 로그인되어 있고, 다른 기기는 로그아웃돼요.</Muted>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body, minHeight: touch.min },
  eye: { minWidth: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  doneRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
});

export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
