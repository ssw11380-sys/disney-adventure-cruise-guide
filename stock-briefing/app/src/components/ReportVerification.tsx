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
  return (
    <View style={{ gap: space.xs, paddingVertical: space.sm }}>
      <Muted>{validTime ? `시세 자료 기준 ${formatDateKo(asOf, true)}${verification?.quoteSource ? ` · ${verification.quoteSource}` : ""}` : "시세 자료 기준 시각: 제공되지 않음"}</Muted>
      {verification?.issues.length ? (
        <View accessibilityRole="alert" style={{ gap: space.xs }}>
          <Text style={{ color: t.warn, fontSize: font.small }}>본문 수치 확인이 필요합니다. 아래 원자료와 다른 표기가 있습니다.</Text>
          {verification.issues.map((issue, i) => (
            <Text key={`${issue.field}:${i}`} style={{ color: t.warn, fontSize: font.small }}>{`${issue.reported} · 원자료 ${issue.expected}`}</Text>
          ))}
          <Muted>현재가·등락률의 명시적 표기만 대조했습니다. 본문 전체의 사실성을 보증하지 않습니다.</Muted>
        </View>
      ) : null}
    </View>
  );
}
