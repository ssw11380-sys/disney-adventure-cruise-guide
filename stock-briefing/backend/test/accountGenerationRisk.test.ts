import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest, TextGenerator } from "../src/llm/generator.js";
import { PromptStore } from "../src/llm/prompts.js";
import type { MarketIndex } from "../src/providers/market/indices.js";
import { AccountBriefingService, type AccountBriefingDeps } from "../src/services/accountBriefingService.js";
import type { AccountHolding } from "../src/services/accountNumbers.js";
import { GenerationJobs } from "../src/services/generationJobs.js";

// 변경 전 재현은 감사 폴더의 이전 소스만 지정한다. 제품 코드에는 별도 실행 경로를 넣지 않는다.
const Service: typeof AccountBriefingService = process.env["ACCOUNT_RISK_MODULE"]
  ? (await import(process.env["ACCOUNT_RISK_MODULE"]!)).AccountBriefingService : AccountBriefingService;
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountBriefing.json", import.meta.url), "utf8")) as { holdings: AccountHolding[]; usdKrw: MarketIndex };
const now = () => new Date("2026-12-28T08:30:00+09:00");
const date = "2026-12-28";
const text = "계좌의 변동은 보유 종목 흐름에 영향을 받았습니다.";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function gate() { let release!: () => void; return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() }; }
async function sqlite() {
  const directory = await mkdtemp(join(tmpdir(), "stock-account-risk-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const url = join(directory, "data.sqlite"); const db = await createMigratedDb(url); cleanup.push(() => db.destroy());
  return { db, second() { const other = createDb(url).db; cleanup.push(() => other.destroy()); return other; } };
}
function dependencies(db: Db, generate = vi.fn(async (_request: GenerateRequest) => ({ text, model: "account-fixed-test-model" }))) {
  const stocks = { listWithFreshQuotes: vi.fn(async () => structuredClone(fixture.holdings)) };
  const generator: TextGenerator = { model: "account-fixed-test-model", generate };
  const deps: AccountBriefingDeps = {
    db, jobs: new GenerationJobs(db, { pollMs: 5, recordNow: now }), stocks,
    indices: { list: vi.fn(async () => [structuredClone(fixture.usdKrw)]) }, calendar: null,
    generator, prompts: new PromptStore(),
    features: { enabled: async (key) => key === "accountBriefing" || key === "accountBriefingLlm" }, now,
  };
  return { deps, stocks, generate, service: new Service(deps) };
}

describe("계좌 보고서의 공유 DB 소유권과 자료 복구", () => {
  it("실제 SQLite 두 연결·두 서비스의 동시 요청은 자료와 모델을 한 번만 호출한다", async () => {
    const env = await sqlite(); const block = gate();
    const setup = dependencies(env.db, vi.fn(async () => { await block.promise; return { text, model: "account-fixed-test-model" }; }));
    const otherDb = env.second();
    const other = new Service({ ...setup.deps, db: otherDb, jobs: new GenerationJobs(otherDb, { pollMs: 5, recordNow: now }) });
    const first = setup.service.generate("morning", { date });
    await vi.waitFor(() => expect(setup.generate).toHaveBeenCalledTimes(1));
    const second = other.generate("morning", { date });
    try {
      // 경합하는 요청만 기다린다. 실행권이 있는 첫 요청에 새 대기를 넣은 검사가 아니다.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.generate).toHaveBeenCalledTimes(1);
      expect(setup.stocks.listWithFreshQuotes).toHaveBeenCalledTimes(1);
      block.release();
      expect(await second).toEqual(await first);
      expect(await env.db.selectFrom("account_briefings").selectAll().execute()).toHaveLength(1);
    } finally { block.release(); await Promise.allSettled([first, second]); }
  });

  it("최종 DB 쓰기 실패 후 새 서비스는 완료된 원자료와 모델 결과를 그대로 저장한다", async () => {
    const { db } = await sqlite(); const setup = dependencies(db);
    await sql`CREATE TRIGGER reject_account BEFORE INSERT ON account_briefings BEGIN SELECT RAISE(ABORT, 'account save rejected'); END`.execute(db);
    await expect(setup.service.generate("morning", { date })).rejects.toThrow("account save rejected");
    const requests = structuredClone(setup.generate.mock.calls);
    expect(requests).toHaveLength(1);
    await sql`DROP TRIGGER reject_account`.execute(db);
    setup.stocks.listWithFreshQuotes.mockRejectedValue(new Error("복구 중 자료를 다시 조회하면 안 됩니다"));
    setup.generate.mockRejectedValue(new Error("완료된 모델을 다시 호출하면 안 됩니다"));
    const recovered = await new Service({ ...setup.deps, jobs: new GenerationJobs(db, { recordNow: now }) }).generate("morning", { date });
    expect(recovered).toMatchObject({ status: "ok", detail: text, model: "account-fixed-test-model", template: false, createdAt: "2026-12-28T08:30:00+09:00" });
    expect(setup.generate.mock.calls).toEqual(requests);
    expect(setup.stocks.listWithFreshQuotes).toHaveBeenCalledTimes(1);
    expect((await setup.service.get(recovered!.id)).data).toMatchObject({ asOf: "2026-12-28T08:30:00+09:00", narrative: { source: "llm", reason: null } });
  });

  it("모델 결과 체크포인트 실패는 성공 기본문장으로 숨기지 않고 명시 재생성 전 외부 호출을 반복하지 않는다", async () => {
    const { db } = await sqlite(); const setup = dependencies(db);
    await sql`CREATE TRIGGER reject_model_checkpoint BEFORE UPDATE ON generation_jobs WHEN instr(NEW.checkpoint, '"model":"account-fixed-test-model"') > 0 BEGIN SELECT RAISE(ABORT, 'model checkpoint rejected'); END`.execute(db);
    await expect(setup.service.generate("morning", { date })).rejects.toMatchObject({ code: "GENERATION_CHECKPOINT_FAILED" });
    expect(await setup.service.list()).toEqual([]);
    await sql`DROP TRIGGER reject_model_checkpoint`.execute(db);
    const restart = new Service({ ...setup.deps, jobs: new GenerationJobs(db, { recordNow: now }) });
    await expect(restart.generate("morning", { date })).rejects.toMatchObject({ code: "GENERATION_INTERRUPTED" });
    expect(setup.generate).toHaveBeenCalledTimes(1);
    expect((await restart.generate("morning", { date, force: true }))?.detail).toBe(text);
    expect(setup.generate).toHaveBeenCalledTimes(2);
  });

  it("만료된 소유자의 늦은 모델 결과는 새 소유자가 저장한 본문을 덮어쓰지 못한다", async () => {
    const env = await sqlite(); const block = gate();
    const setup = dependencies(env.db, vi.fn(async () => { await block.promise; return { text: "이전 계좌의 설명입니다.", model: "account-fixed-test-model" }; }));
    const first = setup.service.generate("morning", { date });
    const rejected = expect(first).rejects.toMatchObject({ code: "GENERATION_OWNERSHIP_LOST" });
    await vi.waitFor(() => expect(setup.generate).toHaveBeenCalledTimes(1));
    await env.db.updateTable("generation_jobs").set({ lease_until: new Date(Date.now() - 1).toISOString() }).where("job_key", "=", `account:${date}:morning`).execute();
    const next = dependencies(env.second());
    try {
      const saved = await next.service.generate("morning", { date, force: true });
      block.release(); await rejected;
      expect((await setup.service.get(saved!.id)).detail).toBe(text);
      expect(await setup.service.list()).toHaveLength(1);
    } finally { block.release(); await first.catch(() => undefined); }
  });

  it("같은 부모 실행 복구는 결과를 재사용하고 새 강제 실행은 새 보고서를 생성한다", async () => {
    const { db } = await sqlite(); const setup = dependencies(db);
    const first = await setup.service.generate("morning", { date, force: true, eventId: "parent-1" });
    const second = new Service({ ...setup.deps, jobs: new GenerationJobs(db, { recordNow: now }) });
    expect(await second.generate("morning", { date, force: true, eventId: "parent-1" })).toEqual(first);
    expect(setup.generate).toHaveBeenCalledTimes(1);
    await second.generate("morning", { date, force: true, eventId: "parent-2" });
    expect(setup.generate).toHaveBeenCalledTimes(2);
    expect(setup.generate.mock.calls[1]).toEqual(setup.generate.mock.calls[0]);
    expect(setup.generate.mock.calls[0]?.[0]).toMatchObject({ label: "account_briefing", maxTokens: 1024, effort: "low" });
  });

  it("서버 종료 대기는 진행 중인 계좌 저장을 마친 뒤 끝난다", async () => {
    const { db } = await sqlite(); const block = gate();
    const setup = dependencies(db, vi.fn(async () => { await block.promise; return { text, model: "account-fixed-test-model" }; }));
    const generated = setup.service.generate("morning", { date });
    await vi.waitFor(() => expect(setup.generate).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = setup.service.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    block.release(); await generated; await closing;
    expect(setup.service.isRunning).toBe(false);
    expect((await setup.service.list())[0]?.status).toBe("ok");
  });
});

const pgUrl = process.env["TEST_PG_URL"];
describe.skipIf(!pgUrl)("실제 격리 PostgreSQL 계좌 경합", () => {
  it("두 독립 연결 서비스가 같은 요청의 모델을 한 번만 실행한다", async () => {
    const url = new URL(pgUrl!);
    if (!["localhost", "127.0.0.1", "[::1]", "postgres"].includes(url.hostname) || url.searchParams.has("host")) throw new Error("격리 로컬·CI DB만 허용합니다");
    const admin = createDb(pgUrl!).db; const name = `account_risk_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    cleanup.push(async () => { await sql`drop database ${sql.id(name)} with (force)`.execute(admin); await admin.destroy(); });
    url.pathname = `/${name}`;
    const db = await createMigratedDb(url.toString()); cleanup.push(() => db.destroy());
    const otherDb = createDb(url.toString()).db; cleanup.push(() => otherDb.destroy());
    const block = gate();
    const setup = dependencies(db, vi.fn(async () => { await block.promise; return { text, model: "account-fixed-test-model" }; }));
    const other = new Service({ ...setup.deps, db: otherDb, jobs: new GenerationJobs(otherDb, { pollMs: 5, recordNow: now }) });
    const first = setup.service.generate("morning", { date });
    await vi.waitFor(() => expect(setup.generate).toHaveBeenCalledTimes(1));
    const second = other.generate("morning", { date });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(setup.generate).toHaveBeenCalledTimes(1);
      block.release(); expect(await second).toEqual(await first);
      expect(await db.selectFrom("account_briefings").selectAll().execute()).toHaveLength(1);
    } finally { block.release(); await Promise.allSettled([first, second]); }
  });
});
