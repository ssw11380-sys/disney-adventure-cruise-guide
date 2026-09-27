import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 첫 실행 안내 (3-24, 기능 플래그 firstRun). 한 화면(app/welcome)을 새 사용자에게 한 번만 보인다.
 *  - 이미 종목이 있는 사용자(기존 사용자 — OTA 로 이 기능을 처음 받은 사람)는 보이지 않고 '본 것'으로 적어 둔다 (억지로 거치게 하지 않음)
 *  - 등록 종목이 0개로 확인되면 보인다. 목록을 아직 못 받았으면(받는 중·서버 연결 실패) 기다린다
 *  - 안내 화면이 열리면 '본 것'으로 적는다 → 한 번 닫으면 다시 저절로 뜨지 않는다. 설정 > 정보에서 언제든 다시 연다
 */
export const FIRST_RUN_KEY = "guide.firstRun";
/** seen: 안내를 봄 · existing: 기존 사용자라 건너뜀 */
export type FirstRunMark = "seen" | "existing";

export async function readFirstRun(): Promise<FirstRunMark | null> {
  try {
    const v = await AsyncStorage.getItem(FIRST_RUN_KEY);
    return v === "seen" || v === "existing" ? v : null;
  } catch {
    // 저장소를 못 읽으면 본 것으로 친다 (확실하지 않을 때 억지로 띄우지 않는다)
    return "seen";
  }
}

export async function markFirstRun(v: FirstRunMark): Promise<void> {
  try {
    await AsyncStorage.setItem(FIRST_RUN_KEY, v);
  } catch {
    /* 못 적어도 이번 실행에서는 다시 띄우지 않는다 (claimFirstRun) */
  }
}

export type FirstRunDecision = "wait" | "show" | "existing";

/** 등록 종목 수(모르면 undefined)로 정한다 (순수 함수) */
export function firstRunDecision(count: number | undefined): FirstRunDecision {
  if (count === undefined) return "wait";
  return count > 0 ? "existing" : "show";
}

let claimed = false;
/** 이번 실행에서 저절로 띄우는 것은 한 번만 (true 를 받은 쪽이 띄운다) */
export function claimFirstRun(): boolean {
  if (claimed) return false;
  claimed = true;
  return true;
}
/** 테스트용: 이번 실행 기록을 지운다 */
export function forgetFirstRunClaim(): void {
  claimed = false;
}
