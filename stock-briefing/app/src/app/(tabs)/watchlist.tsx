import React from "react";
import { FlatList, Text, View } from "react-native";
import { router } from "expo-router";
import type { WatchItem } from "@/api/types";
import { Screen } from "@/components/Screen";
import { Button, Card, Muted, Row, SectionTitle } from "@/components/ui";
import { formatPrice, formatPct, formatDateKo } from "@/lib/format";
import { watchDifference } from "@/lib/watchlist";
import { useWatchlist } from "@/lib/watchlistHooks";
import { font, space, useTheme } from "@/theme";

export function WatchRow({ item }: { item: WatchItem }) {
  const t = useTheme(), q = item.quote, diff = watchDifference(q?.price, item.desiredPrice);
  return <Card>
    <SectionTitle>{item.name} · {item.code}</SectionTitle>
    <Text style={{ color: t.ink, fontSize: font.h2, fontVariant: ["tabular-nums"] }}>{q ? formatPrice(q.price, item.currency) : "현재가 확인 불가"}</Text>
    <Row label="관심 시작 가격" value={formatPrice(item.startPrice, item.currency)} />
    <Row label="구매희망 가격" value={formatPrice(item.desiredPrice, item.currency)} />
    {diff ? <View style={{ gap: space.xs }}>
      <Text style={{ color: t.ink, fontSize: font.body }}>희망가까지 {diff.amount > 0 ? "+" : diff.amount < 0 ? "−" : ""}{formatPrice(Math.abs(diff.amount), item.currency)} ({formatPct(diff.percent)})</Text>
      {diff.reached ? <Muted>현재가가 구매희망 가격 이하입니다{q?.stale ? " · 지난 시세 기준" : ""}</Muted> : null}
    </View> : null}
    <Muted>{q ? `${q.stale ? "시세 지연 · " : ""}${formatDateKo(q.asOf)} · ${q.priceBasis ?? "제공 시세"}` : "시세를 받으면 가격 차이를 표시합니다"}</Muted>
    <Muted>관심 시작 대비 5% 구간 알림 {item.alerts ? "켜짐" : "꺼짐"}</Muted>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s, marginTop: space.sm }}>
      <Button title="상세·차트" accessibilityLabel={`${item.name} 상세와 차트`} variant="secondary" onPress={() => router.push(`/stocks/${item.code}`)} />
      <Button title="가격·알림 수정" accessibilityLabel={`${item.name} 관심 가격과 알림 수정`} variant="ghost" onPress={() => router.push({ pathname: "/watch-edit", params: { code: item.code } } as never)} />
    </View>
  </Card>;
}
export default function WatchlistScreen() {
  const q = useWatchlist();
  return <Screen scroll={false}>
    <FlatList data={q.available ? q.data?.items ?? [] : []} keyExtractor={s => s.code} renderItem={({ item }) => <WatchRow item={item} />}
      refreshing={q.isFetching && !q.isPending} onRefresh={() => { void q.refetch(); }}
      contentContainerStyle={{ gap: space.sm, paddingBottom: space.lg }}
      ListHeaderComponent={<Card><SectionTitle>관심종목</SectionTitle><Muted>국내·미국 종목의 관심 가격과 구매희망 가격을 기록합니다. 잔고 합계에는 포함하지 않습니다.</Muted>
        {q.available ? <Button title="관심종목 담기" icon="add" onPress={() => router.push("/watch-edit" as never)} /> : <Muted>이 계정 또는 서버에서 관심종목 기능을 사용할 수 없습니다.</Muted>}
        {q.isError ? <><Muted>목록을 새로 받지 못했습니다. 표시된 내용은 마지막 조회 결과입니다.</Muted><Button title="다시 불러오기" variant="secondary" onPress={() => { void q.refetch(); }} /></> : null}
      </Card>}
      ListEmptyComponent={q.available ? <Card><Muted>{q.isPending ? "관심종목을 불러오는 중입니다" : q.isError ? "연결을 확인한 뒤 다시 시도해 주세요" : "아직 담은 관심종목이 없습니다"}</Muted></Card> : null} />
  </Screen>;
}
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
