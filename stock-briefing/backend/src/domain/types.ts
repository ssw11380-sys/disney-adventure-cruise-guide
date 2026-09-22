/** 도메인 타입. 데이터 소스(KIS/Yahoo/DART)와 무관하게 앱 전체가 공유한다. */

export type Market = "KOSPI" | "KOSDAQ" | "NASDAQ" | "NYSE" | "AMEX" | "US" | "UNKNOWN";

/** 상장 종목 마스터 (검색용) */
export interface ListedStock {
  code: string; // 6자리 단축코드, 예: 000660
  name: string; // 한글 종목명, 예: SK하이닉스
  market: Market;
  isinCode: string | null; // 표준코드 KR7000660001
  /** KIS 그룹코드. ST=주식, EF=ETF, BC=수익증권 등. 모르면 null */
  groupCode: string | null;
}

/** 사용자가 등록한 종목 (관심/보유) */
export interface RegisteredStock {
  code: string;
  name: string;
  market: Market;
  quantity: number | null; // 보유 수량 (관심 종목이면 null)
  avgPrice: number | null; // 평균 단가 (원)
  memo: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

/** 현재가 스냅샷 */
export interface Quote {
  code: string;
  currency: "KRW" | "USD";
  price: number; // 현재가/종가 (currency 단위)
  change: number; // 전일 대비 (원)
  changeRate: number; // 전일 대비 (%)
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null; // 당일 누적 거래량
  marketCap: number | null; // 시가총액 (원)
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  high52w: number | null;
  low52w: number | null;
  asOf: string; // ISO (한국 시간 오프셋)
  source: string; // 'kis' | 'naver' | 'yahoo'
  /**
   * 정규장 밖 거래 가격. 한국은 넥스트레이드(NXT) 프리/애프터마켓(08:00~08:50, 15:40~20:00).
   * 토스·네이버 앱이 장 마감 후 보여주는 값이 이것이라 정규장 종가와 다를 수 있다. 소스가 제공하지 않으면 없음.
   */
  afterMarket?: AfterMarketQuote | null;
  /** price 가 어떤 기준인지 ("KRX 정규장", "KRX+NXT 통합", "정규장"). 소스마다 다르므로 표시용 */
  priceBasis?: string;
  /** 미국 종목의 원화 환산 현재가 (소스가 주는 경우만) */
  priceKrw?: number | null;
  /** 실시간 체결(웹소켓)로 price 를 덮어쓴 경우 true */
  live?: boolean;
}

export interface AfterMarketQuote {
  venue: "NXT" | "US"; // NXT=넥스트레이드(한국), US=미국 프리/애프터마켓
  session: "PRE_MARKET" | "AFTER_MARKET" | "UNKNOWN";
  status: "OPEN" | "CLOSE";
  price: number;
  change: number; // 정규장 전일 종가 대비
  changeRate: number;
  volume: number | null;
  asOf: string; // 마지막 체결 시각 (ISO, 한국 시간)
}

export type CandlePeriod = "D" | "W" | "M";

export interface Candle {
  date: string; // YYYY-MM-DD (주/월봉은 해당 기간 시작일 또는 마지막 거래일, 소스에 따름)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSeries {
  code: string;
  period: CandlePeriod;
  candles: Candle[]; // 오래된 것 → 최신 순
  source: string;
}

/** 브리핑/분석 결과에 "데이터 미확인"을 남기기 위한 공통 래퍼 */
export type Fetched<T> =
  | { ok: true; data: T; source: string }
  | { ok: false; error: string; attempted: string[] };
