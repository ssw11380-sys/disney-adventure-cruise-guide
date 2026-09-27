import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";
import { tradeRecordsLabel } from "@/lib/tradeRecords";
import type { TradeRecordsHealth } from "@/api/types";

/**
 * 매매 기록 기반 (3-36, 플래그 tradeRecords) — 앱은 설정 > 서버 '매매 기록' 한 줄만 (읽기만).
 *  - 서버 /health 의 tradeRecords(서버 플래그가 켜져 있을 때만 옴)로 '9/28부터 N거래일 저장', 최근 5거래일 빠진 날이 있으면 뒤에 붙임
 *  - 앱 플래그가 꺼져 있거나(fallback 꺼짐) 예전 서버라 값이 없으면 줄이 없다 — 지금 화면 그대로
 */

const status = (over: Partial<TradeRecordsHealth> = {}): TradeRecordsHealth => ({ toss: true, since: "2026-09-28", days: 3, missing5: [], warning: null, trades: { count: 4 }, ...over });

describe("매매 기록 줄 글 (tradeRecordsLabel)", () => {
  it("기록이 있으면 시작일과 저장한 거래일 수", () => {
    expect(tradeRecordsLabel(status())).toBe("9/28부터 3거래일 저장");
  });

  it("최근 5거래일 중 빠진 날이 있으면 뒤에 붙인다 (한국·미국 같은 날은 하루로)", () => {
    expect(
      tradeRecordsLabel(
        status({
          missing5: [
            { market: "KR", date: "2026-09-30" },
            { market: "US", date: "2026-09-30" },
            { market: "KR", date: "2026-09-29" },
          ],
        }),
      ),
    ).toBe("9/28부터 3거래일 저장 · 최근 5거래일 중 2일 빠짐");
  });

  it("아직 기록 전이면 토스 연동에 따라 안내, 값이 없거나 모양이 다르면 null (줄 없음)", () => {
    expect(tradeRecordsLabel(status({ since: null, days: 0 }))).toBe("첫 기록은 다음 장 마감 뒤");
    expect(tradeRecordsLabel(status({ since: null, days: 0, toss: false }))).toBe("토스 연동 뒤 시작");
    expect(tradeRecordsLabel(null)).toBeNull();
    expect(tradeRecordsLabel(undefined)).toBeNull();
    expect(tradeRecordsLabel({ toss: true } as unknown as TradeRecordsHealth)).toBeNull();
  });
});

const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  health: { data: undefined as unknown, isError: false, error: null as unknown },
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
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  THEME_OPTIONS: [{ value: "dark", label: "다크" }],
  WIDGET_ROW_OPTIONS: [],
  useSettings: () => ({ apiUrl: "http://server", apiToken: "", showKrw: false, afterCost: true, sort: "created", themeMode: "dark", widgetRowCurrency: "krw", haptics: true, setHaptics: vi.fn(), setCredentials: vi.fn() }),
}));
vi.mock("@/api/hooks", () => ({
  useHealth: () => ({ ...h.health, isFetching: false, refetch: async () => undefined }),
  useNotificationSettings: () => ({ data: undefined, refetch: async () => undefined }),
  useFeature: (k: string, fallback = false) => (k in h.flags ? h.flags[k] : fallback),
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

const rowLabels = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "Row").map((n) => n.props.label);
const recordRow = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "Row" && n.props.label === "매매 기록");

beforeEach(() => {
  h.flags = {};
  h.health = { data: { ok: true, time: "2026-09-30T08:00:00Z", sources: {}, tradeRecords: status({ missing5: [{ market: "KR", date: "2026-09-29" }] }) }, isError: false, error: null };
});

describe("설정 > 서버 '매매 기록' 줄 (플래그 tradeRecords)", () => {
  it("플래그를 켜면 서버 상태로 한 줄 (앱 오류 줄 앞)", () => {
    h.flags = { tradeRecords: true };
    const r = render(<SettingsScreen />);
    expect(recordRow(r)?.props.value).toBe("9/28부터 3거래일 저장 · 최근 5거래일 중 1일 빠짐");
    const labels = rowLabels(r);
    expect(labels[labels.indexOf("매매 기록") - 1]).toBe("브리핑 모델");
  });

  it("앱 플래그를 못 받았거나(fallback 꺼짐) 꺼져 있으면 서버가 값을 줘도 줄이 없다 — 예전 화면 그대로", () => {
    const off = render(<SettingsScreen />);
    expect(recordRow(off)).toBeUndefined();
    h.flags = { tradeRecords: false };
    const r = render(<SettingsScreen />);
    expect(recordRow(r)).toBeUndefined();
    expect(rowLabels(r)).toEqual(rowLabels(off));
  });

  it("켜져 있어도 예전 서버·서버 플래그 꺼짐(값 없음)이면 줄이 없다", () => {
    h.flags = { tradeRecords: true };
    h.health = { data: { ok: true, time: "2026-09-30T08:00:00Z", sources: {} }, isError: false, error: null };
    expect(recordRow(render(<SettingsScreen />))).toBeUndefined();
  });
});
