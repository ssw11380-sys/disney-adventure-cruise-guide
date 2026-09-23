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
    expect(ext.note).toContain("KRX 시세"); // 순위 값은 KRX 시세 (NXT 통합 아님)
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

/** 네이버 거래소 장 상태 응답 (front-api/marketStatus) — 실측 모양 */
const exRow = (status: string, type: string | null, openAt: string, closeAt: string, base = "2026-09-28") => ({
  tradeBaseAt: base,
  session: { marketStatusDetailType: status, marketSessionType: type, displayLabel: "", openAt, closeAt },
});
type Row = ReturnType<typeof exRow>;
type Ex = { latest: Row; next?: Row | null; trading?: boolean };
const marketStatus = (kr: Ex, us: Ex) =>
  ok({
    exchanges: [
      { exchange: "krx", statuses: [{ marketType: "KOSPI", stockType: "stock", today: { isTradingDay: kr.trading ?? true }, latest: kr.latest, next: kr.next ?? null }] },
      { exchange: "nasdaq", statuses: [{ today: { isTradingDay: us.trading ?? true }, latest: us.latest, next: us.next ?? null }] },
    ],
  });
/** 추석 연휴(9/24~25 휴장, 주말 뒤 9/28 개장) 동안 네이버가 주는 모양: 마감 세션의 closeAt 은 다음 달력 날 08:00(이미 지남), 다음 개장은 next */
const chuseokKr = (trading = false): Ex => ({
  latest: exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-24T08:00:00+09:00", "2026-09-23"),
  next: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00"),
  trading,
});
const usClosed: Ex = { latest: exRow("close", "afterMarket", "2026-09-25T20:00:00-04:00", "2026-09-26T04:00:00-04:00", "2026-09-25"), next: exRow("open", "preMarket", "2026-09-28T04:00:00-04:00", "2026-09-28T09:30:00-04:00"), trading: false };

describe("네이버 거래소 장 상태로 세션·기준 시각 (휴장일·특수일 반영)", () => {
  function world() {
    const w = { kr: chuseokKr(), us: usClosed, statusCalls: 0, hang: false };
    const src = krSource();
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) {
        w.statusCalls++;
        if (w.hang) return new Promise(() => undefined);
        return marketStatus(w.kr, w.us);
      }
      return src.fetchFn(url);
    }) as unknown as typeof fetch;
    return { w, src, fetchFn };
  }

  it("추석 연휴: 마감 세션 끝(9/24 08:00)이 지나도 다음 개장(9/28) 전까지 마감 · 연휴 뒤 개장 전(9/28 08:30)은 9/23 20:00 기준", async () => {
    const { w, fetchFn } = world();
    const { store, m } = memStore();
    let now = new Date("2026-09-25T03:00:00Z"); // 추석 연휴 중 (금 12:00) — closeAt 9/24 08:00 은 이미 지남
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: { status: () => new Promise(() => undefined) } as unknown as MarketCalendar, store, now: () => now });
    const t0 = Date.now();
    const holiday = await svc.rank("KR", "tradingValue", 1, 50);
    expect(Date.now() - t0).toBeLessThan(1_000); // 달력(멈춤)을 기다리지 않는다
    expect(holiday).toMatchObject({ session: "closed", marketOpen: false, asOf: "2026-09-23T20:00:00+09:00" });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(m.get("discover:kr-last-trade")!)).toMatchObject({ day: "2026-09-23", close: "2026-09-23T11:00:00.000Z", exact: true, nextOpen: "2026-09-27T23:00:00.000Z" });
    // 월 08:30 개장 전 — 네이버는 이때 직전 마감을 알려 주지 않는다
    now = new Date("2026-09-27T23:30:00Z");
    w.kr = { latest: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00"), next: exRow("open", "regularMarket", "2026-09-28T09:00:00+09:00", "2026-09-28T15:30:00+09:00") };
    const pre = await svc.rank("KR", "tradingValue", 1, 50);
    expect(pre).toMatchObject({ session: "pre", marketOpen: true, asOf: "2026-09-23T20:00:00+09:00" });
    // 서버를 다시 켜도 meta 표에서 기억해 낸다
    const restarted = await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).rank("KR", "volume", 1, 50);
    expect(restarted.asOf).toBe("2026-09-23T20:00:00+09:00");
    // 기억도 없으면 틀린 날짜 대신 시각을 밝히지 않는다
    const blank = await new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now }).rank("KR", "gainers", 1, 50);
    expect(blank).toMatchObject({ session: "pre", asOf: null });
  });

  it("아침에만 앱을 여는 경우: 장중·시간외에 본 거래일로 다음 날 개장 전 기준 시각을 맞춘다 (옛 마감 기억을 쓰지 않는다)", async () => {
    const { w, fetchFn } = world();
    const { store, m } = memStore();
    let now = new Date("2026-09-22T12:00:00Z"); // 화 21:00 — 화 20:00 마감을 본다
    w.kr = { latest: exRow("close", "afterMarket", "2026-09-22T20:00:00+09:00", "2026-09-23T08:00:00+09:00", "2026-09-22"), next: exRow("preopen", null, "2026-09-23T08:00:00+09:00", "2026-09-23T09:00:00+09:00", "2026-09-23") };
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    await svc.rank("KR", "volume", 1, 50);
    now = new Date("2026-09-23T01:00:00Z"); // 수 10:00 정규장
    w.kr = { latest: exRow("open", "regularMarket", "2026-09-23T09:00:00+09:00", "2026-09-23T15:30:00+09:00", "2026-09-23"), next: exRow("close", "regularMarket", "2026-09-23T15:30:00+09:00", "2026-09-23T16:00:00+09:00", "2026-09-23") };
    await svc.rank("KR", "volume", 1, 50);
    now = new Date("2026-09-23T09:40:00Z"); // 수 18:40 애프터마켓 — 그 뒤로는 요청 없음
    w.kr = { latest: exRow("open", "afterMarket", "2026-09-23T16:00:00+09:00", "2026-09-23T20:00:00+09:00", "2026-09-23"), next: exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-24T08:00:00+09:00", "2026-09-23") };
    await svc.rank("KR", "volume", 1, 50);
    const preopen928 = { latest: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00"), next: exRow("open", "regularMarket", "2026-09-28T09:00:00+09:00", "2026-09-28T15:30:00+09:00") };
    // 연휴 동안 아무 요청이 없으면: 9/23 과 9/28 사이 평일(9/24·25)이 휴장인지 확인할 수 없어 시각을 적지 않는다 (지금 기억을 복사한 다른 서버로)
    await new Promise((r) => setTimeout(r, 0));
    const copy = new Map(m);
    const later = new Date("2026-09-27T23:30:00Z");
    w.kr = preopen928;
    const quiet = new DiscoverService({ naver: new NaverDiscover(fetchFn), store: { get: async (k: string) => copy.get(k) ?? null, set: async (k: string, v: string) => void copy.set(k, v) }, now: () => later });
    expect((await quiet.rank("KR", "volume", 1, 50)).asOf).toBeNull();
    // 운영에서는 매일 뉴욕 15:50 저장 크론(한국 새벽 04:50)이 장 상태를 받아 한국 마감·다음 개장을 배운다 — 미국 요청으로 흉내
    now = new Date("2026-09-24T19:50:00Z"); // 9/25 04:50 KST (뉴욕 9/24 15:50)
    w.kr = chuseokKr();
    w.us = { latest: exRow("open", "regularMarket", "2026-09-24T09:30:00-04:00", "2026-09-24T16:00:00-04:00", "2026-09-24") };
    await svc.themes("US", "sector", "day").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    now = new Date("2026-09-27T23:30:00Z");
    w.kr = preopen928;
    expect((await svc.rank("KR", "tradingValue", 1, 50)).asOf).toBe("2026-09-23T20:00:00+09:00"); // 기억한 다음 개장 = 오늘 개장 → 확인됨
    const themes = await new DiscoverService({ naver: new NaverDiscover((async (url: string) => (url.includes("/marketStatus") ? fetchFn(url) : ok({ sectors: [{ code: "1", name: "반도체", changeRate: 1.2, topItems: [] }], hasNext: false }))) as unknown as typeof fetch), store, now: () => now }).themes("KR", "theme", "day");
    expect(themes.asOf).toBe("2026-09-23T20:00:00+09:00"); // 재시작한 서버도 meta 표로
  });

  it("개장 전에만 여는 날이 이어져도 한국 새벽의 장 상태로 기억이 앞으로 간다 · 동시 요청도 같은 기억을 읽는다", async () => {
    const { w, fetchFn } = world();
    const { store } = memStore();
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    let now = new Date("2026-09-29T19:50:00Z"); // 9/30 04:50 KST — 한국은 9/29 20:00 마감, 다음 개장 9/30 08:00
    w.kr = { latest: exRow("close", "afterMarket", "2026-09-29T20:00:00+09:00", "2026-09-30T08:00:00+09:00", "2026-09-29"), next: exRow("preopen", null, "2026-09-30T08:00:00+09:00", "2026-09-30T09:00:00+09:00", "2026-09-30") };
    w.us = { latest: exRow("open", "regularMarket", "2026-09-29T09:30:00-04:00", "2026-09-29T16:00:00-04:00", "2026-09-29") };
    await svc.themes("US", "sector", "day").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    now = new Date("2026-09-29T23:30:00Z"); // 9/30 08:30 개장 전
    w.kr = { latest: exRow("preopen", null, "2026-09-30T08:00:00+09:00", "2026-09-30T09:00:00+09:00", "2026-09-30") };
    // 재시작한 서버에서 순위·테마를 한꺼번에 불러도 모두 같은 기억을 읽는다
    const fresh = new DiscoverService({ naver: new NaverDiscover((async (url: string) => (url.includes("/sectors/all") ? ok({ sectors: [{ code: "1", name: "반도체", changeRate: 1.2, topItems: [] }], hasNext: false }) : fetchFn(url))) as unknown as typeof fetch), store, now: () => now });
    const [r, th] = await Promise.all([fresh.rank("KR", "volume", 1, 50), fresh.themes("KR", "theme", "day")]);
    expect(r.asOf).toBe("2026-09-29T20:00:00+09:00");
    expect(th.asOf).toBe("2026-09-29T20:00:00+09:00");
  });

  it("휴장일에 두 출처가 모두 실패해 요일로 추정한 '정규장'은 거래일로 기억하지 않는다", async () => {
    const { w, fetchFn } = world();
    const { store, m } = memStore();
    let now = new Date("2026-09-24T19:50:00Z"); // 9/25 04:50 KST — 네이버가 9/23 마감·9/28 개장을 알려 준다
    w.us = { latest: exRow("open", "regularMarket", "2026-09-24T09:30:00-04:00", "2026-09-24T16:00:00-04:00", "2026-09-24") };
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    await svc.themes("US", "sector", "day").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const before = m.get("discover:kr-last-trade");
    // 9/25 14:30 재시작 — 네이버 503, 토스 500 → 요일 추정(평일 낮 = 열림)
    now = new Date("2026-09-25T05:30:00Z");
    const down = (async (url: string) => (url.includes("/marketStatus") ? json({}, 503) : fetchFn(url))) as unknown as typeof fetch;
    const { MarketCalendar } = await import("../src/providers/market/calendar.js");
    const broken = new DiscoverService({ naver: new NaverDiscover(down), calendar: new MarketCalendar((async () => json({}, 500)) as unknown as typeof fetch, () => now), store, now: () => now });
    // 두 출처가 모두 멈춰도, 기억한 마감(9/23 20:00)과 다음 개장(9/28) 사이라 요일 추정 대신 마감으로 본다
    expect(await broken.rank("KR", "volume", 1, 50)).toMatchObject({ session: "closed", asOf: "2026-09-23T20:00:00+09:00" });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.get("discover:kr-last-trade")).toBe(before); // 하지만 기억은 그대로
    now = new Date("2026-09-27T23:30:00Z");
    w.kr = { latest: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00") };
    expect((await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).rank("KR", "gainers", 1, 50)).asOf).toBe("2026-09-23T20:00:00+09:00");
  });

  it("15:30~16:00 틈(정규장 마감 뒤 애프터마켓 전)은 시간외로 보고, 15:30 을 마감으로 기억하지 않는다", async () => {
    const { w, fetchFn } = world();
    const { store, m } = memStore();
    w.kr = { latest: exRow("close", "regularMarket", "2026-09-23T15:30:00+09:00", "2026-09-23T16:00:00+09:00", "2026-09-23"), next: exRow("open", "afterMarket", "2026-09-23T16:00:00+09:00", "2026-09-23T20:00:00+09:00", "2026-09-23") };
    const now = new Date("2026-09-23T06:45:00Z"); // 15:45
    const r = await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).rank("KR", "tradingValue", 1, 50);
    expect(r).toMatchObject({ session: "extended", marketOpen: true, asOf: "2026-09-23T15:45:00+09:00" });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(m.get("discover:kr-last-trade")!)).toMatchObject({ day: "2026-09-23", close: "2026-09-23T11:00:00.000Z", exact: false });
  });

  it("세션 경계(09:00·09:30 ET)에서 바로 새로 묻는다 · 수능일처럼 개장이 늦으면 출처 세션을 따른다", async () => {
    const { w, fetchFn } = world();
    // 수능일: 10:00 개장 — 09:30 에도 개장 전
    w.kr = { latest: exRow("preopen", null, "2026-11-19T08:00:00+09:00", "2026-11-19T10:00:00+09:00", "2026-11-19"), next: exRow("open", "regularMarket", "2026-11-19T10:00:00+09:00", "2026-11-19T16:30:00+09:00", "2026-11-19") };
    let now = new Date("2026-11-19T00:30:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    expect((await svc.rank("KR", "tradingValue", 1, 50)).session).toBe("pre");
    const calls = w.statusCalls;
    now = new Date("2026-11-19T00:31:00Z");
    await svc.rank("KR", "tradingValue", 1, 50);
    expect(w.statusCalls).toBe(calls); // 경계 전에는 캐시
    w.kr = { latest: exRow("open", "regularMarket", "2026-11-19T10:00:00+09:00", "2026-11-19T16:30:00+09:00", "2026-11-19") };
    now = new Date("2026-11-19T01:00:05Z"); // 10:00:05 — 경계를 지나면 바로 다시 묻는다
    expect((await svc.rank("KR", "tradingValue", 1, 50)).session).toBe("regular");
    expect(w.statusCalls).toBe(calls + 1);
    now = new Date("2026-11-19T07:15:00Z"); // 16:15 — 이날은 16:30 까지 정규장
    expect((await svc.rank("KR", "tradingValue", 1, 50)).session).toBe("regular");
  });

  it("미국: 네이버 정규장만 장중, 조기 폐장일(13:00)은 애프터마켓 뒤·주말까지 13:00 을 정규장 마감으로", async () => {
    const { w, fetchFn } = world();
    const sectors = (async (url: string) => (url.includes("/marketStatus") ? fetchFn(url) : ok({ sectors: [{ code: "1", name: "IT", changeRate: 1, topItems: [] }], hasNext: false }))) as unknown as typeof fetch;
    w.us = { latest: exRow("open", "regularMarket", "2026-11-27T09:30:00-05:00", "2026-11-27T13:00:00-05:00", "2026-11-27") };
    let now = new Date("2026-11-27T15:00:00Z"); // 10:00 ET
    const svc = new DiscoverService({ naver: new NaverDiscover(sectors), calendar: calendarOf(state("KR", false), state("US", false, "2026-11-27T22:00:00.000Z")), now: () => now });
    expect(await svc.themes("US", "sector", "day")).toMatchObject({ session: "regular", marketOpen: true });
    w.us = { latest: exRow("open", "afterMarket", "2026-11-27T13:00:00-05:00", "2026-11-27T17:00:00-05:00", "2026-11-27") };
    now = new Date("2026-11-27T19:00:00Z"); // 14:00 ET (조기 폐장 뒤)
    expect(await svc.themes("US", "sector", "week")).toMatchObject({ session: "closed", asOf: "2026-11-28T03:00:00+09:00" }); // 13:00 ET
    w.us = { latest: exRow("close", "afterMarket", "2026-11-27T17:00:00-05:00", "2026-11-28T04:00:00-05:00", "2026-11-27"), next: exRow("open", "preMarket", "2026-11-30T04:00:00-05:00", "2026-11-30T09:30:00-05:00"), trading: false };
    now = new Date("2026-11-28T15:00:00Z"); // 토요일 — 달력은 17:00 ET 를 주지만 기억한 13:00 이 맞다
    expect(await svc.themes("US", "sector", "month")).toMatchObject({ session: "closed", asOf: "2026-11-28T03:00:00+09:00" });
  });

  it("장 상태를 못 받으면 토스 달력으로 대신한다 · 둘 다 멈춰도 2.5초 한 번만 기다린다", async () => {
    const { w, src } = world();
    const fetchFn = (async (url: string) => (url.includes("/marketStatus") ? json({}, 500) : src.fetchFn(url))) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", false, "2026-09-23T11:00:00.000Z")), now: () => new Date("2026-09-24T01:00:00Z") });
    expect(await svc.rank("KR", "volume", 1, 50)).toMatchObject({ session: "closed", asOf: "2026-09-23T20:00:00+09:00" });
    void w;
    // 네이버 장 상태와 토스 달력이 모두 멈춘 경우: 둘을 함께 기다려 2.5초 한 번, 그다음 요일·시각 추정
    const hw = world();
    hw.w.hang = true;
    const stuck = new DiscoverService({ naver: new NaverDiscover(hw.fetchFn), calendar: { status: () => new Promise(() => undefined) } as unknown as MarketCalendar, now: () => new Date("2026-09-23T01:00:00Z") });
    const t0 = Date.now();
    const r = await stuck.rank("KR", "volume", 1, 50);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThan(2_000);
    expect(took).toBeLessThan(3_500);
    expect(r.session).toBe("regular"); // 수 10:00 추정
  }, 15_000);

  it("마감 뒤에 받은 목록은 마지막 거래 마감 시점 값 — 다음 날 장중 출처가 비어 그 목록을 보여 줘도 기준 시각이 맞다", async () => {
    const { w, src, fetchFn } = world();
    let now = new Date("2026-09-23T12:30:00Z"); // 수 21:30 (마감 뒤)
    w.kr = { latest: exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-24T08:00:00+09:00", "2026-09-23"), next: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00") };
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    await svc.rank("KR", "tradingValue", 1, 50);
    src.w.reset = true;
    now = new Date("2026-09-28T00:00:30Z"); // 월 09:00:30 정규장 — 출처가 아직 0%
    w.kr = { latest: exRow("open", "regularMarket", "2026-09-28T09:00:00+09:00", "2026-09-28T15:30:00+09:00") };
    const r = await svc.rank("KR", "tradingValue", 1, 50);
    expect(r).toMatchObject({ session: "regular", asOf: "2026-09-23T20:00:00+09:00" });
    expect(r.note).toContain("직전 목록");
  });

  it("첫 쪽을 옛 목록으로 받은 뒤 새 목록이 들어와도, 뒤 쪽은 같은 판(ver)에서 이어 준다", async () => {
    const { w, src, fetchFn } = world();
    w.kr = { latest: exRow("open", "regularMarket", "2026-09-23T09:00:00+09:00", "2026-09-23T15:30:00+09:00", "2026-09-23") };
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
  it("네이버 장 상태를 새로 못 받아도, 마지막으로 받은 '마감' 세션이 지금을 덮고 있으면 기다리지 않고 그대로 쓴다", async () => {
    const src = krSource();
    let mode: "ok" | "fail" | "hang" = "ok";
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) {
        if (mode === "fail") return json({}, 503);
        if (mode === "hang") return new Promise(() => undefined);
        return marketStatus(chuseokKr(), usClosed);
      }
      return src.fetchFn(url);
    }) as unknown as typeof fetch;
    let now = new Date("2026-09-24T01:00:00Z"); // 추석 10:00
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: { status: () => new Promise(() => undefined) } as unknown as MarketCalendar, now: () => now });
    expect((await svc.rank("KR", "volume", 1, 50)).session).toBe("closed");
    for (const [m, at] of [["fail", "2026-09-24T02:00:00Z"], ["hang", "2026-09-25T02:00:00Z"]] as const) {
      mode = m;
      now = new Date(at);
      const t0 = Date.now();
      const r = await svc.rank("KR", "volume", 1, 50);
      expect(r).toMatchObject({ session: "closed", marketOpen: false, asOf: "2026-09-23T20:00:00+09:00" });
      expect(Date.now() - t0).toBeLessThan(1_000);
    }
  });
});

describe("장 상태 방어 (부분 응답·깨진 값·재시작)", () => {
  const sectors = () => ok({ sectors: [{ code: "1", name: "IT", changeRate: 1, topItems: [] }], hasNext: false });

  it("한 시장만 온 응답이 다른 시장의 유효한 값을 지우지 않는다 · 끝 시각이 없는 세션은 5분만 믿는다", async () => {
    let body: unknown = null;
    let fail = false;
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) return fail ? json({}, 503) : ok(body);
      return sectors();
    }) as unknown as typeof fetch;
    const usHoliday = { exchange: "nasdaq", statuses: [{ today: { isTradingDay: false }, latest: exRow("close", "afterMarket", "2026-11-25T20:00:00-05:00", "2026-11-26T04:00:00-05:00", "2026-11-25"), next: exRow("open", "preMarket", "2026-11-27T04:00:00-05:00", "2026-11-27T09:30:00-05:00", "2026-11-27") }] };
    const kr = { exchange: "krx", statuses: [{ marketType: "KOSPI", stockType: "stock", today: { isTradingDay: true }, latest: exRow("close", "afterMarket", "2026-11-26T20:00:00+09:00", "2026-11-27T08:00:00+09:00", "2026-11-26"), next: null }] };
    body = { exchanges: [kr, usHoliday] };
    let now = new Date("2026-11-26T14:00:00Z"); // 추수감사절 09:00 ET
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: { status: () => new Promise(() => undefined) } as unknown as MarketCalendar, now: () => now });
    expect((await svc.themes("US", "sector", "day")).session).toBe("closed");
    body = { exchanges: [kr] }; // 미국 줄이 빠진 응답
    now = new Date("2026-11-26T15:11:00Z"); // 10:11 ET
    expect((await svc.themes("US", "sector", "week")).session).toBe("closed"); // 옛 미국 값(다음 개장 전)이 그대로 쓰인다
    // 끝 시각이 없는 정규장 줄: 받은 뒤 5분까지만
    body = { exchanges: [{ exchange: "nasdaq", statuses: [{ today: { isTradingDay: true }, latest: { tradeBaseAt: "2026-11-27", session: { marketStatusDetailType: "open", marketSessionType: "regularMarket", openAt: "2026-11-27T09:30:00-05:00", closeAt: "" } }, next: null }] }] };
    now = new Date("2026-11-27T16:00:00Z");
    const svc2 = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: calendarOf(state("KR", false), state("US", false, "2026-11-27T18:00:00.000Z")), now: () => now });
    expect((await svc2.themes("US", "sector", "day")).session).toBe("regular");
    fail = true;
    now = new Date("2026-11-28T16:00:00Z"); // 다음 날 — 네이버 실패
    expect((await svc2.themes("US", "sector", "month")).session).toBe("closed"); // 옛 '정규장'을 끝없이 믿지 않는다
  });

  it("미국 마감(20:00 ET~)은 네이버 거래일로 기준 시각을 정하고(토스 없이), 조기 폐장 13:00 기억은 재시작해도 남는다", async () => {
    let us: Ex = { latest: exRow("open", "afterMarket", "2026-11-27T13:00:00-05:00", "2026-11-27T17:00:00-05:00", "2026-11-27") };
    const fetchFn = (async (url: string) => (url.includes("/marketStatus") ? marketStatus(chuseokKr(true), us) : sectors())) as unknown as typeof fetch;
    const { store } = memStore();
    let now = new Date("2026-11-27T19:00:00Z"); // 14:00 ET 애프터마켓 — 13:00 을 배운다
    await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).themes("US", "sector", "day");
    await new Promise((r) => setTimeout(r, 0));
    // 토요일, 재시작한 서버 · 토스 달력 멈춤 · 네이버 마감 세션(거래일 11/27)
    us = { latest: exRow("close", "afterMarket", "2026-11-27T17:00:00-05:00", "2026-11-28T04:00:00-05:00", "2026-11-27"), next: exRow("open", "preMarket", "2026-11-30T04:00:00-05:00", "2026-11-30T09:30:00-05:00", "2026-11-30"), trading: false };
    now = new Date("2026-11-28T15:00:00Z");
    const stuck = { status: () => new Promise(() => undefined) } as unknown as MarketCalendar;
    const t0 = Date.now();
    const r = await new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: stuck, store, now: () => now }).themes("US", "sector", "week");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r).toMatchObject({ session: "closed", asOf: "2026-11-28T03:00:00+09:00" });
    // 기억이 없으면 그 거래일의 16:00
    const plain = await new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar: stuck, now: () => now }).themes("US", "sector", "month");
    expect(plain.asOf).toBe("2026-11-28T06:00:00+09:00");
  });
});

describe("운영 검증 뒤 4차 수정", () => {
  it("미국 우선주(5글자 티커 포함)·거래소 상장 채권은 빼고, 'Preferred Bank' 같은 회사명은 남긴다", async () => {
    const { isUsNonCommon } = await import("../src/providers/market/naverDiscover.js");
    expect(isUsNonCommon("Alphabet Inc 6.25% Series A", "GOOGM", "알파벳 우선주 6.25% Series A")).toBe(true);
    expect(isUsNonCommon("Strategy Inc 8.00% Series A Perpetual Strike Preferred Stock", "STRK", "스트래티지 우선주 Series A 8.00%")).toBe(true);
    expect(isUsNonCommon("B. Riley Financial Inc 5.25% Senior Notes due 2028", "RILYZ", "B. 라일리 선순위 채권 5.250% 만기 2028년")).toBe(true);
    expect(isUsNonCommon("Banco Bradesco SA Pref ADR", "BBD", "방쿠 브라데스쿠 우선주 ADR")).toBe(true);
    expect(isUsNonCommon("Preferred Bank", "PFBC", "프리퍼드 뱅크")).toBe(false);
    expect(isUsNonCommon("Preformed Line Products Co", "PLPC", "프리폼드 라인 프로덕츠")).toBe(false);
    expect(isUsNonCommon("Energy Transfer Units", "ET", "에너지 트랜스퍼")).toBe(false);
  });

  it("이어 받을 때 바로 앞 쪽을 겹쳐 받아, 그 사이 한 쪽 위로 올라온 종목을 놓치지 않는다", async () => {
    let calls = 0;
    // 3쪽(index 2)의 마지막 종목 X 가 두 번째 묶음을 받을 때 2쪽(index 1)의 끝으로 올라간다
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) return json({}, 404);
      calls++;
      const index = Number(new URL(url).searchParams.get("index") ?? 0);
      const moved = calls > 3;
      const codes = Array.from({ length: 50 }, (_, i) => String(index * 50 + i).padStart(6, "0"));
      if (index === 3 && !moved) codes[0] = "XXXXXX"; // 처음엔 4쪽 첫 줄
      if (index === 2 && moved) codes[49] = "XXXXXX"; // 나중엔 3쪽 끝 줄 (4쪽 첫 줄은 다른 종목)
      return ok({ items: codes.map((c, i) => krRow(c, 5 - (index * 50 + i) * 0.01, 1_000_000 - index * 50 - i)), hasNext: index < 5 });
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-24T01:00:00Z") });
    await svc.rank("KR", "volume", 1, 50); // index 0~2 (X 는 아직 index 3)
    const p4 = await svc.rank("KR", "volume", 4, 50); // index 2(겹침)~5 — X 는 이제 index 2 끝에 있다
    const all = [...(await svc.rank("KR", "volume", 1, 50)).items, ...(await svc.rank("KR", "volume", 2, 50)).items, ...(await svc.rank("KR", "volume", 3, 50)).items, ...p4.items];
    expect(all.map((i) => i.code)).toContain("XXXXXX");
  });

  it("장이 닫힌 직후에는 마감 전에 받은 목록·테마를 TTL 과 상관없이 새로 받아 마감 기준 시각으로 준다", async () => {
    const { w, fetchFn } = (() => {
      const w = { kr: { latest: exRow("open", "afterMarket", "2026-09-23T16:00:00+09:00", "2026-09-23T20:00:00+09:00", "2026-09-23"), next: exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-24T08:00:00+09:00", "2026-09-23") } as Ex };
      const src = krSource();
      const fetchFn = (async (url: string) => {
        if (url.includes("/marketStatus")) return marketStatus(w.kr, usClosed);
        if (url.includes("/sectors/all")) return ok({ sectors: [{ code: "1", name: "반도체", changeRate: 1.2, topItems: [] }], hasNext: false });
        return src.fetchFn(url);
      }) as unknown as typeof fetch;
      return { w, fetchFn };
    })();
    let now = new Date("2026-09-23T10:59:40Z"); // 19:59:40
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    expect((await svc.rank("KR", "tradingValue", 1, 50)).asOf).toBe("2026-09-23T19:59:40+09:00");
    expect((await svc.themes("KR", "theme", "day")).asOf).toBe("2026-09-23T19:59:40+09:00");
    now = new Date("2026-09-23T11:00:20Z"); // 20:00:20 — 마감 (닫힘 TTL 5분 안이지만)
    w.kr = { latest: exRow("close", "afterMarket", "2026-09-23T20:00:00+09:00", "2026-09-24T08:00:00+09:00", "2026-09-23"), next: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00") };
    expect(await svc.rank("KR", "tradingValue", 1, 50)).toMatchObject({ session: "closed", asOf: "2026-09-23T20:00:00+09:00" });
    expect((await svc.themes("KR", "theme", "day")).asOf).toBe("2026-09-23T20:00:00+09:00");
  });

  it("시간외에 본 값과 마감 뒤 값이 같으면 저장본의 기준 시각을 마감으로 올린다 (재시작 뒤 개장 전에도 20:00)", async () => {
    const { store } = memStore();
    let zero = false;
    let kr: Ex = { latest: exRow("open", "afterMarket", "2026-09-23T16:00:00+09:00", "2026-09-23T20:00:00+09:00", "2026-09-23") };
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) return marketStatus(kr, usClosed);
      return ok({ sectors: Array.from({ length: 10 }, (_, i) => ({ code: String(i), name: `테마${i}`, changeRate: zero ? 0 : 1 + i / 10, topItems: [] })), hasNext: false });
    }) as unknown as typeof fetch;
    let now = new Date("2026-09-23T09:05:00Z"); // 18:05 시간외
    await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).themes("KR", "theme", "week");
    now = new Date("2026-09-23T11:06:00Z"); // 20:06 마감 뒤 — 같은 값
    kr = chuseokKr(true);
    const after = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    await after.themes("KR", "theme", "week");
    await new Promise((r) => setTimeout(r, 0));
    // 9/28 08:30 개장 전, 재시작 · 출처 0%
    zero = true;
    now = new Date("2026-09-27T23:30:00Z");
    kr = { latest: exRow("preopen", null, "2026-09-28T08:00:00+09:00", "2026-09-28T09:00:00+09:00") };
    const r = await new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now }).themes("KR", "theme", "week");
    expect(r.themes[0]!.changeRate).toBe(1);
    expect(r.asOf).toBe("2026-09-23T20:00:00+09:00");
  });

  it("업종 상세: 상승·보합·하락 수는 목록과 같게(거래정지 제외), 300종목에서 잘리면 안내한다", async () => {
    const detailItems = (n: number, suspended = 0) =>
      Array.from({ length: n }, (_, i) => ({ ...krRow(String(i).padStart(6, "0"), i < suspended ? 0 : 1, i < suspended ? 0 : 1000), itemCode: String(i).padStart(6, "0") }));
    let items = detailItems(12, 3);
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) return marketStatus(chuseokKr(), usClosed);
      if (url.includes("/sectors/all")) return ok({ sectors: [{ code: "25", name: "기타", changeRate: 0.75, risingCount: 831, unchangedCount: 119, fallingCount: 587, topItems: [] }], hasNext: false });
      return ok({ sectorInfo: { sectorName: "기타", changeRate: 0.75 }, items, hasNext: false });
    }) as unknown as typeof fetch;
    const now = () => new Date("2026-09-24T01:00:00Z");
    // 목록을 받기 전: 구성 종목으로 세되 거래정지 3종목은 뺀다
    const fresh = await new DiscoverService({ naver: new NaverDiscover(fetchFn), now }).theme("KR", "sector", "25");
    expect(fresh!.theme).toMatchObject({ up: 9, flat: 0, down: 0 });
    // 300종목에서 잘리면: 목록의 수를 쓰고 안내
    items = detailItems(300);
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now });
    await svc.themes("KR", "sector", "day");
    const big = await svc.theme("KR", "sector", "25");
    expect(big!.theme).toMatchObject({ up: 831, flat: 119, down: 587 });
    expect(big!.note).toContain("등락률 상위 300종목만 보여 줍니다 (전체 1537종목)");
  });

  it("뒤 쪽 판(ver)은 최근 5판까지 이어 준다", async () => {
    const src = krSource();
    let now = new Date("2026-09-23T01:00:00Z");
    const fetchFn = (async (url: string) => (url.includes("/marketStatus") ? marketStatus({ latest: exRow("open", "regularMarket", "2026-09-23T09:00:00+09:00", "2026-09-23T15:30:00+09:00", "2026-09-23") }, usClosed) : src.fetchFn(url))) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    const first = await svc.rank("KR", "volume", 1, 50);
    for (let i = 1; i <= 3; i++) {
      src.w.base = 5 + i;
      now = new Date(Date.parse("2026-09-23T01:00:00Z") + i * 31_000);
      await svc.rank("KR", "volume", 1, 50); // 새 판
    }
    const p2 = await svc.rank("KR", "volume", 2, 50, first.ver);
    expect(p2.ver).toBe(first.ver);
    expect(p2.items[0]!.changeRate).toBe(4.5);
  });

  it("캐시는 모르는 테마 id 가 쌓여도 커지지 않는다", async () => {
    const fetchFn = (async (url: string) => (url.includes("/marketStatus") ? json({}, 404) : json({}, 404))) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-24T01:00:00Z") });
    for (let i = 0; i < 450; i++) await svc.theme("KR", "theme", `x${i}`);
    expect((svc as unknown as { cache: Map<string, unknown> }).cache.size).toBeLessThanOrEqual(400);
  });

  it("출처가 형식만 맞는 없는 날짜(2026-13-01)를 줘도 처리되지 않은 거부가 생기지 않는다", async () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", on);
    try {
      const fetchFn = (async (url: string) =>
        url.includes("/marketStatus")
          ? marketStatus({ latest: exRow("open", "regularMarket", "2026-09-23T09:00:00+09:00", "2026-09-23T15:30:00+09:00", "2026-13-01") }, usClosed)
          : ok({ sectors: [{ code: "1", name: "반도체", changeRate: 1.2, topItems: [] }], hasNext: false })) as unknown as typeof fetch;
      const r = await new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T01:00:00Z") }).themes("KR", "sector", "day");
      expect(r.session).toBe("regular");
      await new Promise((res) => setTimeout(res, 20));
      expect(seen).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});
