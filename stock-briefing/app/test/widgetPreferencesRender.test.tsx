import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetData } from "@/widgets/data";
const h = vi.hoisted(() => ({ identity: 1, clarity: true, prefs: { pnlMode: "day", sort: "name", pinnedCodes: ["AAPL"], showMarketLine: false }, read: vi.fn(), globalPnl: vi.fn(), saves: vi.fn(), deletes: vi.fn(), network: vi.fn(), redraw: vi.fn() }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null } }));
vi.mock("@/lib/settings", () => ({ defaultApiUrl: () => "https://a.test", STORAGE_KEYS: { apiUrl: "settings.apiUrl" } }));
vi.mock("react-native-android-widget", () => ({ FlexWidget: "FlexWidget", TextWidget: "TextWidget", getWidgetInfo: async () => [{ widgetId: 11, widgetName: "Holdings", width: 420, height: 240 }], requestWidgetUpdateById: h.redraw }));
vi.mock("@/lib/session", () => ({ sessionIdentityVersion: () => h.identity, assertSessionIdentity: (value: number) => { if (value !== h.identity) throw new Error("session changed"); } }));
vi.mock("@/widgets/preferences", () => ({ WidgetPreferenceScopeError: class extends Error {}, defaultWidgetPreferences: (pnlMode: string) => ({ pnlMode, sort: "value", pinnedCodes: [], showMarketLine: false }), readWidgetPreferences: h.read,
  updateWidgetPreferences: async (id: number, change: (value: typeof h.prefs) => typeof h.prefs, _fallback: unknown, scope: unknown) => { const next = change(h.prefs); await h.saves(id, next, scope); h.read.mockResolvedValue(next); return next; },
  deleteWidgetPreferences: h.deletes, widgetPreferenceScope: async () => ({ identity: h.identity }) }));
vi.mock("@/widgets/widgets", () => ({ HoldingsWidget: "Holdings", AssetWidget: "Asset", BriefingWidget: "Briefing", WIDGET_NAMES: { holdings: "Holdings", asset: "Asset", briefing: "Briefing", market: "Market" }, WIDGET_CLICK: { refresh: "REFRESH", pnlToggle: "PNL_TOGGLE" } }));
vi.mock("@/widgets/marketWidget", () => ({ MarketWidget: "Market" }));
vi.mock("@/widgets/sizeLog", () => ({ noteWidgetSize: vi.fn(), forgetWidgetSize: vi.fn() }));
vi.mock("@/widgets/fontScale", () => ({ fontScaleNow: () => 1 }));
vi.mock("@/widgets/redraw", () => ({ redrawAllWidgets: vi.fn() }));
vi.mock("@/lib/widgetRefreshLog", () => ({ logWidgetRefresh: vi.fn() }));
vi.mock("@/widgets/data", () => ({ readPnlMode: h.globalPnl, setPnlMode: vi.fn(), togglePnlMode: vi.fn(), loadWidgetData: h.network, loadCachedWidgetData: async () => ({ stocks: [], briefings: [], features: { clarity: h.clarity, pnlToggle: true }, error: null }) }));
const { renderFor } = await import("@/widgets/render");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { WidgetPreferenceScopeError } = await import("@/widgets/preferences");
const box = { widgetId: 10, width: 420, height: 240 };
const options = { now: 0, fontScale: 1, pnlMode: "cumulative" as const };
const data = (clarity: boolean) => ({ stocks: [], briefings: [], features: { clarity, indexLine: true }, error: null }) as unknown as WidgetData;
beforeEach(() => { vi.clearAllMocks(); h.identity = 1; h.clarity = true; h.read.mockResolvedValue(h.prefs); h.globalPnl.mockResolvedValue("cumulative"); h.saves.mockResolvedValue(undefined); h.deletes.mockResolvedValue(undefined); h.redraw.mockResolvedValue(undefined); });
describe("개별 위젯 설정 연결", () => {
  it("설정은 한 번만 읽고 라이트·다크에 같은 손익·순서·시장줄 선택을 사용한다", async () => {
    const rendered = await renderFor("Holdings", data(true), box, options);
    expect(h.read).toHaveBeenCalledTimes(1);
    for (const result of [rendered.light, rendered.dark]) expect(result.props).toMatchObject({ pnlMode: "day", indexLine: false, order: { sort: "name", pinnedCodes: ["AAPL"] }, clarity: true, widgetId: 10 });
  });
  it("기능을 끄면 개별 설정을 읽지 않고 기존 공통 설정과 시장줄을 그대로 사용한다", async () => {
    const rendered = await renderFor("Holdings", data(false), box, options);
    expect(h.read).not.toHaveBeenCalled();
    expect(rendered.light.props).toMatchObject({ pnlMode: "cumulative", indexLine: true });
    expect(rendered.light.props).not.toHaveProperty("clarity");
  });
  it("읽기 실패는 개인 고정 종목을 제거하지만 계정 전환은 이전 데이터 렌더까지 거부한다", async () => {
    h.read.mockRejectedValueOnce(new Error("disk"));
    const safe = await renderFor("Holdings", data(true), box, options);
    expect(safe.light.props).toMatchObject({ order: { pinnedCodes: [] } });
    h.read.mockImplementationOnce(async () => { h.identity++; throw new Error("changed"); });
    await expect(renderFor("Holdings", data(true), box, options)).rejects.toThrow("session changed");
  });
  it("서버 전환 오류는 일반 설정 읽기 실패와 구분해 이전 서버 데이터 렌더를 거부한다", async () => {
    h.read.mockRejectedValueOnce(new WidgetPreferenceScopeError("server changed"));
    await expect(renderFor("Holdings", data(true), box, options)).rejects.toThrow("server changed");
  });
  it("손익 클릭은 누른 위젯만 저장·재그림하고 서버 조회나 다른 위젯 갱신을 하지 않는다", async () => {
    const renderWidget = vi.fn();
    await widgetTaskHandler({ widgetInfo: { ...box, widgetName: "Holdings" }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: { mode: "day" }, renderWidget } as never);
    expect(h.saves).toHaveBeenCalledWith(10, expect.objectContaining({ pnlMode: "cumulative" }), expect.any(Object));
    expect(renderWidget).toHaveBeenCalledTimes(1);
    expect(h.network).not.toHaveBeenCalled(); expect(h.redraw).not.toHaveBeenCalled();
  });
  it("손익 설정을 읽는 동안 계정이 바뀌면 새 계정에 저장하거나 이전 잔고를 그리지 않는다", async () => {
    h.globalPnl.mockImplementationOnce(async () => { h.identity++; return "cumulative"; });
    const renderWidget = vi.fn();
    await widgetTaskHandler({ widgetInfo: { ...box, widgetName: "Holdings" }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: { mode: "day" }, renderWidget } as never);
    expect(h.saves).not.toHaveBeenCalled(); expect(renderWidget).not.toHaveBeenCalled();
    expect(h.redraw).not.toHaveBeenCalled(); expect(h.network).not.toHaveBeenCalled();
  });
  it("기존 공통 손익 갱신의 지연된 다른 위젯 콜백도 계정이 바뀌면 이전 잔고를 거부한다", async () => {
    h.clarity = false;
    const drawn = vi.fn();
    h.redraw.mockImplementationOnce(async ({ renderWidget: deferred }) => {
      h.identity++;
      drawn(await deferred({ ...box, widgetId: 11, widgetName: "Holdings" }));
    });
    const renderWidget = vi.fn();
    await widgetTaskHandler({ widgetInfo: { ...box, widgetName: "Holdings" }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: { mode: "day" }, renderWidget } as never);
    expect(renderWidget).toHaveBeenCalledTimes(1);
    expect(h.redraw).toHaveBeenCalledTimes(1);
    expect(drawn).not.toHaveBeenCalled();
  });
  it("위젯 삭제는 해당 위젯 설정만 정리한다", async () => {
    await widgetTaskHandler({ widgetInfo: { ...box, widgetName: "Holdings" }, widgetAction: "WIDGET_DELETED", renderWidget: vi.fn() } as never);
    expect(h.deletes).toHaveBeenCalledWith(10); expect(h.network).not.toHaveBeenCalled();
  });
});
