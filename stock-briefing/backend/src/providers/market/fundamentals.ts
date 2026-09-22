import type { Quote } from "../../domain/types.js";
import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "./types.js";
import { parseNum } from "./naver.js";

/**
 * 밸류에이션·배당 보강 (PER/PBR/EPS/BPS/배당/52주). 토스 시세 API 는 이 값을 주지 않아 네이버에서 채운다.
 *  - 한국: m.stock.naver.com/api/stock/{code}/integration (totalInfos)
 *  - 미국: api.stock.naver.com/stock/{reutersCode}/basic (stockItemTotalInfos). 로이터 코드는 NASDAQ `.O`, NYSE·AMEX 는 접미사 없음,
 *    클래스 주식(BRK-B) 은 소문자 접미사(BRKb). 시장을 모르면 `.O` → 접미사 없음 순으로 시도.
 *  - 환율: api.stock.naver.com/marketindex/exchange/FX_USDKRW (하나은행 고시, 1분 캐시)
 * 종목당 1시간 캐시. 실패해도 시세는 그대로 나간다(보강만 생략).
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
  source: string;
}

type Json = Record<string, unknown>;

export function reutersCandidates(code: string, market?: string | null): string[] {
  const base = code.replace(/[-.]([A-Z])$/, (_m, c: string) => c.toLowerCase()); // BRK-B → BRKb
  if (market === "NASDAQ") return [`${base}.O`, base];
  if (market === "NYSE" || market === "AMEX") return [base, `${base}.O`];
  return [`${base}.O`, base];
}

export class NaverFundamentals {
  readonly name = "naver-fundamentals";
  private readonly cache = new Map<string, { at: number; value: Fundamentals | null }>();
  private fx: { at: number; rate: number } | null = null;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 60 * 60_000,
  ) {}

  private async getJson(url: string): Promise<Json | null> {
    try {
      const res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
      if (!res.ok) return null;
      return (await res.json()) as Json;
    } catch {
      return null;
    }
  }

  /** USD→KRW 환율 (1분 캐시). 실패하면 null */
  async usdKrw(): Promise<number | null> {
    const t = this.now().getTime();
    if (this.fx && t - this.fx.at < 60_000) return this.fx.rate;
    const j = await this.getJson("https://api.stock.naver.com/marketindex/exchange/FX_USDKRW");
    const rate = parseNum((j?.["exchangeInfo"] as Json | undefined)?.["closePrice"]);
    if (rate === null || rate <= 0) return this.fx?.rate ?? null;
    this.fx = { at: t, rate };
    return rate;
  }

  async get(code: string, market?: string | null): Promise<Fundamentals | null> {
    code = normalizeCode(code);
    const t = this.now().getTime();
    const hit = this.cache.get(code);
    if (hit && t - hit.at < this.ttlMs) return hit.value;
    const value = isKrCode(code) ? await this.getKr(code) : await this.getUs(code, market);
    this.cache.set(code, { at: t, value });
    return value;
  }

  private async getKr(code: string): Promise<Fundamentals | null> {
    const j = await this.getJson(`https://m.stock.naver.com/api/stock/${code}/integration`);
    const infos = (j?.["totalInfos"] as Json[] | undefined) ?? [];
    if (infos.length === 0) return null;
    return fromInfos(infos, "naver");
  }

  private async getUs(code: string, market?: string | null): Promise<Fundamentals | null> {
    for (const rc of reutersCandidates(code, market)) {
      const j = await this.getJson(`https://api.stock.naver.com/stock/${encodeURIComponent(rc)}/basic`);
      const infos = j?.["stockItemTotalInfos"] as Json[] | undefined;
      if (!j || !infos || String(j["symbolCode"] ?? "").toUpperCase() !== code.replace(/[-.]/g, "").toUpperCase() && String(j["reutersCode"] ?? "").toUpperCase() !== rc.toUpperCase()) continue;
      const f = fromInfos(infos, "naver-world");
      // 미국 시총은 "1조 4,944억 USD" 같은 한글 표기라 발행주식수 × 현재가로 대신 계산할 수 있게 원화 시총도 같이 둔다
      const shares = parseNum(j["countOfListedStock"]);
      const price = parseNum(j["closePriceRaw"] ?? j["closePrice"]);
      if (f.marketCap === null && shares !== null && price !== null) f.marketCap = Math.round(shares * price);
      return f;
    }
    return null;
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
    industry: m.get("industryGroupKor") ?? null,
    source,
  };
}

/** 시세에 비어 있는 밸류에이션 칸만 채운다 (소스가 준 값은 유지) */
export function applyFundamentals(q: Quote, f: Fundamentals | null): Quote {
  if (!f) return q;
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
    industry: q.industry ?? f.industry,
  };
}

export { ProviderError };
