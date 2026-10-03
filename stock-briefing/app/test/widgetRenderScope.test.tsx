import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
const h = vi.hoisted(() => ({ store: new Map<string, string>(), reads: [] as string[], duringPreferenceRead: null as null | (() => void), fetch: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://a.test" } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => { h.reads.push(key); if (key.startsWith("widget.preferences")) h.duringPreferenceRead?.(); return h.store.get(key) ?? null; },
  setItem: async (key: string, value: string) => { h.store.set(key, value); },
  removeItem: async (key: string) => { h.store.delete(key); },
  multiGet: async (keys: string[]) => keys.map((key) => [key, h.store.get(key) ?? null]),
} }));
vi.mock("react-native-android-widget", () => ({ FlexWidget: "FlexWidget", TextWidget: "TextWidget" }));
vi.mock("@/widgets/widgets", () => ({ HoldingsWidget: "Holdings", AssetWidget: "Asset", BriefingWidget: "Briefing", WIDGET_NAMES: { holdings: "Holdings", asset: "Asset", briefing: "Briefing", market: "Market" } }));
vi.mock("@/widgets/marketWidget", () => ({ MarketWidget: "Market" }));
vi.mock("@/widgets/sizeLog", () => ({ noteWidgetSize: vi.fn() }));
vi.mock("@/lib/widgetRefreshLog", () => ({ logWidgetRefresh: vi.fn() }));
const session = await import("@/lib/session");
const data = await import("@/widgets/data");
const { renderFor } = await import("@/widgets/render");
const { NO_FEATURES } = await import("@/widgets/payload");
const { default: storage } = await import("@react-native-async-storage/async-storage");
const NOW = Date.parse("2026-10-05T10:00:00+09:00");
const SERVER = "https://a.test";
const stock = { code: "AAPL", name: "기존 계정 종목", quantity: 2, averagePrice: 100, quote: null } as unknown as RegisteredWithQuote;
const box = { widgetId: 911, width: 420, height: 220 };
const opts = { fontScale: 1, now: NOW, pnlMode: "cumulative" as const };
const login = (id: number) => session.saveSession({ apiUrl: SERVER, token: `test-session-${id}`, remember: true, user: { id, loginId: `user${id}`, isOwner: true, email: null, usingInitialPassword: false } });
const push = (clarity = true) => data.pushWidgetData({ stocks: [stock], filled: [], showKrw: true, afterCost: true, fetchedAt: NOW, market: null, features: { at: NOW, flags: { ...NO_FEATURES, clarity } } });
beforeEach(async () => {
  h.store.clear(); h.reads = []; h.duringPreferenceRead = null; h.fetch.mockReset();
  h.store.set("settings.apiUrl", SERVER);
  session.resetSessionForTests(); session.installSessionStorage(storage); await login(1);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  h.fetch.mockImplementation(async () => new Response(JSON.stringify({ v: 1, stocks: [], briefings: [], features: { widgetClarity: true } }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("위젯 자료 출처: 조회 완료와 렌더 시작 사이의 계정·서버 전환", () => {
  it("서버 조회 결과는 받은 서버와 시작 계정을 보존하며 서버를 한 번만 조회한다", async () => {
    const result = await data.loadWidgetData();
    expect(result.error).toBeNull();
    expect(result.renderScope).toEqual({ apiUrl: SERVER, identity: session.sessionIdentityVersion() });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("앱 입력과 캐시 재조회는 숫자를 보존하고 현재 검증된 출처를 붙인다", async () => {
    const result = await push();
    expect(result.stocks).toEqual([stock]);
    expect(result.renderScope).toEqual({ apiUrl: SERVER, identity: session.sessionIdentityVersion() });
    const raw = JSON.parse(h.store.get("widget.view")!);
    expect(raw.view).not.toHaveProperty("renderScope");
    raw.view.renderScope = { apiUrl: "https://old-process.test", identity: -10 };
    h.store.set("widget.view", JSON.stringify(raw));
    const cached = await data.loadCachedWidgetData();
    expect(cached.stocks).toEqual([stock]);
    expect(cached.renderScope).toEqual(result.renderScope);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("화면 캐시가 없을 때 받은 응답 캐시에서도 현재 출처를 붙인다", async () => {
    await data.loadWidgetData();
    h.store.delete("widget.view"); h.fetch.mockClear();
    const cached = await data.loadCachedWidgetData();
    expect(cached.renderScope).toEqual({ apiUrl: SERVER, identity: session.sessionIdentityVersion() });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("자료를 받은 뒤 서버 B로 바뀌고 렌더가 늦게 시작해도 서버 A의 종목을 그리지 않는다", async () => {
    const previous = await push();
    h.store.set("settings.apiUrl", "https://b.test");
    await expect(renderFor("Holdings", previous, box, opts)).rejects.toThrow("서버가 바뀌었습니다");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("자료를 받은 뒤 다른 계정으로 바뀐 경우 렌더 시작 시점의 새 identity로 덮어쓰지 않는다", async () => {
    const previous = await push();
    await login(2);
    await expect(renderFor("Holdings", previous, box, opts)).rejects.toThrow("로그인 정보가 바뀌었습니다");
  });
  it("설정 읽기 중 서버가 바뀌고 저장소 오류까지 나도 이전 자료를 기본 설정으로 표시하지 않는다", async () => {
    const previous = await push();
    h.duringPreferenceRead = () => { h.store.set("settings.apiUrl", "https://b.test"); throw new Error("disk"); };
    await expect(renderFor("Holdings", previous, box, opts)).rejects.toThrow("서버가 바뀌었습니다");
  });
  it("정상 경로는 같은 종목을 두 테마에 표시하고 개별 설정을 한 번만 읽는다", async () => {
    const current = await push(); h.reads = [];
    const result = await renderFor("Holdings", current, box, opts);
    expect(result.light.props.stocks).toEqual([stock]); expect(result.dark.props.stocks).toEqual([stock]);
    expect(h.reads.filter((key) => key.startsWith("widget.preferences"))).toHaveLength(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("기능이 꺼진 데이터에는 새 필드를 추가하지 않고 기존 렌더 경로를 유지한다", async () => {
    const current = await push(false);
    expect(current).not.toHaveProperty("renderScope");
    h.store.set("settings.apiUrl", "https://b.test"); h.reads = [];
    const result = await renderFor("Holdings", current, box, opts);
    expect(result.light.props.stocks).toEqual([stock]);
    expect(h.reads).toEqual([]);
  });
});
