import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/hooks";
import type { HoldingSchedule } from "@/api/types";
import { scheduleHasFailure } from "@/lib/filingAlerts";

/**
 * '일정·공시' 화면 (3-38, 플래그 holdingSchedule) 쿼리. 화면을 열 때 받는다 (계좌 브리핑 저장본이 아니라 — 브리핑 뒤 산 종목도 보이게, 서버 캐시 덕에 보통 1초 안).
 * 계좌 상세 링크 줄의 '· 새 공시 N건'은 같은 쿼리를 이미 받아 둔 경우에만 센다 (useCachedSchedule — 카드 때문에 새 요청을 만들지 않음).
 * 쿼리 키의 서버 주소는 API 객체의 것(설정을 다 읽기 전에는 빈 주소 — 그동안은 부르지 않는다). 설정 모듈을 부르지 않아 계좌 상세가 가볍게 그대로 불린다
 */
export const scheduleKey = (apiUrl: string) => [apiUrl, "schedule"] as const;
/** 알림으로 온 '새 공시' 화면(holdingSchedule 꺼짐 · filingAlerts 켬)의 서버 알림 목록 */
export const filingAlertListKey = (apiUrl: string) => [apiUrl, "filingAlertList"] as const;

/** 받아 둔 값을 새것으로 볼 시간 */
export const SCHEDULE_STALE_MS = 60_000;

/**
 * 받아 둔 값이 새것인 시간: 받지 못한 칸·종목이 있으면 0 — 화면 글이 '화면을 다시 열면 다시 받습니다'이므로 1분 안에 다시 열어도 곧바로 다시 묻는다
 * (서버도 받지 못한 일정은 캐시하지 않는다 — 3-38 리뷰 3). 나머지는 1분
 */
export function scheduleStaleMs(data: HoldingSchedule | undefined): number {
  return scheduleHasFailure(data) ? 0 : SCHEDULE_STALE_MS;
}

export function useHoldingSchedule(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: scheduleKey(api.baseUrl), queryFn: () => api.holdingSchedule(), enabled: enabled && api.baseUrl !== "", staleTime: (q) => scheduleStaleMs(q.state.data), retry: 0 });
}

/** 받아 둔 값만 (요청하지 않음 — enabled: false 는 캐시만 읽는다) */
export function useCachedSchedule(): HoldingSchedule | undefined {
  const api = useApi();
  return useQuery({ queryKey: scheduleKey(api.baseUrl), queryFn: () => api.holdingSchedule(), enabled: false }).data;
}

/** '새 공시' 화면 — 서버 알림 목록 (/api/filings/alerts?days=3, 플래그 filingAlerts). 열 때 받는다 */
export function useFilingAlertList(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: filingAlertListKey(api.baseUrl), queryFn: () => api.filingAlerts(), enabled: enabled && api.baseUrl !== "", staleTime: SCHEDULE_STALE_MS, retry: 0 });
}
