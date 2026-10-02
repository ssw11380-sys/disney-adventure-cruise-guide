import { afterEach, describe, expect, it, vi } from "vitest";
import { KisProvider } from "../src/providers/market/kis.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeNewsProvider, FakeQuoteProvider } from "./helpers.js";

const AT = new Date("2026-10-02T15:30:00+09:00");
const WAIT = 10_000; // 네이버·야후·뉴스가 쓰는 기존 출처 요청 정책
const token = (name = "offline-token", expiresIn = 86_400) => ({ access_token: name, expires_in: expiresIn });
const quote = { rt_cd: "0", output: { stck_prpr: "120000", prdy_vrss_sign: "5", prdy_vrss: "2000", prdy_ctrt: "1.64",
  stck_oprc: "123000", stck_hgpr: "124000", stck_lwpr: "119000", stck_sdpr: "122000", acml_vol: "3456", hts_avls: "1200",
  per: "12", pbr: "2", eps: "10000", bps: "60000", w52_hgpr: "140000", w52_lwpr: "80000" } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const provider = (fetchFn: typeof fetch, env: "real" | "mock" = "real") => new KisProvider({
  appKey: "offline-key", appSecret: "offline-secret", env, fetchFn, now: () => new Date(),
});
function clock() { vi.useFakeTimers(); vi.setSystemTime(AT); }

function blocked(body: unknown, status: number, stage: "headers" | "body") {
  let release!: () => void;
  const response = stage === "headers"
    ? new Promise<Response>((resolve) => { release = () => resolve(json(body, status)); })
    : Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(output) { release = () => { output.enqueue(new TextEncoder().encode(JSON.stringify(body))); output.close(); }; },
    }), { status, headers: { "content-type": "application/json" } }));
  return { response, release: () => release() };
}

afterEach(() => { vi.useRealTimers(); });

describe("KIS 요청 기한 — 실제 제공자와 가짜 통신", () => {
  it.each([
    ["token", "headers", 200], ["token", "body", 200], ["token", "body", 503],
    ["quote", "headers", 200], ["quote", "body", 200], ["quote", "body", 503],
  ] as const)("%s %s 정지(HTTP %i)도 10초에 다음 시세 출처로 넘어가고 자동 재시도하지 않는다", async (target, stage, status) => {
    clock();
    const block = blocked(target === "token" ? token() : quote, status, stage);
    let signal: AbortSignal | null | undefined;
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const isToken = String(input).includes("/oauth2/tokenP");
      if ((target === "token") === isToken) { signal = init?.signal; return block.response; }
      return json(isToken ? token() : quote);
    });
    const fallback = new FakeQuoteProvider("offline-fallback");
    const warnings: string[] = [];
    const chain = new QuoteProviderChain([provider(fakeFetch), fallback], { warn: (fields) => { warnings.push(String(fields.err)); } });
    let state = "pending";
    const task = chain.getQuote("000660").then((value) => { state = "success"; return value; });
    await vi.advanceTimersByTimeAsync(WAIT - 1);
    expect(state).toBe("pending");
    expect(fallback.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    const observed = { state, fallbackCalls: fallback.calls, aborted: signal?.aborted, calls: fakeFetch.mock.calls.length };
    // 수정 전 RED 실행에서도 멈춘 가짜 응답을 해제해 다음 테스트로 누수시키지 않는다.
    block.release();
    await task;
    expect(observed).toEqual({ state: "success", fallbackCalls: 1, aborted: true, calls: target === "token" ? 1 : 2 });
    expect(warnings[0]).toContain("시간 초과");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("봉 요청 본문이 멈춰도 다음 소스의 요청 기간·160개 봉을 그대로 받는다", async () => {
    clock();
    const block = blocked({ rt_cd: "0", output2: [] }, 200, "body");
    const fakeFetch = vi.fn(async (input: string | URL | Request) => String(input).includes("tokenP") ? json(token()) : block.response);
    const fallback = new FakeQuoteProvider("offline-fallback");
    const chain = new QuoteProviderChain([provider(fakeFetch), fallback]);
    let state = "pending";
    const task = chain.getCandles("000660", "D", 160).then((value) => { state = "success"; return value; });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    const atDeadline = state;
    block.release();
    const actual = await task;
    expect(atDeadline).toBe("success");
    expect(actual).toEqual(await new FakeQuoteProvider("offline-fallback").getCandles("000660", "D", 160));
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("수급만 멈추면 실제 브리핑 수집기가 나머지 자료를 보존하고 수급 미확인으로 끝낸다", async () => {
    clock();
    const block = blocked({ rt_cd: "0", output: [] }, 200, "body");
    const fakeFetch = vi.fn(async (input: string | URL | Request) => String(input).includes("tokenP") ? json(token()) : block.response);
    const kis = provider(fakeFetch);
    const build = (investorFlow: typeof kis | null) => new DataCollector({
      quotes: new FakeQuoteProvider("offline-quote"), news: new FakeNewsProvider(), financials: null, investorFlow, now: () => AT,
    });
    const stock = { code: "000660", name: "SK하이닉스", market: "KOSPI" as const, quantity: 2, avgPrice: 90000, memo: null, createdAt: AT.toISOString(), updatedAt: AT.toISOString() };
    let state = "pending";
    const task = build(kis).collectBriefing(stock).then((value) => { state = "success"; return value; });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    const atDeadline = state;
    block.release();
    const actual = await task;
    const expected = await build(null).collectBriefing(stock);
    expect(atDeadline).toBe("success");
    expect(actual.missing).toContain("수급");
    expect(actual.investorFlow).toBeNull();
    expect({ ...actual, missing: [], notes: [] }).toEqual({ ...expected, missing: [], notes: [] });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("같은 인스턴스의 동시 토큰 발급을 공유하고 실패 후 명시적 재요청은 새 토큰을 받는다", async () => {
    clock();
    const block = blocked(token("offline-expired"), 200, "headers");
    let tokens = 0;
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      if (!String(input).includes("tokenP")) return json(quote);
      return ++tokens === 1 ? block.response : json(token("offline-new"));
    });
    const kis = provider(fakeFetch);
    let state = "pending";
    const tasks = Promise.allSettled([kis.getQuote("000660"), kis.getQuote("005930")]).then((value) => { state = "done"; return value; });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    const atDeadline = state;
    block.release();
    const results = await tasks;
    const retried = await kis.getQuote("000660");
    expect(atDeadline).toBe("done");
    expect(results.map((v) => v.status)).toEqual(["rejected", "rejected"]);
    expect(tokens).toBe(2);
    expect(retried.source).toBe("kis");
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("만료된 토큰 요청의 늦은 성공은 새 토큰 캐시를 덮지 않는다", async () => {
    clock();
    const block = blocked(token("offline-old"), 200, "headers");
    let tokens = 0;
    const authorizations: string[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("tokenP")) return ++tokens === 1 ? block.response : json(token("offline-new"));
      authorizations.push(new Headers(init?.headers).get("authorization")!);
      return json(quote);
    });
    const kis = provider(fakeFetch);
    let state = "pending";
    const first = kis.getQuote("000660").then(() => { state = "success"; }, () => { state = "failed"; });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    const atDeadline = state;
    // RED 경로가 끝없이 기다리지 않게, 수정 전에는 먼저 옛 응답을 해제한다.
    if (atDeadline === "pending") block.release();
    await first;
    await kis.getQuote("000660");
    if (atDeadline !== "pending") block.release();
    await vi.advanceTimersByTimeAsync(0);
    await kis.getQuote("005930");
    expect(atDeadline).toBe("failed");
    expect(tokens).toBe(2);
    expect(authorizations).toEqual(["Bearer offline-new", "Bearer offline-new"]);
  });

  it.each([401, 403])("HTTP %i 헤더 뒤 본문이 멈춰도 토큰을 무효화하고 다음 요청에서만 재발급한다", async (status) => {
    clock();
    const block = blocked({ msg1: "offline denied" }, status, "body");
    let tokens = 0, quotes = 0;
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("tokenP")) return json(token(`offline-${++tokens}`));
      return ++quotes === 1 ? block.response : json(quote);
    });
    const kis = provider(fakeFetch);
    let state = "pending";
    const first = kis.getQuote("000660").then(() => { state = "success"; }, () => { state = "failed"; });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    const observed = { state, tokens, quotes };
    block.release();
    await first;
    await kis.getQuote("000660");
    expect(observed).toEqual({ state: "failed", tokens: 1, quotes: 1 });
    expect({ tokens, quotes }).toEqual({ tokens: 2, quotes: 2 });
  });

  it("정상 자료·요청·토큰 TTL과 환경별 캐시는 그대로이며 성공에 대기 시간이 추가되지 않는다", async () => {
    clock();
    const calls: { url: string; init?: RequestInit }[] = [];
    let tokens = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return json(String(input).includes("tokenP") ? token(`offline-${++tokens}`, 120) : quote);
    }) as typeof fetch;
    const real = provider(fakeFetch);
    const mock = provider(fakeFetch, "mock");
    const result = await real.getQuote("000660");
    expect(Date.now()).toBe(AT.getTime());
    expect(result).toEqual({ code: "000660", currency: "KRW", price: 120000, change: -2000, changeRate: -1.64,
      open: 123000, high: 124000, low: 119000, prevClose: 122000, volume: 3456, marketCap: 120000000000,
      per: 12, pbr: 2, eps: 10000, bps: 60000, high52w: 140000, low52w: 80000, asOf: "2026-10-02T15:30:00+09:00", source: "kis" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ grant_type: "client_credentials", appkey: "offline-key", appsecret: "offline-secret" });
    expect(new Headers(calls[1]!.init?.headers).get("tr_id")).toBe("FHKST01010100");
    expect(new URL(calls[1]!.url).searchParams.get("FID_INPUT_ISCD")).toBe("000660");
    await real.getQuote("005930");
    expect(tokens).toBe(1);
    await mock.getQuote("000660");
    expect(tokens).toBe(2);
    expect(calls.some((c) => c.url.startsWith("https://openapivts.koreainvestment.com:29443"))).toBe(true);
    vi.setSystemTime(AT.getTime() + 59_999);
    await real.getQuote("000660");
    expect(tokens).toBe(2);
    vi.setSystemTime(AT.getTime() + 60_000);
    await real.getQuote("000660");
    expect(tokens).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("정상 동시 요청도 토큰 1회를 공유하고 160일 봉 페이지와 수급 값은 줄이지 않는다", async () => {
    clock();
    const rows = Array.from({ length: 160 }, (_, i) => ({
      stck_bsop_date: new Date(Date.UTC(2026, 8, 30) - i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""),
      stck_oprc: String(1000 + i), stck_hgpr: String(1100 + i), stck_lwpr: String(900 + i), stck_clpr: String(1050 + i), acml_vol: String(500 + i),
    }));
    const flows = [{ stck_bsop_date: "20260930", stck_clpr: "120000", prsn_ntby_qty: "-150", frgn_ntby_qty: "100", orgn_ntby_qty: "50" }];
    const urls: string[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname.includes("tokenP")) return json(token());
      if (url.pathname.includes("itemchartprice")) {
        const end = url.searchParams.get("FID_INPUT_DATE_2")!;
        return json({ rt_cd: "0", output2: rows.filter((r) => r.stck_bsop_date <= end).slice(0, 100) });
      }
      if (url.pathname.includes("inquire-investor")) return json({ rt_cd: "0", output: flows });
      return json(quote);
    });
    const kis = provider(fakeFetch);
    const [q, candles, flow] = await Promise.all([kis.getQuote("000660"), kis.getCandles("000660", "D", 160), kis.getInvestorFlow("000660", 10)]);
    expect(q.price).toBe(120000);
    expect(candles.candles).toEqual([...rows].reverse().map((r) => ({
      date: `${r.stck_bsop_date.slice(0, 4)}-${r.stck_bsop_date.slice(4, 6)}-${r.stck_bsop_date.slice(6)}`,
      open: Number(r.stck_oprc), high: Number(r.stck_hgpr), low: Number(r.stck_lwpr), close: Number(r.stck_clpr), volume: Number(r.acml_vol),
    })));
    expect(flow).toEqual([{ date: "2026-09-30", close: 120000, individual: -150, foreign: 100, institution: 50 }]);
    expect(urls.filter((u) => u.includes("tokenP"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("itemchartprice"))).toHaveLength(2);
    expect(urls.filter((u) => u.includes("itemchartprice")).every((u) => new URL(u).searchParams.get("FID_ORG_ADJ_PRC") === "0")).toBe(true);
    expect(Date.now()).toBe(AT.getTime());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("실패한 요청의 늦은 인증 헤더가 현재 재사용 가능한 토큰을 지우지 않는다", async () => {
    clock();
    const block = blocked({ msg1: "offline denied" }, 401, "headers");
    let tokens = 0, quotes = 0;
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("tokenP")) return json(token(`offline-${++tokens}`));
      return ++quotes === 1 ? block.response : json(quote);
    });
    const kis = provider(fakeFetch);
    const first = kis.getQuote("000660").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await first;
    await kis.getQuote("000660");
    block.release();
    await vi.advanceTimersByTimeAsync(0);
    await kis.getQuote("005930");
    expect(tokens).toBe(1);
    expect(quotes).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["token-network", "token-empty", "token-json", "quote-network", "quote-json", "quote-api"])("%s 오류는 추가 대기·자동 재시도 없이 fallback하고 타이머를 정리한다", async (failure) => {
    clock();
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      const isToken = String(input).includes("tokenP");
      if ((isToken && failure === "token-network") || (!isToken && failure === "quote-network")) throw new Error("offline network failure");
      if ((isToken && failure === "token-json") || (!isToken && failure === "quote-json")) return new Response("invalid-json");
      if (isToken && failure === "token-empty") return json({});
      if (!isToken && failure === "quote-api") return json({ rt_cd: "1", msg_cd: "OFFLINE", msg1: "offline API error" });
      return json(isToken ? token() : quote);
    });
    const fallback = new FakeQuoteProvider("offline-fallback");
    const result = await new QuoteProviderChain([provider(fakeFetch), fallback]).getQuote("000660");
    expect(result).toEqual(await new FakeQuoteProvider("offline-fallback").getQuote("000660"));
    expect(fakeFetch).toHaveBeenCalledTimes(failure.startsWith("token") ? 1 : 2);
    expect(fallback.calls).toBe(1);
    expect(Date.now()).toBe(AT.getTime());
    expect(vi.getTimerCount()).toBe(0);
  });
});
