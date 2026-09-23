import { usePathname } from "expo-router";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, space, useTheme } from "@/theme";

export const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";

/**
 * 모든 화면 하단에 붙는 고지.
 * 탭 화면에서는 탭 바가 시스템 내비게이션 인셋을 이미 차지하므로 여백을 더하지 않고,
 * 탭 밖(상세·모달)에서는 인셋만큼 아래 여백을 준다.
 */
export function Disclaimer({ inTabs = false }: { inTabs?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.disclaimer, { borderTopColor: t.line, backgroundColor: t.bg, paddingBottom: inTabs ? space.sm : Math.max(insets.bottom, space.sm) }]}>
      <Text style={{ color: t.muted, fontSize: font.tiny, textAlign: "center" }}>{DISCLAIMER}</Text>
    </View>
  );
}

/**
 * 화면 래퍼: 배경색 + 스크롤. 패널(Card)은 화면 폭을 꽉 채워 위아래로 쌓인다(증권사 앱 방식).
 * disclaimer 면 투자 고지 한 줄을 아래에 붙인다(분석·브리핑 화면만).
 * scroll=false 면 자식이 직접 FlatList 등을 그린다.
 */
export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  contentStyle,
  disclaimer = false,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
  disclaimer?: boolean;
}) {
  const t = useTheme();
  const inTabs = /^\/(\(tabs\))?\/?(briefings|settings)?$/.test(usePathname());
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {scroll ? (
        <ScrollView
          style={styles.root}
          contentContainerStyle={[styles.content, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.root, contentStyle]}>{children}</View>
      )}
      {disclaimer ? <Disclaimer inTabs={inTabs} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: space.xl, gap: space.sm },
  disclaimer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, paddingHorizontal: space.lg },
});
