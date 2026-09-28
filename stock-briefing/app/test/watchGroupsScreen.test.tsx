import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * '관심 그룹·순서' 화면 (3-34, 기능 플래그 watchGroups): 꺼짐·불러오는 중·실패 화면, 그룹 카드(↑↓ 사용 불가 · 순서 저장 · ⋯ 이름 바꾸기·지우기 확인 글),
 * 이름 창(앱 검사 글 5가지 · 서버 거절 글 · 저장 중 두 번 누르기 막음), 종목 순서 카드(편집할 그룹 칩 · 줄 이름표 · ↑↓ · 화면 읽기 동작 · ⋯ 시트 그룹 옮기기),
 * 정렬 안내, 그룹 0개·관심 0개, 끌기(≡ 길게 눌러 끌기 → 목표 칸으로 저장), 넓은 창 두 칸. 서버 없음 (저장 차례는 가짜 ops)
 */
const h = vi.hoisted(() => ({
  win: { width: 360, height: 752, scale: 3, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  stocks: undefined as unknown,
  sort: "created" as string,
  setSort: vi.fn(),
  alert: vi.fn(),
  announce: vi.fn(),
  back: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Modal: "Modal",
  TextInput: "TextInput",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  Alert: { alert: h.alert },
  AccessibilityInfo: { announceForAccessibility: h.announce },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-gesture-handler", () => {
  type G = { handlers: Record<string, (e?: unknown) => void> } & Record<string, unknown>;
  const Pan = () => {
    const g = { handlers: {} } as G;
    for (const m of ["runOnJS", "activateAfterLongPress", "maxPointers"]) g[m] = () => g;
    for (const m of ["onStart", "onUpdate", "onEnd", "onFinalize"])
      g[m] = (fn: (e?: unknown) => void) => {
        g.handlers[m] = fn;
        return g;
      };
    return g;
  };
  return { Gesture: { Pan }, GestureDetector: "GestureDetector" };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { back: h.back, canGoBack: () => true, dismissTo: vi.fn(), push: vi.fn() }, usePathname: () => "/watch-groups" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [
    { value: "created", label: "등록순" },
    { value: "changeRate", label: "등락률" },
  ],
  useSettings: () => ({ sort: h.sort, setSort: h.setSort }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks }),
}));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  return { Screen: ({ children }: { children: React.ReactNode }) => R.createElement("Screen", null, children) };
});
vi.mock("@/components/TwoPane", async () => {
  const R = await import("react");
  return { TwoPane: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => R.createElement("TwoPane", null, R.createElement("Left", null, left), R.createElement("Right", null, right)) };
});
vi.mock("@/components/ui", async () => {
  const R = await import("react");
  return {
    Button: "Button",
    Card: "Card",
    Chip: "Chip",
    ErrorView: "ErrorView",
    Loading: "Loading",
    Muted: "Muted",
    Empty: ({ title, action }: { title: string; action?: React.ReactNode }) => R.createElement("Empty", { title }, title, action),
    SectionTitle: ({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) => R.createElement("SectionTitle", null, children, right),
  };
});

const { default: WatchGroupsScreen } = await import("@/app/watch-groups");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { WatchGroupsContext } = await import("@/lib/watchGroupsQuery");
type State = import("@/lib/watchGroupsQuery").WatchGroupsState;
type Layout = import("@/lib/watchGroups").WatchLayout;

const at = (m: number) => `2026-09-01T09:${String(m).padStart(2, "0")}:00+09:00`;
const watch = (code: string, name: string, m: number, market?: string): RegisteredWithQuote => ({
  ...holding(code, quote(code, 50_000), null, null, undefined, name),
  createdAt: at(m),
  ...(market ? { market: market as RegisteredWithQuote["market"] } : null),
});
const STOCKS: RegisteredWithQuote[] = [
  { ...holding("035420", quote("035420", 100_000), 10, 90_000, undefined, "NAVER"), createdAt: at(0) },
  watch("005930", "삼성전자", 1),
  watch("000660", "SK하이닉스", 2),
  watch("NVDA", "엔비디아", 3, "NASDAQ"),
  watch("KO", "코카콜라", 4, "NYSE"),
  watch("O", "리얼티인컴", 5, "NYSE"),
  watch("TSLA", "테슬라", 6, "NASDAQ"),
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
    { code: "NVDA", groupId: 7, position: 2 },
    { code: "KO", groupId: 3, position: 0 },
    { code: "O", groupId: 3, position: 1 },
  ],
};

const ops = { move: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), order: vi.fn() };
const refetch = vi.fn();
const state = (over: Partial<State> = {}): State => ({ on: true, layout: LAYOUT, view: { selected: "all", collapsed: [] }, setView: vi.fn(), ops, status: "ready", error: null, refetch, ...over });

beforeEach(() => {
  h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
  h.flags = {};
  h.stocks = STOCKS;
  h.sort = "created";
  for (const f of [h.setSort, h.alert, h.announce, h.back, refetch, ...Object.values(ops)]) f.mockReset();
  ops.create.mockResolvedValue({ ok: true, created: { id: 11, name: "ETF" } });
  ops.rename.mockResolvedValue({ ok: true });
  installHaptics({ selectionAsync: async () => {}, impactAsync: async () => {}, notificationAsync: async () => {}, performAndroidHapticsAsync: async () => {} }, "android");
  setHapticPolicy({ oneHand: true, user: true });
  forgetWindowClass();
});

const draw = (s: State) =>
  render(
    <WatchGroupsContext.Provider value={s}>
      <WatchGroupsScreen />
    </WatchGroupsContext.Provider>,
  );
const byType = (r: ReturnType<typeof render>, type: string): HostNode[] => r.all().filter((n) => n.type === type);
const press = (r: ReturnType<typeof render>, label: string) => r.act(() => (r.byLabel(label).props.onPress as () => void)());
const flush = () => new Promise((res) => setTimeout(res, 0));
const lastButtons = () => h.alert.mock.calls.at(-1)![2] as { text: string; style?: string; onPress?: () => void }[];
/** 종목 순서 줄의 이름표 (화면 읽기 한 문장) */
const orderRows = (r: ReturnType<typeof render>) =>
  r
    .all()
    .filter((n) => n.props.accessible && typeof n.props.accessibilityLabel === "string" && / \d+종목 중$/.test(n.props.accessibilityLabel as string))
    .map((n) => n.props.accessibilityLabel as string);

describe("꺼짐 · 불러오는 중 · 실패", () => {
  it("꺼짐(주소로 바로 들어옴 등): 안내 + '돌아가기'", () => {
    const r = draw(state({ on: false, status: "off" }));
    expect(byType(r, "Empty")[0]!.props.title).toBe("지금은 관심 그룹 기능이 꺼져 있습니다");
    const back = byType(r, "Button")[0]!;
    expect(back.props.title).toBe("돌아가기");
    (back.props.onPress as () => void)();
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(ops.move).not.toHaveBeenCalled();
  });
  it("처음 불러오는 중은 기다림, 실패는 공용 오류 화면(다시 시도)", () => {
    expect(byType(draw(state({ status: "loading" })), "Loading")).toHaveLength(1);
    const err = byType(draw(state({ status: "error", error: new Error("x") })), "ErrorView")[0]!;
    (err.props.onRetry as () => void)();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("그룹 카드", () => {
  it("그룹 줄: 이름 · 종목 수, 맨 위 ↑·맨 아래 ↓ 는 사용 불가, '그룹 없음'은 늘 맨 끝(버튼 없음)", () => {
    const r = draw(state());
    expect(r.has("반도체, 3종목, 그룹 1번째")).toBe(true);
    expect(r.has("배당, 2종목, 그룹 2번째")).toBe(true);
    expect(r.has("그룹 없음, 1종목, 늘 맨 끝")).toBe(true);
    expect(r.byLabel("반도체 위로").props.accessibilityState).toEqual({ disabled: true });
    expect(r.byLabel("반도체 아래로").props.accessibilityState).toEqual({ disabled: false });
    expect(r.byLabel("배당 아래로").props.accessibilityState).toEqual({ disabled: true });
    expect(r.has("그룹 없음 위로")).toBe(false);
    expect(r.text()).toContain("그룹은 12개, 이름은 10자까지입니다.");
  });

  it("↓ 로 그룹 순서를 바꾸면 저장 차례에 새 순서 + 화면 읽기 알림, 줄 동작도 같다", () => {
    const r = draw(state());
    press(r, "반도체 아래로");
    expect(ops.order).toHaveBeenCalledWith([3, 7]);
    expect(h.announce).toHaveBeenCalledWith("반도체 그룹을 2번째로 옮겼습니다");
    const row = r.byLabel("배당, 2종목, 그룹 2번째");
    expect((row.props.accessibilityActions as { name: string }[]).map((a) => a.name)).toEqual(["up", "rename", "delete"]);
    r.act(() => (row.props.onAccessibilityAction as (e: unknown) => void)({ nativeEvent: { actionName: "up" } }));
    expect(ops.order).toHaveBeenLastCalledWith([3, 7]);
  });

  it("⋯ → 이름 바꾸기 · 지우기 · 취소, 지우기는 확인 창(종목 수 글) → 저장 차례", () => {
    const r = draw(state());
    press(r, "반도체 그룹 메뉴");
    expect(h.alert.mock.calls[0]![0]).toBe("반도체");
    expect(lastButtons().map((b) => b.text)).toEqual(["이름 바꾸기", "지우기", "취소"]);
    r.act(() => lastButtons()[1]!.onPress!());
    expect(h.alert.mock.calls[1]!.slice(0, 2)).toEqual(["‘반도체’ 그룹 지우기", "그룹만 지워집니다. 안의 3종목은 관심 종목으로 남고 ‘그룹 없음’ 맨 끝으로 옮겨집니다."]);
    expect(lastButtons().map((b) => [b.text, b.style])).toEqual([
      ["취소", "cancel"],
      ["지우기", "destructive"],
    ]);
    lastButtons()[1]!.onPress!();
    expect(ops.remove).toHaveBeenCalledWith(7);
  });

  it("그룹이 없으면 안내 한 줄, 12개면 '새 그룹' 흐리게 + 한도 안내", () => {
    const none = draw(state({ layout: { on: true, groups: [], items: [] } }));
    expect(none.text()).toContain("아직 그룹이 없습니다. ‘새 그룹’으로 반도체·배당처럼 묶어 보세요.");
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `그룹${i + 1}`, position: i }));
    const full = draw(state({ layout: { on: true, groups: twelve, items: [] } }));
    expect(full.byLabel("새 그룹 만들기").props.disabled).toBe(true);
    expect(full.text()).toContain("그룹은 12개까지 만들 수 있습니다");
  });
});

describe("이름 창", () => {
  const input = (r: ReturnType<typeof render>) => r.byLabel("그룹 이름, 10자까지");
  const type = (r: ReturnType<typeof render>, v: string) => r.act(() => (input(r).props.onChangeText as (v: string) => void)(v));
  const submit = async (r: ReturnType<typeof render>, title = "만들기") => {
    const b = byType(r, "Button").find((n) => n.props.title === title)!;
    r.act(() => (b.props.onPress as () => void)());
    await flush();
    r.act(() => {});
  };
  const error = (r: ReturnType<typeof render>) => (byType(r, "Text").find((n) => n.props.accessibilityLiveRegion === "polite")!.children.join(""));

  it("앱이 먼저 검사한다: 빔 · 10자 · 예약어 · 같은 이름 (서버에 보내지 않음), 글자 수 '3/10'", async () => {
    const r = draw(state());
    press(r, "새 그룹 만들기");
    expect(r.text()).toContain("새 그룹");
    expect(input(r).props.placeholder).toBe("예: 반도체, 배당");
    await submit(r);
    expect(error(r)).toBe("이름을 넣어 주세요");
    type(r, "가나다라마바사아자차카");
    expect(r.text()).toContain("11/10");
    await submit(r);
    expect(error(r)).toBe("이름은 10자까지입니다");
    type(r, " 그룹 없음 ");
    await submit(r);
    expect(error(r)).toBe("‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다");
    type(r, "배당");
    expect(r.text()).toContain("2/10");
    await submit(r);
    expect(error(r)).toBe("같은 이름의 그룹이 이미 있습니다");
    expect(ops.create).not.toHaveBeenCalled();
  });

  it("12개면 앱 검사에서 한도 글, 서버가 거절하면 그 글, 성공하면 닫힌다", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `그룹${i + 1}`, position: i }));
    const full = draw(state({ layout: { on: true, groups: twelve, items: [] } }));
    // 버튼은 흐리지만 이름 창 검사도 한도를 안다 (그룹 고르기 시트의 '새 그룹 만들고 옮기기'와 같은 규칙)
    full.act(() => (full.byLabel("새 그룹 만들기").props.onPress as () => void)());
    type(full, "새 그룹");
    await submit(full);
    expect(error(full)).toBe("그룹은 12개까지 만들 수 있습니다");
    const r = draw(state());
    press(r, "새 그룹 만들기");
    ops.create.mockResolvedValueOnce({ ok: false, message: "같은 이름의 그룹이 이미 있습니다" });
    type(r, "ETF");
    await submit(r);
    expect(ops.create).toHaveBeenCalledWith("ETF");
    expect(error(r)).toBe("같은 이름의 그룹이 이미 있습니다");
    await submit(r);
    expect(ops.create).toHaveBeenCalledTimes(2);
    expect(r.has("그룹 이름, 10자까지")).toBe(false);
  });

  it("이름 바꾸기: 지금 이름이 채워져 있고 [바꾸기] → 저장 차례 (정리한 이름)", async () => {
    const r = draw(state());
    press(r, "반도체 그룹 메뉴");
    r.act(() => lastButtons()[0]!.onPress!());
    expect(r.text()).toContain("그룹 이름 바꾸기");
    expect(input(r).props.value).toBe("반도체");
    type(r, "  반도체 장비 ");
    await submit(r, "바꾸기");
    expect(ops.rename).toHaveBeenCalledWith(7, "반도체 장비");
    expect(r.has("그룹 이름, 10자까지")).toBe(false);
  });
});

describe("종목 순서 카드", () => {
  it("처음 편집할 그룹은 잔고에서 고른 칩('전체'면 첫 그룹), 줄 이름표 '삼성전자, 반도체 2번째, 3종목 중', 보조 글 코드·시장", () => {
    const r = draw(state());
    const chips = byType(r, "Chip");
    expect(chips.map((c) => [c.props.label, c.props.active, c.props.accessibilityLabel])).toEqual([
      ["반도체 3", true, "반도체 순서 편집, 3종목"],
      ["배당 2", false, "배당 순서 편집, 2종목"],
      ["그룹 없음 1", false, "그룹 없음 순서 편집, 1종목"],
    ]);
    expect(orderRows(r)).toEqual(["SK하이닉스, 반도체 1번째, 3종목 중", "삼성전자, 반도체 2번째, 3종목 중", "엔비디아, 반도체 3번째, 3종목 중"]);
    expect(r.text()).toContain("005930 · 코스피");
    expect(r.text()).toContain("NVDA · 나스닥");
    expect(r.text()).toContain("보유 중인 종목은 여기에 없습니다.");
    // 잔고에서 '배당' 칩을 골랐으면 배당부터
    expect(orderRows(draw(state({ view: { selected: 3, collapsed: [] } })))).toEqual(["코카콜라, 배당 1번째, 2종목 중", "리얼티인컴, 배당 2번째, 2종목 중"]);
    // 칩으로 바꾸기
    r.act(() => (chips[2]!.props.onPress as () => void)());
    expect(orderRows(r)).toEqual(["테슬라, 그룹 없음 1번째, 1종목 중"]);
  });

  it("↑·↓ (끝은 사용 불가) → 저장 차례 (종목 · 그룹 · 새 자리 · 알림 문장), 화면 읽기 동작 맨 위로·맨 아래로·그룹 옮기기", () => {
    const r = draw(state());
    expect(r.byLabel("SK하이닉스 위로 옮기기").props.accessibilityState).toEqual({ disabled: true });
    expect(r.byLabel("엔비디아 아래로 옮기기").props.accessibilityState).toEqual({ disabled: true });
    press(r, "삼성전자 위로 옮기기");
    expect(ops.move).toHaveBeenLastCalledWith(STOCKS[1], 7, 0, "삼성전자를 반도체 1번째로 옮겼습니다");
    const row = r.byLabel("SK하이닉스, 반도체 1번째, 3종목 중");
    expect((row.props.accessibilityActions as { name: string }[]).map((a) => a.name)).toEqual(["down", "bottom", "group"]);
    r.act(() => (row.props.onAccessibilityAction as (e: unknown) => void)({ nativeEvent: { actionName: "bottom" } }));
    expect(ops.move).toHaveBeenLastCalledWith(STOCKS[2], 7, 2, "SK하이닉스를 반도체 3번째로 옮겼습니다");
    // 끌기 손잡이는 화면 읽기에서 숨김 (버튼·동작으로 같은 일)
    for (const g of byType(r, "GestureDetector")) expect((g.children[0] as HostNode).props.accessibilityElementsHidden).toBe(true);
  });

  it("⋯ 시트: 그룹 옮기기 › · 맨 위로(첫 줄은 사용 불가) · 맨 아래로 · 닫기 → 그룹 고르기(지금 그룹 표시) → 다른 그룹 맨 끝으로", () => {
    const r = draw(state());
    press(r, "SK하이닉스 메뉴");
    expect(r.text()).toContain("지금: 반도체 · 1번째 (3종목 중)");
    expect(r.byLabel("맨 위로 옮기기").props.accessibilityState).toEqual({ disabled: true });
    expect(r.has("맨 아래로 옮기기")).toBe(true);
    press(r, "그룹 옮기기");
    expect(r.text()).toContain("‘SK하이닉스’ 옮길 그룹");
    expect(r.byLabel("반도체, 지금 그룹").props.accessibilityState).toEqual({ checked: true });
    expect(r.byLabel("배당").props.accessibilityRole).toBe("radio");
    expect(r.has("새 그룹 만들고 옮기기")).toBe(true);
    press(r, "배당");
    expect(ops.move).toHaveBeenCalledWith(STOCKS[2], 3, 2, "SK하이닉스를 배당 그룹 맨 끝으로 옮겼습니다");
    expect(r.has("‘SK하이닉스’ 옮길 그룹")).toBe(false);
  });

  it("≡ 를 길게 눌러 끌면 다른 줄 가운데를 지날 때 목표 칸이 바뀌고, 놓으면 그 자리로 저장 (바깥 스크롤은 끄는 동안 멈춤)", () => {
    const r = draw(state());
    // 줄 높이 56 씩 (onLayout)
    const rows = r.all().filter((n) => n.type === "View" && typeof n.props.onLayout === "function" && n.children.some((c) => typeof c !== "string" && c.type === "GestureDetector"));
    expect(rows).toHaveLength(3);
    r.act(() => rows.forEach((n) => (n.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { height: 56 } } })));
    const g = (byType(r, "GestureDetector")[0]!.props.gesture as { handlers: Record<string, (e?: unknown) => void> }).handlers;
    r.act(() => g.onStart!());
    expect(byType(r, "ScrollView")[0]!.props.scrollEnabled).toBe(false);
    r.act(() => g.onUpdate!({ translationY: 60 }));
    r.act(() => g.onUpdate!({ translationY: 120 }));
    r.act(() => g.onFinalize!());
    expect(ops.move).toHaveBeenCalledWith(STOCKS[2], 7, 2, "SK하이닉스를 반도체 3번째로 옮겼습니다");
    expect(byType(r, "ScrollView")[0]!.props.scrollEnabled).toBe(true);
    // 제자리에 놓으면 저장하지 않는다
    ops.move.mockReset();
    r.act(() => g.onStart!());
    r.act(() => g.onUpdate!({ translationY: 10 }));
    r.act(() => g.onFinalize!());
    expect(ops.move).not.toHaveBeenCalled();
  });

  it("정렬이 등록순이 아니면 카드 위 안내 + '등록순으로 보기'", () => {
    h.sort = "changeRate";
    const r = draw(state());
    expect(r.text()).toContain("지금 잔고는 ‘등락률’ 순으로 보고 있어, 여기서 정한 순서는 정렬을 ‘등록순’으로 바꾸면 보입니다.");
    (byType(r, "Button").find((b) => b.props.title === "등록순으로 보기")!.props.onPress as () => void)();
    expect(h.setSort).toHaveBeenCalledWith("created");
    h.sort = "created";
    expect(draw(state()).text()).not.toContain("지금 잔고는");
  });

  it("그룹 0개: 제목 '관심 종목 순서', 칩 없이 관심 전체 · 관심 0개: 안내 · 빈 그룹: 안내", () => {
    const none = draw(state({ layout: { on: true, groups: [], items: [] } }));
    expect(none.text()).toContain("관심 종목 순서");
    expect(byType(none, "Chip")).toHaveLength(0);
    expect(orderRows(none)[0]).toBe("삼성전자, 관심 1번째, 6종목 중");
    h.stocks = STOCKS.slice(0, 1);
    expect(draw(state()).text()).toContain("관심 종목이 없습니다. 종목 화면의 ‘관심 추가’로 모은 뒤 순서를 정할 수 있습니다.");
    h.stocks = STOCKS;
    const empty = draw(state({ layout: { ...LAYOUT, groups: [...LAYOUT.groups, { id: 9, name: "빈 그룹", position: 2 }] }, view: { selected: 9, collapsed: [] } }));
    expect(empty.text()).toContain("이 그룹에 종목이 없습니다. 다른 그룹 종목의 ⋯ 에서 ‘그룹 옮기기’로 넣으세요.");
  });
});

describe("넓은 창", () => {
  it("펼친 폴드 가로(933×704, foldLayout): 두 칸 — 왼쪽 그룹 · 오른쪽 종목 순서", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { foldLayout: true };
    const r = draw(state());
    const pane = byType(r, "TwoPane")[0]!;
    const [left, right] = pane.children as HostNode[];
    expect(JSON.stringify(left)).toContain("반도체 그룹 메뉴");
    expect(JSON.stringify(right)).toContain("삼성전자 위로 옮기기");
  });
  it("펼친 세로(704×933)는 한 칸, 읽기 폭 가운데", () => {
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    h.flags = { foldLayout: true };
    const r = draw(state());
    expect(byType(r, "TwoPane")).toHaveLength(0);
    expect(JSON.stringify(byType(r, "ScrollView")[0]!.props.contentContainerStyle)).toContain('"maxWidth":720');
  });
});
