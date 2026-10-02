import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { accountsSeenFor, SESSION_READ_TIMEOUT_MS, sessionFor, sessionIdentityVersion, sessionLoaded, sessionTokenFor } from "./session";

/**
 * 앱을 켜자마자 마지막 잔고·지수를 보이게 하려고 react-query 캐시 일부를 기기에 저장한다.
 *  - 잔고(stocks)와 지수 띠(indices), 기능 플래그(features)만. 장 상태·분석·뉴스·발견 목록은 저장하지 않는다
 *    (옛 장 상태가 "장중/장 마감" 판단과 폴링 주기를 좌우하지 않게)
 *  - 새로고침이 실패해도 마지막으로 받은 값은 계속 저장한다 → 다음에 오프라인으로 켜도 보인다
 *  - 받은 지 7일 지난 값은 저장·복원하지 않는다. 3일 지난 값도 "M/D HH:MM 기준"으로 보인다(긴 휴장 대비)
 *  - 토큰이 틀려(401) 실패 중인 값은 저장하지 않는다
 *  - 쿼리 키 첫 칸이 서버 주소라 서버를 바꾸면 다른 캐시를 쓴다
 *  - 계정 A단계: 자동 로그인을 끈 세션(공용 폰 등)이면 개인 데이터(잔고)는 기기에 적지 않는다 — 앱을 완전히 닫으면 세션과 함께 사라지게.
 *    지수·플래그는 개인 데이터가 아니라 그대로
 */

export const PERSIST_KEYS: ReadonlySet<string> = new Set(["stocks", "indices", "features"]);
/** 그중 개인 데이터 (자동 로그인을 끈 세션이면 적지 않는다) */
export const PERSONAL_PERSIST_KEYS: ReadonlySet<string> = new Set(["stocks"]);
export const PERSIST_MAX_AGE_MS = 7 * 86_400_000;
/** 기기 저장 키 (백그라운드 알림이 마지막으로 받은 기능 플래그를 여기서 읽는다 — lib/marketSummaryLoad) */
export const PERSIST_STORAGE_KEY = "rq.cache";
/** 캐시 형식이 바뀌면 올린다 (옛 캐시를 버림) */
export const PERSIST_BUSTER = "v2";

interface QueryStateLike {
  data: unknown;
  dataUpdatedAt: number;
  error: unknown;
}

const isAuthError = (e: unknown) => typeof e === "object" && e !== null && (e as { status?: unknown }).status === 401;

/**
 * 저장할 쿼리인지: [apiUrl, 종류] 중 종류가 목록에 있고, 받은 값이 있고, 7일 이내이고, 토큰 오류가 아닌 것.
 * personal(apiUrl): 그 서버의 개인 데이터를 기기에 적어도 되는지 (자동 로그인 끔이면 false — lib/session persistsPersonal)
 */
export function shouldPersist(queryKey: readonly unknown[], state: QueryStateLike, now: number, personal: (apiUrl: string) => boolean = () => true): boolean {
  if (queryKey.length !== 2 || typeof queryKey[1] !== "string" || !PERSIST_KEYS.has(queryKey[1])) return false;
  if (PERSONAL_PERSIST_KEYS.has(queryKey[1]) && !personal(String(queryKey[0]))) return false;
  if (state.data === undefined || !(state.dataUpdatedAt > 0) || now - state.dataUpdatedAt > PERSIST_MAX_AGE_MS) return false;
  return !isAuthError(state.error);
}

/**
 * 기기에 적기 전에 실패 흔적을 지운다: 다음 실행 때 "오류 상태의 옛 값"이 아니라 "옛 값"으로 복원되게
 * (그러지 않으면 켤 때마다 "연결 끊김" 띠가 잠깐 뜬다). 값과 받은 시각은 그대로 둔다.
 */
export function cleanForDisk(client: PersistedClient): PersistedClient {
  return {
    ...client,
    clientState: {
      mutations: [],
      queries: client.clientState.queries.map((q) => ({
        ...q,
        state: { ...q.state, status: "success", error: null, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle" },
      })),
    },
  };
}

/** 토큰 없이 개인 쿼리의 서버별 소유자만 기록한다. 공개 쿼리를 읽는 기존 경로의 root 모양은 유지한다. */
type ScopedClient = PersistedClient & { accountOwners?: Record<string, number | null> };
type WriteScope = { identity: number; epoch: number };
let cacheEpoch = 0;
let privateInvalid = false;
const snapshots = new WeakMap<PersistedClient, WriteScope>();
// 저장기는 쓰기를 한 번에 하나씩 수행한다. 직렬화 뒤 native 쓰기 직전·직후에도 같은 캡처를 검사한다.
const writes = new Map<string, WriteScope>();
const currentScope = (scope: WriteScope) => scope.identity === sessionIdentityVersion() && scope.epoch === cacheEpoch;
const personalQuery = (key: readonly unknown[]) => typeof key[1] === "string" && PERSONAL_PERSIST_KEYS.has(key[1]);

/** 기기 읽기·삭제 각각에 기존 세션 읽기 기한을 적용한다. 정상 완료는 바로 반환하고 늦은 거절도 회수한다. */
async function storageDeadline<T>(work: () => T | PromiseLike<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), SESSION_READ_TIMEOUT_MS); }),
    ]);
  } catch {
    // 복원 실패를 throw하면 SDK가 다시 삭제를 기다리므로 오류도 빈 결과로 끝낸다.
    return undefined;
  } finally { clearTimeout(timer); }
}

// 3초 폴링마다 전체 캐시를 적지 않게 기존처럼 10초에 한 번만
const diskPersister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => AsyncStorage.getItem(key),
    removeItem: (key) => AsyncStorage.removeItem(key),
    setItem: async (key, value) => {
      const scope = writes.get(value);
      try {
        if (!scope || !currentScope(scope)) return;
        await AsyncStorage.setItem(key, value);
        if (currentScope(scope)) privateInvalid = false;
      } finally { if (writes.get(value) === scope) writes.delete(value); }
    },
  },
  key: PERSIST_STORAGE_KEY,
  throttleTime: 10_000,
  serialize: (c) => {
    const scope = snapshots.get(c);
    if (!scope || !currentScope(scope)) throw new Error("캐시 저장 전에 로그인 정보가 바뀌었습니다.");
    const raw = JSON.stringify(cleanForDisk(c));
    writes.set(raw, scope);
    return raw;
  },
});

export const queryPersister: Persister = {
  persistClient: (client) => {
    // throttle 실행 때의 사람이 아니라 스냅샷을 맡긴 순간의 사람으로 고정한다.
    const scope = { identity: sessionIdentityVersion(), epoch: cacheEpoch };
    const accountOwners: Record<string, number | null> = {};
    const queries = client.clientState.queries.filter((q) => {
      if (!personalQuery(q.queryKey)) return true;
      const apiUrl = String(q.queryKey[0]);
      const session = sessionFor(apiUrl);
      if (!sessionLoaded() || (session ? !session.remember : accountsSeenFor(apiUrl))) return false;
      accountOwners[apiUrl] = session?.user.id ?? null;
      return true;
    });
    const scoped: ScopedClient = { ...client, accountOwners, clientState: { ...client.clientState, queries } };
    snapshots.set(scoped, scope);
    return diskPersister.persistClient(scoped);
  },
  restoreClient: async () => {
    const scope = { identity: sessionIdentityVersion(), epoch: cacheEpoch };
    // 세션과 캐시를 동시에 읽는다. 저장소 오류를 무계정 상태로 오인해 개인 자료를 허용하지 않는다.
    const result = await storageDeadline(() => Promise.all([
      diskPersister.restoreClient() as Promise<ScopedClient | undefined>,
      sessionTokenFor("").then(() => true, () => false),
    ]));
    if (!result) return undefined;
    const [restored, sessionReady] = result;
    if (!restored || !currentScope(scope)) return undefined;
    return {
      ...restored,
      // 라이브러리가 await 뒤 hydrate하는 순간에도 다시 확인한다. 반환 직후 계정이 바뀌는 틈도 비운다.
      get clientState() {
        if (!currentScope(scope)) return { queries: [], mutations: [] };
        return { ...restored.clientState, queries: restored.clientState.queries.filter((q) => {
          if (!personalQuery(q.queryKey)) return true;
          if (!sessionReady || privateInvalid) return false;
          const apiUrl = String(q.queryKey[0]);
          const owner = restored.accountOwners?.[apiUrl];
          const session = sessionFor(apiUrl);
          return session ? session.remember && owner === session.user.id
            : !accountsSeenFor(apiUrl) && (owner === undefined || owner === null);
        }) };
      },
    };
  },
  removeClient: async () => {
    cacheEpoch++;
    privateInvalid = true;
    // 삭제 실패도 로그인 전환을 실패시키거나 처리되지 않은 거절로 남기지 않는다.
    await storageDeadline(() => diskPersister.removeClient());
  },
};
