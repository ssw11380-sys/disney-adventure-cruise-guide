import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 상세의 등락·손익 색 (BH-38 검증 지적): 각 글자는 그 글자에 보이는 값으로 색을 정한다.
 *  - 잔고 칸의 "0원"·"0.00%" 는 기본 글자색 (잔고 한 줄과 같은 규칙)
 *  - 1센트 미만으로 움직인 동전주도 "-7.41%"·"▼5" 처럼 보이는 등락은 하락 색 (전역 반올림 기준으로 지우지 않는다)
 */
const h = vi.hoisted(() => ({
  stock: undefined as unknown,
  settings: { showKrw: false, afterCost: false },
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { back: vi.fn(), dismissTo: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ code: "005930" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: h.stock }),
  useCandles: () => idle,
  useBriefings: () => idle,
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => idle,
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 } }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.now(), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
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
const { changeColor, light } = await import("@/tokens");

const text = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(text).join(""));
const colorOf = (n: HostNode) => [n.props.style].flat(3).reduce<string | undefined>((c, s) => (s as { color?: string } | undefined)?.color ?? c, undefined);

function open(stock: RegisteredWithQuote, settings = { showKrw: false, afterCost: false }) {
  h.stock = stock;
  h.settings = settings;
  const r = render(<StockDetailScreen />);
  const stats = r.all().filter((n) => n.type === "Stat");
  const stat = (label: string, nth = 0) => {
    const s = stats.filter((n) => n.props.label === label)[nth]!;
    return { value: s.props.value, color: changeColor(light, s.props.change as number | null | undefined) };
  };
  const line = (t: string) => {
    const n = r.all().find((x) => x.type === "Text" && text(x) === t);
    if (!n) throw new Error(`글자 없음: ${t}`);
    return colorOf(n);
  };
  const price = r.all().find((n) => n.type === "FlashPrice")!;
  return { stat, line, priceColor: colorOf(price), a11y: r.all().map((n) => n.props.accessibilityLabel).filter(Boolean).join(" | ") };
}

beforeEach(() => {
  h.stock = undefined;
});

describe("BH-38: 상세 잔고 칸", () => {
  it("국내 1주 평단 1,833.33원·현재가 1,833원: 평가손익 '0원' 은 기본 글자색 (잔고 한 줄과 같게, 재현)", () => {
    const d = open(holding("005930", quote("005930", 1833), 1, 1833.33));
    expect(d.stat("평가손익")).toEqual({ value: "0원", color: light.ink });
    // 수익률은 보이는 대로 손실
    expect(d.stat("수익률")).toEqual({ value: "-0.02%", color: light.down });
  });

  it("미국 소수점 보유: '$0.00'·'0.00%' 기본 글자색, 원화 기준 줄도 같게", () => {
    const qty = 0.052631;
    const d = open(holding("AAPL", quote("AAPL", 190, { currency: "USD", fxRate: 1360 }), qty, 10 / qty, { costBasisKrw: 13_600 }));
    expect(d.stat("평가손익")).toEqual({ value: "$0.00", color: light.ink });
    expect(d.stat("수익률")).toEqual({ value: "0.00%", color: light.ink });
    expect(d.stat("평가손익", 1)).toEqual({ value: "0원", color: light.ink });
    expect(d.stat("수익률", 1)).toEqual({ value: "0.00%", color: light.ink });
  });

  it("보이는 손익은 예전처럼 부호 색", () => {
    const d = open(holding("005930", quote("005930", 1800), 2, 1833));
    expect(d.stat("평가손익")).toEqual({ value: "-66원", color: light.down });
    expect(d.stat("수익률")).toEqual({ value: "-1.80%", color: light.down });
  });
});

describe("BH-38 검증 지적: 1센트 미만으로 움직인 동전주 머리 (회귀)", () => {
  const penny = () => holding("SNDL", quote("SNDL", 0.05, { currency: "USD", change: -0.004, changeRate: -7.41, fxRate: 1360 }), null, null);

  it("달러 보기: 등락률 '-7.41%' 와 현재가는 하락 색, 0 으로 보이는 화살표만 기본 글자색", () => {
    const d = open(penny());
    expect(d.line("-7.41%")).toBe(light.down);
    expect(d.priceColor).toBe(light.down);
    expect(d.line("0")).toBe(light.ink);
    expect(d.a11y).toContain("7.41% 하락");
  });

  it("원화 보기: '▼5' 는 하락 색 (예전 전역 기준에서는 기본 글자색이던 회귀)", () => {
    const d = open(penny(), { showKrw: true, afterCost: false });
    expect(d.line("▼5")).toBe(light.down);
    expect(d.line("-7.41%")).toBe(light.down);
    expect(d.a11y).toContain("하락");
  });
});
