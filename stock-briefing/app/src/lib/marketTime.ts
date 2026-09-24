import type { CandlePeriod, MarketStatus } from "@/api/types";

/**
 * 시장 현지 시각·거래일 규칙 하나 (서버 marketContext.tradingDate · stockService.sameTradingDay · tossOpenApi.aggregateCandles 와 같은 기준).
 *  - 한국 종목은 서울, 미국 종목은 뉴욕(서머타임 포함) 시각으로 본다
 *  - 한국 00:00~08:00(NXT 프리마켓 전)은 체결이 없는 시간 → 직전 거래일. 이때 받은 시세(받은 시각이 asOf 인 토스 웹·네이버)는 지난 거래일 값이다
 *  - 미국 뉴욕 20:00 이후(애프터마켓이 끝난 뒤 주간거래)는 다음 날 정규장에 딸린 세션 → 다음 거래일 (토스도 다음 거래일 봉에 넣는다)
 *  - 체결 시각이 Z 든 +09:00 이든 같은 순간이면 같은 거래일 (앞 10자리를 자르지 않는다)
 * 실시간 체결을 시세(liveTick)·차트 봉(chartPrefs)에 붙일 때 같이 쓴다.
 */

/** 한국 종목 코드: 숫자로 시작하는 6자리 (서버 lib/codes 의 KR_CODE_RE 와 같다). 나머지는 미국 */
const KR_CODE_RE = /^\d[0-9A-Z]{5}$/;

export function isKrCode(code: string): boolean {
  return KR_CODE_RE.test(code);
}

/** 서울은 서머타임이 없어 +9 시간 고정 */
const SEOUL_OFFSET_MIN = 540;

let nyFormat: Intl.DateTimeFormat | null | undefined;
/** 오프셋은 정시에만 바뀌므로 같은 시(hour) 안의 체결은 한 번 계산한 값을 쓴다 */
let nyCache: { hour: number; off: number } | null = null;

/** 뉴욕 오프셋(분)을 기기 Intl 시간대 자료로. 쓸 수 없거나 값이 이상하면(시간대를 무시하는 엔진 등) null → 규칙으로 */
function nyOffsetIntl(t: number): number | null {
  if (nyFormat === null) return null;
  const hour = Math.floor(t / 3_600_000);
  if (nyCache?.hour === hour) return nyCache.off;
  try {
    nyFormat ??= new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    const p: Record<string, number> = {};
    for (const part of nyFormat.formatToParts(new Date(t))) if (part.type !== "literal") p[part.type] = Number(part.value);
    const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!);
    const off = Math.round((local - Math.floor(t / 60_000) * 60_000) / 60_000);
    if (off === -240 || off === -300) {
      nyCache = { hour, off };
      return off;
    }
  } catch {
    /* 아래에서 규칙으로 */
  }
  nyFormat = null; // 이 기기 Intl 로는 뉴욕 시각을 못 구한다 → 앞으로 규칙만
  return null;
}

/** Intl 이 없는 기기용: 미국 동부 서머타임(2007~ 규칙) — 3월 둘째 일요일 02:00 EST ~ 11월 첫째 일요일 02:00 EDT 는 -4, 나머지 -5 시간 */
export function nyOffsetByRule(t: number): number {
  const y = new Date(t).getUTCFullYear();
  const sunday = (month: number, nth: number) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + (nth - 1) * 7;
  const start = Date.UTC(y, 2, sunday(2, 2), 7); // 02:00 EST = 07:00Z
  const end = Date.UTC(y, 10, sunday(10, 1), 6); // 02:00 EDT = 06:00Z
  return t >= start && t < end ? -240 : -300;
}

/** 그 순간 시장의 UTC 오프셋(분) */
function offsetMin(t: number, code: string): number {
  return isKrCode(code) ? SEOUL_OFFSET_MIN : (nyOffsetIntl(t) ?? nyOffsetByRule(t));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "+09:00" / "-04:00" 표기 */
function offsetText(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** 시장 현지 시각 "YYYY-MM-DDTHH:MM:SS" 와 그 순간의 오프셋("+09:00"). 시각을 못 읽으면 null */
export function marketClock(iso: string, code: string): { local: string; offset: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const off = offsetMin(t, code);
  return { local: new Date(t + off * 60_000).toISOString().slice(0, 19), offset: offsetText(off) };
}

/** 시장 현지 달력 날짜 YYYY-MM-DD (분봉의 date). 시각을 못 읽으면 null. 거래일은 tradingDate */
export function marketDate(iso: string, code: string): string | null {
  return marketClock(iso, code)?.local.slice(0, 10) ?? null;
}

/** 한국 거래(NXT 프리마켓)가 시작되는 서울 시각. 그 전(00:00~08:00)은 직전 거래일에 딸린 시간 */
const KR_SESSION_FROM_H = 8;
/** 한국 거래(NXT 애프터마켓)가 끝나는 서울 시각 */
const KR_SESSION_TO_H = 20;
/** 미국 주간거래(블루오션)가 시작되는 뉴욕 시각. 여기부터 다음 날 04:00(프리마켓 시작)까지는 다음 날 정규장에 딸린 세션 */
const US_OVERNIGHT_FROM_H = 20;
const US_OVERNIGHT_TO_H = 4;

/**
 * 뉴욕증권거래소 평일 휴장일 (현지 날짜). 서버 marketContext.US_HOLIDAYS 와 같은 목록 — 해마다 둘 다 추가한다(app/test 가 두 목록이 같은지, 내년 끝까지 있는지 본다).
 * 없으면 평일로 본다. 한국 평일 휴장일은 목록이 없다 (장 상태는 서버 달력 값을 쓴다)
 */
const US_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 일 ~ 6 토 */
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** 그 시장이 거래하는 날인지: 토·일이 아니고, 미국은 휴장일도 아님 */
function isSessionDay(date: string, code: string): boolean {
  const wd = weekdayOf(date);
  return wd >= 1 && wd <= 5 && (isKrCode(code) || !US_HOLIDAYS.has(date));
}

/** 세션 날짜(휴장 보정 전): 한국은 서울 날짜(08:00 전은 전날), 미국은 뉴욕 날짜(20:00 이후는 다음 날) */
function sessionDate(local: string, code: string): string {
  const date = local.slice(0, 10);
  const hour = Number(local.slice(11, 13));
  if (isKrCode(code)) return hour < KR_SESSION_FROM_H ? addDays(date, -1) : date;
  return hour >= US_OVERNIGHT_FROM_H ? addDays(date, 1) : date;
}

/**
 * 체결·시세가 속한 거래일 YYYY-MM-DD. 시각을 못 읽으면 null.
 *  - 한국은 서울 날짜, 단 08:00 전은 전날 — 장 시작 전에 받은 시세(전일 종가가 지난 거래일 기준)에 08:00 첫 체결을 붙이지 않게 (PF-01)
 *  - 미국은 뉴욕 날짜, 단 뉴욕 20:00 이후(주간거래)는 다음 날 — 한국 낮의 주간거래 체결이 끝난 정규장 봉을 고치지 않고 다음 거래일 봉으로 간다
 *  - 거래가 없는 날(토·일, 미국 휴장일)은 직전 거래일로 본다(서버가 막 켜져 값이 그대로인 체결 등) → 빈 봉을 만들지 않게
 * 한국 평일 휴장일은 모른다 — 그날 체결은 새 거래일로 보고, 서버 봉·시세를 다시 받으면 바로잡힌다
 * (차트는 접속 직후 스냅샷으로 새 봉을 열지 않고, 다시 받은 서버 봉에 서버에 없는 봉을 붙이지 않는다 — lib/liveStream)
 */
export function tradingDate(iso: string, code: string): string | null {
  const clock = marketClock(iso, code);
  if (!clock) return null;
  let date = sessionDate(clock.local, code);
  for (let i = 0; i < 7 && !isSessionDay(date, code); i++) date = addDays(date, -1);
  return date;
}

/** 시세 기준 시각과 체결이 같은 거래일인지 (서버 stockService.sameTradingDay 와 같다). 시각을 못 읽으면 막지 않는다 */
export function sameTradingDay(asOf: string, tickIso: string, code: string): boolean {
  const a = tradingDate(asOf, code);
  const b = tradingDate(tickIso, code);
  return a === null || b === null || a === b;
}

/**
 * 그 시각이 그 시장의 거래 시간인지 (요일·시각·미국 휴장일로). 시각을 못 읽으면 true.
 *  - 한국: 평일 08:00~20:00 (서울, KRX+NXT)
 *  - 미국: 세션 날짜가 거래일인 동안 — 뉴욕 전날 20:00(주간거래) ~ 당일 20:00(애프터 끝). 일요일 20:00 ~ 금요일 20:00, 휴장일 빼고
 * 한국 평일 휴장일은 모른다
 */
export function inTradingHours(iso: string, code: string): boolean {
  const clock = marketClock(iso, code);
  if (!clock) return true;
  const hour = Number(clock.local.slice(11, 13));
  if (isKrCode(code) && (hour < KR_SESSION_FROM_H || hour >= KR_SESSION_TO_H)) return false;
  return isSessionDay(sessionDate(clock.local, code), code);
}

/**
 * 지금 그 종목에 거래가 있는 시간인지 (차트 봉 주기 갱신용, PF-04).
 *  - 서버 장 상태가 있으면 그 값. 미국은 토스 달력 isOpen 이 프리~애프터(뉴욕 04:00~20:00)뿐이라 주간거래(뉴욕 20:00~04:00, 다음 날이 거래일인 밤)를 더한다
 *  - 장 상태를 모르면(못 받음) 요일·시각으로 (inTradingHours)
 */
export function tradingNow(code: string, status: Pick<MarketStatus, "KR" | "US"> | undefined, now = Date.now()): boolean {
  const iso = new Date(now).toISOString();
  const open = inTradingHours(iso, code);
  if (isKrCode(code)) return status ? status.KR.isOpen : open;
  if (!status) return open;
  const hour = Number(marketClock(iso, code)?.local.slice(11, 13) ?? 12);
  return status.US.isOpen || (open && (hour >= US_OVERNIGHT_FROM_H || hour < US_OVERNIGHT_TO_H));
}

/** 일·주·월봉 구간 키 (서버 aggregateCandles 와 같다: 주는 월요일 시작, 월은 YYYY-MM, 일은 날짜 그대로) */
export function periodKey(date: string, period: CandlePeriod): string {
  if (period === "M") return date.slice(0, 7);
  if (period !== "W") return date;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 월=0
  return d.toISOString().slice(0, 10);
}
