/** 백엔드 응답 타입 (backend/src/domain, services 와 맞춘다) */

export type Market = "KOSPI" | "KOSDAQ" | "NASDAQ" | "NYSE" | "AMEX" | "US" | "UNKNOWN";
export type Currency = "KRW" | "USD";
/** 차트 값 단위: 통화, 또는 지수·환율처럼 소수 둘째 자리 숫자(PT) */
export type ChartUnit = Currency | "PT";

/** 정규장 밖(넥스트레이드 NXT) 가격. 토스·네이버가 장 마감 후 보여주는 값 */
export interface AfterMarketQuote {
  venue: "NXT" | "US"; // NXT=넥스트레이드(한국), US=미국 프리/애프터마켓
  session: "PRE_MARKET" | "AFTER_MARKET" | "UNKNOWN";
  status: "OPEN" | "CLOSE";
  price: number;
  change: number;
  changeRate: number;
  volume: number | null;
  asOf: string;
}

/**
 * 종목의 지금 거래 세션 (서버 services/liveSession 과 같은 모양).
 * phase — 한국: nxt_pre · auction(동시호가) · regular · nxt_after(15:40~16:00) · after(한국거래소+NXT 애프터마켓 16:00~20:00),
 * 미국: overnight(주간거래) · pre · regular · after, 공통: closed · holiday
 */
export interface QuoteSession {
  market: "KR" | "US";
  phase: string;
  /** "미국 주간거래" · "한국 애프터마켓" · "한국 휴장" … */
  label: string;
  /** 그 시장이 지금 연속 거래 중 (동시호가·장 마감·휴장이면 false) */
  open: boolean;
  /** 이 종목이 지금 세션의 거래 대상인지 (NXT·주간거래·애프터마켓 대상, 거래정지 아님). 모르면 null (이 세션에 체결이 있어야 점) */
  eligible: boolean | null;
  halted?: boolean;
  /** 다음 세션 경계 (ISO) */
  until: string | null;
}

export interface ListedStock {
  code: string;
  name: string;
  market: Market;
  isinCode: string | null;
  groupCode: string | null;
  price?: number | null; // 토스 검색이 주는 현재가
  changeRate?: number | null;
  currency?: Currency;
}

export interface Quote {
  code: string;
  currency?: Currency; // 구버전 서버 응답에는 없음 → KRW 로 간주
  price: number;
  change: number;
  changeRate: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  marketCap: number | null;
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  high52w: number | null;
  low52w: number | null;
  asOf: string;
  source: string;
  afterMarket?: AfterMarketQuote | null;
  priceBasis?: string; // "KRX+NXT 통합" | "KRX 정규장" | "정규장"
  priceKrw?: number | null; // 미국 종목 원화 환산
  /** 실시간 체결로 스냅샷과 다른 가격을 덮어쓴 현재가 (예전 서버의 초록 점 기준 — 새 서버면 realtime·session 을 쓴다, lib/liveDot) */
  live?: boolean;
  /** 이 종목의 지금 거래 세션 (새 서버 잔고·상세만). 잔고 상태 줄 "미국 주간거래 · 한국 휴장" 과 점이 없는 까닭 */
  session?: QuoteSession | null;
  /** 초록 점: 지금 열린 세션에서 이 종목 가격이 실시간으로 갱신되고 있다 (새 서버만. 없으면 예전 서버 → live) */
  realtime?: boolean;
  /** 서버가 시세를 새로 받지 못해 마지막 값을 그대로 준 경우 (asOf 는 원래 시각). 회색 "시세 지연"으로 표시 */
  stale?: boolean;
  fxRate?: number | null; // 미국 종목: 1달러당 원화
  dividendPerShare?: number | null;
  dividendYieldPct?: number | null;
  industry?: string | null;
  /**
   * 사람이 읽는 종목 이름 (새 서버만, 보강 소스가 줄 때만 — 미국 종목은 한글 이름이 있으면 한글, ETF 등은 영문).
   * 등록 이름이 티커뿐인 종목(RGTX 등)의 상세 부제목 끝에 쓴다 (lib/detailText detailNames — 제목은 티커 그대로)
   */
  fullName?: string | null;
}

/** 토스증권 공식 Open API 연동 상태 (/health, /api/admin/toss/status) */
export interface TossOpenApiStatus {
  configured: boolean;
  outboundIp: string | null; // 토스 허용 IP 에 등록할 서버 공인 IP
  client: { configured: boolean; tokenIssuedAt: string | null; lastOkAt: string | null; lastError: string | null; ipBlocked: boolean } | null;
  realtime: { enabled: boolean; connected: boolean; subscribed: string[]; lastMessageAt: string | null; lastError: string | null } | null;
  /** 보유 종목 자동 동기화 (장중 intervalMin 분마다, 장 밖 idleIntervalMin 분마다, 브리핑 직전) */
  sync?: {
    enabled: boolean;
    intervalMin: number;
    idleIntervalMin: number;
    running: boolean;
    lastRunAt: string | null;
    lastTrigger: "startup" | "schedule" | "briefing" | "manual" | null;
    lastError: string | null;
    lastChanges: { added: number; updated: number; removed: number; holdings: number } | null;
    nextRunAt: string | null;
  } | null;
  /** 토스 계좌 자동 대조 (앱 총평가 vs 토스 비용 차감 평가). 구버전 서버에는 없음 */
  reconcile?: {
    last: { at: string; diffKrw: number; diffPct: number; missing: number; qtyMismatch?: string[] } | null;
    streakOver: number;
    qtyStreak?: number;
    week: { n: number; withinPct: number | null };
    alert: boolean;
  } | null;
}

export interface TossImportResult {
  accounts: number;
  added: string[];
  updated: string[];
  unchanged: string[];
  /** 전량 매도로 관심 종목으로 바뀐 종목 (구버전 서버에는 없음) */
  removed?: string[];
  holdings: { code: string; name: string; currency: Currency; quantity: number; avgPrice: number | null; lastPrice: number | null; market: string }[];
}

export interface RegisteredStock {
  code: string;
  name: string;
  market: Market;
  quantity: number | null;
  avgPrice: number | null;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
  /** 토스 계좌에서 맞추는 종목 (수량·평단 잠김, 삭제하면 동기화에서 빠짐) */
  tossSynced?: boolean;
  /**
   * 지우면 토스 동기화에서도 빠지는 종목 (마지막 토스 스냅샷에 있음 — 서버 삭제와 같은 기준). 동기화가 오래 멈췄거나 자동 동기화가 꺼져
   * 잠금(tossSynced)이 풀린 때도 참. 예전 서버에는 없다 → tossSynced 로 대신 (3-24 지우기 문구)
   */
  inTossSnapshot?: boolean;
}

export interface Evaluation {
  marketValue: number;
  costBasis: number;
  profit: number;
  profitRate: number;
  /** 토스 기준 매도 예상 수수료·세금 비율 (토스 동기화 종목만, 구버전 서버에는 없음) */
  costRate?: number | null;
  /** 수수료·세금 차감 후 평가 (토스 앱 화면 기준) */
  afterCost?: { marketValue: number; profit: number; profitRate: number } | null;
  /** 해외 종목 원화 매입금액 (매수 당시 환율 = 토스 원화 손익 기준). exact = 토스 값, estimated = 체결 환율 추정 */
  costBasisKrw?: number | null;
  krwCostSource?: "exact" | "estimated" | null;
}

export interface RegisteredWithQuote extends RegisteredStock {
  quote: Quote | null;
  quoteError: string | null;
  evaluation: Evaluation | null;
}

/** 1m/5m/30m 분봉(토스 소스), D/W/M 일·주·월봉 */
export type CandlePeriod = "1m" | "5m" | "30m" | "D" | "W" | "M";

export interface Candle {
  date: string;
  /** 분봉만: 봉 시각 ISO(현지 오프셋 포함). 서버 출처마다 뜻이 다르다 — 토스 웹 차트(30분봉은 늘 여기)는 봉이 끝나는 시각, 토스 OpenAPI 1분·5분봉은 시작 시각 (backend domain/types.ts Candle.time) */
  time?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 앱만: 실시간 체결로 앱이 만든 임시 봉이라 거래량을 아직 모른다 (volume 0 은 확정값이 아님). 서버 봉을 다시 받으면 없어진다 */
  volumeUnknown?: boolean;
}

export interface CandleSeries {
  code: string;
  period: CandlePeriod;
  candles: Candle[];
  source: string;
}

export type BriefingSession = "morning" | "afternoon";

export interface Briefing {
  id: number;
  code: string;
  name: string | null;
  session: BriefingSession;
  date: string;
  status: "ok" | "failed";
  summary: string;
  detail: string;
  missing: string[];
  model: string;
  error: string | null;
  createdAt: string;
}

export interface BriefingWithData extends Briefing {
  data: {
    quote: Quote | null;
    technical: Record<string, unknown> | null;
    news: NewsItem[] | null;
    disclosures: Disclosure[] | null;
    holding: { profit: number; profitRate: number; marketValue: number } | null;
    missing: string[];
  } | null;
}

/** 계좌 한 장 브리핑 (3-31). 서버 backend/src/services/accountNumbers.ts 의 AccountData 와 같은 모양 */
export interface AccountRow {
  code: string;
  name: string;
  currency: Currency;
  /** 당일 손익 기여(원, 정수). 줄 + 그 외 = 당일 손익 */
  amount: number;
  changeRate: number | null;
  /** 원화 평가금액 */
  value: number;
}

export interface AccountMarketBucket {
  count: number;
  value: number;
  day: number;
  dayRate: number | null;
}

export interface AccountFx {
  /** computed = 나눠 계산함, none = 미국 종목 없음, unavailable = 원/달러 변동을 받지 못함 */
  status: "computed" | "none" | "unavailable";
  reason: string | null;
  usdKrw: { value: number; change: number; changeRate: number; stale: boolean } | null;
  appliedRate: number | null;
  usdHoldingsKrwChange: number | null;
  /** 가격 효과 = 당일 손익의 미국 몫 */
  priceEffect: number | null;
  /** 환율 효과 (당일 손익에 들어가지 않음) */
  fxEffect: number | null;
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

export interface AccountSchedule {
  kr: { date: string; tradingDay: boolean; now: string; hours: string | null; nextOpen: string | null };
  us: { date: string; tradingDay: boolean; now: string; hours: string | null };
  disclosures: { code: string; name: string; title: string; filedAt: string; url: string | null }[];
}

export interface AccountData {
  version: number;
  session: BriefingSession;
  date: string;
  asOf: string;
  basis: string;
  afterCost: boolean;
  holdings: number;
  stale: number;
  totalValue: number;
  totalCost: number;
  totalProfit: number;
  totalProfitRate: number | null;
  dayPnl: number;
  dayRate: number | null;
  contributions: AccountRow[];
  others: { count: number; amount: number } | null;
  markets: { kr: AccountMarketBucket | null; us: AccountMarketBucket | null };
  excluded: { code: string; name: string; reason: string }[];
  fx: AccountFx;
  indices: AccountIndexRow[];
  missingIndices: string[];
  schedule: AccountSchedule;
  narrative: { source: "llm" | "template"; reason: string | null };
  /** 오늘 한국 휴장이라 국내 종목의 등락·당일 손익이 직전 거래일 것 (예전 기록에는 없음) */
  krPreviousDay?: boolean;
  /** 지난밤 미국 평일 휴장이라 미국 종목의 등락·당일 손익이 직전 거래일 것 (앞 브리핑에 담긴 움직임. 예전 기록·서버에는 없음) */
  usPreviousDay?: boolean;
  /** 쉰 미국 정규장의 뉴욕 날짜 (usPreviousDay 일 때만). 브리핑 날짜의 전날이 아니면(금요일 휴장 다음 월요일) '12/25(금) 미국 휴장'. 예전 서버에는 없음 → '지난밤' */
  usHolidayDate?: string;
  /** 브리핑 3차 3 (플래그 accountSinceLast): 보유 종목별 수량·원화 평가. 꺼짐·예전 기록에는 없음 */
  positions?: AccountPosition[];
  /** 브리핑 3차 3 (플래그 accountSinceLast): 지난 같은 세션 브리핑과 비교. 켜졌는데 비교할 브리핑이 없으면 null, 꺼짐·예전 기록에는 칸이 없음 */
  sinceLast?: AccountSinceLast | null;
  /** 브리핑 3차 4 (플래그 accountExposure): 비중 한 줄. 켜졌는데 값이 있는 종목이 없으면 null, 꺼짐·예전 기록에는 칸이 없음 */
  exposure?: AccountExposure | null;
}

/** 브리핑 3차 4: 비중 한 줄의 레버리지·인버스 종목 (값이 큰 순). L = 배수의 크기(인버스도 양수), 모르면 null. weight = 비중(%) */
export interface AccountExposureItem {
  code: string;
  name: string;
  kind: "leveraged" | "inverse";
  L: number | null;
  weight: number;
}

/**
 * 브리핑 3차 4: 비중 한 줄 (서버 accountNumbers.AccountExposure 와 같은 모양). 비중 = 보유 종목 원화 평가금액(비용 차감) ÷ 합계 × 100, 소수 한 자리 —
 * 여럿의 합은 원 값을 더한 뒤 반올림. 현금 제외
 */
export interface AccountExposure {
  /** 기준 시각 = 계좌 브리핑 asOf */
  asOf: string;
  /** 비중 분모에 넣은 종목 수 */
  count: number;
  top1: { code: string; name: string; weight: number };
  /** 4종목 이상일 때만 */
  top3: { weight: number } | null;
  levInv: { weight: number; items: AccountExposureItem[] };
  /** 미국 상장(달러) 종목 합과 그 수 */
  us: { weight: number; count: number };
  /** 시세·환율이 없어 합계에서 뺀 보유 종목 수 */
  excluded: number;
  /** 토스 상품 정보를 받지 못해 이름 규칙으로 가린 종목 수 */
  guessedByName: number;
}

/** 브리핑 3차 3: 계좌 브리핑이 저장한 보유 종목 한 줄 (서버 accountNumbers.AccountPosition 과 같은 모양) */
export interface AccountPosition {
  code: string;
  name: string;
  currency: Currency;
  quantity: number;
  /** 원화 평가금액(원). 시세가 없어 합계에서 뺀 종목은 null */
  value: number | null;
  cost: number | null;
}

/** 수량이 바뀐 종목 한 줄 (새 종목은 from 0, 없어진 종목은 to 0) */
export interface AccountQtyChange {
  code: string;
  name: string;
  from: number;
  to: number;
}

/** 비중(%, 소수 한 자리) 변화 한 줄. change = to − from */
export interface AccountWeightChange {
  code: string;
  name: string;
  from: number;
  to: number;
  change: number;
}

/** 브리핑 3차 3: 지난 같은 세션 계좌 브리핑과 비교 (서버 accountNumbers.AccountSinceLast 와 같은 모양) */
export interface AccountSinceLast {
  prev: { id: number; date: string; session: BriefingSession; asOf: string };
  value: { from: number; to: number; change: number; rate: number | null };
  profit: { from: number; to: number; change: number };
  /** 지난 브리핑에 종목별 값이 없으면(배포 첫날) null */
  positions: { added: AccountQtyChange[]; removed: AccountQtyChange[]; increased: AccountQtyChange[]; decreased: AccountQtyChange[] } | null;
  weights: AccountWeightChange[] | null;
  excludedNow: { code: string; name: string }[];
  excludedPrev: { code: string; name: string }[];
  /**
   * 금액·비중 비교 범위 (서버 accountNumbers.AccountSinceLast.scope): all = 두 합계 그대로, common = 한쪽 합계에서만 빠진 종목(oneSide)을 양쪽에서 빼고,
   * mixed = 종목별 값이 없어 뺄 수 없음(합계에서 뺀 종목이 두 브리핑에서 다름). 칸이 없으면 all
   */
  scope?: "all" | "common" | "mixed";
  /** 한쪽 브리핑 합계에서만 빠진 종목. side = 값이 없던 브리핑, why = 시세(price)·환율(fx)을 받지 못함. 칸이 없으면 없음 */
  oneSide?: { code: string; name: string; side: "prev" | "now"; why: "price" | "fx" }[];
}

export interface AccountHeadline {
  totalValue: number;
  dayPnl: number;
  dayRate: number | null;
  holdings: number;
  /** 당일 손익 기여 상위 3 */
  top: { code: string; name: string; amount: number; changeRate: number | null }[];
  /** 오늘 한국 휴장이라 국내 종목의 등락이 직전 거래일 것 (그럴 때만 옴) */
  krPreviousDay?: boolean;
  /** 지난밤 미국 평일 휴장이라 미국 종목의 등락이 직전 거래일 것 (그럴 때만 옴) */
  usPreviousDay?: boolean;
  /** 쉰 미국 정규장의 뉴욕 날짜 (usPreviousDay 일 때만 옴) */
  usHolidayDate?: string;
  /** 브리핑 3차 3 (플래그 accountSinceLast): 지난 같은 세션 브리핑과 비교 한 줄 — 날짜·세션·총 평가 변화·수량 바뀐 종목 수(모르면 null)·
   *  금액 비교에서 뺀 종목 수 leftOut(한쪽 브리핑 합계에서만 빠진 종목, 있을 때만). 비교가 저장된 브리핑만 오고, 합계에서 뺀 종목이 달라 금액을 맞추지 못한 브리핑은 안 옴 */
  since?: { date: string; session: BriefingSession; change: number; qtyChanged: number | null; leftOut?: number };
}

export interface AccountBriefing {
  id: number;
  date: string;
  session: BriefingSession;
  status: "ok" | "failed";
  summary: string;
  detail: string;
  model: string;
  /** 모델 설명 없이 숫자만으로 만든 기본 문장 */
  template: boolean;
  createdAt: string;
  headline: AccountHeadline | null;
}

export interface AccountBriefingWithData extends AccountBriefing {
  data: AccountData | null;
}

export interface LatestBriefing {
  code: string;
  name: string;
  latest: Briefing | null;
}

// ── 시장 전체 요약 (플래그 marketSummary, 서버 marketSummaryCalc 의 MarketSummaryData 와 같은 모양) ──

export type SummaryMarket = "US" | "KR";

export interface SummaryIndex {
  code: string;
  name: string;
  value: number | null;
  change: number | null;
  changeRate: number | null;
  /** 값의 거래일 (현지) */
  date: string | null;
  asOf: string | null;
  /** 받지 못한 까닭 (있으면 칸은 '—') */
  missing?: string;
}

export interface SummaryFx {
  value: number;
  change: number;
  changeRate: number;
  /** 하나은행 고시 일별 시리즈의 마지막 날짜 */
  date: string | null;
  stale: boolean;
}

export interface SummaryYield {
  value: number;
  change: number | null;
  date: string;
  prevValue: number | null;
  prevDate: string | null;
  /** treasury = 미 재무부, naver = 네이버(로이터 시장 수익률) — 산출 방식이 달라 출처를 적는다 */
  source: "treasury" | "naver";
  dp: { value: number; change: number };
}

export interface SectorRow {
  name: string;
  code: string;
  changeRate: number;
  count?: number;
}

export interface SummarySectors {
  basis: "etf" | "naver";
  date: string;
  strong: SectorRow[];
  weak: SectorRow[];
  all: SectorRow[];
  excluded: { name: string; changeRate: number; reason: string }[];
  total: number;
}

export type CompareGroup = "high" | "similar" | "low";

export interface CompareRow {
  code: string;
  name: string;
  changeRate: number;
  benchmark: { code: string; name: string; changeRate: number };
  /** 종목 등락률 − 기준 지수 등락률 (%p) */
  diff: number;
  group: CompareGroup;
}

export interface HoldingsCompare {
  market: SummaryMarket;
  compared: number;
  up: number;
  down: number;
  flat: number;
  high: CompareRow[];
  similar: CompareRow[];
  low: CompareRow[];
  /** 뺀 종목 이름. bond(채권·금리형 ETF)는 나중에 더한 칸이라 예전에 저장한 요약에는 없다 */
  excluded: { leverage: string[]; overseas: string[]; bond?: string[]; noQuote: string[]; noBenchmark: string[] };
  benchmarks: { code: string; name: string; changeRate: number }[];
}

export interface SummaryEvent {
  kind: "fomc" | "cpi" | "jobs" | "bok" | "kr-holiday" | "kr-open" | "us-holiday" | "us-early" | "kr-special";
  /** 한국 날짜 */
  date: string;
  endDate?: string;
  /** 한국 시각 HH:MM, '오전', 없으면 null */
  time: string | null;
  text: string;
  at: string;
  tentative?: boolean;
  source?: string;
}

export interface SummaryNews {
  /** 언론사 제목 원문 그대로 */
  title: string;
  outlet: string;
  publishedAt: string;
  url: string;
}

export interface MarketSummaryData {
  version: 1;
  session: BriefingSession;
  market: SummaryMarket;
  date: string;
  marketDate: string;
  basisDate: string;
  asOf: string;
  holiday: { date: string; name: string | null } | null;
  weekendGap: boolean;
  earlyClose: boolean;
  closeTime: string;
  phase: "final" | "intraday" | "prelim";
  indices: SummaryIndex[];
  fx: SummaryFx | null;
  yield10y: SummaryYield | null;
  sectors: SummarySectors | null;
  holdings: HoldingsCompare | null;
  events: { within: SummaryEvent[]; next: SummaryEvent | null; unknown: string[] };
  news: { query: string; from: string; to: string; items: SummaryNews[]; fresh: boolean };
  notes: string[];
}

/** GET /api/market-summaries — 목록과 한 건이 같은 모양 (data 포함) */
export interface MarketSummary {
  id: number;
  date: string;
  session: BriefingSession;
  market: SummaryMarket;
  status: "ok" | "failed";
  summary: string;
  createdAt: string;
  data: MarketSummaryData | null;
}

export interface RunResult {
  session: BriefingSession;
  date: string;
  results: { code: string; name: string; status: "ok" | "failed" | "skipped"; briefingId: number | null; error: string | null; summary: string | null }[];
}

export interface MarketState {
  market: "KR" | "US";
  isTradingDay: boolean;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
  source: "toss" | "fallback";
}

/** 홈 상단 지수 띠 (코스피·코스닥·나스닥·S&P500·다우·필라반도체·원/달러) */
export interface MarketIndex {
  code: string;
  name: string;
  /** index: 지수(포인트), fx: 환율(원). 구버전 서버는 없음 */
  kind?: "index" | "fx";
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  /** 출처의 시세 시각 */
  asOf: string | null;
  /** 서버가 출처에서 이 값을 받은 시각 (ISO). 구버전 서버는 없음 */
  fetchedAt?: string;
  /** 출처 조회가 실패해 마지막 값을 그대로 준 경우 (fetchedAt·asOf 는 원래 시각, open 은 false). 구버전 서버는 없음 */
  stale?: boolean;
}

export interface MarketStatus {
  now: string;
  KR: MarketState;
  US: MarketState;
}

export interface LastBriefingRun {
  session: BriefingSession;
  date: string;
  startedAt: string;
  finishedAt: string;
  ok: number;
  failed: number;
  skipped: number;
  lastError: string | null;
  trigger: "schedule" | "manual";
}

export type AnalysisKind = "company" | "value" | "technical";

export interface Analysis {
  id: number;
  code: string;
  kind: AnalysisKind;
  content: string;
  missing: string[];
  model: string;
  createdAt: string;
  cached: boolean;
}

export interface NewsItem {
  title: string;
  url: string;
  source: string | null;
  publishedAt: string;
  summary: string | null;
}

export interface Disclosure {
  receiptNo: string;
  title: string;
  filedAt: string;
  filer: string;
  url: string;
}

export interface StockNews {
  code: string;
  name: string;
  news: NewsItem[];
  newsError: string | null;
  disclosures: Disclosure[];
  disclosuresError: string | null;
}

export interface Health {
  ok: boolean;
  time: string;
  /** 토큰이 없거나 틀리면 서버가 빈 값({})을 준다 (limited) */
  sources?: Record<string, string>;
  /** 토큰이 없거나 틀려 상세를 뺀 응답 */
  limited?: boolean;
  schedule: { timezone: string; running: boolean; jobs: { session: BriefingSession; cron: string; nextRun: string | null }[] } | null;
  devices?: number;
  authRequired?: boolean;
  tossOpenApi?: TossOpenApiStatus;
  lastBriefing?: LastBriefingRun | null;
  /** 서버→앱 실시간 스트림(/api/stream): 접속한 앱 수, 폴링 여부 */
  stream?: { clients: number; polling: boolean; tracked: number };
  llmConfigured?: boolean;
  /** 최근 7일 앱 오류 수 (시험 보고 제외) */
  appErrors?: { days: number; total: number; fatal: number } | null;
  /** 매매 기록 상태 (3-36 서버부터, 서버 플래그 tradeRecords 가 켜져 있을 때만). 예전 서버·꺼짐이면 없음 */
  tradeRecords?: TradeRecordsHealth | null;
  disclaimer: string;
}

/** 매매 기록(3-36) 상태 가운데 앱이 쓰는 칸 — 서버가 일별 계좌 스냅샷·체결을 쌓고 있는지 (읽기만) */
export interface TradeRecordsHealth {
  /** 서버에 토스 키가 있는지 (없으면 기록을 찍지 않음) */
  toss: boolean;
  /** 기록 시작일 YYYY-MM-DD (아직 없으면 null) */
  since: string | null;
  /** 스냅샷을 저장한 날 수 (한국·미국 합쳐 날짜 기준) */
  days: number;
  /** 최근 5거래일 가운데 스냅샷이 없는 날 */
  missing5?: { market: "KR" | "US"; date: string }[];
  warning?: string | null;
  trades?: { count: number };
}

export interface AppErrorSummary {
  days: number;
  since: string;
  total: number;
  fatal: number;
  byDay: { date: string; count: number }[];
  byKind: Record<string, number>;
  top: { fingerprint: string; kind: string; message: string; screen: string | null; count: number; lastAt: string; updateId: string | null }[];
  recent: { at: string; kind: string; message: string; screen: string | null; appVersion: string | null; updateId: string | null }[];
}

export interface ApiError {
  error: string;
  message: string;
}

export interface Device {
  token: string;
  platform: string;
  deviceName: string | null;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface NotificationSettings {
  morningTime: string; // HH:MM (KST)
  afternoonTime: string;
  morningEnabled: boolean;
  afternoonEnabled: boolean;
  weekdaysOnly: boolean;
  pushEnabled: boolean;
  /** 3-19 서버부터: 조용한 시간(한국 시간)·알림 끈 종목·세션당 1건 묶음 여부. 예전 서버는 없음 */
  quietEnabled?: boolean;
  quietStart?: string;
  quietEnd?: string;
  mutedCodes?: string[];
  digest?: boolean;
  /** 계좌 한 장 브리핑 플래그 (3-31 서버부터). 켜져 있으면 세션 알림 앞머리가 계좌 요약 */
  accountBriefing?: boolean;
  /** 브리핑 실행 중 (3-19 서버부터) */
  running?: boolean;
  schedule: Health["schedule"];
}

export type NotificationSettingsPatch = Partial<Omit<NotificationSettings, "schedule" | "digest" | "running" | "accountBriefing">> & { mute?: { code: string; muted: boolean } };

export interface SendSummary {
  sent: number;
  failed: number;
  disabled: string[];
}

// ── 발견 탭 ────────────────────────────────────────────────────────
export type DiscoverMarket = "KR" | "US";
export type RankCategory = "tradingValue" | "volume" | "gainers" | "losers";
/** 테마·업종 등락률 기간 */
export type ThemePeriod = "day" | "week" | "month";
/** 테마(재료별 묶음) / 업종(산업 분류) */
export type ThemeKind = "theme" | "sector";

/** 순위·테마 목록의 종목 한 줄 */
export interface DiscoverStock {
  code: string;
  name: string;
  market: Market | string;
  currency: Currency;
  price: number;
  change: number;
  changeRate: number;
  volume: number | null;
  /** 거래대금 (종목 통화) */
  tradingValue: number | null;
  marketCap?: number | null;
  /** 상장 첫날 (가격제한폭이 없어 등락률이 크게 나온다) */
  newlyListed?: boolean;
  /** 거래정지 (출처 표시) */
  suspended?: boolean;
}

/**
 * 발견 탭 값의 장 상태 (서버가 준다, 옛 서버는 없음)
 *  - regular: 정규장 · extended: 한국 정규장 뒤 시간외(15:30~20:00, 값이 계속 바뀜)
 *  - pre: 한국 정규장 전(08:00~09:00, 직전 거래일 값) · closed: 장 마감·휴장 (미국은 프리·애프터 포함)
 */
export type DiscoverSession = "regular" | "extended" | "pre" | "closed";

export interface DiscoverRank {
  market: DiscoverMarket;
  category: RankCategory;
  items: DiscoverStock[];
  page: number;
  hasMore: boolean;
  /** 값이 바뀌는 시간이면 true (30초 자동 갱신) */
  marketOpen: boolean;
  session?: DiscoverSession;
  /** 목록 판 — 다음 쪽 요청에 돌려주면 같은 목록에서 이어 받는다 (옛 서버는 없음) */
  ver?: number;
  /** 요청한 판을 서버가 더 갖고 있지 않아(재시작 등) 이어 줄 수 없다 — 첫 쪽부터 다시 받는다 (items 는 빈 목록) */
  restart?: boolean;
  asOf: string | null;
  /** 미국 종목 원화 환산용 */
  fxRate?: number | null;
  source: string;
  note?: string | null;
}

export interface ThemeSummary {
  id: string;
  name: string;
  changeRate: number;
  up: number;
  flat: number;
  down: number;
  /** 대표 종목 2~3개 (출처가 등락률을 주지 않으면 changeRate 는 null) */
  leaders: { code: string; name: string; changeRate: number | null }[];
  /** 상장 첫날 종목(가격제한폭 없음)을 빼고 다시 계산한 값이면 true */
  adjusted?: boolean;
  /** changeRate 가 시가총액 가중 평균일 때 함께 오는 단순 평균 (미국 테마) */
  simpleAvg?: number;
  /**
   * 요약을 보이는 종목 값과 같은 때 값으로 확인하지 못했다 (미국 업종 상세, 출처 초기화 때) — changeRate 는 대표 값이 아니고
   * 상승·보합·하락 수는 0(세지 않음). 옛 서버는 없음
   */
  unverified?: boolean;
}

export interface ThemeList {
  market: DiscoverMarket;
  kind: ThemeKind;
  period: ThemePeriod;
  themes: ThemeSummary[];
  marketOpen: boolean;
  session?: DiscoverSession;
  /** 장 밖인데 정규장 값이 없어 지금 값(주간·프리·애프터 섞임)을 준 경우 */
  live?: boolean;
  asOf: string | null;
  source: string;
  /** 테마 등락률 산출 방식 (출처 값 / 구성 종목 평균 등) */
  basis: string;
  /** 범위·대체 안내 (예: 기간 등락률을 받은 테마만) */
  note?: string | null;
  /** 테마 구성(소속 종목)을 마지막으로 새로 만든 시각 — 미국 테마만 (매일 자동 갱신) */
  updatedAt?: string | null;
}

export interface ThemeDetail {
  market: DiscoverMarket;
  kind: ThemeKind;
  theme: ThemeSummary;
  /** 테마 설명 (출처가 줄 때) */
  description?: string | null;
  items: DiscoverStock[];
  marketOpen: boolean;
  session?: DiscoverSession;
  asOf: string | null;
  fxRate?: number | null;
  source: string;
  basis: string;
  /** 범위 안내 (예: 시가총액 상위 30종목 기준) */
  note?: string | null;
  updatedAt?: string | null;
}


/** GET /api/features — 기능 켜고 끄기 (3-15). 목록은 서버 한 곳(featureService.ts)에만 있다 */
export interface FeatureFlags {
  features: Record<string, boolean>;
  updatedAt: string | null;
}

/**
 * GET /api/scores/:code — 지표 점수 (3-44, 플래그 indicatorScores). 서버 services/indicatorScoreService 의 ScoresResponse 와 같은 모양.
 * 모든 문장은 서버가 만든다(금지어 검사를 서버 한 곳에서) — 앱은 배치만 하고, 앱에 고정된 글은 줄 이름·버튼뿐이다.
 * 1단계: 추세 지표 점수. 2단계(서버 플래그 valueScore): 미국 보통주 가치 지표 점수와 종합(두 점수가 모두 있을 때 평균) — 한국은 '계산 준비 중', ETF 는 '대상 아님'.
 * 예전 서버(1단계)는 가치 칸에 label·text 만 준다 → 새 칸은 모두 없을 수 있다고 보고 그린다.
 * trend.reason.code 'fetchFailed' = 받기 실패(일봉·비교 지수·기초자산 일봉) — 서버가 5분 뒤 다시 계산한다
 */
export type TrendBandName = "강함" | "다소 강함" | "중립" | "다소 약함" | "약함";
/** 글 조각 (sign 이 있으면 등락 색 — 레버리지 상자의 수익률 숫자만) */
export interface ScoreTextPart {
  text: string;
  sign?: number;
}
export interface ScoreFamily {
  key: "T" | "M" | "O" | "R" | "V";
  name: string;
  about: string;
  weight: number;
  score: number | null;
  scoreExact: number | null;
  text: string;
  facts: { label: string; value: string }[];
  items: { key: string; name: string; score: number | null }[];
}
export interface LeverageFactsView {
  L: number;
  asOf: string;
  from: string;
  etf63Pct: number;
  und63Pct: number | null;
  naiveLx63Pct: number | null;
  sigEtfAnnPct: number;
  sigUnderlyingAnnPct: number | null;
  volDecayPctPerYear: number | null;
  etfMdd1yPct: number;
}
export interface TrendScoreBlock {
  version: string;
  cal: string;
  status: "ok" | "unavailable" | "hold" | "excluded";
  /** 요약 카드 줄의 글: 띠 이름 · 점수 없음 · 잠시 보류 · 대상 아님 · 이 상품 자체 점수 없음 */
  label: string;
  reason: { code: string; text: string } | null;
  /** 화면 정수 (최근 5거래일 평균의 반올림) */
  score: number | null;
  scoreExact: number | null;
  scoreToday: number | null;
  band: TrendBandName | null;
  meaning: string | null;
  headline: string | null;
  basisLine: string | null;
  bandLine: string | null;
  basis: { kind: "self" | "underlying"; code: string; name: string };
  benchmark: { code: string; name: string } | null;
  candleSource: string | null;
  bars: number | null;
  daysAveraged: number | null;
  coverage: number | null;
  families: ScoreFamily[];
  notes: string[];
  change: { from: string; prev: number; now: number; diff: number; family: string; familyName: string; familyDiff: number; text: string } | null;
  reference: { code: string; name: string; status: "ok" | "unavailable" | "hold"; score: number | null; band: TrendBandName | null; text: string; note: string | null } | null;
  leveraged: {
    L: number;
    underlying: string | null;
    tracks: string | null;
    check: { days: number; corr: number | null; beta: number | null } | null;
    facts: LeverageFactsView | null;
    box: { title: string; lines: { parts: ScoreTextPart[] }[] };
  } | null;
  versionLine: string;
}
/** 가치 지표 띠 (보이는 정수로: 0~33 · 34~66 · 67~100) */
export type ValueBandName = "낮은 편" | "가운데쯤" | "높은 편";
/** 가치 지표 한 지표 줄 (가치분석 탭 상세) — 모든 글은 서버가 만든다 */
export interface ValueMetricRow {
  key: string;
  name: string;
  /** '32.1배' · '12.3%' · '순현금' (계산 안 한 지표는 null) */
  value: string | null;
  /** 연간 재무로 계산한 지표의 기준 '2026년 1월 결산 연간 기준' (성장·이익 안정성·ROE 안정성·주식 수 변화). 예전 서버·그 밖 지표는 없음 */
  basis?: string | null;
  /** '업종 가운데값 25.0배' */
  peerMedian: string | null;
  /** '업종 안 위치 72/100 · 시장 안 64/100 · 지난 5년 중 31/100' */
  positions: string | null;
  /** 실제로 쓴 비교 비중 '업종 50 · 시장 20 · 지난 5년 30' */
  mix: string | null;
  score: number | null;
  text: string;
  meaning: string;
  /** 점수에 쓴 지표인지 (시장 70% 규칙으로 안 쓰는 지표 · 값이 없는 지표는 false) */
  used: boolean;
  note?: string | null;
}
export interface ValueFamilyRow {
  key: "price" | "quality" | "health" | "growth" | "payout";
  name: string;
  about: string;
  weight: number;
  score: number | null;
  scoreExact: number | null;
  text: string;
  metrics: ValueMetricRow[];
}
/** 가치 지표 칸. 예전 서버(1단계)는 method·status·label·score·band·about·text 만 준다 */
export interface ValueScoreBlock {
  method: string;
  /** ok · partial(일부 지표 없이) · insufficient·unavailable(점수 없음) · excluded(대상 아님) · pending(계산 준비 중) · hold(잠시 보류) */
  status: "ok" | "partial" | "insufficient" | "unavailable" | "excluded" | "pending" | "hold";
  /**
   * 요약 카드 줄의 글: '66점 · 가운데쯤'(점수 있음 — 예전 앱이 이 글만 굵게 보이므로 숫자까지) · 점수 없음 · 대상 아님 · 계산 준비 중 · 잠시 보류.
   * 새 앱은 점수가 있으면 score·band 를 쓴다
   */
  label: string;
  score: number | null;
  scoreExact?: number | null;
  band: ValueBandName | string | null;
  about: string;
  /** 요약 카드 설명 줄 (점수가 있으면 뜻, 없으면 이유) */
  text: string;
  reason?: { code: string; text: string } | null;
  /** '일부 지표 없이 계산' · '지난 값 9/24' */
  badges?: string[];
  headline?: string | null;
  peerLine?: string | null;
  datesLine?: string | null;
  priceNote?: string | null;
  path?: "general" | "financial" | null;
  coverageWeight?: number | null;
  families?: ValueFamilyRow[];
  flags?: { key: string; text: string }[];
  notes?: string[];
  change?: { from: string; prev: number; now: number; diff: number; family: string; familyName: string; familyDiff: number; cause: string; text: string } | null;
  asOf?: { priceThrough: string | null; fiscalEnd: string | null; filed: string | null; form: string | null; basis: "FY" | "TTM" | null; fiscalLabel: string | null; fiscalShort: string | null; reference: string | null; fetchedAt: string | null };
  /** 계산 방식·출처 줄 — 점수를 계산했을 때만 (한국·ETF·점수 없음은 null) */
  versionLine?: string | null;
}
export interface IndicatorScores {
  code: string;
  name: string;
  market: "KR" | "US";
  asOf: { priceDate: string | null; scoreDate: string; market: "KR" | "US"; line: string | null };
  value: ValueScoreBlock;
  trend: TrendScoreBlock;
  /** 종합 = 화면에 보이는 두 정수의 평균 (둘 다 있고 기준일이 같을 때만). 차이 30 이상이면 gapNote·gapText */
  composite: { status: "ok" | "none"; score: number | null; reason: string | null; text: string; gap: number | null; gapNote: boolean; gapText?: string | null };
  text: { titleNote: string; notForecast: string; how: string[]; disclaimerShort: string; detailNote: string; trendAbout: string; valueAbout?: string; valueDetailNote?: string };
  computedAt: string;
}

/** 가격 알림 조건 종류 (3-29, 플래그 priceAlerts) — 서버 services/priceAlertService 와 같은 글자 */
export type PriceAlertKind = "priceAbove" | "priceBelow" | "rateUp" | "rateDown" | "volume";

/** 가격 알림 조건 (서버 GET /api/price-alerts 의 한 줄) */
export interface PriceAlertRule {
  id: number;
  code: string;
  kind: PriceAlertKind;
  /** 가격(종목 통화) · 등락률(양수 %) · 거래량 배수 */
  value: number;
  /** 가격 조건만 종목 통화, 그 밖에는 null */
  currency: Currency | null;
  createdAt: string;
  /** 마지막으로 울린 그 종목 거래일 YYYY-MM-DD */
  firedOn: string | null;
  firedAt: string | null;
  firedValue: number | null;
  /** 지금 등록 종목(보유·관심)인지 — 아니면 쉬는 중 (확인하지 않음) */
  registered: boolean;
}

export type VolumeState = "ok" | "closed" | "early" | "short" | "unavailable";

/** 거래량 급증 상태 (서버 GET /api/price-alerts/volume 의 한 줄 — services/volumeBaseline 과 같은 모양) */
export interface VolumeStatus {
  code: string;
  status: VolumeState;
  /** 그 시장의 오늘 날짜. closed 면 null */
  date: string | null;
  /** 오늘 정규장 누적 거래량 (ok 일 때만) */
  volume: number | null;
  /** 지난 거래일들의 같은 경과 시간 누적 평균 (ok 일 때만) */
  expected: number | null;
  /** volume ÷ 평균, 소수 둘째 자리 (ok 일 때만) */
  ratio: number | null;
  /** 평균에 쓴 지난 거래일 수 */
  days: number;
  minutes: number | null;
  asOf: string;
  reason: string | null;
}

/** 브리핑 3차 2 (플래그 briefingStatus): 실패 브리핑 오류 글의 쉬운 종류 (서버 services/briefingStatus.failureKind 와 같은 표) */
export type BriefingFailureKind = "busy" | "outage" | "setup" | "cutoff" | "other";
/** 안내 이유: 오류 종류 + 서버가 도중에 다시 켜져 줄이 없는 종목 */
export type BriefingReasonKind = BriefingFailureKind | "restart";

/** 못 만든 종목 하나 */
export interface BriefingStatusProblem {
  code: string;
  name: string;
  /** 누르면 열 브리핑 (실패 브리핑, 줄이 없으면 같은 회차의 가장 최근 브리핑). 없으면 누를 수 없음 */
  briefingId: number | null;
  kind: BriefingReasonKind;
  /** 이번 회차 줄이 아예 없음 */
  missing: boolean;
}

/** 브리핑 늦음·실패 안내 (서버 GET /api/briefings/status — 플래그가 꺼져 있거나 예전 서버면 404) */
export interface BriefingStatus {
  session: BriefingSession | null;
  date: string;
  scheduledAt: string | null;
  state: "ok" | "late" | "partial" | "allFailed" | "slow" | "missed" | "llmOff" | "none";
  /** 완료가 예약 + 20분 뒤 */
  late: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  problems: BriefingStatusProblem[];
  reasonKind: BriefingReasonKind | null;
  nextRunAt: string | null;
  /** 자동으로 한 번 더 만드는 시각 — 지금 서버는 늘 null */
  retryAt: string | null;
  /** 상세의 '이 종목 다시 만들기'가 있는지 (플래그 briefingManualRun) */
  manualRun: boolean;
}
