import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { RegisteredStock } from "../src/domain/types.js";
import { GenerationError, type GenerateRequest } from "../src/llm/generator.js";
import { PromptStore } from "../src/llm/prompts.js";
import { AnalysisService } from "../src/services/analysisService.js";
import { BriefingService } from "../src/services/briefingService.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeGenerator, FakeNewsProvider, FakeQuoteProvider } from "./helpers.js";

const AT = new Date("2026-12-28T08:30:00+09:00");
const STOCK: RegisteredStock = { code: "005930", name: "삼성전자", market: "KOSPI", quantity: 2, avgPrice: 90_000, memo: "계정 메모 원문", createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
const databases: Db[] = [];
// 트랜잭션도 상속하는 삽입 경계에서 보고서 표만 계측한다. 작업 소유권 표의 쓰기는 이 모의 지연 대상이 아니다.
const insertInto = Kysely.prototype.insertInto;
let elapsed = 0;
type Log = { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
const logger = (): Log => ({ info: vi.fn(), warn: vi.fn() });
const timings = (log: Log) => log.info.mock.calls.filter((call) => call[1] === "보고서 단계별 소요 시간").map((call) => call[0] as { report: string; status: string; stagesMs: Record<string, number>; totalMs: number; failedStage?: string });

async function setup(log?: Log, fail?: "수집" | "프롬프트" | "모델" | "요약" | "저장") {
  const db = await createMigratedDb(":memory:");
  databases.push(db);
  await db.insertInto("registered_stocks").values({ code: STOCK.code, name: STOCK.name, market: STOCK.market, quantity: STOCK.quantity, avg_price: STOCK.avgPrice, memo: STOCK.memo, created_at: STOCK.createdAt, updated_at: STOCK.updatedAt }).execute();
  const collector = new DataCollector({ quotes: new FakeQuoteProvider("시험시세"), news: new FakeNewsProvider(), financials: null, investorFlow: null, now: () => AT });
  const analysisCollect = collector.collectAnalysis.bind(collector);
  const briefingCollect = collector.collectBriefing.bind(collector);
  const collected = vi.spyOn(collector, "collectAnalysis").mockImplementation(async (...args) => {
    elapsed += 17;
    if (fail === "수집") throw new Error("저장하면 안 되는 수집 오류 원문");
    return analysisCollect(...args);
  });
  const collectedBriefing = vi.spyOn(collector, "collectBriefing").mockImplementation(async (...args) => {
    elapsed += 17;
    if (fail === "수집") throw new Error("저장하면 안 되는 수집 오류 원문");
    return briefingCollect(...args);
  });
  const prompts = new PromptStore();
  vi.spyOn(prompts, "load").mockImplementation(async (name) => {
    elapsed += 3;
    if (fail === "프롬프트") throw new Error("저장하면 안 되는 프롬프트 오류 원문");
    return { name, system: "동일한 시스템 글", userTemplate: "{{stock_name}} {{data_json}} {{detail}}" };
  });
  const gen = new FakeGenerator();
  const generate = gen.generate.bind(gen);
  vi.spyOn(gen, "generate").mockImplementation(async (req: GenerateRequest) => {
    elapsed += req.label?.startsWith("briefing_summary") ? 11 : 23;
    if (fail === "모델") throw new GenerationError("저장하면 안 되는 모델 오류 원문", "api");
    if (fail === "요약" && req.label?.startsWith("briefing_summary")) throw new GenerationError("저장하면 안 되는 요약 오류 원문", "api");
    return generate(req);
  });
  vi.spyOn(Kysely.prototype, "insertInto").mockImplementation((function (this: Db, table: Parameters<Db["insertInto"]>[0]) {
    if (table === "analyses" || table === "briefings") {
      elapsed += 7;
      if (fail === "저장") throw new Error("저장하면 안 되는 DB 오류 원문");
    }
    return insertInto.call(this, table);
  }) as Db["insertInto"]);
  const deps = { db, collector, generator: gen, prompts, now: () => AT, log };
  return { db, gen, collected, collectedBriefing, analysis: new AnalysisService(deps), briefing: new BriefingService(deps) };
}
beforeEach(() => { elapsed = 0; vi.spyOn(performance, "now").mockImplementation(() => elapsed); });
afterEach(async () => { vi.restoreAllMocks(); for (const db of databases.splice(0)) await db.destroy(); });

describe("보고서 단계별 단조시계 계측", () => {
  it("분석은 수집·프롬프트·모델·저장 시간을 한 줄에 기록하고 자료·생성 입력·저장 결과는 그대로다", async () => {
    const log = logger();
    const plain = await setup();
    const measured = await setup(log);
    expect(await measured.analysis.get(STOCK.code, "company")).toEqual(await plain.analysis.get(STOCK.code, "company"));
    expect(measured.gen.requests).toEqual(plain.gen.requests);
    expect(measured.gen.requests).toHaveLength(1);
    expect(measured.collected).toHaveBeenCalledTimes(1);
    expect(await measured.db.selectFrom("analyses").selectAll().execute()).toEqual(await plain.db.selectFrom("analyses").selectAll().execute());
    expect(timings(log)).toEqual([{ report: "분석", kind: "company", status: "완료", stagesMs: { "자료 수집": 17, "프롬프트": 3, "모델 생성": 23, "저장": 7 }, totalMs: 50 }]);
  });

  it("브리핑은 상세·요약·저장·완료 처리를 나눠 기록하며 모델 두 번과 기존 저장 내용을 유지한다", async () => {
    const log = logger();
    const plain = await setup();
    const measured = await setup(log);
    measured.briefing.onBriefing(() => { elapsed += 5; });
    expect(await measured.briefing.generateOne(STOCK, "morning")).toEqual(await plain.briefing.generateOne(STOCK, "morning"));
    expect(measured.gen.requests).toEqual(plain.gen.requests);
    expect(measured.gen.requests).toHaveLength(2);
    expect(measured.collectedBriefing).toHaveBeenCalledTimes(1);
    expect(await measured.db.selectFrom("briefings").selectAll().execute()).toEqual(await plain.db.selectFrom("briefings").selectAll().execute());
    expect(timings(log)).toEqual([{ report: "브리핑", session: "morning", status: "완료", stagesMs: { "자료 수집": 17, "프롬프트": 6, "모델 상세": 23, "요약": 11, "저장 대기": 0, "저장": 7, "완료 처리": 5 }, totalMs: 69 }]);
  });

  it.each(["분석", "브리핑"])("%s: 로거가 예외를 던져도 보고서 결과·DB 내용·모델 입력이 달라지지 않는다", async (report) => {
    const log = { info: vi.fn(() => { throw new Error("로거 실패"); }), warn: vi.fn(() => { throw new Error("로거 실패"); }) };
    const plain = await setup();
    const measured = await setup(log);
    const run = (h: Awaited<ReturnType<typeof setup>>) => report === "분석" ? h.analysis.get(STOCK.code, "company") : h.briefing.generateOne(STOCK, "morning");
    expect(await run(measured)).toEqual(await run(plain));
    expect(measured.gen.requests).toEqual(plain.gen.requests);
    const table = report === "분석" ? "analyses" : "briefings";
    expect(await measured.db.selectFrom(table).selectAll().execute()).toEqual(await plain.db.selectFrom(table).selectAll().execute());
  });

  it.each([
    ...["분석", "브리핑"].flatMap((report) => (["수집", "프롬프트", "모델", "저장"] as const).map((fail) => ({ report, fail }))),
    { report: "브리핑", fail: "요약" as const },
  ])(
    "$report $fail 실패: 진행한 단계 시간만 남기고 오류 원문·자료·계정값을 새 로그에 넣지 않는다",
    async ({ report, fail }) => {
      const log = logger();
      const h = await setup(log, fail);
      const result = report === "분석" ? h.analysis.get(STOCK.code, "company") : h.briefing.generateOne(STOCK, "morning");
      if (report === "브리핑" && ["프롬프트", "모델", "요약"].includes(fail)) expect((await result as { status: string }).status).toBe("failed");
      else await expect(result).rejects.toThrow();
      const entries = timings(log);
      expect(entries).toHaveLength(1);
      const stage = fail === "수집" ? "자료 수집" : fail === "모델" ? report === "분석" ? "모델 생성" : "모델 상세" : fail;
      expect(entries[0]).toMatchObject({ report, status: "실패", failedStage: stage });
      expect(Object.values(entries[0]!.stagesMs).reduce((a, b) => a + b, 0)).toBe(entries[0]!.totalMs);
      expect(entries[0]!.totalMs).toBeGreaterThan(0);
      const serialized = JSON.stringify(entries);
      for (const value of [STOCK.code, STOCK.name, STOCK.memo!, "오류 원문", "시스템 글", "data_snapshot", "usage", "token"]) expect(serialized).not.toContain(value);
    },
  );

  it.each(["분석", "브리핑"])("%s 실패 중 로거도 실패해도 원래 오류·실패 저장 결과를 보존한다", async (report) => {
    const log = { info: vi.fn(() => { throw new Error("로거 실패"); }), warn: vi.fn(() => { throw new Error("로거 실패"); }) };
    const h = await setup(log, "모델");
    if (report === "분석") await expect(h.analysis.get(STOCK.code, "company")).rejects.toThrow("저장하면 안 되는 모델 오류 원문");
    else {
      const result = await h.briefing.generateOne(STOCK, "morning");
      expect(result.status).toBe("failed");
      expect(result.error).toBe("api: 저장하면 안 되는 모델 오류 원문");
      expect(await h.briefing.find(STOCK.code, "2026-12-28", "morning")).toEqual(result);
    }
  });

  it("캐시·동일 진행 요청·상태 조회는 새 생성이나 계측 로그를 만들지 않는다", async () => {
    const log = logger();
    const h = await setup(log);
    const first = h.analysis.get(STOCK.code, "company", { refresh: true });
    const joined = h.analysis.get(STOCK.code, "company", { refresh: true });
    expect(await joined).toEqual(await first);
    await h.analysis.get(STOCK.code, "company");
    await h.analysis.state(STOCK.code, "company");
    expect(timings(log)).toHaveLength(1);
    expect(h.gen.requests).toHaveLength(1);
  });
});
