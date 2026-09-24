import type { CandlePeriod, CandleSeries, ListedStock, Quote } from "../../domain/types.js";
import { mapLimit } from "../../lib/concurrency.js";
import { ProviderError, within } from "../../lib/errors.js";
import type { QuoteProvider, StockSearchProvider } from "./types.js";

/** 검색 소스 폴백 체인: 앞 소스가 실패하거나 결과가 없으면 다음 소스로 */
export class StockSearchChain implements StockSearchProvider {
  readonly name: string;

  constructor(
    private readonly providers: StockSearchProvider[],
    private readonly log: ChainLogger = { warn: () => {} },
  ) {
    if (providers.length === 0) throw new Error("StockSearchChain 에 최소 1개 소스가 필요합니다");
    this.name = providers.map((p) => p.name).join(">");
  }

  async search(query: string, limit: number): Promise<ListedStock[]> {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        const r = await p.search(query, limit);
        if (r.length > 0) return r;
      } catch (e) {
        lastErr = e;
        this.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, `검색(${query}) 실패, 다음 소스로`);
      }
    }
    if (lastErr) throw new ProviderError(this.name, `검색(${query}): 모든 소스 실패`, lastErr);
    return [];
  }
}

export interface ChainLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** 일괄 현재가에서 소스 하나를 기다리는 최대 시간 (넘으면 그 소스는 실패로 보고 다음 소스로) */
const PROVIDER_WAIT_MS = 8_000;

/**
 * 여러 QuoteProvider 를 순서대로 시도하는 폴백 체인.
 * 모든 소스가 실패하면 시도한 소스 목록을 담은 ProviderError 를 던진다.
 * 상위 계층(브리핑 파이프라인)은 이를 받아 "데이터 미확인"으로 기록한다.
 */
export class QuoteProviderChain implements QuoteProvider {
  readonly name: string;

  constructor(
    private readonly providers: QuoteProvider[],
    private readonly log: ChainLogger = { warn: () => {} },
  ) {
    if (providers.length === 0) throw new Error("QuoteProviderChain 에 최소 1개 소스가 필요합니다");
    this.name = providers.map((p) => p.name).join(">");
  }

  private async attempt<T>(label: string, code: string, fn: (p: QuoteProvider) => Promise<T>): Promise<T> {
    const attempted: string[] = [];
    let lastErr: unknown;
    for (const p of this.providers) {
      if (p.supports && !p.supports(code)) continue;
      attempted.push(p.name);
      try {
        return await fn(p);
      } catch (e) {
        lastErr = e;
        this.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, `${label} 실패, 다음 소스로`);
      }
    }
    throw new ProviderError(this.name, attempted.length ? `${label}: 모든 소스 실패 (${attempted.join(", ")})` : `${label}: 지원하는 소스 없음`, lastErr);
  }

  getQuote(code: string): Promise<Quote> {
    return this.attempt(`현재가(${code})`, code, (p) => p.getQuote(code));
  }

  /**
   * 여러 종목 현재가: 소스마다 아직 못 받은 종목만 넘긴다. 일괄 조회(getQuotes)가 있는 소스는 한 번에,
   * 없는 소스는 종목마다(동시 4개). 소스 하나가 오래 멈춰도 다음 소스로 넘어가게 소스당 시간 제한을 둔다.
   */
  async getQuotes(codes: string[]): Promise<Map<string, Quote | Error>> {
    const out = new Map<string, Quote | Error>();
    const tried = new Map<string, string[]>();
    let remaining = [...new Set(codes)];
    for (const p of this.providers) {
      const mine = remaining.filter((c) => !p.supports || p.supports(c));
      if (mine.length === 0) continue;
      for (const c of mine) tried.set(c, [...(tried.get(c) ?? []), p.name]);
      const timedOut = new ProviderError(p.name, `응답 없음 (${PROVIDER_WAIT_MS / 1000}초)`);
      const run: Promise<Map<string, Quote | Error>> = p.getQuotes
        ? p.getQuotes(mine)
        : mapLimit(mine, 4, (c) => p.getQuote(c).then((q): Quote | Error => q, (e: unknown) => (e instanceof Error ? e : new Error(String(e))))).then(
            (rs) => new Map(mine.map((c, i) => [c, rs[i]!])),
          );
      const got = await within(run, PROVIDER_WAIT_MS, null).then((m) => m ?? new Map(mine.map((c) => [c, timedOut as Error])));
      const failed: string[] = [];
      for (const c of mine) {
        const r = got.get(c);
        if (r && !(r instanceof Error)) out.set(c, r);
        else {
          failed.push(c);
          out.set(c, r ?? new ProviderError(p.name, `${c} 시세 없음`));
        }
      }
      if (failed.length)
        this.log.warn({ provider: p.name, codes: failed.slice(0, 10), failed: failed.length, err: (() => { const e = got.get(failed[0]!); return e instanceof Error ? e.message : undefined; })() }, "현재가 일괄 조회 일부 실패, 다음 소스로");
      remaining = remaining.filter((c) => !(out.get(c) && !(out.get(c) instanceof Error)));
      if (remaining.length === 0) break;
    }
    for (const c of remaining) {
      const last = out.get(c);
      const names = tried.get(c) ?? [];
      out.set(c, new ProviderError(this.name, names.length ? `현재가(${c}): 모든 소스 실패 (${names.join(", ")})` : `현재가(${c}): 지원하는 소스 없음`, last));
    }
    return out;
  }

  getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    return this.attempt(`봉차트(${code},${period})`, code, (p) => p.getCandles(code, period, count));
  }
}
