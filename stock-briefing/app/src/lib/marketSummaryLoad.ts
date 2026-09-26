import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MarketSummary } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";

/**
 * 백그라운드 알림(로컬 알림)이 쓰는 시장 전체 요약 목록 (서버 플래그 marketSummary). React 밖에서 부른다.
 * 서버가 꺼 두었으면 빈 목록, 예전 서버(404)도 빈 목록, 끊김·시간 초과는 null — 어느 쪽이든 알림은 첫 줄 없이 지금과 같다
 * (요약을 기다리느라 알림을 미루지 않는다)
 */
export async function loadMarketSummaries(timeoutMs = 12_000): Promise<MarketSummary[] | null> {
  const pairs = await AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken]).catch(() => [] as [string, string | null][]);
  const m = new Map(pairs);
  const apiUrl = m.get(STORAGE_KEYS.apiUrl) || defaultApiUrl();
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
