import { beforeEach, describe, expect, it, vi } from "vitest";

// 백그라운드 알림 경로를 가짜 모듈로 (알림 예약 횟수만 본다)
const scheduled: unknown[] = [];
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ status: "granted" }),
  requestPermissionsAsync: async () => ({ status: "granted" }),
  scheduleNotificationAsync: async (x: unknown) => void scheduled.push(x),
}));
// 공용 태스크(check-new-briefings)의 등록 상태를 기억한다 — 알림을 꺼도 위젯 갱신용으로 남는지 본다 (N2)
const task = { registered: false };
vi.mock("expo-background-task", () => ({
  getStatusAsync: async () => 1,
  registerTaskAsync: async () => void (task.registered = true),
  unregisterTaskAsync: async () => void (task.registered = false),
  BackgroundTaskStatus: { Restricted: 0, Available: 1 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
vi.mock("expo-task-manager", () => ({ isTaskDefined: () => true, defineTask: () => undefined, isTaskRegisteredAsync: async () => task.registered }));
vi.mock("@/lib/notifications", () => ({ ANDROID_CHANNEL: "briefings", ensureAndroidChannel: async () => undefined }));
const refreshed: unknown[] = [];
// 지수·환율 위젯이 홈 화면에 있는지 (1.4.0: 있으면 백그라운드 작업이 판을 함께 묻는다)
const placed = { market: false };
vi.mock("@/widgets/refresh", () => ({ refreshWidgets: async (x: unknown) => void refreshed.push(x), marketWidgetPlaced: async () => placed.market }));
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

const { disableLocalBriefingAlerts, enableLocalBriefingAlerts, ensureBackgroundTaskRegistered, runBriefingCheck } = await import("@/lib/backgroundBriefings");

const NOW = Date.parse("2026-09-24T17:00:00+09:00");
const latest = Array.from({ length: 15 }, (_, i) => ({
  code: `00000${i}`,
  name: `종목${i}`,
  latest: { id: 100 + i, code: `00000${i}`, name: `종목${i}`, session: "afternoon", date: "2026-09-24", status: "ok", summary: "요약", detail: "", missing: [], model: "", error: null, createdAt: "2026-09-24T16:05:00+09:00" },
}));
const payload = { v: 1, market: { label: "장 마감", open: false, nextChangeAt: null }, stocks: [], briefings: latest.slice(0, 3).map((b) => ({ ...b.latest, name: b.name })), latestIds: latest.map((b) => b.latest.id) };
const newOnes = (n: number, at = "2026-09-24T16:59:00+09:00") =>
  Array.from({ length: n }, (_, i) => ({ code: `N0000${i}`, name: `새${i}`, latest: { ...latest[0]!.latest, id: 500 + i, code: `N0000${i}`, name: `새${i}`, createdAt: at } }));
const serve = (list: typeof latest, prefs: Record<string, unknown>) =>
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("/api/widget")) return new Response(JSON.stringify({ ...payload, latestIds: list.map((b) => b.latest.id) }), { status: 200 });
    if (url.endsWith("/api/notifications/settings")) return new Response(JSON.stringify(prefs), { status: 200 });
    return new Response(JSON.stringify(list), { status: 200 });
  });
const prefs = { digest: true, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] as string[] };

beforeEach(() => {
  store.clear();
  scheduled.length = 0;
  refreshed.length = 0;
  task.registered = false;
  placed.market = false;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url.includes("/api/widget") ? payload : latest), { status: 200 }));
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
      new Response(JSON.stringify(url.includes("/api/widget") ? { ...payload, latestIds: next.map((b) => b.latest.id) } : next), { status: 200 }),
    );
    await runBriefingCheck();
    expect(scheduled).toHaveLength(1);
  });

  describe("3-19 알림 묶음", () => {
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
        if (url.includes("/api/widget")) return new Response(JSON.stringify({ ...payload, latestIds: list.map((b) => b.latest.id) }), { status: 200 });
        if (url.endsWith("/api/notifications/settings")) return new Response("down", { status: 503 });
        return new Response(JSON.stringify(list), { status: 200 });
      });
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0);
      serve(list, prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
    });

    it("알림 규칙을 3번 연달아 못 받으면 예전처럼 종목마다 알린다", async () => {
      await enableLocalBriefingAlerts();
      const list = [...latest, ...newOnes(2)];
      vi.stubGlobal("fetch", async (url: string) => {
        if (url.includes("/api/widget")) return new Response(JSON.stringify({ ...payload, latestIds: list.map((b) => b.latest.id) }), { status: 200 });
        if (url.endsWith("/api/notifications/settings")) return new Response("down", { status: 503 });
        return new Response(JSON.stringify(list), { status: 200 });
      });
      await runBriefingCheck();
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(2);
    });
  });

  describe("3-31 계좌 한 장 브리핑", () => {
    const account = {
      id: 77, date: "2026-09-24", session: "afternoon", status: "ok", summary: "", detail: "", model: "m", template: false, createdAt: "2026-09-24T16:10:00+09:00",
      headline: { totalValue: 123_456_789, dayPnl: -2_868_108, dayRate: -1.23, holdings: 17, top: [{ code: "RGTX", name: "RGTX", amount: -1_234_567, changeRate: -8.1 }] },
    };
    /** serve 와 같고 계좌 브리핑 목록도 준다 ("404" 면 예전 서버). 받은 주소를 돌려준다 */
    const serveWith = (list: typeof latest, p: Record<string, unknown>, accounts: unknown[] | "404") => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        calls.push(url);
        if (url.includes("/api/widget")) return new Response(JSON.stringify({ ...payload, latestIds: list.map((b) => b.latest.id) }), { status: 200 });
        if (url.endsWith("/api/notifications/settings")) return new Response(JSON.stringify(p), { status: 200 });
        if (url.includes("/api/account-briefings")) return accounts === "404" ? new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 }) : new Response(JSON.stringify(accounts), { status: 200 });
        return new Response(JSON.stringify(list), { status: 200 });
      });
      return calls;
    };
    const title = (i: number) => (scheduled[i] as { content: { title: string } }).content.title;

    it("서버 플래그가 켜져 있으면 세션 알림 1건의 앞머리가 계좌 요약, 누르면 계좌 브리핑", async () => {
      await enableLocalBriefingAlerts();
      serveWith([...latest, ...newOnes(5)], { ...prefs, accountBriefing: true }, [account]);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
      expect(title(0)).toBe("오후 계좌 브리핑 · 당일 -2,868,108원 (-1.23%)");
      const content = (scheduled[0] as { content: { body: string; data: Record<string, unknown> } }).content;
      expect(content.body).toBe("기여 1위 RGTX -1,234,567원\n종목 브리핑 5종목");
      expect(content.data).toMatchObject({ digest: true, accountBriefingId: 77, count: 5 });
    });

    it("플래그가 꺼져 있으면 계좌 브리핑 목록을 묻지 않고 예전 문구", async () => {
      await enableLocalBriefingAlerts();
      const calls = serveWith([...latest, ...newOnes(5)], prefs, [account]);
      await runBriefingCheck();
      expect(calls.filter((u) => u.includes("/api/account-briefings"))).toHaveLength(0);
      expect(scheduled).toHaveLength(1);
      expect(title(0)).toBe("오후 브리핑 5종목");
    });

    it("계좌 브리핑 목록을 못 받으면(예전 서버 404) 계좌 요약 없이 그대로 1건", async () => {
      await enableLocalBriefingAlerts();
      serveWith([...latest, ...newOnes(5)], { ...prefs, accountBriefing: true }, "404");
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
      expect(title(0)).toBe("오후 브리핑 5종목");
    });

    it("다른 세션의 계좌 브리핑은 쓰지 않는다", async () => {
      await enableLocalBriefingAlerts();
      serveWith([...latest, ...newOnes(2)], { ...prefs, accountBriefing: true }, [{ ...account, session: "morning" }]);
      await runBriefingCheck();
      expect(title(0)).toBe("오후 브리핑 2종목");
    });
  });

  describe("브리핑이 0건일 때 알림 켜기 (N3)", () => {
    it("빈 목록에서 켠 뒤 첫 신규 브리핑은 1건 알리고, 다음 확인에서 다시 알리지 않는다", async () => {
      serve([], prefs);
      await enableLocalBriefingAlerts();
      serve(newOnes(1), prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
    });

    it("빈 목록에서 켠 뒤 브리핑이 없으면 알림 규칙을 매번 받지 않는다 (확인할 새 id 없음)", async () => {
      serve([], prefs);
      await enableLocalBriefingAlerts();
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(url.includes("/api/widget") ? { ...payload, latestIds: [] } : []), { status: 200 });
      });
      await runBriefingCheck();
      expect(calls.filter((u) => u.endsWith("/api/notifications/settings"))).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it("켤 때 목록을 받지 못했으면 첫 확인은 지금 상태만 기억한다 (옛 브리핑이 쏟아지지 않게)", async () => {
      vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
      await enableLocalBriefingAlerts();
      serve(latest, prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0);
      serve([...latest, ...newOnes(1)], prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
    });

    it("예전 앱에서 올라온 기기(초기화 표시 없이 본 기록만 있음)는 새 브리핑을 그대로 알린다", async () => {
      store.set("push.localMode", "1");
      store.set("briefings.notified", JSON.stringify(latest.map((b) => b.latest.id)));
      serve([...latest, ...newOnes(1)], prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(1);
    });

    it("알림을 껐다 다시 켜면 꺼져 있던 동안의 브리핑은 알리지 않는다", async () => {
      serve([], prefs);
      await enableLocalBriefingAlerts();
      await disableLocalBriefingAlerts();
      serve(newOnes(2), prefs);
      await runBriefingCheck();
      await enableLocalBriefingAlerts();
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0);
    });
  });

  describe("알림 끄기와 위젯 갱신 태스크 (N2)", () => {
    it("앱 시작 때 등록된 공용 태스크는 브리핑 알림을 꺼도 남고, 위젯은 계속 갱신된다", async () => {
      await ensureBackgroundTaskRegistered();
      expect(task.registered).toBe(true);
      serve(latest, prefs);
      await enableLocalBriefingAlerts();
      await disableLocalBriefingAlerts();
      expect(task.registered).toBe(true);
      serve([...latest, ...newOnes(2)], prefs);
      await runBriefingCheck();
      expect(scheduled).toHaveLength(0); // 알림은 꺼짐
      expect(refreshed).toHaveLength(1); // 위젯 갱신은 계속
    });

    it("즉시 푸시로 바꿀 때(로컬 알림만 끄기)도 태스크가 남는다", async () => {
      await ensureBackgroundTaskRegistered();
      await disableLocalBriefingAlerts();
      expect(task.registered).toBe(true);
    });
  });

  describe("지수·환율 위젯 (APK 1.4.0): 백그라운드 작업이 다른 위젯처럼 갱신한다", () => {
    const board = [
      { code: "KOSPI", name: "코스피", value: 7080.92, change: 63.01, changeRate: 0.9, open: true },
      { code: "USDKRW", name: "원/달러", value: 1360.5, change: -2.1, changeRate: -0.15, open: true },
    ];
    const serveBoard = () => {
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        urls.push(url);
        const withBoard = url.includes("board=1");
        return new Response(JSON.stringify({ ...payload, features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true }, ...(withBoard ? { board } : {}) }), { status: 200 });
      });
      return urls;
    };

    it("홈 화면에 지수·환율 위젯이 있으면 같은 요청 한 번에 판을 함께 묻고(&board=1), 받은 판·플래그로 위젯을 다시 그린다", async () => {
      placed.market = true;
      const urls = serveBoard();
      await runBriefingCheck();
      expect(urls.filter((u) => u.includes("/api/widget"))).toEqual(["https://server.test/api/widget?indices=1&board=1"]);
      const r = refreshed[0] as { board: { at: number; list: { code: string }[] } | null; features: { flags: { market: boolean } } | null };
      expect(r.board!.list.map((i) => i.code)).toEqual(["KOSPI", "USDKRW"]);
      expect(r.board!.at).toBe(NOW);
      expect(r.features!.flags.market).toBe(true);
    });

    it("위젯이 없으면 판을 묻지 않는다 (응답·ETag 가 예전과 같다)", async () => {
      const urls = serveBoard();
      await runBriefingCheck();
      expect(urls.filter((u) => u.includes("/api/widget"))).toEqual(["https://server.test/api/widget?indices=1"]);
      expect((refreshed[0] as { board: unknown }).board).toBeNull();
    });
  });
});
