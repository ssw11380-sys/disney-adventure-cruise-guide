import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db/index.js";
import { BACKUP_TABLES, BackupService, decodeBackup, restoreBackup } from "../src/services/backupService.js";
import { DETAIL_KEY, SNAPSHOT_KEY, TossSyncService } from "../src/services/tossSyncService.js";
import { KrwCostBook } from "../src/services/krwCostBook.js";
import type { TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
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
    expect(rows.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5]);
  });

  const qtyColumns = async () =>
    (
      await sql<{ column_name: string; data_type: string }>`select column_name, data_type from information_schema.columns
        where table_name = 'registered_stocks' and column_name in ('quantity', 'avg_price') order by column_name`.execute(db)
    ).rows;
  /** 테스트가 실패해도 넣은 행을 지운다 (남으면 뒤 테스트의 등록 목록이 달라진다) */
  const cleanupStock = (code: string) =>
    onTestFinished(async () => {
      await db.deleteFrom("registered_stocks").where("code", "=", code).execute();
    });
  const insertStock = async (code: string, quantity: number, avgPrice: number) => {
    cleanupStock(code);
    await db.insertInto("registered_stocks").values({ code, name: code, market: "NASDAQ", quantity, avg_price: avgPrice, memo: null, created_at: "t", updated_at: "t" }).execute();
  };
  const readStock = (code: string) => db.selectFrom("registered_stocks").select(["quantity", "avg_price"]).where("code", "=", code).executeTakeFirstOrThrow();

  it("소수 수량·평단이 그대로 읽힌다 (real 이면 105.234567 → 105.234566)", async () => {
    expect(await qtyColumns()).toEqual([
      { column_name: "avg_price", data_type: "double precision" },
      { column_name: "quantity", data_type: "double precision" },
    ]);
    await insertStock("PGQTY", 105.234567, 187.123456);
    expect(await readStock("PGQTY")).toEqual({ quantity: 105.234567, avg_price: 187.123456 });
  });

  it("real 로 만든 기존 DB 도 v5 에서 보이던 값 그대로 옮긴다 (0.1 → 0.10000000149011612 가 되지 않게)", async () => {
    await sql`alter table registered_stocks alter column quantity type real, alter column avg_price type real`.execute(db);
    await sql`delete from schema_version where version = 5`.execute(db);
    await insertStock("PGOLD", 0.1, 123.45);
    await migrate(db, "postgres");
    expect((await qtyColumns()).map((c) => c.data_type)).toEqual(["double precision", "double precision"]);
    expect(await readStock("PGOLD")).toEqual({ quantity: 0.1, avg_price: 123.45 });
  });

  it("여러 계좌에 나눠 든 소수 수량을 동기화해도 다음 동기화에서 변경으로 보지 않는다", async () => {
    cleanupStock("PGSYNC");
    onTestFinished(async () => {
      await db.deleteFrom("meta").where("key", "in", [SNAPSHOT_KEY, DETAIL_KEY, KrwCostBook.KEY]).execute(); // 토스 연동 흔적도 남기지 않게
    });
    const toss = {
      accounts: async () => [1, 2].map((seq) => ({ accountNo: String(seq), accountSeq: seq, accountType: "BROKERAGE" })),
      holdingsWithOverview: async (seq: number) => ({
        items: [{ code: "PGSYNC", name: "PGSYNC", currency: "USD", quantity: seq === 1 ? 100.1 : 5.134567, avgPrice: 250, lastPrice: null }],
        overview: { purchaseKrw: 0, purchaseUsd: 0, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null },
      }),
      stockInfos: async () => new Map([["PGSYNC", { name: "PGSYNC", market: "NASDAQ" }]]),
      ordersForBook: async () => [],
      usdKrwAt: async () => 1400,
    } as unknown as TossOpenApiProvider;
    const sync = new TossSyncService(db, toss, () => new Date("2026-09-22T00:00:00+09:00"));
    expect((await sync.importHoldings()).added).toEqual(["PGSYNC"]);
    expect((await readStock("PGSYNC")).quantity).toBe(105.234567);
    expect((await sync.importHoldings()).unchanged).toEqual(["PGSYNC"]);
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

    const detail = (await app.inject({ method: "GET", url: `/api/briefings/${run.results[0].briefingId}` })).json();
    expect(detail.name).toBe("SK하이닉스");
    expect(detail.data.quote.price).toBe(100_000);

    const analysis = (await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/technical" })).json();
    expect(analysis.id).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/technical" })).json().cached).toBe(true);
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
