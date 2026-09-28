import type { Candle } from "../src/domain/types.js";
import { isKrTradingDate, isUsTradingDate } from "../src/services/marketContext.js";

/**
 * 거래량 급증 테스트용 30분봉 도우미 (3-29). hhmm 은 봉이 **시작**하는 현지 시각(작업지시 7장의 봉 설명과 같음)이고,
 * 봉 시각(time)에는 토스처럼 봉이 **끝나는** 시각(시작 + 30분)을 같은 오프셋으로 적는다 (2026-09-28 실측). date 는 그 시각 글자의 앞 10자 (토스 dt.slice(0, 10) 흉내)
 */
export function bar(date: string, hhmm: string, volume: number, offset = "+09:00"): Candle {
  const end = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + 30;
  const d = new Date(`${date}T12:00:00Z`);
  if (end >= 24 * 60) d.setUTCDate(d.getUTCDate() + 1);
  const m = end % (24 * 60);
  const day = d.toISOString().slice(0, 10);
  const time = `${day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00${offset}`;
  return { date: time.slice(0, 10), time, open: 1, high: 1, low: 1, close: 1, volume };
}

/** from ~ to (둘 다 포함) 30분 간격 "HH:MM" */
export function halfHours(from: string, to: string): string[] {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const out: string[] = [];
  for (let t = m(from); t <= m(to); t += 30) out.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
  return out;
}

/** date 앞의 거래일 n 개 (오래된 → 최근). 주말·휴장일 목록(marketContext)으로 거슬러 센다 */
export function tradingDaysBefore(date: string, n: number, kr = true): string[] {
  const out: string[] = [];
  const d = new Date(`${date}T12:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (kr ? isKrTradingDate(s) : isUsTradingDate(s)) out.unshift(s);
  }
  return out;
}

/**
 * 작업지시 7장 A 모양: 2026-12-08 10:15(서울) 기준 한국 종목. 앞 25거래일은 09:00~15:00 13개 × 1,000 (수능일 11/19 는 10:00~16:00),
 * 오늘 09:00 3,000 · 09:30 3,000 · 10:00 1,500 → ratio 3 (days 20, volume 7,500, expected 2,500)
 */
export function aBars(): Candle[] {
  const out: Candle[] = [];
  for (const d of tradingDaysBefore("2026-12-08", 25)) {
    const times = d === "2026-11-19" ? halfHours("10:00", "16:00") : halfHours("09:00", "15:00");
    for (const t of times) out.push(bar(d, t, 1000));
  }
  out.push(bar("2026-12-08", "09:00", 3000), bar("2026-12-08", "09:30", 3000), bar("2026-12-08", "10:00", 1500));
  return out;
}
