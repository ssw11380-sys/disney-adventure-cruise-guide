import type { Candle } from "../domain/types.js";
import type { MarketStatus } from "../providers/market/calendar.js";

/**
 * 브리핑 시점의 장 상태 (순수 함수 → 단위 테스트). 모델이 "마감"·"정규장"을 잘못 쓰지 않게 사실을 문장으로 넘긴다.
 * 가격이 어느 거래를 반영하는지는 시세의 priceBasis 가 말하므로 여기서는 세션만 말한다.
 *  - 미국: 정규장(09:30~16:00 ET) 진행 중 / 프리마켓 / 애프터마켓 / 주간거래(한국 낮, 정규장은 전날 밤 마감) / 정규장 마감
 *  - 한국: 정규장(09:00~15:30) 진행 중 / NXT 프리·애프터마켓 / 장 마감
 * 지표는 끝나지 않은 봉을 빼고 계산한다 (완성된 마지막 정규장까지만)
 */

export interface MarketContext {
  market: "KR" | "US";
  /** regular = 정규장 진행 중, extended = 정규장 밖 거래 중(프리·애프터·주간거래), closed = 거래 없음 */
  phase: "regular" | "extended" | "closed";
  /** 모델에게 그대로 주는 한 줄 설명 */
  label: string;
  /** 마지막으로 끝난 정규장의 현지 날짜 (YYYY-MM-DD). 모르면 null */
  lastRegularDate: string | null;
  /** 오늘(현지) 봉이 아직 끝나지 않음 (정규장 중·한국 NXT 프리마켓) */
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

/**
 * lastRegularHint: 일봉에서 확인한 마지막 완성 정규장 날짜 (휴장일이 끼면 요일 계산보다 정확) — 날짜 표시에 쓴다
 */
export function marketContext(code: string, status: MarketStatus | null, now: Date, lastRegularHint?: string | null): MarketContext {
  const kr = /^\d/.test(code);
  if (kr) {
    const p = parts(now, "Asia/Seoul");
    const tradingDay = status ? status.KR.isTradingDay : p.weekday >= 1 && p.weekday <= 5;
    const lastClose = lastRegularHint ?? (status?.KR.lastClose ? parts(new Date(status.KR.lastClose), "Asia/Seoul").date : null);
    if (tradingDay && p.minutes >= 9 * 60 && p.minutes < 15 * 60 + 30)
      return { market: "KR", phase: "regular", label: `한국 정규장 진행 중(15:30 마감 전). 오늘 봉은 아직 끝나지 않았습니다`, lastRegularDate: lastClose, todayIncomplete: true };
    if (tradingDay && p.minutes >= 8 * 60 && p.minutes < 20 * 60) {
      const pre = p.minutes < 9 * 60;
      return {
        market: "KR",
        phase: "extended",
        label: pre ? "한국 정규장 개장 전, 넥스트레이드(NXT) 프리마켓 중" : `오늘(${md(p.date)}) 한국 정규장은 15:30 에 마감, 지금은 넥스트레이드(NXT) 애프터마켓 중(20:00 까지)`,
        lastRegularDate: pre ? lastClose : p.date,
        todayIncomplete: pre,
      };
    }
    const closedLabel = `${tradingDay ? "한국 장 마감 상태" : "한국 휴장일"}${lastClose ? ` (마지막 거래일 ${md(lastClose)})` : ""}`;
    return { market: "KR", phase: "closed", label: closedLabel, lastRegularDate: lastClose ?? (tradingDay && p.minutes >= 20 * 60 ? p.date : null), todayIncomplete: false };
  }
  // 미국: 토스 달력의 isOpen 은 프리~애프터를 모두 포함하므로 정규장 여부는 뉴욕 시각으로 가린다
  const ny = parts(now, "America/New_York");
  const weekday = ny.weekday >= 1 && ny.weekday <= 5;
  const tradingDay = status ? status.US.isTradingDay : weekday;
  const afterClose = tradingDay && ny.minutes >= 16 * 60;
  const lastRegular = lastRegularHint ?? (afterClose ? ny.date : prevWeekday(ny.date));
  const last = md(lastRegular);
  if (tradingDay && ny.minutes >= 9 * 60 + 30 && ny.minutes < 16 * 60)
    return { market: "US", phase: "regular", label: "미국 정규장 진행 중(16:00 ET 마감 전). 오늘 봉은 아직 끝나지 않았습니다", lastRegularDate: lastRegular, todayIncomplete: true };
  if (tradingDay && ny.minutes >= 4 * 60 && ny.minutes < 9 * 60 + 30)
    return { market: "US", phase: "extended", label: `미국 프리마켓 중(정규장 개장 전). 마지막 정규장은 ${last}(현지)`, lastRegularDate: lastRegular, todayIncomplete: false };
  if (afterClose && ny.minutes < 20 * 60)
    return { market: "US", phase: "extended", label: `미국 정규장은 ${last}(현지) 마감, 지금은 애프터마켓 중`, lastRegularDate: lastRegular, todayIncomplete: false };
  // 한국 낮 시간(대략 10:00~17:30 KST)은 미국 주간거래(블루오션) 시간 — 정규장은 전날 밤 끝났다
  const kst = parts(now, "Asia/Seoul");
  if (kst.weekday >= 1 && kst.weekday <= 5 && kst.minutes >= 10 * 60 && kst.minutes < 17 * 60 + 30)
    return { market: "US", phase: "extended", label: `미국 주간거래(한국 낮 시간) 중. 마지막 정규장은 ${last}(현지)에 끝났고 다음 정규장은 아직 열리지 않았습니다. 지금 브리핑을 "장 마감"으로 쓰지 않습니다`, lastRegularDate: lastRegular, todayIncomplete: false };
  return { market: "US", phase: "closed", label: `미국 정규장 마감 상태 (마지막 정규장 ${last}, 현지)`, lastRegularDate: lastRegular, todayIncomplete: false };
}

/** 직전 평일 (휴장일은 모름 → 일봉으로 보정: lastRegularHint) */
function prevWeekday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
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
