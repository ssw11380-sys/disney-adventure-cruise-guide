import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 이동평균선 설정 화면으로 가는 길 (3-39 PR 2, 기능 플래그 maCustom).
 *  - 종목 상세(휴대폰·넓은 창)·지수 상세(휴대폰·넓은 창)·전체 화면 차트: 켬일 때만 CandleChart 에 onMaSettings(→ /chart-lines)를 넘긴다.
 *    끄면 속성 자체가 없어 화면 스냅숏이 그대로
 *  - 새 화면 경로(_layout Stack.Screen 'chart-lines', 제목 '이동평균선')
 *  - 설정 > 표시 '차트 이동평균선' 줄 + [설정] (켬일 때만)
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | undefined>,
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  params: { code: "KOSPI" } as Record<string, string>,
  push: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.4.0", extra: { apiUrl: "https://prod.test" } } } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "StackScreen" },
  router: { push: h.push, setParams: vi.fn(), back: vi.fn(), canGoBack: () => true, dismissTo: vi.fn() },
  useLocalSearchParams: () => h.params,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
const INDEX = { code: "KOSPI", name: "코스피", value: 3478.12, change: 29.35, changeRate: 0.85, kind: "index", asOf: "2026-09-23T06:30:00Z", fetchedAt: "2026-09-23T06:31:00Z", stale: false };
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  // 지수 상세
  useMarketIndices: () => ({ data: { indices: [INDEX] }, isLoading: false, refetch: async () => undefined }),
  useMarketCandles: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined }),
  // 설정
  useHealth: () => ({ data: { ok: true, time: "2026-09-28T01:00:00Z", sources: {} }, isError: false, error: null, isFetching: false, refetch: async () => undefined }),
  useNotificationSettings: () => ({ data: undefined, refetch: async () => undefined }),
}));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 } }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip", formatIndexValue: (v: number) => v.toFixed(2) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/WidgetRefreshStatus", () => ({ WidgetRefreshStatus: "WidgetRefreshStatus" }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge",
  Button: "Button",
  Card: "Card",
  Chip: "Chip",
  ConnectionLine: "ConnectionLine",
  ErrorView: "ErrorView",
  LiveDot: "LiveDot",
  Loading: "Loading",
  Muted: "Muted",
  Row: "Row",
  RowWrapContext: React.createContext(false),
  SectionTitle: "SectionTitle",
  Stat: "Stat",
  Toggle: "Toggle",
}));
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  THEME_OPTIONS: [{ value: "dark", label: "다크" }],
  WIDGET_ROW_OPTIONS: [],
  DENSITY_OPTIONS: [
    { value: "basic", label: "기본" },
    { value: "dense", label: "촘촘" },
  ],
  useSettings: () => ({
    apiUrl: "https://prod.test",
    apiToken: "",
    showKrw: false,
    afterCost: false,
    sort: "created",
    themeMode: "dark",
    widgetRowCurrency: "krw",
    haptics: true,
    density: "basic",
    setDensity: vi.fn(),
    setCredentials: vi.fn(),
  }),
}));

const { default: MarketIndexScreen } = await import("@/app/market/[code]");
const { default: SettingsScreen } = await import("@/app/(tabs)/settings");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf8");
const SPREAD = "{...(maCustom ? { onMaSettings: openMaLines } : null)}";

beforeEach(() => {
  h.flags = {};
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.params = { code: "KOSPI" };
  h.push.mockClear();
  forgetWindowClass();
});

describe("지수 상세 → CandleChart onMaSettings", () => {
  const charts = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "CandleChart");

  it("켬: 휴대폰(475×751)·넓은 창(933×704) 모두 onMaSettings 함수, 부르면 /chart-lines", () => {
    for (const [w, hh, fold] of [[475, 751, false], [933, 704, true]] as const) {
      h.flags = { maCustom: true, foldLayout: fold };
      h.win = { width: w, height: hh, scale: 2.625, fontScale: 1 };
      forgetWindowClass();
      const r = render(<MarketIndexScreen />);
      const c = charts(r);
      expect(c, `${w}`).toHaveLength(1);
      expect(typeof c[0]!.props.onMaSettings, `${w}`).toBe("function");
      h.push.mockClear();
      (c[0]!.props.onMaSettings as () => void)();
      expect(h.push).toHaveBeenCalledWith("/chart-lines");
    }
  });

  it("끔(플래그 없음·꺼짐): 속성 자체가 없다", () => {
    for (const flags of [{}, { maCustom: false }, { maCustom: false, foldLayout: true }]) {
      h.flags = flags;
      for (const [w, hh] of [[475, 751], [933, 704]] as const) {
        h.win = { width: w, height: hh, scale: 2.625, fontScale: 1 };
        forgetWindowClass();
        const r = render(<MarketIndexScreen />);
        for (const c of charts(r)) expect("onMaSettings" in c.props, `${JSON.stringify(flags)} ${w}`).toBe(false);
      }
    }
  });
});

describe("종목 상세 · 전체 화면 차트 (파일 읽기)", () => {
  const uses = (rel: string) => [...read(rel).matchAll(/<CandleChart\b([\s\S]*?)\/>/g)].map((m) => m[1]!);

  it.each([
    ["app/stocks/[code]/index.tsx", 2, "if (!c) return"],
    ["app/stocks/[code]/chart.tsx", 1, "if (!c) {"],
    ["app/market/[code].tsx", 2, null],
  ] as const)("%s: <CandleChart> 마다 onMaSettings 는 maCustom 조건 안에서만, 플래그는 일찍 돌아가는 줄보다 위", (rel, n, early) => {
    const src = read(rel);
    const found = uses(rel);
    expect(found).toHaveLength(n);
    for (const f of found) {
      expect(f).toContain(SPREAD);
      expect(f.match(/onMaSettings/g)).toHaveLength(1);
    }
    // 파일 전체에서 onMaSettings 는 CandleChart 에 넘기는 곳뿐
    expect(src.match(/onMaSettings/g)).toHaveLength(n);
    expect(src).toContain('const openMaLines = () => router.push("/chart-lines");');
    const hook = src.indexOf('const maCustom = useFeature("maCustom", false);');
    expect(hook).toBeGreaterThan(0);
    // detailPolish 를 읽는 줄 바로 아래 (주석 한 줄 사이)
    expect(hook).toBeGreaterThan(src.indexOf('const polish = useFeature("detailPolish", false);'));
    if (early) expect(hook).toBeLessThan(src.indexOf(early));
  });
});

describe("새 화면 경로", () => {
  it("_layout 에 Stack.Screen 'chart-lines' (제목 '이동평균선', 모달) — 비중 다음", () => {
    const src = read("app/_layout.tsx");
    const line = src.split("\n").find((l) => l.includes('name="chart-lines"'))!;
    expect(line).toContain('title: "이동평균선"');
    expect(line).toContain('presentation: "modal"');
    expect(src.indexOf('name="chart-lines"')).toBeGreaterThan(src.indexOf('name="portfolio/allocation"'));
  });

  it("CandleChart 는 expo-router 를 부르지 않는다 (화면 이동은 onMaSettings 로 받음)", () => {
    expect(read("components/CandleChart.tsx")).not.toMatch(/from "expo-router"/);
  });
});

describe("설정 > 표시 '차트 이동평균선'", () => {
  it("켬: 이름·설명과 [설정] 버튼(options-outline, 이름표 '이동평균선 기간·색 설정'), 누르면 /chart-lines", () => {
    h.flags = { maCustom: true };
    const r = render(<SettingsScreen />);
    expect(r.text()).toContain("차트 이동평균선");
    expect(r.text()).toContain("선 6개의 기간(2~240)과 색");
    const b = r.byLabel("이동평균선 기간·색 설정");
    expect(b.type).toBe("Button");
    expect(b.props).toMatchObject({ title: "설정", icon: "options-outline", variant: "secondary", compact: true });
    (b.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/chart-lines");
  });

  it("자리: '잔고 표시'(densityMode) 뒤, 없으면 '잔고 정렬' 뒤 — '홈 화면 위젯 갱신' 앞", () => {
    for (const flags of [{ maCustom: true }, { maCustom: true, densityMode: true }]) {
      h.flags = flags;
      const text = render(<SettingsScreen />).text();
      const ma = text.indexOf("차트 이동평균선");
      expect(ma).toBeGreaterThan(text.indexOf("잔고 정렬"));
      if (flags.densityMode) expect(ma).toBeGreaterThan(text.indexOf("잔고 표시"));
      expect(text.indexOf("홈 화면 위젯 갱신")).toBeGreaterThan(ma);
    }
  });

  it("끔: 줄이 없다", () => {
    for (const flags of [{}, { maCustom: false }]) {
      h.flags = flags;
      const r = render(<SettingsScreen />);
      expect(r.text()).not.toContain("차트 이동평균선");
      expect(r.has("이동평균선 기간·색 설정")).toBe(false);
    }
  });
});
