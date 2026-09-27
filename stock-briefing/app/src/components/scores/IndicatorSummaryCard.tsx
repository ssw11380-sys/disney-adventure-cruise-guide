import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useIndicatorScores } from "@/api/hooks";
import type { IndicatorScores, ScoreFamily, TrendScoreBlock } from "@/api/types";
import { Badge, Button, Card, Muted } from "@/components/ui";
import { familySpeech, SCORE_LABELS, showComposite, stackRows, summarySpeech, trendHasScore, trendSpeech } from "@/lib/scoreView";
import { font, slopFor, space, touch, useFontScale, useTheme } from "@/theme";
import { scores } from "@/tokens";
import { LeverageNotice } from "./LeverageNotice";
import { ScoreBar } from "./ScoreBar";

/**
 * 종목 상세 기업개요 탭 맨 위 '지표 점수' 요약 카드 (3-44 1단계, 플래그 indicatorScores — 켜져 있을 때만 화면이 이 카드를 둔다).
 * 두 점수(가치 · 추세) → 종합(두 점수가 모두 있을 때만, 작게) → 레버리지 주의 상자 → 날짜 한 줄 → 예측 아님 줄 → '구성·계산 방법 보기' → 짧은 고지.
 * 이번 단계: 가치 지표는 '계산 준비 중'(ETF 는 '대상 아님'), 종합은 숨김. 레버리지 ETF 는 이 상품 자체 점수 없이 기초자산 참고 줄과 사실 상자.
 * 카드는 늘 접힌 채 시작하고 펼침은 화면 상태로만 기억한다. 막대는 회색 한 가지. 404(꺼짐·예전 서버)면 아무것도 그리지 않는다
 */
export function IndicatorSummaryCard({
  code,
  twoCol = false,
  onTechnical,
  techTabLabel = SCORE_LABELS.toTechnical,
  onOpenStock,
  flat = false,
}: {
  code: string;
  /** 패널 테두리·여백 없이 (울트라 펼침 세로 오른쪽 칸처럼 이미 여백이 있는 칸 안) */
  flat?: boolean;
  /** 펼친 폴드8 세로(한 단 넓은 창): 가치 · 추세를 두 칸으로 나란히 */
  twoCol?: boolean;
  /** '기술분석 탭에서 항목별 사실 보기' (없으면 줄을 두지 않음) */
  onTechnical?: () => void;
  techTabLabel?: string;
  /** 기초자산 화면 열기 (레버리지 상품) */
  onOpenStock?: (code: string) => void;
}) {
  const t = useTheme();
  const q = useIndicatorScores(code, true);
  const [open, setOpen] = useState(false);
  if (q.data === null) return null; // 꺼짐·예전 서버·모르는 종목
  if (!q.data) {
    return (
      <Frame flat={flat}>
        <Head note={null} />
        {q.isError ? (
          <View style={styles.errorRow}>
            <Muted>지표 점수를 불러오지 못했습니다</Muted>
            <Button title="다시 시도" variant="secondary" compact onPress={() => void q.refetch()} accessibilityLabel="지표 점수 다시 불러오기" />
          </View>
        ) : (
          <Muted>지표 점수를 불러오는 중</Muted>
        )}
      </Frame>
    );
  }
  const s = q.data;
  const trend = s.trend;
  const ref = trend.reference;
  return (
    <Frame flat={flat}>
      <View accessible accessibilityLabel={summarySpeech(s)} style={styles.gapSm}>
        <Head note={s.text.titleNote} />
        <View style={twoCol ? styles.twoCol : styles.gapMd}>
          <View style={twoCol ? styles.col : null}>
            <StatusRow name={SCORE_LABELS.value} label={s.value.label} text={s.value.text} />
          </View>
          <View style={twoCol ? styles.col : null}>
            <TrendRow trend={trend} />
          </View>
        </View>
        {showComposite(s) ? (
          <View style={[styles.composite, { borderTopColor: t.line }]}>
            <Text style={[styles.name, { color: t.sub }]}>{SCORE_LABELS.composite}</Text>
            <Text style={[styles.num, { color: t.ink }]}>{s.composite.score}</Text>
            <Muted>{SCORE_LABELS.compositeNote}</Muted>
          </View>
        ) : null}
      </View>
      {trend.leveraged ? <LeverageNotice box={trend.leveraged.box} /> : null}
      {s.asOf.line ? <Muted>{s.asOf.line}</Muted> : null}
      <Text style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.45 }}>{s.text.notForecast}</Text>
      {ref && onOpenStock ? <LinkRow label={`기초자산 ${ref.code} 화면 보기`} onPress={() => onOpenStock(ref.code)} /> : null}
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={open ? SCORE_LABELS.collapse : SCORE_LABELS.expand}
        accessibilityState={{ expanded: open }}
        hitSlop={slopFor(font.body * 1.4, space.xs)}
        style={styles.toggle}
      >
        <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "700" }}>{open ? SCORE_LABELS.collapse : SCORE_LABELS.expand}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={font.body} color={t.accent} />
      </Pressable>
      {open ? <HowSection s={s} onTechnical={onTechnical} techTabLabel={techTabLabel} /> : null}
      <Muted>{s.text.disclaimerShort}</Muted>
    </Frame>
  );
}

/** 카드 틀: 보통은 패널(Card), flat 이면 여백·테두리 없는 칸 */
function Frame({ flat, children }: { flat: boolean; children: React.ReactNode }) {
  return flat ? <View style={styles.card}>{children}</View> : <Card style={styles.card}>{children}</Card>;
}

function Head({ note }: { note: string | null }) {
  const t = useTheme();
  return (
    <View style={styles.head}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 0 }} accessibilityRole="header">
        {SCORE_LABELS.title}
      </Text>
      {note ? (
        <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1, textAlign: "right" }} numberOfLines={2}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** 점수 없는 줄: 이름 · 상태 글(굵게) / 이유 한 줄 */
function StatusRow({ name, label, text, children }: { name: string; label: string; text: string | null; children?: React.ReactNode }) {
  const t = useTheme();
  const stack = stackRows(useFontScale());
  return (
    <View style={styles.gapXs}>
      <View style={[styles.row, stack ? styles.rowWrap : null]}>
        <Text style={[styles.name, { color: t.ink }]}>{name}</Text>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flexShrink: 1 }}>{label}</Text>
      </View>
      <View style={stack ? null : styles.indent}>
        {children}
        {text ? <Muted>{text}</Muted> : null}
      </View>
    </View>
  );
}

/** 추세 줄: 점수가 있으면 이름 · 막대 · 숫자 · 띠 / 뜻 한 줄, 없으면 상태 글과 이유 (레버리지는 참고 줄) */
function TrendRow({ trend }: { trend: TrendScoreBlock }) {
  const t = useTheme();
  const stack = stackRows(useFontScale());
  if (!trendHasScore(trend)) {
    const ref = trend.reference;
    return (
      <StatusRow name={SCORE_LABELS.trend} label={trend.label} text={ref ? [trend.reason?.text, ref.note].filter(Boolean).join(" ") : (trend.reason?.text ?? null)}>
        {ref ? (
          <View style={styles.refRow}>
            <Text style={{ color: t.sub, fontSize: font.small, flexShrink: 1 }}>{ref.text}</Text>
            <Badge>{SCORE_LABELS.underlyingBadge}</Badge>
          </View>
        ) : null}
      </StatusRow>
    );
  }
  const num = (
    <Text style={[styles.num, { color: t.ink }]} accessibilityLabel={trendSpeech(trend)}>
      {trend.score}
    </Text>
  );
  const band = (
    <Text style={[styles.band, { color: t.sub }]} numberOfLines={stack ? 2 : 1}>
      {trend.band}
    </Text>
  );
  return (
    <View style={styles.gapXs}>
      {stack ? (
        <>
          <View style={styles.row}>
            <Text style={[styles.name, { color: t.ink, flexGrow: 1 }]}>{SCORE_LABELS.trend}</Text>
            {num}
            {band}
          </View>
          <ScoreBar score={trend.score} />
        </>
      ) : (
        <View style={styles.row}>
          <Text style={[styles.name, { color: t.ink }]}>{SCORE_LABELS.trend}</Text>
          <ScoreBar score={trend.score} />
          {num}
          {band}
        </View>
      )}
      {trend.meaning ? <Muted style={stack ? null : styles.indent}>{trend.meaning}</Muted> : null}
    </View>
  );
}

/** 구성·계산 방법 (펼침) */
function HowSection({ s, onTechnical, techTabLabel }: { s: IndicatorScores; onTechnical?: () => void; techTabLabel: string }) {
  const t = useTheme();
  const ok = trendHasScore(s.trend);
  return (
    <View style={[styles.how, { borderTopColor: t.line }]}>
      {ok ? (
        <View style={styles.gapXs}>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
            {SCORE_LABELS.trendParts}
          </Text>
          <Muted>{s.text.trendAbout}</Muted>
          {s.trend.families.map((f) => (
            <FamilyMini key={f.key} f={f} />
          ))}
          {onTechnical ? <LinkRow label={techTabLabel} onPress={onTechnical} /> : null}
        </View>
      ) : null}
      <View style={styles.gapXs}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
          {SCORE_LABELS.how}
        </Text>
        {s.text.how.map((line, i) => (
          <Text key={i} style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>
            · {line}
          </Text>
        ))}
        <Text style={{ color: t.muted, fontSize: font.tiny }}>{s.trend.versionLine}</Text>
      </View>
    </View>
  );
}

function FamilyMini({ f }: { f: ScoreFamily }) {
  const t = useTheme();
  return (
    <View style={[styles.row, styles.mini]} accessible accessibilityLabel={familySpeech(f)}>
      <Text style={{ color: t.sub, fontSize: font.small, width: scores.familyNameW }} numberOfLines={2}>
        {f.name} · {f.weight}
      </Text>
      <ScoreBar score={f.score} />
      <Text style={[styles.num, { color: t.ink, fontSize: font.body }]}>{f.score ?? "-"}</Text>
    </View>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label} style={styles.link}>
      <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "700", flexShrink: 1 }}>{label}</Text>
      <Ionicons name="chevron-forward" size={font.body} color={t.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
  gapXs: { gap: space.xs },
  gapSm: { gap: space.sm },
  gapMd: { gap: space.md },
  twoCol: { flexDirection: "row", gap: space.xl },
  col: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowWrap: { flexWrap: "wrap" },
  name: { width: scores.nameW, fontSize: font.body, fontWeight: "700" },
  num: { minWidth: scores.numW, textAlign: "right", fontSize: font.title, fontWeight: "800", fontVariant: ["tabular-nums"] },
  band: { minWidth: scores.bandW, fontSize: font.body },
  indent: { marginLeft: scores.nameW + space.sm },
  refRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s },
  composite: { flexDirection: "row", alignItems: "baseline", gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  how: { gap: space.md, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
  mini: { minHeight: touch.min - space.md },
  link: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  errorRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
});
