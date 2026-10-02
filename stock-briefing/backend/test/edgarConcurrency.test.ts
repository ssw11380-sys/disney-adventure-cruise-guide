import { describe, expect, it } from "vitest";
import { EdgarProvider } from "../src/providers/dart/edgar.js";
import { DataCollector } from "../src/services/collector.js";
import { FakeNewsProvider, FakeQuoteProvider } from "./helpers.js";

const NOW = new Date("2026-10-02T00:00:00Z").getTime();
const stock = { code: "AAPL", name: "Apple", market: "NASDAQ" };
const tickers = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple" },
  "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft" },
};
const submissions = {
  name: "Apple", fiscalYearEnd: "0930", sic: "3571", sicDescription: "Electronic Computers",
  filings: { recent: { filingDate: ["2026-09-20"], form: ["10-K"], accessionNumber: ["0000320193-26-000001"], primaryDocument: ["annual.htm"] } },
};
const years = [2021, 2022, 2023, 2024, 2025];
const duration = (year: number, val: number) => ({ fy: year, fp: "FY", form: "10-K", start: `${year}-01-01`, end: `${year}-12-31`, val });
const instant = (year: number, val: number) => ({ fy: year, fp: "FY", form: "10-K", end: `${year}-12-31`, val });
const facts = { facts: { "us-gaap": {
  Revenues: { units: { USD: years.map((y) => duration(y, y * 100)) } },
  NetIncomeLoss: { units: { USD: years.map((y) => duration(y, y * 10)) } },
  Assets: { units: { USD: years.map((y) => instant(y, y * 200)) } },
  StockholdersEquity: { units: { USD: years.map((y) => instant(y, y * 120)) } },
} } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
type Resource = "tickers" | "submissions" | "facts";
const resource = (url: string): Resource => url.includes("company_tickers") ? "tickers" : url.includes("submissions") ? "submissions" : "facts";

function fixture() {
  const calls: string[] = [];
  let failing: Resource | null = null;
  let now = NOW;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    // 헤더가 돌아오기 전에 다른 수집기가 같은 리소스를 요청할 수 있게 한다.
    await Promise.resolve();
    const kind = resource(url);
    if (kind === failing) return new Response("offline failure", { status: 503 });
    return json(kind === "tickers" ? tickers : kind === "submissions" ? submissions : facts);
  }) as typeof fetch;
  const provider = new EdgarProvider(fetchFn, () => new Date(now));
  const counts = () => Object.fromEntries(["tickers", "submissions", "facts"].map((r) => [r, calls.filter((url) => resource(url) === r).length]));
  return { provider, calls, counts, fail: (value: Resource | null) => { failing = value; }, advance: (ms: number) => { now += ms; } };
}

function collector(provider: EdgarProvider) {
  return new DataCollector({ quotes: new FakeQuoteProvider("offline"), news: new FakeNewsProvider(),
    financials: null, financialsUs: provider, investorFlow: null, now: () => new Date(NOW) });
}

describe("SEC 동시 자료 요청 공유 — 실제 수집기, 가짜 SEC만 사용", () => {
  it("회사·가치 분석을 동시에 열어도 3종 자료를 각각 한 번 받아 순차 수집과 같은 자료를 만든다", async () => {
    const concurrent = fixture();
    const c = collector(concurrent.provider);
    const actual = await Promise.all([c.collectAnalysis(stock, "company"), c.collectAnalysis(stock, "value")]);
    const sequential = fixture();
    const s = collector(sequential.provider);
    const expected = [await s.collectAnalysis(stock, "company"), await s.collectAnalysis(stock, "value")];
    expect(actual).toEqual(expected);
    expect(actual.map((v) => v.financials?.length)).toEqual([5, 5]);
    expect(concurrent.counts()).toEqual({ tickers: 1, submissions: 1, facts: 1 });
  });

  it("같은 재무 원본을 공유하되 요청한 연도 수를 각각 보존한다", async () => {
    const f = fixture();
    const [one, five] = await Promise.all([f.provider.getAnnualFinancials("AAPL", 1), f.provider.getAnnualFinancials("AAPL", 5)]);
    expect(one).toEqual(five.slice(-1));
    expect(five.map((r) => r.year)).toEqual(years);
    expect(f.counts()).toEqual({ tickers: 1, submissions: 0, facts: 1 });
  });

  it.each<Resource>(["tickers", "submissions", "facts"])("%s 실패를 공유한 뒤 다음 명시적 요청은 다시 받을 수 있다", async (kind) => {
    const f = fixture();
    if (kind !== "tickers") await f.provider.resolveCik("AAPL");
    f.fail(kind);
    const read = () => kind === "tickers" ? f.provider.resolveCik("AAPL")
      : kind === "submissions" ? f.provider.getCompany("AAPL") : f.provider.getAnnualFinancials("AAPL", 5);
    const results = await Promise.allSettled([read(), read()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const beforeRetry = f.calls.filter((url) => resource(url) === kind).length;
    f.fail(null);
    await expect(read()).resolves.toBeDefined();
    expect(f.calls.filter((url) => resource(url) === kind).length).toBe(beforeRetry + 1);
    expect(beforeRetry).toBe(1);
  });

  it("서로 다른 회사 자료는 합치지 않고 기존 캐시 유효기간도 유지한다", async () => {
    const f = fixture();
    await Promise.all([f.provider.getAnnualFinancials("AAPL", 5), f.provider.getAnnualFinancials("MSFT", 5)]);
    expect(f.calls.filter((url) => resource(url) === "facts").map((url) => /CIK(\d+)/.exec(url)?.[1]).sort()).toEqual(["0000320193", "0000789019"]);
    await f.provider.getAnnualFinancials("AAPL", 1);
    expect(f.counts().facts).toBe(2);
    f.advance(6 * 3_600_000 + 1);
    await Promise.all([f.provider.getAnnualFinancials("AAPL", 1), f.provider.getAnnualFinancials("AAPL", 5)]);
    expect(f.counts()).toEqual({ tickers: 1, submissions: 0, facts: 3 });
  });

  it("회사 개요 6시간·공시 1시간의 서로 다른 만료 기준을 바꾸지 않는다", async () => {
    const f = fixture();
    const initial = await f.provider.getCompany("AAPL");
    f.advance(3_600_000 + 1);
    expect(await f.provider.getCompany("AAPL")).toEqual(initial);
    expect(f.counts().submissions).toBe(1);
    const disclosures = await Promise.all([f.provider.getDisclosures("AAPL", 90, 10), f.provider.getDisclosures("AAPL", 90, 10)]);
    expect(disclosures[0]).toEqual(disclosures[1]);
    expect(disclosures[0]).toHaveLength(1);
    expect(f.counts().submissions).toBe(2);
  });
});
