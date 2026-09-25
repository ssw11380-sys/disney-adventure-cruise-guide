import { QueryClient, QueryObserver } from "@tanstack/react-query";
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

  it("미국 휴장일 전날 밤(추수감사절 전날 뉴욕 20:30) 재연결 체결은 휴장일(11/26) 임시 봉을 만들지 않는다", () => {
    const wed = [candle("2026-11-24", 200), candle("2026-11-25", 205)];
    expect(applyTickToCandles(wed, "D", 205, "2026-11-26T10:30:00+09:00", "AAPL")).toBe(wed);
    expect(applyTickToCandles(wed, "D", 205, "2026-11-27T02:00:00+09:00", "AAPL")).toBe(wed); // 휴장일 낮
    // 휴장일 밤 20:00 부터는 금요일 세션(주간거래) → 새 봉
    expect(dates(applyTickToCandles(wed, "D", 206, "2026-11-27T10:30:00+09:00", "AAPL"))).toEqual(["2026-11-24", "2026-11-25", "2026-11-27"]);
  });

  it("한국 장 시작(08:00) 전 재연결 체결(값 그대로)은 오늘 임시 봉을 만들지 않는다", () => {
    const days = [candle("2026-09-23", 100)];
    expect(applyTickToCandles(days, "D", 100, "2026-09-24T07:30:00+09:00", "005930")).toBe(days);
    expect(dates(applyTickToCandles(days, "D", 101, "2026-09-24T08:00:05+09:00", "005930"))).toEqual(["2026-09-23", "2026-09-24"]);
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

  it("거래 시간 밖 체결(장 전·주말·미국 휴장일에 서버가 보낸 값 그대로의 체결)로는 새 분봉을 열지 않는다", () => {
    const kr = [candle("2026-09-23", 100, { time: "2026-09-23T19:59:00+09:00" })];
    expect(applyTickToCandles(kr, "1m", 100, "2026-09-24T07:30:00+09:00", "005930")).toBe(kr);
    expect(applyTickToCandles(kr, "1m", 100, "2026-09-23T21:00:00+09:00", "005930")).toBe(kr);
    expect(applyTickToCandles(kr, "1m", 101, "2026-09-24T08:00:05+09:00", "005930").at(-1)).toMatchObject({ time: "2026-09-24T08:00:00+09:00", volumeUnknown: true });
    const us = [candle("2026-09-25", 200, { time: "2026-09-25T19:59:00-04:00" })];
    expect(applyTickToCandles(us, "5m", 200, "2026-09-26T11:00:00+09:00", "AAPL")).toBe(us); // 뉴욕 금 22:00 (주말 앞이라 주간거래 없음)
    const wed = [candle("2026-11-25", 200, { time: "2026-11-25T19:55:00-05:00" })];
    expect(applyTickToCandles(wed, "5m", 200, "2026-11-26T10:30:00+09:00", "AAPL")).toBe(wed); // 추수감사절 전날 밤 20:30
    expect(applyTickToCandles(wed, "5m", 201, "2026-11-27T10:30:00+09:00", "AAPL")).toHaveLength(2); // 휴장일 밤 20:30 → 금요일 주간거래
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
    // 뉴욕 07:00(프리마켓)·17:00(애프터마켓)도 거래가 있다 — 토스 달력 isOpen 은 정규장만이라 요일·시각으로 (예전에는 멈췄다)
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-25T20:00:00+09:00"))).toBe(true);
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-26T06:00:00+09:00"))).toBe(true);
    expect(tradingNow("AAPL", usClosed, Date.parse("2026-09-26T09:30:00+09:00"))).toBe(false); // 뉴욕 금 20:30 — 토요일 세션 없음
    expect(tradingNow("005930", usClosed, Date.parse("2026-09-26T10:30:00+09:00"))).toBe(true); // 한국은 서버 값 그대로
  });

  it("미국 휴장일에는 주간거래도 없다 — 추수감사절 전날 밤·당일에는 다시 받지 않고, 당일 뉴욕 20:00(금요일 세션)부터 다시 받는다", async () => {
    const { tradingNow } = await import("@/lib/marketTime");
    const usClosed = { KR: { isOpen: false }, US: { isOpen: false } } as MarketStatus;
    const at = (iso: string) => Date.parse(iso);
    expect(tradingNow("AAPL", usClosed, at("2026-11-26T11:30:00+09:00"))).toBe(false); // 뉴욕 수 11/25 21:30
    expect(tradingNow("AAPL", usClosed, at("2026-11-26T16:00:00+09:00"))).toBe(false); // 뉴욕 목 11/26 02:00
    expect(tradingNow("AAPL", usClosed, at("2026-11-27T11:30:00+09:00"))).toBe(true); // 뉴욕 목 11/26 21:30
    expect(tradingNow("AAPL", undefined, at("2026-11-27T02:00:00+09:00"))).toBe(false); // 장 상태 모름 + 휴장일 낮
    expect(tradingNow("AAPL", undefined, at("2026-11-25T02:00:00+09:00"))).toBe(true); // 평일 낮
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

describe("주기 갱신으로 받은 서버 봉에 마지막 체결을 다시 얹는다 (PF-04 검증 지적)", () => {
  const API = "https://server.test";
  const tick = (code: string, price: number, timestamp: string): StreamTick => ({ code, price, volume: 1, timestamp, source: "toss-openapi" });
  // 서버 봉을 받은 때 (체결 10:01:20 의 10초 뒤)
  const NOW = Date.parse("2026-09-24T10:01:30+09:00");

  it("일봉·같은 분봉의 종가는 현재가를 따라가고(서버 거래량은 그대로), 서버에 없는 뒤 구간 봉은 붙이지 않는다", async () => {
    const { rememberTicks, forgetTicks, withLastTick } = await import("@/lib/liveStream");
    forgetTicks();
    rememberTicks(API, [tick("005930", 103, "2026-09-24T10:01:20+09:00")]);
    // 서버 봉 캐시가 늦어 10:01 봉이 아직 없으면 그대로 — 앱이 만든 봉은 서버 봉을 다시 받으면 지워져야 한다 (다음 체결·다음 갱신이 채운다)
    const minutes: CandleSeries = { code: "005930", period: "1m", candles: [candle("2026-09-24", 100, { time: "2026-09-24T10:00:00+09:00" })], source: "test" };
    expect(withLastTick(API, "005930", minutes, NOW)).toBe(minutes);
    const sameMinute: CandleSeries = { ...minutes, candles: [...minutes.candles, candle("2026-09-24", 101, { time: "2026-09-24T10:01:00+09:00", volume: 700 })] };
    expect(withLastTick(API, "005930", sameMinute, NOW).candles.at(-1)).toEqual({ ...candle("2026-09-24", 101, { time: "2026-09-24T10:01:00+09:00", volume: 700 }), close: 103, high: 103 });
    const days: CandleSeries = { code: "005930", period: "D", candles: [candle("2026-09-24", 100, { volume: 5000 })], source: "test" };
    expect(withLastTick(API, "005930", days, NOW).candles).toEqual([{ ...candle("2026-09-24", 100, { volume: 5000 }), close: 103, high: 103 }]);
    // 서버 봉이 체결보다 새로우면(10:02 봉까지 있음) 그대로
    const newer: CandleSeries = { ...minutes, candles: [...minutes.candles, candle("2026-09-24", 104, { time: "2026-09-24T10:02:00+09:00" })] };
    expect(withLastTick(API, "005930", newer, NOW)).toBe(newer);
    // 다른 서버 주소·다른 종목의 체결은 쓰지 않는다
    expect(withLastTick("https://other.test", "005930", days, NOW)).toBe(days);
    expect(withLastTick(API, "000660", { ...days, code: "000660" }, NOW).candles).toEqual(days.candles);
  });

  it("더 오래된 체결로 덮지 않고, 연결이 끊겨 비우면 서버 봉을 그대로 쓴다", async () => {
    const { rememberTicks, forgetTicks, withLastTick } = await import("@/lib/liveStream");
    forgetTicks();
    rememberTicks(API, [tick("005930", 103, "2026-09-24T10:01:20+09:00")]);
    rememberTicks(API, [tick("005930", 99, "2026-09-24T10:01:00+09:00")]);
    const days: CandleSeries = { code: "005930", period: "D", candles: [candle("2026-09-24", 100)], source: "test" };
    expect(withLastTick(API, "005930", days, NOW).candles.at(-1)!.close).toBe(103);
    forgetTicks();
    expect(withLastTick(API, "005930", days, NOW)).toBe(days);
  });
});

describe("오래된 체결은 서버 봉에 다시 얹지 않는다 — 서버가 잊지 않는 삭제 종목의 마지막 체결 (PF-04 검증 지적)", () => {
  const API = "https://server.test";
  const at = (iso: string) => Date.parse(iso);
  // 10:00 에 삭제한 종목 X 의 마지막 체결. 서버 PriceStream 은 이 값을 잊지 않고 접속할 때마다 스냅샷에 실어 보낸다
  const removed: StreamTick = { code: "123456", price: 50_000, volume: 1, timestamp: "2026-09-24T09:59:57+09:00", source: "toss-web" };
  // 14:00 에 발견 탭에서 X 를 열었을 때 서버 일봉 (종가 52,000 · 저가 50,500)
  const daily: CandleSeries = {
    code: "123456",
    period: "D",
    candles: [candle("2026-09-23", 49_000), candle("2026-09-24", 52_000, { open: 51_000, high: 52_500, low: 50_500, volume: 9_000 })],
    source: "test",
  };

  it("14:00 에 받은 일·주·월봉에 09:59:57 체결을 얹지 않는다 (2분 안의 체결은 그대로 얹는다)", async () => {
    const { rememberTicks, forgetTicks, withLastTick } = await import("@/lib/liveStream");
    forgetTicks();
    rememberTicks(API, [removed]);
    const now = at("2026-09-24T14:00:00+09:00");
    expect(withLastTick(API, "123456", daily, now)).toBe(daily);
    const weekly: CandleSeries = { ...daily, period: "W", candles: [candle("2026-09-21", 52_000, { low: 50_500 })] };
    expect(withLastTick(API, "123456", weekly, now)).toBe(weekly);
    const monthly: CandleSeries = { ...daily, period: "M", candles: [candle("2026-09-01", 52_000, { low: 48_000 })] };
    expect(withLastTick(API, "123456", monthly, now)).toBe(monthly);
    // 체결 뒤 2분 안에 받은 봉이면 (서버 봉 캐시가 아직 그 체결을 모를 수 있어) 얹는다
    expect(withLastTick(API, "123456", daily, at("2026-09-24T10:01:30+09:00")).candles.at(-1)).toMatchObject({ close: 50_000, low: 50_000, volume: 9_000 });
    forgetTicks();
  });

  it("접속 직후 스냅샷에 없는 종목의 체결은 잊는다 (그 서버 주소만)", async () => {
    const { rememberTicks, forgetTicks, withLastTick } = await import("@/lib/liveStream");
    forgetTicks();
    const now = at("2026-09-24T10:00:30+09:00");
    rememberTicks(API, [removed, { ...removed, code: "005930", price: 70_000 }]);
    rememberTicks("https://other.test", [removed]);
    rememberTicks(API, [{ ...removed, code: "005930", price: 70_100, timestamp: "2026-09-24T10:00:20+09:00" }], { snapshot: true });
    expect(withLastTick(API, "123456", daily, now)).toBe(daily);
    expect(withLastTick(API, "005930", { ...daily, code: "005930" }, now).candles.at(-1)!.close).toBe(70_100);
    expect(withLastTick("https://other.test", "123456", daily, now).candles.at(-1)!.close).toBe(50_000);
    forgetTicks();
  });

  it("접속 직후 스냅샷의 체결이 차트 봉을 받은 때보다 2분 넘게 오래됐으면 그 봉을 고치지 않는다 (받은 뒤의 체결은 따라간다)", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const qc = new QueryClient();
    const key = [API, "candles", "123456", "D", 800];
    // 14:00 에 받은 봉을 보던 중 앱을 잠깐 내렸다가 14:02 에 다시 붙었다
    qc.setQueryData(key, daily, { updatedAt: at("2026-09-24T14:00:00+09:00") });
    applyTicksToCache(qc, API, new Map([["123456", removed]]), new Set(), at("2026-09-24T14:02:00+09:00"), { snapshot: true });
    expect(qc.getQueryData(key)).toBe(daily);
    // 15:00 에 받은 봉 → 16:00 에 다시 붙었을 때 스냅샷의 15:30 체결(내려 둔 사이의 체결)은 봉에 얹는다
    qc.setQueryData(key, daily, { updatedAt: at("2026-09-24T15:00:00+09:00") });
    applyTicksToCache(qc, API, new Map([["123456", { ...removed, price: 53_000, timestamp: "2026-09-24T15:30:00+09:00" }]]), new Set(), at("2026-09-24T16:00:00+09:00"), { snapshot: true });
    expect(qc.getQueryData<CandleSeries>(key)!.candles.at(-1)).toMatchObject({ close: 53_000, high: 53_000, low: 50_500, volume: 9_000 });
    qc.clear();
  });
});

describe("한국 평일 휴장일(한글날 2026-10-09 금)에 앱이 만든 봉은 서버 봉을 다시 받으면 남지 않는다 (PF-04 검증 지적)", () => {
  const API = "https://server.test";
  // 받은 시각은 실제 지금 기준 (미래 시각이면 react-query 가 새 값으로 보고 다시 받지 않는다)
  const T0 = Date.now() - 60_000;
  // 서버 스냅샷: 값은 10/08 종가 그대로인데 시각만 서버가 마지막으로 폴링한 휴장일 시각 (tradingDate 는 한국 휴장일을 몰라 10/09 로 본다)
  const holidayTick: StreamTick = { code: "005930", price: 100, volume: null, timestamp: "2026-10-09T10:00:03+09:00", source: "toss-web" };
  // 서버 봉을 받은 때: 스냅샷 체결 10초 뒤 (오래된 체결이라 얹지 않는 경우와 섞이지 않게 — 오늘 날짜와 무관하게)
  const holidayNow = Date.parse(holidayTick.timestamp) + 10_000;
  const daily: CandleSeries = { code: "005930", period: "D", candles: [candle("2026-10-07", 99, { volume: 4000 }), candle("2026-10-08", 100, { volume: 5000 })], source: "test" };
  const minutes: CandleSeries = {
    code: "005930",
    period: "1m",
    candles: [candle("2026-10-08", 99, { time: "2026-10-08T19:58:00+09:00" }), candle("2026-10-08", 100, { time: "2026-10-08T19:59:00+09:00" })],
    source: "test",
  };

  it("withLastTick: 10/08 에서 끝나는 서버 봉에 10/09 봉을 붙이지 않는다 (일·1분·주봉)", async () => {
    const { rememberTicks, forgetTicks, withLastTick } = await import("@/lib/liveStream");
    forgetTicks();
    rememberTicks(API, [holidayTick]);
    expect(withLastTick(API, "005930", daily, holidayNow)).toBe(daily);
    expect(withLastTick(API, "005930", minutes, holidayNow)).toBe(minutes);
    const weekly: CandleSeries = { ...daily, period: "W", candles: [candle("2026-10-05", 100)] };
    expect(withLastTick(API, "005930", weekly, holidayNow)).toBe(weekly); // 같은 주, 값도 같다
    forgetTicks();
  });

  it.each([
    ["D", daily, 800],
    ["1m", minutes, 600],
  ] as const)("%s: 체결로 연 10/09 봉(거래량 미확인)은 주기 갱신으로 서버 봉을 다시 받으면 없어진다", async (period, server, count) => {
    const { rememberTicks, forgetTicks, withLastTick, applyTicksToCache } = await import("@/lib/liveStream");
    forgetTicks();
    const qc = new QueryClient();
    const key = [API, "candles", "005930", period, count];
    qc.setQueryData(key, server, { updatedAt: T0 });
    rememberTicks(API, [holidayTick]);
    // 연결 중 체결은 새 봉을 연다 (원래 동작 — 다음 갱신이 바로잡는다)
    applyTicksToCache(qc, API, new Map([["005930", holidayTick]]), new Set(), T0 + 1_000);
    expect(qc.getQueryData<CandleSeries>(key)!.candles.at(-1)).toMatchObject({ date: "2026-10-09", volumeUnknown: true });
    // 서버 봉을 다시 받는다 (useCandles 의 queryFn 과 같은 경로: 받은 봉 + 마지막 체결)
    for (let i = 0; i < 2; i++) {
      await qc.fetchQuery({ queryKey: key, queryFn: async () => withLastTick(API, "005930", server, holidayNow), staleTime: 0 });
      const after = qc.getQueryData<CandleSeries>(key)!;
      expect(dates(after.candles)).not.toContain("2026-10-09");
      expect(after.candles).toEqual(server.candles);
    }
    forgetTicks();
    qc.clear();
  });

  it("서버 재시작 직후 첫 체결(스냅샷이 아닌 ticks)이 연 분봉은, 주기 갱신이 없어도(휴장일) 서버 봉을 바로 다시 받게 한다", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const qc = new QueryClient();
    const key = [API, "candles", "005930", "1m", 600];
    const spy = vi.spyOn(qc, "invalidateQueries");
    // 서버 봉을 받은 지 1분이 넘었다 = 주기 갱신이 돌지 않는 중 → 바로 다시 받는다
    qc.setQueryData(key, minutes, { updatedAt: T0 });
    applyTicksToCache(qc, API, new Map([["005930", holidayTick]]), new Set(), T0 + 90_000);
    expect(qc.getQueryData<CandleSeries>(key)!.candles.at(-1)).toMatchObject({ date: "2026-10-09", volumeUnknown: true });
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: key, refetchType: "active" }), expect.anything());
    // 장중처럼 방금(30초 주기 안) 받은 서버 봉이면 표시만 — 분마다 요청을 더하지 않는다
    qc.setQueryData(key, minutes, { updatedAt: T0 });
    applyTicksToCache(qc, API, new Map([["005930", holidayTick]]), new Set(), T0 + 20_000);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ queryKey: key, refetchType: "none" }), expect.anything());
    qc.clear();
  });

  it("접속 직후 스냅샷으로는 새 봉을 열지 않고, 같은 구간이면 마지막 봉만 고친다", async () => {
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const qc = new QueryClient();
    const dKey = [API, "candles", "005930", "D", 800];
    const mKey = [API, "candles", "005930", "1m", 600];
    // 봉을 받은 때는 스냅샷 체결 시각 근처로 고정 (오늘 날짜와 무관하게 — 스냅샷 체결은 봉을 받은 때와 비교한다)
    const loadedAt = Date.parse("2026-10-08T19:59:00+09:00");
    qc.setQueryData(dKey, daily, { updatedAt: loadedAt });
    qc.setQueryData(mKey, minutes, { updatedAt: loadedAt });
    applyTicksToCache(qc, API, new Map([["005930", holidayTick]]), new Set(), loadedAt + 30_000, { snapshot: true });
    expect(qc.getQueryData(dKey)).toBe(daily);
    expect(qc.getQueryData(mKey)).toBe(minutes);
    // 평일 장중 스냅샷이 서버 마지막 봉과 같은 구간이면 종가는 따라간다
    applyTicksToCache(qc, API, new Map([["005930", { ...holidayTick, price: 101, timestamp: "2026-10-08T19:59:30+09:00" }]]), new Set(), loadedAt + 30_000, { snapshot: true });
    expect(qc.getQueryData<CandleSeries>(dKey)!.candles.at(-1)).toMatchObject({ date: "2026-10-08", close: 101, volume: 5000 });
    expect(qc.getQueryData<CandleSeries>(mKey)!.candles.at(-1)).toMatchObject({ time: "2026-10-08T19:59:00+09:00", close: 101 });
    qc.clear();
  });
});

describe("차트 아래 알림 (PF-04 검증 지적)", () => {
  const NOW = Date.parse("2026-09-24T10:05:00+09:00");
  const q = (o: { data?: unknown; isError?: boolean; error?: unknown; dataUpdatedAt?: number; fetchStatus?: "fetching" | "paused" | "idle" }) => ({
    data: o.data,
    isError: o.isError ?? false,
    error: o.error ?? null,
    dataUpdatedAt: o.dataUpdatedAt ?? 0,
    fetchStatus: o.fetchStatus ?? "idle",
  });

  it("처음 불러오기 실패만 오류, 그려진 차트의 주기 갱신 실패는 언제 받은 봉인지만", async () => {
    const { chartNotice } = await import("@/lib/freshness");
    expect(chartNotice(q({ isError: true, error: new Error("서버 오류") }), NOW)).toEqual({ text: "서버 오류", error: true });
    expect(chartNotice(q({ isError: true }), NOW)).toEqual({ text: "차트 실패", error: true });
    const loaded = { data: { candles: [] }, dataUpdatedAt: Date.parse("2026-09-24T10:03:21+09:00") };
    expect(chartNotice(q({ ...loaded, isError: true, error: new Error("서버 오류") }), NOW)).toEqual({ text: "차트 갱신 지연 · 10:03:21 기준", error: false });
    expect(chartNotice(q({ ...loaded, fetchStatus: "paused" }), NOW)).toMatchObject({ error: false });
    expect(chartNotice(q(loaded), NOW)).toBeNull();
    expect(chartNotice(q({ fetchStatus: "fetching" }), NOW)).toBeNull();
    // isError 가 지워져도(체결 캐시 쓰기) 마지막 실패가 마지막으로 서버 봉을 받은 뒤면 알린다, 그 뒤 서버 봉을 받았으면 알리지 않는다
    expect(chartNotice({ ...q(loaded), errorUpdatedAt: loaded.dataUpdatedAt + 30_000 }, NOW)).toEqual({ text: "차트 갱신 지연 · 10:03:21 기준", error: false });
    expect(chartNotice({ ...q(loaded), errorUpdatedAt: loaded.dataUpdatedAt - 30_000 }, NOW)).toBeNull();
  });

  it("주기 갱신이 실패한 뒤 체결로 봉을 고쳐도(react-query 가 isError 를 지움) '차트 갱신 지연'이 남고, 서버 봉을 다시 받으면 사라진다", async () => {
    const { chartNotice, clockLabel } = await import("@/lib/freshness");
    const { applyTicksToCache, forgetTicks } = await import("@/lib/liveStream");
    forgetTicks();
    const API = "https://server.test";
    const qc = new QueryClient();
    const key = [API, "candles", "005930", "1m", 600];
    const server: CandleSeries = { code: "005930", period: "1m", candles: [candle("2026-09-24", 100, { time: "2026-09-24T10:00:00+09:00" })], source: "test" };
    const loadedAt = Date.now() - 60_000;
    qc.setQueryData(key, server, { updatedAt: loadedAt });
    // 화면(ChartNotice)이 보는 것과 같은 useQuery 결과
    const observer = new QueryObserver<CandleSeries>(qc, { queryKey: key, enabled: false });
    const unsubscribe = observer.subscribe(() => undefined);
    await qc.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error("서버 오류")), retry: false, staleTime: 0 }).catch(() => undefined);
    const now = Date.now();
    const notice = { text: `차트 갱신 지연 · ${clockLabel(loadedAt, now)} 기준`, error: false };
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(chartNotice(observer.getCurrentResult(), now)).toEqual(notice);
    // 1초 안에 오는 체결이 봉을 고친다
    applyTicksToCache(qc, API, new Map([["005930", { code: "005930", price: 101, volume: 1, timestamp: "2026-09-24T10:00:20+09:00", source: "toss-openapi" }]]), new Set());
    const afterTick = observer.getCurrentResult();
    expect(afterTick.data!.candles.at(-1)!.close).toBe(101);
    expect(afterTick.isError).toBe(false); // react-query v5 의 setQueryData 는 오류 상태를 지운다 — 그래서 isError 로는 알림이 사라진다
    expect(afterTick.dataUpdatedAt).toBe(loadedAt);
    expect(chartNotice(afterTick, now)).toEqual(notice);
    // 서버 봉을 다시 받으면 알림이 사라진다
    await qc.fetchQuery({ queryKey: key, queryFn: async () => server, staleTime: 0 });
    expect(chartNotice(observer.getCurrentResult(), Date.now())).toBeNull();
    unsubscribe();
    qc.clear();
  });
});
