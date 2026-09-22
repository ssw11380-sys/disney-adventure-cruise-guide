import { describe, expect, it } from "vitest";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { NaverFinanceProvider, parseNum } from "../src/providers/market/naver.js";
import { ProviderError } from "../src/lib/errors.js";
import { FakeQuoteProvider } from "./helpers.js";

/** 2026-09-22 실제 응답을 줄인 것 (NAVER, 장 마감 후 NXT 애프터마켓까지 끝난 상태) */
const POLLING = {
  pollingInterval: 70000,
  datas: [
    {
      itemCode: "035420",
      stockName: "NAVER",
      closePrice: "201,000",
      compareToPreviousClosePrice: "3,100",
      compareToPreviousPrice: { code: "2", text: "상승", name: "RISING" },
      fluctuationsRatio: "1.57",
      openPrice: "201,000",
      highPrice: "203,500",
      lowPrice: "200,000",
      accumulatedTradingVolume: "494,786",
      marketStatus: "CLOSE",
      localTradedAt: "2026-09-22T20:00:00+09:00",
      overMarketPriceInfo: {
        tradingSessionType: "AFTER_MARKET",
        overMarketStatus: "CLOSE",
        overPrice: "201,500",
        compareToPreviousPrice: { code: "2", text: "상승", name: "RISING" },
        compareToPreviousClosePrice: "3,600",
        fluctuationsRatio: "1.82",
        localTradedAt: "2026-09-22T20:00:00.000000+09:00",
        accumulatedTradingVolumeRaw: "554100",
      },
      marketValueFullRaw: "30570968169000",
      closePriceRaw: "201000",
      compareToPreviousClosePriceRaw: "3100",
      fluctuationsRatioRaw: "1.57",
      openPriceRaw: "201000",
      highPriceRaw: "203500",
      lowPriceRaw: "200000",
      accumulatedTradingVolumeRaw: "494786",
    },
  ],
};

const INTEGRATION = {
  itemCode: "035420",
  totalInfos: [
    { code: "lastClosePrice", key: "전일", value: "197,900" },
    { code: "highPriceOf52Weeks", key: "52주 최고", value: "308,500" },
    { code: "lowPriceOf52Weeks", key: "52주 최저", value: "181,100" },
    { code: "per", key: "PER", value: "15.60배" },
    { code: "eps", key: "EPS", value: "12,885원" },
    { code: "pbr", key: "PBR", value: "1.02배" },
    { code: "bps", key: "BPS", value: "197,363원" },
  ],
};

const CHART = [
  { localDate: "20260918", closePrice: 197500.0, openPrice: 201500.0, highPrice: 202000.0, lowPrice: 196100.0, accumulatedTradingVolume: 1298902 },
  { localDate: "20260921", closePrice: 198400.0, openPrice: 198400.0, highPrice: 198700.0, lowPrice: 196100.0, accumulatedTradingVolume: 616968 },
  { localDate: "20260922", closePrice: 201000.0, openPrice: 201000.0, highPrice: 203500.0, lowPrice: 200000.0, accumulatedTradingVolume: 494786 },
];

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.includes(prefix)) return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const ROUTES = {
  "polling.finance.naver.com/api/realtime/domestic/stock/035420": POLLING,
  "m.stock.naver.com/api/stock/035420/integration": INTEGRATION,
  "api.stock.naver.com/chart/domestic/item/035420/day": CHART,
};

describe("NaverFinanceProvider", () => {
  it("parseNum 은 네이버의 문자열 숫자 표기를 읽는다", () => {
    expect(parseNum("201,000")).toBe(201000);
    expect(parseNum("15.60배")).toBe(15.6);
    expect(parseNum("12,885원")).toBe(12885);
    expect(parseNum("-1.57")).toBe(-1.57);
    expect(parseNum("")).toBeNull();
    expect(parseNum(undefined)).toBeNull();
  });

  it("정규장 종가와 NXT 애프터마켓 가격을 함께 준다", async () => {
    const p = new NaverFinanceProvider(fakeFetch(ROUTES), () => new Date("2026-09-22T23:30:00+09:00"));
    const q = await p.getQuote("035420");
    expect(q.source).toBe("naver");
    expect(q.currency).toBe("KRW");
    expect(q.price).toBe(201000);
    expect(q.change).toBe(3100);
    expect(q.changeRate).toBe(1.57);
    expect(q.prevClose).toBe(197900);
    expect(q.volume).toBe(494786);
    expect(q.marketCap).toBe(30570968169000);
    expect(q.per).toBe(15.6);
    expect(q.bps).toBe(197363);
    expect(q.high52w).toBe(308500);
    expect(q.low52w).toBe(181100);
    expect(q.afterMarket).toEqual({
      venue: "NXT",
      session: "AFTER_MARKET",
      status: "CLOSE",
      price: 201500,
      change: 3600,
      changeRate: 1.82,
      volume: 554100,
      asOf: "2026-09-22T20:00:00.000+09:00",
    });
  });

  it("하락 구분 코드면 등락에 음수 부호를 붙인다", async () => {
    const down = structuredClone(POLLING);
    const d = down.datas[0]!;
    d.compareToPreviousPrice = { code: "5", text: "하락", name: "FALLING" };
    d.compareToPreviousClosePriceRaw = "2000";
    d.fluctuationsRatioRaw = "-0.99"; // 비율은 부호가 붙어 오는 경우도 있다
    const p = new NaverFinanceProvider(fakeFetch({ ...ROUTES, "polling.finance.naver.com/api/realtime/domestic/stock/035420": down }));
    const q = await p.getQuote("035420");
    expect(q.change).toBe(-2000);
    expect(q.changeRate).toBe(-0.99);
  });

  it("지표 API 가 실패해도 현재가는 낸다", async () => {
    const p = new NaverFinanceProvider(fakeFetch({ "polling.finance.naver.com": POLLING, "api.stock.naver.com": CHART }));
    const q = await p.getQuote("035420");
    expect(q.price).toBe(201000);
    expect(q.per).toBeNull();
    expect(q.prevClose).toBe(197900); // price - change 로 계산
  });

  it("없는 종목은 ProviderError", async () => {
    const p = new NaverFinanceProvider(fakeFetch({ "polling.finance.naver.com": { datas: [] }, "m.stock.naver.com": {} }));
    await expect(p.getQuote("999999")).rejects.toBeInstanceOf(ProviderError);
  });

  it("일봉을 날짜 오름차순으로 count 개만 준다", async () => {
    const calls: string[] = [];
    const p = new NaverFinanceProvider(fakeFetch(ROUTES, calls), () => new Date("2026-09-22T23:30:00+09:00"));
    const s = await p.getCandles("035420", "D", 2);
    expect(s.source).toBe("naver");
    expect(s.candles.map((c) => c.date)).toEqual(["2026-09-21", "2026-09-22"]);
    expect(s.candles[1]).toEqual({ date: "2026-09-22", open: 201000, high: 203500, low: 200000, close: 201000, volume: 494786 });
    expect(calls[0]).toContain("/035420/day?startDateTime=2026");
    expect(calls[0]).toContain("endDateTime=202609222359");
  });

  it("미국 티커는 supports=false 라 체인에서 건너뛰고 다음 소스로 간다", async () => {
    const naver = new NaverFinanceProvider(fakeFetch(ROUTES));
    const yahoo = new FakeQuoteProvider("yahoo");
    const chain = new QuoteProviderChain([naver, yahoo]);
    const q = await chain.getQuote("TSLA");
    expect(q.source).toBe("yahoo");
    expect(yahoo.calls).toBe(1);
    const kr = await chain.getQuote("035420");
    expect(kr.source).toBe("naver");
  });
});
