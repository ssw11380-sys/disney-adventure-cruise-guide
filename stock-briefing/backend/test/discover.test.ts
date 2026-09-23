import { describe, expect, it } from "vitest";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { DiscoverService, isUsRegularHours, recount } from "../src/services/discoverService.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ isSuccess: true, detailCode: "", message: "", result });

/** 네이버 한국 순위 한 줄 */
const krRow = (code: string, name: string, rate: number, tv: number, extra: Record<string, unknown> = {}) => ({
  itemCode: code,
  name,
  stockEndType: "stock",
  marketType: "KOSPI",
  currentPrice: 10000,
  fluctuations: String(rate * 100),
  fluctuationsRatio: String(rate),
  accumulatedTradingVolume: 1000,
  accumulatedTradingValue: tv,
  marketValue: 1e12,
  ...extra,
});

describe("NaverDiscover + DiscoverService (한국)", () => {
  it("순위는 ETF·ETN·스팩을 빼고, 급상승은 거래대금 10억 원 미만을 빼며, 쪽을 이어 받는다", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      if (!url.includes("/marketStatus")) calls.push(url); // 장 상태 조회는 세지 않는다
      const u = new URL(url);
      const index = Number(u.searchParams.get("index"));
      if (u.pathname.endsWith("/domestic/stock/list/sorted") && u.searchParams.get("sortType") === "up") {
        const rows = Array.from({ length: 50 }, (_, i) => {
          const n = index * 50 + i;
          if (n % 10 === 3) return krRow(`1${String(n).padStart(5, "0")}`, `KODEX ${n}`, 30 - n * 0.1, 5e9, { stockEndType: "etf" });
          if (n % 10 === 5) return krRow(`2${String(n).padStart(5, "0")}`, `하나스팩${n}`, 30 - n * 0.1, 5e9);
          if (n % 10 === 7) return krRow(`3${String(n).padStart(5, "0")}`, `동전${n}`, 30 - n * 0.1, 5e8); // 거래대금 5억
          return krRow(`0${String(n).padStart(5, "0")}`, `종목${n}`, 30 - n * 0.1, 2e9);
        });
        return ok({ items: rows, hasNext: index < 5, totalCount: 300 });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T05:00:00Z") });
    const p1 = await svc.rank("KR", "gainers", 1, 50);
    expect(p1.items).toHaveLength(50);
    expect(p1.items.every((i) => i.code.startsWith("0"))).toBe(true); // ETF(1)·스팩(2)·동전(3) 제외
    expect(p1.items[0]).toMatchObject({ code: "000000", name: "종목0", changeRate: 30, currency: "KRW", tradingValue: 2e9 });
    expect(p1.items[0]!.newlyListed).toBeUndefined();
    expect(p1.hasMore).toBe(true);
    expect(p1.note).toContain("10억 원");
    expect(calls).toHaveLength(3); // 한 번에 3쪽 (쪽당 걸러낸 뒤 35개 → 105개)
    const p2 = await svc.rank("KR", "gainers", 2, 50);
    expect(p2.items).toHaveLength(50);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.code)).size).toBe(100);
    expect(calls).toHaveLength(3); // 이미 가진 것으로 충분
    const p3 = await svc.rank("KR", "gainers", 3, 50);
    expect(p3.items).toHaveLength(50);
    expect(calls).toHaveLength(7); // 부족한 만큼만 이어 받음 (바로 앞 쪽 하나를 겹쳐 다시 받아 쪽 경계에서 빠지는 종목이 없게)
    const p4 = await svc.rank("KR", "gainers", 4, 50);
    expect(p4.items).toHaveLength(50);
    expect(p4.hasMore).toBe(true); // 6쪽 × 35 = 210
    const p5 = await svc.rank("KR", "gainers", 5, 50);
    expect(p5.items).toHaveLength(10);
    expect(p5.hasMore).toBe(false);
    // 캐시 안에서는 다시 받지 않는다
    const again = calls.length;
    await svc.rank("KR", "gainers", 1, 50);
    expect(calls.length).toBe(again);
  });

  it("순위는 받은 값으로 다시 정렬하고, 가격제한폭을 넘는 정리매매는 빼며(상장 첫날은 남김), 빈 목록이 오면 직전 목록을 유지한다", async () => {
    let empty = false;
    let now = new Date("2026-09-23T05:00:00Z");
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (empty) return ok({ items: [], hasNext: false });
      if (u.searchParams.get("sortType") === "down")
        return ok({
          items: [
            krRow("000010", "정리매매", -96.68, 1.03e9),
            krRow("000011", "가", -12, 2e9),
            krRow("000012", "나", -15, 2e9), // 출처 순서가 어긋남
            krRow("000013", "다", -29.9, 2e9),
          ],
          hasNext: false,
        });
      if (u.searchParams.get("sortType") === "up")
        return ok({ items: [krRow("0010S0", "새내기", 288, 9e11, { newlyListed: true }), krRow("000020", "라", 21.65, 2e9), krRow("000021", "마", 22.06, 2e9)], hasNext: false });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    const losers = await svc.rank("KR", "losers", 1, 50);
    expect(losers.items.map((i) => i.code)).toEqual(["000013", "000012", "000011"]);
    expect(losers.note).toContain("정리매매 제외");
    const gainers = await svc.rank("KR", "gainers", 1, 50);
    expect(gainers.items.map((i) => i.code)).toEqual(["0010S0", "000021", "000020"]);
    expect(gainers.items[0]!.newlyListed).toBe(true);
    // 장 시작 전처럼 빈 목록이 오면 직전 목록
    empty = true;
    now = new Date(now.getTime() + 10 * 60_000);
    expect((await svc.rank("KR", "gainers", 1, 50)).items).toHaveLength(3);
  });

  it("조회가 실패하면 직전 목록을 주고, 직전 값이 없으면 던진다", async () => {
    let fail = false;
    let now = new Date("2026-09-23T05:00:00Z");
    const fetchFn = (async (url: string) => {
      if (fail) return json({}, 503);
      if (url.includes("sortType=priceTop")) return ok({ items: [krRow("005930", "삼성전자", 2.9, 6.6e12)], hasNext: false });
      if (url.includes("sortType=quantTop")) return json({}, 500);
      return json({}, 404);
    }) as unknown as typeof fetch;
    const calendar = { status: async () => ({ KR: { isOpen: true, isTradingDay: true }, US: { isOpen: false } }) } as never;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now, calendar });
    expect((await svc.rank("KR", "tradingValue", 1, 50)).items.map((i) => i.name)).toEqual(["삼성전자"]);
    await expect(svc.rank("KR", "volume", 1, 50)).rejects.toThrow("HTTP 500");
    fail = true;
    now = new Date(now.getTime() + 10 * 60_000);
    const stale = await svc.rank("KR", "tradingValue", 1, 50);
    expect(stale.items.map((i) => i.name)).toEqual(["삼성전자"]);
    expect(stale.asOf).toBe("2026-09-23T14:00:00+09:00"); // 직전 값의 시각
  });

  it("테마 목록은 cursor 로 끝까지 받고, 상장 첫날 종목이 든 테마는 그 종목을 빼고 다시 센다", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      if (!url.includes("/marketStatus")) urls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/stock/sectors/all")) {
        expect(u.searchParams.get("businessDayCategory")).toBe("daily");
        if (!u.searchParams.get("cursor"))
          return ok({
            sectors: [
              { code: "615", name: "신규상장", changeRate: 60, risingCount: 2, unchangedCount: 0, fallingCount: 1, topItems: [{ code: "0010S0", name: "새내기" }, { code: "000001", name: "가" }] },
              { code: "110", name: "화장품", changeRate: 1.5, risingCount: 10, unchangedCount: 1, fallingCount: 4, topItems: [{ code: "000002", name: "나" }] },
            ],
            hasNext: true,
            cursor: "MTEw",
          });
        return ok({ sectors: [{ code: "110", name: "화장품(중복)", changeRate: 1.5 }, { code: "300", name: "원자력", changeRate: -2, risingCount: 0, unchangedCount: 0, fallingCount: 5, topItems: [] }], hasNext: false });
      }
      if (u.pathname.endsWith("/domestic/stock/list/sorted") && u.searchParams.get("sortType") === "newStock")
        return ok({ items: [krRow("0010S0", "새내기", 288, 9e11, { newlyListed: true }), krRow("0240J0", "RISE ETF", 1, 1e9, { newlyListed: false })], hasNext: true });
      if (u.pathname.endsWith("/domestic/sector/item/list"))
        return ok({
          sectorInfo: { sectorName: "신규상장", sectorDescription: "새로 상장한 종목", changeRate: 60 },
          items: [
            krRow("0010S0", "새내기", 288, 9e11),
            krRow("000001", "가", 2, 1e9),
            krRow("000003", "다", -1, 1e9),
            krRow("000004", "정지", 0, 0, { accumulatedTradingVolume: 0 }),
          ],
          hasNext: false,
        });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn) });
    const list = await svc.themes("KR", "theme", "day");
    expect(list.themes.map((t) => t.id)).toEqual(["615", "110", "300"]);
    expect(list.themes[1]!.name).toBe("화장품"); // 중복은 처음 것
    expect(list.themes[0]).toMatchObject({ changeRate: 0.5, up: 1, flat: 0, down: 1, adjusted: true }); // (2 + -1)/2, 정지 제외
    expect(list.themes[0]!.leaders.map((l) => l.code)).toEqual(["000001", "000003"]);
    expect(list.themes[1]).toMatchObject({ changeRate: 1.5, up: 10, flat: 1, down: 4 });
    expect(list.themes[1]!.adjusted).toBeUndefined();
    const detail = await svc.theme("KR", "theme", "615");
    expect(detail).toMatchObject({ description: "새로 상장한 종목", theme: { name: "신규상장", changeRate: 0.5, adjusted: true } });
    expect(detail!.items).toHaveLength(4); // 목록에는 모두 보여 준다 (평균만 조정)
    // 주·월은 네이버 값 그대로
    const week = new DiscoverService({
      naver: new NaverDiscover((async (url: string) =>
        url.includes("/stock/sectors/all") ? ok({ sectors: [{ code: "615", name: "신규상장", changeRate: 60, risingCount: 2, unchangedCount: 0, fallingCount: 1, topItems: [{ code: "0010S0", name: "새내기" }] }], hasNext: false }) : json({}, 404)) as unknown as typeof fetch),
    });
    expect((await week.themes("KR", "theme", "week")).themes[0]!.changeRate).toBe(60);
  });

  it("모르는 테마 코드는 null (라우트에서 404)", async () => {
    const fetchFn = (async () => json({ isSuccess: false, detailCode: "RESOURCE_NOT_FOUND" }, 404)) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn) });
    expect(await svc.theme("KR", "theme", "99999")).toBeNull();
  });

  it("미국 순위: 정규장 값, 권리주·우선주·워런트·SPAC 권리·거래정지·지난 날짜 줄 제외, 클래스주는 BRK.B", async () => {
    const usRow = (sym: string, eng: string, rate: number, tv: number, extra: Record<string, unknown> = {}) => ({
      stockEndType: "stock",
      symbolCode: sym,
      reutersCode: `${sym}.O`,
      stockName: eng === "-" ? null : `한글 ${sym}`,
      stockNameEng: eng,
      stockExchangeType: { name: "NASDAQ" },
      closePriceRaw: "10.5",
      compareToPreviousClosePriceRaw: "1.25",
      fluctuationsRatioRaw: String(rate),
      accumulatedTradingVolumeRaw: "1000",
      accumulatedTradingValueRaw: String(tv),
      marketValueRaw: "5000000000",
      localTradedAt: "2026-09-22T16:00:00-04:00",
      tradeStopType: { name: "TRADING" },
      overMarketPriceInfo: { overPrice: "99" }, // 애프터마켓 값은 쓰지 않는다
      ...extra,
    });
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      if (!url.includes("/marketStatus")) urls.push(url);
      return json({
        page: 1,
        totalCount: 150,
        marketStatus: "CLOSE",
        stocks: [
          usRow("JAGX", "Jaguar Health Inc", 1190.64, 6.6e8),
          usRow("RIV RT", "RiverNorth Opportunities Rights", 900, 5e6),
          usRow("KLXER", "KLX Energy Services Holdings Rights", 800, 5e6),
          usRow("AHT PRD", "Ashford Pref D", 700, 5e6),
          usRow("ASGI RTWI", "Abrdn Rights When Issued", 600, 5e6),
          usRow("CAPNU", "Cayson Acquisition Corp Units", 500, 5e6),
          usRow("OLD", "Halted Co", 400, 5e6, { tradeStopType: { name: "HALTED" } }),
          usRow("STALE", "Stale Co", 300, 5e6, { localTradedAt: "2025-01-02T16:00:00-05:00" }),
          usRow("PENNY", "Penny Co", 200, 9e5),
          usRow("BRK B", "Berkshire Hathaway Class B", 100, 3e9),
          usRow("NONAME", "-", 50, 2e6),
        ],
      });
    }) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), usdKrw: async () => 1380 });
    const r = await svc.rank("US", "gainers", 1, 50);
    expect(urls[0]).toContain("api.stock.naver.com/stock/nation/USA/up?page=1&pageSize=100");
    expect(r.items.map((i) => i.code)).toEqual(["JAGX", "BRK.B", "NONAME"]);
    expect(r.items[0]).toMatchObject({ name: "한글 JAGX", market: "NASDAQ", currency: "USD", price: 10.5, change: 1.25, changeRate: 1190.64, tradingValue: 6.6e8 });
    expect(r.items[2]!.name).toBe("-"); // 한글명이 없으면 영문명
    expect(r).toMatchObject({ fxRate: 1380, source: "네이버 증권", hasMore: false }); // 150개 = 2쪽을 다 받아도 3개뿐
    expect(r.note).toContain("ETF·우선주·채권·권리주 제외");
    expect(r.asOf).toBe("2026-09-23T05:00:00+09:00"); // 정규장 종료(16:00 ET) 시각
    expect(r.note).toContain("100만 달러");
    // 거래량 순위는 top 경로, 동전주도 남긴다
    await svc.rank("US", "volume", 1, 50);
    expect(urls.some((u) => u.includes("/stock/nation/USA/top?page=1"))).toBe(true);
    expect((await svc.rank("US", "volume", 1, 50)).items.map((i) => i.code)).toContain("PENNY");
  });

  it("미국은 정규장(뉴욕 09:30~16:00)만 장중 — 달력이 프리·애프터를 열림으로 봐도 장 마감", async () => {
    expect(isUsRegularHours(new Date("2026-09-22T13:29:00Z"))).toBe(false); // 09:29 EDT (프리마켓)
    expect(isUsRegularHours(new Date("2026-09-22T13:30:00Z"))).toBe(true); // 09:30 EDT
    expect(isUsRegularHours(new Date("2026-09-22T19:59:00Z"))).toBe(true); // 15:59 EDT
    expect(isUsRegularHours(new Date("2026-09-22T20:00:00Z"))).toBe(false); // 16:00 EDT (애프터마켓)
    expect(isUsRegularHours(new Date("2026-12-01T14:45:00Z"))).toBe(true); // 09:45 EST
    expect(isUsRegularHours(new Date("2026-09-26T15:00:00Z"))).toBe(false); // 토요일
    let now = new Date("2026-09-22T12:00:00Z"); // 08:00 EDT, 프리마켓
    const calendar = { status: async () => ({ KR: { isOpen: false }, US: { isOpen: true } }) } as never;
    const fetchFn = (async () => json({ page: 1, totalCount: 0, stocks: [] })) as unknown as typeof fetch;
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), calendar, now: () => now });
    expect((await svc.rank("US", "tradingValue", 1, 50)).marketOpen).toBe(false);
    now = new Date("2026-09-22T15:00:00Z"); // 11:00 EDT
    expect((await svc.rank("US", "volume", 1, 50)).marketOpen).toBe(true);
  });

  it("recount: 거래정지·상장 첫날을 빼고 평균·상승/보합/하락을 다시 센다", () => {
    const base = { id: "1", name: "t", changeRate: 9, up: 0, flat: 0, down: 0, leaders: [] };
    const s = (code: string, changeRate: number, volume = 10) => ({ code, name: code, market: "KOSPI", currency: "KRW" as const, price: 1, change: 0, changeRate, volume, tradingValue: 1 });
    const r = recount(base, [s("A", 3), s("B", 0), s("C", -1), s("N", 100), s("H", 0, 0)], new Set(["N"]));
    expect(r).toMatchObject({ changeRate: 0.67, up: 1, flat: 1, down: 1, adjusted: true });
  });
});

describe("GET /api/discover", () => {
  it("값 검사 400, 모르는 테마 404, 출처 실패 502, 정상 200", async () => {
    const { buildApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config.js");
    const { createMigratedDb } = await import("../src/db/index.js");
    const { fakeProviders } = await import("./helpers.js");
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/domestic/stock/list/sorted") && u.searchParams.get("sortType") === "priceTop")
        return ok({ items: [krRow("005930", "삼성전자", 2.9, 6.6e12)], hasNext: false });
      if (u.pathname.endsWith("/domestic/sector/item/list")) return json({ isSuccess: false }, 404);
      return json({}, 500);
    }) as unknown as typeof fetch;
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ discover: new NaverDiscover(fetchFn) }),
      logger: false,
      enableScheduler: false,
    });
    try {
      const okRes = await app.inject({ method: "GET", url: "/api/discover/KR/rank/tradingValue?page=1&size=50" });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json()).toMatchObject({ market: "KR", category: "tradingValue", page: 1, hasMore: false, source: "네이버 증권" });
      expect(okRes.json().items[0]).toMatchObject({ code: "005930", name: "삼성전자" });
      expect((await app.inject({ method: "GET", url: "/api/discover/JP/rank/tradingValue" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/discover/KR/rank/popular" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/discover/KR/rank/volume?size=500" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/discover/KR/themes?period=year" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/discover/KR/themes/a%20b" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/discover/KR/themes/99999" })).statusCode).toBe(404);
      const bad = await app.inject({ method: "GET", url: "/api/discover/KR/rank/volume" });
      expect(bad.statusCode).toBe(502);
      expect(bad.json().error ?? bad.json().message).toBeTruthy();
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
