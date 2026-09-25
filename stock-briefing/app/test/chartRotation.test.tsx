import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 전체 화면 차트의 '가로로 보기'(화면을 90도 돌려 그리기)가 가로 창에서 또 돌지 않는지.
 * 안드로이드 16 부터 큰 화면(펼친 접는 폰 안쪽 화면)은 앱의 세로 고정을 무시하고 가로로 돈다 → 창이 이미 가로면
 * 돌리지 않고 창을 그대로 쓴다. 세로 창에서는 전과 똑같이 돌린다.
 */
const h = vi.hoisted(() => ({
  win: { width: 400, height: 800 } as { width: number; height: number; fontScale?: number },
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
  /** 서버가 준 foldLayout 값 (undefined = 아직 못 받음 → fallback 꺼짐) */
  flag: undefined as boolean | undefined,
  /** 종목 정보 (없으면 이름 대신 코드, 시세 없음) */
  stock: undefined as unknown,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { back: vi.fn(), dismissTo: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ code: "005930", period: "D" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ data: h.stock, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useCandles: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : fallback),
}));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ ChangeText: "ChangeText", ErrorView: "ErrorView" }));

const { default: ChartScreen } = await import("@/app/stocks/[code]/chart");
const { font, fontCap, light, space, touch } = await import("@/tokens");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { chartHeaderLayout, CHART_ICON_BTN } = await import("@/lib/chartLayout");

type R = ReturnType<typeof render>;
const PAD = space.md * 2; // 차트 좌우 여백
const HEADER = 44;
const CHROME = 170; // 도구 모음 높이 첫 추정 (onLayout 전)
const expectedH = (availH: number) => Math.max(160, availH - HEADER - CHROME - space.sm);

const flatStyle = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
/** 90도 돌려 그리는 요소 */
const rotated = (r: R) => r.all().filter((n) => JSON.stringify(flatStyle(n).transform ?? []).includes("rotate"));
const chart = (r: R) => {
  const c = r.all().find((n) => n.type === "CandleChart");
  return { w: c!.props.width as number, h: c!.props.height as number };
};
const toggle = (r: R) => r.all().find((n) => n.type === "Pressable" && /로 보기$/.test(String(n.props.accessibilityLabel)))!;
const press = (r: R) => r.act(() => (toggle(r).props.onPress as () => void)());

beforeEach(() => {
  h.win = { width: 400, height: 800 };
  h.insets = { top: 0, bottom: 0, left: 0, right: 0 };
  h.flag = undefined;
  h.stock = undefined;
  forgetWindowClass();
});

describe("전체 화면 차트: 세로 창 (전과 같음)", () => {
  it("가로 버튼을 누르면 90도 돌려 넓게, 다시 누르면 세로로", () => {
    const r = render(<ChartScreen />);
    expect(rotated(r)).toHaveLength(0);
    expect(chart(r)).toEqual({ w: 400 - PAD, h: expectedH(800) });
    expect(toggle(r).props.accessibilityLabel).toBe("가로로 보기");
    expect(toggle(r).props.disabled).toBeFalsy();

    press(r);
    expect(rotated(r)).toHaveLength(1);
    expect(flatStyle(rotated(r)[0]).transform).toEqual([{ rotate: "90deg" }]);
    expect(chart(r)).toEqual({ w: 800 - PAD, h: expectedH(400) });
    expect(toggle(r).props.accessibilityLabel).toBe("세로로 보기");

    press(r);
    expect(rotated(r)).toHaveLength(0);
    expect(chart(r)).toEqual({ w: 400 - PAD, h: expectedH(800) });
  });

  it("돌릴 때 상태 표시줄·내비게이션 바 높이를 뺀 만큼이 차트 폭이 된다", () => {
    h.insets = { top: 24, bottom: 48, left: 0, right: 0 };
    const r = render(<ChartScreen />);
    expect(chart(r)).toEqual({ w: 400 - PAD, h: expectedH(800 - 72) });
    press(r);
    expect(chart(r)).toEqual({ w: 800 - 72 - PAD, h: expectedH(400) });
    // 돌린 판의 바깥 틀 = 여백을 뺀 창
    const frame = r.all().find((n) => n.children.some((c) => typeof c !== "string" && rotated(r).includes(c)))!;
    expect(flatStyle(frame)).toMatchObject({ width: 400, height: 800 - 72 });
  });
});

describe("전체 화면 차트: 가로 창 (펼친 안쪽 화면을 돌림) — 두 번 돌리지 않는다", () => {
  const LAND = { width: 832, height: 750 };

  it("처음부터 가로 창이면 돌리지 않고 창을 그대로 쓴다", () => {
    h.win = LAND;
    h.insets = { top: 24, bottom: 0, left: 0, right: 48 };
    const r = render(<ChartScreen />);
    expect(rotated(r)).toHaveLength(0);
    // 오른쪽 내비게이션 바(48)를 피한다
    expect(chart(r)).toEqual({ w: 832 - 48 - PAD, h: expectedH(750 - 24) });
    const root = r.tree.find((n): n is HostNode => typeof n !== "string")!;
    expect(flatStyle(root)).toMatchObject({ paddingTop: 24, paddingBottom: 0, paddingLeft: 0, paddingRight: 48 });
  });

  it("가로 버튼은 꺼져 있고 까닭을 화면 읽기로 알린다. 눌러도 돌지 않는다", () => {
    h.win = LAND;
    const r = render(<ChartScreen />);
    const btn = toggle(r);
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.accessibilityState).toEqual({ disabled: true });
    expect(btn.props.accessibilityLabel).toBe("가로로 보기");
    expect(btn.props.accessibilityHint).toMatch(/이미 가로 화면/);
    press(r); // 꺼진 버튼이라도 onPress 가 불려도
    expect(rotated(r)).toHaveLength(0);
    expect(chart(r)).toEqual({ w: 832 - PAD, h: expectedH(750) });
  });

  it("돌린 채로 폰을 가로로 돌리면 돌리기가 풀리고, 다시 세로로 와도 옆으로 눕지 않는다", () => {
    const r = render(<ChartScreen />);
    press(r);
    expect(rotated(r)).toHaveLength(1);

    h.win = { width: 800, height: 400 };
    r.rerender();
    expect(rotated(r)).toHaveLength(0);
    expect(chart(r)).toEqual({ w: 800 - PAD, h: expectedH(400) });

    h.win = { width: 400, height: 800 };
    r.rerender();
    expect(rotated(r)).toHaveLength(0);
    expect(toggle(r).props.accessibilityLabel).toBe("가로로 보기");
    expect(chart(r)).toEqual({ w: 400 - PAD, h: expectedH(800) });
  });

  it("돌린 채로 접거나 펴도(세로 창 크기가 바뀜) 돌리기가 풀린다", () => {
    const r = render(<ChartScreen />);
    press(r);
    h.win = { width: 750, height: 832 }; // 펼친 안쪽 화면 세로
    r.rerender();
    expect(rotated(r)).toHaveLength(0);
    expect(chart(r).w).toBe(750 - PAD);
  });
});

describe("가로 창에서 가로로 보기 버튼 (폴드 진단 26번, 플래그 foldLayout)", () => {
  const LAND = { width: 933, height: 704 };
  const closeBtn = (r: R) => r.byLabel("차트 닫기");
  const buttonsRow = (r: R) => r.all().find((n) => n.type === "View" && n.children.some((c) => c === closeBtn(r)))!;

  it("플래그 꺼짐(못 받음 포함): 지금처럼 흐리게 꺼 둔다", () => {
    h.win = LAND;
    const r = render(<ChartScreen />);
    expect(toggle(r).props.disabled).toBe(true);
    expect(flatStyle(toggle(r)).opacity).toBeLessThan(1);
    expect(buttonsRow(r).children).toHaveLength(2);
  });

  it("플래그 켜짐 + 가로 창: 버튼을 숨기고 닫기만 오른쪽 끝에 남긴다 (화면 읽기에도 꺼진 버튼이 없다)", () => {
    h.win = LAND;
    h.flag = true;
    const r = render(<ChartScreen />);
    expect(r.all().some((n) => /로 보기$/.test(String(n.props.accessibilityLabel)))).toBe(false);
    expect(r.all().some((n) => n.props.accessibilityHint !== undefined)).toBe(false);
    expect(buttonsRow(r).children).toEqual([closeBtn(r)]);
    expect(closeBtn(r).props.accessibilityRole).toBe("button");
    expect(rotated(r)).toHaveLength(0);
    expect(chart(r)).toEqual({ w: 933 - PAD, h: expectedH(704) });
  });

  it("플래그 켜짐 + 세로 창: 버튼이 그대로 있고 돌릴 수 있다. 돌린 판(가로)에서도 '세로로 보기'로 남는다", () => {
    h.flag = true;
    const r = render(<ChartScreen />);
    expect(toggle(r).props.disabled).toBeFalsy();
    press(r);
    expect(rotated(r)).toHaveLength(1);
    expect(toggle(r).props.accessibilityLabel).toBe("세로로 보기");
    // 폰을 가로로 돌리면 돌리기가 풀리고 버튼이 숨는다
    h.win = { width: 800, height: 400 };
    r.rerender();
    expect(rotated(r)).toHaveLength(0);
    expect(r.all().some((n) => /로 보기$/.test(String(n.props.accessibilityLabel)))).toBe(false);
  });
});

describe("전체 화면 차트 머리 (폴드 진단 8번): 가격이 쪼개지거나 도구 줄과 겹치지 않는다", () => {
  const LONG = {
    code: "012450",
    name: "한화에어로스페이스",
    market: "KOSPI",
    avgPrice: null,
    quote: { price: 912000, change: 12000, changeRate: 1.33, currency: "KRW" },
  };
  const PRICE = "912,000원";
  const CHANGE = "+12,000원 (+1.33%)";
  const texts =(r: R) => r.all().filter((n) => n.type === "Text" || n.type === "ChangeText");
  const nameNode = (r: R) => texts(r).find((n) => n.children.includes(LONG.name))!;
  const priceNode = (r: R) => texts(r).find((n) => n.children.includes(PRICE))!;
  const changeNode = (r: R) => r.all().find((n) => n.type === "ChangeText")!;
  const header = (r: R) => r.all().find((n) => flatStyle(n).minHeight !== undefined)!;
  /** 이 노드를 바로 품은 View */
  const parentOf = (r: R, node: HostNode) => r.all().find((n) => n.children.includes(node))!;

  it("이름만 줄어들고(…) 가격·등락은 한 줄로 줄지 않는다. 글자는 fontCap.chrome 까지만 커진다", () => {
    h.stock = LONG;
    h.win = { width: 475, height: 751 };
    const r = render(<ChartScreen />);
    expect(nameNode(r).props.numberOfLines).toBe(1);
    expect(flatStyle(nameNode(r)).flexShrink).toBe(1);
    expect(priceNode(r).props.numberOfLines).toBe(1);
    expect(flatStyle(priceNode(r)).flexShrink).toBe(0);
    expect(changeNode(r).props.numberOfLines).toBe(1);
    expect(flatStyle(changeNode(r)).flexShrink).toBe(0);
    expect(changeNode(r).props.text).toBe(CHANGE);
    for (const n of [nameNode(r), priceNode(r), changeNode(r)]) expect(n.props.maxFontSizeMultiplier).toBe(fontCap.chrome);
  });

  it("폴드8 접힘 100%·115%, 울트라 접힘 100%: 이름·가격·등락이 한 줄, 머리 높이 44 (차트 높이도 전과 같은 계산)", () => {
    h.stock = LONG;
    for (const [w, hh, fontScale] of [
      [475, 751, 1],
      [475, 751, 1.15],
      [411, 960, 1],
    ]) {
      h.win = { width: w!, height: hh!, fontScale };
      const r = render(<ChartScreen />);
      const row = parentOf(r, nameNode(r));
      expect(row.children, `${w} ${fontScale}`).toContain(priceNode(r));
      expect(row.children, `${w} ${fontScale}`).toContain(changeNode(r));
      expect(flatStyle(header(r)).minHeight).toBe(touch.min);
      expect(chart(r)).toEqual({ w: w! - PAD, h: expectedH(hh!) });
    }
  });

  it("접힌 화면 130%(폴드8·울트라): 이름을 네 글자로 줄여도 모자라 가격·등락을 이름 아래 둘째 줄로, 머리가 커진 만큼 차트를 줄인다", () => {
    h.stock = LONG;
    for (const [w, hh] of [
      [475, 751],
      [411, 960],
    ]) {
      h.win = { width: w!, height: hh!, fontScale: 1.3 };
      const r = render(<ChartScreen />);
      const head = chartHeaderLayout({ width: w! - PAD, fontScale: 1.3, name: LONG.name, price: PRICE, change: CHANGE, buttons: 2 });
      expect(head.twoLines, `${w}`).toBe(true);
      // 이름 줄 = [이름, 버튼 묶음], 둘째 줄 = [가격, 등락]
      const nameRow = parentOf(r, nameNode(r));
      expect(nameRow.children).not.toContain(priceNode(r));
      expect(nameRow.children.some((c) => typeof c !== "string" && c.children.includes(r.byLabel("차트 닫기")))).toBe(true);
      const quoteRow = parentOf(r, priceNode(r));
      expect(quoteRow.children).toEqual([priceNode(r), changeNode(r)]);
      // 두 줄이 모두 머리 안에 (최소 높이 = 버튼 줄 + 가격 줄), 차트는 그만큼 낮아진다 → 도구 줄과 겹치지 않는다
      expect(header(r).children).toEqual([nameRow, quoteRow]);
      expect(flatStyle(header(r)).minHeight).toBe(head.height);
      expect(head.height).toBeGreaterThan(CHART_ICON_BTN + font.body * 1.3);
      expect(chart(r).h).toBe(Math.max(160, hh! - head.height - CHROME - space.sm));
    }
  });

  it("시세가 없으면 이름만 한 줄 (전과 같음)", () => {
    h.stock = { ...LONG, quote: null };
    h.win = { width: 411, height: 960, fontScale: 1.5 };
    const r = render(<ChartScreen />);
    expect(priceNode(r)).toBeUndefined();
    expect(flatStyle(header(r)).minHeight).toBe(touch.min);
  });

  it("차트 칩 띠 끝은 전체 화면 바탕색(t.bg)으로 흐린다", () => {
    const r = render(<ChartScreen />);
    expect(r.all().find((n) => n.type === "CandleChart")!.props.backdrop).toBe(light.bg);
  });
});
