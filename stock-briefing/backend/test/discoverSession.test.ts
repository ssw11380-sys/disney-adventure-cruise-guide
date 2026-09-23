import { describe, expect, it } from "vitest";
import type { MarketCalendar, MarketState } from "../src/providers/market/calendar.js";
import { isMostlyZero, NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { TossTics } from "../src/providers/market/tossTics.js";
import { DiscoverService } from "../src/services/discoverService.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ isSuccess: true, result });
const memStore = () => {
  const m = new Map<string, string>();
  const writes: string[] = [];
  return { m, writes, store: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void (writes.push(k), m.set(k, v)) } };
};
const state = (market: "KR" | "US", isOpen: boolean, lastClose: string | null = null): MarketState => ({ market, isOpen, isTradingDay: true, opensAt: null, closesAt: null, lastClose, source: "toss" });
const calendarOf = (kr: MarketState, us: MarketState = state("US", false)) => ({ status: async () => ({ now: "", KR: kr, US: us }) }) as unknown as MarketCalendar;
const krRow = (code: string, rate: number, vol: number) => ({
  itemCode: code,
  name: `종목${code}`,
  stockEndType: "stock",
  marketType: "KOSPI",
  currentPrice: 10000,
  fluctuations: "0",
  fluctuationsRatio: String(rate),
  accumulatedTradingVolume: vol,
  accumulatedTradingValue: vol * 10_000,
  marketValue: 1e12,
});
/** 한국 순위 원본: 쪽마다 50줄, 3쪽까지. reset 이면 모든 줄이 0%·거래량 0 */
function krSource() {
  const calls: string[] = [];
  const w = { reset: false, base: 5, slowMs: 0, calls };
  const fetchFn = (async (url: string) => {
    if (url.includes("/marketStatus")) return json({}, 404); // 장 상태는 달력(가짜)으로
    calls.push(url);
    if (w.slowMs) await new Promise((r) => setTimeout(r, w.slowMs));
    const index = Number(new URL(url).searchParams.get("index") ?? 0);
    const items = Array.from({ length: 50 }, (_, i) => {
      const n = index * 50 + i;
      return w.reset ? krRow(String(n).padStart(6, "0"), 0, 0) : krRow(String(n).padStart(6, "0"), w.base - n * 0.01, 1_000_000 - n);
    });
    return ok({ items, hasNext: index < 2 });
  }) as unknown as typeof fetch;
  return { w, fetchFn };
}

describe("발견 탭 장 상태 (정규장·시간외·장 시작 전·마감)", () => {
  it("한국: 달력이 열려 있는 08:00~20:00 동안 갱신하고, 15:30 뒤는 시간외 · 휴장일 기준 시각은 달력의 실제 마지막 거래 마감", async () => {
    const { fetchFn } = krSource();
    let now = new Date("2026-09-23T08:00:00Z"); // 수 17:00 (시간외)
    let kr = state("KR", true);
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: { status: async () => ({ now: "", KR: kr, US: state("US", false) }) } as unknown as MarketCalendar, now: () => now });
    const ext = await svc.rank("KR", "tradingValue", 1, 50);
    expect(ext).toMatchObject({ session: "extended", marketOpen: true, asOf: "2026-09-23T17:00:00+09:00" });
    expect(ext.note).not.toContain("KRX");
    // 추석(9/24) 10:00: 휴장 — 달력의 마지막 세션 종료(9/23 20:00)가 기준 시각
    now = new Date("2026-09-24T01:00:00Z");
    kr = state("KR", false, "2026-09-23T11:00:00.000Z");
    const closed = await svc.rank("KR", "tradingValue", 1, 50);
    expect(closed).toMatchObject({ session: "closed", marketOpen: false, asOf: "2026-09-23T20:00:00+09:00" });
    const themes = await new DiscoverService({ naver: new NaverDiscover((async () => ok({ sectors: [{ code: "1", name: "반도체", changeRate: 1.2, topItems: [] }], hasNext: false })) as unknown as typeof fetch), calendar: calendarOf(kr), now: () => now }).themes("KR", "theme", "day");
    expect(themes).toMatchObject({ session: "closed", asOf: "2026-09-23T20:00:00+09:00" });
    expect(themes.basis).not.toContain("KRX");
    // 정규장·장 시작 전
    now = new Date("2026-09-28T01:00:00Z");
    kr = state("KR", true);
    expect((await svc.rank("KR", "volume", 1, 50)).session).toBe("regular");
    now = new Date("2026-09-27T23:30:00Z"); // 월 08:30
    expect((await svc.rank("KR", "losers", 1, 50)).session).toBe("pre");
  });

  it("달력이 멈추면 오래 기다리지 않고 요일·시각 추정으로 대신한다", async () => {
    const { fetchFn } = krSource();
    const calendar = { status: () => new Promise(() => undefined) } as unknown as MarketCalendar;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar, now: () => new Date("2026-09-23T01:00:00Z") });
    const t0 = Date.now();
    const r = await svc.rank("KR", "tradingValue", 1, 50);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(r).toMatchObject({ session: "regular", marketOpen: true });
  }, 10_000);

  it("한국 장중에 출처가 비면 직전 목록을 유지하되 기준 시각은 그 목록의 시각, 더 보기로 오늘 0% 줄이 섞이지 않는다", async () => {
    const { w, fetchFn } = krSource();
    let now = new Date("2026-09-22T06:00:00Z"); // 화 15:00
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", true)), now: () => now });
    expect((await svc.rank("KR", "tradingValue", 1, 50)).items).toHaveLength(50);
    w.reset = true;
    now = new Date("2026-09-23T00:01:00Z"); // 수 09:01 — 출처가 아직 0% 목록
    const p1 = await svc.rank("KR", "tradingValue", 1, 50);
    expect(p1.items[0]!.changeRate).toBe(5);
    expect(p1).toMatchObject({ session: "regular", asOf: "2026-09-22T15:00:00+09:00" });
    expect(p1.note).toContain("직전 목록");
    const p3 = await svc.rank("KR", "tradingValue", 3, 50);
    const p4 = await svc.rank("KR", "tradingValue", 4, 50);
    expect([...p3.items, ...p4.items].every((i) => i.changeRate !== 0)).toBe(true);
    expect(p4).toMatchObject({ items: [], hasMore: false });
    // 출처가 돌아오면 새 목록
    w.reset = false;
    w.base = 7;
    now = new Date("2026-09-23T00:02:00Z");
    const back = await svc.rank("KR", "tradingValue", 1, 50);
    expect(back.items[0]!.changeRate).toBe(7);
    expect(back.note).not.toContain("직전 목록");
    expect(back.asOf).toBe("2026-09-23T09:02:00+09:00");
  });

  it("뒤 쪽 요청은 첫 쪽이 받은 목록을 이어 준다 (TTL 3배까지), 첫 쪽 요청만 새로 받는다", async () => {
    const { w, fetchFn } = krSource();
    const t0 = Date.parse("2026-09-24T01:00:00Z");
    let now = new Date(t0);
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", false, "2026-09-23T11:00:00.000Z")), now: () => now });
    const firstPage = () => w.calls.filter((c) => /[?&]index=0(&|$)/.test(c)).length;
    await svc.rank("KR", "volume", 1, 50);
    expect(firstPage()).toBe(1);
    now = new Date(t0 + 6 * 60_000); // 닫힘 TTL 5분 지남
    await svc.rank("KR", "volume", 2, 50);
    expect(firstPage()).toBe(1); // 뒤 쪽은 새로 받지 않는다
    await svc.rank("KR", "volume", 1, 50);
    expect(firstPage()).toBe(2); // 첫 쪽은 새로 받는다
    now = new Date(t0 + 6 * 60_000 + 16 * 60_000); // 15분(3배)도 지남
    await svc.rank("KR", "volume", 2, 50);
    expect(firstPage()).toBe(3);
  });

  it("순위: 직전 목록이 있으면 느린 새 조회를 오래 기다리지 않는다 (새 목록은 뒤에서 채움)", async () => {
    const { w, fetchFn } = krSource();
    let now = new Date("2026-09-23T01:00:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", true)), now: () => now, staleWaitMs: 20 });
    expect((await svc.rank("KR", "gainers", 1, 50)).items[0]!.changeRate).toBe(5);
    w.slowMs = 150;
    w.base = 9;
    now = new Date("2026-09-23T01:01:00Z");
    const t0 = Date.now();
    const stale = await svc.rank("KR", "gainers", 1, 50);
    expect(Date.now() - t0).toBeLessThan(120);
    expect(stale.items[0]!.changeRate).toBe(5);
    await new Promise((r) => setTimeout(r, 250));
    expect((await svc.rank("KR", "gainers", 1, 50)).items[0]!.changeRate).toBe(9);
  });

  it("저장본은 값이 바뀔 때만 meta 표에 쓴다 (장 밖에 같은 값을 5분마다 다시 쓰지 않게)", async () => {
    const { w, fetchFn } = krSource();
    const { store, writes } = memStore();
    const t0 = Date.parse("2026-09-24T01:00:00Z");
    let now = new Date(t0);
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", false, "2026-09-23T11:00:00.000Z")), store, now: () => now });
    const rankWrites = () => writes.filter((k) => k === "discover:snap:rank:KR:tradingValue").length;
    await svc.rank("KR", "tradingValue", 1, 50);
    await new Promise((r) => setTimeout(r, 0));
    expect(rankWrites()).toBe(1);
    for (let i = 1; i <= 3; i++) {
      now = new Date(t0 + i * 6 * 60_000);
      await svc.rank("KR", "tradingValue", 1, 50);
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(rankWrites()).toBe(1);
    w.base = 6; // 값이 바뀌면 (장 밖이라 바로) 쓴다
    now = new Date(t0 + 30 * 60_000);
    await svc.rank("KR", "tradingValue", 1, 50);
    await new Promise((r) => setTimeout(r, 0));
    expect(rankWrites()).toBe(2);
  });

  it("테마 목록이 거의 모두 0%(초기화)면 저장본을 쓰고, 한 줄만 달라도 초기화로 알아본다", async () => {
    let zero = false;
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ code: String(i), name: `테마${i}`, changeRate: zero ? (i === 0 ? 0.3 : 0) : 1 + i / 10, topItems: [] }));
    const fetchFn = (async () => ok({ sectors: list(20), hasNext: false })) as unknown as typeof fetch;
    const { store } = memStore();
    let now = new Date("2026-09-23T06:00:00Z");
    const mk = () => new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", true)), store, now: () => now });
    expect((await mk().themes("KR", "theme", "day")).themes[0]!.changeRate).toBe(1);
    zero = true;
    now = new Date("2026-09-23T23:30:00Z"); // 다음날 08:30, 재시작
    const r = await mk().themes("KR", "theme", "day");
    expect(r.themes[0]!.changeRate).toBe(1);
    expect(r.note).toContain("직전 값");
    expect(r.asOf).toBe("2026-09-23T15:00:00+09:00");
    expect(isMostlyZero([{ changeRate: 0 }, { changeRate: 0, volume: 0 }, { changeRate: 1 }])).toBe(false);
    expect(isMostlyZero(Array.from({ length: 10 }, (_, i) => ({ changeRate: i === 0 ? 0 : 0, volume: i === 0 ? 1200 : 0 })))).toBe(true);
  });

  it("미국 업종 상세: 장 밖 초기화 때만 0 인 종목만 저장본으로 덮고, 기준 시각은 저장본 시각", async () => {
    const usItem = (sym: string, rate: number, vol: number) => ({ symbolCode: sym, reutersCode: `${sym}.O`, name: sym, stockExchangeType: "NASDAQ", currentPrice: "10", fluctuations: "0", fluctuationsRatio: String(rate), accumulatedTradingVolume: String(vol), accumulatedTradingValue: String(vol * 10), marketValue: "1000" });
    const items = [usItem("S0", 10, 5000), ...Array.from({ length: 9 }, (_, i) => usItem(`S${i + 1}`, 0, 0))];
    const fetchFn = (async () => ok({ sectorCode: "57", sectorName: "IT", changeRate: 0, items, risingCount: 1, unChangedCount: 9, fallingCount: 0 })) as unknown as typeof fetch;
    const { store, m } = memStore();
    const savedAt = Date.parse("2026-09-22T20:00:00Z");
    const q = (sym: string, rate: number) => [`${sym}.O`, { code: sym, name: sym, market: "NASDAQ", currency: "USD", price: 11, change: 1, changeRate: rate, volume: 100, tradingValue: 1000, marketCap: 1000, tradedAt: null }];
    m.set("discover:snap:usq", JSON.stringify({ savedAt, value: [q("S0", -5), ...Array.from({ length: 9 }, (_, i) => q(`S${i + 1}`, 2))] }));
    const now = new Date("2026-09-23T07:45:00Z"); // 뉴욕 03:45 (초기화 구간)
    const closed = await new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", true), state("US", false, "2026-09-22T20:00:00.000Z")), store, now: () => now }).theme("US", "sector", "57");
    const by = new Map(closed!.items.map((i) => [i.code, i.changeRate]));
    expect(by.get("S0")).toBe(10); // 오늘 체결된 종목은 그대로
    expect(by.get("S1")).toBe(2);
    expect(closed!.note).toContain("9/10종목");
    expect(closed!.asOf).toBe("2026-09-23T05:00:00+09:00");
    // 정규장 중에는 덮지 않는다 (개장 직후 체결 없는 종목이 많아도)
    const open = await new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", false), state("US", true)), store, now: () => new Date("2026-09-23T13:30:20Z") }).theme("US", "sector", "57");
    expect(open!.items.find((i) => i.code === "S1")!.changeRate).toBe(0);
    expect(open!.note).toBeNull();
  });

  it("미국 업종: 서버를 다시 켠 뒤 없는 코드(출처 500)면 업종 목록을 받아 보고 404, 목록에 있으면 오류", async () => {
    const fetchFn = (async (url: string) =>
      url.includes("/sector/item/list") ? json({}, 500) : ok({ sectors: [{ code: "57201010", name: "IT 서비스", changeRate: 1, topItems: [] }], hasNext: false })) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T07:00:00Z") });
    expect(await svc.theme("US", "sector", "99999999")).toBeNull();
    await expect(svc.theme("US", "sector", "57201010")).rejects.toThrow();
  });

  it("시간 초과는 다시 부르지 않고, 연결 끊김은 한 번 더 부른다", async () => {
    let calls = 0;
    const timeout = (async () => {
      calls++;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(new NaverDiscover(timeout).sectors("KR", "theme", "day")).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(new TossTics(timeout, 0).ranking("US", "1w")).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    const reset = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new NaverDiscover(reset).sectors("KR", "theme", "day")).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

/** 네이버 거래소 장 상태 응답 (front-api/marketStatus) */
const exRow = (status: string, type: string | null, openAt: string, closeAt: string, base = "2026-09-28") => ({
  tradeBaseAt: base,
  session: { marketStatusDetailType: status, marketSessionType: type, displayLabel: "", openAt, closeAt },
});
const marketStatus = (kr: ReturnType<typeof exRow>, us: ReturnType<typeof exRow>) =>
  ok({
    exchanges: [
      { exchange: "krx", statuses: [{ marketType: "KOSPI", stockType: "stock", today: { isTradingDay: true }, latest: kr, next: null }] },
      { exchange: "nasdaq", statuses: [{ today: { isTradingDay: true }, latest: us, next: null }] },
    ],
  });

describe("네이버 거래소 장 상태로 세션·기준 시각 (휴장일·특수일 반영)", () => {
  const usClosed = exRow("close", "afterMarket", "2026-09-25T20:00:00-04:00", "2026-09-28T04:00:00-04:00");
  function world() {
    const w = { kr: exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-28T08:00:00+09:00", "2026-09-23"), us: usClosed, statusCalls: 0 };
    const src = krSource();
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) {
        w.statusCalls++;
        return marketStatus(w.kr, w.us);
      }
      return src.fetchFn(url);
    }) as unknown as typeof fetch;
    return { w, src, fetchFn };
  }

  it("추석 연휴 뒤 개장 전(9/28 08:30): 연휴 중에 본 마지막 거래 마감(9/23 20:00)을 기준 시각으로 쓴다 — 휴장일(9/25)로 틀리지 않게", async () => {
    const { w, fetchFn } = world();
    const { store, m } = memStore();
    let now = new Date("2026-09-25T03:00:00Z"); // 추석 연휴 중 (금 12:00)
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    const holiday = await svc.rank("KR", "tradingValue", 1, 50);
    expect(holiday).toMatchObject({ session: "closed", marketOpen: false, asOf: "2026-09-23T20:00:00+09:00" });
    expect(m.get("discover:kr-last-close")).toBe("2026-09-23T11:00:00.000Z");
    // 월 08:30 개장 전 — 네이버는 이때 직전 마감을 알려 주지 않는다
    now = new Date("2026-09-27T23:30:00Z");
    w.kr = exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00");
    const pre = await svc.rank("KR", "tradingValue", 1, 50);
    expect(pre).toMatchObject({ session: "pre", marketOpen: true, asOf: "2026-09-23T20:00:00+09:00" });
    // 서버를 다시 켜도 meta 표에서 기억해 낸다
    const restarted = await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).rank("KR", "volume", 1, 50);
    expect(restarted.asOf).toBe("2026-09-23T20:00:00+09:00");
    // 기억도 없으면 틀린 날짜 대신 시각을 밝히지 않는다
    const blank = await new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now }).rank("KR", "gainers", 1, 50);
    expect(blank).toMatchObject({ session: "pre", asOf: null });
  });

  it("세션 경계(09:00·09:30 ET)에서 바로 새로 묻는다 · 수능일처럼 개장이 늦으면 출처 세션을 따른다", async () => {
    const { w, fetchFn } = world();
    // 수능일: 10:00 개장 — 09:30 에도 개장 전
    w.kr = exRow("preopen", null, "2026-11-19T08:00:00+09:00", "2026-11-19T10:00:00+09:00", "2026-11-19");
    let now = new Date("2026-11-19T00:30:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    expect((await svc.rank("KR", "tradingValue", 1, 50)).session).toBe("pre");
    const calls = w.statusCalls;
    now = new Date("2026-11-19T00:31:00Z");
    await svc.rank("KR", "tradingValue", 1, 50);
    expect(w.statusCalls).toBe(calls); // 경계 전에는 캐시
    w.kr = exRow("open", "regularMarket", "2026-11-19T10:00:00+09:00", "2026-11-19T16:30:00+09:00", "2026-11-19");
    now = new Date("2026-11-19T01:00:05Z"); // 10:00:05 — 경계를 지나면 바로 다시 묻는다
    expect((await svc.rank("KR", "tradingValue", 1, 50)).session).toBe("regular");
    expect(w.statusCalls).toBe(calls + 1);
  });

  it("미국: 네이버 정규장만 장중, 애프터마켓이면 그 시작(조기 폐장일 13:00)을 정규장 마감으로", async () => {
    const { w, fetchFn } = world();
    const sectors = (async (url: string) => (url.includes("/marketStatus") ? fetchFn(url) : ok({ sectors: [{ code: "1", name: "IT", changeRate: 1, topItems: [] }], hasNext: false }))) as unknown as typeof fetch;
    w.us = exRow("open", "regularMarket", "2026-11-27T09:30:00-05:00", "2026-11-27T13:00:00-05:00", "2026-11-27");
    let now = new Date("2026-11-27T15:00:00Z"); // 10:00 ET
    expect(await new DiscoverService({ naver: new NaverDiscover(sectors), now: () => now }).themes("US", "sector", "day")).toMatchObject({ session: "regular", marketOpen: true });
    w.us = exRow("open", "afterMarket", "2026-11-27T13:00:00-05:00", "2026-11-27T17:00:00-05:00", "2026-11-27");
    now = new Date("2026-11-27T19:00:00Z"); // 14:00 ET (조기 폐장 뒤)
    const after = await new DiscoverService({ naver: new NaverDiscover(sectors), now: () => now }).themes("US", "sector", "day");
    expect(after).toMatchObject({ session: "closed", asOf: "2026-11-28T03:00:00+09:00" }); // 13:00 ET
  });

  it("장 상태를 못 받으면 토스 달력으로 대신한다", async () => {
    const { src } = world();
    const fetchFn = (async (url: string) => (url.includes("/marketStatus") ? json({}, 500) : src.fetchFn(url))) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", false, "2026-09-23T11:00:00.000Z")), now: () => new Date("2026-09-24T01:00:00Z") });
    expect(await svc.rank("KR", "volume", 1, 50)).toMatchObject({ session: "closed", asOf: "2026-09-23T20:00:00+09:00" });
  });

  it("마감 뒤에 받은 목록은 마지막 거래 마감 시점 값 — 다음 날 장중 출처가 비어 그 목록을 보여 줘도 기준 시각이 맞다", async () => {
    const { w, src, fetchFn } = world();
    let now = new Date("2026-09-23T12:30:00Z"); // 수 21:30 (마감 뒤)
    w.kr = exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-24T08:00:00+09:00", "2026-09-23");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    await svc.rank("KR", "tradingValue", 1, 50);
    src.w.reset = true;
    now = new Date("2026-09-28T00:00:30Z"); // 월 09:00:30 정규장 — 출처가 아직 0%
    w.kr = exRow("open", "regularMarket", "2026-09-28T09:00:00+09:00", "2026-09-28T15:30:00+09:00");
    const r = await svc.rank("KR", "tradingValue", 1, 50);
    expect(r).toMatchObject({ session: "regular", asOf: "2026-09-23T20:00:00+09:00" });
    expect(r.note).toContain("직전 목록");
  });

  it("첫 쪽을 옛 목록으로 받은 뒤 새 목록이 들어와도, 뒤 쪽은 같은 판(ver)에서 이어 준다", async () => {
    const { w, src, fetchFn } = world();
    w.kr = exRow("open", "regularMarket", "2026-09-23T09:00:00+09:00", "2026-09-23T15:30:00+09:00", "2026-09-23");
    let now = new Date("2026-09-23T01:00:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now, staleWaitMs: 10 });
    const first = await svc.rank("KR", "tradingValue", 1, 50);
    src.w.slowMs = 80;
    src.w.base = 9; // 새 목록은 등락률이 다르다
    now = new Date("2026-09-23T01:01:00Z");
    const p1 = await svc.rank("KR", "tradingValue", 1, 50); // 새 조회가 느려 옛 목록
    expect(p1.ver).toBe(first.ver);
    await new Promise((r) => setTimeout(r, 400)); // 새 목록 도착
    const p2 = await svc.rank("KR", "tradingValue", 2, 50, p1.ver);
    expect(p2.ver).toBe(p1.ver);
    expect(p2.items[0]!.changeRate).toBe(first.items[0]!.changeRate - 0.5); // 옛 목록의 51번째
    const fresh = await svc.rank("KR", "tradingValue", 2, 50); // 판 없이 부르면 새 목록
    expect(fresh.ver).not.toBe(p1.ver);
  });
});

describe("장 상태 출처가 모두 막힐 때", () => {
  it("네이버 장 상태를 새로 못 받아도, 마지막으로 받은 '마감' 세션이 지금을 덮고 있으면 그대로 쓴다 (휴장일을 장중으로 추정하지 않게)", async () => {
    const src = krSource();
    let fail = false;
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) {
        if (fail) return json({}, 503);
        return marketStatus(exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-28T08:00:00+09:00", "2026-09-23"), exRow("close", "afterMarket", "2026-09-23T20:00:00-04:00", "2026-09-24T04:00:00-04:00", "2026-09-23"));
      }
      return src.fetchFn(url);
    }) as unknown as typeof fetch;
    let now = new Date("2026-09-24T01:00:00Z"); // 추석 10:00
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: { status: () => new Promise(() => undefined) } as unknown as MarketCalendar, now: () => now });
    expect((await svc.rank("KR", "volume", 1, 50)).session).toBe("closed");
    fail = true;
    now = new Date("2026-09-24T02:00:00Z"); // 한 시간 뒤 — 네이버 503, 토스 달력도 멈춤
    const t0 = Date.now();
    const r = await svc.rank("KR", "volume", 1, 50);
    expect(r).toMatchObject({ session: "closed", marketOpen: false, asOf: "2026-09-23T20:00:00+09:00" });
    expect(Date.now() - t0).toBeLessThan(1_000); // 마지막 값이 있으면 달력을 기다리지 않는다
  });
});
