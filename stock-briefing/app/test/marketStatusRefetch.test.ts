import { environmentManager, isServer, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketState, MarketStatus } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { marketStatusQuery } = await import("@/api/hooks");
const { marketBoundary } = await import("@/lib/liveDot");

/**
 * BH-60: 앱 장 상태(useMarketStatus)를 고정 5분마다만 다시 받아, 개장·마감 직후 최대 5분 동안 "장 마감"/"장중"과 폴링 주기가 틀렸다.
 * 서버는 받은 상태에 다음 개장(opensAt)·마감(closesAt)을 주고 그 경계까지만 캐시한다 → 앱도 그 경계 1초 뒤에 한 번 더 받는다.
 * 가짜 서버: 2026-09-25(금) 서머타임 — 미국 정규장 22:30~05:00 KST, 한국은 20:00 에 닫혀 월요일 08:00 에 연다
 */
const API = "https://server.test";
const kst = (hhmmss: string, day = "2026-09-25") => Date.parse(`${day}T${hhmmss}+09:00`);
const US_OPEN = kst("22:30:00");
const US_CLOSE = kst("05:00:00", "2026-09-26");
const iso = (t: number) => new Date(t).toISOString();

function statusAt(t: number): MarketStatus {
  const KR: MarketState = { market: "KR", isTradingDay: false, isOpen: false, opensAt: iso(kst("08:00:00", "2026-09-28")), closesAt: null, source: "toss" };
  const open = t >= US_OPEN && t < US_CLOSE;
  const US: MarketState = open
    ? { market: "US", isTradingDay: true, isOpen: true, opensAt: null, closesAt: iso(US_CLOSE), source: "toss" }
    : { market: "US", isTradingDay: true, isOpen: false, opensAt: iso(t < US_OPEN ? US_OPEN : kst("22:30:00", "2026-09-28")), closesAt: null, source: "toss" };
  return { now: iso(t), KR, US };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 노드에서는 react-query 가 서버로 보고 간격 타이머를 걸지 않는다 → 앱(RN)처럼
  environmentManager.setIsServer(() => false);
});
afterEach(() => {
  vi.useRealTimers();
  environmentManager.setIsServer(() => isServer);
});

/** useMarketStatus 와 같은 옵션의 쿼리를 구독한다. lagMs: 서버 시계가 앱보다 늦은 만큼 (경계 직후에도 옛 상태를 준다) */
async function mount(start: number, o: { lagMs?: number } = {}) {
  vi.setSystemTime(start);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
  let calls = 0;
  const api = {
    marketStatus: async (): Promise<MarketStatus> => {
      calls++;
      return statusAt(Date.now() - (o.lagMs ?? 0));
    },
  };
  const observer = new QueryObserver(qc, marketStatusQuery(api, API));
  const unsubscribe = observer.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const usOpen = () => observer.getCurrentResult().data?.US.isOpen;
  return { qc, api, usOpen, calls: () => calls, unsubscribe };
}

describe("marketBoundary: 받은 장 상태의 가장 가까운 개장·마감", () => {
  it("열린 시장은 마감, 닫힌 시장은 개장 중 이른 것. 방금(10초 안) 지난 경계는 포함, 그보다 오래됐거나 모르면 없음", () => {
    const s = statusAt(kst("22:27:00"));
    expect(marketBoundary(s, kst("22:27:00"))).toBe(US_OPEN);
    expect(marketBoundary(statusAt(US_OPEN), US_OPEN)).toBe(US_CLOSE);
    expect(marketBoundary(s, US_OPEN + 5_000)).toBe(US_OPEN);
    expect(marketBoundary(s, US_OPEN + 60_000)).toBe(kst("08:00:00", "2026-09-28"));
    const fallback: MarketState = { market: "US", isTradingDay: true, isOpen: true, opensAt: null, closesAt: null, source: "fallback" };
    expect(marketBoundary({ KR: { ...fallback, market: "KR" }, US: fallback }, US_OPEN)).toBeNull();
    expect(marketBoundary(undefined, US_OPEN)).toBeNull();
  });
});

describe("장 상태: 개장·마감 경계에서 바로 다시 받는다 (BH-60)", () => {
  it("22:27 에 받은 '미국 닫힘'은 22:30 개장 1초 뒤 다시 받아 '장중'이 된다 (예전: 22:32 까지 닫힘)", async () => {
    const m = await mount(kst("22:27:00"));
    expect(m.usOpen()).toBe(false);
    await vi.advanceTimersByTimeAsync(US_OPEN - Date.now() + 2_000);
    expect(m.calls()).toBe(2);
    expect(m.usOpen()).toBe(true);
    m.unsubscribe();
  });

  it("마감(05:00)도 같다 — 04:58 에 받은 '장중'이 05:00:01 에 닫힘으로", async () => {
    const m = await mount(kst("04:58:00", "2026-09-26"));
    expect(m.usOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(US_CLOSE - Date.now() + 2_000);
    expect(m.usOpen()).toBe(false);
    m.unsubscribe();
  });

  it("서버 시계가 조금 늦어 경계 직후에도 옛 상태를 주면 3초 뒤 한 번 더", async () => {
    const m = await mount(kst("22:27:00"), { lagMs: 2_000 });
    await vi.advanceTimersByTimeAsync(US_OPEN - Date.now() + 1_500);
    expect(m.usOpen()).toBe(false); // 22:30:01 에 받았지만 서버는 22:29:59
    await vi.advanceTimersByTimeAsync(4_000);
    expect(m.usOpen()).toBe(true);
    m.unsubscribe();
  });

  it("경계가 멀면 예전처럼 5분마다 (더 자주 묻지 않는다)", async () => {
    const m = await mount(kst("23:00:00"));
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect(m.calls()).toBe(3);
    m.unsubscribe();
  });

  it("경계가 지난 뒤 새로 붙은 화면은 받아 둔 옛 상태를 쓰지 않고 다시 받는다 (staleTime 도 경계까지)", async () => {
    const m = await mount(kst("22:27:00"));
    m.unsubscribe(); // 장 상태를 보던 화면이 사라짐 (주기 갱신 없음)
    vi.setSystemTime(US_OPEN + 5_000);
    const again = new QueryObserver(m.qc, marketStatusQuery(m.api, API));
    const off = again.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.calls()).toBe(2);
    expect(again.getCurrentResult().data?.US.isOpen).toBe(true);
    off();
  });
});
