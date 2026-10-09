import { describe, expect, it } from "vitest";
import { verifyReport } from "../src/services/reportVerification.js";
import { makeQuote } from "./helpers.js";

const kr = { quote: makeQuote("005930", "고정 출처", 71_234) };
const us = { quote: { ...makeQuote("AAPL", "고정 출처", 123.456), currency: "USD", changeRate: -2.34 } };
describe("확인 가능한 시세 주장만 대조하는 검사", () => {
  it.each(["현재가: 71,234원", "**현재가**: 7.12만원", "| 현재가 | 7.1만원 |", "현재 주가는 약 71,234원입니다.", "- 현재 가격: 71,234 KRW"])("정상 가격·반올림·단위 변환을 불일치로 오인하지 않는다: %s", (body) => {
    const r = verifyReport(body, kr);
    expect(r.checkedClaims).toBe(1);
    expect(r.issues).toEqual([]);
  });
  it.each(["현재가: $123.46", "현재가: 123.46달러", "현재가: 123 USD"])("달러 가격의 표시 자리수 반올림을 보존한다: %s", (body) => {
    expect(verifyReport(body, us)).toMatchObject({ checkedClaims: 1, issues: [] });
  });
  it.each(["현재가: 99,000원일 경우", "과거 현재가: 99,000원", "현재가: 99,000원 이상", "현재가: 99,000~100,000원", "다른 기업의 현재가: 99,000원", "현재가가 99,000원에 도달하면", "예상 현재가: 99,000원", "현재가: 99,000", "현재가: 123달러"])("가정·범위·다른 대상·통화가 불분명한 주장을 잘못 판정하지 않는다: %s", (body) => {
    expect(verifyReport(body, kr)).toMatchObject({ checkedClaims: 0, issues: [] });
  });
  it.each(["등락률: -2.34%", "전일 대비: 2.34% 하락", "전일 대비 등락률은 -2.3%"])("등락률 부호와 표시 자리수를 보존한다: %s", (body) => {
    expect(verifyReport(body, us)).toMatchObject({ checkedClaims: 1, issues: [] });
  });
  it("명확한 가격·등락 부호 불일치를 본문 삭제 없이 반환한다", () => {
    const body = "현재가: 70,000원\n등락률: -1.01%\n분석 내용 유지";
    const r = verifyReport(body, kr);
    expect(r.issues).toEqual([{ field: "price", reported: "현재가: 70,000원", expected: "71,234원" }, { field: "changeRate", reported: "등락률: -1.01%", expected: "1.01%" }]);
    expect(body).toContain("분석 내용 유지");
  });
  it("숫자와 상승·하락 표현 자체가 충돌해도 확인 대상으로 남긴다", () => {
    expect(verifyReport("전일 대비: +2.34% 하락", us).issues).toHaveLength(1);
  });
  it.each(["등락률: 1.01%p", "등락률: 1.01%↓", "등락률: 1.01% 내림", "등락률: -0.5% ~ +1.5%", "현재가: 90,000원 ~ 110,000원", "현재가: 90,000원 (2025년 1월 1일 기준)", "현재가: 70,000원 (다른 종목)"])("미지원 단위·범위·대상·시점의 일부 숫자만 비교하지 않는다: %s", (body) => {
    expect(verifyReport(body, kr)).toMatchObject({ checkedClaims: 0, issues: [] });
  });
  it("중복 문장은 한 번 확인하고 원자료를 변경하지 않는다", () => {
    const before = structuredClone(kr);
    expect(verifyReport("현재가: 70,000원\n현재가: 70,000원", kr)).toMatchObject({ checkedClaims: 1, issues: [{ field: "price" }] });
    expect(kr).toEqual(before);
  });
  it.each([null, [], "오류", { quote: null }, { quote: { asOf: "잘못된 시각", price: "123", changeRate: null } }])("없거나 손상된 자료는 검증 성공·생성시각 대입으로 바꾸지 않는다: %j", (input) => {
    expect(verifyReport("현재가: 100원", input)).toEqual({ scope: "quote_claims", quoteAsOf: null, quoteSource: null, checkedClaims: 0, issues: [] });
  });
});
