import { describe, expect, it } from "vitest";
import type { Quote } from "../src/domain/types.js";
import { createMigratedDb } from "../src/db/index.js";
import { compareWithToss, ReconcileService } from "../src/services/reconcileService.js";
import type { RegisteredWithQuote } from "../src/services/stockService.js";
import { makeQuote } from "./helpers.js";

function row(code: string, cur: "KRW" | "USD", afterCost: number, opts: { synced?: boolean; noQuote?: boolean; fx?: number } = {}): RegisteredWithQuote {
  const quote: Quote = { ...makeQuote(code, "toss-openapi"), currency: cur, fxRate: cur === "USD" ? (opts.fx ?? 1400) : null };
  return {
    code, name: code, market: cur === "USD" ? "NASDAQ" : "KOSPI", quantity: 1, avgPrice: 1, memo: null, createdAt: "", updatedAt: "",
    tossSynced: opts.synced ?? true,
    quote: opts.noQuote ? null : quote,
    quoteError: null,
    evaluation: opts.noQuote ? null : { marketValue: afterCost * 1.001, costBasis: 1, profit: 0, profitRate: 0, costRate: 0.001, afterCost: { marketValue: afterCost, profit: 0, profitRate: 0 }, costBasisKrw: null, krwCostSource: null },
  };
}

const toss = (code: string, cur: "KRW" | "USD", v: number | null, quantity = 1) => ({ code, currency: cur, quantity, marketValueAfterCost: v });

describe("토스 계좌 자동 대조 (3-13)", () => {
  it("같은 종목끼리 원화는 원화끼리, 달러는 달러끼리 비교하고 합계 차이만 환율로 환산한다. 토스 밖 종목은 넣지 않는다", () => {
    const list = [row("005930", "KRW", 3_000_000), row("VRT", "USD", 40_000, { fx: 1391.37 }), row("MANUAL", "KRW", 9_999_999, { synced: false })];
    const e = compareWithToss(list, [toss("005930", "KRW", 3_000_500), toss("VRT", "USD", 40_010)], "t");
    expect(e).toMatchObject({ appKrw: 3_000_000, appUsd: 40_000, tossKrw: 3_000_500, tossUsd: 40_010, fx: 1391.37, missing: 0, n: 2 });
    expect(e.diffKrw).toBe(Math.round(-500 + -10 * 1391.37));
    expect(e.diffPct).toBeCloseTo((-500 - 13_913.7) / (3_000_500 + 40_010 * 1391.37) * 100, 3);
  });

  it("비교할 수 없는 경우는 비교 제외: 시세 없음·지연, 토스 평가금 없음, 환율 없음 (리뷰 m1·m3)", () => {
    const stale = row("005930", "KRW", 1_000_000);
    stale.quote = { ...stale.quote!, stale: true };
    expect(compareWithToss([stale], [toss("005930", "KRW", 1_000_000)], "t").missing).toBeGreaterThan(0);
    expect(compareWithToss([row("005930", "KRW", 1_000_000)], [toss("005930", "KRW", null)], "t").missing).toBeGreaterThan(0);
    const usd = row("VRT", "USD", 100);
    usd.quote = { ...usd.quote!, fxRate: null };
    expect(compareWithToss([usd], [toss("VRT", "USD", 100)], "t").missing).toBeGreaterThan(0);
    expect(compareWithToss([], [], "t").missing).toBeGreaterThan(0); // 비교할 금액 없음
  });

  it("수량이 다르면 평가금 비교에서 빼고 수량 차이로 따로 센다 (재검토: 연달은 동기화 사이 어긋남이 가격 경고가 되지 않게)", () => {
    const gone = row("005930", "KRW", 1_000_000);
    gone.quantity = null;
    const more = row("000660", "KRW", 2_000_000);
    more.quantity = 2;
    const e = compareWithToss([gone, more, row("035420", "KRW", 1_000_000)], [toss("005930", "KRW", 1_000_000), toss("000660", "KRW", 1_000_000, 1), toss("035420", "KRW", 1_000_000)], "t");
    expect(e.qtyMismatch).toEqual(["005930", "000660"]);
    expect(e.missing).toBe(2);
    expect(e).toMatchObject({ appKrw: 1_000_000, tossKrw: 1_000_000, diffKrw: 0 });
    // 소수점 수량의 끝자리 차이는 같은 수량으로 본다 (Postgres real: 105.234567 → 105.234566, 0.1+0.2)
    const frac = row("VRT", "USD", 100);
    frac.quantity = 105.234566;
    const sum = row("AAPL", "USD", 100);
    sum.quantity = 0.3;
    expect(compareWithToss([frac, sum], [toss("VRT", "USD", 100, 105.234567), toss("AAPL", "USD", 100, 0.1 + 0.2)], "t").qtyMismatch).toEqual([]);
  });

  it("수량 차이가 3번 연속이면 한 번 알린다", async () => {
    const db = await createMigratedDb(":memory:");
    const sent: string[] = [];
    const svc = new ReconcileService({ db, notify: async (x) => void sent.push(x) });
    const two = row("005930", "KRW", 1_000_000);
    two.quantity = 2;
    for (let i = 0; i < 4; i++) await svc.record([two], [toss("005930", "KRW", 1_000_000, 1)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("005930");
    expect(await svc.status()).toMatchObject({ qtyStreak: 4, alert: true, streakOver: 0 });
  });

  it("0.1% 초과가 3번 연속이면 한 번만 알리고, 비교 제외 건이 뒤에 붙어도 다시 알리지 않는다 (리뷰 M1)", async () => {
    const db = await createMigratedDb(":memory:");
    const sent: string[] = [];
    let t = Date.parse("2026-09-28T10:00:00+09:00");
    const svc = new ReconcileService({ db, now: () => new Date(t), notify: async (x) => void sent.push(x) });
    const ok = [row("005930", "KRW", 1_000_000)];
    const off = [row("005930", "KRW", 1_010_000)]; // +1%
    const miss = [row("005930", "KRW", 0, { noQuote: true })];
    const tItems = [toss("005930", "KRW", 1_000_000)];
    await svc.record(ok, tItems);
    for (const l of [off, off, miss, off, miss, miss, miss, off]) {
      t += 600_000;
      await svc.record(l, tItems);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("10,000원");
    const st = await svc.status();
    expect(st).toMatchObject({ streakOver: 4, alert: true });
    expect(st.week).toEqual({ n: 5, withinPct: 20 });
    await svc.record(ok, tItems);
    expect((await svc.status()).streakOver).toBe(0);
  });

  it("동시에 기록해도 빠지는 기록이 없다 (리뷰 nit)", async () => {
    const db = await createMigratedDb(":memory:");
    const svc = new ReconcileService({ db, now: () => new Date("2026-09-28T10:00:00+09:00") });
    await Promise.all(Array.from({ length: 5 }, () => svc.record([row("005930", "KRW", 1_000_000)], [toss("005930", "KRW", 1_000_000)])));
    expect(await svc.history()).toHaveLength(5);
    expect(await new ReconcileService({ db }).history()).toHaveLength(5); // DB 에도
  });
});
