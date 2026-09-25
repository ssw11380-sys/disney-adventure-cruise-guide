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
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
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
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
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
  h.insets = { top: 0, bottom: 0, left: 0, right: 0 };
  forgetWindowClass();
});

describe("지수 상세: 플래그 꺼짐·좁은 창은 지금 화면 그대로 (바꾸기 전 스냅숏)", () => {
  it("플래그 꺼짐 · 폴드8 펼침 가로 크기", () => {
    size(933, 704);
    expect(tree(render(<MarketIndexScreen />).tree)).toMatchSnapshot();
  });

  it("플래그가 꺼져 있으면 화면 여백(safe area)이 있어도 지금 화면과 같다", () => {
    size(933, 704);
    const golden = tree(render(<MarketIndexScreen />).tree);
    h.insets = { top: 32, bottom: 48, left: 24, right: 0 };
    expect(tree(render(<MarketIndexScreen />).tree)).toEqual(golden);
  });

  it("플래그가 꺼져 있으면 여섯 크기 모두, 켜져 있어도 접힌 화면은 같은 결과", () => {
    size(933, 704);
    const golden = tree(render(<MarketIndexScreen />).tree);
    for (const [w, hh] of [[475, 679], [411, 888], [933, 632], [704, 861], [859, 882], [954, 787]] as const) {
      forgetWindowClass();
      size(w, hh);
      expect(tree(render(<MarketIndexScreen />).tree), `꺼짐 ${w}x${hh}`).toEqual(golden);
    }
    h.flag = true;
    for (const [w, hh] of [[475, 679], [411, 888]] as const) {
      forgetWindowClass();
      size(w, hh);
      expect(tree(render(<MarketIndexScreen />).tree), `켜짐 ${w}x${hh}`).toEqual(golden);
    }
  });
});

describe("지수 상세 넓은 창", () => {
  const all = (r: ReturnType<typeof render>) => r.all();
  const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));

  it("펼친 폴드8 가로: 한 줄 머리(수정 버튼·이전/다음 없음) + 지수 띠 아래 남은 높이에 차트를 맞춘다", () => {
    h.flag = true;
    size(933, 632);
    const r = render(<MarketIndexScreen />);
    expect(all(r).find((n) => n.type === "StackScreen")!.props.options).toEqual({ headerShown: false });
    // 머리는 Screen 의 top (스크롤과 상관없이 맨 위)
    const head = render(all(r).find((n) => n.type === "Screen")!.props.top as React.ReactElement);
    expect(head.has("뒤로")).toBe(true);
    expect(head.has("보유 정보 수정")).toBe(false);
    expect(head.all().some((n) => /종목 중/.test(String(n.props.accessibilityLabel ?? "")))).toBe(false);
    expect(head.text()).toContain("장 마감");
    const chart = () => all(r).find((n) => n.type === "CandleChart")!;
    expect(chart().props.height).toBeUndefined();
    const body = all(r).find((n) => typeof n.props.onLayout === "function" && flat(n).flex === 1)!;
    r.act(() => (body.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 933, height: 480 } } }));
    expect(chart().props.height).toBe(480 - 120);
    // 당겨서 새로고침은 차트 칸 스크롤에
    expect(React.isValidElement(all(r).find((n) => n.type === "ScrollView")!.props.refreshControl)).toBe(true);
  });

  it("폴드8 펼침 세로·울트라 펼침 세로: 한 줄 머리 + 지금처럼 스크롤 (차트는 기본 크기)", () => {
    h.flag = true;
    for (const [w, hh] of [[704, 861], [859, 882]] as const) {
      forgetWindowClass();
      size(w, hh);
      const r = render(<MarketIndexScreen />);
      const screen = all(r).find((n) => n.type === "Screen")!;
      expect(typeof screen.props.onRefresh).toBe("function");
      expect(render(screen.props.top as React.ReactElement).has("뒤로")).toBe(true);
      expect(all(r).find((n) => n.type === "CandleChart")!.props.height).toBeUndefined();
    }
  });
});

describe("지수 상세 넓은 창: 아래 작업 표시줄 · 좌우 카메라 구멍 여백 (앱은 화면 끝까지 그린다)", () => {
  const all = (r: ReturnType<typeof render>) => r.all();
  const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
  const INSETS = { top: 24, bottom: 48, left: 32, right: 16 };

  it("좌우 배치: 차트 칸이 작업 표시줄(48) 위에서 끝나고 좌우 여백을 비운다 — 차트는 그 안쪽 높이에 맞춘다", () => {
    h.flag = true;
    h.insets = INSETS;
    size(933, 704);
    const r = render(<MarketIndexScreen />);
    const outer = all(r).find((n) => flat(n).flex === 1 && flat(n).paddingBottom === INSETS.bottom)!;
    expect(outer).toBeDefined();
    expect([flat(outer).paddingLeft, flat(outer).paddingRight]).toEqual([INSETS.left, INSETS.right]);
    // 재는 칸은 여백 안쪽 (여백을 뺀 높이를 받는다)
    const body = outer.children.find((c): c is HostNode => typeof c !== "string" && typeof c.props.onLayout === "function")!;
    r.act(() => (body.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 933 - 48, height: 430 } } }));
    expect(all(r).find((n) => n.type === "CandleChart")!.props.height).toBe(430 - 120);
    // 지수 띠도 좌우 여백 안쪽
    const strip = all(r).find((n) => n.type === "MarketStrip")!;
    expect(all(r).some((n) => n.children.includes(strip) && flat(n).paddingLeft === INSETS.left && flat(n).paddingRight === INSETS.right)).toBe(true);
  });

  it("한 단(펼침 세로): 끝까지 내리면 출처 줄이 작업 표시줄 위에 (아래 여백 = 기본 + 48), 차트 칸 좌우도 여백 안쪽", () => {
    h.flag = true;
    h.insets = INSETS;
    for (const [w, hh] of [[704, 933], [859, 954]] as const) {
      forgetWindowClass();
      size(w, hh);
      const r = render(<MarketIndexScreen />);
      const screen = all(r).find((n) => n.type === "Screen")!;
      expect(flat({ ...screen, props: { style: screen.props.contentStyle } } as HostNode).paddingBottom, `${w}x${hh}`).toBeGreaterThanOrEqual(INSETS.bottom + 8);
      const panel = all(r).find((n) => n.children.some((c) => typeof c !== "string" && c.type === "CandleChart"))!;
      expect(flat(panel).paddingLeft).toBeGreaterThan(INSETS.left);
      expect(flat(panel).paddingRight).toBeGreaterThan(INSETS.right);
    }
  });
});
