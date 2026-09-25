import { describe, expect, it } from "vitest";
import { parseSessionInfo, TossProvider, type CodeStore } from "../src/providers/market/toss.js";

/**
 * 초록 점의 종목 자격 (주간거래·NXT 대상·거래정지·ETF·ETN) — 토스 웹 stock-infos 일괄 조회 (로그인 없는 공개 JSON, 시세와 같은 서버).
 * 칸 이름과 참/거짓 값은 2026-09-25 01:05Z(뉴욕 21:05, 주간거래 중) 실제 응답과 같다 (이 기능이 읽는 칸만 남김).
 * 상품 구분(group.code)은 02:20Z 에 본 값: NAVER ST(주권) · 윙입푸드 FS(외국주권) · KODEX 200 EF(ETF) · 삼성 레버리지 WTI원유 선물 ETN EN(ETN).
 * 미국 상품 코드·가격은 예시 값
 */
const INFOS: Record<string, Record<string, unknown>> = {
  A035420: { code: "A035420", symbol: "035420", name: "NAVER", market: { code: "KSP" }, group: { code: "ST", displayName: "주권" }, status: "N", daytimePriceSupported: false, nxtSupported: true, nxtOpenDate: "2025-03-04", tradingSuspended: false, krxTradingSuspended: false, nxtTradingSuspended: false, userTradingSuspended: false },
  A900340: { code: "A900340", symbol: "900340", name: "윙입푸드", market: { code: "KSQ" }, group: { code: "FS", displayName: "외국주권" }, status: "N", daytimePriceSupported: false, nxtSupported: false, tradingSuspended: false, krxTradingSuspended: false, nxtTradingSuspended: false },
  A069500: { code: "A069500", symbol: "069500", name: "KODEX 200", market: { code: "KSP" }, group: { code: "EF", displayName: "ETF" }, status: "N", daytimePriceSupported: false, nxtSupported: false, tradingSuspended: false, krxTradingSuspended: false, nxtTradingSuspended: false },
  US20200205001: { code: "US20200205001", symbol: "VRT", name: "버티브 홀딩스", market: { code: "NYS" }, status: "N", daytimePriceSupported: true, nxtSupported: false, tradingSuspended: false },
  // 칸이 빠진 응답 (비공식 API 가 바뀐 경우) → 모름
  US20990101001: { code: "US20990101001", symbol: "NEWX", name: "새 종목", market: { code: "NSQ" }, status: "N" },
};
/** 같은 시각 stock-prices: 한국은 거래소 구분(integrated = KRX+NXT, krx = KRX 만)과 종목별 거래 시간 */
const PRICES: Record<string, Record<string, unknown>> = {
  A035420: { productCode: "A035420", exchange: "integrated", base: 250000, close: 251500, tradingEnd: "2026-09-23T11:00:00Z", nextTradingStart: "2026-09-27T23:00:00Z" },
  A900340: { productCode: "A900340", exchange: "krx", base: 1000, close: 1005, tradingEnd: "2026-09-23T06:30:00Z", nextTradingStart: "2026-09-28T00:00:00Z" },
  US20200205001: { productCode: "US20200205001", base: 120.1, close: 121.3, volume: 399, afterMarketClose: 0, tradingEnd: "2026-09-24T20:00:00Z", nextTradingStart: "2026-09-25T13:30:00Z" },
};

class Store implements CodeStore {
  map = new Map<string, string>([
    ["toss:product:VRT", "US20200205001"],
    ["toss:product:NEWX", "US20990101001"],
  ]);
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
}

function provider(t: { now: number }, o: { failInfos?: () => boolean; failPrices?: () => boolean } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const ok = (body: unknown) => new Response(JSON.stringify({ result: body }), { status: 200 });
    if (url.includes("/v1/stock-infos?codes=")) {
      if (o.failInfos?.()) return new Response("nope", { status: 503 });
      const codes = decodeURIComponent(url.split("codes=")[1]!).split(",");
      return ok(codes.map((c) => INFOS[c]).filter(Boolean));
    }
    if (url.includes("/v3/stock-prices?")) {
      if (o.failPrices?.()) return new Response("nope", { status: 503 });
      const codes = decodeURIComponent(url.split("productCodes=")[1]!).split(",");
      return ok(codes.map((c) => PRICES[c]).filter(Boolean));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { p: new TossProvider(fetchFn, new Store(), () => new Date(t.now)), calls };
}

const CODES = ["035420", "900340", "069500", "VRT", "NEWX"];

describe("토스 세션 사실 (stock-infos · stock-prices)", () => {
  it("받아 둔 값만 바로 주고(처음엔 모름), 뒤에서 한 번에 받은 뒤에는 자격·거래소 구분·가격 받은 시각을 준다", async () => {
    const t = { now: Date.parse("2026-09-25T01:05:00Z") };
    const { p, calls } = provider(t);
    const first = p.sessionFacts(CODES);
    expect(first.get("VRT")).toMatchObject({ daytime: null, nxt: null, exchange: null, pricedAt: null });
    await p.refreshSessionInfos(CODES); // 이미 나간 요청을 같이 기다린다
    await p.getMany(CODES);
    const f = p.sessionFacts(CODES);
    expect(f.get("035420")).toEqual({ daytime: false, nxt: true, halted: false, nxtHalted: false, etp: false, exchange: "integrated", pricedAt: t.now });
    expect(f.get("900340")).toMatchObject({ nxt: false, etp: false, exchange: "krx" });
    expect(f.get("069500")).toMatchObject({ nxt: false, etp: true }); // ETF — 한국거래소 애프터마켓 대상 아님
    expect(f.get("VRT")).toMatchObject({ daytime: true, halted: false });
    expect(f.get("NEWX")).toMatchObject({ daytime: null, nxt: null, halted: null, nxtHalted: null, etp: null }); // 칸이 없으면 모름 — 아무 값으로 채우지 않는다
    expect(calls.filter((u) => u.includes("/v1/stock-infos")).length).toBe(1); // 5종목 한 번에
  });

  it("1시간 안에는 다시 묻지 않고, 지나면 다시 받는다 (거래정지는 장중에도 바뀔 수 있다)", async () => {
    const t = { now: Date.parse("2026-09-25T01:05:00Z") };
    const { p, calls } = provider(t);
    await p.refreshSessionInfos(CODES);
    t.now += 30 * 60_000;
    p.sessionFacts(CODES);
    await p.refreshSessionInfos(CODES);
    expect(calls.filter((u) => u.includes("/v1/stock-infos")).length).toBe(1);
    t.now += 31 * 60_000;
    await p.refreshSessionInfos(CODES);
    expect(calls.filter((u) => u.includes("/v1/stock-infos")).length).toBe(2);
  });

  it("조회가 실패하면 모름으로 두고 5분 동안 다시 부르지 않는다", async () => {
    const t = { now: Date.parse("2026-09-25T01:05:00Z") };
    let fail = true;
    const { p, calls } = provider(t, { failInfos: () => fail });
    await p.refreshSessionInfos(CODES);
    expect(p.sessionFacts(CODES).get("VRT")!.daytime).toBeNull();
    t.now += 60_000;
    await p.refreshSessionInfos(CODES);
    expect(calls.filter((u) => u.includes("/v1/stock-infos")).length).toBe(1);
    fail = false;
    t.now += 5 * 60_000;
    await p.refreshSessionInfos(CODES);
    expect(p.sessionFacts(CODES).get("VRT")!.daytime).toBe(true);
  });

  it("그 뒤 일괄 시세가 실패하면 '가격을 받는 중'이 아니다 (pricedAt 없음)", async () => {
    const t = { now: Date.parse("2026-09-25T01:05:00Z") };
    let fail = false;
    const { p } = provider(t, { failPrices: () => fail });
    await p.getMany(["VRT"]);
    expect(p.sessionFacts(["VRT"]).get("VRT")!.pricedAt).toBe(t.now);
    fail = true;
    t.now += 3_000;
    await p.getMany(["VRT"]).catch(() => undefined);
    expect(p.sessionFacts(["VRT"]).get("VRT")!.pricedAt).toBeNull();
  });

  it("거래정지 칸: 둘 중 하나라도 정지면 정지, 모두 없으면 모름", () => {
    expect(parseSessionInfo({ tradingSuspended: false, krxTradingSuspended: true }, 0).halted).toBe(true);
    expect(parseSessionInfo({ tradingSuspended: false }, 0).halted).toBe(false);
    expect(parseSessionInfo({}, 0).halted).toBeNull();
    expect(parseSessionInfo({ daytimePriceSupported: "Y" }, 0).daytime).toBeNull(); // 불리언이 아니면 모름
  });

  it("ETF·ETN: 상품 구분 EF·EN 이면 true, 다른 구분이면 false, 칸이 없으면 모름", () => {
    expect(parseSessionInfo({ group: { code: "EF" } }, 0).etp).toBe(true);
    expect(parseSessionInfo({ group: { code: "EN" } }, 0).etp).toBe(true);
    expect(parseSessionInfo({ group: { code: "ST" } }, 0).etp).toBe(false);
    expect(parseSessionInfo({ group: { code: "FS" } }, 0).etp).toBe(false);
    expect(parseSessionInfo({}, 0).etp).toBeNull();
    expect(parseSessionInfo({ group: null }, 0).etp).toBeNull();
  });
});
