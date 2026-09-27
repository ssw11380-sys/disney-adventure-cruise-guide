/**
 * 지표 점수 문구 검사 (3-44). 서버가 만드는 모든 점수 문장(요약·상세·레버리지 상자·계산 방법·바뀐 이유)은 이 검사를 통과해야 한다 —
 * 테스트가 모든 틀 조합을 돌려 확인한다(test/indicatorScores.test.ts). 목록은 설계서(docs/설계/지표점수-설계.md 2.5)의 금지어 합본.
 *  - 지표 이름 '과매수·과매도'는 검사 전에 지운다 ('매수'가 그 안에서도 걸리므로)
 *  - 과거형 사실('올랐습니다·내렸습니다')은 허용한다 ('오를·내릴'은 금지)
 *  - 미래형 끝말('~할 것·~할 가능성·~수 있습니다')은 금지하되, 상품 구조·계산 방식 설명만 허용 목록으로 둔다
 */
export const SCORE_BANNED_RE =
  /(매수|매도|사세요|파세요|살 때|팔 때|담으세요|담아|진입|청산|손절|익절|추천|유망|기회|주목|매력|목표|적정주가|적정가|적정 가격|저평가|고평가|싸다|비싸다|저렴|우량|알짜|강력|대박|급등 예상|확실|반드시|보장|안전|위험하|오를|내릴|상승할|하락할|반등|조정 가능|전망|예상|기대|상승 여력|하락 위험|비중 (확대|축소)|지금이|놓치|좋은 종목|나쁜 종목|만점)/;
export const SCORE_FUTURE_RE = /(할 것|할 가능성|수 있습니다|수 있다)/;
/** 미래형이지만 계산 방식·상품 구조 설명이라 허용하는 문장 조각 */
export const SCORE_FUTURE_ALLOW = ["차이가 커질 수 있습니다", "낮게 나올 수 있습니다", "조금 다를 수 있습니다"] as const;

/** 문장에서 걸리는 낱말들 (없으면 빈 배열) */
export function scoreWordingProblems(text: string): string[] {
  let t = text.replace(/과매수|과매도/g, "");
  const out: string[] = [];
  const banned = t.match(new RegExp(SCORE_BANNED_RE.source, "g"));
  if (banned) out.push(...banned);
  for (const ok of SCORE_FUTURE_ALLOW) t = t.split(ok).join("");
  const future = t.match(new RegExp(SCORE_FUTURE_RE.source, "g"));
  if (future) out.push(...future);
  return out;
}
