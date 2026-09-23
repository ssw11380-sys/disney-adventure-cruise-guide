import { describe, expect, it } from "vitest";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { DiscoverService } from "../src/services/discoverService.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const usRow = (sym: string, tv: number, at: string) => ({
  stockEndType: "stock",
  symbolCode: sym,
  reutersCode: `${sym}.O`,
  stockName: sym,
  stockNameEng: `${sym} Inc`,
  stockExchangeType: { name: "NASDAQ" },
  closePriceRaw: "10",
  compareToPreviousClosePriceRaw: "0.1",
  fluctuationsRatioRaw: "1",
  accumulatedTradingVolumeRaw: "1000",
  accumulatedTradingValueRaw: String(tv),
  marketValueRaw: "5000000000",
  localTradedAt: at,
  tradeStopType: { name: "TRADING" },
});

/**
 * 네이버 미국 순위(api.stock.naver.com) 실측 동작을 흉내 낸다 (2026-09-23 정규장):
 *  - 같은 쪽을 물어도 서버에 따라 수십 초 전 목록(묵은 쪽)이 온다 → 그 사이 쪽 경계를 넘은 종목이 두 쪽 어디에도 없다
 *  - 가끔 한 종목이 빠진 채 온다(뒤 줄이 한 칸씩 당겨짐)
 */
function source(opts: { stalePage1: number; dropFirstPage0: boolean }) {
  const FRESH = "2026-09-23T10:00:30-04:00";
  const STALE = "2026-09-23T09:59:50-04:00";
  const base = Array.from({ length: 300 }, (_, i) => `S${String(i).padStart(3, "0")}`);
  const fresh = [...base.slice(0, 150), "MOVER", ...base.slice(150)]; // 지금: MOVER 151위 (2쪽)
  const stale = [...base.slice(0, 250), "MOVER", ...base.slice(250)]; // 40초 전: 251위 (3쪽)
  const seen = new Map<number, number>();
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    if (!url.includes("/stock/nation/USA/")) return json({}, 404);
    urls.push(url);
    const index = Number(new URL(url).searchParams.get("page")) - 1;
    const n = (seen.get(index) ?? 0) + 1;
    seen.set(index, n);
    const isStale = index === 1 && n <= opts.stalePage1;
    let list = isStale ? stale : fresh;
    if (index === 0 && n === 1 && opts.dropFirstPage0) list = list.filter((s) => s !== "S040"); // 한 종목이 빠진 응답
    const at = isStale ? STALE : FRESH;
    const rows = list.slice(index * 100, index * 100 + 100).map((s) => usRow(s, 1e9 - fresh.indexOf(s) * 1e6, at));
    return json({ page: index + 1, pageSize: 100, totalCount: 301, marketStatus: "OPEN", stocks: rows });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

async function chain(svc: DiscoverService, pages: number) {
  const first = await svc.rank("US", "tradingValue", 1, 50);
  const codes = first.items.map((i) => i.code);
  for (let p = 2; p <= pages; p++) codes.push(...(await svc.rank("US", "tradingValue", p, 50, first.ver)).items.map((i) => i.code));
  return codes;
}

describe("미국 순위: 네이버 쪽마다 다른 시점·빠진 줄", () => {
  it("묵은 쪽은 다시 받고, 한 종목이 빠진 응답은 두 번째 벌로 메운다 — 목록에서 빠지거나 두 번 나오는 종목이 없다", async () => {
    const { fetchFn, urls } = source({ stalePage1: 2, dropFirstPage0: true });
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T14:00:35Z") });
    const codes = await chain(svc, 7);
    expect(codes).toContain("S040"); // 첫 벌에서 빠졌던 종목
    expect(codes).toContain("MOVER"); // 묵은 2쪽과 새 3쪽 사이에서 빠지던 종목
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toHaveLength(301);
    // 2쪽(index 1)은 두 벌 모두 묵어서 한 번 더(두 벌) 받았다
    expect(urls.filter((u) => u.includes("page=2&")).length).toBeGreaterThanOrEqual(4);
  });

  it("모든 쪽이 같은 시점이면 쪽마다 두 벌만 받는다 (다시 받지 않는다)", async () => {
    const { fetchFn, urls } = source({ stalePage1: 0, dropFirstPage0: false });
    const svc = new DiscoverService({ naver: new NaverDiscover(fetchFn), now: () => new Date("2026-09-23T14:00:35Z") });
    const p1 = await svc.rank("US", "tradingValue", 1, 50);
    expect(p1.items).toHaveLength(50);
    expect(urls).toHaveLength(6); // 3쪽 × 두 벌
  });
});
