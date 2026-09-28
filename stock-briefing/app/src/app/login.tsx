import * as Device from "expo-device";
import { router } from "expo-router";
import React, { useRef, useState } from "react";
import { AccessibilityInfo, type TextInput } from "react-native";
import { useApi } from "@/api/hooks";
import { AuthButton, AuthCheckbox, AuthField, AuthLink, AuthNotice } from "@/components/auth/AuthParts";
import { AuthFrame } from "@/components/auth/AuthFrame";
import { AUTH_TEXT, authErrorView, type AuthErrorView } from "@/lib/authErrors";
import { fieldMessage, normalizeLoginId } from "@/lib/authRules";
import { lastEndReason, markFailOpen, rememberPreference, requestInitialPasswordPrompt, saveSession, setRememberPreference } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { authLayout, space, touch } from "@/tokens";

/**
 * 로그인 (계정 A단계, 기능 플래그 accounts — 앱 루트가 세션이 없고 계정 모드일 때만 이 화면을 연다).
 * 늘 고급 다크. 위: 움직이는 첫 화면 그림(<LoginHero/> — 횡보 → 상한가 10봉 계단 → 불기둥 빛 + 금색 로고),
 * 아래: 아이디 · 비밀번호(눈 모양) · '자동 로그인'(기본 켬) · [로그인] · [회원가입], 맨 아래 '서버 설정'과 고지 문구.
 * 비밀번호 칸을 누르면 키보드 위로 [로그인] 버튼까지 보이게 스크롤한다.
 *  - 자동 로그인 켬: 1년 유지·쓸 때마다 연장, 인터넷이 끊겨도·앱을 업데이트해도 로그아웃되지 않는다. 끔: 앱을 완전히 닫으면 다시 로그인
 *  - 성공하면 세션을 저장하고 루트가 앱으로 넘긴다. 처음 비밀번호(1111)면 들어간 뒤 바꾸기 권유를 한 번
 *  - 예전 서버(로그인 주소가 없음, 404)면 로그인 없이 지금처럼 들어간다 (fail-open)
 */
export default function LoginScreen() {
  const api = useApi();
  const { apiUrl } = useSettings();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(rememberPreference());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<AuthErrorView | null>(null);
  const passwordRef = useRef<TextInput>(null);
  const ended = lastEndReason() === "invalid";

  const fail = (v: AuthErrorView) => {
    setErr(v);
    const say = v.message ?? Object.values(v.fields)[0];
    if (say) AccessibilityInfo.announceForAccessibility(say);
  };

  const submit = async () => {
    if (busy) return;
    const fields: Record<string, string> = {};
    if (!normalizeLoginId(loginId)) fields["loginId"] = fieldMessage("loginId", "required");
    if (!password) fields["password"] = fieldMessage("password", "required");
    if (Object.keys(fields).length) return fail({ message: null, fields, showServer: false, failOpen: false });
    setBusy(true);
    setErr(null);
    try {
      const r = await api.login({ loginId: normalizeLoginId(loginId), password, remember, deviceName: Device.modelName ?? null });
      setRememberPreference(remember);
      if (r.user.usingInitialPassword) requestInitialPasswordPrompt();
      // 저장하면 앱 루트(Stack.Protected)가 로그인 화면을 닫고 앱으로 넘긴다
      await saveSession({ apiUrl, token: r.token, remember, user: r.user });
    } catch (e) {
      const v = authErrorView(e);
      if (v.failOpen) {
        markFailOpen(apiUrl);
        return;
      }
      fail(v);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame top="hero" footer={<AuthLink title="서버 설정" icon="settings-outline" onPress={() => router.push("/server")} />}>
      {ended && !err ? <AuthNotice tone="info" text={AUTH_TEXT.sessionEnded} /> : null}
      <AuthField
        label="아이디"
        value={loginId}
        onChangeText={(v) => {
          setLoginId(v);
          if (err?.fields["loginId"]) setErr({ ...err, fields: { ...err.fields, loginId: "" } });
        }}
        error={err?.fields["loginId"] || null}
        autoComplete="username"
        textContentType="username"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        submitBehavior="submit"
      />
      <AuthField
        ref={passwordRef}
        label="비밀번호"
        secret
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          if (err?.fields["password"]) setErr({ ...err, fields: { ...err.fields, password: "" } });
        }}
        error={err?.fields["password"] || null}
        autoComplete="password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        revealBelow={authLayout.fieldGap * 2 + touch.min + authLayout.buttonH}
      />
      <AuthCheckbox checked={remember} onChange={setRemember} label="자동 로그인" note={remember ? null : "앱을 완전히 닫으면 다시 로그인해요"} style={{ marginTop: -space.xs }} />
      {err?.message ? <AuthNotice text={err.message} action={err.showServer ? { title: "서버 설정 열기", onPress: () => router.push("/server") } : undefined} /> : null}
      <AuthButton title="로그인" onPress={() => void submit()} loading={busy} style={{ marginTop: space.xs }} />
      <AuthButton title="회원가입" variant="secondary" onPress={() => router.push("/signup")} />
    </AuthFrame>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
