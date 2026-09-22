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
