import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HoldingThemes, HtGroup, RegisteredWithQuote } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";
import { holding, quote } from "./helpers";

/**
 * 3-35 내 종목 테마 (플래그 holdingThemes, 앱 fallback 꺼짐) — 잔고 탭 '테마' 버튼과 '내 종목 테마' 화면.
 *  - 끄면: 버튼이 없고 계좌 패널·구역 머리·넓은 띠가 지금과 같은 모양, 화면을 열어도 요청 0건
 *  - 켜면: 보통 모드 계좌 패널 '비중' 오른쪽 '테마', 촘촘 모드 보유 구역 머리 '테마', 넓은 창 계좌 띠 onThemes
 *  - 화면: 많이 속한 테마 한 줄 · 칩 · 상태 줄 · 높은/낮은 3개 · 전체 · 연결 못 한 종목 · 기준 · 고지, 폭 933 은 두 칸
 * 실제 화면 컴포넌트를 최소 렌더러로 그리고 RN 부품은 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  density: undefined as string | undefined,
  stocks: undefined as unknown,
  themes: undefined as unknown,
  themesError: false,
  themesCalls: [] as boolean[],
  push: vi.fn(),
  storeFails: false,
  store: new Map<string, string>(),
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
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (h.storeFails) throw new Error("저장소 없음");
      return h.store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      if (h.storeFails) throw new Error("저장소 없음");
      h.store.set(k, v);
    },
  },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, navigate: vi.fn(), dismissTo: vi.fn(), back: vi.fn(), canGoBack: () => false, canDismiss: () => false }, usePathname: () => "/" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  useSettings: () => ({ afterCost: false, showKrw: false, sort: "created", setSort: vi.fn(), density: h.density }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks, isError: false, error: null, refetch: async () => undefined, dataUpdatedAt: 1 }),
  useHealth: () => ({ data: undefined }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: vi.fn() } }),
  useHoldingThemes: (enabled: boolean) => {
    h.themesCalls.push(enabled);
    return { data: enabled ? h.themes : undefined, isError: h.themesError, error: h.themesError ? new Error("x") : null, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1 };
  },
}));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  const Screen = ({ children, top, disclaimer }: { children: React.ReactNode; top?: React.ReactNode; disclaimer?: boolean }) => R.createElement("Screen", { disclaimer }, R.createElement("Top", null, top), children);
  return { Screen, Disclaimer: "Disclaimer" };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", ErrorView: "ErrorView", TableHead: "TableHead", Chip: "Chip", Empty: "Empty", Loading: "Loading" }));
vi.mock("@/components/Freshness", () => ({ LiveStatus: "LiveStatus", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: 0, feedOk: true }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip" }));
vi.mock("@/components/Skeleton", () => ({ HoldingsSkeleton: "HoldingsSkeleton" }));
vi.mock("@/components/StockRow", () => ({ StockRow: "StockRow" }));
vi.mock("@/components/SwipeRow", () => ({ SwipeRow: "SwipeRow", closeOpenRow: () => false }));
vi.mock("@/components/TossImportButton", () => ({ TossImportButton: "TossImportButton" }));
vi.mock("@/components/StockLine", () => ({ PRICE_HEAD: "현재가", useLineCols: () => ({ rank: 30, price: 100, right: 108 }) }));
vi.mock("@/components/HoldingsTableHead", () => ({ TableHeadRow: "TableHeadRow" }));
vi.mock("@/components/AccountBand", async (orig) => ({ ...(await orig<typeof import("@/components/AccountBand")>()), AccountBand: "AccountBand" }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { default: ThemesScreen } = await import("@/app/portfolio/themes");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor } = await import("@/lib/holdingsAnchor");
const { dark } = await import("@/tokens");

const samsung = holding("005930", quote("005930", 72_000, { industry: "반도체" }), 10, 70_000, undefined, "삼성전자");
const apple = holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: 1360 }), 4, 180, { costBasisKrw: 950_000, krwCostSource: "exact" }, "애플");
const watchOnly = holding("035720", quote("035720", 41_000), null, null, undefined, "카카오");
const STOCKS: RegisteredWithQuote[] = [samsung, apple, watchOnly];

const tv = (over: Partial<HtGroup["tradingValue"]> = {}): HtGroup["tradingValue"] => ({ today: 1, avg: 1, days: 12, ratioPct: 182, state: "final", day: "2026-09-28", currency: "USD", ...over });
const G = (key: string, name: string, rate: number, over: Partial<HtGroup> = {}): HtGroup => ({
  key,
  market: key.startsWith("KR") ? "KR" : "US",
  kind: key.includes(":sector:") ? "sector" : "theme",
  id: key.split(":")[2]!,
  name,
  day: { changeRate: rate, up: 3, flat: 0, down: 1 },
  week: { changeRate: rate / 2, up: null, flat: null, down: null },
  tradingValue: tv(),
  inDiscoverList: true,
  holdings: [{ code: "AAPL", name: "애플", via: null, changeRate: -0.2, inCalc: true }],
  ...over,
});
const THEMES: HoldingThemes = {
  enabled: true,
  asOf: "2026-09-29T11:00:00+09:00",
  markets: {
    US: { session: "closed", marketOpen: false, asOf: "2026-09-29T05:00:00+09:00", tvDay: "2026-09-28", preparing: false, note: null, weekNote: "1주는 상승·하락 종목 수 없이 등락률만", heldValue: 1_088_000 },
    KR: { session: "regular", marketOpen: true, asOf: "2026-09-29T11:00:00+09:00", tvDay: "2026-09-29", preparing: false, note: null, weekNote: null, heldValue: 720_000 },
  },
  coverage: { held: 3, mapped: 2, unmapped: [{ code: "QQQ", name: "QQQ", market: "US", reason: "index", text: "QQQ · 나스닥100 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다" }] },
  mostHeld: [{ key: "US:theme:203", name: "스마트폰제조", count: 1, codes: ["AAPL"] }],
  groups: [
    G("US:theme:203", "스마트폰제조", -0.3),
    G("US:theme:209", "컴퓨터와 주변기기", 1.5),
    G("US:theme:1", "테마1", 3),
    G("US:theme:2", "테마2", 2),
    G("US:theme:3", "테마3", -1),
    G("US:theme:4", "테마4", -2),
    G("KR:theme:543", "HBM(고대역폭메모리)", -4.12, { holdings: [{ code: "005930", name: "삼성전자", via: null, changeRate: -5, inCalc: null }], tradingValue: tv({ state: "partial", ratioPct: 62, currency: "KRW" }) }),
  ],
  byHolding: [
    { code: "AAPL", name: "애플", market: "US", keys: ["US:theme:203", "US:theme:209"] },
    { code: "005930", name: "삼성전자", market: "KR", keys: ["KR:theme:543"] },
  ],
  basis: ["기준: 등락률과 오른·내린 종목 수는 발견 탭과 같은 값입니다.", "한국 테마 구성은 주 1회 받은 목록입니다 (마지막: 9월 27일 (일) 05:40)."],
  krIndexAt: "9월 27일 (일) 05:40",
  disclaimer: "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.",
};

type R = ReturnType<typeof render>;
const byType = (r: R, type: string): HostNode[] => r.all().filter((n) => n.type === type);
const textIn = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textIn).join(""));
const treeText = (tree: unknown) => JSON.stringify(tree, (_k, v) => (typeof v === "function" ? undefined : v));
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const drawTab = (): R => {
  forgetWindowClass();
  forgetHoldingsAnchor();
  return render(<StocksScreen />);
};
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { allocationView: true };
  h.density = undefined;
  h.stocks = STOCKS;
  h.themes = THEMES;
  h.themesError = false;
  h.themesCalls = [];
  h.push.mockReset();
  h.storeFails = false;
  h.store.clear();
});

describe("잔고 탭 '테마' 버튼", () => {
  it("끔(없음·false): 버튼이 없고 계좌 패널 버튼 칸은 '비중' 하나 그대로 · 그림 트리가 같다", () => {
    const none = drawTab();
    expect(none.has("내 종목 테마 보기")).toBe(false);
    const btn = byType(none, "Button").find((b) => b.props.accessibilityLabel === "비중 보기")!;
    const box = none.all().find((n) => n.children.includes(btn))!;
    expect(box.children).toHaveLength(1);
    expect(flat(box.props.style)).toEqual({ flexDirection: "row", justifyContent: "flex-end", marginTop: 4 });
    h.flags = { allocationView: true, holdingThemes: false };
    expect(treeText(drawTab().tree)).toBe(treeText(none.tree));
  });

  it("켬: '비중' 오른쪽에 같은 모양 '테마'(작은 보조 버튼) · 누르면 내 종목 테마 화면 · 두 버튼 칸은 줄이 모자라면 다음 줄로", () => {
    h.flags = { allocationView: true, holdingThemes: true };
    const r = drawTab();
    const btn = r.byLabel("내 종목 테마 보기");
    expect(btn.type).toBe("Button");
    expect(btn.props).toMatchObject({ title: "테마", icon: "pricetags-outline", variant: "secondary", compact: true });
    const box = r.all().find((n) => n.children.includes(btn))!;
    expect(box.children.map((c) => (c as HostNode).props.accessibilityLabel)).toEqual(["비중 보기", "내 종목 테마 보기"]);
    expect(flat(box.props.style)).toMatchObject({ flexWrap: "wrap" });
    (btn.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/portfolio/themes");
  });

  it("비중 보기가 꺼져 있고 이 기능만 켜져 있으면 '테마' 버튼만", () => {
    h.flags = { holdingThemes: true };
    const r = drawTab();
    expect(r.has("비중 보기")).toBe(false);
    expect(r.byLabel("내 종목 테마 보기").props.title).toBe("테마");
  });

  it("보유 종목이 없으면(관심만) 버튼이 없다", () => {
    h.flags = { allocationView: true, holdingThemes: true };
    h.stocks = [watchOnly];
    expect(drawTab().has("내 종목 테마 보기")).toBe(false);
  });

  it("촘촘 모드: 보유 구역 머리의 '비중' 옆 '테마' 글자 버튼 (높이 44 · 위아래 hitSlop 0)", () => {
    h.flags = { allocationView: true, holdingThemes: true, densityMode: true };
    h.density = "dense";
    const r = drawTab();
    const p = r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityLabel === "내 종목 테마 보기");
    expect(p).toHaveLength(1);
    expect(textIn(p[0]!)).toBe("테마");
    expect(p[0]!.props.hitSlop).toMatchObject({ top: 0, bottom: 0 });
    expect(flat(p[0]!.props.style)).toMatchObject({ minHeight: 44 });
    // 계좌 패널 안에는 없다 (구역 머리로 옮김)
    expect(byType(r, "Button").filter((b) => b.props.accessibilityLabel === "내 종목 테마 보기")).toHaveLength(0);
  });

  it("넓은 창(933×704, foldLayout): 계좌 띠에 onThemes — 끄면 속성 자체가 없다", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { allocationView: true, foldLayout: true };
    expect(byType(drawTab(), "AccountBand")[0]!.props).not.toHaveProperty("onThemes");
    h.flags = { allocationView: true, foldLayout: true, holdingThemes: true };
    expect(typeof byType(drawTab(), "AccountBand")[0]!.props.onThemes).toBe("function");
  });
});

describe("'내 종목 테마' 화면", () => {
  it("끔: 요청하지 않고 안내만 (화면 작업 0건)", () => {
    const r = render(<ThemesScreen />);
    expect(h.themesCalls).toEqual([]);
    expect(byType(r, "Empty")[0]!.props.title).toBe("이 기능은 지금 꺼져 있습니다");
  });

  it("켬 (폰 475): 많이 속한 테마 한 줄 → 칩 → 상태 줄 → 높은/낮은 3개 → 전체 → 연결 못 한 종목 → 종목별로 보기 → 기준 · 고지", async () => {
    h.flags = { holdingThemes: true };
    const r = render(<ThemesScreen />);
    await settle(r);
    expect(h.themesCalls.every((x) => x)).toBe(true);
    const screen = byType(r, "Screen")[0]!;
    expect(screen.props.disclaimer).toBe(true);
    // 많이 속한 테마: 제목은 머리(header)만, 조각은 버튼으로 따로 — 묶음 문장으로 한 번 더 읽지 않는다 (중복 읽기 없음)
    expect(r.has("내 종목이 많이 속한 테마, 스마트폰제조 1종목. 보유 3종목 중 2종목 연결")).toBe(false);
    expect(r.byLabel("스마트폰제조 1종목, 그 테마 줄로 이동").type).toBe("Pressable");
    // 칩: 시장(미국 6 · 한국 1) · 기간(오늘 · 1주). 처음 시장은 원화 보유액이 큰 미국
    const chips = byType(r, "Chip").map((c) => [c.props.label, c.props.active]);
    expect(chips).toEqual([
      ["미국 6", true],
      ["한국 1", false],
      ["오늘", true],
      ["1주", false],
    ]);
    // 기간 칩은 글자가 짧아도 누르는 폭 44 이상 (공용 Chip 의 wideTouch — 3-33 수급 탭과 같은 속성)
    expect(byType(r, "Chip").filter((c) => c.props.wideTouch).map((c) => c.props.label)).toEqual(["오늘", "1주"]);
    const headers = r.all().filter((n) => n.props.accessibilityRole === "header").map(textIn);
    expect(headers).toEqual(["내 종목이 많이 속한 테마", "등락률 높은 3개", "등락률 낮은 3개", "내 테마 6개 · 등락률 높은 순", "연결하지 못한 종목 1"]);
    const text = textIn(screen);
    // 미국 장 마감: 기준 거래일(뉴욕 날짜)을 밝히고 한국 시각은 따로 (거래대금 줄 날짜와 두 날짜로 보이지 않게)
    expect(text).toContain("장 마감 · 미국 9/28(월) 정규장 기준 · 한국 시각 9월 29일 (화) 05:00");
    expect(text).toContain("QQQ · 나스닥100 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다");
    expect(text).toContain("한국 테마 구성은 주 1회 받은 목록입니다");
    // 줄: 누르면 발견 탭 상세, 한 줄 한 문장, 누르는 높이 44 이상
    const rows = r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").endsWith("누르면 발견 탭 테마 상세"));
    expect(rows).toHaveLength(12); // 높은 3 + 낮은 3 + 전체 6
    for (const row of rows) expect(flat((row.props.style as (a: { pressed: boolean }) => unknown)({ pressed: false })).minHeight).toBeGreaterThanOrEqual(44);
    (rows[0]!.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/discover/theme/1?market=US&kind=theme&name=%ED%85%8C%EB%A7%881&period=day&rate=3");
    // 색은 등락률 글자에만: 거래대금 줄은 기본 흐린 색
    const tvLine = r.all().find((n) => n.type === "Text" && textIn(n) === "거래대금 평소의 182%")!;
    expect(flat(tvLine.props.style).color).toBe(dark.muted);
  });

  it("칩: 한국 · 1주로 바꾸면 그 시장 목록과 1주 안내, 고른 칩은 기기에 기억", async () => {
    h.flags = { holdingThemes: true };
    const r = render(<ThemesScreen />);
    await settle(r);
    (byType(r, "Chip").find((c) => c.props.label === "한국 1")!.props.onPress as () => void)();
    (byType(r, "Chip").find((c) => c.props.label === "1주")!.props.onPress as () => void)();
    await settle(r);
    const headers = r.all().filter((n) => n.props.accessibilityRole === "header").map(textIn);
    expect(headers).toContain("내 테마 1개 · 등락률 높은 순");
    expect(headers).not.toContain("등락률 높은 3개");
    expect(JSON.parse(h.store.get("holdingThemes.chips.v1")!)).toEqual({ market: "KR", period: "week" });
    // 1주에는 거래대금 줄이 없다
    expect(r.all().some((n) => n.type === "Text" && textIn(n).startsWith("거래대금"))).toBe(false);
  });

  it("기기 저장소를 쓸 수 없어도(throw) 기본값으로 그대로 그린다", async () => {
    h.flags = { holdingThemes: true };
    h.storeFails = true;
    const r = render(<ThemesScreen />);
    await settle(r);
    expect(byType(r, "Chip").find((c) => c.props.label === "미국 6")!.props.active).toBe(true);
    (byType(r, "Chip").find((c) => c.props.label === "1주")!.props.onPress as () => void)();
    await settle(r);
    expect(byType(r, "Chip").find((c) => c.props.label === "1주")!.props.active).toBe(true);
  });

  it("빈 화면·오류·서버가 모름(404 → null)", () => {
    h.flags = { holdingThemes: true };
    h.themes = { ...THEMES, coverage: { held: 0, mapped: 0, unmapped: [] }, groups: [], mostHeld: [], byHolding: [] };
    expect(byType(render(<ThemesScreen />), "Empty")[0]!.props).toMatchObject({ title: "보유 종목이 없습니다", hint: "종목을 사면(또는 보유 수량을 넣으면) 그 종목이 속한 테마를 보여 드립니다." });
    h.themes = undefined;
    h.themesError = true;
    expect(byType(render(<ThemesScreen />), "Empty")[0]!.props).toMatchObject({ title: "내 종목 테마를 불러오지 못했습니다", hint: "연결을 확인하고 다시 시도하세요." });
    h.themesError = false;
    h.themes = null;
    expect(byType(render(<ThemesScreen />), "Empty")[0]!.props.title).toBe("이 기능은 지금 꺼져 있습니다");
  });

  it("첫 준비 중이면 맨 위 알림 줄", () => {
    h.flags = { holdingThemes: true };
    h.themes = { ...THEMES, markets: { ...THEMES.markets, KR: { ...THEMES.markets.KR!, preparing: true } } };
    expect(textIn(byType(render(<ThemesScreen />), "Screen")[0]!)).toContain("테마 목록을 처음 준비하는 중입니다 (약 2분). 준비된 시장부터 보여 드립니다.");
  });

  it("넓은 창 933×704 (foldLayout): 왼쪽 칸(요약·칩·높은/낮은 3개)과 오른쪽 칸(전체 이하)이 따로 스크롤 · 고지는 맨 아래 한 번", async () => {
    h.flags = { holdingThemes: true, foldLayout: true };
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const r = render(<ThemesScreen />);
    await settle(r);
    const scrolls = byType(r, "ScrollView");
    expect(scrolls).toHaveLength(2);
    expect(textIn(scrolls[0]!)).toContain("등락률 높은 3개");
    expect(textIn(scrolls[0]!)).not.toContain("내 테마 6개");
    expect(textIn(scrolls[1]!)).toContain("내 테마 6개 · 등락률 높은 순");
    expect(byType(r, "Disclaimer")).toHaveLength(1);
  });

  it("펼친 세로 704×933: 한 단, 높은/낮은 3개만 두 칸 나란히 (칸 최소 300)", async () => {
    h.flags = { holdingThemes: true, foldLayout: true };
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const r = render(<ThemesScreen />);
    await settle(r);
    expect(byType(r, "ScrollView")).toHaveLength(0); // Screen(가짜) 한 단
    const pair = r.all().find((n) => n.type === "View" && flat(n.props.style).flexDirection === "row" && flat(n.props.style).flexWrap === "wrap" && n.children.length === 2 && textIn(n).includes("등락률 낮은 3개"))!;
    expect(pair).toBeTruthy();
    for (const cell of pair.children as HostNode[]) expect(flat(cell.props.style)).toMatchObject({ flexBasis: 300 });
  });
});

describe("리뷰 반영 (3-35 검증)", () => {
  const manyUs = (n: number): HtGroup[] => Array.from({ length: n }, (_, i) => G(`US:theme:${100 + i}`, `테마${String(100 + i)}`, 10 - i));

  it("촘촘 모드: 보유 구역 머리에 버튼 셋이면 줄이 모자랄 때 버튼 묶음이 다음 줄 오른쪽으로 (제목은 끊지 않음) · 관심 구역 머리·끈 상태는 그대로", () => {
    h.flags = { allocationView: true, densityMode: true };
    h.density = "dense";
    const none = drawTab();
    h.flags = { allocationView: true, densityMode: true, holdingThemes: false };
    expect(treeText(drawTab().tree)).toBe(treeText(none.tree));
    h.flags = { allocationView: true, densityMode: true, holdingThemes: true };
    const r = drawTab();
    const titles = r.all().filter((n) => n.type === "Text" && n.props.accessibilityRole === "header");
    const held = titles.find((n) => textIn(n).startsWith("보유"))!;
    const bar = r.all().find((n) => n.children.includes(held))!;
    expect(flat(bar.props.style)).toMatchObject({ flexWrap: "wrap", minHeight: 44 });
    expect(flat(held.props.style)).toMatchObject({ flexShrink: 0 });
    const end = bar.children.find((c) => typeof c !== "string" && c !== held) as HostNode;
    expect(flat(end.props.style)).toMatchObject({ flexWrap: "wrap", justifyContent: "flex-end", marginLeft: "auto" });
    // 관심 구역 머리는 버튼이 정렬 하나라 그대로
    const watch = titles.find((n) => textIn(n).startsWith("관심"));
    if (watch) expect(flat(r.all().find((n) => n.children.includes(watch))!.props.style)).not.toHaveProperty("flexWrap");
  });

  it("1주 칩: 내 종목 줄 머리가 '내 종목 (오늘)' (테마는 1주, 내 종목은 오늘 등락률)", async () => {
    h.flags = { holdingThemes: true };
    const r = render(<ThemesScreen />);
    await settle(r);
    expect(r.all().some((n) => n.type === "Text" && textIn(n) === "내 종목")).toBe(true);
    (byType(r, "Chip").find((c) => c.props.label === "1주")!.props.onPress as () => void)();
    await settle(r);
    expect(r.all().some((n) => n.type === "Text" && textIn(n) === "내 종목")).toBe(false);
    expect(r.all().filter((n) => n.type === "Text" && textIn(n) === "내 종목 (오늘)").length).toBeGreaterThan(0);
    const row = r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith("테마1,"))!;
    expect(String(row.props.accessibilityLabel)).toContain("1주 1.50% 상승");
    expect(String(row.props.accessibilityLabel)).toContain("내 종목 오늘 등락률 애플, 0.20% 하락");
  });

  it("거래정지 내 종목(설계 E10)은 '거래정지'", async () => {
    h.flags = { holdingThemes: true };
    h.themes = { ...THEMES, groups: THEMES.groups.map((g) => (g.key === "KR:theme:543" ? { ...g, holdings: [{ code: "010140", name: "삼성중공업", via: null, changeRate: null, inCalc: null, halted: true }] } : g)) };
    const r = render(<ThemesScreen />);
    await settle(r);
    (byType(r, "Chip").find((c) => c.props.label === "한국 1")!.props.onPress as () => void)();
    await settle(r);
    expect(r.all().some((n) => n.type === "Text" && textIn(n).startsWith("삼성중공업 거래정지"))).toBe(true);
    expect(textIn(byType(r, "Screen")[0]!)).not.toContain("시세 없음");
  });

  it("연결한 종목이 0 이면: 카드 제목·칩 없이 한 줄 안내 + 연결하지 못한 종목", () => {
    h.flags = { holdingThemes: true };
    h.themes = { ...THEMES, coverage: { held: 2, mapped: 0, unmapped: [THEMES.coverage.unmapped[0]!, { code: "069500", name: "KODEX 200", market: "KR", reason: "index", text: "KODEX 200 · 코스피200 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다" }] }, groups: [], mostHeld: [], byHolding: [] };
    const r = render(<ThemesScreen />);
    expect(byType(r, "Chip")).toHaveLength(0);
    const text = textIn(byType(r, "Screen")[0]!);
    expect(text).toContain("보유 2종목 중 테마·업종에 연결한 종목이 없습니다");
    expect(text).not.toContain("내 종목이 많이 속한 테마");
    expect(text).toContain("KODEX 200 · 코스피200 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다");
    expect(r.all().filter((n) => n.props.accessibilityRole === "header").map(textIn)).toEqual(["연결하지 못한 종목 2"]);
  });

  it("내 테마가 12개를 넘으면 앞 10개 + '나머지 N개 더 보기' — 누르면 모두, 많이 속한 테마 조각으로 가면 펼친다", async () => {
    h.flags = { holdingThemes: true };
    h.themes = { ...THEMES, groups: manyUs(15), mostHeld: [{ key: "US:theme:114", name: "테마114", count: 2, codes: ["AAPL"] }], byHolding: [] };
    const r = render(<ThemesScreen />);
    await settle(r);
    const allRows = () => r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").endsWith("누르면 발견 탭 테마 상세")).length;
    expect(allRows()).toBe(6 + 10); // 높은 3 + 낮은 3 + 전체 앞 10
    const more = r.byLabel("나머지 5개 더 보기");
    expect(flat(more.props.style).minHeight).toBeGreaterThanOrEqual(44);
    (more.props.onPress as () => void)();
    await settle(r);
    expect(allRows()).toBe(6 + 15);
    expect(r.has("나머지 5개 더 보기")).toBe(false);
    // 다시 그려 접힌 채에서 조각을 누르면 펼친다
    cleanupRenders();
    const r2 = render(<ThemesScreen />);
    await settle(r2);
    (r2.byLabel("테마114 2종목, 그 테마 줄로 이동").props.onPress as () => void)();
    await settle(r2);
    expect(r2.has("나머지 5개 더 보기")).toBe(false);
  });

  it("많이 속한 테마 조각: 긴 이름도 칸 폭 안에서 줄바꿈 (flexShrink · maxWidth 100%)", async () => {
    h.flags = { holdingThemes: true };
    h.themes = { ...THEMES, mostHeld: [{ key: "KR:theme:543", name: "밸류업(24년 기업가치 제고계획 발표)", count: 6, codes: ["005930"] }] };
    const r = render(<ThemesScreen />);
    await settle(r);
    const part = r.byLabel("밸류업(24년 기업가치 제고계획 발표) 6종목, 그 테마 줄로 이동");
    expect(flat(part.props.style)).toMatchObject({ flexShrink: 1, maxWidth: "100%" });
    expect(flat((part.children[0] as HostNode).props.style)).toMatchObject({ flexShrink: 1 });
  });

  it("종목별로 보기: 펼침 상태는 accessibilityState 로만 · 한 종목 한 문장", async () => {
    h.flags = { holdingThemes: true };
    const r = render(<ThemesScreen />);
    await settle(r);
    const toggle = r.byLabel("종목별로 보기");
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    (toggle.props.onPress as () => void)();
    await settle(r);
    expect(r.byLabel("종목별로 보기").props.accessibilityState).toEqual({ expanded: true });
    const rows = r.all().filter((n) => n.type === "View" && n.props.accessible === true && String(n.props.accessibilityLabel ?? "").includes("등락률 높은 순"));
    expect(rows.map((n) => n.props.accessibilityLabel)).toEqual([
      "애플, 미국 테마 2개, 오늘 등락률 높은 순, 컴퓨터와 주변기기 1.50퍼센트 상승, 스마트폰제조 0.30퍼센트 하락",
      "삼성전자, 한국 테마 1개, 오늘 등락률 높은 순, HBM(고대역폭메모리) 4.12퍼센트 하락",
    ]);
  });

  it("넓은 창 두 칸: 두 칸 모두 당겨서 새로고침 · 왼쪽 칸은 글자 배율만큼 넓힌다 (100% 340 → 200% 408)", async () => {
    h.flags = { holdingThemes: true, foldLayout: true };
    for (const [fs, w] of [
      [1, 340],
      [2, 408],
    ] as const) {
      h.win = { width: 933, height: 704, scale: 2.625, fontScale: fs };
      forgetWindowClass();
      cleanupRenders();
      const r = render(<ThemesScreen />);
      await settle(r);
      const scrolls = byType(r, "ScrollView");
      expect(scrolls).toHaveLength(2);
      for (const s of scrolls) expect((s.props.refreshControl as { type: unknown } | undefined)?.type).toBe("RefreshControl");
      expect(flat(scrolls[0]!.props.style).width).toBe(w);
    }
  });

  it("펼친 세로 704×933 · 글자 200%: 높은/낮은 3개 칸 최소 폭도 배율만큼 (600 — 두 칸이 안 들어가 위아래)", async () => {
    h.flags = { holdingThemes: true, foldLayout: true };
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 2 };
    forgetWindowClass();
    const r = render(<ThemesScreen />);
    await settle(r);
    const pair = r.all().find((n) => n.type === "View" && flat(n.props.style).flexWrap === "wrap" && n.children.length === 2 && textIn(n).includes("등락률 낮은 3개"))!;
    for (const cell of pair.children as HostNode[]) expect(flat(cell.props.style)).toMatchObject({ flexBasis: 600 });
  });
});
