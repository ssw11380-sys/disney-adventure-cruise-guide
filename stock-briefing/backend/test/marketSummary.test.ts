import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { buildDigest, KR_PREVIOUS_DAY_LINE, US_PREVIOUS_DAY_LINE, type DigestAccount, type DigestItem } from "../src/notifications/digest.js";
import type { PushMessage, PushSendResult, PushSender } from "../src/notifications/push.js";
import { MarketCalendar, type MarketStatus } from "../src/providers/market/calendar.js";
import type { MarketIndex } from "../src/providers/market/indices.js";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { parseGoogleRss } from "../src/providers/news/googleRss.js";
import { stripHtml, type NewsItem } from "../src/providers/news/types.js";
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
  isLeverageName,
  isWebUrl,
  krSectors,
  LEVERAGE_RE,
  naverYield,
  newsDays,
  newsWindow,
  nextSessionOpenAt,
  parseTreasuryCsv,
  phaseOf,
  pickFx,
  pickIndices,
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

  it("일별 시리즈에 오늘 점이 아직 없어도, 한국 영업일 10:00 뒤 새로 받은 띠 값은 오늘 고시값 — 평일 오후에 '(전날 고시)'가 틀리게 붙지 않는다", () => {
    const daily = [{ date: "2026-09-21" }, { date: "2026-09-22" }];
    const row = { value: 1359, change: 3.5, changeRate: 0.26 };
    // 평일 16:00 오후 요약: 오늘(9/23) 고시값 → 날짜 표기 없음
    const pm = pickFx(row, daily, "2026-09-23", { now: at("2026-09-23T16:00:00+09:00"), krOpenToday: true })!;
    expect(pm.date).toBe("2026-09-23");
    expect(fxText({ fx: pm, date: "2026-09-23" })).toBe("원/달러 1,359.00원 +3.50원");
    // 아침 08:30 은 아직 오늘 고시 전 → 일별 시리즈 날짜 그대로
    expect(pickFx(row, daily, "2026-09-23", { now: at("2026-09-23T08:30:00+09:00"), krOpenToday: true })!.date).toBe("2026-09-22");
    // 한국 휴장일은 오늘로 보지 않는다
    expect(pickFx(row, daily, "2026-09-25", { now: at("2026-09-25T16:00:00+09:00"), krOpenToday: false })!.date).toBe("2026-09-22");
    // 받지 못해 이어 쓴 값(stale — 받은 지 3시간까지)은 오늘 고시인지 전날 고시인지 알 수 없다 → 날짜를 붙이지 않고 '고시일 확인 못 함' (4차 검토)
    const staleFx = pickFx({ ...row, stale: true }, daily, "2026-09-23", { now: at("2026-09-23T16:00:00+09:00"), krOpenToday: true })!;
    expect(staleFx).toMatchObject({ date: null, stale: true });
    expect(fxText({ fx: staleFx, date: "2026-09-23" })).toBe("원/달러 1,359.00원 +3.50원 (고시일 확인 못 함)");
    // 일별 시리즈를 못 받아도 영업일 오후 새 값이면 오늘
    expect(pickFx(row, null, "2026-09-23", { now: at("2026-09-23T16:00:00+09:00"), krOpenToday: true })!.date).toBe("2026-09-23");
    expect(pickFx(row, null, "2026-09-23")!.date).toBeNull();
  });

  it("'10:00 뒤는 오늘 고시값' 규칙은 오후 요약에만 — 아침 요약을 10:00 뒤 다시 만들어도 직전 영업일 고시(일별 종가)와 '(M/D 고시)' (3차 검토)", () => {
    // 추석 연휴 뒤 화요일(9/29): 일별 시리즈 9/23 1,359.00 → 9/28 1,362.00, 띠에는 12:00 에 오늘 고시값 1,365.00
    const daily = [{ date: "2026-09-22", close: 1355.5 }, { date: "2026-09-23", close: 1359 }, { date: "2026-09-28", close: 1362 }];
    const live = { value: 1365, change: 3, changeRate: 0.22 };
    const noon = { now: at("2026-09-29T12:00:00+09:00"), krOpenToday: true } as const;
    const am = pickFx(live, daily, "2026-09-29", { ...noon, session: "morning" })!;
    expect(am).toEqual({ value: 1362, change: 3, changeRate: 0.22, date: "2026-09-28", stale: false });
    expect(fxText({ fx: am, date: "2026-09-29" })).toBe("원/달러 1,362.00원 +3.00원 (9/28 고시)");
    // 같은 때 오후 요약은 띠 값을 오늘 고시로
    expect(pickFx(live, daily, "2026-09-29", { ...noon, session: "afternoon" })).toMatchObject({ value: 1365, date: "2026-09-29" });
    // 아침 08:30(아직 오늘 고시 전)은 띠 값 그대로 + 일별 시리즈 날짜
    const early = { value: 1362, change: 3, changeRate: 0.22 };
    expect(pickFx(early, daily, "2026-09-29", { now: at("2026-09-29T08:30:00+09:00"), krOpenToday: true, session: "morning" })).toMatchObject({ value: 1362, date: "2026-09-28" });
    // 10:00 뒤인데 종가를 모르면 오늘 값에 전날 날짜를 붙이지 않는다 ('고시일 확인 못 함')
    const noClose = pickFx(live, [{ date: "2026-09-28" }], "2026-09-29", { ...noon, session: "morning" })!;
    expect(noClose.date).toBeNull();
    expect(fxText({ fx: noClose, date: "2026-09-29" })).toBe("원/달러 1,365.00원 +3.00원 (고시일 확인 못 함)");
  });

  it("아침 브리핑을 09:30 으로 옮겨도(하나은행 첫 고시 뒤 ~10:00) 오늘 띠 값에 전날 날짜를 붙이지 않는다 — 아침은 시각과 상관없이 직전 영업일 종가 (4차 검토)", () => {
    // 9/29 09:30: 띠에는 오늘 첫 고시 1,362.00(+1.50), 일별 시리즈는 9/28 1,360.50 까지
    const daily = [{ date: "2026-09-23", close: 1359 }, { date: "2026-09-28", close: 1360.5 }];
    const band = { value: 1362, change: 1.5, changeRate: 0.11 };
    const am = pickFx(band, daily, "2026-09-29", { now: at("2026-09-29T09:30:00+09:00"), krOpenToday: true, session: "morning" })!;
    expect(am).toEqual({ value: 1360.5, change: 1.5, changeRate: 0.11, date: "2026-09-28", stale: false });
    expect(fxText({ fx: am, date: "2026-09-29" })).toBe("원/달러 1,360.50원 +1.50원 (9/28 고시)");
    // 종가를 모르면: 첫 고시 전(08:30)만 띠 값 = 직전 영업일 고시, 09:30 은 '고시일 확인 못 함'
    const dates = [{ date: "2026-09-23" }, { date: "2026-09-28" }];
    expect(pickFx(band, dates, "2026-09-29", { now: at("2026-09-29T08:30:00+09:00"), krOpenToday: true, session: "morning" })!.date).toBe("2026-09-28");
    expect(pickFx(band, dates, "2026-09-29", { now: at("2026-09-29T09:30:00+09:00"), krOpenToday: true, session: "morning" })!.date).toBeNull();
    // 오늘이 한국 휴장일이면 띠 값은 직전 영업일 고시 그대로 (9/25 추석 아침)
    expect(pickFx(band, [{ date: "2026-09-22" }, { date: "2026-09-23" }], "2026-09-25", { now: at("2026-09-25T09:30:00+09:00"), krOpenToday: false, session: "morning" })!.date).toBe("2026-09-23");
  });
});

describe("지수: 출처 조회가 실패해 남은 마지막 값(stale)은 마감 뒤 시세일 때만 (4차 검토)", () => {
  const row = (code: string, asOf: string, stale: boolean) => ({ code, name: code, value: 7000, change: 60, changeRate: 0.9, asOf, stale });
  it("16:00 코스피 조회 실패로 15:25 장중 값만 남았으면 뺀다 — '15:30 장 마감 기준'으로 카드·알림·보유 종목 비교에 쓰이지 않게", () => {
    const close = sessionClose("KR", "2026-09-23").at;
    const got = pickIndices([row("KOSPI", "2026-09-23T15:25:00+09:00", true), row("KOSDAQ", "2026-09-23T15:31:00+09:00", true)], "KR", "2026-09-23", close);
    expect(got[0]).toMatchObject({ code: "KOSPI", changeRate: null, missing: "출처 조회가 실패해 남은 마지막 값이 마감 전(15:25) 값이라 뺌" });
    // 마감 뒤에 받은 값이면 확정 값이라 쓴다
    expect(got[1]).toMatchObject({ code: "KOSDAQ", changeRate: 0.9 });
    // 새로 받은 값(stale 아님)은 시각을 따지지 않는다 (예전과 같다)
    expect(pickIndices([row("KOSPI", "2026-09-23T15:25:00+09:00", false)], "KR", "2026-09-23", close)[0]!.changeRate).toBe(0.9);
    // 미국: 16:00 ET 마감 뒤 값(17:15)은 쓰고, 장중(15:10)은 뺀다
    const usClose = sessionClose("US", "2026-09-25").at;
    const us = pickIndices([row("NASDAQ", "2026-09-25T17:15:00-04:00", true), row("SPX", "2026-09-25T15:10:00-04:00", true)], "US", "2026-09-25", usClose);
    expect(us.map((i) => i.changeRate)).toEqual([0.9, null, null, null]);
    expect(us[1]!.missing).toContain("마감 전(15:10)");
  });
});

describe("다음 장이 열리는 순간 (강제 재실행이 좋은 요약을 덮지 않게)", () => {
  it("미국 금요일(9/25) 다음 개장은 월요일 09:30 ET(한국 22:30), 추수감사절 전날(11/25) 다음은 11/27, 한국 수능일은 10:00", () => {
    expect(new Date(nextSessionOpenAt("US", "2026-09-25")).toISOString()).toBe("2026-09-28T13:30:00.000Z");
    expect(new Date(nextSessionOpenAt("US", "2026-11-25")).toISOString()).toBe("2026-11-27T14:30:00.000Z");
    expect(new Date(nextSessionOpenAt("KR", "2026-11-18")).toISOString()).toBe("2026-11-19T01:00:00.000Z");
    expect(new Date(nextSessionOpenAt("KR", "2026-09-23")).toISOString()).toBe("2026-09-28T00:00:00.000Z"); // 추석 연휴 뒤
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

  it("미국 인버스: 'UltraShort'(−2배)·'Short QQQ/S&P500'(−1배)은 레버리지·인버스로 빼고, 짧은 만기 채권 ETF('Ultra-Short Income'·'Short Treasury Bond')는 채권으로", () => {
    for (const name of ["ProShares UltraShort QQQ", "ProShares UltraShort S&P500", "ProShares UltraShort 20+ Year Treasury", "ProShares Short QQQ", "ProShares Short S&P500", "ProShares UltraPro Short QQQ", "프로셰어즈 울트라숏 QQQ"]) expect(isLeverageName(name), name).toBe(true);
    for (const name of ["JPMorgan Ultra-Short Income ETF", "BlackRock Ultra Short-Term Bond ETF", "iShares Short Treasury Bond ETF", "Schwab Short-Term U.S. Treasury ETF", "Invesco Ultra Short Duration ETF", "마이크로소프트"]) expect(isLeverageName(name), name).toBe(false);
    const indices = [idx("NASDAQ", "나스닥", 0.48, "2026-09-25"), idx("SPX", "S&P500", 0.51, "2026-09-25")];
    const q = (rate: number, exchange: string, name: string) => ({ changeRate: rate, tradedAt: "2026-09-25T16:00:00-04:00", exchange, name });
    const cmp = compareHoldings({
      market: "US",
      basisDate: "2026-09-25",
      holdings: [
        { code: "QID", name: "QID", market: "NASDAQ" },
        { code: "SDS", name: "SDS", market: "NYSE" },
        { code: "TBT", name: "TBT", market: "NYSE" },
        { code: "PSQ", name: "PSQ", market: "NASDAQ" },
        { code: "SH", name: "SH", market: "NYSE" },
        { code: "SHV", name: "SHV", market: "NASDAQ" },
        { code: "JPST", name: "JPST", market: "AMEX" },
      ],
      quotes: new Map([
        ["QID", q(-0.96, "NSQ", "ProShares UltraShort QQQ")],
        ["SDS", q(-1.02, "NYS", "ProShares UltraShort S&P500")],
        ["TBT", q(0.4, "NYS", "ProShares UltraShort 20+ Year Treasury")],
        ["PSQ", q(-0.48, "NSQ", "ProShares Short QQQ")],
        ["SH", q(-0.51, "NYS", "ProShares Short S&P500")],
        ["SHV", q(0.01, "NSQ", "iShares Short Treasury Bond ETF")],
        ["JPST", q(0.02, "AMX", "JPMorgan Ultra-Short Income ETF")],
      ]),
      indices,
    })!;
    expect(cmp.compared).toBe(0);
    expect(cmp.excluded.leverage).toEqual(["QID", "SDS", "TBT", "PSQ", "SH"]);
    expect(cmp.excluded.bond).toEqual(["SHV", "JPST"]);
  });

  it("한국: 코스닥 추종 ETF 는 코스닥과, 금현물·원자재 ETF 는 빼고, 종목 마스터 분류가 없어도 한글 상표(히어로즈·마이다스)를 알아본다 ('파워로직스'는 종목)", () => {
    const indices = [idx("KOSPI", "코스피", 0.9, "2026-09-23"), idx("KOSDAQ", "코스닥", 1.21, "2026-09-23")];
    const q = (rate: number) => ({ changeRate: rate, tradedAt: "2026-09-23T15:30:00+09:00", exchange: "KS" });
    const cmp = compareHoldings({
      market: "KR",
      basisDate: "2026-09-23",
      holdings: [
        { code: "229200", name: "KODEX 코스닥150", market: "KOSPI", groupCode: "EF" },
        { code: "411060", name: "ACE KRX금현물", market: "KOSPI", groupCode: "EF" },
        { code: "999001", name: "히어로즈 미국S&P500", market: "KOSPI", groupCode: null },
        { code: "999002", name: "마이다스 KRX금현물", market: "KOSPI" },
        { code: "047310", name: "파워로직스", market: "KOSDAQ", groupCode: null },
      ],
      quotes: new Map([["229200", q(1.5)], ["411060", q(-0.8)], ["999001", q(0.4)], ["999002", q(-0.8)], ["047310", { ...q(2.5), exchange: "KQ" }]]),
      indices,
    })!;
    expect(cmp.similar.map((r) => `${r.name} ${r.benchmark.name} ${r.diff}`)).toEqual(["KODEX 코스닥150 코스닥 0.29"]);
    expect(cmp.high.map((r) => `${r.name} ${r.benchmark.name}`)).toEqual(["파워로직스 코스닥"]);
    expect(cmp.excluded.overseas).toEqual(["ACE KRX금현물", "히어로즈 미국S&P500", "마이다스 KRX금현물"]);
  });

  it("이름 오분류 막기 (4차 검토): 'Ultra'는 ProShares 상품에만('Ultra Clean Holdings'·'Ultragenyx'는 종목), 'MSCI Korea'는 코스피와 비교", () => {
    for (const name of ["Ultra Clean Holdings", "Ultragenyx Pharmaceutical", "울트라 클린 홀딩스", "Ultralife Corp"]) expect(isLeverageName(name), name).toBe(false);
    for (const name of ["ProShares Ultra QQQ", "프로셰어즈 울트라 QQQ", "프로셰어즈 울트라프로 QQQ", "ProShares UltraPro Russell2000"]) expect(isLeverageName(name), name).toBe(true);
    const us = compareHoldings({
      market: "US",
      basisDate: "2026-09-25",
      holdings: [
        { code: "UCTT", name: "UCTT", market: "NASDAQ" },
        { code: "RARE", name: "RARE", market: "NASDAQ" },
      ],
      quotes: new Map([
        ["UCTT", { changeRate: 2.1, tradedAt: "2026-09-25T16:00:00-04:00", exchange: "NSQ", name: "울트라 클린 홀딩스" }],
        ["RARE", { changeRate: -0.2, tradedAt: "2026-09-25T16:00:00-04:00", exchange: "NSQ", name: "Ultragenyx Pharmaceutical" }],
      ]),
      indices: [idx("NASDAQ", "나스닥", 0.48, "2026-09-25")],
    })!;
    expect(us.compared).toBe(2);
    expect(us.excluded.leverage).toEqual([]);
    const kr = compareHoldings({
      market: "KR",
      basisDate: "2026-09-23",
      holdings: [
        { code: "069500", name: "KODEX MSCI Korea TR", market: "KOSPI", groupCode: "EF" },
        { code: "251350", name: "KODEX MSCI선진국", market: "KOSPI", groupCode: "EF" },
      ],
      quotes: new Map([
        ["069500", { changeRate: 1.1, tradedAt: "2026-09-23T15:30:00+09:00", exchange: "KS" }],
        ["251350", { changeRate: 0.3, tradedAt: "2026-09-23T15:30:00+09:00", exchange: "KS" }],
      ]),
      indices: [idx("KOSPI", "코스피", 0.9, "2026-09-23"), idx("KOSDAQ", "코스닥", 1.21, "2026-09-23")],
    })!;
    expect(kr.similar.map((r) => `${r.name} ${r.benchmark.name}`)).toEqual(["KODEX MSCI Korea TR 코스피"]);
    expect(kr.excluded.overseas).toEqual(["KODEX MSCI선진국"]);
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

  it("목표가는 '목표주가'·'목표 주가'까지 막는다 — 창 안 통신사 기사라도 카드 첫 제목이 되지 않는다 (요구 검사 must)", () => {
    for (const t of ["[뉴욕증시] 모건스탠리, 엔비디아 목표주가 상향에 3%↑", "엔비디아 목표 주가 줄상향", "반도체주 목표가 줄상향"]) expect(blockedTitle(t), t).toBe(true);
    const w = newsWindow("US", "2026-09-25", at("2026-09-28T08:30:00+09:00"));
    const bad: NewsItem = { title: "[뉴욕증시] 모건스탠리, 엔비디아 목표주가 상향에 3%↑", url: "https://news.google.com/rss/articles/tp", source: "연합뉴스", publishedAt: "2026-09-25T20:30:00Z", summary: null };
    const picked = pickNews([bad, ...items()], { ...w, days: newsDays("US", "2026-09-25") });
    expect(picked.map((n) => n.outlet)).toEqual(["뉴스1", "KBS", "한국경제"]);
    expect(picked.some((n) => n.title.includes("목표"))).toBe(false);
  });

  it("명령·권유형 제목('매수하라'·'지금 사라'·'적기'·'톱픽'·'투자의견'·'늘려라'·'살 때다'·'담을 때')도 뺀다 — '사라져'·'사라진'은 사실이라 둔다", () => {
    for (const t of ["반도체 매수하라", "지금 사라, 반도체주", "지금이 저점 매수 적기", "매수 적기", "지금이 매수적기", "월가 톱픽은 엔비디아", "테슬라 투자의견 '매수'로 상향", "비중 늘려라", "지금이 살 때다", "반도체 담을 때", "현금 비중 줄여라"]) expect(blockedTitle(t), t).toBe(true);
    for (const t of ["관세 불확실성 사라져…뉴욕증시 상승 마감", "공포 사라진 월가, 3대 지수 상승", "나스닥 0.48% 올라 마감", "반도체주 강세 속 상승 마감", "실적기대감에 반도체 강세"]) expect(blockedTitle(t), t).toBe(false);
  });

  // 3차 검토 must: 앱의 권유 금지 목록(app/test/wording.test.ts BANNED) 17개 중 10개가 거르기를 통과했다 (예: 창 안 통신사 기사 '월가 "엔비디아 적극 매수"')
  const BANNED = (() => {
    const src = readFileSync(new URL("../../app/test/wording.test.ts", import.meta.url), "utf8");
    const m = /const BANNED = (\[[^\]]*\]);/.exec(src);
    return JSON.parse(m![1]!) as string[];
  })();

  it("앱 권유 금지 목록(wording.test BANNED)의 문구는 모두 막힌다 — 그 문구만 있어도, 통신사 제목 안에 있어도", () => {
    expect(BANNED.length).toBeGreaterThanOrEqual(17);
    for (const w of BANNED) {
      expect(blockedTitle(w), w).toBe(true);
      expect(blockedTitle(`[뉴욕증시] 월가 "엔비디아 ${w}"…나스닥 1%↑`), w).toBe(true);
    }
    // 창 안 통신사 기사라도 카드 첫 제목이 되지 않는다
    const w = newsWindow("US", "2026-09-25", at("2026-09-28T08:30:00+09:00"));
    const bad: NewsItem = { title: '[뉴욕증시] 월가 "엔비디아 적극 매수"…나스닥 1%↑', url: "https://news.google.com/rss/articles/ab", source: "연합뉴스", publishedAt: "2026-09-25T20:30:00Z", summary: null };
    expect(pickNews([bad, ...parseGoogleRss(fixture("google-news-sample.xml"))], { ...w, days: newsDays("US", "2026-09-25") }).map((n) => n.outlet)).toEqual(["뉴스1", "KBS", "한국경제"]);
  });

  it("사는 쪽·파는 쪽 같은 꼴로 막는다 (당위·허락 묻기·명령·기회) — 사실을 적은 말은 둔다", () => {
    for (const t of [
      "엔비디아 지금 사야 한다",
      "반도체주 사야 할 때",
      "지금 사도 되나",
      "지금 매수해도 된다…월가 낙관",
      "지금 매도해도 될까",
      "반도체 비중 늘려야",
      "현금 비중 줄여야",
      "AI 랠리 올라타라",
      "지금이 기회",
      "저가 매수 기회 왔다",
      "테슬라 팔아야",
      "지금 팔라",
      "팔아도 되나",
      "반도체 담아야",
      "손절 타이밍",
    ])
      expect(blockedTitle(t), t).toBe(true);
    for (const t of ["외국인 순매수에 코스피 0.9% 상승 마감", "개인 매수세 몰려", "기관 매도 우위", "팔라듐 가격 급등", "기회발전특구 지정", "기회비용 늘어", "회사야 어찌 되든", "공포 사라진 월가"]) expect(blockedTitle(t), t).toBe(false);
  });

  it("물음표 없는 물음('반등 오나'·'바닥 찍었나'·'랠리 계속되나'·'지금 들어가도 되나')과 예측 낱말('예측'·'관측'·'간다')도 뺀다 — '까지'·'내주며'·'관측소' 등은 둔다", () => {
    for (const t of ["반등 오나", "반등 오나…나스닥 1%↑", "바닥 찍었나", "랠리 계속되나", "지금 들어가도 되나", "금리 인하 끝났나", "상승 이어가나", "대안 없나", "바닥 찍었는가", "코스피 3000 예측", "금리 동결 관측", "주가 2배 간다", "코스피 5000 간다…증권가"]) expect(blockedTitle(t), t).toBe(true);
    for (const t of [
      "반도체까지 오름세 넓어져",
      "시총 1위 자리 내주며 하락",
      "관세 불확실성 사라져…뉴욕증시 상승 마감",
      "실적기대감에 반도체 강세",
      "기상청 관측소 이전",
      "가나 대통령 방한",
      "3대 지수 중 하나만 올라",
      "고점 지나 하락 마감",
      "우리나라 수출 증가",
      "나스닥 0.48% 올라 마감",
      "뉴욕증시, 기술주 강세 속 상승 마감",
      "시간외 거래 증가",
    ])
      expect(blockedTitle(t), t).toBe(false);
  });

  it("원문 링크는 http(s) 주소만 저장한다 (javascript:·intent: 같은 주소의 기사는 뺀다)", () => {
    expect(isWebUrl("https://news.google.com/rss/articles/x")).toBe(true);
    expect(isWebUrl("http://a.b/c")).toBe(true);
    for (const u of ["javascript:alert(1)", "intent://x#Intent;end", "file:///etc/passwd", "", " ", null, undefined, "https://a b"]) expect(isWebUrl(u as string), String(u)).toBe(false);
    const base: NewsItem = { title: "뉴욕증시 상승 마감", url: "javascript:alert(1)", source: "연합뉴스", publishedAt: "2026-09-25T20:30:00Z", summary: null };
    const w = { from: "2026-09-25T19:50:00.000Z", to: "2026-09-26T02:00:00.000Z", days: [25, 26] };
    expect(pickNews([base], w)).toEqual([]);
    expect(pickNews([{ ...base, url: " https://news.google.com/rss/articles/ok " }], w).map((n) => n.url)).toEqual(["https://news.google.com/rss/articles/ok"]);
  });

  /** 녹화 모양 그대로의 구글 RSS 한 건 (제목 끝 ' - 언론사') */
  const rss = (items: Array<{ title: string; outlet: string; at: string; id: string }>) =>
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items
      .map((i) => `<item><title>${i.title} - ${i.outlet}</title><link>https://news.google.com/rss/articles/${i.id}</link><pubDate>${new Date(i.at).toUTCString()}</pubDate><source url="https://x">${i.outlet}</source></item>`)
      .join("")}</channel></rss>`;
  const mondayWindow = () => ({ ...newsWindow("US", "2026-09-25", at("2026-09-28T08:30:00+09:00")), days: newsDays("US", "2026-09-25") });

  it("때 짚기·명령형 권유는 사는 쪽·파는 쪽 모두 막는다: '지금 살 때인가'·'살 때냐 팔 때냐'·'지금은 매수할 때'·'매도할 시점'·'사둬라'·'갈아타라' (4차 검토 must)", () => {
    for (const t of [
      "지금 살 때인가",
      "팔 때인가",
      "살 때냐 팔 때냐",
      "뉴욕증시, 지금은 매수할 때",
      "지금은 매도할 때",
      "매수할 시점",
      "매도할 시점",
      "지금이 매수 시점",
      "매도 시점 왔다",
      "매수할 타이밍",
      "사둬라",
      "반도체주 사 둬라",
      "사들여라",
      "성장주로 갈아타라",
      "배당주 모아라",
      "지금 살 때가 왔다",
      "살 만한 종목",
      "반도체 버텨라",
      "지금 정리하라",
      "현금 확보해라",
    ])
      expect(blockedTitle(t), t).toBe(true);
    // 사실을 적은 말은 둔다 ('저가 매수세'·'외국인 사자'·나이 '30살 때'·'사하라'·'올라 마감')
    for (const t of ["저가 매수세 유입에 반등", "외국인 사자에 코스피 상승", "30살 때부터 모은 주식", "사하라 모래바람", "나스닥 0.48% 올라 마감", "외국인 매도 우위에 하락 마감", "공매도 잔고 줄어"]) expect(blockedTitle(t), t).toBe(false);
    // 실제 파서(parseGoogleRss)로 읽은 창 안 기사라도 카드·상세에 오르지 않는다
    const bad = parseGoogleRss(rss([{ title: "뉴욕증시, 지금은 매수할 때", outlet: "머니투데이", at: "2026-09-25T21:00:00Z", id: "buy" }]));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ title: "뉴욕증시, 지금은 매수할 때", source: "머니투데이" });
    const picked = pickNews([...bad, ...parseGoogleRss(fixture("google-news-sample.xml"))], mondayWindow());
    expect(picked.map((n) => n.outlet)).toEqual(["뉴스1", "KBS", "한국경제"]);
    expect(picked.some((n) => n.title.includes("매수할 때"))).toBe(false);
  });

  it("물음표 없는 물음은 마디 끝 '~나'·'~ㄴ가'·'~냐'·'~ㄹ지'까지, 전망은 '금주·차주'·'~ㄹ 것'·'가능성'·'온다'·'여력·여지'까지 — 이름·사실을 적은 말은 둔다 (4차 검토)", () => {
    for (const t of [
      "랠리 멈추나",
      "코스피 꺾이나",
      "반도체 살아나나",
      "상승세 이어지나",
      "코스피 어디까지 오르나",
      "코스피 3천 가나",
      "코스피 3천 가나…외국인 순매수",
      "코스피 바닥인가",
      "AI주 거품인가",
      "지금 살 때인가",
      "괜찮은가",
      "반등 성공할지 주목",
      "지금 사도 될까요",
      "반도체 오르나요",
      "금주 증시",
      "차주 증시 일정",
      "랠리 계속될 것",
      '골드만 "코스피 연말 3500 갈 것"',
      "4000 시대 열릴 것이란 기대",
      "추가 상승 가능성",
      '"코스피 5000 온다"',
      "상승 여지 남아",
      "반등 여력 충분",
    ])
      expect(blockedTitle(t), t).toBe(true);
    for (const t of [
      "반도체까지 오름세 넓어져",
      "시총 1위 자리 내주며 하락",
      "관세 불확실성 사라져…뉴욕증시 상승 마감",
      "실적기대감에 반도체 강세",
      "기상청 관측소 이전",
      "팔라듐 가격 급등",
      "기회발전특구 지정",
      "가나 대통령 방한",
      "3대 지수 중 하나만 올라",
      "고점 지나 하락 마감",
      "우리나라 수출 증가",
      "신한·우리·하나",
      "우크라이나 재건주 강세",
      "러시아, 우크라이나",
      "차이나 리스크에 하락",
      "대한항공·아시아나",
      "케냐 대통령 방한",
      "주가 두 배나 뛰어",
      "원가 부담에 하락",
      "납품 단가 인상",
      "인터넷은행 예비인가 신청",
      "인가 취소",
      "3종목 상한가",
      "하한가 속출",
      "매매일지 공개",
      "그것이 알고 싶다",
      "여지없이 무너진 코스피",
      "뉴욕증시 마감 시황 & 금리 동향",
    ])
      expect(blockedTitle(t), t).toBe(false);
  });

  it("제목의 숫자·16진 엔티티를 푼다 (두 겹 감싼 것까지) — '나스닥 &#8230; 상승'처럼 보이지 않고, 감싼 물음표(&#63;)도 물음 제목으로 거른다 (4차 검토)", () => {
    expect(stripHtml("나스닥 &amp;#8230; 상승")).toBe("나스닥 … 상승");
    expect(stripHtml("나스닥 &#x2026; 상승 &#8216;AI&#8217;")).toBe("나스닥 … 상승 ‘AI’");
    expect(stripHtml("S&amp;P500 &quot;사상 최고&quot; &amp;amp; 나스닥")).toBe('S&P500 "사상 최고" & 나스닥');
    expect(stripHtml("잘못된 &#0; &#xD800; 엔티티")).toBe("잘못된 &#0; &#xD800; 엔티티");
    const got = parseGoogleRss(
      rss([
        { title: "나스닥 &amp;#8230; 상승 마감", outlet: "연합뉴스", at: "2026-09-25T20:40:00Z", id: "e1" },
        { title: "코스피 반등 오나&amp;#63;", outlet: "뉴시스", at: "2026-09-25T20:45:00Z", id: "e2" },
      ]),
    );
    expect(got.map((n) => n.title)).toEqual(["코스피 반등 오나?", "나스닥 … 상승 마감"]);
    expect(pickNews(got, mondayWindow()).map((n) => n.title)).toEqual(["나스닥 … 상승 마감"]);
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

  it("토스 달력과 휴장일 목록이 다르면 경고한다 (시장·날짜마다 한 번) — 한국은 휴장 쪽으로 본다 (3차 검토: 2027 목록은 계산값이라 틀리면 브리핑이 조용히 건너뛰어진다)", async () => {
    const toss = (krEnd: string, krNext: string) =>
      (async () =>
        new Response(
          JSON.stringify({ result: [{ productCode: "A005930", tradingEnd: krEnd, nextTradingStart: krNext }, { productCode: "US19801212001", tradingEnd: "2026-09-24T20:00:00Z", nextTradingStart: "2026-09-25T13:30:00Z" }] }),
          { status: 200 },
        )) as unknown as typeof fetch;
    const warns: string[] = [];
    const log = { warn: (_o: Record<string, unknown>, m: string) => void warns.push(m) };
    // 토스는 9/25(추석)를 거래일로 알려 줌(장중) — 목록은 휴장 → 휴장으로 보고 경고 한 번
    const cal = new MarketCalendar(toss("2026-09-25T11:00:00Z", "2026-09-27T23:00:00Z"), () => new Date("2026-09-25T03:00:00Z"), 60_000, log);
    expect(await cal.isTradingDate("KR", "2026-09-25")).toBe(false);
    expect(await cal.isTradingDate("KR", "2026-09-25")).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("토스 달력은 거래일");
    expect(warns[0]).toContain("목록 확인 필요");
    // 토스는 10/1 을 휴장으로(9/30 마감 뒤 다음 개장 10/2) — 목록에는 없음 → 휴장으로 보고 경고
    const cal2 = new MarketCalendar(toss("2026-09-30T11:00:00Z", "2026-10-01T23:00:00Z"), () => new Date("2026-10-01T03:00:00Z"), 60_000, log);
    expect(await cal2.isTradingDate("KR", "2026-10-01")).toBe(false);
    expect(warns[1]).toContain("토스 달력은 휴장");
    // 같으면 조용하다
    expect(await cal2.isTradingDate("KR", "2026-10-02")).toBe(true);
    expect(await cal2.isTradingDate("KR", "2026-10-03")).toBe(false); // 토요일 (주말은 비교하지 않는다)
    expect(warns).toHaveLength(2);
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

  it("이어진 휴장의 이름이 다르면 '연말·신정', 다음 개장이 특수일이면 시각까지 ('다음 개장 1/4(월) 10:00') — 3차 검토", () => {
    expect(line("2026-12-30T16:00:00+09:00")).toBe("일정 · 12/31~1/1 연말·신정 연휴 한국 휴장 · 다음 개장 1/4(월) 10:00");
    // 같은 이름(추석 연휴·추석)은 하나로, 평소 개장(09:00)은 시각 없이 그대로
    expect(line("2026-09-23T16:00:00+09:00")).toBe("일정 · 9/24~9/25 추석 연휴 한국 휴장 · 다음 개장 9/28(월)");
  });

  it("이어진 한국 휴장은 창 안에 드는 첫 휴장일부터 — 연휴 둘째 날 아침에도 '오늘 한국 휴장' (4차 검토: 9/25·2027-01-01 08:30 에 빠졌다)", () => {
    expect(line("2026-09-25T08:30:00+09:00")).toBe("일정 · 오늘 한국 휴장(추석)");
    expect(line("2027-01-01T08:30:00+09:00")).toBe("일정 · 오늘 한국 휴장(신정) · 오늘 미국 휴장(신정)");
    // 사흘 연휴의 둘째 날: 남은 이틀 범위 + 다음 개장
    expect(line("2027-09-15T08:30:00+09:00")).toBe("일정 · 9/15~9/16 추석 연휴 한국 휴장 · 다음 개장 9/17(금)");
    // 연휴 첫날 아침은 예전처럼 범위 전체, 연휴 전날 오후도 그대로
    expect(line("2026-09-24T08:30:00+09:00")).toBe("일정 · 9/24~9/25 추석 연휴 한국 휴장 · 다음 개장 9/28(월)");
    expect(line("2026-12-30T16:00:00+09:00")).toBe("일정 · 12/31~1/1 연말·신정 연휴 한국 휴장 · 다음 개장 1/4(월) 10:00");
    // 연휴 안(오늘이 휴장일)에 받은 네이버 다음 거래일도 쓴다
    const e = upcomingEvents(at("2027-09-15T08:30:00+09:00"), { krNext: { today: "2027-09-15", next: "2027-09-20" } });
    expect(e.within.find((x) => x.kind === "kr-open")).toMatchObject({ date: "2027-09-20" });
  });

  it("다음 개장은 네이버 다음 거래일(next.tradeBaseAt)을 먼저 — 목록에 없는 임시공휴일이 끼어도 맞게, 없거나 맞지 않으면 목록으로", () => {
    // 휴장일 오후: 네이버가 다음 거래일 10/2 를 알려 주면(10/1 임시공휴일 — 목록에 없음) 10/2
    expect(nextOpenEvent("2026-09-30", { today: "2026-09-30", next: "2026-10-02" })).toMatchObject({ date: "2026-10-02", time: "09:00" });
    expect(nextOpenEvent("2026-09-30")).toMatchObject({ date: "2026-10-01" });
    // 다른 날 받은 값·오늘보다 앞선 값·주말은 쓰지 않는다
    expect(nextOpenEvent("2026-09-30", { today: "2026-09-29", next: "2026-10-02" }).date).toBe("2026-10-01");
    expect(nextOpenEvent("2026-09-30", { today: "2026-09-30", next: "2026-09-30" }).date).toBe("2026-10-01");
    expect(nextOpenEvent("2026-09-30", { today: "2026-09-30", next: "2026-10-03" }).date).toBe("2026-10-01");
    // 새해 첫 거래일은 10:00 개장
    expect(nextOpenEvent("2026-12-31", { today: "2026-12-31", next: "2027-01-04" })).toMatchObject({ date: "2027-01-04", time: "10:00" });
    // 연휴 줄의 다음 개장: 네이버 다음 거래일이 연휴 뒤면 그 날(9/28 이 임시공휴일인 경우), 연휴 안이면(출처가 다름) 목록으로
    const ops = (next: string) => eventsText({ events: { within: upcomingEvents(at("2026-09-23T16:00:00+09:00"), { krNext: { today: "2026-09-23", next } }).within, next: null, unknown: [] } }, at("2026-09-23T16:00:00+09:00"));
    expect(ops("2026-09-29")).toBe("일정 · 9/24~9/25 추석 연휴 한국 휴장 · 다음 개장 9/29(화)");
    expect(ops("2026-09-24")).toBe("일정 · 9/24~9/25 추석 연휴 한국 휴장 · 다음 개장 9/28(월)");
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
function fakeSources(o: { session: "morning" | "afternoon"; krToday?: { date: string; trading: boolean; desc: string | null; latest: string; next?: string }; slowMs?: number; krSec?: { note: string | null; asOf?: string | null } } ) {
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
      const next = kt.next ? { kind: "preopen" as const, label: "", openAt: null, closeAt: null, tradeBaseAt: kt.next } : null;
      return { KR: { latest: session, next, isTradingDay: kt.trading, today: { date: kt.date, isWeekdayHoliday: !kt.trading, holidayDescription: kt.desc } } };
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
      const svc = new MarketSummaryService({ db: dbx, sources: { ...src, indices: async () => (calls["indices"] = (calls["indices"] ?? 0) + 1, [kr("KOSPI", "코스피", 0.5), kr("KOSDAQ", "코스닥", -0.2)]) }, features: { enabled: async () => true }, now: () => t.now, timer: () => () => undefined });
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

  it("장중에 만든 요약은 확정 시각(마감) + 5분에 저절로 다시 만든다 — 예약 실행을 기다리지 않고, 서버를 닫으면 예약을 취소", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src, calls } = fakeSources({ session: "afternoon", krToday: { date: "2026-11-19", trading: true, desc: null, latest: "2026-11-19" } });
      const t = { now: at("2026-11-19T16:00:00+09:00") };
      const kr = (code: string, name: string, rate: number): MarketIndex => ({ code, name, kind: "index", value: 100, change: 1, changeRate: rate, open: true, asOf: "2026-11-19T16:00:00+09:00", stale: false });
      const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
      const timer = (fn: () => void, ms: number) => {
        const e = { fn, ms, cancelled: false };
        timers.push(e);
        return () => void (e.cancelled = true);
      };
      const svc = new MarketSummaryService({ db: dbx, sources: { ...src, indices: async () => (calls["indices"] = (calls["indices"] ?? 0) + 1, [kr("KOSPI", "코스피", 0.5), kr("KOSDAQ", "코스닥", -0.2)]) }, features: { enabled: async () => true }, now: () => t.now, timer });
      const early = await svc.generate("afternoon", { date: "2026-11-19" });
      expect(early?.data?.phase).toBe("intraday");
      // 수능일 16:30 마감 + 5분 = 16:35 → 16:00 에서 35분 뒤
      expect(timers.map((x) => x.ms)).toEqual([35 * 60_000]);
      // 같은 날짜·세션은 한 번만 예약
      await svc.generate("afternoon", { date: "2026-11-19", force: true });
      expect(timers).toHaveLength(1);
      t.now = at("2026-11-19T16:35:00+09:00");
      timers[0]!.fn();
      await new Promise((r) => setTimeout(r, 30));
      expect((await svc.find("2026-11-19", "afternoon"))?.data?.phase).toBe("final");
      expect(calls["indices"]).toBe(3);
      // 확정 값은 예약하지 않는다
      expect(timers).toHaveLength(1);
      // 닫으면 남은 예약을 취소
      const kr20 = (code: string, name: string, rate: number): MarketIndex => ({ ...kr(code, name, rate), asOf: "2026-11-20T15:00:00+09:00" });
      const svc2 = new MarketSummaryService({ db: dbx, sources: { ...src, indices: async () => [kr20("KOSPI", "코스피", 0.5), kr20("KOSDAQ", "코스닥", -0.2)] }, features: { enabled: async () => true }, now: () => at("2026-11-20T15:00:00+09:00"), timer });
      await svc2.generate("afternoon", { date: "2026-11-20" });
      expect(timers).toHaveLength(2);
      svc2.stop();
      expect(timers[1]!.cancelled).toBe(true);
    } finally {
      await dbx.destroy();
    }
  });

  it("이른 수동 실행(12:00 장중)을 확정 + 5분(15:35)에 저절로 다시 만든 요약은 뉴스 창이 15:35 에 닫혀 있어, 16:00 예약 실행이 한 번 더 만들어 16:00 까지 넓힌다 (3차 검토)", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src, calls } = fakeSources({ session: "afternoon" });
      const t = { now: at("2026-09-23T12:00:00+09:00") };
      const kr = (code: string, name: string, rate: number): MarketIndex => ({ code, name, kind: "index", value: 100, change: 1, changeRate: rate, open: true, asOf: "2026-09-23T12:00:00+09:00", stale: false });
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const svc = new MarketSummaryService({
        db: dbx,
        sources: { ...src, indices: async () => ((calls["indices"] = (calls["indices"] ?? 0) + 1), [kr("KOSPI", "코스피", 0.5), kr("KOSDAQ", "코스닥", -0.2)]) },
        features: { enabled: async () => true },
        now: () => t.now,
        timer: (fn, ms) => (timers.push({ fn, ms }), () => undefined),
      });
      expect((await svc.generate("afternoon", { date: "2026-09-23" }))?.data?.phase).toBe("intraday");
      expect(timers.map((x) => x.ms)).toEqual([215 * 60_000]); // 12:00 → 15:35
      t.now = at("2026-09-23T15:35:00+09:00");
      timers[0]!.fn();
      await new Promise((r) => setTimeout(r, 30));
      const auto = await svc.find("2026-09-23", "afternoon");
      expect(auto?.data).toMatchObject({ phase: "final", origin: "refinal", news: { to: "2026-09-23T06:35:00.000Z" } });
      // 16:00 예약 실행: 강제가 아니어도 다시 만들어 뉴스 창을 16:00 까지 (알림 첫 줄도 이 요약)
      t.now = at("2026-09-23T16:00:10+09:00");
      const before = calls["indices"]!;
      const sched = await svc.afterRun({ session: "afternoon", date: "2026-09-23", partial: false });
      expect(calls["indices"]).toBe(before + 1);
      expect(sched?.data?.origin).toBeUndefined();
      expect(sched?.data?.news.to).toBe("2026-09-23T07:00:10.000Z");
      // 그 뒤에는 다시 부르지 않는다 (예약 실행이 한 번 더 돌아도)
      await svc.afterRun({ session: "afternoon", date: "2026-09-23", partial: false });
      expect(calls["indices"]).toBe(before + 1);
    } finally {
      await dbx.destroy();
    }
  });

  it("한국 휴장 오후의 다음 개장은 네이버 다음 거래일 — 목록에 없는 임시공휴일(10/1)이 끼면 10/2, 목록과 다르면 경고 (3차 검토)", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src } = fakeSources({ session: "afternoon", krToday: { date: "2026-09-30", trading: false, desc: "임시공휴일", latest: "2026-09-29", next: "2026-10-02" } });
      const kr = (code: string, name: string, rate: number): MarketIndex => ({ code, name, kind: "index", value: 100, change: 1, changeRate: rate, open: false, asOf: "2026-09-29T20:15:00+09:00", stale: false });
      const warns: string[] = [];
      const svc = new MarketSummaryService({
        db: dbx,
        sources: { ...src, indices: async () => [kr("KOSPI", "코스피", 0.5), kr("KOSDAQ", "코스닥", -0.2)] },
        features: { enabled: async () => true },
        now: () => at("2026-09-30T16:00:10+09:00"),
        log: { info: () => undefined, warn: (_o, m) => void warns.push(m) },
      });
      const r = await svc.generate("afternoon", { date: "2026-09-30" });
      expect(r?.data).toMatchObject({ holiday: { date: "2026-09-30", name: "임시공휴일" }, basisDate: "2026-09-29" });
      expect(eventsText(r!.data!, at("2026-09-30T16:01:00+09:00"))).toBe("일정 · 다음 개장 10/2(금) 09:00");
      expect(warns.some((m) => m.includes("다음 개장이 출처마다 다름"))).toBe(true);
    } finally {
      await dbx.destroy();
    }
  });

  it("연휴 첫날 오후(9/24 추석 연휴): 남은 휴장일(9/25)은 다음 개장 날짜가 말해 주므로 '다음 개장 9/28(월) 09:00' 한 칸 (4차 검토)", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src } = fakeSources({ session: "afternoon", krToday: { date: "2026-09-24", trading: false, desc: "추석 연휴", latest: "2026-09-23", next: "2026-09-28" } });
      const svc = new MarketSummaryService({ db: dbx, sources: src, features: { enabled: async () => true }, now: () => at("2026-09-24T16:00:10+09:00") });
      const r = await svc.generate("afternoon", { date: "2026-09-24" });
      expect(r?.data).toMatchObject({ holiday: { date: "2026-09-24", name: "추석 연휴" }, basisDate: "2026-09-23" });
      expect(eventsText(r!.data!, at("2026-09-24T16:01:00+09:00"))).toBe("일정 · 다음 개장 9/28(월) 09:00");
    } finally {
      await dbx.destroy();
    }
  });

  it("서버를 다시 켜면(자동 배포) 장중·최종값 전 요약의 '확정 뒤 다시 만들기' 예약을 되살린다 — 이미 지났으면 곧바로, 다음 장이 열렸으면 두지 않는다 (4차 검토)", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src, calls } = fakeSources({ session: "afternoon", krToday: { date: "2026-11-19", trading: true, desc: null, latest: "2026-11-19" } });
      const t = { now: at("2026-11-19T16:00:00+09:00"), asOf: "2026-11-19T16:00:00+09:00" };
      const kr = (code: string, name: string, rate: number): MarketIndex => ({ code, name, kind: "index", value: 100, change: 1, changeRate: rate, open: true, asOf: t.asOf, stale: false });
      const sources = { ...src, indices: async () => ((calls["indices"] = (calls["indices"] ?? 0) + 1), [kr("KOSPI", "코스피", 0.5), kr("KOSDAQ", "코스닥", -0.2)]) };
      const timers: Array<{ fn: () => void; ms: number }> = [];
      const make = () => new MarketSummaryService({ db: dbx, sources, features: { enabled: async () => true }, now: () => t.now, timer: (fn, ms) => (timers.push({ fn, ms }), () => undefined) });
      // 수능일 16:00 장중 요약 → 16:35 예약 (메모리)
      expect((await make().generate("afternoon", { date: "2026-11-19" }))?.data?.phase).toBe("intraday");
      expect(timers.map((x) => x.ms)).toEqual([35 * 60_000]);
      // 16:10 에 다시 켬 (예약은 사라짐) → 켤 때 25분 뒤로 되살린다
      t.now = at("2026-11-19T16:10:00+09:00");
      const restarted = make();
      expect(await restarted.resumeRefinal()).toBe(1);
      expect(timers.map((x) => x.ms)).toEqual([35 * 60_000, 25 * 60_000]);
      // 16:40 에 다시 켬 (예약 시각이 지남) → 곧바로 다시 만들어 확정 값으로
      t.now = at("2026-11-19T16:40:00+09:00");
      t.asOf = "2026-11-19T16:31:00+09:00";
      const late = make();
      expect(await late.resumeRefinal()).toBe(1);
      expect(timers.at(-1)!.ms).toBe(0);
      timers.at(-1)!.fn();
      await new Promise((r) => setTimeout(r, 30));
      expect((await late.find("2026-11-19", "afternoon"))?.data).toMatchObject({ phase: "final", origin: "refinal" });
      // 확정 값만 남았으면 되살릴 예약이 없다
      expect(await make().resumeRefinal()).toBe(0);
      // 다음 장이 열린 뒤(11/20 10:00 뒤)라면 장중 요약이 남아 있어도 예약하지 않는다
      const dby = await createMigratedDb(":memory:");
      try {
        t.now = at("2026-11-19T16:00:00+09:00");
        t.asOf = "2026-11-19T16:00:00+09:00";
        const svcY = () => new MarketSummaryService({ db: dby, sources, features: { enabled: async () => true }, now: () => t.now, timer: (fn, ms) => (timers.push({ fn, ms }), () => undefined) });
        await svcY().generate("afternoon", { date: "2026-11-19" });
        const n = timers.length;
        t.now = at("2026-11-20T09:30:00+09:00");
        expect(await svcY().resumeRefinal()).toBe(0);
        expect(timers).toHaveLength(n);
      } finally {
        await dby.destroy();
      }
      // 플래그가 꺼져 있으면 아무것도 하지 않는다
      const off = new MarketSummaryService({ db: dbx, sources, features: { enabled: async () => false }, now: () => t.now });
      expect(await off.resumeRefinal()).toBe(0);
    } finally {
      await dbx.destroy();
    }
  });

  it("출처 조회가 실패해 남은 장중 지수 값(stale)은 '장 마감 기준' 요약에 쓰지 않는다 (서비스, 4차 검토)", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src } = fakeSources({ session: "afternoon" });
      const kr = (code: string, name: string, rate: number, asOf: string, stale: boolean): MarketIndex => ({ code, name, kind: "index", value: 100, change: 1, changeRate: rate, open: false, asOf, stale });
      const svc = new MarketSummaryService({
        db: dbx,
        sources: { ...src, indices: async () => [kr("KOSPI", "코스피", 0.4, "2026-09-23T15:25:00+09:00", true), kr("KOSDAQ", "코스닥", 1.21, "2026-09-23T20:15:00+09:00", false)] },
        features: { enabled: async () => true },
        now: () => at("2026-09-23T16:00:10+09:00"),
      });
      const d = (await svc.generate("afternoon", { date: "2026-09-23" }))!.data!;
      expect(d.indices.map((i) => i.changeRate)).toEqual([null, 1.21]);
      expect(d.notes).toContain("코스피: 출처 조회가 실패해 남은 마지막 값이 마감 전(15:25) 값이라 뺌");
      // 코스피 상장 종목은 비교 지수가 없어 비교하지 않는다 (마감 전 값과 견주지 않게)
      const h = d.holdings!;
      expect([...h.high, ...h.low, ...h.similar].some((r) => r.benchmark.code === "KOSPI")).toBe(false);
      expect(h.excluded.noBenchmark).toEqual(["삼성전자", "NAVER"]);
    } finally {
      await dbx.destroy();
    }
  });

  it("강제 재실행이 좋은 요약을 '생성 실패'로 덮지 않는다: 다음 장이 열린 뒤(한국 22:30 뒤 수동 오전 브리핑)는 다시 만들지 않고, 다시 만든 것이 실패면 먼저 것을 둔다", async () => {
    const dbx = await createMigratedDb(":memory:");
    try {
      const { src, calls } = fakeSources({ session: "morning" });
      const t = { now: at("2026-09-28T08:30:05+09:00"), broken: false };
      const svc = new MarketSummaryService({ db: dbx, sources: { ...src, indices: async () => (t.broken ? [] : src.indices()) }, features: { enabled: async () => true }, now: () => t.now });
      const first = await svc.generate("morning", { date: "2026-09-28" });
      expect(first?.status).toBe("ok");
      // 뉴욕 월요일 09:30(한국 22:30) 뒤 수동 전체 실행: 출처를 부르지 않고 먼저 것을 그대로
      t.now = at("2026-09-28T23:00:00+09:00");
      const before = calls["indices"];
      const again = await svc.afterRun({ session: "morning", date: "2026-09-28", partial: false, force: true });
      expect(again).toMatchObject({ id: first!.id, status: "ok" });
      expect(calls["indices"]).toBe(before);
      // 개장 전이라도 다시 만든 것이 실패(지수를 못 받음)면 덮지 않는다
      t.now = at("2026-09-28T12:00:00+09:00");
      t.broken = true;
      const kept = await svc.generate("morning", { date: "2026-09-28", force: true });
      expect(kept).toMatchObject({ id: first!.id, status: "ok" });
      expect((await svc.find("2026-09-28", "morning"))?.status).toBe("ok");
      expect((await svc.find("2026-09-28", "morning"))?.summary).toBe(first!.summary);
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
