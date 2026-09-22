import type { Candle } from "../domain/types.js";

/**
 * 기술적 지표. 외부 라이브러리 없이 직접 구현한다.
 * 모든 함수는 입력 배열과 같은 길이의 배열을 돌려주고, 계산 불가 구간은 null 로 채운다.
 */

export function sma(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  // 첫 EMA 는 SMA 로 시작
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder 방식 RSI (기본 14). */
export function rsi(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdPoint {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdPoint[] {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const macdLine: Array<number | null> = values.map((_, i) =>
    f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null,
  );
  // signal 은 macd 가 정의된 구간에서만 EMA
  const firstIdx = macdLine.findIndex((v) => v !== null);
  const signal: Array<number | null> = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const defined = macdLine.slice(firstIdx) as number[];
    const sig = ema(defined, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstIdx + i] = sig[i]!;
  }
  return values.map((_, i) => ({
    macd: macdLine[i]!,
    signal: signal[i]!,
    histogram: macdLine[i] !== null && signal[i] !== null ? (macdLine[i] as number) - (signal[i] as number) : null,
  }));
}

export interface BollingerPoint {
  middle: number | null;
  upper: number | null;
  lower: number | null;
  /** (price - lower) / (upper - lower). 0 = 하단, 1 = 상단 */
  percentB: number | null;
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerPoint[] {
  const mid = sma(values, period);
  return values.map((v, i) => {
    const m = mid[i] ?? null;
    if (m === null) return { middle: null, upper: null, lower: null, percentB: null };
    const window = values.slice(i - period + 1, i + 1);
    const variance = window.reduce((acc, x) => acc + (x - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = m + mult * sd;
    const lower = m - mult * sd;
    return { middle: m, upper, lower, percentB: upper === lower ? null : (v - lower) / (upper - lower) };
  });
}

/**
 * 단순 피벗 기반 지지/저항 후보.
 * 좌우 `span` 개 봉보다 높은 고가 = 저항 후보, 낮은 저가 = 지지 후보. 현재가 기준으로 가장 가까운 것부터 반환.
 */
export function supportResistance(
  candles: Candle[],
  span = 5,
  maxEach = 3,
): { support: number[]; resistance: number[] } {
  const n = candles.length;
  if (n === 0) return { support: [], resistance: [] };
  const last = candles[n - 1]!.close;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = span; i < n - span; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= c.high) isHigh = false;
      if (candles[j]!.low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(c.high);
    if (isLow) lows.push(c.low);
  }
  const resistance = [...new Set(highs.filter((h) => h > last))].sort((a, b) => a - b).slice(0, maxEach);
  const support = [...new Set(lows.filter((l) => l < last))].sort((a, b) => b - a).slice(0, maxEach);
  return { support, resistance };
}

export type MaAlignment = "정배열" | "역배열" | "혼조";

export interface TechnicalSummary {
  asOfDate: string;
  close: number;
  ma: { ma5: number | null; ma20: number | null; ma60: number | null; ma120: number | null };
  maAlignment: MaAlignment;
  priceVsMa: { above5: boolean | null; above20: boolean | null; above60: boolean | null; above120: boolean | null };
  rsi14: number | null;
  rsiZone: "과매수" | "중립" | "과매도" | null;
  macd: MacdPoint;
  macdCross: "골든크로스 근접/발생" | "데드크로스 근접/발생" | "없음" | null;
  bollinger: BollingerPoint;
  supportResistance: { support: number[]; resistance: number[] };
  volume: { last: number; avg20: number | null; ratioToAvg20: number | null };
  returns: { d1: number | null; d5: number | null; d20: number | null; d60: number | null };
  range: { high20: number | null; low20: number | null; high60: number | null; low60: number | null };
  candleCount: number;
}

function r2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

function pctChange(values: number[], lookback: number): number | null {
  const n = values.length;
  if (n <= lookback) return null;
  const prev = values[n - 1 - lookback]!;
  return prev === 0 ? null : r2(((values[n - 1]! - prev) / prev) * 100);
}

/** 브리핑/분석 프롬프트에 넣을 기술적 지표 요약. 일봉 배열(오래된 → 최신)을 받는다. */
export function computeTechnicalSummary(candles: Candle[]): TechnicalSummary | null {
  if (candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const n = closes.length;
  const last = n - 1;
  const at = (arr: Array<number | null>) => arr[last] ?? null;

  const ma5 = at(sma(closes, 5)), ma20 = at(sma(closes, 20)), ma60 = at(sma(closes, 60)), ma120 = at(sma(closes, 120));
  const close = closes[last]!;
  const rsiV = at(rsi(closes, 14));
  const macdSeries = macd(closes);
  const m = macdSeries[last]!;
  const mPrev = macdSeries[last - 1]!;
  const bb = bollinger(closes)[last]!;
  const avg20 = at(sma(vols, 20));

  const defined = [ma5, ma20, ma60, ma120].filter((x): x is number => x !== null);
  let maAlignment: MaAlignment = "혼조";
  if (defined.length >= 3) {
    const asc = defined.every((v, i) => i === 0 || defined[i - 1]! >= v);
    const desc = defined.every((v, i) => i === 0 || defined[i - 1]! <= v);
    if (asc && close >= defined[0]!) maAlignment = "정배열";
    else if (desc && close <= defined[0]!) maAlignment = "역배열";
  }

  let macdCross: TechnicalSummary["macdCross"] = null;
  if (m.histogram !== null && mPrev.histogram !== null) {
    if (mPrev.histogram <= 0 && m.histogram > 0) macdCross = "골든크로스 근접/발생";
    else if (mPrev.histogram >= 0 && m.histogram < 0) macdCross = "데드크로스 근접/발생";
    else macdCross = "없음";
  }

  const window = (k: number) => candles.slice(Math.max(0, n - k));
  const hi = (k: number) => (n >= 2 ? Math.max(...window(k).map((c) => c.high)) : null);
  const lo = (k: number) => (n >= 2 ? Math.min(...window(k).map((c) => c.low)) : null);

  return {
    asOfDate: candles[last]!.date,
    close,
    ma: { ma5: r2(ma5), ma20: r2(ma20), ma60: r2(ma60), ma120: r2(ma120) },
    maAlignment,
    priceVsMa: {
      above5: ma5 === null ? null : close > ma5,
      above20: ma20 === null ? null : close > ma20,
      above60: ma60 === null ? null : close > ma60,
      above120: ma120 === null ? null : close > ma120,
    },
    rsi14: r2(rsiV),
    rsiZone: rsiV === null ? null : rsiV >= 70 ? "과매수" : rsiV <= 30 ? "과매도" : "중립",
    macd: { macd: r2(m.macd), signal: r2(m.signal), histogram: r2(m.histogram) },
    macdCross,
    bollinger: { middle: r2(bb.middle), upper: r2(bb.upper), lower: r2(bb.lower), percentB: r2(bb.percentB) },
    supportResistance: supportResistance(candles.slice(-120)),
    volume: {
      last: vols[last]!,
      avg20: r2(avg20),
      ratioToAvg20: avg20 ? r2(vols[last]! / avg20) : null,
    },
    returns: { d1: pctChange(closes, 1), d5: pctChange(closes, 5), d20: pctChange(closes, 20), d60: pctChange(closes, 60) },
    range: { high20: hi(20), low20: lo(20), high60: hi(60), low60: lo(60) },
    candleCount: n,
  };
}
