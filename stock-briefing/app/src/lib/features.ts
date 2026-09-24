import type { FeatureFlags } from "@/api/types";

/** 순수 함수 (테스트용): 받은 플래그에서 key 가 켜져 있는지. 없으면 꺼짐 */
export function featureOn(flags: FeatureFlags | undefined | null, key: string): boolean {
  return flags?.features?.[key] === true;
}
