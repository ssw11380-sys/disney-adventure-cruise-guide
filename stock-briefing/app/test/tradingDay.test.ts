import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MarketStatus } from "@/api/types";
import { applyTick, applyTicksToList, latestPerCode, newTradingDay, type StreamTick } from "@/lib/liveTick";
import { holding, quote } from "./helpers";

// PF-01: 거래일이 바뀐 첫 체결을 전날 시세(전일 종가·고가·저가)에 섞지 않는다 (서버 stockService.sameTradingDay 와 같은 기준)
const tick = (code: string, price: number, timestamp: string): StreamTick => ({ code, price, volume: 1, timestamp, source: "toss-openapi" });

describe("거래일이 바뀐 체결 (PF-01)", () => {
  // 9/16 종가 100, 그날 기준 전일 종가 90 (등락 +10)
  const kr = quote("005930", 100, { prevClose: 90, change: 10, changeRate: 11.11, high: 105, low: 90, asOf: "2026-09-16T15:30:00+09:00", source: "toss" });

  it("국내 다음 장 첫 체결은 전날 기준가로 계산하지 않는다 (+11 / +12.22% 가 아님)", () => {
    const n = applyTick(kr, tick("005930", 101, "2026-09-17T09:00:01+09:00"));
    expect(n).toBe(kr);
    expect(n!.change).toBe(10);
    expect(n!.high).toBe(105);
    expect(n!.live).toBeUndefined();
  });

  it("휴일(주말) 뒤 첫 장도 보류", () => {
    const fri = { ...kr, asOf: "2026-09-18T15:30:00+09:00" };
    expect(applyTick(fri, tick("005930", 101, "2026-09-21T09:00:00+09:00"))).toBe(fri);
  });

  it("UTC(Z) 표기여도 서울 날짜로 본다: 23:30Z 는 다음 날 08:30 KST → 보류, 06:40Z 는 같은 날 15:40 KST → 적용", () => {
    expect(applyTick(kr, tick("005930", 101, "2026-09-16T23:30:00Z"))).toBe(kr);
    const same = applyTick(kr, tick("005930", 101, "2026-09-16T06:40:00Z"))!;
    expect(same.change).toBe(11);
    expect(same.live).toBe(true);
  });

  it("미국: 서울 날짜는 달라도 뉴욕 날짜가 같으면 같은 거래일 → 적용", () => {
    // 9/17 23:00 KST = 뉴욕 9/17 10:00, 9/18 01:00 KST = 뉴욕 9/17 12:00
    const us = quote("AAPL", 200, { currency: "USD", prevClose: 198, change: 2, changeRate: 1.01, asOf: "2026-09-17T23:00:00+09:00", fxRate: 1400 });
    const n = applyTick(us, tick("AAPL", 201, "2026-09-18T01:00:00+09:00"))!;
    expect(n.price).toBe(201);
    expect(n.change).toBe(3);
    expect(n.live).toBe(true);
  });

  it("미국: 서울 날짜는 같아도 뉴욕 날짜가 다르면 보류", () => {
    // 9/17 05:00 KST = 뉴욕 9/16 16:00 (마감), 9/17 22:30 KST = 뉴욕 9/17 09:30 (다음 장 시작)
    const us = quote("AAPL", 200, { currency: "USD", prevClose: 198, change: 2, changeRate: 1.01, asOf: "2026-09-17T05:00:00+09:00" });
    expect(applyTick(us, tick("AAPL", 201, "2026-09-17T22:30:05+09:00"))).toBe(us);
  });

  it("정상 당일 체결은 그대로 적용", () => {
    const today = quote("005930", 100, { prevClose: 100, change: 0, changeRate: 0, asOf: "2026-09-17T09:00:00+09:00" });
    const n = applyTick(today, tick("005930", 101, "2026-09-17T09:00:05+09:00"))!;
    expect(n.change).toBe(1);
    expect(n.changeRate).toBe(1);
  });

  it("서버 재조회가 늦으면 옛 목록을 그대로 두고 보류한 종목을 알린다 → 새 거래일 시세가 오면 +1 / +1%", () => {
    const list = [holding("005930", kr, 10, 80), holding("000660", quote("000660", 200, { asOf: "2026-09-17T09:00:00+09:00" }), 1, 150)];
    const held = new Set<string>();
    const ticks = latestPerCode([tick("005930", 101, "2026-09-17T09:00:01+09:00")]);
    expect(applyTicksToList(list, ticks, held)).toBe(list);
    expect([...held]).toEqual(["005930"]);
    // 서버가 9/17 기준가(100)로 새 시세를 주면 그다음 체결부터 붙는다
    const fresh = [holding("005930", quote("005930", 100, { prevClose: 100, change: 0, changeRate: 0, asOf: "2026-09-17T09:00:00+09:00" }), 10, 80)];
    const next = applyTicksToList(fresh, latestPerCode([tick("005930", 101, "2026-09-17T09:00:03+09:00")]), held);
    expect(next[0]!.quote!.change).toBe(1);
    expect(next[0]!.quote!.changeRate).toBe(1);
  });
});

describe("장 시작 전에 받은 국내 시세 (PF-01 2차 검증 지적)", () => {
  // 토스 웹·네이버 시세는 asOf 가 받은 시각이다. 07:59 에 받은 시세는 9/16 거래 값(전일 종가 = 9/15 종가 90)
  const early = quote("005930", 100, { prevClose: 90, change: 10, changeRate: 11.11, high: 105, low: 90, asOf: "2026-09-17T07:59:30+09:00", source: "toss" });

  it("07:59 에 받은 시세에 08:00 NXT 첫 체결을 붙이지 않는다 (+11 / +12.22% 가 아님) → 새 시세를 받으면 +1 / +1%", () => {
    const first = tick("005930", 101, "2026-09-17T08:00:05+09:00");
    expect(applyTick(early, first)).toBe(early);
    expect(newTradingDay(early, first)).toBe(true);
    const held = new Set<string>();
    const list = [holding("005930", early, 10, 80)];
    expect(applyTicksToList(list, latestPerCode([first]), held)).toBe(list);
    expect([...held]).toEqual(["005930"]);
    // 08:00 이후 받은 시세(9/17 기준가 100)에는 붙는다
    const fresh = quote("005930", 100, { prevClose: 100, change: 0, changeRate: 0, asOf: "2026-09-17T08:00:30+09:00", source: "toss" });
    expect(applyTick(fresh, tick("005930", 101, "2026-09-17T08:00:40+09:00"))).toMatchObject({ price: 101, change: 1, changeRate: 1, live: true });
  });

  it("UTC 표기(22:59Z = 07:59 KST)도 같고, 월요일 새벽 시세는 금요일 거래일", () => {
    const z = { ...early, asOf: "2026-09-16T22:59:30Z" };
    expect(applyTick(z, tick("005930", 101, "2026-09-16T23:00:05Z"))).toBe(z);
    const monEarly = { ...early, asOf: "2026-09-21T06:00:00+09:00" };
    expect(newTradingDay(monEarly, tick("005930", 101, "2026-09-21T08:00:01+09:00"))).toBe(true);
    // 장 시작 전 시세와 그 전날 밤 체결(값 그대로)은 같은 거래일
    expect(newTradingDay({ ...early, asOf: "2026-09-17T06:00:00+09:00" }, tick("005930", 100, "2026-09-17T07:00:00+09:00"))).toBe(false);
  });
});

describe("미국 주간거래(뉴욕 20:00 이후)는 다음 거래일 (PF-01 검증 지적)", () => {
  it("애프터마켓 시세(뉴욕 19:58, 전일 종가 = 전날 정규장의 전날 것)에 주간거래 체결(뉴욕 21:00)을 붙이지 않는다", () => {
    // 9/17 정규장 종가 200 (9/16 종가 190), 애프터 202 → 등락 +12 는 9/16 종가 기준
    const after = quote("AAPL", 202, { currency: "USD", prevClose: 190, change: 12, changeRate: 6.32, asOf: "2026-09-18T08:58:00+09:00" });
    const t = tick("AAPL", 205, "2026-09-18T10:00:00+09:00");
    expect(applyTick(after, t)).toBe(after);
    expect(newTradingDay(after, t)).toBe(true);
  });

  it("주간거래 시세(전일 종가 = 9/17 정규장)에는 붙고, 뉴욕 자정을 넘겨도(한국 13:30) 같은 거래일이라 보류하지 않는다", () => {
    const day = quote("AAPL", 204, { currency: "USD", prevClose: 200, change: 4, changeRate: 2, asOf: "2026-09-18T10:00:00+09:00" });
    const t = tick("AAPL", 206, "2026-09-18T13:30:00+09:00");
    expect(newTradingDay(day, t)).toBe(false);
    expect(applyTick(day, t)).toMatchObject({ price: 206, change: 6, changeRate: 3, live: true });
  });

  it("주말에 온 체결(값 그대로)은 금요일 시세와 같은 거래일, 월요일 주간거래(뉴욕 일요일 20:00~)는 새 거래일", () => {
    const fri = quote("AAPL", 200, { currency: "USD", prevClose: 198, change: 2, changeRate: 1.01, asOf: "2026-09-19T08:59:00+09:00" }); // 뉴욕 금 19:59
    expect(newTradingDay(fri, tick("AAPL", 200, "2026-09-19T13:00:00+09:00"))).toBe(false);
    expect(newTradingDay(fri, tick("AAPL", 201, "2026-09-21T10:00:00+09:00"))).toBe(true);
    const krFri = quote("005930", 100, { asOf: "2026-09-18T15:30:00+09:00" });
    expect(newTradingDay(krFri, tick("005930", 100, "2026-09-19T11:00:00+09:00"))).toBe(false);
    expect(newTradingDay(krFri, tick("005930", 101, "2026-09-21T09:00:00+09:00"))).toBe(true);
  });
});

describe("시장 현지 거래일 규칙 (한국 서울, 미국 뉴욕·서머타임)", () => {
  it("tradingDate: 미국은 뉴욕 20:00 부터 다음 날, 주말은 직전 금요일 (서머타임 적용/비적용, Z 표기)", async () => {
    const { tradingDate } = await import("@/lib/marketTime");
    // EDT(-4): 9/17(목) 19:59 → 9/17, 20:00 → 9/18, 9/18 00:30 → 9/18
    expect(tradingDate("2026-09-18T08:59:00+09:00", "AAPL")).toBe("2026-09-17");
    expect(tradingDate("2026-09-18T09:00:00+09:00", "AAPL")).toBe("2026-09-18");
    expect(tradingDate("2026-09-18T00:00:00Z", "AAPL")).toBe("2026-09-18");
    expect(tradingDate("2026-09-18T13:30:00+09:00", "AAPL")).toBe("2026-09-18");
    // EST(-5): 1/15(목) 19:59 → 1/15, 20:00 → 1/16
    expect(tradingDate("2026-01-16T00:59:00Z", "AAPL")).toBe("2026-01-15");
    expect(tradingDate("2026-01-16T01:00:00Z", "AAPL")).toBe("2026-01-16");
    // 주말: 금 20:00 ~ 일 20:00 전은 금요일, 일 20:00 부터 월요일
    expect(tradingDate("2026-09-19T10:30:00+09:00", "AAPL")).toBe("2026-09-18"); // 뉴욕 금 21:30
    expect(tradingDate("2026-09-20T12:00:00+09:00", "AAPL")).toBe("2026-09-18"); // 뉴욕 토 23:00
    expect(tradingDate("2026-09-21T08:59:00+09:00", "AAPL")).toBe("2026-09-18"); // 뉴욕 일 19:59
    expect(tradingDate("2026-09-21T09:00:00+09:00", "AAPL")).toBe("2026-09-21"); // 뉴욕 일 20:00
    // 한국은 서울 날짜 그대로(20:00 규칙 없음), 주말은 금요일
    expect(tradingDate("2026-09-17T20:30:00+09:00", "005930")).toBe("2026-09-17");
    expect(tradingDate("2026-09-19T10:00:00+09:00", "005930")).toBe("2026-09-18");
    expect(tradingDate("bad", "AAPL")).toBeNull();
  });

  it("tradingDate: 한국 00:00~08:00 은 직전 거래일 (체결이 없는 시간, 월요일 새벽은 금요일)", async () => {
    const { tradingDate } = await import("@/lib/marketTime");
    expect(tradingDate("2026-09-17T07:59:59+09:00", "005930")).toBe("2026-09-16");
    expect(tradingDate("2026-09-17T08:00:00+09:00", "005930")).toBe("2026-09-17");
    expect(tradingDate("2026-09-16T23:00:00Z", "005930")).toBe("2026-09-17"); // 08:00 KST
    expect(tradingDate("2026-09-17T00:10:00+09:00", "005930")).toBe("2026-09-16");
    expect(tradingDate("2026-09-21T07:00:00+09:00", "005930")).toBe("2026-09-18");
    expect(tradingDate("2026-09-19T07:00:00+09:00", "005930")).toBe("2026-09-18"); // 토 새벽
  });

  it("tradingDate: 미국 휴장일(추수감사절 11/26, 노동절 9/7)은 직전 거래일 — 전날 밤 20:00 이후 체결도 휴장일 봉을 만들지 않는다", async () => {
    const { tradingDate } = await import("@/lib/marketTime");
    expect(tradingDate("2026-11-26T10:30:00+09:00", "AAPL")).toBe("2026-11-25"); // 뉴욕 11/25(수) 20:30 — 다음 날 휴장이라 주간거래 없음
    expect(tradingDate("2026-11-27T02:00:00+09:00", "AAPL")).toBe("2026-11-25"); // 뉴욕 11/26 12:00
    expect(tradingDate("2026-11-27T10:30:00+09:00", "AAPL")).toBe("2026-11-27"); // 뉴욕 11/26 20:30 → 금요일 세션
    expect(tradingDate("2026-09-07T10:00:00+09:00", "AAPL")).toBe("2026-09-04"); // 뉴욕 일 9/6 21:00 → 월 9/7 휴장 → 금 9/4
    expect(tradingDate("2026-09-08T10:00:00+09:00", "AAPL")).toBe("2026-09-08"); // 뉴욕 월 9/7 21:00 → 화 9/8
  });

  const holidayList = (rel: string) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const m = /US_HOLIDAYS = new Set\(\[([\s\S]*?)\]\)/.exec(readFileSync(join(root, rel), "utf8"));
    return [...(m?.[1] ?? "").matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((x) => x[1]!);
  };

  it("앱 미국 휴장일 목록이 서버(marketContext.US_HOLIDAYS)와 같다 — 해마다 둘 다 추가", () => {
    const app = holidayList("app/src/lib/marketTime.ts");
    expect(app.length).toBeGreaterThan(10);
    expect(app).toEqual(holidayList("backend/src/services/marketContext.ts"));
  });

  it("미국 휴장일 목록이 내년 끝까지 있다 — 목록이 끝난 해부터는 휴장일을 평일로 보므로, 해가 바뀌면 NYSE 가 발표한 다음 해 휴장일을 앱·서버에 같이 넣는다", () => {
    const last = Math.max(...holidayList("app/src/lib/marketTime.ts").map((d) => Number(d.slice(0, 4))));
    const need = new Date().getUTCFullYear() + 1;
    expect(last, `US_HOLIDAYS 가 ${last}년까지뿐 — ${need}년 NYSE 휴장일을 app/src/lib/marketTime.ts 와 backend/src/services/marketContext.ts 에 추가`).toBeGreaterThanOrEqual(need);
  });

  it("marketDate: 같은 순간은 표기(Z·+09:00)와 관계없이 같은 날짜", async () => {
    const { marketDate } = await import("@/lib/marketTime");
    expect(marketDate("2026-09-18T01:00:00+09:00", "AAPL")).toBe("2026-09-17");
    expect(marketDate("2026-09-17T16:00:00Z", "AAPL")).toBe("2026-09-17");
    expect(marketDate("2026-09-16T23:30:00Z", "005930")).toBe("2026-09-17");
    expect(marketDate("2026-09-17T08:30:00+09:00", "005930")).toBe("2026-09-17");
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
        expect(marketDate("2026-09-18T01:00:00+09:00", "AAPL")).toBe("2026-09-17");
        expect(marketDate("2026-01-16T04:30:00Z", "AAPL")).toBe("2026-01-15");
        expect(marketDate("2026-07-16T04:30:00Z", "AAPL")).toBe("2026-07-16");
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("sameTradingDay: 시각을 못 읽으면 막지 않는다 (서버와 같다)", async () => {
    const { sameTradingDay } = await import("@/lib/marketTime");
    expect(sameTradingDay("2026-09-16T15:30:00+09:00", "2026-09-17T09:00:00+09:00", "005930")).toBe(false);
    expect(sameTradingDay("", "2026-09-17T09:00:00+09:00", "005930")).toBe(true);
  });
});

describe("한국 평일 휴장일 목록(KR_HOLIDAYS)을 거래일 판단에 쓴다 — 서버 marketContext.tradingDate 와 같게", () => {
  const KR = "005930";
  const at = (iso: string) => Date.parse(iso);

  it("tradingDate: 추석(9/24 목·9/25 금)·그 주말은 직전 거래일 9/23, 휴장 뒤 첫 거래일(9/28 월 08:00~)은 그날", async () => {
    const { tradingDate } = await import("@/lib/marketTime");
    expect(tradingDate("2026-09-24T10:00:00+09:00", KR)).toBe("2026-09-23");
    expect(tradingDate("2026-09-24T08:00:00+09:00", KR)).toBe("2026-09-23");
    expect(tradingDate("2026-09-25T15:30:00+09:00", KR)).toBe("2026-09-23");
    expect(tradingDate("2026-09-25T00:30:00Z", KR)).toBe("2026-09-23"); // Z 표기(09:30 KST)도 같다
    expect(tradingDate("2026-09-27T12:00:00+09:00", KR)).toBe("2026-09-23");
    expect(tradingDate("2026-09-28T07:59:00+09:00", KR)).toBe("2026-09-23");
    expect(tradingDate("2026-09-28T08:00:00+09:00", KR)).toBe("2026-09-28");
  });

  it("tradingDate: 개천절 대체공휴일(10/5 월)·한글날(10/9 금)·연말 휴장(12/31 목)·2027(설 연휴 2/8~2/9, 추석 9/14~16, 12/27 성탄절 대체공휴일, 12/31)", async () => {
    const { tradingDate } = await import("@/lib/marketTime");
    expect(tradingDate("2026-10-05T10:00:00+09:00", KR)).toBe("2026-10-02"); // 월 → 금 (10/3 토 개천절)
    expect(tradingDate("2026-10-06T08:00:00+09:00", KR)).toBe("2026-10-06");
    expect(tradingDate("2026-10-09T10:00:00+09:00", KR)).toBe("2026-10-08");
    expect(tradingDate("2026-12-31T10:00:00+09:00", KR)).toBe("2026-12-30");
    expect(tradingDate("2027-01-01T10:00:00+09:00", KR)).toBe("2026-12-30"); // 신정까지 이어진 휴장
    expect(tradingDate("2027-01-04T09:00:00+09:00", KR)).toBe("2027-01-04");
    expect(tradingDate("2027-02-09T10:00:00+09:00", KR)).toBe("2027-02-05"); // 월·화 휴장 → 앞 금요일
    expect(tradingDate("2027-02-10T09:00:00+09:00", KR)).toBe("2027-02-10");
    expect(tradingDate("2027-09-16T14:00:00+09:00", KR)).toBe("2027-09-13");
    expect(tradingDate("2027-12-27T10:00:00+09:00", KR)).toBe("2027-12-24");
    expect(tradingDate("2027-12-31T10:00:00+09:00", KR)).toBe("2027-12-30");
  });

  it("평범한 평일(9/23 수)은 그대로, 미국 종목은 한국 휴장일과 상관없다 (추석 낮의 미국 주간거래 = 뉴욕 9/24 세션)", async () => {
    const { tradingDate, inTradingHours } = await import("@/lib/marketTime");
    expect(tradingDate("2026-09-23T10:00:00+09:00", KR)).toBe("2026-09-23");
    expect(inTradingHours("2026-09-23T10:00:00+09:00", KR)).toBe(true);
    expect(tradingDate("2026-09-24T10:30:00+09:00", "AAPL")).toBe("2026-09-24"); // 뉴욕 9/23 21:30 → 9/24 세션
    expect(tradingDate("2026-09-25T02:00:00+09:00", "AAPL")).toBe("2026-09-24"); // 뉴욕 9/24 13:00 정규장
    expect(inTradingHours("2026-09-24T10:30:00+09:00", "AAPL")).toBe(true);
    expect(inTradingHours("2026-10-05T23:00:00+09:00", "AAPL")).toBe(true);
    // 미국 휴장일 규칙은 그대로 (추수감사절 11/26)
    expect(tradingDate("2026-11-27T02:00:00+09:00", "AAPL")).toBe("2026-11-25");
  });

  it("inTradingHours: 한국 휴장일은 08:00~20:00 도 거래 시간이 아니다 (다음 거래일은 그대로)", async () => {
    const { inTradingHours } = await import("@/lib/marketTime");
    for (const iso of ["2026-09-24T08:00:00+09:00", "2026-09-24T10:00:00+09:00", "2026-09-25T19:59:00+09:00", "2026-10-05T09:00:00+09:00", "2026-12-31T10:00:00+09:00", "2027-09-15T10:00:00+09:00"]) {
      expect(inTradingHours(iso, KR), iso).toBe(false);
    }
    expect(inTradingHours("2026-09-28T08:00:00+09:00", KR)).toBe(true);
    expect(inTradingHours("2026-12-30T15:00:00+09:00", KR)).toBe(true);
  });

  it("tradingNow: 장 상태를 모르면 한국 휴장일에 차트를 1분마다 다시 받지 않는다 (장 상태를 받았으면 서버 값 그대로)", async () => {
    const { tradingNow } = await import("@/lib/marketTime");
    const { candleRefresh } = await import("@/lib/freshness");
    expect(tradingNow(KR, undefined, at("2026-09-24T10:00:00+09:00"))).toBe(false);
    expect(tradingNow(KR, undefined, at("2026-10-05T10:00:00+09:00"))).toBe(false);
    expect(tradingNow(KR, undefined, at("2026-12-31T10:00:00+09:00"))).toBe(false);
    expect(candleRefresh("D", tradingNow(KR, undefined, at("2026-09-25T10:00:00+09:00"))).refetchInterval).toBe(false);
    expect(tradingNow(KR, undefined, at("2026-09-23T10:00:00+09:00"))).toBe(true);
    expect(tradingNow(KR, { KR: { isOpen: true }, US: { isOpen: false } } as MarketStatus, at("2026-09-24T10:00:00+09:00"))).toBe(true);
    // 미국 종목은 한국 휴장과 상관없이 주간거래 시간이면 다시 받는다
    expect(tradingNow("AAPL", undefined, at("2026-09-24T10:30:00+09:00"))).toBe(true);
  });

  // 거래일이 바뀌는 순간은 모두 정각이다 — 서울 08:00(= 23:00Z), 뉴욕 20:00(= 00:00Z 서머타임 · 01:00Z), 서머타임 전환(06:00Z·07:00Z), 자정.
  // 그래서 매시 정각만 견줘도 경계 앞뒤를 모두 본다(예전 30분 간격 7만 번은 서버 쪽이 매번 Intl 을 새로 만들어 따로 돌려도 약 3초 —
  // 앱 전체 검사에서 기본 제한 5초를 넘겼다). 휴장일·주말이 몰린 달(설·추석·연말)은 경계 1분 전·1분 뒤까지 더 본다
  it("서버 marketContext.tradingDate 와 2026~2027 매시 정각마다 같다 (한국·미국 종목, 휴장일 달은 경계 ±1분까지)", { timeout: 30_000 }, async () => {
    const { tradingDate } = await import("@/lib/marketTime");
    const path = fileURLToPath(new URL("../../backend/src/services/marketContext.ts", import.meta.url));
    const server = (await import(/* @vite-ignore */ path)) as { tradingDate: (iso: string, kr: boolean) => string };
    let checked = 0;
    const same = (t: number) => {
      const iso = new Date(t).toISOString();
      for (const [code, kr] of [[KR, true], ["AAPL", false]] as const) {
        const app = tradingDate(iso, code);
        if (app !== server.tradingDate(iso, kr)) throw new Error(`불일치 ${iso} ${code}: 앱 ${app} · 서버 ${server.tradingDate(iso, kr)}`);
        checked++;
      }
    };
    for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2028-01-01T00:00:00Z"); t += 3_600_000) same(t);
    // 설(2026-02 · 2027-02) · 추석(2026-09~10 · 2027-09~10) · 연말연시(2026-12~2027-01 · 2027-12): 경계 시각(23:00Z · 00:00Z · 01:00Z)의 1분 전·뒤
    const busy = [["2026-02-01", "2026-03-04"], ["2026-09-20", "2026-10-12"], ["2026-12-20", "2027-01-05"], ["2027-02-01", "2027-03-03"], ["2027-09-10", "2027-10-13"], ["2027-12-20", "2028-01-01"]];
    for (const [from, to] of busy)
      for (let d = Date.parse(`${from}T00:00:00Z`); d < Date.parse(`${to}T00:00:00Z`); d += 86_400_000)
        for (const hour of [-1, 0, 1]) for (const dm of [-1, 1]) same(d + hour * 3_600_000 + dm * 60_000);
    expect(checked).toBeGreaterThan(35_000);
  });

  it("체결: 휴장일에 온 값 그대로의 체결은 9/23 시세와 같은 거래일(등락 유지), 휴장 뒤 첫 거래일 체결은 새 거래일로 보류", () => {
    const wed = quote(KR, 100, { prevClose: 90, change: 10, changeRate: 11.11, asOf: "2026-09-23T15:30:00+09:00" });
    const holiday = tick(KR, 100, "2026-09-24T10:00:03+09:00");
    expect(newTradingDay(wed, holiday)).toBe(false);
    expect(applyTick(wed, holiday)).toBe(wed); // 값이 같으면 그대로
    // 휴장일에 받은 시세(asOf = 받은 시각)도 9/23 거래 값 → 9/28 첫 체결은 보류
    const polled = { ...wed, asOf: "2026-09-25T11:00:00+09:00" };
    const monday = tick(KR, 101, "2026-09-28T09:00:01+09:00");
    expect(newTradingDay(polled, monday)).toBe(true);
    expect(applyTick(polled, monday)).toBe(polled);
    const held = new Set<string>();
    const list = [holding(KR, polled, 10, 80)];
    expect(applyTicksToList(list, latestPerCode([monday]), held)).toBe(list);
    expect([...held]).toEqual([KR]);
  });
});
