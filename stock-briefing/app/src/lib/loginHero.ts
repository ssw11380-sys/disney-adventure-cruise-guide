import { authFont, authLayout } from "@/tokens";

/**
 * 로그인 화면 배치와 첫 화면 그림(히어로)의 기하 (계정 A단계, hero-spec.md 4·5장). 순수 함수 — 테스트가 네 크기의 값을 확인한다.
 *  - 이번 단계는 움직임 없이 마지막 장면(횡보 16봉 + 상한가 10봉 + 빛)을 멈춘 모습으로 그린다 (components/auth/LoginHero).
 *    움직이는 그림(시간표 6장·숨쉬기)은 다음 작업이 같은 기하 위에 더한다
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
  /** 키보드가 떠 그림을 접었는지 */
  collapsed: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 창 크기·안전 영역 → 배치. keyboard 면 한 칸 그림을 글자 한 줄 높이로 접는다 */
export function heroLayout(W: number, H: number, insets: Insets, keyboard = false): LoginLayout {
  const logoSize = W < authLayout.wideMin ? authFont.logo : authFont.logoWide;
  if (W >= authLayout.twoColMin && W > H) {
    const heroW = W - authLayout.rightW;
    const formW = authLayout.rightW - 2 * authLayout.gutterWide;
    const w = heroW - 2 * authLayout.twoPlotInset;
    const inner = H - insets.top - insets.bottom;
    const h = Math.min(inner - 80, w);
    const plot = { x0: authLayout.twoPlotInset, y0: insets.top + (inner - h) / 2, w, h };
    return { mode: "two", gutter: authLayout.gutterWide, formW, formX: heroW + authLayout.gutterWide, screenW: W, heroW, heroH: H, plot, logoSize, logoX: plot.x0, logoY: plot.y0 + 4, collapsed: false };
  }
  const gutter = W < authLayout.wideMin ? authLayout.gutter : authLayout.gutterWide;
  const formW = Math.min(W - 2 * gutter, authLayout.formMaxW);
  const formX = (W - formW) / 2;
  const inner = H - insets.top - insets.bottom;
  const body = keyboard ? authLayout.heroKeyboardH : clamp(Math.round(inner * authLayout.heroRatio), authLayout.heroMin, authLayout.heroMax);
  const pw = Math.min(W - 2 * gutter, authLayout.plotMaxW);
  const plot = { x0: (W - pw) / 2, y0: insets.top + authLayout.plotTop, w: pw, h: body - 2 * authLayout.plotTop };
  return { mode: "one", gutter, formW, formX, screenW: W, heroW: W, heroH: body + insets.top, plot, logoSize, logoX: formX, logoY: plot.y0 + 4, collapsed: keyboard };
}

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
  /** 불기둥 높이 */
  flameH: number;
}

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
export const LIMIT_COUNT = 10;
const MIN_BODY = 1.5;

/** 그림 칸 → 봉 26개(횡보 16 + 상한가 10)·눈금·빛 자리 (난수 없음 — 늘 같은 그림) */
export function heroCandles(p: Plot): HeroGeometry {
  const n = SIDE.length + LIMIT_COUNT;
  const slot = p.w / n;
  const cx = (i: number) => p.x0 + (i + 0.5) * slot;
  const bw = clamp(slot * 0.58, 5, 14);
  const wickW = clamp(Math.round(bw * 0.2 * 2) / 2, 1.5, 2.5);
  const bandH = p.h * 0.14;
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
  const lastClose = p.y0 + p.h * 0.12;
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
    flameH: 0.22 * p.h,
  };
}
