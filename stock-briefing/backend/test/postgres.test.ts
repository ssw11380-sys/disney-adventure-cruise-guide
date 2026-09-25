import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db/index.js";
import { BACKUP_TABLES, BackupService, decodeBackup, restoreBackup } from "../src/services/backupService.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerator, fakeProviders, SAMPLE_MASTER } from "./helpers.js";

/**
 * Postgres 방언 통합 테스트. TEST_PG_URL 이 설정된 경우에만 돈다.
 *   TEST_PG_URL=postgres://postgres@127.0.0.1:5433/stockbriefing_test npm test
 * 매 실행마다 public 스키마를 비우고 마이그레이션부터 다시 한다.
 */
const url = process.env["TEST_PG_URL"];

// CI 는 REQUIRE_PG=1 을 켠다: 환경변수 이름이 바뀌거나 빠져 Postgres 검사가 조용히 건너뛰어지는 일을 막는다
it.runIf(process.env["REQUIRE_PG"] === "1")("CI 에서는 TEST_PG_URL 이 반드시 있다", () => {
  expect(url, "TEST_PG_URL 없음").toBeTruthy();
});

describe.skipIf(!url)("postgres dialect", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    const created = createDb(url!);
    db = created.db;
    await sql`drop schema public cascade`.execute(db);
    await sql`create schema public`.execute(db);
    await migrate(db, created.dialect);
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: url! }),
      db,
      providers: fakeProviders({ generator: new FakeGenerator() }),
      logger: false,
      enableScheduler: true,
      receiptDelayMs: 0,
      now: () => new Date("2026-09-22T00:00:00+09:00"),
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("마이그레이션이 두 번 실행돼도 안전하다", async () => {
    await migrate(db, "postgres");
    const rows = await sql<{ version: number }>`select version from schema_version order by version`.execute(db);
    expect(rows.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("수량·평단은 8바이트(double precision)라 토스 소수 값이 끝자리까지 그대로 돌아온다 (BH-48)", async () => {
    const types = await sql<{ column_name: string; data_type: string }>`
      select column_name, data_type from information_schema.columns
      where table_name = 'registered_stocks' and column_name in ('quantity', 'avg_price') order by column_name`.execute(db);
    expect(types.rows).toEqual([
      { column_name: "avg_price", data_type: "double precision" },
      { column_name: "quantity", data_type: "double precision" },
    ]);
    await db
      .insertInto("registered_stocks")
      .values({ code: "VRT", name: "VRT", market: "NYSE", quantity: 16.123456, avg_price: 201234.57, memo: null, created_at: "x", updated_at: "x" })
      .execute();
    const read = () => db.selectFrom("registered_stocks").select(["quantity", "avg_price"]).where("code", "=", "VRT").executeTakeFirst();
    try {
      expect(await read()).toEqual({ quantity: 16.123456, avg_price: 201234.57 });
      // 버전 6 이전 DB(real 4바이트, 5 = 계좌 한 장 브리핑까지 적용됨)에 있던 값은 지금까지 읽히던 값 그대로 옮긴다
      await sql`alter table registered_stocks alter column quantity type real, alter column avg_price type real`.execute(db);
      await db.updateTable("registered_stocks").set({ quantity: 16.123456, avg_price: 1234.5678 }).where("code", "=", "VRT").execute();
      expect(await read()).toEqual({ quantity: 16.123455, avg_price: 1234.5677 });
      await sql`delete from schema_version where version = 6`.execute(db);
      await migrate(db, "postgres");
      expect(await read()).toEqual({ quantity: 16.123455, avg_price: 1234.5677 });
      const versions = await sql<{ version: number }>`select version from schema_version order by version`.execute(db);
      expect(versions.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6]);
      const doubles = await sql<{ n: number }>`select count(*) as n from information_schema.columns where table_name = 'registered_stocks' and data_type = 'double precision'`.execute(db);
      expect(Number(doubles.rows[0]!.n)).toBe(2);
    } finally {
      await db.deleteFrom("registered_stocks").where("code", "=", "VRT").execute();
    }
  });

  it("종목 마스터 → 검색 → 등록 → 브리핑 → 조회 전체 흐름", async () => {
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    const status = (await app.inject({ method: "GET", url: "/api/admin/master" })).json();
    expect(status.count).toBe(SAMPLE_MASTER.length);

    const search = (await app.inject({ method: "GET", url: "/api/stocks/search?q=삼성전자" })).json();
    expect(search.results[0].code).toBe("005930");

    const reg = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: 3, avgPrice: 100_000 } });
    expect(reg.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660" } })).statusCode).toBe(409);

    const list = (await app.inject({ method: "GET", url: "/api/stocks?quotes=1" })).json();
    expect(list[0].evaluation.profit).toBe(0);

    const run = (await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } })).json();
    expect(run.results[0].status).toBe("ok");
    const again = (await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", force: true } })).json();
    expect(again.results[0].briefingId).toBe(run.results[0].briefingId); // upsert (unique index)

    // 계좌 한 장 브리핑 (3-31): 실행마다 날짜·세션당 1건, force 면 같은 행을 덮어쓴다
    const accounts = (await app.inject({ method: "GET", url: "/api/account-briefings?limit=5" })).json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ date: "2026-09-22", session: "morning", status: "ok", headline: { dayPnl: 3000, holdings: 1 } });
    const account = (await app.inject({ method: "GET", url: `/api/account-briefings/${accounts[0].id}` })).json();
    expect(account.data.contributions[0]).toMatchObject({ code: "000660", amount: 3000 });

    const detail = (await app.inject({ method: "GET", url: `/api/briefings/${run.results[0].briefingId}` })).json();
    expect(detail.name).toBe("SK하이닉스");
    expect(detail.data.quote.price).toBe(100_000);

    const analysis = (await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/technical" })).json();
    expect(analysis.id).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/technical" })).json().cached).toBe(true);
  });

  it("영문 종목명은 티커 모양이어도·대소문자가 달라도 이름으로 찾는다 (Postgres LIKE 는 대소문자를 가림, DISC-05)", async () => {
    const rows = [
      { code: "035420", name: "NAVER", group_code: "ST" },
      { code: "030200", name: "KT", group_code: "ST" },
      { code: "033780", name: "KT&G", group_code: "ST" },
      { code: "069500", name: "KODEX 200", group_code: "EF" },
    ];
    await db
      .insertInto("listed_stocks")
      .values(rows.map((r) => ({ ...r, market: "KOSPI", isin_code: null, updated_at: "2026-09-22T09:00:00+09:00" })))
      .execute();
    try {
      const find = async (q: string) => (await app.stockService.searchMaster(q)).results.map((s) => s.code);
      expect(await find("NAVER")).toEqual(["035420"]);
      expect(await find("naver")).toEqual(["035420"]);
      expect(await find("KT")).toEqual(["030200", "033780"]);
      expect(await find("kodex 200")).toEqual(["069500"]);
      expect(await find("005930")).toEqual(["005930"]);
      // % _ 는 글자 그대로 (like ... escape '!')
      expect(await find("K_")).toEqual([]);
      expect(await find("%")).toEqual([]);
    } finally {
      await db.deleteFrom("listed_stocks").where("code", "in", rows.map((r) => r.code)).execute();
    }
  });

  it("현재가 캐시를 여러 행 한 번에 저장하고 같은 종목은 갱신한다 (on conflict excluded)", async () => {
    const svc = app.stockService;
    const rows = await db.selectFrom("quote_cache").select("code").execute();
    expect(rows.length).toBeGreaterThan(0);
    await svc.getQuote(rows[0]!.code, { fresh: true });
    await svc.warmQuotes();
    expect(svc.quoteStatus().cacheWriteErrors).toBe(0);
    expect((await db.selectFrom("quote_cache").select("code").execute()).length).toBe(rows.length);
  });

  it("기기 등록과 알림 설정이 저장된다", async () => {
    const dev = await app.inject({ method: "POST", url: "/api/devices", payload: { token: "ExponentPushToken[pgpgpgpgpgpgpgpgpgpgpg]", platform: "android" } });
    expect(dev.statusCode).toBe(201);
    expect(dev.json().enabled).toBe(true);
    const put = (await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { morningTime: "09:00" } })).json();
    expect(put.morningTime).toBe("09:00");
    expect(put.schedule.jobs[0].cron).toBe("0 9 * * 1-5");
    const del = await app.inject({ method: "DELETE", url: "/api/stocks/000660" });
    expect(del.statusCode).toBe(204);
  });

  it("백업을 비운 표에 되살리고, 일련번호가 이어져 새 행을 넣을 수 있다 (3-7)", async () => {
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const t of BACKUP_TABLES) tables[t] = (await sql<Record<string, unknown>>`select * from ${sql.table(t)}`.execute(db)).rows;
    const dir = await mkdtemp(join(tmpdir(), "pgbk-"));
    const st = await new BackupService({ db, dialect: "postgres", dir, key: "k" }).run();
    expect(st.lastError).toBeNull();
    const decoded = await decodeBackup(await readFile(join(dir, st.lastFile!)), "k");
    if (decoded.kind !== "json") throw new Error("json 이어야 함");
    const payload = decoded.payload;
    const before = st.lastCounts!;
    expect(before["briefings"]).toBeGreaterThan(0);
    for (const t of [...BACKUP_TABLES].reverse()) await sql`delete from ${sql.table(t)}`.execute(db);
    const r = await restoreBackup(db, "postgres", payload);
    expect(r).toEqual(before);
    // 복구 뒤 새 브리핑 insert 가 id 충돌 없이 된다
    const row = { ...(tables["briefings"]![0] as Record<string, unknown>) };
    delete row["id"];
    row["briefing_date"] = "2099-01-01"; // 고유 키(code·date·session)가 겹치지 않게
    await (db as unknown as { insertInto: (t: string) => { values: (v: unknown) => { execute: () => Promise<unknown> } } }).insertInto("briefings").values(row).execute();
    const n = await sql<{ n: number }>`select count(*) as n from briefings`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(before["briefings"]! + 1);
  });
});
