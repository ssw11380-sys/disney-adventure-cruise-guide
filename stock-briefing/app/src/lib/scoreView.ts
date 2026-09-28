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

/** 가치 줄이 숫자·막대로 보이는지 (미국 보통주 점수 · 3단계 한국 간이 점수 — ok·일부 지표 없이) */
export const valueHasScore = (v: ValueScoreBlock): boolean => (v.status === "ok" || v.status === "partial") && v.score !== null && !!v.band;

/**
 * 화면 읽기: '가치 지표 57점, 0에서 100 중, 가운데쯤' (설계 5.7-F) — 배지가 있으면 덧붙임.
 * 점수가 없으면 상태 글과 이유 글까지: '가치 지표, 지금 계산하지 않음, 가치 지표 점수는 지금 계산하지 않습니다' (보이는 이유 줄을 TalkBack 도 읽게, 검토 지적)
 */
export function valueSpeech(v: ValueScoreBlock): string {
  if (!valueHasScore(v)) {
    const why = (v.reason?.text ?? v.text ?? "").replace(/[.\s]+$/, "");
    return why && why !== v.label ? `${SCORE_LABELS.value}, ${v.label}, ${why}` : `${SCORE_LABELS.value}, ${v.label}`;
  }
  const badges = v.badges?.length ? `, ${v.badges.join(", ")}` : "";
  return `${SCORE_LABELS.value} ${v.score}점, 0에서 100 중, ${v.band}${badges}`;
}

/** 요약 카드 펼침의 표시 줄: 최대 2개, 나머지는 '표시 n개 더 — 가치분석 탭' (설계 5.7-B) */
export function flagPreview(v: ValueScoreBlock, max = 2): { shown: { key: string; text: string }[]; more: number } {
  const all = v.flags ?? [];
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}
export const moreFlagsText = (n: number, wide: boolean) => `${SCORE_LABELS.flags} ${n}개 더 — ${wide ? "가치" : "가치분석"} 탭`;

/** 화면 읽기용으로 다듬기: '72/100' → '100 중 72', ' · ' → 쉼표, 앞 화살표·끝 마침표 떼기 (마침표가 겹치지 않게) */
const speakable = (s: string) => s.replace(/(\d+)\/100/g, "100 중 $1").replace(/ · /g, ", ").replace(/^→\s*/, "").replace(/[.\s]+$/, "");

/**
 * 지표 한 줄 화면 읽기 — 줄 전체를 한 덩어리로 읽으므로 보이는 글을 모두 담는다 (값 · 가운데값 · 위치 점수 · 비교별 위치 · 비중 · 문장 · 안내 · 뜻):
 * 'PER (이익 대비 주가) 27.9배, 업종 가운데값 35.0배. 위치 점수 77. 업종 안 위치 100 중 80, 시장 안 100 중 70. 비중 업종 71, 시장 29. 이익에 비해 …'
 * 쓰지 않는 지표는 '이름, 값 없음, 까닭'
 */
export function metricSpeech(m: ValueMetricRow): string {
  const lead = [m.name, m.value].filter(Boolean).join(" ");
  if (!m.used) return `${[m.name, m.value ?? "값 없음", m.text].map(speakable).join(", ")}.`;
  const parts = [m.peerMedian ? `${lead}, ${m.peerMedian}` : lead, m.basis ?? null, `위치 점수 ${m.score}`, m.positions, m.mix ? `비중 ${m.mix}` : null, m.text, m.note, m.meaning];
  return `${parts
    .filter((p): p is string => !!p)
    .map(speakable)
    .join(". ")}.`;
}

/** 가치 지표 '계산 준비 중'이 서버 백그라운드 받기 때문일 때 다시 묻는 간격 */
export const SCORE_WAIT_REFETCH_MS = 60_000;
/**
 * 서버가 재무·비교 기준을 받는 중이라 곧 바뀌는지 (처음 받기 · 오랜만에 새로 받기 · 첫 비교 기준 — 미국·한국 같은 이유 번호).
 * 한국 비교 회사 첫 채우기(krFirstFill — 밤마다 나눠 며칠)와 '지금 계산하지 않음'(krOff)은 곧 바뀌지 않으므로 아님
 */
const WAIT_CODES: ReadonlySet<string> = new Set(["pendingFacts", "pendingRefresh", "pendingReference"]);
export const valueWaiting = (d: IndicatorScores | null | undefined): boolean => !!d && d.value.status === "pending" && WAIT_CODES.has(d.value.reason?.code ?? "");

/** 종합 숫자: 두 점수가 모두 있을 때만 */
export const showComposite = (s: IndicatorScores): boolean => s.composite.status === "ok" && s.composite.score !== null;

/**
 * 종합 줄 (늘 둔다 — 설계 5.4 '없으면 없다고', 목업 1·2): 두 점수가 있으면 평균 숫자 + '두 점수의 평균',
 * 없으면 서버 글 '없음 · 가치 지표 점수가 없어 합치지 않습니다'를 상태('없음')와 이유로 나눈다.
 * formulaOn(가치 점수 개선 1단계 [4], 플래그 compositeFormula — 앱 fallback 꺼짐)이고 서버가 식을 주면 formula '= (51 + 80) ÷ 2' 도 (끄면 예전 모양 그대로)
 */
export function compositeLine(s: IndicatorScores, formulaOn = false): { score: number | null; label: string; reason: string | null; gapText: string | null; formula?: string } {
  if (showComposite(s)) {
    const base = { score: s.composite.score, label: String(s.composite.score), reason: SCORE_LABELS.compositeNote, gapText: s.composite.gapNote ? (s.composite.gapText ?? null) : null };
    return formulaOn && s.composite.formula ? { ...base, formula: s.composite.formula } : base;
  }
  const [head, ...rest] = s.composite.text.split(" · ");
  return { score: null, label: head || "없음", reason: rest.length ? rest.join(" · ") : null, gapText: null };
}

/** 식 화면 읽기: '= (51 + 80) ÷ 2' → '51과 80을 더해 2로 나눈 값' (기호를 '플러스·나누기'로 읽지 않게) */
export function formulaSpeech(formula: string): string {
  const m = /\((\d+)\s*\+\s*(\d+)\)\s*÷\s*2/.exec(formula);
  if (!m) return formula.replace(/^=\s*/, "");
  const a = m[1]!;
  const b = m[2]!;
  return `${a}${gwaWaNum(a)} ${b}${euRulNum(b)} 더해 2로 나눈 값`;
}
/** 점수(0~100) 읽기 끝소리로 조사: 영·일·삼·육·칠·팔·십·백은 받침 있음, 이·사·오·구는 없음 */
const numHasBatchim = (n: string) => ["0", "1", "3", "6", "7", "8"].includes(n.at(-1)!);
const gwaWaNum = (n: string) => (numHasBatchim(n) ? "과" : "와");
const euRulNum = (n: string) => (numHasBatchim(n) ? "을" : "를");

/**
 * 이유 글에서 앞에 붙은 상태 글('잠시 보류 — …')을 뗀다 — 상태 글은 줄 이름 옆에 따로 보이므로 (3단계 서버는 붙이지 않지만 예전 서버 응답도 그리게)
 */
export function reasonOnly(label: string, text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.startsWith(`${label} — `) ? text.slice(label.length + 3) : text;
  return t || null;
}

/**
 * 화면 읽기: '추세 지표 69점, 다소 강함' / 점수가 없으면 상태 글과 보이는 이유 글까지 —
 * '추세 지표, 이 상품 자체 점수 없음, 매일 3배를 다시 맞추는 상품이라 …' · '추세 지표, 잠시 보류, 주식 분할·병합 반영을 확인하는 중입니다' (검토 지적)
 */
export function trendSpeech(t: TrendScoreBlock): string {
  if (trendHasScore(t)) return `${SCORE_LABELS.trend} ${t.score}점, ${t.band}`;
  const why = reasonOnly(t.label, t.reason?.text)?.replace(/[.\s]+$/, "");
  return why ? `${SCORE_LABELS.trend}, ${t.label}, ${why}` : `${SCORE_LABELS.trend}, ${t.label}`;
}

/** 요약 카드 전체 화면 읽기 (설계 5.7-F). formulaOn: 종합 식도 읽는다 ('종합 지표 66점, 두 점수의 평균, 51과 80을 더해 2로 나눈 값') */
export function summarySpeech(s: IndicatorScores, formulaOn = false): string {
  const parts = [SCORE_LABELS.title, valueSpeech(s.value), trendSpeech(s.trend)];
  if (s.trend.reference?.status === "ok") parts.push(s.trend.reference.text);
  const c = compositeLine(s, formulaOn);
  parts.push(
    c.score !== null
      ? `${SCORE_LABELS.composite} ${c.score}점, ${SCORE_LABELS.compositeNote}${c.formula ? `, ${formulaSpeech(c.formula)}` : ""}`
      : `${SCORE_LABELS.composite} ${c.label}${c.reason ? `, ${c.reason}` : ""}`,
  );
  // 차이 안내는 문장 끝 마침표를 떼고 이어 읽는다 (마침표가 겹치지 않게)
  if (c.gapText) parts.push(c.gapText.replace(/[.\s]+$/, ""));
  return `${parts.join(". ")}.`;
}

/** 레버리지 주의 상자 화면 읽기: 줄 앞 '·'와 줄 끝 마침표를 떼고 '. '로 잇는다 ('상품입니다..' 처럼 마침표가 겹치지 않게) */
export function leverageSpeech(box: { title: string; lines: { parts: { text: string }[] }[] }): string {
  const clean = (s: string) => s.replace(/^\s*·\s*/, "").replace(/[.\s]+$/, "");
  return `${[box.title, ...box.lines.map((l) => l.parts.map((p) => p.text).join(""))].map(clean).filter(Boolean).join(". ")}.`;
}

/** 지표 줄의 값 · 가운데값 (연간 재무 지표는 뒤에 기준 글): '32.9% · 업종 가운데값 13.1% (2026년 1월 결산 연간 기준)' */
export function metricMain(m: Pick<ValueMetricRow, "value" | "peerMedian" | "basis">): string {
  const main = [m.value, m.peerMedian].filter(Boolean).join(" · ");
  return m.basis && main ? `${main} (${m.basis})` : main;
}

/**
 * 묶음 이름 칸의 비중 이음 글: 이름 끝 낱말 · 비중이 한 덩어리로 줄을 바꾸게 줄바꿈 없는 빈칸(U+00A0)으로 잇는다
 * ('수익성과 이익의 질 ·' / '25' 처럼 비중만 다음 줄로 떨어지던 것, 검토 지적). '수익성과 이익의 질 · 25'
 */
export const WEIGHT_JOIN = " · ";
/**
 * 큰 글씨(두 줄 배치 130% 이상)에서는 '·' 앞을 보통 빈칸으로 — 좁은 이름 칸에서 '가격 안정성 · 10' 이 한 덩어리라 낱말 가운데서 끊기던 것
 * ('가격 안정 / 성 · 10', 200% — 검토 지적). 이때는 '가격 안정성' / '· 10' 으로 빈칸에서 바뀐다 ('·'와 숫자는 붙은 채)
 */
export const WEIGHT_JOIN_BREAKABLE = " · ";
export const weightJoin = (fontScale: number) => (stackRows(fontScale) ? WEIGHT_JOIN_BREAKABLE : WEIGHT_JOIN);
export const familyLabel = (name: string, weight: number, fontScale = 1) => `${name}${weightJoin(fontScale)}${weight}`;

/**
 * 요약 카드의 '가치분석 탭에서 지표별 값 보기' 뒤 스크롤 위치: 탭 내용 칸의 스크롤 칸 안 위치 + 그 안에서 가치 상세 카드의 위치 − 위 여백.
 * (휴대폰 화면은 카드가 스크롤 칸에 바로 놓여 탭 내용 칸 위치가 0)
 */
export const VALUE_JUMP_GAP = 8;
export const valueJumpY = (bodyY: number, cardY: number): number => Math.max(0, Math.round(bodyY + cardY - VALUE_JUMP_GAP));

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
