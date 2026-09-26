import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketSummary, MarketSummaryData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 시장 전체 요약 화면 (플래그 marketSummary): 브리핑 탭 맨 위 카드(접은 화면), 넓은 창 목록 맨 위 줄 → 오른쪽 칸 상세, 상세 화면.
 *  - 플래그가 꺼져 있으면(앱 기본) 카드가 없고 목록·상세를 요청하지 않는다
 *  - '밤사이/오늘'은 볼 때 날짜로 (useNow 를 고정 시각으로 바꿔 본다)
 * RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 679, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:31:00+09:00"),
  params: { id: "7" } as { id?: string },
  push: vi.fn(),
  openURL: vi.fn(),
  list: [] as unknown[],
  detail: null as unknown,
  listEnabled: [] as boolean[],
  detailEnabled: [] as boolean[],
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
  Linking: { openURL: h.openURL },
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
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => h.params }));
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
  const LATEST = [{ code: "005930", name: "삼성전자", latest: { id: 1, code: "005930", name: "삼성전자", session: "morning", date: "2026-09-28", status: "ok", summary: "요약", detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-09-28T08:40:00+09:00" } }];
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: (enabled: boolean) => {
      h.listEnabled.push(enabled);
      return q(enabled ? h.list : undefined);
    },
    useMarketSummary: (_id: number, enabled: boolean) => {
      h.detailEnabled.push(enabled);
      return q(enabled ? h.detail : undefined);
    },
    useAccountBriefings: () => q(undefined),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q(LATEST),
    useRegisteredStocks: () => q([]),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(undefined),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { default: MarketSummaryScreen } = await import("@/app/briefings/market/[id]");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const { marketSummary: MS, touch } = await import("@/tokens");

const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
const item = (id: number, data: MarketSummaryData): MarketSummary => ({ id, date: data.date, session: data.session, market: data.market, status: "ok", summary: "요약", createdAt: data.asOf, data });
const MORNING = item(7, shared.cases[0]!.data);
const KR_HOLIDAY = item(8, shared.cases[2]!.data);

type R = ReturnType<typeof render>;
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const texts = (r: R) => r.all().filter((n) => n.type === "Text" || n.type === "Muted").map(textOf);
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
const cardOf = (r: R) => r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").includes("숫자로 만든 요약"));
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 679, scale: 2.625, fontScale: 1 };
  h.flags = {};
  h.now = Date.parse("2026-09-28T08:31:00+09:00");
  h.params = { id: "7" };
  h.list = [MORNING];
  h.detail = MORNING;
  h.listEnabled = [];
  h.detailEnabled = [];
  h.push.mockReset();
  h.openURL.mockReset();
  h.store.clear();
  pick.forgetPick();
  forgetWindowClass();
});

describe("브리핑 탭 맨 위 카드 (접은 화면)", () => {
  it("플래그가 꺼져 있으면(앱 기본) 카드가 없고 목록을 요청하지 않는다", () => {
    const r = render(<BriefingsScreen />);
    expect(cardOf(r)).toBeUndefined();
    expect(h.listEnabled.every((e) => !e)).toBe(true);
  });

  it("켜져 있으면 맨 위 카드: 월요일 제목은 '금요일(9/25) 미국 시장', 지수 4칸·이름표 줄·뉴스 제목 2개·고지, 누르면 상세", () => {
    h.flags = { marketSummary: true };
    const r = render(<BriefingsScreen />);
    const card = cardOf(r)!;
    expect(card).toBeDefined();
    const all = texts(r);
    expect(all).toContain("금요일(9/25) 미국 시장");
    expect(all).toContain("9/25(금) 뉴욕 장 마감 기준 · 주말 이틀 휴장");
    expect(all).toContain("9월 28일 (월) 오전");
    for (const l of ["환율·금리", "업종", "내 종목", "뉴스 3건"]) expect(all).toContain(l);
    expect(all).toContain("원/달러 1,359.00원 +3.50원 (9/23 고시) · 미 10년물 5.17% -0.01%p (미 재무부)");
    expect(all).toContain("약 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)");
    expect(all.some((t) => t.startsWith("뉴스1 9/26 05:32 [예시]"))).toBe(true);
    expect(all.some((t) => t.startsWith("KBS 9/26 05:22"))).toBe(true);
    expect(all.some((t) => t.startsWith("한국경제"))).toBe(false); // 세 번째 제목은 상세에만
    expect(all).toContain("숫자로 만든 요약 · 뉴스 제목은 언론사 원문 · 매매 권유가 아닙니다");
    // 지수 칸마다 화면 읽기 문장
    expect(labels(r)).toContain("나스닥, 0.48% 상승, 27,068.72");
    // 계좌·종목 브리핑보다 위 (첫 누르는 칸)
    const firstPress = r.all().find((n) => n.type === "Pressable");
    expect(firstPress).toBe(card);
    r.act(() => (card.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/briefings/market/7");
  });

  it("다음 날 아침에 보면 '밤사이'가 아니라 날짜로 — 휴장 오후 카드는 '휴장' 배지·배너·칸마다 거래일", () => {
    h.flags = { marketSummary: true };
    h.list = [KR_HOLIDAY];
    h.now = Date.parse("2026-09-25T16:05:00+09:00");
    const r = render(<BriefingsScreen />);
    const all = texts(r);
    expect(all).toContain("오늘 한국 시장");
    expect(all).toContain("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
    expect(all).toContain("코스피 (9/23)");
    expect(r.all().some((n) => n.type === "Badge" && textOf(n) === "휴장")).toBe(true);
    expect(all).not.toContain("뉴스 3건");
    // 토요일에 다시 보면 날짜로
    h.now = Date.parse("2026-09-26T10:00:00+09:00");
    r.rerender();
    expect(texts(r)).toContain("9/25(금) 한국 시장");
    expect(texts(r)).toContain("9/25(금) 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
  });

  it("예전 서버(404 → 빈 목록)면 카드가 없다", () => {
    h.flags = { marketSummary: true };
    h.list = [];
    expect(cardOf(render(<BriefingsScreen />))).toBeUndefined();
  });
});

describe("상세 화면 /briefings/market/<id>", () => {
  it("내 보유 종목과 지수(지수 표보다 위) → 주요 지수 → 업종 → 환율·금리 → 일정 → 뉴스(원문 링크) → 만든 기준", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    const sections = r.all().filter((n) => n.type === "SectionTitle").map(textOf);
    expect(sections).toEqual(["내 보유 종목과 지수", "주요 지수", "업종 (섹터 ETF)", "환율·금리", "일정", "뉴스 3건", "이 요약을 만든 기준"]);
    const all = texts(r);
    expect(all).toContain("금요일(9/25) 미국 시장");
    expect(all).toContain("내 미국 12종목: 상승 8 · 하락 4 / 나스닥 +0.48% · S&P500 +0.51%");
    expect(all).toContain("지수보다 높음 (+1.00%p 이상) 2");
    expect(all).toContain("비슷 (±1.00%p 안) 7");
    expect(all).toContain("지수보다 낮음 (-1.00%p 이하) 3");
    expect(all).toContain("+3.18%p");
    expect(labels(r)).toContain("마이크로소프트, 3.66% 상승, 비교 지수 나스닥 0.48% 상승, 차이 3.18%포인트 높음");
    expect(all.some((t) => t.includes("다음: 10/2(금) 21:30 미국 9월 고용보고서 발표 (예정)"))).toBe(true);
    expect(all.some((t) => t.includes("AI(모델)가 쓴 문장은 없습니다"))).toBe(true);
    // 뉴스 원문 링크 3개 (제목 원문 그대로)
    const links = r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").includes("기사 원문 열기"));
    expect(links).toHaveLength(3);
    r.act(() => (links[0]!.props.onPress as () => void)());
    expect(h.openURL).toHaveBeenCalledWith("https://news.google.com/rss/articles/example-1");
    expect(r.all().some((n) => n.type === "StackScreen" && (n.props.options as { title?: string }).title === "시장 요약 · 오전")).toBe(true);
    expect(h.detailEnabled.at(-1)).toBe(true);
  });

  it("플래그가 꺼져 있으면 불러오지 않고 '볼 수 없습니다'", () => {
    const r = render(<MarketSummaryScreen />);
    expect(h.detailEnabled.every((e) => !e)).toBe(true);
    expect(r.all().some((n) => n.type === "Empty" && n.props.title === "시장 요약을 볼 수 없습니다")).toBe(true);
  });
});

describe("넓은 창 (펼친 폴드8 가로 2단, 플래그 foldLayout)", () => {
  it("목록 맨 위 줄(계좌 줄 위)을 누르면 오른쪽 칸에 요약 상세 — 처음 골라지는 브리핑 규칙은 그대로(첫 미확인 종목 브리핑)", async () => {
    h.flags = { marketSummary: true, foldLayout: true, accountBriefing: true };
    h.win = { width: 933, height: 632, scale: 2.625, fontScale: 1 };
    const r = render(<BriefingsScreen />);
    await settle(r);
    // 처음에는 종목 브리핑이 저절로 골라진다 (시장 요약이 아니라)
    expect(pick.currentPick().pick).toMatchObject({ kind: "stock", id: 1 });
    const row = r.all().find((n) => n.type === "Pressable" && n.props.accessibilityRole === "button" && String(n.props.accessibilityLabel ?? "").startsWith("금요일(9/25) 미국 시장"))!;
    expect(row).toBeDefined();
    expect(texts(r)).toContain("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
    expect(r.all().some((n) => n.type === "Badge" && textOf(n) === "9/25(금) 마감")).toBe(true);
    r.act(() => (row.props.onPress as () => void)());
    await settle(r);
    expect(pick.currentPick().pick).toEqual({ kind: "market", id: 7 });
    expect(h.push).not.toHaveBeenCalled(); // 주소는 그대로, 오른쪽 칸만
    expect(r.all().some((n) => n.type === "SectionTitle" && textOf(n) === "내 보유 종목과 지수")).toBe(true);
    const selected = r.all().find((n) => n === row || (n.type === "Pressable" && n.props.accessibilityState && (n.props.accessibilityState as { selected?: boolean }).selected && String(n.props.accessibilityLabel).startsWith("금요일")));
    expect(selected).toBeDefined();
  });

  it("줄 높이는 누르는 크기(44) 이상", () => {
    expect(MS.rowMinH).toBeGreaterThanOrEqual(touch.min);
  });
});
