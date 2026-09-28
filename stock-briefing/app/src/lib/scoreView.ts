import type { IndicatorScores, ScoreFamily, TrendScoreBlock, ValueMetricRow, ValueScoreBlock } from "@/api/types";

/**
 * 지표 점수 화면 모양 (3-44, 플래그 indicatorScores — 2단계부터 가치·종합) — 순수 함수 (테스트용).
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
  aiValue: "AI 가치분석",
  change: "지난주 대비",
  valueParts: "가치 지표 구성 · 묶음 비중",
  toValue: "가치분석 탭에서 지표별 값 보기",
  toValueWide: "가치 탭에서 지표별 값 보기",
  valueDetail: "가치 지표 점수",
  metricsOpen: "지표별 값 보기",
  metricsClose: "지표별 값 접기",
  flags: "표시",
  unused: "쓰지 않음",
} as const;

/** 막대 채움 비율 0~1 (점수 0~100). 점수가 없으면 null */
export function barFraction(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return Math.min(1, Math.max(0, score / 100));
}

/** 추세 줄이 숫자·막대로 보이는지 (본인 점수가 있을 때만) */
export const trendHasScore = (t: TrendScoreBlock): boolean => t.status === "ok" && t.score !== null && t.band !== null;

/** 가치 줄이 숫자·막대로 보이는지 (미국 보통주 점수 — ok·일부 지표 없이) */
export const valueHasScore = (v: ValueScoreBlock): boolean => (v.status === "ok" || v.status === "partial") && v.score !== null && !!v.band;

/** 화면 읽기: '가치 지표 57점, 0에서 100 중, 가운데쯤' (설계 5.7-F) — 배지가 있으면 덧붙임 / '가치 지표, 계산 준비 중' */
export function valueSpeech(v: ValueScoreBlock): string {
  if (!valueHasScore(v)) return `${SCORE_LABELS.value}, ${v.label}`;
  const badges = v.badges?.length ? `, ${v.badges.join(", ")}` : "";
  return `${SCORE_LABELS.value} ${v.score}점, 0에서 100 중, ${v.band}${badges}`;
}

/** 요약 카드 펼침의 표시 줄: 최대 2개, 나머지는 '표시 n개 더 — 가치분석 탭' (설계 5.7-B) */
export function flagPreview(v: ValueScoreBlock, max = 2): { shown: { key: string; text: string }[]; more: number } {
  const all = v.flags ?? [];
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}
export const moreFlagsText = (n: number, wide: boolean) => `${SCORE_LABELS.flags} ${n}개 더 — ${wide ? "가치" : "가치분석"} 탭`;

/** 지표 한 줄 화면 읽기: 'PER (이익 대비 주가) 27.9배, 위치 점수 77' / '… 쓰지 않음' */
export function metricSpeech(m: ValueMetricRow): string {
  if (!m.used) return `${m.name}, ${m.value ?? "값 없음"}, ${m.text}`;
  return `${m.name} ${m.value ?? ""}, 위치 점수 ${m.score}`.replace(/ ,/, ",");
}

/** 가치 지표 '계산 준비 중'이 서버 백그라운드 받기 때문일 때 다시 묻는 간격 */
export const SCORE_WAIT_REFETCH_MS = 60_000;
/** 서버가 재무·비교 기준을 받는 중이라 곧 바뀌는지 (한국 '계산 준비 중'은 3단계까지 그대로라 아님) */
export const valueWaiting = (d: IndicatorScores | null | undefined): boolean => !!d && d.value.status === "pending" && (d.value.reason?.code === "pendingFacts" || d.value.reason?.code === "pendingReference");

/** 종합 숫자: 두 점수가 모두 있을 때만 */
export const showComposite = (s: IndicatorScores): boolean => s.composite.status === "ok" && s.composite.score !== null;

/**
 * 종합 줄 (늘 둔다 — 설계 5.4 '없으면 없다고', 목업 1·2): 두 점수가 있으면 평균 숫자 + '두 점수의 평균',
 * 없으면 서버 글 '없음 · 가치 지표 점수가 없어 합치지 않습니다'를 상태('없음')와 이유로 나눈다
 */
export function compositeLine(s: IndicatorScores): { score: number | null; label: string; reason: string | null; gapText: string | null } {
  if (showComposite(s)) return { score: s.composite.score, label: String(s.composite.score), reason: SCORE_LABELS.compositeNote, gapText: s.composite.gapNote ? (s.composite.gapText ?? null) : null };
  const [head, ...rest] = s.composite.text.split(" · ");
  return { score: null, label: head || "없음", reason: rest.length ? rest.join(" · ") : null, gapText: null };
}

/** 화면 읽기: '추세 지표 69점, 다소 강함' / '추세 지표, 이 상품 자체 점수 없음' */
export function trendSpeech(t: TrendScoreBlock): string {
  if (trendHasScore(t)) return `${SCORE_LABELS.trend} ${t.score}점, ${t.band}`;
  return `${SCORE_LABELS.trend}, ${t.label}`;
}

/** 요약 카드 전체 화면 읽기 (설계 5.7-F) */
export function summarySpeech(s: IndicatorScores): string {
  const parts = [SCORE_LABELS.title, valueSpeech(s.value), trendSpeech(s.trend)];
  if (s.trend.reference?.status === "ok") parts.push(s.trend.reference.text);
  const c = compositeLine(s);
  parts.push(c.score !== null ? `${SCORE_LABELS.composite} ${c.score}점, ${SCORE_LABELS.compositeNote}` : `${SCORE_LABELS.composite} ${c.label}${c.reason ? `, ${c.reason}` : ""}`);
  // 차이 안내는 문장 끝 마침표를 떼고 이어 읽는다 (마침표가 겹치지 않게)
  if (c.gapText) parts.push(c.gapText.replace(/[.\s]+$/, ""));
  return `${parts.join(". ")}.`;
}

/** 레버리지 주의 상자 화면 읽기: 줄 앞 '·'와 줄 끝 마침표를 떼고 '. '로 잇는다 ('상품입니다..' 처럼 마침표가 겹치지 않게) */
export function leverageSpeech(box: { title: string; lines: { parts: { text: string }[] }[] }): string {
  const clean = (s: string) => s.replace(/^\s*·\s*/, "").replace(/[.\s]+$/, "");
  return `${[box.title, ...box.lines.map((l) => l.parts.map((p) => p.text).join(""))].map(clean).filter(Boolean).join(". ")}.`;
}

/** 묶음 한 줄 화면 읽기: '추세 69점, 비중 35' (가치 묶음도 같은 틀) */
export function familySpeech(f: Pick<ScoreFamily, "name" | "score" | "weight">): string {
  return f.score !== null ? `${f.name} ${f.score}점, 비중 ${f.weight}` : `${f.name}, 점수 없음`;
}

/** 묶음 안 항목 점수 한 줄: '200일선과 거리 72 · 50일선과 거리 66 · …' (없는 항목은 '없음') */
export function itemLine(f: ScoreFamily): string {
  return f.items.map((i) => `${i.name} ${i.score ?? "없음"}`).join(" · ");
}

/** 큰 글씨(130% 이상)면 줄 이름·숫자 / 막대·띠 두 줄로 (설계 4.3), 점수 없는 줄은 이름 / 상태 글 두 줄로 */
export const STACK_SCALE = 1.3;
export const stackRows = (fontScale: number): boolean => fontScale >= STACK_SCALE;
/**
 * 이름 칸 폭: 글자 100% 기준 폭을 글자 배율만큼(두 줄로 바꾸는 130% 까지) 넓힌다 — 폴드8 기본 글자(약 115%)에서 '가치 지표'가
 * '가치 지 / 표'로 접히지 않게. 설명 줄 들여쓰기도 같은 폭을 쓴다
 */
export const nameWidth = (base: number, fontScale: number): number => Math.ceil(base * Math.min(Math.max(fontScale || 1, 1), STACK_SCALE));
