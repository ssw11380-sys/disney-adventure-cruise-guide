import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { describeLlmBackend, resolveLlmBackend } from "../llm/backend.js";
import { ClaudeGenerator, DisabledGenerator, type TextGenerator } from "../llm/generator.js";
import { DartProvider } from "./dart/dart.js";
import type { FinancialsProvider } from "./dart/types.js";
import { QuoteProviderChain, type ChainLogger } from "./market/chain.js";
import type { InvestorFlowProvider } from "./market/investorFlow.js";
import { KisProvider } from "./market/kis.js";
import { KisMasterProvider } from "./market/kisMaster.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "./market/types.js";
import { YahooProvider } from "./market/yahoo.js";
import { ExpoPushSender, type PushSender } from "../notifications/push.js";
import { NewsProviderChain } from "./news/chain.js";
import { GoogleNewsRssProvider } from "./news/googleRss.js";
import { NaverNewsProvider } from "./news/naver.js";
import type { NewsProvider } from "./news/types.js";

export interface Providers {
  quotes: QuoteProvider;
  search: StockSearchProvider; // 로컬 마스터에 없을 때 쓰는 외부 검색
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
    const row = await db.selectFrom("listed_stocks").select("market").where("code", "=", code).executeTakeFirst();
    return row?.market ?? null;
  };
  const yahoo = new YahooProvider(fetch, resolveMarket);

  const quoteChain: QuoteProvider[] = [];
  let kis: KisProvider | null = null;
  if (cfg.kisEnabled) {
    kis = new KisProvider({ appKey: cfg.KIS_APP_KEY, appSecret: cfg.KIS_APP_SECRET, env: cfg.KIS_ENV });
    quoteChain.push(kis);
  }
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
    search: yahoo,
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
    quotes: cfg.kisEnabled ? "kis → yahoo" : "yahoo (KIS 키 없음)",
    news: cfg.NAVER_CLIENT_ID ? "naver → google-rss" : "google-rss (네이버 키 없음)",
    financials: cfg.DART_API_KEY ? "dart" : "없음 (DART 키 없음)",
    investorFlow: cfg.kisEnabled ? "kis" : "없음 (KIS 키 없음)",
    llm: describeLlmBackend(resolveLlmBackend(cfg)),
  };
}
