import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, createMigratedDb, type Db } from "../src/db/index.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import { restoreBackup, type BackupPayload } from "../src/services/backupService.js";
import { RUN_LOG_KEY } from "../src/services/briefingStatus.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

const AT = new Date("2026-09-22T09:00:00+09:00");
const TOKEN = "ExponentPushToken[round2_offline_device]";

class RecordingPush implements PushSender {
  readonly name = "가짜 발송기";
  sent: PushMessage[] = [];
  checked: string[][] = [];
  receiptError: string | null = null;
  beforeCheck: (() => Promise<void>) | null = null;
  isValidToken(): boolean { return true; }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    return { results: tokens.map((token, index) => ({ token, ok: true, error: null, receiptId: `offline-${this.sent.length}-${index}` })) };
  }
  async checkReceipts(ids: string[]) {
    this.checked.push(ids);
    await this.beforeCheck?.();
    return ids.map((receiptId) => ({ receiptId, ok: !this.receiptError, error: this.receiptError }));
  }
}

async function appFor(db: Db, push: RecordingPush, generator: FakeGenerator, now = () => AT): Promise<FastifyInstance> {
  return buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:" }), db,
    providers: fakeProviders({ push, generator }), logger: false, enableScheduler: false,
    receiptDelayMs: 60_000, now,
  });
}

describe("2차 알림 발송과 후속 DB 기록의 실패 경계 — 격리 SQLite", () => {
  it.each([false, true])("계좌 요약 %s: 발송 후 실행 기록 저장이 실패해도 재시작·같은 회차 재요청은 모델과 알림을 반복하지 않는다", async (accountBriefing) => {
    const db = await createMigratedDb(":memory:");
    const push = new RecordingPush();
    const generator = new FakeGenerator();
    let app: FastifyInstance | null = null;
    try {
      app = await appFor(db, push, generator);
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: 10, avgPrice: 95000 } });
      await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN, platform: "android" } });
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accountBriefing, marketSummary: false } });
      await sql`create trigger fail_round2_run_record before insert on meta
        when NEW.key = 'briefing_run_log'
        begin select raise(abort, '가짜 실행 기록 저장 실패'); end`.execute(db);
      expect((await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } })).statusCode).toBe(200);
      expect(push.sent).toHaveLength(1);
      expect(generator.requests).toHaveLength(2);
      const before = await db.selectFrom("briefings").selectAll().execute();
      expect(before).toHaveLength(1);
      expect(before[0]?.status).toBe("ok");
      expect(await db.selectFrom("meta").selectAll().where("key", "=", RUN_LOG_KEY).execute()).toEqual([]);
      const accounts = await db.selectFrom("account_briefings").selectAll().execute();
      expect(accounts).toHaveLength(accountBriefing ? 1 : 0);

      await app.close(); app = null;
      app = await appFor(db, push, generator);
      expect((await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } })).statusCode).toBe(200);
      expect(push.sent).toHaveLength(1);
      expect(generator.requests).toHaveLength(2);
      expect(await db.selectFrom("briefings").selectAll().execute()).toEqual(before);
      expect(await db.selectFrom("account_briefings").selectAll().execute()).toEqual(accounts);

      await sql`drop trigger fail_round2_run_record`.execute(db);
      expect((await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } })).statusCode).toBe(200);
      expect(push.sent).toHaveLength(1);
      expect(generator.requests).toHaveLength(2);
      const log = await db.selectFrom("meta").select("value").where("key", "=", RUN_LOG_KEY).executeTakeFirstOrThrow();
      expect(JSON.parse(log.value)).toHaveLength(1);
    } finally {
      await app?.close(); await db.destroy();
    }
  });

  it("발송 영수증의 무효 기기 기록이 실패하면 다음 확인에 같은 영수증을 재처리해 기기를 비활성화한다", async () => {
    const db = await createMigratedDb(":memory:");
    const push = new RecordingPush();
    const app = await appFor(db, push, new FakeGenerator());
    try {
      await app.deviceService.register({ token: TOKEN, platform: "android" });
      await app.notificationService.sendTest();
      push.receiptError = "DeviceNotRegistered";
      await sql`create trigger fail_round2_disable before update on devices
        when NEW.enabled = 0
        begin select raise(abort, '가짜 기기 비활성 기록 실패'); end`.execute(db);
      expect(await app.notificationService.checkReceipts()).toEqual({ checked: 1, disabled: 0 });
      expect((await app.deviceService.get(TOKEN))?.enabled).toBe(true);
      await sql`drop trigger fail_round2_disable`.execute(db);
      expect(await app.notificationService.checkReceipts()).toEqual({ checked: 1, disabled: 1 });
      expect((await app.deviceService.get(TOKEN))?.enabled).toBe(false);
      expect(push.checked).toEqual([["offline-1-0"], ["offline-1-0"]]);
      expect(push.sent).toHaveLength(1);
    } finally {
      await app.close(); await db.destroy();
    }
  });

  it("일부 기기 저장 실패만 다음 예약으로 넘기고 완료한 기기 영수증은 반복 처리하지 않는다", async () => {
    vi.useFakeTimers();
    const db = await createMigratedDb(":memory:");
    const push = new RecordingPush();
    const app = await appFor(db, push, new FakeGenerator());
    const other = "ExponentPushToken[round2_offline_other]";
    try {
      await app.deviceService.register({ token: TOKEN, platform: "android" });
      await app.deviceService.register({ token: other, platform: "android" });
      await app.notificationService.sendTest();
      push.receiptError = "DeviceNotRegistered";
      await sql`create trigger fail_round2_partial before update on devices
        when NEW.enabled = 0 and NEW.token = ${sql.lit(TOKEN)}
        begin select raise(abort, '가짜 일부 기기 기록 실패'); end`.execute(db);
      // 정상 발송 직후 별도 확인을 앞당기거나 기다리지 않는다.
      expect(push.checked).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await app.deviceService.get(TOKEN))?.enabled).toBe(true);
      expect((await app.deviceService.get(other))?.enabled).toBe(false);
      await sql`drop trigger fail_round2_partial`.execute(db);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await app.deviceService.get(TOKEN))?.enabled).toBe(false);
      expect(push.checked[0]).toHaveLength(2);
      expect(push.checked[1]).toHaveLength(1);
      expect(push.checked[1]?.[0]).toBe(push.checked[0]?.[0]);
      expect(push.sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await app.close(); await db.destroy(); vi.useRealTimers();
    }
  });

  it("영수증 조회 실패 중 새로 발송한 영수증을 잃지 않고 원래 실패분과 한 번씩 확인한다", async () => {
    const db = await createMigratedDb(":memory:");
    const push = new RecordingPush();
    const app = await appFor(db, push, new FakeGenerator());
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      await app.deviceService.register({ token: TOKEN, platform: "android" });
      await app.notificationService.sendTest();
      push.beforeCheck = async () => { await held; throw new Error("가짜 영수증 서버 연결 실패"); };
      const checking = app.notificationService.checkReceipts();
      await app.notificationService.sendTest();
      release();
      expect(await checking).toEqual({ checked: 1, disabled: 0 });
      push.beforeCheck = null;
      expect(await app.notificationService.checkReceipts()).toEqual({ checked: 2, disabled: 0 });
      expect(push.checked[1]?.toSorted()).toEqual(["offline-1-0", "offline-2-0"]);
      expect(await app.notificationService.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
      expect(push.sent).toHaveLength(2);
    } finally {
      release(); await app.close(); await db.destroy();
    }
  });

  it("영수증은 24시간 직전까지 재확인하고 보관 기한 뒤에는 대기 자료·재예약을 정리하며 새 알림은 정상 확인한다", async () => {
    vi.useFakeTimers();
    const db = await createMigratedDb(":memory:");
    const push = new RecordingPush();
    let clock = AT.getTime();
    const app = await appFor(db, push, new FakeGenerator(), () => new Date(clock));
    try {
      await app.deviceService.register({ token: TOKEN, platform: "android" });
      await app.notificationService.sendTest();
      push.beforeCheck = async () => { throw new Error("가짜 계속되는 장애"); };
      await vi.advanceTimersByTimeAsync(60_000);
      clock = AT.getTime() + 24 * 3_600_000 - 1;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(push.checked).toEqual([["offline-1-0"], ["offline-1-0"]]);
      clock++;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(push.checked).toHaveLength(2);
      expect(await app.notificationService.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
      expect(vi.getTimerCount()).toBe(0);
      push.beforeCheck = null;
      await app.notificationService.sendTest();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(push.checked.at(-1)).toEqual(["offline-2-0"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await app.close(); await db.destroy(); vi.useRealTimers();
    }
  });
});

const pgUrl = process.env["TEST_PG_URL"];
it.runIf(process.env["REQUIRE_PG"] === "1")("2차 복구 CI에는 PostgreSQL 연결이 반드시 설정된다", () => {
  expect(Boolean(pgUrl), "2차 복구 PostgreSQL 연결 설정 없음").toBe(true);
});
describe.skipIf(!pgUrl)("2차 실제 PostgreSQL 복구 경계 — 전용 임시 schema", () => {
  it("201번째 행 저장 실패는 200행을 롤백하고 기존 자료를 보존하며 재시도 뒤 원래 ID와 다음 ID가 이어진다", async () => {
    if (!pgUrl) throw new Error("격리 PostgreSQL 검사 주소가 필요합니다");
    const url = new URL(pgUrl);
    if (!["localhost", "127.0.0.1", "[::1]", "postgres"].includes(url.hostname)) throw new Error("복구 검사는 로컬 또는 CI 전용 PostgreSQL에서만 실행합니다");
    const schema = `round2_persistence_${randomUUID().replaceAll("-", "")}`;
    const admin = createDb(pgUrl).db;
    let db: Db | null = null;
    const ts = AT.toISOString();
    const stock = { code: "005930", name: "복구 전 종목", market: "KOSPI", quantity: 1.234567, avg_price: 12345.67, memo: "보존", created_at: ts, updated_at: ts };
    const sentinel = { key: "round2_sentinel", value: "기존 자료 보존" };
    const rows = Array.from({ length: 225 }, (_, i) => ({
      id: 1000 + i * 3, code: "005930", session: "morning",
      briefing_date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      status: i % 5 === 0 ? "failed" : "ok", summary: `복구 요약 ${i}`, detail: `상세 ${i}\n한글·숫자 1,234.56`,
      data_snapshot: JSON.stringify({ quote: { asOf: ts, price: 100.125 + i } }),
      missing_data: JSON.stringify(i % 3 === 0 ? ["자료 누락"] : []), model: "가짜 모델",
      error: i % 5 === 0 ? "가짜 실패" : null, created_at: ts,
    }));
    const payload: BackupPayload = { version: 1, createdAt: ts, tables: {
      registered_stocks: [{ ...stock, memo: "덮어쓰면 안 됨" }], meta: [{ ...sentinel, value: "덮어쓰면 안 됨" }], briefings: rows,
    } };
    try {
      await sql`create schema ${sql.id(schema)}`.execute(admin);
      url.searchParams.set("options", `-c search_path=${schema}`);
      db = await createMigratedDb(url.toString());
      expect((await sql<{ schema: string }>`select current_schema() as schema`.execute(db)).rows[0]?.schema).toBe(schema);
      await db.insertInto("registered_stocks").values(stock).execute();
      await db.insertInto("meta").values(sentinel).execute();
      const originalStocks = await db.selectFrom("registered_stocks").selectAll().execute();
      const originalMeta = await db.selectFrom("meta").selectAll().execute();
      await sql`create function fail_round2_restore() returns trigger language plpgsql as $$
        begin
          if NEW.id = 1600 and (select count(*) from briefings) = 200 then
            raise exception '복구 두 번째 묶음 저장 실패';
          end if;
          return NEW;
        end
      $$`.execute(db);
      await sql`create trigger fail_round2_restore before insert on briefings for each row execute function fail_round2_restore()`.execute(db);
      await expect(restoreBackup(db, "postgres", payload)).rejects.toThrow("복구 두 번째 묶음 저장 실패");
      expect(await db.selectFrom("briefings").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("registered_stocks").selectAll().execute()).toEqual(originalStocks);
      expect(await db.selectFrom("meta").selectAll().execute()).toEqual(originalMeta);
      await sql`drop trigger fail_round2_restore on briefings`.execute(db);
      expect(await restoreBackup(db, "postgres", payload)).toMatchObject({ registered_stocks: "skipped", meta: "skipped", briefings: 225 });
      expect(await db.selectFrom("briefings").selectAll().orderBy("id").execute()).toEqual(rows);
      const { id: _id, ...next } = rows[rows.length - 1]!;
      expect(await db.insertInto("briefings").values({ ...next, briefing_date: "2099-01-01" }).returningAll().executeTakeFirstOrThrow())
        .toEqual({ ...next, id: rows[rows.length - 1]!.id + 1, briefing_date: "2099-01-01" });
      expect(await db.selectFrom("registered_stocks").selectAll().execute()).toEqual(originalStocks);
      expect(await db.selectFrom("meta").selectAll().execute()).toEqual(originalMeta);
    } finally {
      await db?.destroy();
      // 이 검사에서 만든 이름만 정리한다. public이나 기존 스키마는 건드리지 않는다.
      if (/^round2_persistence_[0-9a-f]{32}$/.test(schema)) await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin);
      await admin.destroy();
    }
  });
});
