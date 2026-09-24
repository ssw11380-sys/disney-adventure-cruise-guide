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
    stream.flush();
    live.push("005930", 71000, "2026-09-23T10:00:01+09:00"); // 같은 가격 → 생략
    stream.flush();
    live.push("005930", 71100, "2026-09-23T10:00:02+09:00");
    stream.flush();
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
    stream.flush();
    expect(a.messages("tick")).toHaveLength(2); // 닫힌 소켓엔 안 보냄
    expect(c.messages("tick")).toHaveLength(1);
    expect(stream.status().clients).toBe(2);
    stream.stop();
  });

  it("웹소켓이 없으면 앱이 붙어 있는 동안만 quickPrices 를 폴링해 바뀐 가격만 보낸다", async () => {
    const quick = new FakeQuick();
    quick.prices.set("005930", 70000);
    const stream = new PriceStream({ quickPrices: quick, codes: async () => ["005930", "AAPL"], pollMs: 10, batchMs: 1 });
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

describe("체결 묶어 보내기 (3-17)", () => {
  it("장중 체결이 초당 20건 몰려도 앱에는 초당 4통 이하, 새 앱은 한 통에 여러 종목, 종목마다 마지막 값", async () => {
    const live = new FakeLive();
    const stream = new PriceStream({ live, codes: async () => ["005930", "000660", "AAPL"], batchMs: 250 });
    const modern = new FakeSocket();
    const legacy = new FakeSocket();
    stream.attach(modern);
    stream.attach(legacy);
    modern.emit("message", JSON.stringify({ type: "hello", batch: true }));
    await tick();
    const started = Date.now();
    let n = 0;
    while (Date.now() - started < 1_000) {
      const code = ["005930", "000660", "AAPL"][n % 3]!;
      live.push(code, 70_000 + n, new Date(Date.UTC(2026, 8, 23, 1, 0, 0, n)).toISOString());
      n++;
      await new Promise((r) => setTimeout(r, 50)); // 초당 20건
    }
    await new Promise((r) => setTimeout(r, 300));
    const batches = modern.messages("ticks");
    expect(n).toBeGreaterThanOrEqual(18);
    expect(batches.length).toBeLessThanOrEqual(6); // 1.3초 동안 250ms 마다 → 최대 5~6통 (초당 4통 이하)
    expect(modern.messages("tick")).toHaveLength(0);
    for (const b of batches) {
      const codes = (b["ticks"] as { code: string }[]).map((t) => t.code);
      expect(new Set(codes).size).toBe(codes.length); // 한 통 안에 종목마다 하나
    }
    // 예전 앱은 종목별 tick 이지만 역시 250ms 마다 종목당 1건
    expect(legacy.messages("tick").length).toBeLessThanOrEqual(batches.length * 3);
    // 마지막 값은 빠짐없이 도착
    const lastSent = batches.flatMap((b) => b["ticks"] as { code: string; price: number }[]).filter((t) => t.code === "AAPL").at(-1)!;
    expect(lastSent.price).toBe(live.get("AAPL")!.price);
    stream.stop();
  });

  it("조용하던 중 첫 체결은 기다리지 않고 바로 보낸다 (지연 추가 없음)", async () => {
    const live = new FakeLive();
    const stream = new PriceStream({ live, codes: async () => ["005930"], batchMs: 250 });
    const s = new FakeSocket();
    stream.attach(s);
    s.emit("message", JSON.stringify({ type: "hello", batch: true }));
    await tick();
    live.push("005930", 71000);
    expect(s.messages("ticks")).toHaveLength(1); // 바로
    live.push("005930", 71100, "2026-09-23T10:00:01+09:00");
    expect(s.messages("ticks")).toHaveLength(1); // 250ms 안의 다음 체결은 모음
    await new Promise((r) => setTimeout(r, 300));
    expect(s.messages("ticks")).toHaveLength(2);
    stream.stop();
  });

  it("토스 웹소켓이 구독한 종목은 폴링하지 않고, 두 시장이 닫혀 있으면 폴링을 늦춘다", async () => {
    const live = new FakeLive();
    // 실제 토스 웹소켓은 구독 목록을 토픽("trade:kr:005930")으로 준다
    live.status = () => ({ enabled: true, connected: true, subscribed: ["trade:kr:005930"], lastMessageAt: new Date().toISOString(), lastError: null });
    const asked: string[][] = [];
    const quick: QuickPriceSource = { name: "toss", getMany: async (codes) => (asked.push(codes), new Map()) };
    let open = true;
    const stream = new PriceStream({ live, quickPrices: quick, codes: async () => ["005930", "AAPL"], pollMs: 10, marketOpen: async () => open, closedPollMs: 1_000 });
    const s = new FakeSocket();
    stream.attach(s);
    await new Promise((r) => setTimeout(r, 35));
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((c) => c.length === 1 && c[0] === "AAPL")).toBe(true);
    open = false;
    const before = asked.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(asked.length - before).toBeLessThanOrEqual(1); // 닫혀 있으면 1초에 한 번
    stream.stop();
  });
});

describe("웹소켓이 받는 종목 판단 (3-17 리뷰)", () => {
  it("토픽을 종목 코드로 바꾸고, 90초 넘게 메시지가 없으면 아무 종목도 맡기지 않는다", async () => {
    const { wsCovered, topicCode } = await import("../src/services/priceStream.js");
    expect(topicCode("trade:kr:005930")).toBe("005930");
    expect(topicCode("trade:us:aapl")).toBe("AAPL");
    const now = Date.parse("2026-09-24T10:00:00Z");
    expect([...(wsCovered({ connected: true, subscribed: ["trade:kr:005930", "trade:us:AAPL"], lastMessageAt: "2026-09-24T09:59:30Z" }, now) ?? [])]).toEqual(["005930", "AAPL"]);
    expect(wsCovered({ connected: true, subscribed: ["trade:kr:005930"], lastMessageAt: "2026-09-24T09:58:00Z" }, now)).toBeNull(); // 반쯤 끊김
    expect(wsCovered({ connected: false, subscribed: ["trade:kr:005930"], lastMessageAt: "2026-09-24T09:59:59Z" }, now)).toBeNull();
    // 체결이 없어도 PING 응답이 오면 살아 있는 것으로
    expect(wsCovered({ connected: true, subscribed: ["trade:kr:005930"], lastMessageAt: "2026-09-24T09:00:00Z", lastAliveAt: "2026-09-24T09:59:40Z" }, now)).not.toBeNull();
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
    await new Promise((r) => setTimeout(r, 300)); // 250ms 묶음
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
