import { describe, expect, it } from "vitest";
import { REASONS, replayPair, tossCosts, type LedgerAnchor, type LedgerFill } from "../src/services/journalCalc.js";

/**
 * 매매일지 원장 (3-37, 플래그 tradeJournal) — 이동평균법 실현손익. 순수 함수, 고정 값, 네트워크 없음.
 * 숫자는 설계안 §3.1·§3.4 의 손계산 예시 그대로다 (예시 값 — 실제 계좌와 무관)
 */

let seq = 0;
const fill = (over: Partial<LedgerFill> & Pick<LedgerFill, "side" | "quantity" | "amount" | "at">): LedgerFill => {
  seq++;
  const orderId = over.orderId ?? `o${seq}`;
  return {
    key: `${over.account ?? 3}:${orderId}:0`,
    account: 3,
    orderId,
    code: "SOXL",
    basis: "filled",
    orderQuantity: over.quantity,
    orderCosts: null,
    seq,
    ...over,
  };
};
const anchor = (over: Partial<LedgerAnchor> & Pick<LedgerAnchor, "asOf" | "quantity" | "cost">): LedgerAnchor => ({
  date: over.asOf.slice(0, 10),
  costKrw: null,
  costKrwEstimated: false,
  costRatio: null,
  ...over,
});

describe("이동평균법 실현손익 (토스증권 방식)", () => {
  it("10@100 + 10@120 뒤 5주를 130 에 팔면 실현손익 +100, 남은 평균 110 (설계 §9-1)", () => {
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T10:00:00+09:00", code: "005930" }),
      fill({ side: "BUY", quantity: 10, amount: 1200, at: "2026-09-02T10:00:00+09:00", code: "005930" }),
      fill({ side: "SELL", quantity: 5, amount: 650, at: "2026-09-03T10:00:00+09:00", code: "005930" }),
    ];
    const r = replayPair(f, [], { currency: "KRW" });
    const sell = r.fills.get(f[2]!.key)!.realized!;
    expect(sell).toMatchObject({ status: "ok", basis: "history-only", gross: 100, avgCost: 110, costAmount: 550 });
    expect(sell.rate).toBeCloseTo(18.18, 2);
    expect(r.holding).toEqual({ quantity: 15, avgCost: 110 });
    // 매수 상세: '이 매수 뒤 평균 구매가'
    expect(r.fills.get(f[1]!.key)!.afterBuy).toEqual({ avgCost: 110, quantity: 20 });
  });

  it("SOXL 손계산 (§3.1·§3.4): +$17.43 (+10.25%), 원화 약 +24,703원 — 매수 환율로 쌓은 원화 평균 구매가 기준", () => {
    const fx: Record<string, number> = { "2026-09-01T23:00:00+09:00": 1390, "2026-09-23T23:00:00+09:00": 1385, "2026-09-25T23:10:00+09:00": 1389.4 };
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 320.4, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "BUY", quantity: 20, amount: 700, at: "2026-09-23T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 5, amount: 187.5, at: "2026-09-25T23:10:00+09:00" }),
    ];
    const r = replayPair(f, [], { currency: "USD", fxAt: (at) => fx[at] ?? null });
    const s = r.fills.get(f[2]!.key)!.realized!;
    expect(s.gross).toBe(17.43);
    expect(s.rate).toBe(10.25);
    expect(s.costAmount).toBe(170.07);
    expect(s.avgCost).toBeCloseTo(34.0133, 4);
    expect(s.krw).toMatchObject({ gross: 24703, sellFx: 1389.4, fxSource: "toss", reason: null });
    expect(s.krw!.costKrw).toBe(235809);
    // 남은 25주 매입금액 $850.3333 — 평균 그대로
    expect(r.holding.quantity).toBe(25);
    expect(r.holding.avgCost).toBeCloseTo(34.0133, 4);
  });

  it("기준점(스냅샷)에서 출발: 토스 매입금액/수량으로 이어 계산하고 basis 'snapshot' (§9-3)", () => {
    const a = anchor({ asOf: "2026-09-28T05:05:00+09:00", date: "2026-09-25", quantity: 25, cost: 825.4 });
    const f = [fill({ side: "SELL", quantity: 5, amount: 190, at: "2026-09-28T23:30:00+09:00" })];
    const s = replayPair(f, [a], { currency: "USD" }).fills.get(f[0]!.key)!.realized!;
    // 평균 33.016 → 원가 165.08 → +24.92
    expect(s).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2026-09-25", gross: 24.92, costAmount: 165.08 });
  });

  it("며칠에 걸친 부분 체결은 몫마다 한 줄 — 실현손익 합이 한 번에 판 것과 같다 (§9-4)", () => {
    const a = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1_000_000, date: "2026-09-25" });
    const one = [fill({ side: "SELL", quantity: 6, amount: 720_000, at: "2026-09-28T10:00:00+09:00", code: "005930" })];
    const split = [
      fill({ side: "SELL", quantity: 2, amount: 240_000, at: "2026-09-28T10:00:00+09:00", code: "005930", orderId: "p", orderQuantity: 6 }),
      fill({ side: "SELL", quantity: 4, amount: 480_000, at: "2026-09-29T10:00:00+09:00", code: "005930", orderId: "p", orderQuantity: 6 }),
    ];
    split[1]!.key = "3:p:1";
    const whole = replayPair(one, [a], { currency: "KRW" }).fills.get(one[0]!.key)!.realized!.gross!;
    const parts = replayPair(split, [a], { currency: "KRW" });
    const sum = split.reduce((s, x) => s + parts.fills.get(x.key)!.realized!.gross!, 0);
    expect(whole).toBe(120_000);
    expect(sum).toBe(whole);
  });

  it("소수 주식: 0.123456주를 사서 전부 팔면 수량 0·매입금액 0 으로 딱 떨어진다 — 마지막 매도는 남은 매입금액 전부가 원가 (§9-5, BH-48)", () => {
    const f = [
      fill({ side: "BUY", quantity: 0.123456, amount: 25.17, at: "2026-09-10T23:00:00+09:00", code: "NVDA" }),
      fill({ side: "BUY", quantity: 16, amount: 3200, at: "2026-09-11T23:00:00+09:00", code: "NVDA" }),
      fill({ side: "SELL", quantity: 16.123456, amount: 3500, at: "2026-09-12T23:00:00+09:00", code: "NVDA" }),
    ];
    const r = replayPair(f, [], { currency: "USD" });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ costAmount: 3225.17, gross: 274.83 });
    expect(r.holding).toEqual({ quantity: 0, avgCost: null });
  });

  it("다른 종목이 남은 계좌의 16.123444주: 여섯째 자리까지 맞춰 나머지 0.000012주가 남지 않게 판다", () => {
    const f = [
      fill({ side: "BUY", quantity: 16.123444, amount: 1612.34, at: "2026-09-10T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 10, amount: 1200, at: "2026-09-11T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 6.123444, amount: 700, at: "2026-09-12T23:00:00+09:00" }),
    ];
    const r = replayPair(f, [], { currency: "USD" });
    expect(r.holding.quantity).toBe(0);
    const g = (i: number) => r.fills.get(f[i]!.key)!.realized!;
    expect(g(1).costAmount! + g(2).costAmount!).toBeCloseTo(1612.34, 2);
  });
});

describe("같은 날 사고팔기 순서", () => {
  const a = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1_000_000 });

  it("모두 체결 시각(filled)이면 시각 순서대로 — 꼬리표 없음 (§9-6)", () => {
    const f = [
      fill({ side: "SELL", quantity: 5, amount: 600_000, at: "2026-09-28T09:10:00+09:00", code: "005930" }),
      fill({ side: "BUY", quantity: 10, amount: 1_400_000, at: "2026-09-28T10:00:00+09:00", code: "005930" }),
    ];
    const s = replayPair(f, [a], { currency: "KRW" }).fills.get(f[0]!.key)!.realized!;
    expect(s).toMatchObject({ status: "ok", gross: 100_000 });
  });

  it("'seen' 시각이 섞여 순서를 모르면 매수 먼저·매도 먼저로 계산하고, 값이 다를 때만 매수 먼저 값 + 'order-uncertain'", () => {
    const f = [
      fill({ side: "SELL", quantity: 5, amount: 600_000, at: "2026-09-28T09:10:00+09:00", code: "005930" }),
      fill({ side: "BUY", quantity: 10, amount: 1_400_000, at: "2026-09-28T16:05:00+09:00", code: "005930", basis: "seen" }),
    ];
    const s = replayPair(f, [a], { currency: "KRW" }).fills.get(f[0]!.key)!.realized!;
    // 매수 먼저: 평균 (1,000,000 + 1,400,000) / 20 = 120,000 → 600,000 − 600,000 = 0 · 매도 먼저: +100,000 → 다름
    expect(s).toMatchObject({ status: "order-uncertain", gross: 0, reason: REASONS.orderUncertain });
  });

  it("순서를 바꿔도 값이 같으면(같은 값에 사고팜) 꼬리표 없음", () => {
    const f = [
      fill({ side: "SELL", quantity: 5, amount: 500_000, at: "2026-09-28T09:10:00+09:00", code: "005930" }),
      fill({ side: "BUY", quantity: 10, amount: 1_000_000, at: "2026-09-28T16:05:00+09:00", code: "005930", basis: "seen" }),
    ];
    expect(replayPair(f, [a], { currency: "KRW" }).fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: 0 });
  });
});


describe("기록 시작 전 매도 — 언제 '안다'고 할지", () => {
  it("전체 주문 내역이 첫 스냅샷과 맞으면 그 전 매도도 계산 ('history-checked') / 평균이 1원 넘게 다르면 그해 확인 필요 (§9-8)", () => {
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 700_000, at: "2026-09-01T10:00:00+09:00", code: "005930" }),
      fill({ side: "SELL", quantity: 4, amount: 300_000, at: "2026-09-02T10:00:00+09:00", code: "005930" }),
    ];
    const ok = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 6, cost: 420_000 });
    const r = replayPair(f, [ok], { currency: "KRW" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "history-checked", anchorDate: "2026-09-28", gross: 20_000 });
    expect(r.check.preAnchor).toBe("checked");
    // 스냅샷 평균이 70,002원(1원 넘게 다름) → 첫 기록 전 주문 내역이 첫 기록과 맞지 않음 → 그해 확인 필요
    const off = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 6, cost: 420_012 });
    expect(replayPair(f, [off], { currency: "KRW" }).fills.get(f[1]!.key)!.realized).toMatchObject({ status: "unexplained", reason: REASONS.needsCheck, gross: null, change: "첫 기록(9월 28일 6주) 전 주문 내역이 그 기록과 맞지 않아요" });
    // 1원 안(반올림)이면 맞는 것으로
    const round = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 6, cost: 420_004 });
    expect(replayPair(f, [round], { currency: "KRW" }).fills.get(f[1]!.key)!.realized!.status).toBe("ok");
  });
});

// ── 검토 반영 10차: 종목·해 보수 규칙 — 그해 그 종목에 기록으로 설명되지 않는 일이 하나라도 있으면 그해 그 종목의 모든 매도는 '확인 필요' ──

/** 확인 필요 매도: 손익 숫자 없음 */
const needs = { status: "unexplained", reason: REASONS.needsCheck, gross: null, rate: null, avgCost: null, costAmount: null, net: null, krw: null };
const kst = (d: string, hm = "16:05") => `${d}T${hm}:00+09:00`;
const kr = (side: "BUY" | "SELL", quantity: number, amount: number, day: string, hm = "10:00", basis: LedgerFill["basis"] = "filled") => fill({ side, quantity, amount, at: kst(day, hm), code: "005930", basis });
const krA = (date: string, quantity: number, cost: number | null, price: number | null = null) => anchor({ asOf: kst(date), date, quantity, cost, price });
/** 미국 기록: 뉴욕 date 의 다음 날 한국 05:05 */
const usA = (date: string, quantity: number, cost: number | null, price: number | null = null) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return anchor({ asOf: `${d.toISOString().slice(0, 10)}T05:05:00+09:00`, date, quantity, cost, price });
};
/** 미국 체결: 뉴욕 date 의 정규장 (한국 23:40) */
const us = (side: "BUY" | "SELL", quantity: number, amount: number, day: string, hm = "23:40", basis: LedgerFill["basis"] = "filled") => fill({ side, quantity, amount, at: kst(day, hm), basis });
const USD = { currency: "USD" as const, stdAt: () => 1350 };
const KRW = { currency: "KRW" as const };

describe("검토 반영 10차 — 종목·해 규칙: 그해 확인 필요가 되는 일", () => {
  it("① 기록된 체결로 설명되지 않는 구간(1→4 분할 + 사이 매도): 그해 그 종목의 매도는 모두 확인 필요(분할 뒤 매도도), 다음 해는 토스 기록에서 보통 계산", () => {
    const a1 = krA("2026-10-06", 10, 1_000_000);
    const a2 = krA("2026-10-07", 36, 900_000);
    const a3 = krA("2027-03-02", 34, 850_000);
    const f = [kr("SELL", 1, 130_000, "2026-10-07", "09:30"), kr("SELL", 2, 52_000, "2026-11-02"), kr("SELL", 6, 180_000, "2027-03-03")];
    const r = replayPair(f, [a1, a2, a3], KRW);
    const text = "수량 10 → 36주 · 기록된 매매대로라면 9주";
    const guess = "1→4 분할로 보여요(추정)";
    for (const x of f.slice(0, 2)) expect(r.fills.get(x.key)!.realized).toMatchObject({ ...needs, change: `10월 7일 기록: ${text}`, guess });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2027-03-02", avgCost: 25_000, costAmount: 150_000, gross: 30_000, rate: 20 });
    expect(r.changes).toEqual([{ at: a2.asOf, date: "2026-10-07", fromDate: "2026-10-06", kind: "unexplained", fromQty: 10, toQty: 36, expectedQty: 9, text, guess }]);
    // 수익률: 2026 에 걸친 이 종목의 기록 구간은 모두 건너뜀 (2027 구간은 그대로)
    expect(r.skips).toEqual([{ from: a1.asOf, to: a3.asOf }]);
    expect(r.check).toMatchObject({ unexplained: 1, priceJumps: 0, doubtYears: [2026] });
    expect(r.holding).toEqual({ quantity: 28, avgCost: 25_000 });
  });

  it("① 주문 없이 들어온 주식(10 → 20주, 매도 없음): 그 뒤 같은 해 매도도 확인 필요 (예전: 토스 평균에서 −5,000 'ok')", () => {
    const a1 = krA("2026-10-06", 10, 1_000_000);
    const a2 = krA("2026-10-07", 20, 2_300_000);
    const f = [kr("SELL", 1, 110_000, "2026-10-08")];
    const r = replayPair(f, [a1, a2], KRW);
    expect(r.changes).toEqual([{ at: a2.asOf, date: "2026-10-07", fromDate: "2026-10-06", kind: "unexplained", fromQty: 10, toQty: 20, expectedQty: 10, text: "수량 10 → 20주 · 그 사이 기록된 매매 없음", guess: null }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...needs, change: "10월 7일 기록: 수량 10 → 20주 · 그 사이 기록된 매매 없음", guess: null });
    expect(r.skips).toEqual([{ from: a1.asOf, to: null }]);
  });

  it("① 수량이 같고 매입금액 차이가 0.5% 안이면 설명된 것(토스 값으로 맞춤, 점검에 drift) · 0.5% 넘으면 그해 확인 필요 (이 매수 뒤 평균도 없음)", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", quantity: 20, cost: 2002 });
    const f = [fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-28T01:00:00+09:00" })];
    const r = replayPair(f, [a1, a2], { currency: "USD" });
    expect(r.changes).toEqual([]);
    expect(r.skips).toEqual([]);
    expect(r.check).toMatchObject({ drift: 1, doubtYears: [] });
    expect(r.holding.avgCost).toBeCloseTo(100.1, 6);
    expect(r.fills.get(f[0]!.key)!.afterBuy).toEqual({ avgCost: 100, quantity: 20 });
    const far = replayPair(f, [a1, anchor({ ...a2, cost: 2012 })], { currency: "USD" });
    expect(far.changes).toMatchObject([{ kind: "unexplained", text: "토스 매입금액 $2,012.00 · 기록된 매매대로라면 $2,000.00 (수량 20주는 같아요)" }]);
    expect(far.fills.get(f[0]!.key)!.afterBuy).toBeNull();
    expect(far.check.doubtYears).toEqual([2026]);
  });

  it("② 한 구간 주가가 ±25% 넘게 바뀜 (한국·미국 같게): 그해 확인 필요, ±25% 안은 그대로 · 마지막 기록 뒤 체결 가격도 본다", () => {
    const run = (p: number) => {
      const f = [kr("SELL", 100, 100 * p, "2026-10-08")];
      return { f, r: replayPair(f, [krA("2026-10-06", 1000, 1_000_000, 1000), krA("2026-10-07", 1000, 1_000_000, p)], KRW) };
    };
    const down = run(740);
    const text = "주가 1,000원 → 740원 (−26%) · 주식 수 1,000주 그대로";
    expect(down.r.fills.get(down.f[0]!.key)!.realized).toMatchObject({ ...needs, change: `10월 7일 기록: ${text}` });
    expect(down.r.changes).toEqual([{ at: kst("2026-10-07"), date: "2026-10-07", fromDate: "2026-10-06", kind: "possible-action", fromQty: 1000, toQty: 1000, expectedQty: 1000, text, guess: null }]);
    expect(down.r.check).toMatchObject({ unexplained: 0, priceJumps: 1, doubtYears: [2026] });
    const small = run(760);
    expect(small.r.fills.get(small.f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: -24_000 });
    expect(small.r.check.doubtYears).toEqual([]);
    // 미국도 ±25% ($100 → $74 확인 필요 · $76 그대로 — 예전 ±60% 는 −55% 도 보통으로 봤음)
    const usRun = (p: number) => replayPair([], [usA("2026-10-06", 10, 1000, 100), usA("2026-10-07", 10, 1000, p)], { currency: "USD" });
    expect(usRun(74).changes).toMatchObject([{ kind: "possible-action", text: "주가 $100.00 → $74.00 (−26%) · 주식 수 10주 그대로" }]);
    expect(usRun(74).skips).toEqual([{ from: usA("2026-10-06", 0, 0).asOf, to: null }]);
    expect(usRun(76).check.doubtYears).toEqual([]);
    // 마지막 기록 뒤 체결 가격: 직전 기록 주가 1,000원에서 −26% 면 확인 필요, −20% 면 그대로
    const cheap = [kr("SELL", 100, 74_000, "2026-10-07")];
    expect(replayPair(cheap, [krA("2026-10-06", 1000, 1_000_000, 1000)], KRW).fills.get(cheap[0]!.key)!.realized).toMatchObject({ ...needs, change: "10월 7일 매도 가격 740원 · 직전 기록 주가 1,000원보다 −26%" });
    const fair = [kr("SELL", 100, 80_000, "2026-10-07")];
    expect(replayPair(fair, [krA("2026-10-06", 1000, 1_000_000, 1000)], KRW).fills.get(fair[0]!.key)!.realized).toMatchObject({ status: "ok", gross: -20_000 });
  });

  it("② 3거래일 넘게 걸친 구간은 ±20% (10/12 → 10/16 −22% 확인 필요 · 10/12 → 10/15 −22% 는 그대로)", () => {
    const long = replayPair([], [krA("2026-10-12", 1000, 1_000_000, 1000), krA("2026-10-16", 1000, 1_000_000, 780)], KRW);
    expect(long.changes).toMatchObject([{ kind: "possible-action", text: "주가 1,000원 → 780원 (−22%) · 주식 수 1,000주 그대로" }]);
    expect(long.check.doubtYears).toEqual([2026]);
    const short = replayPair([], [krA("2026-10-12", 1000, 1_000_000, 1000), krA("2026-10-15", 1000, 1_000_000, 780)], KRW);
    expect(short.changes).toEqual([]);
    expect(short.check.doubtYears).toEqual([]);
  });

  it("③ 주가가 흔한 비율(주식배당 ×1.05 → −4.8%)만큼 바뀐 뒤 30일 안에 주문 없이 주식 수가 바뀌면: 그 까닭도 적고 이름표 · 주식 수가 그대로면 그대로", () => {
    const base = [krA("2026-10-12", 1000, 1_000_000, 1000), krA("2026-10-13", 1000, 1_000_000, 952)];
    const f = [kr("SELL", 50, 47_500, "2026-10-21")];
    const r = replayPair(f, [...base, krA("2026-10-20", 1050, 1_000_000, 950)], KRW);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({
      ...needs,
      change: "10월 13일 기록: 주가 1,000원 → 952원 (−4.8%) · 그 구간이나 30일 안에 주문 없이 주식 수가 바뀌었어요 / 10월 20일 기록: 수량 1,000 → 1,050주 · 그 사이 기록된 매매 없음",
      guess: "무상증자·주식배당(주식 수 ×1.05)일 수 있어요(추정)",
    });
    const plain = replayPair(f, [...base, krA("2026-10-20", 1000, 1_000_000, 950)], KRW);
    expect(plain.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: -2_500 });
    expect(plain.check.doubtYears).toEqual([]);
  });

  it("④ 이 종목을 0주까지 판 뒤 30일 안에 같은 계좌에 다른 종목이 주문 없이 들어오면(분사 모양 — 크기와 상관없이) 확인 필요 · 판 것보다 먼저 들어왔거나 30일 넘게 뒤면 그대로", () => {
    const a = usA("2026-10-06", 1000, 100_000, 100);
    const z = usA("2026-10-07", 0, 0);
    const f = [us("BUY", 1000, 100_000, "2026-09-01"), us("SELL", 1000, 80_000, "2026-10-07", "23:30")];
    const run = (arrivals: Array<{ from: string; to: string | null }>) => replayPair(f, [a, z], { ...USD, arrivals });
    const text = "10월 7일 모두 판 뒤 30일 안에 같은 계좌에 다른 종목이 주문 없이 들어왔어요(분사 등일 수 있어요)";
    const r = run([{ from: a.asOf, to: z.asOf }]);
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ ...needs, change: text });
    expect(r.fills.get(f[1]!.key)!.std).toEqual({ proceeds: 108_000_000, cost: null, missing: "unexplained" });
    expect(r.skips).toEqual([{ from: a.asOf, to: z.asOf }]);
    // 30일 안 (다음 달 초) · 마지막 기록 뒤(뒤 기록 없음)
    expect(run([{ from: "2026-11-02T05:05:00+09:00", to: "2026-11-03T05:05:00+09:00" }]).fills.get(f[1]!.key)!.realized).toMatchObject(needs);
    expect(run([{ from: z.asOf, to: null }]).fills.get(f[1]!.key)!.realized).toMatchObject(needs);
    // 판 것보다 먼저 들어옴 · 30일 넘게 뒤 · 아무것도 들어오지 않음 → 보통 계산 (−$20,000)
    for (const arr of [[{ from: "2026-10-01T05:05:00+09:00", to: "2026-10-02T05:05:00+09:00" }], [{ from: "2026-11-20T05:05:00+09:00", to: "2026-11-21T05:05:00+09:00" }], []])
      expect(run(arr).fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", gross: -20_000 });
    // 0주가 되지 않았으면(반만 팖) 들어온 종목과 상관없음
    const half = [f[0]!, us("SELL", 500, 40_000, "2026-10-07", "23:30")];
    const h = replayPair(half, [a, usA("2026-10-07", 500, 50_000, 80)], { ...USD, arrivals: [{ from: a.asOf, to: z.asOf }] });
    expect(h.fills.get(half[1]!.key)!.realized).toMatchObject({ status: "ok", gross: -10_000 });
  });

  it("④ 검토 반영 12차: 모두 판 매도와 다시 산 매수의 순서를 모르면 어느 순서로든 0주가 될 수 있었던 매도를 0주까지 판 매도로 본다 · 순서를 알고 0주가 되지 않았거나 들어온 종목이 없으면 그대로", () => {
    const a = usA("2026-10-12", 1000, 100_000, 100);
    const b = usA("2026-10-13", 10, 800, 80);
    const arrivals = [{ from: a.asOf, to: b.asOf }];
    const text = "10월 13일 모두 판 뒤 30일 안에 같은 계좌에 다른 종목이 주문 없이 들어왔어요(분사 등일 수 있어요)";
    const buy = us("BUY", 1000, 100_000, "2026-09-01");
    const sell = us("SELL", 1000, 80_000, "2026-10-13", "23:30");
    // 주문 시각만 있는 다시 사기(22:40): 저장 순서로는 1,010주 → 10주지만 매도 먼저면 0주 → 확인 필요 (까닭 문장은 그 매도 날)
    const ordered = [buy, sell, us("BUY", 10, 800, "2026-10-13", "22:40", "ordered")];
    expect(replayPair(ordered, [a, b], { ...USD, arrivals }).fills.get(sell.key)!.realized).toMatchObject({ ...needs, change: text });
    // 들어온 종목이 없으면 예전 그대로 (매도 먼저만 뒤 기록과 맞음 → '순서 추정' −$20,000)
    expect(replayPair(ordered, [a, b], USD).fills.get(sell.key)!.realized).toMatchObject({ status: "order-uncertain", gross: -20_000 });
    // 다시 산 매수가 22:40 에 체결(순서를 앎 — 0주가 된 적 없음, 뒤 기록은 이동평균으로 남은 10주 $998.02): 들어온 종목이 있어도 ④ 아님
    const known = [buy, sell, us("BUY", 10, 800, "2026-10-13", "22:40")];
    const r = replayPair(known, [a, usA("2026-10-13", 10, 998.02, 80)], { ...USD, arrivals });
    expect(r.fills.get(sell.key)!.realized).toMatchObject({ status: "ok", gross: -19_801.98 });
    expect(r.check.doubtYears).toEqual([]);
  });

  it("④ 첫 기록 전 증거(검토 반영 11차 — 들어온 때의 하한을 모름, from null): 증거(산 기록 없이 판 매도 · 첫 기록의 주문 없는 수량) 전에 0주까지 판 매도는 언제였든 확인 필요 · 증거보다 뒤에 판 것은 그대로", () => {
    const f = [us("BUY", 1000, 100_000, "2025-03-03"), us("SELL", 1000, 80_000, "2025-06-02")];
    const first = usA("2026-09-25", 0, 0);
    const run = (arrivals: Array<{ from: string | null; to: string | null }>) => replayPair(f, [first], { ...USD, arrivals }).fills.get(f[1]!.key)!.realized;
    // 신설회사를 산 기록 없이 6/10 에 팖 (PS1) · 첫 기록에 주문 없이 있음 (PS2) · 기록이 한 번도 없는 짝 (PS3)
    expect(run([{ from: null, to: kst("2025-06-10", "23:40") }])).toMatchObject({ ...needs, change: "6월 2일 모두 판 뒤 30일 안에 같은 계좌에 다른 종목이 주문 없이 들어왔어요(분사 등일 수 있어요)" });
    expect(run([{ from: null, to: first.asOf }])).toMatchObject(needs);
    expect(replayPair(f, [], { ...USD, arrivals: [{ from: null, to: kst("2025-06-10", "23:40") }] }).fills.get(f[1]!.key)!.realized).toMatchObject(needs);
    // 판 것보다 확실히 먼저 들어옴 · 아무것도 들어오지 않음 → 보통 계산
    expect(run([{ from: null, to: kst("2025-05-01", "23:40") }])).toMatchObject({ status: "ok", basis: "history-checked", gross: -20_000 });
    expect(run([])).toMatchObject({ status: "ok", basis: "history-checked", gross: -20_000 });
  });

  it("⑤ 첫 기록 전 매도가 있는데 그 전 주문 내역이 첫 기록을 그대로 만들지 못하면: 그해 그 종목의 매도는 모두 확인 필요 (첫 기록 뒤 매도도) · 다른 해는 그대로", () => {
    const first = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1000 });
    // 같은 해: 5주 사고 8주 판 기록 (앞부분 기록 없음) → 9/29 매도도 확인 필요 (예전: 토스 평균에서 +50 'ok')
    const same = [fill({ side: "BUY", quantity: 5, amount: 500, at: "2026-09-10T23:00:00+09:00" }), fill({ side: "SELL", quantity: 8, amount: 900, at: "2026-09-11T23:00:00+09:00" }), fill({ side: "SELL", quantity: 2, amount: 250, at: "2026-09-29T23:00:00+09:00" })];
    const r = replayPair(same, [first], { currency: "USD" });
    const text = "첫 기록(9월 25일 10주) 전 주문 내역이 그 기록과 맞지 않아요";
    for (const x of same.slice(1)) expect(r.fills.get(x.key)!.realized).toMatchObject({ ...needs, change: text });
    expect(r.fills.get(same[0]!.key)!.afterBuy).toBeNull();
    expect(r.check).toMatchObject({ preAnchor: "mismatch", doubtYears: [2026] });
    // 다른 해: 2025 매도만 확인 필요, 2026 매도는 첫 기록의 토스 평균에서 +50
    const split = [fill({ side: "BUY", quantity: 5, amount: 500, at: "2025-03-10T23:00:00+09:00" }), fill({ side: "SELL", quantity: 8, amount: 900, at: "2025-06-11T23:00:00+09:00" }), fill({ side: "SELL", quantity: 2, amount: 250, at: "2026-09-29T23:00:00+09:00" })];
    const r2 = replayPair(split, [first], { currency: "USD" });
    expect(r2.fills.get(split[1]!.key)!.realized).toMatchObject({ ...needs, change: text });
    expect(r2.fills.get(split[2]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", gross: 50 });
    expect(r2.check.doubtYears).toEqual([2025]);
  });

  it("⑤ 기록이 한 번도 없는 짝: 0주에서 음수 없이 돌면 'history-only', 가진 것보다 많이 판 매도가 있으면 그해 확인 필요 (§9-9)", () => {
    const f = [fill({ side: "BUY", quantity: 3, amount: 300, at: "2026-08-01T23:00:00+09:00", code: "AMD" }), fill({ side: "SELL", quantity: 3, amount: 360, at: "2026-08-02T23:00:00+09:00", code: "AMD" })];
    const r = replayPair(f, [], { currency: "USD" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "history-only", gross: 60 });
    expect(r.check.preAnchor).toBe("history-only");
    const g = [fill({ side: "SELL", quantity: 3, amount: 360, at: "2026-08-02T23:00:00+09:00", code: "AMD" })];
    expect(replayPair(g, [], { currency: "USD" }).fills.get(g[0]!.key)!.realized).toMatchObject({ ...needs, change: "주문 내역에 그때 가진 수량보다 많이 판 매도가 있어요" });
  });

  it("해가 바뀌는 앞뒤 30일: 1월 12일에 주문 없이 들어온 주식은 앞 해 12월 매도도 확인 필요 · 3월이면 앞 해는 그대로 · 12월 말 일은 다음 해 전체", () => {
    const sell = kr("SELL", 1, 110_000, "2026-12-28");
    const run = (d1: string, d2: string) => replayPair([sell], [krA("2026-12-21", 10, 1_000_000), krA("2026-12-22", 10, 1_000_000), krA(d1, 9, 900_000), krA(d2, 19, 1_900_000)], KRW);
    const jan = run("2027-01-11", "2027-01-12");
    expect(jan.fills.get(sell.key)!.realized).toMatchObject({ ...needs, change: "1월 12일 기록: 수량 9 → 19주 · 그 사이 기록된 매매 없음" });
    expect(jan.check.doubtYears).toEqual([2026, 2027]);
    const mar = run("2027-02-26", "2027-03-02");
    expect(mar.fills.get(sell.key)!.realized).toMatchObject({ status: "ok", gross: 10_000 });
    expect(mar.check.doubtYears).toEqual([2027]);
    // 12월 22일에 들어온 주식 → 다음 해 1월 · 2월 매도도 확인 필요
    const late = [kr("SELL", 1, 110_000, "2027-01-05"), kr("SELL", 1, 110_000, "2027-02-15")];
    const r = replayPair(late, [krA("2026-12-21", 10, 1_000_000), krA("2026-12-22", 20, 2_000_000)], KRW);
    for (const x of late) expect(r.fills.get(x.key)!.realized).toMatchObject(needs);
  });

  it("TSLA: 2025 에 사고 모두 판 기록은 2026 에 주문 없이 주식이 들어와도 2025 몫은 그대로 계산 (실현손익·원화·결제일 원화) — 2026 매도만 확인 필요", () => {
    const f = [us("BUY", 10, 2000, "2025-03-03"), us("SELL", 10, 2500, "2025-06-02"), us("SELL", 2, 620, "2026-10-15")];
    const r = replayPair(f, [usA("2026-09-25", 0, 0), usA("2026-10-14", 5, 1500, 300)], { ...USD, fxAt: () => 1400 });
    const old = r.fills.get(f[1]!.key)!;
    expect(old.realized).toMatchObject({ status: "ok", basis: "history-checked", anchorDate: "2026-09-25", gross: 500, rate: 25, costAmount: 2000 });
    expect(old.realized!.krw).toMatchObject({ gross: 700_000 });
    expect(old.std).toEqual({ proceeds: 3_375_000, cost: 2_700_000, missing: null });
    expect(r.fills.get(f[0]!.key)!.afterBuy).toEqual({ avgCost: 200, quantity: 10 });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject(needs);
    expect(r.fills.get(f[2]!.key)!.std).toEqual({ proceeds: 837_000, cost: null, missing: "unexplained" });
    expect(r.check.doubtYears).toEqual([2026]);
  });

  it("설명되지 않은 해 다음 해: 달러·원화 장부 손익은 토스 기록에서 보통 계산하되 결제일 원화 취득가는 모름 ('changed' — 모두 판 뒤 새로 산 몫부터 다시 앎)", () => {
    const buy = us("BUY", 1000, 100_000, "2026-09-01");
    const b1 = usA("2026-09-25", 1000, 100_000, 100);
    const plain = [buy, us("SELL", 500, 55_000, "2026-09-28")];
    expect(replayPair(plain, [b1], USD).fills.get(plain[1]!.key)!.std).toEqual({ proceeds: 74_250_000, cost: 67_500_000, missing: null });
    const later = us("SELL", 1000, 26_000, "2027-03-03");
    const anchors = [b1, anchor({ ...usA("2026-09-28", 4000, 100_000, 25), costKrw: 139_000_000 }), anchor({ ...usA("2027-03-02", 4000, 100_000, 25), costKrw: 139_000_000 })];
    const r = replayPair([buy, later], anchors, { ...USD, fxAt: () => 1400 });
    const s = r.fills.get(later.key)!;
    expect(s.realized).toMatchObject({ status: "ok", gross: 1_000, costAmount: 25_000, avgCost: 25 });
    expect(s.realized!.krw).toMatchObject({ gross: 1_650_000, costKrw: 34_750_000 });
    expect(s.std).toEqual({ proceeds: 35_100_000, cost: null, missing: "changed" });
    expect(r.check.doubtYears).toEqual([2026]);
  });
});

describe("검토 반영 10차 — 예전에 틀린 숫자를 만들던 경우는 모두 합계에 들 숫자가 없다", () => {
  const a1 = krA("2026-10-12", 1000, 1_000_000, 1000);
  const z2 = krA("2026-10-13", 0, 0);
  const k = (side: "BUY" | "SELL", q: number, a: number, hm = "09:30", day = "2026-10-13", basis: LedgerFill["basis"] = "filled") => kr(side, q, a, day, hm, basis);
  const ua = usA("2026-10-12", 1000, 100_000, 100);
  const uz = usA("2026-10-13", 0, 0);
  const ub = us("BUY", 1000, 100_000, "2026-09-01");
  type Case = { fills: LedgerFill[]; anchors: LedgerAnchor[]; usd?: boolean; arrivals?: Array<{ from: string | null; to: string | null }>; allow?: Record<number, number> };
  const cases: Record<string, () => Case> = {
    // 분할·병합 뒤 같은 구간에 모두 팖 (R1~R4 · N10 · E1)
    "R1 한국 1→4 분할 뒤 4,000주 250원에 모두 팖": () => ({ fills: [k("SELL", 4000, 1_000_000)], anchors: [a1, z2] }),
    "R2 미국 1→4 분할 뒤 모두 팖": () => ({ fills: [ub, us("SELL", 4000, 100_000, "2026-10-13", "23:50")], anchors: [ua, uz], usd: true }),
    "R3 한국 4→1 병합 뒤 250주 4,000원에 모두 팖": () => ({ fills: [k("SELL", 250, 1_000_000)], anchors: [a1, z2] }),
    "R4 1→4 분할 뒤 두 번에 나눠 모두 팖": () => ({ fills: [k("SELL", 2000, 500_000), k("SELL", 2000, 500_000, "10:30")], anchors: [a1, z2] }),
    "N10a 1→4 분할 날 −12.5%": () => ({ fills: [k("SELL", 4000, 875_000)], anchors: [a1, z2] }),
    "N10b 1→4 분할 날 +12%": () => ({ fills: [k("SELL", 4000, 1_120_000)], anchors: [a1, z2] }),
    "N10c 1→2 분할 날 −12%": () => ({ fills: [k("SELL", 2000, 880_000)], anchors: [a1, z2] }),
    "N10d 1→10 분할 날 −10%": () => ({ fills: [k("SELL", 10000, 900_000)], anchors: [a1, z2] }),
    "N10e 1→3 분할 날 −10%": () => ({ fills: [k("SELL", 3000, 900_000)], anchors: [a1, z2] }),
    "E1 미국 1→4 분할 + 출고 700 + 3,300주 매도": () => ({ fills: [ub, us("SELL", 3300, 82_500, "2026-10-13", "23:50")], anchors: [ua, uz], usd: true }),
    // 분할 + 사고팔기 (N1 · N9 · N11)
    "N1a 1→4, 1,000주 팔고 500주 삼": () => ({ fills: [k("SELL", 1000, 250_000), k("BUY", 500, 130_000, "10:00")], anchors: [a1, krA("2026-10-13", 3500, 880_000, 255)] }),
    "N1b 1→4, 500주 사고 1,000주 팖": () => ({ fills: [k("BUY", 500, 130_000, "09:10"), k("SELL", 1000, 250_000)], anchors: [a1, krA("2026-10-13", 3500, 878_889, 255)] }),
    "N1c 1→4, 팔고 사고 다시 모두 팖": () => ({ fills: [k("SELL", 1000, 250_000), k("BUY", 500, 130_000, "10:00"), k("SELL", 3500, 945_000, "11:00")], anchors: [a1, z2] }),
    "N1d 같은 경우 매수 시각 모름": () => ({ fills: [k("SELL", 1000, 250_000), k("BUY", 500, 130_000, "16:05", "2026-10-13", "seen"), k("SELL", 3500, 945_000, "11:00")], anchors: [a1, z2] }),
    "N9a 1→4, 모두 팔고 100주 다시 삼": () => ({ fills: [k("SELL", 4000, 1_000_000), k("BUY", 100, 26_000, "10:00")], anchors: [a1, krA("2026-10-13", 100, 26_000, 260)] }),
    "N9b 분할 없이 입고 3,000주 + 4,000주 매도 + 100주 삼": () => ({ fills: [k("SELL", 4000, 4_000_000), k("BUY", 100, 100_000, "10:00")], anchors: [a1, krA("2026-10-13", 100, 100_000, 1000)] }),
    "N9c 미국 입고 3,000주 + 4,000주 매도 + 1주 삼": () => ({ fills: [ub, us("SELL", 4000, 400_000, "2026-10-13", "23:30"), us("BUY", 1, 100, "2026-10-13", "23:45")], anchors: [ua, usA("2026-10-13", 1, 100, 100)], usd: true }),
    "N9e 미국 출고 500주 + 500주 매도 + 10주 삼": () => ({ fills: [ub, us("SELL", 500, 50_000, "2026-10-13", "23:30"), us("BUY", 10, 1000, "2026-10-13", "23:45")], anchors: [ua, usA("2026-10-13", 10, 1000, 100)], usd: true }),
    "N11 1→4, 주문 시각만 있는 매수 + 4,200주 매도": () => ({ fills: [k("BUY", 200, 50_000, "09:00", "2026-10-13", "ordered"), k("SELL", 4200, 1_050_000)], anchors: [a1, z2] }),
    "N12 1→4 + 입고 + 매도, 토스 매입금액 없음": () => ({ fills: [k("SELL", 1000, 250_000)], anchors: [a1, krA("2026-10-13", 3500, null, 250)] }),
    // 가격이 먼저 바뀌고 주식은 나중에 (N2 · 늦은 무상증자 · C10-US)
    "N2a 가격만 먼저 250원, 옛 1,000주 매도, 새 주식 뒤": () => ({ fills: [k("SELL", 1000, 250_000, "09:30", "2026-10-14")], anchors: [a1, krA("2026-10-13", 1000, 1_000_000, 250), krA("2026-10-14", 3000, 750_000, 250)] }),
    "N2b 가격만 먼저, 두 번 모두 팖": () => ({ fills: [k("SELL", 1000, 250_000, "09:30", "2026-10-14"), k("SELL", 3000, 750_000, "10:30", "2026-10-14")], anchors: [a1, krA("2026-10-13", 1000, 1_000_000, 250), krA("2026-10-14", 0, 0)] }),
    "N2c 거래정지 날 0주 → 4,000주 → 모두 팖": () => ({ fills: [k("SELL", 4000, 1_000_000, "09:30", "2026-10-15")], anchors: [a1, z2, krA("2026-10-14", 4000, 1_000_000, 250), krA("2026-10-15", 0, 0)] }),
    "N2d 가격만 먼저, 옛 1,000주 모두 팔고 0주에 새 주식": () => ({ fills: [k("SELL", 1000, 250_000, "09:30", "2026-10-14")], anchors: [a1, krA("2026-10-13", 1000, 1_000_000, 250), krA("2026-10-14", 0, 0), krA("2026-10-15", 3000, 750_000, 250)] }),
    "D2 한국 1주당 1주 무상증자 — 권리락 −50%, 3주 뒤 새 주식, 그 사이·뒤 매도": () => ({
      fills: [k("SELL", 200, 101_000, "10:00", "2026-10-14"), k("SELL", 900, 468_000, "10:00", "2026-11-05")],
      anchors: [a1, krA("2026-10-13", 1000, 1_000_000, 500), krA("2026-10-14", 800, 800_000, 505), krA("2026-11-04", 1800, 800_000, 500)],
    }),
    "D5 미국 주식배당 5% — 배당락 날 옛 1,000주 모두 팖, 20일 뒤 0주에 50주": () => ({
      fills: [ub, us("SELL", 1000, 95_240, "2026-10-14", "23:30")],
      anchors: [ua, usA("2026-10-13", 1000, 100_000, 95.24), usA("2026-10-14", 0, 0), usA("2026-11-03", 50, 4762, 95)],
      usd: true,
    }),
    "C10-US NVDA 1→2 분할이 하루 늦게 — 주가 $50·수량 그대로, 옛 50주 매도": () => ({
      fills: [us("BUY", 100, 10_000, "2026-09-01"), us("SELL", 50, 2500, "2026-10-14")],
      anchors: [usA("2026-10-12", 100, 10_000, 100), usA("2026-10-13", 100, 10_000, 50), usA("2026-10-14", 150, 7500, 50)],
      usd: true,
    }),
    // 병합·감자 (N3 · N5)
    "N3a 미국 1대10 병합 소수 주식 모두 팖": () => ({ fills: [us("BUY", 10.123456, 1012.35, "2026-09-01"), us("SELL", 1.012346, 1012.35, "2026-10-13", "23:50")], anchors: [usA("2026-10-12", 10.123456, 1012.35, 100), uz], usd: true }),
    "N3b 미국 1대10 병합 소수 주식 일부 팖": () => ({ fills: [us("BUY", 10.123456, 1012.35, "2026-09-01"), us("SELL", 0.5, 500, "2026-10-13", "23:50")], anchors: [usA("2026-10-12", 10.123456, 1012.35, 100), usA("2026-10-13", 0.512346, 512.35, 1000)], usd: true }),
    "N3c 미국 1대20 병합 끝수 버림 모두 팖": () => ({ fills: [us("BUY", 7.654321, 765.43, "2026-09-01"), us("SELL", 0.382716, 765.43, "2026-10-13", "23:50")], anchors: [usA("2026-10-12", 7.654321, 765.43, 100), uz], usd: true }),
    "N5a 10대1 감자 뒤 10,100원에 모두 팖": () => ({ fills: [k("SELL", 100, 1_010_000)], anchors: [a1, z2] }),
    "N5b 10대1 감자 뒤 9,000원에 모두 팖": () => ({ fills: [k("SELL", 100, 900_000)], anchors: [a1, z2] }),
    "N5c 3대1 감자 끝수 현금 뒤 모두 팖": () => ({ fills: [k("SELL", 333, 333 * 2900)], anchors: [a1, z2] }),
    "N5d 10대1 감자 뒤 일부 팖": () => ({ fills: [k("SELL", 50, 500_000)], anchors: [a1, krA("2026-10-13", 50, 500_000, 10_000)] }),
    // 분할 + 입고 (N6)
    "N6b 1→4 + 입고 500주, 모두 팖": () => ({ fills: [k("SELL", 4500, 1_125_000)], anchors: [a1, z2] }),
    "N6c 1→4 + 입고 500주, 1,000주 팖": () => ({ fills: [k("SELL", 1000, 250_000)], anchors: [a1, krA("2026-10-13", 3500, 875_000, 250)] }),
    // 분할 전에 모두 팔고 분할 뒤 다시 삼 — 참값 0 (확인 필요로 빼도 틀린 숫자는 아님)
    "N7b 분할 전 모두 팖(시간외), 분할 뒤 400주 삼": () => ({ fills: [k("SELL", 1000, 1_000_000, "17:00", "2026-10-12"), k("BUY", 400, 100_000, "10:00")], anchors: [a1, krA("2026-10-13", 400, 100_000, 250)], allow: { 0: 0 } }),
    // 분사 (N4 · C1 · E4)
    "N4a 미국 분사 당일 모회사 모두 팖 + 신설회사 입고": () => ({ fills: [ub, us("SELL", 1000, 80_000, "2026-10-13", "23:30")], anchors: [ua, uz], usd: true, arrivals: [{ from: ua.asOf, to: uz.asOf }] }),
    "N4b 분사가 기록된 다음 날 모두 팖": () => ({ fills: [ub, us("SELL", 1000, 80_000, "2026-10-14")], anchors: [ua, usA("2026-10-13", 1000, 80_000, 80), usA("2026-10-14", 0, 0)], usd: true }),
    "N4c 분사 당일 999주 팔고 1주 (토스 매입금액 $80)": () => ({ fills: [ub, us("SELL", 999, 79_920, "2026-10-13", "23:30")], anchors: [ua, usA("2026-10-13", 1, 80, 80)], usd: true }),
    "C1-US 분사 당일 모회사·신설회사를 모두 팖 (신설회사는 기록에 없음)": () => ({ fills: [ub, us("SELL", 1000, 80_000, "2026-10-13", "23:30")], anchors: [ua, uz], usd: true, arrivals: [{ from: ua.asOf, to: uz.asOf }] }),
    // 첫 기록 전 분사 모양 (검토 반영 11차 — 서버 arrivals 가 첫 기록 전 증거를 from null 로 넘김)
    "PS1 첫 기록 전 모회사 모두 팖, 8일 뒤 신설회사를 산 기록 없이 팖": () => ({
      fills: [us("BUY", 1000, 100_000, "2025-03-03"), us("SELL", 1000, 80_000, "2025-06-02")],
      anchors: [usA("2026-09-25", 0, 0)],
      usd: true,
      arrivals: [{ from: null, to: kst("2025-06-10", "23:40") }],
    }),
    "PS2 첫 기록 전 모회사 모두 팖, 신설회사가 첫 기록에 주문 없이 있음": () => ({
      fills: [us("BUY", 1000, 100_000, "2026-03-02"), us("SELL", 1000, 80_000, "2026-09-10")],
      anchors: [usA("2026-09-25", 0, 0)],
      usd: true,
      arrivals: [{ from: null, to: usA("2026-09-25", 0, 0).asOf }],
    }),
    "PS3 한국 기록이 없는 계좌: 모회사 모두 팖, 신설회사를 산 기록 없이 팖": () => ({
      fills: [kr("BUY", 100, 1_000_000, "2026-03-03"), kr("SELL", 100, 700_000, "2026-06-01")],
      anchors: [],
      arrivals: [{ from: null, to: kst("2026-06-05", "10:00") }],
    }),
    "PS5 첫 기록 전 해가 바뀜: 2025-12-19 모회사 모두 팖, 2026-01-06 신설회사 매도": () => ({
      fills: [us("BUY", 1000, 100_000, "2025-03-03"), us("SELL", 1000, 80_000, "2025-12-19")],
      anchors: [usA("2026-09-25", 0, 0)],
      usd: true,
      arrivals: [{ from: null, to: kst("2026-01-06", "23:40") }],
    }),
    "E4 분사 + 같은 날 순서 모르는 매수": () => ({ fills: [ub, us("SELL", 500, 50_000, "2026-10-13", "23:30"), fill({ side: "BUY", quantity: 800, amount: 64_000, at: uz.asOf, basis: "seen" })], anchors: [ua, usA("2026-10-13", 1300, 104_000, 80)], usd: true }),
    // 분사 당일 모두 판 매도 + 같은 구간에 다시 산 매수, 순서를 모름 (검토 반영 12차 — 저장 순서로는 0주가 되지 않아 ④를 놓쳤다)
    "A1c 미국 모회사 모두 팖(23:30) + 주문 시각만 있는 10주 다시 삼(22:40), 토스 매입금액 $80,000": () => {
      const a = usA("2026-10-12", 1000, 80_000, 100);
      const b = usA("2026-10-13", 10, 800, 80);
      return { fills: [us("BUY", 1000, 80_000, "2026-09-01"), us("SELL", 1000, 80_000, "2026-10-13", "23:30"), us("BUY", 10, 800, "2026-10-13", "22:40", "ordered")], anchors: [a, b], usd: true, arrivals: [{ from: a.asOf, to: b.asOf }] };
    },
    "A1 미국 같은 모양, 토스 매입금액 $100,000 (예전 '순서 추정' −$20,000)": () => {
      const b = usA("2026-10-13", 10, 800, 80);
      return { fills: [ub, us("SELL", 1000, 80_000, "2026-10-13", "23:30"), us("BUY", 10, 800, "2026-10-13", "22:40", "ordered")], anchors: [ua, b], usd: true, arrivals: [{ from: ua.asOf, to: b.asOf }] };
    },
    "A2 같은 초에 체결된 다시 사기(먼저 저장)와 모두 팖": () => {
      const b = usA("2026-10-13", 10, 800, 80);
      const buy = us("BUY", 10, 800, "2026-10-13", "23:30");
      return { fills: [ub, buy, us("SELL", 1000, 80_000, "2026-10-13", "23:30")], anchors: [ua, b], usd: true, arrivals: [{ from: ua.asOf, to: b.asOf }] };
    },
    "A2c 모두 판 매도는 기록 시각('seen')만, 다시 산 매수는 23:45 체결": () => {
      const a = usA("2026-10-12", 1000, 80_000, 100);
      const b = usA("2026-10-13", 10, 800, 80);
      return { fills: [us("BUY", 1000, 80_000, "2026-09-01"), fill({ side: "SELL", quantity: 1000, amount: 80_000, at: b.asOf, basis: "seen" }), us("BUY", 10, 800, "2026-10-13", "23:45")], anchors: [a, b], usd: true, arrivals: [{ from: a.asOf, to: b.asOf }] };
    },
    "A1-KR 한국 모회사 모두 팖(10:00) + 주문 시각만 있는 10주 다시 삼(09:00)": () => {
      const b = krA("2026-10-13", 10, 8_000, 800);
      return { fills: [k("SELL", 1000, 800_000, "10:00"), k("BUY", 10, 8_000, "09:00", "2026-10-13", "ordered")], anchors: [a1, b], arrivals: [{ from: a1.asOf, to: b.asOf }] };
    },
    "A17 첫 기록 전 모두 팖 + 주문 시각만 있는 평균가 다시 사기, 첫 기록 전 증거(from null)": () => {
      const first = usA("2026-09-25", 10, 1000, 100);
      return {
        fills: [us("BUY", 1000, 100_000, "2026-09-01"), us("SELL", 1000, 100_000, "2026-09-10", "23:30"), us("BUY", 10, 1000, "2026-09-10", "22:40", "ordered")],
        anchors: [first],
        usd: true,
        arrivals: [{ from: null, to: first.asOf }],
      };
    },
    // 입고 · 다시 사기 (C15 · C16)
    "입고 + 모두 팖 + 다시 사고 팖": () => ({
      fills: [k("SELL", 15, 1_650_000), k("BUY", 3, 315_000, "11:00"), k("SELL", 3, 321_000, "10:00", "2026-10-14")],
      anchors: [krA("2026-10-12", 10, 1_000_000, 100_000), krA("2026-10-13", 3, 315_000, 106_000)],
    }),
    "C15 첫 기록 전 권리락 날 모두 팔고 10주 다시 삼, 3주 뒤 1,000주 입고": () => ({
      fills: [kr("BUY", 1000, 10_000_000, "2026-09-01"), kr("SELL", 1000, 5_000_000, "2026-09-03"), kr("BUY", 10, 50_000, "2026-09-04")],
      anchors: [krA("2026-09-10", 10, 50_000, 5000), krA("2026-09-11", 10, 50_000, 5000), krA("2026-10-01", 1010, 50_000, 5000)],
    }),
    "C16 주식배당 3% 날 모두 팔고 100주 다시 산 뒤 30주 입고": () => ({
      fills: [kr("SELL", 1000, 970_000, "2026-09-22"), kr("BUY", 100, 97_000, "2026-09-28")],
      anchors: [krA("2026-09-21", 1000, 1_000_000, 1000), krA("2026-09-22", 0, 0), krA("2026-09-28", 100, 97_000, 970), krA("2026-10-14", 130, 97_000, 970)],
    }),
    "첫 기록 0주 뒤 주문 없이 들어옴 (첫 기록 전 권리락 날 매도)": () => ({ fills: [kr("BUY", 10, 1_000_000, "2026-09-01"), kr("SELL", 10, 500_000, "2026-09-03")], anchors: [krA("2026-09-10", 0, 0), krA("2026-09-11", 0, 0), krA("2026-12-21", 10, 0, 50_000)] }),
    // 큰 주가 변화 (추석·노동절 다음 날 · 미국 −70% 뒤 새로 사고팖)
    "추석 다음 거래일 권리락 −50% 뒤 매도": () => ({ fills: [kr("SELL", 200, 101_000, "2026-09-30")], anchors: [krA("2026-09-23", 1000, 1_000_000, 1000), krA("2026-09-28", 1000, 1_000_000, 500), krA("2026-09-29", 1000, 1_000_000, 505)] }),
    "노동절 다음 날 늦게 반영된 1→4 분할에 옛 수량 모두 팖": () => ({ fills: [us("SELL", 10, 250, "2026-09-08", "23:30")], anchors: [anchor({ asOf: "2026-09-05T05:05:00+09:00", date: "2026-09-04", quantity: 10, cost: 1000, price: 100 }), anchor({ asOf: "2026-09-09T05:05:00+09:00", date: "2026-09-08", quantity: 0, cost: 0 })], usd: true }),
    "미국 −70% 뒤 모두 팔고 0주에서 새로 사고팖": () => ({
      fills: [us("SELL", 10, 300, "2026-09-25", "23:30"), us("BUY", 5, 750, "2026-09-28", "22:40"), us("SELL", 5, 850, "2026-09-29", "01:00")],
      anchors: [usA("2026-09-23", 10, 1000, 100), usA("2026-09-24", 10, 1000, 30), usA("2026-09-25", 0, 0), usA("2026-09-28", 0, 0), usA("2026-09-29", 0, 0)],
      usd: true,
    }),
  };

  for (const [name, make] of Object.entries(cases)) {
    it(name, () => {
      const c = make();
      const r = replayPair(c.fills, c.anchors, c.usd ? { ...USD, fxAt: () => 1400, ...(c.arrivals ? { arrivals: c.arrivals } : {}) } : { ...KRW, ...(c.arrivals ? { arrivals: c.arrivals } : {}) });
      const sells = c.fills.filter((f) => f.side === "SELL");
      expect(sells.length).toBeGreaterThan(0);
      sells.forEach((f, i) => {
        const res = r.fills.get(f.key)!;
        const allowed = c.allow?.[i];
        if (allowed !== undefined && res.realized!.status !== "unexplained") {
          expect(res.realized!.gross, `${name} 매도 ${i}`).toBe(allowed);
          return;
        }
        // 확인 필요: 실현손익·원화·결제일 원화 취득가 어디에도 숫자가 없다
        expect(res.realized, `${name} 매도 ${i}`).toMatchObject(needs);
        expect(res.realized!.change, `${name} 매도 ${i} 까닭`).toBeTruthy();
        if (c.usd) expect(res.std, `${name} 매도 ${i}`).toMatchObject({ cost: null, missing: "unexplained" });
      });
      expect(r.check.doubtYears).toContain(Number(sells[0]!.at.slice(0, 4)));
    });
  }
});

describe("검토 반영 10차 — 기록과 맞는 보통 매매만 있는 해는 한 글자도 그대로", () => {
  it("여러 기록에 걸친 보통 사고팔기(한국): 기록과 맞고 주가 변화가 작으면 모두 보통 계산, 건너뛰는 구간 없음", () => {
    const f = [kr("BUY", 5, 520_000, "2026-10-13"), kr("SELL", 3, 330_000, "2026-10-14"), kr("SELL", 12, 1_290_000, "2026-10-16")];
    const anchors = [krA("2026-10-12", 10, 1_000_000, 100_000), krA("2026-10-13", 15, 1_520_000, 104_000), krA("2026-10-14", 12, 1_216_000, 110_000), krA("2026-10-15", 12, 1_216_000, 108_000), krA("2026-10-16", 0, 0)];
    const r = replayPair(f, anchors, KRW);
    expect(r.fills.get(f[0]!.key)!.afterBuy).toEqual({ avgCost: 101_333.3333, quantity: 15 });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2026-10-13", gross: 26_000, costAmount: 304_000 });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2026-10-15", gross: 74_000, costAmount: 1_216_000 });
    expect(r.skips).toEqual([]);
    expect(r.changes).toEqual([]);
    expect(r.check).toMatchObject({ unexplained: 0, priceJumps: 0, doubtYears: [] });
  });

  it("같은 날 순서를 모르는 매수·매도: 매도 먼저 순서만 토스 매입금액과 맞으면 그 값 — 설명된 구간이라 '순서 추정' 그대로", () => {
    const f = [us("BUY", 1000, 100_000, "2026-09-01"), fill({ side: "SELL", quantity: 500, amount: 60_000, at: "2026-09-28T23:30:00+09:00" }), fill({ side: "BUY", quantity: 500, amount: 55_000, at: "2026-09-29T05:05:00+09:00", basis: "seen" })];
    const r = replayPair(f, [usA("2026-09-25", 1000, 100_000, 100), usA("2026-09-28", 1000, 105_000, 110)], { currency: "USD" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.orderUncertain, gross: 10_000 });
    expect(r.check).toMatchObject({ drift: 0, doubtYears: [] });
    expect(r.changes).toEqual([]);
    expect(r.skips).toEqual([]);
  });

  it("같은 시각에 체결된 매수·매도는 저장 순서로 정하지 않는다: 0주에서 사고판 단타는 보통 계산, 값이 순서에 따라 다르면 '순서 추정'", () => {
    const sell = kr("SELL", 10, 1_100_000, "2026-09-28");
    const buy = kr("BUY", 10, 1_000_000, "2026-09-28");
    const r = replayPair([sell, buy], [krA("2026-09-25", 0, 0), krA("2026-09-28", 0, 0)], KRW);
    expect(r.fills.get(sell.key)!.realized).toMatchObject({ status: "ok", gross: 100_000 });
    expect(r.skips).toEqual([]);
    expect(r.changes).toEqual([]);
    const s2 = kr("SELL", 10, 1_300_000, "2026-09-28");
    const b2 = kr("BUY", 10, 1_200_000, "2026-09-28");
    const r2 = replayPair([s2, b2], [krA("2026-09-25", 10, 1_000_000), krA("2026-09-28", 10, 1_100_000)], KRW);
    expect(r2.fills.get(s2.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.orderUncertain, gross: 200_000 });
    expect(r2.skips).toEqual([]);
  });
});

describe("비용 (수수료·세금) 과 원화", () => {
  it("토스 원본에 수수료·세금 칸이 있으면 몫 비율로 나눠 'toss' — DB 값은 고쳐 쓰지 않는다 (§9-13)", () => {
    expect(tossCosts({ execution: { commission: "1.20", tax: 0.05 } })).toEqual({ fee: 1.2, tax: 0.05 });
    expect(tossCosts({ fee: { amount: 150 }, securitiesTax: 2310 })).toEqual({ fee: 150, tax: 2310 });
    expect(tossCosts({ orderId: "x", side: "SELL" })).toBeNull();
    expect(tossCosts({ tax: "과세", fee: -1 })).toBeNull(); // 숫자가 아니거나 음수는 버림
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 4, amount: 480, at: "2026-09-02T23:00:00+09:00", orderQuantity: 8, orderCosts: { fee: 0.8, tax: 0.2 } }),
    ];
    const s = replayPair(f, [], { currency: "USD" }).fills.get(f[1]!.key)!.realized!;
    expect(s.costs).toEqual({ fee: 0.4, tax: 0.1, total: 0.5, source: "toss" });
    expect(s.net).toBe(79.5);
  });

  it("원본 칸이 없으면 직전 스냅샷의 '비용 차감' 비율로 추정, 그것도 없으면 null (§9-13)", () => {
    const a = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1000, costRatio: 0.001 });
    const f = [fill({ side: "SELL", quantity: 5, amount: 600, at: "2026-09-28T23:00:00+09:00" })];
    expect(replayPair(f, [a], { currency: "USD" }).fills.get(f[0]!.key)!.realized!.costs).toEqual({ fee: null, tax: null, total: 0.6, source: "estimated" });
    const b = { ...a, costRatio: null };
    const s = replayPair(f, [b], { currency: "USD" }).fills.get(f[0]!.key)!.realized!;
    expect(s.costs).toEqual({ fee: null, tax: null, total: null, source: null });
    expect(s.net).toBeNull();
  });

  it("판매 때 환율이 없으면 원화 칸만 비우고 달러 실현손익은 그대로 (§9-14)", () => {
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 5, amount: 600, at: "2026-09-02T23:00:00+09:00" }),
    ];
    const s = replayPair(f, [], { currency: "USD", fxAt: (at) => (at.startsWith("2026-09-01") ? 1390 : null) }).fills.get(f[1]!.key)!.realized!;
    expect(s.gross).toBe(100);
    expect(s.krw).toMatchObject({ gross: null, reason: REASONS.krwNoFx });
  });

  it("기준점의 원화 매입금액(토스 원화 장부)이 없으면 원화 손익을 빼고 까닭을 적는다", () => {
    const a = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1000, costKrw: null });
    const f = [fill({ side: "SELL", quantity: 5, amount: 600, at: "2026-09-28T23:00:00+09:00" })];
    const s = replayPair(f, [a], { currency: "USD", fxAt: () => 1400 }).fills.get(f[0]!.key)!.realized!;
    expect(s.krw).toMatchObject({ gross: null, reason: REASONS.krwNoBook });
    const e = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1000, costKrw: 1_380_000, costKrwEstimated: true });
    expect(replayPair(f, [e], { currency: "USD", fxAt: () => 1400 }).fills.get(f[0]!.key)!.realized!.krw).toMatchObject({ gross: 150_000, estimated: true });
  });
});

describe("반올림", () => {
  it("매도마다 먼저 반올림하므로 합계는 줄의 합과 늘 같다 (§9-15)", () => {
    const f = [fill({ side: "BUY", quantity: 3, amount: 100, at: "2026-09-01T23:00:00+09:00" })];
    for (let i = 0; i < 3; i++) f.push(fill({ side: "SELL", quantity: 1, amount: 34.335, at: `2026-09-0${2 + i}T23:00:00+09:00` }));
    const r = replayPair(f, [], { currency: "USD" });
    const g = f.slice(1).map((x) => r.fills.get(x.key)!.realized!.gross!);
    for (const x of g) expect(Math.round(x * 100)).toBe(x * 100);
    expect(g.reduce((s, x) => s + x, 0)).toBeCloseTo(g[0]! + g[1]! + g[2]!, 10);
  });
});

describe("검토 반영: 원화 손익을 뺀 까닭은 빠진 환율을 바로 말한다", () => {
  const f = () => [
    fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T23:00:00+09:00" }),
    fill({ side: "SELL", quantity: 5, amount: 600, at: "2026-09-02T23:00:00+09:00" }),
  ];
  const krw = (fxAt: (at: string) => number | null) => {
    const x = f();
    return replayPair(x, [], { currency: "USD", fxAt }).fills.get(x[1]!.key)!.realized!.krw;
  };
  it("매수 때 환율이 없으면 '매수 때' · 판매 때 환율이 없으면 '판매 때' · 둘 다 없으면 둘 다", () => {
    expect(krw((at) => (at.startsWith("2026-09-02") ? 1400 : null))).toMatchObject({ gross: null, reason: REASONS.krwNoBuyFx });
    expect(krw((at) => (at.startsWith("2026-09-01") ? 1390 : null))).toMatchObject({ gross: null, reason: REASONS.krwNoFx });
    expect(krw(() => null)).toMatchObject({ gross: null, reason: REASONS.krwNoBothFx });
    expect(REASONS.krwNoBuyFx).toContain("매수 때");
    expect(REASONS.krwNoFx).toContain("판매 때");
  });
});
