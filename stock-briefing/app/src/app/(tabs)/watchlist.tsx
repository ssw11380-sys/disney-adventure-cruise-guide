import React from "react";
import { FlatList, Text, View } from "react-native";
import { router } from "expo-router";
import type { WatchItem } from "@/api/types";
import { useFeature } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { Button, Card, Muted, Row, SectionTitle } from "@/components/ui";
import { formatPrice, formatPct, formatDateKo } from "@/lib/format";
import { watchDifference, watchDifferenceLabel } from "@/lib/watchlist";
import { usePlain } from "@/lib/plainFlag";
import { plainWatchAlert, plainWatchGap } from "@/lib/plainView";
import { gated } from "@/lib/features";
import { useWatchlist } from "@/lib/watchlistHooks";
import { changeColor, font, space, useTheme } from "@/theme";

/**
 * plain: 군더더기 글 줄이기 (플래그 plainView) — 현재가 옆에 등락률, 희망가까지의 차이는 표 한 줄("희망가까지 -$115.08 (-31.52%)"),
 * 시세 기준 시각·시세 종류 줄은 빼고(지연일 때만 '시세 지연'), 알림 줄은 '5% 알림 켜짐'. 주지 않으면 지금 나무 그대로
 */
export function WatchRow({ item, focused = false, plain = false }: { item: WatchItem; focused?: boolean; plain?: boolean }) {
  const t = useTheme(), q = item.quote, diff = watchDifference(q?.price, item.desiredPrice);
  if (plain) {
    const gap = plainWatchGap(q?.price, item.desiredPrice, item.currency);
    return <Card>
      <SectionTitle>{item.name} · {item.code}</SectionTitle>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm }}>
        <Text style={{ color: t.ink, fontSize: font.h2, fontVariant: ["tabular-nums"] }}>{q ? formatPrice(q.price, item.currency) : "현재가 확인 불가"}</Text>
        {q && typeof q.changeRate === "number" && Number.isFinite(q.changeRate) ? <Text style={{ color: changeColor(t, q.changeRate), fontSize: font.body, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatPct(q.changeRate)}</Text> : null}
        {q?.stale ? <Text style={{ color: t.warn, fontSize: font.small }}>시세 지연</Text> : null}
      </View>
      <Row label="관심 시작 가격" value={formatPrice(item.startPrice, item.currency)} />
      <Row label="구매희망 가격" value={formatPrice(item.desiredPrice, item.currency)} />
      {gap ? <Row label="희망가까지" value={gap} /> : null}
      <Muted>{plainWatchAlert(item.alerts)}</Muted>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s, marginTop: space.sm }}>
        <Button title="상세·차트" accessibilityLabel={`${item.name} 상세와 차트`} variant="secondary" onPress={() => router.push(`/stocks/${item.code}`)} />
        <Button title="가격·알림 수정" accessibilityLabel={`${item.name} 관심 가격과 알림 수정`} variant="ghost" onPress={() => router.push({ pathname: "/watch-edit", params: { code: item.code } } as never)} />
      </View>
    </Card>;
  }
  return <Card>
    <SectionTitle>{item.name} · {item.code}</SectionTitle>
    <Text style={{ color: t.ink, fontSize: font.h2, fontVariant: ["tabular-nums"] }}>{q ? formatPrice(q.price, item.currency) : "현재가 확인 불가"}</Text>
    <Row label="관심 시작 가격" value={formatPrice(item.startPrice, item.currency)} />
    <Row label="구매희망 가격" value={formatPrice(item.desiredPrice, item.currency)} />
    {diff ? <View style={{ gap: space.xs }}>
      <Text style={{ color: t.ink, fontSize: font.body }}>{focused ? watchDifferenceLabel(q?.price, item.desiredPrice, item.currency) : <>희망가까지 {diff.amount > 0 ? "+" : diff.amount < 0 ? "−" : ""}{formatPrice(Math.abs(diff.amount), item.currency)} ({formatPct(diff.percent)})</>}</Text>
      {diff.reached ? <Muted>현재가가 구매희망 가격 이하입니다{q?.stale ? " · 지난 시세 기준" : ""}</Muted> : null}
    </View> : null}
    <Muted>{q ? `${q.stale ? "시세 지연 · " : ""}${focused ? "시세 기준 " : ""}${formatDateKo(q.asOf, focused)}${focused ? " (한국 시각)" : ""} · ${q.priceBasis ?? "제공 시세"}` : "시세를 받으면 가격 차이를 표시합니다"}</Muted>
    <Muted>관심 시작 대비 5% 구간 알림 {item.alerts ? "켜짐" : "꺼짐"}</Muted>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s, marginTop: space.sm }}>
      <Button title="상세·차트" accessibilityLabel={`${item.name} 상세와 차트`} variant="secondary" onPress={() => router.push(`/stocks/${item.code}`)} />
      <Button title="가격·알림 수정" accessibilityLabel={`${item.name} 관심 가격과 알림 수정`} variant="ghost" onPress={() => router.push({ pathname: "/watch-edit", params: { code: item.code } } as never)} />
    </View>
  </Card>;
}
export default function WatchlistScreen() {
  const q = useWatchlist();
  const focused = gated(useFeature("informationFocus", false), true);
  // 군더더기 글 줄이기 (플래그 plainView, fallback 꺼짐): 꺼져 있으면 아래 속성·머리 글이 지금과 같다
  const plain = usePlain();
  return <Screen scroll={false}>
    <FlatList data={q.available ? q.data?.items ?? [] : []} keyExtractor={s => s.code} renderItem={({ item }) => <WatchRow item={item} focused={focused} {...(plain ? { plain: true } : null)} />}
      refreshing={q.isFetching && !q.isPending} onRefresh={() => { void q.refetch(); }}
      contentContainerStyle={{ gap: space.sm, paddingBottom: space.lg }}
      ListHeaderComponent={<Card><SectionTitle>관심종목</SectionTitle>{plain ? null : <Muted>국내·미국 종목의 관심 가격과 구매희망 가격을 기록합니다. 잔고 합계에는 포함하지 않습니다.</Muted>}
        {q.available ? <Button title="관심종목 담기" icon="add" onPress={() => router.push("/watch-edit" as never)} /> : <Muted>이 계정 또는 서버에서 관심종목 기능을 사용할 수 없습니다.</Muted>}
        {q.isError ? <><Muted>목록을 새로 받지 못했습니다. 표시된 내용은 마지막 조회 결과입니다.</Muted><Button title="다시 불러오기" variant="secondary" onPress={() => { void q.refetch(); }} /></> : null}
      </Card>}
      ListEmptyComponent={q.available ? <Card><Muted>{q.isPending ? "관심종목을 불러오는 중입니다" : q.isError ? "연결을 확인한 뒤 다시 시도해 주세요" : "아직 담은 관심종목이 없습니다"}</Muted></Card> : null} />
  </Screen>;
}
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
