import React from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Path, Svg } from "react-native-svg";
import { arcPath, chartSummary, donutArcs, pctText, sliceLabel, type AllocationChart, type Slice } from "@/lib/allocation";
import { formatWon } from "@/lib/format";
import { BESIDE, LEGEND_SWATCH, legendCols, WIDE_CARD } from "@/lib/foldScreens";
import { isBigText } from "@/lib/textScale";
import { font, fontCap, radius, space, useFontScale, useTheme, type Theme } from "@/theme";
import { TableHead } from "./ui";

/** 원 지름·고리 두께·조각 사이 틈 (dp). 틈은 바탕색이라 닿는 조각이 선 없이 갈린다 */
const DONUT = 148;
const RING = 22;
const GAP = 2;
/** 범례 색 네모 */
const SWATCH = LEGEND_SWATCH;
/** 범례 숫자 열 폭 (100%): 금액 "1,234,567,890원" · 비중 "100.0%". 큰 글씨에서는 종목 줄처럼 배율의 1/4 만큼 넓히고, 그래도 넘치면 글자를 줄인다 */
const AMOUNT_W = 116;
const PCT_W = 56;
/** 숫자 칸: 좁으면 이 비율까지 줄여 한 줄에 (말줄임 없이) */
const FIT = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6, maxFontSizeMultiplier: fontCap.row } as const;

/** 조각 색: 앞 7개는 차례대로, 그 뒤와 '기타'는 회색 */
export function sliceColor(t: Theme, s: Pick<Slice, "slot">): string {
  return s.slot === null ? t.chart.pieOther : (t.chart.pie[s.slot] ?? t.chart.pieOther);
}

/** 넓은 창 카드 모양 (3-42, lib/foldScreens allocationGrid): 원 지름, 원 옆에 범례를 둘지 */
export interface AllocationCardWide {
  donut: number;
  beside: boolean;
}

/**
 * 원 차트: 조각 + 가운데에 가장 큰 조각 이름·비중. 화면 읽기는 원을 "국내 62.3%, 해외 37.7%" 한 문장으로.
 * size 는 지름 (휴대폰 화면은 DONUT 148)
 */
function Donut({ chart, size, style, label }: { chart: AllocationChart; size: number; style: StyleProp<ViewStyle>; label?: string }) {
  const t = useTheme();
  const r = (size - RING) / 2;
  const arcs = donutArcs(chart.slices.map((s) => s.won), GAP / r);
  // 가운데에는 가장 큰 조각 ('기타'는 여러 종목을 모은 것이라 이름 있는 조각이 있으면 그쪽)
  const named = chart.slices.filter((s) => !s.other);
  const lead = (named.length ? named : chart.slices).reduce<Slice | null>((a, s) => (!a || s.won > a.won ? s : a), null);
  // 가운데 구멍(지름 size - 2·RING) 안에만 쓴다
  const centerW = size === DONUT ? styles.centerText : [styles.centerText, { width: size - 2 * RING - 2 * space.sm }];
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label ?? chartSummary(chart)} style={style}>
      <Svg width={size} height={size}>
        {arcs.map((a, i) => {
          const s = chart.slices[i]!;
          return a ? <Path key={s.key} d={arcPath(size / 2, size / 2, r, a)} stroke={sliceColor(t, s)} strokeWidth={RING} fill="none" /> : null;
        })}
      </Svg>
      {lead ? (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={[centerW, { color: t.muted, fontSize: font.small }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
            {lead.label}
          </Text>
          <Text style={[centerW, styles.num, { color: t.ink, fontSize: font.h2, fontWeight: "700" }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
            {pctText(lead.pct)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * 비중 차트 한 장: 제목 → 원(가운데에 가장 큰 조각) → 범례 표(이름 · 원화 평가금액 · 비중).
 * 화면 읽기는 원을 "국내 62.3%, 해외 37.7%" 한 문장으로, 범례는 줄마다 한 문장으로 읽는다. 글자는 글자색만 쓰고 색은 네모·조각에만 칠한다.
 * wide(넓은 창, 3-42): 2×2 격자의 한 칸. 제목을 범례 머리에 합치고(카드 높이를 줄여 4장이 한 화면에), 원 옆(또는 아래)에 촘촘한 범례
 */
export function AllocationCard({ chart, wide }: { chart: AllocationChart; wide?: AllocationCardWide }) {
  const t = useTheme();
  const scale = useFontScale(fontCap.row);
  const big = isBigText(scale);
  if (wide) return <WideCard chart={chart} wide={wide} scale={scale} />;
  const k = 1 + (scale - 1) / 4;
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
      <Text style={[styles.title, { color: t.ink }]} accessibilityRole="header">
        {chart.title}
      </Text>
      <Donut chart={chart} size={DONUT} style={styles.donut} />
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

/**
 * 넓은 창 카드: 범례 머리 첫 칸이 곧 차트 제목(화면 읽기 머리글), 줄은 위아래 여백을 줄인 한 줄.
 * beside 면 [원 | 범례], 아니면 원 아래 범례. 이름은 한 줄(넘치면 이름만 말줄임), 종목 수는 이름과 떼어 줄이지 않고, 금액·비중은 말줄임 없이 글자를 줄인다.
 * 화면 읽기는 원을 제목보다 먼저 읽으므로 원 요약 앞에 차트 제목을 붙인다 ("업종 원 차트, 반도체 36.8%, …")
 */
function WideCard({ chart, wide, scale }: { chart: AllocationChart; wide: AllocationCardWide; scale: number }) {
  const t = useTheme();
  const col = legendCols(scale);
  const donutLabel = `${chart.title} 원 차트, ${chartSummary(chart)}`;
  const legend = (
    <View style={styles.wideLegend}>
      <TableHead style={wide.beside ? [styles.wideHead, styles.besideRow] : styles.wideHead}>
        <Text style={[styles.wideTitle, { color: t.ink }]} accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          {chart.title}
        </Text>
        <Text style={[styles.headText, { color: t.muted, width: col.amount }]} {...FIT}>
          평가금액
        </Text>
        <Text style={[styles.headText, { color: t.muted, width: col.pct }]} {...FIT}>
          비중
        </Text>
      </TableHead>
      {chart.slices.map((s, i) => (
        <View key={s.key} accessible accessibilityLabel={sliceLabel(s)} style={[styles.wideRow, wide.beside && styles.besideRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line }]}>
          <View style={[styles.swatch, { backgroundColor: sliceColor(t, s) }]} />
          {/* 이름만 줄어들고(말줄임), 종목 수는 떼어 두어 잘리지 않는다 */}
          <View style={styles.wideName}>
            <Text style={[styles.wideNameText, { color: t.ink }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
              {s.label}
            </Text>
            {s.count > 1 ? (
              <Text style={[styles.wideCount, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
                {` · ${s.count}종목`}
              </Text>
            ) : null}
          </View>
          <Text style={[styles.num, styles.cell, { color: t.sub, width: col.amount }]} {...FIT}>
            {formatWon(s.won)}
          </Text>
          <Text style={[styles.num, styles.cell, { color: t.ink, width: col.pct, fontWeight: "700" }]} {...FIT}>
            {pctText(s.pct)}
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <View style={[styles.wideCard, { backgroundColor: t.surface, borderColor: t.line }]}>
      {wide.beside ? (
        <View style={styles.beside}>
          <Donut chart={chart} size={wide.donut} label={donutLabel} style={[styles.donutWide, { width: wide.donut, height: wide.donut }]} />
          {legend}
        </View>
      ) : (
        <>
          <Donut chart={chart} size={wide.donut} label={donutLabel} style={[styles.donutWide, styles.donutTop, { width: wide.donut, height: wide.donut }]} />
          {legend}
        </>
      )}
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
  // 넓은 창 (3-42): 격자 한 칸을 채우고(같은 줄 두 카드 높이를 맞춘다), 위아래 여백을 줄인다
  // 위아래 여백·원과 범례 사이 간격은 lib/foldScreens WIDE_CARD 와 같다 (남는 높이로 원을 키우는 계산이 이 값을 쓴다)
  wideCard: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: WIDE_CARD.padV, gap: WIDE_CARD.gap },
  // 원 옆 범례: 여백은 lib/foldScreens BESIDE 와 같다 (원 지름 계산이 이 값을 쓴다)
  beside: { flexDirection: "row", alignItems: "flex-start", gap: BESIDE.gap, paddingLeft: BESIDE.padL },
  besideRow: { paddingLeft: BESIDE.rowL, paddingRight: BESIDE.rowR },
  donutWide: { flexShrink: 0 },
  donutTop: { alignSelf: "center" },
  wideLegend: { flex: 1, minWidth: 0 },
  wideHead: { gap: space.sm },
  wideTitle: { flex: 1, fontSize: font.body, fontWeight: "700" },
  wideRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.xs },
  // 범례 이름 칸: 이름(줄어듦) + 종목 수(줄지 않음)
  wideName: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline" },
  wideNameText: { flexShrink: 1, fontSize: font.small },
  wideCount: { flexShrink: 0, fontSize: font.small },
});

