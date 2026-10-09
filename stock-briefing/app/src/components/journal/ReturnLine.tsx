import React, { useState } from "react";
import { Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { Line, Path, Svg } from "react-native-svg";
import { returnLineLabels } from "@/lib/journal";
import { clampScale } from "@/lib/textScale";
import { changeColor, font, space, useTheme } from "@/theme";

/**
 * 날짜별 누적 수익률 선 (3-37 수익률 탭). 0% 가로선과 누적 값 선 하나 — 끝 값이 이익이면 빨강, 손실이면 파랑.
 * 위에 제목 '날짜별 누적 수익률', 아래 양 끝 날짜, 0% 선 오른쪽 끝에 '0%' (무엇을 그린 선인지 보이게 — 글자 높이는 글자 배율만큼 잡아
 * 큰 글씨에서도 0% 선 위·그림 안에 둔다: 아래 날짜 줄과 겹치지 않게).
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

/** '0%' 글자 칸 높이 (글자 font.tiny × 줄 간격 1.4 × 글자 배율) */
export function zeroLabelH(fontScale: number): number {
  return Math.ceil(font.tiny * 1.4 * clampScale(fontScale));
}

/** '0%' 글자 위치: 0% 선 바로 위, 그림(RETURN_LINE_H) 안에서 넘치지 않게 */
export function zeroLabelTop(zeroY: number, fontScale: number): number {
  const hgt = zeroLabelH(fontScale);
  return Math.max(0, Math.min(RETURN_LINE_H - hgt, zeroY - hgt));
}

export function ReturnLine({ series }: { series: { date: string; cum: number }[] }) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const [w, setW] = useState(0);
  const values = series.map((s) => s.cum);
  const { d, zeroY } = linePath(values, w, RETURN_LINE_H);
  const color = changeColor(t, values.at(-1) ?? 0);
  const labels = returnLineLabels(series);
  // '0%' 글자: 0% 선 바로 위 (그림 안에서 넘치지 않게 — 높이는 글자 배율만큼)
  const zeroTop = zeroLabelTop(zeroY, fontScale);
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="return-line" style={{ gap: space.xxs }}>
      {labels ? <Text style={{ color: t.sub, fontSize: font.small, fontWeight: "700" }}>{labels.title}</Text> : null}
      <View onLayout={(e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width))} style={{ height: RETURN_LINE_H }}>
        {w > 0 && d ? (
          <Svg width={w} height={RETURN_LINE_H}>
            <Line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke={t.line} strokeWidth={1} />
            <Path d={d} stroke={color} strokeWidth={2} fill="none" />
          </Svg>
        ) : null}
        {w > 0 && d ? <Text style={{ position: "absolute", right: 0, top: zeroTop, color: t.muted, fontSize: font.tiny }}>0%</Text> : null}
      </View>
      {labels ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", columnGap: space.sm }}>
          <Text style={{ color: t.muted, fontSize: font.tiny }}>{labels.from}</Text>
          <Text style={{ color: t.muted, fontSize: font.tiny }}>{labels.to}</Text>
        </View>
      ) : null}
    </View>
  );
}

