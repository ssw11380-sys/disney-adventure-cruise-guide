import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render, type HostNode } from "./miniRender";
const h = vi.hoisted(() => ({ enabled: true, member: false, identity: 1, params: { id: "102" }, save: vi.fn(), redraw: vi.fn(), cache: vi.fn(), list: vi.fn() }));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => h.params }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, Text: "Text", View: "View" }));
vi.mock("@/api/hooks", () => ({ useFeature: () => h.enabled }));
vi.mock("@/lib/account", () => ({ useAccountView: () => ({ member: h.member }), useSessionVersion: () => h.identity }));
vi.mock("@/lib/session", () => ({ sessionIdentityVersion: () => h.identity }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://a.test", apiToken: "" }) }));
vi.mock("@/theme", async () => ({ ...(await import("@/tokens")), useTheme: () => ({ ink: "#111111" }) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", SectionTitle: "SectionTitle", Toggle: "Toggle" }));
vi.mock("@/widgets/data", () => ({ loadCachedWidgetData: h.cache, readPnlMode: async () => "day" }));
vi.mock("@/widgets/fontScale", () => ({ fontScaleNow: () => 1 }));
vi.mock("@/widgets/render", () => ({ renderFor: async () => ({ light: {}, dark: {} }) }));
vi.mock("@/widgets/widgets", () => ({ WIDGET_NAMES: { holdings: "Holdings", asset: "Asset", market: "Market", briefing: "Briefing" } }));
vi.mock("@/widgets/preferences", () => ({
  defaultWidgetPreferences: () => ({ pnlMode: "cumulative", sort: "value", pinnedCodes: [], showMarketLine: false }),
  widgetPreferenceScope: async () => ({ apiUrl: "https://a.test", owner: 1, identity: h.identity }),
  assertWidgetPreferenceScope: async (s: { identity: number }) => { if (s.identity !== h.identity) throw new Error("changed"); },
  readWidgetPreferences: async () => ({ pnlMode: "day", sort: "value", pinnedCodes: [], showMarketLine: false }),
  saveWidgetPreferences: h.save,
}));
vi.mock("react-native-android-widget", () => ({ getWidgetInfo: h.list, requestWidgetUpdateById: h.redraw }));
const { default: WidgetSettingsScreen } = await import("@/app/widget-settings");
const words = (nodes: (HostNode | string)[]): string => nodes.map((node) => typeof node === "string" ? node : words(node.children)).join("");
const loaded = async (r: ReturnType<typeof render>) => { await vi.waitFor(() => { r.rerender(); expect(r.all().find((node) => node.props.title === "이 위젯에 적용")?.props.disabled).toBe(false); }); };
const apply = (r: ReturnType<typeof render>) => r.act(() => (r.all().find((node) => node.props.title === "이 위젯에 적용")!.props.onPress as () => void)());
beforeEach(() => {
  cleanupRenders(); vi.clearAllMocks(); h.enabled = true; h.member = false; h.identity = 1;
  h.save.mockResolvedValue(undefined);
  h.redraw.mockResolvedValue(undefined);
  h.cache.mockResolvedValue({ stocks: [{ code: "AAPL", name: "애플" }] });
  h.list.mockImplementation(async (name: string) => name === "Holdings" ? [101, 102].map((widgetId) => ({ widgetId, widgetName: name, width: 420, height: 240 })) : []);
});
describe("위젯 설정 화면", () => {
  it("설정 링크의 위젯을 선택하고 저장한 위젯 하나만 캐시로 다시 그린다", async () => {
    const r = render(<WidgetSettingsScreen />); await loaded(r);
    expect(r.all().filter((node) => node.type === "Chip" && node.props.active).some((node) => String(node.props.label).startsWith("내 종목 시세 2"))).toBe(true);
    r.act(() => (r.all().find((node) => node.props.label === "애플")!.props.onPress as () => void)());
    apply(r);
    await vi.waitFor(() => { r.rerender(); expect(words(r.tree)).toContain("이 위젯에 적용했습니다"); });
    expect(h.save).toHaveBeenCalledWith(102, expect.objectContaining({ pinnedCodes: ["AAPL"] }), expect.any(Object));
    expect(h.redraw).toHaveBeenCalledTimes(1);
    expect(h.redraw).toHaveBeenCalledWith(expect.objectContaining({ widgetId: 102, widgetName: "Holdings" }));
  });
  it("저장 실패 때 적용 성공을 표시하거나 위젯을 다시 그리지 않는다", async () => {
    h.save.mockRejectedValue(new Error("disk"));
    const r = render(<WidgetSettingsScreen />); await loaded(r); apply(r);
    await vi.waitFor(() => { r.rerender(); expect(words(r.tree)).toContain("저장 또는 화면 반영에 실패"); });
    expect(words(r.tree)).not.toContain("적용했습니다"); expect(h.redraw).not.toHaveBeenCalled();
  });
  it("그리기 실패는 저장 완료만으로 성공이라고 표시하지 않는다", async () => {
    h.redraw.mockRejectedValue(new Error("native unavailable"));
    const r = render(<WidgetSettingsScreen />); await loaded(r); apply(r);
    await vi.waitFor(() => { r.rerender(); expect(words(r.tree)).toContain("저장 또는 화면 반영에 실패"); });
    expect(words(r.tree)).not.toContain("적용했습니다");
  });
  it("기능 꺼짐·회원은 위젯 목록과 개인 캐시를 읽지 않는다", async () => {
    h.enabled = false; const r = render(<WidgetSettingsScreen />);
    await Promise.resolve(); expect(h.list).not.toHaveBeenCalled(); expect(h.cache).not.toHaveBeenCalled();
    h.enabled = true; h.member = true; r.rerender();
    await Promise.resolve(); expect(h.list).not.toHaveBeenCalled(); expect(words(r.tree)).toContain("사용할 수 없습니다");
  });
});
