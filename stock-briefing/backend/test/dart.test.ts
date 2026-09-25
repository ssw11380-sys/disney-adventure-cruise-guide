import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { DartProvider, parseCorpCodeXml, parseDividends, parseSingleAccount } from "../src/providers/dart/dart.js";

describe("DART parsers", () => {
  it("corpCode.xml 에서 상장사(6자리 종목코드)만 골라낸다", () => {
    const xml = `<?xml version="1.0"?><result>
<list><corp_code>00164779</corp_code><corp_name>SK하이닉스</corp_name><stock_code>000660</stock_code><modify_date>20260101</modify_date></list>
<list><corp_code>00999999</corp_code><corp_name>비상장</corp_name><stock_code> </stock_code><modify_date>20260101</modify_date></list>
</result>`;
    expect(parseCorpCodeXml(xml)).toEqual([{ stock_code: "000660", corp_code: "00164779", corp_name: "SK하이닉스" }]);
  });

  it("주요계정은 연결(CFS) 우선, 당기/전기/전전기 3개년으로 펼친다", () => {
    const list = [
      { fs_div: "OFS", sj_div: "IS", account_nm: "매출액", thstrm_amount: "1", frmtrm_amount: "1", bfefrmtrm_amount: "1" },
      { fs_div: "CFS", sj_div: "IS", account_nm: "매출액", thstrm_amount: "66,193,000,000,000", frmtrm_amount: "32,766,000,000,000", bfefrmtrm_amount: "44,622,000,000,000" },
      { fs_div: "CFS", sj_div: "IS", account_nm: "영업이익", thstrm_amount: "23,467,000,000,000", frmtrm_amount: "-7,730,000,000,000", bfefrmtrm_amount: "6,809,000,000,000" },
      { fs_div: "CFS", sj_div: "IS", account_nm: "당기순이익", thstrm_amount: "19,797,000,000,000", frmtrm_amount: "-9,138,000,000,000", bfefrmtrm_amount: "2,244,000,000,000" },
      { fs_div: "CFS", sj_div: "BS", account_nm: "자산총계", thstrm_amount: "100", frmtrm_amount: "90", bfefrmtrm_amount: "80" },
      { fs_div: "CFS", sj_div: "BS", account_nm: "부채총계", thstrm_amount: "40", frmtrm_amount: "45", bfefrmtrm_amount: "35" },
      { fs_div: "CFS", sj_div: "BS", account_nm: "자본총계", thstrm_amount: "60", frmtrm_amount: "45", bfefrmtrm_amount: "45" },
    ];
    const out = parseSingleAccount(list, 2025);
    expect(out.map((f) => f.year)).toEqual([2023, 2024, 2025]);
    expect(out[2]).toMatchObject({ basis: "CFS", revenue: 66_193_000_000_000, operatingIncome: 23_467_000_000_000, totalEquity: 60 });
    expect(out[1]!.operatingIncome).toBe(-7_730_000_000_000);
    expect(out[0]!.totalLiabilities).toBe(35);
  });

  it("연결이 없으면 개별(OFS)을 쓰고, 빈 목록이면 빈 배열", () => {
    const out = parseSingleAccount([{ fs_div: "OFS", account_nm: "매출액", thstrm_amount: "10", frmtrm_amount: "", bfefrmtrm_amount: "" }], 2025);
    expect(out).toEqual([{ year: 2025, basis: "OFS", revenue: 10, operatingIncome: null, netIncome: null, totalAssets: null, totalLiabilities: null, totalEquity: null }]);
    expect(parseSingleAccount([], 2025)).toEqual([]);
  });

  it("배당은 보통주 행을 우선 고른다", () => {
    const list = [
      { se: "주당 현금배당금(원)", stock_knd: "우선주", thstrm: "1,250" },
      { se: "주당 현금배당금(원)", stock_knd: "보통주", thstrm: "1,200" },
      { se: "현금배당수익률(%)", stock_knd: "보통주", thstrm: "0.6" },
      { se: "(연결)현금배당성향(%)", thstrm: "5.1" },
    ];
    expect(parseDividends(list, 2025)).toEqual({ year: 2025, cashDividendPerShare: 1200, dividendYieldPct: 0.6, payoutRatioPct: 5.1 });
    expect(parseDividends([], 2025)).toBeNull();
  });
});

describe("DART 고유번호 표 (BH-44)", () => {
  const xmlOf = (codes: string[]) =>
    `<?xml version="1.0"?><result>${codes.map((c, i) => `<list><corp_code>0099${String(i).padStart(4, "0")}</corp_code><corp_name>회사${c}</corp_name><stock_code>${c}</stock_code><modify_date>20260101</modify_date></list>`).join("")}</result>`;

  function dartFake(listed: () => string[]) {
    const counts = { corpCode: 0 };
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/corpCode.xml")) {
        counts.corpCode++;
        await new Promise((r) => setTimeout(r, 5)); // 내려받는 동안 다른 호출이 겹치게
        return new Response(zipSync({ "CORPCODE.xml": strToU8(xmlOf(listed())) }), { status: 200 });
      }
      if (url.includes("/company.json")) return new Response(JSON.stringify({ status: "000", corp_name: "회사", ceo_nm: "대표" }), { status: 200 });
      return new Response(JSON.stringify({ status: "013", list: [] }), { status: 200 });
    }) as typeof fetch;
    return { counts, fetchFn };
  }

  it("처음 쓸 때 여러 호출이 겹쳐도 corpCode.xml 은 한 번만 받는다", async () => {
    const db = await createMigratedDb(":memory:");
    const { counts, fetchFn } = dartFake(() => ["005930"]);
    const dart = new DartProvider({ apiKey: "k", db, fetchFn, now: () => new Date("2026-09-25T09:00:00+09:00") });
    await Promise.all([dart.getCompany("005930"), dart.getDisclosures("005930", 7, 5), dart.getDividends("005930", 1), dart.getAnnualFinancials("005930", 1)]);
    expect(counts.corpCode).toBe(1);
    await db.destroy();
  });

  it("표에 없는 종목(첫 다운로드 뒤 상장)은 표가 하루 넘게 묵었으면 다시 받아 찾는다. 하루 안에는 다시 받지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    let listed = ["005930"];
    let now = new Date("2026-09-25T09:00:00+09:00");
    const { counts, fetchFn } = dartFake(() => listed);
    const dart = new DartProvider({ apiKey: "k", db, fetchFn, now: () => now });
    await dart.getCompany("005930");
    expect(counts.corpCode).toBe(1);
    // 같은 날 없는 코드: 곧바로 다시 받지 않는다 (ETF 처럼 원래 없는 코드로 매번 내려받지 않게)
    await expect(dart.getCompany("999990")).rejects.toThrow("DART 고유번호를 찾을 수 없음");
    expect(counts.corpCode).toBe(1);
    // 며칠 뒤 새로 상장한 종목
    listed = ["005930", "999990"];
    now = new Date("2026-09-28T09:00:00+09:00");
    expect((await dart.getCompany("999990")).name).toBe("회사");
    expect(counts.corpCode).toBe(2);
    // 방금 새로 받았으니 또 없는 코드여도 다시 받지 않는다
    await expect(dart.getCompany("888880")).rejects.toThrow("DART 고유번호를 찾을 수 없음");
    expect(counts.corpCode).toBe(2);
    await db.destroy();
  });
});
