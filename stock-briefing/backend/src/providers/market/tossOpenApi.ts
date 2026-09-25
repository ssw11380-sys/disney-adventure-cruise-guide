import { isIntraday, type Candle, type CandlePeriod, type CandleSeries, type ListedStock, type Market, type Quote } from "../../domain/types.js";
import { CODE_RE, isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError, within } from "../../lib/errors.js";
import { mapLimit } from "../../lib/concurrency.js";
import { seoulIso } from "../../lib/time.js";
import type { InvestorFlowDay, InvestorFlowProvider } from "./investorFlow.js";
import type { FetchFn, MasterProvider, QuoteProvider } from "./types.js";

/**
 * 토스증권 공식 Open API (https://developers.tossinvest.com).
 *  - 인증: OAuth 2.0 Client Credentials. 클라이언트당 유효 토큰 1개(재발급 시 이전 토큰 즉시 무효) → 토큰은 이 프로세스가 하나만 들고 쓴다.
 *  - 허용 IP: WTS 설정 > Open API > 허용 IP 관리에 서버의 공인 IP 를 등록해야 한다. 미등록이면 403 edge-blocked.
 *  - 시세: 한국은 KRX+NXT 통합, 미국은 최근 체결(시간외 포함). 현재가 API 는 가격·시각만 주므로 전일 대비는 일봉으로 계산한다.
 *  - 캔들: 1m·1d 만 제공(최대 200개/페이지, before 로 페이지네이션) → 주봉·월봉은 일봉을 묶어 만든다.
 *  - 종목 마스터: 마켓별 전체 종목(한글명 포함) → 로컬 검색에 한국·미국 종목을 모두 넣을 수 있다.
 *  - 수급: 국내 종목 투자자별 매매동향.
 *  - Rate limit 은 그룹별 초당 N회. 429 는 Retry-After 만큼 한 번 기다렸다 재시도.
 * 데이터 이용 정책: 본인 매매 목적에 한함(제3자 배포 금지). 이 앱은 단일 사용자용.
 */

export const TOSS_OPENAPI_BASE = "https://openapi.tossinvest.com";
export const TOSS_OPENAPI_WS = "wss://openapi-ws.tossinvest.com/ws/v1";

export interface TossOpenApiLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info?(obj: Record<string, unknown>, msg: string): void;
}

export interface TossOpenApiClientOptions {
  clientId: string;
  clientSecret: string;
  fetchFn?: FetchFn;
  now?: () => Date;
  log?: TossOpenApiLogger;
  baseUrl?: string;
  /** 429 재시도 대기 상한(ms). 테스트에서 0 */
  maxRetryWaitMs?: number;
}

export interface TossOpenApiStatus {
  configured: boolean;
  tokenIssuedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** 403 edge-blocked 를 받았으면 true (허용 IP 미등록 가능성) */
  ipBlocked: boolean;
}

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 등락: 1달러 미만 미국 종목은 $0.0001 단위로 거래되므로 소수 4자리까지 */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 토큰 발급·갱신과 공통 요청 처리 */
export class TossOpenApiClient {
  readonly name = "toss-openapi";
  private readonly fetchFn: FetchFn;
  private readonly now: () => Date;
  private readonly log: TossOpenApiLogger;
  private readonly baseUrl: string;
  private readonly maxRetryWaitMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  readonly status: TossOpenApiStatus;

  constructor(private readonly opts: TossOpenApiClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? { warn: () => {} };
    this.baseUrl = opts.baseUrl ?? TOSS_OPENAPI_BASE;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 3000;
    this.status = { configured: Boolean(opts.clientId && opts.clientSecret), tokenIssuedAt: null, lastOkAt: null, lastError: null, ipBlocked: false };
  }

  /** 유효한 액세스 토큰. 만료 5분 전부터 재발급. 동시 호출은 한 번만 발급한다. */
  async getToken(force = false): Promise<string> {
    const t = this.now().getTime();
    if (!force && this.token && this.token.expiresAt - t > 5 * 60_000) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = this.issueToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  private async issueToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
      });
    } catch (e) {
      throw this.fail(new ProviderError(this.name, "토큰 발급 네트워크 오류", e));
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      if (res.status === 403) this.status.ipBlocked = true;
      const desc = String(json["error_description"] ?? (json["error"] as Json | undefined)?.["message"] ?? json["error"] ?? "");
      throw this.fail(new ProviderError(this.name, `토큰 발급 실패 HTTP ${res.status}${desc ? `: ${desc}` : ""}${res.status === 403 ? " (허용 IP 미등록일 수 있음)" : ""}`));
    }
    const value = String(json["access_token"] ?? "");
    if (!value) throw this.fail(new ProviderError(this.name, "토큰 응답에 access_token 이 없습니다"));
    const expiresIn = num(json["expires_in"]) ?? 3600;
    this.token = { value, expiresAt: this.now().getTime() + expiresIn * 1000 };
    this.status.tokenIssuedAt = seoulIso(this.now());
    this.status.ipBlocked = false;
    this.log.info?.({ expiresIn }, "토스증권 Open API 토큰 발급");
    return value;
  }

  private fail(e: ProviderError): ProviderError {
    this.status.lastError = e.message;
    return e;
  }

  /** GET /api/v1/... 공통. 401 이면 토큰 재발급 후 1회, 429 면 Retry-After 만큼 기다린 뒤 1회 재시도 */
  async get<T = unknown>(path: string, params: Record<string, string | number | boolean | undefined> = {}, extraHeaders: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs.toString()}` : ""}`;
    let refreshed = false;
    let waited = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await this.getToken(refreshed);
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...extraHeaders } });
      } catch (e) {
        throw this.fail(new ProviderError(this.name, `네트워크 오류: ${path}`, e));
      }
      if (res.ok) {
        this.status.lastOkAt = seoulIso(this.now());
        this.status.lastError = null;
        this.status.ipBlocked = false;
        const json = (await res.json()) as Json;
        return json["result"] as T;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      const code = json.error?.code ?? "";
      const message = json.error?.message ?? "";
      if (res.status === 401 && !refreshed) {
        refreshed = true; // expired-token / token-revoked / invalid-token → 새 토큰으로 한 번 더
        continue;
      }
      if (res.status === 429 && !waited) {
        waited = true;
        const retryAfter = num(res.headers.get("retry-after")) ?? 1;
        await sleep(Math.min(retryAfter * 1000, this.maxRetryWaitMs));
        continue;
      }
      if (res.status === 403) this.status.ipBlocked = true;
      throw this.fail(
        new ProviderError(
          this.name,
          `HTTP ${res.status} ${code}${message ? `: ${message}` : ""} (${path})${res.status === 403 ? " — 서버 IP 가 토스증권 허용 IP 목록에 없을 수 있습니다" : ""}`,
        ),
      );
    }
    throw this.fail(new ProviderError(this.name, `재시도 초과: ${path}`));
  }
}

const TOSS_MARKETS: Record<string, Market> = { KOSPI: "KOSPI", KOSDAQ: "KOSDAQ", NYSE: "NYSE", NASDAQ: "NASDAQ", AMEX: "AMEX", KR_ETC: "UNKNOWN", US_ETC: "US" };
const ETF_TYPES = new Set(["ETF", "FOREIGN_ETF", "ETN"]);

interface TossCandle {
  timestamp?: string;
  openPrice?: string;
  highPrice?: string;
  lowPrice?: string;
  closePrice?: string;
  volume?: string;
}

interface TossStockInfo {
  symbol?: string;
  name?: string;
  englishName?: string;
  isinCode?: string;
  market?: string;
  securityType?: string;
  status?: string;
  currency?: string;
  sharesOutstanding?: string;
}

/** 거래소 현지 날짜(YYYY-MM-DD). 한국은 KST, 미국은 뉴욕 */
export function localDate(iso: string, kr: boolean): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: kr ? "Asia/Seoul" : "America/New_York" }).format(new Date(iso));
}

/** ISO 시각을 현지(서울/뉴욕) 오프셋이 붙은 ISO 로 (예: 2026-09-23T10:25:00+09:00) */
export function localIso(iso: string, kr: boolean): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: kr ? "Asia/Seoul" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "longOffset",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const off = get("timeZoneName").replace("GMT", "") || "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${off === "" ? "Z" : off}`;
}

/** 1분봉(오래된 순) → 5분/30분봉. 봉의 time 은 그 구간의 시작 시각(현지 기준으로 step 분 단위 절삭) */
export function aggregateIntraday(minutes: Candle[], stepMin: number): Candle[] {
  if (stepMin <= 1) return minutes;
  const out: Candle[] = [];
  let key = "";
  for (const c of minutes) {
    if (!c.time) continue;
    const m = c.time.slice(0, 16); // YYYY-MM-DDTHH:MM (현지)
    const minute = Number(m.slice(14, 16));
    const bucketMin = Math.floor(minute / stepMin) * stepMin;
    const k = `${m.slice(0, 14)}${String(bucketMin).padStart(2, "0")}`;
    const last = out.at(-1);
    if (k !== key || !last) {
      key = k;
      out.push({ ...c, time: `${k}:00${c.time.slice(19)}` });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

export function toCandle(c: TossCandle, kr: boolean, intraday = false): Candle | null {
  const ts = c.timestamp ?? "";
  const o = num(c.openPrice), h = num(c.highPrice), l = num(c.lowPrice), cl = num(c.closePrice);
  if (!ts || o === null || h === null || l === null || cl === null) return null;
  if (intraday) return { date: localDate(ts, kr), time: localIso(ts, kr), open: o, high: h, low: l, close: cl, volume: num(c.volume) ?? 0 };
  // 1d 봉의 timestamp 는 현지 자정 고정이라 앞 10자리가 곧 거래일이다. 형식이 달라도 현지 날짜로 환산해 둔다.
  const date = /^\d{4}-\d{2}-\d{2}T00:00:00/.test(ts) ? ts.slice(0, 10) : localDate(ts, kr);
  return { date, open: o, high: h, low: l, close: cl, volume: num(c.volume) ?? 0 };
}

/** 일봉(오래된 순) → 주봉/월봉. 주는 월요일 시작, 봉의 date 는 그 기간의 첫 거래일 */
export function aggregateCandles(daily: Candle[], period: CandlePeriod): Candle[] {
  if (period === "D") return daily;
  const keyOf = (date: string): string => {
    if (period === "M") return date.slice(0, 7);
    const d = new Date(`${date}T00:00:00Z`);
    const day = (d.getUTCDay() + 6) % 7; // 월=0
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  };
  const out: Candle[] = [];
  let key = "";
  for (const c of daily) {
    const k = keyOf(c.date);
    const last = out.at(-1);
    if (k !== key || !last) {
      key = k;
      out.push({ ...c });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

/** 한국 종목 기준가(krBase)를 기다리는 최대 시간 */
const KR_BASE_WAIT_MS = 1_500;
/** 시세용 일봉 개수 (52주 고저) */
const QUOTE_DAILY = 260;
/** 같은 거래일 안에서 최근 봉(오늘 시고저·거래량, 새로 열린 거래일 봉)만 다시 받는 간격 — 예전 시세 캐시와 같은 1분 */
const TODAY_REFRESH_MS = 60_000;
/** 일봉을 동시에 받는 종목 수 (그룹별 초당 호출 제한) */
const DAILY_CONCURRENCY = 4;
/** 현재가 일괄 조회 한 번에 넣는 종목 수 */
const PRICES_CHUNK = 50;

export interface TossOpenApiProviderOptions {
  now?: () => Date;
  /**
   * 한국 종목의 기준가(토스 앱·네이버가 등락을 재는 전일 종가, 토스 웹 시세의 base). 주면 전일 종가로 이 값을 쓴다 —
   * 공식 API 일봉 종가는 NXT 애프터마켓까지 포함한 통합 종가라 NXT 종목의 등락이 토스 앱과 달라진다 (삼성전자 +3.24% vs +3.62%)
   */
  krBase?: (code: string) => Promise<number | null>;
  /** 여러 종목 기준가를 한 번에 (토스 웹 일괄 시세 1회). 없으면 krBase 를 종목마다 */
  krBaseMany?: (codes: string[]) => Promise<Map<string, number>>;
}

export class TossOpenApiProvider implements QuoteProvider, InvestorFlowProvider, MasterProvider {
  readonly name = "toss-openapi";
  private readonly now: () => Date;
  private readonly infoCache = new Map<string, { at: number; info: TossStockInfo }>();
  private fxCache: { at: number; rate: number } | null = null;
  /** 시세용 일봉: 과거 봉은 거래일(현지 날짜)마다 한 번, 같은 날에는 1분마다 최근 3개만 받아 끝을 갈아 끼운다 */
  private readonly dailyBook = new Map<string, { day: string; candles: Candle[]; at: number }>();
  private readonly dailyInflight = new Map<string, Promise<Candle[]>>();
  /** 기준가를 못 받아 일봉 종가로 등락을 계산한 횟수 (운영 확인용) */
  baseFallbacks = 0;

  constructor(
    readonly client: TossOpenApiClient,
    private readonly opts: TossOpenApiProviderOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  // ── 종목 정보 ────────────────────────────────────────────────────

  async stockInfos(symbols: string[]): Promise<Map<string, TossStockInfo>> {
    const out = new Map<string, TossStockInfo>();
    const t = this.now().getTime();
    const need: string[] = [];
    for (const s of symbols) {
      const hit = this.infoCache.get(s);
      if (hit && t - hit.at < 24 * 3_600_000) out.set(s, hit.info);
      else need.push(s);
    }
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200);
      const rows = (await this.client.get<TossStockInfo[]>("/api/v1/stocks", { symbols: chunk.join(",") })) ?? [];
      for (const r of rows) {
        const sym = String(r.symbol ?? "").toUpperCase();
        if (!sym) continue;
        this.infoCache.set(sym, { at: t, info: r });
        out.set(sym, r);
      }
    }
    return out;
  }

  /** USD → KRW 매매기준율 (1분 캐시). 실패하면 null */
  async usdKrw(): Promise<number | null> {
    const t = this.now().getTime();
    if (this.fxCache && t - this.fxCache.at < 60_000) return this.fxCache.rate;
    try {
      const r = await this.client.get<Json>("/api/v1/exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" });
      const rate = num(r?.["midRate"]) ?? num(r?.["rate"]);
      if (rate === null) return null;
      this.fxCache = { at: t, rate };
      return rate;
    } catch {
      return null;
    }
  }

  // ── 캔들 ────────────────────────────────────────────────────────

  /** 일봉을 최신순 페이지로 받아 오래된 순으로 돌려준다 */
  private async dailyCandles(code: string, count: number): Promise<Candle[]> {
    const kr = isKrCode(code);
    const acc: Candle[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 14 && acc.length < count; page++) {
      // before 는 inclusive 라 페이지 경계의 봉이 한 번 더 올 수 있다 → 한 개 더 청하고 날짜로 중복 제거
      const r = await this.client.get<{ candles?: TossCandle[]; nextBefore?: string | null }>("/api/v1/candles", {
        symbol: code,
        interval: "1d",
        count: Math.min(200, count - acc.length + (page > 0 ? 1 : 0)),
        before,
        adjusted: true,
      });
      const rows = r?.candles ?? [];
      for (const c of rows) {
        const candle = toCandle(c, kr);
        if (candle && !seen.has(candle.date)) {
          seen.add(candle.date);
          acc.push(candle);
        }
      }
      if (!r?.nextBefore || rows.length === 0) break;
      before = r.nextBefore;
    }
    acc.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return acc;
  }

  /** 1분봉을 최신순 페이지로 받아 오래된 순으로 (분봉은 하루 390개 안팎) */
  private async minuteCandles(code: string, count: number): Promise<Candle[]> {
    const kr = isKrCode(code);
    const acc: Candle[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 10 && acc.length < count; page++) {
      const r = await this.client.get<{ candles?: TossCandle[]; nextBefore?: string | null }>("/api/v1/candles", {
        symbol: code,
        interval: "1m",
        count: Math.min(200, count - acc.length + (page > 0 ? 1 : 0)),
        before,
        adjusted: true,
      });
      const rows = r?.candles ?? [];
      for (const c of rows) {
        const candle = toCandle(c, kr, true);
        if (candle?.time && !seen.has(candle.time)) {
          seen.add(candle.time);
          acc.push(candle);
        }
      }
      if (!r?.nextBefore || rows.length === 0) break;
      before = r.nextBefore;
    }
    acc.sort((a, b) => Date.parse(a.time!) - Date.parse(b.time!));
    return acc;
  }

  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    code = normalizeCode(code);
    if (isIntraday(period)) {
      // 30분봉은 1분봉 9,000개(45페이지)가 필요해 여기서는 만들지 않는다 → 체인이 토스 웹(min:30, 요청 1개)으로 넘어간다
      if (period === "30m") throw new ProviderError(this.name, "30분봉은 1분봉 집계 비용이 커서 웹 차트 소스로 넘깁니다");
      const step = period === "1m" ? 1 : 5;
      const minutes = await this.minuteCandles(code, Math.min(count * step, 2000));
      if (minutes.length === 0) throw new ProviderError(this.name, `${code} 분봉 데이터 없음`);
      return { code, period, candles: aggregateIntraday(minutes, step).slice(-count), source: this.name };
    }
    const dailyNeeded = period === "D" ? count : period === "W" ? count * 5 + 10 : count * 22 + 10;
    // 월봉 120개 = 일봉 약 2,650개 (200개씩 14쪽). 예전 상한 1,600 이면 79개만 나왔다 (3-18)
    const daily = await this.dailyCandles(code, Math.min(dailyNeeded, 2700));
    if (daily.length === 0) throw new ProviderError(this.name, `${code} 봉 데이터 없음`);
    return { code, period, candles: aggregateCandles(daily, period).slice(-count), source: this.name };
  }

  // ── 현재가 ──────────────────────────────────────────────────────

  /** 시세용 일봉 (캐시). 새로 받지 못하면 전에 받은 것을 그대로 쓴다 */
  private quoteDaily(code: string): Promise<Candle[]> {
    const kr = isKrCode(code);
    const t = this.now().getTime();
    const day = localDate(new Date(t).toISOString(), kr);
    const hit = this.dailyBook.get(code);
    if (hit && hit.day === day && t - hit.at < TODAY_REFRESH_MS) return Promise.resolve(hit.candles);
    const running = this.dailyInflight.get(code);
    if (running) return running;
    const p = (async () => {
      let candles: Candle[];
      if (hit && hit.day === day) {
        // 같은 거래일: 최근 봉 몇 개만 다시 받아 끝을 갈아 끼운다 (요청 1개)
        const recent = await this.dailyCandles(code, 3);
        const from = recent[0]?.date;
        candles = from ? [...hit.candles.filter((c) => c.date < from), ...recent].slice(-QUOTE_DAILY) : hit.candles;
      } else {
        candles = await this.dailyCandles(code, QUOTE_DAILY);
      }
      this.dailyBook.set(code, { day, candles, at: t });
      return candles;
    })()
      .catch((e: unknown) => {
        if (hit) return hit.candles;
        throw e;
      })
      .finally(() => this.dailyInflight.delete(code));
    this.dailyInflight.set(code, p);
    return p;
  }

  /** 현재가 일괄 조회 (/prices 는 symbols 를 콤마로 여러 개 받는다) */
  private async pricesMany(codes: string[]): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    for (let i = 0; i < codes.length; i += PRICES_CHUNK) {
      const chunk = codes.slice(i, i + PRICES_CHUNK);
      let rows: Json[];
      try {
        rows = (await this.client.get<Json[]>("/api/v1/prices", { symbols: chunk.join(",") })) ?? [];
      } catch (e) {
        // 모르는·상장폐지 종목 하나 때문에 묶음 전체가 4xx 로 거절되면 종목마다 다시 물어 나머지는 살린다
        if (chunk.length === 1 || !(e instanceof ProviderError) || !/HTTP 4(00|04|22)/.test(e.message)) throw e;
        const single = await mapLimit(chunk, DAILY_CONCURRENCY, (c) => this.client.get<Json[]>("/api/v1/prices", { symbols: c }).then((r) => (r ?? []).map((x) => ({ ...x, symbol: x["symbol"] ?? c })), () => [] as Json[]));
        rows = single.flat();
      }
      for (const r of rows) {
        const sym = String(r["symbol"] ?? "").toUpperCase();
        if (sym) out.set(sym, r);
      }
      // 한 종목만 물었는데 심볼 표기가 다르게 오면(대소문자 등) 그 한 줄을 쓴다
      if (chunk.length === 1 && !out.has(chunk[0]!) && rows[0]) out.set(chunk[0]!, rows[0]);
    }
    return out;
  }

  private async krBases(codes: string[]): Promise<Map<string, number>> {
    if (codes.length === 0) return new Map();
    const { krBase, krBaseMany } = this.opts;
    if (krBaseMany) return within(krBaseMany(codes), KR_BASE_WAIT_MS, new Map<string, number>());
    if (!krBase) return new Map();
    // 기준가는 짧게만 기다린다 — 토스 웹이 느리거나 멈추면 일봉으로 (공식 API 시세까지 붙잡지 않게)
    const vals = await Promise.all(codes.map((c) => within(krBase(c), KR_BASE_WAIT_MS, null)));
    return new Map(codes.flatMap((c, i) => (vals[i] && vals[i]! > 0 ? [[c, vals[i]!] as [string, number]] : [])));
  }

  async getQuote(code: string): Promise<Quote> {
    code = normalizeCode(code);
    const r = (await this.getQuotes([code])).get(code);
    if (!r) throw new ProviderError(this.name, `${code} 시세 없음`);
    if (r instanceof Error) throw r;
    return r;
  }

  /**
   * 여러 종목 현재가: 현재가 1회(일괄) + 종목 정보(하루 캐시) + 기준가 1회(일괄) + 일봉(거래일 캐시).
   * 현재가 일괄 조회가 실패하면 던진다(체인이 다음 소스로). 종목별 실패는 Error 로 담는다
   */
  async getQuotes(codes: string[]): Promise<Map<string, Quote | Error>> {
    const list = [...new Set(codes.map(normalizeCode))];
    const out = new Map<string, Quote | Error>();
    if (list.length === 0) return out;
    const [prices, infos, bases, fx, dailies] = await Promise.all([
      this.pricesMany(list),
      this.stockInfos(list).catch(() => new Map<string, TossStockInfo>()),
      this.krBases(list.filter(isKrCode)),
      list.some((c) => !isKrCode(c)) ? this.usdKrw() : Promise.resolve(null),
      mapLimit(list, DAILY_CONCURRENCY, (c) =>
        this.quoteDaily(c).then(
          (d) => ({ d, e: null as unknown }),
          (e: unknown) => ({ d: [] as Candle[], e }),
        ),
      ),
    ]);
    let fallbacks = 0;
    list.forEach((code, i) => {
      try {
        const q = this.buildQuote(code, prices.get(code), dailies[i]!.d, dailies[i]!.e, infos.get(code), bases.get(code) ?? null, fx);
        if (q.prevCloseBasis === "candle") fallbacks++;
        out.set(code, q);
      } catch (e) {
        out.set(code, e instanceof Error ? e : new ProviderError(this.name, String(e)));
      }
    });
    this.baseFallbacks += fallbacks;
    return out;
  }

  private buildQuote(code: string, p: Json | undefined, daily: Candle[], dailyError: unknown, info: TossStockInfo | undefined, krBase: number | null, fx: number | null): Quote {
    const kr = isKrCode(code);
    if (!p) throw new ProviderError(this.name, `${code} 시세 없음`);
    const latest = daily.at(-1) ?? null;
    const price = num(p["lastPrice"]) ?? latest?.close ?? null;
    if (price === null) throw new ProviderError(this.name, `${code} 현재가 없음`);
    const ts = typeof p["timestamp"] === "string" ? p["timestamp"] : null;
    const priceDate = ts ? localDate(ts, kr) : latest?.date ?? "";
    // 오늘 봉이 있으면 전일은 그 앞 봉, 없으면(장 시작 전 등) 마지막 봉이 전일.
    // 미국 데이마켓(한국 낮 시간)에는 토스가 다음 거래일 봉을 먼저 열어 두므로, 체결 날짜(뉴욕 기준 전날 밤)보다
    // 마지막 봉 날짜가 뒤일 수 있다 → 그 봉을 오늘 봉으로 보고 직전 정규장 종가와 비교한다.
    const today = latest && latest.date >= priceDate ? latest : null;
    const prev = today ? daily.at(-2) ?? null : latest;
    const useBase = krBase !== null && krBase > 0;
    const prevClose = useBase ? krBase : (prev?.close ?? null);
    // 전일 종가를 모르면(상장 첫날이라 일봉이 오늘 것뿐, 또는 일봉을 못 받음) 등락을 0 으로 만들지 않고
    // 다음 소스(기준가를 주는 토스 웹)로 넘긴다 — 상장 첫날 +280% 종목이 "0 · 0.00%"로 보이지 않게
    if (prevClose === null)
      throw new ProviderError(this.name, dailyError ? `${code} 일봉을 받지 못해 전일 종가를 모름` : `${code} 전일 종가 없음 (상장 첫날)`, dailyError ?? undefined);
    // 등락률은 반올림 전 차이로 — 센트로 반올림한 등락으로 내면 $0.0500 → $0.0537 이 0.00% 가 된다 (+7.40%)
    const change = round4(price - prevClose);
    const changeRate = prevClose ? round2(((price - prevClose) / prevClose) * 100) : 0;
    const currency = String(p["currency"] ?? (kr ? "KRW" : "USD")) === "USD" ? "USD" : "KRW";
    const shares = num(info?.sharesOutstanding);
    const yearAgo = new Date(this.now().getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
    const year = daily.filter((c) => c.date >= yearAgo);
    const rate = currency === "USD" ? fx : null;
    return {
      code,
      currency,
      price,
      change,
      changeRate,
      open: today?.open ?? null,
      // 오늘 봉은 최대 1분 전 것이라 현재가가 그 고가·저가를 넘었을 수 있다
      high: today ? Math.max(today.high, price) : null,
      low: today ? Math.min(today.low, price) : null,
      prevClose,
      volume: today?.volume ?? null,
      marketCap: shares !== null ? Math.round(price * shares) : null,
      per: null,
      pbr: null,
      eps: null,
      bps: null,
      high52w: year.length ? Math.max(...year.map((c) => c.high)) : null,
      low52w: year.length ? Math.min(...year.map((c) => c.low)) : null,
      asOf: ts ?? seoulIso(this.now()),
      source: this.name,
      priceBasis: kr ? "KRX+NXT 통합" : "최근 체결(시간외 포함)",
      priceKrw: rate !== null ? Math.round(price * rate) : null,
      afterMarket: null,
      ...(kr ? { prevCloseBasis: useBase ? ("base" as const) : ("candle" as const) } : {}),
    };
  }

  // ── 수급 ────────────────────────────────────────────────────────

  async getInvestorFlow(code: string, days: number): Promise<InvestorFlowDay[]> {
    code = normalizeCode(code);
    if (!isKrCode(code)) throw new ProviderError(this.name, `수급은 국내 종목만 지원합니다: ${code}`);
    const [r, daily] = await Promise.all([
      this.client.get<{ records?: Json[] }>(`/api/v1/stocks/${encodeURIComponent(code)}/investor-trading`, { count: Math.min(days, 100) }),
      this.dailyCandles(code, days + 5).catch(() => [] as Candle[]),
    ]);
    const closeByDate = new Map(daily.map((c) => [c.date, c.close]));
    const net = (o: unknown): number | null => num((o as Json | null | undefined)?.["netBuyVolume"]);
    return (r?.records ?? [])
      .map((rec) => ({
        date: String(rec["date"] ?? ""),
        close: closeByDate.get(String(rec["date"] ?? "")) ?? null,
        individual: net(rec["individual"]),
        foreign: net(rec["foreigner"]),
        institution: net(rec["institution"]),
      }))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
      .slice(0, days);
  }

  // ── 종목 마스터 ──────────────────────────────────────────────────

  /** 마켓별 전체 종목(한글명 포함). STOCK_ALL 은 초당 1회라 순차 호출 */
  async fetchAll(): Promise<ListedStock[]> {
    const markets: Array<keyof typeof TOSS_MARKETS> = ["KOSPI", "KOSDAQ", "NYSE", "NASDAQ", "AMEX"];
    const out: ListedStock[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < markets.length; i++) {
      if (i > 0) await sleep(1100);
      const m = markets[i]!;
      const rows = (await this.client.get<Json[]>("/api/v1/stocks/all", { market: m, status: "ACTIVE" })) ?? [];
      for (const r of rows) {
        const code = String(r["symbol"] ?? "").toUpperCase();
        if (!CODE_RE.test(code) || seen.has(code)) continue;
        if (isKrCode(code) !== (m === "KOSPI" || m === "KOSDAQ")) continue;
        seen.add(code);
        out.push({
          code,
          name: String(r["name"] ?? code),
          market: TOSS_MARKETS[m]!,
          isinCode: typeof r["isinCode"] === "string" ? r["isinCode"] : null,
          groupCode: ETF_TYPES.has(String(r["securityType"] ?? "")) ? "EF" : "ST",
        });
      }
    }
    if (out.length === 0) throw new ProviderError(this.name, "종목 마스터가 비어 있습니다");
    return out;
  }

  // ── 계좌·보유 ────────────────────────────────────────────────────

  async accounts(): Promise<Array<{ accountNo: string; accountSeq: number; accountType: string }>> {
    const rows = (await this.client.get<Json[]>("/api/v1/accounts")) ?? [];
    return rows.map((r) => ({ accountNo: String(r["accountNo"] ?? ""), accountSeq: Number(r["accountSeq"]), accountType: String(r["accountType"] ?? "") }));
  }

  /**
   * 보유 종목과 계좌 요약을 한 번의 호출로 (요약과 종목이 같은 시점이어야 원화 장부 보정이 맞는다).
   * 요약의 rateAfterCost 는 토스 내부 원화 매입금액(매수 당시 환율) 기준이다 — 문서 설명과 달리 실측으로 확인
   * (계좌 합계 원화 매입금액이 토스 앱 값과 238원 차이, 현재 환율 기준이었다면 약 290만 원 차이).
   */
  async holdingsWithOverview(accountSeq: number): Promise<{
    items: TossHolding[];
    overview: { purchaseKrw: number; purchaseUsd: number | null; afterCostKrw: number; afterCostUsd: number; rateAfterCost: number | null };
  }> {
    const r = await this.client.get<Json>("/api/v1/holdings", {}, { "X-Tossinvest-Account": String(accountSeq) });
    // 본문이 빈 200 은 일시 오류로 본다 (빈 목록으로 받아들이면 전량 매도로 처리돼 보유·원화 장부가 지워진다)
    if (!r || !Array.isArray(r["items"])) throw new ProviderError(this.name, "보유 종목 응답이 비었습니다 (/api/v1/holdings)");
    const purchase = (r["totalPurchaseAmount"] as Json | undefined) ?? null;
    const after = (((r["marketValue"] as Json | undefined) ?? {})["amountAfterCost"] as Json | undefined) ?? null;
    const rate = num(((r["profitLoss"] as Json | undefined) ?? {})["rateAfterCost"]);
    return {
      items: parseHoldingItems(r["items"] as Json[]),
      overview: {
        purchaseKrw: num(purchase?.["krw"]) ?? 0,
        // 모르면 null (0 이면 "달러 종목 없음"으로 읽혀 원화 장부가 지워진다)
        purchaseUsd: num(purchase?.["usd"]),
        afterCostKrw: num(after?.["krw"]) ?? 0,
        afterCostUsd: num(after?.["usd"]) ?? 0,
        // 요약 값이 빠졌으면 계좌 합계 보정을 하지 않는다
        rateAfterCost: purchase && after ? rate : null,
      },
    };
  }

  /**
   * 원화 장부용 체결 목록: 종료된 주문(CLOSED, 100건씩 페이지) + 진행 중이지만 일부 체결된 주문(OPEN).
   * 주문 하나 = 한 줄이고 부분 체결은 누적 수량·금액으로 온다 → 장부는 orderId 별로 이미 반영한 양을 기억해 차이만 반영한다.
   * 네트워크·한도 오류는 그대로 던진다(장부를 건드리지 않고 다음 동기화에서 다시).
   */
  async ordersForBook(accountSeq: number, symbol: string): Promise<Array<{ orderId: string; side: "BUY" | "SELL"; quantity: number; amount: number; at: string }>> {
    const out: Array<{ orderId: string; side: "BUY" | "SELL"; quantity: number; amount: number; at: string }> = [];
    const take = (orders: Json[] | undefined) => {
      for (const o of orders ?? []) {
        const ex = (o["execution"] as Json | undefined) ?? {};
        const q = num(ex["filledQuantity"]) ?? 0;
        const amount = num(ex["filledAmount"]);
        const at = typeof ex["filledAt"] === "string" ? ex["filledAt"] : typeof o["orderedAt"] === "string" ? o["orderedAt"] : null;
        const side = o["side"] === "SELL" ? "SELL" : o["side"] === "BUY" ? "BUY" : null;
        const id = typeof o["orderId"] === "string" ? o["orderId"] : null;
        if (q > 0 && amount !== null && at && side && id) out.push({ orderId: id, side, quantity: q, amount, at });
      }
    };
    const headers = { "X-Tossinvest-Account": String(accountSeq) };
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.client.get<{ orders?: Json[]; nextCursor?: string | null; hasNext?: boolean }>("/api/v1/orders", { status: "CLOSED", symbol, limit: 100, cursor }, headers);
      take(r?.orders);
      if (!r?.hasNext || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    const open = await this.client.get<{ orders?: Json[] }>("/api/v1/orders", { status: "OPEN", symbol }, headers);
    take(open?.orders);
    return out;
  }

  /**
   * 과거 시점의 토스 매수 환율 (USD→KRW). 오류는 던진다(원화 장부가 실패와 "데이터 없음"을 구분해야 한다).
   * 그 분의 환율이 없으면(404 exchange-rate-not-found) 조금 앞 시각(체결 직전 유효 환율)들로 한 번씩 더 찾는다.
   */
  async usdKrwAt(iso: string): Promise<number> {
    const at = Date.parse(iso);
    const backMinutes = Number.isFinite(at) ? [0, 1, 5, 30, 120, 1440] : [0];
    let last: unknown = null;
    for (const [i, m] of backMinutes.entries()) {
      if (i > 0) await sleep(350); // MARKET_INFO 초당 3회
      const dateTime = m === 0 ? iso : seoulIso(new Date(at - m * 60_000));
      try {
        const r = await this.client.get<Json>("/api/v1/exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW", dateTime });
        const rate = num(r?.["rate"]) ?? num(r?.["midRate"]);
        if (rate !== null) return rate;
        last = new ProviderError(this.name, `환율 없음 (${dateTime})`);
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.message.includes("exchange-rate-not-found")) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new ProviderError(this.name, `환율 없음 (${iso})`);
  }

  /** 진단용: 보유 종목 원본 응답 (필드 구성 확인) */
  async holdingsRaw(accountSeq: number): Promise<unknown> {
    return this.client.get<unknown>("/api/v1/holdings", {}, { "X-Tossinvest-Account": String(accountSeq) });
  }

  async holdings(accountSeq: number): Promise<TossHolding[]> {
    const r = await this.client.get<{ items?: Json[] }>("/api/v1/holdings", {}, { "X-Tossinvest-Account": String(accountSeq) });
    return parseHoldingItems(r?.items ?? []);
  }
}

function parseHoldingItems(items: Json[]): TossHolding[] {
  return items
    .map((it) => ({
      code: String(it["symbol"] ?? "").toUpperCase(),
      name: String(it["name"] ?? ""),
      currency: String(it["currency"] ?? "") === "USD" ? ("USD" as const) : ("KRW" as const),
      quantity: num(it["quantity"]) ?? 0,
      avgPrice: num(it["averagePurchasePrice"]),
      lastPrice: num(it["lastPrice"]),
      purchaseAmount: num((it["marketValue"] as Json | undefined)?.["purchaseAmount"]),
      marketValue: num((it["marketValue"] as Json | undefined)?.["amount"]),
      marketValueAfterCost: num((it["marketValue"] as Json | undefined)?.["amountAfterCost"]),
    }))
    .filter((h) => CODE_RE.test(h.code) && h.quantity > 0);
}

export interface TossHolding {
  code: string;
  name: string;
  currency: "KRW" | "USD";
  quantity: number;
  avgPrice: number | null;
  lastPrice: number | null;
  /** 매입금액 (종목 통화). 토스 앱의 "매입금액" */
  purchaseAmount?: number | null;
  /** 평가금액 (수수료·세금 차감 전 / 후, 종목 통화) */
  marketValue?: number | null;
  marketValueAfterCost?: number | null;
}
