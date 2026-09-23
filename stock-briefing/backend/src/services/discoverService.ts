import { seoulIso } from "../lib/time.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { DiscoverMarket, DiscoverStock, NaverDiscover, RankCategory, ThemeKind, ThemePeriod, ThemeSummary } from "../providers/market/naverDiscover.js";

/**
 * 발견 탭 서비스: 순위(거래대금·거래량·급상승·급하락)와 테마·업종(오늘/1주/1개월), 테마 구성 종목.
 *  - 캐시: 그 나라 장이 열려 있으면 30초, 닫혀 있으면 5분 (주·월 등락률은 장중에도 2분)
 *  - 조회가 실패하면 직전 값을 그대로 준다(stale). 직전 값도 없으면 오류
 *  - 급상승·급하락은 거래대금 한국 10억 원·미국 100만 달러 미만을 빼서 동전주가 뜨지 않게 한다
 *  - ETF·ETN·스팩은 순위에서 뺀다 (종목만)
 */

export interface DiscoverRank {
  market: DiscoverMarket;
  category: RankCategory;
  items: DiscoverStock[];
  page: number;
  hasMore: boolean;
  marketOpen: boolean;
  asOf: string | null;
  fxRate: number | null;
  source: string;
  note: string | null;
}

export interface ThemeList {
  market: DiscoverMarket;
  kind: ThemeKind;
  period: ThemePeriod;
  themes: ThemeSummary[];
  marketOpen: boolean;
  asOf: string | null;
  source: string;
  basis: string;
}

export interface ThemeDetail {
  market: DiscoverMarket;
  kind: ThemeKind;
  theme: ThemeSummary;
  description: string | null;
  items: DiscoverStock[];
  marketOpen: boolean;
  asOf: string | null;
  fxRate: number | null;
  source: string;
  basis: string;
}

/** 순위 원본: 정렬된 전체 목록을 앞에서부터 한 쪽씩 (없으면 빈 목록, hasNext 로 끝) */
export type RankSource = (category: RankCategory, index: number) => Promise<{ items: DiscoverStock[]; hasNext: boolean }>;

export const MIN_TRADING_VALUE: Record<DiscoverMarket, number> = { KR: 1_000_000_000, US: 1_000_000 };
const MAX_SOURCE_PAGES = 12;

type Cached<T> = { at: number; value: T };

export class DiscoverService {
  private readonly cache = new Map<string, Cached<unknown>>();
  /** 순위는 쪽을 이어 받으므로 (시장, 분류)별로 누적 상태를 둔다 */
  private readonly ranks = new Map<string, { at: number; items: DiscoverStock[]; next: number; hasNext: boolean; source: string }>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      naver: NaverDiscover;
      /** 미국 순위 원본 (없으면 미국 순위는 오류) */
      usRank?: { source: RankSource; name: string } | null;
      calendar?: MarketCalendar | null;
      usdKrw?: (() => Promise<number | null>) | null;
      now?: () => Date;
    },
  ) {}

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async isOpen(market: DiscoverMarket): Promise<boolean> {
    if (!this.deps.calendar) return false;
    try {
      const s = await this.deps.calendar.status();
      return market === "KR" ? s.KR.isOpen : s.US.isOpen;
    } catch {
      return false;
    }
  }

  private ttl(open: boolean, slow = false): number {
    return open ? (slow ? 120_000 : 30_000) : 5 * 60_000;
  }

  private async fx(market: DiscoverMarket): Promise<number | null> {
    if (market !== "US" || !this.deps.usdKrw) return null;
    return this.deps.usdKrw().catch(() => null);
  }

  /** 캐시 → 없거나 오래되면 조회(같은 키는 한 번만) → 실패하면 직전 값 */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ value: T; at: number }> {
    const hit = this.cache.get(key) as Cached<T> | undefined;
    const t = this.now.getTime();
    if (hit && t - hit.at < ttl) return { value: hit.value, at: hit.at };
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    try {
      const value = await p;
      this.cache.set(key, { at: t, value });
      return { value, at: t };
    } catch (e) {
      if (hit) return { value: hit.value, at: hit.at };
      throw e;
    }
  }

  async rank(market: DiscoverMarket, category: RankCategory, page: number, size: number): Promise<DiscoverRank> {
    const open = await this.isOpen(market);
    const key = `${market}:${category}`;
    const t = this.now.getTime();
    const need = page * size + 1; // 다음 쪽이 있는지 알기 위해 하나 더
    let st = this.ranks.get(key);
    if (!st || t - st.at >= this.ttl(open)) {
      // 새로 받는다. 실패하면 직전 목록
      try {
        st = await this.fillRank(market, category, { at: t, items: [], next: 0, hasNext: true, source: "" }, need);
        this.ranks.set(key, st);
      } catch (e) {
        if (!st) throw e;
      }
    } else if (st.items.length < need && st.hasNext) {
      try {
        st = await this.fillRank(market, category, st, need);
        this.ranks.set(key, st);
      } catch {
        /* 더 받기 실패: 가진 만큼 */
      }
    }
    const s = st!;
    const items = s.items.slice((page - 1) * size, page * size);
    return {
      market,
      category,
      items,
      page,
      hasMore: s.items.length > page * size || s.hasNext,
      marketOpen: open,
      asOf: seoulIso(new Date(s.at)),
      fxRate: await this.fx(market),
      source: s.source,
      note: category === "gainers" || category === "losers" ? `ETF·ETN·스팩 제외 · 거래대금 ${market === "KR" ? "10억 원" : "100만 달러"} 이상` : "ETF·ETN·스팩 제외",
    };
  }

  /** 원본을 need 개(걸러낸 뒤)가 찰 때까지 이어 받는다. 한 번에 3쪽씩 병렬 */
  private async fillRank(
    market: DiscoverMarket,
    category: RankCategory,
    start: { at: number; items: DiscoverStock[]; next: number; hasNext: boolean; source: string },
    need: number,
  ): Promise<{ at: number; items: DiscoverStock[]; next: number; hasNext: boolean; source: string }> {
    const src: { source: RankSource; name: string } | null =
      market === "KR" ? { source: (c, i) => this.deps.naver.krRankPage(c, i), name: "네이버 증권" } : (this.deps.usRank ?? null);
    if (!src) throw new Error("미국 순위 출처가 설정되지 않았습니다");
    const items = [...start.items];
    const seen = new Set(items.map((i) => i.code));
    let next = start.next;
    let hasNext = start.hasNext;
    const minTv = category === "gainers" || category === "losers" ? MIN_TRADING_VALUE[market] : 0;
    while (items.length < need && hasNext && next < MAX_SOURCE_PAGES) {
      const batch = [next, next + 1, next + 2].filter((i) => i < MAX_SOURCE_PAGES);
      const pages = await Promise.all(batch.map((i) => src.source(category, i)));
      for (const p of pages) {
        for (const it of p.items) {
          if (seen.has(it.code)) continue;
          if (minTv && (it.tradingValue ?? 0) < minTv) continue;
          seen.add(it.code);
          items.push(it);
        }
      }
      next += batch.length;
      hasNext = pages.at(-1)?.hasNext ?? false;
      if (pages.some((p) => !p.hasNext)) hasNext = false;
    }
    return { at: start.at, items, next, hasNext, source: src.name };
  }

  /** 오늘 상장한 한국 종목 (실패하면 빈 집합 — 조정 없이 네이버 값 그대로) */
  private async newlyListed(open: boolean): Promise<Set<string>> {
    try {
      return (await this.cached("kr:newlyListed", this.ttl(open), () => this.deps.naver.newlyListedToday())).value;
    } catch {
      return new Set();
    }
  }

  /**
   * 상장 첫날 종목은 가격제한폭이 없어(+300%) 몇 종목짜리 테마 평균을 크게 왜곡한다(예: 업종 +168%).
   * 그 종목이 대표 종목에 든 테마만 구성 종목을 받아, 그 종목과 거래정지(거래량 0)를 빼고 단순 평균·상승/보합/하락을 다시 센다.
   */
  private async adjustForNewListings(kind: ThemeKind, themes: ThemeSummary[], fresh: Set<string>): Promise<ThemeSummary[]> {
    if (!fresh.size) return themes;
    return Promise.all(
      themes.map(async (th) => {
        if (!th.leaders.some((l) => fresh.has(l.code))) return th;
        try {
          const d = await this.deps.naver.sectorDetail("KR", kind, th.id);
          return d ? recount(th, d.items, fresh) : th;
        } catch {
          return th;
        }
      }),
    );
  }

  async themes(market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod): Promise<ThemeList> {
    const open = await this.isOpen(market);
    const k: ThemeKind = market === "US" ? "sector" : kind;
    const { value, at } = await this.cached(`themes:${market}:${k}:${period}`, this.ttl(open, period !== "day"), async () => {
      const list = await this.deps.naver.sectors(market, k, period);
      // 오늘 등락률만 조정한다 (주·월은 상장 첫날 값이 섞여도 기간 수익률 계산 기준이 달라 네이버 값 그대로)
      return market === "KR" && period === "day" ? this.adjustForNewListings(k, list, await this.newlyListed(open)) : list;
    });
    return {
      market,
      kind,
      period,
      themes: value,
      marketOpen: open,
      asOf: seoulIso(new Date(at)),
      source: "네이버 증권",
      basis: market === "US" ? "산업 분류(TRBC)별 구성 종목 단순 평균" : "구성 종목 등락률 단순 평균(거래정지 제외)",
    };
  }

  async theme(market: DiscoverMarket, kind: ThemeKind, id: string): Promise<ThemeDetail | null> {
    const open = await this.isOpen(market);
    const k: ThemeKind = market === "US" ? "sector" : kind;
    const { value, at } = await this.cached(`theme:${market}:${k}:${id}`, this.ttl(open), () => this.deps.naver.sectorDetail(market, k, id));
    if (!value) return null;
    const fresh = market === "KR" ? await this.newlyListed(open) : new Set<string>();
    const theme = value.items.some((i) => fresh.has(i.code)) ? recount(value.theme, value.items, fresh) : value.theme;
    return {
      market,
      kind,
      theme,
      description: value.description,
      items: value.items,
      marketOpen: open,
      asOf: seoulIso(new Date(at)),
      fxRate: await this.fx(market),
      source: "네이버 증권",
      basis: market === "US" ? "산업 분류(TRBC)별 구성 종목 단순 평균" : "구성 종목 등락률 단순 평균(거래정지 제외)",
    };
  }
}

/** 구성 종목에서 상장 첫날 종목과 거래정지(거래량 0)를 빼고 테마 등락률(단순 평균)·상승/보합/하락 수를 다시 센다 */
export function recount(th: ThemeSummary, items: DiscoverStock[], fresh: Set<string>): ThemeSummary {
  const live = items.filter((i) => !fresh.has(i.code) && (i.volume ?? 1) > 0);
  if (!live.length) return th;
  const avg = live.reduce((s, i) => s + i.changeRate, 0) / live.length;
  const leaders = [...live]
    .sort((a, b) => b.changeRate - a.changeRate)
    .slice(0, 3)
    .map((i) => ({ code: i.code, name: i.name, changeRate: i.changeRate }));
  return {
    ...th,
    changeRate: Math.round(avg * 100) / 100,
    up: live.filter((i) => i.changeRate > 0).length,
    flat: live.filter((i) => i.changeRate === 0).length,
    down: live.filter((i) => i.changeRate < 0).length,
    leaders,
    adjusted: true,
  };
}
