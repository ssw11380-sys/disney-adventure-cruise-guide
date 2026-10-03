import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, LatestBriefing } from "@/api/types";
import { DEFAULT_PREFS } from "@/lib/briefingDigest";

const h = vi.hoisted(() => ({ store: new Map<string, string>(), delivered: [] as string[], attempts: 0, failAt: 0 }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => h.store.get(key) ?? null,
  setItem: async (key: string, value: string) => { h.store.set(key, value); },
  removeItem: async (key: string) => { h.store.delete(key); },
} }));
vi.mock("expo-notifications", () => ({
  getPresentedNotificationsAsync: async () => [], getAllScheduledNotificationsAsync: async () => [], scheduleNotificationAsync: async (input: { content: { data: { session: string; briefingId?: number } } }) => {
  if (++h.attempts === h.failAt) throw new Error("기기 알림 예약 실패");
  h.delivered.push(`${input.content.data.session}:${input.content.data.briefingId}`);
} }));
vi.mock("@/lib/settings", () => ({ STORAGE_KEYS: { apiUrl: "settings.apiUrl" }, defaultApiUrl: () => "https://server.test" }));
vi.mock("expo-background-task", () => ({}));
vi.mock("expo-task-manager", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@/lib/notifications", () => ({ ANDROID_CHANNEL: "briefings" }));
vi.mock("@/lib/marketSummaryLoad", () => ({}));
vi.mock("@/lib/widgetRefreshLog", () => ({}));
vi.mock("@/widgets/data", () => ({}));
vi.mock("@/widgets/model", () => ({}));
vi.mock("@/widgets/payload", () => ({}));
vi.mock("@/widgets/redraw", () => ({}));
vi.mock("@/widgets/refresh", () => ({}));

import { notifyNewBriefings } from "@/lib/backgroundBriefings";
import { INIT_KEY, SEEN_KEY, seenIds } from "@/lib/briefingSeen";
const NOW = new Date("2026-10-02T17:00:00+09:00");
function item(id: number, session: "morning" | "afternoon"): LatestBriefing {
  const code = String(id).padStart(6, "0");
  return { code, name: `종목${id}`, latest: { id, code, name: `종목${id}`, date: "2026-10-02", session, status: "ok", summary: "요약", detail: "본문", missing: [], model: "가짜", error: null, createdAt: "2026-10-02T16:00:00+09:00" } };
}
const list = [item(1, "morning"), item(2, "morning"), item(3, "afternoon")];
beforeEach(() => {
  h.store.clear(); h.delivered.length = 0; h.attempts = 0; h.failAt = 0;
  h.store.set(INIT_KEY, "1"); h.store.set(SEEN_KEY, "[90]");
  vi.useFakeTimers(); vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe("백그라운드 알림 일부 발송 뒤 기기 실패", () => {
  it("오전 묶음을 보낸 뒤 오후 발송이 실패하면 다음 확인은 오후만 알린다", async () => {
    h.failAt = 2;
    const opts = { now: NOW, prefs: DEFAULT_PREFS };
    await expect(notifyNewBriefings(list, opts)).rejects.toThrow("기기 알림 예약 실패");
    expect(await seenIds()).toEqual(new Set([90, 1, 2]));
    h.failAt = 0;
    // 메모리 기록을 이어받지 않고 같은 저장소에서 새 모듈로 다시 시작한다.
    vi.resetModules();
    const restarted = await import("@/lib/backgroundBriefings");
    expect(await restarted.notifyNewBriefings(list, opts)).toBe(1);
    expect(h.delivered).toEqual(["morning:1", "afternoon:3"]);
  });

  it("종목별 알림의 두 번째 발송이 실패해도 첫 번째를 반복하거나 나머지를 누락하지 않는다", async () => {
    h.failAt = 2;
    const opts = { now: NOW, prefs: { ...DEFAULT_PREFS, digest: false } };
    await expect(notifyNewBriefings(list, opts)).rejects.toThrow("기기 알림 예약 실패");
    expect(await seenIds()).toEqual(new Set([90, 1]));
    h.failAt = 0;
    expect(await notifyNewBriefings(list, opts)).toBe(2);
    expect(h.delivered).toEqual(["morning:1", "morning:2", "afternoon:3"]);
  });

  it("정상 묶음은 기존 문구와 세션당 한 건을 유지하고 다음 확인은 알리지 않는다", async () => {
    expect(await notifyNewBriefings(list, { now: NOW, prefs: DEFAULT_PREFS })).toBe(2);
    expect(await notifyNewBriefings(list, { now: NOW, prefs: DEFAULT_PREFS })).toBe(0);
    expect(h.delivered).toEqual(["morning:1", "afternoon:3"]);
  });

  it("첫 예약이 실패하면 미전송 대상은 보류하지만 끈 종목은 이미 처리한 것으로 남긴다", async () => {
    h.failAt = 1;
    const opts = { now: NOW, prefs: { ...DEFAULT_PREFS, mutedCodes: ["000001"] } };
    await expect(notifyNewBriefings(list, opts)).rejects.toThrow("기기 알림 예약 실패");
    expect(await seenIds()).toEqual(new Set([90, 1]));
    h.failAt = 0;
    expect(await notifyNewBriefings(list, { ...opts, prefs: DEFAULT_PREFS })).toBe(2);
    expect(h.delivered).toEqual(["morning:2", "afternoon:3"]);
  });

  it("계좌 요약만 있는 두 세션도 성공분만 적고 실패한 세션은 다음에 한 번 보낸다", async () => {
    h.store.set("accountBriefings.notifyInit", "1");
    const accounts = (["morning", "afternoon"] as const).map((session, i): AccountBriefing => ({
      id: 100 + i, date: "2026-10-02", session, status: "ok", summary: "계좌 요약", detail: "본문", model: "가짜", template: true,
      createdAt: "2026-10-02T16:00:00+09:00", headline: { totalValue: 10000, holdings: 1, dayPnl: 100, dayRate: 1, top: [] },
    }));
    const opts = { now: NOW, accounts, accountIds: [100, 101], prefs: { ...DEFAULT_PREFS, accountBriefing: true } };
    h.failAt = 2;
    await expect(notifyNewBriefings([], opts)).rejects.toThrow("기기 알림 예약 실패");
    expect(await seenIds()).toEqual(new Set([90, -100]));
    h.failAt = 0;
    expect(await notifyNewBriefings([], opts)).toBe(1);
    expect(h.delivered).toEqual(["morning:undefined", "afternoon:undefined"]);
  });

  it("조용한 시간에는 예약 없이 기록만 저장하여 다음 날 옛 알림이 나오지 않는다", async () => {
    h.failAt = 1;
    expect(await notifyNewBriefings(list, { now: new Date("2026-10-02T23:00:00+09:00"), prefs: DEFAULT_PREFS })).toBe(0);
    expect(h.attempts).toBe(0);
    expect(await seenIds()).toEqual(new Set([90, 1, 2, 3]));
    expect(await notifyNewBriefings(list, { now: new Date("2026-10-03T08:00:00+09:00"), prefs: DEFAULT_PREFS })).toBe(0);
  });
});
