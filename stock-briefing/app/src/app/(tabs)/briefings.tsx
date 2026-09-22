import React, { useState } from "react";
import { Alert, View } from "react-native";
import { useLatestBriefings, useStockMutations } from "@/api/hooks";
import type { BriefingSession } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { Screen } from "@/components/Screen";
import { Button, Card, Empty, ErrorView, Loading, Muted, Segmented } from "@/components/ui";
import { space } from "@/theme";

/** 브리핑 탭: 종목별 최신 브리핑. 요약/상세 토글, 수동 실행. */
export default function BriefingsScreen() {
  const [mode, setMode] = useState<"summary" | "detail">("summary");
  const { data, isLoading, isError, error, refetch, isRefetching } = useLatestBriefings();
  const { run } = useStockMutations();

  const runNow = (session: BriefingSession) => {
    run.mutate(
      { session, force: true },
      {
        onSuccess: (r) => {
          const failed = r.results.filter((x) => x.status === "failed");
          Alert.alert(
            "브리핑 생성 완료",
            failed.length ? `${r.results.length}개 중 ${failed.length}개 실패\n${failed.map((f) => `${f.name}: ${f.error}`).join("\n")}` : `${r.results.length}개 종목 생성`,
          );
        },
        onError: (e) => Alert.alert("실행 실패", e instanceof Error ? e.message : String(e)),
      },
    );
  };

  if (isLoading) return <Screen><Loading label="브리핑 불러오는 중" /></Screen>;
  if (isError) return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  const items = data ?? [];
  const withBriefing = items.filter((i) => i.latest);

  return (
    <Screen refreshing={isRefetching} onRefresh={() => void refetch()}>
      <Segmented
        options={[
          { value: "summary", label: "요약" },
          { value: "detail", label: "상세" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {items.length === 0 ? (
        <Empty title="등록된 종목이 없습니다" hint="내 종목 탭에서 종목을 등록하세요." />
      ) : withBriefing.length === 0 ? (
        <Empty title="아직 생성된 브리핑이 없습니다" hint="평일 08:30, 16:00 에 자동 생성됩니다. 지금 바로 만들어 볼 수도 있습니다." />
      ) : (
        withBriefing.map((i) => <BriefingCard key={i.code} briefing={i.latest!} mode={mode} />)
      )}
      {items.length > 0 ? (
        <Card>
          <Muted>지금 생성 (등록 종목 전체, 종목당 30초 안팎)</Muted>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="오전 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "morning"} disabled={run.isPending} onPress={() => runNow("morning")} />
            <Button title="오후 브리핑" variant="secondary" style={{ flex: 1 }} loading={run.isPending && run.variables?.session === "afternoon"} disabled={run.isPending} onPress={() => runNow("afternoon")} />
          </View>
        </Card>
      ) : null}
      {items.some((i) => !i.latest) && withBriefing.length > 0 ? (
        <Muted>브리핑 없음: {items.filter((i) => !i.latest).map((i) => i.name).join(", ")}</Muted>
      ) : null}
    </Screen>
  );
}
