import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { shownSign } from "@/lib/format";
import { changeColor, font, radius, slopFor, space, touch, useTheme } from "@/theme";

/**
 * 공용 UI 조각 (증권사 MTS 톤). 그림자·둥근 카드 대신 평평한 패널과 얇은 구분선,
 * 숫자는 전부 고정폭(tabular-nums), 색은 테마 토큰만 쓴다.
 */

const NUM: TextStyle = { fontVariant: ["tabular-nums"] };

/** 패널: 화면 폭을 채우는 평평한 블록. padded=false 면 표처럼 가장자리까지 쓴다 */
export function Card({ children, style, padded = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line, padding: padded ? space.lg : 0 }, style]}>{children}</View>;
}

/** 패널 머리: 굵은 작은 제목 + 오른쪽 부가 요소 */
export function SectionTitle({ children, right, style }: { children: React.ReactNode; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[styles.sectionRow, style]}>
      <Text style={[styles.sectionTitle, { color: t.ink }]} accessibilityRole="header">
        {children}
      </Text>
      {right}
    </View>
  );
}

export function Muted({ children, style, numberOfLines }: { children: React.ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const t = useTheme();
  return (
    <Text style={[{ color: t.muted, fontSize: font.small, lineHeight: 17 }, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  icon,
  style,
  compact,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
  /** 화면 읽기 이름 (기본은 title). 같은 말의 버튼이 여럿이면 무엇의 버튼인지 붙인다 */
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const bg = variant === "primary" ? t.accent : variant === "danger" ? t.danger : variant === "ghost" ? "transparent" : t.surfaceAlt;
  const fg = variant === "primary" || variant === "danger" ? t.accentInk : variant === "ghost" ? t.accent : t.ink;
  const border = variant === "secondary" ? t.lineStrong : "transparent";
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      // 작은 버튼(32)은 위아래로 넓혀 44 로 (3-22)
      hitSlop={compact ? slopFor(COMPACT_H) : undefined}
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { backgroundColor: bg, borderColor: border, opacity: off ? 0.45 : pressed ? 0.8 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={compact ? 14 : 16} color={fg} /> : null}
      <Text style={[styles.buttonText, compact && { fontSize: font.small }, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** 작은 선택 칩 (사각). 보이는 높이 32 + 위아래 hitSlop 6 = 44 (3-22) */
export function Chip({ label, active, onPress, icon, accessibilityLabel }: { label: string; active?: boolean; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap; accessibilityLabel?: string }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!active }}
      hitSlop={slopFor(CHIP_H, space.xxs)}
      style={({ pressed }) => [styles.chip, { backgroundColor: active ? t.surfaceAlt : "transparent", borderColor: active ? t.accent : t.lineStrong, opacity: pressed ? 0.75 : 1 }]}
    >
      {icon ? <Ionicons name={icon} size={12} color={active ? t.accent : t.muted} /> : null}
      <Text style={{ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? "700" : "500" }}>{label}</Text>
    </Pressable>
  );
}

/** 밑줄 탭 (증권사 앱의 종목 상세 탭처럼) */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segment, { borderBottomColor: t.line, backgroundColor: t.surface }, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityLabel={o.label} accessibilityState={{ selected: active }} style={[styles.segmentItem, { borderBottomColor: active ? t.ink : "transparent" }]}>
            <Text style={{ color: active ? t.ink : t.muted, fontSize: font.body, fontWeight: active ? "700" : "500" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "gold" }) {
  const t = useTheme();
  const color = tone === "good" ? t.accent : tone === "warn" ? t.warn : tone === "bad" ? t.danger : tone === "gold" ? t.gold : t.muted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={{ color, fontSize: font.tiny, fontWeight: "700" }}>{children}</Text>
    </View>
  );
}

/**
 * 등락 색: 한국 관례 (상승 빨강, 하락 파랑).
 * numberOfLines·maxFontSizeMultiplier 는 머리처럼 한 줄·글자 확대 상한이 필요한 곳에서만 준다 (주지 않으면 지금과 같음)
 */
export function ChangeText({
  value,
  text,
  style,
  numberOfLines,
  maxFontSizeMultiplier,
}: {
  value: number | null | undefined;
  text: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  maxFontSizeMultiplier?: number;
}) {
  const t = useTheme();
  // 보합(0)은 앱 전체 공통 규칙(changeColor)대로 기본 글자색, 값 없음("-")은 회색.
  // 부호는 보이는 글자로: "$0.00 (0.00%)"·"0원" 처럼 0 으로 보이는 값은 손실·이익 색으로 칠하지 않는다 (BH-38)
  const color = value === null || value === undefined ? t.muted : changeColor(t, shownSign(value, text));
  return (
    <Text style={[{ color }, NUM, style]} numberOfLines={numberOfLines} maxFontSizeMultiplier={maxFontSizeMultiplier}>
      {text}
    </Text>
  );
}

/** 등락률 상자 (HTS 목록의 색 칠한 등락률 칸) */
export function RateBox({ value, text, style }: { value: number | null | undefined; text: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  // "0.00%" 로 보이는 값은 보합 칸 (BH-38)
  const sign = shownSign(value, text);
  const up = sign > 0, down = sign < 0;
  // 칠한 칸은 흰 글자가 4.5:1 이상 읽히는 진한 등락색 (3-20)
  const bg = up ? t.upFill : down ? t.downFill : t.surfaceAlt;
  return (
    <View style={[styles.rateBox, { backgroundColor: bg }, style]}>
      <Text style={[{ color: up || down ? t.onFill : t.muted, fontSize: font.small, fontWeight: "700" }, NUM]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** 켜고 끄기 스위치 — 앱의 모든 스위치는 이것만 쓴다 (모양 하나, 3-20) */
/**
 * accessibilityLabel 은 필수: 화면 읽기가 "켜짐/꺼짐" 앞에 무엇의 스위치인지 읽는다 (3-22).
 * 누르는 크기는 안드로이드 기본 스위치 크기를 따른다 (Switch 에는 hitSlop 이 먹지 않음) — 3-26 실기기에서 확인
 */
export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: { value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean; accessibilityLabel: string }) {
  const t = useTheme();
  return (
    // eslint-disable-next-line no-restricted-syntax -- 스위치를 감싸는 유일한 곳
    <Switch value={value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={accessibilityLabel} trackColor={{ true: t.accent, false: t.muted }} thumbColor={t.onFill} />
  );
}

/** 실시간·장중 점 (등락색이 아닌 초록, 3-20) */
export function LiveDot({ on = true, size = 6 }: { on?: boolean; size?: number }) {
  const t = useTheme();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: on ? t.live : t.muted }} />;
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={t.muted} />
      {label ? <Muted style={{ marginTop: space.sm }}>{label}</Muted> : null}
    </View>
  );
}

export function ErrorView({ error, onRetry, retryLabel = "다시 시도" }: { error: unknown; onRetry?: () => void; retryLabel?: string }) {
  const t = useTheme();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <View style={[styles.center, { gap: space.md }]}>
      <Text style={{ color: t.sub, textAlign: "center", fontSize: font.small }}>{message}</Text>
      {onRetry ? <Button title={retryLabel} variant="secondary" compact onPress={onRetry} /> : null}
    </View>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.center, { gap: space.sm }]}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>{title}</Text>
      {hint ? <Muted style={{ textAlign: "center" }}>{hint}</Muted> : null}
      {action}
    </View>
  );
}

/** 한 줄 항목: 왼쪽 이름, 오른쪽 값 */
export function Row({ label, value, valueStyle }: { label: string; value: React.ReactNode; valueStyle?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <View style={[styles.kv, { borderBottomColor: t.line }]}>
      <Text style={{ color: t.muted, fontSize: font.small }}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? <Text style={[{ color: t.ink, fontSize: font.small, fontWeight: "600" }, NUM, valueStyle]}>{value}</Text> : value}
    </View>
  );
}

/**
 * 시세표 한 칸: 왼쪽 항목명, 오른쪽 값 (2열 격자에 쓴다).
 * dense: 넓은 창 종목 상세 시세표(3-42)의 촘촘한 줄 — 글자 크기는 같고 위아래 여백만 줄인다 (설계 목업의 줄 높이 약 26)
 */
export function Stat({ label, value, tone, change, dense = false }: { label: string; value: React.ReactNode; tone?: "up" | "down"; change?: number | null; dense?: boolean }) {
  const t = useTheme();
  const color = tone === "up" ? t.up : tone === "down" ? t.down : change !== undefined ? changeColor(t, change) : t.ink;
  return (
    <View style={[styles.stat, dense ? styles.statDense : null, { borderBottomColor: t.line }]}>
      <Text style={{ color: t.muted, fontSize: font.small }}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={[{ color, fontSize: font.small, fontWeight: "600" }, NUM]} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

/** 2열 시세표 */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

/** 표 머리줄 (열 이름) */
export function TableHead({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.tableHead, { backgroundColor: t.surfaceAlt, borderColor: t.line }, style]}>{children}</View>;
}

/** 작은 버튼·칩의 보이는 높이 (hitSlop 으로 44 까지 넓힌다) */
const COMPACT_H = 32;
const CHIP_H = 32;

const styles = StyleSheet.create({
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.xxs },
  sectionTitle: { fontSize: font.h2, fontWeight: "700" },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s,
    minHeight: touch.min,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // 높이는 최소만 정해 큰 글씨에서 글자가 잘리지 않게 늘어난다
  buttonCompact: { minHeight: COMPACT_H, paddingHorizontal: space.md },
  buttonText: { fontSize: font.body, fontWeight: "700" },
  chip: { flexDirection: "row", alignItems: "center", gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, minHeight: CHIP_H },
  segment: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  segmentItem: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: touch.min, paddingVertical: space.sm, borderBottomWidth: 2 },
  badge: { borderWidth: 1, borderRadius: 3, paddingHorizontal: space.xs, paddingVertical: space.xxs },
  rateBox: { minWidth: 64, alignItems: "flex-end", borderRadius: 3, paddingHorizontal: space.s, paddingVertical: space.xxs },
  center: { alignItems: "center", justifyContent: "center", padding: space.xl },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  grid: { flexDirection: "row", flexWrap: "wrap", columnGap: space.lg },
  stat: { width: "47%", flexGrow: 1, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.s },
  statDense: { paddingVertical: space.xs },
  tableHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
});
