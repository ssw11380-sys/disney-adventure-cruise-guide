import type { Candle, CandlePeriod, CandleSeries } from "../../domain/types.js";
import { localIso, aggregateCandles, aggregateIntraday } from "./tossOpenApi.js";
import type { FetchFn } from "./types.js";

/**
 * 시장 지수 띠 (앱 홈 상단)와 지수·환율 차트. 네이버 증권 모바일 JSON, 키 불필요.
 *  - 국내 지수: m.stock.naver.com/api/index/{KOSPI|KOSDAQ}/basic, 차트 api.stock.naver.com/chart/domestic/index/{code}/{minute|minute5|minute30|day|week|month}
 *  - 해외 지수: api.stock.naver.com/index/{.IXIC|.INX|.DJI|.SOX}/basic, 차트 api.stock.naver.com/chart/foreign/index/{code}/{day|week|month}
 *    (해외 지수 분봉은 기간 조회가 비어 있어 당일 1분 시세 ?periodType=day 를 쓴다. 시각은 뉴욕 현지)
 *  - 환율: api.stock.naver.com/marketindex/exchange/FX_{USD|JPY|CNY}KRW (하나은행 고시 매매기준율. 엔은 100엔 기준),
 *    차트 m.stock.naver.com/front-api/chart/pricesByPeriod (당일 고시 회차, 1년 일별, 5·10년 주별 종가·고저)
 * 목록은 30초 캐시. 개별 항목이 실패하면 그 항목만 빠진다.
 */

export type IndexKind = "index" | "fx";

export interface MarketIndex {
  code: string;
  name: string;
  /** index: 지수(포인트), fx: 환율(원) */
  kind: IndexKind;
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  asOf: string | null;
}

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";

type Source = { code: string; name: string; kind: IndexKind; region: "kr" | "us" | "fx"; naver: string; url: string };

export const INDEX_SOURCES: Source[] = [
  { code: "KOSPI", name: "코스피", kind: "index", region: "kr", naver: "KOSPI", url: "https://m.stock.naver.com/api/index/KOSPI/basic" },
  { code: "KOSDAQ", name: "코스닥", kind: "index", region: "kr", naver: "KOSDAQ", url: "https://m.stock.naver.com/api/index/KOSDAQ/basic" },
  { code: "NASDAQ", name: "나스닥", kind: "index", region: "us", naver: ".IXIC", url: "https://api.stock.naver.com/index/.IXIC/basic" },
  { code: "SPX", name: "S&P500", kind: "index", region: "us", naver: ".INX", url: "https://api.stock.naver.com/index/.INX/basic" },
  { code: "DJI", name: "다우", kind: "index", region: "us", naver: ".DJI", url: "https://api.stock.naver.com/index/.DJI/basic" },
  { code: "SOX", name: "필라반도체", kind: "index", region: "us", naver: ".SOX", url: "https://api.stock.naver.com/index/.SOX/basic" },
  { code: "USDKRW", name: "원/달러", kind: "fx", region: "fx", naver: "FX_USDKRW", url: "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW" },
  { code: "JPYKRW", name: "원/100엔", kind: "fx", region: "fx", naver: "FX_JPYKRW", url: "https://api.stock.naver.com/marketindex/exchange/FX_JPYKRW" },
  { code: "CNYKRW", name: "원/위안", kind: "fx", region: "fx", naver: "FX_CNYKRW", url: "https://api.stock.naver.com/marketindex/exchange/FX_CNYKRW" },
];

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "20260923141900" 또는 "20260923" → 날짜·시각 조각 */
function splitStamp(s: string): { date: string; hms: string | null } | null {
  if (!/^\d{8}(\d{6})?$/.test(s)) return null;
  const date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return { date, hms: s.length === 14 ? `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}` : null };
}

/** 뉴욕 현지 날짜의 UTC 오프셋 (서머타임 반영, 예 "-04:00") */
function nyOffset(date: string): string {
  return localIso(`${date}T16:00:00Z`, false).slice(19);
}

/** yyyyMMddHHmm (서울) */
function stampKst(d: Date): string {
  const s = localIso(d.toISOString(), true);
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}${s.slice(11, 13)}${s.slice(14, 16)}`;
}

type Json = Record<string, unknown>;

/** 차트에 쓰는 기간별 조회 범위(일)와 캐시 시간 */
const RANGE_DAYS: Record<CandlePeriod, (count: number) => number> = {
  "1m": () => 7,
  "5m": () => 14,
  "30m": () => 45,
  D: (n) => Math.ceil(n * 1.5) + 10,
  W: (n) => n * 7 + 14,
  M: (n) => n * 31 + 40,
};

export class MarketIndices {
  private cache: { at: number; value: MarketIndex[] } | null = null;
  private readonly chartCache = new Map<string, { at: number; want: number; series: CandleSeries }>();

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async json(url: string): Promise<unknown> {
    const res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    return res.json();
  }

  private async one(src: Source): Promise<MarketIndex | null> {
    try {
      const raw = (await this.json(src.url)) as Json;
      // 환율 응답은 exchangeInfo 아래에 있고 필드 이름이 조금 다르다
      const d = (raw["exchangeInfo"] as Json | undefined) ?? raw;
      const value = num(d["closePrice"]);
      const change = num(d["compareToPreviousClosePrice"] ?? d["fluctuations"]);
      let rate = num(d["fluctuationsRatio"]);
      if (value === null || change === null) return null;
      // 등락률 부호가 빠지는 경우가 있어 전일 대비 부호에 맞춘다
      if (rate !== null && change < 0 && rate > 0) rate = -rate;
      return {
        code: src.code,
        name: src.name,
        kind: src.kind,
        value,
        change,
        changeRate: rate ?? 0,
        open: src.kind === "fx" ? true : String(d["marketStatus"] ?? "") === "OPEN",
        asOf: typeof d["localTradedAt"] === "string" ? d["localTradedAt"] : null,
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<MarketIndex[]> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < 30_000) return this.cache.value;
    const rows = await Promise.all(INDEX_SOURCES.map((s) => this.one(s)));
    const out = rows.filter((r): r is MarketIndex => r !== null);
    // 전부 실패하면 직전 값을 계속 쓴다
    if (out.length === 0 && this.cache) return this.cache.value;
    this.cache = { at: t, value: out };
    return out;
  }

  static source(code: string): Source | null {
    return INDEX_SOURCES.find((s) => s.code === code.toUpperCase()) ?? null;
  }

  /**
   * 지수·환율 차트 (오래된 → 최신, 최근 count 개). 분봉 time 은 현지 시각 ISO(국내·환율 +09:00, 해외는 뉴욕 오프셋).
   * 분봉 30초, 일·주·월봉 10분 캐시. 알 수 없는 코드면 null.
   */
  async candles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries | null> {
    const src = MarketIndices.source(code);
    if (!src) return null;
    const key = `${src.code}:${period}`;
    const t = this.now().getTime();
    const ttl = period === "D" || period === "W" || period === "M" ? 10 * 60_000 : 30_000;
    // 앱은 기간별로 넉넉한 봉 수(일 800·주 260·월 120)를 요청한다. 그보다 적게 달라고 해도 같은 양을 받아 캐시를 같이 쓴다
    const want = Math.max(count, period === "D" ? 800 : period === "W" ? 260 : period === "M" ? 120 : 0);
    const hit = this.chartCache.get(key);
    let series: CandleSeries;
    if (hit && t - hit.at < ttl && hit.want >= want) {
      series = hit.series;
    } else {
      try {
        const candles = src.region === "fx" ? await this.fxCandles(src, period) : await this.indexCandles(src, period, want);
        series = { code: src.code, period, candles, source: "naver" };
        if (candles.length) this.chartCache.set(key, { at: t, want, series });
        else if (hit) series = hit.series; // 비면 직전 값
      } catch (e) {
        if (!hit) throw e;
        series = hit.series; // 조회 실패면 직전 값
      }
    }
    return { ...series, candles: series.candles.slice(-count) };
  }

  /** 국내·해외 지수 */
  private async indexCandles(src: Source, period: CandlePeriod, want: number): Promise<Candle[]> {
    const kr = src.region === "kr";
    const base = `https://api.stock.naver.com/chart/${kr ? "domestic" : "foreign"}/index/${encodeURIComponent(src.naver)}`;
    const now = this.now();
    const range = (days: number) => `startDateTime=${stampKst(new Date(now.getTime() - days * 86_400_000)).slice(0, 8)}0000&endDateTime=${stampKst(now).slice(0, 8)}2359`;
    if (period === "D" || period === "W" || period === "M") {
      const path = period === "D" ? "day" : period === "W" ? "week" : "month";
      const rows = (await this.json(`${base}/${path}?${range(RANGE_DAYS[period](want))}`)) as Json[];
      return (Array.isArray(rows) ? rows : []).map(dailyCandle).filter((c): c is Candle => c !== null);
    }
    if (kr) {
      const path = period === "1m" ? "minute" : period === "5m" ? "minute5" : "minute30";
      const rows = (await this.json(`${base}/${path}?${range(RANGE_DAYS[period](want))}`)) as Json[];
      return (Array.isArray(rows) ? rows : []).map((r) => minuteCandle(r, "+09:00")).filter((c): c is Candle => c !== null);
    }
    // 해외 지수 분봉: 직전·당일 세션의 1분 시세(종가만) → 1분봉 → 5·30분
    const d = (await this.json(`${base}?periodType=day`)) as Json;
    const ticks = [...((d["lastPriceInfos"] as Json[] | undefined) ?? []), ...((d["priceInfos"] as Json[] | undefined) ?? [])];
    const minutes = ticksToMinutes(ticks, (date) => nyOffset(date), num(d["openPrice"]), true);
    return aggregateIntraday(minutes, period === "1m" ? 1 : period === "5m" ? 5 : 30);
  }

  /** 환율: 당일 고시 회차 → 분봉, 1년 일별 종가 → 일봉, 5·10년 주별 → 주·월봉 */
  private async fxCandles(src: Source, period: CandlePeriod): Promise<Candle[]> {
    const type = period === "D" ? "areaYear" : period === "W" ? "areaYearFive" : period === "M" ? "areaYearTen" : "day";
    const url = `https://m.stock.naver.com/front-api/chart/pricesByPeriod?reutersCode=${encodeURIComponent(src.naver)}&category=exchange&chartInfoType=marketindex&scriptChartType=${type}`;
    const raw = (await this.json(url)) as Json;
    const r = (raw["result"] as Json | undefined) ?? {};
    if (type === "day") {
      const ticks = [...((r["lastPriceInfos"] as Json[] | undefined) ?? []), ...((r["priceInfos"] as Json[] | undefined) ?? [])];
      const minutes = ticksToMinutes(ticks, () => "+09:00", num(r["openPrice"]), false);
      return aggregateIntraday(minutes, period === "1m" ? 1 : period === "5m" ? 5 : 30);
    }
    // 일·주별 종가(시가 0). 시가는 직전 종가로, 고·저는 그 둘을 포함하게
    const out: Candle[] = [];
    for (const row of (r["priceInfos"] as Json[] | undefined) ?? []) {
      const p = splitStamp(String(row["localDate"] ?? ""));
      const close = num(row["closePrice"]);
      if (!p || close === null) continue;
      const open = out.at(-1)?.close ?? close;
      const high = Math.max(num(row["highPrice"]) ?? close, open, close);
      const low = Math.min(num(row["lowPrice"]) ?? close, open, close);
      out.push({ date: p.date, open, high, low, close, volume: 0 });
    }
    return period === "M" ? aggregateCandles(out, "M") : out;
  }
}

function dailyCandle(r: Json): Candle | null {
  const p = splitStamp(String(r["localDate"] ?? ""));
  const close = num(r["closePrice"]);
  if (!p || close === null) return null;
  const open = num(r["openPrice"]) || close;
  return { date: p.date, open, high: num(r["highPrice"]) ?? Math.max(open, close), low: num(r["lowPrice"]) ?? Math.min(open, close), close, volume: num(r["accumulatedTradingVolume"]) ?? 0 };
}

function minuteCandle(r: Json, offset: string): Candle | null {
  const p = splitStamp(String(r["localDateTime"] ?? ""));
  const close = num(r["currentPrice"]);
  if (!p?.hms || close === null) return null;
  const open = num(r["openPrice"]) ?? close;
  return {
    date: p.date,
    time: `${p.date}T${p.hms}${offset}`,
    open,
    high: num(r["highPrice"]) ?? Math.max(open, close),
    low: num(r["lowPrice"]) ?? Math.min(open, close),
    close,
    volume: num(r["accumulatedTradingVolume"]) ?? 0,
  };
}

/**
 * 시각별 가격(종가만, 누적 거래량 선택) → 1분봉. 같은 분의 가격들로 시·고·저·종을, 시가는 직전 분 종가(그날 첫 봉은 그날 시가)로.
 * cumulativeVolume 이면 누적 거래량의 차이를 그 분의 거래량으로 (날짜가 바뀌면 다시 센다. 세션 중간부터 온 날은 첫 값이 기준).
 */
function ticksToMinutes(ticks: Json[], offsetOf: (date: string) => string, firstOpen: number | null, cumulativeVolume: boolean): Candle[] {
  const rows = ticks
    .map((r) => ({ p: splitStamp(String(r["localDateTime"] ?? "")), price: num(r["currentPrice"]), vol: num(r["accumulatedTradingVolume"]) }))
    .filter((x): x is { p: { date: string; hms: string }; price: number; vol: number | null } => !!x.p?.hms && x.price !== null)
    .sort((a, b) => (a.p.date + a.p.hms < b.p.date + b.p.hms ? -1 : 1));
  const out: Candle[] = [];
  let prevVol = 0;
  let prevDate = "";
  const today = rows.at(-1)?.p.date ?? "";
  for (const { p, price, vol } of rows) {
    const minute = `${p.date}T${p.hms.slice(0, 5)}:00${offsetOf(p.date)}`;
    const newDay = p.date !== prevDate;
    if (newDay) {
      // 세션 첫 분(09:30 무렵)부터 온 날은 누적 거래량을 0부터, 중간부터 온 날(직전 세션 일부)은 첫 값을 기준으로 센다
      prevVol = p.hms <= "09:31:00" ? 0 : (vol ?? 0);
      prevDate = p.date;
    }
    const v = cumulativeVolume && vol !== null ? Math.max(vol - prevVol, 0) : 0;
    if (cumulativeVolume && vol !== null) prevVol = vol;
    const last = out.at(-1);
    if (last && last.time === minute) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += v;
      continue;
    }
    // 시가: 같은 날이면 직전 분 종가, 날이 바뀌면 그날 시가(당일은 응답의 openPrice, 직전 세션은 첫 값) — 밤사이 갭을 한 봉에 넣지 않는다
    const open = !newDay && last ? last.close : p.date === today && firstOpen !== null ? firstOpen : price;
    out.push({ date: p.date, time: minute, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: v });
  }
  return out;
}
