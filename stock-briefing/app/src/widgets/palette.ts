/**
 * 위젯 팔레트 (3-20·3-23): 홈 화면 위젯의 색·글자 크기·누르는 칸 크기는 여기에만 둔다.
 * 위젯은 안드로이드 RemoteViews 로 그려져 앱 테마·아이콘 글꼴을 쓸 수 없고, 칸이 작아 앱보다 작은 글자 단계를 쓴다.
 * 그래서 디자인 토큰 규칙(eslint)의 예외다 — 색은 앱 테마(tokens.ts)의 라이트·다크 값을 그대로 쓴다.
 * 위젯은 라이트·다크 두 벌을 함께 그려 두고(3-23), 안드로이드가 시스템 테마에 맞는 쪽을 보여 준다 (서버 재조회 없이 바로 바뀜).
 */

import { dark, light, type Theme } from "@/tokens";

type Hex = `#${string}`;
const hex = (c: string) => c as Hex;

export type WidgetScheme = "light" | "dark";

export interface WidgetPalette {
  scheme: WidgetScheme;
  /** 위젯 바탕 (앱 패널색) */
  bg: Hex;
  ink: Hex;
  /** 보조 글자 */
  sub: Hex;
  /** 흐린 글자 (시각·설명·지연된 지수) */
  muted: Hex;
  line: Hex;
  up: Hex;
  down: Hex;
  gold: Hex;
  warn: Hex;
  /** "갱신 중" 표시 (등락색과 다른 청록) */
  accent: Hex;
  link: Hex;
  /** 장중 초록 점 (등락색과 겹치지 않는 초록, 앱 지수 띠의 점과 같은 색) */
  live: Hex;
  /** 카드 테두리 (라이트 지수·환율 위젯의 얇은 테두리) */
  edge: Hex;
  /**
   * 카드 바탕 그라데이션 (지수·환율 위젯): 다크는 패널색 → 한 단계 깊은 화면 바탕색으로 비스듬히.
   * 라이트는 없음 — 흰 카드에 얇은 테두리. 두 끝 색 모두 앱 테마 값이라 글자 대비(4.5 이상)가 그대로 지켜진다
   */
  gradient: { from: Hex; to: Hex } | null;
}

/** 앱 테마 값을 그대로 쓴다 (테마를 바꾸면 위젯도 따라가게). 위젯만의 색은 두지 않는다 */
function fromTheme(scheme: WidgetScheme, t: Theme): WidgetPalette {
  return {
    scheme,
    bg: hex(t.surface),
    ink: hex(t.ink),
    sub: hex(t.sub),
    muted: hex(t.muted),
    line: hex(t.line),
    up: hex(t.up),
    down: hex(t.down),
    gold: hex(t.gold),
    warn: hex(t.warn),
    accent: hex(t.accent),
    link: hex(t.gold),
    live: hex(t.live),
    edge: hex(t.line),
    gradient: t.dark ? { from: hex(t.surface), to: hex(t.bg) } : null,
  };
}

export const WIDGET_PALETTES: Record<WidgetScheme, WidgetPalette> = {
  light: fromTheme("light", light),
  dark: fromTheme("dark", dark),
};

/** 다크 팔레트 (부르는 쪽이 팔레트를 넘기지 않을 때의 기본값) */
export const WIDGET_COLORS = WIDGET_PALETTES.dark;

/** 위젯 글자 크기 (sp). 2×2 칸에 맞춘 작은 단계 */
export const WIDGET_FONT = { xs: 9, sm: 10, md: 11, base: 12, title: 13, icon: 14, big: 18, bigger: 19 } as const;

/** 잔고 위젯 합계를 칸에 맞춰 줄이는 단계 (sp, 큰 것부터) */
export const WIDGET_TOTAL_FONTS = [WIDGET_FONT.big, 16, WIDGET_FONT.icon] as const;

/** 누르는 칸 최소 크기 (dp, 안드로이드 권장 48dp) — ↻·손익 전환 (3-23) */
export const WIDGET_TOUCH = 48;

/** 위젯 모서리 둥글기 (dp) */
export const WIDGET_RADIUS = 14;
/** 장 상태 칩 모서리 둥글기 (dp) */
export const CHIP_RADIUS = 6;

/**
 * 지수·환율 위젯 (APK 1.4.0). 값 글자는 칸에 맞춰 max 에서 줄이고(layout.ts planMarket),
 * comfort 보다 작아지면 한 칸에 덜 넣는 배치를 먼저 본다. min 아래로는 줄이지 않는다
 */
export const WIDGET_BOARD = {
  /** 카드 모서리 (다른 위젯보다 넉넉히) */
  radius: 20,
  /** 카드 테두리 두께 (라이트에서만 보인다 — 다크는 그라데이션이 테두리를 덮는다) */
  border: 1,
  /** 제목 앞 금색 막대 (폭·높이·모서리, dp) */
  mark: { width: 3, height: 14, radius: 2 },
  /** 장중 초록 점 지름 (dp) */
  dot: 5,
  /** 칸 사이 구분선 (dp) */
  hairline: 1,
  value: { max: WIDGET_FONT.bigger, comfort: WIDGET_FONT.base, min: WIDGET_FONT.xs },
} as const;
