import { describe, expect, it, vi } from "vitest";
import { applyTick, applyTicksToList, latestPerCode, type StreamTick } from "@/lib/liveTick";
import { holding, quote } from "./helpers";

// PF-01: 거래일이 바뀐 첫 체결을 전날 시세(전일 종가·고가·저가)에 섞지 않는다 (서버 stockService.sameTradingDay 와 같은 기준)
const tick = (code: string, price: number, timestamp: string): StreamTick => ({ code, price, volume: 1, timestamp, source: "toss-openapi" });

describe("거래일이 바뀐 체결 (PF-01)", () => {
  // 9/23 종가 100, 그날 기준 전일 종가 90 (등락 +10)
  const kr = quote("005930", 100, { prevClose: 90, change: 10, changeRate: 11.11, high: 105, low: 90, asOf: "2026-09-23T15:30:00+09:00", source: "toss" });

  it("국내 다음 장 첫 체결은 전날 기준가로 계산하지 않는다 (+11 / +12.22% 가 아님)", () => {
    const n = applyTick(kr, tick("005930", 101, "2026-09-24T09:00:01+09:00"));
    expect(n).toBe(kr);
    expect(n!.change).toBe(10);
    expect(n!.high).toBe(105);
    expect(n!.live).toBeUndefined();
  });

  it("휴일(주말) 뒤 첫 장도 보류", () => {
    const fri = { ...kr, asOf: "2026-09-25T15:30:00+09:00" };
    expect(applyTick(fri, tick("005930", 101, "2026-09-28T09:00:00+09:00"))).toBe(fri);
  });

  it("UTC(Z) 표기여도 서울 날짜로 본다: 23:30Z 는 다음 날 08:30 KST → 보류, 06:40Z 는 같은 날 15:40 KST → 적용", () => {
    expect(applyTick(kr, tick("005930", 101, "2026-09-23T23:30:00Z"))).toBe(kr);
    const same = applyTick(kr, tick("005930", 101, "2026-09-23T06:40:00Z"))!;
    expect(same.change).toBe(11);
    expect(same.live).toBe(true);
  });

  it("미국: 서울 날짜는 달라도 뉴욕 날짜가 같으면 같은 거래일 → 적용", () => {
    // 9/24 23:00 KST = 뉴욕 9/24 10:00, 9/25 01:00 KST = 뉴욕 9/24 12:00
    const us = quote("AAPL", 200, { currency: "USD", prevClose: 198, change: 2, changeRate: 1.01, asOf: "2026-09-24T23:00:00+09:00", fxRate: 1400 });
    const n = applyTick(us, tick("AAPL", 201, "2026-09-25T01:00:00+09:00"))!;
    expect(n.price).toBe(201);
    expect(n.change).toBe(3);
    expect(n.live).toBe(true);
  });

  it("미국: 서울 날짜는 같아도 뉴욕 날짜가 다르면 보류", () => {
    // 9/24 05:00 KST = 뉴욕 9/23 16:00 (마감), 9/24 22:30 KST = 뉴욕 9/24 09:30 (다음 장 시작)
    const us = quote("AAPL", 200, { currency: "USD", prevClose: 198, change: 2, changeRate: 1.01, asOf: "2026-09-24T05:00:00+09:00" });
    expect(applyTick(us, tick("AAPL", 201, "2026-09-24T22:30:05+09:00"))).toBe(us);
  });

  it("정상 당일 체결은 그대로 적용", () => {
    const today = quote("005930", 100, { prevClose: 100, change: 0, changeRate: 0, asOf: "2026-09-24T09:00:00+09:00" });
    const n = applyTick(today, tick("005930", 101, "2026-09-24T09:00:05+09:00"))!;
    expect(n.change).toBe(1);
    expect(n.changeRate).toBe(1);
  });

  it("서버 재조회가 늦으면 옛 목록을 그대로 두고 보류한 종목을 알린다 → 새 거래일 시세가 오면 +1 / +1%", () => {
    const list = [holding("005930", kr, 10, 80), holding("000660", quote("000660", 200, { asOf: "2026-09-24T09:00:00+09:00" }), 1, 150)];
    const held = new Set<string>();
    const ticks = latestPerCode([tick("005930", 101, "2026-09-24T09:00:01+09:00")]);
    expect(applyTicksToList(list, ticks, held)).toBe(list);
    expect([...held]).toEqual(["005930"]);
    // 서버가 9/24 기준가(100)로 새 시세를 주면 그다음 체결부터 붙는다
    const fresh = [holding("005930", quote("005930", 100, { prevClose: 100, change: 0, changeRate: 0, asOf: "2026-09-24T09:00:00+09:00" }), 10, 80)];
    const next = applyTicksToList(fresh, latestPerCode([tick("005930", 101, "2026-09-24T09:00:03+09:00")]), held);
    expect(next[0]!.quote!.change).toBe(1);
    expect(next[0]!.quote!.changeRate).toBe(1);
  });
});

describe("시장 현지 거래일 규칙 (한국 서울, 미국 뉴욕·서머타임)", () => {
  it("marketDate: 같은 순간은 표기(Z·+09:00)와 관계없이 같은 날짜", async () => {
    const { marketDate } = await import("@/lib/marketTime");
    expect(marketDate("2026-09-25T01:00:00+09:00", "AAPL")).toBe("2026-09-24");
    expect(marketDate("2026-09-24T16:00:00Z", "AAPL")).toBe("2026-09-24");
    expect(marketDate("2026-09-23T23:30:00Z", "005930")).toBe("2026-09-24");
    expect(marketDate("2026-09-24T08:30:00+09:00", "005930")).toBe("2026-09-24");
    expect(marketDate("bad", "005930")).toBeNull();
  });

  it("서머타임: 겨울(EST -5)·여름(EDT -4) 자정 경계", async () => {
    const { marketDate } = await import("@/lib/marketTime");
    expect(marketDate("2026-01-16T04:30:00Z", "AAPL")).toBe("2026-01-15"); // 23:30 EST
    expect(marketDate("2026-01-16T05:30:00Z", "AAPL")).toBe("2026-01-16"); // 00:30 EST
    expect(marketDate("2026-07-16T03:30:00Z", "AAPL")).toBe("2026-07-15"); // 23:30 EDT
    expect(marketDate("2026-07-16T04:30:00Z", "AAPL")).toBe("2026-07-16"); // 00:30 EDT
  });

  it("Intl 이 없는 기기용 뉴욕 오프셋 규칙이 Intl(America/New_York)과 같다 (2024~2030, 30분 간격 + 전환 직전·직후)", async () => {
    const { nyOffsetByRule } = await import("@/lib/marketTime");
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" });
    const intl = (t: number) => {
      const m = /GMT([+-])(\d{2}):(\d{2})/.exec(fmt.format(new Date(t)))!;
      return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    };
    const edges = ["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z", "2027-03-14T07:00:00Z", "2027-11-07T06:00:00Z"].map(Date.parse);
    for (const t of edges) expect(nyOffsetByRule(t), new Date(t).toISOString()).toBe(intl(t));
    for (let t = Date.parse("2024-01-01T00:00:00Z"); t < Date.parse("2031-01-01T00:00:00Z"); t += 30 * 60_000) {
      if (nyOffsetByRule(t) !== intl(t)) throw new Error(`불일치 ${new Date(t).toISOString()}`);
    }
  });

  it("기기 Intl 이 시간대를 모르거나 무시해도 뉴욕 날짜는 규칙으로 맞다", async () => {
    const real = Intl.DateTimeFormat;
    for (const fake of [
      // formatToParts 가 없는 엔진
      function () {
        return { format: () => "" };
      },
      // timeZone 을 무시하고 서울 시각으로 주는 엔진
      function (_l: string, o: Intl.DateTimeFormatOptions) {
        return new real("en-US", { ...o, timeZone: "Asia/Seoul" });
      },
    ]) {
      vi.resetModules();
      vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: fake });
      try {
        const { marketDate } = await import("@/lib/marketTime");
        expect(marketDate("2026-09-25T01:00:00+09:00", "AAPL")).toBe("2026-09-24");
        expect(marketDate("2026-01-16T04:30:00Z", "AAPL")).toBe("2026-01-15");
        expect(marketDate("2026-07-16T04:30:00Z", "AAPL")).toBe("2026-07-16");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("sameTradingDay: 시각을 못 읽으면 막지 않는다 (서버와 같다)", async () => {
    const { sameTradingDay } = await import("@/lib/marketTime");
    expect(sameTradingDay("2026-09-23T15:30:00+09:00", "2026-09-24T09:00:00+09:00", "005930")).toBe(false);
    expect(sameTradingDay("", "2026-09-24T09:00:00+09:00", "005930")).toBe(true);
  });
});
