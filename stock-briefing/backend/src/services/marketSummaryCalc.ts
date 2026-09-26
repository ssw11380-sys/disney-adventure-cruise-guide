import { formatRate } from "../notifications/digest.js";
import { INVISIBLE_RE, type NewsItem } from "../providers/news/types.js";
import { nyWall } from "./accountNumbers.js";
import { briefingMarketDate } from "./briefingService.js";
import { isKrTradingDate, isUsTradingDate, KR_HOLIDAYS, krRegularHours, US_EARLY_CLOSES, US_HOLIDAY_NAMES } from "./marketContext.js";
import { kstWall, nextKrTradingDate, prevKrTradingDate, type SummaryEvent } from "./marketEvents.js";

/**
 * 시장 전체 요약 — 계산과 문장 (순수 함수, DB·네트워크 없음 → 단위 테스트).
 * AI(모델) 문장은 쓰지 않는다: 숫자는 모두 여기서 출처 값으로 계산하고, 문장은 틀에 숫자를 채운다. 뉴스는 언론사 제목 원문을 고르기만 한다.
 * 앱 lib/marketSummary.ts 에 같은 문장 함수가 있다 (shared/fixtures/marketSummary.json 으로 두 쪽이 같은 글을 내는지 본다).
 *  - 아침(morning) = 방금 끝난 미국 장, 오후(afternoon) = 오늘 한국 장
 *  - '오늘/밤사이'는 저장하지 않고 그릴 때 보는 날짜(한국)로 정한다 — 다음 날·주말에 보면 날짜로 바뀐다
 *  - 쓰지 않는 말: 선방·부진·기회·주의 같은 평가, '~때문에' 같은 원인. '강한/약한'은 업종 제목에만, 종목은 '지수보다 높음/낮음'
 */

export type SummarySession = "morning" | "afternoon";
export type SummaryMarket = "US" | "KR";

export interface SummaryIndex {
  code: string;
  name: string;
  value: number | null;
  change: number | null;
  changeRate: number | null;
  /** 값의 거래일 (그 시장 현지 날짜) */
  date: string | null;
  /** 출처 시세 시각 */
  asOf: string | null;
  /** 받지 못한 까닭 (있으면 칸은 '—') */
  missing?: string;
}

export interface SummaryFx {
  value: number;
  change: number;
  changeRate: number;
  /** 하나은행 고시 일별 시리즈의 마지막 날짜 (그 고시의 날짜). 모르면 null */
  date: string | null;
  stale: boolean;
}

export interface SummaryYield {
  value: number;
  change: number | null;
  /** 값의 날짜 (뉴욕) */
  date: string;
  prevValue: number | null;
  prevDate: string | null;
  /** treasury = 미 재무부 Daily Treasury Par Yield Curve, naver = 네이버(로이터 시장 수익률 US10YT=RR). 산출 방식이 달라 섞지 않는다 */
  source: "treasury" | "naver";
  /** 표시 소수 자리 (재무부 2·2, 네이버 3·4 — 출처가 준 자리 그대로) */
  dp: { value: number; change: number };
}

export interface SectorRow {
  name: string;
  /** 미국: 섹터 ETF 코드(XLK …), 한국: 네이버 업종 코드 */
  code: string;
  changeRate: number;
  /** 구성 종목 수 (한국) */
  count?: number;
}

export interface SummarySectors {
  /** etf = 미국 SPDR 섹터 ETF 11개 정규장 종가, naver = 네이버 한국 업종(시가총액 가중·상장 첫날 보정) */
  basis: "etf" | "naver";
  date: string;
  strong: SectorRow[];
  weak: SectorRow[];
  /** 순위 전체 (미국은 11개 막대, 한국은 뺀 뒤 남은 업종) */
  all: SectorRow[];
  excluded: Array<{ name: string; changeRate: number; reason: string }>;
  /** 출처 업종 수 */
  total: number;
}

export type CompareGroup = "high" | "similar" | "low";

export interface CompareRow {
  code: string;
  name: string;
  changeRate: number;
  benchmark: { code: string; name: string; changeRate: number };
  /** 종목 등락률 − 기준 지수 등락률 (%p, 소수 둘째 자리) */
  diff: number;
  group: CompareGroup;
}

export interface HoldingsCompare {
  market: SummaryMarket;
  /** 비교한 종목 수 (뺀 종목 제외) */
  compared: number;
  up: number;
  down: number;
  flat: number;
  high: CompareRow[];
  similar: CompareRow[];
  low: CompareRow[];
  /** 뺀 종목 이름. bond(채권·금리형 ETF)는 나중에 더한 칸이라 예전에 저장한 요약에는 없다 */
  excluded: { leverage: string[]; overseas: string[]; bond: string[]; noQuote: string[]; noBenchmark: string[] };
  /** 비교에 쓴 지수 (보조 줄 '나스닥 +0.48% · S&P500 +0.51%') */
  benchmarks: Array<{ code: string; name: string; changeRate: number }>;
}

export interface SummaryNews {
  title: string;
  outlet: string;
  publishedAt: string;
  url: string;
}

export interface MarketSummaryData {
  version: 1;
  session: SummarySession;
  market: SummaryMarket;
  /** 요약 날짜 (한국, 브리핑 세션 날짜) */
  date: string;
  /** 이 세션이 다루는 거래일 (미국 아침은 전날, 월요일은 금요일 — briefingMarketDate). 휴장이면 그 휴장일 */
  marketDate: string;
  /** 숫자가 속한 거래일 (휴장이면 직전 거래일) */
  basisDate: string;
  /** 만든 시각 (한국 시간 ISO) */
  asOf: string;
  /** 평일 휴장 (주말은 넣지 않는다 — basisDate 로 날짜만 옮긴다) */
  holiday: { date: string; name: string | null } | null;
  /** 월요일 아침: 금요일 장 뒤 주말 이틀 */
  weekendGap: boolean;
  /** 미국 조기 폐장일 (13:00 ET) */
  earlyClose: boolean;
  /** 정규장 마감 시각: 한국은 서울 HH:MM, 미국은 뉴욕 HH:MM */
  closeTime: string;
  /** final = 확정, intraday = 아직 장중(마감 전 실행), prelim = 미국 마감 직후 최종값 전(네이버 최종값 17:15 ET 전) */
  phase: "final" | "intraday" | "prelim";
  indices: SummaryIndex[];
  fx: SummaryFx | null;
  yield10y: SummaryYield | null;
  sectors: SummarySectors | null;
  holdings: HoldingsCompare | null;
  events: { within: SummaryEvent[]; next: SummaryEvent | null; unknown: string[] };
  news: { query: string; from: string; to: string; items: SummaryNews[]; fresh: boolean };
  /** 받지 못한 것·뺀 까닭 (상세 화면 안내) */
  notes: string[];
  /**
   * refinal = 장중·최종값 전 요약을 확정 시각 + 5분에 저절로 다시 만든 것 (뉴스 창이 그 시각에 닫혀 있다).
   * 그날 그 세션의 예약·수동 실행이 뒤에 오면 한 번 더 만들어 뉴스 창을 정상(마감 뒤 6시간 또는 실행 시각)으로 넓힌다. 예전에 저장한 요약에는 없다
   */
  origin?: "refinal";
}

// ── 상수 ────────────────────────────────────────────────────

/** '비슷' 기준: 지수와 차이가 ±1.00%p 안 (경계 포함은 높음·낮음). 사용자 확인 대상 — 이 상수 하나만 바꾼다 */
export const SIMILAR_BAND_BP = 100;
/** 카드·요약 줄 최대 수 */
export const MAX_LINES = 6;
/** 카드·상세 뉴스 최대 건수 (카드는 앞의 2건 제목) */
export const NEWS_MAX = 3;
/** 세션 알림을 기다리게 하는 최대 시간 — 넘으면 요약 줄 없이 보낸다 */
export const SUMMARY_WAIT_MS = 20_000;

export const US_INDEX_CODES = ["NASDAQ", "SPX", "DJI", "SOX"] as const;
export const KR_INDEX_CODES = ["KOSPI", "KOSDAQ"] as const;
export const INDEX_NAMES: Record<string, string> = { NASDAQ: "나스닥", SPX: "S&P500", DJI: "다우", SOX: "필라반도체", KOSPI: "코스피", KOSDAQ: "코스닥" };

/** SPDR 섹터 ETF 11개 (네이버 로이터 코드 — XLRE 만 .K 가 붙는다, 2026-09-26 실측) */
export const US_SECTOR_ETFS: ReadonlyArray<{ reuters: string; code: string; name: string }> = [
  { reuters: "XLK", code: "XLK", name: "기술" },
  { reuters: "XLF", code: "XLF", name: "금융" },
  { reuters: "XLV", code: "XLV", name: "헬스케어" },
  { reuters: "XLE", code: "XLE", name: "에너지" },
  { reuters: "XLI", code: "XLI", name: "산업재" },
  { reuters: "XLY", code: "XLY", name: "경기소비재" },
  { reuters: "XLP", code: "XLP", name: "필수소비재" },
  { reuters: "XLU", code: "XLU", name: "유틸리티" },
  { reuters: "XLB", code: "XLB", name: "소재" },
  { reuters: "XLRE.K", code: "XLRE", name: "부동산" },
  { reuters: "XLC", code: "XLC", name: "커뮤니케이션" },
];

/** 한국 업종에서 뺄 값: 구성 종목이 이보다 적거나 등락률 절댓값이 이보다 크면 (상장 첫날 종목 한 개가 평균을 끌어올린 경우 등) */
export const KR_SECTOR_MIN_COUNT = 5;
export const KR_SECTOR_MAX_ABS = 30;

export const NEWS_QUERY: Record<SummaryMarket, string[]> = { US: ["뉴욕증시"], KR: ["코스피 마감", "코스피"] };
/** 뉴스 창: 세션 마감 −10분 ~ 실행 시각, 단 마감 뒤 6시간까지만 (월요일·연휴 뒤 주말 전망 기사가 섞이지 않게) */
export const NEWS_BEFORE_CLOSE_MS = 10 * 60_000;
export const NEWS_AFTER_CLOSE_MS = 6 * 3_600_000;
/** 네이버 미국 지수 최종값 시각 (뉴욕 17:15) — 그 전 실행이면 '최종값 확정 전' */
const US_FINAL_MIN = 17 * 60 + 15;

/**
 * ── 뉴스 제목 거르기 ──
 * 언론사 제목은 원문 그대로만 보이므로(고치지 않는다) 매매 권유·전망·물음으로 읽힐 수 있는 제목은 통째로 뺀다.
 * 낱말 목록만으로는 새 말이 계속 새어 나와(검토마다 '찬스'·'최선호주'·'들어갈 때'·'사들여야'…), 모양으로 먼저 막는다:
 *  ① 따옴표 속 남의 말(인용) — 권유·전망이 가장 많이 들어오는 길 (quotedSpeech)
 *  ② 끝 모양 — 명령형 '~아라·~어라'와 존댓말 명령 '~세요·~십시오·~시길'(commands), 청유 '(엔비디아) 사자…'(proposes), 당위 '~아야·~어야·~해야'(ought),
 *     때 짚기 '~ㄹ 때'(timingCall), 물음 '~나·~ㄴ가·~ㄹ까'(asksQuestion), 예측 '~ㄹ 것·~ㄹ 수 있다·~면 …·~ㄹ지도 모른다·끝 '~기대''(predicts),
 *     말투 '~합니다·~해요'(politeTalk — 기사 제목이 아니라 해설·광고 글)
 *  ③ 낱말 목록 — 권유(ADVICE_RE)·값 매기기(VALUE_RE)·전망(OUTLOOK_RE)·영문 전망·권유(ENGLISH_RE)
 * 모양 검사는 제목 전체와, 끝에 붙은 언론사·말머리('- 머니투데이'·' By EBN'·'[1분 브리프]')를 뗀 본문(coreTitle) 둘 다에 한다.
 * 2026-09-08~26 실제 구글 뉴스 RSS 1만여 건(서비스 질의·창 그대로 + 넓은 질의 + 권유가 많을 질의)을 통과 제목 하나하나 읽어 보고 다듬었다.
 */

/** 낱말 끝 (뒤에 한글·영문·숫자가 오지 않음) — 괄호·말머리·동그라미 숫자('③') 앞도 낱말 끝 */
const B = "(?![가-힣A-Za-z0-9])";
/** 물음표 제목은 뺀다 (고치지 않는다) */
const QUESTION_RE = /[?？]/;
/**
 * 매매 권유형 제목은 뺀다 — 사는 쪽·파는 쪽을 같은 꼴로 막는다 (명령·권유·허락 묻기·당위·때 짚기).
 * 앱 test/wording.test.ts 의 금지 문구 목록 전체가 여기서 막힌다 (backend 테스트가 그 목록을 읽어 하나씩 넣어 본다).
 * 이 파일도 금지 문구 검사를 받으므로 금지 문구를 글자 그대로 적지 않고 묶음 꼴로 적는다 ('(?:적극|강력)\s?매[수도]' 등).
 *  - 목표가는 줄임말과 '목표(주)가'·띄어 쓴 꼴·한자('목표價')·어순이 바뀐 '주가 목표 상향'까지 (영문 'price target'·'Sees AMD at $720'은 ENGLISH_RE)
 *  - 명령·권유형: '매수하라'·'지금 사라'·'비중 늘려라'·'매수 적기'·'톱픽'·'top pick'·'최선호주'·'투자의견'·'올라타라'·'지금이 기회'·'찬스'·
 *    '매수 권고·권유·권장'·'강추'·'줍줍'·'매수 신호'·'매수 전략'·'분할 매수'·'전략 유효'·'매매법'·'그래도 사라는 증권가'(남의 권유를 옮긴 말)·
 *    '무시하지 마세요'·'놓치지 마라' (그 밖의 명령형 끝은 commands, 청유 '사자…'는 proposes)
 *  - 종목 추천 목록·추천 난: '수혜주 3선'·'AI 주식 3선'·'눈여겨볼 배당주'·'오늘장 공략주'·'주요 종목 선정'·'AI가 선정한 기술주'·'황금종목'·
 *    '웃는 주식 따로 있다'·'수혜를 노리는'·'반등 노리는'·'현 시점 전략 세워보니'·'[애널픽]'·'[핫픽!미국주식]'·'추석 픽'·'초고수'·'투자분석'·'미리 포착'
 *  - 때 짚기(사는 쪽·파는 쪽 모두): '살·팔·담을·들어갈·나설·늘릴·줄일 때'·'살 종목'·'지금 살 때인가'·'지금은 매수할 때'·'매도할 시점'·'살 만한'·'사둘 만한'
 *    (그 밖의 마디 끝 '~ㄹ 때'는 timingCall)
 *  - 당위·허락 묻기: '사야 한다'·'팔아야'·'늘려야'·'사도 되나'·'지금 매수해도 된다'·'지금 사면 안 된다'·'사면 늦었다'·'사도 늦지 않다'
 *    (그 밖의 당위 끝 '~아야·~어야·~해야'는 ought)
 *  - 값 매기기·투자 까닭: '저평가'·'고평가'·'과대평가'·'매력적인 투자처'·'달러를 보유하는 이유'·'은퇴 준비를 위한 …'
 *  - 단정·보장: '무조건'·'반드시', 수익(률)·원금을 보장한다는 말, '손절'·'익절'
 *  - 말머리: 투자 전략·노하우·투자 리포트 난('[증시전략]'·'[투자 노하우]'·'[데일리 투자리포트]')
 *  사실을 적은 말은 둔다: '사라져'·'사라진'('사라'는 뒤에 글자가 없을 때만), '실적기대'('적기'는 낱말 앞에서만), '팔라듐', '기회비용'·'기회발전특구',
 *  '회사야'('사야'는 낱말 앞에서만), '순매수'·'매수세'·'저가 매수세', '30살 때'(나이 — '살'·'팔' 앞에 숫자가 오면 둔다), '공매도'
 */
const ADVICE_RE = new RegExp(
  [
    "살까|팔까|추천|목표\\s?[주株]?[가價]|주가\\s?목표|유망|톱\\s?픽|탑\\s?픽|top[\\s-]?picks?|투자\\s?의견",
    // 종목 추천 목록·추천 난 (6차 검토 + 말뭉치 검토: '배당주 3종'·'이 7가지 주식을 모아가는 이유'·'전문가는 이것 뽑았다'·'AI가 선택한 미국 주식'·
    // '2026년 9월 최고의 배당주'·'모틀리풀이 꼽은 AI 반도체 5선'·'월가 거물들이 찜한 종목'·'1년 묵힐 종목'(끝 모양은 timingCall)·'배당주가 답이다')
    `(?:주|종목|주식|株)\\s?\\d{1,2}(?!\\d)\\s?[선종]${B}|\\d+\\s?가지\\s?(?:주식|종목|배당주)|\\d+\\s?개\\s?분석|잡주`,
    "눈여겨\\s?볼|공략\\s?(?:주|종목)|황금\\s?종목|수혜주|초고수|투자\\s?분석|전략\\s?세워|현\\s?시점\\s?전략|미리\\s?포착|꼽(?:은|았)|찜(?:한|했)|이것\\s?뽑|뽑은\\s?(?:종목|주식)",
    "(?:종목|주식|유망주|기술주|배당주|가치주|성장주|관련주)\\s?선정|선정한\\s?(?:종목|주식|기술주|배당주|가치주|성장주|유망주)|AI\\s?(?:가\\s?)?(?:선정|선택)|선정\\s?종목|종목\\s?(?:리스트|소개|발굴)",
    "최고의\\s?(?:종목|주식|배당주|[가-힣]{0,3}주)(?![가-힣])|(?:이|가)\\s?답이다|재테크|절세|종잣돈|입문|필독|고수익|돈\\s?되는|요령|(?<=[가-힣])는\\s?법(?![가-힣A-Za-z0-9])",
    "웃는\\s?(?:주식|종목|株)|(?:주식|종목|株)\\s?따로\\s?있|(?:반등|상승|수익|차익|반전|회복|저점|수혜)[을를]?\\s?노리|(?:모아가|모으|사들이|매수하)는\\s?이유|(?<![가-힣])사는\\s?이유",
    "(?:애널|핫|원|톱|탑|주간|오늘의|추석|연휴|올해|작년|고수|증권사|전문가|월가)\\s?픽|(?<![가-힣])픽(?![가-힣])|\\[[^\\]]*(?<!올림|그래|트래)픽[^\\]]*\\]",
    "\\[[^\\]]*(?:이\\s?종목|줌인|(?:버핏|애널|증권사|종목)\\s?리포트)[^\\]]*\\]",
    // 하지 말라는 권유 ('무시하지 마세요'·'놓치지 마라')
    `마세요|마십시오|지\\s?(?:마라|말라|말자|마)${B}`,
    "매[수도]\\s?(?:의견|적기|타이밍|시점|신호|시그널|전략|유효|권고|권유|기회|찬스)|분할\\s?매[수도]|(?:투자|매매)\\s?전략|전략\\s?유효",
    "권고|권유|권장|강추|찬스|최선호|줍줍|(?<![가-힣])적기|비중\\s?(?:확대|축소)|기회(?!비용|발전)|(?:적극|강력)\\s?매[수도]",
    "매[수도](?:하세요|하라|해라|하자|해야|해도)|[사파]세요|(?:담아|늘려|줄여|팔아)(?:라|야)",
    `(?<![가-힣])사야(?:겠|지)?${B}|(?<![가-힣])사도\\s?(?:되|돼|될|괜찮)|팔아도\\s?(?:되|돼|될|괜찮)|(?<![가-힣])[사팔]라${B}`,
    `(?<![가-힣])(?:사|팔|담으|버티|매[수도]하|사들이|갈아타)(?:라는|라고|란)${B}`,
    "(?:(?<![가-힣\\d])[살팔]|담을|들어갈|나설|늘릴|줄일|사들일|갈아탈|모을|올라탈|매[수도]할)\\s?(?:때(?!문)|종목|만(?:하|한|해)|시점|타이밍|적기)",
    "(?<![가-힣])(?:사\\s?둘|담아\\s?둘|모아\\s?둘|눈여겨\\s?볼|주목할|관심\\s?가질|투자할)\\s?만(?:하|한|해)",
    "(?<![가-힣])(?:사|팔|담으|들어가|올라타|매[수도]하)면\\s?(?:안\\s?[되돼된]|된다|돼|늦|손해|후회)|늦지\\s?않|(?<![가-힣])나서야",
    "사\\s?[둬두]라|사들여라|갈아타라|모아라|올라[타탈]|(?:수익률?|원금)\\s?보장|무조건|반드시|손절|익절",
    "저평가|고평가|과대평가|과소평가|매력적|투자처|매매법|투자법|돈\\s?버는|(?:은퇴|노후)\\s?(?:준비|대비)|(?:보유|투자|매수|편입|주목)(?:하는|할|해야\\s?할)\\s?이유|담는\\s?이유",
    "\\[[^\\]]*(?:전략|노하우|투자\\s?리포트|투자\\s?포인트)[^\\]]*\\]",
    // (7차 검토) 종목 하나를 띄우는 소개 글: '커스텀 AI 반도체 … 연결의 강자 - 마벨 테크놀로지(MRVL)'·'AI 반도체의 숨은 강자 - 브로드컴(AVGO)'
    // ('반도체 강자 삼성전자 3% 상승'처럼 강자 뒤에 줄표가 없으면 둔다). 끝이 '회사(종목 기호)'인 꼴은 tickerIntro (대소문자를 가려 본다)
    "강자\\s?[-–—:|]|(?:숨은|숨겨진|진정한|차세대|떠오르는|새로운)\\s?(?:강자|보석|대장주|주도주)",
    // (8차 검토) 종목 분석 난·따라 사기 난·영문 PICK 말머리·상품 제안·테마주 몰이:
    // '[종목분석] 마벨 테크놀로지(MRVL)'·'AI 데이터센터의 숨은 수혜 기업, 마벨(MRVL)'·'[기관따라잡기]연기금, … 순매수'·'[오늘의 딜 PICK]'·
    // '한화운용, 반도체 매출 비중 높은 ETF 3종 제안'·'유리 기판 관련주 전반에 매수 온기 확산'·'외국인이 쓸어담는 종목'·'하락장에서 빛나는 배당주'
    // ('호르무즈 재개방 제안'·'주식 공모 제안에 주가 하락'처럼 상품·종목을 내미는 말이 아니면 둔다)
    "종목\\s?분석|수혜\\s?(?:기업|종목)|\\[[^\\]]*따라\\s?(?:잡기|하기|사기)[^\\]]*\\]|(?:외국인|기관|연기금|고수|큰손|슈퍼\\s?개미)\\s?따라\\s?(?:잡기|하기|사기|매매)|\\[[^\\]]*\\bpicks?\\b[^\\]]*\\]",
    "(?:ETF|펀드|상품|종목|주식|포트폴리오)\\s?(?:\\d+\\s?(?:종|개|선|가지)\\s?)?(?:제안|소개)|관련주[^…⋯]{0,20}(?:매수\\s?)?온기|쓸어\\s?담(?:는|은)\\s?(?:종목|주식|株)|빛나는\\s?(?:종목|주식|[가-힣]{1,3}주)(?![가-힣])",
    // (7차 검토) '삼성전자 담아볼 만'·'사볼 만한 반도체주'·'존버가 답'·'이 종목 사면 대박'·'지금 반도체 사면 수익'
    "볼\\s?만(?:하|한|해|(?=$|\\s|…|⋯|‥|,|!|\\.{2,}))|존버|(?<=[가-힣])(?:이|가)\\s?답(?=$|\\s*(?:…|⋯|‥|\\.{2,}|,|!))",
    "(?<![가-힣])(?:사|팔|담으|들어가|올라타|매[수도]하|투자하)면\\s?(?:수익|대박|이득|이익|돈|번다|벌|오른다|[2-9]배|두\\s?배)",
    // (7차 검토) 업종·종목을 좋다·나쁘다로 가르거나 추려 내미는 목록: '항공株엔 호재, 해운株엔 악재'·'외국인 순매수 중인 순위 Top5'·'[투자자 순매수 TOP5]'
    // ('중동 악재에 하락'·'반도체 호재에 상승'처럼 그날 움직임의 까닭은 둔다, '시총 톱10 중 절반'도 둔다)
    // (8차 검토) 종목 순위 표: '[표] 거래소 외국인 순매수도 상위종목(11일)'·'[주식 매매 상위 종목 및 환율]' (TOP5 와 같은 종류)
    "(?:株|주|업종|종목|기업|증시)(?:엔|에는|에겐|에게는?)\\s?(?:호재|악재)|호재[,·]\\s?[^…⋯]{0,15}악재|악재[,·]\\s?[^…⋯]{0,15}호재|(?:(?<![A-Za-z])top|톱|탑)\\s?\\d{1,2}(?![\\d가-힣]|\\s?중)|상위\\s?(?:\\d+\\s?개\\s?)?종목",
    // (7차 말뭉치 검토) 환율·유가의 업종 득실 가르기: '항공주 웃고 해운·수출주는 실적 부담'·'항공주는 웃고 해운주 울고…식음료는 딜레마'·'해운·식품주는 셈법 복잡'·
    // '환율 하락에 항공주 수혜', 증권사 보고서 해설·투자 입문·'배당주 시즌'. (8차 검토) 과거형 '항공주는 웃고 해운주는 울었다'도 같은 꼴이라 막는다
    "(?:株|주)(?:는|은)?\\s?(?:웃고|울고)[^…⋯]{0,25}(?:부담|딜레마|셈법)|(?:株|주)(?:는|은)?\\s?셈법\\s?복잡|(?:株|주)\\s?수혜|웃고\\s?[^…⋯]{0,15}울(?:고|었|어)|울고\\s?[^…⋯]{0,15}웃(?:고|었|어)",
    "리서치\\s?리포트|리포트\\s?해설|(?:시작하는|쉽게\\s?배우는|따라\\s?하는)\\s?[^…⋯]{0,10}투자|배당주\\s?시즌",
    // (7차 검토) 지수 목표 값: '증권가, 코스피 연말 목표 8000 제시'·'목표 7500 상향'
    "(?:코스피|코스닥|나스닥|지수|주가|S&P\\s?500|다우)\\s?(?:연말\\s?|연내\\s?|내년\\s?)?목표\\s?\\d|목표\\s?\\d[\\d,.]*\\s?(?:선|포인트|p|pt)?\\s?(?:제시|상향|하향)",
  ].join("|"),
  "i",
);
/**
 * (7차·8차 검토) 끝이 '회사(종목 기호)'인 종목 소개 글: '… 연결의 강자 - 마벨 테크놀로지(MRVL)'·'AI 반도체 강자, 브로드컴(AVGO)'·
 * '커스텀 AI 반도체 연결의 강자 마벨 테크놀로지(MRVL)'·'광통신 연결의 강자… 마벨 테크놀로지(MRVL)'·'숨은 수혜 기업, 마벨(MRVL)'.
 * 줄표·쌍점으로 끝 이름을 떼어 붙였거나, 띄우는 낱말(강자·수혜 기업·대장주·주도주·유망주·기대주)이 앞에 있으면 막는다.
 * 기호는 대문자만 본다(대소문자를 가린다). 이름과 기호가 같은 언론사 꼬리('코스피 0.9% 상승 마감 - KBS(KBS)')는 둔다
 */
const TICKER_END_RE = /\(([A-Z]{1,5}(?:\.[A-Z])?)\)\s*$/;
const TICKER_DASH_RE = /\s[-–—:]\s?([^-–—:]{1,30})$/;
const INTRO_WORD_RE = /강자|수혜\s?(?:기업|주|종목)|대장주|주도주|유망주|기대주|보석/;
export function tickerIntro(title: string): boolean {
  const m = TICKER_END_RE.exec(title);
  if (!m) return false;
  const head = title.slice(0, m.index);
  const dash = TICKER_DASH_RE.exec(head);
  if (dash) return dash[1]!.trim() !== m[1];
  return INTRO_WORD_RE.test(head);
}
/**
 * 주가를 싸다·비싸다고 매기는 제목은 뺀다 ('저평가·고평가'와 같은 종류 — 6차 검토 must): '적정 수준으로 보인다'·'적정주가'·'공정가치보다 낮은'·
 * '할인된 가격에 거래'·'비싸 보인다'·'싸졌다'·'과열된 모습'·'내재가치'·'가격 매력'·'배당 매력'.
 * 끝이 '~보인다'·'~거래 중'·'~모습'이어도 같은 낱말이면 막는다 (같은 출처의 '… 적정 가격에 도달했을 수 있다'만 막히던 어긋남을 없앤다)
 */
const VALUE_RE = new RegExp(
  [
    "적정\\s?(?:주?가|가격|가치|수준|밸류)|공정\\s?가치|내재\\s?가치|할인된\\s?(?:가격|수준|값)|할인\\s?거래",
    "(?:가격|밸류(?:에이션)?|투자|배당|주가)\\s?매력|과열(?:된)?\\s?(?:모습|양상|구간|신호)|싸\\s?보(?:인|여|이)|비싸(?:다|졌|진|지|게)|(?<![가-힣])싸(?:다|졌|진|게)",
    "저렴|프리미엄\\s?수준",
  ].join("|"),
);
/**
 * 영문 제목의 전망·권유 낱말 ('Nvidia Forecast'·'Here's Where Shares Could Go'·'Sees AMD at $720'·'price target'·'Top Pick'·'Buy rating'·'undervalued').
 * 'sell-off'(급락)·'buyback'(자사주 매입)은 사실이라 둔다
 */
const ENGLISH_RE =
  /\b(?:forecasts?|could|would|should|will|might|outlook|predicts?|predictions?|expects?|expected|expectations?|targets?|upside|downside|poised|sees|buy|sell(?![\s-]?offs?\b)|top\s+picks?|upgrades?|upgraded|downgrades?|downgraded|overweight|underweight|outperform|underperform|bullish|bearish|undervalued|overvalued|cheap|bargain|stocks?\s+to\s+watch|set\s+to|heads?\s+(?:toward|for)|(?:shares|stocks?|index|nasdaq|kospi)\s+to\s+(?:rally|surge|soar|climb|jump|rise|gain|fall|drop|plunge|slump|tumble|rebound|recover|double|triple|hit|reach|top))\b/i;
/**
 * 의견 난(사설·칼럼 등)은 뺀다 — 그날 장의 사실이 아니라 필자의 주장이다 ('[사설] … 대비하길'·'[여명] … 보내자').
 * 기자 이름을 단 난('[김남현의 채권썰]'·'[신윤우의 외환분석]'·'[김혜란의 FX]' — 세 글자 이름 + '의')과 '[기자수첩]'·'[우보세]'·'[이슈프리즘]'·'[애널리스트의 시각]'도.
 * '[오늘의 증시]'처럼 두 글자 + '의'는 사실 난이라 둔다
 */
const OPINION_RE = /\[[^\]]*(?:사설|칼럼|시론|기고|오피니언|논단|여명|수첩|시평|우보세|프리즘|지지대|노트북|애널리스트)[^\]]*\]|\[[가-힣]{3}의\s[^\]]*\]/;
/**
 * 도박·광고 글 (넓은 질의에 섞여 온다 — 카드에 오르면 안 된다). 띄어 쓴 '파워 볼'·'크레이지타임'·'배팅법'·'경마배팅'·'블랙잭'·'섯다'·
 * '텔레그램 게임방'·'스포츠 베팅 api'·'무료 차익 거래 베팅 안내'까지 (6차 검토), 게임·코인 안내 글('게임 규칙에 나오는 …'·'… 변환기 및 환율'·
 * '… 의 모든 측면: 장점, 단점 …'·'해외 배당주 순위 …'). 금융 기사의 '반도체에 베팅'·'게임주'·'시리즈B 라운드'는 둔다
 */
const SPAM_RE = new RegExp(
  [
    // '포커'는 '[경제 포커스]'·'[아주증시포커스]' 같은 난 이름을 빼고 (7차 말뭉치 검토)
    "카지노|바카라|토토|슬롯|룰렛|파워\\s?볼|포커(?!스)|홀덤|도박|먹튀|마작|크레이지\\s?타임|배팅|(?<!신)경마|블랙잭|섯다|텔레그램|게임방|꽁머니",
    "스포츠\\s?베팅|베팅\\s?(?:사이트|안내|방법|법|api)|머니\\s?시세|w88|프리서버|무료\\s?(?:시청|스핀)|하이\\s?로우|보드\\s?게임|빙고|슬링고|고스톱|바둑이|리겜",
    "밸런스\\s?게임|변환기\\s?및\\s?환율|코인마켓캡|의\\s?모든\\s?측면|장점,\\s?단점|디자인\\s?패턴|배당주\\s?순위|게임\\s?(?:규칙|설명|화면|데이터|시작|진행|유형|정보|핵|사이트)",
    "규칙\\s?(?:문서|페이지)|사이트\\s?(?:순위|규칙)|맞고\\s?(?:버그|환전)|뉴\\s?맞고|뽑기|내기\\s?승리|설정\\s?메뉴|메뉴\\s?(?:지도|구별)",
    // 앱 안내 꼴 광고 글 ('… 주가 정보 버튼과 설정 버튼의 차이'·'… 이용 시간 알림 기능 확인'·'… 앱 시각적 구성')
    "버튼(?:과|의)\\s|기능\\s?확인|시각적\\s?구성",
  ].join("|"),
  "i",
);
/**
 * 당위 끝 '~아야·~어야·~여야·~해야'(낱말 끝): '사들여야'·'갈아타야'·'버텨야'·'정리해야'·'들어가야'·'비중 늘려야'·'지켜봐야'·'대비해야'·'개선돼야'.
 * 목록에 없는 당위도 막으려고 끝 모양으로 본다 (명령형 commands 와 같은 방식). 사실을 적은 말은 둔다:
 * 이름씨 '분야'·'시야'·'회사야'·'여야'(여당과 야당), 때를 적은 '이제서야'·'그제야'·'지나서야'·'들어서야'('4분기 들어서야 반등')
 */
const OUGHT_RE = new RegExp(`([가-힣]*)([가-힣])야(?:${B}|(?=지|죠|할|한다|하는))`, "g");
const OUGHT_BEFORE = new Set([..."아어여해돼와워줘둬봐타켜쳐춰꿔겨려혀져텨펴러써가내셔"]);
/** 끝 모양은 같지만 당위가 아닌 낱말 ('여야' = 여당과 야당) */
const NOT_OUGHT = new Set(["여야"]);
export function ought(title: string): boolean {
  for (const m of title.matchAll(OUGHT_RE)) if (OUGHT_BEFORE.has(m[2]!) && !NOT_OUGHT.has(m[0])) return true;
  return false;
}
/**
 * 인용 발언이 든 제목은 뺀다 — 권유·전망이 가장 많이 들어오는 길이 따옴표 속 남의 말('"저가 매수 찬스"'·'증권가 "최선호주는 …"')이라,
 * 낱말 목록으로 쫓는 대신 모양으로 막는다. 따옴표(곧은·굽은·홑·겹·낫표·`) 안이 숫자·종목 기호뿐이면 둔다('7000'·"7000선"·'3%'·'NVDA'·'S&P500').
 * 낱말 뒤 아포스트로피(Nvidia's·투데이’s)와 '26년·‘25년 같은 해 줄임은 따옴표가 아니다. 짝이 맞지 않는 따옴표는 인용으로 본다.
 * (강조 따옴표 '7천피'·'전강후약'도 함께 빠진다 — 말뭉치에서 통과 제목의 약 4분의 1이 줄지만 창마다 11건 넘게 남는다)
 */
const QUOTE_RE = /["“”‘’'ʼ「」『』＂＇`]/g;
const PLAIN_QUOTED_RE = /^\s*(?:[+-]?\d[\d.,]*\s?(?:%p?|bp|원|달러|포인트|선|배|대|만|천|억|조|p)*|[A-Z][A-Z0-9.&-]{0,9})\s*$/;
export function quotedSpeech(title: string): boolean {
  const marks = [...title.matchAll(QUOTE_RE)]
    .map((m) => m.index!)
    .filter((i) => {
      const c = title[i]!;
      if (c !== "'" && c !== "’" && c !== "‘" && c !== "ʼ") return true;
      if (c !== "‘" && /[가-힣A-Za-z0-9]/.test(title[i - 1] ?? "") && /[A-Za-z]/.test(title[i + 1] ?? "")) return false; // Nvidia's · 투데이’s
      return !/^\d{2}(?:년|\s|$)/.test(title.slice(i + 1)) || /\d/.test(title[i - 1] ?? ""); // '26년 · ‘25년
    });
  if (!marks.length) return false;
  if (marks.length % 2) return true;
  for (let k = 0; k < marks.length; k += 2) if (!PLAIN_QUOTED_RE.test(title.slice(marks[k]! + 1, marks[k + 1]!))) return true;
  return false;
}
/**
 * 명령형 낱말 끝 '~아라·~어라·~여라·~해라·~하라'('사둬라'·'사들여라'·'갈아타라'·'모아라'·'버텨라'·'던져라'·'정리하라'·'대비하라'·'체질을 바꿔라③').
 * 목록에 없는 명령형도 막으려고 끝 모양으로 본다. 이름으로 쓰이는 낱말('사하라'·'티아라')은 둔다
 */
const IMPERATIVE_RE = new RegExp(`([가-힣]*[아어여해하둬워와봐타켜쳐춰꿔겨려혀져텨])라${B}`, "g");
const NOT_IMPERATIVE = new Set(["사하라", "티아라", "오하라"]);
/**
 * 존댓말 명령·바람 끝 (6차 검토 must): '매도하십시오'·'매수하시길'·'갈아타세요'·'비중 줄이세요…'·'사두세요'·'늘리세요'·'담으세요'·'분산 투자하세요'·
 * '투자하길'·'대비하시오'. 반말 '~라'만 보던 빈 곳을 끝 모양으로 막는다
 */
const HONORIFIC_COMMAND_RE = new RegExp(`(?:세요|십시오|시오|시길|하길|하시라|으시라|하소서)${B}`);
/** 청하는 끝 '~ㅂ시다'('삽시다'·'담읍시다'·'투자합시다') */
const LETS_RE = new RegExp(`([가-힣])시다${B}`, "g");
export function commands(title: string): boolean {
  for (const m of title.matchAll(IMPERATIVE_RE)) if (!NOT_IMPERATIVE.has(`${m[1]}라`)) return true;
  if (HONORIFIC_COMMAND_RE.test(title)) return true;
  for (const m of title.matchAll(LETS_RE)) if (finalOf(m[1]!) === 17 || m[1] === "읍") return true;
  return false;
}
/**
 * 청유 '~자'(마디 끝): '송편 먹고 엔비디아 사자…'·'지금 팔자'·'반도체 담자'·'저점에 줍자'·'배당주 모으자'·'AI주 올라타자'·'미국 국채에 투자하자' (6차 검토 must).
 * 투자자 무리가 바로 앞(같은 마디 12글자 안)에 오면 사실이다: '외국인 사자·기관 팔자에 보합'·'외인 '1.5조' 팔자 [마감시황]'·'개미들 삼성전자 사자'
 * (시장 낱말로 쓰는 '사자·팔자'), 뒤에 토씨가 붙은 '외국인 사자에'도 둔다
 */
const PROPOSE_RE = /(?<![가-힣])(?:[사팔담줍]|모으|사\s?두|사들이|갈아타|올라타|들어가|버티|쟁이|투자하|베팅하)자/g;
const MARKET_ACTOR_BEFORE_RE = /(?:외국인|외인|기관|개인|개미|연기금|투신|큰손|금융투자|외국계|서학개미|동학개미|투자자)(?:(?!…|⋯|·|,|!|\.\.).){0,12}$/;
export function proposes(title: string): boolean {
  for (const m of title.matchAll(PROPOSE_RE)) {
    if (!CLAUSE_END.test(title.slice(m.index! + m[0].length))) continue;
    if (MARKET_ACTOR_BEFORE_RE.test(title.slice(0, m.index!))) continue;
    return true;
  }
  return false;
}
/**
 * 해설·광고 글의 말투 (기사 제목은 이렇게 끝나지 않는다): '~합니다·~입니다·~습니다'('꺾이는 신호입니다'·'더 중요합니다'),
 * '~해요·~에요·~네요·~죠'. 물음 '~까요·~나요'는 asksQuestion
 */
const POLITE_YO_RE = new RegExp(`(?:해|에|예|네|어|아|워|와|래|군|걸|든|잖아)요${B}|(?<=[가-힣])죠${B}`);
export function politeTalk(title: string): boolean {
  for (const m of title.matchAll(new RegExp(`([가-힣])니(?:다|까)${B}`, "g"))) if (finalOf(m[1]!) === 17) return true;
  return POLITE_YO_RE.test(title);
}
/**
 * 전망형 제목은 뺀다 (사용자 규칙 '전망 없이' — 월요일·연휴 뒤 창에 섞이는 주간 전망 기사 등): '이번주 증시 전망'·'금주·차주 증시'·'다음주 체크포인트'·'내주 FOMC'·
 * '지속될 듯'·'실적 예상'·'예측'·'~할 것이란 관측'·'2배 간다'·'5000 온다'·'추가 상승 가능성'·'상승 여력·여지'·'바닥은 어디인가 … 찍었는가'·
 * '[위클리 증시]'·'관전 포인트'·'인하 점쳐'·'3000 돌파 임박'·'상승세 이어진다'·'금리 더 오른다'·'방향이 바뀐다'·'몸값 2700조 넘본다'·
 * '조정 경고'·'수급 주목'·'향후 흐름'·'인상 불가피'·'수급 변수'·'변곡점'·'반도체 시험대'·'수급이 관건'·'반등 달렸다'·'1400원대 바라보는'·'추가 하락은 제한적'·
 * '험난한 앞날'·'이익 눈높이'·'코스피지수 목표치'·'밴드 상단'·'상단 7764'·'1,380원 상단 시험'·
 * (6차 검토) '2배 상승도 가능'·'주가 상승 유효'·'꺾이는 신호'·'강세장 신호'·'추가 상승 vs 다시 하락'·'매매시나리오'·'줄초상 예고'·'커브 플랫에 무게'·
 * '인상론에 힘 실려'·'반등 열쇠는'·'실적이 분수령'·'증시에 중요한 이유'·'적정 수준으로 보인다'(짐작)
 * (7차 검토) '8000선 위태'·'7000선 위협'·'8000도 가능'·'15만원 가능'·'연말 7500'·'연내'·'연말까지'·'당분간'·'돌파 무난'·'오를 일만 남았다'·'성장 예고'
 * ('~ㄹ 것'·'~ㄹ 수 있다'·'~ㄹ지'·'~면 …'·끝 '~기대'·'~우려'는 predicts·asksQuestion, 먼 앞날 해의 규모 단정은 futureYearOutlook). '관측소'·'내주며'·'여지없이'·'상장 폐지 경고 받아'·'부회장, 하이닉스로 보임'(자리 옮김)·
 * '반도체에 힘 싣는다'(회사 결정)·'통행료 예고에 하락'(발표)·'매도 우세'는 사실을 적은 말이라 둔다
 */
const OUTLOOK_RE = new RegExp(
  [
    "전망|주간|위클리|관전\\s?포인트|(?<![가-힣])점[쳐친치]|임박|이어진다|이번\\s?주|다음\\s?주|(?<![가-힣])[금차]주(?![가-힣])|내주(?=$|\\s)",
    "예상|예측|관측(?!소)|향방|향후|체크\\s?포인트|가능성|여력|여지(?!없)|불가피|변수|변곡점|시험대|관건|달렸다|바라보|제한적|앞날|눈높이|목표치|밴드\\s?[상하]단|[상하]단\\s?(?:\\d|시험|테스트)",
    "경고(?!\\s?(?:를\\s?)?(?:받|통지|통보|조치|수령|문구))|주목",
    `(?:듯|간다|온다|뜬다|는가)${B}`,
    `(?:오른|내린|뛴|튄|빠진|떨어진|꺾인|바뀐|살아난|반등한|상승한|하락한|급등한|급락한|넘본|가른)다${B}`,
    "(?:상승|하락|반등|급등|급락|돌파|도달|회복|랠리|배|인하|인상)(?:도|이|은)?\\s?가능(?!성)|(?:상승|하락|반등|추세|랠리|흐름|모멘텀|강세|상승세|하락세)\\s?유효",
    "(?:꺾이는|하락|상승|반등|위험|과열|바닥|천장|고점|저점|반전|전환|강세장|약세장|침체|둔화|경고)\\s?신호|(?:상승|하락|반등|강세|약세|인상|인하)\\s?vs|vs\\.?\\s?(?:상승|하락|반등|강세|약세)",
    "시나리오|에\\s?무게|(?:론|설|전망|관측|기대|가능성)에\\s?힘\\s?(?:실려|실린|싣)|열쇠|분수령|중요한\\s?이유",
    `(?:로|게|해|워|와|아|어|져)\\s?보(?:인다|이는|여${B})`,
    // (7차 검토) 지수 선이 무너질 수 있다는 말: '코스닥 제약지수 8000선 위태' (숫자 뒤 '위협'은 threatensLevel — 그날 움직임을 적은 마디는 둔다)
    "위태",
    // (8차 검토) 곧 닿는다는 말: '6900선 눈앞 [선데이 머니카페]'·'코스피 7100선 코앞…'·'1400원 돌파 초읽기'·'8000 시대 개막 초읽기'·'20만원 시대 머지않아'
    // (그날 움직임을 적은 '7000선 눈앞서 마감'·'1380원 코앞까지 상승'·'7200 눈앞에 뒀는데…'는 둔다),
    // 바닥·저점을 단정하는 말: '코스피 바닥 찍었다'·'지금이 저점'·'저점 통과'·'상단 열렸다' ('52주 신저점 기록'·'2개월 저점에 도달'·'바닥 찍고 반등'은 둔다)
    "초읽기|머지않|(?:눈앞|코앞)(?!\\s?(?:서|에서)\\s?마감|까지\\s?(?:상승|올라|올랐|치솟|급등|하락|떨어|밀려|내려|급락)|에\\s?뒀)",
    "(?:지금|이제|여기|현재|올해|오늘)(?:이|가|은|는)?\\s?(?:바닥|저점)|(?:바닥|저점)(?:을|은|이)?\\s?(?:찍었|쳤|다졌|다지기|확인|통과|지났|왔다|론|논쟁|매수|이다|일\\s?수)|상단(?:이)?\\s?열(?:렸|린|려|리|어)",
    // (7차 검토) 숫자 뒤 '가능'('코스피 8000도 가능'·'삼성전자 15만원 가능'·'연말 7500 가능' — '2배 상승도 가능'만 막히던 빈 곳), 앞날의 값·기간:
    // '연말 8000'·'연내'·'연말까지'·'당분간'·'돌파 무난'·'오를 일만 남았다'·'성장 예고'
    "\\d[\\d,.]*\\s?(?:만\\s?|천\\s?)?(?:원|달러|선|포인트|p|배|%)?(?:도|까지|이|은)?\\s?가능(?!성)",
    "연말\\s?(?:까지|\\d)|연내|내년\\s?\\d|당분간|(?:돌파|달성|도달|회복|상승|반등)\\s?무난|일만\\s?남(?:았|은|아)",
    "(?:성장|상승|반등|강세|호황|랠리|흑자|하락|조정|급락|폭락|약세|줄초상|줄상폐)\\s?예고",
    // (7차 말뭉치 검토) '연휴 직후 국내 증시, … 지표가 방향성 결정'·'낙관은 어려워'·'커지는 상승 걸림돌'·'한국 주식 5차 파동'
    "방향성?\\s?(?:결정|좌우|가를|가늠)|낙관(?:은|하기)?\\s?(?:어려|이르|금물)|(?:상승|반등|랠리|회복)\\s?걸림돌|\\d차\\s?파동",
  ].join("|"),
  "i",
);

/**
 * (7차·8차 검토) 지수·주가 선이 무너질 수 있다는 '위협': '코스피 7000선 위협'·'코스피, 7,000선을 위협'·'삼성전자 10만원선 위협'·'7천 위협'.
 * 그 마디(…·쉼표 등으로 나뉜 한 덩어리)가 그날 움직임을 적으면 둔다: '7000선 위협받다 반등…'·'장 초반 낙폭 키워 7천 위협‥'·'장중 7000선 위협 뒤 반등 마감'.
 * 숫자 뒤가 아니면('AI 위협에 하락') 보지 않는다
 */
const LEVEL_THREAT_RE = /\d[\d,.]*\s?(?:만\s?|천\s?)?(?:원|달러|엔)?(?:선|포인트|p|pt|대|선대|원대)?\s?(?:[을를이가도]|마저|까지)?\s?위협(?!받|했|하다|하던|하며|하고)/g;
const DAY_MOVE_RE = /반등|마감|장중|장\s?초반|장\s?막판|출발|개장|오전|오후\s?장|낙폭|하락\s?전환/;
const CLAUSE_SPLIT_RE = /…|⋯|‥|\.{2,}|[·,;]|\s[-–—|]\s/;
export function threatensLevel(title: string): boolean {
  for (const m of title.matchAll(LEVEL_THREAT_RE)) {
    const before = title.slice(0, m.index!).split(CLAUSE_SPLIT_RE).pop() ?? "";
    const after = title.slice(m.index! + m[0].length).split(CLAUSE_SPLIT_RE)[0] ?? "";
    if (!DAY_MOVE_RE.test(before + m[0] + after)) return true;
  }
  return false;
}

/**
 * 현재·미래 꼴 '~ㄴ다·~는다'(낱말 끝)는 앞일을 말한다 — 장 마감 기사는 '~했다'나 이름씨로 끝난다 (6차 검토: 목록 '오른다·넘본다'를 끝 모양으로 넓힘).
 * '반대매매가 낙폭 더 키운다'·'코스닥 부담 커진다'·'국내 증시 떠받친다'·'증시 긴장 못 푼다'·'내 돈은 안 쉰다'·'수주 쌓인다'·'빅파마 뒤에서 웃는다'·
 * '국내 ETF로도 투자한다'·'담는 ETF 늘어난다'·'실적 날개 단다'·'삼전은 판다'. 회사·정부 계획 기사('인재 키운다'·'공장 짓는다')도 함께 빠진다 — 시장 요약 창에는 거의 없다.
 * 이름('혼다'·'어젠다'·'르완다' 등)은 둔다 ('판다'는 '삼전은 판다'처럼 판다는 말로 더 자주 쓰여 막는다)
 */
const NOT_PLAIN_FUTURE = ["혼다", "어젠다", "아젠다", "린다", "완다", "르완다", "우간다", "아만다", "미란다", "프로파간다", "아나콘다"];
export function forecastsTense(title: string): boolean {
  for (const m of title.matchAll(new RegExp(`([가-힣]+)다${B}`, "g"))) {
    if (finalOf(m[1]!.slice(-1)) !== 4) continue;
    const word = `${m[1]}다`;
    if (NOT_PLAIN_FUTURE.some((n) => word === n || (word.endsWith(n) && n.length > 2))) continue;
    return true;
  }
  return false;
}

/** 한글 음절의 받침 번호 (0 = 받침 없음, 4 = ㄴ, 8 = ㄹ, 17 = ㅂ, 18 = ㅄ, 20 = ㅆ). 한글 음절이 아니면 -1 */
const finalOf = (ch: string) => {
  const c = ch.charCodeAt(0) - 0xac00;
  return c >= 0 && c < 11_172 ? c % 28 : -1;
};
/** 낱말 끝 (뒤에 한글·영문·숫자가 오지 않음) */
const WORD_END = new RegExp(`^${B}`);
/**
 * 마디 끝 (제목 끝, 또는 말줄임(…·⋯·‥·..)·쉼표·느낌표·따옴표·괄호·말머리·세로줄 앞) — 물음 끝 '~나'는 여기서만 본다
 * ('두 배나 뛰어'의 '배나'는 마디 끝이 아니다)
 */
const CLAUSE_END = /^(?:$|\s*(?:…|⋯|‥|\.{2,}|[,!'"”’\])·~|｜[【<(-]))/;
/** 마디 끝이 '~나'여도 물음이 아닌 낱말 (수·지나감, 나라·회사·병 이름) */
const NOT_QUESTION_NA = new Set(["하나", "지나", "안나", "한나"]);
/** 끝이 '~나'인 이름 — 앞에 글자가 붙어도 이름이다 ('[올댓차이나]'·'[서학개미 안테나]'·'대한항공·아시아나') */
const NA_NAMES = ["차이나", "우크라이나", "아시아나", "코로나", "아르헨티나", "캐롤라이나", "바나나", "애리조나", "마리나", "안테나"];
/** 물음 끝 '~ㄴ가'를 만드는 앞 음절 ('바닥인가'·'괜찮은가'·'충분한가'·'어려운가'·'다른가'·'했던가') */
const NGA_BEFORE = new Set(["인", "은", "는", "한", "운", "던", "된", "린", "른"]);
/** '~ㄴ가'로 끝나도 이름씨인 낱말: 허가('예비인가'·'본인가'·'미인가' — 인터넷은행 인가 기사), 가격 제한('상한가'·'하한가') */
const NGA_NOUN_RE = /(?:(?:예비|본|정식|최종|설립|영업|조건부|무|미|재)인가|[상하]한가)$/;
/** 물음 낱말 ('대출·투자 어떻게 하나'·'韓증시 어디로'·'한은 추가 인상 언제'·'메타 뮤즈 뭐길래'). '언제든'·'언제나'는 둔다 */
const QUESTION_WORD_RE = /어떻게|어디로|어디까지|언제(?!든|나)|얼마나|무엇을|뭐길래|뭐기에|무엇이길래/;
/**
 * 물음표 없이 묻는 제목:
 *  - '~ㄹ까'·'~ㄹ지': '상승 이어갈까'·'지금 사도 될까'·'반등할까…'·'반등 성공할지 주목' ('반도체까지'·'매매일지'는 아니다)
 *  - '~까요'·'~나요'·'~냐': '지금 사도 될까요'·'오르나요'·'살 때냐 팔 때냐' ('케냐'는 아니다)
 *  - '~ㄴ가'(앞에 낱말이 붙을 때): '코스피 바닥인가'·'거품인가'·'지금 살 때인가'·'괜찮은가' ('인가 취소'·'예비인가'·'원가'·'단가'는 아니다)
 *  - 낱말 끝 '~나': 과거형(받침 ㅆ·ㅄ) '바닥 찍었나'·'끝났나'·'대안 없나', '되나'·'오나' ('랠리 계속되나'·'반등 오나'·'지금 들어가도 되나'),
 *    '~가나'는 앞에 글자가 붙을 때만 ('이어가나'·'올라가나' — 나라 이름 '가나'는 아니다)
 *  - 마디 끝 '~나'는 모두: '랠리 멈추나'·'코스피 꺾이나'·'반도체 살아나나'·'상승세 이어지나'·'어디까지 오르나'·'코스피 3천 가나'·'1400원대 올라서나 [1분 브리프]'
 *    ('하나'·'지나'와 나라·회사 이름은 아니다. '우리나라'·'가나 대통령'은 마디 끝이 아니다)
 *  - 물음 낱말: '어떻게'·'어디로'·'언제'·'얼마나'
 *  - 본문 끝 '~은·~는'(물음을 줄인 말): '향후 흐름은'·'정부 대책은'·'순매수 1위 종목은'·'전략은' — 본문(coreTitle) 끝에서만 본다
 */
export function asksQuestion(title: string): boolean {
  for (const m of title.matchAll(/([가-힣])[까지](?![가-힣])/g)) if (finalOf(m[1]!) === 8 && m[0] !== "일지") return true;
  if (new RegExp(`[가-힣](?:까|나)요${B}`).test(title)) return true;
  for (const m of title.matchAll(new RegExp(`([가-힣]*)냐${B}`, "g"))) if (m[1] !== "케") return true;
  for (const m of title.matchAll(new RegExp(`([가-힣]+)([가-힣])가${B}`, "g"))) if (NGA_BEFORE.has(m[2]!) && !NGA_NOUN_RE.test(m[0])) return true;
  for (const m of title.matchAll(/([가-힣])나/g)) {
    const i = m.index!;
    if (!WORD_END.test(title.slice(i + 2))) continue;
    const prev = m[1]!;
    const f = finalOf(prev);
    if (f === 20 || f === 18 || prev === "되" || prev === "오") return true;
    if (prev === "가" && i > 0 && finalOf(title[i - 1]!) >= 0) return true;
  }
  // 마디 끝 '~나' (앞에 한글이 붙은 낱말만 — 홀로 쓴 '나'는 아니다)
  for (const m of title.matchAll(/([가-힣]*)나/g)) {
    if (!m[1] || !CLAUSE_END.test(title.slice(m.index! + m[0].length)) || NOT_QUESTION_NA.has(m[0]) || NA_NAMES.some((n) => m[0].endsWith(n))) continue;
    return true;
  }
  return QUESTION_WORD_RE.test(title);
}
/** 본문 끝 '~은·~는'(물음을 줄인 말 — '향후 흐름은'·'정부 대책은'·'순매수 1위 종목은'). 본문(coreTitle)에만 쓴다 */
const TOPIC_END_RE = /[가-힣][은는]$/;

/**
 * 마디 끝 '~ㄹ 때'(때 짚기 — '노려볼 때'·'쉬어갈 때다'·'버틸 때인가'). '30살 때부터'·'떨어질 때 산 개미'처럼 마디 안이면 둔다.
 * 꾸미는 꼴 '~ㄹ 종목·주식'(고르기 — '1년 묵힐 종목'·'오를 주식'·'담을 종목'·'주목할 종목')은 어디서든.
 * 받침 ㄹ 이름씨('개별 종목'·'대출 종목관리'·'9월 주식'·'선물 종목'·'기술 주식')는 둔다 — 꾸미는 꼴로 흔한 끝 음절만 본다
 */
const ADNOMINAL_L = new Set([..."할될볼힐릴울을둘설탈낼를뜰"]);
export function timingCall(title: string): boolean {
  for (const m of title.matchAll(/([가-힣])\s?때(?:다|이다|입니다|인가|냐)?/g)) {
    if (finalOf(m[1]!) !== 8) continue;
    if (CLAUSE_END.test(title.slice(m.index! + m[0].length))) return true;
  }
  for (const m of title.matchAll(/([가-힣])\s(?:종목|주식|株)/g)) if (ADNOMINAL_L.has(m[1]!)) return true;
  return false;
}

/**
 * 예측: '~ㄹ 것'('랠리 계속될 것'·'"코스피 연말 3500 갈 것"'·'4000 시대 열릴 것이란'), '~ㄹ 수 있다·~ㄹ 수도'('한국경제 흔들릴 수 있다'),
 * (7차 검토) 마디 끝 '(하락·조정·수급 공백 …) 우려'(WORRY_END_RE)·'~가 우려된다', '(수주 …) 기대감 고조',
 * '~ㄹ 모멘텀·동력'('외인 투심 돌아올 모멘텀'). '그것'·'이것'은 아니다.
 * (6차 검토 must) '~ㄹ지도 모른다'('AI가 끝낼지도 모른다'), '~겠다'(짐작·다짐), '~가 기대된다', 마디 끝 '(상승·재평가·유입·확대·수급 …) 기대'
 * ('코스피 상승 기대'·'주가 재평가 기대'·'배당 확대 기대'·'5조원 유입 기대' — 까닭으로 쓴 '협상 기대에 상승'·'기대감에'와 시장 분위기를 적은
 * '호르무즈 재개 기대'·'중동대화 기대'는 둔다), 마디 끝 조건 '~면'('감축 논의로 이어지면 국내 증시 상당한 타격'·'이 가격 떨어지면 꺾이는 신호'·
 * '미국이 올렸다면 한국도') — 이름씨 '측면·국면·반면·화면·라면·가면·사면' 등과 출처를 밝히는 '~에 따르면'은 둔다
 */
const HOPE_END_RE =
  /(?:상승|반등|재평가|유입|확대|개선|수혜|효과|강세장?|회복|랠리|호조|성장|증가|수급|급등|돌파|상향|특수|턴어라운드|흑자\s?전환|실적|주가|수주)\s?기대(?:감)?(?:\s?(?:고조|확산|커져|커진|↑))?(?=\s*(?:$|…|⋯|‥|\.{2,}|[·,]))/;
/**
 * (7차 검토 must) 끝이 '~우려'인 앞날 걱정도 '~기대'와 같은 꼴로 막는다 — 오를 거라는 전망만 막고 내릴 거라는 걱정은 두던 빈 곳:
 * '삼전·하닉 34조 자사주 막바지…코스피 수급 공백 우려'·'…10월 수급 공백 우려'·'코스피 추가 하락 우려'·'반도체주 조정 우려'·'추가 상폐 우려도'.
 * 그날 움직임의 까닭으로 쓴 '금리 인상 우려에 하락'·'중동 확전 우려 속'과, 가격이 아닌 걱정('인플레 우려'·'금리인상 우려·국채금리 급등에 하락'·
 * '지분희석 우려…주가 3%↓')은 둔다 — 시장 값·수급이 앞으로 나빠진다는 낱말 뒤만 본다.
 * (8차 검토 must) 하락장에서 가장 흔한 꼴도: '코스피 7000선 붕괴 우려'·'코스닥 800선 붕괴 우려…외인 매도'·'코스피 약세장 진입 우려'·
 * '코스피, 8000 붕괴 위기감'·'7000선 붕괴 공포'·'수급 공백 불안'·'추가 하락 걱정'·'동전주 줄상폐 위기'
 * ('7000선 붕괴 공포에 급락'·'상폐 위기 고조에 4%↓'처럼 뒤에 '~에'가 붙은 그날의 까닭과 '결국 7000선 붕괴…'(사실)는 둔다)
 */
const WORRY_END_RE =
  /(?:하락|조정|급락|폭락|약세장?|하방|반락|되돌림|공백|매물\s?부담|이탈|유출|쇼크|오버행|상폐|상장\s?폐지|붕괴|하회|추락|투매|손실|(?:약세장|하락장|조정장|베어마켓|침체)\s?진입)\s?(?:우려|경계|공포|위기|불안|걱정)(?:감|심리)?(?:도)?(?:\s?(?:고조|확산|커져|커진|엄습|↑))?(?=\s*(?:$|…|⋯|‥|\.{2,}|[·,]))/;
const COND_RE = /([가-힣]+)면(?=\s|,|…|⋯|\.{2,}|$)/g;
/**
 * 끝이 '~면'이지만 조건이 아닌 낱말: 이름씨(받침 없는 앞 음절 + 면 — 낱말 전체가 같을 때만. '이어지면'·'올라가면'·'넘어서면'은 조건이다),
 * 출처를 밝히는 말('블룸버그에 따르면').
 * (7차 검토) '사면'은 목록에서 뺐다 — '지금 반도체 사면 수익'·'이 종목 사면 대박'처럼 '사면'(사다 + 면)이 더 흔하다.
 * 이름씨 '사면'(특별사면·사면 복권)은 뒤에 오는 말로 알아본다 (NOUN_SAMYEON_AFTER)
 */
const NOT_COND_WORDS = new Set(["이면", "지면", "라면", "컵라면", "대면", "비대면", "서면", "수면", "해수면", "화면", "체면", "가면", "특별사면", "내면", "외면", "표면", "우면", "냉면", "쫄면", "따르면", "의하면"]);
const NOUN_SAMYEON_AFTER = /^\s?(?:복권|대상|심사|단행|명단|논란|조치|절차|검토|결정|위원회|권|·|,)/;
export function predicts(title: string): boolean {
  for (const m of title.matchAll(/([가-힣])\s?(?:것|수\s?(?:있|도|밖에)|모멘텀|동력)/g)) if (finalOf(m[1]!) === 8) return true;
  if (/지도\s?(?:모른|몰라|모를)|겠(?:다|네|지|어|습|고)/.test(title)) return true;
  if (/(?:기대|우려)(?:된다|돼|되는|된다며)/.test(title)) return true;
  const core = coreTitle(title);
  if (HOPE_END_RE.test(title) || HOPE_END_RE.test(core) || WORRY_END_RE.test(title) || WORRY_END_RE.test(core)) return true;
  for (const m of title.matchAll(COND_RE)) {
    const word = `${m[1]}면`;
    const prev = m[1]!.slice(-1);
    const f = finalOf(prev);
    // 받침 없는 앞 음절('오르면'·'이어지면'·'되면'·'하면'), 받침 ㄹ('팔면'·'늘면'), '~으면'·'~다면'·'~라면'
    if (!(f === 0 || f === 8 || prev === "으") || NOT_COND_WORDS.has(word)) continue;
    if (word === "사면" && NOUN_SAMYEON_AFTER.test(title.slice(m.index! + m[0].length))) continue;
    return true;
  }
  return false;
}

/**
 * (7차 검토) 먼 앞날의 산업·회사 규모를 단정하는 제목 — 주가 예측은 아니지만 '전망 없이' 규칙에 맞게 뺀다:
 * '2035년 반도체 레이저 시장: … 성장 견인'·'… 시장, 2035년까지 … 성장 가속'·'글로벌 반도체 칩 생태계, 2035년 2539조 원 규모로 확장'.
 * 기사가 나온 해(year)보다 뒤의 해가 제목에 있고 규모·성장 낱말이 함께 있을 때만 (지난해·올해 실적은 둔다). year 를 모르면 보지 않는다
 */
const YEAR_RE = /(?<!\d)(20\d{2})년/g;
const GROWTH_RE = /시장|규모|성장|확장|확대|증가|달할|도달|돌파|매출|이익|목표|전망/;
export function futureYearOutlook(title: string, year: number | undefined): boolean {
  if (!year) return false;
  for (const m of title.matchAll(YEAR_RE)) if (Number(m[1]) > year && GROWTH_RE.test(title)) return true;
  return false;
}

/**
 * 제목 본문: 끝에 붙은 언론사·출처·말머리를 뗀다 (' - 머니투데이'·' | 네이버 블로그'·' : 금융'·' By 알파경제 alphabiz'·' [1분 브리프]'·'(종합)').
 * 마디 끝 모양('~나'·'~은') 검사가 꼬리표에 가려지지 않게 한다. 다 떼면 원래 제목
 */
export function coreTitle(title: string): string {
  let t = title.trim();
  for (let i = 0; i < 5; i++) {
    const before = t;
    t = t
      .replace(/\s+By\s+.+$/, "")
      .replace(/\s*[|｜]\s*[^|｜]*$/, "")
      .replace(/\s+:\s+[^:]*$/, "")
      .replace(/\s+-\s+[^-]+$/, "")
      .replace(/\s*(?:\[[^\]]*\]|\([^)]*\)|<[^>]*>|【[^】]*】)\s*$/, "")
      .trim();
    if (t === before) break;
  }
  return t || title.trim();
}
/** 통신사 기사를 먼저 */
const WIRE_OUTLETS = new Set(["연합뉴스", "연합인포맥스", "뉴스1", "뉴시스"]);
const FLASH_RE = /\[(속보|1보|2보)\]|-\s?[12]보\]|\((속보|1보)\)/;

/**
 * 레버리지·인버스 ETF (지수와 차이가 구조적으로 커 비교에서 빼고 개수만 적는다). 알아보지 못한 것은 포함된다고 상세에 밝힌다.
 * 'Ultra'(2배)는 ProShares 상품 이름에 붙을 때만 본다 — 'Ultra Clean Holdings'·'Ultragenyx'·'울트라 클린 홀딩스' 같은 회사 이름을 레버리지로 빼지 않게.
 * 'UltraPro'(3배)는 그 낱말만으로. 'Ultra' 뒤에 Short 가 오면 뺀다 — 'Ultra-Short Income'·'Ultra Short-Term Bond' 는 초단기 채권 ETF 이지 레버리지가 아니다 (채권형으로 따로 센다)
 */
export const LEVERAGE_RE = /(\b[23]x\b|\bultrapro\b|울트라\s?프로|(?:proshares|프로셰어즈)\s*(?:ultra|울트라)(?![\s-]*short|\s?숏)|\bbull\b|\bbear\b|인버스|레버리지|곱버스)/i;
/** ProShares 'UltraShort'(−2배 인버스, 한 낱말)·'울트라숏'. 채권 낱말이 같이 있어도 인버스다 ('UltraShort 20+ Year Treasury' = TBT) */
const ULTRASHORT_RE = /(ultrashort|울트라\s?숏)/i;
/** −1배 인버스 'ProShares Short QQQ·Short S&P500'·'숏' (아래 채권 낱말이 같이 있으면 만기가 짧은 채권 ETF 라 인버스가 아니다) */
const SHORT_RE = /(\bshort\b|(?<![가-힣])숏(?![가-힣]))/i;
/** 'Short' 가 짧은 만기를 뜻하는 채권 ETF 낱말: 'Ultra-Short Income'·'Ultra Short-Term Bond'·'Short Treasury Bond'·'Short Duration' */
const SHORT_BOND_RE = /(income|bond|\bterm\b|duration|maturity|muni|t-bill|floating)/i;
/**
 * 레버리지·인버스 ETF 인지 (이름으로). 'UltraShort'·'Short QQQ' 는 인버스, 'Ultra-Short Income'·'Short-Term Bond' 는 채권 ETF (BOND_ETF_RE 로 따로 센다).
 * 인버스를 먼저 봐야 −2배 인버스가 '채권·금리형'으로, −1배 인버스가 S&P500 비교로 잘못 들어가지 않는다
 */
export function isLeverageName(names: string): boolean {
  if (LEVERAGE_RE.test(names) || ULTRASHORT_RE.test(names)) return true;
  return SHORT_RE.test(names) && !SHORT_BOND_RE.test(names);
}
/**
 * 채권·금리형 ETF (CD금리·KOFR·국고채·미국 국채·초단기 채권 등). 주식 지수와 견주면 높음·낮음이 구조적으로 틀려(해외 지수 ETF 와 같은 까닭) 빼고 개수만 적는다.
 * 이름으로만 알아보므로 알아보지 못한 것은 포함된다. 인버스(isLeverageName)를 먼저 본 뒤에 쓴다
 */
export const BOND_ETF_RE = /(채권|국고채|국채|통안채|회사채|전단채|단기채|CD금리|KOFR|SOFR|머니마켓|MMF|금리액티브|treasury|\bbonds?\b|t-bill|ultra[\s-]*short)/i;
/**
 * 한국 ETF 상표 (종목 마스터 분류가 없을 때 이름으로). 한글 상표 뒤에는 \b 가 성립하지 않아(한글은 낱말 글자가 아님) 공백·괄호·끝으로 본다 —
 * '파워로직스' 같은 종목 이름은 상표가 아니다
 */
const KR_ETF_BRAND_RE = /^(?:(?:KODEX|TIGER|ACE|KBSTAR|RISE|SOL|HANARO|ARIRANG|KOSEF|PLUS|TIMEFOLIO|KIWOOM|WON|1Q|BNK|FOCUS|TRUSTON|UNICORN|VITA|ITF|TREX|KCGI|DAISHIN343)\b|(?:마이다스|에셋플러스|파워|마이티|히어로즈)(?=$|[\s(]))/i;
/**
 * 한국 상장 해외 지수·원자재·통화 ETF (코스피와 비교하면 높음·낮음이 구조적으로 틀린다). 금현물·원자재처럼 국내에서 거래해도 주식 지수를 따르지 않는 것도 여기로.
 * 'MSCI Korea'(한국 주식 지수 — 'KODEX MSCI Korea TR')는 해외가 아니라 그대로 코스피와 비교한다
 */
const KR_OVERSEAS_RE =
  /(미국|나스닥|S&P|필라델피아|다우존스|차이나|중국|항셍|홍콩|일본|니케이|닛케이|인도|베트남|유로|독일|글로벌|선진국|신흥국|MSCI(?!\s?(?:korea|코리아|한국))|대만|브라질|원유|WTI|골드|금선물|금현물|KRX\s?금|은선물|은현물|구리|원자재|농산물|천연가스|팔라듐|백금|귀금속|비철금속|탄소배출권|달러|엔화|해외|월드|아시아|멕시코|캐나다|호주|영국|사우디|인도네시아)/i;
/** 한국 상장 코스닥 추종 ETF ('KODEX 코스닥150') — 상장은 코스피 시장이지만 코스닥과 비교한다 */
const KR_KOSDAQ_ETF_RE = /코스닥/;
/** 미국 상장 거래소 → 비교 지수 (나스닥 상장 → 나스닥 종합, 뉴욕·아멕스 상장 → S&P500). 그 밖(모르는 거래소)은 비교에서 뺀다 */
const US_BENCHMARK: Record<string, "NASDAQ" | "SPX"> = { NSQ: "NASDAQ", NYS: "SPX", AMX: "SPX" };
/** 네이버 시세의 거래소 이름 → 코드 */
export const US_EXCHANGE_CODE: Record<string, string> = { NASDAQ: "NSQ", NYSE: "NYS", AMEX: "AMX", NSQ: "NSQ", NYS: "NYS", AMX: "AMX" };

// ── 날짜 ─────────────────────────────────────────────────────

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n: number) => String(n).padStart(2, "0");
export const kstDateOf = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
const kstHmOf = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
/** 서울 시각의 하루 중 분 (0~1439) */
const kstMinutesOf = (t: number) => {
  const d = new Date(t + 9 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const isWeekday = (date: string) => weekday(date) >= 1 && weekday(date) <= 5;
/** "9/25" */
export const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
/** "9/25(금)" */
export const mdw = (date: string) => `${md(date)}(${WD[weekday(date)]})`;
/** "금요일" */
const dayName = (date: string) => `${WD[weekday(date)]}요일`;
const hm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** 직전 미국 거래일 (주말·US_HOLIDAYS 건너뜀) */
export function prevUsTradingDate(date: string): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 30 && !isUsTradingDate(d); i++) d = addDays(d, -1);
  return d;
}

export function marketOf(session: SummarySession): SummaryMarket {
  return session === "morning" ? "US" : "KR";
}

/**
 * 세션 날짜·휴장 판단 (세 겹: 네이버 장 상태 → 토스 달력 → 정적 목록). 출처끼리 다르면 휴장 쪽으로 보고 conflicts 에 남긴다(로그 경고).
 *  - 아침(미국): 세션 날짜의 전날 장, 월요일은 금요일 (briefingMarketDate). 그날이 평일 휴장이면 직전 거래일 값
 *  - 오후(한국): 세션 날짜 그대로. 휴장이면 네이버 latest.tradeBaseAt(직전 거래일), 없으면 목록으로 계산
 *  - 주말은 휴장 줄을 만들지 않고 날짜만 직전 거래일로 옮긴다 (토요일 아침은 금요일 장, 일요일 아침도 금요일 값)
 */
export function resolveDates(input: {
  session: SummarySession;
  date: string;
  /** 네이버 한국 장 상태 (오늘 날짜가 맞을 때만 쓴다) */
  kr?: { todayDate: string | null; isTradingDay: boolean | null; isWeekdayHoliday: boolean | null; holidayDescription: string | null; latestTradeBaseAt: string | null } | null;
  /** 토스 달력의 그 날짜 거래일 여부 (모르면 null) */
  calendarTrading?: boolean | null;
}): { market: SummaryMarket; marketDate: string; basisDate: string; holiday: { date: string; name: string | null } | null; weekendGap: boolean; conflicts: string[] } {
  const market = marketOf(input.session);
  const conflicts: string[] = [];
  if (market === "US") {
    const marketDate = briefingMarketDate("US", "morning", input.date);
    const listOpen = isUsTradingDate(marketDate);
    const calClosed = input.calendarTrading === false;
    if (isWeekday(marketDate) && listOpen && calClosed) conflicts.push(`미국 ${marketDate}: 토스 달력은 휴장, 휴장일 목록은 거래일 → 휴장으로 봄`);
    const holidayDay = isWeekday(marketDate) && (!listOpen || calClosed);
    const basisDate = listOpen && !calClosed ? marketDate : prevUsTradingDate(marketDate);
    const weekendGap = !holidayDay && weekday(input.date) === 1 && addDays(basisDate, 3) === input.date;
    return { market, marketDate, basisDate, holiday: holidayDay ? { date: marketDate, name: US_HOLIDAY_NAMES[marketDate] ?? null } : null, weekendGap, conflicts };
  }
  const marketDate = input.date;
  const naver = input.kr && input.kr.todayDate === marketDate ? input.kr : null;
  const listHoliday = marketDate in KR_HOLIDAYS;
  const naverHoliday = naver ? naver.isTradingDay === false : null;
  const calHoliday = input.calendarTrading === false;
  if (isWeekday(marketDate)) {
    if (naverHoliday === false && listHoliday) conflicts.push(`한국 ${marketDate}: 네이버는 거래일, 휴장일 목록은 휴장 → 휴장으로 봄`);
    if (naverHoliday === true && !listHoliday) conflicts.push(`한국 ${marketDate}: 네이버는 휴장, 휴장일 목록에 없음 → 휴장으로 봄 (목록 확인 필요)`);
    if (calHoliday && !listHoliday && naverHoliday !== true) conflicts.push(`한국 ${marketDate}: 토스 달력은 휴장, 목록·네이버는 거래일 → 휴장으로 봄`);
  }
  const closed = !isWeekday(marketDate) || listHoliday || naverHoliday === true || calHoliday;
  if (!closed) return { market, marketDate, basisDate: marketDate, holiday: null, weekendGap: false, conflicts };
  const tb = naver?.latestTradeBaseAt;
  const basisDate = tb && /^\d{4}-\d{2}-\d{2}$/.test(tb) && tb < marketDate ? tb : prevKrTradingDate(marketDate);
  const holiday = isWeekday(marketDate) ? { date: marketDate, name: naver?.holidayDescription ?? KR_HOLIDAYS[marketDate] ?? null } : null;
  return { market, marketDate, basisDate, holiday, weekendGap: false, conflicts };
}

/** 정규장 마감: 순간·표시 시각 (한국은 서울, 미국은 뉴욕) */
export function sessionClose(market: SummaryMarket, basisDate: string): { at: number; time: string; early: boolean } {
  if (market === "KR") {
    const h = krRegularHours(basisDate);
    return { at: kstWall(basisDate, Math.floor(h.close / 60), h.close % 60), time: hm(h.close), early: false };
  }
  const early = US_EARLY_CLOSES.has(basisDate);
  const m = early ? 13 * 60 : 16 * 60;
  return { at: nyWall(basisDate, Math.floor(m / 60), m % 60), time: hm(m), early };
}

/** 값이 확정되는 순간: 한국은 정규장 마감, 미국은 네이버 최종값 시각(뉴욕 17:15) */
export function finalAt(market: SummaryMarket, basisDate: string): number {
  return market === "KR" ? sessionClose("KR", basisDate).at : nyWall(basisDate, Math.floor(US_FINAL_MIN / 60), US_FINAL_MIN % 60);
}

/** 실행 시각이 마감 전이면 장중, 미국은 마감 뒤 최종값 시각(17:15 ET) 전이면 잠정 */
export function phaseOf(market: SummaryMarket, basisDate: string, now: Date): MarketSummaryData["phase"] {
  const close = sessionClose(market, basisDate);
  if (now.getTime() < close.at) return "intraday";
  if (now.getTime() < finalAt(market, basisDate)) return "prelim";
  return "final";
}

/** 다음 미국 거래일 (주말·US_HOLIDAYS 건너뜀) */
export function nextUsTradingDate(date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 30 && !isUsTradingDate(d); i++) d = addDays(d, 1);
  return d;
}

/**
 * 기준 거래일 다음 정규장이 열리는 순간 (미국 09:30 ET, 한국 그날 개장 시각 — 수능일·새해 첫날 10:00).
 * 이 뒤에는 지수 띠가 새 거래일 값이라 그 세션 요약을 다시 만들면 지수가 모두 빠진다 (강제 재실행이 좋은 요약을 덮지 않게)
 */
export function nextSessionOpenAt(market: SummaryMarket, basisDate: string): number {
  if (market === "US") return nyWall(nextUsTradingDate(basisDate), 9, 30);
  const next = nextKrTradingDate(basisDate);
  const h = krRegularHours(next);
  return kstWall(next, Math.floor(h.open / 60), h.open % 60);
}

/** 뉴스 창 (ISO) */
export function newsWindow(market: SummaryMarket, basisDate: string, now: Date): { from: string; to: string } {
  const close = sessionClose(market, basisDate).at;
  const to = Math.min(now.getTime(), close + NEWS_AFTER_CLOSE_MS);
  return { from: new Date(close - NEWS_BEFORE_CLOSE_MS).toISOString(), to: new Date(Math.max(to, close - NEWS_BEFORE_CLOSE_MS)).toISOString() };
}

// ── 지수·환율·금리 ─────────────────────────────────────────

/**
 * 지수 목록에서 요약에 쓸 지수 (날짜가 기준 거래일이 아니면 받지 못한 것으로).
 * closeAt(그 거래일 정규장 마감 순간)을 주면: 출처 조회가 실패해 이어 준 마지막 값(stale)은 마감 뒤 시세일 때만 쓴다 —
 * 16:00 에 코스피 조회가 한 번 실패해 15:25 장중 값이 남아 있으면, 그 값이 '15:30 장 마감 기준'으로 카드·알림·보유 종목 비교에 쓰이지 않게 뺀다
 */
export function pickIndices(
  list: ReadonlyArray<{ code: string; name: string; value: number; change: number; changeRate: number; asOf: string | null; stale?: boolean }>,
  market: SummaryMarket,
  basisDate: string,
  closeAt?: number,
): SummaryIndex[] {
  const codes = market === "US" ? US_INDEX_CODES : KR_INDEX_CODES;
  return codes.map((code) => {
    const name = INDEX_NAMES[code]!;
    const i = list.find((x) => x.code === code);
    if (!i) return { code, name, value: null, change: null, changeRate: null, date: null, asOf: null, missing: "받지 못함" };
    const date = i.asOf && /^\d{4}-\d{2}-\d{2}/.test(i.asOf) ? i.asOf.slice(0, 10) : null;
    if (date !== basisDate) return { code, name, value: null, change: null, changeRate: null, date, asOf: i.asOf, missing: date ? `기준 거래일(${md(basisDate)})이 아닌 ${md(date)} 값이라 뺌` : "시세 날짜를 확인하지 못함" };
    if (i.stale === true && closeAt !== undefined) {
      const t = i.asOf ? Date.parse(i.asOf) : NaN;
      if (!(t >= closeAt)) {
        const hhmm = /T(\d{2}:\d{2})/.exec(i.asOf ?? "")?.[1];
        return { code, name, value: null, change: null, changeRate: null, date, asOf: i.asOf, missing: `출처 조회가 실패해 남은 마지막 값이 마감 전${hhmm ? `(${hhmm})` : ""} 값이라 뺌` };
      }
    }
    return { code, name, value: i.value, change: i.change, changeRate: i.changeRate, date, asOf: i.asOf };
  });
}

/** 한국 영업일 이 시각(서울, 분) 뒤에는 원/달러 띠 값이 그날 고시값이다 — 하나은행 첫 고시는 09시 무렵이라 넉넉히 10:00 */
export const FX_TODAY_FROM_MIN = 10 * 60;
/** 하나은행 그날 첫 고시가 나올 수 있는 시각(서울, 분) — 이 전의 띠 값은 직전 영업일 마지막 고시다 */
export const FX_FIRST_POSTING_MIN = 9 * 60;

/**
 * 원/달러: 지수 띠와 같은 값(하나은행 고시 매매기준율)과, 일별 시리즈 마지막 날짜 = 그 고시의 날짜.
 * 띠의 시세 시각(localTradedAt)은 고시 시각이 아니라 받은 무렵의 시각일 때가 있어(토요일 05:45 등 — 녹화 값) 날짜로 쓰지 않는다.
 *  - 오후(한국) 요약: 일별 시리즈에 '오늘' 점이 하루가 끝나야 들어오는 경우(아직 실측 전)에도 '(전날 고시)'가 틀리게 붙지 않게,
 *    오늘이 한국 영업일(krOpenToday)이고 10:00 뒤에 새로 받은 띠 값이면 그 값의 날짜를 오늘로 본다.
 *    출처 조회가 실패해 이어 준 값(stale — 받은 지 3시간까지)은 오늘 고시인지 전날 고시인지 알 수 없어 '고시일 확인 못 함'으로 둔다
 *  - 아침(미국) 요약: 직전 한국 영업일 고시(상세 화면 안내와 같다) — 일별 시리즈의 오늘 앞 마지막 종가와 그 앞 종가로 값·전일 대비를 채운다.
 *    띠 값은 하나은행 첫 고시(09시 무렵) 뒤면 오늘 값이라, 아침 브리핑을 09:30 으로 옮겨도 오늘 값에 전날 날짜가 붙지 않게 시각과 상관없이 이 규칙.
 *    종가를 모르면 첫 고시 전(09:00 전)에만 띠 값에 일별 시리즈 날짜를 붙이고, 그 뒤면 '고시일 확인 못 함'
 */
export function pickFx(
  row: { value: number; change: number; changeRate: number; stale?: boolean } | null | undefined,
  daily: ReadonlyArray<{ date: string; close?: number | null }> | null,
  today: string,
  opts: { now?: Date; krOpenToday?: boolean; session?: SummarySession } = {},
): SummaryFx | null {
  if (!row || !Number.isFinite(row.value)) return null;
  const past = daily?.filter((c) => c.date <= today) ?? [];
  const now = opts.now?.getTime();
  const stale = row.stale === true;
  if (opts.session === "morning") {
    const closes = past.filter((c) => c.date < today && typeof c.close === "number" && Number.isFinite(c.close) && c.close > 0);
    const cur = closes.at(-1);
    const before = closes.at(-2);
    if (cur && before) {
      const change = (Math.round(cur.close! * 100) - Math.round(before.close! * 100)) / 100;
      return { value: cur.close!, change, changeRate: Math.round((change / before.close!) * 10_000) / 100, date: cur.date, stale: false };
    }
    // 종가를 모를 때: 오늘 첫 고시가 나올 수 있기 전이면 띠 값 = 직전 영업일 마지막 고시
    const beforeFirst = now !== undefined && (kstDateOf(now) < today || (kstDateOf(now) === today && (opts.krOpenToday === false || kstMinutesOf(now) < FX_FIRST_POSTING_MIN)));
    const prev = past.filter((c) => c.date < today).at(-1)?.date ?? null;
    return { value: row.value, change: row.change, changeRate: row.changeRate, date: beforeFirst && !stale ? prev : null, stale };
  }
  if (stale) return { value: row.value, change: row.change, changeRate: row.changeRate, date: null, stale };
  let last = past.at(-1)?.date ?? null;
  const liveToday = opts.krOpenToday === true && now !== undefined && kstDateOf(now) === today && kstMinutesOf(now) >= FX_TODAY_FROM_MIN;
  if (liveToday && (last === null || last < today)) last = today;
  return { value: row.value, change: row.change, changeRate: row.changeRate, date: last, stale };
}

/** 미 재무부 Daily Treasury Par Yield Curve CSV → 날짜별 10년물 (최신 순) */
export function parseTreasuryCsv(csv: string): Array<{ date: string; value: number }> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0]!.split(",").map((h) => h.replace(/"/g, "").trim());
  const col = head.indexOf("10 Yr");
  const dateCol = head.indexOf("Date");
  if (col < 0 || dateCol < 0) return [];
  const out: Array<{ date: string; value: number }> = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((cells[dateCol] ?? "").replace(/"/g, "").trim());
    const v = Number((cells[col] ?? "").replace(/"/g, "").trim());
    if (!m || !(cells[col] ?? "").trim() || !Number.isFinite(v)) continue;
    out.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value: v });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 재무부 10년물: 기준 거래일 행과 그 앞 행(1월 초는 전년 파일). 전일 대비는 두 값을 빼서 계산 */
export function treasuryYield(rows: ReadonlyArray<{ date: string; value: number }>, basisDate: string, prevYear: ReadonlyArray<{ date: string; value: number }> = []): SummaryYield | null {
  const all = [...rows, ...prevYear].sort((a, b) => (a.date < b.date ? 1 : -1));
  const i = all.findIndex((r) => r.date === basisDate);
  if (i < 0) return null;
  const cur = all[i]!;
  const prev = all.slice(i + 1).find((r) => r.date < basisDate) ?? null;
  const change = prev ? (Math.round(cur.value * 100) - Math.round(prev.value * 100)) / 100 : null;
  return { value: cur.value, change, date: cur.date, prevValue: prev?.value ?? null, prevDate: prev?.date ?? null, source: "treasury", dp: { value: 2, change: 2 } };
}

/** 재무부 값이 없을 때만: 네이버 US10YT=RR (로이터 시장 수익률 — 재무부와 산출 방식이 달라 출처를 적는다). 날짜가 기준 거래일이 아니면 쓰지 않는다 */
export function naverYield(raw: unknown, basisDate: string): SummaryYield | null {
  const j = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/,/g, "")) : NaN);
  const value = num(j["closePrice"]);
  const change = num(j["fluctuations"]);
  const at = typeof j["localTradedAt"] === "string" ? j["localTradedAt"] : "";
  if (!Number.isFinite(value) || at.slice(0, 10) !== basisDate) return null;
  return { value, change: Number.isFinite(change) ? change : null, date: basisDate, prevValue: null, prevDate: null, source: "naver", dp: { value: 3, change: 4 } };
}

// ── 업종 ────────────────────────────────────────────────────

/** 미국 업종: SPDR 섹터 ETF 11개 정규장 종가. 11개가 다 오지 않았거나 날짜가 기준 거래일이 아니면 null (까닭) */
export function usSectors(quotes: ReadonlyMap<string, { changeRate: number; tradedAt: string | null }>, basisDate: string): SummarySectors | { reason: string } {
  const rows: SectorRow[] = [];
  const missing: string[] = [];
  for (const e of US_SECTOR_ETFS) {
    const q = quotes.get(e.reuters);
    if (!q || !Number.isFinite(q.changeRate)) missing.push(e.code);
    else if ((q.tradedAt ?? "").slice(0, 10) !== basisDate) missing.push(`${e.code}(날짜 다름)`);
    else rows.push({ name: e.name, code: e.code, changeRate: q.changeRate });
  }
  if (missing.length) return { reason: `섹터 ETF 11개 중 ${rows.length}개만 받아 업종 줄을 뺌 (${missing.join(", ")})` };
  const all = [...rows].sort((a, b) => b.changeRate - a.changeRate || a.name.localeCompare(b.name, "ko"));
  return { basis: "etf", date: basisDate, strong: all.slice(0, 2), weak: [...all].reverse().slice(0, 2), all, excluded: [], total: rows.length };
}

/** 한국 업종: 네이버 업종(상장 첫날 보정한 값)에서 구성 5종목 미만·등락 ±30% 초과를 빼고 위아래 2개 */
export function krSectors(themes: ReadonlyArray<{ id: string; name: string; changeRate: number; up: number; flat: number; down: number }>, basisDate: string): SummarySectors | { reason: string } {
  if (!themes.length) return { reason: "한국 업종을 받지 못함" };
  const excluded: SummarySectors["excluded"] = [];
  const kept: SectorRow[] = [];
  for (const t of themes) {
    const count = t.up + t.flat + t.down;
    if (count < KR_SECTOR_MIN_COUNT) excluded.push({ name: t.name, changeRate: t.changeRate, reason: `구성 ${count}종목` });
    else if (Math.abs(t.changeRate) > KR_SECTOR_MAX_ABS) excluded.push({ name: t.name, changeRate: t.changeRate, reason: `등락 ${formatRate(t.changeRate)}` });
    else kept.push({ name: t.name, code: t.id, changeRate: t.changeRate, count });
  }
  if (kept.length < 4) return { reason: "비교할 업종이 너무 적어 업종 줄을 뺌" };
  const all = kept.sort((a, b) => b.changeRate - a.changeRate || a.name.localeCompare(b.name, "ko"));
  return { basis: "naver", date: basisDate, strong: all.slice(0, 2), weak: [...all].reverse().slice(0, 2), all, excluded, total: themes.length };
}

// ── 내 보유 종목 vs 지수 ────────────────────────────────────

/** 종목 등락률 − 지수 등락률 (정수 1/100 %p). 출처가 준 소수 둘째 자리 값을 그대로 빼므로 부동소수 오차 없이 */
export const diffBp = (stock: number, index: number) => Math.round(stock * 100) - Math.round(index * 100);

/** 높음(≥ +1.00%p) · 낮음(≤ −1.00%p) · 비슷 (경계는 높음·낮음에 넣는다) */
export function classify(bp: number): CompareGroup {
  return bp >= SIMILAR_BAND_BP ? "high" : bp <= -SIMILAR_BAND_BP ? "low" : "similar";
}

export interface HoldingInput {
  code: string;
  name: string;
  /** registered_stocks.market (KOSPI · KOSDAQ · NASDAQ · NYSE · AMEX · US …) */
  market: string;
  /** 종목 마스터 분류 (EF = ETF, EN = ETN) */
  groupCode?: string | null;
}

export interface QuoteInput {
  changeRate: number;
  /** 시세 시각 (현지 — 날짜 부분이 거래일) */
  tradedAt: string | null;
  name?: string;
  /** 한국: KS·KQ, 미국: NSQ·NYS·AMX */
  exchange?: string;
}

/** 종목의 비교 지수 (없으면 뺀 까닭) */
export function benchmarkOf(market: SummaryMarket, h: HoldingInput, q: QuoteInput | null): { code: string } | { exclude: "leverage" | "overseas" | "bond" | "noBenchmark" } {
  const names = `${h.name} ${q?.name ?? ""}`;
  if (isLeverageName(names)) return { exclude: "leverage" };
  if (market === "KR") {
    const etf = h.groupCode === "EF" || h.groupCode === "EN" || KR_ETF_BRAND_RE.test(h.name);
    if (etf && BOND_ETF_RE.test(h.name)) return { exclude: "bond" };
    if (etf && KR_OVERSEAS_RE.test(h.name)) return { exclude: "overseas" };
    if (etf && KR_KOSDAQ_ETF_RE.test(h.name)) return { code: "KOSDAQ" };
    const m = h.market === "KOSPI" || h.market === "KOSDAQ" ? h.market : q?.exchange === "KS" ? "KOSPI" : q?.exchange === "KQ" ? "KOSDAQ" : null;
    return m ? { code: m } : { exclude: "noBenchmark" };
  }
  if (BOND_ETF_RE.test(names)) return { exclude: "bond" };
  const ex = q?.exchange ? US_EXCHANGE_CODE[q.exchange] : undefined;
  const code = ex ? US_BENCHMARK[ex] : undefined;
  return code ? { code } : { exclude: "noBenchmark" };
}

/**
 * 보유 종목(수량 > 0)을 같은 세션 지수와 비교한다. 종목·지수 모두 정규장 종가(애프터·NXT 제외).
 *  - 시세가 없거나 시세 날짜가 기준 거래일과 다르면(거래정지·지연·모르는 코드·시세 조회 실패) 빼고 '시세 없음'으로 센다
 *    (미국 비교 지수는 시세의 거래소로 정하므로, 시세가 없는 종목을 '비교 지수 없음'으로 세지 않게 시세부터 본다)
 *  - 레버리지·인버스, 채권·금리형 ETF, 한국 상장 해외 지수·원자재 ETF(코스닥 추종 ETF 는 코스닥과 비교), 비교 지수를 정하지 못한 종목은 빼고 개수만
 *  - 정렬(확정 목업): 묶음마다 차이를 부호 그대로 큰 순 — 높음은 가장 높은 것부터, 비슷은 +에서 −로(+0.82 … −0.84), 낮음은 0에 가까운 것부터(−2.00 … −3.81).
 *    같으면 이름 순. 한 줄 문구 괄호에는 묶음에서 차이가 가장 큰 종목을 따로 고른다(widestOf). 보유가 0 이면 null
 */
export function compareHoldings(input: {
  market: SummaryMarket;
  basisDate: string;
  holdings: readonly HoldingInput[];
  quotes: ReadonlyMap<string, QuoteInput>;
  indices: readonly SummaryIndex[];
}): HoldingsCompare | null {
  if (!input.holdings.length) return null;
  const excluded: HoldingsCompare["excluded"] = { leverage: [], overseas: [], bond: [], noQuote: [], noBenchmark: [] };
  const rows: CompareRow[] = [];
  const used = new Map<string, { code: string; name: string; changeRate: number }>();
  for (const h of input.holdings) {
    const q = input.quotes.get(h.code) ?? null;
    const quoteOk = !!q && Number.isFinite(q.changeRate) && (q.tradedAt ?? "").slice(0, 10) === input.basisDate;
    const b = benchmarkOf(input.market, h, q);
    // 이름으로 아는 제외(레버리지·채권·해외 지수·원자재 ETF)가 먼저, 그다음 시세, 마지막이 비교 지수
    if ("exclude" in b && b.exclude !== "noBenchmark") {
      excluded[b.exclude].push(h.name);
      continue;
    }
    if (!quoteOk || !q) {
      excluded.noQuote.push(h.name);
      continue;
    }
    if ("exclude" in b) {
      excluded.noBenchmark.push(h.name);
      continue;
    }
    const idx = input.indices.find((i) => i.code === b.code);
    if (!idx || idx.changeRate === null) {
      excluded.noBenchmark.push(h.name);
      continue;
    }
    const bench = { code: idx.code, name: idx.name, changeRate: idx.changeRate };
    used.set(idx.code, bench);
    const bp = diffBp(q.changeRate, idx.changeRate);
    rows.push({ code: h.code, name: h.name, changeRate: q.changeRate, benchmark: bench, diff: bp / 100, group: classify(bp) });
  }
  const order = (a: CompareRow, b: CompareRow) => Math.round(b.diff * 100) - Math.round(a.diff * 100) || a.name.localeCompare(b.name, "ko");
  const codes = input.market === "US" ? US_INDEX_CODES : KR_INDEX_CODES;
  return {
    market: input.market,
    compared: rows.length,
    up: rows.filter((r) => r.changeRate > 0).length,
    down: rows.filter((r) => r.changeRate < 0).length,
    flat: rows.filter((r) => r.changeRate === 0).length,
    high: rows.filter((r) => r.group === "high").sort(order),
    similar: rows.filter((r) => r.group === "similar").sort(order),
    low: rows.filter((r) => r.group === "low").sort(order),
    excluded,
    benchmarks: codes.flatMap((c) => (used.has(c) ? [used.get(c)!] : [])),
  };
}

// ── 뉴스 ────────────────────────────────────────────────────

/** 같은 기사로 볼 제목 (말머리·괄호·기호를 뺀 앞부분) */
export function normTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "")
    .slice(0, 24);
}

/** 제목에 박힌 날짜(일): '[뉴욕증시 23일]'·'23일(현지시간)'·'9월 23일'·'상위종목(11일)' */
export function titleDays(title: string): number[] {
  const out: number[] = [];
  for (const b of title.matchAll(/\[([^\]]*)\]/g)) for (const d of b[1]!.matchAll(/(\d{1,2})일/g)) out.push(Number(d[1]));
  for (const d of title.matchAll(/\((\d{1,2})일\)/g)) out.push(Number(d[1]));
  for (const d of title.matchAll(/(\d{1,2})일\s*\(현지/g)) out.push(Number(d[1]));
  for (const d of title.matchAll(/\d{1,2}월\s*(\d{1,2})일/g)) out.push(Number(d[1]));
  return out;
}

export type BlockReason = "물음표" | "의견" | "광고" | "시세" | "인용" | "물음" | "권유" | "평가" | "당위" | "명령" | "전망" | "영문" | "예측" | "말투";

/**
 * 기사가 아니라 시세·종목 쪽 제목인지 (SS4): 종목·상품 코드로 끝나는 제목('SK하이닉스(000660)'·'N2 월간 레버리지 코스피 200 선물 ETN(Q550089 )'),
 * 띄어쓰기 없는 이름만 있는 제목('삼성전자'·'매일경제TV'), 언론사 이름뿐인 제목('쿠키뉴스'), 시세표('[표] 코스피 지수선물·옵션 시세표(9일)-2'·'[표] 외국환율고시표').
 * '[특징주] 삼성전자(005930), 5% 급등'처럼 코드가 가운데 있거나 '[표] 개인, 코스피서 … 순매도'처럼 문장이 있는 제목은 둔다
 */
const QUOTE_CODE_END_RE = /\(\s*[A-Z]{0,2}\d{5,6}[A-Z]?\s*\)\s*$/;
const BARE_NAME_RE = /^[가-힣A-Za-z0-9&.]{1,20}$/;
const QUOTE_TABLE_RE = /\[표\][^…,]*(?:시세표|고시표)/;
export function quotePage(title: string): boolean {
  const t = title.trim();
  return QUOTE_CODE_END_RE.test(t) || BARE_NAME_RE.test(t) || QUOTE_TABLE_RE.test(t) || outletName(t) !== null;
}

/**
 * 제목을 거르는 까닭 (없으면 null): 물음표 · 의견 난 · 광고 · 시세(종목 코드·이름만 — quotePage) · 인용(따옴표 속 남의 말) · 물음(물음표 없는 물음) · 권유(낱말·때 짚기·청유) · 평가(싸다·비싸다) ·
 * 당위 끝 · 명령형 끝(반말·존댓말) · 전망 낱말 · 영문 전망·권유 · 예측 · 말투(해설·광고 글).
 * 고치지 않고 통째로 뺀다 — 언론사 제목 원문만 보이므로 걸러낼 수 없는 제목은 싣지 않는다. 끝 모양 검사는 제목 전체와 본문(coreTitle) 둘 다 본다.
 * year = 기사가 나온 해 (주면 그보다 뒤 해의 규모·성장 단정도 '전망'으로 — futureYearOutlook)
 */
export function blockReason(title: string, opts: { year?: number } = {}): BlockReason | null {
  const core = coreTitle(title);
  const either = (f: (t: string) => boolean) => f(title) || (core !== title && f(core));
  if (QUESTION_RE.test(title)) return "물음표";
  if (OPINION_RE.test(title)) return "의견";
  if (SPAM_RE.test(title)) return "광고";
  if (quotePage(title)) return "시세";
  if (quotedSpeech(title)) return "인용";
  if (either(asksQuestion) || TOPIC_END_RE.test(core)) return "물음";
  if (ADVICE_RE.test(title) || tickerIntro(title) || either(timingCall) || either(proposes)) return "권유";
  if (VALUE_RE.test(title)) return "평가";
  if (either(ought)) return "당위";
  if (either(commands)) return "명령";
  if (OUTLOOK_RE.test(title) || threatensLevel(title) || either(forecastsTense) || futureYearOutlook(title, opts.year)) return "전망";
  if (ENGLISH_RE.test(title)) return "영문";
  if (predicts(title)) return "예측";
  if (either(politeTalk)) return "말투";
  return null;
}

/** 걸러야 할 제목인지 (blockReason 이 있으면) */
export function blockedTitle(title: string, opts: { year?: number } = {}): boolean {
  return blockReason(title, opts) !== null;
}

/**
 * 구글 뉴스가 시각 없이 날짜만 준 기사인지 (7차 검토): 이런 기사는 발행 시각이 그날 태평양 시간 자정(여름 07:00:00 GMT = 한국 16:00,
 * 겨울 08:00:00 GMT = 한국 17:00)으로 찍혀 온다. 말뭉치 1만여 건 가운데 약 4분의 1이 이 시각이었고, 오후 창 끝(16:00)에 걸려
 * 아침 개장 기사('코스피, 0.91% 상승 출발')가 마감 기사처럼 뽑혔다. 실제 시각을 모르므로 창에 넣지 않는다
 */
const LA_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export function dateOnlyStamp(iso: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t % 60_000 !== 0) return false;
  return LA_CLOCK.format(new Date(t)) === "00:00:00";
}

/**
 * 언론사 칸에 보일 이름 (7차·8차 검토): 이름을 아는 언론사만 뽑는다 — 이름 목록(OUTLET_NAMES)이나 도메인 목록(OUTLET_BY_DOMAIN)에 있는 곳.
 * 구글이 이름 대신 도메인을 주면('edaily.co.kr') 아는 언론사는 이름으로 바꾸고, 같은 언론사의 다른 표기('KBS 뉴스'·'Chosunbiz')는
 * 한 이름으로 모은다(같은 언론사 1건 규칙이 맞게). '매일경제 마켓'(시세 쪽 제목이 섞임)은 뽑지 않는다. 목록에 없는 곳은 null (뽑지 않는다): 포털 중계(v.daum.net·네이트), 영상(YouTube)·블로그·
 * 유료 투자 글(네이버 프리미엄콘텐츠), 코인·자동 생성 종목 글(토큰포스트·ThinkPool 등), 증권사·기업 글(KB Think 등), 모르는 도메인과
 * 금융 기사 사이에 섞여 오는 스팸 사이트 이름('Histoire pour tous'·'Calgary Roughnecks')과 해외 중개 사이트('Traders Union'·'TradingKey').
 * 목록은 2026-09 구글 뉴스 말뭉치(언론사 621곳)를 하나하나 보고 통신사·전국/경제 일간지·방송사·주요 경제·IT 인터넷 신문·지역 일간지를 넣었다
 */
const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const OUTLET_BY_DOMAIN: Readonly<Record<string, string>> = {
  "edaily.co.kr": "이데일리",
  "mt.co.kr": "머니투데이",
  "fnnews.com": "파이낸셜뉴스",
  "ebn.co.kr": "EBN",
  "sbs.co.kr": "SBS",
  "chosun.com": "조선일보",
  "biz.chosun.com": "조선비즈",
  "dt.co.kr": "디지털타임스",
  "imaeil.com": "매일신문",
  "gukjenews.com": "국제뉴스",
  "sisajournal.com": "시사저널",
  "hankyung.com": "한국경제",
  "mk.co.kr": "매일경제",
  "yna.co.kr": "연합뉴스",
  "news1.kr": "뉴스1",
  "newsis.com": "뉴시스",
  "einfomax.co.kr": "연합인포맥스",
  "asiae.co.kr": "아시아경제",
  "sedaily.com": "서울경제",
  "heraldcorp.com": "헤럴드경제",
  "etnews.com": "전자신문",
  "newspim.com": "뉴스핌",
  "joongang.co.kr": "중앙일보",
  "donga.com": "동아일보",
  "khan.co.kr": "경향신문",
  "hani.co.kr": "한겨레",
  "kbs.co.kr": "KBS",
  "imbc.com": "MBC",
  "ytn.co.kr": "YTN",
  "ichannela.com": "채널A",
  "mbn.co.kr": "MBN",
  "ekn.kr": "에너지경제신문",
  "newdaily.co.kr": "뉴데일리",
  "seoul.co.kr": "서울신문",
  "kyongbuk.co.kr": "경북일보",
  "jnilbo.com": "전남일보",
};
/** 같은 언론사의 다른 표기 → 한 이름 */
const OUTLET_ALIAS: Readonly<Record<string, string>> = {
  Chosunbiz: "조선비즈",
  "KBS 뉴스": "KBS",
  "MBC 뉴스": "MBC",
  "SBS 뉴스": "SBS",
  // '매일경제 마켓'은 모으지 않는다(뽑지 않음, SS4): 기사 말고 시세 쪽 제목('SK하이닉스(000660)'·'… ETN(Q550089 )'·'삼성전자')도 올리고
  // 발행 시각이 00~09시 사이로 제각각이다. 같은 기사는 '매일경제' 이름으로도 온다
  모바일한경: "한국경제",
  "연합뉴스 한민족센터": "연합뉴스",
  "전북일보 인터넷신문": "전북일보",
  "경인방송 뉴스": "경인방송",
  TV조선뉴스: "TV조선",
  DealSite경제TV: "딜사이트경제TV",
  "ER 이코노믹리뷰": "이코노믹리뷰",
};
/** 뽑을 수 있는 언론사 이름 (구글 source 이름 그대로 — 다른 표기는 OUTLET_ALIAS 로 모은 뒤 본다) */
const OUTLET_NAMES: ReadonlySet<string> = new Set([
  // 통신사
  "연합뉴스", "연합인포맥스", "연합뉴스TV", "뉴스1", "뉴시스", "뉴스핌",
  // 전국 일간지
  "조선일보", "중앙일보", "동아일보", "한국일보", "경향신문", "한겨레", "서울신문", "세계일보", "국민일보", "문화일보", "내일신문", "미주조선일보", "미주중앙일보",
  // 경제 일간지·경제 매체
  "한국경제", "매일경제", "서울경제", "머니투데이", "이데일리", "마켓인", "파이낸셜뉴스", "헤럴드경제", "아시아경제", "아주경제", "이투데이", "조선비즈", "인베스트조선",
  "글로벌이코노믹", "에너지경제신문", "대한경제", "브릿지경제", "머니S", "이코노미스트", "이코노믹리뷰", "한경매거진&북", "뉴스토마토", "뉴스웨이", "비즈워치", "비즈니스포스트",
  "아이뉴스24", "서울파이낸스", "한국금융신문", "조세일보", "딜사이트", "딜사이트경제TV", "EBN", "시사저널", "시사저널e", "매일일보", "신아일보", "아시아투데이", "데일리안", "뉴데일리",
  "미디어펜", "뉴스투데이", "메트로신문", "쿠키뉴스", "노컷뉴스", "OhmyNews", "프레시안", "더팩트", "뉴스웍스", "알파경제", "인포스탁데일리", "오피니언뉴스", "파이낸셜투데이",
  "한스경제", "스페셜경제", "비욘드포스트", "이지경제", "현대경제신문", "금융경제신문", "중소기업신문", "CEO스코어데일리", "뉴스로드", "더구루", "글로벌경제신문", "녹색경제신문",
  "컨슈머타임스", "여성경제신문", "데일리한국", "이뉴스투데이", "한국정경신문", "일간투데이", "뉴시안", "뉴스퀘스트", "주간동아", "주간조선", "주간한국",
  "천지일보", "여성신문", "스트레이트뉴스", "프라임경제", "한양경제", "투데이신문", "일요경제", "월요신문", "자본시장뉴스", "핀포인트뉴스", "파이낸셜포스트", "비즈트리뷴",
  "서울이코노미뉴스", "아시아타임즈", "조세금융신문", "세계비즈",
  // IT·산업
  "전자신문", "디지털타임스", "디지털데일리", "지디넷코리아", "블로터", "IT조선", "디일렉", "테크M", "AI타임스", "인더스트리뉴스", "디지털투데이",
  // 방송
  "KBS", "MBC", "SBS", "YTN", "JTBC", "MBN", "채널A", "TV조선", "SBS Biz", "한국경제TV", "서울경제TV", "매일경제TV", "MTN 머니투데이방송", "이데일리TV", "팍스경제TV",
  "KBC광주방송", "경인방송", "BBS불교방송", "대구MBC", "여수MBC", "제주MBC", "부산경제방송", "티제이비",
  // 지역 일간지
  "국제신문", "부산일보", "매일신문", "경북매일", "경북일보", "강원도민일보", "강원일보", "경기일보", "경인일보", "인천일보", "기호일보", "경기신문", "중부일보", "대전일보",
  "중부매일", "충청투데이", "전북일보", "전북도민일보", "전라일보", "남도일보", "전남일보", "광주일보", "경남일보", "경남신문", "국제뉴스",
  // 해외 주요 금융 매체의 한국어판
  "Investing.com 한국어",
]);
const PORTAL_DOMAIN_RE = /(?:^|\.)(?:daum\.net|naver\.com|nate\.com|zum\.com|msn\.com|yahoo\.com|google\.com)$/i;
export function outletName(source: string | null | undefined): string | null {
  const s = (source ?? "").trim();
  if (!s) return null;
  if (!DOMAIN_RE.test(s)) {
    const name = OUTLET_ALIAS[s] ?? s;
    return OUTLET_NAMES.has(name) ? name : null;
  }
  if (PORTAL_DOMAIN_RE.test(s)) return null;
  const host = s.toLowerCase().replace(/^(?:www|m|news|tvm)\./, "");
  return OUTLET_BY_DOMAIN[host] ?? OUTLET_BY_DOMAIN[host.split(".").slice(-3).join(".")] ?? OUTLET_BY_DOMAIN[host.split(".").slice(-2).join(".")] ?? null;
}

/** 원문 링크로 쓸 수 있는 주소인지 (http·https 만 — 다른 꼴(javascript:·intent: 등)은 저장하지도 열지도 않는다) */
export function isWebUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\/[^\s]+$/i.test(url.trim());
}

/** 제목에서 지수를 알아보는 이름 (나스닥100·코스피200·코스닥150 같은 다른 지수는 빼고) */
const INDEX_TITLE_RE: Record<string, RegExp> = {
  NASDAQ: /나스닥(?!\s?100)|nasdaq(?!\s?100)/i,
  SPX: /S&P\s?500|S&P(?!\s?\d)|에스앤피/i,
  DJI: /다우/,
  SOX: /필라델피아\s?반도체|필라\s?반도체|반도체\s?지수|\bSOX\b/i,
  KOSPI: /코스피(?!\s?200)|kospi(?!\s?200)/i,
  KOSDAQ: /코스닥(?!\s?150)|kosdaq(?!\s?150)/i,
};
/** 지수 수준처럼 보이는 소수 둘째 자리 숫자 ('6627.26'·'46,123.45') — 뒤에 원·달러·%·포인트가 붙으면(환율·등락폭) 빼고 본다 */
const INDEX_LEVEL_RE = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{3,6})\.(\d{2})(?![\d])(?!\s?(?:원|달러|%|p|포인트|P))/g;
/**
 * 다른 날 장 기사인지 (6차 검토): 제목에 그 지수 이름과 지수 수준 숫자가 있는데 기준일 종가와 다르면 다른 날 값이다.
 * 예: 9/16 오후(코스피 종가 6717.97) 창에 15:33 발행으로 들어온 '코스피 6627.26 마감…'(9/15 종가) — 날짜('○일')가 없어 titleDays 로는 못 거른다.
 * 제목에 적힌 지수의 종가 ±15% 안 숫자만 그 지수 값으로 본다 (등락폭·다른 지수 값과 섞이지 않게). 둘째 자리까지 같으면 같은 값.
 * 제목에 적힌 지수 가운데 하나라도 종가가 제목에 있으면 같은 날 기사다 (7차 검토: 지수마다 따로 보면 '코스피 7080.92 마감…코스닥 장중 850.12'처럼
 * 다른 지수의 장중 값을 함께 적은 같은 날 기사가 빠졌다) — '7017.91로 강보합 마감…장중 7171.44까지'처럼 장중 값을 함께 적은 기사도 둔다
 */
export function otherDayIndexValue(title: string, closes: ReadonlyArray<{ code: string; value: number | null }>): boolean {
  const named = closes.filter((c): c is { code: string; value: number } => c.value !== null && c.value > 0 && !!INDEX_TITLE_RE[c.code]?.test(title));
  if (!named.length) return false;
  const levels = [...title.matchAll(INDEX_LEVEL_RE)].map((m) => Math.round(Number(`${m[1]!.replace(/,/g, "")}.${m[2]}`) * 100));
  const closeOf = (c: { value: number }) => Math.round(c.value * 100);
  if (named.some((c) => levels.includes(closeOf(c)))) return false;
  for (const c of named) {
    const close = closeOf(c);
    if (levels.some((n) => Math.abs(n - close) / close <= 0.15)) return true;
  }
  return false;
}

/**
 * 뉴스 제목 고르기 (원문 그대로 — 고치지 않는다): 시간 창 안, 물음표·권유·전망 낱말 없음, 다른 날짜가 박힌 제목 없음, 링크는 http(s) 주소만,
 * 기준일 지수 종가를 알면 제목 속 지수 값이 그와 다른 제목(다른 날 장 기사)도 뺀다.
 * 시각 없이 날짜만 온 기사(dateOnlyStamp)와 언론사 이름을 알 수 없는 기사(포털 중계·모르는 도메인·블로그 — outletName)도 뺀다.
 * 같은 기사(정규화 제목)·같은 언론사는 1건. 속보보다 본기사, 통신사 먼저, 그다음 이른 시각 순. 최대 NEWS_MAX
 */
export function pickNews(items: readonly NewsItem[], opts: { from: string; to: string; days: number[]; closes?: ReadonlyArray<{ code: string; value: number | null }> }): SummaryNews[] {
  const from = Date.parse(opts.from);
  const to = Date.parse(opts.to);
  const allowed = new Set(opts.days);
  const cands = items.flatMap((item) => {
    const raw = { ...item, title: newsTitle(item.title ?? "") };
    const t = Date.parse(raw.publishedAt);
    const outlet = outletName(raw.source?.replace(INVISIBLE_RE, ""));
    if (!raw.title || !outlet || !isWebUrl(raw.url) || Number.isNaN(t) || t < from || t > to || dateOnlyStamp(raw.publishedAt)) return [];
    if (blockedTitle(raw.title, { year: Number(kstDateOf(t).slice(0, 4)) })) return [];
    if (opts.closes && otherDayIndexValue(raw.title, opts.closes)) return [];
    return titleDays(raw.title).every((d) => allowed.has(d)) ? [{ ...raw, source: outlet }] : [];
  });
  const rank = (it: NewsItem) => [FLASH_RE.test(it.title) ? 1 : 0, WIRE_OUTLETS.has(it.source!) ? 0 : /\./.test(it.source!) ? 2 : 1, Date.parse(it.publishedAt)];
  const sorted = [...cands].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  const out: SummaryNews[] = [];
  const outlets = new Set<string>();
  const titles = new Set<string>();
  for (const it of sorted) {
    const key = normTitle(it.title);
    if (outlets.has(it.source!) || (key && titles.has(key))) continue;
    outlets.add(it.source!);
    if (key) titles.add(key);
    out.push({ title: it.title, outlet: it.source!, publishedAt: new Date(Date.parse(it.publishedAt)).toISOString(), url: it.url.trim() });
    if (out.length >= NEWS_MAX) break;
  }
  return out;
}

/**
 * 뽑기 전 제목 다듬기 (SS2·SS3 — 원문 글은 고치지 않고 붙은 꼬리·보이지 않는 글자만 뗀다):
 *  - 뜻 없는 폭 없는 글자(U+200B·U+2060·U+FEFF — INVISIBLE_RE)를 지운다 (출처 파서도 지우지만 다른 출처·예전 저장본에 대비).
 *    ZWJ·ZWNJ·방향 표시는 두다 (이모지·문자 모양이 바뀐다 — 앱은 폭 0 으로 센다)
 *  - 끝에 남은 ' - {아는 언론사}' 꼬리를 되풀이해서 뗀다: 구글이 '… 마감 - 조선비즈 - Chosunbiz'·'… - 머니투데이 - mt.co.kr'처럼
 *    언론사를 두 표기로 붙여 보내면 파서가 마지막 하나만 떼어 카드에 '… 마감 - 머…'가 보였다. 모르는 이름('- 한국투자증권')은 둔다
 */
export function newsTitle(title: string): string {
  let t = title.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
  for (;;) {
    const dash = t.lastIndexOf(" - ");
    if (dash <= 0 || !outletName(t.slice(dash + 3).trim())) return t;
    t = t
      .slice(0, dash)
      .replace(/(?:\s*[|｜])+\s*$/, "")
      .trim();
  }
}

/** 뉴스 제목에 허용하는 날짜(일): 미국은 뉴욕 거래일과 그다음 날(한국 날짜로 쓴 기사), 한국은 거래일 */
export function newsDays(market: SummaryMarket, basisDate: string): number[] {
  const d = Number(basisDate.slice(8, 10));
  return market === "US" ? [d, Number(addDays(basisDate, 1).slice(8, 10))] : [d];
}

// ── 문장 (앱 lib/marketSummary.ts 와 같은 글) ───────────────────

const idx2 = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "-" : "");
/** "+3.50원" */
const wonChange = (v: number) => `${sign(v)}${idx2(Math.abs(v))}원`;
/** "+3.18%p" (차이는 정수 1/100 로 반올림해 적는다) */
export const ppText = (diff: number) => {
  const bp = Math.round(diff * 100);
  return `${sign(bp)}${(Math.abs(bp) / 100).toFixed(2)}%p`;
};
const yieldText = (y: SummaryYield) => `${y.value.toFixed(y.dp.value)}%${y.change !== null ? ` ${sign(y.change)}${Math.abs(y.change).toFixed(y.dp.change)}%p` : ""}`;
const YIELD_SOURCE: Record<SummaryYield["source"], string> = { treasury: "미 재무부", naver: "로이터·네이버" };
const marketWord = (m: SummaryMarket) => (m === "US" ? "미국" : "국내");

/** 보는 날짜(한국) */
export const viewDateOf = (at: Date) => kstDateOf(at.getTime());

/**
 * 제목에 쓰는 날짜.
 *  - 미국: 숫자의 거래일(basisDate). 월요일·휴장 다음 날에는 숫자가 어젯밤 것이 아니므로 '밤사이'가 아니라 그 거래일로
 *    (11/27 추수감사절 다음 날 → '수요일(11/25) 미국 시장', 노동절 다음 날 9/8 → '금요일(9/4) 미국 시장'). 휴장은 배너가 따로 알린다
 *  - 한국: 휴장이면 그 휴장일('오늘 한국 시장' + 휴장 배지·배너), 아니면 거래일
 */
const titleDate = (d: Pick<MarketSummaryData, "market" | "holiday" | "marketDate" | "basisDate">) => (d.market === "KR" && d.holiday ? d.marketDate : d.basisDate);

/**
 * 제목: '밤사이 미국 시장' / '금요일(9/25) 미국 시장' · '오늘 한국 시장' / '9/23(수) 한국 시장'.
 * 볼 때 날짜로 정한다 — '밤사이'는 숫자의 거래일이 보는 날(한국)의 전날일 때만. 월요일·휴장 다음 날·다음 날 아침·주말에 보면 날짜로
 */
export function titleText(d: Pick<MarketSummaryData, "market" | "holiday" | "marketDate" | "basisDate">, view: Date): string {
  return `${sessionWord(d, view)} 시장`;
}

/** '밤사이 미국' · '금요일(9/25) 미국' · '오늘 한국' · '9/23(수) 한국' (알림 첫 줄 앞머리) */
export function sessionWord(d: Pick<MarketSummaryData, "market" | "holiday" | "marketDate" | "basisDate">, view: Date): string {
  const today = viewDateOf(view);
  const td = titleDate(d);
  if (d.market === "US") return td === addDays(today, -1) ? "밤사이 미국" : `${dayName(td)}(${md(td)}) 미국`;
  return td === today ? "오늘 한국" : `${mdw(td)} 한국`;
}

/** 휴장 줄: '오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준' · '지난밤 미국 휴장(추수감사절) · 아래는 직전 거래일 11/25(수) 기준' */
export function holidayText(d: Pick<MarketSummaryData, "market" | "holiday" | "basisDate">, view: Date, withBasis = true): string | null {
  if (!d.holiday) return null;
  const today = viewDateOf(view);
  const name = d.holiday.name ? `(${d.holiday.name})` : "";
  if (d.market === "US") {
    const when = d.holiday.date === addDays(today, -1) ? "지난밤" : mdw(d.holiday.date);
    return `${when} 미국 휴장${name}${withBasis ? ` · 아래는 직전 거래일 ${mdw(d.basisDate)} 기준` : ""}`;
  }
  const when = d.holiday.date === today ? "오늘" : mdw(d.holiday.date);
  return `${when} 한국 휴장${name}${withBasis ? ` · 아래는 직전 거래일 ${md(d.basisDate)} 기준` : ""}`;
}

/** 기준 줄: '9/25(금) 뉴욕 장 마감 기준 · 주말 이틀 휴장' · '9/23(수) 15:30 장 마감 기준' · '장중 값(16:00 기준) · 오늘 16:30 마감' */
export function basisText(d: Pick<MarketSummaryData, "market" | "holiday" | "basisDate" | "weekendGap" | "earlyClose" | "closeTime" | "phase" | "asOf">, view: Date): string {
  const today = viewDateOf(view);
  const made = Date.parse(d.asOf);
  if (d.phase === "intraday") {
    const close = sessionClose(d.market, d.basisDate).at;
    const closeDay = kstDateOf(close);
    return `장중 값(${kstHmOf(made)} 기준) · ${closeDay === today ? "오늘" : mdw(closeDay)} ${kstHmOf(close)} 마감`;
  }
  if (d.market === "US") {
    const pre = d.holiday ? "직전 거래일 " : "";
    const early = d.earlyClose ? " (조기 폐장 13:00 ET)" : "";
    if (d.phase === "prelim") return `${pre}${mdw(d.basisDate)} 뉴욕 장 마감 직후 값${early} · 최종값 확정 전`;
    return `${pre}${mdw(d.basisDate)} 뉴욕 장 마감 기준${early}${d.weekendGap ? " · 주말 이틀 휴장" : ""}`;
  }
  return `${d.holiday ? "직전 거래일 " : ""}${mdw(d.basisDate)} ${d.closeTime} 장 마감 기준`;
}

/** 지수 줄: 아침 '나스닥 +0.48% · …', 오후 '코스피 7,080.92 +0.90% · …', 휴장 '코스피 (9/23) +0.90% · …' */
export function indexText(d: Pick<MarketSummaryData, "market" | "indices" | "holiday">): string | null {
  if (!d.indices.some((i) => i.changeRate !== null)) return null;
  return d.indices
    .map((i) => {
      if (i.changeRate === null) return `${i.name} —`;
      const day = d.holiday && i.date ? ` (${md(i.date)})` : "";
      const val = d.market === "KR" && !d.holiday && i.value !== null ? ` ${idx2(i.value)}` : "";
      return `${i.name}${day}${val} ${formatRate(i.changeRate)}`;
    })
    .join(" · ");
}

/** 원/달러 고시일 표기: 고시일이 요약 날짜와 같으면 없음, 다르면 '(9/23 고시)', 고시일을 확인하지 못했으면 '(고시일 확인 못 함)' — 날짜 없는 값이 오늘 값처럼 보이지 않게 */
export function fxDateNote(f: Pick<SummaryFx, "date">, date: string): string {
  if (!f.date) return " (고시일 확인 못 함)";
  return f.date !== date ? ` (${md(f.date)} 고시)` : "";
}

/** 원/달러 한 칸: '원/달러 1,359.00원 +3.50원 (9/23 고시)' — 고시일이 요약 날짜와 같으면 날짜를 붙이지 않는다 */
export function fxText(d: Pick<MarketSummaryData, "fx" | "date">): string | null {
  const f = d.fx;
  if (!f) return null;
  return `원/달러 ${idx2(f.value)}원 ${wonChange(f.change)}${fxDateNote(f, d.date)}`;
}

/**
 * 미 10년물 한 칸 (출처 표기 필수): '미 10년물 5.17% -0.01%p (미 재무부)'.
 * withDate(휴장 다음 날처럼 숫자가 직전 거래일 값일 때): '미 10년물 4.90% +0.02%p (11/25 기준 · 미 재무부)'
 */
export function yieldLine(y: SummaryYield | null, withDate = false): string | null {
  return y ? `미 10년물 ${yieldText(y)} (${withDate ? `${md(y.date)} 기준 · ` : ""}${YIELD_SOURCE[y.source]})` : null;
}

/** 환율·금리 줄 (휴장이면 금리에도 'M/D 기준' — 원/달러는 고시일을 따로 적는다) */
export function ratesText(d: Pick<MarketSummaryData, "fx" | "date" | "yield10y" | "holiday">): string | null {
  const parts = [fxText(d), yieldLine(d.yield10y, !!d.holiday)].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : null;
}

const sectorItem = (s: SectorRow) => `${s.name} ${formatRate(s.changeRate)}`;
/** 휴장일 숫자 줄 앞머리 'M/D 기준 · ' */
const basisPrefix = (d: Pick<MarketSummaryData, "holiday" | "basisDate">) => (d.holiday ? `${md(d.basisDate)} 기준 · ` : "");

/** 업종 줄: '강한 업종 산업재 +0.95% · 기술 +0.80% / 약한 업종 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)' */
export function sectorText(d: Pick<MarketSummaryData, "sectors" | "holiday" | "basisDate">): string | null {
  const s = d.sectors;
  if (!s || !s.strong.length) return null;
  return `${basisPrefix(d)}강한 업종 ${s.strong.map(sectorItem).join(" · ")} / 약한 업종 ${s.weak.map(sectorItem).join(" · ")}${s.basis === "etf" ? " (섹터 ETF 기준)" : ""}`;
}

/** 묶음에서 지수와 차이가 가장 큰 종목 (한 줄 문구 괄호): 높음은 가장 큰 +, 낮음은 가장 큰 − — 표 순서와 따로 고른다. 같으면 이름 순 앞 */
export function widestOf(rows: readonly CompareRow[]): CompareRow | undefined {
  let best: CompareRow | undefined;
  for (const r of rows) {
    const d = best ? Math.abs(Math.round(r.diff * 100)) - Math.abs(Math.round(best.diff * 100)) : 1;
    if (d > 0 || (d === 0 && r.name.localeCompare(best!.name, "ko") < 0)) best = r;
  }
  return best;
}

/**
 * 내 종목 줄: '내 미국 12종목 · 지수보다 높음 2 (마이크로소프트 +3.66%, 지수와 차이 +3.18%p) · 낮음 3 (메타 -3.33%, 차이 -3.81%p) · 비슷 7'.
 * 모두 비슷하면 '내 미국 12종목 모두 지수와 ±1%p 안'. 비교한 종목이 없으면 null
 */
export function holdingsText(d: Pick<MarketSummaryData, "holdings" | "holiday" | "basisDate">, opts: { mine?: boolean } = {}): string | null {
  const h = d.holdings;
  if (!h || h.compared === 0) return null;
  const head = `${opts.mine === false ? "" : "내 "}${marketWord(h.market)} ${h.compared}종목`;
  if (!h.high.length && !h.low.length) return `${basisPrefix(d)}${head} 모두 지수와 ±${(SIMILAR_BAND_BP / 100).toFixed(0)}%p 안`;
  let first = true;
  const paren = (r: CompareRow | undefined) => {
    if (!r) return "";
    const s = ` (${r.name} ${formatRate(r.changeRate)}, ${first ? "지수와 차이" : "차이"} ${ppText(r.diff)})`;
    first = false;
    return s;
  };
  const high = `지수보다 높음 ${h.high.length}${paren(widestOf(h.high))}`;
  const low = `낮음 ${h.low.length}${paren(widestOf(h.low))}`;
  return `${basisPrefix(d)}${head} · ${high} · ${low} · 비슷 ${h.similar.length}`;
}

/** 상세 보조 줄: '내 미국 12종목: 상승 8 · 하락 4 / 나스닥 +0.48% · S&P500 +0.51%' */
export function holdingsAux(h: HoldingsCompare): string {
  const moves = [`상승 ${h.up}`, `하락 ${h.down}`, ...(h.flat ? [`보합 ${h.flat}`] : [])].join(" · ");
  const bench = h.benchmarks.map((b) => `${b.name} ${formatRate(b.changeRate)}`).join(" · ");
  return `내 ${marketWord(h.market)} ${h.compared}종목: ${moves}${bench ? ` / ${bench}` : ""}`;
}

/** 일정 한 칸: '오늘 21:30 미국 9월 소비자물가(CPI) 발표' · '10/29(목) 03:00 …' · '9/24~9/25 추석 연휴 한국 휴장' · '다음 개장 9/28(월) 09:00' */
export function eventText(e: SummaryEvent, view: Date): string {
  const today = viewDateOf(view);
  const rel = (date: string) => (date === today ? "오늘" : mdw(date));
  if (e.kind === "kr-open") return `다음 개장 ${mdw(e.date)}${e.time ? ` ${e.time}` : ""}`;
  if (e.endDate) return `${md(e.date)}~${md(e.endDate)} ${e.text}`;
  return `${rel(e.date)}${e.time ? ` ${e.time}` : ""} ${e.text}`;
}

/** 일정 줄: 가까운 순 최대 2개 */
export function eventsText(d: Pick<MarketSummaryData, "events">, view: Date): string | null {
  const list = d.events.within.slice(0, 2);
  return list.length ? `일정 · ${list.map((e) => eventText(e, view)).join(" · ")}` : null;
}

/** 뉴스 시각: 요약 날짜와 같은 날이면 HH:MM, 아니면 M/D HH:MM (한국 시간) */
export function newsTime(n: Pick<SummaryNews, "publishedAt">, date: string): string {
  const t = Date.parse(n.publishedAt);
  const day = kstDateOf(t);
  return `${day === date ? "" : `${md(day)} `}${kstHmOf(t)}`;
}

/** 요약의 뉴스 줄 (언론사·시각만 — 제목은 카드·상세의 뉴스 칸에 원문 그대로) */
export function newsText(d: Pick<MarketSummaryData, "news" | "date">): string | null {
  if (!d.news.fresh || !d.news.items.length) return null;
  return `뉴스 ${d.news.items.length}건 · ${d.news.items.map((n) => `${n.outlet} ${newsTime(n, d.date)}`).join(" · ")}`;
}

export type LineKind = "holiday" | "indices" | "rates" | "sectors" | "holdings" | "events" | "news";
export interface SummaryLine {
  kind: LineKind;
  text: string;
}
/** 보이는 순서 */
export const LINE_ORDER: readonly LineKind[] = ["holiday", "indices", "rates", "sectors", "holdings", "events", "news"];
/** 6줄이 넘으면 뒤에서부터 뺀다: 뉴스 → 일정 → 업종 (그다음 환율·금리) */
export const LINE_DROP: readonly LineKind[] = ["news", "events", "sectors", "rates"];

/** 줄 수 상한 적용 (보이는 순서 유지) */
export function fitLines<T extends { kind: LineKind }>(lines: T[], max = MAX_LINES): T[] {
  let out = [...lines];
  for (const k of LINE_DROP) {
    if (out.length <= max) break;
    out = out.filter((l) => l.kind !== k);
  }
  return out.slice(0, max);
}

/** 요약 줄 (최대 6줄, 볼 때 날짜로 '오늘/밤사이' 를 정한다). 지수를 하나도 못 받았으면 빈 목록 */
export function summaryLines(d: MarketSummaryData, view: Date): SummaryLine[] {
  const idx = indexText(d);
  if (!idx) return [];
  const all: Array<SummaryLine | null> = [
    d.holiday ? { kind: "holiday", text: holidayText(d, view)! } : null,
    { kind: "indices", text: idx },
    lineOf("rates", ratesText(d)),
    lineOf("sectors", sectorText(d)),
    lineOf("holdings", holdingsText(d)),
    lineOf("events", eventsText(d, view)),
    lineOf("news", newsText(d)),
  ];
  return fitLines(all.filter((l): l is SummaryLine => l !== null));
}

function lineOf(kind: LineKind, text: string | null): SummaryLine | null {
  return text ? { kind, text } : null;
}

/**
 * 세션 알림 첫 줄 (보내는 순간의 문구 — 저장하지 않는다). 앱 briefingDigest 가 같은 글을 만든다.
 *  - '밤사이 미국 나스닥 +0.48% · S&P500 +0.51% · 내 미국 12종목 중 지수보다 높음 2 · 낮음 3'
 *  - 월요일: '금요일(9/25) 미국 나스닥 …' / 오후: '오늘 한국 코스피 +0.90% · 코스닥 +1.21% · 내 국내 5종목 중 …'
 *  - 휴장: '오늘 한국 휴장(추석) · 코스피 +0.90% · 코스닥 +1.21% (9/23 기준)'
 *  - 지수 두 개를 모두 못 받았으면 null (첫 줄 없이 지금 알림 그대로)
 */
export function digestLine(d: MarketSummaryData, at: Date): string | null {
  const pair = d.indices.slice(0, 2).filter((i) => i.changeRate !== null);
  if (!pair.length) return null;
  const idx = pair.map((i) => `${i.name} ${formatRate(i.changeRate!)}`).join(" · ");
  if (d.holiday) return `${holidayText(d, at, false)} · ${idx} (${md(d.basisDate)} 기준)`;
  // 장중이면 그 시각, 미국 마감 직후 최종값 전이면 그 표시 (카드 기준 줄과 같은 사실)
  const live = d.phase === "intraday" ? ` 장중(${kstHmOf(Date.parse(d.asOf))} 기준)` : d.phase === "prelim" ? "(최종값 전)" : "";
  const h = d.holdings;
  let mine = "";
  if (h && h.compared > 0) {
    const head = `내 ${marketWord(h.market)} ${h.compared}종목`;
    mine = !h.high.length && !h.low.length ? ` · ${head} 모두 지수와 ±${(SIMILAR_BAND_BP / 100).toFixed(0)}%p 안` : ` · ${head} 중 지수보다 높음 ${h.high.length} · 낮음 ${h.low.length}`;
  }
  return `${sessionWord(d, at)}${live} ${idx}${mine}`;
}
