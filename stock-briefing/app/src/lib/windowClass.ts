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

/**
 * width·short 는 지금 창 그대로의 값이고(기준선 여유 없음), twoPane·rail 은 켜기·끄기 기준이 다른 결정 값이다 (히스테리시스).
 * 그래서 기준선 근처 띠에서는 width 가 '중간'이거나 short 가 false 인데도 rail 이 켜져 있을 수 있다 (켜진 상태를 지키는 중)
 */
export interface WindowClass {
  /** 폭 등급: 좁음(600 미만)·중간(600~839)·넓음(840 이상) — 설정 '화면 정보'의 폭 등급과 같다 */
  width: WidthClass;
  /** 창 높이가 layout.shortHeight 보다 낮다 */
  short: boolean;
  /** 2단(왼쪽 목록 + 오른쪽 상세)을 쓸 만큼 넓다. 기준선 근처에서는 이전 값을 따른다 (히스테리시스) */
  twoPane: boolean;
  /**
   * 탭을 왼쪽 세로 막대로 옮긴다: 폭 등급 '넓음' + 높이 짧음일 때 켠다.
   * 켜진 뒤에는 폭이 expandedMin − railHysteresis 아래로 좁아지거나 높이가 shortHeight + railHysteresis 이상이 되어야 끈다
   */
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
 * 2단을 켜는·끄는 창 폭. 큰 글씨로 목록이 넓어진 만큼 기준도 올려서, 오른쪽 상세 칸이 넉넉히 남게 한다
 * (100%: 840 에서 켜고 816 아래로 좁아지면 끔 / 140%: 920·896 — 울트라 펼침 세로 859 는 큰 글씨에서 한 단).
 * 창 폭 기준이다: 탭 막대가 차지한 폭은 2단 틀이 제 폭을 재어 목록을 줄여 맞춘다 (leftPaneWidth)
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
export function classifyWindow(size: WindowSize, prev: WindowClass | null = null, opts: { rail?: boolean } = {}): WindowClass {
  if (!ok(size.width) || !ok(size.height)) return COMPACT;
  const width = widthClass(size.width);
  const short = size.height < layout.shortHeight;
  const pane = twoPaneWidths(size.fontScale);
  const twoPane = size.width >= (prev?.twoPane ? pane.exit : pane.enter);
  // 탭 막대: 켤 때는 폭 등급 '넓음'(expandedMin — 실측 뒤 바뀌어도 폭 등급을 그대로 따른다) + 높이 짧음.
  // 켜진 뒤에는 폭·높이 모두 railHysteresis 만큼 여유를 두고 끈다 (창을 끌며 기준선을 오갈 때 깜빡임 방지)
  // 막대를 쓰지 않으면(layout.railOn 꺼짐 — 사용자 선택) 늘 아래 탭 바
  const railOn = opts.rail ?? layout.railOn;
  const rail = !railOn
    ? false
    : prev?.rail
      ? size.width >= layout.expandedMin - layout.railHysteresis && size.height < layout.shortHeight + layout.railHysteresis
      : width === "expanded" && short;
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
 * 2단 오른쪽 상세 칸이 지키는 최소 폭: 2단을 끄기 직전 폭(twoPaneExit 816)에서 목록(listPaneW 400)과 구분선(divider 1)을 뺀 415.
 * 가장 좁은 바깥 화면(울트라 접힘 411)보다 넓어, 2단의 상세는 접었을 때 화면보다 좁아지지 않는다
 */
export const DETAIL_MIN = layout.twoPaneExit - layout.listPaneW - layout.divider;

/**
 * 2단 화면의 왼쪽 목록 실제 폭. boxWidth 는 창 폭이 아니라 2단 틀이 실제로 받은 폭(좌우 화면 여백 제외)이다 —
 * 탭 화면에서 왼쪽 세로 탭 막대가 켜져 있으면 창 폭보다 막대 폭(railWidth)만큼 좁다 (components/TwoPane 이 onLayout 으로 잰다).
 * listPaneWidth 를 쓰되 오른쪽 칸이 DETAIL_MIN(415)보다 좁아지면 그만큼 목록을 줄이고, 목록은 layout.listPaneW(400) 아래로는 줄이지 않는다.
 *  → 틀 폭이 twoPaneExit(816) 이상이면 오른쪽 칸은 늘 415 이상. 펼친 폴드8 가로(933)는 막대를 빼도 틀이 833~853 이라 모든 글자 크기에서 지켜진다.
 *  → 틀이 816 보다 좁으면(막대가 켜진 폭 약 840~915 의 낮은 팝업·분할 창) 목록 400 을 지키고 오른쪽이 그만큼 좁아진다 (100% · 840×600 → 359)
 */
export function leftPaneWidth(boxWidth: number, fontScale: number): number {
  const want = listPaneWidth(fontScale);
  if (!ok(boxWidth)) return want;
  return Math.max(layout.listPaneW, Math.min(want, Math.floor(boxWidth - layout.divider - DETAIL_MIN)));
}

/** 왼쪽 세로 탭 막대 폭: 탭 이름을 150% 까지 키우므로(fontCap.chrome) 늘어난 배율의 절반만큼 넓힌다 (150% → 100) */
export function railWidth(fontScale: number): number {
  return Math.round(layout.railW * (1 + (clampScale(fontScale, fontCap.chrome) - 1) / 2));
}
