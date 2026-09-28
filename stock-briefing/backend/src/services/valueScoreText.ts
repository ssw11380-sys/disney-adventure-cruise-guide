import { METRIC_UNIT, type MetricKey, type MetricWhy } from "../analysis/valueMetrics.js";
import { VALUE_VERSION, type CompareKey, type PeerLevel, type ValueBand, type ValueFamilyKey, type ValueFlagKey, type ValuePath } from "../analysis/valueScore.js";
import { dateKo } from "./indicatorScoreText.js";

/**
 * 가치 지표 점수 문구 (3-44 2단계). 모든 문장은 서버가 정해진 틀에 숫자를 채워 만든다 — AI 문장 없음.
 * 말투: 지금·과거 숫자의 위치만 말한다('~편입니다', '~가운데쯤입니다'). 앞날·매매·판정(싸다·비싸다·좋다)을 말하지 않는다.
 * 금지어 검사는 analysis/scoreWording (테스트가 모든 틀 조합을 돌린다)
 */

export const VALUE_BAND_LINE: Record<ValueBand, string> = {
  "높은 편": "여러 지표 순위의 평균이 높은 쪽입니다.",
  가운데쯤: "여러 지표 순위의 평균이 가운데쯤입니다.",
  "낮은 편": "여러 지표 순위의 평균이 낮은 쪽입니다.",
};

export const VALUE_FAMILY_NAME: Record<ValueFamilyKey, string> = {
  price: "주가 수준",
  quality: "수익성과 이익의 질",
  health: "재무 건전성",
  growth: "성장",
  payout: "주주환원",
};
export const VALUE_FAMILY_ABOUT: Record<ValueFamilyKey, string> = {
  price: "높을수록 이익·자산·매출에 비해 주가 수준이 낮은 편",
  quality: "높을수록 이익을 내는 효율이 높은 편",
  health: "높을수록 빚 부담이 작은 편",
  growth: "높을수록 최근 3년 늘어난 폭이 큰 편",
  payout: "높을수록 배당이 많거나 주식 수가 줄어든 편",
};

export const METRIC_NAME: Record<MetricKey, string> = {
  A1: "PER (이익 대비 주가)",
  A2: "기업가치 ÷ 영업이익",
  A3: "PBR (순자산 대비 주가)",
  A4: "PSR (매출 대비 주가)",
  A5: "잉여현금흐름 수익률",
  B1: "ROE (자기자본이익률)",
  B2: "ROIC (투하자본이익률)",
  B3: "매출총이익 ÷ 자산",
  B4: "영업이익률",
  B5: "이익 안정성 (5년 영업이익률 오르내림)",
  B6: "이익의 현금 뒷받침",
  D1: "부채비율",
  D2: "순차입금 ÷ 영업이익",
  D3: "이자보상배율",
  D4: "유동비율",
  // 한국 간이 계산(3단계): 네이버 요약에는 유동비율 대신 당좌비율(재고를 뺀 단기 자산 ÷ 단기 빚)이 있다
  D5: "당좌비율",
  C1: "매출 성장 (3년 연평균)",
  C2: "주당이익 증가폭 (3년, 규모 대비)",
  C3: "영업이익률 변화 (3년)",
  E1: "배당수익률",
  E2: "주식 수 변화 (3년 연평균)",
  F1: "ROA (총자산이익률)",
  F2: "ROE 안정성 (5년 오르내림)",
  F3: "자기자본 ÷ 총자산",
};

/** 한국 간이 계산(3단계)의 지표 이름: 네이버 요약은 연간 3개 결산이라 성장은 2년 (그 밖은 미국과 같은 이름) */
export const LITE_METRIC_NAME: Partial<Record<MetricKey, string>> = {
  C1: "매출 성장 (2년 연평균)",
  C2: "주당이익 증가폭 (2년, 순자산 대비)",
  C3: "영업이익률 변화 (2년)",
};
export const metricName = (k: MetricKey, grade?: "full" | "lite") => (grade === "lite" ? (LITE_METRIC_NAME[k] ?? METRIC_NAME[k]) : METRIC_NAME[k]);

/** 지표 위치가 높을 때 · 낮을 때 문장 (설계 value-v1 §13.3) */
const HIGH_LOW: Record<MetricKey, [string, string]> = {
  A1: ["이익에 비해 주가 수준이 낮은 편입니다.", "이익에 비해 주가 수준이 높은 편입니다."],
  A2: ["회사 전체 값에 비해 영업이익이 큰 편입니다.", "회사 전체 값에 비해 영업이익이 작은 편입니다."],
  A3: ["순자산에 비해 주가 수준이 낮은 편입니다.", "순자산에 비해 주가 수준이 높은 편입니다."],
  A4: ["매출에 비해 주가 수준이 낮은 편입니다.", "매출에 비해 주가 수준이 높은 편입니다."],
  A5: ["주가에 비해 남는 현금이 많은 편입니다.", "주가에 비해 남는 현금이 적은 편입니다."],
  B1: ["자본으로 이익을 내는 효율이 높은 편입니다.", "자본으로 이익을 내는 효율이 낮은 편입니다."],
  B2: ["사업에 넣은 돈 대비 이익이 높은 편입니다.", "사업에 넣은 돈 대비 이익이 낮은 편입니다."],
  B3: ["자산 대비 매출총이익이 큰 편입니다.", "자산 대비 매출총이익이 작은 편입니다."],
  B4: ["매출에서 남기는 영업이익 비율이 높은 편입니다.", "매출에서 남기는 영업이익 비율이 낮은 편입니다."],
  B5: ["최근 5년 이익률의 오르내림이 작은 편입니다.", "최근 5년 이익률의 오르내림이 큰 편입니다."],
  B6: ["이익이 현금으로 잘 뒷받침되는 편입니다.", "이익에 비해 들어온 현금이 적은 편입니다."],
  D1: ["자본에 비해 빚이 적은 편입니다.", "자본에 비해 빚이 많은 편입니다."],
  D2: ["영업이익에 비해 순빚 부담이 작은 편입니다(순현금 포함).", "영업이익에 비해 순빚 부담이 큰 편입니다."],
  D3: ["영업이익으로 이자를 감당할 여유가 큰 편입니다.", "영업이익으로 이자를 감당할 여유가 작은 편입니다."],
  D4: ["단기 빚에 비해 단기 자산이 넉넉한 편입니다.", "단기 빚에 비해 단기 자산이 적은 편입니다."],
  D5: ["단기 빚에 비해 재고를 뺀 단기 자산이 넉넉한 편입니다.", "단기 빚에 비해 재고를 뺀 단기 자산이 적은 편입니다."],
  C1: ["최근 3년 매출이 늘어난 속도가 빠른 편입니다.", "최근 3년 매출이 늘어난 속도가 느리거나 줄었습니다."],
  C2: ["1주당 이익이 늘어난 폭이 큰 편입니다.", "1주당 이익이 늘어난 폭이 작거나 줄었습니다."],
  C3: ["3년 전보다 영업이익률이 높아진 편입니다.", "3년 전보다 영업이익률이 낮아진 편입니다."],
  E1: ["주가에 비해 배당이 많은 편입니다.", "주가에 비해 배당이 적거나 없습니다."],
  E2: ["주식 수가 줄어든 편입니다.", "주식 수가 늘어난 편입니다."],
  F1: ["자산으로 이익을 내는 효율이 높은 편입니다.", "자산으로 이익을 내는 효율이 낮은 편입니다."],
  F2: ["최근 5년 ROE 의 오르내림이 작은 편입니다.", "최근 5년 ROE 의 오르내림이 큰 편입니다."],
  F3: ["총자산에 비해 자기자본이 두꺼운 편입니다.", "총자산에 비해 자기자본이 얇은 편입니다."],
};
/** 한국 간이 계산(3단계)의 성장 문장 — 연간 3개 결산이라 '2년' */
const LITE_HIGH_LOW: Partial<Record<MetricKey, [string, string]>> = {
  C1: ["최근 2년 매출이 늘어난 속도가 빠른 편입니다.", "최근 2년 매출이 늘어난 속도가 느리거나 줄었습니다."],
  C3: ["2년 전보다 영업이익률이 높아진 편입니다.", "2년 전보다 영업이익률이 낮아진 편입니다."],
};
const highLow = (k: MetricKey, grade?: "full" | "lite") => (grade === "lite" ? (LITE_HIGH_LOW[k] ?? HIGH_LOW[k]) : HIGH_LOW[k]);
export const metricMeaning = (k: MetricKey, grade?: "full" | "lite") => `100에 가까울수록: ${highLow(k, grade)[0].replace(/입니다\.$/, "").replace(/\.$/, "")}`;
/**
 * 한국 간이 계산(3단계)의 묶음 설명: 성장은 '최근 2년'(연간 3개 결산), 주주환원은 배당수익률 하나뿐이라 '주식 수'를 말하지 않는다
 * (간이 계산에는 주식 수 변화 지표가 없다 — 같은 카드의 KR_LITE_NOTE 와 어긋나던 것, 검토 지적)
 */
export const LITE_FAMILY_ABOUT: Partial<Record<ValueFamilyKey, string>> = {
  growth: "높을수록 최근 2년 늘어난 폭이 큰 편",
  payout: "높을수록 주가에 비해 배당이 많은 편",
};
/** 묶음 설명 (한국 간이는 LITE_FAMILY_ABOUT 먼저) */
export const familyAbout = (k: ValueFamilyKey, grade?: "full" | "lite") => (grade === "lite" ? (LITE_FAMILY_ABOUT[k] ?? VALUE_FAMILY_ABOUT[k]) : VALUE_FAMILY_ABOUT[k]);
export const MID_SENTENCE = "비교한 회사들 가운데쯤입니다.";
/** 위치 점수 → 문장 (67 이상 높을 때, 33 이하 낮을 때, 그 사이 가운데쯤) */
export function positionSentence(k: MetricKey, score: number, grade?: "full" | "lite"): string {
  const s = Math.floor(score + 0.5);
  return s >= 67 ? highLow(k, grade)[0] : s <= 33 ? highLow(k, grade)[1] : MID_SENTENCE;
}

/** 규칙 문장 (0점 · 맨 위 · 계산 안 함) */
export const RULE_TEXT: Record<MetricWhy, string> = {
  lossNi: "순이익이 0 이하라 0점으로 계산했습니다.",
  lossOp: "영업이익이 0 이하라 0점으로 계산했습니다.",
  lossFcf: "잉여현금흐름이 0 이하라 0점으로 계산했습니다.",
  capitalImpairment: "자본총계가 0 이하라(자본잠식) 0점으로 계산했습니다.",
  revenueNonPositive: "계산 안 함: 매출이 0 이하입니다.",
  netCash: "빚보다 현금이 많아(순현금) 가장 높은 순위로 두었습니다(순현금 회사끼리는 같은 순위).",
  evNonPositive: "순현금이 시가총액보다 커서 가장 높은 순위로 두었습니다(이런 회사끼리는 같은 순위).",
  noInterest: "빚이 거의 없고 이자비용이 없어 가장 높은 순위로 두었습니다(이런 회사끼리는 같은 순위).",
  equityNonPositive: "계산 안 함: 자본이 0 이하입니다.",
  smallEquity: "계산 안 함: 장부상 자본이 아주 작아(자사주 매입 등) 값이 극단적으로 나옵니다.",
  negativeEquity: "계산 안 함: 자사주 매입이 쌓여 장부상 자본이 0 이하입니다.",
  investedNonPositive: "계산 안 함: 투하자본이 0 이하입니다.",
  noGrossProfit: "계산 안 함: 매출총이익을 보고하지 않습니다.",
  fewYears: "계산 안 함: 연간 재무가 4년보다 적습니다.",
  noCapex: "계산 안 함: 설비투자 자료가 없습니다.",
  noInterestData: "계산 안 함: 빚이 있지만 이자비용 자료가 없습니다.",
  baseNonPositive: "계산 안 함: 3년 전 값이 0 이하입니다.",
  shareJump: "계산 안 함: 3년 사이 주식 수가 한 해에 50% 넘게 바뀌었습니다(분할·병합·합병 등).",
  noCurrent: "계산 안 함: 유동자산·유동부채 자료가 없습니다.",
  missing: "자료 없음",
  deepLoss: "최근 5년 가운데 절반 넘는 해에 영업손실이 매출보다 커서 0점으로 계산했습니다.",
  noDividendData: "계산 안 함: 최근 1년 안에 배당 기록이 있지만 최근 4분기 배당 합계를 만들 수 없습니다 (배당이 없다는 뜻이 아닙니다).",
};
/**
 * 같은 값이 많은 지표 (무배당 0% 등): 비교 회사의 절반 이상이 같은 값이고 이 회사 값은 그 값과 다를 때, 위치가 그 덩어리에 크게 좌우된다.
 * '배당이 많은 편' 같은 띠 문장 대신 중립 문장(지표 줄 · 화면 읽기)과 안내를 둔다 (그 지표는 묶음 머리 문장으로 고르지 않음, 검토 지적)
 */
export const tieSentence = (pct: number, valueText: string, high: boolean) =>
  `비교한 회사 ${pct >= 60 ? "대부분" : "절반 이상"}(${pct}%)이 ${valueText}${iraRa(valueText)} 위치 점수가 ${high ? "크게" : "작게"} 나왔습니다.`;
export const TIE_NOTE = "같은 값이 많아 그 값과 조금만 달라도 위치 점수가 크게 달라지므로, 많은 편·적은 편으로 나누어 말하지 않았습니다.";
/**
 * 맨 위 규칙(순현금 등) 지표의 위치 안내: 같은 규칙 회사끼리는 모두 같은 순위라, 보이는 위치는 그 무리의 가운데 값이다
 * (p = 100 × (아래 회사 + 0.5 × 같은 회사) / N → 같은 회사 비율 = 2 × (100 − p) / 100). 규칙 문장 '가장 높은 순위'와 보이는 위치(예: 68)가 어긋나 보이지 않게
 */
export const topTieNote = (groupName: string, sharePct: number, pos: number) =>
  `${groupName} 비교 회사의 ${sharePct}%가 같은 맨 위 순위라, ${groupName} 안 위치는 그 무리의 가운데 값(${pos})입니다.`;
/** 연간 재무로 계산한 지표(성장 3년 · 이익·ROE 안정성 5년 · 주식 수 변화 3년)의 기준 — 최근 4분기 값으로 읽히지 않게 */
export const annualBasis = (end: string) => `${end.slice(0, 4)}년 ${Number(end.slice(5, 7))}월 결산 연간 기준`;
export const NOT_ADOPTED = "비교할 회사 자료가 모자라(70% 미만) 이 지표는 쓰지 않았습니다.";
/** 경기 민감 회사의 PER: 최근 4분기 이익과 5년 평균 이익을 반씩 섞음 (설계 value-v1 §5.1) */
export const BLEND_NOTE = "업황에 따라 이익이 크게 오르내리는 회사라, 최근 4분기 이익과 5년 평균 이익을 반씩 섞어 계산했습니다.";
export const NO_DATA = "자료 없음";

export const VALUE_FLAG_TEXT: Record<Exclude<ValueFlagKey, "peerFallback" | "carriedForward" | "thinEquity">, string> = {
  cyclicalPeak: "이익이 최근 몇 년 중 가장 높은 수준입니다. 업황에 따라 이익이 크게 오르내리는 회사는 이익이 많을 때 PER이 낮게 보이는 경향이 있습니다.",
  cyclicalTrough: "이익이 최근 몇 년 중 가장 낮은 수준입니다. 이런 때는 PER이 높게 보이거나 계산되지 않는 경향이 있습니다.",
  valueTrap: "주가 수준 점수는 높지만 이익이 줄고 있거나 재무 부담이 커서, 이 숫자만으로 판단하기 어렵습니다.",
  oneOff: "영업 외 손익이 커서 순이익 기준 지표(PER·ROE)가 영업이익 기준 지표와 차이가 큽니다.",
  sbcHeavy: "주식 보상 비용이 커서 잉여현금흐름이 실제 주주 몫보다 좋아 보일 수 있습니다. 늘어난 주식 수는 주주환원 점수에 반영됩니다.",
  smallEquity: "자사주 매입 등으로 장부상 자본이 작아 ROE가 극단적으로 나옵니다. ROE 대신 투하자본이익률로 봅니다.",
  negativeEquity: "자사주 매입이 쌓여 장부상 자본이 0 이하입니다. PBR·ROE·부채비율은 계산하지 않습니다.",
  capitalImpairment: "자본총계가 0 이하입니다(자본잠식). 재무 건전성 점수에 크게 반영됩니다.",
  earlyStage: "아직 영업이익이 나지 않는 회사는 이 점수 방식으로는 낮게 나오는 것이 보통입니다.",
  payoutOver100: "최근 4분기에 번 이익보다 많은 금액을 배당했습니다.",
  dividendCut: "최근 5년 가운데 1주당 배당이 앞 해보다 줄어든 해가 있습니다.",
  financial: "금융사(은행·보험 등)는 매출·현금흐름·부채비율의 뜻이 달라 금융사끼리 비교하고, 묶음 비중도 따로 씁니다(주가 수준 35 · 수익성 30 · 건전성 10 · 성장 15 · 주주환원 10).",
};
export const peerFallbackText = (level: PeerLevel, sectorKo: string | null, path: ValuePath = "general") =>
  `같은 업종 회사가 적어 ${level === "sector" ? `같은 부문(${sectorKo ?? "부문"}) 전체` : path === "financial" ? "금융사 전체" : "시장 전체"}와 비교했습니다.`;
export const carriedText = (fetchedAt: string) => `재무 숫자는 ${dateKo(fetchedAt.slice(0, 10))}에 받은 값입니다 (그 뒤 새로 받지 못함).`;

/**
 * 점수 없는 줄의 이유 글 (상태 글 '계산 준비 중'·'잠시 보류' 등은 label 에 따로 — 이유 글 앞에 다시 쓰지 않는다, 검토 지적).
 * '… 중입니다'는 서버가 실제로 받는·만드는 중일 때만 (앱은 그동안만 1분마다 다시 묻는다)
 */
export const VALUE_STATUS_TEXT = {
  /** 첫 비교 기준을 지금 만드는 중 (비교 기준이 없으면 화면 요청이 백그라운드로 만들기를 건다 — 30분에 한 번까지) */
  pendingReference: "첫 비교 기준을 만드는 중입니다 (보통 몇 분 안)",
  /** 비교 기준이 2주 넘게 묵어 지금 새로 만드는 중 */
  rebuildingReference: "비교 기준을 새로 만드는 중입니다 (보통 몇 분 안)",
  pendingFacts: "재무제표를 처음 받는 중입니다 (보통 몇 분 안)",
  /** 재무를 받은 지 7일이 넘었지만 받기에 실패한 적은 없음 (오랜만에 연 종목 — 백그라운드로 새로 받는 중) */
  pendingRefresh: "재무제표를 새로 받는 중입니다 (보통 몇 분 안)",
  /** 비교 기준을 만들지 못함 (마지막 만들기 실패 — 열면 30분에 한 번까지 다시, 그리고 매일 09:15) */
  referenceFailed: "비교 기준을 만들지 못했습니다. 잠시 뒤 다시 만듭니다",
  /** 비교 기준이 없고 지금 만드는 중도 아님 (방금 만들기를 건 뒤 30분 안) */
  referenceMissing: "비교 기준이 아직 없습니다. 잠시 뒤 다시 만듭니다",
  /** 가치 부분을 끈 서버 (되돌리기 스위치 valueScore) */
  off: "가치 지표 점수는 지금 계산하지 않습니다.",
  /** 가치 부분을 끈 서버의 상태 글 (label) — 이유 글 '지금 계산하지 않습니다'와 맞춘다 (검토 지적: '계산 준비 중'과 어긋남) */
  offLabel: "지금 계산하지 않음",
  /** 한국 종목 가치 부분을 끈 서버 (되돌리기 스위치 krValueScore) — 3단계가 나간 뒤라 '다음 단계에서'라고 쓰지 않는다 */
  krOff: "한국 종목 가치 지표 점수는 지금 계산하지 않습니다.",
  /** 네이버 재무 요약이 없는 종목 (새로 상장한 회사 등) */
  krNotFound: "네이버 재무 요약을 찾지 못했습니다 (새로 상장한 회사 등)",
  /** 네이버 재무 요약을 처음 받는 중 (백그라운드) */
  krPendingFacts: "재무 요약을 처음 받는 중입니다 (보통 몇 분 안)",
  /** 재무 요약에 최근 4개 분기 실적이 모자람 (분기 실적이 빠진 회사·새로 상장한 회사) */
  krNoData: "재무 요약에 최근 4개 분기 실적이 모자라 계산하지 않았습니다",
  krFiscalOld: "최근 분기 재무가 18개월보다 오래되었습니다",
  spac: "스팩(기업인수목적회사)은 이 점수를 내지 않습니다.",
  preferred: "우선주는 아직 계산하지 않습니다. 보통주 화면의 점수를 참고하세요.",
  reit: "리츠는 전용 지표가 필요해 아직 계산하지 않습니다.",
  clearance: "정리매매 종목은 이 점수를 내지 않습니다.",
  notListed: "SEC 재무제표를 찾지 못했습니다 (외국 회사·새로 상장한 회사 등)",
  /** 재무를 받은 뒤 SEC 목록에서 빠짐 (7일 넘게) — 처음부터 없던 것과 까닭이 달라 따로 (검토 지적) */
  notListedAfter: "SEC 재무제표를 찾지 못했습니다 (상장 폐지·합병·티커 변경 등)",
  noUsGaap: "달러로 보고한 미국 회계기준(US GAAP) 재무가 없어 계산하지 않았습니다",
  fiscalOld: "최근 연간 재무가 18개월보다 오래되었습니다",
  priceInvalid: "주가 수준을 계산할 재무 숫자가 없습니다",
  fewFamilies: "계산할 수 있는 묶음이 3개보다 적습니다",
  referenceOld: "비교 기준이 2주 넘게 갱신되지 않았습니다",
  factsFailed: "재무제표를 받지 못했습니다. 잠시 뒤 다시 계산합니다",
  priceStale: "최근 주가가 없어 계산하지 않았습니다 (거래정지 등)",
  priceFailed: "일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다",
  hold: "주식 분할·병합 반영을 확인하는 중입니다",
  /** SEC 주식 수가 지금 주식 수(Nasdaq 시가총액 ÷ 가격)와 크게 다름 — 마지막 보고서 뒤 분할·병합 등 */
  sharesMismatch: "마지막 재무제표의 주식 수가 지금 주식 수와 크게 달라(주식 분할·병합 등) 다음 보고서를 기다립니다",
} as const;
export const lowCoverageText = (pct: number) => `쓸 수 있는 지표가 모자랍니다 (필요한 비중 70, 지금 ${pct})`;
export const PARTIAL_BADGE = "일부 지표 없이 계산";
export const carriedBadge = (fetchedAt: string) => `지난 값 ${Number(fetchedAt.slice(5, 7))}/${Number(fetchedAt.slice(8, 10))}`;
export const PRICE_NOTE = "점수용 값은 최근 20거래일 평균 가격 기준이라 위 시세 표의 PER·PBR과 조금 다를 수 있습니다.";
export const PEER_TIMING_NOTE =
  "비교 회사 값은 각 회사의 가장 최근 회계연도 값(SEC 공통 자료)이고, 이 회사 값은 최근 4분기 값입니다. 이익이 빠르게 늘고 있는 회사는 이 차이로 주가 수준 점수가 조금 높게 계산되는 편입니다.";
export const VALUE_DETAIL_NOTE = "과거·현재 숫자로 계산한 지표이며 앞으로의 가격이나 수익을 뜻하지 않습니다.";

export const valueHeadline = (v: number, band: ValueBand) => `가치 지표 점수 ${v}/100 · ${band}`;

/** 재무 기준 이름: '2026년 7월까지 최근 4분기' · '2026년 6월 결산 연간' */
export function fiscalLabel(end: string, basis: "FY" | "TTM"): string {
  const y = end.slice(0, 4);
  const m = Number(end.slice(5, 7));
  return basis === "FY" ? `${y}년 ${m}월 결산 연간` : `${y}년 ${m}월까지 최근 4분기`;
}
/** 요약 카드 날짜 줄 뒤에 붙는 짧은 재무 기준: '재무 2026년 7월까지 4분기' · '재무 2026년 6월 결산' */
export const fiscalShort = (end: string, basis: "FY" | "TTM") => `재무 ${end.slice(0, 4)}년 ${Number(end.slice(5, 7))}월${basis === "FY" ? " 결산" : "까지 4분기"}`;

export function valueDatesLine(a: { priceThrough: string; fiscalEnd: string; basis: "FY" | "TTM"; filed: string; reference: string }): string {
  return `주가 ${dateKo(a.priceThrough)}까지 20거래일 평균 · 재무 ${fiscalLabel(a.fiscalEnd, a.basis)}, ${dateKo(a.filed)} 제출 · 비교 기준 ${dateKo(a.reference)}`;
}

/** 앞말의 마지막 한글 글자에 받침이 있으면 '이라', 없거나 한글이 아니면(0.0% 등) '라' */
export function iraRa(word: string): "이라" | "라" {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? "이라" : "라";
}

/** 쓴 비교만 적는 머리 문장 (first: 첫 무리 글을 바꿔 쓸 때 — 금융사 '은행 · Nasdaq 분류, 228곳 — …', 가치 점수 개선 1단계 [5]) */
export function peerLine(p: { level: PeerLevel; nameKo: string | null; n: number; own: boolean; path: ValuePath; first?: string }): string {
  const first =
    p.first ??
    (p.level === "industry"
      ? `같은 업종(${p.nameKo ?? "업종"}, ${p.n}개 회사)`
      : p.level === "sector"
        ? `같은 부문(${p.nameKo ?? "부문"}, ${p.n}개 회사)`
        : `미국 상장 ${p.path === "financial" ? "금융사" : "회사"} ${p.n}개`);
  const parts = [first, p.level === "market" ? null : p.path === "financial" ? "금융사 전체" : "같은 시장", p.own ? "이 회사의 지난 5년" : null].filter(Boolean);
  const joined = parts.join("·");
  return `${joined}${gwaWa(joined)} 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다.`;
}

/** 앞말의 마지막 한글 글자에 받침이 있으면 '과', 없으면 '와' (괄호·숫자 같은 한글 아닌 글자는 건너뜀) */
export function gwaWa(word: string): "과" | "와" {
  for (let i = word.length - 1; i >= 0; i--) {
    const c = word.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? "와" : "과";
  }
  return "와";
}

/** 비교 시장: 미국(US — 이름에 나라를 붙이지 않음) · 한국(KR — '한국 시장'·'한국 금융사 전체', 설명 줄·머리 문장과 같은 이름) */
export type NameMarket = "US" | "KR";
/**
 * 비교 무리 이름: 업종 · 부문 · 시장 (금융사 경로의 '시장'은 '금융사 전체' — 금융사끼리만 비교하므로, 검토 지적).
 * 한국 종목은 '한국 시장'·'한국 금융사 전체' — 같은 카드의 설명 줄·머리 문장·표시가 그렇게 부른다 (지표 줄만 '시장'이던 것, 검토 지적)
 */
export const marketName = (path: ValuePath, market: NameMarket = "US") => `${market === "KR" ? "한국 " : ""}${path === "financial" ? "금융사 전체" : "시장"}`;
export const levelName = (level: PeerLevel | null, path: ValuePath, market: NameMarket = "US") => (level === "sector" ? "부문" : level === "market" ? marketName(path, market) : "업종");
/**
 * 쓴 비교 비중: '업종 50 · 시장 20 · 지난 5년 30' (없는 비교는 비례 배분한 값, 금융사는 '금융사 전체 20', 한국은 '한국 시장 29').
 * 업종 자리가 시장으로 내려가면(같은 업종 회사가 적음) 두 비교가 같은 무리라 한 항목으로 합친다 — '시장 50 · 시장 50' 대신 '시장 100' (검토 지적)
 */
export function mixText(mix: Partial<Record<CompareKey, number>>, level: PeerLevel | null, path: ValuePath = "general", market: NameMarket = "US"): string {
  const name = (k: CompareKey) => (k === "industry" ? levelName(level, path, market) : k === "market" ? marketName(path, market) : "지난 5년");
  const sums = new Map<string, number>();
  for (const k of Object.keys(mix) as CompareKey[]) sums.set(name(k), (sums.get(name(k)) ?? 0) + mix[k]!);
  return [...sums].map(([n, w]) => `${n} ${Math.round(w)}`).join(" · ");
}
/**
 * 위치 줄: '업종 안 위치 72/100 · 시장 안 64/100 · 지난 5년 중 31/100' (금융사는 '금융사 전체 안', 한국은 '한국 시장 안').
 * profit 이 있으면 업종·시장 위치 옆에 '(흑자 회사끼리 59)' (가치 점수 개선 1단계 [3] — 없으면 예전 글 그대로)
 */
export function positionText(pos: Partial<Record<CompareKey, number>>, level: PeerLevel | null, path: ValuePath = "general", market: NameMarket = "US", profit?: Partial<Record<CompareKey, number>>): string {
  const bits: string[] = [];
  const withProfit = (s: string, k: CompareKey) => (profit?.[k] !== undefined ? profitPosText(s, profit[k]!) : s);
  if (pos.industry !== undefined) bits.push(withProfit(`${levelName(level, path, market)} 안 위치 ${Math.floor(pos.industry + 0.5)}/100`, "industry"));
  if (pos.market !== undefined && level !== "market") bits.push(withProfit(`${marketName(path, market)} 안 ${Math.floor(pos.market + 0.5)}/100`, "market"));
  if (pos.own !== undefined) bits.push(`지난 5년 중 ${Math.floor(pos.own + 0.5)}/100`);
  return bits.join(" · ");
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const signed = (v: number) => `${v < 0 ? "−" : ""}${f1(Math.abs(v))}`;
/** 화면 값 → 글 ('32.1배', '12.3%', '−2.0%p') */
export function formatMetric(k: MetricKey, show: number | null): string | null {
  if (show === null || !Number.isFinite(show)) return null;
  const u = METRIC_UNIT[k];
  if (u === "배") return `${Math.abs(show) >= 1000 ? Math.round(show).toLocaleString("en-US") : signed(show)}배`;
  return `${Math.abs(show) >= 1000 ? Math.round(show).toLocaleString("en-US") : signed(show)}${u}`;
}

/** 순위용 값 → 화면 값 (가운데값 표시용) */
export function showOf(k: MetricKey, x: number | null): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  switch (k) {
    case "A1":
    case "A2":
    case "A3":
    case "A4":
      return x > 0 ? 1 / x : null;
    case "D2":
      return -x;
    case "D3":
      return x;
    case "B5":
    case "B6":
    case "D1":
    case "E2":
    case "F2":
      return -100 * x;
    default:
      return 100 * x;
  }
}
/**
 * 가운데값 글 (±∞ 는 규칙 이름으로, 배수가 100배를 넘으면 '100배 넘음' — 적자 회사가 많은 업종은 이익 대비 배수의 가운데값이 아주 커진다).
 * cap = false 면 100배가 넘어도 숫자 그대로 (흑자 회사 가운데값 — 가치 점수 개선 1단계 [3])
 */
export function medianText(k: MetricKey, x: number | null, cap = true): string | null {
  if (x === null) return null;
  if (cap && METRIC_UNIT[k] === "배" && (k === "A1" || k === "A2" || k === "A3" || k === "A4") && x > 0 && 1 / x > 100) return "100배 넘음";
  if (x === Infinity) return k === "D2" ? "순현금" : k === "D3" ? "이자 없음" : "맨 위";
  if (x === -Infinity || ((k === "A1" || k === "A2") && x <= 0)) return k === "A1" ? "적자" : k === "A2" ? "영업적자" : "0점 규칙";
  return formatMetric(k, showOf(k, x));
}

/** 지난주 대비 바뀐 이유 (상세 카드만, 화면 정수 차이가 5점 넘을 때) */
export function valueChangeText(c: { from: string; diff: number; family: ValueFamilyKey; familyDiff: number; cause: string }): string {
  const fd = c.familyDiff === 0 ? "0" : `${c.familyDiff > 0 ? "+" : "−"}${Math.abs(c.familyDiff)}`;
  return `지난주 ${dateKo(c.from)}보다 점수가 ${Math.abs(c.diff)}점 ${c.diff > 0 ? "높아졌습니다" : "낮아졌습니다"}. 가장 크게 바뀐 묶음은 ${VALUE_FAMILY_NAME[c.family]}(${fd}점)이고, ${c.cause}`;
}
export const causeFiling = (form: string, filed: string) => `새 보고서(${form}, ${dateKo(filed)} 제출)가 반영되었습니다.`;
export const causePrice = (pct: number) => `최근 20거래일 평균 주가가 ${f1(Math.abs(pct))}% ${pct >= 0 ? "올랐습니다" : "내렸습니다"}.`;
export const causeReference = (ref: string) => `비교 기준(업종 분포)이 ${dateKo(ref)}에 새로 만들어졌습니다.`;

/** 종합 지표 차이 안내 */
export const gapText = (d: number) => `두 점수의 차이가 ${d}점이라 평균만으로는 상태가 잘 드러나지 않습니다. 두 점수를 함께 보세요.`;

export function valueVersionLine(ref: string | null): string {
  return [`계산 방식 ${VALUE_VERSION}`, "재무 SEC(미국 증권거래위원회) 공시", "업종 분류 Nasdaq", ref ? `비교 기준 ${dateKo(ref)}` : null].filter(Boolean).join(" · ");
}

/**
 * 구성·계산 방법 (2단계: 가치·추세·종합, 3단계: 한국 간이 — kr 이 꺼져 있으면 한국은 '지금 계산하지 않습니다').
 * 첫 줄은 미국 종목 계산이라고 밝히고, 한국 줄에 지표 수(일반 11 · 금융사 8)와 '지난 5년 비교 없음'을 적는다 — 한국 카드에서 '약 20개 ·
 * 지난 5년과 비교'로 읽히던 것 (검토 지적)
 */
export function howLinesV2(kr = true, opts: { gapHide?: boolean } = {}): string[] {
  const lines = [
    "가치(미국 종목): 재무 숫자 약 20개를 같은 업종·시장 회사들(그리고 이 회사의 지난 5년)과 비교한 순위를, 5개 묶음 비중으로 평균했습니다. 여러 순위의 평균이라 아주 높거나 낮은 점수는 드뭅니다.",
    "가치 묶음 비중: 주가 수준 30 · 수익성과 이익의 질 25 · 재무 건전성 20 · 성장 15 · 주주환원 10 (금융사는 35 · 30 · 10 · 15 · 10).",
    "추세: 최근 약 1년 일봉으로 16개 항목을 고정된 기준에 따라 계산했습니다. 50은 '뚜렷한 추세 없음'이고, 최근 5거래일 점수의 평균을 보여 줍니다.",
    "추세와 모멘텀 묶음(합쳐 70%)은 서로 겹치는 흐름을 봅니다. 여러 지표를 섞었지만 몇 가지 흐름이 겹칩니다.",
    "종합: 화면에 보이는 두 점수를 더해 2로 나눈 값입니다. 두 점수는 만드는 방식이 달라(가치는 다른 회사와 비교한 순위, 추세는 고정 기준) 평균의 뜻은 제한적입니다.",
    "비중은 설명하기 쉽도록 정한 설계값이며, 과거 수익률에 맞춰 고르지 않았습니다. 몇 점 차이는 큰 뜻이 없습니다.",
    kr
      ? "가치(한국 종목): 네이버 증권 재무 요약(최근 5개 분기·3개 결산)으로 간이 계산합니다('간이 계산' 표시). 재무 숫자 11개(금융사는 8개)를 같은 업종·한국 시장 회사들과만 비교하고, 이 회사의 지난 5년과는 비교하지 않습니다. 잉여현금흐름·기업가치 같은 몇 지표는 빠집니다."
      : "한국 종목 가치 지표 점수는 지금 계산하지 않습니다.",
    "한국 종목과 미국 종목은 쓰는 재무 자료와 비교 대상이 달라, 서로의 가치 지표 점수를 견주지 않습니다.",
    "지난 약 11년 미국·한국 대형주 자료로 맞춰 보니, 점수가 높았던 종목이 그 뒤 더 오른 관계는 우연과 구별하기 어려울 만큼 약했습니다. 가치 지표를 흉내 낸 간이 계산으로 맞춰 본 기간에는 점수가 높았던 종목이 오히려 덜 올랐습니다.",
    kr
      ? "증권사가 낸 앞날 추정 숫자와 의견은 쓰지 않았습니다. 이미 발표된 재무(미국 SEC 제출 · 한국 네이버 재무 요약의 실적 열)와 이미 거래된 가격만 썼습니다."
      : "증권사가 낸 앞날 추정 숫자와 의견은 쓰지 않았습니다. SEC 에 이미 제출된 재무와 이미 거래된 가격만 썼습니다.",
    "장 마감 뒤 하루 한 번 바뀝니다(한국 20:10, 미국은 한국 시간 아침). 장중에는 그대로입니다. 비교 기준(업종 분포)은 주 1회 바뀝니다.",
  ];
  // 가치 점수 개선 1단계 [4] (compositeGapHide): 종합 줄에 '30점 넘게 벌어지면 숫자 대신 까닭' 한 문장
  if (opts.gapHide) lines[4] = `${lines[4]} ${HOW_GAP_HIDE}`;
  return lines;
}

/** Nasdaq 부문·업종 이름 → 한국어 (없으면 원래 이름) */
const SECTOR_KO: Record<string, string> = {
  Technology: "기술",
  Finance: "금융",
  "Health Care": "헬스케어",
  "Consumer Discretionary": "경기소비재",
  "Consumer Staples": "필수소비재",
  Industrials: "산업재",
  Energy: "에너지",
  Utilities: "유틸리티",
  "Real Estate": "부동산",
  "Basic Materials": "소재",
  Telecommunications: "통신",
  Miscellaneous: "기타",
};
const INDUSTRY_KO: Record<string, string> = {
  Semiconductors: "반도체",
  "Computer Software: Prepackaged Software": "소프트웨어",
  "Computer Software: Programming Data Processing": "인터넷·소프트웨어 서비스",
  "Computer Manufacturing": "컴퓨터·하드웨어 제조",
  "EDP Services": "IT 서비스",
  "Major Banks": "대형 은행",
  Banks: "은행",
  "Commercial Banks": "상업 은행",
  "Savings Institutions": "저축 기관",
  "Investment Bankers/Brokers/Service": "증권·투자은행",
  "Investment Managers": "자산운용",
  "Finance: Consumer Services": "금융 서비스",
  "Life Insurance": "생명보험",
  "Property-Casualty Insurers": "손해보험",
  "Auto Manufacturing": "자동차 제조",
  "Business Services": "비즈니스 서비스",
  "Biotechnology: Pharmaceutical Preparations": "제약",
  "Biotechnology: Biological Products (No Diagnostic Substances)": "바이오",
  "Medical/Dental Instruments": "의료기기",
  "Oil & Gas Production": "석유·가스 생산",
  "Integrated oil Companies": "종합 석유",
  "Industrial Machinery/Components": "산업 기계",
  "Electric Utilities: Central": "전력",
  "Telecommunications Equipment": "통신 장비",
  "Radio And Television Broadcasting And Communications Equipment": "통신·방송 장비",
  "Electronic Components": "전자 부품",
  "Computer peripheral equipment": "컴퓨터 주변기기",
  Restaurants: "외식",
  "Catalog/Specialty Distribution": "온라인·통신 판매",
  "Department/Specialty Retail Stores": "소매",
  "Aerospace": "항공우주",
  "Military/Government/Technical": "방산·정부 기술",
  "Beverages (Production/Distribution)": "음료",
  "Packaged Foods": "가공식품",
  "Package Goods/Cosmetics": "생활용품·화장품",
  "Retail: Computer Software & Peripheral Equipment": "소프트웨어·기기 소매",
};
export const sectorKo = (s: string | null) => (s ? (SECTOR_KO[s] ?? s) : null);
export const industryKo = (s: string | null) => (s ? (INDUSTRY_KO[s] ?? s) : null);

// ── 가치 점수 개선 1단계 (2026-09-29, 검토 보고서 개선안 — 글만, 점수 그대로) ─────────────
// 플래그마다 나눈 글 (services/valueTextFlags). 끄면 위의 예전 글을 그대로 쓴다

/** [2] 방향 말 (valueDirectionWords): 묶음 설명을 '막대가 길수록'으로 — '높은 편'이 싸다·좋다로 번갈아 읽히던 것 (검토: 26/50종목) */
export const DIRECTION_ABOUT: Record<ValueFamilyKey, string> = {
  price: "막대가 길수록: 이익·순자산·매출에 비해 주가가 낮은 쪽 (비교 회사 기준)",
  quality: "막대가 길수록: 이익을 내는 효율이 높은 쪽",
  health: "막대가 길수록: 빚 부담이 작은 쪽",
  growth: "막대가 길수록: 최근 3년 늘어난 폭이 큰 쪽",
  payout: "막대가 길수록: 배당이 많거나 주식 수가 줄어든 쪽",
};
/** 금융사 경로의 주가 수준은 PER·PBR 뿐 (매출 대비 없음) */
export const DIRECTION_ABOUT_FIN_PRICE = "막대가 길수록: 이익·순자산에 비해 주가가 낮은 쪽 (비교 회사 기준)";
/** 한국 간이 (성장 2년 · 주주환원은 배당 하나) */
export const LITE_DIRECTION_ABOUT: Partial<Record<ValueFamilyKey, string>> = {
  growth: "막대가 길수록: 최근 2년 늘어난 폭이 큰 쪽",
  payout: "막대가 길수록: 주가에 비해 배당이 많은 쪽",
};
/** [5] 금융사 재무 건전성 묶음 설명 (valueFinancialNote) — '빚 부담'이 아니라 자기자본 ÷ 총자산 하나 */
export const FIN_HEALTH_ABOUT = "막대가 길수록: 총자산에 비해 자기자본 여유가 큰 쪽";

/** 묶음 설명: 플래그·경로·등급에 맞춰 (둘 다 끄면 예전 familyAbout 그대로) */
export function familyAboutOf(k: ValueFamilyKey, o: { grade?: "full" | "lite" | undefined; path?: ValuePath | undefined; direction?: boolean | undefined; financial?: boolean | undefined }): string {
  if (o.financial && o.path === "financial" && k === "health") return FIN_HEALTH_ABOUT;
  if (!o.direction) return familyAbout(k, o.grade);
  if (k === "price" && o.path === "financial") return DIRECTION_ABOUT_FIN_PRICE;
  return o.grade === "lite" ? (LITE_DIRECTION_ABOUT[k] ?? DIRECTION_ABOUT[k]) : DIRECTION_ABOUT[k];
}

/** [2] 비교 시점 안내 (방향 말 + 내부 이름 'SEC 공통 자료' 뺌) */
export const PEER_TIMING_NOTE_V2 =
  "비교 회사 값은 각 회사의 가장 최근 회계연도 값이고, 이 회사 값은 최근 4분기 값입니다. 이익이 빠르게 늘고 있는 회사는 이 차이로 주가 수준 막대가 조금 길게(이익에 비해 주가가 실제보다 낮아 보이는 쪽으로) 계산되는 편입니다.";
/** [2] 가치 함정 표시 (방향 말) */
export const VALUE_TRAP_V2 = "주가 수준 막대는 길지만(이익·순자산·매출에 비해 주가가 낮은 쪽) 이익이 줄고 있거나 재무 부담이 커서, 이 숫자만으로 판단하기 어렵습니다.";

/** [2] 두 쪽 문장 (valueFamilyTwoSided): 위치 67 이상 · 33 이하 지표를 가장 튀는 순으로 */
export const TWO_SIDED_LONG = "막대를 길게 만든 지표";
export const TWO_SIDED_SHORT = "막대를 짧게 만든 지표";
/** 67 이상 · 33 이하 지표가 없을 때: 가운데쯤 지표를 그대로 적는다 */
export const TWO_SIDED_MID = "가운데쯤(34~66)인 지표";
/**
 * 두 쪽 문장의 지표 하나 'PER 70점': 숫자가 PER 배수가 아니라 위치 점수라는 것을 '점'으로 붙이고('PER 70'을 'PER 70배'로 읽지 않게 — 바로 아래 PER 줄은 27.9배,
 * 검토 지적 · 화면 읽기도 같은 글), 이름과 숫자 사이는 줄바꿈 없는 빈칸(U+00A0)이라 좁은 화면에서 'PER' / '70점'으로 갈리지 않는다. tag 는 '(적자)' 같은 사실
 */
export const twoSidedItem = (name: string, score: number, tag = "") => `${name}\u00a0${score}점${tag}`;
type TwoSidedItem = readonly [name: string, score: number, tag?: string];
export const twoSidedMidLine = (items: ReadonlyArray<TwoSidedItem>) => `${TWO_SIDED_MID}: ${items.map(([n, s, t]) => twoSidedItem(n, s, t)).join(" · ")}`;
export const twoSidedLine = (long: boolean, items: ReadonlyArray<TwoSidedItem>) => `${long ? TWO_SIDED_LONG : TWO_SIDED_SHORT}: ${items.map(([n, s, t]) => twoSidedItem(n, s, t)).join(" · ")}`;
/** 지표 짧은 이름 ('PER (이익 대비 주가)' → 'PER', '매출 성장 (3년 연평균)' → '매출 성장') */
export const shortMetricName = (k: MetricKey, grade?: "full" | "lite") => metricName(k, grade).replace(/ \([^)]*\)$/, "");

/** [3] PER 줄 (valuePerPlain): 첫 숫자는 남과 같은 최근 4분기 PER */
export const PER_PLAIN_TAG = "(최근 4분기 · 흔히 쓰는 계산)";
export const blendRankNote = (blended: string, why: string) => `순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 ${blended}를 썼습니다(${why}).`;
/** 섞은 이익이 0 이하일 때 (인텔: 최근 4분기도 적자) */
export const blendRankZeroNote = (why: string, plainLoss: boolean) =>
  `순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 값을 썼습니다(${why}). 섞은 이익${plainLoss ? "도" : "이"} 0 이하라 0점입니다.`;
/** 경기 민감 까닭 — 예전 말 (valueWordingFacts 꺼짐) */
export const CYCLICAL_WHY_OLD = "업황에 따라 이익이 크게 오르내리는 회사라";
/** [10] 경기 민감 까닭 (valueWordingFacts): 업종 목록이면 업종, 이익률 기준이면 실제 숫자 (팔란티어가 '업황에 따라…'로 읽히던 것) */
export function cyclicalWhy(c: { byIndustry: boolean; lo: number | null; hi: number | null }): string {
  if (c.byIndustry || c.lo === null || c.hi === null) return "업황에 따라 이익이 크게 오르내리는 업종이라";
  return `최근 5년 영업이익률이 가장 낮은 해 ${signedPct(c.lo)}%, 가장 높은 해 ${signedPct(c.hi)}%로 오르내림이 커서`;
}
/** 섞기 안내 (valuePerPlain 꺼짐, valueWordingFacts 켬) */
export const blendNoteOf = (why: string) => `${why}, 최근 4분기 이익과 5년 평균 이익을 반씩 섞어 계산했습니다.`;
const signedPct = (v: number) => `${v < 0 ? "−" : ""}${(Math.round(Math.abs(v) * 10) / 10).toFixed(1)}`;

/** [3] 적자 회사 덩어리 (valueMedianText) — 적자 비율이 이보다 크면 위치 옆에 흑자 회사끼리 위치 */
export const LOSS_NOTE_SHARE = 0.1;
export function profitMedianText(k: MetricKey, median: string, lname: string, n: number, lossPct: number): string {
  const op = k === "A2";
  return `${op ? "영업이익 " : ""}흑자 회사 가운데값 ${median} · 비교한 ${lname} ${n.toLocaleString("en-US")}곳 중 ${lossPct}%는 ${op ? "영업적자" : "적자"}`;
}
export const profitPosText = (base: string, p: number) => `${base} (흑자 회사끼리 ${Math.floor(p + 0.5)})`;
/** 흑자 회사끼리 보면 띠가 달라질 때의 문장 */
export function lossClumpSentence(k: MetricKey, lossPct: number, profitScore: number, grade?: "full" | "lite"): string {
  const s = Math.floor(profitScore + 0.5);
  const tail = s >= 67 ? highLow(k, grade)[0] : s <= 33 ? highLow(k, grade)[1] : "가운데쯤입니다.";
  return `비교한 회사의 ${lossPct}%가 ${k === "A2" ? "영업적자" : "적자"}라 위치 점수가 크게 나왔습니다. 흑자 회사끼리 보면 ${tail}`;
}

/** [3] 가격 안내 (valuePriceNote2) */
export const PRICE_NOTE_BASE = "PER·PBR은 최근 20거래일 평균 주가로 계산했습니다.";
export const PRICE_NOTE_BLEND = "이 종목의 PER은 순위용 계산이 달라 시세 표와 크게 다릅니다(아래 PER 줄에 두 값을 함께 적었습니다).";
export const PRICE_NOTE_SMALL = "시세 표의 PER·PBR은 그날 가격이라 조금 다를 수 있습니다.";
/** 20거래일 평균과 마지막 종가가 이 비율보다 크게 다르면 그 가격의 PER·PBR 한 줄 (메타 14%·인텔 18%) */
export const CLOSE_GAP_NOTE = 0.05;
export function closeGapText(date: string, pct: number, per: string | null, pbr: string | null): string | null {
  const vals = [per ? `PER ${per}` : null, pbr ? `PBR ${pbr}` : null].filter(Boolean);
  if (!vals.length) return null;
  return `${dateKo(date)} 종가가 20거래일 평균보다 ${(Math.round(Math.abs(pct) * 10) / 10).toFixed(1)}% ${pct >= 0 ? "높아" : "낮아"}, 그 가격으로는 ${vals.join(" · ")}입니다.`;
}
export function priceNoteV2(o: { blend: boolean; close: string | null }): string {
  return [PRICE_NOTE_BASE, o.blend ? PRICE_NOTE_BLEND : null, o.close ?? (o.blend ? null : PRICE_NOTE_SMALL)].filter(Boolean).join(" ");
}

/**
 * [3] 영업 외 손익 (valueOneOffAbs): 영업 외 **이익**(세전이익 − 영업이익)이 세전이익의 30% 이상이면 표시 + PER 줄에 영업이익 기준 PER (알파벳 17.2 ↔ 35.0배).
 * 영업 외 **손실**(이자 비용 등 — 버라이즌)은 이 표시·줄을 쓰지 않는다: 영업이익 기준 PER 은 해마다 나가는 이자를 없는 것으로 쳐 빚이 많은 회사가 싸 보이는
 * 숫자가 된다(버라이즌 12.7 → 9.4배, 검토 지적). 그쪽은 예전 표시(시장 상위 5% 기준) 그대로
 */
export const ONE_OFF_ABS_SHARE = 0.3;
export const oneOffAbsText = (pct: number) => `영업 외 손익이 세전이익의 ${pct}%로 커서 순이익 기준 지표(PER·ROE)가 영업이익 기준 지표와 차이가 큽니다.`;
export const opPerNote = (taxPct: number, per: string) => `영업이익으로 계산하면(세금 ${taxPct}% 가정) PER 약 ${per}입니다.`;

/** [5] 금융사 (valueFinancialNote) */
export const FIN_INDUSTRY_KO: Record<string, string> = { "Major Banks": "은행" };
/** 은행 업종 (Nasdaq · 네이버) — 큰 은행 가운데값·은행 안내 */
export const BANK_INDUSTRIES: ReadonlySet<string> = new Set(["Major Banks", "Banks", "Commercial Banks", "Savings Institutions", "은행"]);
/** 보험 업종 (Nasdaq · 네이버) */
export const INSURER_INDUSTRIES: ReadonlySet<string> = new Set(["Life Insurance", "Property-Casualty Insurers", "Accident &Health Insurance", "Specialty Insurers", "생명보험", "손해보험"]);
/** 작은 회사 · 큰 회사 기준 (달러) */
export const FIN_SMALL_CAP = 5e9;
export const FIN_BIG_CAP = 50e9;
export const finPeerFirst = (nameKo: string, n: number, small: number | null) =>
  `같은 업종(${nameKo} · Nasdaq 분류, ${n.toLocaleString("en-US")}곳${small !== null ? ` — 그중 ${small.toLocaleString("en-US")}곳은 시가총액 50억 달러 미만` : ""})`;
export function finHealthFacts(o: { value: string | null; lname: string; median: string | null; big: { word: string; n: number; median: string } | null }): string | null {
  if (!o.value) return null;
  return [`자기자본 ÷ 총자산 ${o.value}`, o.median ? `${o.lname} 가운데값 ${o.median}` : null, o.big ? `시가총액 500억 달러 넘는 ${o.big.word} ${o.big.n}곳 가운데값 ${o.big.median}` : null].filter(Boolean).join(" · ");
}
export const BANK_HEALTH_NOTE =
  "은행 감독에 쓰는 자본비율(BIS·CET1)과 다른 단순 비율입니다. 국채·중앙은행 예치금처럼 위험이 낮은 자산을 많이 가진 대형 은행은 이 비율이 낮게 나오는 편이라, 이 막대 하나로 은행의 건전성을 말할 수는 없습니다.";
export const INSURER_HEALTH_NOTE =
  "보험사는 가진 채권·주식의 평가이익(또는 손실)이 자본에 크게 들어 있어, 자기자본 ÷ 총자산의 뜻이 은행과 다릅니다. 이 막대 하나로 보험사의 건전성을 말할 수는 없습니다.";
export const FIN_OTHER_HEALTH_NOTE = "금융사 감독에 쓰는 자본비율과 다른 단순 비율입니다. 이 막대 하나로 이 회사의 건전성을 말할 수는 없습니다.";
export const KR_FIN_MIX_NOTE = "한국 금융사 전체 비교에는 은행·보험·증권·카드 회사가 함께 들어 있습니다.";

/** [9] 이유 글 (valueReasonDetail) */
export const SHARES_MISSING_TEXT = "이 앱이 이 회사의 주식 수 자료를 읽지 못해 계산하지 않았습니다. 회사 재무에 문제가 있다는 뜻은 아닙니다.";
export const krFewQuartersText = (n: number) =>
  `재무 요약에 분기 실적이 아직 ${n}개뿐입니다(4개 필요 — 새로 상장했거나 분할로 새로 생긴 회사 등). 회사 재무에 문제가 있다는 뜻은 아닙니다.`;
export const KR_QUARTER_GAP_TEXT = "재무 요약의 최근 4개 분기 실적 가운데 빈 값이 있어 계산하지 않았습니다. 회사 재무에 문제가 있다는 뜻은 아닙니다.";
export const preferredText = (commonName: string | null) =>
  commonName ? `우선주는 따로 계산하지 않습니다. 같은 회사 보통주(${commonName}) 화면에 가치 지표 점수가 있습니다.` : "우선주는 따로 계산하지 않습니다.";

/**
 * [10] 사실과 다른 문장 (valueWordingFacts): 순손실 회사의 이익의 현금 뒷받침. 금액은 부호 없는 크기로 받는다 — '순손실(−2.39억 달러)'(이중 부정)·
 * 음수끼리 '작을 뿐'(헷갈림) 대신 '순손실은 2.39억 달러이고, 영업활동에서도 현금이 0.61억 달러 빠져나갔습니다(순손실보다 적은 금액)' (검토 지적)
 */
export function lossAccrualText(ni: string, ocf: string, ocfNegative: boolean, ocfSmaller: boolean): string {
  const head = "순손실 회사라 '이익이 현금으로 뒷받침되는지'로 읽지 않습니다.";
  return ocfNegative
    ? `${head} 순손실은 ${ni}이고, 영업활동에서도 현금이 ${ocf} 빠져나갔습니다(순손실보다 ${ocfSmaller ? "적은" : "많은"} 금액).`
    : `${head} 순손실은 ${ni}이지만, 영업현금흐름은 플러스(${ocf})입니다.`;
}
/** 순손실 회사의 이익의 현금 뒷받침 줄 뜻 (예전 '100에 가까울수록: 이익이 현금으로 잘 뒷받침되는 편' 대신 — 좋은 뜻으로 읽히지 않게) */
export const LOSS_ACCRUAL_MEANING = "순손실 회사는 100에 가까워도 '이익이 현금으로 잘 뒷받침되는 편'이라는 뜻이 아닙니다.";
/** [10] 경기 정점 표시 — 업종 목록이 아니라 이익률 오르내림으로 경기 민감이 된 회사(팔란티어)는 '업황에 따라'를 쓰지 않는다 */
export const CYCLICAL_PEAK_MARGIN = "이익이 최근 몇 년 중 가장 높은 수준입니다. 이익이 크게 오르내리는 회사는 이익이 많을 때 PER이 낮게 보이는 경향이 있습니다.";
export const lossYearsText = (from: string, to: string, n: number, all: boolean) =>
  `${from === to ? `${to}년` : `${from}~${to}년`}${all ? `, 자료가 있는 ${n}년 모두` : ` ${n}년 연속`} 영업손실입니다. 영업손실인 회사는 이 점수 방식으로는 낮게 나오는 것이 보통입니다.`;
/** 한국 간이: 부채비율이 이 값(%) 이상이면 자본이 아주 작다는 표시 (아시아나항공 5,496%) */
export const THIN_EQUITY_DEBT = 1000;
export const thinEquityText = (debtRatio: number) =>
  `자본(순자산)이 총자산에 비해 아주 작아(부채비율 ${Math.round(debtRatio).toLocaleString("en-US")}%), 순자산으로 나누는 PBR·ROE 는 작은 변화에도 크게 바뀝니다.`;

/** 금액 글 ('−0.61억 달러', '−187억 달러', '1,234억원') */
export function moneyEok(v: number, unit: "USD" | "KRW"): string {
  const e = v / 1e8;
  const a = Math.abs(e);
  const body = a >= 100 ? Math.round(a).toLocaleString("en-US") : a >= 10 ? (Math.round(a * 10) / 10).toFixed(1) : (Math.round(a * 100) / 100).toFixed(2);
  return `${e < 0 ? "−" : ""}${body}억${unit === "USD" ? " 달러" : "원"}`;
}

/** [4] 종합 (compositeFormula · compositeGapHide) */
export const COMPOSITE_GAP_NOTE_V2 = 25;
export const COMPOSITE_GAP_HIDE = 30;
export const compositeFormulaText = (v: number, t: number) => `= (${v} + ${t}) ÷ 2`;
export const gapTextV2 = (d: number) => `두 점수 차이가 ${d}점입니다. 평균 하나로는 이 차이가 가려집니다.`;
export const gapHideText = (d: number) => `두 점수 차이가 ${d}점이라 평균을 보이지 않습니다`;
export const HOW_GAP_HIDE = "두 점수 차이가 30점을 넘으면 종합 숫자 대신 그 까닭을 적습니다.";

// ── 한국 간이 계산 (3-44 3단계) ─────────────────────────────

/** 한국 종목 배지 (설계 5.4 lite) */
export const LITE_BADGE = "간이 계산";
/** 한국 종목 상세 카드 안내 (간이 계산이 무엇을 빼는지 · 미국과 견주지 않음 — 설계 B8) */
export const KR_LITE_NOTE =
  "한국 종목은 네이버 증권의 재무 요약(최근 5개 분기·3개 결산)으로 계산한 간이 계산입니다. 잉여현금흐름·기업가치·투하자본이익률·이익 안정성·주식 수 변화 지표가 없고, 이 회사의 지난 5년과도 비교하지 않습니다. 한국 상장 회사끼리만 비교해 미국 종목 점수와 견주지 않습니다.";
/** 비교 회사 첫 채우기 중 (밤마다 나눠 받음 — 며칠 걸림, 앱이 다시 묻지 않는 끝나는 상태) */
export const krFirstFillText = (pct: number) => `비교할 한국 회사 재무를 처음 모으는 중입니다 (밤마다 나눠 받아 며칠 걸립니다 · 지금 ${pct}%)`;
/** 머리 문장 (한국) */
export function krPeerLine(p: { level: PeerLevel; nameKo: string | null; n: number; path: ValuePath }): string {
  const first = p.level === "market" ? `한국 상장 ${p.path === "financial" ? "금융사" : "회사"} ${p.n.toLocaleString("en-US")}개` : `같은 업종(${p.nameKo ?? "업종"}, ${p.n}개 회사)`;
  const parts = [first, p.level === "market" ? null : p.path === "financial" ? "한국 금융사 전체" : "한국 시장"].filter(Boolean);
  const joined = parts.join("·");
  return `${joined}${gwaWa(joined)} 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다.`;
}
/** 날짜 줄 (한국): '주가 9월 23일(수)까지 20거래일 평균 · 재무 2026년 6월까지 최근 4분기(네이버 재무 요약) · 비교 기준 9월 27일(일)' */
export function krDatesLine(a: { priceThrough: string; quarter: string; reference: string }): string {
  return `주가 ${dateKo(a.priceThrough)}까지 20거래일 평균 · 재무 ${a.quarter.slice(0, 4)}년 ${Number(a.quarter.slice(5, 7))}월까지 최근 4분기(네이버 재무 요약) · 비교 기준 ${dateKo(a.reference)}`;
}
export const krCauseQuarter = (quarter: string) => `새 분기 실적(${quarter.slice(0, 4)}년 ${Number(quarter.slice(5, 7))}월까지)이 반영되었습니다.`;
export function krVersionLine(ref: string | null): string {
  return [`계산 방식 ${VALUE_VERSION} 간이(한국)`, "재무 네이버 증권 재무 요약(실적 열만)", "업종 분류 네이버", ref ? `비교 기준 ${dateKo(ref)}` : null].filter(Boolean).join(" · ");
}
