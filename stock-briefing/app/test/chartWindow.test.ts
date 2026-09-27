import { describe, expect, it, vi } from "vitest";
import type { CandlePeriod } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));

const { createChartViewMemo, initialWindowIdx, isNarrowChart } = await import("@/lib/chartLayout");
const { WINDOWS } = await import("@/lib/chartPrefs");
const { classifyWindow } = await import("@/lib/windowClass");

/**
 * 차트를 처음 열 때 보이는 봉 수 (2026-09-27 결정, 기능 플래그 detailPolish):
 * 좁은 창(휴대폰·접은 화면)의 일봉만 60일, 나머지는 예전 그대로 둘째 칩(일 120 · 주 104 · 월 60 · 분봉 둘째)
 */
describe("처음 보이는 봉 수 칩 (initialWindowIdx)", () => {
  const PERIODS: CandlePeriod[] = ["D", "W", "M", "1m", "5m", "30m"];
  const count = (period: CandlePeriod, o: { compact: boolean; polish: boolean }) => WINDOWS[period][initialWindowIdx(period, o)];

  it("일봉 칩 순서는 60 → 120 → 250 (첫째가 60, 둘째가 예전 기본 120)", () => {
    expect(WINDOWS.D).toEqual([60, 120, 250]);
  });

  it("켜짐 + 좁은 창: 일봉만 60일, 주·월·분봉은 예전 기본", () => {
    const on = { compact: true, polish: true };
    expect(count("D", on)).toBe(60);
    expect(count("W", on)).toBe(104);
    expect(count("M", on)).toBe(60);
    expect(count("1m", on)).toBe(120);
    expect(count("5m", on)).toBe(156);
    expect(count("30m", on)).toBe(130);
  });

  it("펼친 창(중간·넓음)이나 플래그 꺼짐이면 모든 기간 예전 기본 (일 120)", () => {
    for (const o of [{ compact: false, polish: true }, { compact: true, polish: false }, { compact: false, polish: false }])
      for (const p of PERIODS) expect(initialWindowIdx(p, o), `${p} ${JSON.stringify(o)}`).toBe(1);
    expect(count("D", { compact: false, polish: true })).toBe(120);
  });

  it("좁은 창 = 폭 등급 'compact' (600 미만): 폴드8 접힘 475 · 울트라 접힘 411 · 360 은 좁음, 펼침 704 · 933 · 859 · 954 는 아님", () => {
    const cls = (w: number, h: number) => classifyWindow({ width: w, height: h, fontScale: 1 }).width;
    for (const [w, h] of [[475, 751], [411, 960], [360, 780], [599, 900]]) expect(cls(w, h), `${w}`).toBe("compact");
    for (const [w, h] of [[704, 933], [933, 704], [859, 954], [954, 859], [600, 900]]) expect(cls(w, h), `${w}`).not.toBe("compact");
  });

  it("전체 화면처럼 차트 폭을 정해 주면 그 폭으로: 572dp(창 600 의 상세 차트 폭) 미만이면 좁음", () => {
    expect(isNarrowChart({ windowCompact: true })).toBe(true);
    expect(isNarrowChart({ windowCompact: false })).toBe(false);
    expect(isNarrowChart({ windowCompact: true, width: 451 })).toBe(true); // 폴드8 접힘 세로 전체 화면
    expect(isNarrowChart({ windowCompact: true, width: 571 })).toBe(true);
    expect(isNarrowChart({ windowCompact: true, width: 572 })).toBe(false);
    expect(isNarrowChart({ windowCompact: true, width: 647 })).toBe(false); // 접은 화면에서 '가로로 보기'로 돌려 그림
    expect(isNarrowChart({ windowCompact: false, width: 909 })).toBe(false); // 펼친 화면
  });

  it("보관함(createChartViewMemo): 처음엔 비어 있고, 적은 값을 그대로 읽는다 (화면마다 따로)", () => {
    const a = createChartViewMemo();
    const b = createChartViewMemo();
    expect(a.read()).toBeNull();
    a.save({ period: "D", windowIdx: 0, view: { count: 60, offset: 3 } });
    expect(a.read()).toEqual({ period: "D", windowIdx: 0, view: { count: 60, offset: 3 } });
    expect(b.read()).toBeNull();
  });

  it("근거: 접은 화면 차트 폭(475 창 → 447dp)에 120봉이면 봉 칸 약 3.7dp, 60봉이면 약 7.5dp", () => {
    const width = 475 - 28; // 패널 안쪽 (detailPolish 켜짐 — 잰 폭)
    expect(width / 120).toBeLessThan(4);
    expect(width / 60).toBeGreaterThan(7);
  });
});
