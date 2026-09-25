import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";

/**
 * 위젯 리뷰 5·6번과 1·2번의 연결 부분을 라이브러리의 실제 트리 빌더로 그려 본다 (고치기 전에 실패하는 재현 테스트).
 *  - 5: 10:08 앱 즉시 갱신 뒤 10:10 크기 변경·주기 갱신이 백그라운드가 10:00 에 받아 둔 응답을 다시 쓰면서 잔고·칩·기준 시각을 옛 값으로 덮었다
 *  - 6: 백그라운드 갱신이 실패하면 위젯을 다시 그리지 않고 조용히 끝나, 서버가 멈춰도 30분 넘게 멀쩡해 보였다.
 *       와이파이 로그인 페이지(HTML) 한 번·404 한 번이면 6시간 동안 예전 서버 모드(예전 API, 플래그 꺼짐)
 *  - 1: 백그라운드 작업이 연장 세션(ext) 응답이면 휴장 규칙으로 건너뛰지 않는다
 *  - 2: 자동 갱신마다 시각·출처·결과를 기기에 적는다 (설정 화면 '마지막 자동 갱신')
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
const { refreshWidgets } = await import("@/widgets/refresh");
const { loadWidgetData, readLastStocks } = await import("@/widgets/data");
const { failureText } = await import("@/widgets/model");
const { runBriefingCheck } = await import("@/lib/backgroundBriefings");
const { readWidgetRefreshLog } = await import("@/lib/widgetRefreshLog");

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string };
  children?: Tree[];
}
const build = (el: React.JSX.Element): Tree => buildWidgetTree(el) as Tree;
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const words = (t: Tree) => nodes(t).filter((n) => n.type === "TextWidget").map((n) => String(n.props.text));
const dark = (r: unknown) => words(build((r as { dark: React.JSX.Element }).dark));

const API = "https://server.test";
const WIDGET_URL = `${API}/api/widget?indices=1&sessions=1&ui=2`;
const WIDE = { width: 420, height: 260 };
/** 2026-09-24(목) KST 시각 */
const T = (hm: string) => Date.parse(`2026-09-24T${hm}:00+09:00`);
const KR_OPEN = { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: "2026-09-24T11:00:00.000Z" };

type Q = [number, number, number, "KRW" | "USD", string, number | null, 0 | 1];
type E = [number, number, number | null, number | null, "exact" | "estimated" | null];
/** 서버 /api/widget 응답: 삼성전자 10주 (가격 70,000 → 평가 700,000원) */
const payload = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  market: KR_OPEN,
  stocks: [{ c: "005930", n: "삼성전자", qty: 10, avg: 80_000, q: [70_000, 100, 0.14, "KRW", "2026-09-24T10:00:00+09:00", null, 0] as Q, e: [700_000, 800_000, null, null, null] as E }],
  briefings: [{ id: 3, code: "005930", name: "삼성전자", session: "morning", date: "2026-09-24", summary: "첫 줄", createdAt: "2026-09-24T08:35:00+09:00" }],
  latestIds: [3],
  features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetExtended: true },
  ...over,
});
const serve = (body: unknown = payload(), urls: string[] = []) => {
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: `"${urls.length}"`, "content-type": "application/json" } });
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
const info = (name: string, box = WIDE) => ({ widgetName: name, widgetId: 7, ...box, screenInfo: { screenHeightDp: 800, screenWidthDp: 400, density: 3, densityDpi: 480 } });
const run = async (props: Record<string, unknown>) => {
  const rendered: unknown[] = [];
  await widgetTaskHandler({ renderWidget: (r: unknown) => void rendered.push(r), ...props } as never);
  return rendered;
};
/** 앱이 10:08 에 받은 잔고: 가격 71,000 → 평가 710,000원 (시세에 세션이 붙은 앱 모양) */
const appStocks = () => [holding("005930", quote("005930", 71_000, { change: 1_100, changeRate: 1.57, asOf: "2026-09-24T10:08:00+09:00" }), 10, 80_000, undefined, "삼성전자")];
/** 앱이 넘긴 칩 (다른 경계 시각으로 어느 쪽 칩인지 알아본다) */
const APP_CHIP = { ...KR_OPEN, nextChangeAt: "2026-09-24T11:00:00.001Z" };

beforeEach(() => {
  store.clear();
  shared.widgets = {};
  shared.updates = [];
  vi.useFakeTimers();
  vi.setSystemTime(T("10:00"));
});

describe("리뷰 5: 앱에서 방금 본 숫자가 위젯에서 되돌아가지 않는다", () => {
  /** 10:00 백그라운드가 받아 둔 응답 → 10:08 앱이 위젯을 바로 그림 */
  const seedThenAppPush = async () => {
    serve();
    await loadWidgetData({ stocks: true, briefings: true }); // 백그라운드 작업과 같은 조회 (응답·마지막 잔고·그린 값을 적는다)
    vi.setSystemTime(T("10:08"));
    shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE] };
    await refreshWidgets({ stocks: appStocks(), showKrw: false, afterCost: false, market: APP_CHIP, features: { at: T("10:08"), flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
    expect(dark(shared.updates.at(-1)!.rendered)).toContain("710,000원");
  };

  it("재현: 10:10 크기 변경(폴드 펼침)이 10:00 응답을 다시 써도 10:08 숫자·칩·기준 시각 그대로", async () => {
    await seedThenAppPush();
    vi.setSystemTime(T("10:10"));
    const calls = offline();
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_RESIZED" });
    expect(calls).toEqual([]); // 받아 둔 응답을 다시 쓴다 (서버를 부르지 않음)
    const w = dark(r[0]);
    expect(w).toContain("710,000원");
    expect(w).not.toContain("700,000원");
    expect(w).toContain("10:08 기준");
    const d = await loadWidgetData({ stocks: true, briefings: false, reuse: true });
    expect(d.fetchedAt).toBe(T("10:08"));
    expect(d.market).toEqual(APP_CHIP);
    expect(d.stocks[0]!.quote!.price).toBe(71_000);
  });

  it("주기 갱신도 같고, 마지막 잔고(조회 실패 때 쓰는 값)를 옛 응답으로 덮지 않는다 — 그 뒤 ↻ 가 실패해도 10:08 값", async () => {
    await seedThenAppPush();
    vi.setSystemTime(T("10:10"));
    offline();
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_UPDATE" });
    expect(dark(r[0])).toContain("710,000원");
    expect((await readLastStocks(API))?.at).toBe(T("10:08"));
    vi.setSystemTime(T("10:11"));
    const failed = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    const w = dark(failed.at(-1));
    expect(w).toContain("갱신 실패 · 연결 안 됨");
    expect(w).toContain("710,000원");
  });

  it("받아 둔 응답이 더 새것이면(앱을 닫은 뒤 백그라운드가 받음) 그 응답을 쓴다", async () => {
    await seedThenAppPush();
    vi.setSystemTime(T("10:15"));
    serve(payload({ stocks: [{ ...payload().stocks[0]!, q: [72_000, 2_100, 3, "KRW", "2026-09-24T10:15:00+09:00", null, 0] as Q, e: [720_000, 800_000, null, null, null] as E }] }));
    await loadWidgetData({ stocks: true, briefings: true });
    vi.setSystemTime(T("10:20"));
    offline();
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_RESIZED" });
    expect(dark(r[0])).toContain("720,000원");
  });
});

describe("리뷰 6: 실패가 위젯에 바로 보인다", () => {
  const ALL = [WIDGET_NAMES.holdings, WIDGET_NAMES.asset, WIDGET_NAMES.briefing, WIDGET_NAMES.market];
  const placeAll = () => (shared.widgets = Object.fromEntries(ALL.map((n) => [n, [WIDE]])));

  it("재현: 백그라운드 갱신이 연달아 2번 실패하면 위젯 4종을 저장해 둔 값 + '갱신 실패 · 연결 안 됨'으로 다시 그린다 (1번째는 그대로)", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    expect(shared.updates.map((u) => u.widgetName).sort()).toEqual([...ALL].sort());
    shared.updates = [];
    offline();
    vi.setSystemTime(T("10:15"));
    await runBriefingCheck();
    expect(shared.updates).toHaveLength(0); // 한 번은 일시적일 수 있어 깜빡이지 않게
    vi.setSystemTime(T("10:30"));
    await runBriefingCheck();
    expect(shared.updates.map((u) => u.widgetName).sort()).toEqual([...ALL].sort());
    const holdings = dark(shared.updates.find((u) => u.widgetName === WIDGET_NAMES.holdings)!.rendered);
    expect(holdings).toContain("갱신 실패 · 연결 안 됨");
    expect(holdings).toContain("700,000원"); // 숫자는 지우지 않는다
    // 세 번째 실패도 다시 그린다 ('지연'·기준 시각이 제때 바뀌게)
    shared.updates = [];
    vi.setSystemTime(T("10:45"));
    await runBriefingCheck();
    expect(shared.updates).toHaveLength(4);
    expect(dark(shared.updates.find((u) => u.widgetName === WIDGET_NAMES.holdings)!.rendered)).toContain("지연");
  });

  it("성공하면 연속 실패 수를 지운다 (실패 → 성공 → 실패는 다시 그리지 않는다)", async () => {
    placeAll();
    serve();
    await runBriefingCheck();
    offline();
    await runBriefingCheck();
    serve();
    await runBriefingCheck();
    offline();
    shared.updates = [];
    await runBriefingCheck();
    expect(shared.updates).toHaveLength(0);
  });

  it("재현: 와이파이 로그인 페이지(HTML 200)는 '갱신 실패 · 연결 안 됨' — 예전 서버로 보지 않고 다음에 다시 /api/widget", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("<!doctype html><html><body>Wi-Fi 로그인</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const d = await loadWidgetData({ stocks: true, briefings: true });
    expect(failureText(d.error)).toBe("갱신 실패 · 연결 안 됨");
    expect(urls).toEqual([WIDGET_URL]); // 예전 API(/api/stocks)를 부르지 않는다
    vi.setSystemTime(T("10:01"));
    await loadWidgetData({ stocks: true, briefings: true });
    expect(urls).toEqual([WIDGET_URL, WIDGET_URL]);
  });

  it("404 도 HTML 이면(로그인 페이지·프록시) 연결 오류, JSON 404(정말 /api/widget 이 없는 예전 서버)만 예전 API 로 — 그것도 10분만", async () => {
    const urls: string[] = [];
    let html = true;
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("/api/widget"))
        return html
          ? new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } })
          : new Response(JSON.stringify({ message: "Route GET:/api/widget not found", error: "Not Found", statusCode: 404 }), { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(url.includes("briefings") ? [] : []), { status: 200, headers: { "content-type": "application/json" } });
    });
    const d = await loadWidgetData({ stocks: true, briefings: true });
    expect(failureText(d.error)).toBe("갱신 실패 · 연결 안 됨");
    expect(urls).toEqual([WIDGET_URL]);
    html = false;
    urls.length = 0;
    await loadWidgetData({ stocks: true, briefings: true });
    expect(urls).toEqual([WIDGET_URL, `${API}/api/stocks?quotes=1`, `${API}/api/briefings/latest`]);
    urls.length = 0;
    vi.setSystemTime(T("10:09"));
    await loadWidgetData({ stocks: true, briefings: true });
    expect(urls.filter((u) => u.includes("/api/widget"))).toHaveLength(0); // 10분 안은 묻지 않는다
    vi.setSystemTime(T("10:11"));
    await loadWidgetData({ stocks: true, briefings: true });
    expect(urls.filter((u) => u.includes("/api/widget"))).toHaveLength(1); // 예전: 6시간
  });

  it("예전 앱이 적어 둔 6시간짜리 예전 서버 기록은 쓰지 않는다 (OTA 직후에도 바로 /api/widget)", async () => {
    store.set("widget.legacyServer", JSON.stringify({ apiUrl: API, until: T("10:00") + 5 * 3_600_000 }));
    const urls = serve();
    await loadWidgetData({ stocks: true, briefings: true });
    expect(urls).toEqual([WIDGET_URL]);
  });

  it("예전 API 경로에서도 마지막 플래그를 그대로 둔다 (지수·환율 위젯이 '표시할 수 없습니다'로 바뀌지 않게)", async () => {
    serve();
    await loadWidgetData({ stocks: true, briefings: true });
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("/api/widget") ? new Response(JSON.stringify({ statusCode: 404 }), { status: 404, headers: { "content-type": "application/json" } }) : new Response("[]", { status: 200 }),
    );
    vi.setSystemTime(T("10:05"));
    const d = await loadWidgetData({ stocks: true, briefings: true });
    expect(d.features.market).toBe(true);
    expect(d.features.pnlToggle).toBe(true);
  });
});

describe("리뷰 1: 백그라운드 작업은 연장 세션이면 휴장 규칙으로 건너뛰지 않는다", () => {
  const PRE = { label: "미국 프리마켓", open: false, kr: false, us: false, nextChangeAt: "2026-09-24T13:30:00.000Z" };
  const seed = async (features: Record<string, boolean>) => {
    vi.setSystemTime(T("20:30"));
    serve(payload({ market: { ...PRE, ext: { kr: false, us: true } }, features }));
    await loadWidgetData({ stocks: true, briefings: true });
    vi.setSystemTime(T("21:00"));
  };

  it("재현: 30분 전 프리마켓 응답(ext.us) → 서버에 다시 묻는다 (예전: 2시간 건너뜀)", async () => {
    await seed({ widgetExtended: true });
    const urls = serve(payload({ market: { ...PRE, ext: { kr: false, us: true } } }));
    await runBriefingCheck();
    expect(urls).toEqual([WIDGET_URL]);
  });

  it("플래그가 꺼진 응답이면 예전처럼 건너뛴다", async () => {
    await seed({ widgetExtended: false });
    const urls = serve();
    await runBriefingCheck();
    expect(urls).toEqual([]);
  });
});

describe("리뷰 2: 자동 갱신 기록 (기기 안, 설정 화면 '마지막 자동 갱신')", () => {
  it("백그라운드 작업은 성공·건너뜀·실패를 background 로 적는다", async () => {
    serve(payload({ market: { label: "장 마감", open: false, kr: false, us: false, nextChangeAt: "2026-09-25T00:00:00.000Z" } }));
    vi.setSystemTime(T("21:00"));
    await runBriefingCheck(); // 성공 (받음)
    vi.setSystemTime(T("21:15"));
    await runBriefingCheck(); // 두 시장 닫힘 → 건너뜀
    offline();
    vi.setSystemTime(T("23:30")); // 2시간 지남 → 묻다가 실패
    await runBriefingCheck();
    const log = await readWidgetRefreshLog();
    expect(log.map((e) => [e.t, e.s, e.r])).toEqual([
      [T("21:00"), "background", "ok"],
      [T("21:15"), "background", "skipped"],
      [T("23:30"), "background", "failed"],
    ]);
    expect(log[2]!.e).toMatch(/연결/);
  });

  it("위젯 주기 갱신(WIDGET_UPDATE)은 periodic, ↻ 는 button, 크기 변경·추가·손익 전환은 적지 않는다", async () => {
    serve();
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_UPDATE" });
    vi.setSystemTime(T("10:02"));
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_RESIZED" });
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_ADDED" });
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE" });
    vi.setSystemTime(T("10:05"));
    offline();
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    const log = await readWidgetRefreshLog();
    expect(log.map((e) => [e.t, e.s, e.r])).toEqual([
      [T("10:00"), "periodic", "ok"],
      [T("10:05"), "button", "failed"],
    ]);
  });

  it("앱 즉시 갱신은 app — 앱을 켜 둔 동안 1분마다 와도 한 줄로 합친다 (자동 갱신 기록이 밀려나지 않게)", async () => {
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(T("10:00") + i * 61_000);
      await refreshWidgets({ stocks: appStocks(), showKrw: false, afterCost: false, rowKrw: true, market: KR_OPEN });
    }
    const log = await readWidgetRefreshLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ s: "app", r: "ok", t: T("10:00") + 4 * 61_000, n: 5 });
  });
});
