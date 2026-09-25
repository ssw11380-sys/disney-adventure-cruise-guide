import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Briefing, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 상세 넓은 창 배치 (3-42 웨이브 C, 기능 플래그 foldLayout).
 *  - 플래그가 꺼져 있거나 좁은 창(접힌 화면)이면 지금 화면과 한 글자도 다르지 않다: 바꾸기 전 화면에서 뜬 결과(스냅숏)와 같은지 본다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  insets: { top: 32, bottom: 48, left: 0, right: 0 },
  flag: undefined as boolean | undefined,
  params: { code: "005930" } as Record<string, string | undefined>,
  stock: undefined as unknown,
  briefings: undefined as Briefing[] | undefined,
  news: undefined as unknown,
  settings: { showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" },
  nav: null as unknown,
  navArgs: [] as unknown[][],
  replace: vi.fn(),
  setParams: vi.fn(),
  back: vi.fn(),
  canGoBack: true,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "StackScreen" },
  router: { back: h.back, dismissTo: vi.fn(), push: vi.fn(), replace: h.replace, setParams: h.setParams, canGoBack: () => h.canGoBack },
  useLocalSearchParams: () => h.params,
  usePathname: () => "/stocks/005930",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return {
    ...tokens,
    useTheme: () => tokens.light,
    useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap),
  };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: h.stock }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: h.briefings }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => ({ ...idle, data: h.news }),
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : fallback),
  useApi: () => ({ listStocks: async () => [] }),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));
vi.mock("@/lib/holdingsNav", async (orig) => ({
  ...(await orig<typeof import("@/lib/holdingsNav")>()),
  useHoldingsNav: (...args: unknown[]) => {
    h.navArgs.push(args);
    return args[2] ? h.nav : null;
  },
}));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: (raw: unknown) => (raw === "W" || raw === "M" ? raw : "D") }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.parse("2026-09-25T12:00:00Z"), feedOk: true }) }));
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

/** 결과 트리를 비교할 수 있는 값으로: 함수는 '[fn]', 속성으로 넘긴 요소(top·refreshControl 등)는 이름과 속성만 */
function ser(v: unknown): unknown {
  if (typeof v === "function") return "[fn]";
  if (React.isValidElement(v)) {
    const e = v as React.ReactElement<Record<string, unknown>>;
    const name = typeof e.type === "string" ? e.type : ((e.type as { name?: string }).name ?? "?");
    return { el: name, key: e.key, props: ser(e.props) };
  }
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}
const tree = (nodes: (HostNode | string)[]): unknown =>
  nodes.map((n) => {
    if (typeof n === "string") return n;
    const { children: _c, ...props } = n.props;
    return { type: n.type, props: ser(props), children: tree(n.children) };
  });

const brief = (id: number, session: "morning" | "afternoon"): Briefing => ({
  id,
  code: "005930",
  name: "삼성전자",
  session,
  date: "2026-09-23",
  status: "ok",
  summary: `요약 ${id} 첫 줄\n둘째 줄`,
  detail: `# 상세 ${id}`,
  missing: [],
  model: "m",
  error: null,
  createdAt: "2026-09-23T11:00:00Z",
});

const FULL = { open: 83_500, high: 84_900, low: 82_800, prevClose: 83_100, volume: 14_832_110, marketCap: 503e12, per: 14.82, pbr: 1.41, eps: 5_688, bps: 59_786, high52w: 88_800, low52w: 53_000, dividendYieldPct: 1.71, dividendPerShare: 1_444 };
const samsung = () => ({ ...holding("005930", quote("005930", 84_300, { ...FULL, change: 1_200, changeRate: 1.44, priceBasis: "KRX+NXT 통합" }), 120, 71_000, {}, "삼성전자"), registered: true });
const apple = () => ({
  ...holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: 1391.5, open: 256, high: 257, low: 253, prevClose: 258.5, volume: 48_210_000, marketCap: 3.78e12 }), 30, 180, { costBasisKrw: 7_302_600 }, "애플"),
  market: "NASDAQ" as const,
  registered: true,
});
const unregistered = () => ({ ...holding("035720", quote("035720", 41_000, { change: -300, changeRate: -0.73 }), null, null, {}, "카카오"), registered: false });

const CASES: Record<string, () => RegisteredWithQuote & { registered?: boolean }> = { samsung, apple, unregistered };

function open(stock: RegisteredWithQuote, extra: Partial<typeof h> = {}) {
  h.stock = stock;
  Object.assign(h, extra);
  return render(<StockDetailScreen />);
}

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.insets = { top: 32, bottom: 48, left: 0, right: 0 };
  h.flag = undefined;
  h.params = { code: "005930" };
  h.briefings = [brief(2, "afternoon"), brief(1, "morning")];
  h.news = undefined;
  h.settings = { showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" };
  h.nav = null;
  h.navArgs.length = 0;
  h.replace.mockReset();
  h.setParams.mockReset();
  h.back.mockReset();
  h.canGoBack = true;
});

describe("플래그 꺼짐·좁은 창: 지금 화면 그대로 (바꾸기 전 스냅숏)", () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: 폴드8 펼침 가로 크기라도 플래그가 꺼져 있으면 지금 화면`, () => {
      h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
      const r = open(make());
      expect(tree(r.tree)).toMatchSnapshot();
    });
  }
});
