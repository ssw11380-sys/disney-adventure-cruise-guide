import { useColorScheme } from "react-native";

/** 색 토큰. 라이트/다크 둘 다 정의하고 컴포넌트는 토큰만 쓴다. */
export interface Theme {
  bg: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  up: string; // 상승 (한국 관례: 빨강)
  down: string; // 하락 (파랑)
  warn: string;
  danger: string;
  code: string;
}

export const light: Theme = {
  bg: "#f5f6f3",
  surface: "#ffffff",
  surfaceAlt: "#eef0eb",
  line: "#d9ddd5",
  ink: "#1b221d",
  muted: "#5f6a63",
  accent: "#1f6f5c",
  accentInk: "#ffffff",
  up: "#c8342b",
  down: "#1f5fbf",
  warn: "#9a6b00",
  danger: "#b3261e",
  code: "#eef0eb",
};

export const dark: Theme = {
  bg: "#131714",
  surface: "#1b201c",
  surfaceAlt: "#232a25",
  line: "#2e3630",
  ink: "#e7ece8",
  muted: "#9aa69e",
  accent: "#5cc4a6",
  accentInk: "#0f1a15",
  up: "#ff6b61",
  down: "#6ea8ff",
  warn: "#e0b04a",
  danger: "#ff7b72",
  code: "#101512",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 6, md: 10, lg: 14 } as const;
export const font = {
  title: 22,
  h2: 17,
  body: 15,
  small: 13,
  tiny: 11,
} as const;
