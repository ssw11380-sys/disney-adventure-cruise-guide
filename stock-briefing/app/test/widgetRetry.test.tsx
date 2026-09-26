import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 위젯 2차 (A): 갱신이 한 번 실패하면 휴장·주말에도 다음 자동 갱신(백그라운드 작업 약 15분)이 다시 묻는다.
 * 예전: 휴장 중에는 받아 둔 응답을 2시간까지 다시 써서(백그라운드 작업은 건너뛰고, 위젯 주기·크기 변경 갱신은 재사용)
 * 잠깐의 실패('갱신 실패 · 연결 안 됨')가 한 위젯에 최대 2시간 남았다 (2026-09-26 토 10:32 폴드8 캡처 — 지수·환율 위젯만 실패, 잔고 위젯은 멀쩡).
 * 성공하면 위젯 4종의 '갱신 실패'를 모두 지우고, 그 뒤로는 휴장 2시간 재사용 그대로 (서버 호출이 늘지 않는다). 시각은 모두 고정 시계
 */

const lib = (p: string) => import(/* @vite-ignore */ p);
const shared = vi.hoisted(() => ({
  widgets: {} as Record<string, { width: number; height: number }[]>,
  updates: [] as { widgetName: string; rendered: unknown }[],
}));

vi.mock("react-native-android-widget", async () => {
  const load = (p: string) => import(/* @vite-ignore */ p);
  const base = "react-native-android-widget/lib/commonjs/widgets/";
  const [flex, text, list] = await Promise.all([load(`${base}FlexWidget.js`), load(`${base}TextWidget.js`), load(`${base}ListWidget.js`)]);
  return {
    FlexWidget: flex.FlexWidget,
    TextWidget: text.TextWidget,
    ListWidget: list.ListWidget,
    getWidgetInfo: async (name: string) => (shared.widgets[name] ?? []).map((b) => ({ widgetName: name, widgetId: 1, ...b })),
    requestWidgetUpdate: async ({ widgetName, renderWidget }: { widgetName: string; renderWidget: (i: unknown) => unknown }) => {
      for (const box of shared.widgets[widgetName] ?? []) {
        shared.updates.push({ widgetName, rendered: await renderWidget({ widgetName, widgetId: 1, ...box, screenInfo: {} }) });
      }
    },
  };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" }, PixelRatio: { getFontScale: () => 1 } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
vi.mock("expo-notifications", () => ({ getPermissionsAsync: async () => ({ status: "granted" }), requestPermissionsAsync: async () => ({ status: "granted" }), scheduleNotificationAsync: async () => undefined }));
vi.mock("expo-background-task", () => ({
  getStatusAsync: async () => 1,
  registerTaskAsync: async () => undefined,
  unregisterTaskAsync: async () => undefined,
  BackgroundTaskStatus: { Restricted: 0, Available: 1 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));
vi.mock("expo-task-manager", () => ({ isTaskDefined: () => true, defineTask: () => undefined, isTaskRegisteredAsync: async () => false }));
vi.mock("@/lib/notifications", () => ({ ANDROID_CHANNEL: "briefings", ensureAndroidChannel: async () => undefined }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { buildWidgetTree } = await lib("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { WIDGET_NAMES } = await import("@/widgets/widgets");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { loadWidgetData, pendingRetry } = await import("@/widgets/data");
const { runBriefingCheck } = await import("@/lib/backgroundBriefings");
const { readWidgetRefreshLog } = await import("@/lib/widgetRefreshLog");

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string };
  children?: Tree[];
}
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const words = (r: unknown) =>
  nodes(buildWidgetTree((r as { dark: React.JSX.Element }).dark) as Tree)
    .filter((n) => n.type === "TextWidget")
    .map((n) => String(n.props.text));
const FAIL = "갱신 실패 · 연결 안 됨";

const API = "https://server.test";
const WIDGET_URL = `${API}/api/widget?indices=1&sessions=1&ui=2`;
const BOARD_URL = `${WIDGET_URL}&board=1`;
const BOX = { width: 420, height: 260 };
/** 2026-09-26(토) KST 시각 — 두 시장 모두 휴장 (다음 개장 월 08:00) */
const S = (hm: string) => Date.parse(`2026-09-26T${hm}:00+09:00`);
const WEEKEND = { label: "주말 휴장", open: false, kr: false, us: false, nextChangeAt: "2026-09-27T23:00:00.000Z" };
const BOARD = [
  { code: "KOSPI", name: "코스피", value: 7080.92, change: 63.01, changeRate: 0.9, open: false },
  { code: "NASDAQ", name: "나스닥", value: 27068.72, change: 129.34, changeRate: 0.48, open: false },
  { code: "USDKRW", name: "원/달러", value: 1359, change: 3.5, changeRate: 0.26, open: false },
];
type Q = [number, number, number, "KRW" | "USD", string, number | null, 0 | 1];
type E = [number, number, number | null, number | null, "exact" | "estimated" | null];
/** 서버 /api/widget 응답 (주말): 삼성전자 10주. 판은 &board=1 로 물은 요청에만 */
const body = (board: boolean) => ({
  v: 1 as const,
  market: WEEKEND,
  stocks: [{ c: "005930", n: "삼성전자", qty: 10, avg: 80_000, q: [70_000, 100, 0.14, "KRW", "2026-09-25T15:30:00+09:00", null, 0] as Q, e: [700_000, 800_000, null, null, null] as E }],
  briefings: [{ id: 3, code: "005930", name: "삼성전자", session: "afternoon", date: "2026-09-25", summary: "첫 줄", createdAt: "2026-09-25T16:05:00+09:00" }],
  latestIds: [3],
  features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetExtended: true },
  ...(board ? { board: BOARD } : {}),
});
const serve = (urls: string[] = []) => {
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body(url.includes("board=1"))), { status: 200, headers: { etag: `"${urls.length}"`, "content-type": "application/json" } });
  });
  return urls;
};
const offline = (urls: string[] = []) => {
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    throw new TypeError("Network request failed");
  });
  return urls;
};
const info = (name: string) => ({ widgetName: name, widgetId: 7, ...BOX, screenInfo: { screenHeightDp: 800, screenWidthDp: 400, density: 3, densityDpi: 480 } });
const run = async (props: Record<string, unknown>) => {
  const rendered: unknown[] = [];
  await widgetTaskHandler({ renderWidget: (r: unknown) => void rendered.push(r), ...props } as never);
  return rendered;
};
const ALL = [WIDGET_NAMES.holdings, WIDGET_NAMES.asset, WIDGET_NAMES.briefing, WIDGET_NAMES.market];
const placeAll = () => (shared.widgets = Object.fromEntries(ALL.map((n) => [n, [BOX]])));
/** 마지막으로 그린 위젯마다 '갱신 실패'가 보이는지 */
const failing = () => Object.fromEntries(ALL.map((n) => [n, shared.updates.filter((u) => u.widgetName === n).length ? words(shared.updates.filter((u) => u.widgetName === n).at(-1)!.rendered).some((w) => w.includes("갱신 실패")) : null]));

beforeEach(() => {
  store.clear();
  shared.widgets = {};
  shared.updates = [];
  vi.useFakeTimers();
  vi.setSystemTime(S("09:50"));
});

describe("위젯 2차 (A): 실패하면 휴장에도 약 15분 뒤 다시 묻는다", () => {
  it("재현: 토 10:00 지수·환율 ↻ 실패 → 10:15 백그라운드 작업이 다시 묻고, 성공하면 위젯 4종 모두 '갱신 실패'가 없다", async () => {
    placeAll();
    serve();
    await runBriefingCheck(); // 09:50 성공 (받아 둔 응답 — 주말이라 2시간까지 다시 쓴다)
    vi.setSystemTime(S("10:00"));
    offline();
    const r = await run({ widgetInfo: info(WIDGET_NAMES.market), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    expect(words(r.at(-1))).toContain(FAIL);
    // 10:15 백그라운드 작업: 예전에는 09:50 응답이 2시간 안이라 건너뛰어 12:00 까지 '갱신 실패'가 남았다
    vi.setSystemTime(S("10:15"));
    shared.updates = [];
    const urls = serve();
    await runBriefingCheck();
    expect(urls).toEqual([BOARD_URL]);
    expect(failing()).toEqual({ [WIDGET_NAMES.holdings]: false, [WIDGET_NAMES.asset]: false, [WIDGET_NAMES.briefing]: false, [WIDGET_NAMES.market]: false });
    expect(await pendingRetry()).toBeNull();
    expect((await readWidgetRefreshLog()).at(-1)).toMatchObject({ s: "background", r: "ok", t: S("10:15") });
  });

  it("성공한 뒤에는 휴장 2시간 재사용 그대로: 10:30 백그라운드 작업은 건너뛰고, 10:45 위젯 주기·크기 변경 갱신은 받아 둔 응답을 다시 쓴다", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    vi.setSystemTime(S("10:00"));
    offline();
    await run({ widgetInfo: info(WIDGET_NAMES.market), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    vi.setSystemTime(S("10:15"));
    serve();
    await runBriefingCheck();
    vi.setSystemTime(S("10:30"));
    const later = serve();
    await runBriefingCheck();
    expect(later).toEqual([]);
    expect((await readWidgetRefreshLog()).at(-1)).toMatchObject({ s: "background", r: "skipped" });
    vi.setSystemTime(S("10:45"));
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_UPDATE" });
    await run({ widgetInfo: info(WIDGET_NAMES.market), widgetAction: "WIDGET_RESIZED" });
    expect(later).toEqual([]);
  });

  it("실패가 없으면 예전과 같다: 토 10:15 백그라운드 작업은 09:50 응답을 두고 건너뛴다", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    vi.setSystemTime(S("10:15"));
    const urls = serve();
    await runBriefingCheck();
    expect(urls).toEqual([]);
  });

  it("재현: 판 없이 받아 둔 응답에 10:00 지수·환율 위젯을 놓다 실패(추가) → 10:15 백그라운드 작업이 판과 함께 다시 묻는다", async () => {
    // 09:50 에는 지수·환율 위젯이 없어 판 없이 받았다
    shared.widgets = { [WIDGET_NAMES.holdings]: [BOX] };
    serve();
    await runBriefingCheck();
    vi.setSystemTime(S("10:00"));
    shared.widgets = { [WIDGET_NAMES.holdings]: [BOX], [WIDGET_NAMES.market]: [BOX] };
    const calls = offline();
    const r = await run({ widgetInfo: info(WIDGET_NAMES.market), widgetAction: "WIDGET_ADDED" });
    expect(calls).toEqual([BOARD_URL]);
    expect(words(r.at(-1))).toContain(FAIL);
    vi.setSystemTime(S("10:15"));
    shared.updates = [];
    const urls = serve();
    await runBriefingCheck();
    expect(urls).toEqual([BOARD_URL]);
    const market = words(shared.updates.find((u) => u.widgetName === WIDGET_NAMES.market)!.rendered);
    expect(market.join(" ")).not.toContain("갱신 실패");
    expect(market).toContain("7,080.92");
  });

  it("실패 뒤 위젯이 스스로 받아도(10:05 폴드 펼침 크기 변경) 성공하면 다른 위젯의 '갱신 실패'까지 지운다", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    vi.setSystemTime(S("10:00"));
    offline();
    await run({ widgetInfo: info(WIDGET_NAMES.market), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    vi.setSystemTime(S("10:05"));
    shared.updates = [];
    const urls = serve();
    // 예전: 받아 둔 09:50 응답을 다시 써서 서버를 부르지 않았고, 지수·환율 위젯의 '갱신 실패'도 그대로였다
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_RESIZED" });
    expect(urls).toEqual([WIDGET_URL]);
    expect(words(r.at(-1)).join(" ")).not.toContain("갱신 실패");
    expect(shared.updates.map((u) => u.widgetName).sort()).toEqual([...ALL].sort());
    expect(failing()[WIDGET_NAMES.market]).toBe(false);
    expect(await pendingRetry()).toBeNull();
    // 다음 크기 변경은 다시 받아 둔 응답 (한 번만 물었다)
    await run({ widgetInfo: info(WIDGET_NAMES.asset), widgetAction: "WIDGET_RESIZED" });
    expect(urls).toEqual([WIDGET_URL]);
  });

  it("아직 연결이 안 되면 자동 갱신마다 다시 묻고 '갱신 실패'를 그대로 보인다 (마지막 숫자는 지우지 않는다)", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    vi.setSystemTime(S("10:00"));
    offline();
    await run({ widgetInfo: info(WIDGET_NAMES.market), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    vi.setSystemTime(S("10:05"));
    const urls = offline();
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_UPDATE" });
    expect(urls).toEqual([WIDGET_URL]);
    expect(words(r.at(-1)).join(" ")).toContain("갱신 실패");
    expect(words(r.at(-1))).toContain("700,000원");
    // 실패 표시는 마지막 실패 시각 (10:00 ↻ → 10:05 주기 갱신)
    expect(await pendingRetry()).toBe(S("10:05"));
    vi.setSystemTime(S("10:20"));
    await runBriefingCheck();
    expect(urls).toEqual([WIDGET_URL, BOARD_URL]);
    expect((await readWidgetRefreshLog()).at(-1)).toMatchObject({ s: "background", r: "failed" });
  });

  it("다른 서버 주소에서 난 실패 표시는 쓰지 않는다 (주소를 바꾸면 예전 규칙)", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    store.set("widget.retry", JSON.stringify({ at: S("10:00"), apiUrl: "https://old.test" }));
    expect(await pendingRetry()).toBeNull();
    vi.setSystemTime(S("10:15"));
    const urls = serve();
    await runBriefingCheck();
    await loadWidgetData({ stocks: true, briefings: false, reuse: true });
    expect(urls).toEqual([]);
  });
});
