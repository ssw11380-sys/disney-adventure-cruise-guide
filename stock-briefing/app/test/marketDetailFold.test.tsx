import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 지수·환율 상세 넓은 창 (3-42 웨이브 C, 플래그 foldLayout): 넓은 창에서는 값 머리를 한 줄로 줄여 차트가 첫 화면에 더 들어오게 한다.
 * 플래그가 꺼져 있거나 좁은 창이면 바꾸기 전 화면(스냅숏)과 똑같다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flag: undefined as boolean | undefined,
  params: { code: "KOSPI" } as Record<string, string>,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { setParams: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => h.params }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
const INDEX = { code: "KOSPI", name: "코스피", value: 3478.12, change: 29.35, changeRate: 0.85, kind: "index", asOf: "2026-09-23T06:30:00Z", fetchedAt: "2026-09-23T06:31:00Z", stale: false };
vi.mock("@/api/hooks", () => ({
  useMarketIndices: () => ({ data: { indices: [INDEX] }, isLoading: false, refetch: async () => undefined }),
  useMarketCandles: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined }),
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : fallback),
}));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 } }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip", formatIndexValue: (v: number) => v.toFixed(2) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
// 넓은 창 머리(components/StockDetailParts)가 함께 불러오는 것
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Stat: "Stat" }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "http://x", sort: "created", afterCost: false, showKrw: false }) }));

const { default: MarketIndexScreen } = await import("@/app/market/[code]");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");

function ser(v: unknown): unknown {
  if (typeof v === "function") return "[fn]";
  if (React.isValidElement(v)) {
    const e = v as React.ReactElement<Record<string, unknown>>;
    return { el: typeof e.type === "string" ? e.type : ((e.type as { name?: string }).name ?? "?"), props: ser(e.props) };
  }
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}
const tree = (nodes: (HostNode | string)[]): unknown =>
  nodes.map((n) => {
    if (typeof n === "string") return n;
    const { children: _c, ...props } = n.props;
    return { type: n.type, props: ser(props), children: tree(n.children) };
  });
const size = (width: number, height: number, fontScale = 1) => {
  h.win = { width, height, scale: 2.625, fontScale };
};

beforeEach(() => {
  size(475, 751);
  h.flag = undefined;
  forgetWindowClass();
});

describe("지수 상세: 플래그 꺼짐·좁은 창은 지금 화면 그대로 (바꾸기 전 스냅숏)", () => {
  it("플래그 꺼짐 · 폴드8 펼침 가로 크기", () => {
    size(933, 704);
    expect(tree(render(<MarketIndexScreen />).tree)).toMatchSnapshot();
  });
});
