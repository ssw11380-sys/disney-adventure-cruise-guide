import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
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
