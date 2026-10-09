import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeGenerator, FakeQuoteProvider, fakeProviders } from "./helpers.js";

const now = () => new Date("2026-12-28T08:30:00+09:00");
let app: FastifyInstance | undefined;
let db: Db | undefined;
afterEach(async () => { await app?.close(); await db?.destroy(); app = undefined; db = undefined; });

describe("분석 요청의 명시적 캐시 선택", () => {
  it("false와 0은 기존 결과를 재사용하고 true와 1만 새로 생성한다", async () => {
    const generator = new FakeGenerator();
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator }), logger: false, enableScheduler: false, now });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    const path = "/api/stocks/005930/analysis/company";
    const first = (await app.inject({ method: "GET", url: path })).json();
    for (const [index, refresh] of ["false", "0"].entries()) {
      const response = await app.inject({ method: "GET", url: `${path}?refresh=${refresh}&requestId=cache-request-${index}` });
      expect(response.statusCode).toBe(200);
      expect(response.json(), refresh).toMatchObject({ id: first.id, cached: true });
      expect(generator.requests, refresh).toHaveLength(1);
    }
    for (const [index, refresh] of ["true", "1"].entries()) {
      const response = await app.inject({ method: "GET", url: `${path}?refresh=${refresh}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ cached: false });
      expect(response.json().id).not.toBe(first.id);
      expect(generator.requests).toHaveLength(index + 2);
    }
    expect(generator.requests[1]).toEqual(generator.requests[0]);
    expect(generator.requests[2]).toEqual(generator.requests[0]);
  });
});

describe("기술적 분석의 부족한 자료 안내", () => {
  it("일봉이 비었거나 지표 계산에 부족하면 누락을 표시하고 받은 주봉과 시세는 보존한다", async () => {
    for (const count of [0, 1]) {
      const quotes = new FakeQuoteProvider("고정 시세");
      const getCandles = quotes.getCandles.bind(quotes);
      quotes.getCandles = (code, period, requested) => getCandles(code, period, period === "D" ? count : requested);
      const collector = new DataCollector({ ...fakeProviders({ quotes }), now });
      const snapshot = await collector.collectAnalysis({ code: "005930", name: "삼성전자", market: "KOSPI" }, "technical");
      expect(snapshot.technical, String(count)).toBeNull();
      expect(snapshot.missing, String(count)).toContain("기술적 지표(봉 부족)");
      expect(snapshot.quote?.price).toBe(100_000);
      expect(snapshot.weeklyCandles).toHaveLength(26);
    }
  });

  it("지표 부족 안내가 모델 입력·저장 결과·다시 조회한 응답까지 유지된다", async () => {
    const generator = new FakeGenerator();
    const quotes = new FakeQuoteProvider("고정 시세");
    const getCandles = quotes.getCandles.bind(quotes);
    quotes.getCandles = (code, period, count) => getCandles(code, period, period === "D" ? 1 : count);
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator, quotes }), logger: false, enableScheduler: false, now });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    const path = "/api/stocks/005930/analysis/technical";
    const generated = await app.inject({ method: "GET", url: path });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().missing).toEqual(["기술적 지표(봉 부족)"]);
    expect(generator.requests).toHaveLength(1);
    expect(generator.requests[0]).toMatchObject({ maxTokens: 4096, effort: "medium", label: "technical_analysis:005930" });
    expect(generator.requests[0]!.user).toContain("기술적 지표(봉 부족)");
    const saved = await db.selectFrom("analyses").selectAll().executeTakeFirstOrThrow();
    const snapshot = JSON.parse(saved.data_snapshot);
    expect(snapshot.weeklyCandles).toHaveLength(26);
    expect(snapshot.quote.price).toBe(100_000);
    expect(JSON.parse(saved.missing_data)).toEqual(["기술적 지표(봉 부족)"]);
    const cached = (await app.inject({ method: "GET", url: path })).json();
    expect(cached).toMatchObject({ id: generated.json().id, cached: true, missing: ["기술적 지표(봉 부족)"] });
    expect(generator.requests).toHaveLength(1);
  });

  it("충분한 일봉과 일봉 조회 실패를 구별하고 회사 소개에는 지표 부족 안내를 더하지 않는다", async () => {
    const stock = { code: "005930", name: "삼성전자", market: "KOSPI" };
    const complete = await new DataCollector({ ...fakeProviders(), now }).collectAnalysis(stock, "technical");
    expect(complete.technical).not.toBeNull();
    expect(complete.missing).not.toContain("기술적 지표(봉 부족)");
    const failed = await new DataCollector({ ...fakeProviders({ quotes: new FakeQuoteProvider("실패", { failCandles: true }) }), now }).collectAnalysis(stock, "technical");
    expect(failed.missing).toEqual(["일봉", "주봉"]);
    const company = await new DataCollector({ ...fakeProviders(), now }).collectAnalysis(stock, "company");
    expect(company.missing).not.toContain("기술적 지표(봉 부족)");
  });
});
