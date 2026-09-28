import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { ScheduleScreen } from "@/components/ScheduleScreen";
import { parseAccession, SCHEDULE_TITLE } from "@/lib/filingAlerts";

/**
 * '일정·공시' 화면 (3-38, 플래그 holdingSchedule): 보유 종목 30일 안 배당락일 + 최근 30일 미국 SEC 공시 + 한국 공시 안내.
 * 새 공시 알림은 /schedule?focus=<접수 번호> 로 연다 — 형식(10-2-6 자리 숫자)이 아니면 focus 를 무시한다
 */
export default function ScheduleRoute() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: SCHEDULE_TITLE }} />
      <ScheduleScreen focus={parseAccession(focus)} />
    </>
  );
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
