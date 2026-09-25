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
const { chartHeaderLayout, CHART_ICON_BTN, estimateTextWidth, headerButtonsRoom } = await import("@/lib/chartLayout");

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

describe("전체 화면 차트 머리 (폴드 진단 8번, 깨질 때만 고친다): 한 줄로 그려 재 보고 넘칠 때만 바꾼다", () => {
  const LONG = {
    code: "012450",
    name: "한화에어로스페이스",
    market: "KOSPI",
    avgPrice: null,
    quote: { price: 912000, change: 12000, changeRate: 1.33, currency: "KRW" },
  };
  const PRICE = "912,000원";
  const CHANGE = "+12,000원 (+1.33%)";
  const texts = (r: R) => r.all().filter((n) => n.type === "Text" || n.type === "ChangeText");
  const nameNode = (r: R, name = LONG.name) => texts(r).find((n) => n.children.includes(name))!;
  const priceNode = (r: R, price = PRICE) => texts(r).find((n) => n.children.includes(price))!;
  const changeNode = (r: R) => r.all().find((n) => n.type === "ChangeText")!;
  /** 이 노드를 바로 품은 View */
  const parentOf = (r: R, node: HostNode) => r.all().find((n) => n.children.includes(node))!;
  /** 머리 = 닫기 버튼 → 버튼 묶음 → 머리 줄 → 머리 */
  const header = (r: R) => parentOf(r, parentOf(r, parentOf(r, r.byLabel("차트 닫기"))));
  /** 머리 높이: 한 줄은 3-42 이전처럼 고정 높이(height), 두 줄은 최소 높이(minHeight) */
  const headBox = (r: R) => {
    const st = flatStyle(header(r));
    return { height: st.height, minHeight: st.minHeight };
  };
  /** 3-42 이전(main) 한 줄 머리: 높이 44 고정 */
  const MAIN_HEAD = { height: HEADER, minHeight: undefined };
  type Layout = (e: unknown) => void;
  /** 한 줄 머리의 글자 묶음·이름이 잰 폭을 알린다 (onLayout) */
  const measure = (r: R, m: { title: number; name: number }, name = LONG.name) =>
    r.act(() => {
      const n = nameNode(r, name);
      (parentOf(r, n).props.onLayout as Layout)({ nativeEvent: { layout: { width: m.title, height: 22, x: 0, y: 0 } } });
      (n.props.onLayout as Layout)({ nativeEvent: { layout: { width: m.name, height: 22, x: 0, y: 0 } } });
    });
  /**
   * 한 줄 머리를 그렸을 때 폰이 잴 값 흉내: 글꼴 폭 = 어림(estimateTextWidth). 다 들어가면 글자 폭 그대로,
   * 넘치면 글자 묶음은 쓸 수 있는 폭까지, 이름이 그만큼 줄어든다 (가격·등락은 줄지 않는다)
   */
  const phone = (winW: number, fontScale: number, name: string, price: string, change: string, buttons = 2) => {
    // 한 줄 머리는 3-42 이전처럼 글자 배율 상한이 없다 (시스템 글자 200% 면 200% 로 그려 잰다)
    const s = Math.max(fontScale, 1);
    const room = winW - PAD - headerButtonsRoom(buttons);
    const quote = space.sm + estimateTextWidth(price, font.body * s) + space.sm + estimateTextWidth(change, font.small * s);
    const nm = estimateTextWidth(name, font.h2 * s);
    return nm + quote <= room ? { title: nm + quote, name: nm } : { title: room, name: Math.max(0, room - quote) };
  };
  const oneLineState = (hh: number) => ({ head: MAIN_HEAD, twoLines: false, chartH: expectedH(hh) });
  /** 3-42 이전(main) 한 줄 머리의 글자 속성: 이름만 한 줄 말줄임, 가격·등락은 줄 수 제한 없음, 셋 다 글자 배율 상한 없음 */
  const expectMainTexts = (r: R, label: string, name = LONG.name, price = PRICE) => {
    expect(nameNode(r, name).props.numberOfLines, label).toBe(1);
    expect(nameNode(r, name).props.maxFontSizeMultiplier, label).toBeUndefined();
    for (const n of [priceNode(r, price), changeNode(r)]) {
      expect(n.props.numberOfLines, label).toBeUndefined();
      expect(n.props.maxFontSizeMultiplier, label).toBeUndefined();
    }
  };

  it("한 줄 머리는 3-42 이전(main)과 같은 글자 (플래그 켬·끔, 글자 100~200%): 상한·줄 수 제한을 새로 두지 않는다", () => {
    // 검증 보고: 160~200% 에서 한 줄에 다 들어가던 머리 글자가 150% 로 줄었고(maxFontSizeMultiplier),
    // 100% 에서도 가격 끝 글자가 번지는 1px 가 잘렸다(numberOfLines → overflow:hidden). 한 줄 머리는 main 그대로여야 한다
    for (const flag of [undefined, false, true])
      for (const [w, hh] of [
        [475, 751],
        [411, 960],
        [360, 780],
      ] as const)
        for (const fontScale of [1, 1.3, 1.6, 1.8, 2]) {
          h.stock = LONG;
          h.flag = flag;
          h.win = { width: w, height: hh, fontScale };
          forgetWindowClass();
          const r = render(<ChartScreen />);
          const label = `${flag} ${w} ${fontScale}`;
          expect(header(r).children, label).toHaveLength(1);
          expect(headBox(r), label).toEqual(MAIN_HEAD);
          expectMainTexts(r, label);
          // 이름은 자리가 모자랄 때만 줄어든다(다 들어가면 main 과 같은 자리). 가격·등락은 줄지 않는다
          expect(flatStyle(nameNode(r)).flexShrink, label).toBe(1);
          expect(flatStyle(priceNode(r)).flexShrink, label).toBe(0);
          expect(flatStyle(changeNode(r)).flexShrink, label).toBe(0);
          expect(changeNode(r).props.text, label).toBe(CHANGE);
          expect(chart(r), label).toEqual({ w: w - PAD, h: expectedH(hh) });
        }
  });

  it("다 들어가는 머리는 잰 뒤에도 main 그대로 (검증 보고의 475·411 160~200% 짧은 이름, 플래그 켬·끔)", () => {
    const STOCKS = {
      삼성전자: { code: "005930", market: "KOSPI", quote: { price: 74500, change: 1200, changeRate: 1.64, currency: "KRW" } },
      엔비디아: { code: "NVDA", market: "NASDAQ", quote: { price: 181.2, change: 2.1, changeRate: 1.17, currency: "USD" } },
      애플: { code: "AAPL", market: "NASDAQ", quote: { price: 231.5, change: -1.2, changeRate: -0.52, currency: "USD" } },
    } as const;
    // 검증 보고에서 main 은 한 줄에 다 들어갔는데 새 머리는 150% 로 줄었던 경우
    const CASES: [keyof typeof STOCKS, number, number][] = [
      ["삼성전자", 475, 1.6],
      ["엔비디아", 475, 1.6],
      ["애플", 475, 1.6],
      ["엔비디아", 475, 1.8],
      ["애플", 475, 1.8],
      ["엔비디아", 411, 1.8],
      ["애플", 411, 1.8],
      ["애플", 475, 2],
    ];
    for (const flag of [undefined, false, true])
      for (const [name, w, fontScale] of CASES) {
        const st = STOCKS[name];
        h.stock = { ...st, name, avgPrice: null };
        h.flag = flag;
        h.win = { width: w, height: 900, fontScale };
        forgetWindowClass();
        const r = render(<ChartScreen />);
        const label = `${flag} ${name} ${w} ${fontScale}`;
        const priceText = texts(r).find((n) => n.type === "Text" && n !== nameNode(r, name))!.children[0] as string;
        // 검증 보고 실측: main 머리는 이 창·글자에서 한 줄에 다 들어갔다 → 잰 글자 묶음은 쓸 수 있는 폭보다 좁고, 이름은 줄지 않은 폭
        measure(r, { title: w - PAD - headerButtonsRoom(2) - 10, name: estimateTextWidth(name, font.h2 * fontScale) }, name);
        expect(header(r).children, label).toHaveLength(1);
        expect(headBox(r), label).toEqual(MAIN_HEAD);
        expectMainTexts(r, label, name, priceText);
        expect(chart(r), label).toEqual({ w: w - PAD, h: expectedH(900) });
      }
  });

  it("360×780 삼성전자 (플래그 켬·끔): 재기 전에도, 잰 뒤에도 3-42 이전과 같은 한 줄 머리 44 · 차트 336×(780 − 44 − 도구)", () => {
    const SAMSUNG = { code: "005930", name: "삼성전자", market: "KOSPI", avgPrice: null, quote: { price: 74500, change: 1200, changeRate: 1.64, currency: "KRW" } };
    for (const flag of [undefined, false, true]) {
      h.stock = SAMSUNG;
      h.flag = flag;
      h.win = { width: 360, height: 780, fontScale: 1 };
      forgetWindowClass();
      const r = render(<ChartScreen />);
      const state = () => ({ head: headBox(r), twoLines: header(r).children.length === 2, chartH: chart(r).h });
      const row = () => parentOf(r, nameNode(r, "삼성전자"));
      expect(state(), `${flag}`).toEqual(oneLineState(780));
      expect(chart(r).w).toBe(360 - PAD);
      expect(row().children).toContain(priceNode(r, "74,500원"));
      // 웹 미리보기에서 잰 값: 이름 x12–71, 가격 79–132.5, 등락 140.5–239 (글자 묶음 227), 버튼은 280 부터
      measure(r, { title: 227, name: 59 }, "삼성전자");
      expect(state(), `${flag}`).toEqual(oneLineState(780));
      expect(row().children).toContain(changeNode(r));
      // 예전 어림 기준은 이 머리를 두 줄로 내렸다 (어림 합 342.7 > 머리 폭 336 → 머리 59, 차트 15 낮아짐)
      expect(estimateTextWidth("삼성전자", font.h2) + space.sm + estimateTextWidth("74,500원", font.body) + space.sm + estimateTextWidth("+1,200원 (+1.64%)", font.small) + headerButtonsRoom(2)).toBeGreaterThan(360 - PAD);
    }
  });

  it("폴드8 접힘 100%·115%, 울트라 접힘 100%: 긴 이름이 넘쳐도 이름만 줄여 한 줄, 머리 높이 44 (차트 높이도 전과 같은 계산)", () => {
    h.stock = LONG;
    for (const [w, hh, fontScale] of [
      [475, 751, 1],
      [475, 751, 1.15],
      [411, 960, 1],
    ] as const) {
      h.win = { width: w, height: hh, fontScale };
      const r = render(<ChartScreen />);
      measure(r, phone(w, fontScale, LONG.name, PRICE, CHANGE));
      const row = parentOf(r, nameNode(r));
      expect(row.children, `${w} ${fontScale}`).toContain(priceNode(r));
      expect(row.children, `${w} ${fontScale}`).toContain(changeNode(r));
      expect(headBox(r)).toEqual(MAIN_HEAD);
      expect(chart(r)).toEqual({ w: w - PAD, h: expectedH(hh) });
    }
  });

  it("접힌 화면 130%(폴드8·울트라): 첫 그림은 한 줄, 재 보니 이름에 네 글자도 남지 않으면 가격·등락을 둘째 줄로, 머리가 커진 만큼 차트를 줄인다", () => {
    h.stock = LONG;
    for (const [w, hh] of [
      [475, 751],
      [411, 960],
    ] as const) {
      h.win = { width: w, height: hh, fontScale: 1.3 };
      const r = render(<ChartScreen />);
      // 재기 전: 3-42 이전처럼 한 줄
      expect(header(r).children).toHaveLength(1);
      expect(headBox(r)).toEqual(MAIN_HEAD);
      measure(r, phone(w, 1.3, LONG.name, PRICE, CHANGE));
      const head = chartHeaderLayout({ fontScale: 1.3, quote: true, twoLines: true });
      // 이름 줄 = [이름, 버튼 묶음], 둘째 줄 = [가격, 등락]
      const nameRow = parentOf(r, nameNode(r));
      expect(nameRow.children).not.toContain(priceNode(r));
      expect(nameRow.children.some((c) => typeof c !== "string" && c.children.includes(r.byLabel("차트 닫기")))).toBe(true);
      const quoteRow = parentOf(r, priceNode(r));
      expect(quoteRow.children).toEqual([priceNode(r), changeNode(r)]);
      // 두 줄이 모두 머리 안에 (최소 높이 = 버튼 줄 + 가격 줄), 차트는 그만큼 낮아진다 → 도구 줄과 겹치지 않는다
      expect(header(r).children).toEqual([nameRow, quoteRow]);
      expect(headBox(r)).toEqual({ height: undefined, minHeight: head.height });
      expect(head.height).toBeGreaterThan(CHART_ICON_BTN + font.body * 1.3);
      expect(chart(r).h).toBe(Math.max(160, hh - head.height - CHROME - space.sm));
      // 두 줄 머리는 더 재지 않는다
      expect(nameNode(r).props.onLayout).toBeUndefined();
      // 두 줄로 바꾼 머리(예전이면 깨지던 경우)에서만 글자를 fontCap.chrome(150%) 까지로, 가격·등락은 한 줄로 (쪼개지지 않게)
      for (const n of [nameNode(r), priceNode(r), changeNode(r)]) {
        expect(n.props.maxFontSizeMultiplier).toBe(fontCap.chrome);
        expect(n.props.numberOfLines).toBe(1);
      }
    }
  });

  it("시세가 바뀌어도 머리가 한 줄 ↔ 두 줄로 뛰지 않는다 (울트라 접힘 115%, +990원 ↔ +1,000원). 창이 바뀌면 한 줄로 다시 재서 정한다", () => {
    const quote = (change: number, changeRate: number) => ({ price: 171500, change, changeRate, currency: "KRW" });
    const HYNIX = { code: "000660", name: "SK하이닉스", market: "KOSPI", avgPrice: null, quote: quote(990, 0.58) };
    const changeOf = (c: number, rate: number) => `${c > 0 ? "+" : ""}${c.toLocaleString("ko-KR")}원 (${rate > 0 ? "+" : ""}${rate.toFixed(2)}%)`;
    h.stock = HYNIX;
    h.win = { width: 411, height: 960, fontScale: 1.15 };
    const r = render(<ChartScreen />);
    const state = () => ({ head: headBox(r), twoLines: header(r).children.length === 2, chartH: chart(r).h });
    /** 한 줄 머리면 폰처럼 재서 알린다 (두 줄 머리는 재지 않는다) */
    const settle = (c: number, rate: number, winW = 411, fontScale = 1.15) => {
      const n = nameNode(r, HYNIX.name);
      if (n.props.onLayout) measure(r, phone(winW, fontScale, HYNIX.name, "171,500원", changeOf(c, rate)), HYNIX.name);
    };
    const one = oneLineState(960);
    const two = { head: { height: undefined, minHeight: 62 }, twoLines: true, chartH: Math.max(160, 960 - 62 - CHROME - space.sm) };
    settle(990, 0.58);
    expect(state()).toEqual(one);
    const seq: [number, number][] = [
      [1000, 0.59],
      [990, 0.58],
      [1000, 0.59],
      [0, 0],
      [-100, -0.06],
      [980, 0.57],
    ];
    const seen = seq.map(([c, rate]) => {
      h.stock = { ...HYNIX, quote: quote(c, rate) };
      r.rerender();
      settle(c, rate);
      return state();
    });
    // 예전: 62 → 44 → 62 → 44 … (차트 높이도 18dp 씩 오르내림)
    expect(seen).toEqual(seq.map(() => two));
    // 폴드8 접힘(475)으로 창이 바뀌면 한 줄로 다시 그려 잰다 → +1,000원 도 한 줄에 들어간다
    h.stock = { ...HYNIX, quote: quote(1000, 0.59) };
    h.win = { width: 475, height: 751, fontScale: 1.15 };
    r.rerender();
    expect(header(r).children).toHaveLength(1);
    settle(1000, 0.59, 475);
    expect(headBox(r)).toEqual(MAIN_HEAD);
    expect(header(r).children).toHaveLength(1);
  });

  it("잰 값 하나만 와서는 정하지 않는다 (글자 묶음·이름 둘 다 모여야)", () => {
    h.stock = LONG;
    h.win = { width: 411, height: 960, fontScale: 1.3 };
    const r = render(<ChartScreen />);
    const m = phone(411, 1.3, LONG.name, PRICE, CHANGE);
    r.act(() => (parentOf(r, nameNode(r)).props.onLayout as Layout)({ nativeEvent: { layout: { width: m.title, height: 22, x: 0, y: 0 } } }));
    expect(header(r).children).toHaveLength(1);
    r.act(() => (nameNode(r).props.onLayout as Layout)({ nativeEvent: { layout: { width: m.name, height: 22, x: 0, y: 0 } } }));
    expect(header(r).children).toHaveLength(2);
  });

  it("시세가 없으면 이름만 한 줄 (전과 같음) — 재지도 않는다", () => {
    h.stock = { ...LONG, quote: null };
    h.win = { width: 411, height: 960, fontScale: 1.5 };
    const r = render(<ChartScreen />);
    expect(priceNode(r)).toBeUndefined();
    expect(headBox(r)).toEqual(MAIN_HEAD);
    expect(nameNode(r).props.onLayout).toBeUndefined();
  });

  it("차트 칩 띠 끝은 전체 화면 바탕색(t.bg)으로 흐린다 (넓은 창만 — CandleChart 가 정한다)", () => {
    const r = render(<ChartScreen />);
    expect(r.all().find((n) => n.type === "CandleChart")!.props.backdrop).toBe(light.bg);
  });
});
