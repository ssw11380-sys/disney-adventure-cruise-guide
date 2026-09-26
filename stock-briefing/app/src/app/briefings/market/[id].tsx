import { Stack, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef } from "react";
import { MarketSummaryBody } from "@/components/MarketSummaryBody";
import { pickBriefing } from "@/lib/briefingPick";
import { SESSION_LABEL } from "@/lib/format";
import { parseBriefingId } from "@/lib/freshness";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";

/**
 * 시장 전체 요약 상세 (플래그 marketSummary, 주소 /briefings/market/<id>). 본문은 components/MarketSummaryBody.
 * 넓은 창(플래그 foldLayout)에서는 두 칸(제목·요약·내 보유 종목과 지수 | 지수·업종·환율·일정·뉴스), 그 밖에는 폰 화면 한 줄.
 * 플래그가 켜져 있으면 브리핑 탭이 이어 보도록 기억한다 (계좌 브리핑 화면과 같은 규칙)
 */
export default function MarketSummaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const numId = parseBriefingId(id);
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  const seenWide = useRef(false);
  useEffect(() => {
    if (!fold.on || numId === null) return;
    if (wide) seenWide.current = true;
    pickBriefing({ kind: "market", id: numId }, { highlight: seenWide.current });
  }, [fold.on, numId, wide]);
  return <MarketSummaryBody numId={numId} layout={wide ? "split" : "stack"} title={(s) => <Stack.Screen options={{ title: `시장 요약 · ${SESSION_LABEL[s.session]}` }} />} />;
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
