import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
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
  eventText,
  holdingsAuxSegs,
  holdingsSegs,
  indexValueText,
  md,
  mdw,
  newsTime,
  ppText,
  rateText,
  speakText,
  summarySegLines,
  titleText,
  wonChangeText,
  wonText,
  yieldChangeText,
  yieldSourceText,
  yieldValueText,
} from "@/lib/marketSummary";
import { useNow } from "@/lib/useNow";
import { changeColor, font, fontCap, space, touch, useTheme } from "@/theme";
import { marketSummary as MS, radius } from "@/tokens";
import { SegText } from "./MarketSummaryCard";

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

function SummaryView({ s, top, layout, title }: { s: MarketSummary; top: React.ReactNode; layout: BodyLayout; title?: (s: MarketSummary) => React.ReactNode }) {
  const t = useTheme();
  const now = new Date(useNow(60_000));
  const d = s.data;
  const failed = s.status === "failed" || !d;
  const header = (
    <View style={styles.header}>
      <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "700" }} accessibilityRole="header">
        {d ? titleText(d, now) : "시장 요약"}
      </Text>
      <Muted>
        {d ? `${basisText(d, now)} · ` : ""}
        {formatDateKo(s.createdAt, true)} 생성
      </Muted>
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
          <Text style={{ color: t.danger, fontSize: font.body }}>{s.summary}</Text>
          <Muted>다음 브리핑 시간에 다시 만듭니다.</Muted>
        </Card>
      </Screen>
    );
  }
  const summary = <SummaryLinesCard d={d} now={now} />;
  const holdings = <HoldingsCard d={d} />;
  const rest = (
    <>
      <IndicesCard d={d} />
      <SectorsCard d={d} />
      <RatesCard d={d} />
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

const GROUP_TITLE: Record<"high" | "similar" | "low", string> = { high: "지수보다 높음 (+1.00%p 이상)", similar: "비슷 (±1.00%p 안)", low: "지수보다 낮음 (-1.00%p 이하)" };

/** 내 보유 종목과 지수: 높음·비슷·낮음으로 묶은 표 (종목 | 등락률 | 비교 지수 | 차이 %p) */
function HoldingsCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const h = d.holdings;
  const us = d.market === "US";
  const segs = holdingsSegs(d, { mine: false });
  return (
    <Card padded={false}>
      <View style={styles.cardHead}>
        <SectionTitle>내 보유 종목과 지수</SectionTitle>
        {segs ? <SegText segs={segs} style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.5 }} /> : null}
        {h && h.compared > 0 ? <SegText segs={holdingsAuxSegs(h)} style={{ color: t.sub, fontSize: font.small }} /> : null}
        {!h ? <Muted>{us ? "미국" : "국내"} 보유 종목이 없어 비교하지 않았습니다.</Muted> : h.compared === 0 ? <Muted>지수 또는 종목 시세를 받지 못해 비교하지 못했습니다.</Muted> : null}
      </View>
      {h && h.compared > 0 ? (
        <>
          <TableHead>
            <Text style={[styles.th, styles.colName, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>종목</Text>
            <Text style={[styles.th, styles.colRate, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>등락률</Text>
            <Text style={[styles.th, styles.colBench, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>비교 지수</Text>
            <Text style={[styles.th, styles.colDiff, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>차이</Text>
          </TableHead>
          {(["high", "similar", "low"] as const).map((g) =>
            h[g].length ? (
              <View key={g}>
                <Text style={[styles.group, { color: t.sub, backgroundColor: t.bg }]} maxFontSizeMultiplier={fontCap.row}>
                  {GROUP_TITLE[g]} {h[g].length}
                </Text>
                {h[g].map((r) => (
                  <CompareLine key={r.code} r={r} />
                ))}
              </View>
            ) : null,
          )}
        </>
      ) : null}
      <View style={styles.cardFoot}>
        <Muted style={{ fontSize: font.tiny }}>{holdingsFoot(d, h)}</Muted>
      </View>
    </Card>
  );
}

function holdingsFoot(d: MarketSummaryData, h: HoldingsCompare | null): string {
  const us = d.market === "US";
  const parts = [
    us ? "정규장 종가 기준(애프터마켓 제외) — 잔고 화면 값과 조금 다를 수 있습니다" : "KRX 정규장 종가 기준(NXT·시간외 제외) — 잔고 화면 값과 조금 다를 수 있습니다",
    us ? "나스닥 상장 종목은 나스닥, 뉴욕·아멕스 상장 종목은 S&P500과 비교" : "코스피 상장 종목은 코스피, 코스닥 상장 종목은 코스닥과 비교",
    us ? "국내 보유 종목은 오후 요약에서" : "미국 보유 종목은 아침 요약에서",
  ];
  if (h) {
    const ex = h.excluded;
    if (ex.leverage.length) parts.push(`레버리지·인버스 ETF ${ex.leverage.length}종목 제외(${ex.leverage.join(", ")}) — 이름으로 알아보지 못한 것은 포함됩니다`);
    if (ex.overseas.length) parts.push(`해외 지수 ETF ${ex.overseas.length}종목 제외(${ex.overseas.join(", ")})`);
    if (ex.noQuote.length) parts.push(`시세 없음 ${ex.noQuote.length}(${ex.noQuote.join(", ")}) — 거래정지·지연으로 같은 날 시세가 아님`);
    if (ex.noBenchmark.length) parts.push(`비교 지수 없음 ${ex.noBenchmark.length}(${ex.noBenchmark.join(", ")})`);
  }
  return parts.join(" · ");
}

function CompareLine({ r }: { r: CompareRow }) {
  const t = useTheme();
  const label = sentence([r.name, speakRate(r.changeRate), `비교 지수 ${r.benchmark.name} ${speakRate(r.benchmark.changeRate) ?? ""}`, `차이 ${speakText(ppText(r.diff))}`]);
  return (
    <View accessible accessibilityLabel={label} style={[styles.tr, { borderBottomColor: t.line }]}>
      <Text style={[styles.colName, { color: t.ink, fontSize: font.body, fontWeight: "600" }]} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
        {r.name}
      </Text>
      <Text style={[styles.num, styles.colRate, { color: changeColor(t, shownSign(r.changeRate, rateText(r.changeRate))), fontSize: font.body }]} maxFontSizeMultiplier={fontCap.row}>
        {rateText(r.changeRate)}
      </Text>
      <Text style={[styles.colBench, { color: t.sub, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row}>
        {r.benchmark.name} <Text style={{ color: changeColor(t, shownSign(r.benchmark.changeRate, rateText(r.benchmark.changeRate))) }}>{rateText(r.benchmark.changeRate)}</Text>
      </Text>
      {/* 차이에는 색을 칠하지 않는다 (좋고 나쁨이 아니라 비교 사실) */}
      <Text style={[styles.num, styles.colDiff, { color: t.ink, fontSize: font.body, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
        {ppText(r.diff)}
      </Text>
    </View>
  );
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${indexValueText(Math.abs(v))}`;

/** 주요 지수: 종가 · 전일 대비 · 등락률 · 출처 시각 */
function IndicesCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const us = d.market === "US";
  const foot =
    d.phase === "intraday"
      ? "네이버 증권 · 장중 값 (마감 전)"
      : us
        ? `네이버 증권 · 뉴욕 장 마감 뒤 최종값${d.phase === "prelim" ? "이 오기 전 값" : ""}`
        : `네이버 증권 · ${d.closeTime} 장 마감 확정값`;
  return (
    <Card padded={false}>
      <SectionTitle style={styles.cardHead} right={<Muted>{d.holiday ? `직전 거래일 ${mdw(d.basisDate)}` : `${mdw(d.basisDate)} ${d.phase === "intraday" ? "장중" : "마감"}`}</Muted>}>
        주요 지수
      </SectionTitle>
      <TableHead>
        <Text style={[styles.th, styles.colName, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>지수</Text>
        <Text style={[styles.th, styles.colValue, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>종가</Text>
        <Text style={[styles.th, styles.colChange, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>전일 대비</Text>
        <Text style={[styles.th, styles.colRate, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>등락률</Text>
      </TableHead>
      {d.indices.map((i) => (
        <View key={i.code} accessible accessibilityLabel={sentence([i.name, i.value !== null ? indexValueText(i.value) : "받지 못함", speakRate(i.changeRate)])} style={[styles.tr, { borderBottomColor: t.line }]}>
          <Text style={[styles.colName, { color: t.ink, fontSize: font.body, fontWeight: "600" }]} maxFontSizeMultiplier={fontCap.row}>
            {i.name}
          </Text>
          {i.changeRate === null ? (
            <Text style={[styles.colMissing, { color: t.muted, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row}>
              받지 못함{i.missing ? ` · ${i.missing}` : ""}
            </Text>
          ) : (
            <>
              <Text style={[styles.num, styles.colValue, { color: t.ink, fontSize: font.body }]} maxFontSizeMultiplier={fontCap.row}>
                {i.value !== null ? indexValueText(i.value) : "—"}
              </Text>
              <Text style={[styles.num, styles.colChange, { color: i.change !== null ? changeColor(t, shownSign(i.change, indexValueText(Math.abs(i.change)))) : t.muted, fontSize: font.body }]} maxFontSizeMultiplier={fontCap.row}>
                {i.change !== null ? signed(i.change) : "—"}
              </Text>
              <Text style={[styles.num, styles.colRate, { color: changeColor(t, shownSign(i.changeRate, rateText(i.changeRate))), fontSize: font.body, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
                {rateText(i.changeRate)}
              </Text>
            </>
          )}
        </View>
      ))}
      <Muted style={[styles.cardFoot, { fontSize: font.tiny }]}>{foot}</Muted>
    </Card>
  );
}

/** 업종: 미국은 섹터 ETF 11개 막대, 한국은 위아래 2개씩 + 뺀 업종 안내 */
function SectorsCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const s = d.sectors;
  const rows = s ? (s.basis === "etf" ? s.all : [...s.strong, ...s.weak]) : [];
  const max = Math.max(0.01, ...rows.map((r) => Math.abs(r.changeRate)));
  return (
    <Card>
      <SectionTitle>{s?.basis === "etf" ? "업종 (섹터 ETF)" : "업종"}</SectionTitle>
      {!s ? (
        <Muted>업종 값을 확인하지 못해 뺐습니다.</Muted>
      ) : (
        <>
          {rows.map((r) => {
            const w = Math.max(2, Math.round((Math.abs(r.changeRate) / max) * MS.barMaxW));
            const color = changeColor(t, shownSign(r.changeRate, rateText(r.changeRate)));
            return (
              <View key={r.code} accessible accessibilityLabel={sentence([r.name, speakRate(r.changeRate)])} style={styles.barRow}>
                <Text style={[styles.barName, { color: t.ink, fontSize: font.small }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
                  {r.name}
                  <Text style={{ color: t.muted, fontSize: font.tiny }}>{s.basis === "etf" ? ` ${r.code}` : r.count ? ` ${r.count}종목` : ""}</Text>
                </Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barHalf, { alignItems: "flex-end" }]}>{r.changeRate < 0 ? <View style={{ width: w, height: MS.barH, backgroundColor: color, borderRadius: radius.sm }} /> : null}</View>
                  <View style={[styles.barAxis, { backgroundColor: t.line }]} />
                  <View style={styles.barHalf}>{r.changeRate > 0 ? <View style={{ width: w, height: MS.barH, backgroundColor: color, borderRadius: radius.sm }} /> : null}</View>
                </View>
                <Text style={[styles.num, styles.barRate, { color, fontSize: font.small }]} maxFontSizeMultiplier={fontCap.row}>
                  {rateText(r.changeRate)}
                </Text>
              </View>
            );
          })}
          <Muted style={{ fontSize: font.tiny }}>
            {s.basis === "etf"
              ? "SPDR 섹터 ETF 11개 · 정규장 종가 · 공식 S&P 섹터 지수가 아님"
              : `위아래 2개씩만 보여 줌 (전체 ${s.total}개는 발견 탭 '업종') · 네이버 업종 · 시가총액 가중 · 구성 5종목 미만·등락 ±30% 넘는 업종은 뺌${s.excluded.length ? ` (${s.excluded.length}개: ${s.excluded.map((x) => `${x.name} ${x.reason}`).join(", ")})` : ""}`}
            {d.holiday ? ` · ${md(d.basisDate)} 값` : ""}
          </Muted>
        </>
      )}
    </Card>
  );
}

/** 환율·금리: 고시일·출처 표기 */
function RatesCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const f = d.fx;
  const y = d.yield10y;
  const morning = d.market === "US";
  return (
    <Card>
      <SectionTitle>{morning ? "환율·금리" : "환율"}</SectionTitle>
      {f ? (
        <View accessible accessibilityLabel={sentence(["원달러", wonText(f.value), speakText(wonChangeText(f.change)), speakRate(f.changeRate)])} style={styles.rate}>
          <Text style={{ color: t.muted, fontSize: font.small, width: MS.labelW }}>원/달러</Text>
          <Text style={[styles.num, { color: t.ink, fontSize: font.h2, fontWeight: "700" }]}>{wonText(f.value)}</Text>
          <Text style={[styles.num, { color: changeColor(t, shownSign(f.change, wonChangeText(f.change))), fontSize: font.body }]}>
            {wonChangeText(f.change)} ({rateText(f.changeRate)})
          </Text>
        </View>
      ) : (
        <Muted>원/달러를 받지 못했습니다.</Muted>
      )}
      {f ? (
        <Muted style={{ fontSize: font.tiny }}>
          하나은행 고시 매매기준율{f.date ? ` · ${md(f.date)} 고시값` : " · 고시일 확인 못 함"}
          {d.holiday && f.date && f.date < d.date ? " (한국 휴장으로 갱신 없음)" : ""} · 서울외환시장 15:30 종가가 아니라 은행 고시값입니다
          {morning ? " · 아침의 원/달러는 밤사이 변화가 아니라 직전 한국 영업일 고시의 전일 대비입니다" : ""}
        </Muted>
      ) : null}
      {morning ? (
        y ? (
          <>
            <View accessible accessibilityLabel={sentence(["미국 10년물 금리", yieldValueText(y), y.change !== null ? speakText(yieldChangeText(y)) : null, yieldSourceText(y)])} style={styles.rate}>
              <Text style={{ color: t.muted, fontSize: font.small, width: MS.labelW }}>미 10년물</Text>
              <Text style={[styles.num, { color: t.ink, fontSize: font.h2, fontWeight: "700" }]}>{yieldValueText(y)}</Text>
              {y.change !== null ? <Text style={[styles.num, { color: changeColor(t, shownSign(y.change, yieldChangeText(y))), fontSize: font.body }]}>{yieldChangeText(y)}</Text> : null}
            </View>
            <Muted style={{ fontSize: font.tiny }}>
              {y.source === "treasury"
                ? `미 재무부 ${md(y.date)}${y.prevDate && y.prevValue !== null ? ` (전날 ${md(y.prevDate)} ${y.prevValue.toFixed(2)}%)` : ""}`
                : `로이터·네이버 ${md(y.date)} — 재무부 값이 없어 대신 씀 (산출 방식이 달라 재무부 값과 다를 수 있음)`}
            </Muted>
          </>
        ) : (
          <Muted>미 10년물 금리를 받지 못했습니다.</Muted>
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
            <Text style={{ color: t.ink, fontSize: font.body, flexShrink: 1 }}>{line(e)}</Text>
          </View>
        ))
      ) : (
        <View style={styles.event}>
          <Ionicons name="calendar-outline" size={16} color={t.muted} />
          <Text style={{ color: t.sub, fontSize: font.body, flexShrink: 1 }}>요약 시각부터 24시간 안에 등록된 큰 일정 없음</Text>
        </View>
      )}
      {next ? <Muted>다음: {line(next)}</Muted> : null}
      {d.events.unknown.length ? <Muted style={{ fontSize: font.tiny }}>일정 목록이 끝나 뺀 종류: {d.events.unknown.map((k) => KIND_KO[k] ?? k).join(", ")}</Muted> : null}
      <Muted style={{ fontSize: font.tiny }}>미 연준·미 노동통계국·한국은행·거래소 공식 일정표를 손으로 옮긴 목록 · 결과나 예상치는 넣지 않음</Muted>
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
      {!d.news.fresh && items.length ? <Muted>새 마감 기사가 없어 요약에는 넣지 않았습니다 · 아래는 {md(d.basisDate)} 장 마감 기사</Muted> : null}
      {items.length ? (
        items.map((n) => (
          <View key={n.url} style={[styles.news, { borderBottomColor: t.line }]}>
            <View style={{ flex: 1, gap: space.xxs }}>
              <Muted>
                {n.outlet} · {newsTime(n, d.date)}
              </Muted>
              <Text style={{ color: t.ink, fontSize: font.body }}>{n.title}</Text>
            </View>
            <Pressable
              onPress={() => void Linking.openURL(n.url)}
              accessibilityRole="link"
              accessibilityLabel={sentence([`${n.outlet} 기사 원문 열기`, n.title])}
              style={({ pressed }) => [styles.link, { backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
            >
              <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }}>원문</Text>
              <Ionicons name="open-outline" size={14} color={t.accent} />
            </Pressable>
          </View>
        ))
      ) : (
        <Muted>조건에 맞는 기사가 없습니다.</Muted>
      )}
      <Muted style={{ fontSize: font.tiny }}>
        {`구글 뉴스 검색 '${d.news.query}'`} · {us ? "뉴욕" : "한국"} 장 마감 10분 전부터 마감 뒤 6시간(또는 요약 시각)까지의 기사 · 통신사 기사 먼저, 같은 기사·같은 언론사는 1건 · 물음표·매매 권유·전망 낱말 제목은 뺌 · 제목은 언론사가 쓴 그대로이며 앱의 설명이 아님
      </Muted>
    </Card>
  );
}

/** 이 요약을 만든 기준 */
function BasisCard({ d }: { d: MarketSummaryData }) {
  const t = useTheme();
  const bullets = [
    "숫자는 모두 서버 코드가 공개 시세에서 계산합니다. AI(모델)가 쓴 문장은 없습니다.",
    "원인 설명·앞으로의 전망·사고팔기 권유를 담지 않습니다. 뉴스는 언론사 제목 원문으로만 보여 줍니다.",
    "'비슷'은 지수와의 차이가 ±1.00%p 안인 종목입니다 (좋고 나쁨의 뜻이 아님).",
  ];
  return (
    <Card>
      <SectionTitle>이 요약을 만든 기준</SectionTitle>
      {bullets.map((b) => (
        <Text key={b} style={{ color: t.sub, fontSize: font.small }}>
          · {b}
        </Text>
      ))}
      {d.notes.length ? <Muted style={{ fontSize: font.tiny }}>받지 못하거나 뺀 것: {d.notes.join(" · ")}</Muted> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingHorizontal: space.lg, paddingTop: space.md },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  cardHead: { gap: space.xs, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  cardFoot: { paddingHorizontal: space.lg, paddingVertical: space.md },
  th: { fontSize: font.small },
  group: { fontSize: font.small, fontWeight: "700", paddingHorizontal: space.lg, paddingVertical: space.s },
  tr: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  colName: { flex: 1, minWidth: 0 },
  colRate: { width: MS.colRate, textAlign: "right" },
  colBench: { width: MS.colBench, textAlign: "right" },
  colDiff: { width: MS.colDiff, textAlign: "right" },
  colValue: { width: MS.colValue, textAlign: "right" },
  colChange: { width: MS.colChange, textAlign: "right" },
  colMissing: { flex: 2, textAlign: "right" },
  num: { fontVariant: ["tabular-nums"] },
  barRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: MS.barRowH },
  barName: { flex: 1, minWidth: 0 },
  barTrack: { flexDirection: "row", alignItems: "center" },
  barHalf: { width: MS.barMaxW },
  barAxis: { width: 1, height: MS.barH + space.xs },
  barRate: { width: MS.colRate, textAlign: "right" },
  rate: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm },
  event: { flexDirection: "row", alignItems: "center", gap: space.sm },
  news: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  link: { minHeight: touch.min, minWidth: touch.min, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xxs, paddingHorizontal: space.sm, borderRadius: radius.sm },
});
