/**
 * 가치 지표 점수 (3-44 2단계, VALUE-1) 에 쓰는 SEC XBRL 항목과 태그 별칭. 대상 종목(companyfacts)과 비교 회사(frames)가 같은 표를 쓴다 —
 * 두 쪽이 같은 정의로 계산되어야 순위가 뜻을 가진다.
 *  - 한 항목에 태그가 여럿이면 앞쪽이 먼저. 회사마다 가장 최근 기간 값이 있는 태그를 먼저 쓰고(태그 이름이 바뀐 회사 — NVDA 설비투자·이자비용),
 *    그 태그에 없는 기간만 다음 태그로 채운다 (analysis/secFacts)
 *  - us-gaap 만 쓴다 (IFRS 로 보고하는 외국 회사는 v1 에서 계산하지 않음 — 비교 회사 표(frames)도 달러 us-gaap 값뿐)
 *  - 증권사가 낸 앞날 추정 숫자와 의견은 SEC 자료에 없다 (보고된 숫자만)
 */

export type FactUnit = "USD" | "shares" | "USD/shares";
export interface FactTag {
  name: string;
  unit: FactUnit;
}
const usd = (name: string): FactTag => ({ name, unit: "USD" });

/** 기간 값(손익·현금흐름) — 최근 4분기 합(TTM)을 만든다 */
export const FLOW_TAGS = {
  revenue: [
    usd("Revenues"),
    usd("RevenuesNetOfInterestExpense"), // 은행 순영업수익 (JPM)
    usd("RevenueFromContractWithCustomerExcludingAssessedTax"),
    usd("RevenueFromContractWithCustomerIncludingAssessedTax"),
    usd("SalesRevenueNet"),
  ],
  opIncome: [usd("OperatingIncomeLoss")],
  netIncome: [usd("NetIncomeLoss"), usd("ProfitLoss")],
  grossProfit: [usd("GrossProfit")],
  costOfRevenue: [usd("CostOfRevenue"), usd("CostOfGoodsAndServicesSold")],
  ocf: [usd("NetCashProvidedByUsedInOperatingActivities"), usd("NetCashProvidedByUsedInOperatingActivitiesContinuingOperations")],
  // NVDA: 2011년 보고는 앞 태그, 2024~2026 은 뒤 태그
  capex: [usd("PaymentsToAcquirePropertyPlantAndEquipment"), usd("PaymentsToAcquireProductiveAssets")],
  // NVDA·MSFT: ~2024 InterestExpense → 2025~ InterestExpenseNonoperating, META: InterestExpenseDebt
  interest: [usd("InterestExpense"), usd("InterestExpenseNonoperating"), usd("InterestExpenseDebt")],
  tax: [usd("IncomeTaxExpenseBenefit")],
  pretax: [
    usd("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"),
    usd("IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"),
  ],
  // 배당 지급액: 회사마다 태그가 다르다 (MSFT·WFC 앞 태그, JPM·KO PaymentsOfDividends, BAC·JNJ 보통주 현금배당 선언액·PaymentsOfOrdinaryDividends)
  dividends: [
    usd("PaymentsOfDividendsCommonStock"),
    usd("PaymentsOfDividends"),
    usd("PaymentsOfOrdinaryDividends"),
    usd("DividendsCommonStockCash"),
    usd("DividendsCommonStock"),
  ],
  dps: [
    { name: "CommonStockDividendsPerShareDeclared", unit: "USD/shares" },
    { name: "CommonStockDividendsPerShareCashPaid", unit: "USD/shares" },
  ],
  sbc: [usd("ShareBasedCompensation"), usd("AllocatedShareBasedCompensationExpense")],
  // 은행: 매출 합계 태그가 없으면 순이자이익 + 비이자이익 (기존 edgar.ts 은행 매출 규칙과 같은 기준)
  nii: [usd("InterestIncomeExpenseNet")],
  nonii: [usd("NoninterestIncome")],
} as const satisfies Record<string, readonly FactTag[]>;
export type FlowKey = keyof typeof FLOW_TAGS;

/** 희석 가중평균 주식 수 (기간 값이지만 더하지 않는다 — 가장 최근 분기 값·연간 값) */
export const SHARE_TAGS: readonly FactTag[] = [
  { name: "WeightedAverageNumberOfDilutedSharesOutstanding", unit: "shares" },
  { name: "WeightedAverageNumberOfShareOutstandingBasicAndDiluted", unit: "shares" },
];

/** 잔액(재무상태표 시점 값) */
export const INSTANT_TAGS = {
  equity: [usd("StockholdersEquity")],
  equityTotal: [usd("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest")],
  nci: [usd("MinorityInterest")],
  assets: [usd("Assets")],
  liabilities: [usd("Liabilities")],
  assetsCurrent: [usd("AssetsCurrent")],
  liabilitiesCurrent: [usd("LiabilitiesCurrent")],
  cash: [usd("CashAndCashEquivalentsAtCarryingValue"), usd("CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents")],
  // 단기금융상품: MSFT ShortTermInvestments, NVDA 2026~ DebtSecuritiesCurrent, AAPL·META MarketableSecuritiesCurrent
  stInvest: [usd("MarketableSecuritiesCurrent"), usd("ShortTermInvestments"), usd("DebtSecuritiesCurrent"), usd("AvailableForSaleSecuritiesDebtSecuritiesCurrent")],
  ltd: [usd("LongTermDebt")],
  // KO·PEP·T·HD 는 장기차입금을 리스 의무와 합친 태그로 보고한다 (비유동 · 유동)
  ltdNoncurrent: [usd("LongTermDebtNoncurrent"), usd("LongTermDebtAndCapitalLeaseObligations")],
  ltdCurrent: [usd("LongTermDebtCurrent"), usd("LongTermDebtAndCapitalLeaseObligationsCurrent")],
  debtCurrent: [usd("DebtCurrent")],
  stBorrowings: [usd("ShortTermBorrowings")],
  commercialPaper: [usd("CommercialPaper")],
  opLease: [usd("OperatingLeaseLiability")],
  opLeaseNoncurrent: [usd("OperatingLeaseLiabilityNoncurrent")],
  opLeaseCurrent: [usd("OperatingLeaseLiabilityCurrent")],
  finLease: [usd("FinanceLeaseLiability")],
  finLeaseNoncurrent: [usd("FinanceLeaseLiabilityNoncurrent")],
  finLeaseCurrent: [usd("FinanceLeaseLiabilityCurrent")],
  // 금융사 판별 (예금 · 보험 준비금)
  deposits: [usd("Deposits")],
  policyReserves: [usd("LiabilityForFuturePolicyBenefits")],
  claimReserves: [usd("LiabilityForClaimsAndClaimsAdjustmentExpense")],
} as const satisfies Record<string, readonly FactTag[]>;
export type InstantKey = keyof typeof INSTANT_TAGS;

export const FLOW_KEYS = Object.keys(FLOW_TAGS) as FlowKey[];
export const INSTANT_KEYS = Object.keys(INSTANT_TAGS) as InstantKey[];

/** 모든 태그 이름 (companyfacts 에서 이것만 남긴다) */
export function allTagNames(): string[] {
  const out = new Set<string>();
  for (const k of FLOW_KEYS) for (const t of FLOW_TAGS[k]) out.add(t.name);
  for (const t of SHARE_TAGS) out.add(t.name);
  for (const k of INSTANT_KEYS) for (const t of INSTANT_TAGS[k]) out.add(t.name);
  return [...out];
}

/**
 * 총차입금 = 장기차입금(유동 포함) + 단기차입금·기업어음 + 리스부채 (설계: 'EV = 시가총액 + 총차입금(리스부채 포함) + 비지배지분 − 현금·단기금융상품').
 *  - LongTermDebt 가 있으면 그것(유동 부분 포함), 없으면 비유동 + 유동(LongTermDebtCurrent, 없으면 DebtCurrent)
 *  - DebtCurrent 로 유동 부분을 채웠으면 단기차입금·기업어음은 이미 들어 있을 수 있어 더하지 않는다
 *  - 단기차입금(ShortTermBorrowings)과 기업어음(CommercialPaper)이 둘 다 있으면 큰 쪽 하나만 — 기업어음을 단기차입금 합계 안에 넣어
 *    보고하는 회사가 많아 둘을 더하면 같은 빚을 두 번 센다 (검토 지적)
 *  - 리스: OperatingLeaseLiability(없으면 비유동 + 유동) + FinanceLeaseLiability(없으면 비유동 + 유동)
 * 차입 항목이 하나도 없으면 0 (빚이 없는 회사는 태그가 없다). 다만 차입 항목이 없는데 이자비용이 있으면 빚을 다른 태그로 적은 회사라
 * 모르는 것(null)으로 둔다 — 빚 0 으로 보면 '순현금'으로 맨 위에 오르게 된다. 재무상태표 자체가 없으면 부르는 쪽이 null 로 둔다
 */
export function totalDebt(b: Partial<Record<InstantKey, number>>, interest?: number): number | null {
  const debtTags = [b.ltd, b.ltdNoncurrent, b.ltdCurrent, b.debtCurrent, b.stBorrowings, b.commercialPaper].some((v) => v !== undefined);
  if (!debtTags && typeof interest === "number" && interest > 0) return null;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  let base: number;
  let shortIncluded = false;
  if (b.ltd !== undefined) base = b.ltd;
  else if (b.ltdCurrent !== undefined) base = n(b.ltdNoncurrent) + b.ltdCurrent;
  else if (b.debtCurrent !== undefined) {
    base = n(b.ltdNoncurrent) + b.debtCurrent;
    shortIncluded = true;
  } else base = n(b.ltdNoncurrent);
  const short = shortIncluded ? 0 : b.stBorrowings !== undefined && b.commercialPaper !== undefined ? Math.max(n(b.stBorrowings), n(b.commercialPaper)) : n(b.stBorrowings) + n(b.commercialPaper);
  const op = b.opLease !== undefined ? b.opLease : n(b.opLeaseNoncurrent) + n(b.opLeaseCurrent);
  const fin = b.finLease !== undefined ? b.finLease : n(b.finLeaseNoncurrent) + n(b.finLeaseCurrent);
  return Math.max(0, base) + Math.max(0, short) + Math.max(0, op) + Math.max(0, fin);
}

/** 현금·단기금융상품 */
export function cashAndInvestments(b: Partial<Record<InstantKey, number>>): number {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
  return n(b.cash) + n(b.stInvest);
}
