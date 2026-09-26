import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 차트 제스처 설정 (2026-09-26 RGTX 캡처 '120일 · 2일 전' — 세로로 스크롤하던 손가락이 옆으로 조금 흔들리면 차트가 과거로 옮겨졌다).
 *  - 한 손가락 드래그(과거/최신 이동)는 가로로 14dp 움직여야 시작하고, 그 전에 세로로 10dp 움직이면 포기 → 화면 스크롤
 *    (예전에는 어느 쪽으로든 8dp — minDistance(8) — 만 움직이면 시작했다)
 *  - 시작 조건만큼 움직인 거리는 이동에 넣지 않는다 (시작할 때 봉이 한꺼번에 튀지 않게)
 *  - 두 손가락 확대·축소, 길게 누른 뒤 십자선, 탭(십자선 지우기)은 그대로
 * react-native-gesture-handler 는 설정 호출을 기록하는 가짜로 바꿔, PriceChart 가 GestureDetector 에 넘긴 제스처를 읽는다.
 */

type Call = [string, unknown[]];
type Rec = { kind: string; calls: Call[]; children: Rec[] };

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Line: "Line", Path: "Path", Rect: "Rect", Text: "SvgText", G: "G", Defs: "Defs", ClipPath: "ClipPath" }));
vi.mock("react-native-gesture-handler", () => {
  // Gesture.Pan().runOnJS(true).activeOffsetX(...)... 처럼 이어 부르는 설정을 순서대로 기록하는 가짜
  const builder = (kind: string) => {
    const rec: Rec = { kind, calls: [], children: [] };
    const proxy: unknown = new Proxy(rec, {
      get: (target, key) => {
        if (key in target) return target[key as keyof Rec];
        if (key === "then") return undefined;
        return (...args: unknown[]) => {
          target.calls.push([String(key), args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  const group = (kind: string) => (...children: Rec[]) => ({ kind, calls: [], children });
  return {
    Gesture: { Pan: () => builder("Pan"), Pinch: () => builder("Pinch"), Tap: () => builder("Tap"), Race: group("Race"), Simultaneous: group("Simultaneous") },
    GestureDetector: "GestureDetector",
  };
});
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});

const { PriceChart, chartPanConfig } = await import("@/components/chart/PriceChart");

const DAY = 86_400_000;
const CANDLES = Array.from({ length: 300 }, (_, i) => {
  const c = 10_000 + (i % 9) * 40;
  return { date: new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10), open: c, high: c + 80, low: c - 80, close: c + 20, volume: 1_000 };
});

const draw = (view = { count: 120, offset: 0 }, onViewChange: (v: { count: number; offset: number }) => void = () => undefined) =>
  render(
    <PriceChart
      candles={CANDLES}
      period="D"
      currency="KRW"
      width={447}
      height={260}
      view={view}
      onViewChange={onViewChange}
      maPeriods={[20]}
      showBollinger={false}
      showVolume
      indicator="none"
      fitAxis
    />,
  );

/** GestureDetector 에 넘긴 제스처: Race(십자선, Simultaneous(확대·축소, 드래그), 탭) */
const gestures = (r: ReturnType<typeof draw>) => {
  const race = r.all().find((n) => n.type === "GestureDetector")!.props.gesture as Rec;
  expect(race.kind).toBe("Race");
  const [crosshair, both, tap] = race.children;
  expect(both!.kind).toBe("Simultaneous");
  const [pinch, scroll] = both!.children;
  return { crosshair: crosshair!, pinch: pinch!, scroll: scroll!, tap: tap! };
};
const calls = (g: Rec, name: string) => g.calls.filter(([k]) => k === name).map(([, a]) => a);
const handler = (g: Rec, name: string) => calls(g, name)[0]![0] as (e: { translationX: number; x?: number; y?: number }) => void;
const plotW = (r: ReturnType<typeof draw>) => ((r.all().find((n) => n.type === "ClipPath")!.children[0] as HostNode).props.width as number);

describe("차트 드래그는 가로로 움직일 때만 (세로 스크롤과 다투지 않게)", () => {
  it("한 손가락 드래그: 가로 14dp(12~16) 넘게 움직여야 시작, 세로 10dp(8~10) 넘게 먼저 움직이면 포기 — 어느 쪽으로든 8dp 에 시작하던 minDistance 는 없다", () => {
    const { scroll } = gestures(draw());
    expect(scroll.kind).toBe("Pan");
    expect(chartPanConfig.activeX).toBeGreaterThanOrEqual(12);
    expect(chartPanConfig.activeX).toBeLessThanOrEqual(16);
    expect(chartPanConfig.failY).toBeGreaterThanOrEqual(8);
    expect(chartPanConfig.failY).toBeLessThanOrEqual(10);
    expect(calls(scroll, "activeOffsetX")).toEqual([[[-chartPanConfig.activeX, chartPanConfig.activeX]]]);
    expect(calls(scroll, "failOffsetY")).toEqual([[[-chartPanConfig.failY, chartPanConfig.failY]]]);
    // 세로 움직임만으로 시작하게 하는 설정이 없다 (minDistance·activeOffsetY 는 어느 쪽 움직임이든 시작시킨다)
    expect(calls(scroll, "minDistance")).toEqual([]);
    expect(calls(scroll, "activeOffsetY")).toEqual([]);
    expect(calls(scroll, "maxPointers")).toEqual([[1]]);
    expect(calls(scroll, "runOnJS")).toEqual([[true]]);
  });

  it("두 손가락 확대·축소, 길게 누른 뒤 십자선(220ms), 탭은 그대로", () => {
    const { crosshair, pinch, tap } = gestures(draw());
    expect(pinch.kind).toBe("Pinch");
    expect(calls(pinch, "onUpdate")).toHaveLength(1);
    expect(crosshair.kind).toBe("Pan");
    expect(calls(crosshair, "activateAfterLongPress")).toEqual([[220]]);
    expect(calls(crosshair, "maxPointers")).toEqual([[1]]);
    // 십자선은 세로로도 움직여야 하므로 세로 포기 조건을 두지 않는다
    expect(calls(crosshair, "failOffsetY")).toEqual([]);
    expect(calls(crosshair, "activeOffsetX")).toEqual([]);
    expect(tap.kind).toBe("Tap");
    expect(calls(tap, "onEnd")).toHaveLength(1);
  });

  it("시작 조건(14dp)만큼 움직인 거리는 빼고 옮긴다: 시작 순간에는 그대로, 그 뒤 봉 폭만큼마다 한 봉", () => {
    const seen: { count: number; offset: number }[] = [];
    const r = draw({ count: 120, offset: 0 }, (v) => seen.push(v));
    const { scroll } = gestures(r);
    const step = plotW(r) / 120;
    const a = chartPanConfig.activeX;
    // 오른쪽으로 끌어 과거로: 시작 순간(14dp) 에는 옮기지 않는다 (예전 식이면 14 / 3.4 ≈ 4봉이 한꺼번에 튀었다)
    handler(scroll, "onStart")({ translationX: a });
    handler(scroll, "onUpdate")({ translationX: a });
    expect(seen).toEqual([]);
    handler(scroll, "onUpdate")({ translationX: a + step * 3 });
    expect(seen).toEqual([{ count: 120, offset: 3 }]);
  });

  it("과거에서 왼쪽으로 끌면 최신 쪽으로 (시작 순간 −14dp 도 빼고)", () => {
    const seen: { count: number; offset: number }[] = [];
    const r = draw({ count: 120, offset: 10 }, (v) => seen.push(v));
    const { scroll } = gestures(r);
    const step = plotW(r) / 120;
    handler(scroll, "onStart")({ translationX: -chartPanConfig.activeX });
    handler(scroll, "onUpdate")({ translationX: -chartPanConfig.activeX - step * 4 });
    expect(seen).toEqual([{ count: 120, offset: 6 }]);
  });
});
