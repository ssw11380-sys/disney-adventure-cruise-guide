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
/** 기간 길이(일) → 종류. 52/53주 회계연도의 13·14주 분기까지 */
function spanKind(start: string | null, end: string): "Q" | "H" | "9M" | "Y" | "other" | "instant" {
  if (!start) return "instant";
  const d = daysBetween(start, end) + 1;
  if (d >= 80 && d <= 100) return "Q";
  if (d >= 170 && d <= 200) return "H";
  if (d >= 260 && d <= 290) return "9M";
  if (d >= 350 && d <= 380) return "Y";
  return "other";
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
    const divKnown = flow.dividends !== undefined || (flow.dps !== undefined && shares !== null);
    const divUnknown = !divKnown && this.dividendSeen(asOf, E);
    return normalizeInputs({ flow, bal, balYearAgo, annual: this.annualHistory(asOf), shares, period, ...(divUnknown ? { divUnknown: true } : {}) });
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
