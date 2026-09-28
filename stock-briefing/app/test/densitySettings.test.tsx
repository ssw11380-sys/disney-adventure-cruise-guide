import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 설정 > 표시 '잔고 표시' 기본 · 촘촘 (3-39 PR 1, 기능 플래그 densityMode).
 *  - 플래그가 켜져 있을 때만 칩 두 개(화면 읽기 '잔고 표시 기본' · '잔고 표시 촘촘'), 누르면 저장
 *  - 저장(SettingsProvider): 기기 저장소 settings.density, 모르는 값·없음은 기본, 앱을 다시 켜도 유지
 *  - 꺼져 있으면 칸이 없다 (지금 그대로)
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | undefined>,
  density: "basic" as string,
  setDensity: vi.fn(async () => undefined),
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
    density: h.density,
    setDensity: h.setDensity,
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

beforeEach(() => {
  h.flags = {};
  h.density = "basic";
  h.setDensity.mockClear();
  h.store.clear();
});

describe("설정 화면 '잔고 표시'", () => {
  it("플래그 켬: 이름·설명과 칩 두 개(기본 선택됨), 촘촘을 누르면 저장 함수가 'dense' 로 불린다", () => {
    h.flags = { densityMode: true };
    const r = render(<SettingsScreen />);
    const text = r.text();
    expect(text).toContain("잔고 표시");
    expect(text).toContain("촘촘: 종목 줄 높이를 줄이고 계좌 요약을 짧게 해 한 화면에 종목을 더 많이 봅니다 (매입금액·국내/해외는 기본에서)");
    const basic = r.byLabel("잔고 표시 기본");
    const dense = r.byLabel("잔고 표시 촘촘");
    expect(basic.type).toBe("Chip");
    expect(basic.props).toMatchObject({ label: "기본", active: true });
    expect(dense.props).toMatchObject({ label: "촘촘", active: false });
    (dense.props.onPress as () => void)();
    expect(h.setDensity).toHaveBeenCalledWith("dense");
  });

  it("플래그 켬 + 저장값 촘촘: 촘촘 칩이 선택됨", () => {
    h.flags = { densityMode: true };
    h.density = "dense";
    const r = render(<SettingsScreen />);
    expect(r.byLabel("잔고 표시 촘촘").props.active).toBe(true);
    expect(r.byLabel("잔고 표시 기본").props.active).toBe(false);
  });

  it("'잔고 정렬' 바로 뒤, '홈 화면 위젯 갱신' 앞", () => {
    h.flags = { densityMode: true };
    const text = render(<SettingsScreen />).text();
    const sort = text.indexOf("잔고 정렬");
    const density = text.indexOf("잔고 표시");
    const widget = text.indexOf("홈 화면 위젯 갱신");
    expect(sort).toBeGreaterThanOrEqual(0);
    expect(density).toBeGreaterThan(sort);
    expect(widget).toBeGreaterThan(density);
  });
});

describe("끔 — 지금 그대로", () => {
  it("플래그 없음(앱 fallback 꺼짐)·꺼짐: '잔고 표시' 칸이 없다 (저장값이 촘촘이어도)", () => {
    h.density = "dense";
    for (const flags of [{}, { densityMode: false }]) {
      h.flags = flags;
      const r = render(<SettingsScreen />);
      expect(r.text()).not.toContain("잔고 표시");
      expect(r.has("잔고 표시 기본")).toBe(false);
      expect(r.has("잔고 표시 촘촘")).toBe(false);
      // 옆 칸은 그대로
      expect(r.text()).toContain("잔고 정렬");
    }
  });
});

describe("저장 (SettingsProvider · 기기 저장소 settings.density)", () => {
  /** 앱을 켠다: 저장된 설정을 다 읽을 때까지. 다시 켜기(fresh)면 모듈을 새로 부른다 (저장소는 그대로) */
  async function open(fresh = false) {
    if (fresh) vi.resetModules();
    const R = fresh ? await import("react") : React;
    const mr = fresh ? await import("./miniRender") : { render };
    const s = await real();
    let shown: { density: string; setDensity: (v: "basic" | "dense") => Promise<void> } = { density: "", setDensity: async () => undefined };
    const Probe = () => {
      const v = s.useSettings();
      shown = { density: v.density, setDensity: v.setDensity };
      return null;
    };
    const r = mr.render(R.createElement(s.SettingsProvider, null, R.createElement(Probe)));
    await s.loadedCredentials();
    // 저장소 읽기(가짜 — 바로 끝남)가 끝난 뒤 한 번 더 기다렸다 그린다
    await new Promise((res) => setTimeout(res, 0));
    r.rerender();
    return { r, get: () => shown };
  }

  it("저장소 '촘촘' → dense", async () => {
    h.store.set("settings.density", "dense");
    const { get } = await open(true);
    expect(get().density).toBe("dense");
  });

  it.each([[null], ["xyz"], ["basic"]])("저장값 %s → basic", async (v) => {
    if (v !== null) h.store.set("settings.density", v);
    const { get } = await open(true);
    expect(get().density).toBe("basic");
  });

  it("setDensity('dense') → 저장소에 적히고, 앱을 다시 켜도 dense", async () => {
    const { r, get } = await open(true);
    expect(get().density).toBe("basic");
    await get().setDensity("dense");
    r.rerender();
    expect(get().density).toBe("dense");
    expect(h.store.get("settings.density")).toBe("dense");
    // 다시 켜기: 모듈 상태·화면 상태는 새로, 저장소는 그대로
    const again = await open(true);
    expect(again.get().density).toBe("dense");
    // 기본으로 되돌리기도 저장
    await again.get().setDensity("basic");
    expect(h.store.get("settings.density")).toBe("basic");
    expect((await open(true)).get().density).toBe("basic");
  });

  it("densityOf: 'dense' 만 촘촘, 그 밖(기본·없음·모르는 값)은 기본", async () => {
    const { densityOf, DENSITY_OPTIONS, STORAGE_KEYS } = await real();
    expect(densityOf("dense")).toBe("dense");
    for (const v of ["basic", null, undefined, "x", ""]) expect(densityOf(v)).toBe("basic");
    expect(DENSITY_OPTIONS).toEqual([
      { value: "basic", label: "기본" },
      { value: "dense", label: "촘촘" },
    ]);
    expect(STORAGE_KEYS.density).toBe("settings.density");
  });
});
