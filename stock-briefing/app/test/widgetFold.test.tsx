import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 위젯 2차 (B): 폴드8 바깥 화면(접힘)에 펼친 화면 모양(잔고 '평가금액' 칸)이 보이던 것 (플래그 widgetFoldFit).
 * 2026-09-26 토 10:32 캡처: 바깥 4x2 카드 1065px 에 평가금액 칸 → 홈 화면이 알려 준 폭이 칸 기준(504dp) 이상, 약 507~516dp.
 * 고친 뒤: 넓은 모습(잔고 평가금액 칸·두 열, 지수·환율 옆 칸)은 위젯 폭이 WIDE_EXTRAS_MIN_DP(560dp) 이상일 때만 — 폭 하나로만 정한다.
 * 화면 크기·방향·접힘·위젯마다의 기억은 그림에 영향이 없다 (같은 폭이면 같은 그림). 플래그 꺼짐은 예전 그림과 한 글자도 같다.
 * 크기 기록(sizeLog.ts)은 설정 '화면 정보' 공유 글의 진단 줄에만 쓴다. 시각은 모두 고정 시계 (vi.useFakeTimers)
 */

const lib = (p: string) => import(/* @vite-ignore */ p);
const shared = vi.hoisted(() => ({
  widgets: {} as Record<string, { widgetId: number; width: number; height: number; screenInfo: Record<string, number> }[]>,
  updates: [] as { widgetName: string; rendered: unknown }[],
}));
vi.mock("react-native-android-widget", async () => {
  const load = (p: string) => import(/* @vite-ignore */ p);
  const base = "react-native-android-widget/lib/commonjs/widgets/";
  const [flex, text, list] = await Promise.all([load(`${base}FlexWidget.js`), load(`${base}TextWidget.js`), load(`${base}ListWidget.js`)]);
  return {
    FlexWidget: flex.FlexWidget,
    TextWidget: text.TextWidget,
    ListWidget: list.ListWidget,
    getWidgetInfo: async (name: string) => (shared.widgets[name] ?? []).map((b) => ({ widgetName: name, ...b })),
    requestWidgetUpdate: async ({ widgetName, renderWidget }: { widgetName: string; renderWidget: (i: unknown) => unknown }) => {
      for (const box of shared.widgets[widgetName] ?? []) shared.updates.push({ widgetName, rendered: await renderWidget({ widgetName, ...box }) });
    },
  };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" }, PixelRatio: { getFontScale: () => 1 } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
const store = new Map<string, string>();
const io = vi.hoisted(() => ({ reads: 0, writes: 0, fail: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      io.reads++;
      if (io.fail && k === "widget.sizeLog") throw new Error("저장소 오류");
      return store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      io.writes++;
      if (io.fail && k === "widget.sizeLog") throw new Error("저장소 오류");
      store.set(k, v);
    },
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { buildWidgetTree } = await lib("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { renderBoth, renderFor } = await import("@/widgets/render");
const { WIDGET_NAMES } = await import("@/widgets/widgets");
const { WIDE, PAD, WIDE_EXTRAS_MIN_DP, wideExtrasOk } = await import("@/widgets/layout");
const { WIDGET_FONT } = await import("@/widgets/palette");
const { widgetFeatures } = await import("@/widgets/payload");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { saveWidgetView } = await import("@/widgets/data");
const { addSize, forgetWidgetSize, noteWidgetSize, parseSizeLog, readSizeLog, SIZE_LOG_KEY, SIZE_ROWS, SIZE_WIDGETS } = await import("@/widgets/sizeLog");
const { widgetReport, widgetReportLines } = await import("@/widgets/diagnose");
type WidgetData = import("@/widgets/data").WidgetData;
type SizeBox = import("@/widgets/sizeLog").SizeBox;
type SizeLog = import("@/widgets/sizeLog").SizeLog;

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string };
  children?: Tree[];
}
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const tree = (r: { dark: React.JSX.Element }): Tree => buildWidgetTree(r.dark) as Tree;
const lightTree = (r: { light: React.JSX.Element }): Tree => buildWidgetTree(r.light) as Tree;
const texts = (t: Tree) => nodes(t).filter((n) => n.type === "TextWidget").map((n) => String(n.props.text));
const uri = (n: Tree) => String((n.props.clickActionData as { uri?: string } | undefined)?.uri ?? "");

/** 넓은 모습이 들어 있는지: 잔고 평가금액 칸 · 잔고 두 열 · 지수·환율 구역 안 옆 칸(또는 넓은 값 글자) */
function extras(t: Tree): { value: boolean; twoColumns: boolean; boardWide: boolean } {
  const all = nodes(t);
  const list = all.find((n) => n.type === "ListWidget");
  const tiles = (n: Tree) => (n.children ?? []).filter((c) => uri(c).includes("/market/")).length;
  return {
    value: texts(t).includes("평가금액"),
    // 한 열이면 목록 줄마다 누르는 칸, 두 열이면 줄(누르는 칸 아님) 안에 칸 둘
    twoColumns: !!list?.children?.some((c) => !c.props.clickAction),
    // 구역 안 가로 줄(칸 둘 이상) 또는 넓은 위젯만 쓰는 큰 값 글자
    boardWide: all.some((n) => n.type === "FlexWidget" && n.props.orientation === "HORIZONTAL" && tiles(n) >= 2) || all.some((n) => n.type === "TextWidget" && Number(n.props.fontSize) > WIDGET_FONT.bigger),
  };
}
const NONE = { value: false, twoColumns: false, boardWide: false };

// ── 사용자 계좌와 비슷한 잔고 (보유 16 · 관심 1) ──
const US_AT = "2026-09-26T08:59:00+09:00";
const KR_AT = "2026-09-25T15:30:00+09:00";
const us = (code: string, name: string, qty: number, avg: number, price: number, rate: number) =>
  holding(code, quote(code, price, { currency: "USD", change: (price * rate) / 100, changeRate: rate, fxRate: 1359, asOf: US_AT }), qty, avg, undefined, name);
const kr = (code: string, name: string, qty: number, avg: number, price: number, rate: number) => holding(code, quote(code, price, { change: (price * rate) / 100, changeRate: rate, asOf: KR_AT }), qty, avg, undefined, name);
const STOCKS: RegisteredWithQuote[] = [
  us("SOXL", "SOXL", 135, 133, 151.86, 3.7),
  us("AVGO", "브로드컴", 18, 375, 353.95, 0.95),
  us("RGTX", "RGTX", 457, 14.4, 10.64, 2.31),
  us("VRT", "버티브 홀딩스", 28, 287, 253.5, 3.26),
  us("IONQ", "아이온큐", 70, 44, 45.31, 0.67),
  us("QUBT", "퀀티넘", 60, 60, 49.69, 0.53),
  us("ETN", "이튼", 5, 331, 442.4, 0.5),
  kr("035420", "NAVER", 10, 233_000, 196_000, -2.49),
  us("QQQI", "QQQI", 30, 58.5, 55.87, 0.49),
  us("RGTI", "리게티 컴퓨팅", 70, 15.2, 16.7, 1.15),
  us("RTX", "RTX", 7, 196, 189.65, 0.48),
  us("ANET", "아리스타 네트웍스", 5, 152, 206.87, 0.49),
  us("GD", "제너럴 다이내믹스", 3, 330, 345.1, 0.3),
  kr("005930", "삼성전자", 10, 71_000, 84_300, 1.44),
  kr("000660", "SK하이닉스", 2, 262_000, 318_500, -1.39),
  kr("005380", "현대차", 3, 230_000, 251_000, 0.6),
  holding("042700", quote("042700", 98_400, { change: -1600, changeRate: -1.6, asOf: KR_AT }), null, null, undefined, "한미반도체"),
];
const idx = (code: string, name: string, value: number, change: number, changeRate: number) => ({ code, name, value, change, changeRate, open: false, asOf: KR_AT });
const INDICES = [idx("NASDAQ", "나스닥", 27068.72, 129.34, 0.48), idx("SPX", "S&P500", 7743.41, 39.28, 0.51), idx("KOSPI", "코스피", 7080.92, 63.01, 0.9), idx("KOSDAQ", "코스닥", 844.48, 10.1, 1.21), idx("USDKRW", "원/달러", 1359, 3.5, 0.26)];
const BOARD = [
  ...INDICES.filter((i) => i.code !== "USDKRW"),
  idx("DJI", "다우", 51828.62, 478.64, 0.93),
  idx("SOX", "필라반도체", 12668.93, 176.39, 1.41),
  idx("USDKRW", "원/달러", 1359, 3.5, 0.26),
  idx("JPYKRW", "원/100엔", 864.09, 3.18, 0.37),
  idx("CNYKRW", "원/위안", 202.13, -0.24, -0.12),
];
const NOW = Date.parse("2026-09-26T10:32:00+09:00");
const WEEKEND = { label: "미국 장 마감 · 한국 휴장", open: false, kr: false, us: false, nextChangeAt: "2026-09-27T23:00:00.000Z" };
/** foldFit: 서버 플래그 widgetFoldFit (꺼짐이면 키도 없다 — 예전 서버와 같은 features) */
const data = (foldFit: boolean): WidgetData => ({
  stocks: STOCKS,
  briefings: [],
  showKrw: true,
  afterCost: true,
  rowKrw: true,
  brief: null,
  fetchedAt: NOW - 60_000,
  error: null,
  filled: [],
  market: WEEKEND,
  indices: INDICES,
  indicesAt: NOW - 60_000,
  board: BOARD,
  boardAt: NOW - 60_000,
  features: widgetFeatures({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: true, ...(foldFit ? { widgetFoldFit: true } : {}) }),
});
const OPTS = { fontScale: 1, now: NOW, pnlMode: "cumulative" as const };
const draw = (name: string, d: WidgetData, b: { width: number; height: number }) => tree(renderBoth(name, d, { ...OPTS, width: b.width, height: b.height }));

// ── 화면 (dp) — 그림에는 영향이 없어야 한다 ──
/** 바깥 화면 세로 (420dpi 추정 · 캡처로 잰 밀도 약 2.1) · 안쪽 화면 가로 · 모름 */
const COVER_SCREEN = { screenWidthDp: 475, screenHeightDp: 751, density: 2.625 };
const COVER_SCREEN_2X = { screenWidthDp: 594, screenHeightDp: 939, density: 2.1 };
const INNER_SCREEN = { screenWidthDp: 933, screenHeightDp: 704, density: 2.625 };
const INNER_SCREEN_2X = { screenWidthDp: 1166, screenHeightDp: 880, density: 2.1 };
const SCREENS = [COVER_SCREEN, COVER_SCREEN_2X, INNER_SCREEN, INNER_SCREEN_2X, {}];
/** 캡처로 잰 크기 (docs/폴드-위젯.md 10절) */
const COVER_4X2 = { width: 507, height: 222 };
const INNER_HOLDINGS = { width: 476, height: 611 };
const INNER_MARKET = { width: 476, height: 351 };
/** 안쪽 화면에 넓게 늘린 위젯 (3-42) */
const INNER_WIDE = { width: 780, height: 350 };

beforeEach(() => {
  store.clear();
  io.reads = 0;
  io.writes = 0;
  io.fail = false;
  shared.widgets = {};
  shared.updates = [];
  vi.unstubAllGlobals();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("폭 규칙 (layout.ts wideExtrasOk — 폭 하나로만)", () => {
  it("꺼져 있으면 늘 허락(예전 기준만), 켜져 있으면 폭 560dp 이상만", () => {
    expect(WIDE_EXTRAS_MIN_DP).toBe(560);
    for (const w of [1, 300, 507, 559, 560, 780, 5000]) expect(wideExtrasOk(w, false), `꺼짐 ${w}`).toBe(true);
    expect(wideExtrasOk(507, true)).toBe(false);
    expect(wideExtrasOk(559, true)).toBe(false);
    expect(wideExtrasOk(559.9, true)).toBe(false);
    expect(wideExtrasOk(560, true)).toBe(true);
    expect(wideExtrasOk(780, true)).toBe(true);
  });

  it("560 의 근거: 폴드8 바깥 4x2(캡처 1065px, 밀도 1.99~2.11 → 504~536dp)보다 넓고, 두 열 기준(644dp)·안쪽 넓은 위젯(777~780dp)보다 좁다", () => {
    // 캡처에 평가금액 칸이 있었으니 알려 준 폭은 칸 기준 이상, 두 열은 없었으니 두 열 기준 미만
    const valueFrom = WIDE.valueMin + PAD * 2;
    const twoFrom = WIDE.columnMin * 2 + WIDE.columnGap + PAD * 2;
    expect([valueFrom, twoFrom]).toEqual([504, 644]);
    const coverDp = [1065 / 2.113, 1065 / 2.1, 1065 / 2.0625, 1065 / 1.986].map(Math.round);
    expect(coverDp).toEqual([504, 507, 516, 536]);
    for (const w of coverDp) expect(w).toBeLessThan(WIDE_EXTRAS_MIN_DP - 20);
    expect(WIDE_EXTRAS_MIN_DP).toBeLessThan(twoFrom);
    expect(WIDE_EXTRAS_MIN_DP).toBeLessThan(777);
  });
});

describe("폴드8 캡처 크기: 바깥 4x2 에 평가금액 칸이 없고, 안쪽은 그대로", () => {
  it("재현 (고치기 전 = 플래그 꺼짐): 바깥 507×222 잔고에 평가금액 칸이 있다 → 켜면 없다 (칸 크기·줄 수·제목은 그대로)", () => {
    const before = draw(WIDGET_NAMES.holdings, data(false), COVER_4X2);
    const after = draw(WIDGET_NAMES.holdings, data(true), COVER_4X2);
    expect(extras(before)).toEqual({ value: true, twoColumns: false, boardWide: false });
    expect(extras(after)).toEqual(NONE);
    const rowsOf = (t: Tree) => nodes(t).find((n) => n.type === "ListWidget")?.children?.length;
    expect(rowsOf(after)).toBe(rowsOf(before));
    expect(texts(after)[0]).toBe(texts(before)[0]);
    expect(after.props.width).toBe(before.props.width);
    expect(after.props.height).toBe(before.props.height);
    // 라이트도 같다
    expect(texts(lightTree(renderBoth(WIDGET_NAMES.holdings, data(true), { ...OPTS, ...COVER_4X2 })))).not.toContain("평가금액");
  });

  it("바깥 507×222 지수·환율은 원래도 옆 칸 기준(540) 아래라 켜도 꺼도 같다", () => {
    const off = draw(WIDGET_NAMES.market, data(false), COVER_4X2);
    expect(extras(off).boardWide).toBe(false);
    expect(draw(WIDGET_NAMES.market, data(true), COVER_4X2)).toEqual(off);
  });

  it("안쪽 캡처 크기(잔고 476×611 · 지수 476×351)는 켜도 꺼도 한 글자도 같다", () => {
    expect(draw(WIDGET_NAMES.holdings, data(true), INNER_HOLDINGS)).toEqual(draw(WIDGET_NAMES.holdings, data(false), INNER_HOLDINGS));
    expect(draw(WIDGET_NAMES.market, data(true), INNER_MARKET)).toEqual(draw(WIDGET_NAMES.market, data(false), INNER_MARKET));
  });

  it("안쪽에 넓게 늘린 위젯(780×350 · 780×230 · 900×470)은 접힌 채 그려도 넓은 모습 그대로 (두 열 · 지수 옆 칸)", async () => {
    for (const box of [INNER_WIDE, { width: 780, height: 230 }, { width: 900, height: 470 }]) {
      for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.market]) {
        const off = draw(name, data(false), box);
        for (const screenInfo of SCREENS) {
          // 바깥 화면이 켜져 있을 때(접힘) 그려도 · 안쪽에서 그려도 같은 그림
          const t = tree(await renderFor(name, data(true), { widgetId: 40, ...box, screenInfo }, OPTS));
          expect(t, `${name} ${box.width}×${box.height} ${JSON.stringify(screenInfo)}`).toEqual(off);
        }
      }
      expect(extras(draw(WIDGET_NAMES.holdings, data(true), box)).twoColumns).toBe(true);
      expect(extras(draw(WIDGET_NAMES.market, data(true), box)).boardWide).toBe(true);
    }
  });

  it("화면 크기·방향·그린 순서와 상관없다: 같은 폭이면 같은 그림 (위젯마다 기억하지 않는다)", async () => {
    const boxes = [COVER_4X2, INNER_HOLDINGS, INNER_WIDE, { width: 540, height: 222 }];
    for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.market]) {
      const want = new Map(boxes.map((b) => [b, draw(name, data(true), b)]));
      // 한 위젯(번호 9)이 두 화면을 오가며 여러 크기로 그려져도 (① 한 그림 · ② 화면마다 · ③ 따로 — 어느 경우든)
      for (let k = 0; k < 2; k++) {
        for (const b of boxes) {
          for (const screenInfo of SCREENS) {
            for (const by of ["resize", "update", "app"] as const) {
              expect(tree(await renderFor(name, data(true), { widgetId: 9, ...b, screenInfo }, { ...OPTS, by })), `${name} ${b.width}`).toEqual(want.get(b));
            }
          }
        }
      }
    }
  });
});

describe("달라지는 것은 폭 504~559dp 뿐 (위젯 4종 × 폭 × 높이, 플래그 켬·끔)", () => {
  const WIDTHS = [250, 330, 380, 420, 476, 503, 504, 507, 516, 536, 539, 540, 559, 560, 587, 600, 643, 644, 700, 777, 780, 900];
  const HEIGHTS = [110, 222, 611];

  it("밖: 켬 = 끔 (한 글자도 같음). 안: 잔고는 평가금액 칸만, 지수·환율(540~559)은 옆 칸만 빠진다", () => {
    let inBand = 0;
    let differs = 0;
    for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.market, WIDGET_NAMES.asset, WIDGET_NAMES.briefing]) {
      for (const width of WIDTHS) {
        for (const height of HEIGHTS) {
          const on = draw(name, data(true), { width, height });
          const off = draw(name, data(false), { width, height });
          const band = width >= 504 && width < WIDE_EXTRAS_MIN_DP;
          if (!band || name === WIDGET_NAMES.asset || name === WIDGET_NAMES.briefing) {
            expect(on, `${name} ${width}×${height}`).toEqual(off);
            continue;
          }
          inBand++;
          expect(extras(on), `${name} ${width}×${height}`).toEqual(NONE);
          // 끔은 예전 기준 그대로: 잔고는 목록이 보이는 높이면 평가금액 칸이 있다 (두 열은 644dp 부터라 없음)
          const was = extras(off);
          expect(was.twoColumns).toBe(false);
          if (name === WIDGET_NAMES.holdings && height >= 222) expect(was.value, `${width}×${height}`).toBe(true);
          if (name === WIDGET_NAMES.market && width < WIDE.boardMin) expect(on, `${name} ${width}×${height}`).toEqual(off);
          if (JSON.stringify(on) !== JSON.stringify(off)) differs++;
        }
      }
    }
    expect(inBand).toBe(2 * 7 * 3);
    expect(differs).toBeGreaterThanOrEqual(2 * 7);
  });

  it("예전 기준 확인 (플래그 꺼짐): 504dp 부터 평가금액 칸, 644dp 부터 두 열, 540dp 부터 지수 옆 칸 — 켜면 560dp 부터", () => {
    const at = (name: string, d: WidgetData, width: number) => extras(draw(name, d, { width, height: 350 }));
    expect(at(WIDGET_NAMES.holdings, data(false), 503).value).toBe(false);
    expect(at(WIDGET_NAMES.holdings, data(false), 504).value).toBe(true);
    expect(at(WIDGET_NAMES.holdings, data(true), 559).value).toBe(false);
    expect(at(WIDGET_NAMES.holdings, data(true), 560).value).toBe(true);
    expect(at(WIDGET_NAMES.holdings, data(true), 644).twoColumns).toBe(true);
    expect(at(WIDGET_NAMES.market, data(false), 540).boardWide).toBe(true);
    expect(at(WIDGET_NAMES.market, data(true), 559).boardWide).toBe(false);
    expect(at(WIDGET_NAMES.market, data(true), 560).boardWide).toBe(true);
  });

  it("화면 읽기: 넓은 모습을 뺀 그림도 누르는 칸마다 이름표가 있다", () => {
    const t = draw(WIDGET_NAMES.holdings, data(true), COVER_4X2);
    const labels = nodes(t)
      .filter((n) => n.props.clickAction)
      .map((n) => n.props.accessibilityLabel);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.every((v) => typeof v === "string" && v.length > 0)).toBe(true);
  });
});

describe("크기 진단 기록 (sizeLog.ts — 그림에 쓰지 않는다)", () => {
  const log = () => parseSizeLog(store.get(SIZE_LOG_KEY));
  const BOX: SizeBox = { widgetId: 5, width: 507, height: 222, screenInfo: COVER_SCREEN_2X };

  it("플래그가 꺼져 있으면 읽지도 적지도 않는다", async () => {
    await renderFor(WIDGET_NAMES.holdings, data(false), BOX, OPTS);
    expect(io.reads + io.writes).toBe(0);
    expect(store.size).toBe(0);
  });

  it("켜져 있으면 그리는 시각(고정 시계 now)으로 한 줄. 같은 줄은 한 시간에 한 번만 다시 적고, 다르면 더한다", async () => {
    vi.setSystemTime(NOW + 5 * 86_400_000);
    await renderFor(WIDGET_NAMES.holdings, data(true), BOX, { ...OPTS, by: "resize" });
    expect(log()).toEqual({ "5": [{ w: 507, h: 222, sw: 594, sh: 939, by: "resize", at: NOW }] });
    const writes = io.writes;
    await renderFor(WIDGET_NAMES.holdings, data(true), BOX, { ...OPTS, now: NOW + 60_000, by: "resize" });
    expect(io.writes).toBe(writes);
    await renderFor(WIDGET_NAMES.holdings, data(true), BOX, { ...OPTS, now: NOW + 3_600_000, by: "resize" });
    expect(log()["5"]).toEqual([{ w: 507, h: 222, sw: 594, sh: 939, by: "resize", at: NOW + 3_600_000 }]);
    await renderFor(WIDGET_NAMES.holdings, data(true), { ...BOX, width: 476, height: 611, screenInfo: INNER_SCREEN_2X }, { ...OPTS, now: NOW + 3_700_000 });
    expect(log()["5"]!.map((r) => `${r.by}:${r.w}x${r.h}@${r.sw}`)).toEqual(["resize:507x222@594", "app:476x611@1166"]);
  });

  it("위젯마다 최근 6줄, 위젯은 8개까지 (가장 오래 못 본 위젯부터 버림) · 번호·크기를 모르면 적지 않음", () => {
    let l: SizeLog = {};
    for (let k = 0; k < 10; k++) l = addSize(l, { widgetId: 1, width: 400 + k, height: 200 }, "update", k) ?? l;
    expect(l["1"]!.map((r) => r.w)).toEqual([404, 405, 406, 407, 408, 409]);
    expect(SIZE_ROWS).toBe(6);
    for (let id = 2; id <= 9; id++) l = addSize(l, { widgetId: id, width: 300, height: 200 }, "app", 100 + id) ?? l;
    expect(SIZE_WIDGETS).toBe(8);
    expect(Object.keys(l).sort()).toEqual(["2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(addSize(l, { width: 300, height: 200 }, "app", 1)).toBeNull();
    expect(addSize(l, { widgetId: 3, width: 0, height: 200 }, "app", 1)).toBeNull();
  });

  it("깨진 기록은 버리고, 저장소가 고장 나도 그림은 그대로 그린다", async () => {
    store.set(SIZE_LOG_KEY, "{");
    expect(await readSizeLog()).toEqual({});
    store.set(SIZE_LOG_KEY, JSON.stringify({ "3": [{ w: 1, h: 1, by: "x", at: 0 }, { w: 400, h: 200, by: "app", at: 5, sw: "a" }], x: [], "4": "no" }));
    expect(await readSizeLog()).toEqual({ "3": [{ w: 400, h: 200, by: "app", at: 5 }] });
    io.fail = true;
    const t = tree(await renderFor(WIDGET_NAMES.holdings, data(true), BOX, OPTS));
    expect(t).toEqual(draw(WIDGET_NAMES.holdings, data(true), BOX));
    expect(await readSizeLog()).toEqual({});
  });

  it("앱과 위젯 태스크가 한꺼번에 적어도 서로 덮지 않는다", async () => {
    await Promise.all([1, 2, 3].map((id) => noteWidgetSize({ ...BOX, widgetId: id }, "app", NOW)));
    expect(Object.keys(log()).sort()).toEqual(["1", "2", "3"]);
  });

  it("태스크 핸들러: 추가·크기 변경·주기·누름을 그대로 적고, 위젯을 지우면 그 위젯 줄만 지운다", async () => {
    await saveWidgetView(data(true), "https://server.test");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    const info = (b: SizeBox) => ({ widgetName: WIDGET_NAMES.holdings, ...b });
    const run = async (b: SizeBox, widgetAction: string, extra: Record<string, unknown> = {}) => {
      const out: unknown[] = [];
      await widgetTaskHandler({ widgetInfo: info(b), widgetAction, renderWidget: (r: unknown) => void out.push(r), ...extra } as never);
      return out as { dark: React.JSX.Element }[];
    };
    const inner: SizeBox = { widgetId: 8, width: 476, height: 611, screenInfo: INNER_SCREEN_2X };
    await run(inner, "WIDGET_ADDED");
    const cover = await run(BOX, "WIDGET_RESIZED");
    // 바깥 칸 크기로 그린 그림(실패 표시와 함께)에도 평가금액 칸이 없다
    expect(extras(tree(cover.at(-1)!))).toEqual(NONE);
    vi.setSystemTime(NOW + 60_000);
    await run(inner, "WIDGET_UPDATE");
    await run({ ...inner, widgetId: 9 }, "WIDGET_CLICK", { clickAction: "REFRESH" });
    expect(log()["8"]!.map((r) => `${r.by}:${r.w}x${r.h}`)).toEqual(["add:476x611", "update:476x611"]);
    expect(log()["9"]!.map((r) => r.by)).toEqual(["click"]);
    expect(log()["5"]!.map((r) => `${r.by}:${r.w}x${r.h}`)).toEqual(["resize:507x222"]);
    await run({ widgetId: 8, width: 0, height: 0 }, "WIDGET_DELETED");
    expect(Object.keys(log()).sort()).toEqual(["5", "9"]);
    await forgetWidgetSize(9);
    expect(Object.keys(log())).toEqual(["5"]);
  });
});

describe("설정 '화면 정보' 공유 글의 위젯 진단 (widgets/diagnose.ts)", () => {
  it("위젯 수·기준 폭, 위젯마다 지금 크기·화면·밀도와 최근 크기(새것부터), 두 화면에서 그려졌는지 (고정 시계, widgetFoldFit 켬)", () => {
    const l: SizeLog = {
      "12": [
        { w: 476, h: 611, sw: 1166, sh: 880, by: "resize", at: NOW - 2 * 3_600_000 },
        { w: 507, h: 222, sw: 594, sh: 939, by: "resize", at: NOW - 5 * 60_000 },
      ],
      "13": [{ w: 507, h: 222, sw: 594, sh: 939, by: "update", at: NOW - 3 * 86_400_000 }],
    };
    const lines = widgetReportLines(
      [
        { name: WIDGET_NAMES.holdings, widgetId: 12, width: 476, height: 611, screenInfo: INNER_SCREEN_2X },
        { name: WIDGET_NAMES.market, widgetId: 13, width: 507, height: 222, screenInfo: { screenWidthDp: 594, screenHeightDp: 939 } },
        { name: WIDGET_NAMES.market, widgetId: 14, width: 476, height: 351, screenInfo: null },
      ],
      l,
      NOW,
      true,
    );
    expect(lines).toEqual([
      "[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 2개 · 넓은 모습은 폭 560dp 이상만",
      "[위젯] 잔고 #12: 지금 476×611dp (화면 1166×880 · 밀도 2.1) · 최근 크기 변경 507×222 (화면 594×939) 5분 전 / 크기 변경 476×611 (화면 1166×880) 2시간 전 · 두 화면에서 그려짐",
      "[위젯] 지수·환율 #13: 지금 507×222dp (화면 594×939) · 최근 주기 507×222 (화면 594×939) 3일 전",
      "[위젯] 지수·환율 #14: 지금 476×351dp (화면 모름) · 기록 없음",
    ]);
  });

  it("검증 지적: widgetFoldFit 이 꺼져 있으면 첫 줄은 예전 기준(504/540/644dp)·'크기 기록 안 함'이고, 남아 있던 옛 크기 기록은 보이지 않는다", () => {
    const l: SizeLog = { "12": [{ w: 507, h: 222, sw: 594, sh: 939, by: "resize", at: NOW - 5 * 60_000 }] };
    const list = [{ name: WIDGET_NAMES.holdings, widgetId: 12, width: 476, height: 611, screenInfo: INNER_SCREEN_2X }];
    expect(widgetReportLines(list, l, NOW, false)).toEqual([
      "[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 0개 · 넓은 모습은 예전 기준(평가금액 칸 504dp·지수 옆 칸 540dp·두 열 644dp 이상) · 크기 기록 안 함(widgetFoldFit 꺼짐)",
      "[위젯] 잔고 #12: 지금 476×611dp (화면 1166×880 · 밀도 2.1)",
    ]);
    // 적힌 기준 숫자가 그림의 예전 기준과 같다 (layout.ts WIDE — 위 '예전 기준 확인' 테스트가 그림으로 확인)
    expect([WIDE.valueMin + PAD * 2, WIDE.boardMin, WIDE.columnMin * 2 + WIDE.columnGap + PAD * 2]).toEqual([504, 540, 644]);
  });

  it("검증 지적: 첫 줄의 규칙은 위젯이 마지막으로 그린 데이터의 플래그를 따른다 — 켰다가 끈 뒤 남은 기록은 보이지 않고, 다시 켜면 보인다", async () => {
    shared.widgets = { [WIDGET_NAMES.holdings]: [{ widgetId: 21, width: 507, height: 222, screenInfo: COVER_SCREEN_2X }] };
    await noteWidgetSize({ widgetId: 21, width: 507, height: 222, screenInfo: COVER_SCREEN_2X }, "resize", NOW - 60_000);
    await saveWidgetView(data(false), "https://server.test");
    expect(await widgetReport(NOW)).toEqual([
      "[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 0개 · 넓은 모습은 예전 기준(평가금액 칸 504dp·지수 옆 칸 540dp·두 열 644dp 이상) · 크기 기록 안 함(widgetFoldFit 꺼짐)",
      "[위젯] 잔고 #21: 지금 507×222dp (화면 594×939 · 밀도 2.1)",
    ]);
    // 위젯 데이터를 아직 받은 적이 없어도(저장한 값 없음) 꺼짐과 같다 (그림도 꺼짐 기준으로 그린다)
    store.delete("widget.view");
    expect((await widgetReport(NOW))[0]).toMatch(/예전 기준.*크기 기록 안 함/);
    await saveWidgetView(data(true), "https://server.test");
    expect(await widgetReport(NOW)).toEqual([
      "[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 0개 · 넓은 모습은 폭 560dp 이상만",
      "[위젯] 잔고 #21: 지금 507×222dp (화면 594×939 · 밀도 2.1) · 최근 크기 변경 507×222 (화면 594×939) 1분 전",
    ]);
  });

  it("홈 화면 위젯과 기록을 읽어 만든다 — 같은 이름이 둘이면(두 화면에 따로 놓음) 둘 다 적는다", async () => {
    await saveWidgetView(data(true), "https://server.test");
    shared.widgets = {
      [WIDGET_NAMES.holdings]: [
        { widgetId: 21, width: 507, height: 222, screenInfo: COVER_SCREEN_2X },
        { widgetId: 22, width: 476, height: 611, screenInfo: COVER_SCREEN_2X },
      ],
    };
    await noteWidgetSize({ widgetId: 21, width: 507, height: 222, screenInfo: COVER_SCREEN_2X }, "resize", NOW - 60_000);
    const lines = await widgetReport(NOW);
    expect(lines[0]).toBe("[위젯] 잔고 2개 · 자산 0개 · 브리핑 0개 · 지수·환율 0개 · 넓은 모습은 폭 560dp 이상만");
    expect(lines[1]).toBe("[위젯] 잔고 #21: 지금 507×222dp (화면 594×939 · 밀도 2.1) · 최근 크기 변경 507×222 (화면 594×939) 1분 전");
    expect(lines[2]).toBe("[위젯] 잔고 #22: 지금 476×611dp (화면 594×939 · 밀도 2.1) · 기록 없음");
  });
});
