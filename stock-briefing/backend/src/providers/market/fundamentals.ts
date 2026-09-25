import type { Quote } from "../../domain/types.js";
import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FetchFn } from "./types.js";
import { parseNum } from "./naver.js";

/**
 * 밸류에이션·배당 보강 (PER/PBR/EPS/BPS/배당/52주). 토스 시세 API 는 이 값을 주지 않아 네이버에서 채운다.
 *  - 한국: m.stock.naver.com/api/stock/{code}/integration (totalInfos)
 *  - 미국: api.stock.naver.com/stock/{reutersCode}/basic (stockItemTotalInfos). 로이터 코드는 NASDAQ `.O`, NYSE·AMEX 는 접미사 없음,
 *    클래스 주식(BRK-B) 은 소문자 접미사(BRKb). 시장을 모르면 `.O` → 접미사 없음 순으로 시도.
 *  - 환율: api.stock.naver.com/marketindex/exchange/FX_USDKRW (하나은행 고시, 1분 캐시)
 * 종목당 1시간 캐시(받기에 실패한 결과는 2분만). 실패해도 시세는 그대로 나간다(보강만 생략).
 */

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";

export interface Fundamentals {
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  dividendPerShare: number | null;
  dividendYieldPct: number | null;
  high52w: number | null;
  low52w: number | null;
  marketCap: number | null; // 원화 또는 달러 (종목 통화)
  industry: string | null;
  /**
   * 사람이 읽는 종목 이름 (미국만 — 네이버 basic 의 stockName, 없으면 stockNameEng). 한글 이름이 있으면 한글(애플),
   * 없으면 영문(ETF: "Defiance Daily Target 2X Long RGTI ETF"). 모르면 null
   */
  name?: string | null;
  source: string;
}

type Json = Record<string, unknown>;

export function reutersCandidates(code: string, market?: string | null): string[] {
  const base = code.replace(/[-.]([A-Z])$/, (_m, c: string) => c.toLowerCase()); // BRK-B → BRKb
  if (market === "NASDAQ") return [`${base}.O`, base];
  if (market === "NYSE" || market === "AMEX") return [base, `${base}.O`];
  return [`${base}.O`, base];
}

/** 받기 실패 (네트워크·시간 초과·5xx·429·JSON 오류). "받았는데 값이 없음"(null)과 구분한다 */
const FAILED = Symbol("failed");
type Fetched<T> = T | null | typeof FAILED;

/** 없는 종목이라는 답 (네이버는 모르는 코드에 409 StockConflict·404 를 준다) */
const NOT_FOUND_STATUS = new Set([400, 404, 409]);

export class NaverFundamentals {
  readonly name = "naver-fundamentals";
  private readonly cache = new Map<string, { at: number; ttl: number; value: Fundamentals | null }>();
  private fx: { at: number; rate: number } | null = null;

  /** 우선 쓸 환율 소스(토스 Open API 등). 토스 앱의 평가금과 같은 숫자를 내기 위해 토스 환율을 먼저 쓴다 */
  fxPrimary: (() => Promise<number | null>) | null = null;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 60 * 60_000,
    /** 받기에 실패한 결과는 이만큼만 기억한다 (한 번의 오류로 1시간 동안 PER/PBR 이 비지 않게) */
    private readonly failTtlMs = 2 * 60_000,
  ) {}

  private async getJson(url: string): Promise<Fetched<Json>> {
    try {
      const res = await fetchWithTimeout(this.fetchFn, url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
      if (!res.ok) return NOT_FOUND_STATUS.has(res.status) ? null : FAILED;
      return (await res.json()) as Json;
    } catch {
      return FAILED;
    }
  }

  /** USD→KRW 환율 (1분 캐시). 실패하면 null */
  async usdKrw(): Promise<number | null> {
    const t = this.now().getTime();
    if (this.fx && t - this.fx.at < 60_000) return this.fx.rate;
    if (this.fxPrimary) {
      const primary = await this.fxPrimary().catch(() => null);
      if (primary && primary > 0) {
        this.fx = { at: t, rate: primary };
        return primary;
      }
    }
    const j = await this.getJson("https://api.stock.naver.com/marketindex/exchange/FX_USDKRW");
    const rate = j === FAILED ? null : parseNum((j?.["exchangeInfo"] as Json | undefined)?.["closePrice"]);
    if (rate === null || rate <= 0) return this.fx?.rate ?? null;
    this.fx = { at: t, rate };
    return rate;
  }

  async get(code: string, market?: string | null): Promise<Fundamentals | null> {
    code = normalizeCode(code);
    const t = this.now().getTime();
    const hit = this.cache.get(code);
    if (hit && t - hit.at < hit.ttl) return hit.value;
    const got = isKrCode(code) ? await this.getKr(code) : await this.getUs(code, market);
    // 받기 실패는 "값 없음"이 아니다: 직전 값이 있으면 그대로 두고, 짧게만 기억했다가 다시 받는다 (BH-43)
    const failed = got === FAILED;
    const value = failed ? (hit?.value ?? null) : got;
    this.cache.set(code, { at: t, ttl: failed ? this.failTtlMs : this.ttlMs, value });
    return value;
  }

  private async getKr(code: string): Promise<Fetched<Fundamentals>> {
    const j = await this.getJson(`https://m.stock.naver.com/api/stock/${code}/integration`);
    if (j === FAILED) return FAILED;
    const infos = (j?.["totalInfos"] as Json[] | undefined) ?? [];
    if (infos.length === 0) return null;
    return fromInfos(infos, "naver");
  }

  private async getUs(code: string, market?: string | null): Promise<Fetched<Fundamentals>> {
    // 로이터 코드 규칙이 들쭉날쭉(IONQ.K, SOXL.K, ETN, AVGO.O)이라 네이버 자동완성으로 먼저 알아낸다
    const resolved = await this.lookupReuters(code);
    // 자동완성을 못 받았으면 규칙 후보가 모두 없다고 나와도 확정할 수 없다 (IONQ.K 같은 코드는 자동완성으로만 찾는다)
    let failed = resolved === FAILED;
    const candidates = [...new Set([...(typeof resolved === "string" ? [resolved] : []), ...reutersCandidates(code, market)])];
    for (const rc of candidates) {
      const j = await this.getJson(`https://api.stock.naver.com/stock/${encodeURIComponent(rc)}/basic`);
      if (j === FAILED) {
        failed = true;
        continue;
      }
      const infos = j?.["stockItemTotalInfos"] as Json[] | undefined;
      if (!j || !infos) continue;
      const f = fromInfos(infos, "naver-world");
      f.name = realText(j["stockName"]) ?? realText(j["stockNameEng"]);
      // 미국 시총은 "1조 4,944억 USD" 같은 한글 표기라 발행주식수 × 현재가로 대신 계산할 수 있게 원화 시총도 같이 둔다
      const shares = parseNum(j["countOfListedStock"]);
      const price = parseNum(j["closePriceRaw"] ?? j["closePrice"]);
      if (f.marketCap === null && shares !== null && price !== null) f.marketCap = Math.round(shares * price);
      return f;
    }
    return failed ? FAILED : null;
  }

  /** 네이버 자동완성으로 티커 → 로이터 코드 (예: IONQ → IONQ.K, BRK.B → BRKb). 못 찾거나 받기에 실패하면 null */
  async resolveReuters(code: string): Promise<string | null> {
    const r = await this.lookupReuters(code);
    return typeof r === "string" ? r : null;
  }

  private async lookupReuters(code: string): Promise<Fetched<string>> {
    // 클래스 주식은 점·하이픈 없이 묻는다 (자동완성은 'BRK.B' 로는 못 찾고 'BRKB' 로 찾는다. 네이버 코드는 'BRK B')
    const symbol = code.replace(/[-.\s]/g, "").toUpperCase();
    const j = await this.getJson(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(symbol)}&target=stock`);
    if (j === FAILED) return FAILED;
    const items = (j?.["items"] as Json[] | undefined) ?? [];
    const hit = items.find((it) => String(it["code"] ?? "").replace(/[-.\s]/g, "").toUpperCase() === symbol && String(it["nationCode"] ?? "") === "USA" && typeof it["reutersCode"] === "string");
    return hit ? String(hit["reutersCode"]) : null;
  }
}

function fromInfos(infos: Json[], source: string): Fundamentals {
  const m = new Map<string, string>();
  for (const it of infos) if (typeof it["code"] === "string") m.set(it["code"], String(it["value"] ?? ""));
  const n = (k: string) => {
    const v = m.get(k);
    if (!v || v === "N/A" || v === "-") return null;
    return parseNum(v);
  };
  return {
    per: n("per"),
    pbr: n("pbr"),
    eps: n("eps"),
    bps: n("bps"),
    dividendPerShare: n("dividend"),
    dividendYieldPct: n("dividendYieldRatio"),
    high52w: n("highPriceOf52Weeks"),
    low52w: n("lowPriceOf52Weeks"),
    marketCap: null,
    // 업종이 없는 종목(ETF 등)은 "-" 로 온다 → 비운다 (앱에 "RGTX · NASDAQ · -" 로 보이던 것)
    industry: realText(m.get("industryGroupKor")),
    source,
  };
}

/** 자리표시가 아닌 글자 ("-" · "—" · "N/A" · 공백이면 null) */
export function realText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" || /^(-|—|–|n\/a|null|undefined)$/i.test(s) ? null : s;
}

/**
 * 시세에 비어 있는 밸류에이션 칸만 채운다 (소스가 준 값은 유지). 업종이 자리표시("-")면 비어 있는 것으로 본다.
 * 사람이 읽는 이름(fullName)은 보강 값에 있을 때만 넣는다 (예전 응답 모양에 칸을 새로 만들지 않게)
 */
export function applyFundamentals(q: Quote, f: Fundamentals | null): Quote {
  if (!f) return q;
  const fullName = q.fullName ?? f.name ?? null;
  return {
    ...q,
    per: q.per ?? f.per,
    pbr: q.pbr ?? f.pbr,
    eps: q.eps ?? f.eps,
    bps: q.bps ?? f.bps,
    high52w: q.high52w ?? f.high52w,
    low52w: q.low52w ?? f.low52w,
    marketCap: q.marketCap ?? f.marketCap,
    dividendPerShare: q.dividendPerShare ?? f.dividendPerShare,
    dividendYieldPct: q.dividendYieldPct ?? f.dividendYieldPct,
    industry: realText(q.industry) ?? realText(f.industry),
    ...(fullName ? { fullName } : {}),
  };
}

export { ProviderError };
