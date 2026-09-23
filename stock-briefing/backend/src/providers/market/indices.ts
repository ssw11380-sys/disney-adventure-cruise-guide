import type { FetchFn } from "./types.js";

/**
 * 시장 지수 띠 (앱 홈 상단). 네이버 증권 모바일 JSON, 키 불필요.
 *  - 국내: m.stock.naver.com/api/index/{KOSPI|KOSDAQ}/basic
 *  - 해외: api.stock.naver.com/index/{.IXIC|.INX|.DJI|.SOX}/basic
 *  - 환율: api.stock.naver.com/marketindex/exchange/FX_USDKRW (하나은행 고시 매매기준율, 시장 표준 호가)
 * 30초 캐시. 개별 지수가 실패하면 그 항목만 빠진다.
 */

export interface MarketIndex {
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  asOf: string | null;
}

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";

const SOURCES: { code: string; name: string; url: string }[] = [
  { code: "KOSPI", name: "코스피", url: "https://m.stock.naver.com/api/index/KOSPI/basic" },
  { code: "KOSDAQ", name: "코스닥", url: "https://m.stock.naver.com/api/index/KOSDAQ/basic" },
  { code: "NASDAQ", name: "나스닥", url: "https://api.stock.naver.com/index/.IXIC/basic" },
  { code: "SPX", name: "S&P500", url: "https://api.stock.naver.com/index/.INX/basic" },
  { code: "DJI", name: "다우", url: "https://api.stock.naver.com/index/.DJI/basic" },
  { code: "SOX", name: "필라반도체", url: "https://api.stock.naver.com/index/.SOX/basic" },
  { code: "USDKRW", name: "원/달러", url: "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW" },
];

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export class MarketIndices {
  private cache: { at: number; value: MarketIndex[] } | null = null;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async one(src: (typeof SOURCES)[number]): Promise<MarketIndex | null> {
    try {
      const res = await this.fetchFn(src.url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
      if (!res.ok) return null;
      const raw = (await res.json()) as Record<string, unknown>;
      // 환율 응답은 exchangeInfo 아래에 있고 필드 이름이 조금 다르다
      const d = (raw["exchangeInfo"] as Record<string, unknown> | undefined) ?? raw;
      const value = num(d["closePrice"]);
      const change = num(d["compareToPreviousClosePrice"] ?? d["fluctuations"]);
      let rate = num(d["fluctuationsRatio"]);
      if (value === null || change === null) return null;
      // 등락률 부호가 빠지는 경우가 있어 전일 대비 부호에 맞춘다
      if (rate !== null && change < 0 && rate > 0) rate = -rate;
      return {
        code: src.code,
        name: src.name,
        value,
        change,
        changeRate: rate ?? 0,
        open: src.code === "USDKRW" ? true : String(d["marketStatus"] ?? "") === "OPEN",
        asOf: typeof d["localTradedAt"] === "string" ? d["localTradedAt"] : null,
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<MarketIndex[]> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < 30_000) return this.cache.value;
    const rows = await Promise.all(SOURCES.map((s) => this.one(s)));
    const out = rows.filter((r): r is MarketIndex => r !== null);
    // 전부 실패하면 직전 값을 계속 쓴다
    if (out.length === 0 && this.cache) return this.cache.value;
    this.cache = { at: t, value: out };
    return out;
  }
}
