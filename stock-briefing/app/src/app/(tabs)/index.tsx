import { useIsRestoring } from "@tanstack/react-query";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAnyMarketOpen, useHealth, useMarketStatus, useStockMutations, useStocks } from "@/api/hooks";
import type { Currency, RegisteredWithQuote } from "@/api/types";
import { LiveStatus, StaleBanner, usePull } from "@/components/Freshness";
import { MarketStrip } from "@/components/MarketStrip";
import { HoldingsSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { COL, StockRow } from "@/components/StockRow";
import { Button, ErrorView, TableHead } from "@/components/ui";
import { formatPct, formatPrice, formatQuote } from "@/lib/format";
import { holdingsSuffix, openMaxAge, staleQuoteCount, viewState } from "@/lib/freshness";
import { evalView } from "@/lib/liveTick";
import { fxOf, summarize, type Bucket as Totals } from "@/lib/portfolio";
import { SORT_OPTIONS, useSettings, type SortKey } from "@/lib/settings";
import { changeColor, font, space, useTheme } from "@/theme";
import { widgetPushDue } from "@/widgets/pushPolicy";
import { refreshWidgets } from "@/widgets/refresh";

/** 홈(잔고): 지수 띠 → 계좌 평가 → 보유 표 → 관심 표 */
export default function StocksScreen() {
  const t = useTheme();
  const stocks = useStocks();
  const { data, error, refetch } = stocks;
  const { sort, setSort, showKrw, afterCost } = useSettings();
  const { remove } = useStockMutations();
  const health = useHealth();
  const live = useAnyMarketOpen();
  const [sortOpen, setSortOpen] = useState(false);
  // 값이 있으면 재조회가 실패해도 화면을 지우지 않고, 끊김·지연을 띠와 상태 글자로 알린다
  const { pulling, onPull } = usePull(refetch);

  // 합계는 토스 앱과 같은 기준: 평가금액은 (설정 시) 수수료·세금 차감 후, 해외 종목 원화 손익은 매수 당시 환율의 원화 매입금액 기준
  const summary = useMemo(() => summarize(data ?? [], afterCost), [data, afterCost]);

  const sections = useMemo(() => {
    const list = [...(data ?? [])];
    const num = (s: RegisteredWithQuote, k: SortKey): number => {
      const q = s.quote;
      if (!q) return Number.NEGATIVE_INFINITY;
      if (k === "changeRate") return q.changeRate;
      // 수익률은 화면에 보이는 기준(원화 보기 여부)대로, 평가금액은 통화를 맞춰야 비교되므로 항상 원화로
      if (k === "profit") {
        const v = evalView(s.evaluation, { afterCost, toKrw: showKrw, currency: q.currency, fx: fxOf(s) });
        return v ? v.profitRate : Number.NEGATIVE_INFINITY;
      }
      const v = evalView(s.evaluation, { afterCost, toKrw: true, currency: q.currency, fx: fxOf(s) });
      if (k === "value") return v ? v.marketValue : Number.NEGATIVE_INFINITY;
      return 0;
    };
    const sorted = (() => {
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
    })();
    const held = sorted.filter((s) => s.evaluation);
    const watch = sorted.filter((s) => !s.evaluation);
    return [
      ...(held.length ? [{ key: "held", title: `보유 ${held.length}`, data: held }] : []),
      ...(watch.length ? [{ key: "watch", title: `관심 ${watch.length}`, data: watch }] : []),
    ];
  }, [data, sort, afterCost, showKrw]);

  // 홈 화면 데이터가 새로 오면 홈 화면 위젯도 같이 갱신 (규칙은 widgets/pushPolicy: 시세만 바뀌면 1분에 한 번,
  // 표시 설정·장 상태가 바뀌거나 앱을 떠날 때는 바로). 기기에 저장해 둔 옛 잔고로는 덮지 않는다
  const lastWidgetPush = useRef({ at: 0, key: "" });
  const dataAt = stocks.dataUpdatedAt;
  const ms = useMarketStatus().data;
  const krOpen = ms?.KR.isOpen ?? false;
  const usOpen = ms?.US.isOpen ?? false;
  const market = useMemo(
    () => (live.loaded ? { label: live.label, open: live.open, nextChangeAt: null, kr: krOpen, us: usOpen } : null),
    [live.loaded, live.label, live.open, krOpen, usOpen],
  );
  // 이번 실행에서 서버에서 받은 잔고인지: 받은 시각이 화면을 연 뒤인지로 본다
  // (isFetchedAfterMount 는 기기 저장값 복원·오프라인 실패에도 true 가 되어 옛 잔고로 위젯을 덮을 수 있다)
  const [mountedAt] = useState(() => Date.now());
  const restoring = useIsRestoring();
  const fetchedThisSession = !restoring && dataAt > mountedAt;
  const pushKey = `${showKrw}|${afterCost}|${market?.label ?? ""}`;
  // 앱을 떠날 때 쓸 최신 값 (렌더 중에는 ref 를 건드리지 않고 effect 에서 갱신)
  const pushWidgets = useRef<(leaving: boolean) => void>(() => undefined);
  useEffect(() => {
    pushWidgets.current = (leaving: boolean) => {
      const now = Date.now();
      if (!data || !widgetPushDue({ now, fetchedThisSession, lastAt: lastWidgetPush.current.at, lastKey: lastWidgetPush.current.key, key: pushKey, leaving })) return;
      lastWidgetPush.current = { at: now, key: pushKey };
      void refreshWidgets({ stocks: data, showKrw, afterCost, market });
    };
    pushWidgets.current(false);
  }, [data, dataAt, pushKey, showKrw, afterCost, market, fetchedThisSession]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") pushWidgets.current(true);
    });
    return () => sub.remove();
  }, []);

  const confirmRemove = (s: RegisteredWithQuote) =>
    // 토스 연동 종목은 삭제하면 동기화에서도 빠진다는 것을 먼저 알린다 (수정 화면과 같은 문구)
    Alert.alert(s.name, s.tossSynced ? "토스 계좌에서 가져온 종목입니다. 삭제하면 토스 동기화에서도 빠져 다시 나타나지 않습니다 (다시 등록하면 다시 맞춤)." : undefined, [
      { text: "보유 정보 수정", onPress: () => router.push(`/stocks/${s.code}/edit`) },
      { text: "삭제", style: "destructive", onPress: () => remove.mutate(s.code, { onError: (e) => Alert.alert("삭제 실패", e instanceof Error ? e.message : String(e)) }) },
      { text: "취소", style: "cancel" },
    ]);

  // 줄 누름 처리는 렌더마다 새로 만들지 않는다 (체결이 온 줄만 다시 그리게, 3-17)
  const confirmRef = useRef(confirmRemove);
  useEffect(() => {
    confirmRef.current = confirmRemove;
  });
  const openStock = useCallback((s: RegisteredWithQuote) => router.push(`/stocks/${s.code}`), []);
  const longPress = useCallback((s: RegisteredWithQuote) => confirmRef.current(s), []);

  const view = viewState(stocks);
  if (view === "loading")
    return (
      <Screen scroll={false}>
        <MarketStrip />
        <HoldingsSkeleton />
      </Screen>
    );
  if (view === "error") return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "정렬";

  const header = (
    <View>
      <MarketStrip />
      {summary.held > 0 ? (
        <AccountPanel
          total={summary.krw}
          byCur={summary.byCur}
          usdInKrw={summary.usdInKrw}
          estimated={summary.estimated}
          currentBasis={summary.currentBasis}
          afterCost={afterCost}
          showKrw={showKrw}
          fx={summary.fx}
          status={<LiveStatus query={stocks} open={live.open} closedLabel={live.label} maxAgeMs={openMaxAge} suffix={holdingsSuffix({ held: summary.held, watch: summary.watch, stale: staleQuoteCount(stocks.data) })} />}
        />
      ) : null}
    </View>
  );

  const sectionHeader = (section: (typeof sections)[number]) => (
    <View style={{ backgroundColor: t.bg }}>
      <View style={[styles.sectionBar, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }}>{section.title}</Text>
        <Pressable onPress={() => setSortOpen(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel="정렬">
          <Text style={{ color: t.muted, fontSize: font.small }}>{sortLabel} ▾</Text>
        </Pressable>
      </View>
      <TableHead>
        <HeadCell label="종목명" active={sort === "name"} onPress={() => void setSort("name")} flex />
        <HeadCell label="현재가 / 등락률" active={sort === "changeRate"} onPress={() => void setSort("changeRate")} width={COL.price} />
        {section.key === "held" ? (
          <HeadCell label="평가손익 / 수익률" active={sort === "profit"} onPress={() => void setSort("profit")} width={COL.right} />
        ) : (
          <HeadCell label="전일대비 / 거래량" width={COL.right} />
        )}
      </TableHead>
    </View>
  );
  const empty = (
    <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>등록된 종목이 없습니다</Text>
      <Text style={{ color: t.muted, fontSize: font.small }}>종목명·티커로 검색해 추가하거나 토스증권 계좌에서 불러옵니다.</Text>
      <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
        <Button title="종목 검색" icon="search" onPress={() => router.push("/stocks/add")} style={{ flex: 1 }} />
        {health.data?.tossOpenApi?.configured ? <Button title="계좌 불러오기" variant="secondary" onPress={() => router.push("/settings")} style={{ flex: 1 }} /> : null}
      </View>
    </View>
  );
  // 머리(0) 다음부터 구역마다 [머리글, 줄들...] → 머리글 자리만 고정
  const stickyIndices: number[] = [];
  let childIndex = 1;
  for (const sec of sections) {
    stickyIndices.push(childIndex);
    childIndex += 1 + sec.data.length;
  }

  return (
    <Screen scroll={false} top={<StaleBanner query={stocks} open={live.open} maxAgeMs={openMaxAge} />}>
      {/* 잔고는 수십 줄이라 가상화 목록 대신 스크롤 + 고정 머리글로 그린다: 체결 묶음마다 목록 내부의 두 번째 커밋이 없고,
          체결이 온 줄만 다시 그린다 (3-17) */}
      <ScrollView
        stickyHeaderIndices={stickyIndices}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} />}
        contentContainerStyle={{ paddingBottom: space.xl }}
      >
        {header}
        {sections.length === 0
          ? empty
          : sections.flatMap((section) => [
              <View key={`h-${section.key}`}>{sectionHeader(section)}</View>,
              ...section.data.map((item) => <StockRow key={item.code} stock={item} showKrw={showKrw} afterCost={afterCost} onPress={openStock} onLongPress={longPress} />),
            ])}
      </ScrollView>
      <SortSheet visible={sortOpen} value={sort} onClose={() => setSortOpen(false)} onPick={(k) => void setSort(k)} />
    </Screen>
  );
}

function HeadCell({ label, active, onPress, width, flex }: { label: string; active?: boolean; onPress?: () => void; width?: number; flex?: boolean }) {
  const t = useTheme();
  const body = (
    <Text style={{ color: active ? t.ink : t.muted, fontSize: font.tiny, fontWeight: active ? "700" : "500", textAlign: flex ? "left" : "right" }} numberOfLines={1}>
      {label}
      {active ? " ▼" : ""}
    </Text>
  );
  const style = flex ? { flex: 1 } : { width };
  return onPress ? (
    <Pressable onPress={onPress} hitSlop={6} style={style}>
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}

/** 계좌 평가 패널: 총 평가금액(원화 환산) + 평가손익·수익률·매입·당일 + 국내/해외 구분 */
function AccountPanel({
  total,
  byCur,
  usdInKrw,
  estimated,
  currentBasis,
  afterCost,
  showKrw,
  fx,
  status,
}: {
  total: Totals | null;
  byCur: Record<Currency, Totals>;
  usdInKrw: Totals;
  estimated: boolean;
  /** 원화 매입금액 장부가 없어 현재 환율로 환산한 해외 종목 수 */
  currentBasis: number;
  afterCost: boolean;
  showKrw: boolean;
  fx: number | null;
  status: React.ReactNode;
}) {
  const t = useTheme();
  // 합계는 원화로(환율을 모르면 원화 종목만). 해외 행은 설정에 따라 달러 또는 원화
  const main = total ?? byCur.KRW;
  const profit = main.value - main.cost;
  const rate = main.cost > 0 ? (profit / main.cost) * 100 : 0;
  const pc = changeColor(t, profit);
  const dc = changeColor(t, main.day);
  const lines: { label: string; tot: Totals; cur: Currency }[] = [];
  if (byCur.KRW.count) lines.push({ label: "국내", tot: byCur.KRW, cur: "KRW" });
  if (byCur.USD.count) lines.push(showKrw && usdInKrw.count === byCur.USD.count ? { label: "해외", tot: usdInKrw, cur: "KRW" } : { label: "해외", tot: byCur.USD, cur: "USD" });
  return (
    <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
      <View style={styles.panelTop}>
        <Text style={{ color: t.muted, fontSize: font.small, flexShrink: 0 }}>
          총 평가금액{total ? "" : " (원화 종목)"}
          {afterCost ? " · 비용 차감" : ""}
        </Text>
        {status}
      </View>
      <Text style={[styles.total, { color: t.ink }]}>
        {formatQuote(main.value, "KRW")}
        <Text style={{ fontSize: font.body, color: t.muted, fontWeight: "500" }}> 원</Text>
      </Text>
      <View style={styles.kpis}>
        <Kpi label="평가손익" value={formatPrice(profit, "KRW", { sign: true })} color={pc} />
        <Kpi label="수익률" value={formatPct(rate)} color={pc} />
        <Kpi label="매입금액" value={formatPrice(main.cost, "KRW")} />
        <Kpi label="당일손익" value={formatPrice(main.day, "KRW", { sign: true })} color={dc} />
      </View>
      {lines.length > 1 || (lines[0]?.cur === "USD") ? (
        <View style={[styles.split, { borderTopColor: t.line }]}>
          {lines.map((l) => {
            const p = l.tot.value - l.tot.cost;
            const r = l.tot.cost > 0 ? (p / l.tot.cost) * 100 : 0;
            return (
              <View key={l.label} style={styles.splitRow}>
                <Text style={{ color: t.muted, fontSize: font.small, width: 34 }}>{l.label}</Text>
                <Text style={[styles.splitNum, { color: t.ink, flex: 1 }]}>{formatPrice(l.tot.value, l.cur)}</Text>
                <Text style={[styles.splitNum, { color: changeColor(t, p), width: 118 }]} numberOfLines={1} adjustsFontSizeToFit>
                  {formatPrice(p, l.cur, { sign: true })}
                </Text>
                <Text style={[styles.splitNum, { color: changeColor(t, p), width: 62 }]}>{formatPct(r)}</Text>
              </View>
            );
          })}
          {fx ? (
            <Text style={{ color: t.muted, fontSize: font.tiny, textAlign: "right" }}>
              토스 적용 환율 {fx.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}원 · 원화 손익은 매수 당시 환율 기준{estimated ? " (일부 추정)" : ""}
              {currentBasis ? ` · ${currentBasis}종목은 현재 환율 환산` : ""}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={styles.kpi}>
      <Text style={{ color: t.muted, fontSize: font.tiny }}>{label}</Text>
      <Text style={{ color: color ?? t.ink, fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] }} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

function SortSheet({ visible, value, onClose, onPick }: { visible: boolean; value: SortKey; onClose: () => void; onPick: (k: SortKey) => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.lineStrong }]}>
          <Text style={{ color: t.muted, fontSize: font.small, paddingHorizontal: space.lg, paddingVertical: space.sm }}>정렬</Text>
          {SORT_OPTIONS.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => {
                onPick(o.value);
                onClose();
              }}
              style={({ pressed }) => [styles.sheetItem, { borderTopColor: t.line, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
            >
              <Text style={{ color: o.value === value ? t.accent : t.ink, fontSize: font.body, fontWeight: o.value === value ? "700" : "400" }}>{o.label}</Text>
              {o.value === value ? <Text style={{ color: t.accent }}>✓</Text> : null}
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, gap: 4 },
  // 상태 줄이 길면(시세 지연 N 등) 제목을 줄이지 않고 다음 줄로 내린다
  panelTop: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: space.sm, rowGap: 2 },
  total: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  kpis: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  kpi: { width: "50%", paddingVertical: 4, paddingRight: space.sm, gap: 1 },
  split: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 6, paddingTop: 6, gap: 3 },
  splitRow: { flexDirection: "row", alignItems: "center" },
  splitNum: { fontSize: font.small, fontVariant: ["tabular-nums"], textAlign: "right" },
  sectionBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 6 },
  empty: { margin: space.lg, padding: space.lg, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xl },
  sheetItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
