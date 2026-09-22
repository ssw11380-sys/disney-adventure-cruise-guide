import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import { aggregateCandles, TossOpenApiClient, TossOpenApiProvider, toCandle } from "../src/providers/market/tossOpenApi.js";
import { TossRealtime, type SocketLike } from "../src/providers/market/tossRealtime.js";
import { StockService } from "../src/services/stockService.js";
import { TossSyncService } from "../src/services/tossSyncService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";

const NOW = () => new Date("2026-09-22T14:00:00+09:00"); // 장중

function daily(n: number, base = 200000): unknown[] {
  // 최신순 n개 일봉 (2026-09-22 부터 거슬러, 주말 포함 단순화)
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 8, 22) - i * 86_400_000).toISOString().slice(0, 10);
    const c = base + (n - i) * 100;
    out.push({ timestamp: `${d}T00:00:00+09:00`, openPrice: String(c - 500), highPrice: String(c + 1000), lowPrice: String(c - 1200), closePrice: String(c), volume: "1000", currency: "KRW" });
  }
  return out;
}

interface Call { method: string; url: string; headers: Record<string, string>; body: string | null }

function fakeFetch(opts: { calls?: Call[]; tokenStatus?: number; priceStatus?: number; first429?: boolean; candlePages?: number } = {}): typeof fetch {
  const calls = opts.calls ?? [];
  let tokenCount = 0;
  let served429 = false;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? init.body : null });
    const ok = (body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...extra } });
    const err = (status: number, code: string, message = "") => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/oauth2/token")) {
      tokenCount++;
      if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response(JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed: client_secret" }), { status: opts.tokenStatus });
      return ok({ access_token: `tok-${tokenCount}`, token_type: "Bearer", expires_in: 86400 });
    }
    if (!headers["authorization"]?.startsWith("Bearer tok-")) return err(401, "edge-blocked");
    if (opts.first429 && !served429 && url.includes("/api/v1/prices")) {
      served429 = true;
      return new Response(JSON.stringify({ error: { code: "rate-limit-exceeded" } }), { status: 429, headers: { "retry-after": "1" } });
    }
    if (url.includes("/api/v1/prices")) {
      if (opts.priceStatus === 403) return err(403, "edge-blocked", "허용되지 않은 요청입니다.");
      if (opts.priceStatus === 401) {
        // 첫 토큰은 만료 취급, 두 번째 토큰부터 정상
        if (headers["authorization"] === "Bearer tok-1") return err(401, "expired-token");
      }
      const symbols = new URL(url).searchParams.get("symbols")!.split(",");
      return ok({
        result: symbols.map((s) =>
          s === "TSLA"
            ? { symbol: "TSLA", timestamp: "2026-09-22T13:59:00.000+09:00", lastPrice: "377.5", currency: "USD" }
            : { symbol: s, timestamp: "2026-09-22T13:59:30.123+09:00", lastPrice: "201500", currency: "KRW" },
        ),
      });
    }
    if (url.includes("/api/v1/candles")) {
      const u = new URL(url);
      const symbol = u.searchParams.get("symbol")!;
      const count = Number(u.searchParams.get("count") ?? 100);
      const before = u.searchParams.get("before");
      if (symbol === "TSLA") {
        // 미국: 뉴욕 자정, 오늘(9/22 뉴욕) 봉은 아직 없고 9/21 이 마지막
        return ok({
          result: {
            candles: [
              { timestamp: "2026-09-21T00:00:00-04:00", openPrice: "371.63", highPrice: "378.36", lowPrice: "371.07", closePrice: "375.3", volume: "36599609", currency: "USD" },
              { timestamp: "2026-09-18T00:00:00-04:00", openPrice: "369", highPrice: "370.9", lowPrice: "360.75", closePrice: "364.27", volume: "51922256", currency: "USD" },
            ],
            nextBefore: null,
          },
        });
      }
      const pages = opts.candlePages ?? 1;
      const all = daily(200 * pages);
      const start = before ? all.findIndex((c) => (c as { timestamp: string }).timestamp.startsWith(before.slice(0, 10))) : 0;
      const slice = all.slice(Math.max(start, 0), Math.max(start, 0) + count);
      const last = slice.at(-1) as { timestamp: string } | undefined;
      const hasMore = start + count < all.length;
      return ok({ result: { candles: slice, nextBefore: hasMore && last ? last.timestamp : null } });
    }
    if (url.includes("/api/v1/stocks/all")) {
      const market = new URL(url).searchParams.get("market");
      const rows: Record<string, unknown[]> = {
        KOSPI: [
          { symbol: "005930", name: "삼성전자", securityType: "STOCK", isCommonShare: true, isinCode: "KR7005930003" },
          { symbol: "0162Z0", name: "RISE 삼성전자SK하이닉스채권혼합50", securityType: "ETF", isCommonShare: true, isinCode: "KR70162Z0000" },
        ],
        KOSDAQ: [{ symbol: "247540", name: "에코프로비엠", securityType: "STOCK", isCommonShare: true, isinCode: "KR7247540008" }],
        NYSE: [{ symbol: "KO", name: "코카콜라", securityType: "FOREIGN_STOCK", isCommonShare: true, isinCode: "US1912161007" }],
        NASDAQ: [
          { symbol: "TSLA", name: "테슬라", securityType: "FOREIGN_STOCK", isCommonShare: true, isinCode: "US88160R1014" },
          { symbol: "QQQ", name: "QQQ", securityType: "FOREIGN_ETF", isCommonShare: true, isinCode: "US46090E1038" },
        ],
        AMEX: [],
      };
      return ok({ result: rows[market ?? ""] ?? [] });
    }
    if (url.includes("/api/v1/stocks?")) {
      const symbols = new URL(url).searchParams.get("symbols")!.split(",");
      return ok({
        result: symbols.map((s) =>
          s === "TSLA"
            ? { symbol: "TSLA", name: "테슬라", market: "NASDAQ", securityType: "FOREIGN_STOCK", status: "ACTIVE", currency: "USD", sharesOutstanding: "3949547394" }
            : { symbol: s, name: "NAVER", market: "KOSPI", securityType: "STOCK", status: "ACTIVE", currency: "KRW", sharesOutstanding: "152094369" },
        ),
      });
    }
    if (url.includes("/investor-trading")) {
      return ok({
        result: {
          nextUntil: "2026-09-18",
          records: [
            { date: "2026-09-22", updatedAt: "x", individual: null, foreigner: { netBuyVolume: "119900" }, institution: { netBuyVolume: "-113200" }, otherCorporation: null },
            { date: "2026-09-21", updatedAt: "x", individual: { netBuyVolume: "291850" }, foreigner: { netBuyVolume: "-319700" }, institution: { netBuyVolume: "37900" }, otherCorporation: {} },
          ],
        },
      });
    }
    if (url.includes("/api/v1/exchange-rate")) return ok({ result: { baseCurrency: "USD", quoteCurrency: "KRW", rate: "1390.5", midRate: "1384.3" } });
    if (url.includes("/api/v1/accounts")) return ok({ result: [{ accountNo: "123", accountSeq: 3, accountType: "BROKERAGE" }, { accountNo: "456", accountSeq: 7, accountType: "BROKERAGE" }] });
    if (url.includes("/api/v1/holdings")) {
      const seq = headers["x-tossinvest-account"];
      return ok({
        result: {
          items:
            seq === "3"
              ? [
                  { symbol: "035420", name: "NAVER", marketCountry: "KR", currency: "KRW", quantity: "9", lastPrice: "201500", averagePurchasePrice: "232555" },
                  { symbol: "TSLA", name: "테슬라", marketCountry: "US", currency: "USD", quantity: "2", lastPrice: "377.5", averagePurchasePrice: "300" },
                ]
              : [{ symbol: "TSLA", name: "테슬라", marketCountry: "US", currency: "USD", quantity: "2", lastPrice: "377.5", averagePurchasePrice: "340" }],
        },
      });
    }
    return err(404, "edge-blocked", "요청한 API 경로를 지원하지 않습니다.");
  }) as typeof fetch;
}

function client(opts: Parameters<typeof fakeFetch>[0] = {}, calls: Call[] = []) {
  return new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn: fakeFetch({ ...opts, calls }), now: NOW, maxRetryWaitMs: 0 });
}

describe("TossOpenApiClient", () => {
  it("토큰을 form 으로 발급받고 Bearer 로 호출하며, 만료 401 이면 한 번 재발급한다", async () => {
    const calls: Call[] = [];
    const c = client({ priceStatus: 401 }, calls);
    const r = await c.get<unknown[]>("/api/v1/prices", { symbols: "035420" });
    expect(r).toHaveLength(1);
    const tokenCalls = calls.filter((x) => x.url.endsWith("/oauth2/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCalls[0]!.body).toBe("grant_type=client_credentials&client_id=c_1&client_secret=s_1");
    expect(calls.filter((x) => x.url.includes("/prices")).map((x) => x.headers["authorization"])).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(c.status.lastOkAt).not.toBeNull();
  });

  it("429 는 Retry-After 뒤 한 번 재시도한다", async () => {
    const calls: Call[] = [];
    const r = await client({ first429: true }, calls).get<unknown[]>("/api/v1/prices", { symbols: "035420" });
    expect(r).toHaveLength(1);
    expect(calls.filter((x) => x.url.includes("/prices"))).toHaveLength(2);
  });

  it("403 은 허용 IP 안내와 함께 ProviderError, 상태에 ipBlocked 가 남는다", async () => {
    const c = client({ priceStatus: 403 });
    await expect(c.get("/api/v1/prices", { symbols: "035420" })).rejects.toThrow(/허용 IP/);
    expect(c.status.ipBlocked).toBe(true);
    expect(c.status.lastError).toContain("edge-blocked");
  });

  it("client_secret 오류는 error_description 을 담아 실패한다", async () => {
    await expect(client({ tokenStatus: 401 }).getToken()).rejects.toThrow(/client_secret/);
  });
});

describe("TossOpenApiProvider", () => {
  it("한국 현재가: 통합 가격, 오늘 봉으로 시고저·거래량, 전일 종가로 등락, 발행주식수로 시총", async () => {
    const p = new TossOpenApiProvider(client(), { now: NOW });
    const q = await p.getQuote("035420");
    expect(q.source).toBe("toss-openapi");
    expect(q.price).toBe(201500);
    expect(q.currency).toBe("KRW");
    expect(q.prevClose).toBe(200000 + 199 * 100); // 어제 봉 종가
    expect(q.change).toBe(201500 - q.prevClose!);
    expect(q.open).toBe(220000 - 500);
    expect(q.volume).toBe(1000);
    expect(q.marketCap).toBe(201500 * 152094369);
    expect(q.priceBasis).toBe("KRX+NXT 통합");
    expect(q.high52w).toBeGreaterThan(q.low52w!);
    expect(q.asOf).toBe("2026-09-22T13:59:30.123+09:00");
  });

  it("미국 현재가: 오늘 봉이 아직 없으면 마지막 봉이 전일이고, 원화 환산이 붙는다", async () => {
    const q = await new TossOpenApiProvider(client(), { now: NOW }).getQuote("tsla");
    expect(q.code).toBe("TSLA");
    expect(q.currency).toBe("USD");
    expect(q.price).toBe(377.5);
    expect(q.prevClose).toBe(375.3);
    expect(q.change).toBe(2.2);
    expect(q.open).toBeNull(); // 오늘 봉 없음
    expect(q.priceKrw).toBe(Math.round(377.5 * 1384.3));
    expect(q.priceBasis).toContain("시간외");
  });

  it("일봉은 페이지를 이어 받고 주봉·월봉은 일봉을 묶어 만든다", async () => {
    const calls: Call[] = [];
    const p = new TossOpenApiProvider(client({ candlePages: 2 }, calls), { now: NOW });
    const d = await p.getCandles("035420", "D", 300);
    expect(d.candles).toHaveLength(300);
    expect(d.candles[0]!.date < d.candles.at(-1)!.date).toBe(true);
    expect(calls.filter((c) => c.url.includes("/candles")).length).toBe(2);
    const w = await p.getCandles("035420", "W", 4);
    expect(w.candles).toHaveLength(4);
    expect(w.candles.at(-1)!.date).toBe("2026-09-21"); // 월요일 시작 주의 첫 거래일
    const m = await p.getCandles("035420", "M", 2);
    expect(m.candles.map((c) => c.date.slice(0, 7))).toEqual(["2026-08", "2026-09"]);
  });

  it("aggregateCandles 는 고가·저가·거래량을 합치고 종가는 마지막 값", () => {
    const daily = [
      { date: "2026-09-14", open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { date: "2026-09-15", open: 11, high: 15, low: 10, close: 14, volume: 2 },
      { date: "2026-09-21", open: 14, high: 16, low: 13, close: 15, volume: 3 },
    ];
    expect(aggregateCandles(daily, "W")).toEqual([
      { date: "2026-09-14", open: 10, high: 15, low: 9, close: 14, volume: 3 },
      { date: "2026-09-21", open: 14, high: 16, low: 13, close: 15, volume: 3 },
    ]);
    expect(toCandle({ timestamp: "2026-09-22T00:00:00-04:00", openPrice: "1", highPrice: "2", lowPrice: "0.5", closePrice: "1.5", volume: "9" }, false)).toEqual({ date: "2026-09-22", open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 });
  });

  it("수급은 순매수 수량과 그날 종가를 준다", async () => {
    const flow = await new TossOpenApiProvider(client(), { now: NOW }).getInvestorFlow("035420", 2);
    expect(flow).toEqual([
      { date: "2026-09-22", close: 220000, individual: null, foreign: 119900, institution: -113200 },
      { date: "2026-09-21", close: 219900, individual: 291850, foreign: -319700, institution: 37900 },
    ]);
    await expect(new TossOpenApiProvider(client(), { now: NOW }).getInvestorFlow("TSLA", 2)).rejects.toBeInstanceOf(ProviderError);
  });

  it("종목 마스터는 한국·미국 5개 마켓을 합치고 ETF 를 구분한다", async () => {
    const rows = await new TossOpenApiProvider(client(), { now: NOW }).fetchAll();
    expect(rows.map((r) => [r.code, r.name, r.market, r.groupCode])).toEqual([
      ["005930", "삼성전자", "KOSPI", "ST"],
      ["0162Z0", "RISE 삼성전자SK하이닉스채권혼합50", "KOSPI", "EF"],
      ["247540", "에코프로비엠", "KOSDAQ", "ST"],
      ["KO", "코카콜라", "NYSE", "ST"],
      ["TSLA", "테슬라", "NASDAQ", "ST"],
      ["QQQ", "QQQ", "NASDAQ", "EF"],
    ]);
  }, 10_000);
});

describe("TossSyncService", () => {
  it("보유 종목을 등록 종목으로 가져오고, 여러 계좌는 합산한다", async () => {
    const db = await createMigratedDb(":memory:");
    const p = new TossOpenApiProvider(client(), { now: NOW });
    const service = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), now: NOW });
    await service.refreshMaster();
    await service.register({ code: "005930", quantity: 1, avgPrice: 70000, memo: "메모 유지" });
    const r = await new TossSyncService(db, p, NOW).importHoldings();
    expect(r.accounts).toBe(2);
    expect(r.added.sort()).toEqual(["035420", "TSLA"]);
    expect(r.updated).toEqual([]);
    const list = await service.list();
    const tsla = list.find((s) => s.code === "TSLA")!;
    expect(tsla).toMatchObject({ name: "테슬라", market: "NASDAQ", quantity: 4, avgPrice: 320 }); // (300*2 + 340*2) / 4
    expect(list.find((s) => s.code === "035420")).toMatchObject({ name: "NAVER", quantity: 9, avgPrice: 232555 });
    expect(list.find((s) => s.code === "005930")).toMatchObject({ quantity: 1, memo: "메모 유지" }); // 토스에 없는 종목은 그대로
    // 두 번째 실행은 변화 없음
    const r2 = await new TossSyncService(db, p, NOW).importHoldings();
    expect(r2.added).toEqual([]);
    expect(r2.unchanged.sort()).toEqual(["035420", "TSLA"]);
    await db.destroy();
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

describe("TossRealtime", () => {
  it("연결 후 종목을 시장별로 선언하고, 체결 메시지를 마지막 체결가로 보관한다", async () => {
    const sockets: FakeSocket[] = [];
    const headers: Record<string, string>[] = [];
    const rt = new TossRealtime(client(), {
      socketFactory: (_url, h) => {
        headers.push(h);
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      pingIntervalMs: 5,
    });
    rt.start();
    rt.setCodes(["035420", "tsla", "005930"]);
    await new Promise((r) => setTimeout(r, 10)); // 토큰 발급 대기
    expect(headers[0]!["authorization"]).toBe("Bearer tok-1");
    const s = sockets[0]!;
    s.emit("open");
    const decl = JSON.parse(s.sent[0]!) as Array<Record<string, unknown>>;
    expect(decl.slice(1)).toEqual([
      { type: "trade:kr", codes: ["035420", "005930"] },
      { type: "trade:us", codes: ["TSLA"] },
    ]);
    s.emit("message", JSON.stringify({ type: "subscriptions", subscribed: ["trade:kr:035420", "trade:kr:005930", "trade:us:TSLA"], rejected: [] }));
    s.emit("message", JSON.stringify({ type: "message", topic: "trade:us:TSLA", data: { price: "378.12", volume: "8", timestamp: "2026-09-22T23:30:00.000+09:00", currency: "USD" } }));
    s.emit("message", JSON.stringify({ type: "pong" }));
    expect(rt.get("tsla")).toMatchObject({ code: "TSLA", price: 378.12, volume: 8, timestamp: "2026-09-22T23:30:00.000+09:00" });
    expect(rt.status()).toMatchObject({ connected: true, subscribed: ["trade:kr:035420", "trade:kr:005930", "trade:us:TSLA"] });
    await new Promise((r) => setTimeout(r, 12));
    expect(s.sent.filter((x) => x === "PING").length).toBeGreaterThan(0);

    // 종목이 바뀌면 전체를 다시 선언하고, 빠진 종목의 체결가는 버린다
    rt.setCodes(["005930"]);
    const decl2 = JSON.parse(s.sent.at(-1)!) as Array<Record<string, unknown>>;
    expect(decl2.slice(1)).toEqual([{ type: "trade:kr", codes: ["005930"] }]);
    expect(rt.get("TSLA")).toBeNull();
    rt.stop();
    expect(s.closed).toBe(true);
    expect(rt.status().connected).toBe(false);
  });
});

describe("StockService + 실시간", () => {
  it("실시간 체결이 스냅샷보다 새로우면 현재가·등락을 덮어쓰고 live 표시를 붙인다", async () => {
    const db = await createMigratedDb(":memory:");
    const ticks = new Map([["000660", { code: "000660", price: 101500, volume: 10, timestamp: "2026-09-22T14:30:00+09:00", receivedAt: 0 }]]);
    const live = { get: (c: string) => ticks.get(c) ?? null, setCodes: () => {}, status: () => ({ enabled: true, connected: true, subscribed: [], lastMessageAt: null, lastError: null }) };
    const service = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, now: NOW });
    const q = await service.getQuote("000660"); // 가짜 시세: 100,000원, 전일 99,000, asOf 09:00
    expect(q).toMatchObject({ price: 101500, change: 2500, changeRate: 2.53, live: true, asOf: "2026-09-22T14:30:00+09:00", high: 101500 });
    ticks.set("000660", { code: "000660", price: 100500, volume: 1, timestamp: "2026-09-22T08:00:00+09:00", receivedAt: 0 }); // 스냅샷보다 오래된 체결은 무시
    expect((await service.getQuote("000660")).live).toBeUndefined();
    await db.destroy();
  });

  it("웹소켓이 없으면 REST 일괄 조회로 덮어쓰되, 같은 가격 기준(toss 계열) 스냅샷에만 적용한다", async () => {
    const db = await createMigratedDb(":memory:");
    const calls: string[][] = [];
    const quick = {
      name: "toss",
      getMany: async (codes: string[]) => {
        calls.push(codes);
        return new Map(codes.map((c) => [c, { code: c, price: 102000, volume: null, timestamp: "2026-09-22T14:30:00+09:00", receivedAt: 0 }]));
      },
    };
    const fromToss = new StockService({ db, quotes: new FakeQuoteProvider("toss"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), quickPrices: quick, now: NOW });
    await fromToss.refreshMaster();
    await fromToss.register({ code: "000660" });
    await fromToss.register({ code: "005930" });
    const list = await fromToss.listWithQuotes();
    expect(calls).toEqual([["000660", "005930"]]); // 목록 전체를 요청 1개로
    expect(list.map((s) => [s.quote!.price, s.quote!.live])).toEqual([[102000, true], [102000, true]]);
    expect(list[0]!.evaluation).toBeNull();

    const fromNaver = new StockService({ db, quotes: new FakeQuoteProvider("naver"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), quickPrices: quick, now: NOW });
    const q = await fromNaver.getQuote("000660", { fresh: true });
    expect(q.price).toBe(100000); // 네이버 정규장 종가에는 통합 가격을 섞지 않는다
    expect(q.live).toBeUndefined();
    await db.destroy();
  });
});
