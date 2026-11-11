/**
 * 퍼센트(등락률·수익률) 표기 규칙 — 토스증권과 같이 소수 둘째 자리 아래를 0 쪽으로 버린다 (반올림하지 않는다).
 *
 * 2026-11-12 실측 (토스증권 화면·공식 계좌 API 와 대조):
 *  - 삼성전자 (208,000 − 198,900) ÷ 198,900 = 4.5751…% → 토스 +4.57% (반올림이면 +4.58%)
 *  - SK하이닉스 6.4356…% → +6.43%, NAVER 1.2953…% → +1.29%, LIG디펜스앤에어로스페이스 9.4395…% → +9.43%
 *  - 제너럴 다이내믹스 −0.4354…% → −0.43%, 메타 −0.5067…% → −0.50% (음수도 0 쪽으로)
 *  - 공식 계좌 API(/api/v1/holdings) 종목 수익률 18건: 반올림과 갈리는 15건이 모두 버림
 * 앱 lib/format.ts 의 truncPct·formatPct 와 같은 식이다 (한쪽을 바꾸면 다른 쪽도).
 */

/**
 * 부동소수 오차만 메우는 여유 (0.01% 를 1 로 본 단위). 4.58 처럼 딱 떨어지는 값이 457.99999999999994 가 되어 4.57 로 버려지지 않게.
 * 가격·기준가는 유한 소수라 진짜로 경계에 이만큼 가까운 값은 없다 (기준가가 7천만 센트여도 이웃 값과 1.4e-8 떨어져 있다)
 */
const EPS = 1e-9;

/** 퍼센트 값(예 4.5751)을 소수 둘째 자리까지 버린다 (0 쪽으로). -0 은 0 으로 */
export function truncPct(pct: number): number {
  if (!Number.isFinite(pct)) return pct;
  const scaled = pct * 100;
  const t = Math.trunc(scaled + (scaled >= 0 ? EPS : -EPS)) / 100;
  return t === 0 ? 0 : t;
}

/** (값 − 기준) ÷ 기준 을 퍼센트로 (버림). 기준이 없거나 0 이면 null */
export function changePct(value: number, base: number | null | undefined): number | null {
  if (base === null || base === undefined || !Number.isFinite(base) || base === 0 || !Number.isFinite(value)) return null;
  return truncPct(((value - base) / base) * 100);
}

/** 부분 ÷ 전체 를 퍼센트로 (버림). 전체가 0 이하·없음이면 null — 수익률(손익 ÷ 매입금액) 등 */
export function ratioPct(part: number, whole: number | null | undefined): number | null {
  if (whole === null || whole === undefined || !Number.isFinite(whole) || whole <= 0 || !Number.isFinite(part)) return null;
  return truncPct((part / whole) * 100);
}
