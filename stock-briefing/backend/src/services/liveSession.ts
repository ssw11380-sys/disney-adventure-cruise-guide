import type { QuoteSession } from "../domain/types.js";
import { isKrCode } from "../lib/codes.js";
import type { MarketState, MarketStatus } from "../providers/market/calendar.js";
import type { StockSessionFacts } from "../providers/market/tossRealtime.js";
import { US_HOLIDAYS } from "./marketContext.js";

/**
 * 종목 하나의 "지금 거래 세션"과 초록 점(실시간) 판단 — 순수 함수 (단위 테스트: test/liveSession.test.ts).
 * 점의 뜻: 이 종목 가격이 지금 열린 거래 시간에 실시간(웹소켓 체결 또는 토스 웹 3초 갱신)으로 바뀌고 있다.
 * 체결이 아직 없어도, 세션이 열려 있고 이 종목이 그 세션의 거래 대상이며 서버가 값을 받고 있으면 켠다.
 * (예전에는 "스냅샷과 다른 가격의 체결이 왔다"여서 거래가 뜸한 종목은 같은 세션에서도 점이 없었다)
 *
 * 한국 (서울 시각. 거래일은 토스 달력 — 한국 평일 휴장일 목록은 따로 없다)
 *   08:00~08:50 NXT 프리마켓(NXT 대상만) · 08:50~09:00 동시호가 · 09:00~15:20 정규장(모든 종목)
 *   · 15:20~15:30 동시호가 · 15:30~15:40 장 마감(NXT 애프터마켓 전) · 15:40~20:00 NXT 애프터마켓(NXT 대상만)
 * 미국 (뉴욕 시각·서머타임. 정규장 거래일은 토스 달력 → 없으면 US_HOLIDAYS)
 *   전날 20:00~04:00 주간거래(토스 주간거래 대상만, 다음 날이 정규장인 밤만) · 04:00~09:30 프리마켓
 *   · 09:30~마감 정규장 · 마감~마감+4시간 애프터마켓(보통 16:00~20:00, 조기 폐장 13:00 이면 17:00 까지) — 프리·정규·애프터는 모든 종목
 * 토스 달력(삼성전자·애플 시세의 tradingEnd/nextTradingStart)은 한국은 KRX+NXT(08:00~20:00), 미국은 정규장만 알려 준다.
 * 토스 주간거래가 끝나는 정확한 시각(04:00 인지 03:30 인지)은 확인하지 못했다 — 앱·서버의 거래일 규칙(뉴욕 20:00~04:00)과 같게 둔다.
 */

export type { QuoteSession, SessionPhase } from "../domain/types.js";

/** 서버 안에서 쓰는 세션: 응답(QuoteSession)에 시작 시각을 더한 것 (자격을 모를 때 "이 세션에 체결이 있었나"를 재는 기준) */
export interface StockSession extends QuoteSession {
  /** 이 세션이 시작된 시각 (ISO). 닫혀 있으면 null */
  start: string | null;
}

export interface SessionFacts {
  /** 토스 달력 (없거나 요일 추정(fallback)이면 시각·요일·US_HOLIDAYS 로만) */
  calendar?: MarketStatus | null;
  /** 이 종목의 NXT·주간거래 대상·거래정지 (없으면 자격을 모름) */
  stock?: StockSessionFacts | null;
}

const TZ = { KR: "Asia/Seoul", US: "America/New_York" } as const;
const MIN = 60_000;

const formats = new Map<string, Intl.DateTimeFormat>();
/** 그 시장 현지 날짜(YYYY-MM-DD)와 자정부터 지난 분 */
function zoned(t: number, tz: string): { date: string; minutes: number } {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    formats.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: `${p["year"]}-${p["month"]}-${p["day"]}`, minutes: (Number(p["hour"]) % 24) * 60 + Number(p["minute"]) };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const weekday = (date: string) => {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5;
};

/** 그 시장 현지 날짜·시각(분) → 순간(ms). 서머타임이 바뀌는 새벽 2~3시는 경계로 쓰지 않는다 */
function localToUtc(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const offset = (t: number) => {
    const z = zoned(t, tz);
    const [zy, zm, zd] = z.date.split("-").map(Number) as [number, number, number];
    return Math.round((Date.UTC(zy, zm - 1, zd, 0, z.minutes) - Math.floor(t / MIN) * MIN) / MIN);
  };
  const first = offset(wall);
  let t = wall - first * MIN;
  const second = offset(t);
  if (second !== first) t = wall - second * MIN;
  return t;
}

const iso = (t: number) => new Date(t).toISOString();

/** 토스 달력을 믿을 수 있을 때만 (요일 추정 fallback 은 미국을 04:00~20:00 로 보는 등 기준이 달라 쓰지 않는다) */
const tossState = (s: MarketState | null | undefined): MarketState | null => (s && s.source === "toss" ? s : null);

// ── 한국 ──────────────────────────────────────────────────────────

const KR_NXT_PRE = 8 * 60;
const KR_OPEN_AUCTION = 8 * 60 + 50;
const KR_REGULAR = 9 * 60;
const KR_CLOSE_AUCTION = 15 * 60 + 20;
const KR_REGULAR_END = 15 * 60 + 30;
const KR_NXT_AFTER = 15 * 60 + 40;
const KR_END = 20 * 60;

/** 한국 거래일: 토스 달력(삼성전자 거래 시간)으로. 받은 뒤 날짜가 바뀌었을 수 있어 알려진 개장·마감 날짜로도 본다. 달력이 없으면 평일 */
function krTradingDay(date: string, cal: MarketState | null): boolean {
  if (!cal) return weekday(date);
  if (cal.isTradingDay) return true;
  return [cal.opensAt, cal.closesAt, cal.lastClose].some((x) => !!x && zoned(Date.parse(x), TZ.KR).date === date);
}

/** 다음 한국 개장(08:00): 달력의 다음 개장, 없으면 다음 평일 */
function nextKrOpen(t: number, date: string, cal: MarketState | null): number {
  const opens = cal?.opensAt ? Date.parse(cal.opensAt) : NaN;
  if (Number.isFinite(opens) && opens > t) return opens;
  let d = addDays(date, 1);
  for (let i = 0; i < 7 && !weekday(d); i++) d = addDays(d, 1);
  return localToUtc(d, KR_NXT_PRE, TZ.KR);
}

function krSession(t: number, calendar: MarketStatus | null | undefined, stock: StockSessionFacts | null | undefined): StockSession {
  const cal = tossState(calendar?.KR);
  const { date, minutes: m } = zoned(t, TZ.KR);
  const at = (min: number) => iso(localToUtc(date, min, TZ.KR));
  const closed = (phase: "closed" | "holiday" | "auction", until: string): StockSession => ({
    market: "KR",
    phase,
    label: phase === "holiday" ? "한국 휴장" : phase === "auction" ? "한국 동시호가" : "한국 장 마감",
    open: false,
    eligible: null,
    start: null,
    until,
  });
  if (!krTradingDay(date, cal)) return closed("holiday", iso(nextKrOpen(t, date, cal)));
  if (m < KR_NXT_PRE) return closed("closed", at(KR_NXT_PRE));
  const halted = stock?.halted === true;
  const nxtHalted = halted || stock?.nxtHalted === true;
  // NXT 대상: 토스 stock-infos(nxtSupported) → 없으면 토스 시세의 거래소 구분(integrated = KRX+NXT, krx = KRX 만) → 모름
  const nxt = stock?.nxt ?? (stock?.exchange === "integrated" ? true : stock?.exchange === "krx" ? false : null);
  const open = (phase: "nxt_pre" | "regular" | "nxt_after", from: number, to: number): StockSession => {
    const stop = phase === "regular" ? halted : nxtHalted;
    return {
      market: "KR",
      phase,
      label: phase === "regular" ? "한국 정규장" : phase === "nxt_pre" ? "한국 NXT 프리마켓" : "한국 NXT 애프터마켓",
      open: true,
      eligible: stop ? false : phase === "regular" ? true : nxt,
      ...(stop ? { halted: true as const } : {}),
      start: at(from),
      until: at(to),
    };
  };
  if (m < KR_OPEN_AUCTION) return open("nxt_pre", KR_NXT_PRE, KR_OPEN_AUCTION);
  if (m < KR_REGULAR) return closed("auction", at(KR_REGULAR));
  if (m < KR_CLOSE_AUCTION) return open("regular", KR_REGULAR, KR_CLOSE_AUCTION);
  if (m < KR_REGULAR_END) return closed("auction", at(KR_REGULAR_END));
  if (m < KR_NXT_AFTER) return closed("closed", at(KR_NXT_AFTER));
  if (m < KR_END) return open("nxt_after", KR_NXT_AFTER, KR_END);
  return closed("closed", iso(nextKrOpen(t, date, cal)));
}

// ── 미국 ──────────────────────────────────────────────────────────

const US_PRE = 4 * 60;
const US_REGULAR = 9 * 60 + 30;
const US_CLOSE = 16 * 60;
const US_AFTER_LEN = 4 * 60;
const US_OVERNIGHT = 20 * 60;

/**
 * 뉴욕 날짜가 정규장이 열리는 날인지. 토스 달력이 알려 준 날(마지막 정규장·다음 정규장, 그 사이는 휴장)을 먼저 쓰고,
 * 모르는 날은 평일이면서 US_HOLIDAYS 에 없는 날 — 목록 밖 임시 휴장도 달력이 알려 주면 지킨다
 */
function usRegularDays(cal: MarketState | null): (date: string) => boolean {
  const known = new Map<string, boolean>();
  const day = (x: string | null | undefined) => (x ? zoned(Date.parse(x), TZ.US).date : null);
  if (cal?.isOpen) {
    const c = day(cal.closesAt);
    if (c) known.set(c, true);
  } else if (cal) {
    const last = day(cal.lastClose);
    const next = day(cal.opensAt);
    if (last) known.set(last, true);
    if (next) known.set(next, true);
    if (last && next) for (let d = addDays(last, 1); d < next && known.size < 40; d = addDays(d, 1)) known.set(d, false);
  }
  return (date) => known.get(date) ?? (weekday(date) && !US_HOLIDAYS.has(date));
}

/** 그날 정규장 마감(분): 토스 달력의 마감 시각이 그날이면 그 값(조기 폐장 13:00), 아니면 16:00 */
function usCloseMinutes(cal: MarketState | null, date: string): number {
  const end = cal ? (cal.isOpen ? cal.closesAt : (cal.lastClose ?? null)) : null;
  if (!end) return US_CLOSE;
  const z = zoned(Date.parse(end), TZ.US);
  return z.date === date && z.minutes >= 10 * 60 && z.minutes <= 17 * 60 ? z.minutes : US_CLOSE;
}

function usSession(t: number, calendar: MarketStatus | null | undefined, stock: StockSessionFacts | null | undefined): StockSession {
  const cal = tossState(calendar?.US);
  const regularDay = usRegularDays(cal);
  const { date, minutes: m } = zoned(t, TZ.US);
  const at = (d: string, min: number) => iso(localToUtc(d, min, TZ.US));
  const halted = stock?.halted === true;
  const open = (phase: "overnight" | "pre" | "regular" | "after", start: string, until: string): StockSession => ({
    market: "US",
    phase,
    label: phase === "overnight" ? "미국 주간거래" : phase === "pre" ? "미국 프리마켓" : phase === "regular" ? "미국 정규장" : "미국 애프터마켓",
    open: true,
    // 주간거래는 토스가 지원하는 종목만 (daytimePriceSupported), 프리·정규·애프터는 모든 종목
    eligible: halted ? false : phase === "overnight" ? (stock?.daytime ?? null) : true,
    ...(halted ? { halted: true as const } : {}),
    start,
    until,
  });
  const tomorrow = addDays(date, 1);
  if (regularDay(date)) {
    const close = usCloseMinutes(cal, date);
    if (m < US_PRE) return open("overnight", at(addDays(date, -1), US_OVERNIGHT), at(date, US_PRE));
    if (m < US_REGULAR) return open("pre", at(date, US_PRE), at(date, US_REGULAR));
    if (m < close) return open("regular", at(date, US_REGULAR), at(date, close));
    if (m < close + US_AFTER_LEN) return open("after", at(date, close), at(date, close + US_AFTER_LEN));
  }
  if (m >= US_OVERNIGHT && regularDay(tomorrow)) return open("overnight", at(date, US_OVERNIGHT), at(tomorrow, US_PRE));
  // 닫힘: 다음 경계는 다음 주간거래 시작(다음 정규장 전날 20:00)
  // (오늘 밤이 그 전날이면 20:00 이 아직 오지 않은 것 — 지났다면 위에서 주간거래였다)
  let next = tomorrow;
  for (let i = 0; i < 14 && !regularDay(next); i++) next = addDays(next, 1);
  const today = regularDay(date);
  return { market: "US", phase: today ? "closed" : "holiday", label: today ? "미국 장 마감" : "미국 휴장", open: false, eligible: null, start: null, until: at(addDays(next, -1), US_OVERNIGHT) };
}

// ── 공개 함수 ─────────────────────────────────────────────────────

/** 종목의 지금 세션 (종목 코드로 시장을 가른다: 숫자로 시작하면 한국) */
export function sessionAt(code: string, now: Date, facts: SessionFacts = {}): StockSession {
  const t = now.getTime();
  return isKrCode(code) ? krSession(t, facts.calendar, facts.stock) : usSession(t, facts.calendar, facts.stock);
}

/** 응답에 넣는 모양 (시작 시각은 빼고) */
export function toQuoteSession(s: StockSession): QuoteSession {
  const { start: _start, ...rest } = s;
  return rest;
}

/** 등록 종목 시장 중 하나라도 지금 연속 거래 세션이면 true (서버 토스 웹 폴링 주기 — 토스 달력은 미국 정규장만 알려 주므로 세션으로 본다) */
export function anySessionOpen(codes: readonly string[], status: MarketStatus | null, now: Date): boolean {
  const t = now.getTime();
  return (codes.some(isKrCode) && krSession(t, status, null).open) || (codes.some((c) => !isKrCode(c)) && usSession(t, status, null).open);
}

/** 토스 웹 일괄 가격을 이 시간 안에 받았으면 "3초 갱신 중"으로 본다 (앱 폴링 3초 × 5번, 앱 OPEN_MAX_AGE_MS 와 같다) */
export const POLL_FRESH_MS = 15_000;

export interface RealtimeInput {
  session: StockSession;
  now: number;
  /**
   * ws: 토스 웹소켓이 이 종목을 구독 중이고 연결이 살아 있으며(priceStream.wsCovered), 이번 세션에 이 시장 체결을 웹소켓으로 받은 적이 있음
   * (주간거래·프리·애프터 체결을 웹소켓이 주는지 확인하지 못해 실제로 받은 뒤에만 — StockService 가 정한다).
   * polledAt: 토스 웹 가격을 마지막으로 받은 시각
   */
  feed: { ws: boolean; polledAt: number | null };
  /** 시세를 새로 받지 못한 마지막 값 */
  stale: boolean;
  /** 받아 둔 스냅샷이 지금 거래일에 받은 것 (지난 세션 스냅샷에는 새 체결을 붙이지 않으므로 값이 움직이지 않는다) */
  snapshotCurrent: boolean;
  /** 거래일이 바뀐 체결을 스냅샷을 다시 받을 때까지 보류 중 (가격이 그 체결을 따라가지 않는 중) */
  held: boolean;
  /** 실제 체결 시각의 증거 (웹소켓 체결 시각·공식 API 마지막 체결 시각·3초 갱신에서 본 가격 변화). 자격을 모를 때만 쓴다 */
  tradedAt: number | null;
}

/**
 * 초록 점: 세션이 열려 있고, 서버가 이 종목 가격을 지금 받고 있고(웹소켓 구독 또는 토스 웹 15초 안),
 * 지금 거래일의 스냅샷이며, 이 종목이 그 세션의 거래 대상일 때. 대상인지 모르면(토스 정보 없음) 이 세션에 체결이 있었다는 증거가 있을 때만.
 * 그 종목의 체결 여부는 보지 않는다 — 웹소켓은 유실이 있고 거래가 뜸한 종목은 몇 분씩 체결이 없다 (예전 규칙의 문제)
 */
export function realtimeOf(i: RealtimeInput): boolean {
  const s = i.session;
  if (!s.open || i.stale || !i.snapshotCurrent || i.held) return false;
  const polled = i.feed.polledAt !== null && Math.abs(i.now - i.feed.polledAt) <= POLL_FRESH_MS;
  if (!i.feed.ws && !polled) return false;
  if (s.eligible !== null) return s.eligible;
  const start = s.start ? Date.parse(s.start) : NaN;
  return i.tradedAt !== null && Number.isFinite(start) && i.tradedAt >= start;
}
