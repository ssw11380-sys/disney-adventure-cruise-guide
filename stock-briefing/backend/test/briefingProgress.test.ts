import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest, GenerateResult } from "../src/llm/generator.js";
import type { BriefingStatus } from "../src/services/briefingStatus.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

/** 실제 실행의 준비·생성·완료 리스너를 각각 멈춰, 상태 경로에 보이는 실행 수명을 확인한다 */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class PausedGenerator extends FakeGenerator {
  readonly hold = gate();
  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    await this.hold.promise;
    return super.generate(req);
  }
}

const DATE = "2026-12-28";
const iso = (time: string) => `${DATE}T${time}+09:00`;
const open: Array<{ app: FastifyInstance; db: Db }> = [];

async function start(time = "08:20:00") {
  const db = await createMigratedDb(":memory:");
  const clock = { now: new Date(iso(time)) };
  const generator = new PausedGenerator();
  const providers = fakeProviders({ generator });
  providers.calendar.isTradingDate = async () => true;
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers, now: () => clock.now, logger: false, enableScheduler: false });
  open.push({ app, db });
  await app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingLiveProgress: true, briefingParallel: false } });
  for (const [code, name, market] of [["005930", "삼성전자", "KOSPI"], ["AAPL", "애플", "NASDAQ"]]) {
    await db.insertInto("registered_stocks").values({ code: code!, name: name!, market: market!, quantity: 1, avg_price: 100, memo: null, created_at: "2026-12-01T10:00:00+09:00", updated_at: "2026-12-01T10:00:00+09:00" }).execute();
  }
  const status = async () => {
    const response = await app.inject({ method: "GET", url: "/api/briefings/status" });
    expect(response.statusCode).toBe(200);
    return response.json() as BriefingStatus;
  };
  return { app, db, clock, generator, providers, status };
}

afterEach(async () => {
  for (const c of open.splice(0)) {
    await c.app.close();
    await c.db.destroy();
  }
});

describe("브리핑 실행 시작부터 진행 정보 전달", () => {
  it.each([
    { name: "예약 실행", time: "08:30:00", session: "morning" as const, trigger: "schedule" as const, partial: false },
    { name: "예약 전 수동 실행", time: "08:20:00", session: "morning" as const, trigger: "manual" as const, partial: false },
    { name: "예약 전 오후 한 종목 실행", time: "08:20:00", session: "afternoon" as const, trigger: "manual" as const, partial: true },
  ])("$name: 준비부터 마무리 리스너가 끝날 때까지 실제 실행을 보낸다", async ({ time, session, trigger, partial }) => {
    const c = await start(time);
    const prepare = gate();
    const finish = gate();
    let finishing = false;
    c.app.briefingService.onSessionStart(() => prepare.promise);
    c.app.briefingService.onRunDone(async () => { finishing = true; await finish.promise; });
    const run = c.app.briefingService.runSession(session, { trigger, ...(partial ? { codes: ["005930"] } : {}) });
    const fields = { session, date: DATE, trigger, partial, startedAt: iso(time) };
    try {
      const ready = await c.status();
      expect(ready.activeRun).toEqual({ ...fields, total: 0, done: 0 });
      if (time === "08:20:00") expect(ready).toMatchObject({ session: null, state: "none" });
      prepare.release();
      await vi.waitFor(() => expect(c.app.briefingService.progress?.total).toBe(partial ? 1 : 2));
      expect((await c.status()).activeRun).toEqual({ ...fields, total: partial ? 1 : 2, done: 0 });
      c.generator.hold.release();
      await vi.waitFor(() => expect(finishing).toBe(true));
      const done = await c.status();
      expect(done.activeRun).toEqual({ ...fields, total: partial ? 1 : 2, done: partial ? 1 : 2 });
      expect(c.app.briefingService.isRunning).toBe(true);
      finish.release();
      await run;
      expect((await c.status()).activeRun).toBeNull();
    } finally {
      prepare.release();
      c.generator.hold.release();
      finish.release();
      await run;
    }
  });

  it("기능을 끄면 activeRun 필드 없이 기존 응답 그대로, 켜도 20분 지연 판정은 그대로", async () => {
    const c = await start("08:30:00");
    const run = c.app.briefingService.runSession("morning", { trigger: "schedule" });
    try {
      await vi.waitFor(() => expect(c.app.briefingService.progress?.total).toBe(2));
      for (const [time, state] of [["08:31:00", "ok"], ["08:51:00", "slow"]] as const) {
        c.clock.now = new Date(iso(time));
        const on = await c.status();
        expect(on.state).toBe(state);
        expect(on.activeRun).toMatchObject({ total: 2, done: 0 });
        await c.app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingLiveProgress: false } });
        const off = await c.status();
        const { activeRun: _activeRun, ...legacy } = on;
        expect(off).toEqual(legacy);
        expect(Object.hasOwn(off, "activeRun")).toBe(false);
        await c.app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingLiveProgress: true } });
      }
    } finally {
      c.generator.hold.release();
      await run;
    }
  });

  it("실패·휴장 건너뜀도 처리 수에 포함하고 끝난 뒤에는 기존 실패 판정으로 돌아간다", async () => {
    const c = await start("08:30:00");
    c.generator.opts.failKind = "api";
    c.providers.calendar.isTradingDate = async (market) => market === "KR";
    c.generator.hold.release();
    const finish = gate();
    let finishing = false;
    c.app.briefingService.onRunDone(async () => { finishing = true; await finish.promise; });
    const run = c.app.briefingService.runSession("morning", { trigger: "schedule" });
    try {
      await vi.waitFor(() => expect(finishing).toBe(true));
      expect((await c.status()).activeRun).toMatchObject({ total: 2, done: 2 });
      finish.release();
      const result = await run;
      expect(result.results.map((r) => r.status)).toEqual(["failed", "skipped"]);
      expect((await c.status())).toMatchObject({ state: "allFailed", activeRun: null, done: 0 });
    } finally {
      finish.release();
      await run;
    }
  });
});
