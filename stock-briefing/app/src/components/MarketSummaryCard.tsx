import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import type { MarketSummary, MarketSummaryData, SummaryIndex } from "@/api/types";
import { formatDateKo, SESSION_LABEL, shownSign } from "@/lib/format";
import {
  basisText,
  cardRows,
  cardSpeech,
  closeBadge,
  closeBadgeWarn,
  holdingsShort,
  holidayText,
  indexValueText,
  md,
  newsTime,
  rateText,
  speakText,
  SUMMARY_NOTE,
  summaryWhen,
  titleText,
  type Seg,
} from "@/lib/marketSummary";
import { sentence, speakRate } from "@/lib/a11y";
import { useNow } from "@/lib/useNow";
import { changeColor, font, fontCap, space, touch, useFontScale, useTheme } from "@/theme";
import { foldBriefings as FB, marketSummary as MS, radius } from "@/tokens";
import { Badge, Card, Muted } from "./ui";

/**
 * 시장 전체 요약 (플래그 marketSummary, AI 문장 없음). 숫자는 서버가 출처 값으로 계산한 그대로이고, 문장은 틀에 채운 것이다.
 *  - MarketSummaryCard: 브리핑 탭 맨 위 카드 (휴대폰·접은 화면). 카드 전체가 누르는 칸 하나, 누르면 상세
 *  - MarketSummaryRow: 넓은 창 목록 맨 위 줄 (계좌 줄 위). 2단이면 오른쪽 칸에 상세(role button), 카드 격자면 전체 화면(role link)
 * '밤사이/오늘'은 볼 때 날짜로 정한다 (자정·주말을 넘겨 보면 날짜로) — 1분마다 다시 본다
 */

/** 줄 조각을 색 있는 글로 (등락은 한국 관례 색, 0 으로 보이는 값은 칠하지 않음) */
export function SegText({ segs, style, numberOfLines, cap }: { segs: Seg[]; style?: StyleProp<TextStyle>; numberOfLines?: number; cap?: number }) {
  const t = useTheme();
  return (
    <Text style={style} numberOfLines={numberOfLines} maxFontSizeMultiplier={cap}>
      {segs.map((s, i) => (
        <Text key={i} style={s.tone !== undefined ? { color: changeColor(t, shownSign(s.tone, s.text)) } : s.muted ? { color: t.muted } : undefined}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** 지수 전일 대비 "+63.01" */
const signedIndex = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${indexValueText(Math.abs(v))}`;

/**
 * 지수 칸: 아침 4칸(등락률 굵게 + 종가), 오후 2칸(등락률 + 종가 · 전일 대비). 받지 못한 칸은 '—'.
 * 휴장이면 이름 아래 줄에 그 값의 거래일('11/25') — 이름 옆에 붙이면 좁은 칸(울트라 411·큰 글씨)에서 날짜가 말줄임으로 잘렸다
 */
function IndexCell({ i, d, compact = false }: { i: SummaryIndex; d: MarketSummaryData; compact?: boolean }) {
  const t = useTheme();
  const day = d.holiday && i.date ? md(i.date) : null;
  const label = sentence([`${i.name}${day ? ` (${day})` : ""}`, i.changeRate === null ? "받지 못함" : speakRate(i.changeRate), i.value !== null && !compact ? indexValueText(i.value) : null]);
  return (
    <View accessible accessibilityLabel={label} style={[compact ? styles.cellSmall : styles.cell, { backgroundColor: compact ? t.bg : t.surfaceAlt }]}>
      <Text style={{ color: t.muted, fontSize: compact ? font.tiny : font.small }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
        {i.name}
      </Text>
      {day ? (
        <Text style={[styles.num, { color: t.muted, fontSize: font.tiny }]} maxFontSizeMultiplier={fontCap.row}>
          {day}
        </Text>
      ) : null}
      {i.changeRate === null ? (
        <Text style={[styles.cellRate, { color: t.muted, fontSize: compact ? font.body : font.h2 }]}>—</Text>
      ) : (
        <Text style={[styles.cellRate, { color: changeColor(t, shownSign(i.changeRate, rateText(i.changeRate))), fontSize: compact ? font.body : font.h2 }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          {rateText(i.changeRate)}
        </Text>
      )}
      {!compact && i.value !== null ? (
        <Text style={[styles.num, { color: t.sub, fontSize: font.tiny }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          {indexValueText(i.value)}
          {d.market === "KR" && i.change !== null ? <Text style={{ color: changeColor(t, shownSign(i.change, indexValueText(Math.abs(i.change)))) }}>{` · ${signedIndex(i.change)}`}</Text> : null}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 브리핑 탭은 체결(약 0.1초)마다 다시 그려지므로 카드는 속성(요약·강조)이 같으면 다시 그리지 않는다 (React.memo).
 * '오늘/밤사이'는 안에서 1분마다 다시 본다
 */
export const MarketSummaryCard = React.memo(function MarketSummaryCard({ summary, selected = false }: { summary: MarketSummary; /** 넓은 창에서 보던 요약 (접고 펴기 이어 보기) */ selected?: boolean }) {
  const t = useTheme();
  const view = new Date(useNow(60_000));
  const d = summary.data;
  const failed = summary.status === "failed" || !d;
  const when = `${formatDateKo(summary.date)} ${SESSION_LABEL[summary.session]}`;
  return (
    <Card style={selected ? { borderLeftWidth: FB.selBar, borderLeftColor: t.accent, paddingLeft: space.lg - FB.selBar } : undefined}>
      <Pressable
        onPress={() => router.push(`/briefings/market/${summary.id}`)}
        accessibilityRole="link"
        accessibilityLabel={cardSpeech(summary, view)}
        {...(selected ? { accessibilityState: { selected: true } } : {})}
        style={styles.press}
      >
        <View style={styles.head}>
          <Ionicons name="globe-outline" size={18} color={t.accent} />
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }}>{d ? titleText(d, view) : "시장 요약"}</Text>
          {d?.holiday ? <Badge tone="warn">휴장</Badge> : null}
          {d?.phase === "intraday" ? <Badge tone="warn">장중</Badge> : null}
          <Muted style={styles.when}>{when}</Muted>
          <Ionicons name="chevron-forward" size={18} color={t.muted} />
        </View>
        {failed ? (
          <View style={styles.failed}>
            <Badge tone="bad">생성 실패</Badge>
            <Text style={{ color: t.danger, fontSize: font.small, flexShrink: 1 }}>{summary.summary}</Text>
          </View>
        ) : (
          <CardBody d={d} view={view} />
        )}
        <Muted style={{ fontSize: font.tiny }}>{SUMMARY_NOTE}</Muted>
      </Pressable>
    </Card>
  );
});

function CardBody({ d, view }: { d: MarketSummaryData; view: Date }) {
  const t = useTheme();
  // 이름표 칸 폭은 글자 배율만큼 늘린다 (큰 글씨에서 '환율·금리'가 '환율·금 / 리'로 쪼개지지 않게)
  const labelW = Math.round(MS.labelW * useFontScale(fontCap.row));
  const banner = holidayText(d, view);
  return (
    <>
      <Muted>{basisText(d, view)}</Muted>
      {banner ? (
        <View style={[styles.banner, { backgroundColor: t.surfaceAlt }]}>
          <Ionicons name="calendar-outline" size={16} color={t.gold} />
          <Text style={{ color: t.ink, fontSize: font.body, flexShrink: 1 }}>{banner}</Text>
        </View>
      ) : null}
      <View style={styles.cells}>
        {d.indices.map((i) => (
          <IndexCell key={i.code} i={i} d={d} />
        ))}
      </View>
      {cardRows(d, view).map((r) => (
        <View key={r.kind} style={styles.row}>
          <Text style={[styles.label, { width: labelW, color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
            {r.label}
          </Text>
          <View style={styles.rowBody}>
            {r.kind === "news" ? (
              <>
                {r.items.map((n) => (
                  <Text key={n.url} style={{ color: t.ink, fontSize: font.body }} numberOfLines={1}>
                    <Text style={{ color: t.sub }}>
                      {n.outlet} {newsTime(n, d.date)}{" "}
                    </Text>
                    {n.title}
                  </Text>
                ))}
                {r.more ? <Muted>외 {r.more}건 (상세에서 원문 제목·링크)</Muted> : null}
              </>
            ) : (
              r.lines.map((segs, i) => <SegText key={i} segs={segs} style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.5 }} />)
            )}
          </View>
        </View>
      ))}
    </>
  );
}

/**
 * 넓은 창 목록 맨 위 줄 (계좌 줄 위): 1줄 제목 · 마감일 배지 · 시각 › / 2줄 지수 작은 칸 4개 또는 2개 / 3줄 '내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7'
 */
export function MarketSummaryRow({ summary, selected, onPress, role }: { summary: MarketSummary; selected: boolean; onPress: () => void; role: "button" | "link" }) {
  const t = useTheme();
  const view = new Date(useNow(60_000));
  const d = summary.data;
  const failed = summary.status === "failed" || !d;
  const hold = d ? holdingsShort(d.holdings) : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={cardSpeech(summary, view)}
      accessibilityState={role === "button" ? { selected } : selected ? { selected: true } : undefined}
      style={({ pressed }) => [styles.listRow, { borderBottomColor: t.line, backgroundColor: selected || pressed ? t.surfaceAlt : t.surface }]}
    >
      {selected ? <View style={[styles.selBar, { backgroundColor: t.accent }]} /> : null}
      <View style={styles.rowHead}>
        <Ionicons name="globe-outline" size={18} color={t.accent} />
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flexShrink: 1 }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          {d ? titleText(d, view) : "시장 요약"}
        </Text>
        {d && !failed ? <Badge tone={closeBadgeWarn(d) ? "warn" : "neutral"}>{closeBadge(d)}</Badge> : null}
        <Text style={[styles.rowWhen, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
          {summaryWhen(summary)}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={t.muted} />
      </View>
      {failed ? (
        <Text style={{ color: t.danger, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
          생성 실패 · {summary.summary}
        </Text>
      ) : (
        <>
          <View style={styles.cells}>
            {d.indices.map((i) => (
              <IndexCell key={i.code} i={i} d={d} compact />
            ))}
          </View>
          {hold ? (
            <Text style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row} accessibilityLabel={speakText(hold)}>
              {hold}
            </Text>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  press: { minHeight: touch.min, gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  when: { flexGrow: 1, textAlign: "right" },
  failed: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md },
  cells: { flexDirection: "row", gap: space.sm },
  cell: { flex: 1, minWidth: 0, gap: space.xxs, paddingHorizontal: space.sm, paddingVertical: space.sm, borderRadius: radius.md },
  cellSmall: { flex: 1, minWidth: 0, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm },
  cellRate: { fontWeight: "700", fontVariant: ["tabular-nums"] },
  num: { fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  label: { fontSize: font.small, lineHeight: font.body * 1.5 },
  rowBody: { flex: 1, minWidth: 0, gap: space.xxs },
  listRow: { minHeight: MS.rowMinH, justifyContent: "center", gap: space.xs, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  selBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: FB.selBar },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.s },
  rowWhen: { marginLeft: "auto", fontSize: font.small, flexShrink: 0 },
});
