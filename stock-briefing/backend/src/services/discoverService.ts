import { seoulIso } from "../lib/time.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import { isPreopenQuotes, type DiscoverMarket, type DiscoverStock, type NaverDiscover, type RankCategory, type SectorDetail, type ThemeKind, type ThemePeriod, type ThemeSummary, type UsQuote } from "../providers/market/naverDiscover.js";
import type { CodeStore } from "../providers/market/toss.js";
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
export type RankSource = (category: RankCategory, index: number) => Promise<{ items: DiscoverStock[]; hasNext: boolean; tradedAt?: string | null; preopen?: boolean }>;

type RankState = { at: number; items: DiscoverStock[]; next: number; hasNext: boolean; source: string; tradedAt: string | null; preopen?: boolean; fromSnapshot?: boolean };

/** 네이버가 장 시작 전으로 초기화해 쓸 값이 없고 저장본도 없을 때 */
export class PreopenError extends Error {
  constructor(what: string) {
    super(`${what}: 장 시작 전이라 직전 정규장 값이 아직 없습니다`);
    this.name = "PreopenError";
  }
}

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
/** 미국 테마북을 처음 만드는 동안(약 1분) 요청이 기다리는 최대 시간 — 앱 제한 시간(20초)보다 훨씬 짧게 */
const BOOK_WAIT_MS = 3_000;
/** 앱이 받을 수 있는 순위 쪽 상한 (라우트 page ≤ 20) */
const MAX_PAGE = 20;
/** 직전 값이 있으면 새 조회를 이만큼만 기다리고 직전 값을 준다 (새 값은 뒤에서 채운다) */
const STALE_WAIT_MS = 2_500;
/** 실패한 조회는 이 시간 동안 다시 하지 않는다 (상류 장애 때 요청마다 다시 부르지 않게). 비싼 조회(미국 테마 기간 등락률)는 10분 */
const FAIL_RETRY_MS = 20_000;
const FAIL_COOLDOWN_MS = 10 * 60_000;
/** 구성 종목을 이만큼 받았으면 잘렸을 수 있어 신규상장 조정을 하지 않는다 */
const SECTOR_MAX_ITEMS = 300;
/** 직전 정규장 저장본(meta)을 쓰는 기간과 저장 간격 */
const SNAP_MAX_AGE_MS = 5 * 24 * 3_600_000;
const SNAP_PERSIST_EVERY_MS = 10 * 60_000;
/** 순위 저장본에 남기는 줄 수 */
const SNAP_RANK_ITEMS = 600;

type Cached<T> = { at: number; value: T };

export class DiscoverService {
  private readonly cache = new Map<string, Cached<unknown>>();
  /** 순위는 쪽을 이어 받으므로 (시장, 분류)별로 누적 상태를 둔다 */
  private readonly ranks = new Map<string, RankState>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, { at: number; error: unknown }>();
  /** 미국 테마 기간 등락률의 정규장 중 스냅숏 */
  private readonly periodSnaps = new Map<ThemePeriod, UsPeriodSnapshot>();
  /** 직전 정규장 저장본 (메모리 + meta 표). 네이버가 장 시작 전으로 초기화한 시간에 쓴다 */
  private readonly snaps = new Map<string, { savedAt: number; persistedAt: number; value: unknown }>();

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
      /** 미국 테마북을 처음 만드는 동안 기다리는 최대 시간 (기본 3초) */
      bookWaitMs?: number;
      /** 미국 테마 기간 등락률의 "정규장 중" 스냅숏을 남길 곳 (meta 표) */
      store?: CodeStore | null;
      /** 직전 값이 있을 때 새 조회를 기다리는 시간 (기본 2.5초, 테스트용) */
      staleWaitMs?: number;
    },
  ) {}

  private get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /**
   * 장중인지 — 발견 탭 값의 기준 세션만 본다.
   *  - 한국: 네이버 순위·테마 값은 KRX 기준이라 KRX 정규장(09:00~15:30)만 장중. 달력은 NXT(08:00~20:00)까지 열림으로 본다
   *  - 미국: 정규장(뉴욕 09:30~16:00)만 장중. 달력은 프리~애프터를 모두 열림으로 본다
   */
  private async isOpen(market: DiscoverMarket): Promise<boolean> {
    if (!this.deps.calendar) return false;
    try {
      const s = await this.deps.calendar.status();
      return market === "KR" ? s.KR.isTradingDay && isKrxRegularHours(this.now) : s.US.isOpen && isUsRegularHours(this.now);
    } catch {
      return false;
    }
  }

  /** 장이 닫혀 있을 때 한국 값의 기준 시각 = 직전 KRX 정규장 마감(15:30). 휴장이 이어지면 주말만 거른 근사 */
  private async krClosedAsOf(): Promise<string | null> {
    try {
      const s = this.deps.calendar ? await this.deps.calendar.status() : null;
      return lastKrxClose(this.now, s?.KR.isTradingDay ?? true);
    } catch {
      return null;
    }
  }

  private ttl(open: boolean, slow = false): number {
    return open ? (slow ? 120_000 : 30_000) : 5 * 60_000;
  }

  private async fx(market: DiscoverMarket): Promise<number | null> {
    if (market !== "US" || !this.deps.usdKrw) return null;
    return this.deps.usdKrw().catch(() => null);
  }

  /**
   * 캐시 → 없거나 오래되면 조회(같은 키는 한 번만) → 실패하면 직전 값.
   * 직전 값이 있으면 새 조회를 STALE_WAIT_MS 만 기다리고 직전 값을 준다(느린 출처가 화면을 붙잡지 않게, 새 값은 뒤에서 채운다).
   * 직전 값이 없는 실패는 잠시(기본 20초, 비싼 조회는 10분) 기억해 같은 오류를 바로 준다(상류 장애 때 요청마다 다시 부르지 않게).
   */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>, failCooldownMs = FAIL_RETRY_MS): Promise<{ value: T; at: number }> {
    const hit = this.cache.get(key) as Cached<T> | undefined;
    const t = this.now.getTime();
    if (hit && t - hit.at < ttl) return { value: hit.value, at: hit.at };
    const failed = this.failures.get(key);
    if (!hit && failed && t - failed.at < failCooldownMs) throw failed.error;
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      const started = t;
      p = load()
        .then((value) => {
          this.cache.set(key, { at: started, value });
          this.failures.delete(key);
          return value;
        })
        .catch((e: unknown) => {
          this.failures.set(key, { at: started, error: e });
          throw e;
        })
        .finally(() => this.inflight.delete(key));
      p.catch(() => undefined); // 뒤에서 끝난 실패가 처리되지 않은 거부로 남지 않게
      this.inflight.set(key, p);
    }
    try {
      if (hit) {
        const r = await Promise.race([p.then((v) => ({ v })), new Promise<null>((res) => setTimeout(() => res(null), this.deps.staleWaitMs ?? STALE_WAIT_MS))]);
        if (!r) return { value: hit.value, at: hit.at };
        return { value: r.v, at: (this.cache.get(key) as Cached<T>).at };
      }
      const value = await p;
      return { value, at: (this.cache.get(key) as Cached<T> | undefined)?.at ?? t };
    } catch (e) {
      if (hit) return { value: hit.value, at: hit.at };
      throw e;
    }
  }

  /** 직전 정규장 저장본 쓰기 — 메모리는 늘, meta 표는 10분에 한 번(또는 force) */
  private async saveSnap(key: string, value: unknown, force = false): Promise<void> {
    const t = this.now.getTime();
    const prev = this.snaps.get(key);
    const persist = force || !prev || t - prev.persistedAt >= SNAP_PERSIST_EVERY_MS;
    this.snaps.set(key, { savedAt: t, persistedAt: persist ? t : (prev?.persistedAt ?? 0), value });
    if (persist) await this.deps.store?.set(`discover:snap:${key}`, JSON.stringify({ savedAt: t, value })).catch(() => undefined);
  }

  /** 직전 정규장 저장본 읽기 (5일 넘으면 버림) */
  private async loadSnap<T>(key: string): Promise<{ savedAt: number; value: T } | null> {
    const t = this.now.getTime();
    const mem = this.snaps.get(key);
    if (mem) return t - mem.savedAt < SNAP_MAX_AGE_MS ? { savedAt: mem.savedAt, value: mem.value as T } : null;
    try {
      const raw = await this.deps.store?.get(`discover:snap:${key}`);
      if (!raw) return null;
      const v = JSON.parse(raw) as { savedAt: number; value: T };
      if (typeof v.savedAt !== "number" || t - v.savedAt >= SNAP_MAX_AGE_MS) return null;
      this.snaps.set(key, { savedAt: v.savedAt, persistedAt: v.savedAt, value: v.value });
      return v;
    } catch {
      return null;
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
        if (fresh.items.length && !fresh.preopen) {
          st = fresh;
          this.ranks.set(key, st);
          // 정규장 값이 있을 때 저장본을 남긴다 (재시작 뒤 장 시작 전에도 직전 정규장 순위를 보여 주려고)
          void this.saveSnap(`rank:${key}`, { ...fresh, items: fresh.items.slice(0, SNAP_RANK_ITEMS) }, !open);
        } else if (st?.items.length && !st.fromSnapshot) {
          // 장 시작 전처럼 빈 목록·0% 목록이 오면 가진 직전 목록을 그대로 (다음 확인은 TTL 뒤)
          st = { ...st, at: t };
          this.ranks.set(key, st);
        } else {
          const snap = await this.loadSnap<RankState>(`rank:${key}`);
          if (snap) {
            // 저장본은 더 이어 받지 않는다 (지금 출처는 비어 있으므로)
            st = { ...snap.value, at: t, next: MAX_SOURCE_PAGES, hasNext: false, fromSnapshot: true };
            this.ranks.set(key, st);
          } else if (!st) {
            st = { ...fresh, items: fresh.preopen ? [] : fresh.items };
            this.ranks.set(key, st);
          }
        }
      } catch (e) {
        if (!st) {
          const snap = await this.loadSnap<RankState>(`rank:${key}`);
          if (!snap) throw e;
          st = { ...snap.value, at: t, next: MAX_SOURCE_PAGES, hasNext: false, fromSnapshot: true };
          this.ranks.set(key, st);
        }
      }
    } else if (st.items.length < need && st.hasNext && !st.fromSnapshot) {
      try {
        st = await this.fillRank(market, category, st, need);
        this.ranks.set(key, st);
      } catch {
        /* 더 받기 실패: 가진 만큼 */
      }
    }
    const s = st!;
    const items = s.items.slice((page - 1) * size, page * size);
    // 기준 시각: 출처가 체결 시각을 주면 그 시각(미국), 한국 장 마감 뒤엔 직전 KRX 마감, 아니면 받은 시각
    const asOf = s.tradedAt ? seoulIso(new Date(s.tradedAt)) : market === "KR" && !open ? ((await this.krClosedAsOf()) ?? seoulIso(new Date(s.at))) : seoulIso(new Date(s.at));
    return {
      market,
      category,
      items,
      page,
      hasMore: page < MAX_PAGE && items.length > 0 && (s.items.length > page * size || s.hasNext),
      marketOpen: open,
      asOf,
      fxRate: await this.fx(market),
      source: s.source,
      note: [
        !s.items.length && !open ? "장 시작 전이라 출처가 목록을 비워 두었습니다 (정규장이 열리면 채워집니다)" : null,
        market === "KR" ? (category === "gainers" || category === "losers" ? "KRX 기준 · ETF·ETN·스팩·정리매매 제외" : "KRX 기준 · ETF·ETN·스팩 제외") : "ETF·우선주·권리주 제외",
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
    let preopen = false;
    const movers = category === "gainers" || category === "losers";
    const minTv = movers ? MIN_TRADING_VALUE[market] : 0;
    while (items.length < need && hasNext && next < MAX_SOURCE_PAGES) {
      const batch = [next, next + 1, next + 2].filter((i) => i < MAX_SOURCE_PAGES);
      const pages = await Promise.all(batch.map((i) => src.source(category, i)));
      for (const p of pages) {
        if (p.preopen) preopen = true;
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
      if (preopen) break; // 장 시작 전 초기화 — 더 받아도 쓸 값이 없다
    }
    // 원본 쪽 상한에 닿으면 끝 (빈 "더 보기"가 이어지지 않게)
    if (next >= MAX_SOURCE_PAGES) hasNext = false;
    // 출처 순위는 가격보다 늦게 갱신돼 순서가 조금씩 어긋난다 → 이번에 새로 받은 것만 받은 값으로 다시 정렬해 뒤에 붙인다.
    // 이미 앱에 내려보낸 앞부분의 순서는 건드리지 않는다 (쪽 경계에서 종목이 빠지거나 두 번 나오지 않게)
    const key = RANK_KEY[category];
    const dir = category === "losers" ? 1 : -1;
    const added = items
      .slice(start.items.length)
      .map((it, i) => ({ it, i }))
      .sort((a, b) => dir * ((key(a.it) ?? -Infinity) - (key(b.it) ?? -Infinity)) || a.i - b.i)
      .map((x) => x.it);
    return { at: start.at, items: [...start.items, ...added], next, hasNext, source: src.name, tradedAt, preopen };
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
   * 그 종목이 대표 종목(네이버 topItems = 등락률 상위 3)에 든 테마만 구성 종목을 받아, 그 종목과 거래정지(거래량 0)를 빼고 다시 센다.
   * 테마는 단순 평균, 업종은 시가총액 가중 — 네이버와 같은 방식으로.
   */
  private async adjustForNewListings(kind: ThemeKind, themes: ThemeSummary[], fresh: Set<string>): Promise<ThemeSummary[]> {
    if (!fresh.size) return themes;
    return Promise.all(
      themes.map(async (th) => {
        if (!th.leaders.some((l) => fresh.has(l.code))) return th;
        try {
          const d = await this.deps.naver.sectorDetail("KR", kind, th.id);
          return d && d.items.length < SECTOR_MAX_ITEMS ? recount(th, d.items, fresh, kind === "sector") : th;
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
        const why =
          e instanceof UsThemesBuildingError
            ? "미국 테마를 처음 준비하는 중이라(약 1분)"
            : e instanceof PreopenError
              ? "미국 장 시작 전이라 직전 정규장 테마 값이 아직 없어"
              : "미국 테마를 불러오지 못해";
        return { ...alt, note: `${why} 산업 분류로 대신 보여 줍니다` };
      }
    }
    return this.naverThemes(market, market === "US" ? "sector" : kind, period, open);
  }

  private async naverThemes(market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod, open: boolean): Promise<ThemeList> {
    const snapKey = `themes:${market}:${kind}:${period}`;
    const { value, at } = await this.cached(`themes:${market}:${kind}:${period}`, this.ttl(open, period !== "day"), async () => {
      const list = await this.deps.naver.sectors(market, kind, period);
      // 장 시작 전 초기화(모든 등락률 0)면 직전 정규장 저장본을 쓴다
      if (list.length > 5 && list.every((x) => x.changeRate === 0)) {
        const snap = await this.loadSnap<ThemeSummary[]>(snapKey);
        if (snap) return snap.value;
        return list;
      }
      // 오늘 등락률만 조정한다 (주·월은 상장 첫날 값이 섞여도 기간 수익률 계산 기준이 달라 네이버 값 그대로)
      const out = market === "KR" && period === "day" ? await this.adjustForNewListings(kind, list, await this.newlyListed(open)) : list;
      void this.saveSnap(snapKey, out, !open);
      return out;
    });
    return {
      market,
      kind,
      period,
      themes: value,
      marketOpen: open,
      asOf: market === "KR" && !open ? ((await this.krClosedAsOf()) ?? seoulIso(new Date(at))) : seoulIso(new Date(at)),
      source: "네이버 증권",
      basis: naverBasis(market, kind),
      note: null,
    };
  }

  /** 미국 테마북 구성 종목 전체의 정규장 시세 (한 번에, 캐시) */
  private async usThemeQuotes(book: UsThemeBookData, open: boolean) {
    const codes = [...new Set(book.themes.flatMap((t) => t.members.map((m) => m.reuters)))];
    const key = `usq:${book.builtAt}`;
    // 테마북이 새로 만들어지면 옛 시세 묶음은 버린다 (하루에 하나씩 쌓이지 않게)
    for (const k of this.cache.keys()) if (k.startsWith("usq:") && k !== key) this.cache.delete(k);
    return this.cached(key, this.ttl(open), async () => {
      const q = await this.deps.naver.usQuotes(codes);
      if (isPreopenQuotes(q)) {
        // 뉴욕 새벽~정규장 전: 네이버가 등락률·거래량을 0 으로 초기화한다 → 직전 정규장 저장본
        const snap = await this.loadSnap<[string, UsQuote][]>("usq");
        if (snap) return new Map(snap.value);
        throw new PreopenError("미국 테마 시세");
      }
      void this.saveSnap("usq", [...q.entries()], !open);
      return q;
    });
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
    const snap = await this.usPeriodRates(open, period);
    const word = period === "week" ? "1주" : "1개월";
    const when = snap.inSession ? (open ? null : `직전 정규장 중 ${hm(snap.capturedAt)} 값`) : "토스 현재가 기준이라 주간·프리·애프터 가격이 섞일 수 있음";
    return {
      market: "US",
      kind: "theme",
      period,
      themes: snap.themes,
      marketOpen: open,
      asOf: seoulIso(new Date(snap.capturedAt)),
      source: "토스증권",
      basis: `토스증권 테마 ${word} 등락률 (미국 종목, 시가총액 가중)`,
      note: [
        when,
        `${word}은 테마 등락률만 제공 (상승·하락 종목 수 없음)`,
        snap.themes.length < snap.total ? `기간 등락률을 받은 테마만 (${snap.themes.length}/${snap.total}개)` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      updatedAt: seoulIso(new Date(snap.builtAt)),
    };
  }

  /**
   * 미국 테마 1주·1개월 등락률. 토스 값은 그때의 현재가 기준이라 장 밖(한국 낮)에는 주간거래·프리·애프터 가격이 섞인다.
   * 그래서 미국 정규장 중에 받은 값을 남겨 두고(meta), 장 밖에는 그 값을 쓴다. 남긴 값이 없을 때만 지금 값을 받아 그렇다고 밝힌다.
   */
  private async usPeriodRates(open: boolean, period: ThemePeriod): Promise<UsPeriodSnapshot> {
    const storeKey = `discover:us-tics-period:${period}`;
    if (!open) {
      const kept = this.periodSnaps.get(period) ?? (await this.loadPeriodSnap(storeKey));
      if (kept && this.now.getTime() - kept.capturedAt < 4 * 24 * 3_600_000) {
        this.periodSnaps.set(period, kept);
        return kept;
      }
    }
    const { value } = await this.cached(`usperiod:${period}:${open ? "open" : "closed"}`, open ? 15 * 60_000 : 60 * 60_000, () => this.computePeriodRates(open, period), FAIL_COOLDOWN_MS);
    if (value.inSession && this.periodSnaps.get(period)?.capturedAt !== value.capturedAt) {
      this.periodSnaps.set(period, value);
      await this.deps.store?.set(storeKey, JSON.stringify(value)).catch(() => undefined);
    }
    return value;
  }

  private async loadPeriodSnap(key: string): Promise<UsPeriodSnapshot | null> {
    try {
      const raw = await this.deps.store?.get(key);
      const v = raw ? (JSON.parse(raw) as UsPeriodSnapshot) : null;
      return v && Array.isArray(v.themes) && typeof v.capturedAt === "number" ? v : null;
    } catch {
      return null;
    }
  }

  private async computePeriodRates(open: boolean, period: ThemePeriod): Promise<UsPeriodSnapshot> {
    const usThemes = this.deps.usThemes!;
    const book = await usThemes.get(this.deps.bookWaitMs ?? BOOK_WAIT_MS);
    const tics = this.deps.tics!;
    const dur = period === "week" ? "1w" : "1m";
    const capturedAt = this.now.getTime();
    const rows = new Map<string, TicsRankRow>();
    let rankOk = 0;
    for (const sortBy of ["FLUCTUATION_RATE", "TRADING_AMOUNT"] as const) {
      try {
        for (const r of await tics.ranking("US", dur, sortBy)) if (!rows.has(r.id)) rows.set(r.id, r);
        rankOk++;
      } catch {
        /* 하나씩 묻기로 채운다 */
      }
    }
    // 순위가 둘 다 실패하면 토스가 막힌 것 — 테마마다 수백 번 묻지 않고 바로 실패
    if (!rankOk) throw new Error("토스 테마 기간 순위를 받지 못했습니다");
    // 오늘 목록과 같은 테마만 (거래가 거의 없는 테마 제외), 대표 종목은 시가총액 상위 3
    let quotes: Awaited<ReturnType<NaverDiscover["usQuotes"]>> | null = null;
    try {
      quotes = (await this.usThemeQuotes(book, open)).value;
    } catch {
      /* 시세를 못 받으면 거르지 않는다 */
    }
    const day = quotes ? latestTradeDay(quotes.values()) : "";
    const targets = quotes ? book.themes.filter((t) => (usThemeSummary(t, quotes!, day)?.tradingValue ?? 0) >= MIN_TRADING_VALUE.US) : book.themes;
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
    const themes: ThemeSummary[] = [];
    for (const t of targets) {
      const r = rate.get(t.id);
      if (r === undefined) continue;
      const leaders = quotes
        ? t.members
            .map((m) => quotes!.get(m.reuters))
            .filter((q): q is NonNullable<typeof q> => !!q)
            .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
            .slice(0, 3)
            .map((q) => ({ code: q.code, name: q.name, changeRate: null }))
        : [];
      themes.push({ id: t.id, name: t.name, changeRate: Math.round(r * 100) / 100 || 0, up: 0, flat: 0, down: 0, leaders });
    }
    if (!themes.length) throw new Error("토스 테마 기간 등락률을 받지 못했습니다");
    return { themes, total: targets.length, builtAt: book.builtAt, capturedAt, inSession: open };
  }

  async theme(market: DiscoverMarket, kind: ThemeKind, id: string): Promise<ThemeDetail | null> {
    const open = await this.isOpen(market);
    if (market === "US" && kind === "theme" && this.deps.usThemes) return this.usTheme(open, id);
    const k: ThemeKind = market === "US" ? "sector" : kind;
    let got: { value: SectorDetail | null; at: number };
    try {
      got = await this.cached(`theme:${market}:${k}:${id}`, this.ttl(open), () => this.deps.naver.sectorDetail(market, k, id));
    } catch (e) {
      // 네이버 미국 업종은 없는 코드에 404 대신 500 을 준다 → 받아 둔 업종 목록에 없으면 "없음"
      if (market === "US" && this.knownSectorIds("US")?.has(id) === false) return null;
      throw e;
    }
    const { at } = got;
    let value = got.value;
    if (!value) return null;
    let note: string | null = null;
    if (market === "US" && value.items.length && value.items.filter((i) => !i.volume && i.changeRate === 0).length / value.items.length >= 0.8) {
      // 장 시작 전 초기화: 종목 값이 모두 0 — 미국 테마 시세 저장본(약 2,500종목)으로 덮는다
      const snap = await this.loadSnap<[string, UsQuote][]>("usq");
      const byTicker = new Map((snap?.value ?? []).map(([, q]) => [q.code, q] as const));
      let hit = 0;
      const items = value.items.map((i) => {
        const q = byTicker.get(i.code);
        if (!q) return i;
        hit++;
        return { ...i, price: q.price, change: q.change, changeRate: q.changeRate, volume: q.volume, tradingValue: q.tradingValue };
      });
      value = { ...value, items };
      note = hit ? `장 시작 전이라 종목 값은 직전 정규장 저장본 (${hit}/${items.length}종목)` : "장 시작 전이라 종목별 등락률이 0으로 초기화돼 있습니다 (정규장이 열리면 갱신)";
    }
    // 목록과 같은 조건으로만 조정한다: 상장 첫날 종목이 등락률 상위 3(네이버 대표 종목)에 들 때
    const fresh = market === "KR" ? await this.newlyListed(open) : new Set<string>();
    const top3 = [...value.items].sort((a, b) => b.changeRate - a.changeRate).slice(0, 3);
    const adjust = top3.some((i) => fresh.has(i.code)) && value.items.length < SECTOR_MAX_ITEMS;
    const theme = adjust ? recount(value.theme, value.items, fresh, k === "sector") : value.theme;
    return {
      market,
      kind: k,
      theme,
      description: value.description,
      items: value.items,
      marketOpen: open,
      asOf: market === "KR" && !open ? ((await this.krClosedAsOf()) ?? seoulIso(new Date(at))) : seoulIso(new Date(at)),
      fxRate: await this.fx(market),
      source: "네이버 증권",
      basis: naverBasis(market, k),
      note,
    };
  }

  /** 받아 둔 업종 목록의 코드 (없으면 null) */
  private knownSectorIds(market: DiscoverMarket): Set<string> | null {
    for (const period of ["day", "week", "month"] as const) {
      const hit = this.cache.get(`themes:${market}:sector:${period}`) as Cached<ThemeSummary[]> | undefined;
      if (hit) return new Set(hit.value.map((t) => t.id));
    }
    return null;
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

type UsPeriodSnapshot = { themes: ThemeSummary[]; total: number; builtAt: number; capturedAt: number; inSession: boolean };

/** 네이버 테마·업종 등락률 산출 방식 (실측: 한국 테마 = 단순 평균, 업종 = 시가총액 가중) */
function naverBasis(market: DiscoverMarket, kind: ThemeKind): string {
  if (market === "US") return "산업 분류(TRBC)별 구성 종목 시가총액 가중 평균";
  return kind === "theme" ? "구성 종목 등락률 단순 평균(거래정지 제외, KRX 기준)" : "구성 종목 시가총액 가중 평균(KRX 기준)";
}

/** "HH:MM" (서울) — 날짜가 오늘이 아니면 "M/D HH:MM" */
function hm(t: number): string {
  const iso = seoulIso(new Date(t));
  const today = seoulIso(new Date()).slice(0, 10);
  const time = iso.slice(11, 16);
  return iso.slice(0, 10) === today ? time : `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${time}`;
}

/** 서울 평일 09:00~15:30 (KRX 정규장, 휴장일은 달력이 거른다) */
export function isKrxRegularHours(d: Date): boolean {
  const iso = seoulIso(d);
  const wd = new Date(`${iso.slice(0, 10)}T12:00:00+09:00`).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const m = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  return m >= 9 * 60 && m < 15 * 60 + 30;
}

/** 직전 KRX 정규장 마감 시각 (서울 15:30). 오늘이 거래일이고 15:30 이 지났으면 오늘, 아니면 직전 평일 */
export function lastKrxClose(now: Date, todayIsTradingDay: boolean): string {
  const iso = seoulIso(now);
  const m = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  let day = new Date(`${iso.slice(0, 10)}T12:00:00+09:00`);
  const wd = day.getUTCDay();
  if (!(todayIsTradingDay && wd !== 0 && wd !== 6 && m >= 15 * 60 + 30)) {
    do day = new Date(day.getTime() - 86_400_000);
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  }
  return `${seoulIso(day).slice(0, 10)}T15:30:00+09:00`;
}

/** 뉴욕 현지 평일 09:30~16:00 (휴장일은 달력이 거른다) */
export function isUsRegularHours(d: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const m = Number(get("hour")) * 60 + Number(get("minute"));
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

/**
 * 구성 종목에서 상장 첫날 종목과 거래정지(거래량 0)를 빼고 등락률·상승/보합/하락 수를 다시 센다.
 * weighted 면 전일 시가총액 가중 평균(업종), 아니면 단순 평균(테마) — 네이버와 같은 방식.
 */
export function recount(th: ThemeSummary, items: DiscoverStock[], fresh: Set<string>, weighted = false): ThemeSummary {
  const live = items.filter((i) => !fresh.has(i.code) && (i.volume ?? 1) > 0);
  if (!live.length) return th;
  let avg = live.reduce((s, i) => s + i.changeRate, 0) / live.length;
  if (weighted) {
    let w = 0;
    let wr = 0;
    for (const i of live) {
      if (!i.marketCap || i.marketCap <= 0) continue;
      const prev = i.marketCap / (1 + i.changeRate / 100);
      w += prev;
      wr += prev * i.changeRate;
    }
    if (w > 0) avg = wr / w;
  }
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
