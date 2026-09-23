import { seoulIso } from "../lib/time.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { DiscoverMarket, DiscoverStock, NaverDiscover, RankCategory, ThemeKind, ThemePeriod, ThemeSummary } from "../providers/market/naverDiscover.js";
import type { TicsRankRow, TossTics } from "../providers/market/tossTics.js";
import { latestTradeDay, pool, usThemeSummary, UsThemesBuildingError, type UsThemeBook, type UsThemeBookData } from "./usThemes.js";

/**
 * 발견 탭 서비스: 순위(거래대금·거래량·급상승·급하락)와 테마·업종(오늘/1주/1개월), 테마 구성 종목.
 *  - 캐시: 그 나라 장이 열려 있으면 30초, 닫혀 있으면 5분 (주·월 등락률은 장중에도 2분)
 *  - 조회가 실패하면 직전 값을 그대로 준다(stale). 직전 값도 없으면 오류
 *  - 급상승·급하락은 거래대금 한국 10억 원·미국 100만 달러 미만을 빼서 동전주가 뜨지 않게 한다
 *  - ETF·ETN·스팩은 순위에서 뺀다 (종목만)
 *  - 미국 테마는 토스 테마 분류에 네이버 정규장 시세를 붙여 직접 계산한다 (usThemes.ts)
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
  /** 범위·대체 안내 (없으면 null) */
  note: string | null;
  /** 테마 구성(소속 종목)을 마지막으로 새로 만든 시각 — 미국 테마만 (한국은 매번 출처에서 받는다) */
  updatedAt?: string | null;
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
  note: string | null;
  updatedAt?: string | null;
}

/** 순위 원본: 정렬된 전체 목록을 앞에서부터 한 쪽씩 (없으면 빈 목록, hasNext 로 끝) */
export type RankSource = (category: RankCategory, index: number) => Promise<{ items: DiscoverStock[]; hasNext: boolean; tradedAt?: string | null }>;

type RankState = { at: number; items: DiscoverStock[]; next: number; hasNext: boolean; source: string; tradedAt: string | null };

export const MIN_TRADING_VALUE: Record<DiscoverMarket, number> = { KR: 1_000_000_000, US: 1_000_000 };
const MAX_SOURCE_PAGES = 12;
/** 한국 가격제한폭(%) — 넘으면 상장 첫날이거나 정리매매 */
const KR_LIMIT_PCT = 30.5;
/** 분류별 정렬 기준 값 */
const RANK_KEY: Record<RankCategory, (s: DiscoverStock) => number | null> = {
  tradingValue: (s) => s.tradingValue,
  volume: (s) => s.volume,
  gainers: (s) => s.changeRate,
  losers: (s) => s.changeRate,
};
/** 미국 테마북을 처음 만드는 동안(약 1분) 요청이 기다리는 최대 시간 */
const BOOK_WAIT_MS = 20_000;

type Cached<T> = { at: number; value: T };

export class DiscoverService {
  private readonly cache = new Map<string, Cached<unknown>>();
  /** 순위는 쪽을 이어 받으므로 (시장, 분류)별로 누적 상태를 둔다 */
  private readonly ranks = new Map<string, RankState>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      naver: NaverDiscover;
      /** 미국 순위 원본 (없으면 네이버 미국 순위) */
      usRank?: { source: RankSource; name: string } | null;
      calendar?: MarketCalendar | null;
      usdKrw?: (() => Promise<number | null>) | null;
      now?: () => Date;
      /** 미국 테마 (토스 테마 분류 + 네이버 정규장 시세). 없으면 미국은 산업 분류만 */
      usThemes?: UsThemeBook | null;
      tics?: TossTics | null;
      /** 미국 테마북을 처음 만드는 동안 기다리는 최대 시간 (기본 20초) */
      bookWaitMs?: number;
    },
  ) {}

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /**
   * 장중인지. 한국은 달력 그대로(KRX+NXT 08:00~20:00 — 통합 가격이 계속 바뀐다).
   * 미국은 정규장(뉴욕 09:30~16:00)만 장중으로 본다: 달력은 프리~애프터를 모두 열림으로 보지만 발견 탭 값은 정규장 기준이라
   * 장 시작 전·마감 뒤에는 "장 마감"으로 보여야 한다.
   */
  private async isOpen(market: DiscoverMarket): Promise<boolean> {
    if (!this.deps.calendar) return false;
    try {
      const s = await this.deps.calendar.status();
      return market === "KR" ? s.KR.isOpen : s.US.isOpen && isUsRegularHours(this.now);
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
      // 새로 받는다. 실패하거나(장 시작 전처럼) 빈 목록이 오면 직전 목록
      try {
        const fresh = await this.fillRank(market, category, { at: t, items: [], next: 0, hasNext: true, source: "", tradedAt: null }, need);
        if (fresh.items.length || !st?.items.length) {
          st = fresh;
          this.ranks.set(key, st);
        }
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
      // 출처가 체결 시각을 주면 그 시각(미국 장 마감 뒤엔 정규장 종료 시각), 아니면 받은 시각
      asOf: seoulIso(new Date(s.tradedAt ?? s.at)),
      fxRate: await this.fx(market),
      source: s.source,
      note: [
        market === "KR" ? (category === "gainers" || category === "losers" ? "ETF·ETN·스팩·정리매매 제외" : "ETF·ETN·스팩 제외") : "ETF·우선주·권리주 제외",
        category === "gainers" || category === "losers" ? `거래대금 ${market === "KR" ? "10억 원" : "100만 달러"} 이상` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  /** 원본을 need 개(걸러낸 뒤)가 찰 때까지 이어 받는다. 한 번에 3쪽씩 병렬 */
  private async fillRank(
    market: DiscoverMarket,
    category: RankCategory,
    start: RankState,
    need: number,
  ): Promise<RankState> {
    const src: { source: RankSource; name: string } =
      market === "KR"
        ? { source: (c, i) => this.deps.naver.krRankPage(c, i), name: "네이버 증권" }
        : (this.deps.usRank ?? { source: (c, i) => this.deps.naver.usRankPage(c, i), name: "네이버 증권" });
    const items = [...start.items];
    const seen = new Set(items.map((i) => i.code));
    let next = start.next;
    let hasNext = start.hasNext;
    let tradedAt = start.tradedAt;
    const movers = category === "gainers" || category === "losers";
    const minTv = movers ? MIN_TRADING_VALUE[market] : 0;
    while (items.length < need && hasNext && next < MAX_SOURCE_PAGES) {
      const batch = [next, next + 1, next + 2].filter((i) => i < MAX_SOURCE_PAGES);
      const pages = await Promise.all(batch.map((i) => src.source(category, i)));
      for (const p of pages) {
        if (p.tradedAt && (!tradedAt || Date.parse(p.tradedAt) > Date.parse(tradedAt))) tradedAt = p.tradedAt;
        for (const it of p.items) {
          if (seen.has(it.code)) continue;
          if (minTv && (it.tradingValue ?? 0) < minTv) continue;
          // 한국 가격제한폭(±30%)을 넘는데 상장 첫날이 아니면 정리매매·기준가 변경 종목이라 뺀다 (예: -96%)
          if (movers && market === "KR" && Math.abs(it.changeRate) > KR_LIMIT_PCT && !it.newlyListed) continue;
          seen.add(it.code);
          items.push(it);
        }
      }
      next += batch.length;
      hasNext = pages.at(-1)?.hasNext ?? false;
      if (pages.some((p) => !p.hasNext)) hasNext = false;
    }
    // 출처 순위는 가격보다 늦게 갱신돼 순서가 조금씩 어긋난다 → 받은 값으로 다시 정렬 (같으면 원래 순서)
    const key = RANK_KEY[category];
    const dir = category === "losers" ? 1 : -1;
    const sorted = items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => dir * ((key(a.it) ?? -Infinity) - (key(b.it) ?? -Infinity)) || a.i - b.i)
      .map((x) => x.it);
    return { at: start.at, items: sorted, next, hasNext, source: src.name, tradedAt };
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
    if (market === "US" && kind === "theme" && this.deps.usThemes) {
      try {
        return await this.usThemeList(open, period);
      } catch (e) {
        // 토스 테마를 못 받거나 처음 만드는 중이면 네이버 산업 분류로 대신 (빈 화면·긴 기다림보다 낫다)
        const alt = await this.naverThemes("US", "sector", period, open);
        const why = e instanceof UsThemesBuildingError ? "미국 테마를 처음 준비하는 중이라(약 1분)" : "미국 테마를 불러오지 못해";
        return { ...alt, note: `${why} 산업 분류로 대신 보여 줍니다` };
      }
    }
    return this.naverThemes(market, market === "US" ? "sector" : kind, period, open);
  }

  private async naverThemes(market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod, open: boolean): Promise<ThemeList> {
    const { value, at } = await this.cached(`themes:${market}:${kind}:${period}`, this.ttl(open, period !== "day"), async () => {
      const list = await this.deps.naver.sectors(market, kind, period);
      // 오늘 등락률만 조정한다 (주·월은 상장 첫날 값이 섞여도 기간 수익률 계산 기준이 달라 네이버 값 그대로)
      return market === "KR" && period === "day" ? this.adjustForNewListings(kind, list, await this.newlyListed(open)) : list;
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
      note: null,
    };
  }

  /** 미국 테마북 구성 종목 전체의 정규장 시세 (한 번에, 캐시) */
  private async usThemeQuotes(book: UsThemeBookData, open: boolean) {
    const codes = [...new Set(book.themes.flatMap((t) => t.members.map((m) => m.reuters)))];
    const key = `usq:${book.builtAt}`;
    // 테마북이 새로 만들어지면 옛 시세 묶음은 버린다 (하루에 하나씩 쌓이지 않게)
    for (const k of this.cache.keys()) if (k.startsWith("usq:") && k !== key) this.cache.delete(k);
    return this.cached(key, this.ttl(open), () => this.deps.naver.usQuotes(codes));
  }

  private async usThemeList(open: boolean, period: ThemePeriod): Promise<ThemeList> {
    const usThemes = this.deps.usThemes!;
    if (period === "day") {
      const book = await usThemes.get(this.deps.bookWaitMs ?? BOOK_WAIT_MS);
      const { value: quotes, at } = await this.usThemeQuotes(book, open);
      const day = latestTradeDay(quotes.values());
      // 구성 종목 거래대금 합이 100만 달러 미만인 테마(동전주 몇 개짜리)는 뺀다 — 급상승 순위와 같은 기준
      const rows = book.themes.map((t) => usThemeSummary(t, quotes, day)).filter((x): x is NonNullable<typeof x> => !!x);
      const themes = rows.filter((r) => r.tradingValue >= MIN_TRADING_VALUE.US).map((r) => r.summary);
      const dropped = rows.length - themes.length;
      const tradedAt = [...quotes.values()].map((q) => q.tradedAt).filter((x): x is string => !!x && !Number.isNaN(Date.parse(x))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      return {
        market: "US",
        kind: "theme",
        period,
        themes,
        marketOpen: open,
        asOf: seoulIso(new Date(tradedAt ?? at)),
        source: "토스증권 테마 분류 · 네이버 증권 시세",
        basis: "테마별 시가총액 상위 종목의 시가총액 가중 평균 (정규장)",
        note: dropped ? `거래대금 100만 달러 미만 테마 ${dropped}개 제외` : null,
        updatedAt: seoulIso(new Date(book.builtAt)),
      };
    }
    // 1주·1개월: 토스 테마 기간 등락률 (미국 종목만, 시가총액 가중). 순위(상위 약 100개)에 없는 테마는 하나씩 묻는다
    const { value, at } = await this.cached(`themes:US:theme:${period}`, open ? 15 * 60_000 : 60 * 60_000, async () => {
      const book = await usThemes.get(this.deps.bookWaitMs ?? BOOK_WAIT_MS);
      const tics = this.deps.tics!;
      const dur = period === "week" ? "1w" : "1m";
      const rows = new Map<string, TicsRankRow>();
      for (const sortBy of ["FLUCTUATION_RATE", "TRADING_AMOUNT"] as const) {
        try {
          for (const r of await tics.ranking("US", dur, sortBy)) if (!rows.has(r.id)) rows.set(r.id, r);
        } catch {
          /* 하나씩 묻기로 채운다 */
        }
      }
      // 오늘 목록과 같은 테마만 (거래가 거의 없는 테마 제외)
      let liquid: Set<string> | null = null;
      try {
        const { value: quotes } = await this.usThemeQuotes(book, open);
        const day = latestTradeDay(quotes.values());
        liquid = new Set(book.themes.filter((t) => (usThemeSummary(t, quotes, day)?.tradingValue ?? 0) >= MIN_TRADING_VALUE.US).map((t) => t.id));
      } catch {
        /* 시세를 못 받으면 거르지 않는다 */
      }
      const targets = liquid ? book.themes.filter((t) => liquid!.has(t.id)) : book.themes;
      const missing = targets.filter((t) => !rows.has(t.id));
      const extra = await pool(missing, 6, async (t) => {
        try {
          return [t.id, await tics.periodRate(t.id, "US", dur)] as const;
        } catch {
          return [t.id, null] as const;
        }
      });
      const rate = new Map<string, number>([...rows].map(([id, r]) => [id, r.rate]));
      for (const [id, r] of extra) if (r !== null) rate.set(id, r);
      const symbolOf = new Map(book.themes.flatMap((t) => t.members.map((m) => [m.productCode, m.symbol] as const)));
      const themes: ThemeSummary[] = [];
      for (const t of targets) {
        const r = rate.get(t.id);
        if (r === undefined) continue;
        const lead = rows.get(t.id)?.leader;
        const code = lead ? symbolOf.get(lead.productCode) : undefined;
        themes.push({ id: t.id, name: t.name, changeRate: Math.round(r * 100) / 100, up: 0, flat: 0, down: 0, leaders: code && lead ? [{ code, name: lead.name, changeRate: null }] : [] });
      }
      if (!themes.length) throw new Error("토스 테마 기간 등락률을 받지 못했습니다");
      return { themes, total: targets.length, builtAt: book.builtAt };
    });
    return {
      market: "US",
      kind: "theme",
      period,
      themes: value.themes,
      marketOpen: open,
      asOf: seoulIso(new Date(at)),
      source: "토스증권",
      basis: `토스증권 테마 ${period === "week" ? "1주" : "1개월"} 등락률 (미국 종목, 시가총액 가중)`,
      note: value.themes.length < value.total ? `기간 등락률을 받은 테마만 (${value.themes.length}/${value.total}개)` : null,
      updatedAt: seoulIso(new Date(value.builtAt)),
    };
  }

  async theme(market: DiscoverMarket, kind: ThemeKind, id: string): Promise<ThemeDetail | null> {
    const open = await this.isOpen(market);
    if (market === "US" && kind === "theme" && this.deps.usThemes) return this.usTheme(open, id);
    const k: ThemeKind = market === "US" ? "sector" : kind;
    const { value, at } = await this.cached(`theme:${market}:${k}:${id}`, this.ttl(open), () => this.deps.naver.sectorDetail(market, k, id));
    if (!value) return null;
    const fresh = market === "KR" ? await this.newlyListed(open) : new Set<string>();
    const theme = value.items.some((i) => fresh.has(i.code)) ? recount(value.theme, value.items, fresh) : value.theme;
    return {
      market,
      kind: k,
      theme,
      description: value.description,
      items: value.items,
      marketOpen: open,
      asOf: seoulIso(new Date(at)),
      fxRate: await this.fx(market),
      source: "네이버 증권",
      basis: market === "US" ? "산업 분류(TRBC)별 구성 종목 단순 평균" : "구성 종목 등락률 단순 평균(거래정지 제외)",
      note: null,
    };
  }

  private async usTheme(open: boolean, id: string): Promise<ThemeDetail | null> {
    const usThemes = this.deps.usThemes!;
    const book = await usThemes.get(this.deps.bookWaitMs ?? BOOK_WAIT_MS);
    const t = book.themes.find((x) => x.id === id);
    if (!t) return null;
    const { value: quotes, at } = await this.usThemeQuotes(book, open);
    const r = usThemeSummary(t, quotes, latestTradeDay(quotes.values()));
    if (!r) return null;
    const tradedAt = t.members
      .map((m) => quotes.get(m.reuters)?.tradedAt)
      .filter((x): x is string => !!x && !Number.isNaN(Date.parse(x)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1);
    return {
      market: "US",
      kind: "theme",
      theme: r.summary,
      description: await usThemes.summary(id),
      items: r.items,
      marketOpen: open,
      asOf: seoulIso(new Date(tradedAt ?? at)),
      fxRate: await this.fx("US"),
      source: "토스증권 테마 분류 · 네이버 증권 시세",
      basis: "시가총액 가중 평균 (정규장)",
      note: t.total > t.members.length ? `시가총액 상위 ${t.members.length}종목 기준 (토스 분류 전체 ${t.total}종목)` : null,
      updatedAt: seoulIso(new Date(book.builtAt)),
    };
  }
}

/** 뉴욕 현지 평일 09:30~16:00 (휴장일은 달력이 거른다) */
export function isUsRegularHours(d: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const m = Number(get("hour")) * 60 + Number(get("minute"));
  return m >= 9 * 60 + 30 && m < 16 * 60;
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
    changeRate: Math.round(avg * 100) / 100 || 0,
    up: live.filter((i) => i.changeRate > 0).length,
    flat: live.filter((i) => i.changeRate === 0).length,
    down: live.filter((i) => i.changeRate < 0).length,
    leaders,
    adjusted: true,
  };
}
