export interface NewsItem {
  title: string;
  url: string;
  source: string | null; // 언론사
  publishedAt: string; // ISO
  summary: string | null;
}

export interface NewsProvider {
  readonly name: string;
  /** 종목명 기준 최신 뉴스. limit 개 이하, 최신순. */
  search(query: string, limit: number): Promise<NewsItem[]>;
  /** 종목 코드로 직접 조회할 수 있는 소스(네이버 종목 뉴스). 있으면 체인이 이름 검색보다 먼저 쓴다 */
  forStock?(stock: { code: string; name: string; market?: string }, limit: number): Promise<NewsItem[]>;
  /** 따옴표·OR·when:30d 같은 검색 문법을 알아듣는 소스(구글 뉴스). 종목 뉴스를 이름 검색으로 채울 때 이 소스를 쓴다 */
  readonly advancedQuery?: boolean;
}

/** HTML 태그 제거 + 흔한 엔티티 복원 */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function toIso(dateLike: string): string {
  const t = Date.parse(dateLike);
  return Number.isNaN(t) ? dateLike : new Date(t).toISOString();
}
