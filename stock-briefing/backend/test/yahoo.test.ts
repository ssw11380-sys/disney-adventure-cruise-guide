import { describe, expect, it } from "vitest";
import { YahooProvider, yahooSymbol } from "../src/providers/market/yahoo.js";
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

  it("가격이 정규장 종가면 등락·전일 종가도 정규장 기준 (시간외 포함 fulldayChange 를 붙이지 않는다) (BH-22)", async () => {
    // 2026-09-24 TSLA 실측: 정규장 377.94, 전일 종가 380.12. fulldayChange 는 시간외 가격(379.68) 기준이라 -0.44
    const at = (iso: string) => Date.parse(iso) / 1000;
    const tsla = {
      chart: {
        result: [
          {
            meta: { currency: "USD", exchangeTimezoneName: "America/New_York", regularMarketPrice: 377.94, regularMarketTime: at("2026-09-24T20:00:00Z"), regularMarketChangePercent: -0.574, fulldayPrice: 379.68, fulldayChange: -0.44, fulldayChangePercent: -0.116 },
            timestamp: [at("2026-09-22T13:30:00Z"), at("2026-09-23T13:30:00Z"), at("2026-09-24T13:30:00Z")],
            indicators: { quote: [{ open: [378, 379, 380], high: [381, 382, 383], low: [376, 377, 376], close: [378.9, 380.12, 377.94], volume: [1, 2, 3] }] },
          },
        ],
      },
    };
    const q = await new YahooProvider(fakeFetch(() => tsla)).getQuote("TSLA");
    expect(q.price).toBe(377.94);
    expect(q.prevClose).toBe(380.12);
    expect(q.change).toBe(-2.18);
    expect(q.changeRate).toBe(-0.57);

    // 정규장 -3% 뒤 시간외 +8%: 전일보다 낮은 정규장 가격 옆에 상승이 붙으면 안 된다
    const flip = fakeFetch(() => chartResponse({ currency: "USD", regularMarketPrice: 97, fulldayPrice: 104.76, fulldayChange: 4.76, fulldayChangePercent: 4.76 }, [99, 100, 97]));
    const f = await new YahooProvider(flip).getQuote("SOFI");
    expect(f.prevClose).toBe(100);
    expect(f.change).toBe(-3);
    expect(f.changeRate).toBe(-3);
  });

  it("클래스 주식(BRK.B·BF.B)은 Yahoo 형식(BRK-B)으로 조회한다 (BH-62)", async () => {
    const urls: string[] = [];
    const fetchFn = fakeFetch((url) => {
      urls.push(url);
      return url.includes("/chart/BRK.B?") || url.includes("/chart/BF.B?")
        ? { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }
        : chartResponse({ currency: "USD", regularMarketPrice: 505.18 }, [500, 505.18]);
    });
    const y = new YahooProvider(fetchFn);
    expect((await y.getQuote("BRK.B")).price).toBe(505.18);
    expect((await y.getCandles("BF.B", "D", 10)).candles.length).toBeGreaterThan(0);
    expect(urls[0]).toContain("/chart/BRK-B?");
    expect(urls[1]).toContain("/chart/BF-B?");
    expect(yahooSymbol("BRK.B", "NYSE")).toBe("BRK-B");
    expect(yahooSymbol("BRK-B", "NYSE")).toBe("BRK-B");
    expect(yahooSymbol("AAPL", "NASDAQ")).toBe("AAPL");
    expect(yahooSymbol("000660", "KOSPI")).toBe("000660.KS");
  });

  describe("주봉·월봉 (BH-71)", () => {
    // Yahoo 동작 흉내: 1wk/1mo 는 끝에 마지막 체결 시각(16:00:01 ET)으로 찍은 하루치 live 행을 따로 붙이고,
    // range=max&interval=1mo 는 상장 기간에 따라 주봉(1wk)으로 준다. 1d 는 요청한 대로 일봉.
    const LIVE = Date.parse("2026-09-24T20:00:01Z") / 1000;
    const days: number[] = [];
    for (let t = Date.parse("2021-10-01T13:30:00Z"); t <= Date.parse("2026-09-24T13:30:00Z"); t += 86_400_000) {
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6) days.push(t / 1000);
    }
    const closeAt = (i: number) => Math.round((10 + i * 0.01) * 100) / 100;
    const reply = (granularity: string, ts: number[], closes: number[]) => ({
      chart: {
        result: [
          {
            meta: { currency: "USD", exchangeTimezoneName: "America/New_York", dataGranularity: granularity, regularMarketPrice: closes.at(-1) },
            timestamp: ts,
            indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: ts.map(() => 1000) }] },
          },
        ],
      },
    });
    const weekly = () => {
      const ts: number[] = [];
      const closes: number[] = [];
      days.forEach((t, i) => {
        if (new Date(t * 1000).getUTCDay() === 1 || i === 0) {
          ts.push(t - 34_200); // 월요일 00:00 ET (04:00Z)
          closes.push(closeAt(i));
        } else closes[closes.length - 1] = closeAt(i);
      });
      return reply("1wk", [...ts, LIVE], [...closes, closeAt(days.length - 1)]);
    };
    const fetchFn = fakeFetch((url) => {
      const interval = /interval=(\w+)/.exec(url)?.[1];
      const range = /range=(\w+)/.exec(url)?.[1];
      if (interval === "1d") return reply("1d", [...days, LIVE], [...days.map((_, i) => closeAt(i)), closeAt(days.length - 1)]);
      if (interval === "1wk" || (interval === "1mo" && range === "max")) return weekly();
      const ts: number[] = [];
      const closes: number[] = [];
      days.forEach((t, i) => {
        const d = new Date(t * 1000);
        if (d.getUTCDate() <= 3 && (ts.length === 0 || new Date(ts.at(-1)! * 1000).getUTCMonth() !== d.getUTCMonth())) {
          ts.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 4) / 1000);
          closes.push(closeAt(i));
        } else if (closes.length) closes[closes.length - 1] = closeAt(i);
      });
      return reply("1mo", [...ts, LIVE], [...closes, closeAt(days.length - 1)]);
    });
    const weekKey = (date: string) => {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };

    it("월봉은 달마다 한 봉 (주봉·분기봉이 아니고), 마지막 달도 한 봉", async () => {
      const m = (await new YahooProvider(fetchFn).getCandles("IONQ", "M", 120)).candles;
      const months = m.map((c) => c.date.slice(0, 7));
      expect(new Set(months).size).toBe(months.length);
      expect(months[0]).toBe("2021-10");
      expect(months.at(-1)).toBe("2026-09");
      expect(months).toHaveLength(60);
      expect(m.at(-1)!.close).toBe(closeAt(days.length - 1));
      expect(m.every((c) => c.date <= "2026-09-24")).toBe(true);
    });

    it("주봉은 주마다 한 봉: 끝의 live 행이 같은 주에 봉을 하나 더 만들지 않고, 날짜가 다음 날(서울)로 밀리지 않는다", async () => {
      const w = (await new YahooProvider(fetchFn).getCandles("IONQ", "W", 260)).candles;
      const weeks = w.map((c) => weekKey(c.date));
      expect(new Set(weeks).size).toBe(weeks.length);
      expect(weeks.at(-1)).toBe("2026-09-21");
      expect(w.every((c) => c.date <= "2026-09-24")).toBe(true);
      expect(w.at(-1)!.close).toBe(closeAt(days.length - 1));
    });

    it("일봉 날짜는 거래소 현지 날짜 (미국 종목의 마지막 봉이 서울 날짜로 다음 날이 되지 않는다)", async () => {
      const d = (await new YahooProvider(fetchFn).getCandles("IONQ", "D", 5)).candles;
      expect(d.map((c) => c.date)).toEqual(["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
    });
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
