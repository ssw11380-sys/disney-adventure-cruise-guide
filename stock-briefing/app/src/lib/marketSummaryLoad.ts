import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MarketSummary } from "@/api/types";
import { PERSIST_STORAGE_KEY } from "@/lib/queryPersist";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";

/**
 * 기기에 저장한 react-query 캐시(rq.cache)에서 그 서버의 기능 플래그 key 가 켜져 있는지 (순수 함수 — 테스트용).
 * 캐시가 없거나(앱을 아직 열지 않음·지움) 모양이 다르거나 서버가 모르는 키면 false — 새 기능의 앱 기본값(fallback false)과 같다
 */
export function persistedFeatureOn(raw: string | null, apiUrl: string, key: string): boolean {
  if (!raw) return false;
  try {
    const client = JSON.parse(raw) as { clientState?: { queries?: { queryKey?: unknown[]; state?: { data?: { features?: Record<string, unknown> } } }[] } };
    const q = client.clientState?.queries?.find((x) => Array.isArray(x.queryKey) && x.queryKey[0] === apiUrl && x.queryKey[1] === "features");
    return q?.state?.data?.features?.[key] === true;
  } catch {
    return false;
  }
}

/**
 * 백그라운드 알림(로컬 알림)이 쓰는 시장 전체 요약 목록 (서버 플래그 marketSummary). React 밖에서 부른다.
 *  - 앱이 마지막으로 받은 기능 플래그(기기 저장본)에서 marketSummary 가 켜져 있을 때만 묻는다. 꺼져 있거나 모르면(예전 서버·앱을 아직 열지 않음)
 *    요청 0 으로 빈 목록 — 플래그를 끄면 조회도 하지 않는다(docs/기능-플래그.md), 예전 서버에 매번 404 를 묻지 않는다
 *  - 서버가 꺼 두었으면 빈 목록, 예전 서버(404)도 빈 목록, 끊김·시간 초과는 null — 어느 쪽이든 알림은 첫 줄 없이 지금과 같다
 *    (요약을 기다리느라 알림을 미루지 않는다)
 */
export async function loadMarketSummaries(timeoutMs = 12_000): Promise<MarketSummary[] | null> {
  const pairs = await AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken, PERSIST_STORAGE_KEY]).catch(() => [] as [string, string | null][]);
  const m = new Map(pairs);
  const apiUrl = m.get(STORAGE_KEYS.apiUrl) || defaultApiUrl();
  if (!persistedFeatureOn(m.get(PERSIST_STORAGE_KEY) ?? null, apiUrl, "marketSummary")) return [];
  // 토큰 규칙은 앱 설정과 같다: 저장한 적 없으면 번들 기본 토큰, 사용자가 비웠으면 빈 값
  const token = (m.get(STORAGE_KEYS.apiToken) ?? process.env.EXPO_PUBLIC_API_TOKEN ?? "").trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiUrl}/api/market-summaries?limit=4`, { headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: ctrl.signal });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? (list as MarketSummary[]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
