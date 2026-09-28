import { describe, expect, it } from "vitest";
import { floor10, isKrBankDay, TAX_EXCLUDE_REASON, taxFor, TAX_RULES, taxSummary, usSettleDate, type TaxSellInput } from "../src/services/taxRules.js";

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

  it("검토 반영 3차: 2026 전 한국 공휴일(2022~2025)도 은행 휴일 — 2025 추석(10/3·10/6~10/9)·설(1/27~1/30) 위에 결제일을 잡지 않는다", () => {
    for (const d of ["2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09", "2025-01-27", "2025-01-28", "2025-01-29", "2025-01-30", "2024-09-17", "2023-10-02"]) {
      expect(isKrBankDay(d), d).toBe(false);
    }
    // 거래소만 쉬는 연말 휴장은 은행 영업일
    expect(isKrBankDay("2023-12-29")).toBe(true);
    expect(isKrBankDay("2024-12-31")).toBe(true);
    expect(isKrBankDay("2025-10-10")).toBe(true);
    // 미국 10/2(목) 매수 → 현지 결제 10/3(금) → 국내 결제일은 연휴 뒤 10/10(금) (예전에는 휴일인 10/6)
    expect(usSettleDate("2025-10-02")).toEqual({ us: "2025-10-03", kr: "2025-10-10" });
    expect(usSettleDate("2025-01-23")).toEqual({ us: "2025-01-24", kr: "2025-01-31" });
  });

  it("2026 전 공휴일 목록은 모두 평일이고, 2026 뒤 거래소 목록(KR_HOLIDAYS)과 겹치지 않는다", async () => {
    const { KR_BANK_HOLIDAYS_PAST } = await import("../src/services/taxRules.js");
    const { KR_HOLIDAYS } = await import("../src/services/marketContext.js");
    for (const d of KR_BANK_HOLIDAYS_PAST) {
      const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
      expect(wd >= 1 && wd <= 5, d).toBe(true);
      expect(d < "2026-01-01", d).toBe(true);
      expect(d in KR_HOLIDAYS, d).toBe(false);
    }
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

describe("검토 반영 7차: 설명되지 않은 기간의 매도는 늘 합계에서 빼고 따로 · 그 뒤 매도는 취득가 모름 · 순서 모름은 기본으로 합계에서 뺀다", () => {
  const order = { status: "order-uncertain" as const, reason: "같은 날 사고판 순서를 몰라 추정했어요." };
  const why = { reason: "이 기간은 주식 수·매입금액이 기록과 달라 손익을 계산하지 않았어요.", change: "수량 1,000 → 0주 · 기록된 매매대로라면 750주", guess: "4→1 병합으로 보여요(추정)" };
  const rows = () => [
    item({ key: "a", gainParts: { proceeds: 1_000_000, cost: 900_000, costs: null } }),
    item({ key: "u", quantity: 250, proceedsUsd: 100_000, gainParts: null, excluded: "unexplained", unexplained: why }),
    item({ key: "c", code: "NVDA", name: "엔비디아", gainParts: null, excluded: "changed" }),
    item({ key: "d", code: "TSLA", name: "테슬라", gainParts: { proceeds: 500_000, cost: 400_000, costs: null }, estimate: order }),
  ];

  it("기본: 합계는 온전한 매도만 — 설명되지 않은 매도는 까닭·바뀐 것·이름표와 함께 따로(숫자 없음), 변화 뒤 매도는 취득가 모름, 순서 모름은 빼고 참고 값", () => {
    const s = taxSummary(2026, rows());
    expect(s.totals).toMatchObject({ sells: 1, net: 100_000 });
    expect(s.items.map((x) => x.key)).toEqual(["a"]);
    expect(s.excluded).toEqual([
      { code: "NVDA", name: "엔비디아", count: 1, reason: TAX_EXCLUDE_REASON.changed },
      { code: "SOXL", name: "SOXL", count: 1, reason: TAX_EXCLUDE_REASON.unexplained },
      { code: "TSLA", name: "테슬라", count: 1, reason: TAX_EXCLUDE_REASON.uncertain },
    ]);
    expect(s.unexplainedSells).toEqual([{ key: "u", code: "SOXL", name: "SOXL", tradeDate: "2026-09-25", settleDate: "2026-09-29", quantity: 250, proceedsUsd: 100_000, ...why }]);
    expect(s).toMatchObject({ complete: false, includeUncertain: false, uncertainExcluded: 1, uncertainGainKrw: 100_000, estimatedIncluded: 0, estimatedSells: [] });
    expect(s.uncertainItems).toMatchObject([{ key: "d", gainKrw: 100_000, estimate: order }]);
  });

  it("includeUncertain: 순서 모름은 합계에 넣고 '추정 포함' — 설명되지 않은 매도는 그래도 넣지 않는다", () => {
    const s = taxSummary(2026, rows(), { includeUncertain: true });
    expect(s.totals).toMatchObject({ sells: 2, net: 200_000 });
    expect(s.estimatedIncluded).toBe(1);
    expect(s.estimatedSells).toEqual([{ code: "TSLA", name: "테슬라", count: 1, reason: order.reason }]);
    expect(s.unexplainedSells.map((x) => x.key)).toEqual(["u"]);
    expect(s.excluded.map((x) => x.reason)).toEqual([TAX_EXCLUDE_REASON.changed, TAX_EXCLUDE_REASON.unexplained]);
    expect(s).toMatchObject({ uncertainExcluded: 0, uncertainGainKrw: null, uncertainItems: [] });
  });

  it("설명되지 않은 매도는 결제일 환율을 받는 중이어도 '받는 중'이 아니라 빠진 매도 · 다른 해(결제일 기준) 매도는 세지 않는다", () => {
    const s = taxSummary(2026, [
      item({ key: "u", gainParts: null, excluded: "unexplained", pending: true, unexplained: why }),
      item({ key: "v", settleDate: "2027-01-04", gainParts: null, excluded: "unexplained", unexplained: why }),
    ]);
    expect(s.fxPending).toBe(0);
    expect(s.unexplainedSells.map((x) => x.key)).toEqual(["u"]);
    expect(s.complete).toBe(false);
  });

  it("순서 모름 매도의 큰 손실이 예상 세액을 몰래 0 으로 만들지 않는다 (넣으면 세액 0)", () => {
    const list = [
      item({ key: "real", gainParts: { proceeds: 10_000_000, cost: 5_000_000, costs: null } }),
      item({ key: "fake", gainParts: { proceeds: 135_000_000, cost: 540_000_000, costs: null }, estimate: order }),
    ];
    const s = taxSummary(2026, list);
    expect(s.totals).toEqual({ gains: 5_000_000, losses: 0, net: 5_000_000, ...taxFor(5_000_000), sells: 1 });
    expect(s.totals.tax).toBe(550_000);
    expect(s).toMatchObject({ uncertainExcluded: 1, uncertainGainKrw: -405_000_000, complete: false });
    expect(s.excluded).toEqual([{ code: "SOXL", name: "SOXL", count: 1, reason: TAX_EXCLUDE_REASON.uncertain }]);
    expect(taxSummary(2026, list, { includeUncertain: true }).totals.tax).toBe(0);
  });
});
