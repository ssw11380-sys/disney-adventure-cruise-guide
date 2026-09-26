import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 위젯 2차 (B): 폴드8 커버 화면 미러링 — 한 위젯이 바깥(접힘, 세로)과 안쪽(펼침, 가로) 화면에 함께 보일 때 (플래그 widgetFoldFit).
 * 라이브러리는 그리는 순간의 방향 하나로 그림 크기를 고른다 (세로 = 가장 좁은 폭 × 가장 큰 높이, 가로 = 가장 넓은 폭 × 가장 작은 높이 —
 * RNWidgetUtil). 런처가 두 화면 크기를 모두 알려 주면(아래 '범위') 두 벌이 화면과 엇갈려, 펼쳐서 그린 넓고 낮은 그림(평가금액 칸)이
 * 접힌 바깥 화면에 보였다 (2026-09-26 토 10:32 캡처). 화면마다 크기를 따로 알려 주는 런처(아래 '화면마다')여도 같은 규칙으로 본다.
 *  - 두 화면의 크기를 다 알면: 넓은 모습(평가금액 칸·두 열·지수 옆 칸)은 두 화면 중 좁은 폭이 허락할 때만 — 바깥 화면에 넓은 모습이 나오지 않는다
 *  - '범위' 런처: 두 화면에 모두 들어가는 크기로 그리고 남는 곳은 투명 (카드가 두 화면 어디서나 같다)
 *  - 한 방향만 봤거나 같은 화면을 돌린 것(일반 폰)·플래그 꺼짐: 지금 그림과 한 글자도 다르지 않다
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
const io = vi.hoisted(() => ({ reads: 0, writes: 0 }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      io.reads++;
      return store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      io.writes++;
      store.set(k, v);
    },
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { buildWidgetTree } = await lib("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { differentDisplays, forgetFrame, FRAME_FORGET_MS, frameFor, frameOf, orientationOf, remember, screenChanged } = await import("@/widgets/frame");
const { renderBoth, renderFor } = await import("@/widgets/render");
const { WIDGET_NAMES } = await import("@/widgets/widgets");
const { WIDE, PAD } = await import("@/widgets/layout");
const { WIDGET_FONT } = await import("@/widgets/palette");
const { widgetFeatures } = await import("@/widgets/payload");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { redrawForScreen } = await import("@/widgets/refresh");
const { saveWidgetView } = await import("@/widgets/data");
type WidgetData = import("@/widgets/data").WidgetData;
type BoxInfo = import("@/widgets/frame").BoxInfo;

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string };
  children?: Tree[];
}
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const tree = (r: { dark: React.JSX.Element }): Tree => buildWidgetTree(r.dark) as Tree;
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
/** 카드 크기: 두 화면에 맞춘 그림이면 투명 바탕 안의 카드, 아니면 그림 전체 */
function card(t: Tree, box: { width: number; height: number }): { width: number; height: number } {
  const inner = t.children?.length === 1 ? t.children[0]! : null;
  if (t.props.width === "match_parent" && inner && typeof inner.props.width === "number" && typeof inner.props.height === "number" && !t.props.backgroundColor) {
    return { width: inner.props.width, height: inner.props.height };
  }
  return { width: box.width, height: box.height };
}

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

// ── 화면 (dp) ──
/** 바깥 화면 (세로). 420dpi 추정(docs/폴드-위젯.md)과 캡처로 잰 값(밀도 약 2.1 — 1248px 폭) */
const COVER_SCREEN = { screenWidthDp: 475, screenHeightDp: 751 };
const COVER_SCREEN_2X = { screenWidthDp: 594, screenHeightDp: 939 };
/** 안쪽 화면 (가로) */
const INNER_SCREEN = { screenWidthDp: 933, screenHeightDp: 704 };
const INNER_SCREEN_2X = { screenWidthDp: 1166, screenHeightDp: 880 };
interface Place {
  name: string;
  width: number;
  height: number;
  screen: { screenWidthDp: number; screenHeightDp: number };
}
/** 바깥 4x2 (docs/폴드-위젯.md 표의 범위 양 끝 + 캡처 실측) */
const COVERS: Place[] = [
  { name: "바깥 4x2 좁게", width: 405, height: 180, screen: COVER_SCREEN },
  { name: "바깥 4x2 작게", width: 430, height: 180, screen: COVER_SCREEN },
  { name: "바깥 4x2 크게", width: 460, height: 290, screen: COVER_SCREEN },
  { name: "바깥 4x2 캡처", width: 507, height: 222, screen: COVER_SCREEN_2X },
];
/** 안쪽 (미러링 반쪽 · 캡처 실측 · 가로로 넓게) */
const INNERS: Place[] = [
  { name: "안쪽 반쪽 4x2", width: 435, height: 200, screen: INNER_SCREEN },
  { name: "안쪽 반쪽 4x4", width: 450, height: 320, screen: INNER_SCREEN },
  { name: "안쪽 캡처 잔고", width: 476, height: 611, screen: INNER_SCREEN_2X },
  { name: "안쪽 캡처 지수", width: 476, height: 351, screen: INNER_SCREEN_2X },
  { name: "안쪽 가로 4x2", width: 520, height: 230, screen: INNER_SCREEN },
  { name: "안쪽 가로 6x2", width: 780, height: 230, screen: INNER_SCREEN },
  { name: "안쪽 가로 6x3", width: 780, height: 350, screen: INNER_SCREEN },
  { name: "안쪽 가로 6x4", width: 900, height: 470, screen: INNER_SCREEN },
];
/**
 * 라이브러리가 두 방향에서 고르는 크기 (RNWidgetUtil):
 *  - range: 런처가 두 화면 크기를 모두 범위로 알려 줌 → 세로 = (좁은 폭, 큰 높이), 가로 = (넓은 폭, 작은 높이). 한 그림이 두 화면에 보인다
 *  - perScreen: 런처가 접고 펼 때마다 그 화면 크기로 바꿔 알려 줌 (크기 변경 알림으로 그 화면에서 다시 그린다)
 */
function libraryBoxes(cover: Place, inner: Place, mode: "range" | "perScreen", id: number): { p: BoxInfo; l: BoxInfo } {
  if (mode === "perScreen") return { p: { widgetId: id, width: cover.width, height: cover.height, screenInfo: cover.screen }, l: { widgetId: id, width: inner.width, height: inner.height, screenInfo: inner.screen } };
  return {
    p: { widgetId: id, width: Math.min(cover.width, inner.width), height: Math.max(cover.height, inner.height), screenInfo: cover.screen },
    l: { widgetId: id, width: Math.max(cover.width, inner.width), height: Math.min(cover.height, inner.height), screenInfo: inner.screen },
  };
}
/** 접고(세로) 펴고(가로) 다시 접고 펴며 그린다 — 두 방향을 다 본 뒤의 마지막 두 그림 */
async function foldCycle(name: string, d: WidgetData, b: { p: BoxInfo; l: BoxInfo }) {
  await renderFor(name, d, b.p, OPTS);
  await renderFor(name, d, b.l, OPTS);
  const p = tree(await renderFor(name, d, b.p, OPTS));
  const l = tree(await renderFor(name, d, b.l, OPTS));
  return { p, l };
}
const allows = (width: number) => ({ value: width - PAD * 2 >= WIDE.valueMin, twoColumns: width - PAD * 2 >= WIDE.columnMin * 2 + WIDE.columnGap, boardWide: width >= WIDE.boardMin });

beforeEach(() => {
  store.clear();
  io.reads = 0;
  io.writes = 0;
  shared.widgets = {};
  shared.updates = [];
  vi.unstubAllGlobals();
});

describe("크기 기억 (순수 함수)", () => {
  const P = { screenWidthDp: 475, screenHeightDp: 751 };
  const L = { screenWidthDp: 933, screenHeightDp: 704 };
  it("방향은 라이브러리와 같은 기준 (폭 > 높이면 가로), 화면을 모르면 null", () => {
    expect(orientationOf(P)).toBe("p");
    expect(orientationOf(L)).toBe("l");
    expect(orientationOf({ screenWidthDp: 700, screenHeightDp: 700 })).toBe("p");
    expect(orientationOf({})).toBeNull();
    expect(orientationOf(null)).toBeNull();
  });

  it("다른 화면: 짧은 변이 10% 넘게 다를 때 (폴드 바깥 475 ↔ 안쪽 704). 폰을 돌린 것은 같은 화면", () => {
    expect(differentDisplays(475, 704)).toBe(true);
    expect(differentDisplays(594, 880)).toBe(true);
    expect(differentDisplays(411, 411)).toBe(false);
    expect(differentDisplays(700, 704)).toBe(false);
  });

  it("범위 런처(엇갈린 두 벌)는 두 화면에 모두 들어가는 크기 — 캡처 실측 잔고 (바깥 507×222 · 안쪽 476×611)", () => {
    let m = remember(null, { width: 476, height: 611, screenInfo: COVER_SCREEN_2X }, 0);
    expect(frameOf(m, { width: 476, height: 611 })).toEqual({ width: 476, height: 611, fit: "none" }); // 한 방향만 — 그대로
    m = remember(m, { width: 507, height: 222, screenInfo: INNER_SCREEN_2X }, 1);
    expect(frameOf(m, { width: 507, height: 222 })).toEqual({ width: 476, height: 222, fit: "both" });
    expect(frameOf(m, { width: 476, height: 611 })).toEqual({ width: 476, height: 222, fit: "both" });
  });

  it("화면마다 크기를 알려 주는 런처는 지금 크기 그대로, 넓은 모습만 좁은 화면 폭까지", () => {
    let m = remember(null, { width: 507, height: 222, screenInfo: COVER_SCREEN_2X }, 0);
    m = remember(m, { width: 476, height: 611, screenInfo: INNER_SCREEN_2X }, 1);
    expect(frameOf(m, { width: 476, height: 611 })).toEqual({ width: 476, height: 611, fit: "none" }); // 좁은 쪽은 그대로
    m = remember(m, { width: 507, height: 222, screenInfo: COVER_SCREEN_2X }, 2);
    expect(frameOf(m, { width: 507, height: 222 })).toEqual({ width: 507, height: 222, wideWidth: 476, fit: "wide" });
  });

  it("일반 폰을 돌린 것(같은 화면)은 지금 크기 그대로", () => {
    let m = remember(null, { width: 380, height: 220, screenInfo: { screenWidthDp: 411, screenHeightDp: 914 } }, 0);
    m = remember(m, { width: 700, height: 150, screenInfo: { screenWidthDp: 914, screenHeightDp: 411 } }, 1);
    expect(frameOf(m, { width: 700, height: 150 })).toEqual({ width: 700, height: 150, fit: "none" });
    expect(frameOf(m, { width: 380, height: 220 })).toEqual({ width: 380, height: 220, fit: "none" });
  });

  it("같은 방향에서 크기가 바뀌면(크기 조절·격자·화면 확대) 다른 방향의 옛 크기는 버린다 · 14일이 지나도 버린다", () => {
    let m = remember(null, { width: 435, height: 290, screenInfo: P }, 0);
    m = remember(m, { width: 460, height: 200, screenInfo: L }, 1);
    expect(frameOf(m, { width: 460, height: 200 }).fit).toBe("both");
    const resized = remember(m, { width: 460, height: 290, screenInfo: L }, 2);
    expect(resized.p).toBeUndefined();
    expect(frameOf(resized, { width: 460, height: 290 }).fit).toBe("none");
    const old = remember(m, { width: 460, height: 200, screenInfo: L }, 1 + FRAME_FORGET_MS + 1);
    expect(old.p).toBeUndefined();
    const fresh = remember(m, { width: 460, height: 200, screenInfo: L }, FRAME_FORGET_MS - 1);
    expect(fresh.p).toBeDefined();
  });

  it("같은 크기를 안쪽 화면을 세로로 돌려서도 보면(범위 런처) 가장 짧은 화면 변을 둔다 — 바깥에도 보이는 위젯인 것을 잊지 않게", () => {
    let m = remember(null, { width: 435, height: 290, screenInfo: P }, 0); // 바깥 (짧은 변 475)
    m = remember(m, { width: 460, height: 200, screenInfo: L }, 1);
    m = remember(m, { width: 435, height: 290, screenInfo: { screenWidthDp: 704, screenHeightDp: 933 } }, 2); // 안쪽 세로
    expect(m.p!.sw).toBe(475);
    expect(frameOf(m, { width: 435, height: 290 }).fit).toBe("both");
  });

  it("화면 크기 변경: 접기·펴기·돌리기만 (1dp 미만 반올림 차이는 같다)", () => {
    expect(screenChanged({ width: 475, height: 751 }, { width: 933, height: 704 })).toBe(true);
    expect(screenChanged({ width: 475, height: 751 }, { width: 751, height: 475 })).toBe(true);
    expect(screenChanged({ width: 475.2, height: 751 }, { width: 475.4, height: 751 })).toBe(false);
    expect(screenChanged(null, { width: 1, height: 1 })).toBe(false);
  });
});

describe("저장 (위젯마다 AsyncStorage) · 플래그", () => {
  const P_BOX: BoxInfo = { widgetId: 5, width: 435, height: 290, screenInfo: COVER_SCREEN };
  const L_BOX: BoxInfo = { widgetId: 5, width: 460, height: 200, screenInfo: INNER_SCREEN };
  it("플래그가 꺼져 있으면 읽지도 적지도 않고 지금 크기 그대로", async () => {
    expect(await frameFor(P_BOX, false)).toEqual({ width: 435, height: 290, fit: "none", outerWidth: 435, outerHeight: 290 });
    expect(await frameFor(L_BOX, false)).toEqual({ width: 460, height: 200, fit: "none", outerWidth: 460, outerHeight: 200 });
    expect(io.reads + io.writes).toBe(0);
    expect(store.size).toBe(0);
  });

  it("켜져 있으면 위젯마다 적고, 크기가 같으면 다시 적지 않는다 (한 시간에 한 번만 본 시각을 새로)", async () => {
    await frameFor(P_BOX, true, 0);
    expect(await frameFor(L_BOX, true, 1_000)).toEqual({ width: 435, height: 200, fit: "both", outerWidth: 460, outerHeight: 200 });
    const writes = io.writes;
    await frameFor(L_BOX, true, 2_000);
    await frameFor(P_BOX, true, 3_000);
    expect(io.writes).toBe(writes);
    await frameFor(P_BOX, true, 3_600_000 + 5_000);
    expect(io.writes).toBe(writes + 1);
    // 다른 위젯은 따로
    expect(await frameFor({ ...L_BOX, widgetId: 6 }, true, 1_000)).toMatchObject({ fit: "none" });
  });

  it("위젯을 지우면(WIDGET_DELETED) 그 위젯의 기억도 지운다", async () => {
    await frameFor(P_BOX, true, 0);
    await frameFor({ ...P_BOX, widgetId: 9 }, true, 0);
    expect([...store.keys()].sort()).toEqual(["widget.frame.5", "widget.frame.9"]);
    await widgetTaskHandler({ widgetInfo: { widgetName: WIDGET_NAMES.holdings, widgetId: 5, width: 0, height: 0, screenInfo: {} }, widgetAction: "WIDGET_DELETED", renderWidget: () => undefined } as never);
    expect([...store.keys()]).toEqual(["widget.frame.9"]);
    await forgetFrame(9);
    expect(store.size).toBe(0);
  });
});

describe("폴드8 크기: 두 화면을 다 알면 바깥 화면에 넓은 모습이 나오지 않는다", () => {
  const MODES = ["range", "perScreen"] as const;
  const NAMES = [WIDGET_NAMES.holdings, WIDGET_NAMES.market];

  it("재현 (고치기 전 = 플래그 꺼짐): 캡처 실측 크기에서 바깥 화면에 보이는 그림에 평가금액 칸이 있다", async () => {
    const cover = COVERS.find((c) => c.name === "바깥 4x2 캡처")!;
    const inner = INNERS.find((c) => c.name === "안쪽 캡처 잔고")!;
    // 범위 런처: 펼쳐서 그린 그림(넓은 폭 507 × 낮은 높이 222)이 바깥에 보인다
    const range = libraryBoxes(cover, inner, "range", 1);
    expect(extras(tree(renderBoth(WIDGET_NAMES.holdings, data(false), { ...OPTS, width: range.l.width, height: range.l.height }))).value).toBe(true);
    // 화면마다 런처: 바깥 화면 그림 자체가 507dp (평가금액 기준 504dp 를 넘는다)
    const per = libraryBoxes(cover, inner, "perScreen", 2);
    expect(extras(tree(renderBoth(WIDGET_NAMES.holdings, data(false), { ...OPTS, width: per.p.width, height: per.p.height }))).value).toBe(true);
    // 플래그 꺼짐이면 renderFor 도 같다
    expect((await foldCycle(WIDGET_NAMES.holdings, data(false), range)).l).toEqual(tree(renderBoth(WIDGET_NAMES.holdings, data(false), { ...OPTS, width: range.l.width, height: range.l.height })));
  });

  it("고친 뒤: 캡처 실측 크기 — 두 런처 모두 바깥·안쪽 그림에 평가금액 칸이 없다", async () => {
    const cover = COVERS.find((c) => c.name === "바깥 4x2 캡처")!;
    const inner = INNERS.find((c) => c.name === "안쪽 캡처 잔고")!;
    for (const [n, mode] of MODES.entries()) {
      const { p, l } = await foldCycle(WIDGET_NAMES.holdings, data(true), libraryBoxes(cover, inner, mode, 10 + n));
      expect(extras(p).value, mode).toBe(false);
      expect(extras(l).value, mode).toBe(false);
    }
  });

  it("바깥 4x2 × 안쪽 8가지 × 두 런처 × 잔고·지수: 넓은 모습은 두 화면 중 좁은 폭이 허락할 때만, 범위 런처의 카드는 두 화면에 모두 들어간다", async () => {
    let id = 100;
    let checked = 0;
    for (const cover of COVERS)
      for (const inner of INNERS)
        for (const mode of MODES)
          for (const name of NAMES) {
            const b = libraryBoxes(cover, inner, mode, id++);
            const { p, l } = await foldCycle(name, data(true), b);
            const ok = allows(Math.min(cover.width, inner.width));
            const label = `${name} ${cover.name} ${cover.width}×${cover.height} · ${inner.name} ${inner.width}×${inner.height} · ${mode}`;
            for (const [side, t] of [["p", p], ["l", l]] as const) {
              const e = extras(t);
              if (e.value) expect(ok.value, `${label} ${side} 평가금액`).toBe(true);
              if (e.twoColumns) expect(ok.twoColumns, `${label} ${side} 두 열`).toBe(true);
              if (e.boardWide) expect(ok.boardWide, `${label} ${side} 지수 옆 칸`).toBe(true);
              if (mode === "range") {
                const c = card(t, b[side]);
                expect(c.width, `${label} ${side} 카드 폭`).toBeLessThanOrEqual(Math.min(cover.width, inner.width));
                expect(c.height, `${label} ${side} 카드 높이`).toBeLessThanOrEqual(Math.min(cover.height, inner.height));
              }
              checked++;
            }
          }
    expect(checked).toBe(COVERS.length * INNERS.length * MODES.length * NAMES.length * 2);
  });

  it("화면마다 런처 · 바깥 507 · 안쪽 6x3(780×350): 안쪽 그림은 바깥 폭이 허락하는 평가금액 칸까지만 (두 열·지수 옆 칸은 없다 — 예전에는 있었다)", async () => {
    const b = libraryBoxes(COVERS[3]!, INNERS[6]!, "perScreen", 40);
    const { l } = await foldCycle(WIDGET_NAMES.holdings, data(true), b);
    expect(extras(l)).toMatchObject({ value: true, twoColumns: false });
    expect(card(l, b.l)).toEqual({ width: 780, height: 350 }); // 크기는 그대로 (안쪽 화면에서 그 화면 크기로 다시 그린다)
    expect(extras(tree(renderBoth(WIDGET_NAMES.holdings, data(true), { ...OPTS, width: 780, height: 350 })))).toMatchObject({ twoColumns: true });
    const m = await foldCycle(WIDGET_NAMES.market, data(true), libraryBoxes(COVERS[3]!, INNERS[6]!, "perScreen", 41));
    expect(extras(m.l).boardWide).toBe(false);
    expect(extras(tree(renderBoth(WIDGET_NAMES.market, data(true), { ...OPTS, width: 780, height: 350 }))).boardWide).toBe(true);
  });

  it("범위 런처: 카드 밖은 투명 칸 하나뿐이고(바탕색 없음), 카드 안은 두 화면에 모두 들어가는 크기로 고른 그림과 같다", async () => {
    const cover = COVERS.find((c) => c.name === "바깥 4x2 크게")!; // 460×290
    const inner = INNERS.find((c) => c.name === "안쪽 가로 4x2")!; // 520×230
    const b = libraryBoxes(cover, inner, "range", 7);
    const { p, l } = await foldCycle(WIDGET_NAMES.holdings, data(true), b);
    for (const t of [p, l]) {
      expect(t.props.backgroundColor).toBeUndefined();
      expect(t.children).toHaveLength(1);
      expect(card(t, b.p)).toEqual({ width: 460, height: 230 });
      // 카드 안 = 460×230 로 그린 그림 (평가금액 칸 없음 — 예전 가로 그림 520×230 에는 있었다)
      expect(t.children![0]!.children![0]).toEqual(tree(renderBoth(WIDGET_NAMES.holdings, data(true), { ...OPTS, width: 460, height: 230 })));
    }
    expect(extras(tree(renderBoth(WIDGET_NAMES.holdings, data(false), { ...OPTS, width: 520, height: 230 }))).value).toBe(true);
  });

  it("넓게 늘린 안쪽 위젯이 바깥에는 안 보이면(안쪽만 — 한 방향만 봄) 넓은 모습 그대로 (3-42): 6x3 두 열·평가금액, 지수 옆 칸", async () => {
    const box: BoxInfo = { widgetId: 30, width: 780, height: 350, screenInfo: INNER_SCREEN };
    const h = tree(await renderFor(WIDGET_NAMES.holdings, data(true), box, OPTS));
    expect(extras(h)).toMatchObject({ twoColumns: true });
    const m = tree(await renderFor(WIDGET_NAMES.market, data(true), { ...box, widgetId: 31 }, OPTS));
    expect(extras(m).boardWide).toBe(true);
  });

  it("한 방향만 본 위젯 · 일반 폰을 돌린 것 · 플래그 꺼짐: 지금 그림과 똑같다 (위젯 4종)", async () => {
    const PHONE_P = { screenWidthDp: 411, screenHeightDp: 914 };
    const PHONE_L = { screenWidthDp: 914, screenHeightDp: 411 };
    let id = 500;
    for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.market, WIDGET_NAMES.briefing, WIDGET_NAMES.asset]) {
      for (const place of [...COVERS, ...INNERS]) {
        const box: BoxInfo = { widgetId: id++, width: place.width, height: place.height, screenInfo: place.screen };
        const plain = tree(renderBoth(name, data(true), { ...OPTS, width: box.width, height: box.height }));
        expect(tree(await renderFor(name, data(true), box, OPTS)), `${name} ${place.name}`).toEqual(plain);
        expect(tree(await renderFor(name, data(true), box, OPTS)), `${name} ${place.name} 두 번째`).toEqual(plain);
      }
      // 일반 폰: 세로 380×220 ↔ 가로 700×150 (같은 화면)
      const p: BoxInfo = { widgetId: id, width: 380, height: 220, screenInfo: PHONE_P };
      const l: BoxInfo = { widgetId: id++, width: 700, height: 150, screenInfo: PHONE_L };
      await renderFor(name, data(true), p, OPTS);
      expect(tree(await renderFor(name, data(true), l, OPTS)), `${name} 폰 가로`).toEqual(tree(renderBoth(name, data(true), { ...OPTS, width: 700, height: 150 })));
      expect(tree(await renderFor(name, data(true), p, OPTS)), `${name} 폰 세로`).toEqual(tree(renderBoth(name, data(true), { ...OPTS, width: 380, height: 220 })));
      // 플래그 꺼짐: 폴드 두 화면을 오가도 그대로
      const b = libraryBoxes(COVERS[2]!, INNERS[4]!, "range", id++);
      const off = await foldCycle(name, data(false), b);
      expect(off.p, `${name} 꺼짐 세로`).toEqual(tree(renderBoth(name, data(false), { ...OPTS, width: b.p.width, height: b.p.height })));
      expect(off.l, `${name} 꺼짐 가로`).toEqual(tree(renderBoth(name, data(false), { ...OPTS, width: b.l.width, height: b.l.height })));
    }
  });

  it("화면 읽기: 두 화면에 맞춘 그림도 누르는 칸마다 이름표가 그대로 (자산 위젯 전체 칸 포함)", async () => {
    const b = libraryBoxes({ name: "", width: 230, height: 110, screen: COVER_SCREEN }, { name: "", width: 260, height: 90, screen: INNER_SCREEN }, "range", 900);
    const { l } = await foldCycle(WIDGET_NAMES.asset, data(true), b);
    const plain = tree(renderBoth(WIDGET_NAMES.asset, data(true), { ...OPTS, width: 230, height: 90 }));
    const labels = (t: Tree) => nodes(t).filter((n) => n.props.clickAction).map((n) => n.props.accessibilityLabel);
    expect(labels(l)).toEqual(labels(plain));
    expect(labels(l).every((x) => typeof x === "string" && x.length > 0)).toBe(true);
    // 위젯 전체 설명(맨 바깥 칸의 이름표)도 감싼 칸으로 옮긴다
    expect(card(l, b.l)).toEqual({ width: 230, height: 90 });
    expect(l.props.accessibilityLabel).toBe(plain.props.accessibilityLabel);
    expect(typeof plain.props.accessibilityLabel).toBe("string");
    const h = await foldCycle(WIDGET_NAMES.holdings, data(true), libraryBoxes(COVERS[2]!, INNERS[4]!, "range", 901));
    expect(labels(h.l)).toEqual(labels(tree(renderBoth(WIDGET_NAMES.holdings, data(true), { ...OPTS, width: 460, height: 230 }))));
  });
});

describe("앱이 떠 있을 때 접고 펴면 다시 그리기 (refresh.tsx redrawForScreen)", () => {
  const place = (screen: Place["screen"], w: number, h: number) =>
    (shared.widgets = {
      [WIDGET_NAMES.holdings]: [{ widgetId: 1, width: w, height: h, screenInfo: screen }],
      [WIDGET_NAMES.market]: [{ widgetId: 2, width: w, height: h, screenInfo: screen }],
    });
  it("서버를 부르지 않고 마지막으로 그린 값으로 위젯을 다시 그리고, 그 화면 크기를 기억한다", async () => {
    await saveWidgetView(data(true), "https://server.test");
    vi.stubGlobal("fetch", async () => {
      throw new Error("서버를 부르면 안 된다");
    });
    place(COVER_SCREEN, 460, 290); // 범위 런처: 접힘(세로) = 좁은 폭 × 큰 높이
    await redrawForScreen();
    expect(shared.updates.map((u) => u.widgetName).sort()).toEqual([WIDGET_NAMES.holdings, WIDGET_NAMES.market].sort());
    place(INNER_SCREEN, 520, 230); // 펼침(가로) = 넓은 폭 × 작은 높이
    shared.updates = [];
    await redrawForScreen();
    const h = tree(shared.updates.find((u) => u.widgetName === WIDGET_NAMES.holdings)!.rendered as { dark: React.JSX.Element });
    expect(card(h, { width: 520, height: 230 })).toEqual({ width: 460, height: 230 });
    expect(extras(h).value).toBe(false);
    expect(JSON.parse(store.get("widget.frame.1")!)).toMatchObject({ p: { w: 460, h: 290, sw: 475 }, l: { w: 520, h: 230, sw: 704 } });
  });

  it("위젯이 쓰는 플래그가 꺼져 있으면 아무 일도 하지 않는다", async () => {
    await saveWidgetView(data(false), "https://server.test");
    place(COVER_SCREEN, 460, 290);
    await redrawForScreen();
    expect(shared.updates).toHaveLength(0);
  });
});
