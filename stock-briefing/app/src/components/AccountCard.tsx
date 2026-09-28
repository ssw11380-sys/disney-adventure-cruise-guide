import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React, { useState } from "react";
import { AccessibilityInfo, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useApi } from "@/api/hooks";
import { Badge, Button, Card, Muted, Row, SectionTitle } from "@/components/ui";
import { useAccountView } from "@/lib/account";
import { authErrorView } from "@/lib/authErrors";
import { emailError, fieldMessage } from "@/lib/authRules";
import { logout } from "@/lib/logout";
import { activeSession, updateSessionUser, type StoredSession } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { font, fontCap, radius, space, touch, useTheme } from "@/theme";

/**
 * 설정 탭 맨 위 '계정' 칸 (계정 A단계, 기능 플래그 accounts — 꺼져 있거나 로그인 전이면 없음. 다만 꺼져 있어도 지금 서버에 주인 아닌 계정 세션이 있으면
 * 아이디와 [로그아웃]만 — 검증 4차: 끈 동안에도 그 계정 폰에서 로그아웃할 수 있게. 비밀번호·이메일 바꾸기는 서버가 꺼 두어 뺀다).
 * 아이디(주인이면 '주인') · 이메일 등록/변경(지금 비밀번호를 함께 — 세션만으로는 바꾸지 못하게) · 자동 로그인 · [비밀번호 바꾸기] · [로그아웃] · [모든 기기에서 로그아웃](확인 창).
 * 처음 비밀번호(1111)를 쓰는 중이면 칸 위에 띠 '처음 비밀번호를 쓰고 있어요' + [바꾸기] (바꿀 때까지)
 */
export const INITIAL_PW_BANNER = "처음 비밀번호를 쓰고 있어요";

export function AccountCard() {
  const acct = useAccountView();
  if (acct.on && acct.session) return <AccountCardBody session={acct.session} />;
  const here = activeSession();
  if (!acct.on && acct.member && here && !here.user.isOwner) return <AccountCardBody session={here} limited />;
  return null;
}

/** 플래그가 꺼져 있을 때(비상 모드) 주인 아닌 계정에게 보이는 한 줄 */
export const ACCOUNTS_OFF_NOTE = "로그인 기능이 잠시 꺼져 있어요. 이 기기에서 로그아웃할 수 있어요.";

function AccountCardBody({ session, limited = false }: { session: StoredSession; limited?: boolean }) {
  const t = useTheme();
  const api = useApi();
  const { apiUrl } = useSettings();
  const u = session.user;
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(u.email ?? "");
  const [current, setCurrent] = useState("");
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [currentMsg, setCurrentMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState<"here" | "all" | null>(null);

  const closeEdit = () => {
    setEditing(false);
    setEmail(u.email ?? "");
    setCurrent("");
    setEmailMsg(null);
    setCurrentMsg(null);
  };

  const saveEmail = async () => {
    const code = emailError(email);
    const needPw = current ? null : fieldMessage("current", "required");
    setEmailMsg(code ? fieldMessage("email", code) : null);
    setCurrentMsg(needPw);
    if (code || needPw) {
      AccessibilityInfo.announceForAccessibility((code ? fieldMessage("email", code) : needPw)!);
      return;
    }
    setSaving(true);
    try {
      const r = await api.changeEmail(email.trim(), current);
      await updateSessionUser(apiUrl, r.user);
      closeEdit();
      AccessibilityInfo.announceForAccessibility("이메일을 저장했어요");
    } catch (e) {
      const v = authErrorView(e);
      const pw = v.fields["current"] ?? null;
      setCurrentMsg(pw);
      setEmailMsg(v.fields["email"] ?? (pw ? null : v.message));
      const say = pw ?? v.fields["email"] ?? v.message;
      if (say) AccessibilityInfo.announceForAccessibility(say);
    } finally {
      setSaving(false);
    }
  };

  const out = (all: boolean) => {
    const go = async () => {
      setLeaving(all ? "all" : "here");
      try {
        await logout(api, apiUrl, all);
      } catch (e) {
        Alert.alert("로그아웃하지 못했어요", authErrorView(e).message ?? "잠시 뒤 다시 해 주세요");
      } finally {
        setLeaving(null);
      }
    };
    if (all) {
      Alert.alert("모든 기기에서 로그아웃", "이 기기를 포함해 모든 기기에서 로그아웃해요.", [
        { text: "취소", style: "cancel" },
        { text: "로그아웃", style: "destructive", onPress: () => void go() },
      ]);
    } else {
      Alert.alert("로그아웃", "이 기기에서 로그아웃할까요?", [
        { text: "취소", style: "cancel" },
        { text: "로그아웃", onPress: () => void go() },
      ]);
    }
  };

  if (limited) {
    return (
      <Card>
        <SectionTitle>계정</SectionTitle>
        <Muted style={{ fontSize: font.small }}>{ACCOUNTS_OFF_NOTE}</Muted>
        <Row label="아이디" value={u.loginId} />
        <View style={[styles.buttons, { paddingTop: space.sm }]}>
          <Button title="로그아웃" icon="log-out-outline" variant="secondary" compact onPress={() => out(false)} loading={leaving === "here"} />
        </View>
      </Card>
    );
  }
  return (
    <Card>
      {u.usingInitialPassword ? (
        <View style={[styles.banner, { backgroundColor: t.surfaceAlt, borderColor: t.warn }]} accessibilityRole="alert">
          <Ionicons name="key-outline" size={16} color={t.warn} />
          <Text style={{ color: t.ink, fontSize: font.small, flex: 1 }} maxFontSizeMultiplier={fontCap.chrome}>
            {INITIAL_PW_BANNER}
          </Text>
          <Pressable onPress={() => router.push("/account/password")} accessibilityRole="button" accessibilityLabel="처음 비밀번호 바꾸기" style={styles.bannerAction}>
            <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }}>바꾸기</Text>
          </Pressable>
        </View>
      ) : null}
      <SectionTitle right={u.isOwner ? <Badge tone="gold">주인</Badge> : null}>계정</SectionTitle>
      <Row label="아이디" value={u.loginId} />
      <Row label="이메일" value={u.email ?? "없음"} />
      <Row label="자동 로그인" value={session.remember ? "켬 · 1년 유지" : "끔 · 앱을 닫으면 다시 로그인"} />
      {editing ? (
        <View style={{ gap: space.s, paddingTop: space.s }}>
          <TextInput
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setEmailMsg(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="이메일"
            accessibilityHint={emailMsg ?? undefined}
            placeholder="이메일"
            placeholderTextColor={t.muted}
            maxFontSizeMultiplier={fontCap.chrome}
            style={[styles.input, { color: t.ink, borderColor: emailMsg ? t.danger : t.line, backgroundColor: t.surfaceAlt }]}
          />
          {emailMsg ? <Text style={{ color: t.danger, fontSize: font.small }}>{emailMsg}</Text> : <Muted style={{ fontSize: font.tiny }}>비밀번호를 잃어버렸을 때 확인용으로만 씁니다.</Muted>}
          <TextInput
            value={current}
            onChangeText={(v) => {
              setCurrent(v);
              setCurrentMsg(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            accessibilityLabel="지금 비밀번호"
            accessibilityHint={currentMsg ?? "이메일을 바꾸려면 지금 비밀번호를 한 번 더 넣어 주세요"}
            placeholder="지금 비밀번호"
            placeholderTextColor={t.muted}
            maxFontSizeMultiplier={fontCap.chrome}
            style={[styles.input, { color: t.ink, borderColor: currentMsg ? t.danger : t.line, backgroundColor: t.surfaceAlt }]}
          />
          {currentMsg ? <Text style={{ color: t.danger, fontSize: font.small }}>{currentMsg}</Text> : null}
          <View style={styles.buttons}>
            <Button title="저장" compact onPress={() => void saveEmail()} loading={saving} accessibilityLabel="이메일 저장" />
            <Button title="취소" compact variant="secondary" onPress={closeEdit} accessibilityLabel="이메일 바꾸기 취소" />
          </View>
        </View>
      ) : null}
      <View style={[styles.buttons, { paddingTop: space.sm }]}>
        {editing ? null : <Button title={u.email ? "이메일 변경" : "이메일 등록"} icon="mail-outline" variant="secondary" compact onPress={() => setEditing(true)} />}
        <Button title="비밀번호 바꾸기" icon="key-outline" variant="secondary" compact onPress={() => router.push("/account/password")} />
      </View>
      <View style={[styles.buttons, { paddingTop: space.sm }]}>
        <Button title="로그아웃" icon="log-out-outline" variant="secondary" compact onPress={() => out(false)} loading={leaving === "here"} />
        <Button title="모든 기기에서 로그아웃" variant="ghost" compact onPress={() => out(true)} loading={leaving === "all"} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingLeft: space.md, marginBottom: space.md, minHeight: touch.min },
  bannerAction: { minHeight: touch.min, minWidth: touch.min, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
