import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";
import { fillFromLast } from "./model";
import { fromPayload, type WidgetMarket, type WidgetPayload } from "./payload";

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
  /** 장 상태 칩 (예전 서버면 null) */
  market: WidgetMarket | null;
  /** 모든 종목의 최신 브리핑 id (새 서버). 없으면 briefings 가 전체 목록(예전 서버) */
  latestIds?: number[];
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

const PAYLOAD_KEY = "widget.payload";

/** 마지막으로 받은 /api/widget 응답 (ETag 로 304 를 받으면 이걸 쓴다, 백그라운드 갱신이 휴장 중 호출을 건너뛸지 판단) */
export async function readCachedPayload(apiUrl?: string): Promise<{ at: number; etag: string | null; body: WidgetPayload } | null> {
  try {
    const url = apiUrl ?? (await readSettings()).apiUrl;
    const raw = await AsyncStorage.getItem(PAYLOAD_KEY);
    const v = raw ? (JSON.parse(raw) as { at?: unknown; apiUrl?: unknown; etag?: unknown; body?: unknown }) : null;
    if (!v || typeof v.at !== "number" || v.apiUrl !== url || !v.body) return null;
    return { at: v.at, etag: typeof v.etag === "string" ? v.etag : null, body: v.body as WidgetPayload };
  } catch {
    return null;
  }
}

class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** /api/widget 한 번: 304 면 저장해 둔 본문, 받으면 저장. 예전 서버(404)면 null */
async function fetchPayload(apiUrl: string, token: string, now: number): Promise<WidgetPayload | null> {
  const cached = await readCachedPayload(apiUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${apiUrl}/api/widget`, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cached?.etag ? { "if-none-match": cached.etag } : {}) },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    let body: WidgetPayload;
    if (res.status === 304 && cached) body = cached.body;
    else if (res.ok) body = (await res.json()) as WidgetPayload;
    else throw new HttpError(res.status);
    // 모양이 다르면(예전·다른 서버) 예전 API 로
    if (!body || body.v !== 1 || !Array.isArray(body.stocks)) return null;
    await AsyncStorage.setItem(PAYLOAD_KEY, JSON.stringify({ at: now, apiUrl, etag: res.headers.get("etag"), body })).catch(() => undefined);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** 모든 종목의 최신 브리핑 (백그라운드 알림이 새 브리핑을 찾았을 때만) */
export async function loadLatestBriefings(): Promise<LatestBriefing[]> {
  const { apiUrl, apiToken } = await readSettings();
  return getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken);
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
 * 서버에서 위젯에 필요한 데이터를 받는다. 위젯 3종이 GET /api/widget 한 번을 같이 쓴다 (예전 서버면 예전 두 API).
 *  - 조회가 통째로 실패하면 마지막으로 받은 잔고를 그대로 돌려주고 error 에 사유를 남긴다("잔고 0"을 보이지 않게)
 *  - 일부 종목만 시세가 없으면 그 종목은 마지막 값으로 채운다
 */
export async function loadWidgetData(opts: { stocks?: boolean; briefings?: boolean } = { stocks: true, briefings: true }): Promise<WidgetData> {
  const { apiUrl, apiToken, showKrw, afterCost } = await readSettings();
  const out: WidgetData = { stocks: [], briefings: [], showKrw, afterCost, fetchedAt: Date.now(), error: null, filled: [], market: null };
  const last = await readLastStocks(apiUrl);
  try {
    const payload = await fetchPayload(apiUrl, apiToken, out.fetchedAt);
    let stocks: RegisteredWithQuote[];
    if (payload) {
      const p = fromPayload(payload);
      stocks = p.stocks;
      out.briefings = p.briefings;
      out.market = p.market;
      if (payload.latestIds) out.latestIds = payload.latestIds;
    } else {
      [stocks, out.briefings] = await Promise.all([
        opts.stocks ? getJson<RegisteredWithQuote[]>(`${apiUrl}/api/stocks?quotes=1`, apiToken) : Promise.resolve([]),
        opts.briefings ? getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken) : Promise.resolve([]),
      ]);
    }
    const f = fillFromLast(stocks, last?.stocks ?? null, out.fetchedAt);
    out.stocks = f.stocks;
    out.filled = f.filled;
    // 채운 결과를 적는다: 채운 종목은 옛 시세 시각을 그대로 갖고 있어 7일이 지나면 더는 쓰이지 않는다
    if (stocks.length || payload) await saveLastStocks(f.stocks, out.fetchedAt, apiUrl);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    const cached = await readCachedPayload(apiUrl);
    out.market = cached?.body.market ?? null;
    if (cached) out.briefings = fromPayload(cached.body).briefings;
    if (last) {
      out.stocks = last.stocks;
      out.fetchedAt = last.at;
    }
  }
  return out;
}
