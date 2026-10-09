import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import type { Analysis, AnalysisState } from "@/api/types";
import { AnalysisRecovery } from "@/lib/analysisRecovery";

const API = "https://analysis-return.test";
const CODE = "005930";
const key = [API, "analysis", CODE, "company"];
const record = (id: number, code = CODE): Analysis => ({ id, code, kind: "company", content: `${id}번 본문`, missing: [], model: "fake", cached: true, createdAt: "2026-12-28T08:30:00+09:00" });
const json = (body: unknown) => new Response(JSON.stringify(body));
const isState = (url: string) => new URL(url).pathname.endsWith("/state");
const state = (url: string, status: "pending" | "completed" | "failed", latest: Analysis | null, result: Analysis | null = null): AnalysisState => ({ latest, running: status === "pending", request: { id: new URL(url).searchParams.get("requestId")!, status, result } });
const later = (ms: number, body: unknown) => new Promise<Response>((resolve) => setTimeout(() => resolve(json(body)), ms));
const clients: QueryClient[] = [];
const controllers: AnalysisRecovery[] = [];
function setup(enabled: () => boolean = () => true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const recovery = new AnalysisRecovery(qc, createApi(API), API, enabled);
  clients.push(qc); controllers.push(recovery);
  return { qc, recovery };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-28T08:30:00+09:00")); });
afterEach(() => { controllers.splice(0).forEach((r) => r.dispose()); clients.splice(0).forEach((q) => q.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("분석 실패와 오래 가린 앱의 본문 회수", () => {
  it("생성이 먼저 실패해도 늦게 받은 기존 본문을 남기며 새 분석 완료로 표시하지 않는다", async () => {
    let generated = 0;
    vi.stubGlobal("fetch", (url: string) => {
      if (isState(url)) return later(30, state(url, "failed", record(1)));
      generated++;
      return Promise.resolve(new Response(JSON.stringify({ message: "분석 제공자가 응답하지 않습니다", code: "LLM_CONFIG" }), { status: 503 }));
    });
    const { qc, recovery } = setup();
    const job = recovery.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(30); await job;
    expect(qc.getQueryData(key)).toEqual(record(1));
    expect(recovery.snapshot(CODE, "company")).toMatchObject({ phase: "unknown", requestError: "분석 제공자가 응답하지 않습니다" });
    expect(generated).toBe(1);
  });

  it("복구 조회도 실패한 뒤 도착한 보조 기존 본문은 같은 요청에만 보존한다", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) throw new TypeError("연결 실패");
      if (++reads === 1) return later(30, state(url, "failed", record(1)));
      return json(state(url, "failed", null));
    });
    const { qc, recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0); await job;
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    await vi.advanceTimersByTimeAsync(30);
    expect(qc.getQueryData(key)).toEqual(record(1));
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
  });

  it("앞 요청의 늦은 본문은 새 요청이나 더 최근에 표시된 본문을 덮지 않는다", async () => {
    let reads = 0;
    let generated = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) {
        if (++generated === 1) throw new TypeError("연결 실패");
        return later(100, record(4));
      }
      reads++;
      if (reads === 1) return later(30, state(url, "failed", record(99)));
      if (reads === 2) return json(state(url, "failed", null));
      return later(20, state(url, "pending", record(1)));
    });
    const { qc, recovery } = setup();
    const first = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0); await first;
    qc.setQueryData(key, record(3));
    const second = recovery.start(CODE, "company", true);
    await vi.advanceTimersByTimeAsync(30);
    expect(qc.getQueryData(key)).toEqual(record(3));
    expect(recovery.snapshot(CODE, "company").phase).toBe("generating");
    await vi.advanceTimersByTimeAsync(70); await second;
    expect(qc.getQueryData(key)).toEqual(record(4));
  });

  it("보조 응답의 다른 종목 본문은 현재 종목이나 다른 종목 캐시에 넣지 않는다", async () => {
    vi.stubGlobal("fetch", (url: string) => isState(url) ? later(10, state(url, "pending", record(9, "TSLA"))) : later(20, record(2)));
    const { qc, recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(10);
    expect(qc.getQueryData([API, "analysis", "TSLA", "company"])).toBeUndefined();
    expect(qc.getQueryData(key)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10); await job;
  });

  it("타이머가 11분 가려졌다 돌아와도 마지막 읽기 한 번으로 자신의 완료를 회수한다", async () => {
    let done = false;
    let generated = 0;
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) { generated++; throw new TypeError("연결 실패"); }
      reads++;
      return json(state(url, done ? "completed" : "pending", record(1), done ? record(2) : null));
    });
    const { qc, recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.snapshot(CODE, "company").phase).toBe("recovering");
    const before = reads;
    done = true;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await vi.advanceTimersByTimeAsync(5_000); await job;
    expect(reads).toBe(before + 1);
    expect(generated).toBe(1);
    expect(qc.getQueryData(key)).toEqual(record(2));
    expect(recovery.snapshot(CODE, "company").phase).toBe("idle");
  });

  it("기한 뒤 마지막 읽기도 pending이면 다시 반복하지 않고 확인 불가로 멈춘다", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) throw new TypeError("연결 실패");
      reads++; return json(state(url, "pending", record(1)));
    });
    const { recovery } = setup();
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    const before = reads;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await vi.advanceTimersByTimeAsync(5_000); await job;
    expect(reads).toBe(before + 1);
    expect(recovery.snapshot(CODE, "company").phase).toBe("unknown");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(before + 1);
  });

  it("기한 뒤 마지막 읽기를 기다리다 기능이 꺼지면 늦은 결과를 쓰지 않는다", async () => {
    let enabled = true;
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!isState(url)) throw new TypeError("연결 실패");
      if (++reads <= 2) return json(state(url, "pending", record(1)));
      return later(100, state(url, "completed", record(2), record(2)));
    });
    const { qc, recovery } = setup(() => enabled);
    const job = recovery.start(CODE, "company");
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(3);
    enabled = false;
    await vi.advanceTimersByTimeAsync(100); await job;
    expect(qc.getQueryData(key)).not.toEqual(record(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(3);
  });
});
