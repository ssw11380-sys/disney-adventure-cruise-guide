import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import type { FlowTrendRow, FlowTrendSource, InvestorFlowDay } from "../src/providers/market/investorFlow.js";
import { NaverInvestorTrend, parseNaverTrend } from "../src/providers/market/naverInvestorTrend.js";
import { parseTossStockInfo, parseTossTradingTrend, TossTradingTrend } from "../src/providers/market/tossTradingTrend.js";
import { FEATURES, FeatureService } from "../src/services/featureService.js";
import { FLOW_JUDGE_RE, FLOW_TEXT, flowWordingProblems } from "../src/services/flowText.js";
import { buildFlowBody, compareFlows, flowCacheTtlMs, flowLimit, flowRatio, flowSums, isFinalRow, splitFlowRows } from "../src/services/investorFlowCalc.js";
import { InvestorFlowService, type InvestorFlowSources } from "../src/services/investorFlowService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 3-33 수급 탭 (플래그 flowTab). 종목 상세 '수급' 탭이 부르는 공용 경로 GET /api/investor-flow/:code 와 관리 경로 GET /api/admin/investor-flow/check.
 *  - 출처: 토스증권 웹 공개 자료(KRX+NXT 합산, 1순위) → 네이버 증권(KRX만, 폴백). 토스 Open API 는 대조(개수)만
 *  - 픽스처: 2026-09-29 02:40 KST 이 PC 에서 로그인 없이 받은 원자료(test/fixtures/investorFlow/ — 토스 웹 행은 쓰는 칸만 남김, 9/28(월) 장 마감 자료)
 *  - 시계는 모두 고정 (한국 시간)
 */
const FX = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/investorFlow/${name}`, import.meta.url), "utf8"));
const TOSS = {
  samsung: parseTossTradingTrend(FX("toss-samsung.json")),
  kt: parseTossTradingTrend(FX("toss-kt.json")),
  kodex: parseTossTradingTrend(FX("toss-kodex200.json")),
  kepco: parseTossTradingTrend(FX("toss-kepco.json")),
};
const NAVER = { samsung: parseNaverTrend(FX("naver-samsung.json")), kt: parseNaverTrend(FX("naver-kt.json")) };
/** 토스 웹 종목 정보 v2/stock-infos (상품 코드·상장 주식 수 — 2026-09-29 05:00 KST 실측, 쓰는 칸만). A520057 은 result null (ETN 은 Q) */
const INFO = FX("toss-info.json") as Record<string, unknown>;
/** 보유율이 1% 아래인 한도 종목 (9/28 줄) — YTN 040300 · 세종텔레콤 036630 · 트리니티항공 091810 */
const LOW = Object.fromEntries(Object.entries(FX("toss-low-ratio.json") as Record<string, unknown>).map(([k, v]) => [k, parseTossTradingTrend(v)[0]!]));
const shares = (pc: string) => parseTossStockInfo(INFO[pc])!.listedShares!;
/** 가짜 토스 웹 응답: 종목 정보는 INFO(없으면 result null), Q520057 수급은 ETN 픽스처, 그 밖 수급은 HTTP 400 */
const tossEtnFetch = (urls: string[] = []) =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u.replace("https://wts-info-api.tossinvest.com/api/", ""));
    if (u.includes("/v2/stock-infos/")) return new Response(JSON.stringify(INFO[u.split("/").at(-1)!] ?? { result: null }), { status: 200 });
    if (u.includes("productCode=Q520057")) return new Response(JSON.stringify(FX("toss-etn-q520057.json")), { status: 200 });
    return new Response(JSON.stringify({ error: { statusCode: 400, code: "bad-request" } }), { status: 400 });
  }) as unknown as typeof fetch;
const at = (iso: string) => () => new Date(iso);
/** 픽스처를 받은 때 (화 02:40 — 9/28 줄까지 모두 확정) */
const NIGHT = at("2026-09-29T02:40:00+09:00");

/** 확정 판정용 한 줄 */
function row(date: string, over: Partial<FlowTrendRow> = {}): FlowTrendRow {
  return { date, individual: 1, foreign: 2, institution: -3, otherCorp: 0, foreignRatio: 50, foreignHolding: null, foreignLimit: null, close: 100, inMarketTime: false, hasAll: true, updatedAt: `${date}T20:15:40.000+09:00`, ...over };
}

// ───────────────────────────── 1·2. 파서 ─────────────────────────────

describe("토스 웹 trading-trend 파서", () => {
  it("삼성전자 70행: 날짜·네 분류 순매수·외국인 보유·종가·장중·확정 칸 (9/28 장 마감 값)", () => {
    const r = TOSS.samsung;
    expect(r).toHaveLength(70);
    expect(r[0]).toEqual({
      date: "2026-09-28", individual: 7_422_778, foreign: -5_984_131, institution: -3_626_482, otherCorp: 2_149_361,
      foreignRatio: 46.52, foreignHolding: 2_719_756_970, foreignLimit: 5_846_278_608, close: 270_000,
      inMarketTime: false, hasAll: true, updatedAt: "2026-09-28T20:15:40.000+09:00",
    });
    expect(r.at(-1)!.date).toBe("2026-06-17");
    // 최신순, 추석(9/24~25)·주말은 줄이 없다
    expect(r.slice(0, 3).map((x) => x.date)).toEqual(["2026-09-28", "2026-09-23", "2026-09-22"]);
    // 네 분류를 더하면 0에 가깝다 (누군가 판 주식은 누군가 산 것)
    expect(Math.abs(r[0]!.individual! + r[0]!.foreign! + r[0]!.institution! + r[0]!.otherCorp!)).toBeLessThan(60_000);
  });

  it("원자료 전체 칸(기관 세부 7칸·잔고 칸)이 있어도 쓰는 칸만 같게 읽는다", () => {
    expect(parseTossTradingTrend(FX("toss-raw-2.json"))).toEqual(TOSS.samsung.slice(0, 2));
  });

  it("KT·KODEX 200·한국전력도 같은 모양", () => {
    expect(TOSS.kt[0]).toMatchObject({ date: "2026-09-28", foreignRatio: 49, foreignHolding: expect.any(Number), foreignLimit: expect.any(Number) });
    expect(TOSS.kodex).toHaveLength(21);
    expect(TOSS.kepco[0]).toMatchObject({ foreignRatio: 20.56, close: 30_600 });
  });

  it("has 셋 중 하나라도 거짓이면 hasAll 거짓, 칸이 없으면 모름(null)", () => {
    const one = (o: Record<string, unknown>) => parseTossTradingTrend({ result: { body: [{ baseDate: "2026-09-29", ...o }] } })[0]!;
    expect(one({ hasIndividual: false, hasInstitution: true, hasForeigner: true }).hasAll).toBe(false);
    expect(one({ hasIndividual: true, hasInstitution: true, hasForeigner: true }).hasAll).toBe(true);
    expect(one({}).hasAll).toBeNull();
    expect(one({ netIndividualsBuyVolume: null, inMarketTime: true })).toMatchObject({ individual: null, inMarketTime: true });
  });

  it("has 가 거짓인 분류는 값을 null 로 (아직 안 나온 값을 0 으로 채워 보내도 '0주'·합계에 들어가지 않게 — 기타법인은 개인과 같이)", () => {
    const one = (o: Record<string, unknown>) => parseTossTradingTrend({ result: { body: [{ baseDate: "2026-09-29", ...o }] } })[0]!;
    const zeros = { netIndividualsBuyVolume: 0, netForeignerBuyVolume: 120_000, netInstitutionBuyVolume: -40_000, netOtherCorporationBuyVolume: 0, inMarketTime: true };
    expect(one({ ...zeros, hasIndividual: false, hasInstitution: true, hasForeigner: true })).toMatchObject({ individual: null, otherCorp: null, foreign: 120_000, institution: -40_000, hasAll: false });
    // KRX 잠정치가 나오기 전(외국인·기관도 아직)이면 0 자리값이 모두 null
    expect(one({ ...zeros, netForeignerBuyVolume: 0, netInstitutionBuyVolume: 0, hasIndividual: false, hasInstitution: false, hasForeigner: false })).toMatchObject({ individual: null, foreign: null, institution: null, otherCorp: null });
    // has 가 참이거나 칸이 없으면(모름) 값 그대로 — 진짜 0 은 0
    expect(one({ ...zeros, hasIndividual: true, hasInstitution: true, hasForeigner: true })).toMatchObject({ individual: 0, otherCorp: 0 });
    expect(one(zeros)).toMatchObject({ individual: 0, foreign: 120_000 });
    // 값 모양 검사는 has 와 상관없이 (글자면 모양 바뀜)
    expect(() => one({ netIndividualsBuyVolume: "0", hasIndividual: false })).toThrow(ProviderError);
  });

  it("모양이 바뀌면 출처 실패 (result 없음 · body 가 배열 아님 · 날짜 모양 · 숫자 칸이 글자)", () => {
    for (const bad of [{}, { result: null }, { result: { body: "x" } }, { result: { body: [{ baseDate: "2026/09/28" }] } }, { result: { body: [{ baseDate: "2026-09-28", netIndividualsBuyVolume: "12" }] } }, { result: { body: [{ baseDate: "2026-09-28", foreignerRatio: Number.NaN }] } }, null, []]) {
      expect(() => parseTossTradingTrend(bad), JSON.stringify(bad)).toThrow(ProviderError);
    }
    expect(parseTossTradingTrend({ result: { body: [] } })).toEqual([]);
  });

  it("요청: 종목 정보(A)와 A{코드}·size 를 함께, 토스 웹과 같은 머리(UA·referer), 없는 코드(A·Q 모두 result null · HTTP 400)는 출처 실패", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
      if (u.includes("/v2/stock-infos/")) return new Response(JSON.stringify(INFO[u.split("/").at(-1)!] ?? { result: null }), { status: 200 });
      return u.includes("A999999") ? new Response(JSON.stringify({ error: { statusCode: 400 } }), { status: 400 }) : new Response(JSON.stringify(FX("toss-raw-2.json")), { status: 200 });
    });
    const src = new TossTradingTrend(fetchFn as unknown as typeof fetch, NIGHT);
    expect(await src.trend("005930", 70)).toEqual(TOSS.samsung.slice(0, 2));
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://wts-info-api.tossinvest.com/api/v1/stock-infos/trade/trend/trading-trend?productCode=A005930&size=70",
      "https://wts-info-api.tossinvest.com/api/v2/stock-infos/A005930",
    ]);
    for (const c of calls) {
      expect(c.headers.referer).toBe("https://tossinvest.com/");
      expect(c.headers["user-agent"]).toMatch(/Mozilla/);
    }
    // 상장 주식 수는 받아 둔 종목 정보에서 (호출 없음), 다음 수급은 상품 코드를 알아 수급 한 번
    expect(await src.listedShares("005930")).toBe(5_846_278_608);
    calls.length = 0;
    await src.trend("005930", 70);
    expect(calls.map((c) => c.url)).toEqual(["https://wts-info-api.tossinvest.com/api/v1/stock-infos/trade/trend/trading-trend?productCode=A005930&size=70"]);
    // 없는 코드: 종목 정보 A·Q 모두 없음 → 수급 A 400 → Q 는 부르지 않고 실패
    calls.length = 0;
    await expect(src.trend("999999", 70)).rejects.toThrow(ProviderError);
    expect(calls.map((c) => c.url.replace("https://wts-info-api.tossinvest.com/api/", "")).sort()).toEqual([
      "v1/stock-infos/trade/trend/trading-trend?productCode=A999999&size=70",
      "v2/stock-infos/A999999",
      "v2/stock-infos/Q999999",
    ]);
    expect(await src.listedShares("999999")).toBeNull();
  });

  it("ETN 은 'Q' 상품 코드 (520057 실측: A 는 HTTP 400) — 종목 정보가 Q 를 알려 주면 Q 로 한 번 더, 다음부터는 Q 로 바로", async () => {
    const urls: string[] = [];
    const src = new TossTradingTrend(tossEtnFetch(urls), NIGHT);
    const rows = await src.trend("520057", 70);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-28", "2026-09-23", "2026-09-22"]);
    expect(rows[0]).toMatchObject({ individual: 394_885, foreign: 54_565, institution: -428_461, otherCorp: -73_989, foreignRatio: 0.17, foreignHolding: 54_954, foreignLimit: 31_500_000 });
    expect(urls.sort()).toEqual([
      "v1/stock-infos/trade/trend/trading-trend?productCode=A520057&size=70",
      "v1/stock-infos/trade/trend/trading-trend?productCode=Q520057&size=70",
      "v2/stock-infos/A520057",
      "v2/stock-infos/Q520057",
    ]);
    expect(await src.listedShares("520057")).toBe(31_500_000);
    urls.length = 0;
    await src.trend("520057", 70);
    expect(urls).toEqual(["v1/stock-infos/trade/trend/trading-trend?productCode=Q520057&size=70"]);
  });

  it("종목 정보를 받지 못하면(HTTP 500): A 가 400 이면 Q 로 한 번 더 · 상장 주식 수는 모름(null) · 5분 동안 종목 정보를 다시 부르지 않는다", async () => {
    let t = Date.parse("2026-09-29T10:00:00+09:00");
    const urls: string[] = [];
    const fetchFn = async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u.replace("https://wts-info-api.tossinvest.com/api/", ""));
      if (u.includes("/v2/stock-infos/")) return new Response("{}", { status: 500 });
      if (u.includes("productCode=Q520057")) return new Response(JSON.stringify(FX("toss-etn-q520057.json")), { status: 200 });
      return new Response("{}", { status: 400 });
    };
    const src = new TossTradingTrend(fetchFn as unknown as typeof fetch, () => new Date(t));
    expect(await src.trend("520057", 70)).toHaveLength(3);
    expect(urls.filter((u) => u.startsWith("v1/")).sort()).toEqual([
      "v1/stock-infos/trade/trend/trading-trend?productCode=A520057&size=70",
      "v1/stock-infos/trade/trend/trading-trend?productCode=Q520057&size=70",
    ]);
    expect(await src.listedShares("520057")).toBeNull();
    urls.length = 0;
    t += 4 * 60_000;
    await src.trend("520057", 70);
    expect(urls.filter((u) => u.startsWith("v2/"))).toEqual([]);
    t += 2 * 60_000; // 5분이 지나면 다시 해 본다
    await src.trend("520057", 70);
    expect(urls.filter((u) => u.startsWith("v2/"))).toEqual(["v2/stock-infos/A520057"]);
  });

  it("종목 정보 파서: result null → 없음, 코드·상장 주식 수, 모양이 바뀌면 던진다", () => {
    expect(parseTossStockInfo(INFO["A520057"])).toBeNull();
    expect(parseTossStockInfo(INFO["Q520057"])).toEqual({ productCode: "Q520057", listedShares: 31_500_000 });
    expect(parseTossStockInfo(INFO["A040300"])).toEqual({ productCode: "A040300", listedShares: 47_676_980 });
    expect(parseTossStockInfo({ result: { code: "A005930", sharesOutstanding: 0 } })).toEqual({ productCode: "A005930", listedShares: null });
    for (const bad of [{}, null, [], { result: "x" }, { result: { code: 5930 } }, { result: { code: "005930" } }]) expect(() => parseTossStockInfo(bad), JSON.stringify(bad)).toThrow(ProviderError);
  });
});

describe("네이버 trend 파서", () => {
  it("삼성전자 60행: '+5,330,121' 글자를 수로, 보유율 '46.56%', 종가 '270,000', bizdate → YYYY-MM-DD, 기타법인·한도는 없음", () => {
    const r = NAVER.samsung;
    expect(r).toHaveLength(60);
    expect(r[0]).toEqual({
      date: "2026-09-28", individual: 5_330_121, foreign: -4_999_903, institution: -2_410_724, otherCorp: null,
      foreignRatio: 46.56, foreignHolding: null, foreignLimit: null, close: 270_000, inMarketTime: null, hasAll: null, updatedAt: null,
    });
  });

  it("'0' → 0, 빈 글자 → null, '-1,234' → −1234", () => {
    const [x] = parseNaverTrend([{ bizdate: "20260929", individualPureBuyQuant: "0", foreignerPureBuyQuant: "", organPureBuyQuant: "-1,234", foreignerHoldRatio: "", closePrice: "" }]);
    expect(x).toMatchObject({ date: "2026-09-29", individual: 0, foreign: null, institution: -1234, foreignRatio: null, close: null });
  });

  it("'-' 한 글자(값 없음 — 일부 ETN 보유율, 530036 실측)는 null, 출처 실패가 아니다", () => {
    const rows = parseNaverTrend([
      { bizdate: "20260928", individualPureBuyQuant: "+1,200", foreignerPureBuyQuant: "-", organPureBuyQuant: " - ", foreignerHoldRatio: "-", closePrice: "10,050" },
      { bizdate: "20260926", individualPureBuyQuant: "-300", foreignerPureBuyQuant: "+300", organPureBuyQuant: "0", foreignerHoldRatio: "-", closePrice: "10,000" },
    ]);
    expect(rows[0]).toMatchObject({ individual: 1200, foreign: null, institution: null, foreignRatio: null, close: 10_050 });
    expect(rows[1]).toMatchObject({ individual: -300, foreign: 300, institution: 0, foreignRatio: null });
    // '-' 뒤에 숫자가 없는 다른 모양('--'·'-%')은 그대로 모양 바뀜
    expect(() => parseNaverTrend([{ bizdate: "20260928", individualPureBuyQuant: "--" }])).toThrow(ProviderError);
    expect(() => parseNaverTrend([{ bizdate: "20260928", foreignerHoldRatio: "-%" }])).toThrow(ProviderError);
  });

  it("모양이 바뀌면 출처 실패, 빈 배열(없는 코드)은 자료 없음", () => {
    for (const bad of [{}, null, [{ bizdate: "2026-09-28" }], [{ bizdate: "20260928", individualPureBuyQuant: "abc" }], [{ bizdate: "20260928", foreignerHoldRatio: "많음" }]]) {
      expect(() => parseNaverTrend(bad), JSON.stringify(bad)).toThrow(ProviderError);
    }
    expect(parseNaverTrend([])).toEqual([]);
  });

  it("요청 주소: pageSize 60 (61부터 HTTP 400)", async () => {
    const urls: string[] = [];
    const src = new NaverInvestorTrend((async (url: string) => (urls.push(String(url)), new Response("[]", { status: 200 }))) as unknown as typeof fetch);
    expect(await src.trend("005930", 70)).toEqual([]);
    expect(urls).toEqual(["https://m.stock.naver.com/api/stock/005930/trend?pageSize=60"]);
  });

  it("첫 쪽이 60줄 꽉 차면 둘째 쪽(bizdate=가장 오래된 날)으로 70줄까지 — '60일 전' 보유율 줄(6/30 46.96%)이 생긴다, 둘째 쪽 실패는 첫 쪽만", async () => {
    const urls: string[] = [];
    let p2ok = true;
    const src = new NaverInvestorTrend((async (url: string) => {
      const u = String(url);
      urls.push(u.replace("https://m.stock.naver.com/api/stock/", ""));
      if (u.includes("bizdate=")) return p2ok ? new Response(JSON.stringify(FX("naver-samsung-p2.json")), { status: 200 }) : new Response("[]", { status: 500 });
      return new Response(JSON.stringify(FX("naver-samsung.json")), { status: 200 });
    }) as unknown as typeof fetch);
    const rows = await src.trend("005930", 70);
    expect(urls).toEqual(["005930/trend?pageSize=60", "005930/trend?pageSize=10&bizdate=20260701"]);
    expect(rows).toHaveLength(70);
    expect(rows[60]).toMatchObject({ date: "2026-06-30", foreignRatio: 46.96 });
    const body = buildFlowBody({ code: "005930", source: "naver", rows, fetchedAt: NIGHT(), stale: false, check: null, now: NIGHT() });
    expect(body.ratio?.ago["60"]).toEqual({ value: 46.96, date: "2026-06-30", change: -0.4 });
    expect(body.days).toHaveLength(60);
    p2ok = false;
    expect(await src.trend("005930", 70)).toHaveLength(60);
  });
});

// ───────────────────────────── 3. 확정 판정 ─────────────────────────────

describe("확정 판정 (한국 시간)", () => {
  const T = (iso: string) => new Date(iso);
  it("토스 웹: 오늘 줄은 장이 끝나고(inMarketTime 거짓) 세 값이 다 나오고 20:30 이 지나고 updatedAt 이 18:00 뒤일 때만 확정", () => {
    expect(isFinalRow(row("2026-09-29", { inMarketTime: true, individual: null, hasAll: false, updatedAt: "2026-09-29T10:00:00+09:00" }), "toss-web", T("2026-09-29T10:00:00+09:00"))).toBe(false);
    expect(isFinalRow(row("2026-09-29", { updatedAt: "2026-09-29T15:45:00+09:00" }), "toss-web", T("2026-09-29T16:00:00+09:00"))).toBe(false);
    expect(isFinalRow(row("2026-09-29"), "toss-web", T("2026-09-29T20:40:00+09:00"))).toBe(true);
    expect(isFinalRow(row("2026-09-29", { updatedAt: "2026-09-29T17:50:00+09:00" }), "toss-web", T("2026-09-29T20:40:00+09:00"))).toBe(false);
    expect(isFinalRow(row("2026-09-29", { hasAll: false }), "toss-web", T("2026-09-29T20:40:00+09:00"))).toBe(false);
    expect(isFinalRow(row("2026-09-29", { inMarketTime: true }), "toss-web", T("2026-09-29T20:40:00+09:00"))).toBe(false);
    expect(isFinalRow(row("2026-09-29", { updatedAt: null }), "toss-web", T("2026-09-29T20:40:00+09:00"))).toBe(false);
  });

  it("지난 날은 모두 확정, 앞날(시계 어긋남)은 잠정", () => {
    expect(isFinalRow(row("2026-09-29", { inMarketTime: true, hasAll: false }), "toss-web", T("2026-09-30T09:00:00+09:00"))).toBe(true);
    expect(isFinalRow(row("2026-09-28"), "naver", T("2026-09-29T00:10:00+09:00"))).toBe(true);
    expect(isFinalRow(row("2026-09-30"), "toss-web", T("2026-09-29T21:00:00+09:00"))).toBe(false);
  });

  it("네이버: 오늘 줄은 20:30 부터 확정 (20:00 잠정 · 20:31 확정)", () => {
    const n = row("2026-09-29", { inMarketTime: null, hasAll: null, updatedAt: null });
    expect(isFinalRow(n, "naver", T("2026-09-29T20:00:00+09:00"))).toBe(false);
    expect(isFinalRow(n, "naver", T("2026-09-29T20:31:00+09:00"))).toBe(true);
  });

  it("받은 때 기준: 장중(15:00)에 받은 줄을 다음 날 다시 쓰면 그 날 줄은 확정이 아니고, '오늘' 줄도 아니다", () => {
    const provisional = row("2026-09-29", { inMarketTime: true, individual: null, hasAll: false, foreign: 50_000, institution: 7, updatedAt: "2026-09-29T15:00:00+09:00" });
    const rows = [provisional, row("2026-09-28"), row("2026-09-26")];
    const fetched = T("2026-09-29T15:00:00+09:00");
    // 받은 그날: 잠정 → today
    expect(splitFlowRows(rows, "toss-web", fetched, T("2026-09-29T15:05:00+09:00")).today?.date).toBe("2026-09-29");
    // 다음 날 10:00 에 같은 줄을 다시 쓰면: 9/29 는 확정 줄에도 today 에도 없다
    const next = splitFlowRows(rows, "toss-web", fetched, T("2026-09-30T10:00:00+09:00"));
    expect(next.final.map((r) => r.date)).toEqual(["2026-09-28", "2026-09-26"]);
    expect(next.today).toBeNull();
    // 네이버도 같다: 20:30 전에 받은 그날 줄은 다음 날에도 잠정 · 20:30 뒤에 받은 줄은 확정
    const n = row("2026-09-29", { inMarketTime: null, hasAll: null, updatedAt: null });
    expect(splitFlowRows([n], "naver", T("2026-09-29T20:00:00+09:00"), T("2026-09-30T09:00:00+09:00")).final).toEqual([]);
    expect(splitFlowRows([n], "naver", T("2026-09-29T20:31:00+09:00"), T("2026-09-30T09:00:00+09:00")).final).toHaveLength(1);
    // 받은 때가 20:30 전이면 지금이 20:40 이어도 잠정 (그 자료를 다시 받아야 확정)
    expect(splitFlowRows([row("2026-09-29")], "toss-web", T("2026-09-29T20:25:00+09:00"), T("2026-09-29T20:40:00+09:00")).final).toEqual([]);
  });

  it("나누기: 잠정 줄은 today 하나로, 확정 줄은 최신순 (같은 날짜가 두 번 오면 앞의 것)", () => {
    const rows = [row("2026-09-29", { inMarketTime: true, individual: null, foreign: 120_000, institution: -40_000, updatedAt: "2026-09-29T10:00:00+09:00" }), row("2026-09-26"), row("2026-09-28"), row("2026-09-28", { individual: 999 })];
    const s = splitFlowRows(rows, "toss-web", T("2026-09-29T10:00:00+09:00"));
    expect(s.today).toMatchObject({ date: "2026-09-29", individual: null, foreign: 120_000 });
    expect(s.final.map((r) => [r.date, r.individual])).toEqual([["2026-09-28", 1], ["2026-09-26", 1]]);
  });
});

// ───────────────────────────── 4~6. 합계·보유율·한도 ─────────────────────────────

describe("합계 (확정 줄 앞에서 5·20·60개)", () => {
  it("삼성전자: 설계서 2.2 표 값 그대로 (토스 웹)", () => {
    const s = flowSums(TOSS.samsung, "toss-web");
    expect(s["5"]).toEqual({ individual: -20_119_397, foreign: 4_179_201, institution: 6_373_968, otherCorp: 9_663_459, days: 5, missing: 0 });
    expect(s["20"]).toEqual({ individual: -33_476_518, foreign: -13_640_206, institution: 8_385_452, otherCorp: 38_799_061, days: 20, missing: 0 });
    expect(s["60"]).toEqual({ individual: -13_407_335, foreign: -29_995_621, institution: -4_413_293, otherCorp: 47_851_029, days: 60, missing: 0 });
  });

  it("KT 20일 개인: 토스 −13,469 · 네이버 +82,571 (기준이 달라 부호까지 반대 — 한 응답에 섞지 않는 까닭)", () => {
    expect(flowSums(TOSS.kt, "toss-web")["20"].individual).toBe(-13_469);
    expect(flowSums(NAVER.kt, "naver")["20"].individual).toBe(82_571);
  });

  it("빈 값은 빼고 더하고 그 날 수를 missing 에, 줄이 모자라면 days = 실제 개수, 네이버 기타법인은 null", () => {
    const rows = TOSS.samsung.map((r, i) => (i === 1 ? { ...r, institution: null } : r));
    const s = flowSums(rows, "toss-web");
    expect(s["5"]).toMatchObject({ institution: 6_373_968 - TOSS.samsung[1]!.institution!, missing: 1, days: 5 });
    const short = flowSums(TOSS.samsung.slice(0, 43), "toss-web");
    expect(short["60"].days).toBe(43);
    expect(short["20"].days).toBe(20);
    const nav = flowSums(NAVER.samsung, "naver");
    expect(nav["20"]).toMatchObject({ individual: -32_247_701, foreign: -15_639_586, institution: 8_950_718, otherCorp: null, missing: 0 });
    // 모두 null 인 칸은 null (0 으로 지어내지 않는다)
    expect(flowSums([row("2026-09-28", { individual: null })], "toss-web")["5"]).toMatchObject({ individual: null, days: 1, missing: 1 });
    expect(flowSums([], "toss-web")["20"]).toEqual({ individual: null, foreign: null, institution: null, otherCorp: null, days: 0, missing: 0 });
  });
});

describe("외국인 보유율", () => {
  it("지금 46.52 · 5·20·60일 전(합계 창 바로 앞날) 46.48·46.75·46.96 · 변화 +0.04·−0.23·−0.44 · 선 61점(오래된 순) · 가장 높음 46.96 · 낮음 46.46", () => {
    const r = flowRatio(TOSS.samsung)!;
    expect(r.now).toBe(46.52);
    expect(r.date).toBe("2026-09-28");
    expect(r.ago).toEqual({
      "5": { value: 46.48, date: "2026-09-17", change: 0.04 },
      "20": { value: 46.75, date: "2026-08-27", change: -0.23 },
      "60": { value: 46.96, date: "2026-06-30", change: -0.44 },
    });
    expect(r.series).toHaveLength(61);
    expect(r.series[0]).toEqual(["2026-06-30", 46.96]);
    expect(r.series[60]).toEqual(["2026-09-28", 46.52]);
    expect([r.high, r.low]).toEqual([46.96, 46.46]);
  });

  it("줄이 모자라면 그 기간 null, 지금 값이 없으면 전체 null", () => {
    const r = flowRatio(TOSS.samsung.slice(0, 43))!;
    expect(r.ago["60"]).toBeNull();
    expect(r.ago["20"]).not.toBeNull();
    expect(r.series).toHaveLength(43);
    expect(flowRatio([row("2026-09-28", { foreignRatio: null })])).toBeNull();
    expect(flowRatio([])).toBeNull();
  });
});

describe("외국인 한도 (토스 웹만, 한도가 상장 주식 수의 99.5% 미만일 때)", () => {
  it("상장 주식 수(토스 웹 종목 정보)로: KT 49.0% · 100.0%, 한국전력 40.0% · 51.4%, 삼성전자·ETN(한도 = 상장 주식 수) 없음", () => {
    expect(flowLimit(TOSS.kt[0]!, shares("A030200"))).toEqual({ limitPct: 49, usedPct: 100 });
    expect(flowLimit(TOSS.kepco[0]!, shares("A015760"))).toEqual({ limitPct: 40, usedPct: 51.4 });
    expect(flowLimit(TOSS.samsung[0]!, shares("A005930"))).toBeNull();
    const etn = parseTossTradingTrend(FX("toss-etn-q520057.json"));
    expect(flowLimit(etn[0]!, shares("Q520057"))).toBeNull();
    // 보유 0 인 날(9/22)도 한도 판정은 상장 주식 수로 (한도 없음)
    expect(flowLimit(etn[2]!, shares("Q520057"))).toBeNull();
  });

  it("회귀: 보유율이 낮은 한도 종목의 한도율 — 보유율(소수 둘째 자리)로 셈하면 틀린다 (YTN 9.8 · 세종텔레콤 48.6 · 트리니티항공 50.1), 상장 주식 수로 10.00 · 49.00 · 49.99", () => {
    // 상장 주식 수를 알면 정확히 (한도율 소수 둘째 자리 — 트리니티항공 49.99%)
    expect(flowLimit(LOW["A040300"]!, shares("A040300"))).toEqual({ limitPct: 10, usedPct: 1.6 });
    expect(flowLimit(LOW["A036630"]!, shares("A036630"))).toEqual({ limitPct: 49, usedPct: 0.7 });
    expect(flowLimit(LOW["A091810"]!, shares("A091810"))).toEqual({ limitPct: 49.99, usedPct: 0.9 });
    // 모르면(종목 정보를 받지 못함) 어림 오차가 커서(보유율 0.16% ± 0.01%p → 한도율 ± 0.6%p) 한도 줄을 뺀다 — 틀린 값을 사실처럼 보이지 않게
    expect(flowLimit(LOW["A040300"]!)).toBeNull();
    expect(flowLimit(LOW["A036630"]!)).toBeNull();
    expect(flowLimit(LOW["A091810"]!)).toBeNull();
  });

  it("상장 주식 수를 모를 때: 보유율로 어림 — 오차가 0.05%p 안이면 소수 한 자리(KT 49.0 · 한국전력 40.0), 한도 없는 종목은 없음, 네이버 없음", () => {
    expect(flowLimit(TOSS.kt[0]!)).toEqual({ limitPct: 49, usedPct: 100 });
    expect(flowLimit(TOSS.kepco[0]!)).toEqual({ limitPct: 40, usedPct: 51.4 });
    expect(flowLimit(TOSS.samsung[0]!)).toBeNull();
    expect(flowLimit(TOSS.kodex[0]!)).toBeNull();
    expect(flowLimit(NAVER.kt[0]!)).toBeNull();
    expect(flowLimit(row("2026-09-28", { foreignRatio: 0, foreignHolding: 0, foreignLimit: 10 }))).toBeNull();
  });

  it("보유율이 1% 아래인 한도 없는 종목: 보유율 끝자리 반올림 때문에 없는 한도를 보이지 않는다 (0.56% · 0.07% 실측 모양)", () => {
    // 한도 = 상장 주식 수(한도 없음)인데 보유율이 소수 둘째 자리로 줄어 있어 예전 계산은 한도율 99.2% 를 냈다
    expect(flowLimit(row("2026-09-28", { foreignRatio: 0.56, foreignHolding: 122_468, foreignLimit: 21_704_774 }))).toBeNull();
    // 379800 모양: 보유율 0.07%, 보유 ÷ 한도 = 0.0705% (예전 계산 99.3%)
    expect(flowLimit(row("2026-09-28", { foreignRatio: 0.07, foreignHolding: 70_500, foreignLimit: 100_000_000 }))).toBeNull();
    expect(flowLimit(row("2026-09-28", { foreignRatio: 0.06, foreignHolding: 649, foreignLimit: 1_000_000 }))).toBeNull();
    // 상장 주식 수를 알면 한도 = 상장 주식 수 → 없음
    expect(flowLimit(row("2026-09-28", { foreignRatio: 0.07, foreignHolding: 70_500, foreignLimit: 100_000_000 }), 100_000_000)).toBeNull();
  });

  it("실제 한도(30~50%): 상장 주식 수를 알면 보유율이 낮아도 정확히, 모르면 어림 오차가 작을 때(보유가 한도의 약 20% 이상)만", () => {
    const listed = 100_000_000;
    const limitRow = (limitPct: number, ratio: number) => row("2026-09-28", { foreignRatio: ratio, foreignHolding: Math.round((listed * ratio) / 100), foreignLimit: Math.round((listed * limitPct) / 100) });
    expect(flowLimit(limitRow(50, 20.34), listed)).toEqual({ limitPct: 50, usedPct: 40.7 });
    expect(flowLimit(limitRow(49, 49), listed)).toEqual({ limitPct: 49, usedPct: 100 });
    expect(flowLimit(limitRow(40, 20.56), listed)).toEqual({ limitPct: 40, usedPct: 51.4 });
    expect(flowLimit(limitRow(30, 0.5), listed)).toEqual({ limitPct: 30, usedPct: 1.7 });
    expect(flowLimit(limitRow(49, 0.05), listed)).toEqual({ limitPct: 49, usedPct: 0.1 });
    expect(flowLimit(limitRow(50, 20.34))).toEqual({ limitPct: 50, usedPct: 40.7 });
    expect(flowLimit(limitRow(49, 49))).toEqual({ limitPct: 49, usedPct: 100 });
    expect(flowLimit(limitRow(40, 20.56))).toEqual({ limitPct: 40, usedPct: 51.4 });
    expect(flowLimit(limitRow(30, 0.5))).toBeNull();
    expect(flowLimit(limitRow(49, 0.05))).toBeNull();
  });
});

// ───────────────────────────── 대조 (순수) ─────────────────────────────

/** 토스 Open API investor-trading 이 줄 모양 (같은 원천이면 세 값이 같다) */
const apiDays = (rows: FlowTrendRow[], n = 22): InvestorFlowDay[] => rows.slice(0, n).map((r) => ({ date: r.date, close: r.close, individual: r.individual, foreign: r.foreign, institution: r.institution }));

describe("토스 Open API 원자료와 대조 (최근 20일, 세 값이 모두 같아야 같은 날)", () => {
  it("모두 같으면 20/20, 한 날 기관만 다르면 19/20 (다른 날짜·칸 이름을 준다)", () => {
    expect(compareFlows(TOSS.samsung, apiDays(TOSS.samsung))).toMatchObject({ days: 20, same: 20, diffs: [] });
    const api = apiDays(TOSS.samsung).map((d, i) => (i === 3 ? { ...d, institution: (d.institution ?? 0) + 1 } : d));
    const c = compareFlows(TOSS.samsung, api);
    expect(c).toMatchObject({ days: 20, same: 19 });
    expect(c.diffs).toEqual([{ date: TOSS.samsung[3]!.date, fields: ["institution"] }]);
  });

  it("두 쪽에 다 있는 날만 센다 (Open API 가 15일만 주면 15일)", () => {
    expect(compareFlows(TOSS.samsung, apiDays(TOSS.samsung, 15))).toMatchObject({ days: 15, same: 15 });
    expect(compareFlows([], apiDays(TOSS.samsung))).toMatchObject({ days: 0, same: 0 });
  });
});

describe("캐시 유효 시간", () => {
  it("평일 08:00~21:00 은 10분, 그 밖(밤·주말)은 60분", () => {
    expect(flowCacheTtlMs(new Date("2026-09-29T10:00:00+09:00"))).toBe(10 * 60_000);
    expect(flowCacheTtlMs(new Date("2026-09-29T07:59:00+09:00"))).toBe(60 * 60_000);
    expect(flowCacheTtlMs(new Date("2026-09-29T21:00:00+09:00"))).toBe(60 * 60_000);
    expect(flowCacheTtlMs(new Date("2026-10-03T10:00:00+09:00"))).toBe(60 * 60_000); // 토요일
  });
});

// ───────────────────────────── 7~11. 서비스 (출처·캐시·폴백·대조) ─────────────────────────────

/** 부른 횟수를 세는 가짜 출처 */
class FakeSource implements FlowTrendSource {
  calls: string[] = [];
  fail = false;
  wait: Promise<void> | null = null;
  /** 상장 주식 수 (토스 웹 종목 정보 흉내 — 기본 모름) */
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
    if (this.wait) await this.wait;
    if (this.fail) throw new ProviderError(this.name, "HTTP 500");
    return this.rows;
  }
}

class FakeOpenApi {
  calls: string[] = [];
  constructor(
    public days: InvestorFlowDay[],
    public hang = false,
  ) {}
  async getInvestorFlow(code: string, n: number): Promise<InvestorFlowDay[]> {
    this.calls.push(`${code}:${n}`);
    if (this.hang) return new Promise(() => undefined);
    return this.days;
  }
}

async function makeService(o: { now: () => Date; toss?: FakeSource; tossSource?: FlowTrendSource; naver?: FakeSource; openApi?: FakeOpenApi | null; flag?: boolean }) {
  const db = await createMigratedDb(":memory:");
  const features = new FeatureService(db, o.now);
  if (o.flag === false) await features.set({ flowTab: false });
  const toss = o.toss ?? new FakeSource("toss-web", TOSS.samsung);
  const naver = o.naver ?? new FakeSource("naver", NAVER.samsung);
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = { info: () => undefined, warn: (obj: Record<string, unknown>, msg: string) => void warns.push({ obj, msg }) };
  const sources: InvestorFlowSources = { tossWeb: o.tossSource ?? toss, naver, openApi: o.openApi ?? null };
  const service = new InvestorFlowService({ features, sources, now: o.now, log });
  return { service, toss, naver, warns, db };
}

describe("수급 서비스: 응답 모양", () => {
  it("삼성전자 (토스 웹): 출처·기준·확정 줄 60개·합계·보유율·한도 없음·대조 없음", async () => {
    const { service } = await makeService({ now: NIGHT });
    const r = await service.get("005930");
    if (!r.supported) throw new Error("한국 종목");
    expect(r).toMatchObject({ code: "005930", supported: true, source: "toss-web", basis: "KRX+NXT", asOf: "2026-09-28T20:15:40+09:00", fetchedAt: "2026-09-29T02:40:00+09:00", stale: false, today: null, limit: null, check: null });
    expect(r.days).toHaveLength(60);
    expect(r.days[0]).toEqual({ date: "2026-09-28", individual: 7_422_778, foreign: -5_984_131, institution: -3_626_482, otherCorp: 2_149_361, foreignRatio: 46.52, close: 270_000 });
    expect(r.sums["20"]).toMatchObject({ individual: -33_476_518, days: 20 });
    expect(r.ratio?.ago["60"]).toEqual({ value: 46.96, date: "2026-06-30", change: -0.44 });
  });

  it("장중: 오늘 줄은 today(잠정)로만, 합계·막대에 넣지 않는다", async () => {
    const provisional = { ...row("2026-09-29"), individual: null, otherCorp: null, foreign: 120_000, institution: -40_000, inMarketTime: true, hasAll: false, updatedAt: "2026-09-29T10:05:00.000+09:00" };
    const toss = new FakeSource("toss-web", [provisional, ...TOSS.samsung]);
    const { service } = await makeService({ now: at("2026-09-29T10:10:00+09:00"), toss });
    const r = await service.get("005930");
    if (!r.supported) throw new Error("한국 종목");
    expect(r.today).toEqual({ date: "2026-09-29", updatedAt: "2026-09-29T10:05:00+09:00", individual: null, foreign: 120_000, institution: -40_000 });
    expect(r.days[0]!.date).toBe("2026-09-28");
    expect(r.sums["5"].individual).toBe(-20_119_397);
  });

  it("KT: 한도 49.0% · 100.0%", async () => {
    const { service } = await makeService({ now: NIGHT, toss: new FakeSource("toss-web", TOSS.kt) });
    const r = await service.get("030200");
    expect(r.supported && r.limit).toEqual({ limitPct: 49, usedPct: 100 });
  });

  it("회귀: YTN 한도율은 토스 웹 종목 정보의 상장 주식 수로 10.00% (보유율로 셈하면 9.8%) — 종목 정보를 모르면 한도 줄 없음", async () => {
    const toss = new FakeSource("toss-web", [LOW["A040300"]!]);
    toss.shares = shares("A040300");
    const { service } = await makeService({ now: NIGHT, toss });
    expect(await service.get("040300")).toMatchObject({ source: "toss-web", limit: { limitPct: 10, usedPct: 1.6 } });
    const x = await makeService({ now: NIGHT, toss: new FakeSource("toss-web", [LOW["A040300"]!]) });
    expect(await x.service.get("040300")).toMatchObject({ source: "toss-web", limit: null });
  });

  it("ETN 520057 (실제 출처 코드 + 가짜 fetch): 토스 웹 Q 상품 코드로 받아 source toss-web · 기타법인 있음 · 한도 없음 · 네이버로 넘김 경고 없음", async () => {
    const naver = new FakeSource("naver", NAVER.samsung);
    const { service, warns } = await makeService({ now: NIGHT, tossSource: new TossTradingTrend(tossEtnFetch(), NIGHT), naver });
    const r = await service.get("520057");
    if (!r.supported) throw new Error("한국 종목");
    expect(r).toMatchObject({ source: "toss-web", basis: "KRX+NXT", limit: null, asOf: "2026-09-28T20:19:14+09:00" });
    expect(r.days[0]).toMatchObject({ date: "2026-09-28", otherCorp: -73_989, foreignRatio: 0.17 });
    expect(naver.calls).toHaveLength(0);
    expect(warns).toEqual([]);
  });

  it("미국 종목: 외부 호출 없이 supported: false", async () => {
    const { service, toss, naver } = await makeService({ now: NIGHT });
    expect(await service.get("AAPL")).toEqual({ code: "AAPL", supported: false, reason: FLOW_TEXT.usReason });
    expect(toss.calls.length + naver.calls.length).toBe(0);
  });
});

describe("수급 서비스: 폴백 순서", () => {
  it("토스 웹 실패 → 24시간 안 토스 캐시(stale)", async () => {
    let t = Date.parse("2026-09-29T10:00:00+09:00");
    const { service, toss, naver } = await makeService({ now: () => new Date(t) });
    expect((await service.get("005930")) as { stale: boolean }).toMatchObject({ source: "toss-web", stale: false });
    toss.fail = true;
    t += 11 * 60_000;
    const r = await service.get("005930");
    expect(r).toMatchObject({ source: "toss-web", stale: true, fetchedAt: "2026-09-29T10:00:00+09:00" });
    expect(naver.calls).toHaveLength(0);
  });

  it("토스 웹 실패 → 어제 장중(15:00)에 받은 토스 캐시: 그 날 잠정 값은 합계·막대·오늘 줄에 넣지 않는다", async () => {
    let t = Date.parse("2026-09-29T15:00:00+09:00");
    const provisional = { ...row("2026-09-29"), individual: null, otherCorp: null, foreign: 9_000_000, institution: -40_000, inMarketTime: false, hasAll: false, updatedAt: "2026-09-29T15:00:00.000+09:00" };
    const toss = new FakeSource("toss-web", [provisional, ...TOSS.samsung]);
    const { service, naver } = await makeService({ now: () => new Date(t), toss });
    const first = await service.get("005930");
    expect(first).toMatchObject({ stale: false, today: { date: "2026-09-29", foreign: 9_000_000 } });
    toss.fail = true;
    t = Date.parse("2026-09-30T10:00:00+09:00"); // 19시간 뒤 (24시간 안 토스 캐시)
    const r = await service.get("005930");
    if (!r.supported) throw new Error("한국 종목");
    expect(r).toMatchObject({ source: "toss-web", stale: true, fetchedAt: "2026-09-29T15:00:00+09:00", today: null });
    expect(r.days[0]!.date).toBe("2026-09-28");
    expect(r.sums["5"].foreign).toBe(4_179_201); // 9/28 까지 다섯 날 — 9/29 잠정 +900만 은 빠짐
    expect(naver.calls).toHaveLength(0);
  });

  it("토스 웹 실패·토스 캐시 없음 → 네이버 (KRX 기준, 기타법인·한도·대조 없음) + 경고 로그", async () => {
    const toss = new FakeSource("toss-web", TOSS.kt);
    toss.fail = true;
    const openApi = new FakeOpenApi(apiDays(TOSS.kt));
    const { service, warns } = await makeService({ now: NIGHT, toss, naver: new FakeSource("naver", NAVER.kt), openApi });
    const r = await service.get("030200");
    if (!r.supported) throw new Error("한국 종목");
    expect(r).toMatchObject({ source: "naver", basis: "KRX", stale: false, limit: null, check: null, asOf: "2026-09-29T02:40:00+09:00" });
    expect(r.sums["20"]).toMatchObject({ individual: 82_571, otherCorp: null });
    expect(r.days[0]!.otherCorp).toBeNull();
    expect(warns.map((w) => w.msg)).toContain("수급 출처를 네이버로 넘김");
    expect(warns.find((w) => w.msg === "수급 출처를 네이버로 넘김")?.obj).toMatchObject({ code: "030200" });
    await service.idle();
    expect(openApi.calls).toHaveLength(0); // 네이버 자료는 기준이 달라 대조하지 않는다
  });

  it("둘 다 실패 → 72시간 안 아무 캐시(stale), 없으면 502", async () => {
    let t = Date.parse("2026-09-29T10:00:00+09:00");
    const toss = new FakeSource("toss-web", TOSS.samsung);
    toss.fail = true;
    const naver = new FakeSource("naver", NAVER.samsung);
    const { service } = await makeService({ now: () => new Date(t), toss, naver });
    expect(await service.get("005930")).toMatchObject({ source: "naver", stale: false });
    naver.fail = true;
    t += 30 * 3_600_000; // 30시간 뒤 (토스 캐시는 애초에 없음)
    expect(await service.get("005930")).toMatchObject({ source: "naver", stale: true, fetchedAt: "2026-09-29T10:00:00+09:00" });
    t += 50 * 3_600_000; // 80시간 뒤 → 캐시도 너무 오래됨
    await expect(service.get("005930")).rejects.toMatchObject({ statusCode: 502, code: "UPSTREAM", message: FLOW_TEXT.upstream });
  });

  it("한 응답 안에 두 출처를 섞지 않는다 (네이버로 넘어간 응답의 줄은 모두 네이버 값)", async () => {
    const toss = new FakeSource("toss-web", TOSS.samsung);
    toss.fail = true;
    const { service } = await makeService({ now: NIGHT, toss });
    const r = await service.get("005930");
    if (!r.supported) throw new Error("한국 종목");
    expect(r.days.map((d) => d.individual)).toEqual(NAVER.samsung.map((d) => d.individual));
    expect(r.ratio?.now).toBe(46.56);
  });

  it("ETN(토스 400 · 네이버 보유율 '-'): 네이버 자료로 200 — 보유율 카드 없음, 모양 바뀜 경고 없음", async () => {
    const toss = new FakeSource("toss-web", []);
    toss.fail = true;
    const etn = parseNaverTrend([
      { bizdate: "20260928", individualPureBuyQuant: "+1,200", foreignerPureBuyQuant: "-300", organPureBuyQuant: "-900", foreignerHoldRatio: "-", closePrice: "10,050" },
      { bizdate: "20260926", individualPureBuyQuant: "-500", foreignerPureBuyQuant: "0", organPureBuyQuant: "+500", foreignerHoldRatio: "-", closePrice: "10,000" },
    ]);
    const { service, warns } = await makeService({ now: NIGHT, toss, naver: new FakeSource("naver", etn) });
    const r = await service.get("530036");
    expect(r).toMatchObject({ supported: true, source: "naver", stale: false, ratio: null, limit: null });
    expect(r.supported && r.sums["5"]).toMatchObject({ individual: 700, foreign: -300, institution: -400, days: 2 });
    expect(warns.map((w) => w.msg)).not.toContain("수급 출처 모양 바뀜");
  });

  it("없는 코드: 토스 400 → 네이버 [] → days: [] (자료 없음)", async () => {
    const toss = new FakeSource("toss-web", []);
    toss.fail = true;
    const { service } = await makeService({ now: NIGHT, toss, naver: new FakeSource("naver", []) });
    expect(await service.get("999999")).toMatchObject({ supported: true, source: "naver", days: [], ratio: null, today: null, asOf: "2026-09-29T02:40:00+09:00" });
  });
});

describe("수급 서비스: 캐시", () => {
  it("평일 10:00: 10분 안 두 번째는 호출 0, 10분 뒤 1회", async () => {
    let t = Date.parse("2026-09-29T10:00:00+09:00");
    const { service, toss } = await makeService({ now: () => new Date(t) });
    await service.get("005930");
    t += 9 * 60_000;
    await service.get("005930");
    expect(toss.calls).toHaveLength(1);
    t += 2 * 60_000;
    expect(await service.get("005930")).toMatchObject({ fetchedAt: "2026-09-29T10:11:00+09:00" });
    expect(toss.calls).toHaveLength(2);
  });

  it("토요일은 60분", async () => {
    let t = Date.parse("2026-10-03T10:00:00+09:00");
    const { service, toss } = await makeService({ now: () => new Date(t) });
    await service.get("005930");
    t += 59 * 60_000;
    await service.get("005930");
    expect(toss.calls).toHaveLength(1);
    t += 2 * 60_000;
    await service.get("005930");
    expect(toss.calls).toHaveLength(2);
  });

  it("같은 종목 동시 요청 5개 → 호출 1", async () => {
    const toss = new FakeSource("toss-web", TOSS.samsung);
    let release!: () => void;
    toss.wait = new Promise<void>((r) => (release = r));
    const { service } = await makeService({ now: NIGHT, toss });
    const all = Promise.all(Array.from({ length: 5 }, () => service.get("005930")));
    release();
    const got = await all;
    expect(toss.calls).toHaveLength(1);
    expect(new Set(got.map((g) => JSON.stringify(g))).size).toBe(1);
  });

  it("종목 300개까지 — 오래 안 쓴 것부터 버린다", async () => {
    const { service, toss } = await makeService({ now: NIGHT, toss: new FakeSource("toss-web", TOSS.samsung.slice(0, 3)) });
    const code = (i: number) => String(100000 + i);
    for (let i = 0; i < 301; i++) await service.get(code(i));
    expect(toss.calls).toHaveLength(301);
    await service.get(code(300)); // 남아 있음
    expect(toss.calls).toHaveLength(301);
    await service.get(code(0)); // 가장 오래 안 쓴 것 → 버려졌다
    expect(toss.calls).toHaveLength(302);
  });
});

describe("수급 서비스: 토스 Open API 대조 (개수만)", () => {
  it("같은 원천이면 20/20 — 첫 응답은 기다리지 않고, 뒤에서 대조한 뒤 다음 응답에 check", async () => {
    let t = Date.parse("2026-09-29T21:00:00+09:00");
    const openApi = new FakeOpenApi(apiDays(TOSS.samsung));
    const { service } = await makeService({ now: () => new Date(t), openApi });
    expect(await service.get("005930")).toMatchObject({ check: null });
    await service.idle();
    expect(openApi.calls).toEqual(["005930:22"]);
    t += 61 * 60_000;
    expect(await service.get("005930")).toMatchObject({ check: { at: "2026-09-29T21:00:00+09:00", days: 20, same: 20 } });
    // 12시간 안에는 다시 부르지 않는다
    await service.idle();
    expect(openApi.calls).toHaveLength(1);
  });

  it("한 날 기관만 다르면 19/20 + 경고 로그(날짜·칸 이름만, 숫자 없음)", async () => {
    const api = apiDays(TOSS.samsung).map((d, i) => (i === 2 ? { ...d, institution: (d.institution ?? 0) - 5 } : d));
    const { service, warns } = await makeService({ now: NIGHT, openApi: new FakeOpenApi(api) });
    await service.get("005930");
    await service.idle();
    const r = await service.get("005930");
    expect(r).toMatchObject({ check: { days: 20, same: 19 } });
    const w = warns.find((x) => x.msg === "수급 대조: 토스 Open API 와 다른 날이 있음");
    // 순매수 숫자는 로그에 없다 (날짜·칸 이름만 — 값은 관리 경로로)
    expect(w?.obj).toEqual({ code: "005930", days: 20, same: 19, diffs: [{ date: TOSS.samsung[2]!.date, fields: ["institution"] }] });
  });

  it("키 없음 → check: null · 대조가 끝나지 않아도 응답은 바로", async () => {
    const { service } = await makeService({ now: NIGHT, openApi: null });
    await service.get("005930");
    await service.idle();
    expect(await service.get("005930")).toMatchObject({ check: null });
    const hang = await makeService({ now: NIGHT, openApi: new FakeOpenApi([], true) });
    expect(await hang.service.get("005930")).toMatchObject({ supported: true, check: null });
  });
});

// ───────────────────────────── 9~12. 경로 ─────────────────────────────

async function makeApp(o: { sources?: InvestorFlowSources | null; flag?: boolean; now?: () => Date } = {}) {
  const db = await createMigratedDb(":memory:");
  const toss = new FakeSource("toss-web", TOSS.samsung);
  const naver = new FakeSource("naver", NAVER.samsung);
  const openApi = new FakeOpenApi(apiDays(TOSS.samsung).map((d, i) => (i === 0 ? { ...d, foreign: (d.foreign ?? 0) + 1 } : d)));
  const sources = o.sources === undefined ? { tossWeb: toss, naver, openApi } : o.sources;
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ investorFlowSources: sources }), logger: false, enableScheduler: false, now: o.now ?? NIGHT });
  if (o.flag === false) await app.inject({ method: "PUT", url: "/api/admin/features", payload: { flowTab: false } });
  return { app, db, toss, naver, openApi, close: async () => (await app.close(), await db.destroy()) };
}

describe("경로 GET /api/investor-flow/:code (공용)", () => {
  it("켜짐: 한국 종목 200 · 소문자·공백 코드는 정리 · 미국 supported:false · 틀린 코드 400", async () => {
    const x = await makeApp();
    try {
      const ok = await x.app.inject({ method: "GET", url: "/api/investor-flow/005930" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ code: "005930", supported: true, source: "toss-web", basis: "KRX+NXT" });
      const us = await x.app.inject({ method: "GET", url: "/api/investor-flow/aapl" });
      expect(us.json()).toEqual({ code: "AAPL", supported: false, reason: FLOW_TEXT.usReason });
      expect((await x.app.inject({ method: "GET", url: "/api/investor-flow/%21%21" })).statusCode).toBe(400);
      expect(x.toss.calls).toEqual(["005930"]);
    } finally {
      await x.close();
    }
  });

  it("플래그 꺼짐 → 404 · 토스 웹·네이버·Open API 호출 0 (관리 경로는 {enabled:false})", async () => {
    const x = await makeApp({ flag: false });
    try {
      const r = await x.app.inject({ method: "GET", url: "/api/investor-flow/005930" });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: "NOT_FOUND", message: FLOW_TEXT.off });
      expect((await x.app.inject({ method: "GET", url: "/api/investor-flow/AAPL" })).statusCode).toBe(404);
      expect((await x.app.inject({ method: "GET", url: "/api/admin/investor-flow/check?code=005930" })).json()).toEqual({ enabled: false });
      expect(x.toss.calls.length + x.naver.calls.length + x.openApi.calls.length).toBe(0);
    } finally {
      await x.close();
    }
  });

  it("출처 묶음이 없으면(테스트 기본) 404", async () => {
    const x = await makeApp({ sources: null });
    try {
      expect((await x.app.inject({ method: "GET", url: "/api/investor-flow/005930" })).statusCode).toBe(404);
      expect((await x.app.inject({ method: "GET", url: "/api/admin/investor-flow/check?code=005930" })).json()).toEqual({ enabled: false });
    } finally {
      await x.close();
    }
  });

  it("두 출처 모두 실패·캐시 없음 → 502 UPSTREAM '수급 자료를 받지 못했습니다'", async () => {
    const toss = new FakeSource("toss-web", []);
    const naver = new FakeSource("naver", []);
    toss.fail = naver.fail = true;
    const x = await makeApp({ sources: { tossWeb: toss, naver, openApi: null } });
    try {
      const r = await x.app.inject({ method: "GET", url: "/api/investor-flow/005930" });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual({ error: "UPSTREAM", message: FLOW_TEXT.upstream });
    } finally {
      await x.close();
    }
  });
});

describe("관리 경로 GET /api/admin/investor-flow/check (서버 주인만 — 토스 Open API 원자료가 담김)", () => {
  it("그 자리에서 대조를 다시 돌려 날짜별 두 값을 준다 (다른 날 표시)", async () => {
    const x = await makeApp();
    try {
      const r = (await x.app.inject({ method: "GET", url: "/api/admin/investor-flow/check?code=005930" })).json();
      expect(r).toMatchObject({ enabled: true, code: "005930", available: true, days: 20, same: 19, at: "2026-09-29T02:40:00+09:00" });
      expect(r.rows).toHaveLength(20);
      expect(r.rows[0]).toEqual({
        date: "2026-09-28",
        same: false,
        fields: ["foreign"],
        web: { individual: 7_422_778, foreign: -5_984_131, institution: -3_626_482 },
        api: { individual: 7_422_778, foreign: -5_984_130, institution: -3_626_482 },
      });
      expect(r.rows[1].same).toBe(true);
      // 공용 경로에는 개수만 (원자료 없음)
      const pub = (await x.app.inject({ method: "GET", url: "/api/investor-flow/005930" })).json();
      expect(pub.check).toEqual({ at: "2026-09-29T02:40:00+09:00", days: 20, same: 19 });
      expect(JSON.stringify(pub)).not.toContain("-5984130");
    } finally {
      await x.close();
    }
  });

  it("토스 Open API 키가 없으면 available: false · 코드 없음·틀림 400 · 미국 종목 400", async () => {
    const x = await makeApp({ sources: { tossWeb: new FakeSource("toss-web", TOSS.samsung), naver: new FakeSource("naver", []), openApi: null } });
    try {
      expect((await x.app.inject({ method: "GET", url: "/api/admin/investor-flow/check?code=005930" })).json()).toEqual({ enabled: true, code: "005930", available: false, reason: FLOW_TEXT.noOpenApi });
      expect((await x.app.inject({ method: "GET", url: "/api/admin/investor-flow/check" })).statusCode).toBe(400);
      expect((await x.app.inject({ method: "GET", url: "/api/admin/investor-flow/check?code=AAPL" })).statusCode).toBe(400);
    } finally {
      await x.close();
    }
  });
});

// ───────────────────────────── 공용 픽스처 (앱 테스트가 그리는 응답) ─────────────────────────────

describe("공용 픽스처 shared/fixtures/investorFlow.json", () => {
  it("지금 서버 계산과 같다 (삼성전자 토스 웹 · 삼성전자 네이버 폴백 · KT 한도)", () => {
    const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/investorFlow.json", import.meta.url), "utf8")) as { cases: Record<string, unknown> };
    const now = NIGHT();
    const check20 = { at: "2026-09-29T21:05:00+09:00", days: 20, same: 20 };
    expect(buildFlowBody({ code: "005930", source: "toss-web", rows: TOSS.samsung, fetchedAt: now, stale: false, check: check20, now })).toEqual(shared.cases["samsung"]);
    expect(buildFlowBody({ code: "005930", source: "naver", rows: NAVER.samsung, fetchedAt: now, stale: false, check: null, now })).toEqual(shared.cases["samsungNaver"]);
    expect(buildFlowBody({ code: "030200", source: "toss-web", rows: TOSS.kt, fetchedAt: now, stale: false, check: { ...check20, same: 19 }, now })).toEqual(shared.cases["kt"]);
  });
});

// ───────────────────────────── 13·14. 문구·플래그 ─────────────────────────────

describe("문구: 투자 권유·수급 판단 낱말 0건", () => {
  it("서버가 만드는 모든 글 (미국 안내·꺼짐·실패·키 없음)", () => {
    for (const [k, s] of Object.entries(FLOW_TEXT)) expect(flowWordingProblems(s), k).toEqual([]);
  });

  it("검사기가 수급 판단 낱말과 권유 말을 잡는다 ('순매수'·'순매도'·'공매도' 자료 이름은 허용)", () => {
    expect(flowWordingProblems("외국인 순매수 · 기관 순매도")).toEqual([]);
    expect(flowWordingProblems("공매도 잔고처럼 한 달에 두 번 나오는 자료")).toEqual([]);
    expect(flowWordingProblems("매도 신호")).toEqual(["매도", "신호"]);
    expect(flowWordingProblems("외국인 매집 신호")).toEqual(["매집", "신호"]);
    expect(flowWordingProblems("수급 개선, 매수 추천")).toEqual(expect.arrayContaining(["매수", "추천", "수급 개선"]));
    expect(flowWordingProblems("개미가 몰려 이탈")).toEqual(expect.arrayContaining(["개미", "몰려", "이탈"]));
    expect(FLOW_JUDGE_RE.test("강세")).toBe(true);
  });
});

describe("기능 플래그 flowTab", () => {
  it("서버 기본 켜짐, 설명에 끄면 탭·경로·호출 0", () => {
    expect(FEATURES.flowTab.default).toBe(true);
    expect(FEATURES.flowTab.description).toMatch(/3-33/);
    expect(FEATURES.flowTab.description).toMatch(/끄면 .*404.*호출 0/);
  });

  it("docs/기능-플래그.md 표에 한 줄", () => {
    const doc = readFileSync(new URL("../../docs/기능-플래그.md", import.meta.url), "utf8");
    expect(doc).toMatch(/^\| `flowTab` \| 켜짐 \|/m);
  });
});
