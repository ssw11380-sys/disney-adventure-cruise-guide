import { FLOW_KEYS, FLOW_TAGS, INSTANT_KEYS, INSTANT_TAGS, SHARE_TAGS, type FactTag, type FlowKey, type InstantKey } from "../analysis/valueConcepts.js";
import { addDays, daysBetween, normalizeInputs, type AnnualPoint, type ValueInputs } from "../analysis/secFacts.js";
import { computeAux, computeMetrics, type MetricAux } from "../analysis/valueMetrics.js";
import {
  buildLevels,
  encodeX,
  FISCAL_STALE_DAYS,
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
 *  - 재무: SEC frames (항목 하나·기간 하나의 전 회사 값 — 공공 자료). 회사마다 '가장 최근 회계연도'(CY 연간 틀) 값과 '최근 분기말' 잔액.
 *    가장 최근 회계연도는 최근 세 연간 틀(CY(Y)·CY(Y−1)·CY(Y−2)) 가운데 그 회사 값이 있는 가장 최근 것 — 1~3월에는 12월 결산 회사가
 *    아직 연간 보고서를 내지 않아 CY(Y−1) 이 비어 있으므로 CY(Y−2) 로 (결산이 18개월보다 오래되면 뺀다)
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
  /** 마지막 가격 (달러, 없으면 null) — 대상 종목의 SEC 주식 수 확인용 */
  price?: number | null;
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
    const price = Number(String(r["lastsale"] ?? "").replace(/[$,]/g, ""));
    out.push({
      symbol,
      name: typeof r["name"] === "string" ? r["name"] : "",
      marketCap: Number.isFinite(cap) && cap > 0 ? cap : null,
      sector: typeof r["sector"] === "string" ? r["sector"].trim() : "",
      industry: typeof r["industry"] === "string" ? r["industry"].trim() : "",
      price: String(r["lastsale"] ?? "").trim() && Number.isFinite(price) && price > 0 ? price : null,
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
  /** 기준일 (결산이 18개월보다 오래된 회사를 뺄 때) */
  refDate: string;
  /** 연간 틀 (오래된 → 최신): CY(Y−6) … CY(Y) — 가장 최근 회계연도가 CY(Y−2) 인 회사도 5년 이력이 되게 */
  annual: string[];
  /** 최근 분기말 (우선 → 대신): 기준일보다 50일 넘게 지난 가장 최근 분기말, 그 전 분기말 */
  latest: [string, string];
  /** 위 두 분기말의 1년 전 */
  yearAgo: [string, string];
  /** 연말 잔액 (자산·자본) CY(Y−6)Q4I … CY(Y−1)Q4I */
  yearEnd: string[];
}

export function referencePeriods(refDate: string): ReferencePeriods {
  const Y = Number(refDate.slice(0, 4));
  const annual = [6, 5, 4, 3, 2, 1, 0].map((k) => `CY${Y - k}`);
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
  return { refDate, annual, latest: [name(q1), name(q0)], yearAgo: [name(q1, 1), name(q0, 1)], yearEnd: [6, 5, 4, 3, 2, 1].map((k) => `CY${Y - k}Q4I`) };
}

/**
 * frames 로 받을 항목 목록 (태그·기간). 필요한 것만: 매출·영업이익·순이익은 7년, 주식 수는 6년(세 태그 — 대상 종목과 같은 정의), 나머지 흐름은
 * 최근 3개 연도 (가장 최근 회계연도가 CY(Y−2) 인 회사도 같은 항목이 있게). 모두 222번 (주식 수 세 태그 — 3단계에서 기본 주식 수를 더함, 문서 가치지표-계산.md 5장)
 */
export function framePlan(p: ReferencePeriods): Array<{ key: string; tag: FactTag; period: string }> {
  const out: Array<{ key: string; tag: FactTag; period: string }> = [];
  const last3 = p.annual.slice(-3);
  for (const k of FLOW_KEYS) {
    if (k === "dps") continue; // 비교 회사는 배당 지급액만 (주당 배당은 대상 종목에서 지급액이 없을 때만)
    const periods = k === "revenue" || k === "opIncome" || k === "netIncome" || k === "nii" || k === "nonii" ? p.annual : last3;
    // 순이익 대신 태그(ProfitLoss)는 최근 3개 연도만
    FLOW_TAGS[k].forEach((tag, i) => {
      for (const period of k === "netIncome" && i > 0 ? last3 : periods) out.push({ key: `flow:${k}`, tag, period });
    });
  }
  // 희석 주식 수: 대상 종목(companyfacts)과 같은 세 태그 — 앞 태그가 없는 회사는 '기본·희석 같음', 그것도 없으면 기본 주식 수 (주식 수 변화·주당이익 증가폭, 검토 지적)
  for (const tag of SHARE_TAGS) for (const period of p.annual.slice(-6)) out.push({ key: "shares", tag, period });
  for (const k of INSTANT_KEYS) for (const tag of INSTANT_TAGS[k]) for (const period of p.latest) out.push({ key: `inst:${k}`, tag, period });
  for (const k of ["equity", "assets"] as const) for (const period of [...p.yearAgo, ...p.yearEnd]) out.push({ key: `inst:${k}`, tag: INSTANT_TAGS[k][0]!, period });
  // 지배주주 자본을 따로 보고하지 않는 회사(AVGO)의 1년 전 자본
  for (const period of p.yearAgo) out.push({ key: "inst:equityTotal", tag: INSTANT_TAGS.equityTotal[0]!, period });
  return out;
}

/**
 * 받은 frames (`${tag}|${period}` → CIK → 값). 메모리를 아끼려고 값만 숫자로 두고, 기간 끝 날짜는 순이익 태그만 둔다
 * (회계연도 끝 맞추기에만 쓴다) — 한 번에 frames 222개 × 회사 수천 곳
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

/** 한 회사의 비교용 입력 (frames 에서). 최근 회계연도가 없거나(최근 세 연간 틀 모두 없음·결산 18개월 넘음) 최근 분기말 자산이 없으면 null */
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
  // 가장 최근 회계연도: 최근 세 연간 틀(CY(Y) → CY(Y−1) → CY(Y−2)) 가운데 이 회사 값이 있는 가장 최근 것.
  // 다만 그 값의 기간 끝이 한 해(두 해) 앞 틀 값과 같은 달·날(±10일)이 아니면 건너뛴다 — 아직 연간 보고서를 내지 않은 해의 틀에는
  // 10-Q 의 '최근 12개월' 줄(AMZN 2025-07~2026-06)이 들어오는 일이 있어서다. 1~3월(12월 결산 회사가 연간 보고서를 내기 전)에도
  // CY(Y−2) 값으로 비교 회사에 남는다 (예전에는 이때 대부분이 빠졌다)
  const years = p.annual;
  const n = years.length;
  const cands = [n - 1, n - 2, n - 3].map((i) => ({ i, r: first(FLOW_TAGS.netIncome, years[i]!) }));
  let k = -1;
  for (const c of cands) {
    if (!c.r) continue;
    const older = cands.find((o) => o.i < c.i && o.r);
    // 앞 값과 끝 날짜가 어긋나면 건너뛰되, 앞 값이 이미 18개월보다 오래되었으면(회계연도 끝을 바꾼 회사 등) 이 값을 쓴다
    const misaligned = older && Math.abs(daysBetween(addDays(older.r!.end, Math.round(365.25 * (c.i - older.i))), c.r.end)) > 10;
    if (misaligned && daysBetween(older!.r!.end, p.refDate) <= FISCAL_STALE_DAYS) continue;
    k = c.i;
    break;
  }
  if (k < 0) return null;
  const fyEnd = first(FLOW_TAGS.netIncome, years[k]!)!.end;
  // 결산이 18개월보다 오래된 회사는 뺀다 (대상 종목의 '최근 연간 재무가 18개월보다 오래됨'과 같은 기준)
  if (!fyEnd || daysBetween(fyEnd, p.refDate) > FISCAL_STALE_DAYS) return null;
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
      shares: first(SHARE_TAGS, period)?.val ?? null,
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
  /** 지난 비교 기준 (업종 자리 층을 두 주 연속 조건이 바뀌었을 때만 바꾸려고). 없으면 이번 주 조건 그대로 */
  prev?: ValueReferenceData | null;
}

/** 지난 기준과 층을 이어 쓰는 최대 간격 (이보다 오래된 기준이면 이번 주 조건 그대로) */
export const LEVEL_PREV_MAX_DAYS = 21;
/** 비교 회사 수 급감 막기: 지난 기준보다 이 비율 밑으로 줄면 저장하지 않는다 (모집단·일반 / 금융) */
export const REFERENCE_KEEP_RATIO = 0.85;
export const REFERENCE_KEEP_RATIO_FIN = 0.8;
/** 비교 기준: 7일 넘으면 다시 만들고, 14일 넘으면 점수 없음 ('비교 기준이 2주 넘게 갱신되지 않았습니다') */
export const REFERENCE_REBUILD_DAYS = 7;
export const REFERENCE_STALE_DAYS = 14;
/**
 * 새 기준을 거절하고 지난 기준을 지키는 것은 지난 기준이 이 일수까지일 때만 — 그보다 오래되면 새 기준을 받아들인다. 점수 없음 기준(14일)보다
 * 하루 짧게 두어, 새 기준을 거절하는 동안 지켜 둔 지난 기준이 '2주 넘게 갱신 안 됨 → 점수 없음'이 되지 않게 한다 (2단계는 35일이라
 * 15~35일 사이에 새 기준은 거절되고 지난 기준은 점수 없음이 되었다 — 검토 지적)
 */
export const REFERENCE_DROP_MAX_DAYS = REFERENCE_STALE_DAYS - 1;
/** 지표 채택 비율(값이 있는 회사 비율)이 지난 기준보다 이만큼(0~1, 10%p) 넘게 줄면 저장하지 않는다 — 주마다 흔들림은 1%p 안쪽 */
export const REFERENCE_COVERAGE_DROP = 0.1;
/** 빠지면 기준을 저장하지 않는 frames 태그 (순이익은 최근 세 연간 틀만 — 그 앞은 이력용) */
const KEY_FRAME_TAGS: ReadonlySet<string> = new Set([FLOW_TAGS.revenue[0].name, FLOW_TAGS.opIncome[0].name, INSTANT_TAGS.assets[0].name]);

/** 새 기준에서 받지 못한 핵심 frames: 순이익 CY(Y)·CY(Y−1)·CY(Y−2), 매출(Revenues)·영업이익·자산 (모든 기간) */
export function keyFramesMissing(next: Pick<ValueReferenceData, "missingFrames" | "periods">): string[] {
  const recent = new Set((next.periods?.annual ?? []).slice(-3));
  return (next.missingFrames ?? []).filter((k) => {
    const [tag, period] = k.split("|");
    return tag === FLOW_TAGS.netIncome[0].name ? recent.has(period ?? "") : KEY_FRAME_TAGS.has(tag ?? "");
  });
}

/**
 * 새 기준을 받아들이지 않을 까닭 (자료가 비어 한쪽으로 치우친 기준이 한 주 동안 쓰이지 않게 — 지난 기준을 그대로 쓴다):
 *  - 회사 수가 지난 기준보다 크게 줄었다 (모집단·일반 85%, 금융 80% 밑 — 예: 연간 보고서 철이 아닌데 틀이 비었을 때)
 *  - 핵심 frames(순이익 최근 세 해 · 매출 · 영업이익 · 자산)를 두 번 받아도 받지 못했다
 *  - 어느 지표든 채택 비율이 지난 기준보다 10%p 넘게 줄었다 (frames 가 비어 온 때)
 * 까닭 글, 아니면 null. 지난 기준이 없거나 13일보다 오래되었으면 null — 지난 기준이 점수 없음(14일 넘음)이 되기 전에 새 기준을 받아들인다
 */
export function referenceDrop(
  prev: (Pick<ValueReferenceData, "refDate" | "counts"> & Partial<Pick<ValueReferenceData, "coverage">>) | null | undefined,
  next: Pick<ValueReferenceData, "refDate" | "counts"> & Partial<Pick<ValueReferenceData, "coverage" | "missingFrames" | "periods">>,
): string | null {
  if (!prev || daysBetween(prev.refDate, next.refDate) > REFERENCE_DROP_MAX_DAYS) return null;
  const a = prev.counts;
  const b = next.counts;
  const fewer: string[] = [];
  if (b.universe < a.universe * REFERENCE_KEEP_RATIO) fewer.push(`모집단 ${a.universe} → ${b.universe}`);
  if (b.general < a.general * REFERENCE_KEEP_RATIO) fewer.push(`일반 ${a.general} → ${b.general}`);
  if (b.financial < a.financial * REFERENCE_KEEP_RATIO_FIN) fewer.push(`금융 ${a.financial} → ${b.financial}`);
  const other: string[] = [];
  const keys = keyFramesMissing({ missingFrames: next.missingFrames ?? [], periods: next.periods ?? { annual: [], latest: [], yearAgo: [] } });
  if (keys.length) other.push(`받지 못한 핵심 frames ${keys.join(", ")}`);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  for (const path of ["general", "financial"] as const)
    for (const k of METRIC_ORDER) {
      const was = prev.coverage?.[path]?.[k];
      if (was === undefined || !next.coverage) continue;
      const now = next.coverage[path]?.[k] ?? 0;
      if (was - now > REFERENCE_COVERAGE_DROP) other.push(`${path === "general" ? "일반" : "금융"} ${k} 채택 비율 ${pct(was)} → ${pct(now)}`);
    }
  if (fewer.length) return `비교 회사 수가 지난 기준(${prev.refDate})보다 크게 줄어 저장하지 않았습니다: ${[...fewer, ...other].join(", ")}`;
  if (other.length) return `새 비교 기준에 빠진 자료가 있어 저장하지 않았습니다(지난 기준 ${prev.refDate} 그대로): ${other.join(", ")}`;
  return null;
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
  const critical = [fk(FLOW_TAGS.netIncome[0], p.annual.at(-2)!), fk(FLOW_TAGS.netIncome[0], p.annual.at(-3)!), fk(INSTANT_TAGS.assets[0], p.latest[0])];
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
  const quotes: Record<string, [number, number]> = {};
  const pairs = new Map<string, readonly [string, string]>();
  const byCik = new Map<string, { row: ScreenerRow; cik: string }>();
  for (const r of screener) {
    symbols[r.symbol] = [idx(sectors, r.sector), idx(industries, r.industry)];
    pairs.set(`${r.sector}|${r.industry}`, [r.sector, r.industry]);
    if (r.marketCap && r.price) quotes[r.symbol] = [r.marketCap, r.price];
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
  // 업종 자리 층: 두 주 연속 조건이 바뀌어야 바뀐다 (지난 기준이 3주보다 오래되었으면 이번 주 조건 그대로)
  const prev = opts.prev && daysBetween(opts.prev.refDate, refDate) <= LEVEL_PREV_MAX_DAYS && opts.prev.refDate < refDate ? opts.prev.levels : null;
  const levels = buildLevels(peers, sectors, industries, pairs.values(), prev);
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
    quotes,
    levels,
  };
}
