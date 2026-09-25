import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Quote } from "../src/domain/types.js";
import { createMigratedDb } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import { stateFromSession, type MarketStatus } from "../src/providers/market/calendar.js";
import type { LiveTick, LiveTicks, QuickPriceSource, StockSessionFacts } from "../src/providers/market/tossRealtime.js";
import type { QuoteProvider } from "../src/providers/market/types.js";
import { anySessionOpen, realtimeOf, sessionAt, type StockSession } from "../src/services/liveSession.js";
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

const NXT: StockSessionFacts = { daytime: false, nxt: true, halted: false, nxtHalted: false, exchange: "integrated", pricedAt: null };
const KRX_ONLY: StockSessionFacts = { daytime: false, nxt: false, halted: false, nxtHalted: false, exchange: "krx", pricedAt: null };
const US_DAY: StockSessionFacts = { daytime: true, nxt: false, halted: false, nxtHalted: false, exchange: null, pricedAt: null };
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
    ["2026-09-22T15:40:00+09:00", "nxt_after", "한국 NXT 애프터마켓", true, "2026-09-22T20:00:00+09:00"],
    ["2026-09-22T19:59:00+09:00", "nxt_after", "한국 NXT 애프터마켓", true, "2026-09-22T20:00:00+09:00"],
    ["2026-09-22T20:00:00+09:00", "closed", "한국 장 마감", false, "2026-09-23T08:00:00+09:00"],
  ])("%s → %s (%s)", (iso, phase, label, open, until) => {
    const s = kr(iso);
    expect(s).toMatchObject({ market: "KR", phase, label, open });
    expect(Date.parse(s.until!)).toBe(Date.parse(until));
  });

  it("정규장(09:00~15:20)에는 모든 한국 종목이 거래 대상, NXT 시간(08:00~08:50·15:40~20:00)에는 NXT 종목만", () => {
    expect(kr("2026-09-22T10:30:00+09:00", KRX_ONLY)).toMatchObject({ phase: "regular", open: true, eligible: true });
    expect(kr("2026-09-22T08:30:00+09:00", NXT)).toMatchObject({ phase: "nxt_pre", eligible: true });
    expect(kr("2026-09-22T08:30:00+09:00", KRX_ONLY)).toMatchObject({ phase: "nxt_pre", open: true, eligible: false });
    expect(kr("2026-09-22T16:00:00+09:00", NXT)).toMatchObject({ phase: "nxt_after", eligible: true });
    expect(kr("2026-09-22T16:00:00+09:00", KRX_ONLY)).toMatchObject({ phase: "nxt_after", eligible: false });
  });

  it("NXT 지원 여부를 모르면 토스 시세의 거래소 구분(integrated / krx)으로, 그것도 없으면 모름(null)", () => {
    const unknown = { ...NXT, nxt: null };
    expect(kr("2026-09-22T16:00:00+09:00", { ...unknown, exchange: "integrated" }).eligible).toBe(true);
    expect(kr("2026-09-22T16:00:00+09:00", { ...unknown, exchange: "krx" }).eligible).toBe(false);
    expect(kr("2026-09-22T16:00:00+09:00", { ...unknown, exchange: null }).eligible).toBeNull();
    expect(kr("2026-09-22T16:00:00+09:00", null).eligible).toBeNull();
  });

  it("거래정지 종목은 정규장·NXT 모두 거래 대상이 아니다 (NXT 만 정지면 NXT 시간만)", () => {
    expect(kr("2026-09-22T10:30:00+09:00", { ...NXT, halted: true })).toMatchObject({ open: true, eligible: false, halted: true });
    expect(kr("2026-09-22T10:30:00+09:00", { ...NXT, nxtHalted: true })).toMatchObject({ eligible: true });
    expect(kr("2026-09-22T16:00:00+09:00", { ...NXT, nxtHalted: true })).toMatchObject({ eligible: false, halted: true });
  });

  it("휴장일(추석 9/24~9/25)과 주말은 '한국 휴장', 다음 경계는 달력의 다음 개장", () => {
    const now = at("2026-09-25T09:59:00+09:00");
    const cal = calendar(now, ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], null);
    const s = sessionAt("035420", now, { calendar: cal, stock: NXT });
    expect(s).toMatchObject({ phase: "holiday", label: "한국 휴장", open: false });
    expect(Date.parse(s.until!)).toBe(Date.parse("2026-09-28T08:00:00+09:00"));
    // 달력을 못 받으면 요일로 (토요일 휴장, 평일은 거래일로 본다)
    expect(sessionAt("035420", at("2026-09-26T10:00:00+09:00")).phase).toBe("holiday");
    expect(sessionAt("035420", at("2026-10-06T10:00:00+09:00")).phase).toBe("regular");
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
  /** 토스 웹 일괄 가격 (코드 → 가격). 받은 시각은 now */
  prices = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async getMany(codes: string[]): Promise<Map<string, LiveTick>> {
    const at = this.now();
    return new Map(codes.flatMap((c) => (this.prices.has(c) ? [[c, { code: c, price: this.prices.get(c)!, volume: null, timestamp: new Date(at).toISOString(), receivedAt: at }] as const] : [])));
  }
  sessionFacts(codes: string[]) {
    return new Map(codes.flatMap((c) => (this.facts.has(c) ? [[c, this.facts.get(c)!] as const] : [])));
  }
}

async function scenario(o: { live?: boolean; facts?: boolean; sessionTicks?: boolean; pricedAgo?: number; quick?: Record<string, number>; gdAfterHoursTick?: boolean } = {}) {
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
  if (o.sessionTicks ?? true) {
    live.ticks.set("VRT", { code: "VRT", price: 101.5, volume: 3, timestamp: "2026-09-25T09:58:59+09:00", receivedAt: t.now - 1_000 });
    live.ticks.set("QNT", { code: "QNT", price: 99.2, volume: 5, timestamp: "2026-09-25T09:58:58+09:00", receivedAt: t.now - 2_000 });
  }
  live.ticks.set("APH", { code: "APH", price: 100, volume: 1, timestamp: "2026-09-25T08:59:00+09:00", receivedAt: t.now - 3_600_000 }); // 같은 가격
  // GD: 웹소켓 마지막 체결은 애프터마켓(스냅샷 09:31 보다 오래됨)
  if (o.gdAfterHoursTick) live.ticks.set("GD", { code: "GD", price: 98, volume: 1, timestamp: "2026-09-25T08:50:00+09:00", receivedAt: t.now - 4_000_000 });
  const quick = new ScenarioQuick(() => t.now);
  for (const [c, p] of Object.entries(o.quick ?? {})) quick.prices.set(c, p);
  if (o.facts ?? true) {
    const pricedAt = o.pricedAgo === undefined ? null : t.now - o.pricedAgo;
    for (const c of US_HOLDINGS) quick.facts.set(c, { daytime: true, nxt: false, halted: false, nxtHalted: false, exchange: null, pricedAt });
    quick.facts.set(NAVER, { daytime: false, nxt: true, halted: false, nxtHalted: false, exchange: "integrated", pricedAt: null });
  }
  const now = at("2026-09-25T09:59:00+09:00");
  const cal = { status: async () => calendar(now, ["2026-09-23T11:00:00Z", "2026-09-27T23:00:00Z"], ["2026-09-24T20:00:00Z", "2026-09-25T13:30:00Z"]) };
  const service = new StockService({ db, quotes, search: new FakeSearchProvider(), master: new FakeMasterProvider(), live, quickPrices: quick, calendar: cal, now: () => new Date(t.now) });
  return { service, live, quick, t };
}

describe("보고된 장면: 09:59 KST 잔고 (미국 주간거래 중, 한국 추석 휴장)", () => {
  it("미국 9종목 모두 실시간(주간거래 지원·웹소켓 구독 중 — 체결이 없던 종목도), NAVER 는 휴장이라 아님", async () => {
    const { service } = await scenario();
    const list = await service.listWithQuotes();
    const by = new Map(list.map((s) => [s.code, s.quote!]));
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

  it("웹소켓이 붙어 구독 중이어도 이번 세션(20:00 뒤) 미국 체결이 하나도 안 왔으면 웹소켓만으로는 켜지 않는다 — 토스 웹 가격을 15초 안에 받으면 켠다", async () => {
    // 토스 웹소켓이 주간거래 체결을 주는지는 확인하지 못했다 → 이 세션 체결을 실제로 받은 뒤에만 웹소켓을 믿는다
    const quiet = await scenario({ sessionTicks: false });
    expect((await quiet.service.listWithQuotes()).some((s) => s.quote?.realtime)).toBe(false);
    const polled = await scenario({ sessionTicks: false, pricedAgo: 3_000 });
    expect((await polled.service.listWithQuotes()).filter((s) => s.quote?.realtime).map((s) => s.code)).toEqual(US_HOLDINGS);
    const late = await scenario({ sessionTicks: false, pricedAgo: 20_000 }); // 3초 갱신이 멈춤
    expect((await late.service.listWithQuotes()).some((s) => s.quote?.realtime)).toBe(false);
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
    quick.facts.set("VRT", { daytime: true, nxt: false, halted: false, nxtHalted: false, exchange: null, pricedAt: null });
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
    const { service } = await scenario({ live: false });
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
