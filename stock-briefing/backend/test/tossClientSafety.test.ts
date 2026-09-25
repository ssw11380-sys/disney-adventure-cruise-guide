import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/lib/errors.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { TossOpenApiClient, TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { TossRealtime, type SocketLike } from "../src/providers/market/tossRealtime.js";
import { FakeQuoteProvider } from "./helpers.js";
import { NOW } from "./tossFake.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** p 가 ms 안에 끝나면 그 값(실패면 오류 객체), 아니면 "pending" */
function settle<T>(p: Promise<T>, ms = 2_000): Promise<T | unknown> {
  return Promise.race([p.then((v) => v, (e: unknown) => e), sleep(ms).then(() => "pending")]);
}

/**
 * 연결은 받지만 답하지 않는 로컬 토스 서버 (실제 fetch·undici 로 확인).
 *  - /oauth2/token: stallToken 이면 답하지 않음, 아니면 토큰
 *  - /api/v1/prices: 헤더만 보내고 본문이 멈춤
 *  - 그 밖(/api/v1/candles 등): 아무 답도 없음
 */
async function stallServer(opts: { stallToken?: boolean } = {}) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    hits.push(path);
    if (path === "/oauth2/token") {
      if (opts.stallToken) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "tok-1", expires_in: 86400 }));
      return;
    }
    if (path === "/api/v1/prices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"result": [');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

describe("BH-09 토스 Open API 요청 제한 시간", () => {
  it("응답 헤더가 오지 않거나 본문이 멈추면 제한 시간 뒤 ProviderError 로 끊는다", async () => {
    const srv = await stallServer();
    try {
      const c = new TossOpenApiClient({ clientId: "c", clientSecret: "s", baseUrl: srv.base, now: NOW, maxRetryWaitMs: 0, timeoutMs: 200 });
      const noHeaders = await settle(c.get("/api/v1/candles", { symbol: "005930", interval: "1d" }));
      expect(noHeaders).toBeInstanceOf(ProviderError);
      expect(String((noHeaders as Error).message)).toContain("시간 초과");
      const stuckBody = await settle(c.get("/api/v1/prices", { symbols: "005930" }));
      expect(stuckBody).toBeInstanceOf(ProviderError);
      expect(c.status.lastError).toContain("시간 초과");
    } finally {
      await srv.close();
    }
  });

  it("토큰 발급이 멈춰도 제한 시간 뒤 실패한다", async () => {
    const srv = await stallServer({ stallToken: true });
    try {
      const c = new TossOpenApiClient({ clientId: "c", clientSecret: "s", baseUrl: srv.base, now: NOW, maxRetryWaitMs: 0, timeoutMs: 200 });
      const r = await settle(c.getToken());
      expect(r).toBeInstanceOf(ProviderError);
    } finally {
      await srv.close();
    }
  });

  it("공식 API 가 멈추면 차트(체인)는 다음 소스로 넘어간다", async () => {
    const srv = await stallServer();
    try {
      const c = new TossOpenApiClient({ clientId: "c", clientSecret: "s", baseUrl: srv.base, now: NOW, maxRetryWaitMs: 0, timeoutMs: 200 });
      const chain = new QuoteProviderChain([new TossOpenApiProvider(c, { now: NOW }), new FakeQuoteProvider("toss")]);
      const r = await settle(chain.getCandles("005930", "D", 30));
      expect(r).toMatchObject({ source: "toss" });
      expect(srv.hits).toContain("/api/v1/candles");
    } finally {
      await srv.close();
    }
  });
});

describe("BH-10 동시에 받은 401 은 새 토큰 하나를 같이 쓴다", () => {
  /** 클라이언트당 유효 토큰 1개 (발급하면 이전 토큰 즉시 무효). 요청마다·시도마다 서버 도착 지연을 준다 */
  function oneTokenServer(delays: Record<string, number[]>, now: () => Date = NOW) {
    const state = { valid: "", issued: 0 };
    const tries: Record<string, number> = {};
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth2/token")) {
        state.issued++;
        state.valid = `tok-${state.issued}`;
        return json({ access_token: state.valid, expires_in: 86400 });
      }
      const sym = url.searchParams.get("symbols") ?? "";
      const n = (tries[sym] = (tries[sym] ?? 0) + 1);
      await sleep(delays[sym]?.[n - 1] ?? 0);
      const auth = ((init?.headers as Record<string, string> | undefined) ?? {})["authorization"];
      if (auth !== `Bearer ${state.valid}`) return json({ error: { code: "token-revoked", message: "토큰이 무효화되었습니다." } }, 401);
      return json({ result: [{ symbol: sym }] });
    }) as typeof fetch;
    return { state, client: new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now, maxRetryWaitMs: 0 }) };
  }

  it("늦게 온 401 이 방금 받은 토큰을 다시 무효로 만들지 않는다 (재발급 1번, 두 요청 모두 성공)", async () => {
    // A: 바로 401 → 새 토큰 → 재시도는 100ms 뒤 도착. B: 50ms 뒤 옛 토큰으로 401 → 이미 받은 새 토큰을 써야 한다
    const { state, client } = oneTokenServer({ A: [0, 100], B: [50, 0] });
    await client.getToken();
    state.valid = "external"; // 같은 키로 다른 곳에서 발급 → 들고 있던 토큰이 무효
    const before = state.issued;
    const r = await Promise.allSettled([client.get("/api/v1/prices", { symbols: "A" }), client.get("/api/v1/prices", { symbols: "B" })]);
    expect(r.map((x) => (x.status === "fulfilled" ? "ok" : String((x.reason as Error).message)))).toEqual(["ok", "ok"]);
    expect(state.issued - before).toBe(1);
  });

  class FakeSocket extends EventEmitter implements SocketLike {
    send() {}
    close() {
      this.emit("close");
    }
  }

  /** 실시간 소켓이 연결에 쓴 토큰을 받게 하고, 시계를 움직일 수 있게 */
  async function withRealtime(delays: Record<string, number[]>) {
    const clock = { t: Date.parse("2026-09-22T14:00:00+09:00") };
    const srv = oneTokenServer(delays, () => new Date(clock.t));
    const sockets: Array<{ socket: FakeSocket; auth: string }> = [];
    const rt = new TossRealtime(srv.client, {
      socketFactory: (_url, headers) => {
        const socket = new FakeSocket();
        sockets.push({ socket, auth: headers["authorization"] ?? "" });
        return socket;
      },
    });
    rt.start();
    rt.setCodes(["005930"]);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    return { ...srv, clock, rt, sockets };
  }

  it("실시간 소켓 핸드셰이크 401 이 방금 REST 가 받은 토큰을 다시 무효로 만들지 않는다 (소켓은 거절된 토큰을 넘기지 않는다)", async () => {
    const { state, client, clock, rt, sockets } = await withRealtime({ A: [0, 100] });
    expect(sockets[0]!.auth).toBe("Bearer tok-1");
    clock.t += 10 * 60_000; // 토큰을 받은 지 한참 뒤
    state.valid = "external"; // 들고 있던 토큰이 무효
    const before = state.issued;
    // REST: 바로 401 → 새 토큰 → 재시도는 100ms 뒤 도착. 그 사이 소켓(옛 토큰)의 핸드셰이크도 401
    const rest = client.get("/api/v1/prices", { symbols: "A" }).then(
      () => "ok",
      (e: unknown) => String((e as Error).message),
    );
    await sleep(30);
    sockets[0]!.socket.emit("unexpected-response", {}, { statusCode: 401 });
    expect(await rest).toBe("ok");
    expect(state.issued - before).toBe(1);
    expect(await client.getToken()).toBe(state.valid); // 다음 소켓 연결도 이 토큰
    rt.stop();
  });

  it("소켓만 지금 토큰으로 401 을 받으면 새 토큰을 받아 다음 연결에 쓴다", async () => {
    const { state, client, clock, rt, sockets } = await withRealtime({});
    clock.t += 10 * 60_000;
    state.valid = "external";
    const before = state.issued;
    sockets[0]!.socket.emit("unexpected-response", {}, { statusCode: 401 });
    await vi.waitFor(() => expect(state.issued - before).toBe(1));
    expect(await client.getToken()).toBe(state.valid);
    rt.stop();
  });

  it("401 뒤 429 를 받아도 세 번째 시도에서 토큰을 또 새로 받지 않는다", async () => {
    let issued = 0;
    let n = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/oauth2/token")) return json({ access_token: `tok-${++issued}`, expires_in: 86400 });
      n++;
      if (n === 1) return json({ error: { code: "expired-token" } }, 401);
      if (n === 2) return new Response(JSON.stringify({ error: { code: "rate-limit-exceeded" } }), { status: 429, headers: { "retry-after": "0" } });
      return json({ result: [] });
    }) as typeof fetch;
    const c = new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, maxRetryWaitMs: 0 });
    await expect(c.get("/api/v1/prices", { symbols: "005930" })).resolves.toEqual([]);
    expect(issued).toBe(2);
  });
});
