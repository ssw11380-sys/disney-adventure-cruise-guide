import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/errors.js";
import { StockSearchChain } from "../src/providers/market/chain.js";
import { TossProvider, type CodeStore } from "../src/providers/market/toss.js";
import { FakeSearchProvider } from "./helpers.js";

/** 2026-09-22 실제 응답을 줄인 것 */
const SEARCH_ITEMS: Record<string, unknown[]> = {
  테슬라: [
    { productCode: "US20100629001", productName: "테슬라", symbol: "TSLA", companyCode: "NAS006XY7-E0", market: "NSQ", stockStatus: "N" },
    { productCode: "A457480", productName: "ACE 테슬라밸류체인액티브", symbol: "457480", companyCode: "EFKSP457480", market: "KSP", stockStatus: "N" },
    { productCode: "US20220809012", productName: "TSLL", symbol: "TSLL", companyCode: "EFNSQTSLL", market: "NSQ", stockStatus: "N" },
    { productCode: "XX1", productName: "상폐", symbol: "DEAD", companyCode: "NAS", market: "NSQ", stockStatus: "D" },
  ],
  TSLA: [{ productCode: "US20100629001", productName: "테슬라", symbol: "TSLA", companyCode: "NAS006XY7-E0", market: "NSQ", stockStatus: "N" }],
  삼성전자: [
    { productCode: "A005930", productName: "삼성전자", symbol: "005930", companyCode: "005930", market: "KSP", stockStatus: "N" },
    { productCode: "A0162Z0", productName: "RISE 삼성전자SK하이닉스채권혼합50", symbol: "0162Z0", companyCode: "EFKSP0162Z0", market: "KSP", stockStatus: "N" },
  ],
  에코프로비엠: [{ productCode: "A247540", productName: "에코프로비엠", symbol: "247540", companyCode: "247540", market: "KSQ", stockStatus: "N" }],
};

const PRICES: Record<string, unknown> = {
  A035420: { exchange: "integrated", productCode: "A035420", currency: "KRW", base: 197900, close: 201500, changeType: "UP", volume: 1050258 },
  US20100629001: { productCode: "US20100629001", currency: "USD", base: 375.3, baseKrw: 519527, close: 376.31, closeKrw: 520925, changeType: "UP", volume: 11094719, afterMarketClose: 377.0, afterMarketCloseKrw: 521880 },
};

const CHART_KR = {
  code: "A035420",
  exchange: "integrated",
  candles: [
    { dt: "2026-09-22T00:00:00+09:00", base: 197900, open: 198200, high: 203500, low: 198200, close: 201500, volume: 1050258 },
    { dt: "2026-09-21T00:00:00+09:00", base: 197700, open: 198900, high: 199700, low: 196100, close: 198400, volume: 1006174 },
    { dt: "2026-09-18T00:00:00+09:00", base: 199000, open: 202000, high: 202500, low: 196100, close: 197600, volume: 1805937 },
  ],
};
const CHART_US = {
  code: "US20100629001",
  exchangeRate: 1384.3,
  candles: [
    { dt: "2026-09-22T00:00:00-04:00", base: 375.3, open: 379.06, high: 379.25, low: 372.88, close: 376.31, volume: 11094536 },
    { dt: "2026-09-21T00:00:00-04:00", base: 364.27, open: 371.63, high: 378.36, low: 371.07, close: 375.3, volume: 36599609 },
  ],
};
const INFO_KR = { code: "A035420", symbol: "035420", name: "NAVER", market: { code: "KSP" }, currency: "KRW", sharesOutstanding: 152094369 };
const INFO_US = { code: "US20100629001", symbol: "TSLA", name: "테슬라", market: { code: "NSQ" }, currency: "USD", sharesOutstanding: 3949547394 };

function fakeFetch(calls: string[] = [], opts: { failSearch?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const ok = (body: unknown) => new Response(JSON.stringify({ result: body }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/search-all/")) {
      if (opts.failSearch) return new Response("nope", { status: 500 });
      const q = (JSON.parse(String(init?.body)) as { query: string }).query;
      return ok([{ type: "PRODUCT", data: { items: SEARCH_ITEMS[q] ?? [] } }]);
    }
    if (url.includes("/v3/stock-prices?")) {
      const codes = decodeURIComponent(url.split("productCodes=")[1]!).split(",");
      return ok(codes.map((c) => PRICES[c]).filter(Boolean));
    }
    if (url.includes("/v1/c-chart/kr-s/A035420/")) return ok(CHART_KR);
    if (url.includes("/v1/c-chart/us-s/US20100629001/")) return ok(CHART_US);
    if (url.includes("/v2/stock-infos/A035420")) return ok(INFO_KR);
    if (url.includes("/v2/stock-infos/US20100629001")) return ok(INFO_US);
    return new Response(JSON.stringify({ error: { statusCode: 404 } }), { status: 404 });
  }) as typeof fetch;
}

class MemoryStore implements CodeStore {
  map = new Map<string, string>();
  gets = 0;
  async get(key: string) {
    this.gets++;
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
}

const NOW = () => new Date("2026-09-22T23:30:00+09:00");

describe("TossProvider", () => {
  it("한글로 검색하면 미국 종목이 나오고 ETF/상폐 구분이 된다", async () => {
    const p = new TossProvider(fakeFetch());
    const r = await p.search("테슬라", 10);
    expect(r.map((x) => [x.code, x.name, x.market, x.groupCode])).toEqual([
      ["TSLA", "테슬라", "NASDAQ", "ST"],
      ["457480", "ACE 테슬라밸류체인액티브", "KOSPI", "EF"],
      ["TSLL", "TSLL", "NASDAQ", "EF"],
    ]);
    const kr = await p.search("삼성전자", 10);
    expect(kr.map((x) => x.code)).toEqual(["005930", "0162Z0"]);
    expect((await p.search("에코프로비엠", 5))[0]).toMatchObject({ code: "247540", market: "KOSDAQ" });
  });

  it("한국 종목은 KRX+NXT 통합 가격, 오늘 봉의 시고저, 발행주식수로 시총을 준다", async () => {
    const calls: string[] = [];
    const q = await new TossProvider(fakeFetch(calls), null, NOW).getQuote("035420");
    expect(q).toMatchObject({
      code: "035420",
      currency: "KRW",
      price: 201500,
      change: 3600,
      changeRate: 1.82,
      prevClose: 197900,
      open: 198200,
      high: 203500,
      low: 198200,
      volume: 1050258,
      marketCap: 201500 * 152094369,
      high52w: 203500,
      low52w: 196100,
      source: "toss",
      priceBasis: "KRX+NXT 통합",
      afterMarket: null,
    });
    expect(calls.some((c) => c.includes("productCodes=A035420"))).toBe(true);
    expect(calls.every((c) => !c.includes("search-all"))).toBe(true); // 한국은 검색 없이 A+코드
  });

  it("미국 티커는 검색으로 상품 코드를 찾아 저장소에 남기고, USD·원화 환산·애프터마켓을 준다", async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const p = new TossProvider(fakeFetch(calls), store, NOW);
    const q = await p.getQuote("tsla");
    expect(q).toMatchObject({ code: "TSLA", currency: "USD", price: 376.31, change: 1.01, changeRate: 0.27, priceKrw: 520925, priceBasis: "정규장" });
    expect(q.afterMarket).toMatchObject({ venue: "US", price: 377, change: 1.7, changeRate: 0.45 });
    expect(store.map.get("toss:product:TSLA")).toBe("US20100629001");
    expect(calls.filter((c) => c.includes("search-all")).length).toBe(1);
    await p.getQuote("TSLA"); // 두 번째는 메모리 캐시
    expect(calls.filter((c) => c.includes("search-all")).length).toBe(1);

    // 새 인스턴스는 저장소에서 읽어 검색 없이 간다
    const calls2: string[] = [];
    await new TossProvider(fakeFetch(calls2), store, NOW).getCandles("TSLA", "D", 2);
    expect(calls2.some((c) => c.includes("search-all"))).toBe(false);
    expect(calls2.some((c) => c.includes("/us-s/US20100629001/day:1?count=2"))).toBe(true);
  });

  it("getMany 는 여러 종목 현재가를 요청 1개로 받고 2초 동안 재사용한다", async () => {
    const calls: string[] = [];
    let t = Date.parse("2026-09-22T14:00:00+09:00");
    const p = new TossProvider(fakeFetch(calls), null, () => new Date(t));
    const m = await p.getMany(["035420", "tsla", "ZZZZ"]);
    expect([...m.keys()]).toEqual(["035420", "TSLA"]);
    expect(m.get("035420")).toMatchObject({ price: 201500, volume: 1050258 });
    expect(m.get("TSLA")).toMatchObject({ price: 376.31 });
    const priceCalls = () => calls.filter((c) => c.includes("/v3/stock-prices?")).length;
    expect(priceCalls()).toBe(1);
    expect(calls.at(-1)).toContain(encodeURIComponent("A035420,US20100629001"));
    t += 1000;
    await p.getMany(["035420", "TSLA", "ZZZZ"]);
    expect(priceCalls()).toBe(1); // 캐시
    t += 2000;
    await p.getMany(["035420", "TSLA", "ZZZZ"]);
    expect(priceCalls()).toBe(2);
  });

  it("봉은 오래된 순으로 정렬되고 날짜는 거래소 현지 날짜다", async () => {
    const s = await new TossProvider(fakeFetch(), null, NOW).getCandles("035420", "W", 2);
    expect(s.candles.map((c) => c.date)).toEqual(["2026-09-21", "2026-09-22"]);
    expect(s.candles[1]).toEqual({ date: "2026-09-22", open: 198200, high: 203500, low: 198200, close: 201500, volume: 1050258 });
    const us = await new TossProvider(fakeFetch(), null, NOW).getCandles("TSLA", "M", 5);
    expect(us.candles.map((c) => c.date)).toEqual(["2026-09-21", "2026-09-22"]);
  });

  it("모르는 티커나 검색 장애는 ProviderError", async () => {
    await expect(new TossProvider(fakeFetch(), null, NOW).getQuote("ZZZZ")).rejects.toBeInstanceOf(ProviderError);
    await expect(new TossProvider(fakeFetch([], { failSearch: true }), null, NOW).search("테슬라", 5)).rejects.toBeInstanceOf(ProviderError);
  });

  it("검색 체인은 앞 소스가 실패하거나 비면 다음 소스로 간다", async () => {
    const yahoo = new FakeSearchProvider([{ code: "TSLA", name: "Tesla, Inc.", market: "NASDAQ", isinCode: null, groupCode: "ST" }]);
    const chain = new StockSearchChain([new TossProvider(fakeFetch([], { failSearch: true })), yahoo]);
    expect((await chain.search("tesla", 5))[0]!.name).toBe("Tesla, Inc.");
    const chain2 = new StockSearchChain([new TossProvider(fakeFetch()), yahoo]);
    expect((await chain2.search("없는것", 5))[0]!.name).toBe("Tesla, Inc."); // 토스 결과 없음 → yahoo
    expect((await chain2.search("테슬라", 5))[0]!.name).toBe("테슬라");
  });
});

describe("분봉", () => {
  it("토스 웹 분봉은 min:N 경로로 받고 time 을 붙여 시각순으로 돌려준다", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          result: {
            candles: [
              { dt: "2026-09-23T10:30:00+09:00", open: 284000, high: 284500, low: 283500, close: 283500, volume: 248364 },
              { dt: "2026-09-23T10:25:00+09:00", open: 284500, high: 284500, low: 283750, close: 284000, volume: 268872 },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const s = await new TossProvider(fetchFn, null, NOW).getCandles("035420", "5m", 10);
    expect(calls[0]).toContain("/api/v1/c-chart/kr-s/A035420/min:5?count=10");
    expect(s.candles.map((c) => c.time)).toEqual(["2026-09-23T10:25:00+09:00", "2026-09-23T10:30:00+09:00"]);
    expect(s.candles[0]).toMatchObject({ date: "2026-09-23", open: 284500, close: 284000 });
  });
});
