import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { describeLlmBackend, resolveLlmBackend } from "../llm/backend.js";
import { ClaudeGenerator, DisabledGenerator, type TextGenerator } from "../llm/generator.js";
import { DartProvider } from "./dart/dart.js";
import { NaverDiscover } from "./market/naverDiscover.js";
import { NaverFinanceClient } from "./market/naverFinance.js";
import type { MarketIndices } from "./market/indices.js";
import { EdgarProvider } from "./dart/edgar.js";
import type { FinancialsProvider } from "./dart/types.js";
import { MarketCalendar } from "./market/calendar.js";
import { QuoteProviderChain, StockSearchChain, type ChainLogger } from "./market/chain.js";
import { TossProvider, type CodeStore } from "./market/toss.js";
import { TossOpenApiClient, TossOpenApiProvider } from "./market/tossOpenApi.js";
import { TossTics } from "./market/tossTics.js";
import { TossRealtime, type QuickPriceSource } from "./market/tossRealtime.js";
import type { InvestorFlowProvider } from "./market/investorFlow.js";
import { KisProvider } from "./market/kis.js";
import { KisMasterProvider } from "./market/kisMaster.js";
import { NaverFinanceProvider } from "./market/naver.js";
import { NaverFundamentals } from "./market/fundamentals.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "./market/types.js";
import { YahooProvider } from "./market/yahoo.js";
import { ExpoPushSender, type PushSender } from "../notifications/push.js";
import { NewsProviderChain } from "./news/chain.js";
import { GoogleNewsRssProvider } from "./news/googleRss.js";
import { NaverNewsProvider } from "./news/naver.js";
import { NaverStockNewsProvider } from "./news/naverStock.js";
import type { NewsProvider } from "./news/types.js";
import type { MarketSummarySources } from "../services/marketSummaryService.js";
import type { ProductFacts } from "../analysis/leveraged.js";
import type { ScoreSources } from "../services/indicatorScoreService.js";
import { defaultValueSources, type ValueSources } from "../services/valueScoreService.js";
import type { HoldingEventSources } from "../services/holdingEvents.js";
import type { FilingSource } from "../services/filingAlerts.js";
import { NasdaqScreener } from "./market/nasdaqScreener.js";
import { defaultKrValueSources, type KrValueSources } from "../services/krValueService.js";

export interface Providers {
  quotes: QuoteProvider;
  /** 토스증권 공식 Open API (키 있을 때만). 보유 종목 가져오기·상태 조회에 쓴다 */
  tossOpenApi: TossOpenApiProvider | null;
  /** 실시간 체결(웹소켓) — 토스 Open API 키 있을 때만 */
  live: TossRealtime | null;
  /** 키 없이도 되는 준실시간: 토스 웹 시세를 여러 종목 한 번에 */
  quickPrices: QuickPriceSource | null;
  /** PER/PBR/배당/52주·환율 보강 (네이버) */
  fundamentals: NaverFundamentals | null;
  /** 발견 탭(순위·테마·업종). 없으면 기본 네이버 공개 JSON */
  discover?: NaverDiscover | null;
  /** 발견 탭 미국 테마(토스 테마 분류). 없으면 미국은 산업 분류만 */
  tics?: TossTics | null;
  search: StockSearchProvider; // 외부 검색 (토스 → Yahoo)
  searchRemoteFirst?: boolean; // true 면 로컬 마스터보다 외부 검색을 먼저 쓴다
  master: MasterProvider;
  news: NewsProvider;
  financials: FinancialsProvider | null; // DART 키 없으면 null → "데이터 미확인"
  /** 미국 종목 재무·공시 (SEC EDGAR, 키 불필요) */
  financialsUs: FinancialsProvider | null;
  /** 휴장일·장중 판단 */
  calendar: MarketCalendar;
  /**
   * 정규장 종가 일봉 (매매 기록 스냅샷의 regularClose, 3-36) — 시장마다 차례로 묻는다. 한국은 네이버(KRX 정규장 일봉 — 토스 일봉은
   * NXT 애프터마켓까지 든 통합 종가라 넣지 않음), 미국은 토스 웹(애프터마켓 체결은 봉에 넣지 않음) → Yahoo. 없으면 regularClose 는 null
   */
  regularCloseSources?: { KR: QuoteProvider[]; US: QuoteProvider[] } | null;
  /** 지수 띠·잔고 위젯 지수 줄 (없으면 기본 네이버 공개 JSON) */
  indices?: MarketIndices | null;
  /**
   * 시장 전체 요약의 출처 묶음 (없으면 app.ts 가 실제 출처로 만든다). null = 요약 서비스를 두지 않음 —
   * 네트워크 없이 도는 테스트 기본값(fakeProviders)이 쓴다 (플래그 marketSummary 가 켜져 있어도 출처를 부르지 않게)
   */
  marketSummary?: MarketSummarySources | null;
  /** 토스 웹 상품 정보 (ETF·레버리지 배수·단일 종목형 — 지표 점수 3-44). 없으면 이름 규칙·정적 표로만 가린다 */
  productInfo?: { productFacts(code: string): Promise<ProductFacts | null> } | null;
  /** 지표 점수 자료 묶음 (없으면 app.ts 가 차트 일봉·네이버 지수·종목 목록으로 만든다 — 테스트는 기록한 일봉을 넣는다) */
  scoreSources?: ScoreSources | null;
  /** 가치 지표 출처 (SEC companyfacts·frames + Nasdaq 스크리너, 3-44 2단계). 없으면 가치 지표는 1단계 그대로('계산 준비 중') */
  valueSources?: ValueSources | null;
  /**
   * 다가오는 일정 출처 (브리핑 3차 5 — 토스 웹 배당 요약·공개 캘린더 + 네이버 배당락일, 모두 로그인 없음). 없으면(테스트 기본) 계좌 브리핑에 일정 칸이 없다
   */
  holdingEvents?: HoldingEventSources | null;
  /** 한국 간이 가치 출처 (네이버 재무 요약 + 업종 구성 종목, 3-44 3단계). 없으면 한국 가치 줄은 '지금 계산하지 않음' */
  krValueSources?: KrValueSources | null;
  /**
   * 새 공시 알림 출처 (3-38 — SEC EDGAR 티커→CIK · submissions, 로그인·키 없음). 가치 지표와 같은 EdgarProvider 인스턴스(요청 간격 공유).
   * 없으면(테스트 기본) 공시 확인 작업을 두지 않는다 — 네트워크 없이
   */
  secFilings?: FilingSource | null;
  investorFlow: InvestorFlowProvider | null; // KIS 키 없으면 null
  generator: TextGenerator;
  dart: DartProvider | null;
  push: PushSender;
}

/** meta 표를 키-값 저장소로 (토스 상품 코드, 미국 테마북 등) */
export function metaStore(db: Db): CodeStore {
  return {
    get: async (key) => (await db.selectFrom("meta").select("value").where("key", "=", key).executeTakeFirst())?.value ?? null,
    set: async (key, value) => {
      await db.insertInto("meta").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    },
  };
}

/** 설정에 따라 실제 데이터 소스를 조립한다. 키가 없는 소스는 폴백 또는 null. */
export function buildProviders(cfg: AppConfig, db: Db, log: ChainLogger): Providers {
  const resolveMarket = async (code: string): Promise<string | null> => {
    const listed = await db.selectFrom("listed_stocks").select("market").where("code", "=", code).executeTakeFirst();
    if (listed) return listed.market;
    const registered = await db.selectFrom("registered_stocks").select("market").where("code", "=", code).executeTakeFirst();
    return registered?.market ?? null;
  };
  const yahoo = new YahooProvider(fetch, resolveMarket);
  // 토스 상품 코드(티커 → US2010...) 매핑은 meta 테이블에 남긴다
  const codeStore = metaStore(db);
  const toss = new TossProvider(fetch, codeStore);

  // 토스증권 공식 Open API: 키가 있으면 시세·차트·마스터·수급·실시간의 1순위
  let tossOpenApi: TossOpenApiProvider | null = null;
  let live: TossRealtime | null = null;
  if (cfg.tossOpenApiEnabled) {
    const client = new TossOpenApiClient({ clientId: cfg.TOSS_CLIENT_ID, clientSecret: cfg.TOSS_CLIENT_SECRET, log });
    tossOpenApi = new TossOpenApiProvider(client, { krBase: (code) => toss.basePrice(code), krBaseMany: (codes) => toss.baseMany(codes) });
    live = new TossRealtime(client, { log });
  }

  const quoteChain: QuoteProvider[] = [];
  let kis: KisProvider | null = null;
  if (cfg.kisEnabled) {
    kis = new KisProvider({ appKey: cfg.KIS_APP_KEY, appSecret: cfg.KIS_APP_SECRET, env: cfg.KIS_ENV });
    quoteChain.push(kis);
  }
  if (tossOpenApi) quoteChain.push(tossOpenApi);
  quoteChain.push(toss); // 한국(KRX+NXT 통합, 토스 앱과 같은 숫자)·미국 모두
  const naver = new NaverFinanceProvider();
  quoteChain.push(naver); // 한국 폴백: KRX 정규장 종가 + NXT 야간 가격
  quoteChain.push(yahoo);

  const fundamentals = new NaverFundamentals();
  // 환율: 토스 앱이 원화 평가금에 쓰는 환율(토스 웹 시세의 closeKrw/close) → 토스 Open API 매매기준율 → 네이버(하나은행 고시)
  fundamentals.fxPrimary = async () => (await toss.usdKrw()) ?? (tossOpenApi ? await tossOpenApi.usdKrw() : null);
  const newsChain: NewsProvider[] = [new NaverStockNewsProvider(fetch, fundamentals)];
  if (cfg.NAVER_CLIENT_ID && cfg.NAVER_CLIENT_SECRET) {
    newsChain.push(new NaverNewsProvider(cfg.NAVER_CLIENT_ID, cfg.NAVER_CLIENT_SECRET));
  }
  newsChain.push(new GoogleNewsRssProvider());

  const dart = cfg.DART_API_KEY ? new DartProvider({ apiKey: cfg.DART_API_KEY, db }) : null;
  // 미국 재무·공시(SEC) — 분석 수집과 가치 지표가 같은 인스턴스를 써서 SEC 요청 간격을 함께 지킨다
  // SEC User-Agent: SEC_USER_AGENT(회사 이름 + 연락 메일)가 있으면 그것, 없으면 코드 기본값 (3-38)
  const edgar = new EdgarProvider(fetch, undefined, { userAgent: cfg.SEC_USER_AGENT });

  const backend = resolveLlmBackend(cfg);
  const generator: TextGenerator = backend ? new ClaudeGenerator({ backend }) : new DisabledGenerator();

  return {
    quotes: new QuoteProviderChain(quoteChain, log),
    tossOpenApi,
    live,
    quickPrices: toss,
    fundamentals,
    tics: new TossTics(),
    search: new StockSearchChain([toss, yahoo], log),
    searchRemoteFirst: true, // 토스 검색은 한글로 미국 종목도 찾고 순위도 좋아 마스터보다 먼저 쓴다
    master: tossOpenApi ?? new KisMasterProvider(), // 토스 마스터는 한국+미국 종목(한글명)까지
    news: new NewsProviderChain(newsChain, log),
    financials: dart,
    financialsUs: edgar,
    // 가치 지표(3-44 2단계): 같은 SEC 인스턴스(요청 간격 공유) + Nasdaq 스크리너
    valueSources: defaultValueSources(edgar, new NasdaqScreener()),
    // 새 공시 알림(3-38): 같은 SEC 인스턴스 (User-Agent·요청 간격 gate 공유 — 가치 지표 배치와 겹쳐도 초당 10회 아래)
    secFilings: edgar,
    // 한국 간이 가치(3-44 3단계): 네이버 재무 요약(요청 사이 0.7초) + 업종 구성 종목(발견 탭과 같은 네이버 공개 JSON)
    krValueSources: defaultKrValueSources(new NaverFinanceClient(), new NaverDiscover()),
    // 토스 달력과 휴장일 목록이 다르면 로그로 경고 (시장·날짜마다 한 번)
    calendar: new MarketCalendar(fetch, () => new Date(), 5 * 60_000, log),
    regularCloseSources: { KR: [naver], US: [toss, yahoo] },
    productInfo: toss,
    // 다가오는 일정 (브리핑 3차 5): 토스 웹(시세와 같은 인스턴스 — 상품 코드 캐시 공유) + 네이버(같은 fundamentals 1시간 캐시)
    holdingEvents: {
      dividends: (code) => toss.dividendSummary(code),
      calendar: (ym) => toss.calendarMonth(ym),
      productCode: (code) => toss.productCode(code),
      naverExDividend: (code) => fundamentals.exDividendAt(code),
    },
    investorFlow: kis ?? tossOpenApi,
    generator,
    dart,
    push: new ExpoPushSender(cfg.EXPO_ACCESS_TOKEN || undefined),
  };
}

export function describeProviders(cfg: AppConfig): Record<string, string> {
  return {
    quotes: [cfg.kisEnabled ? "kis" : null, cfg.tossOpenApiEnabled ? "toss-openapi(공식)" : null, "toss(웹)", "naver", "yahoo"].filter(Boolean).join(" → ") + (cfg.tossOpenApiEnabled ? "" : " (토스 Open API 키 없음)"),
    search: cfg.tossOpenApiEnabled ? "토스 마스터(한국+미국) + toss → yahoo" : "toss → yahoo (+ KIS 종목 마스터)",
    news: cfg.NAVER_CLIENT_ID ? "naver 종목뉴스 → google-rss → naver 검색" : "naver 종목뉴스 → google-rss",
    financials: (cfg.DART_API_KEY ? "dart(한국)" : "없음(DART 키 없음)") + " · edgar(미국)",
    investorFlow: cfg.kisEnabled ? "kis" : cfg.tossOpenApiEnabled ? "toss-openapi(공식)" : "없음 (KIS/토스 Open API 키 없음)",
    realtime: cfg.tossOpenApiEnabled ? "toss-openapi 웹소켓 + toss 웹 3초 갱신" : "toss 웹 3초 갱신 (Open API 키 있으면 웹소켓)",
    llm: describeLlmBackend(resolveLlmBackend(cfg)),
  };
}
