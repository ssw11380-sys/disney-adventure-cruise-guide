import { describe, expect, it } from "vitest";
import { AXIS_GAP_L, AXIS_GAP_R, axisTextWidth, axisWidth, fitAxisWidth, readoutBasis, textWidth, volumeBars } from "@/lib/chartBasis";

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

describe("맞춘 가격 축 폭 (fitAxisWidth — 기능 플래그 detailPolish, 2026-09-26 '차트 오른쪽 빈 여백')", () => {
  it("가장 긴 글자 + 왼쪽 4 + 오른쪽 2 (2px 단위 올림) — 예전 어림(axisWidth)보다 좁다", () => {
    expect(AXIS_GAP_L).toBe(4);
    expect(AXIS_GAP_R).toBe(2);
    // RGTX 캡처 축: 100,000 → 48 (예전 50), 14,430 → 42 (예전 44)
    expect(fitAxisWidth(["100,000", "80,000", "14,430"])).toBe(48);
    expect(axisWidth(["100,000", "80,000", "14,430"])).toBe(50);
    expect(fitAxisWidth(["14,430", "13,500"])).toBe(42);
    expect(fitAxisWidth(["23.45", "24.00"])).toBe(36);
    // 거래량 최댓값('1,297만')이 가장 길면 그 글자에 맞춘다
    expect(fitAxisWidth(["985", "1,297만"])).toBe(46);
    expect(fitAxisWidth([])).toBe(24);
    expect(fitAxisWidth(["1,234,567,890.12"])).toBe(80);
    for (const labels of [["100,000"], ["23.45"], ["1,297만", "12,000"], ["2,650.12"]]) {
      const w = fitAxisWidth(labels);
      const longest = Math.max(...labels.map(axisTextWidth));
      expect(w, labels.join()).toBeGreaterThanOrEqual(AXIS_GAP_L + longest + AXIS_GAP_R);
      expect(w, labels.join()).toBeLessThan(AXIS_GAP_L + longest + AXIS_GAP_R + 2);
    }
  });

  it("글자 폭 어림은 실제 글꼴보다 작지 않다 — 폴드8 캡처(11pt)의 글자 폭(잉크): 100,000 37.7 · 80,000 32.0 · 1,297만 35.4dp", () => {
    // 잉크 폭 + 글자 앞뒤 여백(약 1dp)
    expect(axisTextWidth("100,000")).toBeGreaterThanOrEqual(37.7 + 1);
    expect(axisTextWidth("80,000")).toBeGreaterThanOrEqual(32.0 + 1);
    expect(axisTextWidth("1,297만")).toBeGreaterThanOrEqual(35.4 + 1);
    // 그러나 예전 어림(숫자 0.6·쉼표 0.3 글자)보다는 좁다
    expect(axisTextWidth("100,000")).toBeLessThan(textWidth("100,000"));
  });
});

describe("글자 폭 어림", () => {
  it("한글은 넓게, 쉼표는 좁게", () => {
    expect(textWidth("평단")).toBeCloseTo(22, 5);
    expect(textWidth("1,000")).toBeCloseTo(29.7, 5);
  });
});

// 52주·평단 글자 자리는 test/chartDomain.test.ts (placeInsideLabels — 예전 labelSide 를 대신한다)

describe("거래량 막대 (PF-04)", () => {
  it("거래량을 모르는 임시 봉은 0 처럼 비워 두지 않고 pane 높이의 점선 빈 막대로 따로 준다", () => {
    const bars = volumeBars(
      [
        { open: 1, close: 2, volume: 100 },
        { open: 2, close: 1, volume: 0 },
        { open: 2, close: 3, volume: 0, volumeUnknown: true },
      ],
      { maxVol: 100, top: 10, height: 40, barW: 4, xOf: (i) => i * 10 + 5 },
    );
    expect(bars.up).toBe("M3.0 10.0h4.0v40.0h-4.0z");
    expect(bars.down).toBe("M13.0 50.0h4.0v0.0h-4.0z"); // 확정된 0 은 높이 0
    expect(bars.unknown).toBe("M23.0 50.0V10.0h4.0V50.0");
  });
});
