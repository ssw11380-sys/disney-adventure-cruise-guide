import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate, type Db } from "../src/db/index.js";
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
    expect(rows.rows.map((r) => Number(r.version))).toEqual([1, 2, 3]);
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
});
