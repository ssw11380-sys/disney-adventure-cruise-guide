import { isIntraday, type Candle, type CandlePeriod, type CandleSeries, type ListedStock, type Quote } from "../../domain/types.js";
import { isKrCode, marketFromYahooExchange } from "../../lib/codes.js";
import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import { seoulIso } from "../../lib/time.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import { aggregateCandles } from "./tossOpenApi.js";
import type { FetchFn, QuoteProvider, StockSearchProvider } from "./types.js";

/**
 * Yahoo Finance 비공식 엔드포인트 (yfinance 가 내부적으로 쓰는 것과 동일).
 * 키가 필요 없어 KIS 미설정/장애 시 대체 소스로 쓴다. 한국 종목은 000660.KS / 247540.KQ 형식.
 * 비공식이므로 응답 형식이 바뀔 수 있다 → 파싱은 방어적으로.
 */

const UA = "Mozilla/5.0 (compatible; stock-briefing/0.1)";
const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
/** 봉으로 낸 등락률과 meta 등락률(소수 셋째 자리)이 이만큼(%p) 넘게 어긋나면 직전 봉을 믿지 않는다 */
const RATE_TOLERANCE = 0.05;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function yahooSymbol(code: string, market: string): string {
  if (!isKrCode(code)) return code.replace(/\.([A-Z])$/, "-$1"); // 미국 티커는 그대로, 클래스 주식만 Yahoo 형식(BRK.B → BRK-B)
  return `${code}.${market === "KOSDAQ" ? "KQ" : "KS"}`;
}

/**
 * 봉 수 → 조회 범위(쿼리). 주·월봉도 일봉으로 받아 묶는다.
 * 10년 넘게는 range=max 대신 기간(period1·period2)으로 받는다: range=max 는 일봉을 달라고 해도 3mo 봉으로 준다 (BH-71)
 */
export function rangeQuery(period: CandlePeriod, count: number, nowMs = Date.now()): string {
  const years = period === "W" ? count / 52 : period === "M" ? count / 12 : count / 250;
  if (years <= 10) return `range=${years <= 1 ? "1y" : years <= 2 ? "2y" : years <= 5 ? "5y" : "10y"}`;
  const to = Math.floor(nowMs / 1000);
  return `period1=${to - Math.ceil((years + 1) * 366 * 86_400)}&period2=${to}`;
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
      res = await fetchWithTimeout(this.fetchFn, url, { headers: { "user-agent": UA, accept: "application/json" } });
    } catch (e) {
      throw new ProviderError(this.name, `${isTimeoutError(e) ? "시간 초과" : "네트워크 오류"}: ${url}`, e);
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

  /**
   * 일봉 차트 (날짜는 거래소 현지 날짜). 주·월봉은 이 일봉을 묶는다:
   * Yahoo 의 1wk·1mo 는 range 에 따라 주봉·분기봉으로 바뀌어 오고(dataGranularity), 끝에 하루치 live 행을 따로 붙여
   * 같은 주·달에 봉이 둘 생긴다 (BH-71). span 은 조회 범위 쿼리 (range=1y 또는 period1=…&period2=…)
   */
  private async fetchChart(code: string, span: string): Promise<{
    meta: Record<string, unknown>;
    candles: Candle[];
  }> {
    const known = await this.resolveMarket(code);
    const markets = !isKrCode(code) ? ["US"] : known ? [known] : ["KOSPI", "KOSDAQ"];
    let lastErr: unknown;
    for (const market of markets) {
      const symbol = yahooSymbol(code, market);
      const url = `${CHART_URL}/${symbol}?${span}&interval=1d&includePrePost=false`;
      try {
        const json = (await this.getJson(url)) as {
          chart?: { result?: Array<Record<string, unknown>> | null; error?: unknown };
        };
        const result = json.chart?.result?.[0];
        if (!result) throw new ProviderError(this.name, `${symbol} 결과 없음`);
        const meta = (result["meta"] as Record<string, unknown>) ?? {};
        const granularity = meta["dataGranularity"];
        if (typeof granularity === "string" && granularity !== "1d") throw new ProviderError(this.name, `${symbol} 일봉 대신 ${granularity} 봉이 옴`);
        return { meta, candles: toCandles(result, exchangeTimeZone(meta, code)) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof ProviderError ? lastErr : new ProviderError(this.name, `${code} 차트 조회 실패`, lastErr);
  }

  async getQuote(code: string): Promise<Quote> {
    const { meta, candles } = await this.fetchChart(code, "range=1y");
    const last = candles.at(-1);
    const price = num(meta["regularMarketPrice"]) ?? last?.close ?? null;
    if (price === null) throw new ProviderError(this.name, `${code} 현재가 없음`);
    // 가격이 정규장 종가(regularMarketPrice)이므로 등락·전일 종가도 정규장 기준으로 맞춘다 (BH-22).
    // fulldayChange 는 시간외·야간 가격(fulldayPrice) 기준이라 쓰지 않는다. meta.chartPreviousClose 는 "조회 범위 시작 직전 종가"라 전일 종가가 아니다.
    // 전일 종가: regularMarketChange 가 있으면 그것으로, 없으면 정규장 거래일 직전 봉 종가, 그것도 없으면 등락률로 되짚는다.
    const tradeDate = typeof meta["regularMarketTime"] === "number" ? localDate(meta["regularMarketTime"], exchangeTimeZone(meta, code)) : null;
    const prevBar = tradeDate ? [...candles].reverse().find((c) => c.date < tradeDate) : candles.at(-2);
    const metaChange = num(meta["regularMarketChange"]);
    const metaRate = num(meta["regularMarketChangePercent"]);
    const fromRate = metaRate !== null && metaRate > -100 ? price / (1 + metaRate / 100) : null;
    let prevClose: number | null = metaChange !== null ? price - metaChange : (prevBar?.close ?? null);
    // 직전 거래일 행이 비어(null) 그 전날 봉을 잡으면 등락이 틀린다 → 봉으로 낸 등락률이 Yahoo 등락률과 어긋나면 등락률로 되짚는다
    if (metaChange === null && fromRate !== null && (!prevClose || Math.abs(((price - prevClose) / prevClose) * 100 - metaRate!) > RATE_TOLERANCE)) {
      prevClose = fromRate;
    }
    const currency = meta["currency"] === "USD" ? "USD" : "KRW";
    if (prevClose !== null) prevClose = currency === "KRW" ? Math.round(prevClose) : round4(prevClose); // 원화는 1원 단위
    const change = prevClose !== null ? round4(price - prevClose) : 0;
    const changeRate = prevClose ? (change / prevClose) * 100 : 0;
    const closes = candles.map((c) => c.close);
    return {
      code,
      currency,
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
    if (isIntraday(period)) throw new ProviderError(this.name, "분봉은 지원하지 않습니다");
    const { candles } = await this.fetchChart(code, rangeQuery(period, count));
    // 주는 월요일 시작, 월은 그 달, 봉 날짜는 기간의 첫 거래일 (토스 Open API 와 같은 규칙)
    return { code, period, candles: aggregateCandles(candles, period).slice(-count), source: this.name };
  }
}

/** 봉 날짜를 매길 거래소 시간대. 미국 종목을 서울 날짜로 매기면 장 마감(16:00 ET) 행이 다음 날이 된다 */
function exchangeTimeZone(meta: Record<string, unknown>, code: string): string {
  const tz = meta["exchangeTimezoneName"];
  return typeof tz === "string" && tz ? tz : isKrCode(code) ? "Asia/Seoul" : "America/New_York";
}

/** 현지 날짜(YYYY-MM-DD) 포맷터. 모르는 시간대 이름이면 서울 */
function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" });
  }
}

function localDate(epochSec: number, timeZone: string): string {
  return dateFormatter(timeZone).format(new Date(epochSec * 1000));
}

function toCandles(result: Record<string, unknown>, timeZone: string): Candle[] {
  const ts = (result["timestamp"] as number[] | undefined) ?? [];
  const q = ((result["indicators"] as { quote?: Array<Record<string, Array<number | null>>> })?.quote?.[0]) ?? {};
  const fmt = dateFormatter(timeZone);
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q["open"]?.[i], h = q["high"]?.[i], l = q["low"]?.[i], c = q["close"]?.[i], v = q["volume"]?.[i];
    if (o == null || h == null || l == null || c == null) continue; // 휴장/결측
    const candle = { date: fmt.format(new Date(ts[i]! * 1000)), open: o, high: h, low: l, close: c, volume: v ?? 0 };
    // 끝에 같은 날 행이 따로 한 번 더 오면(live 행) 뒤의 것만 남긴다 (yfinance 와 같은 보정)
    if (out.at(-1)?.date === candle.date) out[out.length - 1] = candle;
    else out.push(candle);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 1달러 미만 종목도 등락이 0 으로 뭉개지지 않게 소수 넷째 자리까지 */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
