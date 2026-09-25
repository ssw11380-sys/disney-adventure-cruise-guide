import { clampScale } from "@/lib/textScale";
import { fontCap, foldScreens, space } from "@/tokens";

/**
 * 설정·비중 화면의 넓은 창 배치 계산 (3-42 웨이브 E, 기능 플래그 foldLayout).
 * React Native 를 불러오지 않는 순수 모듈 (테스트용). 화면은 useFoldLayout 이 넓은 창(폭 600 이상 + 플래그 켜짐)이라고 할 때만 부른다.
 */

/** 두 칸 사이 간격 (설정 카드·비중 카드) */
export const FOLD_COL_GAP = space.sm;

/** 큰 글씨에서 칸 최소 폭을 넓히는 비율: 늘어난 배율(최대 140%)의 절반 (140% → 1.2) */
function colScale(fontScale: number): number {
  return 1 + (clampScale(fontScale, fontCap.row) - 1) / 2;
}

/**
 * 폭이 넓을수록 크거나 같은 배치 값(칸 수, 두 칸이면 1 등) f 에 켜기·끄기 여유를 준다 (히스테리시스).
 * prev 는 바로 전 값(처음이면 null). 바꾸려면 여유(margin)만큼 더 넘어야 한다:
 * 커질 때는 margin 만큼 좁은 폭에서도 커야, 작아질 때는 margin 만큼 넓은 폭에서도 작아야 바꾼다.
 * → 창을 끌어 기준선 근처를 오가도 값이 번갈아 바뀌지 않는다
 */
export function stickyStep(prev: number | null, width: number, f: (w: number) => number, margin: number = foldScreens.hysteresis): number {
  const now = f(width);
  if (prev === null || now === prev) return now;
  if (now > prev) {
    const up = f(width - margin);
    return up > prev ? up : prev;
  }
  const down = f(width + margin);
  return down < prev ? down : prev;
}

/**
 * 설정 카드를 두 칸(표시·알림·정보 | 토스·업데이트·서버·고급·화면 정보)으로 놓을지.
 * width 는 설정 화면이 받는 폭(왼쪽 세로 탭 막대가 있으면 뺀 값). 한 칸이 settingsColMin(큰 글씨는 넓힘)보다 좁아지면 한 칸 그대로.
 * 두 칸이면 한 칸 폭이 곧 버튼 최대 폭이다
 */
export function settingsTwoColumns(width: number, fontScale: number): boolean {
  if (!(Number.isFinite(width) && width > 0)) return false;
  return width >= 2 * foldScreens.settingsColMin * colScale(fontScale) + FOLD_COL_GAP;
}

/**
 * 설정 두 칸에서 한 칸의 최대 폭 (settingsColMax, 큰 글씨는 넓힘): 이름과 스위치 사이가 300dp 안팎으로 가깝게.
 * 이보다 넓게 남는 폭은 칸 사이와 양옆 여백에 고루 나눈다 (가운데 한 칸으로 모으지 않는다)
 */
export function settingsColumnMax(fontScale: number): number {
  return Math.round(foldScreens.settingsColMax * colScale(fontScale));
}

/** 비중 카드 범례 열 폭 (넓은 창). 큰 글씨는 종목 줄처럼 배율의 1/4 만큼 넓히고, 그래도 넘치는 숫자는 글자를 줄인다 */
export function legendCols(fontScale: number): { amount: number; pct: number } {
  const k = 1 + (clampScale(fontScale, fontCap.row) - 1) / 4;
  return { amount: Math.round(foldScreens.legendAmountW * k), pct: Math.round(foldScreens.legendPctW * k) };
}

/** 범례 한 줄에서 이름·숫자 말고 차지하는 폭: 색 네모 10 + 칸 사이 간격 3개 */
export const LEGEND_SWATCH = 10;
const LEGEND_FIXED = LEGEND_SWATCH + 3 * space.sm;

/**
 * 원 옆 범례 배치의 여백 (카드 그리기와 이 계산이 같은 값을 쓴다):
 * [카드 왼쪽 여백 lg | 원 | 간격 md | 범례 (줄 왼쪽 여백 sm · 내용 · 줄 오른쪽 여백 lg)]
 */
export const BESIDE = { padL: space.lg, gap: space.md, rowL: space.sm, rowR: space.lg } as const;

/** 넓은 창 카드의 위아래 여백과 원·범례 사이 간격 (카드 그리기와 높이 어림이 같은 값을 쓴다) */
export const WIDE_CARD = { padV: space.xs, gap: space.sm } as const;

export interface AllocationGrid {
  /** 카드 한 칸 폭 (두 칸 격자) */
  colW: number;
  /** 원 지름 */
  donut: number;
  /** 원 옆에 범례를 둔다 (아니면 원 아래) */
  beside: boolean;
}

/** 원 아래 범례 배치에서 남는 높이로 원을 키울 때 필요한 것 */
export interface AllocationRoom {
  /** 카드 격자가 쓸 수 있는 높이 (창 높이 − 시스템 막대 − 화면 머리·요약·고지 어림) */
  height: number;
  /** 격자 줄마다 범례 줄 수가 많은 카드의 줄 수 (윗줄: 국내/해외·통화, 아랫줄: 업종·종목별) */
  rows: readonly number[];
}

/**
 * 비중 화면 넓은 창: 카드 4장을 2×2 격자로. 이름 칸을 먼저 확보하고, 원은 남는 폭·높이로 키운다.
 *  - 원 옆 범례: 가장 작은 원(donutMin) 옆에도 범례 이름 칸이 바라는 폭(legendNameIdeal, 큰 글씨는 넓힘)이 남을 때만.
 *    이때 원은 그 이름 칸을 남기고 남은 폭으로 (donutMin~donutMax). 예: 폴드8 펼침 가로 933 → 칸 462, 원 122
 *  - 아니면 원 아래 범례 (울트라 펼침 세로 859·폴드8 펼침 세로 704): 이름 칸은 칸 폭 거의 전부.
 *    원은 room(격자가 쓸 높이·범례 줄 수)이 있으면 카드 4장이 한 화면에 들어가는 만큼 키운다 (donutMin~donutMax, 칸 폭 안)
 *  - besideOverride: 기준선 근처에서 바로 전 배치를 지킬 때 (히스테리시스, 화면이 stickyStep 으로 정한다)
 * width 는 화면 폭
 */
export function allocationGrid(width: number, fontScale: number, room?: AllocationRoom, besideOverride?: boolean): AllocationGrid {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const colW = Math.floor((w - FOLD_COL_GAP) / 2);
  const { amount, pct } = legendCols(fontScale);
  // 원 옆 범례 한 줄의 내용 폭 = 칸 − 왼쪽 여백 − 원 − 간격 − 줄 좌우 여백
  const rowContent = (donut: number) => colW - BESIDE.padL - donut - BESIDE.gap - BESIDE.rowL - BESIDE.rowR;
  // 이름 칸 폭은 글자 배율(최대 140%)만큼 넓혀서 본다 — 큰 글씨에서 이름이 몇 글자만 남으면 원 아래 범례가 낫다
  const k = clampScale(fontScale, fontCap.row);
  const need = LEGEND_FIXED + Math.round(foldScreens.legendNameIdeal * k) + amount + pct;
  const beside = besideOverride ?? rowContent(foldScreens.donutMin) >= need;
  if (beside) return { colW, donut: clampDonut(rowContent(0) - need, colW), beside: true };
  return { colW, donut: belowDonut(colW, k, room), beside: false };
}

function clampDonut(d: number, colW: number): number {
  // 원 아래 배치에서도 칸 좌우 여백 안에 들어가게
  const max = Math.min(foldScreens.donutMax, colW - 2 * space.lg);
  return Math.max(foldScreens.donutMin, Math.min(max, Math.floor(d)));
}

/** 원 아래 범례: 카드 = 위아래 여백 + 원 + 간격 + 범례. 격자 줄마다 원이 하나씩 쌓이므로 남는 높이를 줄 수로 나눈다 */
function belowDonut(colW: number, k: number, room?: AllocationRoom): number {
  if (!room || !(Number.isFinite(room.height) && room.height > 0) || !room.rows.length) return foldScreens.donutMin;
  const legendH = (n: number) => Math.ceil((foldScreens.legendHeadH + n * foldScreens.legendRowH) * k);
  const fixed = room.rows.reduce((s, n) => s + 2 * WIDE_CARD.padV + WIDE_CARD.gap + legendH(n), 0);
  return clampDonut((room.height - fixed) / room.rows.length, colW);
}
