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

  /**
   * 종목 뉴스: 코드로 조회할 수 있는 소스(네이버 종목 뉴스)를 먼저 쓰고, 결과가 적으면 이름 검색 결과로 채운다.
   * 같은 기사(제목 정규화)는 한 번만.
   */
  async forStock(stock: { code: string; name: string; market?: string }, limit: number): Promise<NewsItem[]> {
    const out: NewsItem[] = [];
    const seen = new Set<string>();
    const add = (items: NewsItem[]) => {
      for (const it of items) {
        const key = it.title.replace(/\s+/g, "").toLowerCase().slice(0, 40);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
    };
    for (const p of this.providers) {
      if (!p.forStock) continue;
      try {
        add(await p.forStock(stock, limit));
      } catch (e) {
        this.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, `종목 뉴스(${stock.code}) 실패, 다음 소스로`);
      }
      if (out.length >= limit) return out.slice(0, limit);
    }
    if (out.length < Math.min(3, limit)) {
      try {
        add(await this.search(stock.name, limit));
      } catch (e) {
        if (out.length === 0) throw e;
      }
    }
    return out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)).slice(0, limit);
  }
}
