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
  flags: {} as Record<string, boolean | undefined>,
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
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
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
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
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
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
vi.mock("@/components/HoldingsTableHead", () => ({ TableHeadRow: "TableHeadRow" }));
vi.mock("@/components/AccountBand", async (orig) => ({ ...(await orig<typeof import("@/components/AccountBand")>()), AccountBand: "AccountBand" }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { useReturnMark } = await import("@/components/ReturnMark");
const nav = await import("@/lib/holdingsNav");
const { foldDetail, light } = await import("@/tokens");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor, holdingsAnchorMemory } = await import("@/lib/holdingsAnchor");

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
  // ‹ › 는 플래그 foldLayout 이 켜진 넓은 창에만 있다 → 잔고 연결은 플래그가 켜진 상태로 본다 (접힌 화면 475×751)
  h.flags = { foldLayout: true };
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  forgetWindowClass();
  forgetHoldingsAnchor();
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

  it("플래그가 꺼져 있으면 목록에 ref·칸 높이 재기를 붙이지 않는다 (지금 그대로 — ‹ › 도 없어 강조할 줄이 생기지 않는다)", () => {
    h.flags = { foldLayout: false };
    const r = render(<StocksScreen />);
    const list = r.all().find((n) => n.type === "ScrollView" && n.props.stickyHeaderIndices)!;
    expect(list.props).not.toHaveProperty("ref");
    expect(list.props).not.toHaveProperty("onLayout");
  });

  it("펼친 잔고 넓은 표(933×704)에서도 돌아온 줄을 강조하고 스크롤한다 — 감싼 동안 이어 보기 줄 위치는 틀이 알린다", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const r = render(<StocksScreen />);
    const list = () => r.all().find((n) => n.type === "ScrollView" && n.props.stickyHeaderIndices)!;
    // 넓은 표로 그렸는지 (표 머리 · 열 계획)
    expect(r.all().filter((n) => n.type === "TableHeadRow")).toHaveLength(2);
    expect(rowOf(r, "035420").props.columns).toBeTruthy();
    const scrollTo = vi.fn();
    (list().props.ref as { current: unknown }).current = { scrollTo };
    r.act(() => (list().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 853, height: 600 } } }));
    browsed();
    returnTo(r);
    const box = parentOf(r, rowOf(r, "035420"));
    expect(box.type).toBe("View");
    expect(parentOf(r, box)).toBe(list());
    // 넓은 표 줄 그대로 (열 계획·줄무늬) 감싼다
    expect(rowOf(r, "035420").props.columns).toBeTruthy();
    expect(rowOf(r, "035420").props.zebra).toBe(false);
    // 감싼 줄은 틀 안에서 y=0 이라 줄 자신은 위치를 알리지 않고, 틀이 스크롤 내용 기준 위치를 알린다
    expect(rowOf(r, "035420").props).not.toHaveProperty("onLayoutRow");
    expect(typeof rowOf(r, "005930").props.onLayoutRow).toBe("function");
    const head = list().children.find((c): c is HostNode => typeof c !== "string" && c.type === "View" && typeof c.props.onLayout === "function" && c.children.some((k) => typeof k !== "string" && k.type === "TableHeadRow"))!;
    (head.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 500, width: 853, height: 44 } } });
    const rowAt = (code: string, y: number) => (rowOf(r, code).props.onLayoutRow as (s: unknown, y: number, h: number) => void)(rowOf(r, code).props.stock, y, 44);
    rowAt("005930", 544);
    rowAt("000660", 588);
    (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 632, width: 853, height: 44 } } });
    // 스크롤: 목록 칸 600 가운데쯤으로 한 번
    expect(scrollTo).toHaveBeenCalledWith({ y: Math.round(632 - (600 - 44) / 2), animated: true });
    // 이어 보기: NAVER 가 표 머리 바로 아래에 오게 스크롤하면 맨 위 종목은 NAVER (틀 위치가 없으면 SK하이닉스로 잘못 기억)
    (list().props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 588 } } });
    expect(holdingsAnchorMemory().code).toBe("035420");
    // 강조가 끝나면 틀을 벗고 줄이 다시 스스로 위치를 알린다
    r.act(() => vi.advanceTimersByTime(foldDetail.returnMarkMs));
    expect(parentOf(r, rowOf(r, "035420"))).toBe(list());
    expect(typeof rowOf(r, "035420").props.onLayoutRow).toBe("function");
  });
});

describe("돌아온 줄 강조 스크롤과 접고 펴기 이어 보기가 겹칠 때 (‹ › 로 넘겨 본 뒤 접거나 펴고 돌아옴)", () => {
  /**
   * 넓은 표(933×704)에서 맨 위 종목 SK하이닉스를 기억한 채 상세로 가서 ‹ › 로 NAVER 까지 보고, 접은 뒤(475×751) 잔고로 돌아온다.
   * 배치가 바뀌어(넓은 표 → 휴대폰 목록) 이어 보기는 SK하이닉스로 되맞추려 하고, 돌아온 줄 강조는 NAVER 를 가운데로 스크롤하려 한다.
   * 강조 스크롤이 이긴다: 사용자가 가장 최근에 본 종목(NAVER)이 이어 보기가 기억한 맨 위 종목(상세로 가기 전)보다 새롭고,
   * 설계가 '마지막에 본 줄로 스크롤해 강조'다. 강조 스크롤이 움직이면 아직 못 맞춘 되맞추기는 버리고, 그 뒤 스크롤부터 다시 기억한다
   * (useHoldingsAnchor release — 손가락으로 끌기 시작할 때와 같다)
   */
  const LIST_H = 600;
  const setup = () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const r = render(<StocksScreen />);
    const list = () => r.all().find((n) => n.type === "ScrollView" && n.props.stickyHeaderIndices)!;
    const scrollTo = vi.fn();
    (list().props.ref as { current: unknown }).current = { scrollTo };
    r.act(() => (list().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 853, height: LIST_H } } }));
    // 넓은 표: 보유 머리(y 500, 44) 아래 줄 44 씩 → y 544 로 내리면 맨 위 종목은 SK하이닉스
    const heldHead = () => list().children.find((c): c is HostNode => typeof c !== "string" && c.type === "View" && typeof c.props.onLayout === "function")!;
    (heldHead().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 500, width: 853, height: 44 } } });
    const rowAt = (code: string, y: number, hh: number) => (rowOf(r, code).props.onLayoutRow as (s: unknown, y: number, h: number) => void)(rowOf(r, code).props.stock, y, hh);
    rowAt("005930", 544, 44);
    rowAt("000660", 588, 44);
    rowAt("035420", 632, 44);
    (list().props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 544 } } });
    expect(holdingsAnchorMemory().code).toBe("000660");
    // 상세로 가서 ‹ › 로 NAVER 까지 보고, 상세에 있는 동안 접는다 → 잔고로 돌아온다
    browsed();
    h.focused = false;
    r.rerender();
    h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
    r.rerender();
    h.focused = true;
    r.rerender();
    r.act(() => vi.advanceTimersByTime(0));
    // 휴대폰 목록으로 다시 그려졌고(표 머리 없음) NAVER 줄이 강조 틀에 싸였다
    expect(r.all().filter((n) => n.type === "TableHeadRow")).toHaveLength(0);
    const box = parentOf(r, rowOf(r, "035420"));
    expect(box.type).toBe("View");
    expect(box).not.toBe(list());
    scrollTo.mockClear();
    (list().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 475, height: LIST_H } } });
    // 휴대폰 목록: 보유 머리(y 300, 40) 아래 줄 58 씩
    (heldHead().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 300, width: 475, height: 40 } } });
    const markRow = () => (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 456, width: 475, height: 58 } } });
    const markY = Math.round(456 - (LIST_H - 58) / 2);
    return { r, list, scrollTo, rowAt, markRow, markY };
  };

  it("강조 줄이 먼저 자리를 알리면: 강조 스크롤만 하고, 뒤이어 온 이어 보기 줄 자리로 되맞추지 않는다 (강조 스크롤을 덮지 않는다)", () => {
    const { list, scrollTo, rowAt, markRow, markY } = setup();
    rowAt("005930", 340, 58);
    markRow();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: markY, animated: true });
    // 이어 보기가 기다리던 SK하이닉스 줄이 이제 자리를 알린다 — 예전에는 여기서 y 358 로 되맞춰 강조 스크롤을 덮었다
    rowAt("000660", 398, 58);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: markY, animated: true });
    // 강조 스크롤이 움직이는 대로 맨 위 종목을 다시 기억한다 (y 420 → 맨 위는 NAVER)
    (list().props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 420 } } });
    expect(holdingsAnchorMemory().code).toBe("035420");
  });

  it("이어 보기가 먼저 되맞춘 뒤 강조 줄이 자리를 알리면: 강조 스크롤이 마지막이고, 그 뒤 스크롤부터 다시 기억한다", () => {
    const { list, scrollTo, rowAt, markRow, markY } = setup();
    rowAt("005930", 340, 58);
    rowAt("000660", 398, 58);
    // 이어 보기: SK하이닉스가 머리(40) 바로 아래로
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 358, animated: false });
    markRow();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: markY, animated: true });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    // 되맞춘 뒤 멈춰 두던 기억 갱신도 강조 스크롤이 풀었다 → 강조 스크롤 자리로 기억 (예전에는 SK하이닉스에 머물렀다)
    (list().props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 420 } } });
    expect(holdingsAnchorMemory().code).toBe("035420");
  });

  it("‹ › 를 쓰지 않았으면(강조 없음) 접고 펼 때 이어 보기는 지금처럼 되맞춘다", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const r = render(<StocksScreen />);
    const list = () => r.all().find((n) => n.type === "ScrollView" && n.props.stickyHeaderIndices)!;
    const scrollTo = vi.fn();
    (list().props.ref as { current: unknown }).current = { scrollTo };
    const heldHead = () => list().children.find((c): c is HostNode => typeof c !== "string" && c.type === "View" && typeof c.props.onLayout === "function")!;
    (heldHead().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 500, width: 853, height: 44 } } });
    const rowAt = (code: string, y: number, hh: number) => (rowOf(r, code).props.onLayoutRow as (s: unknown, y: number, h: number) => void)(rowOf(r, code).props.stock, y, hh);
    rowAt("005930", 544, 44);
    rowAt("000660", 588, 44);
    (list().props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 544 } } });
    h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
    r.rerender();
    returnTo(r);
    (heldHead().props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 300, width: 475, height: 40 } } });
    rowAt("005930", 340, 58);
    rowAt("000660", 398, 58);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 358, animated: false });
  });
});
