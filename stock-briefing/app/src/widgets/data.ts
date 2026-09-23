import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";
import { fillFromLast } from "./model";

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
  /** 이번 조회 실패 사유 (실패해도 stocks 에는 마지막으로 받은 값이 들어 있을 수 있다) */
  error: string | null;
  /** 이번에 받지 못해 마지막 값을 쓴 종목 코드 */
  filled: string[];
}

const LAST_KEY = "widget.lastStocks";

/**
 * 마지막으로 받은 잔고 (위젯이 조회에 실패해도 숫자를 지우지 않게). 앱이 받은 데이터도 여기에 적는다.
 * 서버 주소와 함께 적고, 주소가 바뀌면 쓰지 않는다 (다른 서버·계좌의 잔고가 보이지 않게).
 */
export async function saveLastStocks(stocks: RegisteredWithQuote[], at: number, apiUrl: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_KEY, JSON.stringify({ at, apiUrl, stocks }));
  } catch {
    /* 저장 실패는 무시 */
  }
}

export async function readLastStocks(apiUrl: string): Promise<{ at: number; stocks: RegisteredWithQuote[] } | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_KEY);
    const v = raw ? (JSON.parse(raw) as { at?: unknown; apiUrl?: unknown; stocks?: unknown }) : null;
    if (!v || typeof v.at !== "number" || !Array.isArray(v.stocks) || v.apiUrl !== apiUrl) return null;
    return { at: v.at, stocks: v.stocks as RegisteredWithQuote[] };
  } catch {
    return null;
  }
}

/** 앱이 받은 잔고로 위젯을 그릴 때: 시세가 빠진 종목은 마지막 값으로 채우고, 그 결과를 다음 실패 대비로 적어 둔다 */
export async function withLastGood(stocks: RegisteredWithQuote[], now: number): Promise<{ stocks: RegisteredWithQuote[]; filled: string[] }> {
  const { apiUrl } = await readSettings();
  const f = fillFromLast(stocks, (await readLastStocks(apiUrl))?.stocks ?? null, now);
  await saveLastStocks(f.stocks, now, apiUrl);
  return f;
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

/**
 * 서버에서 위젯에 필요한 데이터를 받는다.
 *  - 조회가 통째로 실패하면 마지막으로 받은 잔고를 그대로 돌려주고 error 에 사유를 남긴다("잔고 0"을 보이지 않게)
 *  - 일부 종목만 시세가 없으면 그 종목은 마지막 값으로 채운다
 */
export async function loadWidgetData(opts: { stocks?: boolean; briefings?: boolean } = { stocks: true, briefings: true }): Promise<WidgetData> {
  const { apiUrl, apiToken, showKrw, afterCost } = await readSettings();
  const out: WidgetData = { stocks: [], briefings: [], showKrw, afterCost, fetchedAt: Date.now(), error: null, filled: [] };
  const last = opts.stocks ? await readLastStocks(apiUrl) : null;
  try {
    const [stocks, briefings] = await Promise.all([
      opts.stocks ? getJson<RegisteredWithQuote[]>(`${apiUrl}/api/stocks?quotes=1`, apiToken) : Promise.resolve([]),
      opts.briefings ? getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken) : Promise.resolve([]),
    ]);
    const f = fillFromLast(stocks, last?.stocks ?? null, out.fetchedAt);
    out.stocks = f.stocks;
    out.filled = f.filled;
    out.briefings = briefings;
    // 채운 결과를 적는다: 채운 종목은 옛 시세 시각을 그대로 갖고 있어 7일이 지나면 더는 쓰이지 않는다
    if (opts.stocks) await saveLastStocks(f.stocks, out.fetchedAt, apiUrl);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    if (last) {
      out.stocks = last.stocks;
      out.fetchedAt = last.at;
    }
  }
  return out;
}
