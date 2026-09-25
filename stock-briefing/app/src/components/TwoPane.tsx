import React from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { leftPaneWidth } from "@/lib/windowClass";
import { layout, useTheme } from "@/theme";

/**
 * 2단 화면 틀 (3-42 접는 폰, 기능 플래그 foldLayout 뒤에서만 쓴다 — 쓸지는 부르는 쪽이 useFoldLayout().twoPane 으로 정한다).
 *  - 왼쪽: 목록. 폭 고정(layout.listPaneW, 큰 글씨에서는 배율의 절반만큼 넓힘 — lib/windowClass leftPaneWidth)
 *  - 가운데: 1dp 구분선(layout.divider, 테마 line 색). 화면 읽기에서는 건너뛴다
 *  - 오른쪽: 상세. 남은 폭을 모두 쓴다. 고른 것이 없으면(right 가 없으면) empty 를 보인다
 *  - 화면 읽기(TalkBack) 순서는 그리는 순서 그대로 왼쪽 → 오른쪽
 *  - 좌우 화면 여백(카메라 구멍·둥근 모서리): 왼쪽 칸은 왼쪽 여백, 오른쪽 칸은 오른쪽 여백만큼 안쪽으로.
 *    탭 화면에서 왼쪽 세로 탭 막대가 이미 왼쪽 여백을 차지하면 insetLeft={false}
 * 위아래 여백은 부르는 쪽(탭 바·머리·고지)이 이미 맡으므로 여기서 더하지 않는다
 */
export function TwoPane({
  left,
  right,
  empty,
  insetLeft = true,
}: {
  left: React.ReactNode;
  /** 오른쪽 상세. null·undefined 면 empty 를 보인다 */
  right?: React.ReactNode;
  /** 오른쪽이 비었을 때 (예: '왼쪽에서 종목을 고르세요' 안내) */
  empty?: React.ReactNode;
  /** 왼쪽 화면 여백을 왼쪽 칸에 더할지 (기본 더함) */
  insetLeft?: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const padL = insetLeft ? insets.left : 0;
  const leftW = leftPaneWidth(width, fontScale) + padL;
  const detail = right === null || right === undefined ? (empty ?? null) : right;
  return (
    <View style={styles.root}>
      <View style={[styles.left, { width: leftW, paddingLeft: padL }]}>{left}</View>
      <View style={[styles.divider, { width: layout.divider, backgroundColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
      <View style={[styles.right, { paddingRight: insets.right }]}>{detail}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row" },
  left: { flexShrink: 0 },
  divider: { alignSelf: "stretch" },
  right: { flex: 1, minWidth: 0 },
});
