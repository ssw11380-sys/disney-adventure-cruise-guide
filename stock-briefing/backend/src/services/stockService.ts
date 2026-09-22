import type { Db } from "../db/index.js";
import type { CandlePeriod, CandleSeries, ListedStock, Quote, RegisteredStock } from "../domain/types.js";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { ConflictError, NotFoundError, ProviderError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { toMarket } from "../providers/market/kisMaster.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "../providers/market/types.js";

export interface StockServiceDeps {
  db: Db;
  quotes: QuoteProvider;
  search: StockSearchProvider;
  master: MasterProvider;
  /** true 면 외부 검색(토스)을 먼저 쓰고 로컬 마스터는 보조/폴백으로 쓴다 */
  searchRemoteFirst?: boolean;
  now?: () => Date;
  /** 현재가 캐시 유효 시간(ms). 장중 새로고침 남발 방지용. */
  quoteCacheTtlMs?: number;
}

export interface RegisterInput {
  code: string;
  quantity?: number | null | undefined;
  avgPrice?: number | null | undefined;
  memo?: string | null | undefined;
}

export interface UpdateInput {
  quantity?: number | null | undefined;
  avgPrice?: number | null | undefined;
  memo?: string | null | undefined;
}

export interface RegisteredWithQuote extends RegisteredStock {
  quote: Quote | null;
  quoteError: string | null;
  /** 보유 정보가 있을 때만 계산 */
  evaluation: { marketValue: number; costBasis: number; profit: number; profitRate: number } | null;
}


export class StockService {
  private readonly now: () => Date;
  private readonly ttl: number;

  constructor(private readonly deps: StockServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.ttl = deps.quoteCacheTtlMs ?? 60_000;
  }

  // ── 종목 마스터 ────────────────────────────────────────────────

  async refreshMaster(): Promise<{ count: number; refreshedAt: string }> {
    const stocks = await this.deps.master.fetchAll();
    const refreshedAt = seoulIso(this.now());
    await this.deps.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("listed_stocks").execute();
      const CHUNK = 500;
      for (let i = 0; i < stocks.length; i += CHUNK) {
        await trx
          .insertInto("listed_stocks")
          .values(
            stocks.slice(i, i + CHUNK).map((s) => ({
              code: s.code,
              name: s.name,
              market: s.market,
              isin_code: s.isinCode,
              group_code: s.groupCode,
              updated_at: refreshedAt,
            })),
          )
          .execute();
      }
      // 마스터가 없을 때 외부 검색으로 등록된 종목의 이름(영문 등)을 정식 한글명으로 맞춘다
      const registered = await trx.selectFrom("registered_stocks").select(["code", "name", "market"]).execute();
      const byCode = new Map(stocks.map((s) => [s.code, s]));
      for (const r of registered) {
        const m = byCode.get(r.code);
        if (m && (m.name !== r.name || m.market !== r.market)) {
          await trx
            .updateTable("registered_stocks")
            .set({ name: m.name, market: m.market, updated_at: refreshedAt })
            .where("code", "=", r.code)
            .execute();
        }
      }
      await trx
        .insertInto("meta")
        .values({ key: "master_refreshed_at", value: refreshedAt })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: refreshedAt }))
        .execute();
    });
    return { count: stocks.length, refreshedAt };
  }

  async masterStatus(): Promise<{ count: number; refreshedAt: string | null }> {
    const cnt = await this.deps.db
      .selectFrom("listed_stocks")
      .select((eb) => eb.fn.countAll<number>().as("c"))
      .executeTakeFirst();
    const meta = await this.deps.db
      .selectFrom("meta")
      .select("value")
      .where("key", "=", "master_refreshed_at")
      .executeTakeFirst();
    return { count: Number(cnt?.c ?? 0), refreshedAt: meta?.value ?? null };
  }

  // ── 검색 ────────────────────────────────────────────────────────

  /**
   * 기본: 1) 로컬 마스터(코드 정확 일치 → 이름 접두 → 이름 포함) 2) 비어 있으면 외부 검색.
   * searchRemoteFirst: 외부 검색(토스: 한글로 미국 종목까지, 순위 좋음)을 먼저 쓰고 마스터 결과를 뒤에 덧붙인다.
   * 외부 검색이 실패하면 마스터만으로 답한다.
   */
  async search(query: string, limit = 20): Promise<{ results: ListedStock[]; source: string }> {
    const q = query.trim();
    if (!q) return { results: [], source: "none" };
    const compact = q.replace(/\s+/g, "");
    const local = await this.searchLocal(compact, limit);
    if (this.deps.searchRemoteFirst) {
      try {
        const remote = await this.deps.search.search(q, limit);
        if (remote.length > 0) {
          const seen = new Set(remote.map((s) => s.code));
          const merged = [...remote, ...local.filter((s) => !seen.has(s.code))].slice(0, limit);
          return { results: merged, source: local.length ? `${this.deps.search.name}+master` : this.deps.search.name };
        }
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
      }
      return { results: local, source: local.length ? "master" : "none" };
    }
    // 영문 티커처럼 보이면(대문자 1~5자) 마스터에 있어도 미국 종목을 함께 보여준다
    const looksLikeTicker = /^[A-Za-z][A-Za-z.\-]{0,5}$/.test(compact);
    if (local.length > 0 && !looksLikeTicker) return { results: local, source: "master" };
    try {
      const remote = await this.deps.search.search(q, limit);
      const seen = new Set(local.map((s) => s.code));
      const merged = [...local, ...remote.filter((r) => !seen.has(r.code))].slice(0, limit);
      return { results: merged, source: local.length ? `master+${this.deps.search.name}` : this.deps.search.name };
    } catch (e) {
      if (e instanceof ProviderError) return { results: local, source: local.length ? "master" : "none" };
      throw e;
    }
  }

  private async searchLocal(q: string, limit: number): Promise<ListedStock[]> {
    const db = this.deps.db;
    const rows = CODE_RE.test(q)
      ? await db.selectFrom("listed_stocks").selectAll().where("code", "=", q).execute()
      : await db
          .selectFrom("listed_stocks")
          .selectAll()
          .where((eb) => eb.or([eb("name", "like", `${q}%`), eb("name", "like", `%${q}%`), eb("code", "like", `${q}%`)]))
          .limit(limit * 3)
          .execute();
    const upperQ = q.toUpperCase();
    const rank = (name: string, code: string): number => {
      const n = name.replace(/\s+/g, "").toUpperCase();
      if (n === upperQ || code === q) return 0;
      if (n.startsWith(upperQ)) return 1;
      if (code.startsWith(q)) return 2;
      return 3;
    };
    return rows
      .map((r) => ({
        code: r.code,
        name: r.name,
        market: toMarket(r.market),
        isinCode: r.isin_code,
        groupCode: r.group_code,
      }))
      .sort((a, b) => {
        const d = rank(a.name, a.code) - rank(b.name, b.code);
        if (d !== 0) return d;
        // 일반 주식(ST) 우선, 그 다음 이름 길이(짧을수록 본주일 확률 높음)
        const g = (x: ListedStock) => (x.groupCode === "ST" ? 0 : 1);
        return g(a) - g(b) || a.name.length - b.name.length;
      })
      .slice(0, limit);
  }

  private async resolveListed(code: string): Promise<ListedStock> {
    const row = await this.deps.db.selectFrom("listed_stocks").selectAll().where("code", "=", code).executeTakeFirst();
    if (row) {
      return { code: row.code, name: row.name, market: toMarket(row.market), isinCode: row.isin_code, groupCode: row.group_code };
    }
    // 마스터에 없으면 외부 검색으로 이름을 찾는다 (신규 상장 등)
    try {
      const remote = await this.deps.search.search(code, 5);
      const hit = remote.find((r) => r.code === code);
      if (hit) return hit;
    } catch {
      /* 아래에서 NotFound */
    }
    throw new NotFoundError(`종목 코드 ${code} 를 찾을 수 없습니다. 종목 마스터를 갱신하거나 코드를 확인하세요.`);
  }

  // ── 등록/보유 ────────────────────────────────────────────────────

  async register(input: RegisterInput): Promise<RegisteredStock> {
    input = { ...input, code: normalizeCode(input.code) };
    if (!CODE_RE.test(input.code)) throw new NotFoundError(`종목 코드는 6자리 숫자(한국) 또는 티커(미국)여야 합니다: ${input.code}`);
    const exists = await this.deps.db
      .selectFrom("registered_stocks")
      .select("code")
      .where("code", "=", input.code)
      .executeTakeFirst();
    if (exists) throw new ConflictError(`이미 등록된 종목입니다: ${input.code}`);
    const listed = await this.resolveListed(input.code);
    const ts = seoulIso(this.now());
    await this.deps.db
      .insertInto("registered_stocks")
      .values({
        code: listed.code,
        name: listed.name,
        market: listed.market,
        quantity: input.quantity ?? null,
        avg_price: input.avgPrice ?? null,
        memo: input.memo ?? null,
        created_at: ts,
        updated_at: ts,
      })
      .execute();
    return (await this.get(listed.code))!;
  }

  async update(code: string, input: UpdateInput): Promise<RegisteredStock> {
    const current = await this.get(code);
    if (!current) throw new NotFoundError(`등록되지 않은 종목입니다: ${code}`);
    await this.deps.db
      .updateTable("registered_stocks")
      .set({
        quantity: input.quantity === undefined ? current.quantity : input.quantity,
        avg_price: input.avgPrice === undefined ? current.avgPrice : input.avgPrice,
        memo: input.memo === undefined ? current.memo : input.memo,
        updated_at: seoulIso(this.now()),
      })
      .where("code", "=", code)
      .execute();
    return (await this.get(code))!;
  }

  async remove(code: string): Promise<void> {
    const r = await this.deps.db.deleteFrom("registered_stocks").where("code", "=", code).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) throw new NotFoundError(`등록되지 않은 종목입니다: ${code}`);
  }

  async get(code: string): Promise<RegisteredStock | null> {
    const r = await this.deps.db.selectFrom("registered_stocks").selectAll().where("code", "=", code).executeTakeFirst();
    return r ? toRegistered(r) : null;
  }

  async list(): Promise<RegisteredStock[]> {
    const rows = await this.deps.db.selectFrom("registered_stocks").selectAll().orderBy("created_at", "asc").execute();
    return rows.map(toRegistered);
  }

  async listWithQuotes(): Promise<RegisteredWithQuote[]> {
    const stocks = await this.list();
    // 소스 rate limit 을 고려해 순차 조회
    const out: RegisteredWithQuote[] = [];
    for (const s of stocks) {
      let quote: Quote | null = null;
      let quoteError: string | null = null;
      try {
        quote = await this.getQuote(s.code);
      } catch (e) {
        quoteError = e instanceof Error ? e.message : String(e);
      }
      out.push({ ...s, quote, quoteError, evaluation: evaluate(s, quote) });
    }
    return out;
  }

  // ── 시세 ────────────────────────────────────────────────────────

  async getQuote(code: string, opts: { fresh?: boolean } = {}): Promise<Quote> {
    const db = this.deps.db;
    if (!opts.fresh) {
      const cached = await db.selectFrom("quote_cache").selectAll().where("code", "=", code).executeTakeFirst();
      if (cached && this.now().getTime() - Date.parse(cached.fetched_at) < this.ttl) {
        return JSON.parse(cached.payload) as Quote;
      }
    }
    const quote = await this.deps.quotes.getQuote(code);
    const fetchedAt = seoulIso(this.now());
    await db
      .insertInto("quote_cache")
      .values({ code, payload: JSON.stringify(quote), fetched_at: fetchedAt })
      .onConflict((oc) => oc.column("code").doUpdateSet({ payload: JSON.stringify(quote), fetched_at: fetchedAt }))
      .execute();
    return quote;
  }

  getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    return this.deps.quotes.getCandles(code, period, count);
  }
}

function toRegistered(r: {
  code: string; name: string; market: string; quantity: number | null; avg_price: number | null;
  memo: string | null; created_at: string; updated_at: string;
}): RegisteredStock {
  return {
    code: r.code,
    name: r.name,
    market: toMarket(r.market),
    quantity: r.quantity,
    avgPrice: r.avg_price,
    memo: r.memo,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function evaluate(s: RegisteredStock, q: Quote | null): RegisteredWithQuote["evaluation"] {
  if (!q || s.quantity === null || s.avgPrice === null || s.quantity <= 0) return null;
  const marketValue = q.price * s.quantity;
  const costBasis = s.avgPrice * s.quantity;
  const profit = marketValue - costBasis;
  return {
    marketValue,
    costBasis,
    profit,
    profitRate: costBasis > 0 ? Math.round((profit / costBasis) * 10000) / 100 : 0,
  };
}
