import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { MarketCalendar, MarketState } from "../src/providers/market/calendar.js";
import { NaverDiscover, type DiscoverStock, type ThemeSummary } from "../src/providers/market/naverDiscover.js";
import { discoverRoutes } from "../src/routes/discover.js";
import { DiscoverService, type DiscoverRank } from "../src/services/discoverService.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ isSuccess: true, result });
const state = (market: "KR" | "US", isOpen: boolean, lastClose: string | null = null): MarketState => ({ market, isOpen, isTradingDay: true, opensAt: null, closesAt: null, lastClose, source: "toss" });
const calendarOf = (kr: MarketState, us: MarketState) => ({ status: async () => ({ now: "", KR: kr, US: us }) }) as unknown as MarketCalendar;
const memStore = () => {
  const m = new Map<string, string>();
  return { m, store: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) } };
};

/** 화면의 종목 값으로 센 상승·보합·하락 수와 시가총액 가중 등락률 — 업종 요약이 보이는 종목과 맞는지 */
function fromItems(items: DiscoverStock[]) {
  const w = items.reduce((s, i) => s + (i.marketCap ?? 0), 0);
  const rate = items.reduce((s, i) => s + (i.marketCap ?? 0) * i.changeRate, 0) / w;
  return {
    changeRate: Math.round(rate * 100) / 100,
    up: items.filter((i) => i.changeRate > 0).length,
    flat: items.filter((i) => i.changeRate === 0).length,
    down: items.filter((i) => i.changeRate < 0).length,
  };
}

describe("DISC-03 미국 업종 상세: 출처 초기화 때 저장본으로 덮은 종목과 업종 요약이 같은 시점", () => {
  // 직전 정규장 마감 9/22 16:00 EDT, 지금 뉴욕 9/23 03:45 (출처가 등락률·거래량을 0 으로 비우는 시간)
  const CLOSE = "2026-09-22T20:00:00.000Z";
  const NOW = new Date("2026-09-23T07:45:00Z");
  const usItem = (sym: string, rate: number, vol: number, cap = 1000) => ({ symbolCode: sym, reutersCode: `${sym}.O`, name: sym, stockExchangeType: "NASDAQ", currentPrice: "10", fluctuations: "0", fluctuationsRatio: String(rate), accumulatedTradingVolume: String(vol), accumulatedTradingValue: String(vol * 10), marketValue: String(cap) });
  const quote = (sym: string, rate: number) => [`${sym}.O`, { code: sym, name: sym, market: "NASDAQ", currency: "USD", price: 11, change: 1, changeRate: rate, volume: 100, tradingValue: 1000, marketCap: 1000, tradedAt: null }] as const;
  type Summary = Pick<ThemeSummary, "changeRate" | "up" | "flat" | "down">;
  /** 보고서 재현: 1종목만 +10%, 9종목은 초기화(0%·거래량 0), 출처 요약은 0% · 상승1/보합9/하락0 */
  const RESET_ROWS = [usItem("S0", 10, 5000), ...Array.from({ length: 9 }, (_, i) => usItem(`S${i + 1}`, 0, 0))];
  const RESET_SUMMARY: Summary = { changeRate: 0, up: 1, flat: 9, down: 0 };

  function world(opts: { rows?: ReturnType<typeof usItem>[]; summary?: Summary; list?: "empty" | "fail" | "zero" | ThemeSummary[]; usq?: { savedAt: string; quotes: ReturnType<typeof quote>[] } | null; listSnap?: { savedAt: string; value: ThemeSummary[] } }) {
    const rows = opts.rows ?? RESET_ROWS;
    const s = opts.summary ?? RESET_SUMMARY;
    const fetchFn = (async (url: string) => {
      if (url.includes("/marketStatus")) return json({}, 404); // 장 상태는 달력(가짜)으로
      if (url.includes("/sectors/all")) {
        if (opts.list === "fail") return json({}, 500);
        // 아직 비우지 않은 업종 목록 (마감 뒤 값)
        if (Array.isArray(opts.list)) return ok({ sectors: opts.list.map((t) => ({ code: t.id, name: t.name, changeRate: t.changeRate, risingCount: t.up, unchangedCount: t.flat, fallingCount: t.down, topItems: [] })), hasNext: false });
        // 출처 초기화 때는 업종 목록도 거의 모두 0% (저장본을 쓴다)
        const sectors = opts.list === "zero" ? Array.from({ length: 20 }, (_, i) => ({ code: String(60 + i), name: `업종${i}`, changeRate: 0, topItems: [] })) : [];
        return ok({ sectors, hasNext: false });
      }
      if (url.includes("/sector/item/list")) {
        const page = Number(new URL(url).searchParams.get("page") ?? 1);
        return ok({ sectorCode: "57", sectorName: "IT", changeRate: s.changeRate, items: rows.slice((page - 1) * 50, page * 50), risingCount: s.up, unChangedCount: s.flat, fallingCount: s.down });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    const { store, m } = memStore();
    const usq = opts.usq === undefined ? { savedAt: CLOSE, quotes: [quote("S0", -5), ...Array.from({ length: 9 }, (_, i) => quote(`S${i + 1}`, 2))] } : opts.usq;
    if (usq) m.set("discover:snap:usq", JSON.stringify({ savedAt: Date.parse(usq.savedAt), value: usq.quotes }));
    if (opts.listSnap) m.set("discover:snap:themes:US:sector:day", JSON.stringify({ savedAt: Date.parse(opts.listSnap.savedAt), value: opts.listSnap.value }));
    return new DiscoverService({ naver: new NaverDiscover(fetchFn), store, calendar: calendarOf(state("KR", true), state("US", false, CLOSE)), now: () => NOW });
  }
  const it57 = (s: Summary): ThemeSummary => ({ id: "57", name: "IT", leaders: [], ...s });

  it("보고서 재현: 비워진 종목을 모두 덮었고 구성 종목이 잘리지 않았으면 요약을 보이는 종목 값으로 다시 센다 (모두 상승이면 상승 10)", async () => {
    for (const list of ["empty", "fail"] as const) {
      const d = await world({ list }).theme("US", "sector", "57");
      expect(d!.items.filter((i) => i.changeRate > 0)).toHaveLength(10);
      expect(d!.theme).toMatchObject({ up: 10, flat: 0, down: 0, changeRate: 2.8 }); // (10 + 2×9) / 10, 같은 시가총액
      expect(d!.theme).toMatchObject(fromItems(d!.items));
      expect(d!.theme.unverified).toBeUndefined();
      expect(d!.theme.adjusted).toBeUndefined(); // 상장 첫날 조정 문구가 붙지 않게
      expect(d!.note).toContain("9/10종목");
      expect(d!.asOf).toBe("2026-09-23T05:00:00+09:00");
    }
  });

  it("같은 마감 뒤에 저장한 업종 목록 요약이 있으면 그 값을 쓴다", async () => {
    const saved = it57({ changeRate: 2.75, up: 10, flat: 0, down: 0 });
    const d = await world({ list: "zero", listSnap: { savedAt: CLOSE, value: [saved] } }).theme("US", "sector", "57");
    expect(d!.theme).toMatchObject({ changeRate: 2.75, up: 10, flat: 0, down: 0 });
    expect(d!.theme.unverified).toBeUndefined();
    // 마감 뒤 받은 지금 목록(아직 비우지 않음)도 같은 시점 — 등락률까지 그 값으로 (출처 요약의 0% 를 남기지 않는다)
    const list = [it57({ changeRate: 2.7, up: 10, flat: 0, down: 0 }), ...Array.from({ length: 9 }, (_, i) => ({ id: String(70 + i), name: `업종${i}`, changeRate: 1 + i / 10, up: 1, flat: 0, down: 0, leaders: [] }))];
    const cur = await world({ list }).theme("US", "sector", "57");
    expect(cur!.theme).toMatchObject({ changeRate: 2.7, up: 10, flat: 0, down: 0 });
  });

  it("300종목에서 잘린 업종: 같은 시점 목록 요약이 있으면 그 수(전체 종목), 없으면 평균 내지 않고 확인 못 함으로 밝힌다", async () => {
    // 350종목 업종 — 출처는 300종목까지만 준다. 10종목만 값이 남고 나머지는 초기화
    const rows = Array.from({ length: 350 }, (_, i) => (i < 10 ? usItem(`T${i}`, 5, 1000) : usItem(`T${i}`, 0, 0)));
    const summary: Summary = { changeRate: 0.4, up: 10, flat: 340, down: 0 };
    const usq = { savedAt: CLOSE, quotes: rows.map((_, i) => quote(`T${i}`, -1)) };
    const same = await world({ rows, summary, usq, list: "zero", listSnap: { savedAt: CLOSE, value: [it57({ changeRate: -0.9, up: 20, flat: 30, down: 300 })] } }).theme("US", "sector", "57");
    expect(same!.items).toHaveLength(300);
    expect(same!.theme).toMatchObject({ changeRate: -0.9, up: 20, flat: 30, down: 300 });
    expect(same!.note).toContain("(전체 350종목)");
    // 목록 저장본이 그 전 정규장(9/21) 것이면 같은 시점이 아니다
    const old = await world({ rows, summary, usq, list: "zero", listSnap: { savedAt: "2026-09-21T20:00:00.000Z", value: [it57({ changeRate: -0.9, up: 20, flat: 30, down: 300 })] } }).theme("US", "sector", "57");
    expect(old!.theme).toMatchObject({ up: 0, flat: 0, down: 0, unverified: true });
    expect(old!.theme.changeRate).toBe(0.4); // 보이는 300종목의 평균(-0.68 등)으로 바꾸지 않는다
    expect(old!.note).toContain("확인하지 못했습니다");
  });

  it("일부만 덮었으면(저장본에 없는 종목) 다시 세지 않고 확인 못 함 · 남은 0% 종목 수를 밝힌다", async () => {
    const usq = { savedAt: CLOSE, quotes: Array.from({ length: 5 }, (_, i) => quote(`S${i + 1}`, 2)) };
    const d = await world({ usq, list: "empty" }).theme("US", "sector", "57");
    expect(d!.items.filter((i) => i.changeRate === 2)).toHaveLength(5);
    expect(d!.theme).toMatchObject({ up: 0, flat: 0, down: 0, unverified: true });
    expect(d!.note).toContain("5/10종목");
    expect(d!.note).toContain("4종목");
    expect(d!.note).toContain("확인하지 못했습니다");
  });

  it("시가총액이 없는 종목이 있으면 가중 평균을 다시 낼 수 없어 확인 못 함 (앱은 등락률을 '-' 로 보여 준다)", async () => {
    const rows = [usItem("S0", 10, 5000), ...Array.from({ length: 9 }, (_, i) => usItem(`S${i + 1}`, 0, 0, i === 0 ? 0 : 1000))];
    const d = await world({ rows, list: "empty" }).theme("US", "sector", "57");
    expect(d!.items.every((i) => i.changeRate > 0)).toBe(true);
    // 요약 등락률은 출처가 비운 때 값(0%) — 대표 값이 아니라고 unverified 로 알린다
    expect(d!.theme).toMatchObject({ changeRate: 0, up: 0, flat: 0, down: 0, unverified: true });
    expect(d!.note).toContain("확인하지 못했습니다");
  });

  it("저장본이 마감 전(정규장 중) 값이면 마감 뒤 목록 요약과 시점이 달라 쓰지 않는다 — 다 덮었으면 다시 센다", async () => {
    const usq = { savedAt: "2026-09-22T19:50:00.000Z", quotes: [quote("S0", -5), ...Array.from({ length: 9 }, (_, i) => quote(`S${i + 1}`, 2))] };
    const d = await world({ usq, list: "zero", listSnap: { savedAt: CLOSE, value: [it57({ changeRate: 2.75, up: 10, flat: 0, down: 0 })] } }).theme("US", "sector", "57");
    expect(d!.theme).toMatchObject({ ...fromItems(d!.items), changeRate: 2.8 });
  });

  it("저장본이 없거나 초기화 전이면 출처 요약 그대로 (보이는 종목과 같은 때 값)", async () => {
    const none = await world({ usq: null, list: "empty" }).theme("US", "sector", "57");
    expect(none!.theme).toMatchObject({ ...RESET_SUMMARY });
    expect(none!.theme).toMatchObject({ up: fromItems(none!.items).up, flat: fromItems(none!.items).flat, down: 0 });
    expect(none!.note).toContain("0으로 비웠습니다");
    const rows = Array.from({ length: 10 }, (_, i) => usItem(`S${i}`, i < 6 ? 1 : -1, 100));
    const before = await world({ rows, summary: { changeRate: 0.2, up: 6, flat: 0, down: 4 }, list: "empty" }).theme("US", "sector", "57");
    expect(before!.theme).toMatchObject({ changeRate: 0.2, up: 6, flat: 0, down: 4 });
    expect(before!.theme.unverified).toBeUndefined();
    expect(before!.note).toBeNull();
  });

  it("저장본 없이(또는 덮을 종목이 없어) 비워진 채인데 마감 뒤 목록 요약이 있으면 등락률·수를 모두 그 목록 값으로 (머리 안에서 시점을 섞지 않는다)", async () => {
    const rates = [10, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const others = Array.from({ length: 9 }, (_, i) => ({ id: String(70 + i), name: `업종${i}`, changeRate: 1 + i / 10, up: 1, flat: 0, down: 0, leaders: [] }));
    const list = [it57({ changeRate: 2.8, up: 10, flat: 0, down: 0 }), ...others];
    // 검증 재현: usq 저장본 없음 + 마감 뒤 받은 지금 목록 57 = 2.8% · 상승 10 (예전: 0% · 상승 10/보합 0 — 등락률만 비운 때 값)
    const unrelated = { savedAt: CLOSE, quotes: [quote("X1", 3)] }; // 저장본은 있지만 이 업종 종목이 없다
    for (const usq of [null, unrelated]) {
      const d = await world({ usq, list }).theme("US", "sector", "57");
      expect(d!.items.map((i) => i.changeRate)).toEqual(rates); // 종목은 비워진 값 그대로
      expect(d!.theme).toMatchObject({ changeRate: 2.8, up: 10, flat: 0, down: 0 });
      expect(d!.theme.unverified).toBeUndefined();
      expect(d!.note).toContain("0으로 비웠습니다");
      expect(d!.note).toContain("업종 목록 값"); // 머리(마감 뒤 목록)와 종목(비운 값)의 시점 차이를 밝힌다
    }
    // 지금 목록도 비워져(저장본 목록) 없으면 마감 뒤에 남긴 목록 저장본의 요약
    const snap = await world({ usq: null, list: "zero", listSnap: { savedAt: CLOSE, value: [it57({ changeRate: 2.75, up: 9, flat: 1, down: 0 })] } }).theme("US", "sector", "57");
    expect(snap!.items.map((i) => i.changeRate)).toEqual(rates);
    expect(snap!.theme).toMatchObject({ changeRate: 2.75, up: 9, flat: 1, down: 0 });
    // 목록 저장본이 그 전 정규장 것이면 쓰지 않고 출처 요약 그대로 (보이는 비워진 종목과 같은 때 값)
    const old = await world({ usq: null, list: "zero", listSnap: { savedAt: "2026-09-21T20:00:00.000Z", value: [it57({ changeRate: 2.75, up: 9, flat: 1, down: 0 })] } }).theme("US", "sector", "57");
    expect(old!.theme).toMatchObject({ ...RESET_SUMMARY });
    expect(old!.theme).toMatchObject({ up: fromItems(old!.items).up, flat: fromItems(old!.items).flat, down: 0 });
    expect(old!.note).not.toContain("업종 목록 값");
  });

  it("300종목에서 잘린 업종이 저장본 없이 비워진 채: 마감 뒤 목록 요약이 있으면 그 등락률·전체 종목 수", async () => {
    const rows = Array.from({ length: 350 }, (_, i) => (i < 10 ? usItem(`T${i}`, 5, 1000) : usItem(`T${i}`, 0, 0)));
    const summary: Summary = { changeRate: 0.4, up: 10, flat: 340, down: 0 };
    const d = await world({ rows, summary, usq: null, list: "zero", listSnap: { savedAt: CLOSE, value: [it57({ changeRate: -0.9, up: 20, flat: 30, down: 300 })] } }).theme("US", "sector", "57");
    expect(d!.items).toHaveLength(300);
    expect(d!.theme).toMatchObject({ changeRate: -0.9, up: 20, flat: 30, down: 300 });
    expect(d!.note).toContain("(전체 350종목)");
    // 목록도 없으면 수는 세지 않는다 (예전과 같음)
    const none = await world({ rows, summary, usq: null, list: "zero" }).theme("US", "sector", "57");
    expect(none!.theme).toMatchObject({ changeRate: 0.4, up: 0, flat: 0, down: 0 });
  });
});

describe("DISC-04 순위 더 보기: 첫 쪽의 판(ver)을 잃으면 다른 판을 이어 주지 않는다", () => {
  const codes = Array.from({ length: 250 }, (_, i) => String(i).padStart(6, "0"));
  /** 한국 거래량 순위 원본. revision 이 바뀌면 000050 이 1위로 올라온다 (보고서 재현과 같은 조건) */
  function rankWorld() {
    const w = { revision: 0, now: new Date("2026-09-24T02:00:00Z"), calls: 0, down: false };
    const naver = {
      marketStatus: async () => ({}),
      krRankPage: async (_c: string, index: number) => {
        w.calls++;
        if (w.down) throw new Error("down");
        const order = w.revision ? [codes[50]!, ...codes.slice(0, 50), ...codes.slice(51)] : codes;
        return {
          items: order.slice(index * 50, (index + 1) * 50).map((code, i) => ({ code, name: code, market: "KOSPI", currency: "KRW" as const, price: 100, change: 1, changeRate: 1, volume: 10_000 - index * 50 - i, tradingValue: 1e9 })),
          hasNext: (index + 1) * 50 < order.length,
        };
      },
    } as unknown as NaverDiscover;
    const calendar = calendarOf(state("KR", true), state("US", false));
    const make = () => new DiscoverService({ naver, calendar, now: () => w.now });
    return { w, make };
  }
  const tick = (w: { now: Date }) => (w.now = new Date(w.now.getTime() + 31_000));
  const newOrder = [codes[50]!, ...codes.slice(0, 50), ...codes.slice(51)];
  /** 새 앱: restart 를 안다고 알린다 (요청의 r=1) */
  const R1 = { restart: true };

  it("최근 5판 밖으로 밀린 판이면 새 목록 쪽 대신 빈 쪽 + restart — 첫 쪽부터 다시 받으면 빠진 종목·순서가 맞다", async () => {
    const { w, make } = rankWorld();
    const svc = make();
    const page1 = await svc.rank("KR", "volume", 1, 50);
    for (let i = 0; i < 6; i++) {
      w.revision++;
      tick(w);
      await svc.rank("KR", "volume", 1, 50); // 다른 앱이 새로고침 — 새 판
    }
    const page2 = await svc.rank("KR", "volume", 2, 50, page1.ver, R1);
    expect(page2).toMatchObject({ restart: true, items: [], hasMore: false });
    // 앱이 첫 쪽부터 다시 받는다
    const again1 = await svc.rank("KR", "volume", 1, 50);
    const again2 = await svc.rank("KR", "volume", 2, 50, again1.ver, R1);
    expect(again2.restart).toBeUndefined();
    expect([...again1.items, ...again2.items].map((i) => i.code)).toEqual(newOrder.slice(0, 100));
  });

  it("서버를 다시 켠 뒤 옛 판으로 뒤 쪽을 물어도 새 목록을 이어 주지 않는다", async () => {
    const { w, make } = rankWorld();
    const page1 = await make().rank("KR", "volume", 1, 50);
    w.revision++;
    tick(w);
    const restarted = make();
    const page2 = await restarted.rank("KR", "volume", 2, 50, page1.ver, R1);
    expect(page2).toMatchObject({ restart: true, items: [], hasMore: false });
    expect(page2.ver).not.toBe(page1.ver);
    const again1 = await restarted.rank("KR", "volume", 1, 50);
    const again2 = await restarted.rank("KR", "volume", 2, 50, again1.ver, R1);
    const all = [...again1.items, ...again2.items].map((i) => i.code);
    expect(all).toContain("000050");
    expect(all).toEqual(newOrder.slice(0, 100));
  });

  it("판을 잃은 뒤 쪽은 원본을 받지 않고 바로 restart — 깊은 쪽(20쪽)도 수백 줄을 받지 않고, 원본이 실패해도 오류 대신 restart", async () => {
    const { w, make } = rankWorld();
    const page1 = await make().rank("KR", "volume", 1, 50);
    w.revision++;
    tick(w);
    const restarted = make();
    w.calls = 0;
    const deep = await restarted.rank("KR", "volume", 20, 50, page1.ver, R1);
    expect(deep).toMatchObject({ restart: true, items: [], hasMore: false, page: 20 });
    expect(w.calls).toBe(0);
    // 원본이 내려가 있어도 restart 를 준다 (첫 쪽 요청에서 오류·저장본을 다룬다)
    w.down = true;
    const down = await restarted.rank("KR", "volume", 3, 50, page1.ver, R1);
    expect(down).toMatchObject({ restart: true, items: [], hasMore: false });
    expect(w.calls).toBe(0);
    await expect(restarted.rank("KR", "volume", 1, 50)).rejects.toThrow("down");
    // 원본이 돌아오면 첫 쪽부터 새 목록
    w.down = false;
    tick(w);
    const again1 = await restarted.rank("KR", "volume", 1, 50);
    expect(again1.items[0]!.code).toBe("000050");
    // 판을 가진 서버에서도 잃은 판의 뒤 쪽은 원본을 더 받지 않는다 (지금 판 그대로)
    const calls = w.calls;
    const gone = await restarted.rank("KR", "volume", 4, 50, page1.ver, R1);
    expect(gone).toMatchObject({ restart: true, items: [], ver: again1.ver });
    expect(w.calls).toBe(calls);
    const again2 = await restarted.rank("KR", "volume", 2, 50, again1.ver, R1);
    expect(again2.restart).toBeUndefined();
    expect([...again1.items, ...again2.items].map((i) => i.code)).toEqual(newOrder.slice(0, 100));
  });

  it("판이 남아 있으면(최근 5판) 그 판에서 빠짐·겹침 없이 이어 주고, 판 없이 부르면(옛 앱) 지금 목록", async () => {
    const { w, make } = rankWorld();
    const svc = make();
    const page1 = await svc.rank("KR", "volume", 1, 50);
    for (let i = 0; i < 5; i++) {
      w.revision++;
      tick(w);
      await svc.rank("KR", "volume", 1, 50);
    }
    const page2 = await svc.rank("KR", "volume", 2, 50, page1.ver);
    expect(page2.restart).toBeUndefined();
    expect(page2.ver).toBe(page1.ver);
    expect([...page1.items, ...page2.items].map((i) => i.code)).toEqual(codes.slice(0, 100));
    const bare = await svc.rank("KR", "volume", 2, 50);
    expect(bare.restart).toBeUndefined();
    expect(bare.items.map((i) => i.code)).toEqual(newOrder.slice(50, 100));
  });

  it("옛 앱(r 플래그 없음)이 잃은 판으로 뒤 쪽을 물으면 main 서버처럼 지금 목록의 쪽을 준다 — 빈 쪽에서 더 보기·자동 갱신이 멈추지 않게", async () => {
    const { w, make } = rankWorld();
    const before = make();
    const page1 = await before.rank("KR", "volume", 1, 50);
    await before.rank("KR", "volume", 2, 50, page1.ver);
    await before.rank("KR", "volume", 3, 50, page1.ver);
    w.revision++;
    tick(w);
    // 배포(재시작) 뒤 옛 앱이 4쪽을 옛 판으로 묻는다
    const restarted = make();
    const page4 = await restarted.rank("KR", "volume", 4, 50, page1.ver);
    expect(page4.restart).toBeUndefined();
    expect(page4.items.map((i) => i.code)).toEqual(newOrder.slice(150, 200));
    expect(page4.hasMore).toBe(true);
    // 최근 5판 밖으로 밀린 판도 같다
    const svc = make();
    const first = await svc.rank("KR", "volume", 1, 50);
    for (let i = 0; i < 6; i++) {
      tick(w);
      await svc.rank("KR", "volume", 1, 50);
    }
    const page2 = await svc.rank("KR", "volume", 2, 50, first.ver);
    expect(page2.restart).toBeUndefined();
    expect(page2.items).toHaveLength(50);
  });

  it("GET 순위: r=1 을 보낸 요청에만 restart, 없으면 지금 목록의 쪽 (옛 앱 번들 호환)", async () => {
    const { w, make } = rankWorld();
    const page1 = await make().rank("KR", "volume", 1, 50);
    w.revision++;
    tick(w);
    const app = Fastify({ logger: false });
    await app.register(discoverRoutes, { prefix: "/api/discover", service: make() });
    try {
      const old = (await app.inject({ method: "GET", url: `/api/discover/KR/rank/volume?page=2&size=50&v=${page1.ver}` })).json() as DiscoverRank;
      expect(old.restart).toBeUndefined();
      expect(old.items.map((i) => i.code)).toEqual(newOrder.slice(50, 100));
      const neu = (await app.inject({ method: "GET", url: `/api/discover/KR/rank/volume?page=2&size=50&v=${page1.ver}&r=1` })).json() as DiscoverRank;
      expect(neu).toMatchObject({ restart: true, items: [], hasMore: false });
      // 판이 남아 있으면 플래그와 상관없이 그 판에서 이어 준다
      const cur = (await app.inject({ method: "GET", url: "/api/discover/KR/rank/volume?page=1&size=50&r=1" })).json() as DiscoverRank;
      const next = (await app.inject({ method: "GET", url: `/api/discover/KR/rank/volume?page=2&size=50&v=${cur.ver}&r=1` })).json() as DiscoverRank;
      expect(next.restart).toBeUndefined();
      expect([...cur.items, ...next.items].map((i) => i.code)).toEqual(newOrder.slice(0, 100));
    } finally {
      await app.close();
    }
  });
});
