import { describe, expect, it } from "vitest";
import { MarketIndices } from "../src/providers/market/indices.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("MarketIndices", () => {
  it("지수와 환율을 모으고, 실패한 항목만 빼며, 음수 등락률 부호를 맞춘다", async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      if (url.includes("KOSPI")) return json({ stockName: "코스피", closePrice: "7,026.35", compareToPreviousClosePrice: "8.44", fluctuationsRatio: "0.12", marketStatus: "OPEN", localTradedAt: "2026-09-23T11:18:00+09:00" });
      if (url.includes(".DJI")) return json({ closePrice: "51,863.69", compareToPreviousClosePrice: "-185.14", fluctuationsRatio: "0.36", marketStatus: "CLOSE" });
      if (url.includes("FX_USDKRW")) return json({ exchangeInfo: { closePrice: "1,352.10", fluctuations: "-3.40", fluctuationsRatio: "-0.25" } });
      if (url.includes("FX_JPYKRW")) return json({ exchangeInfo: { closePrice: "858.01", fluctuations: "-2.90", fluctuationsRatio: "-0.34" } });
      return new Response("x", { status: 500 });
    }) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => new Date("2026-09-23T02:20:00Z"));
    const list = await m.list();
    expect(list.map((i) => i.code)).toEqual(["KOSPI", "DJI", "USDKRW", "JPYKRW"]);
    expect(list[0]).toMatchObject({ name: "코스피", value: 7026.35, change: 8.44, changeRate: 0.12, open: true });
    expect(list[1]).toMatchObject({ change: -185.14, changeRate: -0.36, open: false });
    expect(list[2]).toMatchObject({ name: "원/달러", kind: "fx", value: 1352.1, change: -3.4, changeRate: -0.25 });
    expect(list[3]).toMatchObject({ name: "원/100엔", kind: "fx", value: 858.01 });
    expect(list[0]!.kind).toBe("index");
    const before = calls;
    await m.list();
    expect(calls).toBe(before); // 30초 캐시
  });
  describe("candles", () => {
    const NOW = () => new Date("2026-09-23T05:20:00Z"); // 14:20 KST

    it("국내 지수 분봉은 시·고·저·종이 있는 분 데이터를 서울 시각으로, 일봉은 기간 조회로 가져온다", async () => {
      const urls: string[] = [];
      const fetchFn = (async (url: string) => {
        urls.push(url);
        if (url.includes("/chart/domestic/index/KOSPI/minute?"))
          return json([
            { localDateTime: "20260923090000", currentPrice: 7144.02, openPrice: 7153.99, highPrice: 7153.99, lowPrice: 7144.02, accumulatedTradingVolume: 4038 },
            { localDateTime: "20260923090100", currentPrice: 7142.23, openPrice: 7139.08, highPrice: 7142.23, lowPrice: 7135.17, accumulatedTradingVolume: 2639 },
          ]);
        if (url.includes("/chart/domestic/index/KOSPI/day?"))
          return json([
            { localDate: "20260922", closePrice: 7017.91, openPrice: 6990.1, highPrice: 7030.5, lowPrice: 6980.2, accumulatedTradingVolume: 500 },
            { localDate: "20260923", closePrice: 7050.69, openPrice: 7153.99, highPrice: 7171.52, lowPrice: 7040.1, accumulatedTradingVolume: 300 },
          ]);
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, NOW);
      const min = await m.candles("kospi", "1m", 100);
      expect(min!.candles[0]).toEqual({ date: "2026-09-23", time: "2026-09-23T09:00:00+09:00", open: 7153.99, high: 7153.99, low: 7144.02, close: 7144.02, volume: 4038 });
      expect(urls[0]).toContain("startDateTime=202609160000&endDateTime=202609232359");
      const day = await m.candles("KOSPI", "D", 100);
      expect(day!.candles.map((c) => c.close)).toEqual([7017.91, 7050.69]);
      expect(urls[1]).toMatch(/\/day\?startDateTime=\d{8}0000&endDateTime=202609232359/);
      expect(await m.candles("NOPE", "D", 100)).toBeNull();
    });

    it("해외 지수 분봉은 당일 1분 시세(종가만)로 만들고 뉴욕 시각(서머타임) 오프셋을 붙이며, 5분봉으로 묶는다", async () => {
      const fetchFn = (async (url: string) => {
        if (url.includes("/chart/foreign/index/.IXIC?periodType=day"))
          return json({
            openPrice: 27161.197,
            // 직전 세션은 중간(12:14)부터만 온다: 첫 분의 누적 거래량을 그 분 거래량으로 치지 않는다
            lastPriceInfos: [
              { localDateTime: "20260921121400", currentPrice: 27013, accumulatedTradingVolume: 510453 },
              { localDateTime: "20260921121500", currentPrice: 27019, accumulatedTradingVolume: 512055 },
            ],
            priceInfos: [
              { localDateTime: "20260922093000", currentPrice: 27180, accumulatedTradingVolume: 100 },
              { localDateTime: "20260922093100", currentPrice: 27213, accumulatedTradingVolume: 160 },
              { localDateTime: "20260922093500", currentPrice: 27200, accumulatedTradingVolume: 200 },
            ],
          });
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, NOW);
      const all = (await m.candles("NASDAQ", "1m", 100))!.candles;
      expect(all.slice(0, 2).map((c) => [c.time, c.volume])).toEqual([
        ["2026-09-21T12:14:00-04:00", 0],
        ["2026-09-21T12:15:00-04:00", 1602],
      ]);
      const one = all.slice(2);
      // 당일 첫 봉 시가는 응답의 당일 시가 (밤사이 갭을 한 봉에 넣지 않는다)
      expect(one[0]).toEqual({ date: "2026-09-22", time: "2026-09-22T09:30:00-04:00", open: 27161.197, high: 27180, low: 27161.197, close: 27180, volume: 100 });
      expect(one[1]).toMatchObject({ open: 27180, close: 27213, high: 27213, low: 27180, volume: 60 });
      const five = (await m.candles("NASDAQ", "5m", 100))!.candles;
      expect(five.slice(-2).map((c) => [c.time, c.open, c.high, c.low, c.close])).toEqual([
        ["2026-09-22T09:30:00-04:00", 27161.197, 27213, 27161.197, 27213],
        ["2026-09-22T09:35:00-04:00", 27213, 27213, 27200, 27200],
      ]);
    });

    it("환율: 당일 고시 회차는 분봉으로 묶고, 일별 종가는 시가를 직전 종가로 채우며, 월봉은 주별을 묶는다", async () => {
      const fetchFn = (async (url: string) => {
        if (!url.includes("pricesByPeriod") || !url.includes("FX_CNYKRW")) return new Response("x", { status: 404 });
        const type = new URL(url).searchParams.get("scriptChartType");
        if (type === "day")
          return json({
            result: {
              openPrice: 202,
              priceInfos: [
                { localDateTime: "20260923090010", currentPrice: 202.1 },
                { localDateTime: "20260923090040", currentPrice: 201.9 },
                { localDateTime: "20260923090120", currentPrice: 202.3 },
              ],
            },
          });
        if (type === "areaYear")
          return json({
            result: {
              priceInfos: [
                { localDate: "20260921", closePrice: 203, openPrice: 0, highPrice: 203, lowPrice: 203 },
                { localDate: "20260922", closePrice: 202, openPrice: 0, highPrice: 202, lowPrice: 202 },
              ],
            },
          });
        if (type === "areaYearTen")
          return json({
            result: {
              priceInfos: [
                { localDate: "20260828", closePrice: 200, openPrice: 0, highPrice: 201, lowPrice: 199 },
                { localDate: "20260904", closePrice: 204, openPrice: 0, highPrice: 205, lowPrice: 200 },
                { localDate: "20260911", closePrice: 206, openPrice: 0, highPrice: 207, lowPrice: 203 },
              ],
            },
          });
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, NOW);
      const min = (await m.candles("CNYKRW", "1m", 100))!.candles;
      expect(min).toEqual([
        { date: "2026-09-23", time: "2026-09-23T09:00:00+09:00", open: 202, high: 202.1, low: 201.9, close: 201.9, volume: 0 },
        { date: "2026-09-23", time: "2026-09-23T09:01:00+09:00", open: 201.9, high: 202.3, low: 201.9, close: 202.3, volume: 0 },
      ]);
      const day = (await m.candles("CNYKRW", "D", 100))!.candles;
      expect(day[1]).toEqual({ date: "2026-09-22", open: 203, high: 203, low: 202, close: 202, volume: 0 });
      const month = (await m.candles("CNYKRW", "M", 100))!.candles;
      expect(month.map((c) => [c.date, c.close])).toEqual([
        ["2026-08-28", 200],
        ["2026-09-04", 206],
      ]);
    });

    it("조회가 실패하면 직전 캐시를 쓰고, 캐시가 없으면 던진다", async () => {
      let fail = false;
      const fetchFn = (async (url: string) => {
        if (fail) return new Response("x", { status: 503 });
        if (url.includes("/chart/foreign/index/.DJI/week?")) return json([{ localDate: "20260920", closePrice: 51863.69, openPrice: 51000, highPrice: 52000, lowPrice: 50900, accumulatedTradingVolume: 1 }]);
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      let now = new Date("2026-09-23T05:20:00Z");
      const m = new MarketIndices(fetchFn, () => now);
      await expect(m.candles("DJI", "D", 50)).rejects.toThrow("HTTP 404");
      expect((await m.candles("DJI", "W", 50))!.candles).toHaveLength(1);
      fail = true;
      now = new Date(now.getTime() + 60 * 60_000); // 캐시 만료 뒤 실패
      expect((await m.candles("DJI", "W", 50))!.candles).toHaveLength(1);
    });
  });
});
