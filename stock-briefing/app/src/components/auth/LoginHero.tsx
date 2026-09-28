import React, { memo, useId, useMemo } from "react";
import { View } from "react-native";
import { Defs, Ellipse, LinearGradient as SvgLinearGradient, Line, RadialGradient, Rect, Stop, Svg } from "react-native-svg";
import { heroCandles, type LoginLayout } from "@/lib/loginHero";
import { authColors as C, authLayout, space } from "@/tokens";
import { AuthLogo } from "./AuthParts";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  <LoginHero/> 자리 (계정 A단계) — 로그인 첫 화면 그림
 *  지금은 **움직이지 않는 자리 채움**: hero-spec.md 의 마지막 장면(횡보 16봉 → 상한가 10봉 계단 + 붉은 빛·불기둥 + 금색 글자)을
 *  같은 크기·같은 기하(lib/loginHero heroCandles)로 멈춘 모습으로 그린다.
 *  움직이는 그림(시간표 6장 · 숨쉬기 · 애니메이션 줄이기 · RN Animated 네이티브 드라이버)은 다음 작업이 이 파일을 바꿔 넣는다.
 *  크기 약속: 한 칸은 폭 layout.heroW × 높이 layout.heroH(위 안전 영역 포함), 두 칸은 왼쪽 영역 전체. 입력 칸은 이 부품과 상관없이 바로 쓸 수 있다
 * ─────────────────────────────────────────────────────────────────────────────
 * 그림은 꾸밈이라 화면 읽기에서 뺀다 (로고 글자만 읽는다). '수익'·'추천' 같은 말이나 '+30%' 숫자는 넣지 않는다
 */
export const LoginHero = memo(function LoginHero({ layout, logo = true }: { layout: LoginLayout; logo?: boolean }) {
  const g = useMemo(() => heroCandles(layout.plot), [layout.plot]);
  // 그러데이션 id 는 그림마다 다르게 (웹에서는 문서 전체에서 id 를 찾는다 — 로그인·회원가입 두 그림이 함께 있으면 가려진 쪽 것을 집는다)
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const ref = (name: string) => `url(#${uid}${name})`;
  const { heroW, heroH: H, plot } = layout;
  // 빛은 두 칸 화면에서도 창 전체에 (오른쪽 입력 칸 뒤까지 — 경계에 세로 줄이 생기지 않게, hero-spec 4.1). 그림 영역은 heroW
  const W = layout.screenW;
  const last = g.candles[g.candles.length - 1]!;
  const flameRy = g.flameH * 0.55;
  const collapsed = layout.collapsed;
  return (
    <View style={{ width: heroW, height: H, overflow: "visible", zIndex: 0 }} testID="login-hero">
      {collapsed ? null : (
        <View style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={W} height={H}>
          <Defs>
            <RadialGradient id={`${uid}glow`} cx={g.glow.cx} cy={g.glow.cy} r={g.glow.r} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={C.glow} stopOpacity={0.42} />
              <Stop offset="0.5" stopColor={C.glow} stopOpacity={0.12} />
              <Stop offset="1" stopColor={C.glow} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={`${uid}glow2`} cx={g.glow2.cx} cy={g.glow2.cy} r={g.glow2.r} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={C.glow} stopOpacity={0.15} />
              <Stop offset="1" stopColor={C.glow} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={`${uid}flame`} cx="50%" cy="60%" r="50%">
              <Stop offset="0" stopColor={C.flame} stopOpacity={0.5} />
              <Stop offset="0.45" stopColor={C.flameHot} stopOpacity={0.22} />
              <Stop offset="1" stopColor={C.flameHot} stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id={`${uid}core`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={C.flameCore} stopOpacity={0.55} />
              <Stop offset="1" stopColor={C.flameCore} stopOpacity={0} />
            </RadialGradient>
            <SvgLinearGradient id={`${uid}limit`} x1="0" y1="1" x2="0" y2="0">
              <Stop offset="0" stopColor={C.limitLow} />
              <Stop offset="1" stopColor={C.limitHigh} />
            </SvgLinearGradient>
          </Defs>
          <Rect x={0} y={0} width={W} height={H} fill={ref("glow2")} />
          <Rect x={0} y={0} width={W} height={H} fill={ref("glow")} />
          {g.grid.map((y) => (
            <Line key={`g${y}`} x1={plot.x0} x2={plot.x0 + plot.w} y1={y} y2={y} stroke={C.grid} strokeWidth={1} />
          ))}
          <Line x1={plot.x0} x2={plot.x0 + plot.w} y1={g.baseline} y2={g.baseline} stroke={C.baseline} strokeWidth={1} />
          {/* 불기둥: 마지막 세 봉 위 세로 타원 (흐림 필터 없이 원형 그러데이션) */}
          {[0.55, 0.78, 1].map((k, i) => {
            const c = g.candles[g.candles.length - 3 + i]!;
            const ry = 0.62 * flameRy * k;
            return <Ellipse key={`f${i}`} cx={c.cx} cy={c.top - 0.3 * flameRy * k} rx={1.4 * g.bw} ry={ry} fill={ref("flame")} opacity={[0.35, 0.6, 1][i]} />;
          })}
          <Ellipse cx={last.cx} cy={last.top} rx={0.9 * g.bw} ry={0.9 * g.bw} fill={ref("core")} />
          {g.candles.map((c, i) => {
            const side = c.kind === "side";
            const color = side ? (c.up ? C.sideUp : C.sideDown) : C.limitWick;
            const bodyH = Math.max(c.bottom - c.top, 1.5);
            return (
              <React.Fragment key={i}>
                <Line x1={c.cx} x2={c.cx} y1={c.high} y2={c.low} stroke={color} strokeWidth={side ? 1 : g.wickW} />
                <Rect x={c.cx - g.bw / 2} y={c.top} width={g.bw} height={bodyH} rx={side ? 1 : Math.min(2, g.bw * 0.12)} fill={side ? color : ref("limit")} />
                {side ? null : <Rect x={c.cx - g.bw / 2} y={c.top} width={g.bw} height={1.5} fill={C.limitCap} opacity={0.55} />}
              </React.Fragment>
            );
          })}
        </Svg>
        </View>
      )}
      {logo ? (
        <View style={{ position: "absolute", left: layout.logoX, top: collapsed ? layout.heroH - authLayout.heroKeyboardH + (authLayout.heroKeyboardH - layout.logoSize * 1.25 - space.sm - authLayout.logoLineH) / 2 : layout.logoY }}>
          <AuthLogo size={layout.logoSize} subtitle={!collapsed} />
        </View>
      ) : null}
    </View>
  );
});
