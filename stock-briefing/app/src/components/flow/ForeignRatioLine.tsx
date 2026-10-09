import React from "react";
import { StyleSheet, View } from "react-native";
import { linePoints, lineSegments } from "@/lib/flowView";
import { space, useTheme } from "@/theme";

/** 선 굵기 · 끝 점 지름 · 위아래 여백 */
const LINE_W = 2;
const DOT = 8;
const PAD = DOT / 2 + 1;

/**
 * 외국인 보유율 추이 선 (3-33 수급 탭, 한 줄이라 범례 없음 — 카드 제목이 이름). 오래된 날이 왼쪽, 가장 높은 값이 위.
 * View 를 선분마다 돌려 그린다(점이 많아야 61개 — 막대와 같이 react-native-svg 없이). 같은 직선 위의 점은 선분 하나로 합친다(값이 모두 같으면 가로선 하나).
 * 위아래 가는 선 = 가장 높음·가장 낮음 자리(곁글에 값).
 * 화면 읽기는 칸 하나로 처음·끝·가장 높음·낮음을 읽는다
 */
export function ForeignRatioLine({ series, width, height = 72, speech }: { series: readonly (readonly [string, number])[]; width: number; height?: number; speech: string }) {
  const t = useTheme();
  const pts = linePoints(series, width, height, PAD);
  const segs = lineSegments(pts);
  const last = pts[pts.length - 1];
  return (
    <View style={{ width, height, marginVertical: space.xs }} accessible accessibilityRole="image" accessibilityLabel={speech}>
      <View style={[styles.abs, { left: 0, width, top: PAD, height: StyleSheet.hairlineWidth, backgroundColor: t.line }]} />
      <View style={[styles.abs, { left: 0, width, top: height - PAD, height: StyleSheet.hairlineWidth, backgroundColor: t.line }]} />
      {segs.map((s, i) => (
        <View
          key={i}
          testID="flow-ratio-seg"
          style={[
            styles.abs,
            {
              // 끝을 둥글리지 않고 양쪽을 선 굵기의 반씩 늘려 겹친다 — 이음매가 점선처럼 보이거나 꺾인 곳에 틈이 생기지 않게
              left: s.cx - (s.len + LINE_W) / 2,
              top: s.cy - LINE_W / 2,
              width: s.len + LINE_W,
              height: LINE_W,
              backgroundColor: t.accent,
              transform: [{ rotate: `${s.deg}deg` }],
            },
          ]}
        />
      ))}
      {last ? (
        <View
          testID="flow-ratio-end"
          style={[styles.abs, { left: last.x - DOT / 2 - 2, top: last.y - DOT / 2 - 2, width: DOT + 4, height: DOT + 4, borderRadius: (DOT + 4) / 2, borderWidth: 2, borderColor: t.surface, backgroundColor: t.accent }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: "absolute" },
});
