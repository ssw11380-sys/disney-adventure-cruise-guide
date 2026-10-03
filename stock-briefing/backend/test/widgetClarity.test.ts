import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { widgetRoutes } from "../src/routes/widget.js";
import { FEATURES, FeatureService } from "../src/services/featureService.js";
import { buildWidgetPayload } from "../src/services/widgetPayload.js";
import type { RegisteredWithQuote } from "../src/services/stockService.js";
import { makeQuote } from "./helpers.js";

describe("위젯 정보 기준 플래그: 예전 본문 보존·추가 외부 호출 없음", () => {
  it("종목별 거래 대상은 새 기능을 켰을 때만 전달하고 가격·평가 수치는 보존한다", () => {
    const quote = makeQuote("AAPL", "test", 100);
    quote.session = { market: "US", phase: "overnight", label: "미국 주간거래", open: true, eligible: false, until: "2026-10-05T17:00:00+09:00" };
    const stock = { code: "AAPL", name: "애플", quantity: 1, avgPrice: 90, quote, evaluation: null } as RegisteredWithQuote;
    const previous = buildWidgetPayload([stock], [], null);
    const flags = { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true };
    const on = buildWidgetPayload([stock], [], null, { features: { ...flags, widgetClarity: true } });
    const off = buildWidgetPayload([stock], [], null, { features: { ...flags, widgetClarity: false } });
    expect(on.stocks[0]!.ss).toEqual(quote.session);
    expect(off.stocks).toEqual(previous.stocks);
    const { ss: _session, ...numbers } = on.stocks[0]!;
    expect(numbers).toEqual(previous.stocks[0]);
  });
  let db: Db;
  let app: ReturnType<typeof Fastify>;
  let features: FeatureService;
  const list = vi.fn(async () => []);
  const indices = vi.fn(async () => []);
  const latest = vi.fn(async () => []);
  const calendar = vi.fn(async () => null);
  beforeEach(async () => {
    vi.clearAllMocks();
    db = await createMigratedDb(":memory:");
    features = new FeatureService(db, () => new Date("2026-10-05T10:00:00+09:00"));
    app = Fastify();
    await app.register(widgetRoutes, {
      prefix: "/api/widget", features,
      stocks: { listWithQuotes: list } as never,
      briefings: { latestPerStock: latest } as never,
      calendar: { status: calendar } as never,
      indices: { list: indices } as never,
    });
  });
  afterEach(async () => { await app?.close(); await db?.destroy(); });

  it("기본 켜짐이며 지금 앱의 요청에만 true 칸을 더한다", async () => {
    expect(FEATURES.widgetClarity.default).toBe(true);
    const before = await app.inject("/api/widget");
    const now = await app.inject("/api/widget?ms=1");
    expect(before.json().features).not.toHaveProperty("widgetClarity");
    expect(now.json().features.widgetClarity).toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
    expect(calendar).toHaveBeenCalledTimes(2);
    expect(latest).toHaveBeenCalledTimes(2);
    expect(indices).not.toHaveBeenCalled();
  });

  it("꺼짐은 새 칸을 뺀 기존 본문·ETag와 같고 재조회도 304다", async () => {
    const on = await app.inject("/api/widget?ms=1");
    const previous = on.json();
    delete previous.features.widgetClarity;
    const previousBody = JSON.stringify(previous);
    await features.set({ widgetClarity: false });
    const off = await app.inject("/api/widget?ms=1");
    expect(off.body).toBe(previousBody);
    expect(off.headers.etag).toBe(`"${createHash("sha1").update(previousBody).digest("base64url").slice(0, 16)}"`);
    const unchanged = await app.inject({ url: "/api/widget?ms=1", headers: { "if-none-match": String(off.headers.etag) } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe("");
  });

  it("예전 요청은 켜고 꺼도 본문과 ETag가 동일하다", async () => {
    const on = await app.inject("/api/widget?ui=2&sessions=1");
    await features.set({ widgetClarity: false });
    const off = await app.inject("/api/widget?ui=2&sessions=1");
    expect(off.body).toBe(on.body);
    expect(off.headers.etag).toBe(on.headers.etag);
  });

  it("시장 줄과 판을 함께 받아도 자료원별 호출 수는 켜짐·꺼짐 모두 같다", async () => {
    const path = "/api/widget?ms=1&indices=1&board=1";
    await app.inject(path);
    expect([list, latest, calendar, indices].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    await features.set({ widgetClarity: false });
    await app.inject(path);
    expect([list, latest, calendar, indices].map((f) => f.mock.calls.length)).toEqual([2, 2, 2, 2]);
  });

  it("새 플래그 읽기가 실패해도 기존 자료와 응답은 유지하고 새 기능만 끈다", async () => {
    const enabled = features.enabled.bind(features);
    vi.spyOn(features, "enabled").mockImplementation((name) => name === "widgetClarity" ? Promise.reject(new Error("저장소 읽기 실패")) : enabled(name));
    const response = await app.inject("/api/widget?ms=1");
    expect(response.statusCode).toBe(200);
    expect(response.json().features).not.toHaveProperty("widgetClarity");
    expect(list).toHaveBeenCalledTimes(1);
  });
});
