import type { FetchFn } from "./types.js";

/**
 * 장 운영 여부(휴장일·장중) 판단. 토스 웹 시세 API 가 종목마다 tradingEnd / nextTradingStart 를 주므로
 * 대표 종목(삼성전자, 애플) 하나씩만 보면 한국·미국 달력을 알 수 있다.
 *  - 오늘이 거래일: tradingEnd 또는 nextTradingStart 의 현지 날짜가 오늘
 *  - 장중: nextTradingStart 가 tradingEnd 보다 뒤이고 now < tradingEnd (세션이 진행 중이면 nextTradingStart 는 다음 세션)
 * 5분 캐시. 실패하면 요일 기반 추정으로 대체한다(주말만 휴장 취급).
 */

export type MarketKey = "KR" | "US";

export interface MarketState {
  market: MarketKey;
  isTradingDay: boolean; // 현지 날짜 기준 오늘 장이 열리는 날인지
  isOpen: boolean; // 지금 거래 시간인지 (한국은 KRX+NXT 통합 08:00~20:00, 미국은 프리~애프터)
  opensAt: string | null; // ISO, 다음(또는 오늘) 개장
  closesAt: string | null; // ISO, 현재/다음 세션 종료
  /** 장이 닫혀 있을 때 마지막 세션이 끝난 시각(ISO, 휴장일을 건너뛴 실제 값). 장중이거나 모르면 null */
  lastClose?: string | null;
  source: "toss" | "fallback";
}

export interface MarketStatus {
  now: string;
  KR: MarketState;
  US: MarketState;
}

const PRODUCTS: Record<MarketKey, string> = { KR: "A005930", US: "US19801212001" }; // 삼성전자, 애플
const TZ: Record<MarketKey, string> = { KR: "Asia/Seoul", US: "America/New_York" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function localDate(iso: string | Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(typeof iso === "string" ? new Date(iso) : iso);
}

export function fallbackState(market: MarketKey, now: Date): MarketState {
  const tz = TZ[market];
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(now));
  const weekday = !["Sat", "Sun"].includes(day);
  const open = weekday && (market === "KR" ? hour >= 8 && hour < 20 : hour >= 4 && hour < 20);
  return { market, isTradingDay: weekday, isOpen: open, opensAt: null, closesAt: null, source: "fallback" };
}

export function stateFromSession(market: MarketKey, now: Date, tradingEnd: string | null, nextStart: string | null): MarketState {
  if (!tradingEnd || !nextStart) return fallbackState(market, now);
  const end = Date.parse(tradingEnd);
  const next = Date.parse(nextStart);
  if (Number.isNaN(end) || Number.isNaN(next)) return fallbackState(market, now);
  const t = now.getTime();
  const today = localDate(now, TZ[market]);
  const isOpen = t < end && next > end;
  const isTradingDay = localDate(tradingEnd, TZ[market]) === today || localDate(nextStart, TZ[market]) === today;
  return {
    market,
    isTradingDay,
    isOpen,
    opensAt: isOpen ? null : new Date(next).toISOString(),
    closesAt: isOpen ? new Date(end).toISOString() : null,
    lastClose: !isOpen && end <= t ? new Date(end).toISOString() : null,
    source: "toss",
  };
}

export class MarketCalendar {
  /** until = TTL 끝 또는 가장 가까운 세션 경계(개장·마감) 중 이른 때 — 경계를 지나면 바로 다시 묻는다 */
  private cache: { until: number; status: MarketStatus } | null = null;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 5 * 60_000,
  ) {}

  private inflight: Promise<MarketStatus> | null = null;

  async status(): Promise<MarketStatus> {
    const now = this.now();
    if (this.cache && now.getTime() < this.cache.until) return { ...this.cache.status, now: now.toISOString() };
    // 캐시가 끝난 직후 동시에 들어온 요청은 한 번만 묻는다
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<MarketStatus> {
    const now = this.now();
    let KR = fallbackState("KR", now);
    let US = fallbackState("US", now);
    try {
      const res = await this.fetchFn(`https://wts-info-api.tossinvest.com/api/v3/stock-prices?productCodes=${PRODUCTS.KR},${PRODUCTS.US}`, {
        headers: { "user-agent": UA, accept: "application/json", referer: "https://tossinvest.com/" },
        signal: AbortSignal.timeout(5_000), // 멈춘 연결이 장 상태를 묻는 모든 요청을 붙잡지 않게
      });
      if (res.ok) {
        const rows = ((await res.json()) as { result?: Array<Record<string, unknown>> }).result ?? [];
        const by = new Map(rows.map((r) => [String(r["productCode"]), r]));
        const kr = by.get(PRODUCTS.KR), us = by.get(PRODUCTS.US);
        if (kr) KR = stateFromSession("KR", now, kr["tradingEnd"] as string | null, kr["nextTradingStart"] as string | null);
        if (us) US = stateFromSession("US", now, us["tradingEnd"] as string | null, us["nextTradingStart"] as string | null);
      }
    } catch {
      /* fallback 유지 */
    }
    const status: MarketStatus = { now: now.toISOString(), KR, US };
    const bounds = [KR, US].map((m) => Date.parse((m.isOpen ? m.closesAt : m.opensAt) ?? "")).filter((b) => !Number.isNaN(b) && b > now.getTime());
    this.cache = { until: Math.min(now.getTime() + this.ttlMs, ...bounds), status };
    return status;
  }

  /** 종목 코드의 시장이 오늘 거래일인지 */
  async isTradingDay(code: string): Promise<boolean> {
    const s = await this.status();
    return /^\d/.test(code) ? s.KR.isTradingDay : s.US.isTradingDay;
  }
}
