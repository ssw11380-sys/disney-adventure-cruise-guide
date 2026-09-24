import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, createApi } from "@/api/client";

/**
 * 공통 통신 제한 시간 (2026-09-24 점검 NET-01).
 * 헤더가 온 뒤 본문이 멈춰도 제한 시간(연결 확인 8초) 안에 요청을 끊고 "시간 초과"로 알린다.
 * 실제 로컬 HTTP 서버에 붙고, 제한 시간 타이머(setTimeout)만 가짜 시계로 돌린다.
 */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler = () => undefined;
/** 테스트마다 새로: 앞 테스트에서 끊은 연결의 close 가 늦게 와도 섞이지 않게 */
let seen = { requests: 0, cut: 0 };
const sockets = new Set<Socket>();
/**
 * 테스트마다 새 포트의 서버: fetch(undici)는 주소(origin)마다 연결 풀을 두는데, 앞 테스트가 가짜 시계로 끊은 요청의 풀 상태가 남으면
 * Node 22 에서 다음 요청이 서버에 가지 못하고 멈춘다(CI). 주소를 바꾸면 풀이 섞이지 않는다
 */
let server: http.Server;
const createServer = () => http.createServer((req, res) => {
  const s = seen;
  s.requests++;
  // 응답을 끝내기 전에 끊긴 요청 = 요청이 실제로 취소됨
  res.on("close", () => void (res.writableFinished ? null : s.cut++));
  handler(req, res);
});
let base = "";

const realFetch = globalThis.fetch;
/** fetch 가 헤더를 받아 Response 를 돌려준 횟수 */
let headers = 0;

beforeEach(async () => {
  server = createServer();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = () => undefined;
  seen = { requests: 0, cut: 0 };
  headers = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", async (...a: Parameters<typeof fetch>) => {
    const res = await realFetch(...a);
    headers++;
    return res;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

/** 끝났는지(성공·실패)를 기다리지 않고 볼 수 있게 */
function track<T>(p: Promise<T>) {
  const t = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  p.then(
    (v) => Object.assign(t, { settled: true, value: v }),
    (e: unknown) => Object.assign(t, { settled: true, error: e }),
  );
  return t;
}

/** 가짜 시계를 건드리지 않고 기다린다 (vi.waitFor 는 기다리는 동안 가짜 타이머를 앞으로 돌린다) */
async function until(cond: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("제한 시간 안에 끝나지 않음");
    await new Promise((r) => setImmediate(r));
  }
}
const settle = (t: { settled: boolean }) => until(() => t.settled);
const TIMEOUT = { status: 0, code: "TIMEOUT", message: "서버 응답이 없습니다 (시간 초과)" };

describe("요청 제한 시간 (NET-01)", () => {
  it("헤더만 오고 본문이 멈추면 8초에 시간 초과로 끝나고 요청을 실제로 끊는다", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      res.write("{");
    };
    const t = track(createApi(base).health());
    await until(() => headers === 1);
    vi.advanceTimersByTime(7_999);
    await new Promise((r) => setImmediate(r));
    expect(t.settled).toBe(false);
    vi.advanceTimersByTime(1);
    await settle(t);
    expect(t.error).toBeInstanceOf(ApiRequestError);
    expect(t.error).toMatchObject(TIMEOUT);
    await until(() => seen.cut === 1);
  });

  it("본문이 중간에 멈춰도 같다", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      res.write('{"status":"ok","db":');
    };
    const t = track(createApi(base).health());
    await until(() => headers === 1);
    vi.advanceTimersByTime(8_000);
    await settle(t);
    expect(t.error).toMatchObject(TIMEOUT);
    await until(() => seen.cut === 1);
  });

  it("헤더도 안 오는 연결 지연은 그대로 시간 초과", async () => {
    const t = track(createApi(base).health());
    await until(() => seen.requests === 1);
    vi.advanceTimersByTime(8_000);
    await settle(t);
    expect(headers).toBe(0);
    expect(t.error).toMatchObject(TIMEOUT);
    await until(() => seen.cut === 1);
  });

  it("본문이 늦어도 제한 시간 안에 끝나면 정상 응답, 끝난 뒤에는 타이머가 남지 않는다", async () => {
    let finish: (() => void) | null = null;
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      res.write('{"status":');
      finish = () => res.end('"ok"}');
    };
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const t = track(createApi(base).health());
    await until(() => headers === 1);
    vi.advanceTimersByTime(5_000);
    finish!();
    await settle(t);
    expect(t.error).toBeUndefined();
    expect(t.value).toEqual({ status: "ok" });
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
    expect(seen.cut).toBe(0);
  });

  it("204 는 본문 없이 끝나고 타이머가 남지 않는다", async () => {
    handler = (_req, res) => void res.writeHead(204).end();
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const t = track(createApi(base).removeStock("005930"));
    await settle(t);
    expect(t.error).toBeUndefined();
    expect(t.value).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("JSON 이 아닌 오류 본문(프록시 502)은 HTTP 오류로, 타이머가 남지 않는다", async () => {
    handler = (_req, res) => void res.writeHead(502, { "content-type": "text/html" }).end("<html>Bad Gateway</html>");
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const t = track(createApi(base).health());
    await settle(t);
    expect(t.error).toMatchObject({ status: 502, code: "HTTP_502", message: "서버 오류 (502)" });
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("서버에 연결할 수 없으면 연결 실패(시간 초과 아님), 타이머가 남지 않는다", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((r) => closed.close(() => r()));
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const t = track(createApi(url).health());
    await settle(t);
    expect(t.error).toMatchObject({ status: 0, code: "NETWORK" });
    vi.advanceTimersByTime(60_000);
    expect(abort).not.toHaveBeenCalled();
  });
});
