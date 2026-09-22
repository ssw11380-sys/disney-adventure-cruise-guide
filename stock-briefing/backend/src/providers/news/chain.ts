import { ProviderError } from "../../lib/errors.js";
import type { ChainLogger } from "../market/chain.js";
import type { NewsItem, NewsProvider } from "./types.js";

export class NewsProviderChain implements NewsProvider {
  readonly name: string;
  constructor(
    private readonly providers: NewsProvider[],
    private readonly log: ChainLogger = { warn: () => {} },
  ) {
    if (providers.length === 0) throw new Error("NewsProviderChain 에 최소 1개 소스가 필요합니다");
    this.name = providers.map((p) => p.name).join(">");
  }

  async search(query: string, limit: number): Promise<NewsItem[]> {
    const attempted: string[] = [];
    let lastErr: unknown;
    for (const p of this.providers) {
      attempted.push(p.name);
      try {
        return await p.search(query, limit);
      } catch (e) {
        lastErr = e;
        this.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, `뉴스(${query}) 실패, 다음 소스로`);
      }
    }
    throw new ProviderError(this.name, `뉴스(${query}): 모든 소스 실패 (${attempted.join(", ")})`, lastErr);
  }
}
