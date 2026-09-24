/**
 * 위젯 팔레트 (3-20): 홈 화면 위젯의 색·글자 크기는 여기에만 둔다.
 * 위젯은 안드로이드 RemoteViews 로 그려져 앱 테마·아이콘 글꼴을 쓸 수 없고, 칸이 작아 앱보다 작은 글자 단계를 쓴다.
 * 그래서 디자인 토큰 규칙(eslint)의 예외다 — 색은 앱 다크 테마(tokens.ts)와 같은 톤을 유지한다.
 */

import { dark } from "@/tokens";

type Hex = `#${string}`;
const hex = (c: string) => c as Hex;

/** 앱 다크 테마 값을 그대로 쓴다 (테마를 바꾸면 위젯도 따라가게). 위젯에만 있는 색만 여기 */
export const WIDGET_COLORS = {
  bg: hex(dark.surface),
  ink: hex(dark.ink),
  muted: hex(dark.muted),
  line: "rgba(255, 255, 255, 0.07)" as const,
  up: hex(dark.up),
  down: hex(dark.down),
  gold: hex(dark.gold),
  warn: hex(dark.warn),
  white: hex(dark.onFill),
  link: hex(dark.gold),
} as const;

/** 위젯 글자 크기 (dp). 2×2 칸에 맞춘 작은 단계 */
export const WIDGET_FONT = { xs: 9, sm: 10, md: 11, base: 12, title: 13, icon: 14, big: 18, bigger: 19 } as const;
