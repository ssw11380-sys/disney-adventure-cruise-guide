import type { DiscoverStock, NaverDiscover, ThemeSummary } from "../providers/market/naverDiscover.js";
import type { CodeStore } from "../providers/market/toss.js";
import { reutersCandidates, type TicsDuration, type TicsNode, type TossTics } from "../providers/market/tossTics.js";

/**
 * 미국 테마북: 토스 테마 분류(TICS)의 구성 종목에 네이버 정규장 시세를 붙여 테마 등락률을 직접 계산한다.
 *
 *  1) 테마 목록: 토스 미국 테마 순위(기간 5개 × 등락률·거래대금)에 나온 테마의 개요에서 분류 트리 전체를 모은다
 *  2) 구성 종목: 테마마다 시가총액 큰 순으로 최대 pagesPerTheme 쪽(쪽당 10개). 미국 종목이 minStocks 개 미만인 테마는 뺀다
 *  3) 토스 상품 코드 → 티커(stock-infos) → 네이버 로이터 코드(후보를 폴링해 실제로 있는 것). 스팩은 뺀다
 *  4) 매일 정해진 시각(app.ts: 한국 21:00, 미국 정규장 전)에 새로 만들고 meta 표에 남긴다.
 *     그 사이 하루가 넘었으면(정기 갱신 실패 등) 옛것을 주면서 뒤에서 새로 만든다
 *
 * 토스 값을 쓰지 않고 다시 계산하는 까닭: 토스는 한국 낮에 미국 주간거래 가격을 섞어 등락률을 낸다 (정규장 기준이 아님).
 */

export interface UsThemeMember {
  productCode: string;
  symbol: string;
  reuters: string;
}

export interface UsTheme {
  id: string;
  name: string;
  root: string;
  depth: number;
  /** 토스 기준 미국 구성 종목 수 (members 는 시가총액 상위 일부일 수 있다) */
  total: number;
  members: UsThemeMember[];
}

export interface UsThemeBookData {
  version: 1;
  builtAt: number;
  themes: UsTheme[];
}

type Log = { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };

const STORE_KEY = "discover:us-tics:v1";
const FRESH_MS = 24 * 3_600_000;
const USABLE_MS = 7 * 24 * 3_600_000;
const DURATIONS: TicsDuration[] = ["1d", "1w", "1m", "3m", "1y"];

export async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

/** 테마북을 처음 만드는 중 (약 1분) */
export class UsThemesBuildingError extends Error {
  constructor() {
    super("미국 테마를 처음 준비하는 중입니다 (약 1분)");
    this.name = "UsThemesBuildingError";
  }
}

export class UsThemeBook {
  private data: UsThemeBookData | null = null;
  private loaded = false;
  private building: Promise<UsThemeBookData> | null = null;
  private readonly summaries = new Map<string, { at: number; summary: string | null }>();

  constructor(
    private readonly deps: {
      tics: TossTics;
      naver: NaverDiscover;
      store?: CodeStore | null;
      now?: () => Date;
      log?: Log;
      pagesPerTheme?: number;
      minStocks?: number;
      concurrency?: number;
    },
  ) {}

  private get t(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  /**
   * 테마북. 없으면 만들 때까지 기다리고(waitMs 를 넘기면 UsThemesBuildingError), 하루 넘었으면 옛것을 주면서 뒤에서 새로 만든다.
   */
  async get(waitMs?: number): Promise<UsThemeBookData> {
    const p = this.getInner();
    if (waitMs === undefined || this.data) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new UsThemesBuildingError()), waitMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async getInner(): Promise<UsThemeBookData> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const raw = await this.deps.store?.get(STORE_KEY);
        const parsed = raw ? (JSON.parse(raw) as UsThemeBookData) : null;
        if (parsed?.version === 1 && Array.isArray(parsed.themes) && parsed.themes.length) this.data = parsed;
      } catch {
        /* 저장본이 깨졌으면 새로 만든다 */
      }
    }
    const d = this.data;
    if (d && this.t - d.builtAt < FRESH_MS) return d;
    if (d && this.t - d.builtAt < USABLE_MS) {
      void this.rebuild().catch((e) => this.deps.log?.warn?.({ err: String(e) }, "미국 테마북 갱신 실패 (옛것 사용)"));
      return d;
    }
    return this.rebuild();
  }

  /** 서버를 켤 때 미리 만들어 둔다 (첫 화면이 기다리지 않게) */
  warm(): void {
    void this.get().catch((e) => this.deps.log?.warn?.({ err: String(e) }, "미국 테마북 준비 실패"));
  }

  /**
   * 신선도와 상관없이 지금 새로 만든다 (매일 정해진 시각에 부른다 — 화면을 열지 않아도 새 테마·편입 종목이 반영되게).
   * 실패하면 가진 것을 그대로 둔다.
   */
  async refresh(): Promise<void> {
    if (!this.loaded) await this.get().catch(() => undefined);
    await this.rebuild().catch((e) => this.deps.log?.warn?.({ err: String(e) }, "미국 테마북 정기 갱신 실패 (옛것 유지)"));
  }

  /** 지금 가진 테마북을 만든 시각 (없으면 null) */
  get builtAt(): number | null {
    return this.data?.builtAt ?? null;
  }

  private rebuild(): Promise<UsThemeBookData> {
    this.building ??= this.build()
      .then(async (d) => {
        this.data = d;
        await this.deps.store?.set(STORE_KEY, JSON.stringify(d)).catch(() => undefined);
        this.deps.log?.info?.({ themes: d.themes.length, stocks: new Set(d.themes.flatMap((t) => t.members.map((m) => m.reuters))).size }, "미국 테마북 만듦");
        return d;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  async build(): Promise<UsThemeBookData> {
    const { tics, naver } = this.deps;
    const pages = this.deps.pagesPerTheme ?? 3;
    const minStocks = this.deps.minStocks ?? 3;
    const conc = this.deps.concurrency ?? 4;

    // 1) 순위에 나온 테마 → 개요의 분류 트리로 전체 테마를 모은다
    const seeds = new Map<string, string>();
    for (const dur of DURATIONS)
      for (const sortBy of ["FLUCTUATION_RATE", "TRADING_AMOUNT"] as const) {
        try {
          for (const r of await tics.ranking("US", dur, sortBy)) if (!seeds.has(r.id)) seeds.set(r.id, r.name);
        } catch {
          /* 한 목록이 실패해도 나머지로 */
        }
      }
    if (!seeds.size) throw new Error("토스 미국 테마 순위를 받지 못했습니다");
    const nodes = new Map<string, TicsNode>();
    const roots = new Set<string>();
    for (const id of seeds.keys()) {
      const known = nodes.get(id);
      if (known && roots.has(known.root)) continue;
      try {
        const ov = await tics.overview(id);
        for (const n of ov.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
        for (const n of ov.nodes) if (n.depth === 0) roots.add(n.root);
        if (ov.summary) this.summaries.set(id, { at: this.t, summary: ov.summary });
      } catch {
        /* 개요 실패: 순위의 이름으로만 둔다 */
      }
      if (!nodes.has(id)) nodes.set(id, { id, name: seeds.get(id)!, depth: 1, root: "" });
    }

    // 2) 구성 종목 (시가총액 큰 순). 가장 큰 분류(depth 0: IT·금융 …)는 너무 넓어 뺀다
    const targets = [...nodes.values()].filter((n) => n.depth >= 1);
    const crawled = await pool(targets, conc, async (n) => {
      try {
        const first = await tics.stocksPage(n.id, "US", 1);
        if (first.total < minStocks) return null;
        const stocks = [...first.stocks];
        for (let p = 2; p <= Math.min(pages, Math.ceil(first.total / 10)); p++) stocks.push(...(await tics.stocksPage(n.id, "US", p)).stocks);
        return { node: n, total: first.total, codes: [...new Set(stocks.map((s) => s.productCode))] };
      } catch {
        return null;
      }
    });
    const themes = crawled.filter((x): x is NonNullable<typeof x> => x !== null);
    if (!themes.length) throw new Error("토스 미국 테마 구성 종목을 받지 못했습니다");

    // 3) 상품 코드 → 티커 → 로이터 코드 (네이버에 실제로 있는 후보)
    const infos = await tics.stockInfos([...new Set(themes.flatMap((t) => t.codes))]);
    const candidates = new Map<string, string[]>();
    for (const [code, info] of infos) if (!info.spac) candidates.set(code, reutersCandidates(info.symbol, info.market));
    const found = await naver.usQuotes([...new Set([...candidates.values()].flat())]);
    const member = new Map<string, UsThemeMember>();
    for (const [code, cands] of candidates) {
      const reuters = cands.find((c) => found.has(c));
      if (reuters) member.set(code, { productCode: code, symbol: found.get(reuters)!.code, reuters });
    }

    const out: UsTheme[] = [];
    for (const t of themes) {
      const members = t.codes.map((c) => member.get(c)).filter((m): m is UsThemeMember => !!m);
      if (members.length >= minStocks) out.push({ id: t.node.id, name: t.node.name, root: t.node.root, depth: t.node.depth, total: t.total, members });
    }
    if (!out.length) throw new Error("미국 테마 구성 종목의 시세 코드를 찾지 못했습니다");
    return { version: 1, builtAt: this.t, themes: out };
  }

  /** 테마 설명 (토스 개요, 하루 캐시) */
  async summary(id: string): Promise<string | null> {
    const hit = this.summaries.get(id);
    if (hit && this.t - hit.at < FRESH_MS) return hit.summary;
    try {
      const s = (await this.deps.tics.overview(id)).summary;
      this.summaries.set(id, { at: this.t, summary: s });
      return s;
    } catch {
      return hit?.summary ?? null;
    }
  }
}

/** 지난 날짜에 멈춘 종목(거래정지 등)을 빼기 위한 최신 거래일 */
export function latestTradeDay(quotes: Iterable<{ tradedAt: string | null }>): string {
  let d = "";
  for (const q of quotes) {
    const day = (q.tradedAt ?? "").slice(0, 10);
    if (day > d) d = day;
  }
  return d;
}

/**
 * 테마 한 개의 오늘 등락률 (정규장). 거래가 없는 종목·지난 날짜 종목은 뺀다.
 *  - changeRate: 시가총액 가중 평균 (전일 시가총액 = 오늘 시가총액 / (1 + 등락률))
 *  - simpleAvg: 단순 평균 (참고)
 *  - tradingValue: 구성 종목 거래대금 합 (달러) — 거의 거래되지 않는 테마를 거르는 데 쓴다
 */
export function usThemeSummary(
  theme: UsTheme,
  quotes: Map<string, DiscoverStock & { tradedAt: string | null }>,
  day: string,
): { summary: ThemeSummary; items: DiscoverStock[]; tradingValue: number } | null {
  const items: DiscoverStock[] = [];
  for (const m of theme.members) {
    const q = quotes.get(m.reuters);
    if (!q) continue;
    if (day && (q.tradedAt ?? "").slice(0, 10) !== day) continue;
    const { tradedAt: _t, ...s } = q;
    items.push(s);
  }
  const live = items.filter((i) => (i.volume ?? 1) > 0);
  if (!live.length) return null;
  const simple = live.reduce((s, i) => s + i.changeRate, 0) / live.length;
  let wSum = 0;
  let wr = 0;
  for (const i of live) {
    if (!i.marketCap || i.marketCap <= 0) continue;
    const prev = i.marketCap / (1 + i.changeRate / 100);
    wSum += prev;
    wr += prev * i.changeRate;
  }
  const weighted = wSum > 0 ? wr / wSum : simple;
  const r2 = (x: number) => Math.round(x * 100) / 100 || 0; // -0 은 0 으로
  return {
    tradingValue: live.reduce((s, i) => s + (i.tradingValue ?? 0), 0),
    summary: {
      id: theme.id,
      name: theme.name,
      changeRate: r2(weighted),
      up: live.filter((i) => i.changeRate > 0).length,
      flat: live.filter((i) => i.changeRate === 0).length,
      down: live.filter((i) => i.changeRate < 0).length,
      leaders: [...live]
        .sort((a, b) => b.changeRate - a.changeRate)
        .slice(0, 3)
        .map((i) => ({ code: i.code, name: i.name, changeRate: i.changeRate })),
      simpleAvg: r2(simple),
    },
    items,
  };
}
