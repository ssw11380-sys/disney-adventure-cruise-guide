import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { fetchWithTimeout } from "../src/lib/timedFetch.js";
import { DartProvider } from "../src/providers/dart/dart.js";
import { NaverFundamentals } from "../src/providers/market/fundamentals.js";
import { NaverFinanceProvider } from "../src/providers/market/naver.js";
import { YahooProvider } from "../src/providers/market/yahoo.js";
import { GoogleNewsRssProvider } from "../src/providers/news/googleRss.js";
import { NaverNewsProvider } from "../src/providers/news/naver.js";
import { NaverStockNewsProvider } from "../src/providers/news/naverStock.js";

/**
 * 멈춘 출처 (BH-23): 연결만 받고 답이 없거나, 헤더만 오고 본문이 끝나지 않는 응답.
 * 예전에는 undici 기본값(약 300초)까지 순차 브리핑을 종목마다 붙잡았다.
 * 이제 요청마다 본문 끝까지 제한 시간(10초, DART corpCode.xml 은 60초) 안에 끝나야 한다.
 */
// signal 을 따르지 않는 fetch 도 제한 시간에 끝나야 한다
const noAnswer = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
const bodyStalls = (async () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
      },
    }),
    { status: 200 },
  )) as unknown as typeof fetch;

async function stateAfter(p: Promise<unknown>, ms: number): Promise<"pending" | "settled"> {
  let state: "pending" | "settled" = "pending";
  p.then(
    () => (state = "settled"),
    () => (state = "settled"),
  );
  await vi.advanceTimersByTimeAsync(ms);
  return state;
}

const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ["응답 없음", noAnswer],
  ["본문 멈춤", bodyStalls],
])("멈춘 출처 (%s)는 제한 시간에 끝난다 (BH-23)", (_label, f) => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["구글 뉴스 RSS", () => new GoogleNewsRssProvider(f).search("삼성전자", 5)],
    ["네이버 종목 뉴스", () => new NaverStockNewsProvider(f).forStock({ code: "005930", name: "삼성전자" }, 5)],
    ["네이버 검색 뉴스", () => new NaverNewsProvider("id", "secret", f).search("삼성전자", 5)],
    ["네이버 현재가", () => new NaverFinanceProvider(f).getQuote("005930")],
    ["네이버 지표", () => new NaverFundamentals(f).get("005930", "KOSPI")],
    ["Yahoo", () => new YahooProvider(f, async () => "KOSPI").getQuote("005930")],
  ];
  it.each(cases)("%s", async (_name, run) => {
    fake();
    expect(await stateAfter(run(), 15_000)).toBe("settled");
  });

  it("DART 조회와 corpCode.xml", async () => {
    const db = await createMigratedDb(":memory:");
    await db.insertInto("dart_corp_codes").values({ stock_code: "005930", corp_code: "00126380", corp_name: "삼성전자", updated_at: "2026-09-25T09:00:00+09:00" }).execute();
    const dart = new DartProvider({ apiKey: "k", db, fetchFn: f, now: () => new Date("2026-09-25T09:00:00+09:00") });
    fake();
    expect(await stateAfter(dart.getCompany("005930"), 15_000)).toBe("settled");
    expect(await stateAfter(dart.refreshCorpCodes(), 65_000)).toBe("settled");
    vi.useRealTimers();
    await db.destroy();
  });
});

describe("fetchWithTimeout (실제 HTTP)", () => {
  it("정상 응답은 상태·헤더·본문을 그대로 주고, 헤더만 오고 본문이 멈추면 제한 시간에 연결을 끊는다", async () => {
    let closed = false;
    const server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(201, { "content-type": "application/json", "x-src": "naver" });
        res.end('{"a":1}');
        return;
      }
      req.socket.on("close", () => (closed = true));
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"items":'); // 본문 일부만 보내고 멈춘다
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetchWithTimeout(fetch, `${base}/ok`, { headers: { accept: "application/json" } }, 2_000);
      expect(ok.status).toBe(201);
      expect(ok.headers.get("x-src")).toBe("naver");
      expect(await ok.json()).toEqual({ a: 1 });
      const t0 = Date.now();
      await expect(fetchWithTimeout(fetch, `${base}/stall`, {}, 200)).rejects.toMatchObject({ name: "TimeoutError" });
      expect(Date.now() - t0).toBeLessThan(2_000);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
