import { Stack, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef } from "react";
import { AccountBriefingBody } from "@/components/AccountBriefingBody";
import { pickBriefing } from "@/lib/briefingPick";
import { SESSION_LABEL } from "@/lib/format";
import { parseBriefingId } from "@/lib/freshness";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { isWide } from "@/lib/windowClass";

/**
 * 계좌 한 장 브리핑 (3-31): 오늘 내 계좌가 왜 움직였는지 한 화면에 (본문은 components/AccountBriefingBody).
 * 알림에서 여는 주소(/briefings/account/<id>)는 그대로다.
 * 넓은 창(3-42, 플래그 foldLayout)에서는 3칸(펼친 폴드8 가로 등: 요약·수치 | 기여 표 | 지수·환율·일정) 또는 2칸(요약·수치·기여 표 | 지수·환율·일정·설명), 그 밖에는 지금 폰 화면 그대로.
 * 플래그가 켜져 있으면 브리핑 탭이 이어 보도록 기억한다 (넓은 창에서 열었거나 넓은 창에서 본 적이 있을 때만 폰 목록에서 강조 —
 * 넓은 창에서 읽다가 접어도 강조를 끄지 않는다: 종목 브리핑 상세(briefings/[id])·탭에서 접을 때와 같게)
 */
export default function AccountBriefingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const numId = parseBriefingId(id);
  const fold = useFoldLayout();
  const wide = fold.on && isWide(fold);
  // 이 화면을 넓은 창에서 본 적이 있는지 (접은 뒤에도 강조를 지킨다)
  const seenWide = useRef(false);
  useEffect(() => {
    if (!fold.on || numId === null) return;
    if (wide) seenWide.current = true;
    pickBriefing({ kind: "account", id: numId }, { highlight: seenWide.current });
  }, [fold.on, numId, wide]);
  return <AccountBriefingBody numId={numId} layout={wide ? "split" : "stack"} title={(b) => <Stack.Screen options={{ title: `계좌 브리핑 · ${SESSION_LABEL[b.session]}` }} />} />;
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
