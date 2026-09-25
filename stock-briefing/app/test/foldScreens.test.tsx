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
