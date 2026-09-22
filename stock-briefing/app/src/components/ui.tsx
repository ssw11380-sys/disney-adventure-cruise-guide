import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { font, radius, space, useTheme } from "@/theme";

/** 공용 UI 조각. 색은 전부 테마 토큰에서 온다. */

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.sectionTitle, { color: t.ink }]}>{children}</Text>
      {right}
    </View>
  );
}

export function Muted({ children, style, numberOfLines }: { children: React.ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const t = useTheme();
  return (
    <Text style={[{ color: t.muted, fontSize: font.small }, style]} numberOfLines={numberOfLines}>
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
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = variant === "primary" ? t.accent : variant === "danger" ? t.danger : t.surfaceAlt;
  const fg = variant === "secondary" ? t.ink : t.accentInk;
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={16} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
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
            style={[styles.segmentItem, active && { backgroundColor: t.surface, borderColor: t.line }]}
          >
            <Text style={{ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? "600" : "400" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" }) {
  const t = useTheme();
  const color = tone === "good" ? t.accent : tone === "warn" ? t.warn : tone === "bad" ? t.danger : t.muted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={{ color, fontSize: font.tiny, fontWeight: "600" }}>{children}</Text>
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
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "600" }}>{title}</Text>
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
        <Text style={[{ color: t.ink, fontSize: font.small, fontVariant: ["tabular-nums"] }, valueStyle]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.lg, gap: space.sm },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.sm },
  sectionTitle: { fontSize: font.h2, fontWeight: "700" },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingVertical: 12,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  buttonText: { fontSize: font.body, fontWeight: "600" },
  segment: { flexDirection: "row", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 3 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent" },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  center: { alignItems: "center", justifyContent: "center", padding: space.xl },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
});
