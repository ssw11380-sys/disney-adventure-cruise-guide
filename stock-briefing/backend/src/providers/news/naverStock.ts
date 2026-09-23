import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { ProviderError } from "../../lib/errors.js";
import type { NaverFundamentals } from "../market/fundamentals.js";
import type { FetchFn } from "../market/types.js";
import { stripHtml, type NewsItem, type NewsProvider } from "./types.js";

/**
 * 네이버 증권의 "종목 뉴스" (종목 페이지에 붙는 뉴스). 이름 검색보다 종목 관련도가 훨씬 높다.
 *  - 한국: m.stock.naver.com/api/news/stock/{6자리}?pageSize=N
 *  - 미국: api.stock.naver.com/news/stock/{로이터코드}?pageSize=N  (로이터코드는 NaverFundamentals.resolveReuters 로)
 * 응답은 [{ total, items: [{ officeId, articleId, officeName, datetime(YYYYMMDDHHmm), title, body }] }]
 * 기사 링크는 n.news.naver.com/mnews/article/{officeId}/{articleId}.
 */
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";

export class NaverStockNewsProvider implements NewsProvider {
  readonly name = "naver-stock";

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly fundamentals: Pick<NaverFundamentals, "resolveReuters"> | null = null,
  ) {}

  /** 이름 검색은 지원하지 않는다 (체인에서 forStock 만 쓴다) */
  async search(_query: string, _limit: number): Promise<NewsItem[]> {
    throw new ProviderError(this.name, "종목 코드로만 조회할 수 있습니다");
  }

  async forStock(stock: { code: string; name: string }, limit: number): Promise<NewsItem[]> {
    const code = normalizeCode(stock.code);
    let url: string;
    if (isKrCode(code)) url = `https://m.stock.naver.com/api/news/stock/${code}?pageSize=${limit}&page=1`;
    else {
      const rc = (await this.fundamentals?.resolveReuters(code)) ?? `${code}.O`;
      url = `https://api.stock.naver.com/news/stock/${encodeURIComponent(rc)}?pageSize=${limit}&page=1`;
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}`);
    const groups = (await res.json()) as Array<{ items?: Array<Record<string, unknown>> }>;
    if (!Array.isArray(groups)) throw new ProviderError(this.name, "응답 형식이 다릅니다");
    const out: NewsItem[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      for (const it of g.items ?? []) {
        const officeId = String(it["officeId"] ?? ""), articleId = String(it["articleId"] ?? "");
        const key = `${officeId}/${articleId}`;
        if (!officeId || !articleId || seen.has(key)) continue;
        seen.add(key);
        const dt = String(it["datetime"] ?? ""); // YYYYMMDDHHmm
        const iso = /^\d{12}$/.test(dt) ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}:00+09:00` : new Date().toISOString();
        out.push({
          title: stripHtml(String(it["titleFull"] ?? it["title"] ?? "")),
          url: `https://n.news.naver.com/mnews/article/${officeId}/${articleId}`,
          source: typeof it["officeName"] === "string" ? it["officeName"] : null,
          publishedAt: iso,
          summary: typeof it["body"] === "string" ? stripHtml(it["body"]).slice(0, 200) : null,
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}
