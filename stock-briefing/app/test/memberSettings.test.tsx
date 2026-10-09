import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 계정 A단계 검증 4차: 주인 아닌 계정의 설정 화면 — 주인만 쓰는 줄(잔고·위젯·매매 기록·스트림·첫 실행 안내)을 숨기고,
 * 알림 설정 조회(개인 경로 — 서버는 403)를 하지 않는다. 주인·계정 전은 지금 그대로
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | undefined>,
  density: "basic" as string,
  setDensity: vi.fn(async () => undefined),
  /** 가짜 기기 저장소 — 모듈을 새로 불러도(앱 다시 켜기) 남는다 */
  store: new Map<string, string>(),
  notifyArgs: [] as unknown[],
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
  useHealth: () => ({ data: { ok: true, time: "2026-09-28T01:00:00Z", sources: {}, tradeRecords: { enabled: true, ok: true, days: 5, lastDate: "2026-09-26", missing: [], warning: null } }, isError: false, error: null, isFetching: false, refetch: async () => undefined }),
  useNotificationSettings: (on: unknown) => {
    h.notifyArgs.push(on);
    return { data: undefined, refetch: async () => undefined };
  },
  useApi: () => ({ logout: async () => undefined }),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
}));
vi.mock("@/lib/uxFlags", async (orig) => ({ ...(await orig<typeof import("@/lib/uxFlags")>()), useUx: () => ({ oneHand: false, firstRun: true, emptyGuide: false, connectionGuide: false, flagsMissing: false }) }));
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

const session = await import("@/lib/session");

const MEMBER = { id: 7, loginId: "newbie", email: "n@example.com", isOwner: false, usingInitialPassword: false };
const OWNER = { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false };
/** 주인만 쓰는 줄 (잔고·위젯·매매 기록·실시간 스트림·첫 실행 안내) */
const OWNER_ONLY = ["수수료·세금 차감 평가", "잔고 정렬", "잔고 표시", "홈 화면 위젯 갱신", "위젯 종목 금액", "매매 기록", "앱 스트리밍", "처음 사용 안내 다시 보기"];
const ALL_FLAGS = { accounts: true, densityMode: true, widgetPolish: true, tradeRecords: true, firstRun: true, maCustom: true, chartHighLow: true };

beforeEach(() => {
  h.flags = {};
  h.notifyArgs = [];
  session.resetSessionForTests();
});

const shown = (r: ReturnType<typeof render>) => {
  const t = r.text();
  const rows = r.all().filter((n) => n.type === "Row").map((n) => String(n.props.label));
  const titles = r.all().filter((n) => n.type === "Button").map((n) => String(n.props.title));
  return (label: string) => t.includes(label) || rows.includes(label) || titles.includes(label);
};

describe("설정: 주인 아닌 계정", () => {
  it("토스 계좌 구분이 켜지면 원본과 추정 평가를 안내하고 꺼지면 기존 설명을 보존한다", () => {
    h.flags = { ...ALL_FLAGS, tossAccountSnapshot: true };
    const r = render(<SettingsScreen />);
    expect(r.text()).toContain("앱 표시 환율로 환산한 참고 금액입니다.");
    expect(r.text()).toContain("토스 계좌는 차감 후 제공값, 실시간 평가는 비용 정보가 있는 종목의 예상 비용을 반영합니다.");
    expect(r.text()).not.toContain("토스 앱과 같은 평가금액·손익");
    h.flags.tossAccountSnapshot = false;
    r.rerender();
    expect(r.text()).toContain("토스증권 적용 환율 기준");
    expect(r.text()).toContain("토스 앱과 같은 평가금액·손익 (토스 연동 종목)");
  });

  it("주인만 쓰는 줄이 없고 알림 설정을 묻지 않는다 — 화면·해외 원화·차트 줄·계정 칸·서버 칸은 그대로", async () => {
    h.flags = ALL_FLAGS;
    await session.saveSession({ apiUrl: "https://prod.test", token: "gzs1_m", remember: true, user: MEMBER });
    const r = render(<SettingsScreen />);
    const has = shown(r);
    for (const label of OWNER_ONLY) expect(has(label), label).toBe(false);
    for (const label of ["화면", "해외주식 원화 표시", "차트 이동평균선", "차트 최고·최저가 표시", "계정", "서버 시각"]) expect(has(label), label).toBe(true);
    expect(h.notifyArgs.length).toBeGreaterThan(0);
    expect(h.notifyArgs.every((a) => a === false)).toBe(true);
    expect(r.all().some((n) => n.type === "NotificationSettingsCard" || n.type === "TossOpenApiCard")).toBe(false);
  });

  it("주인(세션)·계정 전(세션 없음)은 지금 그대로: 모든 줄과 알림 설정 조회", async () => {
    h.flags = ALL_FLAGS;
    for (const user of [OWNER, null]) {
      session.resetSessionForTests();
      h.notifyArgs = [];
      if (user) await session.saveSession({ apiUrl: "https://prod.test", token: "gzs1_o", remember: true, user });
      const r = render(<SettingsScreen />);
      const has = shown(r);
      for (const label of OWNER_ONLY) expect(has(label), `${user?.loginId ?? "없음"} ${label}`).toBe(true);
      expect(h.notifyArgs.at(-1)).toBe(true);
    }
  });
});
