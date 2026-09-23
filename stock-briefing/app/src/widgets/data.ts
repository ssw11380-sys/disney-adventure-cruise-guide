import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";

/**
 * 위젯은 앱과 별도의 JS 컨텍스트에서 돌아가므로(react-native-android-widget 태스크 핸들러) react-query 나
 * SettingsProvider 를 쓸 수 없다. AsyncStorage 에서 서버 주소·토큰·표시 설정을 직접 읽어 서버를 호출한다.
 */

export interface WidgetData {
  stocks: RegisteredWithQuote[];
  briefings: LatestBriefing[];
  showKrw: boolean;
  afterCost: boolean;
  fetchedAt: number;
  error: string | null;
}

async function readSettings(): Promise<{ apiUrl: string; apiToken: string; showKrw: boolean; afterCost: boolean }> {
  const pairs = await AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken, STORAGE_KEYS.showKrw, STORAGE_KEYS.afterCost]).catch(() => []);
  const m = new Map(pairs);
  return {
    apiUrl: m.get(STORAGE_KEYS.apiUrl) || defaultApiUrl(),
    apiToken: m.get(STORAGE_KEYS.apiToken) || process.env.EXPO_PUBLIC_API_TOKEN || "",
    showKrw: m.get(STORAGE_KEYS.showKrw) === "1",
    afterCost: m.get(STORAGE_KEYS.afterCost) !== "0",
  };
}

async function getJson<T>(url: string, token: string, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 서버에서 위젯에 필요한 데이터를 받는다. 실패하면 error 에 사유를 남기고 빈 목록 */
export async function loadWidgetData(opts: { stocks?: boolean; briefings?: boolean } = { stocks: true, briefings: true }): Promise<WidgetData> {
  const { apiUrl, apiToken, showKrw, afterCost } = await readSettings();
  const out: WidgetData = { stocks: [], briefings: [], showKrw, afterCost, fetchedAt: Date.now(), error: null };
  try {
    const [stocks, briefings] = await Promise.all([
      opts.stocks ? getJson<RegisteredWithQuote[]>(`${apiUrl}/api/stocks?quotes=1`, apiToken) : Promise.resolve([]),
      opts.briefings ? getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken) : Promise.resolve([]),
    ]);
    out.stocks = stocks;
    out.briefings = briefings;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}
