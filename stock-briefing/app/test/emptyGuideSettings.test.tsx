import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 설정 탭 3-24.
 *  - emptyGuide: '설정 열기'(주소 검색어 open=server&at=…)로 오면 '서버 연결' 칸을 펼치고 그 칸까지 스크롤. 누를 때마다(at) 다시.
 *    서버에 연결되지 않아 알림·토스 칸이 비면 까닭 + '서버 연결 열기' 버튼 하나. 서버 칸 오류 글도 칸 이름으로
 *  - oneHand: 표시 칸에 '누를 때 진동' 스위치 (저장), firstRun: 정보 칸에 '처음 사용 안내 다시 보기'
 *  - 모두 꺼져 있으면 지금 그대로
 */
const h = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  health: { data: undefined as unknown, isError: false, error: null as unknown },
  scrollTo: vi.fn(),
  push: vi.fn(),
  setHaptics: vi.fn(async () => undefined),
  haptics: true,
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
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.4.0" } } }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push }, useLocalSearchParams: () => h.params }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  THEME_OPTIONS: [{ value: "dark", label: "다크" }],
  WIDGET_ROW_OPTIONS: [],
  useSettings: () => ({ apiUrl: "http://wrong", apiToken: "", showKrw: false, afterCost: true, sort: "created", themeMode: "dark", widgetRowCurrency: "krw", haptics: h.haptics, setHaptics: h.setHaptics, setCredentials: vi.fn() }),
}));
vi.mock("@/api/hooks", () => ({
  useHealth: () => ({ ...h.health, isFetching: false, refetch: async () => undefined }),
  useNotificationSettings: () => ({ data: undefined, refetch: async () => undefined }),
  useFeature: (_k: string, fallback = false) => fallback,
}));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/WidgetRefreshStatus", () => ({ WidgetRefreshStatus: "WidgetRefreshStatus" }));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  // 받은 스크롤 ref 에 가짜 scrollTo 를 단다 ('서버 연결' 칸까지 스크롤하는지 본다)
  const Screen = ({ children, scrollRef }: { children: React.ReactNode; scrollRef?: { current: unknown } }) => {
    if (scrollRef) scrollRef.current = { scrollTo: h.scrollTo };
    return R.createElement("Screen", { hasScrollRef: !!scrollRef }, children);
  };
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", Row: "Row", RowWrapContext: React.createContext(false), SectionTitle: "SectionTitle", Toggle: "Toggle" }));

const { default: SettingsScreen } = await import("@/app/(tabs)/settings");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { ApiRequestError } = await import("@/api/client");

beforeEach(() => {
  h.params = {};
  h.health = { data: { ok: true, time: "2026-09-27T01:00:00Z", sources: {} }, isError: false, error: null };
  h.scrollTo.mockReset();
  h.push.mockReset();
  h.setHaptics.mockClear();
  h.haptics = true;
});

const draw = (flags: Partial<{ oneHand: boolean; firstRun: boolean; emptyGuide: boolean; connectionGuide: boolean }> = {}) =>
  render(
    <UxFlagsContext.Provider value={{ oneHand: false, firstRun: false, emptyGuide: false, ...flags, connectionGuide: flags.connectionGuide ?? !!flags.emptyGuide }}>
      <SettingsScreen />
    </UxFlagsContext.Provider>,
  );
const connectBox = (r: ReturnType<typeof render>): HostNode => {
  // '서버 연결' 칸을 감싼 틀 (자리 재기) — 칸의 펼침 버튼을 품은 View
  const box = r.all().find((n) => n.type === "View" && typeof n.props.onLayout === "function" && JSON.stringify(n.children).includes("서버 연결"));
  if (!box) throw new Error("서버 연결 틀 없음");
  return box;
};
const layout = (n: HostNode, y: number, height = 60) => (n.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y, width: 475, height } } });

describe("'설정 열기'로 오면 '서버 연결' 칸을 펼치고 그 칸까지 스크롤", () => {
  it("펼침 → 칸 자리를 알려 오면 스크롤 (칸 위 8dp)", () => {
    h.params = { open: "server", at: "1" };
    const r = draw({ emptyGuide: true });
    expect(r.has("서버 주소")).toBe(true);
    expect(r.has("API 토큰")).toBe(true);
    expect(r.byLabel("서버 연결").props.accessibilityState).toEqual({ expanded: true });
    layout(connectBox(r), 900, 260);
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 892, animated: true });
  });

  it("사용자가 접은 뒤 다른 화면에서 또 누르면(새 at) 다시 펼친다. 같은 요청으로 다시 그려지면 그대로", () => {
    h.params = { open: "server", at: "1" };
    const r = draw({ emptyGuide: true });
    layout(connectBox(r), 900, 260);
    r.act(() => (r.byLabel("서버 연결").props.onPress as () => void)());
    expect(r.has("서버 주소")).toBe(false);
    r.rerender();
    expect(r.has("서버 주소")).toBe(false);
    h.params = { open: "server", at: "2" };
    r.rerender();
    expect(r.has("서버 주소")).toBe(true);
  });

  it("플래그가 꺼져 있으면 검색어를 보지 않고(접힌 채), 칸을 감싸지 않는다", () => {
    h.params = { open: "server", at: "1" };
    const r = draw({});
    expect(r.has("서버 주소")).toBe(false);
    expect(r.all().find((n) => n.type === "Screen")!.props.hasScrollRef).toBe(false);
    expect(() => connectBox(r)).toThrow();
  });
});

describe("서버에 연결되지 않으면 알림·토스 빈 칸 안내 + 버튼 하나", () => {
  it("연결 실패: 서버 칸은 칸 이름 문구, 빈 칸 안내의 '서버 연결 열기' 한 번에 펼침", () => {
    h.health = { data: undefined, isError: true, error: new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://wrong") };
    const r = draw({ emptyGuide: true });
    expect(r.text()).toContain("서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요. 계속되면 설정 > 서버 연결에서 '서버 주소'를 확인하세요.");
    expect(r.text()).toContain("알림 · 토스증권 연동");
    const gapCard = r.all().find((n) => n.type === "Card" && JSON.stringify(n.children).includes("알림 · 토스증권 연동"))!;
    const btns = gapCard.children.filter((c): c is HostNode => typeof c !== "string" && c.type === "Button");
    expect(btns.map((b) => b.props.title)).toEqual(["서버 연결 열기"]);
    layout(connectBox(r), 700);
    r.act(() => (btns[0]!.props.onPress as () => void)());
    expect(r.has("서버 주소")).toBe(true);
    layout(connectBox(r), 700, 300);
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 692, animated: true });
  });

  it("토큰 없음(제한된 응답)도 같은 안내, 연결되면 없음, 꺼져 있으면 예전 글", () => {
    h.health = { data: { ok: true, limited: true }, isError: false, error: null };
    const r = draw({ emptyGuide: true });
    expect(r.text()).toContain("'API 토큰'이 없거나 맞지 않습니다. 아래 '서버 연결'에서 'API 토큰'을 확인하세요.");
    expect(r.text()).toContain("알림 · 토스증권 연동");
    expect(draw({}).text()).toContain("서버에 연결됐지만 토큰이 없거나 맞지 않습니다. 아래 서버 연결에서 토큰을 입력하세요.");
    expect(draw({}).text()).not.toContain("알림 · 토스증권 연동");
    h.health = { data: { ok: true, time: "2026-09-27T01:00:00Z", sources: {} }, isError: false, error: null };
    expect(draw({ emptyGuide: true }).text()).not.toContain("알림 · 토스증권 연동");
  });
});

describe("oneHand · firstRun 설정 항목", () => {
  it("'누를 때 진동' 스위치 (켬 기본, 끄면 저장)", () => {
    expect(draw({}).has("누를 때 진동")).toBe(false);
    const r = draw({ oneHand: true });
    const sw = r.byLabel("누를 때 진동");
    expect(sw.props.value).toBe(true);
    (sw.props.onValueChange as (v: boolean) => void)(false);
    expect(h.setHaptics).toHaveBeenCalledWith(false);
  });

  it("'처음 사용 안내 다시 보기' → 안내 화면", () => {
    const has = (r: ReturnType<typeof render>) => r.all().some((n) => n.type === "Button" && n.props.title === "처음 사용 안내 다시 보기");
    expect(has(draw({}))).toBe(false);
    const r = draw({ firstRun: true });
    const btn = r.all().find((n) => n.type === "Button" && n.props.title === "처음 사용 안내 다시 보기")!;
    (btn.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/welcome");
  });
});
