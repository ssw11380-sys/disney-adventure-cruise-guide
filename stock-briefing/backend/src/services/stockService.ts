import { EXCLUDED_KEY, parseCodes, SNAPSHOT_KEY, type TossHoldingDetail } from "./tossSyncService.js";
import { KrwCostBook, type KrwCost } from "./krwCostBook.js";
import { CandleCache } from "./candleCache.js";
import { marketContext } from "./marketContext.js";
import type { Db } from "../db/index.js";
import type { CandlePeriod, CandleSeries, ListedStock, Quote, RegisteredStock } from "../domain/types.js";
import { CODE_RE, isKrCode, normalizeCode } from "../lib/codes.js";
import { mapLimit } from "../lib/concurrency.js";
import { holdingsWriteLock } from "../lib/mutex.js";
import { ConflictError, NotFoundError, ProviderError, TossLockedError, within } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { toMarket } from "../providers/market/kisMaster.js";
import { localDate } from "../providers/market/tossOpenApi.js";
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
  /** 공식 API 소스 (기준가 폴백 횟수를 /health 에 보이려고). 있으면 토스 연동 종목 잠금도 켠다 */
  tossOpenApi?: { baseFallbacks: number } | null;
  /** 토스 자동 동기화 주기(분). 0 이면 동기화가 없으니 잠그지 않는다 */
  tossSyncMinutes?: number;
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

/** 캐시가 없는 종목이 있을 때(첫 실행) 새로 받기를 기다리는 최대 시간. 넘으면 있는 것만으로 답한다 */
const COLD_WAIT_MS = 1_200;
/** 실시간(토스 웹 일괄) 가격을 기다리는 최대 시간. 넘으면 직전에 받은 값(QUICK_MAX_AGE_MS 안)으로 */
const QUICK_WAIT_MS = 150;
/** 직전에 받은 일괄 가격을 이만큼까지는 쓴다 (앱은 3초마다 묻는다) */
const QUICK_MAX_AGE_MS = 30_000;
/** 새로 받기가 실패한 종목은 이만큼 쉬었다가 다시 (출처가 죽었을 때 3초 폴링마다 두드리지 않게) */
const RETRY_AFTER_FAIL_MS = 20_000;
/** 새로 받지 못한 채 이보다 오래된 값은 stale 로 본다. 이보다 오래된 캐시로 답해야 할 때는 새로 받기를 잠깐(COLD_WAIT_MS) 기다린다 */
const STALE_AFTER_MS = 3 * 60_000;
/** 실시간 체결가가 이 안에 들어왔을 때만 "지연 아님"으로 본다 */
const TICK_FRESH_MS = 60_000;
/** 밸류에이션·환율 보강을 기다리는 최대 시간 (넘으면 보강 없이 시세만 저장) */
const ENRICH_WAIT_MS = 3_000;

/** 스냅샷과 체결이 같은 거래일인지 (한국은 서울, 미국은 뉴욕 날짜) */
function sameTradingDay(q: Quote, tickIso: string): boolean {
  const a = Date.parse(q.asOf), b = Date.parse(tickIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  const kr = isKrCode(q.code);
  return localDate(q.asOf, kr) === localDate(tickIso, kr);
}
const TOSS_DETAIL_KEY = "toss_holdings_detail";

interface Held {
  quote: Quote;
  at: number;
  failedAt: number;
}

function parseTossDetail(value: string | null): Map<string, TossHoldingDetail> {
  if (!value) return new Map();
  try {
    const parsed = JSON.parse(value) as { items?: Record<string, TossHoldingDetail> };
    return new Map(Object.entries(parsed.items ?? {}));
  } catch {
    return new Map();
  }
}

/**
 * 잠금 밖(연동 꺼짐·동기화 멈춤)에서 사용자가 수량·평단을 직접 넣으면 그 종목의 옛 토스 평가 기준을 지운다.
 * 안 그러면 수량만 같을 때 옛 토스 매입금액으로 손익을 내 직접 넣은 평단이 무시된다. 원화 장부는 이 기준이 있을 때만 쓰므로
 * 장부 자체는 두고(다시 연동되면 그대로 쓴다) 여기서만 뺀다. syncedAt 은 그대로 → 잠금 판단은 바뀌지 않고, 다음 동기화가 다시 채운다
 */
async function forgetTossDetail(db: Db, code: string): Promise<void> {
  const row = await db.selectFrom("meta").select("value").where("key", "=", TOSS_DETAIL_KEY).executeTakeFirst();
  if (!row) return;
  let parsed: { items?: Record<string, TossHoldingDetail> } | null;
  try {
    parsed = JSON.parse(row.value) as { items?: Record<string, TossHoldingDetail> } | null;
  } catch {
    return;
  }
  if (!parsed?.items || !Object.hasOwn(parsed.items, code)) return;
  delete parsed.items[code];
  await db.updateTable("meta").set({ value: JSON.stringify(parsed) }).where("key", "=", TOSS_DETAIL_KEY).execute();
}

export interface RegisteredWithQuote extends RegisteredStock {
  quote: Quote | null;
  quoteError: string | null;
  /** 보유 정보가 있을 때만 계산 */
  evaluation: Evaluation | null;
}


export class StockService {
  private readonly now: () => Date;
  private readonly candleCache: CandleCache;
  private readonly ttl: number;
  /** 현재가 메모리 캐시 (DB quote_cache 와 같은 값). at = 새로 받은 시각, failedAt = 그 뒤 마지막 새로 받기 실패 시각 */
  private readonly book = new Map<string, Held>();
  private readonly quoteErrors = new Map<string, string>();
  /** 종목별 마지막 새로 받기 실패 시각 (캐시가 없는 종목 포함) */
  private readonly failedAt = new Map<string, number>();
  /** 토스 웹 일괄 가격을 마지막으로 받은 값 (종목별) */
  private readonly quickLast = new Map<string, LiveTick>();
  private readonly inflight = new Map<string, Promise<void>>();
  private hydrated: Promise<void> | null = null;
  /** 마지막 잔고 요청의 종목 (/health 지연 수 세기용) */
  private listCodes: string[] = [];
  private readonly stats = { refreshes: 0, failures: 0, cacheWriteErrors: 0, lastRefreshAt: null as string | null, lastRefreshMs: null as number | null };

  constructor(private readonly deps: StockServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.ttl = deps.quoteCacheTtlMs ?? 60_000;
    this.candleCache = new CandleCache((c, p, n) => deps.quotes.getCandles(c, p, n), () => this.now().getTime(), candleSession);
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
        const remote = await this.remoteSearch(q, limit);
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
      const remote = await this.remoteSearch(q, limit);
      const seen = new Set(local.map((s) => s.code));
      const merged = [...local, ...remote.filter((r) => !seen.has(r.code))].slice(0, limit);
      return { results: merged, source: local.length ? `master+${this.deps.search.name}` : this.deps.search.name };
    } catch (e) {
      if (e instanceof ProviderError) return { results: local, source: local.length ? "master" : "none" };
      throw e;
    }
  }

  /** 외부 검색 결과 (1분 캐시: 같은 말을 다시 치거나 지웠다 다시 쳐도 바로, 3-18). 빈 결과는 담지 않는다(일시 장애일 수 있음) */
  private readonly searchCache = new Map<string, { at: number; results: ListedStock[] }>();
  private async remoteSearch(q: string, limit: number): Promise<ListedStock[]> {
    const key = `${q.replace(/\s+/g, " ").toUpperCase()}|${limit}`;
    const t = this.now().getTime();
    const hit = this.searchCache.get(key);
    if (hit && t - hit.at < 60_000) return hit.results;
    const results = await this.deps.search.search(q, limit);
    if (results.length === 0) return results;
    this.searchCache.delete(key);
    this.searchCache.set(key, { at: t, results });
    if (this.searchCache.size > 500) this.searchCache.delete(this.searchCache.keys().next().value!);
    return results;
  }

  /** 종목 마스터만 검색 (외부 검색 없이 바로) */
  async searchMaster(query: string, limit = 20): Promise<{ results: ListedStock[]; source: string }> {
    const compact = query.trim().replace(/\s+/g, "");
    if (!compact) return { results: [], source: "none" };
    const results = await this.searchLocal(compact, limit);
    return { results, source: results.length ? "master" : "none" };
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

  register(input: RegisterInput): Promise<RegisteredStock> {
    return holdingsWriteLock.run(() => this.registerNow(input));
  }

  private async registerNow(input: RegisterInput): Promise<RegisteredStock> {
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
    // 동기화에서 뺐던 종목을 다시 등록하면 다시 토스 계좌에서 맞춘다 (등록이 된 뒤에)
    await this.setExcluded(listed.code, false);
    // 잠금 밖에서 지웠다가 다시 등록한 종목도 직접 넣은 수량·평단으로 평가 (잠긴 종목은 다음 동기화가 토스 값으로 맞춘다)
    if (!(await this.tossSynced()).has(listed.code)) await forgetTossDetail(this.deps.db, listed.code);
    void this.refreshQuotes([listed.code]); // 등록 직후 잔고 화면이 시세를 기다리지 않게 바로 받기 시작
    await this.syncLive();
    return (await this.get(listed.code))!;
  }

  /** 등록 종목 전체를 실시간 구독 목록으로 넘긴다 (기동 시, 등록/삭제/가져오기 후) */
  async syncLive(): Promise<void> {
    if (!this.deps.live) return;
    const codes = (await this.list()).map((s) => s.code);
    this.deps.live.setCodes(codes);
  }

  update(code: string, input: UpdateInput): Promise<RegisteredStock> {
    return holdingsWriteLock.run(() => this.updateNow(code, input));
  }

  private async updateNow(code: string, input: UpdateInput): Promise<RegisteredStock> {
    const current = await this.get(code);
    if (!current) throw new NotFoundError(`등록되지 않은 종목입니다: ${code}`);
    const changesHolding =
      (input.quantity !== undefined && input.quantity !== current.quantity) || (input.avgPrice !== undefined && input.avgPrice !== current.avgPrice);
    if (changesHolding && (await this.tossSynced()).has(code))
      throw new TossLockedError("토스 계좌에서 자동으로 맞추는 종목이라 수량·평단은 바꿀 수 없습니다. 메모는 바꿀 수 있습니다. 이 종목을 앱에서 빼려면 삭제하세요 (토스 동기화에서도 빠집니다).");
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("registered_stocks")
        .set({
          quantity: input.quantity === undefined ? current.quantity : input.quantity,
          avg_price: input.avgPrice === undefined ? current.avgPrice : input.avgPrice,
          memo: input.memo === undefined ? current.memo : input.memo,
          updated_at: seoulIso(this.now()),
        })
        .where("code", "=", code)
        .execute();
      // 직접 고친 수량·평단으로 평가 (메모만 고치면 토스 기준 그대로)
      if (changesHolding) await forgetTossDetail(trx, code);
    });
    return (await this.get(code))!;
  }

  /** 삭제. 토스 계좌에서 맞추는 종목이면 동기화에서도 뺀다 (안 그러면 10분 뒤 다시 나타난다) */
  remove(code: string): Promise<{ tossExcluded: boolean }> {
    return holdingsWriteLock.run(() => this.removeNow(code));
  }

  private async removeNow(code: string): Promise<{ tossExcluded: boolean }> {
    const synced = (await this.tossSynced()).has(code);
    const r = await this.deps.db.deleteFrom("registered_stocks").where("code", "=", code).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) throw new NotFoundError(`등록되지 않은 종목입니다: ${code}`);
    if (synced) await this.setExcluded(code, true);
    await this.syncLive();
    return { tossExcluded: synced };
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
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", TOSS_DETAIL_KEY).executeTakeFirst();
    return parseTossDetail(row?.value ?? null);
  }

  /** 평가에 쓰는 두 가지(토스 평가 기준·원화 장부)를 쿼리 1번으로 */
  async holdingMeta(): Promise<{ detail: Map<string, TossHoldingDetail>; krw: Map<string, KrwCost>; synced: Set<string> }> {
    const rows = await this.deps.db.selectFrom("meta").select(["key", "value"]).where("key", "in", [TOSS_DETAIL_KEY, KrwCostBook.KEY, SNAPSHOT_KEY, EXCLUDED_KEY]).execute();
    const v = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
    return { detail: parseTossDetail(v(TOSS_DETAIL_KEY)), krw: KrwCostBook.summarize(KrwCostBook.parse(v(KrwCostBook.KEY))), synced: this.syncedFrom(v(SNAPSHOT_KEY), v(EXCLUDED_KEY), v(TOSS_DETAIL_KEY)) };
  }

  /**
   * 토스 계좌에서 맞추는 종목 = 마지막 동기화 때 토스에 있던 종목 − 사용자가 뺀 종목.
   * 토스 연동이 꺼져 있으면(키 없음) 잠그지 않는다
   */
  private syncedFrom(snapshot: string | null, excluded: string | null, detail: string | null): Set<string> {
    if (!this.deps.tossOpenApi || this.deps.tossSyncMinutes === 0) return new Set();
    // 동기화가 멈춘 지(3시간) 오래면 잠그지 않는다 — 옛 값에 묶여 고칠 수 없게 되지 않게
    const syncedAt = detail ? Date.parse(((): string => { try { return String((JSON.parse(detail) as { syncedAt?: string }).syncedAt ?? ""); } catch { return ""; } })()) : NaN;
    if (Number.isNaN(syncedAt) || this.now().getTime() - syncedAt > 3 * 3_600_000) return new Set();
    const ex = new Set(parseCodes(excluded));
    return new Set(parseCodes(snapshot).filter((c) => !ex.has(c)));
  }

  async tossSynced(): Promise<Set<string>> {
    const rows = await this.deps.db.selectFrom("meta").select(["key", "value"]).where("key", "in", [SNAPSHOT_KEY, EXCLUDED_KEY, TOSS_DETAIL_KEY]).execute();
    const v = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
    return this.syncedFrom(v(SNAPSHOT_KEY), v(EXCLUDED_KEY), v(TOSS_DETAIL_KEY));
  }

  private async setExcluded(code: string, on: boolean): Promise<void> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", EXCLUDED_KEY).executeTakeFirst();
    const set = new Set(parseCodes(row?.value));
    if (on === set.has(code)) return;
    if (on) set.add(code);
    else set.delete(code);
    const value = JSON.stringify([...set].sort());
    await this.deps.db.insertInto("meta").values({ key: EXCLUDED_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }

  /**
   * 잔고 목록 + 현재가. 요청은 기다리지 않는다:
   *  - 현재가는 메모리의 마지막 값(없으면 DB 캐시)으로 바로 답하고, 오래됐으면(ttl) 뒤에서 한 번에 새로 받는다(single-flight)
   *  - 캐시가 아예 없는 종목이 있을 때만(첫 실행) 새로 받기를 잠깐(COLD_WAIT_MS) 기다린다
   *  - 새로 받기가 실패하면 마지막 값을 버리지 않고 stale 표시로 내보낸다 → 보유 종목이 "관심"으로 빠지거나 총평가가 줄지 않는다
   * DB 쿼리: 등록 종목 1 + meta 1 (첫 호출만 캐시 읽기 1 추가)
   */
  async listWithQuotes(): Promise<RegisteredWithQuote[]> {
    const [stocks, meta] = await Promise.all([this.list(), this.holdingMeta(), this.hydrate()]);
    const codes = stocks.map((s) => s.code);
    this.listCodes = codes;
    const quickP = this.quickNow(codes);
    const t = this.now().getTime();
    const expired = codes.filter((c) => this.due(c, t));
    if (expired.length) {
      const p = this.refreshQuotes(expired);
      // 캐시가 없거나 오래된(밤새 쉬었다 연 경우 등) 종목이 있으면 잠깐 기다린다 — 어제 스냅샷에 오늘 체결가를 섞어 보여 주지 않게
      if (expired.some((c) => this.old(c, t))) await within(p, COLD_WAIT_MS, undefined);
    }
    const quick = await quickP;
    return stocks.map((s) => {
      const quote = this.current(s.code, quick);
      const quoteError = quote ? null : (this.quoteErrors.get(s.code) ?? "시세를 불러오는 중입니다");
      return { ...s, tossSynced: meta.synced.has(s.code), quote, quoteError, evaluation: evaluate(s, quote, meta.detail.get(s.code), meta.krw.get(s.code)) };
    });
  }

  /**
   * 일괄 가격: 새로 받기를 시작하고 짧게(QUICK_WAIT_MS)만 기다린다. 늦으면 직전에 받은 값으로 답하고,
   * 받은 값은 다음 요청에서 쓴다 → 토스 웹이 느려도 잔고 응답이 그만큼 늦어지지 않는다
   */
  private async quickNow(codes: string[]): Promise<Map<string, LiveTick>> {
    const src = this.deps.quickPrices;
    if (!src || codes.length === 0) return new Map();
    const fetched = src
      .getMany(codes)
      .then((m) => {
        for (const [c, tick] of m) this.quickLast.set(c, tick);
        return true;
      })
      .catch(() => false);
    await within(fetched, QUICK_WAIT_MS, false);
    const t = this.now().getTime();
    const out = new Map<string, LiveTick>();
    for (const c of codes) {
      const tick = this.quickLast.get(c);
      if (tick && t - Date.parse(tick.timestamp) <= QUICK_MAX_AGE_MS) out.set(c, tick);
    }
    return out;
  }

  // ── 시세 ────────────────────────────────────────────────────────

  /**
   * 한 종목 현재가 (상세 화면·/quote). 캐시가 ttl 안이면 그대로, 오래됐으면 마지막 값으로 답하고 뒤에서 새로 받는다.
   * 캐시가 없거나 fresh 면 새로 받을 때까지 기다린다. 새로 받지 못하면 마지막 값(stale), 그것도 없으면 던진다
   */
  async getQuote(code: string, opts: { fresh?: boolean; quick?: Map<string, LiveTick> } = {}): Promise<Quote> {
    await this.hydrate();
    const quickP = opts.quick ? Promise.resolve(opts.quick) : this.deps.live?.get(code) ? Promise.resolve(new Map<string, LiveTick>()) : this.quickNow([code]);
    const h = this.book.get(code);
    const t = this.now().getTime();
    if (h && !opts.fresh) {
      if (this.due(code, t)) {
        const p = this.refreshQuotes([code]);
        if (this.old(code, t)) await within(p, COLD_WAIT_MS, undefined);
      }
    } else {
      await this.refreshQuotes([code]);
    }
    const q = this.current(code, await quickP);
    if (!q) throw new ProviderError(this.deps.quotes.name, this.quoteErrors.get(code) ?? `${code} 시세 없음`);
    return q;
  }

  /** 현재가를 새로 받은 뒤(최대 8초) 잔고 목록 — 토스 대조처럼 지금 값이 필요할 때 */
  async listWithFreshQuotes(): Promise<RegisteredWithQuote[]> {
    await this.hydrate();
    const codes = (await this.list()).map((s) => s.code);
    if (codes.length) await within(this.refreshQuotes(codes), 8_000, undefined);
    return this.listWithQuotes();
  }

  /** 기동 직후: DB 캐시를 메모리로 올리고 등록 종목 현재가를 한 번 받아 둔다 (첫 요청이 기다리지 않게) */
  async warmQuotes(): Promise<void> {
    await this.hydrate();
    const codes = (await this.list()).map((s) => s.code);
    this.listCodes = codes; // /health 지연 수를 첫 잔고 요청 전에도 셀 수 있게
    if (codes.length) await this.refreshQuotes(codes);
  }

  /** 운영 확인용 (/health) */
  quoteStatus(): { cached: number; stale: number; refreshing: number; refreshes: number; failures: number; cacheWriteErrors: number; lastRefreshAt: string | null; lastRefreshMs: number | null; baseFallbacks: number | null } {
    const t = this.now().getTime();
    let stale = 0;
    // 잔고에 보이는 종목만 센다 (발견 탭에서 한 번 본 종목 등 캐시에만 남은 것은 제외)
    for (const code of this.listCodes) {
      const h = this.book.get(code);
      if (h && this.isStale(code, h, t)) stale++;
    }
    return { cached: this.book.size, stale, refreshing: this.inflight.size, ...this.stats, baseFallbacks: this.deps.tossOpenApi?.baseFallbacks ?? null };
  }

  private hydrate(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = this.deps.db
        .selectFrom("quote_cache")
        .selectAll()
        .execute()
        .then((rows) => {
          for (const r of rows) {
            if (this.book.has(r.code)) continue;
            const at = Date.parse(r.fetched_at);
            try {
              this.book.set(r.code, { quote: JSON.parse(r.payload) as Quote, at: Number.isNaN(at) ? 0 : at, failedAt: 0 });
            } catch {
              /* 깨진 행은 건너뜀 */
            }
          }
        })
        .catch(() => {
          this.hydrated = null; // 다음 요청에서 다시
        });
    }
    return this.hydrated ?? Promise.resolve();
  }

  /** 여러 종목을 한 번에 새로 받는다. 이미 받는 중인 종목은 그 작업을 같이 기다린다 (single-flight) */
  private refreshQuotes(codes: string[]): Promise<void> {
    const need = [...new Set(codes)].filter((c) => !this.inflight.has(c));
    if (need.length) {
      const p: Promise<void> = this.fetchQuotes(need)
        .catch(() => undefined)
        .finally(() => {
          for (const c of need) if (this.inflight.get(c) === p) this.inflight.delete(c);
        });
      for (const c of need) this.inflight.set(c, p);
    }
    return Promise.all(codes.map((c) => this.inflight.get(c))).then(() => undefined);
  }

  private async fetchQuotes(codes: string[]): Promise<void> {
    const started = performance.now();
    const chain = this.deps.quotes;
    let results: Map<string, Quote | Error>;
    try {
      results = chain.getQuotes
        ? await chain.getQuotes(codes)
        : new Map(await mapLimit(codes, 4, async (c) => [c, await chain.getQuote(c).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))] as const));
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      results = new Map(codes.map((c) => [c, err]));
    }
    const ok = codes.flatMap((c) => {
      const r = results.get(c);
      return r && !(r instanceof Error) ? [[c, r] as const] : [];
    });
    const markets = ok.length ? await this.marketsOf(ok.map(([c]) => c)).catch(() => new Map<string, string>()) : new Map<string, string>();
    // 보강(네이버)이 멈춰도 새 시세는 저장한다
    const enriched = await mapLimit(ok, 4, async ([c, q]) => [c, await within(this.enrich(q, markets.get(c) ?? null), ENRICH_WAIT_MS, q)] as const);
    const t = this.now().getTime();
    const fetchedAt = seoulIso(this.now());
    for (const [c, q] of enriched) {
      this.book.set(c, { quote: q, at: t, failedAt: 0 });
      this.quoteErrors.delete(c);
      this.failedAt.delete(c);
    }
    let failures = 0;
    for (const c of codes) {
      const r = results.get(c);
      if (r instanceof Error || !r) {
        failures++;
        this.quoteErrors.set(c, r instanceof Error ? r.message : `${c} 시세 없음`);
        this.failedAt.set(c, t);
        const h = this.book.get(c);
        if (h) h.failedAt = t;
      }
    }
    if (enriched.length) {
      await this.deps.db
        .insertInto("quote_cache")
        .values(enriched.map(([c, q]) => ({ code: c, payload: JSON.stringify(q), fetched_at: fetchedAt })))
        .onConflict((oc) => oc.column("code").doUpdateSet((eb) => ({ payload: eb.ref("excluded.payload"), fetched_at: eb.ref("excluded.fetched_at") })))
        .execute()
        .catch(() => {
          this.stats.cacheWriteErrors++; // 캐시 저장 실패는 메모리 값으로 계속 (/health 에서 확인)
        });
    }
    this.stats.refreshes++;
    this.stats.failures += failures;
    this.stats.lastRefreshAt = fetchedAt;
    this.stats.lastRefreshMs = Math.round(performance.now() - started);
  }

  private async marketsOf(codes: string[]): Promise<Map<string, string>> {
    const rows = await this.deps.db.selectFrom("registered_stocks").select(["code", "market"]).where("code", "in", codes).execute();
    return new Map(rows.map((r) => [r.code, r.market]));
  }

  /** 캐시가 없거나 STALE_AFTER_MS 보다 오래됐는지 (이때만 응답이 새로 받기를 잠깐 기다린다) */
  private old(code: string, t: number): boolean {
    const h = this.book.get(code);
    return !h || t - h.at > STALE_AFTER_MS;
  }

  /** 새로 받을 때인지: 캐시가 없거나 ttl 이 지났고, 최근(RETRY_AFTER_FAIL_MS) 실패하지 않았음 */
  private due(code: string, t: number): boolean {
    const h = this.book.get(code);
    if (h && t - h.at < this.ttl) return false;
    return t - (this.failedAt.get(code) ?? -Infinity) >= RETRY_AFTER_FAIL_MS;
  }

  /** 새로 받지 못한 마지막 값인지: 마지막 새로 받기가 실패했거나, 오래됐는데 받는 중도 아님 */
  private isStale(code: string, h: Held, t: number): boolean {
    return h.failedAt > h.at || (t - h.at > STALE_AFTER_MS && !this.inflight.has(code));
  }

  /** 캐시 값 + 실시간 가격. 새 체결가로 덮어쓰지 못하고 캐시도 새로 받지 못했으면 stale 표시 */
  private current(code: string, quick?: Map<string, LiveTick>): Quote | null {
    const h = this.book.get(code);
    if (!h) return null;
    const t = this.now().getTime();
    let tick = this.liveTick(h.quote, quick);
    // 스냅샷(asOf)과 체결의 거래일(현지 날짜)이 다르면 섞지 않는다 — 어제 스냅샷의 전일 종가에 오늘 체결을 대면 등락이 이틀치가 된다.
    // 스냅샷을 새로 받으면(1분 안) 같은 날이 되어 다시 붙는다
    if (tick && !sameTradingDay(h.quote, tick.timestamp)) tick = null;
    const q = tick ? this.applyTick(h.quote, tick) : h.quote;
    const tickFresh = tick !== null && Math.abs(t - tick.receivedAt) <= TICK_FRESH_MS;
    const stale = !tickFresh && this.isStale(code, h, t);
    return stale ? { ...q, stale: true } : q.stale ? { ...q, stale: false } : q;
  }

  /** 밸류에이션(PER/PBR/EPS/BPS/배당/52주)과 달러 환율을 채운다. 실패해도 시세는 그대로 */
  private async enrich(quote: Quote, market: string | null): Promise<Quote> {
    const f = this.deps.fundamentals;
    if (!f) return quote;
    const needFundamentals = quote.per === null || quote.pbr === null || quote.dividendYieldPct === undefined;
    const [fund, fx] = await Promise.all([
      needFundamentals ? f.get(quote.code, market).catch(() => null) : Promise.resolve(null),
      quote.currency === "USD" ? f.usdKrw().catch(() => null) : Promise.resolve(null),
    ]);
    let out = applyFundamentals(quote, fund);
    if (quote.currency === "USD") {
      const rate = fx ?? (quote.priceKrw && quote.price ? Math.round((quote.priceKrw / quote.price) * 100) / 100 : null);
      // 원화 환산은 함께 보여 주는 환율(fxRate)로 — 공급자가 준 값(공식 API 매매기준율 등)과 섞이면 같은 화면에서 숫자가 어긋난다
      out = { ...out, fxRate: rate, priceKrw: rate ? Math.round(out.price * rate) : (out.priceKrw ?? null) };
    }
    return out;
  }

  /**
   * 덮어쓸 체결가. 1순위 웹소켓 체결, 2순위 REST 일괄 조회.
   * REST 일괄 조회는 토스 통합 가격이라 같은 기준(toss 계열)의 스냅샷에만 적용한다 — 네이버 정규장 종가에 섞이면 등락이 틀어진다.
   * 스냅샷보다 오래된 체결은 쓰지 않는다
   */
  private liveTick(quote: Quote, quick?: Map<string, LiveTick>): LiveTick | null {
    let tick = this.deps.live?.get(quote.code) ?? null;
    if (!tick && quick && quote.source.startsWith("toss")) tick = quick.get(quote.code) ?? null;
    if (!tick) return null;
    const tickAt = Date.parse(tick.timestamp);
    const quoteAt = Date.parse(quote.asOf);
    if (Number.isNaN(tickAt) || (!Number.isNaN(quoteAt) && tickAt < quoteAt)) return null;
    return tick;
  }

  private applyTick(quote: Quote, tick: LiveTick): Quote {
    if (tick.price === quote.price) return quote;
    const prevClose = quote.prevClose ?? (quote.change ? quote.price - quote.change : null);
    const change = prevClose !== null ? Math.round((tick.price - prevClose) * 100) / 100 : quote.change;
    const changeRate = prevClose ? Math.round((change / prevClose) * 10000) / 100 : quote.changeRate;
    // 원화 환산은 화면에 함께 보이는 환율(fxRate)로 — 옛 원화가/달러가 비율로 곱하면 반올림 때문에 1원씩 어긋난다
    const priceKrw = quote.fxRate ? Math.round(tick.price * quote.fxRate) : quote.priceKrw && quote.price ? Math.round((quote.priceKrw / quote.price) * tick.price) : (quote.priceKrw ?? null);
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

  /** 차트 봉 (캐시: 같은 종목·주기를 다시 열면 바로, 3-18) */
  getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    return this.candleCache.get(normalizeCode(code), period, count);
  }

  /** 기동 뒤: 등록 종목의 기본 차트(일봉 800개)를 한 종목씩 미리 받아 둔다 (처음 여는 차트도 기다리지 않게). 실패는 무시, 종목 사이 gapMs 쉼 */
  async warmCandles(codes?: string[], count = 800, gapMs = 300): Promise<void> {
    for (const code of codes ?? (await this.list()).map((s) => s.code)) {
      await this.candleCache.get(normalizeCode(code), "D", count).catch(() => undefined);
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  candleStatus() {
    return { ...this.candleCache.stats };
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
  // (잠금 밖에서 수량·평단을 직접 고친 종목은 update 가 토스 기준을 지워 toss 가 넘어오지 않는다 → 평단만 고쳐도 직접 계산)
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
    // 원화 장부도 토스 기준을 쓸 때만 (직접 넣은 평단에 옛 원화 매입금액을 붙이지 않게)
    ...(q.currency === "USD" ? krwBasis(s.quantity, q, t, t ? krwCost : null) : { costBasisKrw: null, krwCostSource: null }),
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

/** 차트 캐시용 장 구간: 시장·단계·마지막 정규장·현지 날짜가 같을 때만 옛 봉을 쓴다 (달력 조회 없이 시계로) */
function candleSession(code: string, at: number): { key: string; regular: boolean } {
  const now = new Date(at);
  const ctx = marketContext(code, null, now);
  const date = now.toLocaleDateString("en-CA", { timeZone: ctx.market === "KR" ? "Asia/Seoul" : "America/New_York" });
  return { key: `${ctx.market}|${ctx.phase}|${ctx.todayIncomplete}|${ctx.lastRegularDate}|${date}`, regular: ctx.phase === "regular" };
}
