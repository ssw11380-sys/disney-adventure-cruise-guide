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
  /** 잔고를 아직 받는 중 */
  stocksLoading: false,
  /** 테마 목록을 바꿔 볼 때 (null = 기본 THEMES) */
  themes: null as unknown[] | null,
  push: vi.fn(),
  /** 새로 만들어진 횟수 (카드가 같은 자리에 남아 상태를 지키는지) */
  mounts: { notify: 0, toss: 0 },
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
// 알림·토스 카드: 결과 트리는 예전처럼 이름만 남기고, 새로 만들어질 때(상태가 처음부터)만 센다
vi.mock("@/components/NotificationSettingsCard", async () => {
  const R = await import("react");
  return {
    NotificationSettingsCard: function NotificationSettingsCard() {
      R.useState(() => (h.mounts.notify += 1));
      return R.createElement("NotificationSettingsCard");
    },
  };
});
vi.mock("@/components/TossOpenApiCard", async () => {
  const R = await import("react");
  return {
    TossOpenApiCard: function TossOpenApiCard() {
      R.useState(() => (h.mounts.toss += 1));
      return R.createElement("TossOpenApiCard");
    },
  };
});
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
const lead = (code: string, name: string, changeRate: number | null) => ({ code, name, changeRate });
const themeList = (market: "KR" | "US"): ThemeList =>
  ({ market, kind: "theme", period: "day", themes: h.themes ?? THEMES, marketOpen: false, session: "closed", asOf: "2026-09-23T15:30:00+09:00", source: "toss", basis: "구성 종목 평균", note: null, updatedAt: null }) as ThemeList;
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
  useStocks: () => (h.stocksLoading ? { ...ok(undefined), isLoading: true } : ok(h.stocks)),
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
  h.stocksLoading = false;
  h.themes = null;
  h.mounts = { notify: 0, toss: 0 };
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

const { pickDiscoverCols, heatColumns, themeListColumns, themeLeaderLineW, fitThemeLeaders, textEm, DISCOVER_PAD, DISCOVER_GAP } = await import("@/lib/discoverColumns");
const { allocationGrid, allocationStep, besideNameW, settingsTwoColumns, settingsColumnMax, stickyStep, BESIDE, DENSE_CUT, FOLD_COL_GAP, WIDE_CARD } = await import("@/lib/foldScreens");
const { formatPct } = await import("@/lib/format");
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
    // 이름 칸은 최대 160 을 넘는 만큼 숫자 열에 고루 나눈다: 704 는 182 → 164 (열마다 +3), 853 은 331 → 163 (열마다 +28)
    expect(pickDiscoverCols(704, 1, "tradingValue").name).toBe(164);
    const f8l = pickDiscoverCols(853, 1, "tradingValue");
    expect(f8l.name).toBe(163);
    expect(f8l.cols.map((c) => c.width)).toEqual([86, 62, 76, 64, 76, 44].map((w) => w + 28));
  });

  it("이름 칸은 최대 폭(160, 글자 배율만큼 넓힘)을 크게 넘지 않는다 — 넓은 창에서 이름과 현재가 사이가 멀어지지 않게", () => {
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
  it("설정 두 칸: 한 칸 340 × 글자 배율(최대 140%) 이상일 때만 — 글자 100% 는 폭 688 부터, 130% 는 울트라 펼침 가로 954 만", () => {
    expect(settingsTwoColumns(853, 1)).toBe(true);
    expect(settingsTwoColumns(859, 1)).toBe(true);
    expect(settingsTwoColumns(704, 1)).toBe(true);
    expect(settingsTwoColumns(688, 1)).toBe(true);
    expect(settingsTwoColumns(687, 1)).toBe(false);
    // 폭 600~640 창(칸 약 298): 토스 카드 줄 이름이 '자동 동기/화' 처럼 끊기던 곳 → 한 칸
    expect(settingsTwoColumns(604, 1)).toBe(false);
    expect(settingsTwoColumns(640, 1)).toBe(false);
    // 글자 130%: 칸이 442 이상이어야 두 칸 (폴드8 펼침 가로 853·세로 704·울트라 펼침 세로 859 는 한 칸 — 칸 422 에서도 이름이 끊겼다)
    expect(settingsTwoColumns(954, 1.3)).toBe(true);
    expect(settingsTwoColumns(933 - railWidth(1.3), 1.3)).toBe(false);
    expect(settingsTwoColumns(859, 1.3)).toBe(false);
    expect(settingsTwoColumns(704, 1.3)).toBe(false);
    expect(settingsTwoColumns(954, 1.4)).toBe(false);
    expect(settingsTwoColumns(954, 2)).toBe(false);
    expect(settingsTwoColumns(0, 1)).toBe(false);
    // 두 칸이면 한 칸은 늘 최소 폭(글자 배율만큼, 설계 범위 310~430 의 안쪽) 이상
    expect(foldScreens.settingsColMin).toBeGreaterThanOrEqual(310);
    for (const [w, s] of [
      [688, 1],
      [704, 1],
      [853, 1],
      [954, 1.3],
      [1300, 1.4],
    ] as const) {
      expect(settingsTwoColumns(w, s), `${w}/${s}`).toBe(true);
      expect((w - FOLD_COL_GAP) / 2, `${w}/${s}`).toBeGreaterThanOrEqual(foldScreens.settingsColMin * Math.min(s, 1.4));
    }
  });

  it("설정 칸 최대 폭 400 × 글자 배율(최대 140%) — 이름과 스위치 사이 300dp 이하 (설계 칸 폭 범위 310~430 안)", () => {
    expect(settingsColumnMax(1)).toBe(400);
    expect(settingsColumnMax(1.3)).toBe(520);
    expect(settingsColumnMax(1.4)).toBe(560);
    expect(settingsColumnMax(2)).toBe(560);
    expect(settingsColumnMax(1)).toBeGreaterThanOrEqual(foldScreens.settingsColMin);
  });

  /** 격자가 쓸 높이 = 창 − 상태 표시줄 24 − 작업 표시줄 48 − 머리·요약·고지 어림(176, 글자 배율만큼). 범례 줄 수: 윗줄 2 · 아랫줄 11 (보유 17종목) */
  const room = (hh: number, s = 1, rows = [2, 11]) => ({ height: hh - 24 - 48 - Math.round(foldScreens.allocChromeH * Math.max(s, 1)), rows });
  /** 원 옆 배치의 격자 높이 어림 (화면 코드와 같은 식을 테스트에서 따로 세운다) */
  const need = (g: { donut: number; legend: string; dense: boolean }, s: number, rows: number[]) => {
    const k = Math.min(Math.max(s, 1), 1.4);
    const rowH = foldScreens.legendRowH + (g.legend === "stack" ? foldScreens.legendSubH : 0);
    return rows.reduce((a, n) => a + 2 * WIDE_CARD.padV + Math.max(g.donut, Math.ceil((foldScreens.legendHeadH + n * rowH) * k) - (g.dense ? n * DENSE_CUT : 0)), 0);
  };

  it("비중 (글자 100%): 네 가지 펼친 크기 모두 원 옆 범례 (설계 '카드 2×2, 원 옆에 범례') — 칸이 좁으면 평가금액을 이름 아래로 내린 두 줄 범례", () => {
    // 폭만 볼 때 (높이를 모르면 원은 이름 칸이 바라는 폭 110 을 남기고 남은 폭으로)
    expect(allocationGrid(933, 1)).toEqual({ colW: 462, donut: 126, beside: true, legend: "row", dense: false });
    expect(allocationGrid(954, 1)).toEqual({ colW: 473, donut: 137, beside: true, legend: "row", dense: false });
    expect(allocationGrid(859, 1)).toEqual({ colW: 425, donut: 180, beside: true, legend: "stack", dense: false });
    expect(allocationGrid(704, 1)).toEqual({ colW: 348, donut: 120, beside: true, legend: "stack", dense: false });
    // 이름 칸: 한 줄 범례는 바라는 폭(110), 두 줄 범례는 평가금액 열(96)만큼 넓어진다 — 울트라 펼침 세로 원 180 옆 123 · 폴드8 펼침 세로 원 120 옆 106
    expect(besideNameW(462, 126, 1, "row")).toBe(foldScreens.legendNameIdeal);
    expect(besideNameW(473, 137, 1, "row")).toBe(foldScreens.legendNameIdeal);
    expect(besideNameW(425, 180, 1, "stack")).toBe(123);
    expect(besideNameW(348, 120, 1, "stack")).toBe(106);
    // 예전(평가금액 열을 둔 한 줄 범례)이면 울트라 펼침 세로 79 · 폴드8 펼침 세로 2 뿐이라 원 아래로 내렸다
    expect(besideNameW(425, 120, 1, "row")).toBe(79);
    expect(besideNameW(348, 120, 1, "row")).toBe(2);
  });

  it("비중 원 옆 범례: 카드 4장이 한 화면에 들어가는 만큼만 원을 키우고, 보통 줄 여백으로 안 들어가면 촘촘한 범례 (높이도 본다)", () => {
    for (const [name, w, hh, want] of [
      // 폴드8 펼침 가로 933×704: 보통 여백으로 들어가는 만큼 원 122 (폭만 보면 126)
      ["폴드8 펼침 가로", 933, 704, { donut: 122, legend: "row", dense: false }],
      // 울트라 펼침 가로 954×859 · 울트라 펼침 세로 859×954 · 폴드8 펼침 세로 704×933
      ["울트라 펼침 가로", 954, 859, { donut: 137, legend: "row", dense: false }],
      ["울트라 펼침 세로", 859, 954, { donut: 180, legend: "stack", dense: false }],
      ["폴드8 펼침 세로", 704, 933, { donut: 120, legend: "stack", dense: false }],
    ] as const) {
      const g = allocationGrid(w, 1, room(hh));
      expect(g, name).toMatchObject({ beside: true, ...want });
      expect(need(g, 1, [2, 11]), name).toBeLessThanOrEqual(room(hh).height);
    }
    // 창이 더 낮으면 (웹 미리보기의 실제 앱 창: 시스템 막대가 이미 빠진 높이) 줄 여백을 줄여 4장을 한 화면에
    const f8l = { height: 632 - 8 - foldScreens.allocChromeH, rows: [2, 11] };
    const g = allocationGrid(933, 1, f8l);
    expect(g).toMatchObject({ beside: true, legend: "row", dense: true, donut: 126 });
    expect(need({ ...g, dense: false }, 1, [2, 11])).toBeGreaterThan(f8l.height);
    expect(need(g, 1, [2, 11])).toBeLessThanOrEqual(f8l.height);
    expect(DENSE_CUT).toBe(4);
    // 폴드8 펼침 세로가 더 낮은 창(704×861 에 시스템 막대까지): 두 줄 범례도 촘촘하게 하면 들어간다
    const f8p = room(861);
    const gp = allocationGrid(704, 1, f8p);
    expect(gp).toMatchObject({ beside: true, legend: "stack", dense: true, donut: 120 });
    expect(need(gp, 1, [2, 11])).toBeLessThanOrEqual(f8p.height);
    // 종목이 적으면 원이 커진다 (가장 크게 180)
    expect(allocationGrid(859, 1, room(954, 1, [2, 4])).donut).toBe(foldScreens.donutMax);
  });

  it("비중 큰 글씨: 두 줄 범례로 한 화면에 안 들어가면 줄이 낮은 한 줄 범례(이름만 말줄임), 이름 칸 최소 폭도 안 남으면 원 아래 범례", () => {
    // 글자 130% · 폴드8 펼침 가로: 한 줄 범례(이름 칸 105 ≥ 최소 94) — 예전에는 원 아래 범례라 첫 화면에 카드 2장
    expect(allocationGrid(933, 1.3, room(704, 1.3))).toMatchObject({ beside: true, legend: "row", donut: foldScreens.donutMin });
    expect(besideNameW(462, 120, 1.3, "row")).toBe(105);
    expect(Math.round(foldScreens.legendNameMin * 1.3)).toBe(94);
    // 글자 130% · 울트라 펼침 세로 · 폴드8 펼침 세로: 두 줄 범례 (한 줄로는 이름 칸이 최소 폭도 안 남는다)
    expect(allocationGrid(859, 1.3, room(954, 1.3))).toMatchObject({ beside: true, legend: "stack" });
    expect(allocationGrid(704, 1.3, room(933, 1.3))).toMatchObject({ beside: true, legend: "stack" });
    // 폭 640 창 · 글자 140%: 두 줄 범례로도 이름 칸이 최소 폭(101)이 안 남아 원 아래 범례
    expect(allocationGrid(640, 1.4, room(933, 1.4))).toMatchObject({ beside: false, legend: "row" });
    // 어느 폭·글자 배율이든: 원은 120~180, 원 옆이면 이름 칸은 최소 폭(글자 배율만큼) 이상
    for (const w of [600, 640, 704, 760, 859, 900, 933, 954, 1200])
      for (const s of [1, 1.3, 1.4, 2]) {
        const g = allocationGrid(w, s, room(933, s));
        expect(g.donut, `${w}/${s}`).toBeGreaterThanOrEqual(foldScreens.donutMin);
        expect(g.donut, `${w}/${s}`).toBeLessThanOrEqual(foldScreens.donutMax);
        if (g.beside) expect(besideNameW(g.colW, g.donut, s, g.legend), `${w}/${s}`).toBeGreaterThanOrEqual(Math.round(foldScreens.legendNameMin * Math.min(s, 1.4)));
      }
  });

  it("비중 배치 단계는 폭이 넓어질수록 줄지 않는다 (0 원 아래 → 1 원 옆 두 줄 → 2 원 옆 한 줄) — 켜기·끄기 여유를 거는 조건", () => {
    for (const s of [1, 1.3, 1.4, 2])
      for (const hh of [632, 704, 861, 954, 1400]) {
        let last = 0;
        for (let w = 600; w <= 1400; w += 2) {
          const step = allocationStep(w, s, room(hh, s));
          expect(step, `${w}/${s}/${hh}`).toBeGreaterThanOrEqual(last);
          last = step;
        }
      }
    // 칸 폭만 모자라면: 폭 760 은 두 줄, 910 은 두 줄, 933 은 한 줄
    expect(allocationStep(760, 1)).toBe(1);
    expect(allocationStep(910, 1)).toBe(1);
    expect(allocationStep(933, 1)).toBe(2);
  });

  it("비중 원 아래 범례(단계 0): 남는 높이가 있으면 원을 키운다 (카드 4장이 한 화면에 들어가는 만큼, 120~180 · 칸 폭 안)", () => {
    const below = (d: number, rows: number[]) => rows.reduce((a, n) => a + 2 * WIDE_CARD.padV + d + WIDE_CARD.gap + foldScreens.legendHeadH + n * foldScreens.legendRowH, 0);
    for (const [w, hh, d] of [
      [859, 954, 136],
      [704, 933, 125],
    ] as const) {
      const g = allocationGrid(w, 1, room(hh), 0);
      expect(g, `${w}`).toEqual({ colW: Math.floor((w - 8) / 2), donut: d, beside: false, legend: "row", dense: false });
      expect(below(g.donut, [2, 11]), `${w}`).toBeLessThanOrEqual(room(hh).height);
    }
    expect(allocationGrid(704, 1, room(2000, 1, [2, 2]), 0).donut).toBe(foldScreens.donutMax);
    expect(allocationGrid(704, 1, room(700), 0).donut).toBe(foldScreens.donutMin);
    expect(allocationGrid(704, 1, { height: Number.NaN, rows: [2, 11] }, 0).donut).toBe(foldScreens.donutMin);
    // 기준선 근처에서 바로 전 단계를 지킬 때 (stepOverride): 원 옆 한 줄이면 원은 가장 작게라도 옆에
    expect(allocationGrid(900, 1, undefined, 2)).toMatchObject({ beside: true, legend: "row", donut: foldScreens.donutMin });
    expect(allocationGrid(933, 1, undefined, 1)).toMatchObject({ beside: true, legend: "stack" });
  });

  it("테마 목록 두 칸: 한 칸 340(큰 글씨는 넓힘) 이상일 때만 — 704·853·859·954 모두 두 칸, 큰 글씨 704 는 한 칸", () => {
    expect(themeListColumns(853, 1)).toBe(2);
    expect(themeListColumns(859, 1)).toBe(2);
    expect(themeListColumns(704, 1)).toBe(2);
    expect(themeListColumns(954, 1)).toBe(2);
    expect(themeListColumns(853, 1.3)).toBe(2);
    expect(themeListColumns(704, 1.3)).toBe(1);
    expect(themeListColumns(640, 1)).toBe(1);
    expect(themeListColumns(0, 1)).toBe(1);
  });
});

describe("켜기·끄기 여유 (stickyStep, 히스테리시스)", () => {
  const cols = (w: number) => Math.max(3, Math.floor(w / 150));
  it("처음에는 그 폭의 값, 바로 전 값에서 여유(24)만큼 더 넘어야 바꾼다", () => {
    expect(foldScreens.hysteresis).toBe(24);
    expect(stickyStep(null, 760, cols)).toBe(5);
    // 5칸(750 이상)에서 740 으로 줄여도 764 에서 5칸이면 그대로 → 725 까지 줄여야(749) 4칸
    expect(stickyStep(5, 740, cols)).toBe(5);
    expect(stickyStep(5, 726, cols)).toBe(5);
    expect(stickyStep(5, 725, cols)).toBe(4);
    // 4칸에서 760 으로 넓혀도 736 이 4칸이면 그대로 → 774 이상이어야 5칸
    expect(stickyStep(4, 760, cols)).toBe(4);
    expect(stickyStep(4, 774, cols)).toBe(5);
    // 크게 바뀌면 (접고 펴기) 여유를 뺀 폭의 값으로 바로
    expect(stickyStep(3, 1200, cols)).toBe(7);
    expect(stickyStep(7, 475, cols)).toBe(3);
  });

  it("기준선을 오가는 창 끌기 (678 ↔ 698) 에서 두 칸·한 칸이 번갈아 바뀌지 않는다", () => {
    const two = (w: number) => (settingsTwoColumns(w, 1) ? 1 : 0);
    let v: number | null = null;
    const seen: number[] = [];
    for (const w of [720, 698, 678, 698, 678, 698, 660, 678, 698, 678, 720]) {
      v = stickyStep(v, w, two);
      seen.push(v);
    }
    expect(seen).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1]);
  });
});

describe("테마 한 칸의 대표 종목 (lib/discoverColumns)", () => {
  const L = (name: string, changeRate: number | null) => ({ name, changeRate });
  const JOSEON = [L("한화오션", 4.11), L("HD현대중공업", 3.2), L("삼성중공업", 1.69)];
  const DEFENSE = [L("현대로템", 7.35), L("한화에어로스페이스", 2.36)];

  it("대표 종목 줄 폭: 칸 − 여백 28 − 순위 28 − 간격 16 − 등락률 상자 72 (큰 글씨는 상자가 넓어진다)", () => {
    expect(themeLeaderLineW(853 / 2, 1)).toBe(282);
    expect(themeLeaderLineW(704 / 2, 1)).toBe(208);
    expect(themeLeaderLineW(954 / 2, 1)).toBe(333);
    expect(themeLeaderLineW(954 / 2, 2)).toBeLessThan(themeLeaderLineW(954 / 2, 1));
    expect(themeLeaderLineW(0, 1)).toBe(0);
  });

  it("글자 폭 어림: 한글 1 · 영문 대문자 0.72 · 숫자 0.6 · 점·가운뎃점 0.32 · % 0.9", () => {
    expect(textEm("삼성")).toBe(2);
    expect(textEm("HD")).toBeCloseTo(1.44);
    expect(textEm("+1.69%")).toBeCloseTo(0.6 * 4 + 0.32 + 0.9);
    // 구분 " · " 은 빈칸 둘 + 가운뎃점 (예전에는 가운뎃점을 0.6 으로 잡아 들어갈 자리가 있는 대표 종목도 뺐다)
    expect(textEm(" · ")).toBeCloseTo(0.3 * 2 + 0.32);
  });

  it("폴드8 펼침 세로 한 칸(352): 첫 종목 뒤 남는 약 95dp 에 둘째 종목을 넣는다 (원자력발전 '한국전력 +1.94%')", () => {
    const lineW = themeLeaderLineW(704 / 2, 1);
    const leaders = [L("두산에너빌리티", 6.12), L("한국전력", 1.94), L("현대건설", 0.85)];
    // 첫 종목 어림 폭 뒤에 구분점 + 이름 최소 폭(한글 세 글자) + 등락률이 들어간다 → 둘째 종목까지 (이름은 줄어들 수 있고, 등락률은 그대로)
    const used = (textEm("두산에너빌리티") + textEm(" +6.12%")) * 11;
    expect(used + (textEm(" · ") + textEm(" +1.94%")) * 11 + foldScreens.themeLeaderNameMin).toBeLessThanOrEqual(lineW);
    expect(fitThemeLeaders(leaders, lineW, 1, formatPct)).toBe(2);
  });

  it("들어가는 만큼만: 다 들어가는 종목까지, 다음 종목은 이름 세 글자 폭이 남으면 이름을 줄여 하나 더", () => {
    // 한 칸 426(폴드8 펼침 가로): 조선 대표 종목 둘까지 다 들어가고, 셋째는 이름 세 글자도 안 남아 뺀다 (예전에는 '+1…' 로 잘림)
    expect(fitThemeLeaders(JOSEON, 282, 1, formatPct)).toBe(2);
    // 한 칸 477(울트라 펼침 가로): 셋 다
    expect(fitThemeLeaders(JOSEON, 333, 1, formatPct)).toBe(3);
    // 한 칸 352(폴드8 펼침 세로): 방위산업 — 현대로템은 다, 한화에어로스페이스는 이름을 줄여서
    expect(fitThemeLeaders(DEFENSE, 208, 1, formatPct)).toBe(2);
    // 아주 좁으면 첫 종목 하나 (이름이 줄어든다), 하나뿐이거나 없으면 그대로
    expect(fitThemeLeaders(JOSEON, 60, 1, formatPct)).toBe(1);
    expect(fitThemeLeaders([L("삼성전자", 1.44)], 10, 1, formatPct)).toBe(1);
    expect(fitThemeLeaders([], 300, 1, formatPct)).toBe(0);
    // 큰 글씨는 글자만큼 넓게 어림 → 덜 보인다
    expect(fitThemeLeaders(JOSEON, 282, 1.4, formatPct)).toBeLessThanOrEqual(fitThemeLeaders(JOSEON, 282, 1, formatPct));
    // 등락률이 없는 종목은 이름만 어림
    expect(fitThemeLeaders([L("가", null), L("나", null), L("다", null)], 282, 1, formatPct)).toBe(3);
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
    // 표: 재기 전에는 창 폭 − 왼쪽 탭 막대(80)로 어림 → 이름 칸 163, 잰 뒤(853)도 같다
    const nameW = () => styleOf(inside(tableRows(r)[0]!).find((n) => n.type === "View" && styleOf(n).flex === 1)!);
    expect(nameW()).toMatchObject({ flex: 1 });
    expect(nodes(r, "TableHead")[0]!.children.filter((c): c is HostNode => typeof c !== "string").map((c) => styleOf(c).width)).toEqual([30, undefined, 114, 90, 104, 92, 104, 72]);
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
    // 폭이 704 로 줄면 히트맵 4칸, 목록은 그대로 두 칸 (한 칸 352 — 대표 종목은 들어가는 만큼만)
    layoutTo(r, r.tree[0] as HostNode, 704);
    expect(flatList(r).props).toMatchObject({ numColumns: 4 });
    expect(styleOf(tile()).width).toBe("25%");
    r.act(() => (r.byLabel("목록으로 보기").props.onPress as () => void)());
    expect(flatList(r).props).toMatchObject({ numColumns: 2 });
    expect(styleOf(nodes(r, "Pressable").find((n) => /^1위, 조선 테마/.test(String(n.props.accessibilityLabel)))!).width).toBe("50%");
  });

  it("큰 글씨(130%) · 폴드8 펼침 세로 704: 테마 목록은 한 칸 (휴대폰 줄 그대로)", () => {
    wideOn(704, 933, 1.3);
    const r = render(<DiscoverScreen />);
    layoutTo(r, r.tree[0] as HostNode, 704);
    r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
    expect(flatList(r).props).toMatchObject({ numColumns: 1 });
    expect(styleOf(nodes(r, "Pressable").find((n) => /^1위, 조선 테마/.test(String(n.props.accessibilityLabel)))!).width).toBeUndefined();
  });

  it("테마 한 칸: 대표 종목은 들어가는 만큼만, 등락률은 이름과 떼어 말줄임 없이 · 이름은 마지막 하나만 줄어든다 (숫자 잘림 회귀)", () => {
    h.themes = [
      { ...THEMES[0]!, leaders: [lead("042660", "한화오션", 4.11), lead("329180", "HD현대중공업", 3.2), lead("010140", "삼성중공업", 1.69)] },
      { ...THEMES[1]!, leaders: [lead("064350", "현대로템", 7.35), lead("012450", "한화에어로스페이스", 2.36)] },
      { ...THEMES[2]!, leaders: [lead("034020", "두산에너빌리티", 6.12), lead("015760", "한국전력", null)] },
    ];
    const leaderTexts = (r: R, label: RegExp) => {
      const row = nodes(r, "Pressable").find((n) => label.test(String(n.props.accessibilityLabel)))!;
      const line = inside(row).find((n) => n.type === "View" && styleOf(n).alignItems === "baseline" && styleOf(n).overflow === "hidden")!;
      return line.children.filter((c): c is HostNode => typeof c !== "string");
    };
    for (const [w, hh, box, n] of [
      // 폴드8 펼침 가로: 한 칸 426 → 조선은 둘 (예전에는 셋째 '삼성중공업 +1…' 의 등락률이 잘렸다)
      [933, 704, 853, 2],
      // 울트라 펼침 가로: 한 칸 477 → 셋 다
      [954, 859, 954, 3],
    ] as const) {
      wideOn(w, hh);
      const r = render(<DiscoverScreen />);
      layoutTo(r, r.tree[0] as HostNode, box);
      r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
      const texts = leaderTexts(r, /^1위, 조선 테마/);
      const rates = texts.filter((x) => /[+-]\d/.test(textOf(x)));
      expect(rates.map(textOf), `${w}`).toEqual([" +4.11%", " +3.20%", " +1.69%"].slice(0, n));
      // 등락률·구분점: 말줄임 없음, 줄지 않음
      for (const x of texts.filter((x) => !/[가-힣A-Z]/.test(textOf(x)))) {
        expect(x.props.numberOfLines, textOf(x)).toBeUndefined();
        expect(styleOf(x).flexShrink, textOf(x)).toBe(0);
      }
      // 이름: 한 줄, 마지막 이름만 줄어든다
      const names = texts.filter((x) => /[가-힣A-Z]/.test(textOf(x)));
      expect(names.map((x) => styleOf(x).flexShrink), `${w}`).toEqual([...Array(n - 1).fill(0), 1]);
      for (const x of names) expect(x.props.numberOfLines).toBe(1);
    }
    // 폴드8 펼침 세로 704: 한 칸 352 → 방위산업은 현대로템 다, 한화에어로스페이스는 이름을 줄여서 (등락률은 그대로)
    wideOn(704, 933);
    const r = render(<DiscoverScreen />);
    layoutTo(r, r.tree[0] as HostNode, 704);
    r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
    expect(leaderTexts(r, /^2위, 원자력발전 테마/).map(textOf)).toEqual(["현대로템", " +7.35%", " · ", "한화에어로스페이스", " +2.36%"]);
    // 등락률이 없는 종목은 이름만
    expect(leaderTexts(r, /^3위, 방위산업 테마/).map(textOf)).toEqual(["두산에너빌리티", " +6.12%", " · ", "한국전력"]);
    // 휴대폰 줄(한 칸 목록)은 예전처럼 한 줄 글자 (접은 화면)
    size(475, 751);
    r.rerender();
    const phone = nodes(r, "Pressable").find((n) => /^1위, 조선 테마/.test(String(n.props.accessibilityLabel)))!;
    expect(inside(phone).some((n) => n.type === "View" && styleOf(n).alignItems === "baseline" && styleOf(n).overflow === "hidden")).toBe(false);
    expect(textOf(phone)).toContain("한화오션 +4.11% · HD현대중공업 +3.20% · 삼성중공업 +1.69%");
  });

  it("칸 수 기준선 근처에서는 바로 전 칸 수를 지킨다 (히스테리시스) — 목록을 새로 만들지 않는다", () => {
    wideOn(859, 954);
    const r = render(<DiscoverScreen />);
    const box = r.tree[0] as HostNode;
    layoutTo(r, box, 859);
    r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
    r.act(() => (r.byLabel("히트맵으로 보기").props.onPress as () => void)());
    expect(flatList(r).props).toMatchObject({ numColumns: 5 });
    // 5칸 기준(타일 150 × 5 + 여백 16 = 766) 바로 아래 760: 여유 24 안이라 5칸 그대로
    layoutTo(r, r.tree[0] as HostNode, 760);
    expect(flatList(r).props.numColumns).toBe(5);
    // 여유를 넘어 740: 4칸
    layoutTo(r, r.tree[0] as HostNode, 740);
    expect(flatList(r).props.numColumns).toBe(4);
    // 다시 770 으로 넓혀도 790(여유 24 를 뺀 폭이 766) 에 못 미치면 4칸, 800 이면 5칸
    layoutTo(r, r.tree[0] as HostNode, 770);
    expect(flatList(r).props.numColumns).toBe(4);
    layoutTo(r, r.tree[0] as HostNode, 800);
    expect(flatList(r).props.numColumns).toBe(5);
    // 목록 두 칸(680 이상)도 같다: 670 은 두 칸 그대로, 650 은 한 칸
    r.act(() => (r.byLabel("목록으로 보기").props.onPress as () => void)());
    layoutTo(r, r.tree[0] as HostNode, 670);
    expect(flatList(r).props.numColumns).toBe(2);
    layoutTo(r, r.tree[0] as HostNode, 650);
    expect(flatList(r).props.numColumns).toBe(1);
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

  it("접은 화면에서 펴면 처음 연 것과 같은 칸 수 — 좁은 창에서는 바로 전 칸 수를 잊는다 (진단: 펼친 경로에 따라 칸 수가 달랐다)", () => {
    // 폭 690: 테마 목록 두 칸 기준(680) 바로 위. 좁은 창의 칸 수(1)를 기억하면 여유(24) 때문에 한 칸으로 남았다
    wideOn(690, 933);
    const fresh = render(<DiscoverScreen />);
    fresh.act(() => (fresh.byLabel("테마 보기").props.onPress as () => void)());
    expect(flatList(fresh).props.numColumns).toBe(2);
    expect(themeListColumns(690 - foldScreens.hysteresis, 1)).toBe(1);
    wideOn(475, 751);
    const r = render(<DiscoverScreen />);
    r.act(() => (r.byLabel("테마 보기").props.onPress as () => void)());
    expect(flatList(r).props.numColumns).toBeUndefined();
    size(690, 933);
    r.rerender();
    expect(flatList(r).props.numColumns).toBe(2);
    // 히트맵도: 폭 770(여백 뺀 754) → 5칸. 좁은 창의 3칸을 기억하면 4칸이었다
    r.act(() => (r.byLabel("히트맵으로 보기").props.onPress as () => void)());
    size(475, 751);
    r.rerender();
    expect(flatList(r).props.numColumns).toBe(3);
    size(770, 933);
    r.rerender();
    expect(flatList(r).props.numColumns).toBe(5);
    expect(heatColumns(770 - 16 - foldScreens.hysteresis, 1)).toBe(4);
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
  /** 넓은 창의 카드 틀 (두 칸이든 한 칸이든 같은 틀 — 폭을 재는 onLayout 이 달려 있다) */
  const frame = (r: R) => r.all().find((n) => n.type === "View" && typeof n.props.onLayout === "function");
  /** 칸 안 카드 순서: 제목(SectionTitle) 글자, 또는 따로 만든 카드 이름 */
  const cardsIn = (col: HostNode): string[] =>
    col.children.flatMap((c) => {
      if (typeof c === "string") return [];
      if (c.type !== "Card") return [c.type];
      const title = inside(c).find((x) => x.type === "SectionTitle");
      return title ? [textOf(title)] : [];
    });
  const PHONE_ORDER = ["표시", "NotificationSettingsCard", "TossOpenApiCard", "AppUpdateCard", "서버", "서버 연결", "ScreenInfoCard", "정보"];

  it.each([
    ["폴드8 펼침 가로 (왼쪽 탭 막대)", 933, 704, 1],
    ["울트라 펼침 세로", 859, 954, 1],
    ["폴드8 펼침 세로", 704, 933, 1],
    ["울트라 펼침 가로 · 글자 130%", 954, 859, 1.3],
  ] as const)("%s: 카드 두 칸 — 왼쪽 표시·알림·정보 | 오른쪽 토스·업데이트·서버·서버 연결·화면 정보", (_n, w, hh, s) => {
    wideOn(w, hh, s);
    const r = render(<SettingsScreen />);
    const cols = columns(r)!;
    expect(cols).toBeDefined();
    expect(cols).toBe(frame(r));
    expect(styleOf(cols)).toMatchObject({ gap: space.sm, alignItems: "flex-start" });
    const [left, right] = cols.children as HostNode[];
    expect(cardsIn(left!)).toEqual(["표시", "NotificationSettingsCard", "정보"]);
    expect(cardsIn(right!)).toEqual(["TossOpenApiCard", "AppUpdateCard", "서버", "서버 연결", "ScreenInfoCard"]);
    // 칸은 최대 폭(400 × 글자 배율)까지만, 남는 폭은 두 칸 사이로만 — 칸은 화면 양 끝에 붙는다 (가운데로 모으지 않는다)
    expect(styleOf(cols).justifyContent).toBe("space-between");
    for (const c of [left!, right!]) expect(styleOf(c)).toMatchObject({ flex: 1, maxWidth: settingsColumnMax(s) });
    // 고지 문구는 그대로
    expect(r.text()).toContain("투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.");
  });

  it.each([
    ["폴드8 펼침 가로 · 글자 130%", 933, 704, 1.3],
    ["폴드8 펼침 세로 · 글자 130%", 704, 933, 1.3],
    ["폭 640 창", 640, 933, 1],
  ] as const)("%s: 두 칸이 안 들어가면 같은 틀을 세로로 쌓은 한 칸 — 카드 차례는 휴대폰과 같다 (정보는 맨 끝)", (_n, w, hh, s) => {
    wideOn(w, hh, s);
    const r = render(<SettingsScreen />);
    expect(columns(r)).toBeUndefined();
    const f = frame(r)!;
    expect(f.children).toHaveLength(2);
    expect((f.children as HostNode[]).flatMap(cardsIn)).toEqual(PHONE_ORDER);
    expect(r.text()).toContain("투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.");
  });

  it("두 칸 기준선(688) 근처에서는 바로 전 배치를 지킨다 (히스테리시스): 창을 끌어도 한 칸·두 칸이 번갈아 바뀌지 않는다", () => {
    wideOn(680, 933);
    const r = render(<SettingsScreen />);
    // 처음 680: 한 칸
    expect(frame(r)).toBeDefined();
    expect(columns(r)).toBeUndefined();
    // 700 으로 넓혀도 여유(24) 안이라 한 칸 그대로, 720 이면 두 칸
    size(700, 933);
    r.rerender();
    expect(columns(r)).toBeUndefined();
    size(720, 933);
    r.rerender();
    expect(columns(r)).toBeDefined();
    // 680 으로 좁혀도 두 칸 그대로 (여유 없이 재면 한 칸), 660 이면 한 칸
    size(680, 933);
    r.rerender();
    expect(settingsTwoColumns(680, 1)).toBe(false);
    expect(columns(r)).toBeDefined();
    size(660, 933);
    r.rerender();
    expect(columns(r)).toBeUndefined();
    // 접으면(좁은 창) 휴대폰 화면 (틀 없음)
    size(475, 751);
    r.rerender();
    expect(frame(r)).toBeUndefined();
  });

  it("두 칸 여부는 설정 탭이 실제로 받은 폭(잰 값)으로 — 창 폭 어림이 아니라", () => {
    wideOn(760, 933);
    const r = render(<SettingsScreen />);
    expect(columns(r)).toBeDefined();
    // 좌우 여백 등으로 실제 폭이 640 이면 한 칸 (여유를 넘는 차이)
    layoutTo(r, frame(r)!, 640);
    expect(columns(r)).toBeUndefined();
  });

  it("접은 화면에서 펴면 처음 연 것과 같은 배치 — 좁은 창에서는 바로 전 배치를 잊는다 (진단: 펼친 경로에 따라 한 칸·두 칸이 달랐다)", () => {
    // 폭 700: 두 칸 기준(688) 바로 위. 좁은 창의 '한 칸'을 기억하면 여유(24) 때문에 한 칸으로 남았다
    wideOn(700, 933);
    const fresh = render(<SettingsScreen />);
    expect(columns(fresh)).toBeDefined();
    expect(settingsTwoColumns(700 - foldScreens.hysteresis, 1)).toBe(false);
    wideOn(475, 751);
    const r = render(<SettingsScreen />);
    expect(frame(r)).toBeUndefined();
    size(700, 933);
    r.rerender();
    expect(columns(r)).toBeDefined();
    expect(shot(r)).toEqual(shot(fresh));
  });

  it("한 칸 ↔ 두 칸이 바뀌어도 카드가 새로 만들어지지 않는다 · 입력 중인 서버 주소는 접고 펴도 남는다", () => {
    wideOn(720, 933);
    const r = render(<SettingsScreen />);
    expect(columns(r)).toBeDefined();
    expect(h.mounts).toEqual({ notify: 1, toss: 1 });
    press(r, "서버 연결");
    r.act(() => (r.byLabel("서버 주소").props.onChangeText as (v: string) => void)("https://draft.test"));
    r.act(() => (r.byLabel("API 토큰").props.onChangeText as (v: string) => void)("tok-draft"));
    // 두 칸 → 한 칸 → 두 칸 (창 끌기·돌리기): 알림·토스 카드는 그대로 (펼침 상태·안내가 남는다)
    size(640, 933);
    r.rerender();
    expect(columns(r)).toBeUndefined();
    size(760, 933);
    r.rerender();
    expect(columns(r)).toBeDefined();
    expect(h.mounts).toEqual({ notify: 1, toss: 1 });
    expect(r.byLabel("서버 주소").props.value).toBe("https://draft.test");
    // 접고 펴기: 카드 틀이 달라 카드는 새로 그려지지만, 입력 중인 주소·토큰과 '서버 연결' 펼침은 화면이 들고 있어 남는다
    size(475, 751);
    r.rerender();
    expect(frame(r)).toBeUndefined();
    expect(r.byLabel("서버 주소").props.value).toBe("https://draft.test");
    expect(r.byLabel("API 토큰").props.value).toBe("tok-draft");
    size(933, 704);
    r.rerender();
    expect(r.byLabel("서버 주소").props.value).toBe("https://draft.test");
    expect(r.byLabel("API 토큰").props.value).toBe("tok-draft");
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
  const besideCount = (r: R) => r.all().filter((n) => n.type === "View" && styleOf(n).paddingLeft === BESIDE.padL && styleOf(n).flexDirection === "row").length;
  /** 범례 머리의 '평가금액' 열 (한 줄 범례에만 있다) */
  const amountHeads = (r: R) => r.all().filter((n) => n.type === "Text" && textOf(n) === "평가금액").length;
  const donuts = (r: R) => nodes(r, "Svg").map((s) => s.props.width);

  it("폴드8 펼침 가로: 요약 한 줄 + 카드 2×2, 원(126) 옆에 한 줄 범례, 제목은 범례 머리(화면 읽기 머리글)", () => {
    wideOn(933, 704);
    many();
    const r = render(<AllocationScreen />);
    const rows = gridRows(r);
    expect(rows.map((row) => row.children.length)).toEqual([2, 2]);
    expect(donuts(r)).toEqual([126, 126, 126, 126]);
    expect(r.all().filter((n) => n.props.accessibilityRole === "header").map(textOf)).toEqual(["국내 / 해외", "통화", "업종", "종목별"]);
    // 원 옆 배치 4장, 한 줄 범례(평가금액 열)
    expect(besideCount(r)).toBe(4);
    expect(amountHeads(r)).toBe(4);
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

  it.each([
    // 격자 높이 933 − 24 − 48 − 176 = 685 → 원 120 (이름 칸 106)
    ["폴드8 펼침 세로 704", 704, 933, 120],
    // 격자 높이 706 → 원 180 (이름 칸 123)
    ["울트라 펼침 세로 859", 859, 954, 180],
  ] as const)("%s: 원 옆 두 줄 범례 — 평가금액·종목 수를 이름 아래로 내려 이름 칸을 넓힌다 (예전에는 원 아래 범례)", (_n, w, hh, d) => {
    wideOn(w, hh);
    many();
    const r = render(<AllocationScreen />);
    expect(gridRows(r)).toHaveLength(2);
    expect(donuts(r)).toEqual([d, d, d, d]);
    expect(besideCount(r)).toBe(4);
    // 평가금액 열 머리가 없고, 줄마다 둘째 줄에 금액 (· 종목 수)
    expect(amountHeads(r)).toBe(0);
    const subs = r.all().filter((n) => n.type === "Text" && /^[\d,]+원( · \d+종목)?$/.test(textOf(n)));
    expect(subs.length).toBeGreaterThan(10);
    // 둘째 줄은 말줄임 없이 글자를 줄이고(숫자), 이름은 한 줄 말줄임
    for (const x of subs) expect(x.props, textOf(x)).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
    expect(subs.some((x) => / · \d+종목$/.test(textOf(x)))).toBe(true);
    const box = r.all().find((n) => n.type === "View" && n.children.includes(subs[0]!))!;
    expect(styleOf(box)).toMatchObject({ flex: 1, minWidth: 0 });
    expect((box.children[0] as HostNode).props.numberOfLines).toBe(1);
    // 비중은 그대로 오른쪽 열, 말줄임 없이 글자를 줄인다
    const pcts = r.all().filter((n) => n.type === "Text" && /^[\d.]+%$/.test(textOf(n)) && styleOf(n).fontWeight === "700" && styleOf(n).textAlign === "right");
    expect(pcts.length).toBeGreaterThan(10);
    for (const x of pcts) expect(x.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
    // 화면 읽기: 범례 한 줄 한 문장은 한 줄 범례와 같다
    expect(r.all().some((n) => /^한화에어로스페이스, [\d,]+원, 비중 [\d.]+%$/.test(String(n.props.accessibilityLabel)))).toBe(true);
  });

  it("범례 종목 수는 이름과 떼어 줄이지 않는다 · 이름만 한 줄 말줄임 (숫자 잘림 회귀)", () => {
    wideOn(933, 704);
    many();
    const r = render(<AllocationScreen />);
    const counts = r.all().filter((n) => n.type === "Text" && /^ · \d+종목$/.test(textOf(n)));
    expect(counts.length).toBeGreaterThanOrEqual(3);
    for (const c of counts) {
      expect(c.props.numberOfLines, textOf(c)).toBeUndefined();
      expect(styleOf(c).flexShrink, textOf(c)).toBe(0);
    }
    // 이름: 한 줄, 줄어든다 (같은 줄의 종목 수와 형제)
    const box = r.all().find((n) => n.type === "View" && n.children.includes(counts[0]!))!;
    const name = box.children[0] as HostNode;
    expect(name.props.numberOfLines).toBe(1);
    expect(styleOf(name).flexShrink).toBe(1);
    expect(styleOf(box)).toMatchObject({ flex: 1, minWidth: 0, flexDirection: "row" });
  });

  it("높이가 모자라면 범례 줄 여백을 줄인다 (폴드8 펼침 가로 실제 창 933×632 — 넷째 카드가 첫 화면에)", () => {
    wideOn(933, 632);
    h.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    h.stocks = [...HOLD, ...Array.from({ length: 16 }, (_, i) => holding(`D${i}`, quote(`D${i}`, 10_000 + i * 1_000, { industry: `업종${i % 9}` }), 10, 9_000, undefined, `종목${i}`))];
    const r = render(<AllocationScreen />);
    expect(besideCount(r)).toBe(4);
    const rowsV = r.all().filter((n) => n.type === "View" && typeof n.props.accessibilityLabel === "string" && /, 비중 [\d.]+%$/.test(String(n.props.accessibilityLabel)));
    expect(rowsV.length).toBeGreaterThan(10);
    for (const x of rowsV) expect(styleOf(x).paddingVertical).toBe(space.xxs);
    // 높이가 넉넉하면 보통 여백
    size(933, 859);
    r.rerender();
    for (const x of r.all().filter((n) => n.type === "View" && /, 비중 [\d.]+%$/.test(String(n.props.accessibilityLabel ?? "")))) expect(styleOf(x).paddingVertical).toBe(space.xs);
  });

  it("화면 읽기: 제목보다 먼저 읽는 원 요약 앞에 차트 제목을 붙인다", () => {
    wideOn(933, 704);
    many();
    const r = render(<AllocationScreen />);
    const imgs = r.all().filter((n) => n.props.accessibilityRole === "image");
    expect(imgs.map((d) => String(d.props.accessibilityLabel).split(",")[0])).toEqual(["국내 / 해외 원 차트", "통화 원 차트", "업종 원 차트", "종목별 원 차트"]);
    expect(String(imgs[0]!.props.accessibilityLabel)).toMatch(/^국내 \/ 해외 원 차트, 국내 [\d.]+%, 해외 [\d.]+%$/);
  });

  it("배치 단계 기준선 근처에서는 바로 전 배치를 지킨다 (히스테리시스)", () => {
    wideOn(933, 704);
    many();
    const r = render(<AllocationScreen />);
    expect(amountHeads(r)).toBe(4);
    // 이 높이에서는 두 줄 범례가 한 화면에 안 들어가 한 줄 범례를 폭 844 까지 쓴다. 830: 여유 없이 재면 두 줄이지만 854 에서 한 줄이라 그대로
    size(830, 704);
    r.rerender();
    expect(besideCount(r)).toBe(4);
    expect(amountHeads(r)).toBe(4);
    // 815: 여유(24)를 넘어 두 줄 범례
    size(815, 704);
    r.rerender();
    expect(besideCount(r)).toBe(4);
    expect(amountHeads(r)).toBe(0);
  });

  it.each([
    ["폴드8 펼침 가로", 933, 704, 1],
    ["울트라 펼침 세로", 859, 954, 1],
    ["폴드8 펼침 세로 · 글자 130%", 704, 933, 1.3],
  ] as const)("접은 화면에서 펴도 처음 연 것과 같은 배치 — %s (좁은 창에서는 바로 전 배치를 잊는다)", (_n, w, hh, s) => {
    many();
    wideOn(w, hh, s);
    const fresh = render(<AllocationScreen />);
    expect(besideCount(fresh)).toBe(4);
    wideOn(475, 751, s);
    const r = render(<AllocationScreen />);
    expect(besideCount(r)).toBe(0);
    size(w, hh, s);
    r.rerender();
    expect(shot(r)).toEqual(shot(fresh));
  });

  it("잔고를 늦게 받아도 처음부터 가진 채 연 것과 같은 배치 — 받는 중(차트 없음)에는 배치 단계를 고르지 않는다", () => {
    // 글자 130% · 폴드8 펼침 가로: 받기 전 '범례 없음' 높이로 고른 두 줄 범례가 여유(24) 때문에 남았다 (웹 미리보기에서 재현)
    many();
    wideOn(933, 704, 1.3);
    const fresh = render(<AllocationScreen />);
    expect(amountHeads(fresh)).toBe(4);
    wideOn(933, 704, 1.3);
    h.stocksLoading = true;
    const r = render(<AllocationScreen />);
    expect(nodes(r, "Loading")).toHaveLength(1);
    h.stocksLoading = false;
    r.rerender();
    expect(amountHeads(r)).toBe(4);
    expect(shot(r)).toEqual(shot(fresh));
  });

  it("요약 줄: 총액은 말줄임 없이 — 넘치면 설명이 다음 줄로, 그래도 모자라면 총액이 이름 아래 줄로 (글자 200% '71,445,8…' 회귀)", () => {
    wideOn(704, 933, 2);
    many();
    const r = render(<AllocationScreen />);
    const summary = r.all().find((n) => n.type === "View" && /^총 평가금액/.test(String(n.props.accessibilityLabel ?? "")))!;
    expect(styleOf(summary)).toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
    const [totalBox, note] = summary.children as HostNode[];
    // 총액 칸: 제 폭 그대로(상한 없음 — 줄 전체까지), 이름과 한 줄에 안 들어가면 총액이 다음 줄로
    expect(styleOf(totalBox!)).toMatchObject({ flexDirection: "row", flexWrap: "wrap", maxWidth: "100%" });
    expect(styleOf(totalBox!).flexShrink).toBeUndefined();
    // 설명: 적어도 allocNoteMin 폭을 받고, 안 남으면 다음 줄로
    expect(styleOf(note!)).toMatchObject({ flexGrow: 1, flexBasis: foldScreens.allocNoteMin });
    const total = inside(totalBox!).find((n) => n.type === "Text" && /^[\d,]+ 원$/.test(textOf(n)))!;
    expect(total.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
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
