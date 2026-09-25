import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 차트 아래 이동평균 값 줄 (폴드 진단 24번, 버그 수정 — 플래그와 상관없음).
 * 예전에는 한 줄 글자 안에 '■ 120일 77,120원' 을 이어 써서, 글자 130% 에서 '120일'과 '77,120원'이 다른 줄로 떨어지거나
 * 색 네모만 윗줄에 혼자 남았다. 이제 항목마다 [색 네모 + 글자] 묶음을 줄바꿈 줄(flexWrap)에 놓고, 항목 안 공백은 줄바꿈 없는 공백.
 */
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Line: "Line", Path: "Path", Rect: "Rect", Text: "SvgText" }));
vi.mock("react-native-gesture-handler", () => {
  // Gesture.Pan().runOnJS(true).minDistance(8)... 처럼 이어 부르는 설정을 모두 받아 주는 가짜
  const chain: unknown = new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : () => chain), apply: () => chain });
  return { Gesture: chain, GestureDetector: "GestureDetector" };
});
vi.mock("expo-haptics", () => ({ selectionAsync: async () => undefined }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1.3 };
});

const { PriceChart, maColor } = await import("@/components/chart/PriceChart");
const { maLegendItems } = await import("@/lib/chartLayout");
const { sma } = await import("@/lib/indicators");
const { light } = await import("@/tokens");

const DAY = 86_400_000;
const CANDLES = Array.from({ length: 130 }, (_, i) => {
  const close = 77_000 + (i % 7) * 40 + i;
  return { date: new Date(Date.UTC(2026, 3, 1) + i * DAY).toISOString().slice(0, 10), open: close - 50, high: close + 80, low: close - 90, close, volume: 1000 + i };
});
const MA = [5, 20, 60, 120];

const draw = (props: Partial<React.ComponentProps<typeof PriceChart>> = {}) =>
  render(
    <PriceChart
      candles={CANDLES}
      period="D"
      currency="KRW"
      width={383}
      height={237}
      view={{ count: 60, offset: 0 }}
      onViewChange={() => undefined}
      maPeriods={MA}
      showBollinger={false}
      showVolume
      indicator="none"
      {...props}
    />,
  );
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const legend = (r: ReturnType<typeof draw>) => r.all().find((n) => n.type === "View" && flat(n).flexWrap === "wrap");

describe("이동평균 값 줄: 항목 단위로만 줄이 바뀐다", () => {
  it("항목마다 [색 네모, 글자] 한 묶음을 줄바꿈 줄에 놓는다", () => {
    const r = draw();
    const line = legend(r)!;
    expect(flat(line)).toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
    const items = line.children as HostNode[];
    expect(items).toHaveLength(MA.length);
    const closes = CANDLES.map((c) => c.close);
    const expected = maLegendItems(MA.map((p) => ({ period: p, values: sma(closes, p) })), CANDLES.length - 1, "KRW", "D");
    items.forEach((item, i) => {
      expect(item.type).toBe("View");
      expect(flat(item)).toMatchObject({ flexDirection: "row", alignItems: "center" });
      const [square, text] = item.children as HostNode[];
      // 색 네모는 글자와 같은 묶음 안 (혼자 윗줄에 남지 않는다)
      expect(square!.type).toBe("Ionicons");
      expect(square!.props.color).toBe(maColor(light, MA[i]!));
      expect(text!.type).toBe("Text");
      expect(text!.children).toEqual([expected[i]!.text]);
      // 항목 안에는 줄을 바꿀 수 있는 공백이 없다 ('120일'과 값이 떨어지지 않는다)
      expect(String(text!.children[0])).not.toMatch(/[ \t]/);
      // 글자색은 흐린 글자색 (선 색은 글자 대비를 보장하지 않아 네모에만)
      expect(flat(text!).color).toBe(light.muted);
    });
    expect(String((items[3]!.children[1] as HostNode).children[0])).toMatch(/^120일 [\d,]+원$/);
  });

  it("전체 화면(값 줄 끔)에서는 그리지 않는다", () => {
    expect(legend(draw({ showMaValues: false }))).toBeUndefined();
  });

  it("이동평균을 하나도 고르지 않으면 줄이 없다", () => {
    expect(legend(draw({ maPeriods: [] }))).toBeUndefined();
  });
});
