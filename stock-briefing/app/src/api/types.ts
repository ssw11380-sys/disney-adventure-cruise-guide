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
  /** 서버가 시세를 새로 받지 못해 마지막 값을 그대로 준 경우 (asOf 는 원래 시각). 회색 "시세 지연"으로 표시 */
  stale?: boolean;
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
  disclaimer: string;
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
  /** 브리핑 실행 중 (3-19 서버부터) */
  running?: boolean;
  schedule: Health["schedule"];
}

export type NotificationSettingsPatch = Partial<Omit<NotificationSettings, "schedule" | "digest" | "running">> & { mute?: { code: string; muted: boolean } };

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
