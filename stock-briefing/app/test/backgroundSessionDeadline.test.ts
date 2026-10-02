import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = "https://background-session.test";
const h = vi.hoisted(() => ({ store: new Map<string, string>(), wait: Promise.resolve(), release: () => {} }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://background-session.test" } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => { if (key.startsWith("auth.")) await h.wait; return h.store.get(key) ?? null; },
  setItem: async (key: string, value: string) => void h.store.set(key, value),
  removeItem: async (key: string) => void h.store.delete(key),
  multiGet: async (keys: string[]) => keys.map((key) => [key, h.store.get(key) ?? null]),
  multiSet: async (pairs: [string, string][]) => void pairs.forEach(([key, value]) => h.store.set(key, value)),
} }));

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00")); vi.resetModules();
  h.store.clear(); h.wait = new Promise<void>((resolve) => { h.release = resolve; });
  h.store.set("settings.apiUrl", API);
  h.store.set("settings.apiToken", "offline-api");
  h.store.set("auth.session.v1", JSON.stringify({ apiUrl: API, token: "offline-session", remember: true, user: { id: 1, loginId: "사용자", email: null, isOwner: true }, savedAt: 1 }));
  h.store.set("auth.pendingLogout.v1", JSON.stringify([{ apiUrl: API, token: "offline-pending" }]));
  h.store.set("rq.cache", JSON.stringify({ clientState: { queries: [{ queryKey: [API, "features"], state: { data: { features: { marketSummary: true } } } }] } }));
  h.store.set("widget.lastStocks", JSON.stringify({ at: 1, apiUrl: API, stocks: [{ code: "005930", name: "이전 종목", quantity: 5 }] }));
});
afterEach(async () => { h.release(); const s = await import("@/lib/session"); s.resetSessionForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function modules() {
  const s = await import("@/lib/session");
  const data = await import("@/widgets/data");
  const summaries = await import("@/lib/marketSummaryLoad");
  const logout = await import("@/lib/logout");
  const { createApi } = await import("@/api/client");
  return { s, data, summaries, logout, api: createApi(API) };
}
const push = { stocks: [], filled: [], showKrw: false, afterCost: true, fetchedAt: 1, market: null };

describe("백그라운드 저장소 실패는 로그인 없는 요청으로 바꾸지 않음", () => {
  it.each(["종목 브리핑", "계좌 브리핑", "시장 요약", "위젯 조회", "앱 위젯 전달", "미전달 로그아웃"])("%s 경로는 8초에 끝내고 요청·개인 캐시 덮어쓰기 없이 재시도 가능하게 남긴다", async (kind) => {
    const fetchFn = vi.fn(async () => new Response("[]")); vi.stubGlobal("fetch", fetchFn);
    const { s, data, summaries, logout, api } = await modules();
    const saved = new Map(["auth.session.v1", "auth.pendingLogout.v1", "widget.lastStocks"].map((key) => [key, h.store.get(key)]));
    let settled = false;
    const work = kind === "종목 브리핑" ? data.loadLatestBriefings()
      : kind === "계좌 브리핑" ? data.loadAccountBriefings()
      : kind === "시장 요약" ? summaries.loadMarketSummaries()
      : kind === "위젯 조회" ? data.loadWidgetData()
      : kind === "앱 위젯 전달" ? data.pushWidgetData(push)
      : logout.flushPendingLogouts(api, API);
    const observed = work.then((value) => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
    await vi.advanceTimersByTimeAsync(8_000);
    const settledAtDeadline = settled;
    h.release(); await vi.advanceTimersByTimeAsync(0);
    const result = await observed;
    expect(settledAtDeadline).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(s.sessionFor(API)).toBeNull();
    for (const [key, value] of saved) expect(h.store.get(key)).toBe(value);
    if (kind === "위젯 조회") expect(result).toMatchObject({ value: { stocks: [], briefings: [], error: expect.stringContaining("로그인 정보") } });
    if (kind === "종목 브리핑" || kind === "앱 위젯 전달") expect(result).toMatchObject({ error: { code: "SESSION_STORAGE" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("시장 요약의 더 짧은 개별 기한도 저장소 읽기를 중단하고 서버에 보내지 않는다", async () => {
    const fetchFn = vi.fn(async () => new Response("[]")); vi.stubGlobal("fetch", fetchFn);
    const { summaries } = await modules();
    let settled = false;
    const work = summaries.loadMarketSummaries(1_000).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await work).toBeNull();
    h.release(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("읽기 실패 때 남긴 미전달 로그아웃은 다음 확인에서만 전송하고 정리한다", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchFn);
    const { logout, api } = await modules();
    const first = logout.flushPendingLogouts(api, API);
    await vi.advanceTimersByTimeAsync(8_000); await first;
    expect(fetchFn).not.toHaveBeenCalled();
    expect(h.store.has("auth.pendingLogout.v1")).toBe(true);
    h.release(); await logout.flushPendingLogouts(api, API);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(h.store.has("auth.pendingLogout.v1")).toBe(false);
  });
});
