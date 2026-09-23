import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef } from "react";
import { Alert, FlatList, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAnyMarketOpen, useHealth, useStockMutations, useStocks } from "@/api/hooks";
import { useLiveStream } from "@/lib/liveStream";
import type { Currency, RegisteredWithQuote } from "@/api/types";
import { Screen } from "@/components/Screen";
import { StockRow } from "@/components/StockRow";
import { Button, Card, ChangeText, Chip, ErrorView, Loading, Muted } from "@/components/ui";
import { formatPct, formatPrice } from "@/lib/format";
import { SORT_OPTIONS, useSettings, type SortKey } from "@/lib/settings";
import { refreshWidgets } from "@/widgets/refresh";
import { font, radius, space, useTheme } from "@/theme";

const fxOf = (s: RegisteredWithQuote): number | null => s.quote?.fxRate ?? (s.quote?.priceKrw && s.quote.price ? s.quote.priceKrw / s.quote.price : null);
/** 종목 통화 금액을 원화로. 환율을 모르면 null */
const toKrw = (n: number, s: RegisteredWithQuote): number | null => {
  const cur = s.quote?.currency ?? "KRW";
  if (cur === "KRW") return n;
  const fx = fxOf(s);
  return fx ? n * fx : null;
};

/** 홈: 자산 요약(히어로) + 정렬 + 등록 종목 목록 */
export default function StocksScreen() {
  const t = useTheme();
  const { data, isLoading, isError, error, refetch, isRefetching } = useStocks();
  const { sort, setSort, showKrw } = useSettings();
  const { remove } = useStockMutations();
  const health = useHealth();
  const live = useAnyMarketOpen();
  const stream = useLiveStream();

  const summary = useMemo(() => {
    const list = data ?? [];
    const held = list.filter((s) => s.evaluation && s.quote);
    const byCur: Record<Currency, { value: number; cost: number; day: number; count: number }> = { KRW: { value: 0, cost: 0, day: 0, count: 0 }, USD: { value: 0, cost: 0, day: 0, count: 0 } };
    let krwValue = 0, krwCost = 0, krwDay = 0, convertible = true;
    for (const s of held) {
      const cur = s.quote!.currency ?? "KRW";
      const ev = s.evaluation!;
      const day = s.quote!.change * (s.quantity ?? 0);
      byCur[cur].value += ev.marketValue;
      byCur[cur].cost += ev.costBasis;
      byCur[cur].day += day;
      byCur[cur].count += 1;
      const v = toKrw(ev.marketValue, s), c = toKrw(ev.costBasis, s), d = toKrw(day, s);
      if (v === null || c === null || d === null) convertible = false;
      else {
        krwValue += v;
        krwCost += c;
        krwDay += d;
      }
    }
    return { held: held.length, byCur, krw: convertible ? { value: krwValue, cost: krwCost, day: krwDay } : null, watch: list.length - held.length };
  }, [data]);

  const sorted = useMemo(() => {
    const list = [...(data ?? [])];
    const num = (s: RegisteredWithQuote, k: SortKey): number => {
      const q = s.quote;
      if (!q) return Number.NEGATIVE_INFINITY;
      if (k === "changeRate") return q.changeRate;
      if (k === "profit") return s.evaluation ? (toKrw(s.evaluation.profit, s) ?? s.evaluation.profit) : Number.NEGATIVE_INFINITY;
      if (k === "value") return s.evaluation ? (toKrw(s.evaluation.marketValue, s) ?? s.evaluation.marketValue) : Number.NEGATIVE_INFINITY;
      return 0;
    };
    switch (sort) {
      case "name":
        return list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      case "market":
        return list.sort((a, b) => a.market.localeCompare(b.market) || a.name.localeCompare(b.name, "ko"));
      case "changeRate":
      case "profit":
      case "value":
        return list.sort((a, b) => num(b, sort) - num(a, sort));
      default:
        return list;
    }
  }, [data, sort]);

  // 홈 화면 데이터가 새로 오면 홈 화면 위젯도 같이 갱신 (1분에 한 번)
  const lastWidgetPush = useRef(0);
  useEffect(() => {
    if (!data || Date.now() - lastWidgetPush.current < 60_000) return;
    lastWidgetPush.current = Date.now();
    void refreshWidgets({ stocks: data, showKrw });
  }, [data, showKrw]);

  const confirmRemove = (s: RegisteredWithQuote) =>
    Alert.alert(s.name, "어떻게 할까요?", [
      { text: "보유 정보 수정", onPress: () => router.push(`/stocks/${s.code}/edit`) },
      { text: "목록에서 삭제", style: "destructive", onPress: () => remove.mutate(s.code, { onError: (e) => Alert.alert("삭제 실패", e instanceof Error ? e.message : String(e)) }) },
      { text: "취소", style: "cancel" },
    ]);

  if (isLoading) return <Screen><Loading label="종목 불러오는 중" /></Screen>;
  if (isError) return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  const heroMain = showKrw && summary.krw ? { value: summary.krw.value, cost: summary.krw.cost, day: summary.krw.day, currency: "KRW" as Currency } : null;

  return (
    <Screen scroll={false}>
      <FlatList
        data={sorted}
        keyExtractor={(s) => s.code}
        contentContainerStyle={styles.list}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.sm }}>
            {summary.held > 0 ? (
              <LinearGradient colors={[t.heroFrom, t.heroTo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.hero, { shadowColor: t.shadow }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: t.heroMuted, fontSize: font.small, fontWeight: "600" }}>
                    보유 {summary.held}종목{summary.watch ? ` · 관심 ${summary.watch}` : ""}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: live.open ? "#5CE0A5" : t.heroMuted }} />
                    <Text style={{ color: t.heroMuted, fontSize: font.tiny }}>{live.open && stream.connected ? "실시간 스트리밍" : live.label}</Text>
                  </View>
                </View>
                {heroMain ? (
                  <HeroTotals value={heroMain.value} cost={heroMain.cost} day={heroMain.day} currency="KRW" />
                ) : (
                  (["KRW", "USD"] as const)
                    .filter((c) => summary.byCur[c].count > 0)
                    .map((c) => <HeroTotals key={c} value={summary.byCur[c].value} cost={summary.byCur[c].cost} day={summary.byCur[c].day} currency={c} label={summary.byCur.KRW.count && summary.byCur.USD.count ? (c === "KRW" ? "원화 종목" : "달러 종목") : undefined} />)
                )}
                {!heroMain && summary.byCur.USD.count > 0 && summary.krw ? (
                  <Text style={{ color: t.heroMuted, fontSize: font.tiny }}>원화 환산 합계 {formatPrice(summary.krw.value, "KRW")} · 설정에서 “미국 주식 원화로 보기”를 켜면 합쳐서 보여줍니다</Text>
                ) : null}
              </LinearGradient>
            ) : null}
            {(data?.length ?? 0) > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }}>
                {SORT_OPTIONS.map((o) => (
                  <Chip key={o.value} label={o.label} active={sort === o.value} onPress={() => void setSort(o.value)} />
                ))}
              </ScrollView>
            ) : null}
          </View>
        }
        renderItem={({ item }) => <StockRow stock={item} showKrw={showKrw} onPress={() => router.push(`/stocks/${item.code}`)} onLongPress={() => confirmRemove(item)} />}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        ListEmptyComponent={
          <View style={{ gap: space.md }}>
            <Card>
              <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "800", letterSpacing: -0.3 }}>시작해 볼까요</Text>
              <Muted>보유하거나 지켜보는 종목을 등록하면 매일 아침·저녁 브리핑이 오고, 홈에서 실시간 시세와 손익을 볼 수 있습니다.</Muted>
              <View style={{ gap: space.sm, marginTop: space.xs }}>
                <Step n={1} text="종목 등록 — 한글 이름이나 티커로 검색 (삼성전자, 테슬라, AAPL)" />
                <Step n={2} text="수량·평단을 넣으면 평가손익이 계산됩니다 (비우면 관심 종목)" />
                <Step n={3} text="설정에서 알림 시간을 정하면 그 시간에 브리핑 알림이 옵니다" />
              </View>
              <Button title="종목 등록" icon="add" onPress={() => router.push("/stocks/add")} />
              {health.data?.tossOpenApi?.configured ? <Button title="토스증권 보유 종목 가져오기" variant="secondary" icon="download-outline" onPress={() => router.push("/settings")} /> : null}
            </Card>
          </View>
        }
        ListFooterComponent={(data?.length ?? 0) > 0 ? <Muted style={{ textAlign: "center", marginTop: space.md }}>종목을 길게 누르면 수정·삭제할 수 있습니다 · 오른쪽 위 + 로 등록</Muted> : null}
      />
    </Screen>
  );
}

function HeroTotals({ value, cost, day, currency, label }: { value: number; cost: number; day: number; currency: Currency; label?: string }) {
  const t = useTheme();
  const profit = value - cost;
  const rate = cost > 0 ? (profit / cost) * 100 : 0;
  return (
    <View style={{ gap: 4 }}>
      {label ? <Text style={{ color: t.heroMuted, fontSize: font.tiny, fontWeight: "600" }}>{label}</Text> : null}
      <Text style={{ color: t.heroInk, fontSize: font.hero, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] }}>{formatPrice(value, currency)}</Text>
      <View style={{ flexDirection: "row", gap: space.lg, flexWrap: "wrap" }}>
        <View>
          <Text style={{ color: t.heroMuted, fontSize: font.tiny }}>오늘</Text>
          <ChangeText value={day} text={`${formatPrice(day, currency, { sign: true })}`} style={{ fontSize: font.small, fontWeight: "700", color: day > 0 ? "#FF8A80" : day < 0 ? "#8EC5FF" : t.heroMuted }} />
        </View>
        <View>
          <Text style={{ color: t.heroMuted, fontSize: font.tiny }}>총 손익</Text>
          <Text style={{ color: profit > 0 ? "#FF8A80" : profit < 0 ? "#8EC5FF" : t.heroMuted, fontSize: font.small, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
            {formatPrice(profit, currency, { sign: true })} ({formatPct(rate)})
          </Text>
        </View>
        <View>
          <Text style={{ color: t.heroMuted, fontSize: font.tiny }}>매입</Text>
          <Text style={{ color: t.heroInk, fontSize: font.small, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatPrice(cost, currency)}</Text>
        </View>
      </View>
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: t.accentInk, fontSize: font.tiny, fontWeight: "800" }}>{n}</Text>
      </View>
      <Text style={{ color: t.ink, fontSize: font.small, flex: 1, lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, paddingBottom: space.xl },
  hero: { borderRadius: radius.lg, padding: space.xl, gap: space.md, shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
});
