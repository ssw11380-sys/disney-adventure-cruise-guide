import { describe, expect, it } from "vitest";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { reutersCandidates, TossTics } from "../src/providers/market/tossTics.js";
import { DiscoverService } from "../src/services/discoverService.js";
import { UsThemeBook, usThemeSummary } from "../src/services/usThemes.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 네이버 폴링 한 줄 (정규장 값) */
const poll = (reuters: string, sym: string, rate: number, cap: number, extra: Record<string, unknown> = {}) => ({
  reutersCode: reuters,
  symbolCode: sym,
  stockName: `한글 ${sym}`,
  stockNameEng: `${sym} Inc`,
  stockExchangeType: { name: reuters.endsWith(".O") ? "NASDAQ" : "NYSE" },
  closePriceRaw: "100",
  compareToPreviousClosePriceRaw: String(rate),
  fluctuationsRatioRaw: String(rate),
  accumulatedTradingVolumeRaw: "1000",
  accumulatedTradingValueRaw: "500000",
  marketValueFullRaw: String(cap),
  localTradedAt: "2026-09-22T16:00:00-04:00",
  tradeStopType: { name: "TRADING" },
  ...extra,
});

/** 토스 테마 3개(양자 956: 3종목, 작은 테마 777: 2종목, 분류 IT 87 = depth 0) + 네이버 시세 */
function world(opts: { failToss?: boolean } = {}) {
  const calls: string[] = [];
  const quotes: Record<string, ReturnType<typeof poll>> = {
    "IONQ.K": poll("IONQ.K", "IONQ", 10, 1_100), // 전일 1000
    "RGTI.O": poll("RGTI.O", "RGTI", -10, 900), // 전일 1000
    "QBTS.K": poll("QBTS.K", "QBTS", 0, 8_000),
    BRKb: poll("BRKb", "BRK B", 1, 1000),
    "OLD.O": poll("OLD.O", "OLD", 5, 100, { localTradedAt: "2025-01-02T16:00:00-05:00" }),
    // 거의 거래되지 않는 테마 888
    "TA.O": poll("TA.O", "TA", 40, 10, { accumulatedTradingValueRaw: "1000" }),
    "TB.O": poll("TB.O", "TB", 30, 10, { accumulatedTradingValueRaw: "1000" }),
    "TC.O": poll("TC.O", "TC", 20, 10, { accumulatedTradingValueRaw: "1000" }),
  };
  const productOf: Record<string, { symbol: string; market: string; spac?: boolean }> = {
    P_IONQ: { symbol: "IONQ", market: "NYS" },
    P_RGTI: { symbol: "RGTI", market: "NSQ" },
    P_QBTS: { symbol: "QBTS", market: "NYS" },
    P_BRK: { symbol: "BRK.B", market: "NYS" },
    P_OLD: { symbol: "OLD", market: "NSQ" },
    P_SPAC: { symbol: "SPCX", market: "NSQ", spac: true },
    P_TA: { symbol: "TA", market: "NSQ" },
    P_TB: { symbol: "TB", market: "NSQ" },
    P_TC: { symbol: "TC", market: "NSQ" },
  };
  const members: Record<string, string[]> = { "956": ["P_IONQ", "P_RGTI", "P_QBTS", "P_OLD", "P_SPAC"], "777": ["P_BRK", "P_IONQ"], "888": ["P_TA", "P_TB", "P_TC"] };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === "wts-info-api.tossinvest.com") {
      if (opts.failToss) return json({ error: { statusCode: 403 } }, 403);
      const p = u.pathname;
      if (p.endsWith("/tics/ranking")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.duration === "1m") return json({ result: { tics: [] } }); // 순위에 없는 경우
        if (body.duration === "1w")
          return json({ result: { tics: [{ ticsId: 956, name: "양자컴퓨터", fluctuationRate: 0.1296, stockCount: 3, leadingStock: { productCode: "P_IONQ", name: "아이온큐" } }] } });
        return json({ result: { tics: [{ ticsId: 956, name: "양자컴퓨터", fluctuationRate: 0.0567, stockCount: 3, leadingStock: null }] } });
      }
      const m = /tics\/(\d+)\/(overview|stocks|simple)$/.exec(p);
      if (m?.[2] === "overview")
        return json({
          result: {
            ticsId: Number(m[1]),
            name: "양자컴퓨터",
            summary: "양자컴퓨팅 하드웨어·소프트웨어",
            relatedTics: [{ ticsId: 87, name: "IT", depth: 0, subItems: [{ ticsId: 956, name: "양자컴퓨터", depth: 1, subItems: [] }, { ticsId: 777, name: "소형", depth: 2, subItems: [] }, { ticsId: 888, name: "동전주", depth: 1, subItems: [] }] }],
          },
        });
      if (m?.[2] === "stocks") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const all = (members[m[1]!] ?? ["P_IONQ", "P_RGTI", "P_QBTS", "P_BRK"]).map((c) => ({ code: c, name: c, marketCapUsd: 1 }));
        return json({ result: { totalCount: m[1] === "956" ? 12 : all.length, stocks: all.slice((body.page - 1) * 10, body.page * 10) } });
      }
      if (m?.[2] === "simple") return json({ result: { ticsId: Number(m[1]), duration: u.searchParams.get("duration"), changeRate: u.searchParams.get("nation") === "US" ? -3.21 : 99 } });
      if (p.endsWith("/v1/stock-infos")) {
        const codes = (u.searchParams.get("codes") ?? "").split(",");
        return json({ result: codes.filter((c) => productOf[c]).map((c) => ({ code: c, symbol: productOf[c]!.symbol, market: { code: productOf[c]!.market }, name: c, status: "N", spac: productOf[c]!.spac ?? false })) });
      }
      return json({}, 404);
    }
    if (u.host === "polling.finance.naver.com") {
      const codes = decodeURIComponent(u.pathname.split("/").pop() ?? "").split(",");
      return json({ pollingInterval: 70000, datas: codes.filter((c) => quotes[c]).map((c) => quotes[c]) });
    }
    if (u.pathname.endsWith("/stock/sectors/all"))
      return json({ isSuccess: true, result: { sectors: [{ code: "57201010", name: "IT 서비스", changeRate: -0.55, risingCount: 1, unchangedCount: 0, fallingCount: 2, topItems: [] }], hasNext: false } });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { calls, fetchFn, quotes };
}

describe("미국 테마 (토스 테마 분류 + 네이버 정규장 시세)", () => {
  it("로이터 코드 후보: 나스닥 .O, 뉴욕 접미사 없음/.K, 클래스주 BRKb", () => {
    expect(reutersCandidates("AAPL", "NSQ")[0]).toBe("AAPL.O");
    expect(reutersCandidates("IONQ", "NYS")).toEqual(["IONQ", "IONQ.K", "IONQ.N"]);
    expect(reutersCandidates("BRK.B", "NYS")[0]).toBe("BRKb");
    expect(reutersCandidates("BAD SYM", "NYS")).toEqual([]);
  });

  it("테마북: 분류 트리 → 구성 종목(3쪽까지) → 티커 → 네이버 코드. 스팩·지난 날짜·작은 테마를 거르고 저장한다", async () => {
    const w = world();
    const saved = new Map<string, string>();
    const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: string) => void saved.set(k, v) };
    const book = new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn), store, now: () => new Date("2026-09-23T06:00:00Z") });
    const d = await book.get();
    expect(d.themes.map((t) => t.id)).toEqual(["956", "888"]); // 777 은 2종목뿐, 87 은 가장 큰 분류라 뺀다
    const q = d.themes[0]!;
    expect(q.total).toBe(12);
    expect(q.members.map((m) => `${m.symbol}:${m.reuters}`)).toEqual(["IONQ:IONQ.K", "RGTI:RGTI.O", "QBTS:QBTS.K", "OLD:OLD.O"]); // 스팩 제외
    expect(w.calls.filter((c) => c.includes("/tics/956/stocks")).length).toBe(2); // 12종목 = 2쪽
    expect(saved.get("discover:us-tics:v1")).toContain("IONQ.K");
    // 저장본이 있으면 다시 만들지 않는다
    const w2 = world({ failToss: true });
    const again = new UsThemeBook({ tics: new TossTics(w2.fetchFn, 0), naver: new NaverDiscover(w2.fetchFn), store, now: () => new Date("2026-09-23T07:00:00Z") });
    expect((await again.get()).themes[0]!.id).toBe("956");
    expect(w2.calls).toHaveLength(0);
  });

  it("오늘 등락률: 전일 시가총액 가중 평균(정규장), 단순 평균은 참고, 지난 날짜 종목 제외", async () => {
    const w = world();
    const svc = new DiscoverService({
      naver: new NaverDiscover(w.fetchFn),
      tics: new TossTics(w.fetchFn, 0),
      usThemes: new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn) }),
      usdKrw: async () => 1390,
    });
    const list = await svc.themes("US", "theme", "day");
    expect(list).toMatchObject({ market: "US", kind: "theme", period: "day", note: "거래대금 100만 달러 미만 테마 1개 제외" });
    expect(list.themes.map((t) => t.id)).toEqual(["956"]); // 888(동전주 테마)은 거래대금이 3천 달러라 뺀다
    expect(list.asOf).toBe("2026-09-23T05:00:00+09:00"); // 정규장 종료 시각
    const q = list.themes[0]!;
    // 전일 시총: IONQ 1000, RGTI 1000, QBTS 8000 → (10·1000 − 10·1000 + 0·8000) / 10000 = 0
    expect(q).toMatchObject({ id: "956", name: "양자컴퓨터", changeRate: 0, simpleAvg: 0, up: 1, flat: 1, down: 1 });
    expect(q.leaders.map((l) => l.code)).toEqual(["IONQ", "QBTS", "RGTI"]);
    const detail = await svc.theme("US", "theme", "956");
    expect(detail).toMatchObject({ description: "양자컴퓨팅 하드웨어·소프트웨어", fxRate: 1390, note: "시가총액 상위 4종목 기준 (토스 분류 전체 12종목)" });
    expect(detail!.items.map((i) => i.code)).toEqual(["IONQ", "RGTI", "QBTS"]); // OLD 는 지난 날짜
    expect(await svc.theme("US", "theme", "123")).toBeNull();
  });

  it("1주·1개월: 토스 순위 값, 순위에 없는 테마는 미국 종목 기준으로 하나씩 묻는다", async () => {
    const w = world();
    const mk = () =>
      new DiscoverService({ naver: new NaverDiscover(w.fetchFn), tics: new TossTics(w.fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn) }) });
    const week = await mk().themes("US", "theme", "week");
    expect(week.themes.map((t) => t.id)).toEqual(["956"]); // 오늘 목록과 같은 테마만
    expect(week.themes[0]).toMatchObject({ id: "956", changeRate: 12.96, up: 0, down: 0 });
    expect(week.themes[0]!.leaders).toEqual([{ code: "IONQ", name: "아이온큐", changeRate: null }]);
    expect(week.note).toBeNull();
    expect(w.calls.some((c) => c.includes("/simple"))).toBe(false); // 순위에 있으면 하나씩 묻지 않는다
    // 1개월 순위에 없으면 테마마다 미국 종목 기준(nation=US)으로 묻는다
    const month = await mk().themes("US", "theme", "month");
    expect(month.themes[0]).toMatchObject({ id: "956", changeRate: -3.21, leaders: [] });
    expect(w.calls.find((c) => c.includes("/tics/956/simple"))).toContain("nation=US&duration=1m");
  });

  it("토스가 막히면 네이버 산업 분류로 대신 보여 주고 안내한다", async () => {
    const w = world({ failToss: true });
    const svc = new DiscoverService({ naver: new NaverDiscover(w.fetchFn), tics: new TossTics(w.fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn) }) });
    const list = await svc.themes("US", "theme", "day");
    expect(list.kind).toBe("sector");
    expect(list.themes[0]!.name).toBe("IT 서비스");
    expect(list.note).toContain("산업 분류로 대신");
  });

  it("처음 만드는 중이면 오래 기다리지 않고 산업 분류로 대신 보여 준다", async () => {
    const w = world();
    const slow = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("tossinvest")) await new Promise((r) => setTimeout(r, 200));
      return w.fetchFn(url, init);
    }) as unknown as typeof fetch;
    const book = new UsThemeBook({ tics: new TossTics(slow, 0), naver: new NaverDiscover(w.fetchFn) });
    await expect(book.get(20)).rejects.toThrow("처음 준비하는 중");
    const svc = new DiscoverService({ naver: new NaverDiscover(w.fetchFn), tics: new TossTics(slow, 0), usThemes: book, bookWaitMs: 20 });
    const list = await svc.themes("US", "theme", "day");
    expect(list.kind).toBe("sector");
    expect(list.note).toContain("처음 준비하는 중");
    // 다 만들어지면 테마로
    expect((await book.get()).themes[0]!.id).toBe("956");
    expect((await svc.themes("US", "theme", "day")).kind).toBe("theme");
  });

  it("usThemeSummary: 시가총액이 없으면 단순 평균, 거래 없는 종목 제외", () => {
    const th = { id: "1", name: "t", root: "", depth: 1, total: 3, members: [{ productCode: "a", symbol: "A", reuters: "A.O" }, { productCode: "b", symbol: "B", reuters: "B.O" }, { productCode: "c", symbol: "C", reuters: "C.O" }] };
    const s = (code: string, changeRate: number, volume: number) => ({ code, name: code, market: "NASDAQ", currency: "USD" as const, price: 1, change: 0, changeRate, volume, tradingValue: 1, marketCap: null, tradedAt: "2026-09-22T16:00:00-04:00" });
    const q = new Map([["A.O", s("A", 3, 10)], ["B.O", s("B", -1, 10)], ["C.O", s("C", 50, 0)]]);
    const r = usThemeSummary(th, q, "2026-09-22")!;
    expect(r.summary).toMatchObject({ changeRate: 1, simpleAvg: 1, up: 1, down: 1, flat: 0 });
    expect(r.items).toHaveLength(3); // 목록에는 보여 주되 평균에서만 뺀다
  });
});
