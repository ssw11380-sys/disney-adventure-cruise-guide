import { formatRate, formatWon, KR_PREVIOUS_DAY_LINE, US_PREVIOUS_DAY_LINE, usHolidayWhen, usPreviousDayLine } from "../notifications/digest.js";
import type { MarketStatus } from "../providers/market/calendar.js";
import type { MarketIndex } from "../providers/market/indices.js";
import { seoulDate } from "../lib/time.js";
import { isKrTradingDate, isUsTradingDate, krRegularHours, marketContext, usRegularCloseMinutes } from "./marketContext.js";
import type { Evaluation } from "./stockService.js";

/**
 * 계좌 한 장 브리핑(3-31)의 숫자와 문장. 숫자는 모두 여기서 코드로 계산하고, 모델은 이 숫자를 옮겨 적기만 한다.
 * DB·네트워크를 모르는 순수 함수라 단위 테스트로 묶는다.
 *
 * 기준은 앱 잔고 화면의 계좌 합계(app/src/lib/portfolio.ts summarize, 설정 기본값 afterCost=true)와 같다:
 *  - 총 평가금액: 토스 비용 비율이 있으면 수수료·세금 예상액을 뺀 평가금액. 미국 종목은 시세의 적용 환율(fxRate, 토스 표시 환율)로 원화 환산
 *  - 매입금액: 국내는 매입금액, 미국은 매수 당시 환율의 원화 매입금액(장부가 없으면 현재 환율 환산)
 *  - 당일 손익: 전일 대비 × 수량. 미국 종목은 같은 적용 환율로 환산 — 환율이 움직인 몫은 들어가지 않으므로 '환율 효과'로 따로 보여 준다
 *  - 환율을 모르는 미국 종목은 원화 합계에서 빼고 excluded 에 남긴다 (앱은 이때 원화 합계 대신 통화별로 보여 준다)
 */

export type AccountSession = "morning" | "afternoon";

/** 잔고 한 줄 (StockService.listWithQuotes 의 항목과 같은 모양, 필요한 칸만) */
export interface AccountHolding {
  code: string;
  name: string;
  quantity: number | null;
  avgPrice: number | null;
  quote: {
    currency?: "KRW" | "USD";
    price: number;
    change: number;
    changeRate: number;
    fxRate?: number | null;
    priceKrw?: number | null;
    stale?: boolean;
  } | null;
  evaluation: Evaluation | null;
}

/** 당일 손익 기여 한 줄 */
export interface AccountRow {
  code: string;
  name: string;
  currency: "KRW" | "USD";
  /** 당일 손익 기여(원, 정수). 줄마다 반올림한 값의 합이 당일 손익과 정확히 같게 나눈다 */
  amount: number;
  /** 전일 대비 등락률(%) */
  changeRate: number | null;
  /** 원화 평가금액(원, 앱 기준) */
  value: number;
}

export interface MarketBucket {
  count: number;
  /** 원화 평가금액 */
  value: number;
  /** 당일 손익(원). 국내 + 미국 = 계좌 당일 손익 */
  day: number;
  /** 전일 평가금액 대비 당일 손익(%) */
  dayRate: number | null;
}

export interface AccountFx {
  /** computed = 나눠 계산함, none = 미국 종목 없음, unavailable = 원/달러 변동을 받지 못함 */
  status: "computed" | "none" | "unavailable";
  reason: string | null;
  /** 원/달러 (지수 띠와 같은 출처: 네이버, 하나은행 매매기준율) */
  usdKrw: { value: number; change: number; changeRate: number; stale: boolean } | null;
  /** 원화 환산에 쓴 적용 환율 (앱 잔고 화면과 같은 토스 표시 환율) */
  appliedRate: number | null;
  /** 미국 보유분 원화 평가(비용 차감 전)의 하루 변화 = 가격 효과 + 환율 효과 (나눈 뒤의 두 값을 더해 정의 — 화면의 등식이 늘 맞게) */
  usdHoldingsKrwChange: number | null;
  /** 가격 효과 = 달러 등락 × 수량 × 적용 환율 = 당일 손익의 미국 몫 */
  priceEffect: number | null;
  /** 환율 효과 = 전일 달러 평가액 × 원/달러 전일 대비 (당일 손익에는 들어가지 않음) */
  fxEffect: number | null;
}

export interface AccountTotals {
  afterCost: boolean;
  /** 합계에 넣은 보유 종목 수 */
  holdings: number;
  /** 그중 시세가 지연된(새로 받지 못한) 종목 수 */
  stale: number;
  totalValue: number;
  totalCost: number;
  totalProfit: number;
  totalProfitRate: number | null;
  dayPnl: number;
  dayRate: number | null;
  /** 당일 손익 기여가 큰 순 상위 (|기여| 순) */
  contributions: AccountRow[];
  /** 상위 밖 종목의 합. contributions 의 합 + others.amount = dayPnl (정확히) */
  others: { count: number; amount: number } | null;
  markets: { kr: MarketBucket | null; us: MarketBucket | null };
  /** 합계에서 뺀 보유 종목과 이유 */
  excluded: Array<{ code: string; name: string; reason: string }>;
  fx: AccountFx;
}

export interface AccountIndexRow {
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  stale: boolean;
}

export interface AccountDisclosure {
  code: string;
  name: string;
  title: string;
  filedAt: string;
  url: string | null;
}

export interface AccountSchedule {
  kr: { date: string; tradingDay: boolean; now: string; hours: string | null; nextOpen: string | null };
  /** date = 오늘(한국 시간 기준 다음 또는 진행 중) 미국 정규장의 뉴욕 날짜 */
  us: { date: string; tradingDay: boolean; now: string; hours: string | null };
  /** 종목 브리핑이 이미 받아 둔 최근 DART 공시 (새로 부르지 않음) */
  disclosures: AccountDisclosure[];
}

export interface AccountData extends AccountTotals {
  version: 1;
  session: AccountSession;
  date: string;
  /** 숫자를 계산한 시각 (한국 시간 ISO) */
  asOf: string;
  /** 숫자 기준 한 줄 (화면 아래 안내) */
  basis: string;
  indices: AccountIndexRow[];
  /** 받지 못한 지수 이름 */
  missingIndices: string[];
  schedule: AccountSchedule;
  /** 설명(detail)을 누가 썼는지: 모델(llm) 또는 숫자만으로 만든 기본 문장(template)과 그 이유 */
  narrative: { source: "llm" | "template"; reason: string | null };
  /**
   * 오늘 한국이 휴장인데 국내 보유 종목이 있음 → 국내 종목의 등락·당일 손익은 직전 거래일 것이다(앱 잔고 화면과 같은 기준이라 그대로 둔다).
   * 요약·알림·설명에 이 점을 밝힌다. 예전 기록에는 없다(없으면 false)
   */
  krPreviousDay?: boolean;
  /**
   * 지난밤(이번 브리핑이 보는) 미국 정규장이 평일 휴장(추수감사절 등)이었는데 미국 보유 종목이 있음 → 미국 종목의 등락·당일 손익은
   * 그 전 거래일 것이라 이미 앞 브리핑에 담긴 움직임이다. 금요일에 쉰 다음 월요일도 같다. 요약·알림·설명에 밝힌다. 예전 기록에는 없다(없으면 false)
   */
  usPreviousDay?: boolean;
  /**
   * 쉰 미국 정규장의 뉴욕 날짜 (YYYY-MM-DD, usPreviousDay 가 참일 때만). 브리핑 날짜의 전날이면 '지난밤', 아니면(금요일 휴장 다음 월요일)
   * '12/25(금)'처럼 날짜로 밝힌다. 예전 기록에는 없다(없으면 '지난밤')
   */
  usHolidayDate?: string;
  /**
   * 보유 종목별 수량·원화 평가 (브리핑 3차 3, 플래그 accountSinceLast — 다음 브리핑이 수량·비중 변화를 알게). 꺼짐·예전 기록에는 칸이 없다
   */
  positions?: AccountPosition[];
  /**
   * 지난 같은 세션 브리핑과 비교 (브리핑 3차 3, 플래그 accountSinceLast). 만들 때 계산해 저장한다 — 나중에 옛 브리핑을 열어도 그때 기준 그대로.
   * 켜져 있었는데 비교할 브리핑이 없으면(처음·10일 넘음) null, 꺼짐·예전 기록에는 칸이 없다
   */
  sinceLast?: AccountSinceLast | null;
  /**
   * 비중 한 줄 (브리핑 3차 4, 플래그 accountExposure): 가장 큰 종목·상위 3종목·레버리지·인버스·미국 상장 비중. 만들 때 계산해 저장한다(그때 기준 그대로).
   * 켜져 있었는데 값이 있는 종목이 없으면 null, 꺼짐·예전 기록에는 칸이 없다
   */
  exposure?: AccountExposure | null;
  /**
   * 다가오는 일정 (브리핑 3차 5, 플래그 holdingEvents — services/holdingEvents): 보유 종목의 30일 안 배당락일(과 플래그 holdingEarnings 면 실적 발표일),
   * 그 주 첫 오전 브리핑이면 이번 주 일정. 만들 때 받아 저장한다(그때 기준 그대로). 꺼짐·출처 없음·예전 기록에는 칸이 없다
   */
  events?: AccountEvents;
}

/** 다가오는 일정 한 줄 (브리핑 3차 5) */
export interface AccountEventItem {
  code: string;
  /** 보유 종목 이름 (앱 잔고와 같은 이름) */
  name: string;
  /** exDividend = 배당락일, earnings = 실적 발표 (예정) */
  kind: "exDividend" | "earnings";
  /** YYYY-MM-DD. 배당락일은 그 시장 날짜(미국 종목은 미국 날짜 — usDate), 실적 발표는 토스가 준 한국 날짜 */
  date: string;
  /** 실적 발표 한국 시각 'HH:MM' (미국 실적만 — 토스가 준 값 그대로, 서머타임을 우리가 계산하지 않음) */
  kstTime?: string;
  /** 토스가 보인 시각 글 '오전 5시 이후' (미국 실적만) */
  timeText?: string;
  /** 주당 배당금 (배당락일만 — 토스 배당 요약이 준 발표 값, 네이버만으로 안 날은 없음) */
  amount?: number;
  currency?: "KRW" | "USD";
  /** date 가 미국 날짜인지 (미국 종목 배당락일) */
  usDate: boolean;
  /** 출처: toss · naver(토스를 받지 못한 날 미국 배당락일) · toss+naver(두 출처 날짜가 같음) */
  source: "toss" | "naver" | "toss+naver";
}

/** 다가오는 일정 (브리핑 3차 5 — AccountData.events) */
export interface AccountEvents {
  /** 기준 시각 = 계좌 브리핑 asOf */
  asOf: string;
  /** 브리핑 날짜(한국)부터 며칠 안 (30) */
  days: number;
  /** 날짜 순 (같은 날은 시각 → 배당락일 → 실적 → 등록 순) */
  items: AccountEventItem[];
  /** 실적 발표일을 넣었는지 (그때 플래그 holdingEarnings) */
  earnings: boolean;
  /** 배당 일정을 받지 못한 보유 종목 (토스 실패 + 캐시 없음, 미국은 네이버도 모름) */
  failed: Array<{ code: string; name: string }>;
  /** 실적 발표일(캘린더)을 받지 못함 (earnings 가 true 일 때만 뜻이 있음) */
  earningsFailed: boolean;
  /** 토스와 네이버의 배당락일이 달라 뺀 미국 종목 (틀린 날짜를 보이지 않게) */
  conflicts: Array<{ code: string; name: string }>;
  /** 일정을 찾아본 보유 종목 수 (시장별) — 국내 종목이 있으면 앱이 '국내 종목 배당은 보통 기준일 뒤에 정해져 …'를 붙인다 */
  kr: number;
  us: number;
  /** 그 주 첫 오전 계좌 브리핑이면 브리핑 날짜 ~ 그 주 일요일의 일정 (없으면 빈 배열), 아니면 null */
  week: AccountEventItem[] | null;
}

/** 비중 한 줄의 레버리지·인버스 종목 한 줄 (값이 큰 순). L = 배수의 크기(인버스도 양수), 모르면 null. weight = 비중(%, 소수 한 자리) */
export interface AccountExposureItem {
  code: string;
  name: string;
  kind: "leveraged" | "inverse";
  L: number | null;
  weight: number;
}

/** 합계에서 뺀(시세·환율을 받지 못한) 레버리지·인버스 종목 — 비중을 알 수 없어 weight 가 없다 (등록 순서) */
export type AccountExposureUncounted = Omit<AccountExposureItem, "weight">;

/**
 * 비중 한 줄 (브리핑 3차 4 — exposureOf). 비중 = 종목 원화 평가금액(비용 차감, 앱 잔고와 같은 기준) ÷ 합계에 넣은 종목 값의 합 × 100, 소수 한 자리.
 * 여럿을 더한 비중(상위 3종목·레버리지·인버스·미국 상장)은 원 값을 더한 뒤 반올림한다 (조각 반올림의 합이 아님). 현금·예수금은 모름(토스 보유 조회에 없음) — 분모에 없음
 */
export interface AccountExposure {
  /** 기준 시각 = 계좌 브리핑의 asOf */
  asOf: string;
  /** 비중 분모에 넣은 종목 수 (시세·환율이 있어 합계에 넣은 보유 종목) */
  count: number;
  /** 가장 큰 종목 (값이 같으면 먼저 등록한 종목). 1종목이면 100 */
  top1: { code: string; name: string; weight: number };
  /** 상위 3종목 합 (4종목 이상일 때만, 아니면 null) */
  top3: { weight: number } | null;
  /**
   * 레버리지·인버스 상품 합과 그 종목들 (합계에 넣은 것 — 없으면 weight 0 · 빈 목록).
   * uncounted = 합계에서 뺀 레버리지·인버스 종목 (비중을 모름 — 합계에 넣은 것이 없고 이것만 있으면 앱이 '없음' 대신 '비중 알 수 없음')
   */
  levInv: { weight: number; items: AccountExposureItem[]; uncounted: AccountExposureUncounted[] };
  /**
   * 미국 상장(달러) 종목 합과 그 수 (합계에 넣은 것. 수가 0 이면 앱이 '미국 상장 없음' — 비중이 0.0 으로 반올림되는 작은 보유와 가르려고).
   * uncounted = 합계에서 뺀 미국 종목 수 (환율·시세를 받지 못한 날 — count 가 0 이어도 이것이 있으면 앱이 '없음' 대신 '비중 알 수 없음').
   * 국내 상장 해외 ETF 는 원화 종목이라 들지 않음
   */
  us: { weight: number; count: number; uncounted: number };
  /** 시세·환율이 없어 합계에서 뺀 보유 종목 수 (비중 계산에 없음) */
  excluded: number;
  /** 토스 상품 정보를 받지 못해 이름 규칙으로 레버리지·인버스를 가린 종목 수 (analysis/leveraged levInvOf guessed — 합계에서 뺀 종목도 셈) */
  guessedByName: number;
}

/** 계좌 브리핑이 저장하는 보유 종목 한 줄 (브리핑 3차 3) */
export interface AccountPosition {
  code: string;
  name: string;
  currency: "KRW" | "USD";
  /** 등록한 보유 수량 (자동 동기화가 켜져 있으면 브리핑 직전 토스 동기화 값) */
  quantity: number;
  /** 원화 평가금액(원, 정수, 앱 잔고와 같은 기준 — 합계에 넣은 종목의 합이 totalValue 와 같게 나눔). 시세·환율이 없어 합계에서 뺀 종목은 null */
  value: number | null;
  /** 원화 매입금액(원, 정수 — 합이 totalCost 와 같게 나눔). 합계에서 뺀 종목은 null */
  cost: number | null;
}

/** 수량이 바뀐 종목 한 줄. 새 종목은 from 0, 없어진 종목은 to 0 */
export interface AccountQtyChange {
  code: string;
  name: string;
  from: number;
  to: number;
}

/** 비중(%, 소수 한 자리) 변화 한 줄. change = to − from (보이는 두 값의 차) */
export interface AccountWeightChange {
  code: string;
  name: string;
  from: number;
  to: number;
  change: number;
}

/** 한쪽 브리핑 합계에서만 빠진 종목 한 줄. side = 값이 없던(합계에서 뺀) 브리핑, why = 시세 또는 환율을 받지 못함 */
export interface AccountOneSide {
  code: string;
  name: string;
  side: "prev" | "now";
  why: "price" | "fx";
}

/** 지난 같은 세션 계좌 브리핑과 비교 (브리핑 3차 3 — services/accountSinceLast.compareSinceLast) */
export interface AccountSinceLast {
  /** 비교한 지난 브리핑 (기준 시각 = 두 브리핑의 asOf) */
  prev: { id: number; date: string; session: AccountSession; asOf: string };
  /** 총 평가금액(원): 지난 → 이번. rate = 변화 ÷ 지난 값 (%). scope 가 common 이면 oneSide 종목을 뺀 값 */
  value: { from: number; to: number; change: number; rate: number | null };
  /** 평가손익(원): 지난 → 이번. scope 가 common 이면 oneSide 종목을 뺀 값 */
  profit: { from: number; to: number; change: number };
  /** 수량이 바뀐 종목 (지난 브리핑에 종목별 값이 없으면 null) */
  positions: { added: AccountQtyChange[]; removed: AccountQtyChange[]; increased: AccountQtyChange[]; decreased: AccountQtyChange[] } | null;
  /** 비중 변화가 큰 종목: 두 브리핑 모두 값이 있는 종목 중 0.5%p 이상, 큰 순 3개 (지난 브리핑에 종목별 값이 없으면 null). 분모는 value 의 from·to */
  weights: AccountWeightChange[] | null;
  /** 시세·환율이 없어 합계에서 뺀 종목 (이번 · 지난) */
  excludedNow: Array<{ code: string; name: string }>;
  excludedPrev: Array<{ code: string; name: string }>;
  /**
   * 금액·비중을 어떤 종목으로 비교했는지 (리뷰 고침 — 한쪽 합계에서만 빠진 종목이 가짜 변화를 만들지 않게):
   *  - all: 두 브리핑의 합계 그대로 (한쪽 합계에서만 빠진 종목 없음)
   *  - common: 두 브리핑 모두 보유했는데 한쪽 합계에서만 빠진 종목(oneSide)을 양쪽에서 빼고 비교 (value·profit·weights 모두)
   *  - mixed: 지난 브리핑에 종목별 값이 없어 뺄 수 없는데 합계에서 뺀 종목이 두 브리핑에서 다름 → 금액은 합계 그대로(그 종목 값이 섞였을 수 있음).
   *    목록 headline 에는 한 줄을 싣지 않는다
   */
  scope: "all" | "common" | "mixed";
  /** 한쪽 브리핑 합계에서만 빠진 종목 (common: 두 브리핑 모두 보유 · mixed: 두 브리핑의 합계에서 뺀 종목 목록이 다른 것) */
  oneSide: AccountOneSide[];
}

/** 오늘 한국 휴장인데 국내 보유분이 있는지 (국내 등락이 직전 거래일 것인지) */
export function krPreviousDay(schedule: Pick<AccountSchedule, "kr">, totals: Pick<AccountTotals, "markets">): boolean {
  return !schedule.kr.tradingDay && totals.markets.kr !== null;
}

/** 요약·알림에 붙이는 한 줄 */
export const KR_PREVIOUS_DAY_NOTE = KR_PREVIOUS_DAY_LINE;
export const US_PREVIOUS_DAY_NOTE = US_PREVIOUS_DAY_LINE;

/**
 * 지금 기준으로 가장 최근에 끝났어야 할 미국 정규장의 뉴욕 날짜 (뉴욕 16:00 이 지났으면 그날, 아니면 전날).
 * 오전 브리핑(08:30 KST)은 지난밤 정규장, 오후 브리핑(뉴욕 새벽)도 같은 정규장을 본다
 */
export function usLastSessionDate(now: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const date = `${p["year"]}-${p["month"]}-${p["day"]}`;
  if (Number(p["hour"]) % 24 >= 16) return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 이번 브리핑이 보는 미국 정규장이 쉰 날(뉴욕 날짜). usLastSessionDate 에서 시작해 토·일이면 금요일까지 거슬러 올라가,
 * 그 날이 미국 휴장일이면 그 날짜, 아니면 null. 평일 휴장은 거슬러 올라가지 않는다(그 날짜가 답).
 * 예) 2026-12-28(월) 오전·오후 → 12/27(일) → 12/25(금) 성탄절 휴장 → "2026-12-25". 11/27(금) 오전 → "2026-11-26"(추수감사절)
 */
export function usSkippedSession(now: Date): string | null {
  let d = usLastSessionDate(now);
  for (let i = 0; i < 2; i++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) break;
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() - 1);
    d = x.toISOString().slice(0, 10);
  }
  return isUsTradingDate(d) ? null : d;
}

/**
 * 이번 브리핑이 보는 미국 정규장이 휴장(추수감사절·독립기념일 등)이었는데 미국 보유분이 있는지 → 미국 등락이 그 전 거래일 것(이미 앞 브리핑에 담긴 움직임).
 * 금요일에 쉰 다음 월요일(오전·오후)도 참이다 — 월요일의 미국 몫은 목요일 움직임이라 금요일 아침 브리핑에 이미 담겼다 (usSkippedSession)
 */
export function usPreviousDay(now: Date, totals: Pick<AccountTotals, "markets">): boolean {
  return totals.markets.us !== null && usSkippedSession(now) !== null;
}

/** 상위 몇 종목까지 따로 보여 주는지 (나머지는 '그 외 N종목') */
export const TOP_N = 5;
/** 지수·환율 영향에 쓰는 지수 (지수 띠와 같은 목록에서) */
export const ACCOUNT_INDEX_CODES = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX"] as const;
export const BASIS =
  "총 평가금액은 수수료·세금 예상액을 뺀 값(앱 기본 설정), 당일 손익은 전일 대비 등락 × 수량이며 미국 종목은 적용 환율로 원화 환산(앱 잔고 화면과 같음). 환율 효과는 원/달러 전일 대비 변동으로 따로 계산해 당일 손익에 넣지 않음";
export const KR_HOURS = "정규장 09:00~15:30 · 넥스트레이드 08:00~20:00";

/** 자정부터 분 → "HH:MM" */
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * 오늘 일정의 한국 시간 (서울 날짜). 평소는 KR_HOURS 그대로, 수능일·새해 첫 거래일(krRegularHours 의 reason)은 '정규장 10:00~16:30 (수능일)'.
 * 특수일의 넥스트레이드 시간은 그날 공지를 확인하지 못해 적지 않는다
 */
export function krHoursText(date: string): string {
  const h = krRegularHours(date);
  return h.reason ? `정규장 ${hhmm(h.open)}~${hhmm(h.close)} (${h.reason})` : KR_HOURS;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** 종목의 원화 환율: 시세의 적용 환율, 없으면 원화 환산가 ÷ 가격 (앱 portfolio.fxOf 와 같다) */
export function fxOf(q: NonNullable<AccountHolding["quote"]>): number | null {
  return q.fxRate ?? (q.priceKrw && q.price ? q.priceKrw / q.price : null);
}

/**
 * 실수 여러 개를 정수로 나눈다 (최대 나머지 방식). 결과의 합 = target, 각 값은 원래 값의 내림 또는 올림.
 * target 은 기본이 합의 반올림이고, 위 단계에서 나눈 값(원래 합의 내림 또는 올림)을 줄 수도 있다
 */
export function apportion(values: readonly number[], target = Math.round(sum(values))): number[] {
  const out = values.map((v) => Math.floor(v));
  let rest = target - sum(out);
  const byFrac = values.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  // 보통 rest 는 0..n. 부동소수 오차로 벗어나도 합은 target 에 맞춘다 (큰 조각부터 +1, 작은 조각부터 −1)
  for (let k = 0; rest > 0 && byFrac.length; k = (k + 1) % byFrac.length, rest--) out[byFrac[k]!.i]! += 1;
  for (let k = byFrac.length - 1; rest < 0 && byFrac.length; k = (k - 1 + byFrac.length) % byFrac.length, rest++) out[byFrac[k]!.i]! -= 1;
  return out;
}

interface RawRow {
  code: string;
  name: string;
  currency: "KRW" | "USD";
  fx: number;
  changeRate: number | null;
  stale: boolean;
  value: number;
  cost: number;
  day: number;
  prev: number;
  nowUsd: number;
  prevUsd: number;
}

function bucket(rows: RawRow[], day: number): MarketBucket | null {
  if (!rows.length) return null;
  const prev = sum(rows.map((r) => r.prev));
  return { count: rows.length, value: Math.round(sum(rows.map((r) => r.value))), day, dayRate: prev > 0 ? round2((sum(rows.map((r) => r.day)) / prev) * 100) : null };
}

/** 잔고 목록 → 계좌 합계·당일 손익 기여·환율 효과 */
export function computeAccount(list: readonly AccountHolding[], opts: { afterCost?: boolean; topN?: number; usdKrw?: MarketIndex | null } = {}): AccountTotals {
  const afterCost = opts.afterCost ?? true;
  const topN = opts.topN ?? TOP_N;
  const excluded: AccountTotals["excluded"] = [];
  const rows: RawRow[] = [];
  for (const s of list) {
    const q = s.quote;
    const ev = s.evaluation;
    // 앱 summarize 와 같이 평가(수량·평단)와 시세가 모두 있는 종목만 합계에 넣는다
    if (!q || !ev) {
      if ((s.quantity ?? 0) > 0 && s.avgPrice !== null) excluded.push({ code: s.code, name: s.name, reason: "시세를 받지 못해 합계에서 뺐습니다" });
      continue;
    }
    const currency = q.currency ?? "KRW";
    const fx = currency === "USD" ? fxOf(q) : 1;
    if (!fx) {
      excluded.push({ code: s.code, name: s.name, reason: "환율을 받지 못해 원화 합계에서 뺐습니다" });
      continue;
    }
    const qty = s.quantity ?? 0;
    const native = afterCost && ev.afterCost ? ev.afterCost.marketValue : ev.marketValue;
    if (!Number.isFinite(q.price) || !Number.isFinite(native)) {
      excluded.push({ code: s.code, name: s.name, reason: "시세를 받지 못해 합계에서 뺐습니다" });
      continue;
    }
    // 등락을 모르면(출처가 빈 값) 당일 손익 0 으로 본다 — 합계가 NaN 이 되지 않게
    const change = Number.isFinite(q.change) ? q.change : 0;
    rows.push({
      code: s.code,
      name: s.name,
      currency,
      fx,
      changeRate: Number.isFinite(q.changeRate) ? q.changeRate : null,
      stale: q.stale === true,
      value: native * fx,
      cost: currency === "USD" ? (ev.costBasisKrw ?? ev.costBasis * fx) : ev.costBasis,
      day: change * qty * fx,
      prev: (q.price - change) * qty * fx,
      nowUsd: currency === "USD" ? q.price * qty : 0,
      prevUsd: currency === "USD" ? (q.price - change) * qty : 0,
    });
  }

  const kr = rows.filter((r) => r.currency === "KRW");
  const us = rows.filter((r) => r.currency === "USD");
  const dayRaw = sum(rows.map((r) => r.day));
  const dayPnl = Math.round(dayRaw);
  // 계좌 → 국내·미국 → 종목 순으로 나눠, 어느 단계에서 더해도 위 단계 값과 정확히 같게 한다
  const [krDay, usDay] = apportion([sum(kr.map((r) => r.day)), sum(us.map((r) => r.day))], dayPnl) as [number, number];
  const amount = new Map<RawRow, number>();
  apportion(kr.map((r) => r.day), krDay).forEach((a, i) => amount.set(kr[i]!, a));
  apportion(us.map((r) => r.day), usDay).forEach((a, i) => amount.set(us[i]!, a));

  const ranked = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Math.abs(b.r.day) - Math.abs(a.r.day) || a.i - b.i)
    .map((x) => x.r);
  const top = ranked.slice(0, topN);
  const rest = ranked.slice(topN);

  const valueRaw = sum(rows.map((r) => r.value));
  const costRaw = sum(rows.map((r) => r.cost));
  const prevRaw = sum(rows.map((r) => r.prev));

  return {
    afterCost,
    holdings: rows.length,
    stale: rows.filter((r) => r.stale).length,
    totalValue: Math.round(valueRaw),
    totalCost: Math.round(costRaw),
    // 앱 잔고 합계처럼 평가·매입을 따로 반올림한 뒤 뺀다 (한 번에 반올림하면 .5 를 사이에 두고 1원 달라짐)
    totalProfit: Math.round(valueRaw) - Math.round(costRaw),
    totalProfitRate: costRaw > 0 ? round2(((valueRaw - costRaw) / costRaw) * 100) : null,
    dayPnl,
    dayRate: prevRaw > 0 ? round2((dayRaw / prevRaw) * 100) : null,
    contributions: top.map((r) => ({ code: r.code, name: r.name, currency: r.currency, amount: amount.get(r)!, changeRate: r.changeRate, value: Math.round(r.value) })),
    others: rest.length ? { count: rest.length, amount: sum(rest.map((r) => amount.get(r)!)) } : null,
    markets: { kr: bucket(kr, krDay), us: bucket(us, usDay) },
    excluded,
    fx: fxImpact(us, usDay, opts.usdKrw ?? null),
  };
}

/**
 * 미국 보유분의 원화 평가 변화를 가격 효과와 환율 효과로 나눈다.
 *   원화 변화 = 지금 달러 평가 × 적용 환율 − 전일 달러 평가 × (적용 환율 − 원/달러 변동)
 *            = 달러 등락 × 적용 환율(가격 효과 = 당일 손익의 미국 몫) + 전일 달러 평가 × 원/달러 변동(환율 효과)
 * 원/달러 변동은 지수 띠와 같은 출처(하나은행 매매기준율 전일 대비)라 적용 환율(토스 표시 환율)과 출처가 다르다 — 변동 폭만 쓴다
 */
function fxImpact(us: RawRow[], usDay: number, usdKrw: MarketIndex | null): AccountFx {
  const idx = usdKrw ? { value: usdKrw.value, change: usdKrw.change, changeRate: usdKrw.changeRate, stale: usdKrw.stale === true } : null;
  const none = { usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null };
  if (!us.length) return { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: idx, appliedRate: null, ...none };
  const appliedRate = us[0]!.fx;
  if (!usdKrw || !Number.isFinite(usdKrw.change)) {
    return { status: "unavailable", reason: "원/달러 전일 대비 변동을 받지 못해 환율 효과를 계산하지 못했습니다", usdKrw: idx, appliedRate, ...none };
  }
  const d = usdKrw.change;
  const fxEffect = Math.round(sum(us.map((r) => r.prevUsd * d)));
  // 원화 변화는 나눈 뒤의 두 값의 합으로 정의한다 — 따로 반올림하면 '변화 = 가격 효과 + 환율 효과' 가 1원 어긋날 수 있다.
  // 반올림 전 원래 값(Σ 지금 달러 평가 × 적용 환율 − 전일 달러 평가 × (적용 환율 − 변동))과는 2원 안에서 같다 (테스트)
  return { status: "computed", reason: null, usdKrw: idx, appliedRate, usdHoldingsKrwChange: usDay + fxEffect, priceEffect: usDay, fxEffect };
}

/**
 * 보유 종목별 수량·원화 평가 (브리핑 3차 3, 플래그 accountSinceLast): 수량 > 0·평단 있는 종목 모두, 등록 순서 그대로.
 * 값은 computeAccount 와 같은 규칙(시세·평가가 있고, 미국은 환율이 있어야 합계에 넣음 · afterCost 면 비용 차감)으로 원화 환산해,
 * 합계에 넣은 종목끼리 원 단위로 나눈다 → 값의 합 = totalValue, 매입의 합 = totalCost (정확히). 합계에서 뺀 종목은 value·cost null
 */
export function positionsOf(list: readonly AccountHolding[], opts: { afterCost?: boolean } = {}): AccountPosition[] {
  const afterCost = opts.afterCost ?? true;
  const rows: Array<{ p: AccountPosition; value: number; cost: number } | { p: AccountPosition; value: null; cost: null }> = [];
  for (const s of list) {
    const quantity = s.quantity ?? 0;
    if (!(quantity > 0) || s.avgPrice === null) continue;
    const q = s.quote;
    const ev = s.evaluation;
    // 시세가 있으면 computeAccount 와 같은 통화 규칙(통화 칸이 없으면 KRW) — 포함 여부·환율 곱이 합계와 어긋나지 않게.
    // 시세가 없으면(값 null) 보이는 통화만 코드로 짐작한다
    const currency = q ? (q.currency ?? "KRW") : /^\d/.test(s.code) ? "KRW" : "USD";
    const p: AccountPosition = { code: s.code, name: s.name, currency, quantity, value: null, cost: null };
    const fx = q ? (currency === "USD" ? fxOf(q) : 1) : null;
    const native = ev ? (afterCost && ev.afterCost ? ev.afterCost.marketValue : ev.marketValue) : NaN;
    if (!q || !ev || !fx || !Number.isFinite(q.price) || !Number.isFinite(native)) {
      rows.push({ p, value: null, cost: null });
      continue;
    }
    rows.push({ p, value: native * fx, cost: currency === "USD" ? (ev.costBasisKrw ?? ev.costBasis * fx) : ev.costBasis });
  }
  const counted = rows.filter((r): r is { p: AccountPosition; value: number; cost: number } => r.value !== null);
  // computeAccount 와 같은 반올림: 평가·매입을 따로 반올림한 합계로 나눈다
  const values = apportion(counted.map((r) => r.value));
  const costs = apportion(counted.map((r) => r.cost));
  counted.forEach((r, i) => {
    r.p.value = values[i]!;
    r.p.cost = costs[i]!;
  });
  return rows.map((r) => r.p);
}

/**
 * 비중(%, 소수 한 자리)을 정확히 반올림 (값·합계는 원 단위 정수 — positionsOf). 값 × 1000 ÷ 합계는 절반 경계에서 정확히 '.5' 가 되어 올림된다.
 * (값 ÷ 합계) × 100 × 10 은 21.35 를 213.4999… 로 만들어 21.3 으로 내림하던 것 (브리핑 3차 4 검토 지적). 비중 한 줄·지난 브리핑과 비교가 같이 쓴다
 */
export function weightPct(value: number, total: number): number {
  return Math.round((value * 1000) / total) / 10;
}

/**
 * 비중 한 줄 (브리핑 3차 4, 플래그 accountExposure — 순수). positions = positionsOf 결과(값 null = 합계에서 뺀 종목), kinds = 종목별 레버리지·인버스
 * (analysis/leveraged levInvOf — 없는 종목은 보통 상품, 합계에서 뺀 종목도 넣을 수 있음). 합계에 넣은 종목이 없거나 합이 0 이면 null.
 * 판단하지 않고 숫자만: 가장 큰 종목·상위 3종목(4종목 이상)·레버리지·인버스(값 큰 순)·미국 상장.
 * 합계에서 뺀 미국·레버리지·인버스 종목은 비중에는 없지만 따로 센다(us.uncounted·levInv.uncounted) — 환율을 받지 못한 날 '미국 상장 없음'처럼 사실과 다른 '없음'이 나오지 않게
 */
export function exposureOf(
  positions: readonly AccountPosition[],
  kinds: ReadonlyMap<string, { kind: "leveraged" | "inverse" | null; L: number | null; guessed: boolean }>,
  asOf: string,
): AccountExposure | null {
  const counted = positions.map((p, i) => ({ p, i })).filter((x): x is { p: AccountPosition & { value: number }; i: number } => x.p.value !== null);
  const left = positions.filter((p) => p.value === null);
  const total = sum(counted.map((x) => x.p.value));
  if (!counted.length || !(total > 0)) return null;
  const weight = (v: number) => weightPct(v, total);
  const levKind = (code: string) => {
    const k = kinds.get(code);
    return k && (k.kind === "leveraged" || k.kind === "inverse") ? { kind: k.kind, L: k.L } : null;
  };
  // 값이 큰 순, 같으면 먼저 등록한 종목
  const ranked = [...counted].sort((a, b) => b.p.value - a.p.value || a.i - b.i);
  const top = ranked[0]!.p;
  const usd = counted.filter((x) => x.p.currency === "USD");
  const lev = ranked.filter((x) => levKind(x.p.code) !== null);
  return {
    asOf,
    count: counted.length,
    top1: { code: top.code, name: top.name, weight: weight(top.value) },
    top3: counted.length > 3 ? { weight: weight(sum(ranked.slice(0, 3).map((x) => x.p.value))) } : null,
    levInv: {
      weight: weight(sum(lev.map((x) => x.p.value))),
      items: lev.map((x) => ({ code: x.p.code, name: x.p.name, ...levKind(x.p.code)!, weight: weight(x.p.value) })),
      uncounted: left.flatMap((p) => {
        const k = levKind(p.code);
        return k ? [{ code: p.code, name: p.name, ...k }] : [];
      }),
    },
    us: { weight: weight(sum(usd.map((x) => x.p.value))), count: usd.length, uncounted: left.filter((p) => p.currency === "USD").length },
    excluded: left.length,
    guessedByName: positions.filter((p) => kinds.get(p.code)?.guessed === true).length,
  };
}

/** 지수·환율 영향에 쓰는 지수 (없으면 missing) */
export function pickIndices(list: readonly MarketIndex[]): { rows: AccountIndexRow[]; missing: string[] } {
  const rows: AccountIndexRow[] = [];
  const missing: string[] = [];
  const names: Record<string, string> = { KOSPI: "코스피", KOSDAQ: "코스닥", NASDAQ: "나스닥", SPX: "S&P500" };
  for (const code of ACCOUNT_INDEX_CODES) {
    const i = list.find((x) => x.code === code);
    if (!i) missing.push(names[code]!);
    else rows.push({ code, name: i.name, value: i.value, change: i.change, changeRate: i.changeRate, open: i.open, stale: i.stale === true });
  }
  return { rows, missing };
}

// ── 오늘 일정 ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** 시간대의 UTC 오프셋(분, 현지 − UTC) */
function offsetMin(tz: string, t: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]) % 24, Number(p["minute"]));
  return Math.round((asUtc - Math.floor(t / 60_000) * 60_000) / 60_000);
}

/** 뉴욕 현지 날짜·시각 → 그 순간 (서머타임 반영). 시장 요약(marketSummaryCalc·marketEvents)도 쓴다 */
export function nyWall(date: string, h: number, m: number): number {
  const guess = Date.parse(`${date}T${pad(h)}:${pad(m)}:00Z`);
  const off = offsetMin("America/New_York", guess);
  const t = guess - off * 60_000;
  const off2 = offsetMin("America/New_York", t);
  return off2 === off ? t : guess - off2 * 60_000;
}

/** 순간 → 한국 시간 "9/25 22:30" */
export function kstShort(t: number | string): string {
  const ms = typeof t === "string" ? Date.parse(t) : t;
  const iso = new Date(ms + 9 * 3_600_000).toISOString();
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${iso.slice(11, 16)}`;
}

/** 지금 기준으로 다음(또는 진행 중인) 미국 정규장의 뉴욕 날짜: 뉴욕 16:00 전이면 오늘, 뒤면 다음 날 */
export function usSessionDate(now: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const date = `${p["year"]}-${p["month"]}-${p["day"]}`;
  if (Number(p["hour"]) % 24 < 16) return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 미국 정규장(09:30~마감 ET)을 한국 시간으로: "정규장 9/25 22:30~9/26 05:00 (한국 시간)".
 * 마감(closeMinutes, 뉴욕 자정부터 분)이 16:00 이 아니면(조기 폐장 13:00) 끝에 ' · 조기 폐장'
 */
export function usRegularKst(nyDate: string, closeMinutes = 16 * 60): string {
  const early = closeMinutes !== 16 * 60 ? " · 조기 폐장" : "";
  return `정규장 ${kstShort(nyWall(nyDate, 9, 30))}~${kstShort(nyWall(nyDate, Math.floor(closeMinutes / 60), closeMinutes % 60))} (한국 시간)${early}`;
}

/** 오늘 일정: 한국·미국 장 운영(달력·휴장 목록)과 지금 상태, 종목 브리핑이 받아 둔 최근 공시 */
export function buildSchedule(status: MarketStatus | null, now: Date, disclosures: AccountDisclosure[]): AccountSchedule {
  const date = seoulDate(now);
  // 달력이 없으면 요일과 한국 휴장일 목록(KR_HOLIDAYS)으로 짐작한다
  const krTrading = status ? status.KR.isTradingDay : isKrTradingDate(date);
  const usDate = usSessionDate(now);
  const usTrading = isUsTradingDate(usDate);
  return {
    kr: {
      date,
      tradingDay: krTrading,
      now: marketContext("005930", status, now).label,
      hours: krTrading ? krHoursText(date) : null,
      nextOpen: krTrading ? null : (status?.KR.opensAt ?? null),
    },
    us: { date: usDate, tradingDay: usTrading, now: marketContext("AAPL", status, now).label, hours: usTrading ? usRegularKst(usDate, usRegularCloseMinutes(usDate, status?.US ?? null)) : null },
    disclosures,
  };
}

// ── 문장 ────────────────────────────────────────────────────

/** "+1,234원" · "-2,868,108원" · "0원" (알림 묶음과 같은 표기) */
export const won = formatWon;

const idx = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number, text: string) => (v > 0 ? `+${text}` : v < 0 ? `-${text}` : text);
const SESSION_KO: Record<AccountSession, string> = { morning: "오전", afternoon: "오후" };

/**
 * 요약·알림·카드의 '기여 1위·2위': 당일 손익과 같은 방향(오른 날은 올린 종목, 내린 날은 내린 종목)만 크기 순으로.
 * 표(contributions)는 크기 순 그대로 둔다 — 오른 날 '기여 1위'가 손실 종목으로 보이지 않게. 당일 손익이 0 이면 크기 순
 */
export function leaders(d: { dayPnl: number; contributions: readonly AccountRow[] }): AccountRow[] {
  const dir = Math.sign(d.dayPnl);
  return dir === 0 ? [...d.contributions] : d.contributions.filter((c) => Math.sign(c.amount) === dir);
}

/**
 * 알림·카드용 요약 두 줄 (코드로 만든다 — 숫자가 늘 맞게). 오늘 한국 휴장이면 국내 등락이, 지난밤 미국 평일 휴장이면 미국 등락이
 * 직전 거래일 것임을 다음 줄에 밝힌다. 미국 휴장일이 브리핑 날짜의 전날이 아니면(금요일 휴장 다음 월요일) '12/25(금) 미국 휴장 …'.
 * date 가 없으면 예전 문구(US_PREVIOUS_DAY_NOTE)
 */
export function summaryText(d: AccountTotals & { krPreviousDay?: boolean; usPreviousDay?: boolean; date?: string; usHolidayDate?: string }): string {
  const top = leaders(d)[0];
  const line1 = `당일 ${won(d.dayPnl)}${d.dayRate !== null ? ` (${formatRate(d.dayRate)})` : ""}${top ? ` · 기여 1위 ${top.name} ${won(top.amount)}` : ""}`;
  const line2 = `총 평가금액 ${won(d.totalValue, false)}${d.fx.status === "computed" ? ` · 환율 효과 ${won(d.fx.fxEffect!)}` : ""}`;
  const usLine = d.date ? usPreviousDayLine(d.date, d.usHolidayDate) : US_PREVIOUS_DAY_NOTE;
  return [line1, line2, ...(d.krPreviousDay ? [KR_PREVIOUS_DAY_NOTE] : []), ...(d.usPreviousDay ? [usLine] : [])].join("\n");
}

function contributionLine(r: AccountRow, rank: number): string {
  return `${rank}. ${r.name}: ${won(r.amount)}${r.changeRate !== null ? ` (등락률 ${formatRate(r.changeRate)})` : ""}`;
}

function fxLine(fx: AccountFx): string {
  const rate = fx.usdKrw ? `원/달러 ${idx(fx.usdKrw.value)}원 (전일 대비 ${signed(fx.usdKrw.change, `${idx(Math.abs(fx.usdKrw.change))}원`)}, ${formatRate(fx.usdKrw.changeRate)})${fx.usdKrw.stale ? " · 지연된 값" : ""}` : null;
  if (fx.status === "computed") {
    return `${rate}. 미국 보유분 원화 평가 변화 ${won(fx.usdHoldingsKrwChange!)} = 가격 효과 ${won(fx.priceEffect!)} + 환율 효과 ${won(fx.fxEffect!)} (환율 효과는 당일 손익에 넣지 않음)`;
  }
  if (fx.status === "none") return `${rate ? `${rate}. ` : ""}환율 효과: 해당 없음 — ${fx.reason}`;
  return `${rate ? `${rate}. ` : ""}환율 효과: 계산하지 못함 — ${fx.reason}`;
}

function scheduleLines(s: AccountSchedule): string[] {
  // 장 상태는 브리핑을 만든 때의 것이다 — '지금'이라고 적으면 나중에 연 사람이(또는 모델 설명이) 현재 상태로 읽는다
  const out = [
    `한국: ${s.kr.tradingDay ? `오늘 거래일, ${s.kr.hours}` : `오늘 휴장${s.kr.nextOpen ? ` (다음 개장 ${kstShort(s.kr.nextOpen)})` : ""}`}. 브리핑 시각 기준: ${s.kr.now}`,
    `미국: ${s.us.tradingDay ? `${Number(s.us.date.slice(5, 7))}/${Number(s.us.date.slice(8, 10))}(현지) ${s.us.hours}` : `${Number(s.us.date.slice(5, 7))}/${Number(s.us.date.slice(8, 10))}(현지) 휴장`}. 브리핑 시각 기준: ${s.us.now}`,
  ];
  // 공시 건수를 적어 둔다 — 기본 문장의 '최근 공시 N건'이 사실 안의 숫자가 되게. 기간은 숫자·수 낱말 없이
  // ('3일'·'사흘'이 사실에 있으면 '3일 연속'·'사흘 연속' 같은 지어낸 말이 통과한다)
  if (s.disclosures.length) out.push(`최근 공시 ${s.disclosures.length}건: ${s.disclosures.map((x) => `${x.name} "${x.title}" (${x.filedAt})`).join(" / ")}`);
  else out.push("최근 공시: 보유 국내 종목의 최근 공시 없음(종목 브리핑이 받아 둔 것 기준)");
  return out;
}

/** 모델에게 주는 '사실' 목록. 모델의 설명에 나온 숫자는 모두 이 안에 있어야 한다 */
export function factsText(d: AccountData): string {
  const lines: string[] = [];
  lines.push(`- 날짜: ${d.date} ${SESSION_KO[d.session]} 브리핑`);
  lines.push(`- 기준: ${d.basis}`);
  lines.push(`- 총 평가금액: ${won(d.totalValue, false)} (보유 ${d.holdings}종목${d.stale ? `, 시세 지연 ${d.stale}종목` : ""})`);
  lines.push(`- 당일 손익: ${won(d.dayPnl)}${d.dayRate !== null ? ` (${formatRate(d.dayRate)})` : ""}`);
  if (d.krPreviousDay) lines.push("- 참고: 오늘 한국은 휴장이라 국내 종목의 등락률과 당일 손익은 직전 거래일 것입니다(앱 잔고 화면과 같은 기준)");
  if (d.usPreviousDay) lines.push(`- 참고: ${usHolidayWhen(d.date, d.usHolidayDate)} 미국은 휴장이라 미국 종목의 등락률과 당일 손익은 직전 거래일 것입니다(앞 브리핑에 이미 담긴 움직임, 앱 잔고 화면과 같은 기준)`);
  lines.push(`- 누적 평가손익: ${won(d.totalProfit)}${d.totalProfitRate !== null ? ` (${formatRate(d.totalProfitRate)})` : ""}`);
  const m: string[] = [];
  if (d.markets.kr) m.push(`국내 보유분 ${d.markets.kr.count}종목 ${won(d.markets.kr.day)}${d.markets.kr.dayRate !== null ? ` (${formatRate(d.markets.kr.dayRate)})` : ""}`);
  if (d.markets.us) m.push(`미국 보유분 ${d.markets.us.count}종목 ${won(d.markets.us.day)}${d.markets.us.dayRate !== null ? ` (${formatRate(d.markets.us.dayRate)})` : ""}`);
  if (m.length) lines.push(`- 시장별 당일 손익: ${m.join(" / ")}`);
  if (d.contributions.length) {
    lines.push(`- 당일 손익 기여 상위 ${d.contributions.length}종목:`);
    d.contributions.forEach((r, i) => lines.push(`  ${contributionLine(r, i + 1)}`));
    if (d.others) lines.push(`  그 외 ${d.others.count}종목: ${won(d.others.amount)}`);
  }
  if (d.indices.length) lines.push(`- 지수: ${d.indices.map((i) => `${i.name} ${idx(i.value)} (${formatRate(i.changeRate)}${i.stale ? ", 지연" : ""})`).join(", ")}`);
  if (d.missingIndices.length) lines.push(`- 받지 못한 지수: ${d.missingIndices.join(", ")}`);
  lines.push(`- 환율: ${fxLine(d.fx)}`);
  for (const l of scheduleLines(d.schedule)) lines.push(`- ${l}`);
  if (d.excluded.length) lines.push(`- 합계에서 뺀 종목: ${d.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}`);
  return lines.join("\n");
}

/**
 * 모델 설명을 쓸 수 없을 때의 기본 문장 (숫자만으로). 기여는 표·사실 목록과 같은 줄(상위 TOP_N + 그 외)을 모두 적는다 —
 * 적은 금액을 더하면 당일 손익과 정확히 같다 (일부만 적고 '그 외'를 붙이면 빠진 순위가 생긴다)
 */
export function templateNarrative(d: AccountData): string {
  const out: string[] = [];
  const top = leaders(d)[0];
  out.push(`- ${SESSION_KO[d.session]} 기준 당일 손익은 ${won(d.dayPnl)}${d.dayRate !== null ? `(${formatRate(d.dayRate)})` : ""}입니다.${top ? ` 가장 크게 기여한 종목은 ${top.name}(${won(top.amount)})입니다.` : ""}`);
  if (d.krPreviousDay) out.push("- 오늘 한국은 휴장이라 국내 종목의 당일 손익은 직전 거래일 등락입니다.");
  if (d.usPreviousDay) out.push(`- ${usHolidayWhen(d.date, d.usHolidayDate)} 미국은 휴장이라 미국 종목의 당일 손익은 직전 거래일 등락입니다(앞 브리핑에 이미 담긴 움직임).`);
  if (d.contributions.length > 1 || d.others) {
    const listed = d.contributions.map((r) => `${r.name} ${won(r.amount)}`).join(", ");
    out.push(`- 기여 순서: ${listed}${d.others ? `, 그 외 ${d.others.count}종목 ${won(d.others.amount)}` : ""}.`);
  }
  const idxText = d.indices.map((i) => `${i.name} ${formatRate(i.changeRate)}`).join(", ");
  const mk: string[] = [];
  if (d.markets.kr?.dayRate != null) mk.push(`국내 보유분 ${formatRate(d.markets.kr.dayRate)}`);
  if (d.markets.us?.dayRate != null) mk.push(`미국 보유분 ${formatRate(d.markets.us.dayRate)}`);
  if (idxText || mk.length) out.push(`- ${[mk.join(", "), idxText ? `지수는 ${idxText}` : ""].filter(Boolean).join(" · ")}.`);
  if (d.fx.status === "computed") out.push(`- 원/달러 변동으로 미국 보유분의 원화 가치가 ${won(d.fx.fxEffect!)} 달라졌습니다(환율 효과, 당일 손익에는 넣지 않음).`);
  else if (d.fx.status === "unavailable") out.push(`- 환율 효과는 계산하지 못했습니다: ${d.fx.reason}`);
  const s = d.schedule;
  out.push(`- 오늘 일정: 한국 ${s.kr.tradingDay ? "거래일" : "휴장"}, 미국 ${s.us.tradingDay ? s.us.hours : "휴장"}.${s.disclosures.length ? ` 최근 공시 ${s.disclosures.length}건.` : ""}`);
  return out.join("\n");
}

// ── 모델 설명 검사 ────────────────────────────────────────────

/**
 * 글 속 숫자 하나. 날짜·시각은 key("9/25"·"22:30")로, 나머지는 값·단위·부호·말로 적은 방향을 함께 맞춰 본다.
 * (값만 보면 '20% 하락'이 장 시간 20:00 으로, '+30,089원'이 -30,089원으로, '8.06% 올랐'이 -8.06% 로, '9종목'이 순위 9 로 통과한다)
 */
export interface NumberToken {
  /** 글에 적힌 모양 (부호·단위 포함, 이유 표시용) */
  raw: string;
  kind: "num" | "date" | "time";
  /** date: "9/25" · time: "22:30" · num: "" */
  key: string;
  value: number;
  /**
   * num 의 단위: % · %p · 원 · pt(포인트) · 만(억·조·천) · 달러 · 년 · 월 ·
   * 개수 낱말 그대로(종목·건·주·일·회·개·곳·줄·가지) · 순서(위·번째) · 기간('3일 연속'·'2주째') ·
   * rank(사실의 목록 번호 '1. 리게티 컴퓨팅') · ?(모르는 접미어: '4거래일'·'2배') · ""(없음)
   */
  unit: string;
  /**
   * 적혀 있는 부호 (+·-·−·전각·'플러스/마이너스'·▲▼, 강조·코드·취소선·따옴표·괄호·빈칸이 끼어 있어도). 부호 없이 쓴 숫자는 null.
   * "?": 뜻이 갈리는 표시(△·±), 모르는 기호(▴·➕·📈·˗…)이거나 부호끼리 어긋남('플러스 -3원') — 어느 사실과도 맞추지 않는다
   */
  sign: "+" | "-" | "?" | null;
  /** 소수점이 있는지 */
  decimal: boolean;
  /** 숫자 바로 뒤에 말로 적은 방향: 올랐·상승·이익 +1, 내렸·하락·손실 -1, 없으면 0 */
  dir: 1 | -1 | 0;
  /** 방향으로 읽은 말 (이유 표시용) */
  dirWord: string;
  /** 방향을 숫자에 바로 붙은 화살표로 적었는지 ('8.06%↓') — 부호를 적은 것으로 본다 */
  arrowAfter: boolean;
}

const DATE_TIME: Array<{ re: RegExp; kind: "date" | "time"; key: (m: RegExpExecArray) => string }> = [
  // 2026-09-25 → 9/25 (연도는 맞춰 보지 않는다)
  { re: /(?<![\d.,])\d{4}-(\d{1,2})-(\d{1,2})(?!\d)/g, kind: "date", key: (m) => `${Number(m[1])}/${Number(m[2])}` },
  { re: /(?<![\d.,])(?:\d{4}년\s?)?(\d{1,2})월\s?(\d{1,2})일/g, kind: "date", key: (m) => `${Number(m[1])}/${Number(m[2])}` },
  { re: /(?<![\d.,/])(\d{1,2})\/(\d{1,2})(?![\d/])/g, kind: "date", key: (m) => `${Number(m[1])}/${Number(m[2])}` },
  { re: /(?<![\d.,:])(\d{1,2}):(\d{2})(?![\d:])/g, kind: "time", key: (m) => `${Number(m[1])}:${m[2]}` },
  { re: /(?<![\d.,])(\d{1,2})시(?![간세작])(?:\s?(\d{1,2})분)?/g, kind: "time", key: (m) => `${Number(m[1])}:${String(Number(m[2] ?? 0)).padStart(2, "0")}` },
];

/**
 * 숫자 바로 뒤(빈칸 하나까지)의 단위 → 정규화한 단위. '3일 연속'·'2주째' 같은 기간은 따로('기간') 본다.
 * '퍼센트포인트'·'퍼센트 포인트'·'% 포인트'는 '%'보다 먼저 읽어 %p 로 (표기에 따라 %·%p 가 갈리지 않게)
 */
const UNIT_RE = /^\s?(%p|%\s?포인트|퍼센트\s?포인트|%|퍼센트|원|포인트|pt(?![A-Za-z])|p(?![A-Za-z])|만|억|조|천|달러|종목|번째|가지|위|건|줄|개|[일주]\s?(?:연속|동안|째|간)|일|곳|회|주|년|월)/;
/** 'N일' 뒤에 붙으면 날짜의 일이 아니라 기간 ('25일 만에'·'24일 만의 최대'·'25일 넘게') */
const DAYS_SPAN = /^\s?(?:만[에의이]?|넘|이상|이내|새|가량|남짓|안팎|여(?![가-힣])|사이)/;
function normUnit(u: string | undefined): string {
  if (!u) return "";
  if (u === "%" || u === "퍼센트") return "%";
  if (u === "%p" || /^(?:%|퍼센트)\s?포인트$/.test(u)) return "%p";
  if (u === "포인트" || u === "pt" || u === "p") return "pt";
  if (u === "억" || u === "조" || u === "천") return "만";
  if (/^[일주]\s?(?:연속|동안|째|간)$/.test(u)) return "기간";
  // 원 · 만 · 달러 · 년 · 월, 개수 단위는 낱말 그대로(종목·건·주·일·회·개…: 같은 낱말끼리만 맞춰 본다), 순서(위·번째)
  return u;
}
/**
 * 숫자를 읽기 전에 모양을 맞춘다: 전각 숫자·부호('＋２５０，２６７')·특수 빈칸은 NFKC 로 보통 글자로 바꾸고,
 * 폭 없는 글자·서식 문자(\p{Cf})와 이모지 모양 선택자(➕의 U+FE0F)는 지운다 (부호와 숫자 사이에 숨은 것).
 * 글과 사실을 똑같이 바꾸므로 옮겨 쓴 숫자는 그대로 맞는다
 */
function normalizeNumbers(text: string): string {
  return text.normalize("NFKC").replace(/[\p{Cf}\ufe00-\ufe0f]/gu, "");
}

/**
 * 부호와 숫자 사이(또는 부호 표시끼리 사이)에 끼어도 건너뛰는 것 — 개수·순서와 상관없이:
 * 빈칸(여러 칸·탭·줄바꿈), 강조·코드·취소선(* _ ` ~), 따옴표, 여는 괄호 ('**+** 250,267원'·'`+` 250,267원'·'-~~39,240원~~'·'+(250,267원)')
 */
const SIGN_GAP = /[\s*_`~"'“”‘’«»「」『』〈〉《》([{]/u;
const PLAIN_SIGN = /^[+\-−]$/;
/** 긴 줄표: 숫자에 붙어 있을 때만 빼기 ('—39,240원'), 띄우면 문장 부호 ('엔비디아 — 39,240원') */
const DASH_SIGN = /^[–—‒―‐]$/;
const ARROW_UP = /[▲↑⬆🔺]/u;
const ARROW_DOWN = /[▼▽↓⬇🔻]/u;
/** 뜻이 갈리는 표시: 회계의 △(마이너스)와 상승 표시, ± */
const AMBIGUOUS_SIGN = /^[△±∓]$/;
/** 숫자 앞에 와도 부호가 아닌 기호 ('변화 = -209,723원'·'코스피 → -0.80%'·표의 '|'·통화 기호) */
const NEUTRAL_SYMBOL = /^[=→⇒|<>$₩€¥£]$/u;
/** 그 밖의 기호(▴ ▾ ↗ ⇧ ➕ ➖ 📈 ˗ …)와 줄표 모양: 부호인지 알 수 없으므로 '?' (어느 사실과도 맞추지 않는다) */
const OTHER_SYMBOL = /^[\p{S}\p{Pd}]$/u;
/** 숫자에 바로 붙은 뒤 화살표 ('8.06%↑'). 다음 숫자 앞에 놓인 화살표('1.99% ▼12,000원')는 그 숫자의 것이라 빈칸 없이 붙은 것만 */
const ARROW_AFTER = /^[*_`"'“”‘’«»「」『』〈〉《》]*([▲↑⬆🔺▼▽↓⬇🔻])(?![ \t]?[+\-−–—‒―‐\d])/u;

/** 줄 머리부터 부호 앞까지가 들여쓰기와 목록·인용 표시('- '·'* '·'+ '·'1. '·'2) '·'>')뿐인지 — 그 뒤의 '- '·'+ '는 (안쪽) 글머리표 */
const LIST_PREFIX = /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+|>[ \t]*)*$/;

/** end 바로 앞의 한 글자 (이모지 같은 서로게이트 쌍은 두 칸을 한 글자로) */
function charBefore(s: string, end: number): string {
  if (end <= 0) return "";
  const lo = s.charCodeAt(end - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
    const hi = s.charCodeAt(end - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(end - 2, end);
  }
  return s[end - 1]!;
}

/**
 * 숫자 앞의 부호: 읽은 부호, 부호 표시가 시작하는 곳, 이유에 보일 모양.
 * 숫자에서 앞으로 한 표시씩 읽는다: [틈] 부호 표시 [틈] 부호 표시 … (틈 = SIGN_GAP, 부호 표시는 넷까지)
 *  - 부호 표시: + - −, 붙은 긴 줄표, 플러스·마이너스, ▲▼↑↓, 뜻이 갈리는 △± 와 모르는 기호('?')
 *  - 부호 앞 글자는 숫자만 빼고 가리지 않는다 ('엔비디아-39,240원'·'→+8.06%')
 *  - 줄 머리의 '- '·'+ '(마크다운 글머리표)와 숫자에 바로 붙은 빼기 모양('1-2위')은 부호가 아니다. 다른 목록·인용 표시 뒤의
 *    '- '·'+ '('- - 1원'·'1. - 1원'·'> - 1원'·들여쓴 '  - + 1원')도 안쪽 글머리표가 되어 화면에서 사라지므로 부호가 아니다.
 *    줄 머리는 날짜·시각을 지우기 전 글(lineSrc)로 본다 — 지운 자리의 빈칸('- 9/25 - 1원')을 목록 표시로 읽지 않게
 */
function signBefore(rest: string, at: number, lineSrc: string = rest): { sign: NumberToken["sign"]; start: number; shown: string } {
  const floor = Math.max(0, at - 32);
  const signs = new Set<"+" | "-" | "?">();
  const shown: string[] = [];
  let start = at;
  for (let n = 0; n < 4; n++) {
    let j = start;
    while (j > floor && SIGN_GAP.test(rest[j - 1]!)) j--;
    const spaced = /\s/.test(rest.slice(j, start));
    const word = /(플러스|마이너스)$/.exec(rest.slice(Math.max(0, j - 4), j));
    if (word) {
      signs.add(word[1] === "플러스" ? "+" : "-");
      shown.unshift(`${word[1]} `);
      start = j - word[1]!.length;
      continue;
    }
    const ch = charBefore(rest, j);
    if (!ch || j <= floor) break;
    const chAt = j - ch.length;
    const prev = rest[chAt - 1] ?? "";
    let sign: "+" | "-" | "?";
    if (PLAIN_SIGN.test(ch)) {
      if (spaced && LIST_PREFIX.test(lineSrc.slice(lineSrc.lastIndexOf("\n", chAt - 1) + 1, chAt))) break; // 글머리표 (안쪽 포함)
      if (ch !== "+" && /\d/.test(prev)) break; // 범위·이음표
      sign = ch === "+" ? "+" : "-";
    } else if (DASH_SIGN.test(ch)) {
      if (spaced || /\d/.test(prev)) break;
      sign = "-";
    } else if (ARROW_UP.test(ch)) sign = "+";
    else if (ARROW_DOWN.test(ch)) sign = "-";
    else if (AMBIGUOUS_SIGN.test(ch)) sign = "?";
    else if (NEUTRAL_SYMBOL.test(ch)) break;
    else if (OTHER_SYMBOL.test(ch)) sign = "?";
    else break;
    signs.add(sign);
    shown.unshift(PLAIN_SIGN.test(ch) || DASH_SIGN.test(ch) ? sign : ch);
    start = chAt;
  }
  const sign = signs.size === 0 ? null : signs.size > 1 || signs.has("?") ? "?" : [...signs][0]!;
  return { sign, start, shown: shown.join("") };
}

/** 숫자에 바로 붙어도 단위가 아닌 조사 ('3,412.35로'). 이것이 아닌 글자가 붙으면('4거래일'·'2배') 모르는 단위('?')로 본다 */
const JOSA_RE = /^(?:으로|로|에서|에|까지|부터|보다|은|는|이|가|을|를|와|과|도|의|였|입|인|라|며|나)/;
/**
 * 방향을 말로 적은 것 (숫자 뒤). '수익률'·'평가손익'은 방향이 아니다.
 * 부호를 뺀 숫자는 방향 낱말과 상관없이 거절하므로(checkNarrative), 이 목록은 부호를 적고도 말로 뒤집은 것('+39,240원 손해')과 이유 표시에 쓴다
 */
const DIR_UP =
  /상승|올라|오른|올랐|오르|올렸|올려|오름|끌어올|이익|이득|수익(?!률)|평가익|흑자|강세|플러스|늘어|늘었|늘린|증가|벌었|벌어들|벌어다|뛰|급등|폭등|상향/;
const DIR_DOWN =
  /하락|내려|내린|내렸|내리|내림|끌어내|떨어|손실|손해|평가손(?!익)|(?<!누)적자|약세|마이너스|줄어|줄었|줄인|감소|잃|빠졌|빠져|빠지|빠진|밀렸|밀려|밀리|급락|폭락|하향|낙폭|날렸|깎|까먹|부진|악화/;
/** '손실을 (일부) 줄였'·'하락폭을 만회'는 이익 쪽, '이익을 줄였'·'상승폭을 반납'은 손실 쪽 — 낱말 하나만 보면 반대로 읽힌다 */
const REDUCE_UP = /(?:손실|손해|하락|낙폭|적자)폭?(?:을|를|이|가)?\s?(?:일부\s?|조금\s?|다소\s?|크게\s?)?(?:줄|만회|상쇄|메웠|메워|덜)/;
const REDUCE_DOWN = /(?:이익|이득|수익|상승|오름|흑자)폭?(?:을|를|이|가)?\s?(?:일부\s?|조금\s?|다소\s?|크게\s?)?(?:줄|반납|깎|덜)/;
/** 맞대는 말: 이 뒤의 방향 낱말은 앞 숫자의 것이 아니다 */
const CONTRAST = /(?:와|과)(?:는)?\s?(?:달리|반대로|대조적으로)/;
/**
 * 숫자 바로 앞 어절이 방향 낱말(+ 률·폭·액·분·세, + 조사)이면 ('손실 39,240원'·'이익은 250,267원'·'상승률 8.06%'·'손실액 +39,240원').
 * 동사('내려')는 앞 숫자의 말이라 보지 않고, 방향 낱말로 시작하는 다른 말('하락장에서도'·'하락세에도')은 숫자의 방향이 아니라 보지 않는다
 */
const DIR_BEFORE_UP = /^(상승|이익|이득|수익(?!률)|평가익|흑자|강세|플러스|증가|급등|폭등|상향|오름)(?:률|율|폭|액|분|세)?(?:은|는|이|가|도|을|를|의|만)?$/;
const DIR_BEFORE_DOWN = /^(하락|손실|손해|평가손(?!익)|적자|약세|마이너스|감소|급락|폭락|하향|낙폭|내림)(?:률|율|폭|액|분|세)?(?:은|는|이|가|도|을|를|의|만)?$/;

/**
 * 숫자 바로 뒤에 말로 적은 방향: 붙은 글자와 다음 두 어절 안에 '올랐·상승·이익·강세'면 +1, '내렸·하락·손실·약세'면 -1.
 * '손실을 줄였' 같은 말은 그 절 안 어디에 있어도 먼저 본다.
 * 쉼표·마침표·괄호(여닫기)·다음 숫자에서 멈춘다 (다른 숫자의 방향을 가져오지 않게: '엔비디아(+39,240원)와 … 손실을'). 다음 숫자 바로 앞의 '플러스·마이너스'는 그 숫자의 부호다
 */
function directionAfter(s: string): { dir: 1 | -1 | 0; word: string; arrow: boolean } {
  const arrow = ARROW_AFTER.exec(s);
  if (arrow) return { dir: ARROW_UP.test(arrow[1]!) ? 1 : -1, word: arrow[1]!, arrow: true };
  const stop = s.search(/[\d,.;·/|()[\]{}\n]/);
  let head = stop < 0 ? s : s.slice(0, stop);
  if (stop >= 0 && /\d/.test(s[stop]!)) head = head.replace(/(?:마이너스|플러스)\s?$/, "");
  // '나스닥 +0.35%와 달리 내렸고': '와 달리'·'와 반대로' 뒤의 말은 다른 주어의 방향이다
  const contrast = head.search(CONTRAST);
  if (contrast >= 0) head = head.slice(0, contrast);
  const scope = /^\s*(?:\S+\s+){0,2}\S*/.exec(head)![0]; // 앞 세 어절 (자리를 그대로 두어 head 와 위치가 맞게)
  const found = [
    { m: REDUCE_UP.exec(head), dir: 1 as const },
    { m: REDUCE_DOWN.exec(head), dir: -1 as const },
    { m: DIR_UP.exec(scope), dir: 1 as const },
    { m: DIR_DOWN.exec(scope), dir: -1 as const },
  ]
    .filter((x): x is { m: RegExpExecArray; dir: 1 | -1 } => x.m !== null)
    .sort((a, b) => a.m.index - b.m.index); // 같은 자리면 '손실을 줄'이 '손실'보다 먼저 (안정 정렬)
  const first = found[0];
  return first ? { dir: first.dir, word: first.m[0], arrow: false } : { dir: 0, word: "", arrow: false };
}

/** 숫자 바로 앞 어절(빈칸 하나까지, 강조 기호는 건너뜀)에 적은 방향 */
function directionBefore(before: string): { dir: 1 | -1 | 0; word: string } {
  const w = /([가-힣]+)[*_`"'“”‘’]*\s?[*_`"'“”‘’]*$/.exec(before.slice(-24))?.[1];
  if (!w) return { dir: 0, word: "" };
  const up = DIR_BEFORE_UP.exec(w);
  if (up) return { dir: 1, word: up[1]! };
  const down = DIR_BEFORE_DOWN.exec(w);
  if (down) return { dir: -1, word: down[1]! };
  return { dir: 0, word: "" };
}

/**
 * 숫자를 한글로 적은 금액·비율 ('이십오만 원'·'만 육천 원'·'수만 원'·'팔 퍼센트'·'팔 프로') — 사실의 숫자와 맞춰 볼 수 없으니 입력에 없는 숫자로 본다.
 * '원화'·'원/달러'는 금액이 아니고, 숫자 뒤의 '만 원'('287만 원')은 숫자로 따로 읽는다
 */
const KO_NUMERAL =
  /(?<![가-힣]|[\d.,]\s?)(?:[일이삼사오육칠팔구수몇]?[십백천만억조]\s?)+[일이삼사오육칠팔구]?\s*(?:원(?!화|\/|달러)|퍼센트|프로(?![가-힣])|달러)|(?<![가-힣]|[\d.,]\s?)[일이삼사오육칠팔구수몇]+\s*(?:퍼센트|프로(?![가-힣]))/g;
/**
 * 한글로 적은 개수·기간·순서·소수 — 숫자로 적으면 이미 거절되는 것들('3일 연속'·'9종목'·'7건'·'2배'·'8.06%'):
 *  - 고유어 기간 '이틀·사흘·…·열흘' (+ 연속·째·동안·간·만에). '오늘 하루'처럼 흔한 '하루'는 뺀다
 *  - 고유어 수 '한·두·세·네·…·열' + 개수·기간 말('세 종목'·'두 건'·'열 배'·'두 번째'·'한 달'). '두 시장'·'이 종목'은 개수 말이 아니라 넘어간다
 *  - 십·백이 들어간 한자어 수 + 개수·기간 말('이십 종목')
 *  - '점'이 들어간 한자어 소수 + 단위('이점육육퍼센트'·'팔 점 영육 퍼센트'). 단위가 없으면('이점이 있습니다') 넘어간다
 *  - 서수 '첫째·둘째·셋째·첫 번째'와 개수 말 없이 쓴 고유어 수 '하나·둘·셋·…' + 조사·쉼표·빈칸·'뿐'('오른 종목은 둘, 내린 종목은 다섯입니다'·
 *    '셋뿐'·'하나뿐인'). '둘러'·'넷마블'·'열린'·'하나은행'·'하나도 없'처럼 개수가 아닌 말은 넘어간다
 *  - 기간 '일주일·석 달·넉 달·반년·삼 개월·며칠·몇 년', 어림수 '한두·한둘·두세·두셋·서너·네댓·대여섯', '두 자릿수'
 * 사실에 똑같은 말이 있을 때만 옮겨 쓴 것으로 본다 (종목 이름 등)
 */
const KO_COUNT = new RegExp(
  [
    "(?<![가-힣])(?:이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘|보름)(?:\\s*(?:연속|째|동안|간|만에|사이))?",
    "(?<![가-힣])(?:첫|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네)\\s*째|(?<![가-힣])첫\\s*번째",
    "(?<![가-힣])(?:열한|열두|열세|열네|다섯|여섯|일곱|여덟|아홉|스무|스물|서른|마흔|한|두|세|네|열)\\s*(?:종목|건|주(?![가식요도])|번째|번|차례|배|개(?![장인])|곳|가지|달러|달|해(?!외)|거래일|시간|째|연속|자릿수|자리\\s*수)",
    "(?<![가-힣])(?:일주일|이주일|석\\s*달|넉\\s*달|서너\\s*달|반\\s*년|반\\s*달|[일이삼사오육칠팔구]\\s*(?:개월|년(?!도)|거래일)|수\\s*(?:개월|년|주일)|며칠|몇\\s*(?:종목|건|주|일|달|개월|년|번|차례|배|거래일|해|시간))",
    "(?<![가-힣])(?:한둘|한두|두셋|두서너|두세|서너|서넛|너덧|네댓|대여섯|예닐곱|일고여덟|여남은)|(?<![가-힣])두어\\s*(?:종목|건|개|번|차례|달|해|주|일|배)",
    "(?<![가-힣])(?:열|스물|서른|마흔)?(?:하나(?!은행|도\\s*없)|셋|넷|다섯|여섯|일곱|여덟|아홉)(?=[은는이가을를과와도만의로으에씩쯤뿐입였,.)!?]|\\s|$)",
    "(?<![가-힣])(?:열|스물|서른|마흔)?둘(?=[은는이가을를과와도만의로에씩쯤뿐입였,.)!?\\n]|$)",
    "(?<![가-힣])(?:열|스물|서른|마흔)(?=[,.)!?\\n]|\\s*뿐|입니|이었|였|$)",
    "(?<![가-힣])(?:한|두|세|네)(?=\\s*,)",
    "(?<![가-힣])(?:[일이삼사오육칠팔구]?[십백]\\s*)+[일이삼사오육칠팔구]?\\s*(?:종목|건|주|일|배|번째|번|회|개월|개|곳|가지|거래일|위|년)",
    "(?<![가-힣])[일이삼사오육칠팔구십백천만영공]+\\s*점\\s*[일이삼사오육칠팔구영공]+\\s*(?:퍼센트|프로|원(?!화|\\/|달러)|포인트|달러|배|%)",
  ].join("|"),
  "gu",
);

/** 줄 머리의 목록 번호('  1. 리게티 컴퓨팅', '- 1. RGTX')인지 — 사실의 기여 순위. 글의 'N위'는 이것과 맞춰 본다 */
function isListNumber(rest: string, at: number, len: number): boolean {
  const lineStart = rest.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*(?:[-*][ \t]*)?$/.test(rest.slice(lineStart, at)) && /^\.(?:\s|$)/.test(rest.slice(at + len));
}

/**
 * 글 속 숫자들. malformed: 틀린 표기 (틀린 숫자로 본다) — 쉼표 자리가 틀림('30,0890'), 빈칸으로 끊어 적음('250 267원'),
 * 0으로 시작하는 덩어리('1, 000원'·'8. 06%'의 '000'·'06'), 0~9 가 아닌 숫자('٢٥٠' — 숫자로 읽지 못해 사실과 맞춰 볼 수 없다)
 */
export function numberTokens(text: string): { tokens: NumberToken[]; malformed: string[] } {
  const tokens: NumberToken[] = [];
  const malformed: string[] = [];
  const norm = normalizeNumbers(text);
  let rest = norm;
  // 0) NFKC 뒤에도 남은 0~9 밖의 숫자(아라비아-인도 숫자 등)
  for (const m of rest.matchAll(/(?:(?![0-9])\p{Nd})+/gu)) malformed.push(m[0]);
  // 1) 날짜·시각을 먼저 읽고 지운다 — 그 안의 숫자(20:00 의 20, 9/25 의 25)를 따로 세지 않게
  for (const d of DATE_TIME) {
    rest = rest.replace(d.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      tokens.push({ raw: m[0], kind: d.kind, key: d.key(m), value: Number.NaN, unit: "", sign: null, decimal: false, dir: 0, dirWord: "", arrowAfter: false });
      return " ".repeat(m[0].length);
    });
  }
  // 2) 나머지 숫자: 앞의 부호 표시 + 숫자(쉼표·소수) + 단위(또는 모르는 접미어) + 뒤(없으면 바로 앞 어절)에 말로 적은 방향
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const at = m.index!;
    const body = m[0].replace(/,+$/, "");
    const { sign, start, shown: signShown } = signBefore(rest, at, norm);
    const afterNum = rest.slice(at + body.length);
    const u = UNIT_RE.exec(afterNum);
    let unit = normUnit(u?.[1]);
    let tail = u ? u[0] : "";
    if (unit === "일" && DAYS_SPAN.test(afterNum.slice(tail.length))) unit = "기간";
    if (!u) {
      // 단위가 아닌 글자가 붙은 숫자: 조사면 단위 없는 숫자, 아니면('4거래일'·'2배'·'4 거래일') 모르는 단위 — 사실의 단위 없는 같은 값과만 맞춘다
      const w = /^(\s?)([가-힣A-Za-z]+)/.exec(afterNum);
      if (w && !(w[1] === "" && JOSA_RE.test(w[2]!))) {
        unit = "?";
        tail = w[0];
      }
    }
    const shown = `${signShown}${body}${tail}`.trim();
    // 방향: 숫자 뒤의 말이 먼저, 없으면 바로 앞 어절 ('손실 39,240원'·'손실 +39,240원' — 부호를 적었어도 말이 반대면 거절)
    const after = directionAfter(afterNum.slice(tail.length));
    const arrowAfter = after.arrow;
    let { dir, word: dirWord } = after;
    if (!dir) ({ dir, word: dirWord } = directionBefore(rest.slice(0, start)));
    if (!sign && !u && !tail && isListNumber(rest, at, m[0].length)) unit = "rank";
    const [intPart = "", frac] = body.split(".");
    const groups = intPart.split(",");
    if (groups.length > 1 && (groups[0]!.length > 3 || groups.slice(1).some((g) => g.length > 3))) {
      malformed.push(shown);
      continue;
    }
    // 0으로 시작하는 덩어리('000원'·'06%'·'8,06%'의 06): 끊어 적은 숫자의 뒷부분
    const listed = groups.length > 1 && groups.slice(1).some((g) => g.length < 3);
    if (/^0\d/.test(groups[0]!) || (listed && groups.slice(1).some((g) => /^0\d/.test(g)))) {
      malformed.push(shown);
      continue;
    }
    // 빈칸 하나로 끊어 적은 세 자리('250 267원'·'9 157 673원'): 앞 숫자와 함께 보인다
    const split = /(\d[\d,.]*)[ \t]$/.exec(rest.slice(Math.max(0, at - 24), at));
    if (split && groups.length === 1 && intPart.length === 3) {
      malformed.push(`${split[1]} ${body}${tail}`.trim());
      continue;
    }
    if (listed) {
      // '1,2위' 처럼 쉼표로 늘어놓은 숫자: 따로 읽는다 (부호는 첫 수, 단위·방향은 마지막 수에)
      groups.forEach((g, i) => {
        const last = i === groups.length - 1;
        const raw = last && frac !== undefined ? `${g}.${frac}` : g;
        tokens.push({
          raw: `${i === 0 ? signShown : ""}${raw}${last ? tail.trim() : ""}`,
          kind: "num",
          key: "",
          value: Number(raw),
          unit: last ? unit : "",
          sign: i === 0 ? sign : null,
          decimal: last && frac !== undefined,
          dir: last ? dir : 0,
          dirWord: last ? dirWord : "",
          arrowAfter: last && arrowAfter,
        });
      });
      continue;
    }
    tokens.push({ raw: shown, kind: "num", key: "", value: Number(body.replace(/,/g, "")), unit, sign, decimal: frac !== undefined, dir, dirWord, arrowAfter });
  }
  return { tokens, malformed };
}

/**
 * 글의 단위 tu 가 사실의 단위 fu 를 옮겨 쓴 것인지.
 *  - 같은 단위 (개수는 같은 낱말끼리: '9종목'은 사실의 'N종목'과만, '6건'은 'N건'과만)
 *  - 단위를 빼고 옮긴 것(''), 지수 값 뒤에 붙인 '포인트'
 *  - 순위 'N위': 사실의 기여 순위 줄 번호('1. 리게티 컴퓨팅')
 *  - 모르는 접미어('4거래일'·'2배'): 사실의 단위 없는 같은 값만 (지수 값 등)
 * '번째'·'기간'(3일 연속)은 사실에 없으므로 늘 거절된다
 */
function unitMatches(tu: string, fu: string): boolean {
  if (tu === fu) return true;
  if (tu === "") return true;
  if ((tu === "pt" || tu === "?") && fu === "") return true;
  return tu === "위" && fu === "rank";
}

/** 글의 숫자 t 가 사실의 숫자 f 를 옮겨 쓴 것인지: 값이 같고, 단위가 맞고, 부호를 적었으면 부호도 같다 */
function sameNumber(t: NumberToken, f: NumberToken): boolean {
  if (t.kind !== f.kind) return false;
  if (t.kind !== "num") return t.key === f.key;
  if (t.value !== f.value) return false;
  if (!unitMatches(t.unit, f.unit)) return false;
  return t.sign === null || t.sign === f.sign;
}

/** 말로 적은 방향(올랐·손실…)이 사실의 부호와 맞는지. 방향을 적지 않았거나 사실에 부호가 없으면(지수 값·0) 맞는 것으로 */
function sameDirection(t: NumberToken, f: NumberToken): boolean {
  if (!t.dir || f.sign === null) return true;
  return (t.dir > 0) === (f.sign === "+");
}

/** '24일'·'9월'처럼 날짜의 일·월만 쓴 것은 사실의 날짜(공시일·장 날짜)에 그 일·월이 있으면 옮겨 쓴 것으로 본다 ('3일 연속'·'25일 만에'는 기간이라 해당 없음) */
function partOfKnownDate(t: NumberToken, known: readonly NumberToken[]): boolean {
  if (t.kind !== "num" || t.sign !== null || t.decimal) return false;
  const dates = known.filter((f) => f.kind === "date").map((f) => f.key.split("/").map(Number));
  if (t.unit === "일") return dates.some(([, d]) => d === t.value);
  if (t.unit === "월") return dates.some(([m]) => m === t.value);
  return false;
}

/** 받침이 f 인 한글 글자 전부: 가(U+AC00) + 28·k + f (f: 8 = ㄹ, 17 = ㅂ, 20 = ㅆ) */
function withFinal(f: number): string {
  return Array.from({ length: 19 * 21 }, (_, k) => String.fromCharCode(0xac00 + k * 28 + f)).join("");
}
/** 받침이 ㄹ 인 글자 ('할·될·오를·흔들릴·달라질') */
export const RIEUL_FINAL = withFinal(8);
/** 받침이 ㅂ 인 글자 ('합시다·늘립시다'의 '합·립') */
const BIEUP_FINAL = withFinal(17);
/** 받침이 ㅆ 인 글자 ('었·았·였·했·됐·났·컸·있…' — 과거형과 '있다'). '겠'(추측)은 뺀다 */
const SSANG_FINAL = withFinal(20).replace("겠", "");

/**
 * 설명에 나오면 안 되는 말 (나오면 기본 문장으로). 떨어뜨리는 비용은 기본 설명으로 바뀌는 것뿐이라 보수적으로 넓게 잡는다:
 *  - 매매 지시·권유: 매수·매도·매입·매각·추천…, 사고팔기('팔고'·'팔아'·'사는 것'·'팔 시점'·'사들'), 명령·권고형 어미(세요·십시오·시길·바랍니다)
 *  - 행동 제안: 비중·손절·권장·바람직·처분·정리하·정리할·차익·물타기·매집·담아/담으·진입·관망·'유지하는'·리밸런싱·현금·검토·'볼 만'·기회·타이밍·시점…
 *  - 의무·권고·제안: '~해야 합니다'·제안·조언·권고·권해·'~것도 방법입니다'·'~ㄹ 만합니다'·'~ㅂ시다'·'~해도 됩니다'·어떨까·까요·지켜보
 *  - 평가·권고형 끝맺음: 낫·좋습니다(좋을·좋아·좋겠)·필요·안전·위험·주의·조심·신중·유리·불리·괜찮·중요·유의·유효·적합·적기·합리·현명·우호·매력·
 *    저평가·고평가·과열·바닥·저점·고점·임박·긍정적·부정적·낙관·비관·갈아타·전략·일시적·지지선·저항선·공산,
 *    받침 ㄹ + 가치·여지·이유·차례·'때입니다'('보유할 가치'·'오를 차례')
 *  - 전망/예측/추측: 전망·예상·가능성·반등·회복할·계속·지속·이어질·우려·걱정·곧·'오를 듯'·'내려갈 것'·겠·듯·'것 같'·'것으로 보'·보입니다·'수 있'·
 *    앞으로·향후·당분간·다음 주·내년·연말·여력·'내일도'·여지·확률·모릅니다·리라·머지않·조만간·되돌림·오래가,
 *    받침 ㄹ + '것입니다/겁니다/거라'(흔들릴 것입니다·달라질 겁니다·커질 거라)와 끝에 온 '~ㄹ 것'('늘릴 것.')
 *    ('내일 새벽 05:00'처럼 장 시간을 말하는 '내일'은 뺀다)
 * '예상액'(기준 문장의 수수료·세금 예상액)·'매입금액'·'매입가'는 사실을 설명하는 말이라 뺀다.
 * 낱말 목록은 끝이 없으므로 문장 끝맺음도 따로 본다 (badEnding)
 */
const FORBIDDEN = new RegExp(
  [
    // 매매 지시·권유·행동 제안
    "매수|매도|매입(?!금액|가|단가|원가)|매각|추천|권유|권합|권장|목표가|목표 ?주가",
    "사야|팔아|팔고|팔기|팔자|팔 (?:때|시점)|살 (?:때|시점)|사는 (?:것|게|편)|파는 (?:것|게|편)|사 두|사두|사들",
    "손절|익절|비중|처분|정리하(?!면|자면)|정리할|정리해야|차익|물타기|매집|담아|담으|담을|담는|진입|관망|유지하(?:는|시|세|길|기)|유지할",
    "리밸런싱|현금|검토|볼 ?만|할 ?만|고려해|고려할|기회|타이밍|시점|유망|주목할",
    // 의무·권고·제안 ('분야·시야 하락'의 '야 하'는 뺀다)
    "(?<!분|시)야만? ?(?:합|하|할|한|해)|제안|조언|권고|권해|권하|방법(?:입니다|이다|일|이에요|도)|[어아여워와해]도 ?(?:됩|되|돼|괜찮)|어떨|까요|습니까|지켜(?:보|봐|볼|봅|본)",
    `[${BIEUP_FINAL}]시다|시오(?![가-힣])`,
    // 명령·권고·평가형 끝맺음
    "세요|십시오|시길|바랍니다|바람직|낫|좋(?=습|을|아|겠|다)|필요|안전|위험|주의|조심|신중|유리|불리|괜찮|나쁘지",
    "중요|유의|유효|적합|(?<!누)적기|합리|현명|우호|매력|저평가|고평가|과열|바닥|저점|고점|임박|긍정적|부정적|낙관|비관|갈아타|전략|일시적|지지선|저항선|공산",
    `[${RIEUL_FINAL}] ?(?:만(?:하|합|한|해|할)|가치|여지|이유|차례|때(?:입|이|다|예|야|인|가|라))`,
    // 전망·예측·추측
    "전망|예측|예상(?!액)|가능성|기대|반등|반락|회복(?=할|될|하겠|세)|계속|지속|이어질|이어갈|우려|걱정|곧",
    "(?:오를|내릴|올라갈|내려갈)(?= ?(?:것|거|겁|수|듯|지|까))|떨어질|상승할|하락할",
    "겠|듯|것 같|것으로 보|보입니다|보인다|수 있습니다|수 있어|수 있을|수도 있|여력|앞으로|향후|당분간|내년|연말",
    "여지|확률|모릅|모른|모를|리라|머지 ?않|머잖|조만간|되돌림|오래 ?(?:가|갈|간)",
    "다음 ?(?:주|달)(?=[에는도부터까지중초말]|\\s|$|[.,])",
    "내일(?! ?(?:새벽|오전|아침|\\d))",
    `[${RIEUL_FINAL}] ?(?:것(?:입니다|이다|이에요|으로|이라|이란|임)|겁니다|거예요|거다|거야|거라|거란|거로|걸로)`,
    `[${RIEUL_FINAL}] ?것(?=$|[\\s.!?,)])`,
  ].join("|"),
  "g",
);

/**
 * 사실 목록에 없는 이유를 지어낸 말 ('수주 소식에 올랐습니다'·'업황 부진 여파로'·'실적 발표 효과로'). 프롬프트가 막지만 검사로도 막는다.
 * 사실에 있는 공시 제목 속 말('영업실적등에대한전망')을 옮긴 것은 넘어간다 (forbiddenIn)
 */
const INVENTED_REASON = /소식|뉴스|수주|실적|발표|업황|호조|수급|외국인|기관|금리|여파|이슈|호재|악재|심리|매물|연준|관세|물가|규제/g;

/** 문장이 끝맺는 말(…다·…요·…까·…죠)로 끝나는지. 명사·명사형('없음'·'브리핑'·'-4,669원')으로 끝나는 줄은 문장으로 보지 않는다 */
const FINITE_END = /[다요까죠]$/;
/**
 * 받는 끝맺음 (그 밖은 거절 — 현재형 '오릅니다·회복합니다·줄입니다'는 앞일이나 권유로도 읽힌다):
 *  - 일어난 일을 적는 과거형: 었·았·였·했·됐·났… + 습니다/다/어요 (받침 ㅆ, '있습니다' 포함)
 *  - '없습니다', 명사 + '입니다·이다·이에요·예요'·'아닙니다' ('줄입니다·높입니다'처럼 움직씨 + 이다는 뺀다), '같습니다·다릅니다'
 *  - 합계 설명: '넣지·포함하지·더하지 않습니다'
 *  - 일정 문장: '열립니다·엽니다·마감합니다·마감됩니다·개장합니다·휴장합니다·운영됩니다'
 *  - 숫자를 만든 방식: '따로 봅니다·나눠 봅니다·따로 계산됩니다·표시합니다·구분합니다·뜻합니다' ('~다고·~라·~으로·~게 봅니다'는 의견이라 뺀다)
 */
const ALLOWED_END = new RegExp(
  "(?:" +
    [
      `[${SSANG_FINAL}](?:습니다|다|어요)`,
      "없(?:습니다|다|어요)",
      "(?<!줄|높|낮|쌓|섞|먹|붙|꺾|기울)(?:입니다|이다|이에요)",
      "예요|아닙니다|아니다|아니에요|같습니다|같다|다릅니다|다르다",
      "(?:넣|포함하|포함되|더하|반영하|반영되|들어가)지 않(?:습니다|는다)",
      "(?:열립|엽|마감합|마감됩|개장합|휴장합|운영됩)니다",
      "(?:계산|표시|구분)(?:합|됩)니다|뜻합니다",
      "(?<!(?:고|다|라|으로|게|듯이?)\\s?)봅니다",
    ].join("|") +
    ")$",
);
/** 문장 조각을 나누는 곳: 마침표(소수점은 빼고)·느낌표·물음표·줄바꿈·괄호 */
const SENTENCE_BREAK = /[!?。\n()]|(?<!\d)\.|\.(?!\d)/g;

/**
 * 문장 끝맺음 검사. 조각마다 마지막 한글 어절을 보고, 물음표로 끝나거나 끝맺는 말이 받는 끝맺음(ALLOWED_END)이 아니면 그 말을 돌려준다.
 * 사실에 그대로 있는 조각은 넘어간다
 */
function badEnding(text: string, facts: string): string | null {
  let from = 0;
  for (const e of [...text.matchAll(SENTENCE_BREAK), null]) {
    const at = e ? e.index! : text.length;
    const seg = text.slice(from, at).trim();
    from = e ? at + e[0].length : at;
    const copied = seg.length >= 4 && facts.includes(seg);
    if (e?.[0] === "?" && !copied) return "물음표"; // '…했습니다!?'처럼 빈 조각 뒤의 물음표도
    if (!seg || copied) continue;
    const tail = /([가-힣]+)[\s*_`~"'“”‘’«»「」『』〈〉《》:;,·…\-–—]*$/.exec(seg);
    if (!tail || !FINITE_END.test(tail[1]!)) continue;
    if (!ALLOWED_END.test(seg.slice(0, tail.index + tail[1]!.length))) return `문장 끝 '${tail[1]}'`;
  }
  return null;
}

/**
 * 설명에 쓰지 않는 표기: HTML 엔티티('&plus;'·'&minus;'·'&#8722;' — 앱 마크다운이 +·− 로 풀어 그려 부호 검사를 비켜 간다)와 태그('<b>').
 * 'S&P500' 처럼 ';' 로 끝나지 않는 것은 엔티티가 아니다
 */
const MARKUP = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);|<\/?[a-z][^<>]*>/i;
/** 글자 방향 제어 문자: 보이는 순서를 바꿔 부호 자리를 속일 수 있다 */
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * 금지어가 사실 목록에 그대로 있는 더 긴 말(공시 제목 '주식매수선택권부여에관한신고'·'공개매수신고서'·종목 이름)의 일부면 넘어간다.
 * 금지어 앞뒤로 빈칸 없이 붙은 글자를 한 자씩 늘려 가며 사실에 있는지 보고, 2자 이상 늘어나면 옮겨 쓴 것으로 본다
 */
export function forbiddenIn(text: string, facts: string, re: RegExp = FORBIDDEN): string | null {
  for (const m of text.matchAll(re)) {
    let s = m.index!;
    let e = s + m[0].length;
    while (s > 0 && !/\s/.test(text[s - 1]!) && facts.includes(text.slice(s - 1, e))) s--;
    while (e < text.length && !/\s/.test(text[e]!) && facts.includes(text.slice(s, e + 1))) e++;
    if (e - s >= m[0].length + 2) continue;
    return m[0];
  }
  return null;
}

/**
 * 모델 설명을 그대로 써도 되는지. 아래면 이유와 함께 false (서비스는 기본 문장을 쓴다):
 *  - 빈 응답·너무 김
 *  - 틀린 표기의 숫자: 쉼표 자리('-30,0890원'), 빈칸으로 끊어 적음('250 267원'), 0으로 시작하는 조각('1, 000원')
 *  - 사실에 없는 숫자: 값·단위·부호(적었으면)가 모두 맞는 숫자가 사실에 없음. 개수(9종목·6건·10주)도 사실의 같은 낱말 개수와 맞춰 보고,
 *    순위(N위)는 사실의 기여 순위 번호와, 모르는 접미어(4거래일·2배)는 사실의 단위 없는 같은 값과만 맞춘다. '번째'·'3일 연속' 같은 기간은 늘 거절.
 *    날짜·시각은 사실의 날짜·시각과만 맞춰 본다. 부호는 꾸밈에 싸여 있어도 읽는다(**+250,267원**·`-39,240원`·→+8.06%·전각 ＋·'플러스'·▲▼),
 *    뜻이 갈리는 △·± 와 모르는 부호 모양(▴·➕·📈·˗…)은 어느 사실과도 맞추지 않는다. 한글로 적은 금액·비율('이십오만 원'·'팔 퍼센트'·'이점육육퍼센트')과
 *    개수·기간·서수('세 종목'·'두 건'·'이틀 연속'·'열 배'·'둘, 다섯입니다'·'셋뿐'·'둘째'·'일주일 만에'·'두세 종목'), 0~9 가 아닌 숫자('٢٥٠')도
 *    맞춰 볼 수 없어 거절. '25일 만에'처럼 기간으로 쓴 'N일'은 날짜의 일로 보지 않고, '퍼센트포인트'는 %p 로 읽는다
 *  - HTML 엔티티·태그('&plus;250,267원'·'<b>+</b>' — 앱 마크다운이 부호로 풀어 그린다), 글자 방향 제어 문자
 *  - 말로 뒤집은 방향: 숫자 바로 뒤의 '올랐·상승·이익·강세·흑자…'·붙은 화살표(↑↓), 없으면 바로 앞 어절의 '손실·이익·상승률…'이 사실의 부호와 반대
 *    ('8.06% 올랐'·'8.06%↑'·'손실 39,240원'·'손실 +39,240원'·'+39,240원 손해' ← 실제 -8.06%·+39,240원)
 *  - 부호가 빠진 숫자: 부호가 붙은 사실(0이 아닌 손익·등락률)과만 맞는 숫자를 부호 없이 옮김 ('8.06% 강세'·'39,240원 보탬'·안쪽 글머리표 '- - 39,240원').
 *    방향을 말로 적는 방법은 끝이 없어 낱말 목록으로 다 잡을 수 없으므로, 부호(또는 숫자에 붙은 ↑↓)를 적은 것만 받는다
 *  - 매매 지시·의무·행동 제안·평가·전망·추측 표현, 사실에 없는 이유(뉴스·수주·실적·업황·수급…) (사실에 있는 공시 제목 속 말은 제외)
 *  - 과거형 설명이 아닌 끝맺음('오릅니다'·'줄입니다'·'늘린다')과 물음표 — 낱말 목록은 끝이 없으므로 끝맺음으로도 막는다 (badEnding)
 */
export function checkNarrative(text: string, facts: string): { ok: true } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: "빈 응답" };
  if (text.length > 3000) return { ok: false, reason: "설명이 너무 김" };
  const markup = MARKUP.exec(text);
  if (markup && !facts.includes(markup[0])) return { ok: false, reason: `쓰지 않는 표기: ${markup[0]}` };
  if (BIDI_CONTROL.test(text)) return { ok: false, reason: "쓰지 않는 표기: 글자 방향 제어 문자" };
  const got = numberTokens(text);
  const fact = numberTokens(facts);
  // 사실에도 똑같이 있는 틀린 표기(공시 제목 속 숫자 등)를 옮겨 쓴 것은 넘어간다
  const malformed = [...new Set(got.malformed)].filter((m) => !fact.malformed.includes(m));
  if (malformed.length) return { ok: false, reason: `숫자 표기가 틀림: ${malformed.slice(0, 3).join(", ")}` };
  const known = fact.tokens;
  const unknown = new Set<string>();
  const flipped = new Set<string>();
  const unsigned = new Set<string>();
  for (const t of got.tokens) {
    if (partOfKnownDate(t, known)) continue;
    const same = known.filter((f) => sameNumber(t, f));
    if (!same.length) unknown.add(t.raw);
    else if (!same.some((f) => sameDirection(t, f))) flipped.add(`${t.raw} ${t.dirWord}`);
    else if (t.kind === "num" && t.sign === null && !t.arrowAfter && same.every((f) => f.sign === "+" || f.sign === "-")) unsigned.add(t.raw);
  }
  // 한글로 적은 수는 글과 사실을 같은 모양으로 맞춘 뒤 본다 (폭 없는 글자로 끊어 적은 것까지)
  const plain = normalizeNumbers(text);
  const plainFacts = normalizeNumbers(facts);
  // 개수·기간은 뒤 한 글자까지 사실에 있어야 옮긴 것으로 본다 ('둘,'·'한,' 같은 짧은 말이 '한국'·다른 낱말 속 글자로 통과하지 않게)
  for (const m of plain.matchAll(KO_NUMERAL)) if (!plainFacts.includes(m[0])) unknown.add(m[0].trim());
  for (const m of plain.matchAll(KO_COUNT)) if (!plainFacts.includes(plain.slice(m.index!, m.index! + m[0].length + 1))) unknown.add(m[0].trim());
  if (unknown.size) return { ok: false, reason: `입력에 없는 숫자: ${[...unknown].slice(0, 5).join(", ")}` };
  if (flipped.size) return { ok: false, reason: `방향이 사실과 반대: ${[...flipped].slice(0, 3).join(", ")}` };
  if (unsigned.size) return { ok: false, reason: `부호가 빠진 숫자: ${[...unsigned].slice(0, 3).join(", ")}` };
  const bad = forbiddenIn(plain, plainFacts) ?? forbiddenIn(plain, plainFacts, INVENTED_REASON) ?? badEnding(plain, plainFacts);
  if (bad) return { ok: false, reason: `쓰지 않는 표현: ${bad}` };
  return { ok: true };
}

/** 모델 응답 정리: 코드 울타리를 벗기고 앞뒤 공백 제거 */
export function cleanNarrative(text: string): string {
  return text.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

export function sessionKo(s: AccountSession): string {
  return SESSION_KO[s];
}
