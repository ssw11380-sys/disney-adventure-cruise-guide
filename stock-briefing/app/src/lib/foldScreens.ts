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
 * 설정 카드를 두 칸(표시·알림·정보 | 토스·업데이트·서버·고급·화면 정보)으로 놓을지.
 * width 는 설정 화면이 받는 폭(왼쪽 세로 탭 막대가 있으면 뺀 값). 한 칸이 settingsColMin(큰 글씨는 넓힘)보다 좁아지면 한 칸 그대로.
 * 두 칸이면 한 칸 폭이 곧 버튼 최대 폭이고, 이름과 스위치 사이가 300dp 안쪽으로 가깝다
 */
export function settingsTwoColumns(width: number, fontScale: number): boolean {
  if (!(Number.isFinite(width) && width > 0)) return false;
  return width >= 2 * foldScreens.settingsColMin * colScale(fontScale) + FOLD_COL_GAP;
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

export interface AllocationGrid {
  /** 카드 한 칸 폭 (두 칸 격자) */
  colW: number;
  /** 원 지름 */
  donut: number;
  /** 원 옆에 범례를 둔다 (아니면 원 아래) */
  beside: boolean;
}

/**
 * 비중 화면 넓은 창: 카드 4장을 2×2 격자로. 카드 안에서 원(지름 donutMin~donutMax)과 범례 표를 나란히 둔다.
 *  - 원은 범례 이름 칸이 바라는 폭(legendNameIdeal)을 남기고 남은 폭으로 정한다 (최소 donutMin)
 *  - 원 옆에 범례 이름 칸 최소 폭(legendNameMin)조차 남지 않으면(폴드8 펼침 세로 704 등) 원 아래에 범례를 둔다 (원은 가장 작게)
 * width 는 화면 폭
 */
export function allocationGrid(width: number, fontScale: number): AllocationGrid {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const colW = Math.floor((w - FOLD_COL_GAP) / 2);
  const { amount, pct } = legendCols(fontScale);
  // 원 옆 범례 한 줄의 내용 폭 = 칸 − 왼쪽 여백 − 원 − 간격 − 줄 좌우 여백
  const rowContent = (donut: number) => colW - BESIDE.padL - donut - BESIDE.gap - BESIDE.rowL - BESIDE.rowR;
  const legendNeed = (name: number) => LEGEND_FIXED + name + amount + pct;
  const donut = Math.max(foldScreens.donutMin, Math.min(foldScreens.donutMax, rowContent(0) - legendNeed(foldScreens.legendNameIdeal)));
  const beside = rowContent(donut) >= legendNeed(foldScreens.legendNameMin);
  return { colW, donut: beside ? donut : foldScreens.donutMin, beside };
}
