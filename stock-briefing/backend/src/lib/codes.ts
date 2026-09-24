import type { Market } from "../domain/types.js";

/**
 * 종목 코드 규칙.
 *  - 한국: 숫자로 시작하는 6자리 (000660). 2025년부터 ETF 등에 영문이 섞인 코드(0162Z0)도 나와 뒤 5자리는 영숫자 허용
 *  - 미국: 티커 1~10자, 영문 대문자로 시작, 영문/숫자/하이픈, 끝에 ".한글자" 클래스 접미사만 허용 (AAPL, BRK-B, BF.B)
 *    ".TO", ".KS" 같은 거래소 접미사(두 글자 이상)는 거절한다.
 *  첫 글자가 숫자면 한국, 영문이면 미국이라 두 형식이 겹치지 않는다.
 *  NAVER·KT·LG 같은 영문 종목명도 티커 형식에 맞으므로, 검색어가 코드인지 이름인지 가르는 데는 쓰지 않는다 (DISC-05).
 */
export const KR_CODE_RE = /^\d[0-9A-Z]{5}$/;
export const US_TICKER_RE = /^[A-Z][A-Z0-9\-]{0,9}(?:\.[A-Z])?$/;
export const CODE_RE = /^(?:\d[0-9A-Z]{5}|[A-Z][A-Z0-9\-]{0,9}(?:\.[A-Z])?)$/;

export function isKrCode(code: string): boolean {
  return KR_CODE_RE.test(code);
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export type Currency = "KRW" | "USD";

export const US_MARKETS: ReadonlySet<Market> = new Set<Market>(["NASDAQ", "NYSE", "AMEX", "US"]);

export function currencyOf(market: Market): Currency {
  return US_MARKETS.has(market) ? "USD" : "KRW";
}

/** Yahoo 검색 결과의 exchange 코드 → 우리 Market. 지원하지 않는 거래소는 null */
export function marketFromYahooExchange(exchange: string | undefined, symbol: string): Market | null {
  if (/^\d{6}\.KS$/.test(symbol)) return "KOSPI";
  if (/^\d{6}\.KQ$/.test(symbol)) return "KOSDAQ";
  if (!US_TICKER_RE.test(symbol)) return null; // .TO, =F 같은 해외/선물 제외
  switch (exchange) {
    case "NMS":
    case "NGM":
    case "NCM":
      return "NASDAQ";
    case "NYQ":
    case "PCX":
      return "NYSE";
    case "ASE":
      return "AMEX";
    case "BTS":
      return "US";
    default:
      return null;
  }
}
