import { environmentManager, isServer, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { featuresQuery } = await import("@/api/hooks");
const { freshFeaturesOnce, resetFreshFeaturesForTests } = await import("@/lib/authGate");
const session = await import("@/lib/session");

/**
 * 계정 A단계 검증 지적: 기능 플래그는 기기 저장 캐시로 되살아나고 30초 동안 새것으로 본다 → 서버 모드가 바뀐 직후(예전 서버로 바꿈·비상 끄기를 풂)
 * 앱을 다시 켜도 30초 동안 옛 'accounts' 값을 믿어 로그인 화면이 남거나 안내 띠가 없었다.
 * 검증 4차: 새로 받기는 **설정(서버 주소)을 다 읽은 뒤 그 서버 주소로** 한 번 (예전에는 관문이 처음 그려질 때 — 설정을 읽기 전의 번들 기본 주소로 — 받고,
 * 진짜 서버 주소로 바뀐 뒤에는 30초 안 된 되살린 캐시를 그대로 믿었다). 로그인 화면이 떠 있는 동안에는 30초마다 묻지 않는다
 */
const API = "https://server.test";
const OTHER = "https://other.test";

beforeEach(() => {
  environmentManager.setIsServer(() => false);
  resetFreshFeaturesForTests();
  session.resetSessionForTests();
});
afterEach(() => {
  environmentManager.setIsServer(() => isServer);
  session.resetSessionForTests();
});

function client() {
  const qc = new QueryClient();
  // 방금(1초 전) 되살린 캐시: accounts 켬
  for (const url of [API, OTHER]) qc.setQueryData([url, "features"], { features: { accounts: true }, updatedAt: null } as FeatureFlags, { updatedAt: Date.now() - 1000 });
  const calls: string[] = [];
  const apiFor = (url: string) => ({
    features: async (): Promise<FeatureFlags> => {
      calls.push(url);
      return { features: { accounts: false }, updatedAt: null } as FeatureFlags;
    },
  });
  const accounts = (url: string) => (qc.getQueryData([url, "features"]) as FeatureFlags | undefined)?.features["accounts"];
  return { qc, calls, apiFor, accounts };
}

describe("기능 플래그: 관문은 설정을 읽은 뒤 진짜 서버 주소로 한 번 새로 받는다", () => {
  it("그 서버 주소로 한 번: 30초 안 된 캐시가 있어도 새로 받아 서버의 지금 값(accounts 꺼짐)을 쓴다. 같은 주소는 두 번 받지 않는다", async () => {
    const c = client();
    expect(freshFeaturesOnce(c.qc, c.apiFor(API), API)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls).toEqual([API]);
    expect(c.accounts(API)).toBe(false);
    expect(freshFeaturesOnce(c.qc, c.apiFor(API), API)).toBe(false);
    // 서버 주소를 바꾸면 그 주소로 한 번 더
    expect(freshFeaturesOnce(c.qc, c.apiFor(OTHER), OTHER)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls).toEqual([API, OTHER]);
    c.qc.clear();
  });

  it("다른 화면(그냥 구독): 30초 안 된 캐시는 그대로 (화면을 열 때마다 요청하지 않게)", async () => {
    const c = client();
    const observer = new QueryObserver(c.qc, featuresQuery(c.apiFor(API), API));
    const unsubscribe = observer.subscribe(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.calls).toEqual([]);
    expect(c.accounts(API)).toBe(true);
    unsubscribe();
    c.qc.clear();
  });
});

describe("로그인 화면이 떠 있는 동안(계정 모드 · 이 서버 세션 없음)에는 30초마다 묻지 않는다 (검증 4차)", () => {
  const every = (url: string) => {
    const o = featuresQuery({ features: async () => ({ features: {}, updatedAt: null }) as FeatureFlags }, url);
    const f = o.refetchInterval as (q: unknown) => number | false;
    return f(undefined);
  };
  it("로그인 전 false · 로그인하면 30초 · 계정을 쓰지 않는 서버·예전 서버(fail-open)는 30초", async () => {
    expect(every(API)).toBe(30_000);
    session.markAccountsSeen(API, true);
    expect(every(API)).toBe(false);
    await session.saveSession({ apiUrl: API, token: "gzs1_x", remember: true, user: { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false } });
    expect(every(API)).toBe(30_000);
    await session.clearSession("logout");
    expect(every(API)).toBe(false);
    session.markFailOpen(API);
    expect(every(API)).toBe(30_000);
    expect(every(OTHER)).toBe(30_000);
  });
});
