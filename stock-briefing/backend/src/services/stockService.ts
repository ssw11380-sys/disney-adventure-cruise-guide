import type { TossHoldingDetail } from "./tossSyncService.js";
import { KrwCostBook, type KrwCost } from "./krwCostBook.js";
import type { Db } from "../db/index.js";
import type { CandlePeriod, CandleSeries, ListedStock, Quote, RegisteredStock } from "../domain/types.js";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { ConflictError, NotFoundError, ProviderError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { toMarket } from "../providers/market/kisMaster.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "../providers/market/types.js";
import { applyFundamentals, type NaverFundamentals } from "../providers/market/fundamentals.js";
import type { LiveTick, LiveTicks, QuickPriceSource } from "../providers/market/tossRealtime.js";

export interface StockServiceDeps {
  db: Db;
  quotes: QuoteProvider;
  search: StockSearchProvider;
  master: MasterProvider;
  /** true 면 외부 검색(토스)을 먼저 쓰고 로컬 마스터는 보조/폴백으로 쓴다 */
  searchRemoteFirst?: boolean;
  /** 실시간 체결(웹소켓). 있으면 현재가에 마지막 체결가를 덮어쓰고, 등록 종목이 바뀌면 구독을 갱신한다 */
  live?: LiveTicks | null;
  /** 웹소켓이 없을 때 REST 로 여러 종목 현재가를 한 번에 받아 덮어쓴다 (같은 가격 기준의 시세에만) */
  quickPrices?: QuickPriceSource | null;
  /** PER/PBR/배당/52주·환율 보강 (토스 시세에는 없음) */
  fundamentals?: NaverFundamentals | null;
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
  evaluation: Evaluation | null;
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

  /**
   * 등록하지 않은 종목을 상세 화면에서 미리 보기 위한 가상 항목 (발견 탭 등에서 누른 종목).
   * 종목 마스터(없으면 외부 검색)에서 이름·시장을 찾는다. 모르는 코드면 null.
   */
  async preview(code: string): Promise<RegisteredStock | null> {
    try {
      const listed = await this.resolveListed(normalizeCode(code));
      return { code: listed.code, name: listed.name, market: listed.market, quantity: null, avgPrice: null, memo: null, createdAt: "", updatedAt: "" };
    } catch {
      return null;
    }
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
    await this.syncLive();
    return (await this.get(listed.code))!;
  }

  /** 등록 종목 전체를 실시간 구독 목록으로 넘긴다 (기동 시, 등록/삭제/가져오기 후) */
  async syncLive(): Promise<void> {
    if (!this.deps.live) return;
    const codes = (await this.list()).map((s) => s.code);
    this.deps.live.setCodes(codes);
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
    await this.syncLive();
  }

  async get(code: string): Promise<RegisteredStock | null> {
    const r = await this.deps.db.selectFrom("registered_stocks").selectAll().where("code", "=", code).executeTakeFirst();
    return r ? toRegistered(r) : null;
  }

  async list(): Promise<RegisteredStock[]> {
    const rows = await this.deps.db.selectFrom("registered_stocks").selectAll().orderBy("created_at", "asc").execute();
    return rows.map(toRegistered);
  }

  /** 해외 종목 원화 매입금액 장부 (토스 원화 손익 기준, 종목별 계좌 합산). 없으면 빈 맵 */
  async krwCosts(): Promise<Map<string, KrwCost>> {
    return KrwCostBook.summarize(await KrwCostBook.read(this.deps.db));
  }

  /** 토스 동기화 때 저장한 종목별 평가 기준(매입금액·예상 비용 비율). 없으면 빈 맵 */
  async tossDetail(): Promise<Map<string, TossHoldingDetail>> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", "toss_holdings_detail").executeTakeFirst();
    if (!row) return new Map();
    try {
      const parsed = JSON.parse(row.value) as { items?: Record<string, TossHoldingDetail> };
      return new Map(Object.entries(parsed.items ?? {}));
    } catch {
      return new Map();
    }
  }

  async listWithQuotes(): Promise<RegisteredWithQuote[]> {
    const stocks = await this.list();
    const [detail, krw] = await Promise.all([this.tossDetail(), this.krwCosts()]);
    // 등록 종목 전체의 최신 가격을 요청 1개로 미리 받아 둔다 (없거나 실패해도 스냅샷으로 진행)
    const quick = await this.quickPrices(stocks.map((s) => s.code));
    // 소스 rate limit 을 고려해 순차 조회
    const out: RegisteredWithQuote[] = [];
    for (const s of stocks) {
      let quote: Quote | null = null;
      let quoteError: string | null = null;
      try {
        quote = await this.getQuote(s.code, { quick });
      } catch (e) {
        quoteError = e instanceof Error ? e.message : String(e);
      }
      out.push({ ...s, quote, quoteError, evaluation: evaluate(s, quote, detail.get(s.code), krw.get(s.code)) });
    }
    return out;
  }

  private async quickPrices(codes: string[]): Promise<Map<string, LiveTick>> {
    if (!this.deps.quickPrices || codes.length === 0) return new Map();
    try {
      return await this.deps.quickPrices.getMany(codes);
    } catch {
      return new Map();
    }
  }

  // ── 시세 ────────────────────────────────────────────────────────

  async getQuote(code: string, opts: { fresh?: boolean; quick?: Map<string, LiveTick> } = {}): Promise<Quote> {
    const db = this.deps.db;
    const quick = opts.quick ?? (this.deps.live?.get(code) ? new Map() : await this.quickPrices([code]));
    if (!opts.fresh) {
      const cached = await db.selectFrom("quote_cache").selectAll().where("code", "=", code).executeTakeFirst();
      if (cached && this.now().getTime() - Date.parse(cached.fetched_at) < this.ttl) {
        return this.applyLive(JSON.parse(cached.payload) as Quote, quick);
      }
    }
    const quote = await this.enrich(await this.deps.quotes.getQuote(code));
    const fetchedAt = seoulIso(this.now());
    await db
      .insertInto("quote_cache")
      .values({ code, payload: JSON.stringify(quote), fetched_at: fetchedAt })
      .onConflict((oc) => oc.column("code").doUpdateSet({ payload: JSON.stringify(quote), fetched_at: fetchedAt }))
      .execute();
    return this.applyLive(quote, quick);
  }

  /** 밸류에이션(PER/PBR/EPS/BPS/배당/52주)과 달러 환율을 채운다. 실패해도 시세는 그대로 */
  private async enrich(quote: Quote): Promise<Quote> {
    const f = this.deps.fundamentals;
    if (!f) return quote;
    const needFundamentals = quote.per === null || quote.pbr === null || quote.dividendYieldPct === undefined;
    const market = (await this.get(quote.code))?.market ?? null;
    const [fund, fx] = await Promise.all([
      needFundamentals ? f.get(quote.code, market).catch(() => null) : Promise.resolve(null),
      quote.currency === "USD" ? f.usdKrw().catch(() => null) : Promise.resolve(null),
    ]);
    let out = applyFundamentals(quote, fund);
    if (quote.currency === "USD") {
      const rate = fx ?? (quote.priceKrw && quote.price ? Math.round((quote.priceKrw / quote.price) * 100) / 100 : null);
      out = { ...out, fxRate: rate, priceKrw: out.priceKrw ?? (rate ? Math.round(out.price * rate) : null) };
    }
    return out;
  }

  /**
   * 현재가 덮어쓰기. 1순위 웹소켓 체결, 2순위 REST 일괄 조회.
   * REST 일괄 조회는 토스 통합 가격이라 같은 기준(toss 계열)의 스냅샷에만 적용한다 — 네이버 정규장 종가에 섞이면 등락이 틀어진다.
   */
  private applyLive(quote: Quote, quick?: Map<string, LiveTick>): Quote {
    let tick = this.deps.live?.get(quote.code) ?? null;
    if (!tick && quick && quote.source.startsWith("toss")) tick = quick.get(quote.code) ?? null;
    if (!tick) return quote;
    const tickAt = Date.parse(tick.timestamp);
    const quoteAt = Date.parse(quote.asOf);
    if (Number.isNaN(tickAt) || (!Number.isNaN(quoteAt) && tickAt < quoteAt) || tick.price === quote.price) return quote;
    const prevClose = quote.prevClose ?? (quote.change ? quote.price - quote.change : null);
    const change = prevClose !== null ? Math.round((tick.price - prevClose) * 100) / 100 : quote.change;
    const changeRate = prevClose ? Math.round((change / prevClose) * 10000) / 100 : quote.changeRate;
    const priceKrw = quote.priceKrw && quote.price ? Math.round((quote.priceKrw / quote.price) * tick.price) : quote.fxRate ? Math.round(tick.price * quote.fxRate) : (quote.priceKrw ?? null);
    return {
      ...quote,
      price: tick.price,
      change,
      changeRate,
      high: quote.high !== null ? Math.max(quote.high, tick.price) : null,
      low: quote.low !== null ? Math.min(quote.low, tick.price) : null,
      asOf: tick.timestamp,
      priceKrw,
      live: true,
    };
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

export interface Evaluation {
  marketValue: number;
  costBasis: number;
  profit: number;
  profitRate: number;
  /** 토스 기준 매도 예상 수수료·세금 비율 (토스 동기화 종목만). 앱이 실시간 가격에 곱해 "비용 차감 후" 평가를 만든다 */
  costRate: number | null;
  /** 수수료·세금 차감 후 (토스 앱 화면 기준). costRate 가 없으면 null */
  afterCost: { marketValue: number; profit: number; profitRate: number } | null;
  /** 해외 종목: 원화 매입금액(매수 당시 환율, 토스 원화 손익 기준). exact = 토스 값, estimated = 체결 시각 환율로 계산 후 계좌 합계에 보정 */
  costBasisKrw: number | null;
  krwCostSource: "exact" | "estimated" | null;
}

export function evaluate(
  s: RegisteredStock,
  q: Quote | null,
  toss?: TossHoldingDetail | null,
  krwCost?: { krw: number; source: "exact" | "estimated"; quantity: number; usdCost?: number } | null,
): Evaluation | null {
  if (!q || s.quantity === null || s.avgPrice === null || s.quantity <= 0) return null;
  // 토스에서 가져온 수량과 같을 때만 토스 기준(매입금액·비용 비율)을 쓴다. 사용자가 수량을 바꿨으면 직접 계산
  const t = toss && Math.abs(toss.quantity - s.quantity) < 1e-9 ? toss : null;
  const marketValue = q.price * s.quantity;
  const costBasis = t?.purchaseAmount ?? s.avgPrice * s.quantity;
  const profit = marketValue - costBasis;
  const pct = (p: number) => (costBasis > 0 ? Math.round((p / costBasis) * 10000) / 100 : 0);
  const costRate = t?.costRate ?? null;
  const afterValue = costRate !== null ? marketValue * (1 - costRate) : null;
  return {
    marketValue,
    costBasis,
    profit,
    profitRate: pct(profit),
    costRate,
    afterCost: afterValue !== null ? { marketValue: afterValue, profit: afterValue - costBasis, profitRate: pct(afterValue - costBasis) } : null,
    ...(q.currency === "USD" ? krwBasis(s.quantity, q, t, krwCost) : { costBasisKrw: null, krwCostSource: null }),
  };
}

/**
 * 해외 종목의 원화 매입금액. 장부 수량이 보유와 같으면 그대로.
 * 장부가 새 체결을 아직 못 따라온 동안(토스 매입금액은 이미 바뀜)에는 전체를 현재 환율로 바꾸지 않고 차이만 반영한다:
 * 늘어난 달러 매입금액은 현재 환율로 더하고, 줄었으면 비율대로 줄인다 (추정).
 */
function krwBasis(
  quantity: number,
  q: Quote,
  t: TossHoldingDetail | null,
  krwCost: { krw: number; source: "exact" | "estimated"; quantity: number; usdCost?: number } | null | undefined,
): { costBasisKrw: number | null; krwCostSource: "exact" | "estimated" | null } {
  const none = { costBasisKrw: null, krwCostSource: null };
  if (!krwCost || !(krwCost.quantity > 0)) return none;
  const usdNow = t?.purchaseAmount ?? null;
  const usdBook = krwCost.usdCost ?? null;
  const sameQty = Math.abs(krwCost.quantity - quantity) < 1e-9;
  // 수량이 같아도(같은 수량 매도 후 재매수 등) 달러 매입금액이 다르면 장부가 뒤처진 것이다
  const sameUsd = usdNow === null || usdBook === null || Math.abs(usdBook - usdNow) < Math.max(0.05, usdNow * 1e-4);
  if (sameQty && sameUsd) return { costBasisKrw: krwCost.krw, krwCostSource: krwCost.source };
  if (usdNow === null || !usdBook || !(usdBook > 0)) return none;
  if (usdNow <= usdBook) return { costBasisKrw: krwCost.krw * (usdNow / usdBook), krwCostSource: "estimated" };
  const fx = q.fxRate ?? (q.priceKrw && q.price ? q.priceKrw / q.price : null);
  return fx ? { costBasisKrw: krwCost.krw + (usdNow - usdBook) * fx, krwCostSource: "estimated" } : none;
}
