import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 차트 최고·최저가 표시 연결 (3-46, 기능 플래그 chartHighLow + 설정 '차트 최고·최저가 표시'). CandleChart 가 부품 안에서 읽어
 * 둘 다 켜졌을 때만 PriceChart 에 highLow 를 넘긴다 — 끄면 속성 자체가 없어 그림이 지금 그대로.
 * 종목 상세(휴대폰·넓은 창)·지수 상세(휴대폰·넓은 창)·전체 화면 차트는 모두 CandleChart → PriceChart 하나를 거친다 (화면 파일은 고치지 않음)
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean | undefined>,
  /** useSettings 가 주는 값 (undefined = 옛 가짜처럼 키가 없음) */
  settings: { showKrw: false } as { showKrw: boolean; chartHighLow?: boolean },
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 419, height: 860, fontScale: 1 }),
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));
vi.mock("@/api/hooks", () => ({ useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});
// 그림은 test/chartHighLowChart 에서 — 여기서는 받은 속성만 본다
vi.mock("@/components/chart/PriceChart", () => ({
  PriceChart: "PriceChart",
  maColor: (t: { chart: { ma: Record<number, string> }; muted: string }, p: number) => t.chart.ma[p] ?? t.muted,
  clampView: (v: { count: number; offset: number }, total: number, minCount = 15, maxCount = 500) => {
    const count = Math.max(minCount, Math.min(maxCount, Math.min(v.count, Math.max(total, minCount))));
    return { count, offset: Math.max(0, Math.min(v.offset, Math.max(total - count, 0))) };
  },
}));

const { CandleChart } = await import("@/components/CandleChart");

const CANDLES = [
  { date: "2026-09-22", open: 100, high: 110, low: 95, close: 105, volume: 10 },
  { date: "2026-09-23", open: 105, high: 112, low: 101, close: 108, volume: 12 },
  { date: "2026-09-24", open: 108, high: 115, low: 104, close: 110, volume: 9 },
];
const QUOTE = { price: 110, prevClose: 108, high52w: 130, low52w: 90, live: false, fxRate: 1_400, priceKrw: 154_000 };

beforeEach(() => {
  h.flags = {};
  h.settings = { showKrw: false };
});

const chart = (props: Record<string, unknown> = {}) =>
  render(<CandleChart candles={CANDLES} period="D" onPeriodChange={() => undefined} quote={QUOTE} {...(props as object)} />)
    .all()
    .find((n) => n.type === "PriceChart") as HostNode;

describe("CandleChart → PriceChart highLow", () => {
  it("플래그 없음(앱 fallback 꺼짐)·꺼짐: highLow 키 자체가 없다 (설정이 켬이어도)", () => {
    for (const flags of [{}, { chartHighLow: false }]) {
      h.flags = flags;
      h.settings = { showKrw: false, chartHighLow: true };
      expect("highLow" in chart().props).toBe(false);
    }
  });

  it("플래그 켬 + 설정 켬 → highLow: true, 설정 끔 → 키 없음", () => {
    h.flags = { chartHighLow: true };
    h.settings = { showKrw: false, chartHighLow: true };
    expect(chart().props.highLow).toBe(true);
    h.settings = { showKrw: false, chartHighLow: false };
    expect("highLow" in chart().props).toBe(false);
  });

  it("설정 값을 모르면(저장한 적 없음·옛 설정 모양) 켬으로 본다 — 기본 켬", () => {
    h.flags = { chartHighLow: true };
    h.settings = { showKrw: false };
    expect(chart().props.highLow).toBe(true);
  });

  it("전체 화면(compact)·지수(PT)·미국 주식 원화 보기에서도 같은 값", () => {
    h.flags = { chartHighLow: true };
    h.settings = { showKrw: true, chartHighLow: true };
    expect(chart({ compact: true, width: 800, height: 300 }).props.highLow).toBe(true);
    expect(chart({ currency: "PT", hasVolume: false }).props.highLow).toBe(true);
    const usd = chart({ currency: "USD" });
    expect(usd.props.highLow).toBe(true);
    // 원화 보기: 봉·현재가가 같은 환율로 원화 (최고·최저 글자도 원)
    expect(usd.props.currency).toBe("KRW");
    expect(usd.props.currentPrice).toBe(110 * 1_400);
    h.settings = { showKrw: true, chartHighLow: false };
    expect("highLow" in chart({ compact: true, width: 800, height: 300 }).props).toBe(false);
  });

  it("끄면 PriceChart 속성이 지금과 같다 (키 목록)", () => {
    const keys = Object.keys(chart().props).sort();
    h.flags = { chartHighLow: true };
    h.settings = { showKrw: false, chartHighLow: false };
    expect(Object.keys(chart().props).sort()).toEqual(keys);
    h.settings = { showKrw: false, chartHighLow: true };
    expect(Object.keys(chart().props).sort()).toEqual([...keys, "highLow"].sort());
  });
});

describe("모든 큰 가격 차트가 CandleChart → PriceChart 를 거친다 (화면 파일 수정 없이 적용)", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf8");
  const files = (dir: string): string[] =>
    readdirSync(`${SRC}/${dir}`, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`.replace(/^\//, "")] : []));
  it("종목 상세(휴대폰·넓은 창)·지수 상세(휴대폰·넓은 창)·전체 화면은 CandleChart, PriceChart 를 그리는 곳은 CandleChart 하나", () => {
    expect(read("app/stocks/[code]/index.tsx").match(/<CandleChart\b/g)).toHaveLength(2);
    expect(read("app/market/[code].tsx").match(/<CandleChart\b/g)).toHaveLength(2);
    expect(read("app/stocks/[code]/chart.tsx").match(/<CandleChart\b/g)).toHaveLength(1);
    expect(files("").filter((f) => /<PriceChart\b/.test(read(f)))).toEqual(["components/CandleChart.tsx"]);
  });
  it("작은 차트(스파크라인·지수 띠·위젯)는 최고·최저 표시를 쓰지 않는다 (lib/chartHighLow 를 부르는 곳은 PriceChart 하나)", () => {
    expect(files("").filter((f) => /from "@\/lib\/chartHighLow"|from "\.\/chartHighLow"/.test(read(f)))).toEqual(["components/chart/PriceChart.tsx"]);
  });
});
