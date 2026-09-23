import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

/**
 * 앱을 켜자마자 마지막 잔고·지수를 보이게 하려고 react-query 캐시 일부를 기기에 저장한다.
 *  - 잔고(stocks), 지수 띠(indices), 장 상태(market)만. 분석·뉴스·발견 목록은 저장하지 않는다
 *  - 7일 지난 캐시는 버린다. 3일 지난 캐시도 "M/D HH:MM 기준"으로 보인다(추석 같은 긴 휴장 대비)
 *  - 쿼리 키 첫 칸이 서버 주소라 서버를 바꾸면 다른 캐시를 쓴다
 */

export const PERSIST_KEYS: ReadonlySet<string> = new Set(["stocks", "indices", "market"]);
export const PERSIST_MAX_AGE_MS = 7 * 86_400_000;
/** 캐시 형식이 바뀌면 올린다 (옛 캐시를 버림) */
export const PERSIST_BUSTER = "v1";

/** 저장할 쿼리인지: [apiUrl, 종류, ...] 중 종류가 목록에 있고, 성공한 값만 */
export function shouldPersist(queryKey: readonly unknown[], status: string): boolean {
  return status === "success" && typeof queryKey[1] === "string" && PERSIST_KEYS.has(queryKey[1]) && queryKey.length === 2;
}

// 3초 폴링마다 전체 캐시를 적지 않게 10초에 한 번만
export const queryPersister = createAsyncStoragePersister({ storage: AsyncStorage, key: "rq.cache", throttleTime: 10_000 });
