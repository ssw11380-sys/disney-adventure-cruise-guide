import type { CandlePeriod, CandleSeries, ListedStock, Quote } from "../src/domain/types.js";
import { ProviderError } from "../src/lib/errors.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "../src/providers/market/types.js";

export const SAMPLE_MASTER: ListedStock[] = [
  { code: "000660", name: "SK하이닉스", market: "KOSPI", isinCode: "KR7000660001", groupCode: "ST" },
  { code: "005930", name: "삼성전자", market: "KOSPI", isinCode: "KR7005930003", groupCode: "ST" },
  { code: "005935", name: "삼성전자우", market: "KOSPI", isinCode: "KR7005931001", groupCode: "ST" },
  { code: "247540", name: "에코프로비엠", market: "KOSDAQ", isinCode: "KR7247540008", groupCode: "ST" },
  { code: "465580", name: "ACE 하이닉스+삼성전자", market: "KOSPI", isinCode: "KR7465580000", groupCode: "EF" },
];

export function makeQuote(code: string, source: string, price = 100_000): Quote {
  return {
    code, price, change: 1000, changeRate: 1.01, open: 99_000, high: 101_000, low: 98_500, prevClose: 99_000,
    volume: 1_000_000, marketCap: null, per: null, pbr: null, eps: null, bps: null, high52w: null, low52w: null,
    asOf: "2026-09-22T09:00:00+09:00", source,
  };
}

export class FakeQuoteProvider implements QuoteProvider {
  calls = 0;
  constructor(
    public readonly name: string,
    private readonly opts: { fail?: boolean; price?: number } = {},
  ) {}
  async getQuote(code: string): Promise<Quote> {
    this.calls++;
    if (this.opts.fail) throw new ProviderError(this.name, "고의 실패");
    return makeQuote(code, this.name, this.opts.price);
  }
  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    this.calls++;
    if (this.opts.fail) throw new ProviderError(this.name, "고의 실패");
    const candles = Array.from({ length: count }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 1000 + i,
    }));
    return { code, period, candles, source: this.name };
  }
}

export class FakeSearchProvider implements StockSearchProvider {
  readonly name = "fake-search";
  calls: string[] = [];
  constructor(private readonly results: ListedStock[] = []) {}
  async search(query: string): Promise<ListedStock[]> {
    this.calls.push(query);
    return this.results;
  }
}

export class FakeMasterProvider implements MasterProvider {
  readonly name = "fake-master";
  constructor(private readonly rows: ListedStock[] = SAMPLE_MASTER) {}
  async fetchAll(): Promise<ListedStock[]> {
    return this.rows;
  }
}
