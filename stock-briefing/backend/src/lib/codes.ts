import type { Market } from "../domain/types.js";

/**
 * 종목 코드 규칙.
 *  - 한국: 6자리 숫자 (000660)
 *  - 미국: 티커 1~10자, 영문 대문자로 시작, 영문/숫자/하이픈, 끝에 ".한글자" 클래스 접미사만 허용 (AAPL, BRK-B, BF.B)
 *    ".TO", ".KS" 같은 거래소 접미사(두 글자 이상)는 거절한다.
 */
export const CODE_RE = /^(?:\d{6}|[A-Z][A-Z0-9\-]{0,9}(?:\.[A-Z])?)$/;
export const US_TICKER_RE = /^[A-Z][A-Z0-9\-]{0,9}(?:\.[A-Z])?$/;

export function isKrCode(code: string): boolean {
  return /^\d{6}$/.test(code);
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
