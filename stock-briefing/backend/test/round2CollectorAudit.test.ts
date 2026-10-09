import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import type { FinancialsProvider } from "../src/providers/dart/types.js";
import { MarketCalendar } from "../src/providers/market/calendar.js";
import { NaverFundamentals } from "../src/providers/market/fundamentals.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeGenerator, FakeQuoteProvider, fakeProviders } from "./helpers.js";

const AT = Date.parse("2026-12-28T09:30:00+09:00");
const stock = { code: "005930", name: "삼성전자", market: "KOSPI" };
const missingPbr = "PER/PBR(현재 시세 소스가 제공하지 않음)";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fundBody = (pbr: number) => ({ totalInfos: [{ code: "per", value: "99" }, { code: "pbr", value: String(pbr) }] });
const partialFinancials: FinancialsProvider = {
  name: "부분 재무",
  getCompany: async () => ({ corpCode: "fake", name: stock.name, ceo: null, industryCode: null, established: null, homepage: null, address: null, fiscalMonth: null }),
  getAnnualFinancials: async () => [{ year: 2025, basis: "CFS", revenue: 100, operatingIncome: 0, netIncome: null, totalAssets: 20, totalLiabilities: 0, totalEquity: 20 }],
  getDividends: async () => [{ year: 2025, cashDividendPerShare: 0, dividendYieldPct: 0, payoutRatioPct: null }],
  getDisclosures: async () => [],
};
function quotesWith(per: number | null, pbr: number | null) {
  const quotes = new FakeQuoteProvider("고정 시세");
  const original = quotes.getQuote.bind(quotes);
  quotes.getQuote = async code => ({ ...await original(code), per, pbr });
  return quotes;
}
function collector(quotes: FakeQuoteProvider, fundamentals: NaverFundamentals, now = () => new Date(AT)) {
  return new DataCollector({ ...fakeProviders({ quotes, fundamentals, financials: partialFinancials, calendar: new MarketCalendar(async () => json({}, 500), now) }), now });
}

describe("2차 독립 검증: 보강 뒤의 PBR 판정", () => {
  it("PBR이 보강되면 거짓 누락 없이 기존 PER·시세·부분 재무를 보존하고 캐시 조회를 추가하지 않는다", async () => {
    for (const pbr of [2, 0]) {
      let fetches = 0;
      const f = new NaverFundamentals(async () => { fetches++; return json(fundBody(pbr)); }, () => new Date(AT));
      const quotes = quotesWith(-5, null);
      const c = collector(quotes, f);
      const first = await c.collectAnalysis(stock, "value");
      const second = await c.collectAnalysis(stock, "value");
      expect(first.quote).toMatchObject({ per: -5, pbr, price: 100_000, source: "고정 시세", asOf: "2026-09-22T09:00:00+09:00" });
      expect(first.missing).not.toContain(missingPbr);
      expect(first.ratios).toEqual({ roePct: null, debtToEquityPct: 0, operatingMarginPct: 0 });
      expect(first.financials).toEqual(await partialFinancials.getAnnualFinancials(stock.code, 5));
      expect(first.dividends).toEqual(await partialFinancials.getDividends(stock.code, 3));
      expect(second).toEqual(first);
      expect(fetches).toBe(1);
      expect(quotes.calls).toBe(4);
    }
  });

  it("현재 시세에 PER과 PBR이 있으면 보강을 새로 요청하지 않고 0도 그대로 둔다", async () => {
    let fetches = 0;
    const f = new NaverFundamentals(async () => { fetches++; return json(fundBody(9)); }, () => new Date(AT));
    const result = await collector(quotesWith(15, 0), f).collectAnalysis(stock, "value");
    expect(result.quote).toMatchObject({ per: 15, pbr: 0, price: 100_000 });
    expect(result.missing).not.toContain(missingPbr);
    expect(fetches).toBe(0);
  });

  it("보강 실패 뒤 저장된 부족 안내는 캐시에서 그대로 읽고 명시 갱신 때 회복한 자료와 함께 바뀐다", async () => {
    let clock = AT;
    let unavailable = true;
    let fetches = 0;
    const now = () => new Date(clock);
    const fundamentals = new NaverFundamentals(async () => { fetches++; return unavailable ? json({}, 503) : json(fundBody(2)); }, now);
    const quotes = quotesWith(15, null);
    const generator = new FakeGenerator();
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ quotes, generator, fundamentals, financials: partialFinancials, calendar: new MarketCalendar(async () => json({}, 500), now) }), logger: false, enableScheduler: false, now });
    try {
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      const path = "/api/stocks/005930/analysis/value";
      const first = await app.inject({ method: "GET", url: path });
      expect(first.statusCode).toBe(200);
      expect(first.json().missing).toContain(missingPbr);
      expect(generator.requests[0]!.user).toContain('"pbr": null');
      clock += 121_000; unavailable = false;
      const cached = await app.inject({ method: "GET", url: `${path}?refresh=false` });
      expect(cached.json()).toMatchObject({ id: first.json().id, cached: true, missing: first.json().missing });
      expect(fetches).toBe(1); expect(quotes.calls).toBe(2); expect(generator.requests).toHaveLength(1);
      const next = await app.inject({ method: "GET", url: `${path}?refresh=1` });
      expect(next.statusCode).toBe(200);
      expect(next.json().id).not.toBe(first.json().id);
      expect(next.json().missing).not.toContain(missingPbr);
      expect(generator.requests[1]!.user).toContain('"pbr": 2');
      expect(generator.requests[1]).toMatchObject({ system: generator.requests[0]!.system, maxTokens: 4096, effort: "high", label: "value_analysis:005930" });
      expect(fetches).toBe(2); expect(quotes.calls).toBe(4); expect(generator.requests).toHaveLength(2);
      const rows = await db.selectFrom("analyses").select(["missing_data", "data_snapshot"]).orderBy("id").execute();
      expect(JSON.parse(rows[0]!.data_snapshot).quote.pbr).toBeNull();
      expect(JSON.parse(rows[0]!.missing_data)).toContain(missingPbr);
      expect(JSON.parse(rows[1]!.data_snapshot).quote.pbr).toBe(2);
      expect(JSON.parse(rows[1]!.missing_data)).not.toContain(missingPbr);
    } finally { await app.close(); await db.destroy(); }
  });

  it("시세·재무·배당·공시가 함께 실패하면 각 부족을 고정 순서로 알리고 없는 비율을 0으로 만들지 않는다", async () => {
    let fetches = 0;
    const fundamentals = new NaverFundamentals(async () => { fetches++; return json(fundBody(2)); }, () => new Date(AT));
    const fail = async (): Promise<never> => { throw new Error("검증용 자료 거절"); };
    const financials = { ...partialFinancials, getAnnualFinancials: fail, getDividends: fail, getDisclosures: fail };
    const result = await new DataCollector({ ...fakeProviders({ quotes: new FakeQuoteProvider("고정 시세", { fail: true }), fundamentals, financials }), now: () => new Date(AT) }).collectAnalysis(stock, "value");
    expect(result.quote).toBeNull(); expect(result.financials).toBeNull(); expect(result.ratios).toBeNull();
    expect(result.missing).toEqual(["현재가", "일봉", "재무제표", "배당", "공시"]);
    expect(fetches).toBe(0);
  });
});

describe("2차 장기 사용 구조 관측", () => {
  it("5천 가짜 종목 조회 후 만료·반복·새 종목 조회의 캐시 키 잔류와 호출 수를 관측한다", async () => {
    let clock = AT;
    let fetches = 0;
    const f = new NaverFundamentals(async () => { fetches++; return json(fundBody(2)); }, () => new Date(clock));
    // 진단용 읽기만: 현재 Map 구조를 관측하며 캐시 정책 목표나 운영 메모리 한계를 임의로 정하지 않는다.
    const cache = (f as unknown as { cache: Map<string, { at: number; ttl: number }> }).cache;
    const started = performance.now();
    for (let index = 0; index < 5000; index++) await f.get(String(100000 + index), "KOSPI");
    const coldMs = performance.now() - started;
    expect(cache.size).toBe(5000); expect(fetches).toBe(5000);
    for (let index = 0; index < 100; index++) await f.get(String(100000 + index), "KOSPI");
    expect(fetches).toBe(5000);
    clock += 3_600_001;
    for (let index = 0; index < 10; index++) await f.get(String(100000 + index), "KOSPI");
    for (let index = 0; index < 100; index++) await f.get(String(105000 + index), "KOSPI");
    const expired = [...cache.values()].filter(entry => clock - entry.at >= entry.ttl).length;
    expect(cache.size).toBe(5100); expect(fetches).toBe(5110); expect(expired).toBe(4990);
    console.info(JSON.stringify({ audit: "가짜 재무 캐시 1회 관측", uniqueCodes: 5100, warmHits: 100, refreshedCodes: 10, cacheKeys: cache.size, expiredKeysRetained: expired, mockFetches: fetches, cold5000Ms: Math.round(coldMs), externalNetwork: false, heapMeasurement: "미실시" }));
  });
});
