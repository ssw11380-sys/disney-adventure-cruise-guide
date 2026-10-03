import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { seoulIso } from "../src/lib/time.js";
import { MarketCalendar } from "../src/providers/market/calendar.js";
import { NaverFundamentals } from "../src/providers/market/fundamentals.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeGenerator, FakeInvestorFlow, FakeQuoteProvider, fakeProviders } from "./helpers.js";

const AT = Date.parse("2026-12-28T09:30:00+09:00");
const HOUR = 3_600_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fundBody = (pbr = 2) => ({ totalInfos: [{ code: "per", value: "15" }, { code: "pbr", value: String(pbr) }] });
const stock = { code: "005930", name: "삼성전자", market: "KOSPI" as const, quantity: 12, avgPrice: 90_000, memo: null, createdAt: seoulIso(new Date(AT)), updatedAt: seoulIso(new Date(AT)) };
const staleLabel = "재무 보강 갱신 실패(2026-12-28T09:30:00+09:00 수신 자료 사용)";

function scenario() {
  let clock = AT;
  let phase: "success" | "fail" | "absent" | "malformed" = "success";
  let calls = 0;
  const now = () => new Date(clock);
  const fundamentals = new NaverFundamentals(async () => {
    calls++;
    if (phase === "fail") return json({}, 503);
    if (phase === "absent") return json({}, 404);
    if (phase === "malformed") return json({ totalInfos: { length: 1 } });
    return json(fundBody(0));
  }, now);
  const quotes = new FakeQuoteProvider("가상 정상 시세");
  const original = quotes.getQuote.bind(quotes);
  quotes.getQuote = async code => ({ ...await original(code), asOf: seoulIso(now()) });
  const providers = fakeProviders({ quotes, fundamentals, calendar: new MarketCalendar(async () => json({}, 503), now) });
  const collector = new DataCollector({ ...providers, investorFlow: new FakeInvestorFlow(), now });
  return { now, fundamentals, providers, collector, calls: () => calls, advance: (ms: number) => { clock += ms; }, phase: (next: typeof phase) => { phase = next; } };
}

describe("잔여 검증: 재무 보강 원 수신 시각과 실패 안내", () => {
  it("현재가는 새로 받아도 옛 재무 fallback을 새 자료처럼 안내하지 않는다", async () => {
    const s = scenario();
    const fresh = await s.collector.collectAnalysis(stock, "value");
    expect(fresh.quote).toMatchObject({ pbr: 0, price: 100_000, asOf: "2026-12-28T09:30:00+09:00" });
    expect(fresh.missing.some(label => label.startsWith("재무 보강"))).toBe(false);
    s.advance(HOUR); s.phase("fail");
    const stale = await s.collector.collectAnalysis(stock, "value");
    expect(stale.quote).toMatchObject({ pbr: 0, price: 100_000, asOf: "2026-12-28T10:30:00+09:00" });
    expect(stale.missing).toContain(staleLabel);
    const briefing = await s.collector.collectBriefing(stock);
    expect(briefing.missing).toContain(staleLabel);
    expect(briefing.holding).toEqual({ marketValue: 1_200_000, profit: 120_000, profitRate: 11.11 });
    expect(s.calls()).toBe(2);
  });

  it("실패 안내와 원래 0값이 모델 입력·저장·캐시 응답까지 유지된다", async () => {
    const s = scenario();
    await s.fundamentals.get(stock.code);
    s.advance(HOUR); s.phase("fail");
    const generator = new FakeGenerator();
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: { ...s.providers, generator }, logger: false, enableScheduler: false, now: s.now });
    try {
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      const response = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/value" });
      expect(response.statusCode).toBe(200);
      expect(response.json().missing).toContain(staleLabel);
      expect(generator.requests[0]!.user).toContain(staleLabel);
      expect(generator.requests[0]!.user).toContain('"pbr": 0');
      expect(generator.requests[0]).toMatchObject({ maxTokens: 4096, effort: "high", label: "value_analysis:005930" });
      const row = await db.selectFrom("analyses").selectAll().executeTakeFirstOrThrow();
      expect(JSON.parse(row.missing_data)).toContain(staleLabel);
      expect(JSON.parse(row.data_snapshot).quote.pbr).toBe(0);
      const cached = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/value" });
      expect(cached.json()).toMatchObject({ id: response.json().id, missing: response.json().missing, cached: true });
      expect(generator.requests).toHaveLength(1);
      expect(s.calls()).toBe(2);
    } finally { await app.close(); await db.destroy(); }
  });

  it("실패 캐시·연속 실패는 원 수신 시각을 유지하고 성공 회복 뒤에만 새 시각으로 바뀐다", async () => {
    const s = scenario();
    expect(await s.fundamentals.getWithStatus(stock.code)).toMatchObject({ value: { pbr: 0 }, receivedAt: "2026-12-28T09:30:00+09:00", refreshFailed: false });
    s.advance(HOUR); s.phase("fail");
    const stale = await s.fundamentals.getWithStatus(stock.code);
    expect(stale).toMatchObject({ value: { pbr: 0 }, receivedAt: "2026-12-28T09:30:00+09:00", refreshFailed: true });
    s.advance(119_999);
    expect(await s.fundamentals.getWithStatus(stock.code)).toEqual(stale);
    expect(s.calls()).toBe(2);
    s.advance(1);
    expect(await s.fundamentals.getWithStatus(stock.code)).toEqual(stale);
    expect(s.calls()).toBe(3);
    s.advance(120_000); s.phase("success");
    expect(await s.fundamentals.getWithStatus(stock.code)).toMatchObject({ value: { pbr: 0 }, receivedAt: "2026-12-28T10:34:00+09:00", refreshFailed: false });
    const recovered = await s.collector.collectAnalysis(stock, "value");
    expect(recovered.missing.some(label => label.startsWith("재무 보강"))).toBe(false);
    expect(s.calls()).toBe(4);
  });

  it("첫 조회 실패·파싱 실패·정상 값 없음은 서로 구별하고 파싱 오류 뒤에도 회복한다", async () => {
    const failed = scenario(); failed.phase("fail");
    expect(await failed.fundamentals.getWithStatus(stock.code)).toEqual({ value: null, receivedAt: null, refreshFailed: true });
    expect((await failed.collector.collectAnalysis(stock, "value")).missing).toContain("재무 보강 갱신 실패(사용할 이전 자료 없음)");
    expect(failed.calls()).toBe(1);
    const malformed = scenario(); malformed.phase("malformed");
    expect((await malformed.collector.collectAnalysis(stock, "value")).missing).toContain("재무 보강 갱신 실패(사용할 이전 자료 없음)");
    malformed.phase("success");
    expect((await malformed.collector.collectAnalysis(stock, "value")).missing.some(label => label.startsWith("재무 보강"))).toBe(false);
    expect(malformed.calls()).toBe(2);
    const absent = scenario(); absent.phase("absent");
    expect(await absent.fundamentals.getWithStatus(stock.code)).toEqual({ value: null, receivedAt: null, refreshFailed: false });
    expect((await absent.collector.collectAnalysis(stock, "value")).missing.some(label => label.startsWith("재무 보강"))).toBe(false);
    expect(absent.calls()).toBe(1);
  });

  it("상태 포함 조회와 기존 조회가 같은 진행 중 요청을 공유하고 실제 응답 시각을 기록한다", async () => {
    let clock = AT;
    let finish!: (response: Response) => void;
    let calls = 0;
    const f = new NaverFundamentals(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); }, () => new Date(clock));
    const direct = f.get(stock.code);
    const states = Array.from({ length: 20 }, () => f.getWithStatus(" 005930 "));
    clock += 50;
    finish(json(fundBody(0)));
    const value = await direct;
    const results = await Promise.all(states);
    expect(calls).toBe(1);
    for (const result of results) expect(result).toEqual({ value, receivedAt: seoulIso(new Date(clock)), refreshFailed: false });
  });
});

describe("잔여 검증: 환율 갱신 실패와 원 수신 시각", () => {
  function usdScenario() {
    let clock = AT;
    let unavailable = false;
    let primaryCalls = 0;
    let backupCalls = 0;
    const now = () => new Date(clock);
    const fundamentals = new NaverFundamentals(async () => { backupCalls++; return json({}, 503); }, now);
    fundamentals.fxPrimary = async () => { primaryCalls++; if (unavailable) throw new Error("가상 환율 공급자 중단"); return 1400; };
    const quotes = new FakeQuoteProvider("가상 미국 시세", { price: 200 });
    const original = quotes.getQuote.bind(quotes);
    quotes.getQuote = async code => ({ ...await original(code), currency: "USD", per: 15, pbr: 2, asOf: seoulIso(now()) });
    const providers = fakeProviders({ quotes, fundamentals, calendar: new MarketCalendar(async () => json({}, 503), now) });
    return { now, fundamentals, providers, collector: new DataCollector({ ...providers, now }), advance: (ms: number) => { clock += ms; }, fail: () => { unavailable = true; }, recover: () => { unavailable = false; }, calls: () => ({ primaryCalls, backupCalls }) };
  }
  const usStock = { ...stock, code: "AAPL", name: "애플", market: "NASDAQ" as const, avgPrice: 190 };
  const fxStaleLabel = "환율 갱신 실패(2026-12-28T09:30:00+09:00 수신 자료 사용)";

  it("두 환율 소스가 실패하면 마지막 환율을 보존하면서 최신 시세와 다른 수신 시각을 안내한다", async () => {
    const s = usdScenario();
    const first = await s.collector.collectAnalysis(usStock, "value");
    expect(first.quote).toMatchObject({ price: 200, fxRate: 1400, priceKrw: 280_000 });
    expect(first.missing.some(label => label.startsWith("환율"))).toBe(false);
    s.advance(60_000); s.fail();
    const failed = await s.collector.collectAnalysis(usStock, "value");
    expect(failed.quote).toMatchObject({ price: 200, fxRate: 1400, priceKrw: 280_000, asOf: "2026-12-28T09:31:00+09:00" });
    expect(failed.missing).toContain(fxStaleLabel);
    expect(s.calls()).toEqual({ primaryCalls: 2, backupCalls: 1 });
    s.advance(60_000); s.recover();
    const recovered = await s.collector.collectBriefing(usStock);
    expect(recovered.missing.some(label => label.startsWith("환율"))).toBe(false);
    expect(recovered.quote).toMatchObject({ fxRate: 1400, priceKrw: 280_000 });
    expect(s.calls()).toEqual({ primaryCalls: 3, backupCalls: 1 });
  });

  it("처음부터 환율을 받지 못하면 환산값을 만들지 않고 모델 입력·DB·캐시에도 미확인을 보존한다", async () => {
    const s = usdScenario(); s.fail();
    const generator = new FakeGenerator();
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: { ...s.providers, generator }, logger: false, enableScheduler: false, now: s.now });
    try {
      await db.insertInto("listed_stocks").values({ code: usStock.code, name: usStock.name, market: usStock.market, isin_code: null, group_code: "ST", updated_at: seoulIso(s.now()) }).execute();
      const result = await app.inject({ method: "GET", url: "/api/stocks/AAPL/analysis/value" });
      expect(result.statusCode).toBe(200);
      const label = "환율 갱신 실패(환율 자료 미확인)";
      expect(result.json().missing).toContain(label);
      expect(generator.requests[0]!.user).toContain(label);
      const row = await db.selectFrom("analyses").selectAll().executeTakeFirstOrThrow();
      const snapshot = JSON.parse(row.data_snapshot);
      expect(snapshot.quote.price).toBe(200);
      expect(snapshot.quote.fxRate).toBeUndefined();
      expect(snapshot.quote.priceKrw).toBeUndefined();
      expect(JSON.parse(row.missing_data)).toContain(label);
      const cached = await app.inject({ method: "GET", url: "/api/stocks/AAPL/analysis/value" });
      expect(cached.json()).toMatchObject({ id: result.json().id, missing: result.json().missing, cached: true });
      expect(generator.requests).toHaveLength(1);
      expect(s.calls()).toEqual({ primaryCalls: 1, backupCalls: 1 });
    } finally { await app.close(); await db.destroy(); }
  });

  it("시간 경과만으로 실패라 하지 않고 우선 소스 실패 뒤 보조 소스 성공도 정상으로 전달한다", async () => {
    let clock = AT;
    let broken = false;
    let primaryCalls = 0;
    let backupCalls = 0;
    const f = new NaverFundamentals(async () => { backupCalls++; return json({ exchangeInfo: { closePrice: "1350" } }); }, () => new Date(clock));
    f.fxPrimary = async () => { primaryCalls++; if (broken) throw new Error("가상 우선 환율 중단"); return 1400; };
    expect(await f.usdKrwQuoteWithStatus()).toEqual({ value: { rate: 1400, source: "toss", asOf: "2026-12-28T09:30:00+09:00" }, refreshFailed: false });
    clock += 59_999; broken = true;
    expect((await f.usdKrwQuoteWithStatus()).refreshFailed).toBe(false);
    expect(primaryCalls).toBe(1);
    clock += 1;
    expect(await f.usdKrwQuoteWithStatus()).toEqual({ value: { rate: 1350, source: "naver", asOf: "2026-12-28T09:31:00+09:00" }, refreshFailed: false });
    expect(primaryCalls).toBe(2); expect(backupCalls).toBe(1);
  });

  it("숫자·기존 시각·새 상태 API의 동시 환율 요청이 같은 갱신을 공유한다", async () => {
    let finish!: (rate: number) => void;
    let primaryCalls = 0;
    const f = new NaverFundamentals(async () => { throw new Error("보조 소스 요청이 필요하지 않음"); }, () => new Date(AT));
    f.fxPrimary = async () => { primaryCalls++; return new Promise<number>(resolve => { finish = resolve; }); };
    const rate = f.usdKrw();
    const legacy = f.usdKrwQuote();
    const statuses = Array.from({ length: 20 }, () => f.usdKrwQuoteWithStatus());
    finish(1400);
    expect(await rate).toBe(1400);
    const quote = await legacy;
    expect(quote).toEqual({ rate: 1400, source: "toss", asOf: "2026-12-28T09:30:00+09:00" });
    for (const status of await Promise.all(statuses)) expect(status).toEqual({ value: quote, refreshFailed: false });
    expect(primaryCalls).toBe(1);
  });
});
