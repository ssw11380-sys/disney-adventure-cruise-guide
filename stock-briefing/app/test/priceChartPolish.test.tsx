import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";
import { RGTX_FX, RGTX_QUOTE, rgtxDaily } from "./rgtxCandles";

/**
 * 가격 차트 그림 (2026-09-26 RGTX 접은 화면 캡처).
 *  - 버그 수정(플래그 없음): 가격 축은 봉 기준 — 120일선 옛 값이 축을 넓히지 않고, 넘는 선은 가격 칸에서 잘린다.
 *    평단·52주 글자는 봉·서로를 가리지 않는 자리에 옅은 바탕 상자(바탕색 토큰)와 함께
 *  - 과거 구간 안내 버튼(기능 플래그 detailPolish — CandleChart 가 pastView 를 넘길 때만): 그림 위 가운데·왼쪽·오른쪽 중 봉·글자를 덜 가리는 곳,
 *    좁으면 짧은 글, 누르는 영역 44, 화면 읽기 이름표
 *  - 사용자 캡처와 같은 RGTX 모양(test/rgtxCandles)에서 '52주 최저' 글자가 최신 봉을 덮지 않는다 (2차 수정)
 */
const h = vi.hoisted(() => ({ dark: false, scale: 1 }));

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
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => (h.dark ? tokens.dark : tokens.light), useFontScale: (cap = Infinity) => Math.min(h.scale, cap) };
});

const { PriceChart } = await import("@/components/chart/PriceChart");
const { dark, light, touch } = await import("@/tokens");

beforeEach(() => {
  h.dark = false;
  h.scale = 1;
});

const DAY = 86_400_000;
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * DAY).toISOString().slice(0, 10);
/** RGTX 모양: 앞 130일은 200,000 → 20,000 원으로 떨어지고, 마지막 120일은 13,100~15,900 원 */
const RGTX = [
  ...Array.from({ length: 130 }, (_, i) => {
    const c = 200_000 - (180_000 * i) / 129;
    return { date: day(i), open: c, high: c + 2_000, low: c - 2_000, close: c, volume: 1_000 };
  }),
  ...Array.from({ length: 120 }, (_, i) => {
    const c = 14_500 + 1_000 * Math.sin(i / 5);
    return { date: day(130 + i), open: c, high: c + 400, low: c - 400, close: c, volume: 1_000 };
  }),
];

const draw = (props: Partial<React.ComponentProps<typeof PriceChart>> = {}) =>
  render(
    <PriceChart
      candles={RGTX}
      period="D"
      currency="KRW"
      width={419}
      height={260}
      view={{ count: 120, offset: 0 }}
      onViewChange={() => undefined}
      maPeriods={[5, 20, 60, 120]}
      showBollinger={false}
      showVolume
      indicator="none"
      {...props}
    />,
  );
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const svgTexts = (r: ReturnType<typeof draw>) => r.all().filter((n) => n.type === "SvgText").map(textOf);
const num = (s: string) => Number(s.replace(/,/g, ""));

describe("가격 축은 봉 기준 (버그 수정)", () => {
  it("RGTX: 120일선이 10만원대여도 축 눈금은 봉 범위(≈ 12,500~17,000원) 안 — 예전 20,000~100,000 눈금이 없다", () => {
    const r = draw({ currentPrice: 14_430, avgPrice: 18_599 });
    // 오른쪽 축 눈금 (가격 칸 위쪽의 숫자들: 쉼표 있는 5자리 이하 숫자 글자)
    const ticks = svgTexts(r).filter((s) => /^\d{1,3}(,\d{3})*$/.test(s)).map(num).filter((v) => v > 1_000);
    expect(ticks.length).toBeGreaterThan(1);
    for (const v of ticks) {
      expect(v).toBeGreaterThan(12_000);
      expect(v).toBeLessThan(17_000);
    }
    expect(svgTexts(r)).not.toContain("100,000");
  });

  it("선·봉·볼린저는 가격 칸 자르기 틀 안에 그린다 (칸 밖 — 거래량 칸·날짜 줄 — 으로 나가지 않게)", () => {
    const r = draw({ showBollinger: true });
    const clip = r.all().find((n) => n.type === "ClipPath")!;
    const rect = clip.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Rect")!;
    expect(rect.props).toMatchObject({ x: 0, y: 0 });
    // 가격 칸 높이 = 260 − 날짜 줄 18 − 거래량 칸(16%) − 칸 사이 6
    expect(rect.props.height).toBe(260 - 18 - Math.round(260 * 0.16) - 6);
    const group = r.all().find((n) => n.type === "G")!;
    expect(group.props.clipPath).toBe(`url(#${String(clip.props.id)})`);
    // 이동평균 4개 + 캔들 4개 + 볼린저 3개가 틀 안
    const paths = group.children.filter((c): c is HostNode => typeof c !== "string" && c.type === "Path");
    expect(paths.length).toBe(4 + 4 + 3);
  });
});

describe("평단·52주 글자 (버그 수정)", () => {
  it("글자마다 바탕색 토큰으로 옅은 바탕 상자, 두 글자 상자는 겹치지 않는다", () => {
    for (const isDark of [false, true]) {
      h.dark = isDark;
      const t = isDark ? dark : light;
      // 평단·52주 최저를 봉 범위 안 가까운 값으로
      const r = draw({ avgPrice: 13_600, low52w: 13_500, labelBg: t.surface });
      const labels = r.all().filter((n) => n.type === "SvgText" && /^(평단|52주)/.test(textOf(n)));
      expect(labels.map(textOf).sort()).toEqual(["52주 최저", "평단 13,600"]);
      const boxes = r.all().filter((n) => n.type === "Rect" && n.props.fill === t.surface);
      expect(boxes).toHaveLength(2);
      for (const b of boxes) expect(b.props.fillOpacity).toBeGreaterThan(0.5);
      const [a, c] = boxes.map((b) => ({ l: b.props.x as number, r: (b.props.x as number) + (b.props.width as number), t: b.props.y as number, b: (b.props.y as number) + (b.props.height as number) }));
      expect(a!.l < c!.r && c!.l < a!.r && a!.t < c!.b && c!.t < a!.b, `dark=${isDark}`).toBe(false);
    }
  });

  it("범위 밖 평단(RGTX 18,599원)은 선 없이 가장자리 글자 + 바탕 상자", () => {
    const r = draw({ avgPrice: 18_599, labelBg: light.surface });
    expect(svgTexts(r)).toContain("평단(범위 위) 18,599");
    expect(r.all().filter((n) => n.type === "Rect" && n.props.fill === light.surface)).toHaveLength(1);
    // 평단 점선은 그리지 않는다 (범위 밖)
    expect(r.all().some((n) => n.type === "Line" && n.props.stroke === light.gold)).toBe(false);
  });

  it("바탕색을 주지 않으면 패널 색(t.surface)", () => {
    const r = draw({ avgPrice: 14_000 });
    expect(r.all().some((n) => n.type === "Rect" && n.props.fill === light.surface)).toBe(true);
  });
});

describe("과거 구간 안내 버튼 (기능 플래그 detailPolish — pastView)", () => {
  const button = (r: ReturnType<typeof draw>) => r.all().find((n) => n.type === "Pressable");

  it("pastView 가 없으면 버튼이 없고, 있으면 그림 위에 '… · 최신으로' 한 줄", () => {
    expect(button(draw())).toBeUndefined();
    const onLatest = vi.fn();
    const r = draw({ view: { count: 120, offset: 2 }, pastView: { text: "2일 전까지 보는 중", onLatest } });
    const b = button(r)!;
    expect(textOf(b)).toBe("2일 전까지 보는 중 · 최신으로");
    expect(b.props.accessibilityRole).toBe("button");
    expect(b.props.accessibilityLabel).toBe("2일 전까지 보는 중. 누르면 최신 차트로 돌아갑니다");
    (b.props.onPress as () => void)();
    expect(onLatest).toHaveBeenCalledTimes(1);
  });

  it("누르는 영역 44 (보이는 높이 32 + 위아래 hitSlop), 둘레 틀은 누르기를 통과시켜 버튼 밖은 그대로 드래그·십자선", () => {
    const r = draw({ view: { count: 120, offset: 2 }, pastView: { text: "2일 전까지 보는 중", onLatest: () => undefined } });
    const b = button(r)!;
    const style = Object.assign({}, ...[(b.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false })].flat(Infinity).filter(Boolean)) as Record<string, number>;
    const slop = b.props.hitSlop as { top: number; bottom: number };
    expect(style.minHeight! + slop.top + slop.bottom).toBeGreaterThanOrEqual(touch.min);
    const wrap = r.all().find((n) => n.children.includes(b))!;
    expect(flat(wrap)).toMatchObject({ position: "absolute", pointerEvents: "box-none" });
    // 그림 칸 폭(가격 축 제외) 안
    expect(["center", "flex-start", "flex-end"]).toContain(flat(wrap).alignItems);
    expect(flat(wrap).width).toBeLessThan(419);
  });

  it("가운데에 급등한 봉 꼭대기가 있으면 그 봉을 덮지 않게 옆으로 (RGTX 6월 급등 모양), 위가 비어 있으면 가운데", () => {
    // 보이는 120봉(128~247) 중 앞쪽 25~35번째에 급등 (캡처처럼 왼쪽 가운데) → 버튼은 오른쪽
    const spike = RGTX.map((c, i) => (i >= 128 + 25 && i <= 128 + 35 ? { ...c, high: 60_000, close: 50_000, open: 45_000 } : c));
    const past = { text: "2일 전까지 보는 중", onLatest: () => undefined };
    const wrapOf = (r: ReturnType<typeof draw>) => r.all().find((n) => n.children.includes(button(r)!))!;
    expect(flat(wrapOf(draw({ candles: spike, view: { count: 120, offset: 2 }, pastView: past }))).alignItems).toBe("flex-end");
    // 봉이 모두 아래쪽에 있는 그림(평단이 위 끝을 넓힘)은 가운데
    expect(flat(wrapOf(draw({ view: { count: 120, offset: 2 }, avgPrice: 19_000, pastView: past }))).alignItems).toBe("center");
  });

  it("라이트·다크 모두 바탕·글자는 테마 토큰", () => {
    for (const isDark of [false, true]) {
      h.dark = isDark;
      const t = isDark ? dark : light;
      const r = draw({ view: { count: 120, offset: 2 }, pastView: { text: "2일 전까지 보는 중", onLatest: () => undefined } });
      const b = button(r)!;
      const style = (pressed: boolean) => Object.assign({}, ...[(b.props.style as (s: { pressed: boolean }) => unknown)({ pressed })].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
      expect(style(false)).toMatchObject({ backgroundColor: t.surface, borderColor: t.accent });
      expect(style(true).backgroundColor).toBe(t.surfaceAlt);
    }
  });

  it("버튼이 생기고 없어져도 제스처 틀은 같은 자리 (진행 중인 드래그가 끊기지 않게)", () => {
    const parentOf = (r: ReturnType<typeof draw>) => {
      const g = r.all().find((n) => n.type === "GestureDetector")!;
      const p = r.all().find((n) => n.children.includes(g))!;
      return { style: flat(p), index: p.children.indexOf(g) };
    };
    const without = parentOf(draw());
    const withBtn = parentOf(draw({ view: { count: 120, offset: 2 }, pastView: { text: "2일 전까지 보는 중", onLatest: () => undefined } }));
    expect(withBtn).toEqual(without);
    expect(without.style).toEqual({ width: 419, height: 260 });
  });
});

describe("RGTX 캡처 모양 (오늘 52주 신저가 · 6월 급등) — 접은 화면 475·411·360 과 넓은 창 (버그 수정)", () => {
  const K = rgtxDaily(800, RGTX_FX);
  const Q = { avg: RGTX_QUOTE.avg * RGTX_FX, price: RGTX_QUOTE.price * RGTX_FX, prev: RGTX_QUOTE.prevClose * RGTX_FX, high: RGTX_QUOTE.high52w * RGTX_FX, low: RGTX_QUOTE.low52w * RGTX_FX };
  type B = { l: number; r: number; t: number; b: number };
  /** 가격 칸 틀 안 캔들 path 4개(상승·하락 꼬리·몸통)에서 봉 상자를 읽는다 */
  const candleBoxes = (r: ReturnType<typeof draw>) => {
    const g = r.all().find((n) => n.type === "G")!;
    const paths = g.children.filter((c): c is HostNode => typeof c !== "string" && c.type === "Path").slice(0, 4);
    const out: (B & { x: number })[] = [];
    for (const p of paths) {
      const d = String(p.props.d);
      for (const m of d.matchAll(/M([\d.-]+) ([\d.-]+)h([\d.-]+)v([\d.-]+)h[\d.-]+z/g)) out.push({ l: +m[1]!, r: +m[1]! + +m[3]!, t: +m[2]!, b: +m[2]! + +m[4]!, x: +m[1]! + +m[3]! / 2 });
      for (const m of d.matchAll(/M([\d.-]+) ([\d.-]+)V([\d.-]+)/g)) out.push({ l: +m[1]! - 0.5, r: +m[1]! + 0.5, t: +m[2]!, b: +m[3]!, x: +m[1]! });
    }
    return out;
  };
  const labelBoxes = (r: ReturnType<typeof draw>) =>
    r.all()
      .filter((n) => n.type === "Rect" && n.props.fill === light.surface)
      .map((n) => ({ l: n.props.x as number, r: (n.props.x as number) + (n.props.width as number), t: n.props.y as number, b: (n.props.y as number) + (n.props.height as number) }));
  const hit = (a: B, c: B) => a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
  const sizes = [[419, 260], [355, 220], [304, 188], [560, 347]] as const;

  it("'52주 최저'·평단 글자 상자가 최신 봉(오른쪽 끝 5개)은 물론 어떤 봉도 덮지 않고, 서로 겹치지 않는다 — 예전에는 최신 봉 16~22개를 덮었다", () => {
    for (const [w, hh] of sizes)
      for (const count of [120, 60, 20]) {
        const r = draw({ candles: K, width: w, height: hh, view: { count, offset: 0 }, avgPrice: Q.avg, currentPrice: Q.price, prevClose: Q.prev, high52w: Q.high, low52w: Q.low, labelBg: light.surface });
        const bars = candleBoxes(r);
        const xs = [...new Set(bars.map((b) => Math.round(b.x)))].sort((a, b) => a - b);
        const latest = bars.filter((b) => Math.round(b.x) >= xs.at(-5)!);
        const labels = svgTexts(r).filter((s) => /^(평단|52주)/.test(s));
        expect(labels.some((s) => s.startsWith("평단")), `${w} ${count}`).toBe(true);
        const boxes = labelBoxes(r);
        expect(boxes.length, `${w} ${count}`).toBeGreaterThanOrEqual(2);
        for (const box of boxes) {
          expect(latest.filter((b) => hit(box, b)).length, `${w} ${count} 최신 봉`).toBe(0);
          expect(bars.filter((b) => hit(box, b)).length, `${w} ${count} 봉`).toBe(0);
        }
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i]!, boxes[j]!), `${w} ${count} 글자끼리`).toBe(false);
      }
  });

  it("선을 모두 그린 뒤에 글자: 현재가 점선이 평단·52주 글자를 가로지르지 않는다 (글자 바탕 상자가 선 위에 온다)", () => {
    const r = draw({ candles: K, width: 304, height: 188, avgPrice: Q.avg, currentPrice: Q.price, prevClose: Q.prev, low52w: Q.low, labelBg: light.surface });
    const svg = r.all().find((n) => n.type === "Svg")!;
    const order = svg.children.filter((c): c is HostNode => typeof c !== "string");
    const current = order.findIndex((n) => n.type === "Line" && n.props.strokeDasharray === "5 3" && n.props.stroke !== light.gold);
    const firstLabel = order.findIndex((n) => n.type === "Rect" && n.props.fill === light.surface);
    expect(current).toBeGreaterThan(-1);
    expect(firstLabel).toBeGreaterThan(current);
  });

  it("확대해서 이동평균이 보이는 구간 내내 가격 칸 위로 벗어나면 가장자리에 '120일선(범위 위)' + 그 선 색 네모 (칩이 켜져 있는데 선이 없어 고장처럼 보이지 않게)", () => {
    for (const isDark of [false, true]) {
      h.dark = isDark;
      const t = isDark ? dark : light;
      const r = draw({ candles: K, width: 419, height: 260, view: { count: 20, offset: 0 }, avgPrice: Q.avg, currentPrice: Q.price, labelBg: t.surface });
      expect(svgTexts(r)).toContain("120일선(범위 위)");
      // 20일선 등 보이는 선은 표시가 없다
      expect(svgTexts(r).filter((s) => /일선\(범위/.test(s))).toEqual(["120일선(범위 위)"]);
      const label = r.all().find((n) => n.type === "SvgText" && textOf(n) === "120일선(범위 위)")!;
      // 글자는 대비가 보장되는 muted, 색은 앞의 네모로
      expect(label.props.fill).toBe(t.muted);
      expect(r.all().some((n) => n.type === "Rect" && n.props.fill === t.chart.ma[120])).toBe(true);
    }
    // 최신 120봉(선이 보인다)에서는 표시가 없다
    expect(svgTexts(draw({ candles: K, avgPrice: Q.avg, currentPrice: Q.price })).some((s) => /일선\(범위/.test(s))).toBe(false);
    // 주봉은 '주선'
    const w = draw({ candles: K, period: "W", view: { count: 20, offset: 0 }, currentPrice: Q.price });
    expect(svgTexts(w)).toContain("120주선(범위 위)");
  });
});

describe("과거 구간 안내: 좁은 자리에서는 짧은 글 (접은 화면 360 · 큰 글씨)", () => {
  const button = (r: ReturnType<typeof draw>) => r.all().find((n) => n.type === "Pressable")!;
  const past = { text: "60일 전까지 보는 중", short: "60일 전", onLatest: () => undefined };

  it("그림 칸에 긴 글이 다 들어가면 긴 글, 안 들어가면 짧은 글 — 화면 읽기는 늘 긴 글", () => {
    expect(textOf(button(draw({ width: 560, height: 347, view: { count: 120, offset: 60 }, pastView: past })))).toBe("60일 전까지 보는 중 · 최신으로");
    for (const scale of [1, 1.3]) {
      h.scale = scale;
      // 360 창: 차트 폭 304, 가격 칸 약 260 → 긴 글(130% 약 250)이 들어가지 않거나 봉을 더 가린다
      const b = button(draw({ width: 304, height: 188, view: { count: 120, offset: 60 }, pastView: past }));
      if (scale > 1) expect(textOf(b), String(scale)).toBe("60일 전 · 최신으로");
      expect(b.props.accessibilityLabel).toBe("60일 전까지 보는 중. 누르면 최신 차트로 돌아갑니다");
    }
  });

  it("짧은 글이 없으면(예전 부르는 쪽) 긴 글 그대로", () => {
    h.scale = 1.3;
    expect(textOf(button(draw({ width: 304, height: 188, view: { count: 120, offset: 60 }, pastView: { text: "60일 전까지 보는 중", onLatest: () => undefined } })))).toBe("60일 전까지 보는 중 · 최신으로");
  });

  it("범위 밖 평단 글자('평단(범위 위) …' — 왼쪽 위)가 있으면 버튼은 그 글자를 덮지 않는 쪽으로", () => {
    const K = rgtxDaily(800, RGTX_FX);
    const r = draw({ candles: K, width: 419, height: 260, view: { count: 20, offset: 3 }, avgPrice: RGTX_QUOTE.avg * RGTX_FX, labelBg: light.surface, pastView: { text: "3일 전까지 보는 중", short: "3일 전", onLatest: () => undefined } });
    expect(svgTexts(r).some((s) => s.startsWith("평단(범위 위)"))).toBe(true);
    const wrap = r.all().find((n) => n.children.includes(button(r)))!;
    expect(flat(wrap).alignItems).not.toBe("flex-start");
  });
});
