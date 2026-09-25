import { useColorScheme, useWindowDimensions } from "react-native";
import { useSettings } from "@/lib/settings";

import { dark, light, type Theme } from "./tokens";

/** 색·간격·글자 토큰은 tokens.ts (순수 모듈). 여기서는 설정에 맞는 테마를 고르는 훅만 */
export { changeColor, dark, font, fontCap, layout, light, radius, slopFor, space, touch, type ChartColors, type Theme } from "./tokens";

/** 시스템 글자 확대 배율 (1 = 100%). cap 을 주면 그 상한까지만 — 글자에 맞춰 높이·열 폭을 늘릴 때 쓴다 (3-22) */
export function useFontScale(cap = Infinity): number {
  const { fontScale } = useWindowDimensions();
  return Math.min(Math.max(fontScale || 1, 1), cap);
}

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const { themeMode } = useSettings();
  const isDark = themeMode === "dark" || (themeMode === "system" && scheme !== "light");
  return isDark ? dark : light;
}
