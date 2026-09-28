import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERO_MS, heroFrame, heroLayout, heroScene, type LoginLayout } from "@/lib/loginHero";
import { authLayout } from "@/tokens";
import { flatStyle, visibleBox, type FakeLoop, type FakeTiming, type makeFakeAnimated } from "./fakeAnimated";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * <LoginHero/> 움직이는 그림 (hero-spec.md 7·8장). RN Animated 는 계산하는 가짜(fakeAnimated)로 바꿔,
 *  - 시계가 t 일 때 화면에 놓이는 자리·불투명도가 순수 함수 heroFrame 과 같은지 (0.5·1.5·2.5·3.6·4.2초)
 *  - 처음 한 번 재생(네이티브 드라이버) → 숨쉬기, 두 번째로 보이면 마지막 장면, 누르면 다시 한 번
 *  - 움직임 줄이기 → 마지막 장면에 멈춤, 키보드로 접힘·앱이 뒤로·크기 바뀜 → 마지막 장면
 *  - 로고 글자는 입력 칸과 겹치지 않는다 (AuthFrame 네 크기)
 */
const h = vi.hoisted(() => ({
  reduce: false,
  reduceListeners: [] as ((v: boolean) => void)[],
  appListeners: [] as ((s: string) => void)[],
  fake: null as unknown as ReturnType<typeof makeFakeAnimated>,
  win: { width: 360, height: 752, scale: 3, fontScale: 1 },
}));

vi.mock("react-native", async () => {
  const { makeFakeAnimated } = await import("./fakeAnimated");
  h.fake = makeFakeAnimated();
  return {
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    ActivityIndicator: "ActivityIndicator",
    Animated: h.fake.Animated,
    Easing: h.fake.Easing,
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 } },
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(h.reduce),
      addEventListener: (_: string, cb: (v: boolean) => void) => {
        h.reduceListeners.push(cb);
        return { remove: () => void h.reduceListeners.splice(h.reduceListeners.indexOf(cb), 1) };
      },
      announceForAccessibility: () => undefined,
    },
    AppState: {
      currentState: "active",
      addEventListener: (_: string, cb: (s: string) => void) => {
        h.appListeners.push(cb);
        return { remove: () => void h.appListeners.splice(h.appListeners.indexOf(cb), 1) };
      },
    },
    Platform: { OS: "android" },
    useWindowDimensions: () => h.win,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 28, bottom: 24, left: 0, right: 0 }) }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Defs: "Defs", Ellipse: "Ellipse", LinearGradient: "SvgLinearGradient", Line: "Line", RadialGradient: "RadialGradient", Rect: "Rect", Stop: "Stop", Text: "SvgText" }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));

const { LoginHero, resetLoginHeroForTests } = await import("@/components/auth/LoginHero");
const { AuthFrame } = await import("@/components/auth/AuthFrame");

type Screen = ReturnType<typeof render>;
const settle = async (r: Screen) => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const byTest = (r: Screen, id: string): HostNode => {
  const hits = r.all().filter((n) => n.props.testID === id);
  if (hits.length !== 1) throw new Error(`${id} 가 ${hits.length}개`);
  return hits[0]!;
};
const countTest = (r: Screen, re: RegExp) => r.all().filter((n) => typeof n.props.testID === "string" && re.test(n.props.testID as string)).length;
const style = (n: HostNode) => flatStyle(n.props.style);
/** 시계(Animated.Value)를 쓰는 재생: timing 중 toValue 4200 인 것 */
const intros = () => h.fake.started.filter((a): a is FakeTiming => a.kind === "timing" && a.config.toValue === HERO_MS);
const loops = () => h.fake.started.filter((a): a is FakeLoop => a.kind === "loop");
const L360 = () => heroLayout(360, 752, { top: 28, bottom: 24 });

beforeEach(() => {
  cleanupRenders();
  resetLoginHeroForTests();
  h.reduce = false;
  h.reduceListeners.length = 0;
  h.appListeners.length = 0;
  h.fake.started.length = 0;
  h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
});
afterEach(() => cleanupRenders());

describe("그림 구성", () => {
  it("횡보 16 · 상한가 10 · 불기둥 3 · 뜨거운 점, 로고는 '가즈아 불기둥' 머리글, 그림은 화면 읽기에서 뺀다", () => {
    const r = render(<LoginHero layout={L360()} at={HERO_MS} />);
    expect(countTest(r, /^hero-side-\d+$/)).toBe(16);
    expect(countTest(r, /^hero-limit-\d+$/)).toBe(10);
    expect(countTest(r, /^hero-flame-\d+$/)).toBe(3);
    expect(countTest(r, /^hero-core$/)).toBe(1);
    const logo = r.byLabel("가즈아 불기둥");
    expect(logo.props.accessibilityRole).toBe("header");
    const art = r.all().find((n) => n.props.importantForAccessibility === "no-hide-descendants" && n.children.some((c) => typeof c !== "string" && c.props.testID === "hero-glow"));
    expect(art).toBeTruthy();
    // 다시 재생용 누르는 곳은 화면 읽기에 따로 잡히지 않는다 (로고 머리글은 그대로 읽힘)
    expect(byTest(r, "login-hero-replay").props.accessible).toBe(false);
    // 그림 영역 크기 = 배치 (한 칸: 화면 폭 × 그림 높이)
    expect(byTest(r, "login-hero").props.style).toMatchObject({ width: 360, height: 308 });
    // 부제는 사실만
    expect(r.text()).toContain("시세 · 브리핑 · 지표");
    expect(r.text()).not.toMatch(/수익|추천|보장|대박|%|!/);
  });
});

describe("시계가 t 일 때 보이는 모습 = heroFrame (0.5·1.5·2.5·3.6·4.2초, 네 크기)", () => {
  const cases: [number, number, number, number][] = [
    [360, 752, 28, 24],
    [475, 751, 28, 24],
    [933, 704, 24, 16],
    [704, 933, 28, 24],
  ];
  for (const [W, H, top, bottom] of cases) {
    it(`${W}×${H}`, () => {
      const L = heroLayout(W, H, { top, bottom });
      const scene = heroScene(L);
      for (const t of [0, 500, 1500, 2500, 3600, HERO_MS]) {
        const r = render(<LoginHero layout={L} at={t} />);
        const want = Object.fromEntries(heroFrame(scene, t).map((x) => [x.id, x]));
        scene.side.forEach((_, i) => {
          const got = visibleBox(style(byTest(r, `hero-side-${i}`)));
          const w = want[`side${i}`]!;
          expect(got.y, `t=${t} side${i}`).toBeCloseTo(w.rect.y, 6);
          expect(got.h, `t=${t} side${i}`).toBeCloseTo(w.rect.h, 6);
          expect(got.opacity).toBeCloseTo(w.opacity, 6);
        });
        scene.limit.forEach((c, k) => {
          const group = style(byTest(r, `hero-limit-${k}`));
          expect(group.opacity, `t=${t} limit${k}`).toBeCloseTo(want[`limit${k}`]!.opacity, 6);
          const got = visibleBox(style(byTest(r, `hero-body-${k}`)), group.top as number);
          expect(got.y, `t=${t} limit${k}`).toBeCloseTo(want[`limit${k}`]!.rect.y, 6);
          expect(got.h, `t=${t} limit${k}`).toBeCloseTo(want[`limit${k}`]!.rect.h, 6);
          // 아래(시가) 끝은 늘 제자리
          expect(got.y + got.h).toBeCloseTo(c.body.y + c.body.h, 6);
          expect(style(byTest(r, `hero-cap-${k}`)).opacity).toBeCloseTo(want[`cap${k}`]!.opacity / Math.max(want[`limit${k}`]!.opacity, 1e-9) || 0, 6);
        });
        scene.flames.forEach((_, i) => {
          const got = visibleBox(style(byTest(r, `hero-flame-${i}`)));
          const w = want[`flame${i}`]!;
          expect(got.y, `t=${t} flame${i}`).toBeCloseTo(w.rect.y, 6);
          expect(got.h).toBeCloseTo(w.rect.h, 6);
          expect(got.opacity).toBeCloseTo(w.opacity, 6);
        });
        expect(style(byTest(r, "hero-glow")).opacity).toBeCloseTo(want.glow!.opacity, 6);
        expect(style(byTest(r, "hero-core")).opacity).toBeCloseTo(want.core!.opacity, 6);
        const word = style(byTest(r, "hero-logo-word"));
        expect(word.opacity).toBeCloseTo(want.logo!.opacity, 6);
        expect((word.transform as { translateY: number }[])[0]!.translateY).toBeCloseTo(want.logo!.rect.y - scene.logo.y, 6);
        const line = style(byTest(r, "hero-logo-line"));
        expect(line.opacity).toBeCloseTo(want.line!.opacity, 6);
        cleanupRenders();
      }
    });
  }
});

describe("재생 · 숨쉬기 · 움직임 줄이기", () => {
  it("처음 보일 때 한 번: 0.22초 뒤 4.2초 재생(네이티브 드라이버, 상호작용을 막지 않음) → 끝나면 숨쉬기 3.6초 반복", async () => {
    const r = render(<LoginHero layout={L360()} />);
    // 움직임 줄이기 설정을 받기 전에는 시작하지 않는다
    expect(intros()).toHaveLength(0);
    await settle(r);
    expect(intros()).toHaveLength(1);
    expect(intros()[0]!.config).toMatchObject({ toValue: HERO_MS, duration: HERO_MS, delay: 220, useNativeDriver: true, isInteraction: false });
    // 시작 전(0초): 봉·로고가 보이지 않는다
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(0);
    expect(style(byTest(r, "hero-logo-word")).opacity).toBe(0);
    expect(loops()).toHaveLength(0);
    r.act(() => intros()[0]!.finish());
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
    expect(loops()).toHaveLength(1);
    expect(loops()[0]!.inner.config).toMatchObject({ toValue: 1, duration: 3600, useNativeDriver: true, isInteraction: false });
    // 두 번째로 보이면(로그아웃 뒤 등) 재생 없이 마지막 장면 + 숨쉬기
    cleanupRenders();
    const again = render(<LoginHero layout={L360()} />);
    await settle(again);
    expect(intros()).toHaveLength(1);
    expect(loops()).toHaveLength(2);
    expect(style(byTest(again, "hero-limit-9")).opacity).toBe(1);
  });

  it("그림을 누르면 한 번 다시 재생 (기다림 없이), 재생 중에 또 누르면 무시", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    r.act(() => intros()[0]!.finish());
    const firstLoop = loops()[0]!;
    r.act(() => (byTest(r, "login-hero-replay").props.onPress as () => void)());
    expect(intros()).toHaveLength(2);
    expect(intros()[1]!.config.delay).toBe(0);
    expect(firstLoop.stopped).toBe(true);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(0);
    r.act(() => (byTest(r, "login-hero-replay").props.onPress as () => void)());
    expect(intros()).toHaveLength(2);
    r.act(() => intros()[1]!.finish());
    expect(loops()).toHaveLength(2);
  });

  it("움직임 줄이기: 재생·숨쉬기 없이 처음부터 마지막 장면, 눌러도 다시 재생하지 않음", async () => {
    h.reduce = true;
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    expect(h.fake.started).toHaveLength(0);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
    expect(visibleBox(style(byTest(r, "hero-body-9"))).h).toBeCloseTo(heroScene(L360()).limit[9]!.body.h, 6);
    expect(style(byTest(r, "hero-logo-word")).opacity).toBe(1);
    expect(style(byTest(r, "hero-glow")).opacity).toBe(1);
    r.act(() => (byTest(r, "login-hero-replay").props.onPress as () => void)());
    expect(h.fake.started).toHaveLength(0);
  });

  it("재생 중에 움직임 줄이기를 켜면 바로 마지막 장면에 멈춘다", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    const intro = intros()[0]!;
    r.act(() => h.reduceListeners.forEach((f) => f(true)));
    expect(intro.stopped).toBe(true);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
    expect(loops()).toHaveLength(0);
  });

  it("키보드로 접히면 로고 한 줄(22)만 — 재생 중이었으면 멈추고, 펼치면 다시 재생하지 않고 마지막 장면 + 숨쉬기", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    const intro = intros()[0]!;
    const folded = heroLayout(360, 752, { top: 28, bottom: 24 }, true);
    r.rerender(<LoginHero layout={folded} />);
    expect(intro.stopped).toBe(true);
    expect(countTest(r, /^hero-side-/)).toBe(0);
    expect(r.byLabel("가즈아 불기둥")).toBeTruthy();
    expect(r.all().find((n) => n.type === "SvgText")!.props.fontSize).toBe(22);
    expect(byTest(r, "login-hero").props.style).toMatchObject({ height: 100 });
    r.rerender(<LoginHero layout={L360()} />);
    expect(intros()).toHaveLength(1);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
    expect(loops().filter((l) => !l.stopped)).toHaveLength(1);
  });

  it("앱이 뒤로 가면 숨쉬기를 멈추고, 돌아오면 다시", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    r.act(() => intros()[0]!.finish());
    const breathing = loops()[0]!;
    r.act(() => h.appListeners.forEach((f) => f("background")));
    expect(breathing.stopped).toBe(true);
    r.act(() => h.appListeners.forEach((f) => f("active")));
    expect(loops()).toHaveLength(2);
    expect(loops()[1]!.stopped).toBe(false);
  });

  it("창 크기가 바뀌면(접기·펴기) 자리만 새로, 재생 중이었으면 마지막 장면으로", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    const intro = intros()[0]!;
    r.rerender(<LoginHero layout={heroLayout(933, 704, { top: 24, bottom: 16 })} />);
    expect(intro.stopped).toBe(true);
    expect(intros()).toHaveLength(1);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
    expect(byTest(r, "login-hero").props.style).toMatchObject({ width: 513, height: 704 });
  });

  it("같은 배치로 다시 그려도(입력할 때마다) 움직임 노드를 새로 만들지 않는다", async () => {
    const L = L360();
    const r = render(<LoginHero layout={L} />);
    await settle(r);
    const before = byTest(r, "hero-side-3").props.style;
    r.rerender(<LoginHero layout={{ ...L, plot: { ...L.plot } }} />);
    const after = byTest(r, "hero-side-3").props.style as { opacity: unknown };
    expect(after.opacity).toBe((before as { opacity: unknown }).opacity);
    expect(intros()).toHaveLength(1);
    expect(intros()[0]!.stopped).toBe(false);
  });

  it("animate={false}(회원가입 두 칸): 움직임 없이 마지막 장면", async () => {
    const r = render(<LoginHero layout={heroLayout(933, 704, { top: 24, bottom: 16 })} animate={false} />);
    await settle(r);
    expect(h.fake.started).toHaveLength(0);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
  });
});

describe("로고 글자는 입력 칸과 겹치지 않는다 (AuthFrame 네 크기)", () => {
  const sizes: [number, number][] = [
    [360, 752],
    [475, 751],
    [933, 704],
    [704, 933],
  ];
  for (const [W, H] of sizes) {
    it(`${W}×${H}`, () => {
      h.win = { width: W, height: H, scale: 2.6, fontScale: 1 };
      const r = render(
        <AuthFrame top="hero">
          <></>
        </AuthFrame>,
      );
      const hero = byTest(r, "login-hero").props.style as { width: number; height: number };
      const logo = flatStyle(r.byLabel("가즈아 불기둥").props.style) as { left: number; top: number; width: number; height: number };
      const L: LoginLayout = heroLayout(W, H, { top: 28, bottom: 24 });
      // 한 칸: 로고 묶음 아래 끝 ≤ 그림 높이(입력 묶음은 그 아래 8dp 부터), 두 칸: 로고 오른쪽 끝 ≤ 그림 폭(입력 칸은 오른쪽 420)
      expect(logo.top + logo.height).toBeLessThanOrEqual(hero.height);
      if (L.mode === "two") expect(logo.left + logo.width).toBeLessThanOrEqual(hero.width);
      else expect(logo.left).toBe(L.formX);
      expect(logo.height).toBe(heroScene(L).logo.h);
      expect(authLayout.heroGap).toBeGreaterThan(0);
    });
  }
});
