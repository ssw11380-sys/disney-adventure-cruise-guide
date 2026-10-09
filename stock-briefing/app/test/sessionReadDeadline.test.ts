import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import { backgroundSessionFor, clearSession, installSessionStorage, loadSession, pendingLogoutsFor, resetSessionForTests, saveSession, SESSION_KEY, sessionFor, sessionLoaded, type KeyValueStorage } from "@/lib/session";

const API = "https://session-read.test";
const user = (id: number) => ({ id, loginId: `사용자${id}`, email: null, isOwner: id === 1, usingInitialPassword: false });
const stored = (id = 1) => ({ apiUrl: API, token: `offline-session-${id}`, remember: true, user: user(id), savedAt: 1 });
const json = () => new Response(JSON.stringify({ ok: true }));
function delayedStorage() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const getItem = vi.fn(async (key: string) => { await waiting; return key === SESSION_KEY ? JSON.stringify(stored()) : null; });
  const storage: KeyValueStorage = { getItem, setItem: async () => undefined, removeItem: async () => undefined };
  return { storage, release, getItem };
}
function track<T>(promise: Promise<T>) {
  const state: { phase: "pending" | "success" | "failed"; error?: unknown } = { phase: "pending" };
  const settled = promise.then(() => { state.phase = "success"; }, (error: unknown) => { state.phase = "failed"; state.error = error; });
  return { state, settled };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00")); resetSessionForTests(); });
afterEach(() => { resetSessionForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("저장된 로그인 정보 읽기도 API 요청 기한에 포함", () => {
  it("8초 건강 확인 기한에 저장소 대기도 끝내고 늦은 읽기는 요청이나 세션을 되살리지 않는다", async () => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const fetchFn = vi.fn(async () => json()); vi.stubGlobal("fetch", fetchFn);
    const startup = loadSession();
    const request = track(createApi(API).health());
    await vi.advanceTimersByTimeAsync(8_000);
    const phaseAtDeadline = request.state.phase;
    // 수정 전에도 미완료 작업을 남기지 않고 결과를 관찰한다.
    held.release(); await vi.advanceTimersByTimeAsync(0); await request.settled; await startup;
    expect(phaseAtDeadline).toBe("failed");
    expect(request.state.error).toMatchObject({ status: 0, code: "SESSION_STORAGE" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sessionFor(API)).toBeNull();
    expect(sessionLoaded()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("읽기 실패는 익명 요청으로 보내지 않고 다음 요청에서 다시 읽는다", async () => {
    let failing = true;
    const getItem = vi.fn(async (key: string) => {
      if (failing) throw new Error("저장소 읽기 실패");
      return key === SESSION_KEY ? JSON.stringify(stored()) : null;
    });
    installSessionStorage({ getItem, setItem: async () => undefined, removeItem: async () => undefined });
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent.push(init); return json(); });
    const first = track(createApi(API).health()); await first.settled;
    expect(first.state.error).toMatchObject({ status: 0, code: "SESSION_STORAGE" });
    expect(sent).toHaveLength(0);
    failing = false;
    await createApi(API).health();
    expect(getItem).toHaveBeenCalledTimes(6);
    expect(sent).toHaveLength(1);
    expect(new Headers(sent[0]!.headers).get("x-session-token")).toBe(stored().token);
  });

  it("저장소 6초 뒤 통신이 늦어져도 기존 전체 기한 8초에 끝난다", async () => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(json()), 3_000);
      init.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("중단", "AbortError")); }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchFn);
    const request = track(createApi(API).health());
    await vi.advanceTimersByTimeAsync(6_000); held.release(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    const phaseAtDeadline = request.state.phase;
    await vi.advanceTimersByTimeAsync(1_000); await request.settled;
    expect(phaseAtDeadline).toBe("failed");
    expect(request.state.error).toMatchObject({ code: "TIMEOUT" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sessionFor(API)?.token).toBe(stored().token);
  });

  it("정상 저장소와 100ms 응답은 추가 대기 없이 돌아오고 타이머를 정리한다", async () => {
    const held = delayedStorage(); installSessionStorage(held.storage); held.release();
    vi.stubGlobal("fetch", async () => new Promise<Response>((resolve) => setTimeout(() => resolve(json()), 100)));
    const request = track(createApi(API).health());
    await vi.advanceTimersByTimeAsync(99); expect(request.state.phase).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); await request.settled;
    expect(request.state.phase).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["로그아웃", "다른 계정 로그인"])("저장소 읽기 중 %s하면 이전 작업과 저장된 이전 토큰을 적용하지 않는다", async (change) => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const fetchFn = vi.fn(async () => json()); vi.stubGlobal("fetch", fetchFn);
    const request = track(createApi(API).health()); await vi.advanceTimersByTimeAsync(0);
    if (change === "로그아웃") await clearSession("logout");
    else await saveSession(stored(2));
    held.release(); await vi.advanceTimersByTimeAsync(0); await request.settled;
    expect(request.state.error).toMatchObject({ code: "SESSION_CHANGED" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sessionFor(API)?.user.id ?? null).toBe(change === "로그아웃" ? null : 2);
  });

  it("기한이 지난 읽기와 재시도가 겹쳐도 새 저장소의 세션만 쓰고 이전 결과는 버린다", async () => {
    const old = delayedStorage(); installSessionStorage(old.storage);
    const sent: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent.push(init); return json(); });
    const first = track(createApi(API).health()); await vi.advanceTimersByTimeAsync(8_000);
    installSessionStorage({ getItem: async (key) => key === SESSION_KEY ? JSON.stringify(stored(2)) : null, setItem: async () => undefined, removeItem: async () => undefined });
    await createApi(API).health();
    old.release(); await vi.advanceTimersByTimeAsync(0); await first.settled;
    expect(first.state.error).toMatchObject({ code: "SESSION_STORAGE" });
    expect(sent).toHaveLength(1);
    expect(sessionFor(API)?.user.id).toBe(2);
    expect(new Headers(sent[0]!.headers).get("x-session-token")).toBe(stored(2).token);
  });

  it("동시 API는 한 번 읽고 기한이 지나면 모두 안전하게 실패한 뒤 새로 읽을 수 있다", async () => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const fetchFn = vi.fn(async () => json()); vi.stubGlobal("fetch", fetchFn);
    const api = createApi(API);
    const first = track(api.health()), second = track(api.me());
    await vi.advanceTimersByTimeAsync(8_000);
    const phases = [first.state.phase, second.state.phase];
    held.release(); await vi.advanceTimersByTimeAsync(0); await Promise.all([first.settled, second.settled]);
    expect(phases).toEqual(["failed", "failed"]);
    expect(held.getItem).toHaveBeenCalledTimes(3);
    expect(fetchFn).not.toHaveBeenCalled();
    await api.health();
    expect(held.getItem).toHaveBeenCalledTimes(6);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("로그인 요청은 저장소가 멈췄어도 기다리지 않고 기존처럼 세션 없이 보낸다", async () => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const fetchFn = vi.fn(async () => json()); vi.stubGlobal("fetch", fetchFn);
    await createApi(API).login({ loginId: "사용자", password: "offline", remember: false });
    expect(held.getItem).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("저장소 오류가 이미 로그인한 세션을 지우거나 익명 요청을 보내지는 않는다", async () => {
    await saveSession(stored(2));
    installSessionStorage({ getItem: async () => { throw new Error("저장소 내부 오류"); }, setItem: async () => undefined, removeItem: async () => undefined });
    const fetchFn = vi.fn(async () => json()); vi.stubGlobal("fetch", fetchFn);
    const request = track(createApi(API).health()); await request.settled;
    expect(request.state.error).toMatchObject({ code: "SESSION_STORAGE" });
    expect((request.state.error as Error).message).not.toContain("저장소 내부 오류");
    expect(sessionFor(API)?.user.id).toBe(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("중단 신호를 따르지 않는 늦은 본문도 기한 뒤 성공으로 반환하지 않는다", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", async () => ({ status: 200, text: () => new Promise<string>((resolve) => { release = () => resolve("{}"); }) } as Response));
    const request = track(createApi(API).health());
    await vi.advanceTimersByTimeAsync(8_000);
    const phaseAtDeadline = request.state.phase;
    release(); await vi.advanceTimersByTimeAsync(0); await request.settled;
    expect(phaseAtDeadline).toBe("failed");
    expect(request.state.error).toMatchObject({ code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("API가 없는 부팅 읽기도 8초에 시작 화면 대기를 풀고 늦은 값을 적용하지 않는다", async () => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const startup = track(loadSession());
    await vi.advanceTimersByTimeAsync(8_000);
    const phaseAtDeadline = startup.state.phase;
    held.release(); await vi.advanceTimersByTimeAsync(0); await startup.settled;
    expect(phaseAtDeadline).toBe("success");
    expect(sessionLoaded()).toBe(true);
    expect(sessionFor(API)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["백그라운드 세션", "미전달 로그아웃 목록"])("%s 직접 읽기도 8초에 실패하며 세션 없음으로 바꾸지 않는다", async (kind) => {
    const held = delayedStorage(); installSessionStorage(held.storage);
    const request = track<unknown>(kind === "백그라운드 세션" ? backgroundSessionFor(API) : pendingLogoutsFor(API));
    await vi.advanceTimersByTimeAsync(8_000);
    const phaseAtDeadline = request.state.phase;
    held.release(); await vi.advanceTimersByTimeAsync(0); await request.settled;
    expect(phaseAtDeadline).toBe("failed");
    expect(request.state.error).toMatchObject({ code: "SESSION_STORAGE" });
    expect(sessionFor(API)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
