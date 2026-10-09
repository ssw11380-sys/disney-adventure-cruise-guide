/** 고지 문구 (React Native 를 불러오지 않는 모듈 — 위젯 태스크에서도 쓴다) */
export const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";
/** 위젯처럼 좁은 곳용 한 줄 */
export const DISCLAIMER_SHORT = "참고 정보이며 투자 권유가 아닙니다";
/** 종목 브리핑 상세 머리 한 줄 (브리핑 2차 6, 플래그 briefingSafeWording) — 종목 브리핑 글은 모델이 쓴다 */
export const AI_NOTE = "AI가 쓴 글 · 틀릴 수 있음";
/** 종목 브리핑 카드 날짜 줄 끝 조각 (같은 플래그) */
export const AI_TAG = "AI가 쓴 글";
/**
 * AI 가치분석 글 바로 위 한 줄 (가치 점수 개선 1단계 [8] 안전망, 서버 플래그 valueAiSafeWording) — 금지어 검사가 놓친 말이 있어도
 * 글이 AI가 쓴 참고 글이며 권유가 아님을 글과 함께 보인다 (위의 'AI가 쓴 글 · 틀릴 수 있음' + 짧은 고지)
 */
export const VALUE_AI_NOTE = `${AI_NOTE} · ${DISCLAIMER_SHORT}`;
