import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { BriefingWithData } from "@/api/types";
import { formatDateKo } from "@/lib/format";
import { font, space, useTheme } from "@/theme";
import { Card, Muted, SectionTitle } from "./ui";

/**
 * 브리핑 근거: 브리핑을 만들 때 쓴 시세 기준 시각, 뉴스(언론사·시각·원문 링크), 공시.
 * 스냅샷(브리핑 당시 모은 데이터) 그대로라 지금 뉴스와 다를 수 있다
 */
export function BriefingSources({ data }: { data: BriefingWithData["data"] }) {
  const t = useTheme();
  if (!data) return null;
  const news = data.news ?? [];
  const disclosures = data.disclosures ?? [];
  const link = (url: string) => () => void Linking.openURL(url).catch(() => undefined);
  return (
    <Card>
      <SectionTitle>근거</SectionTitle>
      {data.quote ? <Muted>시세 기준: {formatDateKo(data.quote.asOf, true)} · {data.quote.priceBasis ?? data.quote.source}</Muted> : <Muted>시세: 받지 못함</Muted>}
      <Text style={[styles.head, { color: t.ink }]}>{data.news === null ? "뉴스" : `뉴스 ${news.length}건`}</Text>
      {data.news === null ? <Muted>받지 못함 (브리핑 때 뉴스 소스가 응답하지 않음)</Muted> : news.length === 0 ? <Muted>관련 뉴스 없음</Muted> : null}
      {news.map((n, i) => (
        <Pressable key={`${n.url}-${i}`} onPress={link(n.url)} accessibilityRole="link" accessibilityLabel={`${n.title}, ${n.source ?? ""}`} style={({ pressed }) => [styles.row, { borderTopColor: t.line, opacity: pressed ? 0.6 : 1 }]}>
          <Text style={{ color: t.accent, fontSize: font.small }} numberOfLines={2}>
            {n.title}
          </Text>
          <Muted>
            {n.source ?? "출처 미상"} · {formatDateKo(n.publishedAt, true)}
          </Muted>
        </Pressable>
      ))}
      {disclosures.length ? (
        <View>
          <Text style={[styles.head, { color: t.ink }]}>공시 {disclosures.length}건</Text>
          {disclosures.map((d, i) => (
            <Pressable key={`${d.receiptNo}-${i}`} onPress={link(d.url)} accessibilityRole="link" style={({ pressed }) => [styles.row, { borderTopColor: t.line, opacity: pressed ? 0.6 : 1 }]}>
              <Text style={{ color: t.accent, fontSize: font.small }} numberOfLines={2}>
                {d.title}
              </Text>
              <Muted>
                {d.filer} · {formatDateKo(d.filedAt)}
              </Muted>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Muted>브리핑을 만들 때 모은 자료입니다. 누르면 원문이 열립니다.</Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { fontSize: font.small, fontWeight: "700", marginTop: space.sm },
  row: { paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
});
