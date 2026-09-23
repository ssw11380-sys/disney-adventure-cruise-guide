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
  return { calls, fetchFn, quotes, members };
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
    expect(book.builtAt).toBe(Date.parse("2026-09-23T06:00:00Z"));
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
    expect(list.updatedAt).toMatch(/\+09:00$/); // 테마 구성 갱신 시각
    const q = list.themes[0]!;
    // 전일 시총: IONQ 1000, RGTI 1000, QBTS 8000 → (10·1000 − 10·1000 + 0·8000) / 10000 = 0
    expect(q).toMatchObject({ id: "956", name: "양자컴퓨터", changeRate: 0, simpleAvg: 0, up: 1, flat: 1, down: 1 });
    expect(q.leaders.map((l) => l.code)).toEqual(["IONQ", "QBTS", "RGTI"]);
    const detail = await svc.theme("US", "theme", "956");
    expect(detail).toMatchObject({ description: "양자컴퓨팅 하드웨어·소프트웨어", fxRate: 1390, note: "시가총액 상위 4종목 기준 (토스 분류 전체 12종목)" });
    expect(detail!.items.map((i) => i.code)).toEqual(["IONQ", "RGTI", "QBTS"]); // OLD 는 지난 날짜
    expect(await svc.theme("US", "theme", "123")).toBeNull();
  });

  it("정기 갱신(refresh)은 신선해도 새로 만들어 새 테마·새 편입 종목을 반영하고, 실패하면 옛것을 둔다", async () => {
    const w = world();
    let t = new Date("2026-09-23T06:00:00Z");
    const saved = new Map<string, string>();
    const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: string) => void saved.set(k, v) };
    let fail = false;
    const fetchFn = (async (url: string, init?: RequestInit) => (fail && String(url).includes("tossinvest") ? json({}, 503) : w.fetchFn(url, init))) as unknown as typeof fetch;
    const book = new UsThemeBook({ tics: new TossTics(fetchFn, 0), naver: new NaverDiscover(fetchFn), store, now: () => t });
    expect((await book.get()).themes[0]!.members.map((m) => m.symbol)).not.toContain("BRK.B");
    // 토스가 양자컴퓨터 테마에 BRK.B 를 새로 넣었다 (한 시간 뒤 = 아직 신선)
    w.members["956"] = [...w.members["956"]!, "P_BRK"];
    t = new Date("2026-09-23T07:00:00Z");
    const before = w.calls.length;
    expect((await book.get()).themes[0]!.members.map((m) => m.symbol)).not.toContain("BRK.B");
    expect(w.calls.length).toBe(before); // 신선하면 get 은 다시 만들지 않는다
    await book.refresh(); // 매일 21:00 정기 갱신
    expect((await book.get()).themes[0]!.members.map((m) => m.symbol)).toContain("BRK.B");
    expect(book.builtAt).toBe(Date.parse("2026-09-23T07:00:00Z"));
    expect(saved.get("discover:us-tics:v1")).toContain("BRKb");
    // 실패하면 옛것 유지
    fail = true;
    t = new Date("2026-09-23T12:00:00Z");
    await book.refresh();
    expect(book.builtAt).toBe(Date.parse("2026-09-23T07:00:00Z"));
    expect((await book.get()).themes[0]!.members.map((m) => m.symbol)).toContain("BRK.B");
  });

  it("1주·1개월: 토스 순위 값, 순위에 없는 테마는 미국 종목 기준으로 하나씩 묻는다", async () => {
    const w = world();
    const mk = () =>
      new DiscoverService({ naver: new NaverDiscover(w.fetchFn), tics: new TossTics(w.fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn) }) });
    const week = await mk().themes("US", "theme", "week");
    expect(week.themes.map((t) => t.id)).toEqual(["956"]); // 오늘 목록과 같은 테마만
    expect(week.themes[0]).toMatchObject({ id: "956", changeRate: 12.96, up: 0, down: 0 });
    // 대표 종목은 구성 종목의 시가총액 상위 3 (기간 등락률은 없어 null)
    expect(week.themes[0]!.leaders).toEqual([
      { code: "QBTS", name: "한글 QBTS", changeRate: null },
      { code: "IONQ", name: "한글 IONQ", changeRate: null },
      { code: "RGTI", name: "한글 RGTI", changeRate: null },
    ]);
    expect(week.note).toContain("상승·하락 종목 수 없이");
    expect(week.note).toContain("주간·프리·애프터 가격이 섞일 수 있음"); // 정규장 중 스냅숏이 없으면 그렇다고 밝힌다
    expect(week.note).toContain("1주는 상승·하락");
    expect(week.live).toBe(true);
    expect(w.calls.some((c) => c.includes("/simple"))).toBe(false); // 순위에 있으면 하나씩 묻지 않는다
    // 1개월 순위에 없으면 테마마다 미국 종목 기준(nation=US)으로 묻는다
    const month = await mk().themes("US", "theme", "month");
    expect(month.themes[0]).toMatchObject({ id: "956", changeRate: -3.21 });
    expect(month.themes[0]!.leaders).toHaveLength(3);
    expect(w.calls.find((c) => c.includes("/tics/956/simple"))).toContain("nation=US&duration=1m");
  });

  it("1주·1개월은 미국 정규장 중에 받은 값을 남겨 두고, 장 밖(한국 낮)에는 그 값을 쓴다 (토스 장외 가격이 섞이지 않게)", async () => {
    const w = world();
    const saved = new Map<string, string>();
    const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: string) => void saved.set(k, v) };
    let now = new Date("2026-09-22T15:00:00Z"); // 뉴욕 11:00 정규장
    const calendar = { status: async () => ({ KR: { isOpen: false, isTradingDay: true }, US: { isOpen: true, isTradingDay: true } }) } as never;
    const mk = () =>
      new DiscoverService({ naver: new NaverDiscover(w.fetchFn), tics: new TossTics(w.fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn), now: () => now }), calendar, store, now: () => now });
    const inSession = await mk().themes("US", "theme", "week");
    expect(inSession.marketOpen).toBe(true);
    expect(inSession.themes[0]!.changeRate).toBe(12.96);
    expect(inSession.note).not.toContain("주간·프리·애프터");
    expect(saved.get("discover:us-tics-period:week")).toContain("12.96");
    // 한국 낮(뉴욕 새벽): 토스가 주간거래 가격으로 바뀌었더라도 정규장 중 값을 쓴다
    now = new Date("2026-09-23T06:00:00Z");
    const before = w.calls.filter((c) => c.includes("/tics/ranking")).length;
    const later = await mk().themes("US", "theme", "week"); // 새 서비스(재시작) → 저장본에서
    expect(later.marketOpen).toBe(false);
    expect(later.themes[0]!.changeRate).toBe(12.96);
    expect(later.note).toContain("직전 정규장 중");
    expect(later.asOf).toBe("2026-09-23T00:00:00+09:00"); // 받은 시각 = 정규장 중
    expect(w.calls.filter((c) => c.includes("/tics/ranking")).length).toBe(before);
  });

  it("며칠 지난 정규장 값은 '직전 정규장'으로 쓰지 않고 지금 값을 받아 밝힌다 · 뉴욕 15:50 에 미리 받아 둔다", async () => {
    const w = world();
    const saved = new Map<string, string>();
    const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: string) => void saved.set(k, v) };
    let now = new Date("2026-09-18T19:50:00Z"); // 금 뉴욕 15:50 정규장
    let us = { isOpen: true, isTradingDay: true, lastClose: null as string | null };
    const calendar = { status: async () => ({ KR: { isOpen: false, isTradingDay: true }, US: us }) } as never;
    const mk = () =>
      new DiscoverService({ naver: new NaverDiscover(w.fetchFn), tics: new TossTics(w.fetchFn, 0), usThemes: new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn), now: () => now }), calendar, store, now: () => now });
    expect(await mk().captureUsPeriods()).toBe(2); // 1주·1개월
    expect(saved.get("discover:us-tics-period:month")).toContain('"inSession":true');
    // 다음 화요일 한국 낮: 금요일 값은 가장 최근 정규장(월) 값이 아니다 → 지금 값 + 안내
    now = new Date("2026-09-22T06:00:00Z");
    us = { isOpen: false, isTradingDay: true, lastClose: "2026-09-21T20:00:00.000Z" };
    const stale = await mk().themes("US", "theme", "week");
    expect(stale.live).toBe(true);
    expect(stale.note).toContain("주간·프리·애프터");
    // 주말(한국 토·일 낮)에는 금요일 값이 가장 최근 정규장 값 — 오늘이 아니면 날짜를 붙인다
    now = new Date("2026-09-19T06:00:00Z");
    us = { isOpen: false, isTradingDay: false, lastClose: "2026-09-18T20:00:00.000Z" };
    const kept = await mk().themes("US", "theme", "week");
    expect(kept.live).toBeUndefined();
    expect(kept.note).toContain("직전 정규장 중 04:50 값");
    now = new Date("2026-09-20T06:00:00Z");
    expect((await mk().themes("US", "theme", "week")).note).toContain("직전 정규장 중 9/19 04:50 값");
    // 정규장이 아니면 받아 두지 않는다
    expect(await mk().captureUsPeriods()).toBe(0);
  });

  it("테마북 안전장치: 쓸 수 있는 옛것이 있을 때만 크게 줄어든 결과를 거르고, 두 번 이어서 같은 크기면 받아들인다", async () => {
    const w = world();
    let t = new Date("2026-09-23T06:00:00Z");
    const saved = new Map<string, string>();
    const store = { get: async (k: string) => saved.get(k) ?? null, set: async (k: string, v: string) => void saved.set(k, v) };
    const book = new UsThemeBook({ tics: new TossTics(w.fetchFn, 0), naver: new NaverDiscover(w.fetchFn), store, now: () => t });
    expect((await book.get()).themes).toHaveLength(2);
    w.members["888"] = []; // 토스가 테마 하나를 없앴다 → 2개 → 1개 (50%)
    t = new Date("2026-09-24T12:00:00Z");
    await book.refresh();
    expect((await book.get()).themes).toHaveLength(2); // 한 번은 일시적 부분 응답일 수 있어 거른다
    t = new Date("2026-09-25T12:00:00Z");
    await book.refresh();
    expect((await book.get()).themes).toHaveLength(1); // 두 번 이어서 같은 크기 → 실제로 줄었다
    // 옛것이 너무 오래됐으면(7일 넘음) 줄어든 결과라도 바로 받아들인다
    w.members["888"] = ["P_TA", "P_TB", "P_TC"];
    const old = new Map<string, string>([["discover:us-tics:v1", saved.get("discover:us-tics:v1")!.replace(/"builtAt":\d+/, `"builtAt":${Date.parse("2026-09-01T00:00:00Z")}`)]]);
    const w2 = world();
    w2.members["888"] = [];
    w2.members["956"] = ["P_IONQ", "P_RGTI", "P_QBTS"];
    const stale = new UsThemeBook({ tics: new TossTics(w2.fetchFn, 0), naver: new NaverDiscover(w2.fetchFn), store: { get: async (k: string) => old.get(k) ?? null, set: async () => undefined }, now: () => t });
    expect((await stale.get()).themes.map((x) => x.id)).toEqual(["956"]);
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
