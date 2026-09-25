import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest, GenerateResult } from "../src/llm/generator.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import { BriefingScheduler } from "../src/scheduler.js";
import type { BriefingService, BriefingSession } from "../src/services/briefingService.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

/** gate 가 있으면 풀릴 때까지 모델 호출을 붙잡는다 (수동 실행이 도는 중인 상태를 만든다) */
class GatedGenerator extends FakeGenerator {
  gate: Promise<void> | null = null;
  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (this.gate) await this.gate;
    return super.generate(req);
  }
}

class RecordingPush implements PushSender {
  readonly name = "recording-push";
  sent: PushMessage[] = [];
  isValidToken(token: string): boolean {
    return token.startsWith("ExponentPushToken[");
  }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    return { results: tokens.map((token) => ({ token, ok: true, error: null, receiptId: null })) };
  }
  async checkReceipts() {
    return [];
  }
}

/**
 * 진짜 node-cron 으로 정기 실행을 한 번 울린다 (매초 표현식, 처음 울리면 바로 멈춤).
 * started: "정기 브리핑 시작" 로그, finished: 완료 또는 실패 로그까지
 */
function fireScheduled(service: BriefingService, session: BriefingSession, now: () => Date) {
  const logs: string[] = [];
  let onStart!: () => void;
  let onFinish!: () => void;
  const started = new Promise<void>((r) => (onStart = r));
  const finished = new Promise<void>((r) => (onFinish = r));
  const scheduler: BriefingScheduler = new BriefingScheduler(service, {
    morningCron: session === "morning" ? "* * * * * *" : null,
    afternoonCron: session === "afternoon" ? "* * * * * *" : null,
    now,
    log: {
      info: (_o, msg) => {
        logs.push(msg);
        if (msg === "정기 브리핑 시작") {
          scheduler.stop();
          onStart();
        }
        if (msg === "정기 브리핑 완료") onFinish();
      },
      error: (o, msg) => {
        logs.push(`${msg}: ${String(o.err)}`);
        if (msg === "정기 브리핑 실패") onFinish();
      },
    },
  });
  scheduler.start();
  return { started, finished: finished.then(() => logs), stop: () => scheduler.stop() };
}

const TOKEN = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

describe("정기 브리핑 실행 (BH-13·BH-19·BH-18)", () => {
  let app: FastifyInstance;
  let db: Db;
  let gen: GatedGenerator;
  let push: RecordingPush;
  let clock: Date;
  let fired: ReturnType<typeof fireScheduled> | null = null;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    gen = new GatedGenerator();
    push = new RecordingPush();
    clock = new Date("2026-09-22T08:30:00+09:00"); // 화요일
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ generator: gen, push }),
      logger: false,
      enableScheduler: false,
      receiptDelayMs: 0,
      now: () => clock,
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    for (const code of ["000660", "005930"]) await app.inject({ method: "POST", url: "/api/stocks", payload: { code } });
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN, platform: "android" } });
  });

  afterEach(async () => {
    fired?.stop();
    fired = null;
    gen.gate = null;
    await app.close();
    await db.destroy();
  });

  const rows = async (session: BriefingSession) =>
    ((await app.inject({ method: "GET", url: `/api/briefings?date=2026-09-22&session=${session}` })).json() as Array<{ code: string; status: string; createdAt: string }>)
      .map((b) => [b.code, b.status, b.createdAt])
      .sort((a, b) => a[0]!.localeCompare(b[0]!));

  it("수동 실행 중에 예약 시각이 오면 건너뛰지 않고, 수동 실행이 끝난 뒤 이어서 돈다", async () => {
    let release!: () => void;
    gen.gate = new Promise<void>((r) => (release = r));
    // 08:29:50 상세의 '이 종목 오늘 오전 브리핑 다시 만들기' (한 종목, force)
    const manual = app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"], force: true } });
    await vi.waitFor(() => expect(app.briefingService.isRunning).toBe(true));

    fired = fireScheduled(app.briefingService, "morning", () => clock);
    await fired.started;
    gen.gate = null;
    release();
    expect((await manual).statusCode).toBe(200);
    const logs = await fired.finished;

    expect(logs.filter((l) => l.startsWith("정기 브리핑 실패"))).toEqual([]);
    expect(await rows("morning")).toEqual([
      ["000660", "ok", "2026-09-22T08:30:00+09:00"],
      ["005930", "ok", "2026-09-22T08:30:00+09:00"],
    ]);
    // 수동으로 막 만든 000660 은 다시 만들지 않는다: 수동 2회(상세·요약) + 정기 2회(005930)
    expect(gen.requests.map((r) => r.label)).toEqual(["briefing_detail:000660", "briefing_summary:000660", "briefing_detail:005930", "briefing_summary:005930"]);
    // 정기 실행의 세션 알림 (수동 한 종목 다시 만들기는 알리지 않는다)
    expect(push.sent.map((m) => m.title)).toEqual(["삼성전자 오전 브리핑"]);
    expect(app.briefingService.isRunning).toBe(false);
  });

  it("예약 시각 전에 같은 회차를 수동으로 만들어 두어도, 정기 실행은 마감 뒤 내용으로 다시 만들고 알린다", async () => {
    // 10:00 장중에 브리핑 탭 '오후 브리핑' (전체, force) → 그 시각 알림 1건
    clock = new Date("2026-09-22T10:00:00+09:00");
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
    expect(push.sent.map((m) => m.title)).toEqual(["오후 브리핑 2종목"]);
    const early = gen.requests.length;

    clock = new Date("2026-09-22T16:00:00+09:00");
    fired = fireScheduled(app.briefingService, "afternoon", () => clock);
    const logs = await fired.finished;
    expect(logs.filter((l) => l.startsWith("정기 브리핑 실패"))).toEqual([]);

    expect(gen.requests.length - early).toBe(4); // 두 종목 다시 (상세·요약)
    expect(await rows("afternoon")).toEqual([
      ["000660", "ok", "2026-09-22T16:00:00+09:00"],
      ["005930", "ok", "2026-09-22T16:00:00+09:00"],
    ]);
    expect(push.sent.map((m) => m.title)).toEqual(["오후 브리핑 2종목", "오후 브리핑 2종목"]);
  });

  it("아침에 한 종목만 오늘 오후 브리핑을 미리 만들어도 16시 정기 알림에서 빠지지 않는다", async () => {
    // 08:00 전날 오후 브리핑 상세의 '이 종목 오늘 오후 브리핑 다시 만들기' (한 종목, force) → 알림 없음
    clock = new Date("2026-09-22T08:00:00+09:00");
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", codes: ["005930"], force: true } });
    expect(push.sent).toEqual([]);

    clock = new Date("2026-09-22T16:00:00+09:00");
    fired = fireScheduled(app.briefingService, "afternoon", () => clock);
    await fired.finished;
    expect(await rows("afternoon")).toEqual([
      ["000660", "ok", "2026-09-22T16:00:00+09:00"],
      ["005930", "ok", "2026-09-22T16:00:00+09:00"],
    ]);
    expect(push.sent.map((m) => m.title)).toEqual(["오후 브리핑 2종목"]);

    // 예약 시각 뒤에 만든 것은 정기 실행이 다시 만들지 않는다 (같은 시각에 한 번 더 울려도 모델 호출 없음)
    const n = gen.requests.length;
    fired = fireScheduled(app.briefingService, "afternoon", () => clock);
    await fired.finished;
    expect(gen.requests.length).toBe(n);
  });
});
