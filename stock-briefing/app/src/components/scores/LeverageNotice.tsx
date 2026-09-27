import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TrendScoreBlock } from "@/api/types";
import { changeColor, font, radius, space, useTheme } from "@/theme";

/**
 * 레버리지 상품 주의 · 계산한 사실 (3-44, 설계 5.7-D). 점수가 아니라 사실만: 최근 63거래일 상품·기초자산·단순 L배 수익,
 * 상품 변동성·1년 최대 낙폭, 계산상 변동성 손실. 문장은 서버가 만들고, 수익률 숫자만 앱의 등락 색(상승 빨강·하락 파랑)으로 칠한다
 */
export function LeverageNotice({ box }: { box: NonNullable<TrendScoreBlock["leveraged"]>["box"] }) {
  const t = useTheme();
  const speech = [box.title, ...box.lines.map((l) => l.parts.map((p) => p.text).join(""))].join(". ");
  return (
    <View style={[styles.box, { borderColor: t.lineStrong, backgroundColor: t.bg }]} accessible accessibilityLabel={speech}>
      <Text style={{ color: t.warn, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
        {box.title}
      </Text>
      {box.lines.map((line, i) => (
        <Text key={i} style={{ color: t.ink, fontSize: font.small, lineHeight: font.small * 1.5 }}>
          {line.parts.map((p, j) =>
            p.sign !== undefined ? (
              <Text key={j} style={{ color: changeColor(t, p.sign), fontVariant: ["tabular-nums"] }}>
                {p.text}
              </Text>
            ) : (
              p.text
            ),
          )}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, gap: space.xs },
});
