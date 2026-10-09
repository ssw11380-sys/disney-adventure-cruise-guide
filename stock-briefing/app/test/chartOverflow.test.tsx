import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

const h = vi.hoisted(() => ({ win: { width: 475, height: 751, fontScale: 1 }, period: "D" }));
vi.mock("react-native", () => ({
  View: "View", ScrollView: "ScrollView", Text: "Text", Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { back: vi.fn(), dismissTo: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ code: "005930", period: h.period }) }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/lib/useFoldLayout", () => ({ useFoldLayout: () => ({ on: true, width: h.win.width < 600 ? "compact" : "medium" }) }));
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ data: undefined }),
  useCandles: () => ({ data: undefined, isLoading: false, isError: true, error: new Error("차트 조회 실패"), refetch: vi.fn() }),
  useFeature: () => false,
}));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ ChangeText: "ChangeText", ErrorView: "ErrorView" }));
const { default: ChartScreen } = await import("@/app/stocks/[code]/chart");

type Screen = ReturnType<typeof render>;
const style = (node: HostNode, prop = "style") => Object.assign({}, ...[node.props[prop]].flat(Infinity).filter(Boolean));
const chart = (r: Screen) => r.all().find((n) => n.type === "CandleChart")!;
const contains = (root: HostNode, target: HostNode): boolean => root === target || root.children.some((n) => typeof n !== "string" && contains(n, target));
const scroller = (r: Screen) => r.all().find((n) => n.type === "ScrollView" && contains(n, chart(r)));
/** 네이티브가 보고한 도구 높이를 재현한다. 실제 글꼴 높이를 측정했다고 주장하지 않는다. */
const measureTools = (r: Screen, toolsH: number) => {
  const parent = r.all().find((n) => n.type === "View" && n.children.includes(chart(r)))!;
  const height = Number(chart(r).props.height) + toolsH;
  r.act(() => (parent.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { height, width: h.win.width, x: 0, y: 0 } } }));
};
beforeEach(() => { h.win = { width: 475, height: 751, fontScale: 1 }; h.period = "D"; });

describe("낮은 전체 화면 차트의 도구·오류 안내 도달", () => {
  it("933×320 창에서 그림 최소 높이와 도구가 화면보다 커도 끝까지 스크롤할 수 있다", () => {
    h.win = { width: 933, height: 320, fontScale: 2 };
    const r = render(<ChartScreen />);
    measureTools(r, 220);
    const available = 320 - 48 - 44;
    const content = Number(chart(r).props.height) + 220;
    expect(content).toBeGreaterThan(available);
    expect(Number(chart(r).props.height)).toBeGreaterThanOrEqual(160);
    const scroll = scroller(r);
    expect(scroll).toBeDefined();
    expect(style(scroll!).flex).toBe(1);
    expect(style(scroll!, "contentContainerStyle").height).toBeUndefined();
    const notice = r.all().find((n) => n.type === "ChartNotice")!;
    expect(contains(scroll!, notice)).toBe(true);
    expect(contains(scroll!, r.byLabel("차트 닫기"))).toBe(false);
  });

  it.each([
    { width: 475, height: 751 }, { width: 933, height: 704 },
    { width: 704, height: 933 }, { width: 411, height: 900 },
  ].flatMap((size) => [1, 1.3, 2].map((fontScale) => ({ ...size, fontScale }))))(
    "$width×$height · 글자 $fontScale: 그림·조작·안내를 유지하며 낮아진 공간에서는 스크롤한다",
    ({ width, height, fontScale }) => {
      h.win = { width, height, fontScale };
      const r = render(<ChartScreen />);
      const toolsH = Math.ceil(170 * fontScale);
      measureTools(r, toolsH);
      const before = chart(r);
      expect(before.props.period).toBe("D");
      expect(Number(before.props.height)).toBeGreaterThanOrEqual(160);
      expect(scroller(r)).toBeDefined();
      expect(contains(scroller(r)!, r.all().find((n) => n.type === "ChartNotice")!)).toBe(true);
      if (width < height) {
        r.act(() => (r.byLabel("가로로 보기").props.onPress as () => void)());
        measureTools(r, toolsH);
        expect(scroller(r)).toBeDefined();
        expect(chart(r).props.period).toBe("D");
        expect(r.has("세로로 보기")).toBe(true);
      }
    },
  );
});
