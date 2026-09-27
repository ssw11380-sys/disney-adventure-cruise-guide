import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useIndicatorScores } from "@/api/hooks";
import type { ScoreFamily } from "@/api/types";
import { Badge, Button, Card, Muted } from "@/components/ui";
import { DISCLAIMER } from "@/lib/disclaimer";
import { familySpeech, itemLine, nameWidth, SCORE_LABELS, stackRows, trendHasScore } from "@/lib/scoreView";
import { font, space, touch, useFontScale, useTheme } from "@/theme";
import { scores } from "@/tokens";
import { LeverageNotice } from "./LeverageNotice";
import { ScoreBar } from "./ScoreBar";

/**
 * 종목 상세 기술분석 탭 맨 위 추세 지표 상세 카드 (3-44 1단계, 플래그 indicatorScores).
 * 머리 '추세 지표 점수 69/100 · 다소 강함' → 기준 문장 → 띠 한 줄 → 지난주 대비 바뀐 이유(5점 넘게 바뀐 때만) → 5묶음(막대·점수·사실 문장·항목 점수)
 * → 빠진 항목 안내 → 고지('과거·현재 숫자로 계산한 지표…' + 공통 고지) → 계산 방식 줄.
 * 레버리지 상품은 묶음 없이 '이 상품 자체 점수 없음' + 기초자산 참고 줄 + 사실 상자. 문장은 모두 서버가 만든다
 */
export function TrendScoreCard({ code, onOpenStock }: { code: string; onOpenStock?: (code: string) => void }) {
  const t = useTheme();
  const q = useIndicatorScores(code, true);
  if (q.data === null) return null;
  if (!q.data) {
    return (
      <Card style={styles.card}>
        <Text style={[styles.head, { color: t.ink }]} accessibilityRole="header">
          추세 지표 점수
        </Text>
        {q.isError ? (
          <View style={styles.errorRow}>
            <Muted>지표 점수를 불러오지 못했습니다</Muted>
            <Button title="다시 시도" variant="secondary" compact onPress={() => void q.refetch()} accessibilityLabel="추세 지표 점수 다시 불러오기" />
          </View>
        ) : (
          <Muted>지표 점수를 불러오는 중</Muted>
        )}
      </Card>
    );
  }
  const s = q.data;
  const tr = s.trend;
  const ok = trendHasScore(tr);
  return (
    <Card style={styles.card}>
      <View style={styles.headRow}>
        <Text style={[styles.head, { color: t.ink }]} accessibilityRole="header">
          {ok ? tr.headline : "추세 지표 점수"}
        </Text>
        <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1, textAlign: "right" }}>{s.text.titleNote}</Text>
      </View>
      {ok ? (
        <>
          <Muted>{tr.basisLine}</Muted>
          <Text style={{ color: t.ink, fontSize: font.body }}>{tr.bandLine}</Text>
          {tr.change ? (
            <View style={[styles.change, { borderLeftColor: t.lineStrong }]} accessible accessibilityLabel={`${SCORE_LABELS.change}: ${tr.change.text}`}>
              <Text style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.45 }}>{tr.change.text}</Text>
            </View>
          ) : null}
          <View style={styles.families}>
            {tr.families.map((f) => (
              <FamilyBlock key={f.key} f={f} />
            ))}
          </View>
          {tr.notes.map((n, i) => (
            <Muted key={i}>{n}</Muted>
          ))}
        </>
      ) : (
        <View style={styles.gapXs}>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>{tr.label}</Text>
          {tr.reason ? <Text style={{ color: t.sub, fontSize: font.small }}>{tr.reason.text}</Text> : null}
          {tr.reference ? (
            <View style={styles.refRow}>
              <Text style={{ color: t.sub, fontSize: font.small, flexShrink: 1 }}>{tr.reference.text}</Text>
              <Badge>{SCORE_LABELS.underlyingBadge}</Badge>
            </View>
          ) : null}
          {tr.reference?.note ? <Muted>{tr.reference.note}</Muted> : null}
        </View>
      )}
      {tr.leveraged ? <LeverageNotice box={tr.leveraged.box} /> : null}
      {tr.reference && onOpenStock ? (
        <Pressable onPress={() => onOpenStock(tr.reference!.code)} accessibilityRole="link" accessibilityLabel={`기초자산 ${tr.reference.code} 화면 보기`} style={styles.link}>
          <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "700" }}>기초자산 {tr.reference.code} 화면 보기</Text>
          <Ionicons name="chevron-forward" size={font.body} color={t.accent} />
        </Pressable>
      ) : null}
      {s.asOf.line && !ok ? <Muted>{s.asOf.line}</Muted> : null}
      <View style={[styles.foot, { borderTopColor: t.line }]}>
        <Muted>{s.text.detailNote}</Muted>
        <Muted>{DISCLAIMER}</Muted>
        <Text style={{ color: t.muted, fontSize: font.tiny }}>{tr.versionLine}</Text>
      </View>
    </Card>
  );
}

/** 묶음 하나: 이름 · 비중 | 막대 | 점수 / 설명 / 사실 문장 / 항목 점수 */
function FamilyBlock({ f }: { f: ScoreFamily }) {
  const t = useTheme();
  const fs = useFontScale();
  const stack = stackRows(fs);
  const name = (
    <Text style={[styles.famName, { color: t.ink }, stack ? { flexGrow: 1 } : { width: nameWidth(scores.familyNameW, fs) }]} numberOfLines={2}>
      {f.name} <Text style={{ color: t.muted, fontWeight: "400" }}>· {f.weight}</Text>
    </Text>
  );
  const num = <Text style={[styles.num, { color: t.ink }]}>{f.score ?? "-"}</Text>;
  return (
    <View style={styles.family}>
      <View accessible accessibilityLabel={familySpeech(f)}>
        {stack ? (
          <View style={styles.gapXs}>
            <View style={styles.row}>
              {name}
              {num}
            </View>
            <ScoreBar score={f.score} />
          </View>
        ) : (
          <View style={styles.row}>
            {name}
            <ScoreBar score={f.score} />
            {num}
          </View>
        )}
      </View>
      <Muted>{f.about}</Muted>
      <Text style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>{f.text}</Text>
      <Text style={{ color: t.muted, fontSize: font.tiny, lineHeight: font.tiny * 1.5 }}>{itemLine(f)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  headRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
  head: { fontSize: font.h2, fontWeight: "700", flexShrink: 1 },
  gapXs: { gap: space.xs },
  change: { borderLeftWidth: scores.noticeBar, paddingLeft: space.sm, paddingVertical: space.xxs },
  families: { gap: space.md, marginTop: space.xs },
  family: { gap: space.xxs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  famName: { fontSize: font.body, fontWeight: "700" },
  num: { minWidth: scores.numW, textAlign: "right", fontSize: font.h2, fontWeight: "800", fontVariant: ["tabular-nums"] },
  refRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s },
  link: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  foot: { gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, marginTop: space.xs },
  errorRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
});
