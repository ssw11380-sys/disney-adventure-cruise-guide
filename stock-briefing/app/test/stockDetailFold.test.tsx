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
  /** 서버가 준 detailPolish 값 (undefined = 못 받음 → fallback 꺼짐) */
  polish: undefined as boolean | undefined,
  params: { code: "005930" } as Record<string, string | undefined>,
  stock: undefined as unknown,
  stockError: false,
  /** 잔고 목록 캐시에서 찾은 줄 (useCachedRow) */
  cached: null as unknown,
  cachedArgs: [] as unknown[][],
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
  useStock: () => ({ ...idle, data: h.stock, isError: h.stockError, error: h.stockError ? new Error("시세 서버 오류") : null }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: h.briefings }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => ({ ...idle, data: h.news }),
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : key === "detailPolish" ? (h.polish ?? fallback) : fallback),
  useApi: () => ({ listStocks: async () => [] }),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));
vi.mock("@/lib/holdingsNav", async (orig) => ({
  ...(await orig<typeof import("@/lib/holdingsNav")>()),
  useHoldingsNav: (...args: unknown[]) => {
    h.navArgs.push(args);
    return args[2] ? h.nav : null;
  },
  useCachedRow: (...args: unknown[]) => {
    h.cachedArgs.push(args);
    return args[1] ? h.cached : null;
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
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { navAt } = await import("@/lib/holdingsNav");
const { foldDetail, layout, light, space } = await import("@/tokens");
const { sideWidth, statColumns, wideChartHeight } = await import("@/lib/detailLayout");

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
  h.polish = undefined;
  h.params = { code: "005930" };
  h.briefings = [brief(2, "afternoon"), brief(1, "morning")];
  h.news = { code: "005930", name: "삼성전자", news: [], newsError: null, disclosures: [], disclosuresError: null };
  h.settings = { showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" };
  h.nav = null;
  h.navArgs.length = 0;
  h.stockError = false;
  h.cached = null;
  h.cachedArgs.length = 0;
  h.replace.mockReset();
  h.setParams.mockReset();
  h.back.mockReset();
  h.canGoBack = true;
  forgetWindowClass();
});

/** 창 크기 (앱이 쓰는 창) */
const SIZE = {
  F8C: [475, 679],
  UC: [411, 888],
  F8L: [933, 632],
  F8P: [704, 861],
  UP: [859, 882],
  UL: [954, 787],
} as const;
const size = (k: keyof typeof SIZE, fontScale = 1) => {
  const [width, height] = SIZE[k];
  h.win = { width, height, scale: 2.625, fontScale };
};
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const stack = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "StackScreen")!.props.options as Record<string, unknown>;
const segmented = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "Segmented");
const chart = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "CandleChart")!;
const NAV_ITEMS = [
  { code: "005930", name: "삼성전자" },
  { code: "000660", name: "SK하이닉스" },
  { code: "035420", name: "NAVER" },
];

describe("플래그 꺼짐·좁은 창: 지금 화면 그대로 (바꾸기 전 스냅숏)", () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: 폴드8 펼침 가로 크기라도 플래그가 꺼져 있으면 지금 화면`, () => {
      h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
      const r = open(make());
      expect(tree(r.tree)).toMatchSnapshot();
    });

    it(`${name}: 플래그가 꺼져 있으면 여섯 크기 모두, 켜져 있어도 접힌 화면 두 크기는 스냅숏과 같은 결과`, () => {
      h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
      const golden = tree(open(make()).tree);
      for (const k of Object.keys(SIZE) as (keyof typeof SIZE)[]) {
        forgetWindowClass();
        size(k);
        expect(tree(open(make()).tree), `꺼짐 ${k}`).toEqual(golden);
      }
      for (const k of ["F8C", "UC"] as const) {
        forgetWindowClass();
        size(k);
        expect(tree(open(make(), { flag: true }).tree), `켜짐 ${k}`).toEqual(golden);
        h.flag = undefined;
      }
    });
  }

  it("플래그가 꺼져 있으면 기간·탭을 바꿔도 주소 검색어를 건드리지 않는다 (지금 그대로)", () => {
    size("F8L");
    const r = open(samsung());
    r.act(() => (chart(r).props.onPeriodChange as (p: string) => void)("W"));
    r.act(() => (segmented(r)[0]!.props.onChange as (v: string) => void)("news"));
    expect(h.setParams).not.toHaveBeenCalled();
    expect(chart(r).props.period).toBe("W");
    expect(segmented(r)[0]!.props.value).toBe("news");
  });
});

describe("좌우 배치 (펼친 폴드8 가로 · 울트라 가로)", () => {
  const openSplit = (k: "F8L" | "UL" = "F8L", extra: Partial<typeof h> = {}) => {
    size(k);
    return open(samsung(), { flag: true, ...extra });
  };

  it("Stack 머리를 숨기고 합친 머리(뒤로 · 이름 · 가격 · 수정)를 그린다", () => {
    const r = openSplit();
    expect(stack(r)).toEqual({ headerShown: false });
    expect(r.has("뒤로")).toBe(true);
    expect(r.has("보유 정보 수정")).toBe(true);
    expect(r.text()).toContain("삼성전자");
    expect(r.all().some((n) => n.type === "FlashPrice" && n.props.text === "84,300")).toBe(true);
    // 위 화면 여백은 머리가 맡는다
    const head = r.byLabel("뒤로");
    expect(r.all().some((n) => flat(n).paddingTop === h.insets.top && n.children.some((c) => typeof c !== "string" && c.children.includes(head)))).toBe(true);
  });

  it("오른쪽 칸만 스크롤·당겨서 새로고침, 고지는 맨 아래", () => {
    const r = openSplit();
    const scrolls = r.all().filter((n) => n.type === "ScrollView");
    expect(scrolls).toHaveLength(2);
    expect(scrolls[0]!.props.refreshControl).toBeUndefined();
    expect(React.isValidElement(scrolls[1]!.props.refreshControl)).toBe(true);
    expect(r.all().filter((n) => n.type === "Disclaimer")).toHaveLength(1);
    expect(r.tree.at(-1)).toBeDefined();
    // 오른쪽 칸 폭 = sideWidth
    expect(r.all().some((n) => flat(n).width === sideWidth(1))).toBe(true);
  });

  it("오른쪽 칸: 내 보유 6칸 · 시세 14칸을 한 줄 2칸으로, 탭은 브리핑부터", () => {
    const r = openSplit();
    const labels = r.all().filter((n) => n.type === "Stat").map((n) => n.props.label);
    expect(labels.slice(0, 6)).toEqual(["보유수량", "평균단가", "평가금액", "매입금액", "평가손익", "수익률"]);
    expect(labels.slice(6)).toEqual(["시가", "전일", "고가", "거래량", "저가", "시가총액", "52주 최고", "52주 최저", "PER", "PBR", "EPS", "BPS", "배당수익률", "주당배당"]);
    const tabs = segmented(r)[0]!;
    expect((tabs.props.options as { value: string }[]).map((o) => o.value)).toEqual(["briefing", "news", "company", "value", "technical"]);
    expect(tabs.props.value).toBe("briefing");
    expect(r.all().filter((n) => n.type === "BriefingCard")).toHaveLength(2);
  });

  it("왼쪽 칸 높이에 맞춰 차트 그림 높이를 정한다 (둘레를 잰 뒤 칸 − 둘레)", () => {
    const r = openSplit();
    expect(chart(r).props.height).toBeUndefined();
    const pane = r.all().find((n) => typeof n.props.onLayout === "function" && flat(n).flex === 1 && flat(n).minWidth === 0)!;
    r.act(() => (pane.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 592, height: 540 } } }));
    const first = chart(r).props.height as number;
    expect(first).toBe(540 - 120);
    // 패널의 onLayout 은 그릴 때마다 새로 만든다 → 매번 지금 트리에서 찾는다
    const layoutPanel = (height: number) => {
      const panel = r.all().find((n) => typeof n.props.onLayout === "function" && n.children.some((c) => typeof c !== "string" && c.type === "CandleChart"))!;
      r.act(() => (panel.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 592, height } } }));
    };
    // 실제 둘레가 170 이면 차트를 줄여 칸에 맞춘다 (첫 번째는 패널 폭을 재고, 두 번째에 둘레를 잰다)
    layoutPanel(first + 170);
    layoutPanel((chart(r).props.height as number) + 170);
    expect(chart(r).props.height).toBe(540 - 170);
    // 둘레가 줄어도(십자선 읽기 줄) 차트는 다시 커지지 않는다 — 흔들림 방지
    layoutPanel((chart(r).props.height as number) + 150);
    expect(chart(r).props.height).toBe(540 - 170);
    // 아주 낮은 창이면 최소 높이 (왼쪽 칸이 스크롤된다)
    r.act(() => (pane.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 592, height: 200 } } }));
    expect(chart(r).props.height).toBe(layout.chartMinH);
  });

  it("큰 글씨(130%)는 오른쪽 칸을 넓히고 한 줄에 한 칸", () => {
    size("F8L", 1.3);
    const r = open(samsung(), { flag: true });
    expect(r.all().some((n) => flat(n).width === sideWidth(1.3))).toBe(true);
    expect(statColumns(sideWidth(1.3) - space.lg * 2, 1.3, 2)).toBe(1);
  });

  it("‹ n/17 ›: 다음 종목으로 바꿔 끼우고(뒤로 가기에 쌓지 않음) 차트 기간·탭을 넘긴다", () => {
    const r = openSplit("F8L", { nav: navAt("held", NAV_ITEMS, "005930") });
    expect(r.has("보유 3종목 중 1번째")).toBe(true);
    expect(r.byLabel("이전 종목 없음").props.disabled).toBe(true);
    r.act(() => (chart(r).props.onPeriodChange as (p: string) => void)("W"));
    expect(h.setParams).toHaveBeenLastCalledWith({ period: "W" });
    r.act(() => (segmented(r)[0]!.props.onChange as (v: string) => void)("news"));
    expect(h.setParams).toHaveBeenLastCalledWith({ tab: "news" });
    r.act(() => (r.byLabel("다음 종목, SK하이닉스").props.onPress as () => void)());
    expect(h.replace).toHaveBeenCalledWith({ pathname: "/stocks/[code]", params: { code: "000660", period: "W", tab: "news", nav: "1" } });
  });

  it("주소 검색어의 기간·탭으로 연다 (접고 펴기 · ‹ › 로 온 화면)", () => {
    const r = openSplit("F8L", { params: { code: "005930", period: "W", tab: "value", nav: "1" } });
    expect(chart(r).props.period).toBe("W");
    expect(segmented(r)[0]!.props.value).toBe("value");
    expect(h.navArgs.at(-1)).toEqual(["005930", true, true]);
  });

  it("미등록 종목은 수정 대신 관심 추가, 뒤로는 쌓인 화면이 없으면 잔고로", () => {
    size("F8L");
    h.canGoBack = false;
    const r = open(unregistered(), { flag: true });
    expect(r.has("관심 종목에 추가")).toBe(true);
    expect(r.has("보유 정보 수정")).toBe(false);
    r.act(() => (r.byLabel("뒤로").props.onPress as () => void)());
    expect(h.back).not.toHaveBeenCalled();
  });

  it("넓은 창에서 숨긴 Stack 머리는 접으면 되살린다 (화면 옵션이 합쳐져 숨김이 남지 않게)", () => {
    size("F8L");
    const r = open(samsung(), { flag: true });
    expect(stack(r)).toEqual({ headerShown: false });
    size("F8C");
    r.rerender();
    expect(stack(r)).toMatchObject({ headerShown: true, title: "삼성전자" });
  });
});

describe("윗줄+아랫줄 배치 (울트라 펼침 세로)", () => {
  const NEWS = {
    code: "005930",
    name: "삼성전자",
    news: Array.from({ length: 6 }, (_, i) => ({ title: `뉴스 ${i}`, url: `https://n/${i}`, source: "언론", publishedAt: "2026-09-25T00:00:00Z", summary: null })),
    newsError: null,
    disclosures: Array.from({ length: 4 }, (_, i) => ({ receiptNo: `r${i}`, title: `공시 ${i}`, filedAt: "2026-09-23", filer: "삼성전자", url: `https://d/${i}` })),
    disclosuresError: null,
  };

  it("아랫줄에 최근 브리핑 2 · 뉴스 4 · 공시 3 이 탭 없이 함께, 나머지는 더 보기", () => {
    size("UP");
    h.briefings = [brief(3, "afternoon"), brief(2, "morning"), brief(1, "afternoon")];
    const r = open(samsung(), { flag: true, news: NEWS });
    expect(r.all().filter((n) => n.type === "BriefingCard")).toHaveLength(foldDetail.rowsBriefings);
    expect(r.all().filter((n) => /^뉴스:/.test(String(n.props.accessibilityLabel ?? "")))).toHaveLength(foldDetail.rowsNews);
    expect(r.all().filter((n) => /^공시:/.test(String(n.props.accessibilityLabel ?? "")))).toHaveLength(foldDetail.rowsDisclosures);
    r.act(() => (r.byLabel("뉴스 더 보기").props.onPress as () => void)());
    expect(r.all().filter((n) => /^뉴스:/.test(String(n.props.accessibilityLabel ?? "")))).toHaveLength(6);
    // 아랫줄 브리핑 칸은 뉴스·공시 칸보다 넓다 (설계 329 | 265 | 265 — 카드 머리가 한 줄에)
    expect(r.all().some((n) => flat(n).flex === foldDetail.rowsBriefFlex)).toBe(true);
  });

  it("오른쪽 칸 AI 분석: 탭 없이 기업개요 · 기술분석 미리보기를 함께, 가치분석은 제목 줄만 ('더 보기'로 펼침)", () => {
    size("UP");
    const r = open(samsung(), { flag: true });
    // 탭(Segmented)이 없다 — 설계 목업과 같이
    expect(segmented(r)).toHaveLength(0);
    expect(r.text()).toContain("AI 기업개요");
    expect(r.text()).toContain("AI 기술분석");
    expect(r.text()).toContain("AI 가치분석");
    // 기업개요·기술분석은 받는 중(가짜 useAnalysis 가 불러오는 중), 가치분석은 접혀 있어 받지 않는다
    expect(r.all().filter((n) => n.type === "Loading")).toHaveLength(2);
    r.act(() => (r.byLabel("AI 가치분석 더 보기").props.onPress as () => void)());
    expect(r.all().filter((n) => n.type === "Loading")).toHaveLength(3);
    expect(r.byLabel("AI 가치분석 접기").props.accessibilityState).toEqual({ expanded: true });
  });

  it("오른쪽 칸 AI 분석: 받은 분석은 앞 몇 줄만(기업개요 3 · 기술분석 2), '더 보기'로 그 자리에서 전체 + 갱신", async () => {
    size("UP");
    const hooks = await import("@/api/hooks");
    const spy = vi.spyOn(hooks, "useAnalysis").mockImplementation(((_code: string, kind: string) => ({ ...idle, data: { content: `# 제목\n- ${kind} 첫째\n- 둘째`, missing: [], createdAt: "2026-09-25T00:00:00Z" } })) as never);
    try {
      const r = open(samsung(), { flag: true });
      const previews = r.all().filter((n) => n.type === "Text" && typeof n.props.numberOfLines === "number" && n.children.some((c) => typeof c === "string" && /첫째/.test(c)));
      expect(previews.map((n) => n.props.numberOfLines)).toEqual([foldDetail.previewCompanyLines, foldDetail.previewTechLines]);
      expect(r.text()).toContain("company 첫째 둘째");
      expect(r.text()).toContain("9/25 09:00 기준");
      expect(r.all().some((n) => n.type === "MarkdownView")).toBe(false);
      r.act(() => (r.byLabel("AI 기업개요 더 보기").props.onPress as () => void)());
      expect(r.all().filter((n) => n.type === "MarkdownView")).toHaveLength(1);
      expect(r.all().some((n) => n.type === "Button" && n.props.title === "갱신")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("주소 검색어가 가치분석(tab=value)이면 가치분석을 펼친 채 연다", () => {
    size("UP");
    const r = open(samsung(), { flag: true, params: { code: "005930", tab: "value" } });
    expect(r.all().filter((n) => n.type === "Loading")).toHaveLength(3);
  });

  it("미등록 종목: 미리보기마다 'AI 분석 만들기' (누르면 그 분석만 만든다)", () => {
    size("UP");
    const r = open(unregistered(), { flag: true });
    const make = r.all().filter((n) => n.type === "Button" && n.props.title === "AI 분석 만들기");
    expect(make).toHaveLength(2);
    r.act(() => (make[0]!.props.onPress as () => void)());
    expect(r.all().filter((n) => n.type === "Button" && n.props.title === "AI 분석 만들기")).toHaveLength(1);
  });

  it("차트는 옆 칸 높이에 맞추되 기본 크기보다 작아지지 않는다", () => {
    size("UP");
    const r = open(samsung(), { flag: true });
    const side = r.all().find((n) => typeof n.props.onLayout === "function" && flat(n).alignSelf === "flex-start" && flat(n).width !== undefined)!;
    r.act(() => (side.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 340, height: 600 } } }));
    expect(chart(r).props.height).toBe(600 - 120);
    r.act(() => (side.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 340, height: 200 } } }));
    expect(chart(r).props.height).toBeGreaterThan(layout.chartMinH);
    // AI 분석을 펼쳐 옆 칸이 아주 길어져도 창 높이 × rowsChartMaxRatio 에서 멈춘다
    r.act(() => (side.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 340, height: 3000 } } }));
    expect(chart(r).props.height).toBe(Math.round(882 * foldDetail.rowsChartMaxRatio));
  });
});

describe("한 단 배치 (폴드8 펼침 세로)", () => {
  const columns = (r: ReturnType<typeof render>) =>
    r
      .all()
      .filter((n) => flat(n).flexDirection === "row" && flat(n).alignItems === "flex-start" && flat(n).columnGap === space.lg)[0]!
      .children.filter((c): c is HostNode => typeof c !== "string");
  const statsIn = (col: HostNode): string[] => {
    const out: string[] = [];
    const walk = (n: HostNode | string) => {
      if (typeof n === "string") return;
      if (n.type === "Stat") out.push(String(n.props.label));
      n.children.forEach(walk);
    };
    walk(col);
    return out;
  };

  it("차트 전체 폭(높이 = 창 × 0.32) → 내 보유 | 시세 세 칸 (위에서 아래로)", () => {
    size("F8P");
    const r = open(samsung(), { flag: true });
    expect(chart(r).props.height).toBe(wideChartHeight(704 - space.lg * 2, 861));
    const cols = columns(r);
    expect(cols).toHaveLength(4);
    // 내 보유 칸은 시세 칸보다 넓다 (설계 200 | 168 × 3)
    expect(cols.map((c) => flat(c).flex)).toEqual([foldDetail.holdColFlex, 1, 1, 1]);
    expect(statsIn(cols[0]!)).toEqual(["보유수량", "평균단가", "평가금액", "매입금액", "평가손익", "수익률"]);
    expect(statsIn(cols[1]!)).toEqual(["시가", "고가", "저가", "전일", "거래량"]);
    expect(statsIn(cols[2]!)).toEqual(["시가총액", "52주 최고", "52주 최저", "PER", "PBR"]);
    expect(statsIn(cols[3]!)).toEqual(["EPS", "BPS", "배당수익률", "주당배당"]);
  });

  it("52주 막대: 좁은 마지막 칸은 '52주 저 · % · 고'만 (값은 같은 표의 52주 최고·최저 줄에), 좌우 배치 오른쪽 칸은 값까지", () => {
    size("F8P");
    const text = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(text).join(""));
    const last = columns(open(samsung(), { flag: true })).at(-1)!;
    expect(text(last)).toContain("52주 저");
    expect(text(last)).not.toContain("52주 저 53,000");
    forgetWindowClass();
    size("F8L");
    expect(open(samsung(), { flag: true }).text()).toContain("52주 저 53,000");
  });

  it("최근 브리핑은 처음 2건, 나머지는 '더 보기' (설계 2건)", () => {
    size("F8P");
    h.briefings = [brief(3, "afternoon"), brief(2, "morning"), brief(1, "afternoon")];
    const r = open(samsung(), { flag: true });
    expect(r.all().filter((n) => n.type === "BriefingCard")).toHaveLength(foldDetail.wideBriefings);
    r.act(() => (r.byLabel("최근 브리핑 더 보기").props.onPress as () => void)());
    expect(r.all().filter((n) => n.type === "BriefingCard")).toHaveLength(3);
  });

  it("달러 종목: 원화 기준 4칸은 따로 한 칸, 시세는 두 칸", () => {
    size("F8P");
    const r = open(apple(), { flag: true });
    const cols = columns(r);
    expect(cols).toHaveLength(4);
    expect(cols.map((c) => flat(c).flex)).toEqual([foldDetail.holdColFlex, foldDetail.holdColFlex, 1, 1]);
    expect(statsIn(cols[1]!)).toEqual(["평가금액", "매입금액", "평가손익", "수익률"]);
    expect(statsIn(cols[2]!)).toHaveLength(7);
    expect(r.text()).toContain("원화 기준");
  });

  it("관심 종목(보유 없음)은 시세만 네 칸", () => {
    size("F8P");
    const r = open(unregistered(), { flag: true });
    const cols = columns(r);
    expect(cols).toHaveLength(4);
    expect(cols.flatMap(statsIn)).not.toContain("보유수량");
  });
});

describe("고지 문구", () => {
  it("넓은 창 배치 모두 고지를 붙인다 (좌우 배치는 SplitScreen 이, 나머지는 Screen disclaimer)", () => {
    for (const k of ["F8L", "UL"] as const) {
      forgetWindowClass();
      size(k);
      expect(open(samsung(), { flag: true }).all().filter((n) => n.type === "Disclaimer"), k).toHaveLength(1);
    }
    for (const k of ["UP", "F8P"] as const) {
      forgetWindowClass();
      size(k);
      const screen = open(samsung(), { flag: true }).all().find((n) => n.type === "Screen")!;
      expect(screen.props.disclaimer, k).toBe(true);
    }
  });
});

describe("불러오는 중·오류: 넓은 창은 처음부터 합친 머리 (Stack 머리 · 휴대폰 뼈대가 번쩍이지 않게)", () => {
  const loading = (extra: Partial<typeof h> = {}) => {
    h.stock = undefined;
    Object.assign(h, extra);
    return render(<StockDetailScreen />);
  };

  it("휴대폰 화면(플래그 꺼짐 · 접힌 화면)은 지금 그대로: Screen 안에 뼈대만, Stack 옵션을 건드리지 않고 캐시도 읽지 않는다", () => {
    for (const flag of [undefined, true]) {
      forgetWindowClass();
      size(flag ? "F8C" : "F8L");
      h.cached = samsung();
      const r = loading({ flag });
      expect(r.all().some((n) => n.type === "StackScreen")).toBe(false);
      expect(tree(r.tree)).toEqual([{ type: "Screen", props: {}, children: [{ type: "DetailSkeleton", props: {}, children: [] }] }]);
      expect(h.cachedArgs.every((a) => a[1] === false)).toBe(true);
    }
  });

  it("넓은 창 · 목록 캐시에 있으면(‹ › 로 넘길 때) 받아 둔 값으로 바로 넓은 배치를 그린다", () => {
    size("F8L");
    h.cached = samsung();
    const r = loading({ flag: true });
    expect(h.cachedArgs.at(-1)).toEqual(["005930", true]);
    expect(stack(r)).toEqual({ headerShown: false });
    expect(r.all().some((n) => n.type === "DetailSkeleton")).toBe(false);
    expect(r.all().some((n) => n.type === "FlashPrice" && n.props.text === "84,300")).toBe(true);
    expect(r.all().filter((n) => n.type === "Stat").map((n) => n.props.label).slice(0, 2)).toEqual(["보유수량", "평균단가"]);
    // 받은 뒤에는 캐시를 읽지 않는다
    h.stock = samsung();
    h.cachedArgs.length = 0;
    r.rerender();
    expect(h.cachedArgs.every((a) => a[1] === false)).toBe(true);
  });

  it("넓은 창 · 캐시에 없으면 합친 머리(뒤로 · 이름 · ‹ n/17 ›) + 뼈대, ‹ › 도 누를 수 있다", () => {
    size("F8L");
    const r = loading({ flag: true, nav: navAt("held", NAV_ITEMS, "005930"), params: { code: "005930", nav: "1" } });
    expect(stack(r)).toEqual({ headerShown: false });
    const top = render(r.all().find((n) => n.type === "Screen")!.props.top as React.ReactElement);
    expect(top.has("뒤로")).toBe(true);
    expect(top.text()).toContain("삼성전자");
    expect(top.text()).toContain("불러오는 중…");
    expect(r.all().some((n) => n.type === "DetailSkeleton")).toBe(true);
    top.act(() => (top.byLabel("다음 종목, SK하이닉스").props.onPress as () => void)());
    expect(h.replace).toHaveBeenCalledWith({ pathname: "/stocks/[code]", params: { code: "000660", period: "D", tab: "briefing", nav: "1" } });
  });

  it("넓은 창 · 오류도 합친 머리 + 다시 시도", () => {
    size("UP");
    const r = loading({ flag: true, stockError: true });
    expect(stack(r)).toEqual({ headerShown: false });
    expect(r.all().some((n) => n.type === "ErrorView")).toBe(true);
    const top = render(r.all().find((n) => n.type === "Screen")!.props.top as React.ReactElement);
    expect(top.text()).toContain("시세를 불러오지 못했습니다");
  });

  it("넓은 창에서 숨긴 머리는 불러오는 중에 접어도 되살린다", () => {
    size("F8L");
    const r = loading({ flag: true });
    expect(stack(r)).toEqual({ headerShown: false });
    size("F8C");
    r.rerender();
    expect(stack(r)).toEqual({ headerShown: true });
  });
});

describe("휴대폰·접은 화면 보유 한 줄 (기능 플래그 detailPolish — 2026-09-26 RGTX 캡처)", () => {
  /** 시세 머리 (Stack 머리 아래 첫 패널) */
  const head = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "View" && flat(n).borderBottomWidth === 1 && flat(n).paddingTop === space.md)!;
  const line = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "Text" && /^보유 .*주, 평가손익/.test(String(n.props.accessibilityLabel ?? "")));
  const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));

  it("켜짐: 시세 머리 맨 아래에 '보유 120주 · 평가손익 +1,596,000원 (+18.73%)', 한 문장으로 읽힌다", () => {
    const r = open(samsung(), { polish: true });
    const l = line(r)!;
    expect(textOf(l)).toBe("보유 120주 · 평가손익 +1,596,000원 (+18.73%)");
    expect(l.props.accessibilityLabel).toBe("보유 120주, 평가손익 1,596,000원 이익, 수익률 18.73% 상승");
    expect(l.props.numberOfLines).toBe(1);
    // 시세 머리의 마지막 줄 → 차트 패널이 바로 뒤 (첫 화면에서 차트를 밀어내는 것은 이 한 줄뿐)
    expect(head(r).children.at(-1)).toBe(l);
    // 색은 보이는 값의 부호 (이익 = 상승색), '보유 120주' 는 평단선과 같은 금색
    const parts = l.children.filter((c): c is HostNode => typeof c !== "string");
    expect(parts.map((p) => p.props.style)).toEqual([
      { color: light.gold, fontWeight: "700" },
      { color: light.up, fontWeight: "700" },
      { color: light.up },
    ]);
  });

  it("잔고 화면 줄과 같은 평가: 원화로 보기면 미국 종목도 원화, 매도 비용 차감 설정이면 차감 뒤 값", () => {
    h.settings = { ...h.settings, showKrw: true };
    const us = open(apple(), { polish: true, params: { code: "AAPL" } });
    // (254.4 × 30 × 1391.5) − 원화 매입금액 7,302,600
    const krw = Math.round(254.4 * 30 * 1391.5 - 7_302_600);
    expect(textOf(line(us)!)).toBe(`보유 30주 · 평가손익 +${krw.toLocaleString("ko-KR")}원 (+${((krw / 7_302_600) * 100).toFixed(2)}%)`);
    h.settings = { ...h.settings, showKrw: false, afterCost: true };
    const s = samsung();
    const cost = { ...s, evaluation: { ...s.evaluation!, afterCost: { marketValue: 10_000_000, profit: 1_480_000, profitRate: 17.37 } } };
    expect(textOf(line(open(cost, { polish: true }))!)).toBe("보유 120주 · 평가손익 +1,480,000원 (+17.37%)");
  });

  it("손실은 하락색, 큰 글씨는 두 줄까지", () => {
    const loss = { ...holding("005930", quote("005930", 60_000, { change: -100, changeRate: -0.17 }), 10, 70_000, {}, "삼성전자"), registered: true };
    h.win = { ...h.win, fontScale: 1.3 };
    const l = line(open(loss, { polish: true }))!;
    expect(textOf(l)).toBe("보유 10주 · 평가손익 -100,000원 (-14.29%)");
    expect(l.props.numberOfLines).toBe(2);
    const parts = l.children.filter((c): c is HostNode => typeof c !== "string");
    expect(parts[1]!.props.style).toMatchObject({ color: light.down });
  });

  it("꺼짐·못 받음, 관심·미등록 종목, 넓은 창(내 보유 칸이 이미 보임)에는 없다", () => {
    for (const polish of [undefined, false]) expect(line(open(samsung(), { polish })), String(polish)).toBeUndefined();
    expect(line(open(unregistered(), { polish: true }))).toBeUndefined();
    const watch = { ...holding("005930", quote("005930", 84_300), null, null, {}, "삼성전자"), registered: true };
    expect(line(open(watch, { polish: true }))).toBeUndefined();
    for (const k of ["F8L", "F8P", "UP"] as const) {
      forgetWindowClass();
      size(k);
      const r = open(samsung(), { flag: true, polish: true });
      expect(line(r), k).toBeUndefined();
      expect(r.all().filter((n) => n.type === "Stat").map((n) => n.props.label), k).toContain("평가손익");
    }
  });
});

describe("이름·업종 (2026-09-26 버그 수정 — 플래그 없음)", () => {
  const FULL = "Defiance Daily Target 2X Long RGTI ETF";
  const rgtx = (extra: Record<string, unknown> = {}) => ({
    ...holding("RGTX", quote("RGTX", 10.61, { currency: "USD", change: 0.22, changeRate: 2.12, fxRate: 1360, prevClose: 10.39, industry: "-", ...extra }), 160, 13.68, {}, "RGTX"),
    market: "NASDAQ" as const,
    registered: true,
  });

  it("휴대폰: 업종이 '-' 면 'RGTX · NASDAQ' 까지만, 이름이 티커뿐이면 시세의 이름을 제목으로", () => {
    const r = open(rgtx({ fullName: FULL }), { params: { code: "RGTX" } });
    expect(stack(r).title).toBe(FULL);
    expect(r.text()).toContain("RGTX · NASDAQ");
    expect(r.text()).not.toContain("NASDAQ · -");
  });

  it("시세에 이름이 없으면(예전 서버) 지어내지 않고 티커 그대로, 업종이 있으면 그대로 적는다", () => {
    const r = open(rgtx({ industry: "반도체" }), { params: { code: "RGTX" } });
    expect(stack(r).title).toBe("RGTX");
    expect(r.text()).toContain("RGTX · NASDAQ · 반도체");
    // 사람이 읽는 이름이 이미 있으면 그대로
    expect(stack(open(samsung())).title).toBe("삼성전자");
  });

  it("넓은 창 합친 머리도 같은 이름·부제", () => {
    size("F8L");
    const r = open(rgtx({ fullName: FULL }), { flag: true, params: { code: "RGTX" } });
    expect(r.text()).toContain(FULL);
    expect(r.text()).not.toContain("NASDAQ · -");
  });
});
