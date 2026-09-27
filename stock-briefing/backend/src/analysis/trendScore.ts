/**
 * 추세 지표 점수 (3-44 지표 점수 1단계, 계산 방식 TREND-1 · 보정 상수 TREND-CAL-1). 순수 함수 — 네트워크·시계·상태 없음.
 * 식은 docs/설계/추세지표-계산.md. 설계 단계의 기준 구현(trend-score.mjs)을 그대로 옮겼고, 같은 봉에서 같은 값을 내는지 테스트가 본다
 * (test/trendScore.test.ts, 기록된 야후 공개 일봉 13종목). 설계서와 다르게 고친 곳은 두 곳이다:
 *  - 띠는 반올림한 정수로 정한다 (69.6 → 70 → '강함' — 글자와 숫자가 어긋나지 않게)
 *  - 랜덤워크 척도 h 는 반올림한 표 값(66.17 등)이 아니라 정확한 식으로 (기준 구현도 식으로 계산한다)
 *
 * 입력: 끝난 정규장 일봉(오래된 → 최신, 분할 반영, 배당 미반영)과 비교 지수 일봉. 최근 300봉만 쓴다 (출처마다 받을 수 있는 길이가 달라도 같은 점수).
 * 출력: 그날 점수(0~100, 50 = 뚜렷한 추세 없음)와 묶음·항목 점수·원값, 또는 판단 불가·보류와 그 까닭(코드).
 * 이 점수는 지금 숫자 상태의 요약이다 — 과거 점검에서 이후 수익과의 관계는 우연과 구별하기 어려울 만큼 약했다(설계서 12장)
 */

export const TREND_VERSION = "TREND-1";

/** 보정 상수 (2017-09 ~ 2021-12, 157종목 31,554개 종목-날짜에서 c = |z| 90번째 백분위 / ln 9). 바꾸면 버전을 올린다 */
export const TREND_CAL = {
  version: "TREND-CAL-1",
  c: { T1: 0.707, T2: 0.731, T3: 0.689, T4: 0.762, M1: 0.811, M2: 0.702, M3: 0.722, M4: 0.667, V1: 0.255, V2: 0.128 },
} as const;

export const TREND_PARAMS = {
  /** 이보다 짧으면 판단 불가 (200일선이 없으면 추세 묶음을 못 만든다) */
  minBars: 200,
  /** 모든 항목 계산에 필요한 봉 수 (12개월−1개월 모멘텀: t−252) */
  fullBars: 253,
  /** 쓰는 봉 수 (최근 것만) */
  useBars: 300,
  /** 일간 변동성 바닥 (0.4%) — 저변동 종목의 z 값 폭주 방지 */
  volFloorDaily: 0.004,
  /** 초과수익 변동성 바닥 (0.3%) */
  teFloorDaily: 0.003,
  /** 묶음 안 쓸 수 있는 비중 합이 이보다 작으면 그 묶음은 빠진다 */
  familyMinCoverage: 0.5,
  /** 전체 쓸 수 있는 비중 합이 이보다 작으면 판단 불가 */
  totalMinCoverage: 0.7,
  /** 비교 지수 마지막 날보다 이만큼(달력일) 넘게 늦으면 판단 불가 (거래정지 등) */
  staleCalendarDays: 7,
  /** 화면 점수 = 최근 이만큼 거래일 그날 점수의 평균 */
  averageDays: 5,
} as const;

export type FamilyKey = "T" | "M" | "O" | "R" | "V";
export type ItemKey = "T1" | "T2" | "T3" | "T4" | "M1" | "M2" | "M3" | "M4" | "O1" | "O2" | "O3" | "R1" | "R2" | "R3" | "V1" | "V2";

/** 묶음 가중치(합 100)와 묶음 안 비중(합 1) — 설계값, 과거 수익률로 고르지 않았다 */
export const TREND_WEIGHTS: Record<FamilyKey, { w: number; subs: Partial<Record<ItemKey, number>> }> = {
  T: { w: 35, subs: { T1: 0.35, T2: 0.2, T3: 0.25, T4: 0.2 } },
  M: { w: 35, subs: { M1: 0.3, M2: 0.25, M3: 0.15, M4: 0.3 } },
  O: { w: 10, subs: { O1: 0.4, O2: 0.3, O3: 0.3 } },
  R: { w: 10, subs: { R1: 0.35, R2: 0.35, R3: 0.3 } },
  V: { w: 10, subs: { V1: 0.6, V2: 0.4 } },
};
export const FAMILY_KEYS: readonly FamilyKey[] = ["T", "M", "O", "R", "V"];

/** 단기 균형 종 모양 경계 [a0, a1, b1, b0]: a0 이하 0점, a1~b1 100점, b0 이상 0점, 사이는 직선 */
export const TREND_BELL = {
  O1: [20, 40, 65, 85], // RSI(14)
  O2: [-0.3, 0.2, 0.85, 1.3], // 볼린저 %B(20, 2)
  O3: [-2.5, -1.0, 1.2, 2.6], // 50일선 거리 z
} as const satisfies Record<string, readonly [number, number, number, number]>;
/** 가격 안정성: 변동성 연 15% 이하 100점 ~ 90% 이상 0점, 1년 최대 낙폭 60% 이상 0점 */
export const TREND_RISK = { volLo: 0.15, volHi: 0.9, mddZero: 0.6 } as const;

export interface TrendCandle {
  date: string;
  open: number;
  close: number;
  volume?: number | null;
}
export interface BenchPoint {
  date: string;
  close: number;
}

/** 판단 불가·보류 까닭 (화면 문장은 indicatorScoreText 가 만든다) */
export type TrendReason =
  | { code: "short"; bars: number }
  | { code: "stale"; lastDate: string; refDate: string }
  | { code: "split"; date: string; ratio: number }
  | { code: "flat"; pct: number }
  | { code: "thin" }
  | { code: "coverage"; pct: number };

/** 계산은 했지만 빠진 것 */
export type TrendNote = { code: "noBench" } | { code: "noVolume" } | { code: "shortYear"; bars: number };

export interface TrendRaw {
  T1: number;
  T2: number;
  T3: number;
  T4?: number;
  M1?: number;
  M2: number;
  M3: number;
  /** 지수 대비: 기간별 종목·지수 로그수익 (m12 = 12개월−1개월, m6 = 6개월−1개월) */
  M4?: { m12?: { stock: number; bench: number }; m6?: { stock: number; bench: number } };
  O1: number | null;
  O2: number | null;
  O3: number;
  R1: number;
  R2: number;
  R3: number;
  V1?: number;
  V2?: { advRatio: number; z20: number };
}

export interface FamilyScore {
  score: number | null;
  coverage: number;
}

export interface TrendOk {
  status: "ok";
  asOf: string;
  bars: number;
  score: number;
  coverage: number;
  families: Record<FamilyKey, FamilyScore>;
  subs: Partial<Record<ItemKey, number>>;
  x: Partial<Record<ItemKey, number>>;
  raw: TrendRaw;
  notes: TrendNote[];
}
export interface TrendFail {
  status: "unavailable" | "hold";
  reason: TrendReason;
}
export type TrendDayResult = TrendOk | TrendFail;

/** 화면 점수 (최근 5거래일 평균). 묶음·항목 점수도 같은 날들의 평균, 원값(raw)은 오늘 값 */
export interface TrendShown extends TrendOk {
  scoreToday: number;
  subsToday: Partial<Record<ItemKey, number>>;
  daysAveraged: number;
}
export type TrendResult = TrendShown | TrendFail;

// ── 기본 계산 ───────────────────────────────────────────────
const ln = Math.log;
export const logistic = (x: number, c: number): number => 100 / (1 + Math.exp(-x / c));
export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
export function bell(x: number, [a0, a1, b1, b0]: readonly [number, number, number, number]): number {
  if (x <= a0 || x >= b0) return 0;
  if (x < a1) return (100 * (x - a0)) / (a1 - a0);
  if (x <= b1) return 100;
  return (100 * (b0 - x)) / (b0 - b1);
}
function mean(a: readonly number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}
/** 표본표준편차 (n−1) */
function sd(a: readonly number[]): number {
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}
/** closes[i] 에서 끝나는 n 개 산술평균 */
function smaAt(closes: readonly number[], i: number, n: number): number | null {
  if (i - n + 1 < 0) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += closes[k]!;
  return s / n;
}

/** Wilder RSI (analysis/indicators.ts rsi 와 같은 정의) — 마지막 값 */
export function rsiLast(values: readonly number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

/** 볼린저 %B (analysis/indicators.ts bollinger 와 같은 정의: 모표준편차) — 마지막 값 */
export function percentBLast(values: readonly number[], period = 20, mult = 2): number | null {
  const n = values.length;
  if (n < period) return null;
  const w = values.slice(n - period);
  const m = mean(w);
  const v = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / period);
  if (v === 0) return null;
  return (values[n - 1]! - (m - mult * v)) / (2 * mult * v);
}

// ── 랜덤워크 기준 척도 h: x = 원값 / (σ·√h) 가 '추세 없음'에서 표준정규에 가깝게 ──────
/** 로그가격 선형결합 Σ a_j lnC_{t−j} (Σa = 0) 의 분산 / σ² = Σ_k (Σ_{j≤k} a_j)² */
function hOf(a: readonly number[]): number {
  let acc = 0;
  let s = 0;
  for (let k = 0; k < a.length - 1; k++) {
    acc += a[k]!;
    s += acc * acc;
  }
  return s;
}
function smaWeights(n: number, lag: number, len: number): number[] {
  const a = new Array<number>(len).fill(0);
  for (let j = lag; j < lag + n; j++) a[j]! += 1 / n;
  return a;
}
const minus = (a: number[], b: number[]) => a.map((v, i) => v - (b[i] ?? 0));
function unit(len: number): number[] {
  const a = new Array<number>(len).fill(0);
  a[0] = 1;
  return a;
}
export const TREND_H = {
  T1: hOf(minus(unit(201), smaWeights(200, 0, 201))), // ln(C/SMA200) = (n−1)(2n−1)/(6n) ≈ 66.17
  T2: hOf(minus(unit(51), smaWeights(50, 0, 51))), // ln(C/SMA50) ≈ 16.17
  T3: hOf(minus(smaWeights(50, 0, 201), smaWeights(200, 0, 201))), // ln(SMA50/SMA200) ≈ 37.5
  T4: hOf(minus(smaWeights(200, 0, 222), smaWeights(200, 21, 222))), // ln(SMA200_t/SMA200_{t−21}) ≈ 2.13
  M1: 231,
  M2: 105,
  M3: 42,
  O3: hOf(minus(unit(51), smaWeights(50, 0, 51))),
  V2ret: 20,
} as const;

// ── 비교 지수 맞추기 ─────────────────────────────────────────
/** 날짜 d 또는 그 이전 가장 가까운 지수 종가 (뒤 날짜는 절대 쓰지 않는다 — 미래 자료 섞임 방지) */
export function benchLookup(bench: readonly BenchPoint[]): (d: string) => BenchPoint | null {
  const dates = bench.map((c) => c.date);
  return (d) => {
    let lo = 0;
    let hi = dates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid]! <= d) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans < 0 ? null : bench[ans]!;
  };
}

const SPLIT_RATIOS = [2, 3, 4, 5, 8, 10, 15, 20, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 8, 1 / 10, 1 / 15, 1 / 20];
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const ITEMS_LOGISTIC = ["T1", "T2", "T3", "T4", "M1", "M2", "M3", "M4", "V1", "V2"] as const;

export interface TrendOptions {
  /** 비교 지수가 없을 때 거래정지를 가리는 기준 날짜 (그 시장의 최근 거래일) */
  expectedLast?: string | null;
}

/**
 * 그날 점수 (봉 t 까지). candlesIn 은 끝난 정규장 일봉(오래된 → 최신), bench 는 비교 지수 일봉(없으면 지수 대비 항목 M4 가 빠진다).
 * 위에서부터 점검해 걸리면 멈춘다: 기록 200봉 미만 → 지수보다 7일 넘게 늦음 → 분할 의심(보류) → 최근 63일 30% 넘게 가격 변화 없음
 */
export function trendDay(candlesIn: readonly TrendCandle[], bench: readonly BenchPoint[] | null, opt: TrendOptions = {}): TrendDayResult {
  const candles = candlesIn.filter((c) => Number.isFinite(c.close) && c.close > 0).slice(-TREND_PARAMS.useBars);
  const n = candles.length;
  const notes: TrendNote[] = [];
  if (n < TREND_PARAMS.minBars) return { status: "unavailable", reason: { code: "short", bars: n } };
  const t = n - 1;
  const C = candles.map((c) => c.close);
  const V = candles.map((c) => c.volume ?? 0);
  const asOfDate = candles[t]!.date;
  const refDate = bench?.length ? bench[bench.length - 1]!.date : (opt.expectedLast ?? null);
  if (refDate && daysBetween(asOfDate, refDate) > TREND_PARAMS.staleCalendarDays) return { status: "unavailable", reason: { code: "stale", lastDate: asOfDate, refDate } };

  const r: number[] = [];
  for (let i = 1; i < n; i++) r.push(ln(C[i]! / C[i - 1]!)); // r[i−1] = ln(C_i/C_{i−1})
  // 분할·병합 미반영 의심: 최근 253봉 안 하루 비율이 분할 비율과 1% 안으로 같고, 시가도 그 비율로 벌어짐
  for (let i = Math.max(1, n - 253); i < n; i++) {
    const ratio = C[i]! / C[i - 1]!;
    const gap = candles[i]!.open / C[i - 1]!;
    if (SPLIT_RATIOS.some((s) => Math.abs(ratio / s - 1) < 0.01 && Math.abs(gap / s - 1) < 0.03)) return { status: "hold", reason: { code: "split", date: candles[i]!.date, ratio } };
  }
  const last63 = r.slice(-63);
  const flat = last63.filter((x) => x === 0).length / last63.length;
  if (flat > 0.3) return { status: "unavailable", reason: { code: "flat", pct: Math.round(flat * 100) } };

  const sigS = Math.max(sd(r.slice(-63)), TREND_PARAMS.volFloorDaily); // 짧은 창 변동성 (3개월)
  const sigL = Math.max(sd(r.slice(-252)), TREND_PARAMS.volFloorDaily); // 긴 창 변동성 (1년, 모자라면 있는 만큼)
  const s200 = smaAt(C, t, 200)!;
  const s50 = smaAt(C, t, 50)!;
  const s200p = n >= 221 ? smaAt(C, t - 21, 200) : null;
  const at = (k: number): number | null => (t - k >= 0 ? C[t - k]! : null);
  const x: Partial<Record<ItemKey, number>> = {};
  const s: Partial<Record<ItemKey, number>> = {};

  // T 추세
  const T1 = ln(C[t]! / s200);
  x.T1 = T1 / (sigL * Math.sqrt(TREND_H.T1));
  const T2 = ln(C[t]! / s50);
  x.T2 = T2 / (sigS * Math.sqrt(TREND_H.T2));
  const T3 = ln(s50 / s200);
  x.T3 = T3 / (sigL * Math.sqrt(TREND_H.T3));
  let T4: number | undefined;
  if (s200p) {
    T4 = ln(s200 / s200p);
    x.T4 = T4 / (sigL * Math.sqrt(TREND_H.T4));
  }
  // M 모멘텀 (최근 1개월 = 21봉 제외)
  const c21 = at(21)!;
  let M1: number | undefined;
  const c252 = at(252);
  if (c252 !== null) {
    M1 = ln(c21 / c252);
    x.M1 = M1 / (sigL * Math.sqrt(TREND_H.M1));
  }
  const M2 = ln(c21 / at(126)!);
  x.M2 = M2 / (sigL * Math.sqrt(TREND_H.M2));
  const M3 = ln(c21 / at(63)!);
  x.M3 = M3 / (sigS * Math.sqrt(TREND_H.M3));
  // M4 지수 대비 상대강도
  let M4: TrendRaw["M4"];
  if (bench?.length) {
    const B = benchLookup(bench);
    const bAt = (k: number) => (t - k >= 0 ? B(candles[t - k]!.date) : null);
    // 초과 일간수익 (종목 날짜 기준으로 지수를 맞춤) — 최근 63개
    const ex: number[] = [];
    for (let i = n - 63; i < n; i++) {
      const b1 = B(candles[i]!.date);
      const b0 = B(candles[i - 1]!.date);
      if (b1 && b0) ex.push(ln(C[i]! / C[i - 1]!) - ln(b1.close / b0.close));
    }
    const sigTE = ex.length >= 40 ? Math.max(sd(ex), TREND_PARAMS.teFloorDaily) : null;
    const parts: number[] = [];
    const m4: NonNullable<TrendRaw["M4"]> = {};
    for (const L of [252, 126]) {
      const b21 = bAt(21);
      const bL = bAt(L);
      const cL = at(L);
      if (cL === null || !b21 || !bL || !sigTE) continue;
      const stock = ln(c21 / cL);
      const idx = ln(b21.close / bL.close);
      m4[L === 252 ? "m12" : "m6"] = { stock, bench: idx };
      parts.push((stock - idx) / (sigTE * Math.sqrt(L - 21)));
    }
    if (parts.length) {
      x.M4 = mean(parts);
      M4 = m4;
    }
  } else notes.push({ code: "noBench" });
  // O 단기 균형
  const O1 = rsiLast(C.slice(-TREND_PARAMS.useBars), 14);
  const O2 = percentBLast(C, 20, 2);
  const O3 = ln(C[t]! / s50) / (sigS * Math.sqrt(TREND_H.O3));
  // R 가격 안정성
  const R1 = sigS * Math.sqrt(252);
  const w252 = C.slice(-252);
  const maxC = Math.max(...w252);
  const R2 = -ln(C[t]! / maxC); // 52주 최고 종가 대비 로그 낙폭
  let peak = -Infinity;
  let R3 = 0;
  for (const c of w252) {
    peak = Math.max(peak, c);
    R3 = Math.max(R3, 1 - c / peak);
  }
  // V 거래량 뒷받침
  let V1: number | undefined;
  let V2: TrendRaw["V2"];
  const v120 = V.slice(-120);
  const volOk = v120.filter((v) => !(v > 0)).length / v120.length <= 0.1;
  if (volOk) {
    let up = 0;
    let dn = 0;
    for (let i = n - 50; i < n; i++) {
      const d = C[i]! - C[i - 1]!;
      if (d > 0) up += V[i]!;
      else if (d < 0) dn += V[i]!;
    }
    if (up + dn > 0) {
      V1 = up / Math.max(dn, 1e-9);
      x.V1 = Math.max(-2, Math.min(2, ln(Math.max(up, 1e-9) / Math.max(dn, 1e-9))));
    }
    const adv20 = mean(V.slice(-20));
    const adv120 = mean(v120);
    if (adv20 > 0 && adv120 > 0) {
      const z20 = ln(C[t]! / C[t - 20]!) / (sigS * Math.sqrt(TREND_H.V2ret));
      V2 = { advRatio: adv20 / adv120, z20 };
      x.V2 = ln(adv20 / adv120) * Math.tanh(z20);
    }
  } else notes.push({ code: "noVolume" });

  // 점수화
  for (const k of ITEMS_LOGISTIC) {
    const v = x[k];
    if (v !== undefined && Number.isFinite(v)) s[k] = logistic(v, TREND_CAL.c[k]);
  }
  if (O1 !== null) s.O1 = bell(O1, TREND_BELL.O1);
  if (O2 !== null) s.O2 = bell(O2, TREND_BELL.O2);
  s.O3 = bell(O3, TREND_BELL.O3);
  s.R1 = 100 * clamp01((ln(TREND_RISK.volHi) - ln(R1)) / (ln(TREND_RISK.volHi) - ln(TREND_RISK.volLo)));
  s.R2 = 100 * clamp01(1 - R2 / (sigL * Math.sqrt(252)));
  s.R3 = 100 * clamp01(1 - R3 / TREND_RISK.mddZero);

  const families = {} as Record<FamilyKey, FamilyScore>;
  let tw = 0;
  let tsum = 0;
  for (const f of FAMILY_KEYS) {
    const { w, subs } = TREND_WEIGHTS[f];
    let cw = 0;
    let cs = 0;
    for (const [k, wk] of Object.entries(subs) as Array<[ItemKey, number]>) {
      const v = s[k];
      if (v !== undefined) {
        cw += wk;
        cs += wk * v;
      }
    }
    const available = cw >= TREND_PARAMS.familyMinCoverage;
    families[f] = { score: available ? cs / cw : null, coverage: cw };
    if (available) {
      tw += w;
      tsum += w * (cs / cw);
    }
  }
  if (families.T.score === null || families.M.score === null) return { status: "unavailable", reason: { code: "thin" } };
  if (tw / 100 < TREND_PARAMS.totalMinCoverage) return { status: "unavailable", reason: { code: "coverage", pct: Math.round(tw) } };
  if (n < TREND_PARAMS.fullBars) notes.push({ code: "shortYear", bars: n });
  const raw: TrendRaw = { T1, T2, T3, M2, M3, O1, O2, O3, R1, R2, R3 };
  if (T4 !== undefined) raw.T4 = T4;
  if (M1 !== undefined) raw.M1 = M1;
  if (M4 !== undefined) raw.M4 = M4;
  if (V1 !== undefined) raw.V1 = V1;
  if (V2 !== undefined) raw.V2 = V2;
  return { status: "ok", asOf: asOfDate, bars: n, score: tsum / tw, coverage: tw / 100, families, subs: s, x, raw, notes };
}

/**
 * 화면에 내는 점수 = 최근 5거래일(오늘 포함) 그날 점수의 평균. 같은 봉으로 언제든 다시 계산된다(상태 저장 없음).
 * 오늘 점수가 판단 불가면 판단 불가. 앞의 날이 판단 불가면(기록 200~203일) 계산된 날만 평균. 지수도 그날까지로 자른다
 */
export function trendDisplayed(candles: readonly TrendCandle[], bench: readonly BenchPoint[] | null, opt: TrendOptions = {}): TrendResult {
  const today = trendDay(candles, bench, opt);
  if (today.status !== "ok") return today;
  const days: TrendOk[] = [today];
  for (let k = 1; k < TREND_PARAMS.averageDays; k++) {
    const cut = candles.slice(0, candles.length - k);
    const lastDate = cut[cut.length - 1]?.date;
    if (!lastDate) break;
    const b = bench ? bench.filter((c) => c.date <= lastDate) : null;
    const r = trendDay(cut, b, { expectedLast: null });
    if (r.status === "ok") days.push(r);
  }
  const avg = (f: (d: TrendOk) => number | null | undefined): number | null => {
    const v = days.map(f).filter((x): x is number => x !== null && x !== undefined);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const families = {} as Record<FamilyKey, FamilyScore>;
  for (const f of FAMILY_KEYS) families[f] = { score: avg((d) => d.families[f].score), coverage: today.families[f].coverage };
  const subs: Partial<Record<ItemKey, number>> = {};
  for (const k of Object.keys(today.subs) as ItemKey[]) {
    const v = avg((d) => d.subs[k]);
    if (v !== null) subs[k] = v;
  }
  return { ...today, score: avg((d) => d.score)!, scoreToday: today.score, families, subs, subsToday: today.subs, daysAveraged: days.length };
}

export type TrendBand = "강함" | "다소 강함" | "중립" | "다소 약함" | "약함";

/** 화면에 보이는 정수 (반올림) */
export const shownScore = (score: number): number => Math.round(score);

/** 점수 → 띠 이름. 반올림한 정수로 정한다 (69.6 → 70 → 강함) */
export function trendBand(score: number | null | undefined): TrendBand | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const v = shownScore(score);
  if (v >= 70) return "강함";
  if (v >= 55) return "다소 강함";
  if (v >= 45) return "중립";
  if (v >= 30) return "다소 약함";
  return "약함";
}
