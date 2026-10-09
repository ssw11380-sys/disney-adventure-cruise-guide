import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/** 실제 위젯 전달 컴포넌트·쿼리 캐시로 수량 변경과 마지막 가격 전달을 검증한다. 기기 실측은 아니다. */
const API = "https://server.test";
const h = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  /** 브리핑 위젯만 다시 그리기 (refreshBriefingWidget) 에 넘긴 값 */
  briefOnly: [] as ({ at: number; list: unknown[] } | null | undefined)[],
  latest: [] as unknown[],
  fetches: 0,
  appState: [] as ((s: string) => void)[],
  apiToken: "bridge-test-token",
  snapshotResets: 0,
  snapshotResetGate: null as Promise<void> | null,
  settingsReady: true,
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
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, multiGet: async () => [] } }));
vi.mock("react-native-android-widget", () => ({ FlexWidget: () => null, TextWidget: () => null, ListWidget: () => null }));
vi.mock("@/lib/settings", () => ({
  useSettings: () => ({ apiUrl: API, apiToken: h.apiToken, ready: h.settingsReady, showKrw: false, afterCost: true, widgetRowCurrency: "krw" }),
  STORAGE_KEYS: {},
  defaultApiUrl: () => API,
  widgetRowCurrencyOf: () => "krw",
}));
vi.mock("@/api/hooks", async (original) => ({
  ...(await original<typeof import("@/api/hooks")>()),
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
  refreshBriefingWidget: async (a: { at: number; list: unknown[] } | null | undefined) => void h.briefOnly.push(a),
}));
vi.mock("@/widgets/data", async (orig) => ({
  ...(await orig<typeof import("@/widgets/data")>()),
  resetWidgetAccountSnapshot: () => { h.snapshotResets++; return h.snapshotResetGate ?? Promise.resolve(); },
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { render, cleanupRenders } = await import("./miniRender");
const { WidgetBridge } = await import("@/components/WidgetBridge");


const { sessionIdentityVersion } = await import("@/lib/session");

const T = Date.parse("2026-09-24T16:10:00+09:00");
const STOCKS: RegisteredWithQuote[] = [
  holding("005930", quote("005930", 70_000), 10, 60_000, undefined, "삼성전자"),
  holding("NVDA", quote("NVDA", 180, { currency: "USD", fxRate: 1300 }), 100, 100, undefined, "엔비디아"),
];
const flags = (polish: boolean): FeatureFlags => ({ features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, ...(polish ? { widgetPolish: true } : {}) }, updatedAt: null });
const settle = () => new Promise((r) => setTimeout(r, 30));

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
  h.briefOnly.length = 0;
  h.latest = [];
  h.fetches = 0;
  h.appState.length = 0;
  h.apiToken = "bridge-test-token";
  h.snapshotResets = 0;
  h.snapshotResetGate = null;
  h.settingsReady = true;
});


afterEach(() => { cleanupRenders(); vi.useRealTimers(); });

describe("2026-10-07 위젯 실시간 반영 요구 재현", () => {
  it("빠른 전달이 켜지면 마지막 가격을 5초에 넘기고 입력이 이어져도 기한을 밀지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
    const client = await open({ polish: true });
    client.setQueryData([API,"features"], { features:{...flags(true).features, widgetLeanLive:true} });
    await settle();
    const before = h.calls.length;
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]}); vi.setSystemTime(T+1000);
    for (let n=0;n<4;n++) {
      client.setQueryData([API,"stocks"], [holding("005930",quote("005930",71000+n),10,60000,undefined,"삼성전자"),STOCKS[1]!]);
      await vi.advanceTimersByTimeAsync(n===3 ? 999 : 1000);
      expect(h.calls.length).toBe(before);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.length).toBe(before+1);
    expect((h.calls.at(-1)!.stocks as RegisteredWithQuote[])[0]!.quote!.price).toBe(71003);
    expect(h.fetches).toBe(0);
  });
  it("예약 후 화면이 해제되면 남은 위젯 전달을 취소한다", async () => {
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(T);
    const client = await open({polish:true}); const before=h.calls.length;
    vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]}); vi.setSystemTime(T+1000);
    client.setQueryData([API,"stocks"],[holding("005930",quote("005930",71000),10,60000,undefined,"삼성전자"),STOCKS[1]!]);
    await vi.advanceTimersByTimeAsync(10); cleanupRenders();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.calls.length).toBe(before);
  });
  it("수량 변경은 시세 제한과 관계없이 위젯으로 즉시 전달되어야 한다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
    const client = await open({ polish: true });
    const before = h.calls.length;
    vi.setSystemTime(T + 5_000);
    client.setQueryData([API, "stocks"], [holding("005930", quote("005930", 70000), 20, 60000, undefined, "삼성전자"), STOCKS[1]!], { updatedAt: Date.now() });
    await settle();
    expect(h.calls.length, "10주에서 20주로 바뀐 자료를 앱이 받았지만 위젯에 넘기지 않음").toBe(before + 1);
  });
  it("제한 시간 안에 받은 마지막 시세도 60초가 되면 추가 입력 없이 전달되어야 한다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T);
    const client = await open({ polish: true });
    const before = h.calls.length;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(T + 5_000);
    client.setQueryData([API, "stocks"], [holding("005930", quote("005930", 71000), 10, 60000, undefined, "삼성전자"), STOCKS[1]!], { updatedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls.length, "1분이 지나도 다음 시세나 앱 이탈이 없으면 마지막 값을 전달하지 않음").toBe(before + 1);
  });
  it("같은 종목의 체결이 들어오면 잔고뿐 아니라 관심목록 현재가도 즉시 바뀌어야 한다", async () => {
    const now = Date.now();
    const { applyTicksToCache } = await import("@/lib/liveStream");
    const client = new QueryClient();
    const current = Date.now() + 1000;
    const row = holding("005930", quote("005930", 70000, { asOf: new Date(current).toISOString(), prevClose:69000 }), 10, 60000, undefined, "삼성전자");
    // 실제 useWatchScope처럼 현재 인증 경계로 만든다. 모듈의 이전 검사에서 경계가 바뀔 수 있다.
    const key = [API, "watchlist", 1, sessionIdentityVersion()];
    client.setQueryData([API, "stocks"], [row], {updatedAt:current});
    client.setQueryData(key, {on:true,items:[{code:row.code,name:row.name,startPrice:70000,desiredPrice:68000,quote:row.quote}]}, {updatedAt:current});
    const oldKey = [API, "watchlist", 2, sessionIdentityVersion()-1];
    client.setQueryData(oldKey, client.getQueryData(key), {updatedAt:current});
    applyTicksToCache(client, API, new Map([[row.code, {code:row.code,price:71000,volume:null,timestamp:new Date(current+1000).toISOString(),source:"test"}]]), new Set(), now+2000);
    expect(client.getQueryData<RegisteredWithQuote[]>([API,"stocks"])![0]!.quote!.price).toBe(71000);
    expect((client.getQueryData(key) as {items:{quote:{price:number}}[]}).items[0]!.quote.price, "잔고는 71000원, 같은 체결을 받은 관심목록은 70000원").toBe(71000);
    expect((client.getQueryData(oldKey) as {items:{quote:{price:number}}[]}).items[0]!.quote.price).toBe(70000);
  });
  it("관심 조회가 늦게 도착해도 더 최신 체결을 유지하며 기준가와 희망가는 보존한다", async () => {
    const {withWatchTicks,rememberTicks,forgetTicks}=await import("@/lib/liveStream");
    const at="2026-10-07T10:00:00+09:00";
    const row={code:"005930",name:"삼성전자",market:"KOSPI",currency:"KRW" as const,startPrice:69000,desiredPrice:68000,alerts:true,createdAt:at,updatedAt:at,quote:quote("005930",70000,{asOf:at,prevClose:69000})};
    try {
      rememberTicks(API,[{code:row.code,price:71000,volume:null,timestamp:"2026-10-07T10:00:01+09:00",source:"test"}]);
      const result=withWatchTicks(API,{items:[row]}).items[0]!;
      expect(result.quote!.price).toBe(71000); expect(result.startPrice).toBe(69000); expect(result.desiredPrice).toBe(68000);
      expect(withWatchTicks("https://another.test",{items:[row]}).items[0]!.quote!.price).toBe(70000);
      forgetTicks(); expect(withWatchTicks(API,{items:[row]}).items[0]!.quote!.price).toBe(70000);
    } finally {forgetTicks();}
  });
});
