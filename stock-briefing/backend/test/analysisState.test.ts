import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest } from "../src/llm/generator.js";
import { PromptStore } from "../src/llm/prompts.js";
import { AnalysisService } from "../src/services/analysisService.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

let app: FastifyInstance | undefined;
let db: Db | undefined;
async function setup(gen: FakeGenerator, now = () => new Date("2026-12-28T08:30:00+09:00")) {
  db = await createMigratedDb(":memory:");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: gen }), logger: false, enableScheduler: false, now });
  await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  return app;
}
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); await db?.destroy(); app = undefined; db = undefined; });

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

const PATH = "/api/stocks/005930/analysis/company";
const ID = "analysis-request-0001";
const NEXT_ID = "analysis-request-0002";

describe("분석 요청 식별자로 정확한 결과 회수", () => {
  it("상태 조회 없이 바로 생성하고 같은 요청 재전송·유효 캐시는 AI를 다시 부르지 않는다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    const state = vi.spyOn(a.analysisService, "state");
    const result = (await a.inject({ method: "GET", url: `${PATH}?requestId=${ID}` })).json();
    expect(state).not.toHaveBeenCalled();
    expect(gen.requests).toHaveLength(1);
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${ID}` })).json())
      .toMatchObject({ request: { id: ID, status: "completed", result } });
    expect((await a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` })).json()).toEqual(result);
    const cached = (await a.inject({ method: "GET", url: `${PATH}?requestId=${NEXT_ID}` })).json();
    expect(cached).toMatchObject({ id: result.id, cached: true });
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${NEXT_ID}` })).json())
      .toMatchObject({ request: { id: NEXT_ID, status: "completed", result: cached } });
    expect(gen.requests).toHaveLength(1);
  });

  it("강제 갱신 중 같은 ID와 다른 화면 요청은 기존 작업에 합류하고 이전 캐시를 완료로 돌려주지 않는다", async () => {
    let release!: () => void;
    let started = false;
    class Deferred extends FakeGenerator {
      blocked = false;
      override async generate(request: GenerateRequest) {
        if (this.blocked) { started = true; await new Promise<void>((resolve) => { release = resolve; }); }
        return super.generate(request);
      }
    }
    const gen = new Deferred();
    const a = await setup(gen);
    const old = (await a.inject({ method: "GET", url: PATH })).json();
    gen.blocked = true;
    const first = a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` }).then((r) => r);
    await vi.waitFor(() => expect(started).toBe(true));
    try {
      const duplicate = a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` }).then((r) => r);
      // refresh=false라도 이미 진행 중인 갱신에 합류해야 한다.
      const joined = a.inject({ method: "GET", url: `${PATH}?requestId=${NEXT_ID}` }).then((r) => r);
      await vi.waitFor(async () => {
        const current = (await a.inject({ method: "GET", url: `${PATH}/state?requestId=${NEXT_ID}` })).json();
        expect(current).toMatchObject({ latest: { id: old.id }, running: true, request: { id: NEXT_ID, status: "pending", result: null } });
      });
      expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${ID}` })).json())
        .toMatchObject({ request: { id: ID, status: "pending", result: null } });
      release();
      const [one, two, three] = await Promise.all([first, duplicate, joined]);
      expect(two.json()).toEqual(one.json());
      expect(three.json()).toEqual(one.json());
      expect(one.json().id).not.toBe(old.id);
      expect(gen.requests).toHaveLength(2);
      expect(gen.requests[1]).toEqual(gen.requests[0]);
      for (const id of [ID, NEXT_ID]) {
        expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${id}` })).json())
          .toMatchObject({ request: { id, status: "completed", result: one.json() } });
      }
    } finally {
      release();
      await first;
    }
  });

  it("추적하지 않던 기존 실행에도 합류하고 다른 요청이 끝난 뒤에도 해당 결과 ID를 고정한다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    const untracked = a.analysisService.get("005930", "company", { refresh: true });
    const tracked = a.analysisService.getTracked("005930", "company", ID, { refresh: true });
    const same = a.analysisService.getTracked("005930", "company", ID, { refresh: true });
    expect(tracked).toBe(same);
    expect(await tracked).toEqual(await untracked);
    const original = await tracked;
    const newer = (await a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${NEXT_ID}` })).json();
    expect(newer.id).not.toBe(original.id);
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${ID}` })).json())
      .toMatchObject({ latest: { id: newer.id }, request: { id: ID, status: "completed", result: original } });
    expect(gen.requests).toHaveLength(2);
  });

  it("새 생성 실패는 이전 서버 결과가 있어도 completed가 아니며 같은 ID 재전송으로 재생성하지 않는다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    const old = (await a.inject({ method: "GET", url: PATH })).json();
    gen.opts = { failKind: "api" };
    const failed = await a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` });
    expect(failed.statusCode).toBe(502);
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${ID}` })).json())
      .toMatchObject({ latest: { id: old.id }, running: false, request: { id: ID, status: "failed", result: null } });
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${NEXT_ID}` })).json())
      .toMatchObject({ request: { id: NEXT_ID, status: "unknown", result: null } });
    expect((await a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` })).statusCode).toBe(502);
    expect(gen.requests).toHaveLength(2);
    expect((await a.inject({ method: "GET", url: `/api/stocks/000660/analysis/company/state?requestId=${ID}` })).json())
      .toMatchObject({ request: { id: ID, status: "unknown", result: null } });
  });

  it("서버 재시작 후 같은 요청의 완료 결과를 회수하고 기록 없는 요청만 unknown이며 AI 호출은 없다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    const result = (await a.inject({ method: "GET", url: `${PATH}?requestId=${ID}` })).json();
    const restarted = new AnalysisService({ db: db!, collector: {} as never, generator: gen, prompts: new PromptStore(), now: () => new Date("2026-12-28T08:30:00+09:00") });
    expect(await restarted.state("005930", "company", ID))
      .toMatchObject({ latest: { id: result.id }, running: false, request: { id: ID, status: "completed", result } });
    expect(await restarted.getTracked("005930", "company", ID, { refresh: true })).toEqual(result);
    for (let i = 0; i < 3; i++) {
      expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${NEXT_ID}` })).json())
        .toMatchObject({ request: { id: NEXT_ID, status: "unknown", result: null } });
    }
    expect(gen.requests).toHaveLength(1);
  });

  it("추적 플래그를 끄면 요청 ID를 무시하고 기존 강제 갱신·상태 404 동작을 유지한다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    await a.inject({ method: "PUT", url: "/api/admin/features", payload: { analysisWaitRecovery: false } });
    const first = (await a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` })).json();
    const second = (await a.inject({ method: "GET", url: `${PATH}?refresh=1&requestId=${ID}` })).json();
    expect(second.id).not.toBe(first.id);
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${ID}` })).statusCode).toBe(404);
    await a.inject({ method: "PUT", url: "/api/admin/features", payload: { analysisWaitRecovery: true } });
    expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${ID}` })).json())
      .toMatchObject({ request: { id: ID, status: "unknown", result: null } });
    expect(gen.requests).toHaveLength(2);
  });

  it("요청 ID 형식 오류는 생성 전에 거절한다", async () => {
    const gen = new FakeGenerator();
    const a = await setup(gen);
    for (const id of ["짧음", "x".repeat(81), "invalid-request!", "x".repeat(11)]) {
      expect((await a.inject({ method: "GET", url: `${PATH}?requestId=${encodeURIComponent(id)}` })).statusCode).toBe(400);
      expect((await a.inject({ method: "GET", url: `${PATH}/state?requestId=${encodeURIComponent(id)}` })).statusCode).toBe(400);
    }
    expect(gen.requests).toHaveLength(0);
  });

  it("추적 기록은 256개로 제한하고 완료 뒤 30분이 지나면 unknown으로 만료한다", async () => {
    let now = new Date("2026-12-28T08:30:00+09:00");
    const gen = new FakeGenerator();
    const a = await setup(gen, () => now);
    const service = a.analysisService;
    for (let i = 0; i < 256; i++) await service.getTracked("005930", "company", `bounded-request-${i}`);
    const full = await a.inject({ method: "GET", url: `${PATH}?requestId=${ID}` });
    expect(full.statusCode).toBe(429);
    expect(full.json().error).toBe("ANALYSIS_TRACKING_BUSY");
    expect((await service.state("005930", "company", "bounded-request-0")).request?.status).toBe("completed");
    await service.getTracked("005930", "company", "bounded-request-0", { refresh: true });
    expect(gen.requests).toHaveLength(1);
    now = new Date(now.getTime() + 30 * 60_000);
    expect((await service.state("005930", "company", "bounded-request-0")).request)
      .toEqual({ id: "bounded-request-0", status: "unknown", result: null });
    expect((await a.inject({ method: "GET", url: `${PATH}?requestId=${ID}` })).statusCode).toBe(200);
    expect(gen.requests).toHaveLength(1);
  });

  it("진행 중인 요청은 30분이 지나도 지우지 않고 실제 완료 시점부터 만료 시간을 센다", async () => {
    let now = new Date("2026-12-28T08:30:00+09:00");
    let release!: () => void;
    let started = false;
    class Deferred extends FakeGenerator {
      override async generate(request: GenerateRequest) {
        started = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return super.generate(request);
      }
    }
    const gen = new Deferred();
    const a = await setup(gen, () => now);
    const first = a.analysisService.getTracked("005930", "company", ID);
    await vi.waitFor(() => expect(started).toBe(true));
    try {
      now = new Date(now.getTime() + 60 * 60_000);
      expect((await a.analysisService.state("005930", "company", ID)).request?.status).toBe("pending");
      expect(a.analysisService.getTracked("005930", "company", ID, { refresh: true })).toBe(first);
      release();
      await first;
      now = new Date(now.getTime() + 30 * 60_000 - 1);
      expect((await a.analysisService.state("005930", "company", ID)).request?.status).toBe("completed");
      now = new Date(now.getTime() + 1);
      expect((await a.analysisService.state("005930", "company", ID)).request?.status).toBe("unknown");
      expect(gen.requests).toHaveLength(1);
    } finally {
      release();
      await first;
    }
  });
});
