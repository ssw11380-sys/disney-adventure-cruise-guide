import { describe, expect, it } from "vitest";
import { classifyProduct, levInvOf } from "../src/analysis/leveraged.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import type { Candle } from "../src/domain/types.js";
import { ProviderError } from "../src/lib/errors.js";
import type { FlowTrendRow, FlowTrendSource } from "../src/providers/market/investorFlow.js";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { aggregateHalfHours, officialProductFacts, TossOpenApiClient, TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { OPENAPI_TREND_SIZE, parseOpenApiTrend, TossOpenApiTrend } from "../src/providers/market/tossOpenApiTrend.js";
import { parseSectors, parseSectorStocks, switchTics, TossSectorTics } from "../src/providers/market/tossSectors.js";
import type { TicsSource } from "../src/providers/market/tossTics.js";
import { FeatureService } from "../src/services/featureService.js";
import { FLOW_TEXT } from "../src/services/flowText.js";
import { withSectorTics } from "../src/services/holdingThemeMaps.js";
import { buildFlowBody, isFinalRow } from "../src/services/investorFlowCalc.js";
import { InvestorFlowService, type InvestorFlowSources } from "../src/services/investorFlowService.js";
import { UsThemeBook } from "../src/services/usThemes.js";
import { volumeStatus } from "../src/services/volumeBaseline.js";
import { fakeProviders } from "./helpers.js";

/**
 * 토스 웹(비공식) 주소에 기대던 기능을 토스 공식 Open API 로 옮긴 것 (2026-11-12).
 * 토스 웹 주소(wts-info-api)는 2026-11 부터 모든 경로가 HTTP 400 invalid-client-state 로 막혀 있다.
 *  1. 상품 정보 (ETF·레버리지 배수·우선주·정리매매) — /api/v1/stocks
 *  2. 수급 탭 (플래그 flowOpenApi) — /api/v1/stocks/{코드}/investor-trading
 *  3. 미국 테마 분류 · 내 종목 테마 (플래그 themeOpenApi) — /api/v1/sectors …
 *  4. 30분봉 — /api/v1/candles 1분봉을 묶어서
 * 응답 모양은 공식 문서(OpenAPI 1.2.28)와 2026-11-12 운영 서버에서 읽은 실제 응답으로 확인했다. 아래 숫자는 지어낸 값이다
 * (공식 API 원자료는 약관상 본인 목적에만 쓰므로 저장소에 싣지 않는다 — 종목 분류처럼 누구나 아는 사실만 실제 값)
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ───────────────────────────── 1. 상품 정보 ─────────────────────────────

/** 공식 종목 정보 (/api/v1/stocks) — 종목 유형·배수·우선주 여부는 2026-11-12 실제 응답 그대로, 발행 주식 수는 지어낸 값 */
const KR_DETAIL = { liquidationTrading: false, nxtSupported: false, krxTradingSuspended: false, nxtTradingSuspended: false };
const STOCKS: Record<string, Record<string, unknown>> = {
  SOXL: { symbol: "SOXL", name: "SOXL", englishName: "DIREXION SHARES ETF TRUST DAILY SEMICONDUCTOR BULL 3X SHS", market: "AMEX", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "300000000", leverageFactor: "3", koreanMarketDetail: null },
  SOXS: { symbol: "SOXS", name: "SOXS", englishName: "DIREXION DAILY SEMICONDUCTOR BEAR 3X ETF", market: "AMEX", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "30000000", leverageFactor: "-3", koreanMarketDetail: null },
  NVDL: { symbol: "NVDL", name: "NVDL", englishName: "GRANITESHARES 2X LONG NVDA DAILY ETF", market: "NASDAQ", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "100000000", leverageFactor: "2", koreanMarketDetail: null },
  QQQ: { symbol: "QQQ", name: "QQQ", englishName: "Invesco QQQ Trust Series 1", market: "NASDAQ", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "600000000", leverageFactor: "1", koreanMarketDetail: null },
  AAPL: { symbol: "AAPL", name: "애플", englishName: "Apple", market: "NASDAQ", securityType: "STOCK", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "14000000000", leverageFactor: null, koreanMarketDetail: null },
  BBW: { symbol: "BBW", name: "빌드어베어 워크숍", englishName: "Build-A-Bear Workshop", market: "NYSE", securityType: "STOCK", isCommonShare: true, status: "ACTIVE", currency: "USD", sharesOutstanding: "13000000", leverageFactor: null, koreanMarketDetail: null },
  "005930": { symbol: "005930", name: "삼성전자", englishName: "SamsungElec", market: "KOSPI", securityType: "STOCK", isCommonShare: true, status: "ACTIVE", currency: "KRW", sharesOutstanding: "5846278608", leverageFactor: null, koreanMarketDetail: { ...KR_DETAIL, nxtSupported: true } },
  "005935": { symbol: "005935", name: "삼성전자우", englishName: "SamsungElec(1P)", market: "KOSPI", securityType: "STOCK", isCommonShare: false, status: "ACTIVE", currency: "KRW", sharesOutstanding: "800000000", leverageFactor: null, koreanMarketDetail: KR_DETAIL },
  "122630": { symbol: "122630", name: "KODEX 레버리지", englishName: "KODEX LEVERAGE", market: "KOSPI", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "KRW", sharesOutstanding: "70000000", leverageFactor: "2", koreanMarketDetail: KR_DETAIL },
  "252670": { symbol: "252670", name: "KODEX 200선물인버스2X", englishName: "KODEX 200 Futures Inverse 2X", market: "KOSPI", securityType: "ETF", isCommonShare: true, status: "ACTIVE", currency: "KRW", sharesOutstanding: "7000000000", leverageFactor: "-2", koreanMarketDetail: KR_DETAIL },
  "530031": { symbol: "530031", name: "삼성 레버리지 WTI원유 선물 ETN", englishName: "Samsung Leverage WTI Futures ETN", market: "KOSPI", securityType: "ETN", isCommonShare: true, status: "ACTIVE", currency: "KRW", sharesOutstanding: "400000000", leverageFactor: "2", koreanMarketDetail: KR_DETAIL },
  "395400": { symbol: "395400", name: "SK리츠", englishName: "SK REIT", market: "KOSPI", securityType: "REIT", isCommonShare: true, status: "ACTIVE", currency: "KRW", sharesOutstanding: "300000000", leverageFactor: null, koreanMarketDetail: KR_DETAIL },
  "900001": { symbol: "900001", name: "정리매매종목", englishName: "Liquidating", market: "KOSDAQ", securityType: "STOCK", isCommonShare: true, status: "ACTIVE", currency: "KRW", sharesOutstanding: "1000000", leverageFactor: null, koreanMarketDetail: { ...KR_DETAIL, liquidationTrading: true } },
};

/** 1분봉 한 줄 (공식 API 모양 — timestamp 는 봉이 끝나는 시각) */
interface MinuteRow {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  currency: string;
}

/** 가짜 공식 API 서버: 토큰 · 종목 정보 · 1분봉 (쪽 나눔은 실제와 같게 — 최신순, before 는 그 시각 포함) */
function officialWorld() {
  const state = { failStocks: false, minutes: {} as Record<string, MinuteRow[]> };
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/oauth2/token") return json({ access_token: "tok-1", token_type: "Bearer", expires_in: 86_400 });
    calls.push(`${u.pathname}${u.search}`);
    if (u.pathname === "/api/v1/stocks") {
      if (state.failStocks) return json({ error: { code: "internal-error" } }, 500);
      const symbols = (u.searchParams.get("symbols") ?? "").split(",");
      // 모르는 종목은 응답에서 빠진다 (오류 아님 — 2026-11-12 실측)
      return json({ result: symbols.filter((s) => STOCKS[s]).map((s) => STOCKS[s]) });
    }
    if (u.pathname === "/api/v1/candles") {
      const all = state.minutes[u.searchParams.get("symbol") ?? ""] ?? [];
      const count = Number(u.searchParams.get("count") ?? 100);
      const before = u.searchParams.get("before");
      const upto = before ? all.filter((c) => Date.parse(c.timestamp) <= Date.parse(before)) : all;
      const page = upto.slice(-count).reverse();
      return json({ result: { candles: page, nextBefore: upto.length > count ? page.at(-1)!.timestamp : null } });
    }
    return json({ error: { code: "edge-blocked" } }, 404);
  }) as typeof fetch;
  const now = { at: new Date("2026-11-12T10:40:00+09:00") };
  // 줄 세우기(요청 한도)는 test/tossRateLimit.test.ts 가 본다 — 여기서는 끈다 (가짜 서버라 한꺼번에 수십 번 불러도 된다)
  const client = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => now.at, maxRetryWaitMs: 0, pace: false });
  const provider = new TossOpenApiProvider(client, { now: () => now.at });
  const stockCalls = () => calls.filter((c) => c.startsWith("/api/v1/stocks?")).map((c) => decodeURIComponent(c.split("symbols=")[1] ?? ""));
  const candleCalls = () => calls.filter((c) => c.startsWith("/api/v1/candles")).length;
  return { state, calls, now, client, provider, stockCalls, candleCalls };
}

describe("상품 정보: 공식 종목 정보 → ProductFacts (예전 토스 웹 v2/stock-infos)", () => {
  it("SOXL: ETF · 3배 · 아멕스 — 공식 API 에 없는 칸(단일 종목형·파생형·스팩·자세한 이름)은 모름(null)", () => {
    expect(officialProductFacts(STOCKS["SOXL"]!)).toEqual({
      name: "SOXL",
      englishName: "DIREXION SHARES ETF TRUST DAILY SEMICONDUCTOR BULL 3X SHS",
      detailName: null,
      group: "EF",
      exchange: "AMX",
      leverageFactor: 3,
      singleStockEtp: null,
      derivativeEtf: null,
      commonShare: true,
      spac: null,
      clearance: null,
    });
  });

  it("종목 유형·배수·우선주·정리매매", () => {
    const f = (code: string) => officialProductFacts(STOCKS[code]!);
    expect(f("SOXS")).toMatchObject({ group: "EF", leverageFactor: -3 });
    expect(f("QQQ")).toMatchObject({ group: "EF", exchange: "NSQ", leverageFactor: 1 });
    expect(f("AAPL")).toMatchObject({ group: "ST", exchange: "NSQ", leverageFactor: null, commonShare: true, clearance: null }); // 미국 주식도 STOCK, 배수 null
    expect(f("005930")).toMatchObject({ group: "ST", exchange: "KSP", leverageFactor: null, commonShare: true, clearance: false });
    expect(f("005935")).toMatchObject({ group: "ST", commonShare: false });
    expect(f("530031")).toMatchObject({ group: "EN", leverageFactor: 2 });
    expect(f("395400")).toMatchObject({ group: "RT" });
    expect(f("900001")).toMatchObject({ exchange: "KSQ", clearance: true });
    // 배수는 글자·수 모두 읽고, 칸이 없거나 이상하면 null
    expect(officialProductFacts({ securityType: "ETF", leverageFactor: 1.5 })).toMatchObject({ group: "EF", leverageFactor: 1.5 });
    expect(officialProductFacts({ securityType: "MYSTERY", leverageFactor: "x" })).toMatchObject({ name: null, group: null, exchange: null, leverageFactor: null, commonShare: null });
  });

  it("가리기(지표 점수·계좌 비중)가 공식 상품 정보로 예전과 같은 답을 낸다", () => {
    const kind = (code: string, name = STOCKS[code]!["name"] as string) => classifyProduct(code, name, officialProductFacts(STOCKS[code]!));
    expect(kind("SOXL")).toEqual({ kind: "leveraged", L: 3, underlying: "SOXX", tracks: "NYSE 반도체 지수", source: "table", etf: true });
    expect(kind("NVDL")).toMatchObject({ kind: "leveraged", L: 2, underlying: "NVDA", source: "table" });
    expect(kind("SOXS")).toEqual({ kind: "inverse", etf: true });
    expect(kind("QQQ")).toEqual({ kind: "normal", etf: true }); // 1배 ETF
    expect(kind("AAPL")).toEqual({ kind: "normal", etf: false });
    // 보통 주식 이름의 'Bear' 로 인버스라고 짐작하지 않는다 (공식 API 가 주권이라고 알려 줌)
    expect(kind("BBW")).toEqual({ kind: "normal", etf: false });
    expect(kind("122630")).toMatchObject({ kind: "leveraged", L: 2, underlying: "069500" });
    expect(kind("252670")).toEqual({ kind: "inverse", etf: true });
    expect(kind("530031")).toMatchObject({ kind: "leveraged", L: 2, etf: true });
    expect(levInvOf("SOXS", "SOXS", officialProductFacts(STOCKS["SOXS"]!))).toEqual({ kind: "inverse", L: 3, guessed: false });
    expect(levInvOf("SOXL", "SOXL", officialProductFacts(STOCKS["SOXL"]!))).toEqual({ kind: "leveraged", L: 3, guessed: false });
  });

  it("보유 종목 상품 정보를 한꺼번에 물으면 요청 하나로 묶는다 (종목 정보 그룹은 초당 5회) · 하루 캐시", async () => {
    const w = officialWorld();
    const codes = ["SOXL", "SOXS", "NVDL", "QQQ", "AAPL", "BBW", "005930", "005935", "122630", "252670", "530031", "395400"];
    const facts = await Promise.all(codes.map((c) => w.provider.productFacts(c)));
    expect(facts.map((f) => f?.group)).toEqual(["EF", "EF", "EF", "EF", "ST", "ST", "ST", "ST", "EF", "EF", "EN", "RT"]);
    expect(w.stockCalls()).toEqual([codes.join(",")]);
    // 다시 물으면 요청 없이
    expect((await w.provider.productFacts("soxl"))?.leverageFactor).toBe(3); // 코드는 정리해서 본다
    expect(await w.provider.listedShares("005930")).toBe(5_846_278_608);
    expect(w.stockCalls()).toHaveLength(1);
    // 하루가 지나면 새로
    w.now.at = new Date(w.now.at.getTime() + 24 * 3_600_000 + 1_000);
    await w.provider.productFacts("SOXL");
    expect(w.stockCalls()).toHaveLength(2);
  });

  it("공식 API 가 모르는 종목은 null — 1시간 동안 다시 묻지 않는다", async () => {
    const w = officialWorld();
    expect(await Promise.all([w.provider.productFacts("ZZZZ"), w.provider.productFacts("AAPL")])).toMatchObject([null, { group: "ST" }]);
    expect(w.stockCalls()).toEqual(["ZZZZ,AAPL"]);
    expect(await w.provider.productFacts("ZZZZ")).toBeNull();
    expect(await w.provider.listedShares("ZZZZ")).toBeNull();
    expect(w.stockCalls()).toHaveLength(1);
    w.now.at = new Date(w.now.at.getTime() + 3_600_000 + 1_000);
    await w.provider.productFacts("ZZZZ");
    expect(w.stockCalls()).toEqual(["ZZZZ,AAPL", "ZZZZ"]);
  });

  it("받지 못하면 null 이고(던지지 않음) 다음에 다시 묻는다", async () => {
    const w = officialWorld();
    w.state.failStocks = true;
    expect(await Promise.all([w.provider.productFacts("SOXL"), w.provider.listedShares("005930")])).toEqual([null, null]);
    w.state.failStocks = false;
    expect((await w.provider.productFacts("SOXL"))?.leverageFactor).toBe(3);
    expect(w.stockCalls()).toHaveLength(2);
  });
});

// ───────────────────────────── 2. 수급 탭 ─────────────────────────────

/** 공식 투자자별 매매동향 응답(result) — 문서 예시 모양, 숫자는 지어낸 값. 9/29 는 장중 잠정 기록 */
const vol = (net: number) => ({ buyVolume: String(Math.abs(net) + 1_000), sellVolume: "1000", netBuyVolume: String(net) });
const TREND = {
  nextUntil: "2026-09-22",
  records: [
    { date: "2026-09-29", updatedAt: "2026-09-29T10:05:00.000+09:00", individual: null, foreigner: vol(120_000), institution: { ...vol(-40_000), breakdown: null }, otherCorporation: null, foreignerHolding: null, cfd: null },
    { date: "2026-09-28", updatedAt: "2026-09-28T20:15:40.000+09:00", individual: vol(700_000), foreigner: vol(-500_000), institution: { ...vol(-300_000), breakdown: {} }, otherCorporation: vol(100_000), foreignerHolding: { holdingQuantity: "2688769052", limitQuantity: "5846278608", holdingRate: "0.4599" }, cfd: null },
    { date: "2026-09-23", updatedAt: "2026-09-24T06:50:04.000+09:00", individual: vol(-900_000), foreigner: vol(550_000), institution: { ...vol(180_000), breakdown: {} }, otherCorporation: vol(170_000), foreignerHolding: { holdingQuantity: "2700000000", limitQuantity: "5846278608", holdingRate: "0.4618" }, cfd: { buyBalanceQuantity: "1", buyBalanceRate: "0", sellBalanceQuantity: "0", sellBalanceRate: "0" } },
  ],
};
const CLOSES = new Map([
  ["2026-09-28", 270_000],
  ["2026-09-23", 286_500],
]);
const at = (iso: string) => () => new Date(iso);

describe("수급 탭: 공식 투자자별 매매동향 → 줄 (예전 토스 웹 trading-trend)", () => {
  it("칸 옮기기: 순매수(주 수) · 보유율 소수 비율 → % · 종가는 한국거래소 정규장 일봉에서 · 잠정 기록은 개인·기타법인·보유가 null", () => {
    const rows = parseOpenApiTrend(TREND, CLOSES);
    expect(rows[1]).toEqual({
      date: "2026-09-28",
      individual: 700_000,
      foreign: -500_000,
      institution: -300_000,
      otherCorp: 100_000,
      foreignRatio: 45.99, // 0.4599 × 100 = 45.989999… 가 아니다
      foreignHolding: 2_688_769_052,
      foreignLimit: 5_846_278_608,
      close: 270_000,
      inMarketTime: null, // 공식 API 에 없는 칸
      hasAll: true,
      updatedAt: "2026-09-28T20:15:40.000+09:00",
    });
    expect(rows[0]).toMatchObject({ date: "2026-09-29", individual: null, foreign: 120_000, institution: -40_000, otherCorp: null, foreignRatio: null, foreignHolding: null, foreignLimit: null, close: null, hasAll: false });
    expect(rows[2]).toMatchObject({ foreignRatio: 46.18, close: 286_500 });
    // 종가를 받지 못했으면 그 칸만 비운다
    expect(parseOpenApiTrend(TREND).map((r) => r.close)).toEqual([null, null, null]);
    expect(parseOpenApiTrend({ records: [] })).toEqual([]);
  });

  it("모양이 바뀌면 던진다 (부르는 쪽이 캐시·다음 출처로)", () => {
    const bad = (records: unknown) => () => parseOpenApiTrend({ records });
    expect(() => parseOpenApiTrend({ body: [] })).toThrow(/모양 바뀜/);
    expect(() => parseOpenApiTrend(null)).toThrow(ProviderError);
    expect(bad([{ ...TREND.records[1], date: "20260928" }])).toThrow(/모양 바뀜: date/);
    expect(bad([{ ...TREND.records[1], foreigner: null }])).toThrow(/foreigner 가 없습니다/);
    expect(bad([{ ...TREND.records[1], institution: { netBuyVolume: "많음" } }])).toThrow(/institution\.netBuyVolume/);
    expect(bad([{ ...TREND.records[1], individual: {} }])).toThrow(/individual\.netBuyVolume/);
    expect(bad([{ ...TREND.records[1], foreignerHolding: "없음" }])).toThrow(/foreignerHolding/);
  });

  it("출처: 요청 하나(70줄) + 정규장 종가 한 번 — 종가를 받지 못해도 수급은 준다", async () => {
    const calls: string[] = [];
    const get = async (path: string, params?: Record<string, unknown>) => {
      calls.push(`${path}?${JSON.stringify(params)}`);
      return TREND;
    };
    const closesCalls: string[] = [];
    const src = new TossOpenApiTrend({ get, listedShares: async () => 5_846_278_608, closes: async (code, days) => (closesCalls.push(`${code}:${days}`), CLOSES) });
    expect(src.name).toBe("toss-openapi");
    expect((await src.trend("005930", OPENAPI_TREND_SIZE))[1]!.close).toBe(270_000);
    expect(calls).toEqual(['/api/v1/stocks/005930/investor-trading?{"count":70}']);
    expect(closesCalls).toEqual(["005930:75"]);
    expect(await src.listedShares("005930")).toBe(5_846_278_608);
    const noClose = new TossOpenApiTrend({ get, closes: async () => Promise.reject(new Error("네이버 실패")), listedShares: async () => Promise.reject(new Error("x")) });
    expect((await noClose.trend("005930")).map((r) => r.close)).toEqual([null, null, null]);
    expect(await noClose.listedShares("005930")).toBeNull();
    expect(await new TossOpenApiTrend({ get }).listedShares("005930")).toBeNull();
    // 한 번에 100줄까지
    await src.trend("005930", 500);
    expect(calls.at(-1)).toContain('"count":100');
  });

  it("오늘 줄 확정: 20:30 뒤에 받았고 · 개인 값이 나왔고 · 18:00 뒤에 고친 줄만 (장중 여부 칸은 없어도 됨 — 토스 웹 줄은 예전 그대로 그 칸이 있어야 함)", () => {
    const row = (over: Partial<FlowTrendRow> = {}): FlowTrendRow => ({ date: "2026-09-29", individual: 1, foreign: 2, institution: -3, otherCorp: 0, foreignRatio: 50, foreignHolding: null, foreignLimit: null, close: 100, inMarketTime: null, hasAll: true, updatedAt: "2026-09-29T20:16:03.000+09:00", ...over });
    const evening = new Date("2026-09-29T20:40:00+09:00");
    expect(isFinalRow(row(), "toss-openapi", evening)).toBe(true);
    expect(isFinalRow(row(), "toss-openapi", new Date("2026-09-29T19:00:00+09:00"))).toBe(false); // 20:30 전
    expect(isFinalRow(row({ updatedAt: "2026-09-29T15:36:11.000+09:00" }), "toss-openapi", evening)).toBe(false); // 장 마감 직후 값
    expect(isFinalRow(row({ hasAll: false, individual: null }), "toss-openapi", evening)).toBe(false);
    expect(isFinalRow(row({ updatedAt: null }), "toss-openapi", evening)).toBe(false);
    expect(isFinalRow(row({ date: "2026-09-28", hasAll: false }), "toss-openapi", evening)).toBe(true); // 지난 날은 확정
    expect(isFinalRow(row(), "toss-web", evening)).toBe(false); // 토스 웹은 inMarketTime 이 false 여야
    expect(isFinalRow(row({ inMarketTime: false }), "toss-web", evening)).toBe(true);
  });

  it("응답: source 는 'toss-web' 그대로 + via 'openapi' (옛 앱이 네이버 자료로 그리지 않게) · 기준 KRX+NXT · 한도 계산 · 대조 줄 없음", () => {
    const rows = parseOpenApiTrend(TREND, CLOSES);
    const body = buildFlowBody({ code: "005930", source: "toss-openapi", rows, fetchedAt: new Date("2026-09-29T10:10:00+09:00"), stale: false, check: { at: "x", days: 20, same: 20 }, now: new Date("2026-09-29T10:10:00+09:00"), listedShares: 5_846_278_608 });
    expect(body).toMatchObject({ source: "toss-web", via: "openapi", basis: "KRX+NXT", asOf: "2026-09-28T20:15:40+09:00", stale: false, limit: null, check: null });
    expect(body.today).toEqual({ date: "2026-09-29", updatedAt: "2026-09-29T10:05:00+09:00", individual: null, foreign: 120_000, institution: -40_000 });
    expect(body.days[0]).toEqual({ date: "2026-09-28", individual: 700_000, foreign: -500_000, institution: -300_000, otherCorp: 100_000, foreignRatio: 45.99, close: 270_000 });
    expect(body.sums["5"]).toMatchObject({ individual: -200_000, otherCorp: 270_000, days: 2, missing: 0 });
    // 한도가 있는 종목 (한도 49% · 보유 48.89%): 상장 주식 수로 한도율
    const limited = [{ ...rows[1]!, foreignHolding: 123_222_416, foreignLimit: 123_490_626, foreignRatio: 48.89 }];
    expect(buildFlowBody({ code: "030200", source: "toss-openapi", rows: limited, fetchedAt: new Date("2026-09-29T10:10:00+09:00"), stale: false, check: null, now: new Date("2026-09-29T10:10:00+09:00"), listedShares: 252_021_685 }).limit).toEqual({ limitPct: 49, usedPct: 99.8 });
    // 토스 웹·네이버 응답에는 via 칸이 없다 (예전 응답 그대로)
    expect("via" in buildFlowBody({ code: "005930", source: "toss-web", rows, fetchedAt: new Date(), stale: false, check: null, now: new Date() })).toBe(false);
    expect("via" in buildFlowBody({ code: "005930", source: "naver", rows, fetchedAt: new Date(), stale: false, check: null, now: new Date() })).toBe(false);
  });
});

class FakeFlow implements FlowTrendSource {
  calls: string[] = [];
  fail = false;
  shares: number | null = null;
  constructor(
    readonly name: string,
    public rows: FlowTrendRow[],
  ) {}
  async listedShares(): Promise<number | null> {
    return this.shares;
  }
  async trend(code: string): Promise<FlowTrendRow[]> {
    this.calls.push(code);
    if (this.fail) throw new ProviderError(this.name, "HTTP 500");
    return this.rows;
  }
}

/** 토스 웹·네이버 줄 (출처마다 다른 값이라 어느 출처가 답했는지 숫자로도 보인다) */
const webRow: FlowTrendRow = { date: "2026-09-28", individual: 11, foreign: 22, institution: -33, otherCorp: 0, foreignRatio: 46.52, foreignHolding: null, foreignLimit: null, close: 270_000, inMarketTime: false, hasAll: true, updatedAt: "2026-09-28T20:15:40.000+09:00" };
const naverRow: FlowTrendRow = { ...webRow, individual: 1, foreign: 2, institution: -3, otherCorp: null, inMarketTime: null, hasAll: null, updatedAt: null };

async function flowService(o: { now?: { at: Date }; official?: FakeFlow | null; flagOff?: boolean } = {}) {
  const clock = o.now ?? { at: new Date("2026-09-29T10:10:00+09:00") };
  const db = await createMigratedDb(":memory:");
  const features = new FeatureService(db, () => clock.at);
  if (o.flagOff) await features.set({ flowOpenApi: false });
  const web = new FakeFlow("toss-web", [webRow]);
  const naver = new FakeFlow("naver", [naverRow]);
  const official = o.official === undefined ? new FakeFlow("toss-openapi", parseOpenApiTrend(TREND, CLOSES)) : o.official;
  const warns: string[] = [];
  const sources: InvestorFlowSources = { tossWeb: web, naver, openApi: null, official };
  const service = new InvestorFlowService({ features, sources, now: () => clock.at, log: { warn: (_o, msg) => void warns.push(msg) } });
  return { service, features, web, naver, official, warns, clock, db };
}

describe("수급 서비스: 플래그 flowOpenApi — 공식 API 를 맨 앞 출처로", () => {
  it("켜짐(기본): 공식 API 자료를 준다 — 토스 웹·네이버는 부르지 않는다", async () => {
    const x = await flowService();
    const r = await x.service.get("005930");
    expect(r).toMatchObject({ supported: true, source: "toss-web", via: "openapi", basis: "KRX+NXT", stale: false, check: null });
    expect(r.supported && r.days[0]).toMatchObject({ date: "2026-09-28", individual: 700_000, otherCorp: 100_000, close: 270_000 });
    expect([x.official!.calls, x.web.calls, x.naver.calls]).toEqual([["005930"], [], []]);
    // 유효 시간(장 시간 10분) 안에는 다시 부르지 않는다
    await x.service.get("005930");
    expect(x.official!.calls).toHaveLength(1);
    expect(x.warns).toEqual([]);
  });

  it("공식 API 가 실패하면: 24시간 안에 받아 둔 공식 자료(stale) → 없으면 토스 웹 → 네이버", async () => {
    const x = await flowService();
    await x.service.get("005930");
    x.official!.fail = true;
    x.clock.at = new Date(x.clock.at.getTime() + 11 * 60_000);
    expect(await x.service.get("005930")).toMatchObject({ source: "toss-web", via: "openapi", stale: true });
    expect(x.web.calls).toEqual([]);
    expect(x.warns).toEqual(["수급 토스 Open API 출처 실패"]);
    // 받아 둔 것이 없는 종목: 토스 웹으로 (다시 열렸을 때) — via 칸 없음
    const web = await x.service.get("000660");
    expect(web).toMatchObject({ source: "toss-web", stale: false });
    expect("via" in web).toBe(false);
    // 토스 웹도 막혀 있으면 네이버 (지금 운영 상태)
    x.web.fail = true;
    expect(await x.service.get("035420")).toMatchObject({ source: "naver", basis: "KRX" });
    // 24시간이 지난 공식 자료는 주지 않는다
    x.clock.at = new Date(x.clock.at.getTime() + 25 * 3_600_000);
    x.web.fail = false;
    expect("via" in (await x.service.get("005930"))).toBe(false);
  });

  it("모양이 바뀐 응답은 경고를 남기고 다음 출처로", async () => {
    const official = new FakeFlow("toss-openapi", []);
    official.trend = async () => parseOpenApiTrend({ body: [] });
    const x = await flowService({ official });
    expect(await x.service.get("005930")).toMatchObject({ source: "toss-web" });
    expect(x.warns).toEqual(["수급 출처 모양 바뀜"]);
  });

  it("끄면 지금과 똑같다: 공식 API 를 부르지 않고 응답도 공식 출처가 없을 때와 같다", async () => {
    const off = await flowService({ flagOff: true });
    const none = await flowService({ official: null });
    const a = await off.service.get("005930");
    expect(a).toEqual(await none.service.get("005930"));
    expect(a).toMatchObject({ source: "toss-web" });
    expect("via" in a).toBe(false);
    expect(off.official!.calls).toEqual([]);
    expect(off.web.calls).toEqual(["005930"]);
  });

  it("쓰다가 끄면 받아 둔 공식 자료도 그 순간부터 주지 않는다", async () => {
    const x = await flowService();
    expect(await x.service.get("005930")).toMatchObject({ via: "openapi" });
    await x.features.set({ flowOpenApi: false });
    const r = await x.service.get("005930"); // 유효 시간 안이지만 공식 캐시는 쓰지 않는다
    expect("via" in r).toBe(false);
    expect(r.supported && r.days[0]!.individual).toBe(11);
    // 두 출처가 모두 실패해도 공식 캐시(72시간 안)로 돌아가지 않는다
    x.web.fail = true;
    x.naver.fail = true;
    x.clock.at = new Date(x.clock.at.getTime() + 11 * 60_000);
    expect(await x.service.get("005930")).toMatchObject({ source: "toss-web", stale: true });
    expect("via" in (await x.service.get("005930"))).toBe(false);
  });

  it("상장 주식 수(공식 종목 정보)로 한도율을 낸다", async () => {
    const rows = parseOpenApiTrend(TREND, CLOSES).slice(1).map((r) => ({ ...r, foreignHolding: 123_222_416, foreignLimit: 123_490_626, foreignRatio: 48.89 }));
    const official = new FakeFlow("toss-openapi", rows);
    official.shares = 252_021_685;
    const x = await flowService({ official });
    expect(await x.service.get("030200")).toMatchObject({ via: "openapi", limit: { limitPct: 49, usedPct: 99.8 } });
  });

  it("관리 경로 대조: 화면 자료가 공식 API 면 견줄 것이 없다고 답한다", async () => {
    const x = await flowService();
    (x.service as unknown as { deps: { sources: InvestorFlowSources } }).deps.sources.openApi = { getInvestorFlow: async () => [] };
    expect(await x.service.adminCheck("005930")).toEqual({ enabled: true, code: "005930", available: false, reason: FLOW_TEXT.sameSource });
  });

  it("경로 GET /api/investor-flow/:code — 켜면 via 'openapi', 관리 API 로 끄면 예전 응답", async () => {
    const db = await createMigratedDb(":memory:");
    const web = new FakeFlow("toss-web", [webRow]);
    const official = new FakeFlow("toss-openapi", parseOpenApiTrend(TREND, CLOSES));
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ investorFlowSources: { tossWeb: web, naver: new FakeFlow("naver", [naverRow]), openApi: null, official } }),
      logger: false,
      enableScheduler: false,
      now: at("2026-09-29T10:10:00+09:00"),
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/investor-flow/005930" })).json()).toMatchObject({ source: "toss-web", via: "openapi", basis: "KRX+NXT" });
      expect((await app.inject({ method: "PUT", url: "/api/admin/features", payload: { flowOpenApi: false } })).statusCode).toBe(200);
      const off = (await app.inject({ method: "GET", url: "/api/investor-flow/005930" })).json() as Record<string, unknown>;
      expect(off).toMatchObject({ source: "toss-web", basis: "KRX+NXT" });
      expect("via" in off).toBe(false);
      expect(web.calls).toEqual(["005930"]);
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});

// ───────────────────────────── 3. 미국 테마 (공식 섹터) ─────────────────────────────

/** 공식 섹터 목록 (번호·이름·계층은 실제 값 — 토스 웹 테마 분류와 같은 번호) */
const SECTORS = [
  { sectorId: "87", name: "IT", depth: 0, parentSectorId: null },
  { sectorId: "169", name: "반도체", depth: 0, parentSectorId: null },
  { sectorId: "53", name: "자동차", depth: 0, parentSectorId: null },
  { sectorId: "89", name: "IT솔루션구축", depth: 1, parentSectorId: "87" },
  { sectorId: "389", name: "소프트웨어", depth: 1, parentSectorId: "87" },
  { sectorId: "956", name: "양자컴퓨터", depth: 1, parentSectorId: "87" },
  { sectorId: "179", name: "반도체팹리스", depth: 1, parentSectorId: "169" },
  { sectorId: "295", name: "전기차", depth: 1, parentSectorId: "53" },
  { sectorId: "955", name: "비트코인", depth: 2, parentSectorId: "389" },
];
/** 미국 구성 종목 (시가총액 큰 순 — 상위 섹터 목록은 하위 섹터의 종목을 포함한다). 전기차 295 는 미국 종목 없음 */
const MEMBERS: Record<string, string[]> = {
  "87": ["MSFT", "ORCL", "IBM", "ACN", "MSTR", "IONQ", "COIN", "RGTI", "MARA", "QBTS", "QUBT", "SPCQ"],
  "89": ["IBM", "ACN", "RGTI"],
  "389": ["MSFT", "ORCL", "MSTR", "IONQ", "COIN", "MARA"],
  "956": ["IONQ", "RGTI", "QBTS", "QUBT", "SPCQ"],
  "955": ["MSTR", "COIN", "MARA"],
  "169": ["NVDA", "AVGO", "AMD"],
  "179": ["NVDA", "AVGO", "AMD"],
  "53": [],
  "295": [],
};
const DETAIL_RATES = [
  { duration: "1d", changeRate: "-0.0191" },
  { duration: "1w", changeRate: "0.2344" },
  { duration: "1mo", changeRate: "-0.0422" },
  { duration: "3mo", changeRate: "-0.3352" },
  { duration: "6mo", changeRate: null },
  { duration: "1y", changeRate: "-0.5806" },
];
const SECTOR_STOCK_INFO: Record<string, { symbol: string; name: string; englishName?: string; market: string; status: string }> = {
  MSFT: { symbol: "MSFT", name: "마이크로소프트", market: "NASDAQ", status: "ACTIVE" },
  ORCL: { symbol: "ORCL", name: "오라클", market: "NYSE", status: "ACTIVE" },
  IBM: { symbol: "IBM", name: "IBM", market: "NYSE", status: "ACTIVE" },
  ACN: { symbol: "ACN", name: "액센츄어", market: "NYSE", status: "ACTIVE" },
  MSTR: { symbol: "MSTR", name: "스트래티지", market: "NASDAQ", status: "ACTIVE" },
  IONQ: { symbol: "IONQ", name: "아이온큐", market: "NYSE", status: "ACTIVE" },
  COIN: { symbol: "COIN", name: "코인베이스", market: "NASDAQ", status: "ACTIVE" },
  RGTI: { symbol: "RGTI", name: "리게티 컴퓨팅", market: "NASDAQ", status: "ACTIVE" },
  MARA: { symbol: "MARA", name: "마라 홀딩스", market: "NASDAQ", status: "ACTIVE" },
  QBTS: { symbol: "QBTS", name: "디웨이브 퀀텀", market: "NYSE", status: "ACTIVE" },
  QUBT: { symbol: "QUBT", name: "퀀텀 컴퓨팅", market: "NASDAQ", status: "DELISTED" },
  SPCQ: { symbol: "SPCQ", name: "퀀텀 스팩", englishName: "Quantum Acquisition Corp", market: "NASDAQ", status: "ACTIVE" },
  NVDA: { symbol: "NVDA", name: "엔비디아", market: "NASDAQ", status: "ACTIVE" },
  AVGO: { symbol: "AVGO", name: "브로드컴", market: "NASDAQ", status: "ACTIVE" },
  AMD: { symbol: "AMD", name: "AMD", market: "AMEX", status: "ACTIVE" },
};

function sectorWorld(now: { at: Date } = { at: new Date("2026-11-12T21:00:00+09:00") }) {
  const calls: string[] = [];
  const state = { failStocks: new Set<string>(), failDetail: false, failAll: false };
  const get = async (path: string, params: Record<string, string | number | boolean | undefined> = {}) => {
    calls.push(`${path}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}` : ""}`);
    if (state.failAll) throw new ProviderError("toss-openapi", `HTTP 500 internal-error (${path})`);
    if (path === "/api/v1/sectors") return { sectors: SECTORS };
    if (path === "/api/v1/sectors/rankings") {
      // 순위에는 대·중분류만 (소분류 955 는 없다)
      const rows = [
        { rank: 1, sectorId: "956", name: "양자컴퓨터", changeRate: params["duration"] === "1w" ? "0.2344" : "0.0179", tradingAmount: "1", marketCapitalization: "1", currency: "KRW" },
        { rank: 2, sectorId: "87", name: "IT", changeRate: "0.015", tradingAmount: "2", marketCapitalization: "2", currency: "KRW" },
        { rank: 3, sectorId: "179", name: "반도체팹리스", changeRate: "0", tradingAmount: null, marketCapitalization: null, currency: "KRW" },
      ];
      return { rankings: params["type"] === "MARKET_TRADING_AMOUNT" ? rows.slice(1) : rows };
    }
    const m = /^\/api\/v1\/sectors\/(\d+)(\/stocks)?$/.exec(path);
    if (m && m[2]) {
      if (state.failStocks.has(m[1]!)) throw new ProviderError("toss-openapi", `HTTP 500 internal-error (${path})`);
      const list = MEMBERS[m[1]!];
      if (!list) throw new ProviderError("toss-openapi", `HTTP 404 sector-not-found (${path})`);
      return { stocks: list.map((symbol, i) => ({ symbol, name: SECTOR_STOCK_INFO[symbol]?.name ?? symbol, volume: "1", tradingAmount: "1", marketCapitalization: String(1_000_000 - i), currency: "KRW" })) };
    }
    if (m) {
      if (state.failDetail) throw new ProviderError("toss-openapi", `HTTP 500 internal-error (${path})`);
      const s = SECTORS.find((x) => x.sectorId === m[1]);
      if (!s) throw new ProviderError("toss-openapi", `HTTP 404 sector-not-found (${path})`);
      return { ...s, summary: s.sectorId === "956" ? "양자컴퓨팅 하드웨어, 소프트웨어, 서비스를 개발하거나 제공하는 업체" : null, performance: { changeRates: DETAIL_RATES } };
    }
    throw new ProviderError("toss-openapi", `HTTP 404 edge-blocked (${path})`);
  };
  const infoCalls: string[][] = [];
  const stockInfos = async (symbols: string[]) => {
    infoCalls.push(symbols);
    return new Map(symbols.filter((s) => SECTOR_STOCK_INFO[s]).map((s) => [s, SECTOR_STOCK_INFO[s]!]));
  };
  const tics = new TossSectorTics({ get, stockInfos, now: () => now.at });
  const count = (re: RegExp) => calls.filter((c) => re.test(c)).length;
  return { tics, calls, infoCalls, state, now, count };
}

describe("미국 테마: 공식 섹터 API → 테마 분류 (예전 토스 웹 TICS)", () => {
  it("응답 읽기: 목록·구성 종목 — 모양이 바뀌면 던진다", () => {
    expect(parseSectors({ sectors: SECTORS })[3]).toEqual({ id: "89", name: "IT솔루션구축", depth: 1, parent: "87" });
    expect(parseSectors({ sectors: [{ sectorId: 956, name: " 양자컴퓨터 ", depth: "1", parentSectorId: 87 }, { name: "번호 없음", depth: 1 }, { sectorId: "1", name: "", depth: 0 }] })).toEqual([{ id: "956", name: "양자컴퓨터", depth: 1, parent: "87" }]);
    expect(() => parseSectors({ items: [] })).toThrow(/섹터 목록 응답 모양/);
    expect(parseSectorStocks({ stocks: [{ symbol: "ionq", name: "아이온큐" }, { symbol: "IONQ", name: "겹침" }, { name: "티커 없음" }, { symbol: "RGTI" }] })).toEqual([
      { symbol: "IONQ", name: "아이온큐" },
      { symbol: "RGTI", name: "RGTI" },
    ]);
    expect(() => parseSectorStocks(null)).toThrow(/구성 종목 응답 모양/);
  });

  it("순위: 기간·기준 이름을 공식 값으로 바꿔 부르고 등락률은 %로", async () => {
    const w = sectorWorld();
    expect(await w.tics.ranking("US", "1m")).toEqual([
      { id: "956", name: "양자컴퓨터", rate: 1.79, stockCount: null, leader: null },
      { id: "87", name: "IT", rate: 1.5, stockCount: null, leader: null },
      { id: "179", name: "반도체팹리스", rate: 0, stockCount: null, leader: null },
    ]);
    expect((await w.tics.ranking("US", "1w", "TRADING_AMOUNT")).map((r) => r.id)).toEqual(["87", "179"]);
    expect(w.calls).toEqual(["/api/v1/sectors/rankings?type=TOP_GAINERS&marketCountry=US&duration=1mo", "/api/v1/sectors/rankings?type=MARKET_TRADING_AMOUNT&marketCountry=US&duration=1w"]);
  });

  it("기간 등락률: 상세 한 번으로 여섯 기간 (10분 캐시) — 자료가 없는 기간은 null", async () => {
    const w = sectorWorld();
    expect(await Promise.all([w.tics.periodRate("956", "US", "1w"), w.tics.periodRate("956", "US", "1m"), w.tics.periodRate("956", "US", "1y")])).toEqual([23.44, -4.22, -58.06]);
    expect(await w.tics.periodRate("956", "US", "3m")).toBe(-33.52);
    expect(w.calls).toEqual(["/api/v1/sectors/956?marketCountry=US"]);
    w.now.at = new Date(w.now.at.getTime() + 10 * 60_000 + 1);
    await w.tics.periodRate("956", "US", "1w");
    expect(w.count(/^\/api\/v1\/sectors\/956\?/)).toBe(2);
    await expect(w.tics.periodRate("999", "US", "1w")).rejects.toThrow(/sector-not-found/);
  });

  it("개요: 그 섹터가 속한 대분류의 트리 전체 + 한 줄 요약 (목록은 하루 캐시, 요약을 못 받아도 트리는 준다)", async () => {
    const w = sectorWorld();
    const o = await w.tics.overview("956");
    expect(o).toMatchObject({ id: "956", name: "양자컴퓨터", summary: "양자컴퓨팅 하드웨어, 소프트웨어, 서비스를 개발하거나 제공하는 업체" });
    expect(o.nodes).toEqual([
      { id: "87", name: "IT", depth: 0, root: "IT" },
      { id: "89", name: "IT솔루션구축", depth: 1, root: "IT" },
      { id: "389", name: "소프트웨어", depth: 1, root: "IT" },
      { id: "955", name: "비트코인", depth: 2, root: "IT" },
      { id: "956", name: "양자컴퓨터", depth: 1, root: "IT" },
    ]);
    // 소분류에서 물어도 같은 대분류 트리
    expect((await w.tics.overview("955")).nodes.map((n) => n.id)).toEqual(["87", "89", "389", "955", "956"]);
    expect(w.count(/^\/api\/v1\/sectors$/)).toBe(1);
    w.state.failDetail = true;
    expect(await w.tics.overview("179")).toMatchObject({ name: "반도체팹리스", summary: null, nodes: [{ id: "169", name: "반도체", depth: 0, root: "반도체" }, { id: "179", name: "반도체팹리스", depth: 1, root: "반도체" }] });
    expect(await w.tics.overview("12345")).toMatchObject({ name: "", nodes: [] });
  });

  it("구성 종목: 한 번 받아 10개씩 나눠 준다 (티커가 바로 온다)", async () => {
    const w = sectorWorld();
    const p1 = await w.tics.stocksPage("87", "US", 1);
    expect(p1.total).toBe(12);
    expect(p1.stocks).toHaveLength(10);
    expect(p1.stocks[0]).toEqual({ productCode: "MSFT", name: "마이크로소프트", marketCapUsd: null });
    expect((await w.tics.stocksPage("87", "US", 2)).stocks.map((s) => s.productCode)).toEqual(["QUBT", "SPCQ"]);
    expect((await w.tics.stocksPage("87", "US", 3)).stocks).toEqual([]);
    expect(await w.tics.stocksPage("295", "US", 1)).toEqual({ total: 0, stocks: [] }); // 미국 종목이 없는 섹터
    expect(w.count(/\/sectors\/87\/stocks/)).toBe(1);
  });

  it("종목 정보: 거래소 코드 · 상장 중인 종목만 · 스팩은 이름으로", async () => {
    const w = sectorWorld();
    const m = await w.tics.stockInfos(["IONQ", "rgti", "AMD", "QUBT", "SPCQ", "NOPE", "IONQ"]);
    expect([...m.keys()]).toEqual(["IONQ", "RGTI", "AMD", "SPCQ"]); // 상장폐지(QUBT)·모르는 종목은 뺀다
    expect(m.get("IONQ")).toEqual({ productCode: "IONQ", symbol: "IONQ", market: "NYS", name: "아이온큐", spac: false });
    expect([m.get("RGTI")!.market, m.get("AMD")!.market]).toEqual(["NSQ", "AMX"]);
    expect(m.get("SPCQ")!.spac).toBe(true);
    expect(w.infoCalls).toEqual([["IONQ", "RGTI", "AMD", "QUBT", "SPCQ", "NOPE"]]);
  });

  /** 네이버 미국 시세 (정규장) — 테마북이 로이터 코드를 찾는 데 쓴다 */
  function naverFetch(codes: Record<string, string>) {
    return (async (url: string) => {
      const u = new URL(url);
      if (u.host !== "polling.finance.naver.com") return json({}, 404);
      const asked = decodeURIComponent(u.pathname.split("/").pop() ?? "").split(",");
      return json({
        pollingInterval: 70_000,
        datas: asked
          .filter((c) => codes[c])
          .map((c) => ({ reutersCode: c, symbolCode: codes[c], stockName: codes[c], stockNameEng: codes[c], stockExchangeType: { name: c.endsWith(".O") ? "NASDAQ" : "NYSE" }, closePriceRaw: "100", compareToPreviousClosePriceRaw: "1", fluctuationsRatioRaw: "1", accumulatedTradingVolumeRaw: "1000", accumulatedTradingValueRaw: "5000000", marketValueFullRaw: "1000", localTradedAt: "2026-11-11T16:00:00-05:00", tradeStopType: { name: "TRADING" } })),
      });
    }) as unknown as typeof fetch;
  }
  const NAVER_CODES = { "MSFT.O": "MSFT", ORCL: "ORCL", IBM: "IBM", ACN: "ACN", "MSTR.O": "MSTR", "IONQ.K": "IONQ", "COIN.O": "COIN", "RGTI.O": "RGTI", "MARA.O": "MARA", "QBTS.K": "QBTS", "NVDA.O": "NVDA", "AVGO.O": "AVGO", "AMD.K": "AMD" };

  it("미국 테마북을 공식 섹터로 만든다: 중·소분류 · 미국 3종목 이상 · 번호는 예전과 같음 · 스팩·상장폐지 제외", async () => {
    const w = sectorWorld();
    const saved = new Map<string, string>();
    const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: string) => void saved.set(k, v) };
    const book = new UsThemeBook({ tics: w.tics, naver: new NaverDiscover(naverFetch(NAVER_CODES)), store, now: () => w.now.at });
    const d = await book.get();
    expect(d.themes.map((t) => `${t.id}:${t.name}:d${t.depth}:${t.root}`)).toEqual(["89:IT솔루션구축:d1:IT", "389:소프트웨어:d1:IT", "955:비트코인:d2:IT", "956:양자컴퓨터:d1:IT", "179:반도체팹리스:d1:반도체"]);
    const quantum = d.themes.find((t) => t.id === "956")!;
    expect(quantum.total).toBe(5);
    // QUBT(상장폐지)·SPCQ(스팩)는 빠진다. productCode 칸에는 티커
    expect(quantum.members).toEqual([
      { productCode: "IONQ", symbol: "IONQ", reuters: "IONQ.K" },
      { productCode: "RGTI", symbol: "RGTI", reuters: "RGTI.O" },
      { productCode: "QBTS", symbol: "QBTS", reuters: "QBTS.K" },
    ]);
    expect(d.themes.find((t) => t.id === "179")!.members.map((m) => m.reuters)).toEqual(["NVDA.O", "AVGO.O", "AMD.K"]);
    expect(saved.get("discover:us-tics:v1")).toContain("IONQ.K");
    // 구성 종목은 중·소분류마다 한 번씩만 (대분류 87·169·53 은 받지 않는다), 섹터 목록은 한 번
    expect(w.calls.filter((c) => c.includes("/stocks")).map((c) => c.split("/")[4]).sort()).toEqual(["179", "389", "89", "955", "956"]);
    expect(w.count(/^\/api\/v1\/sectors$/)).toBe(1);
    expect(await book.summary("956")).toBe("양자컴퓨팅 하드웨어, 소프트웨어, 서비스를 개발하거나 제공하는 업체");
  });

  it("내 종목 테마: 종목이 든 가장 깊은 섹터만, 좁은 섹터부터 — 구성 종목을 거꾸로 찾는다 (하루 한 번)", async () => {
    const w = sectorWorld();
    // 리게티: 양자컴퓨터(5종목) · IT솔루션구축(3종목) — 대분류 IT 는 뺀다
    expect(await w.tics.majorFor("RGTI")).toEqual([
      { id: "89", title: "IT솔루션구축" },
      { id: "956", title: "양자컴퓨터" },
    ]);
    expect(await w.tics.majorFor("ionq")).toEqual([
      { id: "956", title: "양자컴퓨터" },
      { id: "389", title: "소프트웨어" },
    ]);
    // 소분류(비트코인)에 들었으면 그 위 중분류(소프트웨어)도 뺀다
    expect(await w.tics.majorFor("MSTR")).toEqual([{ id: "955", title: "비트코인" }]);
    expect(await w.tics.majorFor("NVDA")).toEqual([{ id: "179", title: "반도체팹리스" }]);
    // 어느 섹터에도 없는 종목(ETF 등)은 빈 배열 — '테마 없음'
    expect(await w.tics.majorFor("SOXL")).toEqual([]);
    // 중·소분류 6개의 구성 종목을 한 번씩만 받았다 (대분류는 받지 않는다)
    expect(w.count(/\/stocks\?/)).toBe(6);
    await w.tics.majorFor("AVGO");
    expect(w.count(/\/stocks\?/)).toBe(6);
    // 하루 뒤에는 새로 만든다
    w.now.at = new Date(w.now.at.getTime() + 24 * 3_600_000 + 1);
    await w.tics.majorFor("AVGO");
    expect(w.count(/\/stocks\?/)).toBe(12);
  });

  it("거꾸로 찾는 표: 테마북을 만들며 받은 구성 종목을 다시 받지 않는다 · 많이 실패하면 반쪽 표를 만들지 않는다", async () => {
    const w = sectorWorld();
    for (const id of ["89", "389", "955", "956", "179", "295"]) await w.tics.stocksPage(id, "US", 1);
    expect(w.count(/\/stocks\?/)).toBe(6);
    expect((await w.tics.majorFor("MSTR")).map((t) => t.id)).toEqual(["955"]);
    expect(w.count(/\/stocks\?/)).toBe(6);

    const bad = sectorWorld();
    bad.state.failStocks = new Set(["956"]); // 6개 가운데 1개 실패 = 17% > 10%
    await expect(bad.tics.majorFor("RGTI")).rejects.toThrow(/구성 종목 조회 실패가 많습니다 \(1\/6\)/);
    bad.state.failStocks.clear();
    expect((await bad.tics.majorFor("RGTI")).map((t) => t.id)).toEqual(["89", "956"]); // 다음에 다시 만든다
    // 한 번 만든 뒤에 새로 만들지 못하면 전에 만든 표를 쓴다
    bad.now.at = new Date(bad.now.at.getTime() + 24 * 3_600_000 + 1);
    bad.state.failAll = true;
    expect((await bad.tics.majorFor("RGTI")).map((t) => t.id)).toEqual(["89", "956"]);
  });

  it("플래그 themeOpenApi: 켜면 공식 섹터, 끄면 예전 출처(토스 웹) 그대로 — 부를 때마다 본다", async () => {
    const w = sectorWorld();
    const webCalls: string[] = [];
    const web: TicsSource = {
      ranking: async () => (webCalls.push("ranking"), []),
      periodRate: async () => (webCalls.push("periodRate"), 9.99),
      overview: async (id) => (webCalls.push("overview"), { id, name: "웹", summary: null, nodes: [] }),
      stocksPage: async () => (webCalls.push("stocksPage"), { total: 0, stocks: [] }),
      stockInfos: async () => (webCalls.push("stockInfos"), new Map()),
    };
    let on = true;
    const tics = switchTics(w.tics, web, async () => on);
    expect(await tics.periodRate("956", "US", "1w")).toBe(23.44);
    expect((await tics.ranking("US", "1d")).length).toBe(3);
    expect(webCalls).toEqual([]);
    on = false;
    const before = w.calls.length;
    expect(await tics.periodRate("956", "US", "1w")).toBe(9.99);
    await tics.ranking("US", "1d");
    await tics.overview("956");
    await tics.stocksPage("956", "US", 1);
    await tics.stockInfos(["IONQ"]);
    expect(webCalls).toEqual(["periodRate", "ranking", "overview", "stocksPage", "stockInfos"]);
    expect(w.calls.length).toBe(before); // 끄면 공식 섹터 호출 0
    await expect(switchTics(w.tics, null, async () => false).ranking("US", "1d")).rejects.toThrow(/꺼져 있습니다/);

    // 내 종목 테마의 미국 분류도 같은 플래그
    const webTics = async (code: string) => [{ id: "1", title: `웹 ${code}` }];
    const sources = withSectorTics({ usTics: webTics, usIndustry: null, krIndustry: null }, w.tics, async () => on);
    expect(await sources.usTics!("RGTI")).toEqual([{ id: "1", title: "웹 RGTI" }]);
    on = true;
    expect((await sources.usTics!("RGTI")).map((t) => t.id)).toEqual(["89", "956"]);
    // 공식 섹터가 없으면(키 없음) 묶음을 그대로 돌려준다
    const same = { usTics: webTics };
    expect(withSectorTics(same, null, async () => true)).toBe(same);
  });
});

// ───────────────────────────── 4. 30분봉 ─────────────────────────────

/** 한국 통합 세션(08:00~20:00)의 1분봉: 끝나는 시각 08:01 … 20:00 (하루 720개, 거래량은 모두 10). lastUntil 을 주면 마지막 날은 그 시각까지만 */
function krMinutes(dates: string[], lastUntil?: string): MinuteRow[] {
  const out: MinuteRow[] = [];
  for (const d of dates) {
    for (let m = 8 * 60 + 1; m <= 20 * 60; m++) {
      const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      if (d === dates.at(-1) && lastUntil && hm > lastUntil) break;
      out.push({ timestamp: `${d}T${hm}:00.000+09:00`, openPrice: String(1000 + (m % 30)), highPrice: String(1100 + (m % 30)), lowPrice: String(900 + (m % 30)), closePrice: String(1001 + (m % 30)), volume: "10", currency: "KRW" });
    }
  }
  return out;
}
const min = (time: string, o: Partial<Candle> = {}): Candle => ({ date: time.slice(0, 10), time, open: 100, high: 101, low: 99, close: 100, volume: 10, ...o });
/** 하루에 30분봉이 몇 개씩 있는지 (봉이 시작한 날짜 기준) */
const perDay = (bars: Candle[]) => {
  const m = new Map<string, number>();
  for (const b of bars) {
    const d = new Date(Date.parse(b.time!) - 30 * 60_000 + 9 * 3_600_000).toISOString().slice(0, 10);
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return Object.fromEntries(m);
};

describe("30분봉: 공식 1분봉을 묶어 만든다 (공식 API 에는 1분봉·일봉만 — 예전에는 토스 웹 차트)", () => {
  it("1분봉의 시각은 끝나는 시각 — [09:00, 09:30) 의 체결은 09:30 봉에, 30분봉의 시각도 끝나는 시각", () => {
    const minutes = [
      min("2026-11-12T09:00:00+09:00", { open: 90, high: 95, low: 85, close: 91, volume: 1 }), // 08:59~09:00 → 09:00 봉
      min("2026-11-12T09:01:00+09:00", { open: 100, high: 105, low: 99, close: 104, volume: 2 }), // 09:00~09:01 → 09:30 봉
      min("2026-11-12T09:17:00+09:00", { open: 104, high: 120, low: 80, close: 110, volume: 3 }),
      min("2026-11-12T09:30:00+09:00", { open: 110, high: 111, low: 109, close: 111, volume: 4 }), // 09:29~09:30 → 09:30 봉
      min("2026-11-12T09:31:00+09:00", { open: 111, high: 112, low: 110, close: 112, volume: 5 }), // → 10:00 봉
    ];
    expect(aggregateHalfHours(minutes, true)).toEqual([
      { date: "2026-11-12", time: "2026-11-12T09:00:00+09:00", open: 90, high: 95, low: 85, close: 91, volume: 1 },
      { date: "2026-11-12", time: "2026-11-12T09:30:00+09:00", open: 100, high: 120, low: 80, close: 111, volume: 9 },
      { date: "2026-11-12", time: "2026-11-12T10:00:00+09:00", open: 111, high: 112, low: 110, close: 112, volume: 5 },
    ]);
    // 미국: 뉴욕 시각으로 적는다 (겨울 -05:00)
    expect(aggregateHalfHours([min("2026-11-11T14:31:00.000Z"), min("2026-11-11T14:59:00.000Z"), min("2026-11-11T15:01:00.000Z")], false).map((b) => `${b.date} ${b.time} ${b.volume}`)).toEqual([
      "2026-11-11 2026-11-11T10:00:00-05:00 20",
      "2026-11-11 2026-11-11T10:30:00-05:00 10",
    ]);
    expect(aggregateHalfHours([{ date: "2026-11-12", open: 1, high: 1, low: 1, close: 1, volume: 1 }], true)).toEqual([]); // 시각이 없는 봉은 뺀다
  });

  const DAYS6 = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"];

  it("처음: 청한 개수만큼의 1분봉을 차례로 받고, 앞부분이 잘린 맨 앞 날은 뺀다", async () => {
    const w = officialWorld();
    w.state.minutes["005930"] = krMinutes(DAYS6);
    // 30분봉 60개 = 1분봉 1,800개 → 10쪽(200 + 199 × 9 = 1,991개): 11/10·11/9 이틀과 11/6 의 뒷부분
    const s = await w.provider.getCandles("005930", "30m", 60);
    expect(s).toMatchObject({ code: "005930", period: "30m", source: "toss-openapi" });
    expect(w.candleCalls()).toBe(10);
    expect(perDay(s.candles)).toEqual({ "2026-11-09": 24, "2026-11-10": 24 }); // 11/6 은 10:50 부터라 뺐다
    expect(s.candles[0]).toMatchObject({ date: "2026-11-09", time: "2026-11-09T08:30:00+09:00", volume: 300 });
    expect(s.candles.at(-1)).toMatchObject({ time: "2026-11-10T20:00:00+09:00", open: 1001, close: 1001, volume: 300 });
    // 개수를 줄여 청하면 뒤에서부터
    expect((await w.provider.getCandles("005930", "30m", 5)).candles.map((b) => b.time!.slice(11, 16))).toEqual(["18:00", "18:30", "19:00", "19:30", "20:00"]);
  });

  it("그 뒤: 마지막 두 구간부터만 다시 받아 이어 붙인다 (요청 하나) — 진행 중이던 봉이 채워지고 새 봉이 붙는다", async () => {
    const w = officialWorld();
    const days = [...DAYS6, "2026-11-11"];
    w.state.minutes["005930"] = krMinutes(days, "10:10");
    const first = await w.provider.getCandles("005930", "30m", 60);
    expect(first.candles.slice(-2).map((b) => `${b.time!.slice(11, 16)}:${b.volume}`)).toEqual(["10:00:300", "10:30:100"]); // 10:30 봉은 10분만 찼다
    const cold = w.candleCalls();
    w.state.minutes["005930"] = krMinutes(days, "10:42");
    const next = await w.provider.getCandles("005930", "30m", 60);
    expect(w.candleCalls()).toBe(cold + 1);
    expect(next.candles.slice(-3).map((b) => `${b.time!.slice(11, 16)}:${b.volume}`)).toEqual(["10:00:300", "10:30:300", "11:00:120"]);
    expect(next.candles.length).toBe(Math.min(60, first.candles.length + 1));
    // 앞쪽 봉은 그대로 (다시 받지 않은 구간)
    expect(next.candles.at(-4)).toEqual(first.candles.at(-3));
    // 같은 순간에 둘이 물어도 요청은 한 번
    await Promise.all([w.provider.getCandles("005930", "30m", 60), w.provider.getCandles("005930", "30m", 60)]);
    expect(w.candleCalls()).toBe(cold + 2);
  });

  it("더 긴 기간을 청하면 한 번 다시 받는다 — 기록의 처음까지 받았으면 맨 앞 날도 그대로", async () => {
    const w = officialWorld();
    w.state.minutes["005930"] = krMinutes(DAYS6);
    await w.provider.getCandles("005930", "30m", 60);
    const cold = w.candleCalls();
    const all = await w.provider.getCandles("005930", "30m", 450);
    // 1분봉 4,320개 = 200 + 199 × 21 … 22쪽에서 기록이 끝난다
    expect(w.candleCalls()).toBe(cold + 22);
    expect(perDay(all.candles)).toEqual(Object.fromEntries(DAYS6.map((d) => [d, 24])));
    // 다시 짧게 청해도 처음부터 받지 않는다
    await w.provider.getCandles("005930", "30m", 60);
    expect(w.candleCalls()).toBe(cold + 22 + 1);
  });

  it("오래 비어 있었으면(12쪽으로 닿지 못함) 사이가 빈 봉을 붙이지 않고 처음부터 다시 받는다", async () => {
    const w = officialWorld();
    w.state.minutes["005930"] = krMinutes(DAYS6.slice(0, 2));
    await w.provider.getCandles("005930", "30m", 450);
    const cold = w.candleCalls();
    w.state.minutes["005930"] = krMinutes(DAYS6); // 나흘(2,880분) 뒤
    const s = await w.provider.getCandles("005930", "30m", 450);
    expect(perDay(s.candles)).toEqual(Object.fromEntries(DAYS6.map((d) => [d, 24]))); // 빈 날 없이 이어진다
    expect(w.candleCalls()).toBe(cold + 12 + 22);
    // 봉 시각은 늘 오름차순 · 겹침 없음
    const times = s.candles.map((b) => Date.parse(b.time!));
    expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true);
  });

  it("봉이 없으면 던진다 (체인이 다음 출처로 — 지금은 다음 출처가 없어 차트가 '받지 못함')", async () => {
    const w = officialWorld();
    await expect(w.provider.getCandles("005930", "30m", 60)).rejects.toThrow(/분봉 데이터 없음/);
  });

  it("거래량 급증(3-29)이 이 30분봉으로 그대로 계산된다 — 봉 시각의 뜻(끝나는 시각)이 맞아 오늘과 지난 날이 같은 자리에서 견줘진다", async () => {
    const w = officialWorld();
    // 지난 8거래일 + 오늘(11/12 목) 10:40 까지. 1분마다 10주씩 고르게 거래
    const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
    w.state.minutes["005930"] = krMinutes(days, "10:40");
    const bars = (await w.provider.getCandles("005930", "30m", 450)).candles;
    expect(bars.length).toBe(8 * 24 + 6);
    // 정규장 09:00 개장 뒤 100분: 오늘 09:00~10:40 = 1,000주, 지난 날 같은 시각까지도 1,000주 → 1.00배
    expect(volumeStatus("005930", bars, new Date("2026-11-12T10:40:00+09:00"))).toMatchObject({ status: "ok", date: "2026-11-12", volume: 1_000, expected: 1_000, ratio: 1, days: 8, minutes: 100, reason: null });
  });
});
