import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import { aggregateCandles, TossOpenApiClient, TossOpenApiProvider, toCandle } from "../src/providers/market/tossOpenApi.js";
import { TossRealtime, type SocketLike } from "../src/providers/market/tossRealtime.js";
import { StockService } from "../src/services/stockService.js";
import { TossSyncService } from "../src/services/tossSyncService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";
import { client, fakeFetch, NOW, type Call } from "./tossFake.js";


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

  it("한국 종목은 기준가(krBase)를 주면 그 값을 전일 종가로 쓴다 — 토스 앱과 같은 등락 (일봉 종가는 NXT 포함 통합 종가)", async () => {
    const p = new TossOpenApiProvider(client(), { now: NOW, krBase: async () => 199_500 });
    const q = await p.getQuote("035420");
    expect(q).toMatchObject({ prevClose: 199_500, change: 2_000, changeRate: 1 });
    // 상장 첫날도 기준가(공모가)가 있으면 공식 API 로 바로 답한다
    const first = await new TossOpenApiProvider(client(), { now: NOW, krBase: async () => 12_000 }).getQuote("0010S0");
    expect(first).toMatchObject({ prevClose: 12_000, change: 201_500 - 12_000 });
    // 기준가를 못 받으면 예전처럼 일봉으로
    const fallback = await new TossOpenApiProvider(client(), { now: NOW, krBase: async () => { throw new Error("down"); } }).getQuote("035420");
    expect(fallback.prevClose).toBe(200000 + 199 * 100);
    // 미국 종목에는 쓰지 않는다
    const us = await new TossOpenApiProvider(client(), { now: NOW, krBase: async () => 1 }).getQuote("tsla");
    expect(us.prevClose).toBe(375.3);
  });

  it("기준가가 늦으면 짧게만 기다리고 일봉으로 답한다 (토스 웹이 멈춰도 시세가 멈추지 않게)", async () => {
    const slow = new TossOpenApiProvider(client(), { now: NOW, krBase: () => new Promise<number>((r) => setTimeout(() => r(199_500), 5_000)) });
    const t0 = Date.now();
    const q = await slow.getQuote("035420");
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(q.prevClose).toBe(200000 + 199 * 100);
  }, 10_000);

  it("상장 첫날(전일 봉 없음)은 등락 0 으로 만들지 않고 실패해 다음 소스(기준가)로 넘긴다", async () => {
    await expect(new TossOpenApiProvider(client(), { now: NOW }).getQuote("0010S0")).rejects.toThrow(/전일 종가 없음 \(상장 첫날\)/);
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

describe("토스 연동 종목 잠금 (3-10)", () => {
  async function setup() {
    const db = await createMigratedDb(":memory:");
    const p = new TossOpenApiProvider(client(), { now: NOW });
    const search = new FakeSearchProvider([{ code: "035420", name: "NAVER", market: "KOSPI", isinCode: "KR7035420009", groupCode: "ST" }]);
    const service = new StockService({ db, quotes: new FakeQuoteProvider("x"), search, master: new FakeMasterProvider(), tossOpenApi: p, now: NOW });
    await service.refreshMaster();
    await service.register({ code: "005930", quantity: 1, avgPrice: 70000 }); // 토스 밖 종목
    const sync = new TossSyncService(db, p, NOW);
    await sync.importHoldings();
    return { db, service, sync };
  }

  it("토스 종목은 수량·평단을 바꿀 수 없고(409 TOSS_LOCKED) 메모는 바꿀 수 있다. 토스 밖 종목은 그대로 수정", async () => {
    const { db, service } = await setup();
    await expect(service.update("035420", { quantity: 1 })).rejects.toMatchObject({ statusCode: 409, code: "TOSS_LOCKED" });
    await expect(service.update("TSLA", { avgPrice: 1 })).rejects.toMatchObject({ code: "TOSS_LOCKED" });
    await expect(service.update("035420", { quantity: 9, avgPrice: 232555, memo: "메모" })).resolves.toMatchObject({ memo: "메모", quantity: 9 }); // 같은 값은 통과
    await expect(service.update("005930", { quantity: 3, avgPrice: 71000 })).resolves.toMatchObject({ quantity: 3, avgPrice: 71000 });
    const list = await service.listWithQuotes();
    expect(Object.fromEntries(list.map((s) => [s.code, s.tossSynced]))).toEqual({ "005930": false, "035420": true, TSLA: true });
    await db.destroy();
  });

  it("토스 종목을 지우면 동기화에서 빠져 동기화를 여러 번 해도 다시 나타나지 않고, 다시 등록하면 다시 맞춘다", async () => {
    const { db, service, sync } = await setup();
    expect(await service.remove("035420")).toEqual({ tossExcluded: true });
    for (let i = 0; i < 3; i++) {
      const r = await sync.importHoldings();
      expect(r.excluded).toEqual(["035420"]);
      expect(r.added).toEqual([]);
    }
    expect((await service.list()).map((s) => s.code).sort()).toEqual(["005930", "TSLA"]);
    expect(await service.remove("005930")).toEqual({ tossExcluded: false });
    // 다시 등록 → 다음 동기화가 토스 값으로 맞춘다
    await service.register({ code: "035420" });
    const r = await sync.importHoldings();
    expect(r.updated).toEqual(["035420"]);
    expect(await service.get("035420")).toMatchObject({ quantity: 9, avgPrice: 232555 });
    await db.destroy();
  });

  it("토스 연동이 꺼져 있거나(키 없음·동기화 0분) 동기화가 3시간 넘게 멈췄으면 잠그지 않는다", async () => {
    const { db } = await setup();
    const plain = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), now: NOW });
    await expect(plain.update("035420", { quantity: 1 })).resolves.toMatchObject({ quantity: 1 });
    const p = new TossOpenApiProvider(client(), { now: NOW });
    const off = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), tossOpenApi: p, tossSyncMinutes: 0, now: NOW });
    expect((await off.tossSynced()).size).toBe(0);
    const later = new StockService({ db, quotes: new FakeQuoteProvider("x"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), tossOpenApi: p, now: () => new Date(NOW().getTime() + 4 * 3_600_000) });
    expect((await later.tossSynced()).size).toBe(0);
    await db.destroy();
  });

  it("동기화에서 뺀 종목을 토스에서 전량 매도하면 제외 목록에서도 빠진다 (다시 사면 다시 가져옴)", async () => {
    const { db, service, sync } = await setup();
    await service.remove("TSLA");
    const row = () => db.selectFrom("meta").select("value").where("key", "=", "toss_sync_excluded").executeTakeFirst();
    expect((await row())?.value).toBe(JSON.stringify(["TSLA"]));
    // 토스 보유에서 TSLA 가 사라진 동기화
    const p2 = new TossOpenApiProvider(client(), { now: NOW });
    const origin = p2.holdingsWithOverview.bind(p2);
    p2.holdingsWithOverview = async (seq: number) => {
      const r = await origin(seq);
      const items = r.items.filter((h) => h.code !== "TSLA");
      // 전량 매도해 빈 계좌는 요약의 매입금액도 0 이다 (요약과 맞지 않는 빈 응답은 일시 오류로 보고 한 번 미룬다)
      return { items, overview: items.length ? r.overview : { ...r.overview, purchaseKrw: 0, purchaseUsd: 0 } };
    };
    await new TossSyncService(db, p2, NOW).importHoldings();
    expect((await row())?.value).toBe("[]");
    // 다시 보유 → 다시 들어온다
    const r = await sync.importHoldings();
    expect(r.added).toEqual(["TSLA"]);
    await db.destroy();
  });

  it("동시에 삭제·동기화해도 지운 종목이 되살아나지 않는다", async () => {
    const { db, service, sync } = await setup();
    await Promise.all([sync.importHoldings(), service.remove("035420"), sync.importHoldings()]);
    expect((await service.list()).map((s) => s.code)).not.toContain("035420");
    await db.destroy();
  });
});

describe("TossOpenApiProvider 원화 장부용 조회", () => {
  const make = (handler: (url: URL, headers: Record<string, string>) => Response | null) =>
    new TossOpenApiProvider(
      new TossOpenApiClient({
        clientId: "c",
        clientSecret: "s",
        now: NOW,
        maxRetryWaitMs: 0,
        fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 86400 }), { status: 200 });
          const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
          return handler(url, headers) ?? new Response(JSON.stringify({ error: { code: "not-found" } }), { status: 404 });
        }) as typeof fetch,
      }),
      { now: NOW },
    );
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("그 분의 환율이 없으면(404) 조금 앞 시각으로 다시 찾는다", async () => {
    const asked: string[] = [];
    const p = make((url) => {
      if (!url.pathname.endsWith("/exchange-rate")) return null;
      const t = url.searchParams.get("dateTime")!;
      asked.push(t);
      return asked.length === 1 ? json({ error: { code: "exchange-rate-not-found", message: "요청한 시점의 환율 정보가 없습니다." } }, 404) : json({ result: { rate: "1391.2" } });
    });
    expect(await p.usdKrwAt("2026-09-22T23:00:00+09:00")).toBe(1391.2);
    expect(asked).toEqual(["2026-09-22T23:00:00+09:00", "2026-09-22T22:59:00+09:00"]);
  });

  it("429 같은 다른 오류는 그대로 던진다 (장부가 다음 동기화에서 다시)", async () => {
    const p = make((url) => (url.pathname.endsWith("/exchange-rate") ? json({ error: { code: "internal-error" } }, 500) : null));
    await expect(p.usdKrwAt("2026-09-22T23:00:00+09:00")).rejects.toThrow("HTTP 500");
  });

  it("보유 응답 본문이 비면 던지고, 달러 요약이 빠지면 purchaseUsd 는 null, 수익률 보정은 끈다", async () => {
    let body: unknown = { result: null };
    const p = make((url) => (url.pathname.endsWith("/holdings") ? json(body) : null));
    await expect(p.holdingsWithOverview(1)).rejects.toThrow("보유 종목 응답이 비었습니다");
    body = { result: { items: [], profitLoss: { rateAfterCost: "0.01" } } };
    const r = await p.holdingsWithOverview(1);
    expect(r.overview).toMatchObject({ purchaseUsd: null, rateAfterCost: null });
    body = { result: { items: [], totalPurchaseAmount: { krw: "0", usd: "0" }, marketValue: { amountAfterCost: { krw: "0", usd: "0" } }, profitLoss: { rateAfterCost: "0" } } };
    expect((await p.holdingsWithOverview(1)).overview).toMatchObject({ purchaseUsd: 0, rateAfterCost: 0 });
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

describe("TossRealtime 내 주문 체결 구독", () => {
  it("종목이 없어도 계좌를 알면 연결해 personal:order 를 구독하고, 100토픽 한도 안에서 계좌 몫을 먼저 뺀다", async () => {
    const sockets: FakeSocket[] = [];
    const rt = new TossRealtime(client(), {
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      pingIntervalMs: 1000,
    });
    rt.start();
    expect(sockets.length).toBe(0); // 종목도 계좌도 없으면 연결하지 않는다
    rt.setAccounts([3]);
    await new Promise((r) => setTimeout(r, 10));
    const s = sockets[0]!;
    s.emit("open");
    expect((JSON.parse(s.sent.at(-1)!) as Array<Record<string, unknown>>).slice(1)).toEqual([{ type: "personal:order", codes: ["3"] }]);
    const orders: unknown[] = [];
    rt.on("order", (d) => orders.push(d));
    s.emit("message", JSON.stringify({ type: "message", topic: "personal:order:3", data: { event: "FILL", accountSeq: 3 } }));
    expect(orders).toEqual([{ event: "FILL", accountSeq: 3 }]);

    // 종목 100개 + 계좌 1개 → 종목은 99개만 선언한다
    const codes = Array.from({ length: 100 }, (_, i) => String(100000 + i));
    rt.setCodes(codes);
    const decl = JSON.parse(s.sent.at(-1)!) as Array<{ type?: string; codes?: string[] }>;
    const topics = decl.slice(1).reduce((n, d) => n + (d.codes?.length ?? 0), 0);
    expect(topics).toBe(100);
    expect(decl.find((d) => d.type === "personal:order")?.codes).toEqual(["3"]);
    rt.stop();
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

describe("분봉 (Open API 1m → 5m/30m)", () => {
  it("aggregateIntraday 는 현지 시각을 step 분 단위로 묶고, localIso 는 오프셋을 붙인다", async () => {
    const { aggregateIntraday, localIso } = await import("../src/providers/market/tossOpenApi.js");
    expect(localIso("2026-09-23T01:25:00Z", true)).toBe("2026-09-23T10:25:00+09:00");
    expect(localIso("2026-09-22T13:30:00Z", false)).toBe("2026-09-22T09:30:00-04:00");
    const m = (t: string, o: number, c: number, v = 1) => ({ date: t.slice(0, 10), time: t, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: v });
    const out = aggregateIntraday(
      [m("2026-09-23T10:21:00+09:00", 10, 11), m("2026-09-23T10:24:00+09:00", 11, 13), m("2026-09-23T10:25:00+09:00", 13, 12), m("2026-09-23T10:29:00+09:00", 12, 15)],
      5,
    );
    expect(out.map((c) => c.time)).toEqual(["2026-09-23T10:20:00+09:00", "2026-09-23T10:25:00+09:00"]);
    expect(out[0]).toMatchObject({ open: 10, close: 13, high: 14, low: 9, volume: 2 });
    expect(out[1]).toMatchObject({ open: 13, close: 15, high: 16, low: 11, volume: 2 });
  });
});

describe("TossOpenApiProvider 일괄 현재가 (3-9)", () => {
  const CODES = ["035420", "005930", "000660", "TSLA"];
  it("현재가는 요청 1번, 일봉은 거래일마다 종목별 한 번(같은 날엔 1분마다 최근 3개만), 기준가는 일괄 1번", async () => {
    const calls: Call[] = [];
    let t = Date.parse("2026-09-22T10:00:00+09:00");
    const baseCalls: string[][] = [];
    const p = new TossOpenApiProvider(client({ candlePages: 2 }, calls), {
      now: () => new Date(t),
      krBaseMany: async (codes) => {
        baseCalls.push(codes);
        return new Map(codes.map((c) => [c, 199_500]));
      },
    });
    const count = (part: string) => calls.filter((c) => c.url.includes(part)).length;
    const candleCounts = () => calls.filter((c) => c.url.includes("/candles")).map((c) => Number(new URL(c.url).searchParams.get("count")));
    const r = await p.getQuotes(CODES);
    expect([...r.keys()]).toEqual(CODES);
    expect([...r.values()].every((q) => !(q instanceof Error))).toBe(true);
    expect(count("/api/v1/prices")).toBe(1);
    expect(new URL(calls.find((c) => c.url.includes("/prices"))!.url).searchParams.get("symbols")).toBe(CODES.join(","));
    expect(baseCalls).toEqual([["035420", "005930", "000660"]]);
    const first = count("/candles");
    expect(first).toBe(7); // 한국 3종목 × 2페이지(260개) + 미국 1페이지
    expect(r.get("035420")).toMatchObject({ prevClose: 199_500, prevCloseBasis: "base" });

    // 30초 뒤: 일봉 요청 없음
    t += 30_000;
    await p.getQuotes(CODES);
    expect(count("/candles")).toBe(first);
    expect(count("/api/v1/prices")).toBe(2);

    // 1분 넘게 지나면(같은 날): 최근 3개만
    t += 40_000;
    await p.getQuotes(CODES);
    expect(candleCounts().slice(first)).toEqual([3, 3, 3, 3]);

    // 다음 날: 다시 260개
    const before = count("/candles");
    t += 24 * 3_600_000;
    await p.getQuotes(CODES);
    expect(count("/candles") - before).toBe(7);
  });

  it("묶음이 4xx 로 거절되면 종목마다 다시 물어 나머지는 살리고, 고가·저가는 현재가를 넘지 않게 맞춘다", async () => {
    const base = fakeFetch();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/prices") && new URL(url).searchParams.get("symbols")!.includes("ZZZZ"))
        return new Response(JSON.stringify({ error: { code: "invalid-symbol" } }), { status: 400, headers: { "content-type": "application/json" } });
      return base(input, init);
    }) as typeof fetch;
    const p = new TossOpenApiProvider(new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, maxRetryWaitMs: 0 }), { now: NOW });
    const r = await p.getQuotes(["035420", "ZZZZ", "TSLA"]);
    expect(r.get("035420")).not.toBeInstanceOf(Error);
    expect(r.get("TSLA")).not.toBeInstanceOf(Error);
    expect(r.get("ZZZZ")).toBeInstanceOf(Error);
    const q = r.get("035420") as { price: number; high: number; low: number };
    expect(q.high).toBeGreaterThanOrEqual(q.price);
    expect(q.low).toBeLessThanOrEqual(q.price);
  });

  it("기준가를 못 받으면 일봉 종가로 등락을 계산하고 표식·횟수를 남긴다", async () => {
    const p = new TossOpenApiProvider(client(), { now: NOW, krBaseMany: async () => new Map() });
    const r = await p.getQuotes(["035420", "TSLA"]);
    expect(r.get("035420")).toMatchObject({ prevCloseBasis: "candle", prevClose: 200000 + 199 * 100 });
    expect((r.get("TSLA") as { prevCloseBasis?: string }).prevCloseBasis).toBeUndefined();
    expect(p.baseFallbacks).toBe(1);
  });

  it("일봉을 새로 받지 못하면 전에 받은 일봉으로 답한다", async () => {
    let fail = false;
    let t = Date.parse("2026-09-22T10:00:00+09:00");
    const base = fakeFetch();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (fail && String(input).includes("/candles")) return new Response("{}", { status: 500 });
      return base(input, init);
    }) as typeof fetch;
    const p = new TossOpenApiProvider(new TossOpenApiClient({ clientId: "c", clientSecret: "s", fetchFn, now: NOW, maxRetryWaitMs: 0 }), { now: () => new Date(t) });
    const a = await p.getQuote("035420");
    fail = true;
    t += 24 * 3_600_000;
    const b = await p.getQuote("035420");
    expect(b.prevClose).toBe(a.prevClose);
  });
});
