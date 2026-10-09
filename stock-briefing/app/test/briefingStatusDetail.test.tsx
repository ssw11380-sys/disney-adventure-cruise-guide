import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Briefing } from "@/api/types";
import { holding, quote } from "./helpers";
import { render } from "./miniRender";

/**
 * 브리핑 3차 2 (플래그 briefingStatus) — 종목 상세의 '최근 브리핑' 실패 카드도 오류 원문 대신 쉬운 말 (브리핑 탭·브리핑 상세와 같게).
 *  - 폰 화면(stocks/[code]/index 아래 '최근 브리핑')과 넓은 창의 브리핑 목록(StockDetailParts.BriefingList) 모두 켜면 plainFail 을 넘긴다
 *  - 꺼지면(앱 기본) 속성을 넘기지 않아 지금 그대로
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  briefings: [] as unknown[],
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined },
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Animated: { View: "AnimatedView", Value: class {}, timing: () => ({ start: () => undefined }) },
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { back: vi.fn(), dismissTo: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ code: "TSLA" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: holding("TSLA", quote("TSLA", 250, { currency: "USD", fxRate: 1360 }), 1, 200, {}, "테슬라") }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: h.briefings }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => idle,
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useApi: () => ({ listStocks: async () => [] }),
}));
vi.mock("@/lib/holdingsNav", () => ({ useHoldingsNav: () => null, useCachedRow: () => null, rememberNav: vi.fn() }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false }) }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: () => "D" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.now(), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", Disclaimer: "Disclaimer" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({
  Button: "Button",
  Card: "Card",
  ErrorView: "ErrorView",
  LiveDot: "LiveDot",
  Loading: "Loading",
  Muted: "Muted",
  SectionTitle: "SectionTitle",
  Segmented: "Segmented",
  Stat: "Stat",
  StatGrid: "StatGrid",
}));

const { default: StockDetailScreen } = await import("@/app/stocks/[code]/index");
const { BriefingList } = await import("@/components/StockDetailParts");

const RATE_LIMIT = "api: API 사용량 제한에 걸렸습니다 (429). 잠시 뒤 다시 시도해 주세요";
const B = (id: number, over: Partial<Briefing> = {}): Briefing => ({
  id, code: "TSLA", name: "테슬라", session: "morning", date: "2026-09-28", status: "ok", summary: "요약", detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-09-28T08:32:00+09:00", ...over,
});
const LIST = [B(702, { status: "failed", summary: `브리핑 생성 실패: ${RATE_LIMIT}`, error: RATE_LIMIT }), B(690, { date: "2026-09-25" })];

beforeEach(() => {
  h.flags = {};
  h.briefings = LIST;
});

const cards = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "BriefingCard");

describe("종목 상세 '최근 브리핑' 실패 카드 (briefingStatus)", () => {
  it("폰 화면: 켜면 카드마다 plainFail, 꺼지면 속성 없음 (지금 그대로)", () => {
    h.flags.briefingStatus = true;
    const on = cards(render(<StockDetailScreen />));
    expect(on).toHaveLength(2);
    expect(on.every((c) => c.props.plainFail === true)).toBe(true);
    h.flags.briefingStatus = false;
    const off = cards(render(<StockDetailScreen />));
    expect(off).toHaveLength(2);
    expect(off.some((c) => "plainFail" in c.props)).toBe(false);
    h.flags = {};
    expect(cards(render(<StockDetailScreen />)).some((c) => "plainFail" in c.props)).toBe(false);
  });

  it("넓은 창 브리핑 목록(BriefingList): 켜면 plainFail, 꺼지면 속성 없음", () => {
    const query = { data: LIST as Briefing[], isLoading: false, isError: false, error: null, refetch: () => undefined };
    h.flags.briefingStatus = true;
    expect(cards(render(<BriefingList query={query} />)).map((c) => c.props.plainFail)).toEqual([true, true]);
    h.flags.briefingStatus = false;
    expect(cards(render(<BriefingList query={query} />)).some((c) => "plainFail" in c.props)).toBe(false);
  });
});
