import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { Candle, CandlePeriod } from "@/api/types";
import type { IndicatorKind } from "@/components/chart/PriceChart";
import { inTradingHours, marketClock, periodKey, tradingDate } from "./marketTime";

/** 차트 설정(이평선·볼린저·거래량·보조지표)은 종목과 화면(인라인/전체)에 상관없이 하나로 기억한다 */
export interface ChartPrefs {
  maPeriods: number[];
  bollinger: boolean;
  volume: boolean;
  indicator: IndicatorKind;
}

const KEY = "chartPrefs.v1";
const DEFAULT: ChartPrefs = { maPeriods: [5, 20, 60, 120], bollinger: false, volume: true, indicator: "none" };
let cached: ChartPrefs | null = null;
const listeners = new Set<(p: ChartPrefs) => void>();

export function useChartPrefs(): [ChartPrefs, (patch: Partial<ChartPrefs>) => void] {
  const [prefs, setPrefs] = useState<ChartPrefs>(cached ?? DEFAULT);
  useEffect(() => {
    listeners.add(setPrefs);
    if (!cached) {
      AsyncStorage.getItem(KEY)
        .then((raw) => {
          if (!raw) return;
          const parsed = { ...DEFAULT, ...(JSON.parse(raw) as Partial<ChartPrefs>) };
          cached = parsed;
          for (const l of listeners) l(parsed);
        })
        .catch(() => undefined);
    }
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);
  const update = useCallback((patch: Partial<ChartPrefs>) => {
    const next = { ...(cached ?? DEFAULT), ...patch };
    cached = next;
    for (const l of listeners) l(next);
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);
  return [prefs, update];
}

export const PERIOD_OPTIONS: { value: CandlePeriod; label: string }[] = [
  { value: "1m", label: "1분" },
  { value: "5m", label: "5분" },
  { value: "30m", label: "30분" },
  { value: "D", label: "일" },
  { value: "W", label: "주" },
  { value: "M", label: "월" },
];

/** 서버에 요청할 봉 수 (과거 이동과 120 이평선을 위해 넉넉히) */
export const CANDLE_COUNT: Record<CandlePeriod, number> = { "1m": 600, "5m": 400, "30m": 300, D: 800, W: 260, M: 120 };

/** 기간 칩: 처음 보이는 봉 수 후보 */
export const WINDOWS: Record<CandlePeriod, number[]> = {
  "1m": [60, 120, 390],
  "5m": [78, 156, 390],
  "30m": [60, 130, 260],
  D: [60, 120, 250],
  W: [52, 104, 260],
  M: [36, 60, 120],
};

export const UNIT: Record<CandlePeriod, string> = { "1m": "봉", "5m": "봉", "30m": "봉", D: "일", W: "주", M: "월" };

export function isIntraday(period: CandlePeriod): boolean {
  return period === "1m" || period === "5m" || period === "30m";
}

/**
 * 실시간 체결을 봉 시계열에 반영한다. 마지막 봉과 같은 구간이면 고·저·종을 갱신하고, 새 구간이면 봉을 하나 붙인다.
 * 분봉은 시장 현지(한국 서울·미국 뉴욕, 서머타임 포함) 시각으로, 일·주·월봉은 거래일(lib/marketTime 의 tradingDate)로 나눈다 —
 * 미국 주간거래(뉴욕 20:00 이후) 체결은 토스·서버 봉처럼 다음 거래일 봉으로 간다 (PF-02·03).
 * 새로 붙인 봉은 거래량을 모른다(volumeUnknown) — 체결마다 거래량이 오지 않으니 더해서 만들지 않고, 서버 봉을 다시 받으면 채워진다 (PF-04).
 * 바뀐 게 없으면 같은 배열을 돌려준다(리렌더 방지).
 */
export function applyTickToCandles(candles: Candle[], period: CandlePeriod, price: number, timestamp: string, code: string): Candle[] {
  const last = candles.at(-1);
  if (!last) return candles;
  const clock = marketClock(timestamp, code);
  if (!clock) return candles;
  const newBar = (date: string, time?: string): Candle[] => [...candles, { date, ...(time ? { time } : {}), open: price, high: price, low: price, close: price, volume: 0, volumeUnknown: true }];
  if (isIntraday(period)) {
    if (!last.time) return candles;
    const lastAt = Date.parse(last.time);
    if (Number.isNaN(lastAt)) return candles;
    const stepMin = period === "1m" ? 1 : period === "5m" ? 5 : 30;
    // 봉 시각 표기는 서버 봉을 따른다: 서버 봉이 시장 현지 시각이면 체결 순간의 현지 오프셋(서머타임이 바뀌어도 맞게), 아니면 마지막 봉의 오프셋 그대로
    const lastOffset = last.time.slice(19);
    const offset = lastOffset === marketClock(last.time, code)?.offset ? clock.offset : lastOffset;
    const local = shiftToOffset(timestamp, offset);
    if (!local) return candles;
    const minute = Number(local.slice(14, 16));
    const bucket = `${local.slice(0, 14)}${String(Math.floor(minute / stepMin) * stepMin).padStart(2, "0")}:00${offset}`;
    const at = Date.parse(bucket);
    if (at === lastAt) return updateLast(candles, last, price);
    // 거래 시간 밖 체결(서버가 막 켜져 장 전·휴장일에 보낸 값 그대로의 체결 등)로는 새 분봉을 열지 않는다 — 서버 봉을 다시 받아도 마지막 체결을 다시 얹으므로(withLastTick) 빈 봉이 남지 않게
    if (at > lastAt) return inTradingHours(timestamp, code) ? newBar(bucket.slice(0, 10), bucket) : candles;
    return candles;
  }
  // 일·주·월봉: 체결의 거래일이 마지막 봉과 같은 구간(날·월요일 시작 주·월)이면 마지막 봉 갱신, 뒤 구간이면 지난 봉은 두고 새 봉
  const day = tradingDate(timestamp, code);
  if (!day) return candles;
  const key = periodKey(day, period);
  const lastKey = periodKey(last.date, period);
  if (key < lastKey) return candles;
  if (key === lastKey) return updateLast(candles, last, price);
  return newBar(day);
}

function updateLast(candles: Candle[], last: Candle, price: number): Candle[] {
  if (last.close === price && price <= last.high && price >= last.low) return candles;
  const next = { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) };
  return [...candles.slice(0, -1), next];
}

/** ISO 시각을 주어진 오프셋(+09:00 등)의 현지 표기 "YYYY-MM-DDTHH:MM" 으로 */
function shiftToOffset(iso: string, offset: string): string | null {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sign = m ? (m[1] === "-" ? -1 : 1) : 0;
  const mins = m ? sign * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(t + mins * 60_000).toISOString().slice(0, 16);
}
