import type { Candle } from "../domain/types.js";
import { isKrCode } from "../lib/codes.js";
import { seoulIso } from "../lib/time.js";
import { isKrTradingDate, isUsTradingDate, krRegularHours, parts, usRegularCloseMinutes } from "./marketContext.js";

/**
 * 거래량 급증 (3-29 가격 알림, 플래그 priceAlerts) — 순수 함수 (단위 테스트).
 * ratio = 오늘 정규장 누적 거래량(지금까지) ÷ 지난 거래일들의 '개장 뒤 같은 경과 시간까지' 누적 거래량 평균.
 *  - 데이터는 차트와 같은 30분봉(토스 웹 차트, 한 번에 450개까지). 오늘 누적도 같은 봉으로 센다 (시세의 volume 과 섞지 않음 — 출처·구간이 다름)
 *  - 지난 날은 받은 봉이 덮는 만큼 최근 것부터 최대 20거래일 (days). 5일 미만이면 견주지 않는다 (short)
 *  - 정규장만: 한국 KRX 정규장(수능일·새해 첫 거래일은 그날 개장), 미국 09:30 ET ~ 그날 마감(조기 폐장 13:00). 프리·애프터·주간거래 봉은 오늘·지난 날 모두 뺀다
 *  - 봉 안은 고르게 나눠 센다: 지난 날은 같은 경과 시간이 걸친 봉을 비율만큼. 그래서 개장 뒤 첫 30분(첫 봉 — 시가 단일가가 몰림)은 확인하지 않는다 (early)
 *  - 시각은 그 시장 현지 시각 (한국 = 서울, 미국 = 뉴욕 — 서머타임이 바뀐 주도 현지 시각으로 맞춘다)
 *  - 토스 30분봉의 시각(dt → Candle.time)은 **봉이 끝나는 시각**이다 (2026-09-28 실측: 한국 봉이 08:30~20:00 24개, 10:00 에 받은 마지막 봉이 10:30,
 *    미국은 금요일 마지막 봉이 20:00). 그래서 봉 시작 = 시각 − 30분으로 나눈다 — 시작으로 보면 한 칸씩 밀려 한국은 NXT 프리마켓 봉(08:30~09:00)을
 *    정규장 첫 봉으로 세고 마감 단일가가 든 봉(15:00~15:30)을 뺀다
 */

export type VolumeState = "ok" | "closed" | "early" | "short" | "unavailable";

export interface VolumeStatus {
  code: string;
  status: VolumeState;
  /** 그 시장의 오늘 날짜 (한국 = 서울, 미국 = 뉴욕). closed 면 null */
  date: string | null;
  /** 오늘 정규장 누적 거래량 (30분봉 합, 지금 봉 포함). ok 일 때만, 아니면 null */
  volume: number | null;
  /** 지난 거래일들의 같은 경과 시간 누적 평균 (반올림한 정수). ok 일 때만 */
  expected: number | null;
  /** volume ÷ (반올림 전 평균), 소수 둘째 자리 반올림. ok 일 때만 */
  ratio: number | null;
  /** 평균에 쓴 지난 거래일 수 (최대 20). ok·short 일 때, 그 밖에는 0 */
  days: number;
  /** 오늘 정규장 개장 뒤 지난 분. closed 면 null */
  minutes: number | null;
  /** 계산한 때 (한국 시간 ISO, seoulIso(now)) */
  asOf: string;
  /** ok 가 아니면 까닭 (한국어) */
  reason: string | null;
}

/** 봉 한 개 길이(분) = 첫 봉 구간 (그동안은 확인하지 않는다) */
const BAR_MIN = 30;
/** 평균에 쓰는 지난 거래일 수 상한 */
export const VOLUME_MAX_DAYS = 20;
/** 이보다 적은 날로는 견주지 않는다 */
export const VOLUME_MIN_DAYS = 5;

export const VOLUME_REASON = {
  closed: "정규장 시간이 아님",
  early: "개장 뒤 30분 전",
  zero: "지난 거래일 같은 시각 거래량이 0",
  unavailable: "30분봉을 받지 못함",
  budget: "시간 안에 30분봉을 받지 못함",
  short: (days: number) => `지난 거래일 30분봉이 ${days}일뿐이라 견줄 수 없음`,
} as const;

interface MarketRule {
  tz: string;
  hours: (date: string) => { open: number; close: number };
  trading: (date: string) => boolean;
}

function marketOf(code: string): MarketRule {
  if (isKrCode(code)) return { tz: "Asia/Seoul", hours: (d) => krRegularHours(d), trading: isKrTradingDate };
  return { tz: "America/New_York", hours: (d) => ({ open: 9 * 60 + 30, close: usRegularCloseMinutes(d) }), trading: isUsTradingDate };
}

/** 봉 시각(끝나는 시각) 글자 → 그 봉이 시작한 그 시장 현지 날짜·분 (못 읽으면 null) */
function barStartOf(iso: string | undefined, tz: string): { date: string; minutes: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : parts(new Date(t - BAR_MIN * 60_000), tz);
}

/** 봉을 받기 전에: 지금이 그 시장 정규장인지·개장 뒤 30분이 지났는지 (closed·early 면 봉을 받지 않는다) */
export function volumeWindow(code: string, now: Date): { state: "closed" | "early" | "open"; date: string | null; minutes: number | null } {
  const m = marketOf(code);
  const n = parts(now, m.tz);
  if (!m.trading(n.date)) return { state: "closed", date: null, minutes: null };
  const h = m.hours(n.date);
  if (n.minutes < h.open || n.minutes >= h.close) return { state: "closed", date: null, minutes: null };
  const elapsed = n.minutes - h.open;
  return { state: elapsed < BAR_MIN ? "early" : "open", date: n.date, minutes: elapsed };
}

/** ok 가 아닌 상태 한 줄 (부르는 쪽: 봉을 받지 못함·시간 예산 넘김) */
export function volumeNotOk(code: string, now: Date, status: Exclude<VolumeState, "ok">, reason: string, days = 0): VolumeStatus {
  const w = volumeWindow(code, now);
  const closed = w.state === "closed";
  return { code, status, date: closed ? null : w.date, volume: null, expected: null, ratio: null, days, minutes: closed ? null : w.minutes, asOf: seoulIso(now), reason };
}

/** 30분봉(오래된 → 최신, time = 봉이 끝나는 시각 ISO — 토스 dt)으로 상태. limit = 요청한 봉 개수(450) */
export function volumeStatus(code: string, candles: Candle[], now: Date, limit = 450): VolumeStatus {
  const w = volumeWindow(code, now);
  if (w.state === "closed") return volumeNotOk(code, now, "closed", VOLUME_REASON.closed);
  if (w.state === "early") return volumeNotOk(code, now, "early", VOLUME_REASON.early);
  const m = marketOf(code);
  const today = w.date!;
  const elapsed = w.minutes!;

  // 받은 봉이 한도만큼이면 맨 앞 날은 앞부분이 잘렸을 수 있어 뺀다 (오늘이면 빼지 않음).
  // 날짜는 봉 시작(time − 30분)의 그 시장 날짜로 본다 — date 칸은 출처 시각 글자의 앞 10자라 미국 봉이 서울 시각으로 적히면 다음 날이 된다
  let cut: string | null = null;
  if (candles.length >= limit) {
    const first = candles.map((b) => barStartOf(b.time, m.tz)).find((p) => p !== null);
    if (first && first.date !== today) cut = first.date;
  }

  // 정규장 봉만 날짜별로 (봉 시작의 개장 뒤 분 · 거래량)
  const byDate = new Map<string, { offset: number; volume: number }[]>();
  for (const b of candles) {
    const p = barStartOf(b.time, m.tz);
    if (!p || !m.trading(p.date)) continue;
    const h = m.hours(p.date);
    if (p.minutes < h.open || p.minutes >= h.close) continue;
    const list = byDate.get(p.date) ?? [];
    list.push({ offset: p.minutes - h.open, volume: Number.isFinite(b.volume) ? b.volume : 0 });
    byDate.set(p.date, list);
  }

  // 오늘: 지금 걸친 봉까지 받은 그대로
  const volume = (byDate.get(today) ?? []).filter((b) => b.offset < elapsed).reduce((s, b) => s + b.volume, 0);
  // 지난 날: 같은 경과 시간이 걸친 봉은 비율만큼 (거래 없는 30분 구간은 봉이 없어도 0)
  const past = [...byDate.keys()]
    .filter((d) => d < today && d !== cut)
    .sort()
    .reverse()
    .slice(0, VOLUME_MAX_DAYS);
  const days = past.length;
  if (days < VOLUME_MIN_DAYS) return volumeNotOk(code, now, "short", VOLUME_REASON.short(days), days);
  const cums = past.map((d) => byDate.get(d)!.reduce((s, b) => s + b.volume * Math.min(1, Math.max(0, (elapsed - b.offset) / BAR_MIN)), 0));
  const avg = cums.reduce((s, v) => s + v, 0) / days;
  if (!(avg > 0)) return volumeNotOk(code, now, "short", VOLUME_REASON.zero, days);
  return {
    code,
    status: "ok",
    date: today,
    volume,
    expected: Math.round(avg),
    ratio: Math.round((volume / avg) * 100) / 100,
    days,
    minutes: elapsed,
    asOf: seoulIso(now),
    reason: null,
  };
}
