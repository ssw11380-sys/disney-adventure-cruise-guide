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
    if (url.includes("/stock/IONQ.K/basic")) return ok({ ...US_BASIC, reutersCode: "IONQ.K", symbolCode: "IONQ" });
    if (url.includes("ac.stock.naver.com/ac?q=IONQ")) return ok({ query: "IONQ", items: [{ code: "IONQ", name: "아이온큐", typeCode: "NYSE", reutersCode: "IONQ.K", nationCode: "USA", category: "stock" }] });
    if (url.includes("ac.stock.naver.com/ac")) return ok({ query: "", items: [] });
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
    const ko = await f.get("KO", null); // 자동완성 없음 → .O 실패 → 접미사 없음
    expect(ko?.per).toBe(350.29);
    expect(calls.filter((c) => c.includes("/stock/KO"))).toHaveLength(2);
    expect(await f.get("ZZZZ", "NYSE")).toBeNull();
    // 규칙에 없는 접미사(IONQ.K)는 자동완성으로 찾는다
    const ionq = await f.get("IONQ", "NYSE");
    expect(ionq?.per).toBe(350.29);
    expect(calls.filter((c) => c.includes("/stock/IONQ"))).toEqual([expect.stringContaining("/stock/IONQ.K/basic")]);
  });

  it("한 번 받기에 실패하면 1시간 동안 '값 없음'으로 두지 않고 곧 다시 받는다 (BH-43)", async () => {
    let t = Date.parse("2026-09-22T10:00:00+09:00");
    const calls: string[] = [];
    const ok = fakeFetch(calls);
    let blip = true;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (blip) {
        calls.push(String(input));
        throw new TypeError("fetch failed");
      }
      return ok(input, init);
    }) as typeof fetch;
    const f = new NaverFundamentals(fetchFn, () => new Date(t));
    expect(await f.get("035420", "KOSPI")).toBeNull(); // 10:00 네트워크 오류
    blip = false;
    t += 5 * 60_000; // 10:05 네이버 회복
    expect((await f.get("035420", "KOSPI"))?.per).toBe(15.6);
    t += 5 * 60_000; // 성공한 값은 1시간 캐시
    await f.get("035420", "KOSPI");
    expect(calls.filter((c) => c.includes("/035420/"))).toHaveLength(2);
  });

  it("미국: 5xx·자동완성 실패도 잠깐만 기억하고, 실제로 없는 종목(409)은 1시간 캐시", async () => {
    let t = Date.parse("2026-09-22T10:00:00+09:00");
    const calls: string[] = [];
    const ok = fakeFetch(calls);
    let down = true;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (down) {
        calls.push(String(input));
        return new Response("busy", { status: 503 });
      }
      return ok(input, init);
    }) as typeof fetch;
    const f = new NaverFundamentals(fetchFn, () => new Date(t));
    expect(await f.get("IONQ", "NYSE")).toBeNull();
    down = false;
    t += 5 * 60_000;
    expect((await f.get("IONQ", "NYSE"))?.per).toBe(350.29);
    // 없는 종목: 자동완성 빈 결과 + 후보 모두 409 → 1시간 동안 다시 묻지 않는다
    expect(await f.get("ZZZZ", "NYSE")).toBeNull();
    const n = calls.length;
    t += 30 * 60_000;
    expect(await f.get("ZZZZ", "NYSE")).toBeNull();
    expect(calls).toHaveLength(n);
  });

  it("자동완성은 클래스 주식을 점 없이(BRKB) 묻고, 네이버 코드의 공백(BRK B)도 같은 종목으로 본다 (BH-33)", async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("ac?q=BRKB&") ? { items: [{ code: "BRK B", name: "버크셔 해서웨이 B", reutersCode: "BRKb", nationCode: "USA" }] } : { items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const f = new NaverFundamentals(fetchFn, NOW);
    expect(await f.resolveReuters("BRK.B")).toBe("BRKb");
    expect(await f.resolveReuters("BRK-B")).toBe("BRKb");
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
    usd.getQuote = async (code) => ({ ...(await origin(code)), currency: "USD", priceKrw: Math.round(378.62 * 1371) }); // 공급자 환율(1371)은 화면 환율과 다를 수 있다
    const svc2 = new StockService({ db, quotes: usd, search: new FakeSearchProvider(), master: new FakeMasterProvider(), fundamentals: new NaverFundamentals(fakeFetch(), NOW), now: NOW });
    await svc2.register({ code: "TSLA" }).catch(() => undefined);
    const us = await svc2.getQuote("TSLA", { fresh: true });
    expect(us).toMatchObject({ per: 350.29, fxRate: 1358.3, priceKrw: Math.round(378.62 * 1358.3), industry: "자동차 및 트럭 제조" });
    await db.destroy();
  });
});

describe("환율 우선 소스", () => {
  it("fxPrimary(토스)가 값을 주면 네이버를 부르지 않고, 실패하면 네이버로 넘어간다", async () => {
    const { NaverFundamentals } = await import("../src/providers/market/fundamentals.js");
    let naverCalls = 0;
    const fetchFn = (async (url: string) => {
      naverCalls++;
      return new Response(JSON.stringify({ exchangeInfo: { closePrice: "1,348.80" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    let t = 0;
    const f = new NaverFundamentals(fetchFn, () => new Date(t));
    f.fxPrimary = async () => 1357.2;
    expect(await f.usdKrw()).toBe(1357.2);
    expect(naverCalls).toBe(0);
    t += 61_000;
    f.fxPrimary = async () => null;
    expect(await f.usdKrw()).toBe(1348.8);
    expect(naverCalls).toBe(1);
  });
});
