import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type QueryResult } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, migrate } from "../src/db/index.js";
import type { Database } from "../src/db/schema.js";
import { TossOpenApiProvider, type TossHolding } from "../src/providers/market/tossOpenApi.js";
import { StockService } from "../src/services/stockService.js";
import { HoldingsAutoSync, TossSyncService } from "../src/services/tossSyncService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider, fakeProviders } from "./helpers.js";
import { client, NOW as TOSS_NOW } from "./tossFake.js";

const NOW = () => new Date("2026-09-23T10:00:00+09:00");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 계좌 여러 개를 흉내 내는 가짜 토스 Open API.
 * 계좌 요약(매입금액)은 실제 보유(holdings) 기준으로 만들고, glitch 로 보유 목록 응답만 바꿀 수 있다 (응답이 통째로 비는 일시 오류)
 */
class FakeToss {
  accountsList = [1];
  holdings: Record<number, TossHolding[]> = { 1: [] };
  glitch: Record<number, TossHolding[]> = {};
  ordersGate: Promise<void> | null = null;
  ordersCalled = false;
  async accounts() {
    return this.accountsList.map((s) => ({ accountNo: String(s), accountSeq: s, accountType: "BROKERAGE" }));
  }
  async holdingsWithOverview(seq: number) {
    const real = this.holdings[seq] ?? [];
    const sum = (cur: "KRW" | "USD") => real.filter((x) => x.currency === cur).reduce((s, x) => s + x.quantity * (x.avgPrice ?? 0), 0);
    return { items: this.glitch[seq] ?? real, overview: { purchaseKrw: sum("KRW"), purchaseUsd: sum("USD"), afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null } };
  }
  async ordersForBook() {
    this.ordersCalled = true;
    await this.ordersGate;
    return [];
  }
  async usdKrwAt() {
    return 1400;
  }
  async stockInfos(codes: string[]) {
    return new Map(codes.map((c) => [c, { name: c, market: /^\d/.test(c) ? "KOSPI" : "NASDAQ" }]));
  }
  asProvider(): TossOpenApiProvider {
    return this as unknown as TossOpenApiProvider;
  }
}

const kr = (code: string, quantity: number, avgPrice: number): TossHolding => ({ code, name: code, currency: "KRW", quantity, avgPrice, lastPrice: null });
const us = (code: string, quantity: number, avgPrice: number): TossHolding => ({ code, name: code, currency: "USD", quantity, avgPrice, lastPrice: null });

async function setup(opts: { syncMinutes?: number } = {}) {
  const db = await createMigratedDb(":memory:");
  let t = NOW().getTime();
  const now = () => new Date(t);
  const advance = (ms: number) => void (t += ms);
  const toss = new FakeToss();
  const stocks = new StockService({
    db,
    quotes: new FakeQuoteProvider("x"),
    search: new FakeSearchProvider(),
    master: new FakeMasterProvider(),
    tossOpenApi: { baseFallbacks: 0 },
    tossSyncMinutes: opts.syncMinutes ?? 10,
    now,
  });
  await stocks.refreshMaster();
  const sync = new TossSyncService(db, toss.asProvider(), now);
  const excluded = async () => (await db.selectFrom("meta").select("value").where("key", "=", "toss_sync_excluded").executeTakeFirst())?.value ?? null;
  const codes = async () => (await stocks.list()).map((s) => s.code).sort();
  return { db, toss, stocks, sync, advance, excluded, codes };
}

describe("BH-14 원화 장부 갱신(토스 호출)은 등록 종목 쓰기 잠금 밖에서", () => {
  it("장부가 토스 주문 내역을 기다리는 동안에도 앱의 종목 등록은 막히지 않는다", async () => {
    const { db, toss, stocks, sync } = await setup();
    let release!: () => void;
    toss.ordersGate = new Promise<void>((r) => (release = r));
    toss.holdings[1] = [{ ...us("TSLA", 2, 300), purchaseAmount: 600 }];
    const syncing = sync.importHoldings();
    await vi.waitFor(() => expect(toss.ordersCalled).toBe(true)); // 원화 장부가 토스 응답을 기다리는 중
    const reg = stocks.register({ code: "005930", quantity: 1, avgPrice: 70000 });
    const first = await Promise.race([reg.then(() => "done"), sleep(500).then(() => "blocked")]);
    release();
    await Promise.all([syncing, reg]);
    expect(first).toBe("done");
    expect(await stocks.get("TSLA")).toMatchObject({ quantity: 2, avgPrice: 300 });
    await db.destroy();
  });

  it("정기 브리핑 직전 동기화는 토스가 멈춰도 상한 시간까지만 기다린다", async () => {
    const stuck = { importHoldings: () => new Promise<never>(() => {}) } as unknown as TossSyncService;
    const auto = new HoldingsAutoSync({ sync: stuck, intervalMin: 10, briefingWaitMs: 50, now: NOW });
    const r = await Promise.race([auto.beforeBriefing().then(() => "done"), sleep(1_000).then(() => "waiting")]);
    expect(r).toBe("done");
  });
});

describe("BH-34 보유 응답이 한 번 비거나 계좌가 잠깐 빠져도 전량 매도로 보지 않는다", () => {
  it("계좌 요약에는 매입금액이 있는데 보유 목록만 비면: 관심으로 바꾸지 않고 동기화 제외 목록도 지키며, 지운 종목이 되살아나지 않는다", async () => {
    const { db, toss, stocks, sync, excluded, codes } = await setup();
    toss.holdings[1] = [us("SOXL", 100, 30), kr("005930", 3, 70000)];
    expect((await sync.importHoldings()).added.sort()).toEqual(["005930", "SOXL"]);
    expect(await stocks.remove("005930")).toEqual({ tossExcluded: true });
    expect(await excluded()).toBe('["005930"]');

    toss.glitch[1] = []; // 요약(달러 3,000·원화 210,000)은 그대로인데 목록만 빔
    const r2 = await sync.importHoldings();
    expect(r2.removed).toEqual([]);
    expect(await stocks.get("SOXL")).toMatchObject({ quantity: 100, avgPrice: 30 });
    expect(await excluded()).toBe('["005930"]');
    expect((await stocks.tossSynced()).has("SOXL")).toBe(true); // 잠금도 그대로

    delete toss.glitch[1];
    const r3 = await sync.importHoldings();
    expect(r3.added).toEqual([]);
    expect(r3.excluded).toEqual(["005930"]);
    expect(await codes()).toEqual(["SOXL"]);
    await db.destroy();
  });

  it("여러 계좌 중 하나가 목록에서 잠깐 빠져도 그 계좌 종목을 관심으로 바꾸지 않고 제외 목록을 지킨다", async () => {
    const { db, toss, stocks, sync, excluded, codes } = await setup();
    toss.accountsList = [3, 7];
    toss.holdings = { 3: [kr("005930", 3, 70000)], 7: [us("NVDA", 5, 120), us("AMD", 2, 150)] };
    await sync.importHoldings();
    expect(await stocks.remove("AMD")).toEqual({ tossExcluded: true });

    toss.accountsList = [3]; // 계좌 7 이 한 번 빠짐
    expect((await sync.importHoldings()).removed).toEqual([]);
    expect(await stocks.get("NVDA")).toMatchObject({ quantity: 5, avgPrice: 120 });
    expect(await excluded()).toBe('["AMD"]');

    toss.accountsList = [3, 7];
    const r = await sync.importHoldings();
    expect(r.added).toEqual([]);
    expect(r.excluded).toEqual(["AMD"]);
    expect(await codes()).toEqual(["005930", "NVDA"]);
    await db.destroy();
  });

  it("진짜 전량 매도는 그대로 반영한다: 요약도 0 이면 바로, 요약과 맞지 않는 빈 응답이 두 번 연속이면 그때", async () => {
    const a = await setup();
    a.toss.holdings[1] = [us("SOXL", 100, 30)];
    await a.sync.importHoldings();
    a.toss.holdings[1] = []; // 요약도 0
    expect((await a.sync.importHoldings()).removed).toEqual(["SOXL"]);
    expect(await a.stocks.get("SOXL")).toMatchObject({ quantity: null, avgPrice: null });
    await a.db.destroy();

    const b = await setup();
    b.toss.holdings[1] = [us("SOXL", 100, 30), kr("005930", 3, 70000)];
    await b.sync.importHoldings();
    await b.stocks.remove("005930");
    b.toss.glitch[1] = [];
    expect((await b.sync.importHoldings()).removed).toEqual([]);
    expect((await b.sync.importHoldings()).removed).toEqual(["SOXL"]); // 두 번 연속 없으면 전량 매도로 본다
    expect(await b.excluded()).toBe("[]");
    await b.db.destroy();
  });
});

describe("BH-46 동기화가 3시간 넘게 멈춘 사이 지운 토스 종목", () => {
  it("잠금은 풀려도 마지막 토스 스냅샷에 있던 종목이면 동기화에서 빼, 동기화가 살아나도 다시 나타나지 않는다", async () => {
    const { db, toss, stocks, sync, advance, codes } = await setup();
    toss.holdings[1] = [kr("035420", 9, 232555), us("TSLA", 4, 320)];
    await sync.importHoldings();
    advance(4 * 3_600_000); // 동기화가 4시간 멈춤 (예: 허용 IP 문제로 403)
    expect((await stocks.tossSynced()).size).toBe(0); // 수량·평단은 직접 고칠 수 있게 잠금 해제
    expect(await stocks.remove("035420")).toEqual({ tossExcluded: true });

    const r = await sync.importHoldings(); // 동기화가 다시 살아남
    expect(r.added).toEqual([]);
    expect(r.excluded).toEqual(["035420"]);
    expect(await codes()).toEqual(["TSLA"]);
    await db.destroy();
  });
});

describe("BH-78 자동 동기화를 끄면(TOSS_SYNC_MINUTES=0) 브리핑 직전 동기화도 하지 않는다", () => {
  it("꺼져 있으면 run('briefing') 은 토스를 읽지 않아 직접 고친 수량·평단이 그대로다 (수동 가져오기는 그대로 된다)", async () => {
    const { db, toss, stocks, sync } = await setup({ syncMinutes: 0 });
    toss.holdings[1] = [us("SOXL", 100, 30)];
    const auto = new HoldingsAutoSync({ sync, intervalMin: 0, now: NOW });
    expect((await auto.run("manual"))?.added).toEqual(["SOXL"]);
    await stocks.update("SOXL", { quantity: 150, avgPrice: 28 }); // 꺼져 있으면 잠그지 않는다 → 다른 증권사 몫까지 합쳐 직접 고침
    expect(await auto.run("briefing")).toBeNull();
    expect(await stocks.get("SOXL")).toMatchObject({ quantity: 150, avgPrice: 28 });
    expect(auto.status()).toMatchObject({ enabled: false, lastTrigger: "manual" });
    await db.destroy();
  });

  it("앱: 꺼져 있으면 정기 브리핑 스케줄러에 동기화를 걸지 않고, 켜져 있으면 건다", async () => {
    for (const [minutes, wired] of [["0", false], ["10", true]] as const) {
      const db = await createMigratedDb(":memory:");
      const app = await buildApp({
        config: loadConfig({ DATABASE_URL: ":memory:", TOSS_SYNC_MINUTES: minutes }),
        db,
        providers: fakeProviders({ tossOpenApi: new TossOpenApiProvider(client(), { now: TOSS_NOW }) }),
        logger: false,
        enableScheduler: true,
        now: TOSS_NOW,
      });
      try {
        expect(typeof (app.scheduler as unknown as { beforeRun?: unknown }).beforeRun).toBe(wired ? "function" : "undefined");
      } finally {
        await app.close();
        await db.destroy();
      }
    }
  });
});

describe("BH-48 Postgres 에서 수량·평단 정밀도", () => {
  /** 실행한 SQL 만 기록하는 Postgres 방언 Kysely (서버 없이 마이그레이션 문장을 확인) */
  function recordingPostgres() {
    const sqls: string[] = [];
    const conn: DatabaseConnection = {
      executeQuery: async <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
        sqls.push(q.sql);
        return { rows: [] };
      },
      streamQuery: async function* () {
        /* 쓰지 않음 */
      },
    };
    const db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          init: async () => {},
          acquireConnection: async () => conn,
          beginTransaction: async () => {},
          commitTransaction: async () => {},
          rollbackTransaction: async () => {},
          releaseConnection: async () => {},
          destroy: async () => {},
        }),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { db, sqls };
  }

  it("quantity·avg_price 를 double precision(8바이트)으로 바꾸는 마이그레이션이 있다 (real 은 4바이트라 16.123456 → 16.123455)", async () => {
    const { db, sqls } = recordingPostgres();
    await migrate(db, "postgres");
    const alter = sqls.filter((s) => /alter table\s+"?registered_stocks"?/i.test(s)).join("\n");
    expect(alter).toMatch(/"?quantity"?\s+type\s+double precision/i);
    expect(alter).toMatch(/"?avg_price"?\s+type\s+double precision/i);
    await db.destroy();
  });

  it("SQLite 는 표를 바꾸지 않고(REAL 은 이미 8바이트) 소수 값이 그대로 돌아온다", async () => {
    const db = await createMigratedDb(":memory:");
    await db
      .insertInto("registered_stocks")
      .values({ code: "VRT", name: "VRT", market: "NYSE", quantity: 16.123456, avg_price: 1234.5678, memo: null, created_at: "x", updated_at: "x" })
      .execute();
    expect(await db.selectFrom("registered_stocks").select(["quantity", "avg_price"]).where("code", "=", "VRT").executeTakeFirst()).toEqual({ quantity: 16.123456, avg_price: 1234.5678 });
    await db.destroy();
  });
});
