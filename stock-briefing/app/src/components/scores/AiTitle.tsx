import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Badge } from "@/components/ui";
import { usePlain } from "@/lib/plainFlag";
import { SCORE_LABELS } from "@/lib/scoreView";
import { font, space, useTheme } from "@/theme";

/**
 * 'AI 기업개요 [AI가 쓴 글]' 제목 줄 (3-44, 플래그 indicatorScores 켜짐만). 위의 계산식 결과(지표 점수)와 아래 AI 글을 나눈다.
 * 꺼져 있으면 화면이 이 줄을 두지 않는다 (지금 화면 그대로)
 */
export function AiTitle({ title }: { title: string }) {
  const t = useTheme();
  // 군더더기 글 줄이기(plainView): 'AI ' 와 배지를 뺀 제목만 ('기업개요')
  const plain = usePlain();
  if (plain) {
    const short = title.replace(/^AI\s+/, "");
    return (
      <View style={styles.row} accessible accessibilityRole="header" accessibilityLabel={short}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>{short}</Text>
      </View>
    );
  }
  return (
    <View style={styles.row} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${SCORE_LABELS.aiBadge}`}>
      <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>{title}</Text>
      <Badge>{SCORE_LABELS.aiBadge}</Badge>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.xs },
});
