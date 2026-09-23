import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Evaluation, Quote, RegisteredStock } from "@/api/types";
import { evalView, evaluate } from "@/lib/liveTick";

/**
 * 서버 evaluate() 결과(공용 픽스처)와 앱 evaluate() 가 0원 차이로 같은지.
 * 앱은 실시간 체결가마다 직전 서버 평가(prev)를 이어받아 다시 계산하므로, 서버가 체결가로 계산한 값과 같아야 한다.
 */
interface Case {
  name: string;
  stock: RegisteredStock;
  quote: Quote;
  tickPrice: number;
  toss?: unknown;
  krwCost?: unknown;
  atQuote: Evaluation | null;
  atTick: Evaluation | null;
}
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/evaluation.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("실시간 평가 = 서버 평가 (공용 픽스처)", () => {
  it("픽스처가 10건 이상", () => expect(fixture.cases.length).toBeGreaterThanOrEqual(10));

  for (const c of fixture.cases) {
    it(`체결가 반영 후 서버와 같다: ${c.name}`, () => {
      const live = evaluate(c.stock, { ...c.quote, price: c.tickPrice }, c.atQuote);
      expect(live).toEqual(c.atTick);
    });
  }

  for (const c of fixture.cases.filter((x) => !x.toss && !x.krwCost)) {
    it(`토스·장부가 없으면 직전 평가 없이도 같다: ${c.name}`, () => {
      expect(evaluate(c.stock, c.quote)).toEqual(c.atQuote);
    });
  }
});

describe("evaluate 경계", () => {
  const s = { quantity: 10, avgPrice: 1000 };
  const q = { code: "X", price: 1100, currency: "KRW" } as Quote;
  it("시세가 없으면 null", () => expect(evaluate(s, null)).toBeNull());
  it("수량이 음수면 null", () => expect(evaluate({ quantity: -1, avgPrice: 1000 }, q)).toBeNull());
  it("평단이 없으면 null", () => expect(evaluate({ quantity: 1, avgPrice: null }, q)).toBeNull());
  it("수익률은 소수 둘째 자리 반올림", () => expect(evaluate({ quantity: 3, avgPrice: 700 }, { ...q, price: 701 })!.profitRate).toBe(0.14));
});

describe("evalView (화면 표시 평가)", () => {
  const krwEv: Evaluation = { marketValue: 1_000_000, costBasis: 900_000, profit: 100_000, profitRate: 11.11, costRate: 0.002, afterCost: { marketValue: 998_000, profit: 98_000, profitRate: 10.89 } };
  const usdEv: Evaluation = { marketValue: 1000, costBasis: 800, profit: 200, profitRate: 25, costRate: 0.0025, afterCost: { marketValue: 997.5, profit: 197.5, profitRate: 24.69 }, costBasisKrw: 1_040_000, krwCostSource: "exact" };

  it("평가가 없으면 null", () => expect(evalView(null, { afterCost: true, toKrw: false, currency: "KRW", fx: null })).toBeNull());

  it("비용 차감 켜짐 → 차감 후 평가금액", () => {
    const v = evalView(krwEv, { afterCost: true, toKrw: false, currency: "KRW", fx: null })!;
    expect(v.marketValue).toBe(998_000);
    expect(v.profit).toBe(98_000);
  });

  it("비용 차감 꺼짐 → 원래 평가금액", () => {
    const v = evalView(krwEv, { afterCost: false, toKrw: false, currency: "KRW", fx: null })!;
    expect(v.marketValue).toBe(1_000_000);
    expect(v.profit).toBe(100_000);
  });

  it("차감 후 값이 없으면 켜져 있어도 원래 값", () => {
    const v = evalView({ ...krwEv, afterCost: null }, { afterCost: true, toKrw: false, currency: "KRW", fx: null })!;
    expect(v.marketValue).toBe(1_000_000);
  });

  it("원화 종목은 toKrw 여도 그대로", () => {
    const v = evalView(krwEv, { afterCost: false, toKrw: true, currency: "KRW", fx: 1360 })!;
    expect(v.currency).toBe("KRW");
    expect(v.krwBasis).toBeNull();
  });

  it("달러 종목 원화 보기: 평가 = 차감 후 × 환율, 매입 = 매수 당시 원화", () => {
    const v = evalView(usdEv, { afterCost: true, toKrw: true, currency: "USD", fx: 1360 })!;
    expect(v.currency).toBe("KRW");
    expect(v.marketValue).toBe(997.5 * 1360);
    expect(v.costBasis).toBe(1_040_000);
    expect(v.profit).toBe(997.5 * 1360 - 1_040_000);
    expect(v.krwBasis).toBe("purchase");
    expect(v.estimated).toBe(false);
  });

  it("장부 없으면 매입도 현재 환율 → 추정 표시", () => {
    const v = evalView({ ...usdEv, costBasisKrw: null, krwCostSource: null }, { afterCost: false, toKrw: true, currency: "USD", fx: 1360 })!;
    expect(v.costBasis).toBe(800 * 1360);
    expect(v.krwBasis).toBe("current");
    expect(v.estimated).toBe(true);
  });

  it("장부가 추정치면 estimated", () => {
    const v = evalView({ ...usdEv, krwCostSource: "estimated" }, { afterCost: false, toKrw: true, currency: "USD", fx: 1360 })!;
    expect(v.estimated).toBe(true);
    expect(v.krwBasis).toBe("purchase");
  });

  it("환율을 모르면 달러 그대로", () => {
    const v = evalView(usdEv, { afterCost: false, toKrw: true, currency: "USD", fx: null })!;
    expect(v.currency).toBe("USD");
    expect(v.marketValue).toBe(1000);
  });

  it("매입금액 0 이면 수익률 0 (0 나누기 없음)", () => {
    const v = evalView({ marketValue: 100, costBasis: 0, profit: 100, profitRate: 0 }, { afterCost: false, toKrw: false, currency: "KRW", fx: null })!;
    expect(v.profitRate).toBe(0);
  });

  it("통화가 없으면 원화로 본다 (구버전 서버)", () => {
    expect(evalView(krwEv, { afterCost: false, toKrw: false, currency: undefined, fx: null })!.currency).toBe("KRW");
  });
});
