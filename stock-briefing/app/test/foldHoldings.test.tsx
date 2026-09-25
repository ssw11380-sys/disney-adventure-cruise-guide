import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

// 이 파일은 왼쪽 세로 탭 막대 배치도 시험한다. 앱 기본은 막대를 쓰지 않으므로(layout.railOn 꺼짐 — 2026-09-26 사용자 선택: 펼쳐도 아래 탭 바)
// 막대를 켠 앱으로 시험한다. 기본값(아래 탭 바)은 test/bottomTabs.test.ts
vi.mock("@/tokens", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/tokens")>();
  return { ...m, layout: { ...m.layout, railOn: true } };
});

/**
 * 잔고 탭 넓은 표 + 공통 틀 (3-42 웨이브 B, 기능 플래그 foldLayout).
 *  - 플래그가 꺼져 있거나(서버 값을 못 받았을 때 포함) 좁은 창(접힌 화면)이면 지금 휴대폰 화면 그대로
 *  - 넓은 창: 탭 화면 머리를 숨기고 맨 위 띠(지수 두 줄 칸 · 시장 상태 · 검색) → 계좌 띠(한 줄/두 줄) → 표 머리 → 44dp 줄
 *  - 세로 탭 막대(펼친 폴드8 가로)는 탭 묶음을 막대 세로 가운데로
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  insets: { top: 24, bottom: 48, left: 0, right: 0 },
  flags: {} as Record<string, boolean | undefined>,
  stocks: undefined as unknown,
  setSort: vi.fn(),
  push: vi.fn(),
  showKrw: false,
  afterCost: false,
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
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", async () => {
  const R = await import("react");
  const Tabs = Object.assign((p: Record<string, unknown>) => R.createElement("Tabs", p), { Screen: "TabsScreen" });
  return { Tabs, router: { push: h.push }, usePathname: () => "/" };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [
    { value: "created", label: "등록순" },
    { value: "changeRate", label: "등락률" },
    { value: "profit", label: "평가손익" },
    { value: "value", label: "평가금액" },
  ],
  useSettings: () => ({ afterCost: h.afterCost, showKrw: h.showKrw, sort: "created", setSort: h.setSort }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks, isError: false, error: null, refetch: async () => undefined, dataUpdatedAt: 1 }),
  useHealth: () => ({ data: undefined }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: vi.fn() } }),
}));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  // 받은 속성(맨 위 top · 내용 여백)을 그대로 남긴다
  const Screen = ({ children, top, contentStyle }: { children: React.ReactNode; top?: React.ReactNode; contentStyle?: unknown }) => R.createElement("Screen", { contentStyle }, R.createElement("Top", null, top), children);
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", ErrorView: "ErrorView", TableHead: "TableHead" }));
vi.mock("@/components/Freshness", () => ({ LiveStatus: "LiveStatus", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: vi.fn() }), useFeedState: () => ({ now: 0, feedOk: true }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip" }));
vi.mock("@/components/Skeleton", () => ({ HoldingsSkeleton: "HoldingsSkeleton" }));
vi.mock("@/components/StockRow", () => ({ StockRow: "StockRow" }));
vi.mock("@/components/StockLine", () => ({ PRICE_HEAD: "현재가·등락률", useLineCols: () => ({ rank: 30, price: 100, right: 108 }) }));
vi.mock("@/components/HoldingsTableHead", () => ({ TableHeadRow: "TableHeadRow" }));
vi.mock("@/components/AccountBand", async (orig) => ({ ...(await orig<typeof import("@/components/AccountBand")>()), AccountBand: "AccountBand" }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { default: TabsLayout } = await import("@/app/(tabs)/_layout");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor, holdingsAnchorMemory } = await import("@/lib/holdingsAnchor");
const { summarize } = await import("@/lib/portfolio");
const { pickCols, pickWatchCols } = await import("@/lib/holdingsColumns");
const { railWidth } = await import("@/lib/windowClass");
const { layout, space, touch } = await import("@/tokens");

const SIZES = {
  "폴드8 접힘": [475, 751],
  "폴드8 펼침 가로": [933, 704],
  "폴드8 펼침 세로": [704, 933],
  "울트라 접힘": [411, 960],
  "울트라 펼침 세로": [859, 954],
  "울트라 펼침 가로": [954, 859],
} as const;
const FOLDED = ["폴드8 접힘", "울트라 접힘"] as const;
const size = (w: number, hh: number, fontScale = 1) => {
  h.win = { width: w, height: hh, scale: 2.625, fontScale };
};

const FX = 1400;
const samsung = holding("005930", quote("005930", 84_300, { change: 1_200, changeRate: 1.44 }), 120, 71_000, undefined, "삼성전자");
const naver = holding("035420", quote("035420", 232_000, { change: 3_000, changeRate: 1.31 }), 15, 200_000, undefined, "NAVER");
const apple = holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: FX }), 30, 180, { costBasisKrw: 7_000_000, krwCostSource: "exact" }, "애플");
const avgo = holding("AVGO", quote("AVGO", 345.2, { currency: "USD", change: 5.9, changeRate: 1.74, fxRate: FX }), null, null, undefined, "브로드컴");
const STOCKS: RegisteredWithQuote[] = [samsung, naver, apple, avgo];

beforeEach(() => {
  size(475, 751);
  h.insets = { top: 24, bottom: 48, left: 0, right: 0 };
  h.flags = { allocationView: true };
  h.stocks = STOCKS;
  h.showKrw = false;
  h.afterCost = false;
  h.setSort.mockReset();
  h.push.mockReset();
  forgetWindowClass();
  forgetHoldingsAnchor();
});

const byType = (r: ReturnType<typeof render>, type: string): HostNode[] => r.all().filter((n) => n.type === type);
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
/** 휴대폰 화면에서 줄에 주던 속성 (이번 변경 전과 같아야 한다) */
const PHONE_ROW_PROPS = ["afterCost", "live", "onLongPress", "onPress", "showKrw", "stock"];

describe("플래그가 꺼져 있으면 어떤 창에서도 지금 휴대폰 화면 그대로", () => {
  it.each(Object.entries(SIZES).flatMap(([n, s]) => [[n, s, undefined], [n, s, false]] as const))("%s (플래그 %s)", (_n, [w, hh], flag) => {
    size(w, hh);
    h.flags = { allocationView: true, foldLayout: flag };
    const r = render(<StocksScreen />);
    // 넓은 표·계좌 띠·맨 위 띠 없음
    expect(byType(r, "TableHeadRow")).toHaveLength(0);
    expect(byType(r, "AccountBand")).toHaveLength(0);
    const strips = byType(r, "MarketStrip");
    expect(strips).toHaveLength(1);
    expect(strips[0]!.props).toEqual({});
    // 줄 속성은 지금과 같은 6개뿐 (위치 재기·열 계획 없음)
    const rows = byType(r, "StockRow");
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(Object.keys(row.props).sort()).toEqual(PHONE_ROW_PROPS);
    // 스크롤 목록에 스크롤·위치 재기를 붙이지 않는다
    const list = byType(r, "ScrollView")[0]!;
    for (const k of ["onScroll", "onScrollBeginDrag", "scrollEventThrottle", "onLayout", "ref"]) expect(list.props).not.toHaveProperty(k);
    // 구역 머리: 휴대폰 표 머리(TableHead), 감싼 View 에 위치 재기 없음
    expect(byType(r, "TableHead")).toHaveLength(2);
    expect(list.children.filter((c) => typeof c !== "string" && c.type === "View" && "onLayout" in c.props)).toHaveLength(0);
    // 맨 위는 끊김 띠만, 내용 여백 없음
    const screen = byType(r, "Screen")[0]!;
    expect(screen.props.contentStyle).toBeUndefined();
    expect(byType(r, "Top")[0]!.children.map((c) => (typeof c === "string" ? c : c.type))).toEqual(["StaleBanner"]);
    // 계좌 패널: 상태 줄에 보유·관심 수 (지금과 같은 말)
    const status = byType(r, "LiveStatus")[0]!;
    expect(status.props.suffix).toBe("보유 3 · 관심 1");
    expect(status.props).not.toHaveProperty("twoLine");
    expect(r.has("비중 보기")).toBe(true);
  });
});

describe("휴대폰 계좌 패널의 환율 안내 (넓은 창 계좌 띠와 같은 함수 fxNote 로 — 문구는 지금 그대로)", () => {
  it("'토스 적용 환율 1,400원 · 원화 손익은 매수 당시 환율 기준'", () => {
    h.flags = { allocationView: true, foldLayout: false };
    const r = render(<StocksScreen />);
    expect(r.text()).toContain("토스 적용 환율 1,400원 · 원화 손익은 매수 당시 환율 기준");
  });
});

describe("켜져 있어도 접힌 화면은 지금과 같은 모양 (접고 펼 때 이어 보기용 위치 재기만 더함)", () => {
  it.each(FOLDED)("%s", (name) => {
    size(...(SIZES[name] as unknown as [number, number]));
    h.flags = { allocationView: true, foldLayout: true };
    const r = render(<StocksScreen />);
    expect(byType(r, "TableHeadRow")).toHaveLength(0);
    expect(byType(r, "AccountBand")).toHaveLength(0);
    expect(byType(r, "MarketStrip")[0]!.props).toEqual({});
    for (const row of byType(r, "StockRow")) {
      expect(Object.keys(row.props).sort()).toEqual([...PHONE_ROW_PROPS, "onLayoutRow"].sort());
      expect(row.props).not.toHaveProperty("columns");
    }
    const list = byType(r, "ScrollView")[0]!;
    expect(list.props.scrollEventThrottle).toBeGreaterThan(0);
    // 목록 칸 높이 재기: 종목 상세 ‹ › 뒤 돌아온 줄을 목록 가운데쯤에 두려고 (웨이브 C). 표 폭 재기는 넓은 창에서만
    expect(typeof list.props.onLayout).toBe("function");
    (list.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 600 } } });
    expect(byType(r, "TableHeadRow")).toHaveLength(0);
    expect(byType(r, "TableHead")).toHaveLength(2);
    expect(byType(r, "LiveStatus")[0]!.props.suffix).toBe("보유 3 · 관심 1");
    expect(byType(r, "LiveStatus")[0]!.props).not.toHaveProperty("twoLine");
    // 이어 보기: 휴대폰 목록 배치 이름
    expect(holdingsAnchorMemory().mode).toBe("list");
  });
});

describe("넓은 창 (플래그 켜짐)", () => {
  const wide = (w: number, hh: number, fontScale = 1) => {
    size(w, hh, fontScale);
    h.flags = { allocationView: true, foldLayout: true };
    return render(<StocksScreen />);
  };

  it("펼친 폴드8 가로: 맨 위 띠(지수 두 줄 칸 + 시장 상태·검색) · 계좌 띠 한 줄 · 숫자 8칸 표", () => {
    const r = wide(933, 704);
    // 맨 위 띠: 탭 화면 머리를 대신하므로 상태 표시줄만큼 내려 그리고, 세로 막대가 왼쪽 여백을 맡는다
    const top = byType(r, "Top")[0]!;
    const strip = byType(r, "MarketStrip")[0]!;
    expect(strip.props.dense).toBe(true);
    expect(top.children.map((c) => (typeof c === "string" ? c : c.type))).toEqual(["View", "StaleBanner"]);
    expect(flat((top.children[0] as HostNode).props.style)).toMatchObject({ paddingTop: 24, paddingLeft: 0, paddingRight: 0 });
    // 검색 버튼: 맨 위 띠 오른쪽 끝, 누르면 종목 검색
    const end = render(strip.props.trailing as React.ReactElement);
    const search = end.byLabel("종목 검색");
    expect(flat(search.props.style)).toMatchObject({ width: 44, minHeight: 44 });
    (search.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/stocks/add");
    // 시장 상태는 보유·관심 수 없이 (표 머리에 있다), 세션 / 실시간·시각 두 줄
    expect(byType(end, "LiveStatus")[0]!.props.suffix).toBe("");
    expect(byType(end, "LiveStatus")[0]!.props.twoLine).toBe(true);
    // 계좌 띠: 한 줄 + 국내·해외 수익률(설계 F8L), 표와 같은 좌우 여백, 비중 버튼
    const band = byType(r, "AccountBand")[0]!;
    expect(band.props).toMatchObject({ oneLine: true, rates: true, pad: space.md });
    expect(typeof band.props.onAllocation).toBe("function");
    // 표 폭 = 창 933 − 세로 막대 80 → 숫자 8칸, 이름 157
    const plan = pickCols(933 - railWidth(1), 1);
    const heads = byType(r, "TableHeadRow");
    expect(heads.map((x) => x.props.title)).toEqual(["보유 3", "관심 1"]);
    expect(heads[0]!.props.plan).toEqual(plan);
    expect(plan.cols).toHaveLength(8);
    expect(plan.nameW).toBe(157);
    // 관심 표는 보유 표와 이름 칸을 맞춘다
    expect(heads[1]!.props.plan).toEqual(pickWatchCols(853, 1, plan.nameW));
    // 휴대폰 표 머리·패널은 없다
    expect(byType(r, "TableHead")).toHaveLength(0);
    expect(r.has("비중 보기")).toBe(false);
  });

  it("줄: 열 계획 · 줄무늬(짝수 줄) · 비중(계좌 총 평가금액 기준, 소수 첫째 자리)", () => {
    const r = wide(933, 704);
    const rows = byType(r, "StockRow");
    const held = rows.slice(0, 3);
    expect(held.map((x) => x.props.zebra)).toEqual([false, true, false]);
    // 모든 보유 줄이 같은 열 계획 객체를 받는다 (체결마다 다시 만들지 않는다)
    expect(new Set(held.map((x) => x.props.columns)).size).toBe(1);
    // 총 평가금액 = 10,116,000 + 3,480,000 + 7,632 × 1,400 = 24,280,800
    const total = 10_116_000 + 3_480_000 + 7_632 * FX;
    expect(held.map((x) => x.props.weight)).toEqual([10_116_000, 3_480_000, 7_632 * FX].map((v) => Math.round((v / total) * 1000) / 10));
    expect(held[0]!.props.weightMax).toBe(Math.max(...(held.map((x) => x.props.weight) as number[])));
    // 관심 줄: 관심 열 계획, 비중 없음 (최대 비중이 바뀌어도 관심 줄은 다시 그리지 않게 비중 값을 넘기지 않는다)
    expect(rows[3]!.props.columns).toEqual(pickWatchCols(853, 1, 157));
    expect(rows[3]!.props).not.toHaveProperty("weight");
    expect(rows[3]!.props).not.toHaveProperty("weightMax");
    for (const row of rows) expect(typeof row.props.onLayoutRow).toBe("function");
  });

  it("표 폭은 표가 실제로 받은 폭으로 다시 계산한다 (재기 전에는 창 폭에서 막대를 뺀 어림)", () => {
    const r = wide(933, 704);
    const list = byType(r, "ScrollView")[0]!;
    r.act(() => (list.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 704, height: 600 } } }));
    expect(byType(r, "TableHeadRow")[0]!.props.plan).toEqual(pickCols(704, 1));
    expect(byType(r, "AccountBand")[0]!.props.oneLine).toBe(false);
  });

  it("창이 바뀌면(접고 펴거나 돌리면) 지난 창에서 잰 표 폭을 버리고 새 창 폭으로 어림한다", () => {
    const r = wide(933, 704);
    const list = byType(r, "ScrollView")[0]!;
    r.act(() => (list.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 840, height: 600 } } }));
    expect(byType(r, "TableHeadRow")[0]!.props.plan).toEqual(pickCols(840, 1));
    // 폰을 세로로 돌림: 704 창 (막대 없음) — 지난 창의 840 이 아니라 704 로 고른다
    forgetWindowClass();
    size(704, 933);
    r.rerender();
    expect(byType(r, "TableHeadRow")[0]!.props.plan).toEqual(pickCols(704, 1));
    expect(byType(r, "AccountBand")[0]!.props.oneLine).toBe(false);
  });

  it("펼친 폴드8 세로(704): 아래 탭 바 그대로, 계좌 띠 두 줄 · 숫자 6칸", () => {
    const r = wide(704, 933);
    expect(byType(r, "AccountBand")[0]!.props.oneLine).toBe(false);
    const plan = byType(r, "TableHeadRow")[0]!.props.plan as ReturnType<typeof pickCols>;
    expect(plan.cols.map((c) => c.key)).toEqual(["price", "rate", "profit", "profitRate", "day", "value"]);
    // 세로 막대가 없으니 왼쪽 화면 여백은 맨 위 띠·표가 맡는다
    h.insets = { top: 24, bottom: 48, left: 16, right: 8 };
    const r2 = render(<StocksScreen />);
    expect(byType(r2, "Screen")[0]!.props.contentStyle).toEqual({ paddingLeft: 16, paddingRight: 8 });
  });

  it("울트라 펼침 세로(859): 계좌 띠 한 줄(국내·해외 수익률까지 들어감) · 숫자 8칸 (막대 없음)", () => {
    const r = wide(859, 954);
    expect(byType(r, "AccountBand")[0]!.props).toMatchObject({ oneLine: true, rates: true });
    expect((byType(r, "TableHeadRow")[0]!.props.plan as ReturnType<typeof pickCols>).cols).toHaveLength(8);
  });

  it("큰 글씨 130%: 열이 넓어져 칸 수가 줄고(펼친 폴드8 가로 6칸 — 설계와 같음), 계좌 띠는 두 줄", () => {
    const r = wide(933, 704, 1.3);
    const plan = byType(r, "TableHeadRow")[0]!.props.plan as ReturnType<typeof pickCols>;
    expect(plan).toEqual(pickCols(933 - railWidth(1.3), 1.3));
    expect(plan.cols).toHaveLength(6);
    expect(byType(r, "AccountBand")[0]!.props.oneLine).toBe(false);
  });

  it("좁은 한 줄 띠(표 폭 800~839, 예: 820 창)는 국내·해외 금액만", () => {
    const r = wide(820, 1000);
    expect(byType(r, "AccountBand")[0]!.props).toMatchObject({ oneLine: true, rates: false });
  });

  it("당일 등락률 기준: 비용 차감이 켜져 있으면 비용 차감 전 평가금액을 띠에 넘긴다 (당일손익과 같은 기준)", () => {
    h.afterCost = true;
    const on = wide(933, 704);
    const g = summarize(STOCKS, false);
    expect((byType(on, "AccountBand")[0]!.props.data as { grossValue: number | null }).grossValue).toBe((g.krw ?? g.byCur.KRW).value);
    h.afterCost = false;
    const off = render(<StocksScreen />);
    expect((byType(off, "AccountBand")[0]!.props.data as { grossValue: number | null }).grossValue).toBeNull();
  });

  it("이어 보기 배치 이름에 탭 막대 위치·열 수를 넣는다: 큰 글씨에서 펼친 폴드8 을 돌려(세로 704 ↔ 가로 933) 띠가 둘 다 두 줄이어도 다시 맞춘다", () => {
    const r = wide(933, 704, 1.3);
    expect(holdingsAnchorMemory().mode).toBe("table-2-rail-6");
    forgetWindowClass();
    size(704, 933, 1.3);
    r.rerender();
    expect(byType(r, "AccountBand")[0]!.props.oneLine).toBe(false);
    expect(holdingsAnchorMemory().mode).toBe(`table-2-bar-${pickCols(704, 1.3).cols.length}`);
    // 100% 에서 울트라 가로(954, 아래 탭)와 폴드8 가로(933, 막대)도 띠·열이 같아도 탭 위치가 달라 다른 이름
    forgetWindowClass();
    size(954, 787, 1);
    r.rerender();
    const ul = holdingsAnchorMemory().mode;
    forgetWindowClass();
    size(933, 632, 1);
    r.rerender();
    expect(holdingsAnchorMemory().mode).not.toBe(ul);
  });

  it("표 머리의 열 이름을 누르면 설정의 정렬 값으로 바꾸고, '등록순 ▾' 는 정렬 창을 연다", () => {
    const r = wide(933, 704);
    const head = byType(r, "TableHeadRow")[0]!;
    (head.props.onSort as (k: string) => void)("profit");
    expect(h.setSort).toHaveBeenCalledWith("profit");
    expect(head.props.sortLabel).toBe("등록순");
    r.act(() => (head.props.onOpenSort as () => void)());
    expect(byType(r, "Modal")[0]!.props.visible).toBe(true);
  });

  it("보유 종목이 없으면(관심만) 계좌 띠 없이 관심 표만", () => {
    h.stocks = [avgo];
    const r = wide(933, 704);
    expect(byType(r, "AccountBand")).toHaveLength(0);
    expect(byType(r, "TableHeadRow").map((x) => x.props.title)).toEqual(["관심 1"]);
  });

  it("불러오는 중·오류에도 맨 위 띠(검색 버튼)는 그대로", () => {
    h.stocks = undefined;
    const r = wide(933, 704);
    expect(byType(r, "HoldingsSkeleton")).toHaveLength(1);
    expect(byType(r, "MarketStrip")[0]!.props.dense).toBe(true);
  });
});

describe("탭 틀: 넓은 창에서 네 탭 모두 머리 숨김 · 세로 막대 탭을 세로 가운데로", () => {
  const screens = () => byType(render(<TabsLayout />), "TabsScreen").map((n) => ({ name: n.props.name as string, o: n.props.options as Record<string, unknown> }));

  it.each(Object.entries(SIZES))("플래그가 꺼져 있으면 %s 도 모든 탭 머리 그대로 · 탭 칸 모양 그대로", (_n, [w, hh]) => {
    size(w, hh);
    h.flags = { foldLayout: false };
    for (const s of screens()) {
      expect(s.o).not.toHaveProperty("headerShown");
      expect(s.o).not.toHaveProperty("tabBarItemStyle");
    }
  });

  it("넓은 창이면 네 탭 모두 머리를 숨긴다 (탭을 오가도 머리가 생겼다 없어졌다 하지 않게 — 검색은 잔고·발견 맨 위 줄 오른쪽 끝으로)", () => {
    h.flags = { foldLayout: true };
    for (const [w, hh] of [SIZES["폴드8 펼침 가로"], SIZES["폴드8 펼침 세로"], SIZES["울트라 펼침 세로"], SIZES["울트라 펼침 가로"]]) {
      forgetWindowClass();
      size(w, hh);
      const s = screens();
      expect(s.map((x) => x.name)).toEqual(["index", "discover", "briefings", "settings"]);
      for (const x of s) expect(x.o.headerShown, `${w}×${hh} ${x.name}`).toBe(false);
    }
    // 접힌 화면은 머리 그대로
    for (const [w, hh] of [SIZES["폴드8 접힘"], SIZES["울트라 접힘"]]) {
      forgetWindowClass();
      size(w, hh);
      for (const x of screens()) expect(x.o).not.toHaveProperty("headerShown");
    }
  });

  it("세로 막대(펼친 폴드8 가로)면 첫 탭 위·마지막 탭 아래를 자동 여백으로 → 탭 4개가 막대 세로 가운데", () => {
    h.flags = { foldLayout: true };
    size(933, 704);
    const s = screens();
    expect(s.map((x) => x.o.tabBarItemStyle)).toEqual([{ marginTop: "auto" }, undefined, undefined, { marginBottom: "auto" }]);
    // 아래 탭 바(펼친 세로)에는 주지 않는다
    forgetWindowClass();
    size(704, 933);
    for (const x of screens()) expect(x.o).not.toHaveProperty("tabBarItemStyle");
  });
});

describe("가운데 모으기(Screen readable)는 주 화면에 쓰지 않는다 (3-42 최종 설계)", () => {
  const SRC = fileURLToPath(new URL("../src/app", import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".tsx") ? [join(dir, n)] : []));
  it("app/ 아래 화면 어디에도 <Screen ... readable> 이 없다", () => {
    const hits = files(SRC).filter((f) => /<Screen\b[^>]*\breadable\b/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it("넓은 표 토큰: 줄 44 · 머리 44(누르는 크기 — 고정 머리라 hitSlop 으로 넓히지 않는다) · 맨 위 띠 48 · 계좌 띠 52", () => {
    expect(layout.rowH).toBeGreaterThanOrEqual(touch.min);
    expect(layout.headH).toBeGreaterThanOrEqual(touch.min);
    expect(layout).toMatchObject({ rowH: 44, headH: 44, stripH: 48, bandH: 52, bandRowH: 48, colGap: 14, nameMinW: 146, nameMinWrapW: 132, bandRatesMin: 840 });
    // 쓰는 곳이 없는 토큰은 두지 않는다 (탭 가운데 정렬은 margin auto)
    expect(layout).not.toHaveProperty("railTabH");
  });
});
