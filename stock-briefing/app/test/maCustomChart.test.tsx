import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNode } from "./miniRender";

/**
 * 차트 이동평균 칩·선 (3-39 PR 2, 기능 플래그 maCustom — CandleChart 가 부품 안에서 읽는다).
 *  - 끄면 지금 그대로: 칩 6개(5·10·20·60·120·200)·고정 색·chartPrefs.v1 의 maPeriods, '설정' 칩 없음, 새 키(chartPrefs.maLines.v1)를 읽지 않음
 *  - 켜면 칩 6개 = 선 1~6 (기간·색은 기기 저장 chartPrefs.maLines.v1). 저장한 적이 없으면 지금과 같은 기간·색·켜짐
 *  - 칩을 누르면 그 선의 보이기만 바꿔 새 키에 적는다(chartPrefs.v1 은 쓰지 않음). 읽기가 늦게 끝나도 누른 값이 옛 저장값에 덮이지 않는다
 *  - 화면이 onMaSettings 를 주면(켬일 때만) 이동평균 칩 뒤에 '설정' 칩
 */
const h = vi.hoisted(() => {
  /** 가짜 기기 저장소 — 모듈을 새로 불러도(앱 다시 켜기) 남는다 */
  const store = new Map<string, string>();
  /** 늦게 답하기(hold)로 붙잡아 둔 읽기 */
  const waiting: (() => void)[] = [];
  return {
    /** 서버가 준 maCustom 값 (undefined = 못 받음 → fallback 꺼짐) */
    maCustom: undefined as boolean | undefined,
    dark: false,
    store,
    gets: [] as string[],
    sets: [] as [string, string][],
    hold: false,
    waiting,
    /** 붙잡아 둔 읽기에 (부른 순간의 값으로) 답한다 */
    release() {
      for (const f of waiting.splice(0)) f();
    },
  };
});

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 475, height: 751, fontScale: 1 }),
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => {
      h.gets.push(k);
      const v = h.store.get(k) ?? null;
      if (!h.hold) return Promise.resolve(v);
      return new Promise<string | null>((res) => h.waiting.push(() => res(v)));
    },
    setItem: async (k: string, v: string) => {
      h.sets.push([k, v]);
      h.store.set(k, v);
    },
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false }) }));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => (key === "maCustom" ? (h.maCustom ?? fallback) : fallback),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => (h.dark ? tokens.dark : tokens.light), useFontScale: () => 1 };
});
// 그림은 따로 테스트한다 (test/maColors) — 여기서는 받은 속성만 본다
vi.mock("@/components/chart/PriceChart", () => ({
  PriceChart: "PriceChart",
  maColor: (t: { chart: { ma: Record<number, string> }; muted: string }, p: number) => t.chart.ma[p] ?? t.muted,
  clampView: (v: { count: number; offset: number }, total: number, minCount = 15, maxCount = 500) => {
    const count = Math.max(minCount, Math.min(maxCount, Math.min(v.count, Math.max(total, minCount))));
    return { count, offset: Math.max(0, Math.min(v.offset, Math.max(total - count, 0))) };
  },
}));

const { light } = await import("@/tokens");

const NEW_KEY = "chartPrefs.maLines.v1";
const OLD_KEY = "chartPrefs.v1";
const CANDLES = [
  { date: "2026-09-22", open: 100, high: 110, low: 95, close: 105, volume: 10 },
  { date: "2026-09-23", open: 105, high: 112, low: 101, close: 108, volume: 12 },
  { date: "2026-09-24", open: 108, high: 115, low: 104, close: 110, volume: 9 },
];
const LABELS = ["5 이동평균선", "10 이동평균선", "20 이동평균선", "60 이동평균선", "120 이동평균선", "200 이동평균선"];
/** 저장해 둔 선 (선 1 = 7일·갈색·켬, 선 2 = 10일·켬, 선 5·6 끔) */
const SAVED = [
  { period: 7, color: 6, on: true },
  { period: 10, color: 1, on: true },
  { period: 20, color: 2, on: true },
  { period: 60, color: 3, on: true },
  { period: 120, color: 4, on: false },
  { period: 200, color: 5, on: false },
];

type Opened = Awaited<ReturnType<typeof open>>;
/**
 * 앱을 켜고 차트를 그린다: 모듈을 새로 불러(모듈 캐시 비움 — 저장소는 그대로) 새 렌더러로 그린다.
 * credentials.test.tsx 의 restart() 와 같은 방법 (react·miniRender·CandleChart 를 함께 새로)
 */
async function open(props: Record<string, unknown> = {}) {
  vi.resetModules();
  const R = await import("react");
  const mr = await import("./miniRender");
  const { CandleChart } = await import("@/components/CandleChart");
  const el = () => R.createElement(CandleChart, { candles: CANDLES, period: "D", onPeriodChange: () => undefined, ...props } as React.ComponentProps<typeof CandleChart>);
  const r = mr.render(el());
  return r;
}
/** 저장소 읽기(가짜 — 바로 끝남)가 끝난 뒤 다시 그린다 */
async function settle(r: Opened) {
  await new Promise((res) => setTimeout(res, 0));
  await new Promise((res) => setTimeout(res, 0));
  r.rerender();
}
const maChips = (r: Opened) => r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityRole === "switch" && /이동평균선$/.test(String(n.props.accessibilityLabel)));
const labels = (r: Opened) => maChips(r).map((n) => n.props.accessibilityLabel);
const swatch = (chip: HostNode) => {
  const v = chip.children.find((c): c is HostNode => typeof c !== "string" && c.type === "View")!;
  return Object.assign({}, ...[v.props.style].flat(Infinity).filter(Boolean)).backgroundColor as string;
};
const checked = (n: HostNode) => (n.props.accessibilityState as { checked: boolean }).checked;
const priceChart = (r: Opened) => r.all().find((n) => n.type === "PriceChart")!.props;
const press = (r: Opened, label: string) => r.act(() => (r.byLabel(label).props.onPress as () => void)());
const savedLines = () => JSON.parse(h.store.get(NEW_KEY) ?? "null") as typeof SAVED | null;

beforeEach(() => {
  h.maCustom = undefined;
  h.dark = false;
  h.store.clear();
  h.gets.length = 0;
  h.sets.length = 0;
  h.hold = false;
  h.waiting.length = 0;
});

describe("끔 — 지금 그대로", () => {
  it("플래그 못 받음·꺼짐: 칩 6개(5·10·20·60·120·200)·고정 색, onMaSettings 를 줘도 '설정' 칩 없음, PriceChart 에 maPeriods [5, 20, 60, 120] 만(maColors 속성 없음), 새 키 읽기 0번", async () => {
    for (const flag of [undefined, false]) {
      h.maCustom = flag;
      h.gets.length = 0;
      // 새 키에 저장된 선이 있어도 쓰지 않는다
      h.store.set(NEW_KEY, JSON.stringify(SAVED));
      const onMaSettings = vi.fn();
      for (const compact of [false, true]) {
        const r = await open({ onMaSettings, compact });
        await settle(r);
        expect(labels(r), `${flag} ${compact}`).toEqual(LABELS);
        expect(maChips(r).map(swatch)).toEqual([5, 10, 20, 60, 120, 200].map((p) => light.chart.ma[p]));
        expect(maChips(r).map(checked)).toEqual([true, false, true, true, true, false]);
        expect(r.has("이동평균선 기간·색 설정")).toBe(false);
        expect(r.text()).not.toContain("설정");
        const p = priceChart(r);
        expect(p.maPeriods).toEqual([5, 20, 60, 120]);
        expect("maColors" in p).toBe(false);
      }
      expect(h.gets).not.toContain(NEW_KEY);
    }
  });

  it("칩을 누르면 지금처럼 chartPrefs.v1 의 maPeriods 에 적고, 새 키에는 쓰지 않는다", async () => {
    const r = await open();
    await settle(r);
    press(r, "10 이동평균선");
    expect(checked(r.byLabel("10 이동평균선"))).toBe(true);
    expect(priceChart(r).maPeriods).toEqual([5, 10, 20, 60, 120]);
    expect(JSON.parse(h.store.get(OLD_KEY)!).maPeriods).toEqual([5, 10, 20, 60, 120]);
    expect(h.sets.map(([k]) => k)).toEqual([OLD_KEY]);
    expect(h.gets).not.toContain(NEW_KEY);
  });
});

describe("켬 — 저장한 선이 없으면 지금과 같다", () => {
  it("칩 이름표·네모 색·켜짐이 끔과 같고, PriceChart maPeriods [5, 20, 60, 120] · maColors 는 켠 선의 기간만 키로", async () => {
    h.maCustom = true;
    const r = await open();
    await settle(r);
    expect(labels(r)).toEqual(LABELS);
    expect(maChips(r).map(swatch)).toEqual([5, 10, 20, 60, 120, 200].map((p) => light.chart.ma[p]));
    expect(maChips(r).map(checked)).toEqual([true, false, true, true, true, false]);
    const p = priceChart(r);
    expect(p.maPeriods).toEqual([5, 20, 60, 120]);
    expect(p.maColors).toEqual({ 5: light.chart.ma[5], 20: light.chart.ma[20], 60: light.chart.ma[60], 120: light.chart.ma[120] });
    expect(h.gets).toContain(NEW_KEY);
    // 그리기만 해서는 아무것도 적지 않는다
    expect(h.sets).toEqual([]);
  });

  it("chartPrefs.v1 에 켠 기간이 저장돼 있으면 그 켜짐 그대로 (플래그를 켠 순간 차트가 같다)", async () => {
    h.maCustom = true;
    h.store.set(OLD_KEY, JSON.stringify({ maPeriods: [10, 200], bollinger: false, volume: true, indicator: "none" }));
    const r = await open();
    await settle(r);
    expect(maChips(r).map(checked)).toEqual([false, true, false, false, false, true]);
    expect(priceChart(r).maPeriods).toEqual([10, 200]);
    expect(priceChart(r).maColors).toEqual({ 10: light.chart.ma[10], 200: light.chart.ma[200] });
  });

  it("칩을 누르면 그 선만 켜고 끄고 새 키에 선 6개를 적는다 (chartPrefs.v1 에는 쓰지 않음)", async () => {
    h.maCustom = true;
    const r = await open();
    await settle(r);
    press(r, "10 이동평균선");
    expect(checked(r.byLabel("10 이동평균선"))).toBe(true);
    expect(priceChart(r).maPeriods).toEqual([5, 10, 20, 60, 120]);
    expect(savedLines()!.map((l) => l.on)).toEqual([true, true, true, true, true, false]);
    expect(savedLines()!.map((l) => l.period)).toEqual([5, 10, 20, 60, 120, 200]);
    expect(h.sets.map(([k]) => k)).toEqual([NEW_KEY]);
  });
});

describe("켬 — 저장된 선", () => {
  it("첫 칩 '7 이동평균선'(갈색), maPeriods 기간 작은 순, maColors[7] = maPalette[6]", async () => {
    h.maCustom = true;
    h.store.set(NEW_KEY, JSON.stringify(SAVED));
    const r = await open();
    await settle(r);
    expect(labels(r)).toEqual(["7 이동평균선", "10 이동평균선", "20 이동평균선", "60 이동평균선", "120 이동평균선", "200 이동평균선"]);
    expect(swatch(maChips(r)[0]!)).toBe(light.chart.maPalette[6]);
    expect(maChips(r).map(checked)).toEqual([true, true, true, true, false, false]);
    const p = priceChart(r);
    expect(p.maPeriods).toEqual([7, 10, 20, 60]);
    expect(p.maColors).toEqual({ 7: light.chart.maPalette[6], 10: light.chart.maPalette[1], 20: light.chart.maPalette[2], 60: light.chart.maPalette[3] });
    // 끈 선의 칩은 흐리고 테두리는 선 색이 아님 (지금 칩과 같은 모양)
    const off = Object.assign({}, ...[maChips(r)[4]!.props.style].flat(Infinity).filter(Boolean));
    expect(off).toMatchObject({ borderColor: light.line, opacity: 0.6 });
  });

  it("'10 이동평균선' 칩을 누르면 새 키의 선 2 on 이 거짓, chartPrefs.v1 에는 아무것도 적지 않음", async () => {
    h.maCustom = true;
    h.store.set(NEW_KEY, JSON.stringify(SAVED));
    const r = await open();
    await settle(r);
    press(r, "10 이동평균선");
    expect(checked(r.byLabel("10 이동평균선"))).toBe(false);
    expect(savedLines()![1]).toEqual({ period: 10, color: 1, on: false });
    expect(savedLines()!.filter((_, i) => i !== 1)).toEqual(SAVED.filter((_, i) => i !== 1));
    expect(h.store.has(OLD_KEY)).toBe(false);
    expect(h.sets.every(([k]) => k === NEW_KEY)).toBe(true);
    expect(priceChart(r).maPeriods).toEqual([7, 20, 60]);
  });

  it("저장값이 틀리면(같은 기간 두 칸) 통째로 처음 선", async () => {
    h.maCustom = true;
    h.store.set(NEW_KEY, JSON.stringify(SAVED.map((l, i) => (i === 1 ? { ...l, period: 7 } : l))));
    const r = await open();
    await settle(r);
    expect(labels(r)).toEqual(LABELS);
    expect(priceChart(r).maPeriods).toEqual([5, 20, 60, 120]);
  });

  it("다크 테마는 같은 색 번호의 다크 색", async () => {
    h.maCustom = true;
    h.dark = true;
    h.store.set(NEW_KEY, JSON.stringify(SAVED));
    const { dark } = await import("@/tokens");
    const r = await open();
    await settle(r);
    expect(swatch(maChips(r)[0]!)).toBe(dark.chart.maPalette[6]);
    expect((priceChart(r).maColors as Record<number, string>)[7]).toBe(dark.chart.maPalette[6]);
  });
});

describe("늦은 읽기 경주 — 누른 값이 옛 저장값에 덮이지 않는다", () => {
  it("읽기가 늦을 때 칩을 먼저 누르면, 늦게 온 옛 값(선 1 = 7)은 버린다", async () => {
    h.maCustom = true;
    h.store.set(NEW_KEY, JSON.stringify(SAVED));
    h.hold = true;
    const r = await open();
    await settle(r);
    // 아직 읽는 중: 처음 선이 보인다
    expect(labels(r)[0]).toBe("5 이동평균선");
    press(r, "20 이동평균선");
    expect(checked(r.byLabel("20 이동평균선"))).toBe(false);
    // 옛 값이 늦게 도착
    h.release();
    await settle(r);
    expect(labels(r)[0]).toBe("5 이동평균선");
    expect(checked(r.byLabel("20 이동평균선"))).toBe(false);
    expect(savedLines()![2]).toEqual({ period: 20, color: 2, on: false });
    expect(savedLines()![0]!.period).toBe(5);
  });
});

describe("'설정' 칩 (켬 + 화면이 onMaSettings 를 줄 때만)", () => {
  it("켬 + onMaSettings: 선 6(200) 칩 바로 뒤·볼린저 앞에 '설정' 칩(options-outline), 누르면 불림", async () => {
    h.maCustom = true;
    const onMaSettings = vi.fn();
    const r = await open({ onMaSettings });
    await settle(r);
    const chip = r.byLabel("이동평균선 기간·색 설정");
    expect(chip.type).toBe("Pressable");
    expect(chip.props.accessibilityRole).toBe("button");
    expect(chip.props.hitSlop).toBeDefined();
    const icon = chip.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Ionicons")!;
    expect(icon.props.name).toBe("options-outline");
    const text = chip.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Text")!;
    expect(text.children).toEqual(["설정"]);
    const order = r.all().filter((n) => n.type === "Pressable").map((n) => n.props.accessibilityLabel);
    expect(order.indexOf("이동평균선 기간·색 설정")).toBe(order.indexOf("200 이동평균선") + 1);
    expect(order.indexOf("볼린저 밴드")).toBe(order.indexOf("이동평균선 기간·색 설정") + 1);
    press(r, "이동평균선 기간·색 설정");
    expect(onMaSettings).toHaveBeenCalledTimes(1);
  });

  it("켬 + onMaSettings 없음 → '설정' 칩 없음", async () => {
    h.maCustom = true;
    const r = await open();
    await settle(r);
    expect(r.has("이동평균선 기간·색 설정")).toBe(false);
  });

  it("전체 화면(compact): 위 조작 줄 칩 띠 안(기간 칩과 같은 띠)에 이동평균 칩과 '설정' 칩", async () => {
    h.maCustom = true;
    const r = await open({ onMaSettings: vi.fn(), compact: true, width: 700, height: 300 });
    await settle(r);
    const strips = r.all().filter((n) => n.type === "ScrollView");
    expect(strips).toHaveLength(1);
    const inStrip = (label: string) => r.all(strips[0]!.children).some((n) => n.props.accessibilityLabel === label);
    expect(inStrip("일봉")).toBe(true);
    expect(inStrip("5 이동평균선")).toBe(true);
    expect(inStrip("이동평균선 기간·색 설정")).toBe(true);
  });
});

describe("다시 켜기 — 저장한 선이 남는다", () => {
  it("저장된 선에서 칩을 눌러 적은 뒤, 모듈을 새로 불러 다시 그리면(캐시 비움 → 저장소 다시 읽기) 그대로", async () => {
    h.maCustom = true;
    h.store.set(NEW_KEY, JSON.stringify(SAVED));
    const r = await open();
    await settle(r);
    press(r, "10 이동평균선");
    r.unmount();
    const again = await open();
    // 새 모듈은 캐시가 비어 처음 선부터 — 저장소를 읽으면 저장한 선
    await settle(again);
    expect(labels(again)[0]).toBe("7 이동평균선");
    expect(checked(again.byLabel("10 이동평균선"))).toBe(false);
    expect(priceChart(again).maPeriods).toEqual([7, 20, 60]);
  });
});
