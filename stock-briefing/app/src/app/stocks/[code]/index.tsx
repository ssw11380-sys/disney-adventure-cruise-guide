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
import { formatDateKo, formatKrwCompact, formatNumber, formatPct, formatVolume, formatWon, relativeTime } from "@/lib/format";
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
  const candles = useCandles(c, period, period === "D" ? 90 : period === "W" ? 52 : 36);
  const briefings = useBriefings({ code: c, limit: 3 });

  if (!c) return null;
  if (stock.isLoading) return <Screen><Loading /></Screen>;
  if (stock.isError) return <Screen><ErrorView error={stock.error} onRetry={() => void stock.refetch()} /></Screen>;
  const s = stock.data!;
  const q = s.quote;
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
              {q ? ` · ${q.source.toUpperCase()} ${relativeTime(q.asOf)}` : ""}
            </Muted>
            {q ? (
              <>
                <Text style={{ color: t.ink, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatWon(q.price)}</Text>
                <ChangeText value={q.change} text={`${formatWon(q.change, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.body }} />
              </>
            ) : (
              <Text style={{ color: t.danger }}>{s.quoteError ?? "시세 미확인"}</Text>
            )}
          </View>
          {s.quantity ? <Badge tone="good">{s.quantity}주 보유</Badge> : <Badge>관심</Badge>}
        </View>
        {q ? (
          <View style={styles.grid}>
            <Row label="시가" value={formatWon(q.open)} />
            <Row label="고가" value={formatWon(q.high)} />
            <Row label="저가" value={formatWon(q.low)} />
            <Row label="거래량" value={formatVolume(q.volume)} />
            <Row label="52주 고" value={formatWon(q.high52w)} />
            <Row label="52주 저" value={formatWon(q.low52w)} />
            <Row label="시가총액" value={formatKrwCompact(q.marketCap)} />
            <Row label="PER / PBR" value={`${formatNumber(q.per, 1)} / ${formatNumber(q.pbr, 2)}`} />
          </View>
        ) : null}
        {ev ? (
          <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line, paddingTop: space.sm }}>
            <Row label={`보유 ${s.quantity}주 · 평단 ${formatWon(s.avgPrice)}`} value={<ChangeText value={ev.profit} text={`${formatWon(ev.profit, { sign: true })} (${formatPct(ev.rate)})`} style={{ fontSize: font.small }} />} />
            <Row label="평가금액" value={formatWon(ev.value)} />
          </View>
        ) : null}
        {s.memo ? <Muted>메모: {s.memo}</Muted> : null}
      </Card>

      <Card>
        <CandleChart candles={candles.data?.candles} period={period} onPeriodChange={setPeriod} loading={candles.isLoading} />
        {candles.isError ? <Text style={{ color: t.danger, fontSize: font.small }}>{candles.error instanceof Error ? candles.error.message : "차트 실패"}</Text> : null}
      </Card>

      <Segmented options={TABS} value={tab} onChange={setTab} />
      {tab === "news" ? <NewsTab code={c} /> : <AnalysisTab code={c} kind={tab} />}

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

function NewsTab({ code }: { code: string }) {
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
