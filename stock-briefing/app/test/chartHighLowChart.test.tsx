import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 차트 최고·최저가 표시 — PriceChart 그림 (3-46, 기능 플래그 chartHighLow + 설정. CandleChart 가 켬일 때만 highLow 를 넘긴다).
 *  - 끄면(속성 없음·false) 지금 그대로: 트리·축 눈금·화면 읽기 모두 같다
 *  - 켜면 보이는 구간 가장 높은 고가에 빨간(t.up) ↓ 와 '255,000원 (-22.3%, 26.07.27)', 가장 낮은 저가에 파란(t.down) ↑ 와 '181,100원 (+9.3%, 26.07.14)'
 *  - 글자·화살표가 잘리지 않을 만큼 가격 축 위아래 여백, 상자는 그림 [2, plotW − 2] · 가격 칸 위아래 안
 *  - 드래그(보이는 구간이 바뀜)하면 새 구간으로 다시, % 는 늘 지금 현재가 기준
 */
const h = vi.hoisted(() => ({ dark: false }));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
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
  return { ...tokens, useTheme: () => (h.dark ? tokens.dark : tokens.light), useFontScale: () => 1 };
});

const { PriceChart } = await import("@/components/chart/PriceChart");
const { dark, light } = await import("@/tokens");
const { pctFromCurrent, highLowTexts, visibleExtremes } = await import("@/lib/chartHighLow");

beforeEach(() => {
  h.dark = false;
});

const DAY = 86_400_000;
/** 평일만 n 개 (YYYY-MM-DD) */
const weekdays = (from: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < n; t += DAY) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
const DATES = weekdays("2026-07-01", 60);
/** NAVER 모양 60봉: 보통은 193,000~217,000 원 사이, 7월 27일 고가 255,000 · 7월 14일 저가 181,100 (사용자 캡처의 두 값) */
const NAVER = DATES.map((date, i) => {
  const c = 205_000 + 12_000 * Math.sin(i / 6);
  return { date, open: c - 500, high: date === "2026-07-27" ? 255_000 : c + 2_000, low: date === "2026-07-14" ? 181_100 : c - 2_000, close: c, volume: 1_000 + i };
});
const HIGH_TEXT = "255,000원 (-22.3%, 26.07.27)";
const LOW_TEXT = "181,100원 (+9.3%, 26.07.14)";

type Props = React.ComponentProps<typeof PriceChart>;
const draw = (props: Partial<Props> = {}) =>
  render(
    <PriceChart
      candles={NAVER}
      period="D"
      currency="KRW"
      width={419}
      height={260}
      view={{ count: 60, offset: 0 }}
      onViewChange={() => undefined}
      maPeriods={[5, 20, 60]}
      showBollinger={false}
      showVolume
      indicator="none"
      currentPrice={198_000}
      prevClose={194_700}
      {...props}
    />,
  );
type R = ReturnType<typeof draw>;
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const svgTexts = (r: R) => r.all().filter((n) => n.type === "SvgText");
const textNode = (r: R, s: string) => svgTexts(r).find((n) => textOf(n) === s);
const hlTexts = (r: R) => svgTexts(r).filter((n) => /^\S+ \((?:[+-]?[\d,.]+%, )?[\d.: ]+\)$/.test(textOf(n)));
/** 트리를 글로 (함수 속성은 자리만, 자르기 틀 id 는 차트마다 달라 지운다) — 끄면 '지금 그대로'인지 견줄 때 */
const snap = (r: R) => JSON.stringify(r.tree, (_k, v: unknown) => (typeof v === "function" ? "[fn]" : v)).replace(/priceClip[A-Za-z0-9_-]+/g, "priceClip");
const plotBox = (r: R) => {
  const clip = r.all().find((n) => n.type === "ClipPath")!;
  const rect = clip.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Rect")!;
  return { plotW: rect.props.width as number, priceH: rect.props.height as number };
};
/** 글자 바로 앞의 바탕 상자 (같은 부모 안에서 글자 앞 Rect) */
const boxBefore = (r: R, text: HostNode) => {
  for (const n of r.all()) {
    const i = n.children.indexOf(text);
    if (i > 0) {
      const prev = n.children[i - 1];
      if (typeof prev !== "string" && prev.type === "Rect") return { left: prev.props.x as number, top: prev.props.y as number, right: (prev.props.x as number) + (prev.props.width as number), bottom: (prev.props.y as number) + (prev.props.height as number), node: prev };
    }
  }
  return null;
};
/** 최고·최저 화살표 path (대 V + 꺾쇠 L 두 번) — 봉 꼬리 path(M…V… 만)·이동평균(M…L…)과 구분 */
const ARROW_D = /^M[\d.-]+ [\d.-]+V[\d.-]+M[\d.-]+ [\d.-]+L[\d.-]+ [\d.-]+L[\d.-]+ [\d.-]+$/;
const arrows = (r: R) => r.all().filter((n) => n.type === "Path" && ARROW_D.test(String(n.props.d)));
const arrowX = (n: HostNode) => Number(String(n.props.d).match(/^M([\d.-]+)/)![1]);
const gestureView = (r: R) => (r.all().find((n) => n.type === "GestureDetector")!.children[0] as HostNode);
const topTick = (r: R) =>
  Math.max(
    ...svgTexts(r)
      .map(textOf)
      .filter((s) => /^\d{1,3}(,\d{3})+$/.test(s))
      .map((s) => Number(s.replace(/,/g, ""))),
  );

describe("끄면 지금 그대로", () => {
  it("highLow 없음 = false: 트리가 같고, 최고·최저 글자·화면 읽기 문장이 없다", () => {
    for (const extra of [{}, { avgPrice: 205_000, high52w: 260_000, low52w: 150_000 }, { indicator: "rsi" as const }]) {
      const off = draw(extra);
      const f = draw({ ...extra, highLow: false });
      expect(snap(f)).toBe(snap(off));
      expect(hlTexts(off)).toHaveLength(0);
      expect(textNode(off, HIGH_TEXT)).toBeUndefined();
      const v = gestureView(off);
      expect("accessibilityLabel" in v.props).toBe(false);
      expect("accessible" in v.props).toBe(false);
    }
  });
});

describe("켬 — 캡처처럼", () => {
  it("최고 '255,000원 (-22.3%, 26.07.27)' 은 상승색, 최저 '181,100원 (+9.3%, 26.07.14)' 은 하락색 — 다크·라이트, 화살표도 같은 색", () => {
    for (const isDark of [false, true]) {
      h.dark = isDark;
      const t = isDark ? dark : light;
      const r = draw({ highLow: true, labelBg: t.surface });
      const hi = textNode(r, HIGH_TEXT), lo = textNode(r, LOW_TEXT);
      expect(hi, `dark=${isDark}`).toBeDefined();
      expect(lo).toBeDefined();
      expect(hi!.props.fill).toBe(t.up);
      expect(lo!.props.fill).toBe(t.down);
      expect(hi!.props.fontSize).toBe(11);
      // 바탕 상자: 차트 바탕색, 불투명 (봉·선 위에서도 대비 4.5 이상)
      const hb = boxBefore(r, hi!)!;
      expect(hb.node.props.fill).toBe(t.surface);
      expect(hb.node.props.fillOpacity ?? 1).toBe(1);
      // 화살표 (대 + 꺾쇠) — 글자와 같은 색
      expect(arrows(r).map((n) => n.props.stroke).sort()).toEqual([t.up, t.down].sort());
      expect(arrows(r).every((n) => n.props.fill === "none")).toBe(true);
    }
  });

  it("화살표는 그 봉의 꼬리 끝을 가리킨다 (최고: 아래로, 최저: 위로), 가로는 봉 가운데", () => {
    const r = draw({ highLow: true });
    const { plotW } = plotBox(r);
    const step = plotW / 60;
    const iHigh = DATES.indexOf("2026-07-27"), iLow = DATES.indexOf("2026-07-14");
    const up = arrows(r).find((n) => n.props.stroke === light.up)!;
    const down = arrows(r).find((n) => n.props.stroke === light.down)!;
    const parse = (d: string) => d.match(/^M([\d.]+) ([\d.-]+)V([\d.-]+)/)!.slice(1).map(Number) as [number, number, number];
    const [xh, tailH, tipH] = parse(String(up.props.d));
    const [xl, tailL, tipL] = parse(String(down.props.d));
    expect(xh).toBeCloseTo(iHigh * step + step / 2, 1);
    expect(xl).toBeCloseTo(iLow * step + step / 2, 1);
    expect(tipH).toBeGreaterThan(tailH); // 최고: 위(글자)에서 아래(꼬리 끝)로
    expect(tipL).toBeLessThan(tailL); // 최저: 아래(글자)에서 위(꼬리 끝)로
    // 꼬리 끝과 2dp 띄움 (두 봉 모두 상승 봉 — 상승 꼬리 path 에서 그 x 의 고가·저가 y), 대 8
    const wick = String(r.all().find((n) => n.type === "Path" && n.props.stroke === light.up && n.props.strokeWidth === 1)!.props.d);
    const yAt = (x: number) => wick.match(new RegExp(`M${x.toFixed(1)} (-?[\\d.]+)V(-?[\\d.]+)`))!.slice(1).map(Number);
    expect(tipH).toBeCloseTo(yAt(xh)[0]! - 2, 0);
    expect(tipL).toBeCloseTo(yAt(xl)[1]! + 2, 0);
    expect(tailH).toBeCloseTo(tipH - 8, 0);
    expect(tailL).toBeCloseTo(tipL + 8, 0);
  });

  it("가격 축이 글자 자리만큼 넓어진다 (맨 위 눈금 ≥ 끔), 상자는 그림 [2, plotW − 2] · 가격 칸 위 −0.5 · 아래 priceH + 3.5 안", () => {
    const off = draw();
    const on = draw({ highLow: true });
    expect(topTick(on)).toBeGreaterThanOrEqual(topTick(off));
    const { plotW, priceH } = plotBox(on);
    for (const s of [HIGH_TEXT, LOW_TEXT]) {
      const b = boxBefore(on, textNode(on, s)!)!;
      expect(b.left).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(b.right).toBeLessThanOrEqual(plotW - 2 + 1e-9);
      expect(b.top).toBeGreaterThanOrEqual(-0.5);
      expect(b.bottom).toBeLessThanOrEqual(priceH + 3.5);
    }
    // 가격 칸 높이는 그대로 (여백은 축 범위로만 낸다)
    expect(plotBox(off)).toEqual(plotBox(on));
  });

  it("그림 View 의 화면 읽기 문장", () => {
    const v = gestureView(draw({ highLow: true }));
    expect(v.props.accessible).toBe(true);
    expect(v.props.accessibilityLabel).toBe("보이는 구간 최고 255,000원 7월 27일, 최저 181,100원 7월 14일. 현재가는 최고보다 22.3% 낮음, 최저보다 9.3% 높음");
  });
});

describe("보이는 구간을 따라간다 (드래그·‹ ›·봉 수)", () => {
  it("최신 30봉 → 30봉 앞 → 끝: 글자·화살표가 새 구간의 최고·최저로, % 는 계속 지금 현재가(198,000) 기준", () => {
    const r = draw({ highLow: true, view: { count: 30, offset: 0 } });
    const latest = hlTexts(r).map(textOf);
    expect(latest).toHaveLength(2);
    expect(latest.join()).not.toContain("255,000원");
    // 새 구간 값으로 만든 글자와 같다
    const vis0 = NAVER.slice(30);
    const t0 = highLowTexts(vis0, visibleExtremes(vis0)!, { unit: "KRW", period: "D", current: 198_000 });
    expect(latest.sort()).toEqual([t0.high, t0.low].sort());
    r.rerender(
      <PriceChart candles={NAVER} period="D" currency="KRW" width={419} height={260} view={{ count: 30, offset: 30 }} onViewChange={() => undefined} maPeriods={[5, 20, 60]} showBollinger={false} showVolume indicator="none" currentPrice={198_000} highLow />,
    );
    expect(textNode(r, HIGH_TEXT)).toBeDefined();
    expect(textNode(r, LOW_TEXT)).toBeDefined();
    // 화살표 x 도 새 구간의 봉 자리
    const { plotW } = plotBox(r);
    const step = plotW / 30;
    const up = arrows(r).find((n) => n.props.stroke === light.up)!;
    expect(arrowX(up)).toBeCloseTo(DATES.indexOf("2026-07-27") * step + step / 2, 1);
  });
});

describe("값·단위", () => {
  it("현재가를 모르면 마지막 봉 종가로 %", () => {
    const r = draw({ highLow: true, currentPrice: null });
    const last = NAVER.at(-1)!.close;
    expect(textNode(r, `255,000원 (${pctFromCurrent(last, 255_000)}, 26.07.27)`)).toBeDefined();
    expect(textNode(r, `181,100원 (${pctFromCurrent(last, 181_100)}, 26.07.14)`)).toBeDefined();
  });

  it("지수(PT)는 원 없이 '2,650.12', 미국 주식은 '$'", () => {
    const idx = NAVER.map((c) => ({ ...c, open: c.open / 100, high: c.high / 100, low: c.low / 100, close: c.close / 100 }));
    const pt = hlTexts(draw({ highLow: true, candles: idx, currency: "PT", currentPrice: 1_980 })).map(textOf);
    expect(pt.sort()).toEqual(["1,811.00 (+9.3%, 26.07.14)", "2,550.00 (-22.3%, 26.07.27)"]);
    const usd = hlTexts(draw({ highLow: true, candles: idx, currency: "USD", currentPrice: 1_980 })).map(textOf);
    expect(usd.sort()).toEqual(["$1,811.00 (+9.3%, 26.07.14)", "$2,550.00 (-22.3%, 26.07.27)"]);
    expect(gestureView(draw({ highLow: true, candles: idx, currency: "PT", currentPrice: 1_980 })).props.accessibilityLabel).toContain("현재 값은 최고보다 22.3% 낮음");
  });

  it("분봉(하루): 시각 'HH:mm'", () => {
    const bars = NAVER.slice(0, 40).map((c, i) => ({ ...c, date: "2026-09-25", time: `2026-09-25T${String(9 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00+09:00` }));
    const texts = hlTexts(draw({ highLow: true, candles: bars, period: "5m", view: { count: 40, offset: 0 } })).map(textOf);
    // 최고(7월 27일 봉 = 18번째) 12:00, 최저(7월 14일 봉 = 9번째) 10:30
    expect(texts.sort()).toEqual(["181,100원 (+9.3%, 10:30)", "255,000원 (-22.3%, 12:00)"]);
  });

  it("같은 고가 두 봉이면 뒤(최근) 봉을 가리킨다", () => {
    const tie = NAVER.map((c, i) => (i === 40 ? { ...c, high: 255_000 } : c));
    const r = draw({ highLow: true, candles: tie });
    const { plotW } = plotBox(r);
    const step = plotW / 60;
    const up = arrows(r).find((n) => n.props.stroke === light.up)!;
    expect(arrowX(up)).toBeCloseTo(40 * step + step / 2, 1);
    expect(textNode(r, `255,000원 (-22.3%, ${DATES[40]!.slice(2).replace(/-/g, ".")})`)).toBeDefined();
  });
});

describe("다른 글자와 겹치지 않는다", () => {
  const overlap = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  it("평단이 최고 근처(평단 글자가 가운데 자리를 원함)여도 평단 글자는 남고 최고·최저 상자와 겹치지 않는다", () => {
    for (const avg of [250_000, 252_000, 183_000, 205_000]) {
      const r = draw({ highLow: true, avgPrice: avg, high52w: 256_000, low52w: 181_000 });
      const avgText = svgTexts(r).find((n) => textOf(n).startsWith("평단"));
      expect(avgText, `평단 ${avg}`).toBeDefined();
      const ab = boxBefore(r, avgText!)!;
      for (const n of hlTexts(r)) expect(overlap(ab, boxBefore(r, n)!), `평단 ${avg} ${textOf(n)}`).toBe(false);
      // 52주 글자도 (남아 있으면) 겹치지 않는다
      for (const n of svgTexts(r).filter((x) => textOf(x).startsWith("52주"))) for (const m of hlTexts(r)) expect(overlap(boxBefore(r, n)!, boxBefore(r, m)!)).toBe(false);
    }
  });
});

describe("표시하지 않을 때 (축 범위도 끔과 같다)", () => {
  it("평평한 봉(최고 = 최저)", () => {
    const flat = NAVER.map((c) => ({ ...c, open: 200_000, high: 200_000, low: 200_000, close: 200_000 }));
    expect(snap(draw({ highLow: true, candles: flat }))).toBe(snap(draw({ candles: flat })));
  });
  it("가격 칸이 120dp 미만 (높이 180 + 거래량 + RSI → 가격 칸 85)", () => {
    const on = draw({ highLow: true, height: 180, indicator: "rsi" });
    expect(plotBox(on).priceH).toBeLessThan(120);
    expect(snap(on)).toBe(snap(draw({ height: 180, indicator: "rsi" })));
  });
  it("봉이 1개뿐이면 (보이는 봉 < 2)", () => {
    const one = NAVER.slice(0, 1);
    expect(snap(draw({ highLow: true, candles: one }))).toBe(snap(draw({ candles: one })));
  });
});
