import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilingAlertItem } from "@/api/types";

/**
 * 3-38 새 공시 알림 — 백그라운드 확인(runBriefingCheck, 로컬 모드). 위젯 응답(/api/widget …&ms=1)의 filingIds 에 모르는 접수 번호가 있을 때만
 * 알림 규칙·공시 목록 두 요청 → 알림 1건(채널 filings). 없으면 추가 요청 0. 이 부분이 실패해도 위젯 갱신은 계속
 */
const scheduled: Array<{ content: { title: string; data: Record<string, unknown> }; trigger: unknown }> = [];
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ status: "granted" }),
  requestPermissionsAsync: async () => ({ status: "granted" }),
  scheduleNotificationAsync: async (x: (typeof scheduled)[number]) => void scheduled.push(x),
}));
const task = { registered: false };
vi.mock("expo-background-task", () => ({
  getStatusAsync: async () => 1,
  registerTaskAsync: async () => void (task.registered = true),
  unregisterTaskAsync: async () => void (task.registered = false),
  BackgroundTaskStatus: { Restricted: 0, Available: 1 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
vi.mock("expo-task-manager", () => ({ isTaskDefined: () => true, defineTask: () => undefined, isTaskRegisteredAsync: async () => task.registered }));
vi.mock("@/lib/notifications", () => ({ ANDROID_CHANNEL: "briefings", FILING_CHANNEL: "filings", ensureAndroidChannel: async () => undefined, ensureFilingChannel: async () => undefined }));
const refreshed: unknown[] = [];
vi.mock("@/widgets/refresh", () => ({ refreshWidgets: async (x: unknown) => void refreshed.push(x), marketWidgetPlaced: async () => false }));
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
const FX = JSON.parse(readFileSync(new URL("../../shared/fixtures/filingAlerts.json", import.meta.url), "utf8")) as { alerts: FilingAlertItem[] };
const IDS = FX.alerts.map((a) => a.accession);

/** 목 7/30 07:03 KST (미국 장 마감 뒤 — 연장 세션 칩 없이도 묻게 칩을 열어 둔다) */
const NOW = Date.parse("2026-07-30T07:03:00+09:00");
const payload = (filingIds?: string[]) => ({ v: 1, market: { label: "미국 애프터마켓", open: true, nextChangeAt: null }, stocks: [], briefings: [], latestIds: [], ...(filingIds ? { filingIds } : {}) });
const prefs = { digest: true, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] as string[] };
const asked: string[] = [];
function serve(opts: { filingIds?: string[]; alerts?: FilingAlertItem[] | "fail" }) {
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url.replace("https://server.test", "").split("?")[0]!);
    if (url.includes("/api/widget")) return new Response(JSON.stringify(payload(opts.filingIds)), { status: 200 });
    if (url.endsWith("/api/notifications/settings")) return new Response(JSON.stringify(prefs), { status: 200 });
    if (url.includes("/api/filings/alerts")) {
      if (opts.alerts === "fail") throw new TypeError("network");
      return new Response(JSON.stringify({ asOf: "2026-07-30T07:03:00+09:00", items: opts.alerts ?? FX.alerts }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  });
}

beforeEach(async () => {
  store.clear();
  scheduled.length = 0;
  refreshed.length = 0;
  asked.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  serve({});
  await enableLocalBriefingAlerts();
  asked.length = 0;
});

describe("백그라운드 확인의 새 공시 알림", () => {
  it("위젯 응답에 filingIds 가 없으면 추가 요청 0 (예전 서버·끈 서버·새 공시 없음)", async () => {
    serve({});
    await runBriefingCheck();
    expect(asked).toEqual(["/api/widget"]);
    expect(scheduled).toEqual([]);
    expect(refreshed).toHaveLength(1);
  });

  it("첫 확인은 기준만 → 새 번호가 오면 규칙·목록 두 요청 · 알림 1건(채널 filings) → 같은 번호면 추가 요청 0", async () => {
    serve({ filingIds: [IDS[1]!], alerts: [FX.alerts[1]!] });
    await runBriefingCheck();
    expect(scheduled).toEqual([]);
    expect(asked).toEqual(["/api/widget", "/api/notifications/settings", "/api/filings/alerts"]);

    asked.length = 0;
    serve({ filingIds: IDS });
    await runBriefingCheck();
    expect(asked).toEqual(["/api/widget", "/api/notifications/settings", "/api/filings/alerts"]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ content: { title: "마이크로소프트 새 공시", data: { type: "filing", focus: IDS[0] } }, trigger: { channelId: "filings" } });

    asked.length = 0;
    await runBriefingCheck();
    expect(asked).toEqual(["/api/widget"]);
    expect(scheduled).toHaveLength(1);
  });

  it("공시 목록을 받지 못해도 위젯 갱신은 계속 (다음 확인에서 다시)", async () => {
    await import("@/lib/filingSeen").then((s) => s.setFilingInit());
    serve({ filingIds: IDS, alerts: "fail" });
    expect(await runBriefingCheck()).toBe(1);
    expect(refreshed).toHaveLength(1);
    expect(scheduled).toEqual([]);
    serve({ filingIds: IDS });
    await runBriefingCheck();
    expect(scheduled).toHaveLength(1);
  });

  it("로컬 모드가 아니면(알림 꺼짐) 공시도 확인하지 않는다", async () => {
    store.delete("push.localMode");
    serve({ filingIds: IDS });
    await runBriefingCheck();
    expect(asked).toEqual(["/api/widget"]);
    expect(scheduled).toEqual([]);
  });
});

describe("휴장 건너뛰기와 SEC 접수 시간 (3-38 리뷰 — 미국 휴장이지만 SEC 는 공시를 받는 때)", () => {
  const API = "https://server.test";
  /** 두 시장·연장 세션이 모두 닫힌 칩으로 10분 전에 받아 둔 응답 (다음 개장은 이틀 뒤) → 지금 규칙이면 최대 2시간 건너뜀 */
  const closedCache = (now: number) =>
    store.set(
      "widget.payload",
      JSON.stringify({ at: now - 10 * 60_000, apiUrl: API, path: "/api/widget?indices=1&sessions=1&ui=2&ms=1", etag: '"c"', body: { v: 1, market: { label: "휴장", open: false, nextChangeAt: new Date(now + 2 * 86_400_000).toISOString() }, stocks: [], briefings: [], latestIds: [] } }),
    );
  /** 앱이 마지막으로 받은 서버 플래그 (기기 저장 react-query 캐시) */
  const flags = (on: boolean) => store.set("rq.cache", JSON.stringify({ clientState: { queries: [{ queryKey: [API, "features"], state: { data: { features: { filingAlerts: on } } } }] } }));
  const at = (iso: string) => {
    const t = Date.parse(iso);
    vi.setSystemTime(t);
    closedCache(t);
  };

  it.each([
    ["금요일 20:45 동부 = 한국 토 09:45 (미국 애프터마켓·주간거래 모두 닫힘)", "2026-09-26T00:45:00Z"],
    ["성금요일 07:30 동부 = 한국 20:30 (미국 증시 휴장, SEC 는 받음)", "2026-04-03T11:30:00Z"],
  ])("%s: 공시 알림이 켜져 있으면 건너뛰지 않고 묻는다 → 새 공시 알림", async (_n, iso) => {
    await import("@/lib/filingSeen").then((s) => s.setFilingInit());
    flags(true);
    at(iso);
    const fresh = { ...FX.alerts[0]!, acceptedAt: new Date(Date.parse(iso) - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    serve({ filingIds: [fresh.accession], alerts: [fresh] });
    await runBriefingCheck();
    expect(asked).toEqual(["/api/widget", "/api/notifications/settings", "/api/filings/alerts"]);
    expect(scheduled).toHaveLength(1);
  });

  it("공시 플래그가 꺼져 있거나 모름 · SEC 접수 시간 밖(토요일) · 이 기기 '공시 알림' 끔 · 알림을 켜지 않은 기기면 지금처럼 건너뛴다 (요청 0)", async () => {
    const skipped = async () => {
      asked.length = 0;
      await runBriefingCheck();
      return asked.length === 0;
    };
    at("2026-09-26T00:45:00Z");
    flags(false);
    expect(await skipped()).toBe(true);
    store.delete("rq.cache");
    expect(await skipped()).toBe(true);
    flags(true);
    at("2026-09-26T14:00:00Z"); // 토 10:00 동부 — SEC 가 새 공시를 받지 않음
    expect(await skipped()).toBe(true);
    at("2026-09-26T00:45:00Z");
    store.set("filingAlerts.enabled", "0");
    expect(await skipped()).toBe(true);
    store.delete("filingAlerts.enabled");
    store.delete("push.localMode");
    expect(await skipped()).toBe(true);
    // 같은 때 알림을 켠 기기는 묻는다 (위 규칙이 아니었다면 이것도 건너뛰었다)
    store.set("push.localMode", "1");
    expect(await skipped()).toBe(false);
  });
});
