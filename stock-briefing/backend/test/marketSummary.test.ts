import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { buildDigest, KR_PREVIOUS_DAY_LINE, US_PREVIOUS_DAY_LINE, type DigestAccount, type DigestItem } from "../src/notifications/digest.js";
import type { PushMessage, PushSendResult, PushSender } from "../src/notifications/push.js";
import type { MarketStatus } from "../src/providers/market/calendar.js";
import type { MarketIndex } from "../src/providers/market/indices.js";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { parseGoogleRss } from "../src/providers/news/googleRss.js";
import type { NewsItem } from "../src/providers/news/types.js";
import { BACKUP_TABLES } from "../src/services/backupService.js";
import { eventsCoverage, MARKET_EVENTS, nextOpenEvent, upcomingEvents } from "../src/services/marketEvents.js";
import {
  basisText,
  blockedTitle,
  classify,
  compareHoldings,
  diffBp,
  digestLine,
  eventsText,
  fitLines,
  fxText,
  holdingsAux,
  holdingsText,
  holidayText,
  krSectors,
  LEVERAGE_RE,
  naverYield,
  newsDays,
  newsWindow,
  parseTreasuryCsv,
  phaseOf,
  pickNews,
  ratesText,
  resolveDates,
  sessionClose,
  summaryLines,
  titleDays,
  titleText,
  treasuryYield,
  usSectors,
  yieldLine,
  type MarketSummaryData,
  type SummaryIndex,
  type SummaryLine,
} from "../src/services/marketSummaryCalc.js";
import { defaultSummarySources, digestMarket, krSectorsStale, MarketSummaryService, type MarketSummarySources } from "../src/services/marketSummaryService.js";
import { fakeIndices, fakeProviders, FakeSearchProvider, SAMPLE_MASTER } from "./helpers.js";

/**
 * 시장 전체 요약 (플래그 marketSummary). 네트워크 없이 — 고정 시계와 녹화한 출처 응답(test/fixtures/marketSummary, 2026-09-26 실측을 줄인 것)으로 본다.
 * 문장은 앱과 같은 글인지 공용 픽스처(shared/fixtures/marketSummary.json)로 본다
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/marketSummary/${name}`, import.meta.url), "utf8");
const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as {
  cases: Array<{
    name: string;
    data: MarketSummaryData;
    views: Array<{ at: string; title: string; basis: string; holiday: string | null; lines: string[] | null }>;
    digest: { at: string; line: string };
    aux: string | null;
  }>;
  variants: Array<{ name: string; base: number; patch: Partial<MarketSummaryData>; at: string; digest: string; basis: string }>;
};
const at = (iso: string) => new Date(iso);
const idx = (code: string, name: string, rate: number, date: string): SummaryIndex => ({ code, name, value: 100, change: 1, changeRate: rate, date, asOf: `${date}T16:00:00-04:00` });

/** 네이버 폴링 응답을 요청한 코드만 담아 돌려주는 가짜 fetch (모르는 코드는 빠진다 — 실제 출처와 같게) */
function pollingFetch(file: string, key: "reutersCode" | "itemCode") {
  const all = JSON.parse(fixture(file)) as { datas: Array<Record<string, unknown>> };
  return (async (url: string) => {
    const codes = decodeURIComponent(url.split("/stock/")[1] ?? "").split(",");
    return new Response(JSON.stringify({ pollingInterval: 7000, datas: all.datas.filter((d) => codes.includes(String(d[key]))) }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("공용 픽스처 — 서버 문장 (앱 lib/marketSummary 와 같은 글)", () => {
  for (const c of shared.cases) {
    it(c.name, () => {
      for (const v of c.views) {
        const view = at(v.at);
        expect(titleText(c.data, view), `${v.at} 제목`).toBe(v.title);
        expect(basisText(c.data, view), `${v.at} 기준 줄`).toBe(v.basis);
        expect(holidayText(c.data, view)).toBe(v.holiday);
        if (v.lines) expect(summaryLines(c.data, view).map((l) => l.text)).toEqual(v.lines);
      }
      expect(digestLine(c.data, at(c.digest.at))).toBe(c.digest.line);
      if (c.aux) expect(holdingsAux(c.data.holdings!)).toBe(c.aux);
    });
  }

  for (const v of shared.variants) {
    it(`변형: ${v.name}`, () => {
      const d = { ...shared.cases[v.base]!.data, ...v.patch } as MarketSummaryData;
      expect(digestLine(d, at(v.at))).toBe(v.digest);
      expect(basisText(d, at(v.at))).toBe(v.basis);
    });
  }

  it("화~금 아침은 '밤사이 미국 시장', 다음 날 보면 날짜로 (보는 날짜로 정한다)", () => {
    const d = { market: "US" as const, holiday: null, marketDate: "2026-09-24", basisDate: "2026-09-24" };
    expect(titleText(d, at("2026-09-25T08:31:00+09:00"))).toBe("밤사이 미국 시장");
    expect(titleText(d, at("2026-09-26T07:00:00+09:00"))).toBe("목요일(9/24) 미국 시장");
    // 자정 뒤·다음 아침 08:30 전에도 어제 요약을 '밤사이'로 보이지 않는다
    expect(titleText(d, at("2026-09-26T00:10:00+09:00"))).toBe("목요일(9/24) 미국 시장");
    // 일요일 아침(평일만 돌기를 끈 경우): 토요일은 주말이라 금요일 값을 날짜로
    const sun = resolveDates({ session: "morning", date: "2026-09-27" });
    expect(sun).toMatchObject({ marketDate: "2026-09-26", basisDate: "2026-09-25", holiday: null });
    expect(titleText({ market: "US", ...sun }, at("2026-09-27T08:31:00+09:00"))).toBe("금요일(9/25) 미국 시장");
  });
});

describe("미국 제목은 숫자의 거래일로 — '밤사이'는 그 거래일이 보는 날의 전날일 때만 (요구 검사 보정: 월요일·휴장 다음 날)", () => {
  const titleAt = (date: string, view: string) => titleText({ market: "US", ...resolveDates({ session: "morning", date }) }, at(view));
  it("추수감사절 다음 날(11/27)은 11/25 값이라 '수요일(11/25) 미국 시장', 노동절 다음 날(9/8)은 '금요일(9/4)', 성금요일 다음 월요일(2027-03-29)은 '목요일(3/25)'", () => {
    expect(titleAt("2026-11-27", "2026-11-27T08:31:00+09:00")).toBe("수요일(11/25) 미국 시장");
    expect(titleAt("2026-09-08", "2026-09-08T08:31:00+09:00")).toBe("금요일(9/4) 미국 시장");
    expect(titleAt("2027-03-29", "2027-03-29T08:31:00+09:00")).toBe("목요일(3/25) 미국 시장");
    // 휴장 배너·알림 첫 줄은 그대로 '지난밤 미국 휴장(…)' (휴장 사실은 어젯밤 것이 맞다)
    const labor = { market: "US" as const, ...resolveDates({ session: "morning", date: "2026-09-08" }) };
    expect(holidayText(labor, at("2026-09-08T08:31:00+09:00"))).toBe("지난밤 미국 휴장(노동절) · 아래는 직전 거래일 9/4(금) 기준");
    // 평일 보통 아침은 그대로 '밤사이'
    expect(titleAt("2026-09-25", "2026-09-25T08:31:00+09:00")).toBe("밤사이 미국 시장");
    // 한국 휴장 오후는 그날 '오늘 한국 시장'(휴장 배지·배너) 그대로
    expect(titleText({ market: "KR", ...resolveDates({ session: "afternoon", date: "2026-09-25" }) }, at("2026-09-25T16:01:00+09:00"))).toBe("오늘 한국 시장");
  });

  it("휴장 다음 날 알림 첫 줄: 휴장이 아닌 월요일은 날짜로, 휴장 다음 날은 '지난밤 미국 휴장(…) · … (M/D 기준)'", () => {
    const c = shared.cases.find((x) => x.name.includes("추수감사절"))!;
    expect(digestLine(c.data, at("2026-11-27T08:31:00+09:00"))).toBe("지난밤 미국 휴장(추수감사절) · 나스닥 -0.20% · S&P500 +0.30% (11/25 기준)");
    expect(titleText(c.data, at("2026-11-27T08:31:00+09:00"))).toBe("수요일(11/25) 미국 시장");
  });
});

describe("환율·금리 줄의 날짜 표기 (휴장이면 금리에도 'M/D 기준', 고시일을 모르면 그렇다고)", () => {
  const fx = { value: 1359, change: 3.5, changeRate: 0.26, stale: false };
  const y = { value: 4.9, change: 0.02, date: "2026-11-25", prevValue: 4.88, prevDate: "2026-11-24", source: "treasury" as const, dp: { value: 2, change: 2 } };
  it("휴장 다음 날: '미 10년물 4.90% +0.02%p (11/25 기준 · 미 재무부)', 평소에는 날짜 없이", () => {
    expect(ratesText({ fx: { ...fx, date: "2026-11-26" }, date: "2026-11-27", yield10y: y, holiday: { date: "2026-11-26", name: "추수감사절" } })).toBe("원/달러 1,359.00원 +3.50원 (11/26 고시) · 미 10년물 4.90% +0.02%p (11/25 기준 · 미 재무부)");
    expect(ratesText({ fx: { ...fx, date: "2026-11-26" }, date: "2026-11-27", yield10y: y, holiday: null })).toBe("원/달러 1,359.00원 +3.50원 (11/26 고시) · 미 10년물 4.90% +0.02%p (미 재무부)");
  });
  it("원/달러 고시일을 확인하지 못했으면(일별 시리즈 실패) 날짜 없는 값이 오늘 값처럼 보이지 않게 '(고시일 확인 못 함)'", () => {
    expect(fxText({ fx: { ...fx, date: null }, date: "2026-09-25" })).toBe("원/달러 1,359.00원 +3.50원 (고시일 확인 못 함)");
    expect(fxText({ fx: { ...fx, date: "2026-09-25" }, date: "2026-09-25" })).toBe("원/달러 1,359.00원 +3.50원");
  });
});

describe("내 보유 종목 vs 지수 (±1%p, 상장 시장별 비교 지수)", () => {
  it("차이는 출처 소수 둘째 자리 값을 그대로 빼고, ±1.00%p 경계는 높음·낮음에 넣는다", () => {
    expect(1.15 - 0.15).toBeLessThan(1); // 부동소수로 빼면 0.9999… (비슷으로 잘못 분류) — 정수 1/100 로 뺀다
    expect(classify(diffBp(1.15, 0.15))).toBe("high");
    expect(diffBp(1.48, 0.48)).toBe(100);
    expect(classify(diffBp(1.48, 0.48))).toBe("high");
    expect(classify(diffBp(1.47, 0.48))).toBe("similar");
    expect(classify(diffBp(-0.52, 0.48))).toBe("low");
    expect(classify(diffBp(-0.51, 0.48))).toBe("similar");
    expect(classify(diffBp(3.66, 0.48))).toBe("high");
  });

  it("미국: 나스닥 상장(NSQ) → 나스닥, 뉴욕·아멕스(NYS·AMX) → S&P500, 모르는 거래소·레버리지 ETF·시세 날짜 다름·지수 없음은 빼고 개수만", () => {
    const indices = [idx("NASDAQ", "나스닥", 0.48, "2026-09-25"), idx("SPX", "S&P500", 0.51, "2026-09-25")];
    const q = (rate: number, exchange: string, date = "2026-09-25", name?: string) => ({ changeRate: rate, tradedAt: `${date}T16:00:00-04:00`, exchange, ...(name ? { name } : {}) });
    const cmp = compareHoldings({
      market: "US",
      basisDate: "2026-09-25",
      holdings: [
        { code: "MSFT", name: "마이크로소프트", market: "NASDAQ" },
        { code: "JPM", name: "JP모건", market: "NYSE" },
        { code: "XLK", name: "기술 섹터 ETF", market: "AMEX" },
        { code: "TQQQ", name: "TQQQ", market: "NASDAQ" },
        { code: "ZZZ", name: "모르는 거래소", market: "US" },
        { code: "OLD", name: "거래정지", market: "NYSE" },
        { code: "AAPL", name: "애플", market: "NASDAQ" },
        { code: "JPST", name: "JPST", market: "AMEX" },
        { code: "SGOV", name: "아이셰어즈 0-3개월 미국 국채 ETF", market: "AMEX" },
      ],
      quotes: new Map([
        ["MSFT", q(3.66, "NASDAQ")],
        ["JPM", q(1.33, "NYSE")],
        ["XLK", q(-0.8, "AMEX")],
        ["TQQQ", q(1.3, "NASDAQ", "2026-09-25", "ProShares UltraPro QQQ")],
        ["ZZZ", q(2, "PCX")],
        ["OLD", q(9, "NYSE", "2026-09-10")],
        // AAPL: 시세가 오지 않음(거래정지·코드를 못 찾음) → 비교 지수가 아니라 '시세 없음'으로 센다
        ["JPST", q(0.02, "AMEX", "2026-09-25", "JPMorgan Ultra-Short Income ETF")],
        ["SGOV", q(0.01, "AMEX")],
      ]),
      indices,
    })!;
    expect(cmp.compared).toBe(3);
    expect(cmp.high.map((r) => [r.name, r.benchmark.code, r.diff])).toEqual([["마이크로소프트", "NASDAQ", 3.18]]);
    expect(cmp.low.map((r) => [r.name, r.benchmark.code, r.diff])).toEqual([["기술 섹터 ETF", "SPX", -1.31]]);
    expect(cmp.similar.map((r) => [r.name, r.benchmark.code, r.diff])).toEqual([["JP모건", "SPX", 0.82]]);
    expect(cmp.excluded).toEqual({ leverage: ["TQQQ"], overseas: [], bond: ["JPST", "아이셰어즈 0-3개월 미국 국채 ETF"], noQuote: ["거래정지", "애플"], noBenchmark: ["모르는 거래소"] });
    expect(cmp.benchmarks.map((b) => b.code)).toEqual(["NASDAQ", "SPX"]);
    // 기준 지수를 받지 못하면 그 종목은 비교하지 못함으로
    const noIdx = compareHoldings({ market: "US", basisDate: "2026-09-25", holdings: [{ code: "MSFT", name: "MS", market: "NASDAQ" }], quotes: new Map([["MSFT", q(1, "NASDAQ")]]), indices: [] })!;
    expect(noIdx).toMatchObject({ compared: 0, excluded: { noBenchmark: ["MS"] } });
    expect(holdingsText({ holdings: noIdx, holiday: null, basisDate: "2026-09-25" })).toBeNull();
  });

  it("한국: 코스피·코스닥 상장 시장별, 한국 상장 해외 지수 ETF·레버리지는 빼고, 코넥스는 비교 지수 없음 (녹화한 네이버 시세)", async () => {
    const krq = await new NaverDiscover(pollingFetch("naver-kr-quotes.json", "itemCode")).krQuotes(["005930", "035420", "247540", "000660", "069500", "133690", "122630", "999999"]);
    expect(krq.get("005930")).toMatchObject({ name: "삼성전자", exchange: "KS", price: 286_500, changeRate: 3.62 });
    expect(krq.get("035420")).toMatchObject({ changeRate: -2.49 });
    expect(krq.get("247540")).toMatchObject({ exchange: "KQ", changeRate: 1.15 });
    expect(krq.has("999999")).toBe(false);
    const quotes = new Map([...krq].map(([c, q]) => [c, { changeRate: q.changeRate, tradedAt: q.tradedAt, name: q.name, exchange: q.exchange }]));
    quotes.set("KONEX1", { changeRate: 5, tradedAt: "2026-09-23T15:30:00+09:00", name: "코넥스 종목", exchange: "KN" });
    const cmp = compareHoldings({
      market: "KR",
      basisDate: "2026-09-23",
      holdings: [
        { code: "005930", name: "삼성전자", market: "KOSPI" },
        { code: "035420", name: "NAVER", market: "KOSPI" },
        { code: "247540", name: "에코프로비엠", market: "KOSDAQ" },
        { code: "000660", name: "SK하이닉스", market: "KOSPI" },
        { code: "069500", name: "KODEX 200", market: "KOSPI", groupCode: "EF" },
        { code: "133690", name: "TIGER 미국나스닥100", market: "KOSPI", groupCode: "EF" },
        { code: "122630", name: "KODEX 레버리지", market: "KOSPI", groupCode: "EF" },
        { code: "KONEX1", name: "코넥스 종목", market: "KONEX" },
      ],
      quotes,
      indices: [idx("KOSPI", "코스피", 0.9, "2026-09-23"), idx("KOSDAQ", "코스닥", 1.21, "2026-09-23")],
    })!;
    expect(cmp.compared).toBe(5);
    expect(cmp.high.map((r) => `${r.name} ${r.diff}`)).toEqual(["삼성전자 2.72"]);
    expect(cmp.low.map((r) => `${r.name} ${r.diff}`)).toEqual(["NAVER -3.39"]);
    expect(cmp.similar.map((r) => `${r.name} ${r.benchmark.name} ${r.diff}`)).toEqual(["SK하이닉스 코스피 0.35", "KODEX 200 코스피 0.23", "에코프로비엠 코스닥 -0.06"]);
    expect(cmp.excluded).toEqual({ leverage: ["KODEX 레버리지"], overseas: ["TIGER 미국나스닥100"], bond: [], noQuote: [], noBenchmark: ["코넥스 종목"] });
    expect(holdingsText({ holdings: cmp, holiday: null, basisDate: "2026-09-23" })).toBe("내 국내 5종목 · 지수보다 높음 1 (삼성전자 +3.62%, 지수와 차이 +2.72%p) · 낮음 1 (NAVER -2.49%, 차이 -3.39%p) · 비슷 3");
  });

  it("채권·금리형 ETF(CD금리·KOFR·국고채·미국 국채)는 주식 지수와 견주지 않고 개수만, 'Ultra-Short' 는 레버리지가 아니다", () => {
    const indices = [idx("KOSPI", "코스피", 1.5, "2026-09-23"), idx("KOSDAQ", "코스닥", 1.21, "2026-09-23")];
    const q = (rate: number) => ({ changeRate: rate, tradedAt: "2026-09-23T15:30:00+09:00", exchange: "KS" });
    const cmp = compareHoldings({
      market: "KR",
      basisDate: "2026-09-23",
      holdings: [
        { code: "459580", name: "KODEX CD금리액티브(합성)", market: "KOSPI", groupCode: "EF" },
        { code: "423160", name: "KODEX KOFR금리액티브(합성)", market: "KOSPI", groupCode: "EF" },
        { code: "114820", name: "TIGER 국채3년", market: "KOSPI", groupCode: "EF" },
        { code: "305080", name: "TIGER 미국채10년선물", market: "KOSPI", groupCode: "EF" },
        { code: "005930", name: "삼성전자", market: "KOSPI", groupCode: "ST" },
      ],
      quotes: new Map([["459580", q(0.01)], ["423160", q(0.01)], ["114820", q(-0.05)], ["305080", q(0.2)], ["005930", q(3.62)]]),
      indices,
    })!;
    expect(cmp.compared).toBe(1);
    expect(cmp.excluded.bond).toEqual(["KODEX CD금리액티브(합성)", "KODEX KOFR금리액티브(합성)", "TIGER 국채3년", "TIGER 미국채10년선물"]);
    expect(cmp.low).toEqual([]);
    for (const name of ["JPMorgan Ultra-Short Income ETF", "BlackRock Ultra Short-Term Bond ETF"]) expect(LEVERAGE_RE.test(name), name).toBe(false);
    for (const name of ["ProShares UltraPro QQQ", "ProShares Ultra S&P500", "Direxion Daily Semiconductor Bull 3X"]) expect(LEVERAGE_RE.test(name), name).toBe(true);
  });

  it("보유 0 이면 null, 모두 비슷하면 '모두 지수와 ±1%p 안', 정렬은 차이 크기 → 이름 순", () => {
    const base = { market: "US" as const, basisDate: "2026-09-25", indices: [idx("NASDAQ", "나스닥", 0.5, "2026-09-25")] };
    expect(compareHoldings({ ...base, holdings: [], quotes: new Map() })).toBeNull();
    const q = (r: number) => ({ changeRate: r, tradedAt: "2026-09-25T16:00:00-04:00", exchange: "NSQ" });
    const cmp = compareHoldings({
      ...base,
      holdings: [
        { code: "B", name: "나", market: "NASDAQ" },
        { code: "A", name: "가", market: "NASDAQ" },
        { code: "C", name: "다", market: "NASDAQ" },
      ],
      quotes: new Map([["A", q(0.8)], ["B", q(0.2)], ["C", q(1.2)]]),
    })!;
    expect(cmp.similar.map((r) => r.name)).toEqual(["다", "가", "나"]); // |0.7| > |0.3| = |-0.3| → 이름 순
    expect(holdingsText({ holdings: cmp, holiday: null, basisDate: "2026-09-25" })).toBe("내 미국 3종목 모두 지수와 ±1%p 안");
    expect(holdingsText({ holdings: cmp, holiday: { date: "2026-09-26", name: null }, basisDate: "2026-09-25" })).toBe("9/25 기준 · 내 미국 3종목 모두 지수와 ±1%p 안");
  });
});

describe("업종 (미국 섹터 ETF 11개 · 한국 네이버 업종)", () => {
  it("녹화한 섹터 ETF 시세(9/25 정규장)로 위 2개·아래 2개 — 사양 예시와 같다", async () => {
    const q = await new NaverDiscover(pollingFetch("naver-us-quotes.json", "reutersCode")).usQuotes(["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE.K", "XLC"]);
    expect(q.size).toBe(11);
    const s = usSectors(q, "2026-09-25");
    if ("reason" in s) throw new Error(s.reason);
    expect(s.strong.map((x) => `${x.name} ${x.changeRate}`)).toEqual(["산업재 0.95", "기술 0.8"]);
    expect(s.weak.map((x) => `${x.name} ${x.changeRate}`)).toEqual(["커뮤니케이션 -0.9", "에너지 -0.89"]);
    expect(s.all).toHaveLength(11);
    // 하나라도 빠지거나(XLRE 는 .K) 날짜가 다르면 줄을 뺀다
    const missing = new Map(q);
    missing.delete("XLRE.K");
    expect(usSectors(missing, "2026-09-25")).toEqual({ reason: expect.stringContaining("11개 중 10개") });
    expect(usSectors(q, "2026-09-28")).toEqual({ reason: expect.stringContaining("날짜 다름") });
  });

  it("한국: 구성 5종목 미만·등락 ±30% 초과(상장 첫날 영향)는 빼고 위아래 2개", () => {
    const t = (name: string, changeRate: number, n: number) => ({ id: name, name, changeRate, up: n, flat: 0, down: 0 });
    const s = krSectors([t("가정용품", 163.21, 6), t("석유와가스", 3.13, 18), t("작은 업종", 9, 4), t("반도체와반도체장비", 2.8, 90), t("은행", 0.2, 10), t("철강", -2.92, 54), t("건설", -4.19, 72)], "2026-09-23");
    if ("reason" in s) throw new Error(s.reason);
    expect(s.strong.map((x) => x.name)).toEqual(["석유와가스", "반도체와반도체장비"]);
    expect(s.weak.map((x) => x.name)).toEqual(["건설", "철강"]);
    expect(s.excluded.map((x) => x.name)).toEqual(["가정용품", "작은 업종"]);
    expect(s.total).toBe(7);
  });

  it("한국 업종: 출처가 0으로 비운 값은 쓰지 않고, 비워서 준 저장본은 기준 거래일 값일 때만 쓴다 (발견 탭 문구 그대로)", () => {
    const zero = "출처가 잠시 등락률을 0으로 비웠습니다 (곧 다시 채워집니다)";
    const snap = "출처가 잠시 값을 비워 저장해 둔 직전 값을 보여 줍니다";
    expect(krSectorsStale({ note: zero, asOf: "2026-09-23T15:30:00+09:00" }, "2026-09-23")).toBe(true);
    expect(krSectorsStale({ note: snap, asOf: "2026-09-22T15:30:00+09:00" }, "2026-09-23")).toBe(true); // 전날 저장본
    expect(krSectorsStale({ note: snap, asOf: null }, "2026-09-23")).toBe(true); // 날짜를 모름
    expect(krSectorsStale({ note: snap, asOf: "2026-09-23T15:30:00+09:00" }, "2026-09-23")).toBe(false);
    expect(krSectorsStale({ note: null, asOf: "2026-09-23T15:30:00+09:00" }, "2026-09-23")).toBe(false);
  });
});

describe("미 10년물 (재무부 → 네이버 대체, 출처 표기)", () => {
  it("녹화한 재무부 CSV: 9/25 5.17%, 전일 대비는 앞 행과 빼서 -0.01%p", () => {
    const rows = parseTreasuryCsv(fixture("treasury-2026.csv"));
    expect(rows[0]).toEqual({ date: "2026-09-25", value: 5.17 });
    const y = treasuryYield(rows, "2026-09-25")!;
    expect(y).toMatchObject({ value: 5.17, change: -0.01, prevDate: "2026-09-24", source: "treasury" });
    expect(yieldLine(y)).toBe("미 10년물 5.17% -0.01%p (미 재무부)");
    expect(treasuryYield(rows, "2026-09-28")).toBeNull(); // 그날 행이 없으면 대체로
  });

  it("1월 첫 거래일은 전년 파일의 마지막 행과 뺀다", () => {
    const jan = parseTreasuryCsv('Date,"1 Mo","10 Yr"\n01/02/2027,4.1,4.60\n');
    const dec = parseTreasuryCsv('Date,"1 Mo","10 Yr"\n12/31/2026,4.1,4.55\n12/30/2026,4.1,4.50\n');
    expect(treasuryYield(jan, "2027-01-02")).toMatchObject({ change: null });
    expect(treasuryYield(jan, "2027-01-02", dec)).toMatchObject({ value: 4.6, change: 0.05, prevDate: "2026-12-31" });
  });

  it("네이버(로이터) 값은 출처 자리수 그대로 '(로이터·네이버)'를 붙이고, 날짜가 다르면 쓰지 않는다", () => {
    const raw = JSON.parse(fixture("naver-us10y.json"));
    const y = naverYield(raw, "2026-09-25")!;
    expect(yieldLine(y)).toBe("미 10년물 5.165% +0.0026%p (로이터·네이버)");
    expect(naverYield(raw, "2026-09-28")).toBeNull();
  });
});

describe("뉴스 제목 고르기 (원문 그대로 · 창 · 거르기 · 같은 기사·언론사 1건)", () => {
  const items = () => parseGoogleRss(fixture("google-news-sample.xml"));

  it("월요일 아침 창(금요일 마감 −10분 ~ 마감 뒤 6시간)에서 통신사 먼저·속보 뒤로 3건 — 제목은 원문(엔티티만 풂)", () => {
    const w = newsWindow("US", "2026-09-25", at("2026-09-28T08:30:00+09:00"));
    expect(w).toEqual({ from: "2026-09-25T19:50:00.000Z", to: "2026-09-26T02:00:00.000Z" });
    const picked = pickNews(items(), { ...w, days: newsDays("US", "2026-09-25") });
    expect(picked.map((n) => n.outlet)).toEqual(["뉴스1", "KBS", "한국경제"]);
    expect(picked.map((n) => n.title)).toEqual(["[뉴욕마감] 3대 지수 동반 상승…나스닥 0.48%↑", "뉴욕증시, 기술주 강세 속 상승 마감", "뉴욕증시 마감 시황 & 금리 동향"]);
    expect(picked[0]!.url).toBe("https://news.google.com/rss/articles/s2");
  });

  it("거르는 제목: 물음표·권유 낱말·전망/주간/이번주/예상/향방, 다른 날짜가 박힌 제목", () => {
    for (const t of ["지금 살까?", "반도체주 목표가 줄상향", "이번주 증시 전망", "이번 주 뉴욕증시", "금리 향방 주목", "실적 예상 웃돌아", "주간 증시 결산", "유망 종목 추천", "지금 담아라"]) expect(blockedTitle(t), t).toBe(true);
    expect(blockedTitle("뉴욕증시 상승 마감…다우 0.9%↑")).toBe(false);
    // 물음표 없이 묻거나 권하거나 내다보는 제목
    for (const t of ["지금 사도 될까", "상승 이어갈까…외국인 매수세", "저가 매수 기회 왔다", "코스피 강세 지속될 듯", "다음주 증시 체크포인트", "내주 FOMC 촉각", "반도체 비중 확대 필요"]) expect(blockedTitle(t), t).toBe(true);
    // 사실을 적은 제목은 그대로 둔다 ('까지'·'내주며'·'순매수')
    for (const t of ["반도체까지 오름세 넓어져", "시총 1위 자리 내주며 하락", "외국인 순매수에 코스피 0.9% 상승 마감"]) expect(blockedTitle(t), t).toBe(false);
    expect(titleDays("[뉴욕증시 23일] 금리 부담에 하락")).toEqual([23]);
    expect(titleDays("25일(현지시간) 뉴욕증시 상승")).toEqual([25]);
    expect(titleDays("이란 7일 계획에 유가 하락")).toEqual([]); // 날짜가 아닌 '7일'
    expect(newsDays("KR", "2026-09-23")).toEqual([23]);
    const picked = pickNews(items(), { from: "2026-09-25T19:00:00.000Z", to: "2026-09-26T05:00:00.000Z", days: [25, 26] });
    expect(picked.some((n) => /23일|살까|전망|목표가/.test(n.title))).toBe(false);
  });
});

describe("세션 날짜·휴장 판단 (네이버 장 상태 → 토스 달력 → 휴장일 목록, 다르면 휴장 쪽)", () => {
  it("녹화한 네이버 장 상태: 오늘 거래일 여부·평일 휴장·휴장 이름·직전/다음 거래일", async () => {
    const f = (async () => new Response(fixture("naver-market-status-0926.json"), { status: 200 })) as unknown as typeof fetch;
    const st = await new NaverDiscover(f).marketStatus();
    expect(st.KR).toMatchObject({ isTradingDay: false, today: { date: "2026-09-26", isWeekdayHoliday: false, holidayDescription: null }, latest: { tradeBaseAt: "2026-09-23" }, next: { tradeBaseAt: "2026-09-28" } });
    expect(st.US?.latest.tradeBaseAt).toBe("2026-09-25");
  });

  it("아침: 월요일은 금요일 장(주말 이틀 휴장), 추수감사절 다음 날은 11/25 값, 노동절 다음 날은 9/4 값", () => {
    expect(resolveDates({ session: "morning", date: "2026-09-28" })).toMatchObject({ marketDate: "2026-09-25", basisDate: "2026-09-25", holiday: null, weekendGap: true });
    expect(resolveDates({ session: "morning", date: "2026-09-25" })).toMatchObject({ marketDate: "2026-09-24", basisDate: "2026-09-24", holiday: null, weekendGap: false });
    expect(resolveDates({ session: "morning", date: "2026-11-27" })).toMatchObject({ marketDate: "2026-11-26", basisDate: "2026-11-25", holiday: { date: "2026-11-26", name: "추수감사절" } });
    expect(resolveDates({ session: "morning", date: "2026-09-08" })).toMatchObject({ marketDate: "2026-09-07", basisDate: "2026-09-04", holiday: { name: "노동절" } });
  });

  it("오후: 네이버가 휴장이라 하면 그 이름·직전 거래일, 네이버를 못 받아도 목록(KR_HOLIDAYS)으로, 출처가 다르면 휴장 쪽 + 경고", () => {
    const naver = (date: string, trading: boolean, desc: string | null, latest: string) => ({ todayDate: date, isTradingDay: trading, isWeekdayHoliday: !trading, holidayDescription: desc, latestTradeBaseAt: latest });
    expect(resolveDates({ session: "afternoon", date: "2026-09-25", kr: naver("2026-09-25", false, "추석", "2026-09-23") })).toMatchObject({ basisDate: "2026-09-23", holiday: { date: "2026-09-25", name: "추석" }, conflicts: [] });
    expect(resolveDates({ session: "afternoon", date: "2026-09-25", kr: null, calendarTrading: null })).toMatchObject({ basisDate: "2026-09-23", holiday: { name: "추석" } });
    const disagree = resolveDates({ session: "afternoon", date: "2026-09-25", kr: naver("2026-09-25", true, null, "2026-09-25") });
    expect(disagree.holiday).not.toBeNull();
    expect(disagree.conflicts[0]).toContain("휴장으로 봄");
    const unlisted = resolveDates({ session: "afternoon", date: "2026-09-30", kr: naver("2026-09-30", false, "임시 휴장", "2026-09-29") });
    expect(unlisted).toMatchObject({ basisDate: "2026-09-29", holiday: { name: "임시 휴장" } });
    expect(unlisted.conflicts[0]).toContain("목록 확인 필요");
    // 다른 날의 네이버 값(자정 무렵 받은 값)은 쓰지 않는다
    expect(resolveDates({ session: "afternoon", date: "2026-09-23", kr: naver("2026-09-22", false, "x", "2026-09-21") })).toMatchObject({ basisDate: "2026-09-23", holiday: null });
    // 주말(평일만 돌기를 끈 경우)은 휴장 줄 없이 날짜만 직전 거래일로
    expect(resolveDates({ session: "afternoon", date: "2026-09-26" })).toMatchObject({ basisDate: "2026-09-23", holiday: null });
  });

  it("장중·잠정 라벨과 조기 폐장: 수능일 16:00 은 장중, 미국 겨울 07:00 은 최종값 전, 11/27 은 13:00 ET 마감", () => {
    expect(phaseOf("KR", "2026-11-19", at("2026-11-19T16:00:00+09:00"))).toBe("intraday");
    expect(phaseOf("KR", "2026-09-23", at("2026-09-23T16:00:00+09:00"))).toBe("final");
    expect(phaseOf("KR", "2026-09-23", at("2026-09-23T15:00:00+09:00"))).toBe("intraday"); // 사용자가 오후 브리핑을 앞당긴 경우
    expect(phaseOf("US", "2026-09-25", at("2026-09-26T06:30:00+09:00"))).toBe("final"); // 서머타임 최종값 06:15
    expect(phaseOf("US", "2026-11-30", at("2026-12-01T07:00:00+09:00"))).toBe("prelim"); // 표준시 최종값 07:15
    expect(phaseOf("US", "2026-09-25", at("2026-09-26T04:00:00+09:00"))).toBe("intraday");
    expect(sessionClose("US", "2026-11-27")).toMatchObject({ time: "13:00", early: true });
    expect(sessionClose("KR", "2026-11-19")).toMatchObject({ time: "16:30" });
    const d = { market: "US" as const, holiday: null, basisDate: "2026-11-27", weekendGap: false, earlyClose: true, closeTime: "13:00", phase: "final" as const, asOf: "2026-11-28T08:30:00+09:00" };
    expect(basisText(d, at("2026-11-28T08:31:00+09:00"))).toBe("11/27(금) 뉴욕 장 마감 기준 (조기 폐장 13:00 ET)");
    expect(basisText({ ...d, basisDate: "2026-11-30", earlyClose: false, closeTime: "16:00", phase: "prelim", asOf: "2026-12-01T07:00:00+09:00" }, at("2026-12-01T07:01:00+09:00"))).toBe("11/30(월) 뉴욕 장 마감 직후 값 · 최종값 확정 전");
  });
});

describe("일정 (정적 목록 · 24시간 안 · 가까운 순 2개)", () => {
  const line = (iso: string, withinOverride?: (e: ReturnType<typeof upcomingEvents>) => ReturnType<typeof upcomingEvents>["within"]) => {
    const e = upcomingEvents(at(iso));
    return eventsText({ events: { within: withinOverride ? withinOverride(e) : e.within, next: e.next, unknown: e.unknown } }, at(iso));
  };

  it("사양 예시: 고용보고서·FOMC(한국 시간 변환)·한은 오전·한국 휴장(대체공휴일)·추석 연휴와 다음 개장", () => {
    expect(line("2026-10-02T08:30:00+09:00")).toBe("일정 · 오늘 21:30 미국 9월 고용보고서 발표");
    expect(line("2026-10-28T08:30:00+09:00")).toBe("일정 · 10/29(목) 03:00 미국 금리 결정(FOMC) 발표");
    expect(line("2026-10-21T16:00:00+09:00")).toBe("일정 · 10/22(목) 오전 한국은행 기준금리 결정");
    expect(line("2026-10-05T08:30:00+09:00")).toBe("일정 · 오늘 한국 휴장(개천절 대체공휴일)");
    expect(line("2026-09-23T16:00:00+09:00")).toBe("일정 · 9/24~9/25 추석 연휴 한국 휴장 · 다음 개장 9/28(월)");
    expect(line("2026-10-14T08:30:00+09:00")).toBe("일정 · 오늘 21:30 미국 9월 소비자물가(CPI) 발표");
    expect(line("2026-11-10T08:30:00+09:00")).toBe("일정 · 오늘 22:30 미국 10월 소비자물가(CPI) 발표"); // 표준시
    expect(line("2026-12-09T08:30:00+09:00")).toBe("일정 · 12/10(목) 04:00 미국 금리 결정(FOMC) 발표");
    expect(line("2026-11-18T16:00:00+09:00")).toBe("일정 · 11/19(목) 한국 수능일 10:00 개장, 16:30 마감");
    expect(line("2026-09-28T08:30:00+09:00")).toBeNull(); // 24시간 안에 없음
    expect(upcomingEvents(at("2026-09-28T08:30:00+09:00")).next).toMatchObject({ kind: "jobs", date: "2026-10-02", time: "21:30" });
    // 한국 휴장일 오후: 다음 개장(시각까지)
    expect(eventsText({ events: { within: [nextOpenEvent("2026-09-25")], next: null, unknown: [] } }, at("2026-09-25T16:00:00+09:00"))).toBe("일정 · 다음 개장 9/28(월) 09:00");
    expect(nextOpenEvent("2026-12-31")).toMatchObject({ date: "2027-01-04", time: "10:00" }); // 새해 첫 거래일 10:00 개장
  });

  it("목록이 끝난 종류는 '모름'으로 빼고(틀린 일정보다 없는 일정), 종류별 마지막 날짜를 알려 준다", () => {
    expect(eventsCoverage()).toMatchObject({ fomc: "2028-01-26", cpi: "2026-12-10", jobs: "2026-12-04", bok: "2026-11-26" });
    const late = upcomingEvents(at("2026-12-11T08:30:00+09:00"));
    expect(late.unknown).toEqual(["cpi", "jobs", "bok"]);
    expect(late.within.some((e) => e.kind === "cpi" || e.kind === "jobs" || e.kind === "bok")).toBe(false);
  });

  it("해마다 새로 넣기: 12/1 이후에는 다음 해 FOMC·한은 목록이 있어야 하고, BLS 는 다음 해 1/15 까지 유예", () => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const has = (kind: string, year: number) => MARKET_EVENTS.some((e) => e.kind === kind && e.localDate.startsWith(String(year)));
    if (now.getUTCMonth() === 11) {
      expect(has("fomc", y + 1), `연준 ${y + 1}년 일정을 marketEvents.ts 에 넣어 주세요`).toBe(true);
      expect(has("bok", y + 1), `한은 ${y + 1}년 일정을 marketEvents.ts 에 넣어 주세요`).toBe(true);
    }
    if (now.getUTCMonth() > 0 || now.getUTCDate() >= 15) {
      expect(has("cpi", y) || y < 2027, `BLS ${y}년 CPI 일정을 넣어 주세요`).toBe(true);
      expect(has("jobs", y) || y < 2027, `BLS ${y}년 고용 일정을 넣어 주세요`).toBe(true);
    }
  });
});

describe("줄 수 상한 (최대 6줄, 넘치면 뉴스 → 일정 → 업종 순으로 뺀다)", () => {
  const L = (kind: SummaryLine["kind"]): SummaryLine => ({ kind, text: kind });
  it("7줄이면 뉴스를, 뉴스가 없으면 일정을 뺀다 (보이는 순서는 그대로)", () => {
    const seven = ["holiday", "indices", "rates", "sectors", "holdings", "events", "news"].map((k) => L(k as SummaryLine["kind"]));
    expect(fitLines(seven).map((l) => l.kind)).toEqual(["holiday", "indices", "rates", "sectors", "holdings", "events"]);
    expect(fitLines([...seven.slice(0, 6), L("rates")].filter((l) => l.kind !== "news")).map((l) => l.kind)).toEqual(["holiday", "indices", "rates", "sectors", "holdings", "rates"]);
    expect(fitLines(seven.slice(0, 5)).map((l) => l.kind)).toEqual(["holiday", "indices", "rates", "sectors", "holdings"]);
  });

  it("추수감사절 다음 날 아침에 뉴스까지 있으면 7줄 → 뉴스를 빼 6줄", () => {
    const c = shared.cases.find((x) => x.name.includes("추수감사절"))!;
    const withNews: MarketSummaryData = { ...c.data, news: { ...c.data.news, fresh: true } };
    const lines = summaryLines(withNews, at("2026-11-27T08:31:00+09:00"));
    expect(lines).toHaveLength(6);
    expect(lines.some((l) => l.kind === "news")).toBe(false);
    expect(lines.some((l) => l.kind === "events")).toBe(true);
  });
});

describe("쓰지 않는 말 (평가·권유·원인·전망)", () => {
  it("요약 줄·알림 첫 줄·보조 줄에 평가·권유·원인 낱말이 없다", () => {
    const banned = /(선방|부진|아쉬|기회|주의|과매도|과매수|때문|추천|매수|매도|전망|유망|강세|약세|호재|악재)/;
    for (const c of shared.cases) {
      const texts = [...summaryLines(c.data, at(c.digest.at)).map((l) => l.text), digestLine(c.data, at(c.digest.at)) ?? "", c.data.holdings ? holdingsAux(c.data.holdings) : ""];
      // 뉴스 제목은 언론사 원문이라 요약 줄에 넣지 않는다 (카드·상세의 뉴스 칸에 언론사·시각과 함께 인용)
      for (const t of texts) expect(t, t).not.toMatch(banned);
    }
  });
});

describe("세션 알림 첫 줄 (digest.ts — 세션당 1건 그대로, 제목·다른 줄은 그대로)", () => {
  const items: DigestItem[] = [
    { briefingId: 11, code: "RGTX", name: "리게티 컴퓨팅", summary: "요약", changeRate: -8.06 },
    { briefingId: 12, code: "NVDA", name: "엔비디아", summary: "요약", changeRate: 1.82 },
  ];
  const account: DigestAccount = { id: 7, dayPnl: 423_788, dayRate: 0.6, top: [{ name: "마이크로소프트", amount: 148_403 }], krPreviousDay: true, usPreviousDay: true };
  const us = { id: 3, line: "밤사이 미국 나스닥 +0.48% · S&P500 +0.51% · 내 미국 12종목 중 지수보다 높음 2 · 낮음 3", market: "US" as const, holiday: false };

  it("계좌 앞머리 알림: 첫 줄에 요약, 제목 그대로, data 에 marketSummaryId", () => {
    const m = buildDigest("morning", "2026-09-28", items, account, us)!;
    expect(m.title).toBe("오전 계좌 브리핑 · 당일 +423,788원 (+0.60%)");
    expect(m.body.split("\n")[0]).toBe(us.line);
    expect(m.body.split("\n")[1]).toBe("기여 1위 마이크로소프트 +148,403원");
    expect(m.data).toMatchObject({ accountBriefingId: 7, marketSummaryId: 3 });
    // 첫 줄이 미국(휴장 아님)이면 두 휴장 줄은 그대로 (9/24 아침: 한국 휴장 줄을 남긴다)
    expect(m.body).toContain(KR_PREVIOUS_DAY_LINE);
    expect(m.body).toContain(US_PREVIOUS_DAY_LINE);
  });

  it("첫 줄이 같은 시장의 휴장을 말하면 그 시장의 예전 휴장 줄만 뺀다", () => {
    const kr = { id: 4, line: "오늘 한국 휴장(추석) · 코스피 +0.90% · 코스닥 +1.21% (9/23 기준)", market: "KR" as const, holiday: true };
    const m = buildDigest("afternoon", "2026-09-25", items, account, kr)!;
    expect(m.body).not.toContain(KR_PREVIOUS_DAY_LINE);
    expect(m.body).toContain(US_PREVIOUS_DAY_LINE);
    const usHoliday = buildDigest("morning", "2026-11-27", items, account, { ...us, holiday: true })!;
    expect(usHoliday.body).not.toContain(US_PREVIOUS_DAY_LINE);
    expect(usHoliday.body).toContain(KR_PREVIOUS_DAY_LINE);
  });

  it("계좌 브리핑이 없는 알림(1종목·여러 종목)에도 첫 줄, 요약만으로는 알림을 만들지 않는다, 없으면 예전 그대로", () => {
    const one = buildDigest("morning", "2026-09-28", items.slice(0, 1), null, us)!;
    expect(one.title).toBe("리게티 컴퓨팅 오전 브리핑");
    expect(one.body).toBe(`${us.line}\n요약`);
    const many = buildDigest("morning", "2026-09-28", items, null, us)!;
    expect(many.title).toBe("오전 브리핑 2종목");
    expect(many.body.split("\n")[0]).toBe(us.line);
    expect(many.data).toMatchObject({ marketSummaryId: 3, briefingId: 11 });
    expect(buildDigest("afternoon", "2026-12-25", [], null, us)).toBeNull();
    expect(buildDigest("morning", "2026-09-28", items, null, null)).toEqual(buildDigest("morning", "2026-09-28", items, null));
  });
});

// ── 서비스·경로 (가짜 출처 — 네트워크 없음) ─────────────────────────

class RecordingPush implements PushSender {
  readonly name = "recording";
  sent: PushMessage[] = [];
  isValidToken(): boolean {
    return true;
  }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    return { results: tokens.map((token) => ({ token, ok: true, error: null, receiptId: null })) };
  }
  async checkReceipts() {
    return [];
  }
}

const TOKEN = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

/** 출처별 호출 수를 세는 가짜 출처 묶음 (녹화한 응답으로 답한다) */
function fakeSources(o: { session: "morning" | "afternoon"; krToday?: { date: string; trading: boolean; desc: string | null; latest: string }; slowMs?: number; krSec?: { note: string | null; asOf?: string | null } } ) {
  const calls: Record<string, number> = {};
  const count = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const naverUs = new NaverDiscover(pollingFetch("naver-us-quotes.json", "reutersCode"));
  const naverKr = new NaverDiscover(pollingFetch("naver-kr-quotes.json", "itemCode"));
  const us = (code: string, name: string, v: number, rate: number, t: string): MarketIndex => ({ code, name, kind: "index", value: v, change: 1, changeRate: rate, open: false, asOf: t, stale: false });
  const indices: MarketIndex[] =
    o.session === "morning"
      ? [us("NASDAQ", "나스닥", 27068.72, 0.48, "2026-09-25T17:15:00-04:00"), us("SPX", "S&P500", 7743.41, 0.51, "2026-09-25T16:39:00-04:00"), us("DJI", "다우", 51828.62, 0.93, "2026-09-25T17:05:00-04:00"), us("SOX", "필라반도체", 12668.93, 1.41, "2026-09-25T17:15:00-04:00")]
      : [us("KOSPI", "코스피", 7080.92, 0.9, "2026-09-23T20:15:00+09:00"), us("KOSDAQ", "코스닥", 844.48, 1.21, "2026-09-23T20:15:00+09:00")];
  indices.push({ code: "USDKRW", name: "원/달러", kind: "fx", value: 1359, change: 3.5, changeRate: 0.26, open: true, asOf: "2026-09-26T05:45:27+09:00", stale: false });
  const slow = <T,>(v: T) => (o.slowMs ? new Promise<T>((r) => setTimeout(() => r(v), o.slowMs)) : Promise.resolve(v));
  const kt = o.krToday ?? { date: "2026-09-23", trading: true, desc: null, latest: "2026-09-23" };
  const src: MarketSummarySources = {
    indices: async () => (count("indices"), indices),
    fxDaily: async () => (count("fxDaily"), [{ date: "2026-09-22" }, { date: "2026-09-23" }]),
    exchangeStatus: async () => {
      count("exchangeStatus");
      const session = { kind: "closed" as const, label: "", openAt: null, closeAt: null, tradeBaseAt: kt.latest };
      return { KR: { latest: session, next: null, isTradingDay: kt.trading, today: { date: kt.date, isWeekdayHoliday: !kt.trading, holidayDescription: kt.desc } } };
    },
    isTradingDate: async () => (count("isTradingDate"), true),
    treasuryCsv: async () => (count("treasury"), fixture("treasury-2026.csv")),
    naverBond: async () => (count("naverBond"), JSON.parse(fixture("naver-us10y.json"))),
    usQuotes: async (codes) => (count("usQuotes"), naverUs.usQuotes(codes)),
    krQuotes: async (codes) => (count("krQuotes"), naverKr.krQuotes(codes)),
    krSectors: async () => {
      count("krSectors");
      const t = (name: string, changeRate: number, n: number) => ({ id: name, name, changeRate, up: n, flat: 0, down: 0 });
      return { themes: [t("석유와가스", 3.13, 18), t("반도체와반도체장비", 2.8, 90), t("은행", 0.3, 10), t("철강", -2.92, 54), t("건설", -4.19, 72)], note: o.krSec?.note ?? null, asOf: o.krSec?.asOf ?? null };
    },
    news: async (q) => {
      count("news");
      return slow(q === "뉴욕증시" ? parseGoogleRss(fixture("google-news-sample.xml")) : ([] as NewsItem[]));
    },
    holdings: async () => {
      count("holdings");
      return [
        { code: "MSFT", name: "마이크로소프트", market: "NASDAQ", quantity: 3, groupCode: null },
        { code: "NVDA", name: "엔비디아", market: "NASDAQ", quantity: 10, groupCode: null },
        { code: "JPM", name: "JP모건", market: "NYSE", quantity: 2, groupCode: null },
        { code: "KO", name: "코카콜라", market: "NYSE", quantity: 5, groupCode: null },
        { code: "TQQQ", name: "TQQQ", market: "NASDAQ", quantity: 1, groupCode: null },
        { code: "AAPL", name: "애플(관심)", market: "NASDAQ", quantity: null, groupCode: null },
        { code: "005930", name: "삼성전자", market: "KOSPI", quantity: 10, groupCode: "ST" },
        { code: "035420", name: "NAVER", market: "KOSPI", quantity: 3, groupCode: "ST" },
        { code: "133690", name: "TIGER 미국나스닥100", market: "KOSPI", quantity: 2, groupCode: "EF" },
      ];
    },
  };
  return { src, calls };
}

const tradingCalendar = {
  status: async (): Promise<MarketStatus> => ({
    now: "",
    KR: { market: "KR", isTradingDay: true, isOpen: false, opensAt: null, closesAt: null, source: "toss" },
    US: { market: "US", isTradingDay: true, isOpen: false, opensAt: null, closesAt: null, source: "toss" },
  }),
  isTradingDay: async () => true,
  isTradingDate: async () => true,
};
const closedCalendar = {
  status: async (): Promise<MarketStatus> => ({
    now: "",
    KR: { market: "KR", isTradingDay: false, isOpen: false, opensAt: null, closesAt: null, source: "toss" },
    US: { market: "US", isTradingDay: false, isOpen: false, opensAt: null, closesAt: null, source: "toss" },
  }),
  isTradingDay: async () => false,
  isTradingDate: async () => false,
};

describe("시장 요약 서비스·경로 (가짜 출처, 고정 시계)", () => {
  let app: FastifyInstance | null = null;
  let db: Db | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
    await db?.destroy();
    db = null;
  });

  const setup = async (o: { now: string; session: "morning" | "afternoon"; calendar?: unknown; krToday?: Parameters<typeof fakeSources>[0]["krToday"]; krSec?: Parameters<typeof fakeSources>[0]["krSec"] }) => {
    db = await createMigratedDb(":memory:");
    const push = new RecordingPush();
    const { src, calls } = fakeSources({ session: o.session, ...(o.krToday ? { krToday: o.krToday } : {}), ...(o.krSec ? { krSec: o.krSec } : {}) });
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ push, marketSummary: src, calendar: (o.calendar ?? tradingCalendar) as never, search: new FakeSearchProvider([SAMPLE_MASTER[1]!]), indices: fakeIndices(undefined, () => at(o.now)) }),
      logger: false,
      enableScheduler: false,
      receiptDelayMs: 0,
      now: () => at(o.now),
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    // 관심 종목 하나 (수량 없음 → 계좌 브리핑은 없고 종목 브리핑 알림 1건)
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN, platform: "android" } });
    return { push, calls };
  };

  it("월요일 아침 예약 실행: 요약 1건 저장, 세션 알림 본문 첫 줄에 '금요일(9/25) 미국 …', 목록·최신·한 건 조회", async () => {
    const { push, calls } = await setup({ now: "2026-09-28T08:30:05+09:00", session: "morning" });
    await app!.briefingService.runSession("morning", { trigger: "schedule" });
    expect(push.sent).toHaveLength(1);
    const [first, ...rest] = push.sent[0]!.body.split("\n");
    expect(first).toBe("금요일(9/25) 미국 나스닥 +0.48% · S&P500 +0.51% · 내 미국 4종목 중 지수보다 높음 1 · 낮음 0");
    // 둘째 줄부터는 예전 알림 본문 그대로 (종목 브리핑 요약)
    const latestSummary = ((await app!.inject({ method: "GET", url: "/api/briefings/latest" })).json() as Array<{ latest: { summary: string } }>)[0]!.latest.summary;
    expect(rest.join("\n")).toBe(latestSummary);
    expect(push.sent[0]!.title).toBe("삼성전자 오전 브리핑");
    const list = (await app!.inject({ method: "GET", url: "/api/market-summaries" })).json() as Array<{ id: number; status: string; market: string; data: MarketSummaryData }>;
    expect(list).toHaveLength(1);
    const d = list[0]!.data;
    expect(list[0]).toMatchObject({ status: "ok", market: "US", session: "morning", date: "2026-09-28" });
    expect(d).toMatchObject({ marketDate: "2026-09-25", basisDate: "2026-09-25", weekendGap: true, phase: "final", holiday: null });
    expect(d.yield10y).toMatchObject({ value: 5.17, change: -0.01, source: "treasury" });
    expect(d.fx).toMatchObject({ value: 1359, date: "2026-09-23" });
    expect(d.sectors?.strong.map((s) => s.name)).toEqual(["산업재", "기술"]);
    expect(d.holdings).toMatchObject({ compared: 4, excluded: { leverage: ["TQQQ"] } });
    expect(d.news.items.map((n) => n.outlet)).toEqual(["뉴스1", "KBS", "한국경제"]);
    expect(summaryLines(d, at("2026-09-28T08:31:00+09:00")).map((l) => l.text)).toEqual([
      "나스닥 +0.48% · S&P500 +0.51% · 다우 +0.93% · 필라반도체 +1.41%",
      "원/달러 1,359.00원 +3.50원 (9/23 고시) · 미 10년물 5.17% -0.01%p (미 재무부)",
      "강한 업종 산업재 +0.95% · 기술 +0.80% / 약한 업종 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)",
      "내 미국 4종목 · 지수보다 높음 1 (마이크로소프트 +3.66%, 지수와 차이 +3.18%p) · 낮음 0 · 비슷 3",
      "뉴스 3건 · 뉴스1 9/26 05:32 · KBS 9/26 05:22 · 한국경제 9/26 05:38",
    ]);
    // 재무부 값이 있으면 네이버 대체는 부르지 않는다. 한국 시세·업종은 아침에 부르지 않는다. 섹터 ETF 와 보유 종목은 한 번에
    expect(calls).toMatchObject({ treasury: 1, usQuotes: 1, news: 1 });
    expect(calls["naverBond"]).toBeUndefined();
    expect(calls["krQuotes"]).toBeUndefined();
    expect(calls["krSectors"]).toBeUndefined();
    const latest = (await app!.inject({ method: "GET", url: "/api/market-summaries/latest" })).json();
    expect(latest.id).toBe(list[0]!.id);
    expect((await app!.inject({ method: "GET", url: `/api/market-summaries/${list[0]!.id}` })).json().data.basisDate).toBe("2026-09-25");
    expect((await app!.inject({ method: "GET", url: "/api/market-summaries/999" })).statusCode).toBe(404);
    expect((await app!.inject({ method: "GET", url: "/api/market-summaries/abc" })).statusCode).toBe(400);
    // 이미 있으면 다시 부르지 않는다 (예약 실행이 한 번 더 돌아도 출처 호출 0)
    const before = { ...calls };
    await app!.marketSummaries!.afterRun({ session: "morning", date: "2026-09-28", partial: false });
    expect(calls).toEqual(before);
    // 수동 전체 실행(force)은 다시 만든다
    await app!.marketSummaries!.afterRun({ session: "morning", date: "2026-09-28", partial: false, force: true });
    expect(calls["indices"]).toBe((before["indices"] ?? 0) + 1);
    // 일부 종목 실행('이 종목 다시 만들기')은 만들지 않는다
    expect(await app!.marketSummaries!.afterRun({ session: "morning", date: "2026-09-28", partial: true, force: true })).toBeNull();
    // /health 에 일정 목록 범위
    expect((await app!.inject({ method: "GET", url: "/health" })).json().marketSummary).toMatchObject({ enabled: true, eventsCoverage: { fomc: "2028-01-26" } });
  });

  it("오후: 한국 KRX 정규장 종가(녹화)로 코스피·코스닥 비교, 해외 지수 ETF 는 빼고, 업종은 네이버 거래일을 확인해 넣는다", async () => {
    const { push, calls } = await setup({ now: "2026-09-23T16:00:10+09:00", session: "afternoon" });
    await app!.briefingService.runSession("afternoon", { trigger: "schedule" });
    const d = ((await app!.inject({ method: "GET", url: "/api/market-summaries/latest" })).json() as { data: MarketSummaryData }).data;
    expect(d).toMatchObject({ market: "KR", basisDate: "2026-09-23", holiday: null, yield10y: null, closeTime: "15:30" });
    expect(holdingsText(d)).toBe("내 국내 2종목 · 지수보다 높음 1 (삼성전자 +3.62%, 지수와 차이 +2.72%p) · 낮음 1 (NAVER -2.49%, 차이 -3.39%p) · 비슷 0");
    expect(d.holdings?.excluded.overseas).toEqual(["TIGER 미국나스닥100"]);
    expect(d.sectors?.strong.map((s) => s.name)).toEqual(["석유와가스", "반도체와반도체장비"]);
    expect(eventsText(d, at("2026-09-23T16:01:00+09:00"))).toBe("일정 · 9/24~9/25 추석 연휴 한국 휴장 · 다음 개장 9/28(월)");
    expect(push.sent[0]!.body.split("\n")[0]).toBe("오늘 한국 코스피 +0.90% · 코스닥 +1.21% · 내 국내 2종목 중 지수보다 높음 1 · 낮음 1");
    // 오후는 재무부·섹터 ETF 를 부르지 않는다. 뉴스는 '코스피 마감' 다음 '코스피'까지 (3건이 차지 않아서)
    expect(calls["treasury"]).toBeUndefined();
    expect(calls["usQuotes"]).toBeUndefined();
    expect(calls["news"]).toBe(2);
  });

  it("오후: 발견 탭이 출처가 비운 시간이라 전날 저장본을 주면 업종 줄을 뺀다 (전날 업종이 오늘 업종처럼 보이지 않게)", async () => {
    await setup({ now: "2026-09-23T16:00:10+09:00", session: "afternoon", krSec: { note: "출처가 잠시 값을 비워 저장해 둔 직전 값을 보여 줍니다", asOf: "2026-09-22T15:30:00+09:00" } });
    await app!.briefingService.runSession("afternoon", { trigger: "schedule" });
    const d = ((await app!.inject({ method: "GET", url: "/api/market-summaries/latest" })).json() as { data: MarketSummaryData }).data;
    expect(d.sectors).toBeNull();
    expect(d.notes.some((n) => n.includes("업종 줄을 뺌"))).toBe(true);
    expect(summaryLines(d, at("2026-09-23T16:01:00+09:00")).some((l) => l.kind === "sectors")).toBe(false);
  });

  it("오후: 같은 날 저장본이면 업종 줄을 그대로 넣는다", async () => {
    await setup({ now: "2026-09-23T16:00:10+09:00", session: "afternoon", krSec: { note: "출처가 잠시 값을 비워 저장해 둔 직전 값을 보여 줍니다", asOf: "2026-09-23T15:30:00+09:00" } });
    await app!.briefingService.runSession("afternoon", { trigger: "schedule" });
    const d = ((await app!.inject({ method: "GET", url: "/api/market-summaries/latest" })).json() as { data: MarketSummaryData }).data;
    expect(d.sectors?.strong.map((s) => s.name)).toEqual(["석유와가스", "반도체와반도체장비"]);
  });

  it("한국 휴장 오후(추석): 네이버 장 상태로 휴장 이름·직전 거래일, 뉴스 줄은 빼고 다음 개장, 두 시장 모두 쉬면 알림 0건이지만 요약은 저장", async () => {
    const { push } = await setup({ now: "2026-09-25T16:00:10+09:00", session: "afternoon", calendar: closedCalendar, krToday: { date: "2026-09-25", trading: false, desc: "추석", latest: "2026-09-23" } });
    const r = await app!.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(r.results.every((x) => x.status === "skipped")).toBe(true);
    expect(push.sent).toHaveLength(0);
    const d = ((await app!.inject({ method: "GET", url: "/api/market-summaries/latest" })).json() as { data: MarketSummaryData }).data;
    expect(d).toMatchObject({ holiday: { date: "2026-09-25", name: "추석" }, basisDate: "2026-09-23", news: { fresh: false } });
    const lines = summaryLines(d, at("2026-09-25T16:01:00+09:00")).map((l) => l.text);
    expect(lines[0]).toBe("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
    expect(lines).toContain("일정 · 다음 개장 9/28(월) 09:00");
    expect(lines.some((l) => l.startsWith("뉴스"))).toBe(false);
  });

  it("플래그를 끄면: 출처 호출 0, 목록은 빈 목록·한 건은 404, 알림 본문은 예전 그대로", async () => {
    const { push, calls } = await setup({ now: "2026-09-28T08:30:05+09:00", session: "morning" });
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { marketSummary: false } });
    await app!.briefingService.runSession("morning", { trigger: "schedule" });
    expect(calls).toEqual({});
    expect((await app!.inject({ method: "GET", url: "/api/market-summaries" })).json()).toEqual([]);
    expect((await app!.inject({ method: "GET", url: "/api/market-summaries/latest" })).statusCode).toBe(404);
    expect((await app!.inject({ method: "GET", url: "/api/market-summaries/1" })).statusCode).toBe(404);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.body).not.toMatch(/미국|나스닥/);
    expect((await app!.inject({ method: "GET", url: "/api/features" })).json().features.marketSummary).toBe(false);
  });

  it("늦으면(제한 시간) 알림은 첫 줄 없이 가고, 요약은 뒤에서 마저 만들어 저장한다", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src } = fakeSources({ session: "morning", slowMs: 120 });
      const svc = new MarketSummaryService({ db: dbx, sources: src, features: { enabled: async () => true }, now: () => at("2026-09-28T08:30:05+09:00") });
      expect(await svc.afterRun({ session: "morning", date: "2026-09-28", partial: false }, { waitMs: 30 })).toBeNull();
      expect(svc.isRunning).toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      expect(svc.isRunning).toBe(false);
      const saved = await svc.find("2026-09-28", "morning");
      expect(saved?.status).toBe("ok");
      // 출처 하나가 멈추면 그 출처만 빠진다 (제한 시간)
      const stuck = { ...src, news: () => new Promise<NewsItem[]>(() => undefined) };
      const svc2 = new MarketSummaryService({ db: dbx, sources: stuck, features: { enabled: async () => true }, now: () => at("2026-09-29T08:30:05+09:00"), sourceTimeoutMs: 50 });
      const r = await svc2.generate("morning", { date: "2026-09-29" });
      expect(r?.data?.news.items).toEqual([]);
      expect(r?.data?.notes.some((n) => n.includes("뉴스(뉴욕증시)를 받지 못함"))).toBe(true);
    } finally {
      await dbx.destroy();
    }
  });

  it("장중에 만든 요약(수능일 15:00 수동 실행 등)은 마감 뒤 예약 실행이 확정 값으로 다시 만들고, 확정 뒤에는 다시 부르지 않는다", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src, calls } = fakeSources({ session: "afternoon", krToday: { date: "2026-11-19", trading: true, desc: null, latest: "2026-11-19" } });
      const t = { now: at("2026-11-19T15:00:00+09:00") };
      const kr = (code: string, name: string, rate: number): MarketIndex => ({ code, name, kind: "index", value: 100, change: 1, changeRate: rate, open: true, asOf: "2026-11-19T15:00:00+09:00", stale: false });
      const svc = new MarketSummaryService({ db: dbx, sources: { ...src, indices: async () => (calls["indices"] = (calls["indices"] ?? 0) + 1, [kr("KOSPI", "코스피", 0.5), kr("KOSDAQ", "코스닥", -0.2)]) }, features: { enabled: async () => true }, now: () => t.now });
      const early = await svc.generate("afternoon", { date: "2026-11-19" });
      expect(early?.data).toMatchObject({ phase: "intraday", closeTime: "16:30" });
      expect(basisText(early!.data!, t.now)).toBe("장중 값(15:00 기준) · 오늘 16:30 마감");
      t.now = at("2026-11-19T16:40:00+09:00");
      const late = await svc.afterRun({ session: "afternoon", date: "2026-11-19", partial: false });
      expect(late?.data?.phase).toBe("final");
      expect(calls["indices"]).toBe(2);
      await svc.afterRun({ session: "afternoon", date: "2026-11-19", partial: false });
      expect(calls["indices"]).toBe(2);
    } finally {
      await dbx.destroy();
    }
  });

  it("지수를 하나도 못 받으면 '생성 실패'로 저장하고 알림 첫 줄은 없다", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src } = fakeSources({ session: "morning" });
      const svc = new MarketSummaryService({ db: dbx, sources: { ...src, indices: async () => [] }, features: { enabled: async () => true }, now: () => at("2026-09-28T08:30:05+09:00") });
      const r = await svc.generate("morning", { date: "2026-09-28" });
      expect(r).toMatchObject({ status: "failed", summary: "지수를 받지 못해 시장 요약을 만들지 못했습니다" });
      expect(digestMarket(r, at("2026-09-28T08:31:00+09:00"))).toBeNull();
      expect(await svc.afterRun({ session: "morning", date: "2026-09-28", partial: false, force: true })).toBeNull();
    } finally {
      await dbx.destroy();
    }
  });

  it("기본 출처: 구글 뉴스는 질의마다 10분 캐시, 503 은 한 번 다시, 시간 초과는 다시 부르지 않는다", async () => {
    let n = 0;
    let asked = 0;
    const news = {
      // 구글 RSS 는 최신 순이라 넉넉히(100) 받는다 — 40개면 장 마감 직후 기사가 잘렸다 (2026-09-26 실제 출처로 확인)
      search: async (_q: string, limit: number) => {
        asked = limit;
        n++;
        if (n === 1) throw new Error("HTTP 503");
        return [{ title: "t", url: "u", source: "s", publishedAt: "2026-09-25T20:00:00Z", summary: null }];
      },
    };
    const t = { now: Date.parse("2026-09-28T08:30:00+09:00") };
    const s = defaultSummarySources({ db: {} as Db, indices: { list: async () => [], candles: async () => null }, naver: {} as never, calendar: { isTradingDate: async () => true }, krSectors: async () => ({ themes: [], note: null }), news, now: () => t.now, retryDelayMs: 1 });
    expect(await s.news("뉴욕증시")).toHaveLength(1);
    expect(n).toBe(2);
    expect(asked).toBe(100);
    await s.news("뉴욕증시");
    expect(n).toBe(2); // 캐시
    t.now += 11 * 60_000;
    await s.news("뉴욕증시");
    expect(n).toBe(3);
    const timeout = Object.assign(new Error("시간 초과"), { name: "TimeoutError" });
    let m = 0;
    const s2 = defaultSummarySources({ db: {} as Db, indices: { list: async () => [], candles: async () => null }, naver: {} as never, calendar: { isTradingDate: async () => true }, krSectors: async () => ({ themes: [], note: null }), news: { search: async () => { m++; throw timeout; } }, retryDelayMs: 1 });
    await expect(s2.news("x")).rejects.toThrow("시간 초과");
    expect(m).toBe(1);
  });

  it("DB: 새 표 market_summaries (버전 7, 날짜·세션마다 1건)와 백업 대상", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const row = { summary_date: "2026-09-28", session: "morning", market: "US", status: "ok", summary: "s", data: "{}", created_at: "x" };
      await dbx.insertInto("market_summaries").values(row).execute();
      await expect(dbx.insertInto("market_summaries").values(row).execute()).rejects.toThrow();
      expect(BACKUP_TABLES).toContain("market_summaries");
    } finally {
      await dbx.destroy();
    }
  });
});
