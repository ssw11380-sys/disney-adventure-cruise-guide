import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type TextStyle } from "react-native";
import { useFeature, useFeatures, useMarketSummary } from "@/api/hooks";
import type { CompareRow, HoldingsCompare, MarketSummary, MarketSummaryData, SummaryEvent } from "@/api/types";
import { BriefingSplit, type BodyLayout } from "@/components/BriefingBody";
import { StaleBanner } from "@/components/Freshness";
import { Screen } from "@/components/Screen";
import { CardsSkeleton } from "@/components/Skeleton";
import { Badge, Button, Card, Empty, ErrorView, Muted, SectionTitle, TableHead } from "@/components/ui";
import { sentence, speakRate } from "@/lib/a11y";
import { gated } from "@/lib/features";
import { formatDateKo, shownSign } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import {
  basisText,
  bodyWidthGuess,
  eventText,
  GROUP_SPEECH,
  GROUP_TITLE,
  holdingsAuxSegs,
  holdingsSegs,
  holdingsTableMode,
  indexSourceTime,
  indexValueText,
  indicesTableMode,
  md,
  mdw,
  newsLink,
  newsTime,
  ppText,
  rateText,
  SIMILAR_NOTE,
  speakPointMove,
  speakText,
  summarySegLines,
  titleText,
  wonChangeText,
  wonText,
  yieldChangeText,
  yieldSourceText,
  yieldValueText,
  type Seg,
} from "@/lib/marketSummary";
import { useNow } from "@/lib/useNow";
import { changeColor, font, fontCap, space, touch, useFontScale, useTheme, type Theme } from "@/theme";
import { marketSummary as MS, radius } from "@/tokens";
import { MUTED_LH, SegText, Words } from "./MarketSummaryCard";

/**
 * 시장 전체 요약 상세 (플래그 marketSummary, 주소 /briefings/market/<id>). AI 문장 없이 숫자와 언론사 제목 원문만.
 * 순서: 제목·기준 → 요약 5~6줄 → 내 보유 종목과 지수(사용자 질문 '다 같이 빠졌나?'에 바로 답하게 지수 표보다 위) → 주요 지수 → 업종 → 환율·금리 → 일정 → 뉴스 → 만든 기준·고지.
 * 배치 (BriefingBody·AccountBriefingBody 와 같은 이름): stack = 폰, pane = 브리핑 탭 2단 오른쪽 칸, split = 넓은 창 전체 화면 두 칸
 * 플래그가 꺼져 있으면 아무것도 불러오지 않는다
 */
export function MarketSummaryBody({ numId, layout, title }: { numId: number | null; layout: BodyLayout; title?: (s: MarketSummary) => React.ReactNode }) {
  const on = useFeature("marketSummary", false); // 새 기능: 서버가 켤 때만
  const flags = useFeatures();
  const q = useMarketSummary(numId ?? 0, on && numId !== null);
  const data = gated(on, q.data);
  const paneNote = layout === "pane";

  if (numId === null) return <Screen><ErrorView error={new Error("시장 요약 주소가 올바르지 않습니다")} retryLabel="브리핑 목록으로" onRetry={() => router.dismissTo("/briefings")} /></Screen>;
  if (!on) {
    if (flags.data === undefined && flags.isFetching) return <Screen disclaimer={paneNote}><CardsSkeleton count={2} /></Screen>;
    if (flags.data === undefined) {
      return (
        <Screen disclaimer={paneNote}>
          <Empty title="시장 요약을 불러오지 못했습니다" hint="연결을 확인해 주세요. 인터넷이 연결되면 다시 시도할 수 있습니다." action={<Button title="다시 시도" variant="secondary" compact onPress={() => void flags.refetch()} />} />
        </Screen>
      );
    }
    return (
      <Screen disclaimer={paneNote}>
        <Empty
          title="시장 요약을 볼 수 없습니다"
          hint={layout === "pane" ? "지금은 시장 요약이 꺼져 있습니다. 왼쪽 목록에서 브리핑을 고르세요." : "지금은 시장 요약이 꺼져 있습니다. 종목별 브리핑은 브리핑 탭에 있습니다."}
          action={layout === "pane" ? undefined : <Button title="브리핑 탭으로" variant="secondary" compact onPress={() => router.dismissTo("/briefings")} />}
        />
      </Screen>
    );
  }
  const view = viewState(q);
  if (view === "error") return <Screen disclaimer={paneNote}><ErrorView error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  if (view === "loading" || !data) return <Screen disclaimer={paneNote}><CardsSkeleton count={3} /></Screen>;
  return <SummaryView s={data} top={layout === "pane" ? null : <StaleBanner query={q} />} layout={layout} title={title} />;
}

/**
 * 칸의 실제 폭 (onLayout). 받기 전 첫 그림은 창 크기로 어림한 폭(guess)을 쓴다 — 좁은 칸에서 4칸 표를 한 번 그렸다 바꾸지 않게
 */
function useMeasuredWidth(guess: number): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const x = Math.round(e.nativeEvent.layout.width);
    if (x > 0) setW((p) => (p === x ? p : x));
  }, []);
  return [w ?? guess, onLayout];
}

/** 표 배치에 쓰는 것: 칸 폭 어림과 글자 배율(fontCap.row 까지 — 표 글자도 이만큼만 커진다) */
interface Fit {
  guess: number;
  scale: number;
}

function SummaryView({ s, top, layout, title }: { s: MarketSummary; top: React.ReactNode; layout: BodyLayout; title?: (s: MarketSummary) => React.ReactNode }) {
  const t = useTheme();
  const now = new Date(useNow(60_000));
  const win = useWindowDimensions();
  const fit: Fit = { guess: bodyWidthGuess(win.width, layout), scale: useFontScale(fontCap.row) };
  const d = s.data;
  const failed = s.status === "failed" || !d;
  const header = (
    <View style={styles.header}>
      <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "700" }} accessibilityRole="header">
        {d ? titleText(d, now) : "시장 요약"}
      </Text>
      <Words text={`${d ? `${basisText(d, now)} · ` : ""}${formatDateKo(s.createdAt, true)} 생성`} style={mutedText(t)} speak />
      <View style={styles.badges}>
        {failed ? <Badge tone="bad">생성 실패</Badge> : <Badge tone="good">숫자로 만든 요약</Badge>}
        {d?.holiday ? <Badge tone="warn">휴장</Badge> : null}
        {d?.phase === "intraday" ? <Badge tone="warn">장중 값</Badge> : null}
        {d?.phase === "prelim" ? <Badge tone="warn">최종값 확정 전</Badge> : null}
      </View>
    </View>
  );
  if (failed) {
    return (
      <Screen disclaimer top={top}>
        {layout === "pane" ? null : title?.(s)}
        {header}
        <Card>
          <Words text={s.summary} style={{ color: t.danger, fontSize: font.body }} speak />
          <Words text="다음 브리핑 시간에 다시 만듭니다." style={mutedText(t)} speak />
        </Card>
      </Screen>
    );
  }
  const summary = <SummaryLinesCard d={d} now={now} />;
  const holdings = <HoldingsCard d={d} fit={fit} />;
  const rest = (
    <>
      <IndicesCard d={d} fit={fit} />
      <SectorsCard d={d} scale={fit.scale} />
      <RatesCard d={d} scale={fit.scale} />
      <EventsCard d={d} now={now} />
      <NewsCard d={d} />
      <BasisCard d={d} />
    </>
  );
  if (layout === "split") {
    return (
      <Screen scroll={false} disclaimer top={top}>
        {title?.(s)}
        <BriefingSplit
          left={
            <>
              {header}
              {summary}
              {holdings}
            </>
          }
          right={rest}
        />
      </Screen>
    );
  }
  return (
    <Screen disclaimer top={top}>
      {layout === "pane" ? null : title?.(s)}
      {header}
      {summary}
      {holdings}
      {rest}
    </Screen>
  );
}

/** 요약 5~6줄 (카드와 같은 줄 — 볼 때 날짜로 '오늘/밤사이') */
function SummaryLinesCard({ d, now }: { d: MarketSummaryData; now: Date }) {
  const t = useTheme();
  const lines = summarySegLines(d, now);
  return (
    <Card>
      <View accessible accessibilityLabel={lines.map((l) => speakText(l.segs.map((x) => x.text).join(""))).join(". ")} style={{ gap: space.xs }}>
        {lines.map((l) => (
          <SegText key={l.kind} segs={l.segs} style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.6 }} />
        ))}
      </View>
    </Card>
  );
}

/** 흐린 글 (공용 Muted 와 같은 모양) · 아주 작은 흐린 글 (표 아래 안내) */
const mutedText = (t: Theme): TextStyle => ({ color: t.muted, fontSize: font.small, lineHeight: MUTED_LH });
const tinyText = (t: Theme): TextStyle => ({ color: t.muted, fontSize: font.tiny, lineHeight: MUTED_LH });

/** 글자 배율만큼 늘린 열 폭 (dp) */
const colW = (w: number, scale: number) => Math.round(w * scale);

/**
 * 내 보유 종목과 지수: 높음·비슷·낮음으로 묶은 표 (종목 | 등락률 | 비교 지수 | 차이 %p).
 * 칸이 좁거나 글자가 크면(이름 칸이 nameMinW 보다 좁아짐) 비교 지수를 종목 이름 아래 줄로 내린 3칸 표 (holdingsTableMode)
 */
function HoldingsCard({ d, fit }: { d: MarketSummaryData; fit: Fit }) {
  const t = useTheme();
  const [width, onLayout] = useMeasuredWidth(fit.guess);
  const mode = holdingsTableMode(width, fit.scale);
  const h = d.holdings;
  const us = d.market === "US";
  const segs = holdingsSegs(d, { mine: false });
  const aux = h && h.compared > 0 ? holdingsAuxSegs(h) : null;
  // 머리 두 줄('미국 12종목 · 지수보다 높음 2 (…)' · '내 미국 12종목: 상승 8 · 하락 4 / 나스닥 +0.48% · …')은 화면 읽기 한 칸 — 기호는 말로 ('+3.18%p' → '3.18%포인트 높음')
  const headSpeech = [segs, aux].filter((x): x is Seg[] => !!x).map((x) => speakText(x.map((s) => s.text).join(""))).join(". ");
  return (
    <Card padded={false}>
      <View style={styles.cardHead} onLayout={onLayout}>
        <SectionTitle>내 보유 종목과 지수</SectionTitle>
        {headSpeech ? (
          <View accessible accessibilityLabel={headSpeech} style={{ gap: space.xs }}>
            {segs ? <SegText segs={segs} style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.5 }} /> : null}
            {aux ? <SegText segs={aux} style={{ color: t.sub, fontSize: font.small }} /> : null}
          </View>
        ) : null}
        {!h ? <Words text={`${us ? "미국" : "국내"} 보유 종목이 없어 비교하지 않았습니다.`} style={mutedText(t)} speak /> : h.compared === 0 ? <Words text="지수 또는 종목 시세를 받지 못해 비교하지 못했습니다." style={mutedText(t)} speak /> : null}
      </View>
      {h && h.compared > 0 ? (
        <>
          <TableHead>
            <Text style={[styles.th, styles.colName, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
              {mode === "compact" ? "종목 · 비교 지수" : "종목"}
            </Text>
            <Text style={[styles.th, styles.right, { width: colW(MS.colRate, fit.scale), color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>등락률</Text>
            {mode === "full" ? (
              <Text style={[styles.th, styles.right, { width: colW(MS.colBench, fit.scale), color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
                비교 지수
              </Text>
            ) : null}
            <Text style={[styles.th, styles.right, { width: colW(MS.colDiff, fit.scale), color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>차이</Text>
          </TableHead>
          {(["high", "similar", "low"] as const).map((g) =>
            h[g].length ? (
              <View key={g}>
                <View style={[styles.group, { backgroundColor: t.bg }]}>
                  <Words text={`${GROUP_TITLE[g]} ${h[g].length}`} style={{ color: t.sub, fontSize: font.small, fontWeight: "700" }} cap={fontCap.row} label={`${GROUP_SPEECH[g]}, ${h[g].length}종목`} />
                </View>
                {h[g].map((r) => (
                  <CompareLine key={r.code} r={r} mode={mode} scale={fit.scale} />
                ))}
              </View>
            ) : null,
          )}
        </>
      ) : null}
      <View style={styles.cardFoot}>
        <Words text={holdingsFoot(d, h)} style={tinyText(t)} speak />
      </View>
    </Card>
  );
}

/**
 * 보유 종목 표 아래 안내. ETF 는 이름으로만 가려 알아보지 못한 것이 늘 있을 수 있으므로(한국 액티브·테마 ETF, 미국 금·변동성·채권 액티브·코인 ETF 등)
 * 뺀 종목이 없어도 '지수와 그대로 비교된다'를 늘 적는다 (3차 검토)
 */
function holdingsFoot(d: Pick<MarketSummaryData, "market">, h: HoldingsCompare | null): string {
  const us = d.market === "US";
  const parts = [
    us ? "정규장 종가 기준(애프터마켓 제외) — 잔고 화면 값과 조금 다를 수 있습니다" : "KRX 정규장 종가 기준(NXT·시간외 제외) — 잔고 화면 값과 조금 다를 수 있습니다",
    us ? "나스닥 상장 종목은 나스닥, 뉴욕·아멕스 상장 종목은 S&P500과 비교" : "코스피 상장 종목은 코스피, 코스닥 상장 종목과 코스닥 추종 ETF(코스피 시장 상장)는 코스닥과 비교",
    us ? "국내 보유 종목은 오후 요약에서" : "미국 보유 종목은 아침 요약에서",
    us
      ? "레버리지·인버스·채권 ETF는 이름으로 알아보고 빼며, 알아보지 못한 ETF(금·변동성·채권 액티브·코인 ETF 등)는 지수와 그대로 비교됩니다"
      : "레버리지·인버스·채권·해외 지수·원자재 ETF는 이름으로 알아보고 빼며, 알아보지 못한 ETF(해외 종목을 담은 액티브·테마 ETF 등)는 지수와 그대로 비교됩니다",
  ];
  if (h) {
    const ex = h.excluded;
    if (ex.leverage.length) parts.push(`레버리지·인버스 ETF ${ex.leverage.length}종목 제외(${ex.leverage.join(", ")})`);
    if (ex.overseas.length) parts.push(`해외 지수·원자재 ETF ${ex.overseas.length}종목 제외(${ex.overseas.join(", ")})`);
    // 채권·금리형 ETF 칸은 나중에 더해 예전에 저장한 요약에는 없다
    if (ex.bond?.length) parts.push(`채권·금리형 ETF ${ex.bond.length}종목 제외(${ex.bond.join(", ")}) — 주식 지수와 견주지 않음`);
    // 까닭을 단정하지 않는다: 거래정지·지연 말고도 시세 조회 실패·출처가 모르는 코드가 여기로 온다
    if (ex.noQuote.length) parts.push(`시세 없음 ${ex.noQuote.length}(${ex.noQuote.join(", ")}) — 같은 날 정규장 시세를 받지 못함(거래정지·지연·조회 실패 등)`);
    if (ex.noBenchmark.length) parts.push(`비교 지수 없음 ${ex.noBenchmark.length}(${ex.noBenchmark.join(", ")})`);
  }
  return parts.join(" · ");
}

/** 표 한 줄. compact 면 비교 지수를 이름 아래 줄로 (이름 칸을 넓게) */
function CompareLine({ r, mode, scale }: { r: CompareRow; mode: "full" | "compact"; scale: number }) {
  const t = useTheme();
  const label = sentence([r.name, speakRate(r.changeRate), `비교 지수 ${r.benchmark.name} ${speakRate(r.benchmark.changeRate) ?? ""}`, `차이 ${speakText(ppText(r.diff))}`]);
  const bench = (
    <>
      {r.benchmark.name} <Text style={{ color: changeColor(t, shownSign(r.benchmark.changeRate, rateText(r.benchmark.changeRate))) }}>{rateText(r.benchmark.changeRate)}</Text>
    </>
  );
  return (
    <View accessible accessibilityLabel={label} style={[styles.tr, { borderBottomColor: t.line }]}>
      <View style={styles.colName}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
          {r.name}
        </Text>
        {mode === "compact" ? (
          <Text style={{ color: t.sub, fontSize: font.small }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
            {bench}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.num, styles.right, { width: colW(MS.colRate, scale), color: changeColor(t, shownSign(r.changeRate, rateText(r.changeRate))), fontSize: font.body }]} maxFontSizeMultiplier={fontCap.row}>
        {rateText(r.changeRate)}
      </Text>
      {mode === "full" ? (
        <Text style={[styles.right, { width: colW(MS.colBench, scale), color: t.sub, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row}>
          {bench}
        </Text>
      ) : null}
      {/* 차이에는 색을 칠하지 않는다 (좋고 나쁨이 아니라 비교 사실) */}
      <Text style={[styles.num, styles.right, { width: colW(MS.colDiff, scale), color: t.ink, fontSize: font.body, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
        {ppText(r.diff)}
      </Text>
    </View>
  );
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${indexValueText(Math.abs(v))}`;

/**
 * 주요 지수: 종가 · 전일 대비 · 등락률 · 시각 (지수 이름 아래 줄 — 미국은 출처 시각 '뉴욕 17:15'(출처가 값을 마지막으로 고친 현지 시각이라 최종값인지 볼 수 있게),
 * 한국은 '15:30 마감'(네이버가 값을 다시 적는 20:15 무렵을 보이면 애프터마켓 값으로 오해할 수 있어서), 장중 요약이면 '서울 16:00').
 * 칸이 좁거나 글자가 크면(지수 이름 칸이 indexNameMinW 보다 좁아짐) 전일 대비를 종가 아래 줄로 내린 3칸 표 (indicesTableMode)
 */
function IndicesCard({ d, fit }: { d: MarketSummaryData; fit: Fit }) {
  const t = useTheme();
  const [width, onLayout] = useMeasuredWidth(fit.guess);
  const mode = indicesTableMode(width, fit.scale);
  const us = d.market === "US";
  const foot = `${
    d.phase === "intraday"
      ? "네이버 증권 · 장중 값 (마감 전)"
      : us
        ? `네이버 증권 · 뉴욕 장 마감 뒤 최종값${d.phase === "prelim" ? "이 오기 전 값" : ""}`
        : `네이버 증권 · ${d.closeTime} 장 마감 확정값`
  } · 지수 이름 아래는 ${us ? "출처 시각(현지) — 네이버 최종값은 뉴욕 17:15 무렵" : d.phase === "intraday" ? "출처 시각(현지)" : "그 값의 마감 시각"}`;
  const wValue = colW(MS.colValue, fit.scale);
  const wChange = colW(MS.colChange, fit.scale);
  const wRate = colW(MS.colRate, fit.scale);
  return (
    <Card padded={false}>
      <View onLayout={onLayout}>
        <SectionTitle style={styles.cardHead} right={<Muted>{d.holiday ? `직전 거래일 ${mdw(d.basisDate)}` : `${mdw(d.basisDate)} ${d.phase === "intraday" ? "장중" : "마감"}`}</Muted>}>
          주요 지수
        </SectionTitle>
        <TableHead>
          <Text style={[styles.th, styles.colName, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>지수</Text>
          <Text style={[styles.th, styles.right, { width: wValue, color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
            {mode === "compact" ? "종가 · 전일 대비" : "종가"}
          </Text>
          {mode === "full" ? (
            <Text style={[styles.th, styles.right, { width: wChange, color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
              전일 대비
            </Text>
          ) : null}
          <Text style={[styles.th, styles.right, { width: wRate, color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>등락률</Text>
        </TableHead>
        {d.indices.map((i) => {
          const change =
            i.change !== null ? (
              <Text style={[styles.num, { color: changeColor(t, shownSign(i.change, indexValueText(Math.abs(i.change)))) }]}>{signed(i.change)}</Text>
            ) : (
              <Text style={{ color: t.muted }}>—</Text>
            );
          const src = i.changeRate !== null ? indexSourceTime(i, d) : null;
          return (
            <View key={i.code} accessible accessibilityLabel={sentence([i.name, i.value !== null ? indexValueText(i.value) : "받지 못함", speakRate(i.changeRate), src ? (src.endsWith("마감") ? `${src} 값` : `출처 시각 ${src}`) : null])} style={[styles.tr, { borderBottomColor: t.line }]}>
              <View style={styles.colName}>
                <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }} maxFontSizeMultiplier={fontCap.row}>
                  {i.name}
                </Text>
                {src ? (
                  <Text style={[styles.num, { color: t.muted, fontSize: font.tiny }]} maxFontSizeMultiplier={fontCap.row}>
                    {src}
                  </Text>
                ) : null}
              </View>
              {i.changeRate === null ? (
                <View style={styles.colMissing}>
                  <Words text={`받지 못함${i.missing ? ` · ${i.missing}` : ""}`} style={{ color: t.muted, fontSize: font.small, textAlign: "right" }} cap={fontCap.row} end />
                </View>
              ) : (
                <>
                  <View style={{ width: wValue }}>
                    <Text style={[styles.num, styles.right, { color: t.ink, fontSize: font.body }]} maxFontSizeMultiplier={fontCap.row}>
                      {i.value !== null ? indexValueText(i.value) : "—"}
                    </Text>
                    {mode === "compact" ? (
                      <Text style={[styles.right, { fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row}>
                        {change}
                      </Text>
                    ) : null}
                  </View>
                  {mode === "full" ? (
                    <Text style={[styles.right, { width: wChange, fontSize: font.body }]} maxFontSizeMultiplier={fontCap.row}>
                      {change}
                    </Text>
                  ) : null}
                  <Text style={[styles.num, styles.right, { width: wRate, color: changeColor(t, shownSign(i.changeRate, rateText(i.changeRate))), fontSize: font.body, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
                    {rateText(i.changeRate)}
                  </Text>
                </>
              )}
            </View>
          );
        })}
      </View>
      <View style={styles.cardFoot}>
        <Words text={foot} style={tinyText(t)} speak />
      </View>
    </Card>
  );
}

/**
 * 업종: 미국은 섹터 ETF 11개 막대, 한국은 위아래 2개씩 + 뺀 업종 안내.
 * 막대는 칸 폭을 따라 줄고 늘며(이름 칸과 막대 칸을 반씩, 막대 길이는 칸 안의 비율), 이름은 두 줄까지 — 펼친 세로 두 칸(약 350dp)에서도 이름이 사라지지 않게
 */
function SectorsCard({ d, scale }: { d: MarketSummaryData; scale: number }) {
  const t = useTheme();
  const s = d.sectors;
  const rows = s ? (s.basis === "etf" ? s.all : [...s.strong, ...s.weak]) : [];
  const max = Math.max(0.01, ...rows.map((r) => Math.abs(r.changeRate)));
  return (
    <Card>
      <SectionTitle>{s?.basis === "etf" ? "업종 (섹터 ETF)" : "업종"}</SectionTitle>
      {!s ? (
        <Words text="업종 값을 확인하지 못해 뺐습니다." style={mutedText(t)} speak />
      ) : (
        <>
          {rows.map((r) => {
            const color = changeColor(t, shownSign(r.changeRate, rateText(r.changeRate)));
            // 막대 길이: 가장 큰 등락률이 반쪽 칸을 꽉 채우는 비율 (0 이 아닌 값은 최소 2%로 보이게)
            const pct = Math.max(2, Math.round((Math.abs(r.changeRate) / max) * 100));
            const bar = <View style={{ width: `${pct}%`, height: MS.barH, backgroundColor: color, borderRadius: radius.sm }} />;
            return (
              <View key={r.code} accessible accessibilityLabel={sentence([r.name, speakRate(r.changeRate)])} style={styles.barRow}>
                {/* 한국 업종의 구성 종목 수는 이름 아래 줄로 ('반도체와반도체장비 90 / 종목'처럼 숫자와 '종목'이 갈라지지 않게) */}
                <View style={styles.barName}>
                  <Text style={{ color: t.ink, fontSize: font.small }} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
                    {r.name}
                    {s.basis === "etf" ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{` ${r.code}`}</Text> : null}
                  </Text>
                  {s.basis !== "etf" && r.count ? (
                    <Text style={{ color: t.muted, fontSize: font.tiny }} maxFontSizeMultiplier={fontCap.row}>
                      {r.count}종목
                    </Text>
                  ) : null}
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barHalf, { alignItems: "flex-end" }]}>{r.changeRate < 0 ? bar : null}</View>
                  <View style={[styles.barAxis, { backgroundColor: t.line }]} />
                  <View style={styles.barHalf}>{r.changeRate > 0 ? bar : null}</View>
                </View>
                <Text style={[styles.num, styles.right, { width: colW(MS.colRate, scale), color, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row}>
                  {rateText(r.changeRate)}
                </Text>
              </View>
            );
          })}
          <Words
            text={`${
              s.basis === "etf"
                ? "SPDR 섹터 ETF 11개 · 정규장 종가 · 공식 S&P 섹터 지수가 아님"
                : `위아래 2개씩만 보여 줌 (전체 ${s.total}개는 발견 탭 '업종') · 네이버 업종 · 시가총액 가중 · 구성 5종목 미만·등락 ±30% 넘는 업종은 뺌${s.excluded.length ? ` (${s.excluded.length}개: ${s.excluded.map((x) => `${x.name} ${x.reason}`).join(", ")})` : ""}`
            }${d.holiday ? ` · ${md(d.basisDate)} 값` : ""}`}
            style={tinyText(t)}
            speak
          />
        </>
      )}
    </Card>
  );
}

/** 환율·금리: 고시일·출처 표기 */
function RatesCard({ d, scale }: { d: MarketSummaryData; scale: number }) {
  const t = useTheme();
  const f = d.fx;
  const y = d.yield10y;
  const morning = d.market === "US";
  const labelW = colW(MS.labelW, scale);
  // '한국 휴장으로 갱신 없음'은 한국 휴장(오후 요약의 휴장)일 때만 — 아침 요약의 holiday 는 미국 휴장이라 원/달러 고시와 무관하다 (11/27 추수감사절 다음 날 등)
  const krHolidayStale = d.market === "KR" && !!d.holiday && !!f?.date && f.date < d.date;
  return (
    <Card>
      <SectionTitle>{morning ? "환율·금리" : "환율"}</SectionTitle>
      {f ? (
        <View accessible accessibilityLabel={sentence(["원달러", wonText(f.value), speakText(wonChangeText(f.change)), speakRate(f.changeRate)])} style={styles.rate}>
          <Text style={{ color: t.muted, fontSize: font.small, width: labelW }} maxFontSizeMultiplier={fontCap.row}>원/달러</Text>
          <Text style={[styles.num, { color: t.ink, fontSize: font.h2, fontWeight: "700" }]}>{wonText(f.value)}</Text>
          <Text style={[styles.num, { color: changeColor(t, shownSign(f.change, wonChangeText(f.change))), fontSize: font.body }]}>
            {wonChangeText(f.change)} ({rateText(f.changeRate)})
          </Text>
        </View>
      ) : (
        <Words text="원/달러를 받지 못했습니다." style={mutedText(t)} speak />
      )}
      {f ? (
        <Words
          text={`하나은행 고시 매매기준율${f.date ? ` · ${md(f.date)} 고시값` : " · 고시일 확인 못 함"}${krHolidayStale ? " (한국 휴장으로 갱신 없음)" : ""} · 서울외환시장 15:30 종가가 아니라 은행 고시값입니다${
            morning ? " · 아침의 원/달러는 밤사이 변화가 아니라 직전 한국 영업일 고시의 전일 대비입니다" : ""
          }`}
          style={tinyText(t)}
          speak
        />
      ) : null}
      {morning ? (
        y ? (
          <>
            <View accessible accessibilityLabel={sentence(["미국 10년물 금리", yieldValueText(y), y.change !== null ? speakPointMove(yieldChangeText(y)) : null, yieldSourceText(y)])} style={styles.rate}>
              <Text style={{ color: t.muted, fontSize: font.small, width: labelW }} maxFontSizeMultiplier={fontCap.row}>미 10년물</Text>
              <Text style={[styles.num, { color: t.ink, fontSize: font.h2, fontWeight: "700" }]}>{yieldValueText(y)}</Text>
              {y.change !== null ? <Text style={[styles.num, { color: changeColor(t, shownSign(y.change, yieldChangeText(y))), fontSize: font.body }]}>{yieldChangeText(y)}</Text> : null}
            </View>
            <Words
              text={
                y.source === "treasury"
                  ? `미 재무부 ${md(y.date)}${y.prevDate && y.prevValue !== null ? ` (전날 ${md(y.prevDate)} ${y.prevValue.toFixed(2)}%)` : ""}`
                  : `로이터·네이버 ${md(y.date)} — 재무부 값이 없어 대신 씀 (산출 방식이 달라 재무부 값과 다를 수 있음)`
              }
              style={tinyText(t)}
              speak
            />
          </>
        ) : (
          <Words text="미 10년물 금리를 받지 못했습니다." style={mutedText(t)} speak />
        )
      ) : null}
    </Card>
  );
}

/** 일정: 24시간 안의 일정 + 다음 일정 */
function EventsCard({ d, now }: { d: MarketSummaryData; now: Date }) {
  const t = useTheme();
  const within = d.events.within;
  const next = d.events.next;
  const line = (e: SummaryEvent) => `${eventText(e, now)}${e.tentative ? " (예정)" : ""}`;
  return (
    <Card>
      <SectionTitle>일정</SectionTitle>
      {within.length ? (
        within.map((e) => (
          <View key={`${e.kind}-${e.at}`} style={styles.event}>
            <Ionicons name="calendar-outline" size={16} color={t.gold} />
            <View style={styles.grow}>
              <Words text={line(e)} style={{ color: t.ink, fontSize: font.body }} speak />
            </View>
          </View>
        ))
      ) : (
        <View style={styles.event}>
          <Ionicons name="calendar-outline" size={16} color={t.muted} />
          <View style={styles.grow}>
            <Words text="요약 시각부터 24시간 안에 등록된 큰 일정 없음" style={{ color: t.sub, fontSize: font.body }} speak />
          </View>
        </View>
      )}
      {next ? <Words text={`다음: ${line(next)}`} style={mutedText(t)} speak /> : null}
      {d.events.unknown.length ? <Words text={`일정 목록이 끝나 뺀 종류: ${d.events.unknown.map((k) => KIND_KO[k] ?? k).join(", ")}`} style={tinyText(t)} speak /> : null}
      <Words text="미 연준·미 노동통계국·한국은행·거래소 공식 일정표를 손으로 옮긴 목록 · 결과나 예상치는 넣지 않음" style={tinyText(t)} speak />
    </Card>
  );
}

const KIND_KO: Record<string, string> = { fomc: "미국 금리 결정", cpi: "미국 소비자물가", jobs: "미국 고용보고서", bok: "한국은행 기준금리" };

/** 뉴스: 언론사 · 시각 · 원문 제목 · '원문' 링크 (제목은 언론사가 쓴 그대로 — 앱의 설명이 아님) */
function NewsCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const items = d.news.items;
  const us = d.market === "US";
  return (
    <Card>
      <SectionTitle>뉴스 {items.length}건</SectionTitle>
      {!d.news.fresh && items.length ? <Words text={`새 마감 기사가 없어 요약에는 넣지 않았습니다 · 아래는 ${md(d.basisDate)} 장 마감 기사`} style={mutedText(t)} speak /> : null}
      {items.length ? (
        items.map((n, i) => {
          // http(s) 주소만 연다 (서버도 이런 주소만 저장한다 — 예전 요약·다른 값도 한 번 더 본다). 아니면 '원문' 칸을 두지 않는다
          const link = newsLink(n.url);
          return (
            <View key={`${i}-${n.url}`} style={[styles.news, { borderBottomColor: t.line }]}>
              <View style={{ flex: 1, gap: space.xxs }}>
                <Muted>
                  {n.outlet} · {newsTime(n, d.date)}
                </Muted>
                {/* 제목은 언론사 원문 그대로 읽는다 (기호를 말로 바꾸지 않는다) */}
                <Words text={n.title} style={{ color: t.ink, fontSize: font.body }} label={n.title} />
              </View>
              {link ? (
                <Pressable
                  onPress={() => void Linking.openURL(link)}
                  accessibilityRole="link"
                  accessibilityLabel={sentence([`${n.outlet} 기사 원문 열기`, n.title])}
                  style={({ pressed }) => [styles.link, { backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
                >
                  <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }}>원문</Text>
                  <Ionicons name="open-outline" size={14} color={t.accent} />
                </Pressable>
              ) : null}
            </View>
          );
        })
      ) : (
        <Words text="조건에 맞는 기사가 없습니다." style={mutedText(t)} speak />
      )}
      <Words
        text={`구글 뉴스 검색 '${d.news.query}' · ${us ? "뉴욕" : "한국"} 장 마감 10분 전부터 마감 뒤 6시간(또는 요약 시각)까지의 기사 · 통신사 기사 먼저, 같은 기사·같은 언론사는 1건 · 물음·인용 발언·매매 권유·주가 평가·전망으로 읽히는 제목, 다른 날 장 기사, 발행 시각을 알 수 없는 기사와 이름을 아는 언론사가 아닌 기사(포털 중계·영상·블로그 등)는 뺌 · 제목은 언론사가 쓴 그대로이며 앱의 설명이 아님`}
        style={tinyText(t)}
        speak
      />
    </Card>
  );
}

/** 이 요약을 만든 기준 */
function BasisCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const bullets = [
    "숫자는 모두 서버 코드가 공개 시세에서 계산합니다. AI(모델)가 쓴 문장은 없습니다.",
    "원인 설명·앞으로의 전망·사고팔기 권유를 담지 않습니다. 뉴스는 언론사 제목 원문으로만 보여 줍니다.",
    SIMILAR_NOTE,
  ];
  return (
    <Card>
      <SectionTitle>이 요약을 만든 기준</SectionTitle>
      {bullets.map((b) => (
        <Words key={b} text={`· ${b}`} style={{ color: t.sub, fontSize: font.small }} speak />
      ))}
      {d.notes.length ? <Words text={`받지 못하거나 뺀 것: ${d.notes.join(" · ")}`} style={tinyText(t)} speak /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingHorizontal: space.lg, paddingTop: space.md },
  grow: { flex: 1, minWidth: 0 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  cardHead: { gap: space.xs, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  cardFoot: { paddingHorizontal: space.lg, paddingVertical: space.md },
  th: { fontSize: font.small },
  group: { fontSize: font.small, fontWeight: "700", paddingHorizontal: space.lg, paddingVertical: space.s },
  tr: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  colName: { flex: 1, minWidth: 0 },
  // 숫자 칸 폭은 글자 배율만큼 늘려 줄마다 넣는다 (colW)
  right: { textAlign: "right" },
  colMissing: { flex: 2, textAlign: "right" },
  num: { fontVariant: ["tabular-nums"] },
  barRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: MS.barRowH },
  barName: { flex: 1, minWidth: 0 },
  barTrack: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
  barHalf: { flex: 1, minWidth: 0 },
  barAxis: { width: 1, height: MS.barH + space.xs },
  rate: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm },
  event: { flexDirection: "row", alignItems: "center", gap: space.sm },
  news: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  link: { minHeight: touch.min, minWidth: touch.min, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xxs, paddingHorizontal: space.sm, borderRadius: radius.sm },
});
