import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { describeLlmBackend, resolveLlmBackend } from "../llm/backend.js";
import { ClaudeGenerator, DisabledGenerator, type TextGenerator } from "../llm/generator.js";
import { DartProvider } from "./dart/dart.js";
import type { NaverDiscover } from "./market/naverDiscover.js";
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
  quoteChain.push(new NaverFinanceProvider()); // 한국 폴백: KRX 정규장 종가 + NXT 야간 가격
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
    financialsUs: new EdgarProvider(),
    calendar: new MarketCalendar(),
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
    news: cfg.NAVER_CLIENT_ID ? "naver 종목뉴스 → naver 검색 → google-rss" : "naver 종목뉴스 → google-rss",
    financials: (cfg.DART_API_KEY ? "dart(한국)" : "없음(DART 키 없음)") + " · edgar(미국)",
    investorFlow: cfg.kisEnabled ? "kis" : cfg.tossOpenApiEnabled ? "toss-openapi(공식)" : "없음 (KIS/토스 Open API 키 없음)",
    realtime: cfg.tossOpenApiEnabled ? "toss-openapi 웹소켓 + toss 웹 3초 갱신" : "toss 웹 3초 갱신 (Open API 키 있으면 웹소켓)",
    llm: describeLlmBackend(resolveLlmBackend(cfg)),
  };
}
