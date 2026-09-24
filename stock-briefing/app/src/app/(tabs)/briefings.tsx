import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useFeature, useHealth, useLatestBriefings, useMarketStatus, useRegisteredStocks, useStockMutations } from "@/api/hooks";
import type { BriefingSession } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { StaleBanner, usePull } from "@/components/Freshness";
import { CardsSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { Button, Card, ChangeText, Empty, ErrorView, Muted, SectionTitle, Segmented } from "@/components/ui";
import { orderForTab, runConfirm } from "@/lib/briefingRun";
import { formatDateKo, formatPct } from "@/lib/format";
import { viewState } from "@/lib/freshness";
import { font, space, useTheme } from "@/theme";

type Mode = "line" | "summary" | "detail";
type Order = "movers" | "registered";

/**
 * 브리핑 탭: 서버 상태 배너 → (3-19) 변동 큰 3종목 → 종목별 최신 브리핑(한 줄/요약/상세) → 수동 실행.
 * briefingTabMovers 플래그가 켜져 있으면 기본 정렬은 '변동 큰 순'(오늘 등락률 절댓값), 아니면 등록순(예전)
 */
export default function BriefingsScreen() {
  const t = useTheme();
  const [mode, setMode] = useState<Mode>("summary");
  const latest = useLatestBriefings();
  const { data, error, refetch } = latest;
  const { pulling, onPull } = usePull(refetch);
  const { run } = useStockMutations();
  const health = useHealth();
  const market = useMarketStatus();
  const moversOn = useFeature("briefingTabMovers", false);
  const [order, setOrder] = useState<Order>("movers");
  const stocks = useRegisteredStocks();
  const rates = useMemo(() => new Map((stocks.data ?? []).map((s) => [s.code, s.quote?.changeRate ?? null] as const)), [stocks.data]);

  // 17종목 × 약 25초: 누르기 전에 한 번 묻는다 (3-19)
  const confirmRun = (session: BriefingSession) => {
    const c = runConfirm(session, (data ?? []).length);
    Alert.alert(c.title, c.message, [
      { text: "취소", style: "cancel" },
      { text: "만들기", onPress: () => runNow(session) },
    ]);
  };

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
  if (view === "loading") return <Screen><CardsSkeleton count={4} /></Screen>;
  if (view === "error") return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  const items = data ?? [];
  const movers = moversOn && order === "movers";
  const { list: ordered, top } = orderForTab(items.filter((i) => i.latest), rates, movers);
  const withBriefing = ordered;
  const last = health.data?.lastBriefing ?? null;
  const llmOff = health.data?.llmConfigured === false;
  const krHoliday = market.data && !market.data.KR.isTradingDay;

  return (
    <Screen disclaimer refreshing={pulling} onRefresh={onPull} top={<StaleBanner query={latest} />}>
      {llmOff || (last && last.failed > 0) ? (
        <Card style={{ borderLeftWidth: 3, borderLeftColor: t.danger }}>
          <Text style={{ color: t.danger, fontSize: font.body, fontWeight: "700" }}>{llmOff ? "브리핑 모델이 설정되지 않았습니다" : `최근 실행에서 ${last!.failed}개 종목이 실패했습니다`}</Text>
          <Muted>{llmOff ? "서버 변수 ANTHROPIC_API_KEY 가 비어 있습니다." : last!.lastError ?? ""}</Muted>
          {last ? <Muted>{formatDateKo(last.finishedAt, true)} · {last.session === "morning" ? "오전" : "오후"} · 성공 {last.ok} / 실패 {last.failed} / 건너뜀 {last.skipped}</Muted> : null}
        </Card>
      ) : null}
      {krHoliday ? <Muted style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>한국 휴장일 · 국내 종목 브리핑 없음{market.data?.KR.opensAt ? ` · 다음 개장 ${formatDateKo(market.data.KR.opensAt, true)}` : ""}</Muted> : null}
      {movers && top.length > 0 ? (
        <Card>
          <SectionTitle>오늘 변동 큰 종목</SectionTitle>
          {top.map((i) => (
            <Pressable
              key={i.code}
              onPress={() => router.push(`/briefings/${i.latest!.id}`)}
              accessibilityRole="link"
              accessibilityLabel={`${i.name} ${formatPct(rates.get(i.code) ?? null)} 브리핑 보기`}
              style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 6 }}
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
        withBriefing.map((i) => <BriefingCard key={i.code} briefing={i.latest!} mode={mode} rate={movers ? (rates.get(i.code) ?? null) : undefined} />)
      )}
      {items.length > 0 ? (
        <Card>
          <SectionTitle>수동 생성</SectionTitle>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="오전 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "morning"} disabled={run.isPending} onPress={() => confirmRun("morning")} />
            <Button title="오후 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "afternoon"} disabled={run.isPending} onPress={() => confirmRun("afternoon")} />
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
