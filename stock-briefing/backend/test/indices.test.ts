import { describe, expect, it } from "vitest";
import { MarketIndices } from "../src/providers/market/indices.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("MarketIndices", () => {
  it("지수와 환율을 모으고, 실패한 항목만 빼며, 음수 등락률 부호를 맞춘다", async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      if (url.includes("KOSPI")) return json({ stockName: "코스피", closePrice: "7,026.35", compareToPreviousClosePrice: "8.44", fluctuationsRatio: "0.12", marketStatus: "OPEN", localTradedAt: "2026-09-23T11:18:00+09:00" });
      if (url.includes(".DJI")) return json({ closePrice: "51,863.69", compareToPreviousClosePrice: "-185.14", fluctuationsRatio: "0.36", marketStatus: "CLOSE" });
      if (url.includes("FX_USDKRW")) return json({ exchangeInfo: { closePrice: "1,352.10", fluctuations: "-3.40", fluctuationsRatio: "-0.25" } });
      return new Response("x", { status: 500 });
    }) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => new Date("2026-09-23T02:20:00Z"));
    const list = await m.list();
    expect(list.map((i) => i.code)).toEqual(["KOSPI", "DJI", "USDKRW"]);
    expect(list[0]).toMatchObject({ name: "코스피", value: 7026.35, change: 8.44, changeRate: 0.12, open: true });
    expect(list[1]).toMatchObject({ change: -185.14, changeRate: -0.36, open: false });
    expect(list[2]).toMatchObject({ name: "원/달러", value: 1352.1, change: -3.4, changeRate: -0.25 });
    const before = calls;
    await m.list();
    expect(calls).toBe(before); // 30초 캐시
  });
});
