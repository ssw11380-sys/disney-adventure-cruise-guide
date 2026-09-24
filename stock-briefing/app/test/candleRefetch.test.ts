import { environmentManager, focusManager, isServer, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle, CandlePeriod, CandleSeries } from "@/api/types";
import type { StreamTick } from "@/lib/liveTick";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { candlesQuery } = await import("@/api/hooks");
const { refetchDue } = await import("@/lib/freshness");
const { applyTicksToCache, forgetTicks, rememberTicks } = await import("@/lib/liveStream");

const API = "https://server.test";
const CODE = "005930";
// 한국 장중 (목)
const START = Date.parse("2026-09-24T10:00:00+09:00");
const candle = (date: string, close: number, extra: Partial<Candle> = {}): Candle => ({ date, open: close, high: close, low: close, close, volume: 100, ...extra });

describe("refetchDue: 다음 서버 요청까지 남은 시간 (PF-04 검증 지적)", () => {
  const idle = (dataUpdatedAt: number, errorUpdatedAt = 0) => ({ dataUpdatedAt, errorUpdatedAt, fetchStatus: "idle" });

  it("마지막으로 받은 때(실패했으면 실패한 때)부터 잰다 — 타이머를 언제 다시 걸어도 같은 때", () => {
    expect(refetchDue(60_000, idle(START), START + 10_000)).toBe(50_000);
    expect(refetchDue(60_000, idle(START), START + 59_000)).toBe(1_000);
    expect(refetchDue(60_000, idle(START, START + 30_000), START + 59_000)).toBe(31_000);
    // 이미 지났으면 바로(1ms) — 0 은 react-query 가 "주기 없음"으로 본다
    expect(refetchDue(60_000, idle(START), START + 90_000)).toBe(1);
    // 시계가 뒤로 가도 주기보다 길게 기다리지 않는다
    expect(refetchDue(60_000, idle(START), START - 30_000)).toBe(60_000);
  });

  it("받는 중·앱이 뒤에 있을 때·아직 받은 적 없을 때는 한 주기, 거래 없는 시간이면 멈춤", () => {
    expect(refetchDue(30_000, { ...idle(START), fetchStatus: "fetching" }, START + 90_000)).toBe(30_000);
    expect(refetchDue(30_000, { ...idle(START), fetchStatus: "paused" }, START + 90_000)).toBe(30_000);
    expect(refetchDue(30_000, idle(START), START + 90_000, false)).toBe(30_000);
    expect(refetchDue(30_000, idle(0), START)).toBe(30_000);
    expect(refetchDue(false, idle(START), START + 90_000)).toBe(false);
  });
});

describe("체결이 차트 캐시를 계속 고쳐도 서버 봉 주기 갱신이 돈다 (PF-04 검증 지적)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    // 노드에서는 react-query 가 서버로 보고 간격 타이머를 걸지 않는다 → 앱(RN)처럼
    environmentManager.setIsServer(() => false);
  });
  afterEach(() => {
    vi.useRealTimers();
    environmentManager.setIsServer(() => isServer);
    focusManager.setFocused(undefined);
    forgetTicks();
  });

  /** useCandles 와 같은 옵션의 쿼리를 구독하고, 서버 요청 횟수(calls)와 체결 흉내(스트림 → rememberTicks · applyTicksToCache)를 준다 */
  async function mount(period: CandlePeriod, o: { trading?: boolean; fail?: (call: number) => boolean } = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
    let calls = 0;
    const count = 800;
    const time = period === "D" ? undefined : "2026-09-24T10:00:00+09:00";
    const api = {
      getCandles: async (): Promise<CandleSeries> => {
        calls++;
        if (o.fail?.(calls)) throw new Error("서버 오류");
        // 서버 봉: 받을 때마다 거래량이 늘어 있다 (체결로는 모르는 값)
        return { code: CODE, period, candles: [candle("2026-09-23", 100), candle("2026-09-24", 100, { volume: 1_000 * calls, time })], source: "test" };
      },
    };
    const options = (appFocused: boolean) => candlesQuery(api, API, CODE, period, count, { trading: o.trading ?? true, appFocused });
    const observer = new QueryObserver(qc, options(true));
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    let price = 100;
    const tick = () => {
      price = price === 100 ? 101 : 100;
      const t: StreamTick = { code: CODE, price, volume: 1, timestamp: new Date(Date.now()).toISOString(), source: "toss-openapi" };
      rememberTicks(API, [t]);
      applyTicksToCache(qc, API, new Map([[CODE, t]]), new Set(), Date.now());
    };
    /** ms 동안 every 마다 체결 (every=0 이면 체결 없이 시간만) */
    const run = async (ms: number, every: number) => {
      if (!every) return void (await vi.advanceTimersByTimeAsync(ms));
      for (let t = 0; t < ms; t += every) {
        await vi.advanceTimersByTimeAsync(every);
        tick();
      }
    };
    const done = () => {
      unsubscribe();
      qc.clear();
    };
    return { qc, observer, options, run, done, calls: () => calls, price: () => price, key: [API, "candles", CODE, period, count] };
  }

  it("일봉: 1초마다 체결이 와도 60초·120초에 서버 봉을 다시 받고(거래량 바로잡힘), 그 사이에는 더 받지 않는다", async () => {
    const m = await mount("D");
    expect(m.calls()).toBe(1);
    await m.run(59_000, 1_000);
    expect(m.calls()).toBe(1);
    await m.run(60_000, 1_000);
    expect(m.calls()).toBe(2);
    // 119초 체결 뒤 체결 없이 120초 — 주기 갱신으로 받은 봉: 서버 거래량 + 마지막 체결가(withLastTick, 서버 종가는 100)
    const tickPrice = m.price();
    expect(tickPrice).toBe(101);
    await m.run(1_000, 0);
    expect(m.calls()).toBe(3);
    expect(m.qc.getQueryData<CandleSeries>(m.key)!.candles.at(-1)).toMatchObject({ volume: 3_000, close: tickPrice, high: tickPrice });
    await m.run(10_000, 1_000);
    expect(m.calls()).toBe(3);
    m.done();
  });

  it("분봉(30분봉): 250ms 마다 체결이 와도 30초마다 한 번씩", async () => {
    const m = await mount("30m");
    await m.run(130_000, 250);
    expect(m.calls()).toBe(1 + 4);
    m.done();
  });

  it("체결이 없을 때도 같은 주기 (요청이 늘지 않는다)", async () => {
    const m = await mount("D");
    await m.run(130_000, 0);
    expect(m.calls()).toBe(3);
    m.done();
  });

  it("다시 받기가 실패하면 실패한 때부터 한 주기 뒤 — 체결마다 다시 요청하지 않는다", async () => {
    const m = await mount("D", { fail: (call) => call > 1 });
    await m.run(130_000, 1_000);
    // 0초 성공 · 60초 실패(+1초 뒤 재시도 실패) · 121초 실패(+1초 뒤 재시도 실패)
    expect(m.calls()).toBe(1 + 2 + 2);
    m.done();
  });

  it("앱이 뒤에 있는 동안은 받지 않고, 앞으로 오면 밀린 갱신을 바로 한 번 한 뒤 다시 1분마다", async () => {
    const m = await mount("D");
    await m.run(30_000, 1_000);
    // 뒤로 간다: 스트림이 끊기고(체결 없음) focusManager 가 꺼지고 화면이 다시 그려진다 (useAppFocused)
    forgetTicks();
    focusManager.setFocused(false);
    m.observer.setOptions(m.options(false));
    await m.run(5 * 60_000, 0);
    expect(m.calls()).toBe(1);
    focusManager.setFocused(true);
    m.observer.setOptions(m.options(true));
    await m.run(100, 0);
    expect(m.calls()).toBe(2);
    await m.run(59_000, 1_000);
    expect(m.calls()).toBe(2);
    await m.run(2_000, 1_000);
    expect(m.calls()).toBe(3);
    m.done();
  });

  it("거래가 없는 시간이면 체결이 와도 다시 받지 않는다", async () => {
    const m = await mount("D", { trading: false });
    await m.run(5 * 60_000, 1_000);
    expect(m.calls()).toBe(1);
    m.done();
  });
});
