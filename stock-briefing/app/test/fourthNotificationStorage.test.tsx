import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";
import type { AccountBriefing, LatestBriefing } from "@/api/types";
import { DEFAULT_PREFS } from "@/lib/briefingDigest";

const h = vi.hoisted(() => ({
  store: new Map<string, string>(), failRemove: false, failRegister: false,
  registered: false, registrations: 0, removals: 0, serverChanges: [] as unknown[],
  failReadKey: "", notified: [] as unknown[],
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => { if (key === h.failReadKey) throw new Error("가짜 알림 기록 읽기 실패"); return h.store.get(key) ?? null; },
  setItem: async (key: string, value: string) => { h.store.set(key, value); },
  removeItem: async (key: string) => {
    if (key === "push.localMode") { h.removals++; if (h.failRemove) throw new Error("가짜 기기 저장 실패"); }
    h.store.delete(key);
  },
} }));
vi.mock("expo-notifications", () => ({
  getPresentedNotificationsAsync: async () => [], getAllScheduledNotificationsAsync: async () => [],
  getPermissionsAsync: async () => ({ status: "granted" }),
  scheduleNotificationAsync: async (input: unknown) => { h.notified.push(input); },
}));
vi.mock("@/lib/settings", () => ({ STORAGE_KEYS: { apiUrl: "settings.apiUrl" }, defaultApiUrl: () => "https://server.test" }));
vi.mock("expo-background-task", () => ({
  getStatusAsync: async () => 1,
  registerTaskAsync: async () => { h.registrations++; if (h.failRegister) throw new Error("가짜 작업 등록 실패"); h.registered = true; },
  unregisterTaskAsync: async () => { h.registered = false; },
  BackgroundTaskStatus: { Restricted: 0, Available: 1 },
}));
vi.mock("expo-task-manager", () => ({ isTaskRegisteredAsync: async () => h.registered }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s }, Alert: { alert: vi.fn() },
}));
vi.mock("@react-native-community/datetimepicker", () => ({ DateTimePickerAndroid: { open: vi.fn() } }));
vi.mock("@/theme", async () => { const tokens = await import("@/tokens"); return { ...tokens, useTheme: () => tokens.dark }; });
vi.mock("@/api/hooks", () => ({
  useApi: () => ({}), useFeature: () => false,
  useNotificationMutations: () => ({ updateSettings: { mutate: (value: unknown) => h.serverChanges.push(value) }, sendTest: { mutate: vi.fn() } }),
  useNotificationSettings: () => ({ data: undefined, isLoading: false, isError: false, refetch: async () => ({ data: undefined }) }),
  useRegisteredStocks: () => ({ data: undefined }),
}));
vi.mock("@/lib/account", () => ({ useAccountView: () => ({ session: null }) }));
vi.mock("@/lib/notifications", () => {
  class PushSetupError extends Error { constructor(public code: string, message: string) { super(message); } }
  return {
    ANDROID_CHANNEL: "briefings", ensureAndroidChannel: async () => undefined,
    getStoredToken: async () => null, PushSetupError,
    registerForPush: async () => { throw new PushSetupError("TOKEN", "가짜 원격 푸시 미지원"); },
    unregisterPush: async () => undefined,
  };
});
vi.mock("@/lib/marketSummaryLoad", () => ({}));
vi.mock("@/lib/widgetRefreshLog", () => ({}));
vi.mock("@/widgets/data", () => ({ loadLatestBriefings: async () => [] }));
vi.mock("@/widgets/model", () => ({}));
vi.mock("@/widgets/payload", () => ({}));
vi.mock("@/widgets/redraw", () => ({}));
vi.mock("@/widgets/refresh", () => ({}));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Loading: "Loading", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Toggle: "Toggle" }));

import { NotificationSettingsCard } from "@/components/NotificationSettingsCard";
import { hasUnseen, isLocalModeEnabled, LOCAL_MODE_KEY, notifyNewBriefings } from "@/lib/backgroundBriefings";
import { INIT_KEY, SEEN_KEY } from "@/lib/briefingSeen";

function briefing(id: number): LatestBriefing {
  return { code: "005930", name: "가짜 종목", latest: {
    id, code: "005930", name: "가짜 종목", date: "2026-10-03", session: "morning", status: "ok",
    summary: "가짜 요약", detail: "가짜 본문", missing: [], model: "가짜", error: null, createdAt: "2026-10-03T09:00:00+09:00",
  } };
}

async function settle(r: ReturnType<typeof render>) {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  r.rerender();
}
async function change(r: ReturnType<typeof render>, enabled: boolean) {
  r.act(() => (r.byLabel("브리핑 알림").props.onValueChange as (value: boolean) => void)(enabled));
  await settle(r);
}

beforeEach(() => {
  cleanupRenders(); h.store.clear(); h.serverChanges.length = 0;
  h.failRemove = false; h.failRegister = false; h.registered = false; h.registrations = 0; h.removals = 0;
  h.failReadKey = ""; h.notified.length = 0;
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T14:00:00+09:00"));
});
afterEach(() => { cleanupRenders(); vi.useRealTimers(); });

describe("4차: 로컬 알림 설정과 기기 저장 실패의 결합", () => {
  it("끄기 삭제가 실패하면 스위치를 켠 채 안내하고 재시도 성공 뒤에만 꺼진다", async () => {
    h.store.set(LOCAL_MODE_KEY, "1"); h.failRemove = true;
    const r = render(<NotificationSettingsCard />); await settle(r);
    expect(r.byLabel("브리핑 알림").props.value).toBe(true);
    await change(r, false);
    expect(await isLocalModeEnabled()).toBe(true);
    expect(r.byLabel("브리핑 알림").props.value).toBe(true);
    expect(r.text()).toContain("알림을 끄지 못해 아직 켜져 있습니다");
    expect(r.byLabel("브리핑 알림").props.disabled).toBe(false);
    h.failRemove = false;
    await change(r, false);
    expect(await isLocalModeEnabled()).toBe(false);
    expect(r.byLabel("브리핑 알림").props.value).toBe(false);
    expect(r.text()).not.toContain("알림을 끄지 못해 아직 켜져 있습니다");
    expect(h.removals).toBe(2);
    expect(h.serverChanges).toEqual([]);
  });

  it("켜기 작업 등록 실패는 저장소에 켜짐을 남기지 않고 화면 재진입 뒤 재시도할 수 있다", async () => {
    h.failRegister = true;
    let r = render(<NotificationSettingsCard />); await settle(r);
    await change(r, true);
    expect(r.text()).toContain("가짜 작업 등록 실패");
    expect(r.byLabel("브리핑 알림").props.value).toBe(false);
    expect(await isLocalModeEnabled()).toBe(false);
    expect(h.serverChanges).toEqual([]);
    r.unmount(); r = render(<NotificationSettingsCard />); await settle(r);
    expect(r.byLabel("브리핑 알림").props.value).toBe(false);
    h.failRegister = false;
    await change(r, true);
    expect(await isLocalModeEnabled()).toBe(true);
    expect(r.byLabel("브리핑 알림").props.value).toBe(true);
    expect(h.registered).toBe(true);
    expect(h.registrations).toBe(2);
    expect(h.serverChanges).toEqual([{ pushEnabled: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("기존 발송 기록을 읽지 못하면 빈 기록으로 재발송하지 않고 복구 뒤 새 보고서만 알린다", async () => {
    h.store.set(SEEN_KEY, "[1]"); h.store.set(INIT_KEY, "1"); h.failReadKey = SEEN_KEY;
    const results = await Promise.allSettled([hasUnseen([1, 2]), notifyNewBriefings([briefing(1), briefing(2)])]);
    expect(h.notified).toEqual([]);
    expect(results.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.objectContaining({ message: "알림 기록을 읽지 못했습니다. 다음 확인에서 다시 시도합니다." }) })]));
    expect(h.store.get(SEEN_KEY)).toBe("[1]");
    h.failReadKey = "";
    expect(await notifyNewBriefings([briefing(1), briefing(2)])).toBe(1);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({ content: { data: { briefingId: 2 } } });
    expect(await hasUnseen([1, 2])).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("빈 목록의 초기화 표시를 읽지 못하면 새 보고서를 이미 본 것으로 소모하지 않는다", async () => {
    h.store.set(SEEN_KEY, "[]"); h.store.set(INIT_KEY, "1"); h.failReadKey = INIT_KEY;
    await expect(notifyNewBriefings([briefing(2)])).rejects.toThrow("알림 기록을 읽지 못했습니다");
    expect(h.notified).toEqual([]);
    expect(h.store.get(SEEN_KEY)).toBe("[]");
    h.failReadKey = "";
    expect(await notifyNewBriefings([briefing(2)])).toBe(1);
    expect(h.notified).toHaveLength(1);
  });

  it("계좌 알림 기준 읽기도 실패를 처음 사용으로 바꾸지 않고 복구 뒤 한 번 알린다", async () => {
    h.store.set(SEEN_KEY, "[1]"); h.store.set(INIT_KEY, "1"); h.store.set("accountBriefings.notifyInit", "1");
    h.failReadKey = "accountBriefings.notifyInit";
    const account: AccountBriefing = {
      id: 10, date: "2026-10-03", session: "morning", status: "ok", summary: "가짜 계좌 요약", detail: "가짜 본문",
      model: "가짜", template: true, createdAt: "2026-10-03T09:00:00+09:00",
      headline: { totalValue: 10000, holdings: 1, dayPnl: 100, dayRate: 1, top: [] },
    };
    const opts = { accounts: [account], accountIds: [10], prefs: { ...DEFAULT_PREFS, accountBriefing: true } };
    await expect(notifyNewBriefings([], opts)).rejects.toThrow();
    expect(h.notified).toEqual([]);
    expect(h.store.get(SEEN_KEY)).toBe("[1]");
    h.failReadKey = "";
    expect(await notifyNewBriefings([], opts)).toBe(1);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toMatchObject({ content: { data: { accountBriefingId: 10 } } });
    expect(await notifyNewBriefings([], opts)).toBe(0);
  });
});
