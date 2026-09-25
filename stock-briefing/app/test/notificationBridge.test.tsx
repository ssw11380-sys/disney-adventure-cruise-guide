import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 알림을 눌렀을 때의 이동 (BH-50, BH-64). 실제 NotificationBridge 를 최소 렌더러로 그린다.
 *  - 묶음 알림(→ 브리핑 탭)을 종목 상세 위에서 눌러도 탭 묶음을 하나 더 쌓지 않는다
 *  - OTA "지금 다시 시작"으로 JS 만 다시 뜨면 네이티브가 앱을 켰던 옛 알림 응답을 다시 넘긴다 → 이미 처리한 응답이면 다시 이동하지 않는다
 */
const h = vi.hoisted(() => ({
  response: null as unknown,
  canDismiss: false,
  push: vi.fn(),
  navigate: vi.fn(),
  dismissTo: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => undefined,
  setNotificationChannelAsync: async () => null,
  AndroidImportance: { HIGH: 4 },
  useLastNotificationResponse: () => h.response,
}));
vi.mock("expo-router", () => ({ router: { push: h.push, navigate: h.navigate, dismissTo: h.dismissTo, canDismiss: () => h.canDismiss } }));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));

/** 알림 응답 (expo-notifications NotificationResponse 모양) */
const tap = (identifier: string, data: Record<string, unknown>, date = Date.parse("2026-09-24T17:00:00+09:00")) => ({
  actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
  notification: { date, request: { identifier, content: { title: "브리핑", body: "", data } } },
});

/** JS 를 새로 띄운다 (앱 시작·OTA 다시 시작): 모듈 상태·화면 상태는 새로, 기기 저장소는 그대로 */
async function boot() {
  vi.resetModules();
  const R = await import("react");
  const { render } = await import("./miniRender");
  const { NotificationBridge } = await import("@/components/NotificationBridge");
  return render(R.createElement(NotificationBridge));
}
const moves = () => h.push.mock.calls.length + h.navigate.mock.calls.length + h.dismissTo.mock.calls.length;
const settle = () => new Promise((r) => setTimeout(r, 120));

beforeEach(() => {
  h.store.clear();
  h.response = null;
  h.canDismiss = false;
  for (const f of [h.push, h.navigate, h.dismissTo]) f.mockReset();
});

describe("BH-64: OTA 다시 시작 뒤 옛 알림으로 다시 이동하지 않는다", () => {
  it("알림으로 켠 뒤 같은 프로세스에서 JS 를 다시 띄우면, 다시 넘겨받은 같은 응답으로는 이동하지 않는다 (재현)", async () => {
    h.response = tap("local-digest-1", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    // "지금 다시 시작" → 네이티브가 같은 응답을 새 JS 에 다시 준다
    await boot();
    await settle();
    expect(moves()).toBe(1);
  });

  it("다시 시작한 뒤 새로 누른 알림은 이동한다", async () => {
    h.response = tap("local-digest-1", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    await boot();
    await settle();
    h.response = tap("remote-42", { type: "briefing", briefingId: 42 });
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/42"));
    expect(moves()).toBe(2);
  });

  it("같은 식별자라도 새로 올라온 알림(시각이 다름)이면 이동한다", async () => {
    h.response = tap("same-tag", { type: "briefing", briefingId: 7 }, 1_000);
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    h.response = tap("same-tag", { type: "briefing", briefingId: 8 }, 2_000);
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenLastCalledWith("/briefings/8"));
  });

  it("저장소를 읽지 못해도 이동은 한다", async () => {
    h.store.set("notifications.handled", "{깨진 값");
    h.response = tap("n-1", { type: "briefing", briefingId: 3 });
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/3"));
  });
});

describe("BH-50: 묶음 알림은 탭 묶음을 새로 쌓지 않는다", () => {
  it("종목 상세 위(루트 스택에 화면이 쌓임)에서 누르면 기존 탭으로 돌아가 브리핑 탭을 연다 (재현)", async () => {
    h.canDismiss = true;
    h.response = tap("digest-1", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    expect(h.dismissTo).toHaveBeenCalledWith("/briefings");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("탭 안에서 누르면 탭만 바꾼다", async () => {
    h.response = tap("digest-2", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    expect(h.navigate).toHaveBeenCalledWith("/briefings");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("종목 하나 브리핑 알림은 예전처럼 상세 화면을 연다", async () => {
    h.canDismiss = true;
    h.response = tap("single-1", { type: "briefing", briefingId: 99 });
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/99"));
    expect(moves()).toBe(1);
  });
});
