import type {
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
  SendSummary,
  LatestBriefing,
  ListedStock,
  Quote,
  RegisteredStock,
  RegisteredWithQuote,
  RunResult,
  StockNews,
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
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    throw new ApiRequestError(0, aborted ? "TIMEOUT" : "NETWORK", aborted ? "서버 응답이 없습니다 (시간 초과)" : `서버에 연결할 수 없습니다: ${baseUrl}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
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

    searchStocks: (q: string, limit = 20) => get<{ results: ListedStock[]; source: string }>(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
    listStocks: () => get<RegisteredWithQuote[]>("/api/stocks?quotes=1"),
    getStock: (code: string) => get<RegisteredStock & { quote: Quote | null; quoteError: string | null }>(`/api/stocks/${code}`),
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
    updateNotificationSettings: (patch: Partial<Omit<NotificationSettings, "schedule">>) => send<NotificationSettings>("PUT", "/api/notifications/settings", patch),
    sendTestNotification: () => send<SendSummary>("POST", "/api/notifications/test"),
  };
}

export type Api = ReturnType<typeof createApi>;
