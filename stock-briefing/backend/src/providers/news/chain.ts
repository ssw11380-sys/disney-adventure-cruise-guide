import { ProviderError } from "../../lib/errors.js";
import type { ChainLogger } from "../market/chain.js";
import { filterNews, newsQuery } from "./relevance.js";
import type { NewsItem, NewsProvider } from "./types.js";

export class NewsProviderChain implements NewsProvider {
  readonly name: string;
  constructor(
    private readonly providers: NewsProvider[],
    private readonly log: ChainLogger = { warn: () => {} },
    private readonly now: () => number = () => Date.now(),
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
   * 종목 뉴스: 코드로 조회할 수 있는 소스(네이버 종목 뉴스)를 먼저 쓰고, 관련도 필터(relevance.ts)를 거친다.
   * 걸러낸 뒤 절반도 안 차면 이름 검색(최근 30일, 이름이 모호하면 티커+주식 관련 말)으로 채운다.
   * 같은 기사(제목 정규화)는 한 번만. 관련 기사가 없으면 빈 목록 (무관 기사보다 낫다)
   */
  async forStock(stock: { code: string; name: string; market?: string }, limit: number): Promise<NewsItem[]> {
    const out: NewsItem[] = [];
    const seen = new Set<string>();
    const now = this.now();
    const add = (items: NewsItem[]) => {
      for (const it of filterNews(stock, items, now)) {
        const key = it.title.replace(/\s+/g, "").toLowerCase().slice(0, 40);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
    };
    let lastErr: unknown = null;
    for (const p of this.providers) {
      if (!p.forStock) continue;
      try {
        add(await p.forStock(stock, limit * 2));
      } catch (e) {
        lastErr = e;
        this.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, `종목 뉴스(${stock.code}) 실패, 다음 소스로`);
      }
      if (out.length >= limit) break;
    }
    if (out.length < Math.ceil(limit / 2)) {
      try {
        add(await this.search(newsQuery(stock), limit * 3));
      } catch (e) {
        // 이름 검색까지 실패했고 모은 것도 없으면 실패로 (빈 목록과 구분)
        if (out.length === 0) throw lastErr && !(e instanceof ProviderError) ? e : e;
      }
    }
    return out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)).slice(0, limit);
  }
}
