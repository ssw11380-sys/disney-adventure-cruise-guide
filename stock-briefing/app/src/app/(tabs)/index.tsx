import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnyMarketOpen, useFeature, useHealth, useStockMutations, useStocks } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { AccountBand, accountFigures, accountSpeech, fxNote, lineProfit, type AccountData } from "@/components/AccountBand";
import { LiveStatus, StaleBanner, useFeedState, usePull } from "@/components/Freshness";
import { TableHeadRow } from "@/components/HoldingsTableHead";
import { MarketStrip } from "@/components/MarketStrip";
import { HoldingsSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { StockRow } from "@/components/StockRow";
import { PRICE_HEAD, useLineCols } from "@/components/StockLine";
import { Button, ErrorView, TableHead } from "@/components/ui";
import { gated } from "@/lib/features";
import { formatPct, formatPrice, formatQuote } from "@/lib/format";
import { holdingsSuffix, openMaxAge, staleQuoteCount, viewState } from "@/lib/freshness";
import { holdingsLayoutKey, useHoldingsAnchor } from "@/lib/holdingsAnchor";
import { bandOneLine, bandRates, holdingWeights, pickCols, pickWatchCols } from "@/lib/holdingsColumns";
import { quoteLive, sessionOpen } from "@/lib/liveDot";
import { excludedLabel, isHolding, sortHoldings, splitHoldings, summarize } from "@/lib/portfolio";
import { SORT_OPTIONS, useSettings, type SortKey } from "@/lib/settings";
import { TAB_ICON } from "@/lib/textScale";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide, railWidth } from "@/lib/windowClass";
import { changeColor, font, fontCap, layout, space, touch, useFontScale, useTheme } from "@/theme";

/**
 * 홈(잔고): 지수 띠 → 계좌 평가 → 보유 표 → 관심 표.
 * 넓은 창(펼친 폴드·태블릿, 기능 플래그 foldLayout — 3-42 웨이브 B): 탭 화면 머리 대신 맨 위 띠(지수 두 줄 칸 · 시장 상태 · 검색)를 고정하고,
 * 그 아래 계좌 띠(한 줄/두 줄) → 한 줄 44dp 표(숫자 열은 폭·글자 크기에 따라 pickCols). 접힌 화면·플래그 꺼짐은 지금 휴대폰 화면 그대로
 */
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
  // 비중 보기 (새 기능): 서버가 켤 때만 계좌 평가 패널에 '비중' 버튼
  const allocationOn = useFeature("allocationView", false);
  const openAllocation = useCallback(() => router.push("/portfolio/allocation"), []);
  // 값이 있으면 재조회가 실패해도 화면을 지우지 않고, 끊김·지연을 띠와 상태 글자로 알린다
  const { pulling, onPull } = usePull(refetch);
  // 초록 점: 서버가 실시간이라 하고(세션·거래 대상·서버 수신) 앱도 값을 제때 받고 세션이 안 끝났을 때만 (lib/liveDot).
  // 상태 줄은 종목별 세션으로 "미국 주간거래 · 한국 휴장 · 실시간 N종목" — 위젯 칩과 같은 함수로 세션을 고른다(lib/liveDot sessionViews · marketChip,
  // 예전 서버의 닫힘 문구 live.label 도 marketChip). 칩이 세션 이름("미국 주간거래")이면 늘 상태 줄 맨 앞 세션과 같다
  const quotes = useMemo(() => (data ?? []).map((s) => s.quote), [data]);
  const { now, feedOk } = useFeedState(stocks, quotes);
  // 장중 판단(지연 띠): 새 서버는 종목별 세션(미국 프리·애프터·주간거래 포함), 예전 서버는 장 상태
  const open = sessionOpen(quotes) ?? live.open;

  // 넓은 창 배치 (3-42): 플래그가 꺼져 있거나 좁은 창(휴대폰·접힌 화면)이면 wide=false → 아래는 모두 지금과 같은 길
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  const insets = useSafeAreaInsets();
  const { width: winW, fontScale } = useWindowDimensions();
  // 표 폭: 표가 실제로 받은 폭(onLayout). 잰 값은 그 창 크기·탭 막대에서만 쓴다 — 접고 펴서 창이 바뀌면 새로 잴 때까지는
  // 창 폭에서 세로 탭 막대·좌우 화면 여백을 뺀 어림값 (지난 창의 폭으로 열을 한 번 잘못 고르지 않게)
  const sizeKey = `${winW}:${fold.rail ? "rail" : "bar"}`;
  const [measured, setMeasured] = useState<{ key: string; w: number } | null>(null);
  const tableW = measured?.key === sizeKey ? measured.w : winW - (fold.rail ? railWidth(fontScale) + insets.left : insets.left) - insets.right;
  const heldPlan = useMemo(() => (wide ? pickCols(tableW, fontScale) : null), [wide, tableW, fontScale]);
  const watchPlan = useMemo(() => (heldPlan ? pickWatchCols(tableW, fontScale, heldPlan.nameW) : null), [heldPlan, tableW, fontScale]);
  const oneLineBand = bandOneLine(tableW, fontScale);
  // 접고 펼 때 맨 위에 보이던 종목으로 다시 맞춘다. 줄 위치가 달라질 수 있는 배치마다 다른 이름 (휴대폰 목록 / 넓은 표의 계좌 띠 줄 수·
  // 탭 막대 위치·열 수 — lib/holdingsAnchor holdingsLayoutKey). 플래그가 꺼져 있으면 추적하지 않는다 (지금과 똑같다).
  // ※ 플래그가 켜진 접힌 화면(보통 휴대폰 포함)은 모양은 지금과 같고, 이어 보기용으로 스크롤 위치(0.1초 간격)·줄 위치 재기만 더한다
  //   (접은 화면에서 본 종목을 펼친 뒤 이어 보려면 접힌 동안에도 재야 한다). 플래그 값을 처음 받는 순간 목록을 한 번 새로 그린다 (아래 key)
  const anchor = useHoldingsAnchor(fold.on ? holdingsLayoutKey({ wide, oneLineBand, rail: fold.rail, cols: heldPlan?.cols.length ?? 0 }) : null);

  // 합계는 토스 앱과 같은 기준: 평가금액은 (설정 시) 수수료·세금 차감 후, 해외 종목 원화 손익은 매수 당시 환율의 원화 매입금액 기준
  const summary = useMemo(() => summarize(data ?? [], afterCost), [data, afterCost]);
  // 넓은 창 계좌 띠의 당일 등락률 기준: 비용 차감 전 평가금액 (당일손익이 비용 차감 전 금액이라 — AccountBand dayRateOf). 차감이 꺼져 있으면 같은 값
  const grossValue = useMemo(() => {
    if (!wide || !afterCost) return null;
    const g = summarize(data ?? [], false);
    return (g.krw ?? g.byCur.KRW).value;
  }, [wide, data, afterCost]);
  // 표의 비중 열: 계좌 총 평가금액과 같은 기준 (환율을 모르는 해외 종목이 있으면 원화 종목만)
  const weights = useMemo(() => (wide ? holdingWeights(data ?? [], afterCost, (summary.krw ?? summary.byCur.KRW).value, !summary.krw) : null), [wide, data, afterCost, summary]);

  const sections = useMemo(() => {
    // 평가손익·평가금액 정렬은 원화 환산 금액으로 (lib/portfolio sortHoldings). 보유는 수량으로 나눈다 —
    // 평단·첫 시세가 없어도 관심으로 내리지 않고, 합계에서 뺀 수는 계좌 패널이 알린다 (BH-26 · BH-30)
    const { held, watch } = splitHoldings(sortHoldings(data ?? [], sort, afterCost));
    return [
      ...(held.length ? [{ key: "held", title: `보유 ${held.length}`, data: held }] : []),
      ...(watch.length ? [{ key: "watch", title: `관심 ${watch.length}`, data: watch }] : []),
    ];
  }, [data, sort, afterCost]);

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
  // 줄 위치 → 이어 보기 (늘 같은 함수: 줄의 memo 비교를 깨지 않게)
  const rowLayout = useCallback((s: RegisteredWithQuote, y: number, h: number) => anchor.row(s.code, isHolding(s) ? "held" : "watch", y, h), [anchor]);
  const onTableLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      setMeasured((m) => (m?.key === sizeKey && m.w === w ? m : { key: sizeKey, w }));
    },
    [sizeKey],
  );

  const account: AccountData = {
    total: summary.krw,
    byCur: summary.byCur,
    usdInKrw: summary.usdInKrw,
    estimated: summary.estimated,
    currentBasis: summary.currentBasis,
    afterCost,
    showKrw,
    fx: summary.fx,
    excluded: excludedLabel(summary.excluded),
    grossValue,
  };
  const stale = staleQuoteCount(stocks.data);
  const status = (
    <LiveStatus
      query={stocks}
      open={open}
      closedLabel={live.label}
      maxAgeMs={openMaxAge}
      quotes={quotes}
      feed={{ now, feedOk }}
      // 넓은 창 맨 위 띠: 보유·관심 수는 표 머리에 있으니 지연 종목 수만
      suffix={wide ? (stale ? `시세 지연 ${stale}` : "") : holdingsSuffix({ held: summary.held, watch: summary.watch, stale })}
      // 넓은 창 맨 위 띠: 세션 / 실시간·시각 두 줄 (목업과 같음), 글자는 탭 머리와 같은 상한 — 휴대폰 패널은 지금처럼 한 줄
      {...(wide ? { twoLine: true } : null)}
    />
  );
  // 넓은 창 맨 위 띠: 탭 화면 머리(숨김)를 대신하므로 상태 표시줄 높이만큼 내려 그리고, 검색 버튼을 오른쪽 끝에 둔다
  const sideInsets = { paddingLeft: fold.rail ? 0 : insets.left, paddingRight: insets.right };
  const wideTop = wide ? (
    <View style={[{ paddingTop: insets.top, backgroundColor: t.surface }, sideInsets]}>
      <MarketStrip dense trailing={<StripEnd status={status} />} />
    </View>
  ) : null;

  const view = viewState(stocks);
  if (view === "loading")
    return wide ? (
      <Screen scroll={false} top={wideTop}>
        <HoldingsSkeleton />
      </Screen>
    ) : (
      <Screen scroll={false}>
        <MarketStrip />
        <HoldingsSkeleton />
      </Screen>
    );
  if (view === "error")
    return wide ? (
      <Screen top={wideTop}>
        <ErrorView error={error} onRetry={() => void refetch()} />
      </Screen>
    ) : (
      <Screen>
        <ErrorView error={error} onRetry={() => void refetch()} />
      </Screen>
    );

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "정렬";

  const header = wide ? (
    <View>
      {summary.held > 0 && heldPlan ? (
        <AccountBand data={account} oneLine={oneLineBand} rates={bandRates(tableW, fontScale)} pad={heldPlan.pad} onAllocation={gated(allocationOn, openAllocation)} />
      ) : null}
    </View>
  ) : (
    <View>
      <MarketStrip />
      {summary.held > 0 ? <AccountPanel data={account} onAllocation={gated(allocationOn, openAllocation)} status={status} /> : null}
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
          <HeadCell label="평가손익·수익률" a11y="평가손익순 정렬" active={sort === "profit"} onPress={() => void setSort("profit")} width={col.right} />
        ) : (
          <HeadCell label="전일대비·거래량" width={col.right} />
        )}
      </TableHead>
    </View>
  );
  // 넓은 창 표 머리: 열 이름을 누르면 정렬 (설정의 정렬 값 그대로), 이름 칸의 "등록순 ▾" 는 정렬 창
  const tableHeader = (section: (typeof sections)[number]) => (
    <TableHeadRow plan={(section.key === "held" ? heldPlan : watchPlan)!} title={section.title} sort={sort} sortLabel={sortLabel} onSort={(k) => void setSort(k)} onOpenSort={() => setSortOpen(true)} />
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
  // 이어 보기(플래그가 켜져 있을 때만): 스크롤 위치·구역 머리·줄 위치를 잰다. 꺼져 있으면 아무것도 붙이지 않는다 (지금과 똑같다)
  const tracking = fold.on ? { ref: anchor.ref, onScroll: anchor.onScroll, onScrollBeginDrag: anchor.onScrollBeginDrag, scrollEventThrottle: SCROLL_THROTTLE } : null;
  const plans = wide && weights ? { held: heldPlan, watch: watchPlan } : null;

  return (
    <Screen
      scroll={false}
      top={
        wide ? (
          <>
            {wideTop}
            <StaleBanner query={stocks} open={open} maxAgeMs={openMaxAge} />
          </>
        ) : (
          <StaleBanner query={stocks} open={open} maxAgeMs={openMaxAge} />
        )
      }
      contentStyle={wide ? sideInsets : undefined}
    >
      {/* 잔고는 수십 줄이라 가상화 목록 대신 스크롤 + 고정 머리글로 그린다: 체결 묶음마다 목록 내부의 두 번째 커밋이 없고,
          체결이 온 줄만 다시 그린다 (3-17) */}
      <ScrollView
        // 플래그가 켜지는 순간(앱을 처음 열어 서버 값을 받을 때) 목록을 새로 그려 줄 위치를 처음부터 잰다 — 이미 그려진 줄에
        // 위치 재기(onLayout)를 나중에 붙이면 위치가 바뀌기 전까지 알려 주지 않는다. 꺼져 있으면 늘 같은 목록 (지금과 같다)
        key={fold.on ? "fold" : "phone"}
        stickyHeaderIndices={stickyIndices}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPull} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} />}
        contentContainerStyle={{ paddingBottom: space.xl }}
        {...tracking}
        {...(wide ? { onLayout: onTableLayout } : null)}
      >
        {header}
        {sections.length === 0
          ? empty
          : sections.flatMap((section) => [
              <View key={`h-${section.key}`} {...(fold.on ? { onLayout: (e: LayoutChangeEvent) => anchor.head(section.key, e) } : null)}>
                {plans ? tableHeader(section) : sectionHeader(section)}
              </View>,
              ...section.data.map((item, i) => (
                <StockRow
                  key={item.code}
                  stock={item}
                  showKrw={showKrw}
                  afterCost={afterCost}
                  live={quoteLive(item.quote, now, feedOk)}
                  onPress={openStock}
                  onLongPress={longPress}
                  {...(fold.on ? { onLayoutRow: rowLayout } : null)}
                  {...(plans
                    ? { columns: section.key === "held" ? plans.held : plans.watch, zebra: i % 2 === 1, weight: weights!.byCode.get(item.code) ?? null, weightMax: weights!.max }
                    : null)}
                />
              )),
            ])}
      </ScrollView>
      <SortSheet visible={sortOpen} value={sort} onClose={() => setSortOpen(false)} onPick={(k) => void setSort(k)} />
    </Screen>
  );
}

/** 이어 보기용 스크롤 이벤트 간격 (ms) — 맨 위 종목만 고르므로 자주 받을 필요가 없다 */
const SCROLL_THROTTLE = 100;

/**
 * 넓은 창 맨 위 띠 오른쪽 끝: 시장 상태 두 줄 + 검색 버튼 (탭 화면 머리의 검색과 같은 동작).
 * 상태 칸은 글자 폭에 맞추고(목업 약 140), 세션 이름이 길면 최대 폭(layout.stripStatusMaxW × 글자 배율, 탭 글자 상한 150% 까지)에서 접는다
 */
function StripEnd({ status }: { status: React.ReactNode }) {
  const t = useTheme();
  const scale = useFontScale(fontCap.chrome);
  return (
    <View style={[styles.stripEnd, { borderLeftColor: t.line }]}>
      <View style={[styles.stripStatus, { maxWidth: Math.round(layout.stripStatusMaxW * scale) }]}>{status}</View>
      <Pressable onPress={() => router.push("/stocks/add")} accessibilityRole="button" accessibilityLabel="종목 검색" style={styles.searchBtn}>
        <Ionicons name="search" size={TAB_ICON} color={t.ink} />
      </Pressable>
    </View>
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

/** 계좌 평가 패널 (휴대폰 화면): 총 평가금액(원화 환산) + 평가손익·수익률·매입·당일 + 국내/해외 구분 */
function AccountPanel({
  data,
  status,
  onAllocation,
}: {
  data: AccountData;
  status: React.ReactNode;
  /** 비중 보기 화면 열기 (플래그 allocationView 가 꺼져 있으면 없음 → 버튼도 없음) */
  onAllocation?: () => void;
}) {
  const t = useTheme();
  const { total, afterCost, fx, excluded } = data;
  // 합계는 원화로(환율을 모르면 원화 종목만). 해외 행은 설정에 따라 달러 또는 원화
  const { main, profit, rate, lines, showSplit } = accountFigures(data);
  const pc = changeColor(t, profit);
  const dc = changeColor(t, main.day);
  // 화면 읽기: 계좌 요약을 한 문장으로 (3-22, 넓은 창 계좌 띠와 같은 문장). 상태 줄(실시간·지연)은 따로 읽는다
  const label = accountSpeech(data);
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
      {/* 합계에서 뺀 보유 종목(시세·평단·환율 없음)을 알린다 — 말없이 빠져 총액이 작아 보이지 않게 (BH-04 · BH-26 · BH-30) */}
      {excluded ? <Text style={{ color: t.warn, fontSize: font.tiny }}>{excluded}</Text> : null}
      {showSplit ? (
        <View style={[styles.split, { borderTopColor: t.line }]}>
          {/* 숫자는 위 요약 문장에 들어 있다 → 조각으로 한 번 더 읽히지 않게 숨기고, 환율 안내 한 줄만 읽는다 */}
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.splitRows}>
          {lines.map((l) => {
            const { p, r } = lineProfit(l);
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
          {/* 환율 안내: 넓은 창 계좌 띠와 같은 함수 (문구를 한 곳에서만 고친다) */}
          {fx ? <Text style={{ color: t.muted, fontSize: font.tiny, textAlign: "right" }}>{fxNote(data)}</Text> : null}
        </View>
      ) : null}
      {/* 요약 문장(accessible) 밖에 둔다: 안에 두면 화면 읽기로 버튼을 고를 수 없다 (3-22) */}
      {onAllocation ? (
        <View style={styles.panelActions}>
          <Button title="비중" icon="pie-chart-outline" variant="secondary" compact accessibilityLabel="비중 보기" onPress={onAllocation} />
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
  // 비중 버튼(보이는 높이 32, hitSlop 으로 44): 위는 숫자·환율 글자라 넓혀도 겹치는 버튼이 없다
  panelActions: { flexDirection: "row", justifyContent: "flex-end", marginTop: space.xs },
  sectionBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.s },
  empty: { margin: space.lg, padding: space.lg, gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xl },
  sheetItem: { minHeight: touch.min, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.lg, borderTopWidth: StyleSheet.hairlineWidth },
  // ── 넓은 창 맨 위 띠 오른쪽 끝 ──
  stripEnd: { flexDirection: "row", alignItems: "stretch", borderLeftWidth: StyleSheet.hairlineWidth },
  // 시장 상태: 세션 / 실시간·시각 두 줄, 칸 폭은 글자에 맞춘다 (최대 폭은 StripEnd 가 글자 배율로)
  stripStatus: { flexShrink: 0, justifyContent: "center", alignItems: "flex-end", paddingHorizontal: space.sm },
  searchBtn: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
