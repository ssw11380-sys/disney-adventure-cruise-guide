import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { RegisteredStock } from "../src/domain/types.js";
import type { GenerateRequest } from "../src/llm/generator.js";
import { PromptStore } from "../src/llm/prompts.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import { AnalysisService } from "../src/services/analysisService.js";
import { BriefingService, type RunDoneListener } from "../src/services/briefingService.js";
import { BriefingStatusService, runLogEntry } from "../src/services/briefingStatus.js";
import { DataCollector } from "../src/services/collector.js";
import { evaluate } from "../src/services/stockService.js";
import { FakeGenerator, FakeNewsProvider, FakeQuoteProvider, NoopPushSender, fakeProviders, makeQuote } from "./helpers.js";

const AT = new Date("2026-12-28T08:45:00+09:00");
const CODE = "005930";
const DATE = "2026-12-28";
const resources: Db[] = [];
const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise.catch(() => undefined));
  return promise;
}
class ControlledGenerator extends FakeGenerator {
  started: string[] = [];
  before: (request: GenerateRequest) => Promise<void> = async () => {};
  override async generate(request: GenerateRequest) {
    this.started.push(request.label!);
    await this.before(request);
    return super.generate(request);
  }
}
async function setup() {
  const db = await createMigratedDb(":memory:");
  resources.push(db);
  await db.insertInto("registered_stocks").values({
    code: CODE, name: "삼성전자", market: "KOSPI", quantity: 10, avg_price: 90_000,
    memo: "", created_at: "2026-12-01T09:00:00+09:00", updated_at: AT.toISOString(),
  }).execute();
  const gen = new ControlledGenerator();
  const collector = new DataCollector({ quotes: new FakeQuoteProvider("가짜시세"), news: new FakeNewsProvider(), financials: null, investorFlow: null, now: () => AT });
  const prompts = new PromptStore();
  const analysis = new AnalysisService({ db, collector, generator: gen, prompts, now: () => AT });
  let clock = AT;
  const briefing = new BriefingService({ db, collector, generator: gen, prompts, calendar: { isTradingDate: async () => true }, now: () => clock, safeWording: async () => true, parallel: async () => true });
  return { db, gen, collector, analysis, briefing, prompts, setClock: (date: Date) => { clock = date; } };
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(resources.splice(0).map((db) => db.destroy()));
});

describe("서버 보고서 경계 추가 감사 — 실제 서비스와 가짜 자료", () => {
  it("계좌 강제 재생성 중 모든 시세가 실패해도 같은 회차의 이전 성공 본문을 보존해야 한다", async () => {
    const h = await setup();
    let available = false;
    const stock: RegisteredStock = { code: CODE, name: "삼성전자", market: "KOSPI", quantity: 10, avgPrice: 90_000, memo: "", createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
    const stocks = { listWithFreshQuotes: vi.fn(async () => {
      const quote = available ? makeQuote(CODE, "가짜시세") : null;
      return [{ ...stock, quote, evaluation: evaluate(stock, quote) }];
    }) };
    const account = new AccountBriefingService({ db: h.db, stocks, indices: null, calendar: null, generator: h.gen, prompts: h.prompts, features: { enabled: async (key) => key === "accountBriefing" }, now: () => AT });
    const initialFailure = await account.generate("morning", { date: DATE });
    expect(initialFailure?.status).toBe("failed");
    available = true;
    const old = await account.generate("morning", { date: DATE });
    expect(old?.status).toBe("ok");
    expect(old?.detail.length).toBeGreaterThan(0);
    available = false;
    const attempted = await account.generate("morning", { date: DATE, force: true }).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
    const saved = await account.find(DATE, "morning");
    expect.soft(attempted.error).toMatchObject({ code: "ACCOUNT_DATA_UNAVAILABLE" });
    expect(h.gen.requests).toHaveLength(0);
    expect(saved).toEqual(old);
    available = true;
    expect((await account.generate("morning", { date: DATE, force: true }))?.status).toBe("ok");
  });

  it("강제 갱신보다 먼저 시작한 독립 캐시 조회는 자기 응답만 완료로 추적하며 force 결과와 혼동하지 않는다", async () => {
    const h = await setup();
    const old = await h.analysis.get(CODE, "company");
    const readGate = gate();
    const modelGate = gate();
    const latest = h.analysis.latest.bind(h.analysis);
    let readStarted = false;
    vi.spyOn(h.analysis, "latest").mockImplementationOnce(async (...args) => {
      const result = await latest(...args);
      readStarted = true;
      await readGate.promise;
      return result;
    });
    const cachedRead = track(h.analysis.getTracked(CODE, "company", "audit-cache-reader"));
    await vi.waitFor(() => expect(readStarted).toBe(true));
    h.gen.before = async () => modelGate.promise;
    const refresh = track(h.analysis.getTracked(CODE, "company", "audit-force-writer", { refresh: true }));
    await vi.waitFor(() => expect(h.gen.started).toHaveLength(2));
    readGate.release();
    await Promise.resolve();
    modelGate.release();
    const [reader, writer] = await Promise.all([cachedRead, refresh]);
    expect(writer.id).not.toBe(old.id);
    expect(reader.id).toBe(old.id);
    expect((await h.analysis.state(CODE, "company", "audit-cache-reader")).request?.result?.id).toBe(old.id);
    expect((await h.analysis.state(CODE, "company", "audit-force-writer")).request?.result?.id).toBe(writer.id);
  });

  it("브리핑 DB 저장 예외가 발생한 실행은 마지막 실행 정보에 실패로 남아야 한다", async () => {
    const h = await setup();
    const status = new BriefingStatusService({ db: h.db, features: { enabled: async () => true }, settings: async () => ({ morningTime: "08:30", afternoonTime: "16:00", morningEnabled: true, afternoonEnabled: true, weekdaysOnly: true }), calendar: null, progress: () => h.briefing.progress, llmConfigured: () => true, now: () => AT });
    h.briefing.onRunDone(status.onRunDone);
    await h.briefing.runSession("morning");
    const old = await h.briefing.find(CODE, DATE, "morning");
    const firstRun = h.briefing.lastRun;
    h.setClock(new Date("2026-12-28T09:00:00+09:00"));
    const done: Parameters<RunDoneListener>[0][] = [];
    h.briefing.onRunDone((value) => { done.push(value); });
    const insert = h.db.insertInto.bind(h.db);
    vi.spyOn(h.db, "insertInto").mockImplementation(((table: Parameters<Db["insertInto"]>[0]) => {
      if (table === "briefings") throw new Error("가짜 저장 실패");
      return insert(table);
    }) as Db["insertInto"]);
    await expect(h.briefing.runSession("morning", { force: true })).rejects.toThrow("가짜 저장 실패");
    expect(await h.briefing.find(CODE, DATE, "morning")).toEqual(old);
    expect(h.briefing.progress).toBeNull();
    expect(h.briefing.isRunning).toBe(false);
    expect(done).toHaveLength(1);
    expect.soft(runLogEntry(done[0]!, "2026-12-28T09:00:00+09:00")).toMatchObject({ total: 1, failed: 0, runError: expect.any(String) });
    expect.soft(h.briefing.lastRun).not.toEqual(firstRun);
    expect.soft(h.briefing.lastRun).toMatchObject({ total: 1, ok: 0, failed: 0, lastError: expect.any(String) });
    const storedLogs = await status.runs();
    expect(storedLogs).toHaveLength(2);
    expect(storedLogs[0]).not.toHaveProperty("runError");
    expect(storedLogs[1]).toMatchObject({ total: 1, ok: 0, failed: 0, runError: h.briefing.lastRun!.lastError });
    expect(JSON.stringify(storedLogs)).not.toContain("가짜 저장 실패");
  });

  it.each([false, true])("병렬 %s에서 뒤 종목 저장 예외가 앞의 완료 결과나 원래 예외를 바꾸지 않는다", async (parallel) => {
    const h = await setup();
    await h.db.insertInto("registered_stocks").values({ code: "000660", name: "SK하이닉스", market: "KOSPI", quantity: 1, avg_price: 90_000, memo: "", created_at: "2026-12-02T09:00:00+09:00", updated_at: AT.toISOString() }).execute();
    const briefing = new BriefingService({ db: h.db, collector: h.collector, generator: h.gen, prompts: h.prompts, calendar: { isTradingDate: async () => true }, now: () => AT, parallel: async () => parallel });
    const insert = h.db.insertInto.bind(h.db);
    let inserts = 0;
    const error = new Error("가짜 뒤 종목 저장 오류");
    vi.spyOn(h.db, "insertInto").mockImplementation(((table: Parameters<Db["insertInto"]>[0]) => {
      if (table === "briefings" && ++inserts === 2) throw error;
      return insert(table);
    }) as Db["insertInto"]);
    const done: Parameters<RunDoneListener>[0][] = [];
    briefing.onRunDone((value) => { done.push(value); });
    await expect(briefing.runSession("morning")).rejects.toBe(error);
    expect(done[0]).toMatchObject({ total: 2, runError: expect.any(String), results: [{ code: CODE, status: "ok" }] });
    expect(briefing.lastRun).toMatchObject({ total: 2, ok: 1, failed: 0, lastError: expect.any(String) });
    expect(await h.db.selectFrom("briefings").select("code").execute()).toEqual([{ code: CODE }]);
    expect(briefing.isRunning).toBe(false);
    expect(briefing.progress).toBeNull();
  });

  it("계좌 재생성 실패는 API 오류로 구분하고 종목도 실패한 실행에 옛 계좌 성공 알림을 새로 보내지 않는다", async () => {
    const h = await setup();
    const push = new NoopPushSender();
    const sent = vi.spyOn(push, "send");
    const app = await buildApp({ db: h.db, config: loadConfig({ DATABASE_URL: ":memory:" }), providers: fakeProviders({ generator: h.gen, push }), logger: false, enableScheduler: false, receiptDelayMs: 0, now: () => AT });
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: "ExponentPushToken[auditfixtureonly]", platform: "android" } });
    const run = () => app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", force: true } });
    expect((await run()).statusCode).toBe(200);
    const old = await app.accountBriefings.find(DATE, "morning");
    expect(old?.status).toBe("ok");
    expect(sent).toHaveBeenCalledTimes(1);
    const rows = await app.stockService.listWithFreshQuotes();
    vi.spyOn(app.stockService, "listWithFreshQuotes").mockResolvedValue(rows.map((row) => ({ ...row, quote: null, quoteError: "가짜 시세 실패", evaluation: null })));
    h.gen.opts = { failKind: "api" };
    const failed = await run();
    expect(failed.statusCode).toBe(200);
    expect(failed.json().results[0].status).toBe("failed");
    expect(await app.accountBriefings.find(DATE, "morning")).toEqual(old);
    expect(sent).toHaveBeenCalledTimes(1);
    const direct = await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "morning", force: true } });
    expect(direct.statusCode).toBe(503);
    expect(direct.json()).toMatchObject({ error: "ACCOUNT_DATA_UNAVAILABLE" });
    h.gen.opts = {};
    expect((await run()).statusCode).toBe(200);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]![1].data?.accountBriefingId).toBeUndefined();
    expect(await app.accountBriefings.find(DATE, "morning")).toEqual(old);
  });

  it("분석 저장 실패는 이전 성공을 유지하고 failed로 끝나며 새 요청 ID로만 다시 만들 수 있다", async () => {
    const h = await setup();
    const old = await h.analysis.get(CODE, "company");
    const insert = h.db.insertInto.bind(h.db);
    const spy = vi.spyOn(h.db, "insertInto").mockImplementation(((table: Parameters<Db["insertInto"]>[0]) => {
      if (table === "analyses") throw new Error("가짜 분석 저장 실패");
      return insert(table);
    }) as Db["insertInto"]);
    await expect(h.analysis.getTracked(CODE, "company", "audit-failed-save", { refresh: true })).rejects.toThrow("가짜 분석 저장 실패");
    expect(await h.analysis.state(CODE, "company", "audit-failed-save")).toMatchObject({ latest: { id: old.id }, running: false, request: { status: "failed", result: null } });
    spy.mockRestore();
    await expect(h.analysis.getTracked(CODE, "company", "audit-failed-save", { refresh: true })).rejects.toThrow("가짜 분석 저장 실패");
    expect(h.gen.requests).toHaveLength(2);
    const next = await h.analysis.getTracked(CODE, "company", "audit-retry-save", { refresh: true });
    expect(next.id).not.toBe(old.id);
    expect((await h.analysis.state(CODE, "company", "audit-retry-save")).request).toMatchObject({ status: "completed", result: { id: next.id } });
    expect(h.gen.requests).toHaveLength(3);
  });

  it("같은 분석의 동시 강제 요청 ID 여러 개와 동일 ID 재전송은 생성 한 건을 공유한다", async () => {
    const h = await setup();
    const modelGate = gate();
    h.gen.before = async () => modelGate.promise;
    const ids = ["audit-concurrent-1", "audit-concurrent-2", "audit-concurrent-3"];
    const jobs = ids.map((id) => track(h.analysis.getTracked(CODE, "technical", id, { refresh: true })));
    expect(h.analysis.getTracked(CODE, "technical", ids[0]!, { refresh: true })).toBe(jobs[0]);
    await vi.waitFor(() => expect(h.gen.started).toHaveLength(1));
    for (const id of ids) expect((await h.analysis.state(CODE, "technical", id)).request?.status).toBe("pending");
    modelGate.release();
    const results = await Promise.all(jobs);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(h.gen.requests).toHaveLength(1);
    for (const id of ids) expect((await h.analysis.state(CODE, "technical", id)).request?.result?.id).toBe(results[0]!.id);
  });

  it("같은 requestId라도 다른 분석 종류는 별도 작업이며 상태 조회는 생성하지 않는다", async () => {
    const h = await setup();
    const company = await h.analysis.getTracked(CODE, "company", "audit-shared-identity");
    expect((await h.analysis.state(CODE, "technical", "audit-shared-identity")).request?.status).toBe("unknown");
    const technical = await h.analysis.getTracked(CODE, "technical", "audit-shared-identity");
    expect(technical.id).not.toBe(company.id);
    expect((await h.analysis.state(CODE, "company", "audit-shared-identity")).request?.result?.id).toBe(company.id);
    expect(h.gen.requests).toHaveLength(2);
  });

  it("생성 중 삭제한 등록 종목은 되살리지 않으며 이미 수집한 보고서는 이력으로 남는다", async () => {
    const h = await setup();
    const modelGate = gate();
    h.gen.before = async () => modelGate.promise;
    const run = track(h.briefing.runSession("morning"));
    await vi.waitFor(() => expect(h.gen.started).toHaveLength(1));
    await h.db.deleteFrom("registered_stocks").where("code", "=", CODE).execute();
    modelGate.release();
    const result = await run;
    expect(result.results).toHaveLength(1);
    expect(await h.db.selectFrom("registered_stocks").selectAll().execute()).toEqual([]);
    expect(await h.briefing.latestPerStock()).toEqual([]);
    const history = await h.briefing.get(result.results[0]!.briefingId!);
    expect(history).toMatchObject({ code: CODE, name: null, status: "ok", data: { stock: { quantity: 10 } } });
  });

  it("생성 중 보유 수량이 바뀌어도 원래 수집 시점 스냅샷을 보존하고 등록 수량을 덮어쓰지 않는다", async () => {
    const h = await setup();
    const modelGate = gate();
    h.gen.before = async () => modelGate.promise;
    const run = track(h.briefing.runSession("morning"));
    await vi.waitFor(() => expect(h.gen.started).toHaveLength(1));
    await h.db.updateTable("registered_stocks").set({ quantity: 20, avg_price: 80_000 }).where("code", "=", CODE).execute();
    modelGate.release();
    const result = await run;
    expect((await h.briefing.get(result.results[0]!.briefingId!)).data?.stock).toMatchObject({ quantity: 10, avgPrice: 90_000 });
    expect(await h.db.selectFrom("registered_stocks").select(["quantity", "avg_price"]).executeTakeFirst()).toEqual({ quantity: 20, avg_price: 80_000 });
  });

  it("종목 브리핑 강제 갱신 모델 실패는 이전 성공을 보존하고 이번 실행은 실패로 알린다", async () => {
    const h = await setup();
    await h.briefing.runSession("morning");
    const old = await h.briefing.find(CODE, DATE, "morning");
    h.gen.opts = { failKind: "api" };
    const result = await h.briefing.runSession("morning", { force: true });
    expect(await h.briefing.find(CODE, DATE, "morning")).toEqual(old);
    expect(result.results[0]).toMatchObject({ status: "failed", briefingId: old!.id, summary: null });
    expect(h.briefing.lastRun).toMatchObject({ failed: 1 });
  });
});
