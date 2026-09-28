import { describe, expect, it } from "vitest";
import { floor10, isKrBankDay, taxFor, TAX_RULES, taxSummary, usSettleDate, type TaxSellInput } from "../src/services/taxRules.js";

/**
 * 해외주식 양도세 추정 (3-37, 참고용) — 결제일·세액 규칙. 순수 함수, 고정 값.
 * 결제일 예시는 설계안 §3.6.2 (대신증권 공지 2024 의 '미국 12/27 매매까지 12/31 결제'와 같은 결과)
 */

describe("결제일 (추정): 미국 T+1 → 그다음 한국 은행 영업일", () => {
  it("보통 날·추석·추수감사절·연말 (§9-21)", () => {
    expect(usSettleDate("2026-09-28")).toEqual({ us: "2026-09-29", kr: "2026-09-30" });
    expect(usSettleDate("2026-09-23")).toEqual({ us: "2026-09-24", kr: "2026-09-28" }); // 한국 9/24·25 추석, 주말
    expect(usSettleDate("2026-11-25")).toEqual({ us: "2026-11-27", kr: "2026-11-30" }); // 11/26 추수감사절
    expect(usSettleDate("2026-12-29")).toEqual({ us: "2026-12-30", kr: "2026-12-31" }); // 12/31 은 은행 영업일 → 2026년 몫
    expect(usSettleDate("2026-12-30")).toEqual({ us: "2026-12-31", kr: "2027-01-04" }); // 2027년 몫
    expect(usSettleDate("2024-12-27")).toEqual({ us: "2024-12-30", kr: "2024-12-31" }); // 대신증권 공지와 같음
  });

  it("미국 은행 휴일(콜럼버스 데이·재향군인의 날)에는 결제가 없어 하루 밀린다 (거래소는 여는 날)", () => {
    expect(usSettleDate("2026-10-09")).toEqual({ us: "2026-10-13", kr: "2026-10-14" });
    expect(usSettleDate("2026-11-10")).toEqual({ us: "2026-11-12", kr: "2026-11-13" });
  });

  it("한국 은행 영업일: 주말·공휴일은 아니고, 12/31 '연말'은 거래소만 쉬는 날이라 영업일", () => {
    expect(isKrBankDay("2026-09-25")).toBe(false);
    expect(isKrBankDay("2026-09-26")).toBe(false);
    expect(isKrBankDay("2026-12-31")).toBe(true);
    expect(isKrBankDay("2027-01-01")).toBe(false);
    expect(isKrBankDay("2026-09-30")).toBe(true);
  });
});

describe("세액 (2026년 세법 기준으로 넣은 값)", () => {
  it("22% = 양도소득세 20% + 지방소득세(양도소득세의 10%), 기본공제 250만 원", () => {
    expect(TAX_RULES).toMatchObject({ rate: 0.22, nationalRate: 0.2, localRateOfNational: 0.1, deduction: 2_500_000, method: "moving-average", lawYear: 2026 });
  });

  it("3,450,000 → 209,000원 / 2,400,000 → 0 / −550,000 → 0 / 10원 미만 버림 (§9-23)", () => {
    expect(taxFor(3_450_000)).toEqual({ base: 950_000, nationalTax: 190_000, localTax: 19_000, tax: 209_000 });
    expect(taxFor(2_400_000)).toEqual({ base: 0, nationalTax: 0, localTax: 0, tax: 0 });
    expect(taxFor(-550_000)).toEqual({ base: 0, nationalTax: 0, localTax: 0, tax: 0 });
    // 과세 대상 2,500,123 원이면 123 → 24.6 → 20원, 지방소득세 2 → 0원
    expect(taxFor(2_500_123)).toEqual({ base: 123, nationalTax: 20, localTax: 0, tax: 20 });
    expect(floor10(1_234_567.8)).toBe(1_234_560);
  });
});

const item = (over: Partial<TaxSellInput> & Pick<TaxSellInput, "key" | "gainParts">): TaxSellInput => ({
  code: "SOXL",
  name: "SOXL",
  tradeDate: "2026-09-25",
  settleDate: "2026-09-29",
  settleSource: "estimated",
  quantity: 5,
  proceedsUsd: 187.5,
  costsUsd: null,
  fxSell: { rate: 1389.4, source: "smbs", date: "2026-09-29", provisional: false },
  excluded: null,
  pending: false,
  ...over,
});

describe("한 해 합계 (결제일 기준 연도, 손익통산)", () => {
  it("이익·손실을 더하고, 매도마다 원 단위로 먼저 반올림한 값의 합 = 합계", () => {
    const s = taxSummary(2026, [
      item({ key: "a", gainParts: { proceeds: 3_000_000.4, cost: 1_000_000.2, costs: null } }),
      item({ key: "b", gainParts: { proceeds: 3_000_000, cost: 1_000_000, costs: 5_000 } }),
      item({ key: "c", gainParts: { proceeds: 1_000_000, cost: 1_550_000, costs: null } }),
      item({ key: "d", settleDate: "2027-01-04", gainParts: { proceeds: 9_000_000, cost: 1, costs: null } }), // 다음 해 몫
    ]);
    expect(s.totals).toEqual({ gains: 3_995_000, losses: -550_000, net: 3_445_000, base: 945_000, nationalTax: 189_000, localTax: 18_900, tax: 207_900, sells: 3 });
    expect(s.items.map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(s.items[1]).toMatchObject({ proceedsKrw: 3_000_000, costKrw: 1_000_000, costsKrw: 5_000, gainKrw: 1_995_000 });
    expect(s.complete).toBe(true);
  });

  it("취득가를 모르는 매도·결제일 환율이 없는 매도는 빼고 종목·건수·까닭을 모은다 (§3.6.4)", () => {
    const s = taxSummary(2026, [
      item({ key: "a", gainParts: { proceeds: 1_000_000, cost: 900_000, costs: null } }),
      item({ key: "b", code: "TSLA", name: "테슬라", gainParts: null, excluded: "cost" }),
      item({ key: "c", code: "TSLA", name: "테슬라", gainParts: null, excluded: "cost" }),
      item({ key: "d", gainParts: null, excluded: "fx" }),
    ]);
    expect(s.totals.sells).toBe(1);
    expect(s.complete).toBe(false);
    expect(s.excluded).toEqual([
      { code: "TSLA", name: "테슬라", count: 2, reason: "기록 시작 전에 산 몫이라 취득가를 몰라요" },
      { code: "SOXL", name: "SOXL", count: 1, reason: "결제일 환율을 받지 못했어요" },
    ]);
  });

  it("환율을 받는 중인 매도는 빠진 매도가 아니라 '받는 중'으로 센다", () => {
    const s = taxSummary(2026, [item({ key: "a", gainParts: null, excluded: "fx", pending: true })]);
    expect(s.fxPending).toBe(1);
    expect(s.excluded).toEqual([]);
    expect(s.complete).toBe(false);
  });
});
