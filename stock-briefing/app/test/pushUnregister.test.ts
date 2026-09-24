import { beforeEach, describe, expect, it, vi } from "vitest";

// 알림 끄기(N1): 네이티브 모듈만 가짜로, 앱의 실제 API 클라이언트가 가짜 서버(fetch)와 통신한다
vi.mock("expo-notifications", () => ({ setNotificationHandler: () => undefined }));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

const { getStoredToken, PushUnregisterError, unregisterPush } = await import("@/lib/notifications");
const { createApi } = await import("@/api/client");

const API = "https://server.test";
const TOKEN = "ExponentPushToken[fake-device]";
const api = createApi(API);

/** 가짜 서버: 등록된 기기 목록 + 장애 흉내. missing = 없는 토큰을 지울 때 응답 (지금 서버 204, 다른 서버·프록시 404) */
const server = { devices: new Set<string>(), outage: "none" as "none" | "network" | "503", missing: 204 as 204 | 404, deletes: 0 };

beforeEach(() => {
  store.clear();
  server.devices = new Set([TOKEN]);
  server.outage = "none";
  server.missing = 204;
  server.deletes = 0;
  store.set("push.expoToken", TOKEN);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (server.outage === "network") throw new TypeError("Network request failed");
    if (server.outage === "503") return new Response(JSON.stringify({ error: "UNAVAILABLE" }), { status: 503 });
    const m = /\/api\/devices\/(.+)$/.exec(url);
    if (init.method === "DELETE" && m) {
      server.deletes++;
      if (server.devices.delete(decodeURIComponent(m[1]!))) return new Response(null, { status: 204 });
      return server.missing === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
    }
    return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
  });
});

describe("알림 끄기 — 서버 해제 실패 (N1)", () => {
  it("서버에 연결하지 못하면 실패를 알리고, 재시도용 토큰을 남긴다 (서버 등록도 그대로)", async () => {
    server.outage = "network";
    await expect(unregisterPush(api)).rejects.toBeInstanceOf(PushUnregisterError);
    expect(await getStoredToken()).toBe(TOKEN);
    expect(server.devices.has(TOKEN)).toBe(true);
  });

  it("서버가 503이면 실패를 알리고 토큰을 남긴다 — 알림이 아직 켜져 있다고 말한다", async () => {
    server.outage = "503";
    await expect(unregisterPush(api)).rejects.toThrow(/아직 켜져/);
    expect(await getStoredToken()).toBe(TOKEN);
    expect(server.devices.has(TOKEN)).toBe(true);
  });

  it("실패 뒤 다시 끄면 남겨 둔 토큰으로 서버에서 빠지고, 그때 토큰을 지운다", async () => {
    server.outage = "503";
    await expect(unregisterPush(api)).rejects.toThrow();
    server.outage = "none";
    await unregisterPush(api);
    expect(server.devices.has(TOKEN)).toBe(false);
    expect(await getStoredToken()).toBeNull();
    expect(server.deletes).toBe(1);
  });

  it("이미 서버에서 지워진 토큰(404)은 해제된 것으로 보고 토큰을 지운다", async () => {
    server.devices.clear();
    server.missing = 404;
    await unregisterPush(api);
    expect(await getStoredToken()).toBeNull();
  });

  it("이미 지워진 토큰에 지금 서버처럼 204를 줘도 성공", async () => {
    server.devices.clear();
    await unregisterPush(api);
    expect(await getStoredToken()).toBeNull();
  });

  it("저장된 토큰이 없으면(백그라운드 확인 방식) 서버를 부르지 않고 끝난다", async () => {
    store.clear();
    server.outage = "network";
    await unregisterPush(api);
    expect(server.deletes).toBe(0);
  });
});
