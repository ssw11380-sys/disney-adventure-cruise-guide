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
  agoMissingNaverCap,
  agoSpeech,
  checkLine,
  FLOW_NAMES,
  FLOW_TEXT,
  highLow,
  lastData,
  limitNote,
  missingNote,
  missingNoteWide,
  periodChipA11y,
  periodLabel,
  pickedLine,
  pickedParts,
  pctPointNote,
  ratioDateLine,
  ratioSpeech,
  shortData,
  shortDataNaverCap,
  sourceNaver,
  sourceToss,
  staleLine,
  sumSub1,
  sumSubWide,
  TABLE_HEAD,
  tableRowSpeech,
  todayNote,
  todayValues,
} from "@/lib/flowText";
import {
  barsSpeech,
  clampPick,
  dateKo,
  dateLong,
  DAY_TABLE_GAP,
  dayTableLayout,
  flowSumRows,
  formatLimitPct,
  formatPp,
  formatRatio,
  formatShares,
  hhmm,
  lastDataOld,
  sharesSign,
  shortDate,
  showSumTable,
  stampKo,
  sumColumns,
} from "@/lib/flowView";
import { clampScale } from "@/lib/textScale";
import { changeColor, font, fontCap, space, touch, useFontScale, useTheme } from "@/theme";
import { FlowBars } from "./FlowBars";
import { ForeignRatioLine } from "./ForeignRatioLine";

const PERIODS: FlowPeriod[] = [5, 20, 60];
/** 네이버 증권이 한 번에 주는 최대 줄 수 (서버 NAVER_TREND_MAX) */
const NAVER_ROWS = 60;
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
  const pickedArgs = [dateKo(pickedDay.date), formatShares(pickedDay.individual), formatShares(pickedDay.foreign), formatShares(pickedDay.institution), pickedDay.close !== null ? pickedDay.close.toLocaleString("ko-KR") : null] as const;
  const picked = pickedLine(...pickedArgs);
  const labelW = Math.ceil(estimateTextWidth(FLOW_NAMES.foreign, font.small * clampScale(fs, fontCap.row))) + space.sm;
  // 칩: 휴대폰은 합계와 막대를 함께, 넓은 칸은 막대 카드에서 막대만 바꾼다 (화면 읽기 이름에 무엇을 바꾸는지)
  const chips = (
    <View style={styles.chips}>
      {PERIODS.map((p) => (
        <Chip key={p} label={periodLabel(p)} accessibilityLabel={periodChipA11y(wideSums ? "bars" : "both", p)} active={p === period} onPress={() => setPeriod(p)} wideTouch />
      ))}
    </View>
  );

  // ── ① 합계 ──
  const sum = d.sums[String(period) as "5" | "20" | "60"];
  // 실제로 더한 날 수 (자료가 모자라면 그만큼 — 부제·화면 읽기·안내가 같은 수를 쓴다)
  const sumDays = Math.min(period, sum.days) || period;
  const sumRows = flowSumRows(sum, sumDays, toss);
  const noteSum = wideSums ? d.sums["60"] : sum;
  const notePeriod = wideSums ? 60 : period;
  // 넓은 칸 세 기간 표의 열 (자료가 모자라 같은 날 수가 되는 기간은 한 열로) · 열마다 값이 빠진 날
  const cols = sumColumns(d.sums);
  const wideMissing = cols.map((c) => [c.days, d.sums[String(c.period) as "5" | "20" | "60"].missing] as const).filter(([, m]) => m > 0);
  // 네이버는 한 번에 60줄까지라 집계 중인 오늘 줄이 끼면 확정 줄이 59개 (종목 자료가 짧은 것이 아님)
  const naverCap = !toss && d.today !== null && d.days.length + 1 >= NAVER_ROWS;
  // 네이버 자료가 60줄에서 끊김 (둘째 쪽을 받지 못함 — 60일 전 보유율 줄이 없는 까닭)
  const naverCut = !toss && d.days.length + (d.today ? 1 : 0) >= NAVER_ROWS;
  // 마지막 자료가 받은 날보다 한참 앞 (거래정지·상장폐지 — '최근 20일'이 요즘이 아님)
  const lastOld = lastDataOld(d.days[0]!.date, d.fetchedAt);
  const sumCard = (
    <Card>
      <View style={styles.headRow}>
        <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
          {FLOW_TEXT.sumTitle}
        </Text>
        {wideSums ? null : chips}
      </View>
      <Muted>{wideSums ? sumSubWide(cols.map((c) => c.days)) : sumSub1(sumDays)}</Muted>
      <Muted>{FLOW_TEXT.sumSub2}</Muted>
      {lastOld ? <Muted>{lastData(dateKo(d.days[0]!.date))}</Muted> : null}
      {wideSums ? (
        <SumTable d={d} cols={cols} />
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
      {noteSum.days < notePeriod ? <Muted>{naverCap ? shortDataNaverCap(noteSum.days) : shortData(noteSum.days)}</Muted> : null}
      {wideSums ? wideMissing.length ? <Muted>{missingNoteWide(wideMissing)}</Muted> : null : noteSum.missing > 0 ? <Muted>{missingNote(noteSum.missing)}</Muted> : null}
      <Muted>{FLOW_TEXT.signNote}</Muted>
      <Muted>{toss ? FLOW_TEXT.zeroNoteToss : FLOW_TEXT.zeroNoteNaver}</Muted>
      {d.today ? (
        <View style={[styles.today, { borderLeftColor: t.lineStrong }]}>
          <Text style={{ color: t.sub, fontSize: font.small }}>{todayNote(shortDate(d.today.date))}</Text>
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
      {/* 알림 영역(live region)은 두지 않는다 — 막대 칸의 값(accessibilityValue)이 같은 글을 읽어 한 번 옮길 때 두 번 읽지 않게 */}
      <View style={styles.picked} accessible accessibilityLabel={picked} testID="flow-picked">
        {pickedParts(...pickedArgs).map((part, i) => (
          <Text key={i} style={[styles.num, { color: t.ink, fontSize: font.small }]}>
            {i ? `· ${part}` : part}
          </Text>
        ))}
      </View>
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
      {table ? <DayTable days={d.days.slice(0, period)} inner={inner} /> : null}
    </Card>
  );

  // ── ③ 외국인 보유율 ──
  const r = d.ratio;
  const ref = r ? (r.ago["20"] ?? r.ago["5"] ?? r.ago["60"]) : null;
  const ratioCard = !r ? (
    // 보유율 칸이 비어 있는 종목 (일부 ETN) — 카드가 말없이 사라지지 않게 한 줄
    <Card>
      <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
        {FLOW_TEXT.ratioTitle}
      </Text>
      <Text style={{ color: t.sub, fontSize: font.small }}>{FLOW_TEXT.ratioNone}</Text>
    </Card>
  ) : (
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
        // 없으면: 네이버가 60줄에서 끊긴 60일 전은 까닭을 붙인다 (60일 합계는 보이므로)
        const missing = n === 60 && naverCut ? agoMissingNaverCap(n) : agoMissing(n);
        return (
          <Text
            key={n}
            style={[styles.num, { color: a ? t.ink : t.muted, fontSize: font.small }]}
            accessibilityLabel={a ? agoSpeech(n, shortDate(a.date), formatRatio(a.value), Math.abs(a.change).toFixed(2), /[1-9]/.test(a.change.toFixed(2)) ? Math.sign(a.change) : 0) : missing}
          >
            {a ? agoLine(n, shortDate(a.date), formatRatio(a.value), formatPp(a.change)) : missing}
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
      {d.limit ? <Text style={{ color: t.sub, fontSize: font.small }}>{limitNote(formatLimitPct(d.limit.limitPct), formatRatio(d.limit.usedPct, 1))}</Text> : null}
      <Muted>{FLOW_TEXT.ratioRevise}</Muted>
    </Card>
  );

  // ── ④ 읽는 법 (처음엔 접힘) — 외국인 뜻은 출처마다 (토스증권은 금융감독원 등록 외국인 기준, 네이버는 기준이 달라 값이 다름) ──
  const aboutLines = toss ? FLOW_TEXT.about : FLOW_TEXT.about.map((line) => (line.startsWith(`${FLOW_NAMES.foreign}:`) ? FLOW_TEXT.aboutForeignNaver : line));
  const aboutCard = (
    <Card>
      <Pressable onPress={() => setAbout((v) => !v)} accessibilityRole="button" accessibilityLabel={FLOW_TEXT.aboutTitle} accessibilityState={{ expanded: about }} style={styles.toggle}>
        <Text style={[styles.title, { color: t.ink }]}>{FLOW_TEXT.aboutTitle}</Text>
        <Ionicons name={about ? "chevron-up" : "chevron-down"} size={font.body} color={t.muted} />
      </Pressable>
      {about ? aboutLines.map((line) => <Text key={line} style={{ color: t.sub, fontSize: font.small, lineHeight: font.small * 1.5 }}>{line}</Text>) : null}
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
      <Muted>{d.source === "toss-web" ? sourceToss(stampKo(d.asOf)) : sourceNaver(d.days[0] ? dateKo(d.days[0].date) : null, stampKo(d.fetchedAt))}</Muted>
      {d.check && d.check.days > 0 ? <Muted>{checkLine(d.check.days, d.check.same, stampKo(d.check.at))}</Muted> : null}
      {d.stale ? <Muted>{staleLine(stampKo(d.fetchedAt))}</Muted> : null}
    </View>
  );
}

/**
 * 넓은 칸: 세 기간 합계 표 (구분 | 5일 | 20일 | 60일). 한 줄 = 한 요소 (세 기간 문장을 이어 읽음).
 * 열 머리는 실제로 더한 날 수 — 자료가 12일치면 '5일 | 12일' (같은 합계를 두 열에 되풀이하지 않음, lib/flowView sumColumns)
 */
function SumTable({ d, cols }: { d: Supported; cols: ReturnType<typeof sumColumns> }) {
  const t = useTheme();
  const toss = d.source === "toss-web";
  const byPeriod = cols.map((c) => flowSumRows(d.sums[String(c.period) as "5" | "20" | "60"], c.days, toss));
  return (
    <View>
      <View style={[styles.tableRow, { borderBottomColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={[styles.cellName, { color: t.muted, fontSize: font.small }]}>{TABLE_HEAD}</Text>
        {cols.map((c) => (
          <Text key={c.period} style={[styles.cell, { color: t.muted, fontSize: font.small }]}>
            {periodLabel(c.days)}
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

/**
 * 날짜별 숫자 표 (최근 날부터). 한 줄 = 한 요소 (화면 읽기는 '주'까지 읽는다).
 * 고정 폭 열 표라 글자는 fontCap.row(1.4배)까지만 커지고, 칸에는 '주' 없이 숫자만(표 위 '단위: 주') — 큰 글씨에서 '-1,243' / '만 주'처럼
 * 숫자와 단위가 두 줄로 갈라져 1만 배 작은 값으로 읽히지 않게. 날짜 열은 가장 넓은 날짜가 한 줄에 들어가는 폭이고,
 * 그래도 한 줄에 다 들어가지 않는 좁은 칸이면 날짜를 위에 따로 둔다 (lib/flowView dayTableLayout)
 */
function DayTable({ days, inner }: { days: Supported["days"]; inner: number }) {
  const t = useTheme();
  const fs = useFontScale();
  const { dateW, fits } = dayTableLayout(inner, fs);
  const dateCol = fits ? { width: dateW } : styles.dateAbove;
  const cell = (v: number | null) => (
    <Text
      style={[styles.dayCell, styles.num, { color: changeColor(t, sharesSign(v)), fontSize: font.small }]}
      maxFontSizeMultiplier={fontCap.row}
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.7}
    >
      {formatShares(v, { unit: false })}
    </Text>
  );
  return (
    <View testID="flow-day-table">
      <Text style={[styles.unit, { color: t.muted, fontSize: font.tiny }]} maxFontSizeMultiplier={fontCap.row} importantForAccessibility="no" accessibilityElementsHidden>
        {FLOW_TEXT.tableUnit}
      </Text>
      <View style={[styles.tableRow, styles.dayRow, { borderBottomColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={[dateCol, { color: t.muted, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row} numberOfLines={1}>
          {FLOW_TEXT.tableDate}
        </Text>
        {(["individual", "foreign", "institution"] as const).map((k) => (
          <Text key={k} style={[styles.dayCell, { color: t.muted, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row} numberOfLines={1}>
            {FLOW_NAMES[k]}
          </Text>
        ))}
      </View>
      {days.map((x) => (
        <View key={x.date} style={[styles.tableRow, styles.dayRow, { borderBottomColor: t.line }]} accessible accessibilityLabel={tableRowSpeech(dateLong(x.date), formatShares(x.individual), formatShares(x.foreign), formatShares(x.institution))}>
          <Text style={[dateCol, styles.num, { color: t.sub, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row} numberOfLines={1}>
            {shortDate(x.date)}
          </Text>
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
  picked: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs },
  unit: { alignSelf: "flex-end" },
  dayRow: { flexWrap: "wrap", columnGap: DAY_TABLE_GAP },
  dayCell: { flex: 1, minWidth: 0, textAlign: "right" },
  dateAbove: { width: "100%" },
});
