import { FLOW_KEYS, FLOW_TAGS, INSTANT_KEYS, INSTANT_TAGS, SHARE_TAGS, type FactTag, type FlowKey, type InstantKey } from "../analysis/valueConcepts.js";
import { addDays, daysBetween, normalizeInputs, type AnnualPoint, type ValueInputs } from "../analysis/secFacts.js";
import { computeAux, computeMetrics, type MetricAux } from "../analysis/valueMetrics.js";
import {
  encodeX,
  isCyclical,
  isFinancial,
  METRIC_ORDER,
  quantile,
  REIT_INDUSTRY,
  SPAC_INDUSTRY,
  VALUE_VERSION,
  type PeerRow,
  type ValuePath,
  type ValueReferenceData,
  type ValueThresholds,
} from "../analysis/valueScore.js";

/**
 * 가치 지표 비교 기준 (3-44 2단계, 주 1회): 미국 상장 보통주의 지표 분포.
 *  - 회사 목록·업종·시가총액: Nasdaq 스크리너(로그인 없는 공개 JSON, 한 번에 약 7,000줄 — 리츠·스팩·우선주는 뺌)
 *  - 재무: SEC frames (항목 하나·기간 하나의 전 회사 값 — 공공 자료). 회사마다 '가장 최근 회계연도'(CY 연간 틀) 값과 '최근 분기말' 잔액
 *  - 티커 → CIK: SEC company_tickers.json
 *  - 시가총액 하위 20% 는 뺀다(아주 작은 회사의 들쭉날쭉한 숫자가 분포를 흔들지 않게). 금융사는 따로 모은다(일반 회사와 섞지 않음)
 * 한계(문서에 적음): 비교 회사의 흐름 값은 가장 최근 회계연도 값이라 대상 종목의 최근 4분기 값보다 최대 1년 앞선 숫자일 수 있다 —
 * frames 는 누적(6·9개월) 현금흐름을 주지 않아 최근 4분기를 만들 수 없다
 */

export interface ScreenerRow {
  symbol: string;
  name: string;
  marketCap: number | null;
  sector: string;
  industry: string;
}
export interface FrameRow {
  cik: number;
  start?: string;
  end: string;
  val: number;
}
export interface ReferenceSources {
  screener(): Promise<ScreenerRow[]>;
  /** 티커(대문자, SEC 표기 BRK-B) → CIK 10자리 */
  tickers(): Promise<Map<string, string>>;
  /** SEC frames 한 번. 그 기간 값이 없으면(404) 빈 배열, 받기 실패는 오류 */
  frame(tag: FactTag, period: string): Promise<FrameRow[]>;
}

/** 스크리너 원본(JSON) → 줄 (시가총액 문자열 → 숫자, 빈 칸은 null) */
export function parseScreener(raw: unknown): ScreenerRow[] {
  const rows = (((raw as { data?: { rows?: unknown } } | null)?.data?.rows ?? []) as Array<Record<string, unknown>>) || [];
  const out: ScreenerRow[] = [];
  for (const r of rows) {
    const symbol = typeof r["symbol"] === "string" ? r["symbol"].trim().toUpperCase() : "";
    if (!symbol) continue;
    const cap = Number(String(r["marketCap"] ?? "").replace(/[$,]/g, ""));
    out.push({
      symbol,
      name: typeof r["name"] === "string" ? r["name"] : "",
      marketCap: Number.isFinite(cap) && cap > 0 ? cap : null,
      sector: typeof r["sector"] === "string" ? r["sector"].trim() : "",
      industry: typeof r["industry"] === "string" ? r["industry"].trim() : "",
    });
  }
  return out;
}

/** frames 원본 → 줄 */
export function parseFrame(raw: unknown): FrameRow[] {
  const data = ((raw as { data?: unknown } | null)?.data ?? []) as Array<Record<string, unknown>>;
  const out: FrameRow[] = [];
  for (const r of Array.isArray(data) ? data : []) {
    const cik = Number(r["cik"]);
    const val = r["val"];
    const end = r["end"];
    if (!Number.isFinite(cik) || typeof val !== "number" || !Number.isFinite(val) || typeof end !== "string") continue;
    out.push({ cik, end, val, ...(typeof r["start"] === "string" ? { start: r["start"] } : {}) });
  }
  return out;
}

/** 스크리너 티커 → SEC 티커 표기 (BRK/B → BRK-B) */
export const secTicker = (s: string) => s.toUpperCase().replace(/\//g, "-");
/** 비교 회사에서 빼는 줄: 우선주(^)·워런트·유닛·권리, 리츠·스팩 업종 */
export function screenerExcluded(r: ScreenerRow): boolean {
  if (/\^/.test(r.symbol)) return true;
  if (r.industry === REIT_INDUSTRY || r.industry === SPAC_INDUSTRY) return true;
  if (/\b(warrants?|rights?|units?)\b/i.test(r.name) && !/common/i.test(r.name)) return true;
  if (/preferred|depositary shares? each representing .*preferred/i.test(r.name)) return true;
  return false;
}

export interface ReferencePeriods {
  /** 연간 틀 (오래된 → 최신): CY(Y−5) … CY(Y) */
  annual: string[];
  /** 최근 분기말 (우선 → 대신): 기준일보다 50일 넘게 지난 가장 최근 분기말, 그 전 분기말 */
  latest: [string, string];
  /** 위 두 분기말의 1년 전 */
  yearAgo: [string, string];
  /** 연말 잔액 (자산·자본) CY(Y−5)Q4I … CY(Y−1)Q4I */
  yearEnd: string[];
}

export function referencePeriods(refDate: string): ReferencePeriods {
  const Y = Number(refDate.slice(0, 4));
  const annual = [5, 4, 3, 2, 1, 0].map((k) => `CY${Y - k}`);
  // 분기말 후보: 올해·작년의 분기
  const qEnds: Array<{ y: number; q: number; date: string }> = [];
  for (const y of [Y - 1, Y])
    for (const q of [1, 2, 3, 4]) {
      const date = `${y}-${["03-31", "06-30", "09-30", "12-31"][q - 1]}`;
      qEnds.push({ y, q, date });
    }
  const ref = Date.parse(`${refDate}T00:00:00Z`);
  const ok = qEnds.filter((e) => (ref - Date.parse(`${e.date}T00:00:00Z`)) / 86_400_000 >= 50);
  const q1 = ok.at(-1)!;
  const q0 = ok.at(-2)!;
  const name = (e: { y: number; q: number }, back = 0) => `CY${e.y - back}Q${e.q}I`;
  return { annual, latest: [name(q1), name(q0)], yearAgo: [name(q1, 1), name(q0, 1)], yearEnd: [5, 4, 3, 2, 1].map((k) => `CY${Y - k}Q4I`) };
}

/** frames 로 받을 항목 목록 (태그·기간). 필요한 것만: 매출·영업이익·순이익·주식 수는 6년, 나머지 흐름은 최근 2개 연도 */
export function framePlan(p: ReferencePeriods): Array<{ key: string; tag: FactTag; period: string }> {
  const out: Array<{ key: string; tag: FactTag; period: string }> = [];
  const last2 = p.annual.slice(-2);
  for (const k of FLOW_KEYS) {
    if (k === "dps") continue; // 비교 회사는 배당 지급액만 (주당 배당은 대상 종목에서 지급액이 없을 때만)
    const periods = k === "revenue" || k === "opIncome" || k === "netIncome" || k === "nii" || k === "nonii" ? p.annual : last2;
    // 순이익 대신 태그(ProfitLoss)는 최근 2개 연도만
    FLOW_TAGS[k].forEach((tag, i) => {
      for (const period of k === "netIncome" && i > 0 ? last2 : periods) out.push({ key: `flow:${k}`, tag, period });
    });
  }
  for (const period of p.annual.slice(-5)) out.push({ key: "shares", tag: SHARE_TAGS[0]!, period });
  for (const k of INSTANT_KEYS) for (const tag of INSTANT_TAGS[k]) for (const period of p.latest) out.push({ key: `inst:${k}`, tag, period });
  for (const k of ["equity", "assets"] as const) for (const period of [...p.yearAgo, ...p.yearEnd]) out.push({ key: `inst:${k}`, tag: INSTANT_TAGS[k][0]!, period });
  // 지배주주 자본을 따로 보고하지 않는 회사(AVGO)의 1년 전 자본
  for (const period of p.yearAgo) out.push({ key: "inst:equityTotal", tag: INSTANT_TAGS.equityTotal[0]!, period });
  return out;
}

/**
 * 받은 frames (`${tag}|${period}` → CIK → 값). 메모리를 아끼려고 값만 숫자로 두고, 기간 끝 날짜는 순이익 태그만 둔다
 * (회계연도 끝 맞추기에만 쓴다) — 한 번에 frames 약 170개 × 회사 수천 곳
 */
export interface FrameData {
  val: Map<number, number>;
  end?: Map<number, string>;
}
export type FrameMap = Map<string, FrameData>;
const fk = (tag: FactTag, period: string) => `${tag.name}|${period}`;
/** frames 줄 → 저장 모양 (withEnd: 기간 끝 날짜도) */
export function frameData(rows: readonly FrameRow[], withEnd: boolean): FrameData {
  const val = new Map<number, number>();
  const end = withEnd ? new Map<number, string>() : undefined;
  for (const r of rows) {
    if (val.has(r.cik)) continue;
    val.set(r.cik, r.val);
    end?.set(r.cik, r.end);
  }
  return end ? { val, end } : { val };
}
const NI_TAGS = new Set<string>(FLOW_TAGS.netIncome.map((t) => t.name));

/** 한 회사의 비교용 입력 (frames 에서). 최근 회계연도가 없거나 최근 분기말 자산이 없으면 null */
export function peerInputs(cik: number, frames: FrameMap, p: ReferencePeriods): ValueInputs | null {
  const get = (tag: FactTag, period: string): { val: number; end: string } | undefined => {
    const f = frames.get(fk(tag, period));
    const val = f?.val.get(cik);
    return val === undefined ? undefined : { val, end: f!.end?.get(cik) ?? "" };
  };
  const first = (tags: readonly FactTag[], period: string): { val: number; end: string } | undefined => {
    for (const t of tags) {
      const r = get(t, period);
      if (r) return r;
    }
    return undefined;
  };
  // 가장 최근 회계연도: CY(Y−1) 값이 기준. CY(Y) 값은 그 기간 끝이 한 해 앞 값과 같은 달·날(±10일)일 때만 —
  // 10-Q 의 '최근 12개월' 줄(AMZN 2025-07~2026-06)이 CY(Y) 틀에 들어오는 일이 있어서다
  const years = p.annual;
  const Y1 = years.length - 2;
  const prevFy = first(FLOW_TAGS.netIncome, years[Y1]!);
  const curFy = first(FLOW_TAGS.netIncome, years[Y1 + 1]!);
  const sameFyEnd = (a: string, b: string) => Math.abs(daysBetween(addDays(a, 365), b)) <= 10;
  let k = -1;
  if (curFy && (!prevFy || sameFyEnd(prevFy.end, curFy.end))) k = Y1 + 1;
  else if (prevFy) k = Y1;
  if (k < 0) return null;
  const fyEnd = first(FLOW_TAGS.netIncome, years[k]!)!.end;
  // 최근 분기말: 우선 분기에 자산이 있으면 그 분기, 없으면 대신 분기 (한 회사는 한 분기로)
  const qFound = get(INSTANT_TAGS.assets[0]!, p.latest[0]) ? 0 : get(INSTANT_TAGS.assets[0]!, p.latest[1]) ? 1 : -1;
  if (qFound < 0) return null;
  const qi = qFound as 0 | 1;
  const flow: ValueInputs["flow"] = {};
  for (const key of FLOW_KEYS) {
    if (key === "dps") continue;
    const r = first(FLOW_TAGS[key], years[k]!);
    if (r) flow[key as FlowKey] = r.val;
  }
  const bal: ValueInputs["bal"] = {};
  for (const key of INSTANT_KEYS) {
    const r = first(INSTANT_TAGS[key], p.latest[qi]!);
    if (r) bal[key as InstantKey] = r.val;
  }
  const balYearAgo: ValueInputs["balYearAgo"] = {};
  const eqYa = get(INSTANT_TAGS.equity[0]!, p.yearAgo[qi]!);
  const asYa = get(INSTANT_TAGS.assets[0]!, p.yearAgo[qi]!);
  const etYa = get(INSTANT_TAGS.equityTotal[0]!, p.yearAgo[qi]!);
  if (eqYa) balYearAgo.equity = eqYa.val;
  else if (etYa) balYearAgo.equity = etYa.val;
  if (asYa) balYearAgo.assets = asYa.val;
  // 연간 이력: k 까지 최대 6개 (자산·자본은 그해 12월 말 잔액 — 최근 해는 최근 분기말)
  const annual: AnnualPoint[] = [];
  for (let i = 0; i <= k; i++) {
    const period = years[i]!;
    const ni = first(FLOW_TAGS.netIncome, period);
    // 그 회사 회계연도 끝(최근 연도 끝에서 k−i 년 전, ±10일)과 맞는 값만
    if (!ni || Math.abs(daysBetween(addDays(fyEnd, -Math.round(365.25 * (k - i))), ni.end)) > 10) continue;
    const rev = first(FLOW_TAGS.revenue, period)?.val;
    const nii = first(FLOW_TAGS.nii, period)?.val;
    const nonii = first(FLOW_TAGS.nonii, period)?.val;
    const yearEnd = p.yearEnd.find((x) => x.startsWith(`${period}Q4`));
    const isLast = i === k;
    annual.push({
      end: ni.end,
      revenue: rev ?? (nii !== undefined && nonii !== undefined ? nii + nonii : null),
      opIncome: first(FLOW_TAGS.opIncome, period)?.val ?? null,
      netIncome: ni.val,
      shares: get(SHARE_TAGS[0]!, period)?.val ?? null,
      assets: isLast ? (bal.assets ?? null) : yearEnd ? (get(INSTANT_TAGS.assets[0]!, yearEnd)?.val ?? null) : null,
      equity: isLast ? (bal.equity ?? null) : yearEnd ? (get(INSTANT_TAGS.equity[0]!, yearEnd)?.val ?? null) : null,
    });
  }
  return normalizeInputs({ flow, bal, balYearAgo, annual, shares: null, period: null });
}

/** 한 값 목록의 분위수 기준 */
function thresholdsOf(auxs: MetricAux[]): ValueThresholds {
  const sorted = (f: (a: MetricAux) => number | null) =>
    auxs
      .map(f)
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .sort((a, b) => a - b);
  return {
    opMarginStdP70: quantile(sorted((a) => a.opMarginStd), 0.7),
    niToAvg5P90: quantile(sorted((a) => a.niToAvg5), 0.9),
    nonOpP95: quantile(sorted((a) => a.nonOpRatio), 0.95),
    sbcP90: quantile(sorted((a) => a.sbcToRevenue), 0.9),
    equityToAssetsP5: quantile(sorted((a) => (a.equityToAssets !== null && a.equityToAssets > 0 ? a.equityToAssets : null)), 0.05),
    coverageP50: quantile(sorted((a) => a.coverage), 0.5),
    taxRateP50: quantile(sorted((a) => a.taxRate), 0.5) ?? 0.21,
  };
}

export interface BuildOptions {
  /** frames 요청 사이 쉼 (SEC 초당 10회 제한 — 기본 0.25초) */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * 비교 기준 만들기 (주 1회). 받기 실패한 frames 는 한 번 더 받아 보고, 그래도 안 되면 빠진 목록에 적는다.
 * 핵심(최근 회계연도 순이익·최근 분기말 자산)을 못 받으면 오류 — 부르는 쪽은 지난 기준을 그대로 쓴다
 */
export async function buildReferenceData(src: ReferenceSources, refDate: string, opts: BuildOptions = {}): Promise<ValueReferenceData> {
  const pause = opts.pauseMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const p = referencePeriods(refDate);
  const screener = await src.screener();
  if (screener.length < 500) throw new Error(`스크리너 줄이 너무 적습니다: ${screener.length}`);
  await sleep(pause);
  const tickers = await src.tickers();
  const frames: FrameMap = new Map();
  const missing: string[] = [];
  for (const item of framePlan(p)) {
    const key = fk(item.tag, item.period);
    if (frames.has(key)) continue;
    await sleep(pause);
    let rows: FrameRow[] | null = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      try {
        rows = await src.frame(item.tag, item.period);
      } catch (e) {
        if (attempt === 0) await sleep(Math.max(pause * 8, 2_000));
        else opts.log?.(`frames 받기 실패 ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (rows === null) {
      missing.push(key);
      continue;
    }
    frames.set(key, frameData(rows, NI_TAGS.has(item.tag.name)));
  }
  const critical = [fk(FLOW_TAGS.netIncome[0], p.annual.at(-2)!), fk(INSTANT_TAGS.assets[0], p.latest[0])];
  if (critical.some((k) => missing.includes(k))) throw new Error(`핵심 frames 를 받지 못했습니다: ${critical.filter((k) => missing.includes(k)).join(", ")}`);

  // 회사 목록: 스크리너 → CIK, 같은 회사(여러 종류 주식)는 시가총액이 큰 줄 하나
  const sectors: string[] = [];
  const industries: string[] = [];
  const idx = (list: string[], v: string) => {
    let i = list.indexOf(v);
    if (i < 0) i = list.push(v) - 1;
    return i;
  };
  const symbols: Record<string, [number, number]> = {};
  const byCik = new Map<string, { row: ScreenerRow; cik: string }>();
  for (const r of screener) {
    symbols[r.symbol] = [idx(sectors, r.sector), idx(industries, r.industry)];
    if (screenerExcluded(r) || !r.marketCap) continue;
    const cik = tickers.get(secTicker(r.symbol));
    if (!cik) continue;
    const prev = byCik.get(cik);
    if (!prev || (r.marketCap ?? 0) > (prev.row.marketCap ?? 0)) byCik.set(cik, { row: r, cik });
  }
  // 재무가 있는 회사 → 시가총액 하위 20% 빼기
  const withData: Array<{ row: ScreenerRow; cik: string; inp: ValueInputs }> = [];
  for (const { row, cik } of byCik.values()) {
    const inp = peerInputs(Number(cik), frames, p);
    if (inp) withData.push({ row, cik, inp });
  }
  const caps = withData.map((w) => w.row.marketCap!).sort((a, b) => a - b);
  const cut = quantile(caps, 0.2) ?? 0;
  const universe = withData.filter((w) => w.row.marketCap! >= cut);

  // 1차: 보조 값·경로 → 시장 기준값
  const first = universe.map((w) => {
    const aux = computeAux(w.inp);
    const financial = isFinancial(w.row.industry || null, w.inp.bal);
    return { ...w, aux, financial };
  });
  const thresholds = thresholdsOf(first.filter((w) => !w.financial).map((w) => w.aux));
  thresholds.taxRateP50 = thresholdsOf(first.map((w) => w.aux)).taxRateP50;

  // 2차: 지표 값
  const peers: PeerRow[] = [];
  const coverage: ValueReferenceData["coverage"] = { general: {}, financial: {} };
  const counts: Record<ValuePath, number> = { general: 0, financial: 0 };
  const have: Record<ValuePath, Record<string, number>> = { general: {}, financial: {} };
  for (const w of first) {
    const path: ValuePath = w.financial ? "financial" : "general";
    const metrics = computeMetrics(w.inp, w.row.marketCap!, {
      financial: w.financial,
      cyclical: !w.financial && isCyclical(w.row.industry || null, w.aux.opMarginStd, thresholds),
      medianTaxRate: thresholds.taxRateP50,
      smallEquityCut: thresholds.equityToAssetsP5,
      medianCoverage: thresholds.coverageP50,
    });
    counts[path]++;
    for (const k of METRIC_ORDER) if (metrics[k] && metrics[k]!.x !== null) have[path][k] = (have[path][k] ?? 0) + 1;
    peers.push({
      c: w.cik,
      t: w.row.symbol,
      s: idx(sectors, w.row.sector),
      i: idx(industries, w.row.industry),
      f: w.financial ? 1 : 0,
      x: METRIC_ORDER.map((k) => encodeX(metrics[k]?.x ?? null)),
    });
  }
  for (const path of ["general", "financial"] as const) for (const k of METRIC_ORDER) if (counts[path]) coverage[path][k] = Math.round((1000 * (have[path][k] ?? 0)) / counts[path]) / 1000;
  opts.log?.(`비교 기준: 스크리너 ${screener.length} · CIK ${byCik.size} · 재무 ${withData.length} · 모집단 ${universe.length} (일반 ${counts.general} · 금융 ${counts.financial}) · 빠진 frames ${missing.length}`);
  return {
    v: 1,
    method: VALUE_VERSION,
    market: "US",
    refDate,
    screenerDate: refDate,
    periods: { annual: p.annual, latest: [...p.latest], yearAgo: [...p.yearAgo] },
    sectors,
    industries,
    symbols,
    peers,
    thresholds,
    coverage,
    counts: { screener: screener.length, mapped: byCik.size, withData: withData.length, universe: universe.length, general: counts.general, financial: counts.financial },
    missingFrames: missing,
  };
}
