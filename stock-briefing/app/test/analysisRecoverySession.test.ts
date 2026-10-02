import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import type { Analysis } from "@/api/types";
import { analysisRecoveryFor, type AnalysisRecovery } from "@/lib/analysisRecovery";
import { clearSession, onAccountChange, resetSessionForTests, saveSession, updateSessionUser, type AccountUser } from "@/lib/session";

const API = "https://session-analysis.test";
const CODE = "005930";
const OWNER: AccountUser = { id: 1, loginId: "테스트주인", email: null, isOwner: true, usingInitialPassword: false };
const MEMBER: AccountUser = { id: 2, loginId: "테스트회원", email: null, isOwner: false, usingInitialPassword: false };
const result = (id: number): Analysis => ({ id, code: CODE, kind: "company", content: `${id} 분석`, missing: [], model: "fake", createdAt: "2026-12-28T08:30:00+09:00", cached: false });
const json = (data: unknown) => new Response(JSON.stringify(data));
let qc: QueryClient;
const controllers: AnalysisRecovery[] = [];
const cleanups: (() => void)[] = [];
const flags = () => qc.setQueryData([API, "features"], { features: { analysisWaitRecovery: true, accounts: true } });
const controller = () => { const r = analysisRecoveryFor(qc, createApi(API), API, "test-api-credential"); controllers.push(r); return r; };
const login = (user = OWNER, token = "test-owner-session") => saveSession({ apiUrl: API, token, remember: true, user });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00"));
  resetSessionForTests();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => {
  controllers.splice(0).forEach((r) => r.dispose());
  cleanups.splice(0).forEach((fn) => fn());
  qc.clear(); resetSessionForTests(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("배포 앱 계정 세션과 분석 복구 통합", () => {
  it.each(["다른 계정", "로그아웃", "같은 계정 새 세션"])("%s 뒤에는 이전 요청을 복원하거나 늦은 결과를 새 세션 캐시에 쓰지 않는다", async (change) => {
    await login();
    flags();
    // 실제 AuthBridge와 같은 계정 변경 동기 캐시 비우기.
    cleanups.push(onAccountChange(() => qc.clear()));
    let finish: (response: Response) => void = () => undefined;
    let generated = 0;
    let reads = 0;
    vi.stubGlobal("fetch", (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/state")) {
        reads++;
        return Promise.resolve(json({ latest: result(1), running: true, request: { id: parsed.searchParams.get("requestId"), status: "pending", result: null } }));
      }
      generated++;
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const old = controller();
    const job = old.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.snapshot(CODE, "company").requestId).toBeTruthy();
    if (change === "다른 계정") await login(MEMBER, "test-member-session");
    else if (change === "로그아웃") await clearSession("logout");
    else await login(OWNER, "test-owner-replaced-session");
    flags();
    const next = controller();
    expect(next).not.toBe(old);
    expect(next.snapshot(CODE, "company")).toEqual({ phase: "idle", startedAt: 0 });
    const beforeRead = reads;
    await next.start(CODE, "company", false, true);
    expect(reads).toBe(beforeRead);
    finish(json(result(2)));
    await job;
    expect(qc.getQueryData<Analysis>([API, "analysis", CODE, "company"])?.id).not.toBe(2);
    expect(generated).toBe(1);
    expect(old.disposed).toBe(true);
    // 실제 세션은 React Query 키에 넣지 않는다.
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.queryKey))).not.toContain("test-owner");
  });

  it("사용자 정보만 새로 받으면 같은 세션의 진행 요청과 완료 회수를 유지한다", async () => {
    await login(); flags();
    let completed = false;
    let generated = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith("/state")) { generated++; throw new TypeError("연결 실패"); }
      return json({ latest: result(1), running: !completed, request: { id: parsed.searchParams.get("requestId"), status: completed ? "completed" : "pending", result: completed ? result(2) : null } });
    });
    const first = controller();
    const job = first.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(0);
    const requestId = first.snapshot(CODE, "company").requestId;
    await updateSessionUser(API, { ...OWNER, email: "test@example.com" });
    const same = controller();
    expect(same).toBe(first);
    expect(same.snapshot(CODE, "company")).toMatchObject({ phase: "recovering", requestId });
    completed = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await job;
    expect(qc.getQueryData([API, "analysis", CODE, "company"])).toEqual(result(2));
    expect(generated).toBe(1);
  });
});
