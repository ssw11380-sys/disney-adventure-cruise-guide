import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { AUTO_REFRESH_MAX_PAGES, useDiscoverRank } from "@/api/hooks";
import type { DiscoverMarket, DiscoverStock, RankCategory } from "@/api/types";
import { DISCOVER_ROW_H, DiscoverRow } from "@/components/discover/DiscoverRow";
import { LineHead } from "@/components/StockLine";
import { openStock, StatusLine, useAddWatch, useMarks, usePull } from "@/components/discover/shared";
import { SkeletonRows } from "@/components/discover/Skeleton";
import { DISCLAIMER } from "@/components/Screen";
import { ThemeBoard } from "@/components/discover/ThemeBoard";
import { Chip, Empty, ErrorView, Segmented } from "@/components/ui";
import { useSettings } from "@/lib/settings";
import { font, space, useTheme } from "@/theme";

type Category = RankCategory | "themes";

const MARKETS: { value: DiscoverMarket; label: string }[] = [
  { value: "KR", label: "한국주식" },
  { value: "US", label: "미국주식" },
];

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "tradingValue", label: "거래대금" },
  { value: "volume", label: "거래량" },
  { value: "gainers", label: "급상승" },
  { value: "losers", label: "급하락" },
  { value: "themes", label: "테마" },
];

/** 발견 탭: 한국·미국 → 거래대금·거래량·급상승·급하락 순위, 테마(등락률순) → 테마 상세 */
export default function DiscoverScreen() {
  const t = useTheme();
  const [market, setMarket] = useState<DiscoverMarket>("KR");
  const [category, setCategory] = useState<Category>("tradingValue");
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Segmented options={MARKETS} value={market} onChange={setMarket} />
      <View style={[styles.chipsWrap, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {CATEGORIES.map((c) => (
            <Chip key={c.value} label={c.label} active={category === c.value} onPress={() => setCategory(c.value)} />
          ))}
        </ScrollView>
      </View>
      {category === "themes" ? <ThemeBoard key={market} market={market} /> : <RankList key={`${market}:${category}`} market={market} category={category} />}
    </View>
  );
}

function RankList({ market, category }: { market: DiscoverMarket; category: RankCategory }) {
  const t = useTheme();
  const { showKrw } = useSettings();
  const q = useDiscoverRank(market, category);
  const { pulling, onPull } = usePull(q.refetch);
  const marks = useMarks();
  const addWatch = useAddWatch();
  const pages = q.data?.pages;
  const first = pages?.[0];
  // 쪽을 이어 붙일 때 순위가 바뀌어 같은 종목이 두 번 나오지 않게
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: DiscoverStock[] = [];
    for (const p of pages ?? [])
      for (const it of p.items) {
        if (seen.has(it.code)) continue;
        seen.add(it.code);
        out.push(it);
      }
    return out;
  }, [pages]);
  const metric = category === "volume" ? "volume" : "tradingValue";
  const fx = first?.fxRate ?? null;

  const renderItem = useCallback(
    ({ item, index }: { item: DiscoverStock; index: number }) => (
      <DiscoverRow item={item} rank={index + 1} metric={metric} mark={marks.get(item.code) ?? null} showKrw={showKrw} fxRate={fx} onPress={openStock} onLongPress={addWatch} />
    ),
    [metric, marks, showKrw, fx, addWatch],
  );

  const head = (
    <>
      {first ? <StatusLine market={market} open={first.marketOpen} session={first.session} asOf={first.asOf} note={first.note} paused={(pages?.length ?? 0) > AUTO_REFRESH_MAX_PAGES} /> : null}
      <LineHead rank right={metric === "volume" ? "거래량" : "거래대금"} />
    </>
  );

  if (q.isLoading) return <View>{head}<SkeletonRows height={DISCOVER_ROW_H} /></View>;
  if (q.isError && !items.length) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <FlatList
      data={items}
      keyExtractor={(it) => it.code}
      renderItem={renderItem}
      getItemLayout={(_, index) => ({ length: DISCOVER_ROW_H, offset: DISCOVER_ROW_H * index, index })}
      initialNumToRender={14}
      maxToRenderPerBatch={20}
      windowSize={9}
      removeClippedSubviews
      ListHeaderComponent={head}
      ListEmptyComponent={<Empty title="표시할 종목이 없습니다" hint="장 시작 전이거나 데이터를 받지 못했습니다. 잠시 뒤 당겨서 새로고침 하세요." />}
      ListFooterComponent={
        <View>
          {q.isFetchingNextPage ? (
            <ActivityIndicator style={{ marginVertical: space.lg }} color={t.muted} />
          ) : q.hasNextPage ? (
            <Pressable onPress={() => void q.fetchNextPage()} style={[styles.more, { borderColor: t.line }]} accessibilityRole="button">
              <Text style={{ color: t.muted, fontSize: font.small }}>더 보기</Text>
            </Pressable>
          ) : null}
          {items.length ? (
            <Text style={[styles.footer, { color: t.muted }]}>
              출처: {first?.source ?? "-"}
              {"\n"}
              {DISCLAIMER}
            </Text>
          ) : null}
        </View>
      }
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.muted} />}
    />
  );
}

const styles = StyleSheet.create({
  chipsWrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: "row", gap: space.s, paddingHorizontal: space.lg, paddingVertical: space.sm },
  more: { margin: space.lg, paddingVertical: space.sm, alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  footer: { fontSize: font.tiny, textAlign: "center", paddingVertical: space.lg, paddingHorizontal: space.lg },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
