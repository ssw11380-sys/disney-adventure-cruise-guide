import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 위젯 2차 (B): 폴드8 바깥 화면(접힘)에 펼친 화면 모양(잔고 평가금액 칸 등)이 보이던 것 (플래그 widgetFoldFit · widgetFoldBoth).
 * 라이브러리는 그리는 순간의 방향 하나로 그림 크기를 고른다 (세로 = 가장 좁은 폭 × 가장 큰 높이, 가로 = 가장 넓은 폭 × 가장 작은 높이 — RNWidgetUtil).
 * 2026-09-26 토 10:32 캡처 두 장으로는 홈 화면이 위젯을 어떻게 두는지 가릴 수 없어 세 경우를 모두 본다:
 *  - range(①): 같은 위젯이 두 화면에, 옵션은 두 화면 칸 크기의 범위 — 접어서 그린 그림·펴서 그린 그림이 두 화면에 번갈아 보인다
 *  - perScreen(②): 같은 위젯이 두 화면에, 접고 펼 때 그 화면 칸 크기로 옵션을 다시 보내 크기 변경 알림으로 다시 그린다
 *  - separate(③): 두 화면에 서로 다른 위젯 (바깥 위젯도 펼친 채 그려질 수 있다 — 앱 즉시 갱신 등)
 * 고친 뒤: 접는 폰에서 바깥 화면에 보일 수 있는 그림에는 넓은 모습(평가금액 칸·두 열·지수 옆 칸)이 없다. 칸 크기는 그대로(투명한 빈 곳 없음 —
 * 두 화면에 들어가는 카드는 widgetFoldBoth 를 켤 때만). 일반 폰·태블릿·플래그 꺼짐은 지금 그림과 한 글자도 다르지 않다.
 * 시각은 모두 고정 시계 (vi.useFakeTimers)
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
const { DEVICE_KEY, DISPLAY_DIFF, differentDisplays, forgetFrame, FRAME_FORGET_MS, FRAME_STALE_MS, frameFor, frameOf, launcherOf, MAX_SEEN, orientationOf, remember, shortSide, WIDE_SCREEN_MIN } = await import("@/widgets/frame");
const { renderBoth, renderFor } = await import("@/widgets/render");
const { WIDGET_NAMES } = await import("@/widgets/widgets");
const { WIDE, PAD } = await import("@/widgets/layout");
const { WIDGET_FONT } = await import("@/widgets/palette");
const { widgetFeatures } = await import("@/widgets/payload");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { saveWidgetView } = await import("@/widgets/data");
const { widgetReport, widgetReportLines } = await import("@/widgets/diagnose");
type WidgetData = import("@/widgets/data").WidgetData;
type BoxInfo = import("@/widgets/frame").BoxInfo;
type FrameMemo = import("@/widgets/frame").FrameMemo;
type SeenBy = import("@/widgets/frame").SeenBy;

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
const data = (foldFit: boolean, both = false): WidgetData => ({
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
  features: widgetFeatures({
    widgetPnlToggle: true,
    widgetIndexLine: true,
    widgetMarket: true,
    widgetPolish: true,
    ...(foldFit ? { widgetFoldFit: true } : {}),
    ...(both ? { widgetFoldBoth: true } : {}),
  }),
});
const OPTS = { fontScale: 1, now: NOW, pnlMode: "cumulative" as const };

// ── 화면 (dp) ──
/** 바깥 화면 (세로). 420dpi 추정(docs/폴드-위젯.md)과 캡처로 잰 값(밀도 약 2.1 — 1248px 폭) */
const COVER_SCREEN = { screenWidthDp: 475, screenHeightDp: 751 };
const COVER_SCREEN_2X = { screenWidthDp: 594, screenHeightDp: 939 };
/** 안쪽 화면 (가로) */
const INNER_SCREEN = { screenWidthDp: 933, screenHeightDp: 704 };
const INNER_SCREEN_2X = { screenWidthDp: 1166, screenHeightDp: 880 };
/** 안쪽 화면을 세로로 */
const INNER_P = { screenWidthDp: 704, screenHeightDp: 933 };
/** 일반 폰 · 태블릿 */
const PHONE_P = { screenWidthDp: 411, screenHeightDp: 914 };
const PHONE_L = { screenWidthDp: 914, screenHeightDp: 411 };
const TABLET_L = { screenWidthDp: 1280, screenHeightDp: 800 };
const TABLET_P = { screenWidthDp: 800, screenHeightDp: 1280 };
type Screen = { screenWidthDp: number; screenHeightDp: number };
interface Place {
  name: string;
  width: number;
  height: number;
  screen: Screen;
}
/** 바깥 4x2 (docs/폴드-위젯.md 표의 범위 양 끝 + 캡처 실측) */
const COVERS: Place[] = [
  { name: "바깥 4x2 좁게", width: 405, height: 180, screen: COVER_SCREEN },
  { name: "바깥 4x2 작게", width: 430, height: 180, screen: COVER_SCREEN },
  { name: "바깥 4x2 크게", width: 460, height: 290, screen: COVER_SCREEN },
  { name: "바깥 4x2 캡처", width: 507, height: 222, screen: COVER_SCREEN_2X },
];
/** 안쪽 (반쪽 · 캡처 실측 · 가로로 넓게) */
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
const MODES = ["range", "perScreen", "separate"] as const;
type Mode = (typeof MODES)[number];
interface Instance {
  /** 접힌 채(바깥 화면이 켜져 있을 때) 그린 크기 · 펼친 채 그린 크기 (라이브러리가 고른 것) */
  p: BoxInfo;
  l: BoxInfo;
  /** 크기를 알게 된 길 (화면마다 런처는 접고 펼 때마다 크기 변경 알림) */
  by: SeenBy;
  /** 이 위젯의 그림이 보일 수 있는 화면 */
  shows: ("cover" | "inner")[];
}
/**
 * 라이브러리가 두 방향에서 고르는 크기 (RNWidgetUtil) — 경우마다 위젯(번호)과 그 그림이 보이는 화면.
 * 한 폰의 두 화면은 밀도가 같다: 바깥이 캡처로 잰 밀도(약 2.1)면 안쪽 화면도 그 밀도의 크기로
 */
function instances(cover: Place, inner: Place, mode: Mode, id: number): Instance[] {
  const innerScreen = cover.screen === COVER_SCREEN_2X ? INNER_SCREEN_2X : inner.screen;
  const box = (w: number, h: number, screenInfo: Screen, widgetId = id): BoxInfo => ({ widgetId, width: w, height: h, screenInfo });
  if (mode === "range")
    return [
      {
        p: box(Math.min(cover.width, inner.width), Math.max(cover.height, inner.height), cover.screen),
        l: box(Math.max(cover.width, inner.width), Math.min(cover.height, inner.height), innerScreen),
        by: "draw",
        shows: ["cover", "inner"],
      },
    ];
  if (mode === "perScreen") return [{ p: box(cover.width, cover.height, cover.screen), l: box(inner.width, inner.height, innerScreen), by: "resize", shows: ["cover", "inner"] }];
  // 따로 놓은 위젯: 옵션은 그 화면 칸 하나 (세로·가로 같음) — 다른 화면이 켜져 있을 때도 그 칸 크기로 그려진다
  return [
    { p: box(cover.width, cover.height, cover.screen), l: box(cover.width, cover.height, innerScreen), by: "draw", shows: ["cover"] },
    { p: box(inner.width, inner.height, cover.screen, id + 50_000), l: box(inner.width, inner.height, innerScreen, id + 50_000), by: "draw", shows: ["inner"] },
  ];
}
/** 접고(세로) 펴고(가로) 다시 접고 펴며 그린다 — 두 화면을 다 본 뒤의 마지막 두 그림 */
async function foldCycle(name: string, d: WidgetData, x: Instance) {
  const o = { ...OPTS, seenBy: x.by };
  await renderFor(name, d, x.p, o);
  await renderFor(name, d, x.l, o);
  const p = tree(await renderFor(name, d, x.p, o));
  const l = tree(await renderFor(name, d, x.l, o));
  return { p, l };
}
const allows = (width: number) => ({ value: width - PAD * 2 >= WIDE.valueMin, twoColumns: width - PAD * 2 >= WIDE.columnMin * 2 + WIDE.columnGap, boardWide: width >= WIDE.boardMin });
const NONE = { value: false, twoColumns: false, boardWide: false };
const plainTree = (name: string, d: WidgetData, b: { width: number; height: number }) => tree(renderBoth(name, d, { ...OPTS, width: b.width, height: b.height }));
/** 접는 폰으로 알아본 기기 (넓은 화면을 한 시간 전에 봄) */
const foldable = () => store.set(DEVICE_KEY, JSON.stringify({ big: NOW - 3_600_000 }));

beforeEach(() => {
  store.clear();
  io.reads = 0;
  io.writes = 0;
  shared.widgets = {};
  shared.updates = [];
  vi.unstubAllGlobals();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("크기 기억 (순수 함수)", () => {
  /** 차례로 본다: [폭, 높이, 화면, 알게 된 길] — 본 시각은 at 부터 1씩 */
  const see = (m: FrameMemo | null, list: [number, number, Screen, SeenBy?][], at = 0): FrameMemo =>
    list.reduce<FrameMemo>((acc, [w, h, screenInfo, by], k) => remember(acc, { width: w, height: h, screenInfo }, at + k, by ?? "draw"), m ?? { seen: [] });
  const sizes = (m: FrameMemo) => m.seen.map((x) => `${x.o}${x.sw}:${x.w}x${x.h}`).sort();
  const COVER_BOX = { width: 507, height: 222, screenInfo: COVER_SCREEN_2X };

  it("방향은 라이브러리와 같은 기준 (폭 > 높이면 가로), 화면을 모르면 null · 짧은 변 · 넓은 화면 기준 600dp", () => {
    expect(orientationOf(COVER_SCREEN)).toBe("p");
    expect(orientationOf(INNER_SCREEN)).toBe("l");
    expect(orientationOf({ screenWidthDp: 700, screenHeightDp: 700 })).toBe("p");
    expect(orientationOf({})).toBeNull();
    expect(orientationOf(null)).toBeNull();
    expect(shortSide(INNER_SCREEN_2X)).toBe(880);
    expect(shortSide({ screenWidthDp: 0, screenHeightDp: 10 })).toBeNull();
    expect(WIDE_SCREEN_MIN).toBe(600);
  });

  it("다른 화면: 짧은 변이 25% 넘게 다를 때 (폴드 바깥 ↔ 안쪽은 30% 넘게). 폰을 돌려 가로에서 상태 표시줄·아래 막대만큼 짧아진 것은 같은 화면", () => {
    expect(DISPLAY_DIFF).toBe(0.25);
    expect(differentDisplays(475, 704)).toBe(true);
    expect(differentDisplays(594, 880)).toBe(true);
    expect(differentDisplays(550, 880)).toBe(true); // 바깥 가로 ↔ 안쪽 가로
    expect(differentDisplays(411, 411)).toBe(false);
    expect(differentDisplays(360, 320)).toBe(false); // 안드로이드 14 이하: 가로의 짧은 변에서 상태 표시줄 24 + 제스처 막대 16 이 빠짐 (11%)
    expect(differentDisplays(411, 340)).toBe(false); // 17%
    expect(differentDisplays(594, 550)).toBe(false); // 바깥 화면 세로 ↔ 가로
  });

  it("검증 지적 재현(필수): 접은 뒤 바깥 홈 화면을 열기 전 옛 옵션 크기로 여러 번 그려져도 기억을 잃지 않고, 바깥 화면에 평가금액 칸이 돌아오지 않는다", () => {
    // 1) 화면마다 런처로 배움 — 접고 펼 때마다 크기 변경 알림
    let m = see(null, [
      [507, 222, COVER_SCREEN_2X, "resize"],
      [476, 611, INNER_SCREEN_2X, "resize"],
      [507, 222, COVER_SCREEN_2X, "resize"],
      [476, 611, INNER_SCREEN_2X, "resize"],
    ]);
    const learned = sizes(m);
    expect(learned).toEqual(["l880:476x611", "p594:507x222"]);
    expect(launcherOf(m)).toBe("perScreen");
    // 2) 앱을 쓰다 접어 주머니에: 화면은 바깥(594, 세로)인데 옵션은 아직 안쪽 것 → 라이브러리가 세로로 고른 476×611 로
    //    백그라운드 작업·위젯 주기 갱신·앱 즉시 갱신이 30분마다 10번 그림 (예전: 첫 번째에 기억을 모두 버렸다)
    for (let k = 0; k < 10; k++) m = remember(m, { width: 476, height: 611, screenInfo: COVER_SCREEN_2X }, 100 + k * 1_800_000, "draw");
    expect(sizes(m)).toEqual(learned);
    expect(launcherOf(m)).toBe("perScreen");
    // 그 사이 바깥 화면(좁은 화면)에서 그린 그림에는 넓은 모습이 없다 (접는 폰 규칙)
    expect(frameOf(m, { width: 476, height: 611, screenInfo: COVER_SCREEN_2X }, { foldable: true })).toMatchObject({ wideWidth: 0 });
    // 3) 바깥 홈 화면을 열면 런처가 바깥 칸 크기를 다시 보냄 → 기억과 같은 크기의 알림 (예전: 다시 기억을 버려 '한 화면'이 되고 평가금액 칸이 돌아왔다)
    m = remember(m, COVER_BOX, 20_000_000, "resize");
    expect(sizes(m)).toEqual(learned);
    expect(launcherOf(m)).toBe("perScreen");
    expect(frameOf(m, COVER_BOX, { foldable: true })).toEqual({ width: 507, height: 222, wideWidth: 0, fit: "wide" });
    // 4) 다시 펴면 안쪽은 칸 크기 그대로. 안쪽 폭(476)은 바깥 화면(594)에 들어가는 폭이라 넓은 모습 없음 (476 은 원래도 평가금액 기준 504 아래)
    m = remember(m, { width: 476, height: 611, screenInfo: INNER_SCREEN_2X }, 20_000_100, "resize");
    expect(frameOf(m, { width: 476, height: 611, screenInfo: INNER_SCREEN_2X }, { foldable: true })).toEqual({ width: 476, height: 611, wideWidth: 0, fit: "wide" });
  });

  it("그리기로만 본 다른 크기는 하루(FRAME_STALE_MS) 넘게 그 줄을 같은 크기로 못 봤을 때만 바꾼다 (알림 없이 크기가 바뀐 경우)", () => {
    const m = see(null, [[507, 222, COVER_SCREEN_2X, "resize"], [476, 611, INNER_SCREEN_2X, "resize"]]);
    expect(sizes(remember(m, { width: 520, height: 222, screenInfo: COVER_SCREEN_2X }, FRAME_STALE_MS, "draw"))).toEqual(sizes(m));
    const late = remember(m, { width: 520, height: 222, screenInfo: COVER_SCREEN_2X }, FRAME_STALE_MS + 1, "draw");
    expect(sizes(late)).toEqual(["l880:476x611", "p594:520x222"]);
    expect(late.seen.find((x) => x.o === "p")!.t).toBeUndefined(); // 런처 확인 없는 줄
  });

  it("런처가 알려 준 크기가 바뀌면: 런처가 확인한 줄이었으면(크기 조절·격자) 다른 줄도 버리고, 그리기로만 본 줄(옛 옵션일 수 있음)이면 그 줄만 고친다", () => {
    const m = see(null, [[507, 222, COVER_SCREEN_2X, "resize"], [476, 611, INNER_SCREEN_2X, "add"]]);
    expect(sizes(remember(m, { width: 476, height: 700, screenInfo: INNER_SCREEN_2X }, 5, "resize"))).toEqual(["l880:476x700"]);
    // 안쪽에서 추가한 뒤 접어 옛 옵션(476×611)으로 처음 본 바깥 줄 → 바깥 홈 화면의 알림(507×222)이 그 줄만 고친다
    let n = see(null, [[476, 611, INNER_SCREEN_2X, "add"], [476, 611, COVER_SCREEN_2X, "draw"]]);
    n = remember(n, COVER_BOX, 5, "resize");
    expect(sizes(n)).toEqual(["l880:476x611", "p594:507x222"]);
    expect(n.seen.every((x) => x.t === 1)).toBe(true);
    expect(launcherOf(n)).toBe("perScreen");
  });

  it("검증 지적: 범위 런처는 한 화면에서 한 번 온 같은 크기 알림(런처 재시작 등)으로 '화면마다'가 되지 않는다 — 두 화면 모두에서 와야", () => {
    let m = see(null, [[476, 611, COVER_SCREEN_2X], [507, 222, INNER_SCREEN_2X]]);
    expect(launcherOf(m)).toBe("range");
    m = remember(m, { width: 507, height: 222, screenInfo: INNER_SCREEN_2X }, 10, "resize");
    expect(launcherOf(m)).toBe("range");
    m = remember(m, { width: 476, height: 611, screenInfo: COVER_SCREEN_2X }, 11, "resize");
    expect(launcherOf(m)).toBe("perScreen");
    // 14일이 지나면 줄도 증거도 버린다
    const old = remember(m, { width: 507, height: 222, screenInfo: INNER_SCREEN_2X }, 11 + FRAME_FORGET_MS + 1, "draw");
    expect(launcherOf(old)).toBe("one");
    expect(old.seen.every((x) => x.r === undefined)).toBe(true);
  });

  it("런처 모양: 두 화면에서 같은 방향·같은 크기면 ①(확실), 세로가 가로보다 넓거나 낮으면 ②(확실 — 캡처 크기), 한 화면만이면 한 화면", () => {
    expect(launcherOf(see(null, [[476, 611, COVER_SCREEN_2X], [507, 222, INNER_SCREEN_2X], [507, 222, { screenWidthDp: 939, screenHeightDp: 550 }]]))).toBe("range");
    expect(launcherOf(see(null, [[507, 222, COVER_SCREEN_2X], [476, 611, INNER_SCREEN_2X]]))).toBe("perScreen");
    expect(launcherOf(see(null, [[380, 220, PHONE_P], [700, 150, PHONE_L]]))).toBe("one");
    expect(launcherOf(see(null, [[700, 400, INNER_P], [780, 350, INNER_SCREEN]]))).toBe("one"); // 안쪽 화면만 돌림
  });

  it("14일 동안 못 본 줄은 버리고, 화면·방향 줄은 최대 4개 (가장 오래 못 본 줄부터)", () => {
    const m = see(null, [[435, 290, COVER_SCREEN], [460, 200, INNER_SCREEN]]);
    expect(remember(m, { width: 460, height: 200, screenInfo: INNER_SCREEN }, FRAME_FORGET_MS + 1).seen.map((x) => x.o)).toEqual(["l"]);
    expect(remember(m, { width: 460, height: 200, screenInfo: INNER_SCREEN }, FRAME_FORGET_MS - 1).seen.map((x) => x.o).sort()).toEqual(["l", "p"]);
    const five = see(null, [
      [300, 200, { screenWidthDp: 300, screenHeightDp: 600 }],
      [400, 200, COVER_SCREEN],
      [500, 200, INNER_SCREEN],
      [600, 200, INNER_P],
      [700, 200, { screenWidthDp: 1400, screenHeightDp: 1300 }],
    ]);
    expect(five.seen.map((x) => x.w).sort()).toEqual([400, 500, 600, 700]);
    expect(MAX_SEEN).toBe(4);
  });

  it("넓은 모습: 접는 폰의 좁은 화면이면 없음 · 좁은 화면에서 본 적 있는 크기(폭 ≤ 그 화면)면 없음 · 두 화면을 보면 가장 좁은 폭까지 · 일반 폰은 그대로", () => {
    // 번호도 기억도 없는 위젯 (따로 놓은 바깥 위젯의 첫 그림)
    expect(frameOf(null, COVER_BOX, { foldable: true })).toEqual({ width: 507, height: 222, wideWidth: 0, fit: "wide" });
    expect(frameOf(null, COVER_BOX, { foldable: false })).toEqual({ width: 507, height: 222, fit: "none" });
    // 따로 놓은 바깥 위젯을 펼친 채 그림 (옵션은 바깥 칸 그대로)
    const sep = see(null, [[507, 222, COVER_SCREEN_2X], [507, 222, INNER_SCREEN_2X]]);
    expect(frameOf(sep, { ...COVER_BOX, screenInfo: INNER_SCREEN_2X }, { foldable: true })).toMatchObject({ wideWidth: 0 });
    // 안쪽에만 둔 넓은 위젯(780 — 바깥 화면 594 보다 넓다)을 접힌 채도 그렸다: 펼친 그림은 넓은 모습 그대로
    const wide = see(null, [[780, 350, COVER_SCREEN_2X], [780, 350, INNER_SCREEN_2X]]);
    expect(frameOf(wide, { width: 780, height: 350, screenInfo: INNER_SCREEN_2X }, { foldable: true })).toEqual({ width: 780, height: 350, fit: "none" });
    // 화면마다 런처 · 안쪽 780 · 바깥 507: 안쪽 그림의 넓은 모습은 바깥 폭까지
    const per = see(null, [[507, 222, COVER_SCREEN_2X, "resize"], [780, 350, INNER_SCREEN_2X, "resize"]]);
    expect(frameOf(per, { width: 780, height: 350, screenInfo: INNER_SCREEN_2X }, { foldable: true })).toEqual({ width: 780, height: 350, wideWidth: 507, fit: "wide" });
    // 일반 폰(넓은 화면을 본 적 없음)을 돌린 것: 그대로
    const phone = see(null, [[380, 220, PHONE_P], [700, 150, PHONE_L]]);
    expect(frameOf(phone, { width: 700, height: 150, screenInfo: PHONE_L }, { foldable: false })).toEqual({ width: 700, height: 150, fit: "none" });
  });

  it("두 화면에 들어가는 카드는 widgetFoldBoth 를 켤 때만, 그리고 ①로 보일 때만", () => {
    const range = see(null, [[476, 611, COVER_SCREEN_2X], [507, 222, INNER_SCREEN_2X]]);
    const folded = { width: 476, height: 611, screenInfo: COVER_SCREEN_2X };
    expect(frameOf(range, folded, { foldable: true })).toEqual({ width: 476, height: 611, wideWidth: 0, fit: "wide" });
    expect(frameOf(range, folded, { foldable: true, both: true })).toEqual({ width: 476, height: 222, wideWidth: 0, fit: "both" });
    const per = see(null, [[507, 222, COVER_SCREEN_2X, "resize"], [476, 611, INNER_SCREEN_2X, "resize"]]);
    expect(frameOf(per, { width: 476, height: 611, screenInfo: INNER_SCREEN_2X }, { foldable: true, both: true }).fit).not.toBe("both");
  });
});

describe("폴드8 크기: 바깥 화면에 보일 수 있는 그림에는 넓은 모습이 없다 (세 경우 × 바깥 4 × 안쪽 8 × 잔고·지수)", () => {
  const NAMES = [WIDGET_NAMES.holdings, WIDGET_NAMES.market];

  it("재현 (고치기 전 = 플래그 꺼짐): 캡처 실측 크기(바깥 507×222)에서 바깥 화면에 보이는 그림에 평가금액 칸이 있다", async () => {
    const cover = COVERS.find((c) => c.name === "바깥 4x2 캡처")!;
    const inner = INNERS.find((c) => c.name === "안쪽 캡처 잔고")!;
    for (const mode of MODES) {
      const x = instances(cover, inner, mode, 1)[0]!;
      // 바깥 화면에 보이는 그림: ①은 펼친 채 그린 것(507×222), ②③은 바깥 칸 그대로(507×222)
      const c = await foldCycle(WIDGET_NAMES.holdings, data(false), x);
      expect(extras(mode === "range" ? c.l : c.p).value, mode).toBe(true);
    }
  });

  it("고친 뒤: 캡처 실측 크기 — 세 경우 모두 바깥 화면에 보일 수 있는 그림에 평가금액 칸이 없고, 그림은 칸 크기 그대로", async () => {
    const cover = COVERS.find((c) => c.name === "바깥 4x2 캡처")!;
    const inner = INNERS.find((c) => c.name === "안쪽 캡처 잔고")!;
    for (const [n, mode] of MODES.entries()) {
      for (const x of instances(cover, inner, mode, 10 + n)) {
        const { p, l } = await foldCycle(WIDGET_NAMES.holdings, data(true), x);
        if (x.shows.includes("cover")) {
          expect(extras(p).value, `${mode} 접어 그림`).toBe(false);
          expect(extras(l).value, `${mode} 펴서 그림`).toBe(false);
        }
        expect(card(p, x.p), mode).toEqual({ width: x.p.width, height: x.p.height });
        expect(card(l, x.l), mode).toEqual({ width: x.l.width, height: x.l.height });
      }
    }
  });

  it("매트릭스: 바깥 화면에 보일 수 있는 그림은 넓은 모습 없음(그림 폭이 바깥 화면보다 넓으면 가장 좁은 폭까지), 안쪽에만 보이는 위젯은 제 폭대로, 카드는 늘 칸 크기", async () => {
    let id = 100;
    let checked = 0;
    for (const cover of COVERS)
      for (const inner of INNERS)
        for (const mode of MODES)
          for (const name of NAMES) {
            store.clear();
            const coverSw = shortSide(cover.screen)!;
            for (const x of instances(cover, inner, mode, id++)) {
              const { p, l } = await foldCycle(name, data(true), x);
              const label = `${name} ${cover.name} ${cover.width}×${cover.height} · ${inner.name} ${inner.width}×${inner.height} · ${mode} · ${x.shows.join("+")}`;
              // 바깥 화면(좁은 화면)이 켜져 있을 때 그린 그림: 늘 넓은 모습 없음
              expect(extras(p), `${label} 접어 그림`).toEqual(NONE);
              // 펼친 채 그린 그림
              const e = extras(l);
              const w = x.l.width;
              if (x.shows.includes("cover") && w <= coverSw) expect(e, `${label} 펴서 그림 (바깥에 보임)`).toEqual(NONE);
              else {
                const ok = allows(mode === "separate" ? w : Math.min(cover.width, inner.width));
                if (e.value) expect(ok.value, `${label} 평가금액`).toBe(true);
                if (e.twoColumns) expect(ok.twoColumns, `${label} 두 열`).toBe(true);
                if (e.boardWide) expect(ok.boardWide, `${label} 지수 옆 칸`).toBe(true);
              }
              expect(card(p, x.p), `${label} 카드`).toEqual({ width: x.p.width, height: x.p.height });
              expect(card(l, x.l), `${label} 카드`).toEqual({ width: x.l.width, height: x.l.height });
              checked++;
            }
          }
    expect(checked).toBe(COVERS.length * INNERS.length * NAMES.length * 4); // range 1 + perScreen 1 + separate 2
  });

  it("안쪽에만 둔 넓은 위젯(6x3 780×350 — 바깥 화면보다 넓다)은 접힌 채 그려진 뒤에도 3-42 넓은 모습 그대로 (두 열·지수 옆 칸)", async () => {
    const only = instances(COVERS[3]!, INNERS[6]!, "separate", 40)[1]!;
    const h = await foldCycle(WIDGET_NAMES.holdings, data(true), only);
    expect(extras(h.l)).toMatchObject({ twoColumns: true });
    expect(h.l).toEqual(plainTree(WIDGET_NAMES.holdings, data(true), only.l));
    const m = await foldCycle(WIDGET_NAMES.market, data(true), { ...only, p: { ...only.p, widgetId: 41 }, l: { ...only.l, widgetId: 41 } });
    expect(extras(m.l).boardWide).toBe(true);
  });

  it("검증 지적: 안쪽에만 둔 위젯의 세로·가로 크기가 달라도(587×600 ↔ 777×352) 두 화면 카드로 줄이지 않는다 (widgetFoldBoth 꺼짐 — 칸을 다 씀)", async () => {
    const x: Instance = {
      p: { widgetId: 60, width: 587, height: 600, screenInfo: COVER_SCREEN_2X },
      l: { widgetId: 60, width: 777, height: 352, screenInfo: INNER_SCREEN_2X },
      by: "draw",
      shows: ["inner"],
    };
    const { l } = await foldCycle(WIDGET_NAMES.holdings, data(true), x);
    expect(card(l, x.l)).toEqual({ width: 777, height: 352 });
    expect(extras(l).twoColumns).toBe(false); // 두 열은 접었을 때 본 폭(587)까지
    // widgetFoldBoth 를 켜면 ①과 가릴 수 없어 587×352 카드 (칸의 76% — 문서의 남은 한계)
    store.clear();
    const both = await foldCycle(WIDGET_NAMES.holdings, data(true, true), x);
    expect(card(both.l, x.l)).toEqual({ width: 587, height: 352 });
  });

  it("widgetFoldBoth 켬 · ① 범위 런처: 카드는 두 화면에 모두 들어가고 남는 곳은 투명, 넓은 모습 없음", async () => {
    const x = instances(COVERS[2]!, INNERS[4]!, "range", 7)[0]!; // 바깥 460×290 · 안쪽 520×230
    const { p, l } = await foldCycle(WIDGET_NAMES.holdings, data(true, true), x);
    for (const t of [p, l]) {
      expect(t.props.backgroundColor).toBeUndefined();
      expect(t.children).toHaveLength(1);
      expect(card(t, x.p)).toEqual({ width: 460, height: 230 });
      expect(extras(t)).toEqual(NONE);
    }
    // 예전 가로 그림 520×230 에는 평가금액 칸이 있었다
    expect(extras(plainTree(WIDGET_NAMES.holdings, data(false), { width: 520, height: 230 })).value).toBe(true);
  });

  it("한 화면만 본 위젯 · 일반 폰을 돌린 것 · 태블릿 · 플래그 꺼짐: 지금 그림과 똑같다 (위젯 4종)", async () => {
    let id = 500;
    for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.market, WIDGET_NAMES.briefing, WIDGET_NAMES.asset]) {
      // 넓은 화면을 아직 못 본 기기에서 한 화면만 (예: 업데이트 직후 바깥 화면에서 처음 그림 — 접는 폰인지 아직 모름)
      for (const place of [...COVERS, ...INNERS]) {
        store.clear();
        const box: BoxInfo = { widgetId: id++, width: place.width, height: place.height, screenInfo: place.screen };
        const plain = plainTree(name, data(true), box);
        expect(tree(await renderFor(name, data(true), box, OPTS)), `${name} ${place.name}`).toEqual(plain);
        expect(tree(await renderFor(name, data(true), box, OPTS)), `${name} ${place.name} 두 번째`).toEqual(plain);
      }
      // 일반 폰: 세로 380×220 ↔ 가로 700×150 (같은 화면, 넓은 화면 없음 — 가로의 넓은 모습 그대로)
      store.clear();
      const p: BoxInfo = { widgetId: id, width: 380, height: 220, screenInfo: PHONE_P };
      const l: BoxInfo = { widgetId: id++, width: 700, height: 150, screenInfo: PHONE_L };
      for (let k = 0; k < 3; k++) {
        expect(tree(await renderFor(name, data(true), p, OPTS)), `${name} 폰 세로`).toEqual(plainTree(name, data(true), p));
        expect(tree(await renderFor(name, data(true), l, OPTS)), `${name} 폰 가로`).toEqual(plainTree(name, data(true), l));
      }
      // 태블릿: 늘 넓은 화면
      const tl: BoxInfo = { widgetId: id, width: 780, height: 350, screenInfo: TABLET_L };
      const tp: BoxInfo = { widgetId: id++, width: 600, height: 500, screenInfo: TABLET_P };
      for (let k = 0; k < 2; k++) {
        expect(tree(await renderFor(name, data(true), tl, OPTS)), `${name} 태블릿 가로`).toEqual(plainTree(name, data(true), tl));
        expect(tree(await renderFor(name, data(true), tp, OPTS)), `${name} 태블릿 세로`).toEqual(plainTree(name, data(true), tp));
      }
      // 플래그 꺼짐: 폴드 두 화면을 오가도 그대로
      for (const x of instances(COVERS[3]!, INNERS[4]!, "range", id++)) {
        const off = await foldCycle(name, data(false), x);
        expect(off.p, `${name} 꺼짐 세로`).toEqual(plainTree(name, data(false), x.p));
        expect(off.l, `${name} 꺼짐 가로`).toEqual(plainTree(name, data(false), x.l));
      }
    }
  });

  it("화면 읽기: 넓은 모습을 뺀 그림·두 화면 카드도 누르는 칸마다 이름표가 그대로 (자산 위젯 전체 칸 포함)", async () => {
    const x: Instance = {
      p: { widgetId: 900, width: 230, height: 110, screenInfo: COVER_SCREEN },
      l: { widgetId: 900, width: 260, height: 90, screenInfo: INNER_SCREEN },
      by: "draw",
      shows: ["cover", "inner"],
    };
    const { l } = await foldCycle(WIDGET_NAMES.asset, data(true, true), x);
    const plain = plainTree(WIDGET_NAMES.asset, data(true), { width: 230, height: 90 });
    const labels = (t: Tree) => nodes(t).filter((n) => n.props.clickAction).map((n) => n.props.accessibilityLabel);
    expect(labels(l)).toEqual(labels(plain));
    expect(labels(l).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
    // 위젯 전체 설명(맨 바깥 칸의 이름표)도 감싼 칸으로 옮긴다
    expect(card(l, x.l)).toEqual({ width: 230, height: 90 });
    expect(l.props.accessibilityLabel).toBe(plain.props.accessibilityLabel);
    const cap = instances(COVERS[3]!, INNERS[2]!, "perScreen", 901)[0]!;
    const h = await foldCycle(WIDGET_NAMES.holdings, data(true), cap);
    expect(labels(h.p).length).toBeGreaterThan(3);
    expect(labels(h.p).every((v) => typeof v === "string" && v.length > 0)).toBe(true);
  });
});

describe("저장 (위젯마다·기기 AsyncStorage) · 플래그 · 태스크 핸들러", () => {
  const P_BOX: BoxInfo = { widgetId: 5, width: 435, height: 290, screenInfo: COVER_SCREEN };
  const L_BOX: BoxInfo = { widgetId: 5, width: 460, height: 200, screenInfo: INNER_SCREEN };
  const memo = (id: number) => JSON.parse(store.get(`widget.frame.${id}`)!) as FrameMemo;
  const info = (b: BoxInfo) => ({ widgetName: WIDGET_NAMES.holdings, ...b, screenInfo: { ...b.screenInfo, density: 2.1, densityDpi: 336 } });
  const handle = (b: BoxInfo, widgetAction: string) => widgetTaskHandler({ widgetInfo: info(b), widgetAction, renderWidget: () => undefined } as never);

  it("플래그가 꺼져 있으면 읽지도 적지도 않고 지금 크기 그대로", async () => {
    expect(await frameFor(P_BOX, { fit: false })).toEqual({ width: 435, height: 290, fit: "none", outerWidth: 435, outerHeight: 290 });
    expect(await frameFor(L_BOX, { fit: false, both: true })).toEqual({ width: 460, height: 200, fit: "none", outerWidth: 460, outerHeight: 200 });
    expect(io.reads + io.writes).toBe(0);
    expect(store.size).toBe(0);
  });

  it("켜져 있으면 위젯마다·기기에 적고, 같으면 다시 적지 않는다 (한 시간에 한 번만 본 시각을 새로)", async () => {
    await frameFor(P_BOX, { fit: true }, 0);
    // 펼친 그림(460)도 바깥 화면(475)에 들어가는 폭이라 넓은 모습 없음 (같은 위젯이 바깥에도 보일 수 있다)
    expect(await frameFor(L_BOX, { fit: true }, 1_000)).toEqual({ width: 460, height: 200, wideWidth: 0, fit: "wide", outerWidth: 460, outerHeight: 200 });
    expect(JSON.parse(store.get(DEVICE_KEY)!)).toEqual({ big: 1_000 });
    const writes = io.writes;
    await frameFor(L_BOX, { fit: true }, 2_000);
    await frameFor(P_BOX, { fit: true }, 3_000);
    expect(io.writes).toBe(writes);
    await frameFor(P_BOX, { fit: true }, 3_600_000 + 5_000);
    expect(io.writes).toBe(writes + 1);
    // 다른 위젯은 따로 — 다만 기기는 이제 접는 폰이라 바깥 화면 그림에는 넓은 모습이 없다
    expect(await frameFor({ ...P_BOX, widgetId: 6 }, { fit: true }, 3_600_000 + 6_000)).toMatchObject({ fit: "wide", wideWidth: 0 });
    // 번호를 모르는 위젯도 기기 규칙은 쓴다
    expect(await frameFor({ ...P_BOX, widgetId: undefined }, { fit: true }, 3_600_000 + 7_000)).toMatchObject({ wideWidth: 0 });
  });

  it("깨졌거나 예전 모양으로 적힌 기억은 없는 것으로 본다", async () => {
    store.set("widget.frame.5", JSON.stringify({ p: { w: 435, h: 290, sw: 475, at: 0 } }));
    expect(await frameFor(L_BOX, { fit: true }, 1)).toMatchObject({ fit: "none" });
    store.clear();
    store.set("widget.frame.5", "{");
    store.set(DEVICE_KEY, "{");
    expect(await frameFor(L_BOX, { fit: true }, 2)).toMatchObject({ fit: "none" });
    store.set("widget.frame.5", JSON.stringify({ seen: [{ o: "x", w: 1, h: 1, sw: 1, at: 0 }, { o: "p", w: 435, h: 290, sw: 475, at: 0, t: "yes", r: "x" }] }));
    expect(await frameFor(L_BOX, { fit: true }, 3)).toMatchObject({ fit: "wide", wideWidth: 0 });
    expect(memo(5).seen.find((x) => x.o === "p")).toEqual({ o: "p", w: 435, h: 290, sw: 475, at: 0 });
  });

  it("고정 시계: renderFor 는 그리는 시각(now)으로 적는다 (기기 시계가 아니라)", async () => {
    vi.setSystemTime(NOW + 5 * 86_400_000);
    await renderFor(WIDGET_NAMES.holdings, data(true), P_BOX, OPTS);
    expect(memo(5)).toEqual({ seen: [{ o: "p", sw: 475, w: 435, h: 290, at: NOW }] });
    await renderFor(WIDGET_NAMES.holdings, data(true), L_BOX, OPTS);
    expect(JSON.parse(store.get(DEVICE_KEY)!)).toEqual({ big: NOW });
  });

  it("태스크 핸들러: 크기 변경 알림·추가만 런처 확인으로 적고, 같은 크기 알림은 '화면마다' 증거 — 주기 갱신은 기억한 크기를 바꾸지 않는다", async () => {
    await saveWidgetView(data(true), "https://server.test");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    const cover: BoxInfo = { widgetId: 8, width: 507, height: 222, screenInfo: COVER_SCREEN_2X };
    const inner: BoxInfo = { widgetId: 8, width: 476, height: 611, screenInfo: INNER_SCREEN_2X };
    await handle(inner, "WIDGET_ADDED");
    await handle(cover, "WIDGET_RESIZED");
    expect(memo(8).seen.map((x) => [x.o, x.t, x.r])).toEqual([
      ["l", 1, undefined],
      ["p", 1, NOW],
    ]);
    // 접은 채 옛 옵션(476×611)으로 주기 갱신 — 바깥 줄을 바꾸지 않는다
    await handle({ ...inner, screenInfo: COVER_SCREEN_2X }, "WIDGET_UPDATE");
    expect(memo(8).seen.find((x) => x.o === "p")).toMatchObject({ w: 507, h: 222 });
    vi.setSystemTime(NOW + 60_000);
    await handle(inner, "WIDGET_RESIZED");
    expect(launcherOf(memo(8))).toBe("perScreen");
  });

  it("검증 지적 재현: 태스크 핸들러와 앱 즉시 갱신이 같은 위젯을 한꺼번에 그려도 서로 적은 것을 덮지 않는다", async () => {
    const a: BoxInfo = { widgetId: 12, width: 507, height: 222, screenInfo: COVER_SCREEN_2X };
    const b: BoxInfo = { widgetId: 12, width: 476, height: 611, screenInfo: INNER_SCREEN_2X };
    await Promise.all([frameFor(a, { fit: true }, 1, "resize"), frameFor(b, { fit: true }, 2, "draw"), frameFor(a, { fit: true }, 3, "draw")]);
    expect(memo(12).seen.map((x) => `${x.o}:${x.w}x${x.h}:${x.t ?? 0}`).sort()).toEqual(["l:476x611:0", "p:507x222:1"]);
  });

  it("위젯을 지우면(WIDGET_DELETED) 그 위젯의 기억도 지운다 (기기 기억은 남김)", async () => {
    await frameFor(L_BOX, { fit: true }, 0);
    await frameFor({ ...L_BOX, widgetId: 9 }, { fit: true }, 0);
    expect([...store.keys()].sort()).toEqual(["widget.frame.5", "widget.frame.9", DEVICE_KEY].sort());
    await widgetTaskHandler({ widgetInfo: { widgetName: WIDGET_NAMES.holdings, widgetId: 5, width: 0, height: 0, screenInfo: {} }, widgetAction: "WIDGET_DELETED", renderWidget: () => undefined } as never);
    expect([...store.keys()].sort()).toEqual(["widget.frame.9", DEVICE_KEY].sort());
    await forgetFrame(9);
    expect([...store.keys()]).toEqual([DEVICE_KEY]);
  });

  it("앱 즉시 갱신이 바깥 화면에서 그린 잔고 그림에도 넓은 모습이 없다 (접는 폰 · 따로 놓은 바깥 위젯 — 캡처 크기)", async () => {
    foldable();
    const box: BoxInfo = { widgetId: 70, width: 507, height: 222, screenInfo: COVER_SCREEN_2X };
    const t = tree(await renderFor(WIDGET_NAMES.holdings, data(true), box, OPTS));
    expect(extras(t)).toEqual(NONE);
    const before = plainTree(WIDGET_NAMES.holdings, data(true), box);
    expect(extras(before).value).toBe(true);
    // 넓은 모습만 빠지고 칸 크기·제목은 그대로
    expect(card(t, box)).toEqual({ width: 507, height: 222 });
    expect(texts(t)[0]).toBe(texts(before)[0]);
  });
});

describe("설정 '화면 정보' 공유 글의 위젯 진단 (widgets/diagnose.ts)", () => {
  it("위젯 수·번호·지금 크기·화면·밀도와 크기 기억, 판단을 한 줄씩 (고정 시계)", () => {
    const m: FrameMemo = {
      seen: [
        { o: "p", sw: 594, w: 507, h: 222, at: NOW - 5 * 60_000, t: 1, r: NOW - 5 * 60_000 },
        { o: "l", sw: 880, w: 476, h: 611, at: NOW - 2 * 3_600_000, t: 1, r: NOW - 2 * 3_600_000 },
      ],
    };
    const lines = widgetReportLines(
      [
        { name: WIDGET_NAMES.holdings, widgetId: 12, width: 476, height: 611, screenInfo: { ...INNER_SCREEN_2X, density: 2.1 }, memo: m },
        { name: WIDGET_NAMES.market, widgetId: 13, width: 507, height: 222, screenInfo: COVER_SCREEN_2X, memo: null },
      ],
      { big: NOW - 30_000 },
      NOW,
    );
    expect(lines).toEqual([
      "[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 1개",
      "[위젯] 넓은 화면(짧은 변 600dp 이상)을 본 때: 방금",
      "[위젯] 잔고 #12: 지금 476×611dp (화면 1166×880 · 밀도 2.1) · 기억 좁은 화면(594) 세로 507×222 런처 확인 · 같은 크기 알림 5분 전 · 5분 전 / 넓은 화면(880) 가로 476×611 런처 확인 · 같은 크기 알림 2시간 전 · 2시간 전 · 판단 화면마다 다시 그림(②)",
      "[위젯] 지수·환율 #13: 지금 507×222dp (화면 594×939) · 기억 없음",
    ]);
  });

  it("홈 화면 위젯을 읽어 만든다 — 같은 이름이 둘이면(두 화면에 따로 놓음) 둘 다 적는다", async () => {
    shared.widgets = {
      [WIDGET_NAMES.holdings]: [
        { widgetId: 21, width: 507, height: 222, screenInfo: COVER_SCREEN_2X },
        { widgetId: 22, width: 476, height: 611, screenInfo: COVER_SCREEN_2X },
      ],
    };
    store.set("widget.frame.21", JSON.stringify({ seen: [{ o: "p", sw: 594, w: 507, h: 222, at: NOW - 3 * 86_400_000 }] }));
    const lines = await widgetReport(NOW);
    expect(lines[0]).toBe("[위젯] 잔고 2개 · 자산 0개 · 브리핑 0개 · 지수·환율 0개");
    expect(lines[1]).toBe("[위젯] 넓은 화면(짧은 변 600dp 이상)을 본 때: 없음");
    expect(lines[2]).toBe("[위젯] 잔고 #21: 지금 507×222dp (화면 594×939) · 기억 좁은 화면(594) 세로 507×222 · 3일 전 · 판단 한 화면에서만 봄");
    expect(lines[3]).toBe("[위젯] 잔고 #22: 지금 476×611dp (화면 594×939) · 기억 없음");
  });
});
