import { describe, expect, it } from "vitest";
import { rangeQuery, YahooProvider, yahooSymbol } from "../src/providers/market/yahoo.js";
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

  it("직전 거래일 행이 비어(null) 그 전날 봉을 잡으면, Yahoo 등락률과 어긋나므로 등락률로 전일 종가를 되짚는다 (BH-22)", async () => {
    // 2026-09 BRK-B 실측처럼 하루치 행이 null 로 오는 경우: 09-22 가 비어 있고 정규장 거래일은 09-23
    const at = (iso: string) => Date.parse(iso) / 1000;
    const brk = (price: number, rate: number | undefined, close22: number | null) => ({
      chart: {
        result: [
          {
            meta: { currency: "USD", exchangeTimezoneName: "America/New_York", regularMarketPrice: price, regularMarketTime: at("2026-09-23T20:00:03Z"), regularMarketChangePercent: rate },
            timestamp: [at("2026-09-21T13:30:00Z"), at("2026-09-22T13:30:00Z"), at("2026-09-23T13:30:00Z")],
            indicators: { quote: [{ open: [502, close22, 505], high: [503, close22, 508], low: [501, close22, 504], close: [502.01, close22, price], volume: [1, close22, 3] }] },
          },
        ],
      },
    });
    // 실제 전일(09-22) 종가 504.65 → 507.17 은 +0.499%. 09-21 종가(502.01)와 비교하면 +1.03% 로 틀린다
    const q = await new YahooProvider(fakeFetch(() => brk(507.17, 0.499, null))).getQuote("BRK.B");
    expect(q.prevClose).toBeCloseTo(504.65, 1);
    expect(q.change).toBeCloseTo(2.52, 1);
    expect(q.changeRate).toBe(0.5);
    // 행이 다 있으면 봉 종가를 그대로 쓴다 (등락률로 되짚은 값의 반올림 오차 없이)
    const full = await new YahooProvider(fakeFetch(() => brk(507.17, 0.499, 504.65))).getQuote("BRK.B");
    expect(full.prevClose).toBe(504.65);
    expect(full.change).toBe(2.52);
    // 등락률이 없으면 직전 봉 그대로
    expect((await new YahooProvider(fakeFetch(() => brk(507.17, undefined, null))).getQuote("BRK.B")).prevClose).toBe(502.01);
    // 원화 종목을 등락률로 되짚으면 1원 단위
    const kr = fakeFetch(() => chartResponse({ currency: "KRW", regularMarketPrice: 285_500, regularMarketChangePercent: 3.255 }, [261_000, 285_500]));
    const k = await new YahooProvider(kr, async () => "KOSPI").getQuote("005930");
    expect(k.prevClose).toBe(276_500);
    expect(k.change).toBe(9_000);
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

    it("10년 넘는 봉은 range=max(일봉을 달래도 3mo 봉을 줌) 대신 기간(period1·period2)으로 받는다", async () => {
      expect(rangeQuery("M", 120)).toBe("range=10y");
      expect(rangeQuery("W", 260)).toBe("range=5y");
      expect(rangeQuery("D", 120)).toBe("range=1y");
      const now = Date.parse("2026-09-25T00:00:00Z");
      const q = new URLSearchParams(rangeQuery("M", 200, now));
      expect(Number(q.get("period2"))).toBe(now / 1000);
      expect(Number(q.get("period1"))).toBeLessThan(Date.parse("2010-02-01T00:00:00Z") / 1000);
      expect(rangeQuery("W", 1000, now)).toMatch(/^period1=\d+&period2=\d+$/);

      const long: number[] = [];
      for (let t = Date.parse("2006-01-02T14:30:00Z"); t <= Date.parse("2026-09-24T13:30:00Z"); t += 86_400_000) {
        const wd = new Date(t).getUTCDay();
        if (wd !== 0 && wd !== 6) long.push(t / 1000);
      }
      const urls: string[] = [];
      const maxFetch = fakeFetch((url) => {
        urls.push(url);
        if (url.includes("range=max")) return reply("3mo", [long[0]!], [10]); // AAPL 실측: range=max&interval=1d → 3mo
        return reply("1d", [...long, LIVE], [...long.map((_, i) => closeAt(i)), closeAt(long.length - 1)]);
      });
      const m = (await new YahooProvider(maxFetch).getCandles("AAPL", "M", 200)).candles;
      expect(urls.every((u) => !u.includes("range=max") && u.includes("period1="))).toBe(true);
      const months = m.map((c) => c.date.slice(0, 7));
      expect(months).toHaveLength(200);
      expect(new Set(months).size).toBe(200);
      expect(months[0]).toBe("2010-02");
      expect(months.at(-1)).toBe("2026-09");
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
