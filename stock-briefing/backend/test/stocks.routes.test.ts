import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { FakeQuoteProvider, FakeSearchProvider, SAMPLE_MASTER, fakeProviders } from "./helpers.js";

describe("stock routes", () => {
  let app: FastifyInstance;
  let db: Db;
  let kis: FakeQuoteProvider;
  let yahoo: FakeQuoteProvider;
  let search: FakeSearchProvider;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    kis = new FakeQuoteProvider("kis", { price: 180_000 });
    yahoo = new FakeQuoteProvider("yahoo", { price: 179_000 });
    search = new FakeSearchProvider([SAMPLE_MASTER[0]!]);
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ quotes: new QuoteProviderChain([kis, yahoo]), search }),
      logger: false,
      enableScheduler: false,
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("GET /health 에 고지 문구가 포함된다", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().disclaimer).toContain("투자 권유가 아닙니다");
  });

  it("마스터 갱신 후 종목 수가 반영된다", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/master" });
    expect(res.json().count).toBe(SAMPLE_MASTER.length);
    expect(res.json().refreshedAt).toMatch(/\+09:00$/);
  });

  it("종목명 일부로 검색하면 본주가 ETF 보다 먼저 나온다", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stocks/search?q=하이닉스" });
    const body = res.json();
    expect(body.source).toBe("master");
    expect(body.results.map((r: { code: string }) => r.code)).toEqual(["000660", "465580"]);
    expect(search.calls).toHaveLength(0);
  });

  it("코드로 검색하면 정확히 하나만 나온다", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stocks/search?q=005930" });
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].name).toBe("삼성전자");
  });

  it("마스터에 없으면 외부 검색으로 폴백한다", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stocks/search?q=없는종목" });
    expect(res.json().source).toBe("fake-search");
    expect(search.calls).toEqual(["없는종목"]);
  });

  it("종목 등록 → 조회 → 수정 → 삭제 흐름", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/stocks",
      payload: { code: "000660", quantity: 10, avgPrice: 150_000 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code: "000660", name: "SK하이닉스", market: "KOSPI", quantity: 10, avgPrice: 150_000 });

    const dup = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660" } });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].quote.source).toBe("kis");
    expect(list.json()[0].evaluation).toMatchObject({
      marketValue: 1_800_000,
      costBasis: 1_500_000,
      profit: 300_000,
      profitRate: 20,
    });

    const patched = await app.inject({ method: "PATCH", url: "/api/stocks/000660", payload: { quantity: null, avgPrice: null } });
    expect(patched.json().quantity).toBeNull();

    const del = await app.inject({ method: "DELETE", url: "/api/stocks/000660" });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: "/api/stocks/000660" });
    expect(gone.statusCode).toBe(404);
  });

  it("잘못된 코드/본문은 400 으로 거절한다", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "12345" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("VALIDATION");
    const neg = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: -1 } });
    expect(neg.statusCode).toBe(400);
  });

  it("마스터에 없는 코드는 외부 검색으로 이름을 찾고, 그래도 없으면 404", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660" } });
    expect(ok.statusCode).toBe(201);
    const missing = await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "999999" } });
    expect(missing.statusCode).toBe(404);
  });

  it("마스터 갱신 시 외부 검색으로 등록됐던 종목 이름을 정식 한글명으로 바꾼다", async () => {
    await db.deleteFrom("listed_stocks").execute();
    search = new FakeSearchProvider([{ code: "000660", name: "SK hynix Inc.", market: "KOSPI", isinCode: null, groupCode: "ST" }]);
    await db.insertInto("registered_stocks").values({
      code: "000660", name: "SK hynix Inc.", market: "KOSPI", quantity: null, avg_price: null, memo: null,
      created_at: "2026-09-22T09:00:00+09:00", updated_at: "2026-09-22T09:00:00+09:00",
    }).execute();
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    const res = await app.inject({ method: "GET", url: "/api/stocks/000660" });
    expect(res.json().name).toBe("SK하이닉스");
  });

  it("현재가는 캐시되고 fresh=1 이면 다시 조회한다; 1차 소스 장애 시 폴백 소스로 응답한다", async () => {
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
    await app.inject({ method: "GET", url: "/api/stocks/005930/quote" });
    await app.inject({ method: "GET", url: "/api/stocks/005930/quote" });
    expect(kis.calls).toBe(1);

    const fresh = await app.inject({ method: "GET", url: "/api/stocks/005930/quote?fresh=1" });
    expect(kis.calls).toBe(2);
    expect(fresh.json().source).toBe("kis");

    kis.opts.fail = true;
    const fallback = await app.inject({ method: "GET", url: "/api/stocks/005930/quote?fresh=1" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().source).toBe("yahoo");
    expect(fallback.json().price).toBe(179_000);
  });

  it("모든 시세 소스가 죽어도 종목 목록은 quoteError 와 함께 200 으로 응답한다", async () => {
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
    kis.opts.fail = true;
    yahoo.opts.fail = true;
    const res = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].quote).toBeNull();
    expect(res.json()[0].quoteError).toContain("모든 소스 실패");
  });

  it("봉차트는 period/count 를 검증해서 넘긴다", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stocks/000660/candles?period=W&count=30" });
    expect(res.json().period).toBe("W");
    expect(res.json().candles).toHaveLength(30);
    const bad = await app.inject({ method: "GET", url: "/api/stocks/000660/candles?period=X" });
    expect(bad.statusCode).toBe(400);
  });
});
