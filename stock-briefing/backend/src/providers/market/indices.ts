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
 * 목록은 30초 캐시. 개별 항목이 실패하면(멈춤은 제한 시간에 끊는다):
 *  - stale 을 아는 앱(list({ stale: true })): 그 항목의 마지막 정상값을 stale 로 준다 (받은 지 STALE_MAX_MS 까지). 한 번도 못 받았거나 너무 오래됐으면 빠진다
 *  - 옛 앱: 예전(main) 서버처럼 그 항목을 뺀다. 전부 실패하면 main 처럼 직전 목록(마지막으로 비어 있지 않던 목록, 원래 open 그대로)을 준다
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
  /** 장중. 출처 조회가 실패한 항목(stale)은 확인하지 못했으므로 false */
  open: boolean;
  /** 출처의 시세 시각 */
  asOf: string | null;
  /** 서버가 출처에서 이 값을 받은 시각 (ISO, 한국 시간). stale 이면 마지막으로 받은 시각 그대로 */
  fetchedAt?: string;
  /**
   * 이번 조회가 실패해 마지막 정상값을 그대로 주는 중. 구버전 앱은 이 필드를 몰라 멈춘 값을 앱이 받은 시각 옆에 지금 값처럼 보여 주므로
   * stale=1 로 요청한 앱에만 준다 (옛 앱에는 true 인 항목을 주지 않는다)
   */
  stale?: boolean;
}

/** 목록: 출처 하나를 기다리는 최대 시간(연결·본문 포함). 출처들은 함께 부르므로 목록 전체도 이 안에 끝난다 — 앱 제한(10초)보다 짧게 */
const LIST_TIMEOUT_MS = 5_000;
/**
 * 실패한 항목의 마지막 정상값을 stale 로 이어 주는 최대 시간 (서버가 출처에서 받은 시각부터). 3시간:
 *  - 흔한 장애(제한 시간 초과·503·잠깐의 차단)는 몇 분~수십 분이면 풀리므로 그동안은 값이 사라지지 않고 "시세 지연"으로 보이게 넉넉히 덮는다
 *  - 그보다 오래 실패하면 출처 주소가 바뀌었거나 고장 난 것 — 장중 지수는 몇 시간이면 크게 움직이고, 표시가 있어도 몇 시간 넘은 값을 두면
 *    띠가 굳어 보인다. 정규장(6시간 30분)의 절반쯤에서 끊어, 멈춘 값이 한 세션 내내 또는 다음 날 세션 대부분까지 남지 않게 한다
 *  - 끊은 뒤에는 예전(main) 서버처럼 그 항목을 뺀다 (띠에서 빠지고 상세는 "시세를 불러오지 못했습니다")
 */
const STALE_MAX_MS = 3 * 60 * 60_000;
/** 차트: 출처 한 번 조회의 최대 시간 (본문 읽기 포함) */
const CHART_TIMEOUT_MS = 10_000;

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
  /**
   * 30초 캐시: all = 실패한 항목을 마지막 값(stale)으로 채운 목록 (stale 을 아는 앱),
   * legacy = 옛 앱용 — 이번에 받은 항목만, 전부 실패면 직전 목록 (main 서버와 같은 응답)
   */
  private cache: { at: number; all: MarketIndex[]; legacy: MarketIndex[] } | null = null;
  /**
   * 진행 중인 목록 조회. 캐시가 만료된 순간 요청이 겹쳐도(지수 띠·/api/widget·위젯끼리) 출처 9곳을 한 번만 부르고 결과를 나눠 쓴다
   */
  private inflight: Promise<{ at: number; all: MarketIndex[]; legacy: MarketIndex[] }> | null = null;
  /** 항목별 마지막 정상값과 받은 시각 (출처가 실패하면 STALE_MAX_MS 까지 이 값을 stale 로 준다) */
  private readonly last = new Map<string, { row: MarketIndex; at: number }>();
  /** 마지막으로 비어 있지 않던 목록(이번에 받은 항목만)과 받은 시각 — main 의 직전 목록. 전부 실패하면 옛 앱에 이것을 준다 */
  private lastList: { rows: MarketIndex[]; at: number } | null = null;
  private readonly chartCache = new Map<string, { at: number; want: number; series: CandleSeries }>();

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: { listTimeoutMs?: number; chartTimeoutMs?: number } = {},
  ) {}

  /**
   * 출처 JSON 한 번. 연결부터 본문 끝까지 ms 안에 못 받으면 요청을 끊고(abort) 실패로 끝낸다
   * (멈춘 출처 하나가 목록·차트 응답을 붙잡지 않게)
   */
  private async json(url: string, ms = this.limits.chartTimeoutMs ?? CHART_TIMEOUT_MS): Promise<unknown> {
    const ctrl = new AbortController();
    // fetch 가 signal 을 따르지 않아도(주입한 fetch 등) 제한 시간에 끝나게 같이 경쟁시킨다
    const expired = new Promise<never>((_, reject) => {
      ctrl.signal.addEventListener("abort", () => reject(new Error(`시간 초과 ${ms}ms (${url})`)), { once: true });
    });
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await Promise.race([this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" }, signal: ctrl.signal }), expired]);
      if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
      return await Promise.race([res.json() as Promise<unknown>, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async one(src: Source): Promise<MarketIndex | null> {
    try {
      const raw = (await this.json(src.url, this.limits.listTimeoutMs ?? LIST_TIMEOUT_MS)) as Json;
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

  /**
   * 지수 띠 목록.
   *  - stale: true (stale 을 아는 앱, 요청의 stale=1): 실패한 항목도 마지막 정상값을 stale 로 (받은 지 STALE_MAX_MS 까지)
   *  - 없으면(옛 앱): 예전(main) 서버와 같은 응답 — 옛 앱은 stale·fetchedAt 을 몰라, 멈춘 값을 앱이 받은 시각 옆에 지금 값처럼,
   *    stale 항목의 open:false 때문에 장중에도 "장 마감"으로 보여 준다. 그래서 항목별 마지막 값(all)은 주지 않는다:
   *    · 일부 실패: 실패한 항목을 뺀다
   *    · 전부 실패: main 처럼 직전 목록을 원래 open 그대로 (일부 실패 뒤 전부 실패면 그 일부 실패 목록 — 빠졌던 항목이 옛 값으로 되살아나지 않게).
   *      main 과 달리 직전 목록도 받은 지 STALE_MAX_MS 가 지나면 주지 않는다: 몇 시간 넘은 값을 옛 앱이 지금 값·장중처럼 계속 보이느니
   *      띠를 숨기고 상세는 "시세를 불러오지 못했습니다"로 두는 편이 낫다 (한 번도 못 받았을 때의 main 과 같은 모습)
   */
  async list(opts: { stale?: boolean } = {}): Promise<MarketIndex[]> {
    const t = this.now().getTime();
    if (!this.cache || t - this.cache.at >= 30_000) {
      this.inflight ??= this.fetchAll(t).finally(() => {
        this.inflight = null;
      });
      this.cache = await this.inflight;
    }
    return opts.stale ? this.cache.all : this.cache.legacy;
  }

  private async fetchAll(t: number): Promise<{ at: number; all: MarketIndex[]; legacy: MarketIndex[] }> {
    const fetchedAt = localIso(new Date(t).toISOString(), true);
    const rows = await Promise.all(INDEX_SOURCES.map((s) => this.one(s)));
    const fresh: MarketIndex[] = [];
    const all: MarketIndex[] = [];
    rows.forEach((row, n) => {
      const code = INDEX_SOURCES[n]!.code;
      if (row) {
        const got: MarketIndex = { ...row, fetchedAt, stale: false };
        this.last.set(code, { row: got, at: t });
        fresh.push(got);
        all.push(got);
        return;
      }
      // 이번에 못 받은 항목은 마지막 정상값을 원래 시각 그대로 stale 로. 장 상태는 확인하지 못했으니 장중으로 두지 않는다.
      // 받은 지 STALE_MAX_MS 가 지났으면 이어 주지 않는다 (고장 난 출처의 값이 계속 굳어 있지 않게)
      const prev = this.last.get(code);
      if (prev && t - prev.at < STALE_MAX_MS) all.push({ ...prev.row, open: false, stale: true });
    });
    // 옛 앱: 이번에 받은 항목만. 전부 실패면 직전 목록 그대로 (받은 지 STALE_MAX_MS 까지)
    if (fresh.length > 0) this.lastList = { rows: fresh, at: t };
    const prevList = this.lastList;
    const legacy = prevList && t - prevList.at < STALE_MAX_MS ? prevList.rows : [];
    return { at: t, all, legacy };
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
    // 지수 차트의 거래량은 국내·해외 모두 천주 단위 → 주 단위로 (종목 차트와 같게). 나스닥 1,375,034천주 = 약 13.8억 주 (BH-75)
    const volUnit = 1000;
    if (period === "D" || period === "W" || period === "M") {
      const path = period === "D" ? "day" : period === "W" ? "week" : "month";
      const rows = (await this.json(`${base}/${path}?${range(RANGE_DAYS[period](want))}`)) as Json[];
      return (Array.isArray(rows) ? rows : []).map((r) => dailyCandle(r, volUnit)).filter((c): c is Candle => c !== null);
    }
    if (kr) {
      const path = period === "1m" ? "minute" : period === "5m" ? "minute5" : "minute30";
      const rows = (await this.json(`${base}/${path}?${range(RANGE_DAYS[period](want))}`)) as Json[];
      return (Array.isArray(rows) ? rows : []).map((r) => minuteCandle(r, "+09:00", volUnit)).filter((c): c is Candle => c !== null);
    }
    // 해외 지수 분봉: 직전·당일 세션의 1분 시세(종가만) → 1분봉 → 5·30분
    const d = (await this.json(`${base}?periodType=day`)) as Json;
    const ticks = [...((d["lastPriceInfos"] as Json[] | undefined) ?? []), ...((d["priceInfos"] as Json[] | undefined) ?? [])];
    const minutes = ticksToMinutes(ticks, (date) => nyOffset(date), num(d["openPrice"]), true, volUnit);
    return aggregateIntraday(minutes, period === "1m" ? 1 : period === "5m" ? 5 : 30);
  }

  /**
   * 환율: 당일 고시 회차 → 분봉, 1년 일별 종가 → 일봉, 5년 주별 → 주봉.
   * 월봉은 최근 1년을 일별 종가로(월말 종가 정확), 그 이전은 10년 주별로 묶는다(주가 월말에 걸치면 그 주의 마지막 날 달로 들어가는 근사).
   */
  private async fxCandles(src: Source, period: CandlePeriod): Promise<Candle[]> {
    if (period === "M") {
      const [daily, weekly] = await Promise.all([this.fxSeries(src, "areaYear"), this.fxSeries(src, "areaYearTen")]);
      return fxMonthly(daily, weekly);
    }
    if (period === "D" || period === "W") return this.fxSeries(src, period === "D" ? "areaYear" : "areaYearFive");
    const r = await this.fxResult(src, "day");
    const ticks = [...((r["lastPriceInfos"] as Json[] | undefined) ?? []), ...((r["priceInfos"] as Json[] | undefined) ?? [])];
    const minutes = ticksToMinutes(ticks, () => "+09:00", num(r["openPrice"]), false);
    return aggregateIntraday(minutes, period === "1m" ? 1 : period === "5m" ? 5 : 30);
  }

  private async fxResult(src: Source, type: string): Promise<Json> {
    const url = `https://m.stock.naver.com/front-api/chart/pricesByPeriod?reutersCode=${encodeURIComponent(src.naver)}&category=exchange&chartInfoType=marketindex&scriptChartType=${type}`;
    const raw = (await this.json(url)) as Json;
    return (raw["result"] as Json | undefined) ?? {};
  }

  /** 일·주별 종가(시가 0) → 봉. 시가는 직전 종가로, 고·저는 그 둘을 포함하게 */
  private async fxSeries(src: Source, type: string): Promise<Candle[]> {
    const r = await this.fxResult(src, type);
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
    return out;
  }
}

/**
 * 환율 월봉: 일별 자료가 온전히 덮는 달(첫 일별 날짜의 다음 달부터)은 일별로, 그 전은 주별로 묶는다.
 * 봉 날짜는 그 달 1일, 시가는 직전 달 종가로 잇는다.
 */
export function fxMonthly(daily: Candle[], weekly: Candle[]): Candle[] {
  const first = daily[0]?.date;
  const cutoff = first ? nextMonth(first.slice(0, 7)) : null; // "YYYY-MM"
  const older = aggregateCandles(
    weekly.filter((c) => !cutoff || c.date.slice(0, 7) < cutoff),
    "M",
  );
  const recent = cutoff ? aggregateCandles(daily.filter((c) => c.date.slice(0, 7) >= cutoff), "M") : [];
  const out: Candle[] = [];
  for (const c of [...older, ...recent]) {
    const prev = out.at(-1);
    const open = prev ? prev.close : c.open;
    out.push({ ...c, date: `${c.date.slice(0, 7)}-01`, open, high: Math.max(c.high, open), low: Math.min(c.low, open) });
  }
  return out;
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function dailyCandle(r: Json, volUnit = 1): Candle | null {
  const p = splitStamp(String(r["localDate"] ?? ""));
  const close = num(r["closePrice"]);
  if (!p || close === null) return null;
  const open = num(r["openPrice"]) || close;
  return { date: p.date, open, high: num(r["highPrice"]) ?? Math.max(open, close), low: num(r["lowPrice"]) ?? Math.min(open, close), close, volume: (num(r["accumulatedTradingVolume"]) ?? 0) * volUnit };
}

function minuteCandle(r: Json, offset: string, volUnit = 1): Candle | null {
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
    volume: (num(r["accumulatedTradingVolume"]) ?? 0) * volUnit,
  };
}

/**
 * 시각별 가격(종가만, 누적 거래량 선택) → 1분봉. 같은 분의 가격들로 시·고·저·종을, 시가는 직전 분 종가(그날 첫 봉은 그날 시가)로.
 * cumulativeVolume 이면 누적 거래량의 차이를 그 분의 거래량으로 (날짜가 바뀌면 다시 센다. 세션 중간부터 온 날은 첫 값이 기준). volUnit 은 거래량 배율(천주 → 주).
 */
function ticksToMinutes(ticks: Json[], offsetOf: (date: string) => string, firstOpen: number | null, cumulativeVolume: boolean, volUnit = 1): Candle[] {
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
    const v = cumulativeVolume && vol !== null ? Math.max(vol - prevVol, 0) * volUnit : 0;
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
