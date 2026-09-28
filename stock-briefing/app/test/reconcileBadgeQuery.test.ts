import { environmentManager, focusManager, isServer, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileBadgeBody } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { reconcileBadgeQuery } = await import("@/api/hooks");
const { ApiRequestError } = await import("@/api/client");
const { RECONCILE_OFF, RECONCILE_POLL_MS } = await import("@/lib/numberBasis");

/**
 * 토스 대조 배지 쿼리 (3-32, 플래그 numberBasis). '대조 기록이 새로 생기면 1분 안에 배지가 바뀜'(로드맵 완료 기준 2):
 *  - 실시간 알림 'reconcile' 이 오면 바로 (liveStream 테스트), 연결이 끊겨도 잔고 탭이 보이는 동안 30초마다
 *  - 예전 서버 404 는 꺼짐(RECONCILE_OFF), 다른 오류는 던진다
 */
const API = "https://server.test";
const BODY: ReconcileBadgeBody = { on: true, status: null, intraday: { n: 0, withinPct: null, skipped: 0 }, sync: null };
const run = (o: ReturnType<typeof reconcileBadgeQuery>) => (o.queryFn as () => Promise<ReconcileBadgeBody>)();

describe("reconcileBadgeQuery: 옵션", () => {
  it("보이는 동안 30초마다 · 뒤에서는 받지 않음 · 앱으로 돌아오면 다시 · 재시도 없음 · 20초 신선", () => {
    const api = { reconcileBadge: async () => BODY };
    const o = reconcileBadgeQuery(api, API);
    expect(RECONCILE_POLL_MS).toBeLessThanOrEqual(30_000);
    expect(o.refetchInterval).toBe(RECONCILE_POLL_MS);
    expect(o.refetchIntervalInBackground).toBe(false);
    expect(o.refetchOnWindowFocus).toBe(true);
    expect(o.retry).toBe(0);
    expect(o.staleTime).toBe(20_000);
    expect(o.queryKey).toEqual([API, "reconcileBadge"]);
    expect(o.subscribed).toBe(true);
    // 잔고 탭이 가려지면 구독을 끊는다
    expect(reconcileBadgeQuery(api, API, false).subscribed).toBe(false);
    expect(reconcileBadgeQuery(api, API, true).subscribed).toBe(true);
  });

  it("queryFn: 정상은 받은 본문, 404(예전 서버)는 꺼짐, 500·연결 실패는 던진다", async () => {
    expect(await run(reconcileBadgeQuery({ reconcileBadge: async () => BODY }, API))).toBe(BODY);
    expect(await run(reconcileBadgeQuery({ reconcileBadge: async () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "없음")) }, API))).toEqual(RECONCILE_OFF);
    await expect(run(reconcileBadgeQuery({ reconcileBadge: async () => Promise.reject(new ApiRequestError(500, "INTERNAL", "서버 오류")) }, API))).rejects.toThrow("서버 오류");
    await expect(run(reconcileBadgeQuery({ reconcileBadge: async () => Promise.reject(new Error("network")) }, API))).rejects.toThrow("network");
  });
});

describe("reconcileBadgeQuery: 주기 (실시간 연결이 끊겨도 1분 안에 두 번 이상)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 노드에서는 react-query 가 서버로 보고 간격 타이머를 걸지 않는다 → 앱(RN)처럼
    environmentManager.setIsServer(() => false);
  });
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => isServer);
  });

  it("구독 직후 1번, 30초 + 1초 뒤 2번, 60초 + 1초 뒤 3번", async () => {
    vi.setSystemTime(Date.parse("2026-09-28T14:03:30+09:00"));
    let calls = 0;
    const api = { reconcileBadge: async () => (calls++, BODY) };
    const qc = new QueryClient();
    const observer = new QueryObserver(qc, reconcileBadgeQuery(api, API));
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(3);
    unsubscribe();
    // 구독이 끊기면(잔고 탭이 가려짐) 더 받지 않는다
    await vi.advanceTimersByTimeAsync(90_000);
    expect(calls).toBe(3);
    qc.clear();
  });
});
