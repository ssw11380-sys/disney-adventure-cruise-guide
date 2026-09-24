import type { ThemePeriod } from "@/api/types";
import type { Theme } from "@/tokens";
import { contrast, hexRgb, rgbHex, type Rgb } from "./color";

/**
 * 테마 히트맵 색 (순수 함수 — test/tokens.test.ts 가 모든 등락률에서 글자 대비 4.5 이상인지 본다).
 * 4단계 진하기는 0.75: 0.8 이면 라이트 상승 타일(#D7454C)에서 흰 글자·짙은 글자 모두 4.5 밑 (3-20 리뷰)
 */
/** 기간별 색 눈금의 끝값(%): 하루 ±5%, 1주 ±10%, 1개월 ±20% 에서 가장 진하다 */
export const HEAT_MAX: Record<ThemePeriod, number> = { day: 5, week: 10, month: 20 };
export const HEAT_TILE_H = 72;

/**
 * 등락률 → 타일 배경색·글자색. 0 근처는 회색, 멀어질수록 빨강(상승)·파랑(하락)이 진해진다.
 * 글자색은 실제 배경(바탕 위에 겹친 색)과의 명도 대비가 더 큰 쪽(흰색 또는 짙은 글자)을 고른다 — 라이트·다크 모두 4.5:1 이상이 되게
 */
export function heatColor(t: Theme, rate: number, max: number): { bg: string; fg: string; sub: string } {
  const r = Math.max(-1, Math.min(1, rate / max));
  const mag = Math.abs(r);
  if (mag < 0.03) return { bg: t.surfaceAlt, fg: t.ink, sub: t.ink };
  // 5단계로 끊어 읽기 쉽게 (연속 색보다 구분이 잘 된다)
  const step = mag < 0.15 ? 0.28 : mag < 0.35 ? 0.45 : mag < 0.6 ? 0.62 : mag < 0.85 ? 0.75 : 1;
  const base = hexRgb(r > 0 ? t.up : t.down);
  const under = hexRgb(t.bg);
  const mixed = base.map((c, i) => Math.round(c * step + under[i]! * (1 - step))) as Rgb;
  const bg = rgbHex(mixed);
  const useWhite = contrast(mixed, t.onFill) >= contrast(mixed, t.inkOnLight);
  // 오른·내린 종목 수도 같은 색 (반투명으로 흐리게 하면 작은 글자 대비가 4.5:1 밑으로 떨어진다)
  const fg = useWhite ? t.onFill : t.inkOnLight;
  return { bg, fg, sub: fg };
}

