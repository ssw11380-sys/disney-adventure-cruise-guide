import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import { condGet, condKey, condReset } from "@/api/condCache";
import type { Analysis } from "@/api/types";
import { useStockMutations } from "@/api/hooks";
import { AuthBridge } from "@/components/AuthBridge";
import { analysisRecoveryFor } from "@/lib/analysisRecovery";
import { clearSession, handleSessionInvalid, installSessionStorage, onAccountChange, resetSessionForTests, saveSession, sessionFor, updateSessionUser, type StoredSession } from "@/lib/session";
import { logout, setBeforeLogout, setPushRebind } from "@/lib/logout";
import { carryBriefingsIntoPayload, clearWidgetAccountData, loadCachedWidgetData, loadWidgetData, saveLastStocks, signedOutWidgetData } from "@/widgets/data";
import { resetWidgetsForAccountChange } from "@/widgets/redraw";
import type { RegisteredWithQuote } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

// 네트워크·기기 저장소만 가짜로 바꾼다. API/세션/캐시/위젯/실제 훅과 QueryClient는 제품 모듈을 쓴다.
const h = vi.hoisted(() => ({ store: new Map<string, string>(), beforeSet: null as null | ((key: string) => Promise<void>), failRemove: false, infoWait: null as Promise<void> | null, renderWait: null as Promise<void> | null, draws: [] as unknown[] }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://boundary.test" } } } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("@/lib/settings", async (original) => ({ ...await original<typeof import("@/lib/settings")>(), useSettings: () => ({ apiUrl: "https://boundary.test", apiToken: "", ready: true }) }));
vi.mock("@/lib/authGate", () => ({ useAccountsFlag: () => true }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false }), withLastTick: (x: unknown) => x }));
vi.mock("react-native-android-widget", () => ({
  getWidgetInfo: async () => { if (h.infoWait) await h.infoWait; return [{ widgetId: 1, width: 300, height: 180 }]; },
  requestWidgetUpdateById: async (o: { renderWidget: (info: unknown) => Promise<unknown> }) => { const rendered = await o.renderWidget({ widgetId: 1, width: 300, height: 180 }); h.draws.push(rendered); },
}));
vi.mock("@/widgets/render", () => ({ renderFor: async (_name: string, data: unknown) => { if (h.renderWait) await h.renderWait; return data; } }));
vi.mock("@/widgets/widgets", () => ({ WIDGET_NAMES: { holdings: "Holdings", asset: "Asset", briefing: "Briefing", market: "Market" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => h.store.get(key) ?? null,
  setItem: async (key: string, value: string) => { if (h.beforeSet) await h.beforeSet(key); h.store.set(key, value); },
  removeItem: async (key: string) => { if (h.failRemove && key.startsWith("widget.")) throw new Error("가짜 삭제 실패"); h.store.delete(key); },
  multiGet: async (keys: string[]) => keys.map((key) => [key, h.store.get(key) ?? null]),
  multiSet: async (pairs: [string, string][]) => void pairs.forEach(([key, value]) => h.store.set(key, value)),
} }));

const API = "https://boundary.test";
const CODE = "005930";
const user = (id: number) => ({ id, loginId: `가짜사용자${id}`, email: null, isOwner: id === 1, usingInitialPassword: false });
const session = (id: number): StoredSession => ({ apiUrl: API, token: `offline-test-session-${id}`, remember: true, user: user(id), savedAt: 1 });
const analysis = (): Analysis => ({ id: 1, code: CODE, kind: "company", content: "이전 계정에서 시작한 분석", model: "fake", createdAt: "2026-12-28T08:30:00+09:00", missing: [], cached: false });
const key = [API, "analysis", CODE, "company"];
const json = (value: unknown, status = 200, etag?: string) => new Response(JSON.stringify(value), { status, headers: etag ? { etag } : {} });
function seedPersonal(kind: "lastStocks" | "view" | "payload", apiUrl = API, accountUserId: number | undefined = 1) {
  const owner = accountUserId === undefined ? {} : { accountUserId };
  const row = { code: "OLD", quantity: 123 };
  const value = kind === "lastStocks" ? { apiUrl, ...owner, at: Date.now(), stocks: [row] }
    : kind === "view" ? { apiUrl, ...owner, view: { ...signedOutWidgetData(), error: null, stocks: [row] } }
    : { apiUrl, ...owner, at: Date.now(), path: "/api/widget?indices=1&sessions=1&ui=2&ms=1", body: { v: 1, market: null, stocks: [{ c: "OLD", n: "가짜", qty: 123, avg: 100, q: null, e: null }], briefings: [] } };
  h.store.set(`widget.${kind}`, JSON.stringify(value));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const clients: QueryClient[] = [];
const stops: (() => void)[] = [];
function client() { const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } }); clients.push(qc); return qc; }
async function settle() { await vi.advanceTimersByTimeAsync(0); }
function attachBridge(qc: QueryClient, probe?: React.ReactElement) {
  return render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(React.Fragment, null, React.createElement(AuthBridge), probe)));
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00"));
  resetSessionForTests(); condReset(); h.store.clear(); h.beforeSet = null; h.failRemove = false; h.infoWait = null; h.renderWait = null; h.draws.length = 0;
  await clearWidgetAccountData();
  h.store.set("settings.apiUrl", API); h.store.set("settings.apiToken", " ");
  installSessionStorage({ getItem: async (key) => h.store.get(key) ?? null, setItem: async (key, value) => void h.store.set(key, value), removeItem: async (key) => void h.store.delete(key) });
  await saveSession(session(1));
});
afterEach(() => {
  cleanupRenders(); stops.splice(0).forEach((stop) => stop()); clients.splice(0).forEach((qc) => qc.clear());
  resetSessionForTests(); setBeforeLogout(null); setPushRebind(null); condReset();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("독립 재검증: 계정 경계와 늦은 응답", () => {
  it("이전 분석 갱신 성공은 계정 변경으로 비운 현재 캐시에 다시 들어오지 않아야 한다", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", (url: string) => url.endsWith("/api/auth/me") ? Promise.resolve(json({ user: sessionFor(API)!.user })) : response.promise);
    const qc = client();
    let actions!: ReturnType<typeof useStockMutations>;
    function Probe() { actions = useStockMutations(); return null; }
    attachBridge(qc, React.createElement(Probe)); await settle();
    const pending = actions.refreshAnalysis.mutateAsync({ code: CODE, kind: "company" }).catch(() => undefined);
    await settle();
    await clearSession("logout"); await saveSession(session(2)); await settle();
    expect(qc.getQueryData(key)).toBeUndefined();
    response.resolve(json(analysis())); await pending; await settle();
    expect(sessionFor(API)?.user.id).toBe(2);
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  it("반증: 일반 조회는 QueryClient.clear 뒤 늦은 성공이 캐시를 되살리지 않는다", async () => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", () => response.promise);
    const qc = client();
    const pending = qc.fetchQuery({ queryKey: key, queryFn: () => createApi(API).getAnalysis(CODE, "company") }).catch(() => undefined);
    await settle(); qc.clear(); await saveSession(session(2));
    response.resolve(json(analysis())); await pending; await settle();
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  it("반증: 새 분석 회수기는 계정이 바뀌면 늦은 성공을 현재 캐시에 쓰지 않는다", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", (url: string) => url.includes("/state") ? Promise.resolve(json({ latest: null, running: true })) : response.promise);
    const qc = client(); qc.setQueryData([API, "features"], { features: { analysisWaitRecovery: true } });
    const recovery = analysisRecoveryFor(qc, createApi(API), API, ""); stops.push(() => recovery.dispose());
    const pending = recovery.start(CODE, "company", true); await settle();
    await saveSession(session(2)); response.resolve(json(analysis())); await pending;
    expect(qc.getQueryData(key)).toBeUndefined();
  });

  it("이전 조건부 조회 성공은 계정 변경으로 지운 조건부 본문을 다시 저장하지 않아야 한다", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", (url: string) => url.endsWith("/api/auth/me") ? Promise.resolve(json({ user: sessionFor(API)!.user })) : response.promise);
    const qc = client(); attachBridge(qc); await settle();
    const pending = createApi(API, "", { saver: () => true }).listStocks().catch(() => undefined); await settle();
    await clearSession("logout"); await saveSession(session(2)); await settle();
    const cacheKey = condKey(API, "/api/stocks?quotes=1"); expect(condGet(cacheKey)).toBeNull();
    response.resolve(json([{ code: CODE, quantity: 123 }], 200, '"old-account"')); await pending;
    expect(condGet(cacheKey)).toBeNull();
  });

  it("진행 중 위젯 조회가 로그아웃 후 성공해도 이전 잔고를 반환하거나 기기에 다시 적지 않아야 한다", async () => {
    const response = deferred<Response>(); const sent = vi.fn(() => response.promise); vi.stubGlobal("fetch", sent);
    // 앱 루트가 계정 변경 때 실제로 연결하는 저장 데이터 비우기를 그대로 실행한다.
    stops.push(onAccountChange(() => { void clearWidgetAccountData(); }));
    const pending = loadWidgetData(); await settle(); expect(sent).toHaveBeenCalledTimes(1);
    await clearSession("logout"); await settle();
    expect(h.store.has("widget.lastStocks")).toBe(false);
    response.resolve(json({ v: 1, market: null, stocks: [{ c: CODE, n: "가짜 종목", qty: 123, avg: 100, q: [110, 10, 10, "KRW", "2026-12-28T08:30:00+09:00", null, 0], e: null }], briefings: [] }));
    const out = await pending;
    expect.soft(out.stocks).toEqual([]);
    expect.soft(h.store.has("widget.lastStocks")).toBe(false);
    expect.soft(h.store.has("widget.payload")).toBe(false);
  });

  it("이전 로그아웃의 늦은 성공이 그사이 다시 로그인한 새 세션을 지우지 않아야 한다", async () => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", () => response.promise);
    const pending = logout(createApi(API), API); await settle();
    // 다른 진행 중 요청의 session_invalid 때문에 로그인 화면으로 돌아간 뒤 재로그인한 경우.
    handleSessionInvalid(API, session(1).token); await saveSession(session(2));
    response.resolve(new Response(null, { status: 204 })); await pending;
    expect(sessionFor(API)?.token).toBe(session(2).token);
  });

  it("반증: 이전 일반 조회의 늦은 401은 다시 로그인한 새 세션을 지우지 않는다", async () => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", () => response.promise);
    const pending = createApi(API).me().catch(() => undefined); await settle();
    await saveSession(session(2)); response.resolve(json({ code: "session_invalid" }, 401)); await pending;
    expect(sessionFor(API)?.token).toBe(session(2).token);
  });

  it.each([200, 304])("같은 계정의 새 토큰으로 로그인한 뒤에는 옛 %s 응답도 성공 처리하지 않는다", async (status) => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", () => response.promise);
    const pending = createApi(API, "", { saver: () => true }).listStocks().then(() => null, (error: unknown) => error); await settle();
    await saveSession({ ...session(1), token: "offline-test-new-session" });
    response.resolve(status === 304 ? new Response(null, { status: 304 }) : json([], 200, '"old"'));
    expect(await pending).toMatchObject({ code: "SESSION_CHANGED" });
    expect(sessionFor(API)?.token).toBe("offline-test-new-session");
    expect(condGet(condKey(API, "/api/stocks?quotes=1"))).toBeNull();
  });

  it("사용자 이메일만 바뀌는 정상 진행은 세대 변경으로 취소하지 않는다", async () => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", () => response.promise);
    const pending = createApi(API).health(); await settle();
    await updateSessionUser(API, { ...user(1), email: "offline@example.test" });
    response.resolve(json({ status: "ok" }));
    expect(await pending).toEqual({ status: "ok" });
  });

  it("로그인 기능 이전의 세션 없는 정상 요청과 정상 로그아웃은 추가 시계 지연 없이 끝난다", async () => {
    await clearSession("logout");
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { sent.push(init); return url.endsWith("logout") ? new Response(null, { status: 204 }) : json({ ok: true }); });
    const started = Date.now(); expect(await createApi(API).health()).toEqual({ ok: true });
    expect(new Headers(sent[0]!.headers).get("x-session-token")).toBeNull();
    await saveSession(session(1)); await logout(createApi(API), API);
    expect(sessionFor(API)).toBeNull(); expect(Date.now()).toBe(started); expect(vi.getTimerCount()).toBe(0);
  });

  it("로그아웃 전 알림 해제 대기 중 재로그인하면 새 계정 로그아웃 요청을 보내지 않는다", async () => {
    const response = deferred<void>(); setBeforeLogout(() => response.promise);
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchFn);
    const pending = logout(createApi(API), API); await settle(); await saveSession(session(2));
    response.resolve(); await pending;
    expect(fetchFn).not.toHaveBeenCalled(); expect(sessionFor(API)?.user.id).toBe(2);
  });

  it("위젯의 옛 401은 새 세션과 그 계정의 저장 잔고를 지우지 않는다", async () => {
    const response = deferred<Response>(); vi.stubGlobal("fetch", () => response.promise);
    const pending = loadWidgetData(); await settle(); await saveSession(session(2));
    const saved = JSON.stringify({ at: Date.now(), apiUrl: API, stocks: [{ code: "NEW", quantity: 456 }] });
    h.store.set("widget.lastStocks", saved);
    response.resolve(json({ code: "session_invalid" }, 401));
    expect((await pending).stocks).toEqual([]);
    expect(sessionFor(API)?.user.id).toBe(2); expect(h.store.get("widget.lastStocks")).toBe(saved);
  });

  it("이미 시작한 옛 위젯 저장은 늦게 끝나도 로그아웃 지우기와 새 계정 저장보다 뒤로 가지 않는다", async () => {
    const held = deferred<void>(); let block = true;
    h.beforeSet = (key) => key === "widget.lastStocks" && block ? held.promise : Promise.resolve();
    const stock = (code: string) => [{ code }] as RegisteredWithQuote[];
    const oldWrite = saveLastStocks(stock("OLD"), Date.now(), API); await settle();
    let clearing: Promise<void> | undefined;
    stops.push(onAccountChange(() => { clearing = clearWidgetAccountData(); }));
    try {
      const started = Date.now(); await clearSession("logout");
      // 멈춘 개인 저장은 일반 요청·로그아웃 메모리 전환을 기다리게 하지 않는다.
      vi.stubGlobal("fetch", async () => json({ ok: true }));
      expect(await createApi(API).health()).toEqual({ ok: true }); expect(Date.now()).toBe(started);
      await saveSession(session(2)); const newWrite = saveLastStocks(stock("NEW"), Date.now(), API);
      block = false; held.resolve(); await Promise.all([oldWrite, clearing, newWrite]);
      expect(JSON.parse(h.store.get("widget.lastStocks")!).stocks).toEqual(stock("NEW"));
    } finally { block = false; held.resolve(); await oldWrite; }
  });

  it("개인 저장이 멈춰도 계정 변경 직후 캐시 읽기는 빈 값이며 OS 빈 위젯 요청은 기다리지 않는다", async () => {
    h.store.set("widget.lastStocks", JSON.stringify({ at: Date.now(), apiUrl: API, stocks: [{ code: "OLD", quantity: 123 }] }));
    const held = deferred<void>(); let block = true;
    h.beforeSet = (key) => key === "widget.lastStocks" && block ? held.promise : Promise.resolve();
    const pending = saveLastStocks([{ code: "OLDER" }] as RegisteredWithQuote[], Date.now(), API); await settle();
    stops.push(onAccountChange(resetWidgetsForAccountChange));
    try {
      await clearSession("logout"); await settle();
      expect((await loadCachedWidgetData()).stocks).toEqual([]);
      expect(h.draws).toHaveLength(4);
      expect(h.draws.every((data) => (data as { stocks: unknown[] }).stocks.length === 0)).toBe(true);
    } finally { block = false; held.resolve(); await pending; await settle(); }
    expect(h.store.has("widget.lastStocks")).toBe(false);
  });

  it.each(["위젯 정보 조회", "렌더"])("계정 변경의 빈 그림이 %s에서 늦어져도 다음 로그인 뒤에는 그리지 않는다", async (phase) => {
    const held = deferred<void>();
    if (phase === "위젯 정보 조회") h.infoWait = held.promise; else h.renderWait = held.promise;
    resetWidgetsForAccountChange(); await settle();
    await saveSession(session(2)); held.resolve(); await settle();
    expect(h.draws).toEqual([]); expect(sessionFor(API)?.user.id).toBe(2);
  });

  it("개인 저장 삭제가 실패해도 같은 실행에서 옛 잔고를 되살리지 않고 다음 정상 쓰기로 복구한다", async () => {
    h.store.set("widget.lastStocks", JSON.stringify({ at: Date.now(), apiUrl: API, stocks: [{ code: "OLD", quantity: 123 }] }));
    await clearSession("logout"); h.failRemove = true; await clearWidgetAccountData();
    try { expect((await loadCachedWidgetData()).stocks).toEqual([]); }
    finally { h.failRemove = false; }
    await saveSession(session(2));
    await saveLastStocks([{ code: "NEW" }] as RegisteredWithQuote[], Date.now(), API);
    expect((await loadCachedWidgetData()).stocks).toEqual([{ code: "NEW" }]);
  });

  it("개인 삭제 실패 뒤 다른 계정으로 로그인하고 앱을 다시 켜도 옛 디스크 잔고를 복원하지 않는다", async () => {
    await saveLastStocks([{ code: "OLD", quantity: 123 }] as RegisteredWithQuote[], Date.now(), API);
    await clearSession("logout"); h.failRemove = true; await clearWidgetAccountData();
    await saveSession(session(2)); h.failRemove = false;
    vi.resetModules();
    const freshSession = await import("@/lib/session");
    const freshData = await import("@/widgets/data");
    try {
      await freshSession.loadSession();
      expect(freshSession.sessionFor(API)?.user.id).toBe(2);
      expect((await freshData.loadCachedWidgetData()).stocks).toEqual([]);
    } finally { freshSession.resetSessionForTests(); }
  });

  it.each(["lastStocks", "view", "payload"] as const)("%s 개인 캐시는 같은 계정의 새 토큰은 허용하고 다른 계정·서버·메모리 세션은 거절한다", async (kind) => {
    seedPersonal(kind);
    await saveSession({ ...session(1), token: "offline-test-renewed" });
    expect((await loadCachedWidgetData()).stocks.map((stock) => stock.code)).toEqual(["OLD"]);
    await saveSession(session(2)); expect((await loadCachedWidgetData()).stocks).toEqual([]);
    await saveSession({ ...session(1), remember: false }); expect((await loadCachedWidgetData()).stocks).toEqual([]);
    await saveSession(session(1)); seedPersonal(kind, "https://another-boundary.test");
    expect((await loadCachedWidgetData()).stocks).toEqual([]);
  });

  it.each(["lastStocks", "view", "payload"] as const)("%s 소유자 없는 이전 형식은 로그인 상태에서 거절하고 무계정 서버에서는 그대로 읽는다", async (kind) => {
    seedPersonal(kind);
    const value = JSON.parse(h.store.get(`widget.${kind}`)!) as Record<string, unknown>; delete value.accountUserId;
    h.store.set(`widget.${kind}`, JSON.stringify(value));
    expect((await loadCachedWidgetData()).stocks).toEqual([]);
    resetSessionForTests(); h.store.delete("auth.session.v1"); h.store.delete("auth.device.v1");
    installSessionStorage({ getItem: async (key) => h.store.get(key) ?? null, setItem: async () => undefined, removeItem: async () => undefined });
    expect((await loadCachedWidgetData()).stocks.map((stock) => stock.code)).toEqual(["OLD"]);
  });

  it("저장 세션을 아직 읽기 전에는 소유자 없는 개인 캐시를 임의로 현재 계정에 연결하지 않는다", async () => {
    seedPersonal("lastStocks"); const held = deferred<void>(); resetSessionForTests();
    h.store.set("auth.session.v1", JSON.stringify(session(2)));
    installSessionStorage({ getItem: async (key) => { await held.promise; return h.store.get(key) ?? null; }, setItem: async () => undefined, removeItem: async () => undefined });
    let completed = false; const pending = loadCachedWidgetData().then((data) => { completed = true; return data; });
    await settle(); expect(completed).toBe(false); held.resolve();
    expect((await pending).stocks).toEqual([]); expect(sessionFor(API)?.user.id).toBe(2);
  });

  it("로그인 전 안내만 재사용할 때 옛 디스크의 개인 필드를 모두 버리고 빈 화면으로 재구성한다", async () => {
    seedPersonal("view");
    const saved = JSON.parse(h.store.get("widget.view")!);
    saved.view.error = "로그인 필요";
    saved.view.accountIds = [901]; saved.view.latestIds = [902]; saved.view.summary = { title: "옛 요약" };
    saved.view.board = [{ code: "OLD" }]; saved.view.filled = ["OLD"];
    h.store.set("widget.view", JSON.stringify(saved));
    await clearSession("logout");
    const blank = await loadCachedWidgetData();
    expect(blank.error).toBe("로그인 필요");
    expect(blank.stocks).toEqual([]); expect(blank.briefings).toEqual([]); expect(blank.filled).toEqual([]);
    expect(blank.accountIds).toBeUndefined(); expect(blank.latestIds).toBeUndefined(); expect(blank.summary).toBeUndefined();
    expect(blank.board).toBeNull(); expect(blank.indices).toBeNull(); expect(blank.market).toBeNull();
  });

  it("브리핑 전달도 payload 소유자를 유지하며 다른 계정의 기존 본문을 수정하지 않는다", async () => {
    seedPersonal("payload");
    await carryBriefingsIntoPayload([], Date.now());
    const own = h.store.get("widget.payload")!;
    expect(JSON.parse(own).accountUserId).toBe(1);
    expect(own).not.toContain(session(1).token);
    await saveSession(session(2)); await carryBriefingsIntoPayload([], Date.now() + 1);
    expect(h.store.get("widget.payload")).toBe(own);
  });
});
