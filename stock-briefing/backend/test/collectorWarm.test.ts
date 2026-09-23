import { describe, expect, it } from "vitest";
import { DataCollector } from "../src/services/collector.js";

describe("DataCollector.warm", () => {
  it("여러 종목 시세·기준가를 한 번에 받아 두고, 실패해도 그냥 진행한다", async () => {
    const calls: string[][] = [];
    const c = new DataCollector({
      quotes: {} as never,
      news: {} as never,
      financials: null,
      investorFlow: null,
      quickPrices: {
        getMany: async (codes: string[]) => {
          calls.push(codes);
          throw new Error("down");
        },
      },
    });
    await c.warm(["005930", "TSLA"]);
    await c.warm([]);
    expect(calls).toEqual([["005930", "TSLA"]]);
  });
});
