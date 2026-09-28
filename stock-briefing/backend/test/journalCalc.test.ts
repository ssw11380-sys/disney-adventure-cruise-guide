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

describe("검토 반영: 회사 행동(분할·무상증자·주식배당)은 비율과 상관없이 — 매입금액이 그대로인데 수량이 바뀜", () => {
  it("무상증자 10→15 (비율 1.5 — 정수가 아님): 이관이 아니라 주식 수 변화 추정 줄, 평균 구매가만 낮아진다", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1500 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 15, cost: 1500 });
    const f = [fill({ side: "SELL", quantity: 3, amount: 330, at: "2026-09-29T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 5, fromQty: 10, toQty: 15, reason: "split", ratio: 1.5 }]);
    expect(r.check).toMatchObject({ splits: 1, transfers: 0 });
    // 그 뒤 매도: 평균 100 → 원가 300 → +30
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: 30, costAmount: 300, avgCost: 100 });
  });

  it("분할 1→4 와 같은 구간의 매도 5주(분할 뒤 수량): 분할 뒤 평균 구매가로 — 가짜 실현손실이 없다", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1000 });
    // 분할 뒤 40주 → 5주 매도 → 35주, 토스 매입금액 875 (1000 × 35/40)
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 35, cost: 875 });
    const f = [fill({ side: "SELL", quantity: 5, amount: 125, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 30, fromQty: 10, toQty: 40, reason: "split", ratio: 4 }]);
    expect(r.check).toMatchObject({ splits: 1, transfers: 0 });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0, costAmount: 125, avgCost: 25 });
    expect(r.holding).toEqual({ quantity: 35, avgCost: 25 });
  });

  it("비율이 정수가 아닌 변화 + 사이 매도 (10→15 뒤 3주 매도, 토스 매입금액 1,200): 무상증자로 보고 원가 300", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1500 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 12, cost: 1200 });
    const f = [fill({ side: "SELL", quantity: 3, amount: 330, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 5, fromQty: 10, toQty: 15, reason: "split", ratio: 1.5 }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", gross: 30, costAmount: 300 });
  });

  it("해외 양도세 원장(결제일 원화)도 분할 뒤 수량으로 이어진다 — 취득가를 모름으로 떨어뜨리지 않고 가짜 손실도 없다", () => {
    const std = () => 1350;
    const f = [
      fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 5, amount: 125, at: "2026-09-28T23:30:00+09:00" }),
    ];
    const a1 = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1000 });
    const a2 = anchor({ asOf: "2026-09-29T05:05:00+09:00", date: "2026-09-28", quantity: 35, cost: 875 });
    const r = replayPair(f, [a1, a2], { currency: "USD", stdAt: std });
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "estimated", gross: 0 });
    expect(s.std).toEqual({ proceeds: 125 * 1350, cost: 125 * 1350, missing: null });
  });

  it("매입금액이 0.5% 넘게 달라지면(이관 입고) 비율이 딱 맞아도 이관 — 회사 행동으로 보지 않는다", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 20, cost: 2000 });
    const r = replayPair([], [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 10, fromQty: 10, toQty: 20, reason: "transfer" }]);
  });
});

describe("검토 반영: 기준점 뒤 기록된 수량보다 많이 판 매도", () => {
  // 직전 종가 100 — 120 에 판 15주는 1.5배 무상증자(뒤 가격 약 67)로 설명되지 않는다 (서비스는 스냅샷 종가를 늘 넘긴다)
  const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1000, price: 100 });
  const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });

  it("0 으로 조용히 되돌리지 않는다: '순서 추정'(기준점 평균으로 추정) + 다음 기준점의 이관 추정은 +5주", () => {
    const f = [fill({ side: "SELL", quantity: 15, amount: 1800, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.oversoldAfter, gross: 300, costAmount: 1500, avgCost: 100, basis: "snapshot", anchorDate: "2026-09-25" });
    // 다음 기록에 종목이 없으면 그 구간 평균 판 가격(120)을 이관 줄에 적는다 (수익률 흐름 값 — 검토 반영 5차)
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 5, fromQty: -5, toQty: 0, reason: "transfer", sellPx: 120 }]);
    expect(r.check).toMatchObject({ transfers: 1, splits: 0 });
    expect(r.holding).toEqual({ quantity: 0, avgCost: null });
  });

  it("같은 구간의 다음 매도는 평균 구매가를 모른다 · 늦게 적힌 매수로 수량이 맞으면(순서 문제) 이관 추정 줄 없음", () => {
    const f = [
      fill({ side: "SELL", quantity: 15, amount: 1800, at: "2026-09-28T09:30:00+09:00", code: "005930" }),
      fill({ side: "SELL", quantity: 1, amount: 120, at: "2026-09-28T09:40:00+09:00", code: "005930" }),
    ];
    const r = replayPair(f, [a1, anchor({ ...a2, quantity: 0 })], { currency: "KRW" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "unknown-cost", gross: null, reason: REASONS.oversold });
    expect(r.estimated.map((e) => e.qty)).toEqual([6]);
    const g = [
      fill({ side: "SELL", quantity: 15, amount: 1800, at: "2026-09-28T09:30:00+09:00", code: "005930" }),
      fill({ side: "BUY", quantity: 5, amount: 550, at: "2026-09-28T09:31:00+09:00", code: "005930" }),
    ];
    const r2 = replayPair(g, [a1, a2], { currency: "KRW" });
    expect(r2.fills.get(g[0]!.key)!.realized!.status).toBe("order-uncertain");
    expect(r2.estimated).toEqual([]);
  });

  it("기록 시작 전(첫 기준점 전) 많이 판 매도는 지금처럼 '실현손익 모름'", () => {
    const f = [fill({ side: "SELL", quantity: 3, amount: 360, at: "2026-08-02T23:00:00+09:00", code: "AMD" })];
    expect(replayPair(f, [a1], { currency: "USD" }).fills.get(f[0]!.key)!.realized).toMatchObject({ status: "unknown-cost", reason: REASONS.beforeRecord });
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

describe("검토 반영 3차: 회사 행동은 끝 가정·처음 가정을 둘 다 계산해 토스 매입금액에 더 가까운 쪽", () => {
  const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000 });

  it("1000주 1→4 분할 뒤 5주 매도 (토스 3,995주 · 998,750원): 분할 뒤 평균 250 — 가짜 손실 없음, 배수 4", () => {
    // 끝 가정이면 원장 995주·995,000 → 매입금액 차이 0.38% (허용폭 안) 라 예전에는 배수 4.0151 · 매도 손실 −3,750 이었다
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 3995, cost: 998_750 });
    const f = [fill({ side: "SELL", quantity: 5, amount: 1250, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 3000, fromQty: 1000, toQty: 4000, reason: "split", ratio: 4 }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0, costAmount: 1250, avgCost: 250 });
    expect(r.holding).toEqual({ quantity: 3995, avgCost: 250 });
  });

  it("미국 같은 경우: 달러 손익 0, 양도세 취득가 = 양도가 (예전에는 −$375 · 가짜 손실 −506,250원)", () => {
    const f = [
      fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 5, amount: 125, at: "2026-09-28T23:30:00+09:00" }),
    ];
    const b1 = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 100_000 });
    const b2 = anchor({ asOf: "2026-09-29T05:05:00+09:00", date: "2026-09-28", quantity: 3995, cost: 99_875 });
    const r = replayPair(f, [b1, b2], { currency: "USD", stdAt: () => 1350 });
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "estimated", gross: 0, avgCost: 25 });
    expect(s.std).toEqual({ proceeds: 168_750, cost: 168_750, missing: null });
    expect(r.estimated[0]).toMatchObject({ reason: "split", ratio: 4, fromQty: 1000, toQty: 4000 });
  });

  it("무상증자 1000→1500 뒤 3주 매도: 증자 뒤 평균으로 손익 0, 배수 1.5", () => {
    const c1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_500_000 });
    const c2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 1497, cost: 1_497_000 });
    const f = [fill({ side: "SELL", quantity: 3, amount: 3000, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [c1, c2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: c2.asOf, date: "2026-09-28", qty: 500, fromQty: 1000, toQty: 1500, reason: "split", ratio: 1.5 }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ gross: 0, costAmount: 3000, avgCost: 1000 });
  });

  it("분할 뒤 매수 (매입금액은 두 가정이 같음): 흔한 배수(4)인 처음 가정 — 이 매수 뒤 평균 250원 · 4,100주", () => {
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 4100, cost: 1_025_000 });
    const f = [fill({ side: "BUY", quantity: 100, amount: 25_000, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.afterBuy).toEqual({ avgCost: 250, quantity: 4100 });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 3000, fromQty: 1000, toQty: 4000, reason: "split", ratio: 4 }]);
  });

  it("여러 날 구간에서 분할 전에 산 매수: 흔한 배수(4)인 끝 가정 — 처음 가정(4.075)으로 바꾸지 않는다", () => {
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 4100, cost: 1_025_000 });
    const f = [fill({ side: "BUY", quantity: 25, amount: 25_000, at: "2026-09-26T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.afterBuy).toEqual({ avgCost: 1000, quantity: 1025 });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 3075, fromQty: 1025, toQty: 4100, reason: "split", ratio: 4 }]);
  });

  it("분할 전에 판 매도는 그대로 끝 가정 (처음 가정은 매입금액이 맞지 않음)", () => {
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 3960, cost: 990_000 });
    const f = [fill({ side: "SELL", quantity: 10, amount: 11_000, at: "2026-09-26T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 2970, fromQty: 990, toQty: 3960, reason: "split", ratio: 4 }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ gross: 1000, costAmount: 10_000, avgCost: 1000 });
  });
});

describe("검토 반영 3차: 작은 입고·출고는 회사 행동으로 보지 않는다 (수량 변화 2% 이상 · 매입금액 변화는 그 1/10 이하)", () => {
  it("300주 가운데 1주 출고 (매입금액 −0.33%): 병합이 아니라 이관", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 300, cost: 300_000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 299, cost: 299_000 });
    const r = replayPair([], [a1, a2], { currency: "KRW" });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: -1, fromQty: 300, toQty: 299, reason: "transfer" }]);
    expect(r.check).toMatchObject({ splits: 0, transfers: 1 });
  });

  it("1000주에 3주 입고 (매입금액 그대로, +0.3%): 무상증자가 아니라 이관", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 1003, cost: 1_000_000 });
    expect(replayPair([], [a1, a2], { currency: "KRW" }).estimated[0]).toMatchObject({ reason: "transfer", qty: 3 });
  });

  it("매입금액이 수량 변화의 1/10 넘게 움직인 입고(+3% 수량 · +0.4% 매입금액)는 이관 · 주식배당 5%(매입금액 그대로)는 회사 행동", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000 });
    const inbound = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 1030, cost: 1_004_000 });
    expect(replayPair([], [a1, inbound], { currency: "KRW" }).estimated[0]).toMatchObject({ reason: "transfer", qty: 30 });
    const div = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 1050, cost: 1_000_000 });
    expect(replayPair([], [a1, div], { currency: "KRW" }).estimated[0]).toMatchObject({ reason: "split", ratio: 1.05, qty: 50 });
  });
});

describe("검토 반영 4차: 분할·병합·주식배당 뒤 같은 구간에 전부 판 경우 (다음 스냅샷 0주·0원) — 가짜 손익·가짜 이관 없음", () => {
  const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000, price: 1000 });
  const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });
  const kr = (side: "BUY" | "SELL", quantity: number, amount: number, hm = "09:30") => fill({ side, quantity, amount, at: `2026-09-28T${hm}:00+09:00`, code: "005930" });
  const splitRow = (qty: number, toQty: number, ratio: number) => ({ at: a2.asOf, date: "2026-09-28", qty, fromQty: 1000, toQty, reason: "split", ratio });

  it("한국 1→4 분할 뒤 4,000주를 250원에 모두 팔면: 손익 0 · 분할 줄(배수 4) · 이관 없음 (예전 −3,000,000 · 이관 +3,000주)", () => {
    const f = [kr("SELL", 4000, 1_000_000)];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0, costAmount: 1_000_000, avgCost: 250, basis: "snapshot", anchorDate: "2026-09-25" });
    expect(r.estimated).toEqual([splitRow(3000, 4000, 4)]);
    expect(r.check).toMatchObject({ splits: 1, transfers: 0 });
    expect(r.holding).toEqual({ quantity: 0, avgCost: null });
    // 직전 종가가 없으면 판 가격으로 배수를 확인할 수 없어 받아들이지 않는다 (검토 반영 5차 — 주문 내역에 없는 입고를 분할로 잘못 보지 않게):
    // 이관 + 순서 추정 → 양도세 합계에서 뺌
    const noPx = replayPair(f, [{ ...a1, price: null }, a2], { currency: "KRW" });
    expect(noPx.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.oversoldAfter });
    expect(noPx.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 3000, fromQty: -3000, toQty: 0, reason: "transfer", sellPx: 250 }]);
  });

  it("미국 같은 경우 (결제일 환율 1,350): 달러 손익 0 · 원화 손익 0 · 양도세 취득가 = 양도가 (예전 가짜 손실 약 −405,000,000원)", () => {
    const f = [
      fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 4000, amount: 100_000, at: "2026-09-28T23:30:00+09:00" }),
    ];
    const b1 = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 });
    const b2 = anchor({ asOf: "2026-09-29T05:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });
    const r = replayPair(f, [b1, b2], { currency: "USD", fxAt: () => 1390, stdAt: () => 1350 });
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0, costAmount: 100_000, avgCost: 25 });
    expect(s.realized!.krw).toMatchObject({ gross: 0, costKrw: 139_000_000 });
    expect(s.std).toEqual({ proceeds: 135_000_000, cost: 135_000_000, missing: null });
    expect(r.estimated).toEqual([{ at: b2.asOf, date: "2026-09-28", qty: 3000, fromQty: 1000, toQty: 4000, reason: "split", ratio: 4 }]);
  });

  it("한국 4→1 병합 뒤 250주를 4,000원에 모두 팔면: 손익 0 · 병합 줄(배수 0.25) (예전 +750,000 · 출고 −750주)", () => {
    const f = [kr("SELL", 250, 1_000_000)];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0, costAmount: 1_000_000, avgCost: 4000 });
    expect(r.estimated).toEqual([splitRow(-750, 250, 0.25)]);
    expect(r.check).toMatchObject({ splits: 1, transfers: 0 });
  });

  it("미국 4→1 병합 뒤 모두 판 경우: 달러 손익 0 · 양도세 취득가 = 양도가", () => {
    const f = [
      fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 250, amount: 100_000, at: "2026-09-28T23:30:00+09:00" }),
    ];
    const b1 = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 });
    const b2 = anchor({ asOf: "2026-09-29T05:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });
    const r = replayPair(f, [b1, b2], { currency: "USD", stdAt: () => 1350 });
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "estimated", gross: 0, avgCost: 400 });
    expect(s.std).toEqual({ proceeds: 135_000_000, cost: 135_000_000, missing: null });
    expect(r.estimated[0]).toMatchObject({ reason: "split", ratio: 0.25, fromQty: 1000, toQty: 250 });
  });

  it("1→4 분할 뒤 2,000주씩 두 번에 나눠 모두 팔면: 두 매도 모두 손익 0 (예전 −1,500,000 + 평균 모름)", () => {
    const f = [kr("SELL", 2000, 500_000, "09:30"), kr("SELL", 2000, 500_000, "10:30")];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    for (const x of f) expect(r.fills.get(x.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0, costAmount: 500_000, avgCost: 250 });
    expect(r.estimated).toEqual([splitRow(3000, 4000, 4)]);
  });

  it("주식배당 5% (1000→1050주) 뒤 모두 팔면: 손익 0 · 배수 1.05 / 단주를 현금으로 받은 333→349주도 1.05", () => {
    const f = [kr("SELL", 1050, 1_000_000)];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", gross: 0, costAmount: 1_000_000 });
    expect(r.estimated).toEqual([splitRow(50, 1050, 1.05)]);
    // 333주 × 1.05 = 349.65 → 349주 (0.65주는 현금) → 349주를 952원에 모두 팖
    const c1 = anchor({ ...a1, quantity: 333, cost: 333_000 });
    const g = [kr("SELL", 349, 349 * 952)];
    const r2 = replayPair(g, [c1, a2], { currency: "KRW" });
    expect(r2.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 16, fromQty: 333, toQty: 349, reason: "split", ratio: 1.05 }]);
    expect(r2.fills.get(g[0]!.key)!.realized).toMatchObject({ status: "estimated", costAmount: 333_000, gross: 349 * 952 - 333_000 });
  });

  it("1→4 분할 뒤 100주를 더 사고 4,100주를 모두 팔면: 이 매수 뒤 평균 250 · 매도 손익 +41,000 (예전 −2,754,455)", () => {
    const f = [kr("BUY", 100, 25_000, "09:10"), kr("SELL", 4100, 1_066_000, "10:00")];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.afterBuy).toEqual({ avgCost: 250, quantity: 4100 });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "estimated", gross: 41_000, costAmount: 1_025_000, avgCost: 250 });
    expect(r.estimated).toEqual([splitRow(3000, 4000, 4)]);
  });

  it("회사 행동으로 보지 않는 경우: 판 가격이 배수와 맞지 않음 · 흔하지 않은 배수(행동으로 계산하되 순서 추정) · 부분 매도 뒤 출고 · 직전 종가 없는 병합 쪽(순서 추정)", () => {
    // 1) 4,000주를 분할 전 가격(1,000원)에 팖 — 주문 내역에 없는 입고 3,000주로 남긴다 (순서 추정 → 양도세 합계에서 뺌)
    const same = [kr("SELL", 4000, 4_000_000)];
    const r1 = replayPair(same, [a1, a2], { currency: "KRW" });
    expect(r1.fills.get(same[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.oversoldAfter });
    expect(r1.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 3000, fromQty: -3000, toQty: 0, reason: "transfer", sellPx: 1000 }]);
    // 2) 4.075배 — 흔한 배수가 아니다. 판 가격(250원)은 큰 배수를 따라가므로 행동으로 계산하되(가짜 손실 −3,056,250 대신 +18,750)
    //    확인하지 못해 '순서 추정' (양도세 합계에서 뺌 — 검토 반영 5차)
    const odd = [kr("SELL", 4075, 1_018_750)];
    const r2 = replayPair(odd, [a1, a2], { currency: "KRW" });
    expect(r2.fills.get(odd[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.splitUncertain, gross: 18_750, costAmount: 1_000_000 });
    expect(r2.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 3075, fromQty: 1000, toQty: 4075, reason: "split", ratio: 4.075 }]);
    // 3) 250주를 보통 가격(1,000원)에 팔고 나머지 750주는 출고 — 0.25 배 병합이 아니다 (손익은 평균 그대로 0)
    const part = [kr("SELL", 250, 250_000)];
    const r3 = replayPair(part, [a1, a2], { currency: "KRW" });
    expect(r3.fills.get(part[0]!.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.transfer, gross: 0, costAmount: 250_000 });
    expect(r3.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: -750, fromQty: 750, toQty: 0, reason: "transfer", sellPx: 1000 }]);
    // 4) 직전 종가가 없으면 수량이 줄어드는 쪽(병합)은 부분 매도 + 출고와 구별할 수 없어 이관으로 둔다 — 가짜 손실(−750,000)을 만들지 않되,
    //    확인하지 못했으므로 '순서 추정' (병합이었다면 가짜 이익이 양도세 합계에 들지 않게 — 검토 반영 5차)
    const r4 = replayPair(part, [{ ...a1, price: null }, a2], { currency: "KRW" });
    expect(r4.fills.get(part[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.changeUncertain, gross: 0 });
    expect(r4.estimated[0]).toMatchObject({ reason: "transfer" });
  });
});

describe("검토 반영 5차: 병합 끝수 올림·소수 주식 끝수 현금 · 알아보지 못한 0주 구간은 방향과 상관없이 순서 추정", () => {
  const US1 = "2026-09-26T05:05:00+09:00";
  const US2 = "2026-09-29T05:05:00+09:00";
  const b = (quantity: number, cost: number, price: number | null) => anchor({ asOf: US1, date: "2026-09-25", quantity, cost, price });
  const b0 = anchor({ asOf: US2, date: "2026-09-28", quantity: 0, cost: 0 });
  const us = (buyQ: number, buyA: number, sellQ: number, sellA: number) => [
    fill({ side: "BUY", quantity: buyQ, amount: buyA, at: "2026-09-01T23:00:00+09:00" }),
    fill({ side: "SELL", quantity: sellQ, amount: sellA, at: "2026-09-28T23:30:00+09:00" }),
  ];
  const opts = { currency: "USD" as const, stdAt: () => 1350 };

  it("미국 1대8 병합 1,003주 → 126주(끝수 올림) 뒤 126주를 $800 에 모두 팔면: 병합 줄(0.125) · 손익 +$500 · 양도차익 +675,000원 (예전 +$88,200 · +119,070,000원이 '추정 포함'으로 합계에)", () => {
    const f = us(1003, 100_300, 126, 100_800);
    const r = replayPair(f, [b(1003, 100_300, 100), b0], opts);
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 500, costAmount: 100_300 });
    expect(s.std).toEqual({ proceeds: 136_080_000, cost: 135_405_000, missing: null });
    expect(r.estimated).toEqual([{ at: US2, date: "2026-09-28", qty: -877, fromQty: 1003, toQty: 126, reason: "split", ratio: 0.125 }]);
    expect(r.check).toMatchObject({ splits: 1, transfers: 0 });
  });

  it("1,005주 → 101주(1대10, 끝수 올림) · 1대35 병합(1,000주 → 28주, 끝수 현금) · 소수 주식 10.5주 → 1주(1대10, 끝수 현금)도 병합", () => {
    const f1 = us(1005, 100_500, 101, 101_000);
    const r1 = replayPair(f1, [b(1005, 100_500, 100), b0], opts);
    expect(r1.fills.get(f1[1]!.key)!.realized).toMatchObject({ status: "estimated", gross: 500 });
    expect(r1.estimated[0]).toMatchObject({ reason: "split", ratio: 0.1, fromQty: 1005, toQty: 101 });
    const f2 = us(1000, 100_000, 28, 98_000);
    const r2 = replayPair(f2, [b(1000, 100_000, 100), b0], opts);
    expect(r2.fills.get(f2[1]!.key)!.realized).toMatchObject({ status: "estimated", gross: -2000 });
    expect(r2.fills.get(f2[1]!.key)!.std).toEqual({ proceeds: 132_300_000, cost: 135_000_000, missing: null });
    expect(r2.estimated[0]).toMatchObject({ reason: "split", ratio: 0.0286, toQty: 28 });
    // 10.5주 1대10 → 1.05주 → 1주 (0.05주는 현금). 끝수 때문에 1/6 ~ 1/1000 이 모두 수량과 맞지만 판 가격($1,000 = $100 × 10)으로 1/10
    const f3 = us(10.5, 1050, 1, 1000);
    const r3 = replayPair(f3, [b(10.5, 1050, 100), b0], opts);
    expect(r3.fills.get(f3[1]!.key)!.realized).toMatchObject({ status: "estimated", gross: -50 });
    expect(r3.estimated[0]).toMatchObject({ reason: "split", ratio: 0.1, fromQty: 10.5, toQty: 1 });
  });

  it("무상감자 1,000주 → 300주(흔하지 않은 배수) 뒤 모두 팔면: 판 가격이 배수를 따라가 감자로 계산(손익 −10,000, 예전 +700,000)하되 순서 추정", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000, price: 1000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });
    const f = [fill({ side: "SELL", quantity: 300, amount: 990_000, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.splitUncertain, gross: -10_000, costAmount: 1_000_000 });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: -700, fromQty: 1000, toQty: 300, reason: "split", ratio: 0.3 }]);
  });

  it("직전 가격이 없는 1대4 병합(1,000주 → 250주를 $400): 이관으로 두되 매도는 순서 추정 — 가짜 이익 +$75,000 이 '추정'으로 합계에 들지 않는다", () => {
    const f = us(1000, 100_000, 250, 100_000);
    const r = replayPair(f, [b(1000, 100_000, null), b0], opts);
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.changeUncertain, gross: 75_000 });
    expect(r.estimated).toEqual([{ at: US2, date: "2026-09-28", qty: -750, fromQty: 750, toQty: 0, reason: "transfer", sellPx: 400 }]);
    // 판 가격을 알아도 병합 쪽도 이관 쪽도 아니면(250주를 절반 가격 $50 에 팖) 역시 순서 추정
    const g = us(1000, 100_000, 250, 12_500);
    expect(replayPair(g, [b(1000, 100_000, 100), b0], opts).fills.get(g[1]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.changeUncertain });
  });

  it("직전 가격이 없으면 수량이 늘어나는 배수도 받아들이지 않는다: 주문 내역에 없는 입고 1,000주 + 2,000주를 1,000원에 모두 팖 → 순서 추정 · 손익 0 (가짜 분할 +1,000,000 없음)", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000, price: null });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });
    const f = [fill({ side: "SELL", quantity: 2000, amount: 2_000_000, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.oversoldAfter, gross: 0 });
    expect(r.estimated[0]).toMatchObject({ reason: "transfer", qty: 1000 });
  });
});

describe("검토 반영 5차: 권리락·배당락 뒤 새 주식이 늦게 들어와 그 구간에 모두 판 경우 (가격이 먼저 내림)", () => {
  // 기록 6개 (한국 16:05): 1·2일 1,000원 → 3일 권리락 500원 → 5일까지 수량 1,000주 그대로 → 6일 새 주식 1,000주가 들어와 2,000주를 505원에 모두 팖
  const days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"];
  const run = (prices: number[], qty1: number, cost: number, sellQ: number, sellA: number, currency: "KRW" | "USD" = "KRW") => {
    const anchors = days.map((d, i) =>
      i < 5 ? anchor({ asOf: `${d}T16:05:00+09:00`, date: d, quantity: qty1, cost, price: prices[i]! }) : anchor({ asOf: `${d}T16:05:00+09:00`, date: d, quantity: 0, cost: 0 }),
    );
    const f = [fill({ side: "SELL", quantity: sellQ, amount: sellA, at: "2026-09-28T10:00:00+09:00", code: currency === "KRW" ? "005930" : "SOXL" })];
    const r = replayPair(f, anchors, { currency });
    return { r, s: r.fills.get(f[0]!.key)!.realized! };
  };

  it("1주당 1주 무상증자: 권리락 전 가격(1,000원)과 견줘 2배 — 손익 +10,000 (예전 −990,000 순서 추정)", () => {
    const { r, s } = run([1000, 1000, 500, 500, 500], 1000, 1_000_000, 2000, 1_010_000);
    expect(s).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 10_000, costAmount: 1_000_000, avgCost: 500 });
    expect(r.estimated).toEqual([{ at: "2026-09-28T16:05:00+09:00", date: "2026-09-28", qty: 1000, fromQty: 1000, toQty: 2000, reason: "split", ratio: 2 }]);
  });

  it("1.2배 무상증자 (1,000원 → 833원, 1,200주를 840원에 모두 팖): 손익 +8,000 (예전 −192,000) · 미국 5% 주식배당 ($100 → $95.24, 1,050주를 $96): +$800 (예전 −$4,998 쪽)", () => {
    const kr = run([1000, 1000, 833, 833, 833], 1000, 1_000_000, 1200, 1_008_000);
    expect(kr.s).toMatchObject({ status: "estimated", gross: 8000 });
    expect(kr.r.estimated[0]).toMatchObject({ reason: "split", ratio: 1.2 });
    const us = run([100, 100, 95.24, 95.24, 95.24], 1000, 100_000, 1050, 100_800, "USD");
    expect(us.s).toMatchObject({ status: "estimated", gross: 800 });
    expect(us.r.estimated[0]).toMatchObject({ reason: "split", ratio: 1.05 });
  });

  it("앞 기록에서 가격이 한 번에 내린 적이 없으면 늦게 들어온 새 주식으로 보지 않는다 (500원 그대로 → 입고 1,000주 + 순서 추정)", () => {
    const { r, s } = run([500, 500, 500, 500, 500], 1000, 1_000_000, 2000, 1_010_000);
    expect(s).toMatchObject({ status: "order-uncertain", reason: REASONS.oversoldAfter });
    expect(r.estimated[0]).toMatchObject({ reason: "transfer", qty: 1000 });
  });
});

describe("검토 반영 5차: 같은 구간 안 행동 전 매매 (시간외 NXT·미국 애프터마켓 뒤 행동, 기록이 빠진 날) — 행동 시점을 몫 사이에서도 찾는다", () => {
  const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 1_000_000, price: 1000 });
  const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 0, cost: 0 });
  // 9/25 17:00 NXT 시간외(분할 전) · 9/28 10:00 (1→4 분할 뒤)
  const nxt = (q: number, a: number) => fill({ side: "SELL", quantity: q, amount: a, at: "2026-09-25T17:00:00+09:00", code: "005930" });
  const day = (q: number, a: number) => fill({ side: "SELL", quantity: q, amount: a, at: "2026-09-28T10:00:00+09:00", code: "005930" });

  it("분할 전 100주(1,000원) + 분할 뒤 3,600주(250원): 두 매도 모두 손익 0 (예전 −2,700,000 순서 추정)", () => {
    const f = [nxt(100, 100_000), day(3600, 900_000)];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "estimated", gross: 0, costAmount: 100_000, avgCost: 1000 });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "estimated", gross: 0, costAmount: 900_000, avgCost: 250 });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 2700, fromQty: 900, toQty: 3600, reason: "split", ratio: 4 }]);
  });

  it("분할 전 500주 + 분할 뒤 2,000주: 2.5배 무상증자로 잘못 보지 않는다 — 매도마다 +300,000 / −300,000 대신 0 · 0", () => {
    const f = [nxt(500, 500_000), day(2000, 500_000)];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    for (const x of f) expect(r.fills.get(x.key)!.realized).toMatchObject({ status: "estimated", gross: 0 });
    expect(r.estimated).toEqual([{ at: a2.asOf, date: "2026-09-28", qty: 1500, fromQty: 500, toQty: 2000, reason: "split", ratio: 4 }]);
  });

  it("다음 기록에 수량이 남아도 (분할 전 100주 + 분할 뒤 400주 매도, 토스 3,200주 · 800,000원): 가운데 시점 분할 — 손익 0 · 0, 평균 250", () => {
    const b2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 3200, cost: 800_000 });
    const f = [nxt(100, 100_000), day(400, 100_000)];
    const r = replayPair(f, [a1, b2], { currency: "KRW" });
    for (const x of f) expect(r.fills.get(x.key)!.realized).toMatchObject({ status: "estimated", reason: REASONS.split, gross: 0 });
    expect(r.estimated).toEqual([{ at: b2.asOf, date: "2026-09-28", qty: 2700, fromQty: 900, toQty: 3600, reason: "split", ratio: 4 }]);
    expect(r.holding).toEqual({ quantity: 3200, avgCost: 250 });
    // 가격을 모르면 가운데 시점은 보지 않는다 (예전처럼 이관)
    expect(replayPair(f, [{ ...a1, price: null }, b2], { currency: "KRW" }).estimated[0]).toMatchObject({ reason: "transfer" });
  });
});

describe("검토 반영 5차: 수량은 같은데 토스 매입금액이 줄어듦 (분사 등)", () => {
  const f = [
    fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
    fill({ side: "SELL", quantity: 1000, amount: 80_000, at: "2026-09-29T23:30:00+09:00" }),
  ];
  const b1 = anchor({ asOf: "2026-09-26T05:05:00+09:00", date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 });

  it("토스 매입금액 $100,000 → $80,000: 결제일 원화 취득가도 같은 비율(×0.8)로 고쳐 추정 — 가짜 손실 −27,000,000원 없음", () => {
    const b2 = anchor({ asOf: "2026-09-29T05:05:00+09:00", date: "2026-09-28", quantity: 1000, cost: 80_000, price: 80 });
    const r = replayPair(f, [b1, b2], { currency: "USD", stdAt: () => 1350 });
    const s = r.fills.get(f[1]!.key)!;
    expect(s.realized).toMatchObject({ status: "ok", gross: 0, costAmount: 80_000 });
    expect(s.std).toEqual({ proceeds: 108_000_000, cost: 108_000_000, missing: null, estimated: true });
    expect(r.check.drift).toBe(1);
  });

  it("0.5% 이하 차이는 고치지 않고 추정 표시도 없다", () => {
    const b2 = anchor({ asOf: "2026-09-29T05:05:00+09:00", date: "2026-09-28", quantity: 1000, cost: 100_300, price: 100 });
    const s = replayPair(f, [b1, b2], { currency: "USD", stdAt: () => 1350 }).fills.get(f[1]!.key)!;
    expect(s.std).toEqual({ proceeds: 108_000_000, cost: 135_000_000, missing: null });
  });
});
