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

  it("일괄 시세가 나가 있는 동안 같은 종목을 물으면 그 응답을 같이 기다린다 (기준가가 비지 않게, 리뷰 M2)", async () => {
    const calls: string[] = [];
    const base = fakeFetch(calls);
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/v3/stock-prices?")) await new Promise((r) => setTimeout(r, 30));
      return base(input, init);
    }) as typeof fetch;
    const p = new TossProvider(slow, null, () => new Date("2026-09-22T14:00:00+09:00"));
    const [many, bases, again] = await Promise.all([p.getMany(["035420", "TSLA"]), p.baseMany(["035420"]), p.getMany(["035420"])]);
    expect(many.size).toBe(2);
    expect(bases.get("035420")).toBe(197900);
    expect(again.get("035420")?.price).toBe(201500);
    expect(calls.filter((c) => c.includes("/v3/stock-prices?")).length).toBe(1);
  });

  it("basePrice: 일괄 시세에서 받은 기준가를 1분 동안 요청 없이 쓴다", async () => {
    const calls: string[] = [];
    let t = Date.parse("2026-09-22T14:00:00+09:00");
    const p = new TossProvider(fakeFetch(calls), null, () => new Date(t));
    await p.getMany(["035420", "TSLA"]);
    const priceCalls = () => calls.filter((c) => c.includes("/v3/stock-prices?")).length;
    expect(await p.basePrice("035420")).toBe(197900);
    expect(priceCalls()).toBe(1); // 일괄 시세 때 받은 값
    t += 61_000;
    expect(await p.basePrice("035420")).toBe(197900);
    expect(priceCalls()).toBe(2); // 1분이 지나면 다시 받는다
    expect(await p.basePrice("ZZZZ")).toBeNull();
  });

  it("basePrice: 토스 웹이 실패하면 다음 거래 시작 전까지 마지막 기준가를 쓰고, 30초 동안 다시 부르지 않으며, 동시 요청은 하나로 합친다", async () => {
    let fail = false;
    let calls = 0;
    let t = Date.parse("2026-09-23T10:00:00+09:00");
    const fetchFn = (async (url: string) => {
      if (!url.includes("/v3/stock-prices")) return new Response("{}", { status: 404 });
      calls++;
      if (fail) return new Response("{}", { status: 503 });
      const body = { result: [{ productCode: "A005930", base: 276500, close: 286500, nextTradingStart: "2026-09-24T08:00:00+09:00" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const p = new TossProvider(fetchFn, null, () => new Date(t));
    expect(await p.basePrice("005930")).toBe(276500);
    expect(calls).toBe(1);
    t += 61_000;
    fail = true;
    expect(await p.basePrice("005930")).toBe(276500); // 새로 받기 실패 → 같은 거래일의 마지막 값
    expect(calls).toBe(2);
    t += 5_000;
    expect(await p.basePrice("005930")).toBe(276500);
    expect(calls).toBe(2); // 실패 뒤 30초 동안은 부르지 않는다
    t = Date.parse("2026-09-24T08:00:30+09:00");
    expect(await p.basePrice("005930")).toBeNull(); // 다음 거래 시작이 지나면 옛 기준가는 쓰지 않는다
    fail = false;
    t += 60_000;
    const before = calls;
    expect(await Promise.all([p.basePrice("005930"), p.basePrice("005930")])).toEqual([276500, 276500]);
    expect(calls - before).toBe(1);
    // 토스 웹이 기준가를 주지 않는 코드(ETN 등)는 10분 동안 다시 묻지 않는다
    const n = calls;
    expect(await p.basePrice("570051")).toBeNull();
    expect(await p.basePrice("570051")).toBeNull();
    expect(calls - n).toBe(1);
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

describe("토스 표시 환율", () => {
  it("closeKrw / close 의 중앙값을 환율로 쓰고 1분 캐시한다", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ result: [
          { productCode: "US19801212001", close: 340.31, closeKrw: 462821 },
          { productCode: "US20100629001", close: 378.83, closeKrw: 515208 },
          { productCode: "US19990122001", close: 180, closeKrw: 244800 },
        ] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const p = new TossProvider(fetchFn, null, NOW);
    expect(await p.usdKrw()).toBe(1360);
    await p.usdKrw();
    expect(calls).toBe(1);
  });
});

// ── 버그 점검 BH-08: 토스 웹 환율이 한 번 성공한 뒤 영원히 옛 값으로 남아 토스 Open API·네이버 환율로 넘어가지 않음 ──────
describe("토스 표시 환율이 오래되면 다음 소스로 (BH-08)", () => {
  it("새로 받지 못한 마지막 값은 5분까지만 쓰고, 그 뒤엔 null 이라 토스 Open API → 네이버 순서로 넘어간다", async () => {
    const { NaverFundamentals } = await import("../src/providers/market/fundamentals.js");
    let t = Date.parse("2026-09-25T09:00:00+09:00");
    let web: "up" | "down" | "empty" = "up";
    const tossFetch = (async () => {
      if (web === "down") return new Response("blocked", { status: 403 });
      const rows = web === "empty" ? [] : [{ productCode: "US19801212001", close: 100, closeKrw: 138000 }, { productCode: "US20100629001", close: 200, closeKrw: 276000 }, { productCode: "US19990122001", close: 50, closeKrw: 69000 }];
      return new Response(JSON.stringify({ result: rows }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const toss = new TossProvider(tossFetch, null, () => new Date(t));
    expect(await toss.usdKrw()).toBe(1380);
    web = "down";
    t += 2 * 60_000;
    expect(await toss.usdKrw()).toBe(1380); // 잠깐 실패하면 마지막 값 (출처가 오락가락하지 않게)
    web = "empty";
    t += 2 * 60_000;
    expect(await toss.usdKrw()).toBe(1380);
    web = "down";
    t += 2 * 60_000;
    expect(await toss.usdKrw()).toBeNull();

    // providers/index.ts 처럼 이어 붙인다: 토스 웹 → 토스 Open API 매매기준율 → 네이버
    let openApi: number | null = 1411;
    let naverCalls = 0;
    const naverFetch = (async () => {
      naverCalls++;
      return new Response(JSON.stringify({ exchangeInfo: { closePrice: "1,412.50" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const f = new NaverFundamentals(naverFetch, () => new Date(t));
    f.fxPrimary = async () => (await toss.usdKrw()) ?? openApi;
    t += 60 * 60_000; // 한 시간째 토스 웹 장애
    expect(await f.usdKrw()).toBe(1411);
    openApi = null;
    t += 61_000;
    expect(await f.usdKrw()).toBe(1412.5);
    expect(naverCalls).toBe(1);
    web = "up";
    t += 61_000;
    expect(await f.usdKrw()).toBe(1380); // 토스 웹이 돌아오면 다시 토스 앱 환율
  });
});

// ── 버그 점검 BH-21: 토스 웹 차트는 한 번에 봉 450개까지 — 앱 기본값(일봉 800·1분봉 600)이 늘 HTTP 400 ──────
describe("토스 웹 봉 개수 한도 (BH-21)", () => {
  /** 실제 토스 웹처럼 count 가 450 을 넘으면 HTTP 400, 아니면 최신순 count 개 */
  function chartFetch(calls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const count = Number(new URL(url).searchParams.get("count"));
      if (count > 450) return new Response(JSON.stringify({ error: { statusCode: 400 } }), { status: 400 });
      const intraday = url.includes("/min:");
      const top = Date.parse("2026-09-22T06:00:00Z");
      const candles = Array.from({ length: count }, (_, i) => {
        const dt = intraday ? new Date(top - i * 60_000).toISOString() : `${new Date(top - i * 86_400_000).toISOString().slice(0, 10)}T00:00:00+09:00`;
        return { dt, open: 100, high: 101, low: 99, close: 100, volume: 10 };
      });
      return new Response(JSON.stringify({ result: { candles } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("450개보다 많이 청하면 450개로 줄여 받는다 — 일봉 800·1분봉 600 도 실패하지 않는다", async () => {
    const calls: string[] = [];
    const p = new TossProvider(chartFetch(calls), null, NOW);
    expect((await p.getCandles("035420", "D", 800)).candles.length).toBe(450);
    expect((await p.getCandles("035420", "1m", 600)).candles.length).toBe(450);
    expect((await p.getCandles("035420", "W", 260)).candles.length).toBe(260); // 한도 안이면 그대로
    expect(calls.map((c) => Number(new URL(c).searchParams.get("count")))).toEqual([450, 450, 260]);
  });
});

// ── 버그 점검 BH-61: 한국 낮(미국 주간거래)의 토스 웹 미국 가격을 '정규장'이라고 적음 ──────
describe("토스 웹 미국 시세의 가격 기준 (BH-61)", () => {
  /** 마지막 일봉 날짜만 바꾼 차트 (토스는 뉴욕 20:00 부터 다음 거래일 봉을 새로 연다). null 이면 차트 장애 */
  function withLatest(latest: string | null): typeof fetch {
    const base = fakeFetch();
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/c-chart/us-s/US20100629001/")) {
        if (!latest) return new Response("nope", { status: 500 });
        const candles = [{ ...CHART_US.candles[0]!, dt: `${latest}T00:00:00-04:00` }, ...CHART_US.candles.slice(1)];
        return new Response(JSON.stringify({ result: { ...CHART_US, candles } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }) as typeof fetch;
  }
  const basis = async (now: string, latest: string | null) => (await new TossProvider(withLatest(latest), null, () => new Date(now)).getQuote("TSLA")).priceBasis;

  it("한국 낮(뉴욕 20:00~04:00)에 다음 거래일 봉이 열려 있으면 '주간거래', 프리마켓이면 '최근 체결(시간외 포함)'", async () => {
    expect(await basis("2026-09-25T11:19:00+09:00", "2026-09-25")).toBe("주간거래"); // 뉴욕 9/24 22:19
    expect(await basis("2026-09-25T15:30:00+09:00", "2026-09-25")).toBe("주간거래"); // 뉴욕 9/25 02:30
    expect(await basis("2026-09-25T19:00:00+09:00", "2026-09-25")).toBe("최근 체결(시간외 포함)"); // 뉴욕 9/25 06:00 프리마켓
  });

  it("정규장 중·정규장이 끝난 뒤(애프터마켓 가격은 afterMarket 으로 따로)·주말은 '정규장'", async () => {
    expect(await basis("2026-09-25T23:30:00+09:00", "2026-09-25")).toBe("정규장"); // 뉴욕 10:30
    expect(await basis("2026-09-25T06:30:00+09:00", "2026-09-24")).toBe("정규장"); // 뉴욕 9/24 17:30 애프터마켓
    expect(await basis("2026-09-26T14:00:00+09:00", "2026-09-25")).toBe("정규장"); // 토요일
    expect(await basis("2026-09-25T11:19:00+09:00", "2026-09-24")).toBe("정규장"); // 주간거래 체결이 없는 종목 (새 봉이 없음)
  });

  it("봉을 받지 못해 모르면 공식 API 와 같은 '최근 체결(시간외 포함)'", async () => {
    expect(await basis("2026-09-25T11:19:00+09:00", null)).toBe("최근 체결(시간외 포함)");
  });
});
