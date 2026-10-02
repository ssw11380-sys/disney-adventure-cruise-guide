import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db/index.js";
import { BACKUP_TABLES, BackupService, decodeBackup, restoreBackup } from "../src/services/backupService.js";
import { FeatureService } from "../src/services/featureService.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import { evaluate } from "../src/services/stockService.js";
import { PromptStore } from "../src/llm/prompts.js";
import { TradeRecordService } from "../src/services/tradeRecordService.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGenerator, fakeProviders, makeQuote, SAMPLE_MASTER } from "./helpers.js";
import { IndicatorScoreService } from "../src/services/indicatorScoreService.js";
import { benchOf, candlesOf } from "./fixtures/indicatorScores/load.js";

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
    expect(rows.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // 7 = 시장 전체 요약 표 (날짜·세션 하나에 한 건)
    const idx = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'market_summaries'`.execute(db);
    expect(idx.rows.map((r) => r.indexname)).toContain("uq_market_summaries_date_session");
    // 8 = 매매 기록 (시장·거래일마다 스냅샷 한 줄, 계좌·주문번호마다 체결 한 줄). 수량·금액은 8바이트
    const idx8 = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename in ('account_snapshots', 'trade_executions')`.execute(db);
    expect(idx8.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(["uq_account_snapshots_date_market", "uq_trade_executions_account_order"]));
    const types = await sql<{ column_name: string; data_type: string }>`
      select column_name, data_type from information_schema.columns
      where table_name = 'trade_executions' and column_name in ('quantity', 'amount', 'price') order by column_name`.execute(db);
    expect(types.rows.map((r) => r.data_type)).toEqual(["double precision", "double precision", "double precision"]);
    // 9 = 지표 점수 기록 (종목·기준일·종류마다 한 줄). 점수는 8바이트
    const idx9 = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'indicator_scores'`.execute(db);
    expect(idx9.rows.map((r) => r.indexname)).toContain("uq_indicator_scores_code_date_kind");
    const types9 = await sql<{ data_type: string }>`
      select data_type from information_schema.columns where table_name = 'indicator_scores' and column_name in ('score', 'score_today') order by column_name`.execute(db);
    expect(types9.rows.map((r) => r.data_type)).toEqual(["double precision", "double precision"]);
  });

  it("지표 점수 기록 (3-44): 같은 종목·기준일은 덮어쓴다 (Postgres on conflict)", async () => {
    const svc = new IndicatorScoreService({
      db,
      features: { enabled: async () => true },
      sources: {
        stock: async (code) => ({ code, name: code, market: "NASDAQ" }),
        candles: async (code) => ({ code, period: "D", candles: candlesOf("NVDA"), source: "yahoo" }),
        benchmark: async () => benchOf("NVDA"),
        product: async () => null,
        registered: async () => [{ code: "NVDA", name: "엔비디아", market: "NASDAQ" }],
      },
      now: () => new Date("2026-09-25T17:31:00-04:00"),
    });
    try {
      expect(await svc.runDaily("US")).toEqual({ computed: 1, failed: 0 });
      expect(await svc.runDaily("US")).toEqual({ computed: 1, failed: 0 });
      const rows = await db.selectFrom("indicator_scores").select(["code", "score_date", "status", "score", "band"]).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ code: "NVDA", score_date: "2026-09-25", status: "ok", band: "다소 강함" });
      expect(rows[0]!.score).toBeCloseTo(68.5827, 3);
    } finally {
      await db.deleteFrom("indicator_scores").execute();
    }
  });

  it("매매 기록 (3-36): 스냅샷·빈칸·체결을 Postgres 에 쓰고 다시 돌려도 늘지 않는다", async () => {
    const clock = { t: new Date("2026-09-28T16:05:00+09:00") };
    const toss = {
      accounts: async () => [{ accountSeq: 3 }],
      holdingsWithOverview: async () => ({
        items: [{ code: "005930", name: "삼성전자", currency: "KRW" as const, quantity: 10.5, avgPrice: 70000, lastPrice: 71200, purchaseAmount: 735000, marketValue: 747600, marketValueAfterCost: 746000 }],
        overview: { purchaseKrw: 735000, purchaseUsd: 0, afterCostKrw: 746000, afterCostUsd: 0, rateAfterCost: 0.015 },
      }),
      orderHistory: async () => ({
        orders: [{ orderId: "pg-1", symbol: "005930", side: "BUY" as const, status: "CLOSED" as const, quantity: 10.5, amount: 735000, currency: null, filledAt: "2026-09-28T09:01:00+09:00", orderedAt: null, raw: {} }],
        truncated: false,
      }),
    };
    const svc = new TradeRecordService({ db, toss, features: new FeatureService(db, () => clock.t), now: () => clock.t, pauseMs: 0 });
    try {
      await svc.tick();
      await svc.tick();
      clock.t = new Date("2026-09-30T16:05:00+09:00"); // 9/29 은 빈칸
      await svc.tick();
      const rows = await db.selectFrom("account_snapshots").select(["snapshot_date", "status", "total_value_krw", "holdings_count"]).where("market", "=", "KR").orderBy("snapshot_date").execute();
      expect(rows).toEqual([
        { snapshot_date: "2026-09-28", status: "ok", total_value_krw: 747600, holdings_count: 1 },
        { snapshot_date: "2026-09-29", status: "gap", total_value_krw: null, holdings_count: 0 },
        { snapshot_date: "2026-09-30", status: "ok", total_value_krw: 747600, holdings_count: 1 },
      ]);
      expect(await db.selectFrom("trade_executions").select(["order_id", "quantity"]).execute()).toEqual([{ order_id: "pg-1", quantity: 10.5 }]);
      const st = await svc.status();
      expect(st).toMatchObject({ since: "2026-09-28", days: 2, trades: { count: 1, earliest: "2026-09-28" } });
    } finally {
      await db.deleteFrom("account_snapshots").execute();
      await db.deleteFrom("trade_executions").execute();
      await db.deleteFrom("meta").where("key", "=", "trade_records_state").execute();
    }
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
      expect(versions.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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
    // 매매 기록 두 표에도 행을 둔 채 (앞 테스트가 비워 둠) — 지난 날은 다시 받을 수 없어 JSON 백업·복구(identity overriding·setval)를 꼭 확인한다
    const ts = "2026-09-28T16:05:00+09:00";
    const snapRow = (date: string) => ({
      snapshot_date: date,
      market: "KR",
      status: "ok",
      method: "close",
      as_of: ts,
      scheduled_at: ts,
      source: "toss-openapi",
      reason: null,
      holdings_count: 1,
      total_value_krw: 747600,
      data: JSON.stringify({ version: 1, holdings: [], accounts: [] }),
      created_at: ts,
      updated_at: ts,
    });
    const tradeRow = (orderId: string) => ({
      account: 3,
      order_id: orderId,
      code: "005930",
      market: "KR",
      side: "BUY",
      quantity: 10.5,
      amount: 735000,
      price: 70000,
      currency: "KRW",
      fee: null,
      tax: null,
      executed_at: ts,
      executed_date: "2026-09-28",
      time_basis: "filled",
      order_status: "CLOSED",
      source: "toss-orders",
      raw: "{}",
      fills: JSON.stringify([{ q: 10.5, a: 735000, at: ts, basis: "filled", seenAt: ts }]),
      created_at: ts,
      updated_at: ts,
    });
    await db.insertInto("account_snapshots").values(snapRow("2026-09-28")).execute();
    await db.insertInto("trade_executions").values(tradeRow("pg-bk-1")).execute();
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
    // 매매 기록 두 표: 되살린 값이 그대로(8바이트 수량·fills)이고, 새 행이 id 충돌 없이 들어간다
    expect(before["account_snapshots"]).toBe(1);
    expect(before["trade_executions"]).toBe(1);
    expect(await db.selectFrom("trade_executions").select(["order_id", "quantity", "fills"]).execute()).toEqual([{ order_id: "pg-bk-1", quantity: 10.5, fills: tradeRow("pg-bk-1").fills }]);
    await db.insertInto("account_snapshots").values(snapRow("2026-09-29")).execute();
    await db.insertInto("trade_executions").values(tradeRow("pg-bk-2")).execute();
    const ids = await db.selectFrom("trade_executions").select("id").orderBy("id").execute();
    expect(ids).toHaveLength(2);
    expect(new Set(ids.map((r) => r.id)).size).toBe(2);
    expect((await db.selectFrom("account_snapshots").select("id").execute()).length).toBe(2);
    await db.deleteFrom("account_snapshots").execute();
    await db.deleteFrom("trade_executions").execute();
  });

  it("계좌 보고서의 실패 upsert는 기존 성공 행을 보존한다 (Postgres 조건부 충돌 처리)", async () => {
    const at = new Date("2026-12-28T08:45:00+09:00");
    const date = "2026-12-28";
    let available = true;
    const stock = { code: "005930", name: "삼성전자", market: "KOSPI" as const, quantity: 10, avgPrice: 90_000, memo: null, createdAt: at.toISOString(), updatedAt: at.toISOString() };
    const svc = new AccountBriefingService({
      db, indices: null, calendar: null, generator: new FakeGenerator(), prompts: new PromptStore(),
      features: { enabled: async (key) => key === "accountBriefing" }, now: () => at,
      stocks: { listWithFreshQuotes: async () => {
        const quote = available ? makeQuote(stock.code, "가짜시세") : null;
        return [{ ...stock, quote, evaluation: evaluate(stock, quote) }];
      } },
    });
    try {
      const old = await svc.generate("morning", { date, force: true });
      expect(old?.status).toBe("ok");
      available = false;
      await expect(svc.generate("morning", { date, force: true })).rejects.toMatchObject({ code: "ACCOUNT_DATA_UNAVAILABLE" });
      expect(await svc.find(date, "morning")).toEqual(old);
      available = true;
      expect((await svc.generate("morning", { date, force: true }))?.status).toBe("ok");
    } finally {
      await db.deleteFrom("account_briefings").where("briefing_date", "=", date).where("session", "=", "morning").execute();
    }
  });
});
