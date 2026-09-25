import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { PromptStore } from "../src/llm/prompts.js";
import { EdgarProvider } from "../src/providers/dart/edgar.js";

/** 버그 점검 BH-03·11·24·32·42·45·73·77, BH-23(EDGAR 부분) 회귀 테스트. 네트워크 없이 가짜 SEC 응답만 쓴다 */

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

/** p 가 ms 안에 끝나면 그 값, 아니면 "pending" */
async function settle<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"pending">((r) => (timer = setTimeout(() => r("pending"), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const TICKERS = {
  "0": { cik_str: 1809279, ticker: "IONQ", title: "IonQ, Inc." },
  "1": { cik_str: 1818874, ticker: "SOFI", title: "SoFi Technologies, Inc." },
  "2": { cik_str: 1018724, ticker: "AMZN", title: "AMAZON COM INC" },
  "3": { cik_str: 1046179, ticker: "TSM", title: "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD" },
  "4": { cik_str: 1577552, ticker: "BABA", title: "Alibaba Group Holding Ltd" },
  "5": { cik_str: 1110803, ticker: "ILMN", title: "ILLUMINA, INC." },
  "6": { cik_str: 27419, ticker: "TGT", title: "TARGET CORP" },
  "7": { cik_str: 1045810, ticker: "NVDA", title: "NVIDIA CORP" },
  "8": { cik_str: 937966, ticker: "ASML", title: "ASML HOLDING NV" },
  "9": { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
  "10": { cik_str: 813672, ticker: "CDNS", title: "CADENCE DESIGN SYSTEMS INC" },
  "11": { cik_str: 1000001, ticker: "SIXK", title: "Six-K Only Ltd" },
  "12": { cik_str: 1000002, ticker: "NCI", title: "Holding With Minority Inc" },
  "13": { cik_str: 1703399, ticker: "SE", title: "Sea Ltd" },
  "14": { cik_str: 36270, ticker: "MTB", title: "M&T BANK CORP" },
  "15": { cik_str: 49196, ticker: "HBAN", title: "HUNTINGTON BANCSHARES INC /MD/" },
  "16": { cik_str: 831001, ticker: "C", title: "CITIGROUP INC" },
  "17": { cik_str: 109198, ticker: "TJX", title: "TJX COMPANIES INC /DE/" },
  "18": { cik_str: 1114448, ticker: "NVS", title: "NOVARTIS AG" },
  "19": { cik_str: 1535527, ticker: "CRWD", title: "CrowdStrike Holdings, Inc." },
};
const cikOf = (t: string) => String(Object.values(TICKERS).find((v) => v.ticker === t)!.cik_str).padStart(10, "0");

type Row = Record<string, unknown>;
/** 1년 기간 값 (손익) */
const dur = (start: string, end: string, val: number, extra: Row = {}): Row => ({ fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", start, end, val, ...extra });
/** 달력 연도 회사의 1년 값 */
const cy = (y: number, val: number, extra: Row = {}): Row => dur(`${y}-01-01`, `${y}-12-31`, val, extra);
/** 시점 값 (재무상태) */
const inst = (end: string, val: number, extra: Row = {}): Row => ({ fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", end, val, ...extra });
const cyi = (y: number, val: number, extra: Row = {}): Row => inst(`${y}-12-31`, val, extra);

/** companyfacts 모양: { 태그: 행[] } 를 한 통화 단위로 */
const facts = (tags: Record<string, Row[]>, opts: { unit?: string; tax?: string } = {}) => ({
  facts: { [opts.tax ?? "us-gaap"]: Object.fromEntries(Object.entries(tags).map(([k, rows]) => [k, { units: { [opts.unit ?? "USD"]: rows } }])) },
});

function edgarFetch(docs: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("company_tickers")) return ok(TICKERS);
    for (const [cik, body] of Object.entries(docs)) if (url.includes(cik)) return ok(body);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const NOW = () => new Date("2026-09-25T00:00:00Z");
const M = 1_000_000;

describe("EDGAR 재무: 태그는 회사마다 하나로 (BH-03)", () => {
  it("IONQ: 한 해만 있는 'Revenues' 값이 회사가 꾸준히 쓰는 매출 태그를 덮지 않는다", async () => {
    const IONQ = facts({
      Revenues: [cy(2022, 1_235_000_000)],
      RevenueFromContractWithCustomerExcludingAssessedTax: [cy(2021, 2_099_000), cy(2022, 11_131_000), cy(2023, 22_042_000), cy(2024, 43_073_000), cy(2025, 130_016_000)],
      NetIncomeLoss: [cy(2021, -106 * M), cy(2022, -48 * M), cy(2023, -157 * M), cy(2024, -331 * M), cy(2025, -400 * M)],
      Assets: [cyi(2021, 600 * M), cyi(2022, 590 * M), cyi(2023, 520 * M), cyi(2024, 480 * M), cyi(2025, 900 * M)],
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: IONQ }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("IONQ", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2021, 2_099_000],
      [2022, 11_131_000],
      [2023, 22_042_000],
      [2024, 43_073_000],
      [2025, 130_016_000],
    ]);
  });

  it("SOFI: 금융사 총순수익(RevenuesNetOfInterestExpense)을 수수료 매출보다 먼저, 세전이익은 영업이익에 넣지 않는다 (BH-77)", async () => {
    const years = [2021, 2022, 2023, 2024, 2025];
    const fee = [247.7, 377.1, 421.5, 503.1, 619.353];
    const total = [984.9, 1573.5, 2122.8, 2674.9, 3613.4];
    const SOFI = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y, i) => cy(y, fee[i]! * M)),
      RevenuesNetOfInterestExpense: years.map((y, i) => cy(y, total[i]! * M)),
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: years.map((y) => cy(y, (y === 2025 ? 525.857 : 100) * M)),
      NetIncomeLoss: years.map((y) => cy(y, 50 * M)),
      Assets: years.map((y) => cyi(y, 30_000 * M)),
      Liabilities: years.map((y) => cyi(y, 25_000 * M)),
      StockholdersEquity: years.map((y) => cyi(y, 5_000 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("SOFI")]: SOFI }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("SOFI", 5);
    expect(fin.map((r) => r.revenue)).toEqual(total.map((v) => v * M));
    expect(fin.map((r) => r.operatingIncome)).toEqual([null, null, null, null, null]);
    // 비운 이유를 AI 분석 입력에 남긴다
    expect(JSON.stringify(fin.at(-1))).toMatch(/영업이익/);
  });

  it("BRK: 영업이익 태그가 없는 해를 세전 손실로 채우지 않는다 (BH-77)", async () => {
    const BRK = facts({
      Revenues: [cy(2021, 276_094 * M), cy(2022, 302_089 * M)],
      OperatingIncomeLoss: [cy(2011, 10 * M)], // 옛날에만 쓴 태그
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest: [cy(2021, 111_686 * M), cy(2022, -30_576 * M)],
      NetIncomeLoss: [cy(2021, 89_795 * M), cy(2022, -22_819 * M)],
      Assets: [cyi(2021, 958_784 * M), cyi(2022, 948_452 * M)],
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("BRK-B")]: BRK }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("BRK.B", 5);
    expect(fin.map((r) => [r.year, r.operatingIncome])).toEqual([
      [2021, null],
      [2022, null],
    ]);
    expect(fin.every((r) => r.notes?.some((n) => n.startsWith("영업이익:")))).toBe(true);
  });

  it("SE: 부분 매출(RevenueFromContract…)이 더 많은 해를 덮어도 최근 해가 있는 합계 태그(Revenues)를 고르고, 섞지 않은 해는 사유와 함께 비운다", async () => {
    const f20 = { form: "20-F" };
    // RevenueFromContract… 는 2023년부터 부분 매출로 뜻이 바뀌었다 (2021·2022 는 합계와 같던 값)
    const rfc = [9_955, 12_450, 11_454, 14_734, 19_625];
    const total = [13_064, 16_820, 22_938];
    const SE = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [2021, 2022, 2023, 2024, 2025].map((y, i) => cy(y, rfc[i]! * M, f20)),
      Revenues: [2023, 2024, 2025].map((y, i) => cy(y, total[i]! * M, f20)),
      OperatingIncomeLoss: [2021, 2022, 2023, 2024, 2025].map((y) => cy(y, (y === 2025 ? 1_985.3 : 100) * M, f20)),
      NetIncomeLoss: [2021, 2022, 2023, 2024, 2025].map((y) => cy(y, 10 * M, f20)),
      Assets: [2021, 2022, 2023, 2024, 2025].map((y) => cyi(y, 20_000 * M, f20)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("SE")]: SE }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("SE", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2021, null],
      [2022, null],
      [2023, 13_064 * M],
      [2024, 16_820 * M],
      [2025, 22_938 * M],
    ]);
    // 2025 영업이익률이 부분 매출 기준 10.1% 가 아니라 합계 기준 8.7%
    expect(Math.round((fin[4]!.operatingIncome! / fin[4]!.revenue!) * 1000) / 10).toBe(8.7);
    expect(fin[0]!.notes).toContain("매출: 매출 합계 항목에서 이 해 값을 찾지 못해 비워 둠 (기준이 다른 값으로 채우지 않음)");
    expect(fin[2]!.notes?.some((n) => n.startsWith("매출:"))).toBe(false);
  });

  it("최근 해에 한 번만 섞여 든 합계 태그 값이 회사가 꾸준히 쓰는 매출 태그를 밀어내지 않는다", async () => {
    const STRAY = facts({
      Revenues: [cy(2025, 99_000 * M)],
      RevenueFromContractWithCustomerExcludingAssessedTax: [2021, 2022, 2023, 2024, 2025].map((y, i) => cy(y, (100 + i * 10) * M)),
      NetIncomeLoss: [2021, 2022, 2023, 2024, 2025].map((y) => cy(y, 5 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: STRAY }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("IONQ", 5);
    expect(fin.map((r) => r.revenue)).toEqual([100 * M, 110 * M, 120 * M, 130 * M, 140 * M]);
  });

  it("은행(MTB·HBAN): 수수료 매출(RevenueFromContract…)은 매출로 쓰지 않고, 합계 태그가 없는 해는 순이자이익 + 비이자이익으로 계산한다", async () => {
    const years = [2021, 2022, 2023, 2024, 2025];
    const nii = [3_825, 5_822, 7_115, 6_852, 6_948];
    const nonII = [2_167, 2_357, 2_528, 2_427, 2_742];
    const MTB = facts({
      Revenues: [2021, 2022, 2023].map((y, i) => cy(y, (nii[i]! + nonII[i]!) * M)), // 2024년부터 합계 태그를 안 씀
      RevenueFromContractWithCustomerExcludingAssessedTax: [2022, 2023, 2024, 2025].map((y, i) => cy(y, [1_525, 1_484, 1_541, 1_657][i]! * M)),
      InterestIncomeExpenseNet: years.map((y, i) => cy(y, nii[i]! * M)),
      NoninterestIncome: years.map((y, i) => cy(y, nonII[i]! * M)),
      InterestAndDividendIncomeOperating: years.map((y) => cy(y, 10_000 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 2_600 * M)),
      Assets: years.map((y) => cyi(y, 208_000 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("MTB")]: MTB }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("MTB", 5);
    expect(fin.map((r) => r.revenue)).toEqual([5_992, 8_179, 9_643, 9_279, 9_690].map((v) => v * M));
    expect(fin.at(-1)!.notes).toContain("매출: 은행·금융사라 순이자이익 + 비이자이익(순영업수익)으로 계산");

    // HBAN: 합계 태그 없이 수수료 매출(순이익보다 작음)만 있는 은행
    const HBAN = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y) => cy(y, 1_562 * M)),
      InterestIncomeExpenseNet: years.map((y) => cy(y, 5_991 * M)),
      NoninterestIncome: years.map((y) => cy(y, 2_175 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 2_211 * M)),
      Assets: years.map((y) => cyi(y, 225_106 * M)),
    });
    const e2 = new EdgarProvider(edgarFetch({ [cikOf("HBAN")]: HBAN }).fetchFn, NOW);
    expect((await e2.getAnnualFinancials("HBAN", 5)).map((r) => r.revenue)).toEqual(years.map(() => 8_166 * M));

    // 순이자이익이 없어 순영업수익을 계산할 수 없어도(비이자이익 + 이자수익만) 수수료 매출을 쓰지 않고 비운다
    const FEE = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y) => cy(y, 1_562 * M)),
      InterestAndDividendIncomeOperating: years.map((y) => cy(y, 10_310 * M)),
      NoninterestIncome: years.map((y) => cy(y, 2_175 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 2_211 * M)),
    });
    const e3 = new EdgarProvider(edgarFetch({ [cikOf("HBAN")]: FEE }).fetchFn, NOW);
    const fee = await e3.getAnnualFinancials("HBAN", 5);
    expect(fee.map((r) => r.revenue)).toEqual([null, null, null, null, null]);
    expect(fee.at(-1)!.notes?.some((n) => n.startsWith("매출: 은행·금융사라"))).toBe(true);
  });

  it("같은 기간 값은 나중 보고서를 따르되, 나중 값이 반올림만 한 값이면 자세한 값을 둔다 (Citi 2021 자산)", async () => {
    const C = facts({
      Revenues: [cy(2021, 71_884 * M, { filed: "2022-02-28" }), cy(2022, 75_338 * M, { filed: "2023-02-27" })],
      Assets: [
        cyi(2021, 2_291_413 * M, { filed: "2022-02-28" }),
        cyi(2021, 2_291_000 * M, { filed: "2024-02-23" }), // 나중 보고서의 비교 연도: 10억 단위로 반올림
        cyi(2022, 2_416_676 * M, { filed: "2023-02-27" }),
        cyi(2022, 2_417_500 * M, { filed: "2024-02-23" }), // 반올림이 아닌 재작성 → 나중 값
      ],
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("C")]: C }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("C", 5);
    expect(fin.map((r) => r.totalAssets)).toEqual([2_291_413 * M, 2_417_500 * M]);
  });

  it("태그 이름만 바꾼 회사는 겹치는 해 값이 같을 때만 옛 태그로 앞 연도를 채운다", async () => {
    const SWITCH = facts({
      SalesRevenueNet: [cy(2019, 80 * M), cy(2020, 90 * M), cy(2021, 100 * M), cy(2022, 110 * M)],
      Revenues: [cy(2021, 100 * M), cy(2022, 110 * M), cy(2023, 120 * M), cy(2024, 130 * M), cy(2025, 140 * M)],
      NetIncomeLoss: [2021, 2022, 2023, 2024, 2025].map((y) => cy(y, 10 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: SWITCH }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("IONQ", 10);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2019, 80 * M],
      [2020, 90 * M],
      [2021, 100 * M],
      [2022, 110 * M],
      [2023, 120 * M],
      [2024, 130 * M],
      [2025, 140 * M],
    ]);
  });
});

describe("EDGAR 재무: 은행 판별·이상한 원자료 (BH-03 검증 지적)", () => {
  const years = [2021, 2022, 2023, 2024, 2025];
  const bankNote = (rows: Array<{ notes?: string[] }>) => rows.some((r) => r.notes?.some((n) => n.includes("은행")));

  it("ORLY: 일반 회사가 예금 이자 7M 을 이자수익 태그로 한 번 적어도 은행으로 보지 않고 매출을 그대로 쓴다", async () => {
    const sales = [13_328, 14_410, 15_812, 16_708, 17_782];
    const ORLY = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y, i) => cy(y, sales[i]! * M)),
      InterestAndDividendIncomeOperating: [cy(2024, 7 * M)],
      OperatingIncomeLoss: years.map((y) => cy(y, 3_000 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 2_200 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: ORLY }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("IONQ", 5);
    expect(fin.map((r) => r.revenue)).toEqual(sales.map((v) => v * M));
    expect(fin.map((r) => r.operatingIncome)).toEqual(years.map(() => 3_000 * M));
    expect(bankNote(fin)).toBe(false);
  });

  it("DGX·CELH: 순이자 비용·이자수익이 해마다 있어도 비이자이익이 없고 수수료 매출보다 작으면 은행이 아니다", async () => {
    const DGX = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y) => cy(y, 9_872 * M)),
      InterestAndDividendIncomeOperating: years.map((y) => cy(y, 25 * M)),
      InterestIncomeExpenseNet: years.map((y) => cy(y, -201 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 871 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: DGX }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("IONQ", 5);
    expect(fin.map((r) => r.revenue)).toEqual(years.map(() => 9_872 * M));
    expect(bankNote(fin)).toBe(false);

    // 은행처럼 보이는 해(비이자이익 + 이자수익, 수수료 매출 없음)가 한 해뿐이고 수수료 매출이 더 큰 해가 더 많으면 은행이 아니다
    const MIXED = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: [2022, 2023, 2024, 2025].map((y) => cy(y, 1_356 * M)),
      InterestAndDividendIncomeOperating: years.map((y) => cy(y, 3 * M)),
      NoninterestIncome: [cy(2021, 5 * M), cy(2024, 5 * M)],
      NetIncomeLoss: years.map((y) => cy(y, 145 * M)),
    });
    const e2 = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: MIXED }).fetchFn, NOW);
    const mixed = await e2.getAnnualFinancials("IONQ", 5);
    expect(mixed.map((r) => r.revenue)).toEqual([null, 1_356 * M, 1_356 * M, 1_356 * M, 1_356 * M]);
    expect(bankNote(mixed)).toBe(false);
  });

  it("비이자이익 태그가 없는 작은 은행(FVCB)은 수수료 매출이 순이익보다 작아서 은행으로 보고, 이자수익이 매출보다 큰 적자 바이오 회사는 은행이 아니다", async () => {
    const FVCB = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y) => cy(y, 2 * M)),
      InterestAndDividendIncomeOperating: years.map((y) => cy(y, 113 * M)),
      InterestIncomeExpenseNet: years.map((y) => cy(y, 56 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 15 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("HBAN")]: FVCB }).fetchFn, NOW);
    const bank = await e.getAnnualFinancials("HBAN", 5);
    expect(bank.map((r) => r.revenue)).toEqual([null, null, null, null, null]);
    expect(bankNote(bank)).toBe(true);

    const BIO = facts({
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y) => cy(y, 5 * M)),
      InterestIncomeExpenseNet: years.map((y) => cy(y, 20 * M)),
      NetIncomeLoss: years.map((y) => cy(y, -120 * M)),
    });
    const e2 = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: BIO }).fetchFn, NOW);
    const bio = await e2.getAnnualFinancials("IONQ", 5);
    expect(bio.map((r) => r.revenue)).toEqual(years.map(() => 5 * M));
    expect(bankNote(bio)).toBe(false);
  });

  it("FLS: 'Revenues' 를 해마다 0 으로 적은 회사는 같은 해 양수인 매출 항목을 쓴다 (매출이 정말 0 인 회사는 0 그대로)", async () => {
    const sales = [3_541, 3_615, 4_321, 4_558, 4_729];
    const FLS = facts({
      Revenues: years.map((y) => cy(y, 0)),
      RevenueFromContractWithCustomerExcludingAssessedTax: years.map((y, i) => cy(y, sales[i]! * M)),
      OperatingIncomeLoss: years.map((y) => cy(y, 400 * M)),
      NetIncomeLoss: years.map((y) => cy(y, 300 * M)),
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: FLS }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("IONQ", 5);
    expect(fin.map((r) => r.revenue)).toEqual(sales.map((v) => v * M));

    const PRE = facts({ Revenues: years.map((y) => cy(y, 0)), NetIncomeLoss: years.map((y) => cy(y, -50 * M)) });
    const e2 = new EdgarProvider(edgarFetch({ [cikOf("IONQ")]: PRE }).fetchFn, NOW);
    expect((await e2.getAnnualFinancials("IONQ", 5)).map((r) => r.revenue)).toEqual([0, 0, 0, 0, 0]);
  });

  it("LYG: 음수 매출은 비우고 사유를 남긴다, ING: 매출과 똑같은 영업이익은 비워 영업이익률 100% 를 만들지 않는다", async () => {
    const f20 = { form: "20-F" };
    const LYG = facts(
      {
        Revenue: [cy(2021, 38_950 * M, f20), cy(2022, -5_346 * M, f20), cy(2023, 18_629 * M, f20)],
        ProfitLossAttributableToOwnersOfParent: [cy(2021, 5_784 * M, f20), cy(2022, 3_827 * M, f20), cy(2023, 5_460 * M, f20)],
      },
      { tax: "ifrs-full", unit: "GBP" },
    );
    const e = new EdgarProvider(edgarFetch({ [cikOf("NVS")]: LYG }).fetchFn, NOW);
    const lyg = await e.getAnnualFinancials("NVS", 5);
    expect(lyg.map((r) => r.revenue)).toEqual([38_950 * M, null, 18_629 * M]);
    expect(lyg[1]!.notes?.some((n) => n.startsWith("매출:") && n.includes("음수"))).toBe(true);

    const total = [20_093, 30_418, 18_121];
    const ING = facts(
      {
        Revenue: [2023, 2024, 2025].map((y, i) => cy(y, total[i]! * M, f20)),
        ProfitLossFromOperatingActivities: [2023, 2024, 2025].map((y, i) => cy(y, (y === 2025 ? 7_000 : total[i]!) * M, f20)),
        ProfitLossAttributableToOwnersOfParent: [2023, 2024, 2025].map((y) => cy(y, 5_000 * M, f20)),
      },
      { tax: "ifrs-full", unit: "EUR" },
    );
    const e2 = new EdgarProvider(edgarFetch({ [cikOf("NVS")]: ING }).fetchFn, NOW);
    const ing = await e2.getAnnualFinancials("NVS", 5);
    expect(ing.map((r) => r.operatingIncome)).toEqual([null, null, 7_000 * M]);
    expect(ing[0]!.notes).toContain("영업이익: 회사가 매출과 같은 값으로 보고해 영업이익으로 보지 않고 비워 둠");
  });
});

describe("EDGAR 부채총계 (BH-11)", () => {
  it("AMZN: 부채총계 태그가 없으면 유동부채가 아니라 자산총계 − 자본총계로 계산한다", async () => {
    const AMZN = facts({
      Revenues: [cy(2024, 637_959 * M)],
      NetIncomeLoss: [cy(2024, 59_248 * M)],
      Assets: [cyi(2024, 624_894 * M)],
      LiabilitiesCurrent: [cyi(2024, 179_431 * M)],
      StockholdersEquity: [cyi(2024, 285_970 * M)],
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("AMZN")]: AMZN }).fetchFn, NOW);
    const [r] = await e.getAnnualFinancials("AMZN", 5);
    expect(r!.totalLiabilities).toBe(338_924 * M);
    expect(JSON.stringify(r)).toMatch(/부채총계/);
  });

  it("비지배지분이 있으면 자본총계(비지배지분 포함)를 빼고, 계산할 수 없으면 비워 둔다", async () => {
    const HOLD = facts({
      Revenues: [cy(2024, 100 * M), cy(2025, 120 * M)],
      Assets: [cyi(2024, 1_000 * M), cyi(2025, 1_100 * M)],
      LiabilitiesCurrent: [cyi(2024, 200 * M), cyi(2025, 210 * M)],
      StockholdersEquity: [cyi(2025, 500 * M)],
      StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: [cyi(2025, 560 * M)],
    });
    const e = new EdgarProvider(edgarFetch({ [cikOf("NCI")]: HOLD }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("NCI", 5);
    expect(fin.map((r) => [r.year, r.totalLiabilities, r.totalEquity])).toEqual([
      [2024, null, null],
      [2025, 540 * M, 500 * M],
    ]);
  });
});

describe("EDGAR 외국 기업 20-F·40-F·6-K (BH-24)", () => {
  it("us-gaap 20-F 제출사(BABA): 현지 통화(CNY) 값을 읽고 통화를 표시한다", async () => {
    const f20 = { form: "20-F" };
    const BABA = {
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              CNY: [dur("2022-04-01", "2023-03-31", 868_687 * M, f20), dur("2023-04-01", "2024-03-31", 941_168 * M, f20), dur("2024-04-01", "2025-03-31", 996_347 * M, f20)],
              USD: [dur("2024-04-01", "2025-03-31", 137_300 * M, f20)], // 최근 해만 달러 환산
            },
          },
          OperatingIncomeLoss: { units: { CNY: [dur("2024-04-01", "2025-03-31", 140_905 * M, f20)] } },
          NetIncomeLoss: { units: { CNY: [dur("2024-04-01", "2025-03-31", 129_470 * M, f20)] } },
          Assets: { units: { CNY: [inst("2025-03-31", 1_804_227 * M, f20)] } },
        },
      },
    };
    const e = new EdgarProvider(edgarFetch({ [cikOf("BABA")]: BABA }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("BABA", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2023, 868_687 * M],
      [2024, 941_168 * M],
      [2025, 996_347 * M],
    ]);
    expect(fin.at(-1)).toMatchObject({ operatingIncome: 140_905 * M, netIncome: 129_470 * M, currency: "CNY" });
    expect(JSON.stringify(fin.at(-1))).toMatch(/CNY/);
  });

  it("보고 통화를 바꾼 회사(DEO: GBP → USD)는 옛 통화 값이 더 많아도 가장 최근 해가 있는 지금 통화를 고른다", async () => {
    const f20 = { form: "20-F" };
    const fy = (y: number, val: number) => dur(`${y - 1}-07-01`, `${y}-06-30`, val, f20);
    const fyi = (y: number, val: number) => inst(`${y}-06-30`, val, f20);
    const gbpYears = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
    const usd = { 2022: 29_751, 2023: 28_270, 2024: 27_891, 2025: 27_964 } as Record<number, number>;
    const usdYears = [2022, 2023, 2024, 2025];
    const DEO = {
      facts: {
        "ifrs-full": {
          Revenue: {
            units: {
              GBP: gbpYears.map((y) => fy(y, (15_000 + (y - 2016) * 1_000) * M)),
              USD: usdYears.map((y) => fy(y, usd[y]! * M)),
            },
          },
          ProfitLossAttributableToOwnersOfParent: {
            units: { GBP: gbpYears.map((y) => fy(y, 3_000 * M)), USD: usdYears.map((y) => fy(y, 4_000 * M)) },
          },
          Assets: { units: { GBP: gbpYears.map((y) => fyi(y, 35_000 * M)), USD: usdYears.map((y) => fyi(y, 45_000 * M)) } },
        },
      },
    };
    const e = new EdgarProvider(edgarFetch({ [cikOf("NVS")]: DEO }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("NVS", 5);
    expect(fin.map((r) => [r.year, r.revenue, r.currency])).toEqual(usdYears.map((y) => [y, usd[y]! * M, "USD"]));
    // 바꾸기 전 연도(GBP)는 섞지 않고, 빠진 이유를 가장 오래된 해에 남긴다
    expect(fin[0]!.notes?.some((n) => n.includes("GBP"))).toBe(true);
    expect(fin.slice(1).every((r) => !r.notes?.some((n) => n.startsWith("금액 통화")))).toBe(true);
  });

  it("IFRS 20-F 제출사(TSM): ifrs-full 태그를 읽는다", async () => {
    const f20 = { form: "20-F" };
    const TSM = facts(
      {
        Revenue: [cy(2024, 2_894_308 * M, f20), cy(2025, 3_800_000 * M, f20)],
        ProfitLossFromOperatingActivities: [cy(2024, 1_322_053 * M, f20), cy(2025, 1_800_000 * M, f20)],
        ProfitLossAttributableToOwnersOfParent: [cy(2024, 1_173_268 * M, f20), cy(2025, 1_600_000 * M, f20)],
        Assets: [cyi(2024, 6_691_938 * M, f20), cyi(2025, 7_500_000 * M, f20)],
        Liabilities: [cyi(2024, 2_120_000 * M, f20), cyi(2025, 2_300_000 * M, f20)],
        EquityAttributableToOwnersOfParent: [cyi(2024, 4_550_000 * M, f20), cyi(2025, 5_180_000 * M, f20)],
      },
      { tax: "ifrs-full", unit: "TWD" },
    );
    const e = new EdgarProvider(edgarFetch({ [cikOf("TSM")]: TSM }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("TSM", 5);
    expect(fin).toHaveLength(2);
    expect(fin[1]).toMatchObject({
      year: 2025,
      revenue: 3_800_000 * M,
      operatingIncome: 1_800_000 * M,
      netIncome: 1_600_000 * M,
      totalAssets: 7_500_000 * M,
      totalLiabilities: 2_300_000 * M,
      totalEquity: 5_180_000 * M,
      currency: "TWD",
    });
  });

  it("IFRS 제품 매출만 보고하는 회사(NVS: RevenueFromSaleOfGoods)도 매출을 읽는다", async () => {
    const f20 = { form: "20-F" };
    const NVS = facts(
      {
        RevenueFromSaleOfGoods: [cy(2024, 50_317 * M, f20), cy(2025, 54_532 * M, f20)],
        RevenueFromRoyalties: [cy(2024, 37 * M, f20), cy(2025, 379 * M, f20)],
        ProfitLossAttributableToOwnersOfParent: [cy(2024, 11_941 * M, f20), cy(2025, 13_984 * M, f20)],
        Assets: [cyi(2024, 102_246 * M, f20), cyi(2025, 110_949 * M, f20)],
      },
      { tax: "ifrs-full" },
    );
    const e = new EdgarProvider(edgarFetch({ [cikOf("NVS")]: NVS }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("NVS", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2024, 50_317 * M],
      [2025, 54_532 * M],
    ]);
    expect(fin.every((r) => !r.notes?.some((n) => n.startsWith("매출:")))).toBe(true);
  });

  it("가치·회사 분석 프롬프트는 재무 금액을 주가 통화(quote.currency)가 아니라 financials 행의 currency 로 읽게 한다", async () => {
    const store = new PromptStore();
    for (const name of ["value_analysis", "company_overview"] as const) {
      const t = await store.load(name);
      expect(t.system, name).toMatch(/financials 행의 currency/);
      expect(t.system, name).toMatch(/환산하지 않/);
    }
  });

  it("연간 보고서 값이 하나도 없으면(6-K 만) 빈 성공이 아니라 실패로 알린다", async () => {
    const SIXK = facts({ Revenues: [cy(2025, 10 * M, { form: "6-K" })] });
    const e = new EdgarProvider(edgarFetch({ [cikOf("SIXK")]: SIXK }).fetchFn, NOW);
    await expect(e.getAnnualFinancials("SIXK", 5)).rejects.toThrow(/연간/);
  });

  it("공시 목록에 20-F·6-K 를 넣는다", async () => {
    const SUBS = {
      name: "ASML HOLDING NV",
      filings: {
        recent: {
          form: ["6-K", "6-K", "20-F"],
          filingDate: ["2026-09-20", "2026-08-01", "2026-07-10"],
          accessionNumber: ["0000937966-26-000030", "0000937966-26-000020", "0000937966-26-000010"],
          primaryDocument: ["q3.htm", "agm.htm", "asml-20f.htm"],
          primaryDocDescription: ["6-K", "6-K", "20-F"],
        },
      },
    };
    const e = new EdgarProvider(edgarFetch({ [cikOf("ASML")]: SUBS }).fetchFn, NOW);
    const d = await e.getDisclosures("ASML", 90, 10);
    expect(d.map((x) => x.title)).toEqual(["수시 공시 (6-K)", "수시 공시 (6-K)", "연간 보고서 (20-F)"]);
  });
});

describe("EDGAR 회계연도 이름 (BH-42)", () => {
  it("12/31 에 가까운 일요일에 끝나는 회사(ILMN): 1월 초에 끝난 해를 앞 해로 보고, 한 해도 빠뜨리지 않는다", async () => {
    const ends: Array<[string, string, number]> = [
      ["2019-12-30", "2021-01-03", 3_239 * M],
      ["2021-01-04", "2022-01-02", 4_526 * M],
      ["2022-01-03", "2023-01-01", 4_584 * M],
      ["2023-01-02", "2023-12-31", 4_504 * M],
      ["2024-01-01", "2024-12-29", 4_372 * M],
    ];
    const ILMN = facts({ Revenues: ends.map(([s, e, v]) => dur(s, e, v)), NetIncomeLoss: ends.map(([s, e]) => dur(s, e, 1 * M)) });
    const e = new EdgarProvider(edgarFetch({ [cikOf("ILMN")]: ILMN }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("ILMN", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2020, 3_239 * M],
      [2021, 4_526 * M],
      [2022, 4_584 * M],
      [2023, 4_504 * M],
      [2024, 4_372 * M],
    ]);
  });

  it("토요일 규칙(CDNS): 2026-01-03 에 끝난 해는 2025 회계연도", async () => {
    const CDNS = facts({ Revenues: [dur("2023-12-31", "2024-12-28", 4_641 * M), dur("2024-12-29", "2026-01-03", 5_200 * M)] });
    const e = new EdgarProvider(edgarFetch({ [cikOf("CDNS")]: CDNS }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("CDNS", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2024, 4_641 * M],
      [2025, 5_200 * M],
    ]);
  });

  it("보고서의 fy 로 회사가 쓰는 연도 이름을 따른다 (TGT: 2026-01-31 에 끝난 해가 2025 회계연도)", async () => {
    // 10-K 마다 3개 연도(당해+비교 2년), fy 는 그 보고서의 회계연도
    const periods: Array<[number, string, string, number]> = [
      [2019, "2019-02-03", "2020-02-01", 78_112],
      [2020, "2020-02-02", "2021-01-30", 93_561],
      [2021, "2021-01-31", "2022-01-29", 106_005],
      [2022, "2022-01-30", "2023-01-28", 109_120],
      [2023, "2023-01-29", "2024-02-03", 107_412],
      [2024, "2024-02-04", "2025-02-01", 106_566],
      [2025, "2025-02-02", "2026-01-31", 104_800],
    ];
    const rows: Row[] = [];
    for (const [fy] of periods.slice(2)) {
      for (const [pfy, s, e, v] of periods) if (pfy <= fy && pfy >= fy - 2) rows.push(dur(s, e, v * M, { fy, accn: `0000027419-${fy}` }));
    }
    const TGT = facts({ Revenues: rows });
    const e = new EdgarProvider(edgarFetch({ [cikOf("TGT")]: TGT }).fetchFn, NOW);
    const fin = await e.getAnnualFinancials("TGT", 5);
    expect(fin.map((r) => [r.year, r.revenue])).toEqual([
      [2021, 106_005 * M],
      [2022, 109_120 * M],
      [2023, 107_412 * M],
      [2024, 106_566 * M],
      [2025, 104_800 * M],
    ]);
  });
});

describe("EDGAR 회계연도 이름: 보고서 fy 가 섞여 있어도 최근 보고서 기준 (BH-42 검증 지적)", () => {
  /** 1월 말 결산 회사의 10-K 들: 보고서마다 3개 연도(당해+비교 2년), fy 는 diff(기간 끝 연도 기준 차이)로 */
  const JAN_ENDS = [
    "2010-01-30", "2011-01-29", "2012-01-28", "2013-02-02", "2014-02-01", "2015-01-31", "2016-01-30", "2017-01-28", "2018-02-03",
    "2019-02-02", "2020-02-01", "2021-01-30", "2022-01-29", "2023-01-28", "2024-02-03", "2025-02-01", "2026-01-31",
  ];
  const tenKs = (fyDiff: (end: string, i: number) => number) => {
    const rows: Row[] = [];
    JAN_ENDS.forEach((end, i) => {
      const fy = Number(end.slice(0, 4)) + fyDiff(end, i);
      for (let k = Math.max(0, i - 2); k <= i; k++) {
        const e = JAN_ENDS[k]!;
        const s = new Date(Date.parse(e) - 363 * 86_400_000).toISOString().slice(0, 10);
        rows.push(dur(s, e, (1_000 + k) * M, { fy, accn: `acc-${i}`, filed: `${end.slice(0, 4)}-03-30` }));
      }
    });
    return facts({ Revenues: rows });
  };
  const labels = async (ticker: string, body: unknown) =>
    (await new EdgarProvider(edgarFetch({ [cikOf(ticker)]: body }).fetchFn, NOW).getAnnualFinancials(ticker, 5)).map((r) => [r.year, r.revenue]);
  const endYears = [2022, 2023, 2024, 2025, 2026].map((y, j) => [y, (1_000 + 12 + j) * M]);

  it("TJX: 2021년 전 보고서 12건은 fy 가 1 작고 최근 5건은 기간 끝 연도 → 2026-01-31 에 끝난 해는 2026", async () => {
    expect(await labels("TJX", tenKs((end) => (end < "2022" ? -1 : 0)))).toEqual(endYears);
  });

  it("CRWD(세 해만 1 작음)·CRM(최근 한 해만 1 작음)처럼 fy 가 들쭉날쭉하면 기간 끝 연도를 따른다", async () => {
    const crwd = new Set(["2023-01-28", "2024-02-03", "2025-02-01"]);
    expect(await labels("CRWD", tenKs((end) => (crwd.has(end) ? -1 : 0)))).toEqual(endYears);
    expect(await labels("CRWD", tenKs((end) => (end === "2026-01-31" ? -1 : 0)))).toEqual(endYears);
  });

  it("최근 보고서와 최근 5건 과반이 1 작으면(TGT·KR) 회사 이름을 따른다", async () => {
    const kr = new Set(["2023-01-28", "2024-02-03"]); // 중간 두 해만 기간 끝 연도
    expect(await labels("TGT", tenKs((end) => (kr.has(end) ? 0 : -1)))).toEqual(endYears.map(([y, v]) => [y! - 1, v]));
  });
});

describe("EDGAR 공시 목록 (BH-32·BH-73)", () => {
  const subs = (rows: Array<[string, string]>) => ({
    name: "NVIDIA CORP",
    filings: {
      recent: {
        form: rows.map((r) => r[0]),
        filingDate: rows.map((r) => r[1]),
        accessionNumber: rows.map((_, i) => `0001045810-26-${String(900 - i).padStart(6, "0")}`),
        primaryDocument: rows.map((r, i) => (r[0] === "4" ? `xslF345X05/f4-${i}.xml` : `doc-${i}.htm`)),
        primaryDocDescription: rows.map((r) => (r[0] === "4" ? "FORM 4" : r[0])),
      },
    },
  });
  const day = (d: number) => new Date(Date.parse("2026-09-24T00:00:00Z") - d * 86_400_000).toISOString().slice(0, 10);

  it("Form 4 가 수십 건이어도 10-Q·8-K 가 밀려나지 않고, Form 4 는 한도 안에서만", async () => {
    const rows: Array<[string, string]> = [];
    for (let i = 0; i < 20; i++) rows.push(["4", day(i)]); // 09-24 ~ 09-05
    rows.push(["8-K", day(21)]); // 09-03
    for (let i = 22; i < 28; i++) rows.push(["4", day(i)]);
    rows.push(["10-Q", day(29)], ["8-K", day(29)]); // 08-26
    for (let i = 30; i < 60; i++) rows.push(["4", day(i)]);
    rows.push(["8-K", day(80)]);
    const e = new EdgarProvider(edgarFetch({ [cikOf("NVDA")]: subs(rows) }).fetchFn, NOW);
    const d = await e.getDisclosures("NVDA", 90, 10);
    const titles = d.map((x) => x.title);
    expect(titles.filter((t) => t.includes("10-Q"))).toHaveLength(1);
    expect(titles.filter((t) => t.includes("8-K"))).toHaveLength(3);
    const form4 = titles.filter((t) => t.includes("Form 4")).length;
    expect(form4).toBeGreaterThan(0);
    expect(form4).toBeLessThanOrEqual(4);
    expect(d.length).toBeLessThanOrEqual(10);
    // 최신순 유지
    expect(d.map((x) => x.filedAt)).toEqual([...d.map((x) => x.filedAt)].sort().reverse());
    // 공시 탭(30일·15건)에서도 8-K 가 빠지지 않는다
    const tab = await e.getDisclosures("NVDA", 30, 15);
    expect(tab.map((x) => x.title)).toContain("수시 공시 (8-K)");
  });

  it("2024년 12월 이후 이름 'SCHEDULE 13G/13D'(정정 포함)도 5% 이상 보유 보고로 넣는다", async () => {
    const rows: Array<[string, string]> = [
      ["SCHEDULE 13G", "2026-07-20"],
      ["SCHEDULE 13G/A", "2026-07-10"],
      ["SCHEDULE 13D", "2026-07-01"],
      ["SCHEDULE 13D/A", "2026-06-30"],
      ["SC 13G", "2024-11-12"],
    ];
    const e = new EdgarProvider(edgarFetch({ [cikOf("NVDA")]: subs(rows) }).fetchFn, NOW);
    const d = await e.getDisclosures("NVDA", 90, 10);
    expect(d.map((x) => x.title)).toEqual(["5% 이상 보유 보고 (13G)", "5% 이상 보유 보고 정정 (13G/A)", "5% 이상 보유 보고 (13D)", "5% 이상 보유 보고 정정 (13D/A)"]);
    const old = await e.getDisclosures("NVDA", 700, 10);
    expect(old.map((x) => x.title).at(-1)).toBe("5% 이상 보유 보고 (13G)");
  });
});

describe("EDGAR 응답 캐시 (BH-45)", () => {
  const many = 300;
  const tickers = Object.fromEntries(Array.from({ length: many }, (_, i) => [String(i), { cik_str: 5_000_000 + i, ticker: `T${i}`, title: `T${i}` }]));
  const small = facts({ Revenues: [cy(2025, 1 * M)] });
  function counting() {
    const facts = new Map<string, number>();
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("company_tickers")) return ok(tickers);
      const cik = /CIK(\d+)/.exec(url)?.[1] ?? "";
      facts.set(cik, (facts.get(cik) ?? 0) + 1);
      return ok(url.includes("submissions") ? { name: "x", filings: { recent: { form: [], filingDate: [] } } } : small);
    }) as typeof fetch;
    return { fetchFn, facts };
  }

  it("종목 수만큼 끝없이 쌓지 않는다: 많은 종목을 본 뒤 처음 종목은 다시 받는다", async () => {
    const { fetchFn, facts: calls } = counting();
    const e = new EdgarProvider(fetchFn, NOW);
    for (let i = 0; i < many; i++) await e.getAnnualFinancials(`T${i}`, 5);
    await e.getAnnualFinancials("T0", 5);
    expect(calls.get("0005000000")).toBe(2);
    // 가장 최근 종목은 캐시에서
    await e.getAnnualFinancials(`T${many - 1}`, 5);
    expect(calls.get(String(5_000_000 + many - 1).padStart(10, "0"))).toBe(1);
    expect(e.cachedEntries).toBeLessThanOrEqual(many / 2);
  });

  it("만료된 항목은 다시 읽지 않아도 새 항목을 넣을 때 지운다", async () => {
    const { fetchFn } = counting();
    let now = new Date("2026-09-25T00:00:00Z");
    const e = new EdgarProvider(fetchFn, () => now);
    for (let i = 0; i < 5; i++) {
      await e.getAnnualFinancials(`T${i}`, 5);
      await e.getDisclosures(`T${i}`, 30, 5);
    }
    expect(e.cachedEntries).toBe(10);
    now = new Date(now.getTime() + 7 * 86_400_000);
    await e.getAnnualFinancials("T9", 5);
    expect(e.cachedEntries).toBe(1);
  });
});

describe("EDGAR 요청 제한 시간 (BH-23)", () => {
  const tickersOnly = (url: string) => (url.includes("company_tickers") ? ok(TICKERS) : null);

  it("기본으로 모든 요청에 제한 시간 signal 을 준다", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return tickersOnly(String(input)) ?? ok(facts({ Revenues: [cy(2025, 1 * M)] }));
    }) as typeof fetch;
    const e = new EdgarProvider(fetchFn, NOW);
    await e.getAnnualFinancials("IONQ", 5);
    expect(signals).toHaveLength(2);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("헤더만 오고 본문이 멈춰도(실제 HTTP) 제한 시간에 연결을 끊고 실패로 끝낸다", async () => {
    let closed = false;
    const server = http.createServer((req, res) => {
      req.socket.on("close", () => (closed = true));
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"facts":'); // 본문 일부만 보내고 멈춘다
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
        tickersOnly(String(input)) ? Promise.resolve(tickersOnly(String(input))!) : fetch(`http://127.0.0.1:${port}/`, init)) as typeof fetch;
      const e = new EdgarProvider(fetchFn, NOW, { timeoutMs: 200 });
      const r = await settle(e.getAnnualFinancials("IONQ", 5).then(() => "ok", (err: Error) => err.message), 3_000);
      expect(r).toMatch(/시간 초과/);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("주입한 fetch 가 signal 을 따르지 않아도(응답 없음·본문 멈춤) 제한 시간에 끝낸다", async () => {
    const hang = (async (input: string | URL | Request) => tickersOnly(String(input)) ?? new Promise<Response>(() => {})) as typeof fetch;
    const e1 = new EdgarProvider(hang, NOW, { timeoutMs: 100 });
    expect(await settle(e1.getDisclosures("IONQ", 30, 5).then(() => "ok", (err: Error) => err.message), 2_000)).toMatch(/시간 초과/);
    const stalled = (async (input: string | URL | Request) => tickersOnly(String(input)) ?? new Response(new ReadableStream({ start() {} }), { status: 200 })) as typeof fetch;
    const e2 = new EdgarProvider(stalled, NOW, { timeoutMs: 100 });
    expect(await settle(e2.getCompany("IONQ").then(() => "ok", (err: Error) => err.message), 2_000)).toMatch(/시간 초과/);
  });
});
