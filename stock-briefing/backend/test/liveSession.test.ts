import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Quote } from "../src/domain/types.js";
import { createMigratedDb } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import { fallbackState, stateFromSession, type MarketStatus } from "../src/providers/market/calendar.js";
import type { LiveTick, LiveTicks, QuickPriceSource, StockSessionFacts } from "../src/providers/market/tossRealtime.js";
import type { QuoteProvider } from "../src/providers/market/types.js";
import { anySessionOpen, keepTossCalendar, realtimeOf, sessionAt, type StockSession } from "../src/services/liveSession.js";
import { marketContext } from "../src/services/marketContext.js";
import { StockService } from "../src/services/stockService.js";
import { FakeMasterProvider, FakeSearchProvider, makeQuote } from "./helpers.js";

/**
 * 초록 점(실시간)의 뜻: "이 종목 가격이 지금 열린 거래 시간에 실시간으로 갱신되고 있다".
 * 세션(시장·시각·휴장) × 종목 자격(NXT·주간거래·거래정지) × 서버 수신 상태(웹소켓·토스 웹 3초 갱신·지연) 표.
 */

const at = (iso: string) => new Date(iso);

/** 토스 달력 (삼성전자·애플의 tradingEnd / nextTradingStart 로 만든 값) */
function calendar(now: Date, kr: [string, string] | null, us: [string, string] | null): MarketStatus {
  return {
    now: now.toISOString(),
    KR: kr ? stateFromSession("KR", now, kr[0], kr[1]) : { market: "KR", isTradingDay: true, isOpen: false, opensAt: null, closesAt: null, source: "fallback" },
    US: us ? stateFromSession("US", now, us[0], us[1]) : { market: "US", isTradingDay: true, isOpen: false, opensAt: null, closesAt: null, source: "fallback" },
  };
}

const NXT: StockSessionFacts = { daytime: false, nxt: true, halted: false, nxtHalted: false, etp: false, exchange: "integrated", pricedAt: null };
const KRX_ONLY: StockSessionFacts = { daytime: false, nxt: false, halted: false, nxtHalted: false, etp: false, exchange: "krx", pricedAt: null };
/** 한국 ETF (NXT·한국거래소 애프터마켓 모두 대상 아님) */
const KR_ETF: StockSessionFacts = { ...KRX_ONLY, etp: true };
const US_DAY: StockSessionFacts = { daytime: true, nxt: false, halted: false, nxtHalted: false, etp: false, exchange: null, pricedAt: null };
const US_NO_DAY: StockSessionFacts = { ...US_DAY, daytime: false };

describe("한국 세션 (서울 시각, 거래일은 토스 달력)", () => {
  // 2026-09-22(화) 평일. 달력: 9/21 20:00 마감 → 9/22 08:00 시작 / 장중이면 9/22 20:00 마감 → 9/23 08:00
  const krCal = (iso: string) => {
    const now = at(iso);
    const t = now.getTime();
    const open = t >= Date.parse("2026-09-22T08:00:00+09:00") && t < Date.parse("2026-09-22T20:00:00+09:00");
    const before = t < Date.parse("2026-09-22T08:00:00+09:00");
    const kr: [string, string] = open
      ? ["2026-09-22T11:00:00Z", "2026-09-22T23:00:00Z"]
      : before
        ? ["2026-09-21T11:00:00Z", "2026-09-21T23:00:00Z"]
        : ["2026-09-22T11:00:00Z", "2026-09-22T23:00:00Z"];
    return calendar(now, kr, null);
  };
  const kr = (iso: string, stock: StockSessionFacts | null = NXT) => sessionAt("035420", at(iso), { calendar: krCal(iso), stock });

  it.each([
    ["2026-09-22T07:59:00+09:00", "closed", "한국 장 마감", false, "2026-09-22T08:00:00+09:00"],
    ["2026-09-22T08:00:00+09:00", "nxt_pre", "한국 NXT 프리마켓", true, "2026-09-22T08:50:00+09:00"],
    ["2026-09-22T08:49:59+09:00", "nxt_pre", "한국 NXT 프리마켓", true, "2026-09-22T08:50:00+09:00"],
    ["2026-09-22T08:50:00+09:00", "auction", "한국 동시호가", false, "2026-09-22T09:00:00+09:00"],
    ["2026-09-22T09:00:00+09:00", "regular", "한국 정규장", true, "2026-09-22T15:20:00+09:00"],
    ["2026-09-22T15:19:00+09:00", "regular", "한국 정규장", true, "2026-09-22T15:20:00+09:00"],
    ["2026-09-22T15:20:00+09:00", "auction", "한국 동시호가", false, "2026-09-22T15:30:00+09:00"],
    ["2026-09-22T15:30:00+09:00", "closed", "한국 장 마감", false, "2026-09-22T15:40:00+09:00"],
    ["2026-09-22T15:40:00+09:00", "nxt_after", "한국 NXT 애프터마켓", true, "2026-09-22T16:00:00+09:00"],
    ["2026-09-22T15:59:00+09:00", "nxt_after", "한국 NXT 애프터마켓", true, "2026-09-22T16:00:00+09:00"],
    // 한국거래소 애프터마켓(2026-09-14~, 연속 매매)이 16:00 에 열린다 — 한국거래소·NXT 둘 다
    ["2026-09-22T16:00:00+09:00", "after", "한국 애프터마켓", true, "2026-09-22T20:00:00+09:00"],
    ["2026-09-22T19:59:00+09:00", "after", "한국 애프터마켓", true, "2026-09-22T20:00:00+09:00"],
    ["2026-09-22T20:00:00+09:00", "closed", "한국 장 마감", false, "2026-09-23T08:00:00+09:00"],
  ])("%s → %s (%s)", (iso, phase, label, open, until) => {
    const s = kr(iso);
    expect(s).toMatchObject({ market: "KR", phase, label, open });
    expect(Date.parse(s.until!)).toBe(Date.parse(until));
  });

  it("정규장(09:00~15:20)에는 모든 한국 종목이 거래 대상, NXT 시간(08:00~08:50·15:40~16:00)에는 NXT 종목만", () => {
    expect(kr("2026-09-22T10:30:00+09:00", KRX_ONLY)).toMatchObject({ phase: "regular", open: true, eligible: true });
    expect(kr("2026-09-22T08:30:00+09:00", NXT)).toMatchObject({ phase: "nxt_pre", eligible: true });
    expect(kr("2026-09-22T08:30:00+09:00", KRX_ONLY)).toMatchObject({ phase: "nxt_pre", open: true, eligible: false });
    expect(kr("2026-09-22T15:45:00+09:00", NXT)).toMatchObject({ phase: "nxt_after", eligible: true });
    expect(kr("2026-09-22T15:45:00+09:00", KRX_ONLY)).toMatchObject({ phase: "nxt_after", open: true, eligible: false }); // 한국거래소는 시간외 종가(가격 그대로)
  });

  it("16:00~20:00 애프터마켓: NXT 종목은 대상, ETF·ETN 은 아님, 그 밖(한국거래소 애프터마켓 대상 목록이 없음)은 모름 → 체결 증거로", () => {
    expect(kr("2026-09-22T16:30:00+09:00", NXT)).toMatchObject({ phase: "after", open: true, eligible: true });
    expect(kr("2026-09-22T16:30:00+09:00", KRX_ONLY)).toMatchObject({ phase: "after", open: true, eligible: null }); // 예전처럼 false 로 못 박지 않는다
    expect(kr("2026-09-22T16:30:00+09:00", KR_ETF)).toMatchObject({ phase: "after", open: true, eligible: false });
    expect(kr("2026-09-22T16:30:00+09:00", null)).toMatchObject({ phase: "after", eligible: null });
    // 세션 시작은 16:00 — 15:40~16:00 의 시간외 종가 체결은 이 세션 체결 증거가 아니다
    expect(Date.parse(kr("2026-09-22T16:30:00+09:00", KRX_ONLY).start!)).toBe(Date.parse("2026-09-22T16:00:00+09:00"));
  });

  it("NXT 지원 여부를 모르면 토스 시세의 거래소 구분(integrated / krx)으로, 그것도 없으면 모름(null)", () => {
    const unknown = { ...NXT, nxt: null };
    expect(kr("2026-09-22T15:45:00+09:00", { ...unknown, exchange: "integrated" }).eligible).toBe(true);
    expect(kr("2026-09-22T15:45:00+09:00", { ...unknown, exchange: "krx" }).eligible).toBe(false);
    expect(kr("2026-09-22T15:45:00+09:00", { ...unknown, exchange: null }).eligible).toBeNull();
    expect(kr("2026-09-22T15:45:00+09:00", null).eligible).toBeNull();
    expect(kr("2026-09-22T16:30:00+09:00", { ...unknown, exchange: "integrated" }).eligible).toBe(true);
  });

  it("거래정지 종목은 정규장·NXT·애프터마켓 모두 거래 대상이 아니다 (NXT 만 정지면 NXT 시간만)", () => {
    expect(kr("2026-09-22T10:30:00+09:00", { ...NXT, halted: true })).toMatchObject({ open: true, eligible: false, halted: true });
    expect(kr("2026-09-22T10:30:00+09:00", { ...NXT, nxtHalted: true })).toMatchObject({ eligible: true });
    expect(kr("2026-09-22T15:45:00+09:00", { ...NXT, nxtHalted: true })).toMatchObject({ eligible: false, halted: true });
    expect(kr("2026-09-22T16:30:00+09:00", { ...KRX_ONLY, halted: true })).toMatchObject({ eligible: false, halted: true });
  });

  it("휴장일(추석 9/24~9/25)과 주말은 '한국 휴장', 다음 경계는 달력의 다음 개장", () => {
    const now = at("2026-09-25T09:59:00+09:00");
    const cal = calendar(now, ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], null);
    const s = sessionAt("035420", now, { calendar: cal, stock: NXT });
    expect(s).toMatchObject({ phase: "holiday", label: "한국 휴장", open: false });
    expect(Date.parse(s.until!)).toBe(Date.parse("2026-09-28T08:00:00+09:00"));
    // 달력을 못 받으면 요일로 (토요일 휴장, 평일은 거래일로 짐작한다) — 짐작한 날은 평일 휴장일일 수 있어 "대상"을 모름으로 낮춘다(체결 증거가 있는 종목만)
    expect(sessionAt("035420", at("2026-09-26T10:00:00+09:00")).phase).toBe("holiday");
    const tue = at("2026-10-06T10:00:00+09:00");
    expect(sessionAt("035420", tue, { stock: NXT })).toMatchObject({ phase: "regular", open: true, eligible: null });
    expect(sessionAt("035420", tue, { calendar: { now: tue.toISOString(), KR: fallbackState("KR", tue), US: fallbackState("US", tue) }, stock: NXT }).eligible).toBeNull();
    // 짐작해도 대상이 아닌 것은 그대로 아님
    expect(sessionAt("900340", at("2026-10-06T08:30:00+09:00"), { stock: KRX_ONLY }).eligible).toBe(false);
  });

  it("며칠 전에 받은 토스 달력도 날짜로 읽어 휴장일을 안다 (isTradingDay 는 받은 날 기준이라 쓰지 않는다)", () => {
    // 9/23(수) 21:00 에 받은 달력: 마지막 세션 9/23 20:00, 다음 세션 9/28 08:00 → 9/24~9/27 은 휴장
    const cal = calendar(at("2026-09-23T21:00:00+09:00"), ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], null);
    expect(cal.KR.isTradingDay).toBe(true); // 받은 날(9/23) 기준 값 — 9/25 에 그대로 쓰면 틀린다
    expect(sessionAt("035420", at("2026-09-25T10:00:00+09:00"), { calendar: cal, stock: NXT })).toMatchObject({ phase: "holiday", open: false });
    expect(sessionAt("035420", at("2026-09-28T09:30:00+09:00"), { calendar: cal, stock: NXT })).toMatchObject({ phase: "regular", eligible: true }); // 다음 세션 날
    // 9/22 장중에 받은 달력은 9/25 를 모른다 → 평일로 짐작하되 대상은 모름
    const old = calendar(at("2026-09-22T10:00:00+09:00"), ["2026-09-22T11:00:00Z", "2026-09-22T23:00:00Z"], null);
    expect(sessionAt("035420", at("2026-09-25T10:00:00+09:00"), { calendar: old, stock: NXT })).toMatchObject({ phase: "regular", eligible: null });
  });

  it("달력 조회가 실패하면(fallback) 시장별로 마지막 토스 달력을 그대로 쓴다", () => {
    const now = at("2026-09-25T10:00:00+09:00");
    const last = calendar(at("2026-09-25T09:55:00+09:00"), ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], ["2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z"]);
    const failed: MarketStatus = { now: now.toISOString(), KR: fallbackState("KR", now), US: fallbackState("US", now) };
    expect(failed.KR.isOpen).toBe(true); // 요일 추정은 추석을 장중으로 본다
    const kept = keepTossCalendar(last, failed);
    expect(kept.KR).toBe(last.KR);
    expect(kept.US).toBe(last.US);
    expect(kept.now).toBe(failed.now);
    expect(sessionAt("035420", now, { calendar: kept, stock: NXT }).phase).toBe("holiday");
    // 새로 받은 토스 달력은 그대로, 실패한 시장만 마지막 값, 처음부터 없으면 fallback 그대로
    const krOnly: MarketStatus = { ...failed, KR: stateFromSession("KR", now, "2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z") };
    expect(keepTossCalendar(last, krOnly).KR).toBe(krOnly.KR);
    expect(keepTossCalendar(last, krOnly).US).toBe(last.US);
    expect(keepTossCalendar(null, failed)).toBe(failed);
  });
});

describe("미국 세션 (뉴욕 시각·서머타임, 휴장일)", () => {
  const us = (iso: string, stock: StockSessionFacts | null = US_DAY, cal: MarketStatus | null = null) => sessionAt("AAPL", at(iso), { calendar: cal, stock });

  it.each([
    // 서머타임(EDT, -4): 2026-09-24(목)
    ["2026-09-24T03:59:00-04:00", "overnight", "미국 주간거래", "2026-09-24T04:00:00-04:00"],
    ["2026-09-24T04:00:00-04:00", "pre", "미국 프리마켓", "2026-09-24T09:30:00-04:00"],
    ["2026-09-24T09:30:00-04:00", "regular", "미국 정규장", "2026-09-24T16:00:00-04:00"],
    ["2026-09-24T16:00:00-04:00", "after", "미국 애프터마켓", "2026-09-24T20:00:00-04:00"],
    ["2026-09-24T20:00:00-04:00", "overnight", "미국 주간거래", "2026-09-25T04:00:00-04:00"],
    // 표준시(EST, -5): 2026-01-15(목)
    ["2026-01-15T03:59:00-05:00", "overnight", "미국 주간거래", "2026-01-15T04:00:00-05:00"],
    ["2026-01-15T04:00:00-05:00", "pre", "미국 프리마켓", "2026-01-15T09:30:00-05:00"],
    ["2026-01-15T09:30:00-05:00", "regular", "미국 정규장", "2026-01-15T16:00:00-05:00"],
    ["2026-01-15T16:00:00-05:00", "after", "미국 애프터마켓", "2026-01-15T20:00:00-05:00"],
    ["2026-01-15T20:00:00-05:00", "overnight", "미국 주간거래", "2026-01-16T04:00:00-05:00"],
    // 서머타임이 시작되는 일요일 밤(3/8 20:00 EDT)부터 월요일 세션의 주간거래
    ["2026-03-08T20:30:00-04:00", "overnight", "미국 주간거래", "2026-03-09T04:00:00-04:00"],
  ])("%s → %s", (iso, phase, label, until) => {
    const s = us(iso);
    expect(s).toMatchObject({ market: "US", phase, label, open: true, eligible: true });
    expect(Date.parse(s.until!)).toBe(Date.parse(until));
  });

  it("주간거래 자격은 종목마다 (토스 daytimePriceSupported). 프리·정규·애프터는 모든 종목", () => {
    expect(us("2026-09-24T21:00:00-04:00", US_NO_DAY)).toMatchObject({ phase: "overnight", open: true, eligible: false });
    expect(us("2026-09-24T21:00:00-04:00", null)).toMatchObject({ phase: "overnight", open: true, eligible: null });
    expect(us("2026-09-24T05:00:00-04:00", US_NO_DAY)).toMatchObject({ phase: "pre", eligible: true });
    expect(us("2026-09-24T17:00:00-04:00", US_NO_DAY)).toMatchObject({ phase: "after", eligible: true });
    expect(us("2026-09-24T11:00:00-04:00", { ...US_DAY, halted: true })).toMatchObject({ phase: "regular", eligible: false, halted: true });
  });

  it("주말·휴장일: 금요일 20:00 뒤는 장 마감(토요일 주간거래 없음), 추수감사절은 휴장이고 그 전날 밤 주간거래도 없다", () => {
    expect(us("2026-09-25T20:30:00-04:00")).toMatchObject({ phase: "closed", label: "미국 장 마감", open: false });
    expect(us("2026-09-26T12:00:00-04:00")).toMatchObject({ phase: "holiday", label: "미국 휴장", open: false });
    // 일요일 19:59 는 휴장, 20:00 부터 월요일 세션의 주간거래
    const sun = us("2026-09-27T19:59:00-04:00");
    expect(sun).toMatchObject({ phase: "holiday", open: false });
    expect(Date.parse(sun.until!)).toBe(Date.parse("2026-09-27T20:00:00-04:00"));
    expect(us("2026-11-25T21:00:00-05:00")).toMatchObject({ phase: "closed", open: false }); // 추수감사절 전날 밤
    expect(us("2026-11-26T12:00:00-05:00")).toMatchObject({ phase: "holiday", label: "미국 휴장" });
    expect(us("2026-11-26T21:00:00-05:00")).toMatchObject({ phase: "overnight", open: true }); // 금요일 세션
  });

  it("조기 폐장(11/27 13:00)은 토스 달력의 마감 시각으로: 애프터마켓은 17:00 까지", () => {
    // 애플 시세의 tradingEnd(11/27 13:00 EST) / nextTradingStart(11/30 09:30 EST). 장중·마감은 now 로 갈린다
    const cal = (iso: string) => calendar(at(iso), null, ["2026-11-27T18:00:00Z", "2026-11-30T14:30:00Z"]);
    const reg = us("2026-11-27T12:00:00-05:00", US_DAY, cal("2026-11-27T12:00:00-05:00"));
    expect(reg).toMatchObject({ phase: "regular" });
    expect(Date.parse(reg.until!)).toBe(Date.parse("2026-11-27T13:00:00-05:00"));
    const after = us("2026-11-27T14:00:00-05:00", US_DAY, cal("2026-11-27T14:00:00-05:00"));
    expect(after).toMatchObject({ phase: "after" });
    expect(Date.parse(after.until!)).toBe(Date.parse("2026-11-27T17:00:00-05:00"));
    const closed = us("2026-11-27T17:30:00-05:00", US_DAY, cal("2026-11-27T17:30:00-05:00"));
    expect(closed).toMatchObject({ phase: "closed", open: false });
    // 다음 경계는 일요일 20:00 (월요일 세션의 주간거래 시작)
    expect(Date.parse(closed.until!)).toBe(Date.parse("2026-11-29T20:00:00-05:00"));
  });

  it("토스 달력이 알려 준 목록 밖 휴장일(다음 정규장이 하루 건너뜀)도 지킨다", () => {
    // 가상의 임시 휴장: 목 9/24 정규장 뒤 다음 정규장이 월 9/28 → 금 9/25 는 휴장, 목요일 밤 주간거래 없음
    const now = at("2026-09-24T21:00:00-04:00");
    const cal = calendar(now, null, ["2026-09-24T20:00:00Z", "2026-09-28T13:30:00Z"]);
    expect(sessionAt("AAPL", now, { calendar: cal, stock: US_DAY })).toMatchObject({ phase: "closed", open: false });
  });
});

describe("실시간 판단 realtimeOf", () => {
  const NOW = Date.parse("2026-09-24T21:00:00-04:00");
  const session: StockSession = sessionAt("VRT", new Date(NOW), { stock: US_DAY });
  const base = { session, now: NOW, feed: { ws: true, polledAt: null }, stale: false, snapshotCurrent: true, held: false, tradedAt: null } as const;

  it("세션 열림 + 거래 대상 + 웹소켓 구독 중 → 실시간 (체결이 아직 없어도)", () => expect(realtimeOf(base)).toBe(true));
  it("웹소켓이 없어도 토스 웹 가격을 15초 안에 받았으면 실시간 (3초 갱신)", () => {
    expect(realtimeOf({ ...base, feed: { ws: false, polledAt: NOW - 5_000 } })).toBe(true);
    expect(realtimeOf({ ...base, feed: { ws: false, polledAt: NOW - 20_000 } })).toBe(false); // 갱신이 멈춤
    expect(realtimeOf({ ...base, feed: { ws: false, polledAt: null } })).toBe(false); // 연결 끊김
  });
  it("시세 지연(stale)·지난 세션 스냅샷·거래일이 바뀐 체결 보류 중이면 아님", () => {
    expect(realtimeOf({ ...base, stale: true })).toBe(false);
    expect(realtimeOf({ ...base, snapshotCurrent: false })).toBe(false);
    expect(realtimeOf({ ...base, held: true })).toBe(false);
  });
  it("거래 대상이 아니면(주간거래 미지원) 수신 상태와 무관하게 아님", () => {
    const s = sessionAt("VRT", new Date(NOW), { stock: US_NO_DAY });
    expect(realtimeOf({ ...base, session: s, tradedAt: NOW - 1_000 })).toBe(false);
  });
  it("자격을 모르면 이 세션에 체결이 있었던 증거가 있을 때만", () => {
    const s = sessionAt("VRT", new Date(NOW), { stock: null });
    expect(s.eligible).toBeNull();
    expect(realtimeOf({ ...base, session: s, tradedAt: NOW - 60_000 })).toBe(true); // 20:59 체결 (세션 시작 20:00 뒤)
    expect(realtimeOf({ ...base, session: s, tradedAt: Date.parse("2026-09-24T19:58:00-04:00") })).toBe(false); // 애프터마켓 체결
    expect(realtimeOf({ ...base, session: s, tradedAt: null })).toBe(false);
  });
  it("세션이 닫혀 있으면 아님", () => {
    const s = sessionAt("VRT", new Date(Date.parse("2026-09-26T12:00:00-04:00")), { stock: US_DAY });
    expect(realtimeOf({ ...base, session: s, now: Date.parse("2026-09-26T12:00:00-04:00") })).toBe(false);
  });
});

describe("서버 폴링 주기: 등록 종목 시장의 세션이 열려 있는지 (토스 달력은 미국 정규장만)", () => {
  it("미국 주간거래·프리·애프터에도 열림, 한국 휴장이면 한국 종목만으로는 닫힘", () => {
    const now = at("2026-09-25T09:59:00+09:00");
    const cal = calendar(now, ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], ["2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z"]);
    expect(cal.US.isOpen).toBe(false); // 토스 달력은 정규장만 — 예전 규칙이면 30초로 늦췄다
    expect(anySessionOpen(["035420", "VRT"], cal, now)).toBe(true);
    expect(anySessionOpen(["035420"], cal, now)).toBe(false);
    expect(anySessionOpen([], cal, now)).toBe(false);
    expect(anySessionOpen(["AAPL"], null, at("2026-09-24T17:00:00-04:00"))).toBe(true); // 애프터마켓
  });
});

describe("장 상태 문장(브리핑)의 미국 주간거래도 뉴욕 시각으로 — 서머타임 (한국 09:00~17:00)", () => {
  it("한국 09:30(뉴욕 20:30 EDT)은 주간거래, 겨울 한국 17:45(뉴욕 03:45 EST)도 주간거래", () => {
    expect(marketContext("AAPL", null, at("2026-09-25T09:30:00+09:00")).label).toContain("주간거래");
    expect(marketContext("AAPL", null, at("2026-01-16T17:45:00+09:00")).label).toContain("주간거래");
    expect(marketContext("AAPL", null, at("2026-09-25T17:10:00+09:00")).label).not.toContain("주간거래"); // 뉴욕 04:10 → 프리마켓
  });
});

// ── 보고된 장면: 2026-09-25 09:59 KST = 뉴욕 9/24(목) 20:59 (미국 주간거래), 한국은 추석 휴장 ────────────────

const US_HOLDINGS = ["VRT", "QNT", "APH", "GD", "WYHG", "ETN", "QQQI", "RGTX", "RTX"];
const NAVER = "035420";

class ScenarioLive extends EventEmitter implements LiveTicks {
  ticks = new Map<string, LiveTick>();
  connected = true;
  aliveAt: string;
  constructor(private readonly now: () => number) {
    super();
    this.aliveAt = new Date(now()).toISOString();
  }
  get(code: string) {
    return this.ticks.get(code) ?? null;
  }
  setCodes() {}
  status() {
    return {
      enabled: true,
      connected: this.connected,
      subscribed: [...US_HOLDINGS.map((c) => `trade:us:${c}`), `trade:kr:${NAVER}`],
      lastMessageAt: this.aliveAt,
      lastAliveAt: this.aliveAt,
      lastError: null,
    };
  }
}

class ScenarioQuick implements QuickPriceSource {
  readonly name = "toss";
  facts = new Map<string, StockSessionFacts>();
  /** 토스 웹 일괄 가격 (코드 → 가격). 받은 시각은 now — 운영의 TossProvider.getMany 처럼 timestamp 도 체결 시각이 아니라 받은 시각 */
  prices = new Map<string, number>();
  /** true 면 토스 웹 장애 (getMany 실패) */
  fail = false;
  constructor(private readonly now: () => number = () => Date.now()) {}
  async getMany(codes: string[]): Promise<Map<string, LiveTick>> {
    if (this.fail) throw new Error("토스 웹 장애");
    const at = this.now();
    return new Map(codes.flatMap((c) => (this.prices.has(c) ? [[c, { code: c, price: this.prices.get(c)!, volume: null, timestamp: new Date(at).toISOString(), receivedAt: at }] as const] : [])));
  }
  sessionFacts(codes: string[]) {
    return new Map(codes.flatMap((c) => (this.facts.has(c) ? [[c, this.facts.get(c)!] as const] : [])));
  }
}

/**
 * quickAll(기본 true): 운영처럼 토스 웹이 모든 종목 가격을 준다 (체결이 없던 종목은 스냅샷과 같은 가격). quick 으로 종목별 가격을 바꾼다.
 * quickFails: 토스 웹 장애. wsEmpty: 웹소켓 체결 목록이 비었다 (서버를 막 다시 켬)
 */
async function scenario(o: { live?: boolean; facts?: boolean; sessionTicks?: boolean; quick?: Record<string, number>; quickAll?: boolean; quickFails?: boolean; wsEmpty?: boolean; gdAfterHoursTick?: boolean } = {}) {
  const t = { now: Date.parse("2026-09-25T09:59:00+09:00") };
  const db = await createMigratedDb(":memory:");
  await db
    .insertInto("registered_stocks")
    .values([...US_HOLDINGS, NAVER].map((code, i) => ({ code, name: code, market: code === NAVER ? "KOSPI" : "NYSE", quantity: 1, avg_price: 100, memo: null, created_at: `2026-09-01T00:00:${String(i).padStart(2, "0")}+09:00`, updated_at: "2026-09-01T00:00:00+09:00" })))
    .execute();
  // 공식 API 시세: asOf = 마지막 체결 시각. 거래가 뜸한 종목은 주간거래 시작(20:00) 전 체결이 마지막일 수 있다
  const lastTrade: Record<string, string> = { VRT: "2026-09-25T09:58:50+09:00", QNT: "2026-09-25T09:58:40+09:00", APH: "2026-09-25T08:59:00+09:00", GD: "2026-09-25T09:31:00+09:00" };
  const quotes: QuoteProvider = {
    name: "toss-openapi",
    getQuote: async () => {
      throw new ProviderError("toss-openapi", "unused");
    },
    getQuotes: async (codes: string[]) =>
      new Map(
        codes.map((c): [string, Quote] => [
          c,
          c === NAVER
            ? { ...makeQuote(c, "toss-openapi", 250_000), asOf: "2026-09-23T19:59:58+09:00" }
            : { ...makeQuote(c, "toss-openapi", 100), currency: "USD", fxRate: 1390, asOf: lastTrade[c] ?? "2026-09-25T05:00:00+09:00" },
        ]),
      ),
    getCandles: async () => {
      throw new ProviderError("toss-openapi", "unused");
    },
  };
  const live = new ScenarioLive(() => t.now);
  live.connected = o.live ?? true;
  // 웹소켓 체결은 거래가 많은 두 종목만 가격이 스냅샷과 달랐다 (예전 점은 이 둘에만)
  if ((o.sessionTicks ?? true) && !o.wsEmpty) {
    live.ticks.set("VRT", { code: "VRT", price: 101.5, volume: 3, timestamp: "2026-09-25T09:58:59+09:00", receivedAt: t.now - 1_000 });
    live.ticks.set("QNT", { code: "QNT", price: 99.2, volume: 5, timestamp: "2026-09-25T09:58:58+09:00", receivedAt: t.now - 2_000 });
  }
  if (!o.wsEmpty) live.ticks.set("APH", { code: "APH", price: 100, volume: 1, timestamp: "2026-09-25T08:59:00+09:00", receivedAt: t.now - 3_600_000 }); // 같은 가격
  // GD: 웹소켓 마지막 체결은 애프터마켓(스냅샷 09:31 보다 오래됨)
  if (o.gdAfterHoursTick) live.ticks.set("GD", { code: "GD", price: 98, volume: 1, timestamp: "2026-09-25T08:50:00+09:00", receivedAt: t.now - 4_000_000 });
  const quick = new ScenarioQuick(() => t.now);
  quick.fail = o.quickFails ?? false;
  if (o.quickAll ?? true) for (const c of US_HOLDINGS) quick.prices.set(c, 100);
  if (o.quickAll ?? true) quick.prices.set(NAVER, 250_000);
  for (const [c, p] of Object.entries(o.quick ?? {})) quick.prices.set(c, p);
  if (o.facts ?? true) {
    for (const c of US_HOLDINGS) quick.facts.set(c, { daytime: true, nxt: false, halted: false, nxtHalted: false, etp: false, exchange: null, pricedAt: null });
    quick.facts.set(NAVER, { daytime: false, nxt: true, halted: false, nxtHalted: false, etp: false, exchange: "integrated", pricedAt: null });
  }
  const now = at("2026-09-25T09:59:00+09:00");
  const cal = { status: async () => calendar(now, ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], ["2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z"]) };
  let snapshots = 0;
  const counted: QuoteProvider = { ...quotes, getQuotes: async (codes: string[]) => (snapshots++, quotes.getQuotes!(codes)) };
  const service = new StockService({ db, quotes: counted, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, quickPrices: quick, calendar: cal, now: () => new Date(t.now) });
  return { service, live, quick, t, snapshots: () => snapshots, lastTrade };
}

describe("보고된 장면: 09:59 KST 잔고 (미국 주간거래 중, 한국 추석 휴장)", () => {
  it("미국 9종목 모두 실시간(주간거래 지원·웹소켓 구독 중 — 체결이 없던 종목도), NAVER 는 휴장이라 아님", async () => {
    // 운영처럼 토스 웹이 모든 종목 가격을 준다(받은 시각이 찍힘). WYHG·ETN·QQQI·RGTX·RTX 는 마지막 체결이 뉴욕 9/24 16:00(지난 거래일)이다
    const { service, quick } = await scenario();
    expect([...quick.prices.keys()].sort()).toEqual([...US_HOLDINGS, NAVER].sort());
    const list = await service.listWithQuotes();
    const by = new Map(list.map((s) => [s.code, s.quote!]));
    expect(by.get("WYHG")).toMatchObject({ asOf: "2026-09-25T05:00:00+09:00", price: 100 }); // 이번 거래일(뉴욕 20:00~) 체결 없음
    for (const c of US_HOLDINGS) {
      expect(by.get(c)!.realtime, c).toBe(true);
      expect(by.get(c)!.session).toMatchObject({ market: "US", phase: "overnight", label: "미국 주간거래", open: true, eligible: true });
    }
    expect(by.get(NAVER)!.realtime).toBe(false);
    expect(by.get(NAVER)!.session).toMatchObject({ market: "KR", phase: "holiday", label: "한국 휴장", open: false });
    expect(list.filter((s) => s.quote?.realtime).map((s) => s.code)).toEqual(US_HOLDINGS);
    // 예전 앱이 읽는 live(스냅샷과 다른 체결이 붙었는지)는 그대로 — 예전 앱은 전과 똑같이 보인다
    expect(list.filter((s) => s.quote?.live).map((s) => s.code)).toEqual(["VRT", "QNT"]);
  });

  it("상세(getQuote)도 같은 세션·실시간 값을 준다 (잔고 종목 전체의 웹소켓 체결로 판단 — 목록과 같게)", async () => {
    const { service } = await scenario();
    await service.listWithQuotes();
    expect(await service.getQuote("APH")).toMatchObject({ realtime: true, session: { phase: "overnight" } });
    expect(await service.getQuote(NAVER)).toMatchObject({ realtime: false, session: { phase: "holiday" } });
  });

  it("웹소켓이 붙어 구독 중이어도 이번 세션(20:00 뒤) 미국 체결이 하나도 안 왔으면 웹소켓만으로는 켜지 않는다 — 토스 웹 가격을 15초 안에 받아 그 가격을 쓰면 켠다", async () => {
    // 토스 웹소켓이 주간거래 체결을 주는지는 확인하지 못했다 → 이 세션 체결을 실제로 받은 뒤에만 웹소켓을 믿는다
    const quiet = await scenario({ sessionTicks: false, quickAll: false });
    expect((await quiet.service.listWithQuotes()).some((s) => s.quote?.realtime)).toBe(false);
    const polled = await scenario({ sessionTicks: false });
    expect((await polled.service.listWithQuotes()).filter((s) => s.quote?.realtime).map((s) => s.code)).toEqual(US_HOLDINGS);
    // 3초 갱신이 멈춤: 20초 전에 받은 토스 웹 가격뿐
    polled.quick.fail = true;
    polled.t.now += 20_000;
    expect((await polled.service.listWithQuotes()).some((s) => s.quote?.realtime)).toBe(false);
  });

  it("서버를 막 다시 켜 웹소켓 체결 목록이 비었어도 토스 웹 가격을 받는 중이면 거래 대상 9종목 모두 켠다", async () => {
    const { service } = await scenario({ wsEmpty: true });
    expect((await service.listWithQuotes()).filter((s) => s.quote?.realtime).map((s) => s.code)).toEqual(US_HOLDINGS);
  });

  it("조용한 종목의 이번 거래일 첫 체결이 토스 웹에 먼저 보이면: 가격은 스냅샷을 다시 받을 때까지 붙이지 않고 점은 그대로, 10초 뒤 한 번만 다시 받는다", async () => {
    const s = await scenario({ quick: { WYHG: 101 } });
    const first = (await s.service.listWithQuotes()).find((x) => x.code === "WYHG")!.quote!;
    // 스냅샷(지난 거래일 마지막 체결 100)의 전일 종가에 새 거래일 가격을 대면 등락이 이틀치가 된다 → 붙이지 않는다
    expect(first).toMatchObject({ price: 100, realtime: true });
    expect(s.snapshots()).toBe(1);
    s.t.now += 5_000; // 10초 전: 아직 다시 받지 않는다
    await s.service.listWithQuotes();
    expect(s.snapshots()).toBe(1);
    // 공식 API 도 그 체결을 알게 됨 (뉴욕 20:59:05 체결)
    s.lastTrade["WYHG"] = "2026-09-25T09:59:05+09:00";
    s.t.now += 6_000;
    await s.service.listWithQuotes(); // ttl(1분) 전이지만 다시 받기 시작 (잠깐 기다린다)
    expect(s.snapshots()).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    const wyhg = (await s.service.listWithQuotes()).find((x) => x.code === "WYHG")!.quote!;
    expect(wyhg).toMatchObject({ price: 101, realtime: true }); // 같은 거래일 스냅샷이 되어 토스 웹 가격이 붙는다
  });

  it("다시 받아도 공식 API 가 그 가격을 모르면(두 출처의 기준 차이) 같은 가격으로는 더 조르지 않는다 — 1분마다 받는 것은 그대로", async () => {
    const s = await scenario({ quick: { ETN: 99.5 } });
    await s.service.listWithQuotes();
    s.t.now += 11_000;
    await s.service.listWithQuotes();
    expect(s.snapshots()).toBe(2); // 한 번 다시 받음
    for (let i = 0; i < 4; i++) {
      s.t.now += 11_000;
      const etn = (await s.service.listWithQuotes()).find((x) => x.code === "ETN")!.quote!;
      expect(etn).toMatchObject({ price: 100, realtime: true });
    }
    expect(s.snapshots()).toBe(2); // 10초마다 조르지 않는다
    s.t.now += 20_000; // 마지막으로 받은 지 1분 지남 → ttl
    await s.service.listWithQuotes();
    expect(s.snapshots()).toBe(3);
  });

  it("웹소켓 마지막 체결이 스냅샷보다 오래됐으면 토스 웹 가격을 붙인다 — 점이 켜진 종목의 가격이 실제로 3초마다 바뀌게", async () => {
    const { service } = await scenario({ gdAfterHoursTick: true, quick: { GD: 102.25 } });
    const gd = (await service.listWithQuotes()).find((s) => s.code === "GD")!.quote!;
    expect(gd.price).toBe(102.25); // 예전에는 오래된 웹소켓 체결이 있으면 토스 웹 가격을 보지 않아 스냅샷(100)에 멈췄다
    expect(gd.realtime).toBe(true);
  });

  it("지난 세션(애프터마켓)에 받은 스냅샷이면 새로 받을 때까지 끈다 — 세션이 바뀐 지 10초 넘으면 1분(ttl)을 기다리지 않고 다시 받는다", async () => {
    const t = { now: Date.parse("2026-09-25T08:59:55+09:00") }; // 뉴욕 19:59:55 (애프터마켓)
    const db = await createMigratedDb(":memory:");
    await db.insertInto("registered_stocks").values({ code: "VRT", name: "VRT", market: "NYSE", quantity: 1, avg_price: 100, memo: null, created_at: "2026-09-01T00:00:00+09:00", updated_at: "2026-09-01T00:00:00+09:00" }).execute();
    let release: (() => void) | null = null;
    let hang = false;
    let calls = 0;
    // 공식 API 시세: 마지막 체결 가격·시각
    const last = { price: 100, asOf: "2026-09-25T08:59:50+09:00" };
    const quotes: QuoteProvider = {
      name: "toss-openapi",
      getQuote: async () => {
        throw new ProviderError("toss-openapi", "unused");
      },
      getQuotes: async (codes: string[]) => {
        calls++;
        if (hang) await new Promise<void>((r) => (release = r));
        return new Map(codes.map((c): [string, Quote] => [c, { ...makeQuote(c, "toss-openapi", last.price), currency: "USD", asOf: last.asOf }]));
      },
      getCandles: async () => {
        throw new ProviderError("toss-openapi", "unused");
      },
    };
    const live = new ScenarioLive(() => t.now);
    const quick = new ScenarioQuick(() => t.now);
    quick.facts.set("VRT", { daytime: true, nxt: false, halted: false, nxtHalted: false, etp: false, exchange: null, pricedAt: null });
    const service = new StockService({ db, quotes, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, quickPrices: quick, now: () => new Date(t.now) });
    expect((await service.listWithQuotes())[0]!.quote!.session!.phase).toBe("after");
    // 뉴욕 20:00:07 — 주간거래 시작. 웹소켓 체결이 막 왔다 (이 시장 체결 증거)
    t.now = Date.parse("2026-09-25T09:00:07+09:00");
    live.aliveAt = new Date(t.now).toISOString();
    live.ticks.set("VRT", { code: "VRT", price: 100.5, volume: 1, timestamp: "2026-09-25T09:00:06+09:00", receivedAt: t.now });
    hang = true;
    const stale = (await service.listWithQuotes())[0]!.quote!;
    expect(stale.session!.phase).toBe("overnight");
    expect(stale.realtime).toBe(false); // 스냅샷은 지난 거래일(9/24) 것 — 새 체결을 붙이지 않으니 값이 움직이지 않는다
    expect(stale.price).toBe(100);
    expect(calls).toBe(2); // ttl(1분) 전이지만 세션이 바뀌어 다시 받는 중
    // 새로 받은 스냅샷(주간거래 첫 체결 100.4)에 웹소켓 체결(100.5)이 붙는다
    Object.assign(last, { price: 100.4, asOf: "2026-09-25T09:00:02+09:00" });
    release!();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = (await service.listWithQuotes())[0]!.quote!;
    expect(fresh).toMatchObject({ realtime: true, price: 100.5 });
  });

  it("토스 웹소켓이 끊기고 토스 웹 가격도 못 받으면 아무 종목도 실시간이 아니다", async () => {
    const { service } = await scenario({ live: false, quickFails: true });
    const list = await service.listWithQuotes();
    expect(list.some((s) => s.quote?.realtime)).toBe(false);
    expect(list.find((s) => s.code === "VRT")!.quote!.session!.open).toBe(true); // 세션은 그대로 열림
  });

  it("주간거래 지원 여부를 못 받으면 이 세션(20:00 뒤)에 체결이 있었던 종목만 — 증거가 없는 종목은 점을 켜지 않는다", async () => {
    const { service } = await scenario({ facts: false });
    const list = await service.listWithQuotes();
    const live = list.filter((s) => s.quote?.realtime).map((s) => s.code);
    // VRT·QNT(웹소켓 체결)·GD(공식 API 마지막 체결 09:31 KST = 뉴욕 20:31)는 증거가 있고, APH(19:59 체결)·나머지(05:00)는 없다
    expect(live).toEqual(["VRT", "QNT", "GD"]);
  });
});

// ── 세션 표 (StockService 전체): 운영처럼 토스 웹이 모든 종목 가격을 준다 (받은 시각이 찍힘, 체결이 없던 종목은 스냅샷과 같은 가격) ──────

/** 종목별 공식 API 스냅샷(가격 100, asOf = 마지막 체결)과 토스 웹 가격으로 잔고를 한 번 받는다 */
async function table(o: {
  now: string;
  asOf: Record<string, string>;
  facts?: Record<string, StockSessionFacts | null>;
  /** 토스 달력 [tradingEnd, nextTradingStart] (삼성전자·애플). "fallback" 이면 조회 실패(요일 추정) */
  kr?: [string, string] | "fallback";
  us?: [string, string] | "fallback";
  /** 이 달력을 먼저 한 번 받은 뒤(서버가 떠 있던 중) 지금 달력으로 바뀐다 */
  krBefore?: [string, string];
  ws?: Record<string, { price: number; ts: string }>;
  wsConnected?: boolean;
  quickFails?: boolean;
  quick?: Record<string, number>;
}) {
  const codes = Object.keys(o.asOf);
  const t = { now: Date.parse(o.now) };
  const db = await createMigratedDb(":memory:");
  await db
    .insertInto("registered_stocks")
    .values(codes.map((code, i) => ({ code, name: code, market: /^\d/.test(code) ? "KOSPI" : "NYSE", quantity: 1, avg_price: 100, memo: null, created_at: `2026-09-01T00:00:${String(i).padStart(2, "0")}+09:00`, updated_at: "2026-09-01T00:00:00+09:00" })))
    .execute();
  const quotes: QuoteProvider = {
    name: "toss-openapi",
    getQuote: async () => {
      throw new ProviderError("toss-openapi", "unused");
    },
    getQuotes: async (cs: string[]) => new Map(cs.map((c): [string, Quote] => [c, { ...makeQuote(c, "toss-openapi", 100), currency: /^\d/.test(c) ? "KRW" : "USD", asOf: o.asOf[c]! }])),
    getCandles: async () => {
      throw new ProviderError("toss-openapi", "unused");
    },
  };
  const live = new (class extends EventEmitter implements LiveTicks {
    get = (c: string) => (o.ws?.[c] ? { code: c, price: o.ws[c]!.price, volume: 1, timestamp: o.ws[c]!.ts, receivedAt: Date.parse(o.ws[c]!.ts) } : null);
    setCodes() {}
    status() {
      const a = new Date(t.now).toISOString();
      return { enabled: true, connected: o.wsConnected ?? true, subscribed: codes.map((c) => (/^\d/.test(c) ? `trade:kr:${c}` : `trade:us:${c}`)), lastMessageAt: a, lastAliveAt: a, lastError: null };
    }
  })();
  const quick = new ScenarioQuick(() => t.now);
  quick.fail = o.quickFails ?? false;
  for (const c of codes) quick.prices.set(c, o.quick?.[c] ?? 100);
  for (const c of codes) {
    const f = o.facts?.[c];
    if (f) quick.facts.set(c, f);
  }
  const state = (m: "KR" | "US", w: [string, string] | "fallback" | undefined, now: Date) =>
    w === "fallback" || !w ? fallbackState(m, now) : stateFromSession(m, now, w[0], w[1]);
  let kr = o.krBefore ?? o.kr;
  const cal = { status: async () => ({ now: new Date(t.now).toISOString(), KR: state("KR", kr, new Date(t.now)), US: state("US", o.us, new Date(t.now)) }) };
  const service = new StockService({ db, quotes, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, quickPrices: quick, calendar: cal, now: () => new Date(t.now) });
  if (o.krBefore) {
    await service.listWithQuotes();
    kr = o.kr;
  }
  const list = await service.listWithQuotes();
  return Object.fromEntries(list.map((s) => [s.code, { phase: s.quote!.session!.phase, realtime: s.quote!.realtime }]));
}

// 2026-09-22(화) 거래일. 토스 달력 — 한국: 장중 9/22 20:00 마감·다음 9/23 08:00, 미국(정규장만): 9/21 16:00 마감·다음 9/22 09:30
const KR_922: [string, string] = ["2026-09-22T11:00:00Z", "2026-09-22T23:00:00Z"];
const US_922: [string, string] = ["2026-09-21T20:00:00Z", "2026-09-22T13:30:00Z"];
const KR_CHUSEOK: [string, string] = ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"];
const US_924: [string, string] = ["2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z"];
const ETF = "069500";

describe("세션 표 — 한국 (토스 웹이 모든 종목 가격을 줌)", () => {
  // NAVER(NXT) 마지막 체결 9/21 19:50(NXT 애프터), 윙입푸드 900340(한국거래소만) 9/21 15:30, KODEX 200(ETF) 9/21 15:30
  const yesterday = { [NAVER]: "2026-09-21T19:50:00+09:00", "900340": "2026-09-21T15:30:00+09:00", [ETF]: "2026-09-21T15:30:00+09:00" };
  const facts = { [NAVER]: NXT, "900340": KRX_ONLY, [ETF]: KR_ETF };

  it("NXT 프리마켓 08:30: 오늘 체결이 아직 없어도 NXT 종목은 켜고, 한국거래소만 거래하는 종목·ETF 는 끈다", async () => {
    const r = await table({ now: "2026-09-22T08:30:00+09:00", asOf: yesterday, facts, kr: KR_922, us: US_922 });
    expect(r).toEqual({ [NAVER]: { phase: "nxt_pre", realtime: true }, "900340": { phase: "nxt_pre", realtime: false }, [ETF]: { phase: "nxt_pre", realtime: false } });
  });

  it("정규장 09:05: 오늘 아직 체결이 없는 종목(마지막 체결이 어제)도 모두 켠다", async () => {
    const r = await table({ now: "2026-09-22T09:05:00+09:00", asOf: yesterday, facts, kr: KR_922, us: US_922 });
    expect(Object.values(r).every((x) => x.phase === "regular" && x.realtime)).toBe(true);
  });

  it("동시호가(08:55·15:25)·장 마감(15:35·20:30)에는 끈다", async () => {
    for (const now of ["2026-09-22T08:55:00+09:00", "2026-09-22T15:25:00+09:00", "2026-09-22T15:35:00+09:00", "2026-09-22T20:30:00+09:00"]) {
      const r = await table({ now, asOf: { [NAVER]: "2026-09-22T08:49:00+09:00" }, facts, kr: KR_922, us: US_922 });
      expect(r[NAVER]!.realtime, now).toBe(false);
    }
  });

  it("NXT 애프터마켓 15:45: NXT 종목만 (한국거래소는 시간외 종가라 가격이 안 바뀜)", async () => {
    const asOf = { [NAVER]: "2026-09-22T15:30:00+09:00", "900340": "2026-09-22T15:30:00+09:00" };
    const r = await table({ now: "2026-09-22T15:45:00+09:00", asOf, facts, kr: KR_922, us: US_922 });
    expect(r).toEqual({ [NAVER]: { phase: "nxt_after", realtime: true }, "900340": { phase: "nxt_after", realtime: false } });
  });

  it("애프터마켓 16:30(한국거래소 16:00~ + NXT): NXT 종목은 켜고, 한국거래소만 거래하는 종목은 16:00 뒤 체결이 있으면 켜고, ETF 는 끈다", async () => {
    const asOf = { [NAVER]: "2026-09-22T15:30:00+09:00", "900340": "2026-09-22T15:30:00+09:00", "000660": "2026-09-22T16:10:00+09:00", [ETF]: "2026-09-22T16:10:00+09:00" };
    const r = await table({ now: "2026-09-22T16:30:00+09:00", asOf, facts: { ...facts, "000660": KRX_ONLY }, kr: KR_922, us: US_922 });
    expect(r).toEqual({
      [NAVER]: { phase: "after", realtime: true },
      "900340": { phase: "after", realtime: false }, // 16:00 뒤 체결 없음 (한국거래소 애프터마켓 대상인지 모름)
      "000660": { phase: "after", realtime: true }, // 16:10 체결 — 한국거래소 애프터마켓에서 거래 중
      [ETF]: { phase: "after", realtime: false },
    });
  });

  it("추석(9/25 10:00)은 휴장이라 끈다 — 달력 조회가 실패해도 마지막 토스 달력으로", async () => {
    const asOf = { [NAVER]: "2026-09-23T19:59:58+09:00" };
    const ws = { [NAVER]: { price: 100, ts: "2026-09-23T19:59:58+09:00" } }; // 서버가 9/23 부터 떠 있었다
    expect(await table({ now: "2026-09-25T10:00:00+09:00", asOf, ws, facts, kr: KR_CHUSEOK, us: US_924 })).toEqual({ [NAVER]: { phase: "holiday", realtime: false } });
    expect(await table({ now: "2026-09-25T10:00:00+09:00", asOf, ws, facts, krBefore: KR_CHUSEOK, kr: "fallback", us: US_924 })).toEqual({ [NAVER]: { phase: "holiday", realtime: false } });
  });

  it("토스 달력을 한 번도 못 받았으면(요일로 짐작) 휴장일일 수 있어 이 세션 체결이 있었던 종목만 켠다", async () => {
    const holiday = await table({ now: "2026-09-25T10:00:00+09:00", asOf: { [NAVER]: "2026-09-23T19:59:58+09:00" }, facts, kr: "fallback", us: US_924 });
    expect(holiday).toEqual({ [NAVER]: { phase: "regular", realtime: false } }); // 추석인데 평일로 짐작 — 체결이 없으니 점은 없다
    const trading = await table({ now: "2026-09-22T10:00:00+09:00", asOf: { [NAVER]: "2026-09-22T09:59:30+09:00", "900340": "2026-09-21T15:30:00+09:00" }, facts, kr: "fallback", us: US_922 });
    expect(trading).toEqual({ [NAVER]: { phase: "regular", realtime: true }, "900340": { phase: "regular", realtime: false } });
  });
});

describe("세션 표 — 미국 (서머타임·표준시, 토스 웹이 모든 종목 가격을 줌)", () => {
  const NVR = "NVR";
  it("프리마켓 07:00 EDT: 주간거래 미지원 종목도 켠다 (마지막 체결이 전날 애프터마켓이어도)", async () => {
    const r = await table({ now: "2026-09-22T07:00:00-04:00", asOf: { [NVR]: "2026-09-21T17:30:00-04:00" }, facts: { [NVR]: US_NO_DAY }, kr: KR_922, us: US_922 });
    expect(r).toEqual({ [NVR]: { phase: "pre", realtime: true } });
  });

  it("정규장 10:00 EDT·애프터마켓 17:00 EDT: 모든 종목", async () => {
    const us: [string, string] = ["2026-09-22T20:00:00Z", "2026-09-23T13:30:00Z"];
    expect(await table({ now: "2026-09-22T10:00:00-04:00", asOf: { [NVR]: "2026-09-21T16:00:00-04:00" }, facts: { [NVR]: US_NO_DAY }, kr: KR_922, us })).toEqual({ [NVR]: { phase: "regular", realtime: true } });
    expect(await table({ now: "2026-09-22T17:00:00-04:00", asOf: { [NVR]: "2026-09-22T16:00:00-04:00" }, facts: { [NVR]: US_NO_DAY }, kr: KR_922, us })).toEqual({ [NVR]: { phase: "after", realtime: true } });
  });

  it("주간거래 21:00 EST(1월): 지원 종목은 체결이 없어도 켜고, 미지원은 끄고, 모르면 이 세션(20:00 뒤) 체결이 있을 때만", async () => {
    const us: [string, string] = ["2026-01-14T21:00:00Z", "2026-01-15T14:30:00Z"];
    const kr: [string, string] = ["2026-01-14T11:00:00Z", "2026-01-14T23:00:00Z"];
    // NEWX·NEWY: 주간거래 지원 여부를 못 받음. NEWY 는 20:40 에 체결(웹소켓·공식 API 모두 앎)
    const asOf = { RTX: "2026-01-14T19:10:00-05:00", [NVR]: "2026-01-14T19:10:00-05:00", NEWX: "2026-01-14T19:10:00-05:00", NEWY: "2026-01-14T20:40:00-05:00" };
    const ws = { NEWY: { price: 100.5, ts: "2026-01-14T20:40:00-05:00" } };
    const r = await table({ now: "2026-01-14T21:00:00-05:00", asOf, ws, facts: { RTX: US_DAY, [NVR]: US_NO_DAY, NEWX: null, NEWY: null }, kr, us });
    expect(r).toEqual({
      RTX: { phase: "overnight", realtime: true },
      [NVR]: { phase: "overnight", realtime: false },
      NEWX: { phase: "overnight", realtime: false },
      NEWY: { phase: "overnight", realtime: true },
    });
  });

  it("추수감사절(11/26) 낮은 휴장", async () => {
    const us: [string, string] = ["2026-11-25T21:00:00Z", "2026-11-27T14:30:00Z"];
    const r = await table({ now: "2026-11-26T12:00:00-05:00", asOf: { RTX: "2026-11-25T19:59:00-05:00" }, facts: { RTX: US_DAY }, kr: ["2026-11-26T11:00:00Z", "2026-11-26T23:00:00Z"], us });
    expect(r).toEqual({ RTX: { phase: "holiday", realtime: false } });
  });
});

describe("세션 표 — 서버 수신 상태", () => {
  const asOf = { [NAVER]: "2026-09-22T09:59:00+09:00", "900340": "2026-09-21T15:30:00+09:00" };
  const facts = { [NAVER]: NXT, "900340": KRX_ONLY };
  const at10 = "2026-09-22T10:00:00+09:00";

  it("웹소켓 끊김이어도 토스 웹 가격을 받는 중이면 켠다", async () => {
    const r = await table({ now: at10, asOf, facts, kr: KR_922, us: US_922, wsConnected: false });
    expect(Object.values(r).every((x) => x.realtime)).toBe(true);
  });

  it("토스 웹이 장애이면: 웹소켓이 이번 세션 한국 체결을 준 뒤에만 켜고, 웹소켓도 끊기면 끈다", async () => {
    const none = await table({ now: at10, asOf, facts, kr: KR_922, us: US_922, quickFails: true });
    expect(Object.values(none).some((x) => x.realtime)).toBe(false);
    const ws = { [NAVER]: { price: 100, ts: "2026-09-22T09:59:00+09:00" } };
    const covered = await table({ now: at10, asOf, facts, kr: KR_922, us: US_922, quickFails: true, ws });
    expect(Object.values(covered).every((x) => x.realtime)).toBe(true); // 웹소켓이 살아 있고 구독 중 — 체결이 없던 900340 도
    const down = await table({ now: at10, asOf, facts, kr: KR_922, us: US_922, quickFails: true, ws, wsConnected: false });
    expect(Object.values(down).some((x) => x.realtime)).toBe(false);
  });
});

// ── 검증 지적: 웹소켓 마지막 체결이 스냅샷 asOf 와 같고(같은 공식 API) 이번 세션 웹소켓 체결은 없는데 토스 웹 가격만 움직이는 종목 ──────
// 예전에는 웹소켓 옛 체결(= 스냅샷)을 먼저 써서 가격은 멈추고, 점은 토스 웹 가격을 15초 안에 받았다는 이유로 켜졌다 (점과 가격 출처가 다른 기준)

/**
 * 한 종목. 웹소켓은 붙어 구독 중이지만 이번 세션 체결을 준 적이 없다 (마지막 체결 = 스냅샷에 든 체결).
 * 토스 웹 가격은 3초마다 받는다 (poll 이 가격과 pricedAt = 지금을 넣는다). rest 를 바꾸면 공식 API 를 다음에 다시 받을 때 그 값
 */
async function wsBehind(o: { code: string; now: string; facts: StockSessionFacts; asOf: string; kr: [string, string]; us: [string, string] }) {
  const t = { now: Date.parse(o.now) };
  const kr = /^\d/.test(o.code);
  const db = await createMigratedDb(":memory:");
  await db
    .insertInto("registered_stocks")
    .values({ code: o.code, name: o.code, market: kr ? "KOSPI" : "NYSE", quantity: 1, avg_price: 100, memo: null, created_at: "2026-09-01T00:00:00+09:00", updated_at: "2026-09-01T00:00:00+09:00" })
    .execute();
  const rest = { price: 100, asOf: o.asOf };
  let fetches = 0;
  const quotes: QuoteProvider = {
    name: "toss-openapi",
    getQuote: async () => {
      throw new ProviderError("toss-openapi", "unused");
    },
    getQuotes: async (cs: string[]) => (fetches++, new Map(cs.map((c): [string, Quote] => [c, { ...makeQuote(c, "toss-openapi", rest.price), currency: kr ? "KRW" : "USD", asOf: rest.asOf }]))),
    getCandles: async () => {
      throw new ProviderError("toss-openapi", "unused");
    },
  };
  const tick: LiveTick = { code: o.code, price: 100, volume: 1, timestamp: o.asOf, receivedAt: Date.parse(o.asOf) };
  const live = new (class extends EventEmitter implements LiveTicks {
    get = (c: string) => (c === o.code ? tick : null);
    setCodes() {}
    status() {
      const a = new Date(t.now).toISOString();
      return { enabled: true, connected: true, subscribed: [`trade:${kr ? "kr" : "us"}:${o.code}`], lastMessageAt: a, lastAliveAt: a, lastError: null };
    }
  })();
  const quick = new ScenarioQuick(() => t.now);
  const cal = { status: async () => calendar(new Date(t.now), o.kr, o.us) };
  const service = new StockService({ db, quotes, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, quickPrices: quick, calendar: cal, now: () => new Date(t.now) });
  /** 토스 웹 가격을 price 로 (방금 받음) 바꾸고 잔고를 한 번 받는다 */
  const poll = async (price: number) => {
    quick.prices.set(o.code, price);
    quick.facts.set(o.code, { ...o.facts, pricedAt: t.now });
    const q = (await service.listWithQuotes())[0]!.quote!;
    return { price: q.price, realtime: q.realtime };
  };
  return { t, rest, poll, service, fetches: () => fetches };
}

describe("초록 점이 켜지면 가격도 따라간다 (웹소켓 마지막 체결 = 스냅샷, 토스 웹 가격만 움직임)", () => {
  // 2026-09-25 09:58:45 KST = 뉴욕 9/24 20:58:45 (미국 주간거래, 20:00 시작). VRT 는 주간거래 지원.
  // 공식 API 스냅샷 asOf 08:59:30 KST(뉴욕 19:59:30 애프터마켓) · 100 = 웹소켓 마지막 체결. 20:00 뒤 미국 웹소켓 체결은 없다
  const vrt = () => wsBehind({ code: "VRT", now: "2026-09-25T09:58:45+09:00", facts: US_DAY, asOf: "2026-09-25T08:59:30+09:00", kr: KR_CHUSEOK, us: US_924 });
  /** 15초마다 받은 토스 웹 가격 (09:59:00 부터) */
  const moves = [100.7, 100.9, 101.1, 101.0, 101.1];

  it("공식 API 가 주간거래 체결을 주면: 웹소켓 옛 체결 대신 토스 웹 가격을 쓰고, 스냅샷을 다시 받은 뒤로는 그 가격을 따라간다", async () => {
    const s = await vrt();
    expect(await s.poll(100)).toEqual({ price: 100, realtime: true }); // 이번 거래일 체결이 아직 없음 — 조용한 종목도 켠다
    const seen = [];
    for (const p of moves) {
      s.t.now += 15_000;
      Object.assign(s.rest, { price: p, asOf: new Date(s.t.now - 1_000).toISOString() }); // 공식 API 도 1초 전 체결을 안다
      seen.push(await s.poll(p));
    }
    // 처음 본 새 거래일 가격은 스냅샷을 다시 받을 때까지(10초 안) 붙이지 않는다 (전일 종가가 하루 밀려 등락이 이틀치가 되지 않게) — 점은 그대로
    expect(seen[0]).toEqual({ price: 100, realtime: true });
    expect(seen.slice(1)).toEqual(moves.slice(1).map((p) => ({ price: p, realtime: true })));
  });

  it("공식 API 도 주간거래 체결을 주지 않으면: 다시 받아도 붙일 수 없으니 점을 끈다 — 가격이 멈춘 채 점만 켜지지 않는다", async () => {
    const s = await vrt();
    expect(await s.poll(100)).toEqual({ price: 100, realtime: true });
    const seen = [];
    for (const p of moves) {
      s.t.now += 15_000;
      seen.push(await s.poll(p));
    }
    expect(s.fetches()).toBeGreaterThan(1); // 새 거래일 가격을 보고 스냅샷을 다시 받았다
    expect(seen[0]).toEqual({ price: 100, realtime: true }); // 다시 받기 전(10초 안)
    // 다시 받아도 스냅샷이 지난 거래일 것 그대로 → 토스 웹 가격을 붙일 수 없다 → 점도 끈다
    expect(seen.slice(1)).toEqual(moves.slice(1).map(() => ({ price: 100, realtime: false })));
  });

  it("공식 API 가 뒤늦게 이번 거래일 체결을 주면 다시 켜진다", async () => {
    const s = await vrt();
    await s.poll(100);
    for (const p of moves.slice(0, 3)) {
      s.t.now += 15_000;
      await s.poll(p);
    }
    expect((await s.poll(101.1)).realtime).toBe(false);
    Object.assign(s.rest, { price: 101.05, asOf: new Date(s.t.now).toISOString() });
    s.t.now += 61_000; // 1분(ttl) 지나 다시 받는다
    expect(await s.poll(101.2)).toEqual({ price: 101.2, realtime: true });
  });

  it("한국 16:00~20:00 애프터마켓도 같다: 웹소켓 마지막 체결이 15:30 종가(= 스냅샷)여도 토스 웹 가격을 따라간다", async () => {
    const s = await wsBehind({ code: NAVER, now: "2026-09-22T16:29:45+09:00", facts: NXT, asOf: "2026-09-22T15:30:00+09:00", kr: KR_922, us: US_922 });
    expect(await s.poll(100)).toEqual({ price: 100, realtime: true });
    for (const p of [100.5, 100.8, 100.6]) {
      s.t.now += 15_000;
      expect(await s.poll(p)).toEqual({ price: p, realtime: true }); // 예전: 웹소켓 15:30 체결(100)을 먼저 써 가격은 멈추고 점만 켜졌다
    }
  });

  it("웹소켓 체결 목록: 이번 세션에 그 시장 체결을 웹소켓으로 받은 종목(또는 세션이 닫힌 종목)만 토스 웹 폴링 없이 둔다 — 실시간 스트림도 같은 기준", async () => {
    const quiet = await scenario({ sessionTicks: false });
    // 미국: 이번 세션(뉴욕 20:00 뒤) 웹소켓 체결이 없다 → 토스 웹으로 폴링. NAVER: 추석 휴장이라 폴링할 것이 없다
    expect([...(await quiet.service.wsServed([...US_HOLDINGS, NAVER]))].sort()).toEqual([NAVER]);
    const busy = await scenario();
    expect([...(await busy.service.wsServed([...US_HOLDINGS, NAVER]))].sort()).toEqual([...US_HOLDINGS, NAVER].sort());
    const down = await scenario({ live: false });
    expect((await down.service.wsServed([...US_HOLDINGS, NAVER])).size).toBe(0);
  });
});
