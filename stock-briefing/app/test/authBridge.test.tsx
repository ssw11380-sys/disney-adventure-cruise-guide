import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionStorage, resetSessionForTests, saveSession, clearSession, DEVICE_KEY, type AccountUser } from "@/lib/session";
import { cleanupRenders, render } from "./miniRender";

/**
 * 계정 A단계 앱 루트 연결 (components/AuthBridge) — 검증 지적 보강:
 *  - 계정이 바뀌면 react-query·기기 저장 캐시·조건부 요청 기억을 세션을 바꾸는 그 자리에서 비운다 (화면을 다시 그리기 전에 — 탭이 앞 사람의 잔고를 한 번 그리지 않게)
 *  - 받은 플래그를 기기에 적는 것은 설정(서버 주소)을 다 읽은 뒤에만 (읽기 전 번들 기본 주소로 다른 서버의 표시를 덮어쓰지 않게)
 *  - 주인으로 로그인하면 이 기기의 알림 등록을 새 세션에 다시 묶는다 (주인 아닌 계정은 하지 않음)
 */
const SERVER = "https://prod.test";
const OWNER: AccountUser = { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false };
const MEMBER: AccountUser = { id: 7, loginId: "newbie", email: "n@example.com", isOwner: false, usingInitialPassword: false };

const h = vi.hoisted(() => ({
  ready: true,
  apiUrl: "https://prod.test",
  flag: true as boolean | null,
  order: [] as string[],
  store: new Map<string, string>(),
  rebind: vi.fn(async () => undefined),
  // 앱처럼 같은 객체를 돌려준다 (useApi·useQueryClient 는 앱에서 메모된 값)
  qc: { clear: () => undefined } as { clear: () => void; fetchQuery?: (o: { queryKey: unknown[] }) => Promise<unknown> },
  /** 관문이 기능 플래그를 새로 받은 서버 주소 (lib/authGate freshFeaturesOnce) */
  fresh: [] as unknown[],
  api: {} as Record<string, unknown>,
}));
h.qc = { clear: () => void h.order.push("qc.clear"), fetchQuery: async (o) => void h.fresh.push(o.queryKey[0]) };
h.api = { me: async () => ({ user: { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false }, session: { id: 1, remember: true, expiresAt: "" } }) };

vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" }, Platform: { OS: "android" } }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => h.qc }));
vi.mock("@/lib/queryPersist", () => ({ queryPersister: { removeClient: async () => void h.order.push("persist.remove") } }));
vi.mock("@/api/condCache", () => ({ condReset: () => h.order.push("cond.reset") }));
vi.mock("@/api/hooks", () => ({
  useApi: () => h.api,
  featuresQuery: (_api: unknown, url: string) => ({ queryKey: [url, "features"] }),
  useFeatures: () => ({ data: h.flag === null ? undefined : { features: { accounts: h.flag } } }),
  useFeature: (key: string, fallback = false) => (key === "accounts" ? (h.flag ?? fallback) : fallback),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: h.apiUrl, ready: h.ready }) }));

const { AuthBridge } = await import("@/components/AuthBridge");
const { flushPendingLogouts, logout, setPushRebind } = await import("@/lib/logout");
const { ApiRequestError } = await import("@/api/client");
const { PENDING_LOGOUT_KEY, pendingLogoutsFor } = await import("@/lib/session");
const { resetFreshFeaturesForTests } = await import("@/lib/authGate");

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((res) => setTimeout(res, 0));
};

beforeEach(() => {
  cleanupRenders();
  resetSessionForTests();
  resetFreshFeaturesForTests();
  h.store.clear();
  installSessionStorage({ getItem: async (k) => h.store.get(k) ?? null, setItem: async (k, v) => void h.store.set(k, v), removeItem: async (k) => void h.store.delete(k) });
  h.ready = true;
  h.apiUrl = SERVER;
  h.flag = true;
  h.order.length = 0;
  h.fresh.length = 0;
  h.rebind.mockClear();
  setPushRebind(h.rebind);
});
afterEach(() => {
  cleanupRenders();
  resetSessionForTests();
  setPushRebind(null);
});

describe("AuthBridge", () => {
  it("다른 사람으로 로그인하면 세션을 저장하는 그 자리에서(화면에 알리기 전에) 캐시를 비운다", async () => {
    render(<AuthBridge />);
    await settle();
    h.order.length = 0;
    const saving = saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: false, user: MEMBER });
    // await 전에 이미 비웠다 (동기)
    expect(h.order).toEqual(["qc.clear", "persist.remove", "cond.reset"]);
    await saving;
    h.order.length = 0;
    await clearSession("logout");
    expect(h.order).toEqual(["qc.clear", "persist.remove", "cond.reset"]);
  });

  it("받은 플래그는 설정을 다 읽은 뒤에만 기기에 적는다 (읽기 전 번들 기본 주소로 덮어쓰지 않게)", async () => {
    h.ready = false;
    h.apiUrl = "http://localhost:3000";
    const r = render(<AuthBridge />);
    await settle();
    expect(h.store.has(DEVICE_KEY)).toBe(false);
    // 기능 플래그 새로 받기도 설정을 읽은 뒤 진짜 서버 주소로 한 번 (검증 4차 — 번들 기본 주소로 받지 않는다)
    expect(h.fresh).toEqual([]);
    h.ready = true;
    h.apiUrl = SERVER;
    r.rerender();
    await settle();
    expect(JSON.parse(h.store.get(DEVICE_KEY)!)).toEqual({ apiUrl: SERVER, accountsSeen: true });
    expect(h.fresh).toEqual([SERVER]);
    r.rerender();
    await settle();
    expect(h.fresh).toEqual([SERVER]);
  });

  it("주인으로 로그인하면 알림 등록을 새 세션에 다시 묶는다 — 주인 아닌 계정·플래그 꺼짐은 하지 않는다", async () => {
    const r = render(<AuthBridge />);
    await saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: true, user: MEMBER });
    r.rerender();
    await settle();
    expect(h.rebind).not.toHaveBeenCalled();
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER });
    r.rerender();
    await settle();
    expect(h.rebind).toHaveBeenCalledTimes(1);
    h.flag = false;
    await saveSession({ apiUrl: SERVER, token: "gzs1_o2", remember: true, user: OWNER });
    r.rerender();
    await settle();
    expect(h.rebind).toHaveBeenCalledTimes(1);
  });

  it("자동 로그인을 끈 주인 세션은 알림 등록을 다시 묶지 않는다 (검증 5차 — 앱을 닫아 로그아웃된 폰에 주인 푸시가 가지 않게)", async () => {
    const r = render(<AuthBridge />);
    await saveSession({ apiUrl: SERVER, token: "gzs1_short", remember: false, user: OWNER });
    r.rerender();
    await settle();
    expect(h.rebind).not.toHaveBeenCalled();
    // 자동 로그인을 켜고 다시 로그인하면 묶는다
    await saveSession({ apiUrl: SERVER, token: "gzs1_long", remember: true, user: OWNER });
    r.rerender();
    await settle();
    expect(h.rebind).toHaveBeenCalledTimes(1);
  });
});

describe("인터넷이 끊긴 채 로그아웃 (서버에 알리지 못한 세션)", () => {
  it("세션 토큰을 기기에 적어 두고, 다음에 켤 때 그 토큰으로 서버에 다시 알린다 — 서버가 답하면 지우고, 닿지 않으면 남긴다", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_offline", remember: true, user: MEMBER });
    const api = {
      logout: vi.fn(async () => {
        throw new ApiRequestError(0, "NETWORK", "x", "/api/auth/logout", SERVER);
      }),
      logoutSession: vi.fn(async (_t: string): Promise<void> => {
        throw new ApiRequestError(0, "NETWORK", "x", "/api/auth/logout", SERVER);
      }),
    };
    await logout(api as never, SERVER);
    // 이 기기에서는 로그아웃 (세션 없음), 알리지 못한 토큰은 남김
    expect(h.store.has("auth.session.v1")).toBe(false);
    expect(await pendingLogoutsFor(SERVER)).toEqual(["gzs1_offline"]);
    expect(JSON.parse(h.store.get(PENDING_LOGOUT_KEY)!)).toEqual([{ apiUrl: SERVER, token: "gzs1_offline" }]);
    // 여전히 끊김: 남긴다
    await flushPendingLogouts(api as never, SERVER);
    expect(api.logoutSession).toHaveBeenCalledWith("gzs1_offline");
    expect(await pendingLogoutsFor(SERVER)).toEqual(["gzs1_offline"]);
    // 다시 켜진 앱이 기기에서 읽어 와 알린다 → 서버가 받으면 지운다
    resetSessionForTests();
    installSessionStorage({ getItem: async (k) => h.store.get(k) ?? null, setItem: async (k, v) => void h.store.set(k, v), removeItem: async (k) => void h.store.delete(k) });
    api.logoutSession.mockImplementationOnce(async () => undefined);
    await flushPendingLogouts(api as never, SERVER);
    expect(await pendingLogoutsFor(SERVER)).toEqual([]);
    expect(h.store.has(PENDING_LOGOUT_KEY)).toBe(false);
  });

  it("서버가 답한 오류(이미 끝난 세션 401 등)면 다시 알리지 않는다, 다른 서버의 것은 건드리지 않는다", async () => {
    await saveSession({ apiUrl: "https://other.test", token: "gzs1_other", remember: true, user: MEMBER });
    const api = {
      logout: vi.fn(async () => {
        throw new ApiRequestError(503, "HTTP_503", "x", "/api/auth/logout", "https://other.test");
      }),
      logoutSession: vi.fn(async () => {
        throw new ApiRequestError(401, "SESSION_INVALID", "x", "/api/auth/logout", SERVER);
      }),
    };
    await logout(api as never, "https://other.test");
    await saveSession({ apiUrl: SERVER, token: "gzs1_here", remember: true, user: MEMBER });
    await logout(api as never, SERVER);
    expect(await pendingLogoutsFor(SERVER)).toEqual(["gzs1_here"]);
    await flushPendingLogouts(api as never, SERVER);
    expect(await pendingLogoutsFor(SERVER)).toEqual([]);
    expect(await pendingLogoutsFor("https://other.test")).toEqual(["gzs1_other"]);
    // 로그아웃 요청이 서버에 닿았으면(4xx) 적지 않는다
    await saveSession({ apiUrl: SERVER, token: "gzs1_gone", remember: true, user: MEMBER });
    api.logout.mockImplementationOnce(async () => {
      throw new ApiRequestError(401, "SESSION_INVALID", "x", "/api/auth/logout", SERVER);
    });
    await logout(api as never, SERVER);
    expect(await pendingLogoutsFor(SERVER)).toEqual([]);
  });
});
