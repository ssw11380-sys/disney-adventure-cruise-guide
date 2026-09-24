import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

/**
 * 앱을 켜자마자 마지막 잔고·지수를 보이게 하려고 react-query 캐시 일부를 기기에 저장한다.
 *  - 잔고(stocks)와 지수 띠(indices), 기능 플래그(features)만. 장 상태·분석·뉴스·발견 목록은 저장하지 않는다
 *    (옛 장 상태가 "장중/장 마감" 판단과 폴링 주기를 좌우하지 않게)
 *  - 새로고침이 실패해도 마지막으로 받은 값은 계속 저장한다 → 다음에 오프라인으로 켜도 보인다
 *  - 받은 지 7일 지난 값은 저장·복원하지 않는다. 3일 지난 값도 "M/D HH:MM 기준"으로 보인다(긴 휴장 대비)
 *  - 토큰이 틀려(401) 실패 중인 값은 저장하지 않는다
 *  - 쿼리 키 첫 칸이 서버 주소라 서버를 바꾸면 다른 캐시를 쓴다
 */

export const PERSIST_KEYS: ReadonlySet<string> = new Set(["stocks", "indices", "features"]);
export const PERSIST_MAX_AGE_MS = 7 * 86_400_000;
/** 캐시 형식이 바뀌면 올린다 (옛 캐시를 버림) */
export const PERSIST_BUSTER = "v2";

interface QueryStateLike {
  data: unknown;
  dataUpdatedAt: number;
  error: unknown;
}

const isAuthError = (e: unknown) => typeof e === "object" && e !== null && (e as { status?: unknown }).status === 401;

/** 저장할 쿼리인지: [apiUrl, 종류] 중 종류가 목록에 있고, 받은 값이 있고, 7일 이내이고, 토큰 오류가 아닌 것 */
export function shouldPersist(queryKey: readonly unknown[], state: QueryStateLike, now: number): boolean {
  if (queryKey.length !== 2 || typeof queryKey[1] !== "string" || !PERSIST_KEYS.has(queryKey[1])) return false;
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

// 3초 폴링마다 전체 캐시를 적지 않게 10초에 한 번만
export const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "rq.cache",
  throttleTime: 10_000,
  serialize: (c) => JSON.stringify(cleanForDisk(c)),
});
