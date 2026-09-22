import { Ionicons } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAnalysis, useBriefings, useCandles, useStock, useStockMutations, useStockNews } from "@/api/hooks";
import type { AnalysisKind, CandlePeriod } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { CandleChart } from "@/components/CandleChart";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, ChangeText, ErrorView, Loading, Muted, Row, SectionTitle, Segmented } from "@/components/ui";
import { afterMarketLabel, currencyOfMarket, formatDateKo, formatKrwCompact, formatNumber, formatPct, formatPrice, formatVolume, isUsMarket, relativeTime } from "@/lib/format";
import { font, space, useTheme } from "@/theme";

type Tab = AnalysisKind | "news";
const TABS: { value: Tab; label: string }[] = [
  { value: "company", label: "회사 소개" },
  { value: "value", label: "가치투자" },
  { value: "technical", label: "기술적 분석" },
  { value: "news", label: "뉴스·공시" },
];

/** 종목 상세: 시세 헤더, 캔들 차트, 4개 탭, 최근 브리핑 */
export default function StockDetailScreen() {
  const t = useTheme();
  const { code } = useLocalSearchParams<{ code: string }>();
  const c = code ?? "";
  const stock = useStock(c);
  const [period, setPeriod] = useState<CandlePeriod>("D");
  const [tab, setTab] = useState<Tab>("company");
  // 과거 구간 이동과 120 이평선을 위해 넉넉히 받는다 (일봉 약 3년, 주봉 5년, 월봉 10년)
  const candles = useCandles(c, period, period === "D" ? 800 : period === "W" ? 260 : 120);
  const briefings = useBriefings({ code: c, limit: 3 });

  if (!c) return null;
  if (stock.isLoading) return <Screen><Loading /></Screen>;
  if (stock.isError) return <Screen><ErrorView error={stock.error} onRetry={() => void stock.refetch()} /></Screen>;
  const s = stock.data!;
  const q = s.quote;
  const cur = q?.currency ?? currencyOfMarket(s.market);
  const nxt = q?.afterMarket ?? null;
  const ev = q && s.quantity && s.avgPrice ? { profit: (q.price - s.avgPrice) * s.quantity, rate: ((q.price - s.avgPrice) / s.avgPrice) * 100, value: q.price * s.quantity } : null;

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
          <View>
            <Muted>
              {s.code} · {s.market}
              {q ? ` · ${q.source.toUpperCase()}${q.priceBasis ? ` ${q.priceBasis}` : ""}${q.live ? " · 실시간" : ""} ${relativeTime(q.asOf)}` : ""}
            </Muted>
            {q ? (
              <>
                <Text style={{ color: t.ink, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatPrice(q.price, cur)}</Text>
                <ChangeText value={q.change} text={`${formatPrice(q.change, cur, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.body }} />
                {q.priceKrw ? <Muted>≈ {formatPrice(q.priceKrw, "KRW")}</Muted> : null}
                {nxt ? (
                  <ChangeText
                    value={nxt.change}
                    text={`${afterMarketLabel(nxt)} ${formatPrice(nxt.price, cur)} (${formatPrice(nxt.change, cur, { sign: true })}, ${formatPct(nxt.changeRate)})`}
                    style={{ fontSize: font.small }}
                  />
                ) : null}
              </>
            ) : (
              <Text style={{ color: t.danger }}>{s.quoteError ?? "시세 미확인"}</Text>
            )}
          </View>
          {s.quantity ? <Badge tone="good">{s.quantity}주 보유</Badge> : <Badge>관심</Badge>}
        </View>
        {q ? (
          <View style={styles.grid}>
            <Row label="시가" value={formatPrice(q.open, cur)} />
            <Row label="고가" value={formatPrice(q.high, cur)} />
            <Row label="저가" value={formatPrice(q.low, cur)} />
            <Row label="거래량" value={formatVolume(q.volume)} />
            <Row label="52주 고" value={formatPrice(q.high52w, cur)} />
            <Row label="52주 저" value={formatPrice(q.low52w, cur)} />
            <Row label="시가총액" value={formatKrwCompact(q.marketCap, cur)} />
            <Row label="PER / PBR" value={`${formatNumber(q.per, 1)} / ${formatNumber(q.pbr, 2)}`} />
          </View>
        ) : null}
        {ev ? (
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line, paddingTop: space.sm }}>
            <Row label={`보유 ${s.quantity}주 · 평단 ${formatPrice(s.avgPrice, cur)}`} value={<ChangeText value={ev.profit} text={`${formatPrice(ev.profit, cur, { sign: true })} (${formatPct(ev.rate)})`} style={{ fontSize: font.small }} />} />
            <Row label="평가금액" value={formatPrice(ev.value, cur)} />
          </View>
        ) : null}
        {s.memo ? <Muted>메모: {s.memo}</Muted> : null}
      </Card>

      <Card>
        <CandleChart candles={candles.data?.candles} period={period} onPeriodChange={setPeriod} loading={candles.isLoading} currency={cur} />
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
          {formatDateKo(d.createdAt, true)} 생성{d.cached ? " (캐시)" : ""} · {d.model}
        </Muted>
        <Button title="다시 생성" variant="secondary" icon="refresh" onPress={() => refreshAnalysis.mutate({ code, kind })} />
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
            <Text style={{ color: t.ink, fontSize: font.body }}>{item.title}</Text>
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
        {d.disclosures.length === 0 && !d.disclosuresError ? <Muted>최근 30일 공시가 없습니다.</Muted> : null}
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
  grid: { flexDirection: "row", flexWrap: "wrap", columnGap: space.lg, rowGap: 0, marginTop: space.sm },
  newsItem: { paddingVertical: space.sm, gap: 2 },
});
