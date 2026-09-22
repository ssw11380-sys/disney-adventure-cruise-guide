import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/errors.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { FakeQuoteProvider } from "./helpers.js";

describe("QuoteProviderChain", () => {
  it("첫 소스가 성공하면 다음 소스를 호출하지 않는다", async () => {
    const kis = new FakeQuoteProvider("kis");
    const yahoo = new FakeQuoteProvider("yahoo");
    const chain = new QuoteProviderChain([kis, yahoo]);
    const q = await chain.getQuote("000660");
    expect(q.source).toBe("kis");
    expect(yahoo.calls).toBe(0);
  });

  it("첫 소스가 실패하면 다음 소스로 넘어가고 경고를 남긴다", async () => {
    const warnings: string[] = [];
    const chain = new QuoteProviderChain(
      [new FakeQuoteProvider("kis", { fail: true }), new FakeQuoteProvider("yahoo")],
      { warn: (_o, m) => warnings.push(m) },
    );
    const q = await chain.getQuote("000660");
    expect(q.source).toBe("yahoo");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("다음 소스로");
  });

  it("모든 소스가 실패하면 시도한 소스 목록을 담은 ProviderError 를 던진다", async () => {
    const chain = new QuoteProviderChain([
      new FakeQuoteProvider("kis", { fail: true }),
      new FakeQuoteProvider("yahoo", { fail: true }),
    ]);
    await expect(chain.getCandles("000660", "D", 10)).rejects.toThrow(ProviderError);
    await expect(chain.getCandles("000660", "D", 10)).rejects.toThrow("kis, yahoo");
  });
});
