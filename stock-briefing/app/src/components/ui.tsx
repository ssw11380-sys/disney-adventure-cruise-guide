import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { font, radius, space, useTheme } from "@/theme";

/** 공용 UI 조각. 색은 전부 테마 토큰에서 온다. */

export function Card({ children, style, padded = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: t.surface, borderColor: t.line, shadowColor: t.shadow, padding: padded ? space.lg : 0 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

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
    <Text style={[{ color: t.muted, fontSize: font.small, lineHeight: 18 }, style]} numberOfLines={numberOfLines}>
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
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={16} color={fg} /> : null}
      <Text style={[styles.buttonText, compact && { fontSize: font.small }, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** 작은 선택 칩 (정렬, 기간 등) */
export function Chip({ label, active, onPress, icon }: { label: string; active?: boolean; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [styles.chip, { backgroundColor: active ? t.ink : t.surface, borderColor: active ? t.ink : t.line, opacity: pressed ? 0.8 : 1 }]}
    >
      {icon ? <Ionicons name={icon} size={12} color={active ? t.surface : t.muted} /> : null}
      <Text style={{ color: active ? t.surface : t.ink, fontSize: font.small, fontWeight: active ? "700" : "500" }}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: t.surfaceAlt, borderColor: t.line }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segmentItem, active && { backgroundColor: t.surface, shadowColor: t.shadow, shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 }]}
          >
            <Text style={{ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? "700" : "500" }}>{o.label}</Text>
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
    <View style={[styles.badge, { borderColor: color, backgroundColor: `${color}14` }]}>
      <Text style={{ color, fontSize: font.tiny, fontWeight: "700", letterSpacing: 0.2 }}>{children}</Text>
    </View>
  );
}

/** 등락 색: 한국 관례 (상승 빨강, 하락 파랑) */
export function ChangeText({ value, text, style }: { value: number | null | undefined; text: string; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  const color = value === null || value === undefined || value === 0 ? t.muted : value > 0 ? t.up : t.down;
  return <Text style={[{ color, fontVariant: ["tabular-nums"] }, style]}>{text}</Text>;
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={t.accent} />
      {label ? <Muted style={{ marginTop: space.sm }}>{label}</Muted> : null}
    </View>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTheme();
  const message = error instanceof Error ? error.message : String(error);
  return (
    <View style={[styles.center, { gap: space.md }]}>
      <Ionicons name="cloud-offline-outline" size={28} color={t.muted} />
      <Text style={{ color: t.ink, textAlign: "center" }}>{message}</Text>
      {onRetry ? <Button title="다시 시도" variant="secondary" onPress={onRetry} /> : null}
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

export function Row({ label, value, valueStyle }: { label: string; value: React.ReactNode; valueStyle?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <View style={styles.kv}>
      <Text style={{ color: t.muted, fontSize: font.small }}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={[{ color: t.ink, fontSize: font.small, fontWeight: "600", fontVariant: ["tabular-nums"] }, valueStyle]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

/** 지표 타일 (시가/고가/PER 같은 격자) */
export function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "up" | "down" }) {
  const t = useTheme();
  const color = tone === "up" ? t.up : tone === "down" ? t.down : t.ink;
  return (
    <View style={[styles.stat, { backgroundColor: t.surfaceAlt }]}>
      <Text style={{ color: t.muted, fontSize: font.tiny, marginBottom: 2 }}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={{ color, fontSize: font.small, fontWeight: "700", fontVariant: ["tabular-nums"] }} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    gap: space.sm,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.xs },
  sectionTitle: { fontSize: font.h2, fontWeight: "800", letterSpacing: -0.2 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingVertical: 13,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm + 2,
  },
  buttonCompact: { paddingVertical: 8, paddingHorizontal: space.md },
  buttonText: { fontSize: font.body, fontWeight: "700" },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  segment: { flexDirection: "row", borderRadius: radius.sm + 2, borderWidth: StyleSheet.hairlineWidth, padding: 3 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: radius.sm },
  badge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  center: { alignItems: "center", justifyContent: "center", padding: space.xl },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5 },
  stat: { flexBasis: "30%", flexGrow: 1, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 10 },
});
