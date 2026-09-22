import type { Candle, CandlePeriod, CandleSeries, ListedStock, Quote } from "../../domain/types.js";
import { isKrCode, marketFromYahooExchange } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import { seoulIso } from "../../lib/time.js";
import type { FetchFn, QuoteProvider, StockSearchProvider } from "./types.js";

/**
 * Yahoo Finance 비공식 엔드포인트 (yfinance 가 내부적으로 쓰는 것과 동일).
 * 키가 필요 없어 KIS 미설정/장애 시 대체 소스로 쓴다. 한국 종목은 000660.KS / 247540.KQ 형식.
 * 비공식이므로 응답 형식이 바뀔 수 있다 → 파싱은 방어적으로.
 */

const UA = "Mozilla/5.0 (compatible; stock-briefing/0.1)";
const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

const INTERVAL: Record<CandlePeriod, string> = { D: "1d", W: "1wk", M: "1mo" };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function yahooSymbol(code: string, market: string): string {
  if (!isKrCode(code)) return code; // 미국 티커는 그대로
  return `${code}.${market === "KOSDAQ" ? "KQ" : "KS"}`;
}

export class YahooProvider implements QuoteProvider, StockSearchProvider {
  readonly name = "yahoo";

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    /** 코드 → 시장 판별. 마스터 DB가 있으면 주입, 없으면 KOSPI 로 시도 후 KOSDAQ 재시도 */
    private readonly resolveMarket: (code: string) => Promise<string | null> = async () => null,
  ) {}

  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json" } });
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}`);
    return res.json();
  }

  async search(query: string, limit: number): Promise<ListedStock[]> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=${limit * 3}&newsCount=0&listsCount=0`;
    const json = (await this.getJson(url)) as { quotes?: Array<Record<string, unknown>> };
    const out: ListedStock[] = [];
    for (const q of json.quotes ?? []) {
      const symbol = String(q["symbol"] ?? "");
      const quoteType = String(q["quoteType"] ?? "");
      if (quoteType !== "EQUITY" && quoteType !== "ETF") continue; // 선물/옵션/지수 제외
      const market = marketFromYahooExchange(q["exchange"] as string | undefined, symbol);
      if (!market) continue;
      const code = isKrCode(symbol.slice(0, 6)) && /^\d{6}\.(KS|KQ)$/.test(symbol) ? symbol.slice(0, 6) : symbol;
      out.push({
        code,
        name: String(q["longname"] ?? q["shortname"] ?? symbol),
        market,
        isinCode: null,
        groupCode: quoteType === "ETF" ? "EF" : "ST",
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private async fetchChart(code: string, period: CandlePeriod, range: string): Promise<{
    meta: Record<string, unknown>;
    candles: Candle[];
  }> {
    const known = await this.resolveMarket(code);
    const markets = !isKrCode(code) ? ["US"] : known ? [known] : ["KOSPI", "KOSDAQ"];
    let lastErr: unknown;
    for (const market of markets) {
      const symbol = yahooSymbol(code, market);
      const url = `${CHART_URL}/${symbol}?range=${range}&interval=${INTERVAL[period]}&includePrePost=false`;
      try {
        const json = (await this.getJson(url)) as {
          chart?: { result?: Array<Record<string, unknown>> | null; error?: unknown };
        };
        const result = json.chart?.result?.[0];
        if (!result) throw new ProviderError(this.name, `${symbol} 결과 없음`);
        return { meta: (result["meta"] as Record<string, unknown>) ?? {}, candles: toCandles(result) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof ProviderError ? lastErr : new ProviderError(this.name, `${code} 차트 조회 실패`, lastErr);
  }

  async getQuote(code: string): Promise<Quote> {
    const { meta, candles } = await this.fetchChart(code, "D", "1y");
    const last = candles.at(-1);
    const price = num(meta["regularMarketPrice"]) ?? last?.close ?? null;
    if (price === null) throw new ProviderError(this.name, `${code} 현재가 없음`);
    // 주의: meta.chartPreviousClose 는 "조회 범위 시작 직전 종가"라 전일 종가가 아니다.
    // 전일 대비는 meta 의 당일 변동값을 우선 쓰고, 없으면 직전 봉 종가로 계산한다.
    const metaChange = num(meta["fulldayChange"]) ?? num(meta["regularMarketChange"]);
    const metaRate = num(meta["fulldayChangePercent"]) ?? num(meta["regularMarketChangePercent"]);
    let prevClose: number | null;
    let change: number;
    if (metaChange !== null) {
      change = metaChange;
      prevClose = round2(price - metaChange);
    } else {
      prevClose = candles.at(-2)?.close ?? null;
      change = prevClose !== null ? price - prevClose : 0;
    }
    const changeRate = metaRate ?? (prevClose ? round2((change / prevClose) * 100) : 0);
    const closes = candles.map((c) => c.close);
    return {
      code,
      currency: meta["currency"] === "USD" ? "USD" : "KRW",
      price,
      change,
      changeRate: round2(changeRate),
      open: last?.open ?? null,
      high: num(meta["regularMarketDayHigh"]) ?? last?.high ?? null,
      low: num(meta["regularMarketDayLow"]) ?? last?.low ?? null,
      prevClose,
      volume: num(meta["regularMarketVolume"]) ?? last?.volume ?? null,
      marketCap: null,
      per: null,
      pbr: null,
      eps: null,
      bps: null,
      high52w: num(meta["fiftyTwoWeekHigh"]) ?? (closes.length ? Math.max(...closes) : null),
      low52w: num(meta["fiftyTwoWeekLow"]) ?? (closes.length ? Math.min(...closes) : null),
      asOf: seoulIso(),
      source: this.name,
    };
  }

  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    const range = period === "D" ? (count <= 250 ? "1y" : "5y") : period === "W" ? "5y" : "max";
    const { candles } = await this.fetchChart(code, period, range);
    return { code, period, candles: candles.slice(-count), source: this.name };
  }
}

function toCandles(result: Record<string, unknown>): Candle[] {
  const ts = (result["timestamp"] as number[] | undefined) ?? [];
  const q = ((result["indicators"] as { quote?: Array<Record<string, Array<number | null>>> })?.quote?.[0]) ?? {};
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q["open"]?.[i], h = q["high"]?.[i], l = q["low"]?.[i], c = q["close"]?.[i], v = q["volume"]?.[i];
    if (o == null || h == null || l == null || c == null) continue; // 휴장/결측
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(ts[i]! * 1000));
    out.push({ date, open: o, high: h, low: l, close: c, volume: v ?? 0 });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
