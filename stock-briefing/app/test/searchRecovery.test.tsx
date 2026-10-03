import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";

// 실제 화면·useSearch·QueryClient를 사용한다. 네트워크와 RN 렌더링은 모의이므로 실기기 검증과 구분한다.
const h = vi.hoisted(() => ({
  online: false,
  held: undefined as Promise<void> | undefined,
  calls: [] as { source: string; query: string }[],
}));
vi.mock("react-native", async () => {
  const R = await import("react");
  return {
    View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable",
    Keyboard: { metrics: () => undefined, addListener: () => ({ remove() {} }) },
    FlatList: ({ data, renderItem, ListEmptyComponent }: { data: unknown[]; renderItem: (arg: { item: unknown }) => React.ReactNode; ListEmptyComponent: React.ReactNode }) =>
      R.createElement("FlatList", null, data.length ? data.map((item, i) => R.createElement(R.Fragment, { key: i }, renderItem({ item }))) : ListEmptyComponent),
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
    Platform: { OS: "android" }, Alert: { alert: vi.fn() }, ToastAndroid: { show: vi.fn(), SHORT: 0 },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock("expo-router", () => ({ router: { push: vi.fn(), back: vi.fn() }, useIsFocused: () => true }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => { const tokens = await import("@/tokens"); return { ...tokens, useTheme: () => tokens.light }; });
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://search-recovery.test", apiToken: "", ready: true }) }));
vi.mock("@/lib/account", () => ({ useAccountView: () => ({ member: false }) }));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => ({ onOpenSettings: vi.fn() }) }));
vi.mock("@/lib/recentSearch", () => ({ useRecentSearches: () => ({ items: [], add: vi.fn(), clear: vi.fn() }) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/StockLine", () => ({ LineHead: "LineHead", LineMark: "LineMark", StockLine: "StockLine" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ConnectionLine: "ConnectionLine", Muted: "Muted" }));
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  const search = async (source: string, query: string) => {
    h.calls.push({ source, query });
    if (!h.online) throw new actual.ApiRequestError(0, "NETWORK", "주입한 연결 실패");
    await h.held;
    return { results: [{ code: query, name: `${query} 결과`, market: "NASDAQ", isinCode: null, groupCode: null }] };
  };
  return { ...actual, createApi: () => ({ searchStocks: (q: string) => search("full", q), searchStocksLocal: (q: string) => search("local", q) }) };
});
vi.mock("@/api/hooks", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/hooks")>(),
  useRegisteredCodes: () => ({ codes: new Set<string>(), refresh: vi.fn() }),
  useStockMutations: () => ({ register: { mutate: vi.fn(), isPending: false } }),
}));
const { default: AddStockScreen } = await import("@/app/stocks/add");
let qc: QueryClient;
beforeEach(() => {
  vi.useFakeTimers(); h.online = false; h.held = undefined; h.calls = [];
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { cleanupRenders(); qc.clear(); vi.useRealTimers(); });
const draw = () => render(<QueryClientProvider client={qc}><AddStockScreen /></QueryClientProvider>);
type Screen = ReturnType<typeof draw>;
const typeIn = (r: Screen, q: string) => r.act(() => (r.byLabel("종목 검색").props.onChangeText as (v: string) => void)(q));
const retry = (r: Screen) => r.all().find((n) => n.type === "Button" && n.props.title === "다시 검색");
const settle = async (r: Screen) => { for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(0); r.rerender(); } };
const searchFor = async (r: Screen, q: string) => { typeIn(r, q); await vi.advanceTimersByTimeAsync(150); await settle(r); };

describe("검색 실패 뒤 사용자가 같은 검색어로 복구", () => {
  it("연결 복구만으로 반복 조회하지 않으며 다시 검색 연타는 두 기존 조회를 한 번씩만 복구한다", async () => {
    const r = draw(); await searchFor(r, "NVDA");
    expect(h.calls).toEqual([{ source: "full", query: "NVDA" }, { source: "local", query: "NVDA" }]);
    expect(retry(r)).toBeDefined();
    h.online = true;
    await vi.advanceTimersByTimeAsync(15_000); await settle(r);
    expect(h.calls).toHaveLength(2);
    let release!: () => void;
    h.held = new Promise<void>((resolve) => { release = resolve; });
    const press = retry(r)!.props.onPress as () => void;
    r.act(() => { press(); press(); }); await settle(r);
    expect(h.calls).toEqual([
      { source: "full", query: "NVDA" }, { source: "local", query: "NVDA" },
      { source: "full", query: "NVDA" }, { source: "local", query: "NVDA" },
    ]);
    release(); await settle(r);
    expect(r.byLabel("종목 검색").props.value).toBe("NVDA");
    expect(r.all().some((n) => n.type === "StockLine" && n.props.name === "NVDA 결과")).toBe(true);
    expect(retry(r)).toBeUndefined();
  });

  it("키보드 검색 제출로도 같은 검색어를 복구하고 입력이 바뀌는 중에는 앞 검색을 다시 보내지 않는다", async () => {
    const r = draw(); await searchFor(r, "NVDA");
    typeIn(r, "AAPL");
    expect(retry(r)?.props.disabled).toBe(true);
    const submitWhileTyping = r.byLabel("종목 검색").props.onSubmitEditing as () => void;
    expect(submitWhileTyping).toBeTypeOf("function");
    r.act(submitWhileTyping); await settle(r);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(150); await settle(r);
    expect(h.calls.slice(-2).every((c) => c.query === "AAPL")).toBe(true);
    h.online = true;
    r.act(() => (r.byLabel("종목 검색").props.onSubmitEditing as () => void)()); await settle(r);
    expect(h.calls).toHaveLength(6);
    expect(r.all().some((n) => n.type === "StockLine" && n.props.name === "AAPL 결과")).toBe(true);
  });

  it("정상 검색은 기존 150ms 뒤 각 조회 한 번이며 추가 버튼·자동 조회가 없다", async () => {
    h.online = true;
    const r = draw(); typeIn(r, "NVDA");
    await vi.advanceTimersByTimeAsync(149); expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); await settle(r);
    expect(h.calls).toHaveLength(2);
    expect(retry(r)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000); await settle(r);
    expect(h.calls).toHaveLength(2);
  });
});
