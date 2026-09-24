import type { CandlePeriod } from "@/api/types";

/**
 * 시장 현지 시각·거래일 규칙 하나 (서버 stockService.sameTradingDay · tossOpenApi.localDate/aggregateCandles 와 같은 기준).
 *  - 한국 종목은 서울, 미국 종목은 뉴욕(서머타임 포함) 날짜가 거래일이다
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

/** 시장 현지 날짜(거래일) YYYY-MM-DD. 시각을 못 읽으면 null */
export function marketDate(iso: string, code: string): string | null {
  return marketClock(iso, code)?.local.slice(0, 10) ?? null;
}

/** 시세 기준 시각과 체결이 같은 거래일인지. 서버와 같이 시각을 못 읽으면 막지 않는다 */
export function sameTradingDay(asOf: string, tickIso: string, code: string): boolean {
  const a = marketDate(asOf, code);
  const b = marketDate(tickIso, code);
  return a === null || b === null || a === b;
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
