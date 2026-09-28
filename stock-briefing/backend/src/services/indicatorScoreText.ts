import type { LeverageFacts } from "../analysis/leveraged.js";
import { FAMILY_KEYS, TREND_CAL, TREND_VERSION, TREND_WEIGHTS, shownScore, trendBand, type FamilyKey, type ItemKey, type TrendBand, type TrendNote, type TrendReason, type TrendShown } from "../analysis/trendScore.js";

/**
 * 지표 점수 문구 (3-44 1단계). 모든 문장은 서버가 정해진 틀에 숫자를 채워 만든다 — AI 문장 없음, 문구를 고칠 때 앱 OTA 가 필요 없고
 * 금지어 검사(analysis/scoreWording)를 한 곳에서 한다. 앱은 배치만 하고, 앱에 고정된 글은 줄 이름·버튼뿐이다.
 * 말투: 지금 숫자의 상태만 말한다("~지표가 많습니다", "~에 있습니다", "~% 움직였습니다"). 앞날·매매를 말하지 않는다
 */

export type ScoreMarket = "KR" | "US";

const WD = ["일", "월", "화", "수", "목", "금", "토"];
/** "2026-09-25" → "9월 25일(금)" */
export function dateKo(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${WD[d.getUTCDay()]})`;
}
const marketKo = (m: ScoreMarket) => (m === "KR" ? "한국" : "미국");

/** 요약 카드 날짜 줄: "가격 9월 25일(금) 미국 종가" */
export const priceDateLine = (date: string, market: ScoreMarket) => `가격 ${dateKo(date)} ${marketKo(market)} 종가`;
/** 상세 카드 기준 문장 */
export const basisSentence = (date: string, market: ScoreMarket) => `${dateKo(date)} ${marketKo(market)} 정규장 종가까지의 가격·거래량으로 정해진 식에 따라 계산했습니다.`;

export const CARD_TITLE_NOTE = "계산식 결과 · AI 글 아님";
export const NOT_FORECAST = "점수는 과거·현재 숫자의 요약이며, 앞으로의 가격을 알려 주지 않습니다.";
export const DETAIL_NOTE = "과거 가격·거래량으로 계산한 지표이며 앞으로의 가격이나 수익을 뜻하지 않습니다.";
export const DISCLAIMER_SHORT = "참고 정보이며 투자 권유가 아닙니다";
export const TREND_ABOUT = "최근 1년 가격·거래량 흐름의 방향과 세기";
export const VALUE_ABOUT = "재무 숫자가 같은 업종·시장 회사들 사이 어디쯤인지";
/**
 * 가치 지표 설명 줄 — 비교한 무리에 맞춘다: 금융사 경로는 '업종·금융사 전체'(금융사끼리만 비교, 검토 지적), 한국 종목은 '한국 시장'
 * (한국 종목은 한국 상장 회사끼리만 비교 — 미국 종목과 견주지 않음, 설계 B8)
 */
export function valueAboutOf(path: "general" | "financial" | null, market: ScoreMarket = "US"): string {
  const group = market === "KR" ? (path === "financial" ? "한국 금융사 전체" : "한국 시장") : path === "financial" ? "금융사 전체" : "시장";
  return `재무 숫자가 같은 업종·${group} 회사들 사이 어디쯤인지`;
}

/** 띠 한 줄 (설계서 6.4) */
export const BAND_LINE: Record<TrendBand, string> = {
  강함: "상승 추세를 가리키는 지표가 많습니다.",
  "다소 강함": "상승 쪽 지표가 조금 더 많습니다.",
  중립: "뚜렷한 방향을 가리키는 지표가 적습니다.",
  "다소 약함": "하락 쪽 지표가 조금 더 많습니다.",
  약함: "하락 추세를 가리키는 지표가 많습니다.",
};

export const FAMILY_NAME: Record<FamilyKey, string> = { T: "추세", M: "모멘텀", O: "단기 균형", R: "가격 안정성", V: "거래량 뒷받침" };
/** 묶음 한 줄 설명 (상세 카드 묶음 이름 옆) */
export const FAMILY_ABOUT: Record<FamilyKey, string> = {
  T: "이동평균선 위·아래와 기울기",
  M: "최근 1개월을 뺀 수익 흐름",
  O: "높을수록 단기 과열·과매도에서 멂",
  R: "높을수록 흔들림·낙폭이 작음",
  V: "오른 날에 거래가 몰렸는지",
};
export const ITEM_NAME: Record<ItemKey, string> = {
  T1: "200일선과 거리",
  T2: "50일선과 거리",
  T3: "50일선 대 200일선",
  T4: "200일선 기울기",
  M1: "12개월(최근 1개월 제외)",
  M2: "6개월(최근 1개월 제외)",
  M3: "3개월(최근 1개월 제외)",
  M4: "지수 대비",
  O1: "RSI(14)",
  O2: "볼린저 밴드 위치",
  O3: "50일선 거리(흔들림 배수)",
  R1: "변동성",
  R2: "52주 최고 종가 대비",
  R3: "1년 최대 낙폭",
  V1: "오른 날·내린 날 거래량",
  V2: "거래량 추세",
};

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const f2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const signed1 = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${f1(Math.abs(v))}`;
const pctOf = (logv: number) => 100 * (Math.exp(logv) - 1);
const upDown = (v: number) => (v >= 0 ? "위" : "아래");

/** 묶음 문장 (설계서 11.3). raw 는 오늘 값, familyScore 는 화면 점수(5일 평균)의 정수 */
export function familySentence(f: FamilyKey, r: TrendShown, benchName: string | null): { text: string; facts: Array<{ label: string; value: string }> } {
  const raw = r.raw;
  switch (f) {
    case "T": {
      const a = pctOf(raw.T1);
      const b = pctOf(raw.T2);
      const c = pctOf(raw.T3);
      const facts = [
        { label: "200일선 대비", value: `${signed1(a)}%` },
        { label: "50일선 대비", value: `${signed1(b)}%` },
        { label: "50일선 대 200일선", value: `${signed1(c)}%` },
      ];
      const head = `주가가 200일 이동평균선보다 ${f1(Math.abs(a))}% ${upDown(a)}, 50일선보다 ${f1(Math.abs(b))}% ${upDown(b)}에 있습니다.`;
      const mid = `50일선은 200일선보다 ${f1(Math.abs(c))}% ${upDown(c)}`;
      if (raw.T4 === undefined) return { text: `${head} ${mid}입니다. 200일선 기울기는 기록이 모자라 빠졌습니다.`, facts };
      const d = pctOf(raw.T4);
      facts.push({ label: "200일선 한 달 변화", value: `${signed1(d)}%` });
      const tail = Math.abs(d) < 0.1 ? "200일선은 한 달 전과 거의 그대로입니다." : `200일선은 한 달 전보다 ${f1(Math.abs(d))}% ${d > 0 ? "올랐습니다" : "내렸습니다"}.`;
      return { text: `${head} ${mid}이고, ${tail}`, facts };
    }
    case "M": {
      const parts: string[] = [];
      const facts: Array<{ label: string; value: string }> = [];
      if (raw.M1 !== undefined) {
        parts.push(`최근 1개월을 뺀 12개월 동안 ${signed1(pctOf(raw.M1))}%, 6개월 동안 ${signed1(pctOf(raw.M2))}% 움직였습니다.`);
        facts.push({ label: "12개월(최근 1개월 제외)", value: `${signed1(pctOf(raw.M1))}%` });
      } else parts.push(`최근 1개월을 뺀 6개월 동안 ${signed1(pctOf(raw.M2))}% 움직였습니다 (기록이 1년이 안 되어 12개월 값은 없습니다).`);
      facts.push({ label: "6개월(최근 1개월 제외)", value: `${signed1(pctOf(raw.M2))}%` }, { label: "3개월(최근 1개월 제외)", value: `${signed1(pctOf(raw.M3))}%` });
      const rel = raw.M4?.m12 ?? raw.M4?.m6;
      if (rel && benchName) {
        const pp = 100 * (Math.exp(rel.stock) - Math.exp(rel.bench));
        const span = raw.M4?.m12 ? "12개월" : "6개월";
        parts.push(`같은 ${span} 동안 ${benchName}보다 ${f1(Math.abs(pp))}%p ${pp >= 0 ? "높습니다" : "낮습니다"}.`);
        facts.push({ label: `${benchName} 대비(${span})`, value: `${signed1(pp)}%p` });
      }
      return { text: parts.join(" "), facts };
    }
    case "O": {
      const rsi = raw.O1;
      const pb = raw.O2;
      const bits: string[] = [];
      const facts: Array<{ label: string; value: string }> = [];
      if (rsi !== null) {
        const zone = rsi >= 70 ? "과매수 구간" : rsi <= 30 ? "과매도 구간" : "중립 구간";
        bits.push(`RSI ${Math.round(rsi)}(${zone})`);
        facts.push({ label: "RSI(14)", value: `${Math.round(rsi)}` });
      }
      if (pb !== null) {
        bits.push(pb > 1 ? "볼린저 밴드 위쪽 바깥" : pb < 0 ? "볼린저 밴드 아래쪽 바깥" : `볼린저 밴드 안 위치 ${Math.round(pb * 100)}%`);
        facts.push({ label: "밴드 안 위치", value: `${Math.round(pb * 100)}%` });
      }
      bits.push(`50일선과의 거리는 평소 흔들림의 ${f1(Math.abs(raw.O3))}배입니다`);
      facts.push({ label: "50일선 거리(흔들림 배수)", value: `${signed1(raw.O3)}배` });
      const fo = r.families.O.score;
      const end = fo !== null && shownScore(fo) >= 80 ? "단기 지표가 모두 보통 범위입니다." : raw.O3 > 0 ? "최근 상승 폭이 평소보다 큰 편입니다." : "최근 하락 폭이 평소보다 큰 편입니다.";
      return { text: `${bits.join(", ")}. ${end}`, facts };
    }
    case "R": {
      const vol = 100 * raw.R1;
      const size = vol < 20 ? "작은 편" : vol < 35 ? "보통" : vol < 60 ? "큰 편" : "매우 큰 편";
      const fromHigh = 100 * (1 - Math.exp(-raw.R2));
      const mdd = 100 * raw.R3;
      const high = fromHigh < 0.05 ? "52주 최고 종가에 있고" : `52주 최고 종가보다 ${f1(fromHigh)}% 아래에 있고`;
      return {
        text: `최근 3개월 변동성은 연 ${Math.round(vol)}%로 ${size}입니다. ${high}, 최근 1년 가장 크게 떨어진 폭은 ${f1(mdd)}%였습니다.`,
        facts: [
          { label: "변동성(연)", value: `${Math.round(vol)}%` },
          { label: "52주 최고 종가 대비", value: `${fromHigh < 0.05 ? "0.0" : `−${f1(fromHigh)}`}%` },
          { label: "1년 최대 낙폭", value: `${f1(mdd)}%` },
        ],
      };
    }
    case "V": {
      if (raw.V1 === undefined && raw.V2 === undefined) return { text: "거래량 기록이 비어 있는 날이 많아 거래량 항목을 뺐습니다.", facts: [] };
      const bits: string[] = [];
      const facts: Array<{ label: string; value: string }> = [];
      if (raw.V1 !== undefined) {
        bits.push(`최근 50거래일 동안 오른 날 거래량이 내린 날의 ${f2(raw.V1)}배입니다.`);
        facts.push({ label: "오른 날 ÷ 내린 날 거래량", value: `${f2(raw.V1)}배` });
      }
      if (raw.V2) {
        bits.push(`최근 20일 평균 거래량은 120일 평균의 ${f2(raw.V2.advRatio)}배입니다.`);
        facts.push({ label: "20일 ÷ 120일 평균 거래량", value: `${f2(raw.V2.advRatio)}배` });
      }
      return { text: bits.join(" "), facts };
    }
  }
}

/** 판단 불가·보류 까닭 (설계서 5.7-C 점수 없음 (추세)) */
export function trendReasonText(reason: TrendReason): string {
  switch (reason.code) {
    case "short":
      return `기록이 ${reason.bars}거래일이라 계산할 수 없습니다 (200거래일 필요)`;
    case "stale":
      return "최근 거래 기록이 없어 계산하지 않았습니다 (거래정지 등)";
    case "split":
      return "주식 분할·병합 반영을 확인하는 중입니다";
    case "flat":
      return "가격 변화가 없는 날이 많아 계산하지 않았습니다";
    case "thin":
      return "추세·모멘텀을 만들 기록이 모자라 계산하지 않았습니다";
    case "coverage":
      return `계산에 쓸 수 있는 항목이 ${reason.pct}%뿐이라 계산하지 않았습니다`;
  }
}

export function trendNoteText(n: TrendNote, benchMissing: "overseas" | "none" | null): string {
  switch (n.code) {
    case "noBench":
      return benchMissing === "overseas" ? "국내 상장 해외지수·원자재 상품이라 코스피 비교를 뺐습니다." : "비교 지수가 없어 지수 대비 항목을 뺐습니다.";
    case "noVolume":
      return "거래량 기록이 비어 있는 날이 많아 거래량 항목을 뺐습니다.";
    case "shortYear":
      return `기록이 ${n.bars}거래일이라 12개월 항목 없이 계산했습니다.`;
  }
}

export const STATUS_TEXT = {
  fetchFailed: "일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다",
  productFetchFailed: "이 상품 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다",
  underlyingFetchFailed: "기초자산 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다",
  underlyingUnknown: "레버리지 상품의 기초자산을 확인하지 못해 계산하지 않았습니다",
  inverse: "인버스 상품은 점수를 내지 않습니다 (기초자산과 반대로 움직이도록 만든 상품).",
  bond: "채권·금리형 상품은 추세 지표 점수를 계산하지 않습니다.",
  valuePending: "가치 지표 점수는 지금 계산하지 않습니다.",
  valueEtf: "ETF는 여러 종목을 묶은 상품이라, 한 회사의 재무로 계산하는 이 점수를 내지 않습니다.",
  compositeValueMissing: "가치 지표 점수가 없어 합치지 않습니다",
  compositeTrendMissing: "추세 지표 점수가 없어 합치지 않습니다",
  compositeBothMissing: "두 점수가 모두 없습니다",
  compositeDateMismatch: "두 점수의 기준일이 달라 합치지 않았습니다",
} as const;

/**
 * 받기 실패 문장 (설계 5.4: 받기 실패 · 원래 없음 · 계산 불가를 구분). 받기 실패는 점수를 다르게 내지 않고 '점수 없음'으로 두며,
 * 5분 뒤 다시 계산하고 하루 기록에 남기지 않는다. 비교 지수가 원래 없는 상품(해외지수 ETF 등)은 trendNoteText 의 noBench
 */
export const benchFetchFailed = (benchName: string, underlying?: string | null) =>
  `${underlying ? `기초자산 ${underlying}의 ` : ""}비교 지수(${benchName}) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다`;
export const underlyingFetchFailed = (code: string) => `기초자산 ${code} 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다`;
/** 분배금이 큰 상품 안내 (추세 계산 9.6) */
export const DISTRIBUTION_NOTE = "분배금이 큰 상품이라 가격만으로 계산한 추세가 실제 수익보다 낮게 나올 수 있습니다.";

/** 요약 카드 추세 줄 설명 (띠 뜻을 한 줄로) */
export const trendMeaning = (band: TrendBand) => `${TREND_ABOUT}: ${BAND_LINE[band]}`;

/**
 * 지난주 대비 바뀐 이유 (상세 카드만, 화면 정수 차이가 5점 넘을 때). 묶음은 점수와 같은 쪽으로 움직인 묶음 가운데 비중 × 변화가 가장 큰 것.
 * 괄호를 겹치지 않게 날짜는 괄호 밖에: '지난주 9월 18일(금)보다 점수가 6점 높아졌습니다. 가장 크게 바뀐 묶음은 추세(+12점)입니다.'
 */
export function changeText(c: { from: string; diff: number; family: FamilyKey; familyDiff: number }): string {
  const fd = c.familyDiff === 0 ? "0" : `${c.familyDiff > 0 ? "+" : "−"}${Math.abs(c.familyDiff)}`;
  return `지난주 ${dateKo(c.from)}보다 점수가 ${Math.abs(c.diff)}점 ${c.diff > 0 ? "높아졌습니다" : "낮아졌습니다"}. 가장 크게 바뀐 묶음은 ${FAMILY_NAME[c.family]}(${fd}점)입니다.`;
}

/** 레버리지 참고 줄 */
export function referenceText(underlying: string, score: number, band: TrendBand): string {
  return `참고: 기초자산 ${underlying} 추세 지표 ${score} · ${band}`;
}
export const leverageWhy = (L: number) => `매일 ${L}배를 다시 맞추는 상품이라 이 상품 가격으로는 계산하지 않습니다.`;
/** 기초자산이 지수를 1배로 따르는 ETF 일 때 (SOXL → SOXX) */
export const proxyNote = (underlying: string, tracks: string) => `${underlying}는 같은 ${tracks}를 1배로 따르는 ETF입니다.`;

/** 글 조각 (sign 이 있으면 앱이 등락 색으로 칠한다 — 수익률 숫자만) */
export interface TextPart {
  text: string;
  sign?: number;
}
export interface RichLine {
  parts: TextPart[];
}

/** 레버리지 주의 상자 (설계서 5.7-D) */
export function leverageBox(f: LeverageFacts | null, L: number, tracks: string | null): { title: string; lines: RichLine[] } {
  const title = "레버리지 상품 주의 · 계산한 사실";
  const lines: RichLine[] = [{ parts: [{ text: tracks ? `이 상품은 ${tracks} 하루 움직임의 ${L}배를 따라가도록 만든 상품입니다.` : `이 상품은 기초자산 하루 움직임의 ${L}배를 따라가도록 만든 상품입니다.` }] }];
  if (f) {
    const pct = (v: number) => `${signed1(v)}%`;
    if (f.und63Pct !== null && f.naiveLx63Pct !== null)
      lines.push({
        parts: [
          { text: "· 최근 63거래일: 이 상품 " },
          { text: pct(f.etf63Pct), sign: Math.round(f.etf63Pct * 10) },
          { text: ", 기초자산 " },
          { text: pct(f.und63Pct), sign: Math.round(f.und63Pct * 10) },
          { text: ` (단순 ${L}배면 ` },
          { text: pct(f.naiveLx63Pct), sign: Math.round(f.naiveLx63Pct * 10) },
          { text: ")" },
        ],
      });
    else lines.push({ parts: [{ text: "· 최근 63거래일: 이 상품 " }, { text: pct(f.etf63Pct), sign: Math.round(f.etf63Pct * 10) }] });
    lines.push({ parts: [{ text: `· 이 상품의 최근 3개월 변동성 연 ${Math.round(f.sigEtfAnnPct)}%, 최근 1년 가장 크게 떨어진 폭 ${f1(f.etfMdd1yPct)}%` }] });
    if (f.volDecayPctPerYear !== null && f.sigUnderlyingAnnPct !== null)
      lines.push({ parts: [{ text: `· 계산상 변동성 손실: 기초자산 변동성(연 ${f1(f.sigUnderlyingAnnPct)}%)이 1년 이어지고 기초자산이 제자리라고 가정하면, 이 상품 값은 약 ${f1(f.volDecayPctPerYear)}% 줄어듭니다.` }] });
  }
  lines.push({ parts: [{ text: `· 하루 단위로 설계된 상품이라 기간이 길수록 '기초자산 수익률 × ${L}'과 차이가 커질 수 있습니다.` }] });
  return { title, lines };
}

/** 구성·계산 방법 (추세만 — 가치 부분을 끈 서버(valueScore 꺼짐). 2단계가 나간 뒤라 '다음 단계에서'라고 쓰지 않는다, 검토 지적) */
export function howLines(): string[] {
  return [
    "추세: 최근 약 1년 일봉으로 16개 항목을 고정된 기준에 따라 계산했습니다. 50은 '뚜렷한 추세 없음'이고, 최근 5거래일 점수의 평균을 보여 줍니다.",
    "추세와 모멘텀 묶음(합쳐 70%)은 서로 겹치는 흐름을 봅니다. 여러 지표를 섞었지만 몇 가지 흐름이 겹칩니다.",
    "가치 지표 점수와 종합 지표 점수(두 점수의 평균)는 지금 계산하지 않습니다.",
    "비중은 설명하기 쉽도록 정한 설계값이며, 과거 수익률에 맞춰 고르지 않았습니다. 몇 점 차이는 큰 뜻이 없습니다.",
    "지난 약 11년 미국·한국 대형주 자료로 맞춰 보니, 점수가 높았던 종목이 그 뒤 더 오른 관계는 우연과 구별하기 어려울 만큼 약했습니다.",
    "증권사가 낸 앞날 추정 숫자와 의견은 쓰지 않았습니다. 이미 거래된 가격·거래량만 썼습니다.",
    "장 마감 뒤 하루 한 번 바뀝니다(한국 20:10, 미국은 한국 시간 아침). 장중에는 그대로입니다.",
  ];
}

const SOURCE_NAME: Record<string, string> = { toss: "토스증권", "toss-openapi": "토스증권", naver: "네이버", yahoo: "야후", kis: "한국투자증권" };
export const sourceName = (s: string | null) => (s ? (SOURCE_NAME[s] ?? s) : null);

export function versionLine(source: string | null, benchName: string | null): string {
  return [`계산 방식 ${TREND_VERSION} (보정 ${TREND_CAL.version})`, source ? `일봉 ${sourceName(source)}` : null, benchName ? `비교 지수 ${benchName}(네이버)` : null].filter(Boolean).join(" · ");
}

/** 추세 상세 카드 머리 */
export const trendHeadline = (score: number, band: TrendBand) => `추세 지표 점수 ${score}/100 · ${band}`;

/** 묶음 목록 (상세 카드) */
export function familyRows(r: TrendShown, benchName: string | null) {
  return FAMILY_KEYS.map((k) => {
    const fam = r.families[k];
    const s = familySentence(k, r, benchName);
    return {
      key: k,
      name: FAMILY_NAME[k],
      about: FAMILY_ABOUT[k],
      weight: TREND_WEIGHTS[k].w,
      score: fam.score !== null ? shownScore(fam.score) : null,
      scoreExact: fam.score,
      text: fam.score !== null ? s.text : k === "V" ? "거래량 기록이 비어 있는 날이 많아 거래량 항목을 뺐습니다." : "이 묶음을 만들 기록이 모자라 뺐습니다.",
      facts: fam.score !== null ? s.facts : [],
      items: (Object.keys(TREND_WEIGHTS[k].subs) as ItemKey[]).map((i) => ({ key: i, name: ITEM_NAME[i], score: r.subs[i] !== undefined ? shownScore(r.subs[i]!) : null })),
    };
  });
}

export { trendBand, shownScore };
