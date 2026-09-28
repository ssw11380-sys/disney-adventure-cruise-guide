import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Quote } from "../src/domain/types.js";
import { FakeGenerator, FakeQuoteProvider, fakeProviders } from "./helpers.js";

/**
 * 숫자 기준 (3-32 PR 2, 플래그 numberBasis) — 위젯 응답.
 * 지금 앱(&ms=1)이 물을 때 · 켬일 때만 features.numberBasis 와 종목 시세 기준(b, priceBasis 원문 그대로)을 넣는다.
 * &ms=1 이 없는 예전 앱, 또는 끈 상태에서는 칸이 없고 본문이 예전과 같다 (켬 응답에서 두 칸을 뺀 것과 바이트까지 같음).
 * 기본 가짜 시세(helpers makeQuote)에는 priceBasis 가 없어 b 가 생기지 않으므로, priceBasis 를 주는 가짜 시세를 여기 둔다
 */

const BASIS: Record<string, string> = { "000660": "KRX+NXT 통합", "005930": "KRX 정규장" }; // 247540 은 없음
class BasisQuotes extends FakeQuoteProvider {
  async getQuote(code: string): Promise<Quote> {
    const q = await super.getQuote(code);
    return BASIS[code] ? { ...q, priceBasis: BASIS[code] } : q;
  }
}

type Stock = { c: string; q: unknown[] | null; b?: string };
type Body = { features: Record<string, boolean>; stocks: Stock[] };

const NEW_URL = "/api/widget?indices=1&sessions=1&ui=2&ms=1";
const NO_MS_URL = "/api/widget?indices=1&sessions=1&ui=2";

describe("GET /api/widget: 종목 시세 기준 b (numberBasis, &ms=1 만)", () => {
  let db: Db | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const start = async () => {
    db = await createMigratedDb(":memory:");
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ quotes: new BasisQuotes("basis"), generator: new FakeGenerator() }),
      logger: false,
      enableScheduler: false,
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    for (const code of ["000660", "005930", "247540"]) {
      const r = await app.inject({ method: "POST", url: "/api/stocks", payload: { code, quantity: 2, avgPrice: 90_000 } });
      expect(r.statusCode, code).toBeLessThan(300);
    }
  };
  const raw = async (url: string) => (await app!.inject({ method: "GET", url })).body;
  const byCode = (b: Body) => Object.fromEntries(b.stocks.map((s) => [s.c, s]));
  /** 켬 응답에서 features.numberBasis 와 stocks[].b 를 뺀 것 (끈 응답과 같아야 함) */
  const strip = (b: Body): Body => {
    const { numberBasis: _n, ...features } = b.features;
    return { ...b, features, stocks: b.stocks.map(({ b: _b, ...s }) => s) };
  };
  afterEach(async () => {
    await app?.close();
    await db?.destroy();
    app = undefined;
    db = undefined;
  });

  it("켬 + &ms=1: features.numberBasis 참, 기준이 있는 종목만 b(원문 그대로), q 튜플 모양은 그대로", async () => {
    await start();
    const on = JSON.parse(await raw(NEW_URL)) as Body;
    expect(on.features.numberBasis).toBe(true);
    const s = byCode(on);
    expect(s["000660"]!.b).toBe("KRX+NXT 통합");
    expect(s["005930"]!.b).toBe("KRX 정규장");
    expect(s["247540"]).not.toHaveProperty("b");
    expect(s["000660"]!.q).toHaveLength(7);

    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { numberBasis: false } });
    const off = JSON.parse(await raw(NEW_URL)) as Body;
    expect(off.stocks.map((x) => x.q)).toEqual(on.stocks.map((x) => x.q));
  });

  it("&ms=1 이 없는 예전 앱: 켜져 있어도 numberBasis 칸·b 없음", async () => {
    await start();
    for (const url of ["/api/widget", NO_MS_URL]) {
      const body = JSON.parse(await raw(url)) as Body;
      expect(body.features, url).not.toHaveProperty("numberBasis");
      expect(body.stocks.some((x) => "b" in x), url).toBe(false);
    }
  });

  it("끔 + &ms=1: 칸이 없고, 본문은 켬 응답에서 numberBasis·b 를 뺀 것과 바이트까지 같다", async () => {
    await start();
    const onRaw = await raw(NEW_URL);
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { numberBasis: false } });
    const offRaw = await raw(NEW_URL);
    const off = JSON.parse(offRaw) as Body;
    expect(off.features).not.toHaveProperty("numberBasis");
    expect(off.stocks.some((x) => "b" in x)).toBe(false);
    expect(off).toEqual(strip(JSON.parse(onRaw) as Body));
    expect(offRaw).toBe(JSON.stringify(strip(JSON.parse(onRaw) as Body)));
  });
});
