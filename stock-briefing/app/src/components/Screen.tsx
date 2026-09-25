import { usePathname } from "expo-router";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide, type FoldLayout } from "@/lib/windowClass";
import { font, layout, space, useTheme } from "@/theme";

import { DISCLAIMER } from "@/lib/disclaimer";

export { DISCLAIMER };

/**
 * 모든 화면 하단에 붙는 고지.
 * 탭 화면에서는 시스템 내비게이션 인셋을 아래 탭 바가, 탭이 왼쪽 세로 막대일 때(3-42)는 탭 화면 아래 여백
 * ((tabs)/_layout 의 sceneStyle)이 이미 차지하므로 여백을 더하지 않고,
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

interface ScreenProps {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
  disclaimer?: boolean;
  /** 스크롤과 무관하게 맨 위에 고정할 것 (끊김·지연 띠 등) */
  top?: React.ReactNode;
  /**
   * 넓은 창에서 내용을 가운데 읽기 폭(layout.readableMax)으로 모은다 (3-42, 기능 플래그 foldLayout).
   * 플래그가 꺼져 있거나 좁은 창(휴대폰·접힌 화면)이면 지금과 똑같다. 한 화면 안에서는 바꾸지 않는 고정 값으로 쓴다
   */
  readable?: boolean;
}

/**
 * 화면 래퍼: 배경색 + 스크롤. 패널(Card)은 화면 폭을 꽉 채워 위아래로 쌓인다(증권사 앱 방식).
 * disclaimer 면 투자 고지 한 줄을 아래에 붙인다(분석·브리핑 화면만).
 * scroll=false 면 자식이 직접 FlatList 등을 그린다.
 * readable 이면 넓은 창에서 내용 폭을 제한한다 — 이때만 플래그·창 크기를 읽어서, readable 을 쓰지 않는 화면은 전과 똑같이 그린다
 */
export function Screen(props: ScreenProps) {
  return props.readable ? <ReadableScreen {...props} /> : <ScreenBody {...props} />;
}

/** 폭 등급 중간 이상 + foldLayout 켜짐이면 가운데 모은 읽기 폭, 아니면 없음(지금과 같음) */
export function readableFrame(fold: FoldLayout): ViewStyle | undefined {
  return fold.on && isWide(fold) ? styles.readable : undefined;
}

function ReadableScreen(props: ScreenProps) {
  const frame = readableFrame(useFoldLayout());
  return <ScreenBody {...props} frame={frame} />;
}

function ScreenBody({ children, scroll = true, refreshing, onRefresh, contentStyle, disclaimer = false, top, frame }: ScreenProps & { frame?: ViewStyle }) {
  const t = useTheme();
  const inTabs = /^\/(\(tabs\))?\/?(briefings|settings)?$/.test(usePathname());
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {top}
      {scroll ? (
        <ScrollView
          style={styles.root}
          contentContainerStyle={[styles.content, contentStyle, frame]}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} /> : undefined}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.root, contentStyle, frame]}>{children}</View>
      )}
      {disclaimer ? <Disclaimer inTabs={inTabs} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: space.xl, gap: space.sm },
  disclaimer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, paddingHorizontal: space.lg },
  // 넓은 창에서 한 줄이 너무 길어지지 않게 가운데로 모은다 (부르는 쪽 contentStyle 보다 뒤에 두어 늘 적용)
  readable: { width: "100%", maxWidth: layout.readableMax, alignSelf: "center" },
});
