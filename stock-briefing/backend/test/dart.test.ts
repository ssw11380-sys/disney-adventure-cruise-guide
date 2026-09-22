import { describe, expect, it } from "vitest";
import { parseCorpCodeXml, parseDividends, parseSingleAccount } from "../src/providers/dart/dart.js";

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
