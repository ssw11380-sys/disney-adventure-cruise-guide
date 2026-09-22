import type { CandlePeriod, CandleSeries, ListedStock, Quote } from "../../domain/types.js";

/**
 * 시세 데이터 소스 인터페이스.
 * KIS, Yahoo 등 구현체를 교체하거나 체인으로 묶을 수 있게 최소한의 메서드만 둔다.
 * 실패 시에는 ProviderError 를 던지고, 체인이 다음 소스로 넘긴다.
 */
export interface QuoteProvider {
  readonly name: string;
  /** 이 소스가 해당 코드를 다룰 수 있는지 (예: KIS 는 한국 종목만). 없으면 전부 지원 */
  supports?(code: string): boolean;
  getQuote(code: string): Promise<Quote>;
  getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries>;
}

/** 종목명/코드 검색 소스 (로컬 마스터, Yahoo 검색 등) */
export interface StockSearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<ListedStock[]>;
}

/** 상장 종목 마스터 전체를 내려받는 소스 (KIS 마스터 파일) */
export interface MasterProvider {
  readonly name: string;
  fetchAll(): Promise<ListedStock[]>;
}

/** fetch 를 주입 가능하게 해서 테스트에서 네트워크를 끊는다. */
export type FetchFn = typeof fetch;
