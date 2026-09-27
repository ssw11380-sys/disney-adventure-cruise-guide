import { describe, expect, it } from "vitest";
import {
  buildSnapshotData,
  CLOSE_TOLERANCE_MS,
  DOUBT_ACCEPT_MS,
  doubtCarriesOver,
  missingDates,
  netTradedBetween,
  recentExpectedDates,
  sessionDate,
  snapshotDoubts,
  snapshotDueAt,
  snapshotPlan,
  tradingDaysBetween,
  unexplainedChanges,
  zonedInstant,
} from "../src/services/tradeRecordCalc.js";
import { seoulIso } from "../src/lib/time.js";
import { DOUBT_MS, UNSURE_MS } from "../src/services/tossSyncService.js";

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
    // 정규장 종가는 받지 못하면 null (현재가를 대신 넣지 않음)
    expect(d.holdings[0]).toMatchObject({ regularClose: null, regularCloseSource: null });
    expect(d.regularCloseBasis).toContain("KRX 정규장");
  });

  it("정규장 종가(regularClose)는 현재가(price)와 따로 — 평가금액·원화 합계는 그대로 현재가 기준", () => {
    const d = buildSnapshotData("KR", accounts, {
      fx: null,
      fxSource: null,
      scheduledAt: "2026-09-28T16:05:00+09:00",
      krwCost: () => null,
      regularClose: (code) => (code === "005930" ? { close: 71000, source: "naver" } : null),
    });
    expect(d.holdings[0]).toMatchObject({ code: "005930", price: 71200, regularClose: 71000, regularCloseSource: "naver", valueKrw: 712000 });
    expect(d.priceBasis).toContain("KRX+NXT 통합");
    // 0·NaN 같은 값은 쓰지 않는다
    const bad = buildSnapshotData("KR", accounts, { fx: null, fxSource: null, scheduledAt: "x", krwCost: () => null, regularClose: () => ({ close: 0, source: "naver" }) });
    expect(bad.holdings[0]).toMatchObject({ regularClose: null, regularCloseSource: null });
  });

  it("미국 스냅샷은 계좌·종목별 줄, 원화는 기록한 환율로, 원화 매입금액은 원화 장부(없으면 null — 지어내지 않음)", () => {
    const d = buildSnapshotData("US", accounts, {
      fx: 1390,
      fxSource: "naver",
      fxAsOf: "2026-09-29T05:04:10+09:00",
      scheduledAt: "2026-09-29T05:05:00+09:00",
      krwCost: (account, code, qty) => (account === 3 && code === "SOXL" && qty === 25 ? { krw: 1_150_000, source: "book-exact" } : null),
    });
    expect(d.holdings.map((h) => [h.account, h.code, h.quantity])).toEqual([
      [3, "SOXL", 25],
      [7, "SOXL", 5],
    ]);
    expect(d.holdings[0]).toMatchObject({ valueKrw: 1_321_195, costKrw: 1_150_000, costKrwSource: "book-exact" });
    expect(d.holdings[1]).toMatchObject({ valueKrw: 264_239, costKrw: null, costKrwSource: null });
    // 환율은 실제 출처와 받은 시각을 함께 (토스 표시 환율을 못 받아 네이버 값을 썼으면 'naver')
    expect(d.fx).toEqual({ usdKrw: 1390, source: "naver", asOf: "2026-09-29T05:04:10+09:00" });
    // 원화 매입금액이 하나라도 없으면 합계도 null
    expect(d.totals).toMatchObject({ holdings: 2, valueKrw: 1_585_434, costKrw: null, valueUsd: 1140.6, costUsd: 1000.4 });
    const noFx = buildSnapshotData("US", accounts, { fx: null, fxSource: null, scheduledAt: "x", krwCost: () => null });
    expect(noFx.totals.valueKrw).toBeNull();
    expect(noFx.holdings[0]!.valueKrw).toBeNull();
    expect(noFx.fx).toEqual({ usdKrw: null, source: null, asOf: null });
  });

  // 계좌 하나짜리 응답 (overview 는 주지 않은 칸만 기본값)
  const acct = (account: number, items: (typeof accounts)[number]["items"], overview: Partial<(typeof accounts)[number]["overview"]> = {}) => ({
    account,
    items,
    overview: { purchaseKrw: 0, purchaseUsd: 0, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null, ...overview },
  });

  it("계좌마다 확인: 한 계좌 보유 목록만 비어 오고 그 계좌 요약 매입금액은 있으면 의심 (다른 계좌에 종목이 있어도)", () => {
    const tsla = { code: "TSLA", name: "TSLA", currency: "USD" as const, quantity: 2, avgPrice: 300, lastPrice: 377.5, purchaseAmount: 600, marketValue: 755, marketValueAfterCost: 754 };
    const soxl = accounts[0]!.items[1]!;
    const ok = [acct(3, [soxl], { purchaseUsd: 825.4 }), acct(7, [tsla], { purchaseUsd: 600 })];
    expect(snapshotDoubts("US", ok, { held: [3, 7] })).toEqual([]);
    // 예전 검사(시장 전체)는 계좌 3 에 미국 종목이 있어 그냥 넘겼다 → 계좌 7 몫이 빠진 합계가 'ok' 로 영구히 남았다
    const broken = [acct(3, [soxl], { purchaseUsd: 825.4 }), acct(7, [], { purchaseUsd: 600 })];
    expect(snapshotDoubts("US", broken, { held: [3, 7] })).toEqual([{ kind: "empty", account: 7, text: "계좌 7: 미국 보유 목록이 비었는데 계좌 요약 매입금액은 $600" }]);
    // 한국: 원화 요약이 있는데 한국 종목이 없으면 의심, 원화 요약이 0 이면(미국 종목만 있는 계좌) 괜찮다
    expect(snapshotDoubts("KR", [acct(3, [soxl], { purchaseKrw: 700000, purchaseUsd: 825.4 })])).toEqual([
      { kind: "empty", account: 3, text: "계좌 3: 한국 보유 목록이 비었는데 계좌 요약 매입금액은 700,000원" },
    ]);
    expect(snapshotDoubts("KR", [acct(3, [soxl], { purchaseUsd: 825.4 })])).toEqual([]);
    expect(snapshotDoubts("KR", [acct(3, [], { purchaseUsd: 0 })])).toEqual([]); // 정말 빈 계좌 → 0종목 스냅샷도 사실
  });

  it("전에 그 시장 종목이 있던 계좌가 계좌 목록에서 빠지면 의심 — 늘 비어 있던 계좌·다른 시장 종목만 있던 계좌가 빠진 것은 의심하지 않는다", () => {
    const one = [acct(3, [accounts[0]!.items[1]!], { purchaseUsd: 825.4 })];
    expect(snapshotDoubts("US", one, { held: [3, 7, 7] })).toEqual([{ kind: "missing-account", account: 7, text: "계좌 7: 전에 미국 종목이 있던 계좌가 토스 계좌 목록에서 빠짐" }]);
    // 계좌 7 이 직전 스냅샷에 있었어도 그 시장 종목이 없었으면(held 에 없음) 빠져도 괜찮다 — 예전에는 직전 스냅샷의 모든 계좌를 봐서 24시간 빈칸이 생겼다
    expect(snapshotDoubts("US", one, { held: [3] })).toEqual([]);
    expect(snapshotDoubts("US", one, {})).toEqual([]); // 첫 스냅샷은 비교할 것이 없다
  });

  it("목록이 통째로 비었고 달러 요약이 없으면 — 전에 그 시장 종목이 있던 계좌만 'unsure', 늘 비어 있는 계좌는 의심하지 않는다", () => {
    expect(snapshotDoubts("US", [acct(3, [], { purchaseUsd: null })], { held: [3] })).toEqual([
      { kind: "unsure", account: 3, text: "계좌 3: 보유 목록이 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음 (전에는 미국 종목이 있었음)" },
    ]);
    expect(snapshotDoubts("KR", [acct(3, [], { purchaseUsd: null })], { held: [3] }).map((d) => d.kind)).toEqual(["unsure"]);
    // 늘 비어 있는 두 번째 계좌: 직전 스냅샷에 있었지만 종목이 없었거나, 비교할 스냅샷·동기화 기록이 없으면 의심하지 않는다 (예전에는 날마다 '의심을 안고 저장')
    const soxl = accounts[0]!.items[1]!;
    expect(snapshotDoubts("US", [acct(3, [soxl], { purchaseUsd: 825.4 }), acct(7, [], { purchaseUsd: null })], { held: [3] })).toEqual([]);
    expect(snapshotDoubts("US", [acct(7, [], { purchaseUsd: null })])).toEqual([]);
    // 목록에 다른 시장 종목이 있는 계좌의 달러 요약 빈칸은 '달러 종목 없음'
    expect(snapshotDoubts("US", [acct(3, [accounts[0]!.items[0]!], { purchaseKrw: 700000, purchaseUsd: null })], { held: [3] })).toEqual([]);
  });

  it("목록이 통째로 비고 달러 요약이 없어도 직전 스냅샷의 그 계좌 종목이 그 사이 저장한 매도로 모두 설명되면 전부 판 것 — 의심하지 않는다", () => {
    const before = [{ account: 3, code: "TSLA", quantity: 2 }];
    const empty = [acct(3, [], { purchaseUsd: null })];
    expect(snapshotDoubts("US", empty, { held: [3], holdings: before, traded: { "3:TSLA": -2 } })).toEqual([]);
    // 매도가 모자라거나(1주만 저장) 다른 계좌의 매도면 예전처럼 'unsure'
    expect(snapshotDoubts("US", empty, { held: [3], holdings: before, traded: { "3:TSLA": -1 } }).map((d) => d.kind)).toEqual(["unsure"]);
    expect(snapshotDoubts("US", empty, { held: [3], holdings: before, traded: { "7:TSLA": -2 } }).map((d) => d.kind)).toEqual(["unsure"]);
    // 직전 스냅샷 없이 토스 동기화 기록으로만 아는 계좌는 수량을 몰라 맞춰 볼 수 없다
    expect(snapshotDoubts("US", empty, { held: [3], traded: { "3:TSLA": -2 } }).map((d) => d.kind)).toEqual(["unsure"]);
  });

  it("직전 스냅샷에 있던 종목이 목록에서 사라졌는데 그 사이 저장한 매도로 설명되지 않으면 'vanished' (합계가 맞아도)", () => {
    const soxl = { code: "SOXL", name: "SOXL", currency: "USD" as const, quantity: 100, avgPrice: 33, lastPrice: 38, purchaseAmount: 3300, marketValue: 3800, marketValueAfterCost: 3790 };
    const before = [
      { account: 3, code: "SOXL", quantity: 100 },
      { account: 3, code: "AAPL", quantity: 0.1 },
      { account: 3, code: "005930", quantity: 10 }, // 다른 시장 종목은 이 시장 스냅샷에서 보지 않는다
    ];
    const now = [acct(3, [soxl], { purchaseUsd: 3300 })]; // 요약까지 AAPL 을 뺀 모양 (합계는 맞음)
    expect(snapshotDoubts("US", now, { held: [3], holdings: before })).toEqual([
      { kind: "vanished", account: 3, text: "계좌 3: 직전 스냅샷의 AAPL 0.1주이(가) 목록에서 빠졌는데 그 사이 저장한 매도 체결로 설명되지 않음" },
    ]);
    expect(snapshotDoubts("US", now, { held: [3], holdings: before, traded: { "3:AAPL": -0.1 } })).toEqual([]); // 정말 판 것
    expect(snapshotDoubts("US", now, { held: [3], holdings: before, traded: { "3:AAPL": -0.05 } }).map((d) => d.kind)).toEqual(["vanished"]);
    // 요약의 1% 보다 작은 종목이 빠지고 요약은 그대로 온 응답: 합계도 걸린다 (예전 1% 허용치에서는 'ok' 로 영구 저장)
    expect(snapshotDoubts("US", [acct(3, [soxl], { purchaseUsd: 3320 })], { held: [3], holdings: before }).map((d) => d.kind)).toEqual(["vanished", "sum"]);
    // 전부 판 빈 계좌(요약도 0)여도 매도가 없으면 의심
    expect(snapshotDoubts("US", [acct(3, [], { purchaseUsd: 0 })], { held: [3], holdings: before.slice(0, 1) }).map((d) => d.kind)).toEqual(["vanished"]);
  });

  it("소수 여섯째 자리 수량(토스 16.123456 모양)을 전부 판 날은 의심하지 않는다 — 반올림 위·아래 두 방향, 의심 글도 여섯째 자리까지", () => {
    const t1 = Date.parse("2026-09-29T05:05:00+09:00"), t2 = Date.parse("2026-09-30T05:05:00+09:00");
    const sell = (account: number, code: string, quantity: number) => ({ account, code, side: "SELL" as const, quantity, executedAt: "2026-09-29T23:10:00+09:00" });
    for (const q of [0.123444, 0.123456]) {
      const traded = netTradedBetween([sell(7, "TSLA", q)], t1, t2);
      expect(traded).toEqual({ "7:TSLA": -q }); // 예전에는 넷째 자리로 잘라 −0.1234 → 0.000044주가 남은 것처럼 보여 'unsure'
      expect(snapshotDoubts("US", [acct(7, [], { purchaseUsd: null })], { held: [7], holdings: [{ account: 7, code: "TSLA", quantity: q }], traded })).toEqual([]);
    }
    // 다른 종목이 남은 계좌에서 AAPL 16.123444주를 전부 판 날 (예전에는 'vanished' — 'AAPL 16.1234주')
    const soxl = accounts[0]!.items[1]!;
    const before = [
      { account: 3, code: "SOXL", quantity: 25 },
      { account: 3, code: "AAPL", quantity: 16.123444 },
    ];
    const now = [acct(3, [soxl], { purchaseUsd: 825.4 })];
    expect(snapshotDoubts("US", now, { held: [3], holdings: before, traded: netTradedBetween([sell(3, "AAPL", 16.123444)], t1, t2) })).toEqual([]);
    // 모자라게 판 날은 그대로 의심하고, 글에 여섯째 자리까지 적는다
    expect(snapshotDoubts("US", now, { held: [3], holdings: before, traded: { "3:AAPL": -16.1234 } })).toEqual([
      { kind: "vanished", account: 3, text: "계좌 3: 직전 스냅샷의 AAPL 16.123444주이(가) 목록에서 빠졌는데 그 사이 저장한 매도 체결로 설명되지 않음" },
    ]);
    // 추정도 여섯째 자리까지 — 0.000044주 차이를 0 으로 버리지 않는다
    const snaps = [
      { date: "2026-09-28", market: "US" as const, asOf: "2026-09-29T05:05:00+09:00", holdings: [{ account: 7, code: "TSLA", quantity: 0.123444, avgPrice: 300 }] },
      { date: "2026-09-29", market: "US" as const, asOf: "2026-09-30T05:05:00+09:00", holdings: [] },
    ];
    expect(unexplainedChanges(snaps, [sell(7, "TSLA", 0.123444)])).toEqual([]);
    expect(unexplainedChanges(snaps, [sell(7, "TSLA", 0.1234)]).map((c) => [c.tradedQty, c.unexplainedQty])).toEqual([[-0.1234, -0.000044]]);
  });

  it("직전 스냅샷 뒤 그 시장 종목을 산 계좌도 그 시장 종목이 있는 계좌로 본다 — 목록에서 빠지거나(저장한 매수·동기화·체결 알림) 산 종목이 목록에 없으면 의심", () => {
    const soxl = accounts[0]!.items[1]!;
    const one = [acct(3, [soxl], { purchaseUsd: 825.4 })];
    const before = [{ account: 3, code: "SOXL", quantity: 25 }];
    // 한국 종목만 있던 계좌 7 이 TSLA 를 사고(매수 저장됨) 목록에서 빠짐 — 예전에는 held 에 없어 'ok'
    expect(snapshotDoubts("US", one, { held: [3], holdings: before, traded: { "7:TSLA": 1 } })).toEqual([
      { kind: "missing-account", account: 7, text: "계좌 7: 직전 스냅샷 뒤 미국 종목을 산 것으로 보이는 계좌가 토스 계좌 목록에서 빠짐" },
    ]);
    // 매수가 저장되지 않았어도 동기화·체결 알림으로 샀을 수 있는 계좌(mayHold)가 빠지면 의심, 목록에 있으면 보지 않는다
    expect(snapshotDoubts("US", one, { held: [3], mayHold: [7], holdings: before }).map((d) => [d.kind, d.account])).toEqual([["missing-account", 7]]);
    expect(snapshotDoubts("US", [...one, acct(7, [], { purchaseUsd: null })], { held: [3], mayHold: [7], holdings: before })).toEqual([]);
    // 다른 시장 매수·사고 판 것(순수량 0)은 보지 않는다
    expect(snapshotDoubts("US", one, { held: [3], holdings: before, traded: { "7:005930": 1, "8:TSLA": 0 } })).toEqual([]);
    // 전부 판 날 새로 산 종목(NVDA 1)이 목록에 없음: 목록이 통째로 비고 달러 요약도 없으면 'unsure' (예전에는 TSLA 매도만 맞춰 보고 'ok')
    const tsla = [{ account: 7, code: "TSLA", quantity: 2 }];
    expect(snapshotDoubts("US", [acct(7, [], { purchaseUsd: null })], { held: [7], holdings: tsla, traded: { "7:TSLA": -2, "7:NVDA": 1 } })).toEqual([
      { kind: "unsure", account: 7, text: "계좌 7: 보유 목록이 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음 (전에는 미국 종목이 있었음)" },
    ]);
    expect(snapshotDoubts("US", [acct(7, [], { purchaseUsd: null })], { held: [7], holdings: tsla, traded: { "7:TSLA": -2 } })).toEqual([]); // 정말 전부 판 날
    // 직전 스냅샷에 그 시장 종목이 없던 계좌가 사고 나서 통째로 비어 옴
    expect(snapshotDoubts("US", [acct(7, [], { purchaseUsd: null })], { held: [], traded: { "7:NVDA": 1 } }).map((d) => d.text)).toEqual([
      "계좌 7: 보유 목록이 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음 (직전 스냅샷 뒤 미국 종목을 샀음)",
    ]);
    // 다른 종목은 목록에 있는데 산 종목만 없음 → 'vanished'
    const nvda = { ...soxl, code: "NVDA", name: "NVDA", quantity: 1, purchaseAmount: 180 };
    expect(snapshotDoubts("US", one, { held: [3], holdings: before, traded: { "3:NVDA": 1 } })).toEqual([
      { kind: "vanished", account: 3, text: "계좌 3: 직전 스냅샷 뒤 저장한 매수 체결의 NVDA 1주이(가) 목록에 없음" },
    ]);
    expect(snapshotDoubts("US", [acct(3, [soxl, nvda], { purchaseUsd: 1005.4 })], { held: [3], holdings: before, traded: { "3:NVDA": 1 } })).toEqual([]);
  });

  it("하루 넘게 걸리는 의심(empty·missing-account)만 다음 거래일로 이어 센다", () => {
    expect(doubtCarriesOver("empty")).toBe(true);
    expect(doubtCarriesOver("missing-account")).toBe(true);
    expect(doubtCarriesOver("sum")).toBe(false);
    expect(doubtCarriesOver("unsure")).toBe(false);
    expect(doubtCarriesOver("vanished")).toBe(false);
  });

  it("종목 매입금액 합계가 계좌 요약과 반올림 차이(종목 수 × 1원·1센트)보다 크게 다르면 'sum' — 요약의 1% 보다 작은 종목이 빠져도 잡는다", () => {
    const items = accounts[0]!.items; // 삼성전자 700,000원 + SOXL $825.4
    expect(snapshotDoubts("US", [acct(3, items, { purchaseKrw: 700000, purchaseUsd: 825.4 + 750 })])).toEqual([
      { kind: "sum", account: 3, text: "계좌 3: 미국 종목 매입금액 합계 $825.4 ≠ 계좌 요약 $1575.4" },
    ]);
    expect(snapshotDoubts("US", [acct(3, items, { purchaseKrw: 700000, purchaseUsd: 825.41 })])).toEqual([]); // 1종목 × 1센트
    expect(snapshotDoubts("US", [acct(3, items, { purchaseKrw: 700000, purchaseUsd: 825.45 })]).map((d) => d.kind)).toEqual(["sum"]); // 예전 1% 에서는 넘어갔다
    expect(snapshotDoubts("KR", [acct(3, items, { purchaseKrw: 2_792_995, purchaseUsd: 825.4 })]).map((d) => d.kind)).toEqual(["sum"]);
    expect(snapshotDoubts("KR", [acct(3, items, { purchaseKrw: 700_001, purchaseUsd: 825.4 })])).toEqual([]); // 1종목 × 1원
    expect(snapshotDoubts("KR", [acct(3, items, { purchaseKrw: 700_004, purchaseUsd: 825.4 })]).map((d) => d.kind)).toEqual(["sum"]);
    // 종목이 많으면 그만큼 (3종목 × 1센트)
    const three = [0.1, 0.2, 0.3].map((q, i) => ({ ...items[1]!, code: ["SOXL", "TSLA", "AAPL"][i]!, purchaseAmount: 100 + q }));
    expect(snapshotDoubts("US", [acct(3, three, { purchaseUsd: 300.6 + 0.03 })])).toEqual([]);
    expect(snapshotDoubts("US", [acct(3, three, { purchaseUsd: 300.6 + 0.05 })]).map((d) => d.kind)).toEqual(["sum"]);
    // 종목 매입금액을 모르면 맞춰 볼 수 없어 넘긴다
    expect(snapshotDoubts("US", [acct(3, [{ ...items[1]!, purchaseAmount: null }], { purchaseUsd: 9999 })])).toEqual([]);
  });

  it("받아들이기 기준은 토스 동기화와 같다: unsure 30분, 목록이 비었거나 계좌가 빠진 것은 24시간", () => {
    expect(DOUBT_ACCEPT_MS.unsure).toBe(UNSURE_MS);
    expect(DOUBT_ACCEPT_MS.empty).toBe(DOUBT_MS);
    expect(DOUBT_ACCEPT_MS["missing-account"]).toBe(DOUBT_MS);
    expect(DOUBT_ACCEPT_MS.sum).toBe(30 * 60_000);
    expect(DOUBT_ACCEPT_MS.vanished).toBe(30 * 60_000);
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

  it("의심을 안고 저장된 스냅샷은 그 계좌만 끝점에서 빼고 앞뒤 스냅샷끼리 비교한다 — 가짜 −x·+x 두 줄이 없다", () => {
    const snaps = [
      snap("2026-09-28", "2026-09-29T05:05:00+09:00", [[3, "SOXL", 10, 33], [3, "TSLA", 2, 300], [7, "NVDA", 1, 100]]),
      // 계좌 3 의 TSLA 가 빠진 응답을 의심을 안고 저장 (계좌 7 은 믿을 수 있음 — NVDA 1 → 3 은 계좌 7 의 진짜 변화)
      { ...snap("2026-09-29", "2026-09-30T05:05:00+09:00", [[3, "SOXL", 10, 33], [7, "NVDA", 3, 100]]), doubtAccounts: [3] },
      snap("2026-09-30", "2026-10-01T05:05:00+09:00", [[3, "SOXL", 10, 33], [3, "TSLA", 2, 300], [7, "NVDA", 3, 100]]),
    ];
    const out = unexplainedChanges(snaps, []);
    expect(out.map((c) => [c.account, c.code, c.fromDate, c.toDate, c.unexplainedQty])).toEqual([[7, "NVDA", "2026-09-28", "2026-09-29", 2]]);
    // 예전처럼 끝점으로 쓰면 TSLA −2(9/28→9/29)·+2(9/29→9/30) 두 줄이 나온다
    const naive = unexplainedChanges(snaps.map((s) => ({ ...s, doubtAccounts: [] })), []);
    expect(naive.filter((c) => c.code === "TSLA").map((c) => c.unexplainedQty)).toEqual([-2, 2]);
  });

  it("며칠에 걸친 부분 체결은 받을 때마다 늘어난 몫(fills)으로 나눠 센다 — 마지막 체결 시각에 한꺼번에 넣지 않는다", () => {
    const snaps = [
      snap("2026-09-28", "2026-09-29T05:05:00+09:00", [[3, "SOXL", 10, 33]]),
      snap("2026-09-29", "2026-09-30T05:05:00+09:00", [[3, "SOXL", 13, 33]]),
      snap("2026-09-30", "2026-10-01T05:05:00+09:00", [[3, "SOXL", 15, 33]]),
    ];
    // 한 주문: 9/29 밤 3주, 9/30 밤 2주 (누적 5주, 마지막 체결 9/30 23:00)
    const whole = { account: 3, code: "SOXL", side: "BUY" as const, quantity: 5, executedAt: "2026-09-30T23:00:00+09:00" };
    expect(unexplainedChanges(snaps, [whole]).map((c) => [c.toDate, c.unexplainedQty])).toEqual([
      ["2026-09-29", 3],
      ["2026-09-30", -3],
    ]);
    const split = {
      ...whole,
      fills: [
        { quantity: 3, at: "2026-09-29T23:00:00+09:00" },
        { quantity: 2, at: "2026-09-30T23:00:00+09:00" },
      ],
    };
    expect(unexplainedChanges(snaps, [split])).toEqual([]);
  });

  it("스냅샷 뒤 저장한 체결의 순수량 (계좌·종목마다) — 구간 밖 몫은 세지 않는다", () => {
    const t1 = Date.parse("2026-09-29T05:05:00+09:00"), t2 = Date.parse("2026-09-30T05:05:00+09:00");
    const trades = [
      { account: 3, code: "TSLA", side: "SELL" as const, quantity: 2, executedAt: "2026-09-29T23:00:00+09:00" },
      { account: 3, code: "TSLA", side: "BUY" as const, quantity: 1, executedAt: "2026-09-28T23:00:00+09:00" }, // 스냅샷 전
      { account: 7, code: "TSLA", side: "BUY" as const, quantity: 3, executedAt: "2026-09-29T23:30:00+09:00", fills: [{ quantity: 1, at: "2026-09-28T23:30:00+09:00" }, { quantity: 2, at: "2026-09-29T23:30:00+09:00" }] },
    ];
    expect(netTradedBetween(trades, t1, t2)).toEqual({ "3:TSLA": -2, "7:TSLA": 2 });
  });
});
