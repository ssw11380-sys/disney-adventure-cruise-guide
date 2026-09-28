import { router } from "expo-router";
import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccountBriefing, useFeature, useFeatures } from "@/api/hooks";
import type { AccountBriefingWithData, AccountData, AccountEvents, AccountExposure, AccountSchedule } from "@/api/types";
import { BriefingSplit, type BodyLayout } from "@/components/BriefingBody";
import { StaleBanner } from "@/components/Freshness";
import { ScheduleLink } from "@/components/ScheduleLink";
import { useSettingsGuide } from "@/lib/settingsLink";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { CardsSkeleton } from "@/components/Skeleton";
import { Badge, Button, Card, ChangeText, Empty, ErrorView, Muted, SectionTitle, TableHead } from "@/components/ui";
import { sentence, speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { briefingTime, contributionSpeech, contributionTable, fxEquationSpeech, localDay, summaryShownLines, summarySpeech, templateNote } from "@/lib/accountBriefing";
import { EXPOSURE_ABOUT, exposureView } from "@/lib/accountExposure";
import { QTY_HEAD, QTY_NONE, sinceLastView, sinceNone, WEIGHT_HEAD, WEIGHT_NONE } from "@/lib/accountSinceLast";
import { eventsView } from "@/lib/holdingEvents";
import { usHolidayWhen } from "@/lib/briefingDigest";
import { mdw } from "@/lib/marketSummary";
import { accountColumns } from "@/lib/briefingPick";
import { gated } from "@/lib/features";
import { formatDateKo, formatIndexValue, formatPct, formatWon, SESSION_LABEL, shownSign } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { quoteBasisChunks, quoteBasisSpeech } from "@/lib/numberBasis";
import { changeColor, font, fontCap, space, touch, useTheme } from "@/theme";
import { foldBriefings as FB, layout as L } from "@/tokens";

/**
 * 계좌 한 장 브리핑 본문 (3-31, 3-42 웨이브 D1: app/briefings/account/[id].tsx 에서 떼어냄): 오늘 내 계좌가 왜 움직였는지 한 화면에.
 * 요약 → 총 평가·당일 손익 → 당일 손익 기여(상위 + 그 외 = 당일 손익) → 지수·환율 영향(환율 효과 따로) → 오늘 일정 → 설명(모델 또는 기본 문장) → 기준·고지.
 * 숫자는 모두 서버가 계산한 값 그대로다. 플래그 accountBriefing 이 꺼져 있으면 아무것도 불러오지 않는다.
 * 배치 (components/BriefingBody 와 같은 이름):
 *  - stack: 지금 폰 화면 그대로 / pane: 브리핑 탭 2단의 오른쪽 칸 (쌓는 순서는 같고 화면 머리 제목만 바꾸지 않는다)
 *  - split: 넓은 창 전체 화면 — 3칸(요약·총 평가·설명 | 기여 표 | 지수·환율·오늘 일정, 펼친 폴드8 가로·울트라 가로) 또는 2칸(요약·총 평가·기여 표 | 지수·환율·일정·설명)
 */
export function AccountBriefingBody({ numId, layout, title }: { numId: number | null; layout: BodyLayout; title?: (b: AccountBriefingWithData) => React.ReactNode }) {
  const on = useFeature("accountBriefing", false); // 새 기능: 서버가 켤 때만
  // 브리핑 2차 4 (플래그 briefingTrim, 앱 fallback 꺼짐): 휴장 줄 날짜·기본 설명 카드 빼기·제목·배지. 꺼지면 지금 그대로
  const trim = useFeature("briefingTrim", false);
  // 브리핑 3차 3 (플래그 accountSinceLast, 앱 fallback 꺼짐): 총 평가 아래 '지난 오전 브리핑과 비교' 카드. 꺼지면 지금 그대로
  const since = useFeature("accountSinceLast", false);
  // 브리핑 3차 4 (플래그 accountExposure, 앱 fallback 꺼짐): 총 평가 카드·띠 아래 '비중 · 가장 큰 종목 …' 두 줄. 꺼지면 지금 그대로
  const exposure = useFeature("accountExposure", false);
  // 브리핑 3차 5 (플래그 holdingEvents, 앱 fallback 꺼짐): '오늘 일정' 아래 '다가오는 일정' 카드. 꺼지면 지금 그대로
  const events = useFeature("holdingEvents", false);
  // 3-32 (플래그 numberBasis, 앱 fallback 꺼짐): 총 평가 카드 아래 '시세 기준' 한 줄 (저장한 quoteBasis 가 있는 브리핑만). 꺼지면 지금 그대로
  const quoteBasisOn = useFeature("numberBasis", false);
  // 3-38 (플래그 holdingSchedule, 앱 fallback 꺼짐): '다가오는 일정'(없으면 '오늘 일정') 카드 맨 아래 '일정·공시 모두 보기' 줄. 꺼지면 지금 그대로
  const schedule = useFeature("holdingSchedule", false);
  const flags = useFeatures();
  const q = useAccountBriefing(numId ?? 0, on && numId !== null);
  // 3-24 연결 오류의 '설정 열기'·칸 이름 문구 (플래그 emptyGuide, 꺼져 있으면 null — 지금 그대로)
  const guide = useSettingsGuide();
  const data = gated(on, q.data);
  // 2단 오른쪽 칸은 고지가 이 칸에만 있으므로 불러오는 중·오류·꺼짐에도 붙인다 (고지 줄이 들썩이지 않게). 전체 화면은 지금 그대로
  const paneNote = layout === "pane";

  if (numId === null) return <Screen><ErrorView error={new Error("계좌 브리핑 주소가 올바르지 않습니다")} retryLabel="브리핑 목록으로" onRetry={() => router.dismissTo("/briefings")} /></Screen>;
  if (!on) {
    // 플래그를 아직 못 받았으면(알림으로 막 켠 경우) 잠깐 기다린다
    if (flags.data === undefined && flags.isFetching) return <Screen disclaimer={paneNote}><CardsSkeleton count={2} /></Screen>;
    // 플래그를 받지 못함(끊김·서버 오류·오프라인으로 멈춤): '꺼져 있다'고 하지 않고 연결을 확인하게
    if (flags.data === undefined) {
      return (
        <Screen disclaimer={paneNote}>
          <Empty
            title="계좌 브리핑을 불러오지 못했습니다"
            hint="연결을 확인해 주세요. 인터넷이 연결되면 다시 시도할 수 있습니다."
            action={<Button title="다시 시도" variant="secondary" compact onPress={() => void flags.refetch()} />}
          />
        </Screen>
      );
    }
    // 2단 오른쪽 칸은 이미 브리핑 탭 안이라 '브리핑 탭으로' 버튼을 두지 않는다 (누르면 아무 일도 없는 버튼이 되므로)
    return (
      <Screen disclaimer={paneNote}>
        <Empty
          title="계좌 브리핑을 볼 수 없습니다"
          hint={layout === "pane" ? "지금은 계좌 브리핑이 꺼져 있습니다. 왼쪽 목록에서 종목 브리핑을 고르세요." : "지금은 계좌 브리핑이 꺼져 있습니다. 종목별 브리핑은 브리핑 탭에 있습니다."}
          action={layout === "pane" ? undefined : <Button title="브리핑 탭으로" variant="secondary" compact onPress={() => router.dismissTo("/briefings")} />}
        />
      </Screen>
    );
  }
  const view = viewState(q);
  if (view === "error") return <Screen disclaimer={paneNote}><ErrorView error={q.error} onRetry={() => void q.refetch()} {...guide} /></Screen>;
  if (view === "loading" || !data) return <Screen disclaimer={paneNote}><CardsSkeleton count={3} /></Screen>;
  // 2단 오른쪽 칸은 끊김·지연 띠를 탭 위쪽에 한 번만 둔다
  return <AccountBriefingView b={data} top={layout === "pane" ? null : <StaleBanner query={q} {...guide} />} layout={layout} title={title} trim={trim} since={since} exposure={exposure} events={events} quoteBasisOn={quoteBasisOn} schedule={schedule} />;
}

/**
 * trim(브리핑 2차 4, 플래그 briefingTrim)이 켜져 있으면:
 *  - 머리 배지 '숫자로 만든 기본 설명' → '숫자로 만든 요약', 요약의 '오늘 한국 휴장 · …' 줄(서버가 저장한 글)을 브리핑 날짜 줄로 바꿔 그림(저장한 글은 그대로)
 *  - '무엇이 계좌를 움직였나' 카드: 기본 설명(template)이면 그리지 않음(기여 표·보유분 줄을 문장으로 되풀이), 모델 설명이면 제목만 '모델이 쓴 설명'
 *  - 기여 표 아래 설명의 휴장 날짜, '지수·환율 영향' 제목 → '보유분·지수·환율'
 */
function AccountBriefingView({
  b,
  top,
  layout,
  title,
  trim,
  since = false,
  exposure = false,
  events = false,
  quoteBasisOn,
  schedule = false,
}: {
  b: AccountBriefingWithData;
  top: React.ReactNode;
  layout: BodyLayout;
  title?: (b: AccountBriefingWithData) => React.ReactNode;
  trim: boolean;
  since?: boolean;
  exposure?: boolean;
  events?: boolean;
  /** 3-32 (플래그 numberBasis): 총 평가 카드·띠 아래 '시세 기준' 줄 */
  quoteBasisOn: boolean;
  /** 3-38 (플래그 holdingSchedule): '일정·공시 모두 보기' 줄 */
  schedule?: boolean;
}) {
  const t = useTheme();
  const d = b.data;
  // 3-38: '다가오는 일정' 카드가 있으면 그 끝, 없으면 '오늘 일정' 카드 끝에 한 줄 (꺼지면 어느 카드에도 없음 — 카드 트리가 지금과 같다)
  const scheduleLink = schedule ? <ScheduleLink /> : null;
  const upcoming = events && d?.events ? d.events : null;
  const failed = b.status === "failed" || !d;
  const header = (
    <View style={styles.header}>
      <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "700" }} accessibilityRole="header">
        내 계좌 브리핑
      </Text>
      <Muted>
        {formatDateKo(b.date)} {SESSION_LABEL[b.session]} · {formatDateKo(b.createdAt, true)} 생성
      </Muted>
      <View style={styles.badges}>
        {failed ? <Badge tone="bad">생성 실패</Badge> : null}
        {!failed && b.template ? <Badge>{trim ? "숫자로 만든 요약" : "숫자로 만든 기본 설명"}</Badge> : null}
        {d && d.stale > 0 ? <Badge tone="warn">시세 지연 {d.stale}종목</Badge> : null}
      </View>
    </View>
  );
  const failedCard = (
    <Card>
      <Text style={{ color: t.danger, fontSize: font.body }}>{b.summary}</Text>
      <Muted>다음 브리핑 시간에 다시 만듭니다.</Muted>
    </Card>
  );
  const summary = d ? (
    <Card>
      {/* 한 줄에 숫자가 여럿이라 화면 읽기는 기호 없이 한 문장으로 (디자인 규칙) */}
      <View accessible accessibilityLabel={summarySpeech(d, { trim })}>
        {summaryShownLines(b, { trim }).map((line, i) =>
          // 넓은 창(두·세 칸)은 칸이 좁아(약 260) ' · ' 로 나뉜 묶음째 줄을 바꾼다 — '엔비|디아'·'등|락' 처럼 낱말 가운데서 꺾이지 않게. 폰은 그대로
          layout === "stack" ? (
            <Text key={i} style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.6 }}>
              {line}
            </Text>
          ) : (
            <Chunks key={i} parts={line.split(" · ")} joiner=" ·" style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.6 }} />
          ),
        )}
      </View>
    </Card>
  ) : null;
  const narrative = trim && b.template ? null : (
    <Card>
      <SectionTitle right={b.template ? <Badge>기본 설명</Badge> : null}>{trim ? "모델이 쓴 설명" : "무엇이 계좌를 움직였나"}</SectionTitle>
      <MarkdownView>{b.detail}</MarkdownView>
      <Muted style={{ fontSize: font.tiny }}>
        {/* 자세한 이유(모델이 지어낸 숫자·오류 문구)는 화면에 옮기지 않는다 — 틀린 숫자를 실제 값으로 읽지 않게 */}
        {b.template && d ? templateNote(d.narrative.reason) : "모델이 위 숫자만 옮겨 쓴 설명입니다. 입력에 없는 숫자나 매매·전망 표현이 나오면 기본 설명으로 바꿉니다."}
      </Muted>
    </Card>
  );
  const basisLine = d ? (
    <Muted style={styles.basis}>
      기준: {d.basis} · {formatDateKo(d.asOf, true)} 계산
    </Muted>
  ) : null;
  // 브리핑 3차 4 (플래그 accountExposure): 비중 두 줄이 있으면 맨 아래 기준 줄 밑에 '비중'·'미국 상장'의 뜻 한 줄 (첫 화면 밖 — 총 평가 카드를 늘리지 않게). 꺼지면 지금 그대로
  const basis =
    exposure && d?.exposure ? (
      <>
        {basisLine}
        <Muted style={styles.basis}>{EXPOSURE_ABOUT}</Muted>
      </>
    ) : (
      basisLine
    );

  if (layout === "split" && !failed && d) {
    return <AccountSplit d={d} top={top} head={title?.(b)} header={header} summary={summary} narrative={narrative} basis={basis} trim={trim} since={since} exposure={exposure} events={events} quoteBasisOn={quoteBasisOn} scheduleLink={scheduleLink} />;
  }

  // stack(지금 폰 화면)·pane(2단 오른쪽 칸)·실패: 한 줄로 쌓기
  return (
    <Screen disclaimer top={top}>
      {layout === "pane" ? null : title?.(b)}
      {header}
      {failed ? (
        failedCard
      ) : (
        <>
          {summary}
          {/* 2단 오른쪽 칸은 넓은 창 두 칸과 같은 한 줄 띠 (폰 화면은 큰 숫자 카드 그대로) */}
          {layout === "pane" ? <TotalsBand d={d} exposure={exposure} quoteBasisOn={quoteBasisOn} /> : <TotalsCard d={d} exposure={exposure} quoteBasisOn={quoteBasisOn} />}
          <ContributionCard d={d} wide={layout === "pane"} trim={trim} />
          {/* 기여 표 아래 — 오늘 무엇이 계좌를 움직였는지(기여 표)가 첫 화면에서 밀려나지 않게 */}
          {since ? <SinceLastCard d={d} /> : null}
          <ImpactCard d={d} trim={trim} />
          <ScheduleCard s={d.schedule} asOf={d.asOf} footer={upcoming ? null : scheduleLink} />
          {/* 브리핑 3차 5: '오늘 일정' 바로 아래 */}
          {upcoming ? <UpcomingCard e={upcoming} footer={scheduleLink} /> : null}
          {narrative}
          {basis}
        </>
      )}
    </Screen>
  );
}

/**
 * 넓은 창 전체 화면 (3-42 SPEC, 칸마다 스크롤):
 *  - 3칸 (펼친 폴드8 가로·울트라 가로): 요약·총 평가·설명 | 당일 손익 기여 표 | 지수·환율·오늘 일정 → 기여 표가 첫 화면에 다 들어온다
 *  - 2칸 (울트라 세로·폴드8 세로 — 창이 3칸에 모자람): 요약·총 평가·기여 표 | 지수·환율·오늘 일정·설명
 * 칸 수는 좌우 화면 여백을 뺀 창 폭으로 정한다 (lib/briefingPick accountColumns)
 */
function AccountSplit({
  d,
  top,
  head,
  header,
  summary,
  narrative,
  basis,
  trim,
  since = false,
  exposure = false,
  events = false,
  quoteBasisOn,
  scheduleLink = null,
}: {
  d: AccountData;
  top: React.ReactNode;
  head: React.ReactNode;
  header: React.ReactNode;
  summary: React.ReactNode;
  narrative: React.ReactNode;
  basis: React.ReactNode;
  trim: boolean;
  since?: boolean;
  exposure?: boolean;
  events?: boolean;
  /** 3-32 (플래그 numberBasis): 총 평가 띠 아래 '시세 기준' 줄 */
  quoteBasisOn: boolean;
  /** 3-38 (플래그 holdingSchedule): '일정·공시 모두 보기' 줄 (꺼지면 null) */
  scheduleLink?: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // 바로 전 칸 수: 3칸은 912 에서 켜고 888 아래로 좁아져야 끈다 (창 크기를 끌어 바꿀 때 깜빡이지 않게).
  // 지난 그리기의 값을 상태로 기억한다 (바뀌었을 때만 적는 React 의 '이전 값 저장' 방식)
  const [prev, setPrev] = useState<2 | 3 | null>(null);
  const cols = accountColumns(width - insets.left - insets.right, { contribW: FB.accountContribW, minW: FB.accountColMinW, divider: L.divider, hysteresis: FB.accountColsHysteresis }, prev);
  if (cols !== prev) setPrev(cols);
  const three = cols === 3;
  const impact = (
    <>
      <ImpactCard d={d} trim={trim} />
      <ScheduleCard s={d.schedule} asOf={d.asOf} footer={events && d.events ? null : scheduleLink} />
      {/* 브리핑 3차 5: 오른쪽 칸 '오늘 일정' 아래 */}
      {events && d.events ? <UpcomingCard e={d.events} footer={scheduleLink} /> : null}
    </>
  );
  return (
    <Screen scroll={false} disclaimer top={top}>
      {head}
      {three ? (
        <BriefingSplit
          left={
            <>
              {header}
              {summary}
              <TotalsBand d={d} exposure={exposure} quoteBasisOn={quoteBasisOn} />
              {since ? <SinceLastCard d={d} /> : null}
              {narrative}
              {basis}
            </>
          }
          middle={<ContributionCard d={d} wide trim={trim} />}
          middleW={FB.accountContribW}
          right={impact}
        />
      ) : (
        <BriefingSplit
          left={
            <>
              {header}
              {summary}
              <TotalsBand d={d} exposure={exposure} quoteBasisOn={quoteBasisOn} />
              <ContributionCard d={d} wide trim={trim} />
              {since ? <SinceLastCard d={d} /> : null}
            </>
          }
          right={
            <>
              {impact}
              {narrative}
              {basis}
            </>
          }
        />
      )}
    </Screen>
  );
}

/** 총 평가금액·당일 손익·누적 손익 (화면 읽기는 한 문장) */
function totalsSpeech(d: AccountData): string {
  return sentence([
    `총 평가금액 ${speakAmount(formatWon(d.totalValue))}`,
    `당일손익 ${speakProfit(formatWon(d.dayPnl, { sign: true }), Math.sign(d.dayPnl)) ?? "없음"}`,
    speakRate(d.dayRate),
    `평가손익 ${speakProfit(formatWon(d.totalProfit, { sign: true }), Math.sign(d.totalProfit)) ?? "없음"}`,
    d.totalProfitRate !== null ? `수익률 ${speakRate(d.totalProfitRate)}` : null,
    `보유 ${d.holdings}종목`,
  ]);
}

/**
 * 3-32 (플래그 numberBasis): '보유 N종목 합계' 바로 아래 '시세 기준: 국내 NXT 포함 · 미국 정규장 · 08:38 계산'.
 * 총 평가 문장 묶음(totalsSpeech) 밖이라 이 줄 하나를 자기 이름표로 한 번만 읽는다 (Muted 에는 이름표가 없어 View 로 감쌈).
 * 켰을 때만 그리고(부르는 쪽이 거름), 저장한 기준이 없는 예전 브리핑이면 그리지 않는다.
 * 좁은 칸·큰 글씨는 기준 묶음째 다음 줄로 (quoteBasisChunks — 조각 끝에 이음표·줄바꿈 없는 공백이 있어 조각 사이 간격을 따로 두지 않는다).
 * 한 글로 그리면 '· 09:13 계산'처럼 '·'로 시작하는 줄, '시간외 포함' / '1', '정규장 9·주' / '간거래 2'처럼 꺾였다
 */
function QuoteBasisRow({ d }: { d: AccountData }) {
  const at = briefingTime(d.asOf);
  const chunks = quoteBasisChunks(d.quoteBasis, at);
  const speech = quoteBasisSpeech(d.quoteBasis, at);
  if (!chunks || !speech) return null;
  return (
    <View accessible accessibilityLabel={speech} style={styles.quoteBasis}>
      {chunks.map((p, i) => (
        <Muted key={i}>{p}</Muted>
      ))}
    </View>
  );
}

function TotalsCard({ d, exposure = false, quoteBasisOn = false }: { d: AccountData; exposure?: boolean; quoteBasisOn?: boolean }) {
  const t = useTheme();
  const label = totalsSpeech(d);
  return (
    <Card>
      <View accessible accessibilityLabel={label} style={{ gap: space.xs }}>
        <Muted>총 평가금액{d.afterCost ? " · 비용 차감" : ""}</Muted>
        <Text style={[styles.total, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {formatWon(d.totalValue)}
        </Text>
        <View style={styles.kpis}>
          <Kpi label="당일 손익" value={formatWon(d.dayPnl, { sign: true })} sub={d.dayRate !== null ? formatPct(d.dayRate) : null} tone={d.dayPnl} rate={d.dayRate} />
          <Kpi label="평가손익" value={formatWon(d.totalProfit, { sign: true })} sub={d.totalProfitRate !== null ? formatPct(d.totalProfitRate) : null} tone={d.totalProfit} rate={d.totalProfitRate} />
        </View>
      </View>
      <Muted>보유 {d.holdings}종목 합계 · 앱 잔고 화면과 같은 기준</Muted>
      {quoteBasisOn ? <QuoteBasisRow d={d} /> : null}
      {d.excluded.length ? <Muted>합계에서 뺀 종목: {d.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}</Muted> : null}
      {exposure && d.exposure ? <ExposureLines e={d.exposure} /> : null}
    </Card>
  );
}

/**
 * 넓은 창 두 칸의 총 평가 띠 (3-42): 총 평가금액 | 당일 손익 | 평가손익 을 한 줄에 (폭이 모자라면 다음 줄로, 숫자는 줄이지 않음).
 * 폰 카드(TotalsCard)의 큰 숫자 한 칸 + 두 칸 대신 한 줄에 놓아 기여 표가 첫 화면에 들어오게 한다. 화면 읽기 문장은 카드와 같다
 */
function TotalsBand({ d, exposure = false, quoteBasisOn = false }: { d: AccountData; exposure?: boolean; quoteBasisOn?: boolean }) {
  const t = useTheme();
  return (
    <Card>
      <View accessible accessibilityLabel={totalsSpeech(d)} style={styles.band}>
        <View style={styles.bandItem}>
          <Muted>총 평가금액{d.afterCost ? " · 비용 차감" : ""}</Muted>
          <Text style={[styles.bandValue, { color: t.ink, fontSize: font.title }]} maxFontSizeMultiplier={fontCap.row}>
            {formatWon(d.totalValue)}
          </Text>
        </View>
        <BandKpi label="당일 손익" value={formatWon(d.dayPnl, { sign: true })} sub={d.dayRate !== null ? formatPct(d.dayRate) : null} tone={d.dayPnl} rate={d.dayRate} />
        <BandKpi label="평가손익" value={formatWon(d.totalProfit, { sign: true })} sub={d.totalProfitRate !== null ? formatPct(d.totalProfitRate) : null} tone={d.totalProfit} rate={d.totalProfitRate} />
      </View>
      <Muted>보유 {d.holdings}종목 합계 · 앱 잔고 화면과 같은 기준</Muted>
      {quoteBasisOn ? <QuoteBasisRow d={d} /> : null}
      {d.excluded.length ? <Muted>합계에서 뺀 종목: {d.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}</Muted> : null}
      {exposure && d.exposure ? <ExposureLines e={d.exposure} /> : null}
    </Card>
  );
}

/**
 * 브리핑 3차 4 (플래그 accountExposure): 총 평가 카드·띠의 '보유 N종목 합계' 줄(과 '합계에서 뺀 종목' 줄) 아래 비중 두 줄 —
 * '비중 · 가장 큰 종목 엔비디아 21.3% · 상위 3종목 48.2% · 레버리지·인버스 9.1% · 미국 상장 62.4%' /
 * '레버리지·인버스: SOXL(3배) · RGTX(2배) · 보유 종목 평가금액 기준, 현금 제외 · 08:38 기준'.
 * 숫자는 서버가 저장한 값 그대로, 판단하는 말·등락 색 없음. 좁은 칸·큰 글씨는 ' · ' 묶음째 줄바꿈(줄 수 제한·글자 줄이기 없음). 화면 읽기는 한 문장
 */
function ExposureLines({ e }: { e: AccountExposure }) {
  const t = useTheme();
  const chunkRow = useChunkRow();
  const v = exposureView(e);
  // 묶음 끝 ' ·' 의 공백은 줄바꿈 없는 공백 — 묶음 글이 칸보다 길어 그 안에서 줄이 바뀔 때 '·' 하나만 다음 줄 맨 앞에 남지 않게
  const joined = (parts: string[]) => parts.map((p, i) => (i < parts.length - 1 ? `${p}\u00a0·` : p));
  return (
    <View accessible accessibilityLabel={v.speech} style={[styles.exposure, { borderTopColor: t.line }]}>
      <View style={chunkRow}>
        {joined(v.line1).map((p, i) => (
          <Text key={i} style={[styles.num, { color: i === 0 ? t.sub : t.ink, fontSize: font.small, lineHeight: font.small * 1.5, fontWeight: i === 0 ? "600" : "400" }]}>
            {p}
          </Text>
        ))}
      </View>
      <View style={chunkRow}>
        {joined(v.line2).map((p, i) => (
          <Muted key={i} style={{ fontSize: font.tiny }}>
            {p}
          </Muted>
        ))}
      </View>
    </View>
  );
}

function BandKpi({ label, value, sub, tone, rate }: { label: string; value: string; sub: string | null; tone: number; rate: number | null }) {
  const t = useTheme();
  return (
    <View style={styles.bandItem}>
      <Muted>{label}</Muted>
      <Text style={[styles.bandValue, { color: changeColor(t, shownSign(tone, value)), fontSize: font.h2 }]} maxFontSizeMultiplier={fontCap.row}>
        {value}
        {sub ? <Text style={{ color: changeColor(t, shownSign(rate, sub)), fontSize: font.small }}> {sub}</Text> : null}
      </Text>
    </View>
  );
}

/**
 * 브리핑 3차 3 (플래그 accountSinceLast): '지난 오전 브리핑과 비교' 카드 — 당일 손익 기여 표 바로 아래(세 칸은 기여 표가 가운데 칸이라 왼쪽 칸 총 평가 띠 아래).
 * 두 브리핑이 저장한 숫자로(서버 계산): 기간 · 총 평가금액·평가손익 변화(지난 → 이번) · 수량이 바뀐 종목 · 비중 변화가 큰 종목 ·
 * 작은 글(수량 변화·첫날·한쪽 합계에서만 빠진 종목·합계에서 뺀 종목·비교 기준).
 * 색은 변화 금액·%p 에만(보이는 부호). 화면 읽기는 묶음마다 한 문장. 예전 기록(칸 없음)은 그리지 않고, 비교할 브리핑이 없으면 한 줄
 */
function SinceLastCard({ d }: { d: AccountData }) {
  const t = useTheme();
  const chunkRow = useChunkRow();
  const s = d.sinceLast;
  if (s === undefined) return null;
  if (s === null) {
    return (
      <Card>
        <Muted>{sinceNone(d.session)}</Muted>
      </Card>
    );
  }
  const v = sinceLastView(s, d);
  const head = { color: t.sub, fontSize: font.small, fontWeight: "600" as const };
  return (
    <Card>
      <View accessible accessibilityLabel={v.headSpeech} style={styles.sinceHead}>
        <SectionTitle>{v.title}</SectionTitle>
        <Muted>{v.range}</Muted>
        <SinceRow label="총 평가금액" fromTo={v.value.fromToParts}>
          <Text style={[styles.sinceValue, { color: changeColor(t, v.value.sign) }]}>
            {v.value.amount}
            {v.value.rate ? <Text style={{ color: changeColor(t, v.value.rateSign), fontSize: font.small }}> ({v.value.rate})</Text> : null}
          </Text>
        </SinceRow>
        <SinceRow label="평가손익" fromTo={v.profit.fromToParts}>
          <Text style={[styles.sinceValue, { color: changeColor(t, v.profit.sign) }]}>{v.profit.amount}</Text>
        </SinceRow>
      </View>
      {v.qty ? (
        <View accessible accessibilityLabel={v.qtySpeech ?? undefined} style={styles.sinceGroup}>
          {/* 없으면 머리 없이 '수량이 바뀐 종목 없음' 한 줄 */}
          {v.qty.lines.length ? <Text style={head}>{QTY_HEAD}</Text> : null}
          {v.qty.lines.length ? (
            // 좁은 칸·큰 글씨: 묶음째 다음 줄로 ('100주' 와 '→ 120주' 사이에서만 꺾임)
            v.qty.lines.map((l) => (
              <View key={l.key} style={chunkRow}>
                <Text style={{ color: t.muted, fontSize: font.body }}>{l.label} ·</Text>
                {l.parts.map((p, i) => (
                  <Text key={i} style={{ color: t.ink, fontSize: font.body }}>
                    {p}
                  </Text>
                ))}
              </View>
            ))
          ) : (
            <Muted>{QTY_NONE}</Muted>
          )}
          {v.qty.more ? <Muted>외 {v.qty.more}종목</Muted> : null}
        </View>
      ) : null}
      {v.weights ? (
        <View accessible accessibilityLabel={v.weightSpeech ?? undefined} style={styles.sinceGroup}>
          {v.weights.length ? <Text style={head}>{WEIGHT_HEAD}</Text> : null}
          {v.weights.length ? (
            v.weights.map((w) => (
              <View key={w.key} style={chunkRow}>
                {w.parts.map((p, i) => (
                  <Text key={i} style={[styles.num, { color: t.ink, fontSize: font.body }]}>
                    {p}
                  </Text>
                ))}
                <Text style={[styles.num, { color: changeColor(t, w.sign), fontSize: font.body }]}>{w.change}</Text>
              </View>
            ))
          ) : (
            <Muted>{WEIGHT_NONE}</Muted>
          )}
        </View>
      ) : null}
      {v.notes.map((n) => (
        <Muted key={n} style={{ fontSize: font.tiny }}>
          {n}
        </Muted>
      ))}
    </Card>
  );
}

/** '총 평가금액 ……… -419,338원 (-3.40%)' 한 줄 + 그 아래 '지난 → 이번' (좁으면 값이 다음 줄 오른쪽으로) */
function SinceRow({ label, fromTo, children }: { label: string; fromTo: string[]; children: React.ReactNode }) {
  const t = useTheme();
  const chunkRow = useChunkRow();
  return (
    <View style={[styles.sinceRow, { borderBottomColor: t.line }]}>
      <View style={styles.sinceLine}>
        <Text style={{ color: t.muted, fontSize: font.small }}>{label}</Text>
        <View style={styles.lineRight}>{children}</View>
      </View>
      <View style={chunkRow}>
        {fromTo.map((p, i) => (
          <Muted key={i} style={styles.num}>
            {p}
          </Muted>
        ))}
      </View>
    </View>
  );
}

/** 묶음째 줄바꿈하는 줄: 묶음 사이를 글자 크기에 맞춰 넓힌다 (200% 에서 '·퀀티넘'처럼 붙어 보이지 않게) — 100% 4 · 130% 6 · 175% 이상 8 */
function useChunkRow(): ViewStyle {
  const { fontScale } = useWindowDimensions();
  const gap = fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs;
  return { flexDirection: "row", flexWrap: "wrap", columnGap: gap };
}

/** 색은 그 글자에 보이는 값으로 — "0원"·"0.00%" 로 보이는 값을 손실·이익 색으로 칠하지 않게 (BH-38) */
function Kpi({ label, value, sub, tone, rate }: { label: string; value: string; sub: string | null; tone: number; rate: number | null }) {
  const t = useTheme();
  const color = changeColor(t, shownSign(tone, value));
  const subColor = changeColor(t, sub ? shownSign(rate, sub) : 0);
  return (
    <View style={styles.kpi}>
      <Muted>{label}</Muted>
      <Text style={[styles.kpiValue, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {value}
      </Text>
      {sub ? <Text style={[styles.num, { color: subColor, fontSize: font.small }]}>{sub}</Text> : null}
    </View>
  );
}

/**
 * 한 줄을 묶음째 줄바꿈하는 글 (넓은 창): 칸이 모자라면 묶음 사이에서만 다음 줄로 — 낱말 가운데서 꺾이지 않게.
 * joiner 는 마지막이 아닌 묶음 끝에 붙인다 (' ·' → 다음 줄이 '·' 로 시작하지 않음)
 */
function Chunks({ parts, joiner = "", style, cap }: { parts: string[]; joiner?: string; style: StyleProp<TextStyle>; cap?: number }) {
  return (
    <View style={styles.chunks}>
      {parts.map((p, i) => (
        <Text key={i} style={style} maxFontSizeMultiplier={cap}>
          {i < parts.length - 1 ? `${p}${joiner}` : p}
        </Text>
      ))}
    </View>
  );
}

/**
 * 당일 손익 기여: 상위 종목 + 그 외 = 당일 손익. wide(넓은 창 칸)면 합계 이름을 '합계' / '(= 당일 손익)' 묶음째 줄바꿈.
 * trim(briefingTrim)이면 아래 설명의 한국 휴장을 브리핑 날짜로 ('9/25(금) 한국 휴장이라 …')
 */
function ContributionCard({ d, wide = false, trim }: { d: AccountData; wide?: boolean; trim: boolean }) {
  const t = useTheme();
  const table = contributionTable(d);
  if (!table.lines.length) return null;
  return (
    <Card padded={false}>
      <SectionTitle style={styles.cardHead}>당일 손익 기여</SectionTitle>
      <TableHead>
        <Text style={[styles.th, styles.colName, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>종목</Text>
        <Text style={[styles.th, styles.colAmount, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>기여 금액</Text>
        <Text style={[styles.th, styles.colRate, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>등락률</Text>
      </TableHead>
      {table.lines.map((l) => (
        <View key={l.key} accessible accessibilityLabel={contributionSpeech(l)} style={[styles.tr, { borderBottomColor: t.line }]}>
          <Text style={[styles.colName, { color: l.others ? t.sub : t.ink, fontSize: font.body, fontWeight: l.others ? "400" : "600" }]} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
            {l.name}
          </Text>
          <Text style={[styles.num, styles.colAmount, { color: changeColor(t, l.amount), fontSize: font.body }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
            {formatWon(l.amount, { sign: true })}
          </Text>
          <Text style={[styles.num, styles.colRate, { color: l.changeRate === null ? t.muted : changeColor(t, l.changeRate), fontSize: font.small }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
            {l.changeRate === null ? "-" : formatPct(l.changeRate)}
          </Text>
        </View>
      ))}
      <View accessible accessibilityLabel={sentence(["합계, 당일 손익", speakProfit(formatWon(table.sum, { sign: true }), Math.sign(table.sum))])} style={[styles.tr, { borderBottomColor: t.line, backgroundColor: t.surfaceAlt }]}>
        {wide ? (
          <View style={styles.colName}>
            <Chunks parts={["합계", "(= 당일 손익)"]} style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} cap={fontCap.row} />
          </View>
        ) : (
          <Text style={[styles.colName, { color: t.ink, fontSize: font.body, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
            합계 (= 당일 손익)
          </Text>
        )}
        <Text style={[styles.num, styles.colAmount, { color: changeColor(t, table.sum), fontSize: font.body, fontWeight: "700" }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
          {formatWon(table.sum, { sign: true })}
        </Text>
        <Text style={[styles.num, styles.colRate, { color: t.muted, fontSize: font.small }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
          {d.dayRate !== null ? formatPct(d.dayRate) : "-"}
        </Text>
      </View>
      <Muted style={styles.cardFoot}>
        {table.matches ? "줄의 합이 당일 손익과 같습니다(원 단위로 나눔)." : "줄의 합이 당일 손익과 다릅니다. 다시 만들면 바로잡힙니다."}
        {d.fx.appliedRate ? ` 미국 종목은 적용 환율 ${formatIndexValue(d.fx.appliedRate)}원으로 원화 환산.` : ""}
        {d.krPreviousDay ? (trim ? ` ${mdw(d.date)} 한국 휴장이라 국내 종목은 직전 거래일 등락입니다(앱 잔고 화면과 같은 기준).` : " 오늘 한국은 휴장이라 국내 종목은 직전 거래일 등락입니다(앱 잔고 화면과 같은 기준).") : ""}
        {d.usPreviousDay ? ` ${usHolidayWhen(d.date, d.usHolidayDate)} 미국은 휴장이라 미국 종목은 직전 거래일 등락입니다(앞 브리핑에 이미 담긴 움직임).` : ""}
      </Muted>
    </Card>
  );
}

/** 지수·환율 영향: 지수 4개, 국내·미국 보유분, 원/달러와 환율 효과. trim(briefingTrim)이면 제목 '보유분·지수·환율' ('영향'이 원인처럼 읽혀서) */
function ImpactCard({ d, trim }: { d: AccountData; trim: boolean }) {
  const fx = d.fx;
  const bucket = (label: string, b: AccountData["markets"]["kr"]) =>
    b ? (
      <Line key={label} label={`${label} 보유분 ${b.count}종목`} speech={sentence([`${label} 보유분 당일`, speakProfit(formatWon(b.day, { sign: true }), Math.sign(b.day)), speakRate(b.dayRate)])}>
        <ChangeText value={b.day} text={`${formatWon(b.day, { sign: true })}${b.dayRate !== null ? ` (${formatPct(b.dayRate)})` : ""}`} style={styles.lineValue} />
      </Line>
    ) : null;
  return (
    <Card>
      <SectionTitle>{trim ? "보유분·지수·환율" : "지수·환율 영향"}</SectionTitle>
      {bucket("국내", d.markets.kr)}
      {bucket("미국", d.markets.us)}
      {d.indices.map((i) => (
        <Line key={i.code} label={i.name} speech={sentence([i.name, formatIndexValue(i.value), speakRate(i.changeRate), i.stale ? "지연" : null])}>
          <ChangeText value={i.changeRate} text={`${formatIndexValue(i.value)} (${formatPct(i.changeRate)})${i.stale ? " · 지연" : ""}`} style={styles.lineValue} />
        </Line>
      ))}
      {d.missingIndices.length ? <Muted>받지 못한 지수: {d.missingIndices.join(", ")}</Muted> : null}
      {fx.usdKrw ? (
        <Line label="원/달러" speech={sentence(["원달러 환율", `${formatIndexValue(fx.usdKrw.value)}원`, `전일 대비 ${formatIndexValue(Math.abs(fx.usdKrw.change))}원 ${fx.usdKrw.change > 0 ? "상승" : fx.usdKrw.change < 0 ? "하락" : "변동 없음"}`, fx.usdKrw.stale ? "지연" : null])}>
          <ChangeText value={fx.usdKrw.change} text={`${formatIndexValue(fx.usdKrw.value)}원 (${fx.usdKrw.change > 0 ? "+" : fx.usdKrw.change < 0 ? "-" : ""}${formatIndexValue(Math.abs(fx.usdKrw.change))}원)${fx.usdKrw.stale ? " · 지연" : ""}`} style={styles.lineValue} />
        </Line>
      ) : null}
      {fx.status === "computed" ? (
        <>
          <Line label="환율 효과" speech={sentence(["환율 효과", speakProfit(formatWon(fx.fxEffect!, { sign: true }), Math.sign(fx.fxEffect!)), "당일 손익에는 넣지 않음"])}>
            <ChangeText value={fx.fxEffect} text={formatWon(fx.fxEffect!, { sign: true })} style={[styles.lineValue, { fontWeight: "700" }]} />
          </Line>
          <View accessible accessibilityLabel={fxEquationSpeech(fx) ?? undefined}>
            <Muted>
              미국 보유분 원화 평가 변화 {formatWon(fx.usdHoldingsKrwChange!, { sign: true })} = 가격 효과 {formatWon(fx.priceEffect!, { sign: true })} + 환율 효과 {formatWon(fx.fxEffect!, { sign: true })}. 환율 효과는 원/달러 전일 대비 변동으로 계산하며, 당일 손익(앱 잔고 화면과 같은 기준)에는 넣지 않습니다.
            </Muted>
          </View>
        </>
      ) : (
        <Muted>{fx.reason ?? "환율 효과를 계산하지 못했습니다"}</Muted>
      )}
    </Card>
  );
}

/** 오늘 일정: 한국·미국 장 운영과 브리핑을 만든 때의 장 상태, 보유 국내 종목의 최근 공시 */
function ScheduleCard({ s, asOf, footer = null }: { s: AccountSchedule; asOf: string; footer?: React.ReactNode }) {
  const t = useTheme();
  const at = briefingTime(asOf);
  return (
    <Card>
      <SectionTitle>오늘 일정</SectionTitle>
      <Info label="한국" value={s.kr.tradingDay ? (s.kr.hours ?? "거래일") : `휴장${s.kr.nextOpen ? ` · 다음 개장 ${formatDateKo(s.kr.nextOpen, true)}` : ""}`} note={s.kr.now} at={at} />
      <Info label="미국" value={s.us.tradingDay ? `${localDay(s.us.date)} ${s.us.hours ?? ""}` : `${localDay(s.us.date)} 휴장`} note={s.us.now} at={at} />
      <Text style={{ color: t.muted, fontSize: font.small, marginTop: space.xs }}>최근 공시 (보유 국내 종목, 3일)</Text>
      {s.disclosures.length ? (
        s.disclosures.map((x) =>
          x.url ? (
            <Pressable
              key={`${x.code}-${x.title}-${x.filedAt}`}
              onPress={() => void Linking.openURL(x.url!)}
              accessibilityRole="link"
              accessibilityLabel={sentence([x.name, "공시", x.title, formatDateKo(x.filedAt), "DART 에서 열기"])}
              style={({ pressed }) => [styles.disclosure, { backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
            >
              <DisclosureText name={x.name} title={x.title} filedAt={x.filedAt} link />
            </Pressable>
          ) : (
            <View key={`${x.code}-${x.title}-${x.filedAt}`} style={styles.disclosure}>
              <DisclosureText name={x.name} title={x.title} filedAt={x.filedAt} link={false} />
            </View>
          ),
        )
      ) : (
        <Muted>없음 (종목 브리핑이 받아 둔 공시 기준)</Muted>
      )}
      {/* 3-38 (플래그 holdingSchedule): '다가오는 일정' 카드가 없을 때만 '일정·공시 모두 보기' */}
      {footer}
    </Card>
  );
}

/**
 * 브리핑 3차 5 (플래그 holdingEvents): '다가오는 일정' + '보유 종목 · 30일 안' 카드 — '오늘 일정' 바로 아래(넓은 창은 오른쪽 칸).
 * 서버가 계좌 브리핑을 만들 때 받아 둔 일정 그대로: 날짜 순 줄(8개까지, '외 N건') '9/30(수) · 리얼티인컴 배당락일 (미국 날짜) · 주당 $0.2715' ·
 * '10/29(목) 오전 5시 이후 · 마이크로소프트 실적 발표 (예정)'(실적 발표일을 넣었을 때만), 없으면 한 줄, 작은 글(뜻·받지 못한 것·국내 배당), 기준 시각·출처.
 * 누르는 곳 없음. 색 없음(등락이 아님). 좁은 칸·큰 글씨는 ' · ' 묶음째 줄바꿈. 화면 읽기는 제목 묶음·줄마다·기준 한 문장씩
 */
export function UpcomingCard({ e, notes = [], footer = null }: { e: AccountEvents; notes?: readonly string[]; footer?: React.ReactNode }) {
  const t = useTheme();
  const chunkRow = useChunkRow();
  const view = eventsView(e);
  // 3-38 '일정·공시' 화면이 덧붙이는 작은 글 (미국 실적은 공시로 보인다는 글) — 없으면 지금 그대로
  const v = notes.length ? { ...view, notes: [...view.notes, ...notes] } : view;
  // 묶음 끝 ' ·' 의 공백은 줄바꿈 없는 공백 — '·' 하나만 다음 줄 맨 앞에 남지 않게 (비중 두 줄과 같은 규칙)
  const joined = (parts: string[]) => parts.map((p, i) => (i < parts.length - 1 ? `${p} ·` : p));
  return (
    <Card>
      <View accessible accessibilityLabel={v.headSpeech} style={styles.upcomingHead}>
        <SectionTitle>{v.title}</SectionTitle>
        <Muted>{v.sub}</Muted>
        {v.empty ? <Muted style={styles.upcomingEmpty}>{v.empty}</Muted> : null}
      </View>
      {v.lines.map((l) => (
        <View key={l.key} accessible accessibilityLabel={l.speech} style={[styles.upcomingRow, { borderBottomColor: t.line }]}>
          <View style={chunkRow}>
            {joined(l.parts).map((p, i) => (
              <Text key={i} style={[styles.num, { color: i === 0 ? t.sub : t.ink, fontSize: font.body, fontWeight: i === 0 ? "600" : "400" }]}>
                {p}
              </Text>
            ))}
          </View>
        </View>
      ))}
      {v.more > 0 ? <Muted>외 {v.more}건</Muted> : null}
      {v.notes.map((n) => (
        <Muted key={n} style={{ fontSize: font.tiny }}>
          {n}
        </Muted>
      ))}
      <View accessible accessibilityLabel={v.basisSpeech}>
        <Muted style={{ fontSize: font.tiny }}>{v.basis}</Muted>
      </View>
      {/* 3-38 (플래그 holdingSchedule): 기준 줄 바로 아래 '일정·공시 모두 보기' */}
      {footer}
    </Card>
  );
}

function DisclosureText({ name, title, filedAt, link }: { name: string; title: string; filedAt: string; link: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, gap: space.xxs }}>
      <Text style={{ color: link ? t.accent : t.ink, fontSize: font.body }}>{title}</Text>
      <Muted>
        {name} · {formatDateKo(filedAt)}
      </Muted>
    </View>
  );
}

/** 이름 — 값 한 줄 (값이 길면 다음 줄로). 화면 읽기는 speech 한 문장 */
function Line({ label, speech, children }: { label: string; speech: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View accessible accessibilityLabel={speech} style={[styles.line, { borderBottomColor: t.line }]}>
      <Text style={{ color: t.muted, fontSize: font.small, flexShrink: 0 }}>{label}</Text>
      <View style={styles.lineRight}>{children}</View>
    </View>
  );
}

/** 이름 위, 값·설명 아래 (긴 문장용). 설명(장 상태)은 브리핑을 만든 시각 기준임을 밝힌다 */
function Info({ label, value, note, at }: { label: string; value: string; note: string; at: string }) {
  const t = useTheme();
  const basis = at ? `브리핑 시각(${at}) 기준` : "브리핑 시각 기준";
  const spoken = at ? `브리핑 시각 ${at} 기준` : "브리핑 시각 기준";
  return (
    <View accessible accessibilityLabel={sentence([label, value, `${spoken} ${note}`])} style={[styles.info, { borderBottomColor: t.line }]}>
      <Text style={{ color: t.muted, fontSize: font.small }}>{label}</Text>
      <Text style={{ color: t.ink, fontSize: font.body }}>{value}</Text>
      <Muted>
        {basis}: {note}
      </Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xxs, paddingHorizontal: space.lg, paddingTop: space.md },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
  total: { fontSize: font.hero, fontWeight: "700", fontVariant: ["tabular-nums"] },
  kpis: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  kpi: { flexGrow: 1, flexBasis: 140, gap: space.xxs },
  kpiValue: { fontSize: font.h2, fontWeight: "700", fontVariant: ["tabular-nums"] },
  band: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xl, rowGap: space.sm, alignItems: "flex-start" },
  bandItem: { flexShrink: 0, gap: space.xxs },
  bandValue: { fontWeight: "700", fontVariant: ["tabular-nums"] },
  num: { fontVariant: ["tabular-nums"] },
  cardHead: { paddingHorizontal: space.lg, paddingTop: space.lg },
  cardFoot: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  th: { fontSize: font.small },
  tr: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  colName: { flex: 1 },
  colAmount: { flexBasis: 120, flexShrink: 1, textAlign: "right" },
  colRate: { flexBasis: 64, flexShrink: 0, textAlign: "right" },
  line: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: space.sm, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  lineRight: { flexShrink: 1, marginLeft: "auto" },
  lineValue: { fontSize: font.small, fontWeight: "600", textAlign: "right" },
  info: { gap: space.xxs, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  disclosure: { minHeight: touch.min, flexDirection: "row", alignItems: "center", paddingVertical: space.xs },
  basis: { paddingHorizontal: space.lg, fontSize: font.tiny },
  chunks: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs },
  // 3-32 '시세 기준' 줄: 묶음째 줄바꿈 (조각 끝의 이음표·줄바꿈 없는 공백이 간격 — 한 줄이면 한 글과 같은 모양)
  quoteBasis: { flexDirection: "row", flexWrap: "wrap" },
  // 브리핑 3차 3 '지난 브리핑과 비교' 카드
  sinceHead: { gap: space.xs },
  sinceRow: { gap: space.xxs, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  sinceLine: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", columnGap: space.sm },
  sinceValue: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right" },
  sinceGroup: { gap: space.xxs, paddingTop: space.xs },
  // 브리핑 3차 4 비중 두 줄 (총 평가 카드 안, 가는 줄로 위와 나눔)
  exposure: { gap: space.xxs, paddingTop: space.s, borderTopWidth: StyleSheet.hairlineWidth },
  // 브리핑 3차 5 다가오는 일정 카드
  upcomingHead: { gap: space.xxs },
  upcomingEmpty: { marginTop: space.xs },
  upcomingRow: { paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
});
