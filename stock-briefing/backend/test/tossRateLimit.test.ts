import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/errors.js";
import { TossOpenApiClient, TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { PACE_WINDOW_MS, pacedPerWindow, rateGroupOf, RequestPacer } from "../src/providers/market/tossRateLimit.js";
import { fakeFetch, NOW, type Call } from "./tossFake.js";

/**
 * 토스 공식 Open API 요청 한도 지키기 (2026-11-12).
 * 운영 /health 에서 하루 사이 429(요청 한도 초과)가 환율 2,417번 · 현재가 368번 · 봉 301번 쌓여 있었다 — 부르는 쪽마다 동시 개수만 제한해
 * 응답이 빠르면 초당 한도를 넘었고, 그때마다 1~3초 기다렸다 다시 보내거나 1초 시세 확인이 5초 쉬었다.
 *  - 그룹별 줄 세우기 (tossRateLimit.RequestPacer): 문서의 한도 그룹마다 1.1초 구간에 '한도 − 15%'까지만 보낸다
 *  - 환율은 동시에 물어도 요청 하나
 *  - 공식 API 가 모르는 종목은 10분 뒤 묶음에 다시 넣지 않고 따로 한 번만 물어 본다
 * 시계는 가짜 — 기다리기를 부르면 그만큼 시간이 간다 (실제로는 기다리지 않는다)
 */

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    clock: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** 어느 1.1초 구간에도 n 개보다 많이 보내지 않았는지 */
function maxInWindow(times: number[], windowMs = PACE_WINDOW_MS): number {
  const s = [...times].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0; i < s.length; i++) {
    let n = 0;
    for (let j = i; j < s.length && s[j]! - s[i]! < windowMs; j++) n++;
    max = Math.max(max, n);
  }
  return max;
}

describe("요청 한도 그룹 (문서 Rate Limits)", () => {
  it("경로 → 그룹·초당 한도", () => {
    const g = (p: string) => rateGroupOf(p);
    expect(g("/api/v1/prices")).toEqual({ group: "MARKET_DATA", limit: 15 });
    expect(g("/api/v1/candles")).toEqual({ group: "MARKET_DATA_CHART", limit: 20 });
    expect(g("/api/v1/stocks")).toEqual({ group: "STOCK", limit: 5 });
    expect(g("/api/v1/stocks/all")).toEqual({ group: "STOCK_ALL", limit: 1 });
    expect(g("/api/v1/stocks/005930/investor-trading")).toEqual({ group: "STOCK_TRADING_TREND", limit: 10 });
    expect(g("/api/v1/stocks/005930/warnings")).toEqual({ group: "STOCK", limit: 5 });
    // 환율과 장 달력은 같은 그룹 (초당 3회를 나눠 쓴다)
    expect(g("/api/v1/exchange-rate")).toEqual({ group: "MARKET_INFO", limit: 3 });
    expect(g("/api/v1/market-calendar/KR")).toEqual({ group: "MARKET_INFO", limit: 3 });
    expect(g("/api/v1/sectors")).toEqual({ group: "SECTOR", limit: 5 });
    expect(g("/api/v1/sectors/956/stocks")).toEqual({ group: "SECTOR", limit: 5 });
    expect(g("/api/v1/sectors/rankings")).toEqual({ group: "SECTOR_RANKING", limit: 5 });
    expect(g("/api/v1/rankings")).toEqual({ group: "RANKING", limit: 5 });
    expect(g("/api/v1/accounts")).toEqual({ group: "ACCOUNT", limit: 1 });
    expect(g("/api/v1/holdings")).toEqual({ group: "ASSET", limit: 5 });
    expect(g("/api/v1/orders")).toEqual({ group: "ORDER_HISTORY", limit: 5 });
    expect(g("/api/v1/buying-power")).toEqual({ group: "ORDER_INFO", limit: 3 }); // 09:00~09:10 피크 한도
    expect(g("/api/v1/something-new")).toBeNull(); // 문서에 없는 경로는 줄 세우지 않는다
  });

  it("한 구간에 보내는 수: 한도에서 15%(적어도 1)를 남긴다", () => {
    expect([20, 15, 10, 6, 5, 3, 2, 1].map(pacedPerWindow)).toEqual([17, 13, 8, 5, 4, 2, 1, 1]);
    expect(pacedPerWindow(0)).toBe(1);
  });
});

describe("줄 세우기 (RequestPacer)", () => {
  it("한꺼번에 10개를 청하면 4개씩 1.1초 간격으로 나간다 (한도 5) — 온 차례대로", async () => {
    const c = fakeClock();
    const pacer = new RequestPacer({ clock: c.clock, sleep: c.sleep });
    const t0 = c.clock();
    const order: number[] = [];
    const at: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pacer.take("STOCK", 5).then(() => {
          order.push(i);
          at.push(c.clock() - t0);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(at).toEqual([0, 0, 0, 0, 1100, 1100, 1100, 1100, 2200, 2200]);
    expect(pacer.stats["STOCK"]).toEqual({ waited: 6, maxWaitMs: 2200, dropped: 0 });
  });

  it("그룹마다 따로 센다 (봉 요청이 밀려도 현재가는 바로 나간다)", async () => {
    const c = fakeClock();
    const pacer = new RequestPacer({ clock: c.clock, sleep: c.sleep });
    const t0 = c.clock();
    for (let i = 0; i < 17; i++) await pacer.take("MARKET_DATA_CHART", 20);
    expect(c.clock() - t0).toBe(0);
    await pacer.take("MARKET_DATA", 15);
    expect(c.clock() - t0).toBe(0); // 다른 그룹은 기다리지 않는다
    await pacer.take("MARKET_DATA_CHART", 20);
    expect(c.clock() - t0).toBe(1100); // 18번째 봉 요청만 다음 구간으로
  });

  it("줄에서 너무 오래 기다리게 되면 보내지 않고 실패로 — 뒤 요청은 이어서 나간다", async () => {
    const c = fakeClock();
    const pacer = new RequestPacer({ clock: c.clock, sleep: c.sleep, maxWaitMs: 2_000 });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => pacer.take("ACCOUNT", 1)));
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "rejected"]);
    const reason = (results[2] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ProviderError);
    expect(String(reason.message)).toContain("요청 한도 대기 시간 초과");
    expect(pacer.stats["ACCOUNT"]).toMatchObject({ dropped: 2 });
    c.advance(5_000);
    await pacer.take("ACCOUNT", 1); // 줄이 막히지 않았다
  });

  it("429 를 받은 그룹은 쉬는 동안 보내지 않는다", async () => {
    const c = fakeClock();
    const pacer = new RequestPacer({ clock: c.clock, sleep: c.sleep });
    const t0 = c.clock();
    pacer.pause("MARKET_DATA", 3_000);
    await pacer.take("MARKET_DATA", 15);
    expect(c.clock() - t0).toBe(3_000);
    await pacer.take("MARKET_INFO", 3); // 다른 그룹은 그대로
    expect(c.clock() - t0).toBe(3_000);
  });
});

/** 가짜 서버: 보낸 시각(가짜 시계)과 경로를 적는다. limits = 경로별로 응답 머리글에 실을 초당 한도 */
function recordingFetch(c: ReturnType<typeof fakeClock>, opts: { limits?: Record<string, number>; first429?: string } = {}) {
  const sent: Array<{ at: number; path: string }> = [];
  let served429 = false;
  const fetchFn = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/oauth2/token") return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 86_400 }), { status: 200 });
    sent.push({ at: c.clock(), path: u.pathname });
    const limit = opts.limits?.[u.pathname];
    const headers: Record<string, string> = { "content-type": "application/json", ...(limit !== undefined ? { "x-ratelimit-limit": String(limit) } : {}) };
    if (opts.first429 === u.pathname && !served429) {
      served429 = true;
      return new Response(JSON.stringify({ error: { code: "rate-limit-exceeded" } }), { status: 429, headers: { ...headers, "retry-after": "2" } });
    }
    return new Response(JSON.stringify({ result: { ok: true } }), { status: 200, headers });
  }) as typeof fetch;
  return { sent, fetchFn };
}

describe("공식 API 클라이언트: 보내기 전에 줄을 선다", () => {
  it("봉 요청 40개를 한꺼번에 보내도 어느 1.1초에도 17개(한도 20)를 넘지 않는다", async () => {
    const c = fakeClock();
    const { sent, fetchFn } = recordingFetch(c);
    const client = new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, pace: { clock: c.clock, sleep: c.sleep } });
    await Promise.all(Array.from({ length: 40 }, (_, i) => client.get("/api/v1/candles", { symbol: `S${i}`, interval: "1d" })));
    const times = sent.map((x) => x.at);
    expect(times).toHaveLength(40);
    expect(maxInWindow(times)).toBe(17);
    expect(client.status.paced?.["MARKET_DATA_CHART"]).toMatchObject({ waited: 23, dropped: 0 });
  });

  it("토스가 응답 머리글로 더 낮은 한도를 알려 주면 그것을 따른다 (일부 IP 대역은 초당 1회)", async () => {
    const c = fakeClock();
    const { sent, fetchFn } = recordingFetch(c, { limits: { "/api/v1/prices": 1 } });
    const client = new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, pace: { clock: c.clock, sleep: c.sleep } });
    for (let i = 0; i < 4; i++) await client.get("/api/v1/prices", { symbols: "005930" });
    const gaps = sent.slice(1).map((x, i) => x.at - sent[i]!.at);
    // 첫 응답을 받기 전에는 문서 값(15)으로 보내고, 한도 1 을 알게 된 뒤에는 1.1초에 하나씩
    expect(gaps).toEqual([1100, 1100, 1100]);
    expect(client.status.rateLimits).toEqual({ "/api/v1/prices": 1 });
  });

  it("429 를 받으면 그 그룹 전체가 쉰다 — 줄에 선 다른 요청이 이어서 두드리지 않는다", async () => {
    const c = fakeClock();
    const { sent, fetchFn } = recordingFetch(c, { first429: "/api/v1/prices" });
    const client = new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, maxRetryWaitMs: 40, pace: { clock: c.clock, sleep: c.sleep } });
    const t0 = c.clock();
    await Promise.all([client.get("/api/v1/prices", { symbols: "A" }), client.get("/api/v1/prices", { symbols: "B" }), client.get("/api/v1/candles", { symbol: "A", interval: "1d" })]);
    const prices = sent.filter((x) => x.path === "/api/v1/prices").map((x) => x.at - t0);
    // 처음 둘(하나는 429) 뒤, 다시 보내는 요청은 쉬는 시간(40ms)이 지난 뒤에
    expect(prices).toHaveLength(3);
    expect(prices[2]).toBeGreaterThanOrEqual(40);
    expect(client.status.rateLimited).toEqual({ "/api/v1/prices": 1 });
    // 봉(다른 그룹)은 기다리지 않았다
    expect(sent.find((x) => x.path === "/api/v1/candles")!.at - t0).toBe(0);
  });

  it("pace: false 면 줄 세우지 않는다 (예전 그대로)", async () => {
    const c = fakeClock();
    const { sent, fetchFn } = recordingFetch(c);
    const client = new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, pace: false });
    await Promise.all(Array.from({ length: 40 }, (_, i) => client.get("/api/v1/candles", { symbol: `S${i}`, interval: "1d" })));
    expect(maxInWindow(sent.map((x) => x.at))).toBe(40);
    expect(client.status.paced).toBeUndefined();
  });

  it("줄에서 10초 넘게 기다리게 될 요청은 보내지 않고 던진다 (마지막 오류에 남는다)", async () => {
    const c = fakeClock();
    const { sent, fetchFn } = recordingFetch(c);
    const client = new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, pace: { clock: c.clock, sleep: c.sleep } });
    // 계좌 목록은 초당 1회 — 12개를 한꺼번에 청하면 10번째(9.9초)까지만 나간다
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => client.get("/api/v1/accounts")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(sent).toHaveLength(10);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason.message)).toContain("요청 한도 대기 시간 초과");
    expect(String(failed.reason.message)).toContain("/api/v1/accounts");
  });
});

describe("환율: 동시에 물어도 요청은 하나", () => {
  it("시세 조회 여섯 개가 함께 환율을 물으면 한 번만 나가고, 1분 뒤에 다시 한 번", async () => {
    const calls: Call[] = [];
    let now = NOW();
    const base = fakeFetch({ calls });
    // 응답이 조금 늦게 온다 (그 사이 다른 조회가 또 묻는다)
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/v1/exchange-rate")) await new Promise((r) => setTimeout(r, 5));
      return base(input, init);
    }) as typeof fetch;
    const client = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => now, maxRetryWaitMs: 0 });
    const p = new TossOpenApiProvider(client, { now: () => now });
    const fxCalls = () => calls.filter((x) => x.url.includes("/api/v1/exchange-rate")).length;
    expect(await Promise.all(Array.from({ length: 6 }, () => p.usdKrw()))).toEqual([1384.3, 1384.3, 1384.3, 1384.3, 1384.3, 1384.3]);
    expect(fxCalls()).toBe(1);
    // 미국 종목 시세를 종목마다 따로 물어도 (관심·알림이 4개씩 묻는다) 환율은 캐시
    await Promise.all(["TSLA", "TSLA", "TSLA", "TSLA"].map((code) => p.getQuotes([code])));
    expect(fxCalls()).toBe(1);
    now = new Date(now.getTime() + 61_000);
    await Promise.all(Array.from({ length: 4 }, () => p.getQuotes(["TSLA"])));
    expect(fxCalls()).toBe(2);
  });

  it("받지 못하면 null (다음에 다시 묻는다)", async () => {
    let fail = true;
    const base = fakeFetch();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (fail && String(input).includes("/api/v1/exchange-rate")) return new Response(JSON.stringify({ error: { code: "internal-error" } }), { status: 500 });
      return base(input, init);
    }) as typeof fetch;
    const p = new TossOpenApiProvider(new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: NOW, maxRetryWaitMs: 0 }), { now: NOW });
    expect(await Promise.all([p.usdKrw(), p.usdKrw()])).toEqual([null, null]);
    fail = false;
    expect(await p.usdKrw()).toBe(1384.3);
  });
});

describe("공식 API 가 모르는 종목: 쉬는 시간이 끝나면 따로 한 번만 물어 본다", () => {
  /** ZZZZ 가 든 요청은 400 (unknown 이 참인 동안) */
  function world() {
    const calls: Call[] = [];
    const state = { now: NOW(), unknown: true };
    const base = fakeFetch({ calls });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (state.unknown && url.includes("/api/v1/prices") && new URL(url).searchParams.get("symbols")!.split(",").includes("ZZZZ")) {
        calls.push({ method: "GET", url, headers: {}, body: null });
        return new Response(JSON.stringify({ error: { code: "invalid-symbol" } }), { status: 400 });
      }
      return base(input, init);
    }) as typeof fetch;
    const client = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => state.now, maxRetryWaitMs: 0 });
    const p = new TossOpenApiProvider(client, { now: () => state.now });
    const priceCalls = () => calls.filter((x) => x.url.includes("/api/v1/prices")).map((x) => new URL(x.url).searchParams.get("symbols")!);
    return { p, state, priceCalls };
  }
  const CODES = ["035420", "000660", "005930", "005380", "012450", "TSLA", "ZZZZ"];

  it("10분 뒤: 아는 종목 묶음 1번 + 그 종목 1번 — 묶음 전체가 또 거절돼 종목 수만큼 다시 묻지 않는다", async () => {
    const { p, state, priceCalls } = world();
    await p.getMany(CODES);
    expect(priceCalls()).toHaveLength(1 + CODES.length); // 처음 한 번은 가려내야 한다: 묶음 1 + 종목 7
    state.now = new Date(state.now.getTime() + 10 * 60_000 + 1_000);
    const m = await p.getMany(CODES);
    expect(m.size).toBe(6);
    // 예전에는 여기서 또 '묶음 1 + 종목 7' (10분마다 — 운영에서 그때마다 현재가 한도에 걸렸다)
    expect(priceCalls().slice(1 + CODES.length)).toEqual(["035420,000660,005930,005380,012450,TSLA", "ZZZZ"]);
    // 아직 모르는 종목이면 다시 10분 쉰다
    state.now = new Date(state.now.getTime() + 1_000);
    await p.getMany(CODES);
    expect(priceCalls().at(-1)).toBe("035420,000660,005930,005380,012450,TSLA");
  });

  it("다시 알게 된 종목은(다시 상장·오타 수정) 그때부터 묶음에 넣는다", async () => {
    const { p, state, priceCalls } = world();
    await p.getMany(CODES);
    state.unknown = false;
    state.now = new Date(state.now.getTime() + 10 * 60_000 + 1_000);
    expect((await p.getMany(CODES)).has("ZZZZ")).toBe(true);
    state.now = new Date(state.now.getTime() + 1_000);
    await p.getMany(CODES);
    expect(priceCalls().at(-1)).toBe(CODES.join(","));
  });
});
