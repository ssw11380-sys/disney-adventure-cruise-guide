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
  live?: boolean; // 실시간 체결로 덮어쓴 현재가
  fxRate?: number | null; // 미국 종목: 1달러당 원화
  dividendPerShare?: number | null;
  dividendYieldPct?: number | null;
  industry?: string | null;
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
  /** 분봉만: 봉 시작 시각 ISO(현지 오프셋 포함) */
  time?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export interface LatestBriefing {
  code: string;
  name: string;
  latest: Briefing | null;
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
  asOf: string | null;
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
  sources: Record<string, string>;
  schedule: { timezone: string; running: boolean; jobs: { session: BriefingSession; cron: string; nextRun: string | null }[] } | null;
  devices?: number;
  authRequired?: boolean;
  tossOpenApi?: TossOpenApiStatus;
  lastBriefing?: LastBriefingRun | null;
  /** 서버→앱 실시간 스트림(/api/stream): 접속한 앱 수, 폴링 여부 */
  stream?: { clients: number; polling: boolean; tracked: number };
  llmConfigured?: boolean;
  disclaimer: string;
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
  schedule: Health["schedule"];
}

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
}

export interface DiscoverRank {
  market: DiscoverMarket;
  category: RankCategory;
  items: DiscoverStock[];
  page: number;
  hasMore: boolean;
  /** 장중이면 true (자동 갱신·"장 마감" 표시) */
  marketOpen: boolean;
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
}

export interface ThemeList {
  market: DiscoverMarket;
  kind: ThemeKind;
  period: ThemePeriod;
  themes: ThemeSummary[];
  marketOpen: boolean;
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
  asOf: string | null;
  fxRate?: number | null;
  source: string;
  basis: string;
  /** 범위 안내 (예: 시가총액 상위 30종목 기준) */
  note?: string | null;
  updatedAt?: string | null;
}

