import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest } from "../src/llm/generator.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

let app: FastifyInstance | undefined;
let db: Db | undefined;
async function setup(gen: FakeGenerator) {
  db = await createMigratedDb(":memory:");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: gen }), logger: false, enableScheduler: false, now: () => new Date("2026-12-28T08:30:00+09:00") });
  await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  return app;
}
afterEach(async () => { await app?.close(); await db?.destroy(); app = undefined; db = undefined; });

describe("분석 상태 읽기 전용 경로", () => {
  it("결과 없는 종목 상태를 여러 번 확인해도 AI 생성은 0회이고 플래그를 끄면 404다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    for (const kind of ["company", "value", "technical"]) {
      const res = await a.inject({ method: "GET", url: `/api/stocks/005930/analysis/${kind}/state` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ latest: null, running: false });
    }
    expect(gen.requests).toHaveLength(0);
    await a.inject({ method: "PUT", url: "/api/admin/features", payload: { analysisWaitRecovery: false } });
    expect((await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state" })).statusCode).toBe(404);
    expect(gen.requests).toHaveLength(0);
    expect((await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/company" })).statusCode).toBe(200);
    expect(gen.requests).toHaveLength(1);
  });

  it("갱신 중 이전 ID와 running을 반환하고 같은 생성 시각에도 새 ID를 마지막 결과로 회수한다", async () => {
    let release: () => void = () => undefined;
    let started = false;
    class Deferred extends FakeGenerator {
      waiting = false;
      override async generate(req: GenerateRequest) {
        if (this.waiting) { started = true; await new Promise<void>((resolve) => { release = resolve; }); }
        return super.generate(req);
      }
    }
    const gen = new Deferred();
    const a = await setup(gen);
    const old = (await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/company" })).json();
    gen.waiting = true;
    const refresh = a.inject({ method: "GET", url: "/api/stocks/005930/analysis/company?refresh=1" }).then((res) => res);
    await vi.waitFor(() => expect(started).toBe(true));
    const during = (await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state" })).json();
    expect(during).toMatchObject({ latest: { id: old.id }, running: true });
    expect((await a.inject({ method: "GET", url: "/api/stocks/000660/analysis/company/state" })).json()).toEqual({ latest: null, running: false });
    release();
    const refreshed = (await refresh).json();
    expect(refreshed.createdAt).toBe(old.createdAt);
    expect(refreshed.id).not.toBe(old.id);
    const completed = (await a.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state" })).json();
    expect(completed).toMatchObject({ latest: { id: refreshed.id }, running: false });
    expect(gen.requests).toHaveLength(2);
    expect(gen.requests[1]).toEqual(gen.requests[0]);
    expect(gen.requests[0]).toMatchObject({ maxTokens: 4096, effort: "high", label: "company_overview:005930" });
  });
});
