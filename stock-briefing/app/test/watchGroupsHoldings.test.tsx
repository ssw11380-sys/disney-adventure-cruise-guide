import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 잔고 탭 관심 그룹·순서 (3-34, 기능 플래그 watchGroups — 루트 WatchGroupsProvider 가 lib/watchGroupsQuery 의 문맥으로 내려 준다).
 *  - 꺼짐(제공자 없음 · 꺼짐 값): 칩·그룹 머리·새 속성·새 동작 없음, 길게 누르기·밀기·위에 붙는 머리 번호가 지금 그대로
 *  - 켬: 칩(전체·그룹·그룹 없음) → 고른 칩 저장, 그룹 머리 → 접기 저장, 위에 붙는 머리 번호가 보유·관심 머리를 가리킴, 정렬 '등록순'이면 '내 순서',
 *    관심 줄만 화면 읽기 동작(그룹 옮기기 · 위로 · 아래로 — 끝은 뺌, 정렬이 다르면 그룹 옮기기만), 길게 누르기 → 시트(보유 줄은 예전 창), 밀기 버튼 셋,
 *    위로 옮기면 저장 차례에 (종목 · 그룹 · 자리 · 알림 문장), 촘촘·넓은 표(933)
 * 시계·시세는 고정 (useFeedState 가짜의 now 0), 네트워크 없음
 */
const h = vi.hoisted(() => ({
  win: { width: 360, height: 752, scale: 3, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  stocks: undefined as unknown,
  sort: "created" as string,
  density: "basic" as string,
  setSort: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
  remove: vi.fn(),
  closeOpen: vi.fn(() => false),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  Alert: { alert: h.alert },
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, navigate: vi.fn(), dismissTo: vi.fn(), canDismiss: () => false }, usePathname: () => "/" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [
    { value: "created", label: "등록순" },
    { value: "changeRate", label: "등락률" },
  ],
  useSettings: () => ({ afterCost: false, showKrw: false, sort: h.sort, setSort: h.setSort, density: h.density }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks, isError: false, error: null, refetch: async () => undefined, dataUpdatedAt: 1 }),
  useHealth: () => ({ data: undefined }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: h.remove } }),
}));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  const Screen = ({ children, top }: { children: React.ReactNode; top?: React.ReactNode }) => R.createElement("Screen", null, R.createElement("Top", null, top), children);
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", ErrorView: "ErrorView", TableHead: "TableHead" }));
vi.mock("@/components/Freshness", () => ({ LiveStatus: "LiveStatus", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: vi.fn() }), useFeedState: () => ({ now: 0, feedOk: true }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip" }));
vi.mock("@/components/Skeleton", () => ({ HoldingsSkeleton: "HoldingsSkeleton" }));
vi.mock("@/components/StockRow", () => ({ StockRow: "StockRow" }));
vi.mock("@/components/SwipeRow", () => ({ SwipeRow: "SwipeRow", closeOpenRow: () => h.closeOpen() }));
vi.mock("@/components/TossImportButton", () => ({ TossImportButton: "TossImportButton" }));
vi.mock("@/components/StockLine", () => ({ PRICE_HEAD: "현재가·등락률", useLineCols: () => ({ rank: 30, price: 100, right: 108 }) }));
vi.mock("@/components/HoldingsTableHead", () => ({ TableHeadRow: "TableHeadRow" }));
vi.mock("@/components/AccountBand", async (orig) => ({ ...(await orig<typeof import("@/components/AccountBand")>()), AccountBand: "AccountBand" }));
vi.mock("@/components/WatchChips", () => ({ WatchChips: "WatchChips", WatchGroupHead: "WatchGroupHead", WatchEmptyGroup: "WatchEmptyGroup" }));
vi.mock("@/components/WatchRowSheet", async (orig) => ({ ...(await orig<typeof import("@/components/WatchRowSheet")>()), WatchMenuHost: "WatchMenuHost" }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor } = await import("@/lib/holdingsAnchor");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { WatchGroupsContext, WATCH_GROUPS_OFF } = await import("@/lib/watchGroupsQuery");
type State = import("@/lib/watchGroupsQuery").WatchGroupsState;
type Layout = import("@/lib/watchGroups").WatchLayout;
type View = import("@/lib/watchView").WatchView;

const at = (m: number) => `2026-09-01T09:${String(m).padStart(2, "0")}:00+09:00`;
const held = (code: string, name: string, m: number): RegisteredWithQuote => ({ ...holding(code, quote(code, 100_000, { change: 1_000, changeRate: 1 }), 10, 90_000, undefined, name), createdAt: at(m) });
const watch = (code: string, name: string, m: number, rate = 0): RegisteredWithQuote => ({ ...holding(code, quote(code, 50_000, { changeRate: rate }), null, null, undefined, name), createdAt: at(m) });
const STOCKS: RegisteredWithQuote[] = [
  held("035420", "NAVER", 0),
  held("AAPL", "애플", 1),
  watch("005930", "삼성전자", 2, 1.2),
  watch("000660", "SK하이닉스", 3, -0.4),
  watch("042700", "한미반도체", 4, 3.1),
  watch("KO", "코카콜라", 5, -1.1),
  watch("O", "리얼티인컴", 6, 0.1),
  watch("TSLA", "테슬라", 7, -2.5),
];
const LAYOUT: Layout = {
  on: true,
  groups: [
    { id: 7, name: "반도체", position: 0 },
    { id: 3, name: "배당", position: 1 },
  ],
  items: [
    { code: "000660", groupId: 7, position: 0 },
    { code: "005930", groupId: 7, position: 1 },
    { code: "042700", groupId: 7, position: 2 },
    { code: "KO", groupId: 3, position: 0 },
    { code: "O", groupId: 3, position: 1 },
  ],
};

const haptics: string[] = [];
const engine = {
  selectionAsync: async () => void haptics.push("selection"),
  impactAsync: async (s: never) => void haptics.push(`impact:${s}`),
  notificationAsync: async (s: never) => void haptics.push(`notify:${s}`),
  performAndroidHapticsAsync: async (s: never) => void haptics.push(`android:${s}`),
};

const ops = { move: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), order: vi.fn() };
const setView = vi.fn();
const state = (over: Partial<State> = {}): State => ({ on: true, layout: LAYOUT, view: { selected: "all", collapsed: [] }, setView, ops, status: "ready", error: null, refetch: () => {}, ...over });

beforeEach(() => {
  h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
  h.flags = {};
  h.stocks = STOCKS;
  h.sort = "created";
  h.density = "basic";
  for (const f of [h.setSort, h.push, h.alert, h.remove, setView, ...Object.values(ops)]) f.mockReset();
  h.closeOpen.mockReset();
  h.closeOpen.mockReturnValue(false);
  haptics.length = 0;
  installHaptics(engine, "android");
  setHapticPolicy({ oneHand: true, user: true });
  forgetWindowClass();
  forgetHoldingsAnchor();
});

const ux = (o: Partial<{ oneHand: boolean }> = {}) => ({ oneHand: false, firstRun: false, emptyGuide: false, ...o, connectionGuide: false, flagsMissing: false });
const draw = (wg: State | null, flags: Partial<{ oneHand: boolean }> = {}) =>
  render(
    <UxFlagsContext.Provider value={ux(flags)}>
      {wg ? (
        <WatchGroupsContext.Provider value={wg}>
          <StocksScreen />
        </WatchGroupsContext.Provider>
      ) : (
        <StocksScreen />
      )}
    </UxFlagsContext.Provider>,
  );
const byType = (r: ReturnType<typeof render>, type: string): HostNode[] => r.all().filter((n) => n.type === type);
/** 목록(ScrollView)의 자식 순서: 줄은 종목 코드, 그룹 머리는 '▾이름', 빈 칸은 '(빈 그룹)', 구역 머리는 '#머리' */
function listShape(r: ReturnType<typeof render>): string[] {
  const list = byType(r, "ScrollView")[0]!;
  const out: string[] = [];
  for (const c of list.children) {
    if (typeof c === "string") continue;
    const node = c.type === "View" && c.children.length === 1 && typeof c.children[0] !== "string" ? (c.children[0] as HostNode) : c;
    if (node.type === "StockRow") out.push((node.props.stock as RegisteredWithQuote).code);
    else if (node.type === "SwipeRow") out.push("?");
    else if (c.type === "WatchGroupHead") out.push(`${c.props.collapsed ? "▸" : "▾"}${c.props.name as string}`);
    else if (c.type === "WatchEmptyGroup") out.push("(빈 그룹)");
    else out.push("#");
  }
  return out;
}
const rowOf = (r: ReturnType<typeof render>, code: string) => byType(r, "StockRow").find((n) => (n.props.stock as RegisteredWithQuote).code === code)!;
const stickyChild = (r: ReturnType<typeof render>, i: number) => {
  const list = byType(r, "ScrollView")[0]!;
  return list.children.filter((c) => typeof c !== "string")[i] as HostNode;
};

describe("꺼짐 — 지금 그대로", () => {
  it.each([["제공자 없음", null], ["꺼짐 값", WATCH_GROUPS_OFF]] as const)("%s: 칩·그룹 머리·새 속성 없음, 관심은 등록순, 머리 번호 그대로", (_n, wg) => {
    const r = draw(wg);
    expect(byType(r, "WatchChips")).toHaveLength(0);
    expect(byType(r, "WatchGroupHead")).toHaveLength(0);
    expect(byType(r, "WatchMenuHost")).toHaveLength(0);
    for (const row of byType(r, "StockRow")) expect(Object.keys(row.props).sort()).toEqual(["afterCost", "live", "onLongPress", "onPress", "showKrw", "stock"]);
    expect(byType(r, "StockRow").map((n) => (n.props.stock as RegisteredWithQuote).code)).toEqual(["035420", "AAPL", "005930", "000660", "042700", "KO", "O", "TSLA"]);
    // 머리(0) · 보유 머리(1) · 보유 2줄 · 관심 머리(4)
    expect(byType(r, "ScrollView")[0]!.props.stickyHeaderIndices).toEqual([1, 4]);
    expect(r.text()).toContain("등록순");
    expect(r.text()).not.toContain("내 순서");
    // 정렬 창에 아랫줄 없음
    expect(r.all().some((n) => n.props.accessibilityLabel === "등록순, 관심 종목은 ‘그룹·순서’에서 정한 순서")).toBe(false);
    // 관심 줄 길게 누르기: 예전 창
    (rowOf(r, "005930").props.onLongPress as (s: RegisteredWithQuote) => void)(STOCKS[2]!);
    expect(h.alert.mock.calls[0]![0]).toBe("삼성전자");
  });

  it("oneHand 밀기 버튼도 지금 그대로 (관심 줄 둘)", () => {
    const r = draw(null, { oneHand: true });
    const row = rowOf(r, "005930");
    const el = (row.props.wrapRow as (s: unknown, row: React.ReactElement) => React.ReactElement<{ actions: { label: string }[] }>)(row.props.stock, <></>);
    expect(el.props.actions.map((a) => a.label)).toEqual(["수정", "관심 해제"]);
  });
});

describe("켬: 칩 · 그룹 머리 · 위에 붙는 머리", () => {
  it("'전체': 그룹 머리 + 줄(내 순서), 그룹 없음은 맨 끝, 위에 붙는 머리 번호가 보유 머리·관심 머리를 가리킨다", () => {
    const r = draw(state());
    expect(listShape(r)).toEqual(["#", "#", "035420", "AAPL", "#", "▾반도체", "000660", "005930", "042700", "▾배당", "KO", "O", "▾그룹 없음", "TSLA"]);
    const sticky = byType(r, "ScrollView")[0]!.props.stickyHeaderIndices as number[];
    expect(sticky).toEqual([1, 4]);
    // 가리키는 자식이 정말 구역 머리 (보유 머리 · 관심 머리 — 칩 줄이 든 머리)
    const watchHead = stickyChild(r, sticky[1]!);
    expect(JSON.stringify(watchHead)).toContain("WatchChips");
    expect(JSON.stringify(stickyChild(r, sticky[0]!))).toContain("보유 2");
  });

  it("칩: 전체 9가 아니라 관심 수, 고르면 이 기기에 저장(서버 없음) · 짧은 진동", async () => {
    const r = draw(state());
    const chips = byType(r, "WatchChips")[0]!;
    expect((chips.props.chips as { label: string; count: number; selected: boolean }[]).map((c) => `${c.label} ${c.count}${c.selected ? "*" : ""}`)).toEqual(["전체 6*", "반도체 3", "배당 2", "그룹 없음 1"]);
    (chips.props.onPick as (k: unknown) => void)(3);
    expect(setView).toHaveBeenCalledWith({ selected: 3, collapsed: [] });
    await new Promise((res) => setTimeout(res, 0));
    expect(haptics).toEqual(["android:segment-tick"]);
    expect(ops.move).not.toHaveBeenCalled();
    // 그룹·순서 버튼 → 편집 화면
    (chips.props.onEdit as () => void)();
    expect(h.push).toHaveBeenCalledWith("/watch-groups");
  });

  it("그룹 머리를 누르면 접기 저장, 접힌 그룹은 줄이 빠지고 위에 붙는 머리 번호는 그대로 맞다", () => {
    const r = draw(state());
    const head = byType(r, "WatchGroupHead").find((n) => n.props.name === "반도체")!;
    (head.props.onToggle as () => void)();
    expect(setView).toHaveBeenCalledWith({ selected: "all", collapsed: [7] });
    const folded = draw(state({ view: { selected: "all", collapsed: [7, "none"] } }));
    expect(listShape(folded)).toEqual(["#", "#", "035420", "AAPL", "#", "▸반도체", "▾배당", "KO", "O", "▸그룹 없음"]);
    expect(byType(folded, "ScrollView")[0]!.props.stickyHeaderIndices).toEqual([1, 4]);
  });

  it("그룹 칩을 고르면 머리 없이 그 그룹만, 비었으면 빈 칸 하나", () => {
    expect(listShape(draw(state({ view: { selected: 3, collapsed: [3] } })))).toEqual(["#", "#", "035420", "AAPL", "#", "KO", "O"]);
    const empty = draw(state({ layout: { ...LAYOUT, groups: [...LAYOUT.groups, { id: 9, name: "빈 그룹", position: 2 }] }, view: { selected: 9, collapsed: [] } }));
    expect(listShape(empty)).toEqual(["#", "#", "035420", "AAPL", "#", "(빈 그룹)"]);
    // 빈 칸은 고른 그룹 이름을 받는다 (제목 '‘빈 그룹’ 그룹에 종목이 없습니다')
    expect([byType(empty, "WatchEmptyGroup")[0]!.props.name, byType(empty, "WatchEmptyGroup")[0]!.props.groupId]).toEqual(["빈 그룹", 9]);
    (byType(empty, "WatchEmptyGroup")[0]!.props.onOpen as () => void)();
    expect(h.push).toHaveBeenCalledWith("/watch-groups");
  });

  it("그룹이 하나도 없으면 머리 없이 지금 순서 + 칩 줄('전체' 하나 — 설계 E4, '그룹 없음 6' 칩은 없음)", () => {
    const r = draw(state({ layout: { on: true, groups: [], items: [] } }));
    expect(listShape(r)).toEqual(["#", "#", "035420", "AAPL", "#", "005930", "000660", "042700", "KO", "O", "TSLA"]);
    expect((byType(r, "WatchChips")[0]!.props.chips as { label: string; count: number; selected: boolean }[]).map((c) => [c.label, c.count, c.selected])).toEqual([["전체", 6, true]]);
  });

  it("관심 종목이 없으면 관심 구역·칩 줄이 없다", () => {
    h.stocks = STOCKS.slice(0, 2);
    const r = draw(state());
    expect(byType(r, "WatchChips")).toHaveLength(0);
    expect(byType(r, "ScrollView")[0]!.props.stickyHeaderIndices).toEqual([1]);
  });
});

describe("켬: 정렬과 '내 순서'", () => {
  it("등록순이면 관심 머리는 '내 순서'(화면 읽기 '… 관심 종목은 내 순서'), 보유 머리는 '등록순', 정렬 창 '등록순' 아랫줄", () => {
    const r = draw(state());
    const sortBtns = r.all().filter((n) => typeof n.props.accessibilityLabel === "string" && (n.props.accessibilityLabel as string).startsWith("정렬 바꾸기"));
    expect(sortBtns.map((n) => n.props.accessibilityLabel)).toEqual(["정렬 바꾸기, 지금 등록순", "정렬 바꾸기, 지금 등록순, 관심 종목은 내 순서"]);
    expect(r.text()).toContain("내 순서");
    expect(r.all().some((n) => n.props.accessibilityLabel === "등록순, 관심 종목은 ‘그룹·순서’에서 정한 순서")).toBe(true);
  });

  it("다른 정렬이면 그룹 경계는 지키고 그룹 안에서만 그 정렬, 화면 읽기 동작은 그룹 옮기기만", () => {
    h.sort = "changeRate";
    const r = draw(state());
    expect(listShape(r)).toEqual(["#", "#", "035420", "AAPL", "#", "▾반도체", "042700", "005930", "000660", "▾배당", "O", "KO", "▾그룹 없음", "TSLA"]);
    expect((rowOf(r, "005930").props.moreActions as { name: string }[]).map((a) => a.name)).toEqual(["watchGroup"]);
    expect(r.text()).not.toContain("내 순서");
  });
});

describe("켬: 관심 줄 동작", () => {
  it("관심 줄만 화면 읽기 동작(맨 위는 위로 없음, 맨 아래는 아래로 없음), 보유 줄은 그대로", () => {
    const r = draw(state());
    const names = (code: string) => (rowOf(r, code).props.moreActions as { name: string }[]).map((a) => a.name);
    expect(names("000660")).toEqual(["watchGroup", "watchDown"]);
    expect(names("005930")).toEqual(["watchGroup", "watchUp", "watchDown"]);
    expect(names("042700")).toEqual(["watchGroup", "watchUp"]);
    expect(names("TSLA")).toEqual(["watchGroup"]);
    expect(rowOf(r, "035420").props).not.toHaveProperty("moreActions");
    // 늘 같은 배열 (줄 memo 비교)
    expect(rowOf(draw(state()), "005930").props.moreActions).toBe(rowOf(r, "005930").props.moreActions);
  });

  it("위로 옮기기: 저장 차례에 (종목 · 그룹 · 새 자리 · 알림 문장) + 진동, 그룹 옮기기는 그룹 고르기 시트", async () => {
    const r = draw(state());
    const act = rowOf(r, "005930").props.onMoreAction as (s: RegisteredWithQuote, a: string) => void;
    act(STOCKS[2]!, "watchUp");
    expect(ops.move).toHaveBeenCalledWith(STOCKS[2], 7, 0, "삼성전자를 반도체 1번째로 옮겼습니다");
    act(STOCKS[4]!, "watchDown"); // 맨 아래 — 아무 일 없음
    expect(ops.move).toHaveBeenCalledTimes(1);
    await new Promise((res) => setTimeout(res, 0));
    expect(haptics).toEqual(["android:segment-tick"]);
    r.act(() => act(STOCKS[2]!, "watchGroup"));
    const host = byType(r, "WatchMenuHost")[0]!;
    expect(host.props.target).toEqual({ stock: STOCKS[2], step: "groups" });
  });

  it("관심 줄 길게 누르기 → 시트(메뉴부터), 보유 줄은 예전 창 — oneHand 켜짐·꺼짐 모두", () => {
    for (const oneHand of [false, true]) {
      h.alert.mockReset();
      const r = draw(state(), { oneHand });
      r.act(() => (rowOf(r, "KO").props.onLongPress as (s: RegisteredWithQuote) => void)(STOCKS[5]!));
      const host = byType(r, "WatchMenuHost")[0]!;
      expect(host.props.target).toEqual({ stock: STOCKS[5], step: "menu" });
      expect([host.props.variant, host.props.mine, host.props.removeText]).toEqual(["holdings", true, "관심 해제"]);
      expect(h.alert).not.toHaveBeenCalled();
      (rowOf(r, "035420").props.onLongPress as (s: RegisteredWithQuote) => void)(STOCKS[0]!);
      expect(h.alert).toHaveBeenCalledTimes(1);
      expect(h.alert.mock.calls[0]![0]).toBe("NAVER");
    }
  });

  it("밀기(oneHand): 관심 줄은 수정 · 그룹 · 관심 해제, 보유 줄은 수정 · 삭제. '그룹'은 그룹 고르기 시트", () => {
    const r = draw(state(), { oneHand: true });
    const actions = (code: string) =>
      (rowOf(r, code).props.wrapRow as (s: unknown, row: React.ReactElement) => React.ReactElement<{ actions: { key: string; label: string; onPress: () => void }[] }>)(rowOf(r, code).props.stock, <></>).props.actions;
    expect(actions("005930").map((a) => a.label)).toEqual(["수정", "그룹", "관심 해제"]);
    expect(actions("035420").map((a) => a.label)).toEqual(["수정", "삭제"]);
    r.act(() => actions("005930")[1]!.onPress());
    expect(byType(r, "WatchMenuHost")[0]!.props.target).toEqual({ stock: STOCKS[2], step: "groups" });
  });
});

describe("켬: 촘촘 · 넓은 표", () => {
  it("촘촘: 칩·그룹 머리는 그대로(44), 보유 줄 수·순서 그대로", () => {
    h.flags = { densityMode: true };
    h.density = "dense";
    const r = draw(state());
    expect(byType(r, "WatchChips")).toHaveLength(1);
    expect(listShape(r).slice(0, 5)).toEqual(["#", "#", "035420", "AAPL", "#"]);
    expect(rowOf(r, "035420").props.dense).toBe(true);
    expect(rowOf(r, "005930").props.dense).toBe(true);
  });

  it("넓은 표(933×704): 표 머리 '내 순서' 뒤에 칩 줄, 그룹 머리는 표 여백, 줄무늬는 그룹마다 0 부터", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { foldLayout: true };
    const r = draw(state());
    const heads = byType(r, "TableHeadRow");
    expect(heads.map((n) => n.props.sortLabel)).toEqual(["등록순", "내 순서"]);
    // 화면 읽기도 휴대폰과 같은 문장 (보유 머리는 넘기지 않아 기본 '정렬 바꾸기, 지금 등록순')
    expect(heads.map((n) => n.props.sortA11y)).toEqual([undefined, "정렬 바꾸기, 지금 등록순, 관심 종목은 내 순서"]);
    const watchHead = stickyChild(r, (byType(r, "ScrollView")[0]!.props.stickyHeaderIndices as number[])[1]!);
    expect(watchHead.children.filter((c) => typeof c !== "string").map((c) => (c as HostNode).type)).toEqual(["TableHeadRow", "WatchChips"]);
    const pad = (byType(r, "WatchChips")[0]!.props.pad as number) ?? 0;
    expect(byType(r, "WatchGroupHead").every((n) => n.props.pad === pad)).toBe(true);
    expect(["000660", "005930", "042700", "KO", "O", "TSLA"].map((c) => rowOf(r, c).props.zebra)).toEqual([false, true, false, false, true, false]);
    expect(rowOf(r, "005930").props.columns).toBeTruthy();
  });
});
