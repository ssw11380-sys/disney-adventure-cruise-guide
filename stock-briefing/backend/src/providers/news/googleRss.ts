import { ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "../market/types.js";
import { stripHtml, toIso, type NewsItem, type NewsProvider } from "./types.js";

/**
 * Google News RSS (키 불필요). 네이버 키가 없거나 장애일 때 대체.
 * 제목 끝에 " - 언론사" 가 붙어 오므로 분리한다.
 */
export class GoogleNewsRssProvider implements NewsProvider {
  readonly name = "google-news-rss";
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async search(query: string, limit: number): Promise<NewsItem[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; stock-briefing/0.1)" } });
    } catch (e) {
      throw new ProviderError(this.name, "네트워크 오류", e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}`);
    return parseGoogleRss(await res.text()).slice(0, limit);
  }
}

export function parseGoogleRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1]!;
    const rawTitle = stripHtml(unwrapCdata(tag(body, "title")));
    const link = unwrapCdata(tag(body, "link")).trim();
    const pub = unwrapCdata(tag(body, "pubDate")).trim();
    const sourceTag = unwrapCdata(tag(body, "source")).trim();
    let title = rawTitle;
    let source: string | null = sourceTag || null;
    const dash = rawTitle.lastIndexOf(" - ");
    if (dash > 0) {
      title = rawTitle.slice(0, dash).trim();
      source = source ?? rawTitle.slice(dash + 3).trim();
    }
    if (!title) continue;
    items.push({ title, url: link, source, publishedAt: pub ? toIso(pub) : "", summary: null });
  }
  // pubDate 최신순
  return items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

function tag(body: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(body);
  return m?.[1] ?? "";
}

function unwrapCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1]! : s;
}
