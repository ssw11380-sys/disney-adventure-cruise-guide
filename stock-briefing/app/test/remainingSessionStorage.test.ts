import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundSessionFor, clearSession, installSessionStorage, loadSession, persistsPersonal, resetSessionForTests, saveSession, SESSION_KEY, sessionFor, type KeyValueStorage } from "@/lib/session";

const SERVER = "https://remaining-session.test";
const login = (id: number, apiUrl = SERVER, remember = true) => ({ apiUrl, token: `offline-fixture-${id}`, remember, savedAt: 1, user: { id, loginId: `가짜사용자${id}`, email: null, isOwner: id === 1, usingInitialPassword: false } });
let directory = "";
let failRemove = false;
let failSessionValue = false;
let removals = 0;
let writes = 0;
let disk: KeyValueStorage;
async function restart() { resetSessionForTests(); installSessionStorage(disk); await loadSession(); }
// 별도 프로세스가 같은 실제 파일을 읽는다. Android 프로세스나 네이티브 AsyncStorage 검증은 아니다.
const childModule = ts.transpileModule(readFileSync(new URL("../src/lib/session.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
function restoredInNewProcess() {
  const code = `${childModule}
    const fs = await import('node:fs/promises'); const path = await import('node:path');
    installSessionStorage({
      getItem: async key => { try { return await fs.readFile(path.join(process.env.AUDIT_SESSION_DIRECTORY, key), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
      setItem: async () => { throw new Error('읽기 전용'); }, removeItem: async () => { throw new Error('읽기 전용'); }
    });
    await loadSession();
    process.stdout.write(JSON.stringify({ first: sessionFor('https://remaining-session.test')?.user.id ?? null, second: sessionFor('https://remaining-other.test')?.user.id ?? null }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", env: { ...process.env, AUDIT_SESSION_DIRECTORY: directory }, timeout: 10_000, windowsHide: true,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { first: number | null; second: number | null };
}

beforeEach(async () => {
  resetSessionForTests();
  directory = await mkdtemp(join(tmpdir(), "stock-session-boundary-"));
  failRemove = false; failSessionValue = false; removals = 0; writes = 0;
  disk = {
    getItem: async (key) => {
      try { return await readFile(join(directory, key), "utf8"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    },
    setItem: async (key, value) => {
      if (key === SESSION_KEY) { writes++; if (failSessionValue && value !== "null") throw new Error("주입한 로그인 저장 실패"); }
      await writeFile(join(directory, key), value, "utf8");
    },
    removeItem: async (key) => {
      if (key === SESSION_KEY) { removals++; if (failRemove) throw new Error("주입한 로그인 삭제 실패"); }
      try { await unlink(join(directory, key)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    },
  };
  installSessionStorage(disk);
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T22:30:00+09:00"));
});
afterEach(async () => {
  resetSessionForTests(); vi.useRealTimers();
  // mkdtemp로 이 검사에서 만든 전용 폴더만 회수한다.
  await rm(directory, { recursive: true, force: true });
});

describe("실제 임시 파일 저장소와 계정 전환 실패 경계", () => {
  it("로그아웃 삭제 실패라도 폐기값 쓰기가 가능하면 재시작 뒤 앞 계정이 돌아오지 않는다", async () => {
    await saveSession(login(1)); failRemove = true;
    await clearSession("logout");
    expect(sessionFor(SERVER)).toBeNull();
    expect(restoredInNewProcess()).toEqual({ first: null, second: null });
    await restart();
    expect(sessionFor(SERVER)).toBeNull();
    expect(await backgroundSessionFor(SERVER)).toEqual({ kind: "none" });
    expect(removals).toBe(1); expect(writes).toBe(2);
  });

  it("앞 계정에서 자동 로그인 끈 다음 계정으로 바꿀 때 삭제 실패가 앞 계정을 부활시키지 않는다", async () => {
    await saveSession(login(1)); failRemove = true;
    await saveSession(login(2, SERVER, false));
    expect(sessionFor(SERVER)?.user.id).toBe(2);
    expect(await backgroundSessionFor(SERVER)).toEqual({ kind: "memory" });
    expect(restoredInNewProcess()).toEqual({ first: null, second: null });
    await restart();
    expect(sessionFor(SERVER)).toBeNull();
    expect(removals).toBe(1); expect(writes).toBe(2);
  });

  it("새 계정 자동 로그인 저장 실패는 메모리 세션만 유지하고 앞 계정 저장값을 폐기한다", async () => {
    await saveSession(login(1)); failSessionValue = true;
    await saveSession(login(2));
    expect(sessionFor(SERVER)).toMatchObject({ user: { id: 2 }, remember: false });
    expect(persistsPersonal(SERVER)).toBe(false);
    expect(await backgroundSessionFor(SERVER)).toEqual({ kind: "memory" });
    expect(restoredInNewProcess()).toEqual({ first: null, second: null });
    await restart();
    expect(sessionFor(SERVER)).toBeNull();
    expect(removals).toBe(1);
  });

  it("서버를 바꾸며 새 로그인 저장과 앞 세션 삭제가 실패해도 폐기값이 쓰이면 어느 서버에도 복원하지 않는다", async () => {
    const secondServer = "https://remaining-other.test";
    await saveSession(login(1)); failSessionValue = true; failRemove = true;
    await saveSession(login(2, secondServer));
    expect(sessionFor(secondServer)).toMatchObject({ user: { id: 2 }, remember: false });
    expect(sessionFor(SERVER)).toBeNull();
    expect(restoredInNewProcess()).toEqual({ first: null, second: null });
    await restart();
    expect(sessionFor(SERVER)).toBeNull(); expect(sessionFor(secondServer)).toBeNull();
    expect(removals).toBe(1); expect(writes).toBe(3);
  });

  it("정상 저장·삭제는 기존 한 번씩만 수행하고 타이머나 통신을 더하지 않는다", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    try {
      await saveSession(login(1));
      expect(removals).toBe(0); expect(writes).toBe(1);
      await clearSession("logout");
      expect(removals).toBe(1); expect(writes).toBe(1);
      expect(vi.getTimerCount()).toBe(0); expect(network).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("늦게 실패한 앞 로그인 폐기가 뒤의 정상 계정 저장·복원을 지우지 않는다", async () => {
    await saveSession(login(1));
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const set = disk.setItem;
    disk.setItem = async (key, value) => {
      if (key === SESSION_KEY && value.includes('"id":2')) { await delayed; throw new Error("주입한 늦은 저장 실패"); }
      await set(key, value);
    };
    const failed = saveSession(login(2));
    const next = saveSession(login(3));
    release(); await Promise.all([failed, next]);
    expect(sessionFor(SERVER)).toMatchObject({ user: { id: 3 }, remember: true });
    expect(restoredInNewProcess()).toEqual({ first: 3, second: null });
    expect(removals).toBe(1);
  });
});
