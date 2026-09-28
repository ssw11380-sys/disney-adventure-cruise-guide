import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 가격 차트의 이동평균선 색 (3-39 PR 2, 기능 플래그 maCustom — CandleChart 가 maColors 로 넘긴다).
 * maColors(기간 → 색)를 주면 선·값 줄 네모(휴대폰 한 줄 글자 · 넓은 창 항목)·범위 밖 글자 앞 네모가 그 색.
 * 주지 않으면 지금처럼 기간마다 고정 색 maColor(t, 기간)
 */
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Line: "Line", Path: "Path", Rect: "Rect", Text: "SvgText", G: "G", Defs: "Defs", ClipPath: "ClipPath" }));
vi.mock("react-native-gesture-handler", () => {
  const chain: unknown = new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : () => chain), apply: () => chain });
  return { Gesture: chain, GestureDetector: "GestureDetector" };
});
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});

const { PriceChart, maColor } = await import("@/components/chart/PriceChart");
const { light } = await import("@/tokens");

const DAY = 86_400_000;
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * DAY).toISOString().slice(0, 10);
/** 꾸준히 내리는 200일 (100,000 → 40,300원): 최근 20봉만 보면 120일선은 내내 가격 칸 위 → '120일선(범위 위)' */
const FALLING = Array.from({ length: 200 }, (_, i) => {
  const c = 100_000 - 300 * i;
  return { date: day(i), open: c + 100, high: c + 300, low: c - 300, close: c, volume: 1_000 };
});
const MA = [5, 120];
const PICKED = { 5: "#123456", 120: "#ABCDEF" } as const;

const draw = (props: Partial<React.ComponentProps<typeof PriceChart>> = {}) =>
  render(
    <PriceChart
      candles={FALLING}
      period="D"
      currency="KRW"
      width={419}
      height={260}
      view={{ count: 20, offset: 0 }}
      onViewChange={() => undefined}
      maPeriods={MA}
      showBollinger={false}
      showVolume
      indicator="none"
      {...props}
    />,
  );
type R = ReturnType<typeof draw>;
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
/** 이동평균 선 (굵기 1.2 인 Path — 기간 작은 순) */
const maStrokes = (r: R) => r.all().filter((n) => n.type === "Path" && n.props.strokeWidth === 1.2).map((n) => n.props.stroke);
/** 값 줄의 색 네모 (Ionicons square) */
const squares = (r: R) => r.all().filter((n) => n.type === "Ionicons" && n.props.name === "square").map((n) => n.props.color);
/** 범위 밖 글자('120일선(범위 위)') 앞 네모: 그 글자 바로 앞 Rect */
const offSwatch = (r: R) => {
  const svg = r.all().find((n) => n.type === "Svg")!;
  const all = r.all(svg.children);
  const at = all.findIndex((n) => n.type === "SvgText" && textOf(n) === "120일선(범위 위)");
  expect(at).toBeGreaterThan(0);
  return all.slice(0, at).reverse().find((n) => n.type === "Rect" && n.props.width !== undefined && Number(n.props.width) < 20)!.props.fill;
};

describe("maColors 를 주면 (3-39 maCustom 켬)", () => {
  it("선 · 휴대폰 값 줄(한 줄 글자) 네모 · 범위 밖 글자 네모가 준 색", () => {
    const r = draw({ maColors: PICKED });
    expect(maStrokes(r)).toEqual([PICKED[5], PICKED[120]]);
    expect(squares(r)).toEqual([PICKED[5], PICKED[120]]);
    expect(offSwatch(r)).toBe(PICKED[120]);
  });

  it("넓은 창 값 줄(maItems 항목) 네모도 준 색", () => {
    const r = draw({ maColors: PICKED, maItems: true });
    expect(squares(r)).toEqual([PICKED[5], PICKED[120]]);
  });

  it("준 색에 없는 기간은 고정 색으로 (빈 칸 없이)", () => {
    const r = draw({ maColors: { 5: PICKED[5] } });
    expect(maStrokes(r)).toEqual([PICKED[5], maColor(light, 120)]);
  });
});

describe("maColors 가 없으면 지금 그대로 (기간마다 고정 색)", () => {
  it("선 · 값 줄 네모(한 줄 · 항목) · 범위 밖 글자 네모 = maColor(light, 기간)", () => {
    const r = draw();
    const want = MA.map((p) => maColor(light, p));
    expect(want).toEqual([light.chart.ma[5], light.chart.ma[120]]);
    expect(maStrokes(r)).toEqual(want);
    expect(squares(r)).toEqual(want);
    expect(offSwatch(r)).toBe(light.chart.ma[120]);
    expect(squares(draw({ maItems: true }))).toEqual(want);
  });
});
