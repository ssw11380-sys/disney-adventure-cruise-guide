import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 위젯 검토 7번 앞부분: 앱 → 위젯 즉시 갱신(WidgetBridge)이 브리핑 위젯에도 앱이 받은 최신 브리핑을 넘긴다.
 * 실제 WidgetBridge 를 최소 렌더러와 실제 QueryClient 로 그리고, 넘기는 값(refreshWidgets 인자)만 본다.
 *  - 앱이 받은 브리핑 목록(react-query 캐시)과 받은 시각을 넘긴다. 목록이 없으면 스스로 처음부터 받지 않는다
 *  - 다듬은 위젯(widgetPolish)이 켜져 있으면: 목록이 바뀌면 1분을 기다리지 않고 바로 넘기고, 다시 만들기·브리핑 알림이 목록을 무효화하면
 *    브리핑 탭이 가려져 있어도(탭 쿼리는 구독을 끊는다) 다시 받아 넘긴다
 *  - 꺼져 있으면 지금처럼: 무효화돼도 다시 받지 않고, 목록이 바뀌었다고 바로 넘기지 않는다
 */
const API = "https://server.test";
const h = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  latest: [] as unknown[],
  fetches: 0,
  appState: [] as ((s: string) => void)[],
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    addEventListener: (_: string, f: (s: string) => void) => {
      h.appState.push(f);
      return { remove: () => void h.appState.splice(h.appState.indexOf(f), 1) };
    },
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, multiGet: async () => [] } }));
vi.mock("react-native-android-widget", () => ({ FlexWidget: () => null, TextWidget: () => null, ListWidget: () => null }));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({ apiUrl: API, showKrw: false, afterCost: true, widgetRowCurrency: "krw" }),
  STORAGE_KEYS: {},
  defaultApiUrl: () => API,
  widgetRowCurrencyOf: () => "krw",
}));
vi.mock("@/api/hooks", () => ({
  useApi: () => ({
    listStocks: async () => [],
    features: async () => ({ features: {}, updatedAt: null }),
    marketIndices: async () => ({ indices: [] }),
    latestBriefings: async () => {
      h.fetches++;
      return h.latest;
    },
  }),
  useMarketStatus: () => ({ data: undefined }),
}));
vi.mock("@/widgets/refresh", async (orig) => ({
  ...(await orig<typeof import("@/widgets/refresh")>()),
  refreshWidgets: async (o: Record<string, unknown>) => void h.calls.push(o),
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { render, cleanupRenders } = await import("./miniRender");
const { WidgetBridge } = await import("@/components/WidgetBridge");

const T = Date.parse("2026-09-24T16:10:00+09:00");
const STOCKS: RegisteredWithQuote[] = [
  holding("005930", quote("005930", 70_000), 10, 60_000, undefined, "삼성전자"),
  holding("NVDA", quote("NVDA", 180, { currency: "USD", fxRate: 1300 }), 100, 100, undefined, "엔비디아"),
];
const latest = (code: string, name: string, id: number, createdAt: string): LatestBriefing => ({
  code,
  name,
  latest: { id, code, name, session: "afternoon", date: "2026-09-24", status: "ok", summary: `${name} 요약`, detail: "", missing: [], model: "", error: null, createdAt },
});
const LIST = [latest("005930", "삼성전자", 1, "2026-09-24T16:05:00+09:00"), latest("NVDA", "엔비디아", 2, "2026-09-24T16:06:00+09:00")];
/** 다시 만들기 뒤 서버 목록: 삼성전자 브리핑이 새 id 로 */
const REMADE = [latest("005930", "삼성전자", 3, "2026-09-24T16:12:00+09:00"), LIST[1]!];
const flags = (polish: boolean): FeatureFlags => ({ features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, ...(polish ? { widgetPolish: true } : {}) }, updatedAt: null });
const settle = () => new Promise((r) => setTimeout(r, 30));
const pushedIds = (o: Record<string, unknown> | undefined) => ((o?.appBriefings as { list: LatestBriefing[] } | null | undefined)?.list ?? []).map((b) => b.latest!.id);

/** 앱을 연다: 플래그·브리핑 캐시(있으면)를 두고 브리지를 그린 뒤, 잔고 탭이 잔고를 받는다 (이번 실행에서 받은 잔고라야 넘긴다) */
async function open(o: { polish: boolean; briefings?: LatestBriefing[] }) {
  const client = new QueryClient();
  client.setQueryData([API, "features"], flags(o.polish), { updatedAt: T - 60_000 });
  if (o.briefings) client.setQueryData([API, "briefings", "latest"], o.briefings, { updatedAt: T - 30_000 });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(WidgetBridge)));
  client.setQueryData([API, "stocks"], STOCKS, { updatedAt: Date.now() + 1_000 });
  await settle();
  return client;
}

beforeEach(() => {
  cleanupRenders();
  h.calls.length = 0;
  h.latest = [];
  h.fetches = 0;
  h.appState.length = 0;
});
afterEach(() => cleanupRenders());

describe("WidgetBridge: 브리핑 위젯에도 앱이 받은 최신 브리핑을 넘긴다 (위젯 검토 7번)", () => {
  it("재현: 잔고를 넘길 때 앱이 받은 브리핑 목록과 받은 시각을 함께 넘긴다 (예전: 넘기지 않아 브리핑 위젯은 15~30분 옛것)", async () => {
    await open({ polish: true, briefings: LIST });
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    const last = h.calls.at(-1)!;
    expect(last.stocks).toBe(STOCKS);
    expect(last.appBriefings).toEqual({ at: T - 30_000, list: LIST });
    // 목록이 있어도 스스로 다시 받지 않는다 (받은 것을 넘길 뿐)
    expect(h.fetches).toBe(0);
  });

  it("앱을 떠날 때도 브리핑과 함께 바로 넘긴다", async () => {
    await open({ polish: true, briefings: LIST });
    const before = h.calls.length;
    for (const f of [...h.appState]) f("background");
    await settle();
    expect(h.calls.length).toBe(before + 1);
    expect(pushedIds(h.calls.at(-1))).toEqual([1, 2]);
  });

  it("목록이 캐시에 없으면(브리핑 탭을 아직 안 봄) 스스로 받지 않는다 — 잔고만 지금처럼", async () => {
    await open({ polish: true });
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls.at(-1)!.appBriefings ?? null).toBeNull();
    expect(h.fetches).toBe(0);
  });

  it("다시 만들기: 목록이 무효화되면 브리핑 탭이 가려져 있어도 다시 받아 바로 넘긴다 (1분 기다리지 않음)", async () => {
    const client = await open({ polish: true, briefings: LIST });
    const before = h.calls.length;
    h.latest = REMADE;
    // useStockMutations 의 run 성공(다시 만들기)·브리핑 알림(NotificationBridge)과 같은 무효화
    await client.invalidateQueries({ queryKey: [API, "briefings"] });
    await settle();
    expect(h.fetches).toBe(1);
    expect(h.calls.length).toBe(before + 1);
    expect(pushedIds(h.calls.at(-1))).toEqual([3, 2]);
  });

  it("플래그 꺼짐이면 지금처럼: 무효화돼도 다시 받지 않고, 목록이 바뀌었다고 바로 넘기지 않는다", async () => {
    const client = await open({ polish: false, briefings: LIST });
    const before = h.calls.length;
    h.latest = REMADE;
    await client.invalidateQueries({ queryKey: [API, "briefings"] });
    client.setQueryData([API, "briefings", "latest"], REMADE);
    await settle();
    expect(h.fetches).toBe(0);
    expect(h.calls.length).toBe(before);
  });
});
