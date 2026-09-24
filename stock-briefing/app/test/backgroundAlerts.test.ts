import { beforeEach, describe, expect, it, vi } from "vitest";

// 백그라운드 알림 경로를 가짜 모듈로 (알림 예약 횟수만 본다)
const scheduled: unknown[] = [];
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ status: "granted" }),
  requestPermissionsAsync: async () => ({ status: "granted" }),
  scheduleNotificationAsync: async (x: unknown) => void scheduled.push(x),
}));
vi.mock("expo-background-task", () => ({
  getStatusAsync: async () => 1,
  registerTaskAsync: async () => undefined,
  unregisterTaskAsync: async () => undefined,
  BackgroundTaskStatus: { Restricted: 0, Available: 1 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
vi.mock("expo-task-manager", () => ({ isTaskDefined: () => true, defineTask: () => undefined, isTaskRegisteredAsync: async () => false }));
vi.mock("@/lib/notifications", () => ({ ANDROID_CHANNEL: "briefings", ensureAndroidChannel: async () => undefined }));
vi.mock("@/widgets/refresh", () => ({ refreshWidgets: async () => undefined }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { enableLocalBriefingAlerts, runBriefingCheck } = await import("@/lib/backgroundBriefings");

const NOW = Date.parse("2026-09-24T17:00:00+09:00");
const latest = Array.from({ length: 15 }, (_, i) => ({
  code: `00000${i}`,
  name: `종목${i}`,
  latest: { id: 100 + i, code: `00000${i}`, name: `종목${i}`, session: "afternoon", date: "2026-09-24", status: "ok", summary: "요약", detail: "", missing: [], model: "", error: null, createdAt: "2026-09-24T16:05:00+09:00" },
}));
const payload = { v: 1, market: { label: "장 마감", open: false, nextChangeAt: null }, stocks: [], briefings: latest.slice(0, 3).map((b) => ({ ...b.latest, name: b.name })), latestIds: latest.map((b) => b.latest.id) };

beforeEach(() => {
  store.clear();
  scheduled.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url.endsWith("/api/widget") ? payload : latest), { status: 200 }));
});

describe("백그라운드 브리핑 알림 (3-16 리뷰 M1)", () => {
  it("알림을 켠 뒤 첫 백그라운드 확인에서 옛 브리핑 15건이 쏟아지지 않는다", async () => {
    await enableLocalBriefingAlerts();
    await runBriefingCheck();
    expect(scheduled).toHaveLength(0);
  });

  it("그 뒤 새 브리핑이 생기면 그것만 알린다", async () => {
    await enableLocalBriefingAlerts();
    const next = [...latest, { ...latest[0]!, code: "999999", latest: { ...latest[0]!.latest, id: 999, code: "999999", createdAt: "2026-09-24T16:59:00+09:00" } }];
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url.endsWith("/api/widget") ? { ...payload, latestIds: next.map((b) => b.latest.id) } : next), { status: 200 }),
    );
    await runBriefingCheck();
    expect(scheduled).toHaveLength(1);
  });

  describe("3-19 알림 묶음", () => {
    const newOnes = (n: number, at = "2026-09-24T16:59:00+09:00") =>
      Array.from({ length: n }, (_, i) => ({ code: `N0000${i}`, name: `새${i}`, latest: { ...latest[0]!.latest, id: 500 + i, code: `N0000${i}`, name: `새${i}`, createdAt: at } }));
    const serve = (list: typeof latest, prefs: Record<string, unknown>) =>
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/api/widget")) return new Response(JSON.stringify({ ...payload, latestIds: list.map((b) => b.latest.id) }), { status: 200 });
        if (url.endsWith("/api/notifications/settings")) return new Response(JSON.stringify(prefs), { status: 200 });
        return new Response(JSON.stringify(list), { status: 200 });
      });
    const prefs = { digest: true, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] as string[] };

    it("같은 세션의 새 브리핑 5건 → 알림 1건 ('오후 브리핑 5종목')", async () => {
      await enableLocalBriefingAlerts();
      serve([...latest, ...newOnes(5)], prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
      expect((scheduled[0] as { content: { title: string } }).content.title).toBe("오후 브리핑 5종목");
    });

    it("끈 종목은 빼고 세며, 조용한 시간에는 0건이고 아침에 다시 울리지 않는다", async () => {
      await enableLocalBriefingAlerts();
      serve([...latest, ...newOnes(3)], { ...prefs, mutedCodes: ["N00000", "N00001"] });
      await runBriefingCheck();
      expect((scheduled[0] as { content: { title: string } }).content.title).toBe("새2 오후 브리핑");

      vi.setSystemTime(Date.parse("2026-09-24T23:00:00+09:00"));
      const night = newOnes(4, "2026-09-24T22:30:00+09:00").map((b) => ({ ...b, latest: { ...b.latest, id: b.latest.id + 100 } }));
      serve([...latest, ...night], prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1); // 조용한 시간: 0건
      vi.setSystemTime(Date.parse("2026-09-25T07:30:00+09:00"));
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1); // 이미 본 것으로 적혀 아침에 한꺼번에 울리지 않는다
    });

    it("묶음 플래그를 끄면 예전처럼 종목마다", async () => {
      await enableLocalBriefingAlerts();
      serve([...latest, ...newOnes(3)], { ...prefs, digest: false });
      await runBriefingCheck();
      expect(scheduled).toHaveLength(3);
    });

    it("서버가 브리핑을 만드는 중이면 이번엔 넘기고, 끝난 뒤 한 번에 1건 (세션이 두 알림으로 쪼개지지 않게)", async () => {
      await enableLocalBriefingAlerts();
      serve([...latest, ...newOnes(6)], { ...prefs, running: true });
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0);
      serve([...latest, ...newOnes(17)], { ...prefs, running: false });
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
      expect((scheduled[0] as { content: { title: string } }).content.title).toBe("오후 브리핑 17종목");
    });

    it("알림 규칙을 받지 못하면 이번엔 넘기고 '본 것'으로 적지 않는다", async () => {
      await enableLocalBriefingAlerts();
      const list = [...latest, ...newOnes(2)];
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/api/widget")) return new Response(JSON.stringify({ ...payload, latestIds: list.map((b) => b.latest.id) }), { status: 200 });
        if (url.endsWith("/api/notifications/settings")) return new Response("down", { status: 503 });
        return new Response(JSON.stringify(list), { status: 200 });
      });
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0);
      serve(list, prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
    });
  });
});
