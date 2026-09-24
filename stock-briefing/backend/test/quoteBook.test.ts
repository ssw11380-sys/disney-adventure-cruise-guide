import { describe, expect, it } from "vitest";
import type { Quote } from "../src/domain/types.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import type { QuoteProvider } from "../src/providers/market/types.js";
import { StockService } from "../src/services/stockService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider, makeQuote } from "./helpers.js";

/**
 * 3-9 잔고 응답: 현재가는 캐시로 바로 답하고 뒤에서 한 번에 새로 받는다. 출처가 멈추거나 모두 실패해도 보유 종목·총평가가 그대로.
 */

const CODES = Array.from({ length: 17 }, (_, i) => String(100000 + i * 10).padStart(6, "0"));

/** 일괄 조회를 지원하는 가짜 출처. mode 로 정상·실패·멈춤을 바꾼다 */
class BatchProvider implements QuoteProvider {
  readonly name = "toss-openapi";
  batches: string[][] = [];
  mode: "ok" | "fail" | "hang" = "ok";
  price = 100_000;
  asOf = "2026-09-22T10:00:00+09:00";
  private release: (() => void) | null = null;
  async getQuotes(codes: string[]): Promise<Map<string, Quote | Error>> {
    this.batches.push(codes);
    if (this.mode === "fail") throw new ProviderError(this.name, "고의 실패");
    if (this.mode === "hang") await new Promise<void>((r) => (this.release = r));
    return new Map(codes.map((c) => [c, { ...makeQuote(c, this.name, this.price), asOf: this.asOf }]));
  }
  async getQuote(code: string): Promise<Quote> {
    const r = (await this.getQuotes([code])).get(code)!;
    if (r instanceof Error) throw r;
    return r;
  }
  async getCandles(): Promise<never> {
    throw new ProviderError(this.name, "없음");
  }
  unblock() {
    this.release?.();
  }
}

async function setup(provider: QuoteProvider, t: { now: number }, db?: Db) {
  db ??= await createMigratedDb(":memory:");
  const service = new StockService({ db, quotes: provider, search: new FakeSearchProvider(), master: new FakeMasterProvider(), now: () => new Date(t.now), quoteCacheTtlMs: 60_000 });
  const existing = await db.selectFrom("registered_stocks").select("code").execute();
  if (existing.length === 0)
    await db
      .insertInto("registered_stocks")
      .values(CODES.map((code, i) => ({ code, name: `종목${i}`, market: "KOSPI", quantity: 10, avg_price: 90_000, memo: null, created_at: `2026-09-01T00:00:${String(i).padStart(2, "0")}+09:00`, updated_at: "2026-09-01T00:00:00+09:00" })))
      .execute();
  return { db, service };
}

const total = (list: Awaited<ReturnType<StockService["listWithQuotes"]>>) => list.reduce((a, s) => a + (s.evaluation?.marketValue ?? 0), 0);
const held = (list: Awaited<ReturnType<StockService["listWithQuotes"]>>) => list.filter((s) => s.quote && s.evaluation).length;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("잔고 현재가 캐시 (3-9)", () => {
  it("17종목 첫 호출은 일괄 1번, ttl 안의 다음 호출은 출처를 부르지 않는다", async () => {
    const p = new BatchProvider();
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const { service } = await setup(p, t);
    const a = await service.listWithQuotes();
    expect(p.batches).toEqual([CODES]);
    expect(held(a)).toBe(17);
    t.now += 30_000;
    await service.listWithQuotes();
    expect(p.batches).toHaveLength(1);
  });

  it("ttl 이 지나면 옛 값으로 바로 답하고, 동시에 온 요청들은 뒤에서 한 번만 새로 받는다", async () => {
    const p = new BatchProvider();
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const { service } = await setup(p, t);
    await service.listWithQuotes();
    t.now += 61_000;
    p.price = 110_000;
    p.mode = "hang"; // 출처가 멈춰도
    const t0 = performance.now();
    const lists = await Promise.all(Array.from({ length: 5 }, () => service.listWithQuotes()));
    expect(performance.now() - t0).toBeLessThan(300);
    expect(lists.every((l) => l.every((s) => s.quote!.price === 100_000 && !s.quote!.stale))).toBe(true); // 받는 중이라 지연 아님
    expect(p.batches).toHaveLength(2); // 5요청 → 새로 받기 1번
    p.unblock();
    await settle();
    expect((await service.listWithQuotes()).every((s) => s.quote!.price === 110_000)).toBe(true);
  });

  it("출처가 모두 실패하면 마지막 값을 stale 로 유지한다 — 보유 17 그대로, 총평가 변동 0, asOf 는 원래 시각", async () => {
    const p = new BatchProvider();
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const { service } = await setup(p, t);
    const before = await service.listWithQuotes();
    p.mode = "fail";
    t.now += 61_000;
    await service.listWithQuotes(); // 새로 받기 시작(실패)
    await settle();
    const after = await service.listWithQuotes();
    expect(held(after)).toBe(17);
    expect(total(after)).toBe(total(before));
    expect(after.every((s) => s.quote!.stale === true && s.quote!.asOf === "2026-09-22T10:00:00+09:00")).toBe(true);
    expect(after.every((s) => s.quoteError === null)).toBe(true);
    // 실패 뒤 20초 동안은 요청이 와도 출처를 다시 부르지 않는다
    const calls = p.batches.length;
    t.now += 10_000;
    await service.listWithQuotes();
    await service.listWithQuotes();
    expect(p.batches.length).toBe(calls);
    // 다시 받으면 지연 표시가 사라진다
    p.mode = "ok";
    t.now += 61_000;
    await service.listWithQuotes();
    await settle();
    expect((await service.listWithQuotes()).some((s) => s.quote!.stale)).toBe(false);
  });

  it("첫 실행에 출처가 멈추면 1.2초만 기다리고 있는 것만으로 답한다", async () => {
    const p = new BatchProvider();
    p.mode = "hang";
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const { service } = await setup(p, t);
    const t0 = performance.now();
    const list = await service.listWithQuotes();
    const ms = performance.now() - t0;
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(1_800);
    expect(list.every((s) => s.quote === null && s.quoteError)).toBe(true);
    p.unblock();
  });

  it("재시작(새 서비스) 뒤에는 DB 캐시로 바로 답한다 — 출처가 멈춰 있어도", async () => {
    const p = new BatchProvider();
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const { db, service } = await setup(p, t);
    const before = await service.listWithQuotes();
    const p2 = new BatchProvider();
    p2.mode = "hang";
    t.now += 10 * 60_000;
    const { service: restarted } = await setup(p2, t, db);
    const t0 = performance.now();
    const list = await restarted.listWithQuotes();
    expect(performance.now() - t0).toBeLessThan(300);
    expect(held(list)).toBe(17);
    expect(total(list)).toBe(total(before));
    p2.unblock();
  });

  it("잔고 요청 한 번의 DB 쿼리는 3회 이하 (첫 호출 뒤)", async () => {
    const p = new BatchProvider();
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const base = await createMigratedDb(":memory:");
    let queries = 0;
    const counted = base.withPlugin({
      transformQuery: (args) => {
        queries++;
        return args.node;
      },
      transformResult: async (args) => args.result,
    });
    const { service } = await setup(p, t, counted);
    await service.listWithQuotes();
    queries = 0;
    await service.listWithQuotes();
    expect(queries).toBeLessThanOrEqual(3);
    t.now += 61_000; // 새로 받기가 섞여도 요청 자체는 그대로
    queries = 0;
    await service.listWithQuotes();
    expect(queries).toBeLessThanOrEqual(3);
  });

  it("미국 종목 실시간 가격의 원화 환산은 달러가 × 표시 환율과 정확히 같다", async () => {
    const db = await createMigratedDb(":memory:");
    const usd: Quote = { ...makeQuote("VRT", "toss-openapi", 140.12), currency: "USD", fxRate: 1391.37, priceKrw: Math.round(140.12 * 1391.37), asOf: "2026-09-22T10:00:00+09:00" };
    const provider: QuoteProvider = { name: "toss-openapi", getQuote: async () => usd, getCandles: async () => ({ code: "VRT", period: "D", candles: [], source: "x" }) };
    const prices = [101.23, 140.13, 99.99, 250.07];
    let i = 0;
    const live = {
      get: () => ({ code: "VRT", price: prices[i]!, volume: 1, timestamp: "2026-09-22T10:05:00+09:00", receivedAt: 0 }),
      setCodes: () => {},
      status: () => ({ enabled: true, connected: true, subscribed: [], lastMessageAt: null, lastError: null }),
    };
    const service = new StockService({ db, quotes: provider, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, now: () => new Date("2026-09-22T10:05:00+09:00") });
    for (i = 0; i < prices.length; i++) {
      const q = await service.getQuote("VRT");
      expect(q.priceKrw).toBe(Math.round(prices[i]! * 1391.37));
    }
  });

  it("실시간 체결가가 들어오면 스냅샷을 새로 받지 못해도 지연으로 표시하지 않는다", async () => {
    const p = new BatchProvider();
    const t = { now: Date.parse("2026-09-22T10:00:00+09:00") };
    const db = await createMigratedDb(":memory:");
    const live = {
      get: (c: string) => (c === CODES[0] ? { code: c, price: 100_500, volume: 1, timestamp: new Date(t.now).toISOString(), receivedAt: 0 } : null),
      setCodes: () => {},
      status: () => ({ enabled: true, connected: true, subscribed: [], lastMessageAt: null, lastError: null }),
    };
    const service = new StockService({ db, quotes: p, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, now: () => new Date(t.now), quoteCacheTtlMs: 60_000 });
    await setup(p, t, db);
    await service.listWithQuotes();
    p.mode = "fail";
    t.now += 61_000;
    await service.listWithQuotes();
    await settle();
    const list = await service.listWithQuotes();
    expect(list[0]!.quote).toMatchObject({ price: 100_500, live: true });
    expect(list[0]!.quote!.stale).toBeFalsy();
    expect(list[1]!.quote!.stale).toBe(true);
  });
});

describe("QuoteProviderChain.getQuotes", () => {
  it("일괄 소스에서 빠진 종목만 다음 소스로(종목마다) 넘긴다", async () => {
    const batch = new BatchProvider();
    const origin = batch.getQuotes.bind(batch);
    batch.getQuotes = async (codes) => {
      const m = await origin(codes);
      m.set("000002", new ProviderError(batch.name, "없음"));
      return m;
    };
    const next = new FakeQuoteProvider("toss", { price: 50_000 });
    const chain = new QuoteProviderChain([batch, next]);
    const r = await chain.getQuotes(["000001", "000002", "000003"]);
    expect((r.get("000001") as Quote).source).toBe("toss-openapi");
    expect((r.get("000002") as Quote).source).toBe("toss");
    expect(next.calls).toBe(1);
  });

  it("모든 소스가 실패한 종목은 시도한 소스를 담은 오류", async () => {
    const batch = new BatchProvider();
    batch.mode = "fail";
    const chain = new QuoteProviderChain([batch, new FakeQuoteProvider("naver", { fail: true })]);
    const r = await chain.getQuotes(["000001"]);
    expect(r.get("000001")).toBeInstanceOf(Error);
    expect((r.get("000001") as Error).message).toContain("toss-openapi, naver");
  });
});
