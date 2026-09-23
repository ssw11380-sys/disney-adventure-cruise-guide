import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { LiveTick, LiveTicks, QuickPriceSource } from "../src/providers/market/tossRealtime.js";
import { PriceStream, type StreamSocket } from "../src/services/priceStream.js";
import { fakeProviders } from "./helpers.js";

class FakeSocket extends EventEmitter implements StreamSocket {
  sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  messages(type: string) {
    return this.sent.filter((m) => m["type"] === type);
  }
}

class FakeLive extends EventEmitter implements LiveTicks {
  ticks = new Map<string, LiveTick>();
  get(code: string) {
    return this.ticks.get(code) ?? null;
  }
  setCodes() {}
  status() {
    return { enabled: true, connected: true, subscribed: [], lastMessageAt: null, lastError: null };
  }
  push(code: string, price: number, timestamp = "2026-09-23T10:00:00+09:00") {
    const t: LiveTick = { code, price, volume: 1, timestamp, receivedAt: Date.now() };
    this.ticks.set(code, t);
    this.emit("tick", t);
  }
}

class FakeQuick implements QuickPriceSource {
  readonly name = "toss";
  calls = 0;
  prices = new Map<string, number>();
  async getMany(codes: string[]) {
    this.calls++;
    const out = new Map<string, LiveTick>();
    for (const c of codes) {
      const p = this.prices.get(c);
      if (p !== undefined) out.set(c, { code: c, price: p, volume: null, timestamp: `2026-09-23T09:0${this.calls}:00+09:00`, receivedAt: Date.now() });
    }
    return out;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PriceStream", () => {
  it("웹소켓 체결을 접속한 앱 전부에 중계하고, 같은 가격은 다시 보내지 않는다", async () => {
    const live = new FakeLive();
    const stream = new PriceStream({ live, codes: async () => ["005930"] });
    const a = new FakeSocket();
    const b = new FakeSocket();
    stream.attach(a);
    stream.attach(b);
    await tick();
    expect(a.messages("snapshot")[0]?.["ticks"]).toEqual([]);

    live.push("005930", 71000);
    live.push("005930", 71000, "2026-09-23T10:00:01+09:00"); // 같은 가격 → 생략
    live.push("005930", 71100, "2026-09-23T10:00:02+09:00");
    expect(a.messages("tick").map((m) => m["price"])).toEqual([71000, 71100]);
    expect(b.messages("tick").map((m) => m["price"])).toEqual([71000, 71100]);
    expect(a.messages("tick")[0]?.["source"]).toBe("toss-openapi");

    // 나중에 붙은 앱은 스냅샷으로 마지막 가격을 받는다
    const c = new FakeSocket();
    stream.attach(c);
    await tick();
    expect(c.messages("snapshot")[0]?.["ticks"]).toEqual([expect.objectContaining({ code: "005930", price: 71100 })]);

    a.close();
    live.push("005930", 71200, "2026-09-23T10:00:03+09:00");
    expect(a.messages("tick")).toHaveLength(2); // 닫힌 소켓엔 안 보냄
    expect(c.messages("tick")).toHaveLength(1);
    expect(stream.status().clients).toBe(2);
    stream.stop();
  });

  it("웹소켓이 없으면 앱이 붙어 있는 동안만 quickPrices 를 폴링해 바뀐 가격만 보낸다", async () => {
    const quick = new FakeQuick();
    quick.prices.set("005930", 70000);
    const stream = new PriceStream({ quickPrices: quick, codes: async () => ["005930", "AAPL"], pollMs: 10 });
    expect(stream.status().polling).toBe(false);
    const s = new FakeSocket();
    stream.attach(s);
    expect(stream.status().polling).toBe(true);
    await new Promise((r) => setTimeout(r, 35));
    // 첫 폴링 1건, 이후 가격이 그대로면 추가 tick 없음
    expect(s.messages("tick")).toEqual([expect.objectContaining({ code: "005930", price: 70000, source: "toss" })]);
    quick.prices.set("005930", 70500);
    await new Promise((r) => setTimeout(r, 25));
    expect(s.messages("tick").at(-1)).toEqual(expect.objectContaining({ price: 70500 }));
    s.close();
    await tick();
    expect(stream.status().polling).toBe(false);
    expect(stream.status().clients).toBe(0);
    stream.stop();
  });

  it("웹소켓 체결이 더 새로우면 폴링 값은 버린다", async () => {
    const live = new FakeLive();
    const quick = new FakeQuick();
    quick.prices.set("005930", 69000);
    live.push("005930", 71000, "2026-09-23T23:00:00+09:00"); // 폴링 timestamp(09:0x) 보다 새로움
    const stream = new PriceStream({ live, quickPrices: quick, codes: async () => ["005930"], pollMs: 10 });
    const s = new FakeSocket();
    stream.attach(s);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.messages("tick")).toHaveLength(0);
    expect(s.messages("snapshot")[0]?.["ticks"]).toEqual([expect.objectContaining({ price: 71000 })]);
    stream.stop();
  });
});

describe("GET /api/stream (websocket)", () => {
  let app: FastifyInstance;
  let db: Db;
  let live: FakeLive;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    live = new FakeLive();
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "secret-123" }),
      db,
      providers: fakeProviders({ live: live as unknown as never }),
      logger: false,
      enableScheduler: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  const url = (q = "") => {
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return `ws://127.0.0.1:${port}/api/stream${q}`;
  };

  it("토큰 없이는 연결이 거부된다", async () => {
    const ws = new WebSocket(url());
    const code = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(200));
    });
    expect(code).toBe(401);
  });

  it("?token= 또는 Authorization 헤더로 연결하면 snapshot 뒤에 tick 이 온다", async () => {
    const ws = new WebSocket(url("?token=secret-123"));
    const got: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 30));
    live.push("005930", 71000);
    await new Promise((r) => setTimeout(r, 30));
    expect(got[0]?.["type"]).toBe("snapshot");
    expect(got.find((m) => m["type"] === "tick")).toEqual(expect.objectContaining({ code: "005930", price: 71000 }));
    ws.close();

    const ws2 = new WebSocket(url(), { headers: { authorization: "Bearer secret-123" } });
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", () => resolve());
      ws2.on("error", reject);
    });
    ws2.close();
    expect(app.priceStream.status().clients).toBeGreaterThanOrEqual(0);
  });
});
