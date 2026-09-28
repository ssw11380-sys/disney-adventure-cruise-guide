import { authFont, authLayout } from "@/tokens";

/**
 * 로그인 화면 배치와 첫 화면 그림(히어로)의 기하·시간표 (계정 A단계, hero-spec.md 4·5·6장). 모두 순수 함수 — 테스트가 네 크기의 값과
 * 매 순간의 모습(봉이 칸 안에 있는지, 계단이 한 칸씩 오르는지, 글자와 겹치지 않는지)을 확인한다.
 *  - 그리는 쪽(components/auth/LoginHero)은 heroScene 의 자리와 heroTracks 의 시간표를 RN Animated(네이티브 드라이버)의
 *    시계 하나에 이어 붙이기만 한다. 프레임마다 JS 가 하는 일은 없다
 *  - heroFrame(scene, t) 는 그 시계가 t 일 때 화면에 보이는 모습을 계산한다 (테스트·캡처 확인용, 그리는 쪽과 같은 식)
 */

export interface Insets {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}

export interface Plot {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface LoginLayout {
  /** one = 한 칸(그림 위 · 입력 아래), two = 두 칸(왼쪽 그림 · 오른쪽 입력) */
  mode: "one" | "two";
  /** 입력 묶음 옆 여백 */
  gutter: number;
  /** 입력 칸 폭 */
  formW: number;
  /** 입력 칸 왼쪽 끝 (화면 기준) */
  formX: number;
  /** 창 폭 (두 칸 화면의 빛은 경계에서 잘리지 않게 창 전체에 그린다) */
  screenW: number;
  /** 그림 영역 폭·높이 (한 칸: 화면 폭 × 그림 높이(위 안전 영역 포함), 두 칸: 왼쪽 영역 × 화면 높이) */
  heroW: number;
  heroH: number;
  /** 그림 칸 (그림 영역 기준 좌표) */
  plot: Plot;
  /** 로고 글자 크기와 자리 (그림 영역 기준) */
  logoSize: number;
  logoX: number;
  logoY: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 창 크기·안전 영역 → 배치. 키보드가 떠도 배치는 바꾸지 않는다 — 그림을 접으면 입력 칸이 한순간에 200dp 넘게 뛰어서,
 * 대신 화면을 부드럽게 스크롤해 그림을 위로 밀어낸다 (AuthFrame)
 */
export function heroLayout(W: number, H: number, insets: Insets): LoginLayout {
  const logoSize = W < authLayout.wideMin ? authFont.logo : authFont.logoWide;
  if (W >= authLayout.twoColMin && W > H) {
    const heroW = W - authLayout.rightW;
    const formW = authLayout.rightW - 2 * authLayout.gutterWide;
    const w = heroW - 2 * authLayout.twoPlotInset;
    const inner = H - insets.top - insets.bottom;
    const h = Math.min(inner - 80, w);
    const plot = { x0: authLayout.twoPlotInset, y0: insets.top + (inner - h) / 2, w, h };
    return { mode: "two", gutter: authLayout.gutterWide, formW, formX: heroW + authLayout.gutterWide, screenW: W, heroW, heroH: H, plot, logoSize, logoX: plot.x0, logoY: plot.y0 + 4 };
  }
  const gutter = W < authLayout.wideMin ? authLayout.gutter : authLayout.gutterWide;
  const formW = Math.min(W - 2 * gutter, authLayout.formMaxW);
  const formX = (W - formW) / 2;
  const inner = H - insets.top - insets.bottom;
  const body = clamp(Math.round(inner * authLayout.heroRatio), authLayout.heroMin, authLayout.heroMax);
  // 그림 칸 폭 = 입력 칸 폭 (로고·차트·입력 칸의 왼쪽 끝이 한 줄 — 펼친 폴드 세로 704 에서 왼쪽 선이 둘로 보이지 않게)
  const plot = { x0: formX, y0: insets.top + authLayout.plotTop, w: formW, h: body - 2 * authLayout.plotTop };
  return { mode: "one", gutter, formW, formX, screenW: W, heroW: W, heroH: body + insets.top, plot, logoSize, logoX: formX, logoY: plot.y0 + 4 };
}

/** 같은 배치인지 (화면이 다시 그려져도 그림·움직임을 새로 만들지 않게) */
export function layoutKey(l: LoginLayout): string {
  return [l.mode, l.screenW, l.heroW, l.heroH, l.plot.x0, l.plot.y0, l.plot.w, l.plot.h, l.logoSize, l.logoX, l.logoY].join("|");
}

// ─── 로고 ('가즈아 불기둥' 금색 글자 + 선 + 부제) ─────────────────────────────

/** SVG 로고 글자 칸 높이 */
export const wordmarkH = (size: number) => Math.round(size * 1.3);

export interface LogoBox {
  x: number;
  y: number;
  size: number;
  /** 글자 폭(겹침 검사용 — 실제 그림 칸은 더 넓다) */
  w: number;
  /** 글자 칸 높이 */
  wordH: number;
  /** 금색 선 y, 부제 위 y (부제 없으면 null) */
  lineY: number;
  subY: number | null;
  /** 로고 묶음 전체 높이 (글자 + 선 + 부제) */
  h: number;
}

/** 로고 묶음의 자리 (그림 영역 기준) */
export function logoBox(l: LoginLayout): LogoBox {
  const size = l.logoSize;
  const wordH = wordmarkH(size);
  const lineY = l.logoY + wordH + authLayout.logoLineGap;
  const subY: number | null = lineY + authLayout.logoLineH + authLayout.logoSubGap;
  const bottom = subY === null ? lineY + authLayout.logoLineH : subY + authLayout.logoSubH;
  return { x: l.logoX, y: l.logoY, size, w: Math.round(size * authLayout.wordmarkInk), wordH, lineY, subY, h: bottom - l.logoY };
}

// ─── 봉 (hero-spec 5장) ──────────────────────────────────────────────────────

export interface HeroCandle {
  /** 봉 가운데 x */
  cx: number;
  /** 몸통 위·아래 y (위가 작다) */
  top: number;
  bottom: number;
  /** 꼬리 위·아래 y */
  high: number;
  low: number;
  /** side = 횡보, limit = 상한가 */
  kind: "side" | "limit";
  up: boolean;
}

export interface HeroGeometry {
  bw: number;
  wickW: number;
  candles: HeroCandle[];
  /** 가로 눈금 5줄 y, 바닥선 y */
  grid: number[];
  baseline: number;
  /** 빛 두 개 (가운데·반지름) */
  glow: { cx: number; cy: number; r: number };
  glow2: { cx: number; cy: number; r: number };
  /** 불기둥 높이 (마지막 봉 종가에서 위로 — 그림 영역 위 끝에서 멈추는 것은 장면이 정한다) */
  pillarH: number;
  /** 상한가 한 계단 높이 */
  step: number;
}

/**
 * 마지막 상한가 종가 자리 (그림 칸 위에서 h 의 몇 배). 0.12 → 0.18 (검증 지적): 한 칸 화면에서 불기둥 위 끝·가장 밝은 곳이
 * 상태 표시줄(배터리·신호 아이콘) 밑까지 올라왔다 — 불기둥이 그림 칸 안(PILLAR_H 만큼)에 들어오게 내린다
 */
export const LAST_CLOSE = 0.18;
/**
 * 불기둥 높이 (그림 칸 h 의 몇 배 — 검증 4차: 0.17 의 짧은 불꽃이 촛불처럼 보여, 그림 위쪽으로 길게 솟는 빛 기둥으로). 그림 영역 위 끝(0)에 닿으면 거기서 멈춘다 —
 * 위로 갈수록 투명해 상태 표시줄 밑까지 올라가도 되고(hero-spec 4.1), 가장 밝은 아래쪽은 상태 표시줄 아래 (테스트)
 */
export const PILLAR_H = 0.36;
/** 횡보 띠 높이 (그림 칸 h 의 몇 배 — 검증 4차: 0.14 는 횡보 봉이 납작한 점처럼 보였다) */
export const SIDE_BAND = 0.2;

/** 횡보 봉 16개 (띠 단위 u: 시가·종가·고가·저가, 위가 +) — hero-spec 5.3 */
const SIDE: readonly (readonly [number, number, number, number])[] = [
  [-0.1, 0.2, 0.35, -0.25],
  [0.2, -0.05, 0.3, -0.2],
  [-0.05, 0.1, 0.25, -0.3],
  [0.1, -0.3, 0.2, -0.45],
  [-0.3, -0.1, 0, -0.5],
  [-0.1, -0.15, 0.1, -0.35],
  [-0.15, 0.25, 0.4, -0.2],
  [0.25, 0.05, 0.45, -0.1],
  [0.05, -0.2, 0.15, -0.4],
  [-0.2, 0, 0.1, -0.55],
  [0, 0.3, 0.45, -0.1],
  [0.3, 0.1, 0.4, -0.05],
  [0.1, 0.15, 0.35, -0.15],
  [0.15, -0.1, 0.25, -0.3],
  [-0.1, 0.35, 0.5, -0.2],
  [0.35, 0.6, 0.75, 0.25],
];
export const SIDE_COUNT = SIDE.length;
export const LIMIT_COUNT = 10;
const MIN_BODY = 1.5;

/** 그림 칸 → 봉 26개(횡보 16 + 상한가 10)·눈금·빛 자리 (난수 없음 — 늘 같은 그림) */
export function heroCandles(p: Plot): HeroGeometry {
  const n = SIDE.length + LIMIT_COUNT;
  const slot = p.w / n;
  const cx = (i: number) => p.x0 + (i + 0.5) * slot;
  const bw = clamp(slot * 0.58, 5, 14);
  const wickW = clamp(Math.round(bw * 0.2 * 2) / 2, 1.5, 2.5);
  const bandH = p.h * SIDE_BAND;
  const bandBottom = p.y0 + p.h * 0.98;
  const bandMid = bandBottom - bandH / 2;
  const y = (u: number) => bandMid - (u * bandH) / 2;
  const candles: HeroCandle[] = SIDE.map(([o, c, hi, lo], i) => {
    let top = y(Math.max(o, c));
    let bottom = y(Math.min(o, c));
    if (bottom - top < MIN_BODY) {
      const mid = (top + bottom) / 2;
      top = mid - MIN_BODY / 2;
      bottom = mid + MIN_BODY / 2;
    }
    return { cx: cx(i), top, bottom, high: y(hi), low: y(lo), kind: "side", up: c >= o };
  });
  const base = y(0.6);
  const lastClose = p.y0 + p.h * LAST_CLOSE;
  const step = (base - lastClose) / LIMIT_COUNT;
  for (let k = 0; k < LIMIT_COUNT; k++) {
    const prev = base - k * step;
    const open = prev - 0.06 * step;
    const close = prev - step;
    candles.push({ cx: cx(SIDE.length + k), top: close, bottom: open, high: close, low: prev + 0.18 * step, kind: "limit", up: true });
  }
  const last = candles[n - 1]!;
  const sixth = candles[SIDE.length + 5]!;
  return {
    bw,
    wickW,
    candles,
    grid: [1, 2, 3, 4, 5].map((i) => p.y0 + (p.h * i) / 6),
    baseline: bandBottom + 6,
    glow: { cx: last.cx, cy: last.top, r: 0.55 * p.h },
    glow2: { cx: sixth.cx, cy: sixth.top, r: 0.33 * p.h },
    pillarH: PILLAR_H * p.h,
    step,
  };
}

// ─── 한 장면 (그리는 쪽이 쓰는 자리 — 그림 영역 기준 dp) ──────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridLine {
  y: number;
  x1: number;
  x2: number;
}

export interface SceneSide {
  i: number;
  up: boolean;
  /** 꼬리 위 끝 ~ 아래 끝 (움직이는 묶음), 몸통 위·아래 */
  box: Rect;
  bodyTop: number;
  bodyBottom: number;
  /** 크기가 자라는 기준 y (몸통 가운데) */
  pivotY: number;
  /** 꼬리 (1dp) 왼쪽 끝 — 묶음(box) 왼쪽 기준, 폭 */
  wickX: number;
  wickW: number;
}

export interface SceneLimit {
  k: number;
  /** 몸통 (위 = 종가 = 고가, 아래 = 시가). 시가를 기준으로 위로 자란다 */
  body: Rect;
  /** 아래 꼬리 (시가 ~ 저가) */
  wick: Rect;
  /** 몸통 맨 위 천장 띠 높이 */
  capH: number;
  radius: number;
}

/**
 * 불기둥 (검증 4차): 마지막 상한가 봉 종가에서 그림 위쪽으로 곧게 솟는 **세로 빛 기둥** — 폭이 위아래 같고(부풂 없음), 끝이 뾰족하지 않고
 * 위로 갈수록 투명해진다. 가로로는 가운데가 밝고 양옆으로 부드럽게 옅어진다 (붉은 빛 → 가운데 따뜻한 흰 심).
 * 예전 모양(몸통 폭에서 부풀었다가 뾰족해지는 불꽃 + 아래까지 내려온 크림 심)은 촛불처럼 보였다.
 * 아래 끝은 종가(몸통 위 끝)보다 조금 아래 — 몸통 뒤에서 옅게 시작해 봉에서 솟는 모양
 */
export interface ScenePillar {
  cx: number;
  /** 아래 끝 y (몸통 위 끝보다 조금 아래 — 몸통 뒤), 위 끝 y (그림 영역 위 끝 0 아래) */
  base: number;
  top: number;
  /** 기둥 폭 = 몸통 폭 × PILLAR_W (그리는 칸의 폭 — 양옆은 투명으로 옅어짐), 가운데 따뜻한 흰 심 폭 = 몸통 폭 × PILLAR_CORE_W */
  w: number;
  coreW: number;
}

export interface HeroScene {
  layout: LoginLayout;
  plot: Plot;
  bw: number;
  wickW: number;
  step: number;
  grid: GridLine[];
  baseline: GridLine;
  side: SceneSide[];
  limit: SceneLimit[];
  glow: { cx: number; cy: number; r: number };
  glow2: { cx: number; cy: number; r: number };
  pillar: ScenePillar;
  logo: LogoBox;
}

/** 로고 묶음(글자·금색 선·부제) 위아래로 이만큼 안에 걸리는 눈금은 그리지 않는다 (금색 선과 눈금이 1~2dp 어긋나 한 줄이 틀어진 것처럼 보였다) */
export const GRID_LOGO_GAP = 8;
/** 불기둥 폭 = 봉 몸통 폭 × PILLAR_W (2~3배 — 양옆으로 옅어지는 빛까지), 가운데 따뜻한 흰 심 폭 = × PILLAR_CORE_W */
export const PILLAR_W = 2.8;
export const PILLAR_CORE_W = 0.9;

/** 화면 픽셀에 맞추는 함수 (그리는 쪽은 PixelRatio.roundToNearestPixel, 테스트는 그대로) */
export type Snap = (v: number) => number;
const asIs: Snap = (v) => v;

/**
 * 배치 → 한 장면 (움직임의 마지막 모습).
 *  - 눈금은 로고 묶음 높이(± GRID_LOGO_GAP)에 걸리면 그리지 않는다
 *  - snap: 봉 몸통·꼬리의 x·폭과 y, 눈금 y 를 화면 픽셀에 맞춘다 (폴드 dpr 2.625 에서 봉마다 굵기가 24/25px·꼬리 2/3px 로 달라 보였다).
 *    폭은 한 번만 맞춰 모든 봉이 같은 굵기
 *  - hair: 화면 한 픽셀(dp) — 상한가 몸통 맨 위 천장 띠 두께 (검증 4차: 1.5dp 는 굵은 크림 띠로 보였다. 픽셀에 맞춘 몸통 위 끝에 한 픽셀 밝은 선)
 */
export function heroScene(layout: LoginLayout, snap: Snap = asIs, hair = 0.5): HeroScene {
  const p = layout.plot;
  const g = heroCandles(p);
  const logo = logoBox(layout);
  const px = snap(1) > 0 ? snap(1) : 1;
  const bw = Math.max(px, snap(g.bw));
  const wickW = Math.max(px, snap(g.wickW));
  const x2 = p.x0 + p.w;
  const hitsLogo = (y: number) => y >= logo.y - GRID_LOGO_GAP && y <= logo.y + logo.h + GRID_LOGO_GAP && logo.x < x2 && logo.x + logo.w > p.x0;
  const side: SceneSide[] = [];
  const limit: SceneLimit[] = [];
  g.candles.forEach((c, i) => {
    const x = snap(c.cx - bw / 2);
    if (c.kind === "side") {
      const y = snap(c.high);
      const bodyTop = snap(c.top);
      const bodyBottom = Math.max(snap(c.bottom), bodyTop + px);
      side.push({ i, up: c.up, box: { x, y, w: bw, h: snap(c.low) - y }, bodyTop, bodyBottom, pivotY: (bodyTop + bodyBottom) / 2, wickX: snap(c.cx - px / 2) - x, wickW: px });
    } else {
      const top = snap(c.top);
      const bottom = snap(c.bottom);
      limit.push({
        k: i - SIDE_COUNT,
        body: { x, y: top, w: bw, h: bottom - top },
        wick: { x: snap(c.cx - wickW / 2), y: bottom, w: wickW, h: snap(c.low) - bottom },
        capH: hair,
        radius: Math.min(2, bw * 0.12),
      });
    }
  });
  const last = limit[limit.length - 1]!;
  const pillar: ScenePillar = {
    // 가운데는 픽셀에 맞춘 몸통의 가운데
    cx: last.body.x + bw / 2,
    base: last.body.y + Math.min(3, last.body.h * 0.3),
    top: Math.max(0, last.body.y - g.pillarH),
    w: bw * PILLAR_W,
    coreW: bw * PILLAR_CORE_W,
  };
  return {
    layout,
    plot: p,
    bw,
    wickW,
    step: g.step,
    grid: g.grid.filter((y) => !hitsLogo(y)).map((y) => ({ y: snap(y), x1: p.x0, x2 })),
    baseline: { y: snap(g.baseline), x1: p.x0, x2 },
    side,
    limit,
    glow: { ...g.glow, cy: last.body.y },
    glow2: g.glow2,
    pillar,
    logo,
  };
}

// ─── 시간표 (hero-spec 6장) ─────────────────────────────────────────────────

/** 처음 한 번 재생 길이 */
export const HERO_MS = 4200;
/** 숨쉬기 한 번 (빛·불기둥 밝기 1 → 0.82 → 1) */
export const BREATH_MS = 3600;
export const BREATH_MIN = 0.82;
/** 첫 재생을 화면이 뜬 뒤 조금 늦게 (스플래시가 내려가고 첫 그리기가 끝난 뒤 — 처음부터 보이게). 검증 4차: 0.22 → 0.1초 (빈 첫 화면이 길어 보였다) */
export const HERO_START_DELAY_MS = 100;
/** 크기가 0 이 되면 안드로이드 행렬이 깨질 수 있어 이보다 작게는 줄이지 않는다 (불투명도로 가린다) */
export const MIN_SCALE = 0.01;

/** 시계 값(ms) → 속성 값. 사이는 직선, 바깥은 끝값 (Animated interpolate 의 extrapolate: "clamp" 와 같다) */
export interface Track {
  readonly input: readonly number[];
  readonly output: readonly number[];
}

/** 감속(ease-out cubic 1 − (1 − x)³)을 점 7개로 — 네이티브 드라이버는 easing 함수 대신 이 점들을 직선으로 잇는다 */
export const EASE_OUT: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.1, 0.271],
  [0.2, 0.488],
  [0.35, 0.725],
  [0.5, 0.875],
  [0.7, 0.973],
  [1, 1],
];

export function easeTrack(start: number, dur: number, from = 0, to = 1): Track {
  return { input: EASE_OUT.map(([x]) => start + x * dur), output: EASE_OUT.map(([, y]) => from + (to - from) * y) };
}
export function linearTrack(start: number, dur: number, from = 0, to = 1): Track {
  return { input: [start, start + dur], output: [from, to] };
}
/** 두 시간표를 이어 붙인다 (앞의 끝 = 뒤의 처음이면 한 점으로) */
export function joinTracks(a: Track, b: Track): Track {
  const input = [...a.input];
  const output = [...a.output];
  b.input.forEach((x, i) => {
    if (i === 0 && x === input[input.length - 1]) return;
    input.push(x);
    output.push(b.output[i]!);
  });
  return { input, output };
}
/** 시간표의 모든 값에 식을 적용 (크기 → 그에 맞는 옮김처럼 — 사이가 직선이라 같은 점에서 바꿔도 결과가 같다) */
export function mapTrack(t: Track, f: (v: number) => number): Track {
  return { input: t.input, output: t.output.map(f) };
}

/** 크기 시간표: 0 대신 MIN_SCALE (안드로이드 행렬이 깨지지 않게 — 그 순간에는 불투명도 0 이라 보이지 않는다) */
export function growTrack(t: Track): Track {
  return mapTrack(t, (v) => Math.max(MIN_SCALE, v));
}

export function sampleTrack(tr: Track, t: number): number {
  const { input: xs, output: ys } = tr;
  if (t <= xs[0]!) return ys[0]!;
  const n = xs.length - 1;
  if (t >= xs[n]!) return ys[n]!;
  for (let i = 1; i <= n; i++) {
    if (t <= xs[i]!) {
      const x0 = xs[i - 1]!;
      const x1 = xs[i]!;
      const r = x1 === x0 ? 1 : (t - x0) / (x1 - x0);
      return ys[i - 1]! + r * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys[n]!;
}

export interface HeroTracks {
  /** 눈금·바닥선 불투명도 */
  grid: Track;
  /** 빛(glow·glow2) 불투명도 — 숨쉬기를 곱한다 */
  glow: Track;
  /** 횡보 봉 i: 불투명도, 세로 크기(몸통 가운데 기준 0.3 → 1) */
  side: { opacity: Track; scale: Track }[];
  /** 상한가 봉 k: 보이기(꼬리와 함께 0 → 1), 몸통 세로 크기(시가 기준 0 → 1), 천장 띠 불투명도(0 → 0.55) */
  limit: { show: Track; grow: Track; cap: Track }[];
  /** 불기둥 (마지막 봉 하나): 세로 크기(아래 = 봉 종가 기준 0 → 1), 불투명도(0 → 1) — 숨쉬기를 곱한다 */
  pillar: { grow: Track; opacity: Track };
  logo: { opacity: Track; shift: Track };
  /** 금색 선 가로 크기(왼쪽 기준)와 보이기(그어지기 시작할 때 켜짐 — 그 전에는 점 하나도 보이지 않게), 부제 불투명도 */
  line: Track;
  lineShow: Track;
  sub: Track;
}

export const SIDE_START = 150;
export const SIDE_GAP = 70;
export const SIDE_DUR = 300;
export const LIMIT_START = 1500;
export const LIMIT_GAP = 205;
export const LIMIT_DUR = 260;
export const CAP_DELAY = 0;
export const CAP_DUR = 80;
export const FLAME_START = 3600;
/**
 * 로고(금색 '가즈아 불기둥')는 처음에 먼저 (검증 지적 — 예전 명세는 3.7초에야 나와 첫 3.7초가 '빈 차트를 불러오는 중'처럼 보였다):
 * 글자 0.2~0.8초(감속, 8dp 아래에서 제자리로), 금색 선 0.45~0.8초(왼쪽부터), 부제 0.5~0.8초. 3.6~4.2초 절정에는 빛·불기둥만 켜진다
 */
export const LOGO_START = 200;
export const LOGO_DUR = 600;
export const LINE_START = 450;
export const SUB_START = 500;
/** 로고 묶음이 다 보이는 때 */
export const LOGO_END = LOGO_START + LOGO_DUR;

/** 빛(glow·glow2)이 켜지기 시작하는 때 — 상한가 봉이 절반쯤 오른 뒤 (그 전에는 봉이 아직 바닥에 있는데 빈 오른쪽 위가 먼저 붉어졌다) */
export const GLOW_START = 2600;

/** 전체 시간표 (4.2초, 모든 요소는 나타나기만 하고 사라지지 않는다 — 깜빡임 없음) */
export function heroTracks(): HeroTracks {
  const side = Array.from({ length: SIDE_COUNT }, (_, i) => {
    const s = SIDE_START + SIDE_GAP * i;
    return { opacity: linearTrack(s, SIDE_DUR * 0.6), scale: easeTrack(s, SIDE_DUR, 0.3, 1) };
  });
  const limit = Array.from({ length: LIMIT_COUNT }, (_, k) => {
    const s = LIMIT_START + LIMIT_GAP * k;
    return { show: linearTrack(s, 100), grow: easeTrack(s, LIMIT_DUR), cap: linearTrack(s + LIMIT_DUR + CAP_DELAY, CAP_DUR, 0, 0.55) };
  });
  return {
    grid: linearTrack(0, 300),
    glow: joinTracks(linearTrack(GLOW_START, FLAME_START - GLOW_START, 0, 0.7), easeTrack(FLAME_START, HERO_MS - FLAME_START, 0.7, 1)),
    side,
    limit,
    // 불기둥은 마지막 봉 종가에서 위로 솟는다 (3.6 ~ 4.2초 — 절정)
    pillar: { grow: easeTrack(FLAME_START, HERO_MS - FLAME_START), opacity: easeTrack(FLAME_START, HERO_MS - FLAME_START) },
    logo: { opacity: easeTrack(LOGO_START, LOGO_DUR), shift: easeTrack(LOGO_START, LOGO_DUR, 8, 0) },
    line: easeTrack(LINE_START, LOGO_END - LINE_START),
    lineShow: linearTrack(LINE_START, 40),
    sub: linearTrack(SUB_START, LOGO_END - SUB_START),
  };
}

/** 숨쉬기 한 번(위상 0 → 1)의 밝기: 1 → 0.82 → 1, 코사인 모양 (점 9개) */
export function breathTrack(): Track {
  const n = 8;
  const input: number[] = [];
  const output: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    input.push(x);
    output.push(1 - ((1 - BREATH_MIN) * (1 - Math.cos(2 * Math.PI * x))) / 2);
  }
  return { input, output };
}

// ─── 한 순간의 모습 (테스트·확인용 — 그리는 쪽과 같은 식) ─────────────────────

export interface FrameItem {
  id: string;
  rect: Rect;
  opacity: number;
}

/** 가운데가 c 인 [y, y + h] 를 기준 p 로 s 배 → 새 [y, h] */
export const scaleAbout = (y: number, h: number, p: number, s: number): [number, number] => [p + s * (y - p), s * h];

/** 크기를 기준점 p 로 바꾸려면 옮길 거리: 보통 변형(가운데 기준 크기)에 앞서 translate (p − 가운데)(1 − s) */
export const pivotShift = (y: number, h: number, p: number, s: number) => (p - (y + h / 2)) * (1 - s);

/**
 * 시계 t(ms)·숨쉬기 위상 phase 일 때 보이는 요소들의 자리와 불투명도. 불투명도 0 인 것도 넣는다 (자리 검사는 모든 순간에)
 */
export function heroFrame(scene: HeroScene, t: number, phase = 0, tracks: HeroTracks = heroTracks()): FrameItem[] {
  const out: FrameItem[] = [];
  const breath = sampleTrack(breathTrack(), phase);
  const gridO = sampleTrack(tracks.grid, t);
  for (const [i, g] of scene.grid.entries()) out.push({ id: `grid${i}`, rect: { x: g.x1, y: g.y, w: g.x2 - g.x1, h: 0 }, opacity: gridO });
  scene.side.forEach((c, i) => {
    const tr = tracks.side[i]!;
    const s = sampleTrack(growTrack(tr.scale), t);
    const [y, h] = scaleAbout(c.box.y, c.box.h, c.pivotY, s);
    out.push({ id: `side${i}`, rect: { x: c.box.x, y, w: c.box.w, h }, opacity: sampleTrack(tr.opacity, t) });
  });
  scene.limit.forEach((c, k) => {
    const tr = tracks.limit[k]!;
    const show = sampleTrack(tr.show, t);
    const s = sampleTrack(growTrack(tr.grow), t);
    const bottom = c.body.y + c.body.h;
    const [y, h] = scaleAbout(c.body.y, c.body.h, bottom, s);
    out.push({ id: `limit${k}`, rect: { x: c.body.x, y, w: c.body.w, h }, opacity: show });
    out.push({ id: `wick${k}`, rect: c.wick, opacity: show });
    out.push({ id: `cap${k}`, rect: { x: c.body.x, y, w: c.body.w, h: c.capH * s }, opacity: show * sampleTrack(tr.cap, t) });
  });
  const glowO = sampleTrack(tracks.glow, t) * breath;
  out.push({ id: "glow", rect: { x: scene.glow.cx - scene.glow.r, y: scene.glow.cy - scene.glow.r, w: 2 * scene.glow.r, h: 2 * scene.glow.r }, opacity: glowO });
  const P = scene.pillar;
  const ps = sampleTrack(growTrack(tracks.pillar.grow), t);
  const [py, ph] = scaleAbout(P.top, P.base - P.top, P.base, ps);
  out.push({ id: "pillar", rect: { x: P.cx - P.w / 2, y: py, w: P.w, h: ph }, opacity: sampleTrack(tracks.pillar.opacity, t) * breath });
  const L = scene.logo;
  const shift = sampleTrack(tracks.logo.shift, t);
  out.push({ id: "logo", rect: { x: L.x, y: L.y + shift, w: L.w, h: L.wordH }, opacity: sampleTrack(tracks.logo.opacity, t) });
  out.push({ id: "line", rect: { x: L.x, y: L.lineY, w: authLayout.logoLineW * sampleTrack(tracks.line, t), h: authLayout.logoLineH }, opacity: sampleTrack(tracks.lineShow, t) });
  if (L.subY !== null) out.push({ id: "sub", rect: { x: L.x, y: L.subY, w: L.w, h: authLayout.logoSubH }, opacity: sampleTrack(tracks.sub, t) });
  return out;
}

// ─── 회원가입 머리의 작은 정지 계단 ───────────────────────────────────────────

/** 작은 계단의 봉 수 — 100dp 남짓한 칸에 10개를 넣으면 봉이 점처럼 보여, 봉 모양(세로로 긴 몸통)이 보이게 6개로 줄인다 */
export const MINI_COUNT = 6;

/**
 * 회원가입 머리의 작은 계단 칸 (로고 글자 크기에 맞춘다): 높이 = 로고 글자 칸 × 2.4, 폭 = 높이 × 0.9, 빛 거리 = 높이 × 0.4.
 * baselineGap: 로고 묶음(글자 + 금색 선) 아래 끝에서 글자 바탕선까지 — 계단 맨 아래를 바탕선에 맞추려고 계단 아래에 두는 여백
 */
export function miniStairsBox(size: number): { w: number; h: number; glow: number; baselineGap: number } {
  const h = Math.round(wordmarkH(size) * authLayout.miniStairsH);
  const logoBottom = wordmarkH(size) + authLayout.logoLineGap + authLayout.logoLineH;
  return { w: Math.round(h * authLayout.miniStairsW), h, glow: Math.round(h * authLayout.miniStairsGlow), baselineGap: logoBottom - wordmarkBaseline(size) };
}

/** SVG 로고 글자 바탕선 y (글자 칸 위 끝 기준 — GoldWordmark 가 이 자리에 글자를 놓는다) */
export const wordmarkBaseline = (size: number) => Math.round(size * 1.02);

/** 폭 w × 높이 h 칸에 상한가 봉 계단 (몸통·아래 꼬리). 아래에서 위로 한 칸씩, 윗꼬리 없음 */
export function miniStairs(w: number, h: number, count = MINI_COUNT): { bw: number; bodies: Rect[]; wicks: Rect[] } {
  const slot = w / count;
  const bw = clamp(slot * 0.56, 2, 10);
  const step = (h * 0.86) / (count + 0.18);
  const base = h - 0.18 * step;
  const bodies: Rect[] = [];
  const wicks: Rect[] = [];
  for (let k = 0; k < count; k++) {
    const prev = base - k * step;
    const close = prev - step;
    const open = prev - 0.06 * step;
    const x = (k + 0.5) * slot - bw / 2;
    bodies.push({ x, y: close, w: bw, h: open - close });
    wicks.push({ x: (k + 0.5) * slot - 0.5, y: open, w: 1, h: prev + 0.18 * step - open });
  }
  return { bw, bodies, wicks };
}

// ─── 키보드: 누른 칸이 가리지 않게 ─────────────────────────────────────────────

/**
 * 누른 칸(내용 기준 y·높이)이 키보드 위에 보이도록 스크롤할 위치. 이미 보이면 null.
 *  - below: 칸 아래로 더 보이고 싶은 높이 (비밀번호 칸이면 [로그인] 버튼까지)
 *  - viewportH: 스크롤 창 높이, kb: 키보드 높이 (스크롤 창 아래를 가린다), margin: 위아래 여유
 */
export function revealScrollY(o: { y: number; h: number; below?: number; scrollY: number; viewportH: number; kb: number; margin?: number }): number | null {
  const margin = o.margin ?? 16;
  const visible = Math.max(0, o.viewportH - o.kb);
  const top = o.y - margin;
  const bottom = o.y + o.h + (o.below ?? 0) + margin;
  if (top < o.scrollY) return Math.max(0, top);
  if (bottom > o.scrollY + visible) {
    // 칸 위쪽이 가려지지 않는 선까지만 (아래로 보이고 싶은 것보다 누른 칸이 먼저)
    return Math.max(0, Math.min(bottom - visible, top));
  }
  return null;
}
