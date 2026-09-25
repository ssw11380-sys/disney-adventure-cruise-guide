import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 상세 ‹ › 뒤 '뒤로 1번이면 잔고로 돌아가고, 마지막에 본 줄로 스크롤해 강조' (3-42 웨이브 C 설계 · 검증 지적 must).
 *  - ‹ › 를 쓰지 않았으면 잔고 화면은 지금 그대로 (감싸는 틀·스크롤·알림 없음)
 *  - ‹ › 로 넘겨 본 뒤 잔고가 다시 보이면: 마지막에 본 줄을 테두리로 강조하고, 그 줄을 목록 칸 가운데쯤으로 한 번만 스크롤,
 *    화면 읽기에 '마지막에 본 종목, 이름' 을 알리고, foldDetail.returnMarkMs 뒤 강조를 끈다
 */
const h = vi.hoisted(() => ({
  focused: true,
  announce: vi.fn(),
  push: vi.fn(),
  stocks: undefined as unknown,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: h.announce },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push }, useIsFocused: () => h.focused }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  useSettings: () => ({ afterCost: false, showKrw: false, sort: "created", setSort: vi.fn(), apiUrl: "http://x" }),
}));
vi.mock("@/api/hooks", () => ({
  useApi: () => ({ listStocks: async () => [] }),
  useFeature: (_key: string, fallback = false) => fallback,
  useStocks: () => ({ data: h.stocks, isError: false, error: null, refetch: async () => undefined }),
  useHealth: () => ({ data: undefined }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: vi.fn() } }),
}));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Empty: "Empty", ErrorView: "ErrorView", Loading: "Loading", TableHead: "TableHead" }));
vi.mock("@/components/Freshness", () => ({ LiveStatus: "LiveStatus", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: vi.fn() }), useFeedState: () => ({ now: 0, feedOk: true }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip" }));
vi.mock("@/components/Skeleton", () => ({ HoldingsSkeleton: "HoldingsSkeleton" }));
vi.mock("@/components/StockRow", () => ({ StockRow: "StockRow" }));
vi.mock("@/components/StockLine", () => ({ PRICE_HEAD: "현재가", useLineCols: () => ({ rank: 30, price: 100, right: 108 }) }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { useReturnMark } = await import("@/components/ReturnMark");
const nav = await import("@/lib/holdingsNav");
const { foldDetail, light } = await import("@/tokens");

const ROWS = [
  holding("005930", quote("005930", 84_300), 120, 71_000, {}, "삼성전자"),
  holding("000660", quote("000660", 351_000), 18, 250_000, {}, "SK하이닉스"),
  holding("035420", quote("035420", 232_000), 15, 200_000, {}, "NAVER"),
  holding("035720", quote("035720", 41_000), null, null, {}, "카카오"),
];
const ORDER = [
  { code: "005930", name: "삼성전자" },
  { code: "000660", name: "SK하이닉스" },
  { code: "035420", name: "NAVER" },
];

/** 종목 상세에서 ‹ › 로 두 번 넘겨 NAVER 까지 본 것과 같다 */
function browsed() {
  const first = nav.navAt("held", ORDER, "005930")!;
  nav.rememberNav(first, first.next!);
  nav.rememberNav(nav.navAt("held", ORDER, "000660")!, ORDER[2]!);
}
/** 종목 상세를 열었다가(잔고가 가려짐) 뒤로 돌아온다. 마지막에 본 종목은 다시 보인 다음 차례에 읽는다 */
function returnTo(r: ReturnType<typeof render>) {
  h.focused = false;
  r.rerender();
  h.focused = true;
  r.rerender();
  r.act(() => vi.advanceTimersByTime(0));
}
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const rowOf = (r: ReturnType<typeof render>, code: string) => r.all().find((n) => n.type === "StockRow" && (n.props.stock as { code: string }).code === code)!;
const parentOf = (r: ReturnType<typeof render>, child: HostNode) => r.all().find((n) => n.children.includes(child))!;

beforeEach(() => {
  vi.useFakeTimers();
  nav.forgetHoldingsNav();
  h.focused = true;
  h.announce.mockReset();
  h.stocks = ROWS;
});
afterEach(() => vi.useRealTimers());

describe("useReturnMark (훅)", () => {
  function mount(scrollTo = vi.fn()) {
    const seen = { mark: null as ReturnType<typeof useReturnMark> | null };
    function Probe() {
      seen.mark = useReturnMark(scrollTo);
      return <>{["A", "B"].map((code) => seen.mark!.wrap(code, <Text key={code}>{code}</Text>))}</>;
    }
    const Text = "Text" as unknown as React.FC<{ children: React.ReactNode }>;
    return { r: render(<Probe />), seen, scrollTo };
  }

  it("‹ › 를 쓰지 않았으면 아무것도 하지 않는다 (줄을 그대로 돌려준다)", () => {
    const { r, seen, scrollTo } = mount();
    returnTo(r);
    expect(seen.mark!.code).toBeNull();
    expect(r.all().map((n) => n.type)).toEqual(["Text", "Text"]);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("돌아오면 한 번 읽어 강조 → 가운데쯤으로 한 번만 스크롤 → 시간이 지나면 끈다", () => {
    const { r, seen, scrollTo } = mount();
    nav.rememberNav(nav.navAt("held", [{ code: "A", name: "가" }, { code: "B", name: "나" }], "A")!, { code: "B", name: "나" });
    returnTo(r);
    expect(seen.mark!.code).toBe("B");
    expect(h.announce).toHaveBeenCalledWith("마지막에 본 종목, 나");
    // 목록 칸 600, 줄 58 이 y=900 에 있으면 900 − (600 − 58) / 2 = 629
    seen.mark!.onViewLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } } } as never);
    const box = r.all().find((n) => n.type === "View" && typeof n.props.onLayout === "function")!;
    expect(box.children.some((c) => typeof c !== "string" && c.type === "Text")).toBe(true);
    (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 900, width: 400, height: 58 } } });
    expect(scrollTo).toHaveBeenCalledWith(629);
    // 체결로 줄 자리가 바뀌어도 다시 스크롤하지 않는다
    (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 1200, width: 400, height: 58 } } });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // 한 번 읽으면 지운다 (다시 돌아와도 또 강조하지 않는다)
    expect(nav.takeLastViewed()).toBeNull();
    r.act(() => vi.advanceTimersByTime(foldDetail.returnMarkMs));
    expect(seen.mark!.code).toBeNull();
    expect(r.all().map((n) => n.type)).toEqual(["Text", "Text"]);
  });

  it("맨 위 근처 줄은 0 아래로 스크롤하지 않는다", () => {
    const { r, seen, scrollTo } = mount();
    nav.rememberNav(nav.navAt("held", [{ code: "A", name: "가" }, { code: "B", name: "나" }], "B")!, { code: "A", name: "가" });
    returnTo(r);
    seen.mark!.onViewLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } } } as never);
    const box = r.all().find((n) => n.type === "View" && typeof n.props.onLayout === "function")!;
    (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 40, width: 400, height: 58 } } });
    expect(scrollTo).toHaveBeenCalledWith(0);
  });
});

describe("잔고 화면에 연결", () => {
  it("‹ › 를 쓰지 않았으면 지금 그대로: 줄은 목록에 바로 놓이고 감싸는 틀이 없다", () => {
    const r = render(<StocksScreen />);
    returnTo(r);
    const list = r.all().find((n) => n.type === "ScrollView" && n.props.stickyHeaderIndices)!;
    for (const code of ["005930", "000660", "035420", "035720"]) expect(parentOf(r, rowOf(r, code))).toBe(list);
  });

  it("‹ › 로 NAVER 까지 보고 돌아오면 NAVER 줄을 테두리로 강조하고 그 줄로 스크롤한다", () => {
    const r = render(<StocksScreen />);
    const list = () => r.all().find((n) => n.type === "ScrollView" && n.props.stickyHeaderIndices)!;
    // 목록의 ref 에 가짜 스크롤을 달아 둔다 (최소 렌더러는 ref 를 채우지 않는다)
    const scrollTo = vi.fn();
    (list().props.ref as { current: unknown }).current = { scrollTo };
    (list().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 704, height: 700 } } });
    browsed();
    returnTo(r);
    const box = parentOf(r, rowOf(r, "035420"));
    expect(box.type).toBe("View");
    expect(parentOf(r, box)).toBe(list());
    // 다른 줄은 그대로
    expect(parentOf(r, rowOf(r, "005930"))).toBe(list());
    const ring = box.children.find((c): c is HostNode => typeof c !== "string" && c.type === "View")!;
    expect(flat(ring)).toMatchObject({ position: "absolute", borderWidth: foldDetail.returnMarkW, borderColor: light.accent });
    expect(ring.props.pointerEvents).toBe("none");
    expect(ring.props.importantForAccessibility).toBe("no-hide-descendants");
    (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 1000, width: 704, height: 58 } } });
    expect(scrollTo).toHaveBeenCalledWith({ y: Math.round(1000 - (700 - 58) / 2), animated: true });
    expect(h.announce).toHaveBeenCalledWith("마지막에 본 종목, NAVER");
    r.act(() => vi.advanceTimersByTime(foldDetail.returnMarkMs));
    expect(parentOf(r, rowOf(r, "035420"))).toBe(list());
  });
});
