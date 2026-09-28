import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useInvestorFlow } from "@/api/hooks";
import type { FlowPeriod, InvestorFlow } from "@/api/types";
import { Button, Card, Chip, Loading, Muted } from "@/components/ui";
import { estimateTextWidth } from "@/lib/chartLayout";
import {
  agoLine,
  agoMissing,
  checkLine,
  FLOW_NAMES,
  FLOW_TEXT,
  highLow,
  limitNote,
  missingNote,
  periodLabel,
  pickedLine,
  pctPointNote,
  ratioDateLine,
  ratioSpeech,
  shortData,
  sourceNaver,
  sourceToss,
  staleLine,
  sumSub1,
  TABLE_HEAD,
  tableRowSpeech,
  todayNote,
  todayValues,
} from "@/lib/flowText";
import { barsSpeech, clampPick, dateKo, dateLong, flowSumRows, formatPp, formatRatio, formatShares, hhmm, sharesSign, shortDate, showSumTable, stampKo } from "@/lib/flowView";
import { clampScale } from "@/lib/textScale";
import { changeColor, font, fontCap, space, touch, useFontScale, useTheme } from "@/theme";
import { FlowBars } from "./FlowBars";
import { ForeignRatioLine } from "./ForeignRatioLine";

const PERIODS: FlowPeriod[] = [5, 20, 60];
type Supported = Extract<InvestorFlow, { supported: true }>;

/**
 * 종목 상세 '수급' 탭 (3-33, 플래그 flowTab — 켜져 있을 때만 이 부품을 그린다). 한국 종목:
 *  ① 투자자별 매매 합계(5·20·60일, 기본 20일 — 넓은 칸은 세 기간 표) ② 날마다 막대(세 줄 같은 눈금, 누르면 그날 값, 날짜별 숫자 표)
 *  ③ 외국인 보유율(60일 선 · 5·20·60일 전과 %p 차이 · 한도 종목은 한도·소진율) ④ 숫자 읽는 법(처음엔 접힘) ⑤ 출처·기준 시각·대조 개수.
 * 미국 종목은 서버에 묻지 않고 '해당 없음'. 글은 모두 lib/flowText (사실만 — 판단하는 말·색·배지 없음). 색은 부호대로(+빨강·−파랑)이고 늘 +/− 글자를 함께 쓴다.
 * width: 이 탭이 놓이는 칸의 폭 (카드 안쪽 = width − 좌우 여백)
 */
export function FlowTab({ code, us, width }: { code: string; us: boolean; width: number }) {
  const t = useTheme();
  const fs = useFontScale();
  const q = useInvestorFlow(code, !us);
  const [period, setPeriodState] = useState<FlowPeriod>(20);
  /** 막대에서 고른 날 (왼쪽부터 번호, null = 가장 최근 날) */
  const [pick, setPick] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [about, setAbout] = useState(false);
  const setPeriod = (p: FlowPeriod) => {
    setPeriodState(p);
    setPick(null);
  };
  const inner = Math.max(0, width - space.lg * 2);

  /** 모든 상태가 같은 뿌리 (카드 사이 간격 · 캡처·테스트가 찾는 testID) */
  const root = (children: React.ReactNode) => (
    <View style={styles.stack} testID="flow-tab">
      {children}
    </View>
  );
  if (us) return root(<UsCard />);
  if (q.data === undefined) {
    return root(
      <Card>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {FLOW_TEXT.sumTitle}
        </Text>
        {q.isError ? (
          <View style={styles.errorRow} accessibilityRole="alert">
            <Text style={{ color: t.sub, fontSize: font.small, flexShrink: 1 }}>{FLOW_TEXT.fail}</Text>
            <Button title={FLOW_TEXT.retry} variant="secondary" compact onPress={() => void q.refetch()} accessibilityLabel={FLOW_TEXT.retryA11y} />
          </View>
        ) : (
          <Loading label={FLOW_TEXT.loading} />
        )}
      </Card>,
    );
  }
  if (q.data === null)
    return root(
      <Card>
        <Muted>{FLOW_TEXT.off}</Muted>
      </Card>,
    );
  const d = q.data;
  if (!d.supported) return root(<UsCard />);
  if (!d.days.length)
    return root(
      <>
        <Card>
          <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
            {FLOW_TEXT.sumTitle}
          </Text>
          <Text style={{ color: t.sub, fontSize: font.body }}>{FLOW_TEXT.empty}</Text>
        </Card>
        <SourceLines d={d} />
      </>,
    );

  const toss = d.source === "toss-web";
  const wideSums = showSumTable(inner, fs);
  // 막대: 보이는 기간의 확정 줄 (왼쪽이 오래된 날)
  const bars = d.days.slice(0, period).reverse();
  const pickedIdx = clampPick(pick, bars.length);
  const pickedDay = bars[pickedIdx]!;
  const noUnit = (v: number | null) => formatShares(v, { unit: false });
  const picked = pickedLine(dateKo(pickedDay.date), noUnit(pickedDay.individual), noUnit(pickedDay.foreign), noUnit(pickedDay.institution), pickedDay.close !== null ? pickedDay.close.toLocaleString("ko-KR") : null);
  const labelW = Math.ceil(estimateTextWidth(FLOW_NAMES.foreign, font.small * clampScale(fs, fontCap.row))) + space.sm;
  const chips = (
    <View style={styles.chips}>
      {PERIODS.map((p) => (
        <Chip key={p} label={periodLabel(p)} active={p === period} onPress={() => setPeriod(p)} />
      ))}
    </View>
  );

  // ── ① 합계 ──
  const sum = d.sums[String(period) as "5" | "20" | "60"];
  const sumRows = flowSumRows(sum, Math.min(period, sum.days) || period, toss);
  const noteSum = wideSums ? d.sums["60"] : sum;
  const notePeriod = wideSums ? 60 : period;
  const sumCard = (
    <Card>
      <View style={styles.headRow}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {FLOW_TEXT.sumTitle}
        </Text>
        {wideSums ? null : chips}
      </View>
      {wideSums ? null : <Muted>{sumSub1(period)}</Muted>}
      <Muted>{FLOW_TEXT.sumSub2}</Muted>
      {wideSums ? (
        <SumTable d={d} />
      ) : (
        <View>
          {sumRows.map((r) => (
            <View key={r.key} style={[styles.sumRow, { borderBottomColor: t.line }]} accessible accessibilityLabel={r.speech}>
              <Text style={{ color: t.sub, fontSize: font.body }}>{r.name}</Text>
              <Text style={[styles.num, { color: changeColor(t, r.sign), fontSize: font.body, fontWeight: "700" }]}>{r.text}</Text>
            </View>
          ))}
        </View>
      )}
      {noteSum.days < notePeriod ? <Muted>{shortData(noteSum.days)}</Muted> : null}
      {noteSum.missing > 0 ? <Muted>{missingNote(noteSum.missing)}</Muted> : null}
      <Muted>{FLOW_TEXT.signNote}</Muted>
      <Muted>{toss ? FLOW_TEXT.zeroNoteToss : FLOW_TEXT.zeroNoteNaver}</Muted>
      {d.today ? (
        <View style={[styles.today, { borderLeftColor: t.lineStrong }]}>
          <Text style={{ color: t.sub, fontSize: font.small }}>{todayNote(dateKo(d.today.date))}</Text>
          {d.today.foreign !== null || d.today.institution !== null ? (
            <Text style={[styles.num, { color: t.sub, fontSize: font.small }]}>
              {todayValues(hhmm(d.today.updatedAt), formatShares(d.today.foreign), formatShares(d.today.institution))}
              {d.today.individual === null ? ` ${FLOW_TEXT.individualLater}` : ""}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Card>
  );

  // ── ② 막대 ──
  const barCard = (
    <Card>
      <View style={styles.headRow}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {FLOW_TEXT.barsTitle}
        </Text>
        {wideSums ? chips : null}
      </View>
      <Text style={[styles.num, { color: t.ink, fontSize: font.small }]} accessibilityLiveRegion="polite" testID="flow-picked">
        {picked}
      </Text>
      <FlowBars days={bars} width={inner} labelW={labelW} picked={pickedIdx} onPick={setPick} speech={barsSpeech(d.days.slice(0, period))} pickedText={picked} />
      <View style={[styles.axis, { paddingLeft: labelW }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={{ color: t.muted, fontSize: font.tiny }}>{shortDate(bars[0]!.date)}</Text>
        <Text style={{ color: t.muted, fontSize: font.tiny }}>{shortDate(bars[bars.length - 1]!.date)}</Text>
      </View>
      <Muted>{FLOW_TEXT.barsHint}</Muted>
      <Pressable onPress={() => setTable((v) => !v)} accessibilityRole="button" accessibilityLabel={table ? FLOW_TEXT.tableClose : FLOW_TEXT.tableOpen} accessibilityState={{ expanded: table }} style={styles.toggle}>
        <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "700" }}>{table ? FLOW_TEXT.tableClose : FLOW_TEXT.tableOpen}</Text>
        <Ionicons name={table ? "chevron-up" : "chevron-down"} size={font.body} color={t.accent} />
      </Pressable>
      {table ? <DayTable days={d.days.slice(0, period)} /> : null}
    </Card>
  );

  // ── ③ 외국인 보유율 ──
  const r = d.ratio;
  const ref = r ? (r.ago["20"] ?? r.ago["5"] ?? r.ago["60"]) : null;
  const ratioCard = r ? (
    <Card>
      <View style={styles.headRow}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {FLOW_TEXT.ratioTitle}
        </Text>
        <Text style={[styles.num, { color: t.ink, fontSize: font.title, fontWeight: "800" }]}>{formatRatio(r.now)}</Text>
      </View>
      <Muted>{ratioDateLine(dateKo(r.date))}</Muted>
      {PERIODS.map((n) => {
        const a = r.ago[String(n) as "5" | "20" | "60"];
        return (
          <Text key={n} style={[styles.num, { color: a ? t.ink : t.muted, fontSize: font.small }]}>
            {a ? agoLine(n, formatRatio(a.value), formatPp(a.change)) : agoMissing(n)}
          </Text>
        );
      })}
      {r.series.length > 1 ? (
        <>
          <ForeignRatioLine
            series={r.series}
            width={inner}
            speech={ratioSpeech(r.series.length - 1, shortDate(r.series[0]![0]), formatRatio(r.series[0]![1]), shortDate(r.date), formatRatio(r.now), formatRatio(r.high), formatRatio(r.low))}
          />
          <Muted>{highLow(formatRatio(r.high), formatRatio(r.low))}</Muted>
        </>
      ) : null}
      {ref ? <Muted>{pctPointNote(formatRatio(ref.value), formatRatio(r.now), formatPp(ref.change))}</Muted> : null}
      {d.limit ? <Text style={{ color: t.sub, fontSize: font.small }}>{limitNote(formatRatio(d.limit.limitPct, 1), formatRatio(d.limit.usedPct, 1))}</Text> : null}
      <Muted>{FLOW_TEXT.ratioRevise}</Muted>
    </Card>
  ) : null;

  // ── ④ 읽는 법 (처음엔 접힘) ──
  const aboutCard = (
    <Card>
      <Pressable onPress={() => setAbout((v) => !v)} accessibilityRole="button" accessibilityLabel={FLOW_TEXT.aboutTitle} accessibilityState={{ expanded: about }} style={styles.toggle}>
        <Text style={[styles.title, { color: t.ink }]}>{FLOW_TEXT.aboutTitle}</Text>
        <Ionicons name={about ? "chevron-up" : "chevron-down"} size={font.body} color={t.muted} />
      </Pressable>
      {about ? FLOW_TEXT.about.map((line) => <Text key={line} style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>{line}</Text>) : null}
    </Card>
  );

  return root(
    <>
      {sumCard}
      {barCard}
      {ratioCard}
      {aboutCard}
      <SourceLines d={d} />
    </>,
  );
}

/** 미국 종목: 탭은 있고 '해당 없음' 안내만 */
function UsCard() {
  const t = useTheme();
  return (
    <Card>
      <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
        {FLOW_TEXT.usTitle}
      </Text>
      {FLOW_TEXT.us.map((line) => (
        <Text key={line} style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>
          {line}
        </Text>
      ))}
    </Card>
  );
}

/** 출처·기준 시각 · 대조 개수 · 오래된 값 (작은 회색) */
function SourceLines({ d }: { d: Supported }) {
  return (
    <View style={styles.source}>
      <Muted>{d.source === "toss-web" ? sourceToss(stampKo(d.asOf)) : sourceNaver(stampKo(d.fetchedAt))}</Muted>
      {d.check && d.check.days > 0 ? <Muted>{checkLine(d.check.days, d.check.same, stampKo(d.check.at))}</Muted> : null}
      {d.stale ? <Muted>{staleLine(stampKo(d.fetchedAt))}</Muted> : null}
    </View>
  );
}

/** 넓은 칸: 세 기간 합계 표 (구분 | 5일 | 20일 | 60일). 한 줄 = 한 요소 (세 기간 문장을 이어 읽음) */
function SumTable({ d }: { d: Supported }) {
  const t = useTheme();
  const toss = d.source === "toss-web";
  const byPeriod = PERIODS.map((p) => {
    const s = d.sums[String(p) as "5" | "20" | "60"];
    return flowSumRows(s, Math.min(p, s.days) || p, toss);
  });
  return (
    <View>
      <View style={[styles.tableRow, { borderBottomColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={[styles.cellName, { color: t.muted, fontSize: font.small }]}>{TABLE_HEAD}</Text>
        {PERIODS.map((p) => (
          <Text key={p} style={[styles.cell, { color: t.muted, fontSize: font.small }]}>
            {periodLabel(p)}
          </Text>
        ))}
      </View>
      {byPeriod[0]!.map((row, i) => (
        <View key={row.key} style={[styles.tableRow, { borderBottomColor: t.line }]} accessible accessibilityLabel={byPeriod.map((rows) => rows[i]!.speech).join(". ")}>
          <Text style={[styles.cellName, { color: t.sub, fontSize: font.body }]}>{row.name}</Text>
          {byPeriod.map((rows, j) => (
            <Text key={j} style={[styles.cell, styles.num, { color: changeColor(t, rows[i]!.sign), fontSize: font.body, fontWeight: "700" }]}>
              {rows[i]!.text}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/** 날짜별 숫자 표 (최근 날부터). 한 줄 = 한 요소 */
function DayTable({ days }: { days: Supported["days"] }) {
  const t = useTheme();
  const cell = (v: number | null) => <Text style={[styles.cell, styles.num, { color: changeColor(t, sharesSign(v)), fontSize: font.small }]}>{formatShares(v)}</Text>;
  return (
    <View testID="flow-day-table">
      <View style={[styles.tableRow, { borderBottomColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={[styles.cellName, { color: t.muted, fontSize: font.small }]}>{FLOW_TEXT.tableDate}</Text>
        {(["individual", "foreign", "institution"] as const).map((k) => (
          <Text key={k} style={[styles.cell, { color: t.muted, fontSize: font.small }]}>
            {FLOW_NAMES[k]}
          </Text>
        ))}
      </View>
      {days.map((x) => (
        <View key={x.date} style={[styles.tableRow, { borderBottomColor: t.line }]} accessible accessibilityLabel={tableRowSpeech(dateLong(x.date), formatShares(x.individual), formatShares(x.foreign), formatShares(x.institution))}>
          <Text style={[styles.cellName, styles.num, { color: t.sub, fontSize: font.small }]}>{shortDate(x.date)}</Text>
          {cell(x.individual)}
          {cell(x.foreign)}
          {cell(x.institution)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.sm },
  title: { fontSize: font.body, fontWeight: "700", flexShrink: 1 },
  headRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.sm, rowGap: space.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  sumRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: space.md, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  num: { fontVariant: ["tabular-nums"] },
  today: { borderLeftWidth: 2, paddingLeft: space.sm, gap: space.xxs },
  axis: { flexDirection: "row", justifyContent: "space-between" },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, alignSelf: "flex-start" },
  errorRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  source: { paddingHorizontal: space.lg, gap: space.xxs },
  tableRow: { flexDirection: "row", alignItems: "center", paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth, columnGap: space.xs },
  cellName: { flex: 1, minWidth: 0 },
  cell: { flex: 1.3, minWidth: 0, textAlign: "right" },
});
