import type { KrFinanceTable, KrIntegration, KrRowKey } from "../providers/market/naverFinance.js";
import { addDays, daysBetween } from "./secFacts.js";
import type { MetricAux, MetricSet, MetricValue, MetricWhy } from "./valueMetrics.js";
import { buildLevels, encodeX, LITE_METRIC_ORDER, quantile, VALUE_VERSION, type PeerRow, type ValuePath, type ValueReferenceData } from "./valueScore.js";

/**
 * 한국 간이 가치 지표 (3-44 3단계, 설계 S4 '한국 간이 가치' · 가치지표-계산.md 18장) — 순수 함수, 네트워크 없음.
 *  - 재무: 네이버 증권 재무 요약(연간 3개 결산 · 분기 5개, 실적 열만 — 증권사 추정 열은 파서가 버림). 금액 억원, 주당 값 원, 비율 %
 *  - 흐름(매출·영업이익·지배주주순이익·EPS)은 최근 4개 분기 합, 잔액(BPS·부채비율·당좌비율)은 최근 분기, 성장은 연간 2년(3개 결산), 배당은 최근 결산
 *  - 미래 자료를 섞지 않게: 분기는 끝난 뒤 45일(분기·반기 보고서 기한), 연간은 90일(사업보고서 기한)이 지나야 쓴다 (설계 B11).
 *    다만 같은 공시로 함께 나오는 4분기 열을 쓸 수 있으면(+45일) 연간 열도 그날부터 쓴다 (krAnnualAvailable). 새로 받을 때 표에서 빠진
 *    앞 결산·분기는 이어 둔다 (mergeKrFacts — 연간 5개·분기 8개)
 *  - 가격 대비 값은 주당 값으로(EPS·BPS ÷ 20거래일 평균 주가) — 네이버 EPS·BPS 는 우선주를 합친 주식 수 기준이라 보통주 시가총액과 섞지 않는다.
 *    매출 대비(PSR)는 '지배주주순이익 ÷ EPS'로 되짚은 주식 수로 주당 매출을 만든다
 *  - 한국 종목은 한국 상장 회사끼리만 비교한다 (미국 종목과 견주지 않음 — 설계 B8)
 * DART 키가 생기면 이 모듈 대신 DART 전체 재무로 미국과 같은 등급(full)을 만들 수 있다 — 저장 모양(value_fundamentals, cik 칸 'naver')과
 * 비교 기준(value_references market 'KR')을 나눠 두어 출처만 바꿔 끼우면 되게 했다 (services/krValueService 의 KrValueSources)
 */

/** value_fundamentals.cik 칸의 한국 행 표시 (출처 이름) */
export const KR_SOURCE = "naver";
/** 분기·연간 실적을 쓰기 시작하는 날: 분기 끝 + 45일, 결산 + 90일 (보고서 법정 기한) */
export const KR_QUARTER_LAG_DAYS = 45;
export const KR_ANNUAL_LAG_DAYS = 90;
/** 한국 금융사 경로로 보는 네이버 업종 (은행·증권·보험·카드·기타금융) */
export const KR_FINANCIAL_UPJONG: ReadonlySet<string> = new Set(["은행", "증권", "생명보험", "손해보험", "카드", "기타금융"]);
/** 비교 회사 후보: 보통주 가운데 시가총액 하위 20% 는 뺀다 (미국 모집단과 같은 비율 — 재무를 받기 전에 빼서 요청을 줄인다) */
export const KR_CAP_CUT = 0.2;
/** 비교 기준을 만들 수 있는 재무 채움 비율 (후보의 60% 이상 — 첫 채우기는 며칠 밤에 나눠 받는다) */
export const KR_MIN_FILL = 0.6;
/** PER·PBR 교차 점검: 같은 가격으로 계산한 우리 값이 네이버가 보이는 값과 이 비율보다 크게 다르면 경고 기록 */
export const KR_CROSS_CHECK_TOLERANCE = 0.2;

/** 열 한 줄 (저장 모양): [끝 달 'YYYY-MM', 매출, 영업이익, 당기순이익, 지배주주순이익, EPS, BPS, 주당배당금, ROE, 부채비율, 당좌비율] */
export type KrColRow = [k: string, rev: number | null, op: number | null, ni: number | null, nic: number | null, eps: number | null, bps: number | null, dps: number | null, roe: number | null, debt: number | null, quick: number | null];
/** 한국 재무 요약 저장 모양 (value_fundamentals.data — cik 칸 'naver') */
export interface KrFacts {
  v: 1;
  kind: "kr";
  code: string;
  /** 연간 실적 열 (오래된 → 최신) */
  a: KrColRow[];
  /** 분기 실적 열 */
  q: KrColRow[];
  /** 네이버 요약 지표 (교차 점검·업종 번호) — 받지 못했으면 null */
  i: Pick<KrIntegration, "per" | "eps" | "pbr" | "bps" | "perAsOf" | "industryCode" | "endType" | "name"> | null;
  /** 버린 추정 열 수 (연간 + 분기) */
  dropped: number;
}

/** 저장해 두는 열 수 (새로 받을 때 네이버 표에서 빠진 앞 열을 이만큼까지 이어 둔다 — mergeKrFacts) */
export const KR_KEEP_ANNUAL = 5;
export const KR_KEEP_QUARTERS = 8;

/**
 * 새로 받은 재무 요약에 전에 저장한 열을 이어 붙인다 (같은 끝 달은 새 값). 네이버 표는 연간 실적 3열·분기 실적 5열만 보여,
 * 새 결산이 실적 열로 바뀌면(잠정 실적 1~3월) 가장 오래된 결산이 표에서 빠진다 — 그 결산을 버리면 새 결산을 쓸 수 있게 될 때까지
 * '2년 전 결산'이 없어 성장 묶음이 해마다 몇 주씩 빠졌다 (검토 지적). 연간 5개 · 분기 8개까지 둔다. 결산 달이 바뀐 회사도 그대로 이어 두지만
 * 성장은 끝 달이 정확히 24개월 앞인 결산만 쓰므로 섞이지 않는다
 */
export function mergeKrFacts(next: KrFacts, prev: KrFacts | null | undefined): KrFacts {
  if (!prev || prev.kind !== "kr" || prev.code !== next.code) return next;
  const merge = (now: readonly KrColRow[], old: readonly KrColRow[], keep: number): KrColRow[] => {
    const have = new Set(now.map((r) => r[0]));
    return [...old.filter((r) => !have.has(r[0])), ...now].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(-keep);
  };
  return { ...next, a: merge(next.a, prev.a, KR_KEEP_ANNUAL), q: merge(next.q, prev.q, KR_KEEP_QUARTERS) };
}

/** 파싱한 표 → 저장 모양. 실적 열이 하나도 없으면 null */
export function compactKrFacts(code: string, annual: KrFinanceTable | null, quarter: KrFinanceTable | null, integ: KrIntegration | null): KrFacts | null {
  const rows = (t: KrFinanceTable | null): KrColRow[] =>
    (t?.columns ?? []).map((c) => {
      const v = (k: KrRowKey) => c.values[k] ?? null;
      const nic = v("niControlling") ?? v("netIncome");
      return [c.end, v("revenue"), v("opIncome"), v("netIncome"), nic, v("eps"), v("bps"), v("dps"), v("roe"), v("debtRatio"), v("quickRatio")];
    });
  const a = rows(annual);
  const q = rows(quarter);
  if (!a.length && !q.length) return null;
  return {
    v: 1,
    kind: "kr",
    code,
    a,
    q,
    i: integ ? { per: integ.per, eps: integ.eps, pbr: integ.pbr, bps: integ.bps, perAsOf: integ.perAsOf, industryCode: integ.industryCode, endType: integ.endType, name: integ.name } : null,
    dropped: (annual?.consensusDropped ?? 0) + (quarter?.consensusDropped ?? 0),
  };
}

/** 'YYYY-MM' → 그달 말일 'YYYY-MM-DD' */
export function monthEndOf(k: string): string {
  const y = Number(k.slice(0, 4));
  const m = Number(k.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
/** 두 'YYYY-MM' 사이 달 수 */
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
/** 그 열을 asOf 에 쓸 수 있는지 (끝 + lag 일) */
export const krAvailable = (k: string, lagDays: number, asOf: string) => addDays(monthEndOf(k), lagDays) <= asOf;
/**
 * 연간 열을 asOf 에 쓸 수 있는지: 결산 + 90일(사업보고서 기한), 또는 같은 끝 달의 분기 열(4분기)이 있고 그 분기를 쓸 수 있을 때(+45일).
 * 네이버 4분기 열과 연간 실적 열은 같은 공시(잠정 실적·사업보고서)로 함께 실적이 되므로, 4분기를 쓰는 날부터 연간도 쓴다 —
 * 예전에는 4분기는 +45일, 연간은 +90일이라 2월 중순~3월 말 사이 규칙이 어긋났다 (검토 지적)
 */
export function krAnnualAvailable(f: Pick<KrFacts, "q">, k: string, asOf: string): boolean {
  if (krAvailable(k, KR_ANNUAL_LAG_DAYS, asOf)) return true;
  return f.q.some((r) => r[0] === k) && krAvailable(k, KR_QUARTER_LAG_DAYS, asOf);
}

export interface KrAnnual {
  k: string;
  end: string;
  rev: number | null;
  op: number | null;
  nic: number | null;
  eps: number | null;
  bps: number | null;
  dps: number | null;
}
/** 한국 간이 가치 지표 입력 (asOf 에 쓸 수 있는 열로) */
export interface KrInputs {
  /** 최근 분기 끝 달 'YYYY-MM' (쓸 수 있는 것 가운데) */
  quarter: string;
  /** 최근 4개 분기 합 (억원 · EPS 원). 네 분기가 이어지지 않거나 값이 빠지면 null */
  ttm: { rev: number | null; op: number | null; nic: number | null; eps: number | null };
  bps: number | null;
  bpsYearAgo: number | null;
  debtRatio: number | null;
  quickRatio: number | null;
  /** 연간 (쓸 수 있는 최근 3개, 오래된 → 최신) */
  annual: KrAnnual[];
  /** 최근 결산 주당배당금 (그 결산에 값이 없으면 무배당 0) — 결산 열이 없으면 null */
  dpsFY: number | null;
  /** 지배주주순이익 ÷ EPS 로 되짚은 주식 수 (우선주 포함 — 네이버 EPS 와 같은 기준). 모르면 null */
  shares: number | null;
  /** 최근 결산 끝 'YYYY-MM-DD' */
  fiscalEnd: string | null;
}

const toAnnual = (r: KrColRow): KrAnnual => ({ k: r[0], end: monthEndOf(r[0]), rev: r[1], op: r[2], nic: r[4], eps: r[5], bps: r[6], dps: r[7] });
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1]! : (s[(s.length >> 1) - 1]! + s[s.length >> 1]!) / 2) : null;
};

/** 주식 수 되짚기: 지배주주순이익(억원) × 1억 ÷ EPS(원). EPS 가 너무 작으면(반올림 오차) 쓰지 않는다 */
function sharesFrom(rows: readonly KrColRow[]): number | null {
  const est = (minEps: number) =>
    rows
      .filter((r) => r[4] !== null && r[5] !== null && Math.abs(r[5]) >= minEps && r[4] !== 0 && Math.sign(r[4]) === Math.sign(r[5]))
      .map((r) => (r[4]! * 1e8) / r[5]!);
  const good = est(20);
  return med(good.length ? good : est(1));
}

/** asOf 에 알 수 있던 열로 만든 입력 (분기 45일 · 연간 90일 — 4분기 열을 쓸 수 있으면 그날부터, krAnnualAvailable). 쓸 수 있는 분기가 없으면 null */
export function krInputs(f: KrFacts, asOf: string): KrInputs | null {
  const qs = f.q.filter((r) => krAvailable(r[0], KR_QUARTER_LAG_DAYS, asOf));
  if (!qs.length) return null;
  const last = qs.at(-1)!;
  const four = qs.slice(-4);
  const consecutive = four.length === 4 && four.every((r, i) => i === 0 || monthsBetween(four[i - 1]![0], r[0]) === 3);
  const sum = (j: 1 | 2 | 4 | 5) => (consecutive && four.every((r) => r[j] !== null) ? four.reduce((a, r) => a + r[j]!, 0) : null);
  const ya = qs.find((r) => monthsBetween(r[0], last[0]) === 12) ?? null;
  const ann = f.a.filter((r) => krAnnualAvailable(f, r[0], asOf)).slice(-3);
  const annual = ann.map(toAnnual);
  const lastA = annual.at(-1) ?? null;
  return {
    quarter: last[0],
    ttm: { rev: sum(1), op: sum(2), nic: sum(4), eps: sum(5) },
    bps: last[6],
    bpsYearAgo: ya?.[6] ?? null,
    debtRatio: last[9],
    quickRatio: last[10],
    annual,
    // 네이버 주당배당금 '-' 는 무배당으로 본다 (결산 열이 있고 다른 값이 있을 때)
    dpsFY: lastA ? (lastA.dps ?? 0) : null,
    shares: sharesFrom(four.length ? four : qs) ?? sharesFrom(ann),
    fiscalEnd: lastA?.end ?? null,
  };
}

const ok = (x: number, show: number | null): MetricValue => ({ x, show });
const zero = (why: MetricWhy, show: number | null = null): MetricValue => ({ x: -Infinity, show, rule: "zeroLoss", why });
const skip = (why: MetricWhy): MetricValue => ({ x: null, show: null, rule: "notComputed", why });
const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 2년 전 결산 (끝 달이 정확히 24개월 앞) */
function twoYearsBack(annual: readonly KrAnnual[]): { now: KrAnnual; then: KrAnnual } | null {
  const now = annual.at(-1);
  if (!now) return null;
  const then = annual.find((a) => monthsBetween(a.k, now.k) === 24);
  return then ? { now, then } : null;
}

/**
 * 한국 간이 지표 (price = 20거래일 평균 주가, 원). 금융사는 일반 지표 대신 ROA·자기자본 비율 (미국 금융 경로와 같은 뜻 — 총자산은
 * BPS × (1 + 부채비율) 로 되짚는다). 규칙(0점·계산 안 함)은 미국과 같다 (valueMetrics)
 */
export function krLiteMetrics(inp: KrInputs, price: number, financial: boolean): MetricSet {
  const m: MetricSet = {};
  if (!(price > 0)) return m;
  const { ttm, bps } = inp;
  // ── 주가 수준 ──
  if (num(ttm.eps)) m.A1 = ttm.eps > 0 ? ok(ttm.eps / price, price / ttm.eps) : zero("lossNi");
  if (num(bps)) m.A3 = bps > 0 ? ok(bps / price, price / bps) : skip("equityNonPositive");
  if (!financial && num(ttm.rev)) {
    if (ttm.rev <= 0) m.A4 = skip("revenueNonPositive");
    else if (num(inp.shares) && inp.shares > 0) {
      const rps = (ttm.rev * 1e8) / inp.shares;
      m.A4 = ok(rps / price, price / rps);
    }
  }
  // ── 수익성 ──
  if (num(ttm.eps) && num(bps)) {
    const avg = num(inp.bpsYearAgo) && inp.bpsYearAgo > 0 && bps > 0 ? (bps + inp.bpsYearAgo) / 2 : bps;
    m.B1 = bps > 0 && avg > 0 ? ok(ttm.eps / avg, (100 * ttm.eps) / avg) : skip("equityNonPositive");
  }
  const assetsPerShare = num(bps) && bps > 0 && num(inp.debtRatio) ? bps * (1 + inp.debtRatio / 100) : null;
  if (financial) {
    if (num(ttm.eps) && assetsPerShare) m.F1 = ok(ttm.eps / assetsPerShare, (100 * ttm.eps) / assetsPerShare);
    if (num(inp.debtRatio) && num(bps) && bps > 0) {
      const eqA = 1 / (1 + inp.debtRatio / 100);
      m.F3 = ok(eqA, 100 * eqA);
    }
  } else {
    if (num(ttm.op) && num(ttm.rev)) m.B4 = ttm.rev > 0 ? ok(ttm.op / ttm.rev, (100 * ttm.op) / ttm.rev) : skip("revenueNonPositive");
    // ── 재무 건전성 ──
    if (num(bps) && bps <= 0) m.D1 = zero("capitalImpairment");
    else if (num(inp.debtRatio)) m.D1 = ok(-(inp.debtRatio / 100), inp.debtRatio);
    if (num(inp.quickRatio)) m.D5 = ok(inp.quickRatio / 100, inp.quickRatio);
  }
  // ── 성장 (연간 2년) ──
  const two = twoYearsBack(inp.annual);
  if (two) {
    const { now, then } = two;
    if (num(now.rev) && num(then.rev)) {
      if (then.rev <= 0) m.C1 = skip("baseNonPositive");
      else if (now.rev <= 0) m.C1 = zero("revenueNonPositive");
      else {
        const g = Math.sqrt(now.rev / then.rev) - 1;
        m.C1 = ok(g, 100 * g);
      }
    }
    if (num(now.eps) && num(then.eps) && num(then.bps)) {
      if (then.bps <= 0) m.C2 = skip("baseNonPositive");
      // 분할·병합으로 주당 값이 크게 바뀐 구간 (BPS 가 2년 사이 5배 넘게 바뀜) — 계산 안 함
      else if (num(now.bps) && (now.bps / then.bps > 5 || now.bps / then.bps < 0.2)) m.C2 = skip("shareJump");
      else {
        const v = (now.eps - then.eps) / then.bps;
        m.C2 = ok(v, 100 * v);
      }
    }
    if (!financial && num(now.op) && num(now.rev) && now.rev > 0 && num(then.op) && num(then.rev) && then.rev > 0) {
      const d = clip(now.op / now.rev, -1, 1) - clip(then.op / then.rev, -1, 1);
      m.C3 = ok(d, 100 * d);
    }
  } else if (inp.annual.length) m.C1 = skip("fewYears");
  // ── 주주환원 ──
  if (num(inp.dpsFY)) m.E1 = ok(Math.max(0, inp.dpsFY) / price, (100 * Math.max(0, inp.dpsFY)) / price);
  return m;
}

/** 표시 판정 보조 값 (미국 MetricAux 모양 — 한국 간이에서 알 수 있는 것만: 초기 단계 · 배당 > 이익) */
export function krAux(inp: KrInputs): MetricAux {
  const a = inp.annual;
  const eps = inp.ttm.eps;
  return {
    opMarginStd: null,
    marginYears: 0,
    deepLossYears: 0,
    niToAvg5: null,
    nonOpRatio: null,
    sbcToRevenue: null,
    equityToAssets: num(inp.debtRatio) ? 1 / (1 + inp.debtRatio / 100) : null,
    coverage: null,
    taxRate: null,
    opAtHigh: null,
    opAtLow: null,
    earlyStage: a.length >= 2 && a.slice(-2).every((x) => num(x.op) && x.op <= 0),
    payoutOver100: num(inp.dpsFY) && num(eps) && eps > 0 && inp.dpsFY > eps,
    dividendCut: false,
  };
}

// ── 비교 회사 목록 (네이버 업종 구성 종목, 주 1회) ─────────────────────

export interface KrMember {
  code: string;
  name: string;
  market: string;
  endType: string;
  price: number | null;
  /** 시가총액 (원) */
  marketCap: number | null;
  upjong: string;
  upjongCode: string;
}

/** 한국 종목의 가치 지표 '대상 아님' 까닭 (보통주가 아닌 것): 우선주(코드 끝 0 아님) · 스팩 · 리츠 */
export function krExclusion(code: string, name: string | null | undefined): "preferred" | "spac" | "reit" | null {
  if (!/0$/.test(code)) return "preferred";
  const n = name ?? "";
  if (/스팩|SPAC/i.test(n)) return "spac";
  if (/리츠|REIT/i.test(n)) return "reit";
  return null;
}
/** 비교 회사가 될 수 있는 보통주: 코스피·코스닥 주식(ETF·ETN·코넥스 아님) · 우선주·스팩·리츠 아님 · 시가총액 있음 */
export function krCommonStock(m: KrMember): boolean {
  return m.endType === "stock" && (m.market === "KOSPI" || m.market === "KOSDAQ") && !krExclusion(m.code, m.name) && num(m.marketCap) && m.marketCap > 0 && num(m.price) && m.price > 0;
}
/** 재무를 받을 후보: 보통주 가운데 시가총액 하위 20% 를 뺀 것 (큰 순) */
export function krCandidates(members: readonly KrMember[]): KrMember[] {
  const common = members.filter(krCommonStock);
  const caps = common.map((m) => m.marketCap!).sort((a, b) => a - b);
  const cut = quantile(caps, KR_CAP_CUT) ?? 0;
  return common.filter((m) => m.marketCap! >= cut).sort((a, b) => b.marketCap! - a.marketCap!);
}

// ── 재무 다시 받기 (분기에 한 번 돌아가며 — 공시가 났을 때만) ──────────────

/** 새 분기 실적이 나올 때가 된 뒤, 아직 새 열이 없으면 이만큼(일)마다 다시 받아 본다 */
export const KR_RETRY_DAYS = 7;
/** 공시와 상관없이 이만큼 지나면 다시 받는다 (돌아가며) */
export const KR_ROTATION_DAYS = 120;
/** 밤마다 받는 종목 수 상한 (종목당 요청 3번 — 첫 채우기는 며칠 밤에 나눠진다) */
export const KR_NIGHT_CAP = 700;

export type KrDueWhy = "missing" | "newQuarter" | "annualPending" | "rotation";
/**
 * 다시 받을 때인지 (오늘 날짜 KST). 우선순위가 작을수록 먼저:
 *  0 missing — 받은 적 없음
 *  1 newQuarter — 저장한 최근 분기 다음 분기가 끝나고 45일(+3일)이 지났는데 아직 그 분기가 없음 (7일마다 다시). 다음 분기가 결산 달
 *    분기(4분기)면 90일(+3일) — 4분기·연간 실적은 잠정 실적을 내지 않는 회사는 사업보고서(결산 + 90일)로 나오므로, 45일로 두면
 *    2월 중순~3월 말 6주 동안 중소형주 대부분을 주마다 다시 받았다(밤마다 최대 700종목 — 설계 B14 '공시가 난 회사만'과 어긋남, 검토 지적)
 *  2 annualPending — 결산 달 분기는 들어왔는데 연간 열이 아직 그 결산 전 (사업보고서가 늦게 나옴 — 7일마다 다시)
 *  3 rotation — 120일 넘게 받지 않음
 */
export function krDue(row: { lastQuarter: string | null; annualEnd: string | null; fetchedAt: string } | null, today: string): { due: boolean; priority: number; why: KrDueWhy | null } {
  if (!row) return { due: true, priority: 0, why: "missing" };
  const fetched = row.fetchedAt.slice(0, 10);
  const since = daysBetween(fetched, today);
  if (row.lastQuarter) {
    const y = Number(row.lastQuarter.slice(0, 4));
    const mo = Number(row.lastQuarter.slice(5, 7)) + 3;
    const next = `${mo > 12 ? y + 1 : y}-${String(mo > 12 ? mo - 12 : mo).padStart(2, "0")}`;
    // 결산 달: 저장한 연간 열의 달 (없으면 12월 — 한국 상장사 대부분)
    const fyEndQuarter = next.slice(5, 7) === (row.annualEnd ?? "0000-12").slice(5, 7);
    const lag = fyEndQuarter ? KR_ANNUAL_LAG_DAYS : KR_QUARTER_LAG_DAYS;
    if (addDays(monthEndOf(next), lag + 3) <= today && since >= KR_RETRY_DAYS) return { due: true, priority: 1, why: "newQuarter" };
    // 결산 달(연간 열의 달)과 같은 달 분기가 들어왔는데 연간 열이 그보다 앞이면 사업보고서를 기다리는 중
    if (row.annualEnd && row.lastQuarter.slice(5, 7) === row.annualEnd.slice(5, 7) && row.annualEnd < row.lastQuarter && addDays(monthEndOf(row.lastQuarter), KR_ANNUAL_LAG_DAYS) <= today && since >= KR_RETRY_DAYS)
      return { due: true, priority: 2, why: "annualPending" };
  }
  if (since >= KR_ROTATION_DAYS) return { due: true, priority: 3, why: "rotation" };
  return { due: false, priority: 9, why: null };
}

// ── PER·PBR 교차 점검 (설계 B9) ──────────────────────────────

/**
 * 같은 가격으로 계산한 우리 PER·PBR 과 네이버가 보이는 PER·PBR 비교: 네이버 가격 = PER × EPS(네이버). 우리 값 = 그 가격 ÷ (우리 최근 4분기 EPS ·
 * 최근 분기 BPS — 네이버 PER 기준 분기까지). 20% 넘게 다르면 경고 글 (열 순서·단위·추정 열 섞임 같은 파싱 실수를 잡는다)
 */
export function krCrossCheck(f: KrFacts): { per: { ours: number; naver: number } | null; pbr: { ours: number; naver: number } | null; warnings: string[] } {
  const i = f.i;
  const out: { per: { ours: number; naver: number } | null; pbr: { ours: number; naver: number } | null; warnings: string[] } = { per: null, pbr: null, warnings: [] };
  if (!i) return out;
  const upto = i.perAsOf ?? f.q.at(-1)?.[0] ?? null;
  const qs = f.q.filter((r) => !upto || r[0] <= upto);
  const four = qs.slice(-4);
  const eps = four.length === 4 && four.every((r) => r[5] !== null) ? four.reduce((a, r) => a + r[5]!, 0) : null;
  const bps = qs.at(-1)?.[6] ?? null;
  const price = num(i.per) && num(i.eps) && i.per > 0 ? i.per * i.eps : num(i.pbr) && num(i.bps) ? i.pbr * i.bps : null;
  if (!num(price) || price <= 0) return out;
  if (num(i.per) && i.per > 0 && num(eps) && eps > 0) {
    out.per = { ours: price / eps, naver: i.per };
    if (Math.abs(out.per.ours - i.per) / i.per > KR_CROSS_CHECK_TOLERANCE) out.warnings.push(`PER 우리 ${out.per.ours.toFixed(2)} · 네이버 ${i.per}`);
  }
  if (num(i.pbr) && i.pbr > 0 && num(bps) && bps > 0) {
    out.pbr = { ours: price / bps, naver: i.pbr };
    if (Math.abs(out.pbr.ours - i.pbr) / i.pbr > KR_CROSS_CHECK_TOLERANCE) out.warnings.push(`PBR 우리 ${out.pbr.ours.toFixed(2)} · 네이버 ${i.pbr}`);
  }
  return out;
}

// ── 비교 기준 (주 1회, 일요일 새벽) ──────────────────────────────

/** 비교 회사로 쓸 수 있는 입력인지 (주가 수준 핵심 — 최근 4분기 EPS 나 BPS 가 있어야) */
const usable = (inp: KrInputs | null): inp is KrInputs => !!inp && (num(inp.ttm.eps) || num(inp.bps));

/**
 * 한국 비교 기준 만들기 (순수): 업종 구성 종목(members) + 저장한 재무 요약(facts) → value_references 모양 (market 'KR', 등급 lite).
 * 비교 회사 = 후보(보통주, 시가총액 하위 20% 뺌) 가운데 재무가 있는 회사. 가격은 목록의 현재가(그 주 기준 — 미국이 스크리너 시가총액을 쓰는 것과 같음).
 * 업종 자리 층은 미국과 같은 규칙(15곳 · 두 주 연속)으로, 부문 층은 없다(네이버 업종 한 층 → 시장)
 */
export function buildKrReference(members: readonly KrMember[], facts: ReadonlyMap<string, KrFacts>, refDate: string, prev?: ValueReferenceData | null): ValueReferenceData {
  const cands = krCandidates(members);
  const industries: string[] = [];
  const idx = (v: string) => {
    let i = industries.indexOf(v);
    if (i < 0) i = industries.push(v) - 1;
    return i;
  };
  const symbols: Record<string, [number, number]> = {};
  const quotes: Record<string, [number, number]> = {};
  const industryCodes: Record<string, string> = {};
  const pairs = new Map<string, readonly [string, string]>();
  for (const m of members) {
    symbols[m.code] = [0, idx(m.upjong)];
    industryCodes[m.upjongCode] = m.upjong;
    pairs.set(m.upjong, ["", m.upjong]);
    if (krCommonStock(m)) quotes[m.code] = [m.marketCap!, m.price!];
  }
  const peers: PeerRow[] = [];
  const counts: Record<ValuePath, number> = { general: 0, financial: 0 };
  const have: Record<ValuePath, Record<string, number>> = { general: {}, financial: {} };
  let withData = 0;
  for (const m of cands) {
    const f = facts.get(m.code);
    const inp = f ? krInputs(f, refDate) : null;
    if (!usable(inp)) continue;
    withData++;
    const financial = KR_FINANCIAL_UPJONG.has(m.upjong);
    const path: ValuePath = financial ? "financial" : "general";
    const metrics = krLiteMetrics(inp, m.price!, financial);
    counts[path]++;
    for (const k of LITE_METRIC_ORDER) if (metrics[k] && metrics[k]!.x !== null) have[path][k] = (have[path][k] ?? 0) + 1;
    peers.push({ c: m.code, t: m.name, s: 0, i: idx(m.upjong), f: financial ? 1 : 0, x: LITE_METRIC_ORDER.map((k) => encodeX(metrics[k]?.x ?? null)) });
  }
  const coverage: ValueReferenceData["coverage"] = { general: {}, financial: {} };
  for (const path of ["general", "financial"] as const) for (const k of LITE_METRIC_ORDER) if (counts[path]) coverage[path][k] = Math.round((1000 * (have[path][k] ?? 0)) / counts[path]) / 1000;
  const prevLevels = prev && prev.market === "KR" && daysBetween(prev.refDate, refDate) <= 21 && prev.refDate < refDate ? prev.levels : null;
  const levels = buildLevels(peers, [""], industries, pairs.values(), prevLevels, LITE_METRIC_ORDER);
  return {
    v: 1,
    method: VALUE_VERSION,
    market: "KR",
    grade: "lite",
    order: [...LITE_METRIC_ORDER],
    refDate,
    screenerDate: refDate,
    periods: { annual: [], latest: [], yearAgo: [] },
    sectors: [""],
    industries,
    industryCodes,
    symbols,
    peers,
    thresholds: { opMarginStdP70: null, niToAvg5P90: null, nonOpP95: null, sbcP90: null, equityToAssetsP5: null, coverageP50: null, taxRateP50: 0.24 },
    coverage,
    counts: { screener: members.length, mapped: cands.length, withData, universe: withData, general: counts.general, financial: counts.financial },
    missingFrames: [],
    quotes,
    levels,
  };
}
