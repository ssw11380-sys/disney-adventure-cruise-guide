import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { TossOpenApiClient } from "../src/providers/market/tossOpenApi.js";
import { TossRealtime, type SocketLike } from "../src/providers/market/tossRealtime.js";
import { client, NOW } from "./tossFake.js";

/**
 * 토스 실시간 웹소켓 연결 관리 (버그 점검 BH-01·BH-63).
 *  - 핸드셰이크가 거절(401·403·429·5xx)되거나 멈춰도 소켓을 버리고 다시 연결한다 (예전: close 가 오지 않아 서버를 다시 켤 때까지 실시간이 꺼짐)
 *  - 토큰을 받는 사이 연결 요청이 겹쳐도 소켓은 하나 (예전: 둘 이상 생겨 옛 소켓의 close 가 살아 있는 연결을 끊긴 것으로 표시)
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

type Answer = number | "stall" | "accept";

/** 토스 웹소켓 대신 로컬 서버. 핸드셰이크마다 answer 가 정한다: HTTP 상태 코드로 거절 · 응답 없이 붙잡기(stall) · 수락 */
async function wsServer(answer: (n: number, auth: string) => Answer) {
  const wss = new WebSocketServer({ noServer: true });
  const auths: string[] = [];
  const held: Duplex[] = [];
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const auth = String(req.headers["authorization"] ?? "");
    auths.push(auth);
    const a = answer(auths.length, auth);
    if (a === "accept") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    else if (a === "stall") held.push(socket);
    else socket.end(`HTTP/1.1 ${a} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    auths,
    close: async () => {
      for (const s of held) s.destroy();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f();
});

describe("TossRealtime: 핸드셰이크가 거절되거나 멈춰도 다시 연결한다 (BH-01)", () => {
  it("403·503 으로 거절되면 소켓을 버리고 기다렸다 다시 연결한다 — 거절 까닭은 lastError·로그에 남는다", async () => {
    const srv = await wsServer((n) => (n === 1 ? 403 : n === 2 ? 503 : "accept"));
    const warns: string[] = [];
    const rt = new TossRealtime(client(), { url: srv.url, reconnectMs: 20, log: { warn: (o) => warns.push(JSON.stringify(o)) } });
    cleanups.push(() => rt.stop(), () => srv.close());
    rt.setCodes(["AAPL"]);
    expect(await until(() => rt.status().connected)).toBe(true);
    expect(srv.auths.length).toBe(3);
    expect(warns.some((w) => w.includes("403") && w.includes("허용 IP"))).toBe(true);
    expect(warns.some((w) => w.includes("503"))).toBe(true);
    expect(rt.status().lastError).toBeNull();
  });

  it("거절된 뒤에도 종목·계좌가 바뀌면 연결을 다시 시도한다 (붙잡힌 소켓이 없다)", async () => {
    let open = false;
    const srv = await wsServer(() => (open ? "accept" : 403));
    const rt = new TossRealtime(client(), { url: srv.url, reconnectMs: 60_000 });
    cleanups.push(() => rt.stop(), () => srv.close());
    rt.setCodes(["AAPL"]);
    expect(await until(() => rt.status().lastError?.includes("403") === true)).toBe(true);
    open = true; // 사용자가 허용 IP 를 등록했다
    rt.setCodes(["AAPL", "TSLA"]);
    expect(await until(() => rt.status().connected)).toBe(true);
    expect(srv.auths.length).toBe(2);
  });

  it("401(토큰 무효)이면 새 토큰을 받은 뒤 다시 연결한다", async () => {
    const srv = await wsServer((_n, auth) => (auth === "Bearer tok-1" ? 401 : "accept"));
    const rt = new TossRealtime(client(), { url: srv.url, reconnectMs: 20 });
    cleanups.push(() => rt.stop(), () => srv.close());
    rt.setAccounts([3]);
    expect(await until(() => rt.status().connected)).toBe(true);
    expect(srv.auths).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("핸드셰이크 응답이 오지 않으면 handshakeTimeoutMs 뒤 끊고 다시 연결한다", async () => {
    const srv = await wsServer((n) => (n === 1 ? "stall" : "accept"));
    const rt = new TossRealtime(client(), { url: srv.url, reconnectMs: 20, handshakeTimeoutMs: 150 });
    cleanups.push(() => rt.stop(), () => srv.close());
    rt.setCodes(["005930"]);
    expect(await until(() => rt.status().connected)).toBe(true);
    expect(srv.auths.length).toBe(2);
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  /** 실제 ws 처럼 close 이벤트를 나중에(다음 틱) 낸다 */
  constructor(private readonly lateClose = false) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    if (this.lateClose) setImmediate(() => this.emit("close"));
    else this.emit("close");
  }
}

/** 토큰 발급에 ms 가 걸리는 클라이언트 (발급 횟수를 센다) */
function slowClient(ms: number) {
  const issued = { n: 0 };
  const fetchFn = (async () => {
    await sleep(ms);
    issued.n++;
    return new Response(JSON.stringify({ access_token: `tok-${issued.n}`, token_type: "Bearer", expires_in: 86400 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: NOW }), issued };
}

describe("TossRealtime: 연결은 한 번에 하나 (BH-63)", () => {
  it("토큰을 받는 사이 setCodes·setAccounts 가 겹쳐도 소켓은 하나만 만들고, 열리면 마지막 목록으로 선언한다", async () => {
    const { client: slow, issued } = slowClient(50);
    const sockets: FakeSocket[] = [];
    const rt = new TossRealtime(slow, { socketFactory: () => (sockets.push(new FakeSocket()), sockets.at(-1)!) });
    cleanups.push(() => rt.stop());
    rt.setCodes(["AAPL"]);
    rt.setAccounts([3]);
    rt.setCodes(["AAPL", "TSLA"]);
    await sleep(150);
    expect(sockets.length).toBe(1);
    expect(issued.n).toBe(1);
    sockets[0]!.emit("open");
    const decl = JSON.parse(sockets[0]!.sent.at(-1)!) as Array<Record<string, unknown>>;
    expect(decl.slice(1)).toEqual([
      { type: "trade:us", codes: ["AAPL", "TSLA"] },
      { type: "personal:order", codes: ["3"] },
    ]);
  });

  it("멈췄다 다시 켜는 사이 옛 소켓의 close 가 늦게 와도 새 연결을 끊긴 것으로 보거나 소켓을 또 만들지 않는다", async () => {
    const sockets: FakeSocket[] = [];
    const rt = new TossRealtime(client(), { reconnectMs: 20, pingIntervalMs: 5, socketFactory: () => (sockets.push(new FakeSocket(true)), sockets.at(-1)!) });
    cleanups.push(() => rt.stop());
    rt.setCodes(["AAPL"]);
    expect(await until(() => sockets.length === 1)).toBe(true);
    const [s0] = sockets;
    s0!.emit("open");
    rt.stop();
    rt.start();
    expect(await until(() => sockets.length === 2)).toBe(true);
    const s1 = sockets[1]!;
    await new Promise((r) => setImmediate(r)); // s0 의 close 가 이제 온다
    s1.emit("open");
    expect(rt.status().connected).toBe(true);
    expect(s1.sent.some((x) => x.startsWith("["))).toBe(true); // 새 소켓에 구독 선언
    await sleep(60);
    expect(sockets.length).toBe(2); // 세 번째 소켓 없음
    expect(s1.sent.filter((x) => x === "PING").length).toBeGreaterThan(0); // 살아 있는 소켓의 PING 이 멈추지 않는다
    const s0Pings = s0!.sent.filter((x) => x === "PING").length;
    await sleep(30);
    expect(s0!.sent.filter((x) => x === "PING").length).toBe(s0Pings); // 닫은 소켓에는 PING 을 보내지 않는다
    rt.stop();
    expect(s1.closed).toBe(true);
  });
});
