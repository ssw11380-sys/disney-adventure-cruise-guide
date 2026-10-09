import { describe, expect, it } from "vitest";
import { watchDifference, watchDifferenceLabel, watchPriceInput } from "@/lib/watchlist";
describe("관심 가격 입력과 현재가 대비 차이", () => {
  it("희망가에 도달하기 위한 하락과 이미 희망가 아래인 경우를 구분한다", () => {
    expect(watchDifferenceLabel(100, 80, "USD")).toBe("$20.00 (20.00%) 하락하면 희망가 · 현재가 대비");
    expect(watchDifferenceLabel(80, 100, "USD")).toBe("희망가보다 $20.00 낮음 · 차이 25.00% (현재가 대비)");
    expect(watchDifferenceLabel(100, 100, "KRW")).toBe("현재가가 구매희망 가격과 같습니다");
    expect(watchDifferenceLabel(null, 100, "KRW")).toContain("현재가 확인 후");
  });
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
