import React from "react";
import { Text } from "react-native";
import { usePlain } from "@/lib/plainFlag";
import { font, useTheme } from "@/theme";

/**
 * 가치·추세 지표 카드 제목 옆 한 줄 (서버 글 '계산식 결과 · AI 글 아님').
 * 군더더기 글 줄이기(플래그 plainView)면 그리지 않는다. 꺼져 있으면 지금과 같은 글자
 */
export function TitleNote({ text }: { text: string | null | undefined }) {
  const t = useTheme();
  const plain = usePlain();
  if (plain) return null;
  return <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1, textAlign: "right" }}>{text}</Text>;
}
