import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { SHORT_MS } from "../src/auth/authService.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { PriceStream, STREAM_CLOSE_SESSION, type StreamAccess, type StreamSocket } from "../src/services/priceStream.js";
import { fakeProviders } from "./helpers.js";

/**
 * 계정 A단계 검증 6차 M1: 실시간 스트림(/api/stream)은 연결할 때만이 아니라 **연결하는 동안에도** 주인 세션이어야 한다.
 * 예전에는 연결할 때 한 번만 확인해, 세션이 끝난 뒤(로그아웃·모든 기기에서 로그아웃·비밀번호 변경·OWNER_RESET_PASSWORD·기한 지남)에도
 * 이미 열린 연결로 주인 등록 종목의 snapshot·tick 과 'holdings'·'reconcile' 알림이 계속 갔다(같은 세션의 REST 는 401).
 * 비상 모드에 API 토큰만으로 연 연결도 보통 모드가 된 뒤 계속 받았다.
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.parse("2026-09-28T10:00:00+09:00");
const OWNER = "서성원";
const API = "secret-stream-1";

class FakeSocket extends EventEmitter implements StreamSocket {
  sent: Array<Record<string, unknown>> = [];
  closed: number | null = null;
  readyState = 1;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = code ?? 1000;
    this.emit("close");
  }
  types() {
    return this.sent.map((m) => m["type"]);
  }
}

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("PriceStream: 연결마다 연 세션을 적고, 끝난 세션의 연결을 닫는다 (단위)", () => {
  it("revoke: 맞는 연결만 닫고(닫기 코드 4401) 그 뒤로는 보내지 않는다", async () => {
    const stream = new PriceStream({ codes: async () => ["005930"] });
    const a = new FakeSocket();
    const b = new FakeSocket();
    const legacy = new FakeSocket(); // 연 사람을 모름 (예전 부름) — 세션 조건으로는 닫지 않는다
    stream.attach(a, { sessionId: 1, userId: 1 });
    stream.attach(b, { sessionId: 2, userId: 1 });
    stream.attach(legacy);
    await settle();
    expect(stream.revoke((x) => x.sessionId === 1)).toBe(1);
    expect(a.closed).toBe(STREAM_CLOSE_SESSION);
    expect(b.closed).toBeNull();
    stream.notify("holdings");
    stream.notify("reconcile");
    expect(a.types()).not.toContain("holdings");
    expect(b.types()).toEqual(expect.arrayContaining(["snapshot", "holdings", "reconcile"]));
    expect(legacy.types()).toContain("holdings");
    expect(stream.status().clients).toBe(2);
    stream.stop();
  });

  it("recheck: false 면 닫고, 확인이 실패(DB 오류)하면 두고, 확인 함수가 없으면 두고 — ping 마다 저절로 돈다", async () => {
    vi.useFakeTimers();
    try {
      let aliveA = true;
      const stream = new PriceStream({ codes: async () => [], pingMs: 1000 });
      const a = new FakeSocket();
      const broken = new FakeSocket();
      const plain = new FakeSocket();
      stream.attach(a, { sessionId: 1, userId: 1, recheck: async () => aliveA });
      stream.attach(broken, { sessionId: 2, userId: 1, recheck: async () => Promise.reject(new Error("DB 오류")) });
      stream.attach(plain, { sessionId: null, userId: null });
      await vi.advanceTimersByTimeAsync(1000);
      expect([a.closed, broken.closed, plain.closed]).toEqual([null, null, null]);
      aliveA = false;
      await vi.advanceTimersByTimeAsync(1000); // 다음 ping 에 다시 확인
      expect(a.closed).toBe(STREAM_CLOSE_SESSION);
      expect(broken.closed).toBeNull();
      expect(plain.closed).toBeNull();
      expect(await stream.recheck()).toBe(0);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("겹쳐 부른 recheck 는 한 번만 확인한다", async () => {
    const stream = new PriceStream({ codes: async () => [] });
    let calls = 0;
    const s = new FakeSocket();
    const access: StreamAccess = { sessionId: 1, userId: 1, recheck: async () => (calls++, await settle(5), false) };
    stream.attach(s, access);
    const [x, y] = await Promise.all([stream.recheck(), stream.recheck()]);
    expect(calls).toBe(1);
    expect(x + y).toBe(2); // 같은 실행의 결과를 둘 다 받는다
    expect(s.closed).toBe(STREAM_CLOSE_SESSION);
    stream.stop();
  });
});

describe("GET /api/stream: 세션이 끝나면 서버가 이미 열린 연결을 닫는다 (실제 웹소켓)", () => {
  interface World {
    app: FastifyInstance;
    db: Db;
    clock: { t: number };
  }
  const opened: World[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      s.on("error", () => undefined);
      if (s.readyState === WebSocket.OPEN) s.terminate();
    }
    for (const w of opened.splice(0)) {
      await w.app.close();
      await w.db.destroy();
    }
  });

  async function world(env: Record<string, string> = {}): Promise<World> {
    const clock = { t: T0 };
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: API, ...env }), db, providers: fakeProviders(), logger: false, enableScheduler: false, now: () => new Date(clock.t), auth: { scryptN: 1024 } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const w = { app, db, clock };
    opened.push(w);
    return w;
  }

  const bearer = { authorization: `Bearer ${API}` };
  const S = (token: string) => ({ ...bearer, "x-session-token": token });

  async function ownerLogin(app: FastifyInstance, remember = true, password = "1111"): Promise<string> {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: bearer, payload: { loginId: OWNER, password, remember } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  }

  interface Conn {
    ws: WebSocket;
    got: Array<Record<string, unknown>>;
    closed: Promise<number>;
  }

  /** 연결한다 (세션 머리글 또는 ?session=). 열리면 받은 메시지와 닫힘 코드를 모은다 */
  async function connect(app: FastifyInstance, session: string | null, via: "header" | "query" = "header"): Promise<Conn> {
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const q = session && via === "query" ? `?session=${encodeURIComponent(session)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream${q}`, { headers: session && via === "header" ? S(session) : bearer });
    sockets.push(ws);
    const got: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on("error", reject);
    });
    await settle(30);
    return { ws, got, closed };
  }

  /** 닫혔는지 (시간 안에) — 닫혔으면 코드, 아니면 null */
  const closedWithin = (c: Conn, ms = 1000) => Promise.race([c.closed, settle(ms).then(() => null)]);
  const handshake = async (app: FastifyInstance, session: string) => {
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers: S(session) });
    sockets.push(ws);
    return new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => resolve(-1));
    });
  };

  it("로그아웃(이 기기): 그 세션의 연결이 바로 닫혀 'holdings'·'reconcile' 알림이 더 가지 않는다 — 같은 세션으로 다시 붙으면 401", async () => {
    const { app } = await world();
    const token = await ownerLogin(app);
    const c = await connect(app, token);
    const q = await connect(app, token, "query"); // 웹(헤더를 못 붙임)의 ?session= 도 같다
    expect(c.got[0]?.["type"]).toBe("snapshot");
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: S(token) })).statusCode).toBeLessThan(300);
    expect(await closedWithin(c)).toBe(STREAM_CLOSE_SESSION);
    expect(await closedWithin(q)).toBe(STREAM_CLOSE_SESSION);
    const before = c.got.length;
    app.priceStream.notify("holdings");
    app.priceStream.notify("reconcile");
    await settle(50);
    expect(c.got.length).toBe(before);
    expect(app.priceStream.status().clients).toBe(0);
    expect(await handshake(app, token)).toBe(401);
  });

  it("모든 기기에서 로그아웃(다른 폰에서): 잃어버린 폰의 열린 연결도 닫힌다", async () => {
    const { app } = await world();
    const lost = await ownerLogin(app);
    const here = await ownerLogin(app);
    const lostConn = await connect(app, lost);
    const hereConn = await connect(app, here);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: S(here) })).statusCode).toBeLessThan(300);
    expect(await closedWithin(lostConn)).toBe(STREAM_CLOSE_SESSION);
    expect(await closedWithin(hereConn)).toBe(STREAM_CLOSE_SESSION);
  });

  it("비밀번호 변경: 다른 세션의 연결은 닫히고 바꾼 이 세션의 연결은 그대로", async () => {
    const { app } = await world();
    const other = await ownerLogin(app);
    const here = await ownerLogin(app);
    const otherConn = await connect(app, other);
    const hereConn = await connect(app, here);
    const r = await app.inject({ method: "POST", url: "/api/auth/password", headers: S(here), payload: { current: "1111", next: "newpass123", nextConfirm: "newpass123" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await closedWithin(otherConn)).toBe(STREAM_CLOSE_SESSION);
    expect(await closedWithin(hereConn, 200)).toBeNull();
    app.priceStream.notify("holdings");
    await settle(50);
    expect(hereConn.got.map((m) => m["type"])).toContain("holdings");
  });

  it("OWNER_RESET_PASSWORD(비상 되돌리기): 주인의 모든 연결이 닫힌다", async () => {
    const { app } = await world();
    const c = await connect(app, await ownerLogin(app));
    expect(await app.authService.resetOwnerPassword("reset-pass-77")).toBe("reset");
    expect(await closedWithin(c)).toBe(STREAM_CLOSE_SESSION);
  });

  it("기한 지남(자동 로그인 끔 12시간): ping 때 다시 확인해 닫는다 — 살아 있는 세션은 그대로", async () => {
    const { app, clock } = await world();
    const short = await ownerLogin(app, false);
    const long = await ownerLogin(app, true);
    const s = await connect(app, short);
    const l = await connect(app, long);
    expect(await app.priceStream.recheck()).toBe(0);
    clock.t += SHORT_MS + 60_000;
    expect(await app.priceStream.recheck()).toBe(1);
    expect(await closedWithin(s)).toBe(STREAM_CLOSE_SESSION);
    expect(await closedWithin(l, 200)).toBeNull();
  });

  it("다시 확인이 DB 오류면 닫지 않는다 (로그아웃 아님 — 다음 ping 에 다시)", async () => {
    const { app } = await world();
    const c = await connect(app, await ownerLogin(app));
    const spy = vi.spyOn(app.authService, "authenticate").mockRejectedValue(new Error("DB 오류"));
    try {
      expect(await app.priceStream.recheck()).toBe(0);
      expect(await closedWithin(c, 200)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("비상 모드(플래그 끔)에 API 토큰만으로 연 연결은 보통 모드(플래그 켬)로 바꾸는 순간 닫힌다 — 주인 세션으로 연 연결은 그대로", async () => {
    const { app } = await world();
    const owner = await ownerLogin(app);
    expect((await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(owner), payload: { accounts: false } })).statusCode).toBe(200);
    const tokenOnly = await connect(app, null);
    const withSession = await connect(app, owner);
    expect(tokenOnly.got[0]?.["type"]).toBe("snapshot");
    // 비상 모드에는 두 연결 모두 그대로 (계정 전처럼 API 토큰 = 주인)
    expect(await app.priceStream.recheck()).toBe(0);
    // 보통 모드로 (비상 모드라 API 토큰만으로 관리 경로가 열려 있다)
    expect((await app.inject({ method: "PUT", url: "/api/admin/features", headers: bearer, payload: { accounts: true } })).statusCode).toBe(200);
    expect(await closedWithin(tokenOnly)).toBe(STREAM_CLOSE_SESSION);
    expect(await closedWithin(withSession, 200)).toBeNull();
    // 세션 없이 다시 붙으면 관문에서 막힌다
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const again = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers: bearer });
    sockets.push(again);
    expect(await new Promise<number>((r) => again.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)))).toBe(403);
  });
});
