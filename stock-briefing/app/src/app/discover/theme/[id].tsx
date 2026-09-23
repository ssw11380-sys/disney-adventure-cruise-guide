import { Stack, useLocalSearchParams } from "expo-router";
import React, { useCallback, useMemo } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDiscoverTheme } from "@/api/hooks";
import type { DiscoverMarket, DiscoverStock, ThemeKind, ThemePeriod } from "@/api/types";
import { DISCOVER_COL, DISCOVER_ROW_H, DiscoverRow } from "@/components/discover/DiscoverRow";
import { openStock, StatusLine, useAddWatch, useMarks, usePull } from "@/components/discover/shared";
import { SkeletonRows } from "@/components/discover/Skeleton";
import { Empty, ErrorView, TableHead } from "@/components/ui";
import { formatDateKo, formatPct } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { changeColor, font, space, useTheme } from "@/theme";

/** 테마 상세: 테마 전체 등락률·상승/보합/하락 요약 → 구성 종목(등락률순) */
export default function ThemeDetailScreen() {
  const t = useTheme();
  const { id, market: m, name, kind: k, period: p, rate } = useLocalSearchParams<{ id: string; market?: string; name?: string; kind?: string; period?: string; rate?: string }>();
  const market: DiscoverMarket = m === "US" ? "US" : "KR";
  const kind: ThemeKind = k === "sector" ? "sector" : "theme";
  // 목록에서 본 기간의 등락률 (주·월이면 오늘 등락률과 함께 보여 준다)
  const period: ThemePeriod = p === "week" || p === "month" ? p : "day";
  const periodRate = rate !== undefined && rate !== "" && Number.isFinite(Number(rate)) ? Number(rate) : null;
  const q = useDiscoverTheme(market, kind, id ?? "");
  const { pulling, onPull } = usePull(q.refetch);
  const { showKrw } = useSettings();
  const marks = useMarks();
  const addWatch = useAddWatch();
  const theme = q.data?.theme;
  const items = useMemo(() => [...(q.data?.items ?? [])].sort((a, b) => b.changeRate - a.changeRate), [q.data]);
  const fx = q.data?.fxRate ?? null;
  const renderItem = useCallback(
    ({ item, index }: { item: DiscoverStock; index: number }) => (
      <DiscoverRow item={item} rank={index + 1} metric="tradingValue" mark={marks.get(item.code) ?? null} showKrw={showKrw} fxRate={fx} onPress={openStock} onLongPress={addWatch} />
    ),
    [marks, showKrw, fx, addWatch],
  );
  const total = theme ? theme.up + theme.flat + theme.down : 0;
  const c = changeColor(t, theme?.changeRate);

  const head = (
    <>
      <View style={[styles.summary, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <Text style={{ color: t.muted, fontSize: font.small }}>
          {market === "KR" ? "한국" : "미국"} {kind === "theme" ? "테마" : "업종"} · 구성 {total || items.length}종목 · 오늘
        </Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.md }}>
          <Text style={[styles.big, { color: c }]}>{theme ? formatPct(theme.changeRate) : "-"}</Text>
          {period === "day" && theme?.simpleAvg !== undefined ? (
            <Text style={{ color: t.muted, fontSize: font.small }}>
              시가총액 가중 · 단순 평균 <Text style={{ color: changeColor(t, theme.simpleAvg), fontWeight: "700" }}>{formatPct(theme.simpleAvg)}</Text>
            </Text>
          ) : null}
          {period !== "day" && periodRate !== null ? (
            <Text style={{ color: changeColor(t, periodRate), fontSize: font.body, fontWeight: "700" }}>
              {period === "week" ? "1주" : "1개월"} {formatPct(periodRate)}
            </Text>
          ) : null}
        </View>
        {theme && total > 0 ? (
          <>
            <View style={[styles.bar, { backgroundColor: t.surfaceAlt }]}>
              {theme.up ? <View style={{ flex: theme.up, backgroundColor: t.up }} /> : null}
              {theme.flat ? <View style={{ flex: theme.flat, backgroundColor: t.lineStrong }} /> : null}
              {theme.down ? <View style={{ flex: theme.down, backgroundColor: t.down }} /> : null}
            </View>
            <Text style={{ color: t.muted, fontSize: font.small, fontVariant: ["tabular-nums"] }}>
              상승 <Text style={{ color: t.up, fontWeight: "700" }}>{theme.up}</Text> · 보합 {theme.flat} · 하락 <Text style={{ color: t.down, fontWeight: "700" }}>{theme.down}</Text>
            </Text>
          </>
        ) : null}
        {q.data?.description ? (
          <Text style={{ color: t.muted, fontSize: font.small, lineHeight: 18 }} numberOfLines={4}>
            {q.data.description}
          </Text>
        ) : null}
        {q.data?.note ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{q.data.note}</Text> : null}
        {q.data?.basis ? (
          <Text style={{ color: t.muted, fontSize: font.tiny }}>
            등락률: {q.data.basis}
            {theme?.adjusted ? " · 상장 첫날 종목은 가격제한폭이 없어 평균에서 뺐습니다" : ""}
          </Text>
        ) : null}
      </View>
      {q.data ? <StatusLine market={market} open={q.data.marketOpen} asOf={q.data.asOf} /> : null}
      <TableHead>
        <Text style={[styles.th, { color: t.muted, width: DISCOVER_COL.rank }]}>순위</Text>
        <Text style={[styles.th, { color: t.muted, flex: 1 }]}>종목명</Text>
        <Text style={[styles.th, { color: t.muted, width: DISCOVER_COL.price, textAlign: "right" }]}>현재가·등락률</Text>
        <Text style={[styles.th, { color: t.muted, width: DISCOVER_COL.right, textAlign: "right" }]}>거래대금</Text>
      </TableHead>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: theme?.name ?? name ?? "테마" }} />
      {q.isLoading ? (
        <View>
          {head}
          <SkeletonRows height={DISCOVER_ROW_H} />
        </View>
      ) : q.isError && !q.data ? (
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.code}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: DISCOVER_ROW_H, offset: DISCOVER_ROW_H * index, index })}
          initialNumToRender={14}
          windowSize={9}
          removeClippedSubviews
          ListHeaderComponent={head}
          ListEmptyComponent={<Empty title="구성 종목이 없습니다" />}
          ListFooterComponent={
            items.length ? (
              <Text style={[styles.footer, { color: t.muted }]}>
                출처: {q.data?.source ?? "-"} · 길게 누르면 관심 종목에 추가
                {q.data?.updatedAt ? `\n테마 구성 갱신: ${formatDateKo(q.data.updatedAt, true)} (매일 자동)` : ""}
              </Text>
            ) : null
          }
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.muted} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  big: { fontSize: 30, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
  bar: { height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row" },
  th: { fontSize: font.tiny, fontWeight: "600" },
  footer: { fontSize: font.tiny, textAlign: "center", paddingVertical: space.lg, paddingHorizontal: space.lg },
});
