import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FetchFn } from "../market/types.js";
import { stripHtml, toIso, type NewsItem, type NewsProvider } from "./types.js";

/**
 * Google News RSS (키 불필요). 네이버 키가 없거나 장애일 때 대체.
 * 제목 끝에 " - 언론사" 가 붙어 오므로 분리한다.
 */
export class GoogleNewsRssProvider implements NewsProvider {
  readonly name = "google-news-rss";
  readonly advancedQuery = true;
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async search(query: string, limit: number): Promise<NewsItem[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, { headers: { "user-agent": "Mozilla/5.0 (compatible; stock-briefing/0.1)" } });
    } catch (e) {
      throw new ProviderError(this.name, isTimeoutError(e) ? "시간 초과" : "네트워크 오류", e);
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
    // 언론사 이름도 제목처럼 엔티티를 푼다 ('S&amp;P Global'·'매일경제 &amp; MK' 같은 글이 언론사 칸에 그대로 보이지 않게)
    const sourceTag = stripHtml(unwrapCdata(tag(body, "source")));
    let title = rawTitle;
    let source: string | null = sourceTag || null;
    const dash = rawTitle.lastIndexOf(" - ");
    if (dash > 0) {
      // '… 혼조 마감 | - 연합인포맥스'처럼 언론사 앞에 세로줄이 붙어 오면 그 세로줄도 뗀다 (카드에 '마감 |'가 보이지 않게)
      const tail = rawTitle.slice(dash + 3).trim();
      title = stripTails(rawTitle.slice(0, dash), [tail, sourceTag]);
      source = source ?? tail;
    }
    if (!title) continue;
    items.push({ title, url: link, source, publishedAt: pub ? toIso(pub) : "", summary: null });
  }
  // pubDate 최신순
  return items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

/** 제목 끝 세로줄('… 마감 |') */
const BAR_TAIL_RE = /(?:\s*[|｜])+\s*$/;

/**
 * 제목 끝의 언론사 꼬리를 되풀이해서 뗀다 (SS2): 구글이 '… 마감 - 머니투데이 - 머니투데이'처럼 같은 언론사를 두 번 붙여 보내면
 * 마지막 하나만 떼어 카드에 '… 마감 - 머…'가 보였다. names = 떼어 낸 꼬리 이름과 source 태그 이름 (대소문자·띄어쓰기 무시)
 */
function stripTails(title: string, names: ReadonlyArray<string | null | undefined>): string {
  const keys = new Set(names.flatMap((n) => (n ? [n.replace(/\s+/g, "").toLowerCase()] : [])));
  let t = title.replace(BAR_TAIL_RE, "").trim();
  for (;;) {
    const dash = t.lastIndexOf(" - ");
    if (dash <= 0 || !keys.has(t.slice(dash + 3).replace(/\s+/g, "").toLowerCase())) return t;
    t = t.slice(0, dash).replace(BAR_TAIL_RE, "").trim();
  }
}

function tag(body: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(body);
  return m?.[1] ?? "";
}

function unwrapCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1]! : s;
}
