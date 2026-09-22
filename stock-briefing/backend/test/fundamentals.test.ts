import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { applyFundamentals, NaverFundamentals, reutersCandidates } from "../src/providers/market/fundamentals.js";
import { StockService } from "../src/services/stockService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider, makeQuote } from "./helpers.js";

const KR_INTEGRATION = {
  totalInfos: [
    { code: "lastClosePrice", key: "전일", value: "197,900" },
    { code: "highPriceOf52Weeks", key: "52주 최고", value: "308,500" },
    { code: "lowPriceOf52Weeks", key: "52주 최저", value: "181,100" },
    { code: "per", key: "PER", value: "15.60배" },
    { code: "eps", key: "EPS", value: "12,885원" },
    { code: "pbr", key: "PBR", value: "1.02배" },
    { code: "bps", key: "BPS", value: "197,363원" },
    { code: "dividendYieldRatio", key: "배당수익률", value: "1.31%" },
    { code: "dividend", key: "주당배당금", value: "2,630원" },
  ],
};
const US_BASIC = {
  reutersCode: "TSLA.O",
  symbolCode: "TSLA",
  closePrice: "378.62",
  countOfListedStock: 3949547394,
  stockItemTotalInfos: [
    { code: "highPriceOf52Weeks", key: "52주 최고", value: "498.83" },
    { code: "lowPriceOf52Weeks", key: "52주 최저", value: "297.38" },
    { code: "per", key: "PER", value: "350.29배" },
    { code: "eps", key: "EPS", value: "1.08" },
    { code: "pbr", key: "PBR", value: "17.20배" },
    { code: "bps", key: "BPS", value: "21.99" },
    { code: "dividend", key: "주당배당금", value: "N/A" },
    { code: "dividendYieldRatio", key: "배당수익률", value: "N/A" },
    { code: "industryGroupKor", key: "업종", value: "자동차 및 트럭 제조" },
  ],
};
const FX = { exchangeInfo: { reutersCode: "FX_USDKRW", closePrice: "1,358.30" } };

function fakeFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/api/stock/035420/integration")) return ok(KR_INTEGRATION);
    if (url.includes("/stock/TSLA.O/basic")) return ok(US_BASIC);
    if (url.includes("/stock/KO/basic")) return ok({ ...US_BASIC, reutersCode: "KO", symbolCode: "KO" });
    if (url.includes("/marketindex/exchange/FX_USDKRW")) return ok(FX);
    return new Response(JSON.stringify({ code: "StockConflict" }), { status: 409 });
  }) as typeof fetch;
}

const NOW = () => new Date("2026-09-22T14:00:00+09:00");

describe("NaverFundamentals", () => {
  it("로이터 코드 후보: 나스닥 .O, NYSE/AMEX 접미사 없음, 클래스 주식은 소문자", () => {
    expect(reutersCandidates("TSLA", "NASDAQ")).toEqual(["TSLA.O", "TSLA"]);
    expect(reutersCandidates("KO", "NYSE")).toEqual(["KO", "KO.O"]);
    expect(reutersCandidates("BRK-B", "NYSE")).toEqual(["BRKb", "BRKb.O"]);
    expect(reutersCandidates("IONQ", null)).toEqual(["IONQ.O", "IONQ"]);
  });

  it("한국 종목 PER/PBR/EPS/BPS/배당/52주를 읽고 1시간 캐시한다", async () => {
    const calls: string[] = [];
    const f = new NaverFundamentals(fakeFetch(calls), NOW);
    const r = await f.get("035420", "KOSPI");
    expect(r).toMatchObject({ per: 15.6, pbr: 1.02, eps: 12885, bps: 197363, dividendPerShare: 2630, dividendYieldPct: 1.31, high52w: 308500, low52w: 181100 });
    await f.get("035420", "KOSPI");
    expect(calls).toHaveLength(1);
  });

  it("미국 종목은 .O → 접미사 없음 순으로 시도하고 N/A 는 null", async () => {
    const calls: string[] = [];
    const f = new NaverFundamentals(fakeFetch(calls), NOW);
    const t = await f.get("TSLA", "NASDAQ");
    expect(t).toMatchObject({ per: 350.29, pbr: 17.2, eps: 1.08, dividendPerShare: null, dividendYieldPct: null, industry: "자동차 및 트럭 제조", marketCap: Math.round(3949547394 * 378.62) });
    const ko = await f.get("KO", null); // .O 실패 → 접미사 없음
    expect(ko?.per).toBe(350.29);
    expect(calls.filter((c) => c.includes("/stock/KO"))).toHaveLength(2);
    expect(await f.get("ZZZZ", "NYSE")).toBeNull();
  });

  it("환율은 1분 캐시", async () => {
    const calls: string[] = [];
    const f = new NaverFundamentals(fakeFetch(calls), NOW);
    expect(await f.usdKrw()).toBe(1358.3);
    expect(await f.usdKrw()).toBe(1358.3);
    expect(calls.filter((c) => c.includes("FX_USDKRW"))).toHaveLength(1);
  });

  it("applyFundamentals 는 비어 있는 칸만 채운다", () => {
    const q = { ...makeQuote("035420", "toss"), per: 9 };
    const out = applyFundamentals(q, { per: 15.6, pbr: 1.02, eps: 1, bps: 2, dividendPerShare: 3, dividendYieldPct: 4, high52w: 5, low52w: 6, marketCap: 7, industry: "x", source: "s" });
    expect(out.per).toBe(9);
    expect(out.pbr).toBe(1.02);
    expect(out.high52w).toBe(5);
  });
});

describe("StockService 보강", () => {
  it("새로 받은 시세에 PER/PBR 과 환율(미국)을 채워 캐시한다", async () => {
    const db = await createMigratedDb(":memory:");
    const service = new StockService({
      db,
      quotes: new FakeQuoteProvider("toss"),
      search: new FakeSearchProvider([{ code: "TSLA", name: "테슬라", market: "NASDAQ", isinCode: null, groupCode: "ST" }]),
      master: new FakeMasterProvider(),
      fundamentals: new NaverFundamentals(fakeFetch(), NOW),
      now: NOW,
    });
    await service.refreshMaster();
    const kr = await service.getQuote("035420");
    expect(kr).toMatchObject({ per: 15.6, pbr: 1.02, dividendYieldPct: 1.31 });
    expect(kr.fxRate).toBeUndefined();

    // 미국: 가짜 시세는 KRW 로 오므로 USD 로 바꿔 넣는 별도 프로바이더
    const usd = new FakeQuoteProvider("toss", { price: 378.62 });
    const origin = usd.getQuote.bind(usd);
    usd.getQuote = async (code) => ({ ...(await origin(code)), currency: "USD" });
    const svc2 = new StockService({ db, quotes: usd, search: new FakeSearchProvider(), master: new FakeMasterProvider(), fundamentals: new NaverFundamentals(fakeFetch(), NOW), now: NOW });
    await svc2.register({ code: "TSLA" }).catch(() => undefined);
    const us = await svc2.getQuote("TSLA", { fresh: true });
    expect(us).toMatchObject({ per: 350.29, fxRate: 1358.3, priceKrw: Math.round(378.62 * 1358.3), industry: "자동차 및 트럭 제조" });
    await db.destroy();
  });
});
