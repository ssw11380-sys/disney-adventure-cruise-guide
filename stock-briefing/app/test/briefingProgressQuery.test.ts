import { environmentManager, focusManager, isServer, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefingStatus } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { briefingStatusQuery } = await import("@/api/hooks");
const API = "https://server.test";
const BODY: BriefingStatus = {
  session: null, date: "2026-12-28", scheduledAt: null, state: "none", late: false, startedAt: null, finishedAt: null,
  total: 0, done: 0, problems: [], reasonKind: null, nextRunAt: "2026-12-28T08:30:00+09:00", retryAt: null, manualRun: true, activeRun: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-12-28T08:20:00+09:00"));
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
});
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  environmentManager.setIsServer(() => isServer);
});

describe("브리핑 진행 조회 주기", () => {
  it("기능 끔·인수 생략은 기존 60초, 켜도 화면 포커스·백그라운드 제한은 유지한다", () => {
    const api = { briefingStatus: async () => BODY };
    for (const opts of [briefingStatusQuery(api, API, true, true), briefingStatusQuery(api, API, true, true, false)]) {
      expect(opts.staleTime).toBe(30_000);
      expect(opts.refetchInterval).toBe(60_000);
      expect(opts.refetchIntervalInBackground).toBe(false);
      expect(opts.subscribed).toBe(true);
    }
    const on = briefingStatusQuery(api, API, false, false, true);
    expect(on.staleTime).toBe(5_000);
    expect(on.subscribed).toBe(false);
    expect(on.enabled).toBe(false);
    expect(on.refetchIntervalInBackground).toBe(false);
    expect(on.refetchOnWindowFocus).toBe(true);
    expect(on.queryKey).toEqual([API, "briefings", "status"]);
  });

  it("대기 중 15초, 실행을 확인하면 5초, 끝나면 15초로 돌아가고 배경에서는 멈춘다", async () => {
    let body = { ...BODY };
    let calls = 0;
    const api = { briefingStatus: async () => { calls++; return body; } };
    const qc = new QueryClient();
    const observer = new QueryObserver(qc, briefingStatusQuery(api, API, true, true, true));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      body = { ...BODY, activeRun: { session: "morning", date: BODY.date, trigger: "manual", partial: false, startedAt: "2026-12-28T08:20:01+09:00", total: 3, done: 0 } };
      await vi.advanceTimersByTimeAsync(14_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      expect(observer.getCurrentResult().data?.activeRun?.total).toBe(3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(3);
      body = { ...BODY };
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(4);
      expect(observer.getCurrentResult().data?.activeRun).toBeNull();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(calls).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(5);
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(5);
      unsubscribe();
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(5);
    } finally {
      unsubscribe();
      qc.clear();
    }
  });
});
