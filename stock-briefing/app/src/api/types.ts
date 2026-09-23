/** 백엔드 응답 타입 (backend/src/domain, services 와 맞춘다) */

export type Market = "KOSPI" | "KOSDAQ" | "NASDAQ" | "NYSE" | "AMEX" | "US" | "UNKNOWN";
export type Currency = "KRW" | "USD";

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
