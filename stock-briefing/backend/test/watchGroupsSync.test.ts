import { describe, expect, it } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { TossHolding, TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { FeatureService } from "../src/services/featureService.js";
import { StockService } from "../src/services/stockService.js";
import { TossSyncService } from "../src/services/tossSyncService.js";
import { WatchGroupService } from "../src/services/watchGroupService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";

/**
 * 로드맵 3-34 완료 기준 '토스 동기화가 그룹 배정을 덮어쓴 경우 0건': 동기화는 registered_stocks 의 정해 둔 칸(수량·평단·이름·시장·updated_at)만 쓰므로
 * watch_group_id · watch_position 이 늘 그대로여야 한다. 관심 3종목을 그룹·자리에 넣고 ① 새 보유 추가 ② 수량·평단 변경 ③ 전량 매도
 * ④ 다시 매수 ⑤ 동기화 제외(앱에서 지움) ⑥ 보유 응답이 잠깐 빔 — 매번 두 칸을 확인한다 (새로 들어온 보유만 비어 있음).
 * 옮기기와 동기화를 동시에 돌려도 서로 칸을 잃지 않는다. 시계 고정, 네트워크 없음 (가짜 토스는 autoSync.test 와 같은 모양)
 */
const NOW = () => new Date("2026-09-28T21:00:00+09:00");

class FakeToss {
  holdingsList: TossHolding[] = [];
  /** 있으면 요약의 원화 매입금액을 이 값으로 (보유 목록이 비었는데 매입금액이 남은 '잠깐 빈 응답' 흉내) */
  purchaseKrw: number | null = null;
  /** 보유 조회 직후 한 번 실행할 콜백 (동기화 도중 끼어들기) */
  duringSync: (() => Promise<void>) | null = null;
  async accounts() {
    return [{ accountNo: "1", accountSeq: 1, accountType: "BROKERAGE" }];
  }
  async holdingsWithOverview(_seq: number) {
    const items = this.holdingsList;
    const hook = this.duringSync;
    this.duringSync = null;
    if (hook) await hook();
    const purchaseKrw = this.purchaseKrw ?? items.reduce((a, h) => a + h.quantity * h.avgPrice, 0);
    return { items, overview: { purchaseKrw, purchaseUsd: 0, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null } };
  }
  async ordersForBook() {
    return [];
  }
  async usdKrwAt() {
    return 1400;
  }
  async stockInfos(codes: string[]) {
    return new Map(codes.map((c) => [c, { name: c, market: "KOSPI" }]));
  }
  asProvider(): TossOpenApiProvider {
    return this as unknown as TossOpenApiProvider;
  }
}

const h = (code: string, quantity: number, avgPrice: number): TossHolding => ({ code, name: code, currency: "KRW", quantity, avgPrice, lastPrice: null });

async function setup() {
  const db = await createMigratedDb(":memory:");
  const toss = new FakeToss();
  // 토스 연동이 있는 서버 (지우면 동기화에서도 빠지는지 — tossExcluded — 를 정하려면 연동이 있어야 한다)
  const stocks = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), tossOpenApi: toss.asProvider(), now: NOW });
  await stocks.refreshMaster();
  const sync = new TossSyncService(db, toss.asProvider(), NOW);
  const groups = new WatchGroupService({ db, features: new FeatureService(db, NOW), now: NOW });
  return { db, toss, stocks, sync, groups };
}

const cells = async (db: Db) =>
  Object.fromEntries((await db.selectFrom("registered_stocks").select(["code", "watch_group_id", "watch_position"]).orderBy("code").execute()).map((r) => [r.code, [r.watch_group_id, r.watch_position]]));

describe("토스 동기화는 그룹·자리 칸을 덮어쓰지 않는다 (3-34 완료 기준)", () => {
  it("새 보유 · 수량·평단 변경 · 전량 매도 · 다시 매수 · 동기화 제외 · 응답이 잠깐 빔 — 매번 그대로 (새 보유만 비어 있음)", async () => {
    const { db, toss, stocks, sync, groups } = await setup();
    for (const code of ["005930", "000660", "247540"]) await stocks.register({ code });
    const semi = (await groups.create("반도체")).created!.id;
    const div = (await groups.create("배당")).created!.id;
    await groups.move("005930", semi, 0);
    await groups.move("000660", semi, 0);
    await groups.move("247540", div, 0);
    const start = { "000660": [semi, 0], "005930": [semi, 1], "247540": [div, 0] };
    expect(await cells(db)).toEqual(start);

    // ① 관심 종목을 샀고 새 종목도 샀다 (새 보유는 칸이 비어 있음)
    toss.holdingsList = [h("005930", 10, 70_000), h("035420", 3, 200_000)];
    expect((await sync.importHoldings()).added).toEqual(["035420"]);
    expect(await cells(db)).toEqual({ ...start, "035420": [null, null] });
    // ② 수량·평단이 바뀜
    toss.holdingsList = [h("005930", 12, 71_000), h("035420", 3, 200_000)];
    expect((await sync.importHoldings()).updated).toEqual(["005930"]);
    expect(await cells(db)).toEqual({ ...start, "035420": [null, null] });
    // ③ 전량 매도 → 관심으로 돌아와 원래 그룹·자리
    toss.holdingsList = [h("035420", 3, 200_000)];
    expect((await sync.importHoldings()).removed).toEqual(["005930"]);
    expect(await db.selectFrom("registered_stocks").select(["quantity"]).where("code", "=", "005930").executeTakeFirst()).toEqual({ quantity: null });
    expect(await cells(db)).toEqual({ ...start, "035420": [null, null] });
    expect((await groups.layout()).items.find((i) => i.code === "005930")).toEqual({ code: "005930", groupId: semi, position: 1 });
    // ④ 다시 매수
    toss.holdingsList = [h("005930", 1, 72_000), h("035420", 3, 200_000)];
    await sync.importHoldings();
    expect(await cells(db)).toEqual({ ...start, "035420": [null, null] });
    // ⑤ 앱에서 토스 종목을 지움(동기화 제외) → 행이 지워져 그룹도 사라지고, 동기화가 다시 넣지 않는다
    expect((await stocks.remove("035420")).tossExcluded).toBe(true);
    expect((await sync.importHoldings()).excluded).toEqual(["035420"]);
    expect(await cells(db)).toEqual(start);
    // ⑥ 보유 응답이 잠깐 빔(요약 매입금액은 남음 — 일시 오류로 봄) → 아무것도 바꾸지 않는다
    toss.holdingsList = [];
    toss.purchaseKrw = 72_000;
    expect((await sync.importHoldings()).removed).toEqual([]);
    expect(await cells(db)).toEqual(start);
    await db.destroy();
  });

  it("옮기기와 동기화를 동시에 돌려도 서로 칸을 잃지 않는다 (다른 잠금 · 다른 칸)", async () => {
    const { db, toss, stocks, sync, groups } = await setup();
    for (const code of ["005930", "000660"]) await stocks.register({ code });
    const semi = (await groups.create("반도체")).created!.id;
    toss.holdingsList = [h("247540", 2, 150_000), h("000660", 5, 180_000)];
    // 동기화가 보유를 받은 직후(쓰기 잠금 전) 옮기기가 끼어든다
    let moved: Promise<unknown> = Promise.resolve();
    toss.duringSync = async () => {
      moved = groups.move("005930", semi, 0).then(() => groups.move("000660", semi, 1));
    };
    await sync.importHoldings();
    await moved;
    expect(await cells(db)).toEqual({ "000660": [semi, 1], "005930": [semi, 0], "247540": [null, null] });
    expect(await db.selectFrom("registered_stocks").select(["code", "quantity"]).orderBy("code").execute()).toEqual([
      { code: "000660", quantity: 5 },
      { code: "005930", quantity: null },
      { code: "247540", quantity: 2 },
    ]);
    // 반대로 옮기기 도중 동기화 — 여러 번 번갈아도 그대로
    for (let i = 0; i < 5; i++) {
      toss.holdingsList = [h("247540", 2 + i, 150_000), h("000660", 5, 180_000)];
      await Promise.all([sync.importHoldings(), groups.move("005930", semi, i % 2), groups.move("247540", semi, 2)]);
    }
    const final = await cells(db);
    expect(final["247540"]).toEqual([semi, expect.any(Number)]);
    expect(final["005930"]![0]).toBe(semi);
    expect(final["000660"]![0]).toBe(semi);
    expect(await db.selectFrom("registered_stocks").select("quantity").where("code", "=", "247540").executeTakeFirst()).toEqual({ quantity: 6 });
    await db.destroy();
  });
});
