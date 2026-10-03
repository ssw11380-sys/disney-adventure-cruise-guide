import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest } from "../src/llm/generator.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

const AT = new Date("2026-12-28T09:00:00+09:00");
const TOKEN_A = "ExponentPushToken[fourth_local_a]";
const TOKEN_B = "ExponentPushToken[fourth_local_b]";
const TOKEN_C = "ExponentPushToken[fourth_local_c]";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
class HeldGenerator extends FakeGenerator {
  readonly entered = gate();
  readonly held = gate();
  override async generate(request: GenerateRequest) {
    this.entered.release();
    await this.held.promise;
    return super.generate(request);
  }
}
class MixedPush implements PushSender {
  readonly name = "4차 가짜 발송기";
  sent: PushMessage[] = [];
  checked: string[][] = [];
  error = "DeviceNotRegistered";
  isValidToken(): boolean { return true; }
  async send(_tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    return { results: [
      { token: TOKEN_A, ok: false, error: this.error, receiptId: null },
      { token: TOKEN_B, ok: true, error: null, receiptId: "fourth-receipt-b" },
      { token: TOKEN_C, ok: false, error: this.error, receiptId: null },
    ] };
  }
  async checkReceipts(ids: string[]) {
    this.checked.push(ids);
    return ids.map((receiptId) => ({ receiptId, ok: false, error: "DeviceNotRegistered" }));
  }
}
async function setup(generator: FakeGenerator, push?: PushSender, database = ":memory:") {
  const db = await createMigratedDb(database);
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:" }), db,
    providers: fakeProviders({ generator, ...push ? { push } : {} }),
    logger: false, enableScheduler: false, now: () => AT, receiptDelayMs: 60_000,
  });
  await db.insertInto("registered_stocks").values({
    code: "005930", name: "삼성전자", market: "KOSPI", quantity: null, avg_price: null,
    memo: "", created_at: AT.toISOString(), updated_at: AT.toISOString(),
  }).execute();
  return { app, db };
}

describe("4차 연결 중단과 정상 종료의 경계 — 실제 로컬 HTTP, 가짜 분석 모델", () => {
  it.each(["analysis", "briefing"] as const)("%s 요청의 연결이 끊긴 뒤 서버와 DB를 닫아도 시작한 생성과 저장을 마친다", async (kind) => {
    const generator = new HeldGenerator();
    const database = join(tmpdir(), `stock-fourth-${randomUUID()}.sqlite`);
    const { app, db } = await setup(generator, undefined, database);
    const disconnected = gate();
    let closed = false;
    let closing: Promise<void> | undefined;
    let reopened: Db | undefined;
    app.addHook("onRequest", async (req) => { req.socket.once("close", disconnected.release); });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const path = kind === "analysis" ? "/api/stocks/005930/analysis/company?requestId=fourth_disconnect_01" : "/api/briefings/run";
    const request = httpRequest(`${address}${path}`, { method: kind === "analysis" ? "GET" : "POST", headers: { "Content-Type": "application/json" } });
    request.on("error", () => { /* 검증에서 의도한 연결 중단 */ });
    request.end(kind === "briefing" ? JSON.stringify({ session: "morning", force: true }) : undefined);
    try {
      await generator.entered.promise;
      request.destroy();
      await disconnected.promise;
      closing = app.close().then(() => db.destroy()).then(() => { closed = true; });
      // 모델은 명시적인 gate로 멈췄다. 서버가 생성 대신 연결 수만 기다리는지를 확인한다.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect.soft(closed).toBe(false);
      generator.held.release();
      await closing;
      reopened = await createMigratedDb(database);
      const rows = await reopened.selectFrom(kind === "analysis" ? "analyses" : "briefings").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(generator.requests).toHaveLength(kind === "analysis" ? 1 : 2);
      expect(rows[0]).toMatchObject({ code: "005930", model: "fake-model" });
      if (kind === "analysis") {
        expect(rows[0]).toMatchObject({ content: `## 한 줄 요약\ncompany_overview:005930 결과입니다.\n\n## 본문\n데이터 길이 ${generator.requests[0]!.user.length}` });
        expect(generator.requests[0]).toMatchObject({ maxTokens: 4096, effort: "high" });
      } else {
        expect(rows[0]).toMatchObject({ status: "ok", briefing_date: "2026-12-28", session: "morning" });
      }
    } finally {
      request.destroy();
      generator.held.release();
      await closing;
      await app.close();
      await db.destroy();
      await reopened?.destroy();
      await unlink(database);
    }
  });

  it.each([false, true])("분석 캐시 조회 중 종료해도 이미 받은 요청의 성공·실패(%s)를 회수하며 새 생성은 받지 않는다", async (fail) => {
    const generator = new FakeGenerator(fail ? { failKind: "api" } : {});
    const { app, db } = await setup(generator);
    const pendingRead = gate();
    const readEntered = gate();
    const original = app.analysisService.latest.bind(app.analysisService);
    const read = vi.spyOn(app.analysisService, "latest").mockImplementation(async (...args) => {
      readEntered.release();
      await pendingRead.promise;
      return original(...args);
    });
    const result = app.analysisService.getTracked("005930", "company", "fourth_before_generate");
    const observed = result.then((value) => ({ value }), (error: unknown) => ({ error }));
    // DB 요청 복원 조회 횟수와 무관하게 실제 캐시 조회가 시작된 경계를 확정한다.
    await readEntered.promise;
    let stopped = false;
    const stopping = app.analysisService.shutdown().then(() => { stopped = true; });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      await expect(app.analysisService.get("005930", "technical", { refresh: true })).rejects.toMatchObject({ code: "SERVER_CLOSING", statusCode: 503 });
      expect(read).toHaveBeenCalledTimes(1);
      pendingRead.release();
      const outcome = await observed;
      await stopping;
      expect(stopped).toBe(true);
      expect(generator.requests).toHaveLength(1);
      expect(await db.selectFrom("analyses").selectAll().execute()).toHaveLength(fail ? 0 : 1);
      expect(fail ? "error" in outcome : "value" in outcome).toBe(true);
      expect(await app.analysisService.state("005930", "company", "fourth_before_generate"))
        .toMatchObject({ running: false, request: { status: fail ? "failed" : "completed" } });
    } finally {
      pendingRead.release();
      await observed;
      await stopping;
      read.mockRestore();
      await app.close();
      await db.destroy();
    }
  });

  it("종료 전에 대기열에 들어온 브리핑은 완료 리스너까지 마치고 종료 후 새 요청은 생성하지 않는다", async () => {
    const generator = new HeldGenerator();
    const { app, db } = await setup(generator);
    const listenerEntered = gate();
    const listenerHeld = gate();
    const sessions: string[] = [];
    app.briefingService.onRunDone(async (done) => {
      sessions.push(done.session);
      if (done.session === "morning") { listenerEntered.release(); await listenerHeld.promise; }
    });
    const first = app.briefingService.runSession("morning", { force: true });
    await generator.entered.promise;
    const queued = app.briefingService.runSession("afternoon", { force: true, wait: true });
    let stopped = false;
    const stopping = app.briefingService.shutdown().then(() => { stopped = true; });
    try {
      await expect(app.briefingService.runSession("morning", { wait: true })).rejects.toMatchObject({ code: "SERVER_CLOSING", statusCode: 503 });
      generator.held.release();
      await listenerEntered.promise;
      expect(stopped).toBe(false);
      expect(sessions).toEqual(["morning"]);
      listenerHeld.release();
      const results = await Promise.all([first, queued]);
      await stopping;
      expect(sessions).toEqual(["morning", "afternoon"]);
      expect(results.map((r) => r.results[0]?.status)).toEqual(["ok", "ok"]);
      expect(await db.selectFrom("briefings").selectAll().execute()).toHaveLength(2);
      expect(generator.requests).toHaveLength(4);
      expect(app.briefingService.progress).toBeNull();
      expect(app.briefingService.isRunning).toBe(false);
    } finally {
      generator.held.release();
      listenerHeld.release();
      await Promise.allSettled([first, queued, stopping]);
      await app.close();
      await db.destroy();
    }
  });
});

describe("4차 발송 응답 일부 저장 실패 — 실제 격리 SQLite, 가짜 푸시", () => {
  it.each(["DeviceNotRegistered", "InvalidToken"])("%s 기기의 비활성화가 실패해도 다른 기기의 실제 발송 결과와 영수증을 보존한다", async (error) => {
    const push = new MixedPush();
    push.error = error;
    const { app, db } = await setup(new FakeGenerator(), push);
    try {
      for (const token of [TOKEN_A, TOKEN_B, TOKEN_C]) await app.deviceService.register({ token, platform: "android" });
      await sql`create trigger fourth_fail_first_disable before update on devices
        when NEW.enabled = 0 and NEW.token = 'ExponentPushToken[fourth_local_a]'
        begin select raise(abort, '검증용 첫 기기 저장 실패'); end`.execute(db);
      const response = await app.inject({ method: "POST", url: "/api/notifications/test" });
      expect.soft(response.statusCode).toBe(200);
      expect.soft(response.json()).toEqual({ sent: 1, failed: 2, disabled: [TOKEN_C] });
      expect.soft((await app.deviceService.get(TOKEN_C))?.enabled).toBe(false);
      expect((await app.deviceService.get(TOKEN_A))?.enabled).toBe(true);
      expect.soft(await app.notificationService.checkReceipts()).toEqual({ checked: 1, disabled: 1 });
      expect.soft(push.checked).toEqual([["fourth-receipt-b"]]);
      expect.soft((await app.deviceService.get(TOKEN_B))?.enabled).toBe(false);
      expect(push.sent).toHaveLength(1);
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
