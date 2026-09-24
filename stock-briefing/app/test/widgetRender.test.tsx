import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contrast } from "@/lib/color";
import { dark, light } from "@/tokens";

/**
 * 3-23·위젯 요청: 라이브러리의 실제 트리 빌더(react-native-android-widget buildWidgetTree)로 그려 본다.
 *  - 라이트·다크 두 벌, 크기별 배치, 손익 전환(widgetPnlToggle), 지수 줄(widgetIndexLine), 화면 읽기 이름표, ↻ 48dp·"갱신 중"
 *  - 태스크 핸들러: 손익 전환은 서버를 부르지 않고 바로, ↻ 는 "갱신 중"을 먼저 그리고 받은 결과로
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
const { FlexWidget } = await import("react-native-android-widget");
const { HoldingsWidget, AssetWidget, BriefingWidget, WIDGET_NAMES } = await import("@/widgets/widgets");
const { renderBoth, errorView } = await import("@/widgets/render");
const { widgetTaskHandler } = await import("@/widgets/widgetTaskHandler");
const { refreshWidgets } = await import("@/widgets/refresh");
const { loadWidgetData, readPnlMode } = await import("@/widgets/data");
const { fromPayload, widgetFeatures } = await import("@/widgets/payload");
const { HOME_URI, indexItems } = await import("@/widgets/model");
const { WIDGET_PALETTES, WIDGET_TOUCH } = await import("@/widgets/palette");
const { formatIndexValue, formatPct, formatPrice } = await import("@/lib/format");
const { DISCLAIMER_SHORT } = await import("@/lib/disclaimer");
const { pnlLine, pnlSpeech } = await import("@/widgets/model");

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string; color?: string; clickAction?: string; accessibilityLabel?: string; width?: number; height?: number };
  children?: Tree[];
}
const build = (el: React.JSX.Element): Tree => buildWidgetTree(el) as Tree;
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const texts = (t: Tree) => nodes(t).filter((n) => n.type === "TextWidget").map((n) => n.props);
const words = (t: Tree) => texts(t).map((p) => String(p.text));
const byClick = (t: Tree, action: string) => nodes(t).filter((n) => n.props.clickAction === action);

const NOW = Date.parse("2026-09-24T15:40:00+09:00");
const AT = "2026-09-24T15:30:00+09:00";
const API = "https://server.test";
const WIDE = { width: 420, height: 260 };

type Q = [number, number, number, "KRW" | "USD", string, number | null, 0 | 1];
type E = [number, number, number | null, number | null, "exact" | "estimated" | null];
const payload = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  market: { label: "장 마감", open: false, nextChangeAt: "2026-09-25T00:00:00Z", kr: false, us: false },
  stocks: [
    // 오늘 +100×10 = +1,000원, 평단 80,000 → 누적 −100,000원 (−12.50%), 당일 +1,000 ÷ 699,000 = +0.14%
    { c: "005930", n: "삼성전자", qty: 10, avg: 80_000, q: [70_000, 100, 1.5, "KRW", AT, null, 0] as Q, e: [700_000, 800_000, null, null, null] as E },
    { c: "999990", n: "관심종목", qty: null, avg: null, q: [5_000, -50, -0.99, "KRW", AT, null, 0] as Q, e: null },
  ],
  briefings: [{ id: 3, code: "005930", name: "삼성전자", session: "afternoon", date: "2026-09-24", summary: "첫 줄 삼성\n둘째 줄", createdAt: "2026-09-24T16:05:00+09:00" }],
  latestIds: [3],
  features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true },
  indices: [
    { code: "KOSPI", name: "코스피", value: 3412.35, change: 30.45, changeRate: 0.9, open: false, asOf: AT },
    { code: "NASDAQ", name: "나스닥", value: 26936.04, change: -307.5, changeRate: -1.13, open: false, stale: true },
    { code: "USDKRW", name: "원/달러", value: 1360.5, change: -2.1, changeRate: -0.15, open: true },
  ],
  board: BOARD,
  ...over,
});
/** 지수·환율 위젯 판 9개 (서버 board 와 같은 모양): 코스피 장중, 필라반도체 지연(출처 실패), 환율은 장중 점 없음 */
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
const data = (p = payload()) => {
  const f = fromPayload(p);
  return { ...f, showKrw: false, afterCost: false, fetchedAt: NOW, error: null, filled: [], latestIds: p.latestIds };
};
const holdings = (over: Record<string, unknown> = {}, box = WIDE) => {
  const d = data();
  return build(
    <HoldingsWidget
      stocks={d.stocks}
      showKrw={false}
      afterCost={false}
      fetchedAt={NOW}
      error={null}
      now={NOW}
      market={d.market}
      pnlToggle={d.features.pnlToggle}
      indexLine={d.features.indexLine}
      indices={d.indices}
      {...box}
      {...over}
    />,
  );
};

beforeEach(() => {
  store.clear();
  shared.fontScale = 1;
  shared.widgets = {};
  shared.updates = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("라이브러리 트리 빌더로 그려도 깨지지 않는다", () => {
  it("null 을 돌려주는 컴포넌트는 라이브러리가 다룰 수 없다 (그래서 조건부 칸은 부모에서 넣는다)", () => {
    function Nothing() {
      return null;
    }
    expect(() => build(<FlexWidget><Nothing /></FlexWidget>)).toThrow();
  });

  it("위젯 4종(지수·환율 포함) × 라이트·다크 × 크기·글자 배율 × 장 상태 없음·갱신 중·실패·빈 목록·플래그 꺼짐", () => {
    const d = data();
    const empty = { ...d, stocks: [], briefings: [], board: null };
    const cases = [d, { ...d, market: null }, { ...d, error: "Network request failed", filled: ["005930"] }, empty, { ...d, indices: null, features: { pnlToggle: false, indexLine: false, market: false } }];
    let built = 0;
    for (const name of Object.values(WIDGET_NAMES))
      for (const c of cases)
        for (const box of [{ width: 110, height: 40 }, { width: 250, height: 110 }, { width: 250, height: 250 }, WIDE])
          for (const fontScale of [1, 1.3])
            for (const refreshing of [false, true]) {
              const r = renderBoth(name, c, { ...box, fontScale, now: NOW, pnlMode: "day", refreshing });
              build(r.light);
              build(r.dark);
              built += 2;
            }
    expect(Object.values(WIDGET_NAMES)).toHaveLength(4);
    expect(built).toBe(4 * 5 * 4 * 2 * 2 * 2);
  });
});

describe("3-23 라이트·다크 두 벌", () => {
  // 그라데이션도 색이다 (지수·환율 위젯의 다크 카드). 배치·누르는 곳은 같아야 한다
  const strip = (t: Tree): unknown => {
    const { color: _c, backgroundColor: _b, borderColor: _bc, backgroundGradient: _g, ...rest } = t.props;
    return { type: t.type, props: rest, children: (t.children ?? []).map(strip) };
  };
  for (const name of Object.values(WIDGET_NAMES))
    it(`${name}: 색만 다르고 배치·누르는 곳은 같다, 색은 앱 테마(tokens.ts) 값`, () => {
      const r = renderBoth(name, data(), { ...WIDE, fontScale: 1, now: NOW, pnlMode: "cumulative" });
      const l = build(r.light);
      const d = build(r.dark);
      expect(strip(l)).toEqual(strip(d));
      expect(l.props.backgroundColor).toBe(light.surface);
      expect(d.props.backgroundColor).toBe(dark.surface);
      const inkL = texts(l).map((p) => p.color);
      expect(inkL).toContain(light.ink);
      expect(inkL).not.toContain(dark.ink);
    });

  it("오류 화면도 두 벌이고 라이트에서 흰 글자를 쓰지 않는다", () => {
    const r = errorView(new Error("boom"));
    const l = build(r.light);
    expect(l.props.backgroundColor).toBe(light.surface);
    expect(texts(l).map((p) => p.color)).not.toContain("#FFFFFF");
    expect(words(build(r.dark))).toContain("위젯을 그리지 못했습니다");
  });

  it("라이트 보조·흐린 글자 대비 4.5 이상 (위젯 바탕 위, 라이트·다크 모든 글자색)", () => {
    const low: string[] = [];
    for (const p of Object.values(WIDGET_PALETTES))
      for (const k of ["ink", "sub", "muted", "up", "down", "gold", "warn", "accent", "link"] as const) {
        const r = contrast(p[k], p.bg);
        if (r < 4.5) low.push(`${p.scheme} ${k} ${r.toFixed(2)}`);
      }
    expect(low).toEqual([]);
    expect(contrast(WIDGET_PALETTES.light.muted, WIDGET_PALETTES.light.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WIDGET_PALETTES.light.sub, WIDGET_PALETTES.light.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("손익 전환 (widgetPnlToggle)", () => {
  it("켜져 있으면: 합계는 앱 열기, 손익은 48dp 칸의 PNL_TOGGLE + 지금 무엇을 보여 주는지 읽는다", () => {
    const t = holdings();
    const toggle = byClick(t, "PNL_TOGGLE");
    expect(toggle).toHaveLength(1);
    expect(toggle[0]!.props.height).toBeGreaterThanOrEqual(WIDGET_TOUCH);
    expect(toggle[0]!.props.accessibilityLabel).toBe("누적 손익 100,000원 손실, 수익률 12.50% 하락, 누르면 당일 손익으로 바뀝니다");
    expect(words(toggle[0]!)).toEqual(["누적 -100,000원 (-12.50%)"]);
    // 합계를 누르면 여전히 앱
    const open = byClick(t, "OPEN_URI").find((n) => n.props.accessibilityLabel === "총 평가 700,000원")!;
    expect(open.props.clickActionData).toEqual({ uri: HOME_URI });
    expect(words(open)).toEqual(["700,000원"]);
  });

  it("당일: '당일 +1,000원 (+0.14%)' (당일 ÷ (평가 − 당일)), 상승색", () => {
    const t = holdings({ pnlMode: "day" });
    const toggle = byClick(t, "PNL_TOGGLE")[0]!;
    expect(words(toggle)).toEqual(["당일 +1,000원 (+0.14%)"]);
    expect(texts(toggle)[0]!.color).toBe(dark.up);
    expect(toggle.props.accessibilityLabel).toContain("누르면 누적 손익으로 바뀝니다");
  });

  it("꺼져 있으면 예전 그대로: 누적만(당일로 저장돼 있어도), 누르는 칸 없음, 줄 전체가 앱 열기", () => {
    const t = holdings({ pnlToggle: false, pnlMode: "day" });
    expect(byClick(t, "PNL_TOGGLE")).toHaveLength(0);
    expect(words(t)).toContain("누적 -100,000원 (-12.50%)");
    expect(words(t).some((w) => w.startsWith("당일"))).toBe(false);
    const row = byClick(t, "OPEN_URI").find((n) => words(n).includes("누적 -100,000원 (-12.50%)"))!;
    expect(words(row)).toEqual(["700,000원", "누적 -100,000원 (-12.50%)"]);
  });

  it("손익이 0 원이면 '당일 손익 없음' (검토 지적: '당일 손익 손익 없음'으로 읽지 않게)", () => {
    const money = (n: number) => formatPrice(n, "KRW", { sign: true });
    const zero = pnlLine("day", { value: 700_000, profit: -100_000, day: 0 }, money, formatPct);
    expect(pnlSpeech(zero, true)).toBe("당일 손익 없음, 수익률 보합, 누르면 누적 손익으로 바뀝니다");
    const cum = pnlLine("cumulative", { value: 700_000, profit: 0, day: 0 }, money, formatPct);
    expect(pnlSpeech(cum, false)).toBe("누적 손익 없음, 수익률 보합");
    expect(pnlSpeech(pnlLine("day", { value: 700_000, profit: 0, day: 1_000 }, money, formatPct), true)).toBe("당일 손익 1,000원 이익, 수익률 0.14% 상승, 누르면 누적 손익으로 바뀝니다");
  });

  it("누르는 칸은 지금 보여 주는 쪽을 함께 보낸다 (태스크 핸들러가 그 반대로 저장 — 잔고 위젯이 둘 이상이어도 누른 위젯이 바로 바뀌게)", () => {
    expect(byClick(holdings(), "PNL_TOGGLE")[0]!.props.clickActionData).toEqual({ mode: "cumulative" });
    expect(byClick(holdings({ pnlMode: "day" }), "PNL_TOGGLE")[0]!.props.clickActionData).toEqual({ mode: "day" });
  });

  it("예전 서버(플래그 없음)면 꺼짐으로 본다", () => {
    const d = fromPayload(payload({ features: undefined, indices: undefined }));
    expect(d.features).toEqual({ pnlToggle: false, indexLine: false, market: false });
    const t = holdings({ pnlToggle: d.features.pnlToggle, indexLine: d.features.indexLine, indices: d.indices });
    expect(byClick(t, "PNL_TOGGLE")).toHaveLength(0);
    expect(words(t)).not.toContain("코스피");
  });
});

describe("지수 줄 (widgetIndexLine)", () => {
  it("'코스피 3,412.35 +0.90% · 나스닥 26,936.04 -1.13% 지연 · 환율 1,360.50' — 앱 지수 띠와 같은 표기·등락색, 지연 항목은 회색", () => {
    const t = holdings();
    const line = nodes(t).find((n) => n.props.accessibilityLabel?.startsWith("코스피"))!;
    expect(words(line)).toEqual(["코스피", "3,412.35", "+0.90%", "·", "나스닥", "26,936.04", "-1.13%", "지연", "·", "환율", "1,360.50"]);
    const color = (w: string) => texts(line).find((p) => p.text === w)!.color;
    expect(color("3,412.35")).toBe(dark.up);
    expect(color("26,936.04")).toBe(dark.muted); // 지연: 회색
    expect(color("1,360.50")).toBe(dark.down);
    expect(line.props.accessibilityLabel).toBe("코스피 3,412.35 0.90% 상승, 나스닥 26,936.04 1.13% 하락 시세 지연, 원/달러 1,360.50");
    expect(line.props.clickActionData).toEqual({ uri: HOME_URI });
  });

  it("값·등락률은 앱 지수 띠(MarketStrip)와 같은 함수로", () => {
    const items = indexItems(payload().indices);
    expect(items.map((i) => i.value)).toEqual([formatIndexValue(3412.35), formatIndexValue(26936.04), formatIndexValue(1360.5)]);
    expect(items[0]!.rate).toBe(formatPct(0.9));
    const strip = readFileSync(new URL("../src/components/MarketStrip.tsx", import.meta.url), "utf8");
    expect(strip).toMatch(/import \{ formatIndexValue, formatPct \} from "@\/lib\/format"/);
  });

  it("검토 지적: 위젯 조회가 계속 실패해 지수를 받은 지 3시간(서버 stale 한도)이 넘으면 모든 항목을 '지연'(회색)으로", () => {
    const line = (indicesAt: number) => {
      const t = build(renderBoth(WIDGET_NAMES.holdings, { ...data(), indicesAt }, { ...WIDE, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark);
      return nodes(t).find((n) => n.props.accessibilityLabel?.startsWith("코스피"))!;
    };
    const old = line(NOW - 3 * 3_600_000 - 60_000);
    expect(words(old).filter((w) => w === "지연")).toHaveLength(3);
    expect(texts(old).find((p) => p.text === "3,412.35")!.color).toBe(dark.muted);
    expect(old.props.accessibilityLabel).toBe("코스피 3,412.35 0.90% 상승 시세 지연, 나스닥 26,936.04 1.13% 하락 시세 지연, 원/달러 1,360.50 시세 지연");
    // 3시간 안이면 받은 그대로 (나스닥만 서버가 준 stale)
    const fresh = line(NOW - 60 * 60_000);
    expect(words(fresh).filter((w) => w === "지연")).toHaveLength(1);
    expect(texts(fresh).find((p) => p.text === "3,412.35")!.color).toBe(dark.up);
  });

  it("검토 지적: 등록 종목이 0개여도 자리가 있으면 지수 줄을 보여 준다 (목록 자리 대신) — 안내 문구도 그대로", () => {
    for (const box of [{ width: 320, height: 250 }, { width: 330, height: 180 }, WIDE])
      for (const fontScale of [1, 1.3]) {
        const t = holdings({ stocks: [], fontScale }, box);
        expect(words(t)).toContain("코스피");
        expect(words(t)).toContain("등록된 종목이 없습니다");
        expect(nodes(t).some((n) => n.type === "ListWidget")).toBe(false);
      }
  });

  it("플래그 꺼짐·지수 없음(예전 서버)·낮은 위젯(4×2 최소)에서는 감춘다", () => {
    expect(words(holdings({ indexLine: false }))).not.toContain("코스피");
    expect(words(holdings({ indices: null }))).not.toContain("코스피");
    expect(words(holdings({ indices: [] }))).not.toContain("코스피");
    expect(words(holdings({}, { width: 250, height: 110 }))).not.toContain("코스피");
  });
});

describe("세로 배치: 목록은 자리가 있을 때만 (검토 지적)", () => {
  const hasList = (t: Tree) => nodes(t).some((n) => n.type === "ListWidget");

  it("4×2 최소(250×110) × 100·130% × 전환 켬: 목록(ListWidget)을 넣지 않는다 — 넣으면 높이 0 → 라이브러리 예외 → 위젯이 갱신되지 않음", () => {
    for (const fontScale of [1, 1.3])
      for (const pnlMode of ["cumulative", "day"] as const) {
        const t = holdings({ fontScale, pnlMode }, { width: 250, height: 110 });
        expect(hasList(t)).toBe(false);
        expect(byClick(t, "REFRESH")).toHaveLength(1);
        expect(words(t)).toContain("700,000원");
      }
  });

  it("흔한 4×2(330×150·180)·4×4 에서는 목록과 손익 전환 칸이 함께", () => {
    for (const box of [
      { width: 330, height: 150 },
      { width: 330, height: 180 },
      { width: 330, height: 380 },
    ])
      for (const fontScale of [1, 1.3]) {
        const t = holdings({ fontScale, pnlMode: "day" }, box);
        expect(hasList(t)).toBe(true);
        expect(words(byClick(t, "PNL_TOGGLE")[0]!).join(" ")).toContain("당일 +1,000원");
      }
  });

  it("목록 자리가 모자라면 전환 칸을 먼저 뺀다: 누적만, 줄 전체가 앱 열기 (250×130 · 100%, 당일로 저장돼 있어도)", () => {
    const t = holdings({ pnlMode: "day" }, { width: 250, height: 130 });
    expect(hasList(t)).toBe(true);
    expect(byClick(t, "PNL_TOGGLE")).toHaveLength(0);
    const row = byClick(t, "OPEN_URI").find((n) => words(n).includes("700,000원"))!;
    expect(words(row).join(" ")).toContain("누적 -100,000원");
    expect(row.props.accessibilityLabel).toBe("총 평가 700,000원, 누적 손익 100,000원 손실, 수익률 12.50% 하락");
  });

  it("갱신 실패 메모가 들어갈 자리가 없으면 머리 줄 기준 시각 자리에 '갱신 실패' (읽기에도)", () => {
    const t = holdings({ error: "Network request failed", filled: ["005930"] }, { width: 250, height: 110 });
    expect(words(t)).toContain("갱신 실패");
    expect(words(t)).not.toContain("갱신 실패 · 연결 안 됨 · 1종목 이전 값");
    const head = byClick(t, "OPEN_URI").find((n) => String(n.props.accessibilityLabel).startsWith("잔고 2종목"))!;
    expect(head.props.accessibilityLabel).toContain("갱신 실패");
    // 자리가 있으면 메모 줄 그대로, 머리 줄은 기준 시각
    const wide = holdings({ error: "Network request failed", filled: ["005930"] });
    expect(words(wide)).toContain("갱신 실패 · 연결 안 됨 · 1종목 이전 값");
    expect(words(wide)).toContain("15:30 기준");
  });
});

describe("3-23 화면 읽기·↻", () => {
  it("모든 행을 '이름 가격 등락률'로 읽는다", () => {
    const list = nodes(holdings()).find((n) => n.type === "ListWidget")!;
    expect(list.children!.map((r) => r.props.accessibilityLabel)).toEqual(["삼성전자 70,000원 1.50% 상승", "관심종목 5,000원 0.99% 하락"]);
  });

  it("↻ 는 48×48dp, '새로 고침'으로 읽고, 갱신 중이면 기준 시각 자리에 '갱신 중'(강조색)", () => {
    for (const t of [holdings(), build(<BriefingWidget briefings={data().briefings} fetchedAt={NOW} error={null} now={NOW} {...WIDE} />)]) {
      const r = byClick(t, "REFRESH");
      expect(r).toHaveLength(1);
      expect(r[0]!.props.width).toBeGreaterThanOrEqual(WIDGET_TOUCH);
      expect(r[0]!.props.height).toBeGreaterThanOrEqual(WIDGET_TOUCH);
      expect(r[0]!.props.accessibilityLabel).toBe("새로 고침");
    }
    const busy = holdings({ refreshing: true });
    expect(byClick(busy, "REFRESH")[0]!.props.accessibilityLabel).toBe("갱신 중");
    const label = texts(busy).find((p) => p.text === "갱신 중")!;
    expect(label.color).toBe(dark.accent);
    expect(words(busy)).not.toContain("15:30 기준");
  });

  it("검토 지적: 갱신 중에는 지난 실패 문구('갱신 실패 · 연결 안 됨')를 함께 보이지 않는다 — 다른 메모(이전 값)는 그대로", () => {
    for (const box of [WIDE, { width: 250, height: 110 }]) {
      const busy = holdings({ refreshing: true, error: "Network request failed", filled: ["005930"] }, box);
      expect(words(busy)).toContain("갱신 중");
      expect(words(busy).some((w) => w.includes("갱신 실패"))).toBe(false);
    }
    expect(words(holdings({ refreshing: true, error: "Network request failed", filled: ["005930"] }))).toContain("1종목 이전 값");
    // 갱신이 끝나면(실패) 다시 보인다
    expect(words(holdings({ error: "Network request failed", filled: ["005930"] }))).toContain("갱신 실패 · 연결 안 됨 · 1종목 이전 값");
  });

  it("자산 위젯은 한 칸이라 가려진 칸까지 한 문장으로", () => {
    const d = data();
    const t = build(<AssetWidget stocks={d.stocks} showKrw={false} afterCost={false} fetchedAt={NOW} error={null} now={NOW} market={d.market} width={110} height={40} />);
    expect(t.props.accessibilityLabel).toBe("총 평가 700,000원, 오늘 1,000원 이익, 총 손익 100,000원 손실, 장 마감, 15:30 기준");
  });

  it("브리핑: 날짜는 자르지 않고(이름만 줄임), '이름 날짜 브리핑, 첫 줄'로 읽는다", () => {
    const long = [{ ...data().briefings[0]!, name: "TIGER 미국필라델피아반도체나스닥" }];
    const t = build(<BriefingWidget briefings={long} fetchedAt={NOW} error={null} now={NOW} width={250} height={180} fontScale={1.3} />);
    const date = texts(t).find((p) => p.text === " · 09/24 오후")!;
    expect(date.truncate).toBeUndefined();
    const name = texts(t).find((p) => p.text === "TIGER 미국필라델피아반도체나스닥")!;
    expect(name.truncate).toBe("END");
    expect(byClick(t, "OPEN_URI").some((n) => n.props.accessibilityLabel === "TIGER 미국필라델피아반도체나스닥 9월 24일 오후 브리핑, 첫 줄 삼성")).toBe(true);
  });

  it("브리핑 4×2 최소(110dp) · 130%: 이름·요약을 한 줄에(날짜는 빼고 자르지 않음), 고지 한 줄은 그대로 · 읽기는 날짜까지", () => {
    const long = [{ ...data().briefings[0]!, name: "TIGER 미국필라델피아반도체나스닥" }];
    const t = build(<BriefingWidget briefings={long} fetchedAt={NOW} error={null} now={NOW} width={250} height={110} fontScale={1.3} />);
    const item = byClick(t, "OPEN_URI").find((n) => n.props.accessibilityLabel === "TIGER 미국필라델피아반도체나스닥 9월 24일 오후 브리핑, 첫 줄 삼성")!;
    expect(words(item)).toEqual(["TIGER 미국필라델피아반도체나스닥", "첫 줄 삼성"]);
    expect(texts(item).every((p) => p.maxLines === 1)).toBe(true);
    expect(words(t)).not.toContain(" · 09/24 오후");
    expect(words(t).at(-1)).toBe(DISCLAIMER_SHORT);
  });

  it("브리핑이 없을 때 안내 문구 줄 수도 높이에 맞춘다 (고지 줄이 밀려 잘리지 않게)", () => {
    const small = build(<BriefingWidget briefings={[]} fetchedAt={NOW} error={null} now={NOW} width={250} height={110} fontScale={1.3} />);
    const msg = texts(small).find((p) => String(p.text).startsWith("아직 브리핑이 없습니다"))!;
    expect(msg.maxLines).toBe(1);
    const tall = build(<BriefingWidget briefings={[]} fetchedAt={NOW} error={null} now={NOW} {...WIDE} />);
    expect(texts(tall).find((p) => String(p.text).startsWith("아직 브리핑이 없습니다"))!.maxLines).toBe(3);
    expect(words(small).at(-1)).toBe(DISCLAIMER_SHORT);
  });

  it("숫자 글자에는 … 줄임이 없고 한 줄이다 (6개 크기·배율)", () => {
    const bad: string[] = [];
    const d = data();
    for (const [name, box] of [
      [WIDGET_NAMES.asset, { width: 110, height: 40 }],
      [WIDGET_NAMES.holdings, { width: 250, height: 110 }],
      [WIDGET_NAMES.holdings, { width: 250, height: 250 }],
      [WIDGET_NAMES.briefing, { width: 250, height: 110 }],
      [WIDGET_NAMES.briefing, { width: 250, height: 250 }],
    ] as const)
      for (const fontScale of [1, 1.3]) {
        const t = build(renderBoth(name, d, { ...box, fontScale, now: NOW, pnlMode: "cumulative" }).dark);
        for (const p of texts(t)) {
          const numeric = /\d/.test(String(p.text)) && !["삼성전자", "관심종목"].includes(String(p.text)) && !String(p.text).startsWith("첫 줄");
          if (numeric && (p.truncate || p.maxLines !== 1)) bad.push(`${name} ${box.width}×${box.height}@${fontScale} ${p.text}`);
        }
      }
    expect(bad).toEqual([]);
  });
});

describe("태스크 핸들러", () => {
  const info = (name: string, box = WIDE) => ({ widgetName: name, widgetId: 7, ...box, screenInfo: { screenHeightDp: 800, screenWidthDp: 400, density: 3, densityDpi: 480 } });
  const run = async (props: Record<string, unknown>) => {
    const rendered: { light: React.JSX.Element; dark: React.JSX.Element }[] = [];
    await widgetTaskHandler({ renderWidget: (r: unknown) => void rendered.push(r as { light: React.JSX.Element; dark: React.JSX.Element }), ...props } as never);
    return rendered;
  };
  /** 서버에서 한 번 받아 둔다 (응답·마지막 잔고·마지막으로 그린 데이터가 저장된다) */
  const seed = async (p = payload()) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(p), { status: 200, headers: { etag: '"e1"' } }));
    await loadWidgetData({ stocks: true, briefings: false });
  };

  it("손익을 누르면 서버를 부르지 않고 저장해 둔 값으로 바로 누적 ↔ 당일 (두 벌)", async () => {
    await seed();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      throw new TypeError("Network request failed");
    });
    const first = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE" });
    expect(calls).toEqual([]);
    expect(first).toHaveLength(1);
    expect(words(build(first[0]!.light))).toContain("당일 +1,000원 (+0.14%)");
    expect(words(build(first[0]!.dark))).toContain("당일 +1,000원 (+0.14%)");
    expect(await readPnlMode()).toBe("day");
    const second = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE" });
    expect(words(build(second[0]!.dark))).toContain("누적 -100,000원 (-12.50%)");
    expect(await readPnlMode()).toBe("cumulative");
    expect(calls).toEqual([]);
    // 다음 주기 갱신도 고른 쪽으로 그린다
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE" });
    const update = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_UPDATE" });
    expect(words(build(update[0]!.dark))).toContain("당일 +1,000원 (+0.14%)");
  });

  it("플래그가 그사이 꺼졌으면 옛 그림의 손익을 눌러도 바꾸지 않는다", async () => {
    await seed(payload({ features: { widgetPnlToggle: false, widgetIndexLine: true } }));
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE" });
    expect(await readPnlMode()).toBe("cumulative");
    expect(words(build(r[0]!.dark))).toContain("누적 -100,000원 (-12.50%)");
    expect(byClick(build(r[0]!.dark), "PNL_TOGGLE")).toHaveLength(0);
  });

  it("↻: 저장해 둔 값으로 '갱신 중'을 먼저 그리고, 받은 결과로 다시 그린다", async () => {
    await seed();
    const events: string[] = [];
    const next = payload({ stocks: [{ ...payload().stocks[0]!, q: [71_000, 1_100, 1.57, "KRW", AT, null, 0] as Q, e: [710_000, 800_000, null, null, null] as E }] });
    vi.stubGlobal("fetch", async () => {
      events.push("fetch");
      return new Response(JSON.stringify(next), { status: 200, headers: { etag: '"e2"' } });
    });
    await widgetTaskHandler({
      widgetInfo: info(WIDGET_NAMES.holdings),
      widgetAction: "WIDGET_CLICK",
      clickAction: "REFRESH",
      renderWidget: (r: unknown) => {
        const w = words(build((r as { dark: React.JSX.Element }).dark));
        events.push(w.includes("갱신 중") ? `갱신 중 ${w.find((x) => /^\d[\d,]*원$/.test(x))}` : `완료 ${w.find((x) => /^\d[\d,]*원$/.test(x))}`);
      },
    } as never);
    expect(events).toEqual(["갱신 중 700,000원", "fetch", "완료 710,000원"]);
  });

  it("↻ 가 실패하면 마지막 값을 두고 '갱신 실패 …'", async () => {
    await seed();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    const r = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    expect(r).toHaveLength(2);
    expect(words(build(r[0]!.dark))).toContain("갱신 중");
    const done = words(build(r[1]!.dark));
    expect(done).toContain("갱신 실패 · 연결 안 됨");
    expect(done).toContain("700,000원");
    expect(done).not.toContain("갱신 중");
  });

  /** 그린 그림에서 손익 칸을 누를 때 라이브러리가 넘기는 clickActionData */
  const toggleData = (r: { dark: React.JSX.Element }) => byClick(build(r.dark), "PNL_TOGGLE")[0]!.props.clickActionData;
  const pnlWords = (r: { dark: React.JSX.Element }) => words(build(r.dark)).filter((w) => /^(누적|당일) /.test(w));

  it("검토 지적(경쟁 상태): ↻ 로 받는 동안('갱신 중') 손익을 누르면, 받은 뒤 다시 그릴 때도 고른 쪽(당일)을 그린다", async () => {
    await seed();
    let entered!: () => void;
    const inFetch = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", async () => {
      entered();
      await gate;
      return new Response(JSON.stringify(payload()), { status: 200, headers: { etag: '"e2"' } });
    });
    const renders: { dark: React.JSX.Element }[] = [];
    const push = (r: unknown) => void renders.push(r as { dark: React.JSX.Element });
    const refresh = widgetTaskHandler({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH", renderWidget: push } as never);
    await inFetch; // "갱신 중"을 그리고 서버를 기다리는 중
    expect(words(build(renders[0]!.dark))).toContain("갱신 중");
    await widgetTaskHandler({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: toggleData(renders[0]!), renderWidget: push } as never);
    expect(pnlWords(renders.at(-1)!)).toEqual(["당일 +1,000원 (+0.14%)"]);
    release();
    await refresh;
    expect(await readPnlMode()).toBe("day");
    expect(renders).toHaveLength(3);
    expect(words(build(renders[2]!.dark))).not.toContain("갱신 중");
    expect(pnlWords(renders[2]!)).toEqual(["당일 +1,000원 (+0.14%)"]);
    // 다음 누름도 제대로 바뀐다 (예전: 저장값은 당일인데 그림은 누적이라 눌러도 그대로였다)
    const next = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: toggleData(renders[2]!) });
    expect(pnlWords(next[0]!)).toEqual(["누적 -100,000원 (-12.50%)"]);
  });

  it("검토 지적(잔고 위젯 2개): 누른 위젯이 보여 주던 쪽의 반대로 바꾸고, 다른 잔고 위젯도 같은 쪽으로 다시 그린다 (서버 호출 없음)", async () => {
    await seed();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      throw new TypeError("Network request failed");
    });
    const small = { width: 330, height: 180 };
    shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE, small] };
    // 두 위젯 모두 누적을 보여 주는 중 (주기 갱신은 받아 둔 응답을 다시 쓴다)
    const a0 = await run({ widgetInfo: { ...info(WIDGET_NAMES.holdings), widgetId: 1 }, widgetAction: "WIDGET_UPDATE" });
    const b0 = await run({ widgetInfo: { ...info(WIDGET_NAMES.holdings, small), widgetId: 2 }, widgetAction: "WIDGET_UPDATE" });
    expect(pnlWords(b0[0]!)).toEqual(["누적 -100,000원 (-12.50%)"]);
    // A 를 눌러 당일로
    const a1 = await run({ widgetInfo: { ...info(WIDGET_NAMES.holdings), widgetId: 1 }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: toggleData(a0[0]!) });
    expect(pnlWords(a1[0]!)).toEqual(["당일 +1,000원 (+0.14%)"]);
    // 다른 잔고 위젯(B 포함)도 당일로 다시 그린다 — 위젯 크기대로
    expect(shared.updates.map((u) => u.widgetName)).toEqual([WIDGET_NAMES.holdings, WIDGET_NAMES.holdings]);
    for (const u of shared.updates) expect(pnlWords(u.rendered as { dark: React.JSX.Element })).toEqual(["당일 +1,000원 (+0.14%)"]);
    // 다시 그리기가 늦어 B 가 아직 누적을 보여 줄 때 B 를 눌러도(옛 그림) 당일로 바뀐다 — 예전: 저장값을 뒤집어 누적으로 되돌아가 "눌러도 안 바뀜"
    const b1 = await run({ widgetInfo: { ...info(WIDGET_NAMES.holdings, small), widgetId: 2 }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", clickActionData: toggleData(b0[0]!) });
    expect(pnlWords(b1[0]!)).toEqual(["당일 +1,000원 (+0.14%)"]);
    expect(await readPnlMode()).toBe("day");
    expect(calls).toEqual([]);
  });

  it("↻: 지난번 실패가 저장돼 있어도 '갱신 중' 그림에는 실패 문구를 함께 넣지 않는다", async () => {
    await seed();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    const again = await run({ widgetInfo: info(WIDGET_NAMES.holdings), widgetAction: "WIDGET_CLICK", clickAction: "REFRESH" });
    const busy = words(build(again[0]!.dark));
    expect(busy).toContain("갱신 중");
    expect(busy.some((w) => w.includes("갱신 실패"))).toBe(false);
    expect(words(build(again[1]!.dark))).toContain("갱신 실패 · 연결 안 됨");
  });

  it("시스템 글자 크기 배율로 배치를 고른다 (300dp 4×2: 100% 는 손익 한 줄, 130% 는 금액·수익률 두 줄)", async () => {
    await seed();
    const box = { width: 300, height: 200 };
    const at100 = build((await run({ widgetInfo: info(WIDGET_NAMES.holdings, box), widgetAction: "WIDGET_UPDATE" }))[0]!.dark);
    expect(words(byClick(at100, "PNL_TOGGLE")[0]!)).toEqual(["누적 -100,000원 (-12.50%)"]);
    shared.fontScale = 1.3;
    const at130 = build((await run({ widgetInfo: info(WIDGET_NAMES.holdings, box), widgetAction: "WIDGET_UPDATE" }))[0]!.dark);
    const toggle = byClick(at130, "PNL_TOGGLE")[0]!;
    expect(words(toggle)).toEqual(["누적 -100,000원", "(-12.50%)"]);
    expect(toggle.props.height).toBeGreaterThanOrEqual(WIDGET_TOUCH);
  });
});

describe("앱 → 위젯 즉시 갱신 (refreshWidgets)", () => {
  it("두 벌을 위젯 크기대로 그리고, 앱이 받은 지수(더 새것)와 플래그를 쓴다. 그린 값은 손익 전환 때 다시 쓴다", async () => {
    // 위젯이 받아 둔 응답(지수 옛 값)
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload()), { status: 200, headers: { etag: '"e1"' } }));
    vi.setSystemTime(NOW - 10 * 60_000);
    await loadWidgetData({ stocks: true, briefings: true });
    vi.setSystemTime(NOW);
    shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE], [WIDGET_NAMES.asset]: [{ width: 160, height: 72 }] };
    const d = data();
    const appIndices = { at: NOW - 30_000, list: [{ code: "KOSPI", name: "코스피", value: 3500, change: 10, changeRate: 0.29, open: true }] };
    await refreshWidgets({ stocks: d.stocks, showKrw: false, afterCost: false, market: null, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true } }, indices: appIndices });
    expect(shared.updates.map((u) => u.widgetName)).toEqual([WIDGET_NAMES.holdings, WIDGET_NAMES.asset]);
    const r = shared.updates[0]!.rendered as { light: React.JSX.Element; dark: React.JSX.Element };
    expect(build(r.light).props.backgroundColor).toBe(light.surface);
    const w = words(build(r.dark));
    expect(w).toContain("3,500.00");
    expect(w).not.toContain("3,412.35");
    // 손익 전환: 방금 앱이 그린 값(새 지수) 그대로 다시 그린다
    vi.stubGlobal("fetch", async () => {
      throw new Error("부르면 안 됨");
    });
    const rendered: { dark: React.JSX.Element }[] = [];
    await widgetTaskHandler({ widgetInfo: { widgetName: WIDGET_NAMES.holdings, widgetId: 1, ...WIDE, screenInfo: {} }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", renderWidget: (x: unknown) => void rendered.push(x as { dark: React.JSX.Element }) } as never);
    expect(words(build(rendered[0]!.dark))).toContain("3,500.00");
  });

  describe("플래그는 앱 캐시와 위젯 응답 중 받은 시각이 늦은 쪽 (검토 지적)", () => {
    const holdingsTree = () => build((shared.updates.at(-1)!.rendered as { dark: React.JSX.Element }).dark);
    /** 위젯이 `ago` 전에 /api/widget 을 받아 둔다 */
    const widgetFetched = async (ago: number, p = payload()) => {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(p), { status: 200, headers: { etag: '"e1"' } }));
      vi.setSystemTime(NOW - ago);
      await loadWidgetData({ stocks: true, briefings: true });
      vi.setSystemTime(NOW);
      shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE] };
    };
    const tap = async (clickAction: string | null) => {
      const out: { dark: React.JSX.Element }[] = [];
      await widgetTaskHandler({
        widgetInfo: { widgetName: WIDGET_NAMES.holdings, widgetId: 1, ...WIDE, screenInfo: {} },
        widgetAction: clickAction ? "WIDGET_CLICK" : "WIDGET_UPDATE",
        ...(clickAction ? { clickAction } : {}),
        renderWidget: (x: unknown) => void out.push(x as { dark: React.JSX.Element }),
      } as never);
      return build(out.at(-1)!.dark);
    };

    it("킬 스위치: 관리자가 끈 widgetPnlToggle·widgetIndexLine 을 앱에 남은 3일 전 /api/features(켜짐)가 되살리지 않는다 · 눌러도 당일로 바뀌지 않는다", async () => {
      await widgetFetched(5 * 60_000, payload({ features: { widgetPnlToggle: false, widgetIndexLine: false }, indices: undefined }));
      // 홈 탭만 쓰면 앱은 플래그를 다시 받지 않는다 (기기에 저장된 3일 전 값)
      await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 3 * 86_400_000, flags: { pnlToggle: true, indexLine: true, market: true } } });
      const t = holdingsTree();
      expect(byClick(t, "PNL_TOGGLE")).toHaveLength(0);
      expect(words(t)).toContain("누적 -100,000원 (-12.50%)");
      vi.stubGlobal("fetch", async () => {
        throw new Error("부르면 안 됨");
      });
      // 앱을 떠날 때의 갱신이 그린 그림에서 손익을 눌러도(옛 그림) 저장된 값은 꺼짐 → 바꾸지 않는다
      const after = await tap("PNL_TOGGLE");
      expect(await readPnlMode()).toBe("cumulative");
      expect(byClick(after, "PNL_TOGGLE")).toHaveLength(0);
    });

    it("배포 직후: 서버 배포 전에 저장된 앱 플래그(새 키 없음 → 꺼짐)가 위젯이 새로 받은 켜짐을 덮지 않는다 — 앱 갱신·위젯 갱신이 번갈아도 같은 모습", async () => {
      await widgetFetched(10 * 60_000);
      const before = { at: NOW - 86_400_000, flags: widgetFeatures({ briefingDigest: true }) };
      expect(before.flags).toEqual({ pnlToggle: false, indexLine: false, market: false });
      await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: before });
      const app = holdingsTree();
      expect(byClick(app, "PNL_TOGGLE")).toHaveLength(1);
      expect(words(app)).toContain("코스피");
      // 이어서 위젯이 스스로 갱신해도(받아 둔 응답) 같은 모습
      const own = await tap(null);
      expect(byClick(own, "PNL_TOGGLE")).toHaveLength(1);
      expect(words(own)).toContain("코스피");
    });

    describe("검토 지적: 위젯이 스스로 갱신할 때(받아 둔 응답 재사용·조회 실패)도 늦게 받은 쪽 — 앱 갱신과 번갈아 켜졌다 꺼졌다 하지 않게", () => {
      const noServer = () => {
        const calls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
          calls.push(url);
          throw new TypeError("Network request failed");
        });
        return calls;
      };

      it("켜기: 관리자가 켠 직후 앱이 받은 켜짐 → 위젯 주기 갱신(10분 전 응답 재사용, 꺼짐)도 켜짐", async () => {
        await widgetFetched(10 * 60_000, payload({ features: { widgetPnlToggle: false, widgetIndexLine: false } }));
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true } } });
        expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(1);
        const calls = noServer();
        const own = await tap(null);
        expect(calls).toEqual([]); // 받아 둔 응답을 다시 썼다
        expect(byClick(own, "PNL_TOGGLE")).toHaveLength(1);
        expect(words(own)).toContain("코스피");
        // 한 번 더 번갈아도 같은 모습
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true } } });
        expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(1);
        expect(byClick(await tap(null), "PNL_TOGGLE")).toHaveLength(1);
      });

      it("끄기: 관리자가 끈 뒤 앱이 먼저 받은 꺼짐 → 위젯 주기 갱신(10분 전 응답 재사용, 켜짐)도 꺼짐", async () => {
        await widgetFetched(10 * 60_000);
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: false, indexLine: false, market: false } } });
        expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(0);
        noServer();
        const own = await tap(null);
        expect(byClick(own, "PNL_TOGGLE")).toHaveLength(0);
        expect(words(own)).not.toContain("코스피");
      });

      it("조회 실패(받아 둔 응답이 3시간 전이라 다시 묻다가 실패)도 앱이 더 늦게 받은 켜짐을 쓴다", async () => {
        await widgetFetched(3 * 3_600_000, payload({ features: { widgetPnlToggle: false, widgetIndexLine: true } }));
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true } } });
        const calls = noServer();
        const own = await tap(null);
        expect(calls).toHaveLength(1); // 재사용하지 않고 물었다가 실패
        expect(words(own).some((w) => w.includes("갱신 실패"))).toBe(true);
        expect(byClick(own, "PNL_TOGGLE")).toHaveLength(1);
      });

      it("앱이 더 늦게 받은 지수도 위젯 주기 갱신이 옛 응답의 지수로 되돌리지 않는다", async () => {
        await widgetFetched(10 * 60_000);
        const appIndices = { at: NOW - 30_000, list: [{ code: "KOSPI", name: "코스피", value: 3500, change: 10, changeRate: 0.29, open: true }] };
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, indices: appIndices });
        noServer();
        const own = await tap(null);
        expect(words(own)).toContain("3,500.00");
        expect(words(own)).not.toContain("3,412.35");
      });

      it("↻ 로 서버에서 방금 받은 값은 그대로 쓴다 (앱 값이 더 늦다고 옛 값을 덮지 않음)", async () => {
        await widgetFetched(10 * 60_000);
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true } } });
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload({ features: { widgetPnlToggle: false, widgetIndexLine: true } })), { status: 200, headers: { etag: '"e9"' } }));
        const fresh = await tap("REFRESH");
        expect(byClick(fresh, "PNL_TOGGLE")).toHaveLength(0);
        // 그 뒤 주기 갱신도 꺼짐 (방금 받은 쪽이 가장 늦다)
        noServer();
        expect(byClick(await tap(null), "PNL_TOGGLE")).toHaveLength(0);
      });
    });

    it("앱이 더 늦게 받은 플래그는 바로 쓴다 (관리자가 켠 직후 앱이 받은 값)", async () => {
      await widgetFetched(10 * 60_000, payload({ features: { widgetPnlToggle: false, widgetIndexLine: true } }));
      await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true } } });
      expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(1);
      // 그린 값(켜짐)을 적어 두어, 서버를 부르지 않는 손익 전환도 켜진 것으로
      vi.stubGlobal("fetch", async () => {
        throw new Error("부르면 안 됨");
      });
      const t = await tap("PNL_TOGGLE");
      expect(await readPnlMode()).toBe("day");
      expect(words(t)).toContain("당일 +1,000원 (+0.14%)");
    });
  });

  it("앱이 지수·플래그를 모르면 위젯이 받아 둔 값을 쓴다", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload()), { status: 200, headers: { etag: '"e1"' } }));
    await loadWidgetData({ stocks: true, briefings: true });
    shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE] };
    await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false });
    const t = build((shared.updates[0]!.rendered as { dark: React.JSX.Element }).dark);
    expect(words(t)).toContain("3,412.35");
    expect(byClick(t, "PNL_TOGGLE")).toHaveLength(1);
  });

  it("브리핑 위젯은 두 벌, 목록은 저장해 둔 브리핑", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload()), { status: 200, headers: { etag: '"e1"' } }));
    await loadWidgetData({ stocks: true, briefings: true });
    shared.widgets = { [WIDGET_NAMES.briefing]: [WIDE] };
    await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, briefings: data().briefings });
    const r = shared.updates[0]!.rendered as { light: React.JSX.Element; dark: React.JSX.Element };
    expect(words(build(r.light))).toContain("첫 줄 삼성");
    expect(API).toBe("https://server.test");
  });
});
