import type { FeatureKey, FeatureService } from "./featureService.js";

/**
 * 가치 점수 개선 1단계 (2026-09-29) 의 글 플래그 묶음. 모두 글·표시만 바꾸고 점수 숫자는 바꾸지 않는다 (시험: 켬·끔 응답의 점수 칸이 모두 같음).
 * 끄면 그 부분의 글이 지금과 한 글자도 같다. 서버 FEATURES 기본 켬 (docs/기능-플래그.md)
 */
export interface ValueTextFlags {
  /** [2] 묶음 설명 '막대가 길수록 …'·비교 시점 안내·가치 함정 표시의 방향 말 */
  directionWords: boolean;
  /** [2] 묶음 한 줄 → '막대를 길게 만든 지표 … / 짧게 만든 지표 …' */
  familyTwoSided: boolean;
  /** [3] 경기 민감 PER 줄 첫 숫자 = 최근 4분기 PER, 섞은 값은 한 줄 */
  perPlain: boolean;
  /** [3] 흑자 회사 가운데값·적자 비율·흑자 회사끼리 위치 */
  medianText: boolean;
  /** [3] 가격 안내 숫자로 (시세 표와 크게 다름 · 마지막 종가로는) */
  priceNote2: boolean;
  /** [3] 영업 외 손익 표시 기준 = 세전이익의 30% · 영업이익 기준 PER 한 줄 */
  oneOffAbs: boolean;
  /** [5] 금융사 재무 건전성 글 */
  financialNote: boolean;
  /** [5] 보험사 안내 (financialNote 와 함께) */
  insurerNote: boolean;
  /** [9] 점수 없음·대상 아님 이유 글 */
  reasonDetail: boolean;
  /** [10] 사실과 다른 설명 문장 고침 */
  wordingFacts: boolean;
}

export const VALUE_TEXT_FLAG_KEYS: Record<keyof ValueTextFlags, FeatureKey> = {
  directionWords: "valueDirectionWords",
  familyTwoSided: "valueFamilyTwoSided",
  perPlain: "valuePerPlain",
  medianText: "valueMedianText",
  priceNote2: "valuePriceNote2",
  oneOffAbs: "valueOneOffAbs",
  financialNote: "valueFinancialNote",
  insurerNote: "valueInsurerNote",
  reasonDetail: "valueReasonDetail",
  wordingFacts: "valueWordingFacts",
};

/** 모두 끈 값 (예전 글 그대로 — 순수 함수의 기본값) */
export const VALUE_TEXT_OFF: Readonly<ValueTextFlags> = Object.freeze({
  directionWords: false,
  familyTwoSided: false,
  perPlain: false,
  medianText: false,
  priceNote2: false,
  oneOffAbs: false,
  financialNote: false,
  insurerNote: false,
  reasonDetail: false,
  wordingFacts: false,
});

/** 모두 켠 값 (시험용) */
export const VALUE_TEXT_ON: Readonly<ValueTextFlags> = Object.freeze(Object.fromEntries(Object.keys(VALUE_TEXT_OFF).map((k) => [k, true])) as unknown as ValueTextFlags);

/** 서버 플래그 읽기 (읽기가 실패하면 그 글은 끔 — 예전 글) */
export async function readValueTextFlags(features: Pick<FeatureService, "enabled"> | null | undefined): Promise<ValueTextFlags> {
  if (!features) return { ...VALUE_TEXT_OFF };
  const out = { ...VALUE_TEXT_OFF };
  for (const [k, key] of Object.entries(VALUE_TEXT_FLAG_KEYS) as Array<[keyof ValueTextFlags, FeatureKey]>) out[k] = await features.enabled(key).catch(() => false);
  return out;
}
