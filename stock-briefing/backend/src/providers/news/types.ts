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

/** 흔한 이름 엔티티 (&amp; 는 맨 뒤에 따로 푼다) */
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  hellip: "…",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
};

/** 엔티티 한 겹 풀기: 숫자(&#8230;·&#x2026;)·이름 엔티티, 마지막에 &amp; */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g, (m, dec: string | undefined, hex: string | undefined) => {
      const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
    })
    .replace(/&(quot|apos|lt|gt|nbsp|hellip|middot|lsquo|rsquo|ldquo|rdquo|ndash|mdash);/g, (_m, name: string) => NAMED_ENTITIES[name]!)
    .replace(/&amp;/g, "&");
}

/**
 * 폭 없는 글자·방향 표시 (U+200B~U+200F 폭 없는 공백·연결자·방향 표시, U+2060 단어 연결자, U+FEFF BOM).
 * 제목·언론사 이름에서 지운다 — 실제 아주경제 제목 '[속보] (U+200B 7개)코스피, 63.01p(0.90%) 오른 7080.92 마감'처럼 보이지 않는 글자가 박혀 와서,
 * 앱이 글자 폭을 어림할 때 보이지 않는 글자까지 세어 카드에서 제목이 거의 다 잘렸다 (SS3/SS7)
 */
export const INVISIBLE_RE = /[\u200B-\u200F\u2060\uFEFF]/g;

/**
 * HTML 태그 제거 + 엔티티 복원 (숫자·16진 엔티티 포함). RSS 제목은 엔티티가 두 번 감싸여 오기도 해서('&amp;#8230;' → '…', '&amp;#63;' → '?')
 * 두 겹까지 푼다 — 풀지 않으면 '나스닥 &#8230; 상승'처럼 보이고, 감싼 물음표(&#63;)가 물음 제목 거르기를 빠져나간다.
 * 폭 없는 글자(INVISIBLE_RE — '&#8203;' 엔티티로 와도)는 지운다
 */
export function stripHtml(s: string): string {
  return decodeEntities(decodeEntities(s.replace(/<[^>]+>/g, "")))
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toIso(dateLike: string): string {
  const t = Date.parse(dateLike);
  return Number.isNaN(t) ? dateLike : new Date(t).toISOString();
}
