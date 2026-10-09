import { afterEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { RegisteredStock } from "../src/domain/types.js";
import type { GenerateRequest, GenerateResult } from "../src/llm/generator.js";
import { PromptStore, type PromptName } from "../src/llm/prompts.js";
import { BriefingService, type RunResult, type SessionDone } from "../src/services/briefingService.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeGenerator, FakeInvestorFlow, FakeNewsProvider, FakeQuoteProvider } from "./helpers.js";

const CODES = ["000660", "005930", "005935", "247540"];
const AT = new Date("2026-09-22T09:00:00+09:00");
const databases: Db[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

class ControlledGenerator extends FakeGenerator {
  started: string[] = [];
  active = 0;
  peak = 0;
  before: (request: GenerateRequest) => Promise<void> = async () => {};

  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.started.push(request.label!);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await this.before(request);
      return await super.generate(request);
    } finally {
      this.active--;
    }
  }
}

async function setup(options: { parallel?: (() => Promise<boolean>) | null; safe?: boolean; count?: number } = {}) {
  const db = await createMigratedDb(":memory:");
  databases.push(db);
  const codes = CODES.slice(0, options.count ?? 4);
  for (const [index, code] of codes.entries()) {
    await db.insertInto("registered_stocks").values({
      code, name: `종목 ${code}`, market: "KOSPI", quantity: index + 1, avg_price: 90_000,
      memo: "그대로 보존", created_at: `2026-09-01T09:00:0${index}+09:00`, updated_at: AT.toISOString(),
    }).execute();
  }
  const gen = new ControlledGenerator();
  const collector = new DataCollector({
    quotes: new FakeQuoteProvider("가짜시세"), news: new FakeNewsProvider(), financials: null,
    investorFlow: new FakeInvestorFlow(), now: () => AT,
  });
  const warm = vi.spyOn(collector, "warm");
  const prompts = new PromptStore();
  const calendar = { isTradingDate: vi.fn(async () => true) };
  const parallel = options.parallel === null ? undefined : options.parallel ?? (async () => true);
  const service = new BriefingService({
    db, collector, generator: gen, prompts, calendar, now: () => AT,
    safeWording: async () => options.safe ?? true,
    ...(parallel ? { parallel } : {}),
  });
  const run = (opts: Parameters<BriefingService["runSession"]>[1] = {}) => {
    const result = service.runSession("morning", opts);
    // 실패를 나중에 검증하는 테스트도 거절된 Promise 를 방치하지 않는다.
    pending.push(result.then(() => {}, () => {}));
    return result;
  };
  return { db, codes, gen, collector, warm, prompts, service, calendar, run };
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.destroy();
});

describe("두 종목 브리핑 준비와 순서 보존", () => {
  it.each([false, true])("안전 문구 %s: 순차 실행과 프롬프트·설정·자료·결과가 같다", async (safe) => {
    const sequential = await setup({ parallel: async () => false, safe });
    const parallel = await setup({ safe });
    for (const h of [sequential, parallel]) {
      await h.db.insertInto("briefings").values({
        code: CODES[0]!, session: "afternoon", briefing_date: "2026-09-21", status: "ok", summary: "직전 뉴스 요약",
        detail: "직전 상세", data_snapshot: "{}", missing_data: "[]", model: "기존모델", error: null, created_at: "2026-09-21T16:00:00+09:00",
      }).execute();
    }
    expect(await parallel.run()).toEqual(await sequential.run());
    const byLabel = (requests: GenerateRequest[]) => [...requests].sort((a, b) => a.label!.localeCompare(b.label!));
    expect(byLabel(parallel.gen.requests)).toEqual(byLabel(sequential.gen.requests));
    expect(parallel.gen.requests).toHaveLength(8);
    for (const code of CODES) {
      const detail = parallel.gen.requests.find((r) => r.label === `briefing_detail:${code}`)!;
      const summary = parallel.gen.requests.find((r) => r.label === `briefing_summary:${code}`)!;
      expect(detail).toMatchObject({ maxTokens: 4096, effort: "medium" });
      expect(summary).toMatchObject({ maxTokens: 512, effort: "low" });
      const saved = await parallel.service.find(code, "2026-09-22", "morning");
      expect(summary.user).toContain(saved!.detail);
      expect(saved!.model).toBe("fake-model");
    }
    expect(await parallel.db.selectFrom("briefings").selectAll().orderBy("id").execute())
      .toEqual(await sequential.db.selectFrom("briefings").selectAll().orderBy("id").execute());
    expect(parallel.service.lastRun).toEqual(sequential.service.lastRun);
    expect(parallel.warm).toHaveBeenCalledExactlyOnceWith(CODES);
    expect(parallel.calendar.isTradingDate).toHaveBeenCalledExactlyOnceWith("KR", "2026-09-22");
  });

  it("최대 두 종목만 준비하며 뒤 종목이 먼저 끝나도 저장·알림·결과는 등록 순서다", async () => {
    const read = vi.fn(async () => true);
    const h = await setup({ parallel: read });
    const gates = CODES.map(() => gate());
    h.gen.before = async (request) => {
      if (request.label!.startsWith("briefing_detail:")) await gates[CODES.indexOf(request.label!.split(":")[1]!)]!.promise;
    };
    const seen: string[] = [];
    h.service.onBriefing((b) => { seen.push(b.code); });
    const result = h.run();
    await vi.waitFor(() => expect(h.gen.started).toHaveLength(2));
    expect(h.gen.peak).toBe(2);
    await expect(h.run()).rejects.toThrow("브리핑이 이미 실행 중입니다");
    gates[1]!.release();
    await vi.waitFor(() => expect(h.gen.requests.some((r) => r.label === `briefing_summary:${CODES[1]}`)).toBe(true));
    expect(await h.db.selectFrom("briefings").selectAll().execute()).toEqual([]);
    expect(seen).toEqual([]);
    expect(h.service.progress?.done).toBe(0);
    expect(h.gen.started.some((label) => label.endsWith(CODES[2]!))).toBe(false);
    gates[0]!.release();
    await vi.waitFor(() => expect(h.gen.started.filter((label) => label.startsWith("briefing_detail:"))).toHaveLength(4));
    expect(h.service.progress?.done).toBe(2);
    gates[3]!.release();
    await vi.waitFor(() => expect(h.gen.requests.some((r) => r.label === `briefing_summary:${CODES[3]}`)).toBe(true));
    expect(seen).toEqual(CODES.slice(0, 2));
    gates[2]!.release();
    expect((await result).results.map((r) => r.code)).toEqual(CODES);
    expect((await h.db.selectFrom("briefings").select("code").orderBy("id").execute()).map((r) => r.code)).toEqual(CODES);
    expect(seen).toEqual(CODES);
    expect(h.gen.peak).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("종목 알림과 실행 완료 리스너가 끝날 때까지 잠금을 지키고 대기 실행을 깨우지 않는다", async () => {
    const h = await setup({ count: 2 });
    const itemGate = gate();
    const doneGate = gate();
    const events: string[] = [];
    h.service.onBriefing(async (b) => {
      events.push(b.code);
      if (b.code === CODES[0]) await itemGate.promise;
    });
    h.service.onSessionDone((done) => { events.push(`세션:${done.created.length}`); });
    h.service.onRunDone(async () => { events.push("완료"); await doneGate.promise; });
    const first = h.run();
    await vi.waitFor(() => expect(events).toEqual([CODES[0]]));
    const queued = h.run({ wait: true });
    expect(h.service.isRunning).toBe(true);
    expect(h.service.progress?.done).toBe(0);
    expect(await h.db.selectFrom("briefings").selectAll().execute()).toHaveLength(1);
    itemGate.release();
    await vi.waitFor(() => expect(events).toEqual([CODES[0], CODES[1], "세션:2", "완료"]));
    expect(h.service.isRunning).toBe(true);
    expect(h.service.progress?.done).toBe(2);
    expect(h.gen.requests).toHaveLength(4);
    doneGate.release();
    await first;
    const second = await queued;
    expect(second.results).toHaveLength(2);
    expect(h.gen.requests).toHaveLength(4);
    expect(events).toEqual([CODES[0], CODES[1], "세션:2", "완료", "완료"]);
    expect(h.service.isRunning).toBe(false);
    expect(h.service.progress).toBeNull();
  });

  it.each(["api", "truncated"] as const)("모델 %s 실패는 다음 종목을 막지 않고 이전 성공을 지우지 않는다", async (kind) => {
    const h = await setup({ count: 3 });
    const first = await h.run();
    const old = await h.service.find(CODES[1]!, "2026-09-22", "morning");
    h.gen.opts = { failKind: kind, failOnLabel: `briefing_summary:${CODES[1]}` };
    const created: string[] = [];
    h.service.onBriefing((b) => { created.push(b.code); });
    const result = await h.run({ force: true });
    expect(result.results.map((r) => r.status)).toEqual(["ok", "failed", "ok"]);
    expect(result.results[1]).toMatchObject({ briefingId: first.results[1]!.briefingId, summary: null });
    expect(result.results[1]!.error).toContain("이전 브리핑은 그대로 둡니다");
    expect(await h.service.find(CODES[1]!, "2026-09-22", "morning")).toEqual(old);
    expect(created).toEqual([CODES[0], CODES[2]]);
    expect(h.service.lastRun).toMatchObject({ ok: 2, failed: 1, skipped: 0 });
  });

  it("뒤 종목 수집 예외는 앞 종목 완료까지 기다리고 이후 종목을 시작하지 않는다", async () => {
    const h = await setup();
    const firstGate = gate();
    h.gen.before = async (r) => { if (r.label === `briefing_detail:${CODES[0]}`) await firstGate.promise; };
    const collect = h.collector.collectBriefing.bind(h.collector);
    const fatal = new Error("뒤 종목 수집 예외");
    const spy = vi.spyOn(h.collector, "collectBriefing").mockImplementation(async (stock) => {
      if (stock.code === CODES[1]) throw fatal;
      return collect(stock);
    });
    const finished: Array<SessionDone & { results: RunResult["results"] }> = [];
    h.service.onRunDone((done) => { finished.push(done); });
    const result = h.run();
    await vi.waitFor(() => expect(h.gen.started).toEqual([`briefing_detail:${CODES[0]}`]));
    expect(h.service.isRunning).toBe(true);
    expect(finished).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
    firstGate.release();
    await expect(result).rejects.toBe(fatal);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.results.map((r) => r.code)).toEqual([CODES[0]]);
    expect((await h.db.selectFrom("briefings").select("code").execute()).map((r) => r.code)).toEqual([CODES[0]]);
    expect(h.service.isRunning).toBe(false);
  });

  it.each(["수집", "저장"])("앞 종목 %s 예외 뒤에는 이미 시작한 작업을 회수하고 늦은 저장·알림을 막는다", async (stage) => {
    const h = await setup();
    const firstGate = gate();
    const secondGate = gate();
    const fatal = new Error(`${stage} 예외`);
    const collect = h.collector.collectBriefing.bind(h.collector);
    vi.spyOn(h.collector, "collectBriefing").mockImplementation(async (stock) => {
      if (stage === "수집" && stock.code === CODES[0]) { await firstGate.promise; throw fatal; }
      return collect(stock);
    });
    h.gen.before = async (r) => {
      if (r.label === `briefing_detail:${CODES[0]}`) await firstGate.promise;
      if (r.label === `briefing_detail:${CODES[1]}`) await secondGate.promise;
    };
    if (stage === "저장") {
      const insert = Kysely.prototype.insertInto;
      vi.spyOn(Kysely.prototype, "insertInto").mockImplementation((function (this: Db, table: Parameters<Db["insertInto"]>[0]) {
        if (table === "briefings") throw fatal;
        return insert.call(this, table);
      }) as Db["insertInto"]);
    }
    const seen: string[] = [];
    h.service.onBriefing((b) => { seen.push(b.code); });
    h.service.onRunDone(() => { seen.push("완료"); });
    const result = h.run();
    await vi.waitFor(() => expect(h.gen.started).toContain(`briefing_detail:${CODES[1]}`));
    firstGate.release();
    // 앞 작업의 실패를 처리하는 동안 뒤 작업은 여전히 대기한다.
    await vi.waitFor(() => expect(h.gen.active).toBe(1));
    expect(h.service.isRunning).toBe(true);
    expect(seen).toEqual([]);
    secondGate.release();
    await expect(result).rejects.toBe(fatal);
    expect(seen).toEqual(["완료"]);
    expect(await h.db.selectFrom("briefings").selectAll().execute()).toEqual([]);
    expect(h.gen.started.some((label) => label.endsWith(CODES[2]!))).toBe(false);
    expect(h.gen.active).toBe(0);
    expect(h.service.isRunning).toBe(false);
  });

  it.each(["끔", "없음", "읽기 실패"])("플래그 %s이면 기존 상세·요약 순서를 그대로 지킨다", async (mode) => {
    const read = vi.fn(async () => { if (mode === "읽기 실패") throw new Error("플래그 오류"); return false; });
    const h = await setup({ parallel: mode === "없음" ? null : read, count: 2 });
    await h.run();
    expect(h.gen.started).toEqual(CODES.slice(0, 2).flatMap((code) => [`briefing_detail:${code}`, `briefing_summary:${code}`]));
    expect(h.gen.peak).toBe(1);
    expect(read).toHaveBeenCalledTimes(mode === "없음" ? 0 : 1);
  });

  it("가짜 모델의 같은 지연 네 종목은 품질 설정을 그대로 두고 준비 시간이 반으로 준다", async () => {
    const sequential = await setup({ parallel: async () => false });
    const parallel = await setup();
    // 실제 프롬프트·고정 자료를 먼저 읽고, 가짜 시계 안에서는 파일·네트워크를 기다리지 않는다.
    for (const h of [sequential, parallel]) {
      const rows = await h.db.selectFrom("registered_stocks").selectAll().execute();
      const snapshots = new Map(await Promise.all(rows.map(async (row) => {
        const stock: RegisteredStock = { code: row.code, name: row.name, market: "KOSPI", quantity: row.quantity, avgPrice: row.avg_price, memo: row.memo, createdAt: row.created_at, updatedAt: row.updated_at };
        return [row.code, await h.collector.collectBriefing(stock)] as const;
      })));
      vi.spyOn(h.collector, "collectBriefing").mockImplementation(async (stock) => snapshots.get(stock.code)!);
      const names: PromptName[] = ["briefing_detail_safe", "briefing_summary_safe"];
      const templates = new Map(await Promise.all(names.map(async (name) => [name, await h.prompts.load(name)] as const)));
      vi.spyOn(h.prompts, "load").mockImplementation(async (name) => templates.get(name)!);
      h.gen.before = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); };
    }
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const measure = async (h: typeof parallel) => {
      const startedAt = Date.now();
      const result = h.run();
      await vi.runAllTimersAsync();
      await result;
      return Date.now() - startedAt;
    };
    expect(await measure(sequential)).toBe(80);
    expect(await measure(parallel)).toBe(40);
    expect(sequential.gen.requests).toHaveLength(8);
    expect(parallel.gen.requests).toHaveLength(8);
    expect(parallel.gen.peak).toBe(2);
  });
});
