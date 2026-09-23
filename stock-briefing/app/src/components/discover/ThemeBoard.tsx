import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDiscoverThemes } from "@/api/hooks";
import type { DiscoverMarket, ThemeKind, ThemePeriod, ThemeSummary } from "@/api/types";
import { Empty, ErrorView } from "@/components/ui";
import { formatPct } from "@/lib/format";
import { changeColor, font, space, useTheme } from "@/theme";
import { StatusLine } from "./shared";
import { SkeletonRows } from "./Skeleton";
import { HEAT_MAX, HeatLegend, HeatTile } from "./ThemeHeatmap";
import { THEME_ROW_H, ThemeRow } from "./ThemeRow";

const PERIODS: { value: ThemePeriod; label: string }[] = [
  { value: "day", label: "오늘" },
  { value: "week", label: "1주" },
  { value: "month", label: "1개월" },
];
const PERIOD_WORD: Record<ThemePeriod, string> = { day: "오늘", week: "1주", month: "1개월" };

/**
 * 테마·업종 보드: [테마|업종] · 기간(오늘/1주/1개월) · 보기(목록/히트맵) · 정렬(상승/하락).
 * 머리에 전체 분포(오른 테마 vs 내린 테마 막대)와 가장 강한·약한 테마를 보여 준 뒤, 목록 또는 색 타일 히트맵을 그린다.
 */
export function ThemeBoard({ market }: { market: DiscoverMarket }) {
  const t = useTheme();
  const [kind, setKind] = useState<ThemeKind>("theme");
  const [period, setPeriod] = useState<ThemePeriod>("day");
  const [view, setView] = useState<"list" | "heat">("list");
  const [order, setOrder] = useState<"up" | "down">("up");
  const q = useDiscoverThemes(market, kind, period);
  // 테마/업종·기간을 바꾸는 동안에는 이전 값을 흐리게 보여 준다
  const data = q.data;
  const switching = q.isPlaceholderData;

  const all = useMemo(() => data?.themes ?? [], [data]);
  const themes = useMemo(() => [...all].sort((a, b) => (order === "up" ? b.changeRate - a.changeRate : a.changeRate - b.changeRate)), [all, order]);
  const rising = all.filter((x) => x.changeRate > 0).length;
  const falling = all.filter((x) => x.changeRate < 0).length;
  const flat = all.length - rising - falling;
  const best = themes.length ? (order === "up" ? themes[0] : themes.at(-1)) : undefined;
  const worst = themes.length ? (order === "up" ? themes.at(-1) : themes[0]) : undefined;
  const max = HEAT_MAX[period];

  const open = useCallback(
    (th: ThemeSummary) =>
      router.push(
        `/discover/theme/${encodeURIComponent(th.id)}?market=${market}&kind=${kind}&name=${encodeURIComponent(th.name)}&period=${period}&rate=${th.changeRate}` as never,
      ),
    [market, kind, period],
  );
  const renderRow = useCallback(({ item, index }: { item: ThemeSummary; index: number }) => <ThemeRow theme={item} rank={index + 1} onPress={open} />, [open]);
  const renderTile = useCallback(({ item }: { item: ThemeSummary }) => <HeatTile theme={item} max={max} onPress={open} />, [max, open]);

  const seg = (active: boolean) => [styles.seg, { backgroundColor: active ? t.surfaceAlt : "transparent", borderColor: active ? t.accent : t.line }];
  const segText = (active: boolean) => ({ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? ("700" as const) : ("500" as const) });

  const head = (
    <View>
      {data ? <StatusLine open={data.marketOpen} asOf={data.asOf} /> : null}
      {/* 테마/업종 · 기간 · 보기 */}
      <View style={[styles.controls, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <View style={styles.group}>
          {(["theme", "sector"] as const).map((k) => (
            <Pressable key={k} onPress={() => setKind(k)} accessibilityRole="button" accessibilityState={{ selected: kind === k }} style={seg(kind === k)}>
              <Text style={segText(kind === k)}>{k === "theme" ? "테마" : "업종"}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.group}>
          {PERIODS.map((p) => (
            <Pressable key={p.value} onPress={() => setPeriod(p.value)} accessibilityRole="button" accessibilityState={{ selected: period === p.value }} style={seg(period === p.value)}>
              <Text style={segText(period === p.value)}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.group}>
          <Pressable onPress={() => setView("list")} accessibilityLabel="목록으로 보기" accessibilityState={{ selected: view === "list" }} style={seg(view === "list")}>
            <Ionicons name="list" size={15} color={view === "list" ? t.ink : t.muted} />
          </Pressable>
          <Pressable onPress={() => setView("heat")} accessibilityLabel="히트맵으로 보기" accessibilityState={{ selected: view === "heat" }} style={seg(view === "heat")}>
            <Ionicons name="grid" size={14} color={view === "heat" ? t.ink : t.muted} />
          </Pressable>
        </View>
      </View>

      {/* 전체 분포 요약 */}
      {all.length ? (
        <View style={[styles.breadth, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
          <View style={styles.breadthTop}>
            <Text style={{ color: t.muted, fontSize: font.small }}>
              {PERIOD_WORD[period]} {kind === "theme" ? "테마" : "업종"} {all.length}개 · 상승 <Text style={{ color: t.up, fontWeight: "800" }}>{rising}</Text> · 하락{" "}
              <Text style={{ color: t.down, fontWeight: "800" }}>{falling}</Text>
            </Text>
            <Pressable onPress={() => setOrder(order === "up" ? "down" : "up")} accessibilityRole="button" style={[styles.sortBtn, { borderColor: t.line }]}>
              <Ionicons name={order === "up" ? "arrow-up" : "arrow-down"} size={12} color={order === "up" ? t.up : t.down} />
              <Text style={{ color: t.ink, fontSize: font.tiny, fontWeight: "700" }}>{order === "up" ? "상승률순" : "하락률순"}</Text>
            </Pressable>
          </View>
          <View style={[styles.breadthBar, { backgroundColor: t.surfaceAlt }]}>
            {rising ? <View style={{ flex: rising, backgroundColor: t.up }} /> : null}
            {flat ? <View style={{ flex: flat, backgroundColor: t.lineStrong }} /> : null}
            {falling ? <View style={{ flex: falling, backgroundColor: t.down }} /> : null}
          </View>
          <View style={styles.extremes}>
            {best ? (
              <Pressable onPress={() => open(best)} style={styles.extreme} accessibilityRole="button">
                <Text style={{ color: t.muted, fontSize: font.tiny }}>가장 강한</Text>
                <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                  {best.name} <Text style={{ color: changeColor(t, best.changeRate) }}>{formatPct(best.changeRate)}</Text>
                </Text>
              </Pressable>
            ) : null}
            {worst ? (
              <Pressable onPress={() => open(worst)} style={styles.extreme} accessibilityRole="button">
                <Text style={{ color: t.muted, fontSize: font.tiny }}>가장 약한</Text>
                <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                  {worst.name} <Text style={{ color: changeColor(t, worst.changeRate) }}>{formatPct(worst.changeRate)}</Text>
                </Text>
              </Pressable>
            ) : null}
          </View>
          {view === "heat" ? <HeatLegend max={max} /> : null}
        </View>
      ) : null}
    </View>
  );

  if (q.isLoading) return <View>{head}<SkeletonRows height={THEME_ROW_H} rank={false} /></View>;
  if (q.isError && !data) return <ErrorView error={q.error} onRetry={() => void q.refetch()} />;

  const footer = themes.length ? (
    <Text style={[styles.footer, { color: t.muted }]}>
      {kind === "theme" ? "테마" : "업종"} 등락률: {data?.basis ?? "-"} · 출처: {data?.source ?? "-"}
    </Text>
  ) : null;
  const empty = <Empty title={`${kind === "theme" ? "테마" : "업종"}를 불러오지 못했습니다`} hint="잠시 뒤 당겨서 새로고침 하세요." />;
  const refresh = <RefreshControl refreshing={q.isRefetching && !switching} onRefresh={() => void q.refetch()} tintColor={t.muted} />;

  return view === "heat" ? (
    <FlatList
      key="heat"
      data={themes}
      keyExtractor={(it) => it.id}
      renderItem={renderTile}
      numColumns={3}
      columnWrapperStyle={styles.heatRow}
      style={{ opacity: switching ? 0.55 : 1 }}
      initialNumToRender={24}
      windowSize={9}
      ListHeaderComponent={head}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      refreshControl={refresh}
    />
  ) : (
    <FlatList
      key="list"
      data={themes}
      keyExtractor={(it) => it.id}
      renderItem={renderRow}
      getItemLayout={(_, index) => ({ length: THEME_ROW_H, offset: THEME_ROW_H * index, index })}
      style={{ opacity: switching ? 0.55 : 1 }}
      initialNumToRender={12}
      windowSize={9}
      removeClippedSubviews
      ListHeaderComponent={head}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      refreshControl={refresh}
    />
  );
}

const styles = StyleSheet.create({
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  group: { flexDirection: "row", gap: 4 },
  seg: { flexDirection: "row", alignItems: "center", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  breadth: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  breadthTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  breadthBar: { height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row" },
  sortBtn: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  extremes: { flexDirection: "row", gap: space.md },
  extreme: { flex: 1, gap: 1 },
  heatRow: { gap: 0, paddingHorizontal: space.sm },
  footer: { fontSize: font.tiny, textAlign: "center", paddingVertical: space.lg, paddingHorizontal: space.lg },
});
