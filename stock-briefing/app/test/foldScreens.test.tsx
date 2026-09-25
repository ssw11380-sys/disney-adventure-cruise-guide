import { createHash } from "node:crypto";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoverRank, DiscoverStock, RegisteredWithQuote, ThemeDetail, ThemeList } from "@/api/types";
import { render, type HostNode } from "./miniRender";
import { holding, quote } from "./helpers";

/**
 * 발견·설정·비중 화면의 넓은 창 배치 (3-42 웨이브 E, 기능 플래그 foldLayout).
 * 실제 화면 컴포넌트를 최소 렌더러로 그리고, RN 부품·다른 사람이 맡은 부품(StockLine·Screen·ui)은 문자열 요소로 바꿔
 * "이 화면 코드가 무엇을 넘기는지"만 본다.
 *  - 좁은 창(접은 화면)이거나 플래그가 꺼져 있으면(못 받았을 때 포함) 3-42 이전 화면과 똑같다:
 *    이전 코드(a91c8b0)로 그린 결과를 스냅숏(__snapshots__/foldScreens.test.tsx.snap)으로 기록해 두고 지금 코드와 비교한다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  insets: { top: 24, bottom: 48, left: 0, right: 0 },
  /** 서버가 준 foldLayout 값 (undefined = 아직 못 받음 → fallback) */
  flag: undefined as boolean | undefined,
  flags: { allocationView: true } as Record<string, boolean>,
  dark: false,
  showKrw: false,
  params: {} as Record<string, string>,
  stocks: [] as unknown[],
  push: vi.fn(),
}));

vi.mock("react-native", async () => {
  const R = await import("react");
  type P = Record<string, unknown>;
  const el = (c: unknown) => (c === null || c === undefined ? null : R.isValidElement(c) ? c : R.createElement(c as React.ComponentType));
  /** FlatList: 머리 · 줄(renderItem) · 꼬리를 모두 그리고, 줄 높이 계산(getItemLayout) 결과를 속성으로 남긴다 */
  const FlatList = (p: P) => {
    const { data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent, getItemLayout, keyExtractor, ...rest } = p as P & {
      data: unknown[];
      renderItem: (a: { item: unknown; index: number }) => React.ReactNode;
      getItemLayout?: (d: unknown, i: number) => unknown;
      keyExtractor?: (it: unknown, i: number) => string;
    };
    const key = (it: unknown, i: number) => (keyExtractor ? keyExtractor(it, i) : String(i));
    return R.createElement(
      "FlatList",
      { ...rest, itemLayout: getItemLayout ? [0, 1, 2].map((i) => getItemLayout(data, i)) : null, keys: data.map(key) },
      el(ListHeaderComponent),
      ...(data.length ? data.map((item, index) => R.createElement(R.Fragment, { key: key(item, index) }, renderItem({ item, index }))) : [el(ListEmptyComponent)]),
      el(ListFooterComponent),
    );
  };
  class Value {
    constructor(public v: number) {}
    setValue() {}
  }
  const anim = () => ({ start() {}, stop() {} });
  return {
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    RefreshControl: "RefreshControl",
    ActivityIndicator: "ActivityIndicator",
    FlatList,
    Animated: { View: "AnimatedView", Value, timing: anim, loop: anim, sequence: anim },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } },
    Alert: { alert: vi.fn() },
    Platform: { OS: "android" },
    useWindowDimensions: () => h.win,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Path: "Path" }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push }, Stack: { Screen: "StackScreen" }, useLocalSearchParams: () => h.params, usePathname: () => "/" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.4.0" } } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return {
    ...tokens,
    useTheme: () => (h.dark ? tokens.dark : tokens.light),
    useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap),
  };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [
    { value: "created", label: "등록순" },
    { value: "name", label: "이름순" },
  ],
  THEME_OPTIONS: [
    { value: "dark", label: "다크" },
    { value: "light", label: "라이트" },
    { value: "system", label: "시스템" },
  ],
  WIDGET_ROW_OPTIONS: [
    { value: "krw", label: "원화" },
    { value: "native", label: "현지 통화" },
  ],
  useSettings: () => ({
    apiUrl: "https://api.test",
    apiToken: "",
    setCredentials: vi.fn(),
    showKrw: h.showKrw,
    setShowKrw: vi.fn(),
    sort: "created",
    setSort: vi.fn(),
    themeMode: "system",
    setThemeMode: vi.fn(),
    afterCost: true,
    setAfterCost: vi.fn(),
    widgetRowCurrency: "krw",
    setWidgetRowCurrency: vi.fn(),
  }),
}));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/Screen", async () => ({ Screen: "Screen", DISCLAIMER: (await import("@/lib/disclaimer")).DISCLAIMER }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/StockLine", async () => {
  const s = await import("@/lib/textScale");
  return {
    StockLine: "StockLine",
    LineHead: "LineHead",
    LineMark: "LineMark",
    LineValue: "LineValue",
    PRICE_HEAD: "현재가·등락률",
    LINE_COL: s.LINE_COL,
    LINE_H: s.LINE_H,
    useLineH: () => s.lineH(h.win.fontScale),
    useLineCols: () => s.lineCols(h.win.fontScale),
  };
});
vi.mock("@/components/ui", () => ({
  Badge: "Badge",
  Button: "Button",
  Card: "Card",
  Chip: "Chip",
  Empty: "Empty",
  ErrorView: "ErrorView",
  Loading: "Loading",
  Muted: "Muted",
  RateBox: "RateBox",
  Row: "Row",
  SectionTitle: "SectionTitle",
  Segmented: "Segmented",
  TableHead: "TableHead",
  Toggle: "Toggle",
}));

const FX = 1391.5;
const stock = (code: string, name: string, price: number, rate: number, extra: Partial<DiscoverStock> = {}): DiscoverStock => ({
  code,
  name,
  market: "KOSPI",
  currency: "KRW",
  price,
  change: Math.round((price * rate) / (100 + rate)),
  changeRate: rate,
  volume: 1_234_567,
  tradingValue: price * 1_234_567,
  marketCap: price * 500_000_000,
  ...extra,
});
const KR = [
  stock("005930", "삼성전자", 84_300, 1.44),
  stock("000660", "SK하이닉스", 351_000, -1.27),
  stock("042660", "한화오션", 98_700, 4.11, { newlyListed: true }),
  stock("0126Z0", "아주 긴 이름의 신규 상장 종목 주식회사", 12_000, 29.9, { suspended: true, marketCap: null, volume: null, tradingValue: null }),
];
const US = [
  stock("NVDA", "엔비디아", 178.2, 1.74, { market: "NASDAQ", currency: "USD", volume: 182_400_000, tradingValue: 178.2 * 182_400_000, marketCap: 4.34e12 }),
  stock("IONQ", "아이온큐", 71.3, 8.94, { market: "NYSE", currency: "USD", volume: 40_200_000, tradingValue: 71.3 * 40_200_000, marketCap: null }),
];
const rankPage = (market: "KR" | "US", category: DiscoverRank["category"]): DiscoverRank => ({
  market,
  category,
  items: market === "US" ? US : KR,
  page: 1,
  hasMore: false,
  marketOpen: false,
  session: "closed",
  ver: 1,
  asOf: "2026-09-23T15:30:00+09:00",
  fxRate: market === "US" ? FX : null,
  source: "toss",
  note: null,
});
const THEMES: ThemeList["themes"] = Array.from({ length: 7 }, (_, i) => ({
  id: `t${i}`,
  name: ["조선", "원자력발전", "방위산업", "전력설비", "바이오시밀러", "인터넷 플랫폼", "2차전지"][i]!,
  changeRate: [3.42, 3.05, 2.71, 1.98, 0, -0.84, -1.87][i]!,
  up: 10 - i,
  flat: 2,
  down: 3 + i,
  leaders: [{ code: "042660", name: "한화오션", changeRate: 4.11 }],
}));
const themeList = (market: "KR" | "US"): ThemeList =>
  ({ market, kind: "theme", period: "day", themes: THEMES, marketOpen: false, session: "closed", asOf: "2026-09-23T15:30:00+09:00", source: "toss", basis: "구성 종목 평균", note: null, updatedAt: null }) as ThemeList;
const themeDetail: ThemeDetail = {
  market: "KR",
  kind: "theme",
  theme: THEMES[0]!,
  description: "선박을 만드는 회사들",
  items: KR,
  marketOpen: false,
  session: "closed",
  asOf: "2026-09-23T15:30:00+09:00",
  fxRate: null,
  source: "toss",
  basis: "구성 종목 평균",
  note: null,
  updatedAt: null,
};
const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, isFetching: false, isPlaceholderData: false, refetch: async () => undefined });

vi.mock("@/api/hooks", () => ({
  AUTO_REFRESH_MAX_PAGES: 3,
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : (h.flags[key] ?? fallback)),
  useStocks: () => ok(h.stocks),
  useStockMutations: () => ({ register: { mutate: vi.fn() } }),
  useDiscoverRank: (market: "KR" | "US", category: DiscoverRank["category"]) => ({
    ...ok({ pages: [rankPage(market, category)], pageParams: [{ page: 1 }] }),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: async () => undefined,
  }),
  useDiscoverThemes: (market: "KR" | "US") => ok(themeList(market)),
  useDiscoverTheme: () => ok(themeDetail),
  useHealth: () =>
    ok({
      ok: true,
      time: "2026-09-25T08:00:00+09:00",
      sources: { quotes: "toss", realtime: "toss", news: "naver", financials: "dart", investorFlow: "krx", llm: "claude" },
      schedule: null,
      appErrors: { days: 7, total: 0, fatal: 0 },
      disclaimer: "",
    }),
  useNotificationSettings: () => ok(undefined),
}));

const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { default: DiscoverScreen } = await import("@/app/(tabs)/discover");
const { default: ThemeDetailScreen } = await import("@/app/discover/theme/[id]");
const { default: SettingsScreen } = await import("@/app/(tabs)/settings");
const { default: AllocationScreen } = await import("@/app/portfolio/allocation");

type R = ReturnType<typeof render>;

/** 결과 트리를 비교할 수 있는 값으로: 함수는 "ƒ", 누르는 요소의 style 함수는 누르기 전·누른 뒤 모양으로 */
function ser(v: unknown, key = ""): unknown {
  if (typeof v === "function") return key === "style" ? ser([(v as (s: { pressed: boolean }) => unknown)({ pressed: false }), (v as (s: { pressed: boolean }) => unknown)({ pressed: true })]) : "ƒ";
  if (React.isValidElement(v)) {
    const e = v as React.ReactElement<Record<string, unknown>>;
    return { $el: typeof e.type === "string" ? e.type : ((e.type as { name?: string }).name ?? "?"), props: ser(e.props) };
  }
  if (Array.isArray(v)) return v.map((x) => ser(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "children").map(([k, x]) => [k, ser(x, k)]));
  return v;
}
const tree = (nodes: (HostNode | string)[]): unknown[] => nodes.map((n) => (typeof n === "string" ? n : { type: n.type, props: ser(n.props), children: tree(n.children) }));
/** 키 순서와 상관없이 같은 값이면 같은 글자 (스타일 객체를 합치는 순서만 바뀐 것은 같은 화면) */
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
};
/**
 * 한 화면 = 결과 트리 전체의 지문(sha256 앞 16자) + 요소 수 + 보이는 글자.
 * 트리 전체를 스냅숏에 넣으면 수십만 자라서 지문만 남긴다 — 요소·속성·스타일이 하나라도 다르면 지문이 바뀐다
 */
const shot = (r: R) => ({ tree: createHash("sha256").update(stable(tree(r.tree))).digest("hex").slice(0, 16), nodes: r.all().length, text: r.text() });

const size = (width: number, height: number, fontScale = 1) => {
  h.win = { width, height, scale: 2.625, fontScale };
};
/** 휴대폰 화면 그대로여야 하는 경우: 접은 화면(플래그 켜짐) · 펼친 화면(플래그 꺼짐·못 받음) */
const PHONE: [string, number, number, boolean | undefined][] = [
  ["폴드8 접힘 · 켜짐", 475, 751, true],
  ["울트라 접힘 · 켜짐", 411, 960, true],
  ["폴드8 펼침 가로 · 꺼짐", 933, 704, false],
  ["울트라 펼침 세로 · 못 받음", 859, 954, undefined],
  ["폴드8 펼침 세로 · 꺼짐", 704, 933, false],
];

const samsung = holding("005930", quote("005930", 84_300, { industry: "반도체" }), 10, 71_000, undefined, "삼성전자");
const apple = holding("AAPL", quote("AAPL", 254.4, { currency: "USD", fxRate: FX, industry: "하드웨어" }), 30, 180, { costBasisKrw: 7_300_000, krwCostSource: "exact" }, "애플");
const watch = holding("000660", quote("000660", 351_000), null, null, undefined, "SK하이닉스");
const HOLD: RegisteredWithQuote[] = [samsung, apple, watch];

beforeEach(() => {
  size(475, 751);
  h.insets = { top: 24, bottom: 48, left: 0, right: 0 };
  h.flag = undefined;
  h.flags = { allocationView: true };
  h.dark = false;
  h.showKrw = false;
  h.params = { id: "t0", market: "KR", kind: "theme", name: "조선", period: "day", rate: "3.42" };
  h.stocks = HOLD;
  forgetWindowClass();
});

const byLabel = (r: R, label: string) => r.byLabel(label);
const press = (r: R, label: string) => r.act(() => (byLabel(r, label).props.onPress as () => void)());
const segmented = (r: R) => r.all().find((n) => n.type === "Segmented")!;

/** 발견 탭을 여러 보기로 바꿔 가며 찍는다 (한국 거래대금 → 미국 → 거래량 → 테마 목록 → 히트맵) */
function discoverShots(): Record<string, unknown> {
  const r = render(<DiscoverScreen />);
  const out: Record<string, unknown> = { krTradingValue: shot(r) };
  r.act(() => (segmented(r).props.onChange as (v: string) => void)("US"));
  out.usTradingValue = shot(r);
  h.showKrw = true;
  r.rerender();
  out.usKrw = shot(r);
  h.showKrw = false;
  r.act(() => (segmented(r).props.onChange as (v: string) => void)("KR"));
  press(r, "거래량 보기");
  out.krVolume = shot(r);
  press(r, "테마 보기");
  out.themeList = shot(r);
  press(r, "히트맵으로 보기");
  out.themeHeat = shot(r);
  return out;
}

describe("좁은 창·플래그 꺼짐: 3-42 이전 화면과 똑같다 (기록한 스냅숏과 비교)", () => {
  const screens: [string, () => unknown][] = [
    ["발견", discoverShots],
    ["테마 상세", () => shot(render(<ThemeDetailScreen />))],
    ["설정", () => shot(render(<SettingsScreen />))],
    ["비중", () => shot(render(<AllocationScreen />))],
  ];
  it.each(screens)("%s (글자 100%)", (_n, take) => {
    const seen = PHONE.map(([, w, hh, flag]) => {
      h.flag = flag;
      forgetWindowClass();
      size(w, hh);
      return take();
    });
    for (const s of seen.slice(1)) expect(s).toEqual(seen[0]);
    expect(seen[0]).toMatchSnapshot();
  });

  it.each(screens)("%s (글자 130% · 다크)", (_n, take) => {
    h.dark = true;
    const seen = PHONE.map(([, w, hh, flag]) => {
      h.flag = flag;
      forgetWindowClass();
      size(w, hh, 1.3);
      return take();
    });
    for (const s of seen.slice(1)) expect(s).toEqual(seen[0]);
    expect(seen[0]).toMatchSnapshot();
  });
});

// ─────────────────────────── 넓은 창 (플래그 켜짐 + 폭 600 이상) ───────────────────────────

const { pickDiscoverCols, heatColumns, DISCOVER_PAD, DISCOVER_GAP } = await import("@/lib/discoverColumns");
const { allocationGrid, settingsTwoColumns, BESIDE, LEGEND_SWATCH, legendCols } = await import("@/lib/foldScreens");
const { foldScreens, space, touch, light, dark } = await import("@/tokens");
const { railWidth } = await import("@/lib/windowClass");

/** 누르는 요소의 style 은 함수일 수 있다 (누르기 전 모양) */
const styleOf = (n: HostNode, key = "style"): Record<string, unknown> => {
  const v = n.props[key];
  const s = typeof v === "function" ? (v as (x: { pressed: boolean }) => unknown)({ pressed: false }) : v;
  return Object.assign({}, ...[s].flat(Infinity).filter(Boolean));
};
const nodes = (r: R, type: string) => r.all().filter((n) => n.type === type);
const flatList = (r: R) => nodes(r, "FlatList")[0]!;
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const inside = (n: HostNode): HostNode[] => [n, ...n.children.flatMap((c) => (typeof c === "string" ? [] : inside(c)))];
/** 순위 표 한 줄 (이름표가 "n위, …" 인 누르는 요소, 테마 줄 제외) */
const tableRows = (r: R) => nodes(r, "Pressable").filter((n) => /^\d+위, /.test(String(n.props.accessibilityLabel ?? "")) && !/테마|업종/.test(String(n.props.accessibilityLabel)));
const layoutTo = (r: R, node: HostNode, width: number) => r.act(() => (node.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width, height: 600 } } }));
const wideOn = (w: number, hh: number, fontScale = 1) => {
  h.flag = true;
  forgetWindowClass();
  size(w, hh, fontScale);
};

describe("발견 순위 표의 열 고르기 (lib/discoverColumns)", () => {
  const keys = (w: number, s: number, m: "tradingValue" | "volume" = "tradingValue") => pickDiscoverCols(w, s, m).cols.map((c) => c.key);
  const ALL = ["price", "rate", "tradingValue", "volume", "marketCap", "mark"];

  it("폴드8 펼침 가로(탭 막대를 뺀 853)·울트라 펼침 세로 859·폴드8 펼침 세로 704: 글자 100% 에서 8칸 모두", () => {
    for (const w of [853, 859, 704, 954]) expect(keys(w, 1), `${w}`).toEqual(ALL);
    // 이름 칸: 704 → 182 (최소 146 이상). 853 은 331 이 남지만 최대 200 을 넘는 만큼 숫자 열에 고루 나눠(열마다 +21) 205
    expect(pickDiscoverCols(704, 1, "tradingValue").name).toBe(182);
    const f8l = pickDiscoverCols(853, 1, "tradingValue");
    expect(f8l.name).toBe(205);
    expect(f8l.cols.map((c) => c.width)).toEqual([86, 62, 76, 64, 76, 44].map((w) => w + 21));
  });

  it("이름 칸은 최대 폭(200, 글자 배율만큼 넓힘)을 크게 넘지 않는다 — 넓은 창에서 이름과 현재가 사이가 멀어지지 않게", () => {
    for (const w of [704, 853, 859, 954, 1200])
      for (const s of [1, 1.3]) {
        const t = pickDiscoverCols(w, s, "volume");
        expect(t.name, `${w}/${s}`).toBeLessThan(Math.round(foldScreens.discoverNameMax * s) + t.cols.length);
      }
  });

  it("합계가 폭과 같고, 이름 칸은 최소 폭(글자 배율만큼 넓힘) 이상 — 여러 폭 × 글자 100/130/140/200%", () => {
    for (const w of [600, 640, 704, 795, 853, 859, 874, 954])
      for (const s of [1, 1.3, 1.4, 2]) {
        const t = pickDiscoverCols(w, s, "tradingValue");
        const sum = 2 * DISCOVER_PAD + t.rank + DISCOVER_GAP + t.name + t.cols.reduce((a, c) => a + DISCOVER_GAP + c.width, 0);
        expect(sum, `${w}/${s}`).toBe(w);
        // 뺄 수 있는 열이 남아 있으면 이름 칸은 (배율만큼 넓힌) 최소 폭 이상. 가장 적은 열(3칸)까지 뺀 경우에도 100% 최소 폭(146)은 지킨다
        if (t.cols.length > 3) expect(t.name, `${w}/${s}`).toBeGreaterThanOrEqual(Math.round(foldScreens.discoverNameMin * Math.min(s, 1.4)));
        else expect(t.name, `${w}/${s}`).toBeGreaterThanOrEqual(foldScreens.discoverNameMin);
        // 열 순서는 늘 표 순서
        expect(t.cols.map((c) => c.key), `${w}/${s}`).toEqual(ALL.filter((k) => t.cols.some((c) => c.key === k)));
      }
  });

  it("큰 글씨에서는 덜 중요한 열부터 뺀다: 보유 → 시가총액 → 분류 값이 아닌 쪽. 보유 표시는 이름 옆으로", () => {
    expect(keys(704, 1.3)).toEqual(["price", "rate", "tradingValue", "volume"]);
    expect(pickDiscoverCols(704, 1.3, "tradingValue").inlineMark).toBe(true);
    expect(pickDiscoverCols(853, 1, "tradingValue").inlineMark).toBe(false);
    // 좁은 폭 + 큰 글씨: 거래대금 분류는 거래량을, 거래량 분류는 거래대금을 뺀다
    expect(keys(600, 1.4, "tradingValue")).toEqual(["price", "rate", "tradingValue"]);
    expect(keys(600, 1.4, "volume")).toEqual(["price", "rate", "volume"]);
    // 폴드8 펼침 가로 130% 는 8칸 그대로, 140% 는 보유를 뺀다
    expect(keys(853, 1.3)).toEqual(ALL);
    expect(keys(853, 1.4)).toEqual(ALL.slice(0, 5));
  });

  it("폭을 모르면 가장 적은 열", () => {
    expect(keys(0, 1)).toEqual(["price", "rate", "tradingValue"]);
    expect(keys(Number.NaN, 1, "volume")).toEqual(["price", "rate", "volume"]);
  });

  it("히트맵 칸 수 = 폭 ÷ 150 (적어도 3): 853·859 → 5칸, 704 → 4칸. 큰 글씨는 타일을 넓혀 칸이 준다", () => {
    expect(heatColumns(853 - 16, 1)).toBe(5);
    expect(heatColumns(859 - 16, 1)).toBe(5);
    expect(heatColumns(704 - 16, 1)).toBe(4);
    expect(heatColumns(954 - 16, 1)).toBe(6);
    expect(heatColumns(853 - 16, 1.4)).toBe(4);
    expect(heatColumns(400, 1)).toBe(3);
    expect(heatColumns(0, 1)).toBe(3);
  });
});

describe("설정·비중 배치 계산 (lib/foldScreens)", () => {
  it("설정 두 칸: 한 칸 300(큰 글씨는 배율의 절반만큼 넓힘) 이상일 때만", () => {
    expect(settingsTwoColumns(853, 1)).toBe(true);
    expect(settingsTwoColumns(859, 1)).toBe(true);
    expect(settingsTwoColumns(704, 1)).toBe(true);
    expect(settingsTwoColumns(704, 1.3)).toBe(true);
    expect(settingsTwoColumns(704, 1.4)).toBe(false);
    expect(settingsTwoColumns(933 - railWidth(1.4), 1.4)).toBe(true);
    expect(settingsTwoColumns(600, 1)).toBe(false);
    expect(settingsTwoColumns(0, 1)).toBe(false);
  });

  it("비중 2×2: 원 지름 120~180, 원 옆 범례 이름 칸이 최소 폭 이상일 때만 원 옆 (폴드8 펼침 세로 704 는 원 아래)", () => {
    expect(allocationGrid(933, 1)).toEqual({ colW: 462, donut: 126, beside: true });
    expect(allocationGrid(859, 1)).toEqual({ colW: 425, donut: 120, beside: true });
    expect(allocationGrid(704, 1)).toEqual({ colW: 348, donut: 120, beside: false });
    for (const [w, s] of [
      [933, 1],
      [859, 1],
      [954, 1],
      [933, 1.3],
      [859, 1.3],
      [1200, 1],
    ] as const) {
      const g = allocationGrid(w, s);
      expect(g.donut).toBeGreaterThanOrEqual(foldScreens.donutMin);
      expect(g.donut).toBeLessThanOrEqual(foldScreens.donutMax);
      const { amount, pct } = legendCols(s);
      const name = g.colW - BESIDE.padL - g.donut - BESIDE.gap - BESIDE.rowL - BESIDE.rowR - (LEGEND_SWATCH + 3 * space.sm) - amount - pct;
      if (g.beside) expect(name, `${w}/${s}`).toBeGreaterThanOrEqual(foldScreens.legendNameMin);
    }
    expect(allocationGrid(1200, 1).donut).toBe(foldScreens.donutMax);
  });
});

describe("발견 탭 (넓은 창)", () => {
  it("폴드8 펼침 가로: 시장·분류가 한 줄(44)로 합쳐지고, 순위는 한 줄 44 표 8칸", () => {
    wideOn(933, 704);
    const r = render(<DiscoverScreen />);
    expect(nodes(r, "Segmented")).toHaveLength(0);
    // 시장 탭: 역할 tab, 누르는 높이 44
    const kr = r.byLabel("한국주식");
    expect(kr.props.accessibilityRole).toBe("tab");
    expect(kr.props.accessibilityState).toEqual({ selected: true });
    expect(styleOf(kr).minHeight).toBe(touch.min);
    // 분류 칩 5개가 같은 줄에
    expect(nodes(r, "Chip").map((c) => c.props.label)).toEqual(["거래대금", "거래량", "급상승", "급하락", "테마"]);
    const bar = r.all().find((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.props.accessibilityRole === "tablist"))!;
    expect(styleOf(bar)).toMatchObject({ flexDirection: "row", minHeight: touch.min });
    // 표: 재기 전에는 창 폭 − 왼쪽 탭 막대(80)로 어림 → 이름 칸 205, 잰 뒤(853)도 같다
    const nameW = () => styleOf(inside(tableRows(r)[0]!).find((n) => n.type === "View" && styleOf(n).flex === 1)!);
    expect(nameW()).toMatchObject({ flex: 1 });
    expect(nodes(r, "TableHead")[0]!.children.filter((c): c is HostNode => typeof c !== "string").map((c) => styleOf(c).width)).toEqual([30, undefined, 107, 83, 97, 85, 97, 65]);
    layoutTo(r, r.tree[0] as HostNode, 853);
    expect(textOf(nodes(r, "TableHead")[0]!)).toBe("순위종목현재가등락률거래대금거래량시가총액보유");
    const rows = tableRows(r);
    expect(rows).toHaveLength(4);
    expect(styleOf(rows[0]!).height).toBe(foldScreens.tableRowH);
    expect(flatList(r).props.itemLayout).toEqual([0, 1, 2].map((i) => ({ length: 44, offset: 44 * i, index: i })));
    // 한 줄 한 문장 (보이는 열 모두)
    expect(rows[0]!.props.accessibilityLabel).toBe("1위, 삼성전자, 보유, 현재가 84,300원, 1.44% 상승, 거래대금 1,041억원, 거래량 123만주, 시가총액 42조원");
  });

  it("숫자 칸은 말줄임 없이 글자를 줄여 한 줄 (numberOfLines 1 + adjustsFontSizeToFit), 이름만 말줄임", () => {
    wideOn(933, 704);
    const r = render(<DiscoverScreen />);
    const row = tableRows(r)[0]!;
    const texts = inside(row).filter((n) => n.type === "Text");
    const nums = texts.filter((n) => /\d/.test(textOf(n)) && textOf(n) !== "1");
    expect(nums.length).toBeGreaterThanOrEqual(4);
    for (const n of nums) expect(n.props, textOf(n)).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
    const name = texts.find((n) => textOf(n) === "삼성전자")!;
    expect(name.props.numberOfLines).toBe(1);
    expect(name.props.adjustsFontSizeToFit).toBeUndefined();
    // 현재가는 반짝임 가격(FlashPrice)으로, 칸이 좁으면 글자를 줄인다
    expect(inside(row).find((n) => n.type === "FlashPrice")!.props).toMatchObject({ text: "84,300", fit: true });
  });

  it("미국 종목: 금액은 달러 그대로, '해외주식 원화 표시'를 켜면 원화", () => {
    wideOn(859, 954);
    const r = render(<DiscoverScreen />);
    r.act(() => (r.byLabel("미국주식").props.onPress as () => void)());
    expect(tableRows(r)[0]!.props.accessibilityLabel).toBe("1위, 엔비디아, 현재가 178.20달러, 1.74% 상승, 거래대금 325억 달러, 거래량 1.8억주, 시가총액 4.34조 달러");
    h.showKrw = true;
    r.rerender();
    expect(tableRows(r)[0]!.props.accessibilityLabel).toMatch(/^1위, 엔비디아, 현재가 [\d,]+원, 1\.74% 상승, 거래대금 [\d.,]+조원, 거래량 1\.8억주, 시가총액 [\d,]+조원$/);
  });

  it("큰 글씨(130%) · 폴드8 펼침 세로 704: 보유·시가총액 열을 빼고 보유 표시는 이름 옆으로", () => {
    wideOn(704, 933, 1.3);
    const r = render(<DiscoverScreen />);
    layoutTo(r, r.tree[0] as HostNode, 704);
    expect(textOf(nodes(r, "TableHead")[0]!)).toBe("순위종목현재가등락률거래대금거래량");
    const row = tableRows(r)[0]!;
    expect(row.props.accessibilityLabel).toBe("1위, 삼성전자, 보유, 현재가 84,300원, 1.44% 상승, 거래대금 1,041억원, 거래량 123만주");
    expect(inside(row).filter((x) => x.type === "LineMark").map((m) => m.props.label)).toEqual(["보유"]);
  });

  it("순위 기준 열 머리를 진하게: 거래대금 순위는 거래대금, 거래량 순위는 거래량, 급상승은 등락률", () => {
    wideOn(933, 704);
    const r = render(<DiscoverScreen />);
    const strong = () => nodes(r, "TableHead")[0]!.children.filter((c): c is HostNode => typeof c !== "string" && styleOf(c).fontWeight === "700").map(textOf);
    expect(strong()).toEqual(["거래대금"]);
    r.act(() => (r.byLabel("거래량 보기").props.onPress as () => void)());
    expect(strong()).toEqual(["거래량"]);
    r.act(() => (r.byLabel("급상승 보기").props.onPress as () => void)());
    expect(strong()).toEqual(["등락률"]);
  });

  it("테마 목록은 두 칸, 히트맵은 폭 ÷ 150 칸 — 칸 수가 바뀌면 목록을 새로 만든다 · 보기 버튼 폭 44 (진단 34)", () => {
    wideOn(933, 704);
    const r = render(<DiscoverScreen />);
    layoutTo(r, r.tree[0] as HostNode, 853);
    r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
    expect(flatList(r).props).toMatchObject({ numColumns: 2 });
    const rows = nodes(r, "Pressable").filter((n) => /^\d+위, .*테마/.test(String(n.props.accessibilityLabel)));
    expect(rows).toHaveLength(7);
    expect(styleOf(rows[0]!)).toMatchObject({ width: "50%", borderRightWidth: 1 });
    expect(styleOf(rows[1]!)).toMatchObject({ width: "50%", borderRightWidth: 0 });
    for (const l of ["테마별", "업종별", "기간 오늘", "기간 1주", "기간 1개월", "목록으로 보기", "히트맵으로 보기"]) expect(styleOf(r.byLabel(l)).minWidth, l).toBe(touch.min);
    // 가장 강한·약한은 분포 줄 한 줄에: 이름만 말줄임, 등락률은 따로 (줄이지 않음)
    const best = r.byLabel("가장 강한 테마 조선, 3.42% 상승");
    expect(best.props.hitSlop).toBeDefined();
    const rate = inside(best).find((n) => n.type === "Text" && textOf(n) === "+3.42%")!;
    expect(rate.props.numberOfLines).toBeUndefined();
    expect(inside(best).find((n) => n.type === "Text" && textOf(n) === "조선")!.props.numberOfLines).toBe(1);
    expect(r.has("가장 약한 테마 2차전지, 1.87% 하락")).toBe(true);
    r.act(() => (r.byLabel("히트맵으로 보기").props.onPress as () => void)());
    expect(flatList(r).props).toMatchObject({ numColumns: 5 });
    const tile = () => r.byLabel("조선, 3.42% 상승, 오른 종목 10개, 내린 종목 3개");
    expect(styleOf(tile()).width).toBe("20%");
    // 폭이 704 로 줄면 4칸
    layoutTo(r, r.tree[0] as HostNode, 704);
    expect(flatList(r).props).toMatchObject({ numColumns: 4 });
    expect(styleOf(tile()).width).toBe("25%");
  });

  it("접고 펴도 테마 보드의 선택(업종·히트맵)이 남는다 (목록 자리가 두 배치에서 같다)", () => {
    wideOn(475, 751);
    const r = render(<DiscoverScreen />);
    r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
    r.act(() => (r.byLabel("업종별").props.onPress as () => void)());
    r.act(() => (r.byLabel("히트맵으로 보기").props.onPress as () => void)());
    expect(flatList(r).props.numColumns).toBe(3);
    size(933, 704);
    r.rerender();
    expect(r.byLabel("업종별").props.accessibilityState).toEqual({ selected: true });
    // 재기 전 어림: 933 − 탭 막대 80 = 853 → 5칸
    expect(flatList(r).props.numColumns).toBe(5);
    // 잰 폭은 그 창 크기에서만 쓴다: 704×933 으로 돌리면 다시 재기 전까지 704(막대 없음)로 어림 → 4칸
    layoutTo(r, r.tree[0] as HostNode, 853);
    size(704, 933);
    r.rerender();
    expect(flatList(r).props.numColumns).toBe(4);
    size(475, 751);
    r.rerender();
    expect(r.byLabel("업종별").props.accessibilityState).toEqual({ selected: true });
    expect(flatList(r).props.numColumns).toBe(3);
    expect(nodes(r, "Segmented")).toHaveLength(1);
  });

  it("서버가 플래그를 끄면 바로 휴대폰 목록으로", () => {
    wideOn(933, 704);
    const r = render(<DiscoverScreen />);
    expect(tableRows(r).length).toBeGreaterThan(0);
    h.flag = false;
    r.rerender();
    expect(tableRows(r)).toHaveLength(0);
    expect(nodes(r, "StockLine")).toHaveLength(4);
  });
});

describe("테마 상세 (넓은 창)", () => {
  it("구성 종목을 발견과 같은 한 줄 표로 (등락률순이라 등락률 머리를 진하게)", () => {
    wideOn(954, 859);
    const r = render(<ThemeDetailScreen />);
    expect(typeof (r.tree[0] as HostNode).props.onLayout).toBe("function");
    expect(tableRows(r)).toHaveLength(4);
    const head = nodes(r, "TableHead")[0]!;
    expect(head.children.filter((c): c is HostNode => typeof c !== "string" && styleOf(c).fontWeight === "700").map(textOf)).toEqual(["등락률"]);
    expect(nodes(r, "LineHead")).toHaveLength(0);
  });
});

describe("설정 (넓은 창)", () => {
  const columns = (r: R) => r.all().find((n) => n.type === "View" && styleOf(n).flexDirection === "row" && n.children.length === 2 && n.children.every((c) => typeof c !== "string" && styleOf(c).flex === 1));
  /** 칸 안 카드 순서: 제목(SectionTitle) 글자, 또는 따로 만든 카드 이름 */
  const cardsIn = (col: HostNode): string[] =>
    col.children.flatMap((c) => {
      if (typeof c === "string") return [];
      if (c.type !== "Card") return [c.type];
      const title = inside(c).find((x) => x.type === "SectionTitle");
      return title ? [textOf(title)] : [];
    });

  it.each([
    ["폴드8 펼침 가로 (왼쪽 탭 막대)", 933, 704, 1],
    ["울트라 펼침 세로", 859, 954, 1],
    ["폴드8 펼침 세로", 704, 933, 1],
    ["폴드8 펼침 가로 · 글자 140%", 933, 704, 1.4],
  ] as const)("%s: 카드 두 칸 — 왼쪽 표시·알림·정보 | 오른쪽 토스·업데이트·서버·서버 연결·화면 정보", (_n, w, hh, s) => {
    wideOn(w, hh, s);
    const r = render(<SettingsScreen />);
    const cols = columns(r)!;
    expect(cols).toBeDefined();
    expect(styleOf(cols)).toMatchObject({ gap: space.sm, alignItems: "flex-start" });
    const [left, right] = cols.children as HostNode[];
    expect(cardsIn(left!)).toEqual(["표시", "NotificationSettingsCard", "정보"]);
    expect(cardsIn(right!)).toEqual(["TossOpenApiCard", "AppUpdateCard", "서버", "서버 연결", "ScreenInfoCard"]);
    // 고지 문구는 그대로
    expect(r.text()).toContain("투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.");
  });

  it("'화면' 칩은 '잔고 정렬'처럼 이름 아래 왼쪽 (진단 38) · 두 칸이 안 들어가는 큰 글씨(704·140%)는 한 칸", () => {
    wideOn(704, 933, 1.4);
    const r = render(<SettingsScreen />);
    expect(columns(r)).toBeUndefined();
    const label = r.all().find((n) => n.type === "Text" && textOf(n) === "화면")!;
    const box = r.all().find((n) => n.type === "View" && n.children.includes(label))!;
    // 이름과 칩이 세로로 (한 줄 양 끝이 아님)
    expect(styleOf(box).flexDirection).toBeUndefined();
    expect(styleOf(box)).toMatchObject({ gap: space.s });
  });
});

describe("비중 (넓은 창)", () => {
  const gridRows = (r: R) => r.all().filter((n) => n.type === "View" && styleOf(n).flexDirection === "row" && styleOf(n).gap === space.sm && n.children.length > 0 && n.children.every((c) => typeof c !== "string" && styleOf(c).flex === 1));
  const many = () => {
    h.stocks = [
      samsung,
      apple,
      ...["반도체", "은행", "조선", "방산", "자동차", "바이오", "2차전지", "화학"].map((ind, i) =>
        holding(`K${i}`, quote(`K${i}`, 10_000 * (i + 2), { industry: ind }), 10 + i, 9_000, undefined, i === 3 ? "한화에어로스페이스" : `종목${i}`),
      ),
    ];
  };

  it("폴드8 펼침 가로: 요약 한 줄 + 카드 2×2, 원(126) 옆에 범례, 제목은 범례 머리(화면 읽기 머리글)", () => {
    wideOn(933, 704);
    many();
    const r = render(<AllocationScreen />);
    const rows = gridRows(r);
    expect(rows.map((row) => row.children.length)).toEqual([2, 2]);
    expect(nodes(r, "Svg").map((s) => s.props.width)).toEqual([126, 126, 126, 126]);
    expect(r.all().filter((n) => n.props.accessibilityRole === "header").map(textOf)).toEqual(["국내 / 해외", "통화", "업종", "종목별"]);
    // 원 옆 배치 4장
    expect(r.all().filter((n) => n.type === "View" && styleOf(n).flexDirection === "row" && styleOf(n).paddingLeft === BESIDE.padL)).toHaveLength(4);
    // 범례 한 줄 한 문장은 그대로
    expect(r.all().some((n) => /^한화에어로스페이스, [\d,]+원, 비중 [\d.]+%$/.test(String(n.props.accessibilityLabel)))).toBe(true);
    // 금액·비중은 말줄임 없이 글자를 줄인다
    const nums = r.all().filter((n) => n.type === "Text" && /^[\d,.]+(원|%)$/.test(textOf(n)));
    expect(nums.length).toBeGreaterThan(10);
    for (const a of nums) expect(a.props, textOf(a)).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
    // 판단 문구 없음 · 고지는 화면 아래 (Screen disclaimer)
    expect(r.text()).not.toMatch(/리밸런싱|늘리|줄이|추천|권장/);
    expect(nodes(r, "Screen")[0]!.props.disclaimer).toBe(true);
  });

  it("폴드8 펼침 세로 704: 칸이 좁아 원(120) 아래에 범례", () => {
    wideOn(704, 933);
    many();
    const r = render(<AllocationScreen />);
    expect(gridRows(r)).toHaveLength(2);
    expect(nodes(r, "Svg").map((s) => s.props.width)).toEqual([120, 120, 120, 120]);
    expect(r.all().filter((n) => n.type === "View" && styleOf(n).paddingLeft === BESIDE.padL && styleOf(n).flexDirection === "row")).toHaveLength(0);
  });

  it.each([
    ["라이트", false, light],
    ["다크", true, dark],
  ] as const)("%s 테마: 카드 바탕·선은 테마 토큰", (_n, isDark, theme) => {
    h.dark = isDark;
    wideOn(859, 954);
    const r = render(<AllocationScreen />);
    const cards = r.all().filter((n) => n.type === "View" && styleOf(n).flex === 1 && styleOf(n).paddingVertical === space.xs && styleOf(n).borderTopWidth === 1);
    expect(cards).toHaveLength(4);
    for (const c of cards) expect(styleOf(c)).toMatchObject({ backgroundColor: theme.surface, borderColor: theme.line });
  });
});
