import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { MarketState, MarketStatus } from "../src/providers/market/calendar.js";
import { buildWidgetPayload, marketChip } from "../src/services/widgetPayload.js";
import { fakeIndexSource, fakeIndices, fakeProviders, FakeGenerator } from "./helpers.js";

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

describe("GET /api/widget 기능 플래그·지수 줄 (위젯 요청)", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  /** 지수 출처 시계 (30초 캐시를 넘기려고 앞으로 민다) */
  let clock: Date;
  let source: { close: string; fail: boolean };
  let indices: ReturnType<typeof fakeIndices>;
  /** 새 앱: 지수 줄을 그릴 수 있다고 알린다 (?indices=1) */
  const get = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/api/widget?indices=1", headers });
  /** 예전 앱(runtime 1.3.0): 쿼리 없이 */
  const getOld = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/api/widget", headers });
  const later = (sec: number) => (clock = new Date(clock.getTime() + sec * 1000));

  beforeEach(async () => {
    clock = new Date("2026-09-22T10:00:00+09:00");
    source = { close: "3,412.35", fail: false };
    const fx = fakeIndexSource();
    indices = fakeIndices(async (url) => {
      if (source.fail) return new Response("error", { status: 503 });
      if (url.includes("/marketindex/")) return fx(url);
      return fakeIndexSource({ index: { close: source.close, change: "30.45", rate: "0.90", status: "OPEN", at: "2026-09-22T10:00:00+09:00" } })(url);
    }, () => clock);
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new FakeGenerator(), indices }), logger: false, enableScheduler: false, now: () => new Date("2026-09-22T10:00:00+09:00") });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930", quantity: 1, avgPrice: 70_000 } });
  });
  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("플래그 두 개와 코스피·나스닥·원/달러를 순서대로, 앱 지수 띠(stale=1)와 같은 값으로 준다", async () => {
    const body = (await get()).json();
    expect(body.features).toEqual({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true });
    expect(body.indices.map((i: { code: string }) => i.code)).toEqual(["KOSPI", "NASDAQ", "USDKRW"]);
    expect(body.indices[0]).toEqual({ code: "KOSPI", name: "코스피", value: 3412.35, change: 30.45, changeRate: 0.9, open: true, asOf: "2026-09-22T10:00:00+09:00" });
    expect(body.indices[2]).toMatchObject({ code: "USDKRW", name: "원/달러", value: 1360.5, change: -2.1, changeRate: -0.15 });
    // 서버가 받은 시각(fetchedAt)은 넣지 않는다 (값이 같으면 ETag 가 같게)
    expect(body.indices.some((i: Record<string, unknown>) => "fetchedAt" in i || "kind" in i)).toBe(false);
    // 같은 인스턴스: 지수 띠가 주는 값과 같다
    const strip = (await app.inject({ method: "GET", url: "/api/market/indices?stale=1" })).json().indices as Array<Record<string, unknown>>;
    for (const row of body.indices as Array<Record<string, unknown>>) {
      const s = strip.find((x) => x.code === row.code)!;
      expect([row.value, row.change, row.changeRate, row.open, row.name]).toEqual([s.value, s.change, s.changeRate, s.open, s.name]);
    }
  });

  it("ETag: 지수 값이 같으면(출처를 다시 받아도) 304, 값이 바뀌면 새 ETag 로 200", async () => {
    const r1 = await get();
    const etag = String(r1.headers["etag"]);
    const first = indices.calls;
    later(31); // 30초 캐시가 지나 출처를 다시 받는다 (값은 같고 받은 시각만 다름)
    expect((await get({ "if-none-match": etag })).statusCode).toBe(304);
    expect(indices.calls).toBeGreaterThan(first); // 실제로 다시 받았다
    source.close = "3,420.00";
    later(31);
    const r3 = await get({ "if-none-match": etag });
    expect(r3.statusCode).toBe(200);
    expect(String(r3.headers["etag"])).not.toBe(etag);
    expect(r3.json().indices[0].value).toBe(3420);
    // 캐시 안(30초)에서는 같은 값 → 새 ETag 로 304
    expect((await get({ "if-none-match": String(r3.headers["etag"]) })).statusCode).toBe(304);
  });

  it("출처가 실패하면 마지막 값을 stale 로(장중 아님), 한 번도 못 받았으면 지수 없이 보낸다", async () => {
    await get();
    source.fail = true;
    later(31);
    const stale = (await get()).json();
    expect(stale.indices.map((i: { code: string }) => i.code)).toEqual(["KOSPI", "NASDAQ", "USDKRW"]);
    expect(stale.indices.every((i: { stale?: boolean; open: boolean }) => i.stale === true && i.open === false)).toBe(true);
    expect(stale.indices[0].value).toBe(3412.35);

    // 새 서버 인스턴스에서 처음부터 실패: indices 칸이 없다 (위젯은 줄을 감춘다), 나머지는 그대로
    await app.close();
    await db.destroy();
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new FakeGenerator(), indices: fakeIndices(async () => new Response("error", { status: 503 }), () => clock) }), logger: false, enableScheduler: false });
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).not.toHaveProperty("indices");
    expect(r.json().features).toEqual({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true });
  });

  it("widgetIndexLine 을 끄면 지수를 부르지도 넣지도 않는다 (응답·ETag 가 지수와 무관), 켜면 다시", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetIndexLine: false } });
    expect(put.statusCode).toBe(200);
    const r1 = await get();
    expect(r1.json()).not.toHaveProperty("indices");
    expect(r1.json().features).toEqual({ widgetPnlToggle: true, widgetIndexLine: false, widgetMarket: true });
    expect(indices.calls).toBe(0); // 서버 작업 0건
    source.close = "3,999.99";
    later(31);
    expect((await get({ "if-none-match": String(r1.headers["etag"]) })).statusCode).toBe(304);
    expect(indices.calls).toBe(0);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetIndexLine: null } });
    const r2 = await get({ "if-none-match": String(r1.headers["etag"]) });
    expect(r2.statusCode).toBe(200); // 플래그가 바뀌면 ETag 도 바뀐다
    expect(r2.json().indices[0].value).toBe(3999.99);
  });

  it("widgetPnlToggle 을 끄면 features 에 false (앱은 누적만, 전환 없음)", async () => {
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetPnlToggle: false } });
    expect((await get()).json().features).toEqual({ widgetPnlToggle: false, widgetIndexLine: true, widgetMarket: true });
  });

  it("검토 지적: 예전 앱(?indices=1 없음)에는 지수를 넣지도 부르지도 않는다 — 나스닥·환율이 바뀌어도 304 그대로", async () => {
    const r1 = await getOld();
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).not.toHaveProperty("indices");
    expect(r1.json().features).toEqual({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true });
    expect(indices.calls).toBe(0);
    const etag = String(r1.headers["etag"]);
    source.close = "3,500.00";
    later(31);
    expect((await getOld({ "if-none-match": etag })).statusCode).toBe(304);
    expect(indices.calls).toBe(0);
    // 같은 서버에서 새 앱은 지수를 받고, 본문이 달라 ETag 도 다르다 (예전 앱이 받아 둔 ETag 로 304 가 나지 않는다)
    const r2 = await get({ "if-none-match": etag });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().indices[0].value).toBe(3500);
    expect(String(r2.headers["etag"])).not.toBe(etag);
    // 다른 값·빈 값은 새 앱 표시로 보지 않는다
    for (const q of ["indices=0", "indices=", "indices=true"]) expect((await app.inject({ method: "GET", url: `/api/widget?${q}` })).json()).not.toHaveProperty("indices");
  });

  it("예전 앱과 호환: 예전 칸(v·market·stocks·briefings·latestIds)은 그대로이고 새 칸은 더해지기만 한다", async () => {
    const body = (await get()).json();
    expect(body.v).toBe(1);
    expect(Object.keys(body).sort()).toEqual(["briefings", "features", "indices", "latestIds", "market", "stocks", "v"]);
    // 예전 앱이 받는 응답: 예전 칸 + features 만
    expect(Object.keys((await getOld()).json()).sort()).toEqual(["briefings", "features", "latestIds", "market", "stocks", "v"]);
    expect(body.stocks[0].q).toHaveLength(7);
    expect(body.stocks[0].e).toHaveLength(5);
    // 플래그·지수 없이 만들면 예전 응답과 같은 모양
    const plain = buildWidgetPayload([], [], null);
    expect(Object.keys(plain).sort()).toEqual(["briefings", "latestIds", "market", "stocks", "v"]);
    // 지수 줄이 꺼져 있으면 지수를 줘도 넣지 않는다
    expect(buildWidgetPayload([], [], null, { features: { widgetPnlToggle: true, widgetIndexLine: false }, indices: [] })).not.toHaveProperty("indices");
  });

  describe("지수·환율 위젯 판 (APK 1.4.0, widgetMarket · ?board=1)", () => {
    const getBoard = (q = "indices=1&board=1", headers: Record<string, string> = {}) => app.inject({ method: "GET", url: `/api/widget?${q}`, headers });

    it("?board=1 이면 9개를 국내 → 미국 → 환율 순서로, 앱 지수 띠(stale=1)와 같은 값으로 준다 (지수 목록은 한 번만 부른다)", async () => {
      const body = (await getBoard()).json();
      expect(body.features).toEqual({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true });
      expect(body.board.map((i: { code: string }) => i.code)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "USDKRW", "JPYKRW", "CNYKRW"]);
      expect(body.board.map((i: { name: string }) => i.name)).toEqual(["코스피", "코스닥", "나스닥", "S&P500", "다우", "필라반도체", "원/달러", "원/100엔", "원/위안"]);
      // 지수 줄도 그대로 (같은 목록에서)
      expect(body.indices.map((i: { code: string }) => i.code)).toEqual(["KOSPI", "NASDAQ", "USDKRW"]);
      // 출처 9곳을 한 번씩만 (지수 줄과 판이 같은 목록을 쓴다)
      expect(indices.calls).toBe(9);
      expect(body.board.some((i: Record<string, unknown>) => "fetchedAt" in i || "kind" in i)).toBe(false);
      const strip = (await app.inject({ method: "GET", url: "/api/market/indices?stale=1" })).json().indices as Array<Record<string, unknown>>;
      for (const row of body.board as Array<Record<string, unknown>>) {
        const s = strip.find((x) => x.code === row.code)!;
        expect([row.value, row.change, row.changeRate, row.open, row.name]).toEqual([s.value, s.change, s.changeRate, s.open, s.name]);
      }
    });

    it("판만 물어도(지수 줄 없이) 판만, 묻지 않으면 넣지도 부르지도 않는다 — 위젯이 없는 앱·예전 앱의 응답·ETag 는 판과 무관", async () => {
      const only = (await getBoard("board=1")).json();
      expect(only.board).toHaveLength(9);
      expect(only).not.toHaveProperty("indices");
      await app.close();
      await db.destroy();
      indices = fakeIndices(fakeIndexSource(), () => clock);
      db = await createMigratedDb(":memory:");
      app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new FakeGenerator(), indices }), logger: false, enableScheduler: false });
      const none = await getOld();
      expect(none.json()).not.toHaveProperty("board");
      expect(indices.calls).toBe(0);
      expect((await get()).json()).not.toHaveProperty("board");
      for (const q of ["board=0", "board=", "board=true"]) expect((await getBoard(q)).json()).not.toHaveProperty("board");
    });

    it("widgetMarket 을 끄면 판을 넣지 않고 features 에 false (지수 줄 없이 물었으면 지수 조회 0건), 켜면 다시", async () => {
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetMarket: false } });
      const off = await getBoard("board=1");
      expect(off.json()).not.toHaveProperty("board");
      expect(off.json().features).toEqual({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: false });
      expect(indices.calls).toBe(0);
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetMarket: null } });
      expect((await getBoard("board=1")).json().board).toHaveLength(9);
    });

    it("ETag: 판의 값이 같으면 304, 바뀌면 200 (판이 있는 응답과 없는 응답의 ETag 는 다르다)", async () => {
      const r1 = await getBoard();
      const etag = String(r1.headers["etag"]);
      later(31);
      expect((await getBoard("indices=1&board=1", { "if-none-match": etag })).statusCode).toBe(304);
      expect((await get({ "if-none-match": etag })).statusCode).toBe(200);
      source.close = "3,420.00";
      later(31);
      const r2 = await getBoard("indices=1&board=1", { "if-none-match": etag });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().board[1].value).toBe(3420);
    });

    it("출처가 실패하면 판도 마지막 값을 stale 로(장중 아님), 한 번도 못 받았으면 판 없이", async () => {
      await getBoard();
      source.fail = true;
      later(31);
      const stale = (await getBoard()).json();
      expect(stale.board).toHaveLength(9);
      expect(stale.board.every((i: { stale?: boolean; open: boolean }) => i.stale === true && i.open === false)).toBe(true);
      expect(buildWidgetPayload([], [], null, { features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true }, board: [] })).not.toHaveProperty("board");
      expect(buildWidgetPayload([], [], null, { features: { widgetPnlToggle: true, widgetIndexLine: true }, board: [] })).not.toHaveProperty("board");
    });
  });
});
