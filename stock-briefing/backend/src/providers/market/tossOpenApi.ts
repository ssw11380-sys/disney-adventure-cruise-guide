import { isIntraday, type Candle, type CandlePeriod, type CandleSeries, type ListedStock, type Market, type Quote } from "../../domain/types.js";
import { CODE_RE, isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError, within } from "../../lib/errors.js";
import { mapLimit } from "../../lib/concurrency.js";
import { seoulIso } from "../../lib/time.js";
import { truncPct } from "../../lib/pct.js";
import { truncUsdPrice } from "../../lib/usdPrice.js";
import { parseTossAccountTotals, type TossAccountTotals } from "../../services/tossAccountSnapshot.js";
import type { ProductFacts } from "../../analysis/leveraged.js";
import type { InvestorFlowDay, InvestorFlowProvider } from "./investorFlow.js";
import type { LiveTick, QuickPriceSource, StockSessionFacts } from "./tossRealtime.js";
import { rateGroupOf, RequestPacer, type PacerOptions, type PaceStat, type RateGroup } from "./tossRateLimit.js";
import type { FetchFn, MasterProvider, QuoteProvider } from "./types.js";

/**
 * 토스증권 공식 Open API (https://developers.tossinvest.com).
 *  - 인증: OAuth 2.0 Client Credentials. 클라이언트당 유효 토큰 1개(재발급 시 이전 토큰 즉시 무효) → 토큰은 이 프로세스가 하나만 들고 쓴다.
 *  - 허용 IP: WTS 설정 > Open API > 허용 IP 관리에 서버의 공인 IP 를 등록해야 한다. 미등록이면 403 edge-blocked.
 *  - 시세: 한국은 KRX+NXT 통합, 미국은 최근 체결(시간외 포함). 현재가 API 는 가격·시각만 주므로 전일 대비는 일봉으로 계산한다.
 *  - 캔들: 1m·1d 만 제공(최대 200개/페이지, before 로 페이지네이션) → 주봉·월봉은 일봉을, 5분봉·30분봉은 1분봉을 묶어 만든다 (30분봉은 종목마다 받아 두고 이어 붙인다).
 *  - 종목 정보: 종목 유형·레버리지 배수·우선주·정리매매·NXT 대상·거래정지 → 상품 정보(productFacts)·세션 자격.
 *  - 종목 마스터: 마켓별 전체 종목(한글명 포함) → 로컬 검색에 한국·미국 종목을 모두 넣을 수 있다.
 *  - 수급: 국내 종목 투자자별 매매동향 (브리핑 수집기 getInvestorFlow · 수급 탭은 tossOpenApiTrend.ts).
 *  - 섹터(토스 테마 분류): tossSectors.ts.
 *  - Rate limit 은 그룹별 초당 N회 — 보내기 전에 그룹마다 줄을 세운다(tossRateLimit.ts). 그래도 429 를 받으면 Retry-After 만큼 한 번 기다렸다 재시도.
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
  /** 요청 하나(응답 본문 읽기까지)의 제한 시간(ms). 기본 REQUEST_TIMEOUT_MS */
  timeoutMs?: number;
  /**
   * 요청 한도 지키기 (그룹별 속도 조절 — tossRateLimit.ts). 기본 켜짐. false 면 줄 세우지 않고 바로 보낸다,
   * 객체를 주면 가짜 시계·기다리기를 쓴다 (테스트)
   */
  pace?: false | PacerOptions;
}

/**
 * 요청 하나(응답 본문 읽기까지)의 제한 시간. 연결은 받고 답이 없으면(undici 기본은 300초) 시세 체인이 다음 소스로 넘어가지 못하고,
 * 동기화·차트 요청이 몇 분씩 붙잡힌다. 시간 초과는 다시 불러도 또 그만큼 걸리므로 재시도하지 않는다
 */
const REQUEST_TIMEOUT_MS = 10_000;
/** 종목 마스터(마켓별 전체 종목)는 응답이 커서 더 기다린다 */
const MASTER_TIMEOUT_MS = 30_000;
/** 장 운영 달력 조회 제한 시간 */
const CALENDAR_TIMEOUT_MS = 5_000;

export interface TossOpenApiStatus {
  configured: boolean;
  tokenIssuedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** 403 edge-blocked 를 받았으면 true (허용 IP 미등록 가능성) */
  ipBlocked: boolean;
  /** 경로별로 마지막에 받은 초당 허용 요청 수 (응답 머리글 X-RateLimit-Limit — 1초 시세 확인이 한도 안인지 운영에서 본다) */
  rateLimits?: Record<string, number>;
  /** 마지막으로 429(요청 한도 초과)를 받은 시각 */
  lastRateLimitedAt?: string | null;
  /** 경로별 429 횟수 (서버가 켜진 뒤 — 어느 조회가 한도에 걸리는지 운영에서 본다) */
  rateLimited?: Record<string, number>;
  /** 한도 그룹별로 줄을 서서 기다린 요청 수 · 가장 오래 기다린 시간(ms) · 너무 오래 걸려 보내지 않은 수 (속도 조절을 켰을 때만) */
  paced?: Record<string, PaceStat>;
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
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  readonly status: TossOpenApiStatus;
  /** 요청 한도 지키기 (그룹별 줄 세우기). 끄면 null */
  private readonly pacer: RequestPacer | null;
  /** 토스가 응답 머리글로 알려 준 그룹별 초당 한도 (문서 값보다 낮으면 그것을 따른다 — 일부 IP 대역은 초당 1회) */
  private readonly groupLimits = new Map<string, number>();

  constructor(private readonly opts: TossOpenApiClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? { warn: () => {} };
    this.baseUrl = opts.baseUrl ?? TOSS_OPENAPI_BASE;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.pacer = opts.pace === false ? null : new RequestPacer(opts.pace ?? {});
    this.status = { configured: Boolean(opts.clientId && opts.clientSecret), tokenIssuedAt: null, lastOkAt: null, lastError: null, ipBlocked: false, rateLimits: {}, lastRateLimitedAt: null, rateLimited: {} };
    if (this.pacer) this.status.paced = this.pacer.stats;
  }

  /** 응답 머리글의 초당 허용 요청 수를 경로별·그룹별로 적어 둔다 (없으면 그대로) */
  private noteRateLimit(path: string, res: Response, group: RateGroup | null): void {
    const limit = num(res.headers?.get?.("x-ratelimit-limit"));
    if (limit === null) return;
    if (this.status.rateLimits) this.status.rateLimits[path] = limit;
    if (group && limit > 0) this.groupLimits.set(group.group, limit);
  }

  /** 그 그룹에 지금 쓸 초당 한도: 문서 값과 토스가 알려 준 값 중 낮은 쪽 */
  private limitOf(g: RateGroup): number {
    return Math.min(g.limit, this.groupLimits.get(g.group) ?? Infinity);
  }

  /**
   * 유효한 액세스 토큰. 만료 5분 전부터 재발급. 동시 호출은 한 번만 발급하고, 발급 중이면 그 결과를 같이 기다린다
   * (재발급하면 이전 토큰이 바로 무효라 발급 중에 옛 토큰으로 보내면 401 이 난다).
   * rejected: 방금 401 로 거절된 토큰(REST 요청이든 실시간 소켓 핸드셰이크든). 그보다 새 토큰을 준다 — 그 사이 다른 쪽이 이미 새로 받았으면
   * 그것을 그대로 쓰고, 아직 그 토큰이면 한 번만 새로 받는다. 클라이언트당 토큰이 1개라 늦게 도착한 401 마다 새로 받으면
   * 방금 받은 토큰을 서로 무효로 만든다 (예전: 소켓 401 은 거절된 토큰을 몰라 '발급한 지 30초 안 된 토큰은 그대로' 로 짐작했다 →
   * 발급 직후 거절된 토큰으로 다시 연결해 또 거절됐다)
   */
  async getToken(rejected?: string): Promise<string> {
    if (this.tokenPromise) return this.tokenPromise;
    const cur = this.token && this.token.expiresAt - this.now().getTime() > 5 * 60_000 ? this.token : null;
    if (cur && cur.value !== rejected) return cur.value;
    this.tokenPromise = this.issueToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  /**
   * fetch 와 본문(JSON) 읽기를 제한 시간 안에. 넘기면 요청을 끊고 ProviderError (fetchFn 이 signal 을 무시해도 기다리지 않는다).
   * 본문이 JSON 이 아니면 body 는 null
   */
  private async send(url: string, init: RequestInit, what: { network: string; timeout: string }, timeoutMs: number): Promise<{ res: Response; body: unknown }> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new ProviderError(this.name, `${what.timeout} (${timeoutMs / 1000}초)`));
      }, timeoutMs);
    });
    try {
      let res: Response;
      try {
        res = await Promise.race([this.fetchFn(url, { ...init, signal: ctrl.signal }), late]);
      } catch (e) {
        throw e instanceof ProviderError ? e : new ProviderError(this.name, what.network, e);
      }
      const body = await Promise.race([res.json().catch(() => null), late]);
      return { res, body };
    } catch (e) {
      throw this.fail(e instanceof ProviderError ? e : new ProviderError(this.name, what.network, e));
    } finally {
      clearTimeout(timer);
    }
  }

  private async issueToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    const { res, body: raw } = await this.send(
      `${this.baseUrl}/oauth2/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
      },
      { network: "토큰 발급 네트워크 오류", timeout: "토큰 발급 응답 시간 초과" },
      this.timeoutMs,
    );
    const json = (raw && typeof raw === "object" ? raw : {}) as Json;
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

  /**
   * GET /api/v1/... 공통. 401 이면 토큰 재발급 후 1회, 429 면 Retry-After 만큼 기다린 뒤 1회 재시도. 요청마다 제한 시간(opts.timeoutMs).
   * 보내기 전에 그 경로의 한도 그룹 줄에 선다 (tossRateLimit — 초당 한도를 넘겨 429 를 받지 않게). 줄에서 너무 오래 기다리게 되면 보내지 않고 던진다
   */
  async get<T = unknown>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    extraHeaders: Record<string, string> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.size ? `?${qs.toString()}` : ""}`;
    const group = rateGroupOf(path);
    let refreshed = false;
    let waited = false;
    /** 방금 401 을 받은 토큰 (다음 시도에서 한 번만 새 토큰을 청한다) */
    let rejected: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token: string = await this.getToken(rejected ?? undefined);
      rejected = null;
      if (this.pacer && group) {
        try {
          await this.pacer.take(group.group, () => this.limitOf(group));
        } catch (e) {
          throw this.fail(e instanceof ProviderError ? new ProviderError(this.name, `${e.message}: ${path}`) : new ProviderError(this.name, `요청 한도 대기 실패: ${path}`, e));
        }
      }
      const { res, body } = await this.send(
        url,
        { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...extraHeaders } },
        { network: `네트워크 오류: ${path}`, timeout: `응답 시간 초과: ${path}` },
        opts.timeoutMs ?? this.timeoutMs,
      );
      this.noteRateLimit(path, res, group);
      if (res.status === 429) {
        this.status.lastRateLimitedAt = seoulIso(this.now());
        if (this.status.rateLimited) this.status.rateLimited[path] = (this.status.rateLimited[path] ?? 0) + 1;
      }
      if (res.ok) {
        if (!body || typeof body !== "object") throw this.fail(new ProviderError(this.name, `응답 형식 오류: ${path}`));
        this.status.lastOkAt = seoulIso(this.now());
        this.status.lastError = null;
        this.status.ipBlocked = false;
        return (body as Json)["result"] as T;
      }
      const json = (body && typeof body === "object" ? body : {}) as { error?: { code?: string; message?: string } };
      const code = json.error?.code ?? "";
      const message = json.error?.message ?? "";
      if (res.status === 401 && !refreshed) {
        refreshed = true; // expired-token / token-revoked / invalid-token → 새 토큰으로 한 번 더
        rejected = token;
        continue;
      }
      if (res.status === 429) {
        const retryAfter = num(res.headers.get("retry-after")) ?? 1;
        const restMs = Math.min(retryAfter * 1000, this.maxRetryWaitMs);
        // 같은 그룹의 줄에 선 다른 요청도 그동안 보내지 않는다 (이어서 두드려 또 429 를 받지 않게)
        if (group) this.pacer?.pause(group.group, restMs);
        if (!waited) {
          waited = true;
          await sleep(restMs);
          continue;
        }
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

export interface TossStockInfo {
  symbol?: string;
  name?: string;
  englishName?: string;
  isinCode?: string;
  market?: string;
  securityType?: string;
  /** 보통주 여부 (우선주면 false) */
  isCommonShare?: boolean;
  status?: string;
  currency?: string;
  sharesOutstanding?: string;
  /** 레버리지 배수 — ETF·ETN 만 (1 · 2 · 3 · -1 · -2 …), 일반 주식은 null */
  leverageFactor?: string | number | null;
  /** 국내 종목만: NXT 거래 대상·거래정지 (해외 종목은 null) */
  koreanMarketDetail?: { liquidationTrading?: boolean; nxtSupported?: boolean; krxTradingSuspended?: boolean; nxtTradingSuspended?: boolean } | null;
}

/** 종목 유형(securityType) → 상품 구분 코드 (토스 웹 group.code 와 같은 한국거래소 구분: ST 주권 · EF ETF · EN ETN …) */
const PRODUCT_GROUP: Record<string, string> = { STOCK: "ST", FOREIGN_STOCK: "FS", DEPOSITARY_RECEIPT: "DR", INFRASTRUCTURE_FUND: "IF", REIT: "RT", ETF: "EF", FOREIGN_ETF: "EF", ETN: "EN", STOCK_WARRANTS: "SW" };
/** 상장 시장 → 토스 웹 시세의 거래소 코드 (ProductFacts.exchange 가 쓰던 값) */
const PRODUCT_EXCHANGE: Record<string, string> = { KOSPI: "KSP", KOSDAQ: "KSQ", NASDAQ: "NSQ", NYSE: "NYS", AMEX: "AMX" };

/**
 * 공식 종목 정보(/api/v1/stocks) 한 건 → 상품 정보 (지표 점수 3-44 · 계좌 비중 · 가치 지표 대상 판정이 쓰는 ProductFacts — 예전에는 토스 웹 v2/stock-infos).
 * 실측(2026-11-12): SOXL ETF 3 · SOXS ETF -3 · NVDL·RGTX ETF 2 · QQQ ETF 1 · KODEX 레버리지 ETF 2 · KODEX 200선물인버스2X ETF -2 · 레버리지 원유 ETN 2,
 * 일반 주식(애플·삼성전자)은 배수 null · 삼성전자우 isCommonShare false · SK리츠 REIT. 미국 주식도 STOCK, 미국 ETF 도 ETF 로 온다.
 * 공식 API 에 없는 칸은 모름(null): 단일 종목형(singleStockEtp) · 파생형(derivativeEtf) · 스팩(spac) · 자세한 이름(detailName) —
 * 가리는 쪽(analysis/leveraged)은 모르면 정적 표·이름 규칙으로, 스팩은 업종·SIC 로 본다
 */
export function officialProductFacts(r: TossStockInfo): ProductFacts {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const type = str(r.securityType);
  const market = str(r.market);
  const liquidation = r.koreanMarketDetail?.liquidationTrading;
  return {
    name: str(r.name),
    englishName: str(r.englishName),
    detailName: null,
    group: type ? (PRODUCT_GROUP[type] ?? null) : null,
    exchange: market ? (PRODUCT_EXCHANGE[market] ?? null) : null,
    leverageFactor: num(r.leverageFactor),
    singleStockEtp: null,
    derivativeEtf: null,
    commonShare: typeof r.isCommonShare === "boolean" ? r.isCommonShare : null,
    spac: null,
    clearance: typeof liquidation === "boolean" ? liquidation : null,
  };
}

/** 공식 장 운영 달력의 세션 하나 (한국 시간 ISO) */
export interface TossCalendarSession {
  startTime: string;
  endTime: string;
}

/** 공식 장 운영 달력 하루: 한국은 통합(KRX+NXT) 프리·정규·애프터, 미국은 데이마켓·프리·정규·애프터. 쉬는 세션은 null */
export interface TossCalendarDay {
  /** 영업일 (한국은 서울 날짜, 미국은 현지 날짜) */
  date: string;
  /** 그날 거래가 있는 첫 세션 시작 ~ 마지막 세션 끝 (모두 쉬면 null). 한국: 08:00~20:00, 미국: 데이마켓 시작 ~ 애프터마켓 끝 */
  open: TossCalendarSession | null;
  /** 정규장 (쉬면 null) */
  regular: TossCalendarSession | null;
  sessions: { day: TossCalendarSession | null; pre: TossCalendarSession | null; regular: TossCalendarSession | null; after: TossCalendarSession | null };
}

/** 공식 장 운영 달력 응답: 전 영업일·오늘·다음 영업일 */
export interface TossMarketCalendar {
  previous: TossCalendarDay | null;
  today: TossCalendarDay | null;
  next: TossCalendarDay | null;
}

function calendarSession(v: unknown): TossCalendarSession | null {
  const o = v as Json | null | undefined;
  const start = o?.["startTime"], end = o?.["endTime"];
  if (typeof start !== "string" || typeof end !== "string") return null;
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isNaN(a) || Number.isNaN(b) || b <= a ? null : { startTime: start, endTime: end };
}

/** 공식 달력의 하루(today·previousBusinessDay·nextBusinessDay 중 하나)를 읽는다. 모양이 다르면 null */
export function parseCalendarDay(market: "KR" | "US", v: unknown): TossCalendarDay | null {
  const d = v as Json | null | undefined;
  const date = typeof d?.["date"] === "string" ? d["date"].slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const src = (market === "KR" ? (d!["integrated"] as Json | null | undefined) : d) ?? {};
  const sessions = {
    day: market === "US" ? calendarSession(src["dayMarket"]) : null,
    pre: calendarSession(src["preMarket"]),
    regular: calendarSession(src["regularMarket"]),
    after: calendarSession(src["afterMarket"]),
  };
  const all = [sessions.day, sessions.pre, sessions.regular, sessions.after].filter((s): s is TossCalendarSession => s !== null);
  const open = all.length
    ? { startTime: all.reduce((a, s) => (Date.parse(s.startTime) < Date.parse(a) ? s.startTime : a), all[0]!.startTime), endTime: all.reduce((a, s) => (Date.parse(s.endTime) > Date.parse(a) ? s.endTime : a), all[0]!.endTime) }
    : null;
  return { date, open, regular: sessions.regular, sessions };
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

/** 30분 (ms) */
const HALF_HOUR_MS = 30 * 60_000;

/**
 * 1분봉(오래된 순) → 30분봉. 공식 1분봉의 시각은 봉이 **끝나는** 시각이다 (문서: 그 봉은 [시각 − 1분, 시각) 의 체결 — 2026-11-12 실측: 19:04:47 에 받은
 * 삼성전자 마지막 봉이 19:05). 그래서 1분봉 [T−1분, T) 는 구간 [B, B+30분) (B = T−1분을 30분 단위로 내린 시각)에 넣고,
 * 30분봉의 time 은 그 구간이 **끝나는** 시각(B+30분)으로 적는다 — 예전 토스 웹 30분봉과 같은 뜻이라 3-29 거래량 급증(volumeBaseline 이 시각에서 30분을 빼 시작으로 읽음)이 그대로 맞는다.
 * date 는 그 끝 시각의 현지 날짜 (1분봉과 같은 규칙)
 */
export function aggregateHalfHours(minutes: Candle[], kr: boolean): Candle[] {
  const out: Candle[] = [];
  let key = NaN;
  for (const c of minutes) {
    const end = c.time ? Date.parse(c.time) : NaN;
    if (Number.isNaN(end)) continue;
    const bucket = Math.floor((end - 60_000) / HALF_HOUR_MS) * HALF_HOUR_MS;
    const last = out.at(-1);
    if (bucket !== key || !last) {
      key = bucket;
      const iso = new Date(bucket + HALF_HOUR_MS).toISOString();
      out.push({ date: localDate(iso, kr), time: localIso(iso, kr), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

/** 받아 둔 봉과 다시 받은 봉의 가격이 이만큼(비율) 넘게 다르면 지난 봉이 고쳐진 것으로 본다 (수정주가 — 호가 한 칸·늦은 체결 정도는 아님) */
const PRICE_REVISED_RATIO = 0.001;

/** 이미 끝난 봉이 고쳐졌는지: 시가나 종가가 0.1% 넘게 다르다 (거래량만 조금 다른 것은 늦게 들어온 체결이라 고쳐진 것으로 보지 않는다) */
function priceRevised(kept: Candle, fresh: Candle): boolean {
  const off = (a: number, b: number) => Math.abs(a - b) > Math.max(Math.abs(a), Math.abs(b)) * PRICE_REVISED_RATIO;
  return off(kept.open, fresh.open) || off(kept.close, fresh.close);
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
/** 현재가 묶음을 거절하게 만든 종목을 묶음에서 빼 두는 시간 */
const REJECTED_MS = 10 * 60_000;
/** 물은 종목이 모두 거절됐을 때(종목 탓이 아닐 수 있다) 쉬는 시간 */
const REJECTED_ALL_MS = 60_000;
/** 종목(심볼) 때문에 거절된 요청인지 — 모르는·상장폐지 종목은 400·404·422 */
const isRejected = (e: unknown): boolean => e instanceof ProviderError && /HTTP 4(00|04|22)/.test(e.message);
/** 시세용 일봉 개수 (52주 고저) */
const QUOTE_DAILY = 260;
/** 같은 거래일 안에서 최근 봉(오늘 시고저·거래량, 새로 열린 거래일 봉)만 다시 받는 간격 — 예전 시세 캐시와 같은 1분 */
const TODAY_REFRESH_MS = 60_000;
/** 일봉을 동시에 받는 종목 수 (그룹별 초당 호출 제한) */
const DAILY_CONCURRENCY = 4;
/** 현재가 일괄 조회 한 번에 넣는 종목 수 */
const PRICES_CHUNK = 50;
/** 실시간 보조(getMany): 이 안에 받은 현재가는 다시 부르지 않는다 (1초 폴링·잔고 요청·상세 요청이 같은 응답을 나눠 쓴다) */
const QUICK_FRESH_MS = 800;
/** 실시간 보조: 앱이 붙어 있는 동안 서버가 현재가를 묻는 간격. 시세 그룹 한도는 초당 15회, 이 조회는 종목이 많아도 1초에 1~2회 */
const QUICK_POLL_MS = 1_000;
/**
 * 실시간 보조: 토스가 이 서버 IP 의 시세 한도를 낮게 잡았으면(문서: 일부 IP 대역은 초당 1회) 현재가 확인을 이만큼으로 늦춘다 —
 * 1초 확인이 한도를 다 써서 시세 스냅샷·일봉 조회가 429 로 밀리지 않게. 한도는 응답 머리글(X-RateLimit-Limit)로 안다
 */
const QUICK_FRESH_LOW_LIMIT_MS = 2_800;
/** 이 값 이하의 초당 한도면 낮은 한도로 본다 */
const LOW_RATE_LIMIT = 3;
/** 실시간 보조: 요청 한도(429)에 걸리면 이만큼 쉰다 (다른 조회 — 일봉·계좌 — 가 밀리지 않게) */
const QUICK_BACKOFF_MS = 5_000;
/** 세션 자격(NXT 대상·거래정지)을 다시 받는 간격 — 거래정지는 장중에도 바뀔 수 있어 하루가 아니라 1시간 */
const SESSION_INFO_TTL_MS = 60 * 60_000;
/** 세션 자격 조회가 실패하면 이만큼 쉰다 */
const SESSION_INFO_RETRY_MS = 5 * 60_000;
const ETP_TYPES = new Set(["ETF", "FOREIGN_ETF", "ETN"]);
/**
 * 30분봉을 처음 만들 때 받는 1분봉 쪽 수 상한 (한 쪽 200개 — 60쪽 = 1분봉 12,000개: 한국 통합 세션(08:00~20:00) 16일쯤, 미국은 주간·프리·정규·애프터를 다 채우면 8일쯤).
 * 쪽은 차례로 받는다(앞 쪽의 nextBefore 가 있어야 다음 쪽) — 종목 하나를 처음 볼 때만이고, 그 뒤에는 최신 구간만 한두 쪽
 */
const HALF_HOUR_COLD_PAGES = 60;
/** 받아 둔 30분봉을 이어 붙일 때 최신 쪽에서 거슬러 받는 쪽 수 상한 (넘게 비었으면 처음부터 다시 받는다) */
const HALF_HOUR_TAIL_PAGES = 12;
/** 받아 두는 30분봉 수 (가격 알림의 거래량 급증이 450개를 청한다) */
const HALF_HOUR_KEEP = 450;
/** 30분봉을 받아 두는 종목 수 (오래 안 쓴 것부터 버림) */
const HALF_HOUR_CODES = 60;
/** 공식 API 가 모르는 종목의 종목 정보를 다시 묻지 않는 시간 */
const INFO_MISS_MS = 60 * 60_000;

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

export class TossOpenApiProvider implements QuoteProvider, InvestorFlowProvider, MasterProvider, QuickPriceSource {
  readonly name = "toss-openapi";
  /** 현재가의 timestamp 는 실제 마지막 체결 시각 (시간외 체결 포함) */
  readonly tradeTime = true;
  readonly pollMs = QUICK_POLL_MS;
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
    for (const [sym, r] of await this.fetchStockInfos(need)) out.set(sym, r);
    return out;
  }

  /** 종목 정보를 새로 받아 캐시에 넣는다 (받아 둔 값이 있어도 다시 — 거래정지 같은 장중 변화를 보려는 쪽이 쓴다) */
  private async fetchStockInfos(symbols: string[]): Promise<Map<string, TossStockInfo>> {
    const out = new Map<string, TossStockInfo>();
    const t = this.now().getTime();
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
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

  // ── 상품 정보 (종목 하나씩 묻는 쪽 — 한 번에 묶어 보낸다) ──────────────────

  /** 함께 물을 종목 (다음 묶음) 과 그 묶음의 응답 */
  private infoQueue: string[] = [];
  private infoFlush: Promise<Map<string, TossStockInfo> | null> | null = null;
  /** 종목별로 나가 있는 조회 */
  private readonly infoWait = new Map<string, Promise<TossStockInfo | null>>();
  /** 공식 API 가 모르는 종목을 물은 시각 — INFO_MISS_MS 동안 다시 묻지 않는다 */
  private readonly infoMissAt = new Map<string, number>();

  /**
   * 종목 정보 한 건 (하루 캐시). 같은 순간에 여러 종목을 물으면 요청 하나(200개씩)로 묶는다 — 종목 정보 그룹은 초당 5회라,
   * 보유 종목 20개의 상품 정보를 하나씩 물으면 그것만으로 한도를 넘는다. 공식 API 가 모르는 종목은 null (1시간 동안 다시 묻지 않음), 받지 못하면 던진다
   */
  private infoFor(symbol: string): Promise<TossStockInfo | null> {
    const t = this.now().getTime();
    const hit = this.infoCache.get(symbol);
    if (hit && t - hit.at < 24 * 3_600_000) return Promise.resolve(hit.info);
    if (t - (this.infoMissAt.get(symbol) ?? -Infinity) < INFO_MISS_MS) return Promise.resolve(null);
    const running = this.infoWait.get(symbol);
    if (running) return running;
    this.infoQueue.push(symbol);
    // 같은 틱에 부른 종목이 모두 줄에 선 뒤에 보낸다 (타이머를 쓰지 않는다 — 마이크로태스크 두 번 뒤)
    this.infoFlush ??= Promise.resolve()
      .then(() => undefined)
      .then(() => this.flushInfos());
    const p = this.infoFlush
      .then((got) => {
        if (got === null) throw new ProviderError(this.name, `${symbol} 종목 정보를 받지 못했습니다`);
        const info = got.get(symbol) ?? null;
        if (!info) this.infoMissAt.set(symbol, this.now().getTime());
        return info;
      })
      .finally(() => this.infoWait.delete(symbol));
    this.infoWait.set(symbol, p);
    return p;
  }

  /** 줄에 선 종목을 한 번에 받는다. 받지 못하면 null (기다리던 쪽이 실패로) */
  private async flushInfos(): Promise<Map<string, TossStockInfo> | null> {
    const symbols = [...new Set(this.infoQueue)];
    this.infoQueue = [];
    this.infoFlush = null;
    try {
      return await this.fetchStockInfos(symbols);
    } catch {
      return null;
    }
  }

  /**
   * 상품 정보 (ETF·ETN 구분 · 레버리지 배수 · 우선주 · 정리매매 · 거래소 — 지표 점수 3-44 · 계좌 비중 · 가치 지표 대상 판정).
   * 예전에는 토스 웹 v2/stock-infos 였다(2026-11 부터 막힘). 모르는 종목·실패면 null (부르는 쪽은 종목 마스터 분류·이름 규칙으로)
   */
  async productFacts(code: string): Promise<ProductFacts | null> {
    try {
      const info = await this.infoFor(normalizeCode(code));
      return info ? officialProductFacts(info) : null;
    } catch {
      return null;
    }
  }

  /** 상장 주식 수 (수급 탭 외국인 한도율 계산용 — 종목 정보 sharesOutstanding). 모르면 null, 던지지 않는다 */
  async listedShares(code: string): Promise<number | null> {
    try {
      const shares = num((await this.infoFor(normalizeCode(code)))?.sharesOutstanding);
      return shares !== null && shares > 0 ? shares : null;
    } catch {
      return null;
    }
  }

  /** 나가 있는 환율 요청 (동시에 물으면 이것을 같이 기다린다) */
  private fxInflight: Promise<number | null> | null = null;

  /**
   * USD → KRW 매매기준율 (1분 캐시). 실패하면 null.
   * 캐시가 끝난 순간 여러 시세 조회가 함께 물어도 요청은 하나만 나간다 — 예전에는 조회마다 따로 보내(환율·장 달력 그룹은 초당 3회)
   * 운영에서 1분마다 두세 번씩 429 를 받았고, 그 시세 조회가 1~3초 늦거나 환율 없이(원화 환산 없음·다른 출처 환율) 끝났다
   */
  usdKrw(): Promise<number | null> {
    const t = this.now().getTime();
    if (this.fxCache && t - this.fxCache.at < 60_000) return Promise.resolve(this.fxCache.rate);
    this.fxInflight ??= (async () => {
      try {
        const r = await this.client.get<Json>("/api/v1/exchange-rate", { baseCurrency: "USD", quoteCurrency: "KRW" });
        const rate = num(r?.["midRate"]) ?? num(r?.["rate"]);
        if (rate === null) return null;
        this.fxCache = { at: t, rate };
        return rate;
      } catch {
        return null;
      }
    })().finally(() => {
      this.fxInflight = null;
    });
    return this.fxInflight;
  }

  // ── 장 운영 달력 ─────────────────────────────────────────────────

  /**
   * 공식 장 운영 달력 (GET /api/v1/market-calendar/KR|US): 전 영업일·오늘·다음 영업일의 세션 시각.
   * 한국은 통합(KRX+NXT) 프리 08:00 · 정규 · 애프터 ~20:00, 미국은 데이마켓·프리·정규·애프터. 휴장일은 세션이 모두 null,
   * 수능일·조기 폐장도 그날 시각으로 온다. 받지 못하면 던진다 (부르는 쪽이 요일·휴장일 목록으로 대신한다)
   */
  async marketCalendar(market: "KR" | "US"): Promise<TossMarketCalendar> {
    // 장 상태를 묻는 요청들이 오래 붙잡히지 않게 짧게 (예전 달력 조회와 같은 5초 — 넘으면 요일·휴장일 목록 추정)
    const r = await this.client.get<Json>(`/api/v1/market-calendar/${market}`, {}, {}, { timeoutMs: CALENDAR_TIMEOUT_MS });
    if (!r || typeof r !== "object") throw new ProviderError(this.name, `장 운영 달력 응답이 비었습니다 (${market})`);
    const out = { previous: parseCalendarDay(market, r["previousBusinessDay"]), today: parseCalendarDay(market, r["today"]), next: parseCalendarDay(market, r["nextBusinessDay"]) };
    if (!out.today) throw new ProviderError(this.name, `장 운영 달력 응답 모양이 다릅니다 (${market})`);
    return out;
  }

  // ── 실시간 보조: 현재가 일괄 (QuickPriceSource) ─────────────────────

  /** 종목별 마지막으로 받은 현재가 (체결 시각은 실제 마지막 체결 시각) */
  private readonly quickTicks = new Map<string, LiveTick>();
  /** 현재가가 없던 코드(체결 시각 없음·모르는 종목)를 물은 시각 — 잠깐은 그 코드 때문에 다시 부르지 않는다 */
  private readonly quickMissAt = new Map<string, number>();
  private readonly quickInflight: Array<{ codes: Set<string>; p: Promise<void> }> = [];
  private quickFailedAt = -Infinity;
  private quickBackoffUntil = -Infinity;
  /** 종목별 세션 자격을 받은 시각 (1시간마다 다시) */
  private readonly sessionInfoAt = new Map<string, number>();
  private sessionInfoFailedAt = -Infinity;
  private sessionInfoInflight: Promise<void> | null = null;

  /**
   * 여러 종목의 마지막 체결가를 요청 1개로 (/api/v1/prices — 정규장·시간외 모두 '최근 체결'). 웹소켓이 주지 않는 체결(유실·시간외·조용한 종목)을
   * 1초 안에 따라잡는 보조 경로다. QUICK_FRESH_MS 안에 받은 값은 다시 부르지 않고, 같은 종목을 받는 요청이 나가 있으면 그것을 같이 기다린다.
   * 요청 한도(429)에 걸리면 QUICK_BACKOFF_MS 동안 받아 둔 값만 돌려준다. 실패하면 던진다 (부르는 쪽은 직전 값을 쓴다)
   */
  async getMany(codes: string[]): Promise<Map<string, LiveTick>> {
    const list = [...new Set(codes.map(normalizeCode))].filter((c) => CODE_RE.test(c));
    if (list.length === 0) return new Map();
    // 한도가 낮은 IP 면 확인 간격을 늦춘다 (받아 둔 값을 그만큼 더 쓴다)
    const limit = this.client.status.rateLimits?.["/api/v1/prices"];
    const QUICK_FRESH = limit !== undefined && limit <= LOW_RATE_LIMIT ? QUICK_FRESH_LOW_LIMIT_MS : QUICK_FRESH_MS;
    const pick = () => {
      const n = this.now().getTime();
      return new Map(
        list.flatMap((c) => {
          const x = this.quickTicks.get(c);
          return x && n - x.receivedAt < QUICK_FRESH ? [[c, x] as [string, LiveTick]] : [];
        }),
      );
    };
    const t = this.now().getTime();
    const fresh = (c: string) => {
      const x = this.quickTicks.get(c);
      return (x !== undefined && t - x.receivedAt < QUICK_FRESH) || t - (this.quickMissAt.get(c) ?? -Infinity) < QUICK_FRESH;
    };
    if (list.every(fresh) || t < this.quickBackoffUntil) return pick();
    const running = this.quickInflight.find((x) => list.every((c) => x.codes.has(c)));
    if (running) {
      await running.p;
      return pick();
    }
    const entry = { codes: new Set(list), p: this.fetchQuick(list) };
    this.quickInflight.push(entry);
    try {
      await entry.p;
      return pick();
    } finally {
      this.quickInflight.splice(this.quickInflight.indexOf(entry), 1);
    }
  }

  private async fetchQuick(list: string[]): Promise<void> {
    let prices: Map<string, Json>;
    try {
      prices = await this.pricesMany(list);
    } catch (e) {
      const at = this.now().getTime();
      this.quickFailedAt = at;
      if (e instanceof Error && /HTTP 429/.test(e.message)) this.quickBackoffUntil = at + QUICK_BACKOFF_MS;
      throw e;
    }
    const got = this.now().getTime();
    for (const code of list) {
      const p = prices.get(code);
      const raw = num(p?.["lastPrice"]);
      // 미국 종목은 토스 화면·웹소켓 체결과 같은 자리로 (센트 아래 버림) — 같은 체결이 다른 가격으로 보이지 않게
      const price = raw === null || isKrCode(code) ? raw : truncUsdPrice(raw);
      const ts = typeof p?.["timestamp"] === "string" && !Number.isNaN(Date.parse(p["timestamp"])) ? p["timestamp"] : null;
      // 체결 시각이 없으면(오늘 체결 없음 등) 붙일 체결이 아니다 — 스냅샷 값을 그대로 둔다
      if (price === null || ts === null) {
        this.quickMissAt.set(code, got);
        continue;
      }
      this.quickTicks.set(code, { code, price, volume: null, timestamp: ts, receivedAt: got });
      this.quickMissAt.delete(code);
    }
  }

  /**
   * 종목별 세션 사실 (초록 점 판단 — services/liveSession): NXT 대상·거래정지·ETF/ETN 은 공식 종목 정보(/api/v1/stocks)에서.
   * 미국 주간거래 대상 여부는 공식 API 에 없어 모름(null) — 그 세션에 체결이 있었던 종목만 점이 켜진다.
   * 받아 둔 값만 바로 돌려주고, 없거나 1시간 지난 종목은 뒤에서 새로 받는다 (잔고 응답을 기다리게 하지 않는다)
   */
  sessionFacts(codes: string[]): Map<string, StockSessionFacts> {
    const list = [...new Set(codes.map(normalizeCode))].filter((c) => CODE_RE.test(c));
    void this.refreshSessionInfos(list);
    const out = new Map<string, StockSessionFacts>();
    for (const c of list) {
      const info = this.sessionInfoAt.has(c) ? (this.infoCache.get(c)?.info ?? null) : null;
      const kr = info?.koreanMarketDetail ?? null;
      const tick = this.quickTicks.get(c);
      const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
      out.set(c, {
        daytime: null,
        nxt: flag(kr?.nxtSupported),
        halted: flag(kr?.krxTradingSuspended),
        nxtHalted: flag(kr?.nxtTradingSuspended),
        etp: info?.securityType ? ETP_TYPES.has(info.securityType) : null,
        exchange: null,
        // 그 뒤 현재가 조회가 실패했으면 받는 중이 아니다
        pricedAt: tick && tick.receivedAt > this.quickFailedAt ? tick.receivedAt : null,
      });
    }
    return out;
  }

  /** 세션 자격을 새로 받는다 (없거나 1시간 지난 종목만). 실패하면 5분 쉬고, 나가 있는 요청이 있으면 그것을 기다린다 */
  refreshSessionInfos(codes: string[]): Promise<void> {
    if (this.sessionInfoInflight) return this.sessionInfoInflight;
    const t = this.now().getTime();
    if (t - this.sessionInfoFailedAt < SESSION_INFO_RETRY_MS) return Promise.resolve();
    const need = codes.filter((c) => t - (this.sessionInfoAt.get(c) ?? -Infinity) >= SESSION_INFO_TTL_MS);
    if (need.length === 0) return Promise.resolve();
    const p = (async () => {
      // 하루 캐시(infoCache)를 건너뛰고 새로 받는다 — 거래정지는 장중에 바뀐다
      await this.fetchStockInfos(need);
      const at = this.now().getTime();
      // 응답에 없는 종목도 받은 것으로 적어 1시간 동안 다시 묻지 않는다 (자격은 모름)
      for (const c of need) this.sessionInfoAt.set(c, at);
    })()
      .catch(() => {
        this.sessionInfoFailedAt = this.now().getTime();
      })
      .finally(() => {
        this.sessionInfoInflight = null;
      });
    this.sessionInfoInflight = p;
    return p;
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

  /**
   * 1분봉을 최신 쪽부터 거슬러 받는다 (오래된 순으로 돌려줌). sinceMs 를 주면 그 시각과 같거나 이전인 봉이 나올 때까지,
   * 아니면 maxPages 쪽까지. reached = 바라던 데까지 받음 (sinceMs 에 닿았거나 기록의 처음)
   */
  private async minutePages(code: string, o: { maxPages: number; sinceMs?: number }): Promise<{ candles: Candle[]; reached: boolean }> {
    const kr = isKrCode(code);
    const acc: Candle[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    let reached = false;
    for (let page = 0; page < o.maxPages; page++) {
      const r = await this.client.get<{ candles?: TossCandle[]; nextBefore?: string | null }>("/api/v1/candles", { symbol: code, interval: "1m", count: 200, before, adjusted: true });
      const rows = r?.candles ?? [];
      let oldest = Infinity;
      for (const c of rows) {
        const candle = toCandle(c, kr, true);
        if (!candle?.time) continue;
        oldest = Math.min(oldest, Date.parse(candle.time));
        if (!seen.has(candle.time)) {
          seen.add(candle.time);
          acc.push(candle);
        }
      }
      if (o.sinceMs !== undefined && oldest <= o.sinceMs) {
        reached = true;
        break;
      }
      if (!r?.nextBefore || rows.length === 0) {
        reached = true; // 기록의 처음까지 받음
        break;
      }
      before = r.nextBefore;
    }
    acc.sort((a, b) => Date.parse(a.time!) - Date.parse(b.time!));
    return { candles: acc, reached };
  }

  /** 종목별로 받아 둔 30분봉 (오래된 순 · time 은 끝나는 시각). pages = 처음 받을 때 쓴 쪽 수, fromStart = 기록의 처음까지 받음 */
  private readonly halfHourBook = new Map<string, { bars: Candle[]; pages: number; fromStart: boolean }>();
  private readonly halfHourInflight = new Map<string, Promise<Candle[]>>();

  /**
   * 30분봉 (공식 API 에는 1분봉·일봉만 있어 1분봉을 묶어 만든다 — 예전에는 토스 웹 차트 min:30 한 번이었는데 그 주소가 막혔고, 네이버·Yahoo 는 분봉을 주지 않는다).
   * 처음에는 청한 개수만큼의 1분봉(count × 30개, 60쪽까지)을 차례로 받고, 그 뒤에는 받아 둔 봉의 마지막 세 구간부터만 다시 받아 이어 붙인다(보통 한 쪽).
   * 그때 이미 끝나 있던 봉의 가격이 달라져 있으면(수정주가) 처음부터 다시 받는다.
   * 처음 받은 묶음의 맨 앞 날은 앞부분이 잘렸을 수 있어 뺀다 (하루 치가 다 있는 날만 — 거래량 급증이 날마다 같은 시각까지의 거래량을 견준다)
   */
  private halfHours(code: string, count: number): Promise<Candle[]> {
    const running = this.halfHourInflight.get(code);
    if (running) return running;
    const p = this.loadHalfHours(code, count).finally(() => this.halfHourInflight.delete(code));
    this.halfHourInflight.set(code, p);
    return p;
  }

  private async loadHalfHours(code: string, count: number): Promise<Candle[]> {
    const kr = isKrCode(code);
    const want = Math.min(HALF_HOUR_COLD_PAGES, Math.ceil((Math.min(count, HALF_HOUR_KEEP) * 30) / 200) + 1);
    let hit = this.halfHourBook.get(code);
    // 전보다 긴 기간을 청하면(차트 300개 뒤에 거래량 급증 450개) 처음부터 다시 받는다 — 종목마다 많아야 한 번
    if (hit && !hit.fromStart && hit.pages < want) hit = undefined;
    let bars: Candle[] | null = null;
    if (hit && hit.bars.length) {
      // 마지막 세 구간을 다시 만든다: 마지막 봉은 진행 중이었고, 그 앞 봉도 받는 순간 아직 덜 찼을 수 있다.
      // 뒤에서 셋째 봉은 지난번에 이미 끝나 있던 봉이라, 다시 받은 것과 가격이 눈에 띄게 다르면 지난 봉이 고쳐진 것이다
      // (액면분할·무상증자 뒤의 수정주가 — 분할 전 봉에 분할 뒤 봉을 이어 붙이면 가격이 끊기고 거래량 급증이 몇 배로 잘못 나온다) → 처음부터 다시.
      // 늦게 들어온 체결로 거래량이 조금 달라진 정도는 그 봉만 새 값으로 바꾼다 (그때마다 수십 쪽을 다시 받지 않게)
      const check = hit.bars.length >= 3 ? hit.bars.at(-3)! : null;
      const since = Date.parse((check ?? hit.bars.at(-2) ?? hit.bars.at(-1)!).time!) - HALF_HOUR_MS;
      const tail = await this.minutePages(code, { maxPages: HALF_HOUR_TAIL_PAGES, sinceMs: since });
      if (tail.reached) {
        const fresh = aggregateHalfHours(tail.candles.filter((c) => Date.parse(c.time!) > since), kr);
        const again = check ? fresh.find((b) => b.time === check.time) : null;
        if (!check || (again && !priceRevised(check, again))) {
          const kept = hit.bars.filter((b) => Date.parse(b.time!) <= since);
          bars = [...kept, ...fresh].slice(-HALF_HOUR_KEEP);
          // 쓸 때마다 맨 뒤로 (오래 안 쓴 종목부터 버리게)
          this.halfHourBook.delete(code);
          this.halfHourBook.set(code, { bars, pages: hit.pages, fromStart: hit.fromStart });
        }
      }
      // 닿지 못했으면(오래 비어 있었다) 사이가 빈 봉을 이어 붙이지 않고 처음부터 다시 받는다 — 지난 봉이 고쳐졌을 때도
    }
    if (!bars) {
      const cold = await this.minutePages(code, { maxPages: want });
      let made = aggregateHalfHours(cold.candles, kr);
      if (!cold.reached && made.length) {
        // 맨 앞 날(봉이 시작한 현지 날짜)은 앞부분이 잘렸을 수 있다 → 그날 봉을 모두 뺀다
        const dayOf = (b: Candle) => localDate(new Date(Date.parse(b.time!) - HALF_HOUR_MS).toISOString(), kr);
        const first = dayOf(made[0]!);
        const rest = made.filter((b) => dayOf(b) !== first);
        // 하루 치도 안 되면(쪽 수가 아주 적을 때) 맨 앞 구간만 뺀다
        made = rest.length ? rest : made.slice(1);
      }
      bars = made.slice(-HALF_HOUR_KEEP);
      this.halfHourBook.delete(code);
      this.halfHourBook.set(code, { bars, pages: want, fromStart: cold.reached });
      while (this.halfHourBook.size > HALF_HOUR_CODES) {
        const oldest = this.halfHourBook.keys().next().value;
        if (oldest === undefined) break;
        this.halfHourBook.delete(oldest);
      }
    }
    return bars;
  }

  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    code = normalizeCode(code);
    if (isIntraday(period)) {
      if (period === "30m") {
        const bars = await this.halfHours(code, count);
        if (bars.length === 0) throw new ProviderError(this.name, `${code} 분봉 데이터 없음`);
        return { code, period, candles: bars.slice(-count), source: this.name };
      }
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

  /** 현재가 묶음을 거절하게 만든 종목(공식 API 가 모르는·상장폐지 종목)과 다시 넣어 볼 시각 — 그동안은 묶음에서 뺀다 */
  private readonly rejectedUntil = new Map<string, number>();

  /** 현재가 일괄 조회 (/prices 는 symbols 를 콤마로 여러 개 받는다) */
  private async pricesMany(codes: string[]): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    const t = this.now().getTime();
    // 묶음을 거절하게 만든 종목은 한동안 묻지 않는다 (그 종목만 '시세 없음' → 체인이 다음 소스로).
    // 쉬는 시간이 끝난 종목은 묶음에 다시 넣지 않고 따로 한 번 물어 본다(retry) — 묶음에 넣으면 아직 모르는 종목일 때 묶음 전체가 또 거절돼
    // 10분마다 '종목 수만큼' 다시 묻게 된다 (운영에서 그때마다 현재가 한도에 걸려 1초 확인이 5초씩 쉬었다)
    const ask: string[] = [];
    const retry: string[] = [];
    for (const c of codes) {
      const until = this.rejectedUntil.get(c);
      if (until === undefined) ask.push(c);
      else if (until <= t) retry.push(c);
    }
    for (let i = 0; i < ask.length; i += PRICES_CHUNK) {
      const chunk = ask.slice(i, i + PRICES_CHUNK);
      let rows: Json[];
      try {
        rows = (await this.client.get<Json[]>("/api/v1/prices", { symbols: chunk.join(",") })) ?? [];
      } catch (e) {
        if (!isRejected(e)) throw e;
        if (chunk.length === 1) {
          // 한 종목만 물었는데 거절: 잠깐 다시 묻지 않는다 (상세 화면을 보는 동안 1초마다 두드리지 않게)
          this.rejectedUntil.set(chunk[0]!, this.now().getTime() + REJECTED_ALL_MS);
          throw e;
        }
        // 모르는·상장폐지 종목 하나 때문에 묶음 전체가 4xx 로 거절되면 종목마다 다시 물어 나머지는 살린다.
        // 거절된 종목은 기억해 두고 한동안 묶음에서 뺀다 — 1초 확인(getMany)이 매번 '묶음 1 + 종목 수'만큼 부르지 않게
        const single = await mapLimit(chunk, DAILY_CONCURRENCY, (c) =>
          this.client.get<Json[]>("/api/v1/prices", { symbols: c }).then(
            (r) => ({ rows: (r ?? []).map((x) => ({ ...x, symbol: x["symbol"] ?? c })), rejected: false }),
            (e2: unknown) => ({ rows: [] as Json[], rejected: isRejected(e2) }),
          ),
        );
        const bad = chunk.filter((_, k) => single[k]!.rejected);
        // 모두 거절되면 종목 탓이 아닐 수 있다(요청 자체의 문제) → 짧게만 쉰다
        const until = this.now().getTime() + (bad.length === chunk.length ? REJECTED_ALL_MS : REJECTED_MS);
        for (const c of bad) this.rejectedUntil.set(c, until);
        rows = single.flatMap((x) => x.rows);
      }
      for (const r of rows) {
        const sym = String(r["symbol"] ?? "").toUpperCase();
        if (sym) out.set(sym, r);
      }
      // 한 종목만 물었는데 심볼 표기가 다르게 오면(대소문자 등) 그 한 줄을 쓴다
      if (chunk.length === 1 && !out.has(chunk[0]!) && rows[0]) out.set(chunk[0]!, rows[0]);
    }
    // 쉬는 시간이 끝난 종목: 하나씩 (묶음 뒤에 — 이 확인이 늦어도 다른 종목 시세를 붙잡지 않게)
    for (const c of retry) {
      try {
        const rows = (await this.client.get<Json[]>("/api/v1/prices", { symbols: c })) ?? [];
        this.rejectedUntil.delete(c);
        const r = rows.find((x) => String(x["symbol"] ?? "").toUpperCase() === c) ?? rows[0];
        if (r) out.set(c, r);
      } catch (e) {
        // 다른 종목과 함께 물었는데 이 종목만 거절이면 그 종목 탓 → 길게. 혼자 물었거나(종목 탓이 아닐 수 있다) 거절이 아닌 실패(시간 초과 등)면 짧게 쉬고 다시
        this.rejectedUntil.set(c, this.now().getTime() + (isRejected(e) && ask.length > 0 ? REJECTED_MS : REJECTED_ALL_MS));
        // 혼자 물은 종목은 예전처럼 그 오류를 던진다 (체인이 다음 소스로 넘어가며 까닭을 남긴다)
        if (codes.length === 1) throw e;
      }
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
    const rawPrice = num(p["lastPrice"]) ?? latest?.close ?? null;
    if (rawPrice === null) throw new ProviderError(this.name, `${code} 현재가 없음`);
    // 미국 종목은 토스 화면처럼 센트 아래를 버린다 (공식 현재가는 소수 넷째 자리까지 온다 — lib/usdPrice)
    const usd = (v: number) => (kr ? v : truncUsdPrice(v));
    const price = usd(rawPrice);
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
    // 등락률은 반올림 전 차이로 — 센트로 반올림한 등락으로 내면 $0.0500 → $0.0537 이 0.00% 가 된다 (+7.40%).
    // 소수 둘째 자리 아래는 토스증권처럼 버린다 (lib/pct)
    const change = round4(price - prevClose);
    const changeRate = prevClose ? truncPct(((price - prevClose) / prevClose) * 100) : 0;
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
      open: today ? usd(today.open) : null,
      // 오늘 봉은 최대 1분 전 것이라 현재가가 그 고가·저가를 넘었을 수 있다
      high: today ? Math.max(usd(today.high), price) : null,
      low: today ? Math.min(usd(today.low), price) : null,
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
      const rows = (await this.client.get<Json[]>("/api/v1/stocks/all", { market: m, status: "ACTIVE" }, {}, { timeoutMs: MASTER_TIMEOUT_MS })) ?? [];
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
    accountEvaluation: TossAccountTotals | null;
    /** 원본의 양수 보유를 빠짐없이 해석했을 때만 계좌 손익 원금을 합산할 수 있다. */
    costBasisComplete: boolean;
  }> {
    const r = await this.client.get<Json>("/api/v1/holdings", {}, { "X-Tossinvest-Account": String(accountSeq) });
    // 본문이 빈 200 은 일시 오류로 본다 (빈 목록으로 받아들이면 전량 매도로 처리돼 보유·원화 장부가 지워진다)
    if (!r || !Array.isArray(r["items"])) throw new ProviderError(this.name, "보유 종목 응답이 비었습니다 (/api/v1/holdings)");
    const purchase = (r["totalPurchaseAmount"] as Json | undefined) ?? null;
    const after = (((r["marketValue"] as Json | undefined) ?? {})["amountAfterCost"] as Json | undefined) ?? null;
    const rate = num(((r["profitLoss"] as Json | undefined) ?? {})["rateAfterCost"]);
    const items = parseHoldingItems(r["items"] as Json[]);
    const accountEvaluation = parseTossAccountTotals(r);
    const heldCount = (r["items"] as Json[]).filter((it) => (num(it?.["quantity"]) ?? 0) > 0).length;
    return {
      items,
      accountEvaluation,
      costBasisComplete: accountEvaluation !== null && heldCount === items.length,
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
   * 매매 기록(3-36)용 주문 내역: 종료된 주문(CLOSED, 100건씩 cursor 페이지, 최대 maxPages) + 진행 중 주문(OPEN) 가운데 체결 수량이 있는 것.
   * 원화 장부(ordersForBook)와 같은 경로·칸을 읽고, 저장용으로 주문 상태와 원본(계좌번호 칸은 뺌)을 함께 준다.
   * 주문 하나 = 한 줄이고 부분 체결은 누적 수량·금액·마지막 체결 시각으로 온다. 페이지 경계에서 같은 주문이 두 번 올 수 있다(호출한 쪽이 주문번호로 합친다).
   * 토스가 과거를 어디까지 주는지는 API 범위에 달려 있다 — 받은 만큼만 준다. 오류는 그대로 던진다.
   * 종료된 주문이 maxPages(원화 장부와 같은 50쪽 = 5,000건)를 넘어 다음 쪽이 남았으면 truncated — 오래된 주문이 빠졌다는 표시(호출한 쪽이 경고)
   */
  async orderHistory(accountSeq: number, symbol: string, maxPages = 50): Promise<TossOrderHistory> {
    const out: TossOrderRecord[] = [];
    const take = (orders: Json[] | undefined, status: "CLOSED" | "OPEN") => {
      for (const o of orders ?? []) {
        const ex = (o["execution"] as Json | undefined) ?? {};
        const quantity = num(ex["filledQuantity"]) ?? 0;
        const amount = num(ex["filledAmount"]);
        const side = o["side"] === "SELL" ? "SELL" : o["side"] === "BUY" ? "BUY" : null;
        const orderId = typeof o["orderId"] === "string" ? o["orderId"] : null;
        if (!(quantity > 0) || amount === null || !side || !orderId) continue;
        const cur = o["currency"] ?? ex["currency"];
        const raw: Json = { ...o };
        for (const k of Object.keys(raw)) if (/^account(No|Number)$/i.test(k)) delete raw[k];
        out.push({
          orderId,
          symbol: String(o["symbol"] ?? symbol).toUpperCase() || symbol,
          side,
          status,
          quantity,
          amount,
          currency: cur === "USD" || cur === "KRW" ? cur : null,
          filledAt: typeof ex["filledAt"] === "string" ? ex["filledAt"] : null,
          orderedAt: typeof o["orderedAt"] === "string" ? o["orderedAt"] : null,
          raw,
        });
      }
    };
    const headers = { "X-Tossinvest-Account": String(accountSeq) };
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.client.get<{ orders?: Json[]; nextCursor?: string | null; hasNext?: boolean }>("/api/v1/orders", { status: "CLOSED", symbol, limit: 100, cursor }, headers);
      take(r?.orders, "CLOSED");
      if (!r?.hasNext || !r.nextCursor) break;
      cursor = r.nextCursor;
      if (page === maxPages - 1) truncated = true; // 다음 쪽이 남았는데 더 받지 않음
    }
    const open = await this.client.get<{ orders?: Json[] }>("/api/v1/orders", { status: "OPEN", symbol }, headers);
    take(open?.orders, "OPEN");
    return { orders: out, truncated };
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

/** 매매 기록용 주문 내역 (orderHistory). truncated = 쪽 수 한도에 걸려 오래된 종료 주문을 다 받지 못함 */
export interface TossOrderHistory {
  orders: TossOrderRecord[];
  truncated: boolean;
}

/** 매매 기록용 주문 한 줄 (orderHistory). quantity·amount 는 누적 체결 수량·금액(종목 통화) */
export interface TossOrderRecord {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  /** 받은 목록: 종료된 주문(CLOSED) 또는 진행 중 주문(OPEN, 부분 체결) */
  status: "CLOSED" | "OPEN";
  quantity: number;
  amount: number;
  /** 응답에 통화 칸이 있으면 그 값, 없으면 null (저장할 때 종목 코드로 정함) */
  currency: "KRW" | "USD" | null;
  /** 마지막 체결 시각 (없으면 null — 저장할 때 주문 시각으로 대신하고 그렇게 표시) */
  filledAt: string | null;
  orderedAt: string | null;
  /** 원본 주문 (계좌번호 칸은 뺌). 수수료·세금 칸이 있는지는 운영에서 확인한 뒤 3-37 에서 꺼내 쓴다 */
  raw: Record<string, unknown>;
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
