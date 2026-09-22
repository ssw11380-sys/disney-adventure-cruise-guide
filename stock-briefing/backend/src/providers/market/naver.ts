import type { AfterMarketQuote, Candle, CandlePeriod, CandleSeries, Quote } from "../../domain/types.js";
import { isKrCode } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import { seoulIso } from "../../lib/time.js";
import type { FetchFn, QuoteProvider } from "./types.js";

/**
 * 네이버 증권 (모바일 앱이 쓰는 비공식 JSON API). 한국 종목 전용, 키 불필요.
 *  - 현재가: polling.finance.naver.com — KRX 정규장 종가 + 넥스트레이드(NXT) 프리/애프터마켓 가격
 *  - 지표: m.stock.naver.com/api/stock/{code}/integration — 52주 고저, PER/PBR/EPS/BPS
 *  - 봉: api.stock.naver.com/chart/domestic/item/{code}/{day|week|month}
 * Yahoo 는 KRX 종가 확정(15:30 동시호가) 전 값이 남거나 거래량이 일부만 잡히는 경우가 있어
 * 한국 종목은 이 소스를 Yahoo 보다 먼저 쓴다. 비공식 API 라 파싱은 방어적으로.
 */

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";
const POLLING_URL = "https://polling.finance.naver.com/api/realtime/domestic/stock";
const INTEGRATION_URL = "https://m.stock.naver.com/api/stock";
const CHART_URL = "https://api.stock.naver.com/chart/domestic/item";

const PERIOD_PATH: Record<CandlePeriod, string> = { D: "day", W: "week", M: "month" };
/** count 개 봉을 받기 위해 거슬러 올라갈 대략의 달력 일수 (휴장 여유 포함) */
const DAYS_PER_CANDLE: Record<CandlePeriod, number> = { D: 1.7, W: 7.5, M: 31 };

type Json = Record<string, unknown>;

/** "201,000" / "201000" / "-1.57" / "15.60배" / "12,885원" → 숫자. 못 읽으면 null */
export function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s원배%]/g, "");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 네이버의 등락 구분 코드: 1 상한, 2 상승, 3 보합, 4 하한, 5 하락 */
function signOf(compare: unknown): 1 | -1 | 0 {
  const code = String((compare as Json | undefined)?.["code"] ?? "");
  if (code === "1" || code === "2") return 1;
  if (code === "4" || code === "5") return -1;
  return 0;
}

function signed(abs: number | null, sign: 1 | -1 | 0): number {
  if (abs === null) return 0;
  // 이미 부호가 붙어 오는 경우(-1.57)는 그대로, 절대값이면 구분 코드로 부호를 붙인다
  return abs < 0 ? abs : sign * abs;
}

export class NaverFinanceProvider implements QuoteProvider {
  readonly name = "naver";

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  supports(code: string): boolean {
    return isKrCode(code);
  }

  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}`);
    try {
      return await res.json();
    } catch (e) {
      throw new ProviderError(this.name, `JSON 파싱 실패: ${url}`, e);
    }
  }

  async getQuote(code: string): Promise<Quote> {
    if (!isKrCode(code)) throw new ProviderError(this.name, `한국 종목만 지원합니다: ${code}`);
    const [polling, integration] = await Promise.all([
      this.getJson(`${POLLING_URL}/${code}`) as Promise<{ datas?: Json[] }>,
      // 지표는 부가 정보라 실패해도 현재가는 낸다
      (this.getJson(`${INTEGRATION_URL}/${code}/integration`) as Promise<Json>).catch(() => ({}) as Json),
    ]);
    const d = polling.datas?.[0];
    if (!d || String(d["itemCode"] ?? "") !== code) throw new ProviderError(this.name, `${code} 시세 없음 (상장 종목이 아니거나 응답 형식 변경)`);

    const price = parseNum(d["closePriceRaw"]) ?? parseNum(d["closePrice"]);
    if (price === null) throw new ProviderError(this.name, `${code} 현재가 없음`);
    const sign = signOf(d["compareToPreviousPrice"]);
    const change = signed(parseNum(d["compareToPreviousClosePriceRaw"]) ?? parseNum(d["compareToPreviousClosePrice"]), sign);
    const changeRate = signed(parseNum(d["fluctuationsRatioRaw"]) ?? parseNum(d["fluctuationsRatio"]), sign);

    const info = new Map<string, string>();
    for (const item of (integration["totalInfos"] as Json[] | undefined) ?? []) {
      if (typeof item["code"] === "string") info.set(item["code"], String(item["value"] ?? ""));
    }
    const prevClose = parseNum(info.get("lastClosePrice")) ?? price - change;

    return {
      code,
      currency: "KRW",
      price,
      change,
      changeRate: round2(changeRate),
      open: parseNum(d["openPriceRaw"]) ?? parseNum(d["openPrice"]),
      high: parseNum(d["highPriceRaw"]) ?? parseNum(d["highPrice"]),
      low: parseNum(d["lowPriceRaw"]) ?? parseNum(d["lowPrice"]),
      prevClose,
      volume: parseNum(d["accumulatedTradingVolumeRaw"]) ?? parseNum(d["accumulatedTradingVolume"]),
      marketCap: parseNum(d["marketValueFullRaw"]) ?? parseNum(d["marketValueFull"]),
      per: parseNum(info.get("per")),
      pbr: parseNum(info.get("pbr")),
      eps: parseNum(info.get("eps")),
      bps: parseNum(info.get("bps")),
      high52w: parseNum(info.get("highPriceOf52Weeks")),
      low52w: parseNum(info.get("lowPriceOf52Weeks")),
      asOf: seoulIso(this.now()),
      source: this.name,
      priceBasis: "KRX 정규장",
      afterMarket: toAfterMarket(d["overMarketPriceInfo"] as Json | undefined),
    };
  }

  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    if (!isKrCode(code)) throw new ProviderError(this.name, `한국 종목만 지원합니다: ${code}`);
    const end = this.now();
    const start = new Date(end.getTime() - Math.ceil(count * DAYS_PER_CANDLE[period] + 14) * 86_400_000);
    const url = `${CHART_URL}/${code}/${PERIOD_PATH[period]}?startDateTime=${ymd(start)}0000&endDateTime=${ymd(end)}2359`;
    const json = await this.getJson(url);
    if (!Array.isArray(json)) throw new ProviderError(this.name, `${code} 봉 응답 형식이 다릅니다`);
    const candles: Candle[] = [];
    for (const row of json as Json[]) {
      const date = String(row["localDate"] ?? "");
      const o = parseNum(row["openPrice"]), h = parseNum(row["highPrice"]), l = parseNum(row["lowPrice"]), c = parseNum(row["closePrice"]);
      if (!/^\d{8}$/.test(date) || o === null || h === null || l === null || c === null) continue;
      candles.push({
        date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
        open: o, high: h, low: l, close: c,
        volume: parseNum(row["accumulatedTradingVolume"]) ?? 0,
      });
    }
    if (candles.length === 0) throw new ProviderError(this.name, `${code} 봉 데이터 없음`);
    candles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { code, period, candles: candles.slice(-count), source: this.name };
  }
}

function toAfterMarket(o: Json | undefined): AfterMarketQuote | null {
  if (!o) return null;
  const price = parseNum(o["overPriceRaw"]) ?? parseNum(o["overPrice"]);
  if (price === null) return null;
  const sign = signOf(o["compareToPreviousPrice"]);
  const session = String(o["tradingSessionType"] ?? "");
  const asOfRaw = String(o["localTradedAt"] ?? "");
  return {
    venue: "NXT",
    session: session === "PRE_MARKET" || session === "AFTER_MARKET" ? session : "UNKNOWN",
    status: String(o["overMarketStatus"] ?? "").toUpperCase() === "OPEN" ? "OPEN" : "CLOSE",
    price,
    change: signed(parseNum(o["compareToPreviousClosePriceRaw"]) ?? parseNum(o["compareToPreviousClosePrice"]), sign),
    changeRate: round2(signed(parseNum(o["fluctuationsRatioRaw"]) ?? parseNum(o["fluctuationsRatio"]), sign)),
    volume: parseNum(o["accumulatedTradingVolumeRaw"]) ?? parseNum(o["accumulatedTradingVolume"]),
    // "2026-09-22T20:00:00.000000+09:00" 처럼 마이크로초가 붙어 오면 잘라서 표준 ISO 로
    asOf: asOfRaw ? asOfRaw.replace(/(\.\d{3})\d+/, "$1") : seoulIso(),
  };
}

function ymd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d).replace(/-/g, "");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
