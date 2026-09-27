import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Briefing, BriefingWithData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 2차 6 — 종목 브리핑 'AI가 쓴 글' 표시 (플래그 briefingSafeWording, 앱 fallback 꺼짐).
 *  - 켬: 접은 화면 종목 카드 날짜 줄 끝 ' · AI가 쓴 글'(새 줄 없이 같은 Muted 줄)·화면 읽기에 'AI가 쓴 글',
 *        상세 머리(폰 stack·2단 pane·두 칸 split)에 'AI가 쓴 글 · 틀릴 수 있음'
 *  - 끔(앱 기본 = 플래그 없음): 표시 없음, 지금 그대로. 실패 브리핑에는 켜도 없음
 * 시계는 고정 (useNow), RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다. 종목 카드(BriefingCard)는 진짜로 그린다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-25T09:10:00+09:00"),
  detail: null as unknown,
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
vi.mock("expo-router", () => ({ router: { push: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => ({ id: "1" }) }));
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
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));

const B = (id: number, code: string, name: string, over: Partial<Briefing> = {}): Briefing => ({
  id, code, name, session: "morning", date: "2026-09-25", status: "ok", summary: "84,300원 · 전일 대비 +3.56% (NXT 포함)\n외국인 순매수 3일째", detail: "## 한 줄 요약\n실적 발표가 있었습니다.",
  missing: [], model: "m", error: null, createdAt: "2026-09-25T08:02:00+09:00", ...over,
});
const OK = B(1, "005930", "삼성전자");
const FAILED = B(2, "AAPL", "애플", { status: "failed", summary: "브리핑 생성 실패: api: 가짜 실패", error: "api: 가짜 실패" });
const detailOf = (b: Briefing): BriefingWithData => ({
  ...b,
  data: {
    quote: { code: b.code, price: 84_300, change: 2_900, changeRate: 3.56, currency: "KRW", asOf: "2026-09-25T08:01:00+09:00", source: "toss" } as unknown as NonNullable<BriefingWithData["data"]>["quote"],
    technical: null,
    news: [],
    disclosures: [],
    holding: null,
    missing: [],
  },
});

vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: data !== undefined, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: () => q(undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: () => q(undefined),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q([{ code: OK.code, name: OK.name, latest: OK }, { code: FAILED.code, name: FAILED.name, latest: FAILED }]),
    useRegisteredStocks: () => q([]),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(undefined),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(h.detail),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { BriefingBody } = await import("@/components/BriefingBody");
const { BriefingCard } = await import("@/components/BriefingCard");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { formatDateKo, SESSION_LABEL } = await import("@/lib/format");
const { AI_NOTE, AI_TAG } = await import("@/lib/disclaimer");

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
/** 흐린 글(Muted) 하나하나 */
const muted = (r: R) => r.all().filter((n) => n.type === "Muted").map(rawOf);
/** 종목 카드의 누르는 머리 (화면 읽기 이름표가 '… 브리핑'을 담은 링크) */
const cardLabels = (r: R) => r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityRole === "link" && String(n.props.accessibilityLabel).includes("브리핑")).map((n) => String(n.props.accessibilityLabel));
const DATE_LINE = `${formatDateKo(OK.date)} ${SESSION_LABEL[OK.session]} 브리핑`;
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const tab = async () => {
  const r = render(<BriefingsScreen />);
  await settle(r);
  return r;
};
const body = (layout: "stack" | "split" | "pane") => render(<BriefingBody id={1} layout={layout} />);

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = {};
  h.detail = detailOf(OK);
  h.store.clear();
  forgetWindowClass();
});

describe("꺼짐 (앱 기본 — 플래그 없음 = 꺼짐): 지금 그대로", () => {
  it("접은 화면 탭: 카드 날짜 줄 '… 브리핑' 그대로, 화면 읽기에도 없음, 플래그 false 와 같은 화면", async () => {
    const r = await tab();
    expect(muted(r)).toContain(DATE_LINE);
    expect(r.text()).not.toContain(AI_TAG);
    expect(cardLabels(r).some((l) => l.includes(AI_TAG))).toBe(false);
    const base = JSON.stringify(r.tree);
    h.flags = { briefingSafeWording: false };
    expect(JSON.stringify((await tab()).tree)).toBe(base);
  });

  it("상세 stack·pane·split 머리에 표시 없음 (시각 조각도 '… 생성' 그대로)", () => {
    for (const layout of ["stack", "split", "pane"] as const) {
      const r = body(layout);
      expect(r.text(), layout).not.toContain(AI_NOTE);
      expect(r.text(), layout).not.toContain(AI_TAG);
    }
    expect(muted(body("pane")).some((m) => m.endsWith("생성 ·"))).toBe(false);
  });

  it("카드 기본값(aiTag 없음)은 aiTag={false} 와 같은 모양", () => {
    const a = render(<BriefingCard briefing={OK} mode="line" />);
    const b = render(<BriefingCard briefing={OK} mode="line" aiTag={false} />);
    expect(JSON.stringify(b.tree)).toBe(JSON.stringify(a.tree));
  });
});

describe("켬: 'AI가 쓴 글' 표시", () => {
  beforeEach(() => {
    h.flags = { briefingSafeWording: true };
  });

  it("접은 화면 카드: 날짜 줄 끝 ' · AI가 쓴 글'(같은 Muted 한 줄), 화면 읽기에 날짜 다음 'AI가 쓴 글'", async () => {
    const r = await tab();
    expect(muted(r)).toContain(`${DATE_LINE} · ${AI_TAG}`);
    // 날짜만 있는 줄은 실패 브리핑 카드(같은 날짜·회차) 하나뿐
    expect(muted(r).filter((m) => m === DATE_LINE)).toHaveLength(1);
    // 새 줄을 만들지 않는다: 'AI가 쓴 글' 이 따로 선 Muted·Text 가 없다
    expect(r.all().filter((n) => (n.type === "Muted" || n.type === "Text") && rawOf(n) === AI_TAG)).toHaveLength(0);
    const label = cardLabels(r).find((l) => l.startsWith(OK.name!))!;
    expect(label).toContain(`${DATE_LINE}, ${AI_TAG}`);
  });

  it("실패 브리핑 카드에는 붙이지 않는다", async () => {
    const r = await tab();
    const failedLabel = cardLabels(r).find((l) => l.startsWith(FAILED.name!))!;
    expect(failedLabel).toContain("생성 실패");
    expect(failedLabel).not.toContain(AI_TAG);
    expect(muted(r).filter((m) => m.endsWith(AI_TAG))).toHaveLength(1);
    const card = render(<BriefingCard briefing={FAILED} mode="line" aiTag />);
    expect(card.text()).not.toContain(AI_TAG);
  });

  it("상세 폰(stack): 날짜 줄 아래 Muted 한 줄 'AI가 쓴 글 · 틀릴 수 있음'", () => {
    const r = body("stack");
    const m = muted(r);
    const at = m.findIndex((x) => x.startsWith(`${DATE_LINE} · `) && x.endsWith("생성"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(m[at + 1]).toBe(AI_NOTE);
  });

  it("상세 2단 오른쪽 칸(pane)·두 칸(split) 머리: 시각 조각 끝 ' ·' 다음 조각 'AI가 쓴 글 · 틀릴 수 있음'", () => {
    for (const layout of ["pane", "split"] as const) {
      const m = muted(body(layout));
      const at = m.indexOf(AI_NOTE);
      expect(at, layout).toBeGreaterThan(0);
      expect(m[at - 1], layout).toMatch(/생성 ·$/);
      expect(m[at - 2], layout).toBe(`${DATE_LINE} ·`);
    }
  });

  it("실패 브리핑 상세에는 없다", () => {
    h.detail = detailOf(FAILED);
    for (const layout of ["stack", "split", "pane"] as const) expect(body(layout).text(), layout).not.toContain(AI_NOTE);
  });
});
