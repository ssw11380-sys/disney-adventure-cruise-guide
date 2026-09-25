import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useEffect } from "react";
import { BriefingBody } from "@/components/BriefingBody";
import { Screen } from "@/components/Screen";
import { ErrorView } from "@/components/ui";
import { pickBriefing } from "@/lib/briefingPick";
import { markBriefingRead } from "@/lib/briefingRead";
import { SESSION_LABEL } from "@/lib/format";
import { parseBriefingId } from "@/lib/freshness";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";
import { foldBriefings as FB, layout } from "@/tokens";

/**
 * 브리핑 상세: 요약/상세 토글, 당시 시세 스냅샷, 같은 종목 지난 브리핑 날짜 목록 (본문은 components/BriefingBody).
 * 알림·위젯·목록에서 여는 주소(/briefings/<id>)는 그대로다.
 * 넓은 창(3-42, 플래그 foldLayout)에서는 두 칸(왼쪽 가격·근거·지난 브리핑 | 오른쪽 본문)으로, 그 밖에는 지금 폰 화면 그대로.
 * 플래그가 켜져 있으면 연 브리핑을 '읽음'으로 적고 브리핑 탭이 이어 보도록 기억한다 (넓은 창에서 열었을 때만 폰 목록에서 강조)
 */
export default function BriefingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  // 잘못된 딥링크(briefings/abc, briefings/0)는 요청하지 않고 안내만 한다
  const numId = parseBriefingId(id);
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  useEffect(() => {
    if (!fold.on || numId === null) return;
    markBriefingRead(numId);
    pickBriefing({ kind: "stock", id: numId }, { highlight: wide });
  }, [fold.on, numId, wide]);

  if (numId === null) return <Screen><ErrorView error={new Error("브리핑 주소가 올바르지 않습니다")} retryLabel="브리핑 목록으로" onRetry={() => router.dismissTo("/briefings")} /></Screen>;
  return (
    <BriefingBody
      id={numId}
      layout={wide ? "split" : "stack"}
      side={fold.width === "expanded" ? layout.detailSideW : FB.sideNarrowW}
      title={(d) => <Stack.Screen options={{ title: `${d.name ?? d.code} · ${SESSION_LABEL[d.session]}` }} />}
    />
  );
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
