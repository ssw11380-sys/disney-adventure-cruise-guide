import { describe, expect, it } from "vitest";
import { watchDifference, watchPriceInput } from "@/lib/watchlist";
describe("관심 가격 입력과 현재가 대비 차이", () => {
  it("현재가를 분모로 희망가까지의 등락과 도달 여부를 계산한다", () => {
    expect(watchDifference(100, 80)).toEqual({ amount: -20, percent: -20, reached: false });
    expect(watchDifference(80, 100)).toEqual({ amount: 20, percent: 25, reached: true });
    expect(watchDifference(100, 100)).toEqual({ amount: 0, percent: 0, reached: true });
    expect(watchDifference(null, 100)).toBeNull(); expect(watchDifference(NaN, 100)).toBeNull();
  });
  it("원화 정수와 달러 센트를 보존하고 0·음수·지수 표기·범위 초과를 거절한다", () => {
    expect(watchPriceInput("70,000", "KRW")).toBe(70000); expect(watchPriceInput("0.29", "USD")).toBe(0.29);
    for (const value of ["", "0", "-1", "Infinity", "1e6", "0.001", "1000000000"]) expect(watchPriceInput(value, "USD")).toBeNull();
    expect(watchPriceInput("100.5", "KRW")).toBeNull();
  });
});
