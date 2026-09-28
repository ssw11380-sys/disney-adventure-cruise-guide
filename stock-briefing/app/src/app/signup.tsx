import * as Device from "expo-device";
import { router } from "expo-router";
import React, { useRef, useState } from "react";
import { AccessibilityInfo, StyleSheet, Text, type TextInput } from "react-native";
import { useApi } from "@/api/hooks";
import { AuthButton, AuthField, AuthLink, AuthNotice } from "@/components/auth/AuthParts";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { authErrorView } from "@/lib/authErrors";
import { confirmError, EMAIL_NOTE, emailError, fieldMessage, HELP, loginIdError, normalizeEmail, normalizeLoginId, passwordError, signupErrors, type SignupField } from "@/lib/authRules";
import { markFailOpen, saveSession, setRememberPreference } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { authColors as C, authFont, fontCap } from "@/tokens";

/**
 * 회원가입 (계정 A단계). 네 칸만: 아이디 · 비밀번호 · 비밀번호 확인 · 이메일. 가입하면 바로 로그인(자동 로그인 켬).
 * 칸을 떠날 때 서버와 같은 규칙(lib/authRules)으로 먼저 알려 주고, 서버 오류(아이디·이메일 중복 등)도 칸마다 보인다.
 * 새 계정은 주인 데이터를 볼 수 없다 — 시장·종목 정보만 (개인 종목 기능은 다음 단계, 서버가 막는다)
 */
export default function SignupScreen() {
  const api = useApi();
  const { apiUrl } = useSettings();
  const [v, setV] = useState({ loginId: "", password: "", passwordConfirm: "", email: "" });
  const [errors, setErrors] = useState<Partial<Record<SignupField, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);

  const set = (k: SignupField) => (text: string) => {
    setV((o) => ({ ...o, [k]: text }));
    if (errors[k]) setErrors((o) => ({ ...o, [k]: undefined }));
  };
  /** 칸을 떠날 때 그 칸만 검사 (빈 칸은 보낼 때만) */
  const check = (k: SignupField) => () => {
    const raw = v[k];
    if (!raw) return;
    const code =
      k === "loginId" ? loginIdError(raw) : k === "password" ? passwordError(raw, loginIdError(v.loginId) ? "" : v.loginId) : k === "passwordConfirm" ? confirmError(v.password, raw) : emailError(raw);
    setErrors((o) => ({ ...o, [k]: code ? fieldMessage(k, code) : undefined }));
  };

  const submit = async () => {
    if (busy) return;
    const codes = signupErrors(v);
    const local: Partial<Record<SignupField, string>> = {};
    for (const [k, c] of Object.entries(codes)) local[k as SignupField] = fieldMessage(k, c);
    setMessage(null);
    setShowServer(false);
    if (Object.keys(local).length) {
      setErrors(local);
      AccessibilityInfo.announceForAccessibility(Object.values(local)[0]!);
      return;
    }
    setBusy(true);
    try {
      const r = await api.signup({ loginId: normalizeLoginId(v.loginId), password: v.password, passwordConfirm: v.passwordConfirm, email: normalizeEmail(v.email), remember: true, deviceName: Device.modelName ?? null });
      setRememberPreference(true);
      await saveSession({ apiUrl, token: r.token, remember: true, user: r.user });
    } catch (e) {
      const view = authErrorView(e);
      if (view.failOpen) {
        markFailOpen(apiUrl);
        return;
      }
      setErrors(view.fields);
      setMessage(view.message);
      setShowServer(view.showServer);
      const say = view.message ?? Object.values(view.fields)[0];
      if (say) AccessibilityInfo.announceForAccessibility(say);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame top="header" title="회원가입">
      <AuthField
        label="아이디"
        value={v.loginId}
        onChangeText={set("loginId")}
        onBlur={check("loginId")}
        error={errors.loginId ?? null}
        help={HELP.loginId}
        autoComplete="username-new"
        textContentType="username"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        submitBehavior="submit"
      />
      <AuthField
        ref={passwordRef}
        label="비밀번호"
        secret
        value={v.password}
        onChangeText={set("password")}
        onBlur={check("password")}
        error={errors.password ?? null}
        help={HELP.password}
        autoComplete="password-new"
        textContentType="newPassword"
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        submitBehavior="submit"
      />
      <AuthField
        ref={confirmRef}
        label="비밀번호 확인"
        secret
        value={v.passwordConfirm}
        onChangeText={set("passwordConfirm")}
        onBlur={check("passwordConfirm")}
        error={errors.passwordConfirm ?? null}
        autoComplete="password-new"
        textContentType="newPassword"
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
        submitBehavior="submit"
      />
      <AuthField
        ref={emailRef}
        label="이메일"
        value={v.email}
        onChangeText={set("email")}
        onBlur={check("email")}
        error={errors.email ?? null}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      {message ? <AuthNotice text={message} action={showServer ? { title: "서버 설정 열기", onPress: () => router.push("/server") } : undefined} /> : null}
      <AuthButton title="가입하고 시작하기" onPress={() => void submit()} loading={busy} />
      <Text style={styles.note} maxFontSizeMultiplier={fontCap.chrome}>
        {EMAIL_NOTE}
      </Text>
      <AuthLink title="이미 계정이 있어요 · 로그인" accessibilityLabel="로그인 화면으로" onPress={() => (router.canGoBack() ? router.back() : router.replace("/login"))} />
    </AuthFrame>
  );
}

const styles = StyleSheet.create({
  note: { color: C.muted, fontSize: authFont.label, textAlign: "center" },
});

export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
