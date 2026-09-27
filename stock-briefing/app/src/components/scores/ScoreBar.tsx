import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { barFraction } from "@/lib/scoreView";
import { radius, useTheme } from "@/theme";
import { scores } from "@/tokens";

/**
 * 지표 점수 막대 (0~100). 회색 한 가지 — 좋음·나쁨·등락 색을 쓰지 않는다(설계 A9). 가운데 50 눈금 = '뚜렷한 추세 없음'.
 * 화면 읽기에서는 숨긴다 (숫자·띠를 같은 줄의 글이 읽는다)
 */
export function ScoreBar({ score, style }: { score: number | null; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const f = barFraction(score);
  return (
    <View style={[styles.wrap, style]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={[styles.track, { backgroundColor: t.lineStrong }]}>
        {f !== null ? <View style={[styles.fill, { width: `${f * 100}%`, backgroundColor: t.sub }]} /> : null}
      </View>
      <View style={[styles.tick, { backgroundColor: t.muted }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: scores.barMinW, height: scores.tickH, justifyContent: "center" },
  track: { height: scores.barH, borderRadius: radius.sm, overflow: "hidden" },
  fill: { height: scores.barH, borderRadius: radius.sm },
  tick: { position: "absolute", left: "50%", transform: [{ translateX: -scores.tickW / 2 }], top: 0, width: scores.tickW, height: scores.tickH },
});
