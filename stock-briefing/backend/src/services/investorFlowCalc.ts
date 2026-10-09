import { seoulIso } from "../lib/time.js";
import type { FlowTrendRow, InvestorFlowDay } from "../providers/market/investorFlow.js";

/**
 * 수급 탭 계산 (3-33, 플래그 flowTab) — 순수 함수. 설계서 4.2:
 *  - 확정 판정: 받은 때(fetchedAt) 기준 — 그때 지난 날은 확정, 앞날은 잠정, 그날 줄은 장이 끝나고 저녁 값이 나온 뒤(20:30 KST)에 받았을 때만 확정.
 *    지금 시각이 아니라 받은 때로 본다: 전에 받은 값을 다음 날 다시 줄 때 장중에 받은 잠정 값이 확정으로 바뀌어 합계에 들어가지 않게
 *  - 합계: 확정 줄 앞에서 5·20·60개 (빈 값은 빼고 더하고 그 날 수를 missing 에)
 *  - 외국인 보유율: 지금 값과 합계 창 바로 앞날 값의 차이, 61점 선(오래된 순)
 *  - 외국인 한도(토스 웹만): 한도가 있는지는 그 줄의 보유율로만 판정(한도가 상장 주식 수의 99.5% 미만), 한도율은 상장 주식 수(토스 웹 종목 정보 —
 *    그 줄과 같은 날 값일 때만)로 다듬고, 모르면 보유율로 어림하고 오차가 크면 뺌
 *  - 대조: 토스 웹 확정 줄 최근 20일(오늘 빼고)과 토스 Open API 같은 날짜의 개인·외국인·기관 세 값 (Open API 값이 빈 날은 세지 않음)
 */

export type FlowSourceName = "toss-web" | "naver";
export const FLOW_PERIODS = [5, 20, 60] as const;
export type FlowPeriodKey = "5" | "20" | "60";

/** 오늘 줄을 확정으로 보는 시각 (KST 분) — 토스 Open API 문서 '확정치는 해당 일자 저녁', 실측 updatedAt 18:19~20:16 에 여유 15분 */
export const FLOW_FINAL_MIN = 20 * 60 + 30;
/** 토스 웹 오늘 줄의 updatedAt 이 이 시각(KST 분) 뒤여야 확정 (장중·장 마감 직후 잠정값이 아닌지) */
export const FLOW_UPDATED_MIN = 18 * 60;
/** 막대·표에 주는 확정 줄 수 */
export const FLOW_DAYS_MAX = 60;
/** 대조하는 최근 확정 날 수 */
export const FLOW_CHECK_DAYS = 20;

export interface FlowSum {
  individual: number | null;
  foreign: number | null;
  institution: number | null;
  otherCorp: number | null;
  /** 더한 날 수 (확정 줄이 모자라면 그만큼) */
  days: number;
  /** 값이 빠진 칸이 있어 빼고 더한 날 수 */
  missing: number;
}

export interface FlowRatioAgo {
  value: number;
  date: string;
  /** 지금 − 그때 (%p, 소수 둘째 자리) */
  change: number;
}

export interface FlowRatio {
  now: number;
  date: string;
  ago: Record<FlowPeriodKey, FlowRatioAgo | null>;
  /** [날짜, 보유율] 오래된 순, 최대 61점 (첫 점 = 60일 전 값) */
  series: Array<[string, number]>;
  high: number;
  low: number;
}

export interface FlowLimit {
  /** 한도 ÷ 상장 주식 수 (%) — 상장 주식 수를 알면 소수 둘째 자리(49.99), 보유율로 어림하면 첫째 자리 */
  limitPct: number;
  /** 보유 ÷ 한도 (%, 소수 한 자리) */
  usedPct: number;
}

export interface FlowDayOut {
  date: string;
  individual: number | null;
  foreign: number | null;
  institution: number | null;
  otherCorp: number | null;
  foreignRatio: number | null;
  close: number | null;
}

export interface FlowToday {
  date: string;
  updatedAt: string | null;
  individual: number | null;
  foreign: number | null;
  institution: number | null;
}

export interface FlowCheck {
  at: string;
  days: number;
  same: number;
}

export interface InvestorFlowBody {
  code: string;
  supported: true;
  source: FlowSourceName;
  basis: "KRX+NXT" | "KRX";
  /** 가장 최근 확정 줄을 출처가 고친 시각 (네이버·시각 없음은 받은 시각) */
  asOf: string;
  fetchedAt: string;
  /** 새로 받지 못해 전에 받은 값을 준 경우 */
  stale: boolean;
  /** 오늘 잠정 값 (합계·막대에 넣지 않음) */
  today: FlowToday | null;
  /** 확정 줄, 최신순, 최대 60 */
  days: FlowDayOut[];
  sums: Record<FlowPeriodKey, FlowSum>;
  ratio: FlowRatio | null;
  limit: FlowLimit | null;
  /** 토스 Open API 원자료와 대조한 개수 (토스 웹 자료일 때만, 키 없거나 대조 전이면 null) */
  check: FlowCheck | null;
}

export interface InvestorFlowUnsupported {
  code: string;
  supported: false;
  reason: string;
}

export type InvestorFlowResponse = InvestorFlowBody | InvestorFlowUnsupported;

/** 한국 시간 날짜·분·요일(0 일요일) */
export function kst(d: Date): { date: string; minutes: number; weekday: number } {
  const iso = seoulIso(d); // YYYY-MM-DDTHH:MM:SS+09:00
  const date = iso.slice(0, 10);
  const minutes = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  const weekday = new Date(`${date}T12:00:00+09:00`).getUTCDay();
  return { date, minutes, weekday };
}

/** 줄이 확정 값인지 (설계서 4.2). at = 그 줄을 받은 때 (받은 뒤에는 값이 바뀌지 않으므로 받은 때 기준으로 본다) */
export function isFinalRow(row: FlowTrendRow, source: FlowSourceName, at: Date): boolean {
  const k = kst(at);
  if (row.date < k.date) return true;
  if (row.date > k.date) return false; // 시계 어긋남 — 잠정으로
  if (k.minutes < FLOW_FINAL_MIN) return false;
  if (source === "naver") return true;
  if (row.inMarketTime !== false || row.hasAll !== true || !row.updatedAt) return false;
  const u = Date.parse(row.updatedAt);
  if (!Number.isFinite(u)) return false;
  const uk = kst(new Date(u));
  return uk.date > row.date || (uk.date === row.date && uk.minutes >= FLOW_UPDATED_MIN);
}

/**
 * 확정 줄(최신순, 날짜 겹치면 앞의 것)과 오늘 잠정 줄 하나.
 * 확정은 받은 때(fetchedAt) 기준. 잠정 줄은 그 날짜가 지금(now) 한국 날짜와 같을 때만 today 로 준다 —
 * 전에 받은 값을 다음 날 다시 줄 때 어제의 잠정 줄은 합계에도 '오늘' 줄에도 넣지 않는다
 */
export function splitFlowRows(rows: readonly FlowTrendRow[], source: FlowSourceName, fetchedAt: Date, now: Date = fetchedAt): { final: FlowTrendRow[]; today: FlowTrendRow | null } {
  const seen = new Set<string>();
  const uniq: FlowTrendRow[] = [];
  for (const r of rows) {
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    uniq.push(r);
  }
  uniq.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const final: FlowTrendRow[] = [];
  let today: FlowTrendRow | null = null;
  const nowDate = kst(now).date;
  for (const r of uniq) {
    if (isFinalRow(r, source, fetchedAt)) final.push(r);
    else if (!today && r.date === nowDate) today = r;
  }
  return { final, today };
}

const SUM_KEYS = ["individual", "foreign", "institution", "otherCorp"] as const;

/** 확정 줄 앞에서 5·20·60개 합계 */
export function flowSums(final: readonly FlowTrendRow[], source: FlowSourceName): Record<FlowPeriodKey, FlowSum> {
  // 값이 빠졌는지 보는 칸: 네이버는 기타법인이 늘 없어 세 칸만
  const checked = source === "naver" ? SUM_KEYS.slice(0, 3) : SUM_KEYS;
  const one = (n: number): FlowSum => {
    const rows = final.slice(0, n);
    const out: FlowSum = { individual: null, foreign: null, institution: null, otherCorp: null, days: rows.length, missing: 0 };
    for (const r of rows) {
      if (checked.some((k) => r[k] === null)) out.missing++;
      for (const k of SUM_KEYS) {
        const v = r[k];
        if (v !== null) out[k] = (out[k] ?? 0) + v;
      }
    }
    return out;
  };
  return { "5": one(5), "20": one(20), "60": one(60) };
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f || 0;
};

/** 외국인 보유율: 지금 값, 5·20·60일 전(확정 줄 N번째 — 합계 창 바로 앞날), 61점 선 */
export function flowRatio(final: readonly FlowTrendRow[]): FlowRatio | null {
  const first = final[0];
  if (!first || first.foreignRatio === null) return null;
  const now = first.foreignRatio;
  const ago = {} as Record<FlowPeriodKey, FlowRatioAgo | null>;
  for (const n of FLOW_PERIODS) {
    const r = final[n];
    ago[String(n) as FlowPeriodKey] = r && r.foreignRatio !== null ? { value: r.foreignRatio, date: r.date, change: round(now - r.foreignRatio, 2) } : null;
  }
  const series = final
    .slice(0, FLOW_DAYS_MAX + 1)
    .filter((r): r is FlowTrendRow & { foreignRatio: number } => r.foreignRatio !== null)
    .map((r): [string, number] => [r.date, r.foreignRatio])
    .reverse();
  const values = series.map((s) => s[1]);
  return { now, date: first.date, ago, series, high: Math.max(...values), low: Math.min(...values) };
}

/** 한도가 없는 종목으로 보는 한도율 (한도 ÷ 상장 주식 수, %) — 이 이상이면 한도 = 상장 주식 수 */
export const FLOW_NO_LIMIT_PCT = 99.5;
/**
 * 보유율 칸은 소수 둘째 자리까지라(실측은 반올림 — 트리니티항공 0.4386% → 0.44, 버림일 수도 있어 넉넉히) 실제 값이 이만큼(%p) 다를 수 있다.
 * 보유율이 낮을수록 이 끝자리 차이가 한도율에서 크게 불어난다 (YTN 보유율 0.16% → 한도율 9.8%, 실제 10.00%)
 */
const RATIO_STEP = 0.01;
/** 상장 주식 수를 모를 때 보유율로 어림한 한도율의 오차가 이보다 크면(%p) 한도 줄을 뺀다 — 소수 한 자리로 보이는 값이 틀리지 않게 */
const LIMIT_EST_MAX_ERR = 0.05;
/** 보유율 칸의 반올림 폭 (소수 둘째 자리 반올림 — 실측 122630 0.5376% → 0.54 · 069500 22.555% → 22.56) + 수 오차 여유 */
const RATIO_HALF = RATIO_STEP / 2 + 1e-9;

/**
 * 상장 주식 수가 그 줄과 같은 날 값인지: 보유 ÷ 상장 주식 수가 그 줄의 보유율(소수 둘째 자리 반올림)과 맞을 때만.
 * 종목 정보는 24시간 기억하는데 ETF 는 설정·환매로 상장 주식 수가 날마다 바뀐다 (252670: 9/21 110.5억 → 9/22 106.1억 주)
 */
function sharesMatchRow(hold: number, ratio: number, listedShares: number): boolean {
  return Math.abs((hold / listedShares) * 100 - ratio) <= RATIO_HALF;
}

/**
 * 외국인 한도 (토스 웹 줄만 — 한도 칸이 있을 때). 한도가 상장 주식 수의 99.5% 이상이면(= 한도 없음) null. 소진율 = 보유 ÷ 한도.
 *  1. 한도가 있는지는 그 줄 안에서만 판정: 상장 주식 수 = 보유 ÷ 보유율 로 어림하되 보유율을 가장 크게(+0.01%p) 본 한도율도 99.5% 미만일 때만.
 *     다른 날 값일 수 있는 종목 정보의 상장 주식 수로는 판정하지 않는다 (ETF 에 없는 한도 92~99% 가 보이던 것). 보유율·보유가 0 이면 모름 → null
 *  2. 한도율: 상장 주식 수(토스 웹 종목 정보 sharesOutstanding)가 그 줄과 같은 날 값이면(sharesMatchRow) 한도 ÷ 상장 주식 수 (소수 둘째 자리 — 트리니티항공 49.99%)
 *  3. 아니면 보유율 어림 — 어림 오차(보유율 ±0.01%p 가 한도율에서 커진 폭)가 0.05%p 보다 크면 한도 줄을 뺀다 (소수 한 자리로 보임)
 */
export function flowLimit(row: FlowTrendRow, listedShares: number | null = null): FlowLimit | null {
  const { foreignHolding: hold, foreignLimit: limit, foreignRatio: ratio } = row;
  if (hold === null || limit === null || ratio === null || !(hold > 0) || !(limit > 0) || !(ratio > 0)) return null;
  const est = (r: number) => (limit * r) / hold;
  const hi = est(ratio + RATIO_STEP);
  if (!(hi < FLOW_NO_LIMIT_PCT)) return null;
  const usedPct = round((hold / limit) * 100, 1);
  if (listedShares !== null && listedShares > 0 && sharesMatchRow(hold, ratio, listedShares)) {
    const pct = (limit / listedShares) * 100;
    return pct < FLOW_NO_LIMIT_PCT ? { limitPct: round(pct, 2), usedPct } : null;
  }
  const mid = est(ratio);
  const lo = est(Math.max(0, ratio - RATIO_STEP));
  if (Math.max(hi - mid, mid - lo) > LIMIT_EST_MAX_ERR) return null;
  return { limitPct: round(mid, 1), usedPct };
}

export interface FlowCompare {
  days: number;
  same: number;
  /** 다른 날짜와 다른 칸 이름 (로그용 — 숫자 없음) */
  diffs: Array<{ date: string; fields: Array<"individual" | "foreign" | "institution"> }>;
  /** 날짜별 두 값 (관리 경로용) */
  rows: Array<{ date: string; same: boolean; fields: Array<"individual" | "foreign" | "institution">; web: Pick<FlowTrendRow, "individual" | "foreign" | "institution">; api: Pick<InvestorFlowDay, "individual" | "foreign" | "institution"> }>;
}

const CHECK_KEYS = ["individual", "foreign", "institution"] as const;

/**
 * 토스 웹 확정 줄 최근 days 개와 토스 Open API 같은 날짜의 세 값 비교 (두 쪽에 다 있는 날만 센다).
 * today(한국 날짜)를 주면 그날(과 그 뒤 날짜)은 빼고 센다 — Open API 의 오늘 값은 저녁까지 잠정이라 받은 때에 따라 다를 수 있다.
 * Open API 세 값 가운데 빈 값(null — 아직 나오지 않음)이 있는 날도 세지 않는다 (다른 날로 세지 않게)
 */
export function compareFlows(webFinal: readonly FlowTrendRow[], api: readonly InvestorFlowDay[], days = FLOW_CHECK_DAYS, o: { today?: string } = {}): FlowCompare {
  const byDate = new Map(api.map((d) => [d.date, d]));
  const out: FlowCompare = { days: 0, same: 0, diffs: [], rows: [] };
  const past = o.today ? webFinal.filter((w) => w.date < o.today!) : webFinal;
  for (const w of past.slice(0, days)) {
    const a = byDate.get(w.date);
    if (!a || CHECK_KEYS.some((k) => a[k] === null)) continue;
    out.days++;
    const fields = CHECK_KEYS.filter((k) => w[k] !== a[k]);
    if (fields.length === 0) out.same++;
    else out.diffs.push({ date: w.date, fields: [...fields] });
    out.rows.push({
      date: w.date,
      same: fields.length === 0,
      fields: [...fields],
      web: { individual: w.individual, foreign: w.foreign, institution: w.institution },
      api: { individual: a.individual, foreign: a.foreign, institution: a.institution },
    });
  }
  return out;
}

/** 캐시 유효 시간: 평일 08:00~21:00 KST 10분, 그 밖 60분 */
export function flowCacheTtlMs(now: Date): number {
  const k = kst(now);
  const weekday = k.weekday >= 1 && k.weekday <= 5;
  return weekday && k.minutes >= 8 * 60 && k.minutes < 21 * 60 ? 10 * 60_000 : 60 * 60_000;
}

/** 시각 글자를 한국 시간 ISO(초까지)로 — 못 읽으면 null */
function isoOrNull(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? seoulIso(new Date(t)) : null;
}

/** 받은 줄 → 응답 본문 */
export function buildFlowBody(o: {
  code: string;
  source: FlowSourceName;
  rows: readonly FlowTrendRow[];
  fetchedAt: Date;
  stale: boolean;
  check: FlowCheck | null;
  now: Date;
  /** 상장 주식 수 (토스 웹 종목 정보 — 한도율 계산, 모르면 null) */
  listedShares?: number | null;
}): InvestorFlowBody {
  const { final, today } = splitFlowRows(o.rows, o.source, o.fetchedAt, o.now);
  const fetchedAt = seoulIso(o.fetchedAt);
  const first = final[0];
  return {
    code: o.code,
    supported: true,
    source: o.source,
    basis: o.source === "toss-web" ? "KRX+NXT" : "KRX",
    asOf: (o.source === "toss-web" && first ? isoOrNull(first.updatedAt) : null) ?? fetchedAt,
    fetchedAt,
    stale: o.stale,
    today: today ? { date: today.date, updatedAt: isoOrNull(today.updatedAt), individual: today.individual, foreign: today.foreign, institution: today.institution } : null,
    days: final.slice(0, FLOW_DAYS_MAX).map((r) => ({ date: r.date, individual: r.individual, foreign: r.foreign, institution: r.institution, otherCorp: r.otherCorp, foreignRatio: r.foreignRatio, close: r.close })),
    sums: flowSums(final, o.source),
    ratio: flowRatio(final),
    limit: o.source === "toss-web" && first ? flowLimit(first, o.listedShares ?? null) : null,
    check: o.source === "toss-web" ? o.check : null,
  };
}
