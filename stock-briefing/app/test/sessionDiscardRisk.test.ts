import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authErrorView } from "@/lib/authErrors";
import { backgroundSessionFor, clearSession, dropPendingLogout, installSessionStorage, loadSession, pendingLogoutsFor, PENDING_LOGOUT_KEY, resetSessionForTests, saveSession, SESSION_KEY, sessionFor, type KeyValueStorage } from "@/lib/session";

const API = "https://discard-risk.test";
const token = "offline-discard-fixture";
const login = { apiUrl: API, token, remember: true, savedAt: 1, user: { id: 1, loginId: "가짜", email: null, isOwner: true, usingInitialPassword: false } };
let directory: string;
let failSession = false;
let failAll = false;
let disk: KeyValueStorage;
const childModule = ts.transpileModule(readFileSync(new URL("../src/lib/session.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function restoredByFreshProcess() {
  const code = `${childModule}
    const fs = await import('node:fs/promises'), path = await import('node:path');
    installSessionStorage({getItem: async key => {try{return await fs.readFile(path.join(process.env.AUDIT_DISCARD_DIRECTORY,key),'utf8')}catch(e){if(e.code==='ENOENT')return null;throw e}},setItem:async()=>{throw Error('읽기 전용')},removeItem:async()=>{throw Error('읽기 전용')}});
    await loadSession(); process.stdout.write(JSON.stringify({userId:sessionFor('${API}')?.user.id??null}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, AUDIT_DISCARD_DIRECTORY: directory }, timeout: 10_000, windowsHide: true });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { userId: number | null };
}
beforeEach(async () => {
  resetSessionForTests(); failSession = false; failAll = false;
  directory = await mkdtemp(join(tmpdir(), "stock-discard-risk-"));
  disk = {
    getItem: async (key) => { try { return await readFile(join(directory, key), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
    setItem: async (key, value) => { if (failAll || (failSession && key === SESSION_KEY)) throw new Error("주입한 쓰기 실패"); await writeFile(join(directory, key), value, "utf8"); },
    removeItem: async (key) => { if (failAll || (failSession && key === SESSION_KEY)) throw new Error("주입한 삭제 실패"); try { await unlink(join(directory, key)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } },
  };
  installSessionStorage(disk);
});
afterEach(async () => { resetSessionForTests(); await rm(directory, { recursive: true, force: true }); });

describe("세션을 폐기할 수 없는 저장소의 추가 방어", () => {
  it("로그아웃 대기와 같은 서버·토큰은 새 프로세스 시작부터 복원하지 않는다", async () => {
    await saveSession(login);
    await disk.setItem(PENDING_LOGOUT_KEY, JSON.stringify([{ apiUrl: API, token }]));
    expect(restoredByFreshProcess()).toEqual({ userId: null });
  });

  it("다른 서버의 대기 표식으로 현재 서버의 정상 로그인을 막지 않는다", async () => {
    await saveSession(login);
    await disk.setItem(PENDING_LOGOUT_KEY, JSON.stringify([{ apiUrl: "https://other-discard.test", token }]));
    expect(restoredByFreshProcess()).toEqual({ userId: 1 });
  });

  it("세션 키 삭제·덮어쓰기가 모두 실패해도 다른 키 폐기 표식으로 새 프로세스 복원을 막고 실패를 알린다", async () => {
    await saveSession(login); failSession = true;
    const outcome = await clearSession("logout").then(() => null, (e: unknown) => e);
    expect(outcome).toMatchObject({ code: "SESSION_PERSISTENCE" });
    expect(authErrorView(outcome).message).toContain("기기에 남은 로그인 정보를 지우지 못했어요");
    expect(sessionFor(API)).toBeNull();
    expect(await disk.getItem(SESSION_KEY)).not.toBeNull();
    expect(restoredByFreshProcess()).toEqual({ userId: null });
  });

  it("모든 쓰기 불능은 성공으로 숨기지 않고 같은 프로세스 재읽기로 앞 계정이 돌아오지 않는다", async () => {
    await saveSession(login); failAll = true;
    await expect(clearSession("logout")).rejects.toMatchObject({ code: "SESSION_PERSISTENCE" });
    installSessionStorage(disk); await loadSession();
    expect(sessionFor(API)).toBeNull();
    expect(await backgroundSessionFor(API)).toEqual({ kind: "none" });
    // 완전 쓰기 불능 + 프로세스 소멸은 기록을 남길 수 없다. 이 잔여 한계를 정상으로 숨기지 않는다.
    expect(restoredByFreshProcess()).toEqual({ userId: 1 });
  });

  it("서버가 로그아웃을 확인해도 앞 세션 파일을 지우기 전에는 유일한 폐기 표식을 지우지 않는다", async () => {
    await saveSession(login);
    await disk.setItem(PENDING_LOGOUT_KEY, JSON.stringify([{ apiUrl: API, token }]));
    resetSessionForTests(); installSessionStorage(disk); await loadSession();
    failSession = true; await dropPendingLogout(token);
    expect(await pendingLogoutsFor(API)).toEqual([token]);
    expect(restoredByFreshProcess()).toEqual({ userId: null });
    failSession = false; await dropPendingLogout(token);
    expect(await pendingLogoutsFor(API)).toEqual([]);
    expect(await disk.getItem(SESSION_KEY)).toBeNull();
    expect(restoredByFreshProcess()).toEqual({ userId: null });
  });
});
