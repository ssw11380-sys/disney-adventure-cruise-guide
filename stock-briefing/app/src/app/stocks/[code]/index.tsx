import { Ionicons } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAnalysis, useBriefings, useCandles, useStock, useStockMutations, useStockNews } from "@/api/hooks";
import type { AnalysisKind, CandlePeriod } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { CandleChart } from "@/components/CandleChart";
import { CANDLE_COUNT } from "@/lib/chartPrefs";
import { FlashPrice } from "@/components/FlashPrice";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { Button, Card, ErrorView, Loading, Muted, SectionTitle, Segmented, Stat, StatGrid } from "@/components/ui";
import { afterMarketLabel, currencyOfMarket, formatArrowDisplay, formatDateKo, formatKrwCompact, formatNumber, formatPct, formatPrice, formatQuote, formatQuoteDisplay, formatVolume, isUsMarket, relativeTime, toDisplay } from "@/lib/format";
import { evalView, evaluate } from "@/lib/liveTick";
import { useSettings } from "@/lib/settings";
import { changeColor, font, space, useTheme } from "@/theme";

type Tab = AnalysisKind | "news";
const TABS: { value: Tab; label: string }[] = [
  { value: "company", label: "기업개요" },
  { value: "value", label: "가치분석" },
  { value: "technical", label: "기술분석" },
  { value: "news", label: "뉴스·공시" },
];

/** 종목 상세: 시세 헤더, 52주 위치, 지표 격자, 캔들 차트, 4개 탭, 최근 브리핑 */
export default function StockDetailScreen() {
  const t = useTheme();
  const { code } = useLocalSearchParams<{ code: string }>();
  const c = code ?? "";
  const stock = useStock(c);
  const { register } = useStockMutations();
  const { showKrw, afterCost } = useSettings();
  const [period, setPeriod] = useState<CandlePeriod>("D");
  const [tab, setTab] = useState<Tab>("company");
  // 과거 구간 이동과 120 이평선을 위해 넉넉히 받는다 (일봉 약 3년, 주봉 5년, 월봉 10년)
  const candles = useCandles(c, period, CANDLE_COUNT[period]);
  const briefings = useBriefings({ code: c, limit: 3 });

  if (!c) return null;
  if (stock.isLoading) return <Screen><Loading /></Screen>;
  if (stock.isError) return <Screen><ErrorView error={stock.error} onRetry={() => void stock.refetch()} /></Screen>;
  const s = stock.data!;
  const q = s.quote;
  // 발견 탭 등에서 연 미등록 종목: 수정 대신 관심 추가
  const unregistered = s.registered === false;
  const addWatch = () =>
    register.mutate(
      { code: s.code },
      {
        onSuccess: () => void stock.refetch(),
        onError: (e) => {
          // 두 번 눌러 이미 등록된 경우(409)는 성공으로 본다
          if (e instanceof Error && /이미 등록/.test(e.message)) return void stock.refetch();
          Alert.alert("관심 추가 실패", e instanceof Error ? e.message : String(e));
        },
      },
    );
  const cur = q?.currency ?? currencyOfMarket(s.market);
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const displayCur = toDisplay(1, cur, fx, showKrw).currency;
  const nxt = q?.afterMarket ?? null;
  // 서버 평가(토스 매입금액·비용 비율·원화 매입금액 포함)를 쓰고, 구버전 서버면 수량×평단으로 계산
  const baseEval = s.evaluation ?? (q ? evaluate(s, q) : null);
  const evNative = evalView(baseEval, { afterCost, toKrw: false, currency: cur, fx });
  const evKrw = cur === "USD" ? evalView(baseEval, { afterCost, toKrw: true, currency: cur, fx }) : null;
  const ev = evNative;
  const quote = (n: number | null | undefined) => formatQuoteDisplay(n, cur, fx, showKrw);
  const arrow = (n: number | null | undefined) => formatArrowDisplay(n, cur, fx, showKrw);
  const range52 = q && q.high52w && q.low52w && q.high52w > q.low52w ? Math.min(1, Math.max(0, (q.price - q.low52w) / (q.high52w - q.low52w))) : null;

  const up = changeColor(t, q?.change);

  return (
    <Screen
      disclaimer
      refreshing={stock.isRefetching}
      onRefresh={() => {
        void stock.refetch();
        void candles.refetch();
      }}
    >
      <Stack.Screen
        options={{
          title: s.name,
          headerRight: () =>
            unregistered ? (
              <Pressable onPress={addWatch} disabled={register.isPending || stock.isFetching} accessibilityLabel="관심 종목에 추가" hitSlop={10} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ionicons name="star-outline" size={20} color={t.gold} />
                <Text style={{ color: t.gold, fontSize: font.small, fontWeight: "700" }}>{register.isPending ? "추가 중" : "관심 추가"}</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => router.push(`/stocks/${c}/edit`)} accessibilityLabel="보유 정보 수정" hitSlop={10}>
                <Ionicons name="create-outline" size={21} color={t.ink} />
              </Pressable>
            ),
        }}
      />

      {/* 시세 머리 */}
      <View style={[styles.quoteHead, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <Text style={{ color: t.muted, fontSize: font.small }} numberOfLines={1}>
          {s.code} · {s.market}
          {q?.industry ? ` · ${q.industry}` : ""}
          {unregistered ? " · 미등록" : s.quantity ? "" : " · 관심"}
        </Text>
        {q ? (
          <>
            <View style={styles.priceRow}>
              <FlashPrice value={q.price} text={quote(q.price)} style={[styles.bigPrice, { color: up }]} />
              <Text style={{ color: t.muted, fontSize: font.body }}>{displayCur === "KRW" ? "원" : "USD"}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Text style={[styles.change, { color: up }]}>{arrow(q.change)}</Text>
              <Text style={[styles.change, { color: up }]}>{formatPct(q.changeRate)}</Text>
              {q.live ? <Text style={{ color: t.up, fontSize: font.tiny, fontWeight: "700" }}>● 실시간</Text> : null}
            </View>
            {cur === "USD" ? (
              <Text style={styles.sub(t.muted)}>
                {showKrw ? `$${formatQuote(q.price, "USD")}` : `${formatQuote(q.priceKrw ?? (fx ? q.price * fx : null), "KRW")}원`} · 환율 {fx ? formatNumber(fx, 2) : "-"}
              </Text>
            ) : null}
            {nxt ? (
              <Text style={[styles.sub(changeColor(t, nxt.change))]}>
                {afterMarketLabel(nxt)} {quote(nxt.price)} {arrow(nxt.change)} {formatPct(nxt.changeRate)}
              </Text>
            ) : null}
            <Text style={styles.sub(t.muted)}>
              {q.priceBasis ?? q.source.toUpperCase()} · {formatDateKo(q.asOf, true)}
            </Text>
          </>
        ) : (
          <Text style={{ color: t.danger, marginTop: 4 }}>{s.quoteError ?? "시세 없음"}</Text>
        )}
      </View>

      {/* 차트 */}
      <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
        <CandleChart
          candles={candles.data?.candles}
          period={period}
          onPeriodChange={setPeriod}
          loading={candles.isLoading}
          currency={cur}
          avgPrice={s.avgPrice}
          quote={q}
          onFullscreen={() => router.push(`/stocks/${c}/chart?period=${period}` as never)}
        />
        {candles.isError ? <Text style={{ color: t.danger, fontSize: font.small }}>{candles.error instanceof Error ? candles.error.message : "차트 실패"}</Text> : null}
      </View>

      {/* 시세 정보 */}
      {q ? (
        <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
          <Text style={styles.panelTitle(t.ink)}>시세</Text>
          <StatGrid>
            <Stat label="시가" value={quote(q.open)} change={q.open !== null && q.prevClose ? q.open - q.prevClose : null} />
            <Stat label="전일" value={quote(q.prevClose)} />
            <Stat label="고가" value={quote(q.high)} change={q.high !== null && q.prevClose ? q.high - q.prevClose : null} />
            <Stat label="거래량" value={formatVolume(q.volume)} />
            <Stat label="저가" value={quote(q.low)} change={q.low !== null && q.prevClose ? q.low - q.prevClose : null} />
            <Stat label="시가총액" value={formatKrwCompact(q.marketCap, cur)} />
            <Stat label="52주 최고" value={quote(q.high52w)} />
            <Stat label="52주 최저" value={quote(q.low52w)} />
            <Stat label="PER" value={q.per !== null ? `${formatNumber(q.per, 2)}배` : "-"} />
            <Stat label="PBR" value={q.pbr !== null ? `${formatNumber(q.pbr, 2)}배` : "-"} />
            <Stat label="EPS" value={q.eps !== null ? formatQuote(q.eps, cur) : "-"} />
            <Stat label="BPS" value={q.bps !== null ? formatQuote(q.bps, cur) : "-"} />
            <Stat label="배당수익률" value={q.dividendYieldPct !== null && q.dividendYieldPct !== undefined ? `${formatNumber(q.dividendYieldPct, 2)}%` : "-"} />
            <Stat label="주당배당" value={q.dividendPerShare !== null && q.dividendPerShare !== undefined ? formatQuote(q.dividendPerShare, cur) : "-"} />
          </StatGrid>
          {range52 !== null ? (
            <View style={{ gap: 3, marginTop: 6 }}>
              <View style={[styles.rangeTrack, { backgroundColor: t.surfaceAlt }]}>
                <View style={[styles.rangeKnob, { left: `${Math.round(range52 * 100)}%`, backgroundColor: up === t.ink ? t.sub : up }]} />
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={styles.sub(t.muted)}>52주 저 {quote(q.low52w)}</Text>
                <Text style={styles.sub(t.muted)}>{Math.round(range52 * 100)}%</Text>
                <Text style={styles.sub(t.muted)}>고 {quote(q.high52w)}</Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* 잔고 */}
      {ev ? (
        <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
          <Text style={styles.panelTitle(t.ink)}>잔고</Text>
          <StatGrid>
            <Stat label="보유수량" value={`${formatNumber(s.quantity, Number.isInteger(s.quantity) ? 0 : 4)}주`} />
            <Stat label="평균단가" value={formatQuote(s.avgPrice, cur)} />
            <Stat label="평가금액" value={formatPrice(ev.marketValue, cur)} />
            <Stat label="매입금액" value={formatPrice(ev.costBasis, cur)} />
            <Stat label="평가손익" value={formatPrice(ev.profit, cur, { sign: true })} change={ev.profit} />
            <Stat label="수익률" value={formatPct(ev.profitRate)} change={ev.profit} />
          </StatGrid>
          {evKrw?.currency === "KRW" ? (
            <>
              <Text style={[styles.sub(t.muted), { marginTop: 4 }]}>{evKrw.krwBasis === "current" ? "원화 기준 (현재 환율 환산)" : `원화 기준 (매수 당시 환율${evKrw.estimated ? " · 추정" : ""})`}</Text>
              <StatGrid>
                <Stat label="평가금액" value={formatPrice(evKrw.marketValue, "KRW")} />
                <Stat label="매입금액" value={formatPrice(evKrw.costBasis, "KRW")} />
                <Stat label="평가손익" value={formatPrice(evKrw.profit, "KRW", { sign: true })} change={evKrw.profit} />
                <Stat label="수익률" value={formatPct(evKrw.profitRate)} change={evKrw.profit} />
              </StatGrid>
            </>
          ) : null}
          {afterCost && baseEval?.afterCost ? <Text style={styles.sub(t.muted)}>평가금액·손익은 매도 시 예상 수수료·세금 차감 후 (토스 기준)</Text> : null}
          {s.memo ? <Text style={styles.sub(t.muted)}>메모 {s.memo}</Text> : null}
        </View>
      ) : null}

      <Segmented options={TABS} value={tab} onChange={setTab} style={{ marginTop: 2 }} />
      {tab === "news" ? <NewsTab code={c} us={isUsMarket(s.market)} /> : <AnalysisTab key={`${c}:${tab}`} code={c} kind={tab} manual={unregistered} />}

      {briefings.data && briefings.data.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <Text style={[styles.panelTitle(t.ink), { paddingHorizontal: space.lg, paddingTop: space.sm }]}>최근 브리핑</Text>
          {briefings.data.map((b) => (
            <BriefingCard key={b.id} briefing={b} mode="summary" showName={false} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

/** manual: 발견 탭 등에서 잠깐 들여다보는 미등록 종목 — AI 분석은 눌렀을 때만 만든다 (비용·시간) */
function AnalysisTab({ code, kind, manual = false }: { code: string; kind: AnalysisKind; manual?: boolean }) {
  const [requested, setRequested] = useState(!manual);
  const a = useAnalysis(code, kind, requested);
  const { refreshAnalysis } = useStockMutations();
  const busy = refreshAnalysis.isPending && refreshAnalysis.variables?.kind === kind;
  if (!requested)
    return (
      <Card>
        <Muted>관심 종목이 아니라 AI 분석을 미리 만들지 않았습니다.</Muted>
        <Button title="AI 분석 만들기" icon="sparkles" onPress={() => setRequested(true)} />
      </Card>
    );
  if (a.isLoading || busy) return <Card><Loading label="분석 생성 중" /></Card>;
  if (a.isError) return <Card><ErrorView error={a.error} onRetry={() => void a.refetch()} /></Card>;
  const d = a.data!;
  return (
    <Card>
      <MarkdownView>{d.content}</MarkdownView>
      {d.missing.length ? <Muted>데이터 미확인: {d.missing.join(", ")}</Muted> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Muted>
          {formatDateKo(d.createdAt, true)} 기준
        </Muted>
        <Button title="갱신" variant="secondary" icon="refresh" compact onPress={() => refreshAnalysis.mutate({ code, kind })} />
      </View>
    </Card>
  );
}

function NewsTab({ code, us }: { code: string; us: boolean }) {
  const t = useTheme();
  const n = useStockNews(code);
  if (n.isLoading) return <Card><Loading /></Card>;
  if (n.isError) return <Card><ErrorView error={n.error} onRetry={() => void n.refetch()} /></Card>;
  const d = n.data!;
  return (
    <View style={{ gap: space.md }}>
      <Card>
        <SectionTitle>뉴스</SectionTitle>
        {d.newsError ? <Text style={{ color: t.danger, fontSize: font.small }}>{d.newsError}</Text> : null}
        {d.news.length === 0 && !d.newsError ? <Muted>최근 뉴스 없음</Muted> : null}
        {d.news.map((item, i) => (
          <Pressable key={`${item.url}-${i}`} onPress={() => void Linking.openURL(item.url)} accessibilityRole="link" style={[styles.newsItem, { borderTopColor: t.line, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}>
            <Text style={{ color: t.ink, fontSize: font.body, lineHeight: 20 }} numberOfLines={2}>{item.title}</Text>
            <Muted>
              {item.source ?? ""} · {relativeTime(item.publishedAt) || formatDateKo(item.publishedAt)}
            </Muted>
          </Pressable>
        ))}
      </Card>
      <Card>
        <SectionTitle>{us ? "공시 (SEC)" : "공시 (DART)"}</SectionTitle>
        {d.disclosuresError ? <Muted>{d.disclosuresError}</Muted> : null}
        {d.disclosures.length === 0 && !d.disclosuresError ? <Muted>최근 30일 공시 없음</Muted> : null}
        {d.disclosures.map((item, i) => (
          <Pressable key={item.receiptNo} onPress={() => void Linking.openURL(item.url)} accessibilityRole="link" style={[styles.newsItem, { borderTopColor: t.line, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}>
            <Text style={{ color: t.ink, fontSize: font.body }}>{item.title}</Text>
            <Muted>
              {item.filer} · {formatDateKo(item.filedAt)}
            </Muted>
          </Pressable>
        ))}
      </Card>
    </View>
  );
}

const styles = {
  ...StyleSheet.create({
    quoteHead: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
    priceRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
    bigPrice: { fontSize: 30, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
    change: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
    panel: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm },
    newsItem: { paddingVertical: 10, gap: 3 },
    rangeTrack: { height: 4, borderRadius: 2, justifyContent: "center" },
    rangeKnob: { position: "absolute", width: 8, height: 12, borderRadius: 1, marginLeft: -4, top: -4 },
  }),
  sub: (color: string) => ({ color, fontSize: font.small, fontVariant: ["tabular-nums" as const] }),
  panelTitle: (color: string) => ({ color, fontSize: font.body, fontWeight: "700" as const }),
};
