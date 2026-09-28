import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, HoldingThemesSnapshot } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 3-35 내 종목 테마 — 계좌 브리핑 상세 카드 (플래그 holdingThemes, 앱 fallback 꺼짐).
 *  - 브리핑을 만든 그 시각에 저장한 값 그대로: 많이 속한 테마 · 시장별 높은/낮은 3개(또는 한 줄) · 기준 줄 · [지금 기준으로 전체 보기]
 *  - 폰: '지난 오전 브리핑과 비교' 아래 · '오늘 일정' 위, 세 칸: 가운데 칸 기여 표 아래, 두 칸: 왼쪽 칸 끝
 *  - 꺼짐·예전 기록(칸 없음): 그림 트리가 지금과 같음
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-29T08:40:00+09:00"),
  detail: null as unknown,
  push: vi.fn(),
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
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => ({ id: "12" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => h.win.fontScale };
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
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.detail : undefined),
  };
});

const { AccountBriefingBody } = await import("@/components/AccountBriefingBody");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { dark } = await import("@/tokens");

const SNAP: HoldingThemesSnapshot = {
  asOf: "2026-09-29T08:38:00+09:00",
  coverage: { held: 17, mapped: 15 },
  mostHeld: [
    { name: "반도체팹리스", count: 3 },
    { name: "인공지능", count: 3 },
    { name: "양자컴퓨터", count: 2 },
  ],
  markets: {
    US: { basisDay: "2026-09-28", session: "closed", split: true, top: [{ name: "양자컴퓨터", changeRate: 6.21 }, { name: "반도체팹리스", changeRate: 2.1 }, { name: "소프트웨어", changeRate: 1.4 }], bottom: [{ name: "인터넷", changeRate: -1.1 }, { name: "클라우드", changeRate: -0.8 }, { name: "스마트폰제조", changeRate: -0.3 }], more: 0 },
    KR: { basisDay: "2026-09-28", session: "closed", split: false, top: [{ name: "2차전지", changeRate: 0.85 }, { name: "HBM(고대역폭메모리)", changeRate: -4.12 }, { name: "반도체와반도체장비", changeRate: -5.47 }], bottom: [], more: 0 },
  },
};

const DATA: AccountData = {
  version: 1, session: "morning", date: "2026-09-29", asOf: "2026-09-29T08:38:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 9, stale: 0,
  totalValue: 10_000_000, totalCost: 8_400_000, totalProfit: 1_600_000, totalProfitRate: 19.05, dayPnl: 212_000, dayRate: 2.16,
  contributions: [{ code: "NVDA", name: "엔비디아", currency: "USD", amount: 150_000, changeRate: 5.87, value: 2_130_000 }],
  others: null,
  markets: { kr: { count: 3, value: 3_760_000, day: 62_000, dayRate: 1.68 }, us: { count: 6, value: 6_240_000, day: 150_000, dayRate: 2.46 } },
  excluded: [],
  fx: { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: null, appliedRate: null, usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null },
  indices: [{ code: "KOSPI", name: "코스피", value: 3412.35, change: 27.5, changeRate: 0.81, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-09-29", tradingDay: true, now: "개장 전", hours: "정규장 09:00~15:30", nextOpen: null }, us: { date: "2026-09-29", tradingDay: true, now: "미국 휴장 시간", hours: "정규장 9/29 22:30~9/30 05:00 (한국 시간)" }, disclosures: [] },
  narrative: { source: "template", reason: null },
};
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-29", session: "morning", status: "ok", summary: "당일 +212,000원 (+2.16%)\n총 평가금액 10,000,000원",
  detail: "- 설명", model: "template", template: true, createdAt: "2026-09-29T08:38:00+09:00",
  headline: { totalValue: 10_000_000, dayPnl: 212_000, dayRate: 2.16, holdings: 9, top: [{ code: "NVDA", name: "엔비디아", amount: 150_000, changeRate: 5.87 }] },
};
const detailOf = (s: HoldingThemesSnapshot | undefined): AccountBriefingWithData => ({ ...ACCOUNT, data: s === undefined ? DATA : { ...DATA, holdingThemes: s } });

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const allOf = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(allOf)];
const flat = (s: unknown): Record<string, unknown> => (Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : ((s as Record<string, unknown>) ?? {}));
const treeOf = (r: R) =>
  JSON.stringify(r.tree, function (this: unknown, k: string, v: unknown) {
    if (k === "query") return undefined;
    if (k === "children" && !(this && typeof this === "object" && "type" in this && "props" in this)) return undefined;
    return typeof v === "function" ? undefined : v;
  });
const themesCard = (r: R) => r.all().filter((n) => n.type === "Card" && kids(n).some((k) => k.type === "SectionTitle" && rawOf(k) === "내 종목 테마"));
const cardTitles = (n: HostNode) => allOf(n).filter((x) => x.type === "SectionTitle").map(rawOf);

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, briefingTrim: true, holdingThemes: true };
  h.detail = detailOf(SNAP);
  h.push.mockReset();
  forgetWindowClass();
});

describe("계좌 브리핑 상세 '내 종목 테마' 카드", () => {
  it("폰: 저장한 값 그대로 줄마다 한 문장 · 기준 줄 · '지금 기준으로 전체 보기' → 지금 값 화면", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const cards = themesCard(r);
    expect(cards).toHaveLength(1);
    const lines = allOf(cards[0]!).filter((n) => n.props.accessible === true).map((n) => n.props.accessibilityLabel);
    expect(lines).toEqual([
      "내 종목이 많이 속한 테마, 반도체팹리스 3종목, 인공지능 3종목, 양자컴퓨터 2종목",
      "미국 · 등락률 높은 3개, 양자컴퓨터 6.21% 상승, 반도체팹리스 2.10% 상승, 소프트웨어 1.40% 상승",
      "미국 · 등락률 낮은 3개, 인터넷 1.10% 하락, 클라우드 0.80% 하락, 스마트폰제조 0.30% 하락",
      "한국, 2차전지 0.85% 상승, HBM(고대역폭메모리) 4.12% 하락, 반도체와반도체장비 5.47% 하락",
    ]);
    expect(allOf(cards[0]!).some((n) => n.type === "Muted" && rawOf(n) === "보유 17종목 중 15종목 연결 · 미국 9/28(월) 정규장 · 한국 9/28(월) 마감 · 08:38 기준")).toBe(true);
    const btn = allOf(cards[0]!).find((n) => n.type === "Button")!;
    expect(btn.props.title).toBe("지금 기준으로 전체 보기");
    (btn.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/portfolio/themes");
    // 색은 등락률 글자에만 (빨강 +, 파랑 −)
    const rates = allOf(cards[0]!).filter((n) => n.type === "Text" && /^ [+-]\d/.test(rawOf(n)));
    expect(rates.map((n) => [rawOf(n).trim(), flat(n.props.style).color])).toContainEqual(["+6.21%", dark.up]);
    expect(rates.map((n) => [rawOf(n).trim(), flat(n.props.style).color])).toContainEqual(["-1.10%", dark.down]);
  });

  it("자리: 폰은 기여 표 다음 카드들 가운데 '오늘 일정' 위", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const screen = r.all().find((n) => n.type === "Screen")!;
    const cards = kids(screen).filter((n) => n.type === "Card");
    const at = cards.findIndex((c) => cardTitles(c).includes("내 종목 테마"));
    const schedule = cards.findIndex((c) => cardTitles(c).includes("오늘 일정"));
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(schedule);
  });

  it("세 칸 933×704: 가운데 칸 기여 표 아래 · 두 칸 704×933: 왼쪽 칸", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const three = render(<AccountBriefingBody numId={12} layout="split" />);
    const scrolls = three.all().filter((n) => n.type === "ScrollView");
    expect(scrolls.length).toBe(3);
    expect(themesCard(three)).toHaveLength(1);
    expect(allOf(scrolls[1]!)).toContain(themesCard(three)[0]);
    forgetWindowClass();
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    const two = render(<AccountBriefingBody numId={12} layout="split" />);
    const s2 = two.all().filter((n) => n.type === "ScrollView");
    expect(allOf(s2[0]!)).toContain(themesCard(two)[0]);
  });

  it.each(["stack", "pane", "split"] as const)("꺼짐(%s): 칸이 와도 그림 트리가 칸이 없는 것과 같다 · 켬 + 예전 기록(칸 없음)도 같다", (layout) => {
    if (layout === "split") h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags.holdingThemes = false;
    const off = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    expect(off).not.toContain("내 종목 테마");
    h.detail = detailOf(undefined);
    expect(treeOf(render(<AccountBriefingBody numId={12} layout={layout} />))).toBe(off);
    h.flags.holdingThemes = true;
    expect(treeOf(render(<AccountBriefingBody numId={12} layout={layout} />))).toBe(off);
  });
});
