import { widthClass, type WidthClass } from "@/lib/screenInfo";
import { clampScale } from "@/lib/textScale";
import { fontCap, layout } from "@/tokens";

/**
 * 창 크기 등급 (3-42 접는 폰, 기능 플래그 foldLayout).
 * React Native 를 불러오지 않는 순수 모듈 (테스트용). 창 크기를 읽는 훅은 lib/useFoldLayout.ts.
 * 기준 숫자는 모두 tokens.ts 의 layout (폰 실측 전 추정값 — 실측을 받으면 토큰만 바꾼다).
 *
 * 추정 창 크기(dp)로 본 결과 (글자 100%):
 *  - 폴드8 접힘 475×751 · 울트라 접힘 411×960 → 좁음 (지금 휴대폰 화면)
 *  - 폴드8 펼침 세로 704×933 → 중간 (한 단, 가운데 읽기 폭)
 *  - 폴드8 펼침 가로 933×704 → 넓음 · 높이 짧음 · 2단 · 왼쪽 탭 막대
 *  - 울트라 펼침 세로 859×954 · 가로 954×859 → 넓음 · 2단 (높이는 넉넉해 탭은 아래)
 */

export type { WidthClass };

export interface WindowSize {
  width: number;
  height: number;
  /** 시스템 글자 크기 배율 (1 = 100%) */
  fontScale: number;
}

export interface WindowClass {
  /** 폭 등급: 좁음(600 미만)·중간(600~839)·넓음(840 이상) — 설정 '화면 정보'의 폭 등급과 같다 */
  width: WidthClass;
  /** 창 높이가 layout.shortHeight 보다 낮다 */
  short: boolean;
  /** 2단(왼쪽 목록 + 오른쪽 상세)을 쓸 만큼 넓다. 기준선 근처에서는 이전 값을 따른다 (히스테리시스) */
  twoPane: boolean;
  /** 넓고 높이가 짧은 창: 탭을 왼쪽 세로 막대로 옮긴다 (넓음은 2단과 같은 켜기·끄기 폭, 글자 100% 기준) */
  rail: boolean;
}

/** 휴대폰 화면 그대로 (좁은 창, 또는 foldLayout 이 꺼져 있을 때) */
export const COMPACT: WindowClass = Object.freeze({ width: "compact", short: false, twoPane: false, rail: false });

const ok = (n: number) => Number.isFinite(n) && n > 0;

/** 글자 배율(최대 140%)로 넓히는 비율: 늘어난 배율의 절반 (140% → 1.2) */
function paneScale(fontScale: number): number {
  return 1 + (clampScale(fontScale, fontCap.row) - 1) / 2;
}

/** 2단 왼쪽 목록 폭: 100% 는 layout.listPaneW(400), 큰 글씨는 배율의 절반만큼 넓힌다 (140% 이상 → 480) */
export function listPaneWidth(fontScale: number): number {
  return Math.round(layout.listPaneW * paneScale(fontScale));
}

/**
 * 2단을 켜는·끄는 창 폭. 큰 글씨로 목록이 넓어진 만큼 기준도 올려서, 오른쪽 상세 칸은 늘 같은 폭 이상 남는다
 * (100%: 840 에서 켜고 816 아래로 좁아지면 끔 / 140%: 920·896 — 울트라 펼침 세로 859 는 큰 글씨에서 한 단)
 */
export function twoPaneWidths(fontScale: number): { enter: number; exit: number } {
  const extra = listPaneWidth(fontScale) - layout.listPaneW;
  return { enter: layout.twoPaneMin + extra, exit: layout.twoPaneExit + extra };
}

/**
 * 창 크기 → 등급. prev 는 바로 전 등급 (처음이면 null).
 * 2단·탭 막대는 켤 때와 끌 때 기준 폭이 달라서, 창 크기를 끌어 바꾸는 중에 기준선 근처에서 번갈아 바뀌지 않는다.
 * 크기를 모르면(0·NaN) 휴대폰 화면 그대로 본다
 */
export function classifyWindow(size: WindowSize, prev: WindowClass | null = null): WindowClass {
  if (!ok(size.width) || !ok(size.height)) return COMPACT;
  const width = widthClass(size.width);
  const short = size.height < layout.shortHeight;
  const pane = twoPaneWidths(size.fontScale);
  const twoPane = size.width >= (prev?.twoPane ? pane.exit : pane.enter);
  const rail = short && size.width >= (prev?.rail ? layout.twoPaneExit : layout.twoPaneMin);
  return { width, short, twoPane, rail };
}

export function sameWindowClass(a: WindowClass | null, b: WindowClass | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.short === b.short && a.twoPane === b.twoPane && a.rail === b.rail;
}

/** 넓은 창 배치 (foldLayout 플래그를 거친 값). on 이 false 면 창 크기와 상관없이 휴대폰 화면 그대로 */
export interface FoldLayout extends WindowClass {
  on: boolean;
}

export const FOLD_OFF: FoldLayout = Object.freeze({ ...COMPACT, on: false });

/** 플래그가 꺼져 있으면 휴대폰 화면(COMPACT) 그대로, 켜져 있으면 창 등급 그대로 */
export function foldLayoutOf(on: boolean, cls: WindowClass): FoldLayout {
  return on ? { ...cls, on: true } : FOLD_OFF;
}

/** 폭 등급이 중간 이상인지 (가운데 읽기 폭을 쓰는 기준) */
export function isWide(l: WindowClass): boolean {
  return l.width !== "compact";
}

/**
 * 2단 화면의 왼쪽 목록 실제 폭. listPaneWidth 를 쓰되, 창이 좁아 오른쪽 칸이
 * (layout.twoPaneExit − layout.listPaneW = 416) 보다 좁아지면 그만큼 줄인다. 목록은 layout.listPaneW 아래로는 줄이지 않는다
 */
export function leftPaneWidth(windowWidth: number, fontScale: number): number {
  const want = listPaneWidth(fontScale);
  if (!ok(windowWidth)) return want;
  const detailMin = layout.twoPaneExit - layout.listPaneW;
  return Math.max(layout.listPaneW, Math.min(want, Math.floor(windowWidth - detailMin)));
}

/** 왼쪽 세로 탭 막대 폭: 탭 이름을 150% 까지 키우므로(fontCap.chrome) 늘어난 배율의 절반만큼 넓힌다 (150% → 100) */
export function railWidth(fontScale: number): number {
  return Math.round(layout.railW * (1 + (clampScale(fontScale, fontCap.chrome) - 1) / 2));
}
