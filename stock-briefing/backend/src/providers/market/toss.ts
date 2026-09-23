import { isIntraday, type AfterMarketQuote, type Candle, type CandlePeriod, type CandleSeries, type ListedStock, type Market, type Quote } from "../../domain/types.js";
import { CODE_RE, isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import { seoulIso } from "../../lib/time.js";
import type { LiveTick } from "./tossRealtime.js";
import type { FetchFn, QuoteProvider, StockSearchProvider } from "./types.js";

/**
 * 토스증권 웹(tossinvest.com)이 쓰는 내부 API. 공식 개발자 API 가 아니라 예고 없이 바뀔 수 있으므로
 * 체인에서 실패하면 네이버/Yahoo 로 넘어간다. 키 불필요.
 *
 *  - 시세:   GET  /api/v3/stock-prices?productCodes=A035420,US20100629001
 *            한국은 KRX+NXT "통합" 가격(토스 앱에 보이는 그 숫자), 미국은 USD + 원화 환산.
 *  - 봉:     GET  /api/v1/c-chart/{kr-s|us-s}/{productCode}/{day|week|month}:1?count=N  (최신순), 분봉은 min:1|min:5|min:30
 *  - 종목:   GET  /api/v2/stock-infos/{productCode}  (이름, 시장, 발행주식수 → 시가총액)
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
    const change = base !== null ? round2(price - base) : 0;
    const changeRate = base ? round2((change / base) * 100) : 0;
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
      priceBasis: kr ? "KRX+NXT 통합" : "정규장",
      priceKrw: currency === "USD" ? num(p["closeKrw"]) : null,
      afterMarket,
    };
  }

  // ── 실시간에 가까운 현재가 (여러 종목 한 번에) ───────────────────────

  private quickCache: { at: number; key: string; map: Map<string, LiveTick> } | null = null;
  /**
   * 종목별 기준가(base) — 일괄 시세(getMany)를 받을 때마다 채운다. 기준가는 거래일마다 한 번 바뀌므로
   * 다음 거래 시작(nextTradingStart) 전까지는 새로 받지 못해도 마지막 값을 쓴다
   */
  private readonly baseCache = new Map<string, { at: number; base: number; until: number }>();
  private readonly baseInflight = new Map<string, Promise<number | null>>();
  /** 일괄 시세가 마지막으로 실패한 시각 — 잠시 동안 종목마다 다시 부르지 않는다 (장애 때 요청이 불어나지 않게) */
  private pricesFailedAt = 0;
  private fxCache: { at: number; rate: number } | null = null;

  /**
   * 토스 앱이 달러 종목을 원화로 보여줄 때 쓰는 환율 (1분 캐시). 시세 응답의 closeKrw / close 로 구한다.
   * 토스 계좌 화면의 원화 평가금과 같은 숫자를 내려면 매매기준율(하나은행·토스 Open API midRate)이 아니라 이 값을 써야 한다.
   */
  async usdKrw(): Promise<number | null> {
    const t = this.now().getTime();
    if (this.fxCache && t - this.fxCache.at < 60_000) return this.fxCache.rate;
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
      if (rates.length === 0) return this.fxCache?.rate ?? null;
      const rate = Math.round(rates[Math.floor(rates.length / 2)]! * 100) / 100;
      this.fxCache = { at: t, rate };
      return rate;
    } catch {
      return this.fxCache?.rate ?? null;
    }
  }

  /**
   * 등록 종목 전체의 현재가를 요청 1개로 받는다 (stock-prices 는 코드를 콤마로 여러 개 받음).
   * 앱이 3초마다 물어봐도 토스에는 2초에 한 번만 나간다. 통합 가격(KRX+NXT)이라 toss 계열 시세에만 덮어쓴다.
   */
  async getMany(codes: string[]): Promise<Map<string, LiveTick>> {
    const list = [...new Set(codes.map(normalizeCode))].filter((c) => CODE_RE.test(c));
    const out = new Map<string, LiveTick>();
    if (list.length === 0) return out;
    const key = list.join(",");
    const t = this.now().getTime();
    if (this.quickCache && this.quickCache.key === key && t - this.quickCache.at < 2000) return this.quickCache.map;
    const pcs: Array<[string, string]> = [];
    for (const c of list) {
      try {
        pcs.push([c, await this.productCode(c)]);
      } catch {
        /* 모르는 티커는 건너뜀 */
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
    for (const [code, pc] of pcs) {
      const r = byPc.get(pc);
      const price = num(r?.["close"]);
      const base = num(r?.["base"]);
      if (r && base !== null && base > 0) {
        const next = Date.parse(String(r["nextTradingStart"] ?? ""));
        this.baseCache.set(code, { at: t, base, until: Number.isNaN(next) || next <= t ? t + 60_000 : next });
      }
      if (!r || price === null) continue;
      out.set(code, { code, price, volume: num(r["volume"]), timestamp: nowIso, receivedAt: t });
    }
    this.quickCache = { at: t, key, map: out };
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

  private async fetchChart(productCode: string, kr: boolean, period: CandlePeriod, count: number): Promise<Candle[]> {
    const intraday = isIntraday(period);
    const path = `/v1/c-chart/${kr ? "kr-s" : "us-s"}/${encodeURIComponent(productCode)}/${PERIOD_PATH[period]}${intraday ? "" : ":1"}?count=${count}`;
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
