import type { CandlePeriod } from "@/api/types";

/**
 * 차트 읽기 줄의 등락 기준 (순수 함수 → 단위 테스트).
 *  - 최신 일봉은 십자선이 올라가 있어도 현재가 머리와 같은 기준(전일 종가 = 거래소 기준가). 통합 봉의 직전 종가와 다를 수 있다
 *  - 지난 일봉·주봉·월봉은 직전 봉 종가 기준 (전일·전주·전월 대비)
 *  - 분봉은 그 봉의 시가 기준 (봉 안의 움직임)
 * 기준 문구를 함께 돌려 화면에 적는다.
 */
export function readoutBasis(o: {
  period: CandlePeriod;
  /** 보고 있는 봉이 전체 시계열의 마지막(최신) 봉인지 */
  isLatest: boolean;
  /** 현재가 머리의 전일 종가 (일봉에서만 씀) */
  latestBase: number | null | undefined;
  /** 직전 봉의 종가 */
  prevClose: number | null | undefined;
  open: number;
}): { base: number | null; label: string } {
  if (o.period !== "D" && o.period !== "W" && o.period !== "M") return { base: o.open || null, label: "봉 시가 대비" };
  if (o.period === "D" && o.isLatest && o.latestBase) return { base: o.latestBase, label: "전일 대비" };
  const label = o.period === "D" ? "전일 대비" : o.period === "W" ? "전주 대비" : "전월 대비";
  return { base: o.prevClose ?? o.open ?? null, label };
}

/** 10pt 글자 폭 어림: 숫자·영문 약 5.8, 쉼표·마침표 약 3, 한글 약 10 */
export function textWidth(label: string): number {
  let w = 0;
  for (const ch of label) w += /[가-힣]/.test(ch) ? 10 : /[,.]/.test(ch) ? 3 : 5.8;
  return w;
}

/** 가격 축 폭: 가장 긴 눈금·태그 글자에 맞춘다 (고정 폭이면 짧은 값에서 오른쪽이 비고 긴 값은 잘린다). 왼쪽 여백 4 + 오른쪽 2 */
export function axisWidth(labels: string[], min = 30, max = 76): number {
  const longest = labels.reduce((m, s) => Math.max(m, textWidth(s)), 0);
  return Math.round(Math.min(max, Math.max(min, longest + 7)));
}
