import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useDiscoverRank, useDiscoverThemes } from "@/api/hooks";
import type { DiscoverMarket, DiscoverStock, RankCategory, ThemeSummary } from "@/api/types";
import { DISCOVER_COL, DISCOVER_ROW_H, DiscoverRow } from "@/components/discover/DiscoverRow";
import { openStock, StatusLine, useAddWatch, useMarks } from "@/components/discover/shared";
import { SkeletonRows } from "@/components/discover/Skeleton";
import { THEME_ROW_H, ThemeRow } from "@/components/discover/ThemeRow";
import { Chip, Empty, ErrorView, Segmented, TableHead } from "@/components/ui";
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
      {category === "themes" ? <ThemeList key={market} market={market} /> : <RankList key={`${market}:${category}`} market={market} category={category} />}
    </View>
  );
}

function RankList({ market, category }: { market: DiscoverMarket; category: RankCategory }) {
  const t = useTheme();
  const { showKrw } = useSettings();
  const q = useDiscoverRank(market, category);
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
      {first ? <StatusLine open={first.marketOpen} asOf={first.asOf} note={first.note} /> : null}
      <TableHead>
        <Text style={[styles.th, { color: t.muted, width: DISCOVER_COL.rank }]}>순위</Text>
        <Text style={[styles.th, { color: t.muted, flex: 1 }]}>종목명</Text>
        <Text style={[styles.th, { color: t.muted, width: DISCOVER_COL.price, textAlign: "right" }]}>현재가·등락률</Text>
        <Text style={[styles.th, { color: t.muted, width: DISCOVER_COL.right, textAlign: "right" }]}>{metric === "volume" ? "거래량" : "거래대금"}</Text>
      </TableHead>
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
        q.isFetchingNextPage ? (
          <ActivityIndicator style={{ marginVertical: space.lg }} color={t.muted} />
        ) : q.hasNextPage ? (
          <Pressable onPress={() => void q.fetchNextPage()} style={[styles.more, { borderColor: t.line }]} accessibilityRole="button">
            <Text style={{ color: t.muted, fontSize: font.small }}>더 보기</Text>
          </Pressable>
        ) : items.length ? (
          <Text style={[styles.footer, { color: t.muted }]}>출처: {first?.source ?? "-"} · 투자 판단의 책임은 본인에게 있습니다</Text>
        ) : null
      }
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      }}
      refreshControl={<RefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => void q.refetch()} tintColor={t.muted} />}
    />
  );
}

function ThemeList({ market }: { market: DiscoverMarket }) {
  const t = useTheme();
  const q = useDiscoverThemes(market);
  const [order, setOrder] = useState<"up" | "down">("up");
  const themes = useMemo(() => {
    const list = [...(q.data?.themes ?? [])];
    return list.sort((a, b) => (order === "up" ? b.changeRate - a.changeRate : a.changeRate - b.changeRate));
  }, [q.data, order]);
  const rising = (q.data?.themes ?? []).filter((x) => x.changeRate > 0).length;
  const falling = (q.data?.themes ?? []).filter((x) => x.changeRate < 0).length;
  const open = useCallback(
    (th: ThemeSummary) => router.push(`/discover/theme/${encodeURIComponent(th.id)}?market=${market}&name=${encodeURIComponent(th.name)}` as never),
    [market],
  );
  const renderItem = useCallback(({ item, index }: { item: ThemeSummary; index: number }) => <ThemeRow theme={item} rank={index + 1} onPress={open} />, [open]);

  const head = (
    <>
      {q.data ? <StatusLine open={q.data.marketOpen} asOf={q.data.asOf} /> : null}
      <View style={[styles.themeBar, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <Text style={{ color: t.muted, fontSize: font.small }}>
          {q.data ? (
            <>
              상승 테마 <Text style={{ color: t.up, fontWeight: "700" }}>{rising}</Text> · 하락 테마 <Text style={{ color: t.down, fontWeight: "700" }}>{falling}</Text>
            </>
          ) : (
            "테마"
          )}
        </Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Chip label="상승률순" active={order === "up"} onPress={() => setOrder("up")} />
          <Chip label="하락률순" active={order === "down"} onPress={() => setOrder("down")} />
        </View>
      </View>
    </>
  );

  if (q.isLoading) return <View>{head}<SkeletonRows height={THEME_ROW_H} /></View>;
  if (q.isError && !q.data) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <FlatList
      data={themes}
      keyExtractor={(it) => it.id}
      renderItem={renderItem}
      getItemLayout={(_, index) => ({ length: THEME_ROW_H, offset: THEME_ROW_H * index, index })}
      initialNumToRender={12}
      windowSize={9}
      removeClippedSubviews
      ListHeaderComponent={head}
      ListEmptyComponent={<Empty title="테마를 불러오지 못했습니다" hint="잠시 뒤 당겨서 새로고침 하세요." />}
      ListFooterComponent={themes.length ? <Text style={[styles.footer, { color: t.muted }]}>테마 등락률: {q.data?.basis ?? "-"} · 출처: {q.data?.source ?? "-"}</Text> : null}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={t.muted} />}
    />
  );
}

const styles = StyleSheet.create({
  chipsWrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: "row", gap: 6, paddingHorizontal: space.lg, paddingVertical: space.sm },
  th: { fontSize: font.tiny, fontWeight: "600" },
  more: { margin: space.lg, paddingVertical: 10, alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  footer: { fontSize: font.tiny, textAlign: "center", paddingVertical: space.lg, paddingHorizontal: space.lg },
  themeBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
});
