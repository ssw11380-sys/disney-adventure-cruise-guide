import Ionicons from "@expo/vector-icons/Ionicons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { useFeature, useHoldingThemes } from "@/api/hooks";
import type { HoldingThemes, HtMarket, HtMarketInfo } from "@/api/types";
import { StaleBanner, usePull } from "@/components/Freshness";
import { HoldingThemeRow } from "@/components/HoldingThemeRow";
import { Disclaimer, Screen } from "@/components/Screen";
import { Button, Chip, Empty, Loading } from "@/components/ui";
import { formatDateKo } from "@/lib/format";
import {
  BOTTOM_TITLE,
  BY_HOLDING_TITLE,
  byHoldingView,
  defaultMarket,
  EMPTY_HINT,
  EMPTY_TITLE,
  ERROR_HINT,
  ERROR_TITLE,
  marketChips,
  marketView,
  mostView,
  OFF_TITLE,
  PERIOD_LABEL,
  PREPARING_LINE,
  TOP_TITLE,
  UNMAPPED_TITLE,
  type HtPeriod,
  type ThemeRowView,
} from "@/lib/holdingThemes";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";
import { changeColor, font, layout, space, touch, useTheme } from "@/theme";

/**
 * 내 종목 테마 (3-35, 플래그 holdingThemes — 잔고 탭 '테마' 버튼·계좌 브리핑 카드의 '지금 기준으로 전체 보기').
 * 위에서부터: 많이 속한 테마 한 줄 → 시장·기간 칩 → 상태 줄 → 등락률 높은/낮은 3개(묶음 6개 이상) → 내 테마 전체 → 연결하지 못한 종목 → 종목별로 보기 → 기준.
 * 숫자는 서버가 발견 탭 값을 그대로 옮긴 것. 사실만 (판단·권유 없음), 색은 등락률 글자에만.
 * 플래그가 꺼져 있으면 요청하지 않는다(화면 작업 0건). 넓은 창(폭 840 이상)은 왼쪽 칸(요약·칩·높은/낮은 3개)과 오른쪽 칸(전체 이하)이 따로 스크롤,
 * 폭 600~839 는 한 단에 높은/낮은 3개만 두 칸 나란히
 */
const PREFS_KEY = "holdingThemes.chips.v1";

export default function HoldingThemesScreen() {
  const on = useFeature("holdingThemes", false);
  if (!on)
    return (
      <Screen>
        <Empty title={OFF_TITLE} hint="잔고 탭에서 보유 종목을 확인할 수 있습니다." action={<Button title="잔고로" icon="wallet-outline" variant="secondary" onPress={backToHoldings} />} />
      </Screen>
    );
  return <ThemesBody />;
}

function backToHoldings(): void {
  if (router.canGoBack?.()) router.back();
  else router.dismissTo?.("/");
}

/** 기기에 기억한 칩 (읽기·쓰기 실패는 없는 것으로 — 기본값으로 그대로 그린다) */
function useChipPrefs(): [{ market: HtMarket | null; period: HtPeriod }, (p: { market?: HtMarket; period?: HtPeriod }) => void] {
  const [prefs, setPrefs] = useState<{ market: HtMarket | null; period: HtPeriod }>({ market: null, period: "day" });
  useEffect(() => {
    let alive = true;
    try {
      void AsyncStorage.getItem(PREFS_KEY)
        .then((raw) => {
          const v = raw ? (JSON.parse(raw) as { market?: string; period?: string }) : null;
          if (alive && v) setPrefs({ market: v.market === "KR" || v.market === "US" ? v.market : null, period: v.period === "week" ? "week" : "day" });
        })
        .catch(() => undefined);
    } catch {
      /* 저장소를 못 쓰면 기본값 */
    }
    return () => {
      alive = false;
    };
  }, []);
  const save = useCallback((p: { market?: HtMarket; period?: HtPeriod }) => {
    setPrefs((cur) => {
      const next = { market: p.market ?? cur.market, period: p.period ?? cur.period };
      try {
        void AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)).catch(() => undefined);
      } catch {
        /* 기억만 못 할 뿐 화면은 그대로 */
      }
      return next;
    });
  }, []);
  return [prefs, save];
}

function ThemesBody() {
  const q = useHoldingThemes(true);
  const { pulling, onPull } = usePull(q.refetch);
  const d = q.data;
  const top = <StaleBanner query={q} />;
  if (d === undefined && !q.isError)
    return (
      <Screen top={top}>
        <Loading />
      </Screen>
    );
  if (d === undefined)
    return (
      <Screen refreshing={pulling} onRefresh={onPull}>
        <Empty title={ERROR_TITLE} hint={ERROR_HINT} action={<Button title="다시 시도" icon="refresh" variant="secondary" onPress={() => void q.refetch()} />} />
      </Screen>
    );
  if (d === null)
    return (
      <Screen>
        <Empty title={OFF_TITLE} hint="잔고 탭에서 보유 종목을 확인할 수 있습니다." action={<Button title="잔고로" icon="wallet-outline" variant="secondary" onPress={backToHoldings} />} />
      </Screen>
    );
  if (d.coverage.held === 0)
    return (
      <Screen refreshing={pulling} onRefresh={onPull} disclaimer>
        <Empty title={EMPTY_TITLE} hint={EMPTY_HINT} action={<Button title="잔고로" icon="wallet-outline" variant="secondary" onPress={backToHoldings} />} />
      </Screen>
    );
  return <ThemesView d={d} top={top} pulling={pulling} onPull={onPull} />;
}

function ThemesView({ d, top, pulling, onPull }: { d: HoldingThemes; top: React.ReactNode; pulling: boolean; onPull: () => void }) {
  const t = useTheme();
  const [prefs, savePrefs] = useChipPrefs();
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  const twoCol = wide && fold.width === "expanded";
  const market = defaultMarket(d, prefs.market);
  const period = prefs.period;
  const chips = marketChips(d);
  const view = useMemo(() => (market ? marketView(d, market, period) : null), [d, market, period]);
  const most = mostView(d);
  const byHolding = useMemo(() => byHoldingView(d, period), [d, period]);
  const [openByHolding, setOpenByHolding] = useState(false);
  const info: HtMarketInfo | undefined = market ? d.markets[market] : undefined;
  const preparing = Object.values(d.markets).some((m) => m?.preparing);

  // 스크롤 이동 (많이 속한 테마 조각 → 그 테마 줄, '연결하지 못한 N종목' → 그 구역)
  const mainRef = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, number>());
  /** 내 테마 전체 구역 안에서 줄의 위치 (구역 위치에 더해 스크롤한다 — 자식 onLayout 이 부모보다 먼저 올 수 있어서) */
  const rowOffsets = useRef(new Map<string, number>());
  const place = useCallback((key: string) => (e: LayoutChangeEvent) => void offsets.current.set(key, e.nativeEvent.layout.y), []);
  const scrollTo = useCallback((key: string) => {
    const y = key.startsWith("row:") ? (offsets.current.get("all") ?? 0) + (rowOffsets.current.get(key) ?? 0) : offsets.current.get(key);
    if (y !== undefined) mainRef.current?.scrollTo?.({ y: Math.max(0, y - space.md), animated: true });
  }, []);
  const goGroup = (key: string) => {
    const g = d.groups.find((x) => x.key === key);
    if (g && g.market !== market) savePrefs({ market: g.market });
    // 칩을 바꾼 뒤 줄이 자리를 잡을 때까지 한 틀 기다린다
    setTimeout(() => scrollTo(`row:${key}`), 80);
  };

  const mostCard = (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
      <View accessible accessibilityLabel={most.speech}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
          {most.title}
        </Text>
      </View>
      <View style={styles.wrapRow}>
        {most.parts.map((p, i) => (
          <Pressable key={p.key} onPress={() => goGroup(p.key)} accessibilityRole="button" accessibilityLabel={`${p.text}, 그 테마 줄로 이동`} hitSlop={{ top: space.sm, bottom: space.sm, left: 0, right: 0 }} style={styles.partBtn}>
            <Text style={{ color: t.ink, fontSize: font.body }}>
              {p.text}
              {i < most.parts.length - 1 ? " ·" : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.wrapRow}>
        <Text style={{ color: t.muted, fontSize: font.small }}>{most.coverage}</Text>
        {most.unmapped ? (
          <Pressable onPress={() => scrollTo("unmapped")} accessibilityRole="button" accessibilityLabel={`${most.unmapped}, 목록으로 이동`} style={styles.linkBtn}>
            <Text style={{ color: t.accent, fontSize: font.small }}>{most.unmapped}</Text>
            <Ionicons name="chevron-forward" size={font.small} color={t.accent} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  const chipRow = (
    <View style={styles.chips}>
      {chips.length > 1 ? (
        <View style={styles.chipGroup}>
          {chips.map((c) => (
            <Chip key={c.market} label={c.label} active={c.market === market} accessibilityLabel={c.speech} onPress={() => savePrefs({ market: c.market })} />
          ))}
        </View>
      ) : (
        <View />
      )}
      <View style={styles.chipGroup}>
        {(["day", "week"] as const).map((p) => (
          <Chip key={p} wideTouch label={PERIOD_LABEL[p]} active={p === period} accessibilityLabel={`${PERIOD_LABEL[p]}, 기간`} onPress={() => savePrefs({ period: p })} />
        ))}
      </View>
    </View>
  );

  const status = info && market ? <StatusRow info={info} market={market} period={period} /> : null;

  const section = (title: string, rows: ThemeRowView[], key: string) => (
    <View key={key} style={[styles.section, { borderColor: t.line, backgroundColor: t.surface }]} onLayout={place(key)}>
      <Text style={[styles.sectionTitle, { color: t.ink }]} accessibilityRole="header">
        {title}
      </Text>
      {rows.map((r, i) => (
        <View key={r.key} onLayout={key === "all" ? (e) => void rowOffsets.current.set(`row:${r.key}`, e.nativeEvent.layout.y) : undefined}>
          <HoldingThemeRow row={r} first={i === 0} />
        </View>
      ))}
    </View>
  );

  const topBottom =
    view && view.split ? (
      <View style={wide && !twoCol ? styles.pair : undefined}>
        <View style={wide && !twoCol ? styles.pairCell : undefined}>{section(TOP_TITLE, view.top, "top")}</View>
        <View style={wide && !twoCol ? styles.pairCell : undefined}>{section(BOTTOM_TITLE, view.bottom, "bottom")}</View>
      </View>
    ) : null;
  const all = view && view.rows.length ? section(view.allTitle, view.rows, "all") : null;

  const unmapped = d.coverage.unmapped.length ? (
    <View style={[styles.section, { borderColor: t.line, backgroundColor: t.surface }]} onLayout={place("unmapped")}>
      <Text style={[styles.sectionTitle, { color: t.ink }]} accessibilityRole="header">
        {UNMAPPED_TITLE} {d.coverage.unmapped.length}
      </Text>
      {d.coverage.unmapped.map((u) => (
        <Text key={u.code} style={[styles.plain, { color: t.sub, borderTopColor: t.line }]}>
          {u.text}
        </Text>
      ))}
    </View>
  ) : null;

  const byHoldingBlock = byHolding.length ? (
    <View style={[styles.section, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Pressable onPress={() => setOpenByHolding((v) => !v)} accessibilityRole="button" accessibilityLabel={`${BY_HOLDING_TITLE}, ${openByHolding ? "펼쳐짐" : "접힘"}`} accessibilityState={{ expanded: openByHolding }} style={styles.toggle}>
        <Text style={[styles.sectionTitle, { color: t.ink, paddingHorizontal: 0 }]}>{BY_HOLDING_TITLE}</Text>
        <Ionicons name={openByHolding ? "chevron-up" : "chevron-down"} size={font.body} color={t.muted} />
      </Pressable>
      {openByHolding
        ? byHolding.map((h) => (
            <View key={h.code} style={[styles.byRow, { borderTopColor: t.line }]}>
              <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "600" }}>{h.head}</Text>
              <View style={styles.wrapRow}>
                {h.items.map((it, i) => (
                  <Text key={`${it.name}:${i}`} style={{ color: t.sub, fontSize: font.small }}>
                    {it.name} <Text style={{ color: changeColor(t, it.rate), fontVariant: ["tabular-nums"] }}>{it.rateText}</Text>
                    {i < h.items.length - 1 ? " ·" : ""}
                  </Text>
                ))}
              </View>
            </View>
          ))
        : null}
    </View>
  ) : null;

  const basis = (
    <View style={styles.basis}>
      {d.basis.map((b) => (
        <Text key={b} style={{ color: t.muted, fontSize: font.tiny }}>
          {b}
        </Text>
      ))}
    </View>
  );
  const prepLine = preparing ? <Text style={[styles.prep, { color: t.warn, borderColor: t.line }]}>{PREPARING_LINE}</Text> : null;
  const empty = !view ? <Text style={[styles.prep, { color: t.muted }]}>테마·업종에 연결한 보유 종목이 없습니다.</Text> : null;

  if (twoCol) {
    // 넓은 창 (폴드 펼침 가로 등): 두 칸이 따로 스크롤. 고지는 맨 아래 한 번
    return (
      <View style={[styles.root, { backgroundColor: t.bg }]}>
        {top}
        <View style={styles.cols}>
          <ScrollView style={[styles.left, { borderRightColor: t.line }]} contentContainerStyle={styles.colContent}>
            {prepLine}
            {mostCard}
            {chipRow}
            {status}
            {topBottom}
            {empty}
          </ScrollView>
          <ScrollView ref={mainRef} style={styles.root} contentContainerStyle={styles.colContent}>
            {all}
            {unmapped}
            {byHoldingBlock}
            {basis}
          </ScrollView>
        </View>
        <Disclaimer />
      </View>
    );
  }
  return (
    <Screen top={top} refreshing={pulling} onRefresh={onPull} disclaimer scrollRef={mainRef}>
      {prepLine}
      {mostCard}
      {chipRow}
      {status}
      {topBottom}
      {all}
      {empty}
      {unmapped}
      {byHoldingBlock}
      {basis}
    </Screen>
  );
}

/** 상태 줄: 값이 바뀌는 중인지·어느 시점 값인지 (발견 탭 상태 줄과 같은 말, 갱신 주기만 이 화면 것) */
function StatusRow({ info, market, period }: { info: HtMarketInfo; market: HtMarket; period: HtPeriod }) {
  const t = useTheme();
  const s = info.session;
  const moving = s === "regular" || s === "extended";
  const label =
    s === "regular"
      ? "장중 · 1분마다 갱신"
      : s === "extended"
        ? "시간외 거래 반영 중 · 1분마다 갱신"
        : s === "pre"
          ? "장 시작 전 · 직전 거래일 기준"
          : market === "US"
            ? "장 마감 · 직전 정규장 기준"
            : "장 마감 · 마지막 거래 기준";
  return (
    <View style={[styles.status, { borderBottomColor: t.line }]}>
      <View style={styles.statusLine}>
        <View style={[styles.dot, { backgroundColor: moving ? t.live : t.muted }]} />
        <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1 }}>
          {label}
          {info.asOf ? ` · ${formatDateKo(info.asOf, true)} 기준` : ""}
          {info.note ? ` · ${info.note}` : ""}
        </Text>
      </View>
      {period === "week" && info.weekNote ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{info.weekNote}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.xs, rowGap: space.xxs },
  partBtn: { justifyContent: "center", minHeight: font.body * 2 },
  linkBtn: { flexDirection: "row", alignItems: "center", gap: space.xxs, minHeight: touch.min },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", rowGap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  chipGroup: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  status: { paddingHorizontal: space.lg, paddingBottom: space.s, gap: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth },
  statusLine: { flexDirection: "row", alignItems: "center", gap: space.s },
  dot: { width: 5, height: 5, borderRadius: 3 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: space.md },
  sectionTitle: { fontSize: font.small, fontWeight: "700", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  plain: { fontSize: font.small, paddingHorizontal: space.lg, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: touch.min, paddingHorizontal: space.lg },
  byRow: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.xxs, borderTopWidth: StyleSheet.hairlineWidth },
  basis: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xxs },
  prep: { fontSize: font.small, paddingHorizontal: space.lg, paddingVertical: space.sm },
  // 폭 600~839 (펼친 폴드 세로): 높은 3개·낮은 3개를 두 칸 나란히 (칸 최소 300 — 안 되면 위아래)
  pair: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md },
  pairCell: { flexGrow: 1, flexBasis: 300, minWidth: 0 },
  cols: { flex: 1, flexDirection: "row" },
  left: { width: layout.detailSideW, flexGrow: 0, borderRightWidth: StyleSheet.hairlineWidth },
  colContent: { paddingBottom: space.xl },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
