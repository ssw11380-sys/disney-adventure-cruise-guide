import type { AppErrorSummary, Evaluation,
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
  MarketIndex, MarketStatus,
  Quote,
  RegisteredStock,
  RegisteredWithQuote,
  RunResult,
  StockNews,
  TossImportResult,
  TossOpenApiStatus,
  FeatureFlags,
} from "./types";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(baseUrl: string, token: string, path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}${path}`, {
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
    text = res.status === 204 ? "" : await res.text();
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e as Error).name === "AbortError";
    throw new ApiRequestError(0, aborted ? "TIMEOUT" : "NETWORK", aborted ? "서버 응답이 없습니다 (시간 초과)" : `서버에 연결할 수 없습니다: ${baseUrl}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 아래에서 처리 */
  }
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; message?: string };
    throw new ApiRequestError(
      res.status,
      err.error ?? `HTTP_${res.status}`,
      res.status === 401 ? "API 토큰이 틀리거나 비어 있습니다. 설정 > 서버 주소 아래에 토큰을 입력하세요." : (err.message ?? `서버 오류 (${res.status})`),
    );
  }
  return json as T;
}

/** 백엔드 REST 클라이언트. baseUrl/token 은 설정에서 온다. */
export function createApi(baseUrl: string, token = "") {
  const get = <T>(path: string, timeoutMs?: number) => request<T>(baseUrl, token, path, {}, timeoutMs);
  const send = <T>(method: string, path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(baseUrl, token, path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);

  return {
    baseUrl,
    health: () => get<Health>("/health", 8_000),
    /** 앱 오류 보고 (lib/errorReport). 토큰·금액은 보내기 전에 지운다 */
    reportErrors: (errors: unknown[]) => send<{ saved: number; dropped: number }>("POST", "/api/app-errors", { errors }, 10_000),
    appErrorSummary: (days = 7) => get<AppErrorSummary>(`/api/admin/app-errors?days=${days}`),

    searchStocks: (q: string, limit = 20) => get<{ results: ListedStock[]; source: string }>(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
    /** 종목 마스터만 (외부 검색을 기다리지 않아 바로) — 예전 서버는 local 을 무시하고 전체 결과를 준다 */
    searchStocksLocal: (q: string, limit = 20) => get<{ results: ListedStock[]; source: string }>(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}&local=1`, 5_000),
    // 3초마다 부르는 조회는 응답 없는 망에서 60초씩 묶이지 않게 15초로 끊는다 (서버 첫 호출 최대 약 13초 실측)
    listStocks: () => get<RegisteredWithQuote[]>("/api/stocks?quotes=1", 15_000),
    /** registered: false 면 등록하지 않은 종목의 미리 보기(발견 탭 등). 구버전 서버는 필드 없음(= 등록 종목) */
    getStock: (code: string) =>
      get<RegisteredStock & { registered?: boolean; quote: Quote | null; quoteError: string | null; evaluation?: Evaluation | null }>(`/api/stocks/${code}`, 15_000),
    registerStock: (body: { code: string; quantity?: number | null; avgPrice?: number | null; memo?: string | null }) =>
      send<RegisteredStock>("POST", "/api/stocks", body),
    updateStock: (code: string, body: { quantity?: number | null; avgPrice?: number | null; memo?: string | null }) =>
      send<RegisteredStock>("PATCH", `/api/stocks/${code}`, body),
    removeStock: (code: string) => send<void>("DELETE", `/api/stocks/${code}`),
    getQuote: (code: string, fresh = false) => get<Quote>(`/api/stocks/${code}/quote${fresh ? "?fresh=1" : ""}`),
    getCandles: (code: string, period: CandlePeriod, count: number) => get<CandleSeries>(`/api/stocks/${code}/candles?period=${period}&count=${count}`),
    getAnalysis: (code: string, kind: AnalysisKind, refresh = false) =>
      get<Analysis>(`/api/stocks/${code}/analysis/${kind}${refresh ? "?refresh=1" : ""}`, 180_000),
    getStockNews: (code: string) => get<StockNews>(`/api/stocks/${code}/news`),

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

    registerDevice: (body: { token: string; platform: "android" | "ios" | "unknown"; deviceName?: string | null }) => send<Device>("POST", "/api/devices", body),
    unregisterDevice: (token: string) => send<void>("DELETE", `/api/devices/${encodeURIComponent(token)}`),
    listDevices: () => get<Device[]>("/api/devices"),
    getNotificationSettings: () => get<NotificationSettings>("/api/notifications/settings"),
    /** mute: 종목 하나만 알림 끄기/켜기 (3-19 서버). 목록 전체(mutedCodes)를 보내지 않아 연달아 눌러도 안전 */
    updateNotificationSettings: (patch: NotificationSettingsPatch) => send<NotificationSettings>("PUT", "/api/notifications/settings", patch),
    sendTestNotification: () => send<SendSummary>("POST", "/api/notifications/test"),

    tossStatus: () => get<TossOpenApiStatus>("/api/admin/toss/status", 15_000),
    features: () => get<FeatureFlags>("/api/features", 8_000),
    importTossHoldings: () => send<TossImportResult>("POST", "/api/admin/toss/import-holdings", undefined, 60_000),
    /**
     * 해외 종목 원화 매입금액(토스 앱 원화 보기의 평가금액 − 평가손익)을 정확한 값으로 저장.
     * manual: 저장은 했지만 직접 넣은 수량·평단으로 평가 중이라 다음 토스 동기화 뒤부터 쓰인다 (옛 서버는 보내지 않음)
     */
    setKrwCost: (items: Record<string, number>) =>
      send<{ applied: string[]; skipped: { code: string; reason: "not_held" | "orders_failed" | "unexplained" | "changed" | "manual"; retryAfter?: string }[] }>("PUT", "/api/admin/toss/krw-cost", { items }),
    marketStatus: () => get<MarketStatus>("/api/market/status", 10_000),
    /**
     * stale=1: 출처가 실패한 지수도 마지막 값(stale·fetchedAt)으로 받는다 — 이 앱은 "시세 지연"·실제 받은 시각으로 보여 준다.
     * 서버는 이 표시를 모르는 옛 앱(플래그 없음)에는 실패한 항목을 뺀다. 예전 서버는 플래그를 무시한다
     */
    marketIndices: () => get<{ indices: MarketIndex[] }>("/api/market/indices?stale=1", 10_000),
    /**
     * r=1: 뒤 쪽의 판(v)을 서버가 잃었으면 빈 쪽 + restart 를 받는다 (checkRankPage 가 첫 쪽부터 다시 받는다).
     * 서버는 restart 를 모르는 옛 앱(플래그 없음)에는 지금 목록의 쪽을 준다. 예전 서버도 그렇게 주고, 판이 달라 이 앱이 알아챈다
     */
    discoverRank: (market: DiscoverMarket, category: RankCategory, page = 1, size = 50, ver?: number) =>
      get<DiscoverRank>(`/api/discover/${market}/rank/${category}?page=${page}&size=${size}${ver ? `&v=${ver}` : ""}&r=1`, 15_000),
    discoverThemes: (market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod) => get<ThemeList>(`/api/discover/${market}/themes?kind=${kind}&period=${period}`, 20_000),
    discoverTheme: (market: DiscoverMarket, kind: ThemeKind, id: string) => get<ThemeDetail>(`/api/discover/${market}/themes/${encodeURIComponent(id)}?kind=${kind}`, 20_000),
    marketCandles: (code: string, period: CandlePeriod, count: number) => get<CandleSeries>(`/api/market/indices/${encodeURIComponent(code)}/candles?period=${period}&count=${count}`),
  };
}

export type Api = ReturnType<typeof createApi>;
