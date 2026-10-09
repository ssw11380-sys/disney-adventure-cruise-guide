import React from "react";
import { Text } from "react-native";
import { font, space, useTheme } from "@/theme";
import { Button, Card, Muted } from "./ui";

/** 본문과 따로 받는 목록의 실패. 기존 내용을 지우거나 보고서를 새로 만들지 않는다. */
export function ReportListNotice({ label, query }: {
  label: string;
  query: { data: unknown; isError: boolean; isFetching?: boolean; refetch: () => Promise<unknown> };
}) {
  const t = useTheme();
  if (!query.isError) return null;
  return <Card style={{ gap: space.sm }}>
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: t.warn, fontSize: font.body, fontWeight: "600" }}>{label} 목록을 불러오지 못했습니다</Text>
    <Muted>{query.data !== undefined ? "이전에 받은 목록 기준입니다. 최신 목록은 확인하지 못했습니다." : "목록이 없는 상태인지 확인하지 못했습니다. 다시 불러와 주세요."}</Muted>
    <Button title="목록 다시 불러오기" accessibilityLabel={`${label} 목록 다시 불러오기`} variant="secondary" compact loading={query.isFetching} onPress={() => void query.refetch()} />
  </Card>;
}
