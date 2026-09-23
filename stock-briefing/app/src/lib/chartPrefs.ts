import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { Candle, CandlePeriod } from "@/api/types";
import type { IndicatorKind } from "@/components/chart/PriceChart";

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
 * 바뀐 게 없으면 같은 배열을 돌려준다(리렌더 방지).
 */
export function applyTickToCandles(candles: Candle[], period: CandlePeriod, price: number, timestamp: string): Candle[] {
  const last = candles.at(-1);
  if (!last) return candles;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return candles;
  if (isIntraday(period)) {
    if (!last.time) return candles;
    const stepMin = period === "1m" ? 1 : period === "5m" ? 5 : 30;
    const local = shiftToOffset(timestamp, last.time.slice(19));
    if (!local) return candles;
    const minute = Number(local.slice(14, 16));
    const bucket = `${local.slice(0, 14)}${String(Math.floor(minute / stepMin) * stepMin).padStart(2, "0")}:00${last.time.slice(19)}`;
    if (bucket === last.time) return updateLast(candles, last, price);
    if (Date.parse(bucket) > Date.parse(last.time)) return [...candles, { date: bucket.slice(0, 10), time: bucket, open: price, high: price, low: price, close: price, volume: 0 }];
    return candles;
  }
  // 일·주·월봉: 체결 날짜(현지)가 마지막 봉 날짜 이후면 마지막 봉을 갱신. 하루가 바뀌는 순간 새 일봉을 붙인다
  const day = timestamp.slice(0, 10);
  if (day < last.date) return candles;
  if (period === "D" && day > last.date) return [...candles, { date: day, open: price, high: price, low: price, close: price, volume: 0 }];
  return updateLast(candles, last, price);
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
