import { LinearGradient } from "expo-linear-gradient";
import React, { memo, useEffect, useId, useMemo, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, PixelRatio, Platform, StyleSheet, View } from "react-native";
import { Defs, LinearGradient as SvgLinearGradient, Line, Mask, RadialGradient, Rect, Stop, Svg } from "react-native-svg";
import {
  BREATH_MS,
  breathTrack,
  growTrack,
  HERO_MS,
  HERO_START_DELAY_MS,
  heroScene,
  heroTracks,
  layoutKey,
  mapTrack,
  pivotShift,
  type HeroScene,
  type LoginLayout,
  type ScenePillar,
  type Track,
} from "@/lib/loginHero";
import { authColors as C, authLayout } from "@/tokens";
import { GoldWordmark, LogoSubtitle } from "./AuthParts";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  <LoginHero/> — 로그인 첫 화면 그림 (계정 A단계, hero-spec.md)
 *  금색 '가즈아 불기둥'·선·부제가 먼저(0.2~0.8초 — 첫 화면부터 브랜드가 보이게) · 횡보 16봉(0.15~1.5초) → 빨간 상한가 10봉이 한 개씩
 *  계단처럼(1.5~3.6초) → 절정: 붉은 빛 + 마지막 봉에서 그림 위쪽으로 솟는 세로 빛 기둥(3.6~4.2초),
 *  그 뒤에는 빛·불기둥만 3.6초에 한 번 아주 천천히 숨 쉰다 (밝기 1 → 0.82 → 1, 깜빡임 없음).
 *
 *  움직임은 모두 UI 스레드: RN Animated 네이티브 드라이버의 시계 하나(0 → 4200ms)와 숨쉬기 하나에, 봉·빛·글자마다
 *  interpolate(시간표 lib/loginHero heroTracks)로 opacity·transform(translate·scale)만 잇는다. 프레임마다 JS 일 없음, SVG 속성은 움직이지 않는다.
 *  (reanimated 는 1.4.0 APK 에서 한 번도 쓰지 않아 OTA 로 처음 쓰지 않는다 — hero-spec 7.1)
 *
 *  - 앱을 켠 뒤 처음 보일 때 한 번 재생, 그 뒤(로그아웃 뒤 등)에는 마지막 장면 + 숨쉬기. 눌러도 다시 재생하지 않는다
 *    (한 번 잘못 누르면 로고·봉이 한순간에 사라졌다가 3.7초 뒤에야 돌아와서 — 검증 지적)
 *  - '애니메이션 줄이기'(안드로이드 애니메이션 삭제 포함)면 처음부터 마지막 장면에 멈춤 — 숨쉬기도 없음
 *  - paused(키보드가 떠 그림이 위로 밀려남 · 회원가입·서버 설정이 위에 올라와 가려짐): 숨쉬기를 멈춘다. 재생 중이면 끝까지 둔다 (그림은 그대로 — 뛰지 않게)
 *  - 앱이 뒤로 가면 숨쉬기를 멈추고, 재생 중이었으면 마지막 장면으로
 *  - 크기가 바뀌면(접기·펴기) 자리만 다시 계산하고 마지막 장면으로
 *  - at(ms): 그 순간에 멈춘 그림 (테스트·화면 캡처용). animate={false}: 마지막 장면에 멈춘 그림 (회원가입 두 칸 화면)
 * ─────────────────────────────────────────────────────────────────────────────
 * 그림은 꾸밈이라 화면 읽기에서 뺀다 (로고 글자만 '가즈아 불기둥' 머리글로 읽는다). '수익'·'추천' 같은 말이나 '+30%' 숫자는 넣지 않는다
 */

const NATIVE = Platform.OS !== "web";
/** 봉 몸통·꼬리 자리·폭을 화면 픽셀에 (봉마다 굵기가 달라 보이지 않게). 없으면(테스트의 가짜 RN) 그대로 */
const snapPx = (v: number) => (typeof PixelRatio?.roundToNearestPixel === "function" ? PixelRatio.roundToNearestPixel(v) : v);
/** 화면 한 픽셀(dp) — 상한가 천장 띠 두께. 모르면(테스트) 0.5 */
const hairPx = (): number => (typeof PixelRatio?.get === "function" && PixelRatio.get() > 0 ? 1 / PixelRatio.get() : 0.5);
/**
 * 불기둥을 그릴지 (기기에서 가림(mask) 그림이 이상하면 false 로 → 붉은 빛(glow)만 — 아이콘 A 처럼. 로고의 WORDMARK_GRADIENT 와 같은 비상 스위치)
 */
export const PILLAR_COLUMN = true;
/** 숨쉬기를 멈출 때 밝기를 1 로 되돌리는 시간 (한 번에 최대 18% 튀지 않게) */
const BREATH_SETTLE_MS = 180;
const TRACKS = heroTracks();
const BREATH = breathTrack();

/** 이번 앱 실행에서 처음 재생을 했는지 (모듈 변수 — 앱을 다시 켜면 다시 재생) */
let introPlayed = false;
export function resetLoginHeroForTests(): void {
  introPlayed = false;
}

type Node = Animated.AnimatedInterpolation<number>;
const at = (clock: Animated.Value, tr: Track): Node => clock.interpolate({ inputRange: [...tr.input], outputRange: [...tr.output], extrapolate: "clamp" });

/** '애니메이션 줄이기' — 모르는 동안 null (보통 50ms 안에 온다, 1초 넘게 안 오면 꺼진 것으로) */
function useReduceMotion(enabled: boolean): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const set = (x: boolean) => alive && setV(!!x);
    const late = setTimeout(() => setV((cur) => (cur === null ? false : cur)), 1000);
    AccessibilityInfo.isReduceMotionEnabled().then(set, () => set(false));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", set);
    return () => {
      alive = false;
      clearTimeout(late);
      sub?.remove();
    };
  }, [enabled]);
  return v;
}

/** 앱이 앞에 있는지 (뒤로 가면 숨쉬기를 멈춘다 — 배터리) */
function useAppActive(enabled: boolean): boolean {
  const [active, setActive] = useState(AppState.currentState !== "background");
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, [enabled]);
  return active;
}

export interface LoginHeroProps {
  layout: LoginLayout;
  /** 로고를 그림 위에 그릴지 */
  logo?: boolean;
  /** false 면 마지막 장면에 멈춘 그림 (움직임·숨쉬기 없음) */
  animate?: boolean;
  /** 이 순간(ms)에 멈춘 그림 — 테스트·캡처용 */
  at?: number;
  /** 키보드가 떠 그림이 밀려났거나 다른 화면이 위에 올라와 가려졌을 때 — 숨쉬기를 멈춘다 (재생 중이면 끝까지 둔다) */
  paused?: boolean;
}

export const LoginHero = memo(function LoginHero({ layout, logo = true, animate = true, at: frozenAt, paused = false }: LoginHeroProps) {
  const key = layoutKey(layout);
  // 같은 배치면 장면·움직임 노드를 다시 만들지 않는다 (입력할 때마다 화면이 다시 그려져도 시계에 붙은 노드는 그대로)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scene = useMemo(() => heroScene(layout, snapPx, hairPx()), [key]);
  const still = frozenAt !== undefined ? frozenAt : animate ? null : HERO_MS;
  const [clock] = useState(() => new Animated.Value(still ?? (introPlayed ? HERO_MS : 0)));
  const [breath] = useState(() => new Animated.Value(0));
  const reduce = useReduceMotion(still === null);
  const active = useAppActive(still === null);
  /** 마지막 장면에 닿았는지 (그 뒤에만 숨쉰다). 이번 실행에서 이미 재생했으면 처음부터 마지막 장면 */
  const [done, setDone] = useState(() => introPlayed);

  // 처음 한 번 재생. 움직임 줄이기·앱이 뒤로·크기 바뀜(접기·펴기)이면 마지막 장면으로 (paused 는 보지 않는다 — 키보드가 떠도 재생은 끝까지)
  useEffect(() => {
    if (still !== null) {
      clock.setValue(still);
      return;
    }
    if (reduce === null) return;
    if (reduce || !active || introPlayed) {
      clock.setValue(HERO_MS);
      return;
    }
    introPlayed = true;
    let alive = true;
    clock.setValue(0);
    const intro = Animated.timing(clock, { toValue: HERO_MS, duration: HERO_MS, delay: HERO_START_DELAY_MS, easing: Easing.linear, useNativeDriver: NATIVE, isInteraction: false });
    intro.start(({ finished }) => {
      if (alive && finished) setDone(true);
    });
    return () => {
      // 도중에 끊기면(움직임 줄이기·앱이 뒤로·크기 바뀜) 다음 실행이 마지막 장면으로 둔다 → 숨쉬기를 할 수 있게
      alive = false;
      intro.stop();
      setDone(true);
    };
  }, [still, reduce, active, key, clock]);

  // 숨쉬기: 마지막 장면 뒤, 보이는 동안만 (움직임 줄이기·가려짐·키보드·앱이 뒤면 멈추고 밝기 1 로)
  useEffect(() => {
    if (still !== null || reduce !== false || !done || paused || !active) return;
    breath.setValue(0);
    const b = Animated.loop(Animated.timing(breath, { toValue: 1, duration: BREATH_MS, easing: Easing.linear, useNativeDriver: NATIVE, isInteraction: false }));
    b.start();
    return () => {
      b.stop();
      // 밝기 1(위상 0 또는 1)까지 가까운 쪽으로 부드럽게 (예전 setValue(0) 은 키보드·가려짐·앱 전환 때 빛이 한 번에 최대 18% 튀었다 — 검증 지적)
      breath.stopAnimation((v) => {
        const to = typeof v === "number" && v >= 0.5 ? 1 : 0;
        Animated.timing(breath, { toValue: to, duration: BREATH_SETTLE_MS, easing: Easing.linear, useNativeDriver: NATIVE, isInteraction: false }).start(({ finished }) => {
          if (finished) breath.setValue(0);
        });
      });
    };
  }, [still, reduce, done, paused, active, breath]);

  return (
    <View style={{ width: layout.heroW, height: layout.heroH, overflow: "visible", zIndex: 0, pointerEvents: "box-none" }} testID="login-hero">
      <HeroArt scene={scene} clock={clock} breath={breath} />
      {logo ? <HeroLogo scene={scene} clock={clock} /> : null}
    </View>
  );
});

/** 빛·눈금·불기둥·봉 (꾸밈 — 화면 읽기에서 뺀다). 노드는 장면이 바뀔 때만 만든다 */
const HeroArt = memo(function HeroArt({ scene, clock, breath }: { scene: HeroScene; clock: Animated.Value; breath: Animated.Value }) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const ref = (name: string) => `url(#${uid}${name})`;
  const L = scene.layout;
  // 빛은 두 칸 화면에서도 창 전체에 (오른쪽 입력 칸 뒤까지 — 경계에 세로 줄이 생기지 않게, hero-spec 4.1)
  const W = L.screenW;
  const H = L.heroH;
  const P = scene.pillar;
  const pH = P.base - P.top;
  const pillarOn = PILLAR_COLUMN && pH > 1;
  const nodes = useMemo(() => {
    const breathe = breath.interpolate({ inputRange: [...BREATH.input], outputRange: [...BREATH.output] });
    const ps = growTrack(TRACKS.pillar.grow);
    return {
      grid: at(clock, TRACKS.grid),
      glow: Animated.multiply(at(clock, TRACKS.glow), breathe),
      side: scene.side.map((c, i) => {
        const tr = TRACKS.side[i]!;
        const s = growTrack(tr.scale);
        return { opacity: at(clock, tr.opacity), shift: at(clock, mapTrack(s, (v) => pivotShift(c.box.y, c.box.h, c.pivotY, v))), scale: at(clock, s) };
      }),
      limit: scene.limit.map((c, k) => {
        const tr = TRACKS.limit[k]!;
        const s = growTrack(tr.grow);
        return { show: at(clock, tr.show), shift: at(clock, mapTrack(s, (v) => pivotShift(0, c.body.h, c.body.h, v))), scale: at(clock, s), cap: at(clock, tr.cap) };
      }),
      pillar: {
        opacity: Animated.multiply(at(clock, TRACKS.pillar.opacity), breathe),
        // 아래 끝(봉 종가) 기준으로 위로 솟는다
        shift: at(clock, mapTrack(ps, (v) => pivotShift(0, pH, pH, v))),
        scale: at(clock, ps),
      },
    };
  }, [scene, clock, breath, pH]);
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: "visible", pointerEvents: "none" }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {/* 빛: 마지막 봉 둘레(glow)와 계단 가운데(glow2) — 원형 그러데이션 (흐림 필터 없음) */}
      <Animated.View testID="hero-glow" style={{ position: "absolute", left: 0, top: 0, width: W, height: H, opacity: nodes.glow }} renderToHardwareTextureAndroid>
        <Svg width={W} height={H}>
          <Defs>
            <RadialGradient id={`${uid}glow`} cx={scene.glow.cx} cy={scene.glow.cy} r={scene.glow.r} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={C.glow} stopOpacity={0.42} />
              <Stop offset="0.5" stopColor={C.glow} stopOpacity={0.12} />
              <Stop offset="1" stopColor={C.glow} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={`${uid}glow2`} cx={scene.glow2.cx} cy={scene.glow2.cy} r={scene.glow2.r} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={C.glow} stopOpacity={0.15} />
              <Stop offset="1" stopColor={C.glow} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={W} height={H} fill={ref("glow2")} />
          <Rect x={0} y={0} width={W} height={H} fill={ref("glow")} />
        </Svg>
      </Animated.View>
      {/* 눈금 + 바닥선 (로고 묶음 높이에 걸리는 줄은 장면에서 뺐다) */}
      <Animated.View testID="hero-grid" style={{ position: "absolute", left: 0, top: 0, width: L.heroW, height: H, opacity: nodes.grid }}>
        <Svg width={L.heroW} height={H}>
          {scene.grid.map((g, i) => (
            <Line key={`g${i}`} x1={g.x1} x2={g.x2} y1={g.y} y2={g.y} stroke={C.grid} strokeWidth={1} />
          ))}
          <Line x1={scene.baseline.x1} x2={scene.baseline.x2} y1={scene.baseline.y} y2={scene.baseline.y} stroke={C.baseline} strokeWidth={1} />
        </Svg>
      </Animated.View>
      {/* 불기둥 (검증 4·5차): 마지막 종가에서 그림 위쪽(상태 표시줄 아래)으로 곧게 솟는 세로 빛 기둥 — 같은 폭(부풂 없음), 뾰족한 끝 없이 위로 갈수록 투명,
          가로로는 주황 어깨 → 가운데 평평한 따뜻한 흰 심(몸통보다 넓게). 아래 끝은 몸통 뒤에서 옅게 시작한다 (예전 불꽃 모양은 촛불, 가는 심은 심지처럼 보였다).
          움직임은 세로 크기(아래 끝 기준)·불투명도만 — 네이티브 드라이버 */}
      {pillarOn ? (
        <Animated.View
          testID="hero-pillar"
          renderToHardwareTextureAndroid
          style={{ position: "absolute", left: P.cx - P.w / 2, top: P.top, width: P.w, height: pH, opacity: nodes.pillar.opacity, transform: [{ translateY: nodes.pillar.shift }, { scaleY: nodes.pillar.scale }] }}
        >
          <PillarArt uid={uid} pillar={P} />
        </Animated.View>
      ) : null}
      {/* 횡보 봉 16개: 몸통 가운데 기준으로 0.3 → 1 (자리·폭은 화면 픽셀에 맞춤) */}
      {scene.side.map((c, i) => {
        const color = c.up ? C.sideUp : C.sideDown;
        const n = nodes.side[i]!;
        return (
          <Animated.View key={`s${i}`} testID={`hero-side-${i}`} style={{ position: "absolute", left: c.box.x, top: c.box.y, width: c.box.w, height: c.box.h, opacity: n.opacity, transform: [{ translateY: n.shift }, { scaleY: n.scale }] }}>
            <View style={{ position: "absolute", left: c.wickX, top: 0, width: c.wickW, height: c.bodyTop - c.box.y, backgroundColor: color }} />
            <View style={{ position: "absolute", left: 0, top: c.bodyTop - c.box.y, width: c.box.w, height: c.bodyBottom - c.bodyTop, borderRadius: 1, backgroundColor: color }} />
            <View style={{ position: "absolute", left: c.wickX, top: c.bodyBottom - c.box.y, width: c.wickW, height: c.box.y + c.box.h - c.bodyBottom, backgroundColor: color }} />
          </Animated.View>
        );
      })}
      {/* 상한가 봉 10개: 시가(아래) 기준으로 위로 자란다, 윗꼬리 없음, 다 자라면 천장 띠 */}
      {scene.limit.map((c, k) => {
        const n = nodes.limit[k]!;
        return (
          <Animated.View key={`l${k}`} testID={`hero-limit-${k}`} style={{ position: "absolute", left: c.body.x, top: c.body.y, width: c.body.w, height: c.body.h + c.wick.h, opacity: n.show }}>
            <View style={{ position: "absolute", left: c.wick.x - c.body.x, top: c.body.h, width: c.wick.w, height: c.wick.h, backgroundColor: C.limitWick }} />
            <Animated.View testID={`hero-body-${k}`} style={{ position: "absolute", left: 0, top: 0, width: c.body.w, height: c.body.h, borderRadius: c.radius, overflow: "hidden", transform: [{ translateY: n.shift }, { scaleY: n.scale }] }}>
              <LinearGradient colors={[C.limitHigh, C.limitLow]} style={StyleSheet.absoluteFill} />
              <Animated.View testID={`hero-cap-${k}`} style={{ position: "absolute", left: 0, top: 0, width: c.body.w, height: c.capH, backgroundColor: C.limitCap, opacity: n.cap }} />
            </Animated.View>
          </Animated.View>
        );
      })}
    </View>
  );
});

/**
 * 기둥의 가로 빛 (그리는 칸 = 몸통 × 3): 양옆 투명 → 붉은 끝 → 주황 어깨 → 가운데 따뜻한 주황. [위치 0~1, 색, 불투명도].
 * 검증 5차: 붉은 옆빛은 같은 색 원형 빛(glow)에 묻혀 보이지 않았다 → 0.22~0.78 을 주황으로 (몸통의 약 1.7배 폭이 불투명도 0.7 이상)
 */
export const PILLAR_GLOW_X: readonly (readonly [number, string, number])[] = [
  [0, C.pillarRed, 0],
  [0.1, C.pillarRed, 0.18],
  [0.22, C.pillarWarm, 0.7],
  [0.36, C.pillarWarm, 0.82],
  [0.5, C.pillarWarm, 0.88],
  [0.64, C.pillarWarm, 0.82],
  [0.78, C.pillarWarm, 0.7],
  [0.9, C.pillarRed, 0.18],
  [1, C.pillarRed, 0],
];
/**
 * 가운데 심의 가로 빛 (심 칸 = 몸통 × 1.8): 가운데가 **평평한** 따뜻한 흰색 (0.28~0.72 — 몸통의 약 0.8배 폭이 0.9 이상), 양옆은 주황으로 옅어짐.
 * 검증 5차: 예전 심은 몸통보다 좁고 가운데 한 점만 밝아 가는 흰 선(심지·광선검)으로 보였다
 */
export const PILLAR_CORE_X: readonly (readonly [number, string, number])[] = [
  [0, C.pillarWarm, 0],
  [0.12, C.pillarWarm, 0.5],
  [0.28, C.pillarCore, 0.9],
  [0.5, C.pillarCore, 0.95],
  [0.72, C.pillarCore, 0.9],
  [0.88, C.pillarWarm, 0.5],
  [1, C.pillarWarm, 0],
];
/**
 * 세로로 얼마나 보이는지 (아래 끝 0 → 위 끝 1, 가림(mask)의 흰색 불투명도): 주황 빛은 몸통 뒤에서 옅게 시작해 곧 가장 밝고 위로 갈수록 투명.
 * 가운데 심은 몸통 바로 위에서는 옅고(아래 크림 심지처럼 보이지 않게) 조금 위에서 가장 밝았다가 길게 옅어진다 — 짧은 불꽃이 아니라 위로 뻗는 기둥으로
 */
export const PILLAR_GLOW_Y: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.02, 0.6],
  [0.05, 1],
  [0.4, 0.8],
  [0.75, 0.35],
  [1, 0],
];
export const PILLAR_CORE_Y: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.08, 0.3],
  [0.2, 0.95],
  [0.45, 0.75],
  [0.75, 0.3],
  [1, 0],
];

/**
 * 불기둥 그림 (그리는 칸 = 기둥 폭 w × 높이, 아래 끝 = 칸 아래 끝): 가로 빛 그러데이션을 세로 가림(mask — 흰색 불투명도)으로 위아래를 옅게 한 사각형 둘.
 * 모양 선(Path)이 없어 끝이 뾰족하거나 부풀지 않고, 흐림 필터 없이 가로·세로 모두 부드럽다
 */
function PillarArt({ uid, pillar: P }: { uid: string; pillar: ScenePillar }) {
  const h = P.base - P.top;
  const w = P.w;
  const cx0 = (w - P.coreW) / 2;
  const ref = (name: string) => `url(#${uid}${name})`;
  const stopsX = (list: readonly (readonly [number, string, number])[]) => list.map(([o, c, a]) => <Stop key={o} offset={o} stopColor={c} stopOpacity={a} />);
  const stopsY = (list: readonly (readonly [number, number])[]) => list.map(([o, a]) => <Stop key={o} offset={o} stopColor={C.maskOn} stopOpacity={a} />);
  return (
    <Svg width={w} height={h}>
      <Defs>
        <SvgLinearGradient id={`${uid}pGlowX`} x1={0} y1={0} x2={w} y2={0} gradientUnits="userSpaceOnUse">
          {stopsX(PILLAR_GLOW_X)}
        </SvgLinearGradient>
        <SvgLinearGradient id={`${uid}pCoreX`} x1={cx0} y1={0} x2={cx0 + P.coreW} y2={0} gradientUnits="userSpaceOnUse">
          {stopsX(PILLAR_CORE_X)}
        </SvgLinearGradient>
        <SvgLinearGradient id={`${uid}pGlowY`} x1={0} y1={h} x2={0} y2={0} gradientUnits="userSpaceOnUse">
          {stopsY(PILLAR_GLOW_Y)}
        </SvgLinearGradient>
        <SvgLinearGradient id={`${uid}pCoreY`} x1={0} y1={h} x2={0} y2={0} gradientUnits="userSpaceOnUse">
          {stopsY(PILLAR_CORE_Y)}
        </SvgLinearGradient>
        <Mask id={`${uid}pGlowM`} maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
          <Rect x={0} y={0} width={w} height={h} fill={ref("pGlowY")} />
        </Mask>
        <Mask id={`${uid}pCoreM`} maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
          <Rect x={0} y={0} width={w} height={h} fill={ref("pCoreY")} />
        </Mask>
      </Defs>
      <Rect testID="hero-pillar-glow" x={0} y={0} width={w} height={h} fill={ref("pGlowX")} mask={ref("pGlowM")} />
      <Rect testID="hero-pillar-core" x={cx0} y={0} width={P.coreW} height={h} fill={ref("pCoreX")} mask={ref("pCoreM")} />
    </Svg>
  );
}

/** 로고: 글자(나타나며 8dp 올라옴) → 금색 선(왼쪽부터 그어짐) → 부제. 감싸는 View 하나가 '가즈아 불기둥' 머리글 */
const HeroLogo = memo(function HeroLogo({ scene, clock }: { scene: HeroScene; clock: Animated.Value }) {
  const L = scene.logo;
  const nodes = useMemo(
    () => ({
      opacity: at(clock, TRACKS.logo.opacity),
      shift: at(clock, TRACKS.logo.shift),
      lineShift: at(clock, mapTrack(TRACKS.line, (v) => pivotShift(0, authLayout.logoLineW, 0, v))),
      line: at(clock, mapTrack(TRACKS.line, (v) => Math.max(0.01, v))),
      lineShow: at(clock, TRACKS.lineShow),
      sub: at(clock, TRACKS.sub),
    }),
    [clock],
  );
  return (
    <View
      style={{ position: "absolute", left: L.x, top: L.y, width: Math.ceil(L.size * authLayout.wordmarkCanvas), height: L.h }}
      accessible
      accessibilityRole="header"
      accessibilityLabel="가즈아 불기둥"
    >
      <Animated.View testID="hero-logo-word" style={{ opacity: nodes.opacity, transform: [{ translateY: nodes.shift }] }}>
        <GoldWordmark size={L.size} />
      </Animated.View>
      <Animated.View
        testID="hero-logo-line"
        style={{
          position: "absolute",
          left: 0,
          top: L.lineY - L.y,
          width: authLayout.logoLineW,
          height: authLayout.logoLineH,
          backgroundColor: C.goldLine,
          opacity: nodes.lineShow,
          transform: [{ translateX: nodes.lineShift }, { scaleX: nodes.line }],
        }}
      />
      {L.subY !== null ? (
        <Animated.View testID="hero-logo-sub" style={{ position: "absolute", left: 0, top: L.subY - L.y - authLayout.logoSubGap, opacity: nodes.sub }}>
          <LogoSubtitle />
        </Animated.View>
      ) : null}
    </View>
  );
});
