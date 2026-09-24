import { useColorScheme } from "react-native";
import { useSettings } from "@/lib/settings";

import { dark, light, type Theme } from "./tokens";

/** 색·간격·글자 토큰은 tokens.ts (순수 모듈). 여기서는 설정에 맞는 테마를 고르는 훅만 */
export { changeColor, dark, font, light, radius, space, type ChartColors, type Theme } from "./tokens";

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const { themeMode } = useSettings();
  const isDark = themeMode === "dark" || (themeMode === "system" && scheme !== "light");
  return isDark ? dark : light;
}
