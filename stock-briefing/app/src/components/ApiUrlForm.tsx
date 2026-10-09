import React from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Button, Muted } from "@/components/ui";
import { font, radius, space, useTheme } from "@/theme";

/**
 * 서버 주소·토큰 입력 (입력 중인 값은 부르는 화면이 들고 있다 — 카드가 새로 그려져도 남게).
 * 설정 탭 '서버 연결' 칸과 로그인 없이 여는 '서버 설정' 화면(/server, 계정 A단계)이 같이 쓴다
 */
export function ApiUrlForm({
  apiUrl,
  apiToken,
  draft,
  tokenDraft,
  onDraft,
  authRequired,
  onSave,
  onCheck,
  checking,
}: {
  apiUrl: string;
  apiToken: string;
  draft: string;
  tokenDraft: string;
  onDraft: (url: string, token: string) => void;
  authRequired: boolean;
  onSave: (url: string, token: string) => Promise<void>;
  onCheck: () => void;
  checking: boolean;
}) {
  const t = useTheme();
  const setDraft = (url: string) => onDraft(url, tokenDraft);
  const setTokenDraft = (token: string) => onDraft(draft, token);
  const dirty = draft.trim().replace(/\/+$/, "") !== apiUrl || tokenDraft.trim() !== apiToken;
  return (
    <View style={{ gap: space.sm }}>
      <Muted>서버 주소</Muted>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="서버 주소"
        placeholder="https://서버 주소"
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
      />
      <Muted>API 토큰</Muted>
      <TextInput
        value={tokenDraft}
        onChangeText={setTokenDraft}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        accessibilityLabel="API 토큰"
        placeholder={authRequired ? "서버에 설정한 API 토큰" : "서버에 토큰을 설정한 경우만"}
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.ink, borderColor: authRequired && !tokenDraft ? t.danger : t.line, backgroundColor: t.surfaceAlt }]}
      />
      <Button title={dirty ? "저장하고 연결 확인" : "연결 확인"} variant="secondary" onPress={() => (dirty ? void onSave(draft, tokenDraft) : onCheck())} loading={checking} />
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
});
