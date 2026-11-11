import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { LiveTick } from "../src/providers/market/tossRealtime.js";
import { PriceStream, type StreamSocket } from "../src/services/priceStream.js";
import { changePct, ratioPct, retruncRate, truncPct } from "../src/lib/pct.js";
import { krBaseWithFallback, NaverKrBase, parseKrBaseRow, pickKrBase, pickRegularClose } from "../src/providers/market/naverKrBase.js";
import { MarketCalendar, stateFromOfficial, type OfficialCalendar } from "../src/providers/market/calendar.js";
import { TossProvider } from "../src/providers/market/toss.js";
import { parseCalendarDay, TossOpenApiClient, TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { createMigratedDb } from "../src/db/index.js";
import { StockService } from "../src/services/stockService.js";
import { laterThan, polledOverWs } from "../src/services/tickOrder.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";
import type { FetchFn } from "../src/providers/market/types.js";
import { client, fakeFetch, NOW, type Call } from "./tossFake.js";

/**
 * 시세 정확도 (2026-11-12): 토스증권 화면·공식 계좌 API 와 맞대어 본 값으로 고정한다.
 *  - 퍼센트는 소수 둘째 자리 아래를 버린다 (반올림 아님)
 *  - 한국 종목 등락은 한국거래소 정규장 종가(기준가) 대비 — 공식 API 일봉의 통합 종가(NXT 애프터마켓 포함)가 아니다
 *  - 공식 장 운영 달력으로 장 상태를 정한다
 */

describe("퍼센트는 토스증권처럼 버린다 (lib/pct)", () => {
  it("실측 표본: 토스 화면과 같은 값 (반올림이면 0.01 씩 다르다)", () => {
    // [현재가, 기준가, 토스 표시]
    const samples: Array<[number, number, number]> = [
      [208_000, 198_900, 4.57], // 삼성전자 4.5751…
      [1_290_000, 1_212_000, 6.43], // SK하이닉스 6.4356…
      [195_500, 193_000, 1.29], // NAVER 1.2953…
      [274_500, 275_000, -0.18], // 현대차 -0.1818…
      [371_000, 339_000, 9.43], // LIG디펜스앤에어로스페이스 9.4395…
      [24_820, 24_640, 0.73], // KODEX 미국나스닥100
      [365.84, 367.44, -0.43], // 제너럴 다이내믹스 -0.4354… (음수도 0 쪽으로)
      [638.14, 641.39, -0.5], // 메타 -0.5067…
      [350.07, 331.98, 5.44], // 브로드컴 5.4491…
    ];
    for (const [price, base, toss] of samples) expect(changePct(price, base), `${price} / ${base}`).toBe(toss);
  });

  it("딱 떨어지는 값은 부동소수 오차로 깎이지 않는다", () => {
    expect(truncPct(4.58)).toBe(4.58);
    expect(truncPct(1.15)).toBe(1.15);
    expect(truncPct(-6.8)).toBe(-6.8);
    expect(truncPct(0.07 * 100)).toBe(7); // 7.000000000000001
    expect(changePct(110, 100)).toBe(10);
    expect(changePct(101.15, 100)).toBe(1.15);
    expect(changePct(99.71, 100)).toBe(-0.29);
  });

  it("0 으로 보이는 값은 0 (-0 아님), 기준이 없으면 null", () => {
    expect(Object.is(truncPct(-0.004), 0)).toBe(true);
    expect(truncPct(0.009)).toBe(0);
    expect(changePct(100, 0)).toBeNull();
    expect(changePct(100, null)).toBeNull();
    expect(ratioPct(5, 0)).toBeNull();
    expect(ratioPct(-12.3456, 100)).toBe(-12.34);
    expect(truncPct(Number.NaN)).toBeNaN();
  });
});

const row = (over: Record<string, unknown>) => ({
  itemCode: "005930",
  closePriceRaw: "208000",
  compareToPreviousClosePriceRaw: "9100",
  compareToPreviousPrice: { code: "2" },
  localTradedAt: "2026-11-11T20:00:00+09:00",
  ...over,
});

describe("한국 종목 기준가 (네이버 실시간 시세)", () => {
  // 11/11 삼성전자 분봉 실측: 15:19 정규장 연속 체결 · 15:30 종가 단일가(정규장 종가 206,000) · 15:40 시간외 종가 · 16:00~ 애프터마켓
  const MINUTES = [
    { localDateTime: "20261111151900", currentPrice: 205_750 },
    { localDateTime: "20261111153000", currentPrice: 206_000 },
    { localDateTime: "20261111154000", currentPrice: 206_000 },
    { localDateTime: "20261111160000", currentPrice: 205_500 },
    { localDateTime: "20261111164000", currentPrice: 205_500 },
  ];
  // NXT 애프터마켓 시세 실측 (SK하이닉스 11/11 20:00 — 체결 시각은 마이크로초까지 온다)
  const AFTER = { tradingSessionType: "AFTER_MARKET", overPrice: "1,290,000", compareToPreviousPrice: { code: "2" }, compareToPreviousClosePrice: "78,000", localTradedAt: "2026-11-11T20:00:00.000000+09:00" };
  // NXT 프리마켓 (모양은 애프터마켓 실측과 같고 세션 이름·시각만 다르다고 본 것): 207,000 · 오늘 기준가 206,000 대비 +1,000
  const PRE = { tradingSessionType: "PRE_MARKET", overPrice: "207,000", compareToPreviousPrice: { code: "2" }, compareToPreviousClosePrice: "1,000", localTradedAt: "2026-11-12T08:09:58.000000+09:00" };
  const ETF = { itemCode: "069500", closePriceRaw: "84540", compareToPreviousClosePriceRaw: "2540", localTradedAt: "2026-11-11T15:30:00+09:00" };

  it("현재가 − 전일 대비 = 기준가 (부호는 구분 코드로, 이미 붙어 오면 그대로) · 마지막 체결 시각과 시간외 시세도 읽는다", () => {
    expect(parseKrBaseRow(row({}))).toEqual({ close: 208_000, change: 9_100, tradedDate: "2026-11-11", tradedMinutes: 20 * 60, over: null });
    expect(parseKrBaseRow(row({ compareToPreviousPrice: { code: "5" }, compareToPreviousClosePriceRaw: "500" }))).toMatchObject({ change: -500 });
    expect(parseKrBaseRow(row({ compareToPreviousPrice: { code: "3" }, compareToPreviousClosePriceRaw: "0" }))).toMatchObject({ change: 0 });
    expect(parseKrBaseRow(row({ compareToPreviousClosePriceRaw: "-500", compareToPreviousPrice: { code: "2" } }))).toMatchObject({ change: -500 });
    expect(parseKrBaseRow(row({ closePriceRaw: undefined, closePrice: "1,291,000", compareToPreviousClosePriceRaw: undefined, compareToPreviousClosePrice: "79,000" }))).toMatchObject({ close: 1_291_000, change: 79_000 });
    expect(parseKrBaseRow(row(ETF))).toMatchObject({ tradedMinutes: 15 * 60 + 30 });
    // 시간외 시세: 가격 − 기준가 대비도 그 거래일 기준가다 (1,290,000 − 78,000 = 1,212,000)
    expect(parseKrBaseRow(row({ overMarketPriceInfo: AFTER }))!.over).toEqual({ price: 1_290_000, change: 78_000, tradedDate: "2026-11-11" });
    expect(parseKrBaseRow(row({ overMarketPriceInfo: { ...AFTER, overPrice: "-" } }))!.over).toBeNull();
    // 칸이 모자라면 쓰지 않는다
    expect(parseKrBaseRow(row({ closePriceRaw: "-" }))).toBeNull();
    expect(parseKrBaseRow(row({ localTradedAt: null }))).toBeNull();
  });

  it("거래일이 같으면 현재가 − 전일 대비, 새 거래일에 아직 체결 전이면 지난 '정규장' 종가가 기준가 (애프터마켓 마지막 가격이 아니다)", () => {
    const r = { close: 208_000, change: 9_100, tradedDate: "2026-11-11", tradedMinutes: 20 * 60, over: null };
    // 같은 거래일 (장중·장 마감 뒤·다음 날 08:00 전)
    expect(pickKrBase(r, "2026-11-11", { marketTraded: true, preOpenWindow: false })).toEqual({ base: 198_900, preOpen: false, approx: false });
    // 다음 거래일 08:00~개장: 네이버 값은 아직 어제 20:00 애프터마켓 가격(208,000) → 분봉에서 받은 정규장 종가(206,000)가 오늘 기준가
    expect(pickKrBase(r, "2026-11-12", { marketTraded: false, preOpenWindow: true, regularClose: 206_000 })).toEqual({ base: 206_000, preOpen: true, approx: false });
    // 개장 뒤 다른 종목은 체결됐는데 이 종목만 아직 체결 전
    expect(pickKrBase(r, "2026-11-12", { marketTraded: true, preOpenWindow: false, regularClose: 206_000 })).toEqual({ base: 206_000, preOpen: true, approx: false });
    // 정규장 종가를 아직 모르면 마지막 체결가로 어림한다 (approx — 분봉을 받으면 바뀐다)
    expect(pickKrBase(r, "2026-11-12", { marketTraded: false, preOpenWindow: true })).toEqual({ base: 208_000, preOpen: true, approx: true });
    // 지난 거래일 마지막 체결이 정규장 안(애프터마켓 체결 없음 — ETF 등)이면 그 가격이 곧 정규장 종가
    expect(pickKrBase({ close: 84_540, change: 2_540, tradedDate: "2026-11-11", tradedMinutes: 15 * 60 + 30, over: null }, "2026-11-12", { marketTraded: false, preOpenWindow: true })).toEqual({ base: 84_540, preOpen: true, approx: false });
    // 오늘 NXT 프리마켓에서 체결됨: 네이버가 오늘 기준가로 잰 값 (207,000 − 1,000) — 분봉 값보다 먼저 (권리락 날의 조정 기준가도 이 값)
    const pre = { ...r, over: { price: 207_000, change: 1_000, tradedDate: "2026-11-12" } };
    expect(pickKrBase(pre, "2026-11-12", { marketTraded: false, preOpenWindow: true, regularClose: 205_000 })).toEqual({ base: 206_000, preOpen: true, approx: false });
    // 어제 애프터마켓 시세만 있으면(체결 날짜가 지난 거래일) 쓰지 않는다
    const after = { ...r, over: { price: 208_000, change: 9_100, tradedDate: "2026-11-11" } };
    expect(pickKrBase(after, "2026-11-12", { marketTraded: false, preOpenWindow: true, regularClose: 206_000 })).toMatchObject({ base: 206_000 });
    // 개장 시각이 지나도 아무 종목도 체결이 없음 (목록에 없는 임시 휴장) → 지난 거래일 기준 그대로
    expect(pickKrBase(r, "2026-11-12", { marketTraded: false, preOpenWindow: false, regularClose: 206_000 })).toEqual({ base: 198_900, preOpen: false, approx: false });
  });

  it("분봉에서 정규장 종가를 고른다: 마감 시각(15:30, 수능일 16:30)까지의 마지막 가격 — 그 뒤 시간외·애프터마켓 봉은 쓰지 않는다", () => {
    expect(pickRegularClose(MINUTES, "2026-11-11", 15 * 60 + 30)).toBe(206_000);
    // 마감 동시호가에서 체결이 없었으면(15:30 봉 없음) 그 전 마지막 체결가
    expect(pickRegularClose(MINUTES.filter((m) => !m.localDateTime.endsWith("153000")), "2026-11-11", 15 * 60 + 30)).toBe(205_750);
    // 수능일(10:00~16:30)은 16:30 봉까지
    const late = [{ localDateTime: "20261119153000", currentPrice: 100 }, { localDateTime: "20261119163000", currentPrice: 103 }, { localDateTime: "20261119170000", currentPrice: 99 }];
    expect(pickRegularClose(late, "2026-11-19", 16 * 60 + 30)).toBe(103);
    // 다른 날짜 봉·모양이 다른 응답은 쓰지 않는다
    expect(pickRegularClose(MINUTES, "2026-11-10", 15 * 60 + 30)).toBeNull();
    expect(pickRegularClose({ datas: [] }, "2026-11-11", 15 * 60 + 30)).toBeNull();
    expect(pickRegularClose([{ localDateTime: "20261111153000", currentPrice: "-" }], "2026-11-11", 15 * 60 + 30)).toBeNull();
  });

  interface Fake {
    calls?: string[];
    minuteCalls?: string[];
    fail?: { on: boolean };
    minuteFail?: { on: boolean };
    minutes?: (code: string) => unknown | Promise<unknown>;
  }
  function naverFetch(rows: () => Array<Record<string, unknown>>, o: Fake = {}): FetchFn {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/chart/domestic/item/")) {
        o.minuteCalls?.push(u);
        if (o.minuteFail?.on) return new Response("x", { status: 500 });
        return json(await (o.minutes ? o.minutes(/item\/(\w+)\/minute/.exec(u)?.[1] ?? "") : []));
      }
      o.calls?.push(u);
      if (o.fail?.on) return new Response("x", { status: 500 });
      return json({ datas: rows() });
    }) as FetchFn;
  }

  it("여러 종목을 한 요청으로 받고(기준 종목 삼성전자 포함), 1분 안에는 다시 묻지 않는다", async () => {
    let now = new Date("2026-11-12T00:20:00+09:00"); // 11/11 거래일의 밤 (08:00 전은 전 거래일)
    const calls: string[] = [];
    const src = new NaverKrBase(
      naverFetch(
        () => [
          row({}),
          row({ itemCode: "000660", closePriceRaw: "1291000", compareToPreviousClosePriceRaw: "79000", overMarketPriceInfo: AFTER }),
          row({ itemCode: "005380", closePriceRaw: "275000", compareToPreviousClosePriceRaw: "0", compareToPreviousPrice: { code: "3" } }),
        ],
        { calls, minutes: () => MINUTES },
      ),
      () => now,
    );
    const m = await src.baseMany(["000660", "005380", "AAPL"]);
    expect(Object.fromEntries(m)).toEqual({ "000660": 1_212_000, "005380": 275_000 }); // 미국 종목은 묻지 않는다
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/005930,000660,005380");
    now = new Date(now.getTime() + 30_000);
    expect((await src.baseMany(["000660"])).get("000660")).toBe(1_212_000);
    expect(calls).toHaveLength(1);
    expect(await src.basePrice("005380")).toBe(275_000);
    await src.idle();
    expect(src.status()).toMatchObject({ held: 2, approx: 0, ok: 1, failed: 0, lastError: null });
  });

  it("새로 받지 못해도 같은 거래일에 받아 둔 기준가는 그대로 쓴다 (기준가는 그날 바뀌지 않는다)", async () => {
    let now = new Date("2026-11-11T10:00:00+09:00");
    const fail = { on: false };
    const calls: string[] = [];
    const src = new NaverKrBase(naverFetch(() => [row({ closePriceRaw: "203000", compareToPreviousClosePriceRaw: "4100", localTradedAt: "2026-11-11T10:00:00+09:00" })], { calls, fail }), () => now);
    expect(await src.basePrice("005930")).toBe(198_900);
    fail.on = true;
    now = new Date("2026-11-11T14:00:00+09:00");
    expect(await src.basePrice("005930")).toBe(198_900); // 실패해도 그대로
    await src.idle();
    expect(src.status()).toMatchObject({ failed: 1 });
    // 실패 직후에는 잠깐 다시 묻지 않는다
    const n = calls.length;
    expect(await src.basePrice("005930")).toBe(198_900);
    await src.idle();
    expect(calls).toHaveLength(n);
    // 거래일이 바뀌면 옛 기준가는 쓰지 않는다 (받지 못하면 없음 → 부르는 쪽이 일봉으로)
    now = new Date("2026-11-12T08:30:00+09:00");
    expect(await src.basePrice("005930")).toBeNull();
  });

  it("받아 둔 기준가가 있으면 네이버가 느려도 기다리지 않는다 — 다시 확인은 뒤에서 (예전에는 기다리다 시간 초과로 한국 종목 전체가 일봉 기준으로 떨어졌다)", async () => {
    let now = new Date("2026-11-11T10:00:00+09:00");
    const hang = { on: false, release: () => {} };
    const calls: string[] = [];
    const base = naverFetch(() => [row({ closePriceRaw: "203000", compareToPreviousClosePriceRaw: "4100", localTradedAt: "2026-11-11T10:00:00+09:00" })], { calls });
    const src = new NaverKrBase(
      (async (url: string | URL | Request, init?: RequestInit) => {
        if (hang.on) await new Promise<void>((r) => (hang.release = r));
        return base(url, init);
      }) as FetchFn,
      () => now,
    );
    expect(await src.basePrice("005930")).toBe(198_900);
    hang.on = true;
    now = new Date("2026-11-11T10:05:00+09:00"); // 1분이 지나 다시 확인할 때
    const got = await Promise.race([src.basePrice("005930"), new Promise((r) => setTimeout(() => r("기다림"), 200))]);
    expect(got).toBe(198_900);
    hang.on = false;
    hang.release();
    await src.idle();
    expect(calls).toHaveLength(2);
  });

  it("네이버가 값을 주지 않는 종목은 1분 동안 다시 묻지 않는다 (시세 조회마다 요청이 나가지 않게)", async () => {
    let now = new Date("2026-11-11T10:00:00+09:00");
    const calls: string[] = [];
    const src = new NaverKrBase(naverFetch(() => [row({ closePriceRaw: "203000", compareToPreviousClosePriceRaw: "4100", localTradedAt: "2026-11-11T10:00:00+09:00" })], { calls }), () => now);
    expect(Object.fromEntries(await src.baseMany(["005930", "999999"]))).toEqual({ "005930": 198_900 });
    expect(calls).toHaveLength(1);
    now = new Date(now.getTime() + 10_000);
    expect((await src.baseMany(["005930", "999999"])).has("999999")).toBe(false);
    await src.idle();
    expect(calls).toHaveLength(1);
    now = new Date(now.getTime() + 61_000);
    await src.baseMany(["999999"]);
    expect(calls).toHaveLength(2);
  });

  it("저녁·밤: 애프터마켓에서 움직인 종목은 내일 아침에 쓸 정규장 종가(분봉)를 미리 받아 둔다 → 08:00 에 기다리지 않고 토스와 같은 기준가", async () => {
    let now = new Date("2026-11-12T00:20:00+09:00");
    const calls: string[] = [];
    const minuteCalls: string[] = [];
    const src = new NaverKrBase(naverFetch(() => [row({}), row(ETF)], { calls, minuteCalls, minutes: () => MINUTES }), () => now);
    // 밤(11/11 거래일): 현재가 − 전일 대비
    expect(Object.fromEntries(await src.baseMany(["005930", "069500"]))).toEqual({ "005930": 198_900, "069500": 82_000 });
    await src.idle();
    // 분봉은 삼성전자만 (ETF 는 애프터마켓 체결이 없어 마지막 가격이 곧 정규장 종가). 정규장 09:00 ~ 마감 15:30 조금 뒤까지
    expect(minuteCalls).toHaveLength(1);
    expect(minuteCalls[0]).toContain("/005930/minute?startDateTime=202611110900&endDateTime=202611111535");
    expect(src.status()).toMatchObject({ regular: 1, approx: 0 });
    // 08:10 새 거래일: 네이버 값은 아직 어제 20:00 가격(208,000) — 기준가는 정규장 종가 206,000 (예전에는 208,000 으로 잡아 약 1%p 틀렸다). 분봉은 다시 묻지 않는다
    now = new Date("2026-11-12T08:10:00+09:00");
    expect(Object.fromEntries(await src.baseMany(["005930", "069500"]))).toEqual({ "005930": 206_000, "069500": 84_540 });
    await src.idle();
    expect(minuteCalls).toHaveLength(1);
    expect(src.status()).toMatchObject({ approx: 0 });
  });

  it("아침에 서버가 다시 켜져 받아 둔 정규장 종가가 없으면 분봉을 받아 답한다 · 개장해 네이버 값이 오늘 것이 되면 현재가 − 전일 대비", async () => {
    let now = new Date("2026-11-12T08:10:00+09:00");
    let rows = [row({})]; // 아직 11/11 값 (20:00 애프터마켓 208,000)
    const minuteCalls: string[] = [];
    const src = new NaverKrBase(naverFetch(() => rows, { minuteCalls, minutes: () => MINUTES }), () => now);
    expect(await src.basePrice("005930")).toBe(206_000);
    expect(minuteCalls).toHaveLength(1);
    expect(src.status()).toMatchObject({ approx: 0, regularOk: 1 });
    // 09:01 개장: 오늘 체결 210,500 (+4,500)
    now = new Date("2026-11-12T09:01:00+09:00");
    rows = [row({ closePriceRaw: "210500", compareToPreviousClosePriceRaw: "4500", localTradedAt: "2026-11-12T09:01:00+09:00" })];
    expect(await src.basePrice("005930")).toBe(206_000);
    await src.idle();
    expect(await src.basePrice("005930")).toBe(206_000);
  });

  it("분봉이 늦으면 먼저 마지막 체결가로 어림해 답하고, 받는 대로 정규장 종가로 바꾼다 (시세 조회를 붙잡지 않는다)", async () => {
    const now = new Date("2026-11-12T08:10:00+09:00");
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const src = new NaverKrBase(
      naverFetch(() => [row({})], {
        minutes: async () => {
          await gate;
          return MINUTES;
        },
      }),
      () => now,
      { regularWaitMs: 10 },
    );
    expect(await src.basePrice("005930")).toBe(208_000);
    expect(src.status()).toMatchObject({ approx: 1 });
    release();
    await src.idle();
    expect(await src.basePrice("005930")).toBe(206_000);
    expect(src.status()).toMatchObject({ approx: 0 });
  });

  it("분봉을 받지 못하면 어림값을 쓰다가 30초 뒤 다시 받아 바꾼다", async () => {
    let now = new Date("2026-11-12T08:10:00+09:00");
    const minuteFail = { on: true };
    const minuteCalls: string[] = [];
    const src = new NaverKrBase(naverFetch(() => [row({})], { minuteCalls, minuteFail, minutes: () => MINUTES }), () => now);
    expect(await src.basePrice("005930")).toBe(208_000);
    expect(src.status()).toMatchObject({ approx: 1, regularFailed: 1 });
    minuteFail.on = false;
    // 개장 전 값은 20초마다 다시 확인하지만 분봉은 30초 쉰다
    now = new Date(now.getTime() + 21_000);
    expect(await src.basePrice("005930")).toBe(208_000);
    await src.idle();
    expect(minuteCalls).toHaveLength(1);
    now = new Date(now.getTime() + 21_000);
    await src.basePrice("005930");
    await src.idle();
    expect(minuteCalls).toHaveLength(2);
    expect(await src.basePrice("005930")).toBe(206_000);
    expect(src.status()).toMatchObject({ approx: 0, regularLastError: null });
  });

  it("오늘 NXT 프리마켓에서 체결된 종목은 네이버가 오늘 기준가로 잰 값을 쓴다 (분봉을 묻지 않는다)", async () => {
    const now = new Date("2026-11-12T08:10:00+09:00");
    const minuteCalls: string[] = [];
    const src = new NaverKrBase(naverFetch(() => [row({ overMarketPriceInfo: PRE })], { minuteCalls }), () => now);
    expect(await src.basePrice("005930")).toBe(206_000);
    await src.idle();
    expect(minuteCalls).toHaveLength(0);
  });

  it("권리락 날: 개장 전에는 어제 정규장 종가, 개장 뒤에는 조정 기준가로 바뀐다 (개장 전 값은 20초마다 다시 확인)", async () => {
    let now = new Date("2026-11-12T08:59:50+09:00");
    let rows = [row({})];
    const src = new NaverKrBase(naverFetch(() => rows, { minutes: () => MINUTES }), () => now);
    expect(await src.basePrice("005930")).toBe(206_000);
    now = new Date("2026-11-12T09:00:30+09:00");
    rows = [row({ closePriceRaw: "104500", compareToPreviousClosePriceRaw: "500", localTradedAt: "2026-11-12T09:00:20+09:00" })]; // 조정 기준가 104,000
    await src.basePrice("005930"); // 받아 둔 값을 바로 돌려주고 뒤에서 다시 확인한다
    await src.idle();
    expect(await src.basePrice("005930")).toBe(104_000);
  });

  it("기준가 출처 잇기: 네이버에 없는 종목만 다른 출처에 묻고, 그 출처가 느리거나 실패해도 네이버가 준 값은 그대로 돌려준다", async () => {
    const primary = async () => new Map([["005930", 198_900]]);
    const asked: string[][] = [];
    const quick = async (c: string[]) => {
      asked.push(c);
      return new Map([["000660", 1_212_000]]);
    };
    expect(Object.fromEntries(await krBaseWithFallback(["005930", "000660"], primary, quick))).toEqual({ "005930": 198_900, "000660": 1_212_000 });
    expect(asked).toEqual([["000660"]]);
    // 모두 네이버에 있으면 다른 출처는 묻지 않는다
    await krBaseWithFallback(["005930"], primary, quick);
    expect(asked).toHaveLength(1);
    const never = () => new Promise<Map<string, number>>(() => {});
    expect(Object.fromEntries(await krBaseWithFallback(["005930", "000660"], primary, never, 20))).toEqual({ "005930": 198_900 });
    const boom = async (): Promise<Map<string, number>> => {
      throw new Error("x");
    };
    expect(Object.fromEntries(await krBaseWithFallback(["005930", "000660"], primary, boom, 20))).toEqual({ "005930": 198_900 });
    expect((await krBaseWithFallback(["005930"], boom, boom, 20)).size).toBe(0);
  });
});

describe("공식 API 시세: 기준가가 있으면 토스와 같은 등락", () => {
  it("일봉 종가(통합 종가)가 아니라 기준가로 등락을 낸다 · 등락률은 버림", async () => {
    // 가짜 현재가 201,500 · 어제 봉 종가 219,900
    const p = new TossOpenApiProvider(client(), { now: NOW, krBaseMany: async () => new Map([["035420", 198_900]]) });
    const q = await p.getQuote("035420");
    expect(q).toMatchObject({ prevClose: 198_900, prevCloseBasis: "base", change: 2_600, changeRate: 1.3 }); // 1.3071…
    expect(p.baseFallbacks).toBe(0);
  });
});

const day = (date: string, open: [string, string] | null, regular: [string, string] | null = open) => ({
  date,
  open: open ? { startTime: open[0], endTime: open[1] } : null,
  regular: regular ? { startTime: regular[0], endTime: regular[1] } : null,
});

describe("공식 장 운영 달력 → 장 상태", () => {
  const KR: OfficialCalendar = {
    previous: day("2026-11-11", ["2026-11-11T08:00:00.000+09:00", "2026-11-11T20:00:00.000+09:00"]),
    today: day("2026-11-12", ["2026-11-12T08:00:00.000+09:00", "2026-11-12T20:00:00.000+09:00"]),
    next: day("2026-11-13", ["2026-11-13T08:00:00.000+09:00", "2026-11-13T20:00:00.000+09:00"]),
  };
  // 미국: '오늘'은 한국 날짜 기준이라, 한국 새벽에 열린 정규장은 전 영업일 칸에 있다
  const US: OfficialCalendar = {
    previous: day("2026-11-11", ["2026-11-11T10:00:00.000+09:00", "2026-11-12T09:50:00.000+09:00"], ["2026-11-11T23:30:00.000+09:00", "2026-11-12T06:00:00.000+09:00"]),
    today: day("2026-11-12", ["2026-11-12T10:00:00.000+09:00", "2026-11-13T09:50:00.000+09:00"], ["2026-11-12T23:30:00.000+09:00", "2026-11-13T06:00:00.000+09:00"]),
    next: day("2026-11-13", ["2026-11-13T10:00:00.000+09:00", "2026-11-14T09:50:00.000+09:00"], ["2026-11-13T23:30:00.000+09:00", "2026-11-14T06:00:00.000+09:00"]),
  };

  it("한국: 통합 08:00~20:00 창 — 장중·장 마감 뒤·개장 전", () => {
    expect(stateFromOfficial("KR", new Date("2026-11-12T10:00:00+09:00"), KR)).toEqual({
      market: "KR", isTradingDay: true, isOpen: true, opensAt: null, closesAt: "2026-11-12T11:00:00.000Z", lastClose: null, source: "toss",
    });
    expect(stateFromOfficial("KR", new Date("2026-11-12T21:00:00+09:00"), KR)).toMatchObject({ isOpen: false, isTradingDay: true, opensAt: "2026-11-12T23:00:00.000Z", lastClose: "2026-11-12T11:00:00.000Z" });
    expect(stateFromOfficial("KR", new Date("2026-11-12T00:20:00+09:00"), KR)).toMatchObject({ isOpen: false, isTradingDay: true, opensAt: "2026-11-11T23:00:00.000Z", lastClose: "2026-11-11T11:00:00.000Z" });
  });

  it("미국: 정규장만 — 한국 새벽(전 영업일 칸의 정규장)도 장중으로 안다", () => {
    expect(stateFromOfficial("US", new Date("2026-11-12T00:20:00+09:00"), US)).toMatchObject({ isOpen: true, isTradingDay: true, closesAt: "2026-11-11T21:00:00.000Z" });
    // 프리마켓 시간(한국 저녁)은 정규장이 아니다
    expect(stateFromOfficial("US", new Date("2026-11-12T20:00:00+09:00"), US)).toMatchObject({ isOpen: false, opensAt: "2026-11-12T14:30:00.000Z", lastClose: "2026-11-11T21:00:00.000Z" });
  });

  it("휴장일: 오늘 창이 없으면 지난 창과 다음 창 사이 — 그 사이 날은 휴장으로 안다", async () => {
    const holiday: OfficialCalendar = {
      previous: day("2026-11-25", ["2026-11-25T10:00:00.000+09:00", "2026-11-26T09:50:00.000+09:00"], ["2026-11-25T23:30:00.000+09:00", "2026-11-26T06:00:00.000+09:00"]),
      today: day("2026-11-26", null),
      next: day("2026-11-27", ["2026-11-27T10:00:00.000+09:00", "2026-11-28T07:00:00.000+09:00"], ["2026-11-27T23:30:00.000+09:00", "2026-11-28T03:00:00.000+09:00"]),
    };
    const now = new Date("2026-11-27T02:00:00+09:00"); // 뉴욕 11/26 (추수감사절) 정오
    const s = stateFromOfficial("US", now, holiday);
    expect(s).toMatchObject({ isOpen: false, isTradingDay: false, opensAt: "2026-11-27T14:30:00.000Z", lastClose: "2026-11-25T21:00:00.000Z" });
    // 조기 폐장(11/27 13:00 ET = 한국 03:00)도 그날 시각으로 온다
    const cal = new MarketCalendar((async () => new Response("x", { status: 500 })) as FetchFn, () => now, 60_000, { warn: () => {} }, async (m) => (m === "US" ? holiday : KR));
    expect(await cal.isTradingDate("US", "2026-11-26")).toBe(false);
    expect(await cal.isTradingDate("US", "2026-11-27")).toBe(true);
    expect((await cal.status()).US.source).toBe("toss");
  });

  it("공식 달력을 받지 못하면 요일·휴장일 목록으로 추정한다 (한쪽만 실패해도 다른 쪽은 공식 달력)", async () => {
    const now = new Date("2026-11-12T10:00:00+09:00");
    const cal = new MarketCalendar((async () => new Response("x", { status: 500 })) as FetchFn, () => now, 60_000, { warn: () => {} }, async (m) => {
      if (m === "US") throw new Error("down");
      return KR;
    });
    const s = await cal.status();
    expect(s.KR).toMatchObject({ source: "toss", isOpen: true });
    expect(s.US).toMatchObject({ source: "fallback" });
  });

  it("공식 응답 한 날을 읽는다: 한국은 통합 프리~애프터, 미국은 데이마켓~애프터 · 휴장은 창 없음 · 수능일은 프리마켓 없음", () => {
    const kr = parseCalendarDay("KR", {
      date: "2026-11-12",
      integrated: {
        preMarket: { startTime: "2026-11-12T08:00:00.000+09:00", singlePriceAuctionStartTime: "2026-11-12T08:50:00.000+09:00", endTime: "2026-11-12T09:00:00.000+09:00" },
        regularMarket: { startTime: "2026-11-12T09:00:00.000+09:00", endTime: "2026-11-12T15:30:00.000+09:00" },
        afterMarket: { startTime: "2026-11-12T15:30:00.000+09:00", endTime: "2026-11-12T20:00:00.000+09:00" },
      },
    });
    expect(kr).toMatchObject({ date: "2026-11-12", open: { startTime: "2026-11-12T08:00:00.000+09:00", endTime: "2026-11-12T20:00:00.000+09:00" }, regular: { startTime: "2026-11-12T09:00:00.000+09:00" } });
    const suneung = parseCalendarDay("KR", { date: "2026-11-19", integrated: { preMarket: null, regularMarket: { startTime: "2026-11-19T10:00:00.000+09:00", endTime: "2026-11-19T16:30:00.000+09:00" }, afterMarket: { startTime: "2026-11-19T16:30:00.000+09:00", endTime: "2026-11-19T20:00:00.000+09:00" } } });
    expect(suneung?.open).toEqual({ startTime: "2026-11-19T10:00:00.000+09:00", endTime: "2026-11-19T20:00:00.000+09:00" });
    expect(parseCalendarDay("US", { date: "2026-11-26", dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null })).toMatchObject({ open: null, regular: null });
    expect(parseCalendarDay("KR", { date: "2026-10-09", integrated: null })).toMatchObject({ open: null, regular: null });
    expect(parseCalendarDay("KR", { nope: 1 })).toBeNull();
  });
});

describe("공식 API 현재가 일괄 — 1초 확인 (실시간 보조)", () => {
  it("여러 종목을 요청 1개로 받고, 체결 시각은 실제 체결 시각 그대로 · 0.8초 안에는 다시 부르지 않는다", async () => {
    const calls: Call[] = [];
    let now = NOW();
    const p = new TossOpenApiProvider(client({}, calls), { now: () => now });
    expect(p.tradeTime).toBe(true);
    expect(p.pollMs).toBe(1_000);
    const m = await p.getMany(["035420", "tsla"]);
    expect(m.get("TSLA")).toMatchObject({ code: "TSLA", price: 377.5, timestamp: "2026-09-22T13:59:00.000+09:00", receivedAt: now.getTime(), volume: null });
    expect(m.get("035420")).toMatchObject({ price: 201_500, timestamp: "2026-09-22T13:59:30.123+09:00" });
    const priceCalls = () => calls.filter((c) => c.url.includes("/api/v1/prices")).length;
    expect(priceCalls()).toBe(1);
    now = new Date(now.getTime() + 500);
    expect((await p.getMany(["035420"])).get("035420")?.price).toBe(201_500);
    expect(priceCalls()).toBe(1);
    now = new Date(now.getTime() + 600);
    await p.getMany(["035420", "TSLA"]);
    expect(priceCalls()).toBe(2);
    // 받은 뒤에는 세션 사실에 '받는 중'(pricedAt)이 찍힌다. 미국 주간거래 대상은 공식 API 에 없어 모름
    const facts = p.sessionFacts(["TSLA"]).get("TSLA")!;
    expect(facts.pricedAt).toBe(now.getTime());
    expect(facts.daytime).toBeNull();
  });

  it("요청 한도(429)에 걸리면 5초 동안 받아 둔 값만 돌려준다 (다른 조회가 밀리지 않게)", async () => {
    const calls: Call[] = [];
    let now = NOW();
    const limited = { on: false };
    const base = fakeFetch({ calls });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (limited.on && String(input).includes("/api/v1/prices")) {
        calls.push({ method: "GET", url: String(input), headers: {}, body: null });
        return new Response(JSON.stringify({ error: { code: "rate-limit-exceeded" } }), { status: 429, headers: { "retry-after": "0" } });
      }
      return base(input, init);
    }) as typeof fetch;
    const c = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => now, maxRetryWaitMs: 0 });
    const p = new TossOpenApiProvider(c, { now: () => now });
    await p.getMany(["035420"]);
    limited.on = true;
    now = new Date(now.getTime() + 1_000);
    await expect(p.getMany(["035420"])).rejects.toThrow(/429/);
    expect(c.status.lastRateLimitedAt).not.toBeNull();
    expect(c.status.rateLimited).toEqual({ "/api/v1/prices": 2 }); // 어느 조회가 한도에 걸렸는지 (/health) — 처음 + 한 번 다시 시도
    const n = calls.filter((x) => x.url.includes("/prices")).length;
    now = new Date(now.getTime() + 2_000);
    expect((await p.getMany(["035420"])).size).toBe(0); // 쉬는 중 — 요청 없음, 오래된 값은 주지 않는다
    expect(calls.filter((x) => x.url.includes("/prices")).length).toBe(n);
    limited.on = false;
    now = new Date(now.getTime() + 4_000);
    expect((await p.getMany(["035420"])).get("035420")?.price).toBe(201_500);
  });

  it("모르는 종목 하나 때문에 묶음이 거절되면 종목별로 한 번만 가려내고, 그 종목은 10분 동안 묶음에서 뺀다 (1초마다 '묶음 1 + 종목 수'만큼 부르지 않게)", async () => {
    const calls: Call[] = [];
    let now = NOW();
    const base = fakeFetch({ calls });
    // 공식 API 가 모르는 종목(ZZZZ)이 섞인 묶음은 통째로 400
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/prices") && new URL(url).searchParams.get("symbols")!.split(",").includes("ZZZZ")) {
        calls.push({ method: "GET", url, headers: {}, body: null });
        return new Response(JSON.stringify({ error: { code: "invalid-symbol" } }), { status: 400 });
      }
      return base(input, init);
    }) as typeof fetch;
    const c = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => now, maxRetryWaitMs: 0 });
    const p = new TossOpenApiProvider(c, { now: () => now });
    const priceCalls = () => calls.filter((x) => x.url.includes("/api/v1/prices")).length;
    // 첫 번째: 묶음 1(거절) + 종목별 3 — 아는 종목은 살린다
    const m = await p.getMany(["035420", "TSLA", "ZZZZ"]);
    expect([...m.keys()].sort()).toEqual(["035420", "TSLA"]);
    expect(priceCalls()).toBe(4);
    // 그 뒤 1초마다: 모르는 종목을 뺀 묶음 1개만
    for (let i = 0; i < 5; i++) {
      now = new Date(now.getTime() + 1_000);
      expect((await p.getMany(["035420", "TSLA", "ZZZZ"])).size).toBe(2);
    }
    expect(priceCalls()).toBe(4 + 5);
    expect(calls.at(-1)!.url).not.toContain("ZZZZ");
    // 그 종목만 물으면 요청 없이 빈 값 (상세 화면을 보는 동안 두드리지 않는다)
    now = new Date(now.getTime() + 1_000);
    expect((await p.getMany(["ZZZZ"])).size).toBe(0);
    expect(priceCalls()).toBe(9);
    // 10분 뒤에는 다시 넣어 본다 (다시 상장·오타 수정 등)
    now = new Date(now.getTime() + 10 * 60_000);
    await p.getMany(["035420", "ZZZZ"]);
    expect(priceCalls()).toBe(9 + 1 + 2);
  });

  it("한 종목만 물었는데 거절되면 1분 동안 다시 묻지 않는다", async () => {
    const calls: Call[] = [];
    let now = NOW();
    const fetchFn = (async (input: string | URL | Request) => {
      calls.push({ method: "GET", url: String(input), headers: {}, body: null });
      if (String(input).includes("/oauth")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "invalid-symbol" } }), { status: 400 });
    }) as typeof fetch;
    const c = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => now, maxRetryWaitMs: 0 });
    const p = new TossOpenApiProvider(c, { now: () => now });
    const priceCalls = () => calls.filter((x) => x.url.includes("/api/v1/prices")).length;
    await expect(p.getMany(["ZZZZ"])).rejects.toThrow(/400/);
    const n = priceCalls();
    now = new Date(now.getTime() + 5_000);
    expect((await p.getMany(["ZZZZ"])).size).toBe(0);
    expect(priceCalls()).toBe(n);
    now = new Date(now.getTime() + 60_000);
    await expect(p.getMany(["ZZZZ"])).rejects.toThrow(/400/);
    expect(priceCalls()).toBe(n + 1);
  });

  it("응답 머리글의 초당 허용 요청 수를 상태에 적는다 (/health 에서 본다)", async () => {
    const base = fakeFetch();
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await base(input, init);
      if (!String(input).includes("/api/v1/prices")) return res;
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "x-ratelimit-limit": "15" } });
    }) as typeof fetch;
    const c = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: NOW, maxRetryWaitMs: 0 });
    await new TossOpenApiProvider(c, { now: NOW }).getMany(["035420"]);
    expect(c.status.rateLimits).toEqual({ "/api/v1/prices": 15 });
  });
});

describe("StockService — 웹소켓 체결과 1초 확인 값 중 체결 시각이 새로운 쪽", () => {
  const at = new Date("2026-09-22T14:30:10+09:00");
  const tick = (price: number, timestamp: string, receivedAt = at.getTime()) => ({ code: "000660", price, volume: null, timestamp, receivedAt });
  const liveOf = (ticks: Map<string, ReturnType<typeof tick>>) => ({
    get: (c: string) => ticks.get(c) ?? null,
    setCodes: () => {},
    status: () => ({ enabled: true, connected: true, subscribed: ["trade:kr:000660"], lastMessageAt: at.toISOString(), lastError: null, lastAliveAt: at.toISOString() }),
  });
  const quickOf = (ticks: Map<string, ReturnType<typeof tick>>) => ({ name: "toss-openapi", tradeTime: true as const, pollMs: 1_000, getMany: async (codes: string[]) => new Map(codes.flatMap((c) => (ticks.has(c) ? [[c, ticks.get(c)!] as [string, ReturnType<typeof tick>]] : []))) });

  it("웹소켓이 놓친 체결을 1초 확인이 메우고, 웹소켓 체결이 더 새로우면 웹소켓 체결을 쓴다", async () => {
    const db = await createMigratedDb(":memory:");
    const ws = new Map([["000660", tick(101_000, "2026-09-22T14:29:50.120+09:00")]]);
    const quick = new Map([["000660", tick(101_500, "2026-09-22T14:30:05.000+09:00")]]);
    const service = new StockService({ db, quotes: new FakeQuoteProvider("toss-openapi"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), live: liveOf(ws), quickPrices: quickOf(quick), now: () => at });
    await service.refreshMaster();
    await service.register({ code: "000660" });
    // 1초 확인 값(14:30:05)이 웹소켓 마지막 체결(14:29:50)보다 새롭다 → 그 값. 등락률은 99,000 기준 버림 (2.5252…)
    expect((await service.listWithQuotes())[0]!.quote).toMatchObject({ price: 101_500, change: 2_500, changeRate: 2.52, asOf: "2026-09-22T14:30:05.000+09:00", live: true });
    // 웹소켓 체결이 더 새로워지면 웹소켓 체결
    ws.set("000660", tick(101_700, "2026-09-22T14:30:08.450+09:00"));
    expect((await service.listWithQuotes())[0]!.quote).toMatchObject({ price: 101_700, asOf: "2026-09-22T14:30:08.450+09:00" });
    // 같은 초(1초 확인 값은 초 단위로 온다)에 받은 값이면 밀리초까지 있는 웹소켓 체결 (어느 쪽이 나중인지 모른다)
    quick.set("000660", tick(101_600, "2026-09-22T14:30:08.000+09:00"));
    expect((await service.listWithQuotes())[0]!.quote!.price).toBe(101_700);
    // 웹소켓 체결을 받고 1.5초 넘게 지나 받은 현재가가 같은 초·다른 가격이면 웹소켓이 놓친 나중 체결이다 → 그 값 (세션 마지막 초에 놓쳐도 밤새 틀린 가격이 남지 않게)
    quick.set("000660", tick(101_600, "2026-09-22T14:30:08.000+09:00", at.getTime() + 2_000));
    expect((await service.listWithQuotes())[0]!.quote).toMatchObject({ price: 101_600, asOf: "2026-09-22T05:30:08.451Z" });
    // 공식 API 현재가는 시간외 체결까지 든 값이라 실시간 스트림에서 빼는 종목이 없다
    expect([...(await service.webOff(["000660"]))]).toEqual([]);
    await db.destroy();
  });

  it("체결이 뜸한 종목: 방금 받은 값의 체결 시각이 몇 분 전이어도 버리지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    const quick = new Map([["000660", tick(100_800, "2026-09-22T14:21:00.000+09:00")]]);
    const service = new StockService({ db, quotes: new FakeQuoteProvider("toss-openapi"), search: new FakeSearchProvider(), master: new FakeMasterProvider(), quickPrices: quickOf(quick), now: () => at });
    await service.refreshMaster();
    await service.register({ code: "000660" });
    expect((await service.listWithQuotes())[0]!.quote).toMatchObject({ price: 100_800, asOf: "2026-09-22T14:21:00.000+09:00" });
    await db.destroy();
  });
});

describe("실시간 스트림 — 앱이 보고 있는 종목(등록 종목 밖)도 같이 확인한다", () => {
  class Sock extends EventEmitter implements StreamSocket {
    sent: Array<Record<string, unknown>> = [];
    readyState = 1;
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.emit("close");
    }
    ticks() {
      return this.sent.flatMap((m) => (m["type"] === "ticks" ? (m["ticks"] as Array<{ code: string; price: number }>) : m["type"] === "tick" ? [m as unknown as { code: string; price: number }] : []));
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("{type:'view'} 로 알린 종목을 폴링에 더하고, 목록을 바꾸거나 끊으면 뺀다 · 앱마다 8개까지 · 이상한 코드는 버린다", async () => {
    const asked: string[][] = [];
    const prices = new Map([["000660", 100_000], ["NVDA", 180.5], ["AAPL", 250]]);
    const quick = {
      name: "toss-openapi",
      tradeTime: true as const,
      getMany: async (codes: string[]) => {
        asked.push([...codes]);
        return new Map(codes.flatMap((c) => (prices.has(c) ? [[c, { code: c, price: prices.get(c)!, volume: null, timestamp: "2026-09-23T10:00:00.000+09:00", receivedAt: Date.now() }] as [string, LiveTick]] : [])));
      },
    };
    const stream = new PriceStream({ quickPrices: quick, codes: async () => ["000660"], wsServed: async () => new Set<string>(), pollMs: 60_000, pingMs: 60_000, batchMs: 0 });
    const a = new Sock();
    stream.attach(a);
    a.emit("message", JSON.stringify({ type: "hello", batch: true }));
    await settle();
    expect(asked.at(-1)).toEqual(["000660"]);
    // 등록하지 않은 종목 상세를 열었다 → 바로 한 번 읽어 그 가격이 온다
    a.emit("message", JSON.stringify({ type: "view", codes: ["nvda", "../x", 7, "NVDA"] }));
    await settle();
    expect(asked.at(-1)).toEqual(["000660", "NVDA"]);
    expect(a.ticks().map((t) => t.code)).toContain("NVDA");
    // 다른 종목으로 넘기면 목록이 통째로 바뀐다
    a.emit("message", JSON.stringify({ type: "view", codes: ["AAPL"] }));
    await settle();
    expect(asked.at(-1)).toEqual(["000660", "AAPL"]);
    // 8개까지만
    a.emit("message", JSON.stringify({ type: "view", codes: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"].map((x) => x.replace(/\d+/, (n) => "ABCDEFGHIJ"[Number(n) - 1]!)) }));
    await settle();
    expect(asked.at(-1)!.length).toBe(1 + 8);
    // 화면을 닫으면(빈 목록) 등록 종목만
    a.emit("message", JSON.stringify({ type: "view", codes: [] }));
    await stream.poll();
    expect(asked.at(-1)).toEqual(["000660"]);
    // 끊긴 앱의 목록은 남지 않는다
    const b = new Sock();
    stream.attach(b);
    b.emit("message", JSON.stringify({ type: "view", codes: ["NVDA"] }));
    await settle();
    expect(asked.at(-1)).toEqual(["000660", "NVDA"]);
    b.close();
    await stream.poll();
    expect(asked.at(-1)).toEqual(["000660"]);
    stream.stop();
  });

  it("같은 초 안에서 웹소켓이 놓친 체결도 앱에 간다 · 잠깐 본 종목 값은 다음 스냅샷에 남지 않는다", async () => {
    // 웹소켓 마지막 체결 19:59:59.200 (5초 전에 받음). 그 뒤 현재가 확인은 같은 초(초 단위 시각)·다른 가격 → 웹소켓이 놓친 마지막 체결
    const wsTick: LiveTick = { code: "000660", price: 208_000, volume: null, timestamp: "2026-11-11T19:59:59.200+09:00", receivedAt: Date.now() - 5_000 };
    const live = Object.assign(new EventEmitter(), {
      get: (c: string) => (c === "000660" ? wsTick : null),
      setCodes: () => {},
      status: () => ({ enabled: true, connected: true, subscribed: ["trade:kr:000660"], lastMessageAt: null, lastError: null }),
    });
    const quick = {
      name: "toss-openapi",
      tradeTime: true as const,
      getMany: async (codes: string[]) =>
        new Map(codes.map((c) => [c, { code: c, price: c === "000660" ? 207_900 : 180.5, volume: null, timestamp: "2026-11-11T19:59:59.000+09:00", receivedAt: Date.now() }] as [string, LiveTick])),
    };
    const stream = new PriceStream({ live, quickPrices: quick, codes: async () => ["000660"], wsServed: async () => new Set<string>(), pollMs: 60_000, pingMs: 60_000, batchMs: 0 });
    const a = new Sock();
    stream.attach(a);
    a.emit("message", JSON.stringify({ type: "hello", batch: true }));
    a.emit("message", JSON.stringify({ type: "view", codes: ["NVDA"] }));
    await settle();
    // 스냅샷에는 웹소켓 체결(208,000), 그 뒤 현재가 확인이 같은 초의 나중 체결(207,900)을 보낸다 — 시각은 웹소켓 체결 바로 뒤
    expect((a.sent[0]!["ticks"] as Array<{ price: number }>)[0]!.price).toBe(208_000);
    const fixed = a.ticks().find((x) => x.code === "000660") as { price: number; timestamp: string } | undefined;
    expect(fixed?.price).toBe(207_900);
    expect(Date.parse(fixed!.timestamp)).toBe(Date.parse(wsTick.timestamp) + 1);
    expect(a.ticks().map((x) => x.code)).toContain("NVDA");
    a.close();
    // 새로 붙은 앱의 스냅샷에는 등록 종목만 (잠깐 본 NVDA 는 남지 않는다)
    const b = new Sock();
    stream.attach(b);
    await settle();
    expect((b.sent[0]!["ticks"] as Array<{ code: string }>).map((x) => x.code)).toEqual(["000660"]);
    stream.stop();
  });
});

describe("웹소켓 체결과 공식 현재가의 순서 (services/tickOrder)", () => {
  const t = (price: number, timestamp: string, receivedAt: number): LiveTick => ({ code: "000660", price, volume: null, timestamp, receivedAt });

  it("현재가의 체결 시각이 더 뒤면 현재가, 아니면 웹소켓 체결", () => {
    const ws = t(100, "2026-11-11T19:59:58.200+09:00", 1_000);
    expect(polledOverWs(ws, t(101, "2026-11-11T19:59:59.000+09:00", 1_100))).toMatchObject({ price: 101, timestamp: "2026-11-11T19:59:59.000+09:00" });
    expect(polledOverWs(ws, t(99, "2026-11-11T19:59:57.000+09:00", 9_000))).toBeNull();
  });

  it("같은 초: 웹소켓 체결을 받은 뒤 1.5초 넘게 지나 받은 현재가가 다른 가격이면 놓친 체결 — 시각은 웹소켓 체결 바로 뒤로 적는다", () => {
    const ws = t(208_000, "2026-11-11T19:59:59.200+09:00", 10_000);
    // 바로 받은 값은 어느 쪽이 나중인지 모른다
    expect(polledOverWs(ws, t(207_900, "2026-11-11T19:59:59.000+09:00", 10_400))).toBeNull();
    // 1.5초 뒤에도 현재가가 다른 가격이면 그것이 마지막 체결
    const fixed = polledOverWs(ws, t(207_900, "2026-11-11T19:59:59.000+09:00", 11_600))!;
    expect(fixed.price).toBe(207_900);
    expect(Date.parse(fixed.timestamp)).toBe(Date.parse(ws.timestamp) + 1);
    // 가격이 같으면 바꿀 것이 없다
    expect(polledOverWs(ws, t(208_000, "2026-11-11T19:59:59.000+09:00", 11_600))).toBeNull();
    // 현재가 시각에 밀리초가 있으면(정밀한 시각) 시각대로만 견준다
    expect(polledOverWs(ws, t(207_900, "2026-11-11T19:59:59.100+09:00", 11_600))).toBeNull();
  });

  it("시각 견주기는 표기가 달라도(+09:00 · Z) 뒤집히지 않는다", () => {
    expect(laterThan("2026-11-11T11:00:01.000Z", "2026-11-11T19:59:59.000+09:00")).toBe(true); // 20:00:01 KST
    expect(laterThan("2026-11-11T19:59:59.000+09:00", "2026-11-11T11:00:01.000Z")).toBe(false);
    expect(laterThan("b", "a")).toBe(true); // 읽을 수 없으면 글자 순서
  });
});

describe("출처가 준 등락률(반올림 값)을 버림 값으로 (retruncRate)", () => {
  it("가격·전일 대비로 다시 계산해 버린다 — 반올림했을 때 출처 값과 같을 때만", () => {
    expect(retruncRate(208_000, 9_100, 4.58)).toBe(4.57); // 삼성전자: 네이버 4.58 → 토스 4.57
    expect(retruncRate(705.1, 37.49, 5.62)).toBe(5.61); // 코스닥 지수
    expect(retruncRate(274_500, 500, -0.18)).toBe(-0.18); // 전일 대비가 절댓값으로 와도 부호는 등락률을 따른다
    expect(retruncRate(51_863.69, -185.14, -0.36)).toBe(-0.35);
    expect(retruncRate(10_000, 0, 0)).toBe(0);
  });

  it("칸끼리 기준이 다르면(다시 계산해 반올림해도 출처 값이 아님) 출처 값 그대로 · 모르는 칸이 있으면 그대로", () => {
    expect(retruncRate(10_000, -100, -1)).toBe(-1); // -0.9901 → 반올림 -0.99 ≠ -1
    expect(retruncRate(10_000, 200, 3.5)).toBe(3.5);
    expect(retruncRate(null, 100, 1.23)).toBe(1.23);
    expect(retruncRate(10_000, null, 1.23)).toBe(1.23);
    expect(retruncRate(10_000, 100, null)).toBe(1.01); // 출처 등락률이 없으면 계산한 값(버림)
    expect(retruncRate(100, 150, null)).toBeNull(); // 전일 값이 0 이하
  });
});

describe("토스가 이 서버의 시세 한도를 낮게 잡았을 때", () => {
  it("초당 한도가 3 이하로 오면 현재가 확인을 약 3초 간격으로 늦춘다 (스냅샷·일봉 조회가 한도에 밀리지 않게)", async () => {
    const calls: Call[] = [];
    const base = fakeFetch({ calls });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await base(input, init);
      if (!String(input).includes("/api/v1/prices")) return res;
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "x-ratelimit-limit": "1" } });
    }) as typeof fetch;
    let now = NOW();
    const c = new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn, now: () => now, maxRetryWaitMs: 0 });
    const p = new TossOpenApiProvider(c, { now: () => now });
    const priceCalls = () => calls.filter((x) => x.url.includes("/api/v1/prices")).length;
    await p.getMany(["035420"]); // 첫 응답에서 한도 1 을 안다
    expect(priceCalls()).toBe(1);
    now = new Date(now.getTime() + 1_000);
    expect((await p.getMany(["035420"])).get("035420")?.price).toBe(201_500); // 받아 둔 값
    now = new Date(now.getTime() + 1_000);
    await p.getMany(["035420"]);
    expect(priceCalls()).toBe(1);
    now = new Date(now.getTime() + 1_000); // 3초 뒤
    await p.getMany(["035420"]);
    expect(priceCalls()).toBe(2);
  });
});

describe("토스 웹(비공식) 주소가 요청을 막았을 때", () => {
  it("연달아 3번 '요청 막힘'(HTTP 400 invalid-client-state)이면 10분 동안 두드리지 않고 바로 실패한다 — 끝나면 한 번 다시 물어 본다", async () => {
    let now = new Date("2026-11-12T00:20:00+09:00");
    const calls: string[] = [];
    const blocked = { on: true };
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (blocked.on) return new Response(JSON.stringify({ error: { statusCode: 400, code: "invalid-client-state", message: null } }), { status: 400 });
      return new Response(JSON.stringify({ result: [{ productCode: "A005930", close: 208000, base: 198900, currency: "KRW" }] }), { status: 200 });
    }) as FetchFn;
    const toss = new TossProvider(fetchFn, null, () => now);
    for (let i = 0; i < 3; i++) await expect(toss.getMany(["005930"])).rejects.toThrow(/invalid-client-state/);
    expect(toss.blockStatus()).toMatchObject({ blocked: true, streak: 3 });
    const n = calls.length;
    await expect(toss.getMany(["005930"])).rejects.toThrow(/쉬는 중/);
    await expect(toss.search("삼성", 5)).rejects.toThrow(/쉬는 중/);
    expect(calls).toHaveLength(n); // 요청이 나가지 않는다
    // 10분 뒤 한 번 다시 묻고, 또 막혀 있으면 바로 다시 쉰다
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    await expect(toss.getMany(["005930"])).rejects.toThrow(/invalid-client-state/);
    expect(calls).toHaveLength(n + 1);
    await expect(toss.getMany(["005930"])).rejects.toThrow(/쉬는 중/);
    // 다시 열리면 그대로 쓰고 기록을 지운다
    blocked.on = false;
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    expect((await toss.getMany(["005930"])).get("005930")?.price).toBe(208_000);
    expect(toss.blockStatus()).toEqual({ blocked: false, until: null, streak: 0 });
  });

  it("다른 오류(500·404)는 막힘으로 세지 않는다", async () => {
    const toss = new TossProvider((async () => new Response("x", { status: 500 })) as FetchFn, null, () => new Date("2026-11-12T00:20:00+09:00"));
    for (let i = 0; i < 5; i++) await expect(toss.getMany(["005930"])).rejects.toThrow(/HTTP 500/);
    expect(toss.blockStatus()).toEqual({ blocked: false, until: null, streak: 0 });
  });
});
