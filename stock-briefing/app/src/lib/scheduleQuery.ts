import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/hooks";
import type { HoldingSchedule } from "@/api/types";

/**
 * '일정·공시' 화면 (3-38, 플래그 holdingSchedule) 쿼리. 화면을 열 때 받는다 (계좌 브리핑 저장본이 아니라 — 브리핑 뒤 산 종목도 보이게, 서버 캐시 덕에 보통 1초 안).
 * 계좌 상세 링크 줄의 '· 새 공시 N건'은 같은 쿼리를 이미 받아 둔 경우에만 센다 (useCachedSchedule — 카드 때문에 새 요청을 만들지 않음).
 * 쿼리 키의 서버 주소는 API 객체의 것(설정을 다 읽기 전에는 빈 주소 — 그동안은 부르지 않는다). 설정 모듈을 부르지 않아 계좌 상세가 가볍게 그대로 불린다
 */
export const scheduleKey = (apiUrl: string) => [apiUrl, "schedule"] as const;

export function useHoldingSchedule(enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: scheduleKey(api.baseUrl), queryFn: () => api.holdingSchedule(), enabled: enabled && api.baseUrl !== "", staleTime: 60_000, retry: 0 });
}

/** 받아 둔 값만 (요청하지 않음 — enabled: false 는 캐시만 읽는다) */
export function useCachedSchedule(): HoldingSchedule | undefined {
  const api = useApi();
  return useQuery({ queryKey: scheduleKey(api.baseUrl), queryFn: () => api.holdingSchedule(), enabled: false }).data;
}
