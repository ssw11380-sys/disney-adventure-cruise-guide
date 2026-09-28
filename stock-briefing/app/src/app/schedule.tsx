import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { useFeature } from "@/api/hooks";
import { ScheduleScreen } from "@/components/ScheduleScreen";
import { parseAccession, scheduleScreenTitle } from "@/lib/filingAlerts";

/**
 * '일정·공시' 화면 (3-38, 플래그 holdingSchedule): 보유 종목 30일 안 배당락일 + 최근 30일 미국 SEC 공시 + 한국 공시 안내.
 * 새 공시 알림은 /schedule?focus=<접수 번호> 로 연다 — 형식(10-2-6 자리 숫자)이 아니면 focus 를 무시한다.
 * holdingSchedule 이 꺼져 있고 filingAlerts 만 켜져 있으면 제목 '새 공시' (알림 목록만 보인다)
 */
export default function ScheduleRoute() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const title = scheduleScreenTitle(useFeature("holdingSchedule", false), useFeature("filingAlerts", false));
  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScheduleScreen focus={parseAccession(focus)} />
    </>
  );
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
