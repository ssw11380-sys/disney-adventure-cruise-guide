import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeGenerator } from "../src/llm/generator.js";
import type { LlmBackend } from "../src/llm/backend.js";

const backends: LlmBackend[] = [
  { kind: "anthropic", apiKey: "offline-placeholder", model: "offline-model" },
  { kind: "bedrock", bearerToken: "offline-placeholder", region: "us-east-1", model: "offline-model" },
];
const req = { system: "고정 시스템 자료", user: "고정 사용자 자료", maxTokens: 8192, effort: "high" as const };
const message = (stopReason = "end_turn") => ({
  id: "offline-message", type: "message", role: "assistant", model: "offline-model",
  content: [{ type: "text", text: "검증된 보고서 본문" }], stop_reason: stopReason, stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("생성기 응답 본문 시간 제한 — 실제 SDK, 가짜 통신만 사용", () => {
  it.each(backends)("$kind: 헤더 뒤 멈춘 본문도 기존 제한 안에 실패하고 SDK 재시도를 만들지 않는다", async (backend) => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const fakeFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fakeFetch);
    const generator = new ClaudeGenerator({ backend, timeoutMs: 20, maxRetries: 2 });
    let observed: "pending" | "success" | "failed" = "pending";
    const settled = generator.generate(req).then(
      (value) => { observed = "success"; return { value }; },
      (error: unknown) => { observed = "failed"; return { error }; },
    );
    await vi.advanceTimersByTimeAsync(21);
    const atDeadline = observed;
    const abortedAtDeadline = signal?.aborted;
    // 수정 전에도 테스트를 끝내고 SDK/타이머를 남기지 않는다.
    if (!cancelled) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(message())));
      controller.close();
    }
    const result = await settled;
    expect(atDeadline).toBe("failed");
    expect(abortedAtDeadline).toBe(true);
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ error: { kind: "api" } });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("본문 제한은 헤더 수신 뒤 새로 시작하지 않고 기존 요청 예산을 쓴다", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const fakeFetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(new ReadableStream<Uint8Array>({
        start(c) { controller = c; }, cancel() { cancelled = true; },
      }), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fakeFetch);
    let observed = "pending";
    const settled = new ClaudeGenerator({ backend: backends[0]!, timeoutMs: 20, maxRetries: 2 }).generate(req)
      .then(() => { observed = "success"; }, () => { observed = "failed"; });
    await vi.advanceTimersByTimeAsync(21);
    const atDeadline = observed;
    if (!cancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify(message()))); controller.close(); }
    await settled;
    expect(atDeadline).toBe("failed");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("설정 생략 시 본문 제한도 기존 300초이며 임의로 짧아지지 않는다", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { controller = c; }, cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } })));
    let observed = "pending";
    const settled = new ClaudeGenerator({ backend: backends[0]!, maxRetries: 0 }).generate(req)
      .then(() => { observed = "success"; }, () => { observed = "failed"; });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(observed).toBe("pending");
    await vi.advanceTimersByTimeAsync(2);
    const atDeadline = observed;
    if (!cancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify(message()))); controller.close(); }
    await settled;
    expect(atDeadline).toBe("failed");
  });

  it.each(backends)("$kind: 성공 응답·프롬프트·모델·토큰·effort·캐시 설정은 같다", async (backend) => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => json(message()));
    vi.stubGlobal("fetch", fakeFetch);
    const generator = new ClaudeGenerator({ backend, timeoutMs: 20 });
    const result = await generator.generate(req);
    expect(result).toEqual({ text: "검증된 보고서 본문", model: "offline-model", stopReason: "end_turn",
      usage: { input: 12, output: 8, cacheRead: 4, cacheWrite: 2 } });
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      model: "offline-model", max_tokens: 8192, output_config: { effort: "high" },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: req.user }],
      ...(backend.kind === "anthropic" ? { fallbacks: "default" } : {}),
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("기존 503 재시도 정책은 유지한다", async () => {
    vi.useFakeTimers();
    const fakeFetch = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } }))
      .mockResolvedValueOnce(json(message()));
    vi.stubGlobal("fetch", fakeFetch);
    const result = new ClaudeGenerator({ backend: backends[0]!, timeoutMs: 20, maxRetries: 1 }).generate(req);
    await vi.advanceTimersByTimeAsync(30);
    expect((await result).text).toBe("검증된 보고서 본문");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("헤더 수신 전 시간 초과에 대한 기존 SDK 재시도는 유지한다", async () => {
    vi.useFakeTimers();
    let firstSignal: AbortSignal | null | undefined;
    const fakeFetch = vi.fn().mockImplementationOnce(async (_input: unknown, init?: RequestInit) => {
      firstSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        firstSignal?.addEventListener("abort", () => reject(new DOMException("offline header timeout", "AbortError")), { once: true });
      });
    }).mockResolvedValueOnce(json(message()));
    vi.stubGlobal("fetch", fakeFetch);
    const result = new ClaudeGenerator({ backend: backends[0]!, timeoutMs: 20, maxRetries: 1 }).generate(req);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).text).toBe("검증된 보고서 본문");
    expect(firstSignal?.aborted).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("제한 안에서 여러 조각으로 받은 본문을 그대로 합치고 완료 뒤 타이머를 정리한다", async () => {
    vi.useFakeTimers();
    const encoded = new TextEncoder().encode(JSON.stringify(message()));
    const fakeFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(output) {
        setTimeout(() => output.enqueue(encoded.slice(0, 20)), 5);
        setTimeout(() => { output.enqueue(encoded.slice(20)); output.close(); }, 19);
      },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fakeFetch);
    const result = new ClaudeGenerator({ backend: backends[0]!, timeoutMs: 20 }).generate(req);
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).text).toBe("검증된 보고서 본문");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["max_tokens", "model_context_window_exceeded"])("%s로 중단된 본문을 완성 보고서로 반환하지 않는다", async (stopReason) => {
    const fakeFetch = vi.fn(async () => json(message(stopReason)));
    vi.stubGlobal("fetch", fakeFetch);
    await expect(new ClaudeGenerator({ backend: backends[0]!, maxRetries: 2 }).generate(req)).rejects.toMatchObject({ kind: "truncated" });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
