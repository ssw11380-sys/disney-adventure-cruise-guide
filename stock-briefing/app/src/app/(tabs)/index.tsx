import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { useAnyMarketOpen, useHealth, useStockMutations, useStocks } from "@/api/hooks";
import type { Currency, RegisteredWithQuote } from "@/api/types";
import { MarketStrip } from "@/components/MarketStrip";
import { Screen } from "@/components/Screen";
import { COL, StockRow } from "@/components/StockRow";
import { Button, ErrorView, Loading, TableHead } from "@/components/ui";
import { formatPct, formatPrice, formatQuote } from "@/lib/format";
import { useLiveStream } from "@/lib/liveStream";
import { SORT_OPTIONS, useSettings, type SortKey } from "@/lib/settings";
import { changeColor, font, space, useTheme } from "@/theme";
import { refreshWidgets } from "@/widgets/refresh";

const fxOf = (s: RegisteredWithQuote): number | null => s.quote?.fxRate ?? (s.quote?.priceKrw && s.quote.price ? s.quote.priceKrw / s.quote.price : null);
/** 종목 통화 금액을 원화로. 환율을 모르면 null */
const toKrw = (n: number, s: RegisteredWithQuote): number | null => {
  const cur = s.quote?.currency ?? "KRW";
  if (cur === "KRW") return n;
  const fx = fxOf(s);
  return fx ? n * fx : null;
};

interface Totals {
  value: number;
  cost: number;
  day: number;
  count: number;
}
const zero = (): Totals => ({ value: 0, cost: 0, day: 0, count: 0 });

/** 홈(잔고): 지수 띠 → 계좌 평가 → 보유 표 → 관심 표 */
export default function StocksScreen() {
  const t = useTheme();
  const { data, isLoading, isError, error, refetch, isRefetching } = useStocks();
  const { sort, setSort, showKrw } = useSettings();
  const { remove } = useStockMutations();
  const health = useHealth();
  const live = useAnyMarketOpen();
  const stream = useLiveStream();
  const [sortOpen, setSortOpen] = useState(false);

  const summary = useMemo(() => {
    const list = data ?? [];
    const held = list.filter((s) => s.evaluation && s.quote);
    const byCur: Record<Currency, Totals> = { KRW: zero(), USD: zero() };
    const krw = zero();
    let convertible = true;
    for (const s of held) {
      const cur = s.quote!.currency ?? "KRW";
      const ev = s.evaluation!;
      const day = s.quote!.change * (s.quantity ?? 0);
      byCur[cur].value += ev.marketValue;
      byCur[cur].cost += ev.costBasis;
      byCur[cur].day += day;
      byCur[cur].count += 1;
      const v = toKrw(ev.marketValue, s), c = toKrw(ev.costBasis, s), d = toKrw(day, s);
      if (v === null || c === null || d === null) convertible = false;
      else {
        krw.value += v;
        krw.cost += c;
        krw.day += d;
        krw.count += 1;
      }
    }
    const fx = held.map(fxOf).find((x) => x) ?? null;
    return { held: held.length, byCur, krw: convertible && held.length ? krw : null, fx, watch: list.length - held.length };
  }, [data]);

  const sections = useMemo(() => {
    const list = [...(data ?? [])];
    const num = (s: RegisteredWithQuote, k: SortKey): number => {
      const q = s.quote;
      if (!q) return Number.NEGATIVE_INFINITY;
      if (k === "changeRate") return q.changeRate;
      if (k === "profit") return s.evaluation ? s.evaluation.profitRate : Number.NEGATIVE_INFINITY;
      if (k === "value") return s.evaluation ? (toKrw(s.evaluation.marketValue, s) ?? s.evaluation.marketValue) : Number.NEGATIVE_INFINITY;
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
  }, [data, sort]);

  // 홈 화면 데이터가 새로 오면 홈 화면 위젯도 같이 갱신 (1분에 한 번)
  const lastWidgetPush = useRef(0);
  useEffect(() => {
    if (!data || Date.now() - lastWidgetPush.current < 60_000) return;
    lastWidgetPush.current = Date.now();
    void refreshWidgets({ stocks: data, showKrw });
  }, [data, showKrw]);

  const confirmRemove = (s: RegisteredWithQuote) =>
    Alert.alert(s.name, undefined, [
      { text: "보유 정보 수정", onPress: () => router.push(`/stocks/${s.code}/edit`) },
      { text: "삭제", style: "destructive", onPress: () => remove.mutate(s.code, { onError: (e) => Alert.alert("삭제 실패", e instanceof Error ? e.message : String(e)) }) },
      { text: "취소", style: "cancel" },
    ]);

  if (isLoading) return <Screen><Loading /></Screen>;
  if (isError) return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "정렬";
  const statusLabel = live.open ? (stream.connected ? "실시간" : "지연 3초") : live.label;

  const header = (
    <View>
      <MarketStrip />
      {summary.held > 0 ? (
        <AccountPanel
          total={summary.krw}
          byCur={summary.byCur}
          showKrw={showKrw}
          fx={summary.fx}
          status={statusLabel}
          live={live.open && stream.connected}
          counts={`보유 ${summary.held}${summary.watch ? ` · 관심 ${summary.watch}` : ""}`}
        />
      ) : null}
    </View>
  );

  return (
    <Screen scroll={false}>
      <SectionList
        sections={sections}
        keyExtractor={(s) => s.code}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        stickySectionHeadersEnabled
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => (
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
        )}
        renderItem={({ item }) => <StockRow stock={item} showKrw={showKrw} onPress={() => router.push(`/stocks/${item.code}`)} onLongPress={() => confirmRemove(item)} />}
        ListEmptyComponent={
          <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
            <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>등록된 종목이 없습니다</Text>
            <Text style={{ color: t.muted, fontSize: font.small }}>종목명·티커로 검색해 추가하거나 토스증권 계좌에서 불러옵니다.</Text>
            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
              <Button title="종목 검색" icon="search" onPress={() => router.push("/stocks/add")} style={{ flex: 1 }} />
              {health.data?.tossOpenApi?.configured ? <Button title="계좌 불러오기" variant="secondary" onPress={() => router.push("/settings")} style={{ flex: 1 }} /> : null}
            </View>
          </View>
        }
        contentContainerStyle={{ paddingBottom: space.xl }}
      />
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
  showKrw,
  fx,
  status,
  live,
  counts,
}: {
  total: Totals | null;
  byCur: Record<Currency, Totals>;
  showKrw: boolean;
  fx: number | null;
  status: string;
  live: boolean;
  counts: string;
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
  if (byCur.USD.count) {
    const k = showKrw && fx ? fx : 1;
    lines.push({ label: "해외", tot: { value: byCur.USD.value * k, cost: byCur.USD.cost * k, day: byCur.USD.day * k, count: byCur.USD.count }, cur: showKrw && fx ? "KRW" : "USD" });
  }
  return (
    <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
      <View style={styles.panelTop}>
        <Text style={{ color: t.muted, fontSize: font.small }}>총 평가금액{total ? "" : " (원화 종목)"}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={[styles.dot, { backgroundColor: live ? t.up : t.muted }]} />
          <Text style={{ color: t.muted, fontSize: font.tiny }}>
            {status} · {counts}
          </Text>
        </View>
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
          {fx ? <Text style={{ color: t.muted, fontSize: font.tiny, textAlign: "right" }}>적용 환율 {fx.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}원</Text> : null}
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
  panelTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  total: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  kpis: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  kpi: { width: "50%", paddingVertical: 4, paddingRight: space.sm, gap: 1 },
  split: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 6, paddingTop: 6, gap: 3 },
  splitRow: { flexDirection: "row", alignItems: "center" },
  splitNum: { fontSize: font.small, fontVariant: ["tabular-nums"], textAlign: "right" },
  dot: { width: 5, height: 5, borderRadius: 3 },
  sectionBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 6 },
  empty: { margin: space.lg, padding: space.lg, gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xl },
  sheetItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
});
