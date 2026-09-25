import { sql, type Expression, type SqlBool } from "kysely";
import { EXCLUDED_KEY, parseCodes, parseTossDetail, SNAPSHOT_KEY, tossBasisFor, type TossHoldingDetail } from "./tossSyncService.js";
import { KrwCostBook, type KrwCost } from "./krwCostBook.js";
import { CandleCache } from "./candleCache.js";
import { marketContext, tradingDate } from "./marketContext.js";
import { keepTossCalendar, realtimeOf, sessionAt, toQuoteSession, tradedInSession, type StockSession } from "./liveSession.js";
import { wsCovered } from "./priceStream.js";
import type { MarketStatus } from "../providers/market/calendar.js";
import type { Db } from "../db/index.js";
import type { CandlePeriod, CandleSeries, ListedStock, Quote, RegisteredStock } from "../domain/types.js";
import { CODE_RE, isKrCode, normalizeCode } from "../lib/codes.js";
import { mapLimit } from "../lib/concurrency.js";
import { holdingsWriteLock } from "../lib/mutex.js";
import { ConflictError, NotFoundError, ProviderError, TossLockedError, within } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { toMarket } from "../providers/market/kisMaster.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "../providers/market/types.js";
import { applyFundamentals, type NaverFundamentals } from "../providers/market/fundamentals.js";
import type { LiveTick, LiveTicks, QuickPriceSource, StockSessionFacts } from "../providers/market/tossRealtime.js";

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
  /** 장 상태(토스 달력). 있으면 종목 시세에 지금 세션과 초록 점(realtime)을 붙일 때 휴장일·조기 폐장을 안다. 없으면 요일·시각으로 */
  calendar?: { status(): Promise<MarketStatus> } | null;
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
/**
 * 거래일이 바뀌었는데(세션 시작: 한국 08:00·미국 뉴욕 20:00) 지난 거래일에 받은 스냅샷이거나, 새 거래일 체결을 보류 중이거나,
 * 지난 거래일 스냅샷과 다른 토스 웹 가격이 보이면(조용한 종목의 이번 거래일 첫 체결) ttl(1분)을 기다리지 않고 이만큼 지난 스냅샷은 다시 받는다
 * — 세션이 시작되자마자 초록 점과 새 체결이 붙게
 */
const ROLL_REFRESH_MS = 10_000;

/** 세션·초록 점 판단에 쓰는 요청 한 번의 값 (종목마다 다시 구하지 않게) */
interface SessionContext {
  now: Date;
  calendar: MarketStatus | null;
  /** 토스 웹소켓이 체결을 주고 있는 종목 (연결·최근 신호 기준). 없으면 null */
  ws: Set<string> | null;
  /** 시장별로 웹소켓이 준 마지막 체결 시각 (등록 종목 중). 이번 세션에 이 시장 체결이 왔는지 보는 데 쓴다 */
  wsTradeAt: Record<"KR" | "US", number>;
  facts: Map<string, StockSessionFacts>;
}

/** 종목 하나의 지금 세션과 웹소켓을 믿어도 되는지 (sessionView) */
interface SessionView {
  session: StockSession;
  /** 세션 시작 시각(ms). 닫혀 있으면 NaN */
  start: number;
  wsLive: boolean;
}

/** 열린 세션에서 웹소켓 체결을 가격 출처로 믿어도 되는지 따질 때 쓰는 값 (wsFollows) */
interface WsTrust {
  wsLive: boolean;
  start: number;
  now: number;
}

/** 스냅샷과 체결이 같은 거래일인지 (한국은 서울 날짜 — 08:00 전은 전날, 미국은 뉴욕 날짜 — 20:00 이후 주간거래는 다음 거래일. 앱 lib/marketTime 과 같다) */
function sameTradingDay(q: Quote, tickIso: string): boolean {
  const a = Date.parse(q.asOf), b = Date.parse(tickIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  const kr = isKrCode(q.code);
  return tradingDate(q.asOf, kr) === tradingDate(tickIso, kr);
}
const TOSS_DETAIL_KEY = "toss_holdings_detail";

/** 로컬 검색 순위의 마지막 칸: 이름 중간에 검색어가 들어 있기만 한 종목 */
const RANK_NAME_CONTAINS = 4;
/**
 * 로컬 검색 순위: 정확한 코드 → 이름 일치 → 이름 접두 → 코드 접두 → 이름 포함.
 * searchLocal 의 order by 와 같은 기준 (이름은 대문자로, ' ' 만 뺀다). upperQ 는 공백을 뺀 대문자 검색어.
 */
function localRank(upperQ: string, s: { name: string; code: string }): number {
  const n = s.name.replace(/ /g, "").toUpperCase();
  if (s.code === upperQ) return 0;
  if (n === upperQ) return 1;
  if (n.startsWith(upperQ)) return 2;
  if (s.code.startsWith(upperQ)) return 3;
  return RANK_NAME_CONTAINS;
}

interface Held {
  quote: Quote;
  at: number;
  failedAt: number;
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
  /** 토스 웹 일괄 가격이 바뀐 것을 본 때, 바뀌기 전 값을 받은 시각 (자격을 모르는 종목의 "이 세션에 체결이 있었다" 증거) */
  private readonly quickMovedAt = new Map<string, number>();
  /**
   * 토스 웹 가격이 지난 거래일 스냅샷(공식 API asOf 가 지난 거래일)과 값이 다른 것을 본 때의 그 가격과 스냅샷 (종목별).
   * 이번 거래일 첫 체결일 수 있어 붙이지 않고(전일 종가가 하루 밀려 등락이 이틀치가 될 수 있다) 그 스냅샷을 한 번 다시 받는다(rolled).
   * 다시 받아도 그대로면(두 출처의 가격 기준 차이) 같은 가격으로는 더 조르지 않는다 — 스냅샷 객체가 바뀌었는지로 본다.
   * since = 처음 본 때의 스냅샷 (가격이 바뀌어도 그대로). 그 뒤 다시 받은 스냅샷도 지난 거래일 것이면 공식 API 가 이번 거래일 체결을 모르는 것이라
   * 토스 웹 가격을 붙일 수 없다 → 가격이 따라가지 않으니 토스 웹 3초 갱신을 초록 점의 근거로 쓰지 않는다 (quickBehind)
   */
  private readonly quickAhead = new Map<string, { price: number; snapshot: Held; since: Held }>();
  /** 마지막으로 받은 장 상태 (달력 조회를 기다리지 않고 세션을 정할 때) */
  private calendarLast: MarketStatus | null = null;
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
   * 기본: 1) 로컬 마스터(코드 정확 일치 → 이름 일치·접두 → 이름 포함) 2) 비어 있으면 외부 검색.
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
      // 이름 중간에만 걸린 로컬 종목(GE → TIGER …)이 개수 제한을 채워 미국 종목을 밀어내지 않게, 외부 결과를 그 앞에 둔다
      const upperQ = compact.toUpperCase();
      const strong = local.filter((s) => localRank(upperQ, s) < RANK_NAME_CONTAINS);
      const weak = local.filter((s) => localRank(upperQ, s) >= RANK_NAME_CONTAINS);
      const seen = new Set(local.map((s) => s.code));
      const merged = [...strong, ...remote.filter((r) => !seen.has(r.code)), ...weak].slice(0, limit);
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

  /**
   * 정확한 코드 → 이름 일치 → 이름 접두 → 코드 접두 → 이름 포함 순.
   * NAVER·KT·LG 처럼 티커 모양의 영문 종목명도 있으니 코드처럼 보여도 이름 검색을 함께 한다 (DISC-05).
   * 대소문자·띄어쓰기는 무시한다 (Postgres LIKE 는 대소문자를 가리고, 검색어는 공백을 뺀 채 온다).
   */
  private async searchLocal(q: string, limit: number): Promise<ListedStock[]> {
    const upperQ = q.toUpperCase();
    const name = sql<string>`replace(upper(${sql.ref("name")}), ' ', '')`;
    const code = sql.ref<string>("code");
    // 검색어의 % _ 는 글자 그대로 찾는다 (백슬래시는 Postgres 설정에 따라 문자열에서 달리 읽혀 escape 문자로 '!' 를 쓴다)
    const pat = upperQ.replace(/[!%_]/g, "!$&");
    const like = (col: Expression<string>, pattern: string) => sql<SqlBool>`${col} like ${pattern} escape '!'`;
    const rows = await this.deps.db
      .selectFrom("listed_stocks")
      .selectAll()
      .where((eb) => eb.or([like(name, `%${pat}%`), like(code, `${pat}%`)]))
      // 개수 제한에 정확히 맞는 종목이 잘리지 않게 localRank 와 같은 순서로 먼저 줄 세운다
      .orderBy((eb) =>
        eb
          .case()
          .when(code, "=", upperQ)
          .then(0)
          .when(name, "=", upperQ)
          .then(1)
          .when(like(name, `${pat}%`))
          .then(2)
          .when(like(code, `${pat}%`))
          .then(3)
          .else(RANK_NAME_CONTAINS)
          .end(),
      )
      .limit(limit * 3)
      .execute();
    return rows
      .map((r) => ({
        code: r.code,
        name: r.name,
        market: toMarket(r.market),
        isinCode: r.isin_code,
        groupCode: r.group_code,
      }))
      .sort((a, b) => {
        const d = localRank(upperQ, a) - localRank(upperQ, b);
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
    const calendarP = this.calendarNow();
    const t = this.now().getTime();
    const expired = codes.filter((c) => this.due(c, t));
    if (expired.length) {
      const p = this.refreshQuotes(expired);
      // 캐시가 없거나 오래된(밤새 쉬었다 연 경우 등) 종목이 있으면 잠깐 기다린다 — 어제 스냅샷에 오늘 체결가를 섞어 보여 주지 않게.
      // 새 거래일 체결을 보류 중인 종목도 (스냅샷을 다시 받으면 바로 그 체결이 붙는다)
      if (expired.some((c) => this.old(c, t) || this.catchingUp(c))) await within(p, COLD_WAIT_MS, undefined);
    }
    const quick = await quickP;
    const ctx = this.sessionContext(codes, await calendarP);
    return stocks.map((s) => {
      const quote = this.current(s.code, quick, ctx);
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
        for (const [c, tick] of m) {
          const prev = this.quickLast.get(c);
          if (prev && prev.price !== tick.price && prev.receivedAt < tick.receivedAt) this.quickMovedAt.set(c, prev.receivedAt);
          this.quickLast.set(c, tick);
        }
        return true;
      })
      .catch(() => false);
    await within(fetched, QUICK_WAIT_MS, false);
    return this.quickCached(codes);
  }

  /** 마지막으로 받은 토스 웹 가격 중 QUICK_MAX_AGE_MS 안의 것 (새로 받지 않는다) */
  private quickCached(codes: string[]): Map<string, LiveTick> {
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
    // 웹소켓이 방금(1분 안) 체결을 준 종목은 토스 웹을 부르지 않는다 (받아 둔 값만 — 그 체결을 믿지 못할 때(초록 점과 같은 기준) 목록과 같은 가격이 되게).
    // 오래된 체결뿐이면(이 세션 체결을 아직 안 줌) 토스 웹 가격도 받는다
    const wsTick = this.deps.live?.get(code);
    const wsFresh = !!wsTick && Math.abs(this.now().getTime() - wsTick.receivedAt) <= TICK_FRESH_MS;
    const quickP = opts.quick ? Promise.resolve(opts.quick) : wsFresh ? Promise.resolve(this.quickCached([code])) : this.quickNow([code]);
    const calendarP = this.calendarNow();
    const h = this.book.get(code);
    const t = this.now().getTime();
    if (h && !opts.fresh) {
      if (this.due(code, t)) {
        const p = this.refreshQuotes([code]);
        if (this.old(code, t) || this.catchingUp(code)) await within(p, COLD_WAIT_MS, undefined);
      }
    } else {
      await this.refreshQuotes([code]);
    }
    const quick = await quickP;
    const q = this.current(code, quick, this.sessionContext([code], await calendarP));
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
    if (codes.length) this.deps.quickPrices?.sessionFacts?.(codes); // 세션 자격(주간거래·NXT)도 미리 받기 시작 — 첫 잔고부터 점이 맞게
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

  /**
   * 새로 받을 때인지: 캐시가 없거나 ttl 이 지났고(또는 거래일이 바뀌어 스냅샷이 지난 세션 것이 됨 — rolled), 최근(RETRY_AFTER_FAIL_MS) 실패하지 않았음
   */
  private due(code: string, t: number): boolean {
    const h = this.book.get(code);
    if (h && t - h.at < this.ttl && !this.rolled(code, h, t)) return false;
    return t - (this.failedAt.get(code) ?? -Infinity) >= RETRY_AFTER_FAIL_MS;
  }

  /** 받은 지 ROLL_REFRESH_MS 가 지났고, 그 뒤 거래일이 바뀌었거나(세션 시작) 스냅샷에 없는 새 거래일 가격이 보인다(catchingUp) */
  private rolled(code: string, h: Held, t: number): boolean {
    return t - h.at >= ROLL_REFRESH_MS && (!this.snapshotCurrent(code, h, t) || this.catchingUp(code));
  }

  /**
   * 스냅샷을 다시 받아야 새 거래일 가격이 붙는 종목: 새 거래일 웹소켓 체결을 보류 중이거나(heldTick),
   * 스냅샷을 받은 뒤 토스 웹 가격이 지난 거래일 스냅샷과 달라졌다(quickAhead — 한 번 다시 받으면 그 가격으로는 더 조르지 않는다)
   */
  private catchingUp(code: string): boolean {
    if (this.heldTick(code)) return true;
    const h = this.book.get(code);
    return !!h && this.quickAhead.get(code)?.snapshot === h;
  }

  /** 스냅샷을 받은 때가 지금과 같은 거래일인지 (한국 08:00, 미국 뉴욕 20:00 에 거래일이 바뀐다 — marketContext.tradingDate) */
  private snapshotCurrent(code: string, h: Held, t: number): boolean {
    const kr = isKrCode(code);
    return this.tradingDay(h.at, kr) === this.tradingDay(t, kr);
  }

  /** 분 단위로 기억해 둔 거래일 (잔고 요청마다 종목 수 × 2번 부르므로. 거래일은 정각 분에만 바뀐다) */
  private readonly dayCache = new Map<string, string>();
  private tradingDay(t: number, kr: boolean): string {
    const key = `${kr ? "K" : "U"}${Math.floor(t / 60_000)}`;
    let day = this.dayCache.get(key);
    if (day === undefined) {
      if (this.dayCache.size > 512) this.dayCache.clear();
      day = tradingDate(new Date(t).toISOString(), kr);
      this.dayCache.set(key, day);
    }
    return day;
  }

  /** 웹소켓 마지막 체결이 스냅샷보다 새 거래일 것이라 붙이지 않고 보류 중인지 (스냅샷을 다시 받아야 붙는다) */
  private heldTick(code: string): boolean {
    const h = this.book.get(code);
    const tick = this.deps.live?.get(code);
    if (!h || !tick) return false;
    const tickAt = Date.parse(tick.timestamp), quoteAt = Date.parse(h.quote.asOf);
    return !Number.isNaN(tickAt) && !Number.isNaN(quoteAt) && tickAt >= quoteAt && !sameTradingDay(h.quote, tick.timestamp);
  }

  /**
   * 장 상태: 달력을 잠깐만(QUICK_WAIT_MS) 기다리고, 늦으면 마지막으로 받은 값으로 (달력은 5분 캐시라 보통 바로 온다).
   * 기동 직후처럼 받은 적이 없으면 첫 시세를 기다리는 만큼(COLD_WAIT_MS)까지 — 추석 같은 평일 휴장일을 장중으로 한 번 보이지 않게
   */
  private calendarNow(): Promise<MarketStatus | null> {
    const cal = this.deps.calendar;
    if (!cal) return Promise.resolve(null);
    // 조회가 실패해 요일 추정(fallback)이 오면 마지막으로 받은 토스 달력을 시장별로 그대로 쓴다 (추석 같은 평일 휴장일을 장중으로 보지 않게)
    const p = cal.status().then(
      (s) => (this.calendarLast = keepTossCalendar(this.calendarLast, s)),
      () => this.calendarLast,
    );
    return within(p, this.calendarLast ? QUICK_WAIT_MS : COLD_WAIT_MS, this.calendarLast);
  }

  private sessionContext(codes: string[], calendar: MarketStatus | null): SessionContext {
    const now = this.now();
    const wsTradeAt = { KR: -Infinity, US: -Infinity };
    // 상세(종목 하나)도 잔고 종목 전체의 체결로 본다 — 목록과 같은 판단이 되게
    for (const c of new Set([...codes, ...this.listCodes])) {
      const at = Date.parse(this.deps.live?.get(c)?.timestamp ?? "");
      const m = isKrCode(c) ? "KR" : "US";
      if (at > wsTradeAt[m]) wsTradeAt[m] = at;
    }
    return {
      now,
      calendar,
      ws: wsCovered(this.deps.live?.status() ?? null, now.getTime()),
      wsTradeAt,
      facts: this.deps.quickPrices?.sessionFacts?.(codes) ?? new Map(),
    };
  }

  /**
   * 이 종목의 지금 세션과, 웹소켓을 믿어도 되는지 (wsLive — 초록 점의 웹소켓 조건).
   * 웹소켓 구독만으로는 이 세션 체결을 준다고 볼 수 없다 (주간거래·프리·애프터 체결을 토스 웹소켓이 주는지는 확인하지 못했다) →
   * 웹소켓이 붙어 이 종목을 구독 중이고, 이번 세션에 이 시장 체결이 웹소켓으로 한 번이라도 왔을 때만. 그 전에는 토스 웹 3초 갱신으로만 본다.
   * "이번 세션 체결"은 세션 시작 뒤 30초부터다(tradedInSession) — 미국 애프터마켓 시작 시각(16:00:00)에 찍히는 정규장 종가 체결을 세지 않게.
   * 가격 출처 고르기(liveTick)·실시간 스트림 폴링(wsServed)도 이 값을 쓴다 — 점과 가격이 같은 기준을 따르게
   */
  private sessionView(code: string, ctx: SessionContext): SessionView {
    const session = sessionAt(code, ctx.now, { calendar: ctx.calendar, stock: ctx.facts.get(code) ?? null });
    const start = session.start ? Date.parse(session.start) : NaN;
    const wsLive = (ctx.ws?.has(code) ?? false) && tradedInSession(ctx.wsTradeAt[session.market], start);
    return { session, start, wsLive };
  }

  /**
   * 열린 세션에서 이 종목 가격을 웹소켓 체결만으로 따라가도 되는지 — 가격 출처(liveTick)와 실시간 스트림 폴링(wsServed)이 같이 쓴다.
   * 아니면 토스 웹 가격(3초 갱신)을 쓴다:
   *  - 웹소켓이 이번 세션에 이 시장 체결을 준 적이 없음(wsLive 아님 — 끊김 포함)
   *  - 이 종목의 웹소켓 체결이 없거나, 마지막 체결이 이번 세션 것이 아님(세션 시작 전 · 시작 순간의 마감 단일가 — tradedInSession) 또는 스냅샷보다 오래됨
   *  - 이 체결이 스냅샷보다 새것이 아니고(스냅샷에 이미 든 체결) 1분 넘게 새 체결이 없음
   */
  private wsFollows(tick: LiveTick | null | undefined, quoteAt: number, trust: WsTrust): boolean {
    if (!trust.wsLive || !tick) return false;
    const wsAt = Date.parse(tick.timestamp);
    if (!tradedInSession(wsAt, trust.start) || (!Number.isNaN(quoteAt) && wsAt < quoteAt)) return false;
    const quiet = !Number.isNaN(quoteAt) && wsAt <= quoteAt && trust.now - tick.receivedAt > TICK_FRESH_MS;
    return !quiet;
  }

  /**
   * 토스 웹 폴링 없이 웹소켓 체결만으로 가격이 따라가는 종목 (실시간 스트림 PriceStream 이 폴링에서 뺀다).
   * 웹소켓이 붙어 구독 중이고, 세션이 닫혀 있거나(가격이 바뀌지 않음) 가격 출처가 웹소켓 체결인 종목(wsFollows — 초록 점·liveTick 과 같은 기준).
   * 예전에는 구독만 보고 뺐다 → 웹소켓이 이번 세션 체결을 주지 않으면(미국 주간거래 등) 초록 점은 켜졌는데 앱 가격은 30초(보정)마다만 바뀌었다.
   * 그 뒤에도 시장 단위(wsLive)로만 보아, 다른 종목이 이번 세션 체결을 받으면 체결이 없거나 조용한 종목까지 뺐다
   */
  async wsServed(codes: string[]): Promise<Set<string>> {
    if (!this.deps.live || codes.length === 0) return new Set();
    const ctx = this.sessionContext(codes, await this.calendarNow());
    const now = ctx.now.getTime();
    return new Set(
      codes.filter((c) => {
        if (!ctx.ws?.has(c)) return false;
        const v = this.sessionView(c, ctx);
        if (!v.session.open) return true;
        const h = this.book.get(c);
        return this.wsFollows(this.deps.live?.get(c), h ? Date.parse(h.quote.asOf) : NaN, { wsLive: v.wsLive, start: v.start, now });
      }),
    );
  }

  /**
   * 지금 세션과 초록 점(realtime)을 붙인다 (services/liveSession 규칙). 가격·live 는 그대로.
   * polledAt: 보여 주는 가격이 토스 웹 가격을 따라가고 있을 때(current 가 토스 웹 가격을 골랐고 붙일 수 있음)만 그 가격을 받은 때 — 아니면 null.
   * 가격이 따라가지 않는데 "토스 웹 가격을 15초 안에 받았다"는 이유로 점을 켜지 않게 (웹소켓 옛 체결을 쓰는 중 · 공식 API 가 이번 거래일 체결을 모름)
   */
  private withSession(code: string, h: Held, q: Quote, o: { held: boolean; polledAt: number | null; view: SessionView }, ctx: SessionContext): Quote {
    const t = ctx.now.getTime();
    const { session, wsLive } = o.view;
    // 자격을 모를 때만 쓰는 증거: 웹소켓 체결 시각, 공식 API 시세의 마지막 체결 시각, 3초 갱신에서 본 가격 변화(바뀌기 전 값을 받은 때)
    // (토스 웹·네이버 시세의 asOf 와 폴링 체결 시각은 받은 시각이라 증거가 아니다)
    const evidence = [
      Date.parse(this.deps.live?.get(code)?.timestamp ?? ""),
      h.quote.source === "toss-openapi" ? Date.parse(h.quote.asOf) : NaN,
      this.quickMovedAt.get(code) ?? NaN,
    ].filter((x) => Number.isFinite(x));
    const realtime = realtimeOf({
      session,
      now: t,
      feed: { ws: wsLive, polledAt: o.polledAt },
      stale: q.stale === true,
      snapshotCurrent: this.snapshotCurrent(code, h, t),
      held: o.held,
      tradedAt: evidence.length ? Math.max(...evidence) : null,
    });
    return { ...q, session: toQuoteSession(session), realtime };
  }

  /** 새로 받지 못한 마지막 값인지: 마지막 새로 받기가 실패했거나, 오래됐는데 받는 중도 아님 */
  private isStale(code: string, h: Held, t: number): boolean {
    return h.failedAt > h.at || (t - h.at > STALE_AFTER_MS && !this.inflight.has(code));
  }

  /**
   * 캐시 값 + 실시간 가격. 새 체결가로 덮어쓰지 못하고 캐시도 새로 받지 못했으면 stale 표시.
   * ctx 가 있으면(잔고·상세 응답) 지금 세션과 초록 점(realtime)도 붙인다
   */
  private current(code: string, quick?: Map<string, LiveTick>, ctx?: SessionContext): Quote | null {
    const h = this.book.get(code);
    if (!h) return null;
    const t = this.now().getTime();
    // 세션·웹소켓 신뢰(초록 점과 같은 기준)를 먼저 — 가격 출처도 이것으로 고른다 (열린 세션에서만. 닫힌 세션은 예전처럼 웹소켓 체결 먼저)
    const view = ctx ? this.sessionView(code, ctx) : null;
    const trust = view?.session.open ? { wsLive: view.wsLive, start: view.start, now: t } : null;
    const pick = this.liveTick(h.quote, quick, trust);
    let tick = pick?.tick ?? null;
    // 스냅샷(asOf)과 체결의 거래일(현지 날짜)이 다르면 섞지 않는다 — 어제 스냅샷의 전일 종가에 오늘 체결을 대면 등락이 이틀치가 된다.
    // 스냅샷을 새로 받으면(10초~1분 안, rolled) 같은 날이 되어 다시 붙는다
    const newDay = pick !== null && !sameTradingDay(h.quote, pick.tick.timestamp);
    //  - 웹소켓 체결은 실제 체결 시각이라, 새 거래일 것이면 스냅샷에 없는 체결이다 → 보류(held). 가격이 따라가지 않으니 초록 점도 끈다
    //  - 토스 웹 가격은 받은 시각이 찍혀 거래일로는 새 체결인지 알 수 없다. 값이 스냅샷과 같으면 붙일 것이 없고 그 값이 지금 가격이다 →
    //    보류가 아니다 (이번 거래일에 아직 체결이 없는 조용한 종목 — 공식 API asOf 가 지난 거래일 — 도 점이 켜진다).
    //    값이 다르면 붙이지 않고 스냅샷을 곧 다시 받는다(quickAhead). 다시 받기 전(10초 안)에는 점을 그대로 두고(조용한 종목의 첫 체결 — 곧 붙는다),
    //    다시 받아도 스냅샷이 지난 거래일 것이면(공식 API 가 이번 거래일 체결을 모름 — quickBehind) 가격이 따라가지 않으니 토스 웹 3초 갱신으로는 켜지 않는다
    const held = newDay && !pick.polled;
    const ahead = newDay && pick.polled && pick.tick.price !== h.quote.price;
    // 토스 웹 가격을 따져 본 때만 적는다 (이번 응답에 토스 웹 가격이 없으면 그대로 둔다 — 지웠다 다시 적어 같은 가격으로 또 조르지 않게)
    if (pick?.polled) this.noteQuickAhead(code, ahead ? pick.tick : null, h);
    const behind = ahead && this.quickBehind(code, h);
    if (held || ahead) tick = null;
    const q = tick ? this.applyTick(h.quote, tick) : h.quote;
    const tickFresh = tick !== null && Math.abs(t - tick.receivedAt) <= TICK_FRESH_MS;
    const stale = !tickFresh && this.isStale(code, h, t);
    const out = stale ? { ...q, stale: true } : q.stale ? { ...q, stale: false } : q;
    if (!ctx || !view) return out;
    // 토스 웹 가격이 보여 주는 가격의 출처일 때만 "3초 갱신 중" (같은 출처를 실시간 스트림이 3초마다 앱에 보낸다 — facts.pricedAt)
    const polledAt = pick?.polled && !behind ? Math.max(pick.tick.receivedAt, ctx.facts.get(code)?.pricedAt ?? 0) : null;
    return this.withSession(code, h, out, { held, polledAt, view }, ctx);
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
   * 덮어쓸 체결가. 1순위 웹소켓 체결, 2순위 REST 일괄 조회(토스 웹).
   * REST 일괄 조회는 토스 통합 가격이라 같은 기준(toss 계열)의 스냅샷에만 적용한다 — 네이버 정규장 종가에 섞이면 등락이 틀어진다.
   * 스냅샷보다 오래된 체결은 쓰지 않는다.
   * trust(열린 세션일 때 — 초록 점과 같은 기준): 웹소켓 체결을 믿을 수 없으면(wsFollows 아님 — 실시간 스트림 wsServed 와 같은 기준) 그 뒤에 받은 토스 웹 가격이 먼저다
   *  - 웹소켓이 이번 세션에 이 시장 체결을 준 적이 없음(wsLive 아님 — 끊김 포함), 또는 이 체결이 이번 세션 것이 아님(시작 전 · 시작 순간의 마감 단일가)
   *  - 이 체결이 스냅샷보다 새것이 아니고(스냅샷에 이미 든 체결) 1분 넘게 새 체결이 없음
   * 예전에는 웹소켓 체결이 스냅샷보다 오래되지만 않으면 먼저 써서, 지난 세션 마지막 체결 = 스냅샷 asOf 인 조용한 종목은
   * 이번 세션 내내 가격이 멈췄다 (점은 토스 웹 가격을 받는다는 이유로 켜짐)
   */
  private liveTick(quote: Quote, quick?: Map<string, LiveTick>, trust?: WsTrust | null): { tick: LiveTick; polled: boolean } | null {
    const quoteAt = Date.parse(quote.asOf);
    const usable = (tick: LiveTick | null | undefined): LiveTick | null => {
      if (!tick) return null;
      const tickAt = Date.parse(tick.timestamp);
      return Number.isNaN(tickAt) || (!Number.isNaN(quoteAt) && tickAt < quoteAt) ? null : tick;
    };
    // 웹소켓 마지막 체결이 스냅샷보다 오래됐으면(예: 웹소켓이 이 세션 체결을 아직 안 줌) 토스 웹 일괄 가격으로 — 웹소켓이 멈춘 종목도 3초 갱신이 붙게.
    // polled = 토스 웹 가격 (timestamp 가 체결 시각이 아니라 받은 시각)
    const ws = usable(this.deps.live?.get(quote.code));
    const polled = quick && quote.source.startsWith("toss") ? usable(quick.get(quote.code)) : null;
    if (ws && polled && trust && polled.receivedAt >= ws.receivedAt && !this.wsFollows(ws, quoteAt, trust)) return { tick: polled, polled: true };
    if (ws) return { tick: ws, polled: false };
    return polled ? { tick: polled, polled: true } : null;
  }

  /**
   * quickAhead 를 적는다: 지난 거래일 스냅샷(h)과 다른 토스 웹 가격(tick)이 처음 보이거나 그 가격이 바뀐 때만 새로(그 스냅샷을 다시 받게),
   * 같은 가격이면 그대로(이미 다시 받았으면 더 조르지 않게), 토스 웹 가격이 스냅샷에 붙거나 같으면(null) 지운다
   */
  private noteQuickAhead(code: string, tick: LiveTick | null, h: Held): void {
    if (!tick) {
      this.quickAhead.delete(code);
      return;
    }
    const had = this.quickAhead.get(code);
    if (had?.price !== tick.price) this.quickAhead.set(code, { price: tick.price, snapshot: h, since: had?.since ?? h });
  }

  /** 지난 거래일 스냅샷과 다른 토스 웹 가격을 처음 본 뒤 스냅샷을 다시 받았는데도(h 가 그때 것이 아님) 여전히 붙일 수 없다 */
  private quickBehind(code: string, h: Held): boolean {
    const a = this.quickAhead.get(code);
    return !!a && a.since !== h;
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
  // 원화 매입금액 저장(TossSyncService.setExactKrw)도 같은 기준으로 "지금 평가에 쓰는지"를 알린다
  const t = tossBasisFor(s.quantity, toss);
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
