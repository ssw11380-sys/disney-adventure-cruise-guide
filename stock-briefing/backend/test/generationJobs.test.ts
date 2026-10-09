import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { GenerationJobs, checkpointGenerator, type GenerationContext } from "../src/services/generationJobs.js";
import { FakeGenerator } from "./helpers.js";

let db: Db;
afterEach(async () => { vi.restoreAllMocks(); await db?.destroy(); });
async function setup() { db = await createMigratedDb(":memory:"); return new GenerationJobs(db, { leaseMs: 3000, pollMs: 5 }); }
function gate() { let release!: () => void; return { promise: new Promise<void>((r) => { release = r; }), release: () => release() }; }
const request = { system: "전체 시스템 입력", user: "수치 123 / 기준 2026-10-03 / 누락 안내 포함", maxTokens: 4096, effort: "high" as const, label: "전체 보고서" };

describe("보고서 작업 DB 소유권과 저장 복구", () => {
  it("정상 소유자는 고정 타이머 없이 실행하고 같은 요청을 새 서비스가 동일 결과로 회수한다", async () => {
    const jobs = await setup(); const timer = vi.spyOn(globalThis, "setTimeout"); const work = vi.fn(async () => ({ text: "본문 전체", missing: ["분기 공시"] }));
    const first = await jobs.run("analysis:A", { requestKey: "request-1" }, work);
    expect(timer).not.toHaveBeenCalled();
    expect(await new GenerationJobs(db).run("analysis:A", { requestKey: "request-1" }, work)).toEqual(first);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("동시 두 소유자의 같은 입력은 한 번 실행하고 완료 결과에 합류한다", async () => {
    const jobs = await setup(); const block = gate(); let entered = false;
    const work = vi.fn(async () => { entered = true; await block.promise; return { text: "결과" }; });
    const a = jobs.run("one", {}, work);
    await vi.waitFor(() => expect(entered).toBe(true));
    const b = new GenerationJobs(db, { pollMs: 5 }).run("one", { requestKey: "join-other-server" }, work);
    await vi.waitFor(async () => expect((await jobs.request("join-other-server")).status).toBe("pending")); block.release();
    expect(await a).toEqual(await b); expect(work).toHaveBeenCalledTimes(1);
  });

  it("임대가 만료된 소유자의 늦은 결과는 새 소유자의 저장을 덮어쓰지 않는다", async () => {
    const jobs = await setup(); const block = gate(); let entered = false;
    const old = jobs.run("fence", {}, async (context) => { entered = true; await block.promise; return context.commit(async () => "old"); });
    const rejected = expect(old).rejects.toMatchObject({ code: "GENERATION_OWNERSHIP_LOST" });
    await vi.waitFor(() => expect(entered).toBe(true));
    await db.updateTable("generation_jobs").set({ lease_until: new Date(Date.now() - 1).toISOString() }).where("job_key", "=", "fence").execute();
    expect(await new GenerationJobs(db).run("fence", {}, async () => "new")).toBe("new");
    block.release(); await rejected;
    expect((await db.selectFrom("generation_jobs").select("result").where("job_key", "=", "fence").executeTakeFirstOrThrow()).result).toBe('"new"');
  });

  it("모델 완료 후 최종 저장 실패는 원문·입력·모델 설정을 보존하고 재호출 없이 저장한다", async () => {
    const jobs = await setup(); const original = new FakeGenerator(); const generator = checkpointGenerator(original);
    await sql`CREATE TRIGGER fail_final BEFORE UPDATE ON generation_jobs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'final rejected'); END`.execute(db);
    const work = async (context: GenerationContext) => {
      const input = await context.step("request", async () => request);
      return generator.generate(input);
    };
    await expect(jobs.run("result", {}, work)).rejects.toThrow("final rejected");
    expect(original.requests).toEqual([request]);
    const row = await db.selectFrom("generation_jobs").selectAll().where("job_key", "=", "result").executeTakeFirstOrThrow();
    const model = Object.entries(JSON.parse(row.checkpoint).steps).find(([key]) => key.startsWith("model:"))![1];
    await sql`DROP TRIGGER fail_final`.execute(db);
    expect(await new GenerationJobs(db).run("result", {}, work)).toEqual(model);
    expect(original.requests).toEqual([request]);
  });

  it("요청 기록 첫 쓰기 실패는 모델을 부르지 않고 소유권을 실패로 종료한다", async () => {
    const jobs = await setup(); const work = vi.fn(async () => "output");
    await sql`CREATE TRIGGER fail_request BEFORE INSERT ON generation_requests BEGIN SELECT RAISE(ABORT, 'request rejected'); END`.execute(db);
    await expect(jobs.run("request-write", { requestKey: "failing" }, work)).rejects.toThrow("request rejected");
    expect(work).not.toHaveBeenCalled();
    expect(await jobs.running("request-write")).toBe(false);
  });

  it("같은 부모 실행의 완료 하위 결과는 재사용하며 새 부모 실행은 새로 만든다", async () => {
    const jobs = await setup(); const work = vi.fn(async () => ({ all: "full model output" }));
    const opts = { signature: "parent-1", reuseCompleted: true };
    const before = await jobs.run("child", opts, work);
    expect(await new GenerationJobs(db).run("child", opts, work)).toEqual(before);
    expect(work).toHaveBeenCalledTimes(1);
    await jobs.run("child", { ...opts, signature: "parent-2" }, work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it.each(["다른 소유자", "만료된 임대"])("%s 확인 후 완료 효과를 시작하지 않는다", async (condition) => {
    const jobs = await setup(); const effect = vi.fn(async () => "외부 효과");
    await expect(jobs.run("effect-fence", {}, async (context) => {
      await context.step("inputs", async () => request);
      const values = condition === "다른 소유자" ? { owner: "new-owner" } : { lease_until: new Date(Date.now() - 1).toISOString() };
      await db.updateTable("generation_jobs").set(values).where("job_key", "=", "effect-fence").execute();
      return context.effect("done", effect);
    })).rejects.toMatchObject({ code: "GENERATION_OWNERSHIP_LOST" });
    expect(effect).not.toHaveBeenCalled();
    const row = await db.selectFrom("generation_jobs").selectAll().where("job_key", "=", "effect-fence").executeTakeFirstOrThrow();
    expect(row.status).toBe("running");
    expect(JSON.parse(row.checkpoint).steps).toEqual({ inputs: request });
  });

  it("30분을 넘긴 진행 요청은 보존하고 완료 시점부터 정확히 30분 뒤 만료한다", async () => {
    await setup();
    let recordMs = Date.parse("2026-10-03T00:00:00.000Z");
    const recordNow = () => new Date(recordMs);
    const jobs = new GenerationJobs(db, { recordNow }); const block = gate(); let entered = false;
    const work = vi.fn(async () => { entered = true; await block.promise; return { full: "전체 결과" }; });
    const pending = jobs.run("long-job", { requestKey: "long-request" }, work);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      recordMs += 31 * 60_000;
      const other = new GenerationJobs(db, { recordNow });
      // 별도 인스턴스의 정리도 유효한 임대가 있는 진행 요청을 실패 처리하지 않아야 한다.
      await other.run("cleanup-probe", {}, async () => "done");
      expect(await other.request("long-request")).toEqual({ status: "pending", result: null });
      block.release();
      const result = await pending;
      recordMs += 30 * 60_000 - 1;
      expect(await other.request("long-request")).toEqual({ status: "completed", result });
      expect(await other.run("long-job", { requestKey: "long-request" }, work)).toEqual(result);
      expect(work).toHaveBeenCalledTimes(1);
      recordMs += 1;
      expect(await other.request("long-request")).toEqual({ status: "unknown", result: null });
      await other.run("long-job", { requestKey: "long-request" }, work);
      expect(work).toHaveBeenCalledTimes(2);
    } finally {
      block.release();
      await pending.catch(() => undefined);
    }
  });

  it("7일이 지난 완료 작업만 정리하고 실패 작업의 미확정 모델 기록은 보존한다", async () => {
    const jobs = await setup();
    await jobs.run("old-completed", {}, async () => "보존 기간이 지난 완료 결과");
    await expect(jobs.run("old-uncertain", {}, async (context) => {
      await context.step("full-input", async () => request);
      return context.step("model:uncertain", async () => { throw new Error("응답을 받기 전 연결 중단"); }, true);
    })).rejects.toThrow("응답을 받기 전 연결 중단");
    const before = await db.selectFrom("generation_jobs").select("checkpoint").where("job_key", "=", "old-uncertain").executeTakeFirstOrThrow();
    const oldTime = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await db.updateTable("generation_jobs").set({ updated_at: oldTime, started_at: oldTime }).where("job_key", "in", ["old-completed", "old-uncertain"]).execute();
    await new GenerationJobs(db).run("cleanup-trigger", {}, async () => "완료");
    expect(await db.selectFrom("generation_jobs").select("job_key").where("job_key", "=", "old-completed").executeTakeFirst()).toBeUndefined();
    const retained = await db.selectFrom("generation_jobs").selectAll().where("job_key", "=", "old-uncertain").executeTakeFirstOrThrow();
    expect(retained.status).toBe("failed");
    expect(retained.checkpoint).toBe(before.checkpoint);
    expect(JSON.parse(retained.checkpoint)).toEqual({ steps: { "full-input": request }, pending: ["model:uncertain"] });
  });
});
