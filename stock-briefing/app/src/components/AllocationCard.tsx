import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { arcPath, chartSummary, donutArcs, pctText, sliceLabel, type AllocationChart, type Slice } from "@/lib/allocation";
import { formatWon } from "@/lib/format";
import { isBigText } from "@/lib/textScale";
import { font, fontCap, radius, space, useFontScale, useTheme, type Theme } from "@/theme";
import { TableHead } from "./ui";

/** 원 지름·고리 두께·조각 사이 틈 (dp). 틈은 바탕색이라 닿는 조각이 선 없이 갈린다 */
const DONUT = 148;
const RING = 22;
const GAP = 2;
/** 범례 색 네모 */
const SWATCH = 10;
/** 범례 숫자 열 폭 (100%): 금액 "1,234,567,890원" · 비중 "100.0%". 큰 글씨에서는 종목 줄처럼 배율의 1/4 만큼 넓히고, 그래도 넘치면 글자를 줄인다 */
const AMOUNT_W = 116;
const PCT_W = 56;

/** 조각 색: 앞 7개는 차례대로, 그 뒤와 '기타'는 회색 */
export function sliceColor(t: Theme, s: Pick<Slice, "slot">): string {
  return s.slot === null ? t.chart.pieOther : (t.chart.pie[s.slot] ?? t.chart.pieOther);
}

/**
 * 비중 차트 한 장: 제목 → 원(가운데에 가장 큰 조각) → 범례 표(이름 · 원화 평가금액 · 비중).
 * 화면 읽기는 원을 "국내 62.3%, 해외 37.7%" 한 문장으로, 범례는 줄마다 한 문장으로 읽는다. 글자는 글자색만 쓰고 색은 네모·조각에만 칠한다
 */
export function AllocationCard({ chart }: { chart: AllocationChart }) {
  const t = useTheme();
  const scale = useFontScale(fontCap.row);
  const big = isBigText(scale);
  const k = 1 + (scale - 1) / 4;
  const r = (DONUT - RING) / 2;
  const arcs = donutArcs(chart.slices.map((s) => s.won), GAP / r);
  // 가운데에는 가장 큰 조각 ('기타'는 여러 종목을 모은 것이라 이름 있는 조각이 있으면 그쪽)
  const named = chart.slices.filter((s) => !s.other);
  const lead = (named.length ? named : chart.slices).reduce<Slice | null>((a, s) => (!a || s.won > a.won ? s : a), null);
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
      <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
        {chart.title}
      </Text>
      <View accessible accessibilityRole="image" accessibilityLabel={chartSummary(chart)} style={styles.donut}>
        <Svg width={DONUT} height={DONUT}>
          {arcs.map((a, i) => {
            const s = chart.slices[i]!;
            return a ? <Path key={s.key} d={arcPath(DONUT / 2, DONUT / 2, r, a)} stroke={sliceColor(t, s)} strokeWidth={RING} fill="none" /> : null;
          })}
        </Svg>
        {lead ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <Text style={[styles.centerText, { color: t.muted, fontSize: font.small }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
              {lead.label}
            </Text>
            <Text style={[styles.centerText, styles.num, { color: t.ink, fontSize: font.h2, fontWeight: "700" }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
              {pctText(lead.pct)}
            </Text>
          </View>
        ) : null}
      </View>
      <View>
        <TableHead style={styles.legendHead}>
          <Text style={[styles.headText, { color: t.muted, flex: 1, textAlign: "left" }]} maxFontSizeMultiplier={fontCap.row}>
            이름
          </Text>
          <Text style={[styles.headText, { color: t.muted, width: AMOUNT_W * k }]} maxFontSizeMultiplier={fontCap.row}>
            평가금액
          </Text>
          <Text style={[styles.headText, { color: t.muted, width: PCT_W * k }]} maxFontSizeMultiplier={fontCap.row}>
            비중
          </Text>
        </TableHead>
        {chart.slices.map((s, i) => (
          <View key={s.key} accessible accessibilityLabel={sliceLabel(s)} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line }]}>
            <View style={[styles.swatch, { backgroundColor: sliceColor(t, s) }]} />
            <Text style={[styles.name, { color: t.ink }]} numberOfLines={big ? 2 : 1} maxFontSizeMultiplier={fontCap.row}>
              {s.label}
              {s.count > 1 ? <Text style={{ color: t.muted }}>{` · ${s.count}종목`}</Text> : null}
            </Text>
            <Text style={[styles.num, styles.cell, { color: t.sub, width: AMOUNT_W * k }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
              {formatWon(s.won)}
            </Text>
            <Text style={[styles.num, styles.cell, { color: t.ink, width: PCT_W * k, fontWeight: "700" }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
              {pctText(s.pct)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingTop: space.lg, gap: space.md },
  title: { fontSize: font.h2, fontWeight: "700", paddingHorizontal: space.lg },
  donut: { width: DONUT, height: DONUT, alignSelf: "center" },
  center: { alignItems: "center", justifyContent: "center", pointerEvents: "none" },
  // 가운데 구멍(지름 DONUT - 2·RING) 안에만 쓴다
  centerText: { width: DONUT - 2 * RING - 2 * space.sm, textAlign: "center" },
  legendHead: { gap: space.sm },
  headText: { fontSize: font.tiny, textAlign: "right" },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: radius.sm / 2 },
  name: { flex: 1, fontSize: font.small },
  cell: { fontSize: font.small, textAlign: "right" },
  num: { fontVariant: ["tabular-nums"] },
});
