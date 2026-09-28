import Ionicons from "@expo/vector-icons/Ionicons";
import { LinearGradient } from "expo-linear-gradient";
import React, { createContext, useContext, useId, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { Defs, LinearGradient as SvgLinearGradient, RadialGradient, Rect, Stop, Svg, Text as SvgText } from "react-native-svg";
import { DISCLAIMER } from "@/lib/disclaimer";
import { miniStairs, wordmarkH } from "@/lib/loginHero";
import { authColors as C, authFont, authLayout, fontCap, space, touch } from "@/tokens";

/**
 * 로그인·회원가입 화면 공용 부품 (계정 A단계). 앱 테마와 상관없이 늘 고급 다크 (tokens authColors — hero-spec.md 2장).
 * 누르는 곳 44dp 이상, 화면 읽기 이름은 칸 이름 그대로('아이디'·'비밀번호'·'자동 로그인'), 글자는 시스템 글자 크기를 따르되 150% 까지.
 * 강조는 금색 하나: 입력 중인 칸의 테두리·바깥 옅은 테두리, [로그인] 금색 그러데이션, 자동 로그인 체크. 오류는 주황(상승 빨강과 헷갈리지 않게)
 */

/** 화면 전체 바탕: 남색 → 검정 세로 그러데이션 */
export function AuthBackground() {
  return <LinearGradient colors={[C.bgTop, C.bgMid, C.bgBottom]} locations={[0, 0.55, 1]} style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]} />;
}

/**
 * 키보드가 누른 칸을 가리지 않게 (AuthFrame 이 준다): 칸을 누르면 그 칸(과 below 만큼 아래)을 키보드 위로 스크롤한다.
 * 키보드가 아직 안 떴으면 뜬 뒤에 한다
 */
export interface AuthReveal {
  focus: (input: TextInput | null, below: number) => void;
}
export const AuthRevealContext = createContext<AuthReveal | null>(null);

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
  /** 이 칸을 누르면 칸 아래로 이만큼 더 보이게 (비밀번호 칸 → [로그인] 버튼까지) */
  revealBelow?: number;
}

/** 웹 미리보기에서 브라우저 초점 테두리(흰 사각형)가 금색 테두리를 가리지 않게 — 폰에는 없는 테두리라 웹에서만 */
const WEB_NO_OUTLINE = Platform.OS === "web" ? ({ outlineStyle: "none" } as unknown as TextStyle) : null;

const setRef = <T,>(ref: React.Ref<T> | undefined, v: T | null) => {
  if (typeof ref === "function") ref(v);
  else if (ref) (ref as React.RefObject<T | null>).current = v;
};

/** 입력 칸: 이름(12) · 칸(48, 둥글기 12) · 아래 오류(주황 + 아이콘)/도움말. 입력 중이면 금색 테두리 + 바깥 3dp 옅은 금색 */
export function AuthField({ label, value, onChangeText, error, help, secret, onFocus, onBlur, accessibilityLabel, ref, revealBelow = 0, ...rest }: AuthFieldProps) {
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  const reveal = useContext(AuthRevealContext);
  const inner = useRef<TextInput | null>(null);
  const border = error ? C.danger : focused ? C.fieldFocus : C.fieldLine;
  const note = error ?? help ?? null;
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={fontCap.chrome} importantForAccessibility="no">
        {label}
      </Text>
      <View>
        {focused ? <View style={[styles.ring, { borderColor: error ? C.dangerRing : C.focusRing }]} /> : null}
        <View style={[styles.inputBox, { borderColor: border, backgroundColor: focused ? C.fieldActive : C.field }]}>
          <TextInput
            ref={(v) => {
              inner.current = v;
              setRef(ref, v);
            }}
            value={value}
            onChangeText={onChangeText}
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityHint={error ?? undefined}
            secureTextEntry={secret ? !shown : false}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={C.muted}
            selectionColor={C.gold}
            cursorColor={C.gold}
            maxFontSizeMultiplier={fontCap.chrome}
            onFocus={(e) => {
              setFocused(true);
              // 칸 아래 한 줄(오류·도움말)까지 보이게
              reveal?.focus(inner.current, revealBelow + authLayout.groupGap);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            style={[styles.input, WEB_NO_OUTLINE]}
            {...rest}
          />
          {secret ? (
            <Pressable
              onPress={() => setShown((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={shown ? `${label} 숨기기` : `${label} 보기`}
              hitSlop={space.xs}
              style={({ pressed }) => [styles.eye, pressed ? styles.pressedDim : null]}
            >
              <Ionicons name={shown ? "eye-off-outline" : "eye-outline"} size={20} color={shown ? C.gold : C.sub} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {note ? (
        <View style={styles.noteRow}>
          {error ? <Ionicons name="alert-circle" size={14} color={C.danger} style={styles.noteIcon} /> : null}
          <Text style={[styles.note, error ? { color: C.danger } : null]} maxFontSizeMultiplier={fontCap.chrome} accessibilityLiveRegion={error ? "polite" : "none"}>
            {note}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** 체크 상자 (자동 로그인). 줄 전체가 누르는 곳(44dp) */
export function AuthCheckbox({ checked, onChange, label, note, style }: { checked: boolean; onChange: (v: boolean) => void; label: string; note?: string | null; style?: StyleProp<ViewStyle> }) {
  const [pressed, setPressed] = useState(false);
  return (
    <View style={style}>
      <Pressable
        onPress={() => onChange(!checked)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="checkbox"
        accessibilityLabel={label}
        accessibilityState={{ checked }}
        style={styles.checkRow}
      >
        <View style={[styles.box, checked ? styles.boxOn : null, pressed ? (checked ? styles.boxOnPressed : styles.boxPressed) : null]}>
          {checked ? <Ionicons name="checkmark" size={16} color={C.primaryInk} /> : null}
        </View>
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

/** 버튼: primary = 금색 세로 그러데이션 · 검은 글자, secondary = 금색 옅은 테두리 · 흰 글자. 누르면 한 단계 어둡게/옅은 금색 바탕 */
export function AuthButton({ title, onPress, loading, variant = "primary", accessibilityLabel, style }: { title: string; onPress: () => void; loading?: boolean; variant?: "primary" | "secondary"; accessibilityLabel?: string; style?: StyleProp<ViewStyle> }) {
  const primary = variant === "primary";
  const [pressed, setPressed] = useState(false);
  const down = pressed && !loading;
  return (
    <Pressable
      onPress={loading ? undefined : onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ busy: !!loading, disabled: !!loading }}
      style={[styles.button, { minHeight: authLayout.buttonH }, primary ? null : [styles.secondary, down ? { backgroundColor: C.secondaryPressed } : null], style]}
    >
      {primary ? (
        <LinearGradient
          colors={down ? [C.primaryPressedTop, C.primaryPressedBottom] : [C.primaryTop, C.primaryBottom]}
          style={[StyleSheet.absoluteFill, styles.buttonFill, { pointerEvents: "none" }]}
        />
      ) : null}
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
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={accessibilityLabel ?? title} style={({ pressed }) => [styles.link, pressed ? styles.pressedDim : null]}>
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
        <Pressable onPress={action.onPress} accessibilityRole="button" accessibilityLabel={action.title} hitSlop={space.sm} style={({ pressed }) => [styles.noticeAction, pressed ? styles.pressedDim : null]}>
          <Text style={styles.noticeActionText} maxFontSizeMultiplier={fontCap.chrome}>
            {action.title}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 그러데이션 글자가 이상하게 보이는 기기가 있으면 false 로 → 단색 금색 (hero-spec 3장).
 * 글자 로고는 장식이라 시스템 글자 크기를 따르지 않는다 (감싸는 View 가 '가즈아 불기둥' 머리글로 읽힌다)
 */
export const WORDMARK_GRADIENT = true;
/** 웹 미리보기에서 SVG 글자가 명조로 나오지 않게 (폰은 기본 글꼴) */
const WORDMARK_FONT = Platform.OS === "web" ? "-apple-system, 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', sans-serif" : undefined;

/** 금색 그러데이션 글자 '가즈아 불기둥' (react-native-svg). 그림 칸 폭 = 글자 크기 × 7, 높이 × 1.3 */
export function GoldWordmark({ size }: { size: number }) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const w = Math.ceil(size * authLayout.wordmarkCanvas);
  const h = wordmarkH(size);
  return (
    <Svg width={w} height={h}>
      {WORDMARK_GRADIENT ? (
        <Defs>
          <SvgLinearGradient id={`${uid}gold`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={C.goldHi} />
            <Stop offset="0.6" stopColor={C.gold} />
            <Stop offset="1" stopColor={C.goldLo} />
          </SvgLinearGradient>
        </Defs>
      ) : null}
      <SvgText x={0} y={Math.round(size * 1.02)} fontSize={size} fontWeight="800" letterSpacing={-0.6} fontFamily={WORDMARK_FONT} fill={WORDMARK_GRADIENT ? `url(#${uid}gold)` : C.gold}>
        가즈아 불기둥
      </SvgText>
    </Svg>
  );
}

/** 글자 로고 '가즈아 불기둥' + 금색 선 (+ 부제) — 움직이지 않는 것 (회원가입 머리, 접은 그림). 로그인 그림의 것은 LoginHero 가 움직인다 */
export function AuthLogo({ size, subtitle = true }: { size: number; subtitle?: boolean }) {
  return (
    <View accessible accessibilityRole="header" accessibilityLabel="가즈아 불기둥">
      <GoldWordmark size={size} />
      <View style={styles.logoLine} />
      {subtitle ? <LogoSubtitle /> : null}
    </View>
  );
}

/** 부제: 사실만 ('수익'·'추천' 같은 말 없음) */
export function LogoSubtitle() {
  return (
    <Text style={styles.logoSub} allowFontScaling={false} numberOfLines={1}>
      시세 · 브리핑 · 지표
    </Text>
  );
}

/**
 * 회원가입 머리 오른쪽: 로그인 그림의 상한가 계단을 줄인 작은 정지 표시 (봉 6개, 60 × 72 — 몸통이 세로로 길어 봉으로 보이게) +
 * 맨 위 봉 둘레 옅은 붉은 빛. 빛은 칸 밖으로 번지게 그린다 (칸 경계에 빛이 잘린 선이 생기지 않게). 움직임 없음, 꾸밈이라 화면 읽기에서 뺌
 */
export function MiniStairs() {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const W = authLayout.miniStairsW;
  const H = authLayout.miniStairsH;
  const P = authLayout.miniStairsGlow;
  const { bodies, wicks } = miniStairs(W, H);
  const top = bodies[bodies.length - 1]!;
  return (
    <View style={{ width: W, height: H, overflow: "visible", pointerEvents: "none" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={{ position: "absolute", left: -P, top: -P }}>
        <Svg width={W + 2 * P} height={H + 2 * P}>
          <Defs>
            <RadialGradient id={`${uid}glow`} cx={P + top.x + top.w / 2} cy={P + top.y} r={P} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={C.glow} stopOpacity={0.3} />
              <Stop offset="0.5" stopColor={C.glow} stopOpacity={0.09} />
              <Stop offset="1" stopColor={C.glow} stopOpacity={0} />
            </RadialGradient>
            <SvgLinearGradient id={`${uid}limit`} x1="0" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor={C.limitLow} />
              <Stop offset="1" stopColor={C.limitHigh} />
            </SvgLinearGradient>
          </Defs>
          <Rect x={0} y={0} width={W + 2 * P} height={H + 2 * P} fill={`url(#${uid}glow)`} />
          {wicks.map((w, k) => (
            <Rect key={`w${k}`} x={P + w.x} y={P + w.y} width={w.w} height={w.h} fill={C.limitWick} />
          ))}
          {bodies.map((b, k) => (
            <Rect key={`b${k}`} x={P + b.x} y={P + b.y} width={b.w} height={b.h} rx={1} fill={`url(#${uid}limit)`} />
          ))}
        </Svg>
      </View>
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

const R = authLayout.radius;
const styles = StyleSheet.create({
  field: { gap: authLayout.labelGap },
  label: { color: C.sub, fontSize: authFont.label, fontWeight: "600", letterSpacing: 0.2 },
  ring: {
    position: "absolute",
    top: -authLayout.focusRing,
    left: -authLayout.focusRing,
    right: -authLayout.focusRing,
    bottom: -authLayout.focusRing,
    borderRadius: R + authLayout.focusRing,
    borderWidth: authLayout.focusRing,
    pointerEvents: "none",
  },
  inputBox: { flexDirection: "row", alignItems: "center", minHeight: authLayout.fieldH, borderWidth: 1, borderRadius: R },
  input: { flex: 1, minHeight: authLayout.fieldH, paddingHorizontal: space.md + space.xs, color: C.ink, fontSize: authFont.input },
  eye: { width: touch.min, height: touch.min, alignItems: "center", justifyContent: "center", marginRight: space.xs },
  noteRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xs },
  noteIcon: { marginTop: StyleSheet.hairlineWidth },
  note: { flex: 1, color: C.muted, fontSize: authFont.label, lineHeight: authLayout.logoSubH },
  checkRow: { flexDirection: "row", alignItems: "center", gap: space.sm + space.xxs, minHeight: touch.min, alignSelf: "flex-start", paddingRight: space.sm },
  box: { width: authLayout.checkbox, height: authLayout.checkbox, borderRadius: space.s, borderWidth: 1.5, borderColor: C.secondaryLine, alignItems: "center", justifyContent: "center" },
  boxPressed: { borderColor: C.gold, backgroundColor: C.secondaryPressed },
  boxOn: { backgroundColor: C.primary, borderColor: C.primary },
  boxOnPressed: { backgroundColor: C.primaryPressed, borderColor: C.primaryPressed },
  checkLabel: { color: C.ink, fontSize: authFont.check, fontWeight: "600" },
  checkNote: { color: C.muted, fontSize: authFont.label, marginTop: -space.xs, marginLeft: authLayout.checkbox + space.sm + space.xxs },
  // 보이는 높이 48 (authLayout.buttonH), 누르는 곳은 늘 44 이상
  button: { minHeight: touch.min, borderRadius: R, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.lg, overflow: "hidden" },
  buttonFill: { borderRadius: R },
  secondary: { borderColor: C.secondaryLine, borderWidth: 1 },
  buttonText: { fontSize: authFont.button, fontWeight: "700", letterSpacing: 0.2 },
  pressedDim: { opacity: 0.6 },
  link: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs + space.xxs, minHeight: touch.min, alignSelf: "center", paddingHorizontal: space.md },
  linkText: { color: C.muted, fontSize: authFont.link },
  notice: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: R, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: touch.min },
  noticeError: { backgroundColor: C.field, borderWidth: 1, borderColor: C.danger },
  noticeInfo: { backgroundColor: C.notice },
  noticeText: { flex: 1, color: C.ink, fontSize: authFont.link, lineHeight: authLayout.logoSubH + space.xxs },
  noticeAction: { minHeight: touch.min, justifyContent: "center", paddingHorizontal: space.xs },
  noticeActionText: { color: C.gold, fontSize: authFont.link, fontWeight: "700" },
  logoLine: { width: authLayout.logoLineW, height: authLayout.logoLineH, backgroundColor: C.goldLine, marginTop: authLayout.logoLineGap },
  logoSub: { color: C.muted, fontSize: authFont.sub, letterSpacing: 0.4, lineHeight: authLayout.logoSubH, marginTop: authLayout.logoSubGap },
  disclaimer: { color: C.muted, fontSize: authFont.tiny, lineHeight: authLayout.logoSubH, textAlign: "center", paddingHorizontal: space.md, paddingBottom: space.xs },
});
