import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import type { Quote, RegisteredStock } from "../src/domain/types.js";
import { ACCOUNT_GONE_MS, KrwCostBook, PENDING_MS, RateNotFoundError, type AccountForBook, type BookOrder, type HoldingForBook, type OverviewForBook } from "../src/services/krwCostBook.js";
import { evaluate } from "../src/services/stockService.js";

/** 계좌·종목별 주문 목록과 시각별 환율, 시계를 테스트에서 바꿀 수 있는 장부 */
async function setup(orders: Record<string, BookOrder[]>, rates: Record<string, number>) {
  const db = await createMigratedDb(":memory:");
  const ctl = { orders: 0, fail: false, rateFail: false, clock: new Date("2026-09-23T12:00:00+09:00") };
  const book = new KrwCostBook({
    db,
    now: () => ctl.clock,
    orders: async (account, symbol) => {
      ctl.orders++;
      if (ctl.fail) throw new Error("429");
      return orders[`${account}:${symbol}`] ?? [];
    },
    rateAt: async (iso) => {
      if (ctl.rateFail) throw new Error("환율 조회 실패");
      const r = rates[iso];
      if (r === undefined) throw new RateNotFoundError(iso); // 토스에 아예 없는 시각
      return r;
    },
  });
  const later = (ms: number) => (ctl.clock = new Date(ctl.clock.getTime() + ms));
  return { db, book, ctl, later };
}

const usd = (code: string, quantity: number, purchaseAmount: number | null): HoldingForBook => ({ code, currency: "USD", quantity, purchaseAmount });
const one = (...holdings: HoldingForBook[]): AccountForBook[] => [{ account: 1, holdings }];
const reader = (accounts: AccountForBook[] | (() => AccountForBook[])) => async () => (typeof accounts === "function" ? accounts() : accounts);
const krwOf = (s: Awaited<ReturnType<KrwCostBook["update"]>>, code: string) => KrwCostBook.summarize(s).get(code);

describe("KrwCostBook", () => {
  it("주문 내역을 이동평균으로 다시 계산한다 (매도는 비율대로 줄고, 전량 매도 전 매수분은 환율을 조회하지 않는다)", async () => {
    const { book, db } = await setup(
      {
        "1:RGTI": [
          // 2019년 매수분은 뒤에서 전량 매도돼 원화 금액이 0 이 되므로 환율이 없어도 된다
          { orderId: "a", side: "BUY", quantity: 595, amount: 6812.67, at: "2019-01-16T18:02:28+09:00" },
          { orderId: "b", side: "BUY", quantity: 1, amount: 11.54, at: "2019-01-16T21:05:42+09:00" },
          { orderId: "c", side: "SELL", quantity: 596, amount: 7003, at: "2025-02-15T07:13:08+09:00" },
          { orderId: "d", side: "BUY", quantity: 72, amount: 1088.64, at: "2026-09-19T00:34:53+09:00" },
        ],
        "1:VRT": [
          // 순서가 섞여 와도 체결 시각 순으로 반영한다
          { orderId: "z", side: "SELL", quantity: 5, amount: 1400, at: "2026-07-01T23:00:00+09:00" },
          { orderId: "x", side: "BUY", quantity: 10, amount: 3000, at: "2026-05-01T23:00:00+09:00" },
          { orderId: "y", side: "BUY", quantity: 10, amount: 2000, at: "2026-06-01T23:00:00+09:00" },
        ],
      },
      { "2026-09-19T00:34:53+09:00": 1392.82, "2026-05-01T23:00:00+09:00": 1500, "2026-06-01T23:00:00+09:00": 1400 },
    );
    const s = await book.update(one(usd("RGTI", 72, 1088.64), usd("VRT", 15, 3750), { code: "005930", currency: "KRW", quantity: 3, purchaseAmount: 210000 }), null, 1360);
    expect(krwOf(s, "RGTI")).toMatchObject({ quantity: 72, source: "estimated" });
    expect(krwOf(s, "RGTI")!.krw).toBeCloseTo(1088.64 * 1392.82, 3);
    // 20주 5,000달러·7,300,000원 → 5주 매도 후 15주: 3,750달러, 5,475,000원
    expect(krwOf(s, "VRT")!.krw).toBeCloseTo(5_475_000, 3);
    expect(krwOf(s, "005930")).toBeUndefined(); // 원화 종목은 장부에 없다
    expect(s.pending).toEqual({});
    await db.destroy();
  });

  it("토스 값을 넣으면 exact. 매도만 있으면 exact 유지, 추가 매수는 체결 시각 환율로 이어 붙이고 부분 체결은 차이만 더한다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 136, amount: 17559.65, at: "2026-09-01T23:00:00+09:00" }];
    const { book, db, ctl } = await setup({ "1:SOXL": orders }, { "2026-09-01T23:00:00+09:00": 1410, "2026-09-22T23:00:00+09:00": 1370, "2026-09-22T23:05:00+09:00": 1371 });
    let s = await book.update(one(usd("SOXL", 136, 17559.65)), null, 1360);
    expect(krwOf(s, "SOXL")).toMatchObject({ source: "estimated" });
    expect(krwOf(s, "SOXL")!.krw).toBeCloseTo(17559.65 * 1410, 2);

    const before = ctl.orders;
    // 장부가 이미 보유와 맞으면 주문을 다시 읽지 않고 그 반영 기록을 쓴다
    expect((await book.setExact({ SOXL: 24_557_187, NONE: 1000 }, reader(one(usd("SOXL", 136, 17559.65))))).applied).toEqual(["SOXL"]);
    expect(ctl.orders).toBe(before);
    s = await book.update(one(usd("SOXL", 136, 17559.65)), null, 1360); // 그대로면 주문 조회도 하지 않는다
    expect(ctl.orders).toBe(before);
    expect(krwOf(s, "SOXL")).toMatchObject({ krw: 24_557_187, source: "exact" });

    // 36주 매도 → 100주. 이동평균이라 달러·원화 매입금액이 같은 비율로 준다 → exact 유지
    orders.push({ orderId: "o2", side: "SELL", quantity: 36, amount: 5000, at: "2026-09-20T23:00:00+09:00" });
    const after = 17559.65 * (100 / 136);
    s = await book.update(one(usd("SOXL", 100, after)), null, 1360);
    expect(krwOf(s, "SOXL")!.source).toBe("exact");
    expect(krwOf(s, "SOXL")!.krw).toBeCloseTo(24_557_187 * (100 / 136), 3);

    // 10주 매수 주문이 4주만 먼저 체결(부분 체결) → 600달러 × 1,370
    orders.push({ orderId: "o3", side: "BUY", quantity: 4, amount: 600, at: "2026-09-22T23:00:00+09:00" });
    s = await book.update(one(usd("SOXL", 104, after + 600)), null, 1360);
    expect(krwOf(s, "SOXL")).toMatchObject({ source: "estimated", quantity: 104 });
    expect(krwOf(s, "SOXL")!.krw).toBeCloseTo(24_557_187 * (100 / 136) + 600 * 1370, 3);

    // 같은 주문의 나머지 6주 체결: 누적 10주·1,500달러로 오고 마지막 체결 시각이 바뀐다 → 차이(6주·900달러)만 새 시각 환율로
    orders[2] = { orderId: "o3", side: "BUY", quantity: 10, amount: 1500, at: "2026-09-22T23:05:00+09:00" };
    s = await book.update(one(usd("SOXL", 110, after + 1500)), null, 1360);
    expect(krwOf(s, "SOXL")!.quantity).toBe(110);
    expect(krwOf(s, "SOXL")!.krw).toBeCloseTo(24_557_187 * (100 / 136) + 600 * 1370 + 900 * 1371, 3);
    await db.destroy();
  });

  it("setExact 는 보유 → 주문 → 보유를 다시 읽어, 그 사이 체결이 있었던 종목은 저장하지 않는다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 10, amount: 1000, at: "t1" }];
    const { book, db } = await setup({ "1:AAA": orders }, { t1: 1400, t2: 1380 });
    let reads = 0;
    // 첫 읽기는 10주, 주문을 읽는 사이 2주 체결 → 두 번째 읽기는 12주
    const racing = reader(() => {
      reads++;
      if (reads === 1) {
        orders.push({ orderId: "o2", side: "BUY", quantity: 2, amount: 300, at: "t2" });
        return one(usd("AAA", 10, 1000));
      }
      return one(usd("AAA", 12, 1300));
    });
    expect((await book.setExact({ AAA: 1_380_000 }, racing)).applied).toEqual([]);
    expect(reads).toBe(2);
    // 다시 넣으면(체결 반영 뒤 토스 값) 저장되고, 이후 동기화에서 exact 가 그대로 남는다
    expect((await book.setExact({ AAA: 1_794_000 }, reader(one(usd("AAA", 12, 1300))))).applied).toEqual(["AAA"]);
    const s = await book.update(one(usd("AAA", 12, 1300)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_794_000, source: "exact" });
    await db.destroy();
  });

  it("조회 실패(429·환율)는 기존 항목을 건드리지 않고 기다리며, 다음 동기화에서 이어서 맞춘다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 10, amount: 1000, at: "t1" }];
    const { book, db, ctl } = await setup({ "1:AAA": orders }, { t1: 1400, t2: 1350 });
    await book.update(one(usd("AAA", 10, 1000)), null, 1360);
    await book.setExact({ AAA: 1_380_000 }, reader(one(usd("AAA", 10, 1000))));

    orders.push({ orderId: "o2", side: "BUY", quantity: 10, amount: 1200, at: "t2" });
    ctl.fail = true;
    let s = await book.update(one(usd("AAA", 20, 2200)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_380_000, quantity: 10, source: "exact" }); // 그대로
    expect(s.pending).toEqual({}); // 조회 실패는 "설명되지 않음"이 아니라 몇 번이든 다시 시도할 일
    ctl.fail = false;
    ctl.rateFail = true;
    s = await book.update(one(usd("AAA", 20, 2200)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_380_000, quantity: 10 });
    ctl.rateFail = false;
    s = await book.update(one(usd("AAA", 20, 2200)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ quantity: 20, source: "estimated" });
    expect(krwOf(s, "AAA")!.krw).toBeCloseTo(1_380_000 + 1200 * 1350, 3);
    expect(s.pending).toEqual({});

    // 처음 보는 종목이 조회에 실패하면 임시 값도 만들지 않는다(표시 환율로 틀린 값을 내보내지 않게)
    ctl.fail = true;
    s = await book.update(one(usd("AAA", 20, 2200), usd("BBB", 1, 100)), null, 1360);
    expect(krwOf(s, "BBB")).toBeUndefined();
    await db.destroy();
  });

  it("주문 내역으로 설명되지 않으면(이관·체결 순서) 기다렸다가, 오래 계속되면 가진 값으로 맞추고 이후 체결은 이어 붙인다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 2, amount: 300, at: "t1" }];
    const { book, db, ctl, later } = await setup({ "1:TSLA": orders }, { t1: 1400, t2: 1380 });
    // 5주 중 3주는 이관(주문 없음)
    let s = await book.update(one(usd("TSLA", 5, 800)), null, 1360);
    expect(krwOf(s, "TSLA")).toBeUndefined();
    expect(s.pending["1:TSLA"]).toBeDefined();
    later(PENDING_MS);
    s = await book.update(one(usd("TSLA", 5, 800)), null, 1360);
    // 설명되는 300달러는 체결 환율, 모자란 500달러는 표시 환율
    expect(krwOf(s, "TSLA")).toMatchObject({ quantity: 5, source: "estimated" });
    expect(krwOf(s, "TSLA")!.krw).toBeCloseTo(300 * 1400 + 500 * 1360, 6);
    const fetched = ctl.orders;
    s = await book.update(one(usd("TSLA", 5, 800)), null, 1360); // 맞춘 뒤엔 주문을 다시 읽지 않는다
    expect(ctl.orders).toBe(fetched);
    // 1주 추가 매수는 그대로 이어 붙는다
    orders.push({ orderId: "o2", side: "BUY", quantity: 1, amount: 150, at: "t2" });
    s = await book.update(one(usd("TSLA", 6, 950)), null, 1360);
    expect(krwOf(s, "TSLA")).toMatchObject({ quantity: 6 });
    expect(krwOf(s, "TSLA")!.krw).toBeCloseTo(300 * 1400 + 500 * 1360 + 150 * 1380, 6);
    await db.destroy();
  });

  it("체결 순서 때문에 이어 붙인 값이 토스보다 크면, 오래 계속될 때 exact 몫까지 비율대로 줄여 맞춘다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 100, amount: 10_000, at: "t1" }];
    const { book, db, later } = await setup({ "1:SOXL": orders }, { t1: 1380, "2026-09-22T23:30:00+09:00": 1390 });
    await book.update(one(usd("SOXL", 100, 10_000)), null, 1360);
    await book.setExact({ SOXL: 13_800_000 }, reader(one(usd("SOXL", 100, 10_000))));
    // 매수 X(10주, 일부는 매도 Y 전에 체결)와 매도 Y(50주): 마지막 체결 시각 순으로는 토스와 달러 매입금액이 다르다
    orders.push({ orderId: "x", side: "BUY", quantity: 10, amount: 1200, at: "2026-09-22T23:30:00+09:00" }); // 22:40 에 5주, 23:30 에 5주
    orders.push({ orderId: "y", side: "SELL", quantity: 50, amount: 6000, at: "2026-09-22T22:45:00+09:00" });
    const toss = 6152.38;
    let s = await book.update(one(usd("SOXL", 60, toss)), null, 1360);
    expect(krwOf(s, "SOXL")).toMatchObject({ quantity: 100 }); // 기다리는 동안은 그대로 (평가에선 수량이 달라 안 쓴다)
    later(PENDING_MS);
    s = await book.update(one(usd("SOXL", 60, toss)), null, 1360);
    const v = krwOf(s, "SOXL")!;
    expect(v).toMatchObject({ quantity: 60, source: "estimated", usdCost: toss });
    // 이어 붙인 값 (6,900,000 + 1,200 × 1,390) 을 토스 달러 매입금액 비율로
    expect(v.krw).toBeCloseTo((6_900_000 + 1200 * 1390) * (toss / 6200), 3);
    await db.destroy();
  });

  it("매입금액이 잠깐 비면 유지, 다른 종목은 있는데 이 종목만 없으면 전량 매도로 지운다. 빈 계좌는 요약으로 확인한다", async () => {
    const { book, db } = await setup({ "1:CCC": [{ orderId: "o1", side: "BUY", quantity: 5, amount: 500, at: "t1" }] }, { t1: 1400 });
    let s = await book.update(one(usd("CCC", 5, 500)), null, 1360);
    expect(krwOf(s, "CCC")!.krw).toBeCloseTo(500 * 1400, 6);
    s = await book.update(one(usd("CCC", 5, null)), null, 1360);
    expect(krwOf(s, "CCC")!.krw).toBeCloseTo(500 * 1400, 6);
    // 목록이 비었는데 요약엔 달러 매입금액이 있으면 일시 오류 → 둔다. 요약도 0 이면 전량 매도 → 지운다
    s = await book.update([{ account: 1, holdings: [], purchaseUsd: 500 }], null, 1360);
    expect(krwOf(s, "CCC")).toBeDefined();
    s = await book.update([{ account: 1, holdings: [], purchaseUsd: 0 }], null, 1360);
    expect(krwOf(s, "CCC")).toBeUndefined();
    await book.update(one(usd("CCC", 5, 500)), null, 1360);
    s = await book.update(one({ code: "005930", currency: "KRW", quantity: 1, purchaseAmount: 70000 }), null, 1360);
    expect(krwOf(s, "CCC")).toBeUndefined();
    await db.destroy();
  });

  it("여러 계좌: 토스 값은 장부의 계좌별 원화 금액 비율로 나누고 추정으로 두며, 종목별로 합산해 보여 준다", async () => {
    const { book, db } = await setup(
      {
        "1:DDD": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "t1" }],
        "2:DDD": [{ orderId: "b", side: "BUY", quantity: 10, amount: 1000, at: "t2" }],
      },
      { t1: 1300, t2: 1500 },
    );
    const accounts: AccountForBook[] = [
      { account: 1, holdings: [usd("DDD", 10, 1000)] },
      { account: 2, holdings: [usd("DDD", 10, 1000)] },
    ];
    let s = await book.update(accounts, null, 1360);
    expect(krwOf(s, "DDD")).toMatchObject({ quantity: 20, usdCost: 2000, krw: 2_800_000 });
    expect((await book.setExact({ DDD: 2_810_000 }, reader(accounts))).applied).toEqual(["DDD"]);
    s = await book.update(accounts, null, 1360);
    expect(krwOf(s, "DDD")).toMatchObject({ quantity: 20, krw: 2_810_000, source: "estimated" });
    // 달러가 아니라 장부의 원화 비율(1.3M : 1.5M)로 나뉜다
    const parts = Object.values(s.items).map((e) => Math.round(e.krwExact)).sort();
    expect(parts).toEqual([Math.round((2_810_000 * 13) / 28), Math.round((2_810_000 * 15) / 28)].sort());
    // 계좌 1 이 전량 매도(다른 종목은 보유) → 계좌 2 몫만 남는다
    s = await book.update([{ account: 1, holdings: [{ code: "005930", currency: "KRW", quantity: 1, purchaseAmount: 70000 }] }, accounts[1]!], null, 1360);
    expect(krwOf(s, "DDD")!.krw).toBeCloseTo((2_810_000 * 15) / 28, 3);
    await db.destroy();
  });

  it("계좌 전체 수익률로 estimated 몫만 보정하고 exact 는 건드리지 않는다. 동기화할수록 구간이 좁아진다", async () => {
    const { book, db } = await setup(
      {
        "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "t1" }],
        "1:BBB": [{ orderId: "b", side: "BUY", quantity: 10, amount: 1000, at: "t2" }],
      },
      { t1: 1400, t2: 1400 },
    );
    const accounts = one(usd("AAA", 10, 1000), usd("BBB", 10, 1000));
    await book.update(accounts, null, 1360);
    await book.setExact({ AAA: 1_380_000 }, reader(accounts));
    // 토스 내부 원화 매입금액: 국내 1,000,000 + AAA 1,380,000 + BBB 1,390,000 = 3,770,000
    // 비용 차감 후 평가: 국내 900,000 + 달러 × 1360 → 수익률 소수 4자리
    const overview = (usdAfter: number): OverviewForBook => {
      const value = 900_000 + usdAfter * 1360;
      return { purchaseKrw: 1_000_000, afterCostKrw: 900_000, afterCostUsd: usdAfter, rateAfterCost: Math.round((value / 3_770_000 - 1) * 10000) / 10000 };
    };
    let s = await book.update(accounts, overview(2100), 1360);
    const bbb1 = krwOf(s, "BBB")!.krw;
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_380_000, source: "exact" });
    expect(Math.abs(bbb1 - 1_390_000)).toBeLessThan(800); // 한 번만으로도 ±0.02% 안쪽
    for (const v of [2090, 2111, 2083, 2127, 2102, 2095, 2118, 2071]) s = await book.update(accounts, overview(v), 1360);
    expect(s.calib!.samples).toBe(9);
    expect(Math.abs(krwOf(s, "BBB")!.krw - 1_390_000)).toBeLessThanOrEqual(Math.abs(bbb1 - 1_390_000) + 1);
    expect(krwOf(s, "AAA")!.krw).toBe(1_380_000);

    // 보유 구성이 바뀌었는데 보정할 수 없으면(계좌 요약 없음) 예전 비율을 버린다
    s = await book.update(one(usd("AAA", 10, 1000)), null, 1360);
    expect(s.factor).toBe(1);
    await db.destroy();
  });

  it("장부가 보유 전부와 맞지 않으면(조회 실패로 빠진 종목) 계좌 합계 보정을 하지 않는다", async () => {
    const { book, db, ctl } = await setup(
      {
        "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 10_000, at: "t1" }],
        "1:BBB": [{ orderId: "b", side: "BUY", quantity: 1, amount: 300, at: "t1" }],
      },
      { t1: 1400 },
    );
    await book.update(one(usd("AAA", 10, 10_000)), null, 1350);
    ctl.fail = true; // BBB 주문 조회 실패 → 장부에 없음
    const value = 11_000 * 1350;
    const s = await book.update(one(usd("AAA", 10, 10_000), usd("BBB", 1, 300)), { purchaseKrw: 0, afterCostKrw: 0, afterCostUsd: 11_000, rateAfterCost: Math.round((value / 14_420_000 - 1) * 10000) / 10000 }, 1350);
    expect(s.factor).toBe(1);
    expect(krwOf(s, "AAA")!.krw).toBeCloseTo(14_000_000, 3);
    expect(s.calib!.samples).toBe(1); // 계좌 합계 구간은 그대로 쌓는다
    await db.destroy();
  });

  it("환율 조회가 20분 넘게 실패해도 표시 환율로 굳히지 않고, 복구되면 체결 시각 환율로 맞춘다", async () => {
    const { book, db, ctl, later } = await setup({ "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "2026-09-22T23:00:00+09:00" }] }, { "2026-09-22T23:00:00+09:00": 1450 });
    ctl.rateFail = true;
    for (let i = 0; i < 4; i++) {
      const s = await book.update(one(usd("AAA", 10, 1000)), null, 1380);
      expect(krwOf(s, "AAA")).toBeUndefined();
      later(PENDING_MS);
    }
    ctl.rateFail = false;
    const s = await book.update(one(usd("AAA", 10, 1000)), null, 1380);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_450_000, source: "estimated" });
    expect(s.items["1:AAA"]!.approx).toBeUndefined();
    await db.destroy();
  });

  it("setExact 는 읽은 주문이 보유를 설명할 때만 저장한다 (주문 목록이 늦으면 거절, 따라오면 저장)", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 10, amount: 1000, at: "2026-09-20T23:00:00+09:00" }];
    const { book, db } = await setup({ "1:AAA": orders }, { "2026-09-20T23:00:00+09:00": 1400, "2026-09-22T23:00:00+09:00": 1390, "2026-09-23T23:00:00+09:00": 1395 });
    await book.update(one(usd("AAA", 10, 1000)), null, 1360);
    // 2주 매수(o2)가 보유엔 반영됐는데 주문 목록엔 아직 없다
    const held = one(usd("AAA", 12, 1300));
    let s = await book.update(held, null, 1360);
    expect(s.pending["1:AAA"]).toBeDefined();
    expect((await book.setExact({ AAA: 1_690_000 }, reader(held))).applied).toEqual([]);
    orders.push({ orderId: "o2", side: "BUY", quantity: 2, amount: 300, at: "2026-09-22T23:00:00+09:00" });
    expect((await book.setExact({ AAA: 1_690_000 }, reader(held))).applied).toEqual(["AAA"]);
    // 이후 추가 매수는 토스 값 위에 그대로 이어 붙는다
    orders.push({ orderId: "o3", side: "BUY", quantity: 1, amount: 150, at: "2026-09-23T23:00:00+09:00" });
    s = await book.update(one(usd("AAA", 13, 1450)), null, 1360);
    expect(krwOf(s, "AAA")!.krw).toBeCloseTo(1_690_000 + 150 * 1395, 6);
    expect(s.items["1:AAA"]!.krwExact).toBe(1_690_000);
    await db.destroy();
  });

  it("계좌가 목록에서 빠지거나 응답의 달러 요약을 모르면(null) 항목을 지우지 않는다", async () => {
    const { book, db } = await setup({ "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "t1" }] }, { t1: 1400 });
    await book.update(one(usd("AAA", 10, 1000)), null, 1360);
    await book.setExact({ AAA: 1_395_000 }, reader(one(usd("AAA", 10, 1000))));
    let s = await book.update([], null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_395_000, source: "exact" });
    s = await book.update([{ account: 1, holdings: [], purchaseUsd: null }], null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_395_000, source: "exact" });
    await db.destroy();
  });

  it("토스에 아예 없는 과거 환율(404)은 기다렸다가 그 매수분만 표시 환율로 대신하고, 계좌 보정도 다시 켜진다", async () => {
    const { book, db, later } = await setup(
      {
        "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "2019-03-04T23:00:00+09:00" }],
        "1:BBB": [{ orderId: "b", side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T23:00:00+09:00" }],
      },
      { "2026-09-01T23:00:00+09:00": 1400 },
    );
    const accounts = one(usd("AAA", 10, 1000), usd("BBB", 10, 1000));
    const ov: OverviewForBook = { purchaseKrw: 0, afterCostKrw: 0, afterCostUsd: 2100, rateAfterCost: Math.round(((2100 * 1360) / 2_760_000 - 1) * 10000) / 10000 };
    let s = await book.update(accounts, ov, 1360);
    expect(krwOf(s, "AAA")).toBeUndefined();
    expect(s.pending["1:AAA"]).toBeDefined();
    expect(s.factorHash).toBeNull(); // 빠진 종목이 있어 보정하지 않음
    later(PENDING_MS);
    s = await book.update(accounts, ov, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ source: "estimated", quantity: 10 });
    expect(s.items["1:AAA"]!.approx).toBe(true);
    expect(s.factorHash).not.toBeNull(); // 장부가 보유 전부와 맞아 보정 재개
    await db.destroy();
  });

  it("setExact 는 못 한 이유를 돌려주고, 오래 설명되지 않은 보유(이관 입고)는 받아들인다", async () => {
    const { book, db, later } = await setup({ "1:TIN": [] }, {});
    const held = one(usd("TIN", 5, 500));
    let r = await book.setExact({ TIN: 700_000, NONE: 1 }, reader(held));
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([
      { code: "TIN", reason: "unexplained", retryAfter: "2026-09-23T12:20:00+09:00" },
      { code: "NONE", reason: "not_held" },
    ]);
    later(PENDING_MS);
    r = await book.setExact({ TIN: 700_000 }, reader(held));
    expect(r.applied).toEqual(["TIN"]);
    const s = await book.update(held, null, 1360);
    expect(krwOf(s, "TIN")).toMatchObject({ krw: 700_000, source: "exact" });
    await db.destroy();
  });

  it("다른 계좌는 보이는데 하루 넘게 목록에서 빠진 계좌의 항목은 지운다", async () => {
    const { book, db, later } = await setup(
      {
        "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "t1" }],
        "2:AAA": [{ orderId: "b", side: "BUY", quantity: 5, amount: 500, at: "t1" }],
      },
      { t1: 1400 },
    );
    await book.update([{ account: 1, holdings: [usd("AAA", 10, 1000)] }, { account: 2, holdings: [usd("AAA", 5, 500)] }], null, 1360);
    const only1 = [{ account: 1, holdings: [usd("AAA", 10, 1000)] }];
    // 동기화가 하루 넘게 멈췄다가 한 번 빠진 건 지우지 않는다 (처음 빠진 시각부터 센다)
    later(ACCOUNT_GONE_MS + 3_600_000);
    let s = await book.update(only1, null, 1360);
    expect(krwOf(s, "AAA")!.quantity).toBe(15);
    // 다시 보이면 처음부터 다시 센다
    later(600_000);
    await book.update([{ account: 1, holdings: [usd("AAA", 10, 1000)] }, { account: 2, holdings: [usd("AAA", 5, 500)] }], null, 1360);
    s = await book.update(only1, null, 1360);
    later(ACCOUNT_GONE_MS - 60_000);
    s = await book.update(only1, null, 1360);
    expect(krwOf(s, "AAA")!.quantity).toBe(15); // 아직 하루가 안 됨
    later(60_000);
    s = await book.update(only1, null, 1360);
    expect(krwOf(s, "AAA")!.quantity).toBe(10); // 하루 넘게, 여러 번 빠짐 → 지움
    expect(s.missing).toEqual({});
    await db.destroy();
  });

  it("동시에 들어온 갱신과 사용자 입력이 서로 덮어쓰지 않는다", async () => {
    const { book, db } = await setup({ "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "t1" }] }, { t1: 1400 });
    const accounts = one(usd("AAA", 10, 1000));
    await Promise.all([book.update(accounts, null, 1360), book.setExact({ AAA: 1_390_000 }, reader(accounts)), book.update(accounts, null, 1360)]);
    expect(KrwCostBook.summarize(await book.load()).get("AAA")).toMatchObject({ krw: 1_390_000, source: "exact" });
    await db.destroy();
  });
});

describe("evaluate (토스 기준)", () => {
  const stock: RegisteredStock = { code: "RGTI", name: "리게티", market: "NASDAQ", quantity: 72, avgPrice: 15.12, memo: null, createdAt: "", updatedAt: "" };
  const quote = { code: "RGTI", currency: "USD", price: 17.34, fxRate: 1400 } as Quote;
  it("토스 매입금액·비용 비율로 비용 차감 후 평가를 만들고, 해외 종목엔 원화 매입금액을 붙인다", () => {
    const ev = evaluate(stock, quote, { quantity: 72, purchaseAmount: 1088.64, costRate: 0.0018606, currency: "USD" }, { krw: 1_502_649, source: "exact", quantity: 72, usdCost: 1088.64 })!;
    expect(ev.marketValue).toBeCloseTo(72 * 17.34, 6);
    expect(ev.costBasis).toBe(1088.64);
    expect(ev.afterCost!.marketValue).toBeCloseTo(72 * 17.34 * (1 - 0.0018606), 6);
    expect(ev.costBasisKrw).toBe(1_502_649);
    expect(ev.krwCostSource).toBe("exact");
  });
  it("사용자가 수량을 바꿔 토스 수량과 다르면 토스 기준을 쓰지 않는다", () => {
    const ev = evaluate({ ...stock, quantity: 50 }, quote, { quantity: 72, purchaseAmount: 1088.64, costRate: 0.0018, currency: "USD" }, { krw: 1_502_649, source: "exact", quantity: 72, usdCost: 1088.64 })!;
    expect(ev.costBasis).toBeCloseTo(50 * 15.12, 6);
    expect(ev.afterCost).toBeNull();
    expect(ev.costBasisKrw).toBeNull();
  });
  it("수량이 같아도 달러 매입금액이 다르면(같은 수량 매도 후 재매수) 장부가 뒤처진 것으로 보고 추정한다", () => {
    const book = { krw: 1_400_000, source: "exact" as const, quantity: 10, usdCost: 1000 };
    const ev = evaluate({ ...stock, quantity: 10 }, quote, { quantity: 10, purchaseAmount: 1500, costRate: 0.0018, currency: "USD" }, book)!;
    expect(ev.costBasisKrw).toBeCloseTo(1_400_000 + 500 * 1400, 6);
    expect(ev.krwCostSource).toBe("estimated");
  });
  it("장부가 새 체결을 아직 못 따라왔으면 차이만 반영한다 (늘어난 매입분은 현재 환율, 줄었으면 비율)", () => {
    const book = { krw: 1_502_649, source: "exact" as const, quantity: 72, usdCost: 1088.64 };
    const bought = evaluate({ ...stock, quantity: 73 }, quote, { quantity: 73, purchaseAmount: 1105.98, costRate: 0.0018, currency: "USD" }, book)!;
    expect(bought.costBasisKrw).toBeCloseTo(1_502_649 + (1105.98 - 1088.64) * 1400, 6);
    expect(bought.krwCostSource).toBe("estimated");
    const sold = evaluate({ ...stock, quantity: 36 }, quote, { quantity: 36, purchaseAmount: 544.32, costRate: 0.0018, currency: "USD" }, book)!;
    expect(sold.costBasisKrw).toBeCloseTo(1_502_649 / 2, 6);
    expect(sold.krwCostSource).toBe("estimated");
  });
});
