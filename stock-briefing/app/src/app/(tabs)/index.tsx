import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnyMarketOpen, useFeature, useHealth, useStockMutations, useStocks } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { AccountBand, accountFigures, accountSpeech, fxNote, lineProfit, type AccountData } from "@/components/AccountBand";
import { LiveStatus, StaleBanner, useFeedState, usePull } from "@/components/Freshness";
import { TableHeadRow } from "@/components/HoldingsTableHead";
import { MemberNotice } from "@/components/MemberNotice";
import { MEMBER_EMPTY_HOLDINGS, useAccountView } from "@/lib/account";
import { MarketStrip } from "@/components/MarketStrip";
import { BasisMark } from "@/components/NumberBasis";
import { useReturnMark } from "@/components/ReturnMark";
import { HoldingsSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { StockRow } from "@/components/StockRow";
import { PRICE_HEAD, useLineCols } from "@/components/StockLine";
import { closeOpenRow, SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { TossImportButton } from "@/components/TossImportButton";
import { TossAccountSummary } from "@/components/TossAccountSummary";
import { Button, ErrorView, TableHead } from "@/components/ui";
import { panelBasisFit } from "@/lib/basisFit";
import { gated } from "@/lib/features";
import { formatPct, formatPrice, formatQuote } from "@/lib/format";
import { holdingsSuffix, openMaxAge, staleQuoteCount, viewState } from "@/lib/freshness";
import { haptic } from "@/lib/haptics";
import { holdingsLayoutKey, useHoldingsAnchor } from "@/lib/holdingsAnchor";
import { bandOneLine, bandRates, holdingWeights, pickCols, pickWatchCols } from "@/lib/holdingsColumns";
import { quoteLive, sessionOpen } from "@/lib/liveDot";
import { excludedLabel, isHolding, sortHoldings, splitHoldings, summarize } from "@/lib/portfolio";
import { removeConfirm, removeKind, removeLabel } from "@/lib/rowActions";
import { SORT_OPTIONS, useSettings, type SortKey } from "@/lib/settings";
import { useSettingsGuide } from "@/lib/settingsLink";
import { TAB_ICON } from "@/lib/textScale";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { useGuideMarks, useUx } from "@/lib/uxFlags";
import { isWide, railWidth } from "@/lib/windowClass";
import { changeColor, font, fontCap, layout, slopFor, space, touch, useFontScale, useTheme } from "@/theme";

/**
 * 홈(잔고): 지수 띠 → 계좌 평가 → 보유 표 → 관심 표.
 * 넓은 창(펼친 폴드·태블릿, 기능 플래그 foldLayout — 3-42 웨이브 B): 탭 화면 머리 대신 맨 위 띠(지수 두 줄 칸 · 시장 상태 · 검색)를 고정하고,
 * 그 아래 계좌 띠(한 줄/두 줄) → 한 줄 44dp 표(숫자 열은 폭·글자 크기에 따라 pickCols). 접힌 화면·플래그 꺼짐은 지금 휴대폰 화면 그대로
 * 촘촘(3-39, densityMode + 설정 '잔고 표시 촘촘'): 휴대폰·접은 화면은 지수 띠 두 줄 칸 · 계좌 요약 세 줄 · 구역 머리 44(비중 버튼) · 종목 줄 최소 44,
 * 넓은 창은 두 줄 계좌 띠만 첫 줄로. 플래그가 꺼져 있거나 '기본'이면 지금 그대로
 */
export default function StocksScreen() {
  const t = useTheme();
  const stocks = useStocks();
  const { data, error, refetch } = stocks;
  const { sort, setSort, showKrw, afterCost, density } = useSettings();
  const { remove } = useStockMutations();
  const health = useHealth();
  const live = useAnyMarketOpen();
  const [sortOpen, setSortOpen] = useState(false);
  const col = useLineCols();
  // 비중 보기 (새 기능): 서버가 켤 때만 계좌 평가 패널에 '비중' 버튼
  const allocationOn = useFeature("allocationView", false);
  const openAllocation = useCallback(() => router.push("/portfolio/allocation"), []);
  // 계정 A단계 (플래그 accounts): 주인 아닌 계정 (꺼져 있으면 늘 false — 지금 화면 그대로)
  const { member } = useAccountView();
  // 숫자 기준 점 (3-32, 플래그 numberBasis): 켜졌을 때만 계좌 패널·띠에 점 + 토스 대조 글 (훅이므로 아래 이른 return 보다 위)
  const basisOn = useFeature("numberBasis", false);
  const tossSnapshotOn = useFeature("tossAccountSnapshot", false);
  const informationFocus = useFeature("informationFocus", false);
  // 촘촘 모드 (3-39): 서버 플래그 + 설정 '잔고 표시 촘촘'. 불러오는 중 화면도 쓰므로 일찍 돌아가는 줄보다 위에서 정한다
  const densityOn = useFeature("densityMode", false);
  const dense = densityOn && density === "dense";
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
  // 표 폭: 표가 실제로 받은 폭(onLayout). 잰 값은 그 창 크기·탭 막대·글자 크기(탭 막대 폭이 글자 배율을 따른다)에서만 쓴다 — 접고 펴서 창이 바뀌면 새로 잴 때까지는
  // 창 폭에서 세로 탭 막대·좌우 화면 여백을 뺀 어림값 (지난 창의 폭으로 열을 한 번 잘못 고르지 않게)
  const sizeKey = `${winW}:${fold.rail ? "rail" : "bar"}:${fontScale}`;
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

  // 종목 시세 추정: 정렬·비중·추정 펼치기에 쓴다. 계좌 대표 금액은 토스 수신값을 표시한다.
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

  // 이어 보기: 목록에서 빠진 종목(삭제 등)의 줄 위치는 버린다 (맨 위 종목으로 사라진 종목을 기억하지 않게)
  useEffect(() => {
    if (fold.on) anchor.keep(new Set(sections.flatMap((x) => x.data.map((i) => i.code))));
  }, [fold.on, anchor, sections]);

  const confirmRemove = (s: RegisteredWithQuote) =>
    // 토스 연동 종목은 삭제하면 동기화에서도 빠진다는 것을 먼저 알린다 (수정 화면과 같은 문구)
    Alert.alert(s.name, s.tossSynced ? "토스 계좌에서 가져온 종목입니다. 삭제하면 토스 동기화에서도 빠져 다시 나타나지 않습니다 (다시 등록하면 다시 맞춤)." : undefined, [
      { text: "보유 정보 수정", onPress: () => router.push(`/stocks/${s.code}/edit`) },
      { text: "삭제", style: "destructive", onPress: () => remove.mutate(s.code, { onError: (e) => Alert.alert("삭제 실패", e instanceof Error ? e.message : String(e)) }) },
      { text: "취소", style: "cancel" },
    ]);

  // ── 3-24 한 손 조작 (플래그 oneHand): 휴대폰·접은 화면은 줄 스와이프, 넓은 표는 길게 누르기 메뉴. 둘 다 같은 수정·지우기이고 지우기는 늘 확인 창 ──
  const ux = useUx();
  const swipeRows = ux.oneHand && !wide;
  const openEdit = (s: RegisteredWithQuote) => router.push(`/stocks/${s.code}/edit`);
  const askRemove = (s: RegisteredWithQuote) => {
    const c = removeConfirm(s);
    Alert.alert(c.title, c.message, [
      { text: "취소", style: "cancel" },
      {
        text: c.confirm,
        style: "destructive",
        onPress: () =>
          remove.mutate(s.code, {
            onSuccess: () => haptic("success"),
            onError: (e) => {
              haptic("error");
              Alert.alert(`${c.confirm} 실패`, e instanceof Error ? e.message : String(e));
            },
          }),
      },
    ]);
  };
  // 길게 누르기 메뉴: 수정 · 지우기(토스 종목은 동기화 제외, 관심은 관심 해제) · 취소. 지우기는 한 번 더 확인
  const rowMenu = (s: RegisteredWithQuote) => {
    haptic("press");
    Alert.alert(s.name, undefined, [
      { text: "수정", onPress: () => openEdit(s) },
      { text: removeLabel(s), style: "destructive", onPress: () => askRemove(s) },
      { text: "취소", style: "cancel" },
    ]);
  };

  // 줄 누름 처리는 렌더마다 새로 만들지 않는다 (체결이 온 줄만 다시 그리게, 3-17)
  const confirmRef = useRef(confirmRemove);
  const actionRef = useRef((s: RegisteredWithQuote, a: "edit" | "remove") => (a === "edit" ? openEdit(s) : askRemove(s)));
  useEffect(() => {
    confirmRef.current = ux.oneHand ? rowMenu : confirmRemove;
    actionRef.current = (s, a) => (a === "edit" ? openEdit(s) : askRemove(s));
  });
  // 스와이프로 열린 줄이 있으면 다른 줄을 누른 것은 그 줄을 닫기만 한다 (상세를 열지 않음 — 열린 줄을 누른 것과 같은 규칙, 3-24).
  // 열린 줄은 oneHand 가 켜진 휴대폰·접은 화면에만 생기므로 꺼져 있으면 지금 그대로
  const openStock = useCallback((s: RegisteredWithQuote) => {
    if (closeOpenRow()) return;
    router.push(`/stocks/${s.code}`);
  }, []);
  const longPress = useCallback((s: RegisteredWithQuote) => confirmRef.current(s), []);
  const rowAction = useCallback((s: RegisteredWithQuote, a: "edit" | "remove") => actionRef.current(s, a), []);
  // 휴대폰·접은 화면 줄 스와이프 틀: 줄(StockRow) 안에서 감싸 체결이 온 줄만 틀까지 다시 그린다 (늘 같은 함수 — 줄의 memo 비교를 깨지 않게).
  // 버튼: 수정(청록) · 지우기(경고색 — 토스 종목은 동기화 제외, 관심은 관심 해제)
  const swipeWrap = useCallback(
    (s: RegisteredWithQuote, row: React.ReactElement, onLayout?: (e: LayoutChangeEvent) => void) => {
      const actions: SwipeAction[] = [
        { key: "edit", label: "수정", icon: "create-outline", onPress: () => actionRef.current(s, "edit") },
        { key: "remove", label: removeLabel(s), icon: removeKind(s) === "sync" ? "remove-circle-outline" : removeKind(s) === "unwatch" ? "star-outline" : "trash-outline", danger: true, onPress: () => actionRef.current(s, "remove") },
      ];
      return (
        <SwipeRow actions={actions} onLayout={onLayout}>
          {row}
        </SwipeRow>
      );
    },
    [],
  );
  // 정렬 바꾸기 (3-24: 바꿀 때 짧은 진동 — 플래그·설정이 켜져 있을 때만. 열린 줄은 닫는다 — 줄 순서가 바뀌므로)
  const pickSort = (k: SortKey) => {
    closeOpenRow();
    haptic("select");
    void setSort(k);
  };
  // 목록을 끌기 시작하거나 당겨서 새로고침하면 열린 줄을 닫는다 (휴대폰·접은 화면 스와이프가 켜졌을 때만 — 꺼져 있으면 지금 그대로)
  const onPullRows = swipeRows
    ? () => {
        closeOpenRow();
        onPull();
      }
    : onPull;
  const marks = useGuideMarks();
  // 서버 연결 오류의 '설정 열기' (3-24, 플래그 emptyGuide — 플래그를 못 받은 채 서버에 닿지 않을 때도: lib/uxFlags connectionGuide)
  // 플래그가 꺼져 있으면 속성 자체를 넘기지 않는다 (지금 화면과 한 글자도 같게 — 스냅숏)
  const guideProps = useSettingsGuide();
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
  // 숫자 기준 점 (3-32): 끄면 속성 자체를 넘기지 않는다 (지금 화면과 같게). 점만(dotOnly)으로 그릴지는 패널·띠가 줄 수를 어림해 정한다 — '큰 글씨면 점만'
  const basisMark = (dotOnly: boolean) => <BasisMark stocks={data ?? []} account={account} {...(dotOnly ? { dotOnly: true } : {})} />;
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
  // 종목 상세에서 ‹ › 로 넘겨 본 뒤 돌아오면 마지막에 본 줄로 스크롤해 잠깐 강조 (3-42, ‹ › 를 안 썼으면 지금 그대로)
  // 목록 ref 는 이어 보기(anchor)와 같은 것을 쓴다 (ScrollView 에는 ref 를 하나만 달 수 있다).
  // 상세에 있는 동안 접거나 펴서 돌아오면 이어 보기의 되맞추기와 겹친다 → 강조 스크롤이 이긴다: 가장 최근에 본 종목이
  // 이어 보기가 기억한 맨 위 종목(상세로 가기 전)보다 새롭고, 설계가 '마지막에 본 줄로 스크롤'이다. 강조 스크롤 때 이어 보기의
  // 남은 되맞추기를 버리고(anchor.release — 끌기 시작과 같다), 그 스크롤이 간 자리부터 다시 기억한다
  const mark = useReturnMark((y) => {
    anchor.release();
    anchor.ref.current?.scrollTo({ y, animated: true });
  });

  const view = viewState(stocks);
  if (view === "loading")
    return wide ? (
      <Screen scroll={false} top={wideTop} contentStyle={sideInsets}>
        <HoldingsSkeleton />
      </Screen>
    ) : (
      <Screen scroll={false}>
        <MarketStrip {...(dense ? { dense: true } : null)} />
        <HoldingsSkeleton />
      </Screen>
    );
  if (view === "error")
    return wide ? (
      <Screen top={wideTop} contentStyle={sideInsets}>
        <ErrorView error={error} onRetry={() => void refetch()} {...guideProps} />
      </Screen>
    ) : (
      <Screen>
        <ErrorView error={error} onRetry={() => void refetch()} {...guideProps} />
      </Screen>
    );

  const sortLabel = SORT_OPTIONS.find((o) => o.value === sort)?.label ?? "정렬";

  // 넓은 한 줄 계좌 띠에 국내·해외 수익률까지 넣는 폭인지 (좁은 한 줄 띠는 숫자 기준 점만 — 글 없음)
  const rates = bandRates(tableW, fontScale);
  // 계정 A단계: 주인 아닌 계정은 맨 위에 '개인 종목 기능은 준비 중' 안내 (주인·플래그 꺼짐이면 없음)
  const wrapAccount = (content: React.ReactNode) => gated(tossSnapshotOn && !member, true) ? <TossAccountSummary focused={gated(informationFocus, true)} onAllocation={gated(allocationOn && summary.held > 0, openAllocation)}>{content}</TossAccountSummary> : content;
  const header = wide ? (
    <View>
      <MemberNotice />
      {wrapAccount(summary.held > 0 && heldPlan ? (
        <AccountBand
          data={account}
          oneLine={oneLineBand}
          rates={rates}
          pad={heldPlan.pad}
          onAllocation={gated(allocationOn, openAllocation)}
          {...(dense ? { dense: true } : null)}
          {...(basisOn ? { basis: basisMark, width: tableW } : null)}
        />
      ) : null)}
    </View>
  ) : (
    <View>
      <MarketStrip {...(dense ? { dense: true } : null)} />
      <MemberNotice />
      {wrapAccount(summary.held > 0 ? (
        <AccountPanel
          data={account}
          onAllocation={gated(allocationOn, openAllocation)}
          status={status}
          {...(dense ? { dense: true } : null)}
          // 휴대폰 목록은 창 폭을 다 쓴다 (좌우 여백은 패널 안에서)
          {...(basisOn ? { basis: basisMark, width: winW, fontScale } : null)}
        />
      ) : null)}
    </View>
  );

  const sectionHeader = (section: (typeof sections)[number]) => (
    <View style={{ backgroundColor: t.bg }}>
      {dense ? (
        // 촘촘 머리 줄 (3-39): 높이 44 를 정렬·비중 버튼이 채우고 위아래 hitSlop 은 0 — 누르는 곳이 머리 밖으로 나가지 않는다 (BAR_SLOP).
        // 비중 버튼은 보유 구역에만 (계좌 요약에서 옮김 — 머리가 위에 붙어 보유 줄을 보는 동안 늘 보인다)
        <View style={[styles.sectionBarDense, { backgroundColor: t.bg }]}>
          <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }} accessibilityRole="header">
            {section.title}
          </Text>
          <View style={styles.barEnd}>
            {section.key === "held" && allocationOn ? (
              <Pressable onPress={openAllocation} hitSlop={BAR_SLOP} accessibilityRole="button" accessibilityLabel="비중 보기" style={styles.barBtn}>
                <Ionicons name="pie-chart-outline" size={font.small} color={t.muted} />
                <Text style={{ color: t.muted, fontSize: font.small }}>비중</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSortOpen(true)} hitSlop={BAR_SLOP} accessibilityRole="button" accessibilityLabel={`정렬 바꾸기, 지금 ${sortLabel}`} style={styles.barBtn}>
              <Text style={{ color: t.muted, fontSize: font.small }}>{sortLabel}</Text>
              <Ionicons name="chevron-down" size={font.small} color={t.muted} />
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={[styles.sectionBar, { backgroundColor: t.bg }]}>
          <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }} accessibilityRole="header">
            {section.title}
          </Text>
          <Pressable onPress={() => setSortOpen(true)} hitSlop={SORT_SLOP} accessibilityRole="button" accessibilityLabel={`정렬 바꾸기, 지금 ${sortLabel}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xxs, paddingVertical: space.xs }}>
            <Text style={{ color: t.muted, fontSize: font.small }}>{sortLabel}</Text>
            <Ionicons name="chevron-down" size={font.small} color={t.muted} />
          </Pressable>
        </View>
      )}
      <TableHead>
        <HeadCell label="종목명" a11y="이름순 정렬" active={sort === "name"} onPress={() => pickSort("name")} flex />
        <HeadCell label={PRICE_HEAD} a11y="등락률순 정렬" active={sort === "changeRate"} onPress={() => pickSort("changeRate")} width={col.price} />
        {section.key === "held" ? (
          <HeadCell label="평가손익·수익률" a11y="평가손익순 정렬" active={sort === "profit"} onPress={() => pickSort("profit")} width={col.right} />
        ) : (
          <HeadCell label="전일대비·거래량" width={col.right} />
        )}
      </TableHead>
    </View>
  );
  // 넓은 창 표 머리: 열 이름을 누르면 정렬 (설정의 정렬 값 그대로), 이름 칸의 "등록순 ▾" 는 정렬 창
  const tableHeader = (section: (typeof sections)[number]) => (
    <TableHeadRow plan={(section.key === "held" ? heldPlan : watchPlan)!} title={section.title} sort={sort} sortLabel={sortLabel} onSort={pickSort} onOpenSort={() => setSortOpen(true)} />
  );
  // 계정 A단계: 주인 아닌 계정은 종목을 아직 추가할 수 없으므로(서버가 막는다) '종목 검색' 대신 차분한 안내 + [시장·종목 둘러보기] (발견 탭 — 검증 4차)
  const empty = member ? (
    <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">
        {MEMBER_EMPTY_HOLDINGS.title}
      </Text>
      <Text style={{ color: t.muted, fontSize: font.small }}>{MEMBER_EMPTY_HOLDINGS.hint}</Text>
      <View style={{ flexDirection: "row", marginTop: space.sm, width: "100%", maxWidth: layout.readableMax, alignSelf: "center" }}>
        <Button title={MEMBER_EMPTY_HOLDINGS.action} icon="compass-outline" variant="secondary" onPress={() => router.navigate("/discover")} style={{ flex: 1 }} />
      </View>
    </View>
  ) : ux.emptyGuide ? (
    // 3-24 빈 화면 (플래그 emptyGuide): 무엇을 하면 되는지 한 문단 + 행동 버튼 하나 (토스 계좌는 설정의 칸 이름으로 알려 준다)
    <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">
        등록된 종목이 없습니다
      </Text>
      <Text style={{ color: t.muted, fontSize: font.small }}>
        {health.data?.tossOpenApi?.configured
          ? "토스증권 계좌의 보유 종목을 바로 불러올 수 있습니다. 다른 종목은 위의 검색(돋보기)으로 추가하세요."
          : "종목명이나 티커로 검색해 보유·관심 종목을 추가하세요."}
      </Text>
      {/* 넓은 창(933dp 등)에서 버튼이 창 폭 전체(약 875dp)로 늘지 않게 읽기 폭(720)까지, 카드 가운데에 — 첫 실행 안내와 같다
          (왼쪽에 붙이면 카드 오른쪽 약 180dp 가 비어 기울어 보였다 — 3-24 리뷰 수정 3). 휴대폰·접은 화면은 카드가 더 좁아 그대로 */}
      <View style={{ flexDirection: "row", marginTop: space.sm, width: "100%", maxWidth: layout.readableMax, alignSelf: "center" }}>
        {/* 버튼은 하나: 토스가 연결된 서버면 계좌 불러오기(가장 필요한 일), 아니면 종목 검색 */}
        {health.data?.tossOpenApi?.configured ? <TossImportButton /> : <Button title="종목 검색" icon="search" onPress={() => router.push("/stocks/add")} style={{ flex: 1 }} />}
      </View>
    </View>
  ) : (
    <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>등록된 종목이 없습니다</Text>
      <Text style={{ color: t.muted, fontSize: font.small }}>종목명·티커로 검색해 추가하거나 토스증권 계좌에서 불러옵니다.</Text>
      <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.sm }}>
        <Button title="종목 검색" icon="search" onPress={() => router.push("/stocks/add")} style={{ flex: 1 }} />
        {health.data?.tossOpenApi?.configured ? <Button title="계좌 불러오기" variant="secondary" onPress={() => router.push("/settings")} style={{ flex: 1 }} /> : null}
      </View>
    </View>
  );
  // 3-24 관심 빈 상태 (플래그 emptyGuide): 보유 종목만 있고 관심 종목이 없을 때 목록 끝에 한 칸. 늘 붙는 칸이 되지 않게 닫을 수 있고,
  // 한 번 닫으면 이 기기에서 다시 보이지 않는다 (GuideMarks)
  const watchEmpty =
    ux.emptyGuide && !marks.watchHintClosed && summary.held > 0 && sections.every((x) => x.key !== "watch") ? (
      <View style={[styles.empty, { borderColor: t.line, backgroundColor: t.surface }]}>
        <View style={styles.hintHead}>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flex: 1 }} accessibilityRole="header">
            관심 종목이 없습니다
          </Text>
          <Pressable onPress={marks.closeWatchHint} accessibilityRole="button" accessibilityLabel="관심 종목 안내 닫기" hitSlop={CLOSE_SLOP} style={styles.hintClose}>
            <Ionicons name="close" size={font.h2} color={t.muted} />
          </Pressable>
        </View>
        <Text style={{ color: t.muted, fontSize: font.small }}>사지 않고 지켜볼 종목은 검색한 뒤 종목 화면의 &apos;관심 추가&apos;로 여기에 모읍니다.</Text>
        <View style={{ flexDirection: "row", marginTop: space.sm }}>
          <Button title="관심 종목 찾기" icon="search" variant="secondary" onPress={() => router.push("/stocks/add")} style={{ flex: 1 }} />
        </View>
      </View>
    ) : null;
  // 머리(0) 다음부터 구역마다 [머리글, 줄들...] → 머리글 자리만 고정
  const stickyIndices: number[] = [];
  let childIndex = 1;
  for (const sec of sections) {
    stickyIndices.push(childIndex);
    childIndex += 1 + sec.data.length;
  }
  // 이어 보기·돌아온 줄 강조(플래그가 켜져 있을 때만): 스크롤 위치·목록 칸 높이·구역 머리·줄 위치를 잰다. 넓은 창이면 표 폭도 잰다.
  // 꺼져 있으면 아무것도 붙이지 않는다 (지금과 똑같다 — 종목 상세 ‹ › 도 플래그가 켜진 넓은 창에만 있어 강조할 줄이 생기지 않는다)
  const tracking = fold.on
    ? {
        ref: anchor.ref,
        onScroll: anchor.onScroll,
        onScrollBeginDrag: anchor.onScrollBeginDrag,
        scrollEventThrottle: SCROLL_THROTTLE,
        onLayout: (e: LayoutChangeEvent) => {
          mark.onViewLayout(e);
          if (wide) onTableLayout(e);
        },
      }
    : null;
  const plans = wide && weights ? { held: heldPlan, watch: watchPlan } : null;

  return (
    <Screen
      scroll={false}
      top={
        wide ? (
          <>
            {wideTop}
            <StaleBanner query={stocks} open={open} maxAgeMs={openMaxAge} {...guideProps} />
          </>
        ) : (
          <StaleBanner query={stocks} open={open} maxAgeMs={openMaxAge} {...guideProps} />
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
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={onPullRows} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} />}
        contentContainerStyle={{ paddingBottom: space.xl }}
        {...tracking}
        {...(swipeRows
          ? {
              onScrollBeginDrag: () => {
                closeOpenRow();
                tracking?.onScrollBeginDrag();
              },
            }
          : null)}
      >
        {header}
        {sections.length === 0
          ? empty
          : sections.flatMap((section) => [
              <View key={`h-${section.key}`} {...(fold.on ? { onLayout: (e: LayoutChangeEvent) => anchor.head(section.key, e) } : null)}>
                {plans ? tableHeader(section) : sectionHeader(section)}
              </View>,
              // 줄은 목록에 바로 놓는다. 종목 상세에서 ‹ › 로 넘겨 본 뒤 돌아오면 마지막에 본 줄만 강조 틀(mark.wrap)로 감싼다 —
              // 감싼 줄은 틀 안에서 y=0 이므로 이어 보기 줄 위치는 줄 대신 틀이 알린다 (휴대폰 목록·넓은 표 모두)
              ...section.data.map((item, i) => {
                const marked = mark.code === item.code;
                const row = (
                  <StockRow
                    key={item.code}
                    stock={item}
                    showKrw={showKrw}
                    afterCost={afterCost}
                    live={quoteLive(item.quote, now, feedOk)}
                    onPress={openStock}
                    onLongPress={longPress}
                    {...(fold.on && !marked ? { onLayoutRow: rowLayout } : null)}
                    {...(ux.oneHand ? { onRowAction: rowAction } : null)}
                    // 3-24 휴대폰·접은 화면: 줄을 왼쪽으로 밀면 수정 · 지우기 버튼 (넓은 표는 길게 누르기 메뉴)
                    {...(swipeRows ? { wrapRow: swipeWrap } : null)}
                    // 3-39 촘촘 휴대폰 줄 (넓은 표에는 넘기지 않는다 — 표 줄은 이미 44)
                    {...(dense && !plans ? { dense: true } : null)}
                    {...(plans
                      ? section.key === "held"
                        ? { columns: plans.held, zebra: i % 2 === 1, weight: weights!.byCode.get(item.code) ?? null, weightMax: weights!.max }
                        : // 관심 줄은 비중을 쓰지 않는다: 최대 비중이 바뀔 때마다 관심 줄까지 다시 그리지 않게
                          { columns: plans.watch, zebra: i % 2 === 1 }
                      : null)}
                  />
                );
                return mark.wrap(item.code, row, fold.on ? (e) => rowLayout(item, e.nativeEvent.layout.y, e.nativeEvent.layout.height) : undefined);
              }),
            ])}
        {watchEmpty}
      </ScrollView>
      <SortSheet visible={sortOpen} value={sort} onClose={() => setSortOpen(false)} onPick={pickSort} />
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
/**
 * 촘촘 구역 머리(3-39)의 정렬·비중 버튼: 버튼이 머리 높이 44 를 채우므로 위아래로 넓히지 않는다 — 머리 밖으로 나가면
 * 위에 붙은 머리(스크롤 영역 맨 위)에서는 잘려 눌리지 않고, 관심 머리에서는 바로 위 보유 줄 아래쪽을 가려 종목 대신 정렬이 바뀐다.
 * 좌우는 정렬 버튼과 같게(두 버튼 사이 20 안에서 8 + 8 이라 겹치지 않음)
 */
const BAR_SLOP = { top: 0, bottom: 0, left: space.sm, right: space.sm };

/**
 * 계좌 평가 패널 (휴대폰 화면): 총 평가금액(원화 환산) + 평가손익·수익률·매입·당일 + 국내/해외 구분.
 * 촘촘(3-39, dense): 세 줄 — 윗줄('총 평가금액' + 상태) · 총액 · '평가손익 … · 당일 …'. 매입금액·국내/해외·환율 안내(추정·현재 환율 환산일 때만 남김)·비중 버튼(구역 머리로)은 그리지 않고,
 * 화면 읽기 문장은 기본과 같다 (숨긴 숫자도 문장에는 남음)
 */
function AccountPanel({
  data,
  status,
  onAllocation,
  dense = false,
  basis,
  width,
  fontScale,
}: {
  data: AccountData;
  status: React.ReactNode;
  /** 비중 보기 화면 열기 (플래그 allocationView 가 꺼져 있으면 없음 → 버튼도 없음) */
  onAllocation?: () => void;
  /** 촘촘 세 줄 (3-39) — 비중 버튼은 받아도 그리지 않는다 (구역 머리에 있음) */
  dense?: boolean;
  /**
   * 숫자 기준 점 그리기 (3-32, 플래그 numberBasis — dotOnly: 글 없이 점만). 있으면 총액 줄 오른쪽 끝(촘촘이면 요약 묶음 오른쪽)에 두고 — 새 줄 없음,
   * 요약 문장 묶음 밖이라 화면 읽기로 따로 고를 수 있다. 없으면 지금 나무 그대로.
   * 점 + 글이 줄을 늘리면 점만, 촘촘에서 '평가손익 · 당일' 줄이 점 옆에서 한 줄로 안 들어가면 점을 총액 줄 옆으로 (lib/basisFit panelBasisFit — '큰 글씨면 점만')
   */
  basis?: (dotOnly: boolean) => React.ReactNode;
  /** 패널 폭(창 폭)·시스템 글자 배율 — 점 배치 어림에만 쓴다 */
  width?: number;
  fontScale?: number;
}) {
  const t = useTheme();
  const { total, afterCost, fx, excluded } = data;
  // 합계는 원화로(환율을 모르면 원화 종목만). 해외 행은 설정에 따라 달러 또는 원화
  const { main, profit, rate, lines, showSplit } = accountFigures(data);
  const pc = changeColor(t, profit);
  const dc = changeColor(t, main.day);
  const totalValue = formatQuote(main.value, "KRW");
  const profitText = formatPrice(profit, "KRW", { sign: true });
  const rateText = formatPct(rate);
  const dayValue = formatPrice(main.day, "KRW", { sign: true });
  // 숫자 기준 점의 자리·모양 (촘촘은 '평가손익 · 당일' 줄 글로 줄 수를 어림한다 — 화면 글과 같은 글)
  const fit = basis ? panelBasisFit({ width: width ?? 0, fontScale: fontScale ?? 1, total: totalValue, line: dense ? `평가손익 ${profitText} ${rateText} · 당일 ${dayValue}` : null }) : null;
  // 화면 읽기: 계좌 요약을 한 문장으로 (3-22, 넓은 창 계좌 띠와 같은 문장). 상태 줄(실시간·지연)은 따로 읽는다
  const label = accountSpeech(data);
  const top = (
    <View style={styles.panelTop}>
      <Text style={{ color: t.muted, fontSize: font.small, flexShrink: 0 }}>
        총 평가금액{total ? "" : " (원화 종목)"}
        {afterCost ? " · 비용 차감" : ""}
      </Text>
      {status}
    </View>
  );
  // 합계에서 뺀 보유 종목(시세·평단·환율 없음)을 알린다 — 말없이 빠져 총액이 작아 보이지 않게 (BH-04 · BH-26 · BH-30). 촘촘에서도 그대로
  const excludedLine = excluded ? <Text style={{ color: t.warn, fontSize: font.tiny }}>{excluded}</Text> : null;
  if (dense) {
    const denseTotal = (
      <Text style={[styles.totalDense, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {totalValue}
        <Text style={{ fontSize: font.small, color: t.muted, fontWeight: "500" }}> 원</Text>
      </Text>
    );
    // 말줄임 없이: 글자가 크거나 금액이 길면 숫자를 자르지 않고 다음 줄로 (숫자 기준 점을 켜도 이 줄은 줄이거나 한 줄로 묶지 않는다)
    const denseLine = (
      <Text style={[styles.denseLine, { color: t.muted }]}>
        평가손익 <Text style={{ color: pc, fontWeight: "700" }}>{profitText}</Text>
        <Text style={{ color: pc }}> {rateText}</Text> · 당일 <Text style={{ color: dc, fontWeight: "700" }}>{dayValue}</Text>
      </Text>
    );
    const denseSummary = (style: { flex?: number; gap: number }) => (
      <View accessible accessibilityLabel={label} style={style}>
        {denseTotal}
        {denseLine}
      </View>
    );
    return (
      <View style={[styles.panel, styles.panelDense, { backgroundColor: t.surface, borderColor: t.line }]}>
        {top}
        {/* 숫자 기준 점(3-32)은 요약 묶음 오른쪽 — 새 줄·숨기는 칸 없음. 윗줄 상태 점 옆에는 두지 않는다 (점 두 개가 붙어 헷갈림).
            '평가손익 · 당일' 줄이 점 옆에서 한 줄로 안 들어가면 점을 총액 줄 옆에 두고 그 줄은 아래에 꺼졌을 때와 같은 폭·같은 글자로 (요약 문장은 총액 칸이 읽고 줄은 숨김).
            총액 줄 옆 점은 누르는 칸 44 가 총액 글보다 높아도 줄이 두꺼워지지 않게 위아래를 거둔다(tuck) — 거둔 자리는 윗줄 아래쪽·아래 줄 위쪽과 겹치므로,
            점 줄은 점만 누르게(box-none) 하고 아래 줄은 누름을 받지 않게(none) 한다 (둘 다 누를 것이 없는 글) */}
        {basis && fit ? (
          fit.spot === "group" ? (
            <View style={[styles.totalRow, fit.dotOnly && styles.totalRowDot]}>
              {denseSummary({ flex: 1, gap: space.xxs })}
              {basis(fit.dotOnly)}
            </View>
          ) : (
            <>
              <View style={[styles.totalRow, styles.totalRowDot, styles.passThrough, fit.tuck > 0 && { marginVertical: -fit.tuck }]}>
                <View accessible accessibilityLabel={label} style={{ flex: 1 }}>
                  {denseTotal}
                </View>
                {basis(true)}
              </View>
              <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.noTouch}>
                {denseLine}
              </View>
            </>
          )
        ) : (
          denseSummary({ gap: space.xxs })
        )}
        {excludedLine}
        {/* 환율 안내는 숨기되, 원화 손익이 추정이거나 현재 환율 환산일 때만 한 줄 남긴다 (넓은 창 계좌 띠와 같은 규칙) */}
        {fx && (data.estimated || data.currentBasis) ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{fxNote(data)}</Text> : null}
      </View>
    );
  }
  const totalText = (
    <Text style={[styles.total, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
      {totalValue}
      <Text style={{ fontSize: font.body, color: t.muted, fontWeight: "500" }}> 원</Text>
    </Text>
  );
  const kpiCells = [
    <Kpi key="profit" label="평가손익" value={profitText} color={pc} />,
    <Kpi key="rate" label="수익률" value={rateText} color={pc} />,
    <Kpi key="cost" label="매입금액" value={formatPrice(main.cost, "KRW")} />,
    <Kpi key="day" label="당일손익" value={dayValue} color={dc} />,
  ];
  return (
    <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
      {top}
      {basis && fit ? (
        <>
          {/* 숫자 기준 점(3-32): 총액 줄 오른쪽 끝, 요약 문장 밖 (화면 읽기로 따로 고른다 — '비중' 버튼과 같은 까닭). 새 줄 없음.
              총액이 0.6 까지 줄어도 점 + 글 옆에 안 들어가면(좁은 폭 × 큰 글씨) 점만 */}
          <View style={[styles.totalRow, fit.dotOnly && styles.totalRowDot]}>
            <View accessible accessibilityLabel={label} style={{ flex: 1 }}>
              {totalText}
            </View>
            {basis(fit.dotOnly)}
          </View>
          {/* 숫자 네 칸은 위 요약 문장에 들어 있다 → 조각으로 한 번 더 읽히지 않게 숨긴다 (국내·해외 줄과 같은 방식) */}
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.kpis}>
            {kpiCells}
          </View>
        </>
      ) : (
        <View accessible accessibilityLabel={label} style={{ gap: space.xs }}>
          {totalText}
          <View style={styles.kpis}>{kpiCells}</View>
        </View>
      )}
      {excludedLine}
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

/** 관심 안내 칸 닫기(✕ 아이콘 font.h2)의 누르는 영역: 위아래·좌우 모두 44 (3-24 리뷰 수정 — 예전에는 좌우가 아이콘 + 4 로 폭 24) */
const CLOSE_SLOP = slopFor(font.h2, Math.ceil((touch.min - font.h2) / 2));

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
  // ── 촘촘(3-39) ── 계좌 세 줄 · 구역 머리 44 (위아래 여백 없음 — 버튼 둘이 머리 높이를 다 채워 누르는 곳이 머리 안)
  panelDense: { paddingTop: space.s, paddingBottom: space.s, gap: space.xxs },
  totalDense: { fontSize: font.h2, fontWeight: "800", fontVariant: ["tabular-nums"] },
  denseLine: { fontSize: font.small, fontVariant: ["tabular-nums"] },
  sectionBarDense: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: touch.min, paddingHorizontal: space.lg },
  barEnd: { flexDirection: "row", alignItems: "stretch", gap: space.xl },
  barBtn: { flexDirection: "row", alignItems: "center", gap: space.xxs, minHeight: touch.min },
  empty: { margin: space.lg, padding: space.lg, gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  // 3-24 관심 안내 칸 제목 줄 + 닫기(오른쪽, 누르는 영역 44×44 — CLOSE_SLOP)
  hintHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  hintClose: { alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xl },
  sheetItem: { minHeight: touch.min, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.lg, borderTopWidth: StyleSheet.hairlineWidth },
  // ── 넓은 창 맨 위 띠 오른쪽 끝 ──
  stripEnd: { flexDirection: "row", alignItems: "stretch", borderLeftWidth: StyleSheet.hairlineWidth },
  // 시장 상태: 세션 / 실시간·시각 두 줄, 칸 폭은 글자에 맞춘다 (최대 폭은 StripEnd 가 글자 배율로)
  stripStatus: { flexShrink: 0, justifyContent: "center", alignItems: "flex-end", paddingHorizontal: space.sm },
  searchBtn: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  // 숫자 기준 점(3-32)이 있을 때 총액 줄: 총액(남은 폭, 글자를 줄여 맞춤) | 점 + 짧은 글 (누르는 칸 44)
  totalRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  // 점만일 때는 띄우지 않는다: 점이 누르는 칸(44) 가운데라 이미 옆 글과 떨어져 보이고, 그만큼 옆 글이 넓게 쓴다
  totalRowDot: { gap: 0 },
  // 숫자 기준 점을 총액 줄 옆에 거둬 둘 때: 점 줄 자체는 누름을 받지 않고(안의 점만), 겹친 아래 줄은 누름을 통과시킨다
  passThrough: { pointerEvents: "box-none" },
  noTouch: { pointerEvents: "none" },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
