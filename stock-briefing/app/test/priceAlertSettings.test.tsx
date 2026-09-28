import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceAlertRule } from "@/api/types";
import { render, type HostNode } from "./miniRender";

/**
 * 설정 화면의 가격 알림 (3-29, 플래그 priceAlerts): 표시 > '누를 때 진동' 줄의 조건·설명과 '가격 알림' 칸.
 * 설정 화면은 문맥(PriceAlertContext)만 읽는다 — 제공자가 없으면(플래그 꺼짐) 지금 화면과 한 글자도 같다 (oneHand 가 켜져 있어도)
 */
const h = vi.hoisted(() => ({
  health: { data: { ok: true, time: "2026-12-08T01:00:00Z", sources: {} } as unknown, isError: false, error: null as unknown },
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
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() }, useLocalSearchParams: () => ({}) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-12-08T10:12:05+09:00") }));
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  THEME_OPTIONS: [{ value: "dark", label: "다크" }],
  WIDGET_ROW_OPTIONS: [],
  useSettings: () => ({ apiUrl: "http://server", apiToken: "", showKrw: false, afterCost: true, sort: "created", themeMode: "dark", widgetRowCurrency: "krw", haptics: true, setHaptics: vi.fn(), setCredentials: vi.fn() }),
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
  return { Screen: ({ children }: { children: React.ReactNode }) => R.createElement("Screen", null, children) };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", Row: "Row", RowWrapContext: React.createContext(false), SectionTitle: "SectionTitle", Toggle: "Toggle" }));

const { default: SettingsScreen } = await import("@/app/(tabs)/settings");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { PriceAlertContext } = await import("@/lib/priceAlertContext");

const HAPTIC_NOTE = "줄 밀기·길게 누르기·정렬·관심 추가·당겨서 새로고침·차트 십자선. 차트 십자선 말고는 휴대폰의 '터치 진동'이 켜져 있어야 울립니다";
const rules: PriceAlertRule[] = [{ id: 1, code: "005930", kind: "priceAbove", value: 88_600, currency: "KRW", createdAt: "x", firedOn: null, firedAt: null, firedValue: null, registered: true }];

const draw = (o: { oneHand?: boolean; alerts?: boolean }) => {
  const ux = { oneHand: o.oneHand ?? false, firstRun: false, emptyGuide: false, connectionGuide: false, flagsMissing: false };
  const screen = (
    <UxFlagsContext.Provider value={ux}>
      <SettingsScreen />
    </UxFlagsContext.Provider>
  );
  return render(o.alerts ? <PriceAlertContext.Provider value={{ on: true, rules, openSheet: vi.fn(), remove: vi.fn(async () => undefined), nameOf: () => "삼성전자" }}>{screen}</PriceAlertContext.Provider> : screen);
};
const nodeText = (n: HostNode): string => n.children.map((c) => (typeof c === "string" ? c : nodeText(c))).join("");
/** '누를 때 진동' 줄의 설명 글 (없으면 null) */
const hapticNote = (r: ReturnType<typeof render>) => {
  if (!r.has("누를 때 진동")) return null;
  const line = r.all().find((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.type === "Toggle" && c.props.accessibilityLabel === "누를 때 진동"))!;
  return nodeText(line.children.find((c): c is HostNode => typeof c !== "string" && c.type === "View")!.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Muted")!);
};
const typesInOrder = (r: ReturnType<typeof render>) => r.all().filter((n) => ["NotificationSettingsCard", "Card", "TossOpenApiCard"].includes(n.type)).map((n) => (n.type === "Card" ? (n.children.find((c): c is HostNode => typeof c !== "string" && c.type === "SectionTitle") ? nodeText(n.children.find((c): c is HostNode => typeof c !== "string" && c.type === "SectionTitle")!) : "Card") : n.type));

beforeEach(() => {
  h.health = { data: { ok: true, time: "2026-12-08T01:00:00Z", sources: {} }, isError: false, error: null };
});

describe("설정 > 표시 '누를 때 진동' (가격 알림 진동도 이 스위치를 따름)", () => {
  it("제공자 없음(꺼짐): oneHand 가 꺼져 있으면 줄 없음, 켜져 있으면 지금 글 한 글자도 다르지 않음", () => {
    expect(hapticNote(draw({}))).toBeNull();
    expect(hapticNote(draw({ oneHand: true }))).toBe(HAPTIC_NOTE);
  });

  it("켬 + oneHand 켬: 지금 글 + ' · 가격 알림 진동도 이 스위치를 따릅니다'", () => {
    expect(hapticNote(draw({ oneHand: true, alerts: true }))).toBe(`${HAPTIC_NOTE} · 가격 알림 진동도 이 스위치를 따릅니다`);
  });

  it("켬 + oneHand 끔: 줄이 보이고 설명은 '가격 알림이 울릴 때 진동'", () => {
    expect(hapticNote(draw({ alerts: true }))).toBe("가격 알림이 울릴 때 진동");
  });
});

describe("설정 '가격 알림' 칸", () => {
  it("서버에 연결됐고 켜져 있으면 알림 칸 바로 아래, 토스 칸 앞", () => {
    const r = draw({ alerts: true });
    expect(r.text()).toContain("삼성전자 · 88,600원 이상");
    const order = typesInOrder(r);
    const i = order.indexOf("가격 알림");
    expect(order[i - 1]).toBe("NotificationSettingsCard");
    expect(order[i + 1]).toBe("TossOpenApiCard");
  });

  it("꺼짐(제공자 없음)이거나 서버에 연결되지 않았으면 칸 없음", () => {
    expect(draw({}).text()).not.toContain("앱을 켜 둔 동안만 확인합니다");
    h.health = { data: undefined, isError: true, error: new Error("x") };
    expect(draw({ alerts: true }).text()).not.toContain("앱을 켜 둔 동안만 확인합니다");
  });

  it("제공자 없음과 문맥 꺼짐 값은 같은 화면 (글자·요소 수)", () => {
    const a = draw({ oneHand: true });
    const b = render(
      <PriceAlertContext.Provider value={{ on: false, rules, openSheet: vi.fn(), remove: vi.fn(async () => undefined), nameOf: (c: string) => c }}>
        <UxFlagsContext.Provider value={{ oneHand: true, firstRun: false, emptyGuide: false, connectionGuide: false, flagsMissing: false }}>
          <SettingsScreen />
        </UxFlagsContext.Provider>
      </PriceAlertContext.Provider>,
    );
    expect(b.text()).toBe(a.text());
    expect(b.all().length).toBe(a.all().length);
  });
});
