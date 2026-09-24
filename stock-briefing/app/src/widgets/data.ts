import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";
import { fillFromLast, type PnlMode } from "./model";
import { canReuse, fromPayload, NO_FEATURES, type WidgetFeatures, type WidgetIndex, type WidgetMarket, type WidgetPayload } from "./payload";
import { DEFAULT_PREFS, type NotifyPrefs } from "@/lib/briefingDigest";

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
  /** 지수 줄 (코스피·나스닥·원/달러). 예전 서버·플래그 꺼짐이면 null */
  indices: WidgetIndex[] | null;
  /** indices 를 받은 시각 (앱이 받은 지수와 어느 쪽이 새것인지 견줄 때) */
  indicesAt?: number;
  /** 위젯 기능 플래그 (예전 서버면 모두 꺼짐) */
  features: WidgetFeatures;
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
const VIEW_KEY = "widget.view";
const PNL_KEY = "widget.pnlMode";

/** 마지막으로 그린 데이터 (표시 설정 제외). 손익 전환·↻ 직후에 서버를 부르지 않고 바로 다시 그릴 때 쓴다 */
type StoredView = Omit<WidgetData, "showKrw" | "afterCost">;

/** 브리핑 위젯은 앞의 3개 요약 첫 줄만 쓰므로 그만큼만 적는다 (예전 서버의 전체 목록·상세를 저장하지 않게) */
function slimBriefings(list: LatestBriefing[]): LatestBriefing[] {
  return list
    .filter((b) => b.latest && b.latest.status === "ok")
    .slice(0, 3)
    .map((b) => ({ ...b, latest: b.latest ? { ...b.latest, detail: "" } : null }));
}

export async function saveWidgetView(data: WidgetData, apiUrl: string): Promise<void> {
  const { showKrw: _k, afterCost: _a, ...rest } = data;
  const view: StoredView = { ...rest, briefings: slimBriefings(data.briefings) };
  try {
    await AsyncStorage.setItem(VIEW_KEY, JSON.stringify({ apiUrl, view }));
  } catch {
    /* 저장 실패는 무시 */
  }
}

async function readWidgetView(apiUrl: string): Promise<StoredView | null> {
  try {
    const raw = await AsyncStorage.getItem(VIEW_KEY);
    const v = raw ? (JSON.parse(raw) as { apiUrl?: unknown; view?: Partial<StoredView> }) : null;
    const d = v?.view;
    if (!v || v.apiUrl !== apiUrl || !d || typeof d.fetchedAt !== "number" || !Array.isArray(d.stocks)) return null;
    return {
      stocks: d.stocks,
      briefings: Array.isArray(d.briefings) ? d.briefings : [],
      fetchedAt: d.fetchedAt,
      error: typeof d.error === "string" ? d.error : null,
      filled: Array.isArray(d.filled) ? d.filled : [],
      market: d.market ?? null,
      ...(d.latestIds ? { latestIds: d.latestIds } : {}),
      indices: Array.isArray(d.indices) ? d.indices : null,
      ...(typeof d.indicesAt === "number" ? { indicesAt: d.indicesAt } : {}),
      features: { ...NO_FEATURES, ...(d.features ?? {}) },
    };
  } catch {
    return null;
  }
}

/** 손익 칸이 보여 주는 것: 누적(기본) 또는 당일 */
export async function readPnlMode(): Promise<PnlMode> {
  try {
    return (await AsyncStorage.getItem(PNL_KEY)) === "day" ? "day" : "cumulative";
  } catch {
    return "cumulative";
  }
}

/** 누적 ↔ 당일을 바꾸고 바뀐 값을 돌려준다 */
export async function togglePnlMode(): Promise<PnlMode> {
  const next: PnlMode = (await readPnlMode()) === "day" ? "cumulative" : "day";
  await AsyncStorage.setItem(PNL_KEY, next).catch(() => undefined);
  return next;
}

/**
 * 서버를 부르지 않고 마지막으로 그린 데이터 (손익 전환, ↻ 를 누른 직후 "갱신 중" 표시).
 * 아직 적어 둔 것이 없으면(업데이트 직후) 마지막 잔고·마지막 /api/widget 응답으로 만든다
 */
export async function loadCachedWidgetData(): Promise<WidgetData> {
  const { apiUrl, showKrw, afterCost } = await readSettings();
  const view = await readWidgetView(apiUrl);
  if (view) return { ...view, showKrw, afterCost };
  const [last, cached] = await Promise.all([readLastStocks(apiUrl), readCachedPayload(apiUrl)]);
  const p = cached ? fromPayload(cached.body) : null;
  return {
    stocks: last?.stocks ?? p?.stocks ?? [],
    briefings: p?.briefings ?? [],
    showKrw,
    afterCost,
    fetchedAt: last?.at ?? cached?.at ?? Date.now(),
    error: null,
    filled: [],
    market: p?.market ?? null,
    ...(cached?.body.latestIds ? { latestIds: cached.body.latestIds } : {}),
    indices: p?.indices ?? null,
    ...(p?.indices && cached ? { indicesAt: cached.at } : {}),
    features: p?.features ?? NO_FEATURES,
  };
}

/**
 * 앱이 받은 잔고로 위젯을 그릴 때의 데이터 (refreshWidgets). 지수는 앱이 받은 것과 위젯이 받아 둔 것 중 새것,
 * 기능 플래그는 앱이 받은 것(없으면 위젯이 받아 둔 것). 그린 데이터는 적어 둔다 (손익 전환 때 같은 값으로 다시 그리게)
 */
export async function pushWidgetData(o: {
  stocks: RegisteredWithQuote[];
  filled: string[];
  showKrw: boolean;
  afterCost: boolean;
  fetchedAt: number;
  market: WidgetMarket | null;
  briefings?: LatestBriefing[];
  features?: WidgetFeatures | null;
  indices?: { at: number; list: WidgetIndex[] } | null;
}): Promise<WidgetData> {
  const { apiUrl } = await readSettings();
  const [prev, cached] = await Promise.all([readWidgetView(apiUrl), readCachedPayload(apiUrl)]);
  const p = cached ? fromPayload(cached.body) : null;
  const known: { at: number; list: WidgetIndex[] }[] = [];
  if (o.indices) known.push(o.indices);
  if (prev?.indices) known.push({ at: prev.indicesAt ?? prev.fetchedAt, list: prev.indices });
  if (p?.indices && cached) known.push({ at: cached.at, list: p.indices });
  const newest = known.sort((a, b) => b.at - a.at)[0] ?? null;
  const data: WidgetData = {
    stocks: o.stocks,
    briefings: o.briefings ?? prev?.briefings ?? p?.briefings ?? [],
    showKrw: o.showKrw,
    afterCost: o.afterCost,
    fetchedAt: o.fetchedAt,
    error: null,
    filled: o.filled,
    market: o.market,
    ...(prev?.latestIds ? { latestIds: prev.latestIds } : {}),
    indices: newest?.list ?? null,
    ...(newest ? { indicesAt: newest.at } : {}),
    features: o.features ?? prev?.features ?? p?.features ?? NO_FEATURES,
  };
  await saveWidgetView(data, apiUrl);
  return data;
}

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

const LEGACY_KEY = "widget.legacyServer";
const LEGACY_RECHECK_MS = 6 * 3_600_000;

/** 예전 서버라 /api/widget 이 없던 기록 (6시간 동안은 묻지 않고 예전 API 로 — 호출이 늘지 않게) */
async function legacyUntil(apiUrl: string): Promise<number> {
  try {
    const v = JSON.parse((await AsyncStorage.getItem(LEGACY_KEY)) ?? "null") as { apiUrl?: string; until?: number } | null;
    return v?.apiUrl === apiUrl && typeof v.until === "number" ? v.until : 0;
  } catch {
    return 0;
  }
}

/** /api/widget 한 번: 304 면 저장해 둔 본문, 받으면 저장. 예전 서버(404·모양이 다른 응답)면 null */
async function fetchPayload(apiUrl: string, token: string, now: number): Promise<WidgetPayload | null> {
  if (now < (await legacyUntil(apiUrl))) return null;
  const legacy = async () => {
    await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify({ apiUrl, until: now + LEGACY_RECHECK_MS })).catch(() => undefined);
    return null;
  };
  const cached = await readCachedPayload(apiUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${apiUrl}/api/widget`, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cached?.etag ? { "if-none-match": cached.etag } : {}) },
      signal: ctrl.signal,
    });
    if (res.status === 404) return legacy();
    let body: WidgetPayload | null;
    if (res.status === 304 && cached) body = cached.body;
    else if (res.ok) body = (await res.json().catch(() => null)) as WidgetPayload | null; // 프록시의 HTML 대체 페이지 등
    else throw new HttpError(res.status);
    // 모양이 다르면(예전·다른 서버) 예전 API 로
    if (!body || body.v !== 1 || !Array.isArray(body.stocks)) return legacy();
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

/**
 * 알림 규칙 (3-19): 세션당 1건 묶음·조용한 시간·끈 종목 + 브리핑 실행 중인지. 백그라운드 알림이 새 브리핑을 찾았을 때만 받는다.
 * 예전 서버(digest 없음)면 예전처럼 종목마다. 받지 못하면 null → 이번에는 알리지 않고 다음 확인에서 (잘못된 규칙으로 "본 것" 처리하지 않게)
 */
export async function loadNotifyPrefs(): Promise<(NotifyPrefs & { running: boolean }) | null> {
  const { apiUrl, apiToken } = await readSettings();
  try {
    const s = await getJson<Partial<NotifyPrefs> & { running?: boolean; schedule?: { running?: boolean } | null }>(`${apiUrl}/api/notifications/settings`, apiToken);
    const running = s.running ?? s.schedule?.running ?? false;
    if (s.digest === undefined) return { ...DEFAULT_PREFS, digest: false, running };
    return {
      digest: s.digest,
      quietEnabled: s.quietEnabled ?? DEFAULT_PREFS.quietEnabled,
      quietStart: s.quietStart ?? DEFAULT_PREFS.quietStart,
      quietEnd: s.quietEnd ?? DEFAULT_PREFS.quietEnd,
      mutedCodes: s.mutedCodes ?? [],
      running,
    };
  } catch {
    return null;
  }
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
export async function loadWidgetData(opts: { stocks?: boolean; briefings?: boolean; reuse?: boolean } = { stocks: true, briefings: true }): Promise<WidgetData> {
  const { apiUrl, apiToken, showKrw, afterCost } = await readSettings();
  const out: WidgetData = { stocks: [], briefings: [], showKrw, afterCost, fetchedAt: Date.now(), error: null, filled: [], market: null, indices: null, features: NO_FEATURES };
  const last = await readLastStocks(apiUrl);
  let full = false;
  try {
    // 위젯이 스스로 갱신할 때는 백그라운드 작업이 받아 둔 응답을 다시 쓴다 (위젯마다 서버를 부르지 않게)
    const reused = opts.reuse ? await readCachedPayload(apiUrl) : null;
    const reuse = reused && canReuse({ at: reused.at, market: reused.body.market }, out.fetchedAt) ? reused : null;
    if (reuse) out.fetchedAt = reuse.at;
    const payload = reuse ? reuse.body : await fetchPayload(apiUrl, apiToken, out.fetchedAt);
    let stocks: RegisteredWithQuote[];
    if (payload) {
      const p = fromPayload(payload);
      stocks = p.stocks;
      out.briefings = p.briefings;
      out.market = p.market;
      out.indices = p.indices;
      if (p.indices) out.indicesAt = out.fetchedAt;
      out.features = p.features;
      if (payload.latestIds) out.latestIds = payload.latestIds;
      full = true;
    } else {
      [stocks, out.briefings] = await Promise.all([
        opts.stocks ? getJson<RegisteredWithQuote[]>(`${apiUrl}/api/stocks?quotes=1`, apiToken) : Promise.resolve([]),
        opts.briefings ? getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken) : Promise.resolve([]),
      ]);
      // 예전 서버는 등록 순서라 최신 순으로 (위젯은 앞의 3개를 보여 준다)
      out.briefings = [...out.briefings].sort((a, b) => ((a.latest?.createdAt ?? "") < (b.latest?.createdAt ?? "") ? 1 : -1));
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
    if (cached) {
      const p = fromPayload(cached.body);
      out.briefings = p.briefings;
      // 지수·플래그는 마지막으로 받은 값 그대로 (실패했다고 줄이 사라지거나 손익 전환이 꺼지지 않게)
      out.indices = p.indices;
      if (p.indices) out.indicesAt = cached.at;
      out.features = p.features;
      full = true;
    }
    if (last) {
      out.stocks = last.stocks;
      out.fetchedAt = last.at;
    }
  }
  await saveWidgetView(full ? out : await mergeLegacy(out, apiUrl, opts), apiUrl);
  return out;
}

/** 예전 서버에서 한쪽만 받았으면(잔고만·브리핑만) 받지 않은 쪽은 마지막으로 그린 값을 남긴다 */
async function mergeLegacy(out: WidgetData, apiUrl: string, opts: { stocks?: boolean; briefings?: boolean }): Promise<WidgetData> {
  const prev = await readWidgetView(apiUrl);
  if (!prev) return out;
  return {
    ...out,
    ...(opts.stocks || out.stocks.length ? {} : { stocks: prev.stocks, filled: prev.filled }),
    ...(opts.briefings ? {} : { briefings: prev.briefings }),
  };
}
