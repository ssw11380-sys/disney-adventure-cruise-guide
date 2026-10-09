import { FLOW_KEYS, FLOW_TAGS, INSTANT_KEYS, INSTANT_TAGS, SHARE_TAGS, type FactTag, type FlowKey, type InstantKey } from "./valueConcepts.js";

/**
 * SEC companyfacts → 가치 지표 입력 (3-44 2단계, VALUE-1). 순수 함수 — 네트워크 없음.
 *  - 줄이기(compactCompanyFacts): 정기 보고서(10-K·10-Q·정정) 줄만, 쓰는 태그만, 최근 약 8년. DB(value_fundamentals)에 이 모양으로 저장한다
 *  - 공시일 기준(asOf): 그날까지 제출된(filed ≤ asOf) 값만 쓴다 — 같은 기간 값이 여럿이면 그때까지 가장 늦게 낸 값(정정·재작성 반영)
 *  - 최근 4분기(TTM): 가장 최근 보고서의 기간 끝(E)이 연간이면 그 연간 값, 분기면 '직전 연간 + 올해 누적 − 작년 같은 기간 누적'.
 *    10-Q 현금흐름은 연초부터 쌓인 누적값만 있어서 이렇게 빼야 한다 (data-audit 7-4)
 *  - 태그 별칭: 가장 최근 기간(E) 값이 있는 태그를 먼저, 그 태그에 없는 기간만 다른 태그로 채운다. 단 겹치는 기간 값이 다른 태그는 쓰지 않는다
 *    (이름만 바꾼 태그는 겹치는 기간이 없거나 값이 같다)
 */

export type FactRow = [start: string | null, end: string, val: number, filed: string, form: string, tag: number];
export interface CompactFacts {
  v: 1;
  cik: string;
  name: string | null;
  flows: Partial<Record<FlowKey, FactRow[]>>;
  shares: FactRow[];
  inst: Partial<Record<InstantKey, FactRow[]>>;
  /** 가장 늦은 제출일 (새 공시 확인용) */
  lastFiled: string | null;
}

const PERIODIC = new Set(["10-K", "10-Q", "10-K/A", "10-Q/A", "10-KT", "10-KT/A"]);
const ANNUAL_FORMS = new Set(["10-K", "10-K/A", "10-KT", "10-KT/A"]);
const DAY = 86_400_000;
/** 얼마나 오래된 기간까지 남길지 (5년 이력 + 5년 자기 비교에 필요한 만큼) */
export const KEEP_YEARS = 8;

type Json = Record<string, unknown>;
const t0 = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const daysBetween = (a: string, b: string) => Math.round((t0(b) - t0(a)) / DAY);
export function addDays(d: string, n: number): string {
  return new Date(t0(d) + n * DAY).toISOString().slice(0, 10);
}
/**
 * 기간 길이(일) → 종류. 52/53주 회계연도의 13·14주 분기와 12·12·12·16주 분기(COST — 1분기 12주·반기 24주 = 168일·3분기 누적 36주 = 252일)·
 * 16·12·12·12주 분기(1분기 16주 = 112일·반기 28주·3분기 누적 40주)까지. 2단계까지는 반기 170일·3분기 누적 260일부터라 COST 의 24·36주 누적을
 * 몰라 최근 4분기를 만들지 못했다 (검토 지적 — 가치 지표 점수 없음)
 */
export function spanKind(start: string | null, end: string): "Q" | "H" | "9M" | "Y" | "other" | "instant" {
  if (!start) return "instant";
  const d = daysBetween(start, end) + 1;
  if (d >= 80 && d <= 115) return "Q";
  if (d >= 165 && d <= 205) return "H";
  if (d >= 245 && d <= 295) return "9M";
  if (d >= 350 && d <= 380) return "Y";
  return "other";
}

/**
 * 지주회사 전환 등으로 CIK 가 바뀐 회사: 새 CIK → 예전 CIK (설계 B9 'XOM CIK 변경'). SEC 티커 목록은 새 CIK 만 가리키는데, 새 CIK 의
 * companyfacts 에는 전환 뒤 보고서(첫 10-Q)만 있어 연간 이력이 비었다 (XOM: 2026년 ExxonMobil Holdings Corp 0002115436, 예전 Exxon Mobil
 * Corporation 0000034088 — 검토 지적). 예전 CIK 재무를 이어 붙인다 (같은 기간은 늦게 낸 값이 이긴다 — secFacts 의 공시일 규칙 그대로)
 */
export const PREDECESSOR_CIK: Readonly<Record<string, string>> = { "0002115436": "0000034088" };

/** 두 companyfacts 원본 합치기 (새 CIK 의 이름·CIK 그대로, 태그·단위마다 줄을 잇는다 — 같은 줄은 줄이기에서 한 번만 남는다) */
export function mergeCompanyFacts(primary: Json, predecessor: Json): Json {
  const out: Json = { ...primary, facts: {} };
  const facts = out["facts"] as Record<string, Record<string, { units: Record<string, Json[]> } & Json>>;
  for (const src of [predecessor, primary]) {
    for (const [tax, tags] of Object.entries((src["facts"] as Record<string, Record<string, Json>> | undefined) ?? {})) {
      const t = (facts[tax] ??= {});
      for (const [name, body] of Object.entries(tags)) {
        const units = ((body as { units?: Record<string, Json[]> }).units ?? {}) as Record<string, Json[]>;
        const cur = (t[name] ??= { ...(body as Json), units: {} } as { units: Record<string, Json[]> } & Json);
        for (const [u, rows] of Object.entries(units)) cur.units[u] = [...(cur.units[u] ?? []), ...rows];
      }
    }
  }
  return out;
}

/** companyfacts 원본 JSON → 저장용 모양 (since 이후 기간 끝만). USD 가 아닌 금액은 넣지 않는다 */
export function compactCompanyFacts(raw: Json, since: string): CompactFacts {
  const gaap = ((raw["facts"] as Json | undefined)?.["us-gaap"] as Record<string, { units?: Record<string, Json[]> }> | undefined) ?? {};
  const rowsOf = (tags: readonly FactTag[]): FactRow[] => {
    const out: FactRow[] = [];
    const seen = new Set<string>();
    tags.forEach((tag, idx) => {
      for (const r of gaap[tag.name]?.units?.[tag.unit] ?? []) {
        const form = String(r["form"] ?? "");
        const end = typeof r["end"] === "string" ? r["end"] : null;
        const val = r["val"];
        const filed = typeof r["filed"] === "string" ? r["filed"] : null;
        if (!PERIODIC.has(form) || !end || !filed || typeof val !== "number" || !Number.isFinite(val) || end < since) continue;
        const start = typeof r["start"] === "string" ? r["start"] : null;
        const k = `${idx}|${start}|${end}|${val}|${filed}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([start, end, val, filed, form, idx]);
      }
    });
    return out.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
  };
  const flows: CompactFacts["flows"] = {};
  for (const k of FLOW_KEYS) {
    const rows = rowsOf(FLOW_TAGS[k]).filter((r) => r[0] !== null);
    if (rows.length) flows[k] = rows;
  }
  const inst: CompactFacts["inst"] = {};
  for (const k of INSTANT_KEYS) {
    const rows = rowsOf(INSTANT_TAGS[k]).filter((r) => r[0] === null);
    if (rows.length) inst[k] = rows;
  }
  const shares = rowsOf(SHARE_TAGS).filter((r) => r[0] !== null);
  let lastFiled: string | null = null;
  for (const list of [...Object.values(flows), ...Object.values(inst), shares]) for (const r of list ?? []) if (!lastFiled || r[3] > lastFiled) lastFiled = r[3];
  const cik = raw["cik"];
  return {
    v: 1,
    cik: typeof cik === "number" ? String(cik).padStart(10, "0") : typeof cik === "string" ? cik.padStart(10, "0") : "",
    name: typeof raw["entityName"] === "string" ? raw["entityName"] : null,
    flows,
    shares,
    inst,
    lastFiled,
  };
}

/** 기간 하나의 값 (asOf 까지 가장 늦게 낸 것) */
interface Point {
  start: string | null;
  end: string;
  val: number;
  filed: string;
  form: string;
  tag: number;
  /** 이 기간이 연간 보고서(10-K)에 나온 적이 있는지 — 1년 길이라도 10-Q 의 '최근 12개월' 줄(AMZN)은 회계연도가 아니다 */
  annualForm: boolean;
}

/**
 * 한 항목(태그 별칭 묶음)의 기간 값들을 asOf 기준으로 고른다.
 * primaryEnd 가 있으면 그 기간 끝 값이 있는 태그를 먼저, 없으면 가장 최근 기간 끝 값이 있는 태그를 먼저.
 * 다른 태그는 먼저 고른 태그와 겹치는 기간 값이 모두 같을 때만 빈 기간을 채운다
 */
function pickSeries(rows: readonly FactRow[] | undefined, asOf: string, primaryEnd?: string): Map<string, Point> {
  const out = new Map<string, Point>();
  if (!rows?.length) return out;
  // 태그별 기간 → asOf 까지 가장 늦게 낸 값
  const byTag = new Map<number, Map<string, Point>>();
  for (const [start, end, val, filed, form, tag] of rows) {
    if (filed > asOf) continue;
    const m = byTag.get(tag) ?? new Map<string, Point>();
    const k = `${start ?? ""}|${end}`;
    const prev = m.get(k);
    const annualForm = ANNUAL_FORMS.has(form) || (prev?.annualForm ?? false);
    if (!prev || filed > prev.filed || (filed === prev.filed && ANNUAL_FORMS.has(form) && !ANNUAL_FORMS.has(prev.form))) m.set(k, { start, end, val, filed, form, tag, annualForm });
    else if (annualForm && !prev.annualForm) prev.annualForm = true;
    byTag.set(tag, m);
  }
  if (!byTag.size) return out;
  const lastEnd = (m: Map<string, Point>) => [...m.values()].reduce((a, p) => (p.end > a ? p.end : a), "");
  const tags = [...byTag.keys()].sort((a, b) => a - b);
  const newest = tags.reduce((a, t) => (lastEnd(byTag.get(t)!) > a ? lastEnd(byTag.get(t)!) : a), "");
  const target = primaryEnd ?? newest;
  // 기준 기간 끝 값이 있는 태그 중 목록 순서가 앞선 것, 없으면 가장 최근 기간 값이 있는 태그 중 앞선 것
  const primary = tags.find((t) => [...byTag.get(t)!.values()].some((p) => p.end === target)) ?? tags.find((t) => lastEnd(byTag.get(t)!) === newest)!;
  for (const [k, p] of byTag.get(primary)!) out.set(k, p);
  for (const t of tags) {
    if (t === primary) continue;
    const m = byTag.get(t)!;
    const overlap = [...m.keys()].filter((k) => out.has(k));
    if (overlap.some((k) => !sameValue(out.get(k)!.val, m.get(k)!.val))) continue;
    for (const [k, p] of m) if (!out.has(k)) out.set(k, p);
  }
  return out;
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
}

export interface PeriodInfo {
  /** 가장 최근 보고서 기간 끝 */
  end: string;
  /** 그 보고서 제출일 */
  filed: string;
  form: string;
  /** 흐름 값의 기준: FY = 그 연간 보고서, TTM = 최근 4분기 */
  basis: "FY" | "TTM";
}

export interface AnnualPoint {
  end: string;
  revenue: number | null;
  opIncome: number | null;
  netIncome: number | null;
  /** 희석 가중평균 주식 수 (그해) */
  shares: number | null;
  /** 그해 말 잔액 */
  assets: number | null;
  equity: number | null;
}

/** 가치 지표 계산 입력 (대상 종목은 companyfacts 에서, 비교 회사는 frames 에서 같은 모양으로 만든다) */
export interface ValueInputs {
  flow: Partial<Record<FlowKey, number>>;
  /** 최근 분기말 잔액 */
  bal: Partial<Record<InstantKey, number>>;
  /** 1년 전 분기말 (평균 자본·자산) */
  balYearAgo: { equity?: number; assets?: number };
  /** 연간 이력 (오래된 → 최신, 최대 6개) */
  annual: AnnualPoint[];
  /** 시가총액용 최신 희석 주식 수 (대상 종목만) */
  shares: number | null;
  period: PeriodInfo | null;
  /**
   * 대상 종목만: 최근 1년 안에 배당 기록이 있는데 최근 4분기 배당을 만들 수 없음 → 배당수익률 '자료 없음'
   * (무배당 0% 와 다르게 — 설계 원칙 4). 비교 회사(frames 연간 값)는 늘 없음
   */
  divUnknown?: boolean;
  /** 대상 종목만: 최근 5년 가운데 1주당 배당이 앞 해보다 줄어든 해가 있음 (표시 dividendCut — 점수는 그대로) */
  dividendCut?: boolean;
}

/** 1주당 배당이 줄었다고 보는 기준 (앞 해의 99% 밑 — 반올림 차이는 빼고) */
export const DIVIDEND_CUT_RATIO = 0.99;

/** 흔한 분할·병합 배수 (3:2 · 2:1 · … · 50:1). 한 해 주식 수 비율이 이 가운데 하나와 8% 안이면 그 배수로 본다 */
export const SPLIT_RATIOS: readonly number[] = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50];
/** 주식 수 비율이 흔한 배수와 이만큼(비율로) 안이면 그 배수 */
export const SPLIT_TOLERANCE = 1.08;
/** 이보다 크게 바뀌면(1,000배 안팎) 분할이 아니라 단위가 바뀐 것 (WRB 는 2022년까지 주식 수를 천 주 단위로 보고) */
const UNIT_JUMP = 200;

/**
 * 두 해 희석 주식 수(보고한 그대로)로 본 분할·병합 배수: 한 해에 40% 넘게 바뀌었으면 가장 가까운 흔한 배수(SPLIT_RATIOS — 9.66 → 10, 1.46 → 1.5,
 * 3.92 → 4, 0.1 → 1/10), 흔한 배수와 8% 넘게 다르면 비율 그대로(합병 등), 아니면 1. 가중평균 주식 수에는 자사주 매입 등 작은 변화가 섞여 있어
 * 그대로 곱하면 분할 앞뒤 같은 배당(0.16 → 0.016 × 10)을 줄었다고 잘못 본다. 3단계 전에는 0.5 단위로 맞춰 10:1 분할을 9.5 로 덜 맞췄다
 * (LRCX 2024 — 9.66 → 9.5, 검토 지적). 1,000배 안팎으로 바뀐 것은 단위(천 주 → 주)가 바뀐 것으로 보고 그 몫을 뺀다 (WRB 2022→2023)
 */
export function splitFactor(before: number | null, after: number | null): number {
  if (!before || !after || !(before > 0) || !(after > 0)) return 1;
  let k = after / before;
  if (k >= UNIT_JUMP) k /= 1000;
  else if (k <= 1 / UNIT_JUMP) k *= 1000;
  const up = k >= 1;
  const r = up ? k : 1 / k;
  if (r <= 1.4) return 1;
  let best = r;
  let bestGap = Infinity;
  for (const s of SPLIT_RATIOS) {
    const gap = Math.max(r / s, s / r);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  const f = bestGap <= SPLIT_TOLERANCE ? best : r;
  return up ? f : 1 / f;
}

/**
 * 앞 해 1주당 배당이 앞앞 해보다 이만큼(배) 넘게 뛰었으면 특별배당·일시 배당이 섞였을 수 있다고 본다. 2단계 검토의 특별배당 회사들
 * (COST 5.0배 · WRB 4.3배 · CTAS 2.0배 · F 2.5배 · FAST 1.44배·1.61배)이 모두 넘고, 정기 배당을 올린 해는 대개 이 안이다 (1.00 → 1.20 = 1.2배)
 */
export const DIVIDEND_JUMP_RATIO = 1.25;

/**
 * 배당 삭감 판정 (순수 함수): 최근 6개 회계연도(이웃한 두 해 5쌍)에서 뒤 해의 1주당 배당이 앞 해의 99% 밑이면 줄어든 해.
 * 다만 앞 해가 앞앞 해보다 25% 넘게 뛰었으면(특별배당일 수 있음) 뒤 해가 앞앞 해 수준 밑으로 내려갔을 때만 줄어든 해 — 특별배당을 준 해의
 * 다음 해만 달리 본다 (예전 3단계 첫 규칙은 모든 해에 '앞 두 해 모두보다 적을 때'를 적용해 1.00 → 1.20 → 1.10 같은 실제 삭감을 놓쳤다,
 * 검토 지적). years 가 7개면 첫 쌍의 앞앞 해는 7번째 앞 해. 주식 분할·병합은 splitFactor 로 앞 해 기준에 맞춘다. 두 해 모두 값이 있는
 * 쌍만 본다 — 앞앞 해 값이 없으면 앞 해만 (특별배당인지 알 수 없어 예전 규칙 그대로)
 */
export function dividendCutOf(years: ReadonlyArray<{ dps: number | null; shares: number | null }>): boolean {
  const ys = years.slice(-7);
  const first = Math.max(1, ys.length - 5);
  for (let i = first; i < ys.length; i++) {
    const a = ys[i - 1]!;
    const b = ys[i]!;
    if (a.dps === null || b.dps === null || !(a.dps > 0)) continue;
    const bAdj = b.dps * splitFactor(a.shares, b.shares);
    if (!(bAdj < a.dps * DIVIDEND_CUT_RATIO)) continue;
    const z = i >= 2 ? ys[i - 2]! : null;
    // 앞앞 해 (앞 해 주식 수 기준으로 맞춤): 앞 해가 크게 뛰었으면(특별배당) 앞앞 해 수준보다 줄었을 때만
    if (z && z.dps !== null && z.dps > 0) {
      const zAdj = z.dps / splitFactor(z.shares, a.shares);
      if (a.dps > zAdj * DIVIDEND_JUMP_RATIO && !(bAdj < zAdj * DIVIDEND_CUT_RATIO)) continue;
    }
    return true;
  }
  return false;
}

export class FactBook {
  constructor(readonly c: CompactFacts) {}

  /** asOf 까지 제출된 가장 최근 정기 보고서의 기간 끝 (순이익·매출 기간 값 기준) */
  latest(asOf: string): PeriodInfo | null {
    let best: FactRow | null = null;
    for (const k of ["netIncome", "revenue"] as const)
      for (const r of this.c.flows[k] ?? []) {
        if (r[3] > asOf || !r[0]) continue;
        if (!best || r[1] > best[1] || (r[1] === best[1] && r[3] > best[3])) best = r;
      }
    if (!best) return null;
    const end = best[1];
    // 그 기간 끝의 연간 값이 있으면 FY
    const annual = (this.c.flows.netIncome ?? []).some((r) => r[3] <= asOf && r[1] === end && spanKind(r[0], r[1]) === "Y" && ANNUAL_FORMS.has(r[4]));
    return { end, filed: best[3], form: best[4], basis: annual ? "FY" : "TTM" };
  }

  /**
   * 흐름 항목의 최근 4분기 값 (기간 끝 E 기준). E 가 연간이면 연간 값, 아니면 직전 연간 + 올해 누적 − 작년 같은 기간 누적.
   * 값을 만들 수 없으면 null
   */
  flowTTM(key: FlowKey, asOf: string, E: string): number | null {
    const s = pickSeries(this.c.flows[key], asOf, E);
    return ttmFrom(s, E, key === "dividends" || key === "dps");
  }

  /**
   * 흐름 항목의 최근 4분기 값이 덮는 날 수 (직전 연간 + 올해 누적 − 작년 같은 기간 누적일 때: 직전 연간 끝 − 작년 누적 끝 + 올해 누적 날 수).
   * E 가 연간이면 null (그 연간 값 그대로), 만들 수 없으면 null
   */
  flowWindow(key: FlowKey, asOf: string, E: string): number | null {
    return ttmWindow(pickSeries(this.c.flows[key], asOf, E), E);
  }

  /** 최근 1년(기간 끝이 E 앞 400일 안) 사이 배당(지급액·주당 배당) 기록이 있는지 — 0 보다 큰 값만 */
  dividendSeen(asOf: string, E: string): boolean {
    const from = addDays(E, -400);
    for (const k of ["dividends", "dps"] as const) for (const r of this.c.flows[k] ?? []) if (r[3] <= asOf && r[1] > from && r[1] <= E && r[2] > 0) return true;
    return false;
  }

  /** 잔액 항목의 date 시점 값 (±tol 일) */
  instant(key: InstantKey, asOf: string, date: string, tol = 0): number | null {
    const s = pickSeries(this.c.inst[key], asOf, date);
    let best: Point | null = null;
    for (const p of s.values()) {
      const d = Math.abs(daysBetween(p.end, date));
      if (d > tol) continue;
      if (!best || d < Math.abs(daysBetween(best.end, date)) || (d === Math.abs(daysBetween(best.end, date)) && p.filed > best.filed)) best = p;
    }
    return best?.val ?? null;
  }

  /** 시가총액용 주식 수: 기간 끝 E 의 희석 가중평균 (3개월 값 우선, 없으면 가장 짧은 기간), 없으면 E 앞의 가장 최근 값 */
  sharesAt(asOf: string, E: string): number | null {
    const rows = (this.c.shares ?? []).filter((r) => r[3] <= asOf && r[0] && r[1] <= E);
    if (!rows.length) return null;
    const lastEnd = rows.reduce((a, r) => (r[1] > a ? r[1] : a), "");
    const at = rows.filter((r) => r[1] === (rows.some((r2) => r2[1] === E) ? E : lastEnd));
    at.sort((a, b) => daysBetween(a[0]!, a[1]) - daysBetween(b[0]!, b[1]) || (a[5] - b[5]) || (a[3] < b[3] ? 1 : -1));
    return at[0]?.[2] ?? null;
  }

  /** 연간 흐름 값 (기간 끝 → 값) */
  annualFlow(key: FlowKey, asOf: string): Map<string, number> {
    const s = pickSeries(this.c.flows[key], asOf);
    const out = new Map<string, number>();
    for (const p of s.values()) if (isFY(p)) out.set(p.end, p.val);
    return out;
  }

  annualShares(asOf: string): Map<string, number> {
    const out = new Map<string, { val: number; filed: string; tag: number }>();
    for (const r of this.c.shares ?? []) {
      if (r[3] > asOf || spanKind(r[0], r[1]) !== "Y" || !ANNUAL_FORMS.has(r[4])) continue;
      const prev = out.get(r[1]);
      if (!prev || r[5] < prev.tag || (r[5] === prev.tag && r[3] > prev.filed)) out.set(r[1], { val: r[2], filed: r[3], tag: r[5] });
    }
    return new Map([...out].map(([k, v]) => [k, v.val]));
  }

  /** asOf 시점에 알 수 있던 값으로 만든 입력 (대상 종목) */
  inputs(asOf: string): ValueInputs | null {
    const period = this.latest(asOf);
    if (!period) return null;
    const E = period.end;
    const flow: ValueInputs["flow"] = {};
    for (const k of FLOW_KEYS) {
      const v = this.flowTTM(k, asOf, E);
      if (v !== null) flow[k] = v;
    }
    const bal: ValueInputs["bal"] = {};
    for (const k of INSTANT_KEYS) {
      const v = this.instant(k, asOf, E, 3);
      if (v !== null) bal[k] = v;
    }
    const ya = addDays(E, -365);
    const balYearAgo: ValueInputs["balYearAgo"] = {};
    const eqYa = this.instant("equity", asOf, ya, 12);
    const asYa = this.instant("assets", asOf, ya, 12);
    if (eqYa !== null) balYearAgo.equity = eqYa;
    if (asYa !== null) balYearAgo.assets = asYa;
    const etYa = this.instant("equityTotal", asOf, ya, 12);
    if (etYa !== null && balYearAgo.equity === undefined) balYearAgo.equity = etYa - (this.instant("nci", asOf, ya, 12) ?? 0);
    const shares = this.sharesAt(asOf, E);
    // 52/53주 회계연도의 배당 창 (긴급 고침 2026-09-29, KO): 최근 4분기를 '직전 연간 + 올해 누적 − 작년 같은 기간 누적'으로 만들면 분기 끝이 해마다
    // 며칠씩 움직이는 회사는 창이 365일이 아니다(KO: 작년 1분기 끝 3/28 ↔ 올해 4/3 → 371일). 배당은 날짜에 몰려 지급되므로 창 끝 가까이 있는
    // 지급일(KO 4월 1일)이 두 번 들어가 5번 지급으로 셌다(배당수익률 2.9% ↔ 남 2.36~2.41%). 창이 365 ± 3일이 아니고 현금 배당이 주당배당 × 주식 수와
    // 15% 넘게 다르면 주당배당 × 주식 수를 쓴다 (주당배당은 선언한 분기에 잡혀 지급일에 흔들리지 않는다 — KO 2.06달러, SEC 원본으로 확인)
    const win = this.flowWindow("dividends", asOf, E);
    if (win !== null && Math.abs(win - 365) > DIV_WINDOW_TOLERANCE_DAYS && flow.dividends !== undefined && flow.dps !== undefined && shares !== null && shares > 0) {
      const alt = flow.dps * shares;
      if (alt > 0 && Math.abs(flow.dividends / alt - 1) > DIV_WINDOW_MISMATCH) flow.dividends = alt;
    }
    const divKnown = flow.dividends !== undefined || (flow.dps !== undefined && shares !== null);
    const divUnknown = !divKnown && this.dividendSeen(asOf, E);
    // 배당 삭감 표시는 최근 6개 회계연도 + 그 앞 한 해(첫 쌍의 앞앞 해)를 본다
    const hist = this.annualHistory(asOf, 7);
    const annual = hist.slice(-6);
    const cut = this.dividendCut(asOf, hist);
    return normalizeInputs({ flow, bal, balYearAgo, annual, shares, period, ...(divUnknown ? { divUnknown: true } : {}), ...(cut ? { dividendCut: true } : {}) });
  }

  /**
   * 최근 5년 가운데 1주당 배당이 앞 해보다 줄어든 해가 있는지 (설계 value-v1 §12 dividendCut, 표시만):
   *  - 회계연도(연간 이력의 기간 끝) 최근 6개 → 이웃한 두 해 5쌍. 두 해 모두 연간 주당배당(선언액·지급액 태그) 값이 있을 때만 비교한다 —
   *    배당을 아예 멈춘 해는 SEC 에 주당배당 줄이 없는 일이 많아 알 수 없다 (0 으로 보고했으면 줄어든 것으로 센다)
   *  - 주식 분할·병합: 앞 해 값이 분할 전 보고서에만 있으면 주당배당과 주식 수가 모두 분할 전 기준이다. 두 해 희석 주식 수가 한 해에
   *    40% 넘게 바뀌었으면 그 배수(가장 가까운 흔한 배수 SPLIT_RATIOS 로 맞춤 — 10:1 은 10, splitFactor)로 맞춰 비교한다 (10:1 분할 뒤
   *    1/10 이 된 주당배당을 '줄었다'고 하지 않게 — 그해 합병으로 주식 수가 크게 늘며 배당을 줄인 드문 경우는 놓칠 수 있다)
   *  - 앞 해의 99% 밑이면 줄어든 해 (반올림 차이는 빼고). 앞 해가 앞앞 해보다 25% 넘게 뛰었으면(특별배당·일시 배당일 수 있음) 앞앞 해
   *    수준의 99% 밑일 때만 — 특별배당을 준 해 다음 해를 '줄어든 해'로 세지 않는다 (COST 2024 특별배당 15달러 → 2025, FAST·WRB·CTAS·F 도
   *    같은 모양 — 검토 지적). 정기 배당을 한 해에 25% 넘게 올렸다가 조금 줄인 해는 놓칠 수 있다 (문서 14장 10, dividendCutOf)
   */
  dividendCut(asOf: string, annual: readonly AnnualPoint[] = this.annualHistory(asOf, 7)): boolean {
    return dividendCutOf(this.dividendYears(asOf, annual));
  }

  /** 최근 7개 회계연도의 연간 주당배당·희석 주식 수 (배당 삭감 표시용) */
  dividendYears(asOf: string, annual: readonly AnnualPoint[] = this.annualHistory(asOf, 7)): Array<{ end: string; dps: number | null; shares: number | null }> {
    const dps = this.annualFlow("dps", asOf);
    const near = (end: string): number | null => {
      if (dps.has(end)) return dps.get(end)!;
      for (const [e, v] of dps) if (Math.abs(daysBetween(e, end)) <= 7) return v;
      return null;
    };
    return annual.slice(-7).map((a) => ({ end: a.end, dps: dps.size ? near(a.end) : null, shares: a.shares }));
  }

  /** 연간 이력 (오래된 → 최신, 최대 6개): 회계연도는 순이익 연간 값의 기간 끝으로 정한다 */
  annualHistory(asOf: string, max = 6): AnnualPoint[] {
    const ni = this.annualFlow("netIncome", asOf);
    const rev = this.annualFlow("revenue", asOf);
    const nii = this.annualFlow("nii", asOf);
    const nonii = this.annualFlow("nonii", asOf);
    const op = this.annualFlow("opIncome", asOf);
    const sh = this.annualShares(asOf);
    const near = (m: Map<string, number>, end: string): number | null => {
      if (m.has(end)) return m.get(end)!;
      for (const [e, v] of m) if (Math.abs(daysBetween(e, end)) <= 7) return v;
      return null;
    };
    const ends = [...ni.keys()].sort().slice(-max);
    return ends.map((end) => ({
      end,
      revenue: near(rev, end) ?? (near(nii, end) !== null && near(nonii, end) !== null ? near(nii, end)! + near(nonii, end)! : null),
      opIncome: near(op, end),
      netIncome: ni.get(end) ?? null,
      shares: near(sh, end),
      assets: this.instant("assets", asOf, end, 7),
      equity: this.instant("equity", asOf, end, 7),
    }));
  }

  /** 제출일 목록 (asOf 이전, 오래된 → 최신) — 자기 과거 비교에서 보고서가 바뀐 때를 찾는다 */
  filings(): string[] {
    const set = new Set<string>();
    for (const r of this.c.flows.netIncome ?? []) set.add(r[3]);
    return [...set].sort();
  }
}

/** 회계연도 값: 1년 길이이고 연간 보고서(10-K)에 나온 기간 */
const isFY = (p: Point) => spanKind(p.start, p.end) === "Y" && p.annualForm;

/**
 * 빠진 칸 채우기 (대상 종목·비교 회사 공통 — 같은 정의로):
 *  - 지배주주 자본이 없으면 자본총계(비지배지분 포함) − 비지배지분 (AVGO 는 2019년 뒤로 자본총계만 보고)
 *  - 부채총계가 없으면 자산총계 − 자본총계 (기존 edgar.ts 와 같은 규칙)
 *  - 매출 합계가 없으면(은행) 순이자이익 + 비이자이익
 */
export function normalizeInputs(inp: ValueInputs): ValueInputs {
  const b = { ...inp.bal };
  const f = { ...inp.flow };
  const nci = b.nci ?? 0;
  if (b.equity === undefined && b.equityTotal !== undefined) b.equity = b.equityTotal - nci;
  if (b.liabilities === undefined && b.assets !== undefined) {
    const eq = b.equityTotal ?? (b.equity !== undefined ? b.equity + nci : undefined);
    if (eq !== undefined) b.liabilities = b.assets - eq;
  }
  if (f.revenue === undefined && f.nii !== undefined && f.nonii !== undefined) f.revenue = f.nii + f.nonii;
  return { ...inp, bal: b, flow: f };
}

/** 배당 창이 365일에서 이만큼(일) 넘게 벗어나면 52/53주 회계연도 창으로 본다 (윤년 366·52주 364 는 안) */
export const DIV_WINDOW_TOLERANCE_DAYS = 3;
/** 그 창에서 현금 배당이 주당배당 × 주식 수와 이 비율보다 크게 다르면 주당배당 × 주식 수를 쓴다 */
export const DIV_WINDOW_MISMATCH = 0.15;

/** ttmFrom 이 '직전 연간 + 올해 누적 − 작년 같은 기간 누적'으로 만든 창의 날 수 (연간 값이면 null, 만들 수 없으면 null) */
function ttmWindow(s: Map<string, Point>, E: string): number | null {
  const at = [...s.values()].filter((p) => p.end === E && p.start);
  if (at.find(isFY)) return null;
  const ytd = at
    .filter((p) => ["Q", "H", "9M"].includes(spanKind(p.start, p.end)))
    .sort((a, b) => daysBetween(b.start!, b.end) - daysBetween(a.start!, a.end))[0];
  if (!ytd) return null;
  const S = ytd.start!;
  const fyPrev = [...s.values()].find((p) => isFY(p) && Math.abs(daysBetween(p.end, addDays(S, -1))) <= 7);
  const len = daysBetween(ytd.start!, ytd.end);
  const prevEnd = addDays(E, -365);
  const ytdPrev = [...s.values()].find((p) => p.start && Math.abs(daysBetween(p.end, prevEnd)) <= 12 && Math.abs(daysBetween(p.start, p.end) - len) <= 12);
  if (!fyPrev || !ytdPrev) return null;
  return daysBetween(ytdPrev.end, fyPrev.end) + daysBetween(ytd.start!, E) + 1;
}

/**
 * 기간 값 묶음에서 E 까지의 최근 4분기 값. startFill(배당만): 작년 같은 기간 누적 줄이 없으면 그때는 배당이 없었던 것으로 본다 —
 * 올해 처음 배당한 회사(META 2024: 직전 연간·작년 같은 기간 줄 모두 없음 → 올해 누적 그대로)나 작년 그 기간 뒤에 배당을 시작한 회사
 * (직전 연간 + 올해 누적). 직전 연간만 없고 작년 같은 기간 줄은 있으면 앞뒤가 맞지 않아 만들지 않는다
 */
function ttmFrom(s: Map<string, Point>, E: string, startFill = false): number | null {
  const at = [...s.values()].filter((p) => p.end === E && p.start);
  const annual = at.find(isFY);
  if (annual) return annual.val;
  // 올해 누적 (가장 긴 연간 미만 기간)
  const ytd = at
    .filter((p) => ["Q", "H", "9M"].includes(spanKind(p.start, p.end)))
    .sort((a, b) => daysBetween(b.start!, b.end) - daysBetween(a.start!, a.end))[0];
  if (!ytd) return null;
  const S = ytd.start!;
  const fyPrev = [...s.values()].find((p) => isFY(p) && Math.abs(daysBetween(p.end, addDays(S, -1))) <= 7);
  const len = daysBetween(ytd.start!, ytd.end);
  const prevEnd = addDays(E, -365);
  const ytdPrev = [...s.values()].find((p) => p.start && Math.abs(daysBetween(p.end, prevEnd)) <= 12 && Math.abs(daysBetween(p.start, p.end) - len) <= 12);
  if (fyPrev && ytdPrev) return fyPrev.val + ytd.val - ytdPrev.val;
  if (startFill && !ytdPrev) return (fyPrev?.val ?? 0) + ytd.val;
  return null;
}
