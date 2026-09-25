import { Ionicons } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnyMarketOpen, useBriefings, useCandles, useStock, useStockMutations } from "@/api/hooks";
import type { AnalysisKind, CandlePeriod } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { CandleChart } from "@/components/CandleChart";
import { CANDLE_COUNT, parseCandlePeriod } from "@/lib/chartPrefs";
import { FlashPrice } from "@/components/FlashPrice";
import { ChartNotice, StaleBanner, useFeedState, usePull } from "@/components/Freshness";
import { DetailSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { SplitScreen } from "@/components/SplitScreen";
import { AnalysisTab, BriefingList, DetailHeader, FillChart, NewsColumns, NewsTab, PaneTitle, PairGrid, Range52, StatColumns, StatList, type HeaderAction, type StateLine, type StatProps } from "@/components/StockDetailParts";
import { ErrorView, LiveDot, Segmented, Stat, StatGrid } from "@/components/ui";
import { analysisTab, detailMode, parseDetailTab, shortStamp, phoneTab, sideWidth, splitColumns, statColumns, wideChartHeight, wideTab, type DetailTab } from "@/lib/detailLayout";
import { afterMarketLabel, currencyOfMarket, formatArrowDisplay, formatDateKo, formatKrwCompact, formatNumber, formatPct, formatPrice, formatQuote, formatQuoteDisplay, formatVolume, isUsMarket, shownSign, toDisplay } from "@/lib/format";
import { openMaxAge, parseStockCode, viewState } from "@/lib/freshness";
import { rememberNav, useHoldingsNav, type NavItem } from "@/lib/holdingsNav";
import { quoteLive, sessionNote, sessionOpen } from "@/lib/liveDot";
import { evalView, evaluate } from "@/lib/liveTick";
import { useSettings } from "@/lib/settings";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { changeColor, font, layout, slopFor, space, useTheme } from "@/theme";
import { foldDetail } from "@/tokens";
import { sentence, speakMove, speakRate } from "@/lib/a11y";

type Tab = AnalysisKind | "news";
const TABS: { value: Tab; label: string }[] = [
  { value: "company", label: "기업개요" },
  { value: "value", label: "가치분석" },
  { value: "technical", label: "기술분석" },
  { value: "news", label: "뉴스·공시" },
];
/** 넓은 창의 탭 (3-42): 최근 브리핑이 첫 탭. 오른쪽 칸 폭(340)에 다섯 개가 들어가게 이름을 줄였다 */
const WIDE_TABS: { value: DetailTab; label: string }[] = [
  { value: "briefing", label: "브리핑" },
  { value: "news", label: "뉴스·공시" },
  { value: "company", label: "기업개요" },
  { value: "value", label: "가치" },
  { value: "technical", label: "기술" },
];
/** 윗줄+아랫줄 배치의 오른쪽 칸 AI 분석 탭 (브리핑·뉴스·공시는 아랫줄에 늘 보인다) */
const ANALYSIS_TABS: { value: AnalysisKind; label: string }[] = [
  { value: "company", label: "기업개요" },
  { value: "value", label: "가치분석" },
  { value: "technical", label: "기술분석" },
];

/** 시세표 항목 (휴대폰 화면 2열 격자의 가로 먼저 순서) */
type QuoteId = "open" | "prev" | "high" | "volume" | "low" | "cap" | "h52" | "l52" | "per" | "pbr" | "eps" | "bps" | "dy" | "dps";
const PHONE_ORDER: QuoteId[] = ["open", "prev", "high", "volume", "low", "cap", "h52", "l52", "per", "pbr", "eps", "bps", "dy", "dps"];
/** 여러 칸에 위에서 아래로 나눌 때의 읽는 순서 (시가·고가·저가·전일·거래량 → 시가총액·52주 → 가치 지표) */
const COLUMN_ORDER: QuoteId[] = ["open", "high", "low", "prev", "volume", "cap", "h52", "l52", "per", "pbr", "eps", "bps", "dy", "dps"];

/**
 * 종목 상세: 시세 헤더, 52주 위치, 지표 격자, 캔들 차트, 4개 탭, 최근 브리핑.
 * 넓은 창(3-42 웨이브 C, 기능 플래그 foldLayout)에서는 합친 머리 아래 배치를 바꾼다 (lib/detailLayout detailMode):
 *  - split (펼친 폴드8 가로·울트라 가로): 왼쪽 차트 고정 | 오른쪽 칸(보유·시세·52주·탭)만 스크롤
 *  - rows (울트라 펼침 세로): 윗줄 차트 | 보유·시세·AI 분석, 아랫줄 최근 브리핑 · 뉴스 · 공시
 *  - wide (폴드8 펼침 세로): 차트 전체 폭 → 보유·시세 여러 칸 → 탭
 * 플래그가 꺼져 있거나 좁은 창(접힌 화면)이면 지금 화면 그대로다 (phone).
 * 차트 기간·탭은 주소 검색어(period·tab)에도 남겨, 접고 펼 때 화면을 다시 만들거나 ‹ › 로 다음 종목으로 넘어가도 이어진다
 */
export default function StockDetailScreen() {
  const t = useTheme();
  const params = useLocalSearchParams<{ code: string; period?: string; tab?: string; nav?: string }>();
  const { code } = params;
  // 잘못된 딥링크(stocks/%20 등)는 서버에 묻지 않고 안내만 한다
  const c = parseStockCode(code) ?? "";
  const stock = useStock(c);
  const live = useAnyMarketOpen();
  const { register } = useStockMutations();
  const { showKrw, afterCost } = useSettings();
  // 넓은 창 배치 (플래그가 꺼져 있으면 창 크기와 상관없이 phone)
  const fold = useFoldLayout();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const mode = detailMode(fold, win);
  // 차트 기간·탭: 주소 검색어에 있으면 그 값으로 연다 (없으면 지금처럼 일봉 · 기업개요, 넓은 창은 최근 브리핑)
  const [period, setPeriodState] = useState<CandlePeriod>(() => parseCandlePeriod(params.period));
  const [tabPick, setTabPick] = useState<DetailTab | null>(() => parseDetailTab(params.tab));
  // 플래그가 켜져 있으면 고른 값을 주소 검색어에도 남긴다 (접고 펼 때 · ‹ › 로 넘길 때 이어지게)
  const setPeriod = (p: CandlePeriod) => {
    setPeriodState(p);
    if (fold.on) router.setParams({ period: p });
  };
  const setTab = (v: DetailTab) => {
    setTabPick(v);
    if (fold.on) router.setParams({ tab: v });
  };
  const tab = phoneTab(tabPick);
  // 넓은 창에서 Stack 머리를 숨긴 적이 있으면, 다시 좁아질 때 머리를 되살린다 (화면 옵션은 합쳐지므로 숨김이 남는다)
  const [hidHeader, setHidHeader] = useState(false);
  if (mode !== "phone" && !hidHeader) setHidHeader(true);
  // ‹ n/17 ›: 잔고 화면과 같은 순서의 이전·다음 종목 (넓은 창에서만 계산한다)
  const nav = useHoldingsNav(c, params.nav === "1", mode !== "phone");
  // 미등록 종목에서 "AI 분석 만들기"를 누른 탭 (탭을 오가도 다시 묻지 않게 화면에 둔다)
  const [asked, setAsked] = useState<Partial<Record<AnalysisKind, true>>>({});
  // 관심 추가를 눌러 서버 반영·새로고침이 끝날 때까지 (시세 자동 갱신 중에도 버튼이 깜빡이지 않게 따로 둔다)
  const [adding, setAdding] = useState(false);
  // 윗줄+아랫줄 배치: 윗줄 오른쪽 칸 높이 (차트를 이 높이에 맞춘다)
  const [rowsSideH, setRowsSideH] = useState<number | null>(null);
  // 과거 구간 이동과 120 이평선을 위해 넉넉히 받는다 (일봉 약 3년, 주봉 5년, 월봉 10년)
  const candles = useCandles(c, period, CANDLE_COUNT[period]);
  const briefings = useBriefings({ code: c, limit: 3 }, !!c);
  const { pulling, onPull } = usePull(() => Promise.all([stock.refetch(), candles.refetch()]));
  // 초록 점·"실시간": 이 종목 가격이 지금 열린 세션에서 실시간으로 갱신되고, 앱도 값을 제때 받을 때만 (lib/liveDot)
  const detailQuote = stock.data?.quote ?? null;
  const detailQuotes = useMemo(() => [detailQuote], [detailQuote]);
  // 미등록 종목(발견 탭에서 연 종목)은 체결 스트림이 오지 않아 폴링 값으로만 본다
  const { now, feedOk } = useFeedState(stock, detailQuotes, stock.data?.registered !== false);

  if (!c) return <Screen><ErrorView error={new Error("종목 주소가 올바르지 않습니다")} retryLabel="잔고로" onRetry={() => router.dismissTo("/")} /></Screen>;
  const view = viewState(stock);
  if (view === "loading") return <Screen><DetailSkeleton /></Screen>;
  if (view === "error") return <Screen><ErrorView error={stock.error} onRetry={() => void stock.refetch()} /></Screen>;
  const s = stock.data!;
  const q = s.quote;
  // 발견 탭 등에서 연 미등록 종목: 수정 대신 관심 추가
  const unregistered = s.registered === false;
  const addWatch = () => {
    if (adding) return;
    setAdding(true);
    const done = () => void stock.refetch().finally(() => setAdding(false));
    register.mutate(
      { code: s.code },
      {
        onSuccess: done,
        onError: (e) => {
          // 두 번 눌러 이미 등록된 경우(409)는 성공으로 본다
          if (e instanceof Error && /이미 등록/.test(e.message)) return done();
          setAdding(false);
          Alert.alert("관심 추가 실패", e instanceof Error ? e.message : String(e));
        },
      },
    );
  };
  const cur = q?.currency ?? currencyOfMarket(s.market);
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const displayCur = toDisplay(1, cur, fx, showKrw).currency;
  const nxt = q?.afterMarket ?? null;
  // 서버 평가(토스 매입금액·비용 비율·원화 매입금액 포함)를 쓰고, 구버전 서버면 수량×평단으로 계산
  const baseEval = s.evaluation ?? (q ? evaluate(s, q) : null);
  const evNative = evalView(baseEval, { afterCost, toKrw: false, currency: cur, fx });
  const evKrw = cur === "USD" ? evalView(baseEval, { afterCost, toKrw: true, currency: cur, fx }) : null;
  const ev = evNative;
  const quote = (n: number | null | undefined) => formatQuoteDisplay(n, cur, fx, showKrw);
  const arrow = (n: number | null | undefined) => formatArrowDisplay(n, cur, fx, showKrw);
  const range52 = q && q.high52w && q.low52w && q.high52w > q.low52w ? Math.min(1, Math.max(0, (q.price - q.low52w) / (q.high52w - q.low52w))) : null;

  const up = changeColor(t, q?.change);
  const realtime = quoteLive(q, now, feedOk);
  // 점이 없을 때 까닭: 주간거래 미지원 · NXT 비대상 · 거래정지 · 닫힌 세션 (예전 서버면 없음)
  const note = realtime ? null : sessionNote(q);
  // 지연 띠의 장중 판단: 이 종목 세션(미국 프리·애프터·주간거래 포함). 예전 서버면 장 상태
  const open = sessionOpen(q ? [q] : []) ?? live.open;
  // 등락·손익 글자의 색은 그 글자에 보이는 값으로 — "0"·"0.00%"·"0원" 으로 보이는 값을 손실·이익 색으로 칠하지 않게 (BH-38)
  const shownColor = (n: number | null | undefined, text: string) => changeColor(t, shownSign(n, text));
  const shownStat = (n: number, text: string) => ({ value: text, change: shownSign(n, text) });

  // 시세표 칸 (휴대폰 2열 격자와 넓은 창 격자가 같은 값을 쓴다)
  const quoteStats: Record<QuoteId, StatProps> | null = q
    ? {
        open: { label: "시가", value: quote(q.open), change: q.open !== null && q.prevClose ? q.open - q.prevClose : null },
        prev: { label: "전일", value: quote(q.prevClose) },
        high: { label: "고가", value: quote(q.high), change: q.high !== null && q.prevClose ? q.high - q.prevClose : null },
        volume: { label: "거래량", value: formatVolume(q.volume) },
        low: { label: "저가", value: quote(q.low), change: q.low !== null && q.prevClose ? q.low - q.prevClose : null },
        cap: { label: "시가총액", value: showKrw && cur === "USD" && fx && q.marketCap !== null ? formatKrwCompact(q.marketCap * fx, "KRW") : formatKrwCompact(q.marketCap, cur) },
        h52: { label: "52주 최고", value: quote(q.high52w) },
        l52: { label: "52주 최저", value: quote(q.low52w) },
        per: { label: "PER", value: q.per !== null ? `${formatNumber(q.per, 2)}배` : "-" },
        pbr: { label: "PBR", value: q.pbr !== null ? `${formatNumber(q.pbr, 2)}배` : "-" },
        eps: { label: "EPS", value: q.eps !== null ? formatQuote(q.eps, cur) : "-" },
        bps: { label: "BPS", value: q.bps !== null ? formatQuote(q.bps, cur) : "-" },
        dy: { label: "배당수익률", value: q.dividendYieldPct !== null && q.dividendYieldPct !== undefined ? `${formatNumber(q.dividendYieldPct, 2)}%` : "-" },
        dps: { label: "주당배당", value: q.dividendPerShare !== null && q.dividendPerShare !== undefined ? formatQuote(q.dividendPerShare, cur) : "-" },
      }
    : null;
  const holdStats: StatProps[] = ev
    ? [
        { label: "보유수량", value: `${formatNumber(s.quantity, Number.isInteger(s.quantity) ? 0 : 4)}주` },
        { label: "평균단가", value: formatQuote(s.avgPrice, cur) },
        { label: "평가금액", value: formatPrice(ev.marketValue, cur) },
        { label: "매입금액", value: formatPrice(ev.costBasis, cur) },
        { label: "평가손익", ...shownStat(ev.profit, formatPrice(ev.profit, cur, { sign: true })) },
        { label: "수익률", ...shownStat(ev.profitRate, formatPct(ev.profitRate)) },
      ]
    : [];
  const krwStats: StatProps[] =
    evKrw?.currency === "KRW"
      ? [
          { label: "평가금액", value: formatPrice(evKrw.marketValue, "KRW") },
          { label: "매입금액", value: formatPrice(evKrw.costBasis, "KRW") },
          { label: "평가손익", ...shownStat(evKrw.profit, formatPrice(evKrw.profit, "KRW", { sign: true })) },
          { label: "수익률", ...shownStat(evKrw.profitRate, formatPct(evKrw.profitRate)) },
        ]
      : [];
  const krwNote = evKrw ? (evKrw.krwBasis === "current" ? "원화 기준 (현재 환율 환산)" : `원화 기준 (매수 당시 환율${evKrw.estimated ? " · 추정" : ""})`) : "";
  const range = q && range52 !== null ? <Range52 range={range52} low={quote(q.low52w)} high={quote(q.high52w)} color={up === t.ink ? t.sub : up} /> : null;
  // 화면 읽기: 가격·등락을 한 문장으로 (3-22)
  const priceSpeech = q
    ? sentence([
        `현재가 ${quote(q.price)}${displayCur === "KRW" ? "원" : "달러"}`,
        speakMove(`${arrow(q.change)}${displayCur === "KRW" ? "원" : "달러"}`, shownSign(q.change, arrow(q.change))),
        speakRate(q.changeRate),
        realtime ? "실시간" : note,
      ])
    : "";

  if (mode === "phone")
    return (
      <Screen
        disclaimer
        refreshing={pulling}
        onRefresh={onPull}
        top={<StaleBanner query={stock} open={open} maxAgeMs={openMaxAge} />}
      >
        <Stack.Screen
          options={{
            // 넓은 창에서 숨겼던 머리를 되살린다 (처음부터 좁은 창이면 지금 옵션 그대로)
            ...(hidHeader ? { headerShown: true } : {}),
            title: s.name,
            headerRight: () =>
              unregistered ? (
                <Pressable onPress={addWatch} disabled={adding} accessibilityRole="button" accessibilityLabel="관심 종목에 추가" accessibilityState={{ busy: adding, disabled: adding }} hitSlop={slopFor(font.small * 1.35, space.xs)} style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginRight: space.sm, paddingHorizontal: space.xs }}>
                  <Ionicons name="star-outline" size={20} color={t.gold} />
                  <Text style={{ color: t.gold, fontSize: font.small, fontWeight: "700" }}>{adding ? "추가 중" : "관심 추가"}</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => router.push(`/stocks/${c}/edit`)} accessibilityRole="button" accessibilityLabel="보유 정보 수정" hitSlop={slopFor(HEADER_ICON, space.sm)}>
                  <Ionicons name="create-outline" size={HEADER_ICON} color={t.ink} />
                </Pressable>
              ),
          }}
        />

        {/* 시세 머리 */}
        <View style={[styles.quoteHead, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
          <Text style={{ color: t.muted, fontSize: font.small }} numberOfLines={1}>
            {s.code} · {s.market}
            {q?.industry ? ` · ${q.industry}` : ""}
            {unregistered ? " · 미등록" : s.quantity ? "" : " · 관심"}
          </Text>
          {q ? (
            <>
              {/* 화면 읽기: 가격·등락을 한 문장으로 (3-22) */}
              <View accessible accessibilityLabel={priceSpeech} style={{ gap: space.xxs }}>
                <View style={styles.priceRow}>
                  <FlashPrice value={q.price} text={quote(q.price)} style={[styles.bigPrice, { color: up }]} />
                  <Text style={{ color: t.muted, fontSize: font.body }}>{displayCur === "KRW" ? "원" : "USD"}</Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Text style={[styles.change, { color: shownColor(q.change, arrow(q.change)) }]}>{arrow(q.change)}</Text>
                  <Text style={[styles.change, { color: shownColor(q.changeRate, formatPct(q.changeRate)) }]}>{formatPct(q.changeRate)}</Text>
                  {realtime ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                      <LiveDot />
                      <Text style={{ color: t.live, fontSize: font.tiny, fontWeight: "700" }}>실시간</Text>
                    </View>
                  ) : note ? (
                    <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1 }} numberOfLines={2}>
                      {note}
                    </Text>
                  ) : null}
                </View>
              </View>
              {cur === "USD" ? (
                <Text style={styles.sub(t.muted)}>
                  {showKrw ? `$${formatQuote(q.price, "USD")}` : `${formatQuote(q.priceKrw ?? (fx ? q.price * fx : null), "KRW")}원`} · 환율 {fx ? formatNumber(fx, 2) : "-"}
                </Text>
              ) : null}
              {nxt ? (
                <Text style={[styles.sub(changeColor(t, nxt.change))]}>
                  {afterMarketLabel(nxt)} {quote(nxt.price)} {arrow(nxt.change)} {formatPct(nxt.changeRate)}
                </Text>
              ) : null}
              <Text style={styles.sub(t.muted)}>
                {q.priceBasis ?? q.source.toUpperCase()} · {formatDateKo(q.asOf, true)}
                {q.stale ? " · 시세 지연" : ""}
              </Text>
            </>
          ) : (
            <Text style={{ color: t.danger, marginTop: space.xs }}>{s.quoteError ?? "시세 없음"}</Text>
          )}
        </View>

        {/* 차트 */}
        <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
          <CandleChart
            candles={candles.data?.candles}
            period={period}
            onPeriodChange={setPeriod}
            loading={candles.isLoading}
            currency={cur}
            avgPrice={s.avgPrice}
            quote={q}
            onFullscreen={() => router.push(`/stocks/${c}/chart?period=${period}` as never)}
          />
          <ChartNotice query={candles} />
        </View>

        {/* 시세 정보 */}
        {q && quoteStats ? (
          <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
            <Text style={styles.panelTitle(t.ink)}>시세</Text>
            <StatGrid>
              {PHONE_ORDER.map((id) => (
                <Stat key={id} {...quoteStats[id]} />
              ))}
            </StatGrid>
            {range}
          </View>
        ) : null}

        {/* 잔고 */}
        {ev ? (
          <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
            <Text style={styles.panelTitle(t.ink)}>잔고</Text>
            <StatGrid>
              {holdStats.map((p) => (
                <Stat key={p.label} {...p} />
              ))}
            </StatGrid>
            {krwStats.length ? (
              <>
                <Text style={[styles.sub(t.muted), { marginTop: space.xs }]}>{krwNote}</Text>
                <StatGrid>
                  {krwStats.map((p) => (
                    <Stat key={p.label} {...p} />
                  ))}
                </StatGrid>
              </>
            ) : null}
            {afterCost && baseEval?.afterCost ? <Text style={styles.sub(t.muted)}>평가금액·손익은 매도 시 예상 수수료·세금 차감 후 (토스 기준)</Text> : null}
            {s.memo ? <Text style={styles.sub(t.muted)}>메모 {s.memo}</Text> : null}
          </View>
        ) : null}

        <Segmented options={TABS} value={tab} onChange={setTab} style={{ marginTop: space.xxs }} />
        {tab === "news" ? (
          <NewsTab code={c} us={isUsMarket(s.market)} />
        ) : (
          // 관심 종목이 되면(unregistered → false) 바로 자동으로 만든다
          <AnalysisTab key={`${c}:${tab}`} code={c} kind={tab} requested={!unregistered || !!asked[tab]} onRequest={(k) => setAsked((m) => ({ ...m, [k]: true }))} />
        )}

        {briefings.data && briefings.data.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <Text style={[styles.panelTitle(t.ink), { paddingHorizontal: space.lg, paddingTop: space.sm }]}>최근 브리핑</Text>
            {briefings.data.map((b) => (
              <BriefingCard key={b.id} briefing={b} mode="summary" showName={false} />
            ))}
          </View>
        ) : null}
      </Screen>
    );

  // ── 넓은 창 (3-42 웨이브 C) ──
  const us = isUsMarket(s.market);
  const requestAi = (k: AnalysisKind) => setAsked((m) => ({ ...m, [k]: true }));
  const go = (to: NavItem | null) => {
    if (!to || !nav) return;
    // 넘기는 동안 같은 순서를 쓰도록 남기고, 뒤로 가기에 쌓지 않게 바꿔 끼운다 (뒤로 1번이면 잔고). 차트 기간·탭은 이어진다
    rememberNav(nav, to.code);
    router.replace({ pathname: "/stocks/[code]", params: { code: to.code, period, tab: wideTab(tabPick), nav: "1" } } as never);
  };
  const action: HeaderAction = unregistered ? { kind: "watch", busy: adding, onPress: addWatch } : { kind: "edit", onPress: () => router.push(`/stocks/${c}/edit`) };
  // 시장 상태 줄: 실시간(초록 점) 또는 까닭 · 달러 종목 원화 환산 · 시간외 · 시세 기준과 시각
  const state: StateLine[] = q
    ? [
        ...(realtime ? [{ text: "실시간", color: t.live, live: true }] : note ? [{ text: note }] : []),
        ...(cur === "USD" ? [{ text: `${showKrw ? `$${formatQuote(q.price, "USD")}` : `${formatQuote(q.priceKrw ?? (fx ? q.price * fx : null), "KRW")}원`} · 환율 ${fx ? formatNumber(fx, 2) : "-"}` }] : []),
        ...(nxt ? [{ text: `${afterMarketLabel(nxt)} ${quote(nxt.price)} ${arrow(nxt.change)} ${formatPct(nxt.changeRate)}`, color: changeColor(t, nxt.change) }] : []),
        { text: `${q.priceBasis ?? q.source.toUpperCase()} · ${formatDateKo(q.asOf, true)}${q.stale ? " · 시세 지연" : ""}`, short: `${shortStamp(q.asOf)}${q.stale ? " · 시세 지연" : ""}` },
      ]
    : [];
  const header = (
    <DetailHeader
      name={s.name}
      sub={`${s.code} · ${s.market}${q?.industry ? ` · ${q.industry}` : ""}${unregistered ? " · 미등록" : s.quantity ? "" : " · 관심"}`}
      quote={
        q
          ? {
              value: q.price,
              price: quote(q.price),
              unit: displayCur === "KRW" ? "원" : "USD",
              change: arrow(q.change),
              rate: formatPct(q.changeRate),
              priceColor: up,
              changeColor: shownColor(q.change, arrow(q.change)),
              rateColor: shownColor(q.changeRate, formatPct(q.changeRate)),
              a11y: priceSpeech,
            }
          : null
      }
      quoteError={s.quoteError ?? "시세 없음"}
      state={state}
      nav={nav}
      onPrev={() => go(nav?.prev ?? null)}
      onNext={() => go(nav?.next ?? null)}
      onBack={() => (router.canGoBack() ? router.back() : router.dismissTo("/"))}
      action={action}
    />
  );
  const banner = <StaleBanner query={stock} open={open} maxAgeMs={openMaxAge} />;
  const chart = (height?: number) => (
    <CandleChart
      candles={candles.data?.candles}
      period={period}
      onPeriodChange={setPeriod}
      loading={candles.isLoading}
      currency={cur}
      avgPrice={s.avgPrice}
      quote={q}
      height={height}
      onFullscreen={() => router.push(`/stocks/${c}/chart?period=${period}` as never)}
    />
  );
  const holdNote = afterCost && baseEval?.afterCost ? "매도 비용 차감 · 토스 기준" : null;
  const krwBlock = krwStats.length ? <Text style={[styles.sub(t.muted), { marginTop: space.xs }]}>{krwNote}</Text> : null;
  const memo = s.memo ? <Text style={styles.sub(t.muted)}>메모 {s.memo}</Text> : null;
  const wTab = wideTab(tabPick);
  const tabBody =
    wTab === "briefing" ? (
      <BriefingList query={briefings} />
    ) : wTab === "news" ? (
      <NewsTab code={c} us={us} />
    ) : (
      <AnalysisTab key={`${c}:${wTab}`} code={c} kind={wTab} requested={!unregistered || !!asked[wTab]} onRequest={requestAi} />
    );
  const tabs = <Segmented options={WIDE_TABS} value={wTab} onChange={setTab} />;

  // 오른쪽 칸(좌우 배치) · 윗줄 오른쪽(윗줄+아랫줄 배치): 내 보유 → 시세 → 52주 (한 줄에 칸 2개, 큰 글씨는 1개)
  const sideW = sideWidth(win.fontScale);
  const sideCols = statColumns(sideW - space.lg * 2, win.fontScale, 2);
  const sideStats = (
    <View style={styles.side}>
      {ev ? (
        <View>
          <PaneTitle title="내 보유" note={holdNote} />
          <PairGrid items={holdStats} cols={sideCols} />
          {krwBlock}
          {krwStats.length ? <PairGrid items={krwStats} cols={sideCols} /> : null}
          {memo}
        </View>
      ) : null}
      {q && quoteStats ? (
        <View>
          <PaneTitle title="시세" />
          <PairGrid items={PHONE_ORDER.map((id) => quoteStats[id])} cols={sideCols} />
          {range}
        </View>
      ) : null}
    </View>
  );

  if (mode === "split")
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SplitScreen
          head={header}
          top={banner}
          sideW={sideW}
          refreshing={pulling}
          onRefresh={onPull}
          left={(pane) => (
            <FillChart
              height={pane?.height ?? null}
              render={(h) => (
                <>
                  {chart(h)}
                  <ChartNotice query={candles} />
                </>
              )}
            />
          )}
          right={
            <>
              <View style={{ backgroundColor: t.surface }}>{sideStats}</View>
              {tabs}
              <View style={styles.tabBody}>{tabBody}</View>
            </>
          }
        />
      </>
    );

  if (mode === "rows") {
    const aTab = analysisTab(tabPick);
    const vline = <View style={[styles.vline, { backgroundColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />;
    return (
      <Screen
        disclaimer
        refreshing={pulling}
        onRefresh={onPull}
        contentStyle={styles.wideContent}
        top={
          <>
            {header}
            {banner}
          </>
        }
      >
        <Stack.Screen options={{ headerShown: false }} />
        {/* 윗줄: 차트 | 내 보유 · 시세 · 52주 · AI 분석. 차트는 옆 칸 높이만큼 늘려 윗줄에 빈 곳을 남기지 않는다 (기본 크기보다 작아지지는 않는다) */}
        <View style={[styles.rowsTop, { borderBottomColor: t.line, backgroundColor: t.surface, paddingLeft: insets.left }]}>
          <FillChart
            height={rowsSideH}
            minH={Math.min((win.width - insets.left - insets.right - sideW - space.md * 2) * layout.chartAspect, win.height * layout.chartMaxHRatio)}
            style={styles.rowsChart}
            render={(h) => (
              <>
                {chart(h)}
                <ChartNotice query={candles} />
              </>
            )}
          />
          {vline}
          <View
            style={[styles.rowsSide, { width: sideW + insets.right, paddingRight: insets.right }]}
            onLayout={(e) => {
              const h = Math.round(e.nativeEvent.layout.height);
              if (h !== rowsSideH) setRowsSideH(h);
            }}
          >
            {sideStats}
            <View style={styles.side}>
              <PaneTitle title="AI 분석" />
            </View>
            <Segmented options={ANALYSIS_TABS} value={aTab} onChange={setTab} />
            <AnalysisTab key={`${c}:${aTab}`} code={c} kind={aTab} requested={!unregistered || !!asked[aTab]} onRequest={requestAi} preview />
          </View>
        </View>
        {/* 아랫줄: 최근 브리핑 · 뉴스 · 공시 — 탭을 누르지 않아도 함께 보인다 */}
        <View style={[styles.rowsFeed, { backgroundColor: t.surface, paddingLeft: insets.left, paddingRight: insets.right }]}>
          <View style={styles.feedBrief}>
            <View style={styles.side}>
              <PaneTitle title="최근 브리핑" />
            </View>
            <BriefingList query={briefings} max={foldDetail.rowsBriefings} />
          </View>
          {vline}
          <NewsColumns code={c} us={us} divider={vline} />
        </View>
      </Screen>
    );
  }

  // wide: 폴드8 펼침 세로 — 차트 전체 폭 → 내 보유 | 시세 여러 칸 → 탭
  const innerW = win.width - insets.left - insets.right - space.lg * 2;
  const n = statColumns(innerW, win.fontScale, 4);
  // 달러 종목의 원화 기준 4칸: 칸이 넉넉하면(4칸) 따로 한 칸을 써서 보유 칸만 길게 늘어나지 않게, 아니면 보유 칸 아래에
  const krwCol = krwStats.length > 0 && n >= 4;
  const holdCol = ev ? (krwCol ? 2 : 1) : 0;
  const quoteCols = splitColumns(quoteStats ? COLUMN_ORDER.map((id) => quoteStats[id]) : [], Math.max(1, n - holdCol));
  const shortNote = holdNote ? "비용 차감 · 토스" : null;
  const columns = [
    ...(ev
      ? [
          {
            key: "hold",
            title: "내 보유",
            note: shortNote,
            body: (
              <>
                <StatList items={holdStats} />
                {krwCol ? null : krwBlock}
                {!krwCol && krwStats.length ? <StatList items={krwStats} /> : null}
                {memo}
              </>
            ),
          },
          ...(krwCol ? [{ key: "krw", title: "원화 기준", note: krwNote.replace(/^원화 기준 \((.*)\)$/, "$1"), body: <StatList items={krwStats} /> }] : []),
        ]
      : []),
    ...(quoteStats
      ? quoteCols.map((items, i) => ({
          key: `q${i}`,
          title: i === 0 ? "시세" : undefined,
          body: (
            <>
              <StatList items={items} />
              {i === quoteCols.length - 1 ? range : null}
            </>
          ),
        }))
      : []),
  ];
  return (
    <Screen
      disclaimer
      refreshing={pulling}
      onRefresh={onPull}
      contentStyle={styles.wideContent}
      top={
        <>
          {header}
          {banner}
        </>
      }
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line, paddingLeft: space.lg + insets.left, paddingRight: space.lg + insets.right }]}>
        {chart(wideChartHeight(innerW, win.height))}
        <ChartNotice query={candles} />
      </View>
      {columns.length ? (
        <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line, paddingLeft: space.lg + insets.left, paddingRight: space.lg + insets.right }]}>
          <StatColumns columns={columns} />
        </View>
      ) : null}
      {tabs}
      <View style={styles.tabBody}>{tabBody}</View>
    </Screen>
  );
}

const styles = {
  ...StyleSheet.create({
    quoteHead: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.xxs },
    priceRow: { flexDirection: "row", alignItems: "baseline", gap: space.s, marginTop: space.xxs },
    bigPrice: { fontSize: font.hero, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
    change: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
    panel: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm },
    // 넓은 창
    wideContent: { gap: 0, paddingBottom: space.md },
    side: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.md },
    tabBody: { paddingTop: space.sm, paddingBottom: space.md, gap: space.sm },
    rowsTop: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
    // 윗줄 두 칸은 제 내용 높이로 (늘여 붙이면 차트 둘레 높이를 잘못 잰다) — 줄 바탕은 윗줄이 칠한다
    rowsChart: { flex: 1, minWidth: 0, alignSelf: "flex-start" },
    rowsSide: { alignSelf: "flex-start" },
    rowsFeed: { flexDirection: "row", alignItems: "stretch" },
    feedBrief: { flex: 1, minWidth: 0, paddingBottom: space.md, gap: space.xs },
    vline: { width: StyleSheet.hairlineWidth, alignSelf: "stretch" },
  }),
  sub: (color: string) => ({ color, fontSize: font.small, fontVariant: ["tabular-nums" as const] }),
  panelTitle: (color: string) => ({ color, fontSize: font.body, fontWeight: "700" as const }),
};

/** 머리 오른쪽 아이콘 크기 */
const HEADER_ICON = 21;

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
