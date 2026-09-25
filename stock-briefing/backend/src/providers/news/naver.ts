import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FetchFn } from "../market/types.js";
import { stripHtml, toIso, type NewsItem, type NewsProvider } from "./types.js";

/**
 * 네이버 검색 API (뉴스). https://developers.naver.com 에서 애플리케이션 등록 후 Client ID/Secret 발급.
 * 일 25,000회 무료. 정렬 date = 최신순.
 */
export class NaverNewsProvider implements NewsProvider {
  readonly name = "naver-news";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async search(query: string, limit: number): Promise<NewsItem[]> {
    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${Math.min(
      limit,
      100,
    )}&sort=date`;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, {
        headers: { "X-Naver-Client-Id": this.clientId, "X-Naver-Client-Secret": this.clientSecret },
      });
    } catch (e) {
      throw new ProviderError(this.name, isTimeoutError(e) ? "시간 초과" : "네트워크 오류", e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { items?: Array<Record<string, string>> };
    return (json.items ?? []).slice(0, limit).map((it) => {
      const link = it["originallink"] || it["link"] || "";
      return {
        title: stripHtml(it["title"] ?? ""),
        url: link,
        source: hostOf(link),
        publishedAt: toIso(it["pubDate"] ?? ""),
        summary: it["description"] ? stripHtml(it["description"]) : null,
      };
    });
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
