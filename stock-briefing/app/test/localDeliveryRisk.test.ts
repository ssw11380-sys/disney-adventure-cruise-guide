import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatestBriefing } from "@/api/types";

const h = vi.hoisted(() => ({ store: new Map<string, string>(), failSeen: false, failAllWrites: false, failInspect: false, failSchedule: false, scheduleWait: null as null | (() => Promise<void>), delivered: [] as { identifier?: string }[], presented: [] as { request: { identifier: string } }[], pending: [] as { identifier: string }[], inspections: 0 }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => h.store.get(key) ?? null,
  setItem: async (key: string, value: string) => { if (h.failAllWrites || (h.failSeen && key === "briefings.notified")) throw new Error("주입한 기록 실패"); h.store.set(key, value); },
  removeItem: async (key: string) => { if (h.failAllWrites) throw new Error("주입한 삭제 실패"); h.store.delete(key); },
} }));
vi.mock("expo-notifications", () => ({
  getPresentedNotificationsAsync: async () => { h.inspections++; if (h.failInspect) throw new Error("주입한 OS 조회 실패"); return h.presented; },
  getAllScheduledNotificationsAsync: async () => { h.inspections++; if (h.failInspect) throw new Error("주입한 OS 조회 실패"); return h.pending; },
  scheduleNotificationAsync: async (input: { identifier?: string }) => {
    await h.scheduleWait?.();
    if (h.failSchedule) throw new Error("주입한 OS 예약 실패");
    h.delivered.push(input);
    h.presented.push({ request: { identifier: input.identifier ?? "무작위-옛식별자" } });
    return input.identifier ?? "무작위-옛식별자";
  },
}));
vi.mock("expo-background-task", () => ({}));
vi.mock("expo-task-manager", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@/lib/settings", () => ({ STORAGE_KEYS: { apiUrl: "settings.apiUrl" }, defaultApiUrl: () => "https://delivery-risk.test" }));
vi.mock("@/lib/notifications", () => ({ ANDROID_CHANNEL: "briefings" }));
vi.mock("@/lib/marketSummaryLoad", () => ({}));
vi.mock("@/lib/widgetRefreshLog", () => ({}));
vi.mock("@/widgets/data", () => ({}));
vi.mock("@/widgets/model", () => ({}));
vi.mock("@/widgets/payload", () => ({}));
vi.mock("@/widgets/redraw", () => ({}));
vi.mock("@/widgets/refresh", () => ({}));
const NOW = new Date("2026-10-03T16:30:00+09:00");
const item: LatestBriefing = { code: "005930", name: "가짜", latest: { id: 2, code: "005930", name: "가짜", date: "2026-10-03", session: "afternoon", status: "ok", summary: "가짜 요약", detail: "가짜 본문", model: "가짜", missing: [], error: null, createdAt: "2026-10-03T16:00:00+09:00" } };
beforeEach(() => {
  vi.resetModules(); h.store.clear(); h.store.set("briefings.notifyInit", "1"); h.store.set("briefings.notified", "[90]");
  h.failSeen = false; h.failAllWrites = false; h.failInspect = false; h.failSchedule = false;
  h.scheduleWait = null;
  h.delivered = []; h.presented = []; h.pending = []; h.inspections = 0;
  vi.useFakeTimers(); vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
const notify = async () => (await import("@/lib/backgroundBriefings")).notifyNewBriefings([item], { now: NOW });

describe("OS 접수 뒤 알림 기록 실패의 복구", () => {
  it.each([false, true])("OS 응답 실패 %s: 기다리는 중 계정이 바뀌면 앞 계정의 발송 목록으로 덮어쓰지 않는다", async (fail) => {
    const { saveSession } = await import("@/lib/session");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    h.scheduleWait = async () => { entered(); await paused; };
    const pending = notify().then(() => null, (error: unknown) => error);
    await started;
    await saveSession({ apiUrl: "https://delivery-risk.test", token: "new-user-fixture", remember: true, user: { id: 2, loginId: "새 가짜", email: null, isOwner: true, usingInitialPassword: false } });
    h.store.set("briefings.notified", "[777]");
    h.failSchedule = fail;
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(JSON.parse(h.store.get("briefings.notified")!)).toEqual([777]);
  });

  it("기록 실패를 성공으로 숨기지 않고 OS에 남은 같은 알림을 새 실행에서 다시 예약하지 않는다", async () => {
    h.failAllWrites = true;
    await expect(notify()).rejects.toThrow("알림");
    expect(h.delivered).toHaveLength(1);
    vi.resetModules(); h.failAllWrites = false;
    expect(await notify()).toBe(0);
    expect(h.delivered).toHaveLength(1);
    expect(JSON.parse(h.store.get("briefings.notified")!)).toContain(2);
  });

  it("본 기록 키만 실패하면 별도 접수 기록으로 OS에서 지운 알림도 새 실행에 반복하지 않는다", async () => {
    h.failSeen = true;
    await expect(notify()).rejects.toThrow("알림");
    h.presented = []; vi.resetModules(); h.failSeen = false;
    expect(await notify()).toBe(0);
    expect(h.delivered).toHaveLength(1);
  });

  it("OS 예약이 실패한 알림은 보낸 것으로 적지 않고 같은 식별자로 다시 시도한다", async () => {
    h.failSchedule = true;
    await expect(notify()).rejects.toThrow("OS 예약 실패");
    expect(JSON.parse(h.store.get("briefings.notified")!)).not.toContain(2);
    h.failSchedule = false;
    expect(await notify()).toBe(1);
    expect(h.delivered[0]!.identifier).toMatch(/^briefing-local:v1:/);
  });

  it("OS 목록을 읽지 못하면 빈 목록으로 간주해 중복 예약하지 않는다", async () => {
    h.failInspect = true;
    await expect(notify()).rejects.toThrow("OS 조회 실패");
    expect(h.delivered).toEqual([]);
    expect(JSON.parse(h.store.get("briefings.notified")!)).not.toContain(2);
  });

  it("서버가 다르면 같은 보고서 번호도 다른 OS 식별자를 사용하고 새 보고서가 없으면 OS를 조회하지 않는다", async () => {
    expect(await notify()).toBe(1);
    const first = h.delivered[0]!.identifier;
    expect(await notify()).toBe(0);
    expect(h.inspections).toBe(2);
    h.store.set("settings.apiUrl", "https://other-delivery.test"); h.store.set("briefings.notified", "[90]");
    expect(await notify()).toBe(1);
    expect(h.delivered[1]!.identifier).not.toBe(first);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("OS 예약 목록에 같은 식별자가 남아 있어도 접수된 것으로 복구하며 다시 예약하지 않는다", async () => {
    await notify();
    h.pending = h.presented.map((n) => ({ identifier: n.request.identifier })); h.presented = [];
    h.store.set("briefings.notified", "[90]"); vi.resetModules();
    expect(await notify()).toBe(0);
    expect(h.delivered).toHaveLength(1);
  });

  it("같은 실행에서는 모든 기록 실패 후 OS 목록에서 사라져도 접수 기억으로 재발송을 막는다", async () => {
    h.failAllWrites = true;
    await expect(notify()).rejects.toThrow("알림");
    h.presented = [];
    await expect(notify()).rejects.toThrow("알림");
    expect(h.delivered).toHaveLength(1);
    h.failAllWrites = false;
    expect(await notify()).toBe(0);
  });

  it("다른 계정은 같은 서버·회차·보고서 번호도 다른 식별자이며 세션 토큰을 식별자에 넣지 않는다", async () => {
    const { saveSession } = await import("@/lib/session");
    const user = (id: number) => ({ id, loginId: "가짜", email: null, isOwner: true, usingInitialPassword: false });
    await saveSession({ apiUrl: "https://delivery-risk.test", token: "fixture-user-a", remember: true, user: user(1) });
    await notify(); const first = h.delivered[0]!.identifier;
    h.store.set("briefings.notified", "[90]");
    await saveSession({ apiUrl: "https://delivery-risk.test", token: "fixture-user-b", remember: true, user: user(2) });
    expect(await notify()).toBe(1);
    expect(h.delivered[1]!.identifier).not.toBe(first);
    expect(h.delivered.map((d) => d.identifier).join(" ")).not.toContain("fixture-user");
  });
});
