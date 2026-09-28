import { LinearGradient } from "expo-linear-gradient";
import React, { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, Platform, Pressable, StyleSheet, View } from "react-native";
import { Defs, Ellipse, LinearGradient as SvgLinearGradient, Line, RadialGradient, Rect, Stop, Svg } from "react-native-svg";
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
  type Track,
} from "@/lib/loginHero";
import { authColors as C, authLayout } from "@/tokens";
import { AuthLogo, GoldWordmark, LogoSubtitle } from "./AuthParts";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  <LoginHero/> — 로그인 첫 화면 그림 (계정 A단계, hero-spec.md)
 *  횡보 16봉(0~1.5초) → 빨간 상한가 10봉이 한 개씩 계단처럼(1.5~3.6초) → 불기둥 빛 + 금색 '가즈아 불기둥'(3.6~4.2초),
 *  그 뒤에는 빛만 3.6초에 한 번 아주 천천히 숨 쉰다 (밝기 1 → 0.82 → 1, 깜빡임 없음).
 *
 *  움직임은 모두 UI 스레드: RN Animated 네이티브 드라이버의 시계 하나(0 → 4200ms)와 숨쉬기 하나에, 봉·빛·글자마다
 *  interpolate(시간표 lib/loginHero heroTracks)로 opacity·transform(translate·scale)만 잇는다. 프레임마다 JS 일 없음, SVG 속성은 움직이지 않는다.
 *  (reanimated 는 1.4.0 APK 에서 한 번도 쓰지 않아 OTA 로 처음 쓰지 않는다 — hero-spec 7.1)
 *
 *  - 앱을 켠 뒤 처음 보일 때 한 번 재생, 그 뒤(로그아웃 뒤 등)에는 마지막 장면 + 숨쉬기. 그림을 누르면 한 번 다시 재생
 *  - '애니메이션 줄이기'(안드로이드 애니메이션 삭제 포함)면 처음부터 마지막 장면에 멈춤 — 숨쉬기·다시 재생도 없음
 *  - 키보드가 떠 그림을 접으면(layout.collapsed) 로고 한 줄만 (재생 중이었으면 마지막 장면으로), 앱이 뒤로 가면 숨쉬기를 멈춘다
 *  - 크기가 바뀌면(접기·펴기) 자리만 다시 계산하고 마지막 장면으로
 *  - at(ms): 그 순간에 멈춘 그림 (테스트·화면 캡처용). animate={false}: 마지막 장면에 멈춘 그림 (회원가입 두 칸 화면)
 * ─────────────────────────────────────────────────────────────────────────────
 * 그림은 꾸밈이라 화면 읽기에서 뺀다 (로고 글자만 '가즈아 불기둥' 머리글로 읽는다). '수익'·'추천' 같은 말이나 '+30%' 숫자는 넣지 않는다
 */

const NATIVE = Platform.OS !== "web";
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
}

export const LoginHero = memo(function LoginHero({ layout, logo = true, animate = true, at: frozenAt }: LoginHeroProps) {
  const key = layoutKey(layout);
  // 같은 배치면 장면·움직임 노드를 다시 만들지 않는다 (입력할 때마다 화면이 다시 그려져도 시계에 붙은 노드는 그대로)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scene = useMemo(() => heroScene(layout), [key]);
  const still = frozenAt !== undefined ? frozenAt : animate ? null : HERO_MS;
  const [clock] = useState(() => new Animated.Value(still ?? (introPlayed ? HERO_MS : 0)));
  const [breath] = useState(() => new Animated.Value(0));
  const reduce = useReduceMotion(still === null);
  const active = useAppActive(still === null);
  const [replayTick, setReplayTick] = useState(0);
  const replayWanted = useRef(false);
  const playing = useRef(false);
  const collapsed = layout.collapsed;

  useEffect(() => {
    if (still !== null) {
      clock.setValue(still);
      breath.setValue(0);
      return;
    }
    if (reduce === null) return;
    if (reduce || collapsed || !active) {
      // 멈춘 마지막 장면 (움직임 줄이기 · 키보드로 접힘 · 앱이 뒤에)
      clock.setValue(HERO_MS);
      breath.setValue(0);
      return;
    }
    let alive = true;
    const runs: Animated.CompositeAnimation[] = [];
    const breathe = () => {
      if (!alive) return;
      breath.setValue(0);
      const b = Animated.loop(Animated.timing(breath, { toValue: 1, duration: BREATH_MS, easing: Easing.linear, useNativeDriver: NATIVE, isInteraction: false }));
      runs.push(b);
      b.start();
    };
    const replay = replayWanted.current;
    replayWanted.current = false;
    if (replay || !introPlayed) {
      introPlayed = true;
      playing.current = true;
      clock.setValue(0);
      breath.setValue(0);
      const intro = Animated.timing(clock, {
        toValue: HERO_MS,
        duration: HERO_MS,
        delay: replay ? 0 : HERO_START_DELAY_MS,
        easing: Easing.linear,
        useNativeDriver: NATIVE,
        isInteraction: false,
      });
      runs.push(intro);
      intro.start(({ finished }) => {
        if (!alive) return;
        playing.current = false;
        if (finished) breathe();
      });
    } else {
      clock.setValue(HERO_MS);
      breathe();
    }
    return () => {
      alive = false;
      playing.current = false;
      for (const r of runs) r.stop();
    };
  }, [still, reduce, collapsed, active, replayTick, key, clock, breath]);

  const onReplay = () => {
    if (still !== null || reduce !== false || collapsed || playing.current) return;
    replayWanted.current = true;
    setReplayTick((n) => n + 1);
  };

  return (
    <View style={{ width: layout.heroW, height: layout.heroH, overflow: "visible", zIndex: 0 }} testID="login-hero">
      {collapsed ? null : (
        // 그림을 누르면 한 번 다시 재생. 꾸밈이라 화면 읽기에서는 이 누르는 곳을 건너뛴다 (안의 로고 머리글은 읽힘)
        <Pressable
          onPress={onReplay}
          accessible={false}
          importantForAccessibility="no"
          accessibilityRole="none"
          accessibilityLabel="첫 화면 그림 (누르면 다시 재생)"
          style={[StyleSheet.absoluteFill, { overflow: "visible" }]}
          testID="login-hero-replay"
        >
          <HeroArt scene={scene} clock={clock} breath={breath} />
          {logo ? <HeroLogo scene={scene} clock={clock} /> : null}
        </Pressable>
      )}
      {collapsed && logo ? (
        <View style={{ position: "absolute", left: layout.logoX, top: layout.logoY }}>
          <AuthLogo size={layout.logoSize} subtitle={false} />
        </View>
      ) : null}
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
  const nodes = useMemo(() => {
    const breathe = breath.interpolate({ inputRange: [...BREATH.input], outputRange: [...BREATH.output] });
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
      flames: scene.flames.map((f, i) => {
        const tr = TRACKS.flames[i]!;
        const s = growTrack(tr.grow);
        return {
          opacity: Animated.multiply(at(clock, mapTrack(tr.opacity, (v) => v * f.opacity)), breathe),
          shift: at(clock, mapTrack(s, (v) => pivotShift(0, 2 * f.ry, 2 * f.ry, v))),
          scale: at(clock, s),
        };
      }),
      core: Animated.multiply(at(clock, TRACKS.flames[TRACKS.flames.length - 1]!.opacity), breathe),
    };
  }, [scene, clock, breath]);
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
      {/* 눈금 5줄 + 바닥선. 로고 옆을 지나는 줄은 로고 오른쪽에서 옅게 시작 */}
      <Animated.View testID="hero-grid" style={{ position: "absolute", left: 0, top: 0, width: L.heroW, height: H, opacity: nodes.grid }}>
        <Svg width={L.heroW} height={H}>
          <Defs>
            {scene.grid.map((g, i) =>
              g.fade ? (
                <SvgLinearGradient key={i} id={`${uid}fade${i}`} x1={g.x1} y1={0} x2={g.x1 + g.fade} y2={0} gradientUnits="userSpaceOnUse">
                  <Stop offset="0" stopColor={C.gridLine} stopOpacity={0} />
                  <Stop offset="1" stopColor={C.gridLine} stopOpacity={C.gridOpacity} />
                </SvgLinearGradient>
              ) : null,
            )}
          </Defs>
          {scene.grid.map((g, i) => (
            <Line key={`g${i}`} x1={g.x1} x2={g.x2} y1={g.y} y2={g.y} stroke={g.fade ? ref(`fade${i}`) : C.grid} strokeWidth={1} />
          ))}
          <Line x1={scene.baseline.x1} x2={scene.baseline.x2} y1={scene.baseline.y} y2={scene.baseline.y} stroke={C.baseline} strokeWidth={1} />
        </Svg>
      </Animated.View>
      {/* 불기둥: 마지막 세 봉 위 세로 타원 (아래 기준으로 자란다) */}
      {scene.flames.map((f, i) => (
        <Animated.View
          key={`f${i}`}
          testID={`hero-flame-${i}`}
          renderToHardwareTextureAndroid
          style={{ position: "absolute", left: f.cx - f.rx, top: f.cy - f.ry, width: 2 * f.rx, height: 2 * f.ry, opacity: nodes.flames[i]!.opacity, transform: [{ translateY: nodes.flames[i]!.shift }, { scaleY: nodes.flames[i]!.scale }] }}
        >
          <Svg width={2 * f.rx} height={2 * f.ry}>
            <Defs>
              <RadialGradient id={`${uid}flame${i}`} cx="50%" cy="58%" r="50%">
                <Stop offset="0" stopColor={C.flameCore} stopOpacity={0.5} />
                <Stop offset="0.2" stopColor={C.flame} stopOpacity={0.55} />
                <Stop offset="0.55" stopColor={C.flameHot} stopOpacity={0.22} />
                <Stop offset="1" stopColor={C.flameHot} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Ellipse cx={f.rx} cy={f.ry} rx={f.rx} ry={f.ry} fill={ref(`flame${i}`)} />
            {i === scene.flames.length - 1 ? (
              <>
                <Defs>
                  <RadialGradient id={`${uid}pillar`} cx="50%" cy="62%" r="50%">
                    <Stop offset="0" stopColor={C.flameCore} stopOpacity={0.6} />
                    <Stop offset="0.5" stopColor={C.flame} stopOpacity={0.25} />
                    <Stop offset="1" stopColor={C.flame} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Ellipse cx={f.rx} cy={f.ry * 1.05} rx={f.rx * 0.42} ry={f.ry * 0.92} fill={ref("pillar")} />
              </>
            ) : null}
          </Svg>
        </Animated.View>
      ))}
      {/* 횡보 봉 16개: 몸통 가운데 기준으로 0.3 → 1 */}
      {scene.side.map((c, i) => {
        const color = c.up ? C.sideUp : C.sideDown;
        const n = nodes.side[i]!;
        const wickX = (c.box.w - 1) / 2;
        return (
          <Animated.View key={`s${i}`} testID={`hero-side-${i}`} style={{ position: "absolute", left: c.box.x, top: c.box.y, width: c.box.w, height: c.box.h, opacity: n.opacity, transform: [{ translateY: n.shift }, { scaleY: n.scale }] }}>
            <View style={{ position: "absolute", left: wickX, top: 0, width: 1, height: c.bodyTop - c.box.y, backgroundColor: color }} />
            <View style={{ position: "absolute", left: 0, top: c.bodyTop - c.box.y, width: c.box.w, height: c.bodyBottom - c.bodyTop, borderRadius: 1, backgroundColor: color }} />
            <View style={{ position: "absolute", left: wickX, top: c.bodyBottom - c.box.y, width: 1, height: c.box.y + c.box.h - c.bodyBottom, backgroundColor: color }} />
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
      {/* 마지막 봉 꼭대기 뜨거운 점 */}
      <Animated.View
        testID="hero-core"
        style={{ position: "absolute", left: scene.core.cx - scene.core.r, top: scene.core.cy - scene.core.r, width: 2 * scene.core.r, height: 2 * scene.core.r, opacity: nodes.core }}
        renderToHardwareTextureAndroid
      >
        <Svg width={2 * scene.core.r} height={2 * scene.core.r}>
          <Defs>
            <RadialGradient id={`${uid}core`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={C.flameCore} stopOpacity={0.55} />
              <Stop offset="1" stopColor={C.flameCore} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={scene.core.r} cy={scene.core.r} rx={scene.core.r} ry={scene.core.r} fill={ref("core")} />
        </Svg>
      </Animated.View>
    </View>
  );
});

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
