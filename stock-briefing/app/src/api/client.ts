import type { AppErrorSummary, Evaluation,
  AccountBriefing,
  AccountBriefingWithData,
  DiscoverMarket,
  DiscoverRank,
  RankCategory,
  ThemeDetail,
  ThemeKind,
  ThemeList,
  ThemePeriod,
  Analysis,
  AnalysisKind,
  Briefing,
  BriefingSession,
  BriefingWithData,
  CandlePeriod,
  CandleSeries,
  Device,
  Health,
  NotificationSettings,
  NotificationSettingsPatch,
  SendSummary,
  LatestBriefing,
  ListedStock,
  MarketIndex, MarketStatus, MarketSummary,
  Quote,
  RegisteredStock,
  RegisteredWithQuote,
  RunResult,
  StockNews,
  TossImportResult,
  TossOpenApiStatus,
  FeatureFlags,
  IndicatorScores,
  PriceAlertKind,
  PriceAlertRule,
  VolumeStatus,
  BriefingStatus,
  ReconcileBadgeBody,
} from "./types";
import { authMessage, NOT_JSON } from "@/lib/connectionError";

import { condDrop, condGet, condHeaders, condKey, condNote, condPut, isDelta, rebuild } from "./condCache";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** 물은 API 경로 (쿼리 포함, 서버 주소 제외) — 늘 있는 목록 경로의 404 를 '틀린 서버 주소'로 알아보는 데 쓴다 (lib/connectionError) */
    public readonly path?: string,
    /** 물은 서버 주소 (설정의 '서버 주소' 값) — 연결 오류 안내가 '지금 서버 주소'를 한 줄 보여 주는 데 쓴다 (lib/connectionError addressLine) */
    public readonly base?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** 요청 한 번: 응답과 본문 글자. 연결·시간 초과는 ApiRequestError(0) */
async function exchange(baseUrl: string, token: string, path: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
      signal: ctrl.signal,
    });
    // 헤더만 오고 본문이 멈추는 경우도 제한 시간에 끊는다: 타이머는 본문을 다 읽은 뒤에 푼다 (NET-01)
    const text = res.status === 204 || res.status === 304 ? "" : await res.text();
    return { res, text };
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e as Error).name === "AbortError";
    throw new ApiRequestError(0, aborted ? "TIMEOUT" : "NETWORK", aborted ? "서버 응답이 없습니다 (시간 초과)" : `서버에 연결할 수 없습니다: ${baseUrl}`, path, baseUrl);
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(baseUrl: string, token: string, path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<T> {
  const { res, text } = await exchange(baseUrl, token, path, init, timeoutMs);
  return result<T>(res, text, path, baseUrl);
}

/**
 * 조건부 GET (플래그 pollSaver, 3-25 성능-16 — 규칙은 condCache.ts). 304 는 기억한 본문, 226 은 기억한 본문 + 차이(해시가 맞을 때만),
 * 그 밖에는 request 와 같다. 차이를 쓸 수 없으면 조건 없이 한 번 더 받아 전체로 바꾼다 (옛 값을 보여 주지 않게)
 */
async function requestCond<T>(baseUrl: string, token: string, path: string, timeoutMs: number): Promise<T> {
  const key = condKey(baseUrl, path);
  const held = condGet(key);
  const { res, text } = await exchange(baseUrl, token, path, { headers: condHeaders(held) }, timeoutMs);
  if (res.status === 304 && held) {
    condNote("same");
    return JSON.parse(held.text) as T;
  }
  if (res.ok && res.status !== 304) {
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 아래 result 가 처리 */
    }
    if (!isDelta(json)) {
      // 전체 본문: ETag 가 있으면 기억, 없으면(예전 서버·플래그 꺼짐) 잊는다
      const etag = res.headers.get("etag");
      if (etag && json !== null) condPut(key, etag, text);
      else condDrop(key);
      condNote("full");
      return result<T>(res, text, path, baseUrl);
    }
    const out = rebuild(held, json);
    if (out !== null) {
      condPut(key, json.etag, JSON.stringify(out));
      condNote("delta");
      return out as T;
    }
    condNote("resync");
  }
  if (res.ok || res.status === 304) {
    // 쓸 수 없는 차이·기억에 없는 304: 기억을 버리고 조건 없이 전체를 받는다
    condDrop(key);
    const again = await exchange(baseUrl, token, path, {}, timeoutMs);
    const etag = again.res.headers.get("etag");
    if (again.res.ok && etag && again.text && !isDelta(safeParse(again.text))) condPut(key, etag, again.text);
    condNote("full");
    return result<T>(again.res, again.text, path, baseUrl);
  }
  return result<T>(res, text, path, baseUrl);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 응답 → 값 (204 면 없음, 실패면 ApiRequestError — 오류에는 요청 경로·서버 주소를 붙인다: 3-24 연결 오류 안내가 '지금 서버 주소'를 보여 준다) */
function result<T>(res: Response, text: string, path: string, baseUrl: string): T {
  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  let parsed = true;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 아래에서 처리 */
    parsed = false;
  }
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; message?: string };
    throw new ApiRequestError(res.status, err.error ?? `HTTP_${res.status}`, res.status === 401 ? authMessage() : (err.message ?? `서버 오류 (${res.status})`), path, baseUrl);
  }
  // 성공 응답인데 JSON 이 아니면(웹 페이지 등) 이 앱의 서버가 아니다 — 예전에는 빈 값(null)으로 넘겨 빈 잔고처럼 보였다 (버그 수정)
  if (!parsed) throw new ApiRequestError(res.status, NOT_JSON, "서버 응답을 읽을 수 없습니다. 이 주소가 앱의 서버가 아닐 수 있습니다.", path, baseUrl);
  return json as T;
}

/**
 * 종목 한 개의 API 경로. 코드는 한 경로 칸으로 인코딩한다 — 값의 / ? # 가 다른 API 경로·쿼리가 되지 않게 (BH-36, 정상 코드는 그대로).
 * "." · ".." 는 인코딩해도 주소에서 경로 이동으로 풀리므로 막지 못한다 → 화면 주소의 코드는 parseStockCode 로 먼저 거른다
 */
const stockPath = (code: string) => `/api/stocks/${encodeURIComponent(code)}`;

export interface ApiOptions {
  /**
   * 끊겼을 때 데이터 절약(플래그 pollSaver)이 켜져 있는지 — 요청할 때마다 묻는다. 켜져 있으면 자주 묻는 GET(잔고·상세·지수·장 상태·플래그·/health)을
   * 조건부로(304·바뀐 부분만) 받는다. 없거나 false 면 예전과 똑같이 요청한다
   */
  saver?: () => boolean;
}

/** 백엔드 REST 클라이언트. baseUrl/token 은 설정에서 온다. */
export function createApi(baseUrl: string, token = "", opts: ApiOptions = {}) {
  const get = <T>(path: string, timeoutMs?: number) => request<T>(baseUrl, token, path, {}, timeoutMs);
  /** 자주 묻는 GET: pollSaver 가 켜져 있으면 조건부 */
  const poll = <T>(path: string, timeoutMs = 60_000) => (opts.saver?.() ? requestCond<T>(baseUrl, token, path, timeoutMs) : get<T>(path, timeoutMs));
  const send = <T>(method: string, path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(baseUrl, token, path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);

  return {
    baseUrl,
    health: () => poll<Health>("/health", 8_000),
    /** 앱 오류 보고 (lib/errorReport). 토큰·금액은 보내기 전에 지운다 */
    reportErrors: (errors: unknown[]) => send<{ saved: number; dropped: number }>("POST", "/api/app-errors", { errors }, 10_000),
    appErrorSummary: (days = 7) => get<AppErrorSummary>(`/api/admin/app-errors?days=${days}`),

    searchStocks: (q: string, limit = 20) => get<{ results: ListedStock[]; source: string }>(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
    /** 종목 마스터만 (외부 검색을 기다리지 않아 바로) — 예전 서버는 local 을 무시하고 전체 결과를 준다 */
    searchStocksLocal: (q: string, limit = 20) => get<{ results: ListedStock[]; source: string }>(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}&local=1`, 5_000),
    // 3초마다 부르는 조회는 응답 없는 망에서 60초씩 묶이지 않게 15초로 끊는다 (서버 첫 호출 최대 약 13초 실측)
    listStocks: () => poll<RegisteredWithQuote[]>("/api/stocks?quotes=1", 15_000),
    /** registered: false 면 등록하지 않은 종목의 미리 보기(발견 탭 등). 구버전 서버는 필드 없음(= 등록 종목) */
    getStock: (code: string) =>
      poll<RegisteredStock & { registered?: boolean; quote: Quote | null; quoteError: string | null; evaluation?: Evaluation | null }>(stockPath(code), 15_000),
    registerStock: (body: { code: string; quantity?: number | null; avgPrice?: number | null; memo?: string | null }) =>
      send<RegisteredStock>("POST", "/api/stocks", body),
    updateStock: (code: string, body: { quantity?: number | null; avgPrice?: number | null; memo?: string | null }) =>
      send<RegisteredStock>("PATCH", stockPath(code), body),
    removeStock: (code: string) => send<void>("DELETE", stockPath(code)),
    getQuote: (code: string, fresh = false) => get<Quote>(`${stockPath(code)}/quote${fresh ? "?fresh=1" : ""}`),
    getCandles: (code: string, period: CandlePeriod, count: number) => get<CandleSeries>(`${stockPath(code)}/candles?period=${period}&count=${count}`),
    getAnalysis: (code: string, kind: AnalysisKind, refresh = false) =>
      get<Analysis>(`${stockPath(code)}/analysis/${kind}${refresh ? "?refresh=1" : ""}`, 180_000),
    getStockNews: (code: string) => get<StockNews>(`${stockPath(code)}/news`),
    /** 지표 점수 (3-44, 플래그 indicatorScores). 플래그가 꺼져 있거나 예전 서버·모르는 종목이면 404 → 부르는 쪽이 "없음"으로 본다 */
    indicatorScores: (code: string) => get<IndicatorScores>(`/api/scores/${encodeURIComponent(code)}`, 20_000),

    latestBriefings: () => get<LatestBriefing[]>("/api/briefings/latest"),
    listBriefings: (filter: { code?: string; date?: string; session?: BriefingSession; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (filter.code) q.set("code", filter.code);
      if (filter.date) q.set("date", filter.date);
      if (filter.session) q.set("session", filter.session);
      if (filter.limit) q.set("limit", String(filter.limit));
      const qs = q.toString();
      return get<Briefing[]>(`/api/briefings${qs ? `?${qs}` : ""}`);
    },
    getBriefing: (id: number) => get<BriefingWithData>(`/api/briefings/${id}`),
    runBriefings: (session: BriefingSession, codes?: string[], force = false) =>
      send<RunResult>("POST", "/api/briefings/run", { session, codes, force }, 600_000),
    /** 브리핑 늦음·실패 안내 (브리핑 3차 2, 플래그 briefingStatus). 꺼져 있거나 예전 서버면 404 → 부르는 쪽이 "모름"으로 본다 (예전 안내) */
    briefingStatus: () => get<BriefingStatus>("/api/briefings/status", 10_000),
    /** 계좌 한 장 브리핑 (3-31). 예전 서버는 404 → 부르는 쪽이 "없음"으로 본다 */
    accountBriefings: (limit = 5) => get<AccountBriefing[]>(`/api/account-briefings?limit=${limit}`, 15_000),
    getAccountBriefing: (id: number) => get<AccountBriefingWithData>(`/api/account-briefings/${id}`, 15_000),
    /** 시장 전체 요약 (플래그 marketSummary). 예전 서버는 404 → 부르는 쪽이 "없음"으로 본다 (카드 없음) */
    marketSummaries: (limit = 4) => get<MarketSummary[]>(`/api/market-summaries?limit=${limit}`, 15_000),
    getMarketSummary: (id: number) => get<MarketSummary>(`/api/market-summaries/${id}`, 15_000),

    registerDevice: (body: { token: string; platform: "android" | "ios" | "unknown"; deviceName?: string | null }) => send<Device>("POST", "/api/devices", body),
    unregisterDevice: (token: string) => send<void>("DELETE", `/api/devices/${encodeURIComponent(token)}`),
    listDevices: () => get<Device[]>("/api/devices"),
    getNotificationSettings: () => get<NotificationSettings>("/api/notifications/settings"),
    /** mute: 종목 하나만 알림 끄기/켜기 (3-19 서버). 목록 전체(mutedCodes)를 보내지 않아 연달아 눌러도 안전 */
    updateNotificationSettings: (patch: NotificationSettingsPatch) => send<NotificationSettings>("PUT", "/api/notifications/settings", patch),
    sendTestNotification: () => send<SendSummary>("POST", "/api/notifications/test"),

    tossStatus: () => get<TossOpenApiStatus>("/api/admin/toss/status", 15_000),
    features: () => poll<FeatureFlags>("/api/features", 8_000),
    importTossHoldings: () => send<TossImportResult>("POST", "/api/admin/toss/import-holdings", undefined, 60_000),
    /**
     * 해외 종목 원화 매입금액(토스 앱 원화 보기의 평가금액 − 평가손익)을 정확한 값으로 저장.
     * manual: 저장은 했지만 직접 넣은 수량·평단으로 평가 중이라 다음 토스 동기화 뒤부터 쓰인다 (옛 서버는 보내지 않음)
     */
    setKrwCost: (items: Record<string, number>) =>
      send<{ applied: string[]; skipped: { code: string; reason: "not_held" | "orders_failed" | "unexplained" | "changed" | "manual"; retryAfter?: string }[] }>("PUT", "/api/admin/toss/krw-cost", { items }),
    marketStatus: () => poll<MarketStatus>("/api/market/status", 10_000),
    /**
     * stale=1: 출처가 실패한 지수도 마지막 값(stale·fetchedAt)으로 받는다 — 이 앱은 "시세 지연"·실제 받은 시각으로 보여 준다.
     * 서버는 이 표시를 모르는 옛 앱(플래그 없음)에는 실패한 항목을 뺀다. 예전 서버는 플래그를 무시한다
     */
    marketIndices: () => poll<{ indices: MarketIndex[] }>("/api/market/indices?stale=1", 10_000),
    /**
     * r=1: 뒤 쪽의 판(v)을 서버가 잃었으면 빈 쪽 + restart 를 받는다 (checkRankPage 가 첫 쪽부터 다시 받는다).
     * 서버는 restart 를 모르는 옛 앱(플래그 없음)에는 지금 목록의 쪽을 준다. 예전 서버도 그렇게 주고, 판이 달라 이 앱이 알아챈다
     */
    discoverRank: (market: DiscoverMarket, category: RankCategory, page = 1, size = 50, ver?: number) =>
      get<DiscoverRank>(`/api/discover/${market}/rank/${category}?page=${page}&size=${size}${ver ? `&v=${ver}` : ""}&r=1`, 15_000),
    discoverThemes: (market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod) => get<ThemeList>(`/api/discover/${market}/themes?kind=${kind}&period=${period}`, 20_000),
    discoverTheme: (market: DiscoverMarket, kind: ThemeKind, id: string) => get<ThemeDetail>(`/api/discover/${market}/themes/${encodeURIComponent(id)}?kind=${kind}`, 20_000),
    marketCandles: (code: string, period: CandlePeriod, count: number) => get<CandleSeries>(`/api/market/indices/${encodeURIComponent(code)}/candles?period=${period}&count=${count}`),
    /** 가격 알림 (3-29, 플래그 priceAlerts). 예전 서버는 404 → 부르는 쪽이 "조건 없음"으로 본다 */
    priceAlerts: () => get<{ rules: PriceAlertRule[] }>("/api/price-alerts", 10_000),
    createPriceAlert: (body: { code: string; kind: PriceAlertKind; value: number }) => send<PriceAlertRule>("POST", "/api/price-alerts", body),
    deletePriceAlert: (id: number) => send<void>("DELETE", `/api/price-alerts/${id}`),
    priceAlertFired: (id: number, body: { date: string; at: string; value: number }) => send<{ first: boolean }>("POST", `/api/price-alerts/${id}/fired`, body, 10_000),
    // 시간 제한 45초: 서버가 여러 종목 30분봉을 순서대로 받고 시간 예산 35초 안에 끝낸다. 15초면 느린 토스에서 매번 시간 초과
    priceAlertVolume: (codes: string[]) => get<{ items: VolumeStatus[] }>(`/api/price-alerts/volume?codes=${codes.map(encodeURIComponent).join(",")}`, 45_000),
    /** 잔고 '숫자 기준' 배지 (3-32, 플래그 numberBasis). 예전 서버는 404 → 부르는 쪽(reconcileBadgeQuery)이 꺼짐으로 본다 */
    reconcileBadge: () => get<ReconcileBadgeBody>("/api/admin/toss/reconcile/badge", 8_000),
  };
}

export type Api = ReturnType<typeof createApi>;
