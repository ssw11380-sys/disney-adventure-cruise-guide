import { router } from "expo-router";
import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBriefing, useBriefings, useFeature, useStockMutations } from "@/api/hooks";
import type { BriefingWithData } from "@/api/types";
import { Pills } from "@/components/BriefingList";
import { BriefingSources } from "@/components/BriefingSources";
import { StaleBanner } from "@/components/Freshness";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { CardsSkeleton } from "@/components/Skeleton";
import { Badge, Button, Card, ChangeText, ErrorView, Muted, Row, SectionTitle, Segmented } from "@/components/ui";
import { sentence, speakAmount, speakMove, speakProfit, speakRate } from "@/lib/a11y";
import { createdTimeSameDay } from "@/lib/briefingPick";
import { estimateText } from "@/lib/briefingRun";
import { afterMarketLabel, formatDateKo, formatPct, formatPrice, SESSION_LABEL, shownSign } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { changeColor, font, fontCap, slopFor, space, touch, useTheme } from "@/theme";
import { foldBriefings as FB, layout as L } from "@/tokens";

/**
 * 종목 브리핑 본문 (3-42 웨이브 D1: app/briefings/[id].tsx 에서 떼어냄). 배치는 부르는 쪽이 정한다.
 *  - stack: 전체 화면 한 줄 쌓기 = 지금 폰 화면 그대로 (접은 화면·플래그 꺼짐)
 *  - split: 넓은 창 전체 화면 두 칸 — 왼쪽 가격·근거·지난 브리핑 | 오른쪽 요약/상세 본문 (칸마다 따로 스크롤)
 *  - pane: 브리핑 탭 2단의 오른쪽 칸 — 머리(이름·시각·종목 보기·숫자 3칸) → 요약|상세 → 본문 → 근거 → 지난 브리핑
 * 지난 브리핑·다시 만들기 결과를 누르면: onPick 이 있으면(2단 오른쪽) 그 칸만 바꾸고, 없으면 지금처럼 주소를 바꿔 끼운다(router.replace).
 * 고지 한 줄은 어느 배치에서나 아래에 붙는다
 */
export type BodyLayout = "stack" | "split" | "pane";

export function BriefingBody({
  id,
  layout,
  onPick,
  title,
  side = FB.sideW,
}: {
  id: number;
  layout: BodyLayout;
  /** 다른 브리핑을 열 때 (2단 오른쪽 칸). 없으면 주소를 바꿔 끼운다 */
  onPick?: (id: number) => void;
  /** 전체 화면일 때 머리 제목 (Stack.Screen) — 2단 오른쪽 칸은 탭 머리를 바꾸지 않으므로 넘기지 않는다 */
  title?: (d: BriefingWithData) => React.ReactNode;
  /** split 왼쪽 칸 폭 */
  side?: number;
}) {
  const t = useTheme();
  const b = useBriefing(id);
  const [mode, setMode] = useState<"summary" | "detail">("detail");
  const history = useBriefings({ code: b.data?.code, limit: 30 }, !!b.data?.code);
  const sourcesOn = useFeature("briefingSources", true); // 이미 나간 기능(3-12)
  const { run } = useStockMutations();
  const regenOn = useFeature("briefingManualRun", false); // 새 기능(3-19): 서버가 켤 때만

  const view = viewState(b);
  if (view === "loading") return <Screen><CardsSkeleton count={2} /></Screen>;
  if (view === "error") return <Screen><ErrorView error={b.error} onRetry={() => void b.refetch()} /></Screen>;
  const d = b.data!;
  const q = d.data?.quote ?? null;
  const failed = d.status === "failed";
  const open = (next: number) => (onPick ? onPick(next) : router.replace(`/briefings/${next}`));

  const regen = regenOn ? (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xs }}>
      <Button
        title={`이 종목 오늘 ${d.session === "morning" ? "오전" : "오후"} 브리핑 다시 만들기`}
        variant="secondary"
        icon="refresh"
        loading={run.isPending}
        disabled={run.isPending}
        onPress={() =>
          Alert.alert("이 종목만 다시 만들기", `${d.name ?? d.code} 오늘 ${d.session === "morning" ? "오전" : "오후"} 브리핑을 새로 만들어 덮어씁니다 (${estimateText(1)}).`, [
            { text: "취소", style: "cancel" },
            {
              text: "만들기",
              onPress: () =>
                run.mutate(
                  { session: d.session, codes: [d.code], force: true },
                  {
                    onSuccess: (r) => {
                      const res = r.results[0];
                      if (res?.status === "ok" && res.briefingId) open(res.briefingId);
                      else Alert.alert("다시 만들기 실패", res?.error ?? "결과가 없습니다");
                    },
                    onError: (e) => Alert.alert("다시 만들기 실패", e instanceof Error ? e.message : String(e)),
                  },
                ),
            },
          ])
        }
      />
      <Muted style={{ fontSize: font.tiny }}>전체 종목은 브리핑 탭 아래 “수동 생성”에서</Muted>
    </View>
  ) : null;

  const past =
    history.data && history.data.length > 1 ? (
      <View>
        <SectionTitle style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>지난 브리핑</SectionTitle>
        <View>
          {history.data
            .filter((h) => h.id !== d.id)
            .map((h) => (
              <Pressable
                key={h.id}
                onPress={() => open(h.id)}
                accessibilityRole="link"
                accessibilityLabel={`${formatDateKo(h.date)} ${SESSION_LABEL[h.session]} 브리핑, ${h.status === "failed" ? "생성 실패" : h.summary.split("\n")[0]}`}
                style={({ pressed }) => [styles.historyRow, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.line }]}>
                <Text style={{ color: t.ink, fontSize: font.small }}>
                  {formatDateKo(h.date)} {SESSION_LABEL[h.session]}
                </Text>
                <Muted numberOfLines={1} style={{ flex: 1, marginLeft: space.md }}>
                  {h.status === "failed" ? "생성 실패" : h.summary.split("\n")[0]}
                </Muted>
              </Pressable>
            ))}
        </View>
      </View>
    ) : null;

  const sources = sourcesOn ? <BriefingSources data={d.data} /> : null;
  const failedCard = (
    <Card>
      <Text style={{ color: t.danger }}>{d.error ?? d.summary}</Text>
    </Card>
  );
  const text =
    mode === "summary" ? (
      d.summary.split("\n").map((line, i) => (
        <Text key={i} style={{ color: t.ink, fontSize: font.body, lineHeight: 23 }}>
          {line}
        </Text>
      ))
    ) : (
      <MarkdownView>{d.detail}</MarkdownView>
    );
  const missing = d.missing.length ? <Muted>데이터 미확인: {d.missing.join(", ")}</Muted> : null;

  if (layout === "stack") {
    // 지금 폰 화면 그대로 (접은 화면·플래그 꺼짐) — 순서·모양을 바꾸지 않는다
    return (
      <Screen disclaimer top={<StaleBanner query={b} />}>
        {title?.(d)}
        <View style={{ gap: space.xxs, paddingHorizontal: space.lg, paddingTop: space.md }}>
          <Pressable onPress={() => router.push(`/stocks/${d.code}`)} accessibilityRole="link" accessibilityLabel={`${d.name ?? d.code} 종목 화면으로`} hitSlop={slopFor(font.title * 1.35)}>
            <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "700" }}>{d.name ?? d.code}</Text>
          </Pressable>
          <Muted>
            {formatDateKo(d.date)} {SESSION_LABEL[d.session]} 브리핑 · {formatDateKo(d.createdAt, true)} 생성
          </Muted>
          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
            {failed ? <Badge tone="bad">생성 실패</Badge> : null}
            {d.missing.length ? <Badge tone="warn">미확인 {d.missing.length}건</Badge> : null}
          </View>
        </View>

        {q ? (
          <Card>
            <Row label="브리핑 시점 가격" value={formatPrice(q.price, q.currency)} />
            <Row label="전일 대비" value={<ChangeText value={q.change} text={`${formatPrice(q.change, q.currency, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.small }} />} />
            {q.afterMarket ? <Row label={`${afterMarketLabel(q.afterMarket)} 가격`} value={<ChangeText value={q.afterMarket.change} text={`${formatPrice(q.afterMarket.price, q.currency)} (${formatPct(q.afterMarket.changeRate)})`} style={{ fontSize: font.small }} />} /> : null}
            {d.data?.holding ? <Row label="보유 손익" value={<ChangeText value={d.data.holding.profit} text={`${formatPrice(d.data.holding.profit, q.currency, { sign: true })} (${formatPct(d.data.holding.profitRate)})`} style={{ fontSize: font.small }} />} /> : null}
          </Card>
        ) : null}

        {failed ? (
          failedCard
        ) : (
          <>
            <Segmented
              options={[
                { value: "summary", label: "요약" },
                { value: "detail", label: "상세" },
              ]}
              value={mode}
              onChange={setMode}
            />
            <Card>
              {text}
              {missing}
            </Card>
          </>
        )}

        {sources}

        {/* 이 종목만 다시 만들기 (3-19): 전체를 다시 만들지 않고 약 30초 */}
        {regen}

        {past}
      </Screen>
    );
  }

  const toolbar = failed ? null : (
    <View style={[styles.tool, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      <Pills
        label="브리핑 보기"
        options={[
          { value: "summary", label: "요약" },
          { value: "detail", label: "상세" },
        ]}
        value={mode}
        onChange={setMode}
      />
      <SourceCount d={d} on={sourcesOn} />
    </View>
  );
  const bodyText = failed ? failedCard : (
    <View style={styles.text}>
      {text}
      {missing}
    </View>
  );

  if (layout === "split") {
    // 넓은 창 전체 화면 (알림·위젯·종목 상세에서 연 브리핑): 왼쪽 가격·근거·지난 브리핑 | 오른쪽 본문
    return (
      <Screen scroll={false} disclaimer top={<StaleBanner query={b} />}>
        {title?.(d)}
        <BriefingSplit
          side={side}
          left={
            <>
              <Head d={d} />
              {sources}
              {regen}
              {past}
            </>
          }
          right={
            <>
              {toolbar}
              {bodyText}
            </>
          }
        />
      </Screen>
    );
  }

  // 브리핑 탭 2단의 오른쪽 칸 (끊김·지연 띠는 탭 위쪽에 한 번만 — 브리핑 본문은 만든 뒤 바뀌지 않는다)
  return (
    <Screen disclaimer>
      <View>
        <Head d={d} />
        {toolbar}
      </View>
      {bodyText}
      {sources}
      {regen}
      {past}
    </Screen>
  );
}

/** 근거 개수 "근거 뉴스 2 · 공시 1" (근거 기능이 꺼져 있거나 스냅샷이 없으면 없음) */
function SourceCount({ d, on }: { d: BriefingWithData; on: boolean }) {
  const t = useTheme();
  if (!on || !d.data) return null;
  const news = d.data.news === null ? null : d.data.news.length;
  const disc = d.data.disclosures?.length ?? 0;
  const text = [news === null ? null : `근거 뉴스 ${news}`, disc ? `공시 ${disc}` : null].filter(Boolean).join(" · ");
  if (!text) return null;
  return (
    <Text style={{ marginLeft: "auto", color: t.sub, fontSize: font.small, flexShrink: 1 }} maxFontSizeMultiplier={fontCap.row}>
      {text}
    </Text>
  );
}

/** 넓은 창 본문 머리: 이름 · 날짜·세션·만든 시각 · [종목 보기] / 배지 / 숫자 칸(라벨 위, 숫자 아래) */
function Head({ d }: { d: BriefingWithData }) {
  const t = useTheme();
  const failed = d.status === "failed";
  const name = d.name ?? d.code;
  const time = createdTimeSameDay(d);
  return (
    <View style={[styles.head, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      <View style={styles.headRow}>
        <Text style={[styles.headName, { color: t.ink }]} accessibilityRole="header">
          {name}
        </Text>
        <Button title="종목 보기" variant="secondary" compact onPress={() => router.push(`/stocks/${d.code}`)} accessibilityLabel={`${name} 종목 화면으로`} />
      </View>
      <Muted>
        {formatDateKo(d.date)} {SESSION_LABEL[d.session]} 브리핑 · {time ?? formatDateKo(d.createdAt, true)} 생성
      </Muted>
      {failed || d.missing.length ? (
        <View style={styles.badges}>
          {failed ? <Badge tone="bad">생성 실패</Badge> : null}
          {d.missing.length ? <Badge tone="warn">미확인 {d.missing.length}건</Badge> : null}
        </View>
      ) : null}
      <Numbers d={d} />
    </View>
  );
}

interface Kv {
  label: string;
  value: string;
  /** 값 색을 정하는 수 (없으면 기본 글자색) */
  tone?: number | null;
  sub?: { text: string; tone: number | null } | null;
  speech: string;
}

/** 브리핑 시점 숫자 칸: 가격 · 전일 대비 · (시간외) · 보유 손익. 폭이 모자라면 다음 줄로 (숫자는 줄이지 않는다) */
function Numbers({ d }: { d: BriefingWithData }) {
  const t = useTheme();
  const q = d.data?.quote;
  if (!q) return null;
  const change = formatPrice(q.change, q.currency, { sign: true });
  const items: Kv[] = [
    { label: "브리핑 시점 가격", value: formatPrice(q.price, q.currency), speech: sentence(["브리핑 시점 가격", speakAmount(formatPrice(q.price, q.currency))]) },
    {
      label: "전일 대비",
      value: change,
      tone: q.change,
      sub: { text: formatPct(q.changeRate), tone: q.changeRate },
      speech: sentence(["전일 대비", speakMove(change, shownSign(q.change, change)), speakRate(q.changeRate)]),
    },
  ];
  if (q.afterMarket) {
    const label = `${afterMarketLabel(q.afterMarket)} 가격`;
    const price = formatPrice(q.afterMarket.price, q.currency);
    items.push({ label, value: price, tone: q.afterMarket.change, sub: { text: formatPct(q.afterMarket.changeRate), tone: q.afterMarket.changeRate }, speech: sentence([label, speakAmount(price), speakRate(q.afterMarket.changeRate)]) });
  }
  const h = d.data?.holding;
  if (h) {
    const profit = formatPrice(h.profit, q.currency, { sign: true });
    items.push({ label: "보유 손익", value: profit, tone: h.profit, sub: { text: formatPct(h.profitRate), tone: h.profitRate }, speech: sentence(["보유 손익", speakProfit(profit, shownSign(h.profit, profit)), `수익률 ${speakRate(h.profitRate) ?? "없음"}`]) });
  }
  const color = (tone: number | null | undefined, text: string) => (tone === undefined ? t.ink : tone === null ? t.muted : changeColor(t, shownSign(tone, text)));
  return (
    <View style={styles.kv}>
      {items.map((i) => (
        <View key={i.label} accessible accessibilityLabel={i.speech} style={styles.kvItem}>
          <Text style={{ color: t.muted, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
            {i.label}
          </Text>
          <Text style={[styles.kvValue, { color: color(i.tone, i.value) }]} maxFontSizeMultiplier={fontCap.row}>
            {i.value}
            {i.sub ? <Text style={{ color: color(i.sub.tone, i.sub.text), fontSize: font.small }}> {i.sub.text}</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * 넓은 창 전체 화면 두 칸 (브리핑 상세·계좌 브리핑 상세). 칸마다 따로 스크롤한다.
 * side 가 있으면 왼쪽 칸 폭 고정, 없으면 반씩. 좌우 화면 여백(카메라 구멍·가로 내비게이션 바)만큼 안쪽으로.
 * 화면 읽기 순서는 왼쪽 → 오른쪽 (구분선은 건너뛴다)
 */
export function BriefingSplit({ left, right, side }: { left: React.ReactNode; right: React.ReactNode; side?: number }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.split, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <ScrollView style={side === undefined ? styles.half : { width: side, flexGrow: 0, flexShrink: 0 }} contentContainerStyle={styles.col}>
        {left}
      </ScrollView>
      <View style={[styles.divider, { width: L.divider, backgroundColor: t.line }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
      <ScrollView style={styles.half} contentContainerStyle={styles.col}>
        {right}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  historyRow: { minHeight: touch.min, flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  head: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  headRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  headName: { flex: 1, minWidth: 0, fontSize: font.title, fontWeight: "700" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  kv: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xl, rowGap: space.sm },
  kvItem: { flexShrink: 0, gap: space.xxs },
  kvValue: { fontSize: font.h2, fontWeight: "700", fontVariant: ["tabular-nums"] },
  tool: { minHeight: FB.headH, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.xs },
  split: { flex: 1, flexDirection: "row" },
  half: { flex: 1, minWidth: 0 },
  col: { paddingBottom: space.xl, gap: space.sm },
  divider: { alignSelf: "stretch" },
});
