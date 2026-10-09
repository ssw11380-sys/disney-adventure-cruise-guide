import type { Db } from "../../db/index.js";
import type { Fundamentals, FundamentalsCache, FundamentalsCacheStore } from "./fundamentals.js";

const NUMBERS = ["per", "pbr", "eps", "bps", "dividendPerShare", "dividendYieldPct", "high52w", "low52w", "marketCap"] as const;

/** 손상된 저장값으로 숫자/원 수신 시각을 만들어내지 않는다. 저장은 공급자 정상 응답만 받는다. */
export function parseFundamentalsCache(payload: string): FundamentalsCache | null {
  try {
    const e = JSON.parse(payload) as Partial<FundamentalsCache> | null;
    if (!e || typeof e.at !== "number" || !Number.isFinite(new Date(e.at).getTime()) || typeof e.ttl !== "number" || !Number.isFinite(e.ttl) || e.ttl <= 0 || e.refreshFailed !== false) return null;
    if (e.value === null) return e.receivedAt === null ? e as FundamentalsCache : null;
    const value = e.value as Fundamentals | undefined;
    if (!value || typeof value.source !== "string" || !(value.industry === null || typeof value.industry === "string")) return null;
    if (!NUMBERS.every(key => value[key] === null || typeof value[key] === "number" && Number.isFinite(value[key]))) return null;
    if (typeof e.receivedAt !== "number" || !Number.isFinite(e.receivedAt) || !Number.isFinite(new Date(e.receivedAt).getTime())) return null;
    if (value.name !== undefined && value.name !== null && typeof value.name !== "string") return null;
    if (value.exDividendAt !== undefined && typeof value.exDividendAt !== "string") return null;
    return e as FundamentalsCache;
  } catch { return null; }
}

export function createFundamentalsCacheStore(db: Db): FundamentalsCacheStore {
  return {
    async load(code) {
      const row = await db.selectFrom("fundamentals_cache").select("payload").where("code", "=", code).executeTakeFirst();
      return row ? parseFundamentalsCache(row.payload) : null;
    },
    async save(code, entry) {
      if (entry.refreshFailed) return;
      const row = { code, payload: JSON.stringify(entry), fetched_at: new Date(entry.receivedAt ?? entry.at).toISOString() };
      await db.insertInto("fundamentals_cache").values(row).onConflict(oc => oc.column("code").doUpdateSet({ payload: row.payload, fetched_at: row.fetched_at })
        .where("fundamentals_cache.fetched_at", "<=", row.fetched_at)).execute();
    },
  };
}
