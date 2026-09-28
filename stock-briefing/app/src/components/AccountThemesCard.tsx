import { router } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { HoldingThemesSnapshot } from "@/api/types";
import { Button, Card, Muted, SectionTitle } from "@/components/ui";
import { accountThemesView } from "@/lib/holdingThemes";
import { changeColor, font, space, useTheme } from "@/theme";

/**
 * 계좌 브리핑 상세 '내 종목 테마' 카드 (3-35 설계 2.3, 플래그 holdingThemes): 브리핑을 만든 그 시각에 저장한 값 그대로 —
 * 많이 속한 테마 한 줄 · 시장별 등락률 높은/낮은 3개(묶음 6개 미만이면 높은 순 한 줄) · 기준 줄 · [지금 기준으로 전체 보기](지금 값 화면).
 * 색은 등락률 글자에만. 좁은 칸·큰 글씨는 ' · ' 묶음째 줄바꿈. 화면 읽기는 줄마다 한 문장
 */
export function AccountThemesCard({ s, asOfClock }: { s: HoldingThemesSnapshot; asOfClock: string }) {
  const t = useTheme();
  const v = accountThemesView(s, asOfClock);
  if (!v.lines.length) return null;
  return (
    <Card>
      <SectionTitle>{v.title}</SectionTitle>
      {v.lines.map((l) => (
        <View key={l.key} accessible accessibilityLabel={l.speech} style={styles.line}>
          <Text style={[styles.text, { color: t.sub, fontWeight: "600" }]}>{l.head} ·</Text>
          {l.parts.map((p, i) => (
            <Text key={`${p.name}:${i}`} style={[styles.text, { color: t.ink }]}>
              {p.name}
              {p.rateText ? <Text style={{ color: changeColor(t, p.rate), fontVariant: ["tabular-nums"] }}> {p.rateText}</Text> : null}
              {i < l.parts.length - 1 || l.tail ? " ·" : ""}
            </Text>
          ))}
          {l.tail ? <Text style={[styles.text, { color: t.muted }]}>{l.tail}</Text> : null}
        </View>
      ))}
      <Muted style={{ fontSize: font.tiny }}>{v.basis}</Muted>
      <View style={styles.actions}>
        <Button title={v.button} icon="pricetags-outline" variant="secondary" compact accessibilityLabel={`${v.button}, 내 종목 테마 화면`} onPress={() => router.push("/portfolio/themes")} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs, rowGap: space.xxs, alignItems: "baseline" },
  text: { fontSize: font.body, lineHeight: font.body * 1.5 },
  actions: { flexDirection: "row", justifyContent: "flex-start", marginTop: space.xs },
});
