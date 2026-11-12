import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { buildProviders } from "../src/providers/index.js";
import { TossProvider } from "../src/providers/market/toss.js";

/**
 * 출처 조립 (providers/index.ts buildProviders): 토스 공식 Open API 키가 있으면 상품 정보·수급·섹터가 공식 API 로 가는지,
 * 키가 없으면 예전 그대로(토스 웹)인지. 실제 조립 코드를 쓰고 전역 fetch 만 가짜로 바꾼다 (네트워크 없음)
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 가짜 인터넷: 토스 공식 API · 네이버 일봉은 답하고, 토스 웹(막힌 주소)은 지금 운영처럼 HTTP 400 */
function fakeInternet() {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(`${u.host}${u.pathname}${u.search}`);
    if (u.host === "openapi.tossinvest.com") {
      if (u.pathname === "/oauth2/token") return json({ access_token: "tok-1", token_type: "Bearer", expires_in: 86_400 });
      if (u.pathname === "/api/v1/stocks")
        return json({ result: [{ symbol: "SOXL", name: "SOXL", englishName: "DIREXION SHARES ETF TRUST DAILY SEMICONDUCTOR BULL 3X SHS", market: "AMEX", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "300000000", leverageFactor: "3", koreanMarketDetail: null }].filter((r) => (u.searchParams.get("symbols") ?? "").split(",").includes(r.symbol)) });
      if (u.pathname === "/api/v1/stocks/005930/investor-trading")
        return json({ result: { nextUntil: null, records: [{ date: "2026-09-28", updatedAt: "2026-09-28T20:15:40.000+09:00", individual: { netBuyVolume: "700000" }, foreigner: { netBuyVolume: "-500000" }, institution: { netBuyVolume: "-300000" }, otherCorporation: { netBuyVolume: "100000" }, foreignerHolding: { holdingQuantity: "10", limitQuantity: "100", holdingRate: "0.1" }, cfd: null }] } });
      if (u.pathname === "/api/v1/sectors/rankings") return json({ result: { rankings: [{ rank: 1, sectorId: "956", name: "양자컴퓨터", changeRate: "0.0179", tradingAmount: "1", marketCapitalization: "1", currency: "KRW" }] } });
      return json({ error: { code: "edge-blocked" } }, 404);
    }
    if (u.host === "api.stock.naver.com" && u.pathname.startsWith("/chart/domestic/item/005930/day")) return json([{ localDate: "20260928", openPrice: 285000, highPrice: 286000, lowPrice: 269500, closePrice: 270000, accumulatedTradingVolume: 21080365 }]);
    if (u.host === "wts-info-api.tossinvest.com") return json({ error: { errorCode: "invalid-client-state" } }, 400);
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchFn };
}
const log = { warn: () => undefined, info: () => undefined };

afterEach(() => vi.unstubAllGlobals());

describe("출처 조립: 토스 공식 Open API 키가 있을 때", () => {
  it("상품 정보는 공식 종목 정보에서 — 토스 웹(막힌 주소)을 부르지 않는다", async () => {
    const net = fakeInternet();
    vi.stubGlobal("fetch", net.fetchFn);
    const db = await createMigratedDb(":memory:");
    try {
      const p = buildProviders(loadConfig({ DATABASE_URL: ":memory:", TOSS_CLIENT_ID: "c_1", TOSS_CLIENT_SECRET: "s_1" }), db, log);
      expect(await p.productInfo!.productFacts("SOXL")).toMatchObject({ group: "EF", exchange: "AMX", leverageFactor: 3 });
      expect(net.calls.filter((c) => c.startsWith("wts-info-api"))).toEqual([]);
      expect(net.calls).toContain("openapi.tossinvest.com/api/v1/stocks?symbols=SOXL");
      // 공식 API 가 모르는 종목만 토스 웹을 한 번 물어 본다 (막혀 있으면 null)
      expect(await p.productInfo!.productFacts("ZZZZ")).toBeNull();
      expect(net.calls.some((c) => c.startsWith("wts-info-api"))).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("수급 탭의 공식 출처: 투자자별 매매동향 + 한국거래소 정규장 일봉(네이버) 종가", async () => {
    const net = fakeInternet();
    vi.stubGlobal("fetch", net.fetchFn);
    const db = await createMigratedDb(":memory:");
    try {
      const p = buildProviders(loadConfig({ DATABASE_URL: ":memory:", TOSS_CLIENT_ID: "c_1", TOSS_CLIENT_SECRET: "s_1" }), db, log);
      const official = p.investorFlowSources!.official!;
      expect(official.name).toBe("toss-openapi");
      expect(await official.trend("005930", 70)).toEqual([
        { date: "2026-09-28", individual: 700_000, foreign: -500_000, institution: -300_000, otherCorp: 100_000, foreignRatio: 10, foreignHolding: 10, foreignLimit: 100, close: 270_000, inMarketTime: null, hasAll: true, updatedAt: "2026-09-28T20:15:40.000+09:00" },
      ]);
      expect(net.calls).toContain("openapi.tossinvest.com/api/v1/stocks/005930/investor-trading?count=70");
      expect(net.calls.some((c) => c.startsWith("api.stock.naver.com/chart/domestic/item/005930/day"))).toBe(true);
      // 대조용 인스턴스(브리핑 수집기와 같은 것)도 그대로 있다
      expect(p.investorFlowSources!.openApi).toBe(p.tossOpenApi);
    } finally {
      await db.destroy();
    }
  });

  it("섹터(테마 분류) 출처가 생긴다 — 토스 웹 테마 분류(tics)도 그대로 둔다 (플래그를 끄면 그쪽)", async () => {
    const net = fakeInternet();
    vi.stubGlobal("fetch", net.fetchFn);
    const db = await createMigratedDb(":memory:");
    try {
      const p = buildProviders(loadConfig({ DATABASE_URL: ":memory:", TOSS_CLIENT_ID: "c_1", TOSS_CLIENT_SECRET: "s_1" }), db, log);
      expect(await p.sectorTics!.ranking("US", "1d")).toEqual([{ id: "956", name: "양자컴퓨터", rate: 1.79, stockCount: null, leader: null }]);
      expect(net.calls).toContain("openapi.tossinvest.com/api/v1/sectors/rankings?type=TOP_GAINERS&marketCountry=US&duration=1d");
      expect(p.tics).toBeTruthy();
      // 미국 정규장 종가는 아직 토스 웹 → Yahoo 그대로 (공식 일봉은 장 마감 직후 값을 확인하지 못해 넣지 않았다)
      expect(p.regularCloseSources!.US.map((s) => s.name)).toEqual(["toss", "yahoo"]);
    } finally {
      await db.destroy();
    }
  });
});

describe("출처 조립: 키가 없으면 예전 그대로", () => {
  it("상품 정보는 토스 웹 · 공식 수급 출처·섹터 출처 없음", async () => {
    const net = fakeInternet();
    vi.stubGlobal("fetch", net.fetchFn);
    const db = await createMigratedDb(":memory:");
    try {
      const p = buildProviders(loadConfig({ DATABASE_URL: ":memory:" }), db, log);
      expect(p.tossOpenApi).toBeNull();
      expect(p.productInfo).toBeInstanceOf(TossProvider);
      expect(p.sectorTics).toBeNull();
      expect(p.investorFlowSources!.official).toBeNull();
      expect(p.investorFlowSources!.openApi).toBeNull();
      expect(net.calls).toEqual([]); // 만들기만 해서는 아무것도 부르지 않는다
    } finally {
      await db.destroy();
    }
  });
});
