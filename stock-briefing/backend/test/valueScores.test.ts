import { describe, expect, it } from "vitest";
import { compactCompanyFacts, FactBook, normalizeInputs, splitFactor, type CompactFacts, type ValueInputs } from "../src/analysis/secFacts.js";
import { allTagNames, cashAndInvestments, totalDebt } from "../src/analysis/valueConcepts.js";
import { computeAux, computeMetrics, type MetricCtx, type MetricSet } from "../src/analysis/valueMetrics.js";
import {
  buildLevels,
  encodeX,
  isCyclical,
  isFinancial,
  medianOf,
  METRIC_ORDER,
  PeerBook,
  percentile,
  roundScore,
  scoreValue,
  valueBand,
  valueFlags,
  VALUE_WEIGHTS,
  type FamilyScore,
  type MetricScore,
  type PeerRow,
  type ValueReferenceData,
} from "../src/analysis/valueScore.js";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import {
  buildReferenceData,
  frameData,
  framePlan,
  keyFramesMissing,
  parseFrame,
  parseScreener,
  peerInputs,
  referenceDrop,
  referencePeriods,
  screenerExcluded,
  secTicker,
  type FrameMap,
  type FrameRow,
  type ReferenceSources,
  type ScreenerRow,
} from "../src/services/valueReference.js";
import { familyRow, metricRow, sharesMismatch } from "../src/services/valueScoreService.js";
import {
  BLEND_NOTE,
  carriedBadge,
  carriedText,
  causeFiling,
  causePrice,
  causeReference,
  fiscalLabel,
  fiscalShort,
  formatMetric,
  gapText,
  gwaWa,
  howLinesV2,
  lowCoverageText,
  medianText,
  METRIC_NAME,
  metricMeaning,
  mixText,
  NOT_ADOPTED,
  PEER_TIMING_NOTE,
  peerFallbackText,
  peerLine,
  positionSentence,
  positionText,
  PRICE_NOTE,
  RULE_TEXT,
  annualBasis,
  iraRa,
  TIE_NOTE,
  tieSentence,
  topTieNote,
  VALUE_BAND_LINE,
  VALUE_FAMILY_ABOUT,
  VALUE_FAMILY_NAME,
  VALUE_FLAG_TEXT,
  VALUE_STATUS_TEXT,
  valueChangeText,
  valueDatesLine,
  valueHeadline,
} from "../src/services/valueScoreText.js";
import { secFacts, type SecTicker } from "./fixtures/valueScores/load.js";
import { frameSample, screenerSample } from "./fixtures/valueScores/load.js";

/**
 * 가치 지표 점수 2단계 (3-44, VALUE-1) — 순수 함수 시험. 네트워크 없음.
 * SEC companyfacts 는 2026-09-28 에 받은 원본을 줄인 것(test/fixtures/valueScores/sec), 기대값은 같은 원본 줄을 시험 안에서 따로 골라 계산한다
 */

type RawRow = { start?: string; end: string; val: number; form: string; filed: string };
const rawRows = (t: SecTicker, tag: string, unit = "USD"): RawRow[] =>
  ((secFacts(t)["facts"] as Record<string, Record<string, { units: Record<string, RawRow[]> }>>)["us-gaap"]![tag]?.units[unit] ?? []) as RawRow[];
/** 원본에서 (start, end) 값 — 같은 기간 값이 여럿이면 asOf 까지 가장 늦게 낸 것 */
function rawVal(t: SecTicker, tag: string, start: string | null, end: string, asOf = "2026-09-28"): number {
  const rows = rawRows(t, tag).filter((r) => r.end === end && (start === null ? !r.start : r.start === start) && r.filed <= asOf);
  if (!rows.length) throw new Error(`원본에 없음 ${t} ${tag} ${start}~${end}`);
  return rows.sort((a, b) => (a.filed < b.filed ? 1 : -1))[0]!.val;
}
const book = (t: SecTicker) => new FactBook(compactCompanyFacts(secFacts(t), "2018-01-01"));

describe("SEC 재무 줄이기 (compactCompanyFacts)", () => {
  it("정기 보고서(10-K·10-Q·정정) 줄만, 쓰는 태그만, since 이후 기간만, 달러 금액만, 같은 줄은 한 번", () => {
    const raw = {
      cik: 1045810,
      entityName: "예시",
      facts: {
        "us-gaap": {
          NetIncomeLoss: {
            units: {
              USD: [
                { start: "2025-01-01", end: "2025-12-31", val: 10, form: "10-K", filed: "2026-02-01" },
                { start: "2025-01-01", end: "2025-12-31", val: 10, form: "10-K", filed: "2026-02-01" }, // 같은 줄
                { start: "2025-10-01", end: "2025-12-31", val: 3, form: "8-K", filed: "2026-01-20" }, // 수시 공시
                { start: "2010-01-01", end: "2010-12-31", val: 1, form: "10-K", filed: "2011-02-01" }, // since 전
              ],
              EUR: [{ start: "2025-01-01", end: "2025-12-31", val: 9, form: "10-K", filed: "2026-02-01" }],
            },
          },
          SomethingElse: { units: { USD: [{ start: "2025-01-01", end: "2025-12-31", val: 5, form: "10-K", filed: "2026-02-01" }] } },
          Assets: { units: { USD: [{ end: "2025-12-31", val: 100, form: "10-K/A", filed: "2026-03-01" }] } },
        },
      },
    };
    const c = compactCompanyFacts(raw, "2018-01-01");
    expect(c.cik).toBe("0001045810");
    expect(c.flows.netIncome).toEqual([[`2025-01-01`, "2025-12-31", 10, "2026-02-01", "10-K", 0]]);
    expect(c.inst.assets).toEqual([[null, "2025-12-31", 100, "2026-03-01", "10-K/A", 0]]);
    expect(Object.keys(c.flows)).toEqual(["netIncome"]);
    expect(c.lastFiled).toBe("2026-03-01");
    // 쓰는 태그 목록에 대상 종목·비교 회사 공통 태그가 모두 들어 있다
    for (const t of ["NetIncomeLoss", "PaymentsToAcquireProductiveAssets", "InterestExpenseNonoperating", "LongTermDebtAndCapitalLeaseObligations", "DividendsCommonStockCash", "WeightedAverageNumberOfDilutedSharesOutstanding"]) expect(allTagNames()).toContain(t);
  });
});

describe("최근 4분기(TTM) — 누적값 빼기 · 공시일 기준", () => {
  it("MSFT (6월 결산): 가장 최근 보고서가 연간(10-K 2026-07-29)이면 그 연간 값", () => {
    const b = book("MSFT");
    const p = b.latest("2026-09-28")!;
    expect(p).toEqual({ end: "2026-06-30", filed: "2026-07-29", form: "10-K", basis: "FY" });
    expect(b.flowTTM("revenue", "2026-09-28", p.end)).toBe(rawVal("MSFT", "RevenueFromContractWithCustomerExcludingAssessedTax", "2025-07-01", "2026-06-30"));
    expect(b.flowTTM("netIncome", "2026-09-28", p.end)).toBe(133_749_000_000);
    expect(b.flowTTM("capex", "2026-09-28", p.end)).toBe(rawVal("MSFT", "PaymentsToAcquirePropertyPlantAndEquipment", "2025-07-01", "2026-06-30"));
  });

  it("NVDA (1월 결산, 2분기 10-Q): 직전 연간 + 올해 6개월 누적 − 작년 6개월 누적. 현금흐름은 10-Q 에 누적값만 있다", () => {
    const b = book("NVDA");
    const p = b.latest("2026-09-28")!;
    expect(p).toEqual({ end: "2026-07-26", filed: "2026-08-26", form: "10-Q", basis: "TTM" });
    const fy = ["2025-01-27", "2026-01-25"] as const;
    const ytd = ["2026-01-26", "2026-07-26"] as const;
    const prev = ["2025-01-27", "2025-07-27"] as const;
    const ttm = (tag: string) => rawVal("NVDA", tag, ...fy) + rawVal("NVDA", tag, ...ytd) - rawVal("NVDA", tag, ...prev);
    expect(b.flowTTM("revenue", "2026-09-28", p.end)).toBe(ttm("Revenues"));
    expect(b.flowTTM("ocf", "2026-09-28", p.end)).toBe(ttm("NetCashProvidedByUsedInOperatingActivities"));
    // 영업현금흐름은 3개월 값이 없다 (그래서 누적값을 빼야 한다)
    expect(rawRows("NVDA", "NetCashProvidedByUsedInOperatingActivities").some((r) => r.start === "2026-04-27" && r.end === "2026-07-26")).toBe(false);
    expect(b.flowTTM("revenue", "2026-09-28", p.end)).toBe(302_970_000_000);
  });

  it("AAPL (9월 결산, 3분기): 9개월 누적으로 빼기", () => {
    const b = book("AAPL");
    const p = b.latest("2026-09-28")!;
    expect(p.end).toBe("2026-06-27");
    const v = rawVal("AAPL", "NetCashProvidedByUsedInOperatingActivities", "2024-09-29", "2025-09-27") + rawVal("AAPL", "NetCashProvidedByUsedInOperatingActivities", "2025-09-28", "2026-06-27") - rawVal("AAPL", "NetCashProvidedByUsedInOperatingActivities", "2024-09-29", "2025-06-28");
    expect(b.flowTTM("ocf", "2026-09-28", p.end)).toBe(v);
  });

  it("공시일 기준: 2분기 10-Q 제출(8/26) 전날에는 1분기까지, 제출일부터 2분기까지 (미래 자료를 섞지 않음)", () => {
    const b = book("NVDA");
    const before = b.latest("2026-08-25")!;
    expect(before).toEqual({ end: "2026-04-26", filed: "2026-05-20", form: "10-Q", basis: "TTM" });
    const q1 = rawVal("NVDA", "Revenues", "2025-01-27", "2026-01-25") + rawVal("NVDA", "Revenues", "2026-01-26", "2026-04-26") - rawVal("NVDA", "Revenues", "2025-01-27", "2025-04-27");
    expect(b.flowTTM("revenue", "2026-08-25", before.end)).toBe(q1);
    expect(b.latest("2026-08-26")!.end).toBe("2026-07-26");
    // 입력 전체도 그날까지의 값으로
    expect(b.inputs("2026-08-25")!.period!.end).toBe("2026-04-26");
  });

  it("정정·재작성: 같은 기간 값이 여럿이면 그날까지 가장 늦게 낸 값", () => {
    const c: CompactFacts = {
      v: 1,
      cik: "1",
      name: null,
      shares: [],
      inst: {},
      lastFiled: null,
      flows: {
        netIncome: [
          ["2025-01-01", "2025-12-31", 100, "2026-02-10", "10-K", 0],
          ["2025-01-01", "2025-12-31", 90, "2026-05-01", "10-K/A", 0],
        ],
      },
    };
    const b = new FactBook(c);
    expect(b.flowTTM("netIncome", "2026-03-01", "2025-12-31")).toBe(100);
    expect(b.flowTTM("netIncome", "2026-06-01", "2025-12-31")).toBe(90);
  });

  it("10-Q 의 '최근 12개월' 줄(AMZN 식)은 회계연도가 아니다: 기준은 누적값 빼기, 연간 이력에도 넣지 않음", () => {
    const c: CompactFacts = {
      v: 1,
      cik: "1",
      name: null,
      shares: [],
      inst: {},
      lastFiled: null,
      flows: {
        netIncome: [
          ["2024-01-01", "2024-12-31", 40, "2025-02-01", "10-K", 0],
          ["2025-01-01", "2025-12-31", 50, "2026-02-01", "10-K", 0],
          ["2025-01-01", "2025-06-30", 20, "2025-08-01", "10-Q", 0],
          ["2026-01-01", "2026-06-30", 30, "2026-08-01", "10-Q", 0],
          ["2025-07-01", "2026-06-30", 60, "2026-08-01", "10-Q", 0], // 최근 12개월 줄
        ],
      },
    };
    const b = new FactBook(c);
    expect(b.latest("2026-09-01")).toEqual({ end: "2026-06-30", filed: "2026-08-01", form: "10-Q", basis: "TTM" });
    expect(b.flowTTM("netIncome", "2026-09-01", "2026-06-30")).toBe(50 + 30 - 20);
    expect(b.annualHistory("2026-09-01").map((a) => a.end)).toEqual(["2024-12-31", "2025-12-31"]);
  });
});

describe("태그 별칭 (태그 이름이 바뀐 회사)", () => {
  it("NVDA 설비투자: 2020년까지 PaymentsToAcquirePropertyPlantAndEquipment → 2024~ PaymentsToAcquireProductiveAssets", () => {
    const b = book("NVDA");
    expect(rawRows("NVDA", "PaymentsToAcquirePropertyPlantAndEquipment").every((r) => r.end < "2021-01-01")).toBe(true);
    const v =
      rawVal("NVDA", "PaymentsToAcquireProductiveAssets", "2025-01-27", "2026-01-25") +
      rawVal("NVDA", "PaymentsToAcquireProductiveAssets", "2026-01-26", "2026-07-26") -
      rawVal("NVDA", "PaymentsToAcquireProductiveAssets", "2025-01-27", "2025-07-27");
    expect(b.flowTTM("capex", "2026-09-28", "2026-07-26")).toBe(v);
  });

  it("이자비용: NVDA·MSFT 는 2025~ InterestExpenseNonoperating, 이름만 바뀐 앞 태그로 빈 해를 채운다", () => {
    const b = book("NVDA");
    const v =
      rawVal("NVDA", "InterestExpenseNonoperating", "2025-01-27", "2026-01-25") +
      rawVal("NVDA", "InterestExpenseNonoperating", "2026-01-26", "2026-07-26") -
      rawVal("NVDA", "InterestExpenseNonoperating", "2025-01-27", "2025-07-27");
    expect(b.flowTTM("interest", "2026-09-28", "2026-07-26")).toBe(v);
    expect(book("MSFT").flowTTM("interest", "2026-09-28", "2026-06-30")).toBe(3_051_000_000);
  });

  it("겹치는 기간 값이 다른 태그는 빈 기간을 채우지 않는다 (뜻이 다른 태그를 섞지 않게)", () => {
    const c: CompactFacts = {
      v: 1,
      cik: "1",
      name: null,
      shares: [],
      inst: {},
      lastFiled: null,
      flows: {
        revenue: [
          ["2024-01-01", "2024-12-31", 100, "2025-02-01", "10-K", 0],
          ["2025-01-01", "2025-12-31", 110, "2026-02-01", "10-K", 0],
          ["2022-01-01", "2022-12-31", 70, "2023-02-01", "10-K", 2], // 겹치지 않음 → 채움
          ["2023-01-01", "2023-12-31", 80, "2024-02-01", "10-K", 3],
          ["2024-01-01", "2024-12-31", 60, "2025-02-01", "10-K", 3], // 2024 가 100 과 다름 → 이 태그는 쓰지 않음
        ],
        netIncome: [
          ["2022-01-01", "2022-12-31", 1, "2023-02-01", "10-K", 0],
          ["2023-01-01", "2023-12-31", 1, "2024-02-01", "10-K", 0],
          ["2024-01-01", "2024-12-31", 1, "2025-02-01", "10-K", 0],
          ["2025-01-01", "2025-12-31", 1, "2026-02-01", "10-K", 0],
        ],
      },
    };
    const h = new FactBook(c).annualHistory("2026-03-01");
    expect(h.map((a) => a.revenue)).toEqual([70, null, 100, 110]);
  });

  it("AVGO 식: 지배주주 자본 태그 없이 자본총계만 → 자본 = 자본총계 − 비지배지분, 부채총계가 없으면 자산 − 자본총계, 은행 매출 = 순이자 + 비이자", () => {
    const inp: ValueInputs = { flow: { nii: 60, nonii: 40 }, bal: { assets: 500, equityTotal: 120, nci: 20 }, balYearAgo: {}, annual: [], shares: null, period: null };
    const n = normalizeInputs(inp);
    expect(n.bal.equity).toBe(100);
    expect(n.bal.liabilities).toBe(380);
    expect(n.flow.revenue).toBe(100);
  });
});

const CTX: MetricCtx = { financial: false, cyclical: false, medianTaxRate: 0.21, smallEquityCut: 0.1, medianCoverage: 2.5 };
function inputs(over: Partial<{ flow: ValueInputs["flow"]; bal: ValueInputs["bal"]; balYearAgo: ValueInputs["balYearAgo"]; annual: ValueInputs["annual"]; shares: number }> = {}): ValueInputs {
  const annual = over.annual ?? [2021, 2022, 2023, 2024, 2025].map((y, i) => ({ end: `${y}-12-31`, revenue: 100 + 10 * i, opIncome: 20 + 2 * i, netIncome: 15 + i, shares: 100, assets: 200 + 10 * i, equity: 120 + 5 * i }));
  return {
    flow: { revenue: 150, opIncome: 30, netIncome: 20, ocf: 28, capex: 8, interest: 2, tax: 5, pretax: 25, dividends: 4, sbc: 3, ...over.flow },
    bal: { assets: 250, liabilities: 110, equity: 140, assetsCurrent: 90, liabilitiesCurrent: 45, cash: 20, stInvest: 10, ltd: 50, ...over.bal },
    balYearAgo: over.balYearAgo ?? { equity: 130, assets: 240 },
    annual,
    shares: over.shares ?? 100,
    period: null,
  };
}

describe("지표 값 규칙 (computeMetrics)", () => {
  it("보통 회사: 주가 대비 값과 수익성·건전성·성장·주주환원", () => {
    const m = computeMetrics(inputs(), 400, CTX);
    expect(m.A1).toEqual({ x: 20 / 400, show: 20 });
    // EV = 400 + 빚 50 − 현금 30 = 420
    expect(m.A2?.x).toBeCloseTo(30 / 420, 12);
    expect(m.A3?.show).toBeCloseTo(400 / 140, 12);
    expect(m.A5?.x).toBeCloseTo(20 / 400, 12);
    expect(m.B1?.x).toBeCloseTo(20 / 135, 12);
    // ROIC: 세율 5/25 = 20%, 투하자본 140 + 50 − 30 = 160
    expect(m.B2?.x).toBeCloseTo((30 * 0.8) / 160, 12);
    expect(m.D2?.x).toBeCloseTo(-(20 / 30), 12);
    expect(m.D3?.x).toBe(15);
    expect(m.C1?.x).toBeCloseTo((140 / 110) ** (1 / 3) - 1, 12);
    expect(m.E1?.x).toBe(4 / 400);
    expect(m.E2?.x).toBeCloseTo(0, 12);
    expect(m.F1).toBeUndefined();
  });

  it("적자 → 이익 기준 지표 0점(−∞, 값 없음과 다름), 영업적자 → EV/영업이익·순차입금 부담 0점, 잉여현금흐름 ≤ 0 → 0점", () => {
    const m = computeMetrics(inputs({ flow: { netIncome: -5, opIncome: -3, ocf: 2, capex: 6 } }), 400, CTX);
    expect(m.A1).toEqual({ x: -Infinity, show: null, rule: "zeroLoss", why: "lossNi" });
    expect(m.A2?.rule).toBe("zeroLoss");
    expect(m.D2?.rule).toBe("zeroLoss");
    expect(m.A5).toMatchObject({ x: -Infinity, rule: "zeroLoss", why: "lossFcf" });
    expect(m.A5?.show).toBeCloseTo(-1, 12);
  });

  it("순현금 → 순차입금 부담 맨 위(같은 순위), 순현금이 시가총액보다 크면 EV/영업이익 맨 위", () => {
    const m = computeMetrics(inputs({ bal: { ltd: 0, cash: 500 } }), 400, CTX);
    expect(m.D2).toMatchObject({ x: Infinity, rule: "topTie", why: "netCash" });
    expect(m.A2).toMatchObject({ x: Infinity, rule: "topTie", why: "evNonPositive" });
  });

  it("이자보상배율: 이자 있음 → 영업이익 ÷ 이자, 이자 없고 빚도 거의 없음 → 맨 위, 빚은 있는데 이자 자료가 없으면 계산 안 함 (AAPL)", () => {
    expect(computeMetrics(inputs({ flow: { interest: undefined }, bal: { ltd: 1 } }), 400, CTX).D3).toMatchObject({ x: Infinity, rule: "topTie" });
    expect(computeMetrics(inputs({ flow: { interest: undefined } }), 400, CTX).D3).toMatchObject({ x: null, rule: "notComputed", why: "noInterestData" });
  });

  it("총차입금: LongTermDebt(유동 포함) → 비유동 + 유동 → DebtCurrent 는 단기차입금을 다시 더하지 않음, 리스 포함, 차입 태그 없이 이자만 있으면 모름", () => {
    // 단기차입금·기업어음이 둘 다 있으면 큰 쪽 하나만 (기업어음을 단기차입금 안에 넣어 보고하는 회사가 많다 — 두 번 세지 않게, 검토 지적)
    expect(totalDebt({ ltd: 50, stBorrowings: 5, commercialPaper: 2, opLease: 10, finLease: 3 })).toBe(68);
    expect(totalDebt({ ltd: 50, stBorrowings: 2, commercialPaper: 5 })).toBe(55);
    expect(totalDebt({ ltd: 50, commercialPaper: 5 })).toBe(55);
    expect(totalDebt({ ltd: 50, stBorrowings: 5 })).toBe(55);
    expect(totalDebt({ ltdNoncurrent: 40, ltdCurrent: 8, stBorrowings: 5 })).toBe(53);
    expect(totalDebt({ ltdNoncurrent: 40, debtCurrent: 9, stBorrowings: 5 })).toBe(49);
    expect(totalDebt({ opLeaseNoncurrent: 4, opLeaseCurrent: 1, finLeaseNoncurrent: 2 })).toBe(7);
    expect(totalDebt({}, 0)).toBe(0);
    expect(totalDebt({ opLease: 3 }, 12)).toBeNull();
    expect(cashAndInvestments({ cash: 10, stInvest: 5 })).toBe(15);
    // 빚을 모르면 빚이 필요한 지표는 없음 (0 으로 보고 '순현금'으로 올리지 않음)
    const m = computeMetrics(inputs({ bal: { ltd: undefined } }), 400, CTX);
    expect(m.D2).toBeUndefined();
    expect(m.A2).toBeUndefined();
    expect(m.B2).toBeUndefined();
  });

  it("자본 ≤ 0: PBR·ROE 계산 안 함, 부채비율은 '장부상 자본 음수'(영업이익 > 0, 이자보상 ≥ 시장 가운데)면 계산 안 함 · 아니면 자본잠식 0점", () => {
    const neg = computeMetrics(inputs({ bal: { equity: -10 } }), 400, CTX);
    expect(neg.A3).toMatchObject({ x: null, rule: "notComputed", why: "equityNonPositive" });
    expect(neg.B1).toMatchObject({ rule: "notComputed" });
    expect(neg.D1).toMatchObject({ x: null, rule: "notComputed", why: "negativeEquity" });
    const impaired = computeMetrics(inputs({ bal: { equity: -10 }, flow: { opIncome: -1 } }), 400, CTX);
    expect(impaired.D1).toMatchObject({ x: -Infinity, rule: "zeroLoss", why: "capitalImpairment" });
  });

  it("작은 자본(시장 하위 5%)이면 ROE 계산 안 함 — 일반 회사만 (은행·보험은 원래 자본이 얇다)", () => {
    const thin = inputs({ bal: { equity: 20, assets: 250 } });
    expect(computeMetrics(thin, 400, CTX).B1).toMatchObject({ rule: "notComputed", why: "smallEquity" });
    // 평균 자본 = (지금 20 + 1년 전 130) / 2
    expect(computeMetrics(thin, 400, { ...CTX, financial: true }).B1?.x).toBeCloseTo(20 / 75, 12);
  });

  it("경기 민감: PER 에 5년 평균 이익을 반씩 섞음 (표시 blend)", () => {
    const m = computeMetrics(inputs(), 400, { ...CTX, cyclical: true });
    const avg5 = (15 + 16 + 17 + 18 + 19) / 5;
    expect(m.A1?.x).toBeCloseTo((0.5 * 20 + 0.5 * avg5) / 400, 12);
    expect(m.A1?.blend).toBe(true);
  });

  it("무배당 = 0%(유효한 값), 배당 지급액이 없으면 주당 배당 × 주식 수", () => {
    expect(computeMetrics(inputs({ flow: { dividends: undefined } }), 400, CTX).E1).toEqual({ x: 0, show: 0 });
    expect(computeMetrics(inputs({ flow: { dividends: undefined, dps: 0.02 } }), 400, CTX).E1?.x).toBeCloseTo((0.02 * 100) / 400, 12);
  });

  it("3년 사이 한 해에 주식 수가 50% 넘게 바뀌면(분할·병합) 주식 수 변화·주당이익 증가폭 계산 안 함", () => {
    const annual = [2021, 2022, 2023, 2024, 2025].map((y) => ({ end: `${y}-12-31`, revenue: 100, opIncome: 20, netIncome: 15, shares: y >= 2024 ? 1000 : 100, assets: 200, equity: 120 }));
    const m = computeMetrics(inputs({ annual }), 400, CTX);
    expect(m.E2).toMatchObject({ rule: "notComputed", why: "shareJump" });
    expect(m.C2).toMatchObject({ rule: "notComputed", why: "shareJump" });
    expect(m.C1?.x).toBeCloseTo(0, 12);
  });

  it("금융사 경로(JPM): 일반 지표(EV·매출·현금흐름·부채비율 등) 대신 ROA·ROE 안정성·자기자본 비율", () => {
    const inp = book("JPM").inputs("2026-09-28")!;
    const m = computeMetrics(inp, 800e9, { ...CTX, financial: true });
    expect(Object.keys(m).sort()).toEqual(["A1", "A3", "B1", "C1", "C2", "E1", "E2", "F1", "F2", "F3"]);
    expect(m.F3?.x).toBeCloseTo(374_598e6 / 5_015_069e6, 9);
  });

  it("RGTI (적자 초기 기업): 이익 기준 지표 0점, 초기 단계 표시", () => {
    const inp = book("RGTI").inputs("2026-09-28")!;
    const m = computeMetrics(inp, 5e9, CTX);
    expect(m.A1?.rule).toBe("zeroLoss");
    expect(m.A2?.rule).toBe("zeroLoss");
    expect(computeAux(inp).earlyStage).toBe(true);
  });
});

// ── 비교 기준 (손으로 만든 작은 분포) ──

/** 업종 A 20곳 · 업종 B 5곳(같은 부문) · 업종 C 10곳(다른 부문) · 금융 20곳. 지표 값 = 회사 번호 기반 */
function smallReference(opts: { coverage?: Partial<Record<string, number>>; nA?: number } = {}): ValueReferenceData {
  const peers: PeerRow[] = [];
  const mk = (n: number, s: number, i: number, f: 0 | 1, base: number) => {
    for (let k = 0; k < n; k++) peers.push({ c: String(1000 + peers.length), t: `T${peers.length}`, s, i, f, x: METRIC_ORDER.map(() => encodeX(base + k)) });
  };
  mk(opts.nA ?? 20, 0, 0, 0, 1); // 업종 A: 1..20
  mk(5, 0, 1, 0, 100); // 업종 B: 100..104
  mk(10, 1, 2, 0, 50); // 업종 C: 50..59
  mk(20, 2, 3, 1, 1); // 금융: 1..20
  const cov: Record<string, number> = Object.fromEntries(METRIC_ORDER.map((k) => [k, 1]));
  return {
    v: 1,
    method: "VALUE-1",
    market: "US",
    refDate: "2026-09-26",
    screenerDate: "2026-09-26",
    periods: { annual: [], latest: [], yearAgo: [] },
    sectors: ["Technology", "Industrials", "Finance"],
    industries: ["IndA", "IndB", "IndC", "Major Banks"],
    symbols: { AAA: [0, 0], BBB: [0, 1] },
    peers,
    thresholds: { opMarginStdP70: 0.1, niToAvg5P90: 2, nonOpP95: 2, sbcP90: 0.2, equityToAssetsP5: 0.1, coverageP50: 2.5, taxRateP50: 0.21 },
    coverage: { general: { ...cov, ...opts.coverage }, financial: { ...cov, ...opts.coverage } },
    counts: { screener: 0, mapped: 0, withData: 0, universe: 55, general: 35, financial: 20 },
    missingFrames: [],
  };
}
/** 모든 지표에 같은 순위용 값 */
const allMetrics = (x: number, keys = METRIC_ORDER): MetricSet => Object.fromEntries(keys.map((k) => [k, { x, show: x }]));

describe("백분위·비교 섞기·묶음·상태 (scoreValue)", () => {
  it("백분위 p = 100 × (작음 + 0.5 × 같음) / N, 자기 값은 빼고, 규칙(±∞)은 같은 규칙끼리 같은 순위", () => {
    expect(percentile(2, [1, 2, 2, 3])).toBe(50);
    expect(percentile(3, [1, 2, 2, 3])).toBe(87.5);
    // 자기 값(3)을 빼면 [1, 2, 2] 안에서 맨 위
    expect(percentile(3, [1, 2, 2, 3], 3)).toBe(100);
    expect(percentile(2, [1, 2, 2, 3], 2)).toBeCloseTo((100 * (1 + 0.5)) / 3, 12);
    expect(percentile(Infinity, [-Infinity, 1, Infinity, Infinity])).toBe(75);
    expect(percentile(-Infinity, [-Infinity, 1, 2, 3])).toBe(12.5);
    expect(percentile(1, [])).toBeNull();
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    // 가운데 두 값에 규칙 값(±∞)이 끼면 위쪽 가운데값
    expect(medianOf([-Infinity, 1])).toBe(1);
    expect(medianOf([1, Infinity])).toBe(Infinity);
  });

  it("업종 자리: 값이 15개 이상인 첫 층 (업종 → 부문 → 시장), 자기 자신은 세지 않음", () => {
    const pb = new PeerBook(smallReference());
    expect(pb.industrySlot("general", "Technology", "IndA", "A1", null).level).toBe("industry");
    // 업종 B 는 5곳 → 같은 부문(업종 A+B 25곳)
    expect(pb.industrySlot("general", "Technology", "IndB", "A1", null)).toMatchObject({ level: "sector", name: "Technology" });
    // 업종 C 는 10곳, 부문도 10곳 → 시장(일반 35곳)
    expect(pb.industrySlot("general", "Industrials", "IndC", "A1", null)).toMatchObject({ level: "market" });
    expect(pb.industrySlot("general", "Industrials", "IndC", "A1", null).sorted).toHaveLength(35);
    // 업종 A 가 딱 15곳이고 그 가운데 한 곳이 대상 종목이면 14곳 → 부문으로
    const pb15 = new PeerBook(smallReference({ nA: 15 }));
    expect(pb15.industrySlot("general", "Technology", "IndA", "A1", null).level).toBe("industry");
    expect(pb15.industrySlot("general", "Technology", "IndA", "A1", "1000").level).toBe("sector");
    expect(pb.classify("bbb")).toEqual({ sector: "Technology", industry: "IndB" });
  });

  it("주가 수준: 업종 50 · 시장 20 · 자기 지난 5년 30, 지난 5년이 없으면 남은 비교에 비례 배분(71 : 29)", () => {
    const pb = new PeerBook(smallReference());
    const own = Object.fromEntries(["A1", "A2", "A3", "A4", "A5"].map((k) => [k, Array.from({ length: 40 }, (_, i) => i)]));
    const r = scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: allMetrics(10.5), own, peers: pb });
    const a1 = r.families[0]!.metrics[0]!;
    const pInd = percentile(10.5, pb.industrySlot("general", "Technology", "IndA", "A1", null).sorted)!;
    const pMkt = percentile(10.5, pb.marketSlot("general", "A1").sorted)!;
    const pOwn = percentile(10.5, [...own["A1"]!, 10.5].sort((x, y) => x - y))!;
    expect(a1.pos).toEqual({ industry: pInd, market: pMkt, own: pOwn });
    expect(a1.score).toBeCloseTo((50 * pInd + 20 * pMkt + 30 * pOwn) / 100, 12);
    const noOwn = scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: allMetrics(10.5), own: {}, peers: pb });
    const b = noOwn.families[0]!.metrics[0]!;
    expect(b.score).toBeCloseTo((50 * pInd + 20 * pMkt) / 70, 12);
    expect(mixText(b.mix, "industry")).toBe("업종 71 · 시장 29");
    // 월말 35개(36 미만)면 자기 비교를 쓰지 않는다
    const short = scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: allMetrics(10.5), own: { A1: own["A1"]!.slice(0, 35) }, peers: pb });
    expect(short.families[0]!.metrics[0]!.pos.own).toBeUndefined();
  });

  it("묶음 비중 일반 30·25·20·15·10: 화면 정수로 한 단계씩 — 묶음 = 지표 정수의 평균, V = round(Σ W·round(F) / Σ W) (손으로 다시 계산해도 맞게)", () => {
    const pb = new PeerBook(smallReference());
    const metrics: MetricSet = { ...allMetrics(10.5), A1: { x: 20.5, show: 1 }, D1: { x: 0.5, show: 1 } };
    const r = scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics, own: {}, peers: pb });
    expect(r.status).toBe("ok");
    expect(r.coverageWeight).toBe(100);
    for (const f of r.families) {
      const present = f.metrics.filter((m) => m.score !== null);
      expect(f.score).toBeCloseTo(present.reduce((a, m) => a + roundScore(m.score!), 0) / present.length, 12);
    }
    const V = r.families.reduce((a, f) => a + VALUE_WEIGHTS.general[f.key] * roundScore(f.score!), 0) / 100;
    expect(r.score).toBeCloseTo(V, 12);
    expect(r.shown).toBe(roundScore(V));
    expect(r.families.map((f) => f.weight)).toEqual([30, 25, 20, 15, 10]);
  });

  it("리뷰 예: 묶음 정수 0·46·81·24·32 → (30·0 + 25·46 + 20·81 + 15·24 + 10·32) / 100 = 34.5 → 35 (예전처럼 소수 묶음 점수로 계산하면 34 가 될 수 있었다)", () => {
    const fam = (key: FamilyScore["key"], weight: number, score: number): FamilyScore => ({ key, weight, score, valid: true, why: null, metrics: [] });
    // 묶음 소수값이 반올림 경계 바로 아래(45.6·80.6·23.6·31.6)여도 화면 정수(46·81·24·32)로 계산
    const fams = [fam("price", 30, 0), fam("quality", 25, 45.6), fam("health", 20, 80.6), fam("growth", 15, 23.6), fam("payout", 10, 31.6)];
    const exactV = fams.reduce((a, f) => a + f.weight * f.score!, 0) / 100;
    const shownV = fams.reduce((a, f) => a + f.weight * roundScore(f.score!), 0) / 100;
    expect([roundScore(exactV), roundScore(shownV)]).toEqual([34, 35]);
  });

  it("금융사 묶음 비중 35·30·10·15·10, 금융사끼리만 비교", () => {
    const pb = new PeerBook(smallReference());
    const r = scoreValue({ path: "financial", sector: "Finance", industry: "Major Banks", cik: null, metrics: allMetrics(10.5), own: {}, peers: pb });
    expect(r.families.map((f) => [f.key, f.weight])).toEqual([
      ["price", 35],
      ["quality", 30],
      ["health", 10],
      ["growth", 15],
      ["payout", 10],
    ]);
    expect(r.families[0]!.metrics.map((m) => m.key)).toEqual(["A1", "A3"]);
    // 금융 20곳 안 위치 (일반 회사와 섞지 않음)
    expect(r.families[0]!.metrics[0]!.pos.market).toBe(percentile(10.5, pb.marketSlot("financial", "A1").sorted));
    expect(pb.marketSlot("financial", "A1").sorted).toHaveLength(20);
  });

  it("상태: 다섯 묶음 → ok, 비중 70~99 → partial, 70 미만 → 점수 없음(비중 표시), 주가 수준이 없으면 비중과 상관없이 점수 없음", () => {
    const pb = new PeerBook(smallReference());
    const run = (drop: string[]) => {
      const m = allMetrics(10.5);
      for (const k of drop) delete m[k as keyof MetricSet];
      return scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: m, own: {}, peers: pb });
    };
    expect(run([]).status).toBe("ok");
    const noPayout = run(["E1", "E2"]);
    expect([noPayout.status, noPayout.coverageWeight]).toEqual(["partial", 90]);
    // 주가 30 + 수익성 25 + 성장 15 = 70 (경계) → partial
    const seventy = run(["D1", "D2", "D3", "D4", "E1", "E2"]);
    expect([seventy.status, seventy.coverageWeight, seventy.shown !== null]).toEqual(["partial", 70, true]);
    // 주가 30 + 수익성 25 + 주주환원 10 = 65 → 점수 없음
    const sixtyFive = run(["D1", "D2", "D3", "D4", "C1", "C2", "C3"]);
    expect([sixtyFive.status, sixtyFive.coverageWeight, sixtyFive.shown]).toEqual(["insufficient", 65, null]);
    expect(sixtyFive.reasons).toEqual([{ code: "lowCoverage", pct: 65 }]);
    // 주가 수준 핵심(A1·A2) 없음
    const noPrice = run(["A1", "A2"]);
    expect(noPrice.status).toBe("insufficient");
    expect(noPrice.reasons[0]).toEqual({ code: "priceInvalid" });
    expect(noPrice.families[0]).toMatchObject({ valid: false, why: "noCore" });
  });

  it("묶음이 유효하려면 핵심 지표 + 정의된 지표의 절반 이상, 70% 규칙으로 안 쓰는 지표는 정의에서 뺀다", () => {
    const pb = new PeerBook(smallReference());
    const m = allMetrics(10.5);
    for (const k of ["B3", "B4", "B5", "B6"] as const) delete m[k];
    // 수익성 6개 중 B1·B2 만 → 2/6 < 절반 → 무효
    expect(scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: m, own: {}, peers: pb }).families[1]).toMatchObject({ valid: false, why: "tooFew" });
    // B3·B4·B5·B6 이 시장 70% 규칙으로 빠지면 정의가 2개 → 유효
    const pb2 = new PeerBook(smallReference({ coverage: { B3: 0.6, B4: 0.6, B5: 0.69, B6: 0.5 } }));
    const r = scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: m, own: {}, peers: pb2 });
    expect(r.families[1]!.valid).toBe(true);
    expect(r.families[1]!.metrics.find((x) => x.key === "B5")!.adopted).toBe(false);
  });

  it("0점 규칙은 위치와 상관없이 지표 점수 0, 맨 위 규칙은 같은 규칙 회사끼리 같은 순위", () => {
    const pb = new PeerBook(smallReference());
    const r = scoreValue({ path: "general", sector: "Technology", industry: "IndA", cik: null, metrics: { ...allMetrics(10.5), A1: { x: -Infinity, show: null, rule: "zeroLoss", why: "lossNi" }, D2: { x: Infinity, show: null, rule: "topTie", why: "netCash" } }, own: {}, peers: pb });
    expect(r.families[0]!.metrics[0]!.score).toBe(0);
    expect(r.families[2]!.metrics.find((m) => m.key === "D2")!.score).toBe(100);
  });

  it("띠는 보이는 정수로: 0~33 낮은 편 · 34~66 가운데쯤 · 67~100 높은 편, 반올림은 0.5 올림", () => {
    expect([valueBand(0), valueBand(33), valueBand(34), valueBand(66), valueBand(67), valueBand(100)]).toEqual(["낮은 편", "낮은 편", "가운데쯤", "가운데쯤", "높은 편", "높은 편"]);
    expect([roundScore(66.5), roundScore(66.49), roundScore(33.5)]).toEqual([67, 66, 34]);
  });

  it("표시: 가치 함정 · 경기 정점·바닥 · 영업 외 손익 · 주식 보상 · 초기 단계 · 업종 대신 부문 비교 · 금융사", () => {
    const pb = new PeerBook(smallReference());
    const metrics: MetricSet = { ...allMetrics(10.5), A1: { x: 30, show: 1 }, A2: { x: 30, show: 1 }, A3: { x: 30, show: 1 }, A4: { x: 30, show: 1 }, A5: { x: 30, show: 1 }, C1: { x: 0, show: 0 }, C2: { x: 0, show: 0 }, C3: { x: 0, show: 0 }, D1: { x: 0, show: 0 }, D2: { x: 0, show: 0 }, D3: { x: 0, show: 0 }, D4: { x: 0, show: 0 } };
    const r = scoreValue({ path: "general", sector: "Technology", industry: "IndB", cik: null, metrics, own: {}, peers: pb });
    const aux = { opMarginStd: 0.2, niToAvg5: 3, nonOpRatio: 3, sbcToRevenue: 0.3, equityToAssets: 0.5, coverage: 5, taxRate: 0.2, opAtHigh: true, opAtLow: false, earlyStage: true, payoutOver100: true, dividendCut: true, marginYears: 5, deepLossYears: 0 };
    const flags = valueFlags(r, aux, { cyclical: true, thresholds: pb.ref.thresholds, metrics });
    expect(flags).toEqual(["cyclicalPeak", "valueTrap", "oneOff", "sbcHeavy", "earlyStage", "payoutOver100", "dividendCut", "peerFallback"]);
    expect(valueFlags(r, { ...aux, dividendCut: false }, { cyclical: true, thresholds: pb.ref.thresholds, metrics })).not.toContain("dividendCut");
    expect(isCyclical("Semiconductors", null, { opMarginStdP70: 0.1 })).toBe(true);
    expect(isCyclical("IndA", 0.15, { opMarginStdP70: 0.1 })).toBe(true);
    expect(isCyclical("IndA", 0.05, { opMarginStdP70: 0.1 })).toBe(false);
    expect(isFinancial("Major Banks", {})).toBe(true);
    expect(isFinancial("Investment Bankers/Brokers/Service", { liabilities: 100, deposits: 30 })).toBe(true);
    // 예금이 없는 증권사(IBKR·HOOD 식): 자본 ÷ 총자산 < 25% 면 금융 경로 (설계 §4 7번 '증권'), 자산운용사처럼 자본이 두꺼우면 일반 경로
    expect(isFinancial("Investment Bankers/Brokers/Service", { liabilities: 88, assets: 100, equity: 12 })).toBe(true);
    expect(isFinancial("Investment Bankers/Brokers/Service", { liabilities: 60, assets: 100, equity: 40 })).toBe(false);
    expect(isFinancial("Investment Bankers/Brokers/Service", { liabilities: 88, assets: 100, equity: 8, equityTotal: 30 })).toBe(false);
    expect(isFinancial("Business Services", { liabilities: 88, assets: 100, equity: 12 })).toBe(false);
    expect(isFinancial("Finance: Consumer Services", { liabilities: 100 })).toBe(false);
    expect(isFinancial(null, {}, 6021)).toBe(true);
    expect(isFinancial(null, {}, 7372)).toBe(false);
  });
});

// ── 비교 기준 만들기 ──

describe("비교 기준 만들기 (Nasdaq 스크리너 · SEC frames)", () => {
  it("스크리너 원본 → 줄: 시가총액 숫자, 빈 칸 null, 우선주(^)·워런트·스팩·리츠는 비교 회사에서 뺀다, BRK/B → SEC 표기 BRK-B", () => {
    const rows = parseScreener(screenerSample());
    const by = (s: string) => rows.find((r) => r.symbol === s)!;
    expect(by("NVDA")).toEqual({ symbol: "NVDA", name: "NVIDIA Corporation Common Stock", marketCap: 5_412_378_000_000, sector: "Technology", industry: "Semiconductors", price: 224.58 });
    expect(screenerExcluded(by("NVDA"))).toBe(false);
    expect(screenerExcluded(by("O"))).toBe(true); // 리츠
    expect(screenerExcluded(rows.find((r) => r.symbol.includes("^"))!)).toBe(true);
    expect(screenerExcluded(rows.find((r) => /warrant/i.test(r.name))!)).toBe(true);
    expect(screenerExcluded(rows.find((r) => r.industry === "Blank Checks")!)).toBe(true);
    expect(rows.some((r) => r.marketCap === null)).toBe(true);
    expect(secTicker("BRK/B")).toBe("BRK-B");
    expect(parseScreener(null)).toEqual([]);
  });

  it("frames 원본 → 줄 (숫자가 아닌 줄은 버림)", () => {
    const rows = parseFrame(frameSample());
    expect(rows.find((r) => r.cik === 789019)).toEqual({ cik: 789019, start: "2024-07-01", end: "2025-06-30", val: 101_832_000_000 });
    expect(rows.every((r) => Number.isFinite(r.cik) && Number.isFinite(r.val))).toBe(true);
    expect(parseFrame({})).toEqual([]);
  });

  it("기간: 연간 CY(Y−6)~CY(Y), 최근 분기말은 기준일보다 50일 넘게 지난 분기, 1년 전, 연말 잔액", () => {
    expect(referencePeriods("2026-09-26")).toEqual({
      refDate: "2026-09-26",
      annual: ["CY2020", "CY2021", "CY2022", "CY2023", "CY2024", "CY2025", "CY2026"],
      latest: ["CY2026Q2I", "CY2026Q1I"],
      yearAgo: ["CY2025Q2I", "CY2025Q1I"],
      yearEnd: ["CY2020Q4I", "CY2021Q4I", "CY2022Q4I", "CY2023Q4I", "CY2024Q4I", "CY2025Q4I"],
    });
    expect(referencePeriods("2026-08-10").latest).toEqual(["CY2026Q1I", "CY2025Q4I"]);
    expect(referencePeriods("2027-01-02").latest).toEqual(["CY2026Q3I", "CY2026Q2I"]);
    const plan = framePlan(referencePeriods("2026-09-26"));
    expect(new Set(plan.map((p) => `${p.tag.name}|${p.period}`)).size).toBe(plan.length);
    // 매출·영업이익·순이익 7년, 주식 수 6년 × 두 태그, 나머지 흐름 3년 (문서 10장 '216번')
    expect(plan.length).toBe(216);
    // 비교 회사 주식 수도 대상 종목처럼 두 태그 (검토 지적: 앞 태그만 받던 것)
    expect(plan.filter((p) => p.key === "shares").map((p) => `${p.tag.name}|${p.period}`)).toEqual(
      ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfShareOutstandingBasicAndDiluted"].flatMap((t) => ["CY2021", "CY2022", "CY2023", "CY2024", "CY2025", "CY2026"].map((y) => `${t}|${y}`)),
    );
    expect(plan.filter((p) => p.tag.name === "NetCashProvidedByUsedInOperatingActivities").map((p) => p.period)).toEqual(["CY2024", "CY2025", "CY2026"]);
  });

  /** 가짜 frames: 회사마다 값 정의 → 태그·기간별 줄 */
  function synthetic() {
    type Co = { cik: number; sym: string; cap: number; ind: string; sec: string; fin?: boolean; ttmRowCY2026?: boolean; nodata?: boolean };
    const cos: Co[] = [];
    for (let k = 0; k < 30; k++) cos.push({ cik: 100 + k, sym: `G${k}`, cap: (k + 1) * 1e9, ind: k < 20 ? "Semiconductors" : "Computer Software: Prepackaged Software", sec: "Technology" });
    for (let k = 0; k < 6; k++) cos.push({ cik: 200 + k, sym: `B${k}`, cap: (k + 5) * 1e9, ind: "Investment Bankers/Brokers/Service", sec: "Finance", fin: true });
    cos.push({ cik: 301, sym: "AMZNX", cap: 50e9, ind: "Catalog/Specialty Distribution", sec: "Consumer Discretionary", ttmRowCY2026: true });
    cos.push({ cik: 303, sym: "NODATA", cap: 40e9, ind: "Semiconductors", sec: "Technology", nodata: true });
    const screener: ScreenerRow[] = [
      ...cos.map((c) => ({ symbol: c.sym, name: `${c.sym} Common Stock`, marketCap: c.cap, sector: c.sec, industry: c.ind })),
      { symbol: "G0/B", name: "G0 Class B", marketCap: 0.5e9, sector: "Technology", industry: "Semiconductors" }, // 같은 CIK, 작은 쪽
      { symbol: "REIT1", name: "REIT", marketCap: 30e9, sector: "Real Estate", industry: "Real Estate Investment Trusts" },
      { symbol: "PFD^A", name: "Pref", marketCap: 30e9, sector: "Finance", industry: "Major Banks" },
    ];
    // 스크리너 줄 수 하한(500)을 넘기려고 빈 줄을 더한다 (시가총액 없음 → 비교 회사 아님)
    for (let k = 0; k < 500; k++) screener.push({ symbol: `Z${k}`, name: "", marketCap: null, sector: "", industry: "" });
    const tickers = new Map<string, string>([...cos.map((c) => [c.sym, String(c.cik).padStart(10, "0")] as [string, string]), ["G0-B", "0000000100"]]);
    const frame = (tag: string, period: string): FrameRow[] => {
      const out: FrameRow[] = [];
      for (const c of cos) {
        if (c.nodata) continue;
        const y = Number(period.slice(2, 6));
        const annual = !period.includes("Q");
        const end = annual ? `${y}-12-31` : period.includes("Q2") ? `${y}-06-30` : period.includes("Q1") ? `${y}-03-31` : `${y}-12-31`;
        // 2026년 연간 보고서는 아직 없음 (AMZN 식 10-Q 12개월 줄만) — 2027년 1~3월 기준일은 '12월 결산 회사가 아직 연간 보고서를 내기 전'
        if (annual && y >= 2026) {
          if (c.ttmRowCY2026 && tag === "NetIncomeLoss" && y === 2026) out.push({ cik: c.cik, start: "2025-07-01", end: "2026-06-30", val: 999 });
          continue;
        }
        const scale = c.cap / 1e9;
        const g = 1 + 0.05 * (c.cik % 7);
        const yr = annual ? g ** (y - 2025) : 1;
        const v: Record<string, number | undefined> = {
          NetIncomeLoss: (c.cik % 5 === 0 ? -0.1 : 0.1) * scale * 1e9 * yr,
          Revenues: c.fin ? undefined : scale * 1e9 * yr,
          OperatingIncomeLoss: c.fin ? undefined : 0.15 * scale * 1e9 * yr,
          InterestIncomeExpenseNet: c.fin ? 0.3 * scale * 1e9 * yr : undefined,
          NoninterestIncome: c.fin ? 0.2 * scale * 1e9 * yr : undefined,
          NetCashProvidedByUsedInOperatingActivities: 0.12 * scale * 1e9,
          PaymentsToAcquirePropertyPlantAndEquipment: 0.03 * scale * 1e9,
          WeightedAverageNumberOfDilutedSharesOutstanding: 1e8,
          Assets: (c.fin ? 10 : 2) * scale * 1e9,
          Liabilities: (c.fin ? 9 : 1) * scale * 1e9,
          StockholdersEquity: 1 * scale * 1e9,
          Deposits: c.fin ? 5 * scale * 1e9 : undefined,
          LongTermDebt: c.fin ? undefined : 0.3 * scale * 1e9,
          CashAndCashEquivalentsAtCarryingValue: 0.2 * scale * 1e9,
          AssetsCurrent: c.fin ? undefined : 0.8 * scale * 1e9,
          LiabilitiesCurrent: c.fin ? undefined : 0.4 * scale * 1e9,
          PaymentsOfDividends: c.cik % 2 ? 0.01 * scale * 1e9 : undefined,
        };
        const val = v[tag];
        if (val !== undefined) out.push({ cik: c.cik, ...(annual ? { start: `${y}-01-01` } : {}), end, val });
      }
      return out;
    };
    return { screener, tickers, frame, cos };
  }

  it("합성 자료로: CIK 로 합치기, 시가총액 하위 20% 빼기, 리츠·우선주·재무 없는 회사 빼기, 예금 비중으로 금융사, 10-Q 12개월 줄은 회계연도가 아님, 채택 비율", async () => {
    const s = synthetic();
    const calls: string[] = [];
    let failOnce = true;
    const src: ReferenceSources = {
      screener: async () => s.screener,
      tickers: async () => s.tickers,
      frame: async (tag, period) => {
        calls.push(`${tag.name}|${period}`);
        if (tag.name === "GrossProfit" && period === "CY2025" && failOnce) {
          failOnce = false;
          throw new Error("잠깐 실패");
        }
        if (tag.name === "ShareBasedCompensation") throw new Error("계속 실패");
        return s.frame(tag.name, period);
      },
    };
    const slept: number[] = [];
    const d = await buildReferenceData(src, "2026-09-26", { pauseMs: 250, sleep: async (ms) => void slept.push(ms) });
    // 재무가 있는 회사 37곳(NODATA 빼고) → 시가총액 하위 20% 경계(보간) 아래 8곳을 빼면 29곳
    expect(d.counts.mapped).toBe(38);
    expect(d.counts.withData).toBe(37);
    expect(d.counts.universe).toBe(29);
    expect(d.peers.some((p) => p.t === "G0" || p.t === "G1")).toBe(false);
    expect(d.peers.every((p) => p.t !== "REIT1" && p.t !== "PFD^A" && p.t !== "NODATA" && p.t !== "G0/B")).toBe(true);
    const fin = d.peers.filter((p) => p.f === 1).map((p) => p.t);
    expect(fin.length).toBeGreaterThan(0);
    expect(fin.every((t) => t.startsWith("B"))).toBe(true);
    // 금융사 매출 = 순이자 + 비이자 → 매출 성장 값이 있음
    expect(d.coverage.financial["C1"]).toBe(1);
    // AMZN 식: CY2026 순이익 줄(2025-07~2026-06)은 회계연도 끝이 달라 쓰지 않고 CY2025 로
    const amzn = d.peers.find((p) => p.t === "AMZNX")!;
    expect(amzn.x[METRIC_ORDER.indexOf("A1")]).toBeCloseTo(0.1 * 50e9 / 50e9, 9);
    // 잠깐 실패는 한 번 더 받아 채우고, 계속 실패한 항목은 빠진 목록에
    expect(calls.filter((c) => c === "GrossProfit|CY2025")).toHaveLength(2);
    expect(d.missingFrames).toEqual(["ShareBasedCompensation|CY2024", "ShareBasedCompensation|CY2025", "ShareBasedCompensation|CY2026"]);
    // 지표 계산 확인용 시가총액·가격(가격이 없는 합성 줄은 빠짐), 업종 자리 층 표
    expect(d.quotes).toEqual({});
    expect(d.levels!.general["Technology|Semiconductors"]).toMatch(/^[ism]{46}$/);
    expect(slept.filter((ms) => ms === 250).length).toBeGreaterThan(100);
    expect(d.symbols["REIT1"]).toBeDefined(); // 대상 종목 분류용으로는 남김
    expect(d.method).toBe("VALUE-1");
  });

  it("1~3월에도 비교 회사가 빠지지 않는다 (리뷰 must): 12월 결산 회사가 아직 연간 보고서를 내지 않았으면 CY(Y−2) 로 — 예전에는 1/2~3/6 에 거의 다 빠졌다", async () => {
    const s = synthetic();
    const src: ReferenceSources = { screener: async () => s.screener, tickers: async () => s.tickers, frame: async (tag, period) => s.frame(tag.name, period) };
    const quiet = { sleep: async () => undefined };
    const base = await buildReferenceData(src, "2026-09-26", quiet);
    expect(base.counts.universe).toBe(29);
    for (const d of ["2026-12-26", "2027-01-02", "2027-01-09", "2027-02-06", "2027-03-06"]) {
      const r = await buildReferenceData(src, d, quiet);
      expect([d, r.counts.withData, r.counts.universe, r.counts.general, r.counts.financial]).toEqual([d, base.counts.withData, base.counts.universe, base.counts.general, base.counts.financial]);
      // AMZN 식 10-Q 12개월 줄(CY2026 틀 — 연간 보고서를 내기 전)은 여전히 쓰지 않고 CY2025 회계연도 값
      expect(r.peers.find((p) => p.t === "AMZNX")!.x[METRIC_ORDER.indexOf("A1")]).toBeCloseTo((0.1 * 50e9) / 50e9, 9);
      expect(r.peers.map((p) => p.x)).toEqual(base.peers.map((p) => p.x));
    }
    // 결산이 18개월보다 오래되면(연간 보고서를 1년 넘게 내지 않은 회사) 비교 회사에서 뺀다 — 남는 것은 앞 값이 18개월을 넘어
    // 12개월 줄(2026-06-30 끝, 15개월 전)을 그대로 쓰는 AMZNX 하나
    const late = await buildReferenceData(src, "2027-09-26", quiet);
    expect(late.counts.withData).toBe(1);
  });

  it("비교 회사 입력: 1월에 CY(Y−1) 틀의 값이 10-Q 12개월 줄이면 CY(Y−2) 회계연도로, 앞 값이 18개월보다 오래되었으면(회계연도 끝을 바꾼 회사) 그 값 그대로", () => {
    const p = referencePeriods("2027-01-15");
    const frames: FrameMap = new Map();
    const put = (tag: string, period: string, rows: FrameRow[]) => frames.set(`${tag}|${period}`, frameData(rows, tag === "NetIncomeLoss"));
    put("NetIncomeLoss", "CY2026", [
      { cik: 1, start: "2025-10-01", end: "2026-09-30", val: 50 }, // 12월 결산 회사의 10-Q 12개월 줄
      { cik: 2, start: "2025-10-01", end: "2026-09-30", val: 70 }, // 6월 결산 → 9월 결산으로 바꾼 회사 (앞 값 2024-06-30 은 18개월 넘음)
    ]);
    put("NetIncomeLoss", "CY2025", [{ cik: 1, start: "2025-01-01", end: "2025-12-31", val: 40 }]);
    put("NetIncomeLoss", "CY2024", [{ cik: 2, start: "2023-07-01", end: "2024-06-30", val: 60 }]);
    put("Assets", "CY2026Q3I", [
      { cik: 1, end: "2026-09-30", val: 100 },
      { cik: 2, end: "2026-09-30", val: 100 },
    ]);
    expect(peerInputs(1, frames, p)!.flow.netIncome).toBe(40);
    expect(peerInputs(2, frames, p)!.flow.netIncome).toBe(70);
    // 7월이면 앞 값(2025-12-31)도 아직 18개월 안 → 12개월 줄은 계속 건너뜀
    expect(peerInputs(1, frames, { ...p, refDate: "2027-07-01" })!.flow.netIncome).toBe(40);
  });

  it("비교 회사 수가 지난 기준보다 크게 줄면 저장하지 않는다 (모집단·일반 85%, 금융 80% 밑) — 35일보다 오래된 지난 기준과는 비교하지 않음", () => {
    const counts = (universe: number, general: number, financial: number) => ({ screener: 7000, mapped: 5000, withData: 3800, universe, general, financial });
    const prev = { refDate: "2026-09-26", counts: counts(3000, 2600, 400) };
    expect(referenceDrop(prev, { refDate: "2026-10-03", counts: counts(2950, 2560, 390) })).toBeNull();
    expect(referenceDrop(prev, { refDate: "2026-10-03", counts: counts(1200, 1000, 200) })).toBe("비교 회사 수가 지난 기준(2026-09-26)보다 크게 줄어 저장하지 않았습니다: 모집단 3000 → 1200, 일반 2600 → 1000, 금융 400 → 200");
    expect(referenceDrop(prev, { refDate: "2026-10-03", counts: counts(2900, 2560, 310) })).toMatch(/금융 400 → 310/);
    expect(referenceDrop(prev, { refDate: "2026-11-05", counts: counts(1200, 1000, 200) })).toBeNull();
    expect(referenceDrop(null, { refDate: "2026-10-03", counts: counts(10, 5, 5) })).toBeNull();
  });

  it("회사 수는 그대로여도 핵심 frames 가 빠졌거나 어느 지표든 채택 비율이 10%p 넘게 줄면 저장하지 않는다 — 한 주 동안 치우친 기준을 쓰지 않게 (검토 지적), 35일 규칙은 같다", () => {
    const counts = { screener: 7000, mapped: 5000, withData: 3800, universe: 3000, general: 2600, financial: 400 };
    const periods = { annual: ["CY2020", "CY2021", "CY2022", "CY2023", "CY2024", "CY2025", "CY2026"], latest: ["CY2026Q2I", "CY2026Q1I"], yearAgo: ["CY2025Q2I", "CY2025Q1I"] };
    const cov = { general: { A1: 1, C2: 0.8, E2: 0.78 }, financial: { A1: 1, F2: 0.87 } };
    const prev = { refDate: "2026-09-26", counts, coverage: cov };
    const next = (missingFrames: string[], coverage = cov, refDate = "2026-10-03") => ({ refDate, counts, coverage, missingFrames, periods });
    // 이력용 frames(순이익 CY2020·배당 등)만 빠졌으면 받아들인다
    expect(referenceDrop(prev, next(["NetIncomeLoss|CY2020", "PaymentsOfDividends|CY2026"]))).toBeNull();
    expect(keyFramesMissing(next(["NetIncomeLoss|CY2020", "NetIncomeLoss|CY2026", "Revenues|CY2021", "OperatingIncomeLoss|CY2025", "Assets|CY2026Q1I", "ProfitLoss|CY2025"]))).toEqual([
      "NetIncomeLoss|CY2026",
      "Revenues|CY2021",
      "OperatingIncomeLoss|CY2025",
      "Assets|CY2026Q1I",
    ]);
    expect(referenceDrop(prev, next(["NetIncomeLoss|CY2026"]))).toBe("새 비교 기준에 빠진 자료가 있어 저장하지 않았습니다(지난 기준 2026-09-26 그대로): 받지 못한 핵심 frames NetIncomeLoss|CY2026");
    expect(referenceDrop(prev, next(["Revenues|CY2024"]))).toMatch(/Revenues\|CY2024/);
    // 채택 비율: 1%p 흔들림은 그대로, 10%p 넘게 줄면 막는다 (금융 경로도)
    expect(referenceDrop(prev, next([], { general: { A1: 1, C2: 0.79, E2: 0.77 }, financial: { A1: 1, F2: 0.86 } }))).toBeNull();
    expect(referenceDrop(prev, next([], { general: { A1: 1, C2: 0.5, E2: 0.78 }, financial: { A1: 1, F2: 0.7 } }))).toBe(
      "새 비교 기준에 빠진 자료가 있어 저장하지 않았습니다(지난 기준 2026-09-26 그대로): 일반 C2 채택 비율 80% → 50%, 금융 F2 채택 비율 87% → 70%",
    );
    // 지난 기준이 35일보다 오래되었으면 받아들인다 (오래 막혀 있지 않게)
    expect(referenceDrop(prev, next(["NetIncomeLoss|CY2026"], cov, "2026-11-05"))).toBeNull();
    // 예전 기준(채택 비율 없음)과는 채택 비율을 비교하지 않는다
    expect(referenceDrop({ refDate: "2026-09-26", counts }, next([], { general: { C2: 0.1 }, financial: {} }))).toBeNull();
  });

  it("핵심 frames(최근 회계연도 순이익·최근 분기말 자산)를 받지 못하면 오류 — 지난 기준을 그대로 쓰게", async () => {
    const s = synthetic();
    const src: ReferenceSources = {
      screener: async () => s.screener,
      tickers: async () => s.tickers,
      frame: async (tag, period) => {
        if (tag.name === "Assets" && period === "CY2026Q2I") throw new Error("실패");
        return s.frame(tag.name, period);
      },
    };
    await expect(buildReferenceData(src, "2026-09-26", { sleep: async () => undefined })).rejects.toThrow(/핵심 frames/);
    // CY(Y−2) 순이익도 핵심 (1~3월에는 이것으로 비교 회사를 만든다)
    const src2: ReferenceSources = { ...src, frame: async (tag, period) => (tag.name === "NetIncomeLoss" && period === "CY2024" ? Promise.reject(new Error("실패")) : s.frame(tag.name, period)) };
    await expect(buildReferenceData(src2, "2026-09-26", { sleep: async () => undefined })).rejects.toThrow(/NetIncomeLoss\|CY2024/);
    await expect(buildReferenceData({ ...src, screener: async () => [] }, "2026-09-26", { sleep: async () => undefined })).rejects.toThrow(/스크리너/);
  });

  it("비교 회사 입력은 대상 종목과 같은 정의 (자산이 없는 분기면 대신 분기, 둘 다 없으면 null)", () => {
    const p = referencePeriods("2026-09-26");
    const frames: FrameMap = new Map();
    const put = (tag: string, period: string, rows: FrameRow[]) => frames.set(`${tag}|${period}`, frameData(rows, tag === "NetIncomeLoss"));
    put("NetIncomeLoss", "CY2025", [{ cik: 1, start: "2025-01-01", end: "2025-12-31", val: 10 }]);
    put("Assets", "CY2026Q1I", [{ cik: 1, end: "2026-03-31", val: 100 }]);
    put("StockholdersEquity", "CY2026Q1I", [{ cik: 1, end: "2026-03-31", val: 40 }]);
    const inp = peerInputs(1, frames, p)!;
    // 부채총계가 없으면 자산 − 자본 (대상 종목과 같은 규칙)
    expect(inp.bal).toEqual({ assets: 100, equity: 40, liabilities: 60 });
    expect(inp.flow.netIncome).toBe(10);
    expect(peerInputs(2, frames, p)).toBeNull();
  });
});

// ── 문구 ──

describe("문구 (금지어 · 미래형) — 가치 지표 모든 틀", () => {
  it("틀 문장에 걸리는 낱말이 없다", () => {
    const texts: string[] = [
      ...Object.values(VALUE_BAND_LINE),
      ...Object.values(VALUE_FAMILY_NAME),
      ...Object.values(VALUE_FAMILY_ABOUT),
      ...Object.values(METRIC_NAME),
      ...Object.values(RULE_TEXT),
      ...Object.values(VALUE_FLAG_TEXT),
      ...Object.values(VALUE_STATUS_TEXT),
      ...howLinesV2(),
      NOT_ADOPTED,
      PRICE_NOTE,
      PEER_TIMING_NOTE,
      BLEND_NOTE,
      gapText(35),
      lowCoverageText(65),
      carriedText("2026-09-24T21:00:00+09:00"),
      carriedBadge("2026-09-24T21:00:00+09:00"),
      peerFallbackText("sector", "기술"),
      peerFallbackText("market", null),
      valueHeadline(57, "가운데쯤"),
      valueHeadline(80, "높은 편"),
      valueHeadline(20, "낮은 편"),
      fiscalLabel("2026-07-26", "TTM"),
      fiscalShort("2026-06-30", "FY"),
      valueDatesLine({ priceThrough: "2026-09-25", fiscalEnd: "2026-07-26", basis: "TTM", filed: "2026-08-26", reference: "2026-09-26" }),
      peerLine({ level: "industry", nameKo: "반도체", n: 69, own: true, path: "general" }),
      peerLine({ level: "market", nameKo: null, n: 420, own: false, path: "financial" }),
      valueChangeText({ from: "2026-09-18", diff: -7, family: "price", familyDiff: -12, cause: causePrice(8.4) }),
      valueChangeText({ from: "2026-09-18", diff: 6, family: "growth", familyDiff: 20, cause: causeFiling("10-Q", "2026-08-26") }),
      valueChangeText({ from: "2026-09-18", diff: 6, family: "quality", familyDiff: 0, cause: causeReference("2026-09-26") }),
      causePrice(-3.2),
    ];
    for (const k of Object.keys(METRIC_NAME) as Array<keyof typeof METRIC_NAME>) {
      texts.push(metricMeaning(k), positionSentence(k, 90), positionSentence(k, 50), positionSentence(k, 10));
      texts.push(formatMetric(k, 12.34) ?? "", medianText(k, 0.05) ?? "", medianText(k, Infinity) ?? "", medianText(k, -Infinity) ?? "", positionText({ industry: 72.4, market: 60, own: 31 }, "industry"));
    }
    const bad = texts.flatMap((t) => scoreWordingProblems(t).map((w) => `${w} ← ${t}`));
    expect(bad).toEqual([]);
  });

  it("글자 모양: 조사(과·와), 값 단위, 가운데값 100배 넘음·적자, 위치 줄", () => {
    expect([gwaWa("같은 시장"), gwaWa("이 회사의 지난 5년"), gwaWa("금융사 전체"), gwaWa("같은 업종(반도체, 69개 회사)")]).toEqual(["과", "과", "와", "와"]);
    expect(peerLine({ level: "industry", nameKo: "반도체", n: 69, own: false, path: "general" })).toBe("같은 업종(반도체, 69개 회사)·같은 시장과 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다.");
    expect(peerLine({ level: "sector", nameKo: "기술", n: 404, own: true, path: "general" })).toBe("같은 부문(기술, 404개 회사)·같은 시장·이 회사의 지난 5년과 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다.");
    expect([formatMetric("A1", 27.94), formatMetric("B4", 46.83), formatMetric("C3", -5.5), formatMetric("A2", 4633.2)]).toEqual(["27.9배", "46.8%", "−5.5%p", "4,633배"]);
    expect([medianText("A1", 1 / 311), medianText("A1", -0.01), medianText("D2", Infinity), medianText("A3", 0.2)]).toEqual(["100배 넘음", "적자", "순현금", "5.0배"]);
    expect(positionText({ industry: 72.4, market: 60.5, own: 31 }, "industry")).toBe("업종 안 위치 72/100 · 시장 안 61/100 · 지난 5년 중 31/100");
    expect(positionText({ industry: 40, market: 40 }, "market")).toBe("시장 안 위치 40/100");
    expect(valueDatesLine({ priceThrough: "2026-09-25", fiscalEnd: "2026-07-26", basis: "TTM", filed: "2026-08-26", reference: "2026-09-26" })).toBe("주가 9월 25일(금)까지 20거래일 평균 · 재무 2026년 7월까지 최근 4분기, 8월 26일(수) 제출 · 비교 기준 9월 26일(토)");
    expect(fiscalShort("2026-07-26", "TTM")).toBe("재무 2026년 7월까지 4분기");
    expect(carriedBadge("2026-09-24T21:00:00+09:00")).toBe("지난 값 9/24");
  });
});

// ── 리뷰 뒤 고친 점 (2단계 2차): 층 바꾸기·같은 값 덩어리·주식 수 확인·지표 정의 ──

describe("업종 자리 층은 두 주 연속 조건이 바뀌어야 바뀐다 (설계 §7.1·§11.1)", () => {
  const M = METRIC_ORDER.length;
  const key = "Technology|IndA";
  const pairs = [["Technology", "IndA"]] as const;
  const levelsOf = (nA: number, prev?: ValueReferenceData["levels"]) => {
    const r = smallReference({ nA });
    return buildLevels(r.peers, r.sectors, r.industries, pairs, prev);
  };
  it("업종 20곳 → 14곳: 첫 주는 조건만 '부문'이고 쓰는 층은 업종 그대로, 둘째 주에 부문으로. 한 주만 바뀌었다 돌아오면 그대로", () => {
    const w1 = levelsOf(20);
    expect(w1.general[key]).toBe("i".repeat(2 * M));
    const w2 = levelsOf(14, w1);
    expect(w2.general[key]).toBe("s".repeat(M) + "i".repeat(M));
    expect(levelsOf(14, w2).general[key]).toBe("s".repeat(2 * M));
    expect(levelsOf(20, w2).general[key]).toBe("i".repeat(2 * M));
    // 지난주 층의 값이 10개보다 적으면 한 주 더 두지 않는다 (업종 9곳 + 업종 B 5곳 = 부문 14곳 → 시장)
    expect(levelsOf(9, w1).general[key]).toBe("m".repeat(2 * M));
  });
  it("비교 기준에 층 표가 있으면 PeerBook 이 그 층을 쓴다 (14곳이어도 이번 주는 업종), 없으면 그 자리에서 정함", () => {
    const w1 = levelsOf(20);
    const ref14 = smallReference({ nA: 14 });
    const held = new PeerBook({ ...ref14, levels: levelsOf(14, w1) });
    expect(held.industrySlot("general", "Technology", "IndA", "A1", null)).toMatchObject({ level: "industry", name: "IndA" });
    expect(new PeerBook(ref14).industrySlot("general", "Technology", "IndA", "A1", null).level).toBe("sector");
    // 둘째 주: 부문
    expect(new PeerBook({ ...ref14, levels: levelsOf(14, levelsOf(14, w1)) }).industrySlot("general", "Technology", "IndA", "A1", null).level).toBe("sector");
  });
});

describe("같은 값이 많은 지표 (무배당 0% 등) — 리뷰: '배당이 많은 편' 문장이 부풀려지지 않게", () => {
  const peerOf = (tie: number, tieX: number | null) => ({ level: "industry" as const, name: "Semiconductors", n: 60, median: 0, tie, tieX });
  const m = (key: MetricScore["key"], x: number, score: number, peer = peerOf(0.1, 1)): MetricScore => ({ key, adopted: true, x, show: 100 * x, score, pos: { industry: score, market: score }, mix: { industry: 50, market: 50 }, peer, ownN: 0 });
  it("가장 많이 겹친 값과 비율", () => {
    expect(PeerBook.tie([0, 0, 0, 1, 2])).toEqual({ share: 0.6, x: 0 });
    expect(PeerBook.tie([1, 2, 3, 3])).toEqual({ share: 0.5, x: 3 });
    expect(PeerBook.tie([])).toBeNull();
  });
  it("비교 회사의 절반 이상이 0% 이고 이 회사는 0.1% → 띠 문장('배당이 많은 편') 대신 중립 문장과 안내, 묶음 머리 문장은 다른 지표로 (검토 지적)", () => {
    const e1 = m("E1", 0.001, 85, peerOf(0.7, 0));
    const e2 = m("E2", 0.01, 70);
    const row = metricRow(e1);
    expect(row.text).toBe(tieSentence(70, "0.0%", true));
    expect(row.text).toBe("비교한 회사 대부분(70%)이 0.0%라 위치 점수가 크게 나왔습니다.");
    expect(row.text).not.toContain("많은 편");
    expect(row.note).toBe(TIE_NOTE);
    expect(metricRow(e2).note).toBeNull();
    const fam: FamilyScore = { key: "payout", weight: 10, score: 77.5, valid: true, why: null, metrics: [e1, e2] };
    expect(familyRow(fam).text).toBe("주식 수 변화 (3년 연평균) — 주식 수가 줄어든 편입니다.");
    // 이 회사도 무배당(같은 값 안)이면 안내 없이 띠 문장 · 모든 지표가 덩어리에 좌우되면 머리 문장도 중립 문장
    expect(metricRow(m("E1", 0, 35, peerOf(0.7, 0)))).toMatchObject({ note: null, text: "비교한 회사들 가운데쯤입니다." });
    expect(familyRow({ ...fam, metrics: [e1] }).text).toBe("배당수익률 — 비교한 회사 대부분(70%)이 0.0%라 위치 점수가 크게 나왔습니다.");
    // 덩어리보다 아래(위치가 낮게)면 '작게', 절반을 조금 넘으면 '절반 이상'
    expect(metricRow(m("E2", -0.01, 20, peerOf(0.55, 0))).text).toBe("비교한 회사 절반 이상(55%)이 0.0%라 위치 점수가 작게 나왔습니다.");
    expect([iraRa("0.0%"), iraRa("100배 넘음"), iraRa("순현금"), iraRa("적자")]).toEqual(["라", "이라", "이라", "라"]);
  });

  it("맨 위 규칙(순현금): 문장에 '순현금 회사끼리는 같은 순위', 보이는 위치(예: 68)가 그 무리의 가운데라는 안내 (검토 지적)", () => {
    const d2: MetricScore = { key: "D2", adopted: true, x: Infinity, show: -5, rule: "topTie", why: "netCash", score: 73, pos: { industry: 68, market: 79 }, mix: { industry: 50, market: 50 }, peer: { level: "industry", name: "IndA", n: 60, median: Infinity, tie: 0.64, tieX: Infinity }, ownN: 0 };
    const row = metricRow(d2);
    expect(row.text).toBe("빚보다 현금이 많아(순현금) 가장 높은 순위로 두었습니다(순현금 회사끼리는 같은 순위).");
    expect(row.positions).toBe("업종 안 위치 68/100 · 시장 안 79/100");
    // p = 100 × (1 − 0.5 × 같은 회사 비율) → 비율 = 2 × (100 − 68) = 64%
    expect(row.note).toBe(topTieNote("업종", 64, 68));
    expect(row.note).toBe("업종 비교 회사의 64%가 같은 맨 위 순위라, 위치 점수는 그 무리의 가운데 값(68)입니다.");
    // 맨 위가 이 회사 하나뿐(위치 100)이면 안내 없음
    expect(metricRow({ ...d2, pos: { industry: 100, market: 100 } }).note).toBeNull();
    for (const k of ["netCash", "evNonPositive", "noInterest"] as const) expect(RULE_TEXT[k]).toMatch(/같은 순위\)\.$/);
  });
});

describe("주식 수 확인 (리뷰: 마지막 보고서 뒤 분할이면 시가총액이 분할 배수만큼 틀린다)", () => {
  const q = { cap: 100e9, price: 100 }; // Nasdaq 주식 수 10억 주
  it("SEC 주식 수 ÷ Nasdaq 주식 수 < 0.6 (정분할) · > 8 (큰 병합), 점수용 시가총액 ÷ Nasdaq 시가총액 < 0.4 → 보류", () => {
    expect(sharesMismatch(q, 1e9, 100)).toBeNull();
    expect(sharesMismatch(q, 0.97e9, 80)).toBeNull(); // 자사주 매입·20일 평균이 20% 낮음
    // 10:1 분할 뒤 봉은 보정됐는데 SEC 주식 수는 분할 전 → 시가총액 1/10
    expect(sharesMismatch(q, 0.1e9, 100)).toEqual({ shares: 0.1, cap: 0.1 });
    // 1:10 병합
    expect(sharesMismatch(q, 10e9, 100)).toMatchObject({ shares: 10 });
    // 비교 기준을 만든 뒤 생긴 3:1 분할: Nasdaq 주식 수는 아직 분할 전이지만 시가총액이 1/3
    expect(sharesMismatch(q, 1e9, 33)).toMatchObject({ cap: 0.33 });
    // 여러 종류 주식(상장 종류만 시가총액)으로 SEC 주식 수가 2배 → 보류하지 않음
    expect(sharesMismatch(q, 2e9, 100)).toBeNull();
    expect(sharesMismatch(null, 0.1e9, 100)).toBeNull();
  });
});

describe("지표 정의 (리뷰: 설계와 다른 곳)", () => {
  it("ROIC 투하자본·부채비율은 자본총계(비지배지분 포함) — PBR·ROE 는 지배주주 자본", () => {
    const m = computeMetrics(inputs({ bal: { equity: 140, nci: 20, equityTotal: 160 } }), 400, CTX);
    // 투하자본 160 + 50 − 30 = 180
    expect(m.B2?.x).toBeCloseTo((30 * 0.8) / 180, 12);
    expect(m.D1?.x).toBeCloseTo(-(110 / 160), 12);
    expect(m.A3?.x).toBeCloseTo(140 / 400, 12);
    // 자본총계 태그가 없으면 지배주주 자본 + 비지배지분
    expect(computeMetrics(inputs({ bal: { equity: 140, nci: 20 } }), 400, CTX).D1?.x).toBeCloseTo(-(110 / 160), 12);
  });

  it("이익 안정성: 최근 5년 가운데 절반 넘는 해에 영업손실이 매출보다 크면 0점 (−100% 로 잘린 값끼리 오르내림 0 → 맨 위가 되던 것, RGTI)", () => {
    const years = (ops: number[]) => ops.map((op, i) => ({ end: `${2021 + i}-12-31`, revenue: 10, opIncome: op, netIncome: op, shares: 100, assets: 200, equity: 120 }));
    const deep = computeMetrics(inputs({ annual: years([-80, -70, -3, -75, -73]) }), 400, CTX);
    expect(deep.B5).toEqual({ x: -Infinity, show: null, rule: "zeroLoss", why: "deepLoss" });
    expect(computeAux(inputs({ annual: years([-80, -70, -3, -75, -73]) }))).toMatchObject({ marginYears: 5, deepLossYears: 4, opMarginStd: expect.closeTo(0.28, 2) });
    // 두 해만이면 그대로 순위
    expect(computeMetrics(inputs({ annual: years([-80, -70, 1, 2, 3]) }), 400, CTX).B5?.rule).toBeUndefined();
    const rgti = book("RGTI").inputs("2026-09-28")!;
    expect(computeMetrics(rgti, 5e9, CTX).B5).toMatchObject({ rule: "zeroLoss", why: "deepLoss" });
  });

  it("배당: 올해 처음 배당한 회사는 올해 누적을 최근 4분기로 (META 2024 식), 배당 기록이 있는데 만들 수 없으면 '자료 없음'(0% 와 다름), 기록이 없으면 0%", () => {
    const base = (dividends: CompactFacts["flows"]["dividends"]): CompactFacts => ({
      v: 1,
      cik: "0000000001",
      name: null,
      lastFiled: null,
      shares: [["2026-04-01", "2026-06-30", 100, "2026-08-05", "10-Q", 0]],
      inst: {},
      flows: {
        netIncome: [
          ["2025-01-01", "2025-12-31", 100, "2026-02-10", "10-K", 0],
          ["2025-01-01", "2025-06-30", 50, "2026-08-05", "10-Q", 0],
          ["2026-01-01", "2026-06-30", 60, "2026-08-05", "10-Q", 0],
        ],
        ...(dividends ? { dividends } : {}),
      },
    });
    // 올해 6개월 누적 8 만 있음 (작년 연간·같은 기간 없음) → 8
    const started = new FactBook(base([["2026-01-01", "2026-06-30", 8, "2026-08-05", "10-Q", 0]])).inputs("2026-09-01")!;
    expect([started.flow.dividends, started.divUnknown]).toEqual([8, undefined]);
    // 작년 7월에 시작: 작년 연간 5, 작년 6개월 없음, 올해 6개월 8 → 5 + 8
    const lastYear = new FactBook(base([["2025-01-01", "2025-12-31", 5, "2026-02-10", "10-K", 0], ["2026-01-01", "2026-06-30", 8, "2026-08-05", "10-Q", 0]])).inputs("2026-09-01")!;
    expect(lastYear.flow.dividends).toBe(13);
    // 작년 연간 20 은 있는데 이번 10-Q 에 배당 줄이 없음 → 만들 수 없음 → 자료 없음
    const unknown = new FactBook(base([["2025-01-01", "2025-12-31", 20, "2026-02-10", "10-K", 0]])).inputs("2026-09-01")!;
    expect([unknown.flow.dividends, unknown.divUnknown]).toEqual([undefined, true]);
    expect(computeMetrics({ ...inputs(), flow: { ...inputs().flow, dividends: undefined }, divUnknown: true }, 400, CTX).E1).toEqual({ x: null, show: null, rule: "notComputed", why: "noDividendData" });
    // 배당 기록이 없으면 무배당 0%
    const none = new FactBook(base(undefined)).inputs("2026-09-01")!;
    expect([none.flow.dividends, none.divUnknown]).toEqual([undefined, undefined]);
    expect(computeMetrics({ ...inputs(), flow: { ...inputs().flow, dividends: undefined } }, 400, CTX).E1).toEqual({ x: 0, show: 0 });
    expect(RULE_TEXT.noDividendData).toContain("배당이 없다는 뜻이 아닙니다");
  });
});

describe("검토 지적 3차 (배당 삭감 표시 · 비교 회사 주식 수 두 태그 · 금융사 말 · 연간 기준 글 · 회사 수)", () => {
  /** 연간 주당배당·주식 수만 있는 작은 재무 (회계연도 12월) */
  const divBook = (years: Array<[number, number | null, number]>) => {
    const flows: CompactFacts["flows"] = {
      netIncome: years.map(([y]) => [`${y}-01-01`, `${y}-12-31`, 100, `${y + 1}-02-10`, "10-K", 0] as const).map((r) => [...r]) as never,
      dps: years.filter(([, d]) => d !== null).map(([y, d]) => [`${y}-01-01`, `${y}-12-31`, d!, `${y + 1}-02-10`, "10-K", 0]) as never,
    };
    const shares = years.map(([y, , s]) => [`${y}-01-01`, `${y}-12-31`, s, `${y + 1}-02-10`, "10-K", 0]) as never;
    return new FactBook({ v: 1, cik: "0000000001", name: null, lastFiled: null, flows, shares, inst: {} });
  };
  it("배당 삭감 표시(dividendCut, 설계 §12): 최근 5년 가운데 1주당 배당이 앞 해의 99% 밑으로 줄어든 해 — 분할(주식 수 10배)은 그 배수로 맞춰 비교", () => {
    const rising = divBook([[2020, 1, 100], [2021, 1.1, 100], [2022, 1.2, 99], [2023, 1.3, 98], [2024, 1.4, 97], [2025, 1.5, 96]]);
    expect(rising.dividendCut("2026-09-01")).toBe(false);
    const cut = divBook([[2020, 1, 100], [2021, 1.1, 100], [2022, 0.6, 99], [2023, 0.6, 98], [2024, 0.6, 97], [2025, 0.6, 96]]);
    expect(cut.dividendCut("2026-09-01")).toBe(true);
    expect(cut.inputs("2026-09-01")!.dividendCut).toBe(true);
    // 10:1 분할 (NVDA 2024 식): 앞 해 0.16 / 25억 주 → 0.016 / 250억 주(자사주 매입으로 9.89배) — 줄어든 것이 아님
    expect(divBook([[2021, 0.16, 2535], [2022, 0.016, 25070], [2023, 0.016, 24940], [2024, 0.034, 24804], [2025, 0.04, 24514]]).dividendCut("2026-09-01")).toBe(false);
    // 분할 해에 1주당 배당도 실제로 줄었으면 줄어든 것
    expect(divBook([[2021, 0.16, 2535], [2022, 0.01, 25070], [2023, 0.016, 24940]]).dividendCut("2026-09-01")).toBe(true);
    // 배당 값이 없는 해(배당 시작 전·태그 없음)는 비교하지 않음, 6년보다 오래된 삭감은 세지 않음
    expect(divBook([[2023, null, 100], [2024, 2, 100], [2025, 2.1, 100]]).dividendCut("2026-09-01")).toBe(false);
    expect(divBook([[2018, 2, 100], [2019, 1, 100], [2020, 1, 100], [2021, 1, 100], [2022, 1, 100], [2023, 1, 100], [2024, 1, 100], [2025, 1, 100]]).dividendCut("2026-09-01")).toBe(false);
    // 반올림 차이(1% 안)는 줄어든 것이 아님
    expect(divBook([[2024, 1, 100], [2025, 0.995, 100]]).dividendCut("2026-09-01")).toBe(false);
    expect([splitFactor(2535, 25070), splitFactor(100, 148), splitFactor(100, 130), splitFactor(1000, 100), splitFactor(null, 5)]).toEqual([10, 1.5, 1, 0.1, 1]);
    // 기록한 실제 재무: 모두 줄어든 해 없음 (NVDA 는 2024 분할)
    for (const t of ["NVDA", "MSFT", "AAPL", "META", "JPM", "RGTI"] as const) expect(book(t).dividendCut("2026-09-28")).toBe(false);
    expect(VALUE_FLAG_TEXT.dividendCut).toBe("최근 5년 가운데 1주당 배당이 앞 해보다 줄어든 해가 있습니다.");
  });

  it("비교 회사 주식 수: 앞 태그(희석 가중평균)가 없는 회사는 '기본·희석 같음' 태그로 — 주식 수 변화·주당이익 증가폭이 대상 종목과 같은 정의", () => {
    const p = referencePeriods("2026-09-26");
    const frames: FrameMap = new Map();
    const put = (tag: string, period: string, rows: FrameRow[]) => frames.set(`${tag}|${period}`, frameData(rows, tag === "NetIncomeLoss"));
    for (const y of [2021, 2022, 2023, 2024, 2025]) {
      put("NetIncomeLoss", `CY${y}`, [{ cik: 1, start: `${y}-01-01`, end: `${y}-12-31`, val: 10 }, { cik: 2, start: `${y}-01-01`, end: `${y}-12-31`, val: 10 }]);
      put("WeightedAverageNumberOfDilutedSharesOutstanding", `CY${y}`, [{ cik: 1, start: `${y}-01-01`, end: `${y}-12-31`, val: 100 }]);
      put("WeightedAverageNumberOfShareOutstandingBasicAndDiluted", `CY${y}`, [{ cik: 1, start: `${y}-01-01`, end: `${y}-12-31`, val: 999 }, { cik: 2, start: `${y}-01-01`, end: `${y}-12-31`, val: 200 - 10 * (y - 2021) }]);
    }
    put("Assets", "CY2026Q2I", [{ cik: 1, end: "2026-06-30", val: 100 }, { cik: 2, end: "2026-06-30", val: 100 }]);
    // 앞 태그가 있으면 앞 태그 (대상 종목의 annualShares 와 같은 순서)
    expect(peerInputs(1, frames, p)!.annual.map((a) => a.shares)).toEqual([100, 100, 100, 100, 100]);
    expect(peerInputs(2, frames, p)!.annual.map((a) => a.shares)).toEqual([200, 190, 180, 170, 160]);
    expect(computeMetrics(peerInputs(2, frames, p)!, 1000, CTX).E2?.x).toBeGreaterThan(0);
  });

  it("금융사 경로의 지표 줄은 '시장' 대신 '금융사 전체' (비교 회사가 금융사 전체이므로), 일반 회사는 그대로", () => {
    const f1: MetricScore = { key: "F1", adopted: true, x: 0.014, show: 1.4, score: 77, pos: { industry: 81, market: 66 }, mix: { industry: 50, market: 50 }, peer: { level: "industry", name: "Major Banks", n: 229, median: 0.01, tie: 0.01, tieX: 0.01 }, ownN: 0 };
    const fin = metricRow(f1, { path: "financial", annualEnd: null });
    expect([fin.positions, fin.mix, fin.peerMedian]).toEqual(["업종 안 위치 81/100 · 금융사 전체 안 66/100", "업종 50 · 금융사 전체 50", "업종 가운데값 1.0%"]);
    const atMarket = metricRow({ ...f1, pos: { industry: 66, market: 66 }, peer: { ...f1.peer!, level: "market", name: null } }, { path: "financial", annualEnd: null });
    expect([atMarket.positions, atMarket.mix, atMarket.peerMedian]).toEqual(["금융사 전체 안 위치 66/100", "금융사 전체 50 · 금융사 전체 50", "금융사 전체 가운데값 1.0%"]);
    expect(JSON.stringify(fin) + JSON.stringify(atMarket)).not.toMatch(/시장/);
    expect(metricRow(f1, { path: "general", annualEnd: null }).positions).toBe("업종 안 위치 81/100 · 시장 안 66/100");
    expect(peerFallbackText("market", null, "financial")).toBe("같은 업종 회사가 적어 금융사 전체와 비교했습니다.");
    expect(peerFallbackText("market", null)).toBe("같은 업종 회사가 적어 시장 전체와 비교했습니다.");
    expect(peerFallbackText("sector", "기술")).toBe("같은 업종 회사가 적어 같은 부문(기술) 전체와 비교했습니다.");
  });

  it("연간 재무로 계산한 지표(성장 3년 · 이익·ROE 안정성 5년 · 주식 수 변화 3년)에는 기준 글 '2026년 1월 결산 연간 기준' — 최근 4분기 값으로 읽히지 않게", () => {
    const row = (key: MetricScore["key"]) => metricRow({ key, adopted: true, x: 0.1, show: 10, score: 60, pos: { industry: 60 }, mix: { industry: 100 }, peer: { level: "industry", name: "X", n: 30, median: 0.1, tie: 0.05, tieX: 0.1 }, ownN: 0 }, { path: "general", annualEnd: "2026-01-25" });
    for (const k of ["C1", "C2", "C3", "B5", "F2", "E2"] as const) expect(row(k).basis).toBe("2026년 1월 결산 연간 기준");
    for (const k of ["A1", "B1", "B4", "D1", "E1"] as const) expect(row(k).basis).toBeNull();
    expect(annualBasis("2025-09-27")).toBe("2025년 9월 결산 연간 기준");
  });

  it("비교한 회사 수는 대상 종목 자신을 빼고 센다 ('69개 회사'라 하고 68곳과 비교하던 것)", () => {
    const pb = new PeerBook(smallReference());
    expect(pb.groupSize("general", "industry", "IndA", null)).toBe(20);
    expect(pb.groupSize("general", "industry", "IndA", "1000")).toBe(19);
    expect(pb.groupSize("general", "market", null, "1000")).toBe(34);
    expect(pb.groupSize("general", "industry", "IndA", "9999")).toBe(20);
  });

  it("새 문장에 걸리는 낱말이 없다", () => {
    const all = [tieSentence(77, "0.0%", true), tieSentence(55, "−0.2%p", false), TIE_NOTE, topTieNote("금융사 전체", 40, 80), annualBasis("2026-01-25"), peerFallbackText("market", null, "financial"), VALUE_FLAG_TEXT.dividendCut, ...Object.values(VALUE_STATUS_TEXT)];
    expect(all.flatMap((t) => scoreWordingProblems(t))).toEqual([]);
    // 이유 글은 상태 글('계산 준비 중'·'잠시 보류')로 시작하지 않는다 (요약 카드가 상태 글 옆에 이유 글을 둔다 — 같은 말 두 번)
    for (const t of Object.values(VALUE_STATUS_TEXT)) expect(t).not.toMatch(/^(계산 준비 중|잠시 보류|점수 없음|대상 아님)/);
  });
});
