import { useColorScheme } from "react-native";

/**
 * 색·간격·글자 토큰. 라이트/다크 둘 다 정의하고 컴포넌트는 토큰만 쓴다.
 * 톤: 프라이빗 뱅킹 앱처럼 차분한 네이비 + 골드 포인트. 등락은 한국 관례(상승 빨강, 하락 파랑).
 */
export interface Theme {
  bg: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  gold: string;
  heroFrom: string; // 홈 상단 자산 카드 그라데이션
  heroTo: string;
  heroInk: string;
  heroMuted: string;
  up: string; // 상승 (한국 관례: 빨강)
  down: string; // 하락 (파랑)
  warn: string;
  danger: string;
  code: string;
  shadow: string;
}

export const light: Theme = {
  bg: "#F4F5F9",
  surface: "#FFFFFF",
  surfaceAlt: "#EEF1F7",
  line: "#E2E6EE",
  ink: "#101828",
  muted: "#667085",
  accent: "#1D3B8A",
  accentInk: "#FFFFFF",
  gold: "#B8912E",
  heroFrom: "#0F1E45",
  heroTo: "#1D3B8A",
  heroInk: "#FFFFFF",
  heroMuted: "#B8C4E6",
  up: "#D9363E",
  down: "#2A6BE8",
  warn: "#9A6B00",
  danger: "#B42318",
  code: "#EEF1F7",
  shadow: "#0F1E45",
};

export const dark: Theme = {
  bg: "#0B0F17",
  surface: "#141B27",
  surfaceAlt: "#1C2534",
  line: "#273144",
  ink: "#E9EDF5",
  muted: "#93A0B8",
  accent: "#8FB0FF",
  accentInk: "#0B0F17",
  gold: "#E1C25B",
  heroFrom: "#152651",
  heroTo: "#0E1730",
  heroInk: "#FFFFFF",
  heroMuted: "#A9B7DD",
  up: "#FF6B6B",
  down: "#6EA8FF",
  warn: "#E0B04A",
  danger: "#FF7B72",
  code: "#0F1521",
  shadow: "#000000",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 10, md: 16, lg: 22 } as const;
export const font = {
  hero: 30,
  title: 24,
  h2: 17,
  body: 15,
  small: 13,
  tiny: 11,
} as const;
