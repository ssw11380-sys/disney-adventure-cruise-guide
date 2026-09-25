import { isUsTradingDate, usRegularCloseMinutes } from "../../services/marketContext.js";
import type { FetchFn } from "./types.js";

/**
 * 장 운영 여부(휴장일·장중) 판단. 토스 웹 시세 API 가 종목마다 tradingEnd / nextTradingStart 를 주므로
 * 대표 종목(삼성전자, 애플) 하나씩만 보면 한국·미국 달력을 알 수 있다.
 *  - 오늘이 거래일: tradingEnd 또는 nextTradingStart 의 현지 날짜가 오늘
 *  - 장중: nextTradingStart 가 tradingEnd 보다 뒤이고 now < tradingEnd (세션이 진행 중이면 nextTradingStart 는 다음 세션)
 *  - 정해진 날짜가 거래일인지(isTradingDate): 마지막·지금·다음 세션의 날짜는 거래일, 마지막과 다음 사이는 휴장 (knownTradingDays)
 * 토스가 알려 주는 세션은 한국 KRX+NXT(08:00~20:00), 미국 정규장(09:30~16:00 ET)이다 — isOpen 의 뜻도 그대로 (추정값도 같은 뜻).
 * 5분 캐시. 실패하면 요일 기반 추정으로 대체한다(주말·미국 휴장일 목록만 휴장 취급 — 한국 평일 휴장일은 모른다).
 */

export type MarketKey = "KR" | "US";

export interface MarketState {
  market: MarketKey;
  /** 받은 때(현지 날짜) 오늘 장이 열리는 날인지. 정해진 날짜(브리핑 세션이 다루는 거래일 등)는 MarketCalendar.isTradingDate 로 묻는다 */
  isTradingDay: boolean;
  /**
   * 지금 거래 시간인지. 한국은 KRX+NXT 통합 08:00~20:00, 미국은 정규장(09:30~16:00 ET, 조기 폐장일 13:00)만 —
   * 미국 프리·애프터·주간거래는 false 다(세션별 판단은 services/liveSession·marketContext). 토스 달력이든 추정값(fallback)이든 같은 뜻
   */
  isOpen: boolean;
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

/** 현지 시각(자정부터 분) */
function localMinutes(now: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return (g("hour") % 24) * 60 + g("minute");
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 달력 없이 짐작한 거래일: 평일, 미국은 US_HOLIDAYS 도 뺀다 (한국 평일 휴장일은 목록이 없어 모른다) */
function guessTradingDate(market: MarketKey, date: string): boolean {
  if (market === "US") return isUsTradingDate(date);
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd >= 1 && wd <= 5;
}

/** 달력을 못 받았을 때의 추정값 — isOpen 은 토스 달력과 같은 뜻(한국 08:00~20:00, 미국 정규장 09:30~16:00 ET·조기 폐장 13:00) */
export function fallbackState(market: MarketKey, now: Date): MarketState {
  const tz = TZ[market];
  const date = localDate(now, tz);
  const m = localMinutes(now, tz);
  const isTradingDay = guessTradingDate(market, date);
  const open = isTradingDay && (market === "KR" ? m >= 8 * 60 && m < 20 * 60 : m >= 9 * 60 + 30 && m < usRegularCloseMinutes(date));
  return { market, isTradingDay, isOpen: open, opensAt: null, closesAt: null, source: "fallback" };
}

/**
 * 토스 달력이 알려 주는 날짜별 거래일 여부 (그 시장 현지 날짜): 지금 세션·마지막 세션·다음 세션의 날짜는 거래일, 마지막과 다음 사이는 휴장.
 * 날짜로 적어 두므로 몇 시간·며칠 전에 받은 달력이어도(조회가 실패해 마지막 값을 쓸 때) 아는 날은 틀리지 않는다.
 * 모르는 날은 넣지 않는다 (isTradingDay 는 받은 날 기준이라 쓰지 않는다. 요일 추정 fallback 은 아는 날이 없다)
 */
export function knownTradingDays(market: MarketKey, cal: MarketState | null | undefined): Map<string, boolean> {
  const known = new Map<string, boolean>();
  if (!cal || cal.source !== "toss") return known;
  const day = (x: string | null | undefined) => (x && !Number.isNaN(Date.parse(x)) ? localDate(x, TZ[market]) : null);
  if (cal.isOpen) {
    const c = day(cal.closesAt);
    if (c) known.set(c, true);
    return known;
  }
  const last = day(cal.lastClose);
  const next = day(cal.opensAt);
  if (last) known.set(last, true);
  if (next) known.set(next, true);
  if (last && next) for (let d = addDays(last, 1); d < next && known.size < 40; d = addDays(d, 1)) known.set(d, false);
  return known;
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
  /** 시장별로 마지막에 받은 토스 달력 — 조회가 실패해도 날짜별 사실(knownTradingDays)은 그대로 쓴다 */
  private lastToss: Partial<Record<MarketKey, MarketState>> = {};

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
    for (const m of [KR, US]) if (m.source === "toss") this.lastToss[m.market] = m;
    const bounds = [KR, US].map((m) => Date.parse((m.isOpen ? m.closesAt : m.opensAt) ?? "")).filter((b) => !Number.isNaN(b) && b > now.getTime());
    this.cache = { until: Math.min(now.getTime() + this.ttlMs, ...bounds), status };
    return status;
  }

  /** 종목 코드의 시장이 오늘(지금의 현지 날짜) 거래일인지 */
  async isTradingDay(code: string): Promise<boolean> {
    const s = await this.status();
    return /^\d/.test(code) ? s.KR.isTradingDay : s.US.isTradingDay;
  }

  /**
   * 그 시장 현지 날짜(YYYY-MM-DD)가 거래일인지 — "지금"이 아니라 정해진 날짜로 묻는다 (브리핑 세션이 다루는 거래일).
   * 토스 달력이 아는 날이면 그대로(조회가 실패하면 마지막으로 받은 토스 달력), 모르면 요일(미국은 US_HOLIDAYS 도)로 짐작한다
   */
  async isTradingDate(market: MarketKey, date: string): Promise<boolean> {
    const s = await this.status();
    const cal = s[market].source === "toss" ? s[market] : this.lastToss[market];
    return knownTradingDays(market, cal).get(date) ?? guessTradingDate(market, date);
  }
}
