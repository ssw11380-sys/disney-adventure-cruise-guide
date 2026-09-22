import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { describeLlmBackend, resolveLlmBackend } from "../llm/backend.js";
import { ClaudeGenerator, DisabledGenerator, type TextGenerator } from "../llm/generator.js";
import { DartProvider } from "./dart/dart.js";
import type { FinancialsProvider } from "./dart/types.js";
import { QuoteProviderChain, StockSearchChain, type ChainLogger } from "./market/chain.js";
import { TossProvider, type CodeStore } from "./market/toss.js";
import type { InvestorFlowProvider } from "./market/investorFlow.js";
import { KisProvider } from "./market/kis.js";
import { KisMasterProvider } from "./market/kisMaster.js";
import { NaverFinanceProvider } from "./market/naver.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "./market/types.js";
import { YahooProvider } from "./market/yahoo.js";
import { ExpoPushSender, type PushSender } from "../notifications/push.js";
import { NewsProviderChain } from "./news/chain.js";
import { GoogleNewsRssProvider } from "./news/googleRss.js";
import { NaverNewsProvider } from "./news/naver.js";
import type { NewsProvider } from "./news/types.js";

export interface Providers {
  quotes: QuoteProvider;
  search: StockSearchProvider; // 외부 검색 (토스 → Yahoo)
  searchRemoteFirst?: boolean; // true 면 로컬 마스터보다 외부 검색을 먼저 쓴다
  master: MasterProvider;
  news: NewsProvider;
  financials: FinancialsProvider | null; // DART 키 없으면 null → "데이터 미확인"
  investorFlow: InvestorFlowProvider | null; // KIS 키 없으면 null
  generator: TextGenerator;
  dart: DartProvider | null;
  push: PushSender;
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
  const codeStore: CodeStore = {
    get: async (key) => (await db.selectFrom("meta").select("value").where("key", "=", key).executeTakeFirst())?.value ?? null,
    set: async (key, value) => {
      await db.insertInto("meta").values({ key, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    },
  };
  const toss = new TossProvider(fetch, codeStore);

  const quoteChain: QuoteProvider[] = [];
  let kis: KisProvider | null = null;
  if (cfg.kisEnabled) {
    kis = new KisProvider({ appKey: cfg.KIS_APP_KEY, appSecret: cfg.KIS_APP_SECRET, env: cfg.KIS_ENV });
    quoteChain.push(kis);
  }
  quoteChain.push(toss); // 한국(KRX+NXT 통합, 토스 앱과 같은 숫자)·미국 모두
  quoteChain.push(new NaverFinanceProvider()); // 한국 폴백: KRX 정규장 종가 + NXT 야간 가격
  quoteChain.push(yahoo);

  const newsChain: NewsProvider[] = [];
  if (cfg.NAVER_CLIENT_ID && cfg.NAVER_CLIENT_SECRET) {
    newsChain.push(new NaverNewsProvider(cfg.NAVER_CLIENT_ID, cfg.NAVER_CLIENT_SECRET));
  }
  newsChain.push(new GoogleNewsRssProvider());

  const dart = cfg.DART_API_KEY ? new DartProvider({ apiKey: cfg.DART_API_KEY, db }) : null;

  const backend = resolveLlmBackend(cfg);
  const generator: TextGenerator = backend ? new ClaudeGenerator({ backend }) : new DisabledGenerator();

  return {
    quotes: new QuoteProviderChain(quoteChain, log),
    search: new StockSearchChain([toss, yahoo], log),
    searchRemoteFirst: true, // 토스 검색은 한글로 미국 종목도 찾고 순위도 좋아 마스터보다 먼저 쓴다
    master: new KisMasterProvider(),
    news: new NewsProviderChain(newsChain, log),
    financials: dart,
    investorFlow: kis,
    generator,
    dart,
    push: new ExpoPushSender(cfg.EXPO_ACCESS_TOKEN || undefined),
  };
}

export function describeProviders(cfg: AppConfig): Record<string, string> {
  return {
    quotes: cfg.kisEnabled ? "kis → toss → naver → yahoo" : "toss → naver → yahoo (KIS 키 없음)",
    search: "toss → yahoo (+ 종목 마스터)",
    news: cfg.NAVER_CLIENT_ID ? "naver → google-rss" : "google-rss (네이버 키 없음)",
    financials: cfg.DART_API_KEY ? "dart" : "없음 (DART 키 없음)",
    investorFlow: cfg.kisEnabled ? "kis" : "없음 (KIS 키 없음)",
    llm: describeLlmBackend(resolveLlmBackend(cfg)),
  };
}
