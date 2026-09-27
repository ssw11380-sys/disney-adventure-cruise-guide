import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { applyJson, canonicalJson, diffJson, jsonHash, sameJson, type Json } from "../src/lib/jsonDelta.js";
import { deltaBody, etagOf, inmTags, registerPollSaver } from "../src/lib/pollSaver.js";
import { fakeProviders } from "./helpers.js";

/**
 * 끊겼을 때 데이터 절약 (플래그 pollSaver, 3-25 성능-16).
 * 위험(로드맵): ETag 가 틀리면 옛 값이 남는다 → 화면에 보이는 값·기준 시각(asOf) 중 무엇이든 바뀌면 ETag 가 바뀌는지, 304 는 같은 본문일 때만인지,
 * 차이(226)를 적용하면 전체 본문과 똑같은지 본다. 끄면 응답이 바이트까지 예전과 같다.
 */

// ── 잔고 목록 모양의 예시 (18종목: 국내 9 · 미국 8 · 관심 1) ──
function sampleList(t = 0): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < 18; i++) {
    const kr = i < 9;
    const code = kr ? String(5930 + i * 111).padStart(6, "0") : ["AAPL", "NVDA", "VRT", "QNTM", "TSLA", "MSFT", "ETN", "QQQI", "AVGO"][i - 9]!;
    const price = kr ? 50_000 + i * 1_000 + t * 100 : 100 + i + t / 10;
    out.push({
      code,
      name: kr ? `국내종목${i}` : code,
      market: kr ? "KOSPI" : "NASDAQ",
      quantity: i === 17 ? null : 10 + i,
      avgPrice: i === 17 ? null : price * 0.9,
      memo: null,
      createdAt: "2026-01-10T09:00:00+09:00",
      updatedAt: "2026-09-24T21:00:00+09:00",
      tossSynced: i !== 17,
      quote: {
        code,
        currency: kr ? "KRW" : "USD",
        price,
        change: 1200,
        changeRate: 1.44,
        open: price - 300,
        high: price + 500,
        low: price - 700,
        prevClose: price - 1200,
        volume: 1_000_000 + i,
        marketCap: 1e12,
        per: 14.82,
        pbr: 1.41,
        eps: 5688,
        bps: 59786,
        high52w: price * 1.05,
        low52w: price * 0.63,
        asOf: `2026-09-28T10:00:0${i % 10}.000+09:00`,
        source: "toss",
        afterMarket: null,
        priceBasis: kr ? "KRX+NXT 통합" : "정규장",
        priceKrw: kr ? null : Math.round(price * 1391.5),
        fxRate: kr ? null : 1391.5,
        industry: "반도체",
        session: { market: kr ? "KR" : "US", phase: "regular", open: true, eligible: true, until: "2026-09-28T15:30:00+09:00" },
        realtime: true,
        live: true,
        stale: false,
      },
      quoteError: null,
      evaluation: i === 17 ? null : { marketValue: price * 10, costBasis: price * 9, profit: price, profitRate: 11.11, costRate: 0.00195, afterCost: { marketValue: price * 9.98, profit: price * 0.98, profitRate: 10.89 } },
    });
  }
  return out;
}

/** 모든 잎 경로 */
function leaves(v: Json, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, i]));
  if (v !== null && typeof v === "object") return Object.keys(v).flatMap((k) => leaves(v[k]!, [...path, k]));
  return [path];
}
function mutateAt(v: Json, path: (string | number)[]): Json {
  const out = JSON.parse(JSON.stringify(v)) as Json;
  let cur: any = out;
  for (const k of path.slice(0, -1)) cur = cur[k];
  const last = path[path.length - 1]!;
  const x = cur[last];
  cur[last] = typeof x === "number" ? x + 1 : typeof x === "string" ? `${x}.` : typeof x === "boolean" ? !x : 0;
  return out;
}

/** 시드 고정 난수 (재현되게) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function randomJson(r: () => number, depth = 0): Json {
  const k = r();
  if (depth > 3 || k < 0.35) {
    const p = r();
    return p < 0.2 ? null : p < 0.4 ? r() < 0.5 : p < 0.7 ? Math.round((r() - 0.5) * 1e6) / 100 : ["가", "b", "asOf", "", "$", "-"][Math.floor(r() * 6)]!;
  }
  if (k < 0.6) return Array.from({ length: Math.floor(r() * 4) }, () => randomJson(r, depth + 1));
  const o: Record<string, Json> = {};
  for (let i = Math.floor(r() * 5); i > 0; i--) o[["a", "b", "quote", "asOf", "$", "#", "-", "가"][Math.floor(r() * 8)]!] = randomJson(r, depth + 1);
  return o;
}
function randomMutate(r: () => number, v: Json, depth = 0): Json {
  if (r() < 0.25 || depth > 4) return randomJson(r, depth);
  if (Array.isArray(v)) {
    const out = v.map((x) => (r() < 0.4 ? randomMutate(r, x, depth + 1) : x));
    if (r() < 0.15) out.push(randomJson(r, depth + 1));
    return out;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) if (r() > 0.1) out[k] = r() < 0.4 ? randomMutate(r, x, depth + 1) : x;
    if (r() < 0.2) out[["n", "새", "$"][Math.floor(r() * 3)]!] = randomJson(r, depth + 1);
    return out;
  }
  return randomJson(r, depth);
}

describe("JSON 바뀐 부분만 (jsonDelta)", () => {
  it("공용 픽스처: 서버 diffJson 이 적어 둔 패치와 같고, 적용하면 다음 값·해시가 같다 (앱 test/pollSaver 가 같은 파일로 applyJson 을 본다)", () => {
    const cases = JSON.parse(readFileSync(new URL("../../shared/fixtures/jsonDelta.json", import.meta.url), "utf8")) as { name: string; base: Json; next: Json; patch: Json; hash: string; baseHash: string }[];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      expect(diffJson(c.base, c.next), c.name).toEqual(c.patch);
      expect(sameJson(applyJson(c.base, c.patch), c.next), c.name).toBe(true);
      expect(jsonHash(c.next), c.name).toBe(c.hash);
      expect(jsonHash(c.base), c.name).toBe(c.baseHash);
    }
  });

  it("무작위 3,000쌍: 패치를 JSON 으로 주고받아 적용하면 새 값과 똑같다 (특수 키 $·#·- 포함)", () => {
    const r = rng(20260927);
    for (let i = 0; i < 3000; i++) {
      const a = randomJson(r);
      const b = randomMutate(r, a);
      const p = diffJson(a, b);
      if (p === undefined) {
        expect(sameJson(a, b)).toBe(true);
        continue;
      }
      const wire = JSON.parse(JSON.stringify(p)) as Json;
      const got = applyJson(JSON.parse(JSON.stringify(a)) as Json, wire);
      expect(canonicalJson(got)).toBe(canonicalJson(b));
    }
  });

  it("적용은 옛 값을 건드리지 않는다", () => {
    const a = sampleList(0);
    const before = JSON.stringify(a);
    const b = sampleList(1);
    applyJson(a, diffJson(a, b)!);
    expect(JSON.stringify(a)).toBe(before);
  });

  it("모양이 맞지 않는 패치는 던진다 (앱은 전체를 다시 받음)", () => {
    expect(() => applyJson({ a: 1 }, { "#": { "0": 1 } })).toThrow();
    expect(() => applyJson([1, 2], { "#": { "5": 1 } })).toThrow();
    expect(() => applyJson([1, 2], { a: 1 })).toThrow();
    expect(() => applyJson({ a: 1 }, { "-": 1 })).toThrow();
  });

  it("확인용 해시는 키 순서와 무관하고 값이 바뀌면 달라진다", () => {
    expect(jsonHash({ a: 1, b: [1, { c: "가" }] })).toBe(jsonHash({ b: [1, { c: "가" }], a: 1 }));
    expect(jsonHash({ a: 1 })).not.toBe(jsonHash({ a: 2 }));
    expect(jsonHash({ a: "1" })).not.toBe(jsonHash({ a: 1 }));
  });
});

describe("ETag (옛 값이 남지 않게)", () => {
  it("잔고의 모든 칸(가격·평가·세션·asOf …) 하나만 바뀌어도 ETag 가 바뀐다", () => {
    const base = sampleList(0);
    const tag = etagOf(JSON.stringify(base));
    const paths = leaves(base);
    expect(paths.length).toBeGreaterThan(500);
    for (const p of paths) expect(etagOf(JSON.stringify(mutateAt(base, p))), p.join(".")).not.toBe(tag);
  });

  it("가격이 같아도 asOf 만 1초 바뀌면 ETag 가 다르다 (asOf 비교) — 옛 ETag 로 물으면 304 가 아니라 새 값", async () => {
    const base = sampleList(0) as any[];
    const next = JSON.parse(JSON.stringify(base)) as any[];
    next[3].quote.asOf = "2026-09-28T10:00:04.001+09:00";
    expect(etagOf(JSON.stringify(next))).not.toBe(etagOf(JSON.stringify(base)));
    const { app, set } = await stubApp(() => true);
    set(base);
    const first = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    set(next);
    const again = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": String(first.headers.etag) } });
    expect(again.statusCode).toBe(200);
    expect(again.json()[3].quote.asOf).toBe("2026-09-28T10:00:04.001+09:00");
    await app.close();
  });

  it("같은 본문이면 같은 ETag (값이 그대로면 304 가 나오게)", () => {
    expect(etagOf(JSON.stringify(sampleList(2)))).toBe(etagOf(JSON.stringify(sampleList(2))));
  });

  it("If-None-Match: 약한 ETag·여러 개도 읽는다", () => {
    expect(inmTags('W/"abc", "def"')).toEqual(['"abc"', '"def"']);
    expect(inmTags(undefined)).toEqual([]);
  });
});

/** 플러그인만 붙인 작은 서버 (잔고 모양 예시를 바꿔 가며) */
async function stubApp(on: () => boolean) {
  const app = Fastify({ logger: false });
  let data: Json = sampleList(0);
  const saver = registerPollSaver(app, { enabled: async () => on() });
  app.get("/api/stocks", async () => data);
  app.get("/api/stocks/:code/candles", async () => ({ candles: [1, 2, 3] }));
  app.get("/api/stocks/:code", async (req, reply) => ((req.params as { code: string }).code === "NONE" ? reply.code(404).send({ error: "NOT_FOUND" }) : { code: "AAPL", data }));
  await app.ready();
  return { app, saver, set: (v: Json) => void (data = v) };
}

describe("pollSaver 응답 (304·226·gzip)", () => {
  it("켜면: ETag → 같은 본문이면 304(본문·content-type 없음), 바뀌면 200", async () => {
    const { app, set } = await stubApp(() => true);
    const a = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    expect(a.statusCode).toBe(200);
    expect(a.headers.etag).toMatch(/^"[\w-]{16}"$/);
    expect(a.headers["cache-control"]).toBe("no-cache");
    const b = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": String(a.headers.etag) } });
    expect(b.statusCode).toBe(304);
    expect(b.rawPayload.length).toBe(0);
    expect(b.headers["content-type"]).toBeUndefined();
    const weak = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": `W/${a.headers.etag}` } });
    expect(weak.statusCode).toBe(304);
    set(sampleList(1));
    const c = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": String(a.headers.etag) } });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toEqual(sampleList(1));
    await app.close();
  });

  it("A-IM: json-delta + 옛 ETag → 226 차이만. 옛 본문에 적용하면 새 본문과 똑같고 해시도 맞는다", async () => {
    const { app, set } = await stubApp(() => true);
    const a = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    const next = sampleList(0) as any[];
    next[2].quote.price += 100;
    next[2].quote.asOf = "2026-09-28T10:00:09.500+09:00";
    next[2].evaluation.marketValue += 1000;
    set(next);
    const d = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": String(a.headers.etag), "a-im": "json-delta" } });
    expect(d.statusCode).toBe(226);
    expect(d.headers.im).toBe("json-delta");
    expect(d.headers["delta-base"]).toBe(a.headers.etag);
    expect(d.headers["cache-control"]).toBe("no-store");
    const body = d.json() as { $im: string; base: string; etag: string; h: string; p: Json };
    expect(body).toMatchObject({ $im: "json-delta", base: a.headers.etag, etag: d.headers.etag });
    const rebuilt = applyJson(a.json() as Json, body.p);
    expect(sameJson(rebuilt, next)).toBe(true);
    expect(jsonHash(rebuilt)).toBe(body.h);
    expect(body.etag).toBe(etagOf(JSON.stringify(next)));
    // 차이는 전체보다 훨씬 작다
    expect(d.rawPayload.length).toBeLessThan(a.rawPayload.length / 10);
    // 새 ETag 로 다시 물으면 304
    const again = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": body.etag, "a-im": "json-delta" } });
    expect(again.statusCode).toBe(304);
    await app.close();
  });

  it("서버가 옛 본문을 모르면(다시 켬·오래됨) 226 대신 전체 200", async () => {
    const { app, set } = await stubApp(() => true);
    set(sampleList(3));
    const r = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": '"unknownunknown00"', "a-im": "json-delta" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(sampleList(3));
    await app.close();
  });

  it("차이가 전체와 비슷하면(종목 수가 바뀜 등) 전체 200", async () => {
    const base = sampleList(0);
    const grown = [...sampleList(0), ...sampleList(0).slice(0, 1)];
    expect(deltaBody('"a"', JSON.stringify(base), '"b"', JSON.stringify(grown))).toBeNull();
  });

  it("gzip 을 받으면 압축하고, 풀면 같은 본문", async () => {
    const { app } = await stubApp(() => true);
    const plain = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    const z = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "accept-encoding": "gzip" } });
    expect(z.headers["content-encoding"]).toBe("gzip");
    expect(z.headers.vary).toContain("accept-encoding");
    expect(gunzipSync(z.rawPayload).toString()).toBe(plain.payload);
    expect(z.headers.etag).toBe(plain.headers.etag);
    expect(z.rawPayload.length).toBeLessThan(plain.rawPayload.length / 4);
    await app.close();
  });

  it("끄면: ETag·304·226·gzip 없이 예전과 바이트까지 같다", async () => {
    const { app } = await stubApp(() => false);
    const a = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
    const b = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": etagOf(a.payload), "a-im": "json-delta", "accept-encoding": "gzip" } });
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(200);
      expect(r.headers.etag).toBeUndefined();
      expect(r.headers["content-encoding"]).toBeUndefined();
      expect(r.headers.vary).toBeUndefined();
      expect(r.payload).toBe(JSON.stringify(sampleList(0)));
    }
    await app.close();
  });

  it("목록에 없는 라우트(차트)와 오류 응답(404)은 건드리지 않는다", async () => {
    const { app } = await stubApp(() => true);
    const c = await app.inject({ method: "GET", url: "/api/stocks/AAPL/candles" });
    expect(c.headers.etag).toBeUndefined();
    const nf = await app.inject({ method: "GET", url: "/api/stocks/NONE" });
    expect(nf.statusCode).toBe(404);
    expect(nf.headers.etag).toBeUndefined();
    const d = await app.inject({ method: "GET", url: "/api/stocks/AAPL" });
    expect(d.headers.etag).toBeDefined();
    await app.close();
  });

  it("브라우저(다른 출처)도 ETag 를 읽을 수 있게 expose 헤더", async () => {
    const { app } = await stubApp(() => true);
    const r = await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { origin: "http://localhost:8081" } });
    expect(r.headers["access-control-expose-headers"]).toBe("etag");
    await app.close();
  });
});

describe("실제 서버 (buildApp)", () => {
  async function real() {
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
    return { app, db };
  }

  it("잔고·플래그·지수·장 상태·/health 에 ETag, 같은 값이면 304 · 플래그를 바꾸면 차이(226)", async () => {
    const { app, db } = await real();
    try {
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      expect((await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930", quantity: 10, avgPrice: 70000 } })).statusCode).toBe(201);
      for (const url of ["/api/stocks?quotes=1", "/api/stocks/005930", "/api/features", "/api/market/indices?stale=1", "/api/market/status", "/health"]) {
        const r = await app.inject({ method: "GET", url });
        expect(r.statusCode, url).toBe(200);
        expect(r.headers.etag, url).toBeDefined();
      }
      const f = await app.inject({ method: "GET", url: "/api/features" });
      expect((await app.inject({ method: "GET", url: "/api/features", headers: { "if-none-match": String(f.headers.etag) } })).statusCode).toBe(304);
      const list = await app.inject({ method: "GET", url: "/api/stocks?quotes=1" });
      expect((await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: { "if-none-match": String(list.headers.etag) } })).statusCode).toBe(304);
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { allocationView: false } });
      const d = await app.inject({ method: "GET", url: "/api/features", headers: { "if-none-match": String(f.headers.etag), "a-im": "json-delta" } });
      expect(d.statusCode).toBe(226);
      const rebuilt = applyJson(f.json() as Json, (d.json() as { p: Json }).p) as { features: Record<string, boolean> };
      expect(rebuilt.features.allocationView).toBe(false);
      expect(jsonHash(rebuilt as unknown as Json)).toBe((d.json() as { h: string }).h);
      expect((await app.inject({ method: "GET", url: "/health" })).json().pollSaver).toMatchObject({ notModified: 2, delta: 1 });
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("pollSaver 를 끄면 ETag 없음, 304 없음, /health 에 pollSaver 칸 없음 (예전과 같음)", async () => {
    const { app, db } = await real();
    try {
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { pollSaver: false } });
      const f = await app.inject({ method: "GET", url: "/api/features" });
      expect(f.headers.etag).toBeUndefined();
      const again = await app.inject({ method: "GET", url: "/api/features", headers: { "if-none-match": etagOf(f.payload), "accept-encoding": "gzip" } });
      expect(again.statusCode).toBe(200);
      expect(again.headers["content-encoding"]).toBeUndefined();
      expect(again.payload).toBe(f.payload);
      expect("pollSaver" in (await app.inject({ method: "GET", url: "/health" })).json()).toBe(false);
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
