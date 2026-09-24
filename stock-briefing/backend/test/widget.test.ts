import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { MarketState, MarketStatus } from "../src/providers/market/calendar.js";
import { marketChip } from "../src/services/widgetPayload.js";
import { fakeProviders, FakeGenerator } from "./helpers.js";

const m = (market: "KR" | "US", isOpen: boolean, isTradingDay: boolean, at: string | null = null): MarketState => ({ market, isOpen, isTradingDay, opensAt: isOpen ? null : at, closesAt: isOpen ? at : null, source: "toss" });
const st = (kr: MarketState, us: MarketState): MarketStatus => ({ now: "", KR: kr, US: us });

describe("위젯 장 상태 칩 (3-16): 앱 잔고 탭 띠와 같은 규칙", () => {
  it("장중·휴장·장 마감, 다음 바뀌는 시각", () => {
    expect(marketChip(st(m("KR", true, true, "2026-09-23T11:00:00Z"), m("US", false, true, "2026-09-23T08:00:00Z")))).toEqual({ label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: "2026-09-23T08:00:00Z" });
    expect(marketChip(st(m("KR", true, true), m("US", true, true))).label).toBe("실시간");
    expect(marketChip(st(m("KR", false, false), m("US", true, true))).label).toBe("미국 장중");
    expect(marketChip(st(m("KR", false, false, "2026-09-28T23:00:00Z"), m("US", false, false, "2026-09-26T08:00:00Z")))).toEqual({ label: "휴장", open: false, kr: false, us: false, nextChangeAt: "2026-09-26T08:00:00Z" });
    expect(marketChip(st(m("KR", false, false), m("US", false, true))).label).toBe("한국 휴장");
    expect(marketChip(st(m("KR", false, true), m("US", false, true))).label).toBe("장 마감");
  });
});

describe("GET /api/widget (3-16)", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new FakeGenerator() }), logger: false, enableScheduler: false, now: () => new Date("2026-09-22T10:00:00+09:00") });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: 10, avgPrice: 150_000 } });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930", quantity: 1, avgPrice: 70_000 } });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "247540" } });
  });
  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("위젯이 쓰는 칸만 한 번에, 브리핑은 보유 비중 상위 3종목", async () => {
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", force: true } });
    const r = await app.inject({ method: "GET", url: "/api/widget" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.v).toBe(1);
    expect(body.stocks).toHaveLength(3);
    const hynix = body.stocks.find((s: { c: string }) => s.c === "000660");
    // 짧은 키: [가격, 전일 대비, 등락률, 통화, 시각, 환율, 지연] / [평가금, 매입금, 비용 차감 평가금, 원화 매입금, 출처]
    expect(hynix).toMatchObject({ n: "SK하이닉스", qty: 10, avg: 150_000 });
    expect(hynix.q).toHaveLength(7);
    expect(hynix.q[3]).toBe("KRW");
    expect(hynix.e[0]).toBe(hynix.q[0] * 10);
    expect(hynix.e[1]).toBe(1_500_000);
    expect(body.briefings.map((b: { code: string }) => b.code)).toEqual(["000660", "005930", "247540"]); // 평가금 큰 순, 관심 종목은 뒤
    expect(body.briefings[0]).toMatchObject({ session: "morning", summary: expect.any(String) });
    expect(body.briefings[0].summary).not.toContain("\n"); // 위젯은 첫 줄만 쓴다
    expect(body.latestIds).toHaveLength(3);
  });

  it("같은 내용이면 304, gzip 을 받으면 압축", async () => {
    const r1 = await app.inject({ method: "GET", url: "/api/widget", headers: { "accept-encoding": "gzip" } });
    expect(r1.headers["content-encoding"]).toBe("gzip");
    const json = JSON.parse(gunzipSync(r1.rawPayload).toString("utf8"));
    expect(json.stocks).toHaveLength(3);
    const etag = String(r1.headers["etag"]);
    expect(etag).toMatch(/^"[\w-]{16}"$/);
    const r2 = await app.inject({ method: "GET", url: "/api/widget", headers: { "if-none-match": etag } });
    expect(r2.statusCode).toBe(304);
    expect(r2.rawPayload.length).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/widget", headers: { "if-none-match": `W/${etag}, "other"` } })).statusCode).toBe(304); // 약한 ETag·여러 개
    const r3 = await app.inject({ method: "GET", url: "/api/widget", headers: { "if-none-match": '"stale"' } });
    expect(r3.statusCode).toBe(200);
  });
});
