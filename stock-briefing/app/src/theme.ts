import { useColorScheme } from "react-native";
import { useSettings } from "@/lib/settings";

/**
 * 색·간격·글자 토큰. 증권사 MTS/HTS 톤: 어두운 단색 바탕, 얇은 구분선, 작은 모서리, 촘촘한 표.
 * 등락은 한국 관례(상승 빨강, 하락 파랑). 강조색은 선택 상태·링크에만 쓴다.
 * 기본은 다크. 설정 > 표시에서 라이트/시스템으로 바꿀 수 있다.
 */
export interface Theme {
  dark: boolean;
  bg: string; // 화면 바탕
  surface: string; // 패널
  surfaceAlt: string; // 표 머리·눌림·입력칸
  line: string; // 구분선
  lineStrong: string;
  ink: string;
  sub: string; // 보조 글자(값 옆 단위 등)
  muted: string;
  accent: string; // 선택·링크
  accentInk: string;
  gold: string; // 내 평단
  heroFrom: string;
  heroTo: string;
  heroInk: string;
  heroMuted: string;
  up: string;
  upBg: string;
  down: string;
  downBg: string;
  warn: string;
  danger: string;
  code: string;
  shadow: string;
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
  muted: "#7A828F",
  accent: "#4C8DFF",
  accentInk: "#FFFFFF",
  gold: "#E3B341",
  heroFrom: "#12151B",
  heroTo: "#12151B",
  heroInk: "#E8EAED",
  heroMuted: "#7A828F",
  up: "#FF4B55",
  upBg: "rgba(255,75,85,0.14)",
  down: "#3D8EFF",
  downBg: "rgba(61,142,255,0.14)",
  warn: "#E3B341",
  danger: "#FF6B6B",
  code: "#0F1217",
  shadow: "#000000",
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
  muted: "#7D8490",
  accent: "#1F5FE0",
  accentInk: "#FFFFFF",
  gold: "#B8860B",
  heroFrom: "#FFFFFF",
  heroTo: "#FFFFFF",
  heroInk: "#15181D",
  heroMuted: "#7D8490",
  up: "#E3242B",
  upBg: "rgba(227,36,43,0.08)",
  down: "#1E62E6",
  downBg: "rgba(30,98,230,0.08)",
  warn: "#B7791F",
  danger: "#C62828",
  code: "#F5F6F8",
  shadow: "#000000",
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const { themeMode } = useSettings();
  const isDark = themeMode === "dark" || (themeMode === "system" && scheme !== "light");
  return isDark ? dark : light;
}

/** 등락 색 (0 이면 기본 글자색) */
export function changeColor(t: Theme, v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0 || !Number.isFinite(v)) return t.ink;
  return v > 0 ? t.up : t.down;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 14, xl: 20 } as const;
export const radius = { sm: 4, md: 6, lg: 8 } as const;
export const font = {
  hero: 28,
  title: 20,
  h2: 15,
  body: 14,
  small: 12,
  tiny: 11,
} as const;
