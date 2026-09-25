import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAnyMarketOpen, useHealth, useStockMutations, useStocks } from "@/api/hooks";
import type { Currency, RegisteredWithQuote } from "@/api/types";
import { LiveStatus, StaleBanner, useFeedState, usePull } from "@/components/Freshness";
import { MarketStrip } from "@/components/MarketStrip";
import { HoldingsSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { StockRow } from "@/components/StockRow";
import { PRICE_HEAD, useLineCols } from "@/components/StockLine";
import { Button, ErrorView, TableHead } from "@/components/ui";
import { sentence, speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { formatPct, formatPrice, formatQuote } from "@/lib/format";
import { holdingsSuffix, openMaxAge, staleQuoteCount, viewState } from "@/lib/freshness";
import { quoteLive, sessionOpen } from "@/lib/liveDot";
import { evalView } from "@/lib/liveTick";
import { fxOf, summarize, type Bucket as Totals } from "@/lib/portfolio";
import { SORT_OPTIONS, useSettings, type SortKey } from "@/lib/settings";
import { changeColor, font, space, touch, useTheme } from "@/theme";

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
  const col = useLineCols();
  // 값이 있으면 재조회가 실패해도 화면을 지우지 않고, 끊김·지연을 띠와 상태 글자로 알린다
  const { pulling, onPull } = usePull(refetch);
  // 초록 점: 서버가 실시간이라 하고(세션·거래 대상·서버 수신) 앱도 값을 제때 받고 세션이 안 끝났을 때만 (lib/liveDot).
  // 상태 줄은 종목별 세션으로 "미국 주간거래 · 한국 휴장 · 실시간 N종목" — 위젯 칩과 같은 함수로 세션을 고른다(lib/liveDot sessionViews · marketChip,
  // 예전 서버의 닫힘 문구 live.label 도 marketChip). 칩이 세션 이름("미국 주간거래")이면 늘 상태 줄 맨 앞 세션과 같다
  const quotes = useMemo(() => (data ?? []).map((s) => s.quote), [data]);
  const { now, feedOk } = useFeedState(stocks, quotes);
  // 장중 판단(지연 띠): 새 서버는 종목별 세션(미국 프리·애프터·주간거래 포함), 예전 서버는 장 상태
  const open = sessionOpen(quotes) ?? live.open;

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
          status={<LiveStatus query={stocks} open={open} closedLabel={live.label} maxAgeMs={openMaxAge} quotes={quotes} feed={{ now, feedOk }} suffix={holdingsSuffix({ held: summary.held, watch: summary.watch, stale: staleQuoteCount(stocks.data) })} />}
        />
      ) : null}
    </View>
  );

  const sectionHeader = (section: (typeof sections)[number]) => (
    <View style={{ backgroundColor: t.bg }}>
      <View style={[styles.sectionBar, { backgroundColor: t.bg }]}>
        <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }} accessibilityRole="header">
          {section.title}
        </Text>
        <Pressable onPress={() => setSortOpen(true)} hitSlop={SORT_SLOP} accessibilityRole="button" accessibilityLabel={`정렬 바꾸기, 지금 ${sortLabel}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xxs, paddingVertical: space.xs }}>
          <Text style={{ color: t.muted, fontSize: font.small }}>{sortLabel}</Text>
          <Ionicons name="chevron-down" size={font.small} color={t.muted} />
        </Pressable>
      </View>
      <TableHead>
        <HeadCell label="종목명" a11y="이름순 정렬" active={sort === "name"} onPress={() => void setSort("name")} flex />
        <HeadCell label={PRICE_HEAD} a11y="등락률순 정렬" active={sort === "changeRate"} onPress={() => void setSort("changeRate")} width={col.price} />
        {section.key === "held" ? (
          <HeadCell label="평가손익·수익률" a11y="수익률순 정렬" active={sort === "profit"} onPress={() => void setSort("profit")} width={col.right} />
        ) : (
          <HeadCell label="전일대비·거래량" width={col.right} />
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
    <Screen scroll={false} top={<StaleBanner query={stocks} open={open} maxAgeMs={openMaxAge} />}>
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
              ...section.data.map((item) => (
                <StockRow key={item.code} stock={item} showKrw={showKrw} afterCost={afterCost} live={quoteLive(item.quote, now, feedOk)} onPress={openStock} onLongPress={longPress} />
              )),
            ])}
      </ScrollView>
      <SortSheet visible={sortOpen} value={sort} onClose={() => setSortOpen(false)} onPick={(k) => void setSort(k)} />
    </Screen>
  );
}

function HeadCell({ label, a11y, active, onPress, width, flex }: { label: string; a11y?: string; active?: boolean; onPress?: () => void; width?: number; flex?: boolean }) {
  const t = useTheme();
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: flex ? "flex-start" : "flex-end", gap: space.xxs }}>
      <Text style={{ color: active ? t.ink : t.muted, fontSize: font.tiny, fontWeight: active ? "700" : "500", textAlign: flex ? "left" : "right", flexShrink: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {label}
      </Text>
      {active ? <Ionicons name="caret-down" size={font.tiny} color={t.ink} /> : null}
    </View>
  );
  const style = flex ? { flex: 1 } : { width };
  // 표 머리 칸을 위아래 여백까지 채운다(글자 약 16 + 여백 6·6 = 28). 44 예외: 위는 정렬 버튼, 아래는 첫 종목 줄이라
  // hitSlop 으로 넓히면 이웃을 누를 때 정렬이 바뀐다 (3-22 리뷰). 같은 정렬은 "정렬" 버튼으로도 된다
  const tap = { marginVertical: -space.s, paddingVertical: space.s };
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y ?? `${label}순 정렬`} accessibilityState={{ selected: !!active }} style={[style, tap]}>
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}

/** 국내·해외 줄의 이름 칸 최소 폭 (100% 에서 숫자 열이 맞게) */
const SPLIT_LABEL_W = 34;
/** 국내·해외 줄의 손익·수익률 칸 최소 폭 (100% 에서 열이 맞게) */
const SPLIT_PL_W = 118;
const SPLIT_PCT_W = 62;
/**
 * 정렬 버튼(보이는 높이 약 24): 위로 14, 아래로는 머리 줄 여백(6)까지만 → 44.
 * 아래로 더 넓히면 바로 밑 표 머리의 정렬 칸과 겹친다
 */
const SORT_SLOP = { top: 14, bottom: space.s, left: space.sm, right: space.sm };

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
  // 화면 읽기: 계좌 요약을 한 문장으로 (3-22). 상태 줄(실시간·지연)은 따로 읽는다
  const showSplit = lines.length > 1 || lines[0]?.cur === "USD";
  const label = sentence([
    `총 평가금액${total ? "" : " (원화 종목)"} ${speakAmount(formatPrice(main.value, "KRW"))}`,
    `평가손익 ${speakProfit(formatPrice(profit, "KRW"), Math.sign(profit)) ?? "없음"}`,
    speakRate(rate) ? `수익률 ${speakRate(rate)}` : null,
    `매입금액 ${speakAmount(formatPrice(main.cost, "KRW"))}`,
    `당일손익 ${speakProfit(formatPrice(main.day, "KRW"), Math.sign(main.day)) ?? "없음"}`,
    // 국내·해외 줄은 화면에 있을 때만 (그 줄 자체는 화면 읽기에서 숨겨 두 번 읽히지 않게)
    ...(showSplit
      ? lines.map((l) => {
          const p = l.tot.value - l.tot.cost;
          const r = l.tot.cost > 0 ? (p / l.tot.cost) * 100 : 0;
          return sentence([`${l.label} ${speakAmount(formatPrice(l.tot.value, l.cur))}`, speakProfit(formatPrice(p, l.cur), Math.sign(p)) ?? "손익 없음", speakRate(r)]);
        })
      : []),
  ]);
  return (
    <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
      <View style={styles.panelTop}>
        <Text style={{ color: t.muted, fontSize: font.small, flexShrink: 0 }}>
          총 평가금액{total ? "" : " (원화 종목)"}
          {afterCost ? " · 비용 차감" : ""}
        </Text>
        {status}
      </View>
      <View accessible accessibilityLabel={label} style={{ gap: space.xs }}>
      <Text style={[styles.total, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {formatQuote(main.value, "KRW")}
        <Text style={{ fontSize: font.body, color: t.muted, fontWeight: "500" }}> 원</Text>
      </Text>
      <View style={styles.kpis}>
        <Kpi label="평가손익" value={formatPrice(profit, "KRW", { sign: true })} color={pc} />
        <Kpi label="수익률" value={formatPct(rate)} color={pc} />
        <Kpi label="매입금액" value={formatPrice(main.cost, "KRW")} />
        <Kpi label="당일손익" value={formatPrice(main.day, "KRW", { sign: true })} color={dc} />
      </View>
      </View>
      {showSplit ? (
        <View style={[styles.split, { borderTopColor: t.line }]}>
          {/* 숫자는 위 요약 문장에 들어 있다 → 조각으로 한 번 더 읽히지 않게 숨기고, 환율 안내 한 줄만 읽는다 */}
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.splitRows}>
          {lines.map((l) => {
            const p = l.tot.value - l.tot.cost;
            const r = l.tot.cost > 0 ? (p / l.tot.cost) * 100 : 0;
            return (
              <View key={l.label} style={styles.splitRow}>
                {/* 폭을 고정하지 않는다: 큰 글씨에서 "국…"으로 잘리지 않게 (숫자 칸이 대신 줄어든다) */}
                <Text style={{ color: t.muted, fontSize: font.small, minWidth: SPLIT_LABEL_W, flexShrink: 0 }}>{l.label}</Text>
                <Text style={[styles.splitNum, styles.splitGap, { color: t.ink, flexGrow: 1, flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {formatPrice(l.tot.value, l.cur)}
                </Text>
                {/* 손익·수익률은 한 덩어리: 큰 글씨로 한 줄에 안 들어가면 다음 줄 오른쪽으로 내려간다 (3-22) */}
                <View style={styles.splitPl}>
                  <Text style={[styles.splitNum, { color: changeColor(t, p), minWidth: SPLIT_PL_W }]} numberOfLines={1}>
                    {formatPrice(p, l.cur, { sign: true })}
                  </Text>
                  <Text style={[styles.splitNum, styles.splitGap, { color: changeColor(t, p), minWidth: SPLIT_PCT_W }]} numberOfLines={1}>
                    {formatPct(r)}
                  </Text>
                </View>
              </View>
            );
          })}
          </View>
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
      <Text style={{ color: color ?? t.ink, fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
    </View>
  );
}

function SortSheet({ visible, value, onClose, onPick }: { visible: boolean; value: SortKey; onClose: () => void; onPick: (k: SortKey) => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* 바깥을 누르면 닫힘. 창을 감싸면 화면 읽기가 창 전체를 한 덩어리로 읽어 항목을 못 고르므로 뒤에 따로 깐다 (3-22) */}
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="정렬 닫기" />
        <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.lineStrong }]}>
          <Text style={{ color: t.muted, fontSize: font.small, paddingHorizontal: space.lg, paddingVertical: space.sm }} accessibilityRole="header">
            정렬
          </Text>
          {SORT_OPTIONS.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => {
                onPick(o.value);
                onClose();
              }}
              accessibilityRole="radio"
              accessibilityLabel={o.label}
              accessibilityState={{ checked: o.value === value }}
              style={({ pressed }) => [styles.sheetItem, { borderTopColor: t.line, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
            >
              <Text style={{ color: o.value === value ? t.accent : t.ink, fontSize: font.body, fontWeight: o.value === value ? "700" : "400" }}>{o.label}</Text>
              {o.value === value ? <Ionicons name="checkmark" size={font.h2} color={t.accent} /> : null}
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, gap: space.xs },
  // 상태 줄이 길면(시세 지연 N 등) 제목을 줄이지 않고 다음 줄로 내린다
  panelTop: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: space.sm, rowGap: space.xxs },
  total: { fontSize: font.hero, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  kpis: { flexDirection: "row", flexWrap: "wrap", marginTop: space.xs },
  kpi: { width: "50%", paddingVertical: space.xs, paddingRight: space.sm, gap: space.xxs },
  split: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: space.s, paddingTop: space.s, gap: space.xxs },
  splitRows: { gap: space.xxs },
  // 100% 에서는 예전과 같은 열(이름 34 · 평가금액 · 손익 118 · 수익률 62). 칸 사이 여백은 글자가 칸을 채울 때만 보이는 왼쪽 안쪽 여백으로
  splitRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  splitPl: { flexDirection: "row", marginLeft: "auto" },
  splitGap: { paddingLeft: space.xs },
  splitNum: { fontSize: font.small, fontVariant: ["tabular-nums"], textAlign: "right" },
  sectionBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.s },
  empty: { margin: space.lg, padding: space.lg, gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xl },
  sheetItem: { minHeight: touch.min, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.lg, borderTopWidth: StyleSheet.hairlineWidth },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
