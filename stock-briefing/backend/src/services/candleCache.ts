import { INTRADAY_PERIODS, type CandlePeriod, type CandleSeries } from "../domain/types.js";

/**
 * 차트 봉 캐시 (3-18). 같은 종목·주기를 다시 열면 기다리지 않게 받아 둔 봉을 바로 주고, 오래됐으면 뒤에서 새로 받는다(stale-while-revalidate).
 *  - 새 값으로 보는 시간: 분봉 20초, 일·주·월봉 60초
 *  - 그보다 오래됐을 때 바로 주는 한도: 정규장 중엔 분봉 30초·일봉 10분, 장 밖엔 분봉 2분·일봉 12시간. 넘으면 기다려 새로 받는다
 *  - 받은 뒤 장 구간이 바뀌었으면(개장·마감·날짜 넘김) 옛 봉을 주지 않고 기다려 새로 받는다 → 개장 직후 어제 봉이 오늘 봉처럼 보이지 않게
 *  - 같은 종목·주기는 더 많이 받아 둔 것이 있으면 잘라서 준다 (800개를 받아 두면 90개 요청도 바로)
 *  - 마지막 봉은 앱이 실시간 체결로 고친다 (applyTickToCandles) → 캐시가 조금 늦어도 화면은 체결을 따라간다
 *  - 같은 요청이 겹치면 한 번만 받는다(받는 중인 개수가 모자라면 이어서 한 번 더). 새로 받기가 실패하면 받아 둔 값을 그대로 쓴다
 */

const MAX_ENTRIES = 300;

/** 종목의 지금 장 구간. key 가 받은 때와 다르면 옛 봉을 쓰지 않는다. regular = 정규장 진행 중 */
export type SessionOf = (code: string, at: number) => { key: string; regular: boolean };

interface Entry {
  at: number;
  count: number;
  session: string;
  series: CandleSeries;
}

export class CandleCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, { count: number; p: Promise<CandleSeries> }>();
  readonly stats = { hits: 0, stale: 0, misses: 0 };

  constructor(
    private readonly fetchFn: (code: string, period: CandlePeriod, count: number) => Promise<CandleSeries>,
    private readonly now: () => number = () => Date.now(),
    private readonly sessionOf: SessionOf = () => ({ key: "", regular: false }),
  ) {}

  private freshMs(period: CandlePeriod): number {
    return INTRADAY_PERIODS.has(period) ? 20_000 : 60_000;
  }

  private maxStaleMs(period: CandlePeriod, regular: boolean): number {
    if (INTRADAY_PERIODS.has(period)) return regular ? 30_000 : 2 * 60_000;
    return regular ? 10 * 60_000 : 12 * 3_600_000;
  }

  async get(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    const key = `${code}|${period}`;
    const e = this.entries.get(key);
    const t = this.now();
    const session = this.sessionOf(code, t);
    const age = e ? t - e.at : Infinity;
    const fresh = age < this.freshMs(period);
    // 받아 둔 것이 요청보다 적으면 새로 받는다. 받은 개수가 요청보다 적은 경우(상장 기간이 짧음, 또는 일부만 받힘)는 새 값일 때만 그대로
    const enough = e && (e.count >= count || (e.series.candles.length < e.count && fresh));
    if (e && enough && e.session === session.key && age < this.maxStaleMs(period, session.regular)) {
      if (fresh) this.stats.hits++;
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
    if (running && running.count >= count) return running.p;
    // 받는 중인 것이 모자라면 그게 끝난 뒤 더 많이 한 번 더 (겹쳐서 두 번 받지 않게)
    const before = running ? running.p.catch(() => undefined) : Promise.resolve();
    const p = before
      .then(() => this.fetchFn(code, period, count))
      .then((series) => {
        const at = this.now();
        this.entries.delete(key);
        this.entries.set(key, { at, count, session: this.sessionOf(code, at).key, series });
        while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
        return series;
      })
      .catch((err: unknown) => {
        const old = this.entries.get(key);
        if (old) return old.series;
        throw err;
      })
      .finally(() => {
        if (this.inflight.get(key)?.p === p) this.inflight.delete(key);
      });
    this.inflight.set(key, { count, p });
    return p;
  }
}

function slice(s: CandleSeries, count: number): CandleSeries {
  return s.candles.length <= count ? s : { ...s, candles: s.candles.slice(-count) };
}
