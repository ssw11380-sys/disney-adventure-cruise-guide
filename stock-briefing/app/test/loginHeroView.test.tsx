import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERO_MS, HERO_START_DELAY_MS, heroFrame, heroLayout, heroScene, type LoginLayout } from "@/lib/loginHero";
import { authLayout } from "@/tokens";
import { flatStyle, visibleBox, type FakeLoop, type FakeTiming, type makeFakeAnimated } from "./fakeAnimated";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * <LoginHero/> 움직이는 그림 (hero-spec.md 7·8장). RN Animated 는 계산하는 가짜(fakeAnimated)로 바꿔,
 *  - 시계가 t 일 때 화면에 놓이는 자리·불투명도가 순수 함수 heroFrame 과 같은지 (0.5·1.5·2.5·3.6·4.2초)
 *  - 처음 한 번 재생(네이티브 드라이버) → 숨쉬기, 두 번째로 보이면 마지막 장면, 눌러도 다시 재생하지 않음 (누르는 곳이 없다)
 *  - 움직임 줄이기·앱이 뒤로·크기 바뀜 → 마지막 장면, paused(키보드로 밀려남·가려짐) → 숨쉬기만 멈춤 (재생은 끝까지, 그림 자리는 그대로)
 *  - 키보드가 떠도 AuthFrame 은 그림을 접지 않는다 (입력 칸이 한순간에 뛰지 않게) — 아래만 비우고, 내려가면 제자리로 스크롤한 뒤 없앤다
 *  - 로고 글자는 입력 칸과 겹치지 않는다 (AuthFrame 네 크기)
 */
const h = vi.hoisted(() => ({
  reduce: false,
  reduceListeners: [] as ((v: boolean) => void)[],
  appListeners: [] as ((s: string) => void)[],
  kb: {} as Record<string, (e?: { endCoordinates?: { height: number } }) => void>,
  fake: null as unknown as ReturnType<typeof makeFakeAnimated>,
  win: { width: 360, height: 752, scale: 3, fontScale: 1 },
  /** PixelRatio.roundToNearestPixel (기본은 그대로 — 픽셀 맞춤 테스트에서만 바꾼다) */
  snap: (v: number) => v,
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
    Keyboard: {
      addListener: (ev: string, cb: (e?: { endCoordinates?: { height: number } }) => void) => {
        h.kb[ev] = cb;
        return { remove: () => void delete h.kb[ev] };
      },
    },
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
    PixelRatio: { roundToNearestPixel: (v: number) => h.snap(v) },
    useWindowDimensions: () => h.win,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 28, bottom: 24, left: 0, right: 0 }) }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Defs: "Defs", Ellipse: "Ellipse", LinearGradient: "SvgLinearGradient", Line: "Line", Mask: "Mask", Path: "Path", RadialGradient: "RadialGradient", Rect: "Rect", Stop: "Stop", Text: "SvgText" }));
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
  for (const k of Object.keys(h.kb)) delete h.kb[k];
  h.fake.started.length = 0;
  h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
  h.snap = (v) => v;
});
afterEach(() => cleanupRenders());

describe("그림 구성", () => {
  it("횡보 16 · 상한가 10 · 불기둥 하나(마지막 봉), 로고는 '가즈아 불기둥' 머리글, 그림은 화면 읽기에서 뺀다", () => {
    const r = render(<LoginHero layout={L360()} at={HERO_MS} />);
    expect(countTest(r, /^hero-side-\d+$/)).toBe(16);
    expect(countTest(r, /^hero-limit-\d+$/)).toBe(10);
    expect(countTest(r, /^hero-pillar$/)).toBe(1);
    expect(countTest(r, /^hero-flame-\d+$|^hero-core$|^hero-grid-lead$/)).toBe(0);
    const logo = r.byLabel("가즈아 불기둥");
    expect(logo.props.accessibilityRole).toBe("header");
    const art = r.all().find((n) => n.props.importantForAccessibility === "no-hide-descendants" && n.children.some((c) => typeof c !== "string" && c.props.testID === "hero-glow"));
    expect(art).toBeTruthy();
    // 누르는 곳이 없다 — 한 번 잘못 눌러 로고·봉이 사라졌다 다시 그려지지 않게 (예전 '누르면 다시 재생' 뺌)
    expect(r.all().filter((n) => n.type === "Pressable" || typeof n.props.onPress === "function")).toHaveLength(0);
    expect(r.all().filter((n) => n.props.testID === "login-hero-replay")).toHaveLength(0);
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
      for (const t of [0, 500, 800, 1500, 2500, 3600, 3900, HERO_MS]) {
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
        const pillar = visibleBox(style(byTest(r, "hero-pillar")));
        expect(pillar.y, `t=${t} pillar`).toBeCloseTo(want.pillar!.rect.y, 6);
        expect(pillar.h, `t=${t} pillar`).toBeCloseTo(want.pillar!.rect.h, 6);
        expect(pillar.x).toBeCloseTo(want.pillar!.rect.x, 6);
        expect(pillar.opacity).toBeCloseTo(want.pillar!.opacity, 6);
        // 불기둥 아래 끝은 늘 제자리 (마지막 봉 종가에서 위로 솟는다)
        if (want.pillar!.opacity > 0) expect(pillar.y + pillar.h).toBeCloseTo(scene.pillar.base, 6);
        expect(style(byTest(r, "hero-glow")).opacity).toBeCloseTo(want.glow!.opacity, 6);
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
    expect(intros()[0]!.config).toMatchObject({ toValue: HERO_MS, duration: HERO_MS, delay: HERO_START_DELAY_MS, useNativeDriver: true, isInteraction: false });
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

  it("움직임 줄이기: 재생·숨쉬기 없이 처음부터 마지막 장면", async () => {
    h.reduce = true;
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    expect(h.fake.started).toHaveLength(0);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
    expect(visibleBox(style(byTest(r, "hero-body-9"))).h).toBeCloseTo(heroScene(L360()).limit[9]!.body.h, 6);
    expect(style(byTest(r, "hero-logo-word")).opacity).toBe(1);
    expect(style(byTest(r, "hero-glow")).opacity).toBe(1);
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

  it("paused(키보드로 밀려남·가려짐): 재생 중이면 끝까지 두고 그림은 그대로, 숨쉬기는 멈췄다가 풀리면 다시", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    const intro = intros()[0]!;
    r.rerender(<LoginHero layout={L360()} paused />);
    // 재생은 멈추지 않는다 (마지막 장면으로 건너뛰지도 않는다 — 한순간에 바뀌지 않게), 그림·로고는 그대로
    expect(intro.stopped).toBe(false);
    expect(countTest(r, /^hero-side-\d+$/)).toBe(16);
    expect(byTest(r, "login-hero").props.style).toMatchObject({ width: 360, height: 308 });
    r.act(() => intro.finish());
    expect(loops()).toHaveLength(0);
    r.rerender(<LoginHero layout={L360()} />);
    expect(loops()).toHaveLength(1);
    const breathing = loops()[0]!;
    r.rerender(<LoginHero layout={L360()} paused />);
    expect(breathing.stopped).toBe(true);
    expect(intros()).toHaveLength(1);
    expect(style(byTest(r, "hero-limit-9")).opacity).toBe(1);
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

describe("AuthFrame 키보드 (접지 않고 스크롤로 밀어낸다)", () => {
  const bottomPad = (r: Screen) => {
    const sv = r.all().find((n) => n.type === "ScrollView")!;
    return flatStyle(sv.props.contentContainerStyle).paddingBottom as number;
  };
  it("키보드가 떠도 그림 높이·봉·로고는 그대로 (입력 칸이 뛰지 않게), 아래만 키보드 높이만큼 비우고 숨쉬기를 멈춘다. 내려가면 제자리로 스크롤한 뒤 빈 곳을 없앤다", async () => {
    const r = render(
      <AuthFrame top="hero">
        <></>
      </AuthFrame>,
    );
    await settle(r);
    r.act(() => intros()[0]!.finish());
    expect(loops()).toHaveLength(1);
    const before = { hero: byTest(r, "login-hero").props.style, pad: bottomPad(r) };
    r.act(() => h.kb["keyboardDidShow"]!({ endCoordinates: { height: 300 } }));
    expect(byTest(r, "login-hero").props.style).toEqual(before.hero);
    expect(countTest(r, /^hero-side-\d+$/)).toBe(16);
    expect(r.byLabel("가즈아 불기둥")).toBeTruthy();
    expect(bottomPad(r)).toBe(before.pad + 300);
    expect(loops()[0]!.stopped).toBe(true);
    r.act(() => h.kb["keyboardDidHide"]!());
    // 제자리로 스크롤하는 동안은 빈 곳을 남긴다 (한 번에 튀지 않게), 숨쉬기는 다시
    expect(bottomPad(r)).toBe(before.pad + 300);
    expect(loops().filter((l) => !l.stopped)).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 340));
    r.rerender();
    expect(bottomPad(r)).toBe(before.pad);
    expect(byTest(r, "login-hero").props.style).toEqual(before.hero);
  });

  it("두 칸(933×704)은 키보드가 떠도 그림이 보이므로 숨쉬기를 멈추지 않는다, covered(가려짐)면 멈춘다", async () => {
    h.win = { width: 933, height: 704, scale: 2.6, fontScale: 1 };
    const r = render(
      <AuthFrame top="hero">
        <></>
      </AuthFrame>,
    );
    await settle(r);
    r.act(() => intros()[0]!.finish());
    r.act(() => h.kb["keyboardDidShow"]!({ endCoordinates: { height: 300 } }));
    expect(loops().filter((l) => !l.stopped)).toHaveLength(1);
    r.rerender(
      <AuthFrame top="hero" covered>
        <></>
      </AuthFrame>,
    );
    expect(loops().filter((l) => !l.stopped)).toHaveLength(0);
  });
});

describe("불기둥 모양·색 (검증 4차 — 세로 빛 기둥: 뾰족한 끝·부풂·아래 크림 심지 없이)", () => {
  it("모양 선(Path) 없이 같은 폭의 사각형 둘(붉은 빛 · 가운데 따뜻한 흰 심)을 세로 가림으로 옅게 — 아래 끝·위 끝은 투명, 양옆도 투명", async () => {
    const { authColors: C } = await import("@/tokens");
    const scene = heroScene(L360());
    const P = scene.pillar;
    const pH = P.base - P.top;
    const r = render(<LoginHero layout={L360()} at={HERO_MS} />);
    const box = byTest(r, "hero-pillar");
    expect(r.all().filter((n) => n.type === "Path")).toEqual([]);
    const glow = byTest(r, "hero-pillar-glow");
    const core = byTest(r, "hero-pillar-core");
    expect(glow.props).toMatchObject({ x: 0, y: 0, width: P.w, height: pH });
    expect(core.props).toMatchObject({ y: 0, width: P.coreW, height: pH });
    expect((core.props.x as number) + P.coreW / 2).toBeCloseTo(P.w / 2, 6);
    expect(String(glow.props.mask)).toMatch(/pGlowM\)$/);
    expect(String(core.props.mask)).toMatch(/pCoreM\)$/);
    expect(r.all().filter((n) => n.type === "Mask")).toHaveLength(2);
    const grad = (suffix: string) => r.all().find((n) => n.type === "SvgLinearGradient" && String(n.props.id).endsWith(suffix))!;
    const stops = (suffix: string) => grad(suffix).children.map((c) => (c as HostNode).props as { offset: number; stopColor: string; stopOpacity: number });
    // 가로: 양 끝 투명(부드럽게 옅어짐), 가운데가 가장 밝다. 심의 가운데는 따뜻한 흰색·불투명도 0.9 이상
    for (const s of ["pGlowX", "pCoreX"]) {
      const st = stops(s);
      expect(st[0]!.stopOpacity).toBe(0);
      expect(st.at(-1)!.stopOpacity).toBe(0);
      const mid = st.find((x) => x.offset === 0.5)!;
      expect(mid.stopOpacity).toBe(Math.max(...st.map((x) => x.stopOpacity)));
    }
    expect(stops("pCoreX").find((x) => x.offset === 0.5)).toMatchObject({ stopColor: C.pillarCore });
    expect(stops("pCoreX").find((x) => x.offset === 0.5)!.stopOpacity).toBeGreaterThanOrEqual(0.9);
    // 세로(아래 0 → 위 1): 아래 끝·위 끝 투명 (몸통 뒤에서 옅게 시작, 위로 사라짐 — 뾰족한 끝 없음)
    for (const s of ["pGlowY", "pCoreY"]) {
      const g = grad(s);
      expect(g.props).toMatchObject({ y1: pH, y2: 0, gradientUnits: "userSpaceOnUse" });
      const st = stops(s);
      expect(st[0]!.stopOpacity).toBe(0);
      expect(st.at(-1)!.stopOpacity).toBe(0);
      for (const x of st) expect(x.stopColor).toBe(C.maskOn);
    }
    // 심은 몸통 바로 위(아래 10%)에서는 옅다 — 크림 심지처럼 보이지 않게. 가장 밝은 곳은 붉은 빛보다 위
    const coreY = stops("pCoreY");
    const glowY = stops("pGlowY");
    expect(coreY.filter((x) => x.offset <= 0.1).every((x) => x.stopOpacity <= 0.3)).toBe(true);
    const peak = (st: typeof coreY) => st.reduce((a, b) => (b.stopOpacity > a.stopOpacity ? b : a)).offset;
    expect(peak(coreY)).toBeGreaterThan(peak(glowY));
    // 움직임은 세로 크기·불투명도만 (네이티브 드라이버)
    const tf = flatStyle(box.props.style).transform as Record<string, unknown>[];
    expect(tf.map((x) => Object.keys(x)[0])).toEqual(["translateY", "scaleY"]);
  });

  it("비상 스위치 PILLAR_COLUMN (기기에서 가림 그림이 이상하면 끄기 — 붉은 빛만, 아이콘 A 처럼): 기본은 켬", async () => {
    const mod = await import("@/components/auth/LoginHero");
    expect(mod.PILLAR_COLUMN).toBe(true);
  });

  it("봉 자리·폭은 화면 픽셀에 맞춰 그린다 (PixelRatio — dpr 2.625 에서 모든 봉이 같은 굵기)", () => {
    const dpr = 2.625;
    h.snap = (v) => Math.round(v * dpr) / dpr;
    const L = heroLayout(704, 933, { top: 28, bottom: 24 });
    const r = render(<LoginHero layout={L} at={HERO_MS} />);
    const widths = new Set<number>();
    for (let k = 0; k < 10; k++) {
      const g = style(byTest(r, `hero-limit-${k}`));
      widths.add(g.width as number);
      expect(Math.abs((g.left as number) * dpr - Math.round((g.left as number) * dpr))).toBeLessThan(1e-6);
    }
    for (let i = 0; i < 16; i++) widths.add(style(byTest(r, `hero-side-${i}`)).width as number);
    expect(widths.size).toBe(1);
  });
});

describe("숨쉬기를 멈출 때 (검증 지적 — 한 번에 최대 18% 튀었다)", () => {
  it("밝기 1(가까운 끝)까지 약 0.18초 네이티브 timing 으로 되돌린 뒤 멈춘다 — setValue 로 튀지 않게", async () => {
    const r = render(<LoginHero layout={L360()} />);
    await settle(r);
    r.act(() => intros()[0]!.finish());
    const breathing = loops()[0]!;
    // 숨쉬기 위상 0.7 (밝기 약 0.87) 에서 가려짐
    breathing.inner.value.setValue(0.7);
    r.rerender(<LoginHero layout={L360()} paused />);
    expect(breathing.stopped).toBe(true);
    const settleAnim = h.fake.started.filter((a): a is FakeTiming => a.kind === "timing" && a.value === breathing.inner.value && a !== breathing.inner);
    expect(settleAnim).toHaveLength(1);
    expect(settleAnim[0]!.config).toMatchObject({ toValue: 1, duration: 180, useNativeDriver: true });
    // 아직 끝나지 않았으면 값은 그대로 (한 번에 바뀌지 않는다)
    expect(breathing.inner.value.get()).toBe(0.7);
    r.act(() => settleAnim[0]!.finish());
    expect(style(byTest(r, "hero-glow")).opacity).toBeCloseTo(1, 6);
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
