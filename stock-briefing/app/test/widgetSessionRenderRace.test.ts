import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatestBriefing } from "@/api/types";
import type { WidgetData } from "@/widgets/data";

const h = vi.hoisted(() => ({
  identity: 1,
  beforeCallback: null as null | (() => void),
  rendered: [] as unknown[],
  draws: [] as string[],
  load: vi.fn(), push: vi.fn(), last: vi.fn(), save: vi.fn(), carry: vi.fn(), pnl: vi.fn(), render: vi.fn(), storedUrl: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@/lib/session", () => ({ sessionIdentityVersion: () => h.identity, assertSessionIdentity: (identity: number) => { if (identity !== h.identity) throw new Error("계정 전환"); } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: h.storedUrl } }));
vi.mock("@/lib/settings", () => ({ STORAGE_KEYS: { apiUrl: "apiUrl" }, defaultApiUrl: () => "https://server.test" }));
vi.mock("@/widgets/fontScale", () => ({ fontScaleNow: () => 1 }));
vi.mock("@/widgets/render", () => ({ renderFor: h.render }));
vi.mock("@/widgets/widgets", () => ({ WIDGET_NAMES: { holdings: "Holdings", asset: "Asset", briefing: "Briefing", market: "Market" } }));
vi.mock("@/widgets/data", () => ({ loadCachedWidgetData: h.load, pushWidgetData: h.push, withLastGood: h.last, saveWidgetView: h.save, carryBriefingsIntoPayload: h.carry, readPnlMode: h.pnl, readCachedPayload: async () => null, clearWidgetAccountData: vi.fn(), signedOutWidgetData: vi.fn() }));
vi.mock("react-native-android-widget", () => {
  const info = (widgetName: string) => ({ widgetName, widgetId: 17, width: 420, height: 220 });
  const draw = async ({ widgetName, renderWidget }: { widgetName: string; renderWidget: (value: unknown) => unknown }) => {
    h.beforeCallback?.();
    const rendered = await renderWidget(info(widgetName));
    h.rendered.push(rendered); h.draws.push(widgetName);
  };
  return { getWidgetInfo: async (name: string) => [info(name)], requestWidgetUpdate: draw, requestWidgetUpdateById: draw };
});

const { refreshWidgets, refreshBriefingWidget } = await import("@/widgets/refresh");
const { redrawAllWidgets } = await import("@/widgets/redraw");
const data = { stocks: [{ code: "AAPL" }], briefings: [], features: { polish: true }, fetchedAt: 10, error: null } as unknown as WidgetData;
const app = { at: 20, list: [{ code: "AAPL", name: "이전 계정 종목", latest: { id: 1, status: "ok", createdAt: "2026-10-05T00:00:00Z", summary: "이전 계정 보고서" } }] as unknown as LatestBriefing[] };
const refresh = () => refreshWidgets({ stocks: data.stocks, showKrw: true, afterCost: true, appBriefings: app });

beforeEach(() => {
  vi.resetAllMocks(); h.identity = 1; h.beforeCallback = null; h.rendered = []; h.draws = [];
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-05T10:00:00+09:00"));
  h.load.mockResolvedValue(data); h.push.mockResolvedValue(data); h.last.mockResolvedValue({ stocks: data.stocks, filled: [] });
  h.pnl.mockResolvedValue("cumulative"); h.render.mockImplementation(async (_name, value) => value);
  h.storedUrl.mockResolvedValue("https://server.test");
});
afterEach(() => vi.restoreAllMocks());

describe("위젯 계정 경계: 이전 데이터를 새 로그인 그림에 반환하지 않는다", () => {
  it("전체 다시 그리기에서 손익 설정을 읽는 동안 바뀐 계정은 렌더 전에 중단한다", async () => {
    h.pnl.mockImplementationOnce(async () => { h.identity++; return "cumulative"; });
    await redrawAllWidgets(data);
    expect(h.rendered).toEqual([]);
  });
  it("네이티브 위젯 콜백이 늦게 시작하면 이전 계정 데이터로 그리지 않는다", async () => {
    h.beforeCallback = () => { h.identity++; };
    await redrawAllWidgets(data);
    expect(h.render).not.toHaveBeenCalled();
    expect(h.rendered).toEqual([]);
  });
  it("렌더 중 계정이 바뀌어도 완성된 이전 그림과 오류 그림을 모두 반환하지 않는다", async () => {
    h.render.mockImplementation(async () => { h.identity++; return data; });
    await redrawAllWidgets(data);
    expect(h.rendered).toEqual([]);
  });
  it("앱 잔고의 마지막 정상 시세를 읽는 중 계정이 바뀌면 이전 입력을 새 계정 캐시에 쓰지 않는다", async () => {
    h.last.mockImplementationOnce(async () => { h.identity++; return { stocks: data.stocks, filled: [] }; });
    await refresh();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.rendered).toEqual([]);
  });
  it("앱 잔고를 넘긴 뒤 계정이 바뀌면 후속 브리핑 저장과 렌더를 중단한다", async () => {
    h.push.mockImplementationOnce(async () => { h.identity++; return data; });
    await refresh();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.carry).not.toHaveBeenCalled();
    expect(h.rendered).toEqual([]);
  });
  it("브리핑의 첫 캐시 조회 중 계정이 바뀌면 이전 앱 보고서를 붙이지 않는다", async () => {
    h.load.mockImplementationOnce(async () => { h.identity++; return data; });
    await refreshBriefingWidget(app);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.carry).not.toHaveBeenCalled();
    expect(h.rendered).toEqual([]);
  });
  it("브리핑 저장 직전 서버 주소를 읽는 중 계정이 바뀌면 저장하지 않는다", async () => {
    h.storedUrl.mockImplementationOnce(async () => { h.identity++; return "https://other.test"; });
    await refreshBriefingWidget(app);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.rendered).toEqual([]);
  });
  it("앱 즉시 갱신의 지연된 위젯 콜백도 시작 계정을 보존한다", async () => {
    h.beforeCallback = () => { h.identity++; };
    await refresh();
    expect(h.rendered).toEqual([]);
  });
  it("브리핑 갱신의 지연된 위젯 콜백도 시작 계정을 보존한다", async () => {
    h.beforeCallback = () => { h.identity++; };
    await refreshBriefingWidget(app);
    expect(h.rendered).toEqual([]);
  });
  it("정상 계정에서는 같은 자료로 네 종류를 각각 한 번 그리고 재조회하지 않는다", async () => {
    await redrawAllWidgets(data);
    expect(h.draws.sort()).toEqual(["Asset", "Briefing", "Holdings", "Market"]);
    expect(h.rendered).toEqual([data, data, data, data]);
    expect(h.load).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });
  it("정상 앱 브리핑 저장은 시작 계정 경계를 넘기며 기존 자료·보고서를 보존한다", async () => {
    await refreshBriefingWidget(app);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ stocks: data.stocks, briefings: expect.arrayContaining([expect.objectContaining({ code: "AAPL" })]) }), "https://server.test", 1);
    expect(h.draws).toEqual(["Briefing"]);
  });
});
