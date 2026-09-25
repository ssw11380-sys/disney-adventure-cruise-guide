import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 넓은 창 공통 기반 (3-42 접는 폰, 플래그 foldLayout): 창 등급 훅 · 2단 틀(TwoPane) · 가운데 읽기 폭(Screen readable) · 탭 바.
 * 플래그가 꺼져 있으면(서버 값을 못 받았을 때 포함) 어떤 창에서도 지금 휴대폰 화면과 똑같아야 한다.
 * 탭 이름을 늘 아이콘 아래에 두는 것만은 버그 수정이라 플래그와 상관없다.
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  insets: { top: 32, bottom: 48, left: 0, right: 0 },
  /** 서버가 준 foldLayout 값 (undefined = 아직 못 받음 → fallback) */
  flag: undefined as boolean | undefined,
  featureCalls: [] as string[],
  dark: false,
  path: "/",
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", async () => {
  const R = await import("react");
  // 탭 내비게이터 대신 받은 속성(screenOptions)을 그대로 남기는 가짜
  const Tabs = Object.assign((p: Record<string, unknown>) => R.createElement("Tabs", p), { Screen: "TabsScreen" });
  return { Tabs, router: { push: vi.fn() }, usePathname: () => h.path };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return {
    ...tokens,
    useTheme: () => (h.dark ? tokens.dark : tokens.light),
    useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap),
  };
});
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => {
    h.featureCalls.push(key);
    return key === "foldLayout" ? (h.flag ?? fallback) : fallback;
  },
}));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));

const { forgetWindowClass, useFoldLayout, useWindowClass } = await import("@/lib/useFoldLayout");
const { TwoPane } = await import("@/components/TwoPane");
const { Screen } = await import("@/components/Screen");
const { default: TabsLayout } = await import("@/app/(tabs)/_layout");
const { dark, layout, light, space } = await import("@/tokens");
const { tabBarH } = await import("@/lib/textScale");
const { DETAIL_MIN, railWidth } = await import("@/lib/windowClass");

type R = ReturnType<typeof render>;
const flat = (n: HostNode, key = "style"): Record<string, unknown> => Object.assign({}, ...[n.props[key]].flat(Infinity).filter(Boolean));
const size = (width: number, height: number, fontScale = 1) => {
  h.win = { width, height, scale: 2.625, fontScale };
};

const SIZES = {
  "폴드8 접힘": [475, 751],
  "폴드8 펼침 가로": [933, 704],
  "폴드8 펼침 세로": [704, 933],
  "울트라 접힘": [411, 960],
  "울트라 펼침 세로": [859, 954],
  "울트라 펼침 가로": [954, 859],
} as const;

beforeEach(() => {
  size(475, 751);
  h.insets = { top: 32, bottom: 48, left: 0, right: 0 };
  h.flag = undefined;
  h.featureCalls.length = 0;
  h.dark = false;
  h.path = "/";
  // 앱 전체가 기억하는 전 등급을 지운다 (테스트마다 앱을 새로 연 것처럼)
  forgetWindowClass();
});

describe("창 등급 훅 (useWindowClass)", () => {
  function Probe() {
    return React.createElement("Out", { value: useWindowClass() });
  }
  const value = (r: R) => r.all().find((n) => n.type === "Out")!.props.value as ReturnType<typeof useWindowClass>;

  it("폰을 펴고 돌리면 바로 바뀐다", () => {
    const r = render(<Probe />);
    expect(value(r)).toEqual({ width: "compact", short: true, twoPane: false, rail: false });
    size(933, 704);
    r.rerender();
    expect(value(r)).toEqual({ width: "expanded", short: true, twoPane: true, rail: true });
    size(704, 933);
    r.rerender();
    expect(value(r)).toEqual({ width: "medium", short: false, twoPane: false, rail: false });
  });

  it("창을 끌어 크기를 바꿀 때 기준선 근처(816~839)에서는 전 상태를 지킨다", () => {
    size(900, 704);
    const r = render(<Probe />);
    const seen: boolean[] = [];
    for (const w of [835, 845, 820, 830, 815, 830, 839, 840]) {
      size(w, 704);
      r.rerender();
      seen.push(value(r).twoPane);
    }
    expect(seen).toEqual([true, true, true, true, false, false, false, true]);
  });

  it("여러 화면이 같은 전 상태를 본다: 기준선 근처(830)에서 새로 연 화면도 먼저 떠 있던 탭 틀과 같은 등급", () => {
    size(933, 704);
    const tabs = render(<Probe />);
    size(830, 704);
    tabs.rerender();
    expect(value(tabs)).toEqual({ width: "medium", short: true, twoPane: true, rail: true });
    // 화면별로 따로 기억하던 때는 새 화면만 {twoPane:false, rail:false} 였다
    const fresh = render(<Probe />);
    expect(value(fresh)).toEqual(value(tabs));
    expect(value(fresh)).toBe(value(tabs));
    // 816 아래로 좁아지면 둘 다 같이 꺼지고, 그 뒤 830 에서 새로 연 화면도 꺼진 채
    size(810, 704);
    tabs.rerender();
    fresh.rerender();
    expect(value(tabs)).toMatchObject({ twoPane: false, rail: false });
    expect(value(fresh)).toEqual(value(tabs));
    size(830, 704);
    tabs.rerender();
    expect(value(render(<Probe />))).toEqual(value(tabs));
    expect(value(tabs)).toMatchObject({ twoPane: false, rail: false });
  });

  it("앱을 기준선 근처 폭에서 처음 열면(기억 없음) 켜는 폭 기준 → 한 단·아래 탭", () => {
    size(830, 704);
    expect(value(render(<Probe />))).toEqual({ width: "medium", short: true, twoPane: false, rail: false });
  });

  it("등급이 같으면 같은 객체를 돌려준다 (받는 쪽이 다시 계산하지 않게)", () => {
    size(933, 704);
    const r = render(<Probe />);
    const first = value(r);
    size(950, 700);
    r.rerender();
    expect(value(r)).toBe(first);
  });
});

describe("플래그를 거친 값 (useFoldLayout)", () => {
  function Probe() {
    return React.createElement("Out", { value: useFoldLayout() });
  }
  const value = (r: R) => r.all().find((n) => n.type === "Out")!.props.value as ReturnType<typeof useFoldLayout>;
  const OFF = { width: "compact", short: false, twoPane: false, rail: false, on: false };

  it.each(Object.entries(SIZES))("서버 값을 못 받았거나(fallback 꺼짐) 꺼져 있으면 %s 도 휴대폰 화면 그대로", (_n, [w, hh]) => {
    size(w, hh);
    expect(value(render(<Probe />))).toEqual(OFF);
    h.flag = false;
    expect(value(render(<Probe />))).toEqual(OFF);
    expect(h.featureCalls).toContain("foldLayout");
  });

  it("켜지면 창 등급을 따르고, 서버가 끄면 바로 휴대폰 화면으로 돌아간다", () => {
    size(933, 704);
    h.flag = true;
    const r = render(<Probe />);
    expect(value(r)).toEqual({ width: "expanded", short: true, twoPane: true, rail: true, on: true });
    h.flag = false;
    r.rerender();
    expect(value(r)).toEqual(OFF);
  });
});

describe("2단 틀 (TwoPane)", () => {
  const panes = (r: R) => {
    const root = r.tree[0] as HostNode;
    const [left, divider, right] = root.children as HostNode[];
    return { root, left, divider, right };
  };
  const two = (props: Partial<React.ComponentProps<typeof TwoPane>> = {}) =>
    render(<TwoPane left={<Text>종목 목록</Text>} right={<Text>종목 상세</Text>} empty={<Text>왼쪽에서 종목을 고르세요</Text>} {...props} />);
  const Text = "Text" as unknown as React.ComponentType<{ children: React.ReactNode }>;

  it("왼쪽(목록) → 구분선 → 오른쪽(상세) 순서로 그린다 = 화면 읽기 순서도 왼쪽 먼저", () => {
    size(933, 704);
    const r = two();
    const { root, left, divider, right } = panes(r);
    expect(flat(root)).toMatchObject({ flex: 1, flexDirection: "row" });
    expect(root.children).toHaveLength(3);
    expect(r.text()).toBe("종목 목록종목 상세");
    expect(flat(left)).toMatchObject({ width: layout.listPaneW, flexShrink: 0 });
    expect(flat(right)).toMatchObject({ flex: 1, minWidth: 0 });
    // 구분선은 화면 읽기에서 건너뛴다
    expect(divider.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(divider.props.accessibilityElementsHidden).toBe(true);
    expect(divider.children).toHaveLength(0);
  });

  it.each([
    ["라이트", false, light.line],
    ["다크", true, dark.line],
  ])("구분선: 두께 토큰(1dp) · %s 테마 line 색", (_n, isDark, color) => {
    h.dark = isDark;
    size(933, 704);
    expect(flat(panes(two()).divider)).toMatchObject({ width: layout.divider, backgroundColor: color, alignSelf: "stretch" });
    expect(layout.divider).toBe(1);
  });

  it("오른쪽이 비면 empty 칸을 보이고, 고르면 상세로 바뀐다", () => {
    size(933, 704);
    const r = two({ right: null });
    expect(r.text()).toBe("종목 목록왼쪽에서 종목을 고르세요");
    r.rerender(<TwoPane left={<Text>종목 목록</Text>} right={<Text>종목 상세</Text>} empty={<Text>왼쪽에서 종목을 고르세요</Text>} />);
    expect(r.text()).toBe("종목 목록종목 상세");
    // empty 도 없으면 빈 칸
    expect(two({ right: undefined, empty: undefined }).text()).toBe("종목 목록");
  });

  const layoutTo = (r: R, width: number) =>
    r.act(() => (panes(r).root.props.onLayout as (e: { nativeEvent: { layout: { width: number; height: number } } }) => void)({ nativeEvent: { layout: { width, height: 600 } } }));
  const rightW = (r: R, box: number) => box - (flat(panes(r).left).width as number) - layout.divider - ((flat(panes(r).right).paddingRight as number) ?? 0);

  it("창 폭이 아니라 틀이 받은 폭(onLayout)으로 나눈다: 왼쪽 탭 막대가 켜진 폴드8 가로에서도 상세 ≥ 415", () => {
    for (const [f, left, right] of [
      [1, 400, 452],
      [1.3, 425, 415],
      [1.4, 421, 415],
      [2, 417, 415],
    ] as const) {
      size(933, 704, f);
      const r = two();
      // 재기 전 한 번은 창 폭(933)으로 어림
      expect(flat(panes(r).left).width).toBe(Math.min(Math.round(layout.listPaneW * (1 + (Math.min(f, 1.4) - 1) / 2)), 933 - layout.divider - DETAIL_MIN));
      const box = 933 - railWidth(f);
      layoutTo(r, box);
      expect(flat(panes(r).left).width).toBe(left);
      expect(rightW(r, box)).toBe(right);
      expect(rightW(r, box)).toBeGreaterThanOrEqual(DETAIL_MIN);
    }
  });

  it("틀 폭이 바뀌면(폰을 돌리거나 막대가 생기고 사라지면) 다시 나눈다 · 좌우 화면 여백은 틀 폭에서 뺀다", () => {
    size(933, 704, 1.3);
    h.insets = { top: 24, bottom: 0, left: 32, right: 48 };
    const r = two();
    // 틀 933 − 여백 80 = 853 → 목록 853 − 1 − 415 = 437 → 상한 460 아래라 437
    layoutTo(r, 933);
    expect(flat(panes(r).left)).toMatchObject({ width: 437 + 32, paddingLeft: 32 });
    expect(rightW(r, 933)).toBe(DETAIL_MIN);
    layoutTo(r, 1100);
    expect(flat(panes(r).left)).toMatchObject({ width: 460 + 32 });
  });

  it("큰 글씨에서는 목록 폭을 배율의 절반만큼 넓힌다 (130% → 460, 200% → 480 상한)", () => {
    size(933, 704, 1.3);
    expect(flat(panes(two()).left).width).toBe(460);
    size(933, 704, 2);
    expect(flat(panes(two()).left).width).toBe(480);
  });

  it("좌우 화면 여백(카메라 구멍): 왼쪽 칸은 왼쪽 여백만큼, 오른쪽 칸은 오른쪽 여백만큼 안쪽으로", () => {
    size(933, 704);
    h.insets = { top: 24, bottom: 0, left: 32, right: 48 };
    const { left, right } = panes(two());
    expect(flat(left)).toMatchObject({ width: layout.listPaneW + 32, paddingLeft: 32 });
    expect(flat(right)).toMatchObject({ paddingRight: 48 });
    // 왼쪽 세로 탭 막대가 이미 왼쪽 여백을 차지하는 탭 화면에서는 더하지 않는다
    const noInset = panes(two({ insetLeft: false }));
    expect(flat(noInset.left)).toMatchObject({ width: layout.listPaneW, paddingLeft: 0 });
  });
});

describe("가운데 읽기 폭 (Screen readable)", () => {
  const Child = "Card" as unknown as React.ComponentType<{ children?: React.ReactNode }>;
  const content = (r: R) => flat(r.all().find((n) => n.type === "ScrollView")!, "contentContainerStyle");
  const shot = (el: React.ReactElement) => {
    const r = render(el);
    return { scroll: content(r), calls: [...h.featureCalls] };
  };

  it("readable 을 쓰지 않는 화면은 플래그를 읽지도 않고 지금과 같다", () => {
    h.flag = true;
    size(933, 704);
    const r = render(
      <Screen>
        <Child />
      </Screen>,
    );
    expect(h.featureCalls).toEqual([]);
    expect(content(r)).toEqual({ paddingBottom: space.xl, gap: space.sm });
  });

  it.each(Object.entries(SIZES))("플래그가 꺼져 있으면 %s 에서도 readable 이 없는 것과 똑같다", (_n, [w, hh]) => {
    size(w, hh);
    h.flag = false;
    const plain = shot(<Screen contentStyle={{ paddingHorizontal: space.lg }}>{null}</Screen>).scroll;
    expect(shot(<Screen readable contentStyle={{ paddingHorizontal: space.lg }}>{null}</Screen>).scroll).toEqual(plain);
    expect(plain).not.toHaveProperty("maxWidth");
  });

  it("켜져 있어도 좁은 창(접힌 화면)은 그대로", () => {
    h.flag = true;
    for (const [w, hh] of [SIZES["폴드8 접힘"], SIZES["울트라 접힘"]]) {
      size(w, hh);
      expect(shot(<Screen readable>{null}</Screen>).scroll).toEqual({ paddingBottom: space.xl, gap: space.sm });
    }
  });

  it("켜져 있고 폭이 중간 이상이면 가운데 최대 720dp 로 모은다 (부르는 쪽 여백은 그대로)", () => {
    h.flag = true;
    for (const [w, hh] of [SIZES["폴드8 펼침 세로"], SIZES["폴드8 펼침 가로"], SIZES["울트라 펼침 세로"]]) {
      size(w, hh);
      const s = shot(<Screen readable contentStyle={{ paddingHorizontal: space.lg }}>{null}</Screen>).scroll;
      expect(s).toEqual({ paddingBottom: space.xl, gap: space.sm, paddingHorizontal: space.lg, width: "100%", maxWidth: layout.readableMax, alignSelf: "center" });
    }
    expect(layout.readableMax).toBe(720);
  });

  it("scroll=false 화면(목록을 직접 그리는 화면)도 같은 폭으로", () => {
    h.flag = true;
    size(933, 704);
    const r = render(
      <Screen readable scroll={false}>
        <Child />
      </Screen>,
    );
    const inner = r.all().find((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.type === "Card"))!;
    expect(flat(inner)).toMatchObject({ flex: 1, maxWidth: layout.readableMax, alignSelf: "center" });
  });

  it("고지 한 줄은 폭 제한 밖(화면 전체 폭)에 그대로 붙는다", () => {
    h.flag = true;
    size(933, 704);
    const r = render(
      <Screen readable disclaimer>
        {null}
      </Screen>,
    );
    expect(r.text()).toContain("투자 권유가 아닙니다");
  });
});

describe("탭 바", () => {
  const opts = (r: R) => r.all().find((n) => n.type === "Tabs")!.props.screenOptions as Record<string, unknown>;
  const tabs = () => opts(render(<TabsLayout />));
  /** 이번 변경 전 아래 탭 바 모양 (플래그가 꺼져 있으면 이것과 같아야 한다) */
  const bottomStyle = (t = light, scale = 1) => ({ backgroundColor: t.surface, borderTopColor: t.line, height: tabBarH(scale) + h.insets.bottom, paddingTop: space.s, paddingBottom: h.insets.bottom + space.s });

  it.each(Object.entries(SIZES))("탭 이름은 늘 아이콘 아래 — 플래그가 꺼져 있어도 (%s, 버그 수정)", (_n, [w, hh]) => {
    size(w, hh);
    h.flag = false;
    const o = tabs();
    expect(o.tabBarLabelPosition).toBe("below-icon");
    // 그 밖에는 지금과 같다: 아래 탭 바, 같은 높이·색
    expect(o).not.toHaveProperty("tabBarPosition");
    expect(o).not.toHaveProperty("tabBarVariant");
    expect(o).not.toHaveProperty("tabBarActiveBackgroundColor");
    expect(o.tabBarStyle).toEqual(bottomStyle());
    expect(o.sceneStyle).toEqual({ backgroundColor: light.bg });
    expect(o).not.toHaveProperty("headerLeftContainerStyle");
  });

  it("플래그를 아직 못 받았을 때(fallback 꺼짐)도 펼친 가로 창에서 아래 탭 바", () => {
    size(933, 704);
    expect(tabs().tabBarStyle).toEqual(bottomStyle());
  });

  it("켜져 있으면 넓고 높이가 짧은 창(폴드8 펼침 가로)만 왼쪽 세로 막대", () => {
    h.flag = true;
    h.insets = { top: 24, bottom: 0, left: 32, right: 0 };
    size(933, 704);
    const o = tabs();
    expect(o.tabBarPosition).toBe("left");
    // 세로 막대에서 '아이콘 아래 이름'은 material 모양에서만 된다 (uikit 이면 라이브러리가 오류)
    expect(o.tabBarVariant).toBe("material");
    expect(o.tabBarLabelPosition).toBe("below-icon");
    expect(o.tabBarActiveBackgroundColor).toBe(light.surfaceAlt);
    // 높이·위아래 여백을 주지 않는다 (막대가 화면 높이를 다 쓰고, 라이브러리가 화면 여백을 더한다). 폭에는 왼쪽 여백을 더한다
    expect(o.tabBarStyle).toEqual({ backgroundColor: light.surface, borderColor: light.line, width: layout.railW + 32 });
    // 머리의 왼쪽 여백은 막대가 이미 차지 → 라이브러리가 머리 왼쪽에 더하는 여백(marginStart: 왼쪽 여백)을 뺀다
    expect(o.headerLeftContainerStyle).toEqual({ marginStart: 0 });
  });

  it("세로 막대일 때 탭 화면 아래에 시스템 내비게이션 바 여백을 둔다 (고지 한 줄·목록 끝이 그 밑에 깔리지 않게)", () => {
    h.flag = true;
    h.insets = { top: 24, bottom: 48, left: 0, right: 0 };
    size(933, 704);
    const o = tabs();
    expect(o.tabBarPosition).toBe("left");
    expect(o.sceneStyle).toEqual({ backgroundColor: light.bg, paddingBottom: 48 });
    // 다크 테마도 같은 여백, 배경만 다크
    h.dark = true;
    expect(tabs().sceneStyle).toEqual({ backgroundColor: dark.bg, paddingBottom: 48 });
  });

  it.each([0, 24, 48])("어떤 창·플래그에서도 시스템 내비게이션 바(아래 여백 %ddp) 자리를 아래 탭 바나 탭 화면 여백 중 하나가 딱 한 번 맡는다", (bottom) => {
    h.insets = { top: 24, bottom, left: 0, right: 0 };
    for (const flag of [undefined, false, true])
      for (const [w, hh] of [...Object.values(SIZES), [840, 600], [1200, 700]] as [number, number][]) {
        h.flag = flag;
        forgetWindowClass();
        size(w, hh);
        const o = tabs();
        const scene = o.sceneStyle as { paddingBottom?: number };
        const bar = o.tabBarStyle as { paddingBottom?: number };
        if (o.tabBarPosition === "left") {
          expect(scene.paddingBottom).toBe(bottom);
          expect(bar.paddingBottom).toBeUndefined();
        } else {
          expect(scene.paddingBottom).toBeUndefined();
          expect(bar.paddingBottom).toBe(bottom + space.s);
        }
      }
  });

  it("브리핑 탭 고지 한 줄: 세로 막대일 때 아래 여백 = 탭 화면 여백(시스템 바) + 고지 자체 여백", () => {
    h.flag = true;
    h.insets = { top: 24, bottom: 48, left: 0, right: 0 };
    h.path = "/briefings";
    size(933, 704);
    const scene = tabs().sceneStyle as { paddingBottom: number };
    const r = render(
      <Screen disclaimer>
        {null}
      </Screen>,
    );
    const note = r.all().find((n) => n.type === "View" && typeof flat(n).borderTopWidth === "number")!;
    // 탭 안 고지는 작은 여백만 두고(아래 탭 바·탭 화면 여백이 시스템 바를 맡는다), 탭 화면 여백이 시스템 바 48 을 비운다
    expect(flat(note).paddingBottom).toBe(space.sm);
    expect(scene.paddingBottom + (flat(note).paddingBottom as number)).toBe(48 + space.sm);
  });

  it.each(["폴드8 접힘", "폴드8 펼침 세로", "울트라 접힘", "울트라 펼침 세로", "울트라 펼침 가로"] as const)("켜져 있어도 %s 은 아래 탭 바 그대로", (name) => {
    h.flag = true;
    size(...(SIZES[name] as unknown as [number, number]));
    const o = tabs();
    expect(o).not.toHaveProperty("tabBarPosition");
    expect(o.tabBarStyle).toEqual(bottomStyle());
  });

  it("큰 글씨(150% 이상)는 세로 막대를 넓힌다 · 다크 테마 색", () => {
    h.flag = true;
    h.dark = true;
    size(933, 704, 1.5);
    const o = tabs();
    expect(o.tabBarStyle).toEqual({ backgroundColor: dark.surface, borderColor: dark.line, width: 100 });
    expect(o.tabBarActiveBackgroundColor).toBe(dark.surfaceAlt);
  });

  it("세로 막대를 쓰면 늘 material 모양이다 (어떤 크기·글자에서도 라이브러리 오류 조합이 없다)", () => {
    h.flag = true;
    for (const [w, hh] of [...Object.values(SIZES), [840, 600], [1200, 700], [816, 500]] as [number, number][])
      for (const f of [1, 1.3, 2]) {
        size(w, hh, f);
        const o = tabs();
        if (o.tabBarPosition === "left" || o.tabBarPosition === "right") expect(o.tabBarVariant).toBe("material");
        else expect(o.tabBarVariant).toBeUndefined();
      }
  });

  it("탭 4개와 화면 읽기 이름은 그대로", () => {
    h.flag = true;
    size(933, 704);
    const r = render(<TabsLayout />);
    const screens = r.all().filter((n) => n.type === "TabsScreen");
    expect(screens.map((n) => n.props.name)).toEqual(["index", "discover", "briefings", "settings"]);
    expect(screens.map((n) => (n.props.options as { tabBarAccessibilityLabel: string }).tabBarAccessibilityLabel)).toEqual(["잔고", "발견", "브리핑", "설정"]);
  });
});
