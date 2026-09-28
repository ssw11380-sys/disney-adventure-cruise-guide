import type { MetricAux, MetricKey, MetricRule, MetricSet, MetricWhy } from "./valueMetrics.js";

/**
 * 가치 지표 점수 VALUE-1 (3-44 2단계) — 순위(백분위)·비교 섞기·묶음·상태. 순수 함수.
 * 식 (설계 value-v1 §7, 문서 docs/설계/가치지표-계산.md):
 *   p = 100 × (#{작음} + 0.5 × #{같음}) / N            비교 회사 값들 안에서 (대상 종목 자신은 뺀다)
 *   지표 점수 S = Σ w_k p_k / Σ w_k                      k ∈ 있는 비교(업종·시장·자기 지난 5년), 없는 비교는 남은 비교에 비례 배분
 *   묶음 점수 F = 값이 있는 지표의 화면 정수 round(S) 의 평균
 *   V = round( Σ W_f round(F_f) / Σ W_f )               f ∈ 유효한 묶음 — 화면에 보이는 정수로 한 단계씩 (손으로 다시 계산해도 맞게, 설계 §7.5)
 * 0점 규칙(적자 등)은 S = 0, 맨 위 규칙(순현금 등)은 같은 규칙 회사끼리 같은 순위. 가중치는 설계값이며 과거 수익률로 고르지 않았다
 */

export const VALUE_VERSION = "VALUE-1";
export type ValuePath = "general" | "financial";
export type ValueFamilyKey = "price" | "quality" | "health" | "growth" | "payout";
export const VALUE_FAMILIES: readonly ValueFamilyKey[] = ["price", "quality", "health", "growth", "payout"];

export const VALUE_WEIGHTS: Record<ValuePath, Record<ValueFamilyKey, number>> = {
  general: { price: 30, quality: 25, health: 20, growth: 15, payout: 10 },
  financial: { price: 35, quality: 30, health: 10, growth: 15, payout: 10 },
};
export const FAMILY_METRICS: Record<ValuePath, Record<ValueFamilyKey, readonly MetricKey[]>> = {
  general: {
    price: ["A1", "A2", "A3", "A4", "A5"],
    quality: ["B1", "B2", "B3", "B4", "B5", "B6"],
    health: ["D1", "D2", "D3", "D4"],
    growth: ["C1", "C2", "C3"],
    payout: ["E1", "E2"],
  },
  financial: {
    price: ["A1", "A3"],
    quality: ["B1", "F1", "F2"],
    health: ["F3"],
    growth: ["C1", "C2"],
    payout: ["E1", "E2"],
  },
};
/** 핵심 지표 (묶음을 계산하려면 이 가운데 하나는 있어야 함) */
export const CORE_METRICS: Record<ValuePath, Record<ValueFamilyKey, readonly MetricKey[]>> = {
  general: { price: ["A1", "A2"], quality: ["B1", "B2"], health: ["D1", "D2"], growth: ["C1"], payout: ["E1"] },
  // 금융사 성장은 매출(순영업수익)이나 주당이익 증가폭 가운데 하나 (은행 매출 태그가 고르지 않다)
  financial: { price: ["A3"], quality: ["B1"], health: ["F3"], growth: ["C1", "C2"], payout: ["E1"] },
};
export type CompareKey = "industry" | "market" | "own";
/** 세 가지 비교를 섞는 비율 (설계 §7.3) */
export const COMPARE_MIX: Record<ValueFamilyKey, Partial<Record<CompareKey, number>>> = {
  price: { industry: 50, market: 20, own: 30 },
  quality: { industry: 70, market: 30 },
  health: { industry: 50, market: 50 },
  growth: { industry: 60, market: 40 },
  payout: { industry: 50, market: 50 },
};
/** 업종 비교에 필요한 최소 회사 수 (못 미치면 부문 → 시장) */
export const MIN_PEERS = 15;
/**
 * 층을 바꾸는 것은 두 주 연속 조건이 바뀌었을 때만 (설계 §7.1·§11.1) — 지난주 층을 이번 주에 한 주 더 두는 동안에도
 * 그 층의 값이 이보다 적으면 두지 않는다 (업종이 갑자기 작아진 때)
 */
export const MIN_PEERS_HOLD = 10;
/** 층 글자 (비교 기준에 저장): 업종 · 부문 · 시장 */
export type LevelCode = "i" | "s" | "m";
/** 재무: 결산일이 이보다 오래되면 점수 없음 (대상 종목) · 비교 회사에서 뺀다 (18개월) */
export const FISCAL_STALE_DAYS = 548;
/** 한 지표를 쓰려면 그 시장 기준 모집단의 이 비율 이상에서 값이 있어야 함 */
export const MIN_ADOPTION = 0.7;
/** 점수를 내려면 유효한 묶음 비중 합이 이 이상 */
export const MIN_COVERAGE_WEIGHT = 70;
export const MIN_FAMILIES = 3;
/** 자기 지난 5년 비교: 월말 값이 이 개수 이상일 때만 */
export const OWN_MIN_MONTHS = 36;
export const OWN_MONTHS = 60;
/** 지난주 대비 바뀐 이유를 보이는 기준 (화면 정수 차이가 이보다 클 때) */
export const VALUE_CHANGE_MIN = 5;

export type ValueBand = "낮은 편" | "가운데쯤" | "높은 편";
/** 띠는 화면에 보이는 정수로 정한다 (여유 없음 — 숫자와 띠 글자가 어긋나지 않게) */
export function valueBand(shown: number): ValueBand {
  return shown >= 67 ? "높은 편" : shown >= 34 ? "가운데쯤" : "낮은 편";
}
/** 반올림 (0.5 는 올림) */
export const roundScore = (v: number) => Math.floor(v + 0.5);

// ── 백분위 ───────────────────────────────────────────────

/** sorted(오름차순) 에서 x 보다 작은 값의 수 */
function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function upperBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 백분위 p = 100 × (#{작음} + 0.5 × #{같음}) / N. self 가 있으면 그 값 하나를 모집단에서 뺀다 (대상 종목이 비교 회사 안에 있을 때).
 * 비교 값이 없으면 null
 */
export function percentile(x: number, sorted: readonly number[], self?: number | null): number | null {
  let less = lowerBound(sorted, x);
  let eq = upperBound(sorted, x) - less;
  let n = sorted.length;
  if (self !== undefined && self !== null && n > 0) {
    // 자기 값 하나 빼기 (정렬 배열에 있을 때만)
    const i = lowerBound(sorted, self);
    if (i < n && sorted[i] === self) {
      n -= 1;
      if (self < x) less -= 1;
      else if (self === x) eq -= 1;
    }
  }
  if (n <= 0) return null;
  return (100 * (less + 0.5 * eq)) / n;
}

/** 정렬된 값의 가운데값 (±Infinity 포함) */
export function medianOf(sorted: readonly number[]): number | null {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  if (sorted.length % 2) return sorted[m]!;
  const a = sorted[m - 1]!;
  const b = sorted[m]!;
  // 가운데 두 값에 규칙 값(±∞)이 끼면 평균을 낼 수 없어 위쪽 가운데값
  if (!Number.isFinite(a) || !Number.isFinite(b)) return b;
  return (a + b) / 2;
}

// ── 비교 기준 (주 1회 만드는 분포) ─────────────────────────────

/** 비교 회사 한 곳 (저장 모양) */
export interface PeerRow {
  /** CIK (10자리) */
  c: string;
  /** 티커 */
  t: string;
  /** 부문·업종 번호 (sectors·industries 배열 안) */
  s: number;
  i: number;
  /** 금융사 경로 */
  f: 0 | 1;
  /** 지표 순위용 값 (METRIC_ORDER 순서, ±1e300 = ±Infinity, null = 없음) */
  x: Array<number | null>;
}
export const METRIC_ORDER: readonly MetricKey[] = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "B6", "D1", "D2", "D3", "D4", "C1", "C2", "C3", "E1", "E2", "F1", "F2", "F3"];
const INF_STORE = 1e300;
export const encodeX = (x: number | null | undefined): number | null => (x === null || x === undefined || Number.isNaN(x) ? null : x === Infinity ? INF_STORE : x === -Infinity ? -INF_STORE : x);
export const decodeX = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v >= INF_STORE ? Infinity : v <= -INF_STORE ? -Infinity : v);

/** 시장 안 위치로 정하는 표시·규칙의 기준값 */
export interface ValueThresholds {
  /** 영업이익률 5년 표준편차 상위 30% 경계 (경기 민감) */
  opMarginStdP70: number | null;
  /** 최근 순이익 ÷ 5년 평균 상위 10% 경계 (경기 정점) */
  niToAvg5P90: number | null;
  /** 영업 외 손익 비율 상위 5% 경계 */
  nonOpP95: number | null;
  /** 주식보상 ÷ 매출 상위 10% 경계 */
  sbcP90: number | null;
  /** 자본 ÷ 총자산 하위 5% 경계 (작은 자본) */
  equityToAssetsP5: number | null;
  /** 이자보상배율 가운데값 (장부상 자본 음수 판정) */
  coverageP50: number | null;
  /** 유효세율 가운데값 (세전이익 ≤ 0 인 회사의 ROIC) */
  taxRateP50: number;
}

/** 주 1회 만드는 비교 기준 (value_references.data) */
export interface ValueReferenceData {
  v: 1;
  method: string;
  market: "US";
  refDate: string;
  /** Nasdaq 스크리너 받은 날 */
  screenerDate: string;
  /** 쓴 기간 이름 (SEC frames) */
  periods: { annual: string[]; latest: string[]; yearAgo: string[] };
  sectors: string[];
  industries: string[];
  /** 모든 스크리너 종목의 부문·업종 (시가총액 하위 20% 로 빠진 종목도 — 대상 종목 분류용) */
  symbols: Record<string, [number, number]>;
  peers: PeerRow[];
  thresholds: ValueThresholds;
  /** 경로마다 지표별 값이 있는 비율 (0~1) */
  coverage: Record<ValuePath, Partial<Record<MetricKey, number>>>;
  counts: { screener: number; mapped: number; withData: number; universe: number; general: number; financial: number };
  /** 받지 못한 기간·태그 (있으면) */
  missingFrames: string[];
  /**
   * 스크리너 시가총액·마지막 가격 (티커 → [시가총액 달러, 가격 달러], 둘 다 있는 줄만). 대상 종목의 SEC 주식 수가 지금 주식 수와
   * 크게 다른지(보고서 뒤 주식 분할·병합 등) 확인하는 데만 쓴다. 예전 기준에는 없다
   */
  quotes?: Record<string, [number, number]>;
  /**
   * 업종 자리 층 (주 1회, 설계 §7.1): 경로 → '부문|업종' → 이번 주 조건 23글자 + 쓰는 층 23글자 (METRIC_ORDER 순서, i·s·m).
   * 쓰는 층은 두 주 연속 조건이 바뀌었을 때만 바뀐다. 예전 기준에는 없다 (그때는 그 자리에서 정함)
   */
  levels?: Record<ValuePath, Record<string, string>>;
}

export type PeerLevel = "industry" | "sector" | "market";
export interface PeerDist {
  level: PeerLevel;
  /** 업종·부문 이름 (시장이면 null) */
  name: string | null;
  sorted: number[];
}

/** 비교 기준 읽기 (분포를 필요할 때 만들어 기억) */
export class PeerBook {
  private readonly dist = new Map<string, number[]>();
  private readonly byCik = new Map<string, PeerRow>();
  constructor(readonly ref: ValueReferenceData) {
    for (const p of ref.peers) this.byCik.set(p.c, p);
  }

  get refDate(): string {
    return this.ref.refDate;
  }

  /** 티커 → 부문·업종 이름 (BRK.B · BRK-B · BRK/B 모두) */
  classify(ticker: string): { sector: string | null; industry: string | null } | null {
    const t = ticker.toUpperCase();
    const hit = this.ref.symbols[t] ?? this.ref.symbols[t.replace(/[.-]/g, "/")] ?? this.ref.symbols[t.replace(/[./]/g, "-")];
    if (!hit) return null;
    return { sector: this.ref.sectors[hit[0]] || null, industry: this.ref.industries[hit[1]] || null };
  }

  /** 대상 종목이 비교 회사 안에 있으면 그 지표 값 (백분위에서 뺄 값) */
  selfValue(cik: string | null, key: MetricKey): number | null {
    if (!cik) return null;
    const p = this.byCik.get(cik);
    if (!p) return null;
    return decodeX(p.x[METRIC_ORDER.indexOf(key)]);
  }

  adopted(path: ValuePath, key: MetricKey): boolean {
    return (this.ref.coverage[path]?.[key] ?? 0) >= MIN_ADOPTION;
  }

  /** 티커 → 스크리너 시가총액·가격 (기준을 만든 날). 없으면 null */
  quote(ticker: string): { cap: number; price: number } | null {
    const q = this.ref.quotes;
    if (!q) return null;
    const t = ticker.toUpperCase();
    const hit = q[t] ?? q[t.replace(/[.-]/g, "/")] ?? q[t.replace(/[./]/g, "-")];
    return hit && hit[0] > 0 && hit[1] > 0 ? { cap: hit[0], price: hit[1] } : null;
  }

  /** 이번 주에 쓰는 층 (저장한 값). 없으면 null — 그때는 그 자리에서 정한다 */
  heldLevel(path: ValuePath, sector: string | null, industry: string | null, key: MetricKey): LevelCode | null {
    const row = this.ref.levels?.[path]?.[levelKey(sector, industry)];
    const c = row?.[METRIC_ORDER.length + METRIC_ORDER.indexOf(key)];
    return c === "i" || c === "s" || c === "m" ? c : null;
  }

  private values(path: ValuePath, level: PeerLevel, name: string | null, key: MetricKey): number[] {
    const k = `${path}|${level}|${name ?? ""}|${key}`;
    const hit = this.dist.get(k);
    if (hit) return hit;
    const idx = METRIC_ORDER.indexOf(key);
    const secIdx = level === "sector" && name !== null ? this.ref.sectors.indexOf(name) : -1;
    const indIdx = level === "industry" && name !== null ? this.ref.industries.indexOf(name) : -1;
    const out: number[] = [];
    const fin = path === "financial" ? 1 : 0;
    for (const p of this.ref.peers) {
      if (p.f !== fin) continue;
      if (level === "sector" && p.s !== secIdx) continue;
      if (level === "industry" && p.i !== indIdx) continue;
      const v = decodeX(p.x[idx]);
      if (v !== null) out.push(v);
    }
    out.sort((a, b) => a - b);
    this.dist.set(k, out);
    return out;
  }

  /**
   * 업종 자리: 값이 15개 이상인 첫 층 (업종 → 부문 → 시장). 비교 기준에 이번 주 층이 적혀 있으면 그 층
   * (두 주 연속 조건이 바뀌어야 바뀜 — 그 층 값이 10개보다 적으면 그 자리에서 다시 정함)
   */
  industrySlot(path: ValuePath, sector: string | null, industry: string | null, key: MetricKey, selfCik: string | null): PeerDist {
    const self = this.selfValue(selfCik, key);
    const count = (xs: number[]) => xs.length - (self !== null && xs.includes(self) ? 1 : 0);
    const enough = (xs: number[]) => count(xs) >= MIN_PEERS;
    const held = this.heldLevel(path, sector, industry, key);
    if (held === "i" && industry) {
      const xs = this.values(path, "industry", industry, key);
      if (count(xs) >= MIN_PEERS_HOLD) return { level: "industry", name: industry, sorted: xs };
    } else if (held === "s" && sector) {
      const xs = this.values(path, "sector", sector, key);
      if (count(xs) >= MIN_PEERS_HOLD) return { level: "sector", name: sector, sorted: xs };
    } else if (held === "m") return { level: "market", name: null, sorted: this.values(path, "market", null, key) };
    if (industry) {
      const xs = this.values(path, "industry", industry, key);
      if (enough(xs)) return { level: "industry", name: industry, sorted: xs };
    }
    if (sector) {
      const xs = this.values(path, "sector", sector, key);
      if (enough(xs)) return { level: "sector", name: sector, sorted: xs };
    }
    return { level: "market", name: null, sorted: this.values(path, "market", null, key) };
  }

  marketSlot(path: ValuePath, key: MetricKey): PeerDist {
    return { level: "market", name: null, sorted: this.values(path, "market", null, key) };
  }

  /** 가장 많이 겹친 값과 그 비율 (무배당 0%·순현금처럼 여러 회사가 같은 값이면 위치가 그 덩어리에 크게 좌우된다) */
  static tie(sorted: readonly number[]): { share: number; x: number } | null {
    if (!sorted.length) return null;
    let best = 1;
    let bestX = sorted[0]!;
    let run = 1;
    for (let i = 1; i < sorted.length; i++) {
      run = sorted[i] === sorted[i - 1] ? run + 1 : 1;
      if (run > best) {
        best = run;
        bestX = sorted[i]!;
      }
    }
    return { share: best / sorted.length, x: bestX };
  }

  /** 업종 회사 수 (금융·일반 경로 안, 값과 상관없이). 대상 종목 자신(selfCik)은 세지 않는다 — 비교하는 회사 수만 ('69개 회사'라 하고 68곳과 비교하던 것, 검토 지적) */
  groupSize(path: ValuePath, level: PeerLevel, name: string | null, selfCik: string | null = null): number {
    const fin = path === "financial" ? 1 : 0;
    const secIdx = level === "sector" && name !== null ? this.ref.sectors.indexOf(name) : -1;
    const indIdx = level === "industry" && name !== null ? this.ref.industries.indexOf(name) : -1;
    return this.ref.peers.filter((p) => p.f === fin && p.c !== selfCik && (level === "market" || (level === "sector" ? p.s === secIdx : p.i === indIdx))).length;
  }
}

/** 층 표의 열쇠: '부문|업종' (이름 — 번호는 주마다 바뀐다) */
export const levelKey = (sector: string | null, industry: string | null) => `${sector ?? ""}|${industry ?? ""}`;

/**
 * 업종 자리 층 표 만들기 (비교 기준을 만들 때, 설계 §7.1·§11.1). 경로마다 '부문|업종' 짝과 지표마다:
 *  - 이번 주 조건: 업종 값 15개 이상 → i, 아니면 부문 15개 이상 → s, 아니면 m (층은 업종마다 하나 — 대상 종목 자신도 센다)
 *  - 쓰는 층: 지난주 쓰던 층과 같거나 지난주 조건과 같으면(두 주 연속) 이번 주 조건, 아니면 지난주 쓰던 층을 한 주 더
 *    (그 층 값이 10개 이상일 때만)
 * prev 는 지난 기준의 levels (없으면 이번 주 조건 그대로)
 */
export function buildLevels(
  peers: readonly PeerRow[],
  sectors: readonly string[],
  industries: readonly string[],
  pairs: Iterable<readonly [string, string]>,
  prev?: ValueReferenceData["levels"] | null,
): Record<ValuePath, Record<string, string>> {
  const M = METRIC_ORDER.length;
  const count = (fin: 0 | 1, pick: (p: PeerRow) => number) => {
    const m = new Map<number, number[]>();
    for (const p of peers) {
      if (p.f !== fin) continue;
      const k = pick(p);
      let row = m.get(k);
      if (!row) m.set(k, (row = new Array<number>(M).fill(0)));
      for (let j = 0; j < M; j++) if (p.x[j] !== null && p.x[j] !== undefined) row[j]!++;
    }
    return m;
  };
  const out = { general: {}, financial: {} } as Record<ValuePath, Record<string, string>>;
  const list = [...pairs];
  for (const path of ["general", "financial"] as const) {
    const fin = path === "financial" ? 1 : 0;
    const byInd = count(fin, (p) => p.i);
    const bySec = count(fin, (p) => p.s);
    for (const [sector, industry] of list) {
      const key = levelKey(sector || null, industry || null);
      if (out[path][key] !== undefined) continue;
      const ind = industry ? byInd.get(industries.indexOf(industry)) : undefined;
      const sec = sector ? bySec.get(sectors.indexOf(sector)) : undefined;
      const n = (row: number[] | undefined, j: number) => row?.[j] ?? 0;
      let raw = "";
      for (let j = 0; j < M; j++) raw += n(ind, j) >= MIN_PEERS ? "i" : n(sec, j) >= MIN_PEERS ? "s" : "m";
      const old = prev?.[path]?.[key];
      let eff = "";
      for (let j = 0; j < M; j++) {
        const r = raw[j]!;
        const oldRaw = old?.[j];
        const oldEff = old?.[M + j];
        if (!oldEff || r === oldEff || r === oldRaw) eff += r;
        else {
          // 지난주 층을 한 주 더 — 그 층 값이 너무 적으면 두지 않음
          const have = oldEff === "i" ? n(ind, j) : oldEff === "s" ? n(sec, j) : Infinity;
          eff += have >= MIN_PEERS_HOLD ? oldEff : r;
        }
      }
      out[path][key] = raw + eff;
    }
  }
  return out;
}

// ── 점수 ─────────────────────────────────────────────────

export interface MetricScore {
  key: MetricKey;
  /** 이 시장에서 쓰는 지표인지 (70% 규칙) */
  adopted: boolean;
  x: number | null;
  show: number | null;
  rule?: MetricRule;
  why?: MetricWhy;
  blend?: boolean;
  score: number | null;
  pos: Partial<Record<CompareKey, number>>;
  /** 실제로 쓴 비교 비중 (없는 비교는 비례 배분) */
  mix: Partial<Record<CompareKey, number>>;
  /** 업종 자리에 쓴 층과 회사 수, 가운데값(순위용 값), 가장 많이 겹친 값(tieX)과 그 비율(tie, 0~1) */
  peer: { level: PeerLevel; name: string | null; n: number; median: number | null; tie: number; tieX: number | null } | null;
  /** 자기 지난 5년 비교에 쓴 월말 수 */
  ownN: number;
}
export interface FamilyScore {
  key: ValueFamilyKey;
  weight: number;
  score: number | null;
  valid: boolean;
  /** 무효인 까닭 */
  why: "noCore" | "tooFew" | null;
  metrics: MetricScore[];
}
export interface ValueScoreResult {
  path: ValuePath;
  status: "ok" | "partial" | "insufficient";
  /** 반올림 전 */
  score: number | null;
  /** 화면 정수 */
  shown: number | null;
  band: ValueBand | null;
  coverageWeight: number;
  families: FamilyScore[];
  reasons: Array<{ code: "priceInvalid" | "lowCoverage" | "fewFamilies"; pct?: number }>;
}

export interface ScoreInput {
  path: ValuePath;
  sector: string | null;
  industry: string | null;
  cik: string | null;
  metrics: MetricSet;
  /** 자기 지난 5년 월말 값 (지표별 순위용 값, 오래된 → 최신) */
  own: Partial<Record<MetricKey, Array<number | null>>>;
  peers: PeerBook;
}

/** 대상 종목 지표 → 점수 */
export function scoreValue(inp: ScoreInput): ValueScoreResult {
  const { path, peers } = inp;
  const families: FamilyScore[] = VALUE_FAMILIES.map((fk) => {
    const mix = COMPARE_MIX[fk];
    const metrics: MetricScore[] = FAMILY_METRICS[path][fk].map((key) => {
      const mv = inp.metrics[key];
      const adopted = peers.adopted(path, key);
      const base: MetricScore = { key, adopted, x: mv?.x ?? null, show: mv?.show ?? null, ...(mv?.rule ? { rule: mv.rule } : {}), ...(mv?.why ? { why: mv.why } : {}), ...(mv?.blend ? { blend: true } : {}), score: null, pos: {}, mix: {}, peer: null, ownN: 0 };
      if (!adopted || !mv || mv.x === null) return base;
      const self = peers.selfValue(inp.cik, key);
      const ind = peers.industrySlot(path, inp.sector, inp.industry, key, inp.cik);
      const mkt = peers.marketSlot(path, key);
      const own = fk === "price" ? (inp.own[key] ?? []).filter((v): v is number => v !== null) : [];
      const pos: Partial<Record<CompareKey, number>> = {};
      const pInd = percentile(mv.x, ind.sorted, self);
      if (pInd !== null) pos.industry = pInd;
      const pMkt = percentile(mv.x, mkt.sorted, self);
      if (pMkt !== null) pos.market = pMkt;
      if (mix.own && own.length >= OWN_MIN_MONTHS) {
        const all = [...own, mv.x].sort((a, b) => a - b);
        pos.own = percentile(mv.x, all)!;
      }
      const used = (Object.keys(mix) as CompareKey[]).filter((k) => pos[k] !== undefined);
      const wsum = used.reduce((a, k) => a + mix[k]!, 0);
      const usedMix: Partial<Record<CompareKey, number>> = {};
      for (const k of used) usedMix[k] = (100 * mix[k]!) / wsum;
      let score: number | null = wsum > 0 ? used.reduce((a, k) => a + mix[k]! * pos[k]!, 0) / wsum : null;
      // 0점 규칙: 위치와 상관없이 0 (적자·자본잠식 등)
      if (mv.rule === "zeroLoss") {
        score = 0;
        for (const k of used) pos[k] = 0;
      }
      const n = ind.sorted.length - (self !== null && ind.sorted.includes(self) ? 1 : 0);
      const tie = PeerBook.tie(ind.sorted);
      return {
        ...base,
        score,
        pos,
        mix: usedMix,
        peer: { level: ind.level, name: ind.name, n, median: medianOf(ind.sorted), tie: tie?.share ?? 0, tieX: tie?.x ?? null },
        ownN: fk === "price" ? own.length : 0,
      };
    });
    const defined = metrics.filter((m) => m.adopted);
    const present = defined.filter((m) => m.score !== null);
    const core = CORE_METRICS[path][fk].some((k) => present.some((m) => m.key === k));
    const valid = core && present.length * 2 >= defined.length && present.length > 0;
    // 화면에 보이는 지표 정수의 평균 (손으로 다시 계산해도 맞게)
    const score = valid ? present.reduce((a, m) => a + roundScore(m.score!), 0) / present.length : null;
    return { key: fk, weight: VALUE_WEIGHTS[path][fk], score, valid, why: valid ? null : !core ? "noCore" : "tooFew", metrics };
  });
  const valid = families.filter((f) => f.valid);
  const coverageWeight = valid.reduce((a, f) => a + f.weight, 0);
  const reasons: ValueScoreResult["reasons"] = [];
  if (!families.find((f) => f.key === "price")!.valid) reasons.push({ code: "priceInvalid" });
  if (coverageWeight < MIN_COVERAGE_WEIGHT) reasons.push({ code: "lowCoverage", pct: coverageWeight });
  if (valid.length < MIN_FAMILIES) reasons.push({ code: "fewFamilies" });
  if (reasons.length) return { path, status: "insufficient", score: null, shown: null, band: null, coverageWeight, families, reasons };
  // 화면에 보이는 묶음 정수로 (설계 §7.5 '사용자가 손으로 다시 계산해도 맞아야 한다')
  const score = valid.reduce((a, f) => a + f.weight * roundScore(f.score!), 0) / coverageWeight;
  const shown = roundScore(score);
  return { path, status: coverageWeight >= 100 ? "ok" : "partial", score, shown, band: valueBand(shown), coverageWeight, families, reasons };
}

// ── 표시 (점수는 그대로, 해석을 돕는 줄) ─────────────────────────

export type ValueFlagKey =
  | "cyclicalPeak" | "cyclicalTrough" | "valueTrap" | "oneOff" | "sbcHeavy" | "smallEquity" | "negativeEquity" | "capitalImpairment"
  | "earlyStage" | "payoutOver100" | "dividendCut" | "peerFallback" | "financial" | "carriedForward";

export function valueFlags(r: ValueScoreResult, aux: MetricAux, ctx: { cyclical: boolean; thresholds: ValueThresholds; metrics: MetricSet }): ValueFlagKey[] {
  const out: ValueFlagKey[] = [];
  const th = ctx.thresholds;
  const fam = (k: ValueFamilyKey) => {
    const f = r.families.find((x) => x.key === k);
    return f?.score !== null && f?.score !== undefined ? roundScore(f.score) : null;
  };
  if (ctx.cyclical && aux.opAtHigh && aux.niToAvg5 !== null && th.niToAvg5P90 !== null && aux.niToAvg5 >= th.niToAvg5P90) out.push("cyclicalPeak");
  if (ctx.cyclical && aux.opAtLow) out.push("cyclicalTrough");
  const p = fam("price");
  const g = fam("growth");
  const q = fam("quality");
  const h = fam("health");
  if (p !== null && p >= 67 && g !== null && g <= 33 && ((q !== null && q <= 33) || (h !== null && h <= 33))) out.push("valueTrap");
  if (aux.nonOpRatio !== null && th.nonOpP95 !== null && aux.nonOpRatio >= th.nonOpP95) out.push("oneOff");
  if (aux.sbcToRevenue !== null && th.sbcP90 !== null && aux.sbcToRevenue >= th.sbcP90) out.push("sbcHeavy");
  if (ctx.metrics.B1?.why === "smallEquity") out.push("smallEquity");
  if (ctx.metrics.D1?.why === "negativeEquity") out.push("negativeEquity");
  if (ctx.metrics.D1?.why === "capitalImpairment") out.push("capitalImpairment");
  if (aux.earlyStage) out.push("earlyStage");
  if (aux.payoutOver100) out.push("payoutOver100");
  if (aux.dividendCut) out.push("dividendCut");
  // 업종 대신 부문·시장과 비교: 주가 수준 핵심 지표 기준
  const priceCore = r.families.find((f) => f.key === "price")?.metrics.find((m) => m.peer && CORE_METRICS[r.path].price.includes(m.key));
  if (priceCore?.peer && priceCore.peer.level !== "industry") out.push("peerFallback");
  if (r.path === "financial") out.push("financial");
  return out;
}

/** 경기 민감 업종 (Nasdaq 업종 이름, 설계 §14.2 — 목록 + 데이터 기준 둘 중 하나) */
export const CYCLICAL_INDUSTRIES: ReadonlySet<string> = new Set([
  "Semiconductors",
  "Steel/Iron Ore",
  "Metal Mining",
  "Major Chemicals",
  "Specialty Chemicals",
  "Agricultural Chemicals",
  "Oil & Gas Production",
  "Integrated oil Companies",
  "Oil Refining/Marketing",
  "Oilfield Services/Equipment",
  "Coal Mining",
  "Marine Transportation",
  "Auto Manufacturing",
  "Auto Parts:O.E.M.",
  "Motor Vehicles",
  "Homebuilding",
  "Air Freight/Delivery Services",
  "Trucking Freight/Courier Services",
  "Aluminum",
  "Precious Metals",
  "Other Metals and Minerals",
  "Forest Products",
  "Paper",
  "Construction/Ag Equipment/Trucks",
  "Mining & Quarrying of Nonmetallic Minerals (No Fuels)",
]);
/** 금융사 경로로 보는 Nasdaq 업종 (은행·보험·저축기관) — 그 밖은 예금·보험 준비금 비중으로도 판정 */
export const FINANCIAL_INDUSTRIES: ReadonlySet<string> = new Set([
  "Major Banks",
  "Banks",
  "Commercial Banks",
  "Savings Institutions",
  "Life Insurance",
  "Property-Casualty Insurers",
  "Accident &Health Insurance",
  "Specialty Insurers",
  "Finance Companies",
]);
/** 제외 업종: 리츠(전용 지표 필요), 스팩 */
export const REIT_INDUSTRY = "Real Estate Investment Trusts";
export const SPAC_INDUSTRY = "Blank Checks";

/** 증권·투자은행 업종 (Nasdaq) — 자산운용·거래소·결제 회사도 섞여 있어, 고객 돈을 부채로 크게 들고 있는 회사만 금융 경로로 본다 */
export const BROKER_INDUSTRY = "Investment Bankers/Brokers/Service";
/** 증권 업종에서 금융 경로로 보는 자본 ÷ 총자산 상한 (설계 §4 7번 '증권') */
export const BROKER_EQUITY_MAX = 0.25;

/**
 * 금융사 판정: 업종 목록(은행·보험·저축기관) · 예금이나 보험 준비금이 부채의 10% 이상 ·
 * 증권 업종이면서 자본 ÷ 총자산 < 25% (고객 돈을 부채로 들고 있는 증권사 — 예금이 없는 증권사도 금융 경로)
 */
export function isFinancial(
  industry: string | null,
  bal: { liabilities?: number; deposits?: number; policyReserves?: number; claimReserves?: number; assets?: number; equity?: number; equityTotal?: number },
  sic?: number | null,
): boolean {
  if (industry && FINANCIAL_INDUSTRIES.has(industry)) return true;
  if (industry === BROKER_INDUSTRY) {
    const eq = bal.equityTotal ?? bal.equity;
    if (typeof bal.assets === "number" && bal.assets > 0 && typeof eq === "number" && eq / bal.assets < BROKER_EQUITY_MAX) return true;
  }
  const L = bal.liabilities;
  if (typeof L === "number" && L > 0) {
    if ((bal.deposits ?? 0) / L >= 0.1) return true;
    if (((bal.policyReserves ?? 0) + (bal.claimReserves ?? 0)) / L >= 0.1) return true;
  }
  // 업종을 모를 때만 SIC (6000~6411 은행·증권·보험, 6770 스팩·6798 리츠 제외)
  if (!industry && typeof sic === "number" && sic >= 6000 && sic <= 6411) return true;
  return false;
}

/** 경기 민감: 업종 목록 또는 영업이익률 5년 표준편차가 시장 상위 30% */
export function isCyclical(industry: string | null, opMarginStd: number | null, th: Pick<ValueThresholds, "opMarginStdP70">): boolean {
  if (industry && CYCLICAL_INDUSTRIES.has(industry)) return true;
  return opMarginStd !== null && th.opMarginStdP70 !== null && opMarginStd >= th.opMarginStdP70;
}

/** 분위수 (정렬 배열, 선형 보간) */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
