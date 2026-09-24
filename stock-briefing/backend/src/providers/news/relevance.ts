import { isKrCode } from "../../lib/codes.js";
import type { NewsItem } from "./types.js";

/**
 * 종목 뉴스 관련도 필터 (순수 함수 → 단위 테스트). 무관 기사보다 빈 목록이 낫다는 원칙.
 *  - 30일 넘은 기사, 블로그·게임 매체 등은 뺀다
 *  - 이름이 흔한 단어·티커와 같은 종목(RTX·QQQI·SOXL)은 제목에 티커와 함께 주식·실적 관련 말이 있어야 한다 (지포스 RTX 기사 제외)
 *  - 두 글자 이름(이튼)은 앞뒤가 다른 글자로 이어지지 않고(라이튼·이튼튼 제외), 티커나 주식 관련 말이 함께 있어야 한다
 */

export interface StockRef {
  code: string;
  name: string;
  market?: string;
}

export const NEWS_MAX_AGE_MS = 30 * 86_400_000;

/** 회사 이름 뒤에 붙는 말 (기사 제목에서는 빠지는 경우가 많다) */
const SUFFIX = /\s*(\((ADR|ETF|ETN)\)|홀딩스|컴퓨팅|네트웍스|네트워크스|코퍼레이션|테크놀로지스|테크놀로지|인더스트리즈|그룹|Inc\.?|Corp\.?|Corporation|Holdings)$/i;

/** 이름 대신 기사에 자주 쓰는 다른 이름 */
const ALIASES: Record<string, string[]> = {
  "035420": ["네이버"],
  CPNG: ["쿠팡"],
  AVGO: ["브로드컴"],
};

const FINANCE =
  /주가|주식|종목|실적|매출|영업이익|순이익|배당|수주|계약|인수|합병|목표가|투자의견|애널리스트|증시|나스닥|뉴욕|상장|ETF|분기|시총|시가총액|공시|급등|급락|상승|하락|강세|약세|저평가|고평가|공정가치|밸류|순매수|매수|매도|레버리지|편입|지분|가이던스|월가/;

/** 뉴스로 보기 어려운 출처 (블로그·가상자산 시세 페이지·게임 하드웨어 매체) */
const BLOCKED_SOURCE = /브런치|brunch|티스토리|tistory|blog|블로그|카페|CoinGecko|GameGPU/i;

export function coreName(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(SUFFIX, "").trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

const isLatinOnly = (s: string) => /^[A-Za-z0-9 .&-]+$/.test(s);

/** 이름이 흔한 단어·티커와 같아 이름만으로 기사를 고를 수 없는 미국 종목 */
export function isAmbiguous(stock: StockRef): boolean {
  if (isKrCode(stock.code)) return false;
  const core = coreName(stock.name);
  return isLatinOnly(core) && (core.toUpperCase() === stock.code.toUpperCase() || core.replace(/\s/g, "").length <= 5);
}

/** 이름 바로 뒤에 붙는 조사 (네이버서·이튼의·쿠팡이) */
const PARTICLE = /[은는이가을를의에서와과도로만]/;

/**
 * 앞이 글자(한글·영문·숫자)로 이어지지 않는 위치에 word 가 있는지.
 * 뒤는 글자가 아니거나 조사면 된다 (라이튼·이튼튼 은 아니고 네이버서·이튼의 는 맞음)
 */
function hasWord(text: string, word: string): boolean {
  if (!word) return false;
  const letter = /[가-힣A-Za-z0-9]/;
  const variants = [...new Set([word, word.replace(/\s+/g, "")])];
  for (const w of variants) {
    let i = text.indexOf(w);
    while (i >= 0) {
      const before = i > 0 ? text[i - 1]! : "";
      const after = text[i + w.length] ?? "";
      if (!letter.test(before) && (!letter.test(after) || PARTICLE.test(after))) return true;
      i = text.indexOf(w, i + 1);
    }
  }
  return false;
}

function names(stock: StockRef): string[] {
  const core = coreName(stock.name);
  return [...new Set([stock.name, core, ...(ALIASES[stock.code.toUpperCase()] ?? [])].filter(Boolean))];
}

export function isRelevant(stock: StockRef, item: NewsItem, now: number): boolean {
  const at = Date.parse(item.publishedAt);
  if (Number.isNaN(at) || now - at > NEWS_MAX_AGE_MS) return false;
  if (item.source && BLOCKED_SOURCE.test(item.source)) return false;
  const title = item.title;
  const us = !isKrCode(stock.code);
  const ticker = us && hasWord(title, stock.code.toUpperCase());
  const finance = FINANCE.test(title);
  if (isAmbiguous(stock)) return ticker && finance;
  const text = `${title} ${item.summary ?? ""}`;
  const hit = names(stock).filter((n) => hasWord(text, n));
  if (hit.length === 0) return ticker && finance;
  // 두 글자 이하 이름(이튼 등)은 다른 뜻과 겹치기 쉬워 티커나 주식 관련 말이 함께 있어야 한다
  const strong = hit.some((n) => n.replace(/\s/g, "").length >= 3);
  return strong || ticker || finance;
}

export function filterNews(stock: StockRef, items: NewsItem[], now: number): NewsItem[] {
  return items.filter((it) => isRelevant(stock, it, now));
}

/** 이름 검색(구글 뉴스) 질의: 최근 30일, 이름이 모호하면 티커 + 주식 관련 말 */
export function newsQuery(stock: StockRef): string {
  if (isAmbiguous(stock)) return `"${stock.code.toUpperCase()}" (주가 OR 주식 OR 실적 OR 배당 OR ETF) when:30d`;
  return `"${coreName(stock.name)}" when:30d`;
}
