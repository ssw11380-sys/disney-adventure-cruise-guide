import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealScrollY } from "@/lib/loginHero";
import { authLayout } from "@/tokens";
import { cleanupRenders, render } from "./miniRender";

/**
 * 키보드가 누른 칸을 가리지 않는지 — 연결 전체 (계정 A단계 검증 지적: 순수 함수 revealScrollY 만 있고 연결 테스트가 없었다).
 * 칸을 누름(onFocus → reveal.focus) → 키보드가 뜸(keyboardDidShow) → 칸 자리 재기(measureLayout) → 부드럽게 스크롤(scrollTo animated).
 * RN 부품은 ref 를 받는 가짜(칸 자리·스크롤 기록)로, 키보드는 이벤트를 직접 보낸다. 360×752 폰 치수(DOM 실측: 비밀번호 칸 y 426, 키보드 300)
 */
const h = vi.hoisted(() => ({
  kb: {} as Record<string, (e?: { endCoordinates?: { height: number } }) => void>,
  scrollTo: [] as { y: number; animated?: boolean }[],
  fieldY: { 아이디: 358, 비밀번호: 426 } as Record<string, number>,
}));

vi.mock("react-native", async () => {
  const { makeFakeAnimated } = await import("./fakeAnimated");
  const fake = makeFakeAnimated();
  const R = await import("react");
  const setRef = (ref: unknown, v: unknown) => {
    if (typeof ref === "function") (ref as (x: unknown) => void)(v);
    else if (ref && typeof ref === "object") (ref as { current: unknown }).current = v;
  };
  // ref 를 받는 가짜 부품: 칸은 자리를 재 주고, 스크롤은 scrollTo 를 기록한다
  const TextInput = ({ ref, ...p }: { ref?: unknown; accessibilityLabel?: string }) => {
    setRef(ref, { measureLayout: (_rel: unknown, ok: (x: number, y: number, w: number, hh: number) => void) => ok(24, h.fieldY[p.accessibilityLabel ?? ""] ?? 0, 312, 48) });
    return R.createElement("TextInput", p);
  };
  const ScrollView = ({ ref, ...p }: { ref?: unknown }) => {
    setRef(ref, { scrollTo: (o: { y: number; animated?: boolean }) => h.scrollTo.push(o) });
    return R.createElement("ScrollView", p);
  };
  const View = ({ ref, ...p }: { ref?: unknown }) => {
    setRef(ref, { measured: true });
    return R.createElement("View", p);
  };
  return {
    View,
    Text: "Text",
    TextInput,
    Pressable: "Pressable",
    ScrollView,
    Animated: fake.Animated,
    Easing: fake.Easing,
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 } },
    Keyboard: {
      addListener: (ev: string, cb: (e?: { endCoordinates?: { height: number } }) => void) => {
        h.kb[ev] = cb;
        return { remove: () => void delete h.kb[ev] };
      },
    },
    AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(true), addEventListener: () => ({ remove: () => undefined }), announceForAccessibility: () => undefined },
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
    Platform: { OS: "android" },
    PixelRatio: { roundToNearestPixel: (v: number) => v },
    useWindowDimensions: () => ({ width: 360, height: 752, scale: 3, fontScale: 1 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 28, bottom: 24, left: 0, right: 0 }) }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Defs: "Defs", Ellipse: "Ellipse", LinearGradient: "SvgLinearGradient", Line: "Line", Path: "Path", RadialGradient: "RadialGradient", Rect: "Rect", Stop: "Stop", Text: "SvgText" }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));

const { AuthFrame } = await import("@/components/auth/AuthFrame");
const { AuthField } = await import("@/components/auth/AuthParts");

/** 로그인 화면과 같은 두 칸 (비밀번호 칸은 [로그인] 버튼까지 보이게 — login.tsx 와 같은 revealBelow) */
const BELOW = authLayout.fieldGap * 2 + 44 + authLayout.buttonH;
const screen = () =>
  render(
    <AuthFrame top="hero">
      <AuthField label="아이디" value="" onChangeText={() => undefined} />
      <AuthField label="비밀번호" value="" onChangeText={() => undefined} secret revealBelow={BELOW} />
    </AuthFrame>,
  );
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  cleanupRenders();
  h.scrollTo.length = 0;
  for (const k of Object.keys(h.kb)) delete h.kb[k];
});
afterEach(() => cleanupRenders());

describe("키보드가 누른 칸을 가리지 않는다 (AuthFrame 연결)", () => {
  it("비밀번호 칸을 누르고 키보드가 뜨면, 칸과 [로그인] 버튼까지 키보드 위로 부드럽게 스크롤한다", async () => {
    const r = screen();
    const sv = r.all().find((n) => n.type === "ScrollView")!;
    r.act(() => (sv.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { height: 752 } } }));
    r.act(() => (sv.props.onContentSizeChange as (w: number, hh: number) => void)(360, 760));
    // 키보드가 뜨기 전에 누름 → 아직 스크롤하지 않는다
    r.act(() => (r.byLabel("비밀번호").props.onFocus as (e: unknown) => void)({}));
    expect(h.scrollTo).toEqual([]);
    r.act(() => h.kb["keyboardDidShow"]!({ endCoordinates: { height: 300 } }));
    await wait(90);
    const want = revealScrollY({ y: 426, h: 48, below: BELOW + authLayout.groupGap, scrollY: 0, viewportH: 752, kb: 300 });
    expect(want).toBe(426 + 48 + BELOW + authLayout.groupGap + 16 - (752 - 300));
    expect(h.scrollTo).toEqual([{ y: want, animated: true }]);
    // 스크롤한 뒤 [로그인] 아래 끝(칸 + 아래 몫)이 키보드 위 (보이는 높이 452 안)
    expect(426 + 48 + BELOW + authLayout.groupGap - want!).toBeLessThanOrEqual(752 - 300);
  });

  it("키보드가 이미 떠 있을 때 다른 칸을 누르면 바로(0.05초 뒤) 그 칸으로, 이미 보이는 칸이면 스크롤하지 않는다", async () => {
    const r = screen();
    const sv = r.all().find((n) => n.type === "ScrollView")!;
    r.act(() => (sv.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { height: 752 } } }));
    r.act(() => h.kb["keyboardDidShow"]!({ endCoordinates: { height: 300 } }));
    // 아이디 칸: y 358 + 48 + 아래 한 줄(16) + 여유 16 = 438 < 452 → 보인다
    r.act(() => (r.byLabel("아이디").props.onFocus as (e: unknown) => void)({}));
    await wait(80);
    expect(h.scrollTo).toEqual([]);
    r.act(() => (r.byLabel("비밀번호").props.onFocus as (e: unknown) => void)({}));
    await wait(80);
    expect(h.scrollTo).toHaveLength(1);
    expect(h.scrollTo[0]!.animated).toBe(true);
  });

  it("키보드가 내려가면 끝을 넘은 스크롤은 먼저 부드럽게 제자리로 (한 번에 튀지 않게)", async () => {
    const r = screen();
    const sv = r.all().find((n) => n.type === "ScrollView")!;
    r.act(() => (sv.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { height: 752 } } }));
    r.act(() => (sv.props.onContentSizeChange as (w: number, hh: number) => void)(360, 760 + 300));
    r.act(() => h.kb["keyboardDidShow"]!({ endCoordinates: { height: 300 } }));
    r.act(() => (sv.props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { y: 170 } } }));
    h.scrollTo.length = 0;
    r.act(() => h.kb["keyboardDidHide"]!());
    // 키보드 몫을 뺀 내용(760)은 창(752)보다 8 길다 → 8 까지 부드럽게
    expect(h.scrollTo).toEqual([{ y: 8, animated: true }]);
  });
});
