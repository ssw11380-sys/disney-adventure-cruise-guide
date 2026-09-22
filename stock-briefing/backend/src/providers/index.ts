import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { QuoteProviderChain, type ChainLogger } from "./market/chain.js";
import { KisProvider } from "./market/kis.js";
import { KisMasterProvider } from "./market/kisMaster.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "./market/types.js";
import { YahooProvider } from "./market/yahoo.js";

export interface Providers {
  quotes: QuoteProvider;
  search: StockSearchProvider; // 로컬 마스터에 없을 때 쓰는 외부 검색
  master: MasterProvider;
}

/** 설정에 따라 실제 데이터 소스를 조립한다. KIS 키가 없으면 Yahoo 단독. */
export function buildProviders(cfg: AppConfig, db: Db, log: ChainLogger): Providers {
  const resolveMarket = async (code: string): Promise<string | null> => {
    const row = await db
      .selectFrom("listed_stocks")
      .select("market")
      .where("code", "=", code)
      .executeTakeFirst();
    return row?.market ?? null;
  };
  const yahoo = new YahooProvider(fetch, resolveMarket);
  const chain: QuoteProvider[] = [];
  if (cfg.kisEnabled) {
    chain.push(new KisProvider({ appKey: cfg.KIS_APP_KEY, appSecret: cfg.KIS_APP_SECRET, env: cfg.KIS_ENV }));
  }
  chain.push(yahoo);
  return {
    quotes: new QuoteProviderChain(chain, log),
    search: yahoo,
    master: new KisMasterProvider(),
  };
}
