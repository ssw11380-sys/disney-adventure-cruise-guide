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
  mutate: vi.fn(),
  win: { width: 475, height: 751 },
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
    useWindowDimensions: () => ({ ...h.win, scale: 2.625, fontScale: 1 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Path: "Path" }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
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
  useStockMutations: () => ({ register: { mutate: vi.fn() }, run: { mutate: h.mutate, isPending: false, variables: undefined } }),
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
  for (const f of [h.push, h.back, h.dismissTo, h.alert, h.refetch, h.mutate]) f.mockClear();
  h.win = { width: 475, height: 751 };
  forgetWindowClass();
});

const draw = (el: React.ReactElement, emptyGuide: boolean) => render(<UxFlagsContext.Provider value={{ oneHand: false, firstRun: false, emptyGuide, connectionGuide: emptyGuide, flagsMissing: false }}>{el}</UxFlagsContext.Provider>);
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

  it("종목은 있는데 만든 브리핑이 없으면 안내 + '지금 만들기' 하나 → 누른 시각의 세션으로 확인 창 (창 안에서 다른 세션으로 바꿈), 수동 생성 카드는 숨김", () => {
    h.latest = [{ code: "005930", name: "삼성전자", latest: null }];
    h.stocks = [holding("005930", quote("005930", 84_300), 10, 70_000, undefined, "삼성전자")];
    h.flags = { allocationView: true, briefingManualRun: true };
    const now = vi.spyOn(Date, "now");
    try {
      const r = draw(<BriefingsScreen />, true);
      const e = empties(r)[0]!;
      expect(e.props.title).toBe("생성된 브리핑이 없습니다");
      const btns = buttonsOf(e);
      expect(btns.map((b) => b.props.title)).toEqual(["지금 만들기"]);
      // 같은 일을 하는 '수동 생성' 카드(오전·오후 브리핑)는 빈 화면에서는 없다 — 한 화면에 같은 버튼이 셋이 되지 않게
      expect(r.text()).not.toContain("수동 생성");
      expect(r.all().some((n) => n.type === "Button" && (n.props.title === "오전 브리핑" || n.props.title === "오후 브리핑"))).toBe(false);
      // 한국 시각 09:10 → 오전
      now.mockReturnValue(Date.parse("2026-09-28T00:10:00Z"));
      press(btns[0]!);
      expect(h.alert.mock.calls[0]![0]).toBe("오전 브리핑 1종목 새로 만들기");
      // 한국 시각 16:00 → 오후
      now.mockReturnValue(Date.parse("2026-09-28T07:00:00Z"));
      press(btns[0]!);
      expect(h.alert.mock.calls[1]![0]).toBe("오후 브리핑 1종목 새로 만들기");
    } finally {
      now.mockRestore();
    }
    // 꺼져 있으면 수동 생성 카드 그대로
    expect(draw(<BriefingsScreen />, false).text()).toContain("수동 생성");
  });

  it("'지금 만들기' 확인 창에서 다른 세션으로 바꿀 수 있다: 오전(09:10)에 '오후로 바꾸기' → 오후 확인 창 → 만들기 = 오후 브리핑", () => {
    h.latest = [{ code: "005930", name: "삼성전자", latest: null }];
    h.stocks = [holding("005930", quote("005930", 84_300), 10, 70_000, undefined, "삼성전자")];
    h.flags = { allocationView: true, briefingManualRun: true };
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-28T00:10:00Z"));
    try {
      const r = draw(<BriefingsScreen />, true);
      press(buttonsOf(empties(r)[0]!)[0]!);
      type Btn = { text: string; style?: string; onPress?: () => void };
      const [title, message, buttons] = h.alert.mock.calls[0]! as [string, string, Btn[]];
      expect(title).toBe("오전 브리핑 1종목 새로 만들기");
      expect(message).toContain("오후 브리핑을 만들려면 '오후로 바꾸기'를 누르세요.");
      // 버튼 셋: 바꾸기 · 취소 · 만들기 (안드로이드 알림 창 한 줄에 셋까지)
      expect(buttons.map((b) => b.text)).toEqual(["오후로 바꾸기", "취소", "만들기"]);
      expect(buttons[1]!.style).toBe("cancel");
      buttons[0]!.onPress!();
      const [title2, message2, buttons2] = h.alert.mock.calls[1]! as [string, string, Btn[]];
      expect(title2).toBe("오후 브리핑 1종목 새로 만들기");
      expect(message2).toContain("'오전으로 바꾸기'");
      expect(buttons2.map((b) => b.text)).toEqual(["오전으로 바꾸기", "취소", "만들기"]);
      expect(h.mutate).not.toHaveBeenCalled();
      buttons2[2]!.onPress!();
      expect(h.mutate).toHaveBeenCalledTimes(1);
      expect(h.mutate.mock.calls[0]![0]).toMatchObject({ session: "afternoon", force: true });
    } finally {
      now.mockRestore();
    }
  });

  it("'지금 만들기'는 수동 생성 확인(briefingManualRun)이 꺼져 있어도 늘 확인 창을 거친다 — 한 번 눌러 전 종목 생성이 시작되지 않게", () => {
    h.latest = [{ code: "005930", name: "삼성전자", latest: null }];
    h.stocks = [holding("005930", quote("005930", 84_300), 10, 70_000, undefined, "삼성전자")];
    h.flags = { allocationView: true, briefingManualRun: false };
    const r = draw(<BriefingsScreen />, true);
    press(buttonsOf(empties(r)[0]!)[0]!);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.mutate).not.toHaveBeenCalled();
    // 확인 창의 '만들기'를 눌러야 시작
    const buttons = h.alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === "만들기")!.onPress!();
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });

  it("넓은 창(933×704): 브리핑이 없으면 빈 칸의 '지금 만들기' 하나 — 머리의 '⋯'(수동 생성)도 숨긴다. 꺼져 있으면 '⋯' 그대로", () => {
    h.win = { width: 933, height: 704 };
    h.latest = [{ code: "005930", name: "삼성전자", latest: null }];
    h.stocks = [holding("005930", quote("005930", 84_300), 10, 70_000, undefined, "삼성전자")];
    h.flags = { allocationView: true, briefingManualRun: true, foldLayout: true };
    const more = (r: ReturnType<typeof render>) => r.all().filter((n) => n.props.accessibilityLabel === "수동 생성");
    const on = draw(<BriefingsScreen />, true);
    expect(buttonsOf(empties(on)[0]!).map((b) => b.props.title)).toEqual(["지금 만들기"]);
    expect(more(on)).toHaveLength(0);
    forgetWindowClass();
    expect(more(draw(<BriefingsScreen />, false)).length).toBeGreaterThan(0);
  });
});

describe("비중: 플래그를 받지 못한 채 서버에 닿지 않음 (주소·토큰이 틀림)", () => {
  it("'쓸 수 없음' 대신 무엇을 고칠지 + '설정 열기' 하나 (스택 위 화면 — 설정 탭까지 닫고 간다)", () => {
    h.flags = {};
    const missing = { oneHand: false, firstRun: false, emptyGuide: false, connectionGuide: true, flagsMissing: true };
    const r = render(<UxFlagsContext.Provider value={missing}><AllocationScreen /></UxFlagsContext.Provider>);
    const e = empties(r)[0]!;
    expect(e.props.title).toBe("서버에 연결되지 않아 비중을 볼 수 없습니다");
    expect(e.props.hint).toBe("설정 > 서버 연결에서 '서버 주소'와 'API 토큰'을 확인하세요.");
    const btns = buttonsOf(e);
    expect(btns.map((b) => b.props.title)).toEqual(["설정 열기"]);
    // 서버가 비중을 꺼 둔 것(플래그를 받음)이면 예전 안내 그대로
    const off = empties(draw(<AllocationScreen />, true))[0]!;
    expect(off.props.title).toBe("지금은 비중 보기를 쓸 수 없습니다");
    expect(buttonsOf(off)).toHaveLength(0);
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
