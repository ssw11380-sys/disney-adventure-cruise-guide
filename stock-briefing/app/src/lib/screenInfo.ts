import { layout } from "@/tokens";

/**
 * 설정 > 화면 정보 (접는 폰 측정). 창·화면 크기, 밀도, 글자 배율을 읽기 쉬운 줄과 붙여 넣을 글로 바꾼다.
 * React Native 를 불러오지 않는 순수 모듈 (테스트용). 값을 읽는 쪽은 components/ScreenInfoCard.tsx
 *
 * 크기 단위는 모두 dp (안드로이드 화면 좌표). 픽셀 = dp × 화면 밀도.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ScreenInfoInput {
  /** 앱 창 (화면 분할·팝업 창이면 화면보다 작다) */
  window: Size;
  /** 화면 전체 (지금 켜진 화면: 접으면 바깥 화면, 펴면 안쪽 화면) */
  screen: Size;
  /** 화면 밀도 (1dp 가 몇 픽셀인지, PixelRatio.get()) */
  density: number;
  /** 시스템 글자 크기 배율 (1 = 100%) */
  fontScale: number;
  /** 상태 표시줄·내비게이션 바·화면 구멍이 차지하는 여백 */
  insets: Insets;
  manufacturer?: string | null;
  modelName?: string | null;
  osVersion?: string | null;
  apiLevel?: number | null;
  appVersion?: string | null;
  /** 지금 도는 업데이트 (내장 번들 또는 OTA 번호 앞 8자리) */
  build?: string | null;
}

/**
 * 폭 등급 기준 (dp). 안드로이드 창 크기 등급과 같다: 600 미만 좁음, 600~839 중간, 840 이상 넓음.
 * 값은 토큰(tokens.ts layout) 한 곳에 두어, 넓은 창 배치(lib/windowClass)와 이 카드가 늘 같은 등급을 보인다
 */
export const WIDTH_MEDIUM = layout.mediumMin;
export const WIDTH_EXPANDED = layout.expandedMin;
/** 화면 짧은 변이 이 이상이면 펼친 안쪽 화면으로 본다 (접었을 때 바깥 화면은 짧은 변 400dp 안팎) */
export const UNFOLDED_MIN_DP = 600;
/**
 * 긴 변 ÷ 짧은 변이 이보다 작으면(정사각형에 가까우면) 펼친 안쪽 화면으로 본다 — 화면 확대를 최대로 해 짧은 변이 600dp 아래로 내려가도
 * 펼침으로 읽게. 폴드8 안쪽 1.32·울트라 안쪽 1.11, 바깥 1.58·2.33 (삼성 사양 해상도)
 */
export const UNFOLDED_MAX_RATIO = 1.45;
/** 창이 화면보다 이만큼 넘게 작으면 화면 분할·팝업 창으로 본다 (상태 표시줄·내비게이션 바 몫은 봐준다) */
export const WINDOW_SLACK_DP = 100;

export type WidthClass = "compact" | "medium" | "expanded";

const WIDTH_CLASS_TEXT: Record<WidthClass, string> = {
  compact: `좁음 (${WIDTH_MEDIUM}dp 미만)`,
  medium: `중간 (${WIDTH_MEDIUM}~${WIDTH_EXPANDED - 1}dp)`,
  expanded: `넓음 (${WIDTH_EXPANDED}dp 이상)`,
};

const ok = (n: number) => Number.isFinite(n) && n > 0;
const dp = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : "?");

/** 창 폭으로 나눈 등급. 나중에 2단 화면을 쓸지 정할 때 이 기준을 쓴다 */
export function widthClass(width: number): WidthClass {
  if (width >= WIDTH_EXPANDED) return "expanded";
  if (width >= WIDTH_MEDIUM) return "medium";
  return "compact";
}

/** 폭이 높이보다 크면 가로 */
export function isLandscape(s: Size): boolean {
  return s.width > s.height;
}

/**
 * 접힘·펼침 짐작. 앱은 경첩 상태를 직접 알 수 없어서 지금 켜진 화면의 짧은 변으로 짐작한다.
 * 창이 아니라 화면을 보므로 화면 분할·팝업 창이어도 펼친 상태는 펼침이다
 */
export function foldGuess(screen: Size): "folded" | "unfolded" {
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  if (short >= UNFOLDED_MIN_DP) return "unfolded";
  return ok(short) && long / short < UNFOLDED_MAX_RATIO ? "unfolded" : "folded";
}

/** 창이 화면보다 눈에 띄게 작으면 화면 분할·팝업 창 */
export function isWindowed(window: Size, screen: Size): boolean {
  if (!ok(window.width) || !ok(window.height) || !ok(screen.width) || !ok(screen.height)) return false;
  return screen.width - window.width > WINDOW_SLACK_DP || screen.height - window.height > WINDOW_SLACK_DP;
}

/** "samsung SM-F966N". 모델명이 이미 제조사로 시작하면 한 번만 */
export function modelLabel(manufacturer?: string | null, modelName?: string | null): string {
  const maker = manufacturer?.trim() ?? "";
  const model = modelName?.trim() ?? "";
  if (!maker && !model) return "알 수 없음";
  if (!model) return maker;
  if (!maker || model.toLowerCase().startsWith(maker.toLowerCase())) return model;
  return `${maker} ${model}`;
}

/** 2.625 → "2.625 (약 420dpi)" */
function densityText(d: number): string {
  if (!ok(d)) return "알 수 없음";
  return `${Number(d.toFixed(4))} (약 ${Math.round(d * 160)}dpi)`;
}

function fontScaleText(s: number): string {
  return ok(s) ? `${Math.round(s * 100)}%` : "알 수 없음";
}

export interface InfoRow {
  label: string;
  value: string;
}

/** 화면에 보일 줄 (순서 = 붙여 넣는 글 순서) */
export function screenInfoRows(i: ScreenInfoInput): InfoRow[] {
  const shortSide = Math.min(i.screen.width, i.screen.height);
  const px = (n: number) => (ok(n) && ok(i.density) ? String(Math.round(n * i.density)) : "?");
  const os = i.osVersion?.trim() ? `${i.osVersion.trim()}${i.apiLevel ? ` (API ${i.apiLevel})` : ""}` : "알 수 없음";
  return [
    { label: "모델명", value: modelLabel(i.manufacturer, i.modelName) },
    { label: "안드로이드 버전", value: os },
    { label: "앱 창 크기", value: `${dp(i.window.width)}×${dp(i.window.height)} dp` },
    { label: "화면 전체 크기", value: `${dp(i.screen.width)}×${dp(i.screen.height)} dp · ${px(i.screen.width)}×${px(i.screen.height)} 픽셀` },
    { label: "화면 밀도", value: densityText(i.density) },
    { label: "글자 배율", value: fontScaleText(i.fontScale) },
    { label: "가로/세로", value: isLandscape(i.window) ? "가로" : "세로" },
    { label: "접힘/펼침", value: `${foldGuess(i.screen) === "unfolded" ? "펼침(안쪽 화면)" : "접힘(바깥 화면)"}으로 추정 · 짧은 변 ${dp(shortSide)}dp` },
    // 삼성·안드로이드 화면 비율 설정으로 가운데 모아 그린 창도 작게 나온다 (안쪽 화면이 가로로 도는지와 이어진 설정)
    { label: "창 상태", value: isWindowed(i.window, i.screen) ? "화면 분할·팝업 창 또는 화면 비율 제한으로 추정" : "전체 화면" },
    { label: "폭 등급", value: WIDTH_CLASS_TEXT[widthClass(i.window.width)] },
    { label: "화면 여백", value: `위 ${dp(i.insets.top)} · 아래 ${dp(i.insets.bottom)} · 왼쪽 ${dp(i.insets.left)} · 오른쪽 ${dp(i.insets.right)} dp` },
  ];
}

/** 한국 시각 "2026-09-25 14:03" (한국은 서머타임이 없어 +9 시간 고정) */
function kstStamp(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

/** 공유 버튼으로 보낼 글 (대화창에 그대로 붙여 넣는다) */
export function screenInfoText(i: ScreenInfoInput, now: Date = new Date()): string {
  const app = i.appVersion ? ` · 앱 ${i.appVersion}${i.build ? ` (${i.build})` : ""}` : "";
  return [
    `[화면 정보] ${kstStamp(now)} 한국 시각${app}`,
    ...screenInfoRows(i).map((r) => `${r.label}: ${r.value}`),
    "※ 접힘/펼침은 앱이 경첩 상태를 직접 알 수 없어 화면 폭으로 짐작한 값입니다.",
  ].join("\n");
}
