import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { DisabledGenerator, GenerationError, type GenerateRequest, type GenerateResult } from "../src/llm/generator.js";
import { BriefingScheduler, scheduledAtFor } from "../src/scheduler.js";
import type { BriefingService, RunProgress } from "../src/services/briefingService.js";
import {
  failureKind,
  judgeStatus,
  nextRunAt,
  pickSession,
  RUN_LOG_KEY,
  runLogEntry,
  type BriefingStatus,
  type JudgeInput,
  type RunLogEntry,
  type ScheduleSettings,
} from "../src/services/briefingStatus.js";
import { seoulDate } from "../src/lib/time.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

/**
 * 브리핑 3차 2 — 늦음·실패 안내 (플래그 briefingStatus). 시계는 모두 고정:
 * 월 9/28 08:38 · 금 9/25 추석 16:20 · 월 10/26 08:38 · 11/2(월, 미국 서머타임 끝난 뒤) · 12/28 월(미국 12/25 휴장 다음)
 */
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/briefingFailure.json", import.meta.url), "utf8")) as { cases: Array<{ error: string | null; kind: string }> };

const kst = (s: string) => new Date(`${s}+09:00`);
const iso = (s: string) => `${s}+09:00`;
const SETTINGS: ScheduleSettings = { morningTime: "08:30", afternoonTime: "16:00", morningEnabled: true, afternoonEnabled: true, weekdaysOnly: true };

/** 사용자 계좌와 비슷한 17종목: 국내 5 + 미국 12 (등록순) */
const KR = [
  ["005930", "삼성전자"],
  ["000660", "SK하이닉스"],
  ["035420", "NAVER"],
  ["035720", "카카오"],
  ["005380", "현대차"],
] as const;
const US = [
  ["TSLA", "테슬라"],
  ["PLTR", "팔란티어"],
  ["NVDA", "엔비디아"],
  ["MSFT", "마이크로소프트"],
  ["AAPL", "애플"],
  ["AVGO", "브로드컴"],
  ["META", "메타"],
  ["SOXL", "SOXL"],
  ["RGTX", "RGTX"],
  ["O", "리얼티인컴"],
  ["MS", "모건스탠리"],
  ["GOOGL", "알파벳"],
] as const;
const STOCKS = [...KR, ...US].map(([code, name], n) => ({ code, name, createdAt: iso(`2026-09-01T10:${String(n).padStart(2, "0")}:00`) }));

const RATE_LIMIT = "api: API 사용량 제한에 걸렸습니다 (429). 잠시 뒤 다시 시도해 주세요";
const NO_KEY = "config: API 키/자격 증명이 올바르지 않습니다 (401)";

/** 그 회차 줄: 모두 성공(08:31~), fail 에 적은 종목은 실패, missing 에 적은 종목은 줄 없음 */
function rowsFor(date: string, opts: { fail?: Record<string, string>; missing?: string[]; codes?: string[]; at?: string } = {}) {
  const codes = opts.codes ?? STOCKS.map((s) => s.code);
  return codes
    .filter((c) => !opts.missing?.includes(c))
    .map((code, n) => ({ id: 100 + n, code, status: opts.fail?.[code] ? "failed" : "ok", error: opts.fail?.[code] ?? null, createdAt: iso(`${date}T${opts.at ?? "08:31"}:${String(n).padStart(2, "0")}`) }));
}

function entry(over: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    session: "morning", date: "2026-09-28", trigger: "schedule", partial: false,
    scheduledAt: iso("2026-09-28T08:30:00"), firedAt: iso("2026-09-28T08:30:00"), startedAt: iso("2026-09-28T08:30:31"), finishedAt: iso("2026-09-28T08:38:40"),
    total: 17, ok: 17, failed: 0, skipped: 0, skippedCodes: [],
    ...over,
  };
}

function input(now: string, over: Partial<JudgeInput> = {}): JudgeInput {
  const at = kst(now);
  const runs = over.runs ?? [entry()];
  const settings = SETTINGS;
  return {
    now: at,
    llmConfigured: true,
    pick: pickSession(at, settings, runs),
    running: null,
    bootAt: kst("2026-09-27T12:00:00"),
    stocks: STOCKS,
    rows: rowsFor("2026-09-28"),
    trading: { KR: true, US: true },
    runs,
    nextRunAt: nextRunAt(at, settings),
    manualRun: true,
    ...over,
  };
}

describe("오류 글 → 종류 (공용 픽스처 — 앱과 같은 표)", () => {
  it.each(fixture.cases)("$error → $kind", ({ error, kind }) => expect(failureKind(error)).toBe(kind));
});

describe("회차 고르기 · 다음 브리핑 시각", () => {
  it("월 08:29 는 회차 없음, 08:30 부터 오전, 16:00 부터 오후", () => {
    expect(pickSession(kst("2026-09-28T08:29:59"), SETTINGS, [])).toBeNull();
    expect(pickSession(kst("2026-09-28T08:30:00"), SETTINGS, [])).toEqual({ session: "morning", date: "2026-09-28", scheduledAt: iso("2026-09-28T08:30:00") });
    expect(pickSession(kst("2026-09-28T16:20:00"), SETTINGS, [])?.session).toBe("afternoon");
  });
  it("평일만이면 토·일은 없음, 매일이면 있음 · 끈 세션은 고르지 않음", () => {
    expect(pickSession(kst("2026-10-03T09:00:00"), SETTINGS, [])).toBeNull();
    expect(pickSession(kst("2026-10-03T09:00:00"), { ...SETTINGS, weekdaysOnly: false }, [])?.session).toBe("morning");
    expect(pickSession(kst("2026-09-28T08:40:00"), { ...SETTINGS, morningEnabled: false }, [])).toBeNull();
    expect(pickSession(kst("2026-09-28T16:20:00"), { ...SETTINGS, afternoonEnabled: false }, [])?.session).toBe("morning");
  });
  it("그날 브리핑 시각을 09:00 으로 바꿔도 오늘 정기 실행 기록의 예약 시각(08:30)으로 본다", () => {
    const changed = { ...SETTINGS, morningTime: "09:00" };
    expect(pickSession(kst("2026-09-28T08:45:00"), changed, [])).toBeNull();
    expect(pickSession(kst("2026-09-28T08:45:00"), changed, [entry()])?.scheduledAt).toBe(iso("2026-09-28T08:30:00"));
  });
  it("다음 브리핑: 오전 뒤 16:00, 오후 뒤 다음 평일 08:30 (금 → 월), 둘 다 끄면 없음", () => {
    expect(nextRunAt(kst("2026-09-28T08:38:00"), SETTINGS)).toBe(iso("2026-09-28T16:00:00"));
    expect(nextRunAt(kst("2026-09-28T16:20:00"), SETTINGS)).toBe(iso("2026-09-29T08:30:00"));
    expect(nextRunAt(kst("2026-09-25T16:20:00"), SETTINGS)).toBe(iso("2026-09-28T08:30:00"));
    expect(nextRunAt(kst("2026-09-28T08:38:00"), { ...SETTINGS, morningEnabled: false, afternoonEnabled: false })).toBeNull();
  });
});

describe("판단 (고정 시계)", () => {
  it("정상: 08:38 완료 · 모두 성공 → ok (안 보임), 오류 원문 없음", () => {
    const s = judgeStatus(input("2026-09-28T08:39:00"));
    expect(s).toMatchObject({ state: "ok", late: false, total: 17, done: 17, problems: [], retryAt: null, nextRunAt: iso("2026-09-28T16:00:00") });
  });

  it("늦음: 예정 08:30 → 09:12 완료", () => {
    const s = judgeStatus(input("2026-09-28T09:13:00", { runs: [entry({ startedAt: iso("2026-09-28T09:04:00"), finishedAt: iso("2026-09-28T09:12:00") })] }));
    expect(s).toMatchObject({ state: "late", late: true, scheduledAt: iso("2026-09-28T08:30:00"), finishedAt: iso("2026-09-28T09:12:00") });
    // 20분 딱은 늦음이 아님
    expect(judgeStatus(input("2026-09-28T09:00:00", { runs: [entry({ finishedAt: iso("2026-09-28T08:50:00") })] })).state).toBe("ok");
  });

  it("일부 못 만듦: 429 두 건 → partial · 이유 붐빔 · 이름은 등록순 · 누르면 그 실패 브리핑", () => {
    const rows = rowsFor("2026-09-28", { fail: { TSLA: RATE_LIMIT, PLTR: RATE_LIMIT } });
    const s = judgeStatus(input("2026-09-28T08:40:00", { rows }));
    expect(s.state).toBe("partial");
    expect(s).toMatchObject({ total: 17, done: 15, reasonKind: "busy", late: false, finishedAt: iso("2026-09-28T08:38:40") });
    expect(s.problems).toEqual([
      { code: "TSLA", name: "테슬라", briefingId: rows.find((r) => r.code === "TSLA")!.id, kind: "busy", missing: false },
      { code: "PLTR", name: "팔란티어", briefingId: rows.find((r) => r.code === "PLTR")!.id, kind: "busy", missing: false },
    ]);
    // 이유가 둘이면 한 가지로 말하지 않는다
    const mixed = judgeStatus(input("2026-09-28T08:40:00", { rows: rowsFor("2026-09-28", { fail: { TSLA: RATE_LIMIT, PLTR: "api: Anthropic 서버 장애 (500). 잠시 뒤 다시 시도해 주세요" } }) }));
    expect(mixed.reasonKind).toBeNull();
    // 일부 못 만듦 + 늦음
    const both = judgeStatus(input("2026-09-28T09:13:00", { rows, runs: [entry({ finishedAt: iso("2026-09-28T09:12:00") })] }));
    expect(both).toMatchObject({ state: "partial", late: true });
  });

  it("모두 못 만듦: 설정(키) 오류 → allFailed · 이유 설정", () => {
    const fail = Object.fromEntries(STOCKS.map((s) => [s.code, NO_KEY]));
    const s = judgeStatus(input("2026-09-28T08:40:00", { rows: rowsFor("2026-09-28", { fail }) }));
    expect(s).toMatchObject({ state: "allFailed", reasonKind: "setup", total: 17, done: 0 });
    expect(s.problems).toHaveLength(17);
  });

  it("도중에 서버가 다시 켜짐: 기록 없이 14줄만 있고 서버는 줄 뒤에 켜짐 → 줄 없는 3종목 = 못 만듦(서버 다시 시작)", () => {
    const rows = rowsFor("2026-09-28", { missing: ["O", "MS", "GOOGL"] });
    const s = judgeStatus(input("2026-09-28T08:45:00", { runs: [], rows, bootAt: kst("2026-09-28T08:40:00") }));
    expect(s).toMatchObject({ state: "partial", reasonKind: "restart", total: 17, done: 14, finishedAt: null, startedAt: null });
    expect(s.problems.map((p) => [p.name, p.missing, p.briefingId])).toEqual([
      ["리얼티인컴", true, null],
      ["모건스탠리", true, null],
      ["알파벳", true, null],
    ]);
  });

  it("빠짐: 줄·기록 없음 — 09:14 는 아직(30분 늦게까지 돌 수 있음), 09:15 부터 missed", () => {
    const none = { runs: [], rows: [] };
    expect(judgeStatus(input("2026-09-28T09:14:59", none)).state).toBe("ok");
    expect(judgeStatus(input("2026-09-28T09:15:00", none))).toMatchObject({ state: "missed", total: 17, scheduledAt: iso("2026-09-28T08:30:00") });
  });

  it("빠짐: 서버가 예약 뒤(08:31)에 켜졌으면 그 회차는 돌 수 없다 → 08:36 부터 missed (예약 전에 켜졌으면 아직)", () => {
    const booted = { runs: [], rows: [], bootAt: kst("2026-09-28T08:31:00") };
    expect(judgeStatus(input("2026-09-28T08:35:59", booted)).state).toBe("ok");
    expect(judgeStatus(input("2026-09-28T08:36:00", booted)).state).toBe("missed");
    expect(judgeStatus(input("2026-09-28T08:36:00", { runs: [], rows: [], bootAt: kst("2026-09-28T08:29:00") })).state).toBe("ok");
  });

  it("만드는 중: 08:30 에 시작해 08:55 에도 도는 중 → slow (지금 17종목 중 9종목 끝남), 20분 안이면 안 보임, 한 종목 다시 만들기는 slow 아님", () => {
    const running: RunProgress = { session: "morning", date: "2026-09-28", trigger: "schedule", partial: false, startedAt: iso("2026-09-28T08:30:31"), total: 17, done: 9 };
    expect(judgeStatus(input("2026-09-28T08:55:00", { runs: [], rows: rowsFor("2026-09-28", { codes: STOCKS.slice(0, 9).map((s) => s.code) }), running }))).toMatchObject({ state: "slow", total: 17, done: 9, startedAt: running.startedAt });
    expect(judgeStatus(input("2026-09-28T08:45:00", { runs: [], rows: [], running })).state).toBe("ok");
    expect(judgeStatus(input("2026-09-28T09:20:00", { running: { ...running, partial: true, total: 1, done: 0 } })).state).toBe("ok");
    // 다른 회차를 도는 중이면 이 회차는 그대로 판단 (오후 수동 실행 중에 오전 실패)
    const other = judgeStatus(input("2026-09-28T10:00:00", { rows: rowsFor("2026-09-28", { fail: { TSLA: RATE_LIMIT } }), running: { ...running, session: "afternoon" } }));
    expect(other.state).toBe("partial");
  });

  it("주말(평일만)·세션 끔·예약 전 → none", () => {
    expect(judgeStatus(input("2026-10-03T09:00:00")).state).toBe("none");
    expect(judgeStatus({ ...input("2026-09-28T08:40:00"), pick: pickSession(kst("2026-09-28T08:40:00"), { ...SETTINGS, morningEnabled: false }, []) }).state).toBe("none");
    expect(judgeStatus(input("2026-09-28T08:10:00")).state).toBe("none");
  });

  it("금 9/25 추석 16:20: 국내는 휴장이라 건너뜀 — 못 만든 것에 세지 않는다 (미국만 12종목)", () => {
    const date = "2026-09-25";
    const runs = [entry({ session: "afternoon", date, scheduledAt: iso(`${date}T16:00:00`), startedAt: iso(`${date}T16:00:20`), finishedAt: iso(`${date}T16:06:00`), skipped: 5, skippedCodes: KR.map(([c]) => c) })];
    const rows = rowsFor(date, { codes: US.map(([c]) => c), at: "16:01" });
    const ok = judgeStatus(input("2026-09-25T16:20:00", { runs, rows, trading: { KR: false, US: true } }));
    expect(ok).toMatchObject({ session: "afternoon", state: "ok", total: 12 });
    const partial = judgeStatus(input("2026-09-25T16:20:00", { runs, rows: rowsFor(date, { codes: US.map(([c]) => c), at: "16:01", fail: { NVDA: RATE_LIMIT } }), trading: { KR: false, US: true } }));
    expect(partial).toMatchObject({ state: "partial", total: 12, done: 11 });
    // 두 시장 모두 휴장 → 안내 없음
    expect(judgeStatus(input("2026-09-25T16:20:00", { runs, rows: [], trading: { KR: false, US: false } })).state).toBe("none");
  });

  it("월 12/28 오전: 미국은 금요일 12/25 휴장 → 미국 종목 건너뜀 = 정상, 국내만 대상", () => {
    const date = "2026-12-28";
    const runs = [entry({ date, scheduledAt: iso(`${date}T08:30:00`), startedAt: iso(`${date}T08:30:20`), finishedAt: iso(`${date}T08:33:00`), skipped: 12, skippedCodes: US.map(([c]) => c) })];
    const s = judgeStatus(input("2026-12-28T08:38:00", { runs, rows: rowsFor(date, { codes: KR.map(([c]) => c) }), trading: { KR: true, US: false } }));
    expect(s).toMatchObject({ state: "ok", total: 5 });
    // 보유가 미국뿐이면 안내 없음
    expect(judgeStatus(input("2026-12-28T08:38:00", { runs, rows: [], stocks: STOCKS.slice(5), trading: { KR: true, US: false } })).state).toBe("none");
  });

  it("월 10/26 · 11/2(서머타임 끝난 뒤) 오전 08:38 정상 완료 → ok (한국 시각 기준이라 달라지지 않음)", () => {
    for (const date of ["2026-10-26", "2026-11-02"]) {
      const runs = [entry({ date, scheduledAt: iso(`${date}T08:30:00`), finishedAt: iso(`${date}T08:38:00`) })];
      expect(judgeStatus(input(`${date}T08:38:30`, { runs, rows: rowsFor(date) })).state).toBe("ok");
    }
  });

  it("수동으로 다시 만들어 성공하면 안내에서 빠짐 · 늦었던 정기 실행 뒤 전체 수동 실행이면 '늦음'도 말하지 않음", () => {
    const late = [entry({ finishedAt: iso("2026-09-28T09:12:00") })];
    expect(judgeStatus(input("2026-09-28T09:20:00", { runs: late, rows: rowsFor("2026-09-28") })).state).toBe("late");
    const manual = entry({ trigger: "manual", scheduledAt: null, firedAt: null, startedAt: iso("2026-09-28T09:30:00"), finishedAt: iso("2026-09-28T09:38:00") });
    expect(judgeStatus(input("2026-09-28T09:40:00", { runs: [...late, manual] })).state).toBe("ok");
    // 한 종목만 다시 만든 실행(partial)은 늦음을 지우지 않는다
    expect(judgeStatus(input("2026-09-28T09:40:00", { runs: [...late, { ...manual, partial: true, total: 1 }] })).state).toBe("late");
  });

  it("실행 뒤에 등록한 종목은 이번 회차 대상이 아니다", () => {
    const fresh = { code: "ORCL", name: "오라클", createdAt: iso("2026-09-28T09:00:00") };
    const s = judgeStatus(input("2026-09-28T09:10:00", { stocks: [...STOCKS, fresh] }));
    expect(s).toMatchObject({ state: "ok", total: 17 });
  });

  it("모델 없음 → llmOff (회차와 상관없이) · 등록 종목 없음 → none", () => {
    expect(judgeStatus(input("2026-09-28T08:10:00", { llmConfigured: false })).state).toBe("llmOff");
    expect(judgeStatus(input("2026-09-28T09:30:00", { stocks: [], rows: [], runs: [] })).state).toBe("none");
  });

  it("실행 기록 한 줄: 휴장으로 건너뛴 종목 코드를 함께 적는다", () => {
    const e = runLogEntry(
      {
        session: "morning", date: "2026-12-28", trigger: "schedule", partial: false, created: [], force: false,
        results: [
          { code: "005930", name: "삼성전자", status: "ok", briefingId: 1, error: null, summary: "s" },
          { code: "TSLA", name: "테슬라", status: "skipped", briefingId: null, error: "휴장일", summary: null },
          { code: "000660", name: "SK하이닉스", status: "failed", briefingId: 2, error: RATE_LIMIT, summary: null },
        ],
        startedAt: iso("2026-12-28T08:30:20"), firedAt: iso("2026-12-28T08:30:00"), scheduledAt: iso("2026-12-28T08:30:00"),
      },
      iso("2026-12-28T08:33:00"),
    );
    expect(e).toEqual({
      session: "morning", date: "2026-12-28", trigger: "schedule", partial: false, scheduledAt: iso("2026-12-28T08:30:00"), firedAt: iso("2026-12-28T08:30:00"),
      startedAt: iso("2026-12-28T08:30:20"), finishedAt: iso("2026-12-28T08:33:00"), total: 3, ok: 1, failed: 1, skipped: 1, skippedCodes: ["TSLA"],
    });
  });
});

describe("스케줄러: 예약 시각·부른 시각을 실행에 넘긴다", () => {
  it("scheduledAtFor: 시·분 숫자 하나일 때만 그날 예약 시각", () => {
    expect(scheduledAtFor("30 8 * * 1-5", kst("2026-09-28T08:30:04"))).toBe(iso("2026-09-28T08:30:00"));
    expect(scheduledAtFor("0 16 * * *", kst("2026-09-28T16:00:01"))).toBe(iso("2026-09-28T16:00:00"));
    // 30분 늦게 알아채도 예약 시각은 그대로
    expect(scheduledAtFor("30 8 * * 1-5", kst("2026-09-28T08:59:00"))).toBe(iso("2026-09-28T08:30:00"));
    for (const e of ["* * * * * *", "*/5 8 * * *", "30 8-9 * * *", "61 8 * * *"]) expect(scheduledAtFor(e, kst("2026-09-28T08:30:00"))).toBeNull();
    expect(scheduledAtFor("30 8 * * 1-5", kst("2026-09-28T08:30:00"), "America/New_York")).toBeNull();
  });

  it("정기 실행은 runSession 에 firedAt·scheduledAt 을 넘긴다", async () => {
    const runSession = vi.fn(async () => ({ session: "morning" as const, date: "2026-09-28", results: [], startedAt: "", finishedAt: "" }));
    const fired = kst("2026-09-28T08:30:02");
    const scheduler = new BriefingScheduler({ runSession, isRunning: false } as unknown as BriefingService, { morningCron: "30 8 * * 1-5", afternoonCron: null, now: () => fired });
    await (scheduler as unknown as { runScheduled(s: string, e: string): Promise<void> }).runScheduled("morning", "30 8 * * 1-5");
    expect(runSession).toHaveBeenCalledWith("morning", { trigger: "schedule", wait: true, staleBefore: fired, firedAt: fired, scheduledAt: iso("2026-09-28T08:30:00") });
  });
});

// ── 서버 전체 (buildApp · 메모리 DB) ─────────────────────────────

/** 코드별로 실패하게 할 수 있는 생성기. tick 이 있으면 부를 때마다 시계를 그만큼 민다 */
class ScriptedGenerator extends FakeGenerator {
  fail = new Map<string, GenerationError>();
  gate: Promise<void> | null = null;
  constructor(private readonly clock: { t: Date }, public tickMs = 0) {
    super();
  }
  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (this.gate) await this.gate;
    if (this.tickMs) this.clock.t = new Date(this.clock.t.getTime() + this.tickMs);
    const code = (req.label ?? "").split(":")[1] ?? "";
    const err = this.fail.get(code);
    if (err) throw err;
    return super.generate(req);
  }
}

interface Ctx {
  app: FastifyInstance;
  db: Db;
  clock: { t: Date };
  gen: ScriptedGenerator;
  calendarCalls: () => number;
}
let open: Ctx[] = [];
const dbs: Db[] = [];

async function start(opts: { at: string; db?: Db; stocks?: Array<[string, string, string]>; generator?: "disabled" }): Promise<Ctx> {
  const db = opts.db ?? (await createMigratedDb(":memory:"));
  if (!opts.db) dbs.push(db);
  const clock = { t: kst(opts.at) };
  const gen = new ScriptedGenerator(clock);
  const providers = fakeProviders({ generator: opts.generator === "disabled" ? new DisabledGenerator() : gen });
  // 달력 조회 수 (플래그를 끄면 상태 계산이 달력을 묻지 않는지)
  let calls = 0;
  const cal = providers.calendar;
  const isTradingDate = cal.isTradingDate.bind(cal);
  cal.isTradingDate = async (m, d) => {
    calls++;
    return isTradingDate(m, d);
  };
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers, logger: false, enableScheduler: false, now: () => clock.t });
  for (const [code, name, market] of opts.stocks ?? []) {
    await db.insertInto("registered_stocks").values({ code, name, market, quantity: 1, avg_price: 100, memo: null, created_at: iso("2026-09-01T10:00:00"), updated_at: iso("2026-09-01T10:00:00") }).execute();
  }
  const ctx = { app, db, clock, gen, calendarCalls: () => calls };
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const c of open) c.gen.gate = null;
  for (const c of open) await c.app.close();
  open = [];
  for (const d of dbs.splice(0)) await d.destroy();
});

const THREE: Array<[string, string, string]> = [
  ["005930", "삼성전자", "KOSPI"],
  ["000660", "SK하이닉스", "KOSPI"],
  ["TSLA", "테슬라", "NASDAQ"],
];
const status = async (c: Ctx) => {
  const res = await c.app.inject({ method: "GET", url: "/api/briefings/status" });
  return { code: res.statusCode, body: res.json() as BriefingStatus, raw: res.body };
};
/** 스케줄러가 08:30 에 부른 것처럼 */
const scheduled = (c: Ctx, session: "morning" | "afternoon", hhmm: string) => {
  const date = seoulDate(c.clock.t);
  const firedAt = new Date(c.clock.t);
  return c.app.briefingService.runSession(session, { trigger: "schedule", wait: true, staleBefore: firedAt, firedAt, scheduledAt: iso(`${date}T${hhmm}:00`) });
};
const runLog = async (db: Db) => {
  const row = await db.selectFrom("meta").select("value").where("key", "=", RUN_LOG_KEY).executeTakeFirst();
  return row ? (JSON.parse(row.value) as RunLogEntry[]) : null;
};

describe("GET /api/briefings/status (서버 전체)", () => {
  it("일부 못 만듦(429) → 이름·쉬운 종류만, 원문 없음 → 그 종목만 다시 만들어 성공하면 사라짐", async () => {
    const c = await start({ at: "2026-09-28T08:30:00", stocks: THREE });
    c.gen.fail.set("000660", new GenerationError("API 사용량 제한에 걸렸습니다 (429). 잠시 뒤 다시 시도해 주세요", "api"));
    await scheduled(c, "morning", "08:30");
    const log = await runLog(c.db);
    expect(log).toHaveLength(1);
    expect(log![0]).toMatchObject({ session: "morning", trigger: "schedule", partial: false, scheduledAt: iso("2026-09-28T08:30:00"), total: 3, ok: 2, failed: 1 });

    c.clock.t = kst("2026-09-28T08:40:00");
    const s = await status(c);
    expect(s.code).toBe(200);
    expect(s.body).toMatchObject({ session: "morning", state: "partial", total: 3, done: 2, reasonKind: "busy", manualRun: true, retryAt: null, nextRunAt: iso("2026-09-28T16:00:00") });
    const failed = await c.db.selectFrom("briefings").select("id").where("code", "=", "000660").executeTakeFirstOrThrow();
    expect(s.body.problems).toEqual([{ code: "000660", name: "SK하이닉스", briefingId: failed.id, kind: "busy", missing: false }]);
    // 오류 원문(종류 접두·상태 번호·메시지)은 응답에 없다
    for (const raw of ["api:", "429", "사용량", "Error"]) expect(s.raw).not.toContain(raw);

    c.gen.fail.clear();
    c.clock.t = kst("2026-09-28T08:45:00");
    expect((await c.app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"], force: true } })).statusCode).toBe(200);
    expect((await status(c)).body.state).toBe("ok");
    expect((await runLog(c.db))!.map((e) => e.partial)).toEqual([false, true]);
  });

  it("늦음: 모델 호출마다 7분 → 08:30 시작 09:12 완료 → late", async () => {
    const c = await start({ at: "2026-09-28T08:30:00", stocks: THREE });
    c.gen.tickMs = 7 * 60_000;
    await scheduled(c, "morning", "08:30");
    c.clock.t = kst("2026-09-28T09:13:00");
    expect((await status(c)).body).toMatchObject({ state: "late", late: true, finishedAt: iso("2026-09-28T09:12:00"), scheduledAt: iso("2026-09-28T08:30:00") });
  });

  it("서버를 다시 켜도 meta 실행 기록으로 이어서 판단 (재배포 뒤에도 안내가 남음)", async () => {
    const first = await start({ at: "2026-09-28T08:30:00", stocks: THREE });
    first.gen.fail.set("TSLA", new GenerationError("Anthropic 서버 장애 (500). 잠시 뒤 다시 시도해 주세요", "api"));
    await scheduled(first, "morning", "08:30");
    await first.app.close();
    open = open.filter((x) => x !== first);
    const again = await start({ at: "2026-09-28T08:50:00", db: first.db });
    expect((await status(again)).body).toMatchObject({ state: "partial", reasonKind: "outage", problems: [{ name: "테슬라", missing: false }] });
  });

  it("도중 재시작: 기록 없이 2줄만 → 줄 없는 종목은 같은 회차의 지난 브리핑을 열게", async () => {
    const c0 = await start({ at: "2026-09-25T08:30:00", stocks: THREE });
    await scheduled(c0, "morning", "08:30"); // 금요일 오전 (지난 같은 회차)
    const prev = await c0.db.selectFrom("briefings").select(["id", "code"]).where("code", "=", "TSLA").executeTakeFirstOrThrow();
    // 월요일 08:31 에 두 종목 줄을 쓰고 서버가 꺼졌다가 08:40 에 켜짐 (기록은 실행이 끝날 때 쓰므로 없음)
    await c0.db.deleteFrom("meta").where("key", "=", RUN_LOG_KEY).execute();
    for (const code of ["005930", "000660"]) {
      await c0.db.insertInto("briefings").values({ code, session: "morning", briefing_date: "2026-09-28", status: "ok", summary: "s", detail: "d", data_snapshot: "{}", missing_data: "[]", model: "m", error: null, created_at: iso("2026-09-28T08:31:00") }).execute();
    }
    await c0.app.close();
    open = open.filter((x) => x !== c0);
    const c = await start({ at: "2026-09-28T08:40:00", db: c0.db });
    c.clock.t = kst("2026-09-28T08:45:00");
    expect((await status(c)).body).toMatchObject({ state: "partial", reasonKind: "restart", total: 3, done: 2, problems: [{ code: "TSLA", name: "테슬라", missing: true, kind: "restart", briefingId: prev.id }] });
  });

  it("빠짐: 줄·기록 없음 09:15 → missed · 서버가 08:31 에 켜졌으면 08:36 부터", async () => {
    const c = await start({ at: "2026-09-28T07:00:00", stocks: THREE });
    c.clock.t = kst("2026-09-28T09:14:00");
    expect((await status(c)).body.state).toBe("ok");
    c.clock.t = kst("2026-09-28T09:15:00");
    expect((await status(c)).body).toMatchObject({ state: "missed", total: 3 });

    const late = await start({ at: "2026-09-28T08:31:00", stocks: THREE });
    late.clock.t = kst("2026-09-28T08:34:59");
    expect((await status(late)).body.state).toBe("ok");
    late.clock.t = kst("2026-09-28T08:36:00");
    expect((await status(late)).body.state).toBe("missed");
  });

  it("만드는 중: 08:55 에도 첫 종목에서 멈춰 있으면 slow (3종목 중 0종목)", async () => {
    const c = await start({ at: "2026-09-28T08:30:00", stocks: THREE });
    let release!: () => void;
    c.gen.gate = new Promise<void>((r) => (release = r));
    const run = scheduled(c, "morning", "08:30");
    await vi.waitFor(() => expect(c.app.briefingService.progress?.total).toBe(3));
    c.clock.t = kst("2026-09-28T08:45:00");
    expect((await status(c)).body.state).toBe("ok");
    c.clock.t = kst("2026-09-28T08:55:00");
    expect((await status(c)).body).toMatchObject({ state: "slow", total: 3, done: 0, startedAt: iso("2026-09-28T08:30:00") });
    c.gen.gate = null;
    release();
    await run;
    expect(c.app.briefingService.progress).toBeNull();
    expect((await status(c)).body.state).toBe("late"); // 08:55 완료 = 예약 + 25분
  });

  it("추석 9/25 16:20: 국내는 건너뜀, 미국만 대상 → 정상", async () => {
    const c = await start({ at: "2026-09-25T16:00:00", stocks: THREE });
    const r = await scheduled(c, "afternoon", "16:00");
    expect(r.results.map((x) => [x.code, x.status])).toEqual([
      ["005930", "skipped"],
      ["000660", "skipped"],
      ["TSLA", "ok"],
    ]);
    c.clock.t = kst("2026-09-25T16:20:00");
    expect((await status(c)).body).toMatchObject({ session: "afternoon", state: "ok", total: 1, nextRunAt: iso("2026-09-28T08:30:00") });
  });

  it("월 12/28 오전: 미국 12/25 휴장 → 미국 종목 건너뜀 = 정상", async () => {
    const c = await start({ at: "2026-12-28T08:30:00", stocks: THREE });
    await scheduled(c, "morning", "08:30");
    c.clock.t = kst("2026-12-28T08:38:00");
    expect((await status(c)).body).toMatchObject({ state: "ok", total: 2 });
  });

  it("오후 회차를 고른다 (오전 실패는 오후 예약 시각이 지나면 오후 기준)", async () => {
    const c = await start({ at: "2026-09-28T08:30:00", stocks: THREE });
    c.gen.fail.set("TSLA", new GenerationError("API 사용량 제한에 걸렸습니다 (429). 잠시 뒤 다시 시도해 주세요", "api"));
    await scheduled(c, "morning", "08:30");
    c.gen.fail.clear();
    c.clock.t = kst("2026-09-28T16:00:00");
    await scheduled(c, "afternoon", "16:00");
    c.clock.t = kst("2026-09-28T16:20:00");
    expect((await status(c)).body).toMatchObject({ session: "afternoon", state: "ok" });
  });

  it("모델 없음 → llmOff", async () => {
    const c = await start({ at: "2026-09-28T08:40:00", stocks: THREE, generator: "disabled" });
    expect((await status(c)).body.state).toBe("llmOff");
  });

  it("플래그 끔: 경로 404 · 실행 기록을 쓰지 않음 · 달력 조회 0", async () => {
    const c = await start({ at: "2026-09-28T08:30:00", stocks: THREE });
    expect((await c.app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingStatus: false } })).statusCode).toBe(200);
    await scheduled(c, "morning", "08:30");
    expect(await runLog(c.db)).toBeNull();
    const before = c.calendarCalls();
    c.clock.t = kst("2026-09-28T09:30:00");
    const s = await status(c);
    expect(s.code).toBe(404);
    expect(c.calendarCalls()).toBe(before);
  });

  it("실행 기록은 최근 20건만", async () => {
    const c = await start({ at: "2026-09-28T08:30:00", stocks: [THREE[0]!] });
    for (let n = 0; n < 22; n++) await c.app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["005930"], force: true } });
    expect(await runLog(c.db)).toHaveLength(20);
  });
});
