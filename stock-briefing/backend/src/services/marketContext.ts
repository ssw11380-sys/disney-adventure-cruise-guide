import type { Candle } from "../domain/types.js";
import type { MarketState, MarketStatus } from "../providers/market/calendar.js";

/**
 * 브리핑 시점의 장 상태 (순수 함수 → 단위 테스트). 모델이 "마감"·"정규장"을 잘못 쓰지 않게 사실을 문장으로 넘긴다.
 * 가격이 어느 거래를 반영하는지는 시세의 priceBasis 가 말하므로 여기서는 세션만 말한다.
 *  - 미국: 정규장(09:30~16:00 ET, 조기 폐장일 13:00) 진행 중 / 프리마켓 / 애프터마켓 / 주간거래(뉴욕 20:00~04:00) / 정규장 마감
 *  - 한국: 정규장(09:00~15:30, 수능일 등 특수일은 KR_SPECIAL_HOURS) 진행 중 / NXT 프리·애프터마켓 / 장 마감
 * 지표는 끝나지 않은 봉을 빼고 계산한다. 한국 일봉은 KRX+NXT 통합 봉이라 애프터마켓이 끝나는 20:00 에 확정된다
 */

export interface MarketContext {
  market: "KR" | "US";
  /** regular = 정규장 진행 중, extended = 정규장 밖 거래 중(프리·애프터·주간거래), closed = 거래 없음 */
  phase: "regular" | "extended" | "closed";
  /** 모델에게 그대로 주는 한 줄 설명 */
  label: string;
  /** 마지막으로 끝난 정규장의 현지 날짜 (YYYY-MM-DD). 모르면 null */
  lastRegularDate: string | null;
  /** 오늘(현지) 봉이 아직 끝나지 않음 (정규장 중·한국 08:00~20:00 — 통합 봉은 애프터마켓이 끝나는 20:00 에 확정) */
  todayIncomplete: boolean;
}

function parts(d: Date, tz: string): { date: string; minutes: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const h = Number(g("hour")) % 24;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: h * 60 + Number(g("minute")), weekday: wd };
}

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
/** 자정부터 분 → "HH:MM" */
const hm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** 뉴욕증권거래소 휴장일 (현지 날짜). 해마다 추가 — 없으면 평일로 본다. 앱 lib/marketTime 에 같은 목록이 있다 (app/test 가 같은지·내년 끝까지 있는지 본다) */
export const US_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** 뉴욕 현지 날짜 YYYY-MM-DD 가 미국 정규장이 열리는 날인지 (주말·US_HOLIDAYS 제외) */
export const isUsTradingDate = (date: string) => {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5 && !US_HOLIDAYS.has(date);
};

/** 뉴욕증권거래소 조기 폐장일(13:00 ET, 현지 날짜) — 추수감사절 다음 날·평일 크리스마스이브. 해마다 추가 (토스 달력이 그날 마감을 알려 주면 그 값이 먼저) */
export const US_EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

const US_CLOSE = 16 * 60;

/**
 * 뉴욕 날짜의 정규장 마감(자정부터 분, 애프터마켓은 그 뒤 4시간): 토스 달력이 그날 마감 시각을 알려 주면 그 값(조기 폐장 13:00 등),
 * 아니면 US_EARLY_CLOSES 13:00, 아니면 16:00. services/liveSession 과 달력 추정값(fallbackState)도 이 값을 쓴다
 */
export function usRegularCloseMinutes(date: string, cal?: MarketState | null): number {
  const end = cal?.source === "toss" ? (cal.isOpen ? cal.closesAt : (cal.lastClose ?? null)) : null;
  if (end && !Number.isNaN(Date.parse(end))) {
    const z = parts(new Date(end), "America/New_York");
    if (z.date === date && z.minutes >= 10 * 60 && z.minutes <= 17 * 60) return z.minutes;
  }
  return US_EARLY_CLOSES.has(date) ? 13 * 60 : US_CLOSE;
}

/**
 * 한국거래소 정규장 시각이 평소(09:00~15:30)와 다른 날 (서울 날짜, 자정부터 분). 해마다 추가 — 없으면 평소 시각.
 * 수능일은 개장·마감이 1시간씩 늦고(10:00~16:30), 새해 첫 거래일은 10:00 에 연다
 */
export const KR_SPECIAL_HOURS: Readonly<Record<string, { open: number; close: number; reason: string }>> = {
  "2026-11-19": { open: 10 * 60, close: 16 * 60 + 30, reason: "수능일" },
  "2027-01-04": { open: 10 * 60, close: 15 * 60 + 30, reason: "새해 첫 거래일" },
};

/** 서울 날짜의 한국거래소 정규장 (특수일이면 reason) */
export function krRegularHours(date: string): { open: number; close: number; reason: string | null } {
  return KR_SPECIAL_HOURS[date] ?? { open: 9 * 60, close: 15 * 60 + 30, reason: null };
}

export function marketContext(code: string, status: MarketStatus | null, now: Date): MarketContext {
  const kr = /^\d/.test(code);
  if (kr) {
    const p = parts(now, "Asia/Seoul");
    const tradingDay = status ? status.KR.isTradingDay : p.weekday >= 1 && p.weekday <= 5;
    const lastClose = status?.KR.lastClose ? parts(new Date(status.KR.lastClose), "Asia/Seoul").date : null;
    const h = krRegularHours(p.date);
    if (tradingDay && p.minutes >= h.open && p.minutes < h.close) {
      const special = h.reason ? ` — 오늘은 ${h.reason}이라 ${hm(h.open)}~${hm(h.close)}` : "";
      return { market: "KR", phase: "regular", label: `한국 정규장 진행 중(${hm(h.close)} 마감 전${special}). 오늘 봉은 아직 끝나지 않았습니다`, lastRegularDate: lastClose, todayIncomplete: true };
    }
    if (tradingDay && p.minutes >= 8 * 60 && p.minutes < h.open) {
      const label =
        p.minutes >= h.open - 10
          ? "한국 정규장 개장 직전"
          : h.reason
            ? `한국 정규장 개장 전(오늘은 ${h.reason}이라 ${hm(h.open)} 개장)`
            : "한국 정규장 개장 전, 넥스트레이드(NXT) 프리마켓 중";
      return { market: "KR", phase: "extended", label, lastRegularDate: lastClose, todayIncomplete: true };
    }
    if (tradingDay && p.minutes >= h.close && p.minutes < 20 * 60) {
      // 애프터마켓: 넥스트레이드 15:40~20:00, 한국거래소 16:00~20:00 (2026-09-14 부터, ETF·ETN 제외).
      // 일봉(토스)은 KRX+NXT 통합 봉이라 종가·고저·거래량이 20:00 까지 바뀐다 → 오늘 정규장은 끝났어도 오늘 봉은 끝나지 않은 봉(지표·최근 봉에서 뺀다)
      const session = h.reason
        ? "애프터마켓 시간(20:00 까지)"
        : p.minutes < 16 * 60
          ? "넥스트레이드(NXT) 애프터마켓 시간(한국거래소 애프터마켓은 16:00 부터, 20:00 까지)"
          : "애프터마켓 시간(한국거래소·넥스트레이드, 20:00 까지)";
      return {
        market: "KR",
        phase: "extended",
        label: `오늘(${md(p.date)}) 한국 정규장은 ${hm(h.close)} 에 마감, 지금은 ${session}. 오늘 봉(KRX+NXT 통합)은 20:00 에 끝나 아직 확정되지 않았고, 지금 가격은 정규장 종가가 아닙니다`,
        lastRegularDate: p.date,
        todayIncomplete: true,
      };
    }
    const closedLabel = `${tradingDay ? "한국 장 마감 상태" : "한국 휴장일"}${lastClose ? ` (마지막 거래일 ${md(lastClose)})` : ""}`;
    return { market: "KR", phase: "closed", label: closedLabel, lastRegularDate: lastClose ?? (tradingDay && p.minutes >= 20 * 60 ? p.date : null), todayIncomplete: false };
  }
  // 미국: 토스 달력의 isOpen 은 정규장뿐이라(프리·애프터·주간거래는 닫힘) 세션은 뉴욕 시각으로 가린다
  const ny = parts(now, "America/New_York");
  const weekday = ny.weekday >= 1 && ny.weekday <= 5;
  const tradingDay = (status ? status.US.isTradingDay : weekday) && !US_HOLIDAYS.has(ny.date);
  // 정규장 마감: 조기 폐장일(추수감사절 다음 날·크리스마스이브)은 13:00 ET, 애프터마켓은 마감 뒤 4시간(17:00)까지
  const close = usRegularCloseMinutes(ny.date, status?.US);
  const early = close !== US_CLOSE;
  const afterClose = tradingDay && ny.minutes >= close;
  const lastRegular = afterClose ? ny.date : prevTradingDate(ny.date);
  const last = md(lastRegular);
  if (tradingDay && ny.minutes >= 9 * 60 + 30 && ny.minutes < close)
    return { market: "US", phase: "regular", label: `미국 정규장 진행 중(${early ? `오늘은 조기 폐장이라 ${hm(close)}` : "16:00"} ET 마감 전). 오늘 봉은 아직 끝나지 않았습니다`, lastRegularDate: lastRegular, todayIncomplete: true };
  if (tradingDay && ny.minutes >= 4 * 60 && ny.minutes < 9 * 60 + 30)
    return { market: "US", phase: "extended", label: `미국 프리마켓 중(정규장 개장 전). 마지막 정규장은 ${last}(현지)`, lastRegularDate: lastRegular, todayIncomplete: false };
  if (afterClose && ny.minutes < close + 4 * 60)
    return {
      market: "US",
      phase: "extended",
      label: early ? `미국 정규장은 ${last}(현지) ${hm(close)} ET 에 조기 마감, 지금은 애프터마켓 중(${hm(close + 4 * 60)} ET 까지)` : `미국 정규장은 ${last}(현지) 마감, 지금은 애프터마켓 중`,
      lastRegularDate: lastRegular,
      todayIncomplete: false,
    };
  // 뉴욕 20:00~다음 날 04:00 은 미국 주간거래(한국 낮: 서머타임 09:00~17:00, 표준시 10:00~18:00) — 정규장은 전날 밤 끝났다.
  // 주간거래는 다음 날 정규장에 딸린 세션 → 그날이 미국 거래일일 때만 (추수감사절 등 휴장일 전날 밤엔 없다). services/liveSession 과 같은 규칙
  const overnight = ny.minutes >= 20 * 60 ? isUsTradingDate(nextDate(ny.date)) : ny.minutes < 4 * 60 && isUsTradingDate(ny.date);
  if (overnight)
    return { market: "US", phase: "extended", label: `미국 주간거래(한국 낮 시간) 중. 마지막 정규장은 ${last}(현지)에 끝났고 다음 정규장은 아직 열리지 않았습니다`, lastRegularDate: lastRegular, todayIncomplete: false };
  return { market: "US", phase: "closed", label: `미국 정규장 마감 상태 (마지막 정규장 ${last}, 현지)`, lastRegularDate: lastRegular, todayIncomplete: false };
}

/**
 * 체결·시세가 속한 거래일 YYYY-MM-DD (앱 lib/marketTime 의 tradingDate 와 같은 규칙).
 *  - 한국은 서울 날짜, 단 08:00(NXT 프리마켓 시작) 전은 전날 — 토스 웹·네이버 시세는 받은 시각이 asOf 라 장 시작 전에 받은 지난 거래일 시세에
 *    08:00 첫 체결을 붙이지 않게 (그 시간엔 한국 체결이 없다)
 *  - 미국은 뉴욕 날짜, 단 뉴욕 20:00 이후(애프터마켓이 끝난 뒤 주간거래)는 다음 날 정규장에 딸린 세션이라 다음 날 (토스도 다음 거래일 봉에 넣는다)
 *  - 거래가 없는 날(토·일, 미국 휴장일 US_HOLIDAYS)은 직전 거래일로 본다 (한국 평일 휴장일은 목록이 없어 보지 않는다 — 앱과 같게)
 */
export function tradingDate(iso: string, kr: boolean): string {
  const p = parts(new Date(iso), kr ? "Asia/Seoul" : "America/New_York");
  const d = new Date(`${p.date}T12:00:00Z`);
  if (kr && p.minutes < 8 * 60) d.setUTCDate(d.getUTCDate() - 1);
  if (!kr && p.minutes >= 20 * 60) d.setUTCDate(d.getUTCDate() + 1);
  const day = () => d.toISOString().slice(0, 10);
  const open = () => (kr ? d.getUTCDay() >= 1 && d.getUTCDay() <= 5 : isUsTradingDate(day()));
  for (let i = 0; i < 7 && !open(); i++) d.setUTCDate(d.getUTCDate() - 1);
  return day();
}

/** 다음 달력 날짜 */
function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 직전 미국 거래일 (주말·휴장일 건너뜀) */
function prevTradingDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (!isUsTradingDate(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}

/** 지표용 일봉: 끝나지 않은 봉(마지막 정규장 날짜보다 뒤, 또는 정규장 진행 중인 오늘 봉)을 뺀다 */
export function completedCandles(candles: Candle[], ctx: MarketContext, now: Date): Candle[] {
  const today = parts(now, ctx.market === "KR" ? "Asia/Seoul" : "America/New_York").date;
  return candles.filter((c) => {
    if (ctx.todayIncomplete && c.date >= today) return false;
    if (ctx.lastRegularDate && c.date > ctx.lastRegularDate) return false;
    return true;
  });
}
