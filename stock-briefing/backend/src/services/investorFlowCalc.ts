import { seoulIso } from "../lib/time.js";
import type { FlowTrendRow, InvestorFlowDay } from "../providers/market/investorFlow.js";

/**
 * 수급 탭 계산 (3-33, 플래그 flowTab) — 순수 함수. 설계서 4.2:
 *  - 확정 판정: 지난 날은 확정, 앞날은 잠정, 오늘은 장이 끝나고 저녁 값이 나온 뒤(20:30 KST)에만 확정
 *  - 합계: 확정 줄 앞에서 5·20·60개 (빈 값은 빼고 더하고 그 날 수를 missing 에)
 *  - 외국인 보유율: 지금 값과 합계 창 바로 앞날 값의 차이, 61점 선(오래된 순)
 *  - 외국인 한도(토스 웹만): 한도가 상장 주식 수의 99.5% 미만인 종목만 한도·소진율
 *  - 대조: 토스 웹 확정 줄 최근 20일과 토스 Open API 같은 날짜의 개인·외국인·기관 세 값
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
  /** 한도 ÷ 상장 주식 수 (%, 소수 한 자리) */
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

/** 줄이 확정 값인지 (설계서 4.2) */
export function isFinalRow(row: FlowTrendRow, source: FlowSourceName, now: Date): boolean {
  const k = kst(now);
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

/** 확정 줄(최신순, 날짜 겹치면 앞의 것)과 잠정 줄 하나(가장 최근) */
export function splitFlowRows(rows: readonly FlowTrendRow[], source: FlowSourceName, now: Date): { final: FlowTrendRow[]; today: FlowTrendRow | null } {
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
  for (const r of uniq) {
    if (isFinalRow(r, source, now)) final.push(r);
    else if (!today) today = r;
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

/** 외국인 한도 (토스 웹 줄만 — 한도 칸이 있을 때). 한도가 상장 주식 수의 99.5% 이상이면(= 한도 없음) null */
export function flowLimit(row: FlowTrendRow): FlowLimit | null {
  const { foreignHolding: hold, foreignLimit: limit, foreignRatio: ratio } = row;
  if (hold === null || limit === null || ratio === null || !(hold > 0) || !(limit > 0) || !(ratio > 0)) return null;
  const listed = hold / (ratio / 100);
  const limitPct = (limit / listed) * 100;
  if (!(limitPct < 99.5)) return null;
  return { limitPct: round(limitPct, 1), usedPct: round((hold / limit) * 100, 1) };
}

export interface FlowCompare {
  days: number;
  same: number;
  /** 다른 날짜와 다른 칸 이름 (로그용 — 숫자 없음) */
  diffs: Array<{ date: string; fields: Array<"individual" | "foreign" | "institution"> }>;
  /** 날짜별 두 값 (관리 경로용) */
  rows: Array<{ date: string; same: boolean; fields: Array<"individual" | "foreign" | "institution">; web: Pick<FlowTrendRow, "individual" | "foreign" | "institution">; api: Pick<InvestorFlowDay, "individual" | "foreign" | "institution"> }>;
}

/** 토스 웹 확정 줄 최근 days 개와 토스 Open API 같은 날짜의 세 값 비교 (두 쪽에 다 있는 날만 센다) */
export function compareFlows(webFinal: readonly FlowTrendRow[], api: readonly InvestorFlowDay[], days = FLOW_CHECK_DAYS): FlowCompare {
  const byDate = new Map(api.map((d) => [d.date, d]));
  const out: FlowCompare = { days: 0, same: 0, diffs: [], rows: [] };
  for (const w of webFinal.slice(0, days)) {
    const a = byDate.get(w.date);
    if (!a) continue;
    out.days++;
    const fields = (["individual", "foreign", "institution"] as const).filter((k) => w[k] !== a[k]);
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
export function buildFlowBody(o: { code: string; source: FlowSourceName; rows: readonly FlowTrendRow[]; fetchedAt: Date; stale: boolean; check: FlowCheck | null; now: Date }): InvestorFlowBody {
  const { final, today } = splitFlowRows(o.rows, o.source, o.now);
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
    limit: o.source === "toss-web" && first ? flowLimit(first) : null,
    check: o.source === "toss-web" ? o.check : null,
  };
}
