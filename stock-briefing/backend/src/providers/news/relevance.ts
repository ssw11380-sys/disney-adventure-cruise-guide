import { isKrCode } from "../../lib/codes.js";
import type { NewsItem } from "./types.js";

/**
 * 종목 뉴스 관련도 필터 (순수 함수 → 단위 테스트). 무관 기사보다 빈 목록이 낫다는 원칙.
 *  - 30일 넘은 기사, 블로그·게임 매체 등은 뺀다
 *  - 이름이 흔한 단어·티커와 같은 종목(RTX·QQQI·SOXL)은 제목에 티커와 함께 주식·실적 관련 말이 있어야 한다 (지포스 RTX 기사 제외)
 *  - 이름은 앞뒤가 다른 글자로 이어지지 않아야 한다(라이튼·이튼튼 제외, 조사는 허용). 이름이 다른 뜻과 겹치는 종목은 종목별 제외어로 거른다
 */

export interface StockRef {
  code: string;
  name: string;
  market?: string;
}

export const NEWS_MAX_AGE_MS = 30 * 86_400_000;

/** 회사 이름 뒤에 붙는 말 (기사 제목에서는 빠지는 경우가 많다) */
const SUFFIX = /\s*(\((ADR|ETF|ETN)\)|홀딩스|컴퓨팅|네트웍스|네트워크스|코퍼레이션|테크놀로지스|테크놀로지|인더스트리즈|그룹|플랫폼스|Inc\.?|Corp\.?|Corporation|Holdings|\s[A-C])$/i;

/** 이름 대신 기사에 자주 쓰는 다른 이름 */
const ALIASES: Record<string, string[]> = {
  "035420": ["네이버"],
  CPNG: ["쿠팡"],
  AVGO: ["브로드컴"],
  GOOGL: ["구글", "알파벳"],
  GOOG: ["구글", "알파벳"],
  META: ["메타"],
  "BRK.B": ["버크셔"],
};

/** 이름이 다른 뜻과 겹치는 종목: 제목에 이 말이 있으면 뺀다 (이튼 메스·이튼 산불·이튼 칼리지, 농심(農心)·농지, 선진그룹 버스) */
const EXCLUDE: Record<string, RegExp> = {
  ETN: /메스|산불|칼리지|스쿨|학교|알렌/,
  "004370": /농지|농민|농가|농촌|농업인|쌀값|민심|청와대/,
  "136490": /선진그룹|버스|여객|운수/, // 선진(사료, 하림 계열) ≠ 선진그룹(버스)
};

/**
 * 두 글자 이하 한글 이름의 국내 종목 (대상·대교·대덕·선진·기아 …): 흔한 낱말·지명과 겹치기 쉽다.
 * 네이버 종목 뉴스(코드로 묶인 기사)는 제목에 이름만 맞으면 되지만, 이름 검색 결과는
 * 회사를 가리키는 꼴(첫머리 "대상, …"·대상㈜·㈜대상·대상그룹·"CJ·대상·오뚜기") + 주식 관련 말이나 회사 문맥이 있어야 남긴다.
 * ("유미코아 대상 177억 수주", "죽동·대덕·안산 특화단지" 같은 기사 제외)
 */
function companyForm(title: string, core: string): boolean {
  const n = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = "(?<![가-힣A-Za-z0-9])";
  const forms = [
    `^(\\[[^\\]]*\\]\\s*)?${n}([,·'"’”]|[은는이가의도]\\s)`, // 제목 첫머리: "대상, 3분기 …", "[공시]대상의 …"
    `${left}${n}(㈜|\\(주\\)|그룹|홀딩스)`, // 대상㈜·대상그룹
    `(㈜|\\(주\\))\\s*${n}(?![가-힣])`, // ㈜대상
    `[·,]\\s*${n}\\s*(·|,|등)`, // "CJ·대상·오뚜기"
  ];
  return forms.some((f) => new RegExp(f).test(title));
}

const COMPANY_CONTEXT = /그룹|회장|대표|사장|임직원|계열사|자회사|공장|신제품|출시|브랜드|㈜|\(주\)|주주|이사회|CEO|제품/;

const FINANCE =
  /주가|주식|종목|실적|매출|영업이익|순이익|배당|수주|계약|인수|합병|목표가|투자의견|애널리스트|증시|나스닥|뉴욕|상장|ETF|분기|시총|시가총액|공시|급등|급락|상승|하락|강세|약세|저평가|고평가|공정가치|밸류|순매수|매수|매도|레버리지|편입|지분|가이던스|월가/;

/** 뉴스로 보기 어려운 출처 (블로그·유료 칼럼·가상자산 시세 페이지·게임 하드웨어 매체) */
const BLOCKED_SOURCE = /브런치|brunch|티스토리|tistory|blog|블로그|카페|프리미엄콘텐츠|CoinGecko|GameGPU/i;

/** 이름 검색 결과에 섞이는 도박 스팸 제목 (카지노 종목·항공 슬롯 기사처럼 종목 이름이 제목에 있으면 거르지 않는다) */
const SPAM_TITLE = /토토|카지노|슬롯|포커|바카라|먹튀/;

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

/**
 * 이름 바로 뒤에 붙는 조사 (네이버서·이튼의·쿠팡이, 두 글자: 엔비디아까지·쿠팡으로·테슬라처럼).
 * '엔'·'랑' 같은 말은 넣지 않는다 (LG엔솔 ≠ LG)
 */
const PARTICLE = /^(까지|부터|보다|처럼|마저|조차|한테|으로|라도|[은는이가을를의에서와과도로만])/;

/**
 * 앞이 글자(한글·영문·숫자)로 이어지지 않는 위치에 word 가 있는지 (영문 이름은 대소문자 무시).
 * 뒤는 글자가 아니거나 조사면 된다 (라이튼·이튼튼 은 아니고 네이버서·이튼의 는 맞음)
 */
function hasWord(text: string, word: string): boolean {
  if (!word) return false;
  const letter = /[가-힣A-Za-z0-9]/;
  const latin = isLatinOnly(word);
  const hay = latin ? text.toUpperCase() : text;
  const variants = [...new Set([word, word.replace(/\s+/g, "")].map((w) => (latin ? w.toUpperCase() : w)))];
  for (const w of variants) {
    let i = hay.indexOf(w);
    while (i >= 0) {
      const before = i > 0 ? hay[i - 1]! : "";
      const after = hay[i + w.length] ?? "";
      if (!letter.test(before) && (!letter.test(after) || PARTICLE.test(hay.slice(i + w.length)))) return true;
      i = hay.indexOf(w, i + 1);
    }
  }
  return false;
}

/** 기초지수 이름에 들어가는 말 */
const INDEX_WORD = /S&P|나스닥|NASDAQ|다우|필라델피아|코스피|코스닥|MSCI|항셍|니케이|닛케이|유로스톡스|러셀/i;

/** 국내 상장 ETF 브랜드 */
const ETF_BRAND = /^(KODEX|TIGER|ACE|SOL|RISE|KBSTAR|HANARO|ARIRANG|PLUS|KOSEF|TIMEFOLIO)\s+/i;

/** 국내 ETF 는 기사 제목에 상품명보다 기초지수가 나온다: "KODEX 미국S&P500" → "미국S&P500", "S&P500" */
export function etfAliases(stock: StockRef): string[] {
  if (!isKrCode(stock.code) || !ETF_BRAND.test(stock.name)) return [];
  const rest = stock.name.replace(ETF_BRAND, "").replace(/\(H\)|\(합성\)/g, "").trim();
  const out = [rest];
  if (rest.startsWith("미국")) out.push(rest.slice(2).trim());
  // 지수 이름이 있는 것만 ("KODEX 200"의 "200", "KODEX 레버리지"의 "레버리지"처럼 흔한 말은 별칭으로 쓰지 않는다)
  return out.filter((x) => x.length >= 3 && INDEX_WORD.test(x));
}

function names(stock: StockRef): string[] {
  const core = coreName(stock.name);
  return [...new Set([stock.name, core, ...(ALIASES[stock.code.toUpperCase()] ?? []), ...etfAliases(stock)].filter(Boolean))];
}

/** 이름이 짧아(두 글자 이하 한글) 이름만으로는 고를 수 없는 국내 종목 */
export function isShortKrName(stock: StockRef): boolean {
  return isKrCode(stock.code) && /^[가-힣]{1,2}$/.test(coreName(stock.name));
}

/** fromNameSearch: 이름 검색 결과 (코드로 묶인 종목 뉴스보다 엄하게 본다) */
export function isRelevant(stock: StockRef, item: NewsItem, now: number, fromNameSearch = false): boolean {
  const at = Date.parse(item.publishedAt);
  if (Number.isNaN(at) || now - at > NEWS_MAX_AGE_MS) return false;
  if (item.source && BLOCKED_SOURCE.test(item.source)) return false;
  if (fromNameSearch && SPAM_TITLE.test(item.title) && !names(stock).some((n) => hasWord(item.title, n))) return false;
  const title = item.title;
  const us = !isKrCode(stock.code);
  const ticker = us && hasWord(title, stock.code.toUpperCase());
  const finance = FINANCE.test(title);
  if (isAmbiguous(stock)) return ticker && finance;
  if (EXCLUDE[stock.code.toUpperCase()]?.test(title)) return false;
  if (fromNameSearch && isShortKrName(stock)) return companyForm(title, coreName(stock.name)) && (finance || COMPANY_CONTEXT.test(title));
  // 흔한 낱말 이름은 요약문에 우연히 들어가기 쉬워 제목만 본다 ("한국IR대상" 기사 요약의 "대상")
  const text = isShortKrName(stock) ? title : `${title} ${item.summary ?? ""}`;
  return names(stock).some((n) => hasWord(text, n)) || (ticker && finance);
}

export function filterNews(stock: StockRef, items: NewsItem[], now: number, fromNameSearch = false): NewsItem[] {
  return items.filter((it) => isRelevant(stock, it, now, fromNameSearch));
}

/** 이름 검색(구글 뉴스) 질의: 최근 30일, 이름이 모호하면 티커 + 주식 관련 말 */
export function newsQuery(stock: StockRef): string {
  if (isAmbiguous(stock)) return `"${stock.code.toUpperCase()}" (주가 OR 주식 OR 실적 OR 배당 OR ETF) when:30d`;
  const etf = etfAliases(stock).at(-1);
  if (etf) return `("${etf}" OR "${stock.name}") (지수 OR 증시 OR ETF) when:30d`;
  if (isShortKrName(stock)) {
    const core = coreName(stock.name);
    return `("${core}㈜" OR "${core}그룹" OR "${core} 주가") when:30d`;
  }
  return `"${coreName(stock.name)}" when:30d`;
}
