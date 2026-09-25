import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import type { ChainLogger } from "../market/chain.js";
import { coreName, filterNews, newsQuery } from "./relevance.js";
import type { NewsItem, NewsProvider } from "./types.js";

const NAME_CACHE_MS = 10 * 60_000;
/** 이름 검색은 호출한 곳(브리핑 8건·뉴스 탭 15건)과 관계없이 넉넉히 받아 캐시를 함께 쓴다 */
const NAME_SEARCH_SIZE = 45;

/** 제한 시간에 끊긴 요청인지 (소스가 ProviderError 로 감싼 경우 포함) */
const timedOut = (e: unknown) => isTimeoutError(e) || (e instanceof ProviderError && isTimeoutError(e.cause));

export class NewsProviderChain implements NewsProvider {
  readonly name: string;
  constructor(
    private readonly providers: NewsProvider[],
    private readonly log: ChainLogger = { warn: () => {} },
    private readonly now: () => number = () => Date.now(),
    private readonly retryDelayMs = 1_500,
  ) {
    if (providers.length === 0) throw new Error("NewsProviderChain 에 최소 1개 소스가 필요합니다");
    this.name = providers.map((p) => p.name).join(">");
  }

  async search(query: string, limit: number): Promise<NewsItem[]> {
    return this.searchAmong(this.providers, query, limit);
  }

  private async searchAmong(providers: NewsProvider[], query: string, limit: number): Promise<NewsItem[]> {
    const attempted: string[] = [];
    let lastErr: unknown;
    for (const p of providers) {
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
    const add = (items: NewsItem[], fromNameSearch = false) => {
      for (const it of filterNews(stock, items, now, fromNameSearch)) {
        const key = it.title.replace(/\s+/g, "").toLowerCase().slice(0, 40);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
    };
    let stockOk = false;
    for (const p of this.providers) {
      if (!p.forStock) continue;
      try {
        add(await p.forStock(stock, limit * 2));
        stockOk = true;
      } catch (e) {
        this.log.warn({ provider: p.name, err: e instanceof Error ? e.message : String(e) }, `종목 뉴스(${stock.code}) 실패, 다음 소스로`);
      }
      if (out.length >= limit) break;
    }
    if (out.length < Math.ceil(limit / 2)) {
      try {
        add(await this.nameSearch(stock, Math.max(limit * 3, NAME_SEARCH_SIZE), now), true);
      } catch (e) {
        // 종목 뉴스는 받았는데 이름 검색만 실패했으면 모은 것만 (빈 목록이어도 "관련 뉴스 없음"). 둘 다 실패면 실패
        if (!stockOk && out.length === 0) throw e;
      }
    }
    return out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, limit);
  }

  /** 이름 검색 결과 (질의마다 10분 캐시 — 브리핑이 여러 종목을 연달아 모을 때 구글이 503 을 내지 않게) */
  private readonly nameCache = new Map<string, { at: number; size: number; items: NewsItem[] }>();

  /** 검색 문법을 알아듣는 소스(구글)가 있으면 최근 30일 질의로, 없으면 이름만으로 일반 검색 */
  private async nameSearch(stock: { code: string; name: string }, limit: number, now: number): Promise<NewsItem[]> {
    const adv = this.providers.find((p) => p.advancedQuery);
    const query = adv ? newsQuery(stock) : coreName(stock.name);
    const key = `${adv ? "adv" : "plain"}:${query}`;
    const hit = this.nameCache.get(key);
    if (hit && now - hit.at < NAME_CACHE_MS && hit.size >= limit) return hit.items;
    const once = () => (adv ? adv.search(query, limit) : this.search(query, limit));
    let items: NewsItem[];
    try {
      // 구글은 연달아 부르면 잠깐 503 을 낸다 → 1.5초 뒤 한 번만 다시 (시간 초과는 다시 불러도 또 그만큼 걸리므로 바로 넘긴다)
      items = await once().catch(async (e: unknown) => {
        if (timedOut(e)) throw e;
        this.log.warn({ code: stock.code, err: e instanceof Error ? e.message : String(e) }, "이름 검색 실패, 한 번 더");
        await new Promise((r) => setTimeout(r, this.retryDelayMs));
        return once();
      });
    } catch (e) {
      // 구글이 끝내 실패하면 검색 문법이 필요 없는 소스(네이버 검색 API, 키가 있을 때)로 이름만 한 번 (BH-74)
      const plain = adv ? this.providers.filter((p) => p !== adv && !p.advancedQuery && !p.forStock) : [];
      if (plain.length === 0) throw e;
      this.log.warn({ code: stock.code, err: e instanceof Error ? e.message : String(e) }, "이름 검색 실패, 다른 검색 소스로");
      items = await this.searchAmong(plain, coreName(stock.name), limit);
    }
    for (const [k, v] of this.nameCache) if (now - v.at >= NAME_CACHE_MS) this.nameCache.delete(k);
    this.nameCache.set(key, { at: now, size: limit, items });
    return items;
  }
}
