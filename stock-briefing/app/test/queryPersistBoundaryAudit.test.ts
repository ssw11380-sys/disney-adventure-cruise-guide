import React from "react";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import type { StoredSession } from "@/lib/session";

const API = "https://cache-boundary.test";
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  readWait: null as Promise<void> | null,
  writeWait: null as Promise<void> | null,
  sessionWait: null as Promise<void> | null,
  sessionFails: false,
  removeFails: false,
  removeWait: null as Promise<void> | null,
  removeCalls: 0,
  cacheFails: false,
  qc: null as QueryClient | null,
  api: { me: () => new Promise<never>(() => undefined) },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => {
    const value = h.store.get(key) ?? null;
    if (key === "rq.cache" && h.readWait) await h.readWait;
    if (key === "rq.cache" && h.cacheFails) throw new Error("offline cache read failure");
    if (key === "auth.session.v1") { if (h.sessionWait) await h.sessionWait; if (h.sessionFails) throw new Error("offline session read failure"); }
    return value;
  },
  setItem: async (key: string, value: string) => { if (key === "rq.cache" && h.writeWait) await h.writeWait; h.store.set(key, value); },
  removeItem: async (key: string) => {
    if (key === "rq.cache") { h.removeCalls++; if (h.removeWait) await h.removeWait; if (h.removeFails) throw new Error("offline storage failure"); }
    h.store.delete(key);
  },
} }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQueryClient: () => h.qc! }));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("@/api/hooks", () => ({ useApi: () => h.api }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://cache-boundary.test", ready: true }) }));
vi.mock("@/lib/authGate", () => ({ useAccountsFlag: () => true }));

const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; return { promise: new Promise<void>((r, no) => { resolve = r; reject = no; }), resolve: () => resolve(), reject: () => reject(new Error("offline delayed read failure")) }; };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const session = (id: number): StoredSession => ({ apiUrl: API, token: `offline-test-session-${id}`, remember: true, savedAt: 1, user: { id, loginId: `offline-${id}`, email: null, isOwner: id === 1, usingInitialPassword: false } });
let sessions: typeof import("@/lib/session");
let persisted: typeof import("@/lib/queryPersist");
let qc: QueryClient;

function stored(quantity = 123): PersistedClient {
  const source = new QueryClient();
  source.setQueryData([API, "stocks"], [{ code: "OLD", quantity }]);
  source.setQueryData([API, "indices"], [{ code: "KOSPI", value: 2000 }]);
  source.setQueryData([API, "features"], { features: { marketSummary: true } });
  const client = { timestamp: Date.now(), buster: persisted.PERSIST_BUSTER, clientState: dehydrate(source) };
  source.clear();
  return client;
}
const restore = () => persistQueryClientRestore({ queryClient: qc, persister: persisted.queryPersister, buster: persisted.PERSIST_BUSTER, maxAge: persisted.PERSIST_MAX_AGE_MS });

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00"));
  h.store.clear(); h.readWait = null; h.writeWait = null; h.sessionWait = null; h.sessionFails = false; h.removeFails = false;
  h.removeWait = null; h.removeCalls = 0; h.cacheFails = false;
  sessions = await import("@/lib/session"); persisted = await import("@/lib/queryPersist");
  sessions.resetSessionForTests();
  const { default: storage } = await import("@react-native-async-storage/async-storage");
  sessions.installSessionStorage(storage); await sessions.saveSession(session(1));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); h.qc = qc;
});
afterEach(() => { cleanupRenders(); qc.clear(); sessions.resetSessionForTests(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("계정 경계에서 기기 쿼리 캐시 복원", () => {
  it("정상 같은 계정 재실행에서는 마지막 잔고와 공개 지수를 복원한다", async () => {
    await persisted.queryPersister.persistClient(stored());
    await restore();
    expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 123 }]);
    expect(qc.getQueryData([API, "indices"])).toEqual([{ code: "KOSPI", value: 2000 }]);
  });

  it("기존 복원 읽기가 늦게 끝나도 AuthBridge가 새 계정용으로 비운 캐시를 다시 채우지 않는다", async () => {
    await persisted.queryPersister.persistClient(stored());
    const { AuthBridge } = await import("@/components/AuthBridge"); render(React.createElement(AuthBridge)); await settle();
    const held = deferred(); h.readWait = held.promise;
    const pending = restore(); await settle();
    await sessions.saveSession(session(2));
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    held.resolve(); await pending;
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
  });

  it("삭제 실패 후 다른 계정 로그인과 모듈 재시작을 거쳐도 옛 잔고를 복원하지 않는다", async () => {
    await persisted.queryPersister.persistClient(stored()); h.removeFails = true;
    // AuthBridge와 같은 삭제 요청이다. 테스트는 의도한 저장소 오류만 회수한다.
    await Promise.resolve(persisted.queryPersister.removeClient()).catch(() => undefined);
    await sessions.saveSession(session(2)); h.removeFails = false;
    vi.resetModules();
    sessions = await import("@/lib/session"); persisted = await import("@/lib/queryPersist");
    const { default: storage } = await import("@react-native-async-storage/async-storage");
    sessions.installSessionStorage(storage); await sessions.loadSession();
    expect(sessions.sessionFor(API)?.user.id).toBe(2);
    await restore();
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    expect(qc.getQueryData([API, "indices"])).toEqual([{ code: "KOSPI", value: 2000 }]);
  });

  it("이미 시작한 옛 디스크 쓰기가 계정 변경의 삭제보다 늦게 끝나도 다음 복원에 옛 잔고를 넣지 않는다", async () => {
    const held = deferred(); h.writeWait = held.promise;
    const pending = Promise.resolve(persisted.queryPersister.persistClient(stored())); await settle();
    await sessions.saveSession(session(2)); await persisted.queryPersister.removeClient();
    held.resolve(); await pending; h.writeWait = null;
    await restore();
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
  });

  it("10초 저장 대기 중 계정이 바뀌면 옛 스냅샷을 새 계정 소유로 승격하여 저장하지 않는다", async () => {
    await persisted.queryPersister.persistClient(stored());
    await vi.advanceTimersByTimeAsync(1_000);
    const pending = Promise.resolve(persisted.queryPersister.persistClient(stored())); await settle();
    await sessions.saveSession(session(2)); await persisted.queryPersister.removeClient();
    await vi.advanceTimersByTimeAsync(9_000); await pending;
    await restore();
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
  });

  it("설치된 라이브러리가 restore Promise를 받은 뒤 hydrate할 때까지의 microtask 틈도 계정 변경을 검사한다", async () => {
    await persisted.queryPersister.persistClient(stored());
    await persistQueryClientRestore({ queryClient: qc, buster: persisted.PERSIST_BUSTER, persister: {
      ...persisted.queryPersister,
      restoreClient: () => {
        const returning = Promise.resolve(persisted.queryPersister.restoreClient());
        // 라이브러리의 await continuation보다 먼저 이미 예약된 계정 변경을 실행한다.
        void returning.then(() => sessions.saveSession(session(2)));
        return returning;
      },
    } });
    await settle();
    expect(sessions.sessionFor(API)?.user.id).toBe(2);
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
  });

  it("정상 첫 저장·복원은 시계 지연이 없고 이후 저장의 기존 10초 간격을 그대로 유지한다", async () => {
    const started = Date.now(); await persisted.queryPersister.persistClient(stored()); await restore();
    expect(Date.now()).toBe(started); expect(vi.getTimerCount()).toBe(0);
    const pending = Promise.resolve(persisted.queryPersister.persistClient(stored(456)));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(JSON.parse(h.store.get("rq.cache")!).clientState.queries[0].state.data[0].quantity).toBe(123);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(JSON.parse(h.store.get("rq.cache")!).clientState.queries[0].state.data[0].quantity).toBe(456);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("같은 사용자 새 토큰은 정상 복원하며 저장값에 토큰을 추가하지 않고 공개 기능 판독과 호환된다", async () => {
    await persisted.queryPersister.persistClient(stored());
    const raw = h.store.get("rq.cache")!;
    expect(raw).not.toContain(session(1).token);
    await sessions.saveSession({ ...session(1), token: "offline-renewed-session" });
    await restore(); expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 123 }]);
    const plain = JSON.parse(JSON.stringify(await persisted.queryPersister.restoreClient())) as PersistedClient;
    expect(persisted.cleanForDisk(plain).clientState.queries).toHaveLength(3);
    const { persistedFeatureOn } = await import("@/lib/marketSummaryLoad");
    expect(persistedFeatureOn(raw, API, "marketSummary")).toBe(true);
  });

  it("자동 로그인 끈 계정은 개인 캐시 저장과 복원을 거절하고 공개 지수는 보존한다", async () => {
    await sessions.saveSession({ ...session(1), remember: false });
    await persisted.queryPersister.persistClient(stored()); await restore();
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    expect(qc.getQueryData([API, "indices"])).toEqual([{ code: "KOSPI", value: 2000 }]);
  });

  it("로그인 상태에서는 소유자 없는 이전 형식의 개인 값을 승격하지 않고 무계정 서버만 그대로 복원한다", async () => {
    h.store.set("rq.cache", JSON.stringify(stored())); await restore();
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    sessions.resetSessionForTests(); h.store.delete("auth.session.v1"); h.store.delete("auth.device.v1");
    const { default: storage } = await import("@react-native-async-storage/async-storage"); sessions.installSessionStorage(storage);
    await restore(); expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 123 }]);
  });

  it("세션 읽기가 늦을 때는 먼저 개인 캐시를 복원하지 않고 같은 계정 확인 뒤에 복원한다", async () => {
    await persisted.queryPersister.persistClient(stored());
    sessions.resetSessionForTests(); const { default: storage } = await import("@react-native-async-storage/async-storage"); sessions.installSessionStorage(storage);
    const held = deferred(); h.sessionWait = held.promise;
    let done = false; const pending = restore().then(() => { done = true; }); await settle();
    expect(done).toBe(false); expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    held.resolve(); await pending;
    expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 123 }]);
  });

  it("세션 읽기 실패는 무계정으로 오인하지 않고 개인 값만 거절한다", async () => {
    await persisted.queryPersister.persistClient(stored());
    sessions.resetSessionForTests(); const { default: storage } = await import("@react-native-async-storage/async-storage"); sessions.installSessionStorage(storage); h.sessionFails = true;
    await restore(); expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    expect(qc.getQueryData([API, "indices"])).toEqual([{ code: "KOSPI", value: 2000 }]); expect(vi.getTimerCount()).toBe(0);
  });

  it("삭제 실패도 오류를 퍼뜨리지 않으며 새 정상 쓰기가 끝나면 현재 계정 캐시를 다시 복원한다", async () => {
    await persisted.queryPersister.persistClient(stored()); h.removeFails = true;
    await expect(Promise.resolve(persisted.queryPersister.removeClient())).resolves.toBeUndefined();
    await restore(); expect(qc.getQueryData([API, "stocks"])).toBeUndefined();
    h.removeFails = false;
    const pending = Promise.resolve(persisted.queryPersister.persistClient(stored(456)));
    await vi.advanceTimersByTimeAsync(10_000); await pending; await restore();
    expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 456 }]);
  });

  it("기기 캐시 읽기가 끝나지 않아도 기존 세션 읽기와 같은 8초 후 복원을 마쳐 조회 재개를 허용한다", async () => {
    await persisted.queryPersister.persistClient(stored());
    const held = deferred(); h.readWait = held.promise;
    const deletion = deferred(); h.removeWait = deletion.promise;
    let done = false; const fetchCurrent = vi.fn(async () => [{ code: "CURRENT", quantity: 1 }]);
    const pending = restore().then(async () => {
      done = true;
      await qc.fetchQuery({ queryKey: [API, "stocks"], queryFn: fetchCurrent });
    });
    try {
      await vi.advanceTimersByTimeAsync(7_999); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(done).toBe(true); expect(fetchCurrent).toHaveBeenCalledTimes(1);
    } finally { held.resolve(); deletion.resolve(); await pending; }
    expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "CURRENT", quantity: 1 }]);
    expect(h.removeCalls).toBe(0); expect(vi.getTimerCount()).toBe(0);
    h.readWait = null; qc.clear(); await restore();
    expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 123 }]);
  });

  it("읽기 기한 뒤 늦은 저장소 거절을 회수하며 다음 정상 복원을 막지 않는다", async () => {
    await persisted.queryPersister.persistClient(stored()); const held = deferred(); h.readWait = held.promise;
    const pending = restore(); await vi.advanceTimersByTimeAsync(sessions.SESSION_READ_TIMEOUT_MS); await pending;
    held.reject(); await settle();
    expect(qc.getQueryData([API, "stocks"])).toBeUndefined(); expect(h.removeCalls).toBe(0); expect(vi.getTimerCount()).toBe(0);
    h.readWait = null; await restore(); expect(qc.getQueryData([API, "stocks"])).toEqual([{ code: "OLD", quantity: 123 }]);
  });

  it("캐시 읽기 오류도 삭제가 끝나기를 기다리지 않고 즉시 복원을 마친다", async () => {
    const deletion = deferred(); h.removeWait = deletion.promise; h.cacheFails = true;
    const started = Date.now();
    try { await restore(); }
    finally { deletion.resolve(); }
    expect(Date.now()).toBe(started); expect(h.removeCalls).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["만료", "형식 불일치"])("%s 캐시의 SDK 삭제가 멈춰도 기존 8초 정책 뒤 복원을 끝낸다", async (reason) => {
    const old = stored();
    if (reason === "만료") old.timestamp -= persisted.PERSIST_MAX_AGE_MS + 1; else old.buster = "offline-old-format";
    await persisted.queryPersister.persistClient(old);
    const held = deferred(); h.removeWait = held.promise;
    let done = false; const pending = restore().then(() => { done = true; });
    try {
      await vi.advanceTimersByTimeAsync(7_999); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(done).toBe(true);
      expect(qc.getQueryData([API, "stocks"])).toBeUndefined(); expect(h.removeCalls).toBe(1); expect(vi.getTimerCount()).toBe(0);
    } finally { held.resolve(); await pending; }
  });

  it("삭제 기한 뒤 늦은 거절은 회수하고 실패한 디스크의 개인 캐시를 다시 허용하지 않는다", async () => {
    await persisted.queryPersister.persistClient(stored()); const held = deferred(); h.removeWait = held.promise;
    const pending = Promise.resolve(persisted.queryPersister.removeClient());
    await vi.advanceTimersByTimeAsync(sessions.SESSION_READ_TIMEOUT_MS); await pending;
    held.reject(); await settle(); h.removeWait = null;
    await restore(); expect(qc.getQueryData([API, "stocks"])).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
});
