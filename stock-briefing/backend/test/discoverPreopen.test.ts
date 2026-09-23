import { describe, expect, it } from "vitest";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { TossTics } from "../src/providers/market/tossTics.js";
import { DiscoverService } from "../src/services/discoverService.js";
import { UsThemeBook } from "../src/services/usThemes.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const memStore = () => {
  const m = new Map<string, string>();
  return { m, store: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) } };
};
const usRow = (sym: string, rate: number, tv: number) => ({
  stockEndType: "stock",
  symbolCode: sym,
  reutersCode: `${sym}.O`,
  stockName: `한글 ${sym}`,
  stockNameEng: `${sym} Inc`,
  stockExchangeType: { name: "NASDAQ" },
  closePriceRaw: "10",
  compareToPreviousClosePriceRaw: "0.1",
  fluctuationsRatioRaw: String(rate),
  accumulatedTradingVolumeRaw: "1000",
  accumulatedTradingValueRaw: String(tv),
  marketValueRaw: "5000000000",
  localTradedAt: "2026-09-22T16:00:00-04:00",
  tradeStopType: { name: "TRADING" },
});

describe("장 시작 전 초기화 — 직전 정규장 저장본", () => {
  it("미국 순위: 네이버가 PREOPEN 으로 비우면 서버를 다시 켠 뒤에도 저장본(직전 정규장)을 보여 준다", async () => {
    let preopen = false;
    const fetchFn = (async () =>
      preopen
        ? json({ page: 1, totalCount: 0, marketStatus: "PREOPEN", stocks: [] })
        : json({ page: 1, totalCount: 2, marketStatus: "CLOSE", stocks: [usRow("MU", 5, 3e10), usRow("NVDA", 0.6, 2e10)] })) as unknown as typeof fetch;
    const { store } = memStore();
    let now = new Date("2026-09-22T21:00:00Z"); // 정규장 마감 뒤 (한국 06:00)
    const a = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    expect((await a.rank("US", "tradingValue", 1, 50)).items.map((i) => i.code)).toEqual(["MU", "NVDA"]);
    // 한국 16:40 — 네이버 초기화, 서버 재시작(메모리 없음)
    preopen = true;
    now = new Date("2026-09-23T07:40:00Z");
    const b = new DiscoverService({ naver: new NaverDiscover(fetchFn), store, now: () => now });
    const r = await b.rank("US", "tradingValue", 1, 50);
    expect(r.items.map((i) => i.code)).toEqual(["MU", "NVDA"]);
    expect(r).toMatchObject({ marketOpen: false, hasMore: false, asOf: "2026-09-23T05:00:00+09:00" });
    // 저장본도 없으면 빈 목록과 안내
    const c = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    const empty = await c.rank("US", "gainers", 1, 50);
    expect(empty.items).toEqual([]);
    expect(empty.note).toContain("출처가 잠시 목록을 비웠습니다");
  });

  it("같은 서버에서는 초기화된 빈 목록이 와도 가진 직전 목록을 유지한다 (한국 장 시작 전 0% 목록 포함)", async () => {
    let reset = false;
    const krRow = (code: string, rate: number, vol: number) => ({ itemCode: code, name: code, stockEndType: "stock", marketType: "KOSPI", currentPrice: 1000, fluctuations: "0", fluctuationsRatio: String(rate), accumulatedTradingVolume: vol, accumulatedTradingValue: vol * 1000, marketValue: 1e12 });
    const fetchFn = (async () =>
      json({ isSuccess: true, result: { items: reset ? [krRow("000001", 0, 0), krRow("000002", 0, 0)] : [krRow("000001", 3, 5e6), krRow("000002", 2, 4e6)], hasNext: false } })) as unknown as typeof fetch;
    let now = new Date("2026-09-22T07:00:00Z");
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => now });
    expect((await svc.rank("KR", "volume", 1, 50)).items[0]!.changeRate).toBe(3);
    reset = true;
    now = new Date("2026-09-22T23:10:00Z"); // 다음날 08:10 (NXT 프리마켓, KRX 초기화)
    const r = await svc.rank("KR", "volume", 1, 50);
    expect(r.items.map((i) => i.changeRate)).toEqual([3, 2]);
  });

  it("미국 테마: 시세가 PREOPEN(0%)이면 직전 정규장 시세 저장본으로 계산하고, 저장본이 없으면 산업 분류로 대신한다", async () => {
    let preopen = false;
    const members = ["P_A", "P_B", "P_C"];
    const fetchFn = (async (url: string) => {
      const u = new URL(url);
      if (u.host.includes("tossinvest")) {
        if (u.pathname.endsWith("/tics/ranking")) return json({ result: { tics: [{ ticsId: 5, name: "양자", fluctuationRate: 0.05 }] } });
        if (u.pathname.endsWith("/overview")) return json({ result: { ticsId: 5, name: "양자", relatedTics: [{ ticsId: 1, name: "IT", depth: 0, subItems: [{ ticsId: 5, name: "양자", depth: 1, subItems: [] }] }] } });
        if (u.pathname.endsWith("/stocks")) return json({ result: { totalCount: 3, stocks: members.map((c) => ({ code: c, name: c })) } });
        if (u.pathname.endsWith("/v1/stock-infos")) return json({ result: members.map((c) => ({ code: c, symbol: c.slice(2), market: { code: "NSQ" }, name: c, status: "N" })) });
      }
      if (u.host.includes("polling")) {
        const codes = decodeURIComponent(u.pathname.split("/").pop() ?? "").split(",").filter((c) => c.endsWith(".O"));
        return json({
          datas: codes.map((c, i) => ({
            reutersCode: c,
            symbolCode: c.replace(".O", ""),
            stockName: c,
            closePriceRaw: "10",
            compareToPreviousClosePriceRaw: preopen ? "0" : "1",
            fluctuationsRatioRaw: preopen ? "0.00" : String(i + 1),
            accumulatedTradingVolumeRaw: preopen ? "" : "100000",
            accumulatedTradingValueRaw: preopen ? "" : "900000",
            marketValueFullRaw: "1000",
            localTradedAt: preopen ? "2026-09-23T03:40:00-04:00" : "2026-09-22T16:00:00-04:00",
            marketStatus: preopen ? "PREOPEN" : "CLOSE",
            tradeStopType: { name: "TRADING" },
          })),
        });
      }
      if (u.pathname.endsWith("/stock/sectors/all")) return json({ isSuccess: true, result: { sectors: [{ code: "57201010", name: "IT 서비스", changeRate: -0.55, topItems: [] }], hasNext: false } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const { store } = memStore();
    let now = new Date("2026-09-22T21:00:00Z");
    const mk = () => new DiscoverService({ naver: new NaverDiscover(fetchFn), tics: new TossTics(fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(fetchFn, 0), naver: new NaverDiscover(fetchFn), now: () => now }), store, now: () => now });
    const good = await mk().themes("US", "theme", "day");
    expect(good.kind).toBe("theme");
    expect(good.themes[0]!.changeRate).toBe(1.99); // 전일 시총 가중 (시총 같아도 전일 시총은 등락률만큼 다름)
    // 한국 16:40: 네이버 초기화 + 서버 재시작
    preopen = true;
    now = new Date("2026-09-23T07:40:00Z");
    const later = await mk().themes("US", "theme", "day");
    expect(later.kind).toBe("theme");
    expect(later.themes[0]!.changeRate).toBe(1.99);
    expect(later.asOf).toBe("2026-09-23T05:00:00+09:00");
    // 저장본이 없으면 산업 분류로 대신
    const noSnap = new DiscoverService({ naver: new NaverDiscover(fetchFn), tics: new TossTics(fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(fetchFn, 0), naver: new NaverDiscover(fetchFn), now: () => now }), now: () => now });
    const alt = await noSnap.themes("US", "theme", "day");
    expect(alt.kind).toBe("sector");
    expect(alt.note).toContain("출처가 잠시 미국 시세를 비운 시간");
    // 초기화가 끝나면 바로(실패를 기억해 20초 막지 않고) 테마로 돌아온다
    preopen = false;
    expect((await noSnap.themes("US", "theme", "day")).kind).toBe("theme");
  });
});
