import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoverRank, ThemeList } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 빈 화면 안내 (3-24, 기능 플래그 emptyGuide): 발견(순위·테마) · 브리핑(종목 없음·브리핑 없음) · 비중(보유 없음)의 빈 상태에
 * 무엇을 하면 되는지 한 문장 + 행동 버튼 정확히 하나. 꺼져 있으면 지금 안내 그대로(버튼 없음). 잔고·관심은 test/oneHandHoldings, 설정은 test/emptyGuideSettings
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  rank: [] as unknown[],
  themes: [] as unknown[],
  latest: [] as unknown[] | undefined,
  stocks: [] as unknown[] | undefined,
  push: vi.fn(),
  back: vi.fn(),
  dismissTo: vi.fn(),
  alert: vi.fn(),
  refetch: vi.fn(async () => undefined),
}));

vi.mock("react-native", async () => {
  const R = await import("react");
  type P = Record<string, unknown>;
  const el = (c: unknown) => (c === null || c === undefined ? null : R.isValidElement(c) ? c : R.createElement(c as React.ComponentType));
  const FlatList = (p: P) => {
    const { data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent, ...rest } = p as P & { data: unknown[]; renderItem: (a: { item: unknown; index: number }) => React.ReactNode };
    return R.createElement("FlatList", rest, el(ListHeaderComponent), ...(data.length ? data.map((item, index) => R.createElement(R.Fragment, { key: index }, renderItem({ item, index }))) : [el(ListEmptyComponent)]), el(ListFooterComponent));
  };
  class Value {
    constructor(public v: number) {}
    setValue() {}
  }
  const anim = () => ({ start() {}, stop() {} });
  return {
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    RefreshControl: "RefreshControl",
    ActivityIndicator: "ActivityIndicator",
    FlatList,
    Animated: { View: "AnimatedView", Value, timing: anim, loop: anim, sequence: anim },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
    Alert: { alert: h.alert },
    Linking: { openURL: vi.fn() },
    Platform: { OS: "android" },
    useWindowDimensions: () => ({ width: 475, height: 751, scale: 2.625, fontScale: 1 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Path: "Path" }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({
  router: { push: h.push, back: h.back, dismissTo: h.dismissTo, navigate: vi.fn(), canGoBack: () => true },
  Tabs: { Screen: "TabsScreen" },
  Stack: { Screen: "StackScreen" },
  useLocalSearchParams: () => ({}),
  usePathname: () => "/",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" }) }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/components/Screen", async () => ({ Screen: "Screen", DISCLAIMER: (await import("@/lib/disclaimer")).DISCLAIMER }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: h.refetch }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/ui", async () => {
  const R = await import("react");
  return {
    Badge: "Badge",
    Button: "Button",
    Card: "Card",
    ChangeText: "ChangeText",
    Chip: "Chip",
    // 빈 상태: 제목·안내·행동(버튼)을 그대로 그린다 (버튼 수를 센다)
    Empty: ({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) => R.createElement("Empty", { title, hint }, action ?? null),
    ErrorView: "ErrorView",
    Loading: "Loading",
    Muted: "Muted",
    RateBox: "RateBox",
    Row: "Row",
    SectionTitle: "SectionTitle",
    Segmented: "Segmented",
    TableHead: "TableHead",
  };
});
const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, isFetching: false, isSuccess: data !== undefined, isPlaceholderData: false, refetch: h.refetch, dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
vi.mock("@/api/hooks", () => ({
  AUTO_REFRESH_MAX_PAGES: 3,
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
  useStocks: () => ok(h.stocks),
  useRegisteredStocks: () => ok(h.stocks),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
  useDiscoverRank: (market: "KR" | "US", category: DiscoverRank["category"]) => ({
    ...ok({ pages: [{ market, category, items: h.rank, page: 1, hasMore: false, marketOpen: false, session: "closed", ver: 1, asOf: "2026-09-23T15:30:00+09:00", fxRate: null, source: "toss", note: null }], pageParams: [{ page: 1 }] }),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: async () => undefined,
  }),
  useDiscoverThemes: (market: "KR" | "US") => ok({ market, kind: "theme", period: "day", themes: h.themes, marketOpen: false, session: "closed", asOf: "2026-09-23T15:30:00+09:00", source: "toss", basis: "구성 종목 평균", note: null, updatedAt: null } as unknown as ThemeList),
  useLatestBriefings: () => ok(h.latest),
  useHealth: () => ok({ llmConfigured: true, lastBriefing: null }),
  useMarketStatus: () => ok(undefined),
  useMarketSummaries: () => ok(undefined),
  useAccountBriefings: () => ok(undefined),
  useBriefing: () => ok(undefined),
}));

const { default: DiscoverScreen } = await import("@/app/(tabs)/discover");
const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { default: AllocationScreen } = await import("@/app/portfolio/allocation");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");

beforeEach(() => {
  h.flags = { allocationView: true };
  h.rank = [];
  h.themes = [];
  h.latest = [];
  h.stocks = [];
  for (const f of [h.push, h.back, h.dismissTo, h.alert, h.refetch]) f.mockClear();
  forgetWindowClass();
});

const draw = (el: React.ReactElement, emptyGuide: boolean) => render(<UxFlagsContext.Provider value={{ oneHand: false, firstRun: false, emptyGuide, connectionGuide: emptyGuide }}>{el}</UxFlagsContext.Provider>);
const empties = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "Empty");
const buttonsOf = (n: HostNode) => {
  const out: HostNode[] = [];
  const walk = (x: HostNode | string) => {
    if (typeof x === "string") return;
    if (x.type === "Button") out.push(x);
    x.children.forEach(walk);
  };
  n.children.forEach(walk);
  return out;
};
const press = (b: HostNode) => (b.props.onPress as () => void)();

describe("발견: 빈 순위 · 빈 테마", () => {
  it("순위가 비면 안내 + '새로고침' 하나 (꺼져 있으면 버튼 없이 지금 안내)", () => {
    const r = draw(<DiscoverScreen />, true);
    const [e] = empties(r);
    expect(e!.props.title).toBe("표시할 종목이 없습니다");
    const btns = buttonsOf(e!);
    expect(btns.map((b) => b.props.title)).toEqual(["새로고침"]);
    press(btns[0]!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
    const off = empties(draw(<DiscoverScreen />, false))[0]!;
    expect(off.props.hint).toBe("장 시작 전이거나 데이터를 받지 못했습니다. 잠시 뒤 당겨서 새로고침 하세요.");
    expect(buttonsOf(off)).toHaveLength(0);
  });

  it("테마 목록이 비면 안내 + '새로고침' 하나", () => {
    const r = draw(<DiscoverScreen />, true);
    const chip = r.all().find((n) => n.type === "Chip" && n.props.label === "테마")!;
    r.act(() => (chip.props.onPress as () => void)());
    const e = empties(r).find((x) => String(x.props.title).includes("테마"))!;
    expect(e.props.hint).toContain("테마 목록을 아직 받지 못했습니다");
    expect(buttonsOf(e).map((b) => b.props.title)).toEqual(["새로고침"]);
  });
});

describe("브리핑: 종목 없음 · 브리핑 없음", () => {
  it("등록 종목이 없으면 안내 + '종목 검색' 하나", () => {
    const r = draw(<BriefingsScreen />, true);
    const e = empties(r)[0]!;
    expect(e.props.title).toBe("등록된 종목이 없습니다");
    expect(e.props.hint).toContain("평일 장 시작 전·마감 뒤");
    const btns = buttonsOf(e);
    expect(btns.map((b) => b.props.title)).toEqual(["종목 검색"]);
    press(btns[0]!);
    expect(h.push).toHaveBeenCalledWith("/stocks/add");
    // 꺼져 있으면 지금 안내 (버튼 없음)
    const off = empties(draw(<BriefingsScreen />, false))[0]!;
    expect(off.props.hint).toBe("잔고 탭에서 종목을 추가하세요.");
    expect(buttonsOf(off)).toHaveLength(0);
  });

  it("종목은 있는데 만든 브리핑이 없으면 안내 + '지금 만들기' 하나 (오전·오후를 고르는 창)", () => {
    h.latest = [{ code: "005930", name: "삼성전자", latest: null }];
    h.stocks = [holding("005930", quote("005930", 84_300), 10, 70_000, undefined, "삼성전자")];
    const r = draw(<BriefingsScreen />, true);
    const e = empties(r)[0]!;
    expect(e.props.title).toBe("생성된 브리핑이 없습니다");
    const btns = buttonsOf(e);
    expect(btns.map((b) => b.props.title)).toEqual(["지금 만들기"]);
    press(btns[0]!);
    expect(h.alert.mock.calls[0]![0]).toBe("수동 생성");
    expect((h.alert.mock.calls[0]![2] as { text: string }[]).map((b) => b.text)).toEqual(["취소", "오전 브리핑", "오후 브리핑"]);
  });
});

describe("비중: 보유 종목 없음", () => {
  it("안내 + '잔고로' 하나 (꺼져 있으면 지금 안내)", () => {
    h.stocks = [holding("AVGO", quote("AVGO", 345.2, { currency: "USD", fxRate: 1400 }), null, null, undefined, "브로드컴")];
    const r = draw(<AllocationScreen />, true);
    const e = empties(r)[0]!;
    expect(e.props.title).toBe("보유 종목이 없습니다");
    expect(e.props.hint).toContain("수량과 평균 단가");
    const btns = buttonsOf(e);
    expect(btns.map((b) => b.props.title)).toEqual(["잔고로"]);
    press(btns[0]!);
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(buttonsOf(empties(draw(<AllocationScreen />, false))[0]!)).toHaveLength(0);
  });
});
