import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { TossAccountSnapshotBody } from "../src/routes/admin.js";
import { widgetRoutes } from "../src/routes/widget.js";
import { FeatureService } from "../src/services/featureService.js";
import { evaluate, type RegisteredWithQuote } from "../src/services/stockService.js";
import { TossAccountSnapshotStore, type TossAccountSnapshot } from "../src/services/tossAccountSnapshot.js";
import { fakeProviders, FakeGenerator, makeQuote } from "./helpers.js";

const snapshot: TossAccountSnapshot = {
  source: "toss-openapi", scope: "all-toss-stock-holdings", excludesCash: true, includesExcludedHoldings: true,
  receivedFrom: "2026-10-04T10:00:00+09:00", receivedAt: "2026-10-04T10:00:01+09:00",
  accountCount: 1, holdingCount: 1, excludedHoldingCount: 0,
  gross: { krw: 10_000, usd: 0 }, net: { krw: 9_990, usd: 0 }, displayFx: null,
  costBasis: { krw: 11_000, estimatedHoldingCount: 0, holdingCount: 1, source: "synced-holdings-cost-book" },
};
const sync = { enabled: true, intervalMin: 5, idleIntervalMin: 30, lastRunAt: snapshot.receivedAt, nextRunAt: "2026-10-04T10:30:01+09:00", lastError: null };
const body = (): TossAccountSnapshotBody => ({ on: true, snapshot, sync });

describe("위젯 토스 계좌 기준: 저장본만 한 번 전달하고 기존 시세를 보존", () => {
  let app: ReturnType<typeof Fastify>;
  const read = vi.fn(async (): Promise<TossAccountSnapshotBody> => body());
  const stocks = vi.fn(async (): Promise<RegisteredWithQuote[]> => []);
  const latest = vi.fn(async () => []);
  const calendar = vi.fn(async () => null);
  beforeEach(async () => {
    vi.clearAllMocks(); read.mockImplementation(async () => body()); stocks.mockImplementation(async () => []);
    app = Fastify();
    await app.register(widgetRoutes, { prefix: "/api/widget", stocks: { listWithQuotes: stocks } as never,
      briefings: { latestPerStock: latest } as never, calendar: { status: calendar } as never,
      tossAccount: read,
    });
  });
  afterEach(async () => { await app.close(); });

  it("요청 표시가 없으면 조회하지 않고 기존 본문과 ETag를 유지한다", async () => {
    const previous = await app.inject("/api/widget?ms=1");
    expect(read).not.toHaveBeenCalled();
    expect(previous.json()).not.toHaveProperty("tossAccount");
    expect(previous.json().features).toBeUndefined();
    const etag = `"${createHash("sha1").update(previous.body).digest("base64url").slice(0, 16)}"`;
    expect(previous.headers.etag).toBe(etag);
  });

  it("명시한 새 요청에만 같은 동기화 평가·원금·실패 상태를 전달한다", async () => {
    const previous = await app.inject("/api/widget?ms=1");
    const response = await app.inject("/api/widget?ms=1&account=1");
    expect(response.statusCode).toBe(200);
    expect(response.json().tossAccount).toEqual(body());
    expect(response.json().features.tossAccountSnapshot).toBe(true);
    const { tossAccount: _account, features: _features, ...rest } = response.json();
    expect(rest).toEqual(previous.json());
    expect(read).toHaveBeenCalledTimes(1);
    expect([stocks, latest, calendar].map((f) => f.mock.calls.length)).toEqual([2, 2, 2]);
  });

  it("계좌 저장본이 같으면 304이고 저장 시각·원금·오류가 바뀌면 ETag도 바뀐다", async () => {
    const path = "/api/widget?account=1";
    const previous = await app.inject(path);
    const unchanged = await app.inject({ url: path, headers: { "if-none-match": String(previous.headers.etag) } });
    expect(unchanged.statusCode).toBe(304);
    read.mockResolvedValueOnce({ ...body(), snapshot: { ...snapshot, costBasis: { ...snapshot.costBasis!, krw: 12_000 } } });
    expect((await app.inject(path)).headers.etag).not.toBe(previous.headers.etag);
    read.mockResolvedValueOnce({ ...body(), sync: { ...sync, lastError: "계좌 동기화 실패" } });
    expect((await app.inject(path)).headers.etag).not.toBe(previous.headers.etag);
  });

  it("계좌 합계와 다른 개별 종목의 현재가·평가·원금은 원래 값 그대로 보낸다", async () => {
    const stock = { code: "005930", name: "검사용 종목", quantity: 2, avgPrice: 6_000, market: "KOSPI", memo: null,
      createdAt: snapshot.receivedAt, updatedAt: snapshot.receivedAt, quote: makeQuote("005930", "test", 7_000) };
    const item = { ...stock, evaluation: evaluate(stock as never, stock.quote) } as RegisteredWithQuote;
    stocks.mockResolvedValue([item]);
    const previous = (await app.inject("/api/widget")).json();
    const withAccount = (await app.inject("/api/widget?account=1")).json();
    expect(withAccount.stocks).toEqual(previous.stocks);
    expect(withAccount.stocks[0].q[0]).toBe(7_000);
    expect(withAccount.stocks[0].e.slice(0, 2)).toEqual([14_000, 12_000]);
    expect(withAccount.tossAccount.snapshot.net.krw).toBe(9_990);
    expect(withAccount.tossAccount.snapshot.costBasis.krw).toBe(11_000);
  });

  it("비활성 상태를 명시하고 계좌 칸이 없다고 실시간 기준으로 오인하지 않게 한다", async () => {
    read.mockResolvedValueOnce({ on: false, snapshot: null, sync: null });
    const response = await app.inject("/api/widget?account=1");
    expect(response.json().tossAccount).toEqual({ on: false, snapshot: null, sync: null });
    expect(response.json().features.tossAccountSnapshot).toBe(false);
  });

  it("읽기 실패에도 종목·브리핑 응답은 유지하고 계좌 기준을 사용 불가로 남긴다", async () => {
    read.mockRejectedValueOnce(new Error("저장소 읽기 실패"));
    const response = await app.inject("/api/widget?account=1");
    expect(response.statusCode).toBe(200);
    expect(response.json().tossAccount).toEqual({ on: true, snapshot: null, sync: null });
    expect(response.json().features.tossAccountSnapshot).toBe(true);
    expect(response.json().stocks).toEqual([]);
  });
});

describe("토스 계좌 조회의 관리 화면·위젯 공통 경로와 인증", () => {
  let db: Db;
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => { db = await createMigratedDb(":memory:"); });
  afterEach(async () => { await app?.close(); await db.destroy(); });
  it("실제 앱 등록 경로에서 인증 없는 요청·다른 토큰은 관리 화면과 위젯 모두 거절한다", async () => {
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "test-owner-only" }), db,
      providers: fakeProviders({ generator: new FakeGenerator() }), enableScheduler: false, logger: false });
    for (const url of ["/api/widget?account=1", "/api/admin/toss/account-snapshot"]) {
      expect((await app.inject(url)).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { authorization: "Bearer test-another-account" } })).statusCode).toBe(401);
      const valid = await app.inject({ url, headers: { authorization: "Bearer test-owner-only" } });
      expect(valid.statusCode).toBe(200);
      expect(url.includes("widget") ? valid.json().tossAccount : valid.json()).toEqual({ on: false, snapshot: null, sync: null });
    }
  });

  it("연동과 플래그가 켜진 공통 읽기는 저장된 값만 읽고 꺼지면 저장소도 부르지 않는다", async () => {
    const { readTossAccountSnapshot } = await import("../src/routes/admin.js");
    const store = new TossAccountSnapshotStore(db);
    await store.save(snapshot);
    const load = vi.spyOn(store, "load");
    const features = new FeatureService(db, () => new Date(snapshot.receivedAt));
    const toss = { sync: { accountSnapshots: store }, autoSync: { status: () => sync } } as never;
    const enabled = await readTossAccountSnapshot(toss, features);
    expect(enabled).toEqual(body());
    expect(load).toHaveBeenCalledTimes(1);
    await features.set({ tossAccountSnapshot: false });
    expect(await readTossAccountSnapshot(toss, features)).toEqual({ on: false, snapshot: null, sync: null });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await readTossAccountSnapshot(null, features)).toEqual({ on: false, snapshot: null, sync: null });
  });

  it("저장본 없음과 저장소 오류는 정상 금액으로 바꾸지 않고 동기화 상태를 함께 준다", async () => {
    const { readTossAccountSnapshot } = await import("../src/routes/admin.js");
    const store = new TossAccountSnapshotStore(db);
    const features = new FeatureService(db, () => new Date(snapshot.receivedAt));
    const toss = { sync: { accountSnapshots: store }, autoSync: { status: () => sync } } as never;
    expect(await readTossAccountSnapshot(toss, features)).toEqual({ on: true, snapshot: null, sync });
    vi.spyOn(store, "load").mockRejectedValueOnce(new Error("쓰기 잠금"));
    const failed = await readTossAccountSnapshot(toss, features);
    expect(failed.on).toBe(true);
    expect(failed.snapshot).toBeNull();
    expect(failed.sync?.lastError).toContain("읽지 못했습니다");
  });
});
