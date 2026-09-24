import { describe, expect, it } from "vitest";
import { axisWidth, labelSide, readoutBasis, textWidth } from "@/lib/chartBasis";

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
  it("봉 목록이 하루 늦으면(마지막 봉이 어제) 전일 종가 대신 직전 봉 종가", () => {
    expect(readoutBasis({ period: "D", isLatest: true, ...base, candleDate: "2026-09-22", latestDate: "2026-09-23" }).base).toBe(277_800);
    expect(readoutBasis({ period: "D", isLatest: true, ...base, candleDate: "2026-09-23", latestDate: "2026-09-23" }).base).toBe(276_500);
    expect(readoutBasis({ period: "D", isLatest: true, ...base, candleDate: "2026-09-23", latestDate: null }).base).toBe(276_500);
  });
  it("전일 종가를 모르면 직전 봉 종가", () => expect(readoutBasis({ period: "D", isLatest: true, latestBase: null, prevClose: 100, open: 90 }).base).toBe(100));
});

describe("가격 축 폭", () => {
  it("짧은 값(달러)은 좁게, 긴 값(원화 7자리)은 넓게", () => {
    expect(axisWidth(["23.45", "24.00"])).toBe(38); // (4×6+3)×1.1+7 = 36.7 → 2 단위 올림 38 (11pt)
    expect(axisWidth(["1,234,567"])).toBe(60); // (7×6+2×3)×1.1+7 = 59.8 → 60
    expect(axisWidth([])).toBe(32);
    expect(axisWidth(["1,234,567,890.12"])).toBe(80);
  });
  it("거래량 글자도 넣어 잘리지 않게, 작은 글자는 배율로", () => {
    expect(axisWidth(["985"])).toBe(32); // 3×6×1.1+7 = 26.8 → 최소 32
    expect(axisWidth(["985", "3,000만"])).toBe(48); // (4×6+3+10)×1.1+7 = 47.7 → 48
    expect(axisWidth(["985", ["3,000만", 0.9]])).toBe(44); // 36.63+7 = 43.63 → 44
  });
});

describe("글자 폭 어림", () => {
  it("한글은 넓게, 쉼표는 좁게", () => {
    expect(textWidth("평단")).toBeCloseTo(22, 5);
    expect(textWidth("1,000")).toBeCloseTo(29.7, 5);
  });
});

describe("52주 글자 자리", () => {
  // 폭 300 그림, 봉 30개(10px 간격). 기본 봉은 y 100~140
  const bars = (f: (i: number) => [number, number]) => Array.from({ length: 30 }, (_, i) => ({ left: i * 10 + 2, right: i * 10 + 8, top: f(i)[0], bottom: f(i)[1] }));
  it("봉을 가리지 않으면 오른쪽", () => expect(labelSide({ y: 20, plotW: 300, bars: bars(() => [100, 140]) })).toBe("right"));
  it("오늘 52주 신고가: 오른쪽 끝 봉이 글자에 닿으면 왼쪽으로", () => {
    expect(labelSide({ y: 20, plotW: 300, bars: bars((i) => (i >= 27 ? [18, 60] : [100, 140])) })).toBe("left");
  });
  it("왼쪽도 가리면 오른쪽 그대로", () => {
    expect(labelSide({ y: 20, plotW: 300, bars: bars((i) => (i >= 27 || i <= 2 ? [5, 60] : [100, 140])) })).toBe("right");
  });
  it("왼쪽 평단 글자와 가까우면 오른쪽 그대로", () => {
    expect(labelSide({ y: 20, plotW: 300, bars: bars((i) => (i >= 27 ? [18, 60] : [100, 140])), avoidY: 28 })).toBe("right");
  });
});
