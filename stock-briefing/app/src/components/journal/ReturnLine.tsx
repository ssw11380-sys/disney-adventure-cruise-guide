import React, { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { Line, Path, Svg } from "react-native-svg";
import { changeColor, useTheme } from "@/theme";

/**
 * 날짜별 누적 수익률 선 (3-37 수익률 탭). 0% 가로선과 누적 값 선 하나 — 끝 값이 이익이면 빨강, 손실이면 파랑.
 * 숫자는 위 요약 문장이 읽으므로 화면 읽기에서는 숨긴다
 */
export const RETURN_LINE_H = 120;

export function linePath(values: number[], w: number, h: number): { d: string; zeroY: number } {
  if (!values.length || w <= 0) return { d: "", zeroY: h / 2 };
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const pad = 4;
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - lo) / span);
  const x = (i: number) => (values.length === 1 ? w / 2 : (w * i) / (values.length - 1));
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return { d, zeroY: y(0) };
}

export function ReturnLine({ series }: { series: { date: string; cum: number }[] }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const values = series.map((s) => s.cum);
  const { d, zeroY } = linePath(values, w, RETURN_LINE_H);
  const color = changeColor(t, values.at(-1) ?? 0);
  return (
    <View onLayout={(e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width))} style={{ height: RETURN_LINE_H }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="return-line">
      {w > 0 && d ? (
        <Svg width={w} height={RETURN_LINE_H}>
          <Line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke={t.line} strokeWidth={1} />
          <Path d={d} stroke={color} strokeWidth={2} fill="none" />
        </Svg>
      ) : null}
    </View>
  );
}
