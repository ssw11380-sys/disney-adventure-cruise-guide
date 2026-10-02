import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import type { Analysis, AnalysisState } from "@/api/types";
import { AnalysisRecovery, analysisRecoveryFor, invalidateAnalysisRecoveryScope } from "@/lib/analysisRecovery";

const API = "https://analysis.test";
const CODE = "005930";
const record = (id: number, code = CODE): Analysis => ({ id, code, kind: "company", content: `${id}번 분석 본문`, missing: [], model: "fake", createdAt: "2026-12-28T08:30:00+09:00", cached: true });
const json = (data: unknown) => new Response(JSON.stringify(data));
const key = (code = CODE) => [API, "analysis", code, "company"];
const isState = (url: string) => new URL(url).pathname.endsWith("/state");
const idOf = (url: string) => new URL(url).searchParams.get("requestId")!;
const tracked = (url: string, status: "pending" | "completed" | "failed" | "unknown", latest: Analysis | null = record(1), result: Analysis | null = null): AnalysisState => ({ latest, running: status === "pending", request: { id: idOf(url), status, result } });
const later = (ms: number, data: unknown) => new Promise<Response>((resolve) => setTimeout(() => resolve(json(data)), ms));
const aborted = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("중단"), { name: "AbortError" }))));
const clients: QueryClient[] = [];
const controllers: AnalysisRecovery[] = [];
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  const recovery = new AnalysisRecovery(qc, createApi(API), API);
  controllers.push(recovery);
  return { qc, recovery };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00")); });
afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); clients.splice(0).forEach((c) => c.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("분석 대기·완료 회수", () => {
  it("상태 30ms·생성 100ms일 때 선행 조회 130ms에서 병렬 100ms로 줄고 생성은 즉시 한 번 시작한다", async () => {
    const calls: { state: boolean; at: number; id: string }[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push({ state: isState(url), at: Date.now(), id: idOf(url) });
      return isState(url) ? later(30, tracked(url, "pending")) : later(100, record(2));
    });
    const api = createApi(API);
    const legacyStart = Date.now();
    const serial = api.analysisState(CODE, "company").then(() => api.getAnalysis(CODE, "company", true)).then(() => Date.now() - legacyStart);
    await vi.advanceTimersByTimeAsync(130);
    expect(await serial).toBe(130);
    calls.length = 0;
    const { qc, recovery } = setup();
    const start = Date.now();
    const job = recovery.start(CODE, "company", true).then(() => Date.now() - start);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.state)).toEqual([false, true]);
    expect(calls.every((c) => c.at === start)).toBe(true);
    expect(calls[0]!.id).toMatch(/^[A-Za-z0-9_-]{12,80}$/);
    expect(calls[1]!.id).toBe(calls[0]!.id);
    await vi.advanceTimersByTimeAsync(30);
    expect(qc.getQueryData(key())).toEqual(record(1));
    await vi.advanceTimersByTimeAsync(70);
    expect(await job).toBe(100);
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(calls.filter((c) => !c.state)).toHaveLength(1);
  });

  it("상태 응답이 생성보다 느려도 정상 결과를 즉시 반환하고 늦은 이전 본문은 덮어쓰지 않는다", async () => {
    vi.stubGlobal("fetch", (url: string) => isState(url) ? later(300, tracked(url, "pending", record(1))) : later(100, record(2)));
    const { recovery, qc } = setup();
    const job = recovery.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(100);
    await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(qc.getQueryData(key())).toEqual(record(2));
    await vi.advanceTimersByTimeAsync(200);
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
  });

  it("상태 응답이 10초 동안 없어도 100ms 정상 분석 결과는 기다리지 않는다", async () => {
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => isState(url) ? aborted(init) : later(100, record(2)));
    const { recovery, qc } = setup();
    const start = Date.now();
    const job = recovery.start(CODE, "company").then(() => Date.now() - start);
    await vi.advanceTimersByTimeAsync(100);
    expect(await job).toBe(100);
    expect(qc.getQueryData(key())).toEqual(record(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
  });

  it.each(["늦은 성공", "늦은 오류"])('같은 요청의 완료가 먼저 확인되면 30ms에 보여 주며 %s가 덮어쓰지 않는다', async (condition) => {
    let generations = 0;
    vi.stubGlobal("fetch", (url: string) => {
      if (isState(url)) return later(30, tracked(url, "completed", record(2), record(2)));
      generations++;
      if (condition === "늦은 오류") return new Promise<Response>((_, reject) => setTimeout(() => reject(new TypeError("늦은 연결 오류")), 100));
      return later(100, record(3));
    });
    const { recovery, qc } = setup();
    const start = Date.now();
    const job = recovery.start(CODE, "company").then(() => Date.now() - start);
    await vi.advanceTimersByTimeAsync(30);
    expect(await job).toBe(30);
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    await vi.advanceTimersByTimeAsync(70);
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(generations).toBe(1);
  });

  it("실제 180초 요청 제한 뒤에는 같은 요청의 완료 결과만 회수하며 재진입도 생성 한 번이다", async () => {
    let generations = 0;
    let completed = false;
    const requests: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      requests.push(idOf(url));
      if (isState(url)) return Promise.resolve(json(tracked(url, completed ? "completed" : "pending", record(completed ? 2 : 1), completed ? record(2) : null)));
      generations++;
      return aborted(init);
    });
    const { qc, recovery } = setup();
    const first = recovery.start(CODE, "company", true);
    expect(recovery.start(CODE, "company", true)).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(qc.getQueryData(key())).toEqual(record(1));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(recovery.snapshot(CODE, "company").phase).toBe("recovering");
    expect(recovery.start(CODE, "company", true)).toBe(first);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recovery.snapshot(CODE, "company").phase).toBe("recovering");
    completed = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(new Set(requests).size).toBe(1);
    expect(generations).toBe(1);
  });

  it("로컬 ID1·서버 기존 ID2여도 새 요청 실패를 성공으로 오인하지 않고 읽기 확인만 한다", async () => {
    let generated = 0;
    let completed = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (isState(url)) return json(tracked(url, completed ? "completed" : "failed", record(2), completed ? record(3) : null));
      generated++;
      return new Response(JSON.stringify({ message: "권한을 확인해 주세요", code: "UNAUTHORIZED" }), { status: 401 });
    });
    const { recovery, qc } = setup();
    qc.setQueryData(key(), record(1));
    await recovery.start(CODE, "company", true);
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    expect(recovery.snapshot(CODE, "company").message).toContain("토큰");
    const requestedId = recovery.snapshot(CODE, "company").requestId;
    await recovery.start(CODE, "company", false, true);
    expect(recovery.snapshot(CODE, "company")).toMatchObject({ phase: "unknown", requestId: requestedId });
    completed = true;
    await recovery.start(CODE, "company", false, true);
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(qc.getQueryData(key())).toEqual(record(3));
    expect(generated).toBe(1);
  });

  it("다른 요청의 완료 ID와 전역 running은 자신의 완료 근거가 아니고 다른 종목 캐시는 유지한다", async () => {
    let generated = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) { generated++; throw new TypeError("연결 실패"); }
      return json({ latest: record(9), running: true, request: { id: "unrelated-request", status: "completed", result: record(9) } });
    });
    const { qc, recovery } = setup();
    qc.setQueryData(key("TSLA"), record(8, "TSLA"));
    await recovery.start(CODE, "company");
    expect(qc.getQueryData(key("TSLA"))).toEqual(record(8, "TSLA"));
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    expect(generated).toBe(1);
  });

  it("전역 running이 false여도 자신의 요청이 pending이면 계속 기다린다", async () => {
    let completed = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) throw new TypeError("연결 실패");
      return json({ ...tracked(url, completed ? "completed" : "pending", record(1), completed ? record(2) : null), running: false });
    });
    const { recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.snapshot(CODE, "company").phase).toBe("recovering");
    completed = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
  });

  it("플래그를 끄면 조회를 멈추고 다시 켜면 같은 요청 ID를 읽기로만 이어간다", async () => {
    let calls = 0;
    let generations = 0;
    const ids: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls++; ids.push(idOf(url));
      if (!isState(url)) { generations++; throw new TypeError("연결 실패"); }
      return json(tracked(url, "pending"));
    });
    const { qc, recovery: unused } = setup(); unused.dispose();
    const flags = (on: boolean) => qc.setQueryData([API, "features"], { features: { analysisWaitRecovery: on } });
    flags(true);
    const api = createApi(API);
    const first = analysisRecoveryFor(qc, api, API, ""); controllers.push(first);
    const job = first.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    flags(false);
    const atOff = calls;
    await vi.advanceTimersByTimeAsync(30_000);
    await job;
    expect(calls).toBe(atOff);
    expect(first.disposed).toBe(true);
    flags(true);
    const second = analysisRecoveryFor(qc, api, API, ""); controllers.push(second);
    second.ensure(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBeGreaterThan(atOff);
    expect(second.snapshot(CODE, "company").phase).toBe("recovering");
    expect(new Set(ids).size).toBe(1);
    expect(generations).toBe(1);
  });

  it("로그인 정보가 바뀐 뒤 늦게 도착한 결과는 캐시에 쓰지 않는다", async () => {
    let finish: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", (url: string) => isState(url) ? Promise.resolve(json(tracked(url, "pending"))) : new Promise<Response>((resolve) => { finish = resolve; }));
    const { qc, recovery: unused } = setup(); unused.dispose();
    qc.setQueryData([API, "features"], { features: { analysisWaitRecovery: true } });
    const first = analysisRecoveryFor(qc, createApi(API), API, "first-test-session"); controllers.push(first);
    const job = first.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(0);
    invalidateAnalysisRecoveryScope(qc, API, "second-test-session");
    finish(json(record(2)));
    await job;
    expect(qc.getQueryData(key())).toEqual(record(1));
    expect(first.disposed).toBe(true);
  });

  it.each(["요청 미상", "구버전 상태", "404"])('%s이면 이전 최신 ID로 완료 처리하거나 자동 재생성하지 않는다', async (condition) => {
    let generations = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) { generations++; throw new TypeError("연결 실패"); }
      if (condition === "404") return new Response("", { status: 404 });
      return json(condition === "요청 미상" ? tracked(url, "unknown", record(2)) : { latest: record(2), running: true });
    });
    const { recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(15_000);
    await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    const check = recovery.start(CODE, "company", false, true);
    await vi.advanceTimersByTimeAsync(15_000);
    await check;
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    expect(generations).toBe(1);
  });

  it("회수 중 상태 조회가 세 번 연속 실패하면 확인을 멈춘다", async () => {
    let states = 0;
    let generated = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) { generated++; throw new TypeError("연결 실패"); }
      states++;
      throw new TypeError("연결 실패");
    });
    const { recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(10_000);
    await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    expect(states).toBe(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states).toBe(4);
    expect(generated).toBe(1);
  });

  it("자신의 요청이 계속 pending이어도 회수 10분 뒤 확인을 멈춘다", async () => {
    let states = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) throw new TypeError("연결 실패");
      states++;
      return json(tracked(url, "pending"));
    });
    const { recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(600_000);
    await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    const stopped = states;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states).toBe(stopped);
  });

  it("다른 서버로 바꾸면 백그라운드 이전 서버 확인 요청도 멈춘다", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      if (!isState(url)) throw new TypeError("연결 실패");
      return json(tracked(url, "pending"));
    });
    const { qc, recovery: unused } = setup(); unused.dispose();
    qc.setQueryData([API, "features"], { features: { analysisWaitRecovery: true } });
    const old = analysisRecoveryFor(qc, createApi(API), API, ""); controllers.push(old);
    const job = old.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    invalidateAnalysisRecoveryScope(qc, "https://other.test", "");
    const before = calls;
    await vi.advanceTimersByTimeAsync(30_000);
    await job;
    expect(calls).toBe(before);
    expect(qc.getQueryData(["https://other.test", "analysis", CODE, "company"])).toBeUndefined();
  });
});
