import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import type { Quote, RegisteredStock } from "../src/domain/types.js";
import { KrwCostBook, type BookOrder, type HoldingForBook, type OverviewForBook } from "../src/services/krwCostBook.js";
import { evaluate } from "../src/services/stockService.js";

const NOW = () => new Date("2026-09-23T12:00:00+09:00");

/** 계좌·종목별 주문 목록과 시각별 환율을 테스트에서 바꿀 수 있는 장부 */
async function setup(orders: Record<string, BookOrder[]>, rates: Record<string, number>) {
  const db = await createMigratedDb(":memory:");
  const calls = { orders: 0, fail: false, rateFail: false };
  const book = new KrwCostBook({
    db,
    now: NOW,
    orders: async (account, symbol) => {
      calls.orders++;
      if (calls.fail) throw new Error("429");
      return orders[`${account}:${symbol}`] ?? [];
    },
    rateAt: async (iso) => {
      if (calls.rateFail) throw new Error("환율 조회 실패");
      const r = rates[iso];
      if (r === undefined) throw new Error(`환율 없음 ${iso}`);
      return r;
    },
  });
  return { db, book, calls };
}

const usd = (code: string, quantity: number, purchaseAmount: number | null): HoldingForBook => ({ code, currency: "USD", quantity, purchaseAmount });
const one = (...holdings: HoldingForBook[]) => [{ account: 1, holdings }];
const krwOf = (s: Awaited<ReturnType<KrwCostBook["update"]>>, code: string) => KrwCostBook.summarize(s).get(code);

describe("KrwCostBook", () => {
  it("주문 내역을 이동평균으로 다시 계산한다 (매도는 비율대로 줄고, 전량 매도 뒤 새로 산 것만 남는다)", async () => {
    const { book, db } = await setup(
      {
        "1:RGTI": [
          { orderId: "a", side: "BUY", quantity: 595, amount: 6812.67, at: "2025-01-16T18:02:28+09:00" },
          { orderId: "b", side: "BUY", quantity: 1, amount: 11.54, at: "2025-01-16T21:05:42+09:00" },
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
      {
        "2025-01-16T18:02:28+09:00": 1458,
        "2025-01-16T21:05:42+09:00": 1462.65,
        "2026-09-19T00:34:53+09:00": 1392.82,
        "2026-05-01T23:00:00+09:00": 1500,
        "2026-06-01T23:00:00+09:00": 1400,
      },
    );
    const s = await book.update(one(usd("RGTI", 72, 1088.64), usd("VRT", 15, 3750), { code: "005930", currency: "KRW", quantity: 3, purchaseAmount: 210000 }), null, 1360);
    expect(krwOf(s, "RGTI")).toMatchObject({ quantity: 72, source: "estimated" });
    expect(krwOf(s, "RGTI")!.krw).toBeCloseTo(1088.64 * 1392.82, 3);
    // 20주 5,000달러·7,300,000원 → 5주 매도 후 15주: 3,750달러, 5,475,000원
    expect(krwOf(s, "VRT")!.krw).toBeCloseTo(5_475_000, 3);
    expect(krwOf(s, "005930")).toBeUndefined(); // 원화 종목은 장부에 없다
    await db.destroy();
  });

  it("토스 값을 넣으면 exact. 매도만 있으면 exact 유지, 추가 매수는 체결 시각 환율로 이어 붙이고 부분 체결은 차이만 더한다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 136, amount: 17559.65, at: "2026-09-01T23:00:00+09:00" }];
    const { book, db, calls } = await setup({ "1:SOXL": orders }, { "2026-09-01T23:00:00+09:00": 1410, "2026-09-22T23:00:00+09:00": 1370, "2026-09-22T23:05:00+09:00": 1371 });
    let s = await book.update(one(usd("SOXL", 136, 17559.65)), null, 1360);
    expect(krwOf(s, "SOXL")).toMatchObject({ source: "estimated" });
    expect(krwOf(s, "SOXL")!.krw).toBeCloseTo(17559.65 * 1410, 2);

    expect(await book.setExact({ SOXL: 24_557_187, NONE: 1000 }, one(usd("SOXL", 136, 17559.65)))).toEqual(["SOXL"]);
    const before = calls.orders;
    s = await book.update(one(usd("SOXL", 136, 17559.65)), null, 1360); // 그대로면 주문 조회도 하지 않는다
    expect(calls.orders).toBe(before);
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

  it("조회 실패(429·환율)는 기존 항목을 건드리지 않고, 다음 동기화에서 이어서 맞춘다", async () => {
    const orders: BookOrder[] = [{ orderId: "o1", side: "BUY", quantity: 10, amount: 1000, at: "t1" }];
    const { book, db, calls } = await setup({ "1:AAA": orders }, { t1: 1400, t2: 1350 });
    await book.update(one(usd("AAA", 10, 1000)), null, 1360);
    await book.setExact({ AAA: 1_380_000 }, one(usd("AAA", 10, 1000)));

    orders.push({ orderId: "o2", side: "BUY", quantity: 10, amount: 1200, at: "t2" });
    calls.fail = true;
    let s = await book.update(one(usd("AAA", 20, 2200)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_380_000, quantity: 10, source: "exact" }); // 그대로
    calls.fail = false;
    calls.rateFail = true;
    s = await book.update(one(usd("AAA", 20, 2200)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ krw: 1_380_000, quantity: 10 });
    calls.rateFail = false;
    s = await book.update(one(usd("AAA", 20, 2200)), null, 1360);
    expect(krwOf(s, "AAA")).toMatchObject({ quantity: 20, source: "estimated" });
    expect(krwOf(s, "AAA")!.krw).toBeCloseTo(1_380_000 + 1200 * 1350, 3);

    // 처음 보는 종목이 조회에 실패하면 임시 값도 만들지 않는다(표시 환율로 틀린 값을 내보내지 않게)
    calls.fail = true;
    s = await book.update(one(usd("AAA", 20, 2200), usd("BBB", 1, 100)), null, 1360);
    expect(krwOf(s, "BBB")).toBeUndefined();
    await db.destroy();
  });

  it("주문 내역으로 설명되지 않으면(이관 등) 표시 환율 임시 값, 설명되면 바로 교체. 매입금액이 잠깐 비면 유지, 전량 매도는 삭제", async () => {
    const orders: BookOrder[] = [];
    const { book, db } = await setup({ "1:CCC": orders }, { t1: 1400 });
    let s = await book.update(one(usd("CCC", 5, 500)), null, 1360);
    expect(krwOf(s, "CCC")).toMatchObject({ krw: 500 * 1360, source: "estimated" });
    orders.push({ orderId: "o1", side: "BUY", quantity: 5, amount: 500, at: "t1" });
    s = await book.update(one(usd("CCC", 5, 500)), null, 1360);
    expect(krwOf(s, "CCC")!.krw).toBeCloseTo(500 * 1400, 6);

    s = await book.update(one(usd("CCC", 5, null)), null, 1360);
    expect(krwOf(s, "CCC")!.krw).toBeCloseTo(500 * 1400, 6);
    // 계좌 응답이 통째로 비면 일시 오류일 수 있어 두고, 다른 종목은 있는데 이 종목만 없으면 전량 매도로 지운다
    s = await book.update(one(), null, 1360);
    expect(krwOf(s, "CCC")).toBeDefined();
    s = await book.update(one({ code: "005930", currency: "KRW", quantity: 1, purchaseAmount: 70000 }), null, 1360);
    expect(krwOf(s, "CCC")).toBeUndefined();
    await db.destroy();
  });

  it("여러 계좌: 토스 값은 달러 매입금액 비율로 나누고, 종목별로 합산해 보여 준다", async () => {
    const { book, db } = await setup(
      {
        "1:DDD": [{ orderId: "a", side: "BUY", quantity: 3, amount: 300, at: "t1" }],
        "2:DDD": [{ orderId: "b", side: "BUY", quantity: 1, amount: 100, at: "t1" }],
      },
      { t1: 1400 },
    );
    const accounts = [
      { account: 1, holdings: [usd("DDD", 3, 300)] },
      { account: 2, holdings: [usd("DDD", 1, 100)] },
    ];
    let s = await book.update(accounts, null, 1360);
    expect(krwOf(s, "DDD")).toMatchObject({ quantity: 4, usdCost: 400, krw: 400 * 1400 });
    await book.setExact({ DDD: 540_000 }, accounts);
    s = await book.update(accounts, null, 1360);
    expect(krwOf(s, "DDD")).toMatchObject({ quantity: 4, krw: 540_000, source: "exact" });
    expect(Object.values(s.items).map((e) => e.krwExact).sort()).toEqual([135_000, 405_000]);
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
    await book.setExact({ AAA: 1_380_000 }, accounts);
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

  it("동시에 들어온 갱신과 사용자 입력이 서로 덮어쓰지 않는다", async () => {
    const { book, db } = await setup({ "1:AAA": [{ orderId: "a", side: "BUY", quantity: 10, amount: 1000, at: "t1" }] }, { t1: 1400 });
    const accounts = one(usd("AAA", 10, 1000));
    await Promise.all([book.update(accounts, null, 1360), book.setExact({ AAA: 1_390_000 }, accounts), book.update(accounts, null, 1360)]);
    expect(KrwCostBook.summarize(await book.load()).get("AAA")).toMatchObject({ krw: 1_390_000, source: "exact" });
    await db.destroy();
  });
});

describe("evaluate (토스 기준)", () => {
  const stock: RegisteredStock = { code: "RGTI", name: "리게티", market: "NASDAQ", quantity: 72, avgPrice: 15.12, memo: null, createdAt: "", updatedAt: "" };
  const quote = { code: "RGTI", currency: "USD", price: 17.34 } as Quote;
  it("토스 매입금액·비용 비율로 비용 차감 후 평가를 만들고, 해외 종목엔 원화 매입금액을 붙인다", () => {
    const ev = evaluate(stock, quote, { quantity: 72, purchaseAmount: 1088.64, costRate: 0.0018606, currency: "USD" }, { krw: 1_502_649, source: "exact", quantity: 72 })!;
    expect(ev.marketValue).toBeCloseTo(72 * 17.34, 6);
    expect(ev.costBasis).toBe(1088.64);
    expect(ev.afterCost!.marketValue).toBeCloseTo(72 * 17.34 * (1 - 0.0018606), 6);
    expect(ev.costBasisKrw).toBe(1_502_649);
    expect(ev.krwCostSource).toBe("exact");
  });
  it("사용자가 수량을 바꿔 토스 수량과 다르면 토스 기준을 쓰지 않는다", () => {
    const ev = evaluate({ ...stock, quantity: 50 }, quote, { quantity: 72, purchaseAmount: 1088.64, costRate: 0.0018, currency: "USD" }, { krw: 1_502_649, source: "exact", quantity: 72 })!;
    expect(ev.costBasis).toBeCloseTo(50 * 15.12, 6);
    expect(ev.afterCost).toBeNull();
    expect(ev.costBasisKrw).toBeNull();
  });
});
