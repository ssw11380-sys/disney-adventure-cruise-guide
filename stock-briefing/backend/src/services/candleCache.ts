import type { CandlePeriod, CandleSeries } from "../domain/types.js";

/**
 * 차트 봉 캐시 (3-18). 같은 종목·주기를 다시 열면 기다리지 않게 받아 둔 봉을 바로 주고, 오래됐으면 뒤에서 새로 받는다(stale-while-revalidate).
 *  - 새 값으로 보는 시간: 분봉 20초, 일·주·월봉 60초. 그보다 오래됐어도 분봉 5분·일봉 12시간 안이면 바로 주고 뒤에서 갱신
 *  - 같은 종목·주기는 더 많이 받아 둔 것이 있으면 잘라서 준다 (800개를 받아 두면 90개 요청도 바로)
 *  - 마지막 봉은 앱이 실시간 체결로 고친다 (applyTickToCandles) → 캐시가 조금 늦어도 화면은 체결을 따라간다
 *  - 같은 요청이 겹치면 한 번만 받는다. 새로 받기가 실패하면 받아 둔 값을 그대로 쓴다
 */

const INTRADAY: ReadonlySet<CandlePeriod> = new Set(["1m", "5m", "30m"]);
const MAX_ENTRIES = 300;

interface Entry {
  at: number;
  count: number;
  series: CandleSeries;
}

export class CandleCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CandleSeries>>();
  readonly stats = { hits: 0, stale: 0, misses: 0 };

  constructor(
    private readonly fetchFn: (code: string, period: CandlePeriod, count: number) => Promise<CandleSeries>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private freshMs(period: CandlePeriod): number {
    return INTRADAY.has(period) ? 20_000 : 60_000;
  }

  private maxStaleMs(period: CandlePeriod): number {
    return INTRADAY.has(period) ? 5 * 60_000 : 12 * 3_600_000;
  }

  async get(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    const key = `${code}|${period}`;
    const e = this.entries.get(key);
    const age = e ? this.now() - e.at : Infinity;
    // 받아 둔 것이 요청보다 적으면 새로 받는다 (상장 기간이 짧아 봉이 원래 적은 경우는 받은 개수로 판단)
    const enough = e && (e.count >= count || e.series.candles.length < e.count);
    if (e && enough && age < this.maxStaleMs(period)) {
      if (age < this.freshMs(period)) this.stats.hits++;
      else {
        this.stats.stale++;
        void this.refresh(key, code, period, Math.max(count, e.count)).catch(() => undefined);
      }
      this.entries.delete(key); // 최근 쓴 것을 뒤로 (LRU)
      this.entries.set(key, e);
      return slice(e.series, count);
    }
    this.stats.misses++;
    return slice(await this.refresh(key, code, period, Math.max(count, e?.count ?? 0)), count);
  }

  private refresh(key: string, code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fetchFn(code, period, count)
      .then((series) => {
        this.entries.delete(key);
        this.entries.set(key, { at: this.now(), count, series });
        while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
        return series;
      })
      .catch((err: unknown) => {
        const old = this.entries.get(key);
        if (old) return old.series;
        throw err;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

function slice(s: CandleSeries, count: number): CandleSeries {
  return s.candles.length <= count ? s : { ...s, candles: s.candles.slice(-count) };
}
