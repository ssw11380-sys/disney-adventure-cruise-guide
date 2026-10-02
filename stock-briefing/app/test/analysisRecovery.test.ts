import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import type { Analysis } from "@/api/types";
import { AnalysisRecovery, analysisRecoveryFor, invalidateAnalysisRecoveryScope } from "@/lib/analysisRecovery";

const URL = "https://analysis.test";
const CODE = "005930";
const record = (id: number, code = CODE): Analysis => ({ id, code, kind: "company", content: `${id}번 분석 본문`, missing: [], model: "fake", createdAt: "2026-12-28T08:30:00+09:00", cached: true });
const json = (data: unknown) => new Response(JSON.stringify(data));
const key = (code = CODE) => [URL, "analysis", code, "company"];
const clients: QueryClient[] = [];
const controllers: AnalysisRecovery[] = [];
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  const recovery = new AnalysisRecovery(qc, createApi(URL), URL);
  controllers.push(recovery);
  return { qc, recovery };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00")); });
afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); clients.splice(0).forEach((c) => c.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("분석 대기·완료 회수", () => {
  it("실제 180초 요청 제한 뒤 서버가 처리 중이면 이전 본문을 유지하고 새 ID만 회수한다", async () => {
    let states = 0;
    let generations = 0;
    let completed = false;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (url.endsWith("/state")) { states++; return Promise.resolve(json({ latest: record(completed ? 2 : 1), running: states > 1 && !completed })); }
      generations++;
      return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("중단"), { name: "AbortError" }))));
    });
    const { qc, recovery } = setup();
    const first = recovery.start(CODE, "company", true);
    const duplicate = recovery.start(CODE, "company", true);
    expect(first).toBe(duplicate);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.snapshot(CODE, "company").phase).toBe("generating");
    expect(qc.getQueryData(key())).toEqual(record(1));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(recovery.snapshot(CODE, "company").phase).toBe("recovering");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(qc.getQueryData(key())).toEqual(record(1));
    expect(recovery.snapshot(CODE, "company").phase).toBe("recovering");
    completed = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(generations).toBe(1);
  });

  it("서버가 멈췄고 이전 ID만 있으면 완료로 표시하지 않으며 결과 확인 버튼은 생성하지 않는다", async () => {
    let generated = 0;
    let latest = record(1);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/state")) return json({ latest, running: false });
      generated++;
      return new Response(JSON.stringify({ message: "권한을 확인해 주세요", code: "UNAUTHORIZED" }), { status: 401 });
    });
    const { recovery } = setup();
    await recovery.start(CODE, "company", true);
    expect(recovery.snapshot(CODE, "company")).toMatchObject({ phase: "unknown", baselineId: 1 });
    expect(recovery.snapshot(CODE, "company").message).toContain("토큰");
    await recovery.start(CODE, "company", false, true);
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    latest = record(2);
    await recovery.start(CODE, "company", false, true);
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
    expect(generated).toBe(1);
  });

  it("다른 화면에서 진행 중인 분석은 읽기 확인만 하며 다른 종목 캐시는 바꾸지 않는다", async () => {
    let generated = 0;
    let complete = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!url.endsWith("/state")) { generated++; return json(record(99)); }
      return json({ latest: record(complete ? 2 : 1), running: !complete });
    });
    const { qc, recovery } = setup();
    qc.setQueryData(key("TSLA"), record(8, "TSLA"));
    const waiting = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    complete = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;
    expect(qc.getQueryData(key("TSLA"))).toEqual(record(8, "TSLA"));
    expect(qc.getQueryData(key())).toEqual(record(2));
    expect(generated).toBe(0);
  });

  it("플래그를 끄면 확인을 멈추고 다시 켜면 새 제어기로 이어간다", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return json({ latest: record(1), running: true }); });
    const { qc, recovery: unused } = setup(); unused.dispose();
    const flags = (on: boolean) => qc.setQueryData([URL, "features"], { features: { analysisWaitRecovery: on } });
    flags(true);
    const api = createApi(URL);
    const first = analysisRecoveryFor(qc, api, URL, ""); controllers.push(first);
    const job = first.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    flags(false);
    const atOff = calls;
    await vi.advanceTimersByTimeAsync(30_000);
    await job;
    expect(calls).toBe(atOff);
    expect(first.disposed).toBe(true);
    flags(true);
    const second = analysisRecoveryFor(qc, api, URL, ""); controllers.push(second);
    expect(second).not.toBe(first);
    expect(second.disposed).toBe(false);
    second.ensure(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBeGreaterThan(atOff);
    expect(second.snapshot(CODE, "company")).toMatchObject({ phase: "recovering", baselineId: 1 });
  });

  it("서버나 로그인 정보가 바뀐 뒤 늦게 도착한 결과는 캐시에 쓰지 않는다", async () => {
    let finish: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", (url: string) => url.endsWith("/state") ? Promise.resolve(json({ latest: record(1), running: false })) : new Promise<Response>((resolve) => { finish = resolve; }));
    const { qc, recovery: unused } = setup(); unused.dispose();
    qc.setQueryData([URL, "features"], { features: { analysisWaitRecovery: true } });
    const first = analysisRecoveryFor(qc, createApi(URL), URL, "first-test-session"); controllers.push(first);
    const job = first.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(0);
    invalidateAnalysisRecoveryScope(qc, URL, "second-test-session");
    finish(json(record(2)));
    await job;
    expect(qc.getQueryData(key())).toEqual(record(1));
    expect(first.disposed).toBe(true);
  });

  it("첫 상태 조회부터 연결 실패면 생성하지 않고 원인과 완료 미확인을 알린다", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; throw new TypeError("연결 실패"); });
    const { recovery } = setup();
    await recovery.start(CODE, "company");
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    expect(recovery.snapshot(CODE, "company").message).toContain("연결");
    expect(calls).toBe(1);
  });

  it("회수 중 상태 조회가 세 번 연속 실패하면 확인을 멈춘다", async () => {
    let states = 0;
    let generated = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!url.endsWith("/state")) { generated++; throw new TypeError("연결 실패"); }
      if (++states === 1) return json({ latest: record(1), running: true });
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
    expect(generated).toBe(0);
  });

  it("서버가 계속 처리 중이어도 회수 10분 뒤 확인을 멈추고 완료로 표시하지 않는다", async () => {
    let states = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url.endsWith("/state")).toBe(true);
      states++;
      return json({ latest: record(1), running: true });
    });
    const { recovery, qc } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(600_000);
    await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    expect(qc.getQueryData(key())).toEqual(record(1));
    const stopped = states;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(states).toBe(stopped);
  });

  it("다른 서버로 바꾸면 백그라운드 이전 서버 확인 요청도 멈춘다", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return json({ latest: record(1), running: true }); });
    const { qc, recovery: unused } = setup(); unused.dispose();
    qc.setQueryData([URL, "features"], { features: { analysisWaitRecovery: true } });
    const old = analysisRecoveryFor(qc, createApi(URL), URL, ""); controllers.push(old);
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
