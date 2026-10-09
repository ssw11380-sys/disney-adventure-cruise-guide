import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";
import { holding, quote } from "./helpers";

const h = vi.hoisted(() => ({ wide: false, emptyGuide: true, stocks: {} as Record<string, unknown>, stock: {} as Record<string, unknown>, candles: {} as Record<string, unknown>, refetch: vi.fn() }));
const NOW = Date.parse("2026-10-04T11:00:00+09:00");
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", StyleSheet: { create: <T,>(x: T) => x, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: h.wide ? 933 : 475, height: h.wide ? 704 : 751, fontScale: 1 }), Platform: { OS: "android" } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { push: vi.fn(), back: vi.fn(), dismissTo: vi.fn(), canGoBack: () => false }, useLocalSearchParams: () => ({ code: "005930", period: "D" }) }));
vi.mock("@/api/hooks", () => ({ useFeature: (key: string) => key === "allocationView" || key === "tossAccountSnapshot", useStocks: () => h.stocks, useStock: () => h.stock, useCandles: () => h.candles }));
vi.mock("@/lib/account", () => ({ MEMBER_EMPTY_ALLOCATION: {}, useAccountView: () => ({ member: false }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ afterCost: false }) }));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => undefined }));
vi.mock("@/lib/uxFlags", () => ({ useUx: () => ({ emptyGuide: h.emptyGuide }) }));
vi.mock("@/lib/useFoldLayout", () => ({ useFoldLayout: () => ({ on: h.wide, width: h.wide ? "expanded" : "compact" }) }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, connectedAt: null, lastTickAt: null }) }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/lib/pollSaver", () => ({ resetPollBackoff: vi.fn() }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-10-04T11:00:00+09:00") }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/components/Screen", () => ({ Screen: ({ top, children, ...props }: { top?: React.ReactNode; children?: React.ReactNode }) => React.createElement("Screen", props, top, children) }));
vi.mock("@/components/ui", () => ({ Button: "Button", Empty: "Empty", ErrorView: "ErrorView", Loading: "Loading", ChangeText: "ChangeText" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/AllocationCard", () => ({ AllocationCard: "AllocationCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));

const { default: AllocationScreen } = await import("@/app/portfolio/allocation");
const { default: ChartScreen } = await import("@/app/stocks/[code]/chart");
const samsung = holding("005930", quote("005930", 72000), 10, 70000, undefined, "삼성전자");
const state = (data: unknown) => ({ data, isError: false, isLoading: false, error: null, fetchStatus: "idle", dataUpdatedAt: NOW - 60_000, errorUpdatedAt: 0, refetch: h.refetch });
beforeEach(() => { h.wide = false; h.emptyGuide = true; h.refetch.mockReset(); h.refetch.mockResolvedValue(undefined); h.stocks = state([samsung]); h.stock = state(samsung); h.candles = state({ candles: [{ close: 72000 }] }); });

describe("비중·전체 차트 사용자 흐름 감사", () => {
  it.each([false, true])("비중 재조회 실패 시 이전 금액·차트를 유지하며 기준 시각과 연결 실패를 알린다 (넓은 화면 %s)", (wide) => {
    h.wide = wide;
    const r = render(<AllocationScreen />);
    expect(r.text()).toContain("720,000");
    expect(r.text()).not.toContain("연결 끊김");
    h.stocks = { ...h.stocks, isError: true, error: new Error("network") };
    r.rerender();
    expect(r.text()).toContain("연결 끊김");
    expect(r.text()).toContain("10:59:00 기준");
    expect(r.text()).toContain("720,000");
    expect(r.all().filter((n) => n.type === "AllocationCard")).toHaveLength(4);
    expect(h.refetch).not.toHaveBeenCalled();
  });
  it.each([false, true])("비중 설명은 앱 시세와 토스 계좌의 범위·가격 차이를 명시한다 (넓은 화면 %s)", (wide) => {
    h.wide = wide;
    const r = render(<AllocationScreen />);
    expect(r.text()).toContain("앱 시세 기준");
    expect(r.text()).toContain("토스 계좌 평가와 범위·금액이 다를 수 있습니다");
    expect(r.text()).not.toContain("잔고 탭 총 평가금액과 같은 기준");
  });
  it.each([false, true])("보유는 있으나 시세가 없어 계산할 수 없으면 보유 없음으로 표시하지 않는다 (안내 기능 %s)", (guide) => {
    h.emptyGuide = guide;
    h.stocks = state([{ ...samsung, quote: null, evaluation: null }]);
    const empty = render(<AllocationScreen />).all().find((n) => n.type === "Empty")!;
    expect(empty.props.title).toBe("비중을 계산할 수 없습니다");
    expect(empty.props.hint).toContain("시세 없는 1종목 제외");
  });
  it("관심만 있는 빈 잔고는 여전히 보유 없음으로 안내한다", () => {
    h.stocks = state([holding("005930", quote("005930", 72000), null, null)]);
    expect(render(<AllocationScreen />).all().find((n) => n.type === "Empty")?.props.title).toBe("보유 종목이 없습니다");
  });
  it("비중 최초 조회 실패는 이전 금액 없이 오류 화면으로 유지한다", () => {
    h.stocks = { ...state(undefined), isError: true, error: new Error("network") };
    const r = render(<AllocationScreen />);
    expect(r.all().some((n) => n.type === "ErrorView")).toBe(true);
    expect(r.all().some((n) => n.type === "AllocationCard")).toBe(false);
  });
  it.each(["failed", "paused"])("봉 조회는 정상이고 현재가만 %s 상태면 이전 현재가의 연결 상태를 따로 알린다", (failure) => {
    const r = render(<ChartScreen />);
    h.stock = { ...h.stock, isError: failure === "failed", fetchStatus: failure === "paused" ? "paused" : "idle" };
    r.rerender();
    expect(r.text()).toContain("연결 끊김");
    expect(r.text()).toContain("10:59:00 기준");
    expect(r.text()).toContain("72,000원");
    expect(r.all().find((n) => n.type === "CandleChart")?.props.candles).toEqual([{ close: 72000 }]);
    expect(h.refetch).not.toHaveBeenCalled();
  });
});
