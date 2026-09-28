import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useIndicatorScores } from "@/api/hooks";
import type { ValueFamilyRow, ValueMetricRow } from "@/api/types";
import { Badge, Button, Card, Muted } from "@/components/ui";
import { DISCLAIMER } from "@/lib/disclaimer";
import { familySpeech, metricSpeech, nameWidth, SCORE_LABELS, stackRows, valueHasScore, valueSpeech } from "@/lib/scoreView";
import { font, slopFor, space, touch, useFontScale, useTheme } from "@/theme";
import { scores } from "@/tokens";
import { ScoreBar } from "./ScoreBar";

/**
 * 종목 상세 가치분석 탭 맨 위 가치 지표 상세 카드 (3-44 2단계, 플래그 indicatorScores + valueScore — 둘 다 켜져 있을 때만 화면이 이 카드를 둔다).
 * 머리 '가치 지표 점수 57/100 · 가운데쯤' → 배지 → 비교 대상 문장 → 날짜 줄(20거래일 평균 주가 · 재무 기준 · 비교 기준) → 시세 표와 다를 수 있다는 안내
 * → 지난주 대비 바뀐 이유(5점 넘게 바뀐 때만) → 5묶음(막대·점수·가장 크게 작용한 지표 문장) → '지표별 값 보기'(지표마다 값·가운데값·위치·섞은 비중·문장)
 * → 표시 → 고지 → 계산 방식 줄. 점수가 없으면 상태 글과 이유만 (한국 '계산 준비 중', ETF '대상 아님', '점수 없음 — 이유').
 * 모든 문장은 서버가 만든다. 막대는 회색 한 가지 (좋음·나쁨 색 없음)
 */
export function ValueScoreCard({ code }: { code: string }) {
  const t = useTheme();
  const q = useIndicatorScores(code, true);
  const [open, setOpen] = useState(false);
  if (q.data === null) return null;
  if (!q.data) {
    return (
      <Card style={styles.card}>
        <Text style={[styles.head, { color: t.ink }]} accessibilityRole="header">
          {SCORE_LABELS.valueDetail}
        </Text>
        {q.isError ? (
          <View style={styles.errorRow}>
            <Muted>지표 점수를 불러오지 못했습니다</Muted>
            <Button title="다시 시도" variant="secondary" compact onPress={() => void q.refetch()} accessibilityLabel="가치 지표 점수 다시 불러오기" />
          </View>
        ) : (
          <Muted>지표 점수를 불러오는 중</Muted>
        )}
      </Card>
    );
  }
  const s = q.data;
  const v = s.value;
  const ok = valueHasScore(v);
  return (
    <Card style={styles.card}>
      <View style={styles.headRow}>
        {/* 화면 읽기는 '57/100'(슬래시·분수) 대신 '가치 지표 57점, 0에서 100 중, 가운데쯤' */}
        <Text style={[styles.head, { color: t.ink }]} accessibilityRole="header" accessibilityLabel={ok ? valueSpeech(v) : undefined}>
          {ok && v.headline ? v.headline : SCORE_LABELS.valueDetail}
        </Text>
        <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1, textAlign: "right" }}>{s.text.titleNote}</Text>
      </View>
      {ok ? (
        <>
          {v.badges?.length ? (
            <View style={styles.badges}>
              {v.badges.map((b) => (
                <Badge key={b}>{b}</Badge>
              ))}
            </View>
          ) : null}
          {v.peerLine ? <Text style={{ color: t.ink, fontSize: font.small, lineHeight: font.small * 1.5 }}>{v.peerLine}</Text> : null}
          {v.datesLine ? <Muted>{v.datesLine}</Muted> : null}
          {v.priceNote ? <Muted>{v.priceNote}</Muted> : null}
          {v.change ? (
            <View style={[styles.change, { borderLeftColor: t.lineStrong }]} accessible accessibilityLabel={`${SCORE_LABELS.change}: ${v.change.text}`}>
              <Text style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.45 }}>{v.change.text}</Text>
            </View>
          ) : null}
          <View style={styles.families}>
            {(v.families ?? []).map((f) => (
              <FamilyBlock key={f.key} f={f} open={open} />
            ))}
          </View>
          <Pressable
            onPress={() => setOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel={open ? SCORE_LABELS.metricsClose : SCORE_LABELS.metricsOpen}
            accessibilityState={{ expanded: open }}
            hitSlop={slopFor(font.body * 1.4, space.xs)}
            style={styles.toggle}
          >
            <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "700" }}>{open ? SCORE_LABELS.metricsClose : SCORE_LABELS.metricsOpen}</Text>
            <Ionicons name={open ? "chevron-up" : "chevron-down"} size={font.body} color={t.accent} />
          </Pressable>
          {v.flags?.length ? (
            <View style={styles.gapXs}>
              {v.flags.map((f) => (
                <Text key={f.key} style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>
                  {SCORE_LABELS.flags} · {f.text}
                </Text>
              ))}
            </View>
          ) : null}
          {(v.notes ?? []).map((n, i) => (
            <Muted key={i}>{n}</Muted>
          ))}
        </>
      ) : (
        <View style={styles.gapXs}>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>{v.label}</Text>
          <Text style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>{v.reason?.text ?? v.text}</Text>
        </View>
      )}
      <View style={[styles.foot, { borderTopColor: t.line }]}>
        <Muted>{s.text.valueDetailNote ?? s.text.notForecast}</Muted>
        <Muted>{DISCLAIMER}</Muted>
        {v.versionLine ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{v.versionLine}</Text> : null}
      </View>
    </Card>
  );
}

/** 묶음 하나: 이름 · 비중 | 막대 | 점수 / 설명 / 가장 크게 작용한 지표 문장 / (펼치면) 지표 줄들 */
function FamilyBlock({ f, open }: { f: ValueFamilyRow; open: boolean }) {
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
      {open ? (
        <View style={[styles.metrics, { borderLeftColor: t.line }]}>
          {f.metrics.map((m) => (
            <MetricLine key={m.key} m={m} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** 지표 한 줄: 이름 — 값 · 가운데값 / 위치 · 섞은 비중 / 문장 / 100에 가까울수록 … (쓰지 않는 지표는 흐리게 까닭만) */
function MetricLine({ m }: { m: ValueMetricRow }) {
  const t = useTheme();
  const main = [m.value, m.peerMedian].filter(Boolean).join(" · ");
  return (
    <View style={styles.metric} accessible accessibilityLabel={metricSpeech(m)}>
      <Text style={{ color: m.used ? t.ink : t.muted, fontSize: font.small, fontWeight: "700", lineHeight: font.small * 1.45 }}>
        {m.name}
        {main ? <Text style={{ fontWeight: "400", fontVariant: ["tabular-nums"] }}>{`  ${main}`}</Text> : null}
      </Text>
      {m.positions ? <Text style={{ color: t.sub, fontSize: font.tiny, lineHeight: font.tiny * 1.5, fontVariant: ["tabular-nums"] }}>{m.mix ? `${m.positions} (비중 ${m.mix})` : m.positions}</Text> : null}
      <Text style={{ color: m.used ? t.sub : t.muted, fontSize: font.small, lineHeight: font.small * 1.45 }}>{m.used ? `→ ${m.text}` : m.text}</Text>
      {m.note ? <Text style={{ color: t.muted, fontSize: font.tiny, lineHeight: font.tiny * 1.5 }}>{m.note}</Text> : null}
      {m.used ? <Text style={{ color: t.muted, fontSize: font.tiny, lineHeight: font.tiny * 1.5 }}>{m.meaning}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  headRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
  head: { fontSize: font.h2, fontWeight: "700", flexShrink: 1 },
  gapXs: { gap: space.xs },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  change: { borderLeftWidth: scores.noticeBar, paddingLeft: space.sm, paddingVertical: space.xxs },
  families: { gap: space.md, marginTop: space.xs },
  family: { gap: space.xxs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  famName: { fontSize: font.body, fontWeight: "700" },
  num: { minWidth: scores.numW, textAlign: "right", fontSize: font.h2, fontWeight: "800", fontVariant: ["tabular-nums"] },
  metrics: { gap: space.sm, borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: space.sm, marginTop: space.xs },
  metric: { gap: space.xxs },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  foot: { gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, marginTop: space.xs },
  errorRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
});
