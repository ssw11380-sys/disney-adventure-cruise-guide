import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 위젯 2차 (B): 앱이 떠 있을 때 폰을 접거나 펴면(기기 화면 크기가 바뀜) 위젯을 지금 화면 크기로 다시 그린다 (플래그 widgetFoldFit).
 * 라이브러리는 접고 펴기만으로는 다시 그리지 않을 수 있어(런처가 크기 범위를 바꾸지 않으면), 다른 화면에서 그린 그림이 다음 갱신까지 남았다.
 * 실제 WidgetBridge 를 최소 렌더러로 그리고, 화면 크기 변경 알림(Dimensions change)에 다시 그리기(refresh.tsx redrawForScreen)를 부르는지만 본다
 */
const API = "https://server.test";
const h = vi.hoisted(() => ({
  redraws: 0,
  dims: [] as ((e: { window: { width: number; height: number }; screen: { width: number; height: number } }) => void)[],
  screen: { width: 475, height: 751 },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Dimensions: {
    get: () => h.screen,
    addEventListener: (_: string, f: (typeof h.dims)[number]) => {
      h.dims.push(f);
      return { remove: () => void h.dims.splice(h.dims.indexOf(f), 1) };
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
  useApi: () => ({ listStocks: async () => [], features: async () => ({ features: {}, updatedAt: null }), marketIndices: async () => ({ indices: [] }), latestBriefings: async () => [] }),
  useMarketStatus: () => ({ data: undefined }),
}));
vi.mock("@/widgets/refresh", async (orig) => ({
  ...(await orig<typeof import("@/widgets/refresh")>()),
  refreshWidgets: async () => undefined,
  refreshBriefingWidget: async () => undefined,
  redrawForScreen: async () => void h.redraws++,
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { render, cleanupRenders } = await import("./miniRender");
const { WidgetBridge } = await import("@/components/WidgetBridge");
const { FOLD_REDRAW_DELAY_MS } = await import("@/widgets/frame");

const STOCKS: RegisteredWithQuote[] = [holding("005930", quote("005930", 70_000), 10, 60_000, undefined, "삼성전자")];
const flags = (foldFit: boolean): FeatureFlags => ({ features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: true, ...(foldFit ? { widgetFoldFit: true } : {}) }, updatedAt: null });
const settle = async () => {
  await vi.advanceTimersByTimeAsync(30);
};
async function open(foldFit: boolean) {
  const client = new QueryClient();
  client.setQueryData([API, "features"], flags(foldFit), { updatedAt: Date.now() - 60_000 });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(WidgetBridge)));
  client.setQueryData([API, "stocks"], STOCKS, { updatedAt: Date.now() + 1_000 });
  await settle();
  return client;
}
/** 화면 크기 변경 알림 (창은 그대로 두고 기기 화면만) */
const change = (width: number, height: number) => {
  h.screen = { width, height };
  for (const f of [...h.dims]) f({ window: { width, height }, screen: { width, height } });
};

beforeEach(() => {
  cleanupRenders();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-26T10:32:00+09:00"));
  h.redraws = 0;
  h.dims.length = 0;
  h.screen = { width: 475, height: 751 };
});
afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
});

describe("WidgetBridge: 앱이 떠 있을 때 접고 펴면 위젯을 그 화면 크기로 다시 그린다 (widgetFoldFit)", () => {
  it("펴면(바깥 475×751 → 안쪽 933×704) 1초 뒤 한 번 다시 그린다 — 접는 동안 여러 번 와도 한 번", async () => {
    await open(true);
    expect(h.dims).toHaveLength(1);
    change(600, 751); // 펴는 도중
    change(933, 704);
    await vi.advanceTimersByTimeAsync(FOLD_REDRAW_DELAY_MS - 10);
    expect(h.redraws).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.redraws).toBe(1);
    // 다시 접으면 또 한 번
    change(475, 751);
    await vi.advanceTimersByTimeAsync(FOLD_REDRAW_DELAY_MS + 10);
    expect(h.redraws).toBe(2);
  });

  it("화면 크기가 그대로면(창만 바뀜 — 키보드·분할 화면) 다시 그리지 않는다", async () => {
    await open(true);
    for (const f of [...h.dims]) f({ window: { width: 475, height: 400 }, screen: { width: 475, height: 751 } });
    await vi.advanceTimersByTimeAsync(FOLD_REDRAW_DELAY_MS * 2);
    expect(h.redraws).toBe(0);
  });

  it("플래그가 꺼져 있으면 듣지도 않는다 (지금처럼)", async () => {
    await open(false);
    expect(h.dims).toHaveLength(0);
    change(933, 704);
    await vi.advanceTimersByTimeAsync(FOLD_REDRAW_DELAY_MS * 2);
    expect(h.redraws).toBe(0);
  });

  it("앱을 닫으면(브리지가 사라짐) 듣기와 기다리던 다시 그리기를 멈춘다", async () => {
    await open(true);
    change(933, 704);
    cleanupRenders();
    expect(h.dims).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FOLD_REDRAW_DELAY_MS * 2);
    expect(h.redraws).toBe(0);
  });
});
