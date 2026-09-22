import type { CandlePeriod, CandleSeries, Quote } from "../../domain/types.js";
import { ProviderError } from "../../lib/errors.js";
import type { QuoteProvider } from "./types.js";

export interface ChainLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

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

  getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    return this.attempt(`봉차트(${code},${period})`, code, (p) => p.getCandles(code, period, count));
  }
}
