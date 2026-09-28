/**
 * 햅틱(짧은 진동) 한 곳 (3-24, 기능 플래그 oneHand + 설정 > 표시 '누를 때 진동').
 * expo-haptics 는 이미 APK 에 들어 있다(1단계부터 package.json, 차트 십자선이 써 왔음 — 새 네이티브 모듈 없음, VIBRATE 권한은 라이브러리 매니페스트).
 * 이 파일은 expo-haptics 를 직접 불러오지 않는다: 루트 레이아웃(app/_layout)이 installHaptics 로 넣어 준다 →
 * 화면 테스트(노드)에서는 엔진이 없어 아무 일도 하지 않는다.
 *
 * 어디서 울리나 (새 곳은 oneHand 가 켜지고 설정이 켜졌을 때만):
 *  - select: 잔고 줄 스와이프로 버튼이 열릴 때 · 정렬을 바꿀 때 · 당겨서 새로고침을 시작할 때
 *  - press: 잔고 줄을 길게 눌러 메뉴가 열릴 때
 *  - success: 관심 추가·관심 해제·삭제·동기화 제외가 끝났을 때
 *  - error: 그 일이 실패했을 때
 *  - chart: 차트 십자선 (예전부터 있던 곳) — 플래그가 꺼져 있으면 지금처럼 늘 울리고, 켜져 있으면 설정을 따른다
 *  - alert: 가격 알림이 울릴 때 (3-29, 플래그 priceAlerts) — 설정 '누를 때 진동'만 따른다(oneHand 가 꺼져 있어도). 진동기라 휴대폰 '터치 진동'과 상관없이 울린다
 */
export type HapticKind = "select" | "press" | "success" | "error" | "chart" | "alert";

export interface HapticPolicy {
  /** 기능 플래그 oneHand (서버, 앱 fallback 꺼짐) */
  oneHand: boolean;
  /** 설정 > 표시 '누를 때 진동' (기본 켬, 기기에 저장) */
  user: boolean;
}

/** 이 종류를 지금 울려도 되는지 (순수 함수) */
export function hapticAllowed(kind: HapticKind, p: HapticPolicy): boolean {
  // 차트 십자선: 플래그가 꺼져 있으면 예전 그대로(늘), 켜져 있으면 사용자가 끈 경우 울리지 않는다
  if (kind === "chart") return !p.oneHand || p.user;
  // 가격 알림: 설정 '누를 때 진동'만 따른다 (이 설정은 HapticsBridge 가 늘 넘긴다)
  if (kind === "alert") return p.user;
  return p.oneHand && p.user;
}

/** expo-haptics 에서 쓰는 부분 (문자열 값은 expo-haptics 의 enum 값과 같다) */
export interface HapticEngine {
  selectionAsync(): Promise<void>;
  impactAsync(style: never): Promise<void>;
  notificationAsync(type: never): Promise<void>;
  performAndroidHapticsAsync?(type: never): Promise<void>;
}

export type HapticCall =
  | { fn: "selectionAsync" }
  | { fn: "impactAsync"; arg: "light" | "medium" }
  | { fn: "notificationAsync"; arg: "success" | "error" | "warning" }
  | { fn: "performAndroidHapticsAsync"; arg: "segment-tick" | "long-press" | "confirm" | "reject" };

/**
 * 종류마다 부를 함수 (순수 함수). 안드로이드는 시스템 햅틱(performHapticFeedback — 휴대폰의 '터치 진동' 설정을 따르고 권한이 필요 없다)을 먼저 쓴다.
 * fallback(진동기)은 expo-haptics 가 그 효과 상수를 모를 때(예전 안드로이드 — 예: segment-tick 은 안드로이드 14 부터)만 불린다:
 * 네이티브는 performHapticFeedback 의 결과(false)를 버리므로, 휴대폰 '터치 진동'이 꺼져 있거나 기종이 그 효과를 무시해도
 * 실패로 오지 않아 진동기로 넘어가지 않는다 → 그때는 울리지 않는다(시스템 설정을 따름). 차트 십자선은 예전과 같은 selectionAsync(진동기)라
 * '터치 진동'을 꺼 둔 휴대폰에서는 십자선만 울릴 수 있다 (설정 > 표시 '누를 때 진동'을 끄면 십자선도 멈춤)
 */
export function hapticCall(kind: HapticKind, os: string): { first: HapticCall; fallback: HapticCall | null } {
  if (kind === "chart") return { first: { fn: "selectionAsync" }, fallback: null };
  // 가격 알림: 터치 피드백이 아니라 진동기 (알림이므로 휴대폰 '터치 진동' 설정과 상관없이)
  if (kind === "alert") return { first: { fn: "notificationAsync", arg: "warning" }, fallback: null };
  const plain: Record<Exclude<HapticKind, "chart" | "alert">, HapticCall> = {
    select: { fn: "selectionAsync" },
    press: { fn: "impactAsync", arg: "medium" },
    success: { fn: "notificationAsync", arg: "success" },
    error: { fn: "notificationAsync", arg: "error" },
  };
  if (os !== "android") return { first: plain[kind], fallback: null };
  const android: Record<Exclude<HapticKind, "chart" | "alert">, "segment-tick" | "long-press" | "confirm" | "reject"> = {
    select: "segment-tick",
    press: "long-press",
    success: "confirm",
    error: "reject",
  };
  return { first: { fn: "performAndroidHapticsAsync", arg: android[kind] }, fallback: plain[kind] };
}

let engine: HapticEngine | null = null;
let platform = "android";
let policy: HapticPolicy = { oneHand: false, user: true };

/** 앱 시작 때 한 번 (app/_layout): expo-haptics 와 플랫폼 */
export function installHaptics(e: HapticEngine | null, os: string): void {
  engine = e;
  platform = os;
}

/** 플래그·설정이 바뀔 때마다 (components/UxBridge) */
export function setHapticPolicy(p: HapticPolicy): void {
  policy = p;
}

export function hapticPolicy(): HapticPolicy {
  return policy;
}

function run(e: HapticEngine, c: HapticCall): Promise<void> {
  const call = e[c.fn] as ((arg?: never) => Promise<void>) | undefined;
  if (!call) return Promise.reject(new Error("없음"));
  return "arg" in c ? call(c.arg as never) : call();
}

/** 울린다 (허용되지 않았거나 엔진이 없으면 아무 일도 하지 않는다). 첫 호출이 실패(상수 없음)하면 fallback, 그것도 실패하면 조용히 넘긴다 */
export function haptic(kind: HapticKind): void {
  const e = engine;
  if (!e || !hapticAllowed(kind, policy)) return;
  const { first, fallback } = hapticCall(kind, platform);
  try {
    void run(e, first).catch(() => (fallback ? run(e, fallback).catch(() => undefined) : undefined));
  } catch {
    /* 햅틱은 없어도 되는 것 */
  }
}
