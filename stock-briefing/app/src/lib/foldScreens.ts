import { clampScale } from "@/lib/textScale";
import { fontCap, foldScreens, space } from "@/tokens";

/**
 * 설정·비중 화면의 넓은 창 배치 계산 (3-42 웨이브 E, 기능 플래그 foldLayout).
 * React Native 를 불러오지 않는 순수 모듈 (테스트용). 화면은 useFoldLayout 이 넓은 창(폭 600 이상 + 플래그 켜짐)이라고 할 때만 부른다.
 */

/** 두 칸 사이 간격 (설정 카드·비중 카드) */
export const FOLD_COL_GAP = space.sm;

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
 * 설정 카드를 두 칸(표시·알림·정보 | 토스·업데이트·서버·서버 연결·화면 정보)으로 놓을지.
 * width 는 설정 화면이 실제로 받은 폭(잰 값, 재기 전에는 창 폭 − 왼쪽 세로 탭 막대).
 * 한 칸 최소 폭(settingsColMin)은 글자 크기와 상관없다: 큰 글씨에서 한 칸으로 돌아가면 이름과 스위치가 600dp 넘게 벌어지므로(진단 32),
 * 두 칸을 지키고 좁은 칸에서는 이름·값 줄(토스 '자동 동기화' 등)의 값이 이름 아래 줄로 내려간다 (ui RowWrapContext)
 */
export function settingsTwoColumns(width: number): boolean {
  if (!(Number.isFinite(width) && width > 0)) return false;
  return width >= 2 * foldScreens.settingsColMin + FOLD_COL_GAP;
}

/**
 * 설정 두 칸에서 한 칸의 최대 폭 (글자 크기와 상관없음): 이름과 스위치 사이가 300dp 이하로 가깝게.
 * 이보다 넓게 남는 폭은 두 칸 사이 간격으로만 간다 (칸은 화면 양 끝에 붙는다 — 가운데로 모으지 않는다)
 */
export function settingsColumnMax(): number {
  return foldScreens.settingsColMax;
}

/** 비중 카드 범례 열 폭 (넓은 창). 큰 글씨는 종목 줄처럼 배율의 1/4 만큼 넓히고, 그래도 넘치는 숫자는 글자를 줄인다 */
export function legendCols(fontScale: number): { amount: number; pct: number } {
  const k = 1 + (clampScale(fontScale, fontCap.row) - 1) / 4;
  return { amount: Math.round(foldScreens.legendAmountW * k), pct: Math.round(foldScreens.legendPctW * k) };
}

/** 범례 한 줄에서 이름·숫자 말고 차지하는 폭: 색 네모 10 + 칸 사이 간격 (한 줄 범례 3개 · 두 줄 범례 2개) */
export const LEGEND_SWATCH = 10;
const ROW_FIXED = LEGEND_SWATCH + 3 * space.sm;
const STACK_FIXED = LEGEND_SWATCH + 2 * space.sm;
/** 촘촘한 범례에서 줄마다 줄어드는 높이: 위아래 여백 xs → xxs */
export const DENSE_CUT = 2 * (space.xs - space.xxs);

/**
 * 원 옆 범례 배치의 여백 (카드 그리기와 이 계산이 같은 값을 쓴다):
 * [카드 왼쪽 여백 lg | 원 | 간격 md | 범례 (줄 왼쪽 여백 sm · 내용 · 줄 오른쪽 여백 lg)]
 */
export const BESIDE = { padL: space.lg, gap: space.md, rowL: space.sm, rowR: space.lg } as const;

/** 넓은 창 카드의 위아래 여백과 원·범례 사이 간격 (카드 그리기와 높이 어림이 같은 값을 쓴다) */
export const WIDE_CARD = { padV: space.xs, gap: space.sm } as const;

/**
 * 원 옆 범례 한 줄의 모양:
 *  - row: 한 줄 [색 · 이름 · 종목 수 | 평가금액 | 비중] (칸이 넉넉할 때 — 폴드8·울트라 펼침 가로)
 *  - stack: 두 줄 [색 · 이름 / 평가금액 · 종목 수 | 비중] (칸이 좁을 때 — 울트라 펼침 세로·폴드8 펼침 세로).
 *    평가금액 열 폭만큼 이름 칸이 넓어지고, 금액은 줄여 쓰지 않고 그대로(원 단위) 이름 아래에 보인다
 */
export type LegendMode = "row" | "stack";

export interface AllocationGrid {
  /** 카드 한 칸 폭 (두 칸 격자) */
  colW: number;
  /** 원 지름 */
  donut: number;
  /** 원 옆에 범례를 둔다 (아니면 원 아래) */
  beside: boolean;
  /** 범례 줄 모양 (원 아래 범례는 늘 row) */
  legend: LegendMode;
  /** 범례 줄 위아래 여백을 줄인다 — 보통 여백으로는 카드 4장이 한 화면에 안 들어갈 때만 */
  dense: boolean;
}

/** 격자 높이 어림에 필요한 것 */
export interface AllocationRoom {
  /** 카드 격자가 쓸 수 있는 높이 (창 높이 − 시스템 막대 − 화면 머리·요약·고지 어림) */
  height: number;
  /** 격자 줄마다 범례 줄 수가 많은 카드의 줄 수 (윗줄: 국내/해외·통화, 아랫줄: 업종·종목별) */
  rows: readonly number[];
}

/** 배치 단계 — 폭이 넓을수록 크다 (히스테리시스는 이 값에 건다): 0 원 아래 범례 · 1 원 옆 두 줄 범례 · 2 원 옆 한 줄 범례 */
export type AllocationStep = 0 | 1 | 2;

function roomOk(room?: AllocationRoom): room is AllocationRoom {
  return !!room && Number.isFinite(room.height) && room.height > 0 && room.rows.length > 0;
}

/** 범례 높이 어림 (머리 + 줄 수 × 줄 높이, 글자 배율만큼). 촘촘하면 줄마다 DENSE_CUT 만큼 낮다 */
function legendH(n: number, k: number, mode: LegendMode, dense: boolean): number {
  const rowH = foldScreens.legendRowH + (mode === "stack" ? foldScreens.legendSubH : 0);
  return Math.ceil((foldScreens.legendHeadH + n * rowH) * k) - (dense ? n * DENSE_CUT : 0);
}

/** 원 옆 배치의 격자 높이 어림: 격자 줄마다 (위아래 여백 + 원과 범례 중 높은 쪽) */
function besideH(room: AllocationRoom, donut: number, k: number, mode: LegendMode, dense: boolean): number {
  return room.rows.reduce((s, n) => s + 2 * WIDE_CARD.padV + Math.max(donut, legendH(n, k, mode, dense)), 0);
}

/** 원 아래 배치의 격자 높이 어림: 격자 줄마다 (위아래 여백 + 원 + 간격 + 범례) */
function belowH(room: AllocationRoom, donut: number, k: number): number {
  return room.rows.reduce((s, n) => s + 2 * WIDE_CARD.padV + donut + WIDE_CARD.gap + legendH(n, k, "row", false), 0);
}

/** 원 옆 범례의 이름 칸 폭 (원 지름 donut 일 때) */
export function besideNameW(colW: number, donut: number, fontScale: number, mode: LegendMode): number {
  const { amount, pct } = legendCols(fontScale);
  const content = colW - BESIDE.padL - donut - BESIDE.gap - BESIDE.rowL - BESIDE.rowR;
  return mode === "row" ? content - ROW_FIXED - amount - pct : content - STACK_FIXED - pct;
}

function gridColW(width: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  return Math.floor((w - FOLD_COL_GAP) / 2);
}

/**
 * 비중 화면 넓은 창의 배치 단계 (폭·글자 배율·높이로). 설계대로 원 옆 범례가 먼저이고, 범례 이름 칸을 먼저 확보한다:
 *  1) 한 줄 범례로도 이름 칸이 바라는 폭(legendNameIdeal × 글자 배율)이 남으면 한 줄 (폴드8·울트라 펼침 가로)
 *  2) 아니면 두 줄 범례(평가금액을 이름 아래로) — 이름 칸이 최소 폭(legendNameMin × 글자 배율) 이상이고 카드 4장이 한 화면에 들어가면
 *     (울트라 펼침 세로 859 · 폴드8 펼침 세로 704)
 *  3) 두 줄 범례로는 한 화면에 안 들어가면(큰 글씨) 줄이 낮은 한 줄 범례 — 이름 칸이 최소 폭 이상이면 (이름만 말줄임)
 *  4) 그래도 안 되면 두 줄 범례, 이름 칸 최소 폭도 안 남으면(아주 큰 글씨 · 좁은 칸) 원 아래 범례
 * 한 화면에 들어가는지는 촘촘한 범례(줄 여백을 줄인 것)까지 쳐서 본다. room 이 없으면 들어간다고 본다.
 * 폭이 넓어질수록 단계는 줄지 않는다 (0 → 1 → 2) — 히스테리시스(stickyStep)의 조건
 */
export function allocationStep(width: number, fontScale: number, room?: AllocationRoom): AllocationStep {
  const colW = gridColW(width);
  const k = clampScale(fontScale, fontCap.row);
  const ideal = Math.round(foldScreens.legendNameIdeal * k);
  const min = Math.round(foldScreens.legendNameMin * k);
  const rowName = besideNameW(colW, foldScreens.donutMin, fontScale, "row");
  const stackName = besideNameW(colW, foldScreens.donutMin, fontScale, "stack");
  const stackFits = !roomOk(room) || besideH(room, foldScreens.donutMin, k, "stack", true) <= room.height;
  if (rowName >= ideal) return 2;
  if (stackName >= min && stackFits) return 1;
  if (rowName >= min) return 2;
  if (stackName >= min) return 1;
  return 0;
}

/**
 * 비중 화면 넓은 창: 카드 4장을 2×2 격자로 (단계는 allocationStep, 화면이 히스테리시스로 지킨 값을 stepOverride 로 준다).
 *  - 원 옆 범례: 원은 이름 칸이 바라는 폭을 먼저 남기고 남은 폭으로 (donutMin~donutMax).
 *    room 이 있으면 카드 4장이 한 화면에 들어가는 만큼까지만 키우고, 보통 줄 여백으로는 가장 작은 원도 안 들어가면 촘촘한 범례
 *    예 (글자 100%): 폴드8 펼침 가로 933 → 칸 462, 한 줄 범례, 원 126 · 울트라 펼침 세로 859 → 두 줄 범례, 원 180 · 폴드8 펼침 세로 704 → 두 줄 범례, 원 120
 *  - 원 아래 범례: 이름 칸은 칸 폭 거의 전부. 원은 room 이 있으면 카드 4장이 한 화면에 들어가는 만큼 키운다 (donutMin~donutMax, 칸 폭 안)
 * width 는 화면 폭
 */
export function allocationGrid(width: number, fontScale: number, room?: AllocationRoom, stepOverride?: AllocationStep): AllocationGrid {
  const colW = gridColW(width);
  const k = clampScale(fontScale, fontCap.row);
  const step = stepOverride ?? allocationStep(width, fontScale, room);
  if (step === 0) return { colW, donut: belowDonut(colW, k, room), beside: false, legend: "row", dense: false };
  const mode: LegendMode = step === 2 ? "row" : "stack";
  // 이름 칸이 바라는 폭을 남기고 남는 폭으로 원 (칸 폭 안, donutMin~donutMax)
  const ideal = Math.round(foldScreens.legendNameIdeal * k);
  const byWidth = clampDonut(besideNameW(colW, 0, fontScale, mode) - ideal, colW);
  if (!roomOk(room)) return { colW, donut: byWidth, beside: true, legend: mode, dense: false };
  // 보통 줄 여백으로는 가장 작은 원도 한 화면에 안 들어가면 촘촘한 범례
  const dense = besideH(room, foldScreens.donutMin, k, mode, false) > room.height;
  // 한 화면에 들어가는 가장 큰 원 (원 옆 배치는 원이 범례보다 높은 격자 줄에서 원만큼 높아진다)
  let donut = byWidth;
  while (donut > foldScreens.donutMin && besideH(room, donut, k, mode, dense) > room.height) donut--;
  return { colW, donut, beside: true, legend: mode, dense };
}

function clampDonut(d: number, colW: number): number {
  // 원 아래 배치에서도 칸 좌우 여백 안에 들어가게
  const max = Math.min(foldScreens.donutMax, colW - 2 * space.lg);
  return Math.max(foldScreens.donutMin, Math.min(max, Math.floor(d)));
}

/** 원 아래 범례: 카드 = 위아래 여백 + 원 + 간격 + 범례. 격자 줄마다 원이 하나씩 쌓이므로 남는 높이를 줄 수로 나눈다 */
function belowDonut(colW: number, k: number, room?: AllocationRoom): number {
  if (!roomOk(room)) return foldScreens.donutMin;
  const fixed = belowH(room, 0, k);
  return clampDonut((room.height - fixed) / room.rows.length, colW);
}
