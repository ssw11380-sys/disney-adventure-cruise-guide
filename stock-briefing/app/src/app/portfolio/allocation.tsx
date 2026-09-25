import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFeature, useStocks } from "@/api/hooks";
import { AllocationCard } from "@/components/AllocationCard";
import { usePull } from "@/components/Freshness";
import { Screen } from "@/components/Screen";
import { Empty, ErrorView, Loading } from "@/components/ui";
import { sentence, speakAmount } from "@/lib/a11y";
import { allocation, excludedNote } from "@/lib/allocation";
import { formatQuote, formatWon } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { useSettings } from "@/lib/settings";
import { font, space, useTheme } from "@/theme";

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
  return (
    <Screen refreshing={pulling} onRefresh={onPull} disclaimer>
      <View
        accessible
        accessibilityLabel={sentence([`${heading} ${speakAmount(formatWon(a.total))}`, afterCost ? "비용 차감" : null, `${a.count}종목 기준`, note])}
        style={[styles.summary, { backgroundColor: t.surface, borderColor: t.line }]}
      >
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
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
