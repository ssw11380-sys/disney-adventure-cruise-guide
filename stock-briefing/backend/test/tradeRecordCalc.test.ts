import { describe, expect, it } from "vitest";
import {
  buildSnapshotData,
  CLOSE_TOLERANCE_MS,
  emptyHoldingsProblem,
  missingDates,
  recentExpectedDates,
  sessionDate,
  snapshotDueAt,
  snapshotPlan,
  tradingDaysBetween,
  unexplainedChanges,
  zonedInstant,
} from "../src/services/tradeRecordCalc.js";
import { seoulIso } from "../src/lib/time.js";

/** 한국 시간 ISO → Date */
const kst = (s: string) => new Date(`${s}+09:00`);
const iso = (d: Date) => seoulIso(d);

describe("매매 기록 — 스냅샷 시각 (3-36)", () => {
  it("현지 시각 → 실제 시각: 서울은 늘 +09:00, 뉴욕은 서머타임(EDT −4 / EST −5)을 따른다", () => {
    expect(iso(zonedInstant("2026-09-28", 16 * 60 + 5, "Asia/Seoul"))).toBe("2026-09-28T16:05:00+09:00");
    expect(zonedInstant("2026-10-30", 16 * 60 + 5, "America/New_York").toISOString()).toBe("2026-10-30T20:05:00.000Z");
    expect(zonedInstant("2026-11-02", 16 * 60 + 5, "America/New_York").toISOString()).toBe("2026-11-02T21:05:00.000Z");
    // 2027-03-14(일) 서머타임 시작 — 금요일은 EST, 월요일은 EDT
    expect(zonedInstant("2027-03-12", 16 * 60 + 5, "America/New_York").toISOString()).toBe("2027-03-12T21:05:00.000Z");
    expect(zonedInstant("2027-03-15", 16 * 60 + 5, "America/New_York").toISOString()).toBe("2027-03-15T20:05:00.000Z");
  });

  it("한국은 정규장 마감 35분 뒤(보통 16:05, 수능일 17:05), 미국은 정규장 마감 5분 뒤(조기 폐장 13:05 ET)", () => {
    expect(iso(snapshotDueAt("KR", "2026-09-28"))).toBe("2026-09-28T16:05:00+09:00");
    expect(iso(snapshotDueAt("KR", "2026-11-19"))).toBe("2026-11-19T17:05:00+09:00"); // 수능일 16:30 마감
    expect(iso(snapshotDueAt("KR", "2027-01-04"))).toBe("2027-01-04T16:05:00+09:00"); // 새해 첫날은 개장만 늦음
    expect(iso(snapshotDueAt("US", "2026-09-25"))).toBe("2026-09-26T05:05:00+09:00"); // EDT
    expect(iso(snapshotDueAt("US", "2026-11-02"))).toBe("2026-11-03T06:05:00+09:00"); // EST
    expect(iso(snapshotDueAt("US", "2026-11-27"))).toBe("2026-11-28T03:05:00+09:00"); // 추수감사절 다음 날 조기 폐장
    expect(iso(snapshotDueAt("US", "2026-12-24"))).toBe("2026-12-25T03:05:00+09:00");
  });

  it("스냅샷 날짜는 그 시장의 거래일: 한국 추석(9/24~25)·주말·개천절 대체(10/5)는 직전 거래일, 미국 20:00 ET 뒤는 다음 거래일", () => {
    expect(sessionDate("KR", kst("2026-09-24T16:10:00"))).toBe("2026-09-23");
    expect(sessionDate("KR", kst("2026-09-27T12:00:00"))).toBe("2026-09-23");
    expect(sessionDate("KR", kst("2026-09-28T07:59:00"))).toBe("2026-09-23"); // 08:00 전은 전 거래일
    expect(sessionDate("KR", kst("2026-09-28T08:00:00"))).toBe("2026-09-28");
    expect(sessionDate("KR", kst("2026-10-05T16:10:00"))).toBe("2026-10-02");
    expect(sessionDate("US", kst("2026-09-26T10:00:00"))).toBe("2026-09-25"); // 토요일 = 금요일 정규장 뒤
    expect(sessionDate("US", kst("2026-09-29T08:59:00"))).toBe("2026-09-28"); // 뉴욕 9/28 19:59
    expect(sessionDate("US", kst("2026-09-29T09:00:00"))).toBe("2026-09-29"); // 뉴욕 20:00 → 다음 날 주간거래
    expect(sessionDate("US", kst("2026-11-27T01:00:00"))).toBe("2026-11-25"); // 추수감사절(11/26 뉴욕) 동안은 수요일
  });

  it("계획: 마감 전이면 아직, 마감 뒤 30분 안이면 'close', 그 뒤 같은 거래일 안이면 'intraday-fallback'", () => {
    expect(snapshotPlan("KR", kst("2026-09-28T16:04:59"))).toMatchObject({ date: "2026-09-28", due: false, method: null });
    expect(snapshotPlan("KR", kst("2026-09-28T16:05:00"))).toMatchObject({ date: "2026-09-28", due: true, method: "close" });
    expect(snapshotPlan("KR", kst("2026-09-28T16:35:00"))).toMatchObject({ due: true, method: "close" });
    expect(snapshotPlan("KR", kst("2026-09-28T16:35:01"))).toMatchObject({ due: true, method: "intraday-fallback" });
    // 토요일에 본 금요일(한국 거래가 없어 수량·가격은 금요일 마지막 값)
    expect(snapshotPlan("KR", kst("2026-10-03T11:00:00"))).toMatchObject({ date: "2026-10-02", due: true, method: "intraday-fallback" });
    // 미국 조기 폐장: 13:05 ET = 03:05 KST
    expect(snapshotPlan("US", kst("2026-11-28T03:04:00"))).toMatchObject({ date: "2026-11-27", due: false });
    expect(snapshotPlan("US", kst("2026-11-28T03:05:00"))).toMatchObject({ date: "2026-11-27", due: true, method: "close" });
    // 서머타임 끝난 뒤 월요일: 06:05 KST 전은 아직
    expect(snapshotPlan("US", kst("2026-11-03T05:06:00"))).toMatchObject({ date: "2026-11-02", due: false });
    expect(snapshotPlan("US", kst("2026-11-03T06:06:00"))).toMatchObject({ date: "2026-11-02", due: true, method: "close" });
    expect(CLOSE_TOLERANCE_MS).toBe(30 * 60_000);
  });

  it("거래일 목록: 휴장일·주말을 빼고 사이 날짜만 (양 끝 제외)", () => {
    expect(tradingDaysBetween("KR", "2026-09-23", "2026-10-06")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(tradingDaysBetween("US", "2026-11-24", "2026-11-30")).toEqual(["2026-11-25", "2026-11-27"]);
    expect(tradingDaysBetween("KR", "2026-10-02", "2026-10-02")).toEqual([]);
  });

  it("점검 대상 거래일: 마감+30분이 지난 거래일부터 최근 n개 (새것부터)", () => {
    expect(recentExpectedDates("KR", kst("2026-09-28T16:20:00"), 3)).toEqual(["2026-09-23", "2026-09-22", "2026-09-21"]);
    expect(recentExpectedDates("KR", kst("2026-09-28T16:40:00"), 3)).toEqual(["2026-09-28", "2026-09-23", "2026-09-22"]);
    expect(recentExpectedDates("US", kst("2026-11-28T12:00:00"), 3)).toEqual(["2026-11-27", "2026-11-25", "2026-11-24"]);
    expect(recentExpectedDates("KR", kst("2026-10-06T10:00:00"), 5)).toEqual(["2026-10-02", "2026-10-01", "2026-09-30", "2026-09-29", "2026-09-28"]);
  });

  it("빠진 날: 기록 시작일 이후에 스냅샷(ok)이 없는 거래일만 — 시작 전 날은 빠진 날이 아님", () => {
    const expected = ["2026-10-02", "2026-10-01", "2026-09-30", "2026-09-29", "2026-09-28"];
    expect(missingDates(expected, new Set(["2026-10-02", "2026-09-29"]), "2026-09-29")).toEqual(["2026-10-01", "2026-09-30"]);
    expect(missingDates(expected, new Set(), null)).toEqual([]);
  });
});

describe("매매 기록 — 스냅샷 내용 (3-36)", () => {
  const accounts = [
    {
      account: 3,
      items: [
        { code: "005930", name: "삼성전자", currency: "KRW" as const, quantity: 10, avgPrice: 70000, lastPrice: 71200, purchaseAmount: 700000, marketValue: 712000, marketValueAfterCost: 710519 },
        { code: "SOXL", name: "SOXL", currency: "USD" as const, quantity: 25, avgPrice: 33.0167, lastPrice: 38.02, purchaseAmount: 825.4, marketValue: 950.5, marketValueAfterCost: 949.55 },
      ],
      overview: { purchaseKrw: 700000, purchaseUsd: 825.4, afterCostKrw: 710519, afterCostUsd: 949.55, rateAfterCost: 0.0421 },
    },
    {
      account: 7,
      items: [{ code: "SOXL", name: "SOXL", currency: "USD" as const, quantity: 5, avgPrice: 35, lastPrice: 38.02, purchaseAmount: 175, marketValue: 190.1, marketValueAfterCost: 189.9 }],
      overview: { purchaseKrw: 0, purchaseUsd: 175, afterCostKrw: 0, afterCostUsd: 189.9, rateAfterCost: 0.08 },
    },
  ];

  it("한국 스냅샷은 한국 종목만, 원화 합계는 토스 평가금액 그대로", () => {
    const d = buildSnapshotData("KR", accounts, { fx: null, fxSource: null, scheduledAt: "2026-09-28T16:05:00+09:00", krwCost: () => null });
    expect(d.holdings.map((h) => h.code)).toEqual(["005930"]);
    expect(d.holdings[0]).toMatchObject({ account: 3, quantity: 10, avgPrice: 70000, price: 71200, valueKrw: 712000, costKrw: 700000, costKrwSource: "toss" });
    expect(d.totals).toEqual({ holdings: 1, valueKrw: 712000, valueAfterCostKrw: 710519, costKrw: 700000, valueUsd: null, costUsd: null });
    expect(d.fx).toBeNull();
    expect(d.accounts).toHaveLength(2);
  });

  it("미국 스냅샷은 계좌·종목별 줄, 원화는 기록한 환율로, 원화 매입금액은 원화 장부(없으면 null — 지어내지 않음)", () => {
    const d = buildSnapshotData("US", accounts, {
      fx: 1390,
      fxSource: "display",
      scheduledAt: "2026-09-29T05:05:00+09:00",
      krwCost: (account, code, qty) => (account === 3 && code === "SOXL" && qty === 25 ? { krw: 1_150_000, source: "book-exact" } : null),
    });
    expect(d.holdings.map((h) => [h.account, h.code, h.quantity])).toEqual([
      [3, "SOXL", 25],
      [7, "SOXL", 5],
    ]);
    expect(d.holdings[0]).toMatchObject({ valueKrw: 1_321_195, costKrw: 1_150_000, costKrwSource: "book-exact" });
    expect(d.holdings[1]).toMatchObject({ valueKrw: 264_239, costKrw: null, costKrwSource: null });
    expect(d.fx).toEqual({ usdKrw: 1390, source: "display" });
    // 원화 매입금액이 하나라도 없으면 합계도 null
    expect(d.totals).toMatchObject({ holdings: 2, valueKrw: 1_585_434, costKrw: null, valueUsd: 1140.6, costUsd: 1000.4 });
    const noFx = buildSnapshotData("US", accounts, { fx: null, fxSource: null, scheduledAt: "x", krwCost: () => null });
    expect(noFx.totals.valueKrw).toBeNull();
    expect(noFx.holdings[0]!.valueKrw).toBeNull();
  });

  it("보유가 비었는데 계좌 요약에 그 통화 매입금액이 있거나 모르면 믿지 않는다 (일시 오류로 보고 다시)", () => {
    const empty = (purchaseKrw: number, purchaseUsd: number | null) => [{ account: 1, items: [], overview: { purchaseKrw, purchaseUsd, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null } }];
    expect(emptyHoldingsProblem("KR", empty(1000, 0))).toMatch(/비었/);
    expect(emptyHoldingsProblem("KR", empty(0, 0))).toBeNull();
    expect(emptyHoldingsProblem("US", empty(0, null))).toMatch(/비었/);
    expect(emptyHoldingsProblem("US", empty(0, 0))).toBeNull();
    expect(emptyHoldingsProblem("US", accounts)).toBeNull();
  });
});

describe("매매 기록 — 주문 내역으로 설명되지 않는 수량 변화 (추정)", () => {
  const snap = (date: string, asOf: string, holdings: Array<[number, string, number, number | null]>) => ({
    date,
    market: "US" as const,
    asOf,
    holdings: holdings.map(([account, code, quantity, avgPrice]) => ({ account, code, quantity, avgPrice })),
  });

  it("스냅샷 사이 수량 변화 = 그 사이 체결 합이면 추정 없음, 모자라거나 넘치면 그 차이만 '추정' 한 줄", () => {
    const snaps = [
      snap("2026-09-28", "2026-09-29T05:05:00+09:00", [[3, "SOXL", 10, 30], [3, "TSLA", 2, 300], [3, "NVDA", 4, 100]]),
      snap("2026-09-29", "2026-09-30T05:05:00+09:00", [[3, "SOXL", 15, 31], [3, "TSLA", 1, 300], [3, "AAPL", 3, 200]]),
    ];
    const trades = [
      { account: 3, code: "SOXL", side: "BUY" as const, quantity: 3, executedAt: "2026-09-29T23:00:00+09:00" },
      { account: 3, code: "TSLA", side: "SELL" as const, quantity: 1, executedAt: "2026-09-29T23:30:00+09:00" },
      { account: 3, code: "NVDA", side: "SELL" as const, quantity: 4, executedAt: "2026-09-29T22:40:00+09:00" },
      // 스냅샷 전 체결은 세지 않는다
      { account: 3, code: "SOXL", side: "BUY" as const, quantity: 100, executedAt: "2026-09-28T23:00:00+09:00" },
    ];
    const out = unexplainedChanges(snaps, trades);
    expect(out).toEqual([
      {
        market: "US",
        account: 3,
        code: "AAPL",
        fromDate: "2026-09-28",
        toDate: "2026-09-29",
        fromQty: 0,
        toQty: 3,
        tradedQty: 0,
        unexplainedQty: 3,
        fromAvg: null,
        toAvg: 200,
        kind: "increase",
        estimated: true,
      },
      {
        market: "US",
        account: 3,
        code: "SOXL",
        fromDate: "2026-09-28",
        toDate: "2026-09-29",
        fromQty: 10,
        toQty: 15,
        tradedQty: 3,
        unexplainedQty: 2,
        fromAvg: 30,
        toAvg: 31,
        kind: "increase",
        estimated: true,
      },
    ]);
  });
});
