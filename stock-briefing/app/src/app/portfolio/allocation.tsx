import React, { useMemo } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFeature, useStocks } from "@/api/hooks";
import { AllocationCard } from "@/components/AllocationCard";
import { usePull } from "@/components/Freshness";
import { Screen } from "@/components/Screen";
import { Empty, ErrorView, Loading } from "@/components/ui";
import { sentence, speakAmount } from "@/lib/a11y";
import { allocation, excludedNote } from "@/lib/allocation";
import { allocationGrid, allocationStep, FOLD_COL_GAP, type AllocationStep } from "@/lib/foldScreens";
import { formatQuote, formatWon } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { useSettings } from "@/lib/settings";
import { clampScale } from "@/lib/textScale";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { useSticky } from "@/lib/useSticky";
import { isWide } from "@/lib/windowClass";
import { font, space, useTheme } from "@/theme";
import { foldScreens } from "@/tokens";

/**
 * 비중 보기 (플래그 allocationView, 잔고 탭 계좌 평가의 '비중' 버튼): 국내·해외 / 통화 / 업종 / 종목별 원 차트와 범례 표.
 * 금액은 잔고 탭 총 평가금액과 같은 기준(비용 차감 설정·환율)이고, 사실만 보여 준다 — 판단·권유 문구는 넣지 않는다.
 * 플래그가 꺼져 있으면 잔고를 받지도 계산하지도 않는다 (화면 작업 0건).
 */
export default function AllocationScreen() {
  const on = useFeature("allocationView", false);
  if (!on)
    return (
      <Screen>
        <Empty title="지금은 비중 보기를 쓸 수 없습니다" hint="잔고 탭에서 계좌 평가를 확인할 수 있습니다." />
      </Screen>
    );
  return <AllocationBody />;
}

function AllocationBody() {
  const t = useTheme();
  const stocks = useStocks();
  const { afterCost } = useSettings();
  const { pulling, onPull } = usePull(stocks.refetch);
  const a = useMemo(() => allocation(stocks.data ?? [], afterCost), [stocks.data, afterCost]);
  // 넓은 창(3-42, 플래그 foldLayout + 폭 600 이상): 카드 4장을 2×2 격자로, 원 옆에 범례 → 4장이 한 화면에. 좁은 창은 지금 그대로.
  // 범례 이름 칸을 먼저 확보한다: 칸이 넉넉하면 한 줄 범례, 좁으면 평가금액을 이름 아래로 내린 두 줄 범례 (lib/foldScreens allocationStep)
  const fold = useFoldLayout();
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = fold.on && isWide(fold);
  const room = useMemo(() => {
    const rows = [a.charts.slice(0, 2), a.charts.slice(2, 4)].filter((r) => r.length).map((r) => Math.max(...r.map((c) => c.slices.length)));
    // 격자가 쓸 높이 = 창 − 시스템 막대(위·아래) − 화면 머리·요약·고지 어림 (글자가 크면 그만큼 크게 잡는다)
    return { height: height - insets.top - Math.max(insets.bottom, space.sm) - Math.round(foldScreens.allocChromeH * clampScale(fontScale)), rows };
  }, [a.charts, height, insets.top, insets.bottom, fontScale]);
  // 배치 단계(원 아래 / 원 옆 두 줄 / 원 옆 한 줄) 기준선 근처에서는 바로 전 배치를 지킨다 (히스테리시스).
  // 좁은 창이거나 아직 그릴 차트가 없으면(잔고를 받는 중) 바로 전 배치를 지운다(null) — 접은 화면에서 펴거나 잔고가 늦게 와도
  // 처음부터 잔고를 가진 채 연 것과 같은 배치 (받기 전 '범례 없음' 높이로 고른 단계가 남지 않게)
  const step = useSticky(wide && a.charts.length ? width : null, (w) => allocationStep(w, fontScale, room));
  const grid = wide && step !== null ? allocationGrid(width, fontScale, room, step as AllocationStep) : null;

  const view = viewState(stocks);
  if (view === "loading")
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  if (view === "error")
    return (
      <Screen>
        <ErrorView error={stocks.error} onRetry={() => void stocks.refetch()} />
      </Screen>
    );

  const note = excludedNote(a.excluded);
  if (a.count === 0)
    return (
      <Screen refreshing={pulling} onRefresh={onPull}>
        <Empty title="보유 종목이 없습니다" hint={note ?? "수량과 평균 단가를 입력한 종목이 있으면 비중을 보여 줍니다."} />
      </Screen>
    );

  const heading = `총 평가금액${a.krwOnly ? " (원화 종목)" : ""}`;
  const summaryLabel = sentence([`${heading} ${speakAmount(formatWon(a.total))}`, afterCost ? "비용 차감" : null, `${a.count}종목 기준`, note]);
  if (grid) {
    const cardWide = { donut: grid.donut, beside: grid.beside, legend: grid.legend, dense: grid.dense };
    // 두 장씩 한 줄 (같은 줄 두 카드는 높이를 맞춘다). 화면 읽기 순서: 요약 → 국내/해외 → 통화 → 업종 → 종목별
    const rows = [a.charts.slice(0, 2), a.charts.slice(2, 4)].filter((r) => r.length);
    return (
      <Screen refreshing={pulling} onRefresh={onPull} disclaimer>
        {/* 요약 한 줄: 왼쪽 "총 평가금액  71,445,875 원", 오른쪽 설명 (카드 격자에 높이를 넘긴다).
            큰 글씨로 한 줄에 안 들어가면 설명이 다음 줄로, 그래도 모자라면 총액이 이름 아래 줄로 내려간다 — 총액은 말줄임 없이 */}
        <View accessible accessibilityLabel={summaryLabel} style={[styles.summaryWide, { backgroundColor: t.surface, borderColor: t.line }]}>
          <View style={styles.summaryTotal}>
            <Text style={{ color: t.muted, fontSize: font.small }}>
              {heading}
              {afterCost ? " · 비용 차감" : ""}
            </Text>
            <Text style={[styles.total, styles.totalWide, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
              {formatQuote(a.total, "KRW")}
              <Text style={{ fontSize: font.body, color: t.muted, fontWeight: "500" }}> 원</Text>
            </Text>
          </View>
          <View style={styles.summaryNote}>
            <Text style={{ color: t.muted, fontSize: font.small }}>
              보유 {a.count}종목의 원화 평가금액으로 나눈 비중입니다. 잔고 탭 총 평가금액과 같은 기준입니다.
            </Text>
            {note ? <Text style={{ color: t.warn, fontSize: font.small }}>{note}</Text> : null}
          </View>
        </View>
        {rows.map((row) => (
          <View key={row.map((c) => c.kind).join("|")} style={styles.gridRow}>
            {row.map((c) => (
              <View key={c.kind} style={styles.gridCell}>
                <AllocationCard chart={c} wide={cardWide} />
              </View>
            ))}
          </View>
        ))}
      </Screen>
    );
  }
  return (
    <Screen refreshing={pulling} onRefresh={onPull} disclaimer>
      <View accessible accessibilityLabel={summaryLabel} style={[styles.summary, { backgroundColor: t.surface, borderColor: t.line }]}>
        <Text style={{ color: t.muted, fontSize: font.small }}>
          {heading}
          {afterCost ? " · 비용 차감" : ""}
        </Text>
        <Text style={[styles.total, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {formatQuote(a.total, "KRW")}
          <Text style={{ fontSize: font.body, color: t.muted, fontWeight: "500" }}> 원</Text>
        </Text>
        <Text style={{ color: t.muted, fontSize: font.small }}>
          보유 {a.count}종목의 원화 평가금액으로 나눈 비중입니다. 잔고 탭 총 평가금액과 같은 기준입니다.
        </Text>
        {note ? <Text style={{ color: t.warn, fontSize: font.small }}>{note}</Text> : null}
      </View>
      {a.charts.map((c) => (
        <AllocationCard key={c.kind} chart={c} />
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  total: { fontSize: font.hero, fontWeight: "800", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  // 넓은 창 (3-42): [이름 · 총액] [설명]. 넘치면 줄을 바꾼다 (총액 칸은 제 폭 그대로 — 예전 55% 상한은 글자 200% 에서 총액을 '71,445,8…' 로 잘랐다)
  summaryWide: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.xl,
    rowGap: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  // 이름과 총액을 한 줄에 (글자 아래선 맞춤). 둘이 한 줄에 안 들어가면 총액이 다음 줄로
  summaryTotal: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm, maxWidth: "100%" },
  // 총액 혼자서도 줄 폭을 넘으면(아주 큰 글씨) 글자를 줄인다 (말줄임 없이)
  totalWide: { flexShrink: 1 },
  // 설명: 적어도 allocNoteMin 폭은 받고, 총액 옆에 그만큼 안 남으면 다음 줄로
  summaryNote: { flexGrow: 1, flexBasis: foldScreens.allocNoteMin, minWidth: 0, gap: space.xxs },
  gridRow: { flexDirection: "row", gap: FOLD_COL_GAP },
  gridCell: { flex: 1, minWidth: 0 },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
