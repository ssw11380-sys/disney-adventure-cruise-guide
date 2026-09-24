import { describe, expect, it } from "vitest";
import { completedCandles, marketContext } from "../src/services/marketContext.js";
import type { MarketStatus } from "../src/providers/market/calendar.js";
import type { Candle } from "../src/domain/types.js";

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

  it("휴장일이 끼면 마지막 봉 날짜(hint)로 날짜를 맞춘다", () => {
    // 월요일 휴장 뒤 화요일 한국 낮: 요일 계산은 9/7(월)이지만 실제 마지막 정규장은 9/4(금)
    const ctx = marketContext("AAPL", st(true, true), at("2026-09-08T15:00:00+09:00"), "2026-09-04");
    expect(ctx.label).toContain("9/4");
  });

  it("달력을 못 받으면 요일·시각으로 추정한다", () => {
    expect(marketContext("005930", null, at("2026-09-24T10:00:00+09:00")).phase).toBe("regular");
    expect(marketContext("AAPL", null, at("2026-09-24T15:00:00+09:00")).phase).toBe("extended");
  });
});
