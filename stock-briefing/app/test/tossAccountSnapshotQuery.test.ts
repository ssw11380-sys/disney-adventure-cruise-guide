import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TossAccountSnapshotBody } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
const { tossAccountSnapshotQuery, tossSnapshotCredentialScope } = await import("@/api/hooks");
const { ApiRequestError, createApi } = await import("@/api/client");
const { resetSessionForTests, saveSession, markAccountsSeen } = await import("@/lib/session");
const API = "https://server.test";
const BODY: TossAccountSnapshotBody = { on: true, snapshot: null, sync: null };
const run = (o: ReturnType<typeof tossAccountSnapshotQuery>) => (o.queryFn as () => Promise<TossAccountSnapshotBody>)();
beforeEach(() => resetSessionForTests());
afterEach(() => { resetSessionForTests(); vi.unstubAllGlobals(); });

describe("토스 계좌 저장 기록 조회", () => {
  it("30초 간격·화면 밖 구독 중지·재시도 없음이며 조회는 동기화를 실행하지 않는다", async () => {
    const api = { tossAccountSnapshot: vi.fn(async () => BODY) };
    const o = tossAccountSnapshotQuery(api, API, "owner:1");
    expect(o.queryKey).toEqual([API, "tossAccountSnapshot", "owner:1"]);
    expect(o.staleTime).toBe(30_000); expect(o.refetchInterval).toBe(30_000);
    expect(o.refetchIntervalInBackground).toBe(false); expect(o.refetchOnWindowFocus).toBe(true); expect(o.retry).toBe(0);
    expect(tossAccountSnapshotQuery(api, API, "owner:1", false).subscribed).toBe(false);
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(BODY), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await createApi(API, "").tossAccountSnapshot();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/admin/toss/account-snapshot");
    expect(fetch.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });
  it("같은 인증으로 화면을 다시 열면 캐시 사용, 서버·인증 변경이면 새 영역을 사용", () => {
    const qc = new QueryClient();
    const a = tossSnapshotCredentialScope(qc, API, "first");
    expect(tossSnapshotCredentialScope(qc, API, "first")).toBe(a);
    const b = tossSnapshotCredentialScope(qc, API, "second"); expect(b).not.toBe(a);
    const c = tossSnapshotCredentialScope(qc, "https://other.test", "second"); expect(c).not.toBe(b);
    const oldKey = tossAccountSnapshotQuery({ tossAccountSnapshot: async () => BODY }, API, String(a)).queryKey;
    const newKey = tossAccountSnapshotQuery({ tossAccountSnapshot: async () => BODY }, API, String(b)).queryKey;
    qc.setQueryData(oldKey, BODY);
    expect(qc.getQueryData(newKey)).toBeUndefined();
    expect(JSON.stringify(newKey)).not.toContain("second"); qc.clear();
  });
  it("주인 아닌 계정은 자동 요청과 수동 queryFn 호출 모두 관리 조회를 보내지 않는다", async () => {
    await saveSession({ apiUrl: API, token: "test-member", remember: false, user: { id: 2, loginId: "member", email: null, isOwner: false, usingInitialPassword: false } });
    const api = { tossAccountSnapshot: vi.fn(async () => BODY) };
    const o = tossAccountSnapshotQuery(api, API, "member");
    expect(o.enabled).toBe(false); expect((await run(o)).on).toBe(false);
    const qc = new QueryClient(); const observer = new QueryObserver(qc, o); const off = observer.subscribe(() => undefined);
    await Promise.resolve(); expect(api.tossAccountSnapshot).not.toHaveBeenCalled(); off(); qc.clear();
  });
  it("로그인 필요한 서버에 세션이 없으면 관리 조회를 보내지 않는다", async () => {
    await markAccountsSeen(API, true);
    const api = { tossAccountSnapshot: vi.fn(async () => BODY) };
    expect(tossAccountSnapshotQuery(api, API, "none").enabled).toBe(false);
    await run(tossAccountSnapshotQuery(api, API, "none"));
    expect(api.tossAccountSnapshot).not.toHaveBeenCalled();
  });
  it("이전 서버 404는 기능 없음, 403과 연결 실패는 정상 금액으로 바꾸지 않는다", async () => {
    expect(await run(tossAccountSnapshotQuery({ tossAccountSnapshot: async () => { throw new ApiRequestError(404, "NOT_FOUND", "없음"); } }, API, "legacy"))).toEqual({ on: false, snapshot: null, sync: null });
    for (const error of [new ApiRequestError(403, "FORBIDDEN", "권한 없음"), new Error("연결 실패")]) {
      await expect(run(tossAccountSnapshotQuery({ tossAccountSnapshot: async () => { throw error; } }, API, "legacy"))).rejects.toBe(error);
    }
  });
});
