import { describe, expect, it, vi } from "vitest";
import { fallbackState, MarketCalendar, stateFromSession, type MarketStatus } from "../src/providers/market/calendar.js";
import { anySessionOpen, sessionAt } from "../src/services/liveSession.js";

describe("달력 조회 실패와 날짜 경계의 추가 점검", () => {
  it("한국 휴장일 서버 첫 기동에서도 휴장으로 표시하고 반복 시세 조회를 열지 않는다", () => {
    const now = new Date("2026-09-25T10:00:00+09:00");
    const calendar: MarketStatus = { now: now.toISOString(), KR: fallbackState("KR", now), US: fallbackState("US", now) };
    expect(sessionAt("005930", now, { calendar })).toMatchObject({ phase: "holiday", open: false });
    expect(anySessionOpen(["005930"], calendar, now)).toBe(false);
    expect(anySessionOpen(["005930", "AAPL"], calendar, now)).toBe(true);
  });

  it("다음 한국 개장 추정에서 주말 뒤 휴장일도 건너뛴다", () => {
    const now = new Date("2026-10-02T20:30:00+09:00");
    const session = sessionAt("005930", now);
    expect(session.open).toBe(false);
    expect(session.until).toBe(new Date("2026-10-06T08:00:00+09:00").toISOString());
  });

  it("기존 토스 달력과 목록이 한국 휴장일에 충돌하면 다른 달력 경로처럼 휴장을 따른다", () => {
    const now = new Date("2026-09-25T10:00:00+09:00");
    const calendar: MarketStatus = {
      now: now.toISOString(),
      KR: stateFromSession("KR", now, "2026-09-25T20:00:00+09:00", "2026-09-28T08:00:00+09:00"),
      US: fallbackState("US", now),
    };
    expect(sessionAt("005930", now, { calendar })).toMatchObject({ phase: "holiday", open: false });
  });

  it.each([
    ["한국 개장", "2026-10-06T07:59:00+09:00", "2026-10-06T08:00:00+09:00", "KR", false, true],
    ["한국 마감", "2026-10-06T19:59:00+09:00", "2026-10-06T20:00:00+09:00", "KR", true, false],
    ["미국 조기 마감", "2026-11-27T12:59:00-05:00", "2026-11-27T13:00:00-05:00", "US", true, false],
  ] as const)("달력 실패 캐시 중 %s 경계는 재요청 없이 현재 시간으로 반영한다", async (_label, before, after, market, wasOpen, isOpen) => {
    let now = new Date(before);
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const calendar = new MarketCalendar(fetcher, () => now);
    expect((await calendar.status())[market].isOpen).toBe(wasOpen);
    now = new Date(after);
    expect((await calendar.status())[market].isOpen).toBe(isOpen);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("자정을 지난 토스 캐시가 새 now와 전날 거래일 여부를 함께 반환하지 않는다", async () => {
    let now = new Date("2026-10-02T23:59:00+09:00");
    const fetcher = vi.fn(async () => Response.json({ result: [
      { productCode: "A005930", tradingEnd: "2026-10-02T20:00:00+09:00", nextTradingStart: "2026-10-06T08:00:00+09:00" },
    ] }));
    const calendar = new MarketCalendar(fetcher, () => now);
    expect((await calendar.status()).KR.isTradingDay).toBe(true);
    now = new Date("2026-10-03T00:00:00+09:00");
    const fresh = await calendar.status();
    expect(fresh.now).toBe(now.toISOString());
    expect(fresh.KR.isTradingDay).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("캐시 안의 미국 현지 자정도 현재 날짜로 갱신하고 정상 조회 TTL과 동시 요청 공유는 유지한다", async () => {
    let now = new Date("2026-11-26T23:59:00-05:00");
    const fetcher = vi.fn(async () => Response.json({ result: [
      { productCode: "US19801212001", tradingEnd: "2026-11-25T16:00:00-05:00", nextTradingStart: "2026-11-27T09:30:00-05:00" },
    ] }));
    const calendar = new MarketCalendar(fetcher, () => now);
    const first = await Promise.all([calendar.status(), calendar.status()]);
    expect(first.every((s) => !s.US.isTradingDay)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = new Date("2026-11-27T00:00:00-05:00");
    expect((await calendar.status()).US).toMatchObject({ isTradingDay: true, isOpen: false });
    now = new Date("2026-11-27T00:03:59-05:00");
    await calendar.status();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = new Date("2026-11-27T00:04:00-05:00");
    await Promise.all([calendar.status(), calendar.status()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
