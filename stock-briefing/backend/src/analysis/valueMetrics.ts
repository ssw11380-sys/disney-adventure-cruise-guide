import { cashAndInvestments, totalDebt } from "./valueConcepts.js";
import type { AnnualPoint, ValueInputs } from "./secFacts.js";

/**
 * 가치 지표 점수 (VALUE-1) 의 지표 값 — 순수 함수. 대상 종목과 비교 회사가 같은 함수로 계산한다.
 *  - x: 순위용 값 (클수록 점수가 높다). 규칙으로 맨 아래(0점)면 −Infinity, 맨 위(같은 순위)면 +Infinity, 계산하지 않으면 null
 *  - show: 화면 값 (METRIC_UNIT 단위)
 * 규칙 (설계 value-v1 §5):
 *  - 이익·영업이익·잉여현금흐름이 0 이하 → 그 지표 0점 (값이 없는 것과 다름)
 *  - 자본 ≤ 0 → PBR·ROE 계산 안 함. 부채비율은 '장부상 자본 음수'(영업이익 > 0 이고 이자보상이 시장 가운데 이상)면 계산 안 함, 그 밖(자본잠식)은 0점
 *  - PBR·ROE 는 지배주주 자본, ROIC 의 투하자본·부채비율은 자본총계(비지배지분 포함 — 설계 §5.2·§5.3)
 *  - 이익 안정성: 최근 5년 가운데 절반 넘는 해에 영업손실이 매출보다 크면(영업이익률 −100% 아래) 0점 — 잘라 낸 값끼리는 오르내림이 0 으로 보여서
 *  - 순현금(순차입금 ≤ 0) → 순차입금 부담 맨 위 · 순현금이 시가총액보다 커 EV ≤ 0 이고 영업이익 > 0 → EV/영업이익 맨 위
 *  - 이자비용이 없고 차입금도 거의 없음 → 이자보상 맨 위. 차입금이 있는데 이자비용 자료가 없으면 계산 안 함
 *  - 무배당 = 0% (유효한 값). 최근 1년 안에 배당 기록이 있는데 최근 4분기 배당을 만들 수 없으면 '자료 없음'(계산 안 함 — 0% 와 다름)
 *  - 성장·주식 수 변화: 3년 전 값과 비교. 한 해에 주식 수가 50% 넘게 바뀐 구간(분할·병합·합병)은 계산 안 함
 */

export type MetricKey =
  | "A1" | "A2" | "A3" | "A4" | "A5"
  | "B1" | "B2" | "B3" | "B4" | "B5" | "B6"
  | "D1" | "D2" | "D3" | "D4"
  | "C1" | "C2" | "C3"
  | "E1" | "E2"
  | "F1" | "F2" | "F3";
export type MetricRule = "zeroLoss" | "topTie" | "notComputed";
export interface MetricValue {
  x: number | null;
  show: number | null;
  rule?: MetricRule;
  /** 계산 안 함·0점·맨 위의 까닭 (문구 틀 열쇠) */
  why?: MetricWhy;
  /** 경기 민감 회사: 이익에 5년 평균 이익을 반씩 섞었음 (PER) */
  blend?: boolean;
}
export type MetricWhy =
  | "lossNi" | "lossOp" | "lossFcf" | "noCapex" | "equityNonPositive" | "smallEquity" | "negativeEquity" | "capitalImpairment"
  | "revenueNonPositive" | "investedNonPositive" | "noGrossProfit" | "fewYears" | "netCash" | "evNonPositive" | "noInterest" | "noInterestData"
  | "baseNonPositive" | "shareJump" | "noCurrent" | "missing" | "deepLoss" | "noDividendData";

export type MetricUnit = "배" | "%" | "%p";
export const METRIC_UNIT: Record<MetricKey, MetricUnit> = {
  A1: "배", A2: "배", A3: "배", A4: "배", A5: "%",
  B1: "%", B2: "%", B3: "%", B4: "%", B5: "%p", B6: "%",
  D1: "%", D2: "배", D3: "배", D4: "%",
  C1: "%", C2: "%", C3: "%p",
  E1: "%", E2: "%",
  F1: "%", F2: "%p", F3: "%",
};

/** 표시 판정용 보조 값 (시장 안 위치로 정하는 표시의 재료) */
export interface MetricAux {
  /** 최근 5개 연도 영업이익률 표준편차 (경기 민감 판정) */
  opMarginStd: number | null;
  /** 위 표준편차에 쓴 해 수와, 그 가운데 영업손실이 매출보다 큰 해(−100% 로 잘린 해) 수 */
  marginYears: number;
  deepLossYears: number;
  /** 최근 연간 순이익 ÷ 5년 평균 순이익 (경기 정점) */
  niToAvg5: number | null;
  /** |세전이익 − 영업이익| ÷ |영업이익| (영업 외 손익) */
  nonOpRatio: number | null;
  /** 주식보상비용 ÷ 매출 */
  sbcToRevenue: number | null;
  /** 자본 ÷ 총자산 */
  equityToAssets: number | null;
  /** 이자보상배율 (영업이익 ÷ 이자비용, 이자 없으면 null) */
  coverage: number | null;
  /** 유효세율 (세전이익 > 0 일 때만) */
  taxRate: number | null;
  /** 최근 연간 영업이익이 5년 중 최고·최저인지 (4년 이상 있을 때만) */
  opAtHigh: boolean | null;
  opAtLow: boolean | null;
  /** 최근 2개 연도 영업이익 모두 ≤ 0 */
  earlyStage: boolean;
  /** 배당 > 순이익 > 0 */
  payoutOver100: boolean;
}

export interface MetricCtx {
  /** 금융사 경로 (은행·보험·증권) */
  financial: boolean;
  /** 경기 민감 → 이익수익률에 5년 평균 이익을 반씩 섞음 */
  cyclical: boolean;
  /** 세전이익 ≤ 0 일 때 쓰는 세율 (시장 가운데값) */
  medianTaxRate: number;
  /** 작은 자본 기준: 자본 ÷ 총자산이 이보다 작으면 ROE 계산 안 함 (시장 하위 5%) */
  smallEquityCut: number | null;
  /** 장부상 자본 음수 판정용 이자보상배율 시장 가운데값 */
  medianCoverage: number | null;
}

export type MetricSet = Partial<Record<MetricKey, MetricValue>>;

const ok = (x: number, show: number | null): MetricValue => ({ x, show });
const zero = (why: MetricWhy, show: number | null = null): MetricValue => ({ x: -Infinity, show, rule: "zeroLoss", why });
const top = (why: MetricWhy, show: number | null = null): MetricValue => ({ x: Infinity, show, rule: "topTie", why });
const skip = (why: MetricWhy): MetricValue => ({ x: null, show: null, rule: "notComputed", why });
const num = (v: number | undefined | null): v is number => typeof v === "number" && Number.isFinite(v);
const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const avg2 = (a: number | undefined, b: number | undefined): number | undefined => (num(a) && num(b) ? (a + b) / 2 : num(a) ? a : undefined);

/** 표본 표준편차가 아니라 모집단 표준편차 (5개 이하라 차이가 크다 — 설계에 맞춰 모집단) */
export function stdev(xs: readonly number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** 연간 이력에서 k 년 전(기간 끝 기준 ±40일) 값 */
function yearsBack(annual: readonly AnnualPoint[], k: number): AnnualPoint | null {
  const last = annual.at(-1);
  if (!last) return null;
  const want = Date.parse(last.end) - k * 365.25 * 86_400_000;
  let best: AnnualPoint | null = null;
  for (const a of annual) {
    const d = Math.abs(Date.parse(a.end) - want) / 86_400_000;
    if (d <= 40 && (!best || d < Math.abs(Date.parse(best.end) - want) / 86_400_000)) best = a;
  }
  return best;
}

/** 최근 t..t−3 연도의 주식 수가 해마다 50% 넘게 바뀌지 않았는지 (분할·병합·합병 구간 거르기) */
function sharesContinuous(annual: readonly AnnualPoint[]): { now: number; then: number } | null {
  const pts = [0, 1, 2, 3].map((k) => yearsBack(annual, k));
  if (pts.some((p) => !p || !num(p.shares) || p.shares <= 0)) return null;
  for (let i = 0; i < 3; i++) {
    const r = pts[i]!.shares! / pts[i + 1]!.shares!;
    if (r > 1.5 || r < 1 / 1.5) return null;
  }
  return { now: pts[0]!.shares!, then: pts[3]!.shares! };
}

/** 영업이익률 (−100%~+100% 로 자름) */
const margin = (op: number | null, rev: number | null): number | null => (num(op) && num(rev) && rev > 0 ? clip(op / rev, -1, 1) : null);

export function computeAux(inp: ValueInputs): MetricAux {
  const f = inp.flow;
  const b = inp.bal;
  const ann = inp.annual.slice(-5);
  const margins = ann.map((a) => margin(a.opIncome, a.revenue)).filter(num);
  const deepLossYears = margins.filter((m) => m <= -1).length;
  const nis = ann.map((a) => a.netIncome).filter(num);
  const avgNi = nis.length >= 4 ? nis.reduce((x, y) => x + y, 0) / nis.length : null;
  const lastNi = ann.at(-1)?.netIncome;
  const ops = ann.map((a) => a.opIncome).filter(num);
  const lastOp = ann.at(-1)?.opIncome;
  const interest = num(f.interest) && f.interest > 0 ? f.interest : null;
  const pretax = f.pretax;
  return {
    opMarginStd: margins.length >= 4 ? stdev(margins) : null,
    marginYears: margins.length,
    deepLossYears,
    niToAvg5: avgNi !== null && avgNi > 0 && num(lastNi) ? lastNi / avgNi : null,
    nonOpRatio: num(pretax) && num(f.opIncome) && f.opIncome !== 0 ? Math.abs(pretax - f.opIncome) / Math.abs(f.opIncome) : null,
    sbcToRevenue: num(f.sbc) && num(f.revenue) && f.revenue > 0 ? f.sbc / f.revenue : null,
    equityToAssets: num(b.equity) && num(b.assets) && b.assets > 0 ? b.equity / b.assets : null,
    coverage: interest !== null && num(f.opIncome) ? f.opIncome / interest : null,
    taxRate: num(f.tax) && num(pretax) && pretax > 0 ? clip(f.tax / pretax, 0, 0.5) : null,
    opAtHigh: ops.length >= 4 && num(lastOp) ? lastOp >= Math.max(...ops) : null,
    opAtLow: ops.length >= 4 && num(lastOp) ? lastOp <= Math.min(...ops) : null,
    earlyStage: ann.length >= 2 && ann.slice(-2).every((a) => num(a.opIncome) && a.opIncome <= 0),
    payoutOver100: num(f.dividends) && num(f.netIncome) && f.netIncome > 0 && f.dividends > f.netIncome,
  };
}

/** 지표 값 계산. mcap = 시가총액(달러). 금융사는 일반 지표 대신 금융 경로 지표만 */
export function computeMetrics(inp: ValueInputs, mcap: number, ctx: MetricCtx): MetricSet {
  const f = inp.flow;
  const b = inp.bal;
  const m: MetricSet = {};
  if (!(mcap > 0)) return m;
  const eq = b.equity;
  // 자본총계 (비지배지분 포함): ROIC 투하자본·부채비율 (설계 §5.2·§5.3)
  const eqTotal = num(b.equityTotal) ? b.equityTotal : num(eq) ? eq + (num(b.nci) ? b.nci : 0) : undefined;
  const assets = b.assets;
  const avgEq = avg2(eq, inp.balYearAgo.equity);
  const avgAssets = avg2(assets, inp.balYearAgo.assets);
  const ni = f.netIncome;
  const aux = computeAux(inp);
  const ann = inp.annual;

  // ── 주가 수준 ──
  if (num(ni)) {
    let e = ni;
    let blend = false;
    if (ctx.cyclical) {
      const nis = ann.slice(-5).map((a) => a.netIncome).filter(num);
      if (nis.length >= 4) {
        e = 0.5 * ni + 0.5 * (nis.reduce((x, y) => x + y, 0) / nis.length);
        blend = true;
      }
    }
    m.A1 = { ...(e > 0 ? ok(e / mcap, mcap / e) : zero("lossNi")), ...(blend ? { blend: true } : {}) };
  }
  if (num(eq)) m.A3 = eq > 0 ? ok(eq / mcap, mcap / eq) : skip("equityNonPositive");

  const debt = num(assets) || num(b.liabilities) ? totalDebt(b, f.interest) : null;
  const cash = cashAndInvestments(b);
  const op = f.opIncome;
  const rev = f.revenue;

  if (!ctx.financial) {
    if (num(op) && debt !== null) {
      const ev = mcap + debt + (num(b.nci) ? Math.max(0, b.nci) : 0) - cash;
      if (op <= 0) m.A2 = zero("lossOp");
      else if (ev <= 0) m.A2 = top("evNonPositive");
      else m.A2 = ok(op / ev, ev / op);
    }
    if (num(rev)) m.A4 = rev > 0 ? ok(rev / mcap, mcap / rev) : skip("revenueNonPositive");
    if (num(f.ocf)) {
      if (!num(f.capex)) m.A5 = skip("noCapex");
      else {
        const fcf = f.ocf - f.capex;
        m.A5 = fcf > 0 ? ok(fcf / mcap, (100 * fcf) / mcap) : zero("lossFcf", (100 * fcf) / mcap);
      }
    }
  }

  // ── 수익성과 이익의 질 ──
  if (num(ni) && num(eq)) {
    if (eq <= 0 || !num(avgEq) || avgEq <= 0) m.B1 = skip("equityNonPositive");
    // 작은 자본 규칙은 일반 회사만 (은행·보험은 원래 자본이 얇다)
    else if (!ctx.financial && ctx.smallEquityCut !== null && aux.equityToAssets !== null && aux.equityToAssets < ctx.smallEquityCut) m.B1 = skip("smallEquity");
    else m.B1 = ok(ni / avgEq, (100 * ni) / avgEq);
  }
  if (ctx.financial) {
    if (num(ni) && num(avgAssets) && avgAssets > 0) m.F1 = ok(ni / avgAssets, (100 * ni) / avgAssets);
    const roes = ann
      .slice(-5)
      .map((a) => (num(a.netIncome) && num(a.equity) && a.equity > 0 ? a.netIncome / a.equity : null))
      .filter(num);
    m.F2 = roes.length >= 4 ? ok(-stdev(roes), 100 * stdev(roes)) : skip("fewYears");
    if (num(eq) && num(assets) && assets > 0) m.F3 = ok(eq / assets, (100 * eq) / assets);
  } else {
    if (num(op) && num(eqTotal) && debt !== null) {
      const t = aux.taxRate ?? ctx.medianTaxRate;
      // 투하자본은 최근 분기말 값 (설계는 평균 — 비교 회사 1년 전 차입금·현금을 받지 않아 같은 정의로 맞춤, 문서 17장)
      const ic = eqTotal + debt - cash;
      m.B2 = ic > 0 ? ok((op * (1 - t)) / ic, (100 * op * (1 - t)) / ic) : skip("investedNonPositive");
    }
    if (num(avgAssets) && avgAssets > 0) {
      const gp = num(f.grossProfit) ? f.grossProfit : num(rev) && num(f.costOfRevenue) ? rev - f.costOfRevenue : null;
      m.B3 = gp !== null ? ok(gp / avgAssets, (100 * gp) / avgAssets) : skip("noGrossProfit");
    }
    if (num(op) && num(rev)) m.B4 = rev > 0 ? ok(op / rev, (100 * op) / rev) : skip("revenueNonPositive");
    m.B5 =
      aux.opMarginStd === null
        ? skip("fewYears")
        : aux.deepLossYears * 2 > aux.marginYears
          ? zero("deepLoss")
          : ok(-aux.opMarginStd, 100 * aux.opMarginStd);
    if (num(ni) && num(f.ocf) && num(avgAssets) && avgAssets > 0) {
      const acc = (ni - f.ocf) / avgAssets;
      m.B6 = ok(-acc, 100 * acc);
    }

    // ── 재무 건전성 ──
    if (num(b.liabilities) && num(eqTotal)) {
      if (eqTotal > 0) m.D1 = ok(-(b.liabilities / eqTotal), (100 * b.liabilities) / eqTotal);
      else {
        const cov = aux.coverage ?? (num(op) && op > 0 && (!num(f.interest) || f.interest <= 0) ? Infinity : null);
        const negBook = num(op) && op > 0 && cov !== null && ctx.medianCoverage !== null && cov >= ctx.medianCoverage;
        m.D1 = negBook ? skip("negativeEquity") : zero("capitalImpairment");
      }
    }
    if (debt !== null) {
      const nd = debt - cash;
      if (nd <= 0) m.D2 = top("netCash", nd);
      else if (num(op)) m.D2 = op > 0 ? ok(-(nd / op), nd / op) : zero("lossOp");
    }
    if (num(op)) {
      const interest = num(f.interest) ? f.interest : null;
      if (interest !== null && interest > 0) m.D3 = op > 0 ? ok(op / interest, op / interest) : zero("lossOp");
      else if (debt !== null && num(assets) && assets > 0 && debt / assets < 0.01) m.D3 = top("noInterest");
      else m.D3 = skip("noInterestData");
    }
    if (num(b.assetsCurrent) && num(b.liabilitiesCurrent) && b.liabilitiesCurrent > 0) m.D4 = ok(b.assetsCurrent / b.liabilitiesCurrent, (100 * b.assetsCurrent) / b.liabilitiesCurrent);
  }

  // ── 성장 (연간 3년) ──
  const now = yearsBack(ann, 0);
  const then = yearsBack(ann, 3);
  if (now && then) {
    if (num(now.revenue) && num(then.revenue)) {
      if (then.revenue <= 0) m.C1 = skip("baseNonPositive");
      else if (now.revenue <= 0) m.C1 = zero("revenueNonPositive");
      else {
        const g = (now.revenue / then.revenue) ** (1 / 3) - 1;
        m.C1 = ok(g, 100 * g);
      }
    }
    const sh = sharesContinuous(ann);
    if (num(now.netIncome) && num(then.netIncome) && num(then.assets)) {
      if (!sh) m.C2 = skip("shareJump");
      else if (then.assets <= 0) m.C2 = skip("baseNonPositive");
      else {
        const v = (now.netIncome * (sh.then / sh.now) - then.netIncome) / then.assets;
        m.C2 = ok(v, 100 * v);
      }
    }
    if (!ctx.financial) {
      const a = margin(now.opIncome, now.revenue);
      const c = margin(then.opIncome, then.revenue);
      if (a !== null && c !== null) m.C3 = ok(a - c, 100 * (a - c));
    }
  } else if (ann.length) {
    m.C1 = skip("fewYears");
  }

  // ── 주주환원 ──
  const div = num(f.dividends) ? f.dividends : num(f.dps) && num(inp.shares) ? f.dps * inp.shares : inp.divUnknown ? null : 0;
  // 배당 기록은 있는데 최근 4분기 값을 만들 수 없으면 '자료 없음' (무배당 0% 와 다름 — 설계 원칙 4)
  m.E1 = div === null ? skip("noDividendData") : ok(Math.max(0, div) / mcap, (100 * Math.max(0, div)) / mcap);
  const sh = sharesContinuous(ann);
  if (sh) {
    const g = (sh.now / sh.then) ** (1 / 3) - 1;
    m.E2 = ok(-g, 100 * g);
  } else if (ann.length >= 4) m.E2 = skip("shareJump");
  return m;
}
