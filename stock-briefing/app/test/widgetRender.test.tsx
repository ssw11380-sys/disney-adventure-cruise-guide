import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatestBriefing } from "@/api/types";
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
const model = await import("@/widgets/model");
const { marketChip, widgetChip } = await import("@/lib/liveDot");

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
    const cases = [d, { ...d, market: null }, { ...d, error: "Network request failed", filled: ["005930"] }, empty, { ...d, indices: null, features: { pnlToggle: false, indexLine: false, market: false, polish: false } }];
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
    expect(d.features).toEqual({ pnlToggle: false, indexLine: false, market: false, polish: false });
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

describe("다듬은 잔고 위젯 (widgetPolish · 위젯 검토 '전부 수정해줘')", () => {
  // 2026-09-25 10:00 KST 추석: 한국 휴장 · 미국 주간거래, 코스피는 9/23 값. 미국 보유가 원화로 더 크다
  const T = Date.parse("2026-09-25T10:00:00+09:00");
  const US_AT = "2026-09-25T09:59:40+09:00";
  const KR_AT = "2026-09-23T15:30:00+09:00";
  const CHIP = {
    label: "미국 주간거래",
    open: false,
    nextChangeAt: "2026-09-25T08:00:00.000Z",
    kr: false,
    us: false,
    markets: [
      { market: "US" as const, label: "미국 주간거래" },
      { market: "KR" as const, label: "한국 휴장" },
    ],
  };
  const LINE = [
    { code: "KOSPI", name: "코스피", value: 7080.92, change: 63.01, changeRate: 0.9, open: false, asOf: KR_AT },
    { code: "KOSDAQ", name: "코스닥", value: 862.15, change: -3.2, changeRate: -0.37, open: false, asOf: KR_AT },
    { code: "NASDAQ", name: "나스닥", value: 22936.04, change: -261.9, changeRate: -1.13, open: false, asOf: "2026-09-24T16:00:00-04:00" },
    { code: "SPX", name: "S&P500", value: 6650.12, change: 12.4, changeRate: 0.19, open: false, asOf: "2026-09-24T16:00:00-04:00" },
    { code: "USDKRW", name: "원/달러", value: 1391.5, change: 5.25, changeRate: 0.38, open: true, asOf: "2026-09-25T09:59:00+09:00" },
  ];
  // 엔비디아 40주 × $182.30 × 1,391.50 ≈ 1,015 만원 (원화 매입 628 만원) > 삼성전자 10주 70 만원
  const NVDA = { c: "NVDA", n: "엔비디아", qty: 40, avg: 120, q: [182.3, 2.13, 1.18, "USD", US_AT, 1391.5, 0] as Q, e: [7292, 4800, null, 6_288_000, "exact"] as E };
  const SAMSUNG = { c: "005930", n: "삼성전자", qty: 10, avg: 80_000, q: [70_000, 100, 1.5, "KRW", KR_AT, null, 0] as Q, e: [700_000, 800_000, null, null, null] as E };
  const WATCH = { c: "999990", n: "관심종목", qty: null, avg: null, q: [5_000, -50, -0.99, "KRW", KR_AT, null, 0] as Q, e: null };
  const polishedPayload = (over: Record<string, unknown> = {}) =>
    payload({ market: CHIP, stocks: [NVDA, SAMSUNG, WATCH], features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: true }, indices: LINE, ...over });
  const draw = (over: Record<string, unknown> = {}, box = WIDE, p = polishedPayload()) => {
    const d = fromPayload(p);
    return build(
      <HoldingsWidget stocks={d.stocks} showKrw={false} afterCost={false} fetchedAt={T} error={null} now={T} market={d.market} pnlToggle indexLine indices={d.indices} polish={d.features.polish} rowKrw {...box} {...over} />,
    );
  };
  const head = (t: Tree) => byClick(t, "OPEN_URI").find((n) => String(n.props.accessibilityLabel).startsWith("보유"))!;

  it("플래그: 서버가 widgetPolish 를 주면 켜짐, 없으면(예전 서버) 꺼짐 → 예전 모습 그대로('잔고 3', 칩 한 개, '누적 …', 지수 세 개)", () => {
    expect(fromPayload(polishedPayload()).features.polish).toBe(true);
    const old = fromPayload(polishedPayload({ features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true } }));
    expect(old.features.polish).toBe(false);
    const t = build(renderBoth(WIDGET_NAMES.holdings, { ...old, showKrw: false, afterCost: false, fetchedAt: T, error: null, filled: [] }, { ...WIDE, fontScale: 1, now: T, pnlMode: "cumulative" }).dark);
    const w = words(t);
    expect(w).toContain("잔고 3");
    expect(w).toContain("미국 주간거래");
    expect(w).not.toContain("미국 주간거래 · 한국 휴장");
    expect(w.some((x) => x.startsWith("보유"))).toBe(false);
    expect(w.some((x) => x.startsWith("수익 "))).toBe(false);
    expect(w).not.toContain("⇅");
    expect(w).not.toContain("S&P500"); // 앱 지수 띠가 다섯 개를 넘겨도 예전 줄은 세 개
    expect(w).not.toContain("오늘");
  });

  it("1. 칩: 두 시장의 지금 세션, 원화 보유액이 큰 시장부터 — 좁으면 앞 시장만, 한국만 보유하면 한국만", () => {
    expect(words(draw())).toContain("미국 주간거래 · 한국 휴장");
    // 한국 보유가 더 크면 한국부터
    const krHeavy = polishedPayload({ stocks: [{ ...NVDA, qty: 1, e: [182.3, 120, null, 157_200, "exact"] as E }, { ...SAMSUNG, qty: 100, e: [7_000_000, 8_000_000, null, null, null] as E }, WATCH] });
    expect(words(draw({}, WIDE, krHeavy))).toContain("한국 휴장 · 미국 주간거래");
    // 좁은 4×2: 둘째 시장을 뺀다 (숫자·제목은 그대로)
    const narrow = words(draw({}, { width: 250, height: 180 }));
    expect(narrow).toContain("미국 주간거래");
    expect(narrow).not.toContain("미국 주간거래 · 한국 휴장");
    // 한국 종목만 보유: 보유하지 않은 미국 세션은 넣지 않는다
    const krOnly = polishedPayload({ stocks: [SAMSUNG, WATCH] });
    expect(words(draw({}, WIDE, krOnly))).toContain("한국 휴장");
    expect(words(draw({}, WIDE, krOnly))).not.toContain("미국 주간거래");
    // 화면 읽기도 두 시장
    expect(head(draw()).props.accessibilityLabel).toContain("미국 주간거래 · 한국 휴장");
    // 서버가 시장별 문구를 주지 않으면(플래그 꺼진 서버) 예전 칩 한 개
    expect(words(draw({}, WIDE, polishedPayload({ market: { ...CHIP, markets: undefined } })))).toContain("미국 주간거래");
  });

  it("2. 지수 줄: 미국 보유가 크면 나스닥·S&P500 먼저, 지난 세션 값은 흐리게 + 날짜, 원/달러는 끝·등락률까지", () => {
    // 큰 위젯(4×3 이상)은 두 줄까지: 첫 시장 둘 / 둘째 시장 대표 + 원/달러
    const tall = indexLineOf(draw({}, { width: 330, height: 470 }))!;
    expect(words(tall)).toEqual(["나스닥", "22,936.04", "-1.13%", "·", "S&P500", "6,650.12", "+0.19%", "코스피", "7,080.92", "+0.90%", "9/23", "·", "원/달러", "1,391.50", "+0.38%"]);
    // 한 줄(4×2): 좁으면 둘째 지수부터 빼고, 시장마다 하나 + 원/달러는 남긴다 (둘째 시장 지수는 값을 빼고 등락률만)
    const lineTree = draw({}, { width: 420, height: 260 });
    const line = indexLineOf(lineTree)!;
    expect(words(line)).toEqual(["나스닥", "22,936.04", "-1.13%", "·", "코스피", "+0.90%", "9/23", "·", "원/달러", "1,391.50", "+0.38%"]);
    expect(indexSpeechOf(lineTree)).toBe("나스닥 22,936.04 1.13% 하락, 코스피 0.90% 상승 9월 23일 값, 원/달러 1,391.50 0.38% 상승");
    // 전체 순서와 표기 (원/달러는 늘 끝)
    const { polishedIndexItems } = model;
    const us = polishedIndexItems(LINE, T, true);
    expect(us.map((i) => i.label)).toEqual(["나스닥", "S&P500", "코스피", "코스닥", "원/달러"]);
    expect(polishedIndexItems(LINE, T, false).map((i) => i.label)).toEqual(["코스피", "코스닥", "나스닥", "S&P500", "원/달러"]);
    const kospi = us.find((i) => i.code === "KOSPI")!;
    expect(kospi).toMatchObject({ value: "7,080.92", rate: "+0.90%", stale: true, tag: "9/23" }); // 추석 휴장 중 9/23 값
    expect(us.find((i) => i.code === "NASDAQ")).toMatchObject({ stale: false, tag: null }); // 어젯밤(뉴욕 9/24) 정규장 값은 지금 값
    expect(us.find((i) => i.code === "USDKRW")).toMatchObject({ label: "원/달러", value: "1,391.50", rate: "+0.38%", stale: false });
    // 한국 보유가 크면 코스피부터 — 흐린 색 + 날짜로 그린다
    const krHeavy = polishedPayload({ stocks: [SAMSUNG, WATCH] });
    const krTree = draw({}, WIDE, krHeavy);
    const krLine = indexLineOf(krTree)!;
    expect(words(krLine).slice(0, 4)).toEqual(["코스피", "7,080.92", "+0.90%", "9/23"]);
    expect(texts(krLine).find((p) => p.text === "7,080.92")!.color).toBe(dark.muted);
    expect(indexSpeechOf(krTree)).toContain("코스피 7,080.92 0.90% 상승 9월 23일 값");
    // 출처 조회 실패는 예전처럼 "지연"
    expect(polishedIndexItems([{ ...LINE[4]!, stale: true }], T, true)[0]).toMatchObject({ stale: true, tag: "지연" });
  });

  it("3. 종목 줄: 왼쪽 '수익 …'(누적, 기본 원화 — 합계와 같은 기준), 오른쪽 '오늘 …'(작은 회색 이름표) · 가격은 원화 표시 설정 그대로", () => {
    const list = nodes(draw()).find((n) => n.type === "ListWidget")!;
    const nvda = list.children![0]!;
    const w = words(nvda);
    expect(w[0]).toBe("엔비디아");
    // 원화 매입금액(6,288,000원) 기준: 7,292 × 1,391.5 − 6,288,000 = 3,858,818원, +61.37% (달러 기준 +51.92% 가 아니라 합계와 같은 원화 기준)
    expect(w[1]).toBe("수익 +61.37% +3,858,818원");
    expect(w).toContain("$182.30");
    expect(w).toContain("오늘");
    expect(w).toContain("+1.18%");
    expect(texts(nvda).find((p) => p.text === "오늘")!.color).toBe(dark.muted);
    expect(nvda.props.accessibilityLabel).toBe("엔비디아 182.30달러, 오늘 1.18% 상승, 수익 61.37% 상승");
    // 설정 '위젯 종목 금액: 종목 통화'면 달러
    expect(words(nodes(draw({ rowKrw: false })).find((n) => n.type === "ListWidget")!.children![0]!)[1]).toBe("수익 +51.92% +$2,492.00");
    // 가격 칸은 원화 표시 설정(showKrw)을 따른다
    expect(words(nodes(draw({ showKrw: true })).find((n) => n.type === "ListWidget")!.children![0]!)).toContain("253,670원");
    // 관심 종목은 그대로 "관심", 시세가 없는 줄에는 "오늘"이 없다
    const watch = list.children!.find((r) => words(r)[0] === "관심종목")!;
    expect(words(watch)).toContain("관심");
  });

  it("4. 손익 전환 칸: ⇅ 와 '누적'/'오늘'이 보이고 48dp, 화면 읽기는 '눌러서 당일 손익 보기'", () => {
    const toggle = byClick(draw(), "PNL_TOGGLE")[0]!;
    expect(toggle.props.height).toBeGreaterThanOrEqual(WIDGET_TOUCH);
    expect(words(toggle)[0]).toBe("⇅");
    expect(words(toggle).join(" ")).toMatch(/^⇅ 누적 \+[\d,]+원/);
    expect(toggle.props.accessibilityLabel).toMatch(/^누적 손익 [\d,]+원 이익, 수익률 [\d.]+% 상승, 눌러서 당일 손익 보기$/);
    expect(toggle.props.clickActionData).toEqual({ mode: "cumulative" });
    const day = byClick(draw({ pnlMode: "day" }), "PNL_TOGGLE")[0]!;
    expect(words(day).join(" ")).toMatch(/^⇅ 오늘 [+-][\d,]+원/);
    expect(day.props.accessibilityLabel).toMatch(/, 눌러서 누적 손익 보기$/);
    // 플래그 widgetPnlToggle 이 꺼져 있으면 ⇅ 도 없다 (누르면 앱)
    expect(words(draw({ pnlToggle: false }))).not.toContain("⇅");
  });

  it("5. 제목 '보유 2 · 관심 1' (보유 = 수량·평단), 관심이 없으면 '보유 2', 좁으면 '보유 2'", () => {
    expect(words(draw())).toContain("보유 2 · 관심 1");
    expect(head(draw()).props.accessibilityLabel).toMatch(/^보유 2종목, 관심 1종목, /);
    expect(words(draw({}, WIDE, polishedPayload({ stocks: [NVDA, SAMSUNG] })))).toContain("보유 2");
    expect(words(draw({}, WIDE, polishedPayload({ stocks: [NVDA, SAMSUNG] })))).not.toContain("보유 2 · 관심 0");
    const narrow = words(draw({ fontScale: 1.3 }, { width: 250, height: 250 }));
    expect(narrow).toContain("보유 2");
    expect(narrow).not.toContain("잔고 3");
  });

  it("6. ↻ 는 합계 줄 오른쪽 끝(48×48), 제목 줄은 글자 높이 — 같은 크기에 종목 줄이 더 보인다 (330×230: 3줄 넘게)", () => {
    const t = draw({}, { width: 330, height: 230 });
    const r = byClick(t, "REFRESH");
    expect(r).toHaveLength(1);
    expect(r[0]!.props.width).toBeGreaterThanOrEqual(WIDGET_TOUCH);
    expect(r[0]!.props.height).toBeGreaterThanOrEqual(WIDGET_TOUCH);
    // 갱신 중: ↻ 강조색·기준 시각 자리에 '갱신 중'
    const busy = draw({ refreshing: true });
    expect(byClick(busy, "REFRESH")[0]!.props.accessibilityLabel).toBe("갱신 중");
    expect(texts(busy).find((p) => p.text === "갱신 중")!.color).toBe(dark.accent);
    // 목록 줄 위아래 여백은 xxs (예전 xs)
    const row = nodes(t).find((n) => n.type === "ListWidget")!.children![0]!;
    expect(row.props.padding).toMatchObject({ top: 2, bottom: 2 });
  });

  it("라이트·다크 두 벌은 색만 다르다, 갱신 실패·빈 목록·관심만·아주 작은 크기에서도 그려진다", () => {
    const d = { ...fromPayload(polishedPayload()), showKrw: false, afterCost: false, fetchedAt: T, error: null, filled: [] };
    const strip = (t: Tree): unknown => {
      const { color: _c, backgroundColor: _b, borderColor: _bc, ...rest } = t.props;
      return { type: t.type, props: rest, children: (t.children ?? []).map(strip) };
    };
    const r = renderBoth(WIDGET_NAMES.holdings, d, { ...WIDE, fontScale: 1, now: T, pnlMode: "cumulative" });
    expect(strip(build(r.light))).toEqual(strip(build(r.dark)));
    for (const c of [d, { ...d, error: "Network request failed", filled: ["NVDA"] }, { ...d, stocks: [] }, { ...d, stocks: d.stocks.filter((s) => s.code === "999990") }, { ...d, market: null }])
      for (const box of [{ width: 110, height: 40 }, { width: 250, height: 110 }, { width: 250, height: 130 }, { width: 330, height: 180 }, WIDE])
        for (const fontScale of [1, 1.3])
          for (const refreshing of [false, true]) {
            const x = renderBoth(WIDGET_NAMES.holdings, c, { ...box, fontScale, now: T, pnlMode: "day", refreshing });
            build(x.light);
            build(x.dark);
          }
    // 합계가 없으면(관심만) 예전처럼 48dp 머리 줄에 ↻
    const watchOnly = build(renderBoth(WIDGET_NAMES.holdings, { ...d, stocks: d.stocks.filter((s) => s.code === "999990") }, { ...WIDE, fontScale: 1, now: T, pnlMode: "cumulative" }).dark);
    expect(words(watchOnly)).toContain("관심 1");
    expect(byClick(watchOnly, "REFRESH")).toHaveLength(1);
  });

  it("설정 '위젯 종목 금액'은 AsyncStorage 에 두고 위젯이 읽는다 (기본 원화)", async () => {
    const { STORAGE_KEYS } = await import("@/lib/settings");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(polishedPayload()), { status: 200, headers: { etag: '"p1"' } }));
    expect((await loadWidgetData({ stocks: true, briefings: false })).rowKrw).toBe(true);
    store.set(STORAGE_KEYS.widgetRowCurrency, "native");
    const d = await loadWidgetData({ stocks: true, briefings: false });
    expect(d.rowKrw).toBe(false);
    const t = build(renderBoth(WIDGET_NAMES.holdings, d, { ...WIDE, fontScale: 1, now: T, pnlMode: "cumulative" }).dark);
    expect(words(t).some((w) => w.startsWith("수익 ") && w.includes("$"))).toBe(true);
    const settingsScreen = readFileSync(new URL("../src/app/(tabs)/settings.tsx", import.meta.url), "utf8");
    expect(settingsScreen).toContain("위젯 종목 금액");
  });

  // ── 검증 지적 반영 ──
  const krHeavyStocks = [{ ...NVDA, qty: 1, e: [182.3, 120, null, 157_200, "exact"] as E }, { ...SAMSUNG, qty: 100, e: [7_000_000, 8_000_000, null, null, null] as E }, WATCH];
  // 지수 줄: 위젯 검토 7번부터 항목마다 누르는 칸(그 지수·환율 차트 market/코드)이다 — 항목 칸을 모두 담은 가장 안쪽 칸이 줄,
  // 화면 읽기는 항목마다 (이어 붙이면 예전 줄 한 문장과 같다)
  const indexItemsOf = (t: Tree) => byClick(t, "OPEN_URI").filter((n) => String((n.props.clickActionData as { uri?: string } | undefined)?.uri).startsWith(`${HOME_URI}market/`));
  const indexLineOf = (t: Tree) => {
    const items = indexItemsOf(t);
    return items.length ? nodes(t).filter((n) => items.every((i) => nodes(n).includes(i))).at(-1) : undefined;
  };
  const indexSpeechOf = (t: Tree) => indexItemsOf(t).map((n) => n.props.accessibilityLabel).join(", ");

  it("검증 지적: 원/달러(등락률까지)는 330~640dp 어디서나 보인다 — 미국 비중이 크면 330~400dp 에서도 흐린 '코스피 … 9/23'이 보인다", () => {
    for (const width of [330, 360, 400, 480, 560, 640])
      for (const height of [200, 230, 470])
        for (const [mix, stocks] of [
          ["us", [NVDA, SAMSUNG, WATCH]],
          ["kr", krHeavyStocks],
        ] as const) {
          const line = indexLineOf(draw({}, { width, height }, polishedPayload({ stocks })));
          const at = `${width}×${height} ${mix}`;
          expect(line, at).toBeDefined();
          const w = words(line!);
          const fx = w.indexOf("원/달러");
          expect(w.slice(fx), at).toEqual(["원/달러", "1,391.50", "+0.38%"]);
          // 시장마다 하나: 나스닥과 코스피가 모두 보인다 (지난 세션 코스피는 날짜와 함께)
          expect(w, at).toContain("나스닥");
          const k = w.indexOf("코스피");
          expect(k, at).toBeGreaterThanOrEqual(0);
          expect(w.slice(k, k + 4).includes("9/23"), at).toBe(true);
        }
    // 330dp 미국 비중: "나스닥 -1.13% · 코스피 +0.90% 9/23 · 원/달러 1,391.50 +0.38%" (지수는 값을 빼고 등락률만)
    const narrowTree = draw({}, { width: 330, height: 230 });
    const narrow = indexLineOf(narrowTree)!;
    expect(words(narrow)).toEqual(["나스닥", "-1.13%", "·", "코스피", "+0.90%", "9/23", "·", "원/달러", "1,391.50", "+0.38%"]);
    expect(texts(narrow).find((p) => p.text === "+0.90%")!.color).toBe(dark.muted);
    expect(indexSpeechOf(narrowTree)).toBe("나스닥 1.13% 하락, 코스피 0.90% 상승 9월 23일 값, 원/달러 1,391.50 0.38% 상승");
  });

  it("검증 지적 (위젯 검토 7번): 지수 줄이 두 줄이면(4x3 이상·폴드8 커버 4x2 크게 460×290) 줄 전체가 첫 항목의 차트 한 칸 — 약 10dp 칸이 위아래로 붙지 않게", () => {
    for (const box of [
      { width: 330, height: 470 },
      { width: 460, height: 290 },
    ]) {
      const t = draw({}, box);
      const at = `${box.width}×${box.height}`;
      const items = indexItemsOf(t);
      // 누르는 칸은 하나(나스닥 차트)이고, 그 칸이 두 줄을 모두 담는다 (윗줄·아랫줄 항목이 따로 누르는 칸이 아니다)
      expect(items.map((n) => (n.props.clickActionData as { uri: string }).uri), at).toEqual([`${HOME_URI}market/NASDAQ`]);
      expect(items[0]!.children, at).toHaveLength(2);
      expect(nodes(items[0]!).filter((n) => n !== items[0] && n.props.clickAction), at).toHaveLength(0);
      // 화면 읽기는 보이는 항목을 한 문장으로
      expect(String(items[0]!.props.accessibilityLabel), at).toMatch(/^나스닥 .*원\/달러 1,391\.50 0\.38% 상승$/);
    }
    // 한 줄(4x2 420×260)은 지금처럼 항목마다
    expect(indexItemsOf(draw({}, WIDE)).length).toBeGreaterThan(1);
  });

  it("검증 지적: 칩 색은 보이는 시장으로 — 한국만 보유한 23:00(미국 정규장)의 '한국 장 마감'·미국만 보유한 09:30 의 '미국 장 마감'은 회색", () => {
    const chipColor = (t: Tree, text: string) => texts(t).find((p) => p.text === text)?.color;
    const later = "2026-09-25T20:00:00.000Z";
    // 한국만 보유 · 23:00 KST: 달력은 미국 정규장이 열려 있어 예전 칩은 '미국 장중'(금색)
    const krOnly = polishedPayload({ stocks: [SAMSUNG, WATCH], market: { label: "미국 장중", open: true, kr: false, us: true, nextChangeAt: later, markets: [{ market: "KR", label: "한국 장 마감" }] } });
    expect(chipColor(draw({}, WIDE, krOnly), "한국 장 마감")).toBe(dark.muted);
    // 미국만 보유 · 09:30 KST: 달력은 한국이 열려 있어 예전 칩은 '한국 장중'(금색)
    const usOnly = polishedPayload({ stocks: [NVDA], market: { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: later, markets: [{ market: "US", label: "미국 장 마감" }] } });
    expect(chipColor(draw({}, WIDE, usOnly), "미국 장 마감")).toBe(dark.muted);
    // 보이는 시장에 달력으로 열린 시장이 있으면 금색, 좁아서 그 시장이 빠지면 회색
    const both = polishedPayload({
      market: { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: later, markets: [{ market: "KR", label: "한국 장중" }, { market: "US", label: "미국 주간거래" }] },
    });
    expect(chipColor(draw({}, WIDE, both), "미국 주간거래 · 한국 장중")).toBe(dark.gold);
    expect(chipColor(draw({}, { width: 250, height: 180 }, both), "미국 주간거래")).toBe(dark.muted);
    // 시장별 문구가 없으면(플래그 꺼진 서버) 예전처럼 market.open
    expect(chipColor(draw({}, WIDE, polishedPayload({ market: { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: later } })), "한국 장중")).toBe(dark.gold);
  });

  it("검증 지적: 플래그 꺼짐·예전 앱 — 08:30 에 받은 칩으로 09:05 에 다시 그려도 '한국 장중' 칩이 남는다 (미국 애프터마켓 09:00 경계를 넣지 않음)", () => {
    const status = {
      now: "2026-09-21T23:30:00.000Z",
      KR: { market: "KR", isTradingDay: true, isOpen: true, opensAt: null, closesAt: "2026-09-22T11:00:00.000Z", lastClose: null, source: "toss" },
      US: { market: "US", isTradingDay: true, isOpen: false, opensAt: "2026-09-22T13:30:00.000Z", closesAt: null, lastClose: "2026-09-21T20:00:00.000Z", source: "toss" },
    } as const;
    const sessions = [
      { market: "KR" as const, phase: "regular" as const, label: "한국 정규장", open: true, eligible: true, until: "2026-09-22T06:30:00.000Z" },
      { market: "US" as const, phase: "after" as const, label: "미국 애프터마켓", open: true, eligible: true, until: "2026-09-22T00:00:00.000Z" },
    ];
    // 서버 /api/widget?…&sessions=1 (widgetPolish 꺼짐·예전 앱) = 앱 WidgetBridge 의 예전 모습용 칩
    const chip = marketChip(status as never, sessions, Date.parse(status.now));
    const at905 = Date.parse("2026-09-22T09:05:00+09:00");
    const d = fromPayload(payload({ market: chip }));
    const drawn = (market: unknown, polish: boolean) =>
      words(build(<HoldingsWidget stocks={d.stocks} showKrw={false} afterCost={false} fetchedAt={at905 - 10 * 60_000} error={null} now={at905} market={market as never} pnlToggle indexLine={false} indices={null} polish={polish} {...WIDE} />));
    expect(drawn(d.market, false).slice(0, 2)).toEqual(["잔고 2", "한국 장중"]);
    // 다듬은 모습용 칩은 그 경계(09:00)에서 감추고 다시 받는다 (미국 쪽 문구가 바뀌므로)
    const polished = marketChip(status as never, sessions, Date.parse(status.now), { markets: true });
    expect(polished.nextChangeAt).toBe("2026-09-22T00:00:00.000Z");
    expect(drawn(polished, true).some((x) => x.includes("애프터마켓") || x.includes("한국 장중"))).toBe(false);
  });

  it("검증 지적: 앱이 넘기는 칩 — 위젯이 실제로 쓰는 플래그로 고른다 (예전 모습에는 시장별 경계가 없는 칩)", async () => {
    const c = fromPayload(polishedPayload());
    const plain = { label: "미국 주간거래", open: false, kr: false, us: false, nextChangeAt: "2026-09-25T08:00:00.000Z" };
    shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE] };
    vi.setSystemTime(T);
    const { loadCachedWidgetData } = await import("@/widgets/data");
    const flags = (polish: boolean) => ({ pnlToggle: true, indexLine: true, market: true, polish });
    await refreshWidgets({ stocks: c.stocks, showKrw: false, afterCost: false, market: plain, marketPolished: CHIP, features: { at: T, flags: flags(false) } });
    expect((await loadCachedWidgetData()).market).toStrictEqual(plain);
    expect(words(build((shared.updates.at(-1)!.rendered as { dark: React.JSX.Element }).dark))).toContain("잔고 3");
    await refreshWidgets({ stocks: c.stocks, showKrw: false, afterCost: false, market: plain, marketPolished: CHIP, features: { at: T + 1, flags: flags(true) } });
    expect((await loadCachedWidgetData()).market).toStrictEqual(CHIP);
    expect(words(build((shared.updates.at(-1)!.rendered as { dark: React.JSX.Element }).dark))).toContain("미국 주간거래 · 한국 휴장");
    // 백그라운드 작업처럼 한 칩만 주면 그 칩 (서버가 플래그에 맞춰 준 것)
    await refreshWidgets({ stocks: c.stocks, showKrw: false, afterCost: false, market: plain, features: { at: T + 2, flags: flags(true) } });
    expect((await loadCachedWidgetData()).market).toStrictEqual(plain);
  });

  it("누르는 칸: 종목 줄(약 38dp)도 예전 모습처럼 줄마다 그 종목 상세를 연다 (위젯에서 종목으로 바로 가는 길을 없애지 않는다)", () => {
    const list = nodes(draw()).find((n) => n.type === "ListWidget")!;
    expect(list.children![0]!.props.clickActionData).toEqual({ uri: `${HOME_URI}stocks/NVDA` });
    // 화면 읽기 이름표는 줄마다 그대로
    expect(list.children![0]!.props.accessibilityLabel).toMatch(/^엔비디아 /);
    // 예전 모습과 같은 순서·같은 곳 (줄마다 그 종목)
    const classic = nodes(draw({ polish: false })).find((n) => n.type === "ListWidget")!;
    const uris = list.children!.map((r) => r.props.clickActionData);
    expect(uris).toEqual(classic.children!.map((r) => r.props.clickActionData));
    expect(new Set(uris.map((u) => JSON.stringify(u))).size).toBe(uris.length);
    // 제목 줄은 위 여백까지 누르는 칸이고, 바로 아래 합계 칸과 같은 곳(잔고 탭)을 연다
    const t = draw({}, { width: 330, height: 230 });
    expect(head(t).props.padding).toMatchObject({ top: 8 });
    const total = byClick(t, "OPEN_URI").find((n) => String(n.props.accessibilityLabel).startsWith("총 평가"))!;
    expect(total.props.clickActionData).toEqual(head(t).props.clickActionData);
  });

  it("검증 지적: 합계가 달러(모두 미국 종목·원화 표시 꺼짐)면 종목 줄 손익도 달러 — 합계와 같은 통화", () => {
    const usOnly = polishedPayload({ stocks: [NVDA] });
    const t = draw({}, WIDE, usOnly);
    expect(words(t)).toContain("$7,292.00"); // 합계 $
    const row = nodes(t).find((n) => n.type === "ListWidget")!.children![0]!;
    expect(words(row)[1]).toBe("수익 +51.92% +$2,492.00");
    // 원화 표시를 켜면 합계·줄 모두 원화
    const krw = nodes(draw({ showKrw: true }, WIDE, usOnly)).find((n) => n.type === "ListWidget")!.children![0]!;
    expect(words(krw)[1]).toBe("수익 +61.37% +3,858,818원");
  });
});

describe("BH-41: 앱이 위젯에 넘기는 장 상태 칩에도 다음 바뀌는 시각이 있다", () => {
  it("04:59 미국 장중에 앱을 떠난 뒤 07:30 에 손익을 눌러 다시 그려도 '미국 장중'·'지연'을 그리지 않는다 (서버 칩과 같게)", async () => {
    const left = Date.parse("2026-09-25T04:59:00+09:00");
    vi.setSystemTime(left);
    const status = {
      now: new Date(left).toISOString(),
      KR: { market: "KR", isTradingDay: false, isOpen: false, opensAt: "2026-09-27T23:00:00.000Z", closesAt: null, lastClose: "2026-09-23T11:00:00.000Z", source: "toss" },
      US: { market: "US", isTradingDay: true, isOpen: true, opensAt: null, closesAt: "2026-09-24T20:00:00.000Z", lastClose: "2026-09-23T20:00:00.000Z", source: "toss" },
    } as const;
    const us = fromPayload(
      payload({ stocks: [{ c: "VRT", n: "버티브", qty: 2, avg: 200, q: [250, 1, 0.4, "USD", "2026-09-25T04:59:00+09:00", 1360, 0] as Q, e: [500, 400, null, 540_000, "exact"] as E }] }),
    ).stocks;
    // WidgetBridge 와 같은 부름
    const market = widgetChip(status as never, us, left)!;
    expect(market).toMatchObject({ label: "미국 장중", open: true, nextChangeAt: "2026-09-24T20:00:00.000Z" });
    shared.widgets = { [WIDGET_NAMES.holdings]: [WIDE] };
    await refreshWidgets({ stocks: us, showKrw: false, afterCost: false, market, features: { at: left, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
    expect(words(build((shared.updates.at(-1)!.rendered as { dark: React.JSX.Element }).dark))).toContain("미국 장중");
    vi.setSystemTime(Date.parse("2026-09-25T07:30:00+09:00"));
    vi.stubGlobal("fetch", async () => {
      throw new Error("부르면 안 됨");
    });
    const out: { dark: React.JSX.Element }[] = [];
    await widgetTaskHandler({ widgetInfo: { widgetName: WIDGET_NAMES.holdings, widgetId: 1, ...WIDE, screenInfo: {} }, widgetAction: "WIDGET_CLICK", clickAction: "PNL_TOGGLE", renderWidget: (x: unknown) => void out.push(x as { dark: React.JSX.Element }) } as never);
    const w = words(build(out[0]!.dark));
    expect(w).not.toContain("미국 장중");
    expect(w).not.toContain("지연");
  });
});

describe("BH-68: 브리핑 위젯 안내 문구는 서버의 브리핑 시간·실패를 따른다", () => {
  const brief = (over: Record<string, unknown> = {}) => ({ morning: "07:30", afternoon: "21:50", weekdaysOnly: false, failed: 0, ...over });
  const briefingWords = (p: ReturnType<typeof payload>, box = WIDE) => words(build(renderBoth(WIDGET_NAMES.briefing, data(p), { ...box, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark));
  const message = (w: string[]) => w.find((x) => x.startsWith("아직") || x.startsWith("브리핑 생성"));

  it("최신 브리핑이 모두 실패했으면 '아직 브리핑이 없습니다' 대신 실패를 알린다 (예전: 실패를 숨김)", () => {
    const w = briefingWords(payload({ briefings: [], latestIds: [], brief: brief({ failed: 3 }) }));
    expect(message(w)).toBe("브리핑 생성 실패 3종목. 앱의 브리핑 탭에서 확인해 주세요.");
    expect(w.some((x) => x.startsWith("아직 브리핑이 없습니다"))).toBe(false);
    expect(w.at(-1)).toBe(DISCLAIMER_SHORT);
  });

  it("아직 없을 때 시간은 서버 설정 그대로 (매일·평일, 한쪽만 켬, 모두 끔) — 예전: 늘 '평일 08:30·16:00'", () => {
    expect(message(briefingWords(payload({ briefings: [], brief: brief() })))).toBe("아직 브리핑이 없습니다. 매일 07:30·21:50 에 생성됩니다.");
    expect(message(briefingWords(payload({ briefings: [], brief: brief({ morning: null, afternoon: "16:10", weekdaysOnly: true }) })))).toBe("아직 브리핑이 없습니다. 평일 16:10 에 생성됩니다.");
    expect(message(briefingWords(payload({ briefings: [], brief: brief({ morning: null, afternoon: null }) })))).toBe("아직 브리핑이 없습니다. 자동 생성이 꺼져 있습니다.");
  });

  it("예전 서버(시간을 모름)면 시간을 지어내지 않는다, 조회 실패는 예전처럼 '↻ 로 다시 시도'", () => {
    const w = briefingWords(payload({ briefings: [] }));
    expect(message(w)).toBe("아직 브리핑이 없습니다. 설정한 브리핑 시간에 생성됩니다.");
    expect(w.join(" ")).not.toContain("08:30");
    const failed = words(build(<BriefingWidget briefings={[]} fetchedAt={NOW} error="Network request failed" now={NOW} {...WIDE} />));
    expect(failed).toContain("갱신 실패 · 연결 안 됨 · ↻ 로 다시 시도");
  });

  it("받아 둔 브리핑 시간·실패 수는 손익 전환·↻ 의 '갱신 중' 그림(저장해 둔 값)에도 그대로", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload({ briefings: [], latestIds: [], brief: brief({ failed: 2 }) })), { status: 200, headers: { etag: '"b1"' } }));
    const d = await loadWidgetData({ stocks: false, briefings: true });
    expect(d.brief).toEqual(brief({ failed: 2 }));
    const { loadCachedWidgetData } = await import("@/widgets/data");
    expect((await loadCachedWidgetData()).brief).toEqual(brief({ failed: 2 }));
  });

  it("검증 지적: 앱이 위젯을 바로 그릴 때 브리핑 안내는 마지막으로 그린 값보다 위젯이 마지막으로 받은 응답을 먼저 본다", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(payload({ briefings: [], latestIds: [], brief: brief() })), { status: 200, headers: { etag: '"b2"' } }));
    const d = await loadWidgetData({ stocks: true, briefings: true });
    // 그린 데이터에 옛 실패 수가 남아 있어도 (예: 앞선 응답의 값을 옮겨 적은 그림)
    const { saveWidgetView, loadCachedWidgetData } = await import("@/widgets/data");
    await saveWidgetView({ ...d, brief: brief({ failed: 2 }) }, API);
    shared.widgets = { [WIDGET_NAMES.briefing]: [WIDE] };
    await refreshWidgets({ stocks: d.stocks, showKrw: false, afterCost: false, market: null });
    expect((await loadCachedWidgetData()).brief).toEqual(brief());
  });
});

describe("위젯 검토 7번 앞부분: 앱이 브리핑 위젯도 바로 갱신 · 누르면 맞는 화면 (widgetPolish)", () => {
  const BRIEFINGS_URI = `${HOME_URI}briefings`;
  const POLISH = { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: true };
  const CLASSIC = { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true };
  // 엔비디아 40주 × $182.30 × 1,391.50 ≈ 1,015 만원 > 삼성전자 70 만원 > 관심종목 (평가 없음)
  const NVDA = { c: "NVDA", n: "엔비디아", qty: 40, avg: 120, q: [182.3, 2.13, 1.18, "USD", AT, 1391.5, 0] as Q, e: [7292, 4800, null, 6_288_000, "exact"] as E };
  const SAMSUNG = { c: "005930", n: "삼성전자", qty: 10, avg: 80_000, q: [70_000, 100, 1.5, "KRW", AT, null, 0] as Q, e: [700_000, 800_000, null, null, null] as E };
  const WATCH = { c: "999990", n: "관심종목", qty: null, avg: null, q: [5_000, -50, -0.99, "KRW", AT, null, 0] as Q, e: null };
  // 위젯(백그라운드 작업)이 16:00 에 받은 응답: 삼성전자 오전 브리핑 하나 (오후 브리핑은 16:05 부터 생긴다)
  const T0 = Date.parse("2026-09-24T16:00:00+09:00");
  const MORNING = { id: 1, code: "005930", name: "삼성전자", session: "morning", date: "2026-09-24", summary: "오전 삼성", createdAt: "2026-09-24T08:35:00+09:00" };
  const widgetPayload = (features: Record<string, boolean>, over: Record<string, unknown> = {}) =>
    payload({ stocks: [NVDA, SAMSUNG, WATCH], briefings: [MORNING], latestIds: [1], features, ...over });
  /** 앱이 받은 /api/briefings/latest 한 항목 (종목마다 최신 하나 — 상세 본문까지) */
  const latest = (code: string, name: string, id: number, createdAt: string, status: "ok" | "failed" = "ok"): LatestBriefing => ({
    code,
    name,
    latest: { id, code, name, session: "afternoon", date: "2026-09-24", status, summary: `${name} 오후 요약\n둘째 줄`, detail: "## 긴 본문", missing: [], model: "test", error: null, createdAt },
  });
  // 등록 순서 그대로 (서버처럼 보유 비중으로 고르면 엔비디아 → 삼성전자 → 관심종목, 버티브는 실패라 빠진다)
  const LATEST = [
    latest("999990", "관심종목", 14, "2026-09-24T16:07:00+09:00"),
    latest("005930", "삼성전자", 12, "2026-09-24T16:05:00+09:00"),
    latest("NVDA", "엔비디아", 13, "2026-09-24T16:06:00+09:00"),
    latest("VRT", "버티브", 15, "2026-09-24T16:08:00+09:00", "failed"),
  ];
  /** 위젯이 T0 에 /api/widget 을 받아 그려 둔 상태. 그 뒤로는 서버를 부르지 않는다 (앱 즉시 갱신은 서버 재호출 없음) */
  const prime = async (features: Record<string, boolean>) => {
    vi.setSystemTime(T0);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(widgetPayload(features)), { status: 200, headers: { etag: '"w7"' } }));
    await loadWidgetData({ stocks: true, briefings: true });
    vi.stubGlobal("fetch", async () => {
      throw new Error("부르면 안 됨");
    });
    shared.widgets = { [WIDGET_NAMES.briefing]: [WIDE], [WIDGET_NAMES.holdings]: [WIDE] };
    shared.updates = [];
    vi.setSystemTime(T0 + 12 * 60_000);
  };
  const stocks = () => fromPayload(widgetPayload(POLISH)).stocks;
  const push = (appAt: number, list: LatestBriefing[] = LATEST, features?: { at: number; flags: ReturnType<typeof widgetFeatures> }) =>
    refreshWidgets({ stocks: stocks(), showKrw: false, afterCost: false, market: null, appBriefings: { at: appAt, list }, ...(features ? { features } : {}) });
  const briefingUpdates = () => shared.updates.filter((u) => u.widgetName === WIDGET_NAMES.briefing);
  const lastBriefing = () => build((briefingUpdates().at(-1)!.rendered as { dark: React.JSX.Element }).dark);
  const savedIds = async () => (await (await import("@/widgets/data")).loadCachedWidgetData()).briefings.map((b) => b.latest!.id);
  const uriOf = (n: Tree) => (n.props.clickActionData as { uri?: string } | undefined)?.uri ?? "";

  it("재현: 앱이 잔고를 넘길 때 브리핑 위젯은 그대로였다 → 앱이 받은 최신 브리핑으로 바로 다시 그린다 (서버와 같은 3종목·순서, 요약 첫 줄)", async () => {
    await prime(POLISH);
    await push(T0 + 10 * 60_000);
    expect(briefingUpdates()).toHaveLength(1);
    const t = lastBriefing();
    const w = words(t);
    expect(w.filter((x) => ["엔비디아", "삼성전자", "관심종목", "버티브"].includes(x))).toEqual(["엔비디아", "삼성전자", "관심종목"]);
    expect(w).toContain("엔비디아 오후 요약");
    expect(w).not.toContain("오전 삼성");
    expect(w).not.toContain("둘째 줄");
    expect(w.at(-1)).toBe(DISCLAIMER_SHORT);
    // 누르면 그 브리핑 상세 (지금과 같은 주소)
    expect(byClick(t, "OPEN_URI").map(uriOf)).toEqual(expect.arrayContaining([`${HOME_URI}briefings/13`, `${HOME_URI}briefings/12`, `${HOME_URI}briefings/14`]));
    // 저장해 둔 그림(손익 전환·↻ '갱신 중'이 다시 쓰는 값)도 같은 브리핑 — 요약 첫 줄만, 상세 본문은 적지 않는다
    const { loadCachedWidgetData } = await import("@/widgets/data");
    const saved = (await loadCachedWidgetData()).briefings;
    expect(saved.map((b) => b.latest!.id)).toEqual([13, 12, 14]);
    expect(saved.every((b) => b.latest!.detail === "" && !b.latest!.summary.includes("\n"))).toBe(true);
    // 잔고 위젯도 지금처럼 함께 그린다
    expect(shared.updates.some((u) => u.widgetName === WIDGET_NAMES.holdings)).toBe(true);
  });

  it("플래그 꺼짐(예전 서버·관리자가 끔)이면 지금 그대로: 앱은 브리핑 위젯을 다시 그리지 않고 저장해 둔 브리핑도 바꾸지 않는다", async () => {
    await prime(CLASSIC);
    await push(T0 + 10 * 60_000);
    expect(briefingUpdates()).toHaveLength(0);
    expect(shared.updates.some((u) => u.widgetName === WIDGET_NAMES.holdings)).toBe(true);
    expect(await savedIds()).toEqual([1]);
    // 앱에 남은 옛 플래그(켜짐)가 위젯이 더 늦게 받은 꺼짐을 되살리지 않는다
    await push(T0 + 10 * 60_000, LATEST, { at: T0 - 3_600_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: true } });
    expect(briefingUpdates()).toHaveLength(0);
    expect(await savedIds()).toEqual([1]);
  });

  it("앱 목록이 위젯이 받은 응답보다 먼저 받은 것이면(어제 연 브리핑 탭이 메모리에 남음) 덮지 않는다 · 성공한 브리핑이 없는 목록도 덮지 않는다", async () => {
    await prime(POLISH);
    await push(T0 - 60_000);
    expect(briefingUpdates()).toHaveLength(0);
    expect(await savedIds()).toEqual([1]);
    await push(T0 + 10 * 60_000, [LATEST[3]!]);
    expect(briefingUpdates()).toHaveLength(0);
    expect(await savedIds()).toEqual([1]);
    // 백그라운드 작업이 넘기는 브리핑(서버가 고른 것)은 지금처럼 그대로 쓴다 — 앱 목록보다 먼저
    await refreshWidgets({ stocks: stocks(), showKrw: false, afterCost: false, market: null, briefings: fromPayload(widgetPayload(POLISH)).briefings, appBriefings: { at: T0 + 10 * 60_000, list: LATEST } });
    expect(briefingUpdates()).toHaveLength(1);
    expect(await savedIds()).toEqual([1]);
  });

  it("누르는 곳: 브리핑 위젯 제목(48dp 머리 줄)과 안내 문구는 브리핑 탭으로 — 꺼져 있으면 지금처럼 제목은 잔고 탭, 안내는 누르는 칸이 아님", () => {
    const draw = (features: Record<string, boolean>, over: Record<string, unknown> = {}) =>
      build(renderBoth(WIDGET_NAMES.briefing, data(widgetPayload(features, over)), { ...WIDE, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark);
    const head = (t: Tree) => byClick(t, "OPEN_URI").find((n) => String(n.props.accessibilityLabel).startsWith("브리핑"))!;
    const holding = (t: Tree, prefix: string) => byClick(t, "OPEN_URI").filter((n) => words(n).some((x) => x.startsWith(prefix)));
    const failedBrief = { morning: "08:30", afternoon: "16:00", weekdaysOnly: true, failed: 3 };
    const FAILED = "브리핑 생성 실패 3종목. 앱의 브리핑 탭에서 확인해 주세요.";

    const on = draw(POLISH);
    expect(head(on).props.clickActionData).toEqual({ uri: BRIEFINGS_URI });
    expect(head(on).props.height).toBe(WIDGET_TOUCH);
    // 종목 브리핑은 지금처럼 그 브리핑 상세
    expect(byClick(on, "OPEN_URI").map(uriOf)).toContain(`${HOME_URI}briefings/1`);
    const failed = draw(POLISH, { briefings: [], latestIds: [], brief: failedBrief });
    const notice = holding(failed, "브리핑 생성 실패");
    expect(notice).toHaveLength(1);
    expect(notice[0]!.props.clickActionData).toEqual({ uri: BRIEFINGS_URI });
    expect(notice[0]!.props.accessibilityLabel).toBe(FAILED);
    expect(words(failed)).toContain(FAILED);
    expect(words(failed).at(-1)).toBe(DISCLAIMER_SHORT);
    // 검증 지적: 안내 문구 칸은 글자 한 줄(약 13dp)이 아니라 머리 줄 아래 남는 높이 전체(flex → weight)다 — 고지 줄도 같은 자리로 칸 안에 (한 번만)
    expect(notice[0]!.props.weight).toBe(1);
    expect(words(notice[0]!)).toEqual([FAILED, DISCLAIMER_SHORT]);
    expect(words(failed).filter((x) => x === DISCLAIMER_SHORT)).toHaveLength(1);
    const none = holding(draw(POLISH, { briefings: [], latestIds: [] }), "아직 브리핑이 없습니다");
    expect(none.map((n) => n.props.clickActionData)).toEqual([{ uri: BRIEFINGS_URI }]);
    expect(none[0]!.props.weight).toBe(1);
    // 브리핑이 있으면 고지 줄은 예전처럼 목록 아래 따로 (누르는 칸이 아님)
    expect(byClick(on, "OPEN_URI").some((n) => words(n).includes(DISCLAIMER_SHORT))).toBe(false);
    expect(words(on).at(-1)).toBe(DISCLAIMER_SHORT);
    // 조회 실패 안내("… ↻ 로 다시 시도")는 누르는 칸이 아니다 (↻ 를 누르라는 말)
    const err = build(<BriefingWidget briefings={[]} fetchedAt={NOW} error="Network request failed" now={NOW} polish {...WIDE} />);
    expect(words(err)).toContain("갱신 실패 · 연결 안 됨 · ↻ 로 다시 시도");
    expect(holding(err, "갱신 실패")).toHaveLength(0);
    expect(head(err).props.clickActionData).toEqual({ uri: BRIEFINGS_URI });
    // (머리 줄 space-between 이 넣는 빈 칸 말고) 글자를 담고 남는 높이를 차지하는 칸이 없다
    const fills = (t: Tree) => nodes(t).filter((n) => n.props.weight !== undefined && words(n).length > 0);
    expect(fills(err)).toHaveLength(0);
    expect(words(err).at(-1)).toBe(DISCLAIMER_SHORT);

    const off = draw(CLASSIC);
    expect(head(off).props.clickActionData).toEqual({ uri: HOME_URI });
    const offFailed = draw(CLASSIC, { briefings: [], latestIds: [], brief: failedBrief });
    expect(words(offFailed)).toContain(FAILED);
    expect(holding(offFailed, "브리핑 생성 실패")).toHaveLength(0);
    expect(byClick(offFailed, "OPEN_URI").map(uriOf)).not.toContain(BRIEFINGS_URI);
    // 꺼져 있으면 모양도 지금 그대로 (남는 높이를 차지하는 칸 없음, 고지 줄은 따로 끝에)
    expect(fills(offFailed)).toHaveLength(0);
    expect(words(offFailed).at(-1)).toBe(DISCLAIMER_SHORT);
  });

  it("누르는 곳: 다듬은 잔고 위젯 지수 줄은 항목마다 그 지수·환율 차트(market/코드)를 연다 — 꺼져 있으면 지금처럼 줄 전체가 잔고 탭", () => {
    const draw = (features: Record<string, boolean>, box = WIDE) =>
      build(renderBoth(WIDGET_NAMES.holdings, data(widgetPayload(features)), { ...box, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark);
    const MARKET = `${HOME_URI}market/`;
    for (const box of [WIDE, { width: 330, height: 230 }]) {
      const t = draw(POLISH, box);
      const items = byClick(t, "OPEN_URI").filter((n) => uriOf(n).startsWith(MARKET));
      const codes = items.map((n) => uriOf(n).slice(MARKET.length));
      // 미국 보유가 커서 나스닥부터, 원/달러는 끝 (보이는 순서 그대로 한 칸씩)
      expect(codes).toEqual(["NASDAQ", "KOSPI", "USDKRW"]);
      // 항목마다 그 항목만 읽는다 (보이는 이름으로 시작)
      expect(items.map((n) => String(n.props.accessibilityLabel).split(" ")[0])).toEqual(["나스닥", "코스피", "원/달러"]);
      expect(items.map((n) => words(n)[0])).toEqual(["나스닥", "코스피", "원/달러"]);
      // 줄 전체를 잔고 탭으로 여는 칸은 없다
      expect(byClick(t, "OPEN_URI").some((n) => uriOf(n) === HOME_URI && words(n).includes("나스닥"))).toBe(false);
    }
    const off = draw(CLASSIC);
    const line = byClick(off, "OPEN_URI").find((n) => String(n.props.accessibilityLabel).startsWith("코스피"))!;
    expect(line.props.clickActionData).toEqual({ uri: HOME_URI });
    expect(byClick(off, "OPEN_URI").some((n) => uriOf(n).startsWith(MARKET))).toBe(false);
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
    await refreshWidgets({ stocks: d.stocks, showKrw: false, afterCost: false, market: null, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } }, indices: appIndices });
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
      await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 3 * 86_400_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
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
      expect(before.flags).toEqual({ pnlToggle: false, indexLine: false, market: false, polish: false });
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
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
        expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(1);
        const calls = noServer();
        const own = await tap(null);
        expect(calls).toEqual([]); // 받아 둔 응답을 다시 썼다
        expect(byClick(own, "PNL_TOGGLE")).toHaveLength(1);
        expect(words(own)).toContain("코스피");
        // 한 번 더 번갈아도 같은 모습
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
        expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(1);
        expect(byClick(await tap(null), "PNL_TOGGLE")).toHaveLength(1);
      });

      it("끄기: 관리자가 끈 뒤 앱이 먼저 받은 꺼짐 → 위젯 주기 갱신(10분 전 응답 재사용, 켜짐)도 꺼짐", async () => {
        await widgetFetched(10 * 60_000);
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: false, indexLine: false, market: false, polish: false } } });
        expect(byClick(holdingsTree(), "PNL_TOGGLE")).toHaveLength(0);
        noServer();
        const own = await tap(null);
        expect(byClick(own, "PNL_TOGGLE")).toHaveLength(0);
        expect(words(own)).not.toContain("코스피");
      });

      it("조회 실패(받아 둔 응답이 3시간 전이라 다시 묻다가 실패)도 앱이 더 늦게 받은 켜짐을 쓴다", async () => {
        await widgetFetched(3 * 3_600_000, payload({ features: { widgetPnlToggle: false, widgetIndexLine: true } }));
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
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
        await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
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
      await refreshWidgets({ stocks: data().stocks, showKrw: false, afterCost: false, features: { at: NOW - 30_000, flags: { pnlToggle: true, indexLine: true, market: true, polish: false } } });
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

describe("폴드8·울트라 크기 (3-42 폴드 3단계): 라이브러리 트리 빌더로 그려도 깨지지 않고, 넓은 위젯은 다듬은 모습에서만", () => {
  // 보유 7 · 관심 1 (평가금액 순서: 삼성전자 → … ), 다듬은 모습 켬
  const Qk = (p: number, ch: number, r: number): Q => [p, ch, r, "KRW", AT, null, 0];
  const held = (c: string, n: string, qty: number, avg: number, p: number, ch: number, r: number) => ({ c, n, qty, avg, q: Qk(p, ch, r), e: [p * qty, avg * qty, null, null, null] as E });
  const STOCKS = [
    held("005930", "삼성전자", 120, 71_500, 84_300, 1_200, 1.44),
    held("000660", "SK하이닉스", 15, 262_000, 318_500, -4_500, -1.39),
    held("005380", "현대차", 10, 230_000, 251_000, 1_500, 0.6),
    held("035420", "NAVER", 8, 214_000, 198_700, 2_100, 1.07),
    held("373220", "LG에너지솔루션", 3, 420_000, 402_000, -3_000, -0.74),
    held("035720", "카카오", 30, 52_000, 61_200, -400, -0.65),
    held("247540", "에코프로비엠", 5, 180_000, 152_000, 2_300, 1.54),
    { c: "042700", n: "한미반도체", qty: null, avg: null, q: Qk(98_400, -1_600, -1.6), e: null },
  ];
  const foldData = (polish: boolean) => {
    const p = payload({ stocks: STOCKS, features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: polish } });
    return { ...fromPayload(p), showKrw: false, afterCost: false, fetchedAt: NOW, error: null, filled: [] as string[] };
  };
  /** docs/폴드-위젯.md 크기 표에서 고른 상자 (바깥 4×2 큰 쪽 · 울트라 바깥 4×4 · 안쪽 반쪽 · 미러링 끈 안쪽 4×2 · 5×2 · 6×2 · 6×3 · 6×4) */
  const BOXES = [
    { width: 460, height: 290 },
    { width: 390, height: 540 },
    { width: 435, height: 200 },
    { width: 560, height: 300 },
    { width: 650, height: 230 },
    { width: 780, height: 230 },
    { width: 780, height: 350 },
    { width: 900, height: 470 },
  ];
  const draw = (name: string, polish: boolean, box: { width: number; height: number }, fontScale = 1) =>
    build(renderBoth(name, foldData(polish), { ...box, fontScale, now: NOW, pnlMode: "cumulative" }).dark);
  const list = (t: Tree) => nodes(t).find((n) => n.type === "ListWidget");
  const cellsOf = (t: Tree) => byClick(list(t)!, "OPEN_URI");
  const marketTiles = (t: Tree) => byClick(t, "OPEN_URI").filter((n) => String((n.props.clickActionData as { uri?: string } | undefined)?.uri ?? "").includes("market/"));
  /** 지수·환율 칸 둘 이상을 가로로 나란히 둔 줄 (넓은 모양의 구역 안 가로 칸) */
  const sideBySide = (t: Tree) =>
    nodes(t).filter((n) => n.props.orientation === "HORIZONTAL" && (n.children ?? []).length > 1 && (n.children ?? []).every((k) => marketTiles({ ...k, children: [] }).length === 1));

  it("위젯 4종 × 폴드 크기 × 라이트·다크 × 글자 100·130% × 다듬은 모습 켬·끔: 그려지고, 두 벌은 색만 다르다", () => {
    const strip = (t: Tree): unknown => {
      const { color: _c, backgroundColor: _b, borderColor: _bc, backgroundGradient: _g, ...rest } = t.props as Record<string, unknown>;
      return { type: t.type, props: rest, children: (t.children ?? []).map(strip) };
    };
    let built = 0;
    for (const name of Object.values(WIDGET_NAMES))
      for (const polish of [true, false])
        for (const box of name === WIDGET_NAMES.asset ? [{ width: 215, height: 110 }, { width: 190, height: 160 }, { width: 380, height: 150 }] : BOXES)
          for (const fontScale of [1, 1.3]) {
            const r = renderBoth(name, foldData(polish), { ...box, fontScale, now: NOW, pnlMode: "day" });
            expect(strip(build(r.light))).toEqual(strip(build(r.dark)));
            built++;
          }
    expect(built).toBe(3 * 2 * BOXES.length * 2 + 2 * 3 * 2);
  });

  it("바깥 화면·안쪽 반쪽 크기(460·390·435dp)는 넓은 모습이 아니다: 종목 줄마다 한 종목, 평가금액 칸 없음, 지수·환율 구역은 세로로만", () => {
    for (const box of BOXES.slice(0, 3))
      for (const fontScale of [1, 1.3]) {
        const t = draw(WIDGET_NAMES.holdings, true, box, fontScale);
        // 목록의 줄 하나하나가 곧 누르는 칸 (두 열이면 줄 안에 칸이 둘)
        expect(list(t)!.children!.every((row) => row.props.clickAction === "OPEN_URI")).toBe(true);
        expect(words(t)).not.toContain("평가금액");
        // 지수·환율: 가로 줄 하나에 칸이 둘 이상 들어간 곳이 없다 (구역마다 세로로만)
        const m = draw(WIDGET_NAMES.market, true, box, fontScale);
        expect(sideBySide(m)).toEqual([]);
        expect(marketTiles(m).length).toBe(box.height >= 240 ? 9 : 6);
      }
  });

  it("넓은 잔고(안쪽 6칸, 다듬은 모습): 줄마다 두 종목 — 칸마다 그 종목 상세를 열고 따로 읽는다, 순서는 한 열일 때와 같다", () => {
    const t = draw(WIDGET_NAMES.holdings, true, { width: 780, height: 350 });
    const rows = list(t)!.children!;
    // 8종목 → 4줄, 줄 자체는 누르는 칸이 아니고 안의 두 칸이 누르는 칸
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.props.clickAction).toBeUndefined();
      const cells = byClick(row, "OPEN_URI");
      expect(cells).toHaveLength(2);
      for (const c of cells) expect(String(c.props.accessibilityLabel).length).toBeGreaterThan(3);
    }
    const uris = cellsOf(t).map((c) => (c.props.clickActionData as { uri: string }).uri);
    const narrow = draw(WIDGET_NAMES.holdings, true, { width: 460, height: 350 });
    expect(uris).toEqual(cellsOf(narrow).map((c) => (c.props.clickActionData as { uri: string }).uri));
    expect(uris[0]).toBe(`${HOME_URI}stocks/005930`);
    // 다듬은 모습을 끄면 예전 모습 그대로 (줄마다 한 종목)
    const off = draw(WIDGET_NAMES.holdings, false, { width: 780, height: 350 });
    expect(list(off)!.children!.every((row) => row.props.clickAction === "OPEN_URI")).toBe(true);
    expect(words(off)).toContain("잔고 8");
  });

  it("넓은 잔고(한 열 폭 480dp 이상): 가격 왼쪽에 '평가금액' 칸 — 보이는 금액은 화면 읽기에도, 관심 종목은 빈 칸", () => {
    const t = draw(WIDGET_NAMES.holdings, true, { width: 560, height: 300 });
    const cells = cellsOf(t);
    const samsung = cells.find((c) => words(c)[0] === "삼성전자")!;
    // 120주 × 84,300원 = 10,116,000원
    expect(words(samsung)).toEqual(expect.arrayContaining(["평가금액", "10,116,000원", "84,300원", "오늘", "+1.44%"]));
    expect(samsung.props.accessibilityLabel).toMatch(/평가금액 10,116,000원$/);
    const watch = cells.find((c) => words(c)[0] === "한미반도체")!;
    expect(words(watch)).not.toContain("평가금액");
    expect(watch.props.accessibilityLabel).not.toContain("평가금액");
    // 금액 칸도 숫자를 자르지 않는다 (한 줄, … 없음)
    for (const p of texts(t)) if (/^[\d,]+원$/.test(String(p.text))) expect(p.truncate).toBeUndefined();
  });

  it("넓은 지수·환율(안쪽 6×2, 다듬은 모습): 9칸 모두 — 칸마다 그 지수·환율 차트를 열고 읽는다. 끄면 지금처럼 6칸", () => {
    const on = draw(WIDGET_NAMES.market, true, { width: 780, height: 230 });
    const tiles = marketTiles(on);
    expect(tiles).toHaveLength(9);
    expect(new Set(tiles.map((n) => (n.props.clickActionData as { uri: string }).uri)).size).toBe(9);
    for (const n of tiles) expect(String(n.props.accessibilityLabel)).toMatch(/\d/);
    expect(words(on)).toEqual(expect.arrayContaining(["다우", "필라반도체", "원/위안"]));
    // 구역 안에서 칸을 가로로 나란히 (미국 나스닥·S&P500 / 다우·필라반도체 …)
    expect(sideBySide(on).length).toBeGreaterThan(0);
    const off = draw(WIDGET_NAMES.market, false, { width: 780, height: 230 });
    expect(marketTiles(off)).toHaveLength(6);
    expect(sideBySide(off)).toEqual([]);
    // 같은 크기 · 글자 130% 도 그려지고 칸 수가 줄지 않는다
    expect(marketTiles(draw(WIDGET_NAMES.market, true, { width: 780, height: 230 }, 1.3)).length).toBeGreaterThanOrEqual(6);
  });
});
