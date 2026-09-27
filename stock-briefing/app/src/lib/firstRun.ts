import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Health } from "@/api/types";

/**
 * 첫 실행 안내 (3-24, 기능 플래그 firstRun). 한 화면(app/welcome)을 새 사용자에게 한 번만 저절로 보인다.
 *  - 새 사용자인지는 **서버 자료**로 정한다: 등록 종목(보유·관심)이 하나도 없고, 토스 연동 기록도 없으면(서버에 토스 키 없음·동기화한 적 없음) 새 사용자.
 *    종목이 있거나 토스가 연결되어 있으면 기존 사용자 → 저절로 띄우지 않고 '건너뜀'으로 적는다 (설정 > 정보 '다시 보기'로는 언제든 연다)
 *  - 판단은 이번 실행에서 서버에서 **새로 받은** 자료로만 한다 (받은 시각 ≥ 이 JS 가 뜬 시각). 앱을 켤 때 복원한 지난 실행의 캐시는 쓰지 않는다.
 *    인터넷이 없거나 서버에 닿지 않는 동안은 아무것도 적지 않고 기다린다 → 오프라인으로 처음 켠 기기가 기존 사용자로 굳지 않는다
 *  - 예전 방식(이 기기의 사용 흔적 — 지난 실행의 쿼리 캐시)은 APK 1.4.0 을 새로 설치한 폰에서 틀렸다: app.json fallbackToCacheTimeout 0 이라
 *    설치 후 첫 실행은 APK 에 든 번들(이 기능 없음)로 돌고, 그 번들도 쿼리 캐시(rq.cache)를 적는다 → OTA 가 적용되는 두 번째 실행에서 '기존 사용자'로 적혔다
 *  - 안내 화면이 열리면 '본 것'으로 적는다 → 한 번 닫으면 다시 저절로 뜨지 않는다. 한 번 적은 기록(본 것·건너뜀)은 다시 판단하지 않는다
 */
export const FIRST_RUN_KEY = "guide.firstRun";
/** seen: 안내를 봄 · existing: 기존 사용자라 건너뜀 */
export type FirstRunMark = "seen" | "existing";

/** 이 JS 가 뜬 시각: 서버 자료를 이보다 뒤에 받았으면 이번 실행에서 새로 받은 것 (복원한 캐시는 지난 실행의 받은 시각을 그대로 가진다) */
export const BOOT_AT = Date.now();

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

/**
 * 첫 실행 안내를 저절로 열어도 되는 화면인지: 탭 첫 화면(잔고·발견·브리핑·설정)에 있을 때만. 설치 뒤 몇 초 지나 플래그가 도착했을 때
 * 사용자가 이미 검색·종목 상세나 알림으로 연 화면에 있으면 덮지 않고, 탭으로 돌아왔을 때 연다
 */
export function autoOpenPath(path: string | null | undefined): boolean {
  return typeof path === "string" && /^\/(\(tabs\)\/?)?(briefings|discover|settings)?$/.test(path);
}

export type FirstRunDecision = "wait" | "show" | "existing";

/** 서버에서 받은 자료 하나와 받은 시각 (react-query 의 data · dataUpdatedAt — 받은 적 없으면 0) */
export interface Fetched<T> {
  data?: T;
  updatedAt: number;
}

/** 토스 연동 기록이 있는지: 서버에 토스 키가 있거나(configured) 동기화한 적이 있으면. 연동 상태를 알려 주지 않는 예전 서버는 없음으로 */
export function tossLinked(h: Pick<Health, "tossOpenApi">): boolean {
  const t = h.tossOpenApi;
  return !!t && (t.configured === true || !!t.sync?.lastRunAt);
}

/**
 * 서버 자료로 정한다 (순수 함수). 이번 실행에서 새로 받은 자료만 본다 (updatedAt ≥ bootAt).
 *  - 등록 종목이 하나라도 있으면 → existing (토스 연동을 몰라도 된다)
 *  - 토스 연동 기록이 있으면 → existing (종목 목록을 몰라도 된다 — 곧 동기화로 보유 종목이 들어온다)
 *  - 종목 0개 + 토스 연동 없음을 둘 다 확인했으면 → show
 *  - 그 밖(아직 못 받음·오프라인·토큰이 틀려 상세가 빠진 /health)은 → wait (아무것도 적지 않는다)
 */
export function firstRunDecision(stocks: Fetched<readonly unknown[]>, health: Fetched<Pick<Health, "limited" | "tossOpenApi">>, bootAt: number): FirstRunDecision {
  const list = stocks.data !== undefined && stocks.updatedAt >= bootAt ? stocks.data : undefined;
  const h = health.data !== undefined && health.updatedAt >= bootAt && !health.data.limited ? health.data : undefined;
  if (list && list.length > 0) return "existing";
  if (h && tossLinked(h)) return "existing";
  if (list && h) return "show";
  return "wait";
}

let claimed = false;
/**
 * 이번 실행에서 저절로 띄우는 것은 한 번만 (true 를 받은 쪽이 띄운다). 안내 화면도 열릴 때 부른다 →
 * 설정 > 정보 '다시 보기'로 먼저 열었으면 저절로 여는 쪽이 false 를 받아 두 번째로 띄우지 않는다
 */
export function claimFirstRun(): boolean {
  if (claimed) return false;
  claimed = true;
  return true;
}
/** 테스트용: 이번 실행 기록을 지운다 */
export function forgetFirstRunClaim(): void {
  claimed = false;
}
