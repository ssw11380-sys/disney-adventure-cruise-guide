import { router } from "expo-router";
import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useAccountBriefing, useFeature, useFeatures } from "@/api/hooks";
import type { AccountBriefingWithData, AccountData, AccountSchedule } from "@/api/types";
import { BriefingSplit, type BodyLayout } from "@/components/BriefingBody";
import { StaleBanner } from "@/components/Freshness";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { CardsSkeleton } from "@/components/Skeleton";
import { Badge, Button, Card, ChangeText, Empty, ErrorView, Muted, SectionTitle, TableHead } from "@/components/ui";
import { sentence, speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { briefingTime, contributionSpeech, contributionTable, fxEquationSpeech, localDay, summarySpeech, templateNote } from "@/lib/accountBriefing";
import { gated } from "@/lib/features";
import { formatDateKo, formatIndexValue, formatPct, formatWon, SESSION_LABEL, shownSign } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { changeColor, font, fontCap, space, touch, useTheme } from "@/theme";

/**
 * 계좌 한 장 브리핑 본문 (3-31, 3-42 웨이브 D1: app/briefings/account/[id].tsx 에서 떼어냄): 오늘 내 계좌가 왜 움직였는지 한 화면에.
 * 요약 → 총 평가·당일 손익 → 당일 손익 기여(상위 + 그 외 = 당일 손익) → 지수·환율 영향(환율 효과 따로) → 오늘 일정 → 설명(모델 또는 기본 문장) → 기준·고지.
 * 숫자는 모두 서버가 계산한 값 그대로다. 플래그 accountBriefing 이 꺼져 있으면 아무것도 불러오지 않는다.
 * 배치 (components/BriefingBody 와 같은 이름):
 *  - stack: 지금 폰 화면 그대로 / pane: 브리핑 탭 2단의 오른쪽 칸 (쌓는 순서는 같고 화면 머리 제목만 바꾸지 않는다)
 *  - split: 넓은 창 전체 화면 두 칸 — 왼쪽 요약·총 평가·기여 표 | 오른쪽 지수·환율·오늘 일정·설명
 */
export function AccountBriefingBody({ numId, layout, title }: { numId: number | null; layout: BodyLayout; title?: (b: AccountBriefingWithData) => React.ReactNode }) {
  const on = useFeature("accountBriefing", false); // 새 기능: 서버가 켤 때만
  const flags = useFeatures();
  const q = useAccountBriefing(numId ?? 0, on && numId !== null);
  const data = gated(on, q.data);

  if (numId === null) return <Screen><ErrorView error={new Error("계좌 브리핑 주소가 올바르지 않습니다")} retryLabel="브리핑 목록으로" onRetry={() => router.dismissTo("/briefings")} /></Screen>;
  if (!on) {
    // 플래그를 아직 못 받았으면(알림으로 막 켠 경우) 잠깐 기다린다
    if (flags.data === undefined && flags.isFetching) return <Screen><CardsSkeleton count={2} /></Screen>;
    // 플래그를 받지 못함(끊김·서버 오류·오프라인으로 멈춤): '꺼져 있다'고 하지 않고 연결을 확인하게
    if (flags.data === undefined) {
      return (
        <Screen>
          <Empty
            title="계좌 브리핑을 불러오지 못했습니다"
            hint="연결을 확인해 주세요. 인터넷이 연결되면 다시 시도할 수 있습니다."
            action={<Button title="다시 시도" variant="secondary" compact onPress={() => void flags.refetch()} />}
          />
        </Screen>
      );
    }
    return (
      <Screen>
        <Empty title="계좌 브리핑을 볼 수 없습니다" hint="지금은 계좌 브리핑이 꺼져 있습니다. 종목별 브리핑은 브리핑 탭에 있습니다." action={<Button title="브리핑 탭으로" variant="secondary" compact onPress={() => router.dismissTo("/briefings")} />} />
      </Screen>
    );
  }
  const view = viewState(q);
  if (view === "error") return <Screen><ErrorView error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  if (view === "loading" || !data) return <Screen><CardsSkeleton count={3} /></Screen>;
  // 2단 오른쪽 칸은 끊김·지연 띠를 탭 위쪽에 한 번만 둔다
  return <AccountBriefingView b={data} top={layout === "pane" ? null : <StaleBanner query={q} />} layout={layout} title={title} />;
}

function AccountBriefingView({ b, top, layout, title }: { b: AccountBriefingWithData; top: React.ReactNode; layout: BodyLayout; title?: (b: AccountBriefingWithData) => React.ReactNode }) {
  const t = useTheme();
  const d = b.data;
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
        {!failed && b.template ? <Badge>숫자로 만든 기본 설명</Badge> : null}
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
      <View accessible accessibilityLabel={summarySpeech(d)}>
        {b.summary.split("\n").map((line, i) => (
          <Text key={i} style={{ color: t.ink, fontSize: font.body, lineHeight: font.body * 1.6 }}>
            {line}
          </Text>
        ))}
      </View>
    </Card>
  ) : null;
  const narrative = (
    <Card>
      <SectionTitle right={b.template ? <Badge>기본 설명</Badge> : null}>무엇이 계좌를 움직였나</SectionTitle>
      <MarkdownView>{b.detail}</MarkdownView>
      <Muted style={{ fontSize: font.tiny }}>
        {/* 자세한 이유(모델이 지어낸 숫자·오류 문구)는 화면에 옮기지 않는다 — 틀린 숫자를 실제 값으로 읽지 않게 */}
        {b.template && d ? templateNote(d.narrative.reason) : "모델이 위 숫자만 옮겨 쓴 설명입니다. 입력에 없는 숫자나 매매·전망 표현이 나오면 기본 설명으로 바꿉니다."}
      </Muted>
    </Card>
  );
  const basis = d ? (
    <Muted style={styles.basis}>
      기준: {d.basis} · {formatDateKo(d.asOf, true)} 계산
    </Muted>
  ) : null;

  if (layout === "split" && !failed && d) {
    // 넓은 창 전체 화면: 왼쪽 요약·수치·기여 표 | 오른쪽 지수·환율·오늘 일정·설명
    return (
      <Screen scroll={false} disclaimer top={top}>
        {title?.(b)}
        <BriefingSplit
          left={
            <>
              {header}
              {summary}
              <TotalsBand d={d} />
              <ContributionCard d={d} />
            </>
          }
          right={
            <>
              <ImpactCard d={d} />
              <ScheduleCard s={d.schedule} asOf={d.asOf} />
              {narrative}
              {basis}
            </>
          }
        />
      </Screen>
    );
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
          {layout === "pane" ? <TotalsBand d={d} /> : <TotalsCard d={d} />}
          <ContributionCard d={d} />
          <ImpactCard d={d} />
          <ScheduleCard s={d.schedule} asOf={d.asOf} />
          {narrative}
          {basis}
        </>
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

function TotalsCard({ d }: { d: AccountData }) {
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
      {d.excluded.length ? <Muted>합계에서 뺀 종목: {d.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}</Muted> : null}
    </Card>
  );
}

/**
 * 넓은 창 두 칸의 총 평가 띠 (3-42): 총 평가금액 | 당일 손익 | 평가손익 을 한 줄에 (폭이 모자라면 다음 줄로, 숫자는 줄이지 않음).
 * 폰 카드(TotalsCard)의 큰 숫자 한 칸 + 두 칸 대신 한 줄에 놓아 기여 표가 첫 화면에 들어오게 한다. 화면 읽기 문장은 카드와 같다
 */
function TotalsBand({ d }: { d: AccountData }) {
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
      {d.excluded.length ? <Muted>합계에서 뺀 종목: {d.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}</Muted> : null}
    </Card>
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

/** 당일 손익 기여: 상위 종목 + 그 외 = 당일 손익 */
function ContributionCard({ d }: { d: AccountData }) {
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
        <Text style={[styles.colName, { color: t.ink, fontSize: font.body, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
          합계 (= 당일 손익)
        </Text>
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
        {d.krPreviousDay ? " 오늘 한국은 휴장이라 국내 종목은 직전 거래일 등락입니다(앱 잔고 화면과 같은 기준)." : ""}
        {d.usPreviousDay ? " 지난밤 미국은 휴장이라 미국 종목은 직전 거래일 등락입니다(앞 브리핑에 이미 담긴 움직임)." : ""}
      </Muted>
    </Card>
  );
}

/** 지수·환율 영향: 지수 4개, 국내·미국 보유분, 원/달러와 환율 효과 */
function ImpactCard({ d }: { d: AccountData }) {
  const fx = d.fx;
  const bucket = (label: string, b: AccountData["markets"]["kr"]) =>
    b ? (
      <Line key={label} label={`${label} 보유분 ${b.count}종목`} speech={sentence([`${label} 보유분 당일`, speakProfit(formatWon(b.day, { sign: true }), Math.sign(b.day)), speakRate(b.dayRate)])}>
        <ChangeText value={b.day} text={`${formatWon(b.day, { sign: true })}${b.dayRate !== null ? ` (${formatPct(b.dayRate)})` : ""}`} style={styles.lineValue} />
      </Line>
    ) : null;
  return (
    <Card>
      <SectionTitle>지수·환율 영향</SectionTitle>
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
function ScheduleCard({ s, asOf }: { s: AccountSchedule; asOf: string }) {
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
});
