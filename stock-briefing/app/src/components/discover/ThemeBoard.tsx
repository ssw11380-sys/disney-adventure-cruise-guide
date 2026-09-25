import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDiscoverThemes } from "@/api/hooks";
import type { DiscoverMarket, ThemeKind, ThemePeriod, ThemeSummary } from "@/api/types";
import { Empty, ErrorView } from "@/components/ui";
import { speakRate } from "@/lib/a11y";
import { heatColumns, themeLeaderLineW, themeListColumns } from "@/lib/discoverColumns";
import { formatDateKo, formatPct } from "@/lib/format";
import { useSticky } from "@/lib/useSticky";
import { changeColor, font, slopFor, space, touch, useFontScale, useTheme } from "@/theme";
import { foldScreens } from "@/tokens";
import { DISCLAIMER } from "@/components/Screen";
import { StatusLine, usePull } from "./shared";
import { SkeletonRows } from "./Skeleton";
import { HEAT_MAX, HeatLegend, HeatTile } from "./ThemeHeatmap";
import { useThemeRowH, ThemeRow } from "./ThemeRow";

const PERIODS: { value: ThemePeriod; label: string }[] = [
  { value: "day", label: "오늘" },
  { value: "week", label: "1주" },
  { value: "month", label: "1개월" },
];
const PERIOD_WORD: Record<ThemePeriod, string> = { day: "오늘", week: "1주", month: "1개월" };

/**
 * 테마·업종 보드: [테마|업종] · 기간(오늘/1주/1개월) · 보기(목록/히트맵) · 정렬(상승/하락).
 * 머리에 전체 분포(오른 테마 vs 내린 테마 막대)와 가장 강한·약한 테마를 보여 준 뒤, 목록 또는 색 타일 히트맵을 그린다.
 * 넓은 창(3-42, wideW = 보드가 받은 폭 — 플래그 foldLayout 이 켜진 폭 600 이상에서만 부르는 쪽이 준다):
 *  - 히트맵 칸 수 = 폭 ÷ 150 (접은 화면은 지금처럼 3칸) · 목록은 2칸 (한 칸에 들어가는 만큼만 대표 종목, 등락률은 말줄임 없음)
 *  - 칸 수는 기준선에서 켜기·끄기 여유(foldScreens.hysteresis)를 둔다
 *  - 테마/업종·기간·보기 버튼은 폭도 44 이상 (진단 34)
 * wideW 가 없으면 지금과 똑같다
 */
export function ThemeBoard({ market, wideW }: { market: DiscoverMarket; wideW?: number }) {
  const t = useTheme();
  const fontScale = useFontScale();
  const wide = wideW !== undefined;
  // 히트맵 칸 수: 좌우 여백(heatRow)을 뺀 폭으로. 목록 칸 수: 한 칸이 themeCellMin 이상이면 두 칸.
  // 둘 다 기준선 근처에서는 바로 전 값을 지킨다 (히스테리시스 — 칸 수가 바뀌면 목록을 새로 만들어 스크롤 위치를 잃으므로).
  // 좁은 창에서는 바로 전 값을 지운다(null): 접은 화면에서 펴면 처음 연 것과 같은 칸 수
  const heatSticky = useSticky(wide ? wideW - 2 * HEAT_PAD : null, (w) => heatColumns(w, fontScale));
  const listSticky = useSticky(wide ? wideW : null, (w) => themeListColumns(w, fontScale));
  const heatCols = wide ? (heatSticky ?? 3) : 3;
  const listCols = wide ? (listSticky ?? 1) : 1;
  // 여러 칸이면 한 칸의 대표 종목 줄 폭 (줄마다 들어가는 만큼만 대표 종목을 보이고, 등락률은 말줄임 없이)
  const lineW = wide && listCols > 1 ? themeLeaderLineW(wideW / listCols, fontScale) : 0;
  const [kind, setKind] = useState<ThemeKind>("theme");
  const [period, setPeriod] = useState<ThemePeriod>("day");
  const [view, setView] = useState<"list" | "heat">("list");
  const [order, setOrder] = useState<"up" | "down">("up");
  const q = useDiscoverThemes(market, kind, period);
  const { pulling, onPull } = usePull(q.refetch);
  // 테마/업종·기간을 바꾸는 동안에는 이전 값을 흐리게 보여 준다
  const data = q.data;
  const switching = q.isPlaceholderData;

  const all = useMemo(() => data?.themes ?? [], [data]);
  // 서버가 대신 준 분류(미국 테마 실패 → 산업 분류)면 그 이름으로
  const shownKind: ThemeKind = data?.kind ?? kind;
  // 바꾸는 중(이전 값을 흐리게 보여 줄 때)에도 화면의 숫자와 같은 기간으로 열고 칠한다
  const shownPeriod: ThemePeriod = data?.period ?? period;
  const kindWord = shownKind === "theme" ? "테마" : "업종";
  const rowH = useThemeRowH();
  const themes = useMemo(() => [...all].sort((a, b) => (order === "up" ? b.changeRate - a.changeRate : a.changeRate - b.changeRate)), [all, order]);
  const rising = all.filter((x) => x.changeRate > 0).length;
  const falling = all.filter((x) => x.changeRate < 0).length;
  const flat = all.length - rising - falling;
  const best = themes.length ? (order === "up" ? themes[0] : themes.at(-1)) : undefined;
  const worst = themes.length ? (order === "up" ? themes.at(-1) : themes[0]) : undefined;
  const max = HEAT_MAX[shownPeriod];

  const open = useCallback(
    (th: ThemeSummary) =>
      router.push(
        `/discover/theme/${encodeURIComponent(th.id)}?market=${market}&kind=${shownKind}&name=${encodeURIComponent(th.name)}&period=${shownPeriod}&rate=${th.changeRate}` as never,
      ),
    [market, shownKind, shownPeriod],
  );
  // 여러 칸 목록의 칸 모양: 칸 폭을 나눠 갖고(마지막 줄 한 칸도 늘어나지 않게), 마지막 칸이 아니면 오른쪽에 구분선, 대표 종목 줄 폭.
  // 줄마다 같은 객체 (ThemeRow memo 유지)
  const cells = useMemo(
    () => Array.from({ length: listCols }, (_, i) => ({ width: `${100 / listCols}%` as const, divider: i < listCols - 1, lineW })),
    [listCols, lineW],
  );
  const renderRow = useCallback(
    ({ item, index }: { item: ThemeSummary; index: number }) =>
      listCols > 1 ? (
        <ThemeRow theme={item} rank={index + 1} kindWord={kindWord} onPress={open} cell={cells[index % listCols]} />
      ) : (
        <ThemeRow theme={item} rank={index + 1} kindWord={kindWord} onPress={open} />
      ),
    [open, kindWord, listCols, cells],
  );
  const renderTile = useCallback(
    ({ item }: { item: ThemeSummary }) => (wide ? <HeatTile theme={item} max={max} onPress={open} width={`${100 / heatCols}%`} /> : <HeatTile theme={item} max={max} onPress={open} />),
    [max, open, wide, heatCols],
  );

  const seg = (active: boolean) =>
    wide
      ? [styles.seg, { backgroundColor: active ? t.surfaceAlt : "transparent", borderColor: active ? t.accent : t.line }, styles.segWide]
      : [styles.seg, { backgroundColor: active ? t.surfaceAlt : "transparent", borderColor: active ? t.accent : t.line }];
  const segText = (active: boolean) => ({ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? ("700" as const) : ("500" as const) });
  /** 넓은 창의 가장 강한·약한 칸: 이름만 말줄임, 등락률은 줄이지 않는다 */
  const extremeWide = (label: string, th: ThemeSummary) => (
    <Pressable onPress={() => open(th)} style={styles.extremeWide} hitSlop={EXTREME_SLOP} accessibilityRole="button" accessibilityLabel={`${label} ${kindWord} ${th.name}, ${speakRate(th.changeRate) ?? "등락률 없음"}`}>
      <Text style={{ color: t.muted, fontSize: font.tiny }}>{label}</Text>
      <View style={styles.extremeLine}>
        <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
          {th.name}
        </Text>
        <Text style={{ color: changeColor(t, th.changeRate), fontSize: font.small, fontWeight: "700", flexShrink: 0 }}>{formatPct(th.changeRate)}</Text>
      </View>
    </Pressable>
  );

  const head = (
    <View>
      {data ? <StatusLine market={market} open={data.marketOpen} session={data.session} live={data.live} asOf={data.asOf} note={data.note} /> : null}
      {/* 테마/업종 · 기간 · 보기 */}
      <View style={[styles.controls, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
        <View style={styles.group}>
          {(["theme", "sector"] as const).map((k) => (
            <Pressable key={k} onPress={() => setKind(k)} accessibilityRole="button" accessibilityLabel={k === "theme" ? "테마별" : "업종별"} accessibilityState={{ selected: kind === k }} hitSlop={SEG_SLOP} style={seg(kind === k)}>
              <Text style={segText(kind === k)}>{k === "theme" ? "테마" : "업종"}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.group}>
          {PERIODS.map((p) => (
            <Pressable key={p.value} onPress={() => setPeriod(p.value)} accessibilityRole="button" accessibilityLabel={`기간 ${p.label}`} accessibilityState={{ selected: period === p.value }} hitSlop={SEG_SLOP} style={seg(period === p.value)}>
              <Text style={segText(period === p.value)}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.group}>
          <Pressable onPress={() => setView("list")} accessibilityRole="button" accessibilityLabel="목록으로 보기" accessibilityState={{ selected: view === "list" }} hitSlop={SEG_SLOP} style={seg(view === "list")}>
            <Ionicons name="list" size={15} color={view === "list" ? t.ink : t.muted} />
          </Pressable>
          <Pressable onPress={() => setView("heat")} accessibilityRole="button" accessibilityLabel="히트맵으로 보기" accessibilityState={{ selected: view === "heat" }} hitSlop={SEG_SLOP} style={seg(view === "heat")}>
            <Ionicons name="grid" size={14} color={view === "heat" ? t.ink : t.muted} />
          </Pressable>
        </View>
      </View>

      {/* 전체 분포 요약 */}
      {all.length ? (
        <View style={[styles.breadth, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
          <View style={wide ? [styles.breadthTop, styles.breadthTopWide] : styles.breadthTop}>
            <Text style={{ color: t.muted, fontSize: font.small }}>
              {PERIOD_WORD[shownPeriod]} {kindWord} {all.length}개 · 상승 <Text style={{ color: t.up, fontWeight: "800" }}>{rising}</Text> · 하락{" "}
              <Text style={{ color: t.down, fontWeight: "800" }}>{falling}</Text>
            </Text>
            {/* 넓은 창: 가장 강한·약한을 이 줄에 합쳐 목록에 높이를 넘긴다 */}
            {wide ? (
              <View style={[styles.extremesInline, { minWidth: Math.round(foldScreens.themeExtremesMinW * fontScale) }]}>
                {best ? extremeWide("가장 강한", best) : null}
                {worst ? extremeWide("가장 약한", worst) : null}
              </View>
            ) : null}
            <Pressable
              onPress={() => setOrder(order === "up" ? "down" : "up")}
              accessibilityRole="button"
              accessibilityLabel={`${order === "up" ? "상승률순" : "하락률순"}. 누르면 ${order === "up" ? "하락률순" : "상승률순"}으로`}
              hitSlop={SEG_SLOP}
              style={[styles.sortBtn, { borderColor: t.line }]}
            >
              <Ionicons name={order === "up" ? "arrow-up" : "arrow-down"} size={12} color={order === "up" ? t.up : t.down} />
              <Text style={{ color: t.ink, fontSize: font.tiny, fontWeight: "700" }}>{order === "up" ? "상승률순" : "하락률순"}</Text>
            </Pressable>
          </View>
          <View style={[styles.breadthBar, { backgroundColor: t.surfaceAlt }]}>
            {rising ? <View style={{ flex: rising, backgroundColor: t.up }} /> : null}
            {flat ? <View style={{ flex: flat, backgroundColor: t.lineStrong }} /> : null}
            {falling ? <View style={{ flex: falling, backgroundColor: t.down }} /> : null}
          </View>
          {wide ? null : (
            <View style={styles.extremes}>
              {best ? (
                <Pressable onPress={() => open(best)} style={styles.extreme} hitSlop={EXTREME_SLOP} accessibilityRole="button" accessibilityLabel={`가장 강한 ${kindWord} ${best.name}, ${speakRate(best.changeRate) ?? "등락률 없음"}`}>
                  <Text style={{ color: t.muted, fontSize: font.tiny }}>가장 강한</Text>
                  <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                    {best.name} <Text style={{ color: changeColor(t, best.changeRate) }}>{formatPct(best.changeRate)}</Text>
                  </Text>
                </Pressable>
              ) : null}
              {worst ? (
                <Pressable onPress={() => open(worst)} style={styles.extreme} hitSlop={EXTREME_SLOP} accessibilityRole="button" accessibilityLabel={`가장 약한 ${kindWord} ${worst.name}, ${speakRate(worst.changeRate) ?? "등락률 없음"}`}>
                  <Text style={{ color: t.muted, fontSize: font.tiny }}>가장 약한</Text>
                  <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
                    {worst.name} <Text style={{ color: changeColor(t, worst.changeRate) }}>{formatPct(worst.changeRate)}</Text>
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
          {view === "heat" ? <HeatLegend max={max} /> : null}
        </View>
      ) : null}
    </View>
  );

  if (q.isLoading) return <View>{head}<SkeletonRows height={rowH} rank={false} /></View>;
  // 오류여도 테마/업종·기간·보기 버튼은 남겨 다른 선택으로 돌아갈 수 있게
  if (q.isError && !data)
    return (
      <View style={{ flex: 1 }}>
        {head}
        <ErrorView error={q.error} onRetry={() => void q.refetch()} />
      </View>
    );

  const footer = themes.length ? (
    <Text style={[styles.footer, { color: t.muted }]}>
      {kindWord} 등락률: {data?.basis ?? "-"} · 출처: {data?.source ?? "-"}
      {all.some((x) => x.adjusted) ? "\n* 상장 첫날 종목(가격제한폭 없음)을 빼고 다시 계산한 값" : ""}
      {data?.updatedAt ? `\n테마 구성 갱신: ${formatDateKo(data.updatedAt, true)} (매일 자동)` : ""}
      {`\n${DISCLAIMER}`}
    </Text>
  ) : null;
  const empty = <Empty title={`${kindWord}를 불러오지 못했습니다`} hint="잠시 뒤 당겨서 새로고침 하세요." />;
  const refresh = <RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.muted} />;

  return view === "heat" ? (
    <FlatList
      // 칸 수가 바뀌면 목록을 새로 만든다 (FlatList 는 numColumns 를 그리는 중에 바꿀 수 없다)
      key={wide ? `heat${heatCols}` : "heat"}
      data={themes}
      keyExtractor={(it) => it.id}
      renderItem={renderTile}
      numColumns={heatCols}
      columnWrapperStyle={styles.heatRow}
      style={{ opacity: switching ? 0.55 : 1 }}
      initialNumToRender={24}
      windowSize={9}
      ListHeaderComponent={head}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      refreshControl={refresh}
    />
  ) : wide ? (
    // 넓은 창: 두 칸 목록 (1·2위가 첫 줄). getItemLayout 의 index 는 줄 번호
    <FlatList
      key={`list${listCols}`}
      data={themes}
      keyExtractor={(it) => it.id}
      renderItem={renderRow}
      numColumns={listCols}
      getItemLayout={(_, index) => ({ length: rowH, offset: rowH * index, index })}
      style={{ opacity: switching ? 0.55 : 1 }}
      initialNumToRender={16}
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
      getItemLayout={(_, index) => ({ length: rowH, offset: rowH * index, index })}
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

/** 테마/업종·기간·보기 버튼의 보이는 높이 32 → hitSlop 으로 44 (3-22) */
const SEG_H = 32;
const SEG_SLOP = slopFor(SEG_H, space.xxs);
/** 가장 강한·약한 칸(두 줄, 약 33) — 100% 배치는 그대로 두고 누르는 영역만 44 로 */
const EXTREME_SLOP = slopFor(33);
/** 히트맵 줄 좌우 여백 (heatRow) */
const HEAT_PAD = space.sm;

const styles = StyleSheet.create({
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  group: { flexDirection: "row", gap: space.xs },
  seg: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm, paddingVertical: space.xs, minHeight: SEG_H, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  // 넓은 창: 버튼 폭도 44 이상 (아이콘·'1주' 버튼이 31~35 로 좁았다 — 진단 34). 이웃과 겹치지 않게 hitSlop 대신 폭을 키운다
  segWide: { minWidth: touch.min, justifyContent: "center" },
  // 넓은 창: 분포 줄 가운데에 가장 강한·약한 두 칸
  // 최소 폭(foldScreens.themeExtremesMinW × 글자 배율)이 안 남으면 분포 줄 아래 줄로 (breadthTopWide 의 줄바꿈)
  extremesInline: { flex: 1, flexDirection: "row", gap: space.md, paddingHorizontal: space.md },
  extremeWide: { flex: 1, minWidth: 0, gap: space.xxs },
  extremeLine: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  breadth: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  breadthTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  breadthTopWide: { flexWrap: "wrap", rowGap: space.s },
  breadthBar: { height: 6, borderRadius: 3, overflow: "hidden", flexDirection: "row" },
  sortBtn: { flexDirection: "row", alignItems: "center", gap: space.xxs, paddingHorizontal: space.s, paddingVertical: space.xs, minHeight: SEG_H, borderRadius: 3, borderWidth: StyleSheet.hairlineWidth },
  extremes: { flexDirection: "row", gap: space.md },
  extreme: { flex: 1, gap: space.xxs },
  heatRow: { gap: 0, paddingHorizontal: HEAT_PAD },
  footer: { fontSize: font.tiny, textAlign: "center", paddingVertical: space.lg, paddingHorizontal: space.lg },
});
