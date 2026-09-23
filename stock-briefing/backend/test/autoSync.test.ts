import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import type { MarketCalendar } from "../src/providers/market/calendar.js";
import type { TossHolding, TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { StockService } from "../src/services/stockService.js";
import { HoldingsAutoSync, TossSyncService } from "../src/services/tossSyncService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";

const NOW = () => new Date("2026-09-23T10:00:00+09:00");

/** 계좌 1개, 보유 목록을 테스트에서 바꿀 수 있는 가짜 토스 Open API */
class FakeToss {
  calls = 0;
  fail = false;
  holdingsList: TossHolding[] = [];
  noAccounts = false;
  async accounts() {
    if (this.fail) throw new Error("토스 계좌 조회 실패");
    return this.noAccounts ? [] : [{ accountNo: "1", accountSeq: 1, accountType: "BROKERAGE" }];
  }
  /** 동기화 도중(보유 조회 직후) 한 번 실행할 콜백 */
  duringSync: (() => void) | null = null;
  async holdingsWithOverview(_seq: number) {
    this.calls++;
    const items = this.holdingsList;
    const hook = this.duringSync;
    this.duringSync = null;
    hook?.();
    if (this.fail) throw new Error("토스 계좌 조회 실패");
    return { items, overview: { purchaseKrw: 0, purchaseUsd: 0, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null } };
  }
  async ordersForBook() {
    return [];
  }
  async usdKrwAt() {
    return 1400;
  }
  async stockInfos(codes: string[]) {
    return new Map(codes.map((c) => [c, { name: c === "TSLA" ? "테슬라" : "NAVER", market: c === "TSLA" ? "NASDAQ" : "KOSPI" }]));
  }
  asProvider(): TossOpenApiProvider {
    return this as unknown as TossOpenApiProvider;
  }
}

const h = (code: string, quantity: number, avgPrice: number, currency: "KRW" | "USD" = "KRW"): TossHolding => ({ code, name: code, currency, quantity, avgPrice, lastPrice: null });

async function setup() {
  const db = await createMigratedDb(":memory:");
  const toss = new FakeToss();
  const stocks = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), now: NOW });
  await stocks.refreshMaster();
  const sync = new TossSyncService(db, toss.asProvider(), NOW);
  return { db, toss, stocks, sync };
}

describe("TossSyncService 전량 매도 처리", () => {
  it("지난 동기화에 있던 종목이 사라지면 관심 종목(수량·평단 없음)으로 바꾸고, 토스에서 온 적 없는 종목은 건드리지 않는다", async () => {
    const { db, toss, stocks, sync } = await setup();
    await stocks.register({ code: "005930", quantity: 3, avgPrice: 70000, memo: "다른 증권사" });
    toss.holdingsList = [h("035420", 9, 232555), h("TSLA", 2, 300, "USD")];
    const r1 = await sync.importHoldings();
    expect(r1.added.sort()).toEqual(["035420", "TSLA"]);
    expect(r1.removed).toEqual([]);

    // 테슬라 전량 매도, NAVER 추가 매수
    toss.holdingsList = [h("035420", 12, 225000)];
    const r2 = await sync.importHoldings();
    expect(r2.updated).toEqual(["035420"]);
    expect(r2.removed).toEqual(["TSLA"]);
    const list = await stocks.list();
    expect(list.find((s) => s.code === "TSLA")).toMatchObject({ quantity: null, avgPrice: null, name: "테슬라" }); // 남아 있되 보유 정보만 비움
    expect(list.find((s) => s.code === "005930")).toMatchObject({ quantity: 3, memo: "다른 증권사" }); // 토스 밖 종목은 그대로
    expect(list.find((s) => s.code === "035420")).toMatchObject({ quantity: 12, avgPrice: 225000 });

    // 다시 실행해도 removed 는 반복되지 않고, 스냅샷은 재시작 후에도 남는다
    const r3 = await new TossSyncService(db, toss.asProvider(), NOW).importHoldings();
    expect(r3.removed).toEqual([]);
    expect(r3.unchanged).toEqual(["035420"]);
    await db.destroy();
  });

  it("계좌 목록이 비면 일시 오류로 보고 아무것도 바꾸지 않는다 (전량 매도로 처리하지 않음)", async () => {
    const { db, toss, stocks, sync } = await setup();
    toss.holdingsList = [h("035420", 9, 232555)];
    await sync.importHoldings();
    toss.noAccounts = true;
    await expect(sync.importHoldings()).rejects.toThrow("토스 계좌 목록이 비었습니다");
    expect((await stocks.list()).find((s) => s.code === "035420")).toMatchObject({ quantity: 9 });
    await db.destroy();
  });

  it("수량 0 으로 내려온 보유 항목은 보유로 치지 않는다", async () => {
    const { db, toss, sync } = await setup();
    toss.holdingsList = [h("035420", 0, 232555)];
    const r = await sync.importHoldings();
    expect(r.added).toEqual([]);
    expect(r.holdings).toEqual([]);
    await db.destroy();
  });
});

describe("HoldingsAutoSync", () => {
  it("run() 은 동기화하고 바뀐 게 있을 때만 afterSync 를 부르며, 실패는 lastError 에 남긴다(manual 은 던짐)", async () => {
    const { db, toss, sync } = await setup();
    let after = 0;
    const auto = new HoldingsAutoSync({ sync, afterSync: async () => void after++, intervalMin: 10, now: NOW });
    expect(auto.status()).toMatchObject({ enabled: false, lastRunAt: null }); // start() 전

    toss.holdingsList = [h("035420", 9, 232555)];
    const r = await auto.run("startup");
    expect(r?.added).toEqual(["035420"]);
    expect(after).toBe(1);
    expect(auto.status()).toMatchObject({ lastTrigger: "startup", lastError: null, lastChanges: { added: 1, updated: 0, removed: 0, holdings: 1 }, lastRunAt: "2026-09-23T10:00:00+09:00" });

    await auto.run("schedule"); // 변화 없음 → afterSync 안 부름
    expect(after).toBe(1);

    toss.fail = true;
    expect(await auto.run("schedule")).toBeNull();
    expect(auto.status().lastError).toContain("토스 계좌 조회 실패");
    await expect(auto.run("manual")).rejects.toThrow("토스 계좌 조회 실패");
    await db.destroy();
  });

  it("동시에 두 번 부르면 한 번만 실행된다", async () => {
    const { db, toss, sync } = await setup();
    toss.holdingsList = [h("035420", 9, 232555)];
    const auto = new HoldingsAutoSync({ sync, intervalMin: 10, now: NOW });
    const [a, b] = await Promise.all([auto.run("schedule"), auto.run("briefing")]);
    expect(a).toBe(b);
    expect(toss.calls).toBe(1);
    await db.destroy();
  });

  it("동기화 중에 체결 알림(order)이 오면 끝난 뒤 한 번 더 읽는다 (체결 전 잔고를 읽었을 수 있으므로)", async () => {
    const { db, toss, sync } = await setup();
    const auto = new HoldingsAutoSync({ sync, intervalMin: 10, now: NOW });
    toss.holdingsList = [h("035420", 9, 232555)];
    let second: Promise<unknown> | null = null;
    toss.duringSync = () => {
      toss.holdingsList = [h("035420", 12, 225000)]; // 이번 실행은 이미 9주를 읽었다
      second = auto.run("order");
    };
    await auto.run("schedule");
    await second;
    await new Promise((r) => setTimeout(r, 20));
    expect(toss.calls).toBe(2);
    expect((await db.selectFrom("registered_stocks").select("quantity").where("code", "=", "035420").executeTakeFirst())?.quantity).toBe(12);

    // order 가 아닌 트리거는 기존 실행 결과를 같이 기다리기만 한다
    toss.duringSync = () => void auto.run("schedule");
    await auto.run("briefing");
    await new Promise((r) => setTimeout(r, 20));
    expect(toss.calls).toBe(3);
    await db.destroy();
  });

  it("수동 실행이 실패해도 같이 기다리던 자동 실행(order)에는 오류를 넘기지 않고, 수동은 진행 중 실행이 끝난 뒤 자기 실행을 한다", async () => {
    const { db, toss, sync } = await setup();
    const auto = new HoldingsAutoSync({ sync, intervalMin: 10, now: NOW });
    toss.holdingsList = [h("035420", 9, 232555)];
    let joined: Promise<unknown> | null = null;
    // 수동 실행 도중 체결 알림으로 order 가 합류하고, 수동 실행은 실패한다
    toss.duringSync = () => {
      toss.fail = true;
      joined = auto.run("order");
    };
    await expect(auto.run("manual")).rejects.toThrow("토스 계좌 조회 실패");
    expect(await joined).toBeNull(); // 처리 안 된 거부 없이 null
    await new Promise((r) => setTimeout(r, 20)); // order 로 한 번 더 도는 실행도 조용히 실패
    expect(auto.status().lastError).toContain("토스 계좌 조회 실패");

    // 진행 중인 자동 실행에 수동이 겹치면: 자동이 끝난 뒤 수동이 따로 돌고, 실패는 수동 쪽에만 던진다
    toss.fail = false;
    toss.duringSync = () => {
      toss.fail = true;
    };
    const scheduled = auto.run("schedule");
    const manual = auto.run("manual");
    expect(await scheduled).toBeNull();
    await expect(manual).rejects.toThrow("토스 계좌 조회 실패");
    await db.destroy();
  });

  it("장중이면 intervalMin, 장 밖이면 idleIntervalMin 뒤에 다시 돈다. intervalMin 0 이면 꺼진다", async () => {
    const { db, sync } = await setup();
    let open = true;
    const calendar = { status: async () => ({ now: "", KR: { isOpen: open }, US: { isOpen: false } }) } as unknown as MarketCalendar;
    const auto = new HoldingsAutoSync({ sync, calendar, intervalMin: 10, idleIntervalMin: 60, now: NOW });
    expect(await auto.nextDelayMs()).toBe(10 * 60_000);
    open = false;
    expect(await auto.nextDelayMs()).toBe(60 * 60_000);

    const off = new HoldingsAutoSync({ sync, intervalMin: 0, now: NOW });
    off.start();
    expect(off.status()).toMatchObject({ enabled: false, nextRunAt: null });

    auto.start();
    expect(auto.status()).toMatchObject({ enabled: true, nextRunAt: "2026-09-23T01:00:15.000Z" }); // 시작 15초 뒤 첫 실행
    auto.stop();
    expect(auto.status()).toMatchObject({ enabled: false, nextRunAt: null });
    await db.destroy();
  });
});
