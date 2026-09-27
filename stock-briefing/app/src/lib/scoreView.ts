import type { IndicatorScores, ScoreFamily, TrendScoreBlock } from "@/api/types";

/**
 * 지표 점수 화면 모양 (3-44 1단계, 플래그 indicatorScores) — 순수 함수 (테스트용).
 * 문장은 서버가 만들고(금지어 검사는 서버 한 곳), 여기서는 무엇을 어느 줄에 보일지와 화면 읽기 문장만 정한다.
 * 앱에 고정된 글은 줄 이름·버튼·화면 읽기 틀뿐이다 (SCORE_LABELS)
 */

export const SCORE_LABELS = {
  title: "지표 점수",
  value: "가치 지표",
  trend: "추세 지표",
  composite: "종합 지표",
  compositeNote: "두 점수의 평균",
  expand: "구성·계산 방법 보기",
  collapse: "구성·계산 방법 접기",
  trendParts: "추세 지표 구성 · 묶음 비중",
  how: "이 점수는 어떻게 만들었나",
  toTechnical: "기술분석 탭에서 항목별 사실 보기",
  toTechnicalWide: "기술 탭에서 항목별 사실 보기",
  underlyingBadge: "기초자산 기준",
  aiBadge: "AI가 쓴 글",
  aiCompany: "AI 기업개요",
  aiTechnical: "AI 기술분석",
  change: "지난주 대비",
} as const;

/** 막대 채움 비율 0~1 (점수 0~100). 점수가 없으면 null */
export function barFraction(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return Math.min(1, Math.max(0, score / 100));
}

/** 추세 줄이 숫자·막대로 보이는지 (본인 점수가 있을 때만) */
export const trendHasScore = (t: TrendScoreBlock): boolean => t.status === "ok" && t.score !== null && t.band !== null;

/** 종합 줄: 두 점수가 모두 있을 때만 (이번 단계에서는 늘 숨김) */
export const showComposite = (s: IndicatorScores): boolean => s.composite.status === "ok" && s.composite.score !== null;

/** 화면 읽기: '추세 지표 69점, 다소 강함' / '추세 지표, 이 상품 자체 점수 없음' */
export function trendSpeech(t: TrendScoreBlock): string {
  if (trendHasScore(t)) return `${SCORE_LABELS.trend} ${t.score}점, ${t.band}`;
  return `${SCORE_LABELS.trend}, ${t.label}`;
}

/** 요약 카드 전체 화면 읽기 (설계 5.7-F 를 1단계에 맞춤) */
export function summarySpeech(s: IndicatorScores): string {
  const parts = [SCORE_LABELS.title, `${SCORE_LABELS.value}, ${s.value.label}`, trendSpeech(s.trend)];
  if (s.trend.reference?.status === "ok") parts.push(s.trend.reference.text);
  if (showComposite(s)) parts.push(`${SCORE_LABELS.composite} ${s.composite.score}점, ${SCORE_LABELS.compositeNote}`);
  return `${parts.join(". ")}.`;
}

/** 묶음 한 줄 화면 읽기: '추세 69점, 비중 35' */
export function familySpeech(f: ScoreFamily): string {
  return f.score !== null ? `${f.name} ${f.score}점, 비중 ${f.weight}` : `${f.name}, 점수 없음`;
}

/** 묶음 안 항목 점수 한 줄: '200일선과 거리 72 · 50일선과 거리 66 · …' (없는 항목은 '없음') */
export function itemLine(f: ScoreFamily): string {
  return f.items.map((i) => `${i.name} ${i.score ?? "없음"}`).join(" · ");
}

/** 큰 글씨(130% 이상)면 줄 이름·숫자 / 막대·띠 두 줄로 (설계 4.3) */
export const STACK_SCALE = 1.3;
export const stackRows = (fontScale: number): boolean => fontScale >= STACK_SCALE;
/**
 * 이름 칸 폭: 글자 100% 기준 폭을 글자 배율만큼(두 줄로 바꾸는 130% 까지) 넓힌다 — 폴드8 기본 글자(약 115%)에서 '가치 지표'가
 * '가치 지 / 표'로 접히지 않게. 설명 줄 들여쓰기도 같은 폭을 쓴다
 */
export const nameWidth = (base: number, fontScale: number): number => Math.ceil(base * Math.min(Math.max(fontScale || 1, 1), STACK_SCALE));
