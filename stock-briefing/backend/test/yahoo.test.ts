import { describe, expect, it } from "vitest";
import { YahooProvider } from "../src/providers/market/yahoo.js";
import type { FetchFn } from "../src/providers/market/types.js";

function chartResponse(meta: Record<string, unknown>, closes: number[]): unknown {
  const ts = closes.map((_, i) => 1_790_000_000 + i * 86_400);
  return {
    chart: {
      result: [
        {
          meta,
          timestamp: ts,
          indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 100) }] },
        },
      ],
    },
  };
}

function fakeFetch(handler: (url: string) => unknown): FetchFn {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = handler(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as FetchFn;
}

describe("YahooProvider", () => {
  it("전일 대비는 chartPreviousClose 가 아니라 meta 의 당일 변동값으로 계산한다", async () => {
    const fetchFn = fakeFetch(() =>
      chartResponse(
        { regularMarketPrice: 1_840_000, fulldayChange: -28_000, fulldayChangePercent: -1.499, chartPreviousClose: 351_000 },
        [1_800_000, 1_868_000, 1_840_000],
      ),
    );
    const q = await new YahooProvider(fetchFn, async () => "KOSPI").getQuote("000660");
    expect(q.prevClose).toBe(1_868_000);
    expect(q.change).toBe(-28_000);
    expect(q.changeRate).toBe(-1.5);
    expect(q.source).toBe("yahoo");
  });

  it("meta 에 변동값이 없으면 직전 봉 종가로 계산한다", async () => {
    const fetchFn = fakeFetch(() => chartResponse({ regularMarketPrice: 110 }, [90, 100, 110]));
    const q = await new YahooProvider(fetchFn, async () => "KOSPI").getQuote("005930");
    expect(q.prevClose).toBe(100);
    expect(q.change).toBe(10);
    expect(q.changeRate).toBe(10);
  });

  it("시장을 모르면 .KS 로 시도한 뒤 .KQ 로 재시도한다", async () => {
    const urls: string[] = [];
    const fetchFn = fakeFetch((url) => {
      urls.push(url);
      return url.includes(".KS") ? { chart: { result: null, error: { code: "Not Found" } } } : chartResponse({ regularMarketPrice: 50 }, [40, 50]);
    });
    const series = await new YahooProvider(fetchFn).getCandles("247540", "D", 10);
    expect(urls[0]).toContain("247540.KS");
    expect(urls[1]).toContain("247540.KQ");
    expect(series.candles).toHaveLength(2);
  });

  it("검색 결과에서 한국 종목만 골라 코드/시장으로 변환한다", async () => {
    const fetchFn = fakeFetch(() => ({
      quotes: [
        { symbol: "SKHY", longname: "SK hynix Inc.", quoteType: "EQUITY" },
        { symbol: "000660.KS", longname: "SK hynix Inc.", quoteType: "EQUITY" },
        { symbol: "247540.KQ", shortname: "EcoPro BM", quoteType: "EQUITY" },
      ],
    }));
    const r = await new YahooProvider(fetchFn).search("하이닉스", 10);
    expect(r).toEqual([
      { code: "000660", name: "SK hynix Inc.", market: "KOSPI", isinCode: null, groupCode: "ST" },
      { code: "247540", name: "EcoPro BM", market: "KOSDAQ", isinCode: null, groupCode: "ST" },
    ]);
  });
});
