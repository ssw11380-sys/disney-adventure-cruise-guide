import { afterEach, describe, expect, it, vi } from "vitest";
import { NaverFundamentals } from "../src/providers/market/fundamentals.js";
import { SOURCE_TIMEOUT_MS } from "../src/lib/timedFetch.js";
import { MarketCalendar } from "../src/providers/market/calendar.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeInvestorFlow, FakeQuoteProvider, fakeProviders } from "./helpers.js";
import type { RegisteredStock } from "../src/domain/types.js";

const AT = Date.parse("2026-12-28T09:30:00+09:00");
const HOUR = 3_600_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const body = (pbr: number) => ({ totalInfos: [{ code: "per", value: "15" }, { code: "pbr", value: String(pbr) }] });
const fxBody = (rate: number) => ({ exchangeInfo: { closePrice: String(rate) } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("4차 장기 캐시와 동시 갱신", () => {
  it("만료 후 겹친 조회의 늦은 실패가 새 정상 PBR을 이전 값으로 되돌리지 않는다", async () => {
    let clock = AT;
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    let first = true;
    const f = new NaverFundamentals(async () => {
      if (first) { first = false; return json(body(1)); }
      const request = deferred<Response>(); pending.push(request); return request.promise;
    }, () => new Date(clock));
    expect((await f.get("005930"))?.pbr).toBe(1);
    clock += HOUR;
    const a = f.get("005930");
    const b = f.get(" 005930 ");
    pending[0]!.resolve(json(body(2)));
    expect((await a)?.pbr).toBe(2);
    // 구형 구현은 같은 종목을 두 번 요청하고 이 늦은 오류로 새 값을 덮는다.
    pending[1]?.resolve(json({}, 503));
    expect((await b)?.pbr).toBe(2);
    expect((await f.get("005930"))?.pbr).toBe(2);
    expect(pending).toHaveLength(1);
  });

  it("같은 공개 종목의 동시 20회 요청은 한 번 받고 서로 다른 종목은 기다리지 않는다", async () => {
    const waits = new Map<string, ReturnType<typeof deferred<Response>>[]>();
    const f = new NaverFundamentals(async input => {
      const code = String(input).match(/stock\/(.*?)\/integration/)![1]!;
      const request = deferred<Response>();
      waits.set(code, [...(waits.get(code) ?? []), request]);
      return request.promise;
    }, () => new Date(AT));
    const same = Array.from({ length: 20 }, () => f.get("005930", "KOSPI"));
    const other = f.get("000660", "KOSPI");
    for (const request of waits.get("000660")!) request.resolve(json(body(3)));
    expect((await other)?.pbr).toBe(3);
    for (const request of waits.get("005930")!) request.resolve(json(body(2)));
    const results = await Promise.all(same);
    expect(results.every(result => result?.pbr === 2)).toBe(true);
    expect(waits.get("005930")).toHaveLength(1);
    expect(waits.get("000660")).toHaveLength(1);
  });

  it("환율 만료 뒤 겹친 조회는 한 번 갱신하며 늦은 예전 응답이 최신 값과 시각을 덮지 않는다", async () => {
    let clock = AT;
    let first = true;
    const pending: ReturnType<typeof deferred<Response>>[] = [];
    const f = new NaverFundamentals(async () => {
      if (first) { first = false; return json(fxBody(1300)); }
      const request = deferred<Response>(); pending.push(request); return request.promise;
    }, () => new Date(clock));
    expect(await f.usdKrw()).toBe(1300);
    clock += 60_000;
    const a = f.usdKrwQuote();
    const b = f.usdKrw();
    pending[0]!.resolve(json(fxBody(1400)));
    const latest = await a;
    pending[1]?.resolve(json(fxBody(1350)));
    expect(await b).toBe(1400);
    expect(await f.usdKrwQuote()).toEqual(latest);
    expect(latest).toEqual({ rate: 1400, source: "naver", asOf: "2026-12-28T09:31:00+09:00" });
    expect(pending).toHaveLength(1);
  });

  it("공급자가 신호를 무시해도 기존 제한 시간 뒤 종료하고 실패 캐시 만료 후 회복한다", async () => {
    vi.useFakeTimers();
    let clock = AT;
    let stalled = false;
    let calls = 0;
    const late = deferred<Response>();
    const f = new NaverFundamentals(async () => {
      calls++;
      return stalled ? late.promise : json(body(calls === 1 ? 1 : 3));
    }, () => new Date(clock));
    expect((await f.get("005930"))?.pbr).toBe(1);
    clock += HOUR; stalled = true;
    const run = Promise.all([f.get("005930"), f.get("005930")]);
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
    expect((await run).map(result => result?.pbr)).toEqual([1, 1]);
    clock += 120_000; stalled = false;
    expect((await f.get("005930"))?.pbr).toBe(3);
    late.resolve(json(body(9)));
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.get("005930"))?.pbr).toBe(3);
    expect(calls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("정상 마지막 값과 실패 2분 캐시를 보존하고 값 없음 응답은 정상 1시간 캐시한다", async () => {
    let clock = AT;
    let phase: "good" | "fail" | "absent" = "good";
    let calls = 0;
    const f = new NaverFundamentals(async () => {
      calls++;
      return phase === "good" ? json(body(0)) : json({}, phase === "fail" ? 503 : 404);
    }, () => new Date(clock));
    const good = await f.get("005930");
    expect(good?.pbr).toBe(0);
    phase = "fail"; clock += HOUR;
    expect(await f.get("005930")).toEqual(good);
    clock += 119_999;
    expect(await f.get("005930")).toEqual(good); expect(calls).toBe(2);
    phase = "absent"; clock += 1;
    expect(await f.get("005930")).toBeNull(); expect(calls).toBe(3);
    clock += HOUR - 1;
    expect(await f.get("005930")).toBeNull(); expect(calls).toBe(3);
  });

  it("미국 자동완성·후보 전체를 공유하고 파싱 예외가 난 종목은 다음 조회에서 회복한다", async () => {
    const calls: string[] = [];
    let malformed = true;
    const f = new NaverFundamentals(async input => {
      const url = String(input); calls.push(url);
      if (url.includes("/005930/")) return json(malformed ? { totalInfos: { length: 1 } } : body(2));
      if (url.includes("ac.stock.naver.com")) return json({ items: [] });
      if (url.includes("/KO/basic")) return json({ stockItemTotalInfos: body(3).totalInfos, stockName: "코카콜라" });
      return json({}, 404);
    }, () => new Date(AT));
    const results = await Promise.all([f.get(" ko ", "US"), f.get("KO", "NYSE"), f.exDividendAt("KO")]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ pbr: 3, name: "코카콜라" });
    expect(results[2]).toBeNull();
    expect(calls).toHaveLength(3); // 자동완성 + KO.O 없음 + KO 성공
    const failures = await Promise.allSettled([f.get("005930"), f.get("005930")]);
    expect(failures.map(result => result.status)).toEqual(["rejected", "rejected"]);
    malformed = false;
    expect((await f.get("005930"))?.pbr).toBe(2);
    expect(calls.filter(url => url.includes("/005930/"))).toHaveLength(2);
  });

  it("우선 환율의 실패·복구에서도 대기 작업을 회수하고 옛 값의 출처·시각을 보존한다", async () => {
    let clock = AT;
    let primaryCalls = 0;
    let naverCalls = 0;
    let unavailable = false;
    const f = new NaverFundamentals(async () => {
      naverCalls++; return json({}, 503);
    }, () => new Date(clock));
    f.fxPrimary = async () => { primaryCalls++; if (unavailable) throw new Error("검증용 공급자 중단"); return 1400; };
    const initial = await f.usdKrwQuote();
    expect(initial).toEqual({ rate: 1400, source: "toss", asOf: "2026-12-28T09:30:00+09:00" });
    clock += 60_000; unavailable = true;
    expect(await Promise.all([f.usdKrwQuote(), f.usdKrwQuote()])).toEqual([initial, initial]);
    expect(primaryCalls).toBe(2); expect(naverCalls).toBe(1);
    unavailable = false;
    expect(await f.usdKrwQuote()).toEqual({ ...initial, asOf: "2026-12-28T09:31:00+09:00" });
    expect(primaryCalls).toBe(3); expect(naverCalls).toBe(1);
  });

  it("동시에 만든 두 계좌의 수집 결과는 순차 결과와 같고 공개 재무만 공유한다", async () => {
    const now = () => new Date(AT);
    const accountA: RegisteredStock = { code: "005930", name: "삼성전자", market: "KOSPI", quantity: 2, avgPrice: 90_000, memo: null, createdAt: now().toISOString(), updatedAt: now().toISOString() };
    const accountB = { ...accountA, quantity: 7, avgPrice: 80_000 };
    const collect = (fundamentals: NaverFundamentals) => new DataCollector({
      ...fakeProviders({ fundamentals, quotes: new FakeQuoteProvider("고정 시세"), investorFlow: new FakeInvestorFlow(), calendar: new MarketCalendar(async () => json({}, 503), now) }), now,
    });
    const sequential = collect(new NaverFundamentals(async () => json(body(2)), now));
    const expectedA = await sequential.collectBriefing(accountA);
    const expectedB = await sequential.collectBriefing(accountB);
    let calls = 0;
    const concurrent = collect(new NaverFundamentals(async () => { calls++; return json(body(2)); }, now));
    const [actualA, actualB] = await Promise.all([concurrent.collectBriefing(accountA), concurrent.collectBriefing(accountB)]);
    expect(actualA).toEqual(expectedA); expect(actualB).toEqual(expectedB);
    expect(actualA.holding).toEqual({ marketValue: 200_000, profit: 20_000, profitRate: 11.11 });
    expect(actualB.holding).toEqual({ marketValue: 700_000, profit: 140_000, profitRate: 25 });
    expect(actualA.recentCandles).toHaveLength(10);
    expect(actualA.news).toHaveLength(3);
    expect(actualA.investorFlow).toHaveLength(10);
    expect(calls).toBe(1);
    // 공개 공급자의 공유 검사이며 HTTP 계정 인증·권한 격리를 증명하지 않는다.
  });
});
