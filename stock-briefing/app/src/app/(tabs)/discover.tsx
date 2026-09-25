import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { AUTO_REFRESH_MAX_PAGES, useDiscoverRank } from "@/api/hooks";
import type { DiscoverMarket, DiscoverStock, RankCategory } from "@/api/types";
import { DiscoverRow, useDiscoverRowH } from "@/components/discover/DiscoverRow";
import { DiscoverTableHead, DiscoverTableRow } from "@/components/discover/DiscoverTable";
import { LineHead } from "@/components/StockLine";
import { openStock, StatusLine, useAddWatch, useBoxWidth, useMarks, usePull } from "@/components/discover/shared";
import { SkeletonRows } from "@/components/discover/Skeleton";
import { DISCLAIMER } from "@/components/Screen";
import { ThemeBoard } from "@/components/discover/ThemeBoard";
import { Chip, Empty, ErrorView, Segmented } from "@/components/ui";
import { pickDiscoverCols, type DiscoverColKey } from "@/lib/discoverColumns";
import { joinRankPages } from "@/lib/rankPages";
import { useSettings } from "@/lib/settings";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";
import { font, space, touch, useFontScale, useTheme } from "@/theme";
import { foldScreens } from "@/tokens";

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

/**
 * 발견 탭: 한국·미국 → 거래대금·거래량·급상승·급하락 순위, 테마(등락률순) → 테마 상세.
 * 넓은 창(3-42, 기능 플래그 foldLayout + 폭 600 이상): 시장·분류를 한 줄(44)로 합치고, 순위는 한 줄 표(44)로 열을 더 보인다.
 * 좁은 창(접은 화면)이나 플래그가 꺼져 있으면 지금 그대로.
 * 두 배치에서 목록(순위·테마 보드)은 같은 자리(세 번째 칸)에 두어, 접고 펼 때 테마 보드의 선택(테마/업종·기간·보기)이 남는다
 */
export default function DiscoverScreen() {
  const t = useTheme();
  const [market, setMarket] = useState<DiscoverMarket>("KR");
  const [category, setCategory] = useState<Category>("tradingValue");
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  // 탭 화면이라 왼쪽 세로 탭 막대가 켜져 있으면 그만큼 좁다 (재기 전 어림)
  const [boxW, onLayout] = useBoxWidth(fold.rail);
  // 표·히트맵 폭: 넓은 창만 (undefined = 휴대폰 목록)
  const tableW = wide ? boxW : undefined;
  const list = category === "themes" ? <ThemeBoard key={market} market={market} wideW={tableW} /> : <RankList key={`${market}:${category}`} market={market} category={category} tableW={tableW} />;
  if (wide)
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }} onLayout={onLayout}>
        <WideBar market={market} onMarket={setMarket} category={category} onCategory={setCategory} />
        {null}
        {list}
      </View>
    );
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Segmented options={MARKETS} value={market} onChange={setMarket} />
      <View style={[styles.chipsWrap, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {CATEGORIES.map((c) => (
            <Chip key={c.value} label={c.label} accessibilityLabel={`${c.label} 보기`} active={category === c.value} onPress={() => setCategory(c.value)} />
          ))}
        </ScrollView>
      </View>
      {list}
    </View>
  );
}

/**
 * 넓은 창의 맨 위 한 줄 (44): [한국주식|미국주식] 밑줄 탭 · 구분선 · 분류 칩.
 * 칩은 보이는 높이 32 + 위아래 여백 6(= 칩 hitSlop)이라 누르는 영역 44 가 줄 안에 들어간다. 큰 글씨로 넘치면 다음 줄로
 */
function WideBar({ market, onMarket, category, onCategory }: { market: DiscoverMarket; onMarket: (m: DiscoverMarket) => void; category: Category; onCategory: (c: Category) => void }) {
  const t = useTheme();
  return (
    <View style={[styles.wideBar, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      <View style={styles.marketTabs} accessibilityRole="tablist">
        {MARKETS.map((m) => {
          const active = m.value === market;
          return (
            <Pressable
              key={m.value}
              onPress={() => onMarket(m.value)}
              accessibilityRole="tab"
              accessibilityLabel={m.label}
              accessibilityState={{ selected: active }}
              style={[styles.marketTab, { borderBottomColor: active ? t.ink : "transparent" }]}
            >
              <Text style={{ color: active ? t.ink : t.muted, fontSize: font.body, fontWeight: active ? "700" : "500" }}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={[styles.barRule, { backgroundColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
      <View style={styles.wideChips}>
        {CATEGORIES.map((c) => (
          <Chip key={c.value} label={c.label} accessibilityLabel={`${c.label} 보기`} active={category === c.value} onPress={() => onCategory(c.value)} />
        ))}
      </View>
    </View>
  );
}

/** 순위 표의 기준 열 (머리 글자를 진하게): 거래대금·거래량 순위는 그 값, 급상승·급하락은 등락률 */
const EMPHASIS: Record<RankCategory, DiscoverColKey> = { tradingValue: "tradingValue", volume: "volume", gainers: "rate", losers: "rate" };

function RankList({ market, category, tableW }: { market: DiscoverMarket; category: RankCategory; tableW?: number }) {
  const t = useTheme();
  const phoneRowH = useDiscoverRowH();
  const fontScale = useFontScale();
  const { showKrw } = useSettings();
  const q = useDiscoverRank(market, category);
  const { pulling, onPull } = usePull(q.refetch);
  const marks = useMarks();
  const addWatch = useAddWatch();
  const pages = q.data?.pages;
  const first = pages?.[0];
  // 쪽을 이어 붙일 때 순위가 바뀌어 같은 종목이 두 번 나오지 않게, 첫 쪽과 다른 판의 쪽은 붙이지 않는다 (첫 쪽부터 다시 받는 중)
  const items = useMemo(() => joinRankPages(pages), [pages]);
  const metric = category === "volume" ? "volume" : "tradingValue";
  const fx = first?.fxRate ?? null;
  // 넓은 창: 한 줄 표 (보일 열은 표 폭·글자 배율로 고른다). 좁은 창은 두 줄 목록 그대로
  const table = useMemo(() => (tableW === undefined ? null : pickDiscoverCols(tableW, fontScale, metric)), [tableW, fontScale, metric]);
  const rowH = table ? foldScreens.tableRowH : phoneRowH;

  const renderItem = useCallback(
    ({ item, index }: { item: DiscoverStock; index: number }) =>
      table ? (
        <DiscoverTableRow item={item} rank={index + 1} table={table} metric={metric} mark={marks.get(item.code) ?? null} showKrw={showKrw} fxRate={fx} onPress={openStock} onLongPress={addWatch} />
      ) : (
        <DiscoverRow item={item} rank={index + 1} metric={metric} mark={marks.get(item.code) ?? null} showKrw={showKrw} fxRate={fx} onPress={openStock} onLongPress={addWatch} />
      ),
    [table, metric, marks, showKrw, fx, addWatch],
  );

  const head = (
    <>
      {first ? <StatusLine market={market} open={first.marketOpen} session={first.session} asOf={first.asOf} note={first.note} paused={(pages?.length ?? 0) > AUTO_REFRESH_MAX_PAGES} /> : null}
      {table ? <DiscoverTableHead table={table} emphasis={EMPHASIS[category]} /> : <LineHead rank right={metric === "volume" ? "거래량" : "거래대금"} />}
    </>
  );

  if (q.isLoading) return <View>{head}<SkeletonRows height={rowH} /></View>;
  if (q.isError && !items.length) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <FlatList
      data={items}
      keyExtractor={(it) => it.code}
      renderItem={renderItem}
      getItemLayout={(_, index) => ({ length: rowH, offset: rowH * index, index })}
      // 넓은 창 표는 한 화면에 20줄 가까이 보인다
      initialNumToRender={table ? 20 : 14}
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
            <Pressable onPress={() => void q.fetchNextPage()} style={[styles.more, { borderColor: t.line }]} accessibilityRole="button" accessibilityLabel="순위 더 보기">
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
  // 넓은 창 한 줄: 높이 44 (칩 32 + 위아래 6). 큰 글씨로 넘치면 다음 줄로
  wideBar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.md, minHeight: touch.min, paddingHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  marketTabs: { flexDirection: "row" },
  marketTab: { minHeight: touch.min, justifyContent: "center", paddingHorizontal: space.md, borderBottomWidth: 2 },
  barRule: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", marginVertical: space.md },
  wideChips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s, paddingVertical: space.s },
  more: { margin: space.lg, paddingVertical: space.sm, minHeight: touch.min, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  footer: { fontSize: font.tiny, textAlign: "center", paddingVertical: space.lg, paddingHorizontal: space.lg },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
