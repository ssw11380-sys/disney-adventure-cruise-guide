import type { ThemeSummary } from "@/api/types";

/**
 * 테마·업종 상세 머리에 크게 보여 줄 등락률. 서버가 요약을 보이는 종목 값과 같은 때 값으로 확인하지 못했으면(unverified —
 * 미국 업종 출처 초기화 때 종목만 저장본으로 덮은 경우) 요약은 출처가 비운 때 값(0% 등)이라 null → 화면은 "-"(중립 색)
 */
export function headlineRate(theme: Pick<ThemeSummary, "changeRate" | "unverified"> | null | undefined): number | null {
  if (!theme || theme.unverified) return null;
  return theme.changeRate;
}
