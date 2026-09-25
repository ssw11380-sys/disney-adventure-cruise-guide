import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, Briefing, BriefingWithData } from "@/api/types";
import { render, type HostNode } from "./miniRender";

/**
 * 넓은 창 브리핑 (3-42 웨이브 D, 기능 플래그 foldLayout).
 *  - 플래그가 꺼져 있거나 좁은 창(접은 화면)이면 브리핑 탭·브리핑 상세·계좌 브리핑 상세가 지금과 똑같다 (창 크기와 상관없이 같은 트리)
 *  - 2단(펼친 폴드8 가로·울트라 펼침): 왼쪽 목록 | 오른쪽 본문. 처음엔 첫 미확인이 골라져 있고, 누르면 오른쪽만 바뀐다(주소 그대로)
 *  - 카드 격자(펼친 폴드8 세로): 도구 한 줄 · 계좌 줄 · 2열 카드. 누르면 전체 화면 브리핑
 *  - 접고 펴기: 고른 브리핑을 기억해 접으면 그 카드만 강조하고 그 위치로 한 번 스크롤(열지 않음), 펴면 다시 골라져 있다
 *  - 전체 화면 상세는 넓은 창에서 두 칸, 알림 주소는 그대로
 * RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 679, scale: 2.625, fontScale: 1 },
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
  flags: {} as Record<string, boolean>,
  params: { id: "512" } as { id?: string },
  push: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  store: new Map<string, string>(),
  latest: [] as unknown[],
  stocks: [] as unknown[],
  accounts: [] as unknown[],
  accountDetail: null as unknown,
  briefingIds: [] as number[],
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({
  router: { push: h.push, replace: h.replace, dismissTo: h.dismissTo },
  Stack: { Screen: "StackScreen" },
  Tabs: { Screen: "TabsScreen" },
  useLocalSearchParams: () => h.params,
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: data !== undefined, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useLatestBriefings: () => q(h.latest),
    useRegisteredStocks: () => q(h.stocks),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(undefined),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.accountDetail : undefined),
    useBriefing: (id: number) => {
      h.briefingIds.push(id);
      return q(DETAIL(id));
    },
    useBriefings: (f: { code?: string }, enabled: boolean) => q(enabled ? [DETAIL(BY_CODE[f.code!]!), { ...DETAIL(900), code: f.code, date: "2026-09-24" }] : undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { default: BriefingDetailScreen } = await import("@/app/briefings/[id]");
const { default: AccountBriefingScreen } = await import("@/app/briefings/account/[id]");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");
const { foldBriefings: FB, space, touch, slopFor } = await import("@/tokens");

const B = (id: number, code: string, name: string, date: string, session: "morning" | "afternoon", over: Partial<Briefing> = {}): Briefing => ({
  id, code, name, session, date, status: "ok", summary: `${name} 요약 첫 줄\n둘째 줄`, detail: `## 한 줄 요약\n${name}`, missing: [], model: "m", error: null, createdAt: `${date}T${session === "morning" ? "08:02" : "16:10"}:00+09:00`, ...over,
});
const LIST: { code: string; name: string; latest: Briefing | null }[] = [
  { code: "005930", name: "삼성전자", latest: B(500, "005930", "삼성전자", "2026-09-23", "afternoon") },
  { code: "AAPL", name: "애플", latest: B(509, "AAPL", "애플", "2026-09-25", "morning") },
  { code: "NVDA", name: "엔비디아", latest: B(510, "NVDA", "엔비디아", "2026-09-25", "morning") },
  { code: "QNTM", name: "퀀티넘", latest: B(512, "QNTM", "퀀티넘", "2026-09-25", "morning") },
  { code: "TSLA", name: "테슬라", latest: B(513, "TSLA", "테슬라", "2026-09-25", "morning") },
  { code: "ZZZ", name: "브리핑없는종목", latest: null },
];
const RATES: Record<string, number> = { "005930": 1.44, AAPL: -1.59, NVDA: 1.74, QNTM: 6, TSLA: -1.44 };
const BY_CODE: Record<string, number> = Object.fromEntries(LIST.filter((i) => i.latest).map((i) => [i.code, i.latest!.id]));
function DETAIL(id: number): BriefingWithData {
  const item = LIST.find((i) => i.latest?.id === id);
  const b = item?.latest ?? B(id, "QNTM", "퀀티넘", "2026-09-24", "morning");
  return {
    ...b,
    data: {
      quote: { code: b.code, price: 41.85, change: 2.37, changeRate: 6, currency: "USD", asOf: "2026-09-25T08:01:00+09:00", source: "toss" } as unknown as NonNullable<BriefingWithData["data"]>["quote"],
      technical: null,
      news: [],
      disclosures: [],
      holding: { profit: 389.25, profitRate: 26.05, marketValue: 1883 },
      missing: [],
    },
  };
}
const ACCOUNT_DATA: AccountData = {
  version: 1, session: "morning", date: "2026-09-25", asOf: "2026-09-25T08:03:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 17, stale: 0,
  totalValue: 71_445_875, totalCost: 54_699_110, totalProfit: 16_746_765, totalProfitRate: 30.62, dayPnl: 423_788, dayRate: 0.6,
  contributions: [{ code: "NVDA", name: "엔비디아", currency: "USD", amount: 169_763, changeRate: 1.74, value: 9_900_000 }],
  others: { count: 16, amount: 254_025 },
  markets: { kr: { count: 9, value: 1, day: 194_900, dayRate: 0.62 }, us: { count: 8, value: 1, day: 228_888, dayRate: 0.58 } },
  excluded: [],
  fx: { status: "computed", reason: null, usdKrw: { value: 1391.5, change: 4.3, changeRate: 0.31, stale: false }, appliedRate: 1391.5, usdHoldingsKrwChange: 351_894, priceEffect: 228_888, fxEffect: 123_006 },
  indices: [{ code: "KOSPI", name: "코스피", value: 3478.12, change: 29.2, changeRate: 0.85, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-09-25", tradingDay: false, now: "한국 휴장일", hours: null, nextOpen: "2026-09-27T23:00:00.000Z" }, us: { date: "2026-09-25", tradingDay: true, now: "미국 프리마켓", hours: "정규장" }, disclosures: [] },
  narrative: { source: "template", reason: null },
};
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-25", session: "morning", status: "ok", summary: "당일 +423,788원 (+0.60%) · 기여 1위 엔비디아 +169,763원", detail: "- 설명", model: "m", template: true, createdAt: "2026-09-25T08:03:00+09:00",
  headline: { totalValue: 71_445_875, dayPnl: 423_788, dayRate: 0.6, holdings: 17, top: [{ code: "NVDA", name: "엔비디아", amount: 169_763, changeRate: 1.74 }] },
};

type R = ReturnType<typeof render>;
const size = (width: number, height: number, fontScale = 1) => {
  h.win = { width, height, scale: 2.625, fontScale };
};
const SIZES = { F8C: [475, 679], UC: [411, 888], F8L: [933, 632], F8P: [704, 861], UP: [859, 882], UL: [954, 787] } as const;
const flat = (n: HostNode, key = "style"): Record<string, unknown> => {
  const v = n.props[key];
  return Object.assign({}, ...[typeof v === "function" ? (v as (s: { pressed: boolean }) => unknown)({ pressed: false }) : v].flat(Infinity).filter(Boolean));
};
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
/** 목록 줄·카드 (지난 브리핑 줄은 날짜로 시작해서 뺀다) */
const rowNodes = (r: R) => r.all().filter((n) => n.type === "Pressable" && /\d+월 \d+일 \([^)]+\) (오전|오후) 브리핑/.test(String(n.props.accessibilityLabel ?? "")) && !/^(내 계좌|\d+월)/.test(String(n.props.accessibilityLabel)));
const press = (r: R, n: HostNode) => r.act(() => (n.props.onPress as () => void)());
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};

/** 트리를 비교할 수 있는 값으로 (함수는 "fn", 요소는 이름) */
function norm(n: HostNode | string): unknown {
  if (typeof n === "string") return n;
  const props = Object.fromEntries(
    Object.entries(n.props)
      .filter(([k]) => k !== "children")
      .map(([k, v]) => [k, typeof v === "function" ? "fn" : React.isValidElement(v) ? `<${String((v.type as { name?: string }).name ?? v.type)}>` : v]),
  );
  return { t: n.type, p: props, c: n.children.map(norm) };
}
const tree = (r: R) => JSON.stringify(r.tree.map(norm));
const withoutTabsScreen = (r: R) => JSON.stringify(r.tree.map(norm), (_k, v: unknown) => (Array.isArray(v) ? v.filter((x) => !(x && typeof x === "object" && (x as { t?: string }).t === "TabsScreen")) : v));

beforeEach(() => {
  size(475, 679);
  h.insets = { top: 0, bottom: 0, left: 0, right: 0 };
  h.flags = { briefingTabMovers: true, briefingManualRun: true, accountBriefing: true, briefingSources: true };
  h.params = { id: "512" };
  h.push.mockReset();
  h.replace.mockReset();
  h.dismissTo.mockReset();
  h.store.clear();
  h.latest = LIST;
  h.stocks = Object.entries(RATES).map(([code, changeRate]) => ({ code, quote: { changeRate } }));
  h.accounts = [ACCOUNT];
  h.accountDetail = { ...ACCOUNT, data: ACCOUNT_DATA } satisfies AccountBriefingWithData;
  h.briefingIds = [];
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("플래그가 꺼져 있거나 좁은 창이면 지금 그대로", () => {
  it.each(Object.keys(SIZES))("플래그 꺼짐: %s 에서도 접은 화면과 같은 트리 (창 크기를 보지 않는다)", (key) => {
    const base = tree(render(<BriefingsScreen />));
    const [w, hh] = SIZES[key as keyof typeof SIZES];
    size(w, hh);
    forgetWindowClass();
    expect(tree(render(<BriefingsScreen />))).toBe(base);
  });

  it("플래그 꺼짐의 탭 = 예전 구조: 계좌 카드 → 변동 큰 종목 → 정렬 · 보기 탭 → 카드 → 수동 생성 → 브리핑 없음 (탭 머리·저장소를 건드리지 않음)", async () => {
    size(933, 632);
    const r = render(<BriefingsScreen />);
    await settle(r);
    const screen = ofType(r, "Screen")[0]!;
    expect(screen.props.disclaimer).toBe(true);
    expect(screen.props).not.toHaveProperty("scrollRef");
    const kids = screen.children.filter((c): c is HostNode => typeof c !== "string").map((c) => c.type);
    expect(kids).toEqual(["Card", "Card", "Segmented", "Segmented", "BriefingCard", "BriefingCard", "BriefingCard", "BriefingCard", "BriefingCard", "Card", "Muted"]);
    expect(r.text()).toContain("변동 큰 종목");
    expect(ofType(r, "TabsScreen")).toHaveLength(0);
    expect(ofType(r, "BriefingCard").every((c) => c.props.selected === false)).toBe(true);
    expect(rowNodes(r)).toHaveLength(0);
    expect(h.store.size).toBe(0);
  });

  it.each(["F8C", "UC"] as const)("플래그 켜짐 + %s(접은 화면): 탭 머리를 보이게 두는 것 말고는 꺼진 것과 같다", (key) => {
    const off = withoutTabsScreen(render(<BriefingsScreen />));
    h.flags.foldLayout = true;
    size(...(SIZES[key] as unknown as [number, number]));
    const r = render(<BriefingsScreen />);
    expect(withoutTabsScreen(r)).toBe(off);
    expect(ofType(r, "TabsScreen").map((n) => n.props.options)).toEqual([{ headerShown: true }]);
  });
});

describe("2단 (펼친 폴드8 가로 933×632 · 울트라 펼침)", () => {
  const open = async (w = 933, hh = 632, read: number[] = [512]) => {
    h.flags.foldLayout = true;
    h.store.set("briefings.read", JSON.stringify(read));
    size(w, hh);
    const r = render(<BriefingsScreen />);
    await settle(r);
    return r;
  };

  it("탭 머리를 숨기고 목록 머리에 제목 · 변동 큰 순|등록순 (한 줄/요약/상세·변동 큰 종목 카드 없음)", async () => {
    const r = await open();
    expect(ofType(r, "TabsScreen").map((n) => n.props.options)).toEqual([{ headerShown: false }]);
    expect(r.all().some((n) => n.type === "Text" && n.props.accessibilityRole === "header" && n.children[0] === "브리핑")).toBe(true);
    const tabs = r.all().filter((n) => n.props.accessibilityRole === "tablist").map((n) => n.props.accessibilityLabel);
    expect(tabs).toEqual(["정렬", "브리핑 보기"]);
    expect(r.text()).not.toContain("변동 큰 종목");
    expect(r.all().some((n) => n.props.accessibilityRole === "tab" && n.props.accessibilityLabel === "한 줄")).toBe(false);
    expect(ofType(r, "Segmented")).toHaveLength(0);
    // '변동 큰 종목' 카드의 기준 문구는 목록 위 안내로
    expect(r.text()).toContain("변동 큰 순 = 전일 대비 등락률 크기 순");
  });

  it("목록 줄: 변동 큰 순 · 1~3위 표시 · 이름 옆 등락률 · 미확인 점(가장 최근 세션 + 연 적 없음)", async () => {
    const r = await open();
    const rows = rowNodes(r).map((n) => String(n.props.accessibilityLabel));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe("변동 큰 순 1위, 퀀티넘, 6.00% 상승, 9월 25일 (금) 오전 브리핑, 퀀티넘 요약 첫 줄");
    expect(rows[1]).toMatch(/^변동 큰 순 2위, 엔비디아, 1\.74% 상승/);
    expect(rows[2]).toMatch(/^읽지 않음, 변동 큰 순 3위, 애플, 1\.59% 하락/);
    expect(rows[3]).toMatch(/^삼성전자, 1\.44% 상승, 9월 23일 \(수\) 오후 브리핑/);
    expect(rows[4]).toMatch(/^읽지 않음, 테슬라/);
    // 줄 높이 56 · 누르는 크기 44 이상
    for (const n of rowNodes(r)) expect(flat(n).minHeight).toBe(FB.rowH);
    expect(FB.rowH).toBeGreaterThanOrEqual(touch.min);
    expect(FB.accountRowH).toBeGreaterThanOrEqual(touch.min);
  });

  it("처음 열면 첫 미확인(엔비디아)이 골라져 오른쪽에 본문 — 누르지 않아도 차 있고, 연 것은 읽음으로 적는다", async () => {
    const r = await open();
    expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 510 }, highlight: true });
    const sel = rowNodes(r).filter((n) => (n.props.accessibilityState as { selected: boolean }).selected);
    expect(sel.map((n) => String(n.props.accessibilityLabel).split(", ")[1])).toEqual(["엔비디아"]);
    // 오른쪽 칸: 본문 머리(이름 header · 종목 보기) + 요약|상세 + 본문 + 고지
    expect(h.briefingIds).toContain(510);
    const heads = r.all().filter((n) => n.type === "Text" && n.props.accessibilityRole === "header").map((n) => n.children.join(""));
    expect(heads).toContain("엔비디아");
    expect(ofType(r, "Button").find((b) => b.props.title === "종목 보기")!.props.accessibilityLabel).toBe("엔비디아 종목 화면으로");
    expect(ofType(r, "Screen").some((s) => s.props.disclaimer === true)).toBe(true);
    await settle(r);
    expect(JSON.parse(h.store.get("briefings.read")!)).toEqual([512, 510]);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("다 읽었으면 맨 위 · 종목 브리핑이 없으면 계좌 브리핑", async () => {
    let r = await open(933, 632, [509, 510, 512, 513]);
    expect(pick.currentPick().pick).toEqual({ kind: "stock", id: 512 });
    r = r; // (같은 화면)
    pick.forgetPick();
    readStore.forgetRead();
    h.latest = [LIST[5]];
    r = await open();
    expect(pick.currentPick().pick).toEqual({ kind: "account", id: 12 });
  });

  it("줄을 누르면 오른쪽 칸만 바뀐다 (주소·뒤로 가기 기록은 그대로)", async () => {
    const r = await open();
    press(r, rowNodes(r).find((n) => String(n.props.accessibilityLabel).includes("테슬라"))!);
    expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 513 }, highlight: true });
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(r.all().filter((n) => n.type === "Text" && n.props.accessibilityRole === "header").map((n) => n.children.join(""))).toContain("테슬라");
    // 오른쪽 칸의 지난 브리핑은 그 칸에서 바꿔 연다 (router.replace 가 아님)
    const past = r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("9월 24일 (목)"))!;
    press(r, past);
    expect(pick.currentPick().pick).toEqual({ kind: "stock", id: 900 });
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("계좌 줄(60)을 누르면 오른쪽 칸에 계좌 브리핑", async () => {
    const r = await open();
    const row = r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("내 계좌 브리핑"))!;
    expect(row.props.accessibilityRole).toBe("button");
    expect(flat(row).minHeight).toBe(FB.accountRowH);
    press(r, row);
    expect(pick.currentPick().pick).toEqual({ kind: "account", id: 12 });
    expect(r.text()).toContain("당일 손익 기여");
    expect(r.text()).toContain("지수·환율 영향");
    expect(h.push).not.toHaveBeenCalled();
    // 2단 오른쪽 칸은 탭 머리 제목을 바꾸지 않는다
    expect(ofType(r, "StackScreen")).toHaveLength(0);
  });

  it("왼쪽 세로 탭 막대가 있는 창(폴드8 가로)은 목록 칸이 왼쪽 화면 여백을 더하지 않고, 아래 탭 바 창(울트라 세로)은 더한다", async () => {
    h.insets = { top: 0, bottom: 0, left: 32, right: 0 };
    let r = await open(933, 632);
    let left = ofType(r, "View").find((n) => flat(n).flexShrink === 0 && typeof flat(n).width === "number")!;
    expect(flat(left).paddingLeft).toBe(0);
    pick.forgetPick();
    forgetWindowClass();
    r = await open(859, 882);
    left = ofType(r, "View").find((n) => flat(n).flexShrink === 0 && typeof flat(n).width === "number")!;
    expect(flat(left).paddingLeft).toBe(32);
  });

  it("미확인 점은 저장소를 다 읽기 전에는 찍지 않는다 (깜빡임 방지)", () => {
    h.flags.foldLayout = true;
    h.store.set("briefings.read", "[]");
    size(933, 632);
    const r = render(<BriefingsScreen />);
    expect(rowNodes(r).some((n) => String(n.props.accessibilityLabel).startsWith("읽지 않음"))).toBe(false);
    expect(pick.currentPick().pick).toBeNull();
  });
});

describe("카드 격자 (펼친 폴드8 세로 704×861)", () => {
  it("도구 한 줄(변동 큰 순|등록순 + 한 줄|요약|상세) · 계좌 줄 · 2열 카드, 누르면 전체 화면 브리핑", async () => {
    h.flags.foldLayout = true;
    size(704, 861);
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(ofType(r, "TabsScreen").map((n) => n.props.options)).toEqual([{ headerShown: false }]);
    const tabs = r.all().filter((n) => n.props.accessibilityRole === "tablist");
    expect(tabs.map((n) => n.props.accessibilityLabel)).toEqual(["정렬", "보기"]);
    // 두 알약이 같은 줄(도구 줄)에
    const tool = r.all().find((n) => n.children.filter((c) => typeof c !== "string" && c.props.accessibilityRole === "tablist").length === 2)!;
    expect(flat(tool)).toMatchObject({ flexDirection: "row", minHeight: FB.headH });
    const tiles = rowNodes(r);
    expect(tiles).toHaveLength(5);
    // 704 − 좌우 12×2 = 680 → 2열, 칸 (680 − 8) / 2 = 336
    expect(tiles.map((n) => flat(n).width)).toEqual(Array(5).fill(336));
    expect(tiles.every((n) => n.props.accessibilityRole === "link")).toBe(true);
    press(r, tiles[0]!);
    expect(h.push).toHaveBeenCalledWith("/briefings/512");
    // 2단이 아니므로 자동으로 고르지 않는다
    expect(pick.currentPick().pick).toBeNull();
    const acct = r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("내 계좌 브리핑"))!;
    expect(acct.props.accessibilityRole).toBe("link");
    press(r, acct);
    expect(h.push).toHaveBeenLastCalledWith("/briefings/account/12");
    expect(ofType(r, "Screen")[0]!.props.disclaimer).toBe(true);
  });

  it("큰 글씨(130%)는 칸이 넓어져 1열", async () => {
    h.flags.foldLayout = true;
    size(704, 861, 1.3);
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(rowNodes(r).map((n) => flat(n).width)).toEqual(Array(5).fill(680));
  });
});

describe("접고 펴기 이어 보기", () => {
  it("펼쳐 고른 브리핑 → 접으면 그 카드만 강조하고 한 번 그 위치로 스크롤(열지 않음) → 다시 펴면 골라져 있다", async () => {
    h.flags.foldLayout = true;
    size(933, 632);
    const r = render(<BriefingsScreen />);
    await settle(r);
    press(r, rowNodes(r).find((n) => String(n.props.accessibilityLabel).includes("애플"))!);
    expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 509 }, highlight: true });

    size(475, 679);
    r.rerender();
    expect(ofType(r, "TwoPane")).toHaveLength(0);
    const cards = ofType(r, "BriefingCard");
    expect(cards.filter((c) => c.props.selected).map((c) => (c.props.briefing as Briefing).id)).toEqual([509]);
    const wrap = r.all().find((n) => n.type === "View" && typeof n.props.onLayout === "function" && n.children.some((c) => typeof c !== "string" && c.type === "BriefingCard"))!;
    const screen = ofType(r, "Screen")[0]!;
    const ref = screen.props.scrollRef as { current: unknown };
    const scrollTo = vi.fn();
    ref.current = { scrollTo };
    const layout = (y: number) => (wrap.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y, width: 475, height: 120 } } });
    layout(900);
    expect(scrollTo).toHaveBeenCalledWith({ y: 900 - space.xl, animated: false });
    layout(950);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
    expect(ofType(r, "TabsScreen").map((n) => n.props.options)).toEqual([{ headerShown: true }]);

    size(933, 632);
    r.rerender();
    expect(rowNodes(r).filter((n) => (n.props.accessibilityState as { selected: boolean }).selected).map((n) => String(n.props.accessibilityLabel))).toEqual([expect.stringContaining("애플")]);
    expect(h.briefingIds.at(-1)).toBe(509);
  });

  it("접은 채로 연 브리핑은 강조하지 않는다 (접은 화면만 쓰면 지금과 똑같다) · 그래도 펴면 그 브리핑이 골라져 있다", async () => {
    h.flags.foldLayout = true;
    h.params = { id: "513" };
    const d = render(<BriefingDetailScreen />);
    expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 513 }, highlight: false });
    await settle(d);
    expect(JSON.parse(h.store.get("briefings.read")!)).toEqual([513]);
    const r = render(<BriefingsScreen />);
    expect(ofType(r, "BriefingCard").every((c) => c.props.selected === false)).toBe(true);
    expect(ofType(r, "Screen")[0]!.props).not.toHaveProperty("scrollRef");
    size(933, 632);
    r.rerender();
    await settle(r);
    expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 513 }, highlight: true });
  });
});

describe("전체 화면 브리핑 상세 (알림·위젯·종목 상세에서 여는 /briefings/<id>)", () => {
  it.each(Object.keys(SIZES))("플래그 꺼짐: %s 에서도 지금 폰 화면 그대로 (기억·저장소를 건드리지 않음)", async (key) => {
    const base = tree(render(<BriefingDetailScreen />));
    const [w, hh] = SIZES[key as keyof typeof SIZES];
    size(w, hh);
    forgetWindowClass();
    const r = render(<BriefingDetailScreen />);
    expect(tree(r)).toBe(base);
    await settle(r);
    expect(pick.currentPick().pick).toBeNull();
    expect(h.store.size).toBe(0);
  });

  it("폰 화면 구조: 이름 링크 → 날짜 → 시세 칸 → 요약|상세 탭 → 본문 카드 → 근거 → 다시 만들기 → 지난 브리핑(주소 바꿔 끼움)", () => {
    const r = render(<BriefingDetailScreen />);
    const screen = ofType(r, "Screen")[0]!;
    expect(screen.props.disclaimer).toBe(true);
    expect(screen.props.scroll).toBeUndefined();
    expect(ofType(r, "StackScreen")[0]!.props.options).toEqual({ title: "퀀티넘 · 오전" });
    const kids = screen.children.filter((c): c is HostNode => typeof c !== "string").map((c) => c.type);
    expect(kids).toEqual(["StackScreen", "View", "Card", "Segmented", "Card", "BriefingSources", "View", "View"]);
    expect(r.byLabel("퀀티넘 종목 화면으로").props.accessibilityRole).toBe("link");
    expect(ofType(r, "Row").map((n) => n.props.label)).toEqual(["브리핑 시점 가격", "전일 대비", "보유 손익"]);
    press(r, r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("9월 24일 (목)"))!);
    expect(h.replace).toHaveBeenCalledWith("/briefings/900");
  });

  it("넓은 창(폴드8 가로·세로)은 두 칸: 왼쪽 머리·숫자·근거·지난 브리핑 | 오른쪽 요약|상세·본문 (칸마다 스크롤, 고지는 아래)", () => {
    h.flags.foldLayout = true;
    for (const [w, hh, side] of [[933, 632, FB.sideW], [704, 861, FB.sideNarrowW]] as const) {
      size(w, hh);
      forgetWindowClass();
      pick.forgetPick();
      const r = render(<BriefingDetailScreen />);
      const screen = ofType(r, "Screen")[0]!;
      expect(screen.props).toMatchObject({ scroll: false, disclaimer: true });
      const cols = ofType(r, "ScrollView");
      expect(cols).toHaveLength(2);
      expect(flat(cols[0]!)).toMatchObject({ width: side, flexShrink: 0 });
      const leftText = JSON.stringify(cols[0]!.children.map(norm));
      const rightText = JSON.stringify(cols[1]!.children.map(norm));
      expect(leftText).toContain("종목 보기");
      expect(leftText).toContain("BriefingSources");
      expect(leftText).toContain("지난 브리핑");
      expect(rightText).toContain("브리핑 보기");
      expect(rightText).toContain("MarkdownView");
      // 숫자 칸: 라벨 위·숫자 아래, 한 문장으로 읽힘
      expect(labels(r)).toContain("전일 대비, 2.37달러 상승, 6.00% 상승");
      expect(labels(r)).toContain("보유 손익, 389.25달러 이익, 수익률 26.05% 상승");
      // 넓은 창에서 연 것 → 접으면 폰 목록에서 강조
      expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 512 }, highlight: true });
      // 지난 브리핑은 지금처럼 주소를 바꿔 끼운다
      press(r, r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("9월 24일 (목)"))!);
      expect(h.replace).toHaveBeenLastCalledWith("/briefings/900");
    }
  });

  it("잘못된 주소는 요청·기억 없이 안내", () => {
    h.flags.foldLayout = true;
    size(933, 632);
    h.params = { id: "abc" };
    const r = render(<BriefingDetailScreen />);
    expect(ofType(r, "ErrorView")).toHaveLength(1);
    expect(h.briefingIds).toEqual([]);
    expect(pick.currentPick().pick).toBeNull();
  });
});

describe("계좌 브리핑 상세", () => {
  it("플래그 꺼짐이면 넓은 창에서도 폰 화면 그대로", () => {
    h.params = { id: "12" };
    const base = tree(render(<AccountBriefingScreen />));
    size(933, 632);
    forgetWindowClass();
    expect(tree(render(<AccountBriefingScreen />))).toBe(base);
  });

  it("넓은 창은 두 칸: 왼쪽 요약·총 평가 띠·기여 표 | 오른쪽 지수·환율·오늘 일정·설명", () => {
    h.flags.foldLayout = true;
    h.params = { id: "12" };
    size(933, 632);
    const r = render(<AccountBriefingScreen />);
    expect(ofType(r, "Screen")[0]!.props).toMatchObject({ scroll: false, disclaimer: true });
    const [left, right] = ofType(r, "ScrollView");
    const l = JSON.stringify(left!.children.map(norm));
    const rr = JSON.stringify(right!.children.map(norm));
    for (const s of ["내 계좌 브리핑", "총 평가금액", "71,445,875원", "당일 손익 기여"]) expect(l, s).toContain(s);
    for (const s of ["지수·환율 영향", "오늘 일정", "무엇이 계좌를 움직였나"]) expect(rr, s).toContain(s);
    // 두 칸은 반씩
    expect(flat(left!)).toMatchObject({ flex: 1 });
    // 총 평가 띠도 폰 카드와 같은 한 문장으로 읽힌다
    expect(labels(r)).toContain("총 평가금액 71,445,875원, 당일손익 423,788원 이익, 0.60% 상승, 평가손익 16,746,765원 이익, 수익률 30.62% 상승, 보유 17종목");
    expect(pick.currentPick()).toEqual({ pick: { kind: "account", id: 12 }, highlight: true });
  });
});

describe("순수 함수", () => {
  const b = (id: number, date: string, session: "morning" | "afternoon", status: "ok" | "failed" = "ok") => ({ id, date, session, status });

  it("미확인 = 가장 최근 세션 + 성공 + 연 적 없음 / 처음 고를 것 = 보이는 순서에서 첫 미확인, 없으면 맨 위", () => {
    const list = [b(1, "2026-09-23", "afternoon"), b(2, "2026-09-25", "morning", "failed"), b(3, "2026-09-25", "morning"), b(4, "2026-09-24", "afternoon")];
    const latest = pick.latestSession(list);
    expect(list.map((x) => pick.isUnread(x, new Set(), latest))).toEqual([false, false, true, false]);
    expect(pick.firstPick(list, new Set())).toBe(3);
    expect(pick.firstPick(list, new Set([3]))).toBe(1);
    expect(pick.firstPick([], new Set())).toBeNull();
    // 오후가 오전보다 최근
    expect(pick.latestSession([b(1, "2026-09-25", "morning"), b(2, "2026-09-25", "afternoon")])).toBe("2026-09-25-1");
  });

  it("짧은 시각 · 같은 날 만든 시각", () => {
    expect(pick.briefingWhen({ date: "2026-09-05", session: "afternoon" })).toBe("9/5 오후");
    expect(pick.createdTimeSameDay({ date: "2026-09-25", createdAt: "2026-09-25T08:02:00+09:00" })).toBe("08:02");
    // 한국 자정 넘어 만든 것(전날 브리핑)은 날짜까지 쓰게 null
    expect(pick.createdTimeSameDay({ date: "2026-09-24", createdAt: "2026-09-24T15:30:00Z" })).toBeNull();
    expect(pick.createdTimeSameDay({ date: "2026-09-24", createdAt: "x" })).toBeNull();
  });

  it("카드 열 수: 폴드8 세로 2열 · 울트라 큰 글씨 2열 · 좁으면 1열 · 최대 3열", () => {
    const o = { minW: FB.cardMinW, gap: space.sm, max: FB.cardMaxCols, cap: 1.4 };
    expect(pick.gridColumns(680, 1, o)).toBe(2);
    expect(pick.gridColumns(680, 1.3, o)).toBe(1);
    expect(pick.gridColumns(835, 1.4, o)).toBe(2);
    expect(pick.gridColumns(2000, 1, o)).toBe(3);
    expect(pick.gridColumns(0, 1, o)).toBe(1);
  });

  it("고른 것 저장소: 같은 값이면 알리지 않는다", () => {
    pick.pickBriefing({ kind: "stock", id: 1 }, { highlight: true });
    const s = pick.currentPick();
    pick.pickBriefing({ kind: "stock", id: 1 }, { highlight: true });
    expect(pick.currentPick()).toBe(s);
    expect(pick.samePick({ kind: "stock", id: 1 }, { kind: "account", id: 1 })).toBe(false);
    expect(pick.samePick(null, null)).toBe(true);
  });

  it("읽은 기록: 불러오기 전에 적은 것도 합쳐 저장하고 최근 300개만", async () => {
    h.store.set("briefings.read", JSON.stringify([1, 2, "x", -3]));
    readStore.markBriefingRead(5);
    readStore.markBriefingRead(2);
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    expect(JSON.parse(h.store.get("briefings.read")!)).toEqual([1, 5, 2]);
    for (let i = 10; i < 400; i++) readStore.markBriefingRead(i);
    await new Promise((res) => setTimeout(res, 0));
    expect(JSON.parse(h.store.get("briefings.read")!)).toHaveLength(300);
  });

  it("알약 선택 칸: 보이는 34 + 위아래 hitSlop = 44", () => {
    const s = slopFor(FB.pillH);
    expect(FB.pillH + s.top + s.bottom).toBeGreaterThanOrEqual(touch.min);
  });
});
