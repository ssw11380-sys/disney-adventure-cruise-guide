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
async function open(o: { polish: boolean; briefings?: LatestBriefing[]; stocks?: RegisteredWithQuote[] }) {
  const client = new QueryClient();
  client.setQueryData([API, "features"], flags(o.polish), { updatedAt: T - 60_000 });
  if (o.briefings) client.setQueryData([API, "briefings", "latest"], o.briefings, { updatedAt: T - 30_000 });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(WidgetBridge)));
  client.setQueryData([API, "stocks"], o.stocks ?? STOCKS, { updatedAt: Date.now() + 1_000 });
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
afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
});

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

  // ── 검증 지적 반영 ──
  it("회귀: 목록이 캐시에 없어도(앱을 새로 켜 위젯·알림에서 브리핑 상세로 바로 들어감) 다시 만들기·브리핑 알림이 목록을 무효화하면 한 번 받아 바로 넘긴다", async () => {
    // 예전: 관찰자가 '목록이 캐시에 있을 때만' 켜져, 브리핑 탭을 안 본 실행에서는 무효화돼도 받지 않았다 → 브리핑 위젯은 옛 요약 그대로(휴장이면 최대 2시간)
    const client = await open({ polish: true });
    expect(h.fetches).toBe(0);
    const before = h.calls.length;
    h.latest = REMADE;
    await client.invalidateQueries({ queryKey: [API, "briefings"] });
    await settle();
    expect(h.fetches).toBe(1);
    expect(h.calls.length).toBe(before + 1);
    expect(pushedIds(h.calls.at(-1))).toEqual([3, 2]);
    // 받은 뒤로는 스스로 다시 받지 않는다 (잔고를 새로 받아도, 앱을 떠나도)
    client.setQueryData([API, "stocks"], [...STOCKS], { updatedAt: Date.now() + 2_000 });
    for (const f of [...h.appState]) f("background");
    await settle();
    expect(h.fetches).toBe(1);
    expect(pushedIds(h.calls.at(-1))).toEqual([3, 2]);
  });

  it("무효화 없이 새로 켠 것만으로는 받지 않고, 캐시를 비워도(토큰 변경 resetQueries) 받지 않는다 · 플래그 꺼짐이면 목록이 없을 때 무효화돼도 받지 않는다", async () => {
    const on = await open({ polish: true });
    expect(h.fetches).toBe(0);
    await on.resetQueries();
    await settle();
    expect(h.fetches).toBe(0);
    cleanupRenders();
    const off = await open({ polish: false });
    const before = h.calls.length;
    h.latest = REMADE;
    await off.invalidateQueries({ queryKey: [API, "briefings"] });
    await settle();
    expect(h.fetches).toBe(0);
    expect(h.calls.length).toBe(before);
  });

  it("회귀: 시세만 바뀌어 원화 평가금액이 비슷한 종목의 순서·3위와 4위가 뒤집혀도 1분 안에는 더 넘기지 않는다 (3-16 '시세만 바뀌면 1분에 한 번')", async () => {
    // 예전: 키에 '고른 3종목과 그 순서'를 넣어, 체결마다 뒤집히면 1분 규칙을 건너뛰고 매번 넘겼다 (1초 안에 10번 뒤집으면 9~10번)
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    // 엔비디아(약 2,340 만원)가 1위, 삼성전자(69.99~70.01 만원)·SK하이닉스(70 만원)·NAVER(69.995 만원)가 2~4위를 다툰다
    const ticked = (samsung: number): RegisteredWithQuote[] => [
      STOCKS[1]!,
      holding("005930", quote("005930", samsung), 10, 60_000, undefined, "삼성전자"),
      holding("000660", quote("000660", 700_000), 1, 600_000, undefined, "SK하이닉스"),
      holding("035420", quote("035420", 699_950), 1, 600_000, undefined, "NAVER"),
    ];
    const list = [...LIST, latest("000660", "SK하이닉스", 4, "2026-09-24T16:07:00+09:00"), latest("035420", "NAVER", 5, "2026-09-24T16:08:00+09:00")];
    const client = await open({ polish: true, briefings: list, stocks: ticked(70_010) });
    const before = h.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);
    const { pickWidgetBriefings } = await import("@/widgets/refresh");
    const picks = new Set<string>();
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(T + (i + 1) * 90);
      const s = ticked(i % 2 ? 70_010 : 69_990);
      picks.add(pickWidgetBriefings(list, s).map((b) => b.code).join(","));
      client.setQueryData([API, "stocks"], s, { updatedAt: Date.now() });
      await settle();
    }
    // 정말로 순서·구성이 뒤집혔다 (삼성전자가 2위 ↔ 4위 — 3종목 구성도 바뀐다)
    expect([...picks].sort()).toEqual(["NVDA,000660,035420", "NVDA,005930,000660"]);
    expect(h.calls.length).toBe(before);
    expect(h.fetches).toBe(0);
    // 1분이 지나면 다음 시세에 한 번 넘긴다 — 목록 전체를 넘겨 그때 시세로 고르게 한다 (refresh.tsx)
    vi.setSystemTime(T + 61_000);
    client.setQueryData([API, "stocks"], ticked(69_990), { updatedAt: Date.now() });
    await settle();
    expect(h.calls.length).toBe(before + 1);
    expect(pushedIds(h.calls.at(-1))).toEqual([1, 2, 4, 5]);
    // 새 브리핑(목록이 바뀜)은 1분을 기다리지 않는다
    client.setQueryData([API, "briefings", "latest"], [...list.slice(1), latest("005930", "삼성전자", 6, "2026-09-24T16:20:00+09:00")]);
    await settle();
    expect(h.calls.length).toBe(before + 2);
    expect(pushedIds(h.calls.at(-1))).toEqual([2, 4, 5, 6]);
  });
});
