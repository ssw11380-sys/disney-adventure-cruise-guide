import { describe, expect, it } from "vitest";
import { appTicker, isUsNonCommon, krStock, NaverDiscover, usTicker } from "../src/providers/market/naverDiscover.js";
import { TossTics } from "../src/providers/market/tossTics.js";
import { DiscoverService, isKrxRegularHours, lastKrClose, lastUsRegularDay, recount } from "../src/services/discoverService.js";
import { UsThemeBook } from "../src/services/usThemes.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ isSuccess: true, result });
const krRow = (code: string, rate: number, tv: number, extra: Record<string, unknown> = {}) => ({
  itemCode: code,
  name: `종목${code}`,
  stockEndType: "stock",
  marketType: "KOSPI",
  currentPrice: 10000,
  fluctuations: "0",
  fluctuationsRatio: String(rate),
  accumulatedTradingVolume: 1000,
  accumulatedTradingValue: tv,
  marketValue: 1e12,
  ...extra,
});

describe("발견 탭 검토 수정", () => {
  it("쪽을 이어 받아도 이미 보낸 앞부분의 순서는 그대로 — 경계에서 빠지거나 두 번 나오지 않는다", async () => {
    // 원본 순서가 조금 어긋난 급상승: 뒤 쪽에 앞 쪽보다 큰 값이 섞여 있다
    const fetchFn = (async (url: string) => {
      const index = Number(new URL(url).searchParams.get("index"));
      if (index > 7) return ok({ items: [], hasNext: false });
      const rows = Array.from({ length: 50 }, (_, i) => {
        const n = index * 50 + i;
        const rate = 29 - n * 0.05 + (n % 7 === 0 ? 3 : 0); // 7번째마다 튀는 값
        return krRow(String(100000 + n), Math.round(rate * 100) / 100, 2e9);
      });
      return ok({ items: rows, hasNext: index < 7 });
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T02:00:00Z") });
    const pages: string[][] = [];
    for (let p = 1; p <= 6; p++) pages.push((await svc.rank("KR", "gainers", p, 50)).items.map((i) => i.code));
    const all = pages.flat();
    expect(new Set(all).size).toBe(all.length); // 중복 없음
    // 1쪽을 다시 받아도 같은 순서 (이어 받기가 앞부분을 바꾸지 않음)
    expect((await svc.rank("KR", "gainers", 1, 50)).items.map((i) => i.code)).toEqual(pages[0]);
    // 원본 400개(8쪽)를 다 받았으면 400개가 모두 나온다
    expect(all.length).toBe(300);
    const p8 = await svc.rank("KR", "gainers", 8, 50);
    expect(new Set([...all, ...p8.items.map((i) => i.code)]).size).toBe(all.length + p8.items.length);
    expect(p8.hasMore).toBe(false);
  });

  it("원본 12쪽 상한이나 앱 20쪽 상한에 닿으면 hasMore=false, 빈 쪽은 hasMore=false", async () => {
    // 끝없이 hasNext=true 인데 걸러서 조금만 남는 원본
    const fetchFn = (async (url: string) => {
      const index = Number(new URL(url).searchParams.get("index"));
      const rows = Array.from({ length: 50 }, (_, i) => krRow(String(200000 + index * 50 + i), 10, i < 5 ? 2e9 : 1e8));
      return ok({ items: rows, hasNext: true });
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T02:00:00Z") });
    const p1 = await svc.rank("KR", "gainers", 1, 50); // 12쪽 × 5개 = 60개
    expect(p1.items).toHaveLength(50);
    const p2 = await svc.rank("KR", "gainers", 2, 50);
    expect(p2.items).toHaveLength(10);
    expect(p2.hasMore).toBe(false);
    const p3 = await svc.rank("KR", "gainers", 3, 50);
    expect(p3).toMatchObject({ items: [], hasMore: false });
  });

  it("한국 순위 값은 KRX 기준 (가격이 KRX 라 거래량·대금도 KRX, NXT 통합 값은 쓰지 않음)", () => {
    const s = krStock(krRow("005930", 3.25, 5.3e12, { accumulatedTradingVolume: 18_684_033, krxNxtIntegratedPriceInfo: { accumulatedTradingVolume: 27_884_063, accumulatedTradingValue: 7.9e12 } }));
    expect(s).toMatchObject({ volume: 18_684_033, tradingValue: 5.3e12 });
  });

  it("KRX 정규장 09:00~15:30, 달력이 없을 때 마지막 거래 마감 근사 = 직전 평일 20:00, 미국 최근 정규장 날짜", () => {
    expect(isKrxRegularHours(new Date("2026-09-23T00:00:00Z"))).toBe(true); // 09:00
    expect(isKrxRegularHours(new Date("2026-09-23T06:29:00Z"))).toBe(true); // 15:29
    expect(isKrxRegularHours(new Date("2026-09-23T06:30:00Z"))).toBe(false); // 15:30 (시간외)
    expect(isKrxRegularHours(new Date("2026-09-22T23:30:00Z"))).toBe(false); // 08:30 (장 시작 전)
    expect(isKrxRegularHours(new Date("2026-09-26T02:00:00Z"))).toBe(false); // 토요일
    expect(lastKrClose(new Date("2026-09-23T11:30:00Z"))).toBe("2026-09-23T20:00:00+09:00"); // 20:30 → 오늘
    expect(lastKrClose(new Date("2026-09-23T08:00:00Z"))).toBe("2026-09-22T20:00:00+09:00"); // 17:00 → 어제
    expect(lastKrClose(new Date("2026-09-28T01:00:00Z"))).toBe("2026-09-25T20:00:00+09:00"); // 월 10:00 → 금요일 (휴장은 모름 — 달력이 있으면 달력 값)
    // 미국: 달력의 마지막 세션 종료가 있으면 그 날, 없으면 09:30 이 지난 평일
    expect(lastUsRegularDay(new Date("2026-09-23T08:00:00Z"), "2026-09-22T20:00:00.000Z")).toBe("2026-09-22");
    expect(lastUsRegularDay(new Date("2026-09-23T08:00:00Z"), null)).toBe("2026-09-22"); // 뉴욕 04:00 → 어제
    expect(lastUsRegularDay(new Date("2026-09-23T14:00:00Z"), null)).toBe("2026-09-23"); // 뉴욕 10:00 → 오늘
    expect(lastUsRegularDay(new Date("2026-09-28T08:00:00Z"), null)).toBe("2026-09-25"); // 월 04:00 → 금요일
  });

  it("미국 업종 목록의 기준 시각은 장 밖이면 직전 정규장 마감(16:00 ET, 서머타임 반영)", async () => {
    const fetchFn = (async () => json({ isSuccess: true, result: { sectors: [{ code: "1", name: "IT", changeRate: 1, topItems: [] }], hasNext: false } })) as unknown as typeof fetch;
    const at = (now: string, lastClose: string) =>
      new DiscoverService({
        naver: new NaverDiscover(fetchFn),
        calendar: { status: async () => ({ now: "", KR: { market: "KR", isOpen: false, isTradingDay: true, opensAt: null, closesAt: null, source: "toss" }, US: { market: "US", isOpen: false, isTradingDay: true, opensAt: null, closesAt: null, lastClose, source: "toss" } }) } as never,
        now: () => new Date(now),
      }).themes("US", "sector", "day");
    expect((await at("2026-09-23T08:00:00Z", "2026-09-22T20:00:00.000Z")).asOf).toBe("2026-09-23T05:00:00+09:00"); // 서머타임
    expect((await at("2026-12-01T08:00:00Z", "2026-11-30T21:00:00.000Z")).asOf).toBe("2026-12-01T06:00:00+09:00"); // 표준시
  });

  it("미국 티커: 클래스주 BRK.B, 우선주·권리주 제외, MLP(Common Units)는 남기고 스팩 유닛은 뺀다", () => {
    expect(appTicker("BRK B")).toBe("BRK.B");
    expect(appTicker("BIP PRA")).toBeNull();
    expect(usTicker({ reutersCode: "BRKb" })).toBe("BRK.B");
    expect(usTicker({ reutersCode: "AHT_pd" })).toBeNull();
    expect(usTicker({ reutersCode: "AAPL.O" })).toBe("AAPL");
    // 네이버 실제 이름: MLP·로열티 트러스트 지분은 "… Units" 로 온다 → 남긴다
    for (const [eng, sym] of [
      ["Energy Transfer Units", "ET"],
      ["Plains All American Pipeline Units", "PAA"],
      ["Icahn Enterprises Units", "IEP"],
      ["Dorchester Minerals Units", "DMLP"],
      ["Black Stone Minerals Units", "BSM"],
      ["Permian Basin Royalty Units", "PBT"],
      ["Sabine Royalty Units", "SBR"],
      ["Enterprise Products Partners LP", "EPD"],
    ])
      expect(isUsNonCommon(eng!, sym!), sym).toBe(false);
    expect(isUsNonCommon("Cayson Acquisition Corp Units", "CAPNU")).toBe(true);
    expect(isUsNonCommon("Some Growth Capital Units", "SGCU")).toBe(true);
    expect(isUsNonCommon("KLX Energy Services Holdings Rights", "KLXER")).toBe(true);
  });

  it("업종 신규상장 재계산은 시가총액 가중 (네이버 업종과 같은 방식)", () => {
    const base = { id: "1", name: "t", changeRate: 150, up: 0, flat: 0, down: 0, leaders: [] };
    const s = (code: string, changeRate: number, marketCap: number) => ({ code, name: code, market: "KOSPI", currency: "KRW" as const, price: 1, change: 0, changeRate, volume: 10, tradingValue: 1, marketCap });
    const items = [s("BIG", 10, 1100), s("SMALL", -10, 90), s("NEW", 300, 400)]; // 전일 시총 1000, 100
    expect(recount(base, items, new Set(["NEW"]), true).changeRate).toBe(8.18); // (10·1000 − 10·100) / 1100
    expect(recount(base, items, new Set(["NEW"]), false).changeRate).toBe(0);
  });

  it("직전 값이 있으면 느린 새 조회를 오래 기다리지 않고 직전 값을 준다 (새 값은 뒤에서 채움)", async () => {
    let slow = false;
    let release: () => void = () => {};
    const fetchFn = (async (url: string) => {
      if (slow && url.includes("sectors/all")) await new Promise<void>((r) => (release = r));
      return ok({ sectors: [{ code: "1", name: "테마", changeRate: slow ? 2 : 1, risingCount: 1, unchangedCount: 0, fallingCount: 0, topItems: [] }], hasNext: false });
    }) as unknown as typeof fetch;
    let clock = new Date("2026-09-23T02:00:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => clock, staleWaitMs: 30 });
    expect((await svc.themes("KR", "theme", "day")).themes[0]!.changeRate).toBe(1);
    slow = true;
    clock = new Date(clock.getTime() + 10 * 60_000);
    const t0 = Date.now();
    const stale = await svc.themes("KR", "theme", "day");
    expect(stale.themes[0]!.changeRate).toBe(1); // 직전 값
    expect(Date.now() - t0).toBeLessThan(1000);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect((await svc.themes("KR", "theme", "day")).themes[0]!.changeRate).toBe(2); // 뒤에서 채운 새 값
  });

  it("직전 값 없이 실패하면 잠시 같은 오류를 바로 준다 (요청마다 상류를 다시 부르지 않음)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return json({}, 503);
    }) as unknown as typeof fetch;
    let now = new Date("2026-09-23T02:00:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    await expect(svc.themes("KR", "theme", "day")).rejects.toThrow("HTTP 503");
    const after = calls;
    await expect(svc.themes("KR", "theme", "day")).rejects.toThrow("HTTP 503");
    expect(calls).toBe(after);
    now = new Date(now.getTime() + 30_000);
    await expect(svc.themes("KR", "theme", "day")).rejects.toThrow("HTTP 503");
    expect(calls).toBeGreaterThan(after); // 20초 뒤에는 다시 시도
  });

  it("모르는 미국 업종 코드는 404(null) — 네이버가 500 을 줘도 받아 둔 목록에 없으면", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/stock/sectors/all")) return ok({ sectors: [{ code: "57201010", name: "IT 서비스", changeRate: -0.5, topItems: [] }], hasNext: false });
      if (url.includes("worldstock/sector/item/list")) return json({ message: "Request failed with status code 500" }, 500);
      return json({}, 404);
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn) });
    await svc.themes("US", "sector", "day");
    expect(await svc.theme("US", "sector", "99999999")).toBeNull();
    await expect(svc.theme("US", "sector", "57201010")).rejects.toThrow("HTTP 500"); // 목록에 있으면 진짜 오류
  });

  it("테마북 만들기가 실패하면 백오프 동안 다시 만들지 않고, 크게 줄어든 결과로 정상본을 덮어쓰지 않는다", async () => {
    let tossDown = false;
    let calls = 0;
    let themeCount = 3;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.host.includes("tossinvest")) {
        calls++;
        if (tossDown) return json({}, 503);
        if (u.pathname.endsWith("/tics/ranking")) return json({ result: { tics: [{ ticsId: 1, name: "a", fluctuationRate: 0.01 }] } });
        if (u.pathname.endsWith("/overview"))
          return json({ result: { ticsId: 1, name: "a", relatedTics: [{ ticsId: 9, name: "root", depth: 0, subItems: Array.from({ length: themeCount }, (_, i) => ({ ticsId: 10 + i, name: `t${i}`, depth: 1, subItems: [] })) }] } });
        if (u.pathname.endsWith("/stocks")) {
          void init;
          return json({ result: { totalCount: 3, stocks: ["P1", "P2", "P3"].map((c) => ({ code: c, name: c })) } });
        }
        if (u.pathname.endsWith("/v1/stock-infos")) return json({ result: ["P1", "P2", "P3"].map((c) => ({ code: c, symbol: `S${c}`, market: { code: "NSQ" }, name: c, status: "N" })) });
      }
      if (u.host.includes("polling")) {
        const codes = decodeURIComponent(u.pathname.split("/").pop() ?? "").split(",");
        return json({ datas: codes.filter((c) => c.endsWith(".O")).map((c) => ({ reutersCode: c, symbolCode: c.replace(".O", ""), stockName: c, closePriceRaw: "1", fluctuationsRatioRaw: "1", compareToPreviousClosePriceRaw: "0.01", accumulatedTradingVolumeRaw: "10", accumulatedTradingValueRaw: "2000000", marketValueFullRaw: "100", localTradedAt: "2026-09-22T16:00:00-04:00", tradeStopType: { name: "TRADING" } })) });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    let now = new Date("2026-09-23T06:00:00Z");
    const book = new UsThemeBook({ tics: new TossTics(fetchFn, 0), naver: new NaverDiscover(fetchFn), now: () => now });
    expect((await book.get()).themes).toHaveLength(4); // 순위에 나온 1 + 트리의 t0~t2
    // 하루 넘게 지나 새로 만들다 토스가 테마를 조금만 준다 → 너무 작아 실패, 옛것 유지
    themeCount = 1;
    now = new Date("2026-09-24T07:00:00Z");
    await book.refresh();
    expect((await book.get()).themes).toHaveLength(4);
    // 토스가 막히면: 한 번 실패한 뒤 10분 동안은 get 이 다시 만들지 않는다
    tossDown = true;
    themeCount = 3;
    now = new Date("2026-09-24T07:01:00Z");
    await book.get(); // 옛것을 주면서 뒤에서 만들기 시도 → 실패
    await new Promise((r) => setTimeout(r, 30));
    const before = calls;
    now = new Date("2026-09-24T07:05:00Z");
    await book.get();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(before); // 백오프 중
    now = new Date("2026-09-24T07:20:00Z");
    await book.get();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBeGreaterThan(before); // 10분 뒤 다시 시도
  });
});

describe("토스 달력 캐시", () => {
  it("TTL 안이라도 개장·마감 시각을 지나면 바로 다시 묻는다", async () => {
    const { MarketCalendar } = await import("../src/providers/market/calendar.js");
    let calls = 0;
    let now = new Date("2026-09-23T13:29:00Z"); // 09:29 ET
    const fetchFn = (async () => {
      calls++;
      const us = now.getTime() < Date.parse("2026-09-23T13:30:00Z") ? { tradingEnd: "2026-09-22T20:00:00Z", nextTradingStart: "2026-09-23T13:30:00Z" } : { tradingEnd: "2026-09-23T20:00:00Z", nextTradingStart: "2026-09-24T13:30:00Z" };
      return json({ result: [{ productCode: "US19801212001", ...us }, { productCode: "A005930", tradingEnd: "2026-09-23T11:00:00Z", nextTradingStart: "2026-09-27T23:00:00Z" }] });
    }) as unknown as typeof fetch;
    const cal = new MarketCalendar(fetchFn, () => now);
    expect((await cal.status()).US.isOpen).toBe(false);
    now = new Date("2026-09-23T13:29:50Z");
    await cal.status();
    expect(calls).toBe(1);
    now = new Date("2026-09-23T13:30:05Z");
    expect((await cal.status()).US.isOpen).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("토스 달력 동시 요청", () => {
  it("캐시가 끝난 직후 동시에 들어온 요청은 한 번만 묻는다", async () => {
    const { MarketCalendar } = await import("../src/providers/market/calendar.js");
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return json({ result: [] });
    }) as unknown as typeof fetch;
    const cal = new MarketCalendar(fetchFn, () => new Date("2026-09-23T01:00:00Z"));
    await Promise.all([cal.status(), cal.status(), cal.status(), cal.status()]);
    expect(calls).toBe(1);
  });
});
