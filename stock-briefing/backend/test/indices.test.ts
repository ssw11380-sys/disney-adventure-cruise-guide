import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { MarketCalendar } from "../src/providers/market/calendar.js";
import { fxMonthly, INDEX_SOURCES, MarketIndices, type MarketIndex } from "../src/providers/market/indices.js";
import { marketRoutes } from "../src/routes/market.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** p 가 ms 안에 끝나면 그 값, 아니면 "pending" (멈춘 조회를 테스트 제한 시간까지 기다리지 않게) */
async function settle<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"pending">((r) => (timer = setTimeout(() => r("pending"), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** 9개 출처가 모두 정상일 때의 응답 (11:00 KST 시세, 국내·해외 지수는 장중) */
const healthy = (url: string) =>
  url.includes("/marketindex/exchange/")
    ? json({ exchangeInfo: { closePrice: "1,352.10", fluctuations: "-3.40", fluctuationsRatio: "-0.25", localTradedAt: "2026-09-24T10:59:00+09:00" } })
    : json({ closePrice: "3,000", compareToPreviousClosePrice: "30", fluctuationsRatio: "1.01", marketStatus: "OPEN", localTradedAt: "2026-09-24T11:00:00+09:00" });

const ALL = INDEX_SOURCES.map((s) => s.code);

describe("MarketIndices 출처 장애 (DISC-01)", () => {
  it("정상 → 출처 전부 503 → 장 마감 뒤: 값은 남기되 원래 시세·받은 시각과 stale 을 주고, 옛 장중(open)을 이어 가지 않는다 (3시간까지)", async () => {
    let now = new Date("2026-09-24T06:00:00Z"); // 15:00 KST 장중
    let failed = false;
    const fetchFn = (async (url: string) => (failed ? new Response("error", { status: 503 }) : healthy(url))) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => now);
    const first = await m.list({ stale: true });
    expect(first.map((i) => i.code)).toEqual(ALL);
    expect(first[0]).toMatchObject({ code: "KOSPI", open: true, stale: false, asOf: "2026-09-24T11:00:00+09:00", fetchedAt: "2026-09-24T15:00:00+09:00" });

    failed = true;
    now = new Date("2026-09-24T08:30:00Z"); // 17:30 KST 장 마감 뒤
    const later = await m.list({ stale: true });
    // 마지막 정상값은 그대로 (가격 보존)
    expect(later.map((i) => [i.code, i.value])).toEqual(first.map((i) => [i.code, i.value]));
    // 실제 시세 시각·서버가 받은 시각은 그대로, 갱신 실패 표시, 장중을 확정값처럼 주지 않는다
    expect(later[0]).toMatchObject({ code: "KOSPI", asOf: "2026-09-24T11:00:00+09:00", fetchedAt: "2026-09-24T15:00:00+09:00", stale: true, open: false });
    expect(later.every((i) => i.stale === true && i.open === false && i.fetchedAt === "2026-09-24T15:00:00+09:00")).toBe(true);
    // 전부 실패면 옛 앱(플래그 없음)은 예전(main) 서버처럼 직전 목록을 그대로 (stale·open:false 를 모르는 옛 앱에 항목별 stale 을 주지 않는다)
    expect(await m.list()).toEqual(first);

    // 받은 지 3시간이 지나면 더 이어 주지 않는다 (옛 앱도)
    now = new Date("2026-09-24T09:01:00Z"); // 18:01 KST
    expect(await m.list({ stale: true })).toEqual([]);
    expect(await m.list()).toEqual([]);

    // 출처가 돌아오면 새 값·새 시각
    failed = false;
    now = new Date("2026-09-24T09:02:00Z");
    const back = await m.list({ stale: true });
    expect(back[0]).toMatchObject({ code: "KOSPI", open: true, stale: false, fetchedAt: "2026-09-24T18:02:00+09:00" });
  });

  it("일부 항목만 실패하면 그 항목만 마지막 값(stale), 나머지는 새 값. 한 번도 못 받은 항목은 빠진다 · 옛 앱은 실패한 항목을 뺀다", async () => {
    let now = new Date("2026-09-24T02:00:00Z");
    let round = 1;
    const fetchFn = (async (url: string) => {
      if (url.includes("KOSDAQ")) return new Response("error", { status: 503 }); // 처음부터 실패
      if (round === 2 && url.includes("KOSPI")) return new Response("error", { status: 503 });
      return healthy(url);
    }) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => now);
    await m.list({ stale: true });
    round = 2;
    now = new Date("2026-09-24T02:01:00Z"); // 11:01 KST (30초 캐시 뒤)
    const list = await m.list({ stale: true });
    expect(list.map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSDAQ"));
    expect(list.find((i) => i.code === "KOSPI")).toMatchObject({ stale: true, open: false, fetchedAt: "2026-09-24T11:00:00+09:00" });
    expect(list.find((i) => i.code === "NASDAQ")).toMatchObject({ stale: false, open: true, fetchedAt: "2026-09-24T11:01:00+09:00" });
    // 옛 앱: 예전 서버처럼 이번에 받은 항목만
    const old = await m.list();
    expect(old.map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSDAQ" && c !== "KOSPI"));
    expect(old.every((i) => i.stale === false)).toBe(true);
  });

  it("처음부터 출처가 모두 실패하면 두 앱 모두 빈 목록 (main 도 빈 목록 — 띠를 숨긴다)", async () => {
    const m = new MarketIndices((async () => new Response("error", { status: 503 })) as unknown as typeof fetch, () => new Date("2026-09-24T02:00:00Z"));
    expect(await m.list()).toEqual([]);
    expect(await m.list({ stale: true })).toEqual([]);
  });
});

describe("GET /api/market/indices: stale 을 아는 앱만 마지막 값을 받는다 (옛 앱 호환)", () => {
  /** 11:00 KST 에 모두 정상, 주소에 fail 의 글자가 든 출처는 그 뒤로 503 */
  function world() {
    const w = { now: new Date("2026-09-24T02:00:00Z"), fail: new Set<string>() };
    const fetchFn = (async (url: string) => ([...w.fail].some((c) => url.includes(c)) ? new Response("error", { status: 503 }) : healthy(url))) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => w.now);
    return { w, m };
  }
  async function serve(m: MarketIndices) {
    const app = Fastify({ logger: false });
    await app.register(marketRoutes, { prefix: "/api/market", calendar: {} as MarketCalendar, indices: m });
    return app;
  }
  const get = async (app: FastifyInstance, url: string) => ((await app.inject({ method: "GET", url })).json() as { indices: MarketIndex[] }).indices;
  const later = (w: { now: Date }, ms: number) => (w.now = new Date(w.now.getTime() + ms));

  it("옛 앱(플래그 없음): 일부 출처가 실패하면 main 서버처럼 그 항목을 뺀다 — 멈춘 값이 받은 시각 옆에 지금 값처럼 보이지 않게", async () => {
    const { w, m } = world();
    const app = await serve(m);
    try {
      expect((await get(app, "/api/market/indices")).map((i) => i.code)).toEqual(ALL);
      w.fail.add("KOSPI");
      later(w, 60_000);
      const old = await get(app, "/api/market/indices");
      expect(old.map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSPI"));
      expect(old.every((i) => i.stale !== true)).toBe(true);
      // 같은 때 새 앱(stale=1)은 마지막 값을 stale 로 받는다
      const neu = await get(app, "/api/market/indices?stale=1");
      expect(neu.map((i) => i.code)).toEqual(ALL);
      expect(neu.find((i) => i.code === "KOSPI")).toMatchObject({ stale: true, open: false, fetchedAt: "2026-09-24T11:00:00+09:00" });
      // 출처가 돌아오면 옛 앱도 다시 받는다
      w.fail.clear();
      later(w, 60_000);
      expect((await get(app, "/api/market/indices")).map((i) => i.code)).toEqual(ALL);
    } finally {
      await app.close();
    }
  });

  it("새 앱(stale=1)도 마지막 값은 받은 지 3시간까지만 — 고장 난 출처의 값이 계속 굳어 있지 않게", async () => {
    const { w, m } = world();
    const app = await serve(m);
    try {
      await get(app, "/api/market/indices?stale=1");
      w.fail.add("KOSPI");
      later(w, 3 * 60 * 60_000 - 60_000); // 13:59 KST
      const kept = await get(app, "/api/market/indices?stale=1");
      expect(kept.find((i) => i.code === "KOSPI")).toMatchObject({ stale: true, fetchedAt: "2026-09-24T11:00:00+09:00" });
      later(w, 2 * 60_000); // 14:01 KST — 받은 지 3시간 넘음
      const dropped = await get(app, "/api/market/indices?stale=1");
      expect(dropped.map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSPI"));
      expect(dropped.every((i) => i.stale === false)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("출처가 모두 실패하면 옛 앱은 main 서버처럼 직전 목록을 원래 장중(open) 그대로 받는다 — 새 앱은 항목별 stale, 3시간이 지나면 둘 다 뺀다", async () => {
    const { w, m } = world();
    const app = await serve(m);
    try {
      const first = await get(app, "/api/market/indices");
      w.fail.add("naver.com"); // 9개 출처 모두
      later(w, 60 * 60_000); // 12:00 KST 장중
      // 옛 앱: 마지막으로 받은 목록 그대로 (장중 표시·상세의 "장중"이 "장 마감"으로 바뀌지 않게)
      const old = await get(app, "/api/market/indices");
      expect(old).toEqual(first);
      expect(old.filter((i) => i.kind === "index").every((i) => i.open === true)).toBe(true);
      // 새 앱: 항목별 마지막 값을 stale 로 (장 상태는 확인하지 못해 장중으로 두지 않는다)
      const neu = await get(app, "/api/market/indices?stale=1");
      expect(neu.map((i) => i.code)).toEqual(ALL);
      expect(neu.every((i) => i.stale === true && i.open === false && i.fetchedAt === "2026-09-24T11:00:00+09:00")).toBe(true);
      later(w, 2 * 60 * 60_000 + 60_000); // 14:01 KST
      expect(await get(app, "/api/market/indices")).toEqual([]);
      expect(await get(app, "/api/market/indices?stale=1")).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("옛 앱: 일부 실패 → 전체 실패면 main 서버처럼 직전(일부 실패) 목록을 받는다 — 빠졌던 항목의 몇 시간 전 값이 다시 나타나지 않게", async () => {
    const { w, m } = world();
    const app = await serve(m);
    try {
      expect((await get(app, "/api/market/indices")).map((i) => i.code)).toEqual(ALL); // 11:00 모두 정상
      w.fail.add("KOSPI");
      later(w, 60 * 60_000); // 12:00 KOSPI 만 503
      const noon = await get(app, "/api/market/indices");
      expect(noon.map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSPI"));
      w.fail.add("naver.com");
      later(w, 60 * 60_000); // 13:00 모두 503
      const old = await get(app, "/api/market/indices");
      // main 과 같이 12:00 목록 그대로: KOSPI 의 11:00 값이 되살아나지 않고, 나머지는 원래 장중(open) 그대로
      expect(old).toEqual(noon);
      expect(old.some((i) => i.fetchedAt === "2026-09-24T11:00:00+09:00")).toBe(false);
      expect(old.filter((i) => i.kind === "index").every((i) => i.open === true)).toBe(true);
      // 새 앱은 항목별 마지막 값: KOSPI 는 11:00, 나머지는 12:00 값을 stale 로
      const neu = await get(app, "/api/market/indices?stale=1");
      expect(neu.map((i) => i.code)).toEqual(ALL);
      expect(neu.find((i) => i.code === "KOSPI")).toMatchObject({ stale: true, open: false, fetchedAt: "2026-09-24T11:00:00+09:00" });
      expect(neu.find((i) => i.code === "KOSDAQ")).toMatchObject({ stale: true, open: false, fetchedAt: "2026-09-24T12:00:00+09:00" });
      // 직전 목록도 받은 지 3시간이 지나면 옛 앱에 주지 않는다 (12:00 목록 → 15:01)
      later(w, 2 * 60 * 60_000 + 60_000);
      expect(await get(app, "/api/market/indices")).toEqual([]);
      // 출처가 돌아오면 다시 받는다
      w.fail.clear();
      later(w, 60_000);
      expect((await get(app, "/api/market/indices")).map((i) => i.code)).toEqual(ALL);
    } finally {
      await app.close();
    }
  });
});

describe("MarketIndices 멈춘 출처 (DISC-02)", () => {
  it("한 출처가 응답하지 않아도 앱 제한(10초)보다 먼저 나머지 8개를 주고, 멈춘 요청은 끊는다 (기본 제한 시간)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let signal: AbortSignal | null | undefined;
      const fetchFn = (async (url: string, init?: RequestInit) => {
        if (url.includes("KOSPI")) {
          signal = init?.signal;
          return new Promise<Response>(() => {}); // 끝나지 않는 연결
        }
        return healthy(url);
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, () => new Date("2026-09-24T02:00:00Z"));
      let result: MarketIndex[] | undefined;
      void m.list().then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(9_000); // 앱은 10초에 끊는다 (서버↔앱 오가는 시간 여유)
      expect(result?.map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSPI"));
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("캐시가 있으면 멈춘 출처는 마지막 값(stale)으로 채운다 (stale 을 아는 앱)", async () => {
    let now = new Date("2026-09-24T02:00:00Z");
    let hang = false;
    const fetchFn = (async (url: string) => (hang && url.includes("KOSPI") ? new Promise<Response>(() => {}) : healthy(url))) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => now, { listTimeoutMs: 50 });
    await m.list({ stale: true });
    hang = true;
    now = new Date("2026-09-24T02:01:00Z");
    const list = await settle(m.list({ stale: true }), 2_000);
    expect(list).not.toBe("pending");
    expect((list as MarketIndex[]).map((i) => i.code)).toEqual(ALL);
    expect((list as MarketIndex[])[0]).toMatchObject({ code: "KOSPI", stale: true, open: false, fetchedAt: "2026-09-24T11:00:00+09:00" });
    // 옛 앱은 같은 조회에서 멈춘 항목을 뺀다 (다시 부르지 않고 30초 캐시에서)
    expect((await m.list()).map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSPI"));
  });

  it("헤더만 오고 본문이 멈춰도(실제 HTTP) 제한 시간에 연결을 끊고 나머지를 준다", async () => {
    let closed = false;
    const server = http.createServer((req, res) => {
      req.socket.on("close", () => (closed = true));
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"closePrice":'); // 본문 일부만 보내고 멈춘다
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const fetchFn = ((url: string, init?: RequestInit) =>
        url.includes("KOSPI") ? fetch(`http://127.0.0.1:${port}/`, init) : Promise.resolve(healthy(url))) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, () => new Date("2026-09-24T02:00:00Z"), { listTimeoutMs: 200 });
      const list = await settle(m.list(), 3_000);
      expect(list).not.toBe("pending");
      expect((list as MarketIndex[]).map((i) => i.code)).toEqual(ALL.filter((c) => c !== "KOSPI"));
      // 남은 요청은 취소된다 (서버 쪽 연결이 닫힘)
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("차트도 본문이 멈추면 제한 시간에 끝낸다: 캐시가 있으면 직전 값, 없으면 실패", async () => {
    let now = new Date("2026-09-24T05:20:00Z");
    let hang = false;
    // 헤더는 오고 본문이 끝나지 않는 응답 (주입한 fetch 가 signal 을 몰라도 끝나야 한다)
    const stalled = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
    const fetchFn = (async (url: string) => {
      if (hang) return stalled();
      if (url.includes("/chart/foreign/index/.DJI/week?")) return json([{ localDate: "20260920", closePrice: 51863.69, openPrice: 51000, highPrice: 52000, lowPrice: 50900, accumulatedTradingVolume: 1 }]);
      return new Response("x", { status: 404 });
    }) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => now, { chartTimeoutMs: 50 });
    expect((await m.candles("DJI", "W", 50))!.candles).toHaveLength(1);
    hang = true;
    now = new Date(now.getTime() + 60 * 60_000); // 캐시 만료 뒤
    const cached = await settle(m.candles("DJI", "W", 50), 2_000);
    expect(cached).not.toBe("pending");
    expect((cached as { candles: unknown[] }).candles).toHaveLength(1);
    const none = await settle(m.candles("SPX", "D", 50).then(() => "ok", (e: Error) => e.message), 2_000);
    expect(none).toMatch(/시간 초과/);
  });
});

describe("MarketIndices", () => {
  it("지수와 환율을 모으고, 실패한 항목만 빼며, 음수 등락률 부호를 맞춘다", async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      if (url.includes("KOSPI")) return json({ stockName: "코스피", closePrice: "7,026.35", compareToPreviousClosePrice: "8.44", fluctuationsRatio: "0.12", marketStatus: "OPEN", localTradedAt: "2026-09-23T11:18:00+09:00" });
      if (url.includes(".DJI")) return json({ closePrice: "51,863.69", compareToPreviousClosePrice: "-185.14", fluctuationsRatio: "0.36", marketStatus: "CLOSE" });
      if (url.includes("FX_USDKRW")) return json({ exchangeInfo: { closePrice: "1,352.10", fluctuations: "-3.40", fluctuationsRatio: "-0.25" } });
      if (url.includes("FX_JPYKRW")) return json({ exchangeInfo: { closePrice: "858.01", fluctuations: "-2.90", fluctuationsRatio: "-0.34" } });
      return new Response("x", { status: 500 });
    }) as unknown as typeof fetch;
    const m = new MarketIndices(fetchFn, () => new Date("2026-09-23T02:20:00Z"));
    const list = await m.list();
    expect(list.map((i) => i.code)).toEqual(["KOSPI", "DJI", "USDKRW", "JPYKRW"]);
    expect(list[0]).toMatchObject({ name: "코스피", value: 7026.35, change: 8.44, changeRate: 0.12, open: true });
    expect(list[1]).toMatchObject({ change: -185.14, changeRate: -0.36, open: false });
    expect(list[2]).toMatchObject({ name: "원/달러", kind: "fx", value: 1352.1, change: -3.4, changeRate: -0.25 });
    expect(list[3]).toMatchObject({ name: "원/100엔", kind: "fx", value: 858.01 });
    expect(list[0]!.kind).toBe("index");
    const before = calls;
    await m.list();
    expect(calls).toBe(before); // 30초 캐시
  });
  describe("candles", () => {
    const NOW = () => new Date("2026-09-23T05:20:00Z"); // 14:20 KST

    it("국내 지수 분봉은 시·고·저·종이 있는 분 데이터를 서울 시각으로, 일봉은 기간 조회로 가져온다", async () => {
      const urls: string[] = [];
      const fetchFn = (async (url: string) => {
        urls.push(url);
        if (url.includes("/chart/domestic/index/KOSPI/minute?"))
          return json([
            { localDateTime: "20260923090000", currentPrice: 7144.02, openPrice: 7153.99, highPrice: 7153.99, lowPrice: 7144.02, accumulatedTradingVolume: 4038 },
            { localDateTime: "20260923090100", currentPrice: 7142.23, openPrice: 7139.08, highPrice: 7142.23, lowPrice: 7135.17, accumulatedTradingVolume: 2639 },
          ]);
        if (url.includes("/chart/domestic/index/KOSPI/day?"))
          return json([
            { localDate: "20260922", closePrice: 7017.91, openPrice: 6990.1, highPrice: 7030.5, lowPrice: 6980.2, accumulatedTradingVolume: 500 },
            { localDate: "20260923", closePrice: 7050.69, openPrice: 7153.99, highPrice: 7171.52, lowPrice: 7040.1, accumulatedTradingVolume: 300 },
          ]);
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, NOW);
      const min = await m.candles("kospi", "1m", 100);
      // 국내 지수 차트 거래량은 천주 단위 → 주 단위
      expect(min!.candles[0]).toEqual({ date: "2026-09-23", time: "2026-09-23T09:00:00+09:00", open: 7153.99, high: 7153.99, low: 7144.02, close: 7144.02, volume: 4_038_000 });
      expect(urls[0]).toContain("startDateTime=202609160000&endDateTime=202609232359");
      const day = await m.candles("KOSPI", "D", 100);
      expect(day!.candles.map((c) => [c.close, c.volume])).toEqual([
        [7017.91, 500_000],
        [7050.69, 300_000],
      ]);
      expect(urls[1]).toMatch(/\/day\?startDateTime=\d{8}0000&endDateTime=202609232359/);
      expect(await m.candles("NOPE", "D", 100)).toBeNull();
    });

    it("해외 지수 분봉은 당일 1분 시세(종가만)로 만들고 뉴욕 시각(서머타임) 오프셋을 붙이며, 5분봉으로 묶는다", async () => {
      const fetchFn = (async (url: string) => {
        if (url.includes("/chart/foreign/index/.IXIC?periodType=day"))
          return json({
            openPrice: 27161.197,
            // 직전 세션은 중간(12:14)부터만 온다: 첫 분의 누적 거래량을 그 분 거래량으로 치지 않는다
            lastPriceInfos: [
              { localDateTime: "20260921121400", currentPrice: 27013, accumulatedTradingVolume: 510453 },
              { localDateTime: "20260921121500", currentPrice: 27019, accumulatedTradingVolume: 512055 },
            ],
            priceInfos: [
              { localDateTime: "20260922093000", currentPrice: 27180, accumulatedTradingVolume: 100 },
              { localDateTime: "20260922093100", currentPrice: 27213, accumulatedTradingVolume: 160 },
              { localDateTime: "20260922093500", currentPrice: 27200, accumulatedTradingVolume: 200 },
            ],
          });
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, NOW);
      const all = (await m.candles("NASDAQ", "1m", 100))!.candles;
      expect(all.slice(0, 2).map((c) => [c.time, c.volume])).toEqual([
        ["2026-09-21T12:14:00-04:00", 0],
        ["2026-09-21T12:15:00-04:00", 1602],
      ]);
      const one = all.slice(2);
      // 당일 첫 봉 시가는 응답의 당일 시가 (밤사이 갭을 한 봉에 넣지 않는다)
      expect(one[0]).toEqual({ date: "2026-09-22", time: "2026-09-22T09:30:00-04:00", open: 27161.197, high: 27180, low: 27161.197, close: 27180, volume: 100 });
      expect(one[1]).toMatchObject({ open: 27180, close: 27213, high: 27213, low: 27180, volume: 60 });
      const five = (await m.candles("NASDAQ", "5m", 100))!.candles;
      expect(five.slice(-2).map((c) => [c.time, c.open, c.high, c.low, c.close])).toEqual([
        ["2026-09-22T09:30:00-04:00", 27161.197, 27213, 27161.197, 27213],
        ["2026-09-22T09:35:00-04:00", 27213, 27213, 27200, 27200],
      ]);
    });

    it("환율: 당일 고시 회차는 분봉으로 묶고, 일별 종가는 시가를 직전 종가로 채우며, 월봉은 주별을 묶는다", async () => {
      const fetchFn = (async (url: string) => {
        if (!url.includes("pricesByPeriod") || !url.includes("FX_CNYKRW")) return new Response("x", { status: 404 });
        const type = new URL(url).searchParams.get("scriptChartType");
        if (type === "day")
          return json({
            result: {
              openPrice: 202,
              priceInfos: [
                { localDateTime: "20260923090010", currentPrice: 202.1 },
                { localDateTime: "20260923090040", currentPrice: 201.9 },
                { localDateTime: "20260923090120", currentPrice: 202.3 },
              ],
            },
          });
        if (type === "areaYear")
          return json({
            result: {
              priceInfos: [
                { localDate: "20260921", closePrice: 203, openPrice: 0, highPrice: 203, lowPrice: 203 },
                { localDate: "20260922", closePrice: 202, openPrice: 0, highPrice: 202, lowPrice: 202 },
              ],
            },
          });
        if (type === "areaYearTen")
          return json({
            result: {
              priceInfos: [
                { localDate: "20260828", closePrice: 200, openPrice: 0, highPrice: 201, lowPrice: 199 },
                { localDate: "20260904", closePrice: 204, openPrice: 0, highPrice: 205, lowPrice: 200 },
                { localDate: "20260911", closePrice: 206, openPrice: 0, highPrice: 207, lowPrice: 203 },
              ],
            },
          });
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      const m = new MarketIndices(fetchFn, NOW);
      const min = (await m.candles("CNYKRW", "1m", 100))!.candles;
      expect(min).toEqual([
        { date: "2026-09-23", time: "2026-09-23T09:00:00+09:00", open: 202, high: 202.1, low: 201.9, close: 201.9, volume: 0 },
        { date: "2026-09-23", time: "2026-09-23T09:01:00+09:00", open: 201.9, high: 202.3, low: 201.9, close: 202.3, volume: 0 },
      ]);
      const day = (await m.candles("CNYKRW", "D", 100))!.candles;
      expect(day[1]).toEqual({ date: "2026-09-22", open: 203, high: 203, low: 202, close: 202, volume: 0 });
      // 일별 자료가 9/21 부터라 온전한 달이 없다 → 전부 주별로. 봉 날짜는 그 달 1일
      const month = (await m.candles("CNYKRW", "M", 100))!.candles;
      expect(month.map((c) => [c.date, c.close])).toEqual([
        ["2026-08-01", 200],
        ["2026-09-01", 206],
      ]);
    });

    it("조회가 실패하면 직전 캐시를 쓰고, 캐시가 없으면 던진다", async () => {
      let fail = false;
      const fetchFn = (async (url: string) => {
        if (fail) return new Response("x", { status: 503 });
        if (url.includes("/chart/foreign/index/.DJI/week?")) return json([{ localDate: "20260920", closePrice: 51863.69, openPrice: 51000, highPrice: 52000, lowPrice: 50900, accumulatedTradingVolume: 1 }]);
        return new Response("x", { status: 404 });
      }) as unknown as typeof fetch;
      let now = new Date("2026-09-23T05:20:00Z");
      const m = new MarketIndices(fetchFn, () => now);
      await expect(m.candles("DJI", "D", 50)).rejects.toThrow("HTTP 404");
      expect((await m.candles("DJI", "W", 50))!.candles).toHaveLength(1);
      fail = true;
      now = new Date(now.getTime() + 60 * 60_000); // 캐시 만료 뒤 실패
      expect((await m.candles("DJI", "W", 50))!.candles).toHaveLength(1);
    });
  });
});

describe("fxMonthly", () => {
  const c = (date: string, close: number, high = close, low = close) => ({ date, open: close, high, low, close, volume: 0 });
  it("일별이 온전히 덮는 달은 월말 종가로, 그 전은 주별로 묶고, 시가를 직전 달 종가로 잇는다", () => {
    const weekly = [c("2025-08-29", 1390), c("2025-09-05", 1395, 1400, 1388), c("2025-09-26", 1400), c("2025-10-03", 1405)];
    // 일별은 2025-09-23 부터 → 10월부터 일별로. 9/30(화) 종가 1406 이 9월이 아니라 주별 행(10/3 주)에 섞이는 문제를 피한다
    const daily = [c("2025-09-23", 1398), c("2025-09-30", 1406), c("2025-10-01", 1401, 1410, 1399), c("2025-10-31", 1430), c("2025-11-03", 1428)];
    const m = fxMonthly(daily, weekly);
    expect(m.map((x) => [x.date, x.open, x.high, x.low, x.close])).toEqual([
      ["2025-08-01", 1390, 1390, 1390, 1390],
      ["2025-09-01", 1390, 1400, 1388, 1400],
      ["2025-10-01", 1400, 1430, 1399, 1430],
      ["2025-11-01", 1430, 1430, 1428, 1428],
    ]);
  });
});
