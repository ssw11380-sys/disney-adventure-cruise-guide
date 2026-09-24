import type { CandlePeriod } from "@/api/types";
import { font } from "@/tokens";

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
  /** 보고 있는 봉의 날짜 (YYYY-MM-DD) */
  candleDate?: string;
  /** 시세(전일 종가)의 거래일. 알면 마지막 봉 날짜와 같을 때만 전일 종가를 쓴다 (봉 목록이 하루 늦게 캐시된 경우) */
  latestDate?: string | null;
}): { base: number | null; label: string } {
  if (o.period !== "D" && o.period !== "W" && o.period !== "M") return { base: o.open || null, label: "봉 시가 대비" };
  const sameDay = !o.latestDate || !o.candleDate || o.latestDate === o.candleDate;
  if (o.period === "D" && o.isLatest && o.latestBase && sameDay) return { base: o.latestBase, label: "전일 대비" };
  const label = o.period === "D" ? "전일 대비" : o.period === "W" ? "전주 대비" : "전월 대비";
  return { base: o.prevClose ?? o.open ?? null, label };
}

/**
 * 차트 글자(font.tiny) 폭 어림 (굵은 글자도 들어가게 조금 넉넉히). 10pt 기준 숫자·영문 약 6, 쉼표·마침표 약 3, 한글 약 10 을
 * 글자 크기에 비례해 늘린다 (3-20 에 차트 글자를 9·10pt 에서 토큰 11pt 로 맞춤)
 */
export function textWidth(label: string): number {
  let w = 0;
  for (const ch of label) w += /[가-힣]/.test(ch) ? 10 : /[,.]/.test(ch) ? 3 : 6;
  return (w * font.tiny) / 10;
}

/**
 * 가격 축 폭: 가장 긴 눈금·태그 글자에 맞춘다 (고정 폭이면 짧은 값에서 오른쪽이 비고 긴 값은 잘린다).
 * 작은 글자는 [글자, 배율] 로 (거래량 9pt → 0.9). 왼쪽 여백 4 + 오른쪽 3, 2px 단위로 올림 → 이동·확대 중 자릿수가 바뀌어도 폭이 덜 흔들린다
 */
export function axisWidth(labels: (string | [string, number])[], min = 32, max = 80): number {
  const longest = labels.reduce<number>((m, l) => Math.max(m, typeof l === "string" ? textWidth(l) : textWidth(l[0]) * l[1]), 0);
  return Math.min(max, Math.max(min, Math.ceil((longest + 7) / 2) * 2));
}

/** 그림 안쪽 글자 상자(52주 최고·최저)의 세로 범위. 선이 맨 위에 붙으면 선 아래에 적는다 (PriceChart Tag 와 같은 규칙) */
export function insideLabelBox(y: number, topLimit = 12): { top: number; bottom: number } {
  const ty = y - 4 < topLimit ? y + 12 : y - 4;
  return { top: ty - 10, bottom: ty + 3 };
}

/**
 * 52주 글자를 오른쪽 끝과 왼쪽 끝 중 어디에 둘지. 기본은 오른쪽(축 옆),
 * 오른쪽 상자가 봉(최신 봉)을 가리고 왼쪽은 비어 있으며 왼쪽 평단 글자(avoidY)와도 떨어져 있으면 왼쪽.
 */
export function labelSide(o: { y: number; plotW: number; bars: { left: number; right: number; top: number; bottom: number }[]; avoidY?: number | null; labelW?: number }): "left" | "right" {
  const w = o.labelW ?? 62;
  const box = insideLabelBox(o.y);
  const hit = (x0: number, x1: number) => o.bars.some((b) => b.right >= x0 && b.left <= x1 && b.top <= box.bottom && b.bottom >= box.top);
  if (!hit(o.plotW - w, o.plotW)) return "right";
  if (hit(0, w)) return "right";
  if (o.avoidY !== null && o.avoidY !== undefined && Math.abs(o.avoidY - o.y) < 16) return "right";
  return "left";
}
