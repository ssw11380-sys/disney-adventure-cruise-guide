import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 전체 화면 차트의 '가로로 보기'(화면을 90도 돌려 그리기)가 가로 창에서 또 돌지 않는지.
 * 안드로이드 16 부터 큰 화면(펼친 접는 폰 안쪽 화면)은 앱의 세로 고정을 무시하고 가로로 돈다 → 창이 이미 가로면
 * 돌리지 않고 창을 그대로 쓴다. 세로 창에서는 전과 똑같이 돌린다.
 */
const h = vi.hoisted(() => ({
  win: { width: 400, height: 800 },
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
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
  useStock: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useCandles: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ ChangeText: "ChangeText", ErrorView: "ErrorView" }));

const { default: ChartScreen } = await import("@/app/stocks/[code]/chart");
const { space } = await import("@/tokens");

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
