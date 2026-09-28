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
  it("원장보다 많이 파는 매도(앞부분 기록 없음)는 '실현손익 모름', 다음 기준점부터 다시 안다 (§9-7)", () => {
    const f = [
      fill({ side: "BUY", quantity: 5, amount: 500, at: "2026-09-10T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 8, amount: 900, at: "2026-09-11T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 2, amount: 250, at: "2026-09-29T23:00:00+09:00" }),
    ];
    const a = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1000 });
    const r = replayPair(f, [a], { currency: "USD" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "unknown-cost", gross: null, rate: null, reason: REASONS.beforeRecord });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", gross: 50 });
    expect(r.check.preAnchor).toBe("mismatch");
  });

  it("전체 주문 내역이 첫 스냅샷과 맞으면 그 전 매도도 계산 ('history-checked') / 평균이 1원 넘게 다르면 모름 (§9-8)", () => {
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 700_000, at: "2026-09-01T10:00:00+09:00", code: "005930" }),
      fill({ side: "SELL", quantity: 4, amount: 300_000, at: "2026-09-02T10:00:00+09:00", code: "005930" }),
    ];
    const ok = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 6, cost: 420_000 });
    const r = replayPair(f, [ok], { currency: "KRW" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "history-checked", anchorDate: "2026-09-28", gross: 20_000 });
    expect(r.check.preAnchor).toBe("checked");
    // 스냅샷 평균이 70,002원(1원 넘게 다름) → 기록 전 매도는 모름
    const off = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 6, cost: 420_012 });
    expect(replayPair(f, [off], { currency: "KRW" }).fills.get(f[1]!.key)!.realized).toMatchObject({ status: "unknown-cost", reason: REASONS.beforeRecord });
    // 1원 안(반올림)이면 맞는 것으로
    const round = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 6, cost: 420_004 });
    expect(replayPair(f, [round], { currency: "KRW" }).fills.get(f[1]!.key)!.realized!.status).toBe("ok");
  });

  it("스냅샷이 한 번도 없는 짝: 0주에서 끝까지 음수 없이 돌면 'history-only', 음수면 모름 (§9-9)", () => {
    const f = [
      fill({ side: "BUY", quantity: 3, amount: 300, at: "2026-08-01T23:00:00+09:00", code: "AMD" }),
      fill({ side: "SELL", quantity: 3, amount: 360, at: "2026-08-02T23:00:00+09:00", code: "AMD" }),
    ];
    const r = replayPair(f, [], { currency: "USD" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "history-only", gross: 60 });
    expect(r.check.preAnchor).toBe("history-only");
    const g = [fill({ side: "SELL", quantity: 3, amount: 360, at: "2026-08-02T23:00:00+09:00", code: "AMD" })];
    expect(replayPair(g, [], { currency: "USD" }).fills.get(g[0]!.key)!.realized).toMatchObject({ status: "unknown-cost", basis: null });
  });
});

describe("스냅샷 사이 수량 변화 — 분할·이관 추정", () => {
  it("분할 1→4 (매입금액 같음): 추정 줄 + 사이 매도는 'estimated', 매입금액은 그대로 (§9-10)", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1_000_000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 36, cost: 900_000 });
    const f = [fill({ side: "SELL", quantity: 1, amount: 130_000, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    // 매도 뒤 원장 9주·900,000 → 스냅샷 36주·900,000 = 4배
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 27, fromQty: 9, toQty: 36, reason: "split", ratio: 4 }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", gross: 30_000, reason: REASONS.split });
    expect(r.check.splits).toBe(1);
  });

  it("이관 입고: 스냅샷으로 다시 맞추고 추정 줄 (§9-11)", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1_000_000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 20, cost: 2_300_000 });
    const f = [fill({ side: "SELL", quantity: 1, amount: 110_000, at: "2026-09-29T09:30:00+09:00", code: "035420" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 10, fromQty: 10, toQty: 20, reason: "transfer" }]);
    // 그 뒤 매도는 새 기준점에서 (평균 115,000) — 추정 아님
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2026-09-28", gross: -5_000 });
    expect(r.check.transfers).toBe(1);
  });

  it("수량이 같고 평균만 조금 다르면 조용히 스냅샷 값으로 다시 맞춘다 (추정 줄 없음, 점검에 drift)", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", quantity: 20, cost: 2002 });
    const f = [fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-28T01:00:00+09:00" })];
    const r = replayPair(f, [a1, a2], { currency: "USD" });
    expect(r.estimated).toEqual([]);
    expect(r.check.drift).toBe(1);
    expect(r.holding.avgCost).toBeCloseTo(100.1, 6);
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
