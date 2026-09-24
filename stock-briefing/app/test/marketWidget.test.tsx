import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contrast } from "@/lib/color";
import { dark, light } from "@/tokens";

/**
 * 지수·환율 위젯 (APK 1.4.0, 플래그 widgetMarket). 라이브러리의 실제 트리 빌더(buildWidgetTree)로 그려 본다.
 *  - 4×2 · 4×4 × 라이트·다크: 칸 수·순서, 값·등락 표기(앱 지수 띠와 같음), 색(등락·장중 점·지연), 카드 바탕(그라데이션·테두리)
 *  - 플래그 꺼짐·모름, 갱신 실패(마지막 값), 3시간 넘게 못 받음, ↻ "갱신 중", 누르면 가는 곳, 화면 읽기 문장
 *  - 데이터: 서버 판(&board=1), 앱 지수 띠, 재사용·마지막 값 유지, 태스크 핸들러·앱 즉시 갱신
 */

const lib = (p: string) => import(/* @vite-ignore */ p);
const shared = vi.hoisted(() => ({
  fontScale: 1,
  widgets: {} as Record<string, { width: number; height: number }[]>,
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
    getWidgetInfo: async (name: string) => (shared.widgets[name] ?? []).map((box, n) => ({ widgetName: name, widgetId: n + 1, ...box, screenInfo: {} })),
    requestWidgetUpdate: async ({ widgetName, renderWidget }: { widgetName: string; renderWidget: (i: unknown) => unknown }) => {
      for (const box of shared.widgets[widgetName] ?? []) {
        shared.updates.push({ widgetName, rendered: await renderWidget({ widgetName, widgetId: 1, ...box, screenInfo: {} }) });
      }
    },
  };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" }, PixelRatio: { getFontScale: () => shared.fontScale } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { buildWidgetTree } = await lib("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { WIDGET_NAMES } = await import("@/widgets/widgets");
const { MarketWidget, MARKET_EMPTY_TEXT, MARKET_OFF_TEXT } = await import("@/widgets/marketWidget");
const { renderBoth } = await import("@/widgets/render");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { marketWidgetPlaced, refreshWidgets } = await import("@/widgets/refresh");
const { loadCachedWidgetData, loadWidgetData } = await import("@/widgets/data");
const { fromPayload, pickBoard, widgetFeatures, WIDGET_BOARD_CODES } = await import("@/widgets/payload");
const { BOARD_CODES, BOARD_SECTIONS, boardChanges, boardTiles, marketUri } = await import("@/widgets/board");
const { HOME_URI } = await import("@/widgets/model");
const { WIDGET_BOARD, WIDGET_FONT, WIDGET_PALETTES, WIDGET_TOUCH } = await import("@/widgets/palette");
const { MARKER_GAP, planMarket } = await import("@/widgets/layout");
const { boardColumns, BOARD_TITLE } = await import("@/widgets/board");
const { formatIndexValue, formatPct } = await import("@/lib/format");

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string; color?: string; clickAction?: string; accessibilityLabel?: string; width?: number; height?: number; backgroundColor?: string };
  children?: Tree[];
}
const build = (el: React.JSX.Element): Tree => buildWidgetTree(el) as Tree;
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const texts = (t: Tree) => nodes(t).filter((n) => n.type === "TextWidget").map((n) => n.props);
const words = (t: Tree) => texts(t).map((p) => String(p.text));
const byClick = (t: Tree, action: string) => nodes(t).filter((n) => n.props.clickAction === action);
/** 지수·환율 칸 (누르면 차트 화면) */
const tiles = (t: Tree) => byClick(t, "OPEN_URI").filter((n) => String((n.props.clickActionData as { uri?: string } | undefined)?.uri ?? "").startsWith(`${HOME_URI}market/`));
const tileCodes = (t: Tree) => tiles(t).map((n) => String((n.props.clickActionData as { uri: string }).uri).slice(`${HOME_URI}market/`.length));
const tileOf = (t: Tree, code: string) => tiles(t).find((n) => (n.props.clickActionData as { uri: string }).uri === marketUri(code))!;
const colorOf = (t: Tree, text: string) => texts(t).find((p) => p.text === text)?.color;

const NOW = Date.parse("2026-09-24T14:40:00+09:00");
const AT = NOW - 40_000;
const API = "https://server.test";
const S42 = { width: 330, height: 160 };
/** 4×3 (100% 에서 흔한 3칸 높이) */
const S43 = { width: 330, height: 250 };
const S44 = { width: 330, height: 330 };

/** 서버 board 와 같은 모양: 코스피·코스닥 장중, 필라반도체 지연(출처 실패), 환율은 장중 점 없음 */
const BOARD = [
  { code: "KOSPI", name: "코스피", value: 7080.92, change: 63.01, changeRate: 0.9, open: true },
  { code: "KOSDAQ", name: "코스닥", value: 862.15, change: -3.2, changeRate: -0.37, open: true },
  { code: "NASDAQ", name: "나스닥", value: 26936.04, change: -308.24, changeRate: -1.13, open: false },
  { code: "SPX", name: "S&P500", value: 6650.12, change: 12.4, changeRate: 0.19, open: false },
  { code: "DJI", name: "다우", value: 46315.27, change: 0, changeRate: 0, open: false },
  { code: "SOX", name: "필라반도체", value: 7123.45, change: 88.1, changeRate: 1.25, open: false, stale: true },
  { code: "USDKRW", name: "원/달러", value: 1360.5, change: -2.1, changeRate: -0.15, open: true },
  { code: "JPYKRW", name: "원/100엔", value: 930.12, change: 1.35, changeRate: 0.15, open: true },
  { code: "CNYKRW", name: "원/위안", value: 190.55, change: -0.12, changeRate: -0.06, open: true },
];
const FEATURES = { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true };
const payload = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  market: { label: "한국 장중", open: true, nextChangeAt: "2026-09-24T06:30:00Z", kr: true, us: false },
  stocks: [{ c: "005930", n: "삼성전자", qty: 10, avg: 80_000, q: [70_000, 100, 1.5, "KRW", "2026-09-24T14:39:00+09:00", null, 0] as [number, number, number, "KRW", string, null, 0], e: [700_000, 800_000, null, null, null] as [number, number, null, null, null] }],
  briefings: [],
  latestIds: [],
  features: FEATURES,
  indices: [BOARD[0], BOARD[2], BOARD[6]],
  board: BOARD,
  ...over,
});
const market = (over: Record<string, unknown> = {}, box = S44, scheme: "light" | "dark" = "dark") =>
  build(<MarketWidget board={BOARD} boardAt={AT} enabled error={null} now={NOW} {...box} fontScale={1} palette={WIDGET_PALETTES[scheme]} {...over} />);

beforeEach(() => {
  store.clear();
  shared.fontScale = 1;
  shared.widgets = {};
  shared.updates = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("항목·표기 (앱 지수 띠와 같다)", () => {
  it("구역과 순서: 국내(코스피·코스닥) · 미국(나스닥·S&P500·다우·필라반도체) · 환율(원/달러·원/100엔·원/위안), 서버 순서와 같다", () => {
    expect(BOARD_SECTIONS.map((s) => [s.label, [...s.codes]])).toEqual([
      ["국내", ["KOSPI", "KOSDAQ"]],
      ["미국", ["NASDAQ", "SPX", "DJI", "SOX"]],
      ["환율", ["USDKRW", "JPYKRW", "CNYKRW"]],
    ]);
    expect([...BOARD_CODES]).toEqual([...WIDGET_BOARD_CODES]);
    expect(boardTiles(BOARD).map((t) => t.label)).toEqual(["코스피", "코스닥", "나스닥", "S&P500", "다우", "필라반도체", "원/달러", "원/100엔", "원/위안"]);
  });

  it("값·등락은 MarketStrip 과 같은 함수: 값 formatIndexValue, 등락 '▲63.01 +0.90%' (환율도 같은 표기)", () => {
    const t = boardTiles(BOARD);
    for (const i of BOARD) {
      const tile = t.find((x) => x.code === i.code)!;
      expect(tile.value).toBe(formatIndexValue(i.value));
      const arrow = i.change > 0 ? "▲" : i.change < 0 ? "▼" : "";
      expect(tile.changes).toEqual([`${arrow}${formatIndexValue(Math.abs(i.change))} ${formatPct(i.changeRate)}`, formatPct(i.changeRate)]);
    }
    expect(boardChanges(-308.24, -1.13)).toEqual(["▼308.24 -1.13%", "-1.13%"]);
    expect(boardChanges(0, 0)).toEqual(["0.00 0.00%", "0.00%"]);
    // 앱 지수 띠도 같은 두 함수를 쓴다 (한쪽만 바꾸면 이 테스트가 깨진다)
    const strip = readFileSync(new URL("../src/components/MarketStrip.tsx", import.meta.url), "utf8");
    expect(strip).toMatch(/import \{ formatIndexValue, formatPct \} from "@\/lib\/format"/);
    expect(strip).toContain('{i.change > 0 ? "▲" : i.change < 0 ? "▼" : ""}');
    expect(strip).toContain("{formatIndexValue(Math.abs(i.change))} {formatPct(i.changeRate)}");
  });

  it("장중 점은 출처에서 장중을 확인한 지수만 (환율·지연·장 마감은 없음), 받지 못한 항목은 '-' 칸으로 자리를 지킨다", () => {
    const t = boardTiles(BOARD.filter((i) => i.code !== "CNYKRW"));
    expect(t.filter((x) => x.live).map((x) => x.code)).toEqual(["KOSPI", "KOSDAQ"]);
    expect(t.find((x) => x.code === "SOX")).toMatchObject({ stale: true, live: false });
    expect(t.find((x) => x.code === "CNYKRW")).toMatchObject({ has: false, value: "-", changes: [], speech: "원/위안 시세 없음" });
  });

  it("화면 읽기: '코스피 7,080.92, 0.90% 상승, 장중' · '필라반도체 7,123.45, 1.25% 상승, 시세 지연' · 보합", () => {
    const t = boardTiles(BOARD);
    expect(t[0]!.speech).toBe("코스피 7,080.92, 0.90% 상승, 장중");
    expect(t.find((x) => x.code === "NASDAQ")!.speech).toBe("나스닥 26,936.04, 1.13% 하락");
    expect(t.find((x) => x.code === "SOX")!.speech).toBe("필라반도체 7,123.45, 1.25% 상승, 시세 지연");
    expect(t.find((x) => x.code === "DJI")!.speech).toBe("다우 46,315.27, 보합");
    expect(t.find((x) => x.code === "USDKRW")!.speech).toBe("원/달러 1,360.50, 0.15% 하락");
  });
});

describe("4×2 · 4×4 × 라이트 · 다크", () => {
  for (const scheme of ["dark", "light"] as const) {
    const c = scheme === "dark" ? dark : light;
    it(`${scheme} 4×2 (330×160): 코스피·코스닥·나스닥·S&P500·원/달러·원/100엔 6칸 (구역마다 세로로 2칸)`, () => {
      const t = market({}, S42, scheme);
      expect(tileCodes(t)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "USDKRW", "JPYKRW"]);
      // 가로로 세 구역 (국내 | 미국 | 환율), 구역 사이는 머리카락 구분선
      const body = t.children![1]!;
      expect(body.children).toHaveLength(3);
      expect(body.children!.map((col) => (col.props.borderWidth as { left: number } | undefined)?.left ?? 0)).toEqual([0, 1, 1]);
      // 흔한 4×2: 두 줄 칸 — 이름 ··· 등락률(색) / 큰 값
      expect(words(tileOf(t, "KOSPI"))).toEqual(["코스피", "+0.90%", "7,080.92"]);
      expect(colorOf(t, "+0.90%")).toBe(c.up);
      expect(colorOf(t, "-1.13%")).toBe(c.down);
      expect(colorOf(t, "7,080.92")).toBe(c.up);
      expect(colorOf(t, "26,936.04")).toBe(c.down);
      // 값은 제목(13sp)보다 크게
      expect(texts(t).find((p) => p.text === "7,080.92")!.fontSize).toBeGreaterThan(WIDGET_FONT.title);
    });

    it(`${scheme} 4×3 (330×250): 9칸 모두 이름 줄 오른쪽에 ▲/▼ 부호 있는 등락률(색), 지연 칸은 그 자리에 '지연', 구역 이름과 큰 값`, () => {
      const t = market({}, S43, scheme);
      expect(tileCodes(t)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "USDKRW", "JPYKRW", "CNYKRW"]);
      for (const label of ["국내", "미국", "환율"]) expect(colorOf(t, label)).toBe(c.gold);
      for (const i of BOARD) {
        const tile = tileOf(t, i.code);
        const value = formatIndexValue(i.value);
        if (i.stale) {
          expect(words(tile)).toEqual([i.name, "지연", value]);
          expect(colorOf(tile, "지연")).toBe(c.warn);
          expect(colorOf(tile, value)).toBe(c.muted);
        } else {
          const rate = formatPct(i.changeRate);
          expect(words(tile)).toEqual([i.name, rate, value]);
          expect(colorOf(tile, rate)).toBe(i.change > 0 ? c.up : i.change < 0 ? c.down : c.ink);
        }
      }
      expect(texts(t).find((p) => p.text === "7,080.92")!.fontSize).toBeGreaterThan(WIDGET_FONT.title);
    });

    it(`${scheme} 4×4 (330×330): 9칸 모두, 구역 이름(금색)·등락 줄, 색은 앱 테마 값`, () => {
      const t = market({}, S44, scheme);
      expect(tileCodes(t)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "USDKRW", "JPYKRW", "CNYKRW"]);
      for (const label of ["국내", "미국", "환율"]) expect(colorOf(t, label)).toBe(c.gold);
      expect(colorOf(t, "7,080.92")).toBe(c.up);
      expect(colorOf(t, "▲63.01 +0.90%")).toBe(c.up);
      expect(colorOf(t, "1,360.50")).toBe(c.down);
      expect(colorOf(t, "▼2.10 -0.15%")).toBe(c.down);
      // 보합은 기본 글자색
      expect(colorOf(t, "46,315.27")).toBe(c.ink);
      // 이름은 보조 글자, 제목은 기본 글자
      expect(colorOf(t, "코스피")).toBe(c.sub);
      expect(colorOf(t, "지수·환율")).toBe(c.ink);
    });
  }

  it("카드: 다크는 패널색 → 화면 바탕색 비스듬한 그라데이션, 라이트는 흰 카드에 얇은 테두리, 넉넉한 모서리", () => {
    const d = market({}, S42, "dark");
    expect(d.props.backgroundColor).toBe(dark.surface);
    expect(d.props.backgroundGradient).toEqual({ from: dark.surface, to: dark.bg, orientation: "TL_BR" });
    const l = market({}, S42, "light");
    expect(l.props.backgroundColor).toBe(light.surface);
    expect(l.props.backgroundGradient).toBeUndefined();
    expect(l.props.borderWidth).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    expect((l.props.borderColor as { top: string }).top).toBe(light.line);
    for (const t of [d, l]) expect(t.props.borderRadius).toEqual({ topLeft: WIDGET_BOARD.radius, topRight: WIDGET_BOARD.radius, bottomLeft: WIDGET_BOARD.radius, bottomRight: WIDGET_BOARD.radius });
    // 제목 앞 금색 막대
    const mark = nodes(d).find((n) => n.props.width === WIDGET_BOARD.mark.width && n.props.height === WIDGET_BOARD.mark.height)!;
    expect(mark.props.backgroundColor).toBe(dark.gold);
  });

  it("이름은 글자 폭대로(칸 폭을 주지 않음): 장중 점·'지연'이 이름 바로 뒤(4dp)에 붙는다, 구역 폭은 배치대로", () => {
    for (const box of [S42, S43, S44]) {
      const t = market({}, box);
      // 4×2 에는 필라반도체(지연)가 없다
      for (const code of box === S42 ? ["KOSPI"] : ["KOSPI", "SOX"]) {
        const name = texts(tileOf(t, code))[0]!;
        expect(name.width).toBeUndefined();
      }
      const dot = nodes(tileOf(t, "KOSPI")).find((n) => n.props.width === WIDGET_BOARD.dot)!;
      expect((dot.props.margin as { left: number }).left).toBe(MARKER_GAP);
      // 구역 칸 폭 = 배치의 글자 폭 + 구분선·양옆 여백
      const plan = planMarket({ ...box, scale: 1, title: BOARD_TITLE, sub: [], columns: boardColumns(boardTiles(BOARD)) });
      const cols = t.children![1]!.children!;
      expect(cols.map((col) => col.props.width)).toEqual(plan.columns.map((col, n) => col.width + (n ? 8 + 1 : 0) + (n < 2 ? 8 : 0)));
    }
  });

  it("좁거나 글자가 커서 등락률이 안 들어가면(330×250 · 130%) 오른쪽에 ▲/▼ 방향을 남긴다 (색만으로 읽지 않게)", () => {
    for (const scheme of ["dark", "light"] as const) {
      const c = WIDGET_PALETTES[scheme];
      const t = market({ fontScale: 1.3 }, S43, scheme);
      expect(tileCodes(t)).toHaveLength(9);
      expect(words(tileOf(t, "KOSPI"))).toEqual(["코스피", "▲", "7,080.92"]);
      expect(words(tileOf(t, "NASDAQ"))).toEqual(["나스닥", "▼", "26,936.04"]);
      expect(colorOf(tileOf(t, "KOSPI"), "▲")).toBe(c.up);
      expect(colorOf(tileOf(t, "NASDAQ"), "▼")).toBe(c.down);
      // 보합은 방향 없이, 지연은 '지연'(글자) 또는 경고색 점
      expect(words(tileOf(t, "DJI"))).toEqual(["다우", "46,315.27"]);
      const sox = tileOf(t, "SOX");
      expect(words(sox).includes("지연") || nodes(sox).some((n) => n.props.width === WIDGET_BOARD.dot && n.props.backgroundColor === c.warn)).toBe(true);
    }
  });

  it("장중 점은 초록(앱 live 색, 빨강 아님): 코스피·코스닥에만, 환율·지연 칸에는 없음", () => {
    for (const scheme of ["dark", "light"] as const) {
      const t = market({}, S44, scheme);
      const dots = nodes(t).filter((n) => n.props.width === WIDGET_BOARD.dot && n.props.height === WIDGET_BOARD.dot);
      expect(dots).toHaveLength(2);
      for (const dot of dots) {
        expect(dot.props.backgroundColor).toBe(WIDGET_PALETTES[scheme].live);
        expect(dot.props.backgroundColor).not.toBe(WIDGET_PALETTES[scheme].up);
      }
      expect(nodes(tileOf(t, "KOSPI")).some((n) => n.props.width === WIDGET_BOARD.dot)).toBe(true);
      expect(nodes(tileOf(t, "USDKRW")).some((n) => n.props.width === WIDGET_BOARD.dot)).toBe(false);
    }
  });

  it("출처가 실패한 칸: 마지막 값을 흐리게(회색) + '지연'(경고색), 장중으로 보이지 않게", () => {
    for (const scheme of ["dark", "light"] as const) {
      const c = WIDGET_PALETTES[scheme];
      const sox = tileOf(market({}, S44, scheme), "SOX");
      expect(words(sox)).toEqual(["필라반도체", "지연", "7,123.45", "▲88.10 +1.25%"]);
      expect(colorOf(sox, "7,123.45")).toBe(c.muted);
      expect(colorOf(sox, "▲88.10 +1.25%")).toBe(c.muted);
      expect(colorOf(sox, "지연")).toBe(c.warn);
      expect(sox.props.accessibilityLabel).toBe("필라반도체 7,123.45, 1.25% 상승, 시세 지연");
    }
  });

  it("누르면: 칸은 그 지수·환율 차트(market/[code]), 머리는 앱, ↻ 는 48dp 새로 고침", () => {
    const t = market();
    expect((tileOf(t, "KOSPI").props.clickActionData as { uri: string }).uri).toBe("stockbriefing://market/KOSPI");
    expect(tileOf(t, "KOSPI").props.accessibilityLabel).toBe("코스피 7,080.92, 0.90% 상승, 장중");
    const head = byClick(t, "OPEN_URI").find((n) => String(n.props.accessibilityLabel).startsWith("지수·환율"))!;
    expect(head.props.clickActionData).toEqual({ uri: HOME_URI });
    expect(head.props.accessibilityLabel).toBe("지수·환율, 14:39 기준");
    const r = byClick(t, "REFRESH");
    expect(r).toHaveLength(1);
    expect(r[0]!.props.width).toBeGreaterThanOrEqual(WIDGET_TOUCH);
    expect(r[0]!.props.height).toBeGreaterThanOrEqual(WIDGET_TOUCH);
    expect(r[0]!.props.accessibilityLabel).toBe("새로 고침");
  });

  it("↻ 직후 '갱신 중'(강조색)을 기준 시각 자리에", () => {
    const t = market({ refreshing: true });
    expect(colorOf(t, "갱신 중")).toBe(dark.accent);
    expect(words(t)).not.toContain("14:39 기준");
    expect(byClick(t, "REFRESH")[0]!.props.accessibilityLabel).toBe("갱신 중");
    expect(tileCodes(t)).toHaveLength(9); // 숫자는 그대로
  });

  it("라이트·다크 모든 글자색이 카드 바탕(그라데이션 두 끝 포함) 위에서 대비 4.5 이상", () => {
    const low: string[] = [];
    for (const scheme of ["dark", "light"] as const) {
      const p = WIDGET_PALETTES[scheme];
      const backs = [p.bg, ...(p.gradient ? [p.gradient.from, p.gradient.to] : [])];
      for (const over of [{}, { refreshing: true }, { error: "Network request failed" }, { enabled: false }])
        for (const box of [S42, S44])
          for (const t of texts(market(over, box, scheme)))
            for (const b of backs) if (contrast(String(t.color), b) < 4.5) low.push(`${scheme} ${t.text} ${t.color}/${b}`);
    }
    expect(low).toEqual([]);
  });

  it("숫자(값·등락) 글자에는 … 줄임이 없고 한 줄이다, 이름도 흔한 크기에서는 줄지 않는다 (4×2 최소·흔한 4×2·4×4 × 100·130%)", () => {
    const bad: string[] = [];
    const labels = new Set(boardTiles(BOARD).map((t) => t.label));
    for (const box of [{ width: 250, height: 110 }, S42, { width: 330, height: 180 }, { width: 250, height: 250 }, S44])
      for (const fontScale of [1, 1.3])
        for (const scheme of ["dark", "light"] as const)
          for (const p of texts(market({ fontScale }, box, scheme))) {
            const text = String(p.text);
            if (labels.has(text)) continue; // 이름은 아래에서 따로
            if (/\d/.test(text) && (p.truncate || p.maxLines !== 1)) bad.push(`${box.width}×${box.height}@${fontScale} ${text}`);
          }
    expect(bad).toEqual([]);
  });
});

describe("플래그·실패·오래된 값", () => {
  it("widgetMarket 이 꺼져 있거나 모르면(예전 서버) 값 대신 짧은 회색 안내 — 누르면 앱", () => {
    for (const box of [S42, S44, { width: 250, height: 110 }]) {
      const t = market({ enabled: false }, box);
      expect(tiles(t)).toHaveLength(0);
      expect(words(t)).toContain(MARKET_OFF_TEXT);
      expect(colorOf(t, MARKET_OFF_TEXT)).toBe(dark.muted);
      expect(byClick(t, "OPEN_URI").find((n) => n.props.accessibilityLabel === MARKET_OFF_TEXT)!.props.clickActionData).toEqual({ uri: HOME_URI });
    }
    // 예전 서버: features 에 widgetMarket 이 없다 → 꺼짐
    expect(fromPayload(payload({ features: { widgetPnlToggle: true, widgetIndexLine: true }, board: undefined })).features.market).toBe(false);
    expect(fromPayload(payload({ features: undefined })).features.market).toBe(false);
    expect(widgetFeatures({ widgetMarket: true }).market).toBe(true);
    // 사용자 문구에 개발 용어가 없다
    expect(MARKET_OFF_TEXT).not.toMatch(/flag|플래그|서버|API/i);
  });

  it("갱신 실패: 마지막 값을 그대로 두고 머리에 '갱신 실패 · 연결 안 됨'", () => {
    const t = market({ error: "Network request failed" });
    expect(tileCodes(t)).toHaveLength(9);
    expect(words(t)).toContain("7,080.92");
    expect(words(t)).toContain("갱신 실패 · 연결 안 됨");
    expect(words(t)).not.toContain("14:39 기준");
  });

  it("한 번도 못 받았으면 '불러오지 못했습니다 · ↻' 안내, 갱신 중에는 비운다", () => {
    const t = market({ board: null, boardAt: null, error: "Network request failed" });
    expect(tiles(t)).toHaveLength(0);
    expect(words(t)).toContain(MARKET_EMPTY_TEXT);
    const busy = market({ board: null, boardAt: null, refreshing: true });
    expect(words(busy)).not.toContain(MARKET_EMPTY_TEXT);
    expect(words(busy)).toContain("갱신 중");
  });

  it("판을 받은 지 3시간(서버 지연 한도)이 넘으면 모든 칸을 '지연'(회색)으로", () => {
    const d = { ...fromPayload(payload()), showKrw: false, afterCost: false, fetchedAt: NOW, error: null, filled: [] };
    const old = build(renderBoth(WIDGET_NAMES.market, { ...d, boardAt: NOW - 3 * 3_600_000 - 60_000 }, { ...S44, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark);
    expect(words(old).filter((w) => w === "지연")).toHaveLength(9);
    expect(colorOf(old, "7,080.92")).toBe(dark.muted);
    expect(nodes(old).some((n) => n.props.width === WIDGET_BOARD.dot)).toBe(false);
    const fresh = build(renderBoth(WIDGET_NAMES.market, { ...d, boardAt: NOW - 60 * 60_000 }, { ...S44, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark);
    expect(words(fresh).filter((w) => w === "지연")).toHaveLength(1); // 서버가 준 필라반도체만
  });
});

describe("데이터: 서버 판(&board=1) · 앱 지수 띠 · 마지막 값", () => {
  const info = (box = S44) => ({ widgetName: WIDGET_NAMES.market, widgetId: 5, ...box, screenInfo: { screenHeightDp: 800, screenWidthDp: 400, density: 3, densityDpi: 480 } });
  const run = async (props: Record<string, unknown>) => {
    const rendered: { light: React.JSX.Element; dark: React.JSX.Element }[] = [];
    await widgetTaskHandler({ widgetInfo: info(), renderWidget: (r: unknown) => void rendered.push(r as { light: React.JSX.Element; dark: React.JSX.Element }), ...props } as never);
    return rendered;
  };
  const serve = (body: unknown = payload()) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"b1"' } });
    });
    return urls;
  };
  const down = () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      throw new TypeError("Network request failed");
    });
    return urls;
  };

  it("지수·환율 위젯을 추가하면 판을 함께 묻고(&board=1) 두 벌로 그린다", async () => {
    const urls = serve();
    const r = await run({ widgetAction: "WIDGET_ADDED" });
    expect(urls).toEqual([`${API}/api/widget?indices=1&board=1`]);
    expect(tileCodes(build(r[0]!.dark))).toHaveLength(9);
    expect(build(r[0]!.light).props.backgroundColor).toBe(light.surface);
    expect(words(build(r[0]!.dark))).toContain("14:40 기준");
  });

  it("↻: 저장해 둔 값으로 '갱신 중'을 먼저, 받은 판으로 다시. 실패하면 마지막 값 + '갱신 실패 · 연결 안 됨'", async () => {
    serve();
    await run({ widgetAction: "WIDGET_ADDED" });
    const next = payload({ board: BOARD.map((i) => (i.code === "KOSPI" ? { ...i, value: 7100 } : i)) });
    serve(next);
    const r = await run({ widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    expect(r).toHaveLength(2);
    expect(words(build(r[0]!.dark))).toContain("갱신 중");
    expect(words(build(r[0]!.dark))).toContain("7,080.92");
    expect(words(build(r[1]!.dark))).toContain("7,100.00");
    down();
    const failed = await run({ widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    const last = words(build(failed[1]!.dark));
    expect(last).toContain("7,100.00");
    expect(last).toContain("갱신 실패 · 연결 안 됨");
  });

  it("주기 갱신: 받아 둔 응답에 판이 있으면 다시 쓰고(서버 호출 0), 다른 위젯이 판 없이 받아 둔 응답이면 판을 묻는다", async () => {
    serve();
    await run({ widgetAction: "WIDGET_ADDED" });
    const calls = serve();
    await run({ widgetAction: "WIDGET_UPDATE" });
    expect(calls).toEqual([]);
    // 잔고 위젯 ↻ 가 판 없이 받아 둔 뒤 (15분 넘게 지남)
    vi.setSystemTime(NOW + 20 * 60_000);
    const holdingsCalls = serve(payload({ board: undefined }));
    await loadWidgetData({ stocks: true, briefings: false });
    expect(holdingsCalls).toEqual([`${API}/api/widget?indices=1`]);
    // 잔고 쪽 조회가 판을 지우지 않는다 (마지막 값)
    expect((await loadCachedWidgetData()).board).toHaveLength(9);
    const again = serve();
    await run({ widgetAction: "WIDGET_UPDATE" });
    expect(again).toEqual([`${API}/api/widget?indices=1&board=1`]);
  });

  it("widgetMarket 을 모르는 서버(롤백한 서버 등): 짧은 안내, 주기 갱신은 받아 둔 응답을 다시 쓴다 (판을 달라고 계속 묻지 않음)", async () => {
    serve(payload({ features: { widgetPnlToggle: true, widgetIndexLine: true }, board: undefined }));
    const r = await run({ widgetAction: "WIDGET_ADDED" });
    expect(words(build(r[0]!.dark))).toContain(MARKET_OFF_TEXT);
    const calls = serve();
    for (const min of [3, 6, 9]) {
      vi.setSystemTime(NOW + min * 60_000);
      await run({ widgetAction: "WIDGET_UPDATE" });
    }
    expect(calls).toEqual([]);
  });

  it("받아 둔 응답 없이(업데이트 직후) 첫 조회가 실패해도 앱이 적어 둔 판·플래그로: 마지막 숫자 + '갱신 실패', 플래그를 꺼짐으로 적지 않는다", async () => {
    const d = fromPayload(payload());
    await refreshWidgets({
      stocks: d.stocks,
      showKrw: false,
      afterCost: false,
      features: { at: NOW - 30_000, flags: d.features },
      indices: { at: NOW - 30_000, list: [BOARD[0]!, BOARD[2]!, BOARD[6]!] },
      board: { at: NOW - 30_000, list: BOARD },
    });
    down();
    const r = await run({ widgetAction: "WIDGET_ADDED" });
    const t = build(r[r.length - 1]!.dark);
    expect(tileCodes(t)).toHaveLength(9);
    expect(words(t)).toContain("7,080.92");
    expect(words(t)).toContain("갱신 실패 · 연결 안 됨");
    expect(words(t)).not.toContain(MARKET_OFF_TEXT);
    // 적어 둔 값도 그대로 (다음 손익 전환·↻ '갱신 중' 그림이 꺼진 플래그로 그려지지 않게)
    const cached = await loadCachedWidgetData();
    expect(cached.features).toEqual({ pnlToggle: true, indexLine: true, market: true });
    expect(cached.featuresAt).toBe(NOW - 30_000);
    expect(cached.indices?.map((i) => i.code)).toEqual(["KOSPI", "NASDAQ", "USDKRW"]);
    expect(cached.board).toHaveLength(9);
  });

  it("관리자가 끄면(widgetMarket false) 판 없이 짧은 안내, 주기 갱신은 받아 둔 응답을 다시 쓴다(판을 달라고 계속 묻지 않음)", async () => {
    serve(payload({ features: { ...FEATURES, widgetMarket: false }, board: undefined }));
    const r = await run({ widgetAction: "WIDGET_ADDED" });
    expect(words(build(r[0]!.dark))).toContain(MARKET_OFF_TEXT);
    const calls = serve();
    await run({ widgetAction: "WIDGET_UPDATE" });
    expect(calls).toEqual([]);
  });

  it("예전 서버(/api/widget 없음)면 예전 API(잔고·브리핑)를 부르지 않고 짧은 안내", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("", { status: 404 });
    });
    const r = await run({ widgetAction: "WIDGET_ADDED" });
    expect(urls).toEqual([`${API}/api/widget?indices=1&board=1`]);
    expect(words(build(r[0]!.dark))).toContain(MARKET_OFF_TEXT);
  });

  it("앱 즉시 갱신: 앱 지수 띠(더 새것)로 지수·환율 위젯도 다시 그리고, 그 판은 ↻ '갱신 중' 때도 그대로", async () => {
    serve();
    vi.setSystemTime(NOW - 10 * 60_000);
    await loadWidgetData({ stocks: true, briefings: true, board: true });
    vi.setSystemTime(NOW);
    shared.widgets = { [WIDGET_NAMES.market]: [S42, S44] };
    const strip = BOARD.map((i) => ({ ...i, kind: /KRW$/.test(i.code) ? "fx" : "index", asOf: null, fetchedAt: "2026-09-24T14:39:30+09:00", ...(i.code === "KOSPI" ? { value: 7111.11 } : {}) }));
    const d = fromPayload(payload());
    await refreshWidgets({ stocks: d.stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: d.features }, board: { at: NOW - 30_000, list: pickBoard(strip) } });
    const drawn = shared.updates.filter((u) => u.widgetName === WIDGET_NAMES.market);
    expect(drawn).toHaveLength(2);
    for (const u of drawn) expect(words(build((u.rendered as { dark: React.JSX.Element }).dark))).toContain("7,111.11");
    expect(tileCodes(build((drawn[0]!.rendered as { dark: React.JSX.Element }).dark))).toHaveLength(6);
    expect(tileCodes(build((drawn[1]!.rendered as { dark: React.JSX.Element }).dark))).toHaveLength(9);
    down();
    const busy = await run({ widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    expect(words(build(busy[0]!.dark))).toContain("7,111.11");
  });

  it("앱 지수 띠 → 판: 서버 board 와 같은 순서·모양 (받은 시각·종류 칸은 넣지 않는다)", () => {
    const strip = [...BOARD].reverse().map((i) => ({ ...i, kind: "index" as const, asOf: "2026-09-24T14:39:00+09:00", fetchedAt: "2026-09-24T14:39:30+09:00" }));
    const b = pickBoard(strip);
    expect(b.map((i) => i.code)).toEqual([...WIDGET_BOARD_CODES]);
    expect(b.every((i) => !("fetchedAt" in i) && !("kind" in i))).toBe(true);
    expect(b.find((i) => i.code === "SOX")!.stale).toBe(true);
  });

  it("홈 화면에 지수·환율 위젯이 있는지 (백그라운드 작업이 판을 함께 물을지)", async () => {
    expect(await marketWidgetPlaced()).toBe(false);
    shared.widgets = { [WIDGET_NAMES.market]: [S42] };
    expect(await marketWidgetPlaced()).toBe(true);
  });
});
