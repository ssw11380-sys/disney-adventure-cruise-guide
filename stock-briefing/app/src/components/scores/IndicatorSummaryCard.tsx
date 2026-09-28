import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useIndicatorScores } from "@/api/hooks";
import type { IndicatorScores, TrendScoreBlock, ValueScoreBlock } from "@/api/types";
import { Badge, Button, Card, Muted } from "@/components/ui";
import { compositeLine, familySpeech, flagPreview, moreFlagsText, nameWidth, SCORE_LABELS, stackRows, summarySpeech, trendHasScore, trendSpeech, valueHasScore, valueSpeech } from "@/lib/scoreView";
import { font, slopFor, space, touch, useFontScale, useTheme } from "@/theme";
import { scores } from "@/tokens";
import { LeverageNotice } from "./LeverageNotice";
import { ScoreBar } from "./ScoreBar";

/**
 * 종목 상세 기업개요 탭 맨 위 '지표 점수' 요약 카드 (3-44, 플래그 indicatorScores — 켜져 있을 때만 화면이 이 카드를 둔다).
 * 두 점수(가치 · 추세) → 종합(작게 — 두 점수가 모두 있으면 평균, 차이 30 이상이면 안내, 없으면 '없음 · 이유') → 레버리지 주의 상자 → 날짜 한 줄
 * → 예측 아님 줄 → '구성·계산 방법 보기' → 짧은 고지.
 * 2단계: 미국 보통주는 가치 줄도 회색 막대·0~100·띠(낮은 편 · 가운데쯤 · 높은 편)·배지(일부 지표 없이 계산 · 지난 값), 한국은 '계산 준비 중', ETF 는 '대상 아님'.
 * 레버리지 ETF 는 이 상품 자체 점수 없이 기초자산 참고 줄과 사실 상자. 변화 화살표·숫자는 요약 카드에 두지 않는다(지난주 대비는 상세 카드만).
 * 카드는 늘 접힌 채 시작하고 펼침은 화면 상태로만 기억한다. 막대는 회색 한 가지. 404(꺼짐·예전 서버)면 아무것도 그리지 않는다
 */
export function IndicatorSummaryCard({
  code,
  twoCol = false,
  onTechnical,
  techTabLabel = SCORE_LABELS.toTechnical,
  onValue,
  valueTabLabel = SCORE_LABELS.toValue,
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
  /** '가치분석 탭에서 지표별 값 보기' (없으면 줄을 두지 않음) */
  onValue?: () => void;
  valueTabLabel?: string;
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
  const comp = compositeLine(s);
  return (
    <Frame flat={flat}>
      <View accessible accessibilityLabel={summarySpeech(s)} style={styles.gapSm}>
        <Head note={s.text.titleNote} />
        <View style={twoCol ? styles.twoCol : styles.gapMd}>
          <View style={twoCol ? styles.col : null}>
            <ValueRow value={s.value} />
          </View>
          <View style={twoCol ? styles.col : null}>
            <TrendRow trend={trend} />
          </View>
        </View>
        {/* 종합: 두 점수 아래 작게, 없으면 없다고 (설계 5.4 · 목업 1·2). 차이가 30 이상이면 한 줄 안내 */}
        <View style={[styles.compositeBox, { borderTopColor: t.line }]}>
          <View style={styles.composite}>
            <Text style={[styles.name, { color: t.sub }]}>{SCORE_LABELS.composite}</Text>
            {comp.score !== null ? (
              <Text style={[styles.num, { color: t.ink }]}>{comp.score}</Text>
            ) : (
              <Text style={{ color: t.sub, fontSize: font.body, fontWeight: "700" }}>{comp.label}</Text>
            )}
            {comp.reason ? <Muted style={styles.shrink}>{comp.reason}</Muted> : null}
          </View>
          {comp.gapText ? <Text style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.45 }}>{comp.gapText}</Text> : null}
        </View>
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
      {open ? <HowSection s={s} onTechnical={onTechnical} techTabLabel={techTabLabel} onValue={onValue} valueTabLabel={valueTabLabel} /> : null}
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

/**
 * 점수 없는 줄: 이름 · 상태 글(굵게) / 이유 한 줄. 큰 글씨(130% 이상)에서는 이름과 상태 글을 두 줄로 나눈다 —
 * 한 줄에 같은 굵기로 이어 쓰면 '가치 지표 계산 준비 중'이 한 덩어리로 읽히므로
 */
function StatusRow({ name, label, text, children }: { name: string; label: string; text: string | null; children?: React.ReactNode }) {
  const t = useTheme();
  const fs = useFontScale();
  const stack = stackRows(fs);
  const nw = nameWidth(scores.nameW, fs);
  return (
    <View style={styles.gapXs}>
      <View style={stack ? styles.gapXxs : styles.row}>
        <Text style={[styles.name, { color: t.ink }, stack ? null : { width: nw }]}>{name}</Text>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flexShrink: 1 }}>{label}</Text>
      </View>
      <View style={stack ? null : { marginLeft: nw + space.sm }}>
        {children}
        {text ? <Muted>{text}</Muted> : null}
      </View>
    </View>
  );
}

/** 점수 줄 (가치·추세 같은 모양): 이름 · 막대 · 숫자 · 띠 / (배지) / 뜻 한 줄. 130% 부터 이름·숫자 / 막대·띠 두 줄 */
function ScoreRow({ name, score, band, meaning, speech, badges }: { name: string; score: number; band: string; meaning: string | null; speech: string; badges?: string[] }) {
  const t = useTheme();
  const fs = useFontScale();
  const stack = stackRows(fs);
  const nw = nameWidth(scores.nameW, fs);
  const num = (
    <Text style={[styles.num, { color: t.ink }]} accessibilityLabel={speech}>
      {score}
    </Text>
  );
  const bandText = (
    <Text style={[styles.band, { color: t.sub }]} numberOfLines={stack ? 2 : 1}>
      {band}
    </Text>
  );
  const indent = stack ? null : { marginLeft: nw + space.sm };
  return (
    <View style={styles.gapXs}>
      {stack ? (
        // 설계 4.3: 글자 130% 이상은 이름·숫자 / 막대·띠 두 줄
        <>
          <View style={styles.row}>
            <Text style={[styles.name, { color: t.ink, flexGrow: 1 }]}>{name}</Text>
            {num}
          </View>
          <View style={styles.row}>
            <ScoreBar score={score} />
            {bandText}
          </View>
        </>
      ) : (
        <View style={styles.row}>
          <Text style={[styles.name, { color: t.ink, width: nw }]}>{name}</Text>
          <ScoreBar score={score} />
          {num}
          {bandText}
        </View>
      )}
      {badges?.length ? (
        <View style={[styles.badges, indent]}>
          {badges.map((b) => (
            <Badge key={b}>{b}</Badge>
          ))}
        </View>
      ) : null}
      {meaning ? <Muted style={indent}>{meaning}</Muted> : null}
    </View>
  );
}

/** 가치 줄: 점수가 있으면 막대·숫자·띠(배지), 없으면 상태 글과 이유 */
function ValueRow({ value }: { value: ValueScoreBlock }) {
  if (!valueHasScore(value)) return <StatusRow name={SCORE_LABELS.value} label={value.label} text={value.text} />;
  return <ScoreRow name={SCORE_LABELS.value} score={value.score!} band={String(value.band)} meaning={value.text} speech={valueSpeech(value)} badges={value.badges} />;
}

/** 추세 줄: 점수가 있으면 이름 · 막대 · 숫자 · 띠 / 뜻 한 줄, 없으면 상태 글과 이유 (레버리지는 참고 줄) */
function TrendRow({ trend }: { trend: TrendScoreBlock }) {
  const t = useTheme();
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
  return <ScoreRow name={SCORE_LABELS.trend} score={trend.score!} band={trend.band!} meaning={trend.meaning} speech={trendSpeech(trend)} />;
}

/** 구성·계산 방법 (펼침): 가치 구성(묶음 5줄·표시 최대 2개·가치분석 탭으로) → 추세 구성 → 이 점수는 어떻게 만들었나 */
function HowSection({ s, onTechnical, techTabLabel, onValue, valueTabLabel }: { s: IndicatorScores; onTechnical?: () => void; techTabLabel: string; onValue?: () => void; valueTabLabel: string }) {
  const t = useTheme();
  const ok = trendHasScore(s.trend);
  const vOk = valueHasScore(s.value);
  const flags = flagPreview(s.value);
  const wide = valueTabLabel === SCORE_LABELS.toValueWide;
  return (
    <View style={[styles.how, { borderTopColor: t.line }]}>
      {vOk ? (
        <View style={styles.gapXs}>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
            {SCORE_LABELS.valueParts}
          </Text>
          <Muted>{s.text.valueAbout ?? s.value.about}</Muted>
          {(s.value.families ?? []).map((f) => (
            <FamilyMini key={f.key} f={f} />
          ))}
          {flags.shown.map((f) => (
            <Text key={f.key} style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>
              {SCORE_LABELS.flags} · {f.text}
            </Text>
          ))}
          {flags.more ? <Muted>{moreFlagsText(flags.more, wide)}</Muted> : null}
          {onValue ? <LinkRow label={valueTabLabel} onPress={onValue} /> : null}
        </View>
      ) : null}
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
        {vOk && s.value.versionLine ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{s.value.versionLine}</Text> : null}
        <Text style={{ color: t.muted, fontSize: font.tiny }}>{s.trend.versionLine}</Text>
      </View>
    </View>
  );
}

function FamilyMini({ f }: { f: { key: string; name: string; score: number | null; weight: number } }) {
  const t = useTheme();
  const fs = useFontScale();
  return (
    <View style={[styles.row, styles.mini]} accessible accessibilityLabel={familySpeech(f)}>
      <Text style={{ color: t.sub, fontSize: font.small, width: nameWidth(scores.familyNameW, fs) }} numberOfLines={2}>
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
  gapXxs: { gap: space.xxs },
  gapXs: { gap: space.xs },
  gapSm: { gap: space.sm },
  shrink: { flexShrink: 1 },
  gapMd: { gap: space.md },
  twoCol: { flexDirection: "row", gap: space.xl },
  col: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { minWidth: scores.nameW, fontSize: font.body, fontWeight: "700" },
  num: { minWidth: scores.numW, textAlign: "right", fontSize: font.title, fontWeight: "800", fontVariant: ["tabular-nums"] },
  band: { minWidth: scores.bandW, fontSize: font.body },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  refRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s },
  compositeBox: { gap: space.xxs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm },
  composite: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm, rowGap: space.xxs },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  how: { gap: space.md, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
  mini: { minHeight: touch.min - space.md },
  link: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  errorRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" },
});
