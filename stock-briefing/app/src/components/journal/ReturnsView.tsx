import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useJournalReturns } from "@/api/hooks";
import type { JournalReturns, ReturnsMarket } from "@/api/types";
import { TwoPane } from "@/components/TwoPane";
import { Chip, Empty, ErrorView, Loading } from "@/components/ui";
import { formatPct, shownSign } from "@/lib/format";
import { MARKETS, returnsHeader, returnsLines, returnsMethod, returnsNotReady, returnsSpeech, type ListPreset } from "@/lib/journal";
import { changeColor, font, space, touch, useTheme } from "@/theme";
import { PeriodChips } from "./PeriodChips";
import { ReturnLine } from "./ReturnLine";

/**
 * 매매일지 '수익률' 탭 (3-37): 기간·시장 칩 → 큰 숫자 '수익률 (시간가중)' · 기간 손익 · 시작→끝 평가금액 · 그 사이 사고판 금액 · 누적 선 · '계산 방법' 펼침.
 * 스냅샷이 10거래일 쌓이기 전에는 숫자 대신 안내 한 줄. 폴드 가로(twoPane)는 왼쪽 요약·계산 방법 | 오른쪽 선 그림
 */
export function ReturnsView({ twoPane, today }: { twoPane: boolean; today: string }) {
  const t = useTheme();
  const [preset, setPreset] = useState<ListPreset>("1M");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [market, setMarket] = useState<ReturnsMarket>("ALL");
  const [open, setOpen] = useState(false);
  const q = useJournalReturns({ preset: preset === "custom" && !custom ? "1M" : preset, market, ...(preset === "custom" && custom ? custom : {}) }, true);
  const r = q.data;
  const chips = (
    <PeriodChips
      value={preset}
      custom={custom}
      today={today}
      onChange={(p, c) => {
        setPreset(p);
        if (c) setCustom(c);
      }}
      extra={
        <>
          <View style={[styles.sep, { backgroundColor: t.line }]} />
          {MARKETS.map((m) => (
            <Chip key={m.value} label={m.label} active={market === m.value} accessibilityLabel={`시장 ${m.label}`} onPress={() => setMarket(m.value)} />
          ))}
        </>
      }
    />
  );
  let summary: React.ReactNode;
  let chart: React.ReactNode = null;
  if (!r && q.isLoading) summary = <Loading />;
  else if (!r && q.isError) summary = <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  else if (!r || !r.enabled) summary = <Empty title="지금은 기간 수익률을 볼 수 없습니다" />;
  else if (!r.ready)
    summary = (
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} accessible accessibilityLabel={returnsNotReady(r)} testID="returns-not-ready">
        <Ionicons name="time-outline" size={font.h2} color={t.muted} />
        <Text style={{ color: t.sub, fontSize: font.body }}>{returnsNotReady(r)}</Text>
      </View>
    );
  else {
    summary = <ReadySummary r={r} open={open} onToggle={() => setOpen(!open)} />;
    chart = r.series && r.series.length > 1 ? <ReturnLine series={r.series} /> : null;
  }
  if (twoPane)
    return (
      <TwoPane
        insetLeft
        left={
          <ScrollView contentContainerStyle={styles.pane}>
            {chips}
            {summary}
          </ScrollView>
        }
        right={chart ? <View style={styles.chartPane}>{chart}</View> : null}
        empty={<View />}
      />
    );
  return (
    <>
      {chips}
      {summary}
      {chart ? <View style={styles.chartBox}>{chart}</View> : null}
    </>
  );
}

function ReadySummary({ r, open, onToggle }: { r: JournalReturns; open: boolean; onToggle: () => void }) {
  const t = useTheme();
  const l = returnsLines(r);
  const twr = formatPct(r.twr ?? null);
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} testID="returns-ready">
      <View accessible accessibilityLabel={returnsSpeech(r)} style={styles.gap}>
        <Text style={{ color: t.muted, fontSize: font.small }}>{returnsHeader(r)}</Text>
        <View style={styles.bigRow}>
          <Text style={[styles.big, { color: changeColor(t, shownSign(r.twr ?? null, twr)) }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {twr}
          </Text>
          <Text style={{ color: t.muted, fontSize: font.small }}>수익률 (시간가중)</Text>
        </View>
        <Text style={{ color: changeColor(t, l.pnlSign), fontSize: font.body, fontWeight: "700" }}>{l.pnl}</Text>
        <Text style={{ color: t.sub, fontSize: font.small }}>{l.values}</Text>
        {l.flows ? <Text style={{ color: t.sub, fontSize: font.small }}>{l.flows}</Text> : null}
        {l.clipped ? <Text style={{ color: t.muted, fontSize: font.small }}>{l.clipped}</Text> : null}
      </View>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel="계산 방법" accessibilityState={{ expanded: open }} style={styles.toggle}>
        <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }}>계산 방법</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={font.small} color={t.accent} />
      </Pressable>
      {open
        ? returnsMethod(r).map((m) => (
            <Text key={m} style={{ color: t.muted, fontSize: font.small }}>
              {`· ${m}`}
            </Text>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { paddingBottom: space.xl, gap: space.sm },
  chartPane: { flex: 1, justifyContent: "center", padding: space.lg },
  chartBox: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  gap: { gap: space.xs },
  bigRow: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: space.sm },
  big: { fontSize: font.hero, fontWeight: "800", fontVariant: ["tabular-nums"] },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xxs, minHeight: touch.min },
  sep: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", marginHorizontal: space.xs },
});
