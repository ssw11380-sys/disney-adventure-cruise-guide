import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 설정 > 표시 '차트 최고·최저가 표시' (3-46, 기능 플래그 chartHighLow).
 *  - 플래그가 켜져 있을 때만 스위치(화면 읽기 '차트 최고·최저가 표시')와 설명, '차트 이동평균선' 줄 다음 (차트 설정끼리)
 *  - 저장(SettingsProvider): 기기 저장소 settings.chartHighLow '1'/'0', 저장한 적 없으면 켬, 앱을 다시 켜도 유지
 *  - 꺼져 있으면 줄이 없다 (지금 그대로)
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | undefined>,
  chartHighLow: true as boolean | undefined,
  setChartHighLow: vi.fn(async () => undefined),
  /** 가짜 기기 저장소 — 모듈을 새로 불러도(앱 다시 켜기) 남는다 */
  store: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
    multiSet: async (pairs: [string, string][]) => {
      for (const [k, v] of pairs) h.store.set(k, v);
    },
    multiRemove: async (keys: string[]) => {
      for (const k of keys) h.store.delete(k);
    },
  },
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: 475, height: 751, scale: 2.625, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.4.0", extra: { apiUrl: "https://prod.test" } } } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() }, useLocalSearchParams: () => ({}) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
// 설정 화면이 읽는 설정 (가짜). 저장 시험은 아래에서 진짜 모듈(vi.importActual)로
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
    afterCost: true,
    sort: "created",
    themeMode: "dark",
    widgetRowCurrency: "krw",
    haptics: true,
    density: "basic",
    setDensity: vi.fn(),
    chartHighLow: h.chartHighLow,
    setChartHighLow: h.setChartHighLow,
    setCredentials: vi.fn(),
  }),
}));
vi.mock("@/api/hooks", () => ({
  useHealth: () => ({ data: { ok: true, time: "2026-09-28T01:00:00Z", sources: {} }, isError: false, error: null, isFetching: false, refetch: async () => undefined }),
  useNotificationSettings: () => ({ data: undefined, refetch: async () => undefined }),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
}));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/WidgetRefreshStatus", () => ({ WidgetRefreshStatus: "WidgetRefreshStatus" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", Row: "Row", RowWrapContext: React.createContext(false), SectionTitle: "SectionTitle", Toggle: "Toggle" }));

const { default: SettingsScreen } = await import("@/app/(tabs)/settings");

type Real = typeof import("@/lib/settings");
const real = () => vi.importActual<Real>("@/lib/settings");

const NAME = "차트 최고·최저가 표시";
const NOTE = "차트에 보이는 구간의 가장 높은 값과 낮은 값에 화살표, 가격·날짜, 지금 가격과의 차이(%)";

beforeEach(() => {
  h.flags = {};
  h.chartHighLow = true;
  h.setChartHighLow.mockClear();
  h.store.clear();
});

describe("설정 화면 '차트 최고·최저가 표시'", () => {
  it("플래그 켬: 이름·설명과 스위치(기본 켬), 누르면 저장 함수가 false 로 불린다", () => {
    h.flags = { chartHighLow: true };
    const r = render(<SettingsScreen />);
    expect(r.text()).toContain(NAME);
    expect(r.text()).toContain(NOTE);
    const sw = r.byLabel(NAME);
    expect(sw.type).toBe("Toggle");
    expect(sw.props.value).toBe(true);
    (sw.props.onValueChange as (v: boolean) => void)(false);
    expect(h.setChartHighLow).toHaveBeenCalledWith(false);
  });

  it("저장값 끔이면 스위치 끔, 설정 값을 모르면(옛 모양) 켬으로", () => {
    h.flags = { chartHighLow: true };
    h.chartHighLow = false;
    expect(render(<SettingsScreen />).byLabel(NAME).props.value).toBe(false);
    h.chartHighLow = undefined;
    expect(render(<SettingsScreen />).byLabel(NAME).props.value).toBe(true);
  });

  it("'차트 이동평균선' 줄 바로 뒤, '홈 화면 위젯 갱신' 앞 (차트 설정끼리)", () => {
    h.flags = { chartHighLow: true, maCustom: true };
    const text = render(<SettingsScreen />).text();
    const ma = text.indexOf("차트 이동평균선");
    const hl = text.indexOf(NAME);
    const widget = text.indexOf("홈 화면 위젯 갱신");
    expect(ma).toBeGreaterThanOrEqual(0);
    expect(hl).toBeGreaterThan(ma);
    expect(widget).toBeGreaterThan(hl);
  });

  it("투자 권유로 읽힐 말이 없다", () => {
    expect(`${NAME} ${NOTE}`).not.toMatch(/매수|매도|추천|기회|싸다|비싸|저점|고점/);
  });
});

describe("끔 — 지금 그대로", () => {
  it("플래그 없음(앱 fallback 꺼짐)·꺼짐: 줄이 없다 (저장값과 상관없이)", () => {
    for (const flags of [{}, { chartHighLow: false }]) {
      h.flags = flags;
      const r = render(<SettingsScreen />);
      expect(r.text()).not.toContain(NAME);
      expect(r.has(NAME)).toBe(false);
      expect(r.text()).toContain("잔고 정렬");
    }
  });
});

describe("저장 (SettingsProvider · 기기 저장소 settings.chartHighLow)", () => {
  /** 앱을 켠다: 저장된 설정을 다 읽을 때까지. 모듈을 새로 부른다 (저장소는 그대로) */
  async function open() {
    vi.resetModules();
    const R = await import("react");
    const mr = await import("./miniRender");
    const s = await real();
    let shown: { chartHighLow: boolean; setChartHighLow: (on: boolean) => Promise<void> } = { chartHighLow: false, setChartHighLow: async () => undefined };
    const Probe = () => {
      const v = s.useSettings();
      shown = { chartHighLow: v.chartHighLow, setChartHighLow: v.setChartHighLow };
      return null;
    };
    const r = mr.render(R.createElement(s.SettingsProvider, null, R.createElement(Probe)));
    await s.loadedCredentials();
    await new Promise((res) => setTimeout(res, 0));
    r.rerender();
    return { r, get: () => shown };
  }

  it("저장한 적 없음 → 켬", async () => {
    expect((await open()).get().chartHighLow).toBe(true);
  });

  it.each([["0", false], ["1", true], ["xyz", true]])("저장값 %s → %s", async (v, want) => {
    h.store.set("settings.chartHighLow", v);
    expect((await open()).get().chartHighLow).toBe(want);
  });

  it("setChartHighLow(false) → 저장소 '0', 앱을 다시 켜도 끔 · 다시 켜면 '1'", async () => {
    const { r, get } = await open();
    await get().setChartHighLow(false);
    r.rerender();
    expect(get().chartHighLow).toBe(false);
    expect(h.store.get("settings.chartHighLow")).toBe("0");
    const again = await open();
    expect(again.get().chartHighLow).toBe(false);
    await again.get().setChartHighLow(true);
    expect(h.store.get("settings.chartHighLow")).toBe("1");
    expect((await open()).get().chartHighLow).toBe(true);
  });

  it("제공자 밖(기본 문맥)도 켬", async () => {
    vi.resetModules();
    const R = await import("react");
    const mr = await import("./miniRender");
    const s = await real();
    let seen: boolean | null = null;
    const Probe = () => {
      seen = s.useSettings().chartHighLow;
      return null;
    };
    mr.render(R.createElement(Probe));
    expect(seen).toBe(true);
  });
});
