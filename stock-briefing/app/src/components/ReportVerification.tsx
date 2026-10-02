import React from "react";
import { Text, View } from "react-native";
import type { ReportVerification } from "@/api/types";
import { Muted } from "@/components/ui";
import { formatDateKo } from "@/lib/format";
import { font, space, useTheme } from "@/theme";

/** 생성 시각과 원자료 시각을 구분하고, 확인된 불일치만 알린다. 원문은 계속 읽을 수 있다. */
export function ReportVerificationNotice({ verification }: { verification?: ReportVerification }) {
  const t = useTheme();
  const asOf = verification?.quoteAsOf;
  const validTime = typeof asOf === "string" && Number.isFinite(Date.parse(asOf));
  const source = typeof verification?.quoteSource === "string" ? verification.quoteSource : null;
  // 예전 서버의 필드 누락이나 손상된 부가 정보가 보고서 본문 표시를 막지 않게 한다.
  const issues = Array.isArray(verification?.issues) ? verification.issues.filter((issue) => issue !== null && typeof issue === "object"
    && (issue.field === "price" || issue.field === "changeRate") && typeof issue.reported === "string" && typeof issue.expected === "string") : [];
  return (
    <View style={{ gap: space.xs, paddingVertical: space.sm }}>
      <Muted>{validTime ? `보고서에 사용한 시세 시각 ${formatDateKo(asOf, true)}${source ? ` · ${source}` : ""}` : "보고서에 사용한 시세 시각: 제공되지 않음"}</Muted>
      {validTime ? <Muted>일부 출처는 체결 시각 대신 조회 시각을 제공합니다.</Muted> : null}
      {issues.length ? (
        <View accessibilityRole="alert" style={{ gap: space.xs }}>
          <Text style={{ color: t.warn, fontSize: font.small }}>본문 수치 확인이 필요합니다. 아래 원자료와 다른 표기가 있습니다.</Text>
          {issues.map((issue, i) => (
            <Text key={`${issue.field}:${i}`} style={{ color: t.warn, fontSize: font.small }}>{`${issue.reported} · 원자료 ${issue.expected}`}</Text>
          ))}
          <Muted>현재가·등락률의 명시적 표기만 대조했습니다. 본문 전체의 사실성을 보증하지 않습니다.</Muted>
        </View>
      ) : null}
    </View>
  );
}
