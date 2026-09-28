import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, createMigratedDb, migrate, type Db } from "../src/db/index.js";
import type { CandlePeriod, CandleSeries } from "../src/domain/types.js";
import { ProviderError } from "../src/lib/errors.js";
import { BACKUP_TABLES, BackupService, decodeBackup, encryptJsonBackup, restoreBackup } from "../src/services/backupService.js";
import { checkValue, hasCents, PriceAlertService } from "../src/services/priceAlertService.js";
import { FakeQuoteProvider, fakeProviders } from "./helpers.js";
import { aBars } from "./volumeBars.js";

/**
 * 가격·등락률·거래량 알림 서버 (3-29, 플래그 priceAlerts): 조건 저장·목록·지우기, 울림 기록(하루 한 번 · 옛 날짜가 새 날짜를 덮지 않음),
 * 거래량 급증 상태(30분봉), 검사 차례와 한국어 오류 글, 꺼짐(빈 목록·409·봉 조회 0), 재시작 뒤 유지, 백업.
 * 시계는 2026-12-08 10:15 (서울) 고정, 네트워크 없음
 */
const NOW = () => new Date("2026-12-08T10:15:00+09:00");

/** 30분봉 요청만 따로 적는 가짜 시세 (calls 는 등록 때 시세 요청도 세므로 봉 요청 수에 쓰지 않는다) */
class CandleQuotes extends FakeQuoteProvider {
  candleCalls: { code: string; period: CandlePeriod; count: number }[] = [];
  constructor(opts: { failCandles?: boolean } = {}) {
    super("kis", opts);
  }
  override async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    if (period !== "30m") return super.getCandles(code, period, count);
    this.candleCalls.push({ code, period, count });
    if (this.opts.failCandles) throw new ProviderError(this.name, "고의 실패");
    return { code, period, candles: aBars(), source: this.name };
  }
}

let apps: FastifyInstance[] = [];
let dbs: Db[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dbs) await d.destroy();
  apps = [];
  dbs = [];
});

async function setup(o: { now?: () => Date; failCandles?: boolean; db?: Db } = {}) {
  const db = o.db ?? (await createMigratedDb(":memory:"));
  if (!o.db) dbs.push(db);
  const quotes = new CandleQuotes({ failCandles: o.failCandles ?? false });
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ quotes }), logger: false, enableScheduler: false, now: o.now ?? NOW });
  apps.push(app);
  return { app, db, quotes };
}

const register = (db: Db, ...codes: string[]) =>
  db
    .insertInto("registered_stocks")
    .values(codes.map((code) => ({ code, name: code, market: /^\d/.test(code) ? "KOSPI" : "NASDAQ", quantity: null, avg_price: null, memo: null, created_at: "2026-12-01T09:00:00+09:00", updated_at: "2026-12-01T09:00:00+09:00" })))
    .execute();

const post = (app: FastifyInstance, payload: unknown) => app.inject({ method: "POST", url: "/api/price-alerts", ...(payload === undefined ? {} : { payload: payload as object }) });
const rules = async (app: FastifyInstance) => (await app.inject({ method: "GET", url: "/api/price-alerts" })).json().rules as { id: number; code: string; kind: string; value: number; registered: boolean; firedOn: string | null; firedAt: string | null; firedValue: number | null }[];
const fired = (app: FastifyInstance, id: number, date: string, value = 88_700) => app.inject({ method: "POST", url: `/api/price-alerts/${id}/fired`, payload: { date, at: `${date}T10:12:05.000Z`, value } });

describe("만들기 · 목록 · 지우기", () => {
  it("201 모양(통화 KRW/USD/null · registered), 목록은 종목 코드·id 순, 지우기 204, 없는 id 404", async () => {
    const { app, db } = await setup();
    await register(db, "005930", "AAPL", "000660");
    const a = await post(app, { code: "005930", kind: "priceAbove", value: 88_600 });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toEqual({ id: 1, code: "005930", kind: "priceAbove", value: 88_600, currency: "KRW", createdAt: "2026-12-08T10:15:00+09:00", firedOn: null, firedAt: null, firedValue: null, registered: true });
    expect((await post(app, { code: "aapl", kind: "priceBelow", value: 180 })).json()).toMatchObject({ code: "AAPL", currency: "USD", value: 180 });
    expect((await post(app, { code: "000660", kind: "volume", value: 3 })).json()).toMatchObject({ currency: null, kind: "volume" });
    expect((await post(app, { code: "005930", kind: "rateUp", value: 5 })).json()).toMatchObject({ currency: null });
    expect((await rules(app)).map((r) => [r.code, r.id])).toEqual([["000660", 3], ["005930", 1], ["005930", 4], ["AAPL", 2]]);
    expect((await app.inject({ method: "DELETE", url: "/api/price-alerts/4" })).statusCode).toBe(204);
    const gone = await app.inject({ method: "DELETE", url: "/api/price-alerts/4" });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: "NOT_FOUND", message: "알림을 찾을 수 없습니다" });
    expect((await rules(app)).length).toBe(3);
  });

  it("등록에서 뺀 종목의 조건은 지우지 않고 registered: false 로 준다", async () => {
    const { app } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    expect((await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } })).statusCode).toBe(201);
    await post(app, { code: "005930", kind: "priceAbove", value: 88_600 });
    expect((await rules(app))[0]).toMatchObject({ code: "005930", registered: true });
    expect((await app.inject({ method: "DELETE", url: "/api/stocks/005930" })).statusCode).toBe(204);
    expect(await rules(app)).toEqual([expect.objectContaining({ code: "005930", registered: false })]);
  });
});

describe("값 검사 (앱 validateDraft 와 같은 경계 — hasCents)", () => {
  it("소수 둘째 자리까지 식은 부동소수 꼬리에 걸리지 않는다", () => {
    for (const v of [12.1, 0.29, 0.57, 4.35, 1.15, 1.1]) expect(hasCents(v), String(v)).toBe(true);
    for (const v of [12.101, 12.345, 1.155, 0.001, Number.NaN, Infinity]) expect(hasCents(v), String(v)).toBe(false);
    expect(() => checkValue("priceAbove", 0.57, "USD")).not.toThrow();
  });

  it("미국 가격 12.1·0.29·0.57·4.35 와 등락률 1.15·1.1 은 201, 12.101·12.345·1.155 는 400", async () => {
    const { app, db } = await setup();
    await register(db, "AAPL", "005930", "000660");
    for (const v of [12.1, 0.29, 0.57, 4.35]) expect((await post(app, { code: "AAPL", kind: "priceAbove", value: v })).statusCode, String(v)).toBe(201);
    expect((await post(app, { code: "005930", kind: "rateUp", value: 1.15 })).statusCode).toBe(201);
    expect((await post(app, { code: "000660", kind: "rateUp", value: 1.1 })).statusCode).toBe(201);
    for (const v of [12.101, 12.345]) {
      const r = await post(app, { code: "AAPL", kind: "priceBelow", value: v });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: "VALIDATION", message: "value: 소수 둘째 자리까지 넣어 주세요" });
    }
    expect((await post(app, { code: "000660", kind: "rateDown", value: 1.155 })).json().message).toBe("value: 소수 둘째 자리까지 넣어 주세요");
  });

  it("범위 밖은 400 (원·달러·등락률·거래량 배수)", async () => {
    const { app, db } = await setup();
    await register(db, "005930", "AAPL");
    const cases: [unknown, string][] = [
      [{ code: "005930", kind: "rateUp", value: 0.5 }, "value: 1~30 사이로 넣어 주세요"],
      [{ code: "005930", kind: "rateUp", value: 31 }, "value: 1~30 사이로 넣어 주세요"],
      [{ code: "005930", kind: "volume", value: 4 }, "value: 2·3·5·10배 중 하나로 골라 주세요"],
      [{ code: "005930", kind: "priceAbove", value: 0 }, "value: 1원 이상 1억 원 이하로 넣어 주세요"],
      [{ code: "005930", kind: "priceAbove", value: 88_600.5 }, "value: 1원 이상 1억 원 이하로 넣어 주세요"],
      [{ code: "005930", kind: "priceAbove", value: 100_000_001 }, "value: 1원 이상 1억 원 이하로 넣어 주세요"],
      [{ code: "AAPL", kind: "priceAbove", value: 0.001 }, "value: $0.01 이상 $1,000,000 이하로 넣어 주세요"],
    ];
    for (const [body, message] of cases) {
      const r = await post(app, body);
      expect(r.statusCode, message).toBe(400);
      expect(r.json()).toEqual({ error: "VALIDATION", message });
    }
  });

  it("모양 오류는 400 VALIDATION 이고 글은 한국어 (zod 기본 영어 글이 새지 않음)", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    const bodies: unknown[] = [undefined, { code: "005930", kind: "x", value: 1 }, { code: "005930", kind: "priceAbove", value: "1" }, { kind: "priceAbove", value: 1 }, { code: "!!", kind: "priceAbove", value: 1 }, [1, 2]];
    for (const b of bodies) {
      const r = await post(app, b);
      expect(r.statusCode, JSON.stringify(b)).toBe(400);
      const { error, message } = r.json() as { error: string; message: string };
      expect(error).toBe("VALIDATION");
      expect(message).toMatch(/[가-힣]/);
      expect(message).not.toMatch(/Invalid|expected|received|Required/);
    }
    expect((await post(app, { code: "005930", kind: "x", value: 1 })).json().message).toBe("kind: 조건 종류가 올바르지 않습니다");
    expect((await post(app, { code: "005930", kind: "priceAbove", value: "1" })).json().message).toBe("value: 값은 숫자로 넣어 주세요");
    expect((await post(app, { code: "!!", kind: "priceAbove", value: 1 })).json().message).toBe("code: 종목 코드는 6자리 숫자(한국) 또는 티커(미국)");
    const badFired = await app.inject({ method: "POST", url: "/api/price-alerts/abc/fired", payload: { date: "12/8", at: "x", value: "1" } });
    expect(badFired.statusCode).toBe(400);
    expect(badFired.json().message).toBe("id: 알림 번호가 올바르지 않습니다");
    await post(app, { code: "005930", kind: "priceAbove", value: 88_600 });
    const badBody = await app.inject({ method: "POST", url: "/api/price-alerts/1/fired", payload: { date: "12/8", at: "x", value: "1" } });
    expect(badBody.json().message).toBe("date: 날짜는 YYYY-MM-DD 로 넣어 주세요; at: 시각 형식이 올바르지 않습니다; value: 값은 숫자로 넣어 주세요");
  });
});

describe("검사 차례 (값 범위 → 등록 종목 → 같은 조건 → 한도)", () => {
  it("미등록 + 범위 밖 = VALIDATION, 미등록 + 정상 = NOT_REGISTERED, 5개 찬 종목의 같은 조건 = DUPLICATE, 새 조건 = LIMIT", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    expect((await post(app, { code: "000660", kind: "rateUp", value: 50 })).json().error).toBe("VALIDATION");
    const nr = await post(app, { code: "000660", kind: "rateUp", value: 5 });
    expect(nr.statusCode).toBe(400);
    expect(nr.json()).toEqual({ error: "NOT_REGISTERED", message: "보유·관심 종목에만 알림을 걸 수 있습니다" });
    for (const v of [80_000, 81_000, 82_000, 83_000, 84_000]) expect((await post(app, { code: "005930", kind: "priceBelow", value: v })).statusCode).toBe(201);
    const dup = await post(app, { code: "005930", kind: "priceBelow", value: 80_000 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "DUPLICATE", message: "같은 알림이 이미 있습니다" });
    const lim = await post(app, { code: "005930", kind: "priceAbove", value: 90_000 });
    expect(lim.statusCode).toBe(409);
    expect(lim.json()).toEqual({ error: "LIMIT", message: "한 종목에 알림은 5개까지입니다" });
  });

  it("거래량 조건은 모두 10개까지 (11번째 409)", async () => {
    const { app, db } = await setup();
    const codes = Array.from({ length: 11 }, (_, i) => String(100_000 + i));
    await register(db, ...codes);
    for (const c of codes.slice(0, 10)) expect((await post(app, { code: c, kind: "volume", value: 3 })).statusCode).toBe(201);
    const r = await post(app, { code: codes[10], kind: "volume", value: 3 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "LIMIT", message: "거래량 알림은 모두 10개까지입니다" });
    // 가격 조건은 거래량 한도와 상관없다
    expect((await post(app, { code: codes[10], kind: "priceAbove", value: 100 })).statusCode).toBe(201);
  });

  it("모두 30개까지 (31번째 409)", async () => {
    const { app, db } = await setup();
    const codes = Array.from({ length: 7 }, (_, i) => String(200_000 + i));
    await register(db, ...codes);
    await db
      .insertInto("price_alerts")
      .values(codes.slice(0, 6).flatMap((code) => [1, 2, 3, 4, 5].map((k) => ({ code, kind: "priceAbove", value: 1000 * k, currency: "KRW", created_at: "x", fired_on: null, fired_at: null, fired_value: null }))))
      .execute();
    const r = await post(app, { code: codes[6], kind: "priceAbove", value: 1000 });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "LIMIT", message: "알림은 모두 30개까지입니다" });
  });

  it("같은 조건을 동시에 두 번 저장하면 하나만 들어가고 나머지는 409 DUPLICATE", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    const res = await Promise.all([post(app, { code: "005930", kind: "rateUp", value: 5 }), post(app, { code: "005930", kind: "rateUp", value: 5 })]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.statusCode === 409)!.json().error).toBe("DUPLICATE");
    expect((await db.selectFrom("price_alerts").selectAll().execute()).length).toBe(1);
  });
});

describe("울림 기록 (조건마다 하루 한 번)", () => {
  it("같은 날 두 번 → first true·false, 다음 날 → true, 옛 날짜는 새 날짜를 덮지 않는다", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    const { id } = (await post(app, { code: "005930", kind: "priceAbove", value: 88_600 })).json() as { id: number };
    const a = await fired(app, id, "2026-12-08", 88_700);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ first: true, rule: { firedOn: "2026-12-08", firedAt: "2026-12-08T10:12:05.000Z", firedValue: 88_700 } });
    expect((await fired(app, id, "2026-12-08", 88_900)).json().first).toBe(false);
    expect((await rules(app))[0]).toMatchObject({ firedOn: "2026-12-08", firedValue: 88_700 });
    expect((await fired(app, id, "2026-12-09", 89_000)).json().first).toBe(true);
    // 늦게 도착한 옛 날짜: 거짓이고 새 날짜 그대로
    const old = await fired(app, id, "2026-12-08", 1);
    expect(old.json()).toMatchObject({ first: false, rule: { firedOn: "2026-12-09", firedValue: 89_000 } });
    expect((await app.inject({ method: "POST", url: "/api/price-alerts/999/fired", payload: { date: "2026-12-08", at: "2026-12-08T01:00:00Z", value: 1 } })).statusCode).toBe(404);
  });

  it("두 요청을 같이 보내도 참은 하나", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    const { id } = (await post(app, { code: "005930", kind: "rateUp", value: 5 })).json() as { id: number };
    const res = await Promise.all([fired(app, id, "2026-12-08", 5.2), fired(app, id, "2026-12-08", 5.3)]);
    expect(res.map((r) => r.json().first).sort()).toEqual([false, true]);
  });

  it("재시작 뒤 유지: 서버를 닫고 같은 DB 로 다시 만들어도 조건·울린 날짜 그대로", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    const { id } = (await post(app, { code: "005930", kind: "priceAbove", value: 88_600 })).json() as { id: number };
    await fired(app, id, "2026-12-08");
    await app.close();
    apps = apps.filter((a) => a !== app);
    const again = await setup({ db });
    expect(await rules(again.app)).toEqual([expect.objectContaining({ id, code: "005930", kind: "priceAbove", value: 88_600, firedOn: "2026-12-08", registered: true })]);
  });
});

describe("거래량 급증 상태 (GET /volume)", () => {
  it("A 의 값, 30분봉 요청 1번(450개). 같은 코드는 한 번, 순서 유지", async () => {
    const { app, quotes } = await setup();
    const r = await app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930" });
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toEqual([{ code: "005930", status: "ok", date: "2026-12-08", volume: 7500, expected: 2500, ratio: 3, days: 20, minutes: 75, asOf: "2026-12-08T10:15:00+09:00", reason: null }]);
    expect(quotes.candleCalls).toEqual([{ code: "005930", period: "30m", count: 450 }]);
    expect((await app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930,005930" })).json().items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=000660, 005930" })).json().items.map((i: { code: string }) => i.code)).toEqual(["000660", "005930"]);
  });

  it("codes 검사: 없음·빈 글자 · 잘못된 코드 · 11개 → 400", async () => {
    const { app } = await setup();
    for (const url of ["/api/price-alerts/volume", "/api/price-alerts/volume?codes=", "/api/price-alerts/volume?codes=,"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(400);
      expect(r.json()).toEqual({ error: "VALIDATION", message: "codes: 종목 코드를 1개 이상 넣어 주세요" });
    }
    expect((await app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930,!!" })).json()).toEqual({ error: "VALIDATION", message: "codes: 종목 코드는 6자리 숫자(한국) 또는 티커(미국)" });
    const eleven = Array.from({ length: 11 }, (_, i) => String(300_000 + i)).join(",");
    expect((await app.inject({ method: "GET", url: `/api/price-alerts/volume?codes=${eleven}` })).json()).toEqual({ error: "VALIDATION", message: "codes: 한 번에 10종목까지입니다" });
  });

  it("개장 뒤 30분 전·장 마감이면 early·closed 이고 30분봉을 받지 않는다", async () => {
    const early = await setup({ now: () => new Date("2026-12-08T09:20:00+09:00") });
    expect((await early.app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930" })).json().items[0]).toMatchObject({ status: "early", reason: "개장 뒤 30분 전" });
    expect(early.quotes.candleCalls).toEqual([]);
    const closed = await setup({ now: () => new Date("2026-12-08T15:30:00+09:00") });
    expect((await closed.app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930" })).json().items[0]).toMatchObject({ status: "closed", date: null, reason: "정규장 시간이 아님" });
    expect(closed.quotes.candleCalls).toEqual([]);
  });

  it("봉 받기가 실패하고 받아 둔 봉도 없으면 unavailable", async () => {
    const { app, quotes } = await setup({ failCandles: true });
    expect((await app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930" })).json().items[0]).toMatchObject({ status: "unavailable", date: "2026-12-08", minutes: 75, reason: "30분봉을 받지 못함" });
    expect(quotes.candleCalls.length).toBe(1);
  });

  it("시간 예산을 넘기면 남은 종목의 봉은 받지 않고 unavailable (실제 시계 Date.now 로 잰다 — 봉마다 30ms 가 흐르게)", async () => {
    const db = await createMigratedDb(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    // 주입한 now 는 고정이라 예산은 Date.now 로 잰다. 테스트가 바쁜 컴퓨터에서 늦어져도 같은 결과가 나오게 Date.now 를 봉 받을 때마다 30ms 씩 움직인다
    let clock = Date.parse("2026-12-08T01:15:00Z");
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const svc = new PriceAlertService({
        db,
        features: { enabled: async () => true },
        candles: async (code) => {
          calls.push(code);
          await new Promise((r) => setTimeout(r, 1));
          clock += 30;
          return aBars();
        },
        now: NOW,
        volumeBudgetMs: 50,
      });
      const items = await svc.volume(["005930", "000660", "005935"]);
      expect(items.map((i) => i.status)).toEqual(["ok", "ok", "unavailable"]);
      expect(items[2]).toMatchObject({ code: "005935", reason: "시간 안에 30분봉을 받지 못함", date: "2026-12-08" });
      expect(calls).toEqual(["005930", "000660"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("꺼짐 (priceAlerts false)", () => {
  it("목록 빈 목록 · 거래량 빈 목록(봉 조회 0, codes 없어도 400 아님) · 만들기·지우기·울림 409 DISABLED, DB 그대로, 다시 켜면 조건이 보인다", async () => {
    const { app, db, quotes } = await setup();
    await register(db, "005930");
    const { id } = (await post(app, { code: "005930", kind: "priceAbove", value: 88_600 })).json() as { id: number };
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { priceAlerts: false } });
    expect((await app.inject({ method: "GET", url: "/api/price-alerts" })).json()).toEqual({ rules: [] });
    expect((await app.inject({ method: "GET", url: "/api/price-alerts/volume?codes=005930" })).json()).toEqual({ items: [] });
    expect((await app.inject({ method: "GET", url: "/api/price-alerts/volume" })).json()).toEqual({ items: [] });
    expect(quotes.candleCalls).toEqual([]);
    const off = { error: "DISABLED", message: "가격 알림 기능이 꺼져 있습니다" };
    const p = await post(app, { code: "005930", kind: "priceAbove", value: 90_000 });
    expect([p.statusCode, p.json()]).toEqual([409, off]);
    // 꺼짐이 모양 검사보다 먼저
    expect((await post(app, undefined)).json()).toEqual(off);
    const d = await app.inject({ method: "DELETE", url: `/api/price-alerts/${id}` });
    expect([d.statusCode, d.json()]).toEqual([409, off]);
    const f = await fired(app, id, "2026-12-08");
    expect([f.statusCode, f.json()]).toEqual([409, off]);
    expect(await db.selectFrom("price_alerts").select(["id", "fired_on"]).execute()).toEqual([{ id, fired_on: null }]);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { priceAlerts: true } });
    expect((await rules(app)).map((r) => r.id)).toEqual([id]);
  });
});

describe("백업 (3-7)", () => {
  const KEY = "test-key-not-a-secret";

  it("price_alerts 는 백업 표 목록에 있고, JSON 백업의 줄을 빈 DB 에 되살린다", async () => {
    expect(BACKUP_TABLES).toContain("price_alerts");
    const dir = await mkdtemp(join(tmpdir(), "pa-bk-"));
    const file = join(dir, "j.sbk");
    const row = { id: 7, code: "005930", kind: "priceAbove", value: 88_600, currency: "KRW", created_at: "2026-12-08T10:00:00+09:00", fired_on: "2026-12-08", fired_at: "2026-12-08T01:12:05.000Z", fired_value: 88_700 };
    await encryptJsonBackup({ version: 1, createdAt: "t", tables: { price_alerts: [row] } }, file, KEY);
    const decoded = await decodeBackup(await readFile(file), KEY);
    if (decoded.kind !== "json") throw new Error("json 이어야 함");
    const fresh = createDb(":memory:");
    dbs.push(fresh.db);
    await migrate(fresh.db, fresh.dialect);
    expect((await restoreBackup(fresh.db, fresh.dialect, decoded.payload))["price_alerts"]).toBe(1);
    expect(await fresh.db.selectFrom("price_alerts").selectAll().execute()).toEqual([row]);
  });

  it("SQLite 백업 뒤 줄 수에 price_alerts 가 들어간다", async () => {
    const { app, db } = await setup();
    await register(db, "005930");
    await post(app, { code: "005930", kind: "priceAbove", value: 88_600 });
    await post(app, { code: "005930", kind: "rateDown", value: 5 });
    const dir = await mkdtemp(join(tmpdir(), "pa-bk-"));
    const st = await new BackupService({ db, dialect: "sqlite", dir, key: KEY, now: NOW }).run();
    expect(st.lastCounts?.["price_alerts"]).toBe(2);
  });
});
