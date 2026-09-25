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
const { estimateTextWidth, maLegendItems } = await import("@/lib/chartLayout");
const { sma } = await import("@/lib/indicators");
const { font, light, space } = await import("@/tokens");

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

describe("접은 화면 첫 화면: 이동평균 값 줄의 줄 수·높이는 3-42 이전과 같다 (사용자 결정 '접은 화면은 지금 그대로', 결정 테스트)", () => {
  /**
   * 3-42 이전: 한 줄 글자 '■ 5일 84,300원  ■ 20일 …'(numberOfLines 2) 를 공백 단위로 줄바꿈 → 항목 안에서 끊길 수 있었다.
   * 지금: 항목 [■ + '5일 84,300원'] 단위로 줄바꿈 (항목 사이 6, 네모와 글자 사이 2, 줄 사이 0).
   * 휴대폰 차트 폭(3-42 이전 식 그대로: 360 → 304 · 411 → 355 · 475 → 419)과 기본 이동평균(5·20·60·120)에서
   * 두 방식의 줄 수가 같고, 줄 사이 간격이 0 이라 높이도 같다 → 차트 아래 숫자들이 예전 자리 그대로다.
   * 글자 폭은 lib/chartLayout estimateTextWidth 어림 (두 방식에 같은 어림을 쓴다)
   */
  const f = font.tiny;
  const ICON_W = f;
  /** 예전: 공백으로 나눈 낱말을 앞에서부터 채운다 (넘치면 다음 줄) */
  const oldLines = (texts: string[], width: number) => {
    const space1 = estimateTextWidth(" ", f);
    const words = texts.flatMap((tx) => [ICON_W, ...tx.split(" ").map((p) => estimateTextWidth(p, f))]);
    let lines = 1;
    let x = 0;
    for (const w of words) {
      const add = x === 0 ? w : space1 + w;
      if (x > 0 && x + add > width) {
        lines++;
        x = w;
      } else x += add;
    }
    return lines;
  };
  /** 지금: 항목(네모 + 2 + 글자)을 앞에서부터 채운다, 항목 사이 6 */
  const newLines = (texts: string[], width: number) => {
    let lines = 1;
    let x = 0;
    for (const tx of texts) {
      const w = ICON_W + space.xxs + estimateTextWidth(tx, f);
      const add = x === 0 ? w : space.s + w;
      if (x > 0 && x + add > width) {
        lines++;
        x = w;
      } else x += add;
    }
    return lines;
  };
  const CASES: [string, "KRW" | "USD" | "PT", number[]][] = [
    ["국내 5자리", "KRW", [84_300, 83_950, 81_200, 76_540]],
    ["국내 6자리", "KRW", [351_000, 348_500, 330_250, 290_800]],
    ["국내 7자리", "KRW", [1_034_000, 1_021_000, 998_000, 951_000]],
    ["미국", "USD", [254.4, 251.12, 240.33, 228.9]],
    ["지수 4자리", "PT", [2650.12, 2641.5, 2600.33, 2580.1]],
    ["지수 5자리", "PT", [41000.12, 40811.5, 40200.33, 39850.1]],
  ];

  it("360·411·475 창의 휴대폰 차트 폭에서 기본 이동평균 줄 수가 예전과 같다 (1줄 또는 2줄)", () => {
    const got: Record<string, number> = {};
    for (const [win, width] of [[360, 304], [411, 355], [475, 419]] as const) {
      for (const [name, unit, vals] of CASES) {
        const texts = maLegendItems(MA.map((p, i) => ({ period: p, values: [vals[i]!] })), 0, unit, "D").map((it) => it.text.replace(/\u00a0/g, " "));
        const before = oldLines(texts, width);
        const now = newLines(texts, width);
        expect(now, `${win} ${name}`).toBe(before);
        expect(now, `${win} ${name}`).toBeLessThanOrEqual(2);
        got[`${win} ${name}`] = now;
      }
    }
    // 폴드8 접힘(475)은 7자리 가격만 두 줄, 나머지는 한 줄 · 360·411 은 모두 두 줄
    expect(Object.entries(got).filter(([k]) => k.startsWith("475")).map(([k, v]) => `${k}:${v}`)).toEqual([
      "475 국내 5자리:1",
      "475 국내 6자리:1",
      "475 국내 7자리:2",
      "475 미국:1",
      "475 지수 4자리:1",
      "475 지수 5자리:1",
    ]);
  });

  it("줄 사이 간격은 0 (두 줄이 되어도 예전 두 줄 글자와 같은 높이)", () => {
    expect(flat(legend(draw())!).rowGap).toBe(0);
  });
});
