import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/services/stockService.js";

/**
 * 앱과 서버가 같은 평가 계산을 쓰는지 공용 픽스처(stock-briefing/shared/fixtures/evaluation.json)로 묶어 둔다.
 * 서버가 이 값을 만들고, 앱 테스트(app/test/evaluation.test.ts)는 실시간 체결가에서 같은 값이 나오는지 본다.
 * 서버 계산을 바꿨다면 이 테스트가 먼저 깨진다 → 픽스처와 앱 evaluate() 를 같이 고칠 것.
 */
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/evaluation.json", import.meta.url), "utf8")) as {
  cases: { name: string; stock: any; quote: any; tickPrice: number; toss?: any; krwCost?: any; atQuote: unknown; atTick: unknown }[];
};

describe("공용 평가 픽스처", () => {
  it("케이스가 충분하다", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of fixture.cases) {
    it(`서버 evaluate() 와 픽스처가 같다: ${c.name}`, () => {
      expect(evaluate(c.stock, c.quote, c.toss ?? null, c.krwCost ?? null)).toEqual(c.atQuote);
      expect(evaluate(c.stock, { ...c.quote, price: c.tickPrice }, c.toss ?? null, c.krwCost ?? null)).toEqual(c.atTick);
    });
  }
});
