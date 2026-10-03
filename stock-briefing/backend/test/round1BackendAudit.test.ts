import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { MarketCalendar } from "../src/providers/market/calendar.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeGenerator, FakeQuoteProvider, fakeProviders } from "./helpers.js";

let app: FastifyInstance | undefined;
let db: Db | undefined;
const fixedNow = () => new Date("2026-12-28T09:30:00+09:00");
async function setup(generator: FakeGenerator, now = fixedNow, quotes?: FakeQuoteProvider) {
  db = await createMigratedDb(":memory:");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator, ...(quotes ? { quotes } : {}) }), logger: false, enableScheduler: false, now });
  await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  return app;
}
afterEach(async () => { await app?.close(); await db?.destroy(); app = undefined; db = undefined; });

describe("1차 서버 경계와 저장 실패 검증", () => {
  it("잘못된 갱신값과 중복 쿼리는 자료 수집이나 모델 생성 전에 거절한다", async () => {
    const generator = new FakeGenerator();
    const a = await setup(generator);
    const path = "/api/stocks/005930/analysis/company";
    for (const query of ["refresh=", "refresh=yes", "refresh=False", "refresh=2", "refresh=0&refresh=1", "requestId=valid-request-001&requestId=valid-request-002"]) {
      const response = await a.inject({ method: "GET", url: `${path}?${query}` });
      expect(response.statusCode, query).toBe(400);
    }
    expect(generator.requests).toHaveLength(0);
    expect(await db!.selectFrom("analyses").selectAll().execute()).toEqual([]);
  });

  it("실제 DB 저장 거절 뒤에는 이전 결과를 유지하고 같은 요청을 재생성하지 않으며 새 요청으로 회복한다", async () => {
    const generator = new FakeGenerator();
    const a = await setup(generator);
    const path = "/api/stocks/005930/analysis/company";
    const old = (await a.inject({ method: "GET", url: path })).json();
    await sql`CREATE TRIGGER audit_reject_analysis BEFORE INSERT ON analyses BEGIN SELECT RAISE(ABORT, '검증용 저장 거절'); END`.execute(db!);
    const failed = await a.inject({ method: "GET", url: `${path}?refresh=1&requestId=save-failure-001` });
    expect(failed.statusCode).toBe(500);
    expect((await a.inject({ method: "GET", url: `${path}/state?requestId=save-failure-001` })).json()).toMatchObject({
      latest: { id: old.id, content: old.content }, running: false, request: { status: "failed", result: null },
    });
    expect(await db!.selectFrom("analyses").select("id").execute()).toEqual([{ id: old.id }]);
    expect((await a.inject({ method: "GET", url: `${path}?refresh=1&requestId=save-failure-001` })).statusCode).toBe(500);
    expect(generator.requests).toHaveLength(2);
    await sql`DROP TRIGGER audit_reject_analysis`.execute(db!);
    const recovered = await a.inject({ method: "GET", url: `${path}?refresh=1&requestId=save-recovered-002` });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().id).not.toBe(old.id);
    expect((await a.inject({ method: "GET", url: `${path}/state?requestId=save-recovered-002` })).json()).toMatchObject({ running: false, request: { status: "completed", result: recovered.json() } });
    expect(generator.requests).toHaveLength(3);
    expect(generator.requests[2]).toEqual(generator.requests[1]);
  });

  it("기술 분석 캐시 만료 직전은 재사용하고 만료 시각의 동시 조회는 한 번만 생성한다", async () => {
    let clock = fixedNow();
    const generator = new FakeGenerator();
    const a = await setup(generator, () => clock);
    const path = "/api/stocks/005930/analysis/technical";
    const first = (await a.inject({ method: "GET", url: path })).json();
    clock = new Date(clock.getTime() + 86_400_000 - 1);
    expect((await a.inject({ method: "GET", url: `${path}?refresh=false` })).json()).toMatchObject({ id: first.id, cached: true });
    expect(generator.requests).toHaveLength(1);
    clock = new Date(clock.getTime() + 1);
    const [one, two] = await Promise.all([a.inject({ method: "GET", url: `${path}?refresh=false` }), a.inject({ method: "GET", url: `${path}?refresh=0` })]);
    expect(one.statusCode).toBe(200);
    expect(two.json()).toEqual(one.json());
    expect(one.json()).toMatchObject({ cached: false });
    expect(one.json().id).not.toBe(first.id);
    expect(generator.requests).toHaveLength(2);
    expect(await db!.selectFrom("analyses").select("id").execute()).toHaveLength(2);
  });
});

describe("1차 자료 부족 표시의 인접 경계", () => {
  it("받은 봉이 두 개여도 장중 미완료 봉을 빼면 지표 부족을 표시한다", async () => {
    const quotes = new FakeQuoteProvider("고정 시세");
    const original = quotes.getCandles.bind(quotes);
    quotes.getCandles = async (code, period, count) => {
      const series = await original(code, period, period === "D" ? 2 : count);
      return period === "D" ? { ...series, candles: series.candles.map((candle, index) => ({ ...candle, date: index === 0 ? "2026-12-24" : "2026-12-28" })) } : series;
    };
    const calendar = new MarketCalendar(async () => new Response("{}", { status: 500 }), fixedNow);
    const result = await new DataCollector({ ...fakeProviders({ quotes, calendar }), now: fixedNow }).collectAnalysis({ code: "005930", name: "삼성전자", market: "KOSPI" }, "technical");
    expect(result.marketState?.todayIncomplete).toBe(true);
    expect(result.technical).toBeNull();
    expect(result.missing).toEqual(["기술적 지표(봉 부족)"]);
    expect(result.weeklyCandles).toHaveLength(26);
    expect(result.quote?.price).toBe(100_000);
  });

  it("PER은 있지만 PBR이 없는 가치 분석도 시세 지표 자료 부족을 표시한다", async () => {
    for (const [per, pbr, missing] of [[15, null, true], [null, 2, true], [15, 2, false], [0, 0, false]] as const) {
      const quotes = new FakeQuoteProvider("고정 시세");
      const original = quotes.getQuote.bind(quotes);
      quotes.getQuote = async (code) => ({ ...await original(code), per, pbr });
      const result = await new DataCollector({ ...fakeProviders({ quotes }), now: fixedNow }).collectAnalysis({ code: "005930", name: "삼성전자", market: "KOSPI" }, "value");
      expect(result.quote).toMatchObject({ per, pbr, price: 100_000 });
      expect(result.missing.includes("PER/PBR(현재 시세 소스가 제공하지 않음)"), `${per}/${pbr}`).toBe(missing);
      expect(quotes.calls).toBe(2);
    }
  });

  it("PBR 부족 안내를 생성 입력·저장·캐시 응답까지 유지하고 추가 조회나 모델 호출을 만들지 않는다", async () => {
    const generator = new FakeGenerator();
    const quotes = new FakeQuoteProvider("고정 시세");
    const original = quotes.getQuote.bind(quotes);
    quotes.getQuote = async (code) => ({ ...await original(code), per: 15, pbr: null });
    const a = await setup(generator, fixedNow, quotes);
    const path = "/api/stocks/005930/analysis/value";
    const generated = await a.inject({ method: "GET", url: path });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().missing).toContain("PER/PBR(현재 시세 소스가 제공하지 않음)");
    expect(generator.requests).toHaveLength(1);
    expect(generator.requests[0]).toMatchObject({ maxTokens: 4096, effort: "high", label: "value_analysis:005930" });
    expect(generator.requests[0]!.user).toContain("PER/PBR(현재 시세 소스가 제공하지 않음)");
    const saved = await db!.selectFrom("analyses").selectAll().executeTakeFirstOrThrow();
    expect(JSON.parse(saved.data_snapshot).quote).toMatchObject({ per: 15, pbr: null, price: 100_000 });
    expect(JSON.parse(saved.missing_data)).toEqual(generated.json().missing);
    const cached = await a.inject({ method: "GET", url: `${path}?refresh=false` });
    expect(cached.json()).toMatchObject({ id: generated.json().id, cached: true, missing: generated.json().missing });
    expect(generator.requests).toHaveLength(1);
    expect(quotes.calls).toBe(2);
  });
});
