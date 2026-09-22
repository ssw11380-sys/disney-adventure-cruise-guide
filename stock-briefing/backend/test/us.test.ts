import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { CODE_RE, currencyOf, marketFromYahooExchange, normalizeCode } from "../src/lib/codes.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import type { FetchFn } from "../src/providers/market/types.js";
import { YahooProvider } from "../src/providers/market/yahoo.js";
import { FakeGenerator, FakeQuoteProvider, FakeSearchProvider, fakeProviders, SAMPLE_MASTER } from "./helpers.js";

describe("code rules", () => {
  it("한국 6자리와 미국 티커를 받고 나머지는 거절한다", () => {
    for (const ok of ["000660", "0162Z0", "AAPL", "BRK-B", "BF.B", "TSLA"]) expect(CODE_RE.test(ok), ok).toBe(true);
    for (const bad of ["12345", "aapl", "TSLA.TO", "XTSLA=F", "1AAPL", "ABCDEFGHIJK"]) expect(CODE_RE.test(bad), bad).toBe(false);
    expect(normalizeCode(" tsla ")).toBe("TSLA");
    expect(currencyOf("NASDAQ")).toBe("USD");
    expect(currencyOf("KOSPI")).toBe("KRW");
    expect(marketFromYahooExchange("NMS", "TSLA")).toBe("NASDAQ");
    expect(marketFromYahooExchange("NYQ", "KO")).toBe("NYSE");
    expect(marketFromYahooExchange("TOR", "TSLA.TO")).toBeNull();
    expect(marketFromYahooExchange("KSC", "000660.KS")).toBe("KOSPI");
  });
});

describe("Yahoo US search and quotes", () => {
  const fakeFetch = (handler: (url: string) => unknown): FetchFn =>
    (async (input: string | URL | Request) => new Response(JSON.stringify(handler(String(input))), { status: 200 })) as FetchFn;

  it("검색에서 미국 주식/ETF 만 남기고 선물·해외 상장은 뺀다", async () => {
    const fetchFn = fakeFetch(() => ({
      quotes: [
        { symbol: "TSLA", longname: "Tesla, Inc.", exchange: "NMS", quoteType: "EQUITY" },
        { symbol: "XTSLA=F", shortname: "futures", exchange: "CME", quoteType: "FUTURE" },
        { symbol: "TSLA.TO", shortname: "CDR", exchange: "TOR", quoteType: "EQUITY" },
        { symbol: "TSLT", shortname: "2x", exchange: "BTS", quoteType: "ETF" },
        { symbol: "000660.KS", longname: "SK hynix", exchange: "KSC", quoteType: "EQUITY" },
      ],
    }));
    const r = await new YahooProvider(fetchFn).search("tesla", 10);
    expect(r.map((x) => [x.code, x.market, x.groupCode])).toEqual([
      ["TSLA", "NASDAQ", "ST"],
      ["TSLT", "US", "EF"],
      ["000660", "KOSPI", "ST"],
    ]);
  });

  it("미국 티커는 접미사 없이 조회하고 통화가 USD 로 온다", async () => {
    const urls: string[] = [];
    const fetchFn = fakeFetch((url) => {
      urls.push(url);
      const closes = [330, 335, 340.22];
      return {
        chart: {
          result: [
            {
              meta: { currency: "USD", regularMarketPrice: 340.22, regularMarketChangePercent: 0.366, fulldayChange: 1.24 },
              timestamp: closes.map((_, i) => 1_790_000_000 + i * 86_400),
              indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: [1, 2, 3] }] },
            },
          ],
        },
      };
    });
    const q = await new YahooProvider(fetchFn, async () => null).getQuote("AAPL");
    expect(urls[0]).toContain("/chart/AAPL?");
    expect(q.currency).toBe("USD");
    expect(q.price).toBe(340.22);
  });
});

describe("US stock end to end", () => {
  let app: FastifyInstance;
  let db: Db;
  let kis: FakeQuoteProvider;
  let yahoo: FakeQuoteProvider;
  let gen: FakeGenerator;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    kis = new FakeQuoteProvider("kis");
    (kis as unknown as { supports: (c: string) => boolean }).supports = (c: string) => /^\d{6}$/.test(c);
    yahoo = new FakeQuoteProvider("yahoo", { price: 340 });
    gen = new FakeGenerator();
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({
        quotes: new QuoteProviderChain([kis, yahoo]),
        search: new FakeSearchProvider([{ code: "TSLA", name: "Tesla, Inc.", market: "NASDAQ", isinCode: null, groupCode: "ST" }, SAMPLE_MASTER[0]!]),
        generator: gen,
      }),
      logger: false,
      enableScheduler: false,
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  });
  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("소문자 티커로 등록해도 대문자로 저장되고, 시세는 KIS 를 건너뛰고 Yahoo 로 간다", async () => {
    const res = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "tsla", quantity: 3, avgPrice: 300 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ code: "TSLA", name: "Tesla, Inc.", market: "NASDAQ" });
    const list = (await app.inject({ method: "GET", url: "/api/stocks?quotes=1" })).json();
    expect(list[0].quote.source).toBe("yahoo");
    expect(kis.calls).toBe(0);
    expect(list[0].evaluation).toEqual({ marketValue: 1020, costBasis: 900, profit: 120, profitRate: 13.33 });
    expect((await app.inject({ method: "GET", url: "/api/stocks/tsla" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "TSLA.TO" } })).statusCode).toBe(400);
  });

  it("티커 검색은 마스터 결과와 외부 결과를 합친다", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/stocks/search?q=TSLA" })).json();
    expect(res.results.map((r: { code: string }) => r.code)).toContain("TSLA");
  });

  it("미국 종목 브리핑은 공시·수급을 미지원으로 표시한다", async () => {
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "TSLA" } });
    const run = (await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } })).json();
    expect(run.results[0].status).toBe("ok");
    const [b] = (await app.inject({ method: "GET", url: "/api/briefings?code=TSLA" })).json();
    expect(b.missing).toEqual(["공시(미국 종목 미지원)", "수급(미국 종목 미지원)"]);
    expect(gen.requests[0]!.user).toContain("Tesla, Inc. (TSLA)");
  });
});
