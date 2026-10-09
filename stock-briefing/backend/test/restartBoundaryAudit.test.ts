import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest } from "../src/llm/generator.js";
import { PromptStore } from "../src/llm/prompts.js";
import { BriefingScheduler } from "../src/scheduler.js";
import { AnalysisService } from "../src/services/analysisService.js";
import { BriefingService } from "../src/services/briefingService.js";
import { DataCollector } from "../src/services/collector.js";
import { MarketSummaryService, type MarketSummarySources } from "../src/services/marketSummaryService.js";
import { FakeNewsProvider, FakeQuoteProvider } from "./helpers.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

const cronJobs = vi.hoisted(() => [] as Array<{ name: string; fire: () => Promise<void>; destroyed: boolean }>);
vi.mock("node-cron", () => ({ default: {
  validate: () => true,
  schedule: (_expression: string, fire: () => Promise<void>, options?: { name?: string }) => {
    const job = { name: options?.name ?? "기타 예약", fire, destroyed: false };
    cronJobs.push(job);
    return { destroy: () => { job.destroyed = true; }, stop: () => {}, start: () => {}, getNextRun: () => null };
  },
} }));

const AT = new Date("2026-12-28T08:30:00+09:00");
const databases: Db[] = [];
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
  entered = false;
  before = async () => {};
  override async generate(request: GenerateRequest) {
    this.entered = true;
    await this.before();
    return super.generate(request);
  }
}
async function setup(options: { marketSummary?: MarketSummarySources; now?: () => Date } = {}) {
  const db = await createMigratedDb(":memory:");
  databases.push(db);
  const gen = new ControlledGenerator();
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: gen, ...options.marketSummary ? { marketSummary: options.marketSummary } : {} }),
    logger: false, now: options.now ?? (() => AT),
  });
  apps.push(app);
  await db.insertInto("registered_stocks").values({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: null, avg_price: null,
    memo: "", created_at: "2026-12-01T08:00:00+09:00", updated_at: AT.toISOString() }).execute();
  await app.ready();
  const job = cronJobs.findLast((job) => job.name.startsWith("briefing-morning-"))!;
  return { db, app, gen, job };
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.allSettled(pending.splice(0));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
  cronJobs.splice(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MARKET_AT = new Date("2026-09-28T16:00:00+09:00");
function marketSources(): MarketSummarySources {
  return {
    indices: async () => ["KOSPI", "KOSDAQ"].map((code) => ({ code, name: code, kind: "index" as const, value: 2500, change: 10, changeRate: 0.4, open: false, asOf: "2026-09-28T15:30:00+09:00" })),
    fxDaily: async () => [], exchangeStatus: async () => ({}), isTradingDate: async () => true,
    treasuryCsv: async () => "", naverBond: async () => null, usQuotes: async () => new Map(), krQuotes: async () => new Map(),
    krSectors: async () => ({ themes: [], note: null }), news: async () => [], holdings: async () => [],
  };
}

describe("알림 대기에서 분리된 시장 요약의 종료 경계", () => {
  it("알림 대기 뒤 계속 만드는 시장 요약은 DB 종료 전 저장을 마친다", async () => {
    const normal = await setup({ marketSummary: marketSources(), now: () => MARKET_AT });
    const expected = await normal.app.marketSummaries!.generate("afternoon", { date: "2026-09-28" });
    const sources = marketSources();
    const original = sources.indices;
    const block = gate();
    let collecting = false;
    sources.indices = async () => { collecting = true; await block.promise; return original(); };
    const h = await setup({ marketSummary: sources, now: () => MARKET_AT });
    const summary = h.app.marketSummaries!;
    expect(await summary.afterRun({ session: "afternoon", date: "2026-09-28", partial: false }, { waitMs: 0 })).toBeNull();
    expect(collecting).toBe(true);
    expect(summary.isRunning).toBe(true);
    let closeFinished = false;
    const close = track(h.app.close().then(() => { closeFinished = true; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect.soft(closeFinished).toBe(false);
    block.release();
    await close;
    await vi.waitFor(() => expect(summary.isRunning).toBe(false));
    expect(expected).toMatchObject({ status: "ok" });
    expect(await summary.find("2026-09-28", "afternoon")).toEqual(expected);
    expect(h.gen.requests).toHaveLength(0);
  });

  it("플래그를 늦게 읽은 호출이 종료 뒤 새 자료 수집을 시작하지 않는다", async () => {
    const h = await setup();
    const sources = marketSources();
    const calls = vi.spyOn(sources, "indices");
    const block = gate();
    const summary = new MarketSummaryService({ db: h.db, sources, features: { enabled: async () => { await block.promise; return true; } }, now: () => MARKET_AT });
    const run = track(summary.generate("afternoon", { date: "2026-09-28" }));
    await summary.stop();
    block.release();
    expect(await run).toBeNull();
    expect(calls).not.toHaveBeenCalled();
    expect(await summary.find("2026-09-28", "afternoon")).toBeNull();
  });

  it("요약 저장 실패도 종료 회수를 풀되 생성 요청의 실패를 성공으로 바꾸지 않는다", async () => {
    const h = await setup();
    const sources = marketSources();
    const block = gate();
    const indices = sources.indices;
    let collecting = false;
    sources.indices = async () => { collecting = true; await block.promise; return indices(); };
    const summary = new MarketSummaryService({ db: h.db, sources, features: { enabled: async () => true }, now: () => MARKET_AT });
    const original = h.db.insertInto.bind(h.db);
    vi.spyOn(h.db, "insertInto").mockImplementation(((table: Parameters<Db["insertInto"]>[0]) => {
      if (table === "market_summaries") throw new Error("가짜 요약 저장 실패");
      return original(table);
    }) as Db["insertInto"]);
    const run = track(summary.generate("afternoon", { date: "2026-09-28" }));
    await vi.waitFor(() => expect(collecting).toBe(true));
    const stop = track(summary.stop());
    block.release();
    await expect(run).rejects.toThrow("가짜 요약 저장 실패");
    await stop;
    expect(summary.isRunning).toBe(false);
    expect(await summary.find("2026-09-28", "afternoon")).toBeNull();
  });
});

describe("예약 보고서 실행 중 정상 종료 경계 — 가짜 시계·자료·모델", () => {
  it("예약 생성이 10초를 넘어도 종료 훅 제한으로 자원 정리가 먼저 진행되지 않는다", async () => {
    const h = await setup();
    const block = gate();
    h.gen.before = () => block.promise;
    const run = track(h.job.fire());
    await vi.waitFor(() => expect(h.gen.entered).toBe(true));
    const stopNotifications = vi.spyOn(h.app.notificationService, "stop");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let closed = false;
    let closeError: unknown;
    const close = track(h.app.close().then(() => { closed = true; }, (error: unknown) => { closed = true; closeError = error; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10_001);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect.soft(closed).toBe(false);
    expect.soft(closeError).toBeUndefined();
    expect.soft(stopNotifications).not.toHaveBeenCalled();
    block.release();
    await Promise.all([run, close]);
    expect(closeError).toBeUndefined();
    expect(stopNotifications).toHaveBeenCalledTimes(1);
    expect(await h.db.selectFrom("briefings").select(["status"]).execute()).toEqual([{ status: "ok" }]);
  });

  it("모델 생성 중 종료해도 예약 회차 저장과 완료 기록을 끝낸 뒤 닫는다", async () => {
    const h = await setup();
    const block = gate();
    h.gen.before = () => block.promise;
    const run = track(h.job.fire());
    await vi.waitFor(() => expect(h.gen.entered).toBe(true));
    let closed = false;
    const close = track(h.app.close().then(() => { closed = true; }));
    await vi.waitFor(() => expect(h.job.destroyed).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect.soft(closed).toBe(false);
    expect(h.app.briefingService.isRunning).toBe(true);
    block.release();
    await Promise.all([run, close]);
    expect(closed).toBe(true);
    expect(h.app.briefingService.isRunning).toBe(false);
    expect(await h.db.selectFrom("briefings").select(["status", "code"]).execute()).toEqual([{ status: "ok", code: "005930" }]);
    const log = await h.db.selectFrom("meta").select("value").where("key", "=", "briefing_run_log").executeTakeFirstOrThrow();
    expect(JSON.parse(log.value)).toEqual([expect.objectContaining({ trigger: "schedule", ok: 1, failed: 0 })]);
    expect(h.gen.requests).toHaveLength(2);
    expect(h.gen.requests).toEqual([
      expect.objectContaining({ maxTokens: 4096, effort: "medium", label: "briefing_detail:005930" }),
      expect.objectContaining({ maxTokens: 512, effort: "low", label: "briefing_summary:005930" }),
    ]);
  });

  it("종목 저장 뒤에도 계좌·알림 등 실행 완료 리스너가 끝나기 전에는 종료하지 않는다", async () => {
    const h = await setup();
    const block = gate();
    let finishing = false;
    h.app.briefingService.onRunDone(async () => { finishing = true; await block.promise; });
    const run = track(h.job.fire());
    await vi.waitFor(() => expect(finishing).toBe(true));
    let closed = false;
    const close = track(h.app.close().then(() => { closed = true; }));
    await vi.waitFor(() => expect(h.job.destroyed).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect.soft(closed).toBe(false);
    block.release();
    await Promise.all([run, close]);
    expect(h.app.briefingService.lastRun).toMatchObject({ trigger: "schedule", ok: 1, failed: 0 });
  });

  it("실행이 없으면 자료 수집·모델 호출 없이 종료한다", async () => {
    const h = await setup();
    await h.app.close();
    expect(h.job.destroyed).toBe(true);
    expect(h.gen.requests).toHaveLength(0);
    expect(await h.db.selectFrom("briefings").selectAll().execute()).toEqual([]);
  });

  it("수동 실행을 기다리는 예약도 함께 회수하며 방금 저장한 종목을 중복 생성하지 않는다", async () => {
    const h = await setup();
    const block = gate();
    h.gen.before = () => block.promise;
    const manual = track(h.app.briefingService.runSession("morning", { force: true }));
    await vi.waitFor(() => expect(h.gen.entered).toBe(true));
    const scheduled = track(h.job.fire());
    let closed = false;
    const close = track(h.app.close().then(() => { closed = true; }));
    await vi.waitFor(() => expect(h.job.destroyed).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    block.release();
    await Promise.all([manual, scheduled, close]);
    expect(h.gen.requests).toHaveLength(2);
    expect(h.app.briefingService.lastRun).toMatchObject({ trigger: "schedule", ok: 1, failed: 0 });
  });

  it("종료를 시작하면 남은 예약 콜백과 설정 변경으로 새 생성이 시작되지 않는다", async () => {
    const h = await setup();
    await h.app.close();
    await h.job.fire();
    h.app.scheduler!.reschedule({ morningCron: "0 9 * * 1-5", afternoonCron: null });
    expect(h.app.scheduler!.status().jobs).toEqual([]);
    expect(h.gen.requests).toHaveLength(0);
  });

  it("정상 실행과 종료 회수 실행의 입력·설정·본문은 같고 추가 호출이 없다", async () => {
    const normal = await setup();
    await normal.job.fire();
    const closing = await setup();
    const block = gate();
    closing.gen.before = () => block.promise;
    const run = track(closing.job.fire());
    await vi.waitFor(() => expect(closing.gen.entered).toBe(true));
    const close = track(closing.app.close());
    await vi.waitFor(() => expect(closing.job.destroyed).toBe(true));
    block.release();
    await Promise.all([run, close]);
    expect(closing.gen.requests).toEqual(normal.gen.requests);
    expect(closing.gen.requests).toHaveLength(2);
    expect(await closing.db.selectFrom("briefings").selectAll().execute()).toEqual(await normal.db.selectFrom("briefings").selectAll().execute());
  });

  it("저장 예외가 나도 종료 회수가 무한 대기하지 않고 실행 중단 기록을 남긴다", async () => {
    const h = await setup();
    const block = gate();
    h.gen.before = () => block.promise;
    const original = Kysely.prototype.insertInto;
    vi.spyOn(Kysely.prototype, "insertInto").mockImplementation((function (this: Db, table: Parameters<Db["insertInto"]>[0]) {
      if (table === "briefings") throw new Error("가짜 저장 실패");
      return original.call(this, table);
    }) as Db["insertInto"]);
    const run = track(h.job.fire());
    await vi.waitFor(() => expect(h.gen.entered).toBe(true));
    const close = track(h.app.close());
    block.release();
    await Promise.all([run, close]);
    expect(h.app.briefingService.isRunning).toBe(false);
    expect(h.app.briefingService.lastRun).toMatchObject({ total: 1, ok: 0, failed: 0, lastError: expect.any(String) });
    expect(await h.db.selectFrom("briefings").selectAll().execute()).toEqual([]);
  });

  it("예약 사전 작업 중 종료도 그 작업과 보고서 완료를 회수한다", async () => {
    const h = await setup();
    const block = gate();
    let preparing = false;
    const scheduler = new BriefingScheduler(h.app.briefingService, {
      morningCron: "30 8 * * 1-5", afternoonCron: null, now: () => AT,
      beforeRun: async () => { preparing = true; await block.promise; },
    });
    scheduler.start();
    const job = cronJobs.at(-1)!;
    const run = track(job.fire());
    expect(preparing).toBe(true);
    let stopped = false;
    const stop = track(scheduler.shutdown().then(() => { stopped = true; }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(h.gen.requests).toHaveLength(0);
    block.release();
    await Promise.all([run, stop]);
    expect(h.app.briefingService.lastRun).toMatchObject({ trigger: "schedule", ok: 1 });
    expect(h.gen.requests).toHaveLength(2);
  });
});

describe("다른 서비스 인스턴스 사이의 DB 작업 공유 — 운영 재현 아님", () => {
  it("다른 분석 서비스도 동일 요청의 진행 상태를 확인하고 재전송은 기존 생성에 합류한다", async () => {
    const h = await setup();
    const collector = new DataCollector({ quotes: new FakeQuoteProvider("가짜시세"), news: new FakeNewsProvider(), financials: null, investorFlow: null, now: () => AT });
    const second = new AnalysisService({ db: h.db, collector, generator: h.gen, prompts: new PromptStore(), now: () => AT });
    const block = gate();
    h.gen.before = () => block.promise;
    const first = track(h.app.analysisService.getTracked("005930", "company", "restart-same-request", { refresh: true }));
    await vi.waitFor(() => expect(h.gen.entered).toBe(true));
    expect(await second.state("005930", "company", "restart-same-request"))
      .toMatchObject({ running: true, request: { status: "pending", result: null } });
    const duplicate = track(second.getTracked("005930", "company", "restart-same-request", { refresh: true }));
    block.release();
    const [one, two] = await Promise.all([first, duplicate]);
    expect(one.id).toBe(two.id);
    expect(h.gen.requests).toHaveLength(1);
    expect(await h.db.selectFrom("analyses").selectAll().execute()).toHaveLength(1);
  });

  it("두 브리핑 서비스가 같은 회차를 함께 시작해도 상세·요약 모델 작업과 저장 결과를 공유한다", async () => {
    const h = await setup();
    const collector = new DataCollector({ quotes: new FakeQuoteProvider("가짜시세"), news: new FakeNewsProvider(), financials: null, investorFlow: null, now: () => AT });
    const second = new BriefingService({ db: h.db, collector, generator: h.gen, prompts: new PromptStore(), now: () => AT });
    const block = gate();
    h.gen.before = () => block.promise;
    const first = track(h.app.briefingService.runSession("morning"));
    await vi.waitFor(() => expect(h.gen.entered).toBe(true));
    expect(second.isRunning).toBe(false);
    const duplicate = track(second.runSession("morning"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    block.release();
    const results = await Promise.all([first, duplicate]);
    expect(results[1]).toEqual(results[0]);
    expect(h.gen.requests).toHaveLength(2);
    expect(await h.db.selectFrom("briefings").selectAll().execute()).toHaveLength(1);
  });
});
