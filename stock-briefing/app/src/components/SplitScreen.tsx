import React, { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Disclaimer } from "@/components/Screen";
import { layout, useTheme } from "@/theme";

/** 왼쪽 칸이 실제로 받은 크기 (onLayout). 재기 전 첫 그림은 null */
export interface PaneSize {
  width: number;
  height: number;
}

/**
 * 좌우 배치 틀 (3-42 웨이브 C, 기능 플래그 foldLayout — 쓸지는 부르는 쪽이 lib/detailLayout detailMode 로 정한다).
 * 넓고 낮은 가로 창(펼친 폴드8 가로·울트라 가로)의 종목 상세에 쓴다:
 *  - 맨 위: head (합친 머리 — 위 화면 여백은 머리가 맡는다), 그 아래 top (끊김·지연 띠)
 *  - 왼쪽: 고정 칸. 칸이 실제로 받은 크기를 left 함수에 넘긴다 → 차트가 칸 높이에 맞춰 그려져 스크롤 없이 다 보인다.
 *    창이 아주 낮아 다 들어가지 않을 때만 왼쪽 칸이 스크롤된다
 *  - 오른쪽: 폭 sideW, 이 칸만 스크롤한다. 당겨서 새로고침도 이 칸에서
 *  - 맨 아래: 투자 고지 (탭 밖 화면이라 아래 화면 여백을 고지가 맡는다)
 *  - 좌우 화면 여백(카메라 구멍·둥근 모서리): 왼쪽 칸은 왼쪽 여백, 오른쪽 칸은 오른쪽 여백만큼 안쪽으로
 *  - 화면 읽기(TalkBack) 순서는 그리는 순서 그대로: 머리 → 띠 → 왼쪽 → 오른쪽 → 고지. 가운데 구분선은 건너뛴다
 */
export function SplitScreen({
  head,
  top,
  left,
  right,
  sideW,
  refreshing,
  onRefresh,
}: {
  head: React.ReactNode;
  top?: React.ReactNode;
  left: (size: PaneSize | null) => React.ReactNode;
  right: React.ReactNode;
  /** 오른쪽 칸 폭 (좌우 화면 여백 제외 — lib/detailLayout sideWidth) */
  sideW: number;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // 왼쪽 칸 자신의 크기. 같은 값이면 다시 그리지 않는다
  const [pane, setPane] = useState<PaneSize | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setPane((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  };
  // 왼쪽 칸이 받는 크기 = 칸 크기 − 왼쪽 화면 여백
  const inner = pane ? { width: Math.max(0, pane.width - insets.left), height: pane.height } : null;
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      {head}
      {top}
      <View style={styles.row}>
        <View style={[styles.left, { backgroundColor: t.surface }]} onLayout={onLayout}>
          <ScrollView style={styles.fill} contentContainerStyle={{ paddingLeft: insets.left }} keyboardShouldPersistTaps="handled">
            {left(inner)}
          </ScrollView>
        </View>
        <View style={[styles.divider, { width: layout.divider, backgroundColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
        <View style={{ width: sideW + insets.right }}>
          <ScrollView
            style={styles.fill}
            contentContainerStyle={[styles.rightContent, { paddingRight: insets.right }]}
            keyboardShouldPersistTaps="handled"
            refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} /> : undefined}
          >
            {right}
          </ScrollView>
        </View>
      </View>
      <Disclaimer />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flex: 1, flexDirection: "row" },
  left: { flex: 1, minWidth: 0 },
  fill: { flex: 1 },
  divider: { alignSelf: "stretch" },
  rightContent: { paddingBottom: 0 },
});
