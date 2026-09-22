import { describe, expect, it } from "vitest";
import { bollinger, computeTechnicalSummary, ema, macd, rsi, sma, supportResistance } from "../src/analysis/indicators.js";
import type { Candle } from "../src/domain/types.js";

function candlesFrom(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1000 + i,
  }));
}

describe("sma / ema", () => {
  it("SMA 는 기간 미만 구간을 null 로 두고 이후 평균을 낸다", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("EMA 는 첫 값을 SMA 로 시작하고 k=2/(n+1) 로 갱신한다", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(2);
    expect(out[3]).toBeCloseTo(2 + (4 - 2) * 0.5, 10);
    expect(out[4]).toBeCloseTo(3 + (5 - 3) * 0.5, 10);
  });
});

describe("rsi", () => {
  it("Wilder RSI 가 기준 구현과 일치한다", () => {
    const p = [44.34, 44.09, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const out = rsi(p, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    const got = out.slice(14).map((v) => Math.round((v as number) * 100) / 100);
    expect(got).toEqual([66.94, 67.16, 69.85, 66.89, 58.73]);
  });

  it("계속 오르기만 하면 100, 데이터가 부족하면 전부 null", () => {
    const up = rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14);
    expect(up[19]).toBe(100);
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).toBe(true);
  });
});

describe("macd / bollinger", () => {
  it("MACD 는 EMA12-EMA26, signal 은 MACD 의 EMA9 이며 앞 구간은 null", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const out = macd(closes);
    expect(out[24]!.macd).toBeNull();
    expect(out[25]!.macd).not.toBeNull();
    expect(out[25]!.signal).toBeNull();
    expect(out[33]!.signal).not.toBeNull();
    const last = out[59]!;
    expect(last.histogram).toBeCloseTo((last.macd as number) - (last.signal as number), 10);
    const e12 = ema(closes, 12)[59] as number;
    const e26 = ema(closes, 26)[59] as number;
    expect(last.macd).toBeCloseTo(e12 - e26, 10);
  });

  it("볼린저 밴드는 중심선 ± 2σ, 가격이 상단이면 %B=1", () => {
    const closes = [...Array(19).fill(100), 110];
    const b = bollinger(closes, 20, 2)[19]!;
    const mean = (100 * 19 + 110) / 20;
    const sd = Math.sqrt(((100 - mean) ** 2 * 19 + (110 - mean) ** 2) / 20);
    expect(b.middle).toBeCloseTo(mean, 10);
    expect(b.upper).toBeCloseTo(mean + 2 * sd, 10);
    expect(b.lower).toBeCloseTo(mean - 2 * sd, 10);
    expect(b.percentB).toBeCloseTo((110 - (mean - 2 * sd)) / (4 * sd), 10);
    expect(bollinger([1, 2, 3], 20)[2]!.middle).toBeNull();
  });
});

describe("supportResistance", () => {
  it("현재가 아래 피벗 저점은 지지, 위 피벗 고점은 저항으로 가까운 순", () => {
    // 산 두 개(고점 130, 150)와 골 하나(저점 90) 뒤 현재가 120
    const shape = [100, 110, 120, 130, 120, 110, 100, 90, 100, 110, 130, 150, 130, 115, 118, 120, 120, 120, 120, 120, 120, 120];
    const c = candlesFrom(shape);
    const sr = supportResistance(c, 3);
    // 저항은 가까운 순: 첫 산(130) → 둘째 산(150). 고가는 close*1.01
    expect(sr.resistance[0]).toBeCloseTo(130 * 1.01, 5);
    expect(sr.resistance[1]).toBeCloseTo(150 * 1.01, 5);
    // 지지도 가까운 순: 둘째 산 뒤 눌림목(115) → 골(90). 저가는 close*0.99
    expect(sr.support[0]).toBeCloseTo(115 * 0.99, 5);
    expect(sr.support[1]).toBeCloseTo(90 * 0.99, 5);
  });
});

describe("computeTechnicalSummary", () => {
  it("봉이 2개 미만이면 null", () => {
    expect(computeTechnicalSummary(candlesFrom([100]))).toBeNull();
  });

  it("상승 추세에서 정배열/과매수, 하락 추세에서 역배열을 판정한다", () => {
    const up = computeTechnicalSummary(candlesFrom(Array.from({ length: 150 }, (_, i) => 100 + i)))!;
    expect(up.maAlignment).toBe("정배열");
    expect(up.rsiZone).toBe("과매수");
    expect(up.priceVsMa.above120).toBe(true);
    expect(up.returns.d1).toBeCloseTo((1 / 248) * 100, 1);

    const down = computeTechnicalSummary(candlesFrom(Array.from({ length: 150 }, (_, i) => 400 - i)))!;
    expect(down.maAlignment).toBe("역배열");
    expect(down.rsiZone).toBe("과매도");
  });

  it("봉이 적으면 긴 이동평균은 null 이고 혼조로 표시된다", () => {
    const s = computeTechnicalSummary(candlesFrom(Array.from({ length: 30 }, (_, i) => 100 + (i % 3))))!;
    expect(s.ma.ma60).toBeNull();
    expect(s.ma.ma120).toBeNull();
    expect(s.ma.ma20).not.toBeNull();
    expect(s.candleCount).toBe(30);
  });
});
