import { Ionicons } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAnalysis, useBriefings, useCandles, useStock, useStockMutations, useStockNews } from "@/api/hooks";
import type { AnalysisKind, CandlePeriod } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { CandleChart } from "@/components/CandleChart";
import { CANDLE_COUNT } from "@/lib/chartPrefs";
import { FlashPrice } from "@/components/FlashPrice";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, ChangeText, ErrorView, Loading, Muted, Row, SectionTitle, Segmented, Stat } from "@/components/ui";
import { afterMarketLabel, currencyOfMarket, formatDateKo, formatKrwCompact, formatMoney, formatNumber, formatPct, formatPrice, formatVolume, isUsMarket, relativeTime, toDisplay } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { font, space, useTheme } from "@/theme";

type Tab = AnalysisKind | "news";
const TABS: { value: Tab; label: string }[] = [
  { value: "company", label: "회사 소개" },
  { value: "value", label: "가치투자" },
  { value: "technical", label: "기술적 분석" },
  { value: "news", label: "뉴스·공시" },
];

/** 종목 상세: 시세 헤더, 52주 위치, 지표 격자, 캔들 차트, 4개 탭, 최근 브리핑 */
export default function StockDetailScreen() {
  const t = useTheme();
  const { code } = useLocalSearchParams<{ code: string }>();
  const c = code ?? "";
  const stock = useStock(c);
  const { showKrw } = useSettings();
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
  const cur = q?.currency ?? currencyOfMarket(s.market);
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const money = (n: number | null | undefined, opts?: { sign?: boolean }) => formatMoney(n, cur, fx, showKrw, opts);
  const displayCur = toDisplay(1, cur, fx, showKrw).currency;
  const nxt = q?.afterMarket ?? null;
  const ev = q && s.quantity && s.avgPrice ? { profit: (q.price - s.avgPrice) * s.quantity, rate: ((q.price - s.avgPrice) / s.avgPrice) * 100, value: q.price * s.quantity } : null;
  const range52 = q && q.high52w && q.low52w && q.high52w > q.low52w ? Math.min(1, Math.max(0, (q.price - q.low52w) / (q.high52w - q.low52w))) : null;

  return (
    <Screen
      refreshing={stock.isRefetching}
      onRefresh={() => {
        void stock.refetch();
        void candles.refetch();
      }}
    >
      <Stack.Screen
        options={{
          title: s.name,
          headerRight: () => (
            <Pressable onPress={() => router.push(`/stocks/${c}/edit`)} accessibilityLabel="보유 정보 수정" hitSlop={8}>
              <Ionicons name="create-outline" size={22} color={t.ink} />
            </Pressable>
          ),
        }}
      />

      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <Muted>
                {s.code} · {s.market}
                {q?.industry ? ` · ${q.industry}` : ""}
              </Muted>
            </View>
            {q ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 }}>
                  <FlashPrice value={q.price} text={money(q.price)} style={{ color: t.ink, fontSize: font.hero, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] }} />
                  {q.live ? <Badge tone="good">실시간</Badge> : null}
                </View>
                <ChangeText value={q.change} text={`${money(q.change, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.body, fontWeight: "600" }} />
                {cur === "USD" && !showKrw && q.priceKrw ? <Muted>≈ {formatPrice(q.priceKrw, "KRW")}</Muted> : null}
                {cur === "USD" && showKrw ? <Muted>{formatPrice(q.price, "USD")} · 환율 {fx ? formatNumber(fx, 1) : "-"}원</Muted> : null}
                {nxt ? (
                  <ChangeText
                    value={nxt.change}
                    text={`${afterMarketLabel(nxt)} ${money(nxt.price)} (${money(nxt.change, { sign: true })}, ${formatPct(nxt.changeRate)})`}
                    style={{ fontSize: font.small }}
                  />
                ) : null}
                <Muted style={{ fontSize: font.tiny, marginTop: 2 }}>
                  {q.source.toUpperCase()}
                  {q.priceBasis ? ` · ${q.priceBasis}` : ""} · {relativeTime(q.asOf)}
                </Muted>
              </>
            ) : (
              <Text style={{ color: t.danger }}>{s.quoteError ?? "시세 미확인"}</Text>
            )}
          </View>
          {s.quantity ? <Badge tone="gold">{s.quantity}주 보유</Badge> : <Badge>관심</Badge>}
        </View>

        {q && range52 !== null ? (
          <View style={{ gap: 4, marginTop: space.xs }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Muted style={{ fontSize: font.tiny }}>52주 최저 {money(q.low52w)}</Muted>
              <Muted style={{ fontSize: font.tiny }}>52주 최고 {money(q.high52w)}</Muted>
            </View>
            <View style={[styles.rangeTrack, { backgroundColor: t.surfaceAlt }]}>
              <View style={[styles.rangeFill, { width: `${Math.round(range52 * 100)}%`, backgroundColor: range52 > 0.5 ? t.up : t.down }]} />
              <View style={[styles.rangeKnob, { left: `${Math.round(range52 * 100)}%`, backgroundColor: t.ink, borderColor: t.surface }]} />
            </View>
            <Muted style={{ fontSize: font.tiny, textAlign: "center" }}>52주 범위의 {Math.round(range52 * 100)}% 위치</Muted>
          </View>
        ) : null}

        {q ? (
          <View style={styles.grid}>
            <Stat label="시가" value={money(q.open)} />
            <Stat label="고가" value={money(q.high)} tone="up" />
            <Stat label="저가" value={money(q.low)} tone="down" />
            <Stat label="거래량" value={formatVolume(q.volume)} />
            <Stat label="시가총액" value={formatKrwCompact(q.marketCap, cur)} />
            <Stat label="PER" value={q.per !== null ? `${formatNumber(q.per, 1)}배` : "-"} />
            <Stat label="PBR" value={q.pbr !== null ? `${formatNumber(q.pbr, 2)}배` : "-"} />
            <Stat label="EPS" value={q.eps !== null ? formatPrice(q.eps, cur) : "-"} />
            <Stat label="BPS" value={q.bps !== null ? formatPrice(q.bps, cur) : "-"} />
            <Stat label="배당수익률" value={q.dividendYieldPct !== null && q.dividendYieldPct !== undefined ? `${formatNumber(q.dividendYieldPct, 2)}%` : "-"} />
            <Stat label="주당 배당" value={q.dividendPerShare !== null && q.dividendPerShare !== undefined ? formatPrice(q.dividendPerShare, cur) : "-"} />
            <Stat label="전일 종가" value={money(q.prevClose)} />
          </View>
        ) : null}
        {ev ? (
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line, paddingTop: space.sm }}>
            <Row label={`보유 ${s.quantity}주 · 평단 ${money(s.avgPrice)}`} value={<ChangeText value={ev.profit} text={`${money(ev.profit, { sign: true })} (${formatPct(ev.rate)})`} style={{ fontSize: font.small, fontWeight: "700" }} />} />
            <Row label={`평가금액 (${displayCur === "KRW" ? "원화" : "달러"})`} value={money(ev.value)} />
          </View>
        ) : null}
        {s.memo ? <Muted>메모: {s.memo}</Muted> : null}
      </Card>

      <Card>
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
      </Card>

      <Segmented options={TABS} value={tab} onChange={setTab} />
      {tab === "news" ? <NewsTab code={c} us={isUsMarket(s.market)} /> : <AnalysisTab code={c} kind={tab} />}

      {briefings.data && briefings.data.length > 0 ? (
        <View style={{ gap: space.md }}>
          <SectionTitle>최근 브리핑</SectionTitle>
          {briefings.data.map((b) => (
            <BriefingCard key={b.id} briefing={b} mode="summary" showName={false} />
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

function AnalysisTab({ code, kind }: { code: string; kind: AnalysisKind }) {
  const a = useAnalysis(code, kind);
  const { refreshAnalysis } = useStockMutations();
  const busy = refreshAnalysis.isPending && refreshAnalysis.variables?.kind === kind;
  if (a.isLoading || busy) return <Card><Loading label="분석 생성 중 (처음에는 30초 안팎 걸립니다)" /></Card>;
  if (a.isError) return <Card><ErrorView error={a.error} onRetry={() => void a.refetch()} /></Card>;
  const d = a.data!;
  return (
    <Card>
      <MarkdownView>{d.content}</MarkdownView>
      {d.missing.length ? <Muted>데이터 미확인: {d.missing.join(", ")}</Muted> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Muted>
          {formatDateKo(d.createdAt, true)} 생성{d.cached ? " (캐시)" : ""}
        </Muted>
        <Button title="다시 생성" variant="secondary" icon="refresh" compact onPress={() => refreshAnalysis.mutate({ code, kind })} />
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
        {d.news.length === 0 && !d.newsError ? <Muted>최근 뉴스가 없습니다.</Muted> : null}
        {d.news.map((item, i) => (
          <Pressable key={`${item.url}-${i}`} onPress={() => void Linking.openURL(item.url)} accessibilityRole="link" style={[styles.newsItem, { borderTopColor: t.line, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}>
            <Text style={{ color: t.ink, fontSize: font.body, lineHeight: 21 }}>{item.title}</Text>
            <Muted>
              {item.source ?? ""} · {relativeTime(item.publishedAt) || formatDateKo(item.publishedAt)}
            </Muted>
          </Pressable>
        ))}
      </Card>
      <Card>
        <SectionTitle>공시 (DART)</SectionTitle>
        {d.disclosuresError ? <Muted>{d.disclosuresError}</Muted> : null}
        {us ? <Muted>미국 종목은 DART 공시가 없습니다. 실적·공시는 뉴스와 회사 소개를 참고하세요.</Muted> : null}
        {d.disclosures.length === 0 && !d.disclosuresError && !us ? <Muted>최근 30일 공시가 없습니다.</Muted> : null}
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

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
  newsItem: { paddingVertical: space.sm, gap: 2 },
  rangeTrack: { height: 6, borderRadius: 3, overflow: "visible", justifyContent: "center" },
  rangeFill: { height: 6, borderRadius: 3 },
  rangeKnob: { position: "absolute", width: 14, height: 14, borderRadius: 7, marginLeft: -7, borderWidth: 2, top: -4 },
});
