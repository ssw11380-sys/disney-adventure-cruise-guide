import { afterEach, describe, expect, it } from "vitest";
import { clearSession, DEVICE_KEY, installSessionStorage, loadSession, resetSessionForTests, saveSession, SESSION_KEY, sessionFor, updateSessionUser, type KeyValueStorage } from "@/lib/session";

const url = "https://persistence.test";
const login = (id: number) => ({ apiUrl: url, token: `offline-session-${id}`, remember: true, savedAt: 1, user: { id, loginId: `가짜사용자${id}`, email: null, isOwner: id === 1, usingInitialPassword: false } });
function delayedStorage() {
  const disk = new Map<string, string>();
  let release!: () => void;
  let block = false;
  const delay = new Promise<void>((resolve) => { release = resolve; });
  const storage: KeyValueStorage = {
    getItem: async (key) => disk.get(key) ?? null,
    setItem: async (key, value) => { if (key === SESSION_KEY && block) await delay; disk.set(key, value); },
    removeItem: async (key) => { disk.delete(key); },
  };
  return { disk, storage, release, block: () => { block = true; } };
}
afterEach(() => resetSessionForTests());

describe("로그인 저장 지연과 앱 재시작 경계 감사", () => {
  it("로그인 저장이 늦게 끝나도 그 사이 완료한 로그아웃을 디스크에서 되돌리지 않는다", async () => {
    resetSessionForTests();
    const disk = new Map<string, string>();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let writing = false;
    const storage: KeyValueStorage = {
      getItem: async (key) => disk.get(key) ?? null,
      removeItem: async (key) => { disk.delete(key); },
      setItem: async (key, value) => {
        if (key === SESSION_KEY) { writing = true; await delayed; }
        disk.set(key, value);
      },
    };
    installSessionStorage(storage);
    const pending = saveSession(login(1));
    await Promise.resolve();
    expect(writing).toBe(true);
    const clearing = clearSession("logout");
    expect(sessionFor(url)).toBeNull();
    release();
    await Promise.all([pending, clearing]);
    resetSessionForTests();
    installSessionStorage(storage);
    await loadSession();
    expect(sessionFor(url)).toBeNull();
    expect(disk.has(SESSION_KEY)).toBe(false);
  });

  it("옛 프로필 저장 도중 로그아웃·새 로그인해도 재시작하면 새 사용자만 복원한다", async () => {
    const s = delayedStorage(); installSessionStorage(s.storage); await saveSession(login(1));
    s.block();
    const profile = updateSessionUser(url, { ...login(1).user, email: "old@example.test" });
    const clear = clearSession("logout");
    const next = saveSession(login(2));
    expect(sessionFor(url)?.user.id).toBe(2);
    s.release(); await Promise.all([profile, clear, next]);
    resetSessionForTests(); installSessionStorage(s.storage); await loadSession();
    expect(sessionFor(url)?.user).toEqual(login(2).user);
  });

  it("한 저장소의 멈춘 쓰기가 다른 저장소의 정상 로그인을 기다리게 하지 않는다", async () => {
    const old = delayedStorage(); old.block(); installSessionStorage(old.storage);
    const pending = saveSession(login(1));
    const next = delayedStorage(); installSessionStorage(next.storage);
    await saveSession(login(2));
    expect(JSON.parse(next.disk.get(SESSION_KEY)!).user.id).toBe(2);
    old.release(); await pending;
    expect(sessionFor(url)?.user.id).toBe(2);
  });

  it("단독 정상 쓰기는 같은 호출에서 시작하고 추가 타이머·통신이 없다", async () => {
    const s = delayedStorage(); installSessionStorage(s.storage);
    const pending = saveSession(login(1));
    expect(s.disk.has(SESSION_KEY)).toBe(true);
    await pending;
    expect(sessionFor(url)?.user.id).toBe(1);
  });

  it("앞선 저장이 실패해도 다음 로그아웃과 로그인 쓰기가 계속된다", async () => {
    const s = delayedStorage();
    let fail = true;
    const set = s.storage.setItem;
    s.storage.setItem = async (key, value) => { if (key === SESSION_KEY && fail) { fail = false; throw new Error("가짜 저장 실패"); } await set(key, value); };
    installSessionStorage(s.storage);
    await saveSession(login(1)); await clearSession("logout"); await saveSession(login(2));
    expect(JSON.parse(s.disk.get(SESSION_KEY)!).user.id).toBe(2);
  });

  it("기기 표시 쓰기의 지연은 로그아웃 세션 삭제를 기다리게 하지 않는다", async () => {
    const s = delayedStorage();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let deviceStarted = false;
    const set = s.storage.setItem;
    s.storage.setItem = async (key, value) => { if (key === DEVICE_KEY) { deviceStarted = true; await delayed; } await set(key, value); };
    installSessionStorage(s.storage);
    const saved = saveSession(login(1));
    for (let n = 0; n < 12; n++) await Promise.resolve();
    expect(deviceStarted).toBe(true);
    try {
      await clearSession("logout");
      expect(s.disk.has(SESSION_KEY)).toBe(false);
    } finally { release(); await saved; }
  });
});
