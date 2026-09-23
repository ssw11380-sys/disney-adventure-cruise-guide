import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { changeColor, font, radius, space, useTheme } from "@/theme";

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
      <Text style={[styles.sectionTitle, { color: t.ink }]}>{children}</Text>
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
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
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
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { backgroundColor: bg, borderColor: border, opacity: off ? 0.45 : pressed ? 0.8 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Ionicons name={icon} size={compact ? 14 : 16} color={fg} /> : null}
      <Text style={[styles.buttonText, compact && { fontSize: font.small }, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** 작은 선택 칩 (사각) */
export function Chip({ label, active, onPress, icon }: { label: string; active?: boolean; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
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
    <View style={[styles.segment, { borderBottomColor: t.line, backgroundColor: t.surface }, style]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: active }} style={[styles.segmentItem, { borderBottomColor: active ? t.ink : "transparent" }]}>
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

/** 등락 색: 한국 관례 (상승 빨강, 하락 파랑) */
export function ChangeText({ value, text, style }: { value: number | null | undefined; text: string; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  // 보합(0)·값 없음은 앱 전체 공통 규칙(changeColor)대로 기본 글자색
  return <Text style={[{ color: changeColor(t, value) }, NUM, style]}>{text}</Text>;
}

/** 등락률 상자 (HTS 목록의 색 칠한 등락률 칸) */
export function RateBox({ value, text, style }: { value: number | null | undefined; text: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const up = (value ?? 0) > 0, down = (value ?? 0) < 0;
  const bg = up ? t.up : down ? t.down : t.surfaceAlt;
  return (
    <View style={[styles.rateBox, { backgroundColor: bg }, style]}>
      <Text style={[{ color: up || down ? "#FFFFFF" : t.muted, fontSize: font.small, fontWeight: "700" }, NUM]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
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

/** 시세표 한 칸: 왼쪽 항목명, 오른쪽 값 (2열 격자에 쓴다) */
export function Stat({ label, value, tone, change }: { label: string; value: React.ReactNode; tone?: "up" | "down"; change?: number | null }) {
  const t = useTheme();
  const color = tone === "up" ? t.up : tone === "down" ? t.down : change !== undefined ? changeColor(t, change) : t.ink;
  return (
    <View style={[styles.stat, { borderBottomColor: t.line }]}>
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

const styles = StyleSheet.create({
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  sectionTitle: { fontSize: font.h2, fontWeight: "700" },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonCompact: { height: 32, paddingHorizontal: space.md },
  buttonText: { fontSize: font.body, fontWeight: "700" },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 5 },
  segment: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: 11, borderBottomWidth: 2 },
  badge: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  rateBox: { minWidth: 64, alignItems: "flex-end", borderRadius: 3, paddingHorizontal: 6, paddingVertical: 3 },
  center: { alignItems: "center", justifyContent: "center", padding: space.xl },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  grid: { flexDirection: "row", flexWrap: "wrap", columnGap: space.lg },
  stat: { width: "47%", flexGrow: 1, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  tableHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
});
