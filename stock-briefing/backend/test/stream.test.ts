import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  /** sent 와 같은 순서의 보낸 시각 (가짜 시계에서 묶음 간격 확인용) */
  sentAt: number[] = [];
  readyState = 1;
  send(data: string) {
    this.sent.push(JSON.parse(data));
    this.sentAt.push(Date.now());
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  messages(type: string) {
    return this.sent.filter((m) => m["type"] === type);
  }
  times(type: string) {
    return this.sentAt.filter((_, i) => this.sent[i]?.["type"] === type);
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("장중 체결이 초당 20건 몰려도 앱에는 초당 4통 이하, 새 앱은 한 통에 여러 종목, 종목마다 마지막 값", async () => {
    // 실제 50ms 타이머는 OS 타이머 정밀도에 따라 1초에 17건만 나오기도 해서(QA-01) 가짜 시계로 입력을 정확히 20건 만든다
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 23, 1, 0, 0) });
    const codes = ["005930", "000660", "AAPL"];
    const live = new FakeLive();
    const stream = new PriceStream({ live, codes: async () => codes, batchMs: 250 });
    const modern = new FakeSocket();
    const legacy = new FakeSocket();
    stream.attach(modern);
    stream.attach(legacy);
    modern.emit("message", JSON.stringify({ type: "hello", batch: true }));
    await vi.advanceTimersByTimeAsync(0);
    const started = Date.now();
    const pushed = new Map<string, number>();
    const pushedAt: number[] = [];
    for (let n = 0; n < 20; n++) {
      const code = codes[n % 3]!;
      live.push(code, 70_000 + n, new Date(Date.UTC(2026, 8, 23, 1, 0, 0, n)).toISOString());
      pushed.set(code, 70_000 + n);
      pushedAt.push(Date.now());
      await vi.advanceTimersByTimeAsync(50); // 초당 20건
    }
    await vi.advanceTimersByTimeAsync(300);

    const batches = modern.messages("ticks");
    const at = modern.times("ticks");
    const sentTicks = batches.flatMap((b) => b["ticks"] as { code: string; price: number }[]);
    expect(modern.messages("tick")).toHaveLength(0);
    // 조용하던 중 첫 체결은 바로, 그 뒤로는 250ms 이상 간격 → 1초에 4통 이하
    expect(at[0]).toBe(started);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(250);
    expect(batches.length).toBeLessThanOrEqual(6); // 1.3초 동안 250ms 마다 → 최대 5~6통
    expect(sentTicks.length).toBeLessThan(20); // 20건이 종목별로 합쳐져 줄어든다
    for (const b of batches) {
      const inBatch = (b["ticks"] as { code: string }[]).map((t) => t.code);
      expect(new Set(inBatch).size).toBe(inBatch.length); // 한 통 안에 종목마다 하나
    }
    // 예전 앱은 종목별 tick 이지만 같은 묶음을 같은 때에 받는다 (역시 250ms 마다 종목당 1건)
    expect(legacy.messages("tick").map((m) => [m["code"], m["price"]])).toEqual(sentTicks.map((t) => [t.code, t.price]));
    expect(legacy.messages("tick").length).toBeLessThanOrEqual(batches.length * 3);
    // 마지막 값은 빠짐없이 도착
    for (const code of codes) {
      expect(sentTicks.filter((t) => t.code === code).at(-1)?.price).toBe(pushed.get(code));
      expect(live.get(code)!.price).toBe(pushed.get(code));
    }
    // 어느 체결이든 한 묶음 간격(250ms) 안에 앱으로 나간다
    for (const t of pushedAt) expect(at.find((a) => a >= t)! - t).toBeLessThanOrEqual(250);
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

  it("열림 판단에 등록 종목을 넘긴다 — 미국 주간거래처럼 토스 달력은 닫힘이어도 등록 종목 시장의 세션이 열려 있으면 3초 폴링", async () => {
    const { anySessionOpen } = await import("../src/services/liveSession.js");
    const { stateFromSession } = await import("../src/providers/market/calendar.js");
    // 한국 추석 휴장 · 뉴욕 목 20:59 (주간거래). 토스 달력 isOpen 은 둘 다 false
    const at = new Date("2026-09-25T09:59:00+09:00");
    const cal = { now: at.toISOString(), KR: stateFromSession("KR", at, "2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"), US: stateFromSession("US", at, "2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z") };
    expect(cal.KR.isOpen || cal.US.isOpen).toBe(false); // 예전 규칙이면 30초로 늦췄다
    const run = async (codes: string[]) => {
      const asked: string[][] = [];
      const seen: string[][] = [];
      const quick: QuickPriceSource = { name: "toss", getMany: async (c) => (asked.push(c), new Map()) };
      const stream = new PriceStream({ quickPrices: quick, codes: async () => codes, pollMs: 10, closedPollMs: 60_000, marketOpen: async (c) => (seen.push(c), anySessionOpen(c, cal, at)) });
      stream.attach(new FakeSocket());
      await new Promise((r) => setTimeout(r, 45));
      stream.stop();
      return { asked: asked.length, seen: seen[0] };
    };
    const both = await run(["035420", "VRT"]);
    expect(both.seen).toEqual(["035420", "VRT"]);
    expect(both.asked).toBeGreaterThan(2); // 늦추지 않고 계속
    expect((await run(["035420"])).asked).toBe(1); // 한국 종목만이면 휴장 → 접속 직후 한 번 뒤로는 늦춘다
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

  it("구독 중이어도 웹소켓이 이번 세션 체결을 주지 않는 종목(wsServed 밖)은 토스 웹으로 폴링한다 — 초록 점과 같은 기준", async () => {
    // 미국 주간거래: 웹소켓은 붙어 VRT·APH 를 구독 중이지만 20:00 뒤 미국 체결을 준 적이 없다 → 초록 점은 토스 웹 3초 갱신으로 켜진다.
    // 스트림이 구독 종목이라고 폴링하지 않으면 앱 가격은 30초(보정) 마다만 바뀐다
    const live = new FakeLive();
    const subscribed: LiveTicks["status"] = () => ({ enabled: true, connected: true, subscribed: ["trade:us:VRT", "trade:us:APH"], lastMessageAt: new Date().toISOString(), lastError: null });
    live.status = subscribed as unknown as FakeLive["status"];
    const run = async (served: string[] | Error) => {
      const asked: string[][] = [];
      const quick: QuickPriceSource = { name: "toss", getMany: async (c) => (asked.push(c), new Map(c.map((x) => [x, { code: x, price: 100.7, volume: null, timestamp: new Date().toISOString(), receivedAt: Date.now() }]))) };
      const stream = new PriceStream({
        live: live as unknown as LiveTicks & EventEmitter,
        quickPrices: quick,
        codes: async () => ["VRT", "APH"],
        pollMs: 60_000,
        wsServed: async () => {
          if (served instanceof Error) throw served;
          return new Set(served);
        },
      });
      const socket = new FakeSocket();
      stream.attach(socket);
      await new Promise((r) => setTimeout(r, 300)); // 접속 직후 한 번 폴링 + 250ms 묶음
      stream.stop();
      return { asked: asked[0] ?? [], ticks: socket.messages("tick").map((m) => m["code"]) };
    };
    const none = await run([]);
    expect(none.asked).toEqual(["VRT", "APH"]);
    expect(none.ticks.sort()).toEqual(["APH", "VRT"]);
    expect((await run(["VRT"])).asked).toEqual(["APH"]); // VRT 는 웹소켓이 이번 세션 체결을 준다
    expect((await run(["VRT", "APH"])).asked).toEqual([]);
    expect((await run(new Error("달력 실패"))).asked).toEqual(["VRT", "APH"]); // 모르면 폴링한다 (더 부르는 쪽으로)
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
