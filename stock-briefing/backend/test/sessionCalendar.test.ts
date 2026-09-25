import { describe, expect, it } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Candle, CandlePeriod, Quote } from "../src/domain/types.js";
import { PromptStore } from "../src/llm/prompts.js";
import { fallbackState, MarketCalendar, stateFromSession, type MarketStatus } from "../src/providers/market/calendar.js";
import { BriefingService, type BriefingSession } from "../src/services/briefingService.js";
import { DataCollector, type BriefingSnapshot } from "../src/services/collector.js";
import { completedCandles, marketContext } from "../src/services/marketContext.js";
import { FakeGenerator, FakeNewsProvider, makeQuote } from "./helpers.js";

/**
 * 브리핑이 다루는 거래일·장 상태 (버그 점검 BH-02·05·72·06·07·31·37·39·57).
 * 휴장 판단은 "지금"이 아니라 세션이 다루는 그 시장의 현지 거래일로, 장 상태는 특수일(수능·조기 폐장)과 통합 봉 확정 시각(20:00)까지.
 */

const at = (iso: string) => new Date(iso);
const candle = (date: string, close = 1): Candle => ({ date, open: close, high: close, low: close, close, volume: 1 }) as Candle;
const st = (kr: boolean, us: boolean): MarketStatus =>
  ({ now: "", KR: { market: "KR", isTradingDay: kr, isOpen: false, opensAt: null, closesAt: null, source: "toss" }, US: { market: "US", isTradingDay: us, isOpen: false, opensAt: null, closesAt: null, source: "toss" } }) as MarketStatus;

/** 토스 시세 API 모양 (삼성전자·애플의 tradingEnd / nextTradingStart). 시장별 값은 호출 시각마다 다시 고른다 */
function tossFetch(sessions: () => { KR: [string, string]; US: [string, string] } | null) {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    const s = sessions();
    if (!s) return new Response("x", { status: 500 });
    return new Response(
      JSON.stringify({
        result: [
          { productCode: "A005930", tradingEnd: s.KR[0], nextTradingStart: s.KR[1] },
          { productCode: "US19801212001", tradingEnd: s.US[0], nextTradingStart: s.US[1] },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

const snapshot = (code: string): BriefingSnapshot => ({
  stock: { code, name: code, market: /^\d/.test(code) ? "KOSPI" : "NASDAQ", quantity: null, avgPrice: null },
  quote: null,
  recentCandles: null,
  technical: null,
  news: null,
  disclosures: null,
  investorFlow: null,
  holding: null,
  missing: [],
  notes: [],
});

/** 실제 BriefingService + 실제 MarketCalendar(토스 응답 흉내). 수집기는 종목마다 시계를 stepMs, 시작 전 일괄 조회(warm)에서 warmMs 만큼 앞으로 돌린다 */
async function setup(codes: string[], clock: { now: Date }, sessions: () => { KR: [string, string]; US: [string, string] } | null, stepMs = 0, warmMs = 0) {
  const db: Db = await createMigratedDb(":memory:");
  for (const [i, code] of codes.entries()) {
    const ts = `2026-01-01T00:00:0${i}+09:00`;
    await db.insertInto("registered_stocks").values({ code, name: code, market: /^\d/.test(code) ? "KOSPI" : "NASDAQ", quantity: null, avg_price: null, memo: null, created_at: ts, updated_at: ts }).execute();
  }
  const toss = tossFetch(sessions);
  const calendar = new MarketCalendar(toss.fetchFn, () => clock.now);
  const collector = {
    warm: async () => {
      clock.now = new Date(clock.now.getTime() + warmMs);
    },
    collectBriefing: async (s: { code: string }) => {
      clock.now = new Date(clock.now.getTime() + stepMs);
      return snapshot(s.code);
    },
  } as unknown as DataCollector;
  const svc = new BriefingService({ db, collector, generator: new FakeGenerator(), prompts: new PromptStore(), calendar, now: () => clock.now });
  const run = async (session: BriefingSession, iso: string) => {
    clock.now = at(iso);
    const r = await svc.runSession(session, { trigger: "schedule" });
    return { date: r.date, results: Object.fromEntries(r.results.map((x) => [x.code, x.error ?? x.status])) };
  };
  return { db, run, toss };
}

// 2026-09-28(월) 무렵 토스 달력: 한국은 9/28 08:00~20:00, 미국 정규장은 금 9/25 16:00 ET 마감 → 월 9/28 09:30 ET 개장
const MON = { KR: ["2026-09-28T11:00:00Z", "2026-09-28T23:00:00Z"], US: ["2026-09-25T20:00:00Z", "2026-09-28T13:30:00Z"] } as { KR: [string, string]; US: [string, string] };

describe("정기 브리핑 휴장 판단은 세션이 다루는 현지 거래일로 (BH-02·BH-05)", () => {
  it("월요일 08:30 오전 브리핑은 미국 종목도 만든다 — 금요일 정규장(토 05:00 KST 마감)을 처음 보는 오전 브리핑", async () => {
    const clock = { now: at("2026-09-28T08:30:00+09:00") }; // 뉴욕 9/27(일) 19:30
    const { run, db } = await setup(["TSLA", "005930"], clock, () => MON);
    const r = await run("morning", "2026-09-28T08:30:00+09:00");
    expect(r.results).toEqual({ TSLA: "ok", "005930": "ok" });
    await db.destroy();
  });

  it("토스 달력을 못 받아도(요일 추정) 월요일 오전 미국 종목은 휴장이 아니다", async () => {
    const clock = { now: at("2026-11-30T08:30:00+09:00") }; // 표준시: 뉴욕 11/29(일) 18:30
    const { run, db } = await setup(["AAPL", "005930"], clock, () => null);
    expect((await run("morning", "2026-11-30T08:30:00+09:00")).results).toEqual({ AAPL: "ok", "005930": "ok" });
    await db.destroy();
  });

  it("노동절(9/7 월): 월 오전은 금요일 장, 월 오후·화 오전은 휴장으로 건너뛰고, 화 오후는 만든다", async () => {
    const clock = { now: at("2026-09-07T08:30:00+09:00") };
    const cal = (kr: [string, string]) => ({ KR: kr, US: ["2026-09-04T20:00:00Z", "2026-09-08T13:30:00Z"] as [string, string] });
    const { run, db } = await setup(["AAPL", "005930"], clock, () => {
      const kst = clock.now.getTime();
      // 한국은 평일 그대로 (9/7 08:00~20:00, 9/8 08:00~20:00)
      return kst < Date.parse("2026-09-07T11:00:00Z") ? cal(["2026-09-07T11:00:00Z", "2026-09-07T23:00:00Z"]) : cal(["2026-09-08T11:00:00Z", "2026-09-08T23:00:00Z"]);
    });
    expect((await run("morning", "2026-09-07T08:30:00+09:00")).results).toEqual({ AAPL: "ok", "005930": "ok" });
    expect((await run("afternoon", "2026-09-07T16:00:00+09:00")).results).toEqual({ AAPL: "휴장일", "005930": "ok" });
    expect((await run("morning", "2026-09-08T08:30:00+09:00")).results).toEqual({ AAPL: "휴장일", "005930": "ok" });
    expect((await run("afternoon", "2026-09-08T16:00:00+09:00")).results).toEqual({ AAPL: "ok", "005930": "ok" });
    await db.destroy();
  });

  it("화~금 오전·오후는 예전 그대로, 추석(9/24~25) 한국 종목은 건너뛴다", async () => {
    const clock = { now: at("2026-09-24T08:30:00+09:00") };
    const { run, db } = await setup(["AAPL", "005930"], clock, () => ({ KR: ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], US: ["2026-09-23T20:00:00Z", "2026-09-24T13:30:00Z"] }));
    expect((await run("morning", "2026-09-24T08:30:00+09:00")).results).toEqual({ AAPL: "ok", "005930": "휴장일" });
    await db.destroy();
  });
});

describe("자정을 넘기는 세션도 세션 날짜 하나로 판단 (BH-72)", () => {
  // 10/16(금) 밤: 한국은 금 20:00 마감 → 월 10/19 08:00, 미국은 금요일 정규장 중(마감 금 16:00 ET)
  const FRI = { KR: ["2026-10-16T11:00:00Z", "2026-10-18T23:00:00Z"], US: ["2026-10-16T20:00:00Z", "2026-10-19T13:30:00Z"] } as { KR: [string, string]; US: [string, string] };

  it("금요일 23:58 에 시작해 자정을 넘겨도 뒤쪽 국내 종목이 '휴장일'로 빠지지 않는다", async () => {
    const codes = ["000660", "005930", "035420", "AAPL", "051910", "068270", "105560"];
    const clock = { now: at("2026-10-16T23:58:30+09:00") };
    const { run, db, toss } = await setup(codes, clock, () => FRI, 2 * 60_000);
    const r = await run("afternoon", "2026-10-16T23:58:30+09:00");
    expect(r.date).toBe("2026-10-16");
    expect(clock.now.getTime()).toBeGreaterThan(Date.parse("2026-10-17T00:06:00+09:00")); // 달력 캐시(5분)가 자정 뒤에 끝나는 길이
    expect(r.results).toEqual(Object.fromEntries(codes.map((c) => [c, "ok"])));
    expect(toss.calls()).toBeGreaterThanOrEqual(1);
    await db.destroy();
  });

  it("일요일 23:58 에 시작하면(평일만 끔) 자정을 넘긴 뒤 판단해도 일요일 세션이라 건너뛴다 (월요일 거래일로 보지 않는다)", async () => {
    const codes = ["000660", "005930", "035420", "051910"];
    const clock = { now: at("2026-10-18T23:58:30+09:00") };
    // 시작 전 일괄 시세 조회가 느려 첫 휴장 판단이 월요일 00:04 에 일어나는 경우
    const { run, db } = await setup(codes, clock, () => FRI, 2 * 60_000, 6 * 60_000);
    const r = await run("afternoon", "2026-10-18T23:58:30+09:00");
    expect(r.date).toBe("2026-10-18");
    expect(r.results).toEqual(Object.fromEntries(codes.map((c) => [c, "휴장일"])));
    await db.destroy();
  });
});

describe("달력 계약: 미국 isOpen 은 정규장(09:30~16:00 ET)만 — 토스 달력과 추정값이 같은 뜻 (BH-07)", () => {
  it("프리마켓·애프터마켓 시각에는 토스 달력도 추정값(fallback)도 닫힘, 정규장은 열림", () => {
    const pre = at("2026-09-25T06:00:00-04:00");
    const after = at("2026-09-24T17:30:00-04:00");
    const regular = at("2026-09-25T10:00:00-04:00");
    expect(stateFromSession("US", pre, "2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z").isOpen).toBe(false);
    expect(fallbackState("US", pre).isOpen).toBe(false);
    expect(stateFromSession("US", after, "2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z").isOpen).toBe(false);
    expect(fallbackState("US", after).isOpen).toBe(false);
    expect(stateFromSession("US", regular, "2026-09-25T20:00:00Z", "2026-09-28T13:30:00Z").isOpen).toBe(true); // 정규장 중: 오늘 마감 → 다음 개장
    expect(fallbackState("US", regular)).toMatchObject({ isTradingDay: true, isOpen: true });
  });

  it("추정값도 미국 휴장일(US_HOLIDAYS)·조기 폐장(13:00 ET)을 안다", () => {
    expect(fallbackState("US", at("2026-11-26T10:00:00-05:00"))).toMatchObject({ isTradingDay: false, isOpen: false }); // 추수감사절
    expect(fallbackState("US", at("2026-11-27T12:00:00-05:00")).isOpen).toBe(true);
    expect(fallbackState("US", at("2026-11-27T14:00:00-05:00"))).toMatchObject({ isTradingDay: true, isOpen: false });
  });
});

describe("한국 특수일(수능일 10:00~16:30) 정규장 (BH-06)", () => {
  it("2026-11-19 16:00 은 정규장 진행 중 — '15:30 마감'이 아니고, 진행 중인 오늘 봉은 지표에서 뺀다", () => {
    const now = at("2026-11-19T16:00:00+09:00");
    const ctx = marketContext("005930", st(true, true), now);
    expect(ctx).toMatchObject({ market: "KR", phase: "regular", todayIncomplete: true });
    expect(ctx.label).toContain("16:30");
    expect(ctx.label).not.toContain("15:30");
    expect(completedCandles([candle("2026-11-17"), candle("2026-11-18"), candle("2026-11-19")], ctx, now).map((c) => c.date)).toEqual(["2026-11-17", "2026-11-18"]);
  });

  it("수능일 09:30 은 아직 개장 전, 16:40 은 16:30 에 끝난 정규장 뒤 애프터마켓", () => {
    const early = marketContext("005930", st(true, true), at("2026-11-19T09:30:00+09:00"));
    expect(early.phase).not.toBe("regular");
    expect(early.label).toContain("10:00");
    expect(early.todayIncomplete).toBe(true);
    const after = marketContext("005930", st(true, true), at("2026-11-19T16:40:00+09:00"));
    expect(after).toMatchObject({ phase: "extended", lastRegularDate: "2026-11-19", todayIncomplete: true });
    expect(after.label).toContain("16:30 에 마감");
  });

  it("평소 날은 그대로 09:00~15:30", () => {
    expect(marketContext("005930", st(true, true), at("2026-11-18T09:30:00+09:00")).phase).toBe("regular");
    expect(marketContext("005930", st(true, true), at("2026-11-18T15:40:00+09:00")).label).toContain("15:30 에 마감");
  });
});

describe("한국 애프터마켓(15:30~20:00): 통합(KRX+NXT) 일봉은 20:00 에 확정 — 오늘 봉을 끝난 봉으로 쓰지 않는다 (BH-31·BH-37)", () => {
  it("16:00 오후 브리핑 시각: 오늘 봉은 지표·최근 봉에서 빼고, 라벨이 그 사실과 '지금 가격은 종가가 아님'을 말한다", () => {
    const now = at("2026-09-28T16:00:00+09:00");
    const ctx = marketContext("005930", st(true, true), now);
    expect(ctx).toMatchObject({ market: "KR", phase: "extended", lastRegularDate: "2026-09-28", todayIncomplete: true });
    expect(ctx.label).toContain("20:00");
    expect(ctx.label).toContain("종가가 아닙니다");
    expect(completedCandles([candle("2026-09-25"), candle("2026-09-28")], ctx, now).map((c) => c.date)).toEqual(["2026-09-25"]);
    // 20:00 이 지나면 확정된 오늘 봉을 쓴다
    const night = at("2026-09-28T20:30:00+09:00");
    const done = marketContext("005930", st(true, true), night);
    expect(done.todayIncomplete).toBe(false);
    expect(completedCandles([candle("2026-09-25"), candle("2026-09-28")], done, night)).toHaveLength(2);
  });

  it("수집기: 16:00 브리핑·기술적 분석 모두 오늘(9/28) 통합 봉을 빼고 9/25 까지로 계산한다", async () => {
    const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10)).filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    const series = [...days.filter((d) => d < "2026-09-25"), "2026-09-25", "2026-09-28"].map((d, i) => candle(d, 70_000 + i * 10));
    const quotes = {
      name: "fake",
      getQuote: async (code: string): Promise<Quote> => makeQuote(code, "fake", 70_500),
      getCandles: async (code: string, period: CandlePeriod) => ({ code, period, candles: series, source: "fake" }),
    };
    const now = () => at("2026-09-28T16:00:00+09:00");
    const c = new DataCollector({ quotes, news: new FakeNewsProvider(), financials: null, financialsUs: null, investorFlow: null, now, calendar: { status: async () => st(true, true) } });
    const b = await c.collectBriefing({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: null, avgPrice: null, memo: null, createdAt: "", updatedAt: "" });
    expect(b.recentCandles!.at(-1)!.date).toBe("2026-09-25");
    expect(b.technical!.asOfDate).toBe("2026-09-25");
    const a = await c.collectAnalysis({ code: "005930", name: "삼성전자", market: "KOSPI" }, "technical");
    expect(a.technical!.asOfDate).toBe("2026-09-25");
  });
});

describe("미국 조기 폐장(11/27·12/24 13:00 ET) (BH-39)", () => {
  it("13:00 전은 정규장, 13:00~17:00 은 애프터마켓이고 끝난 오늘 봉은 지표에 넣는다", () => {
    const reg = marketContext("AAPL", null, at("2026-11-27T12:00:00-05:00"));
    expect(reg).toMatchObject({ phase: "regular", todayIncomplete: true });
    expect(reg.label).toContain("13:00");
    const now = at("2026-11-27T14:00:00-05:00"); // 한국 11/28 04:00
    const after = marketContext("AAPL", null, now);
    expect(after).toMatchObject({ phase: "extended", lastRegularDate: "2026-11-27", todayIncomplete: false });
    expect(after.label).not.toContain("진행 중");
    expect(after.label).toContain("애프터마켓");
    expect(completedCandles([candle("2026-11-25"), candle("2026-11-27")], after, now).map((c) => c.date)).toEqual(["2026-11-25", "2026-11-27"]);
    // 토스 달력이 알려 준 마감(13:00 EST = 18:00Z)도 같은 결과
    const cal = { now: "", KR: st(true, true).KR, US: stateFromSession("US", at("2026-12-24T14:00:00-05:00"), "2026-12-24T18:00:00Z", "2026-12-28T14:30:00Z") } as MarketStatus;
    expect(marketContext("AAPL", cal, at("2026-12-24T14:00:00-05:00"))).toMatchObject({ phase: "extended", lastRegularDate: "2026-12-24", todayIncomplete: false });
  });

  it("12/25(금) 08:30 KST 정기 오전 브리핑(뉴욕 12/24 18:30)은 조기 폐장일 애프터마켓(17:00 까지)이 끝난 뒤", () => {
    const ctx = marketContext("AAPL", st(true, true), at("2026-12-25T08:30:00+09:00"));
    expect(ctx).toMatchObject({ phase: "closed", lastRegularDate: "2026-12-24" });
    expect(ctx.label).not.toContain("애프터마켓 중");
  });
});

describe("미국 주간거래는 뉴욕 20:00~04:00 — 서머타임 한국 09:00~10:00·표준시 17:30~18:00 도 '마감 상태'가 아님 (BH-57)", () => {
  it.each(["2026-09-29T09:05:00+09:00", "2026-09-29T09:45:00+09:00", "2026-11-10T17:35:00+09:00", "2026-11-10T17:55:00+09:00"])("%s", (iso) => {
    for (const status of [null, st(true, true)]) {
      const ctx = marketContext("AAPL", status, at(iso));
      expect(ctx.phase).toBe("extended");
      expect(ctx.label).toContain("주간거래");
      expect(ctx.label).not.toContain("마감 상태");
    }
  });
});
