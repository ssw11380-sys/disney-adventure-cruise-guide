import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type TextStyle } from "react-native";
import type { MarketSummary, MarketSummaryData, SummaryIndex, SummaryNews } from "@/api/types";
import { formatDateKo, SESSION_LABEL, shownSign } from "@/lib/format";
import {
  basisText,
  cardRows,
  cardSpeech,
  chunkSegs,
  closeBadge,
  closeBadgeWarn,
  fitNewsLine,
  holdingsShort,
  holidayText,
  indexCellCols,
  indexValueText,
  md,
  NEWS_OUTLET_SEP,
  rateText,
  speakText,
  SUMMARY_NOTE,
  summaryWhen,
  titleText,
  wordGap,
  type Seg,
} from "@/lib/marketSummary";
import { useNow } from "@/lib/useNow";
import { listPaneWidth } from "@/lib/windowClass";
import { changeColor, font, fontCap, space, touch, useFontScale, useTheme } from "@/theme";
import { foldBriefings as FB, marketSummary as MS, radius } from "@/tokens";
import { Badge, Card, Muted } from "./ui";

/**
 * 시장 전체 요약 (플래그 marketSummary, AI 문장 없음). 숫자는 서버가 출처 값으로 계산한 그대로이고, 문장은 틀에 채운 것이다.
 *  - MarketSummaryCard: 브리핑 탭 맨 위 카드 (휴대폰·접은 화면). 카드 전체가 누르는 칸 하나, 누르면 상세
 *  - MarketSummaryRow: 넓은 창 목록 맨 위 줄 (계좌 줄 위). 2단이면 오른쪽 칸에 상세(role button), 카드 격자면 전체 화면(role link)
 * '밤사이/오늘'은 볼 때 날짜로 정한다 (자정·주말을 넘겨 보면 날짜로) — 1분마다 다시 본다
 */

/**
 * 줄 조각을 색 있는 글로 (등락은 한국 관례 색, 0 으로 보이는 값은 칠하지 않음).
 * 줄바꿈 덩어리(chunkSegs)마다 한 줄짜리 글로 그려 flexWrap 줄에 놓는다 — 줄은 덩어리 사이(띄어쓰기 자리)에서만 바뀌어
 * 한글 낱말이 음절 사이에서 갈라지지 않는다('비 / 슷 2'·'미 10년 / 물'·'(마이크로소프 / 트'·'지수와 차 / 이' 막기). 글자는 바꾸지 않는다.
 * 덩어리 사이 간격은 그 글자 크기의 띄어쓰기 폭(wordGap). 덩어리가 칸보다 길 때만(아주 긴 종목 이름) 그 안에서 줄이 바뀐다.
 * speak: 줄 전체를 화면 읽기 한 문장으로 (덩어리마다 따로 읽히지 않게 — 기호는 말로, speakText). label 을 주면 그 문장으로.
 * 카드·요약 칸처럼 바깥이 이미 한 문장으로 읽히는 곳에서는 둘 다 쓰지 않는다. end = 오른쪽 정렬 (표의 숫자 칸 자리)
 */
export function SegText({ segs, style, cap, speak = false, label, end = false }: { segs: Seg[]; style?: TextStyle; cap?: number; speak?: boolean; label?: string; end?: boolean }) {
  const t = useTheme();
  const scale = useFontScale(cap);
  const gap = wordGap(style?.fontSize ?? font.body, scale);
  const said = label ?? (speak ? speakText(segs.map((s) => s.text).join("").trim()) : null);
  const a11y = said !== null ? { accessible: true, accessibilityLabel: said } : {};
  return (
    <View testID="words" style={[styles.words, end ? styles.wordsEnd : null, { columnGap: gap }]} {...a11y}>
      {chunkSegs(segs).map((c, i) => (
        <Text key={i} style={[style, styles.chunk]} maxFontSizeMultiplier={cap}>
          {c.map((s, j) =>
            s.tone === undefined && !s.muted ? (
              s.text
            ) : (
              <Text key={j} style={s.tone !== undefined ? { color: changeColor(t, shownSign(s.tone, s.text)) } : { color: t.muted }}>
                {s.text}
              </Text>
            ),
          )}
        </Text>
      ))}
    </View>
  );
}

/** 한 가지 색 글을 낱말 단위로 줄바꿈해 그린다 (SegText 와 같다 — 기준 줄·휴장 배너·안내 문단) */
export function Words({ text, ...rest }: { text: string; style?: TextStyle; cap?: number; speak?: boolean; label?: string; end?: boolean }) {
  return <SegText segs={[{ text }]} {...rest} />;
}

/** 흐린 글 줄 높이 (공용 Muted 와 같다) */
export const MUTED_LH = 17;

/** 지수 전일 대비 "+63.01" */
const signedIndex = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${indexValueText(Math.abs(v))}`;

/** 숫자 칸: 한 줄, 칸보다 길면 글자를 줄여 넣는다 (말줄임 없이 — 안드로이드). 배치(indexCellCols)가 먼저 칸을 넓혀 두므로 거의 쓰이지 않는 마지막 안전판 */
const FIT_NUM = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6, maxFontSizeMultiplier: fontCap.row } as const;

/**
 * 지수 칸 묶음: 칸 폭이 등락률·종가 글자보다 좁으면(울트라 411·큰 글씨) 4칸을 2×2 로 (indexCellCols). 폭은 실제로 잰 값(onLayout),
 * 재기 전 첫 그림은 guess(창 폭으로 어림)
 */
function IndexCells({ d, compact = false, guess }: { d: MarketSummaryData; compact?: boolean; guess: number }) {
  const scale = useFontScale(fontCap.row);
  const [w, setW] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const x = Math.round(e.nativeEvent.layout.width);
    if (x > 0) setW((p) => (p === x ? p : x));
  }, []);
  const cols = indexCellCols(d, w ?? guess, scale, compact);
  const rows: SummaryIndex[][] = [];
  for (let n = 0; n < d.indices.length; n += cols) rows.push(d.indices.slice(n, n + cols));
  return (
    <View style={styles.cellRows} onLayout={onLayout}>
      {rows.map((r, n) => (
        <View key={n} style={styles.cells}>
          {r.map((i) => (
            <IndexCell key={i.code} i={i} d={d} compact={compact} />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * 지수 칸: 아침 4칸(등락률 굵게 + 종가), 오후 2칸(등락률 + 종가 · 전일 대비). 받지 못한 칸은 '—'.
 * 휴장이면 이름 아래 줄에 그 값의 거래일('11/25') — 이름 옆에 붙이면 좁은 칸(울트라 411·큰 글씨)에서 날짜가 말줄임으로 잘렸다.
 * 화면 읽기: 칸은 카드·목록 줄(누르는 칸 하나) 안에만 있고 그 칸의 문장(cardSpeech)이 지수를 이미 읽으므로 칸마다 따로 멈추지 않게
 * accessible·이름을 두지 않는다 (안드로이드는 accessible 을 focusable 로 바꿔 TalkBack 이 같은 지수를 한 번 더 읽었다)
 */
function IndexCell({ i, d, compact = false }: { i: SummaryIndex; d: MarketSummaryData; compact?: boolean }) {
  const t = useTheme();
  const day = d.holiday && i.date ? md(i.date) : null;
  return (
    <View testID="index-cell" style={[compact ? styles.cellSmall : styles.cell, { backgroundColor: compact ? t.bg : t.surfaceAlt }]}>
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
        <Text style={[styles.cellRate, { color: changeColor(t, shownSign(i.changeRate, rateText(i.changeRate))), fontSize: compact ? font.body : font.h2 }]} {...FIT_NUM}>
          {rateText(i.changeRate)}
        </Text>
      )}
      {!compact && i.value !== null ? (
        <Text style={[styles.num, { color: t.sub, fontSize: font.tiny }]} {...FIT_NUM}>
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
        accessibilityLabel={cardSpeech(summary, view, { card: true })}
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
            <View style={styles.grow}>
              <Words text={summary.summary} style={{ color: t.danger, fontSize: font.small }} />
            </View>
          </View>
        ) : (
          <CardBody d={d} view={view} />
        )}
        <Words text={SUMMARY_NOTE} style={{ color: t.muted, fontSize: font.tiny, lineHeight: MUTED_LH }} />
      </Pressable>
    </Card>
  );
});

function CardBody({ d, view }: { d: MarketSummaryData; view: Date }) {
  const t = useTheme();
  // 이름표 칸 폭은 글자 배율만큼 늘린다 (큰 글씨에서 '환율·금리'가 '환율·금 / 리'로 쪼개지지 않게)
  const labelW = Math.round(MS.labelW * useFontScale(fontCap.row));
  // 카드는 창 폭 그대로(좌우 여백 space.lg) — 지수 칸 배치의 첫 어림
  const cellsGuess = useWindowDimensions().width - 2 * space.lg;
  // 뉴스 줄 폭의 첫 어림: 카드 안쪽 폭 − 이름표 칸 − 칸 사이 간격 (재면 그 값으로)
  const newsGuess = cellsGuess - labelW - space.sm;
  const banner = holidayText(d, view);
  return (
    <>
      <Words text={basisText(d, view)} style={{ color: t.muted, fontSize: font.small, lineHeight: MUTED_LH }} />
      {banner ? (
        <View style={[styles.banner, { backgroundColor: t.surfaceAlt }]}>
          <Ionicons name="calendar-outline" size={16} color={t.gold} />
          <View style={styles.grow}>
            <Words text={banner} style={{ color: t.ink, fontSize: font.body }} />
          </View>
        </View>
      ) : null}
      <IndexCells d={d} guess={cellsGuess} />
      {cardRows(d, view).map((r) => (
        <View key={r.kind} style={styles.row}>
          <Text style={[styles.label, { width: labelW, color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
            {r.label}
          </Text>
          <View style={styles.rowBody}>
            {r.kind === "news" ? (
              <NewsLines items={r.items} more={r.more} guess={newsGuess} />
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
 * 카드 뉴스 칸 (8차 검토 · SS5/SS11): 제목마다 한 줄. 줄 앞에 흐린 언론사 머리('연합뉴스 · ')를 붙여 누가 쓴 제목인지 카드에서도 보이게 한다 —
 * 머리를 붙이고도 제목이 다 들어가거나 12자 이상 남을 때만, 아니면 제목만 (fitNewsLine). 시각은 상세 뉴스 칸에 — 화면 읽기는 카드 문장(cardSpeech)이
 * 언론사·시각·원문 제목 전체를 읽는다 (그대로).
 * 줄 폭을 재서(onLayout, 재기 전은 guess) 들어가지 않는 제목은 잘라 보낸다 — 한 줄 말줄임(numberOfLines)에 맡기면 글자 단위로 잘려
 * '나스닥 0.4…'·'2만…'처럼 숫자 가운데서 끊겼다. numberOfLines 는 어림이 빗나갈 때의 안전판이고, 안드로이드에서는 그때 글자를 조금 줄여 넣는다
 * (adjustsFontSizeToFit — 기기 글꼴이 어림보다 넓어도 숫자 가운데서 잘리지 않게). 아주 좁은 칸(큰 글씨 + 좁은 창)에서 제목이 한 줄에
 * 8자도 안 들어가면 그 제목만 두 줄로 두고(머리 없이) 둘째 제목은 뺀다 ('외 N건'으로 — 카드 줄 수를 늘리지 않게)
 */
function NewsLines({ items, more, guess }: { items: SummaryNews[]; more: number; guess: number }) {
  const t = useTheme();
  const scale = useFontScale();
  const [w, setW] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const x = Math.floor(e.nativeEvent.layout.width);
    if (x > 0) setW((p) => (p === x ? p : x));
  }, []);
  const fits = items.map((n) => fitNewsLine(n, w ?? guess, font.body, scale));
  const narrow = fits.some((f) => f.lines === 2);
  const shown = narrow ? items.slice(0, 1) : items;
  const rest = more + items.length - shown.length;
  // 보이는 줄마다 언론사가 있으면 아래 안내에서 '언론사'를 뺀다
  const allOutlets = shown.every((_, i) => fits[i]!.outlet !== null);
  return (
    <View style={styles.newsLines} onLayout={onLayout}>
      {shown.map((n, i) => (
        <Text key={n.url} testID="news-line" style={{ color: t.ink, fontSize: font.body }} numberOfLines={fits[i]!.lines} adjustsFontSizeToFit minimumFontScale={0.85}>
          {fits[i]!.outlet ? (
            <Text testID="news-outlet" style={{ color: t.muted }}>
              {`${fits[i]!.outlet}${NEWS_OUTLET_SEP}`}
            </Text>
          ) : null}
          {fits[i]!.text}
        </Text>
      ))}
      <Words text={`${rest ? `외 ${rest}건 · ` : ""}${allOutlets ? "시각·원문은 상세에서" : "언론사·시각·원문은 상세에서"}`} style={{ color: t.muted, fontSize: font.small, lineHeight: MUTED_LH }} />
    </View>
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
  // 지수 작은 칸 배치의 첫 어림: 2단 왼쪽 목록(button)은 목록 폭, 카드 격자(link)는 창 폭 — 줄의 좌우 안쪽 여백을 뺀다
  const win = useWindowDimensions();
  const cellsGuess = (role === "button" ? listPaneWidth(win.fontScale || 1) : win.width) - space.lg - space.md;
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
        <Words text={`생성 실패 · ${summary.summary}`} style={{ color: t.danger, fontSize: font.small }} cap={fontCap.row} />
      ) : (
        <>
          <IndexCells d={d} compact guess={cellsGuess} />
          {/* 줄 전체의 화면 읽기 문장은 누르는 칸(cardSpeech)이 읽는다 */}
          {hold ? <Words text={hold} style={{ color: t.sub, fontSize: font.small }} cap={fontCap.row} /> : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  press: { minHeight: touch.min, gap: space.sm },
  // 줄바꿈 덩어리 줄: 덩어리(한 줄짜리 글)를 옆으로 놓고 넘치면 다음 줄로 — 간격은 띄어쓰기 폭(columnGap, 그릴 때 넣는다)
  words: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" },
  wordsEnd: { justifyContent: "flex-end" },
  // 덩어리가 칸보다 길 때만 칸 폭으로 줄여 그 안에서 줄을 바꾼다 (보통은 한 줄 그대로)
  chunk: { flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  when: { flexGrow: 1, textAlign: "right" },
  failed: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md },
  // 칸 사이 간격·안쪽 여백은 배치 계산(indexCellCols)과 같은 토큰
  cellRows: { gap: MS.cellGap },
  cells: { flexDirection: "row", gap: MS.cellGap },
  cell: { flex: 1, minWidth: 0, gap: space.xxs, paddingHorizontal: MS.cellPadX, paddingVertical: space.sm, borderRadius: radius.md },
  cellSmall: { flex: 1, minWidth: 0, paddingHorizontal: MS.cellPadX, paddingVertical: space.xs, borderRadius: radius.sm },
  cellRate: { fontWeight: "700", fontVariant: ["tabular-nums"] },
  num: { fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  label: { fontSize: font.small, lineHeight: font.body * 1.5 },
  rowBody: { flex: 1, minWidth: 0, gap: space.xxs },
  newsLines: { gap: space.xxs },
  listRow: { minHeight: MS.rowMinH, justifyContent: "center", gap: space.xs, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  selBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: FB.selBar },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.s },
  rowWhen: { marginLeft: "auto", fontSize: font.small, flexShrink: 0 },
});
