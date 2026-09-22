import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, space, useTheme } from "@/theme";

export const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";

/** 모든 화면 하단에 붙는 고지 */
export function Disclaimer() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.disclaimer, { borderTopColor: t.line, backgroundColor: t.bg, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      <Text style={{ color: t.muted, fontSize: font.tiny, textAlign: "center" }}>{DISCLAIMER}</Text>
    </View>
  );
}

/**
 * 화면 래퍼: 배경색 + 스크롤 + 고지 footer.
 * scroll=false 면 자식이 직접 FlatList 등을 그린다 (footer 는 그대로).
 */
export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  contentStyle,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {scroll ? (
        <ScrollView
          style={styles.root}
          contentContainerStyle={[styles.content, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.accent} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.root, contentStyle]}>{children}</View>
      )}
      <Disclaimer />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  disclaimer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, paddingHorizontal: space.lg },
});
