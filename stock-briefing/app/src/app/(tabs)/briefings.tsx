import React, { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useHealth, useLatestBriefings, useMarketStatus, useStockMutations } from "@/api/hooks";
import type { BriefingSession } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { StaleBanner, useConnection, usePull } from "@/components/Freshness";
import { Screen } from "@/components/Screen";
import { Button, Card, Empty, ErrorView, Loading, Muted, SectionTitle, Segmented } from "@/components/ui";
import { formatDateKo } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { font, space, useTheme } from "@/theme";

type Mode = "line" | "summary" | "detail";

/** 브리핑 탭: 서버 상태 배너 → 종목별 최신 브리핑(한 줄/요약/상세) → 수동 실행 */
export default function BriefingsScreen() {
  const t = useTheme();
  const [mode, setMode] = useState<Mode>("summary");
  const latest = useLatestBriefings();
  const { data, error, refetch } = latest;
  const conn = useConnection(latest, Number.POSITIVE_INFINITY);
  const { pulling, onPull } = usePull(refetch);
  const { run } = useStockMutations();
  const health = useHealth();
  const market = useMarketStatus();

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
  if (view === "loading") return <Screen><Loading /></Screen>;
  if (view === "error") return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  const items = data ?? [];
  const withBriefing = items.filter((i) => i.latest);
  const last = health.data?.lastBriefing ?? null;
  const llmOff = health.data?.llmConfigured === false;
  const krHoliday = market.data && !market.data.KR.isTradingDay;

  return (
    <Screen disclaimer refreshing={pulling} onRefresh={onPull}>
      <StaleBanner conn={conn} open={false} />
      {llmOff || (last && last.failed > 0) ? (
        <Card style={{ borderLeftWidth: 3, borderLeftColor: t.danger }}>
          <Text style={{ color: t.danger, fontSize: font.body, fontWeight: "700" }}>{llmOff ? "브리핑 모델이 설정되지 않았습니다" : `최근 실행에서 ${last!.failed}개 종목이 실패했습니다`}</Text>
          <Muted>{llmOff ? "서버 변수 ANTHROPIC_API_KEY 가 비어 있습니다." : last!.lastError ?? ""}</Muted>
          {last ? <Muted>{formatDateKo(last.finishedAt, true)} · {last.session === "morning" ? "오전" : "오후"} · 성공 {last.ok} / 실패 {last.failed} / 건너뜀 {last.skipped}</Muted> : null}
        </Card>
      ) : null}
      {krHoliday ? <Muted style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>한국 휴장일 · 국내 종목 브리핑 없음{market.data?.KR.opensAt ? ` · 다음 개장 ${formatDateKo(market.data.KR.opensAt, true)}` : ""}</Muted> : null}
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
        withBriefing.map((i) => <BriefingCard key={i.code} briefing={i.latest!} mode={mode} />)
      )}
      {items.length > 0 ? (
        <Card>
          <SectionTitle>수동 생성</SectionTitle>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="오전 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "morning"} disabled={run.isPending} onPress={() => runNow("morning")} />
            <Button title="오후 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "afternoon"} disabled={run.isPending} onPress={() => runNow("afternoon")} />
          </View>
        </Card>
      ) : null}
      {items.some((i) => !i.latest) && withBriefing.length > 0 ? (
        <Muted style={{ paddingHorizontal: space.lg }}>브리핑 없음: {items.filter((i) => !i.latest).map((i) => i.name).join(", ")}</Muted>
      ) : null}
    </Screen>
  );
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
