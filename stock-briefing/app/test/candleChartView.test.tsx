import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 상세 차트 묶음(CandleChart)의 크기와 칩 띠 (3-42 접는 폰 3단계 1) · 폴드 진단 22·25·6·7번).
 *  - 휴대폰 화면(좁은 창 · foldLayout 꺼짐)은 3-42 이전 크기 그대로: 폭 min(창 폭 − 56, 720), 높이 폭 × 0.62 (사용자 결정 '접은 화면은 지금 그대로')
 *  - foldLayout 이 켜져 있고 폭 등급이 중간 이상이면: 폭은 차트 묶음이 실제로 받은 폭(onLayout — 28dp 빈 띠 없음), 720 상한을 풀고
 *    높이를 창 높이 × 0.5 로 제한, 칩·버튼 누르는 영역 44×44
 *  - 넓은 창만: 이동평균 값 줄은 항목 단위 줄바꿈 (휴대폰 화면은 3-42 이전 한 줄 글자)
 *  - 모든 창: 옆으로 넘기는 칩 띠는 넘길 내용이 있는 쪽 끝만 바탕색으로 흐리게 (2026-09-26 버그 수정 — 처음엔 넓은 창만)
 *  - 과거로 옮기면 차트 위 '2일 전까지 보는 중 · 최신으로' (기능 플래그 detailPolish)
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, fontScale: 1 },
  /** 서버가 준 foldLayout 값 (undefined = 아직 못 받음 → fallback 꺼짐) */
  flag: undefined as boolean | undefined,
  /** 서버가 준 detailPolish 값 (undefined = 못 받음 → fallback 꺼짐) */
  polish: undefined as boolean | undefined,
  dark: false,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false }) }));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : key === "detailPolish" ? (h.polish ?? fallback) : fallback),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => (h.dark ? tokens.dark : tokens.light), useFontScale: () => 1 };
});
// 그림(svg·제스처)은 따로 테스트한다 — 여기서는 받은 폭·높이만 본다
vi.mock("@/components/chart/PriceChart", () => ({
  PriceChart: "PriceChart",
  maColor: (t: { chart: { ma: Record<number, string> }; muted: string }, p: number) => t.chart.ma[p] ?? t.muted,
  clampView: (v: { count: number; offset: number }, total: number, minCount = 15, maxCount = 500) => {
    const count = Math.max(minCount, Math.min(maxCount, Math.min(v.count, Math.max(total, minCount))));
    return { count, offset: Math.max(0, Math.min(v.offset, Math.max(total - count, 0))) };
  },
}));

const { CandleChart } = await import("@/components/CandleChart");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { candleChartSize } = await import("@/lib/chartLayout");
const { clearOf, dark, layout, light, space, touch } = await import("@/tokens");

type R = ReturnType<typeof render>;
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const CANDLES = [
  { date: "2026-09-22", open: 100, high: 110, low: 95, close: 105, volume: 10 },
  { date: "2026-09-23", open: 105, high: 112, low: 101, close: 108, volume: 12 },
  { date: "2026-09-24", open: 108, high: 115, low: 104, close: 110, volume: 9 },
];
const SIZES = {
  "폴드8 접힘": [475, 751],
  "폴드8 펼침 가로": [933, 704],
  "폴드8 펼침 세로": [704, 933],
  "울트라 접힘": [411, 960],
  "울트라 펼침 세로": [859, 954],
  "울트라 펼침 가로": [954, 859],
} as const;
/** 종목·지수 상세 패널 안쪽 폭 (창 폭 − 좌우 여백 14 × 2) */
const inner = (w: number) => w - space.lg * 2;

const open = (props: Partial<React.ComponentProps<typeof CandleChart>> = {}) =>
  render(<CandleChart candles={CANDLES} period="D" onPeriodChange={() => undefined} {...props} />);
const root = (r: R) => r.tree.find((n): n is HostNode => typeof n !== "string")!;
/** 부모가 차트 묶음에 준 폭을 알린다 (onLayout) */
const layoutAs = (r: R, width: number) => r.act(() => (root(r).props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width, height: 500, x: 0, y: 0 } } }));
const chart = (r: R) => {
  const c = r.all().find((n) => n.type === "PriceChart")!;
  return { width: c.props.width as number, height: c.props.height as number };
};
const size = (w: number, hh: number) => {
  h.win = { width: w, height: hh, fontScale: 1 };
};

beforeEach(() => {
  size(475, 751);
  h.flag = undefined;
  h.polish = undefined;
  h.dark = false;
  forgetWindowClass();
});

/** 3-42 이전(main) 차트 크기: 폭 min(창 폭 − 56, 720), 높이 폭 × 0.62 — 휴대폰 화면(좁은 창·플래그 꺼짐)은 이 값 그대로 */
const mainSize = (w: number) => {
  const width = Math.min(w - space.lg * 2 - space.lg * 2, 720);
  return { width, height: Math.round(width * 0.62) };
};

describe("휴대폰 화면(좁은 창 · 플래그 꺼짐)은 3-42 이전 차트 크기 그대로 (사용자 결정 '접은 화면은 지금 그대로')", () => {
  it("360·411·475 창 × 플래그 못 받음·꺼짐·켜짐: 첫 그림부터 창 폭 − 56 (304×188 · 355×220 · 419×260), 잰 폭이 와도 그대로", () => {
    const want = { 360: { width: 304, height: 188 }, 411: { width: 355, height: 220 }, 475: { width: 419, height: 260 } } as const;
    for (const [w, hh] of [[360, 780], [411, 960], [475, 751]] as const) {
      for (const flag of [undefined, false, true]) {
        size(w, hh);
        h.flag = flag;
        forgetWindowClass();
        const r = open();
        expect(chart(r), `${w} ${flag}`).toEqual(want[w]);
        expect(chart(r), `${w} ${flag}`).toEqual(mainSize(w));
        // 패널 안쪽 폭(창 폭 − 28)을 재어 알려 와도 예전 식 그대로 (오른쪽 28dp 띠도 예전처럼)
        layoutAs(r, inner(w));
        expect(chart(r), `${w} ${flag}`).toEqual(want[w]);
        // 다른 폭을 알려 와도 (다른 여백의 패널 등)
        layoutAs(r, 400.6);
        expect(chart(r), `${w} ${flag}`).toEqual(want[w]);
      }
    }
  });

  it("데이터가 없을 때 자리 표시 칸도 같은 높이", () => {
    const r = open({ candles: [] });
    const box = r.all().find((n) => n.type === "View" && flat(n).borderRadius !== undefined && flat(n).height !== undefined)!;
    expect(flat(box).height).toBe(mainSize(475).height);
  });

  it("부르는 쪽이 폭·높이를 정하면(전체 화면 차트) 재지 않고 그대로", () => {
    size(933, 704);
    h.flag = true;
    const r = open({ width: 909, height: 480, compact: true });
    expect(root(r).props.onLayout).toBeUndefined();
    expect(chart(r)).toEqual({ width: 909, height: 480 });
  });
});

describe("넓은 창 배치 (진단 6·7·22번, 플래그 foldLayout)", () => {
  const each = (flag: boolean | undefined) =>
    Object.fromEntries(
      (Object.keys(SIZES) as (keyof typeof SIZES)[]).map((name) => {
        const [w, hh] = SIZES[name];
        size(w, hh);
        h.flag = flag;
        forgetWindowClass();
        const r = open();
        layoutAs(r, inner(w));
        return [name, chart(r)];
      }),
    );

  it("플래그 꺼짐(못 받음 포함): 어느 크기에서도 3-42 이전 식 그대로 (720 상한, 높이 = 폭 × 0.62)", () => {
    for (const flag of [undefined, false]) {
      expect(each(flag)).toEqual({
        "폴드8 접힘": { width: 419, height: 260 },
        "폴드8 펼침 가로": { width: 720, height: 446 },
        "폴드8 펼침 세로": { width: 648, height: 402 },
        "울트라 접힘": { width: 355, height: 220 },
        "울트라 펼침 세로": { width: 720, height: 446 },
        "울트라 펼침 가로": { width: 720, height: 446 },
      });
      for (const [name, s] of Object.entries(each(flag))) expect(s, name).toEqual(mainSize(SIZES[name as keyof typeof SIZES][0]));
    }
  });

  it("플래그 켜짐: 넓은 창은 잰 패널 폭을 다 쓰고(28dp 빈 띠 없음) 높이는 창 높이의 절반까지, 접힌 화면은 그대로", () => {
    expect(each(true)).toEqual({
      "폴드8 접힘": { width: 419, height: 260 },
      // 933×704: 높이 352 → 날짜 줄·이동평균 칩까지 첫 화면에 (예전 446 은 아래가 화면 밖)
      "폴드8 펼침 가로": { width: 905, height: 352 },
      "폴드8 펼침 세로": { width: 676, height: 419 },
      "울트라 접힘": { width: 355, height: 220 },
      "울트라 펼침 세로": { width: 831, height: 477 },
      "울트라 펼침 가로": { width: 926, height: 430 },
    });
    for (const [name, s] of Object.entries(each(true))) {
      const [, hh] = SIZES[name as keyof typeof SIZES];
      expect(s.height, name).toBeLessThanOrEqual(Math.round(hh * layout.chartMaxHRatio));
    }
  });

  it("넓은 창: 잰 폭이 어림과 다르면 잰 폭을 쓴다 (다른 여백의 패널·2단 칸)", () => {
    size(933, 704);
    h.flag = true;
    const r = open();
    expect(chart(r)).toEqual({ width: 905, height: 352 });
    layoutAs(r, 400.6);
    expect(chart(r)).toEqual({ width: 400, height: 248 });
  });

  it("같은 계산을 쓴다 (lib/chartLayout candleChartSize)", () => {
    size(933, 704);
    h.flag = true;
    const r = open();
    layoutAs(r, 600);
    expect(chart(r)).toEqual(candleChartSize({ box: 600, window: { width: 933, height: 704 }, wide: true }));
  });

  it("폰을 접으면(넓은 창 → 좁은 창) 바로 휴대폰 화면 크기로 — 새 폭을 재기(onLayout) 전 첫 그림부터", () => {
    for (const flag of [true, false, undefined]) {
      size(933, 704);
      h.flag = flag;
      forgetWindowClass();
      const r = open();
      layoutAs(r, inner(933));
      expect(chart(r), `${flag}`).toEqual(flag ? { width: 905, height: 352 } : { width: 720, height: 446 });
      size(475, 751);
      r.rerender();
      // 잰 폭은 아직 펼쳤을 때의 905 — 휴대폰 화면은 잰 폭을 쓰지 않아 바로 예전 크기 (화면 밖으로 넘치지 않는다)
      expect(chart(r), `${flag}`).toEqual(mainSize(475));
      layoutAs(r, inner(475));
      expect(chart(r), `${flag}`).toEqual(mainSize(475));
    }
  });

  it("울트라 펼침 → 접힘, 펼친 가로 → 세로도 재기 전부터 창 안에", () => {
    h.flag = true;
    size(954, 859);
    const r = open();
    layoutAs(r, inner(954));
    size(411, 960);
    r.rerender();
    expect(chart(r)).toEqual(mainSize(411));

    size(933, 704);
    forgetWindowClass();
    const r2 = open();
    layoutAs(r2, inner(933));
    size(704, 933);
    r2.rerender();
    expect(chart(r2)).toEqual({ width: 676, height: 419 });
  });

  it("낮은 창에서도 높이 하한 chartMinH, 폭 600 부터 높이 상한을 서서히", () => {
    h.flag = true;
    const at = (w: number, hh: number) => {
      size(w, hh);
      forgetWindowClass();
      const r = open();
      layoutAs(r, inner(w));
      return chart(r);
    };
    // 펼친 폴드8 가로를 위아래로 나눈 창: 예전 150
    expect(at(933, 300)).toEqual({ width: 905, height: layout.chartMinH });
    // 좁음(599)은 휴대폰 화면 그대로 → 중간(600)은 잰 폭, 높이 상한은 아직 거의 쓰지 않는다 (예전 354 → 200 처럼 뛰지 않는다)
    expect(at(599, 400)).toEqual(mainSize(599));
    expect(at(600, 400)).toEqual({ width: 572, height: 355 });
    expect(at(layout.mediumMin + layout.chartCapRamp, 400).height).toBe(layout.chartMinH);
  });
});

describe("넓은 창의 차트 칩·버튼은 누르는 영역 44×44 (3-42, 플래그 foldLayout)", () => {
  const PERIODS = ["일봉", "주봉", "월봉", "1분봉", "5분봉", "30분봉"];
  const MA = [5, 10, 20, 60, 120, 200].map((p) => `${p} 이동평균선`);
  const ICONS = ["과거로", "최신으로", "차트 크게 보기"];
  const press = (r: R, label: string) => r.all().find((n) => n.type === "Pressable" && n.props.accessibilityLabel === label)!;
  type Slop = { top: number; bottom: number; left: number; right: number };
  const target = (n: HostNode) => {
    const s = flat(n);
    const slop = n.props.hitSlop as Slop;
    const w = Math.max(Number(s.minWidth ?? 0), Number(s.width ?? 0));
    const hgt = Math.max(Number(s.minHeight ?? 0), Number(s.height ?? 0));
    return { w, h: hgt + slop.top + slop.bottom, slop };
  };
  const draw = (w: number, hh: number, flag: boolean | undefined, props: Partial<React.ComponentProps<typeof CandleChart>> = {}) => {
    size(w, hh);
    h.flag = flag;
    forgetWindowClass();
    return open({ onFullscreen: () => undefined, ...props });
  };

  it("넓은 창(펼친 폴드8 가로·세로·울트라): 기간 칩 · 과거로/최신으로/크게 보기 · 이동평균 스위치의 보이는 폭 44 이상 + 높이 32 + 위아래 6 = 44", () => {
    for (const [w, hh] of [SIZES["폴드8 펼침 가로"], SIZES["폴드8 펼침 세로"], SIZES["울트라 펼침 세로"], [600, 800]] as const) {
      const r = draw(w, hh, true);
      for (const label of [...PERIODS, ...MA, ...ICONS]) {
        const t = target(press(r, label));
        // 폭은 hitSlop 없이 보이는 폭만으로 44 (가로 스크롤 끝의 첫·마지막 칩은 좌우 hitSlop 이 스크롤 틀 밖이라 잘린다)
        expect(t.w, `${w} ${label}`).toBeGreaterThanOrEqual(touch.min);
        expect(t.h, `${w} ${label}`).toBeGreaterThanOrEqual(touch.min);
        // 이웃과 겹치지 않는다: 좌우 hitSlop 은 칩·버튼 간격(6)의 절반 이하
        expect(t.slop.left + t.slop.right, `${w} ${label}`).toBeLessThanOrEqual(space.s);
      }
      // 글자는 가운데 (좁은 칩 '일' 이 44 로 넓어져도)
      expect(flat(press(r, "일봉")).justifyContent).toBe("center");
    }
  });

  it("전체 화면 차트(한 줄로 합친 도구)도 넓은 창이면 44", () => {
    const r = draw(933, 704, true, { compact: true, width: 909, height: 480, onFullscreen: undefined });
    for (const label of [...PERIODS, ...MA, "과거로", "최신으로"]) {
      const t = target(press(r, label));
      expect(t.w, label).toBeGreaterThanOrEqual(touch.min);
      expect(t.h, label).toBeGreaterThanOrEqual(touch.min);
    }
  });

  it("휴대폰 화면(접힌 화면 · 플래그 꺼짐)은 지금 그대로: 칩은 글자 폭, 아이콘 버튼은 32×32", () => {
    for (const [w, hh, flag] of [[475, 751, true], [411, 960, true], [360, 780, undefined], [933, 704, false], [933, 704, undefined]] as const) {
      const r = draw(w, hh, flag);
      for (const label of [...PERIODS, ...MA]) {
        const s = flat(press(r, label));
        expect(s.minWidth, `${w} ${flag} ${label}`).toBeUndefined();
        expect(s.minHeight, `${w} ${flag} ${label}`).toBe(32);
        expect(s.justifyContent, `${w} ${flag} ${label}`).toBeUndefined();
      }
      for (const label of ICONS) expect(flat(press(r, label)), `${w} ${flag} ${label}`).toMatchObject({ width: 32, height: 32 });
    }
  });
});

describe("칩 띠 끝 흐림 (진단 25번 — 모든 창)", () => {
  const strips = (r: R) => r.all().filter((n) => n.type === "ScrollView");
  const fades = (r: R) => r.all().filter((n) => n.type === "LinearGradient");
  const scroll = (r: R, i: number, m: { view?: number; content?: number; x?: number }) =>
    r.act(() => {
      const s = strips(r)[i]!;
      if (m.view !== undefined) (s.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: m.view, height: 44, x: 0, y: 0 } } });
      if (m.content !== undefined) (s.props.onContentSizeChange as (w: number, hh: number) => void)(m.content, 44);
      if (m.x !== undefined) (s.props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: m.x, y: 0 } } });
    });
  const side = (n: HostNode) => (flat(n).right === 0 ? "right" : flat(n).left === 0 ? "left" : "?");
  /** 펼친 폴드8 가로 + 플래그 켜짐 (넓은 창) */
  const wideOpen = (props: Partial<React.ComponentProps<typeof CandleChart>> = {}) => {
    size(933, 704);
    h.flag = true;
    forgetWindowClass();
    return open(props);
  };

  it("상세 화면에는 칩 띠가 둘(조작 줄·이동평균 줄), 전체 화면은 하나(한 줄로 합침)", () => {
    expect(strips(open())).toHaveLength(2);
    expect(strips(open({ compact: true, width: 400, height: 300 }))).toHaveLength(1);
    expect(strips(wideOpen())).toHaveLength(2);
    expect(strips(wideOpen({ compact: true, width: 400, height: 300 }))).toHaveLength(1);
  });

  it("넓은 창: 칩이 다 보이면 칠하지 않고, 넘길 칩이 있는 쪽만 칠한다", () => {
    const r = wideOpen();
    expect(fades(r)).toHaveLength(0);
    // 다 보임
    scroll(r, 0, { view: 400, content: 380 });
    expect(fades(r)).toHaveLength(0);
    // 오른쪽에 더 있음
    scroll(r, 0, { content: 520 });
    expect(fades(r).map(side)).toEqual(["right"]);
    // 넘기는 중: 양쪽
    scroll(r, 0, { x: 60 });
    expect(fades(r).map(side)).toEqual(["left", "right"]);
    // 끝까지: 왼쪽만
    scroll(r, 0, { x: 120 });
    expect(fades(r).map(side)).toEqual(["left"]);
    // 다른 띠(이동평균 줄)는 따로
    scroll(r, 1, { view: 300, content: 450, x: 0 });
    expect(fades(r)).toHaveLength(2);
  });

  it("넓은 창: 바탕색 토큰에서 투명으로 칠하고(라이트·다크), 누르기·화면 읽기를 가로채지 않는다", () => {
    for (const isDark of [false, true]) {
      h.dark = isDark;
      const t = isDark ? dark : light;
      const r = wideOpen();
      scroll(r, 0, { view: 300, content: 500, x: 50 });
      const [left, right] = fades(r);
      expect(right!.props.colors).toEqual([clearOf(t.surface), t.surface]);
      expect(left!.props.colors).toEqual([t.surface, clearOf(t.surface)]);
      for (const f of [left!, right!]) {
        expect(flat(f).pointerEvents).toBe("none");
        // 위에 덧칠만 한다 (자리를 차지하지 않는다)
        expect(flat(f).position).toBe("absolute");
        expect(f.props.importantForAccessibility).toBe("no-hide-descendants");
        expect(f.props.accessibilityElementsHidden).toBe(true);
        expect(flat(f).width).toBe(space.xl);
      }
    }
  });

  it("넓은 창: 바탕이 다른 화면(전체 화면 t.bg)은 그 색으로", () => {
    const r = wideOpen({ compact: true, width: 400, height: 300, backdrop: light.bg });
    scroll(r, 0, { view: 300, content: 500, x: 0 });
    expect(fades(r)[0]!.props.colors).toEqual([clearOf(light.bg), light.bg]);
  });

  it("넓은 창 누르는 영역: 띠 틀을 위아래로 넓히고(음수 여백) 스크롤 영역이 그 틀을 채운다 — 보이는 배치는 그대로", async () => {
    const { CHIP_SLOP } = await import("@/components/chart/ChipStrip");
    const r = wideOpen();
    const s = strips(r)[0]!;
    const frame = r.all().find((n) => n.children.includes(s))!;
    expect(flat(frame).marginVertical).toBe(-CHIP_SLOP.top);
    expect(flat({ ...s, props: { style: s.props.contentContainerStyle } })).toMatchObject({ paddingVertical: CHIP_SLOP.top });
    expect(CHIP_SLOP.top * 2 + 32).toBeGreaterThanOrEqual(44);
  });

  it("휴대폰·접은 화면(360·411·475 창 × 플래그 못 받음·꺼짐·켜짐, 넓은 창 + 플래그 꺼짐)도 넘길 칩이 있는 쪽만 흐린다 (2026-09-26 버그 수정 — 잘린 '30분'·'RSI' 칩이 깨져 보이던 것)", async () => {
    const { CHIP_SLOP } = await import("@/components/chart/ChipStrip");
    const cases: [number, number, boolean | undefined][] = [];
    for (const [w, hh] of [[360, 780], [411, 960], [475, 751]] as const) for (const flag of [undefined, false, true]) cases.push([w, hh, flag]);
    cases.push([933, 704, false], [933, 704, undefined]);
    for (const [w, hh, flag] of cases) {
      size(w, hh);
      h.flag = flag;
      h.dark = false;
      forgetWindowClass();
      for (const props of [{}, { compact: true, width: 400, height: 300, backdrop: light.bg }]) {
        const r = open(props);
        const list = strips(r);
        expect(list, `${w} ${flag}`).toHaveLength("compact" in props ? 1 : 2);
        list.forEach((s, i) => {
          // 누르는 영역 44 는 그대로: 띠 틀이 위아래 음수 여백, 조작 줄 띠만 flex 1
          const frame = r.all().find((n) => n.children.includes(s))!;
          expect(flat(frame), `${w} ${flag} ${i}`).toEqual(i === 0 ? { marginVertical: -CHIP_SLOP.top, flex: 1 } : { marginVertical: -CHIP_SLOP.top });
          expect(s.props.horizontal).toBe(true);
          expect(s.props.showsHorizontalScrollIndicator).toBe(false);
          expect(s.props.contentContainerStyle).toEqual({ flexDirection: "row", gap: space.s, alignItems: "center", paddingVertical: CHIP_SLOP.top });
        });
        // 재기 전·칩이 다 보이면 칠하지 않는다
        expect(fades(r), `${w} ${flag}`).toHaveLength(0);
        scroll(r, 0, { view: 300, content: 300 });
        expect(fades(r), `${w} ${flag}`).toHaveLength(0);
        // 넘길 칩이 오른쪽에 있으면 오른쪽 끝만 (바탕색 토큰 → 투명)
        scroll(r, 0, { content: 420 });
        expect(fades(r).map(side), `${w} ${flag}`).toEqual(["right"]);
        const bg = "compact" in props ? light.bg : light.surface;
        expect(fades(r)[0]!.props.colors).toEqual([clearOf(bg), bg]);
      }
    }
  });
});

describe("이동평균 값 줄: 넓은 창만 항목 단위 줄바꿈 (진단 24번)", () => {
  const maItems = (r: R) => r.all().find((n) => n.type === "PriceChart")!.props.maItems;

  it("휴대폰 화면(360·411·475 × 플래그 못 받음·꺼짐·켜짐, 넓은 창 + 플래그 꺼짐)은 3-42 이전 한 줄 글자 (maItems 꺼짐)", () => {
    for (const [w, hh, flag] of [
      [360, 780, undefined],
      [360, 780, false],
      [360, 780, true],
      [411, 960, true],
      [475, 751, true],
      [475, 751, false],
      [933, 704, false],
      [933, 704, undefined],
    ] as const) {
      size(w, hh);
      h.flag = flag;
      forgetWindowClass();
      expect(maItems(open()), `${w} ${flag}`).toBe(false);
    }
  });

  it("넓은 창(플래그 켜짐, 폭 600 이상)은 항목 단위 (maItems 켜짐)", () => {
    for (const [w, hh] of [[933, 704], [704, 933], [859, 954], [600, 800]] as const) {
      size(w, hh);
      h.flag = true;
      forgetWindowClass();
      expect(maItems(open()), `${w}`).toBe(true);
    }
  });
});

describe("CandleChart 를 쓰는 화면 모두 확인", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const uses = (rel: string) => [...readFileSync(`${SRC}/${rel}`, "utf8").matchAll(/<CandleChart\b([\s\S]*?)\/>/g)].map((m) => m[1]!);

  it("종목 상세·지수 상세는 폭을 넘기지 않아 잰 폭·넓은 창 규칙을 따른다", () => {
    for (const rel of ["app/stocks/[code]/index.tsx", "app/market/[code].tsx"]) {
      const found = uses(rel);
      // 휴대폰 화면 1개 + 넓은 창 배치(3-42 웨이브 C) 1개
      expect(found, rel).toHaveLength(2);
      expect(found[0], rel).not.toMatch(/\bwidth=/);
      expect(found[0], rel).not.toMatch(/\bheight=/);
    }
  });

  it("종목·지수 상세 넓은 창 배치는 폭을 넘기지 않고(잰 폭), 높이만 칸에 맞춰 넘긴다 (lib/detailLayout)", () => {
    for (const rel of ["app/stocks/[code]/index.tsx", "app/market/[code].tsx"]) {
      const wide = uses(rel)[1]!;
      expect(wide, rel).not.toMatch(/\bwidth=/);
      expect(wide, rel).toMatch(/\bheight=\{height\}/);
    }
  });

  it("전체 화면 차트는 창에서 계산한 폭·높이를 넘기고 바탕색(t.bg)을 알린다", () => {
    const found = uses("app/stocks/[code]/chart.tsx");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/\bwidth=\{chartW\}/);
    expect(found[0]).toMatch(/\bheight=\{chartH\}/);
    expect(found[0]).toMatch(/\bbackdrop=\{t\.bg\}/);
  });

  it("상세 패널의 좌우 여백이 어림(창 폭 − 14 × 2)과 같다 → 첫 그림과 잰 뒤 크기가 같다", () => {
    for (const rel of ["app/stocks/[code]/index.tsx", "app/market/[code].tsx"]) {
      expect(readFileSync(`${SRC}/${rel}`, "utf8"), rel).toMatch(/panel: \{ paddingHorizontal: space\.lg,/);
    }
  });
});

describe("과거 구간 안내 (기능 플래그 detailPolish — 2026-09-26 RGTX 캡처 '120일 · 2일 전')", () => {
  const DAY = 86_400_000;
  const MANY = Array.from({ length: 300 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10), open: 100, high: 110, low: 90, close: 105, volume: 10 }));
  const openMany = (props: Partial<React.ComponentProps<typeof CandleChart>> = {}) => render(<CandleChart candles={MANY} period="D" onPeriodChange={() => undefined} {...props} />);
  const pc = (r: R) => r.all().find((n) => n.type === "PriceChart")!;
  type Past = { text: string; onLatest: () => void } | null;
  const past = (r: R) => pc(r).props.pastView as Past;
  const drag = (r: R, offset: number) => r.act(() => (pc(r).props.onViewChange as (v: { count: number; offset: number }) => void)({ count: 120, offset }));

  it("켜짐: 드래그로 2봉 과거로 가면 '2일 전까지 보는 중', 누르면 최신 구간으로 돌아가고 안내가 사라진다", () => {
    h.polish = true;
    const r = openMany();
    expect(past(r)).toBeNull();
    drag(r, 2);
    expect(past(r)?.text).toBe("2일 전까지 보는 중");
    // 칩에도 그대로 '120일 · 2일 전'
    expect(r.text()).toContain("120일 · 2일 전");
    r.act(() => past(r)!.onLatest());
    expect(pc(r).props.view).toEqual({ count: 120, offset: 0 });
    expect(past(r)).toBeNull();
  });

  it("켜짐: 과거로 버튼(반 화면씩)도 같은 안내, 주·월·분봉 단위", () => {
    h.polish = true;
    const r = openMany();
    r.act(() => (r.byLabel("과거로").props.onPress as () => void)());
    expect(past(r)?.text).toBe("60일 전까지 보는 중");
    const w = openMany({ period: "W" });
    drag(w, 3);
    expect(past(w)?.text).toBe("3주 전까지 보는 중");
    // 5분봉 나흘치 (하루 78봉): 같은 날 안이면 분·시간, 전날까지 가면 보이는 마지막 봉의 날짜·시각
    const bar = (date: string, k: number) => {
      const min = 9 * 60 + 30 + k * 5;
      const hm = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
      return { date, time: `${date}T${hm}:00-04:00`, open: 100, high: 110, low: 90, close: 105, volume: 10 };
    };
    const FIVE = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"].flatMap((d) => Array.from({ length: 78 }, (_, k) => bar(d, k)));
    const m = render(<CandleChart candles={FIVE} period="5m" onPeriodChange={() => undefined} />);
    drag(m, 4);
    expect(past(m)).toMatchObject({ text: "20분 전까지 보는 중", short: "20분 전" });
    drag(m, 13);
    expect(past(m)?.text).toBe("1시간 5분 전까지 보는 중");
    // 100봉 앞 = 9/23 의 56번째 봉 (14:05) — 예전에는 '500분 전' (장 이틀에 걸친 시간을 분으로 적어 8시간 전처럼 읽혔다)
    drag(m, 100);
    expect(past(m)).toMatchObject({ text: "9월 23일 14:05까지 보는 중", short: "9/23 14:05까지" });
  });

  it("꺼짐·못 받음: 과거로 옮겨도 안내가 없다 (예전 그대로 — 칩의 '· 2일 전' 만)", () => {
    for (const polish of [undefined, false]) {
      h.polish = polish;
      const r = openMany();
      drag(r, 2);
      expect(past(r), String(polish)).toBeNull();
      expect(r.text()).toContain("120일 · 2일 전");
    }
  });

  it("기간을 바꾸면 최신 구간에서 시작하고, 원래 기간으로 돌아와도 최신 구간, 화면을 다시 열어도 최신 구간 (보이는 구간은 화면 상태)", () => {
    h.polish = true;
    let period: "D" | "W" = "D";
    const r = render(<CandleChart candles={MANY} period={period} onPeriodChange={() => undefined} />);
    drag(r, 5);
    expect(past(r)?.text).toBe("5일 전까지 보는 중");
    period = "W";
    r.rerender(<CandleChart candles={MANY} period={period} onPeriodChange={() => undefined} />);
    expect(pc(r).props.view).toMatchObject({ offset: 0 });
    expect(past(r)).toBeNull();
    // 일 → 주 → 일로 돌아와도 일봉의 옛 위치('5일 전')가 되살아나지 않는다 (예전에는 되살아났다)
    period = "D";
    r.rerender(<CandleChart candles={MANY} period={period} onPeriodChange={() => undefined} />);
    expect(pc(r).props.view).toEqual({ count: 120, offset: 0 });
    expect(past(r)).toBeNull();
    expect(r.text()).not.toContain("5일 전");
    // 봉 수 칩을 바꾼 뒤 기간을 오가도 새 기간의 기본 칩
    r.act(() => (r.all().find((n) => n.type === "Pressable" && /^보이는 봉/.test(String(n.props.accessibilityLabel)))!.props.onPress as () => void)());
    expect((pc(r).props.view as { count: number }).count).not.toBe(120);
    period = "W";
    r.rerender(<CandleChart candles={MANY} period={period} onPeriodChange={() => undefined} />);
    period = "D";
    r.rerender(<CandleChart candles={MANY} period={period} onPeriodChange={() => undefined} />);
    expect(pc(r).props.view).toEqual({ count: 120, offset: 0 });
    // 새로 연 화면
    expect(pc(openMany()).props.view).toMatchObject({ offset: 0 });
  });

  it("그림 안 글자 바탕은 차트 뒤 바탕색 (패널 t.surface, 전체 화면 t.bg)", () => {
    expect(pc(openMany()).props.labelBg).toBe(light.surface);
    expect(pc(openMany({ compact: true, width: 400, height: 300, backdrop: light.bg })).props.labelBg).toBe(light.bg);
  });
});
