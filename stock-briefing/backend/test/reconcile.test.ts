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

describe("토스 계좌 자동 대조 (3-13)", () => {
  it("원화는 원화끼리, 달러는 달러끼리 비교하고 합계 차이만 환율로 환산한다. 토스 밖 종목은 넣지 않는다", () => {
    const list = [row("005930", "KRW", 3_000_000), row("VRT", "USD", 40_000, { fx: 1391.37 }), row("MANUAL", "KRW", 9_999_999, { synced: false })];
    const e = compareWithToss(list, { afterCostKrw: 3_000_500, afterCostUsd: 40_010 }, "t");
    expect(e).toMatchObject({ appKrw: 3_000_000, appUsd: 40_000, tossKrw: 3_000_500, tossUsd: 40_010, fx: 1391.37, missing: 0 });
    expect(e.diffKrw).toBe(Math.round(-500 + -10 * 1391.37));
    expect(e.diffPct).toBeCloseTo((-500 - 13_913.7) / (3_000_500 + 40_010 * 1391.37) * 100, 3);
  });

  it("0.1% 초과가 3번 연속이면 한 번 알리고, 시세가 빠진 비교는 연속 횟수에 넣지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    const sent: string[] = [];
    let t = Date.parse("2026-09-28T10:00:00+09:00");
    const svc = new ReconcileService({ db, now: () => new Date(t), notify: async (x) => void sent.push(x) });
    const ok = [row("005930", "KRW", 1_000_000)];
    const off = [row("005930", "KRW", 1_010_000)]; // +1%
    const miss = [row("005930", "KRW", 0, { noQuote: true })];
    await svc.record(ok, { afterCostKrw: 1_000_000, afterCostUsd: 0 });
    for (const l of [off, off, miss, off, off]) {
      t += 600_000;
      await svc.record(l, { afterCostKrw: 1_000_000, afterCostUsd: 0 });
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("10,000원");
    const st = await svc.status();
    expect(st).toMatchObject({ streakOver: 4, alert: true });
    expect(st.week).toEqual({ n: 5, withinPct: 20 });
    await svc.record(ok, { afterCostKrw: 1_000_000, afterCostUsd: 0 });
    expect((await svc.status()).streakOver).toBe(0);
  });
});
