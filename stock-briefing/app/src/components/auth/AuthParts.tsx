import Ionicons from "@expo/vector-icons/Ionicons";
import { LinearGradient } from "expo-linear-gradient";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { DISCLAIMER } from "@/lib/disclaimer";
import { authColors as C, authFont, authLayout, fontCap, radius, space, touch } from "@/tokens";

/**
 * 로그인·회원가입 화면 공용 부품 (계정 A단계). 앱 테마와 상관없이 늘 고급 다크 (tokens authColors — hero-spec.md 2장).
 * 누르는 곳 44dp 이상, 화면 읽기 이름은 칸 이름 그대로('아이디'·'비밀번호'·'자동 로그인'), 글자는 시스템 글자 크기를 따르되 150% 까지
 */

/** 화면 전체 바탕: 남색 → 검정 세로 그러데이션 */
export function AuthBackground() {
  return <LinearGradient colors={[C.bgTop, C.bgMid, C.bgBottom]} locations={[0, 0.55, 1]} style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]} />;
}

export interface AuthFieldProps extends Omit<TextInputProps, "style" | "secureTextEntry"> {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  /** 칸 아래 오류 (있으면 테두리도 주황) */
  error?: string | null;
  /** 칸 아래 도움말 (오류가 없을 때) */
  help?: string;
  /** 비밀번호 칸: 눈 모양 버튼으로 보기/숨기기 */
  secret?: boolean;
  /** 키보드 '다음'으로 옮겨 갈 때 (React 19 — ref 는 보통 속성) */
  ref?: React.Ref<TextInput>;
}

/** 입력 칸: 이름(12) · 칸(48) · 아래 오류/도움말 */
export function AuthField({ label, value, onChangeText, error, help, secret, onFocus, onBlur, accessibilityLabel, ref, ...rest }: AuthFieldProps) {
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  const border = error ? C.danger : focused ? C.fieldFocus : C.fieldLine;
  const note = error ?? help ?? null;
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={fontCap.chrome} importantForAccessibility="no">
        {label}
      </Text>
      <View style={[styles.inputBox, { borderColor: border }]}>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={error ?? undefined}
          secureTextEntry={secret ? !shown : false}
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={C.muted}
          selectionColor={C.gold}
          maxFontSizeMultiplier={fontCap.chrome}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={styles.input}
          {...rest}
        />
        {secret ? (
          <Pressable
            onPress={() => setShown((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={shown ? `${label} 숨기기` : `${label} 보기`}
            hitSlop={space.sm}
            style={styles.eye}
          >
            <Ionicons name={shown ? "eye-off-outline" : "eye-outline"} size={20} color={C.sub} />
          </Pressable>
        ) : null}
      </View>
      {note ? (
        <Text style={[styles.note, error ? { color: C.danger } : null]} maxFontSizeMultiplier={fontCap.chrome} accessibilityLiveRegion={error ? "polite" : "none"}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** 체크 상자 (자동 로그인). 줄 전체가 누르는 곳(44dp) */
export function AuthCheckbox({ checked, onChange, label, note }: { checked: boolean; onChange: (v: boolean) => void; label: string; note?: string | null }) {
  return (
    <View>
      <Pressable
        onPress={() => onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityState={{ checked }}
        style={styles.checkRow}
      >
        <View style={[styles.box, checked ? styles.boxOn : null]}>{checked ? <Ionicons name="checkmark" size={14} color={C.primaryInk} /> : null}</View>
        <Text style={styles.checkLabel} maxFontSizeMultiplier={fontCap.chrome}>
          {label}
        </Text>
      </Pressable>
      {note ? (
        <Text style={styles.checkNote} maxFontSizeMultiplier={fontCap.chrome}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** 버튼: primary = 금색 바탕 · 검은 글자, secondary = 금색 테두리 */
export function AuthButton({ title, onPress, loading, variant = "primary", accessibilityLabel, style }: { title: string; onPress: () => void; loading?: boolean; variant?: "primary" | "secondary"; accessibilityLabel?: string; style?: StyleProp<ViewStyle> }) {
  const primary = variant === "primary";
  return (
    <Pressable
      onPress={loading ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ busy: !!loading, disabled: !!loading }}
      style={({ pressed }) => [styles.button, { minHeight: authLayout.buttonH }, primary ? { backgroundColor: pressed ? C.primaryPressed : C.primary } : { borderColor: C.secondaryLine, borderWidth: 1, opacity: pressed ? 0.8 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={primary ? C.primaryInk : C.gold} size="small" /> : null}
      <Text style={[styles.buttonText, { color: primary ? C.primaryInk : C.ink }]} maxFontSizeMultiplier={fontCap.chrome}>
        {title}
      </Text>
    </Pressable>
  );
}

/** 작은 글 링크 ('서버 설정' · '로그인') — 누르는 곳 44dp */
export function AuthLink({ title, onPress, accessibilityLabel, icon }: { title: string; onPress: () => void; accessibilityLabel?: string; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={accessibilityLabel ?? title} style={styles.link}>
      {icon ? <Ionicons name={icon} size={14} color={C.muted} /> : null}
      <Text style={styles.linkText} maxFontSizeMultiplier={fontCap.chrome}>
        {title}
      </Text>
    </Pressable>
  );
}

/** 한 줄 알림 (오류 = 주황, 안내 = 금색 옅은 바탕) + 오른쪽 버튼 하나 */
export function AuthNotice({ text, tone = "error", action }: { text: string; tone?: "error" | "info"; action?: { title: string; onPress: () => void } }) {
  const error = tone === "error";
  return (
    <View style={[styles.notice, error ? styles.noticeError : styles.noticeInfo]} accessibilityRole={error ? "alert" : "text"} accessibilityLiveRegion="polite">
      <Ionicons name={error ? "alert-circle-outline" : "information-circle-outline"} size={16} color={error ? C.danger : C.gold} />
      <Text style={[styles.noticeText, error ? { color: C.danger } : null]} maxFontSizeMultiplier={fontCap.chrome}>
        {text}
      </Text>
      {action ? (
        <Pressable onPress={action.onPress} accessibilityRole="button" accessibilityLabel={action.title} hitSlop={space.sm} style={styles.noticeAction}>
          <Text style={styles.noticeActionText} maxFontSizeMultiplier={fontCap.chrome}>
            {action.title}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 글자 로고 '가즈아 불기둥' + 금색 선 (+ 부제). 움직이는 로고는 다음 작업 (hero-spec 3장 — SVG 금색 그러데이션 글자) */
export function AuthLogo({ size, subtitle = true }: { size: number; subtitle?: boolean }) {
  return (
    <View accessible accessibilityRole="header" accessibilityLabel="가즈아 불기둥">
      <Text style={[styles.logo, { fontSize: size, lineHeight: Math.round(size * 1.25) }]} allowFontScaling={false}>
        가즈아 불기둥
      </Text>
      <View style={styles.logoLine} />
      {subtitle ? (
        <Text style={styles.logoSub} allowFontScaling={false}>
          시세 · 브리핑 · 지표
        </Text>
      ) : null}
    </View>
  );
}

/** 맨 아래 고지 (기존 문구 그대로) */
export function AuthDisclaimer() {
  return (
    <Text style={styles.disclaimer} maxFontSizeMultiplier={fontCap.chrome}>
      {DISCLAIMER}
    </Text>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.xs },
  label: { color: C.sub, fontSize: authFont.label, fontWeight: "600" },
  inputBox: { flexDirection: "row", alignItems: "center", minHeight: authLayout.fieldH, borderWidth: 1, borderRadius: radius.lg, backgroundColor: C.field },
  input: { flex: 1, minHeight: authLayout.fieldH, paddingHorizontal: space.md, color: C.ink, fontSize: authFont.input },
  eye: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center" },
  note: { color: C.muted, fontSize: authFont.label },
  checkRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touch.min, alignSelf: "flex-start" },
  box: { width: authLayout.checkbox, height: authLayout.checkbox, borderRadius: radius.sm, borderWidth: 1.5, borderColor: C.secondaryLine, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: C.primary, borderColor: C.primary },
  checkLabel: { color: C.ink, fontSize: authFont.link, fontWeight: "600" },
  checkNote: { color: C.muted, fontSize: authFont.label, marginTop: -space.xs },
  // 보이는 높이 50 (authLayout.buttonH), 누르는 곳은 늘 44 이상
  button: { minHeight: touch.min, borderRadius: radius.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.lg },
  buttonText: { fontSize: authFont.button, fontWeight: "700" },
  link: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, minHeight: touch.min, alignSelf: "center", paddingHorizontal: space.md },
  linkText: { color: C.muted, fontSize: authFont.link },
  notice: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: touch.min },
  noticeError: { backgroundColor: C.field, borderWidth: 1, borderColor: C.danger },
  noticeInfo: { backgroundColor: C.notice },
  noticeText: { flex: 1, color: C.ink, fontSize: authFont.link },
  noticeAction: { minHeight: touch.min, justifyContent: "center", paddingHorizontal: space.xs },
  noticeActionText: { color: C.gold, fontSize: authFont.link, fontWeight: "700" },
  logo: { color: C.gold, fontWeight: "800", letterSpacing: -0.6 },
  logoLine: { width: authLayout.logoLineW, height: authLayout.logoLineH, backgroundColor: C.goldLine, marginTop: space.sm },
  logoSub: { color: C.muted, fontSize: authFont.sub, letterSpacing: 0.4, marginTop: space.md },
  disclaimer: { color: C.muted, fontSize: authFont.tiny, textAlign: "center", paddingVertical: space.md },
});
