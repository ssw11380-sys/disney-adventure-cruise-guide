import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 첫 실행 안내 (3-24, 기능 플래그 firstRun). 한 화면(app/welcome)을 이 기기에서 처음 쓰는 사람에게 한 번만 보인다.
 *  - 새 사용자인지는 서버가 아니라 **이 기기의 사용 흔적**으로 정한다. 서버의 등록 종목 수로 정하면 토스 자동 동기화(서버 시작 15초 뒤)로
 *    새 사용자도 종목이 이미 있어 안내가 뜨지 않고, 같은 서버를 쓰는 새 휴대폰(위젯·알림 권한이 바로 필요한 곳)에서도 뜨지 않았다
 *  - 사용 흔적(PRIOR_USE_KEYS): 이번 실행 전에 저장된 쿼리 캐시(마지막 잔고 — 앱을 한 번이라도 연 기기), 연 브리핑·최근 검색·차트 설정,
 *    사용자가 바꾼 설정 값. 흔적이 있으면(OTA 로 이 기능을 처음 받은 기존 사용자) 띄우지 않고 '건너뜀'으로 적는다 (억지로 거치게 하지 않음)
 *  - 안내 화면이 열리면 '본 것'으로 적는다 → 한 번 닫으면 다시 저절로 뜨지 않는다. 설정 > 정보에서 언제든 다시 연다
 */
export const FIRST_RUN_KEY = "guide.firstRun";
/** seen: 안내를 봄 · existing: 기존 사용자라 건너뜀 */
export type FirstRunMark = "seen" | "existing";

/** 이 JS 가 뜬 시각: 쿼리 캐시가 이보다 먼저 적혔으면 지난 실행의 것 (이번 실행에서 막 적힌 캐시는 흔적이 아니다 — 앱을 켤 때 읽어 두므로 보통은 늘 지난 실행의 것) */
const BOOT_AT = Date.now();

/** 쿼리 캐시 저장 키 (lib/queryPersist PERSIST_STORAGE_KEY 와 같다 — 그 모듈은 persister 를 만들어 여기서 불러오지 않는다) */
export const QUERY_CACHE_KEY = "rq.cache";
/**
 * 사용자가 무언가를 해야 적히는 키: 설정 값(서버 주소·정렬·원화 표시·테마·비용 차감·위젯 통화·진동), 연 브리핑, 최근 검색, 차트 설정.
 * 이 중 하나라도 있으면 이 기기에서 앱을 써 본 것이다 (앱이 켜질 때 저절로 적는 키는 넣지 않는다)
 */
export const PRIOR_USE_KEYS = [
  "settings.apiUrl",
  "settings.sort",
  "settings.showKrw",
  "settings.themeMode",
  "settings.afterCost",
  "settings.widgetRowCurrency",
  "settings.haptics",
  "briefings.read",
  "search.recent",
  "chartPrefs.v1",
] as const;

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

/** 저장된 쿼리 캐시가 이번 실행 전에 적힌 것인지 (순수 함수). 캐시 형식: { timestamp, buster, clientState } — 모르는 모양이면 흔적으로 본다 */
export function cacheFromEarlierRun(raw: string | null | undefined, bootAt: number): boolean {
  if (!raw) return false;
  try {
    const ts = (JSON.parse(raw) as { timestamp?: unknown }).timestamp;
    return typeof ts === "number" ? ts < bootAt : true;
  } catch {
    return true;
  }
}

/** 저장소 값들로 이 기기의 사용 흔적이 있는지 (순수 함수) */
export function priorUseFrom(values: ReadonlyMap<string, string | null>, bootAt: number): boolean {
  if (PRIOR_USE_KEYS.some((k) => values.get(k) != null)) return true;
  return cacheFromEarlierRun(values.get(QUERY_CACHE_KEY), bootAt);
}

/**
 * 이 JS 가 뜰 때 한 번 읽어 둔 사용 흔적 (PRIOR_USE_KEYS + 쿼리 캐시). 못 읽으면 null.
 * 쿼리 캐시 저장기(lib/queryPersist, @tanstack/query-async-storage-persister)는 복원한 뒤 첫 쿼리 변화 때 **기다리지 않고 바로**
 * rq.cache 를 이번 실행 시각으로 다시 적는다(throttle 의 첫 호출은 곧장 실행). 그래서 firstRun 플래그를 받은 뒤에(복원된 플래그에 없고
 * 네트워크에서 온 경우 등) 저장소를 읽으면 지난 실행의 캐시는 이미 덮여 흔적이 사라진다 → 캐시 말고 다른 흔적이 없는 기존 사용자에게 안내가 떴다.
 * 이 모듈을 불러오는 순간(앱 루트 app/_layout 이 components/UxBridge 를 거쳐 불러온다 — PersistQueryClientProvider 가 그려져 복원을
 * 시작하기 전)에 읽기를 시작해 두고, 플래그와 상관없이 그 결과를 쓴다. AsyncStorage 는 요청을 들어온 차례대로 처리한다(안드로이드 직렬 실행기,
 * 웹 localStorage 는 동기) → 이 읽기가 저장기의 복원·다시 쓰기보다 먼저 끝난다
 */
let bootTraces: Promise<ReadonlyMap<string, string | null> | null> = readTraces();

function readTraces(): Promise<ReadonlyMap<string, string | null> | null> {
  try {
    return AsyncStorage.multiGet([...PRIOR_USE_KEYS, QUERY_CACHE_KEY]).then(
      (pairs) => new Map(pairs) as ReadonlyMap<string, string | null>,
      () => null,
    );
  } catch {
    return Promise.resolve(null);
  }
}

/** 테스트용: 저장소를 지금 다시 읽어 '이번 실행을 시작할 때의 흔적'으로 삼는다 (JS 를 새로 띄운 것과 같다) */
export function rereadBootTraces(): Promise<void> {
  bootTraces = readTraces();
  return bootTraces.then(() => undefined);
}

/**
 * 이 기기에서 앱을 써 본 흔적이 있는지 — 앱을 켤 때 읽어 둔 값으로 (bootTraces). 저장소를 못 읽었으면 있는 것으로
 * (확실하지 않을 때 억지로 띄우지 않는다). bootAt: 이 시각보다 먼저 적힌 쿼리 캐시만 흔적 (테스트는 고정 시각을 넘긴다)
 */
export async function hasPriorUse(bootAt = BOOT_AT): Promise<boolean> {
  const values = await bootTraces;
  return values ? priorUseFrom(values, bootAt) : true;
}

/**
 * 첫 실행 안내를 저절로 열어도 되는 화면인지: 탭 첫 화면(잔고·발견·브리핑·설정)에 있을 때만. 설치 뒤 몇 초 지나 플래그가 도착했을 때
 * 사용자가 이미 검색·종목 상세나 알림으로 연 화면에 있으면 덮지 않고, 탭으로 돌아왔을 때 연다
 */
export function autoOpenPath(path: string | null | undefined): boolean {
  return typeof path === "string" && /^\/(\(tabs\)\/?)?(briefings|discover|settings)?$/.test(path);
}

export type FirstRunDecision = "wait" | "show" | "existing";

/** 기록·사용 흔적으로 정한다 (순수 함수). prior 를 아직 모르면(읽는 중) 기다린다 */
export function firstRunDecision(prior: boolean | undefined): FirstRunDecision {
  if (prior === undefined) return "wait";
  return prior ? "existing" : "show";
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
