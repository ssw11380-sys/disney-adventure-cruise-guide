import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "kysely";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDb, createMigratedDb } from "../src/db/index.js";
import { NaverFundamentals, type FundamentalsCacheStore } from "../src/providers/market/fundamentals.js";
import { createFundamentalsCacheStore, parseFundamentalsCache } from "../src/providers/market/fundamentalsCacheStore.js";
import { StockService } from "../src/services/stockService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";

const AT = Date.parse("2026-12-28T09:30:00+09:00");
const HOUR = 3_600_000;
const body = (pbr = 0) => new Response(JSON.stringify({ totalInfos: [{ code: "per", value: "15" }, { code: "pbr", value: String(pbr) }, { code: "dividendYieldRatio", value: "0" }] }));
const pgUrl = process.env["TEST_PG_URL"];

function setup(store: FundamentalsCacheStore, limit = 2) {
  let at = AT;
  let failed = false;
  const fetcher = vi.fn(async () => failed ? new Response("", { status: 503 }) : body());
  const provider = new NaverFundamentals(fetcher, () => new Date(at), HOUR, 120_000, limit);
  provider.setCacheStore(store);
  return { provider, fetcher, advance: (ms: number) => { at += ms; }, fail: (value = true) => { failed = value; } };
}

describe("재무 캐시 메모리 한도와 마지막 정상 자료 보존", () => {
  it.runIf(pgUrl)("격리 PostgreSQL도 이전 시각 upsert를 거절하고 cold 복원에서 외부 재조회 없이 0값을 보존한다", async () => {
    const url = new URL(pgUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("로컬 격리 DB만 허용합니다");
    const admin = createDb(pgUrl!).db;
    const name = `fundamentals_risk_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    url.pathname = `/${name}`;
    const db = await createMigratedDb(url.toString());
    try {
      const store = createFundamentalsCacheStore(db);
      const first = setup(store);
      const original = await first.provider.getWithStatus("005930"); await first.provider.flushCache();
      const old = (await store.load("005930"))!;
      const newer = { ...old, at: AT + 1, receivedAt: AT + 1, value: { ...old.value!, per: 20 } };
      await store.save("005930", newer); await store.save("005930", old);
      expect(await store.load("005930")).toEqual(newer);
      const cold = setup(store); cold.advance(1);
      expect(await cold.provider.getWithStatus("005930")).toEqual({ ...original, value: newer.value, receivedAt: "2026-12-28T09:30:00+09:00" });
      expect(cold.fetcher).toHaveBeenCalledTimes(0);
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    }
  });
  it("실제 SQLite에 보존한 520종목은 500키만 남고 제외된 정상 자료는 외부 재조회 없이 정확히 복원된다", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      const store = createFundamentalsCacheStore(db);
      const load = vi.spyOn(store, "load");
      const save = vi.spyOn(store, "save");
      const s = setup(store, 500);
      const first = await s.provider.getWithStatus("000001");
      for (let i = 2; i <= 520; i++) await s.provider.get(String(i).padStart(6, "0"));
      await s.provider.flushCache();
      expect(s.provider.cacheStats()).toEqual({ entries: 500, limit: 500, pendingWrites: 0, safetyOverflow: 0, persistenceFailures: 0 });
      expect(await db.selectFrom("fundamentals_cache").selectAll().execute()).toHaveLength(520);
      load.mockClear(); save.mockClear();
      expect(await s.provider.getWithStatus("000001")).toEqual(first);
      expect(s.fetcher).toHaveBeenCalledTimes(520);
      expect(load).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(0);
      load.mockClear();
      expect(await s.provider.getWithStatus("000001")).toEqual(first);
      expect(load).toHaveBeenCalledTimes(0); expect(save).toHaveBeenCalledTimes(0);
    } finally { await db.destroy(); }
  });

  it("실제 파일 DB를 닫고 새 인스턴스로 열어도 원 값과 수신 시각·남은 TTL이 유지되며 만료 후 실패만 오래됨으로 표시한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fundamentals-risk-"));
    const path = join(dir, "cache.sqlite");
    let db = await createMigratedDb(path);
    try {
      const first = setup(createFundamentalsCacheStore(db));
      const original = await first.provider.getWithStatus("005930");
      await first.provider.flushCache(); await db.destroy();
      const worker = fileURLToPath(new URL("./fixtures/fundamentalsColdWorker.ts", import.meta.url));
      const coldProcess = await promisify(execFile)(process.execPath, ["--import", "tsx", worker, path, String(AT + HOUR - 1)], { timeout: 10_000 });
      expect(JSON.parse(coldProcess.stdout)).toEqual({ result: original, fetches: 0 });
      db = await createMigratedDb(path);
      const next = setup(createFundamentalsCacheStore(db));
      next.advance(HOUR - 1); next.fail();
      expect(await next.provider.getWithStatus("005930")).toEqual(original);
      expect(next.fetcher).toHaveBeenCalledTimes(0);
      next.advance(1);
      expect(await next.provider.getWithStatus("005930")).toEqual({ ...original, refreshFailed: true });
      expect(next.fetcher).toHaveBeenCalledTimes(1);
      next.advance(119_999);
      expect(await next.provider.getWithStatus("005930")).toEqual({ ...original, refreshFailed: true });
      expect(next.fetcher).toHaveBeenCalledTimes(1);
      next.advance(1); next.fail(false);
      const recovered = await next.provider.getWithStatus("005930");
      expect(recovered.value).toEqual(original.value);
      expect(recovered).toMatchObject({ refreshFailed: false, receivedAt: "2026-12-28T10:32:00+09:00" });
      await next.provider.flushCache();
    } finally {
      await db.destroy();
      if (!resolve(dir).startsWith(resolve(tmpdir()) + "\\fundamentals-risk-") && !resolve(dir).startsWith(resolve(tmpdir()) + "/fundamentals-risk-")) throw new Error("시험 임시 경로 불일치");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("쓰기 실패 중에는 정상값을 버리지 않고 한도 초과를 드러내며 읽기 요청에서 저장이 회복되면 한도로 돌아온다", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      const real = createFundamentalsCacheStore(db);
      let broken = true;
      const store: FundamentalsCacheStore = { load: real.load, save: (code, entry) => broken ? Promise.reject(new Error("시험 쓰기 실패")) : real.save(code, entry) };
      const s = setup(store);
      const first = await s.provider.getWithStatus("000001");
      await s.provider.get("000002"); await s.provider.get("000003"); await s.provider.flushCache();
      expect(s.provider.cacheStats()).toMatchObject({ entries: 3, limit: 2, safetyOverflow: 1, persistenceFailures: 3 });
      s.advance(HOUR); s.fail(); broken = false;
      expect(await s.provider.getWithStatus("000001")).toEqual({ ...first, refreshFailed: true });
      await s.provider.flushCache();
      expect(s.provider.cacheStats()).toMatchObject({ entries: 2, safetyOverflow: 0 });
      expect((await real.load("000001"))?.receivedAt).toBe(AT);
    } finally { await db.destroy(); }
  });

  it("느린 저장은 정상 응답을 막지 않고 동시 cold 조회는 DB와 공급자 각각 한 번만 부른다", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: FundamentalsCacheStore = { load: vi.fn(async () => null), save: vi.fn(() => gate) };
    const s = setup(store);
    const [a, b] = await Promise.all([s.provider.getWithStatus("005930"), s.provider.getWithStatus("005930")]);
    expect(a).toEqual(b); expect(a.value?.pbr).toBe(0);
    expect(s.fetcher).toHaveBeenCalledTimes(1); expect(store.load).toHaveBeenCalledTimes(1);
    expect(s.provider.cacheStats().pendingWrites).toBe(1);
    release(); await s.provider.flushCache();
    expect(s.provider.cacheStats().pendingWrites).toBe(0);
  });

  it("뒤늦은 옛 저장은 최신값을 덮지 않고 정상 빈 자료는 오래된 숫자를 되살리지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      const store = createFundamentalsCacheStore(db);
      const s = setup(store);
      await s.provider.get("005930"); await s.provider.flushCache();
      const old = (await store.load("005930"))!;
      const empty = { at: AT + HOUR, ttl: HOUR, receivedAt: null, refreshFailed: false, value: null };
      await store.save("005930", empty); await store.save("005930", old);
      expect(await store.load("005930")).toEqual(empty);
      const cold = setup(store); cold.advance(HOUR); cold.fail();
      expect(await cold.provider.getWithStatus("005930")).toEqual({ value: null, receivedAt: null, refreshFailed: false });
      expect(cold.fetcher).toHaveBeenCalledTimes(0);
      expect(parseFundamentalsCache("broken")).toBeNull();
      expect(parseFundamentalsCache(JSON.stringify({ ...old, receivedAt: "" }))).toBeNull();
      expect(parseFundamentalsCache(JSON.stringify({ ...old, value: { ...old.value, pbr: "0" } }))).toBeNull();
    } finally { await db.destroy(); }
  });

  it("시세 상세는 최신 체결 시각과 오래된 재무 원 수신 시각을 분리하고 공급자가 이미 준 숫자는 보강 목록에 넣지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      const s = setup(createFundamentalsCacheStore(db));
      await s.provider.get("005930"); await s.provider.flushCache(); s.advance(HOUR); s.fail();
      const quotes = new FakeQuoteProvider("toss");
      const raw = quotes.getQuote.bind(quotes);
      quotes.getQuote = async code => ({ ...await raw(code), per: 22, asOf: "2026-12-28T10:30:00+09:00" });
      const service = new StockService({ db, quotes, search: new FakeSearchProvider(), master: new FakeMasterProvider(), fundamentals: s.provider, now: () => new Date(AT + HOUR) });
      const quote = await service.getQuote("005930", { fresh: true });
      expect(quote).toMatchObject({ per: 22, pbr: 0, asOf: "2026-12-28T10:30:00+09:00", fundamentalsBasis: { receivedAt: "2026-12-28T09:30:00+09:00", refreshFailed: true, source: "naver", fields: ["pbr", "dividendYieldPct"] } });
      expect(s.fetcher).toHaveBeenCalledTimes(2);
      const saved = await db.selectFrom("quote_cache").select("payload").where("code", "=", "005930").executeTakeFirstOrThrow();
      expect(JSON.parse(saved.payload).fundamentalsBasis).toEqual(quote.fundamentalsBasis);
    } finally { await db.destroy(); }
  });
});
