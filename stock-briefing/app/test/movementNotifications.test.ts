import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ store: new Map<string, string>(), events: [] as { id: string; title: string; body: string; data: object; createdAt: string }[], shown: [] as string[], requests: 0, failSeen: false, onFetch: null as null | (() => void) }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (k: string) => h.store.get(k) ?? null,
  setItem: async (k: string, v: string) => { if (h.failSeen && k === "movement.seen.v1") throw Error("저장 실패"); h.store.set(k, v); },
} }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ status: "granted" }),
  getPresentedNotificationsAsync: async () => h.shown.map(identifier => ({ request: { identifier } })),
  getAllScheduledNotificationsAsync: async () => [],
  scheduleNotificationAsync: async ({ identifier }: { identifier: string }) => { h.shown.push(identifier); return identifier; },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@/lib/settings", () => ({ defaultApiUrl: () => "https://example.test", STORAGE_KEYS: { apiUrl: "url", apiToken: "token" } }));
vi.mock("@/lib/queryPersist", () => ({ PERSIST_STORAGE_KEY: "flags" }));
vi.mock("@/lib/marketSummaryLoad", () => ({ persistedFeatureOn: (raw: string | null) => raw === "on" }));
vi.mock("@/lib/session", () => ({ assertSessionIdentity: vi.fn(), backgroundSessionFor: async () => ({ kind: "none" }), personalBlocked: () => false, sessionIdentityVersion: () => 0 }));
vi.mock("@/api/client", () => ({ createApi: () => ({ movementEvents: async () => { h.requests++; h.onFetch?.(); return { events: h.events }; } }) }));
const { checkMovementNotifications } = await import("@/lib/movementNotifications");
const event = (id: string) => ({ id, title: "테스트 +5%", body: "전일 종가 대비", data: { type: "movementAlert", code: "005930" }, createdAt: "2026-10-05T01:00:00Z" });
beforeEach(() => { h.store.clear(); h.store.set("push.localMode", "1"); h.store.set("flags", "on"); h.events = []; h.shown = []; h.requests = 0; h.failSeen = false; h.onFetch = null; });
describe("실제 푸시가 없는 설치본의 가격 사건 전달", () => {
  it("처음에는 과거 사건을 기준으로 삼고 이후 새 사건만 한 번 전달한다", async () => {
    h.events = [event("old")]; expect(await checkMovementNotifications()).toBe(0);
    h.events.push(event("new")); await Promise.all([checkMovementNotifications(), checkMovementNotifications()]);
    expect(h.shown).toHaveLength(1); await checkMovementNotifications(); expect(h.shown).toHaveLength(1);
  });
  it("권한을 켠 로컬 모드와 기능 플래그가 있어야 조회한다", async () => {
    h.store.set("push.localMode", "0"); await checkMovementNotifications(); expect(h.requests).toBe(0);
    h.store.set("push.localMode", "1"); h.store.set("flags", "off"); await checkMovementNotifications(); expect(h.requests).toBe(0);
  });
  it("발송 후 기록 저장이 실패해도 OS의 같은 식별자로 중복을 막는다", async () => {
    await checkMovementNotifications(); h.events = [event("new")]; h.failSeen = true;
    await expect(checkMovementNotifications()).rejects.toThrow("저장 실패"); expect(h.shown).toHaveLength(1);
    h.failSeen = false; await checkMovementNotifications(); expect(h.shown).toHaveLength(1);
  });
  it("조회 중 서버 인증이 바뀌면 이전 응답으로 알리지 않는다", async () => {
    await checkMovementNotifications(); h.events = [event("new")]; h.onFetch = () => { h.store.set("token", "changed"); };
    expect(await checkMovementNotifications()).toBe(0); expect(h.shown).toHaveLength(0);
  });
});
