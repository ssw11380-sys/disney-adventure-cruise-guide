import { describe, expect, it } from "vitest";
import { completedCandles, marketContext, tradingDate } from "../src/services/marketContext.js";
import type { MarketStatus } from "../src/providers/market/calendar.js";
import type { Candle } from "../src/domain/types.js";
import { NotListedError } from "../src/lib/errors.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeNewsProvider, FakeQuoteProvider } from "./helpers.js";

const st = (kr: boolean, us: boolean): MarketStatus =>
  ({ now: "", KR: { market: "KR", isTradingDay: kr, isOpen: false, opensAt: null, closesAt: null, source: "toss" }, US: { market: "US", isTradingDay: us, isOpen: false, opensAt: null, closesAt: null, source: "toss" } }) as MarketStatus;
const candle = (date: string): Candle => ({ date, open: 1, high: 1, low: 1, close: 1, volume: 1 }) as Candle;
const at = (iso: string) => new Date(iso);

describe("장 상태 (3-11)", () => {
  it("한국 정규장 중: 오늘 봉은 끝나지 않았으니 지표에서 뺀다", () => {
    const now = at("2026-09-24T10:30:00+09:00");
    const ctx = marketContext("005930", st(true, true), now);
    expect(ctx).toMatchObject({ market: "KR", phase: "regular", todayIncomplete: true });
    expect(ctx.label).toContain("정규장 진행 중");
    expect(completedCandles([candle("2026-09-23"), candle("2026-09-24")], ctx, now).map((c) => c.date)).toEqual(["2026-09-23"]);
  });

  it("한국 15:30 이후 NXT 애프터마켓: 오늘 정규장은 끝났으니 오늘 봉을 쓴다", () => {
    const now = at("2026-09-24T16:10:00+09:00");
    const ctx = marketContext("005930", st(true, true), now);
    expect(ctx).toMatchObject({ phase: "extended", lastRegularDate: "2026-09-24", todayIncomplete: false });
    expect(ctx.label).toContain("9/24");
    expect(ctx.label).toContain("애프터마켓");
    expect(completedCandles([candle("2026-09-23"), candle("2026-09-24")], ctx, now)).toHaveLength(2);
  });

  it("한국 NXT 프리마켓(08:30)과 휴장일", () => {
    const pre = marketContext("005930", st(true, true), at("2026-09-24T08:30:00+09:00"));
    expect(pre).toMatchObject({ phase: "extended", todayIncomplete: true });
    const holiday = marketContext("005930", st(false, true), at("2026-09-24T11:00:00+09:00"));
    expect(holiday.phase).toBe("closed");
    expect(holiday.label).toContain("휴장일");
  });

  it("미국 주간거래(한국 낮 15:00): 정규장은 전날 밤 끝났고 가격은 주간거래 값 — '마감'이 아님", () => {
    // 한국 9/24(목) 15:00 = 뉴욕 9/24 02:00. 마지막 정규장은 9/23(수)
    const now = at("2026-09-24T15:00:00+09:00");
    const ctx = marketContext("AAPL", st(true, true), now);
    expect(ctx).toMatchObject({ market: "US", phase: "extended", lastRegularDate: "2026-09-23", todayIncomplete: false });
    expect(ctx.label).toContain("주간거래");
    expect(ctx.label).toContain("마지막 정규장은 9/23");
    // 주간거래로 생긴 9/24 봉은 지표에서 뺀다
    expect(completedCandles([candle("2026-09-22"), candle("2026-09-23"), candle("2026-09-24")], ctx, now).map((c) => c.date)).toEqual(["2026-09-22", "2026-09-23"]);
  });

  it("미국 정규장·프리·애프터 (토스 달력의 isOpen 은 프리~애프터를 모두 포함하므로 뉴욕 시각으로 가린다)", () => {
    const open = { ...st(true, true), US: { ...st(true, true).US, isOpen: true } };
    expect(marketContext("AAPL", open, at("2026-09-24T11:00:00-04:00"))).toMatchObject({ phase: "regular", todayIncomplete: true });
    expect(marketContext("AAPL", open, at("2026-09-24T05:00:00-04:00"))).toMatchObject({ phase: "extended", lastRegularDate: "2026-09-23" });
    const after = marketContext("AAPL", open, at("2026-09-24T17:00:00-04:00"));
    expect(after).toMatchObject({ phase: "extended", lastRegularDate: "2026-09-24" });
    expect(after.label).toContain("애프터마켓");
    expect(marketContext("AAPL", st(true, true), at("2026-09-26T12:00:00+09:00")).phase).toBe("closed"); // 토요일
  });

  it("미국 휴장일: 노동절 다음 날엔 마지막 정규장이 금요일, 추수감사절엔 주간거래가 없다 (리뷰 2·4)", () => {
    // 9/8(화) 한국 15:00 = 뉴욕 9/8 02:00, 9/7(월)은 노동절 → 마지막 정규장 9/4(금)
    const ctx = marketContext("AAPL", st(true, true), at("2026-09-08T15:00:00+09:00"));
    expect(ctx).toMatchObject({ phase: "extended", lastRegularDate: "2026-09-04" });
    expect(ctx.label).toContain("9/4");
    // 추수감사절 11/26 한국 16:00 = 뉴욕 11/26 03:00 → 주간거래 아님
    const tg = marketContext("AAPL", null, at("2026-11-26T16:00:00+09:00"));
    expect(tg.phase).toBe("closed");
    expect(tg.lastRegularDate).toBe("2026-11-25");
    // 주간거래는 다음 날 정규장에 딸린다: 월요일 한국 10:30(뉴욕 일요일 밤)은 주간거래 중, 추수감사절 한국 11:00(뉴욕 수요일 밤)은 아님
    expect(marketContext("AAPL", null, at("2026-09-28T10:30:00+09:00")).phase).toBe("extended");
    expect(marketContext("AAPL", null, at("2026-11-26T11:00:00+09:00")).phase).toBe("closed");
    expect(marketContext("AAPL", null, at("2026-09-08T11:00:00+09:00")).phase).toBe("extended"); // 노동절 다음 날 한국 낮
  });

  it("한국 08:50~09:00 은 NXT 프리마켓이 아니라 개장 직전", () => {
    expect(marketContext("005930", st(true, true), at("2026-09-23T08:55:00+09:00")).label).toBe("한국 정규장 개장 직전");
  });

  it("달력을 못 받으면 요일·시각으로 추정한다", () => {
    expect(marketContext("005930", null, at("2026-09-24T10:00:00+09:00")).phase).toBe("regular");
    expect(marketContext("AAPL", null, at("2026-09-24T15:00:00+09:00")).phase).toBe("extended");
  });
});

describe("체결·시세의 거래일 (앱 lib/marketTime.tradingDate 와 같은 규칙)", () => {
  it("미국은 뉴욕 20:00 부터(주간거래) 다음 날, 주말은 직전 금요일, 한국은 서울 날짜", () => {
    // EDT(-4): 9/24(목) 19:59 → 9/24, 20:00 → 9/25, 9/25 00:30 → 9/25
    expect(tradingDate("2026-09-25T08:59:00+09:00", false)).toBe("2026-09-24");
    expect(tradingDate("2026-09-25T09:00:00+09:00", false)).toBe("2026-09-25");
    expect(tradingDate("2026-09-25T13:30:00+09:00", false)).toBe("2026-09-25");
    // EST(-5): 1/15(목) 19:59 → 1/15, 20:00 → 1/16
    expect(tradingDate("2026-01-16T00:59:00Z", false)).toBe("2026-01-15");
    expect(tradingDate("2026-01-16T01:00:00Z", false)).toBe("2026-01-16");
    // 주말: 금 20:00 ~ 일 20:00 전은 금요일, 일 20:00 부터 월요일
    expect(tradingDate("2026-09-26T10:30:00+09:00", false)).toBe("2026-09-25");
    expect(tradingDate("2026-09-28T08:59:00+09:00", false)).toBe("2026-09-25");
    expect(tradingDate("2026-09-28T09:00:00+09:00", false)).toBe("2026-09-28");
    expect(tradingDate("2026-09-24T20:30:00+09:00", true)).toBe("2026-09-24");
    expect(tradingDate("2026-09-23T23:30:00Z", true)).toBe("2026-09-24");
    expect(tradingDate("2026-09-26T10:00:00+09:00", true)).toBe("2026-09-25");
  });

  it("한국 00:00~08:00 은 직전 거래일 — 장 시작 전에 받은 시세(받은 시각이 asOf)와 08:00 첫 체결을 다른 거래일로 본다", () => {
    expect(tradingDate("2026-09-24T07:59:30+09:00", true)).toBe("2026-09-23");
    expect(tradingDate("2026-09-24T08:00:05+09:00", true)).toBe("2026-09-24");
    expect(tradingDate("2026-09-23T22:59:30Z", true)).toBe("2026-09-23");
    expect(tradingDate("2026-09-28T07:00:00+09:00", true)).toBe("2026-09-25"); // 월 새벽 → 금
  });

  it("미국 휴장일(US_HOLIDAYS)은 직전 거래일 — 추수감사절 전날 밤 20:00 이후는 주간거래가 없다", () => {
    expect(tradingDate("2026-11-26T10:30:00+09:00", false)).toBe("2026-11-25"); // 뉴욕 11/25 20:30
    expect(tradingDate("2026-11-27T02:00:00+09:00", false)).toBe("2026-11-25"); // 뉴욕 11/26 12:00
    expect(tradingDate("2026-11-27T10:30:00+09:00", false)).toBe("2026-11-27"); // 뉴욕 11/26 20:30 → 금요일 세션
    expect(tradingDate("2026-09-07T10:00:00+09:00", false)).toBe("2026-09-04"); // 뉴욕 일 21:00 → 월 노동절 → 금
  });
});

describe("수집기: 제공되지 않는 데이터는 notes, 끝나지 않은 봉은 지표에서 제외 (3-11)", () => {
  it("SEC 에 없는 ETF 는 공시·재무가 실패가 아니라 notes 로, 분석 지표도 끝난 봉까지만", async () => {
    const quotes = new FakeQuoteProvider("fake");
    const notListed = () => Promise.reject(new NotListedError("sec-edgar", "SEC 에 등록된 티커가 아닙니다: QQQI"));
    const edgar = { name: "sec-edgar", getCompany: notListed, getDisclosures: notListed, getAnnualFinancials: notListed, getDividends: notListed };
    const now = () => at("2026-09-24T15:00:00+09:00"); // 미국 주간거래 시간
    const c = new DataCollector({ quotes, news: new FakeNewsProvider(), financials: null, financialsUs: edgar, investorFlow: null, now, calendar: { status: async () => st(true, true) } });
    const b = await c.collectBriefing({ code: "QQQI", name: "QQQI", market: "NASDAQ", quantity: null, avgPrice: null, memo: null, createdAt: "", updatedAt: "" });
    expect(b.missing).toEqual([]);
    expect(b.disclosures).toEqual([]);
    expect(b.notes).toHaveLength(2);
    expect(b.notes).toEqual(expect.arrayContaining(["공시: SEC 에서 찾지 못한 종목(ETF 등)이라 해당 없음", "수급: 미국 종목은 투자자별 매매 동향이 제공되지 않음"]));
    expect(b.marketState?.phase).toBe("extended");
    for (const kind of ["company", "value"] as const) {
      const a = await c.collectAnalysis({ code: "QQQI", name: "QQQI", market: "NASDAQ" }, kind);
      expect(a.missing.filter((m) => /회사 개요|재무제표|배당|공시/.test(m))).toEqual([]);
      expect(a.notes!.length).toBeGreaterThan(0);
    }
  });
});
