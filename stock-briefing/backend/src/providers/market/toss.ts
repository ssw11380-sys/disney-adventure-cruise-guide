import { isIntraday, type AfterMarketQuote, type Candle, type CandlePeriod, type CandleSeries, type ListedStock, type Market, type Quote } from "../../domain/types.js";
import { CODE_RE, isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import { seoulIso } from "../../lib/time.js";
import type { LiveTick, StockSessionFacts } from "./tossRealtime.js";
import type { FetchFn, QuoteProvider, StockSearchProvider } from "./types.js";

/**
 * 토스증권 웹(tossinvest.com)이 쓰는 내부 API. 공식 개발자 API 가 아니라 예고 없이 바뀔 수 있으므로
 * 체인에서 실패하면 네이버/Yahoo 로 넘어간다. 키 불필요.
 *
 *  - 시세:   GET  /api/v3/stock-prices?productCodes=A035420,US20100629001
 *            한국은 KRX+NXT "통합" 가격(토스 앱에 보이는 그 숫자), 미국은 USD + 원화 환산.
 *  - 봉:     GET  /api/v1/c-chart/{kr-s|us-s}/{productCode}/{day|week|month}:1?count=N  (최신순, N 은 450 까지), 분봉은 min:1|min:5|min:30
 *  - 종목:   GET  /api/v2/stock-infos/{productCode}  (이름, 시장, 발행주식수 → 시가총액)
 *            GET  /api/v1/stock-infos?codes=A035420,US20100629001  (200개씩: 주간거래·NXT 대상, 거래정지, ETF·ETN → 초록 점의 세션 자격)
 *  - 검색:   POST /api/v3/search-all/wts-auto-complete  (한글로 미국 종목 검색 가능: "테슬라" → TSLA)
 *
 * 상품 코드: 한국은 "A"+종목코드. 미국은 "US20100629001" 같은 내부 코드라 티커로 검색해서 알아낸 뒤
 * 메모리 + (주입된) 저장소에 캐시한다.
 */

const BASE = "https://wts-info-api.tossinvest.com/api";
/** 토스 웹 요청 하나의 최대 대기 (응답이 멈추면 시세 체인이 다음 소스로 넘어가게) */
const REQUEST_TIMEOUT_MS = 8_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const TOSS_MARKET: Record<string, Market> = { KSP: "KOSPI", KSQ: "KOSDAQ", NSQ: "NASDAQ", NYS: "NYSE", AMX: "AMEX" };
const PERIOD_PATH: Record<CandlePeriod, string> = { "1m": "min:1", "5m": "min:5", "30m": "min:30", D: "day", W: "week", M: "month" };
/** 세션 자격(주간거래·NXT 대상·거래정지)을 다시 받는 간격 — 거래정지는 장중에도 바뀔 수 있어 하루가 아니라 1시간 */
const SESSION_INFO_TTL_MS = 60 * 60_000;
/** 세션 자격 조회가 실패하면 이만큼 쉰다 (그동안은 모름으로 → 체결 증거가 있는 종목만 점) */
const SESSION_INFO_RETRY_MS = 5 * 60_000;
/** stock-infos 일괄 조회 한 번에 넣는 종목 수 */
const SESSION_INFO_BATCH = 200;
/** c-chart 가 한 번에 주는 봉 최대 개수. 넘게 청하면 HTTP 400 이라(일봉 800·1분봉 600 등) 이만큼으로 줄여 받는다 */
const CHART_MAX_COUNT = 450;
/**
 * 환율을 새로 받지 못해도 마지막 값을 쓰는 한도. 잠깐 실패하면 출처가 오락가락하지 않게 마지막 값, 넘으면 null →
 * 다음 소스(토스 Open API 매매기준율 → 네이버)로 넘어간다 (예전: 한 번 받은 값을 장애 내내 썼다)
 */
const FX_KEEP_MS = 5 * 60_000;

interface SessionInfo {
  at: number;
  daytime: boolean | null;
  nxt: boolean | null;
  halted: boolean | null;
  nxtHalted: boolean | null;
  etp: boolean | null;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/**
 * stock-infos 한 행 → 세션 자격. 칸이 없으면 모름(null). 거래정지는 둘 중 하나라도 true 면 정지.
 * ETF·ETN 은 상품 구분(group.code: ST 주권 · FS 외국주권 · EF ETF · EN ETN …)으로 — 한국거래소 애프터마켓 대상이 아니다
 */
export function parseSessionInfo(r: Record<string, unknown>, at: number): SessionInfo {
  const stops = [bool(r["tradingSuspended"]), bool(r["krxTradingSuspended"])];
  const group = (r["group"] as Record<string, unknown> | null | undefined)?.["code"];
  return {
    at,
    daytime: bool(r["daytimePriceSupported"]),
    nxt: bool(r["nxtSupported"]),
    halted: stops.includes(true) ? true : stops.every((x) => x === null) ? null : false,
    nxtHalted: bool(r["nxtTradingSuspended"]),
    etp: typeof group === "string" && group ? group === "EF" || group === "EN" : null,
  };
}

type Json = Record<string, unknown>;

/** 티커 → 토스 상품 코드 매핑을 재시작 후에도 남기기 위한 저장소 (meta 테이블 등) */
export interface CodeStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

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

export function tossMarket(code: string | undefined): Market {
  return (code ? TOSS_MARKET[code] : undefined) ?? "UNKNOWN";
}

export class TossProvider implements QuoteProvider, StockSearchProvider {
  readonly name = "toss";
  private readonly codeCache = new Map<string, string>();
  private readonly infoCache = new Map<string, { at: number; info: Json }>();

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly store: CodeStore | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = `${BASE}${path}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "user-agent": UA,
          accept: "application/json",
          referer: "https://tossinvest.com/",
          origin: "https://tossinvest.com",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
      });
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ProviderError(this.name, `JSON 파싱 실패: ${url}`, e);
    }
    const result = (json as Json)?.["result"];
    if (result === undefined) throw new ProviderError(this.name, `응답에 result 가 없습니다: ${url}`);
    return result;
  }

  // ── 검색 ────────────────────────────────────────────────────────

  async search(query: string, limit: number): Promise<ListedStock[]> {
    const q = query.trim();
    if (!q) return [];
    const result = (await this.request("/v3/search-all/wts-auto-complete", {
      method: "POST",
      body: JSON.stringify({ query: q, sections: [{ type: "PRODUCT" }] }),
    })) as Array<{ type?: string; data?: { items?: Json[] } }>;
    const items = result.find((s) => s.type === "PRODUCT")?.data?.items ?? [];
    const out: ListedStock[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const listed = toListed(it);
      if (!listed || seen.has(listed.code)) continue;
      seen.add(listed.code);
      const productCode = String(it["productCode"] ?? "");
      if (productCode && !isKrCode(listed.code)) this.codeCache.set(listed.code, productCode);
      out.push(listed);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── 상품 코드 ────────────────────────────────────────────────────

  async productCode(code: string): Promise<string> {
    if (isKrCode(code)) return `A${code}`;
    const cached = this.codeCache.get(code);
    if (cached) return cached;
    const stored = await this.store?.get(`toss:product:${code}`).catch(() => null);
    if (stored) {
      this.codeCache.set(code, stored);
      return stored;
    }
    const result = (await this.request("/v3/search-all/wts-auto-complete", {
      method: "POST",
      body: JSON.stringify({ query: code, sections: [{ type: "PRODUCT" }] }),
    })) as Array<{ type?: string; data?: { items?: Json[] } }>;
    const items = result.find((s) => s.type === "PRODUCT")?.data?.items ?? [];
    const hit = items.find((it) => String(it["symbol"] ?? "").toUpperCase() === code && !isKrMarket(String(it["market"] ?? "")));
    const productCode = hit ? String(hit["productCode"] ?? "") : "";
    if (!productCode) throw new ProviderError(this.name, `토스에서 티커 ${code} 를 찾지 못했습니다`);
    this.codeCache.set(code, productCode);
    await this.store?.set(`toss:product:${code}`, productCode).catch(() => undefined);
    return productCode;
  }

  private async stockInfo(productCode: string): Promise<Json | null> {
    const hit = this.infoCache.get(productCode);
    const t = this.now().getTime();
    if (hit && t - hit.at < 24 * 3_600_000) return hit.info;
    try {
      const info = (await this.request(`/v2/stock-infos/${productCode}`)) as Json;
      this.infoCache.set(productCode, { at: t, info });
      return info;
    } catch {
      return null; // 부가 정보라 실패해도 시세는 낸다
    }
  }

  // ── 시세 ────────────────────────────────────────────────────────

  async getQuote(code: string): Promise<Quote> {
    code = normalizeCode(code);
    const pc = await this.productCode(code);
    const kr = isKrCode(code);
    const [prices, chart, info] = await Promise.all([
      this.request(`/v3/stock-prices?productCodes=${encodeURIComponent(pc)}`) as Promise<Json[]>,
      this.fetchChart(pc, kr, "D", 260).catch(() => [] as Candle[]),
      this.stockInfo(pc),
    ]);
    const p = prices.find((x) => String(x["productCode"] ?? "") === pc) ?? prices[0];
    if (!p) throw new ProviderError(this.name, `${code} 시세 없음`);
    const price = num(p["close"]);
    const base = num(p["base"]);
    if (price === null) throw new ProviderError(this.name, `${code} 현재가 없음`);
    // 등락률은 반올림 전 차이로 (센트로 반올림한 등락으로 내면 1달러 미만 미국 종목이 0.00% 가 된다), 등락은 소수 4자리까지
    const change = base !== null ? round4(price - base) : 0;
    const changeRate = base ? round2(((price - base) / base) * 100) : 0;
    const currency = String(p["currency"] ?? (kr ? "KRW" : "USD")) === "USD" ? "USD" : "KRW";
    const latest = chart.at(-1) ?? null; // 오늘(또는 마지막 거래일) 봉
    const shares = num(info?.["sharesOutstanding"]);
    const highs = chart.map((c) => c.high);
    const lows = chart.map((c) => c.low);
    const afterClose = num(p["afterMarketClose"]);
    const afterMarket: AfterMarketQuote | null =
      !kr && afterClose && afterClose > 0 && afterClose !== price
        ? {
            venue: "US",
            session: "AFTER_MARKET",
            status: "CLOSE",
            price: afterClose,
            change: round2(afterClose - (base ?? price)),
            changeRate: base ? round2(((afterClose - base) / base) * 100) : 0,
            volume: null,
            asOf: seoulIso(this.now()),
          }
        : null;
    return {
      code,
      currency,
      price,
      change,
      changeRate,
      open: latest?.open ?? null,
      high: latest?.high ?? null,
      low: latest?.low ?? null,
      prevClose: base,
      volume: num(p["volume"]) ?? latest?.volume ?? null,
      marketCap: shares !== null ? Math.round(price * shares) : null,
      per: null,
      pbr: null,
      eps: null,
      bps: null,
      high52w: highs.length ? Math.max(...highs) : null,
      low52w: lows.length ? Math.min(...lows) : null,
      asOf: seoulIso(this.now()),
      source: this.name,
      priceBasis: kr ? "KRX+NXT 통합" : usPriceBasis(latest?.date ?? null, this.now()),
      priceKrw: currency === "USD" ? num(p["closeKrw"]) : null,
      afterMarket,
    };
  }

  // ── 실시간에 가까운 현재가 (여러 종목 한 번에) ───────────────────────

  /** 종목별 마지막 일괄 시세 (2초 안이면 다시 부르지 않는다 — 목록·상세·기준가가 같은 값을 나눠 쓴다) */
  private readonly tickCache = new Map<string, LiveTick>();
  /** 일괄 시세에 가격이 없던 코드(모르는 티커 등)를 물은 시각 — 2초 안에는 그 코드 때문에 다시 부르지 않는다 */
  private readonly tickMissAt = new Map<string, number>();
  /** 나가 있는 일괄 시세 요청 (같은 종목을 동시에 물으면 이것을 같이 기다린다) */
  private readonly manyInflight: Array<{ codes: Set<string>; p: Promise<Map<string, LiveTick>> }> = [];
  /**
   * 종목별 기준가(base) — 일괄 시세(getMany)를 받을 때마다 채운다. 기준가는 거래일마다 한 번 바뀌므로
   * 다음 거래 시작(nextTradingStart) 전까지는 새로 받지 못해도 마지막 값을 쓴다
   */
  private readonly baseCache = new Map<string, { at: number; base: number; until: number }>();
  private readonly baseInflight = new Map<string, Promise<number | null>>();
  /** 일괄 시세가 마지막으로 실패한 시각 — 잠시 동안 종목마다 다시 부르지 않는다 (장애 때 요청이 불어나지 않게) */
  private pricesFailedAt = 0;
  /** 토스 웹이 기준가를 주지 않은 코드(예: 상품코드가 Q 로 시작하는 ETN) — 10분 동안 다시 묻지 않는다 */
  private readonly baseMissing = new Map<string, number>();
  private fxCache: { at: number; rate: number } | null = null;
  /** 종목별 세션 자격 (stock-infos, 1시간) */
  private readonly sessionInfo = new Map<string, SessionInfo>();
  /** 종목별 토스 시세 거래소 구분 ("integrated" = KRX+NXT, "krx") — 일괄 시세를 받을 때마다 */
  private readonly exchangeOf = new Map<string, string>();
  private sessionInfoFailedAt = -Infinity;
  private sessionInfoInflight: Promise<void> | null = null;

  /**
   * 토스 앱이 달러 종목을 원화로 보여줄 때 쓰는 환율 (1분 캐시). 시세 응답의 closeKrw / close 로 구한다.
   * 토스 계좌 화면의 원화 평가금과 같은 숫자를 내려면 매매기준율(하나은행·토스 Open API midRate)이 아니라 이 값을 써야 한다.
   */
  async usdKrw(): Promise<number | null> {
    const t = this.now().getTime();
    if (this.fxCache && t - this.fxCache.at < 60_000) return this.fxCache.rate;
    const kept = () => (this.fxCache && t - this.fxCache.at < FX_KEEP_MS ? this.fxCache.rate : null);
    try {
      // 거래가 많은 미국 종목 몇 개(애플·테슬라·엔비디아)의 비율 중앙값
      const rows = (await this.request(`/v3/stock-prices?productCodes=US19801212001,US20100629001,US19990122001`)) as Json[];
      const rates = rows
        .map((r) => {
          const usd = num(r["close"]), krw = num(r["closeKrw"]);
          return usd && krw && usd > 0 ? krw / usd : null;
        })
        .filter((x): x is number => x !== null && x > 500 && x < 5000)
        .sort((a, b) => a - b);
      if (rates.length === 0) return kept();
      const rate = Math.round(rates[Math.floor(rates.length / 2)]! * 100) / 100;
      this.fxCache = { at: t, rate };
      return rate;
    } catch {
      return kept();
    }
  }

  /**
   * 등록 종목 전체의 현재가를 요청 1개로 받는다 (stock-prices 는 코드를 콤마로 여러 개 받음).
   * 앱이 3초마다 물어봐도 토스에는 2초에 한 번만 나간다. 통합 가격(KRX+NXT)이라 toss 계열 시세에만 덮어쓴다.
   */
  async getMany(codes: string[]): Promise<Map<string, LiveTick>> {
    const list = [...new Set(codes.map(normalizeCode))].filter((c) => CODE_RE.test(c));
    if (list.length === 0) return new Map();
    const t = this.now().getTime();
    const fresh = (c: string) => {
      const x = this.tickCache.get(c);
      return (x !== undefined && t - x.receivedAt < 2000) || t - (this.tickMissAt.get(c) ?? -Infinity) < 2000;
    };
    const pick = () => {
      const n = this.now().getTime();
      return new Map(
        list.flatMap((c) => {
          const x = this.tickCache.get(c);
          return x && n - x.receivedAt < 2000 ? [[c, x] as [string, LiveTick]] : [];
        }),
      );
    };
    if (list.every(fresh)) return pick();
    // 같은 종목을 받는 요청이 이미 나가 있으면 새로 보내지 않고 그 응답을 같이 기다린다 (잔고·기준가·실시간 폴링이 동시에 물을 때)
    const running = this.manyInflight.find((x) => list.every((c) => x.codes.has(c)));
    if (running) {
      await running.p;
      return pick();
    }
    const entry = { codes: new Set(list), p: this.fetchMany(list) };
    this.manyInflight.push(entry);
    try {
      return await entry.p;
    } finally {
      this.manyInflight.splice(this.manyInflight.indexOf(entry), 1);
    }
  }

  private async fetchMany(list: string[]): Promise<Map<string, LiveTick>> {
    const out = new Map<string, LiveTick>();
    const t = this.now().getTime();
    const pcs: Array<[string, string]> = [];
    for (const c of list) {
      try {
        pcs.push([c, await this.productCode(c)]);
      } catch {
        this.tickMissAt.set(c, t); // 모르는 티커는 건너뜀
      }
    }
    if (pcs.length === 0) return out;
    let rows: Json[];
    try {
      rows = (await this.request(`/v3/stock-prices?productCodes=${encodeURIComponent(pcs.map((p) => p[1]).join(","))}`)) as Json[];
    } catch (e) {
      this.pricesFailedAt = this.now().getTime();
      throw e;
    }
    const byPc = new Map(rows.map((r) => [String(r["productCode"] ?? ""), r]));
    const nowIso = seoulIso(this.now());
    const got = this.now().getTime(); // 받은 시각 (응답이 늦어도 같이 기다린 호출이 2초 안의 값으로 본다)
    for (const [code, pc] of pcs) {
      const r = byPc.get(pc);
      const price = num(r?.["close"]);
      const base = num(r?.["base"]);
      if (!r || base === null || base <= 0) this.baseMissing.set(code, t);
      else this.baseMissing.delete(code);
      if (r && base !== null && base > 0) {
        const next = Date.parse(String(r["nextTradingStart"] ?? ""));
        this.baseCache.set(code, { at: t, base, until: Number.isNaN(next) || next <= t ? t + 60_000 : next });
      }
      const exchange = r?.["exchange"];
      if (typeof exchange === "string" && exchange) this.exchangeOf.set(code, exchange);
      if (!r || price === null) {
        this.tickMissAt.set(code, t);
        continue;
      }
      const tick = { code, price, volume: num(r["volume"]), timestamp: nowIso, receivedAt: got };
      this.tickCache.set(code, tick);
      this.tickMissAt.delete(code);
      out.set(code, tick);
    }
    return out;
  }

  /**
   * 여러 종목 기준가를 한 번에: 1분 안에 받은 값은 그대로, 모자라면 일괄 시세 1회로 채운다.
   * 토스 웹이 방금(30초 안) 실패했으면 부르지 않고 아직 유효한(같은 거래일) 마지막 값만 쓴다
   */
  async baseMany(codes: string[]): Promise<Map<string, number>> {
    const list = [...new Set(codes.map(normalizeCode))];
    const t = this.now().getTime();
    const valid = (c: string) => {
      const h = this.baseCache.get(c);
      return h && this.now().getTime() < h.until ? h.base : null;
    };
    const recent = (c: string) => {
      const h = this.baseCache.get(c);
      return (h && t - h.at < 60_000 && valid(c) !== null) || t - (this.baseMissing.get(c) ?? -Infinity) < 10 * 60_000;
    };
    if (!list.every(recent) && t - this.pricesFailedAt >= 30_000) await this.getMany(list).catch(() => undefined);
    const out = new Map<string, number>();
    for (const c of list) {
      const b = valid(c);
      if (b !== null) out.set(c, b);
    }
    return out;
  }

  /**
   * 기준가(전일 종가) — 토스 앱·네이버가 전일 대비 등락을 재는 값. 한국은 KRX 종가(배당락 등은 조정 기준가), 상장 첫날은 공모가.
   * 최근 1분 안에 일괄 시세로 받은 값이 있으면 요청 없이 쓴다
   */
  async basePrice(code: string): Promise<number | null> {
    code = normalizeCode(code);
    const t = this.now().getTime();
    const valid = (h: { base: number; until: number } | undefined) => (h && this.now().getTime() < h.until ? h.base : null);
    const hit = this.baseCache.get(code);
    // 1분 안에 받은 값이면 그대로. 토스 웹이 방금(30초 안) 실패했으면 부르지 않고 아직 유효한 마지막 값(같은 거래일)을 쓴다
    if (hit && t - hit.at < 60_000 && valid(hit) !== null) return hit.base;
    if (t - this.pricesFailedAt < 30_000) return valid(hit);
    if (t - (this.baseMissing.get(code) ?? -Infinity) < 10 * 60_000) return null;
    let p = this.baseInflight.get(code);
    if (!p) {
      p = this.getMany([code])
        .then(
          () => valid(this.baseCache.get(code)),
          () => valid(this.baseCache.get(code)),
        )
        .finally(() => this.baseInflight.delete(code));
      this.baseInflight.set(code, p);
    }
    return p;
  }

  // ── 세션 사실 (초록 점: services/liveSession) ──────────────────────

  /**
   * 종목별 세션 사실: 주간거래·NXT 대상·거래정지(stock-infos), 토스 시세 거래소 구분, 마지막으로 가격을 받은 시각.
   * 받아 둔 값만 바로 돌려준다(잔고 응답을 기다리게 하지 않는다). 없거나 1시간 지난 종목은 뒤에서 일괄로 새로 받는다
   */
  sessionFacts(codes: string[]): Map<string, StockSessionFacts> {
    const list = [...new Set(codes.map(normalizeCode))].filter((c) => CODE_RE.test(c));
    void this.refreshSessionInfos(list);
    const out = new Map<string, StockSessionFacts>();
    for (const c of list) {
      const info = this.sessionInfo.get(c);
      const tick = this.tickCache.get(c);
      out.set(c, {
        daytime: info?.daytime ?? null,
        nxt: info?.nxt ?? null,
        halted: info?.halted ?? null,
        nxtHalted: info?.nxtHalted ?? null,
        etp: info?.etp ?? null,
        exchange: this.exchangeOf.get(c) ?? null,
        // 그 뒤 일괄 시세가 실패했으면(토스 웹 장애) 받는 중이 아니다
        pricedAt: tick && tick.receivedAt > this.pricesFailedAt ? tick.receivedAt : null,
      });
    }
    return out;
  }

  /** 세션 자격을 새로 받는다 (없거나 1시간 지난 종목만, 200개씩 한 번에). 실패하면 5분 쉬고, 나가 있는 요청이 있으면 그것을 기다린다 */
  refreshSessionInfos(codes: string[]): Promise<void> {
    if (this.sessionInfoInflight) return this.sessionInfoInflight;
    const t = this.now().getTime();
    if (t - this.sessionInfoFailedAt < SESSION_INFO_RETRY_MS) return Promise.resolve();
    const need = [...new Set(codes.map(normalizeCode))].filter((c) => {
      const h = this.sessionInfo.get(c);
      return CODE_RE.test(c) && (!h || t - h.at >= SESSION_INFO_TTL_MS);
    });
    if (need.length === 0) return Promise.resolve();
    const p = this.fetchSessionInfos(need)
      .catch(() => {
        this.sessionInfoFailedAt = this.now().getTime();
      })
      .finally(() => {
        this.sessionInfoInflight = null;
      });
    this.sessionInfoInflight = p;
    return p;
  }

  private async fetchSessionInfos(codes: string[]): Promise<void> {
    const pcs: Array<[string, string]> = [];
    for (const c of codes) {
      try {
        pcs.push([c, await this.productCode(c)]);
      } catch {
        /* 모르는 티커는 건너뜀 (자격 모름) */
      }
    }
    for (let i = 0; i < pcs.length; i += SESSION_INFO_BATCH) {
      const batch = pcs.slice(i, i + SESSION_INFO_BATCH);
      const rows = await this.request(`/v1/stock-infos?codes=${batch.map((p) => encodeURIComponent(p[1])).join(",")}`);
      const byPc = new Map((Array.isArray(rows) ? (rows as Json[]) : []).map((r) => [String(r["code"] ?? ""), r]));
      const at = this.now().getTime();
      for (const [code, pc] of batch) {
        const r = byPc.get(pc);
        // 응답에 없는 종목도 받은 것으로 적어 1시간 동안 다시 묻지 않는다 (자격은 모름)
        this.sessionInfo.set(code, r ? parseSessionInfo(r, at) : { at, daytime: null, nxt: null, halted: null, nxtHalted: null, etp: null });
      }
    }
  }

  private async fetchChart(productCode: string, kr: boolean, period: CandlePeriod, count: number): Promise<Candle[]> {
    const intraday = isIntraday(period);
    // 한 번에 450개까지만 준다 (넘으면 HTTP 400) → 더 많이 청하면 최근 450개만 (이어 받는 쿼리는 확인하지 못했다)
    const n = Math.min(count, CHART_MAX_COUNT);
    const path = `/v1/c-chart/${kr ? "kr-s" : "us-s"}/${encodeURIComponent(productCode)}/${PERIOD_PATH[period]}${intraday ? "" : ":1"}?count=${n}`;
    const result = (await this.request(path)) as { candles?: Json[] };
    const out: Candle[] = [];
    for (const c of result.candles ?? []) {
      const dt = String(c["dt"] ?? "");
      const o = num(c["open"]), h = num(c["high"]), l = num(c["low"]), cl = num(c["close"]);
      if (!/^\d{4}-\d{2}-\d{2}/.test(dt) || o === null || h === null || l === null || cl === null) continue;
      out.push({ date: dt.slice(0, 10), ...(intraday ? { time: dt } : {}), open: o, high: h, low: l, close: cl, volume: num(c["volume"]) ?? 0 });
    }
    // 토스는 최신순 → 오래된 순으로. 분봉은 시각(오프셋 포함)으로 정렬
    const keyOf = (c: Candle) => (c.time ? Date.parse(c.time) : Date.parse(`${c.date}T00:00:00Z`));
    out.sort((a, b) => keyOf(a) - keyOf(b));
    return out;
  }

  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    code = normalizeCode(code);
    const pc = await this.productCode(code);
    const candles = await this.fetchChart(pc, isKrCode(code), period, count);
    if (candles.length === 0) throw new ProviderError(this.name, `${code} 봉 데이터 없음`);
    return { code, period, candles: candles.slice(-count), source: this.name };
  }
}

function isKrMarket(market: string): boolean {
  return market === "KSP" || market === "KSQ";
}

const NY_CLOCK = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 토스 웹 미국 시세(close)가 어느 거래의 가격인지 (priceBasis). 토스는 뉴욕 20:00 부터 다음 거래일 봉을 새로 열어 주간거래(·프리마켓) 체결을 넣고
 * close 도 그 봉의 가격이 된다. 정규장이 끝난 뒤의 애프터마켓 체결은 봉·close 에 넣지 않는다 (afterMarketClose 로 따로 → afterMarket).
 *  - 마지막 봉이 뉴욕 오늘보다 뒤 날짜(20:00 뒤)이거나 오늘 봉인데 04:00 전: "주간거래" (한국 낮)
 *  - 오늘 봉인데 04:00~09:30 (프리마켓 — 주간거래 체결일 수도 있다): "최근 체결(시간외 포함)"
 *  - 그 밖 (정규장 중·마감 뒤·주말·휴장일, 주간거래 체결이 없어 새 봉이 없는 종목): "정규장"
 *  - 봉을 받지 못해 모르면 공식 API 와 같은 "최근 체결(시간외 포함)"
 */
function usPriceBasis(latestDate: string | null, now: Date): string {
  if (!latestDate) return "최근 체결(시간외 포함)";
  const p: Record<string, string> = {};
  for (const x of NY_CLOCK.formatToParts(now)) p[x.type] = x.value;
  const today = `${p["year"]}-${p["month"]}-${p["day"]}`;
  const minutes = (Number(p["hour"]) % 24) * 60 + Number(p["minute"]);
  if (latestDate > today || (latestDate === today && minutes < 4 * 60)) return "주간거래";
  if (latestDate === today && minutes < 9 * 60 + 30) return "최근 체결(시간외 포함)";
  return "정규장";
}

function toListed(it: Json): ListedStock | null {
  const marketCode = String(it["market"] ?? "");
  const code = String(it["symbol"] ?? "").toUpperCase(); // 한국은 6자리 코드, 미국은 티커가 그대로 온다
  if (!CODE_RE.test(code)) return null;
  if (isKrMarket(marketCode) !== isKrCode(code)) return null; // 시장과 코드 형식이 어긋나면 제외
  const status = String(it["stockStatus"] ?? "N");
  if (status !== "N") return null; // 상장폐지 등
  const companyCode = String(it["companyCode"] ?? "");
  const kr = isKrMarket(marketCode);
  const close = it["close"] as Json | undefined;
  const base = it["base"] as Json | undefined;
  const price = num(kr ? close?.["krw"] : close?.["usd"]);
  const basePrice = num(kr ? base?.["krw"] : base?.["usd"]);
  return {
    code,
    name: String(it["productName"] ?? it["keyword"] ?? code),
    market: tossMarket(marketCode),
    isinCode: null,
    groupCode: companyCode.startsWith("EF") ? "EF" : "ST",
    price,
    changeRate: price !== null && basePrice ? round2(((price - basePrice) / basePrice) * 100) : null,
    currency: kr ? "KRW" : "USD",
  };
}
