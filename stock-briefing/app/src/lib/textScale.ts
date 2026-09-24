import { font, fontCap, space } from "@/tokens";

/**
 * 시스템 글자 크기(fontScale)에 따른 줄 높이·열 폭 (3-22).
 * React Native 를 불러오지 않는 순수 모듈 — 화면은 훅(useFontScale)으로 배율을 받아 여기 함수에 넣고, 테스트는 값을 그대로 확인한다.
 * 규칙: 배율 1(100%)에서는 3-21 까지의 값과 똑같다.
 */

/** 종목 한 줄의 열 폭 (100%): 순위 | 이름(나머지) | 현재가 | 오른쪽 열 */
export const LINE_COL = { rank: 30, price: 100, right: 108 } as const;
/** 종목 한 줄 높이 (100%) */
export const LINE_H = 58;
/** 테마·업종 한 줄 높이 (100%) */
export const THEME_ROW_H = 72;
/** 탭 바·화면 머리 높이 (100%, 안전 영역 제외) */
export const TAB_H = 58;
export const HEADER_H = 52;
/** 글자 크기 → 한 줄 높이 비율 (안드로이드 기본 줄 간격 약 1.35) */
export const LINE = 1.35;
/** 탭 아이콘 크기 */
export const TAB_ICON = 21;

/** 배율 정리: 1 미만(작은 글씨)은 1 로, cap 이 있으면 그 상한까지 */
export function clampScale(s: number, cap = Infinity): number {
  return Math.min(Math.max(Number.isFinite(s) && s > 0 ? s : 1, 1), cap);
}

/** 큰 글씨 모드: 이름·보조 줄을 두 줄까지 쓴다 (100% 는 한 줄 말줄임 그대로) */
export function isBigText(s: number): boolean {
  return clampScale(s) > 1;
}

/** 숫자 열 폭: 확대 배율(최대 140%)의 1/4 만큼 넓힌다 (140% → 110%). 그래도 넘치는 숫자는 글자를 줄여 한 줄에 */
export function lineCols(s: number): { rank: number; price: number; right: number } {
  const k = 1 + (clampScale(s, fontCap.row) - 1) / 4;
  return { rank: LINE_COL.rank, price: Math.round(LINE_COL.price * k), right: Math.round(LINE_COL.right * k) };
}

/** 보조 줄 한 줄 높이 (100%: 글자 12 × 줄 간격 + 줄 사이) */
const SUB_LINE = Math.round(font.small * LINE) + space.xxs;

/**
 * 고정 높이 종목 줄(발견 목록)의 높이. 큰 글씨에서는 이름 두 줄 + 보조 줄 두 줄(코드 다음 줄에 보유·관심 표시)에 여유를 더해 배율을 곱한다.
 * 목록의 getItemLayout 도 이 값을 써야 스크롤 위치가 맞는다.
 */
export function lineH(s: number): number {
  const c = clampScale(s, fontCap.row);
  return c > 1 ? Math.round((LINE_H + SUB_LINE + space.s) * c) : LINE_H;
}

/** 테마 한 줄 높이: 배율(최대 140%)의 절반만큼 높인다 (이름·대표 종목·막대 세 줄은 한 줄씩 그대로) */
export function themeRowH(s: number): number {
  return Math.round(THEME_ROW_H * (1 + (clampScale(s, fontCap.row) - 1) / 2));
}

/** 탭 바 높이: 탭 이름은 150% 까지 커지고, 커진 만큼 높인다 */
export function tabBarH(s: number): number {
  return TAB_H + Math.ceil(font.tiny * LINE * (clampScale(s, fontCap.chrome) - 1));
}

/** 화면 머리 높이: 제목은 상한 없이 커지고, 커진 만큼 높인다 */
export function headerH(s: number): number {
  return HEADER_H + Math.ceil(font.h2 * LINE * (clampScale(s) - 1));
}
