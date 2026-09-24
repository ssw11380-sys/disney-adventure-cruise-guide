/**
 * 디자인 토큰 (3-20). 색·간격·글자 크기는 여기에만 있다 — 화면 코드는 숫자·hex 를 직접 쓰지 않는다(eslint 로 막음).
 * React Native 를 불러오지 않는 순수 모듈 (테스트·위젯에서 씀). 훅(useTheme)은 theme.ts.
 * 규칙은 docs/디자인-규칙.md. 대비·색 차이는 test/tokens.test.ts 가 지킨다:
 *  - 글자/바탕 조합 대비 4.5 이상 (라이트·다크 모두)
 *  - 강조색·보조선·실시간 점은 상승·하락색과 ΔE2000 20 이상 (등락으로 읽히지 않게)
 */

export interface ChartColors {
  /** 이동평균선: 기간 → 색 */
  ma: Record<number, string>;
  rsi: string;
  macd: string;
  signal: string;
  /** 볼린저 밴드 선·면 */
  band: string;
}

export interface Theme {
  dark: boolean;
  bg: string; // 화면 바탕
  surface: string; // 패널
  surfaceAlt: string; // 표 머리·눌림·입력칸
  line: string; // 구분선
  lineStrong: string;
  ink: string;
  sub: string; // 보조 글자(값 옆 단위 등)
  muted: string; // 흐린 글자(설명·시각)
  accent: string; // 선택·링크·버튼 (등락색과 다른 청록)
  accentInk: string; // accent 위 글자
  gold: string; // 내 평단·보유
  heroFrom: string;
  heroTo: string;
  heroInk: string;
  heroMuted: string;
  up: string; // 상승 (글자·선)
  upBg: string;
  down: string; // 하락
  downBg: string;
  /** 등락률 상자처럼 색을 칠한 칸 (흰 글자가 4.5 이상 읽히는 진한 색) */
  upFill: string;
  downFill: string;
  onFill: string;
  /** 실시간·장중 표시 (등락색과 겹치지 않는 초록) */
  live: string;
  warn: string;
  danger: string;
  code: string;
  shadow: string;
  /** 모달 뒤 어둡게 */
  scrim: string;
  /** 밝은 칸 위 어두운 글자 (히트맵 타일) */
  inkOnLight: string;
  chart: ChartColors;
}

export const dark: Theme = {
  dark: true,
  bg: "#0B0D11",
  surface: "#12151B",
  surfaceAlt: "#1A1E26",
  line: "#20252E",
  lineStrong: "#2C323D",
  ink: "#E8EAED",
  sub: "#B4BAC4",
  muted: "#8A919D",
  accent: "#14B8A6",
  accentInk: "#0B0D11",
  gold: "#E3B341",
  heroFrom: "#12151B",
  heroTo: "#12151B",
  heroInk: "#E8EAED",
  heroMuted: "#8A919D",
  up: "#FF4B55",
  upBg: "rgba(255,75,85,0.14)",
  down: "#3D8EFF",
  downBg: "rgba(61,142,255,0.14)",
  upFill: "#D32F3A",
  downFill: "#2A68D0",
  onFill: "#FFFFFF",
  live: "#3FB950",
  warn: "#E3B341",
  danger: "#FF6B6B",
  code: "#0F1217",
  shadow: "#000000",
  scrim: "rgba(0,0,0,0.55)",
  inkOnLight: "#111418",
  chart: {
    ma: { 5: "#22C55E", 10: "#06B6D4", 20: "#F59E0B", 60: "#D946EF", 120: "#84CC16", 200: "#9CA3AF" },
    rsi: "#D946EF",
    macd: "#14B8A6",
    signal: "#F59E0B",
    band: "#14B8A6",
  },
};

export const light: Theme = {
  dark: false,
  bg: "#EEF0F3",
  surface: "#FFFFFF",
  surfaceAlt: "#F5F6F8",
  line: "#E4E7EB",
  lineStrong: "#D3D7DD",
  ink: "#15181D",
  sub: "#454B55",
  muted: "#646B77",
  accent: "#0F766E",
  accentInk: "#FFFFFF",
  gold: "#87650A",
  heroFrom: "#FFFFFF",
  heroTo: "#FFFFFF",
  heroInk: "#15181D",
  heroMuted: "#646B77",
  up: "#D11A22",
  upBg: "rgba(209,26,34,0.08)",
  down: "#1E62E6",
  downBg: "rgba(30,98,230,0.08)",
  upFill: "#D11A22",
  downFill: "#1E62E6",
  onFill: "#FFFFFF",
  live: "#16762F",
  warn: "#8F5E0F",
  danger: "#C62828",
  code: "#F5F6F8",
  shadow: "#000000",
  scrim: "rgba(0,0,0,0.45)",
  inkOnLight: "#111418",
  chart: {
    ma: { 5: "#15803D", 10: "#0891B2", 20: "#A16207", 60: "#A21CAF", 120: "#4D7C0F", 200: "#78716C" },
    rsi: "#A21CAF",
    macd: "#0F766E",
    signal: "#A16207",
    band: "#0F766E",
  },
};

/** 등락 색 (0 이면 기본 글자색) */
export function changeColor(t: Theme, v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0 || !Number.isFinite(v)) return t.ink;
  return v > 0 ? t.up : t.down;
}

/** 간격 7단계. 이 밖의 값은 쓰지 않는다 (0 은 허용) */
export const space = { xxs: 2, xs: 4, s: 6, sm: 8, md: 12, lg: 14, xl: 20 } as const;
export const radius = { sm: 4, md: 6, lg: 8 } as const;
/** 글자 크기 6단계 (위젯은 widgets/palette.ts 의 따로 정한 크기) */
export const font = {
  hero: 28,
  title: 20,
  h2: 16,
  body: 14,
  small: 12,
  tiny: 11,
} as const;
