import type { FeatureFlags } from "@/api/types";

/** 순수 함수 (테스트용): 받은 플래그에서 key 가 켜져 있는지. 받은 값에 없으면 fallback */
export function featureOn(flags: FeatureFlags | undefined | null, key: string, fallback = false): boolean {
  const v = flags?.features?.[key];
  return typeof v === "boolean" ? v : fallback;
}

/** 꺼진 기능의 데이터는 화면에 넘기지 않는다 (카드 안 조건마다 따로 거르지 않게 한 곳에서) */
export function gated<T>(on: boolean, value: T): T | undefined {
  return on ? value : undefined;
}
