import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { render, type HostNode } from "./miniRender";
import { holding, quote } from "./helpers";

/**
 * 비중 보기 화면과 잔고 탭 '비중' 버튼 (플래그 allocationView).
 * 실제 화면 컴포넌트를 최소 렌더러로 그리고, RN 부품은 문자열 요소로·API 훅은 가짜로 바꿔 끼운다.
 *  - 플래그를 끄면 버튼이 없고, 화면을 열어도 잔고 조회·계산이 0건
 *  - 켜면 원 차트 4장, 원마다 한 문장 요약, 범례 줄마다 한 문장
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  stocks: undefined as unknown,
  stocksCalls: 0,
  push: vi.fn(),
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
  // 잔고 탭의 넓은 창 배치 판단(3-42, 플래그 foldLayout — 여기서는 꺼짐 → 휴대폰 화면)
  useWindowDimensions: () => ({ width: 411, height: 900, scale: 2.625, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Path: "Path" }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  useSettings: () => ({ afterCost: true, showKrw: false, sort: "created", setSort: vi.fn() }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => {
    h.stocksCalls += 1;
    return { data: h.stocks, isError: false, error: null, refetch: async () => undefined };
  },
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
const { default: AllocationScreen } = await import("@/app/portfolio/allocation");

const FX = 1360;
const samsung = holding("005930", quote("005930", 72_000, { industry: "반도체" }), 10, 70_000, undefined, "삼성전자");
const apple = holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: FX, industry: "하드웨어" }), 4, 180, { costBasisKrw: 950_000, krwCostSource: "exact" }, "애플");
const watchOnly = holding("035720", quote("035720", 41_000), null, null, undefined, "카카오");
const noQuote: RegisteredWithQuote = { ...holding("999999", null, 5, 10_000, undefined, "거래정지"), evaluation: null };

const byType = (r: ReturnType<typeof render>, type: string): HostNode[] => r.all().filter((n) => n.type === type);

beforeEach(() => {
  h.flags = {};
  h.stocks = [samsung, apple, watchOnly];
  h.stocksCalls = 0;
  h.push.mockReset();
});

describe("잔고 탭 '비중' 버튼", () => {
  it("플래그가 꺼져 있거나 못 받았으면 버튼이 없다", () => {
    expect(render(<StocksScreen />).has("비중 보기")).toBe(false);
    h.flags = { allocationView: false };
    expect(render(<StocksScreen />).has("비중 보기")).toBe(false);
  });

  it("켜져 있고 보유 종목이 있으면 계좌 평가 패널에 버튼, 누르면 비중 화면", () => {
    h.flags = { allocationView: true };
    const r = render(<StocksScreen />);
    const btn = r.byLabel("비중 보기");
    expect(btn.type).toBe("Button");
    expect(btn.props.title).toBe("비중");
    (btn.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/portfolio/allocation");
  });

  it("켜져 있어도 보유 종목이 없으면(관심만) 계좌 평가 패널과 버튼이 없다", () => {
    h.flags = { allocationView: true };
    h.stocks = [watchOnly];
    expect(render(<StocksScreen />).has("비중 보기")).toBe(false);
  });
});

describe("비중 보기 화면", () => {
  it("플래그가 꺼져 있으면 잔고를 받지도 계산하지도 않고 안내만 (화면 작업 0건)", () => {
    const r = render(<AllocationScreen />);
    expect(h.stocksCalls).toBe(0);
    expect(byType(r, "Svg")).toHaveLength(0);
    expect(byType(r, "Empty")[0]!.props.title).toBe("지금은 비중 보기를 쓸 수 없습니다");
  });

  it("켜져 있으면 원 차트 4장: 원마다 한 문장 요약, 범례 줄마다 한 문장, 총 평가금액은 잔고 탭과 같다", () => {
    h.flags = { allocationView: true };
    const r = render(<AllocationScreen />);
    expect(h.stocksCalls).toBeGreaterThan(0);
    expect(byType(r, "Svg")).toHaveLength(4);
    expect(r.all().filter((n) => n.props.accessibilityRole === "header").map((n) => n.children.join(""))).toEqual(["국내 / 해외", "통화", "업종", "종목별"]);
    // 원: "국내 39.8%, 해외 60.2%"
    const donuts = r.all().filter((n) => n.props.accessibilityRole === "image").map((n) => n.props.accessibilityLabel);
    expect(donuts).toEqual(["국내 39.8%, 해외 60.2%", "원화 39.8%, 달러 60.2%", "하드웨어 60.2%, 반도체 39.8%", "애플 60.2%, 삼성전자 39.8%"]);
    // 범례 한 줄 한 문장 (금액·비중)
    expect(r.has("애플, 1,088,000원, 비중 60.2%")).toBe(true);
    expect(r.has("삼성전자, 720,000원, 비중 39.8%")).toBe(true);
    // 합계 (720,000 + 800달러 × 1,360)
    expect(r.text()).toContain("1,808,000");
    expect(r.all().some((n) => typeof n.props.accessibilityLabel === "string" && n.props.accessibilityLabel.startsWith("총 평가금액 1,808,000원, 비용 차감, 2종목 기준"))).toBe(true);
    // 판단 문구 없음
    expect(r.text()).not.toMatch(/리밸런싱|늘리|줄이|추천|권장/);
  });

  it("원 가운데에는 가장 큰 조각. '기타'가 가장 커도 이름 있는 조각을 보인다", () => {
    h.flags = { allocationView: true };
    h.stocks = Array.from({ length: 30 }, (_, i) => holding(`K${i}`, quote(`K${i}`, 1000, { industry: "반도체" }), 1, 900, undefined, `종목${String(i).padStart(2, "0")}`));
    const r = render(<AllocationScreen />);
    const centers = r.all().filter((n) => n.type === "View" && (JSON.stringify(n.props.style) ?? "").includes('"pointerEvents":"none"'));
    const texts = centers.map((n) => n.children.map((c) => (typeof c === "string" ? c : c.children.join(""))).join(" "));
    expect(texts).toEqual(["국내 100.0%", "원화 100.0%", "반도체 100.0%", "종목00 3.4%"]);
  });

  it("시세 없는 보유 종목은 빼고 알린다", () => {
    h.flags = { allocationView: true };
    h.stocks = [samsung, noQuote];
    const r = render(<AllocationScreen />);
    expect(r.text()).toContain("시세 없는 1종목 제외");
    expect(byType(r, "Svg")).toHaveLength(4);
  });

  it("보유 종목이 없으면 빈 화면 (차트 없음)", () => {
    h.flags = { allocationView: true };
    h.stocks = [watchOnly];
    const r = render(<AllocationScreen />);
    expect(byType(r, "Svg")).toHaveLength(0);
    expect(byType(r, "Empty")[0]!.props.title).toBe("보유 종목이 없습니다");
    h.stocks = [noQuote];
    expect(byType(render(<AllocationScreen />), "Empty")[0]!.props.hint).toBe("시세 없는 1종목 제외");
  });

  it("투자 고지를 붙인다", () => {
    h.flags = { allocationView: true };
    expect(byType(render(<AllocationScreen />), "Screen")[0]!.props.disclaimer).toBe(true);
  });
});
