import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";
import { RGTX_FX, RGTX_QUOTE, rgtxDaily } from "./rgtxCandles";

/**
 * 가격 차트 그림 (2026-09-26 RGTX 접은 화면 캡처).
 *  - 버그 수정(플래그 없음): 가격 축은 봉 기준 — 120일선 옛 값이 축을 넓히지 않고, 넘는 선은 가격 칸에서 잘린다.
 *    평단·52주 글자는 봉·서로를 가리지 않는 자리에 옅은 바탕 상자(바탕색 토큰)와 함께
 *  - 과거 구간 안내는 그림 밖(조작 줄 — CandleChart)에 있어 그림은 과거로 옮겨도 가격 칸을 줄이지 않는다 (축이 튀지 않게)
 *  - 맞춘 가격 축(기능 플래그 detailPolish — fitAxis): 축 글자를 그림 오른쪽 끝에 오른쪽 맞춤, 축 칸은 가장 긴 글자만큼 (오른쪽 빈 띠 없음)
 *  - 볼린저 채움 경로는 음수 좌표(칸 위로 벗어난 밴드)도 잃지 않는다
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

  it("자르기 틀 id 는 차트마다 따로 (웹은 id 가 문서 전체에서 하나 — 상세 위에 전체 화면 차트가 올라와도 제 틀로 자른다), url(#…) 에 쓸 수 있는 글자만", () => {
    const base = { candles: RGTX, period: "D" as const, currency: "KRW" as const, view: { count: 120, offset: 0 }, onViewChange: () => undefined, maPeriods: [20], showBollinger: false, showVolume: true, indicator: "none" as const };
    const r = render(
      <>
        <PriceChart {...base} width={419} height={260} />
        <PriceChart {...base} width={751} height={300} />
      </>,
    );
    const clips = r.all().filter((n) => n.type === "ClipPath");
    const ids = clips.map((c) => String(c.props.id));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    // 각 그림은 제 틀을 쓴다 (폭이 다른 두 틀)
    const groups = r.all().filter((n) => n.type === "G");
    expect(groups.map((g) => g.props.clipPath)).toEqual(ids.map((id) => `url(#${id})`));
    expect(clips.map((c) => (c.children[0] as HostNode).props.width)).not.toEqual([(clips[0]!.children[0] as HostNode).props.width, (clips[0]!.children[0] as HostNode).props.width]);
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

describe("과거 구간 안내는 그림 밖(조작 줄 — CandleChart)에: 과거로 옮겨도 가격 칸을 줄이지 않는다 (축이 튀지 않게, 2026-09-26)", () => {
  const clipRect = (r: ReturnType<typeof draw>) => r.all().find((n) => n.type === "ClipPath")!.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Rect")!.props;
  /** 가격 눈금 글자 (쉼표 있는 숫자)와 그 y */
  const ticks = (r: ReturnType<typeof draw>) =>
    r.all()
      .filter((n) => n.type === "SvgText" && /^\d{1,3}(,\d{3})+$/.test(textOf(n)) && n.props.fill === light.muted)
      .map((n) => [textOf(n), Math.round(n.props.y as number)] as const);
  const K = rgtxDaily(800, RGTX_FX);

  it("그림에는 누르는 버튼이 없고, 제스처 틀은 그림 묶음 바로 아래 (예전 main 과 같은 구조 — 안내를 덮던 둘레 틀 없음)", () => {
    for (const offset of [0, 2, 60]) {
      const r = draw({ view: { count: 120, offset }, fitAxis: true });
      expect(r.all().some((n) => n.type === "Pressable"), String(offset)).toBe(false);
      const g = r.all().find((n) => n.type === "GestureDetector")!;
      const parent = r.all().find((n) => n.children.includes(g))!;
      expect(flat(parent), String(offset)).toEqual({ width: 419, gap: 4 });
    }
  });

  it("가격 칸 자르기 틀은 과거로 옮겨도 맨 위(0)부터 칸 전체 — 예전에는 안내가 뜨면 위쪽 40 을 비워 축이 튀었다(475 에서 194 → 154)", () => {
    for (const [w, hh] of [[447, 260], [383, 220], [332, 188], [905, 352]] as const)
      for (const offset of [0, 2, 3, 60]) {
        const r = draw({ candles: K, width: w, height: hh, view: { count: 120, offset }, avgPrice: RGTX_QUOTE.avg * RGTX_FX, fitAxis: true });
        expect(clipRect(r), `${w} ${offset}`).toMatchObject({ y: 0, height: hh - 18 - Math.round(hh * 0.16) - 6 });
      }
  });

  it("최신 → 2봉 과거: 가격 축 눈금 자리가 그대로 (같은 봉이 보이면 같은 축 — 안내 때문에 눈금이 아래로 밀리지 않는다)", () => {
    // 평평한 구간: 2봉 옮겨도 보이는 봉의 고·저가 같아 축이 같다
    const flatBars = Array.from({ length: 200 }, (_, i) => ({ date: day(i), open: 100, high: 110 + (i % 2), low: 90 - (i % 2), close: 100, volume: 10 }));
    const a = ticks(draw({ candles: flatBars, currency: "KRW", view: { count: 120, offset: 0 }, fitAxis: true }));
    const b = ticks(draw({ candles: flatBars, currency: "KRW", view: { count: 120, offset: 2 }, fitAxis: true }));
    expect(b).toEqual(a);
  });
});

describe("맞춘 가격 축 (fitAxis — 기능 플래그 detailPolish, 2026-09-26 '차트 오른쪽 빈 여백 없애줘')", () => {
  const K = rgtxDaily(800, RGTX_FX);
  const props = { candles: K, avgPrice: RGTX_QUOTE.avg * RGTX_FX, currentPrice: RGTX_QUOTE.price * RGTX_FX, prevClose: RGTX_QUOTE.prevClose * RGTX_FX, low52w: RGTX_QUOTE.low52w * RGTX_FX };
  const plotW = (r: ReturnType<typeof draw>) => (r.all().find((n) => n.type === "ClipPath")!.children[0] as HostNode).props.width as number;
  /** 오른쪽 축 글자 (가격 눈금·현재가 태그·거래량 최댓값) */
  const axisTexts = (r: ReturnType<typeof draw>) => r.all().filter((n) => n.type === "SvgText" && (n.props.x as number) >= plotW(r));

  it("축 글자는 그림 오른쪽 끝 − 2 에 오른쪽 맞춤 → 글자 오른쪽 빈 띠는 2dp, 축 칸은 가장 긴 글자 + 6 만큼만", async () => {
    const { AXIS_GAP_R, axisTextWidth, fitAxisWidth } = await import("@/lib/chartBasis");
    for (const [w, hh] of [[447, 260], [383, 220], [332, 188], [905, 352]] as const) {
      const r = draw({ ...props, width: w, height: hh, fitAxis: true });
      const texts = axisTexts(r);
      // 가격 눈금 여럿 + 현재가 태그 + 거래량 최댓값
      expect(texts.length, String(w)).toBeGreaterThanOrEqual(3);
      for (const n of texts) {
        expect(n.props.textAnchor, `${w} ${textOf(n)}`).toBe("end");
        expect(n.props.x, `${w} ${textOf(n)}`).toBe(w - AXIS_GAP_R);
        // 글자 왼쪽 끝(어림)이 그림(plotW) 안으로 들어가지 않는다
        expect(w - AXIS_GAP_R - axisTextWidth(textOf(n)), `${w} ${textOf(n)}`).toBeGreaterThanOrEqual(plotW(r) + 4 - 0.01);
      }
      // 축 칸 = 가장 긴 글자 + 4 + 2 (2 단위 올림). 그리지 않는 축 끝 값(십자선이 보여 줄 수 있는 값)도 넣어 재므로 그만큼(한 자리)까지 넓을 수 있다
      const shown = fitAxisWidth(texts.map(textOf));
      expect(w - plotW(r), String(w)).toBeGreaterThanOrEqual(shown);
      expect(w - plotW(r), String(w)).toBeLessThanOrEqual(shown + 8);
    }
  });

  it("현재가 태그 상자는 그림 오른쪽 끝까지, 글자는 그 안 오른쪽 맞춤", () => {
    const r = draw({ ...props, width: 447, height: 260, fitAxis: true });
    const tag = r.all().find((n) => n.type === "Rect" && n.props.height === 16 && n.props.x === plotW(r))!;
    expect((tag.props.x as number) + (tag.props.width as number)).toBe(447);
    const label = axisTexts(r).find((n) => n.props.fontWeight === "700")!;
    expect(label.props.textAnchor).toBe("end");
    expect(label.props.x).toBe(445);
  });

  it("같은 창에서 그림(봉 칸)이 예전보다 넓다, 꺼져 있으면 예전 그대로 (축 칸 왼쪽 + 4 에 왼쪽 맞춤)", () => {
    const on = draw({ ...props, width: 447, height: 260, fitAxis: true });
    const off = draw({ ...props, width: 447, height: 260 });
    expect(plotW(on)).toBeGreaterThan(plotW(off));
    for (const n of axisTexts(off)) {
      expect(n.props.x).toBe(plotW(off) + 4);
      expect(n.props.textAnchor).toBe("start");
    }
  });

  it("사용자 캡처 창(475 접은 화면): 예전 그림 폭 419 · 축 48 → 봉 칸 371, 지금 447 · 맞춘 축 46 → 봉 칸 401 (+30 — 빈 띠 28 + 축 2)", () => {
    const before = plotW(draw({ ...props, width: 419, height: 260 }));
    const after = plotW(draw({ ...props, width: 447, height: 260, fitAxis: true }));
    expect(before).toBe(371);
    expect(after).toBe(401);
  });
});

describe("볼린저 채움 영역: 음수 좌표도 잃지 않는다 (reversePath)", () => {
  it("reversePath 는 음수 좌표를 건너뛰지 않는다 — 예전 정규식은 '-' 를 몰라 점이 빠졌다", async () => {
    const { reversePath } = await import("@/components/chart/PriceChart");
    expect(reversePath("M0.0 -5.2L10.0 -3.1L20.0 4.0L30.0 12.5")).toBe("L30.0 12.5L20.0 4.0L10.0 -3.1L0.0 -5.2");
    expect(reversePath("M-1.5 2.0L3.0 -0.5")).toBe("L3.0 -0.5L-1.5 2.0");
    expect(reversePath("")).toBe("");
  });

  it("급락 직후(아래 밴드가 가격 칸 위로 벗어남): 채움 경로의 점 수 = 위 밴드 + 아래 밴드", () => {
    // 100 원 40봉 뒤 50 원 15봉 — 보이는 15봉의 축은 50 원 근처, 첫 몇 봉의 아래 밴드(옛 100 원을 품은 20봉 평균 − 2σ)는 칸 위(음수 y)
    const crash = Array.from({ length: 55 }, (_, i) => {
      const c = i < 40 ? 100 : 50;
      return { date: day(i), open: c, high: c + 1, low: c - 1, close: c, volume: 10 };
    });
    const r = draw({ candles: crash, view: { count: 15, offset: 0 }, maPeriods: [], showBollinger: true });
    const fill = r.all().find((n) => n.type === "Path" && n.props.fillOpacity === 0.07)!;
    const pts = [...String(fill.props.d).matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)];
    expect(pts.length).toBe(15 + 15);
    // 이 경우를 실제로 거친다: 아래 밴드 점 중 음수 y 가 있다
    expect(pts.slice(15).some((m) => Number(m[2]) < 0)).toBe(true);
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
        // 현재가 점선 (빨강·파랑 — 평단 금색이 아닌 5 3 점선)
        const current = r.all().find((n) => n.type === "Line" && n.props.strokeDasharray === "5 3" && n.props.stroke !== light.gold)!;
        const cy = current.props.y1 as number;
        for (const box of boxes) {
          expect(latest.filter((b) => hit(box, b)).length, `${w} ${count} 최신 봉`).toBe(0);
          expect(bars.filter((b) => hit(box, b)).length, `${w} ${count} 봉`).toBe(0);
          // 글자 바탕 상자가 현재가선을 끊지 않는다 — 예전에는 '52주 최저' 상자가 현재가선 위에 놓여 현재가선에 붙은 글자처럼 읽혔다
          expect(box.t < cy && cy < box.b, `${w} ${count} 현재가선 (${cy.toFixed(1)} in ${box.t.toFixed(1)}~${box.b.toFixed(1)})`).toBe(false);
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
