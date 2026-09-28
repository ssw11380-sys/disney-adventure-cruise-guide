import { describe, expect, it } from "vitest";
import { MIN_POINTS, periodReturns, presetRange, READY_DAYS, type RetFlow, type RetSnap } from "../src/services/journalReturns.js";

/**
 * 기간 수익률 (3-37) — 스냅샷 시간가중 수익률(TWR). 순수 함수, 고정 값.
 * 손계산 예(§3.5): V0 = 10,000,000 → 1일째 매수 1,000,000, V1 = 11,100,000 → 2일째 매도 500,000, V2 = 10,700,000 → +1.82%, 기간 손익 +200,000원
 */

const KR = (date: string, value: number, over: Partial<RetSnap> = {}): RetSnap => ({
  date,
  market: "KR",
  asOf: `${date}T16:05:00+09:00`,
  status: "ok",
  doubted: false,
  fx: null,
  holdings: [{ code: "005930", quantity: 1, price: value, regularClose: value }],
  ...over,
});
const US = (date: string, usd: number, fx: number, asOf: string, over: Partial<RetSnap> = {}): RetSnap => ({
  date,
  market: "US",
  asOf,
  status: "ok",
  doubted: false,
  fx,
  holdings: [{ code: "SOXL", quantity: 1, price: usd, regularClose: usd }],
  ...over,
});
const nextDay = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};
const flow = (market: "KR" | "US", side: "BUY" | "SELL", amount: number, at: string): RetFlow => ({ market, side, amount, at, kind: "trade" });
const days = (n: number, start = "2026-09-28") => {
  const out: string[] = [];
  for (let d = new Date(`${start}T12:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    const s = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !["2026-10-05", "2026-10-09"].includes(s)) out.push(s);
  }
  return out;
};
const ONE = { minDays: 1 };
const q = (from: string, to: string, market: "ALL" | "KR" | "US" = "KR") => ({ requested: { from, to }, market, recordSince: "2026-09-28" });

describe("시간가중 수익률", () => {
  it("손계산: 매수·매도를 빼고 날마다 곱해 +1.82%, 기간 손익 +200,000원 (§9-17)", () => {
    const d = days(3);
    const snaps = [KR(d[0]!, 10_000_000), KR(d[1]!, 11_100_000), KR(d[2]!, 10_700_000)];
    const flows = [flow("KR", "BUY", 1_000_000, `${d[1]}T10:00:00+09:00`), flow("KR", "SELL", 500_000, `${d[2]}T10:00:00+09:00`)];
    const r = periodReturns(q(d[0]!, d[2]!), snaps, flows, ONE);
    expect(r.twr).toBe(1.82);
    expect(r.pnl).toBe(200_000);
    expect(r).toMatchObject({ startValue: 10_000_000, endValue: 10_700_000, buys: 1_000_000, sells: 500_000, currency: "KRW", tradingDays: 3 });
    expect(r.series.map((x) => x.cum)).toEqual([0, 0.91, 1.82]);
  });

  it("사고판 것이 없으면 끝 ÷ 시작 − 1", () => {
    const d = days(2);
    const r = periodReturns(q(d[0]!, d[1]!), [KR(d[0]!, 1_000_000), KR(d[1]!, 1_050_000)], [], ONE);
    expect(r.twr).toBe(5);
    expect(r.pnl).toBe(50_000);
  });

  it("빠진 날(gap)은 앞뒤를 이어 계산하고, 의심 스냅샷은 평가 시점에서 뺀다 (§9-18)", () => {
    const d = days(4);
    const snaps = [KR(d[0]!, 1_000_000), KR(d[1]!, 0, { status: "gap", holdings: [] }), KR(d[2]!, 5, { doubted: true }), KR(d[3]!, 1_100_000)];
    const r = periodReturns(q(d[0]!, d[3]!), snaps, [], ONE);
    expect(r.twr).toBe(10);
    expect(r.gaps).toEqual([d[1]]);
    expect(r.doubtedSkipped).toEqual([d[2]]);
    expect(r.tradingDays).toBe(2);
  });

  it("정규장 종가가 없는 종목은 그때 현재가로 — 몇 번이었는지 센다 (§9-18)", () => {
    const d = days(2);
    const snaps = [
      KR(d[0]!, 0, { holdings: [{ code: "005930", quantity: 2, price: 100, regularClose: 99 }, { code: "000660", quantity: 1, price: 50, regularClose: null }] }),
      KR(d[1]!, 0, { holdings: [{ code: "005930", quantity: 2, price: 110, regularClose: 110 }, { code: "000660", quantity: 1, price: 50, regularClose: 50 }] }),
    ];
    const r = periodReturns(q(d[0]!, d[1]!), snaps, [], ONE);
    expect(r.startValue).toBe(248);
    expect(r.priceBasis).toEqual({ regularClose: 3, priceFallback: 1, fallbackCodes: ["000660"] });
  });

  it("미국(달러)은 달러 값만 — 환율은 넣지 않는다", () => {
    const r = periodReturns(
      { requested: { from: "2026-09-28", to: "2026-09-29" }, market: "US", recordSince: "2026-09-28" },
      [US("2026-09-28", 100, 1390, "2026-09-29T05:05:00+09:00"), US("2026-09-29", 110, 1300, "2026-09-30T05:05:00+09:00")],
      [],
      ONE,
    );
    expect(r).toMatchObject({ twr: 10, currency: "USD", startValue: 100, endValue: 110 });
  });

  it("전체(원화): 한국 16:05·미국 05:05 스냅샷을 시각 순으로 이어 평가, 미국 흐름은 그 구간을 끝내는 미국 스냅샷 환율로 (§9-19)", () => {
    const snaps = [
      KR("2026-09-28", 1_000_000),
      US("2026-09-28", 100, 1400, "2026-09-29T05:05:00+09:00"),
      KR("2026-09-29", 1_010_000),
      US("2026-09-29", 210, 1400, "2026-09-30T05:05:00+09:00"),
    ];
    // 미국 9/29 에 $100 더 삼
    const flows = [flow("US", "BUY", 100, "2026-09-29T23:00:00+09:00")];
    const r = periodReturns({ requested: { from: "2026-09-28", to: "2026-09-29" }, market: "ALL", recordSince: "2026-09-28" }, snaps, flows, ONE);
    // 시작 = 한국 1,000,000 + 미국 140,000 (첫 미국 스냅샷에서 두 시장이 다 있음)
    expect(r.startValue).toBe(1_140_000);
    expect(r.endValue).toBe(1_010_000 + 294_000);
    // 한국 +10,000 (1,140,000 기준 0.877%) → 미국 (294,000 + 1,010,000 − 140,000 − 1,150,000 = 14,000) ÷ (1,150,000 + 140,000) = 1.085% → 누적 약 1.97%
    expect(r.twr).toBe(1.97);
    expect(r.pnl).toBe(1_304_000 - 1_140_000 - 140_000);
    expect(r.currency).toBe("KRW");
  });

  it("주문 내역에 없는 수량 변화(이관)는 그날 가격으로 들어오고 나간 것으로 본다", () => {
    const d = days(2);
    const snaps = [KR(d[0]!, 1_000_000), KR(d[1]!, 2_000_000)];
    const flows: RetFlow[] = [{ market: "KR", side: "BUY", amount: 1_000_000, at: `${d[1]}T16:05:00+09:00`, kind: "transfer" }];
    const r = periodReturns(q(d[0]!, d[1]!), snaps, flows, ONE);
    expect(r.twr).toBe(0);
    expect(r.transfersEstimated).toBe(1);
  });
});

describe("공개 조건 · 기간", () => {
  it("기록 전체가 10거래일 미만이면 ready false (숫자 대신 안내), 10거래일이면 true (§9-20)", () => {
    expect(READY_DAYS).toBe(10);
    const nine = days(9);
    const r9 = periodReturns(q(nine[0]!, nine[8]!), nine.map((d, i) => KR(d, 1_000_000 + i)), []);
    expect(r9).toMatchObject({ ready: false, tradingDays: 9, recordDays: 9, twr: null, pnl: null, series: [] });
    const ten = days(10);
    const r10 = periodReturns(q(ten[0]!, ten[9]!), ten.map((d, i) => KR(d, 1_000_000 + i)), []);
    expect(r10.ready).toBe(true);
    expect(r10).toMatchObject({ tradingDays: 10, recordDays: 10 });
  });

  it("회귀: 공개 조건은 기록 전체 길이 — 기록이 60거래일이면 1주(기간 안 5~6거래일)도 전체·한국·미국 모두 숫자가 나온다", () => {
    const d = days(60, "2026-07-01");
    const today = d.at(-1)!;
    const snaps: RetSnap[] = d.flatMap((x, i) => [KR(x, 1_000_000 + i * 1000), US(x, 100 + i, 1400, `${nextDay(x)}T05:05:00+09:00`)]);
    const range = presetRange("1W", today);
    for (const market of ["ALL", "KR", "US"] as const) {
      const r = periodReturns({ requested: range, market, recordSince: d[0]! }, snaps, []);
      expect(r.ready, market).toBe(true);
      expect(r.recordDays, market).toBe(60);
      expect(r.tradingDays, market).toBeLessThanOrEqual(6);
      expect(r.twr, market).not.toBeNull();
    }
    // 1달도 그대로
    expect(periodReturns({ requested: presetRange("1M", today), market: "KR", recordSince: d[0]! }, snaps, []).ready).toBe(true);
  });

  it("회귀: 기록은 충분한데 고른 기간 안 평가 시점이 1개뿐(하루만 고름)이면 계산하지 않고 ready false — recordDays 로 구분", () => {
    expect(MIN_POINTS).toBe(2);
    const d = days(12);
    const r = periodReturns(q(d[5]!, d[5]!), d.map((x, i) => KR(x, 1_000_000 + i)), []);
    expect(r).toMatchObject({ ready: false, tradingDays: 1, recordDays: 12, twr: null, actual: { from: d[5], to: d[5] } });
    // 기간 안 점이 없음(주말만 고름)
    const w = periodReturns(q("2026-10-03", "2026-10-04"), d.map((x, i) => KR(x, 1_000_000 + i)), []);
    expect(w).toMatchObject({ ready: false, tradingDays: 0, recordDays: 12, actual: null });
  });

  it("고른 기간이 기록 시작보다 앞이면 기록 시작일부터 계산하고 그렇게 알린다", () => {
    const d = days(2);
    const r = periodReturns({ requested: { from: "2026-01-01", to: d[1]! }, market: "KR", recordSince: "2026-09-28" }, [KR(d[0]!, 100), KR(d[1]!, 101)], [], ONE);
    expect(r.clippedToRecordStart).toBe(true);
    expect(r.actual).toEqual({ from: d[0], to: d[1] });
  });

  it("기간 고르기: 1주·1달·3달·올해·1년 (달 끝은 그 달 마지막 날로)", () => {
    expect(presetRange("1W", "2026-10-12")).toEqual({ from: "2026-10-05", to: "2026-10-12" });
    expect(presetRange("1M", "2026-10-12")).toEqual({ from: "2026-09-12", to: "2026-10-12" });
    expect(presetRange("1M", "2026-03-31")).toEqual({ from: "2026-02-28", to: "2026-03-31" });
    expect(presetRange("3M", "2026-10-12")).toEqual({ from: "2026-07-12", to: "2026-10-12" });
    expect(presetRange("YTD", "2026-10-12")).toEqual({ from: "2026-01-01", to: "2026-10-12" });
    expect(presetRange("1Y", "2026-10-12")).toEqual({ from: "2025-10-12", to: "2026-10-12" });
  });
});

describe("검토 반영: 전체(원화)에서 미국 기록에 평가 환율이 없을 때", () => {
  it("고른 기간의 미국 스냅샷이 모두 환율 없음이면 기록이 충분해도 까닭 usFxMissing ('기간을 더 길게'가 아님) — 한국만은 숫자", () => {
    const d = days(12);
    const kr = d.map((x, i) => KR(x, 1_000_000 + i));
    const usNoFx = d.map((x) => US(x, 100, 1390, `${nextDay(x)}T05:05:00+09:00`, { fx: null }));
    const r = periodReturns(q(d[0]!, d[11]!, "ALL"), [...kr, ...usNoFx], []);
    expect(r).toMatchObject({ ready: false, usFxMissing: true, tradingDays: 0, twr: null });
    const k = periodReturns(q(d[0]!, d[11]!, "KR"), [...kr, ...usNoFx], []);
    expect(k).toMatchObject({ ready: true, usFxMissing: false });
    // 환율이 있는 미국 기록이 있으면 까닭 없음
    const usOk = d.map((x) => US(x, 100, 1390, `${nextDay(x)}T05:05:00+09:00`));
    expect(periodReturns(q(d[0]!, d[11]!, "ALL"), [...kr, ...usOk], []).usFxMissing).toBe(false);
    // 미국 기록이 아예 없으면(환율 문제가 아님) 까닭 없음
    expect(periodReturns(q(d[0]!, d[11]!, "ALL"), kr, []).usFxMissing).toBe(false);
  });
});
