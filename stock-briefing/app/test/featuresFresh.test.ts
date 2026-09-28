import { environmentManager, isServer, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { featuresQuery } = await import("@/api/hooks");

/**
 * 계정 A단계 검증 지적: 기능 플래그는 기기 저장 캐시로 되살아나고 30초 동안 새것으로 본다 → 서버 모드가 바뀐 직후(예전 서버로 바꿈·비상 끄기를 풂)
 * 앱을 다시 켜도 30초 동안 옛 'accounts' 값을 믿어 로그인 화면이 남거나 안내 띠가 없었다.
 * 로그인 관문(lib/authGate useAccountsFlag)은 fresh 로 구독 → 그려질 때 한 번 새로 받는다. 다른 화면은 그대로(열 때마다 요청하지 않음)
 */
const API = "https://server.test";

beforeEach(() => {
  environmentManager.setIsServer(() => false);
});
afterEach(() => {
  environmentManager.setIsServer(() => isServer);
});

async function mount(fresh: boolean) {
  const qc = new QueryClient();
  // 방금(1초 전) 되살린 캐시: accounts 켬
  qc.setQueryData([API, "features"], { features: { accounts: true }, updatedAt: null } as FeatureFlags, { updatedAt: Date.now() - 1000 });
  let calls = 0;
  const api = {
    features: async (): Promise<FeatureFlags> => {
      calls++;
      return { features: { accounts: false }, updatedAt: null } as FeatureFlags;
    },
  };
  const observer = new QueryObserver(qc, featuresQuery(api, API, { fresh }));
  const unsubscribe = observer.subscribe(() => undefined);
  await new Promise((r) => setTimeout(r, 0));
  const accounts = () => (observer.getCurrentResult().data as FeatureFlags | undefined)?.features["accounts"];
  return { calls: () => calls, accounts, done: () => (unsubscribe(), qc.clear()) };
}

describe("기능 플래그: 관문은 켤 때 한 번 새로 받는다", () => {
  it("fresh: 30초 안 된 캐시가 있어도 그려질 때 새로 받아 서버의 지금 값(accounts 꺼짐)을 쓴다", async () => {
    const m = await mount(true);
    expect(m.calls()).toBe(1);
    expect(m.accounts()).toBe(false);
    m.done();
  });
  it("다른 화면(fresh 없음): 30초 안 된 캐시는 그대로 (화면을 열 때마다 요청하지 않게)", async () => {
    const m = await mount(false);
    expect(m.calls()).toBe(0);
    expect(m.accounts()).toBe(true);
    m.done();
  });
});
