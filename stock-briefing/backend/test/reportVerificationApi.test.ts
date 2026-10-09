import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { FakeGenerator, FakeQuoteProvider, fakeProviders } from "./helpers.js";

const content = "현재가: 99,000원\n전일 대비 등락률: -1.01%\n기업 해석과 나머지 본문은 그대로 보존합니다.";
let app: FastifyInstance | undefined;
let db: Db | undefined;
async function setup() {
  db = await createMigratedDb(":memory:");
  const generator = new FakeGenerator();
  const original = generator.generate.bind(generator);
  generator.generate = async (request) => ({ ...await original(request), text: content });
  const quotes = new FakeQuoteProvider("fixture", { price: 100_000 });
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator, quotes }), logger: false, enableScheduler: false, now: () => new Date("2026-12-28T08:30:00+09:00") });
  await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  return { app, generator, quotes };
}
afterEach(async () => { await app?.close(); await db?.destroy(); app = undefined; db = undefined; });

describe("저장된 원자료에 근거한 보고서 수치 확인", () => {
  it("생성·캐시·상태 조회 모두 원래 시세 시각과 불일치를 제공하고 본문·생성 횟수를 보존한다", async () => {
    const { app: a, generator, quotes } = await setup();
    const url = "/api/stocks/005930/analysis/technical";
    const created = (await a.inject({ method: "GET", url })).json();
    expect(created.content).toBe(content);
    expect(created.verification).toMatchObject({ scope: "quote_claims", quoteAsOf: "2026-09-22T09:00:00+09:00", quoteSource: "fixture", checkedClaims: 2,
      issues: [{ field: "price" }, { field: "changeRate" }] });
    const calls = quotes.calls;
    const cached = (await a.inject({ method: "GET", url })).json();
    const state = (await a.inject({ method: "GET", url: `${url}/state` })).json();
    expect(cached.verification).toEqual(created.verification);
    expect(state.latest.verification).toEqual(created.verification);
    expect(cached.content).toBe(content);
    expect(quotes.calls).toBe(calls);
    expect(generator.requests).toHaveLength(1);
    expect(generator.requests[0]).toMatchObject({ maxTokens: 4096, effort: "medium" });
  });

  it("과거 스냅샷이 손상돼도 본문은 읽을 수 있고 자료 시각을 생성 시각으로 꾸미지 않는다", async () => {
    const { app: a, generator } = await setup();
    await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/technical" });
    await db!.updateTable("analyses").set({ data_snapshot: "잘못된 JSON" }).execute();
    const res = await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/technical/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json().latest.content).toBe(content);
    expect(res.json().latest.verification).toEqual({ scope: "quote_claims", quoteAsOf: null, quoteSource: null, checkedClaims: 0, issues: [] });
    expect(generator.requests).toHaveLength(1);
  });

  it("브리핑 상세는 저장한 시세로 요약·본문을 대조하며 조회할 때 모델을 다시 부르지 않는다", async () => {
    const { app: a, generator, quotes } = await setup();
    await a.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
    await a.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingSafeWording: false } });
    const run = (await a.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } })).json();
    const id = run.results[0].briefingId;
    expect(id).toBeTypeOf("number");
    const calls = quotes.calls;
    const res = await a.inject({ method: "GET", url: `/api/briefings/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().detail).toBe(content);
    expect(res.json().verification.quoteAsOf).toBe("2026-09-22T09:00:00+09:00");
    expect(res.json().verification.issues.map((x: {field: string}) => x.field)).toEqual(["price", "changeRate"]);
    expect(generator.requests).toHaveLength(2);
    expect(quotes.calls).toBe(calls);
  });
});
