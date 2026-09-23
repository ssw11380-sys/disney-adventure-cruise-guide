import { describe, expect, it } from "vitest";
import { axisWidth, readoutBasis, textWidth } from "@/lib/chartBasis";

describe("차트 읽기 줄 등락 기준", () => {
  // 삼성전자 9/23: 거래소 기준가(전일 종가) 276,500, 통합(NXT 포함) 직전 봉 종가 277,800, 오늘 종가 286,500
  const base = { latestBase: 276_500, prevClose: 277_800, open: 282_500 };
  it("최신 일봉은 십자선이어도 머리와 같은 전일 종가 기준 (+3.62%)", () => {
    const r = readoutBasis({ period: "D", isLatest: true, ...base });
    expect(r).toEqual({ base: 276_500, label: "전일 대비" });
    expect(((286_500 - r.base!) / r.base!) * 100).toBeCloseTo(3.617, 2);
  });
  it("지난 일봉은 직전 봉 종가", () => expect(readoutBasis({ period: "D", isLatest: false, ...base })).toEqual({ base: 277_800, label: "전일 대비" }));
  it("주·월봉은 전주·전월 대비", () => {
    expect(readoutBasis({ period: "W", isLatest: true, ...base }).label).toBe("전주 대비");
    expect(readoutBasis({ period: "M", isLatest: true, ...base })).toEqual({ base: 277_800, label: "전월 대비" });
  });
  it("분봉은 봉 시가 대비", () => {
    for (const p of ["1m", "5m", "30m"] as const) expect(readoutBasis({ period: p, isLatest: true, ...base })).toEqual({ base: 282_500, label: "봉 시가 대비" });
  });
  it("전일 종가를 모르면 직전 봉 종가", () => expect(readoutBasis({ period: "D", isLatest: true, latestBase: null, prevClose: 100, open: 90 }).base).toBe(100));
});

describe("가격 축 폭", () => {
  it("짧은 값(달러)은 좁게, 긴 값(원화 7자리)은 넓게", () => {
    expect(axisWidth(["23.45", "24.00"])).toBe(33); // 4×5.8+3+7
    expect(axisWidth(["1,234,567"])).toBe(54); // 7×5.8+2×3+7
    expect(axisWidth([])).toBe(30);
    expect(axisWidth(["1,234,567,890.12"])).toBe(76);
  });
});

describe("글자 폭 어림", () => {
  it("한글은 넓게, 쉼표는 좁게", () => {
    expect(textWidth("평단")).toBe(20);
    expect(textWidth("1,000")).toBeCloseTo(26.2, 5);
  });
});
