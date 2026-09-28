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


describe("스냅샷 사이 수량 변화 — 주문 내역으로 설명되지 않으면 계산하지 않는다 (검토 반영 7차 보수 규칙)", () => {
  it("분할 1→4 (매입금액 같음) + 사이 매도: 그 매도는 손익 없음('unexplained'), 바뀐 것 줄 + 비율 짐작은 이름표로만", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1_000_000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 36, cost: 900_000 });
    const f = [fill({ side: "SELL", quantity: 1, amount: 130_000, at: "2026-09-28T09:30:00+09:00", code: "005930" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    const row = { at: a2.asOf, date: "2026-09-28", fromDate: "2026-09-25", kind: "unexplained", fromQty: 10, toQty: 36, expectedQty: 9, text: "수량 10 → 36주 · 기록된 매매대로라면 9주", guess: "1→4 분할로 보여요(추정)" };
    expect(r.changes).toEqual([row]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "unexplained", reason: REASONS.unexplained, change: row.text, guess: row.guess, gross: null, rate: null, avgCost: null, costAmount: null, net: null });
    expect(r.skips).toEqual([{ from: a1.asOf, to: a2.asOf }]);
    expect(r.check).toMatchObject({ unexplained: 1, priceJumps: 0 });
    // 끝 기록(토스 매입금액)에서 다시 출발 — 지금 보유는 토스 값
    expect(r.holding).toEqual({ quantity: 36, avgCost: 25_000 });
  });

  it("이관 입고 (매도 없음): 바뀐 것 줄만, 그 뒤 매도는 끝 기록의 토스 평균에서 보통 계산 (§9-11)", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", date: "2026-09-25", quantity: 10, cost: 1_000_000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", date: "2026-09-28", quantity: 20, cost: 2_300_000 });
    const f = [fill({ side: "SELL", quantity: 1, amount: 110_000, at: "2026-09-29T09:30:00+09:00", code: "035420" })];
    const r = replayPair(f, [a1, a2], { currency: "KRW" });
    expect(r.changes).toEqual([{ at: a2.asOf, date: "2026-09-28", fromDate: "2026-09-25", kind: "unexplained", fromQty: 10, toQty: 20, expectedQty: 10, text: "수량 10 → 20주 · 그 사이 기록된 매매 없음", guess: null }]);
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2026-09-28", gross: -5_000 });
    expect(r.check.unexplained).toBe(1);
  });

  it("수량이 같고 매입금액 차이가 0.5% 안이면 설명된 것 — 조용히 토스 값으로 맞춘다 (점검에 drift), 0.5% 넘으면 설명되지 않음", () => {
    const a1 = anchor({ asOf: "2026-09-25T16:05:00+09:00", quantity: 10, cost: 1000 });
    const a2 = anchor({ asOf: "2026-09-28T16:05:00+09:00", quantity: 20, cost: 2002 });
    const f = [fill({ side: "BUY", quantity: 10, amount: 1000, at: "2026-09-28T01:00:00+09:00" })];
    const r = replayPair(f, [a1, a2], { currency: "USD" });
    expect(r.changes).toEqual([]);
    expect(r.skips).toEqual([]);
    expect(r.check.drift).toBe(1);
    expect(r.holding.avgCost).toBeCloseTo(100.1, 6);
    const far = replayPair(f, [a1, anchor({ ...a2, cost: 2012 })], { currency: "USD" });
    expect(far.changes).toMatchObject([{ kind: "unexplained", text: "토스 매입금액 $2,012.00 · 기록된 매매대로라면 $2,000.00 (수량 20주는 같아요)" }]);
    expect(far.fills.get(f[0]!.key)!.afterBuy).toBeNull();
  });
});

describe("검토 반영 7차: 예전에 비율을 추정하던 경우는 모두 '계산에서 뺀 매도' — 틀린 숫자가 어디에도 들지 않는다", () => {
  const A1 = "2026-09-25T16:05:00+09:00";
  const A2 = "2026-09-28T16:05:00+09:00";
  const a1 = anchor({ asOf: A1, date: "2026-09-25", quantity: 1000, cost: 1_000_000, price: 1000 });
  const end = (quantity: number, cost: number | null, price: number | null = null) => anchor({ asOf: A2, date: "2026-09-28", quantity, cost, price });
  const kr = (side: "BUY" | "SELL", quantity: number, amount: number, day = "2026-09-28", hm = "10:00") => fill({ side, quantity, amount, at: `${day}T${hm}:00+09:00`, code: "005930" });
  const dropped = { status: "unexplained", reason: REASONS.unexplained, gross: null, rate: null, avgCost: null, costAmount: null, net: null, krw: null };

  it("1→4 분할 뒤 4,000주를 250원에 모두 팖 (다음 기록 0주): 손익 없음 · '기록된 매도가 그때 가진 수량보다 많았어요' · 이름표 '1→4 분할로 보여요(추정)'", () => {
    const f = [kr("SELL", 4000, 1_000_000)];
    const r = replayPair(f, [a1, end(0, 0)], { currency: "KRW" });
    const text = "기록된 매도가 그때 가진 수량보다 많았어요 · 수량 1,000 → 0주";
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: text, guess: "1→4 분할로 보여요(추정)" });
    expect(r.changes).toEqual([{ at: A2, date: "2026-09-28", fromDate: "2026-09-25", kind: "unexplained", fromQty: 1000, toQty: 0, expectedQty: -3000, text, guess: "1→4 분할로 보여요(추정)" }]);
    expect(r.skips).toEqual([{ from: A1, to: A2 }]);
    expect(r.holding).toEqual({ quantity: 0, avgCost: null });
    // 직전 가격이 없으면 이름표도 없다 (짐작할 근거가 없음) — 숫자는 어느 쪽이든 없음
    const noPx = replayPair(f, [{ ...a1, price: null }, end(0, 0)], { currency: "KRW" });
    expect(noPx.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, guess: null });
  });

  it("4→1 병합 뒤 250주를 4,000원에 모두 팖: 손익 없음 · '수량 1,000 → 0주 · 기록된 매매대로라면 750주' · '4→1 병합으로 보여요(추정)'", () => {
    const f = [kr("SELL", 250, 1_000_000)];
    const r = replayPair(f, [a1, end(0, 0)], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: "수량 1,000 → 0주 · 기록된 매매대로라면 750주", guess: "4→1 병합으로 보여요(추정)" });
    // 부분 매도 뒤 출고(보통 가격 1,000원에 250주)는 병합처럼 보이지 않는다 — 이름표 없음, 숫자는 역시 없음
    const part = [kr("SELL", 250, 250_000)];
    expect(replayPair(part, [a1, end(0, 0)], { currency: "KRW" }).fills.get(part[0]!.key)!.realized).toMatchObject({ ...dropped, guess: null });
  });

  it("1→4 분할 뒤 두 번에 나눠 모두 팖: 두 매도 모두 손익 없음, 바뀐 것 줄은 하나", () => {
    const f = [kr("SELL", 2000, 500_000, "2026-09-28", "09:30"), kr("SELL", 2000, 500_000, "2026-09-28", "10:30")];
    const r = replayPair(f, [a1, end(0, 0)], { currency: "KRW" });
    for (const x of f) expect(r.fills.get(x.key)!.realized).toMatchObject(dropped);
    expect(r.changes).toHaveLength(1);
  });

  it("1→4 분할 뒤 5주 매도 (토스 3,995주 · 998,750원): 그 매도 손익 없음 · 다음 구간은 토스 평균 250원에서 보통 계산", () => {
    const f = [kr("SELL", 5, 1250), kr("SELL", 995, 258_700, "2026-09-29")];
    const r = replayPair(f, [a1, end(3995, 998_750, 250)], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: "수량 1,000 → 3,995주 · 기록된 매매대로라면 995주", guess: "1→4 분할로 보여요(추정)" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "snapshot", anchorDate: "2026-09-28", avgCost: 250, costAmount: 248_750, gross: 9_950 });
    expect(r.holding).toEqual({ quantity: 3000, avgCost: 250 });
  });

  it("분할 날 주가가 −5%·−12% 더 움직여도 (237.5원·220원에 모두 팖) 손익 없음 — 가격 허용폭으로 비율을 맞추지 않는다", () => {
    for (const px of [237.5, 220]) {
      const f = [kr("SELL", 4000, 4000 * px)];
      const r = replayPair(f, [a1, end(0, 0)], { currency: "KRW" });
      expect(r.fills.get(f[0]!.key)!.realized).toMatchObject(dropped);
      expect(r.skips).toEqual([{ from: A1, to: A2 }]);
    }
  });

  it("주식배당 1.05 (매입금액 그대로, 매도 없음) · 1.03 뒤 모두 팖: 손익 없음, 이름표 '무상증자·주식배당(주식 수 ×1.05)'", () => {
    const r = replayPair([], [a1, end(1050, 1_000_000, 952)], { currency: "KRW" });
    expect(r.changes).toEqual([
      { at: A2, date: "2026-09-28", fromDate: "2026-09-25", kind: "unexplained", fromQty: 1000, toQty: 1050, expectedQty: 1000, text: "수량 1,000 → 1,050주 · 그 사이 기록된 매매 없음", guess: "무상증자·주식배당(주식 수 ×1.05)으로 보여요(추정)" },
    ]);
    const f = [kr("SELL", 1030, 999_100)];
    const r2 = replayPair(f, [a1, end(0, 0)], { currency: "KRW" });
    expect(r2.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, guess: "무상증자·주식배당(주식 수 ×1.03)으로 보여요(추정)" });
    // 같은 수량이라도 보통 가격(1,000원)에 팔았으면 입고와 구별할 수 없어 이름표 없음
    const g = [kr("SELL", 1030, 1_030_000)];
    expect(replayPair(g, [a1, end(0, 0)], { currency: "KRW" }).fills.get(g[0]!.key)!.realized).toMatchObject({ ...dropped, guess: null });
  });

  it("주문 내역에 없는 입고 + 모두 팖 + 다시 삼: 판 것은 손익 없음, 다시 산 뒤 평균도 보이지 않음, 다음 구간은 토스 값에서", () => {
    const b1 = anchor({ asOf: A1, date: "2026-09-25", quantity: 10, cost: 1_000_000, price: 100_000 });
    const f = [kr("SELL", 15, 1_650_000), kr("BUY", 3, 315_000, "2026-09-28", "11:00"), kr("SELL", 3, 321_000, "2026-09-29")];
    const r = replayPair(f, [b1, end(3, 315_000, 106_000)], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: "기록된 매도가 그때 가진 수량보다 많았어요 · 수량 10 → 3주", guess: null });
    expect(r.fills.get(f[1]!.key)!.afterBuy).toBeNull();
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ status: "ok", gross: 6_000, avgCost: 105_000 });
  });

  it("입고 10주 뒤 2주 매도 (토스 18주 · 2,070,000원): 예전처럼 기록 평균으로 '추정' +30,000 을 넣지 않고 손익 없음", () => {
    const b1 = anchor({ asOf: A1, date: "2026-09-25", quantity: 10, cost: 1_000_000, price: 100_000 });
    const f = [kr("SELL", 2, 230_000)];
    const r = replayPair(f, [b1, end(18, 2_070_000, 115_000)], { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: "수량 10 → 18주 · 기록된 매매대로라면 8주", guess: null });
  });

  it("분사처럼 수량은 같은데 토스 매입금액이 0.5% 넘게 줄면: 그 구간 매도는 손익 없음, 다음 구간은 토스 값 · 결제일 원화 취득가는 그 뒤 모름('changed')", () => {
    const US1 = "2026-09-26T05:05:00+09:00";
    const US2 = "2026-09-29T05:05:00+09:00";
    const f = [
      fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 500, amount: 20_000, at: "2026-09-28T23:30:00+09:00" }),
      fill({ side: "SELL", quantity: 500, amount: 21_000, at: "2026-09-29T23:30:00+09:00" }),
    ];
    const b1 = anchor({ asOf: US1, date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 });
    const b2 = anchor({ asOf: US2, date: "2026-09-28", quantity: 500, cost: 40_000, price: 40 });
    const r = replayPair(f, [b1, b2], { currency: "USD", stdAt: () => 1350 });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ ...dropped, change: "토스 매입금액 $40,000.00 · 기록된 매매대로라면 $50,000.00 (수량 500주는 같아요)" });
    expect(r.fills.get(f[1]!.key)!.std).toEqual({ proceeds: 27_000_000, cost: null, missing: "unexplained" });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ status: "ok", gross: -19_000, costAmount: 40_000 });
    expect(r.fills.get(f[2]!.key)!.std).toEqual({ proceeds: 28_350_000, cost: null, missing: "changed" });
    expect(r.skips).toEqual([{ from: US1, to: US2 }]);
  });

  it("큰 주가 변화 뒤 새 주식이 늦게 들어온 무상증자 (권리락 −50% · 주식 수 그대로 → 사이 매도 → 새 주식): 권리락부터 새 주식 기록까지 매도 손익 없음·수익률 건너뜀, 그 뒤는 보통", () => {
    const days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"];
    const at = (i: number) => `${days[i]}T16:05:00+09:00`;
    const rows: Array<[number, number, number]> = [
      [1000, 1_000_000, 1000],
      [1000, 1_000_000, 1000],
      [1000, 1_000_000, 500],
      [800, 800_000, 505],
      [800, 800_000, 510],
      [1800, 800_000, 500],
      [900, 400_000, 520],
    ];
    const anchors = rows.map(([quantity, cost, price], i) => anchor({ asOf: at(i), date: days[i]!, quantity, cost, price }));
    const f = [kr("SELL", 200, 101_000, "2026-09-24"), kr("SELL", 900, 468_000, "2026-09-29")];
    const r = replayPair(f, anchors, { currency: "KRW" });
    const jump = "주가 1,000원 → 500원 (−50%) · 주식 수 1,000주 그대로";
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction, change: `9월 23일 기록: ${jump}`, guess: "1→2 분할·무상증자일 수 있어요(추정)" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", anchorDate: "2026-09-28", costAmount: 400_000, gross: 68_000 });
    expect(r.changes).toEqual([
      { at: at(2), date: "2026-09-23", fromDate: "2026-09-22", kind: "possible-action", fromQty: 1000, toQty: 1000, expectedQty: 1000, text: jump, guess: "1→2 분할·무상증자일 수 있어요(추정)" },
      { at: at(5), date: "2026-09-28", fromDate: "2026-09-25", kind: "unexplained", fromQty: 800, toQty: 1800, expectedQty: 800, text: "수량 800 → 1,800주 · 그 사이 기록된 매매 없음", guess: null },
    ]);
    expect(r.skips).toEqual([{ from: at(1), to: at(5) }]);
    expect(r.check).toMatchObject({ unexplained: 1, priceJumps: 1 });
  });

  it("큰 주가 변화 뒤 90일 안에 주식 수 변화가 없으면 그 구간만 건너뜀 · 기록이 90일 안에 끝나면 지금까지(마지막 기록 뒤 매도 포함) 계산하지 않음", () => {
    const d = (n: number) => new Date(Date.UTC(2026, 5, 1 + n, 7, 5)).toISOString().replace(".000Z", "Z");
    const mk = (n: number, price: number) => anchor({ asOf: d(n), date: d(n).slice(0, 10), quantity: 1000, cost: 1_000_000, price });
    // 0일 1,000원 → 1일 600원(−40%) → 그 뒤 10일마다 기록 (130일까지), 50일째 100주 매도
    const long = [mk(0, 1000), mk(1, 600), ...Array.from({ length: 13 }, (_, i) => mk(10 * (i + 1), 600))];
    const f = [fill({ side: "SELL", quantity: 100, amount: 61_000, at: d(45), code: "005930" })];
    const withSell = long.map((a, i) => (i >= 6 ? { ...a, quantity: 900, cost: 900_000 } : a));
    const r = replayPair(f, withSell, { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: 61_000 - 100_000 });
    expect(r.skips).toEqual([{ from: d(0), to: d(1) }]);
    // 기록이 30일째에 끝나면: 새 주식이 아직 올 수 있어 30일째까지 · 그 뒤 매도도 계산하지 않는다
    const short = [mk(0, 1000), mk(1, 600), mk(10, 600), mk(20, 600), mk(30, 600)];
    const g = [fill({ side: "SELL", quantity: 100, amount: 61_000, at: d(31), code: "005930" })];
    const r2 = replayPair(g, short, { currency: "KRW" });
    expect(r2.fills.get(g[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction });
    expect(r2.skips).toEqual([{ from: d(0), to: null }]);
  });

  it("마지막 기록 뒤(다음 기록 전): 가진 수량보다 많이 판 매도·직전 주가에서 크게 벗어난 가격의 매도는 손익 없음, 보통 매도는 그대로", () => {
    const over = [kr("SELL", 4000, 1_000_000)];
    const r = replayPair(over, [a1], { currency: "KRW" });
    expect(r.fills.get(over[0]!.key)!.realized).toMatchObject({ ...dropped, change: "기록된 매도가 그때 가진 수량보다 많았어요 · 9월 25일 기록 1,000주" });
    expect(r.skips).toEqual([{ from: A1, to: null }]);
    expect(r.changes).toEqual([]);
    const cheap = [kr("SELL", 100, 25_000)];
    expect(replayPair(cheap, [a1], { currency: "KRW" }).fills.get(cheap[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction, change: "매도 가격 250원 · 직전 기록 주가 1,000원보다 −75%" });
    const normal = [kr("SELL", 100, 110_000)];
    const ok = replayPair(normal, [a1], { currency: "KRW" });
    expect(ok.fills.get(normal[0]!.key)!.realized).toMatchObject({ status: "ok", gross: 10_000 });
    expect(ok.skips).toEqual([]);
  });

  it("미국 기준: ±60% 안의 주가 변화는 큰 주가 변화가 아니다 ($100 → $45 는 −55%) · 넘으면 건너뜀", () => {
    const US1 = "2026-09-26T05:05:00+09:00";
    const US2 = "2026-09-29T05:05:00+09:00";
    const b = (price: number, asOf: string, date: string) => anchor({ asOf, date, quantity: 10, cost: 1000, price });
    expect(replayPair([], [b(100, US1, "2026-09-25"), b(45, US2, "2026-09-28")], { currency: "USD" }).skips).toEqual([]);
    const r = replayPair([], [b(100, US1, "2026-09-25"), b(30, US2, "2026-09-28")], { currency: "USD" });
    expect(r.skips).toEqual([{ from: US1, to: null }]);
    expect(r.changes).toMatchObject([{ kind: "possible-action", text: "주가 $100.00 → $30.00 (−70%) · 주식 수 10주 그대로", guess: null }]);
  });

  it("'하루' 변화만 본다: 기록이 빠져 평일 2일 넘게 걸친 구간의 큰 주가 변화(한국 하한가 두 번 등)와 마지막 기록 뒤 여러 날 지난 체결은 큰 주가 변화로 보지 않는다", () => {
    const b2 = anchor({ asOf: "2026-09-30T16:05:00+09:00", date: "2026-09-30", quantity: 1000, cost: 1_000_000, price: 600 });
    expect(replayPair([], [a1, b2], { currency: "KRW" }).skips).toEqual([]);
    const late = [kr("SELL", 100, 60_000, "2026-09-30")];
    expect(replayPair(late, [a1], { currency: "KRW" }).fills.get(late[0]!.key)!.realized).toMatchObject({ status: "ok", gross: -40_000 });
    // 다음 거래일(금 → 월) 체결은 본다
    const next = [kr("SELL", 100, 60_000, "2026-09-28")];
    expect(replayPair(next, [a1], { currency: "KRW" }).fills.get(next[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction });
    // 미국 체결은 뉴욕 날짜로 센다 (한국 9/29 새벽 1시 = 뉴욕 9/28 월)
    const US1 = "2026-09-26T05:05:00+09:00";
    const us = [fill({ side: "SELL", quantity: 1, amount: 30, at: "2026-09-29T01:00:00+09:00" })];
    expect(replayPair(us, [anchor({ asOf: US1, date: "2026-09-25", quantity: 10, cost: 1000, price: 100 })], { currency: "USD" }).fills.get(us[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction });
  });

  it("분할 날 늦게 본 매수 + 매도 (순서 모름): 두 순서 모두 토스 기록과 맞지 않으면 설명되지 않음 — 매도 손익 없음, 매수 뒤 평균도 없음", () => {
    const US1 = "2026-09-26T05:05:00+09:00";
    const US2 = "2026-09-29T05:05:00+09:00";
    const f = [
      fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 2000, amount: 50_000, at: "2026-09-28T23:30:00+09:00" }),
      fill({ side: "BUY", quantity: 2000, amount: 70_000, at: US2, basis: "seen" }),
    ];
    const r = replayPair(f, [anchor({ asOf: US1, date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 }), anchor({ asOf: US2, date: "2026-09-28", quantity: 4000, cost: 120_000, price: 25 })], {
      currency: "USD",
      stdAt: () => 1350,
    });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject(dropped);
    expect(r.fills.get(f[1]!.key)!.std).toMatchObject({ cost: null, missing: "unexplained" });
    expect(r.fills.get(f[2]!.key)!.afterBuy).toBeNull();
  });

  it("같은 날 순서를 모르는 매수·매도: 매도 먼저 순서만 토스 매입금액과 맞으면 그 값 — 설명된 구간이라 '순서 추정' 그대로", () => {
    const US1 = "2026-09-26T05:05:00+09:00";
    const US2 = "2026-09-29T05:05:00+09:00";
    const f = [
      fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }),
      fill({ side: "SELL", quantity: 500, amount: 60_000, at: "2026-09-28T23:30:00+09:00" }),
      fill({ side: "BUY", quantity: 500, amount: 55_000, at: US2, basis: "seen" }),
    ];
    const r = replayPair(f, [anchor({ asOf: US1, date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 }), anchor({ asOf: US2, date: "2026-09-28", quantity: 1000, cost: 105_000, price: 110 })], { currency: "USD" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.orderUncertain, gross: 10_000 });
    expect(r.check.drift).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.skips).toEqual([]);
  });

  it("미국 보통 구간: 결제일 원화 취득가를 이어 쓰고, 설명되지 않은 구간(분할 4,000주) 뒤에는 달러·원화 장부 손익은 토스 값에서 보통 계산하되 결제일 원화 취득가는 모름", () => {
    const US1 = "2026-09-26T05:05:00+09:00";
    const US2 = "2026-09-29T05:05:00+09:00";
    const buy = fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" });
    const b1 = anchor({ asOf: US1, date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 });
    const plain = [buy, fill({ side: "SELL", quantity: 500, amount: 55_000, at: "2026-09-28T23:30:00+09:00" })];
    expect(replayPair(plain, [b1], { currency: "USD", stdAt: () => 1350 }).fills.get(plain[1]!.key)!.std).toEqual({ proceeds: 74_250_000, cost: 67_500_000, missing: null });
    const later = fill({ side: "SELL", quantity: 1000, amount: 26_000, at: "2026-09-29T23:30:00+09:00" });
    const r = replayPair([buy, later], [b1, anchor({ asOf: US2, date: "2026-09-28", quantity: 4000, cost: 100_000, costKrw: 139_000_000, price: 25 })], { currency: "USD", stdAt: () => 1350, fxAt: () => 1400 });
    const s = r.fills.get(later.key)!;
    expect(s.realized).toMatchObject({ status: "ok", gross: 1_000, costAmount: 25_000, avgCost: 25 });
    expect(s.realized!.krw).toMatchObject({ gross: 1_650_000, costKrw: 34_750_000 });
    expect(s.std).toEqual({ proceeds: 35_100_000, cost: null, missing: "changed" });
  });
});

describe("검토 반영 8차: 휴장일 다음 날 권리락 · 끝이 0주인 구간 · 같은 시각 사고팔기 · 0주에서 새로 산 몫", () => {
  const dropped = { status: "unexplained", reason: REASONS.unexplained, gross: null, rate: null, avgCost: null, costAmount: null, net: null, krw: null };
  const kst = (d: string, hm = "16:05") => `${d}T${hm}:00+09:00`;
  const kr = (side: "BUY" | "SELL", quantity: number, amount: number, day: string, hm = "10:00") => fill({ side, quantity, amount, at: kst(day, hm), code: "005930" });
  const krA = (date: string, quantity: number, cost: number, price: number | null = null) => anchor({ asOf: kst(date), date, quantity, cost, price });

  it("(꼭) 추석 연휴(9/24·9/25) 다음 거래일의 권리락 −50%: 하루 변화로 보고 새 주식 기록까지 매도는 계산에서 뺌·수익률 건너뜀 (평일로 세면 놓쳐 −99,000 이 'ok')", () => {
    const rows: Array<[string, number, number, number]> = [
      ["2026-09-22", 1000, 1_000_000, 1000],
      ["2026-09-23", 1000, 1_000_000, 1000],
      ["2026-09-28", 1000, 1_000_000, 500],
      ["2026-09-29", 1000, 1_000_000, 505],
      ["2026-09-30", 800, 800_000, 510],
      ["2026-10-01", 800, 800_000, 500],
      ["2026-10-02", 800, 800_000, 500],
      ["2026-10-06", 800, 800_000, 500],
      ["2026-10-13", 800, 800_000, 500],
      ["2026-10-14", 1800, 800_000, 500],
      ["2026-10-15", 1800, 800_000, 505],
    ];
    const anchors = rows.map(([d, q, c, p]) => krA(d, q, c, p));
    const f = [kr("SELL", 200, 101_000, "2026-09-30")];
    const r = replayPair(f, anchors, { currency: "KRW" });
    const jump = "주가 1,000원 → 500원 (−50%) · 주식 수 1,000주 그대로";
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction, change: `9월 28일 기록: ${jump}`, guess: "1→2 분할·무상증자일 수 있어요(추정)" });
    expect(r.skips).toEqual([{ from: kst("2026-09-23"), to: kst("2026-10-14") }]);
    expect(r.changes.map((c) => [c.kind, c.fromDate, c.date])).toEqual([
      ["possible-action", "2026-09-23", "2026-09-28"],
      ["unexplained", "2026-10-13", "2026-10-14"],
    ]);
    // 마지막 기록 뒤 체결 가격도 거래일로 센다: 9/23 기록 뒤 9/28 매도 500원은 하루 변화
    const g = [kr("SELL", 100, 50_000, "2026-09-28")];
    expect(replayPair(g, [krA("2026-09-23", 1000, 1_000_000, 1000)], { currency: "KRW" }).fills.get(g[0]!.key)!.realized).toMatchObject({
      ...dropped,
      reason: REASONS.possibleAction,
      change: "매도 가격 500원 · 직전 기록 주가 1,000원보다 −50%",
    });
  });

  it("(꼭) 미국 노동절(9/7) 다음 날 늦게 반영된 1→4 분할(−75%, 수량 그대로)에 옛 수량 10주를 모두 팖: −$750 을 넣지 않고 계산에서 뺌", () => {
    const f = [fill({ side: "SELL", quantity: 10, amount: 250, at: "2026-09-08T23:30:00+09:00" })];
    const a = anchor({ asOf: "2026-09-05T05:05:00+09:00", date: "2026-09-04", quantity: 10, cost: 1000, price: 100 });
    const b = anchor({ asOf: "2026-09-09T05:05:00+09:00", date: "2026-09-08", quantity: 0, cost: 0 });
    const r = replayPair(f, [a, b], { currency: "USD", stdAt: () => 1350 });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction, change: "매도 가격 $25.00 · 직전 기록 주가 $100.00보다 −75%", guess: "1→4 분할·무상증자일 수 있어요(추정)" });
    expect(r.fills.get(f[0]!.key)!.std).toEqual({ proceeds: 337_500, cost: null, missing: "unexplained" });
    expect(r.skips).toEqual([{ from: a.asOf, to: b.asOf }]);
  });

  it("(꼭) 분사 당일 모회사를 전부 팖 (끝 0주): 같은 구간에 다른 종목이 주문 없이 들어왔으면 계산에서 뺌 — 행동 전 원가로 −$20,000 을 넣지 않음", () => {
    const US1 = "2026-09-26T05:05:00+09:00";
    const US2 = "2026-09-29T05:05:00+09:00";
    const f = [fill({ side: "BUY", quantity: 1000, amount: 100_000, at: "2026-09-01T23:00:00+09:00" }), fill({ side: "SELL", quantity: 1000, amount: 80_000, at: "2026-09-28T23:30:00+09:00" })];
    const anchors = [anchor({ asOf: US1, date: "2026-09-25", quantity: 1000, cost: 100_000, price: 100 }), anchor({ asOf: US2, date: "2026-09-28", quantity: 0, cost: 0 })];
    const run = (arrivals?: Map<string, number | null>) => replayPair(f, anchors, { currency: "USD", stdAt: () => 1390, ...(arrivals ? { arrivals } : {}) });
    const r = run(new Map([[US2, 20_000]]));
    const text = "수량 1,000 → 0주 · 같은 기간 다른 종목이 주문 없이 들어와(분사 등일 수 있어요) 매입금액을 맞춰 보지 못했어요";
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ ...dropped, change: text, guess: null });
    expect(r.fills.get(f[1]!.key)!.std).toEqual({ proceeds: 111_200_000, cost: null, missing: "unexplained" });
    expect(r.changes).toEqual([{ at: US2, date: "2026-09-28", fromDate: "2026-09-25", kind: "unexplained", fromQty: 1000, toQty: 0, expectedQty: 0, text, guess: null }]);
    expect(r.skips).toEqual([{ from: US1, to: US2 }]);
    // 들어온 종목의 매입금액을 모르면 역시 뺌
    expect(run(new Map([[US2, null]])).fills.get(f[1]!.key)!.realized).toMatchObject(dropped);
    // 다른 종목이 들어오지 않았거나(보통 매매), 들어온 몫이 매입금액의 0.5% 보다 작으면(토스 이벤트 주식 1주 등 — 분사였어도 허용폭 안) 보통 계산
    for (const x of [undefined, new Map([[US2, 400]])]) expect(run(x).fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", gross: -20_000 });
    // 반만 팔아 수량이 남으면 원래대로 토스 매입금액으로 맞춰 본다 (들어온 종목과 상관없이 설명되는 구간)
    const half = [f[0]!, fill({ side: "SELL", quantity: 500, amount: 40_000, at: "2026-09-28T23:30:00+09:00" })];
    const h = replayPair(half, [anchors[0]!, anchor({ asOf: US2, date: "2026-09-28", quantity: 500, cost: 50_000, price: 80 })], { currency: "USD", arrivals: new Map([[US2, 20_000]]) });
    expect(h.fills.get(half[1]!.key)!.realized).toMatchObject({ status: "ok", gross: -10_000 });
  });

  it("(권장) 첫 기록이 0주인데 그 뒤 주문 없이 주식이 들어오면(90일 안): 첫 기록 전 매도도 계산에서 뺌 — 권리락 −50% 매도 −500,000 을 'history-checked' 로 넣지 않음", () => {
    const f = [kr("BUY", 10, 1_000_000, "2026-09-01"), kr("SELL", 10, 500_000, "2026-09-03")];
    const r = replayPair(f, [krA("2026-09-10", 0, 0), krA("2026-09-11", 0, 0), krA("2026-09-21", 10, 0, 50_000)], { currency: "KRW" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ ...dropped, change: "첫 기록(9월 10일) 0주 · 9월 21일 기록에서 주문 없이 10주가 들어왔어요(판 뒤 늦게 들어온 새 주식일 수 있어요)" });
    expect(r.fills.get(f[0]!.key)!.afterBuy).toBeNull();
    // 90일 넘게 뒤에 들어오면 보통 계산 그대로
    const late = replayPair(f, [krA("2026-09-10", 0, 0), krA("2026-12-18", 0, 0), krA("2026-12-21", 10, 0, 50_000)], { currency: "KRW" });
    expect(late.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "history-checked", gross: -500_000 });
  });

  it("(권장) 기록 뒤 모두 판 구간(끝 0주 — 매입금액을 맞춰 보지 못함) 다음 90일 안에 같은 종목이 주문 없이 들어오면 그 매도도 계산에서 뺌 (주식배당 3% 처럼 큰 주가 변화로 안 잡히는 권리락)", () => {
    const f = [kr("SELL", 1000, 970_000, "2026-09-22")];
    const anchors = [krA("2026-09-21", 1000, 1_000_000, 1000), krA("2026-09-22", 0, 0), krA("2026-09-23", 0, 0), krA("2026-10-14", 30, 0, 970)];
    const r = replayPair(f, anchors, { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: "수량 1,000 → 0주 · 10월 14일 기록에서 주문 없이 30주가 들어왔어요(판 뒤 늦게 들어온 새 주식일 수 있어요)" });
    expect(r.skips).toEqual([
      { from: kst("2026-09-21"), to: kst("2026-09-22") },
      { from: kst("2026-09-23"), to: kst("2026-10-14") },
    ]);
    // 들어오지 않으면 보통 계산 (−30,000)
    expect(replayPair(f, anchors.slice(0, 3), { currency: "KRW" }).fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: -30_000 });
  });

  it("(9차) C15: 첫 기록 전에 모두 팔고 조금 다시 산 뒤 90일 안에 주문 없이 주식이 들어오면: 모두 판 매도는 계산에서 뺌(예전 −5,000,000 'history-checked') · 다시 산 몫은 보통", () => {
    // 1,000주 10,000,000원 → 권리락 −50% 날 모두 5,000,000원에 팖 → 10주 다시 삼 → 첫 기록 10주 50,000원 → 3주 뒤 1,000주가 주문 없이
    const f = [kr("BUY", 1000, 10_000_000, "2026-09-01"), kr("SELL", 1000, 5_000_000, "2026-09-03"), kr("BUY", 10, 50_000, "2026-09-04")];
    const r = replayPair(f, [krA("2026-09-10", 10, 50_000, 5000), krA("2026-09-11", 10, 50_000, 5000), krA("2026-10-01", 1010, 50_000, 5000)], { currency: "KRW" });
    expect(r.fills.get(f[1]!.key)!.realized).toMatchObject({ ...dropped, change: "첫 기록 전 9월 3일 모두 팔아 0주 · 10월 1일 기록에서 주문 없이 1,000주가 들어왔어요(판 뒤 늦게 들어온 새 주식일 수 있어요)" });
    expect(r.fills.get(f[0]!.key)!.afterBuy).toBeNull();
    expect(r.fills.get(f[2]!.key)!.afterBuy).toEqual({ avgCost: 5000, quantity: 10 });
    // 90일 넘게 뒤에 들어오면 보통 계산 그대로
    const late = replayPair(f, [krA("2026-09-10", 10, 50_000, 5000), krA("2026-12-10", 10, 50_000, 5000), krA("2026-12-11", 1010, 50_000, 5000)], { currency: "KRW" });
    expect(late.fills.get(f[1]!.key)!.realized).toMatchObject({ status: "ok", basis: "history-checked", gross: -5_000_000 });
  });

  it("(9차) C16: 주식배당 3%(−3%) 날 1,000주를 모두 팔고 다른 구간에서 100주를 다시 산 뒤 100 → 130주 입고: 모두 판 매도는 계산에서 뺌(예전 −30,000 'ok') · 다시 산 몫은 보통", () => {
    const f = [kr("SELL", 1000, 970_000, "2026-09-22"), kr("BUY", 100, 97_000, "2026-09-24")];
    const anchors = [krA("2026-09-21", 1000, 1_000_000, 1000), krA("2026-09-22", 0, 0), krA("2026-09-24", 100, 97_000, 970), krA("2026-10-14", 130, 97_000, 970)];
    const r = replayPair(f, anchors, { currency: "KRW" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, change: "수량 1,000 → 0주 · 10월 14일 기록에서 주문 없이 30주가 들어왔어요(판 뒤 늦게 들어온 새 주식일 수 있어요)" });
    expect(r.fills.get(f[1]!.key)!.afterBuy).toEqual({ avgCost: 970, quantity: 100 });
    expect(r.skips).toEqual([
      { from: kst("2026-09-21"), to: kst("2026-09-22") },
      { from: kst("2026-09-24"), to: kst("2026-10-14") },
    ]);
    // 들어오지 않으면 보통 계산 (−30,000)
    expect(replayPair(f, anchors.slice(0, 3), { currency: "KRW" }).fills.get(f[0]!.key)!.realized).toMatchObject({ status: "ok", gross: -30_000 });
  });

  it("(권장) 같은 시각에 체결된 매수·매도는 저장 순서(매도 먼저 저장)로 정하지 않는다: 0주에서 사고판 단타는 보통 계산, 값이 순서에 따라 다르면 '순서 추정'", () => {
    const sell = kr("SELL", 10, 1_100_000, "2026-09-28");
    const buy = kr("BUY", 10, 1_000_000, "2026-09-28");
    const r = replayPair([sell, buy], [krA("2026-09-25", 0, 0), krA("2026-09-28", 0, 0)], { currency: "KRW" });
    expect(r.fills.get(sell.key)!.realized).toMatchObject({ status: "ok", gross: 100_000 });
    expect(r.skips).toEqual([]);
    expect(r.changes).toEqual([]);
    // 가진 주식이 있으면 두 순서 모두 가능 → 매수 먼저 값 + '순서 추정' (토스 매입금액 1,100,000 과 맞음)
    const s2 = kr("SELL", 10, 1_300_000, "2026-09-28");
    const b2 = kr("BUY", 10, 1_200_000, "2026-09-28");
    const r2 = replayPair([s2, b2], [krA("2026-09-25", 10, 1_000_000), krA("2026-09-28", 10, 1_100_000)], { currency: "KRW" });
    expect(r2.fills.get(s2.key)!.realized).toMatchObject({ status: "order-uncertain", reason: REASONS.orderUncertain, gross: 200_000 });
    expect(r2.skips).toEqual([]);
  });

  it("(권장) 큰 주가 변화 뒤 모두 팔고 0주에서 새로 사고판 몫은 보통 계산 — 90일 창은 0주가 된 구간까지만 (미국 −70%)", () => {
    const U = (date: string, asOf: string, quantity: number, cost: number, price: number | null = null) => anchor({ asOf, date, quantity, cost, price });
    const anchors = [
      U("2026-09-23", "2026-09-24T05:05:00+09:00", 10, 1000, 100),
      U("2026-09-24", "2026-09-25T05:05:00+09:00", 10, 1000, 30),
      U("2026-09-25", "2026-09-26T05:05:00+09:00", 0, 0),
      U("2026-09-28", "2026-09-29T05:05:00+09:00", 0, 0),
      U("2026-09-29", "2026-09-30T05:05:00+09:00", 0, 0),
    ];
    const f = [
      fill({ side: "SELL", quantity: 10, amount: 300, at: "2026-09-25T23:30:00+09:00" }),
      fill({ side: "BUY", quantity: 5, amount: 750, at: "2026-09-28T22:40:00+09:00" }),
      fill({ side: "SELL", quantity: 5, amount: 850, at: "2026-09-29T01:00:00+09:00" }),
    ];
    const r = replayPair(f, anchors, { currency: "USD" });
    expect(r.fills.get(f[0]!.key)!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction, change: "9월 24일 기록: 주가 $100.00 → $30.00 (−70%) · 주식 수 10주 그대로" });
    expect(r.fills.get(f[1]!.key)!.afterBuy).toEqual({ avgCost: 150, quantity: 5 });
    expect(r.fills.get(f[2]!.key)!.realized).toMatchObject({ status: "ok", gross: 100 });
    expect(r.skips).toEqual([{ from: anchors[0]!.asOf, to: anchors[2]!.asOf }]);
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
