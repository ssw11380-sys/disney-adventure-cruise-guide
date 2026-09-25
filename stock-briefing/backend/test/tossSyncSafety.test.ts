import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql, type CompiledQuery, type DatabaseConnection, type QueryResult } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, migrate } from "../src/db/index.js";
import type { Database } from "../src/db/schema.js";
import { TossOpenApiProvider, type TossHolding } from "../src/providers/market/tossOpenApi.js";
import { StockService } from "../src/services/stockService.js";
import { ACCOUNTS_KEY, HoldingsAutoSync, TossSyncService } from "../src/services/tossSyncService.js";
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
  /** 계좌 요약의 달러 매입금액을 모름(null)으로 주는 계좌 */
  usdUnknown = new Set<number>();
  holdingsCalls = 0;
  ordersGate: Promise<void> | null = null;
  ordersCalled = false;
  async accounts() {
    return this.accountsList.map((s) => ({ accountNo: String(s), accountSeq: s, accountType: "BROKERAGE" }));
  }
  async holdingsWithOverview(seq: number) {
    this.holdingsCalls++;
    const real = this.holdings[seq] ?? [];
    const sum = (cur: "KRW" | "USD") => real.filter((x) => x.currency === cur).reduce((s, x) => s + x.quantity * (x.avgPrice ?? 0), 0);
    const purchaseUsd = this.usdUnknown.has(seq) ? null : sum("USD");
    return { items: this.glitch[seq] ?? real, overview: { purchaseKrw: sum("KRW"), purchaseUsd, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null } };
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
  return { db, toss, stocks, sync, now, advance, excluded, codes };
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

  it("같은 일시 오류를 몇 초 사이 두 번 봐도(체결 동기화 + 바로 이어진 재실행) 확정하지 않는다", async () => {
    const { db, toss, stocks, sync, now, excluded, codes } = await setup();
    toss.holdings[1] = [us("SOXL", 100, 30), kr("005930", 3, 70000)];
    await sync.importHoldings();
    await stocks.remove("005930");
    toss.glitch[1] = [];
    const auto = new HoldingsAutoSync({ sync, intervalMin: 10, now });
    const first = auto.run("order");
    await auto.run("order"); // 실행 중 체결 알림 → 끝나면 한 번 더
    await first;
    await vi.waitFor(() => expect(toss.holdingsCalls).toBe(3));
    await vi.waitFor(() => expect(auto.status().running).toBe(false));
    expect(auto.status().lastChanges).toMatchObject({ removed: 0 });
    expect(await stocks.get("SOXL")).toMatchObject({ quantity: 100, avgPrice: 30 });
    expect(await excluded()).toBe('["005930"]');

    delete toss.glitch[1];
    const r = await sync.importHoldings();
    expect(r.added).toEqual([]);
    expect(await codes()).toEqual(["SOXL"]);
    await db.destroy();
  });

  it("계좌가 10분 간격 동기화 두 번 동안 빠져도 그 계좌 종목을 관심으로 바꾸지 않고, 돌아오면 지운 종목도 그대로 빠져 있다", async () => {
    const { db, toss, stocks, sync, advance, excluded, codes } = await setup();
    toss.accountsList = [3, 7];
    toss.holdings = { 3: [kr("005930", 3, 70000)], 7: [us("NVDA", 5, 120), us("AMD", 2, 150)] };
    await sync.importHoldings();
    await stocks.remove("AMD");
    toss.accountsList = [3];
    expect((await sync.importHoldings()).removed).toEqual([]);
    advance(10 * 60_000);
    expect((await sync.importHoldings()).removed).toEqual([]);
    expect(await stocks.get("NVDA")).toMatchObject({ quantity: 5, avgPrice: 120 });
    expect(await excluded()).toBe('["AMD"]');

    toss.accountsList = [3, 7];
    advance(10 * 60_000);
    expect((await sync.importHoldings()).added).toEqual([]);
    expect(await codes()).toEqual(["005930", "NVDA"]);
    await db.destroy();
  });

  it("믿지 않는 계좌 몫만 미룬다: 다른 계좌가 비어 있거나 잠깐 빠져도 이 계좌의 진짜 전량 매도는 바로 반영한다", async () => {
    const { db, toss, stocks, sync } = await setup();
    toss.accountsList = [1, 2];
    toss.holdings = { 1: [us("SOXL", 100, 30), kr("005930", 3, 70000)], 2: [] };
    toss.usdUnknown.add(2); // 계좌 2: 보유 없음 + 요약의 달러 매입금액 모름
    await sync.importHoldings();
    toss.holdings[1] = [kr("005930", 3, 70000)]; // 계좌 1 에서 SOXL 전량 매도
    expect((await sync.importHoldings()).removed).toEqual(["SOXL"]);
    expect(await stocks.get("SOXL")).toMatchObject({ quantity: null, avgPrice: null });

    // 보유가 있던 계좌 2 가 목록에서 빠진 사이에도 계좌 1 의 매도는 바로
    toss.holdings = { 1: [kr("005930", 3, 70000)], 2: [us("NVDA", 5, 120)] };
    await sync.importHoldings();
    toss.accountsList = [1];
    toss.holdings[1] = [];
    expect((await sync.importHoldings()).removed).toEqual(["005930"]);
    expect(await stocks.get("NVDA")).toMatchObject({ quantity: 5, avgPrice: 120 });
    await db.destroy();
  });

  it("진짜 전량 매도는 반영한다: 요약도 0 이면 바로, 요약과 맞지 않는 응답·빠진 계좌는 24시간 넘게 두 번 이상 이어지면 그때", async () => {
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
    b.advance(23 * 3_600_000);
    expect((await b.sync.importHoldings()).removed).toEqual([]); // 두 번째지만 아직 24시간 전
    expect(await b.excluded()).toBe('["005930"]');
    b.advance(2 * 3_600_000);
    expect((await b.sync.importHoldings()).removed).toEqual(["SOXL"]);
    expect(await b.excluded()).toBe("[]");
    await b.db.destroy();

    // 동기화가 하루 넘게 멈췄다가 처음 한 번 빠진 것만으로는 지우지 않는다 (처음 빠진 시각부터 센다)
    const c = await setup();
    c.toss.accountsList = [3, 7];
    c.toss.holdings = { 3: [kr("005930", 3, 70000)], 7: [us("NVDA", 5, 120)] };
    await c.sync.importHoldings();
    c.advance(48 * 3_600_000);
    c.toss.accountsList = [3];
    expect((await c.sync.importHoldings()).removed).toEqual([]);
    c.advance(10 * 60_000);
    expect((await c.sync.importHoldings()).removed).toEqual([]);
    c.advance(24 * 3_600_000);
    expect((await c.sync.importHoldings()).removed).toEqual(["NVDA"]); // 해지·권한 해제로 보고 반영
    expect(await c.stocks.get("NVDA")).toMatchObject({ quantity: null, avgPrice: null });
    expect(await c.stocks.get("005930")).toMatchObject({ quantity: 3 });
    await c.db.destroy();
  });

  it("계좌별 기록이 없던 서버에서 넘어온 첫 동기화도 요약과 맞지 않는 빈 응답을 전량 매도로 보지 않는다", async () => {
    const { db, toss, stocks, sync } = await setup();
    toss.holdings[1] = [us("SOXL", 100, 30)];
    await sync.importHoldings();
    await db.deleteFrom("meta").where("key", "=", ACCOUNTS_KEY).execute(); // 이전 서버에서 동기화한 상태
    toss.glitch[1] = [];
    expect((await sync.importHoldings()).removed).toEqual([]);
    expect(await stocks.get("SOXL")).toMatchObject({ quantity: 100, avgPrice: 30 });
    await db.destroy();
  });

  it("계좌별 기록이 없던 첫 동기화에서도, 늘 비어 있고 달러 요약이 없는 계좌 때문에 다른 계좌의 전량 매도를 미루지 않는다", async () => {
    const { db, toss, stocks, sync } = await setup();
    toss.accountsList = [1, 2];
    toss.holdings = { 1: [us("SOXL", 100, 30), kr("005930", 3, 70000)], 2: [] };
    toss.usdUnknown.add(2);
    await sync.importHoldings();
    await db.deleteFrom("meta").where("key", "=", ACCOUNTS_KEY).execute(); // 이전 서버에서 동기화한 상태
    toss.holdings[1] = [kr("005930", 3, 70000)]; // 계좌 1 에서 SOXL 전량 매도
    expect((await sync.importHoldings()).removed).toEqual(["SOXL"]);
    expect(await stocks.get("SOXL")).toMatchObject({ quantity: null, avgPrice: null });
    expect((await stocks.tossSynced()).has("SOXL")).toBe(false); // 잠기지 않아 직접 고칠 수 있다
    await db.destroy();
  });

  it("요약에 달러 매입금액이 없어(모름) 빈 보유 목록을 확인할 수 없으면 30분 넘게·두 번 이상 이어질 때 반영한다 (24시간 기다리지 않는다)", async () => {
    const { db, toss, stocks, sync, advance } = await setup();
    toss.usdUnknown.add(1);
    toss.holdings[1] = [kr("005930", 3, 70000)];
    await sync.importHoldings();
    toss.holdings[1] = []; // 실제로 전부 팔았고, 요약에는 달러 매입금액이 빠져 있다
    expect((await sync.importHoldings()).removed).toEqual([]);
    advance(10 * 60_000);
    expect((await sync.importHoldings()).removed).toEqual([]);
    advance(25 * 60_000);
    expect((await sync.importHoldings()).removed).toEqual(["005930"]);
    expect(await stocks.get("005930")).toMatchObject({ quantity: null, avgPrice: null });

    // 같은 모양의 일시 오류(달러 종목만 있는 계좌의 빈 목록)가 한 번 오면 미루고, 다음 정상 응답에서 그대로 이어진다
    const b = await setup();
    b.toss.usdUnknown.add(1);
    b.toss.holdings[1] = [us("SOXL", 100, 30)];
    await b.sync.importHoldings();
    b.toss.glitch[1] = [];
    expect((await b.sync.importHoldings()).removed).toEqual([]);
    delete b.toss.glitch[1];
    b.advance(40 * 60_000);
    expect((await b.sync.importHoldings()).removed).toEqual([]);
    expect(await b.stocks.get("SOXL")).toMatchObject({ quantity: 100, avgPrice: 30 });
    await db.destroy();
    await b.db.destroy();
  });

  it("두 계좌에 같이 있는 종목은 한 계좌 응답이 잠깐 비어도 그 계좌 몫이 빠진 합계로 수량·평단을 바꾸지 않는다", async () => {
    const { db, toss, stocks, sync } = await setup();
    toss.accountsList = [1, 2];
    toss.holdings = { 1: [us("NVDA", 5, 120)], 2: [us("NVDA", 10, 100), kr("005930", 3, 70000)] };
    await sync.importHoldings();
    expect(await stocks.get("NVDA")).toMatchObject({ quantity: 15, avgPrice: 106.67 });
    const detail = async () =>
      (JSON.parse((await db.selectFrom("meta").select("value").where("key", "=", "toss_holdings_detail").executeTakeFirstOrThrow()).value) as {
        items: Record<string, { quantity: number }>;
      }).items;

    toss.glitch[2] = []; // 계좌 2 응답만 잠깐 빔 (요약은 그대로)
    const r = await sync.importHoldings();
    expect(r).toMatchObject({ updated: [], removed: [] });
    expect(await stocks.get("NVDA")).toMatchObject({ quantity: 15, avgPrice: 106.67 });
    expect(await stocks.get("005930")).toMatchObject({ quantity: 3 });
    expect((await detail())["NVDA"]).toMatchObject({ quantity: 15 });

    delete toss.glitch[2];
    const r2 = await sync.importHoldings();
    expect(r2).toMatchObject({ updated: [], removed: [] });
    expect(await stocks.get("NVDA")).toMatchObject({ quantity: 15, avgPrice: 106.67 });
    await db.destroy();
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

  it("자동 동기화가 꺼져 있어도(0분) 토스에서 가져온 종목을 지우면 수동 동기화가 다시 넣지 않는다 (다시 등록하면 다시 맞춤)", async () => {
    const { db, toss, stocks, sync, excluded, codes } = await setup({ syncMinutes: 0 });
    toss.holdings[1] = [kr("005930", 3, 70000), us("TSLA", 4, 320)];
    const auto = new HoldingsAutoSync({ sync, intervalMin: 0, now: NOW });
    await auto.run("manual");
    expect((await stocks.tossSynced()).size).toBe(0); // 꺼져 있으면 잠그지 않는다
    expect(await stocks.remove("005930")).toEqual({ tossExcluded: true });

    const r = await auto.run("manual");
    expect(r?.added).toEqual([]);
    expect(r?.excluded).toEqual(["005930"]);
    expect(await codes()).toEqual(["TSLA"]);

    await stocks.register({ code: "005930" });
    expect(await excluded()).toBe("[]");
    await auto.run("manual");
    expect(await stocks.get("005930")).toMatchObject({ quantity: 3, avgPrice: 70000 });
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
  /**
   * 실행한 SQL 만 기록하는 Postgres 방언 Kysely (서버 없이 마이그레이션 문장을 확인).
   * applied: schema_version 에 이미 있는 버전 (이미 운영 중인 DB 흉내)
   */
  function recordingPostgres(applied: number[] = []) {
    const sqls: string[] = [];
    const inserted: number[] = [];
    const conn: DatabaseConnection = {
      executeQuery: async <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
        sqls.push(q.sql);
        if (/^select version from schema_version/i.test(q.sql.trim())) return { rows: applied.map((version) => ({ version })) as R[] };
        if (/^insert into schema_version/i.test(q.sql.trim())) inserted.push(Number(q.parameters[0]));
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
    return { db, sqls, inserted };
  }

  const versionsOf = async (db: Kysely<Database>) =>
    (await sql<{ version: number }>`select version from schema_version order by version`.execute(db)).rows.map((r) => Number(r.version));

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

  it("정밀도 마이그레이션은 버전 6 이다: 이미 5(계좌 한 장 브리핑)까지 올라간 Postgres DB 에도 적용된다", async () => {
    const { db, sqls, inserted } = recordingPostgres([1, 2, 3, 4, 5]);
    await migrate(db, "postgres");
    expect(inserted).toEqual([6]);
    expect(sqls.some((s) => /create table.*"?account_briefings"?/i.test(s))).toBe(false); // 5 는 다시 돌지 않는다
    const alter = sqls.filter((s) => /alter table\s+"?registered_stocks"?/i.test(s)).join("\n");
    expect(alter).toMatch(/"?quantity"?\s+type\s+double precision/i);
    expect(alter).toMatch(/"?avg_price"?\s+type\s+double precision/i);
    await db.destroy();

    // 새 Postgres DB 는 1~6 을 한 번씩 기록한다
    const fresh = recordingPostgres();
    await migrate(fresh.db, "postgres");
    expect(fresh.inserted).toEqual([1, 2, 3, 4, 5, 6]);
    await fresh.db.destroy();
  });

  it("새 SQLite DB 는 버전 1~6 을 한 번씩 기록하고, 5 까지 올라간 DB 도 6 만 더해 깨끗이 올라간다", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      expect(await versionsOf(db)).toEqual([1, 2, 3, 4, 5, 6]);
      // 버전 5 까지만 올라간 운영 DB 흉내: 계좌 브리핑·보유 종목이 이미 있다
      await sql`delete from schema_version where version = 6`.execute(db);
      await db
        .insertInto("account_briefings")
        .values({ briefing_date: "2026-09-24", session: "morning", status: "ok", summary: "s", detail: "d", data: "{}", model: "m", created_at: "x" })
        .execute();
      await db
        .insertInto("registered_stocks")
        .values({ code: "VRT", name: "VRT", market: "NYSE", quantity: 16.123456, avg_price: 201234.57, memo: null, created_at: "x", updated_at: "x" })
        .execute();
      await migrate(db, "sqlite");
      await migrate(db, "sqlite"); // 두 번 돌아도 안전
      expect(await versionsOf(db)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await db.selectFrom("account_briefings").select(["briefing_date", "session"]).execute()).toEqual([{ briefing_date: "2026-09-24", session: "morning" }]);
      expect(await db.selectFrom("registered_stocks").select(["quantity", "avg_price"]).where("code", "=", "VRT").executeTakeFirst()).toEqual({ quantity: 16.123456, avg_price: 201234.57 });
    } finally {
      await db.destroy();
    }
  });
});
