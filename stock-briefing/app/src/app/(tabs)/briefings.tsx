import { router, Tabs } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccountBriefings, useBriefing, useFeature, useHealth, useLatestBriefings, useMarketStatus, useRegisteredStocks, useStockMutations } from "@/api/hooks";
import type { AccountBriefing, BriefingSession, LatestBriefing } from "@/api/types";
import { AccountBriefingBody } from "@/components/AccountBriefingBody";
import { AccountBriefingCard, AccountBriefingRow } from "@/components/AccountBriefingCard";
import { BriefingBody } from "@/components/BriefingBody";
import { BriefingCard } from "@/components/BriefingCard";
import { BriefingRow, BriefingTile, ListNotice, MoreButton, Pills } from "@/components/BriefingList";
import { StaleBanner, usePull } from "@/components/Freshness";
import { CardsSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { TwoPane } from "@/components/TwoPane";
import { Button, Card, ChangeText, Empty, ErrorView, Muted, SectionTitle, Segmented } from "@/components/ui";
import { orderForTab, runConfirm } from "@/lib/briefingRun";
import { accountCardItem } from "@/lib/accountBriefing";
import { firstPick, gridColumns, isUnread, latestSession, noteListSession, noteTabHeadHidden, pickAuto, pickBriefing, pickByUser, selectedRowId, tabHeadOptions, usePick, type BriefingPick, type PickState } from "@/lib/briefingPick";
import { markBriefingRead, useReadBriefings } from "@/lib/briefingRead";
import { formatDateKo, formatPct } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";
import { font, fontCap, slopFor, space, useTheme } from "@/theme";
import { foldBriefings as FB } from "@/tokens";
import { sentence, speakRate } from "@/lib/a11y";

type Mode = "line" | "summary" | "detail";
type Order = "movers" | "registered";

/**
 * 브리핑 탭: (3-31) 내 계좌 브리핑 → 서버 상태 배너 → (3-19) 변동 큰 3종목 → 종목별 최신 브리핑(한 줄/요약/상세) → 수동 실행.
 * briefingTabMovers 플래그가 켜져 있으면 기본 정렬은 '변동 큰 순'(오늘 등락률 절댓값), 아니면 등록순(예전)
 *
 * 넓은 창 (3-42 웨이브 D, 플래그 foldLayout — 꺼져 있거나 좁은 창·접은 화면은 위 그대로):
 *  - 2단을 쓸 수 있는 창(펼친 폴드8 가로·울트라 펼침): 왼쪽 목록(계좌 줄 60 + 브리핑 줄 56) | 오른쪽 고른 브리핑 본문.
 *    처음에는 첫 미확인(없으면 맨 위)이 골라져 있고, 고른 것은 뒤로 가기 기록에 쌓지 않는다 (lib/briefingPick)
 *  - 그 밖의 넓은 창(펼친 폴드8 세로): 도구 한 줄 + 계좌 줄 + 카드 격자. 카드를 누르면 전체 화면 브리핑
 *  - '변동 큰 종목' 카드 대신 목록 1~3위에 순위 표시. 탭 머리는 숨기고(제목은 목록 머리에) 그 자리의 위 화면 여백(상태 표시줄)은 WideFrame 이 둔다
 *  - 저절로 골라진 첫 미확인은 읽음으로 적지 않고, 사용자가 누른 브리핑만 적는다. 저절로 골라진 것을 보다가 다른 브리핑을 고르면 그때 읽음
 *  - 목록 머리·도구 줄 끝의 '⋯' = 수동 생성 (목록 맨 아래 카드와 같은 동작)
 *  - 오른쪽 본문은 체결(약 0.1초마다 등락률이 바뀜)에 다시 그리지 않는다 (DetailPane — React.memo)
 */
export default function BriefingsScreen() {
  const t = useTheme();
  const [mode, setMode] = useState<Mode>("summary");
  const latest = useLatestBriefings();
  const { data, error, refetch } = latest;
  const stocks = useRegisteredStocks();
  const { run } = useStockMutations();
  const health = useHealth();
  const market = useMarketStatus();
  const moversOn = useFeature("briefingTabMovers", false);
  const confirmOn = useFeature("briefingManualRun", false);
  // 3-31 계좌 한 장 브리핑: 서버가 켤 때만 부르고 보인다. 예전 서버(404)·없음이면 카드가 없다
  const accountOn = useFeature("accountBriefing", false);
  const accounts = useAccountBriefings(accountOn);
  const account = accountCardItem(accountOn, accounts.data);
  // 당겨서 새로고침: 브리핑과 등락률(계좌 브리핑이 켜져 있으면 그것도)을 함께
  const { pulling, onPull } = usePull(() => Promise.all([refetch(), stocks.refetch(), ...(accountOn ? [accounts.refetch()] : [])]));
  const [order, setOrder] = useState<Order>("movers");
  const rates = useMemo(() => new Map((stocks.data ?? []).map((s) => [s.code, s.quote?.changeRate ?? null] as const)), [stocks.data]);
  // 3-42 넓은 창: 플래그가 꺼져 있으면 on=false → 아래는 모두 지금 그대로
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  const picked = usePick();
  // 탭 머리: 넓은 창에서는 숨기고(제목은 목록 머리에) 접으면 다시 보인다. 처음부터 플래그가 꺼져 있으면 건드리지 않고,
  // 한 번 숨긴 뒤 플래그가 꺼지면(서버 긴급 끄기) 다시 보이게 걸어 둔다 (lib/briefingPick tabHeadOptions)
  useEffect(() => {
    if (wide) noteTabHeadHidden();
  }, [wide]);
  const headOptions = tabHeadOptions(fold.on, wide);
  const head = headOptions ? <Tabs.Screen options={headOptions} /> : null;
  // 접은 화면 '이어 보기' 스크롤 (넓은 창에서 보던 브리핑 줄로 한 번). 다시 펴면 다음에 접을 때 또 맞춘다
  const scrollRef = useRef<ScrollView | null>(null);
  const scrolledTo = useRef<number | null>(null);
  useEffect(() => {
    if (wide) scrolledTo.current = null;
  }, [wide]);

  // 17종목 × 약 25초: 누르기 전에 한 번 묻는다 (3-19, 플래그를 끄면 예전처럼 바로)
  const confirmRun = (session: BriefingSession) => {
    if (!confirmOn) return runNow(session);
    const c = runConfirm(session, (data ?? []).length);
    Alert.alert(c.title, c.message, [
      { text: "취소", style: "cancel" },
      { text: "만들기", onPress: () => runNow(session) },
    ]);
  };

  // 넓은 창 목록 머리·도구 줄의 '⋯': 오전·오후를 고르면 목록 아래 '수동 생성' 카드의 버튼과 같은 길 (확인 창 포함)
  const openMore = () =>
    Alert.alert(
      "수동 생성",
      "등록한 모든 종목의 브리핑을 새로 만듭니다.",
      [
        { text: "취소", style: "cancel" },
        { text: "오전 브리핑", onPress: () => confirmRun("morning") },
        { text: "오후 브리핑", onPress: () => confirmRun("afternoon") },
      ],
      { cancelable: true },
    );

  const runNow = (session: BriefingSession) => {
    run.mutate(
      { session, force: true },
      {
        onSuccess: (r) => {
          const failed = r.results.filter((x) => x.status === "failed");
          const skipped = r.results.filter((x) => x.status === "skipped");
          const parts = [`${r.results.length}개 중 ${r.results.length - failed.length - skipped.length}개 생성`];
          if (skipped.length) parts.push(`${skipped.length}개 휴장일로 건너뜀`);
          if (failed.length) parts.push(`${failed.length}개 실패\n${failed.map((f) => `${f.name}: ${f.error}`).join("\n")}`);
          Alert.alert("브리핑 생성 완료", parts.join(", "));
        },
        onError: (e) => Alert.alert("실행 실패", e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const view = viewState(latest);
  // 넓은 창은 탭 머리를 숨기므로 불러오는 중·오류 화면도 위 화면 여백(상태 표시줄) 아래에서 시작한다
  const frame = (el: React.ReactElement) => (wide ? <WideFrame rail={fold.rail}>{el}</WideFrame> : el);
  if (view === "loading") return frame(<Screen>{head}<CardsSkeleton count={4} /></Screen>);
  if (view === "error") return frame(<Screen>{head}<ErrorView error={error} onRetry={() => void refetch()} /></Screen>);

  const items = data ?? [];
  // 등락률을 받기 전엔 정렬을 미룬다(두 번 재정렬되지 않게). 못 받으면 등록순 + 안내
  const ratesReady = stocks.isSuccess;
  const movers = moversOn && order === "movers" && ratesReady;
  const { list: ordered, top } = orderForTab(items.filter((i) => i.latest), rates, movers);
  const withBriefing = ordered;
  const last = health.data?.lastBriefing ?? null;
  const llmOff = health.data?.llmConfigured === false;
  const krHoliday = market.data && !market.data.KR.isTradingDay;

  const banner =
    llmOff || (last && last.failed > 0) ? (
      <Card style={{ borderLeftWidth: 3, borderLeftColor: t.danger }}>
        <Text style={{ color: t.danger, fontSize: font.body, fontWeight: "700" }}>{llmOff ? "브리핑 모델이 설정되지 않았습니다" : `최근 실행에서 ${last!.failed}개 종목이 실패했습니다`}</Text>
        <Muted>{llmOff ? "브리핑을 만드는 모델 키가 서버에 설정되지 않아 새 브리핑을 만들 수 없습니다. 관리자에게 알려 주세요." : last!.lastError ?? ""}</Muted>
        {last ? <Muted>{formatDateKo(last.finishedAt, true)} · {last.session === "morning" ? "오전" : "오후"} · 성공 {last.ok} / 실패 {last.failed} / 건너뜀 {last.skipped}</Muted> : null}
      </Card>
    ) : null;
  const ratesFailText = moversOn && order === "movers" && stocks.isError ? "등락률을 불러오지 못해 등록순으로 보여 줍니다 · 당겨서 다시 시도" : null;
  const manual =
    items.length > 0 ? (
      <Card>
        <SectionTitle>수동 생성</SectionTitle>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button title="오전 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "morning"} disabled={run.isPending} onPress={() => confirmRun("morning")} />
          <Button title="오후 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "afternoon"} disabled={run.isPending} onPress={() => confirmRun("afternoon")} />
        </View>
      </Card>
    ) : null;
  const missingNote =
    items.some((i) => !i.latest) && withBriefing.length > 0 ? (
      <Muted style={{ paddingHorizontal: space.lg }}>브리핑 없음: {items.filter((i) => !i.latest).map((i) => i.name).join(", ")}</Muted>
    ) : null;

  if (wide) {
    // 넓은 창 목록 위 안내는 짧게 (목업): 휴장이어도 국내 종목의 지난 브리핑·등락률은 목록에 있으므로 '브리핑 없음' 대신 등락 기준을 밝힌다
    const wideHoliday = krHoliday ? `한국 휴장일 · 국내 종목은 직전 거래일 등락${market.data?.KR.opensAt ? ` · 다음 개장 ${formatDateKo(market.data.KR.opensAt)}` : ""}` : null;
    return (
      <WideBriefings
        head={head}
        twoPane={fold.twoPane}
        rail={fold.rail}
        list={withBriefing}
        rates={rates}
        ratesKnown={ratesReady}
        // 목록 순서가 정해졌는지: 변동 큰 순이면 등락률을 받았거나(성공) 못 받아 등록순으로 정해졌을 때 (처음 고를 브리핑은 그 뒤에 정한다)
        orderSettled={!(moversOn && order === "movers") || stocks.isSuccess || stocks.isError}
        top={top}
        movers={movers}
        sort={moversOn ? { value: order, onChange: setOrder } : null}
        mode={mode}
        onMode={setMode}
        account={account}
        // 계좌 브리핑 목록을 알고 있는지 (받는 중에는 고른 계좌 브리핑을 '없어졌다'고 보지 않는다)
        accountSettled={!accountOn || accounts.data !== undefined || accounts.isError}
        holiday={wideHoliday}
        criterion={movers ? "변동 큰 순 = 전일 대비 등락률 크기 순 · 매매 권유가 아닙니다" : null}
        ratesFail={ratesFailText}
        banner={banner}
        manual={manual}
        more={items.length > 0 ? { onPress: openMore, busy: run.isPending } : null}
        missingNote={missingNote}
        empty={items.length === 0 ? "none" : withBriefing.length === 0 ? "noBriefing" : null}
        stale={<StaleBanner query={latest} />}
        pulling={pulling}
        onPull={onPull}
        picked={picked}
      />
    );
  }

  // 접은 화면(휴대폰)·플래그 꺼짐: 지금 그대로. 넓은 창에서 보던 브리핑이 있으면 그 카드만 강조하고 처음 한 번 그 위치로 스크롤한다 (자동으로 열지 않음).
  // 보던 것이 목록에 없는 지난 브리핑이면 같은 종목 카드를. 강조할 것이 없거나 플래그가 꺼져 있으면 카드를 감싸지 않고 스크롤도 건드리지 않아 지금과 똑같다
  const hl = fold.on && picked.highlight ? picked.pick : null;
  const hlId = selectedRowId(hl, withBriefing.map((i) => i.latest!));
  const onHighlightLayout = (e: LayoutChangeEvent) => {
    if (hlId === null || scrolledTo.current === hlId) return;
    scrolledTo.current = hlId;
    scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - space.xl), animated: false });
  };
  return (
    <Screen disclaimer refreshing={pulling} onRefresh={onPull} top={<StaleBanner query={latest} />} {...(hlId !== null ? { scrollRef } : {})}>
      {head}
      {account ? <AccountBriefingCard briefing={account} selected={hl?.kind === "account" && hl.id === account.id} /> : null}
      {banner}
      {krHoliday ? <Muted style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>한국 휴장일 · 국내 종목 브리핑 없음{market.data?.KR.opensAt ? ` · 다음 개장 ${formatDateKo(market.data.KR.opensAt, true)}` : ""}</Muted> : null}
      {movers && top.length > 0 ? (
        <Card>
          <SectionTitle>변동 큰 종목</SectionTitle>
          {top.map((i) => (
            <Pressable
              key={i.code}
              onPress={() => router.push(`/briefings/${i.latest!.id}`)}
              accessibilityRole="link"
              accessibilityLabel={sentence([i.name, speakRate(rates.get(i.code) ?? null), "브리핑 보기"])}
              hitSlop={TOP_ROW_SLOP}
              style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.s }}
            >
              <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                {i.name}
              </Text>
              <ChangeText value={rates.get(i.code) ?? null} text={formatPct(rates.get(i.code) ?? null)} style={{ fontSize: font.body, fontWeight: "700" }} />
            </Pressable>
          ))}
          <Muted style={{ fontSize: font.tiny }}>전일 대비 등락률 크기 순 · 매매 권유가 아닙니다</Muted>
        </Card>
      ) : null}
      {moversOn && order === "movers" && stocks.isError ? <Muted style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>등락률을 불러오지 못해 등록순으로 보여 줍니다 · 당겨서 다시 시도</Muted> : null}
      {moversOn ? (
        <Segmented
          options={[
            { value: "movers", label: "변동 큰 순" },
            { value: "registered", label: "등록순" },
          ]}
          value={order}
          onChange={setOrder}
        />
      ) : null}
      <Segmented
        options={[
          { value: "line", label: "한 줄" },
          { value: "summary", label: "요약" },
          { value: "detail", label: "상세" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {items.length === 0 ? (
        <Empty title="등록된 종목이 없습니다" hint="잔고 탭에서 종목을 추가하세요." />
      ) : withBriefing.length === 0 ? (
        <Empty title="생성된 브리핑이 없습니다" hint="평일 장 시작 전·마감 후 자동 생성" />
      ) : (
        withBriefing.map((i) => {
          const selected = hlId !== null && i.latest!.id === hlId;
          const card = <BriefingCard key={i.code} briefing={i.latest!} mode={mode} rate={movers ? (rates.get(i.code) ?? null) : undefined} selected={selected} />;
          return selected ? (
            <View key={i.code} onLayout={onHighlightLayout}>
              {card}
            </View>
          ) : (
            card
          );
        })
      )}
      {manual}
      {missingNote}
    </Screen>
  );
}
interface WideProps {
  head: React.ReactNode;
  twoPane: boolean;
  rail: boolean;
  list: LatestBriefing[];
  rates: Map<string, number | null>;
  ratesKnown: boolean;
  /** 목록 순서가 정해졌는지 (변동 큰 순의 등락률을 기다리는 중이면 false) */
  orderSettled: boolean;
  top: LatestBriefing[];
  movers: boolean;
  sort: { value: Order; onChange: (v: Order) => void } | null;
  mode: Mode;
  onMode: (m: Mode) => void;
  account: AccountBriefing | undefined;
  /** 계좌 브리핑 목록을 알고 있는지 (꺼짐·받음·못 받음). 받는 중이면 false */
  accountSettled: boolean;
  /** 목록 위 안내: 휴장 (넓은 창용 짧은 문구) */
  holiday: string | null;
  /** 변동 큰 순의 기준·매매 권유 아님 ('변동 큰 종목' 카드 대신). 2단은 목록 아래, 카드 격자는 목록 위 안내에 */
  criterion: string | null;
  /** 등락률을 못 받아 등록순으로 보인다는 안내 */
  ratesFail: string | null;
  banner: React.ReactNode;
  manual: React.ReactNode;
  /** 목록 머리·도구 줄 끝의 '⋯' (수동 생성). 등록 종목이 없으면 null */
  more: { onPress: () => void; busy: boolean } | null;
  missingNote: React.ReactNode;
  empty: "none" | "noBriefing" | null;
  stale: React.ReactNode;
  pulling: boolean;
  onPull: () => void;
  picked: PickState;
}

const SORT_OPTIONS: { value: Order; label: string }[] = [
  { value: "movers", label: "변동 큰 순" },
  { value: "registered", label: "등록순" },
];
const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: "line", label: "한 줄" },
  { value: "summary", label: "요약" },
  { value: "detail", label: "상세" },
];

/**
 * 넓은 창에서 탭 머리를 숨긴 만큼 위 화면 여백(상태 표시줄)을 대신 둔다 — 앱은 화면 끝까지 그리므로(edge-to-edge) 머리가 없으면
 * 목록 머리·알약·본문 제목이 상태 표시줄 아이콘 밑에 깔린다. sides 면 좌우 화면 여백도 (왼쪽은 세로 탭 막대가 있으면 막대가 맡는다)
 */
function WideFrame({ rail, sides = true, children }: { rail: boolean; sides?: boolean; children: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[styles.fill, { backgroundColor: t.bg, paddingTop: insets.top, paddingLeft: sides && !rail ? insets.left : 0, paddingRight: sides ? insets.right : 0 }]}>{children}</View>;
}

/**
 * 2단 오른쪽 칸: 고른 브리핑 본문 (아직 고르기 전 — 읽은 기록·등락률을 받는 중 — 이면 뼈대).
 * 브리핑 탭은 등락률(등록 종목 목록)을 구독하므로 장중엔 체결마다(약 0.1초) 다시 그려지지만, 본문은 그대로다.
 * 속성(고른 것·뼈대 여부·고르기 함수)이 같으면 다시 그리지 않아(React.memo) 마크다운을 다시 읽고 그리지 않는다.
 * 고른 것은 저장소(lib/briefingPick)의 같은 객체, onPick 은 고정 함수(useCallback)로 넘긴다
 */
const DetailPane = React.memo(function DetailPane({ sel, pending, onPick }: { sel: BriefingPick | null; pending: boolean; onPick: (id: number, code: string) => void }) {
  if (sel) return sel.kind === "account" ? <AccountBriefingBody key={`a${sel.id}`} numId={sel.id} layout="pane" /> : <BriefingBody key={`s${sel.id}`} id={sel.id} layout="pane" onPick={onPick} />;
  if (!pending) return null;
  return (
    <Screen>
      <CardsSkeleton count={2} />
    </Screen>
  );
});

/**
 * 2단에서 사용자가 브리핑을 고른다 (목록 줄·계좌 줄·오른쪽 칸의 지난 브리핑·다시 만든 브리핑). 오른쪽 칸만 바뀌고 주소는 그대로.
 * 누른 종목 브리핑은 읽음으로 적고, 저절로 골라져 보이던 브리핑을 두고 떠나면 그것도 읽음으로 적는다 (본문을 본 뒤 떠났다)
 */
function chooseBriefing(pick: BriefingPick): void {
  const left = pickByUser(pick);
  if (left !== null) markBriefingRead(left);
  if (pick.kind === "stock") markBriefingRead(pick.id);
}

/** 넓은 창 브리핑 탭 (3-42 웨이브 D): 2단(목록 + 본문) 또는 카드 격자 */
function WideBriefings(p: WideProps) {
  const t = useTheme();
  const { width: winW, fontScale } = useWindowDimensions();
  const { read, ready } = useReadBriefings(true);
  const [gridW, setGridW] = useState<number | null>(null);
  const briefs = useMemo(() => p.list.map((i) => i.latest!), [p.list]);
  const latestKey = latestSession(briefs);
  const sel = p.picked.pick;
  const accountId = p.account?.id ?? null;
  // 고른 브리핑의 종목 코드: 알림·전체 화면에서 연 브리핑은 코드를 모르므로 받아 둔 브리핑에서 (오른쪽 칸과 같은 요청이라 다시 받지 않는다)
  const selInfo = useBriefing(sel?.kind === "stock" && !sel.code ? sel.id : 0);
  const selCode = sel?.kind === "stock" ? (sel.code ?? selInfo.data?.code ?? null) : null;
  // 목록에서 강조할 줄: 고른 브리핑, 목록에 없는 지난 브리핑이면 같은 종목 줄
  const rowId = selectedRowId(sel, briefs, selCode);
  // 읽은 기록과 목록 순서가 정해져야 처음 고를 브리핑을 정한다 (그 전에 고르면 다시 정렬될 때 맨 위 미확인이 아닐 수 있다)
  const settled = ready && p.orderSettled;

  // 2단: 처음 열면 첫 미확인(없으면 맨 위, 종목 브리핑이 없으면 계좌 브리핑)을 고른다 → 누르지 않아도 오른쪽 칸이 차 있다.
  // 이미 고른 것(접기 전에 보던 것 · 알림으로 연 것)이 있으면 그대로 두고, 접었을 때 폰 목록에서 강조되도록 표시만 켠다.
  // 단, 앱이 켜진 채 다음 세션 브리핑이 와서 고른 것이 목록에서 사라졌으면 새 목록의 첫 미확인을 다시 고른다.
  // 보던 계좌 브리핑이 없어지면(서버가 계좌 브리핑을 끔·목록이 빔) 막다른 안내 대신 바로 첫 미확인을 다시 고른다
  const accountGone = sel?.kind === "account" && accountId === null && p.accountSettled;
  useEffect(() => {
    if (!p.twoPane || !settled) return;
    const fresh = noteListSession(latestKey);
    const gone = sel !== null && (sel.kind === "stock" ? !briefs.some((b) => b.id === sel.id) : sel.id !== accountId);
    if (sel && !(fresh && gone) && !accountGone) {
      if (!p.picked.highlight) pickBriefing(sel, { highlight: true });
      return;
    }
    const id = firstPick(briefs, read);
    const first = id === null ? undefined : briefs.find((b) => b.id === id);
    if (first) pickAuto({ kind: "stock", id: first.id, code: first.code });
    else if (accountId !== null) pickAuto({ kind: "account", id: accountId });
    else if (sel) pickBriefing(null, { highlight: false });
  }, [p.twoPane, settled, sel, p.picked.highlight, briefs, read, accountId, latestKey, accountGone]);

  // 사용자가 누른 브리핑만 읽음으로 적는다 (저절로 골라진 첫 미확인은 점을 남겨, 탭을 열었다 바로 떠나도 읽은 것이 되지 않게).
  // 고정 함수 — 오른쪽 칸(DetailPane)이 체결마다 다시 그려지지 않게
  const choose = useCallback((id: number, code: string) => chooseBriefing({ kind: "stock", id, code }), []);

  const rankOf = (i: LatestBriefing) => {
    const n = p.movers ? p.top.indexOf(i) + 1 : 0;
    return n > 0 ? n : undefined;
  };
  const rateOf = (i: LatestBriefing) => (p.ratesKnown ? (p.rates.get(i.code) ?? null) : undefined);
  const unreadOf = (i: LatestBriefing) => ready && isUnread(i.latest!, read, latestKey);
  const emptyView =
    p.empty === "none" ? <Empty title="등록된 종목이 없습니다" hint="잔고 탭에서 종목을 추가하세요." /> : p.empty === "noBriefing" ? <Empty title="생성된 브리핑이 없습니다" hint="평일 장 시작 전·마감 후 자동 생성" /> : null;
  // 목록 위 안내는 한 줄에 모은다 (휴장 · 정렬 기준 · 등락률 못 받음). 길면 안내 묶음째 다음 줄로.
  // 2단 목록(400)은 목업처럼 휴장 안내만 위에 두고(한 줄 → 첫 화면 9줄), 변동 큰 순 기준·매매 권유 아님은 목록 아래에 둔다.
  // 순위(1~3)의 뜻은 바로 위 정렬 알약(변동 큰 순)과 줄마다 읽는 문장('변동 큰 순 1위')이 알려 준다
  const noticeOf = (items: (string | null)[]) => {
    const list = items.filter((x): x is string => !!x);
    return list.length ? <ListNotice items={list} /> : null;
  };
  const notice = p.twoPane ? noticeOf([p.holiday, p.ratesFail]) : noticeOf([p.holiday, p.criterion, p.ratesFail]);

  if (p.twoPane) {
    const left = (
      <View style={[styles.listPane, { backgroundColor: t.surface }]}>
        <View style={[styles.listHead, { borderBottomColor: t.line }]}>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }} accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome}>
            브리핑
          </Text>
          <View style={styles.headRight}>
            {p.sort ? <Pills label="정렬" options={SORT_OPTIONS} value={p.sort.value} onChange={p.sort.onChange} /> : null}
            {p.more ? <MoreButton onPress={p.more.onPress} busy={p.more.busy} /> : null}
          </View>
        </View>
        {notice}
        {p.account ? (
          <AccountBriefingRow
            briefing={p.account}
            role="button"
            selected={sel?.kind === "account" && sel.id === p.account.id}
            onPress={() => chooseBriefing({ kind: "account", id: p.account!.id })}
          />
        ) : null}
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={p.pulling} onRefresh={p.onPull} tintColor={t.muted} colors={[t.accent]} progressBackgroundColor={t.surface} />}
        >
          {p.banner}
          {emptyView ??
            p.list.map((i) => (
              <BriefingRow
                key={i.code}
                briefing={i.latest!}
                name={i.latest!.name ?? i.name}
                rate={rateOf(i)}
                rank={rankOf(i)}
                unread={unreadOf(i)}
                selected={rowId !== null && i.latest!.id === rowId}
                onPress={() => choose(i.latest!.id, i.code)}
              />
            ))}
          <View style={styles.listFoot}>
            {p.criterion && !emptyView ? <Muted style={styles.criterion}>{p.criterion}</Muted> : null}
            {p.manual}
            {p.missingNote}
          </View>
        </ScrollView>
      </View>
    );
    // 오른쪽 칸: 고른 브리핑. 아직 고르기 전(읽은 기록·등락률을 받는 중)에는 '고르세요' 안내 대신 뼈대를 보인다
    const pending = !sel && !settled && (briefs.length > 0 || accountId !== null);
    const right = sel || pending ? <DetailPane sel={sel} pending={pending} onPick={choose} /> : null;
    return (
      <WideFrame rail={p.rail} sides={false}>
        {p.head}
        {p.stale}
        <TwoPane
          left={left}
          right={right}
          // 목록 칸이 이미 '등록된 종목이 없습니다' 같은 안내를 보이면 오른쪽은 같은 말을 되풀이하지 않는다
          empty={
            <Screen disclaimer>
              {emptyView ? <Empty title="브리핑 본문" hint="브리핑이 만들어지면 왼쪽 목록에서 골라 여기서 읽습니다." /> : <Empty title="왼쪽에서 브리핑을 고르세요" hint="고른 브리핑의 요약과 상세가 여기에 보입니다." />}
            </Screen>
          }
          // 왼쪽 세로 탭 막대가 이미 왼쪽 화면 여백을 차지한다
          insetLeft={!p.rail}
        />
      </WideFrame>
    );
  }

  // 카드 격자 (펼친 폴드8 세로 등): 도구 한 줄 → 안내 → 계좌 줄 → 카드 → 수동 생성
  const hl = p.picked.highlight ? sel : null;
  const hlRow = p.picked.highlight ? rowId : null;
  const inner = (gridW ?? winW) - 2 * space.md;
  const cols = gridColumns(inner, fontScale, { minW: FB.cardMinW, gap: space.sm, max: FB.cardMaxCols, cap: fontCap.row });
  const cardW = Math.floor((inner - (cols - 1) * space.sm) / cols);
  return (
    <WideFrame rail={p.rail}>
      <Screen disclaimer refreshing={p.pulling} onRefresh={p.onPull} top={p.stale}>
        {p.head}
        <View>
          <View style={[styles.tool, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
            {p.sort ? <Pills label="정렬" options={SORT_OPTIONS} value={p.sort.value} onChange={p.sort.onChange} /> : null}
            <Pills label="보기" options={MODE_OPTIONS} value={p.mode} onChange={p.onMode} />
            {p.more ? (
              <View style={styles.toolEnd}>
                <MoreButton onPress={p.more.onPress} busy={p.more.busy} />
              </View>
            ) : null}
          </View>
          {notice}
          {p.account ? (
            <AccountBriefingRow briefing={p.account} role="link" selected={hl?.kind === "account" && hl.id === p.account.id} onPress={() => router.push(`/briefings/account/${p.account!.id}`)} />
          ) : null}
        </View>
        {p.banner}
        {emptyView ?? (
          <View style={styles.grid} onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
            {p.list.map((i) => (
              <BriefingTile
                key={i.code}
                briefing={i.latest!}
                name={i.latest!.name ?? i.name}
                rate={rateOf(i)}
                rank={rankOf(i)}
                unread={unreadOf(i)}
                selected={hlRow !== null && hlRow === i.latest!.id}
                mode={p.mode}
                width={cardW}
                onPress={() => router.push(`/briefings/${i.latest!.id}`)}
              />
            ))}
          </View>
        )}
        {p.manual}
        {p.missingNote}
      </Screen>
    </WideFrame>
  );
}

/** 변동 큰 종목 한 줄(글자 약 19 + 위아래 6) — 100% 배치는 그대로, 누르는 영역만 44 로 */
const TOP_ROW_SLOP = slopFor(31);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  listPane: { flex: 1 },
  listHead: { minHeight: FB.headH, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  headRight: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: space.xs },
  toolEnd: { marginLeft: "auto" },
  listContent: { paddingBottom: space.xl },
  listFoot: { gap: space.sm, paddingTop: space.sm },
  criterion: { paddingHorizontal: space.lg, fontSize: font.tiny },
  tool: { minHeight: FB.headH, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.md },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
