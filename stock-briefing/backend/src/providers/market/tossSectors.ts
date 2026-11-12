import { mapLimit } from "../../lib/concurrency.js";
import { ProviderError } from "../../lib/errors.js";
import type { CompanyTic } from "./tossCompanyTics.js";
import type { TicsDuration, TicsNation, TicsNode, TicsRankRow, TicsSource, TicsStock, TicsStockInfo } from "./tossTics.js";

/**
 * 토스증권 공식 Open API 의 섹터(토스 자체 산업·테마 분류) — 예전 토스 웹 테마 분류(TICS, tossTics.ts · tossCompanyTics.ts)를 대신한다 (플래그 themeOpenApi).
 * 토스 웹 주소가 2026-11 부터 막혀 미국 테마북을 새로 만들지 못했고(발견 탭 미국 테마가 '처음 준비하는 중'에 멈춰 산업 분류로만 보임),
 * 내 종목 테마의 미국 종목 분류도 받지 못했다. 공식 섹터는 같은 분류다 — 번호가 같다 (956 양자컴퓨터 · 87 IT · 89 IT솔루션구축, 2026-11-12 확인).
 *
 *  - 목록:      GET /api/v1/sectors                                   전체 300개 안팎 (depth 0 대분류 · 1 중분류 · 2 소분류, parentSectorId)
 *  - 상세:      GET /api/v1/sectors/{id}?marketCountry=US             한 줄 요약 + 기간별 등락률 6개 (소수 비율)
 *  - 구성 종목: GET /api/v1/sectors/{id}/stocks?marketCountry=US      그 섹터(하위 섹터 포함)의 보통주 전부, 시가총액 큰 순 — 티커가 바로 온다
 *  - 순위:      GET /api/v1/sectors/rankings?type=&marketCountry=&duration=   대·중분류 상위 100
 *  - 종목 정보: GET /api/v1/stocks?symbols=                           거래소(NASDAQ·NYSE·AMEX) — 네이버 시세 코드 후보를 만드는 데
 * 요청 한도: 섹터 그룹 초당 5회 · 섹터 순위 초당 5회 · 종목 정보 초당 5회 — 클라이언트가 그룹마다 줄을 세운다(tossRateLimit). 테마북 한 번(구성 종목 260번쯤)에 1분 남짓.
 *
 * 토스 웹 때와 다른 점:
 *  - 순위에 소분류(depth 2)가 없다 → 그 테마의 기간 등락률은 상세에서 하나씩 (상세 한 번으로 6개 기간을 다 받으므로 10분 캐시)
 *  - '회사 → 주요 사업 테마'(웹 companies/{cc}/tics)가 없다 → 섹터 구성 종목 목록을 거꾸로 찾는다 (majorFor). 웹에서도 구성 종목 목록에는
 *    주요 사업 회사만 들어 있었고(그 외 사업은 없음) 공식 목록도 같다 (양자컴퓨터 미국 목록에 마이크로소프트 없음)
 *  - 스팩 표시가 없다 → 이름으로만 거른다 (섹터에는 사업 분류가 있는 보통주만 들어 있어 스팩은 거의 없다)
 *  - 종목이 상품 코드(US2010…) 대신 티커로 온다 → 테마북의 productCode 칸에 티커를 그대로 넣는다 (그 칸은 테마 안에서 종목을 가리는 열쇠로만 쓰인다)
 */

type Json = Record<string, unknown>;

/** 공식 API 읽기 (TossOpenApiClient.get — 응답의 result 를 준다) */
export type SectorApiGet = (path: string, params?: Record<string, string | number | boolean | undefined>) => Promise<unknown>;

export interface SectorTicsDeps {
  get: SectorApiGet;
  /** 종목 정보 (공식 /api/v1/stocks — TossOpenApiProvider.stockInfos, 하루 캐시). 거래소·이름·상장 상태 */
  stockInfos: (symbols: string[]) => Promise<Map<string, { symbol?: string; name?: string; englishName?: string; market?: string; status?: string }>>;
  now?: () => Date;
  /** 구성 종목을 동시에 받는 섹터 수 (요청 한도는 클라이언트가 지킨다) */
  concurrency?: number;
}

interface SectorNode {
  id: string;
  name: string;
  depth: number;
  parent: string | null;
}

const NAME = "toss-sectors";
/** 섹터 목록을 다시 받는 간격 (문서: 자주 바뀌지 않으므로 하루 한 번) */
const TREE_TTL_MS = 24 * 3_600_000;
/** 구성 종목을 쪽으로 나눠 줄 때 같은 목록을 다시 받지 않는 시간 (테마북을 만드는 동안) */
const STOCKS_TTL_MS = 10 * 60_000;
/** 상세(요약·기간 등락률)를 다시 받지 않는 시간 */
const DETAIL_TTL_MS = 10 * 60_000;
/** 종목 → 섹터 표(거꾸로 찾기)를 다시 만드는 간격 */
const INDEX_TTL_MS = 24 * 3_600_000;
/** 거꾸로 찾는 표를 만들 때 구성 종목을 받지 못한 섹터가 이 비율을 넘으면 실패로 (반쪽 표로 '테마 없음'이라 답하지 않게) */
const INDEX_MAX_FAIL = 0.1;
/** 토스 웹 구성 종목과 같게 한 쪽 10개 */
const PAGE_SIZE = 10;
const DURATION: Record<TicsDuration, string> = { "1d": "1d", "1w": "1w", "1m": "1mo", "3m": "3mo", "1y": "1y" };
/** 상장 시장 → 토스 웹 거래소 코드 (reutersCandidates 가 받는 값) */
const MARKET_CODE: Record<string, string> = { NASDAQ: "NSQ", NYSE: "NYS", AMEX: "AMX", KOSPI: "KSP", KOSDAQ: "KSQ" };
/** 이름으로 보는 스팩 (기업인수목적회사) */
const SPAC_NAME_RE = /(기업인수목적|스팩\s*\d|\bSPAC\b|\bAcquisition\s+(Corp|Corporation|Co|Company|Holdings)\b)/i;

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 섹터 목록 응답(result) → 마디. sectors 가 배열이 아니면 모양이 바뀐 것이라 던진다 */
export function parseSectors(result: unknown): SectorNode[] {
  const rows = (result as Json | null | undefined)?.["sectors"];
  if (!Array.isArray(rows)) throw new ProviderError(NAME, "섹터 목록 응답 모양이 바뀌었습니다");
  const out: SectorNode[] = [];
  for (const r of rows as Json[]) {
    const id = r?.["sectorId"];
    const name = r?.["name"];
    const depth = num(r?.["depth"]);
    if ((typeof id !== "string" && typeof id !== "number") || typeof name !== "string" || !name.trim() || depth === null) continue;
    const parent = r["parentSectorId"];
    out.push({ id: String(id), name: name.trim(), depth, parent: typeof parent === "string" || typeof parent === "number" ? String(parent) : null });
  }
  return out;
}

/** 구성 종목 응답(result) → 티커·이름 (시가총액 큰 순 그대로). stocks 가 배열이 아니면 던진다 */
export function parseSectorStocks(result: unknown): Array<{ symbol: string; name: string }> {
  const rows = (result as Json | null | undefined)?.["stocks"];
  if (!Array.isArray(rows)) throw new ProviderError(NAME, "섹터 구성 종목 응답 모양이 바뀌었습니다");
  const out: Array<{ symbol: string; name: string }> = [];
  const seen = new Set<string>();
  for (const r of rows as Json[]) {
    const symbol = typeof r?.["symbol"] === "string" ? r["symbol"].trim().toUpperCase() : "";
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: typeof r["name"] === "string" && r["name"].trim() ? r["name"].trim() : symbol });
  }
  return out;
}

/** 소수 비율(0.0179) → %(1.79). 소수 넷째 자리까지 (부동소수 꼬리를 지운다) */
function ratioToPct(v: unknown): number | null {
  const r = num(v);
  return r === null ? null : Math.round(r * 1_000_000) / 10_000 || 0;
}

export class TossSectorTics implements TicsSource {
  private readonly now: () => Date;
  private tree: { at: number; nodes: SectorNode[] } | null = null;
  private treeInflight: Promise<SectorNode[]> | null = null;
  private readonly stocks = new Map<string, { at: number; list: Array<{ symbol: string; name: string }> }>();
  private readonly stocksInflight = new Map<string, Promise<Array<{ symbol: string; name: string }>>>();
  private readonly details = new Map<string, { at: number; summary: string | null; rates: Map<string, number | null> }>();
  private readonly detailInflight = new Map<string, Promise<{ summary: string | null; rates: Map<string, number | null> }>>();
  private index: { at: number; map: Map<string, CompanyTic[]> } | null = null;
  private indexInflight: Promise<Map<string, CompanyTic[]>> | null = null;

  constructor(private readonly deps: SectorTicsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get t(): number {
    return this.now().getTime();
  }

  /** 연결·한도·모양 오류는 모두 출처 오류(ProviderError)로 */
  private async call(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    try {
      return await this.deps.get(path, params);
    } catch (e) {
      throw e instanceof ProviderError ? e : new ProviderError(NAME, e instanceof Error ? e.message : String(e), e);
    }
  }

  /** 섹터 목록 (하루 캐시 · 동시에 물으면 한 번). 새로 받지 못하면 전에 받은 것을 쓴다 */
  private sectors(): Promise<SectorNode[]> {
    if (this.tree && this.t - this.tree.at < TREE_TTL_MS) return Promise.resolve(this.tree.nodes);
    this.treeInflight ??= (async () => {
      try {
        const nodes = parseSectors(await this.call("/api/v1/sectors"));
        if (!nodes.length) throw new ProviderError(NAME, "섹터 목록이 비어 있습니다");
        this.tree = { at: this.t, nodes };
        return nodes;
      } catch (e) {
        if (this.tree) return this.tree.nodes;
        throw e;
      }
    })().finally(() => {
      this.treeInflight = null;
    });
    return this.treeInflight;
  }

  /** 섹터 하나의 요약·기간 등락률(%) — 상세 한 번으로 여섯 기간을 다 받는다 (10분 캐시 · 동시에 물으면 한 번) */
  private detail(id: string, nation: TicsNation): Promise<{ summary: string | null; rates: Map<string, number | null> }> {
    const key = `${nation}:${id}`;
    const hit = this.details.get(key);
    if (hit && this.t - hit.at < DETAIL_TTL_MS) return Promise.resolve(hit);
    let p = this.detailInflight.get(key);
    if (!p) {
      p = (async () => {
        const r = (await this.call(`/api/v1/sectors/${encodeURIComponent(id)}`, { marketCountry: nation })) as Json | null;
        if (!r || typeof r !== "object") throw new ProviderError(NAME, `섹터 상세 응답이 비었습니다 (${id})`);
        const rates = new Map<string, number | null>();
        const list = (r["performance"] as Json | null | undefined)?.["changeRates"];
        for (const x of Array.isArray(list) ? (list as Json[]) : []) if (typeof x?.["duration"] === "string") rates.set(x["duration"], ratioToPct(x["changeRate"]));
        const summary = typeof r["summary"] === "string" && r["summary"].trim() ? r["summary"].trim() : null;
        const got = { at: this.t, summary, rates };
        this.details.set(key, got);
        // 오래 켜 둔 서버에서 끝없이 늘지 않게 (섹터 300개 × 나라 2)
        while (this.details.size > 700) {
          const oldest = this.details.keys().next().value;
          if (oldest === undefined) break;
          this.details.delete(oldest);
        }
        return got;
      })().finally(() => this.detailInflight.delete(key));
      this.detailInflight.set(key, p);
    }
    return p;
  }

  /** 섹터 하나의 구성 종목 전부 (시가총액 큰 순). maxAgeMs 안에 받은 것은 다시 받지 않는다 */
  private stockList(id: string, nation: TicsNation, maxAgeMs: number): Promise<Array<{ symbol: string; name: string }>> {
    const key = `${nation}:${id}`;
    const hit = this.stocks.get(key);
    if (hit && this.t - hit.at < maxAgeMs) return Promise.resolve(hit.list);
    let p = this.stocksInflight.get(key);
    if (!p) {
      p = (async () => {
        const list = parseSectorStocks(await this.call(`/api/v1/sectors/${encodeURIComponent(id)}/stocks`, { marketCountry: nation }));
        this.stocks.set(key, { at: this.t, list });
        return list;
      })().finally(() => this.stocksInflight.delete(key));
      this.stocksInflight.set(key, p);
    }
    return p;
  }

  // ── TicsSource (미국 테마북 · 발견 탭 기간 등락률) ──────────────────────

  /** 섹터 순위 (대·중분류 상위 100). 등락률은 % */
  async ranking(nation: TicsNation, duration: TicsDuration, sortBy: "FLUCTUATION_RATE" | "TRADING_AMOUNT" = "FLUCTUATION_RATE"): Promise<TicsRankRow[]> {
    const r = (await this.call("/api/v1/sectors/rankings", { type: sortBy === "TRADING_AMOUNT" ? "MARKET_TRADING_AMOUNT" : "TOP_GAINERS", marketCountry: nation, duration: DURATION[duration] })) as Json | null;
    const rows = r?.["rankings"];
    if (!Array.isArray(rows)) throw new ProviderError(NAME, "섹터 순위 응답 모양이 바뀌었습니다");
    const out: TicsRankRow[] = [];
    for (const x of rows as Json[]) {
      const id = x?.["sectorId"];
      const name = x?.["name"];
      const rate = ratioToPct(x?.["changeRate"]);
      if ((typeof id !== "string" && typeof id !== "number") || typeof name !== "string" || !name.trim() || rate === null) continue;
      out.push({ id: String(id), name: name.trim(), rate: Math.round(rate * 100) / 100 || 0, stockCount: null, leader: null });
    }
    return out;
  }

  /** 섹터 한 개의 기간 등락률(%) — 그 나라 종목 기준. 자료가 없으면 null */
  async periodRate(id: string, nation: TicsNation, duration: TicsDuration): Promise<number | null> {
    return (await this.detail(id, nation)).rates.get(DURATION[duration]) ?? null;
  }

  /** 섹터 개요: 한 줄 요약과, 이 섹터가 속한 대분류의 분류 트리 전체 */
  async overview(id: string): Promise<{ id: string; name: string; summary: string | null; nodes: TicsNode[] }> {
    const all = await this.sectors();
    const byId = new Map(all.map((n) => [n.id, n]));
    const self = byId.get(id);
    // 대분류까지 거슬러 올라간다 (순환·끊긴 부모는 거기서 멈춤)
    let root = self ?? null;
    for (let i = 0; root && root.parent !== null && i < 5; i++) root = byId.get(root.parent) ?? null;
    const nodes: TicsNode[] = [];
    if (root) {
      const children = new Map<string, SectorNode[]>();
      for (const n of all) if (n.parent !== null) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
      const walk = (n: SectorNode) => {
        nodes.push({ id: n.id, name: n.name, depth: n.depth, root: root!.name });
        for (const c of children.get(n.id) ?? []) walk(c);
      };
      walk(root);
    }
    // 요약은 덤이다 — 받지 못해도 트리는 준다 (테마북을 만드는 데는 트리만 쓴다)
    const summary = await this.detail(id, "US").then(
      (d) => d.summary,
      () => null,
    );
    return { id, name: self?.name ?? "", summary, nodes };
  }

  /** 구성 종목 한 쪽 (시가총액 큰 순, 10개씩, page 1부터). 공식 API 는 한 번에 다 주므로 한 번 받아 나눠 준다 */
  async stocksPage(id: string, nation: TicsNation, page: number): Promise<{ total: number; stocks: TicsStock[] }> {
    const list = await this.stockList(id, nation, STOCKS_TTL_MS);
    const from = Math.max(0, (Math.floor(page) - 1) * PAGE_SIZE);
    return { total: list.length, stocks: list.slice(from, from + PAGE_SIZE).map((s) => ({ productCode: s.symbol, name: s.name, marketCapUsd: null })) };
  }

  /** 티커 → 거래소·이름 (공식 종목 정보, 200개씩). 상장 중(ACTIVE)이 아닌 종목은 뺀다 */
  async stockInfos(codes: string[]): Promise<Map<string, TicsStockInfo>> {
    const out = new Map<string, TicsStockInfo>();
    const symbols = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return out;
    let infos: Awaited<ReturnType<SectorTicsDeps["stockInfos"]>>;
    try {
      infos = await this.deps.stockInfos(symbols);
    } catch (e) {
      throw e instanceof ProviderError ? e : new ProviderError(NAME, e instanceof Error ? e.message : String(e), e);
    }
    for (const symbol of symbols) {
      const x = infos.get(symbol);
      if (!x || String(x.status ?? "ACTIVE") !== "ACTIVE") continue;
      const name = typeof x.name === "string" && x.name.trim() ? x.name.trim() : symbol;
      const spac = SPAC_NAME_RE.test(name) || (typeof x.englishName === "string" && SPAC_NAME_RE.test(x.englishName));
      out.set(symbol, { productCode: symbol, symbol, market: MARKET_CODE[String(x.market ?? "")] ?? "", name, spac });
    }
    return out;
  }

  // ── 내 종목 테마 (종목 → 주요 사업 테마) ─────────────────────────────

  /**
   * 미국 티커 → 그 종목이 든 섹터 (가장 깊은 것만 — 중분류 '양자컴퓨터'에 들었으면 대분류 'IT'는 빼고, 소분류에 들었으면 그 위 중분류도 뺀다).
   * 좁은 섹터(미국 종목 수가 적은 것)부터. 어느 섹터에도 없으면(ETF 등) 빈 배열. 표를 만들지 못하면 던진다 (부르는 쪽이 5분 뒤 다시)
   */
  async majorFor(code: string): Promise<CompanyTic[]> {
    return (await this.usIndex()).get(code.trim().toUpperCase()) ?? [];
  }

  /** 종목 → 섹터 표 (하루 캐시 · 동시에 물으면 한 번). 중·소분류 구성 종목을 모두 받아 거꾸로 만든다 (260번쯤 — 테마북을 방금 만들었으면 받아 둔 것을 쓴다) */
  private usIndex(): Promise<Map<string, CompanyTic[]>> {
    if (this.index && this.t - this.index.at < INDEX_TTL_MS) return Promise.resolve(this.index.map);
    this.indexInflight ??= this.buildIndex()
      .then((map) => {
        this.index = { at: this.t, map };
        return map;
      })
      .catch((e: unknown) => {
        // 새로 만들지 못하면 전에 만든 표를 쓴다 (없으면 실패)
        if (this.index) return this.index.map;
        throw e;
      })
      .finally(() => {
        this.indexInflight = null;
      });
    return this.indexInflight;
  }

  private async buildIndex(): Promise<Map<string, CompanyTic[]>> {
    const all = await this.sectors();
    // 대분류는 받지 않는다 — 너무 넓고(IT 한 곳에 미국 종목 500개), 테마북에도 없다 (하위 섹터에 든 종목은 하위 섹터로 잡힌다)
    const targets = all.filter((n) => n.depth >= 1);
    let failed = 0;
    const lists = await mapLimit(targets, this.deps.concurrency ?? 4, (n) =>
      this.stockList(n.id, "US", INDEX_TTL_MS).catch(() => {
        failed++;
        return null;
      }),
    );
    if (targets.length && failed / targets.length > INDEX_MAX_FAIL) throw new ProviderError(NAME, `섹터 구성 종목 조회 실패가 많습니다 (${failed}/${targets.length})`);
    const size = new Map<string, number>();
    const holders = new Map<string, Set<string>>();
    targets.forEach((n, i) => {
      const list = lists[i];
      if (!list) return;
      size.set(n.id, list.length);
      for (const s of list) {
        const set = holders.get(s.symbol) ?? new Set<string>();
        set.add(n.id);
        holders.set(s.symbol, set);
      }
    });
    const byId = new Map(all.map((n) => [n.id, n]));
    const children = new Map<string, string[]>();
    for (const n of all) if (n.parent !== null) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id]);
    const out = new Map<string, CompanyTic[]>();
    for (const [symbol, ids] of holders) {
      // 하위 섹터가 이 종목을 갖고 있으면 그 위 섹터는 뺀다 (구성 종목 목록이 하위 섹터의 종목을 포함해서 온다)
      const deepest = [...ids].filter((id) => !(children.get(id) ?? []).some((c) => ids.has(c)));
      deepest.sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0) || Number(a) - Number(b) || (a < b ? -1 : 1));
      out.set(
        symbol,
        deepest.map((id) => ({ id, title: byId.get(id)?.name ?? id })),
      );
    }
    return out;
  }
}

/**
 * 테마 분류 출처 고르기: use() 가 참이면 앞(공식 섹터), 아니면 뒤(토스 웹 — 없으면 '꺼져 있다'고 던진다).
 * 부를 때마다 물어본다 — 플래그를 끄면 그 순간부터 예전 출처 그대로
 */
export function switchTics(first: TicsSource, second: TicsSource | null, use: () => Promise<boolean>): TicsSource {
  const pick = async (): Promise<TicsSource> => {
    if (await use()) return first;
    if (!second) throw new ProviderError(NAME, "테마 분류 출처가 꺼져 있습니다");
    return second;
  };
  return {
    ranking: async (nation, duration, sortBy) => (await pick()).ranking(nation, duration, sortBy),
    periodRate: async (id, nation, duration) => (await pick()).periodRate(id, nation, duration),
    overview: async (id) => (await pick()).overview(id),
    stocksPage: async (id, nation, page) => (await pick()).stocksPage(id, nation, page),
    stockInfos: async (codes) => (await pick()).stockInfos(codes),
  };
}
