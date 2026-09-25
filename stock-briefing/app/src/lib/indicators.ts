/**
 * 차트용 보조지표. 전부 순수 함수이고 입력은 오래된 순 배열, 출력은 같은 길이(계산 불가 구간은 null).
 * 서버의 analysis/indicators.ts 와 같은 정의(RSI 는 Wilder 평활, MACD 12·26·9, 볼린저 20·2σ)를 쓴다.
 */

export type Series = (number | null)[];

/** 단순 이동평균. 앞쪽 period-1 개는 null */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 지수 이동평균. 첫 값은 앞 period 개의 단순평균으로 시작 */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI (Wilder). 0~100 */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

/** 서버 toRsi 와 같다: 내린 폭이 0 이면 100, 오른 폭도 0 이면(가격 변동 없음 — 거래정지 등) 과매수가 아니라 중립 50 (BH-56) */
function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface Macd {
  macd: Series;
  signal: Series;
  hist: Series;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const f = ema(values, fast), s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  // 시그널은 macd 가 있는 구간만으로 EMA
  const firstIdx = line.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const sub = ema(line.slice(firstIdx).map((v) => v ?? 0), signalPeriod);
    for (let i = 0; i < sub.length; i++) signal[firstIdx + i] = sub[i];
  }
  const hist: Series = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i]! : null));
  return { macd: line, signal, hist };
}

export interface Bollinger {
  mid: Series;
  upper: Series;
  lower: Series;
}

export function bollinger(values: number[], period = 20, k = 2): Bollinger {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]!;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j]! - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/** 축 눈금: [min,max] 를 보기 좋은 간격으로 n 개 안팎 나눈다 */
export function niceTicks(min: number, max: number, n = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
