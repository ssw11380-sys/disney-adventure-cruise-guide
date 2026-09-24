import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Candle, CandleSeries, MarketStatus } from "@/api/types";
import type { StreamTick } from "@/lib/liveTick";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { applyTickToCandles } = await import("@/lib/chartPrefs");

const candle = (date: string, close: number, extra: Partial<Candle> = {}): Candle => ({ date, open: close, high: close, low: close, close, volume: 100, ...extra });
const dates = (cs: Candle[]) => cs.map((c) => c.date);

describe("미국 일봉은 뉴욕 거래일로 (PF-02)", () => {
  const day = [candle("2026-09-24", 200)];

  it("한국 자정 이후(뉴욕 9/24 12시) 체결은 9/24 봉 하나의 종가를 바꾼다", () => {
    const next = applyTickToCandles(day, "D", 201, "2026-09-25T01:00:00+09:00", "AAPL");
    expect(dates(next)).toEqual(["2026-09-24"]);
    expect(next[0]!.close).toBe(201);
    expect(next[0]!.high).toBe(201);
  });

  it("같은 순간을 Z 로 적어도 같은 결과", () => {
    expect(applyTickToCandles(day, "D", 201, "2026-09-24T16:00:00Z", "AAPL")).toEqual(applyTickToCandles(day, "D", 201, "2026-09-25T01:00:00+09:00", "AAPL"));
  });

  it("새 미국 거래일 시작(뉴욕 9/25 09:30)에는 새 일봉", () => {
    const next = applyTickToCandles(day, "D", 202, "2026-09-25T22:30:05+09:00", "AAPL");
    expect(dates(next)).toEqual(["2026-09-24", "2026-09-25"]);
    expect(next[0]).toBe(day[0]);
  });

  it("서머타임 적용/비적용: 뉴욕 20:00 전 체결은 그날 봉, 20:00 부터(주간거래)는 다음 거래일 봉", () => {
    // 겨울 EST: 00:59Z = 1/15 19:59 → 1/15 봉, 01:00Z = 1/15 20:00 → 1/16 봉 / 여름 EDT: 23:59Z = 7/15 19:59 → 7/15 봉, 00:00Z = 20:00 → 7/16 봉
    expect(dates(applyTickToCandles([candle("2026-01-15", 50)], "D", 51, "2026-01-16T00:59:00Z", "AAPL"))).toEqual(["2026-01-15"]);
    expect(dates(applyTickToCandles([candle("2026-01-15", 50)], "D", 51, "2026-01-16T01:00:00Z", "AAPL"))).toEqual(["2026-01-15", "2026-01-16"]);
    expect(dates(applyTickToCandles([candle("2026-07-15", 50)], "D", 51, "2026-07-15T23:59:00Z", "AAPL"))).toEqual(["2026-07-15"]);
    expect(dates(applyTickToCandles([candle("2026-07-15", 50)], "D", 51, "2026-07-16T00:00:00Z", "AAPL"))).toEqual(["2026-07-15", "2026-07-16"]);
  });

  it("국내 08~09시 체결을 UTC 로 적어도 서울 날짜(다음 날) 봉", () => {
    const next = applyTickToCandles([candle("2026-09-23", 100)], "D", 101, "2026-09-23T23:30:00Z", "005930");
    expect(dates(next)).toEqual(["2026-09-23", "2026-09-24"]);
    expect(next[0]!.close).toBe(100);
  });
});

describe("미국 주간거래(한국 낮) 체결은 다음 거래일 봉 — 토스·서버 봉과 같게 (PF-02·03 검증 지적)", () => {
  const cs = [candle("2026-09-23", 190), candle("2026-09-24", 200)];

  it("끝난 목요일 정규장 봉을 고치지 않고 금요일 봉을 새로 연다 (금 10:30 KST = 뉴욕 목 21:30)", () => {
    const next = applyTickToCandles(cs, "D", 210, "2026-09-25T10:30:00+09:00", "AAPL");
    expect(dates(next)).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(next[1]).toBe(cs[1]);
    expect(next[2]).toMatchObject({ open: 210, high: 210, low: 210, close: 210, volumeUnknown: true });
  });

  it("서버가 이미 연 주간거래 봉(9/25)은 체결로 계속 갱신된다 (뉴욕 자정을 넘겨도, 이어지는 정규장도 같은 봉)", () => {
    const withDay = [...cs, candle("2026-09-25", 205, { volume: 3 })];
    const a = applyTickToCandles(withDay, "D", 210, "2026-09-25T10:30:00+09:00", "AAPL");
    expect(a).toHaveLength(3);
    expect(a[1]).toBe(cs[1]);
    expect(a[2]).toMatchObject({ date: "2026-09-25", close: 210, high: 210, volume: 3 });
    const b = applyTickToCandles(a, "D", 207, "2026-09-25T13:30:00+09:00", "AAPL"); // 뉴욕 9/25 00:30
    expect(b.at(-1)).toMatchObject({ date: "2026-09-25", close: 207, high: 210 });
    expect(applyTickToCandles(b, "D", 212, "2026-09-25T22:30:00+09:00", "AAPL")).toHaveLength(3); // 뉴욕 9/25 09:30
  });

  it("주봉: 월요일 10:30 KST(뉴욕 일요일 21:30) 체결은 지난주 봉을 고치지 않고 새 주 봉", () => {
    const week = [candle("2026-09-21", 100)];
    const next = applyTickToCandles(week, "W", 120, "2026-09-28T10:30:00+09:00", "AAPL");
    expect(dates(next)).toEqual(["2026-09-21", "2026-09-28"]);
    expect(next[0]).toBe(week[0]);
  });

  it("월봉: 10/1 10:30 KST(뉴욕 9/30 21:30) 체결은 9월 봉을 고치지 않고 10월 봉", () => {
    const month = [candle("2026-09-01", 100)];
    const next = applyTickToCandles(month, "M", 120, "2026-10-01T10:30:00+09:00", "AAPL");
    expect(dates(next)).toEqual(["2026-09-01", "2026-10-01"]);
    expect(next[0]).toBe(month[0]);
  });

  it("주말에 온 체결(토 10:30 KST = 뉴욕 금 21:30, 한국 토요일)은 새 봉을 만들지 않는다 — 금요일 봉이고 값이 같으면 그대로", () => {
    const fri = [candle("2026-09-24", 200), candle("2026-09-25", 205)];
    expect(applyTickToCandles(fri, "D", 205, "2026-09-26T10:30:00+09:00", "AAPL")).toBe(fri);
    expect(applyTickToCandles(fri, "D", 205, "2026-09-26T15:00:00+09:00", "005930")).toBe(fri);
  });
});

describe("새 주·월 체결은 지난 봉을 바꾸지 않고 새 봉 (PF-03)", () => {
  it("주봉: 9/21 주 → 9/28(월) 체결은 새 봉, 지난 봉 보존", () => {
    const week = [candle("2026-09-21", 100)];
    const next = applyTickToCandles(week, "W", 110, "2026-09-28T10:00:00+09:00", "005930");
    expect(dates(next)).toEqual(["2026-09-21", "2026-09-28"]);
    expect(next[0]).toEqual(candle("2026-09-21", 100));
    expect(next[1]).toMatchObject({ open: 110, high: 110, low: 110, close: 110 });
  });

  it("월봉: 9/1 월 → 10/1 체결은 새 봉", () => {
    const month = [candle("2026-09-01", 100)];
    const next = applyTickToCandles(month, "M", 110, "2026-10-01T10:00:00+09:00", "005930");
    expect(dates(next)).toEqual(["2026-09-01", "2026-10-01"]);
    expect(next[0]!.close).toBe(100);
  });

  it("금요일은 같은 주 봉 갱신, 월요일은 새 주", () => {
    const week = [candle("2026-09-21", 100)];
    const fri = applyTickToCandles(week, "W", 105, "2026-09-25T15:00:00+09:00", "005930");
    expect(fri).toHaveLength(1);
    expect(fri[0]).toMatchObject({ date: "2026-09-21", close: 105, high: 105 });
    expect(dates(applyTickToCandles(fri, "W", 107, "2026-09-28T09:00:00+09:00", "005930"))).toEqual(["2026-09-21", "2026-09-28"]);
  });

  it("연말 → 연초: 같은 주(12/28 주의 12/30)는 갱신, 새해 첫 주·새 달은 새 봉", () => {
    const week = [candle("2026-12-28", 100)];
    expect(applyTickToCandles(week, "W", 101, "2026-12-30T10:00:00+09:00", "005930")).toHaveLength(1);
    expect(dates(applyTickToCandles(week, "W", 101, "2027-01-04T09:00:00+09:00", "005930"))).toEqual(["2026-12-28", "2027-01-04"]);
    expect(dates(applyTickToCandles([candle("2026-12-01", 100)], "M", 101, "2027-01-04T09:00:00+09:00", "005930"))).toEqual(["2026-12-01", "2027-01-04"]);
  });

  it("같은 주·월의 후속 날짜는 마지막 봉만 갱신", () => {
    expect(applyTickToCandles([candle("2026-09-21", 100)], "W", 101, "2026-09-23T10:00:00+09:00", "005930")).toMatchObject([{ date: "2026-09-21", close: 101 }]);
    expect(applyTickToCandles([candle("2026-09-01", 100)], "M", 99, "2026-09-24T10:00:00+09:00", "005930")).toMatchObject([{ date: "2026-09-01", close: 99, low: 99 }]);
  });

  it("미국 월봉은 뉴욕 날짜로: 10/1 02:00 KST(뉴욕 9/30 13:00) 체결은 9월 봉", () => {
    const next = applyTickToCandles([candle("2026-09-01", 100)], "M", 101, "2026-10-01T02:00:00+09:00", "AAPL");
    expect(next).toMatchObject([{ date: "2026-09-01", close: 101 }]);
  });

  it("지난 기간의 늦은 체결은 무시", () => {
    const week = [candle("2026-09-21", 100), candle("2026-09-28", 110)];
    expect(applyTickToCandles(week, "W", 90, "2026-09-25T15:00:00+09:00", "005930")).toBe(week);
  });
});

describe("실시간으로 만든 봉의 거래량 (PF-04)", () => {
  it("분 경계 뒤 가격이 여러 번 움직여도 거래량을 확정된 0 으로 두지 않는다", () => {
    let minutes = [candle("2026-09-24", 100, { time: "2026-09-24T10:00:00+09:00" })];
    minutes = applyTickToCandles(minutes, "1m", 101, "2026-09-24T10:01:05+09:00", "005930");
    minutes = applyTickToCandles(minutes, "1m", 103, "2026-09-24T10:01:20+09:00", "005930");
    const last = minutes.at(-1)!;
    expect(last).toMatchObject({ time: "2026-09-24T10:01:00+09:00", open: 101, high: 103, low: 101, close: 103 });
    expect(last.volumeUnknown).toBe(true);
    // 서버에서 받은 봉은 거래량을 그대로 (체결로 고·저·종만 따라간다)
    expect(minutes[0]!.volume).toBe(100);
    expect(minutes[0]!.volumeUnknown).toBeUndefined();
  });

  it("새 일·주봉도 거래량 미확인", () => {
    expect(applyTickToCandles([candle("2026-09-23", 100)], "D", 101, "2026-09-24T09:00:00+09:00", "005930").at(-1)!.volumeUnknown).toBe(true);
    expect(applyTickToCandles([candle("2026-09-21", 100)], "W", 101, "2026-09-28T09:00:00+09:00", "005930").at(-1)!.volumeUnknown).toBe(true);
  });

  it("미국 분봉: 뉴욕 오프셋 봉 시각을 그대로 잇는다", () => {
    const m = [candle("2026-09-24", 200, { time: "2026-09-24T12:00:00-04:00" })];
    expect(applyTickToCandles(m, "5m", 201, "2026-09-25T01:03:00+09:00", "AAPL")).toMatchObject([{ close: 201 }]);
    expect(applyTickToCandles(m, "5m", 201, "2026-09-25T01:05:00+09:00", "AAPL").at(-1)).toMatchObject({ date: "2026-09-24", time: "2026-09-24T12:05:00-04:00" });
  });
});

describe("체결로 고친 차트 캐시는 서버에서 새로 받은 것처럼 보이지 않는다 (PF-04)", () => {
  const API = "https://server.test";
  const T0 = Date.parse("2026-09-24T10:00:30+09:00");
  const tick = (code: string, price: number, timestamp: string): StreamTick => ({ code, price, volume: 1, timestamp, source: "toss-openapi" });
  const series = (period: CandleSeries["period"], candles: Candle[]): CandleSeries => ({ code: "005930", period, candles, source: "test" });

  it("봉은 바뀌지만 받은 시각은 그대로 → staleTime 이 지나면 다시 볼 때 서버 봉을 받는다", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const qc = new QueryClient();
    const key = [API, "candles", "005930", "1m", 600];
    qc.setQueryData(key, series("1m", [candle("2026-09-24", 100, { time: "2026-09-24T10:00:00+09:00" })]), { updatedAt: T0 });
    applyTicksToCache(qc, API, new Map([["005930", tick("005930", 103, "2026-09-24T10:01:20+09:00")]]), new Set());
    expect(qc.getQueryData<CandleSeries>(key)!.candles).toHaveLength(2);
    expect(qc.getQueryState(key)!.dataUpdatedAt).toBe(T0);
    // 값이 같은 체결은 쿼리를 건드리지 않는다
    qc.invalidateQueries({ queryKey: key, refetchType: "none" });
    applyTicksToCache(qc, API, new Map([["005930", tick("005930", 103, "2026-09-24T10:01:30+09:00")]]), new Set());
    expect(qc.getQueryState(key)).toMatchObject({ dataUpdatedAt: T0, isInvalidated: true });
    // 가격이 바뀌어도 무효 표시는 남는다 (다시 볼 때 서버 봉)
    applyTicksToCache(qc, API, new Map([["005930", tick("005930", 104, "2026-09-24T10:01:40+09:00")]]), new Set());
    expect(qc.getQueryState(key)).toMatchObject({ dataUpdatedAt: T0, isInvalidated: true });
    expect(qc.getQueryData<CandleSeries>(key)!.candles.at(-1)!.close).toBe(104);
  });

  it("새 일봉이 열리면 서버 봉을 다시 받도록 무효 표시", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const qc = new QueryClient();
    const key = [API, "candles", "005930", "D", 800];
    qc.setQueryData(key, series("D", [candle("2026-09-23", 100)]), { updatedAt: T0 });
    applyTicksToCache(qc, API, new Map([["005930", tick("005930", 101, "2026-09-24T09:00:01+09:00")]]), new Set());
    expect(qc.getQueryData<CandleSeries>(key)!.candles).toHaveLength(2);
    expect(qc.getQueryState(key)).toMatchObject({ dataUpdatedAt: T0, isInvalidated: true });
  });

  it("새 봉이 열려도 방금(15초 안) 받은 서버 봉이면 바로 다시 받지 않고 표시만 — 서버 봉에 그 봉이 아직 없을 때 체결마다 요청하지 않게", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const qc = new QueryClient();
    const key = [API, "candles", "AAPL", "D", 800];
    const base: CandleSeries = { code: "AAPL", period: "D", candles: [candle("2026-09-24", 200)], source: "test" };
    const spy = vi.spyOn(qc, "invalidateQueries");
    const dayTick = new Map([["AAPL", tick("AAPL", 210, "2026-09-25T10:30:00+09:00")]]);
    qc.setQueryData(key, base, { updatedAt: T0 });
    applyTicksToCache(qc, API, dayTick, new Set(), T0 + 5_000);
    expect(qc.getQueryData<CandleSeries>(key)!.candles).toHaveLength(2);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: key, refetchType: "none" }), expect.anything());
    qc.setQueryData(key, base, { updatedAt: T0 });
    applyTicksToCache(qc, API, dayTick, new Set(), T0 + 20_000);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: key, refetchType: "active" }), expect.anything());
  });

  it("거래일이 바뀐 체결을 보류하면 잔고·상세 캐시를 건드리지 않고 보류 종목을 알린다 (PF-01)", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const { holding, quote } = await import("./helpers");
    const qc = new QueryClient();
    const old = quote("005930", 100, { prevClose: 90, change: 10, changeRate: 11.11, asOf: "2026-09-23T15:30:00+09:00" });
    // 이번 세션에 받은 목록(전일 시세)과 상세
    const list = [holding("005930", old, 10, 80)];
    const detail = { ...holding("005930", old, 10, 80) };
    qc.setQueryData([API, "stocks"], list);
    qc.setQueryData([API, "stock", "005930"], detail);
    const before = { list: qc.getQueryState([API, "stocks"])!, detail: qc.getQueryState([API, "stock", "005930"])! };
    const held = new Set<string>();
    const touched = applyTicksToCache(qc, API, new Map([["005930", tick("005930", 101, "2026-09-24T09:00:01+09:00")]]), held);
    expect(touched).toBe(false);
    expect([...held]).toEqual(["005930"]);
    expect(qc.getQueryData([API, "stocks"])).toBe(list);
    expect(qc.getQueryData([API, "stock", "005930"])).toBe(detail);
    // 쿼리를 다시 쓰지 않았다 (받은 시각이 "방금"으로 바뀌지 않음)
    expect(qc.getQueryState([API, "stocks"])!.dataUpdateCount).toBe(before.list.dataUpdateCount);
    expect(qc.getQueryState([API, "stock", "005930"])!.dataUpdateCount).toBe(before.detail.dataUpdateCount);
  });

  it("같은 거래일 체결은 잔고·상세에 붙는다", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const { holding, quote } = await import("./helpers");
    const qc = new QueryClient();
    const today = quote("005930", 100, { prevClose: 100, change: 0, changeRate: 0, asOf: "2026-09-24T09:00:00+09:00" });
    qc.setQueryData([API, "stocks"], [holding("005930", today, 10, 80)]);
    qc.setQueryData([API, "stock", "005930"], { ...holding("005930", today, 10, 80) });
    const held = new Set<string>();
    expect(applyTicksToCache(qc, API, new Map([["005930", tick("005930", 101, "2026-09-24T09:00:03+09:00")]]), held)).toBe(true);
    expect(held.size).toBe(0);
    expect(qc.getQueryData<{ quote: { change: number; changeRate: number } }[]>([API, "stocks"])![0]!.quote).toMatchObject({ change: 1, changeRate: 1 });
    expect(qc.getQueryData<{ quote: { price: number } }>([API, "stock", "005930"])!.quote.price).toBe(101);
  });
});

describe("차트 봉 주기 갱신 (PF-04)", () => {
  it("장중에는 분봉 30초·일·주·월봉 1분마다 서버 봉을 다시 받고, 장이 닫히면 멈춘다", async () => {
    const { candleRefresh } = await import("@/lib/freshness");
    expect(candleRefresh("1m", true)).toEqual({ refetchInterval: 30_000, staleTime: 20_000 });
    expect(candleRefresh("30m", true).refetchInterval).toBe(30_000);
    expect(candleRefresh("D", true)).toEqual({ refetchInterval: 60_000, staleTime: 60_000 });
    expect(candleRefresh("M", true).refetchInterval).toBe(60_000);
    expect(candleRefresh("D", false)).toEqual({ refetchInterval: false, staleTime: 5 * 60_000 });
  });

  it("미국 주간거래(뉴욕 20:00~04:00, 일~목 밤)에는 토스 달력이 닫힘이어도 다시 받는다 — 주간거래 봉이 화면을 다시 열 때까지 남지 않게", async () => {
    const { tradingNow } = await import("@/lib/marketTime");
    const usClosed = { KR: { isOpen: true }, US: { isOpen: false } } as MarketStatus;
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-25T10:30:00+09:00"))).toBe(true); // 뉴욕 목 21:30
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-28T10:30:00+09:00"))).toBe(true); // 뉴욕 일 21:30 (월요일 세션)
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-26T10:30:00+09:00"))).toBe(false); // 뉴욕 금 21:30 — 주간거래 없음
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-25T20:00:00+09:00"))).toBe(false); // 뉴욕 07:00 은 서버 달력대로
    expect(tradingNow("005930", usClosed, Date.parse("2026-09-26T10:30:00+09:00"))).toBe(true); // 한국은 서버 값 그대로
  });

  it("장 상태를 모르면(조회 실패) 요일·시각으로 — 주말에 1분마다 다시 받지 않는다", async () => {
    const { candleRefresh } = await import("@/lib/freshness");
    const { tradingNow } = await import("@/lib/marketTime");
    const at = (iso: string) => Date.parse(iso);
    expect(tradingNow("005930", undefined, at("2026-09-26T11:00:00+09:00"))).toBe(false); // 토
    expect(tradingNow("005930", undefined, at("2026-09-24T10:00:00+09:00"))).toBe(true);
    expect(tradingNow("005930", undefined, at("2026-09-24T21:00:00+09:00"))).toBe(false);
    expect(tradingNow("AAPL", undefined, at("2026-09-27T12:00:00+09:00"))).toBe(false); // 뉴욕 토 23:00
    expect(tradingNow("AAPL", undefined, at("2026-09-28T09:30:00+09:00"))).toBe(true); // 뉴욕 일 20:30
    expect(candleRefresh("D", tradingNow("AAPL", undefined, at("2026-09-27T12:00:00+09:00"))).refetchInterval).toBe(false);
  });
});
