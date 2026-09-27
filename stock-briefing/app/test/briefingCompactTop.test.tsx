import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, Briefing, MarketSummary, MarketSummaryData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 2차 2 — 맨 위 두 줄(계좌 먼저) (플래그 briefingCompactTop, 앱만 · 앱 fallback 꺼짐).
 *  - 꺼짐(앱 기본): 접은 화면 맨 위는 지금처럼 시장 요약 카드 → 계좌 카드, 넓은 창은 시장 줄 → 계좌 줄
 *  - 켬(접은 화면): 맨 위 묶음 <View> 하나 = 계좌 줄(링크) → 시장 줄(링크) → 안내 한 줄. 시장 줄 안 휴장 줄·다음 개장, 계좌 줄 휴장 줄
 *    (브리핑 날짜가 오늘이 아니면 날짜 모양), 시장 줄이 한국 휴장을 말하면 탭 휴장 줄 숨김(briefingTrim 과 상관없이)
 *  - 켬(넓은 창 2단·카드 격자): 계좌 줄이 시장 줄 위, 한국 휴장이면 목록 위 안내에서 휴장 글을 뺌
 * 시계는 고정 (useNow), RN 부품·공용 UI·종목 카드는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:40:00+09:00"),
  market: undefined as unknown,
  summaries: [] as unknown[],
  accounts: [] as unknown[],
  latest: [] as unknown[],
  stocks: [] as unknown[],
  push: vi.fn(),
  store: new Map<string, string>(),
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
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => ({ id: "12" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/lib/useNow", () => ({ useNow: () => h.now }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: data !== undefined, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: (enabled: boolean) => q(enabled ? h.summaries : undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q(h.latest),
    useRegisteredStocks: () => q(h.stocks),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(h.market),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");

const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
const summaryItem = (id: number, data: MarketSummaryData, status: "ok" | "failed" = "ok"): MarketSummary => ({ id, date: data.date, session: data.session, market: data.market, status, summary: status === "ok" ? "요약" : "지수를 받지 못했습니다", createdAt: data.asOf, data: status === "ok" ? data : null });
/** 월 9/28 아침 미국 요약 (금요일 미국 장) */
const US_MORNING = summaryItem(7, shared.cases[0]!.data);
/** 금 9/25 오후 한국 휴장(추석) 요약 — 다음 개장 9/28(월) 09:00 */
const KR_HOLIDAY = summaryItem(8, shared.cases[2]!.data);

const B = (id: number, code: string, name: string, date: string, session: "morning" | "afternoon"): Briefing => ({
  id, code, name, session, date, status: "ok", summary: `${name} 요약`, detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: `${date}T${session === "morning" ? "08:32" : "16:10"}:00+09:00`,
});
const LIST = [
  { code: "RGTX", name: "RGTX", latest: B(501, "RGTX", "RGTX", "2026-09-28", "morning") },
  { code: "SOXL", name: "SOXL", latest: B(502, "SOXL", "SOXL", "2026-09-28", "morning") },
  { code: "MSFT", name: "마이크로소프트", latest: B(503, "MSFT", "마이크로소프트", "2026-09-28", "morning") },
  { code: "005930", name: "삼성전자", latest: B(504, "005930", "삼성전자", "2026-09-25", "afternoon") },
];
const STOCKS = [
  { code: "RGTX", quote: { changeRate: -6.44 } },
  { code: "SOXL", quote: { changeRate: 4.17 } },
  { code: "MSFT", quote: { changeRate: 3.66 } },
  { code: "005930", quote: { changeRate: 3.56 } },
];

/** 월 9/28 08:38 오전 계좌 브리핑 (목업 숫자) */
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-28", session: "morning", status: "ok",
  summary: "당일 +718,599원 (+0.77%) · 기여 1위 삼성전자 +348,000원", detail: "- 설명", model: "template", template: true, createdAt: "2026-09-28T08:38:00+09:00",
  headline: {
    totalValue: 93_786_000, dayPnl: 718_599, dayRate: 0.77, holdings: 17,
    top: [
      { code: "005930", name: "삼성전자", amount: 348_000, changeRate: 3.56 },
      { code: "MSFT", name: "마이크로소프트", amount: 304_088, changeRate: 3.66 },
      { code: "SOXL", name: "SOXL", amount: 257_494, changeRate: 4.17 },
    ],
  },
};
/** 금 9/25 16:08 오후 계좌 브리핑 (추석 — 국내 종목은 직전 거래일 등락) */
const ACCOUNT_KR_HOLIDAY: AccountBriefing = { ...ACCOUNT, id: 13, date: "2026-09-25", session: "afternoon", createdAt: "2026-09-25T16:08:00+09:00", headline: { ...ACCOUNT.headline!, krPreviousDay: true } };
/** 금 11/27 08:36 오전 계좌 브리핑 (지난밤 11/26 추수감사절 미국 휴장) */
const ACCOUNT_US_HOLIDAY: AccountBriefing = { ...ACCOUNT, id: 14, date: "2026-11-27", session: "morning", createdAt: "2026-11-27T08:36:00+09:00", headline: { ...ACCOUNT.headline!, usPreviousDay: true, usHolidayDate: "2026-11-26" } };

const KR_LINE_OLD = "오늘 한국 휴장 · 국내 종목은 직전 거래일 등락";
const KR_LINE_DATE = "9/25(금) 한국 휴장 · 국내 종목은 직전 거래일 등락";
const NOTE_BOTH = "시장·계좌 요약은 숫자로 만든 것 · 매매 권유가 아닙니다";

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
const muted = (r: R) => ofType(r, "Muted").map(rawOf);
/** 줄바꿈 덩어리 줄(SegText·Words)을 ' '로 이은 한 줄 */
const wordRows = (r: R | HostNode) => ("all" in r ? r.all() : all(r)).filter((n) => n.type === "View" && n.props.testID === "words").map((row) => kids(row).map(rawOf).join(" "));
const all = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(all)];
/** 흐린 글·글 노드 하나하나의 글 */
const texts = (n: HostNode) => all(n).filter((x) => x.type === "Text").map(rawOf);
const screenKids = (r: R) => kids(ofType(r, "Screen")[0]!);
const isAccountRow = (n: HostNode) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith("내 계좌 브리핑");
const isMarketRow = (n: HostNode) => n.type === "Pressable" && /시장, \d+\/\d+ (오전|오후)/.test(String(n.props.accessibilityLabel ?? ""));
/** 접은 화면 탭 휴장 줄 */
const tabHoliday = (r: R) => muted(r).filter((x) => x.startsWith("한국 휴장일"));
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const tab = async () => {
  const r = render(<BriefingsScreen />);
  await settle(r);
  return r;
};
/** 맨 위 묶음 (Screen 의 첫 요소 — View) */
const topBlock = (r: R) => {
  const first = screenKids(r)[0]!;
  expect(first.type).toBe("View");
  return first;
};

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, marketSummary: true, briefingTabMovers: true };
  h.now = Date.parse("2026-09-28T08:40:00+09:00");
  h.market = { KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } };
  h.summaries = [US_MORNING];
  h.accounts = [ACCOUNT];
  h.latest = LIST;
  h.stocks = STOCKS;
  h.push.mockReset();
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("꺼짐 (앱 기본 — 플래그 없음 = 꺼짐): 지금 그대로", () => {
  it("접은 화면: 시장 요약 카드 → 계좌 카드 → '변동 큰 종목' 카드 → 정렬·보기 탭 → 종목 카드 (맨 위 묶음·안내 한 줄 없음)", async () => {
    const r = await tab();
    const types = screenKids(r).map((n) => n.type);
    expect(types).toEqual(["Card", "Card", "Card", "Segmented", "Segmented", "BriefingCard", "BriefingCard", "BriefingCard", "BriefingCard", "Card"]);
    expect(labels(r).findIndex((l) => l.includes("미국 시장"))).toBeLessThan(labels(r).findIndex((l) => l.startsWith("내 계좌 브리핑")));
    expect(r.text()).toContain("변동 큰 종목");
    expect(r.text()).not.toContain("요약은 숫자로 만든 것");
    // 계좌는 카드 안의 누르는 칸 (줄이 아님)
    expect(screenKids(r).some((n) => n.type === "View" || isAccountRow(n) || isMarketRow(n))).toBe(false);
    // 플래그를 false 로 받은 것과 받지 못한 것(앱 기본)은 같은 화면
    const base = JSON.stringify(r.tree);
    h.flags = { ...h.flags, briefingCompactTop: false, moversMerge: false };
    expect(JSON.stringify((await tab()).tree)).toBe(base);
  });
});

describe("켬: 접은 화면 맨 위 묶음", () => {
  beforeEach(() => {
    h.flags.briefingCompactTop = true;
  });

  it("첫 요소는 틈 없는 한 덩어리 <View>: 계좌 줄(링크) → 시장 줄(링크) → 안내 한 줄, 누르면 계좌·시장 상세", async () => {
    const r = await tab();
    const block = topBlock(r);
    const [acc, mkt, note] = kids(block);
    expect(kids(block)).toHaveLength(3);
    expect(isAccountRow(acc!)).toBe(true);
    expect(acc!.props.accessibilityRole).toBe("link");
    expect(isMarketRow(mkt!)).toBe(true);
    expect(mkt!.props.accessibilityRole).toBe("link");
    expect(note!.type).toBe("Muted");
    expect(rawOf(note!)).toBe(NOTE_BOTH);
    // 묶음 View 에는 gap 이 없다 (Screen 의 gap 이 줄 사이에 끼지 않게)
    expect(block.props.style).toBeUndefined();
    // 예전 카드 두 장은 없다
    expect(screenKids(r).filter((n) => n.type === "Card").map(rawOf).some((x) => x.includes("내 계좌 브리핑") || x.includes("미국 시장"))).toBe(false);
    r.act(() => (acc!.props.onPress as () => void)());
    expect(h.push).toHaveBeenLastCalledWith("/briefings/account/12");
    r.act(() => (mkt!.props.onPress as () => void)());
    expect(h.push).toHaveBeenLastCalledWith("/briefings/market/7");
    // 내 종목 줄은 본문 크기·진한 글 (접은 화면만)
    const hold = all(mkt!).find((n) => n.props.testID === "words" && kids(n).map(rawOf).join(" ").startsWith("내 미국"))!;
    expect(kids(hold).every((c) => (c.props.style as unknown[]).some((s) => (s as { fontSize?: number } | null)?.fontSize === 14))).toBe(true);
  });

  it("안내 한 줄: 계좌만 · 시장만 · 둘 다 없으면 묶음 없음", async () => {
    h.summaries = [];
    let r = await tab();
    expect(kids(topBlock(r)).map((n) => n.type)).toEqual(["Pressable", "Muted"]);
    expect(muted(r)).toContain("계좌 요약은 숫자로 만든 것 · 매매 권유가 아닙니다");
    h.summaries = [US_MORNING];
    h.accounts = [];
    r = await tab();
    expect(kids(topBlock(r)).map((n) => n.type)).toEqual(["Pressable", "Muted"]);
    expect(muted(r)).toContain("시장 요약은 숫자로 만든 것 · 매매 권유가 아닙니다");
    h.summaries = [];
    r = await tab();
    expect(screenKids(r)[0]!.type).not.toBe("View");
    expect(r.text()).not.toContain("요약은 숫자로 만든 것");
    // 서버가 두 기능을 끈 경우도 같다
    h.summaries = [US_MORNING];
    h.accounts = [ACCOUNT];
    h.flags.accountBriefing = false;
    h.flags.marketSummary = false;
    r = await tab();
    expect(screenKids(r)[0]!.type).not.toBe("View");
  });

  it("줄 하나가 실패: 그 줄은 '생성 실패 · …' 한 줄, 다른 줄은 정상", async () => {
    h.accounts = [{ ...ACCOUNT, status: "failed", headline: null, summary: "토스 잔고를 받지 못했습니다" }];
    const r = await tab();
    const [acc, mkt] = kids(topBlock(r));
    expect(texts(acc!)).toContain("생성 실패 · 토스 잔고를 받지 못했습니다");
    expect(isMarketRow(mkt!)).toBe(true);
    expect(wordRows(mkt!).some((x) => x.startsWith("내 미국 12종목"))).toBe(true);
  });

  it("글자 130%: 줄 글자(맨 위 Text)마다 글자 확대 상한(maxFontSizeMultiplier)이 있다", async () => {
    h.win = { ...h.win, fontScale: 1.3 };
    h.summaries = [KR_HOLIDAY];
    h.accounts = [ACCOUNT_KR_HOLIDAY];
    h.now = Date.parse("2026-09-25T16:20:00+09:00");
    const r = await tab();
    const block = topBlock(r);
    const outer = (n: HostNode, inText = false): HostNode[] => [...(n.type === "Text" && !inText ? [n] : []), ...kids(n).flatMap((c) => outer(c, inText || n.type === "Text"))];
    const rows = kids(block).filter((n) => n.type === "Pressable");
    const tops = rows.flatMap((n) => outer(n));
    expect(tops.length).toBeGreaterThan(10);
    for (const t of tops) expect(t.props.maxFontSizeMultiplier, rawOf(t)).toBeTypeOf("number");
  });
});

describe("켬: 휴장 줄", () => {
  beforeEach(() => {
    h.flags.briefingCompactTop = true;
  });

  it("한국 휴장(추석) 오후: 시장 줄 안 휴장 줄 + 다음 개장, 계좌 줄 휴장 줄, 탭 휴장 줄 없음 (briefingTrim 끔이어도)", async () => {
    h.now = Date.parse("2026-09-25T16:20:00+09:00");
    h.market = { KR: { isTradingDay: false, opensAt: "2026-09-28T09:00:00+09:00" }, US: { isTradingDay: true } };
    h.summaries = [KR_HOLIDAY];
    h.accounts = [ACCOUNT_KR_HOLIDAY];
    const r = await tab();
    const [acc, mkt] = kids(topBlock(r));
    expect(wordRows(mkt!)).toEqual(expect.arrayContaining(["오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준", "다음 개장 9/28(월) 09:00"]));
    // 휴장 줄은 머리 아래·지수 칸 위
    const order = all(mkt!).map((n) => (n.props.testID === "index-cell" ? "cell" : n.props.testID === "words" ? kids(n).map(rawOf).join(" ") : null)).filter(Boolean);
    expect(order.indexOf("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준")).toBeLessThan(order.indexOf("cell"));
    expect(all(mkt!).some((n) => n.type === "Ionicons" && n.props.name === "calendar-outline")).toBe(true);
    // 계좌 줄: 브리핑 날짜가 오늘이라 예전 글 그대로 (briefingTrim 끔)
    expect(texts(acc!)).toContain(KR_LINE_OLD);
    expect(tabHoliday(r)).toEqual([]);
    // briefingTrim 켬이면 계좌 줄은 브리핑 날짜 줄, 탭 휴장 줄은 역시 없음
    h.flags.briefingTrim = true;
    const t = await tab();
    expect(texts(kids(topBlock(t))[0]!)).toContain(KR_LINE_DATE);
    expect(tabHoliday(t)).toEqual([]);
  });

  it("한국 휴장일 아침('밤사이 미국' 요약): 시장 줄에 한국 휴장 줄이 없으므로 탭 휴장 줄은 남는다", async () => {
    h.now = Date.parse("2026-09-25T08:40:00+09:00");
    h.market = { KR: { isTradingDay: false, opensAt: "2026-09-28T09:00:00+09:00" }, US: { isTradingDay: true } };
    h.summaries = [US_MORNING];
    const r = await tab();
    expect(tabHoliday(r)).toEqual(["한국 휴장일 · 국내 종목 브리핑 없음 · 다음 개장 9월 28일 (월) 09:00"]);
    expect(wordRows(kids(topBlock(r))[1]!).some((x) => x.includes("휴장"))).toBe(false);
  });

  it("월요일 아침 금요일 계좌 브리핑이 맨 위: briefingTrim 끔이면 한국 휴장 줄 없음, 켬이면 날짜 줄 ('오늘' 0건)", async () => {
    h.now = Date.parse("2026-09-28T08:20:00+09:00");
    h.accounts = [ACCOUNT_KR_HOLIDAY];
    let r = await tab();
    let acc = kids(topBlock(r))[0]!;
    expect(texts(acc).some((x) => x.includes("한국 휴장"))).toBe(false);
    expect(String(acc.props.accessibilityLabel)).not.toContain("한국 휴장");
    h.flags.briefingTrim = true;
    r = await tab();
    acc = kids(topBlock(r))[0]!;
    expect(texts(acc)).toContain(KR_LINE_DATE);
    expect(String(acc.props.accessibilityLabel)).toContain("9월 25일 (금) 한국 휴장, 국내 종목은 직전 거래일 등락");
    expect(r.text()).not.toContain("오늘 한국 휴장");
  });

  it("미국 휴장 줄: 브리핑 날짜가 오늘이면 '지난밤 …', 지난 날(주말 넘김 포함)이면 '11/26(목) 미국 휴장 · …' (휴장일을 모르면 전날로)", async () => {
    h.summaries = [summaryItem(9, shared.cases[3]!.data)];
    h.accounts = [ACCOUNT_US_HOLIDAY];
    h.now = Date.parse("2026-11-27T08:40:00+09:00");
    let acc = kids(topBlock(await tab()))[0]!;
    expect(texts(acc)).toContain("지난밤 미국 휴장 · 미국 종목은 직전 거래일 등락");
    expect(String(acc.props.accessibilityLabel)).toContain("지난밤 미국 휴장, 미국 종목은 직전 거래일 등락");
    // 다음 날(토)·주말 넘긴 월요일에 보면 날짜 모양
    for (const at of ["2026-11-28T10:00:00+09:00", "2026-11-30T08:20:00+09:00"]) {
      h.now = Date.parse(at);
      acc = kids(topBlock(await tab()))[0]!;
      expect(texts(acc)).toContain("11/26(목) 미국 휴장 · 미국 종목은 직전 거래일 등락");
      expect(texts(acc).join("\n")).not.toContain("지난밤");
      expect(String(acc.props.accessibilityLabel)).toContain("11월 26일 (목) 미국 휴장, 미국 종목은 직전 거래일 등락");
    }
    // 예전 기록(휴장일 없음): 브리핑 날짜의 달력 전날
    const { usHolidayDate: _drop, ...headline } = ACCOUNT_US_HOLIDAY.headline!;
    h.accounts = [{ ...ACCOUNT_US_HOLIDAY, headline }];
    acc = kids(topBlock(await tab()))[0]!;
    expect(texts(acc)).toContain("11/26(목) 미국 휴장 · 미국 종목은 직전 거래일 등락");
    // 시장 줄: 지난밤 미국 휴장(추수감사절)
    h.now = Date.parse("2026-11-27T08:40:00+09:00");
    const r = await tab();
    expect(wordRows(kids(topBlock(r))[1]!)).toContain("지난밤 미국 휴장(추수감사절) · 아래는 직전 거래일 11/25(수) 기준");
  });

  it("한국 휴장 줄 뒤에 미국 휴장 줄 (한국 → 미국 순서)", async () => {
    h.now = Date.parse("2026-09-25T16:20:00+09:00");
    h.accounts = [{ ...ACCOUNT_KR_HOLIDAY, headline: { ...ACCOUNT_KR_HOLIDAY.headline!, usPreviousDay: true, usHolidayDate: "2026-09-24" } }];
    const t = texts(kids(topBlock(await tab()))[0]!);
    expect(t.indexOf(KR_LINE_OLD)).toBeGreaterThan(-1);
    expect(t.indexOf("지난밤 미국 휴장 · 미국 종목은 직전 거래일 등락")).toBeGreaterThan(t.indexOf(KR_LINE_OLD));
  });
});

describe("넓은 창 (foldLayout 켬)", () => {
  const open = async (w: number, hh: number) => {
    h.flags.foldLayout = true;
    h.store.set("briefings.read", "[]");
    h.win = { width: w, height: hh, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const r = render(<BriefingsScreen />);
    await settle(r);
    return r;
  };
  /** 문서 순서로 계좌 줄·시장 줄 */
  const topRows = (r: R) => r.all().filter((n) => isAccountRow(n) || isMarketRow(n)).map((n) => (isAccountRow(n) ? "account" : "market"));
  const noticeLabels = (r: R) => r.all().filter((n) => n.props.accessible === true && n.type === "View" && typeof n.props.accessibilityLabel === "string").map((n) => String(n.props.accessibilityLabel));

  it.each([
    ["2단 933×632", 933, 632],
    ["카드 격자 704×861", 704, 861],
  ])("%s: 켜면 계좌 줄이 시장 줄 위, 끄면 지금 순서(시장 먼저)", async (_name, w, hh) => {
    expect(topRows(await open(w, hh))).toEqual(["market", "account"]);
    cleanupRenders();
    pick.forgetPick();
    h.flags.briefingCompactTop = true;
    const r = await open(w, hh);
    expect(topRows(r)).toEqual(["account", "market"]);
    // 넓은 창 계좌 줄에는 기여 상위 묶음을 넣지 않는다 (moversMerge 를 켜도)
    cleanupRenders();
    pick.forgetPick();
    h.flags.moversMerge = true;
    const m = await open(w, hh);
    expect(m.text()).toContain("기여 1위 ");
    expect(m.text()).not.toContain("당일 손익 기여 상위");
  });

  it.each([
    ["2단 933×632", 933, 632],
    ["카드 격자 704×861", 704, 861],
  ])("%s 한국 휴장(한국 요약): 켜면 목록 위 안내에서 휴장 글을 빼고 시장 줄 안에 휴장 줄, 끄면 안내에 그대로", async (_name, w, hh) => {
    h.now = Date.parse("2026-09-25T16:20:00+09:00");
    h.market = { KR: { isTradingDay: false, opensAt: "2026-09-28T09:00:00+09:00" }, US: { isTradingDay: true } };
    h.summaries = [KR_HOLIDAY];
    h.accounts = [ACCOUNT_KR_HOLIDAY];
    const off = await open(w, hh);
    expect(noticeLabels(off).some((l) => l.startsWith("한국 휴장일 · 국내 종목은 직전 거래일 등락"))).toBe(true);
    expect(wordRows(off)).not.toContain("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
    cleanupRenders();
    pick.forgetPick();
    h.flags.briefingCompactTop = true;
    const on = await open(w, hh);
    expect(noticeLabels(on).some((l) => l.includes("한국 휴장일"))).toBe(false);
    expect(wordRows(on)).toContain("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
    expect(on.all().filter((n) => n.type === "Text").map(rawOf)).toContain(KR_LINE_OLD);
  });

  it("미국 요약(한국 휴장일 아침)이면 켜도 목록 위 안내의 한국 휴장 글은 남는다", async () => {
    h.now = Date.parse("2026-09-25T08:40:00+09:00");
    h.market = { KR: { isTradingDay: false, opensAt: "2026-09-28T09:00:00+09:00" }, US: { isTradingDay: true } };
    h.flags.briefingCompactTop = true;
    const r = await open(933, 632);
    expect(noticeLabels(r).some((l) => l.startsWith("한국 휴장일 · 국내 종목은 직전 거래일 등락"))).toBe(true);
  });
});
