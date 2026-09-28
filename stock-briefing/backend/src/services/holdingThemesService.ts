import { isKrCode } from "../lib/codes.js";
import { within } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import type { KrQuote, ThemeKind, ThemePeriod, ThemeSummary, UsQuote } from "../providers/market/naverDiscover.js";
import type { DiscoverSession, ThemeDetail, ThemeList } from "./discoverService.js";
import type { HoldingThemeMaps, MapLookup } from "./holdingThemeMaps.js";
import {
  basisLines,
  classifyHolding,
  groupKey,
  koDateTime,
  MARKET_NOTE_KR_INDEX,
  MARKET_NOTE_US_BOOK,
  mostHeld,
  topBottom,
  TV_MIN_DAYS,
  tvBaseline,
  tvRatio,
  unmappedText,
  type ClassifyResult,
  type GroupRef,
  type HtKind,
  type HtMarket,
  type MostHeld,
  type TvDay,
  type Underlying,
  type UnmappedReason,
  type Via,
} from "./holdingThemesCalc.js";
import type { KrThemeIndex, KrThemeIndexData } from "./krThemeIndex.js";
import type { ThemeTvHistory } from "./themeTvHistory.js";
import { usThemeSummary, UsThemesBuildingError, type UsThemeBookData } from "./usThemes.js";

/**
 * 내 보유 종목 × 테마 강도 (3-35, 플래그 holdingThemes). 보유 종목을 테마·업종에 묶고(holdingThemesCalc.classifyHolding),
 * 묶음마다 오늘·1주 등락률과 오른·내린·보합 종목 수(발견 탭 DiscoverService 가 준 값을 그대로 옮김 — 다시 계산하지 않음),
 * 거래대금 평소 대비(이 앱이 매일 기록한 값), 그 묶음에 든 내 종목과 내 종목의 정규장 등락률을 보인다.
 *  - 보유 목록은 인자로 받는다(forHoldings(held)) — 계정 B 이후 경로가 사용자별 보유만 넘기면 된다. 분류·시세·기록은 시장 데이터라 공유 캐시
 *  - 플래그를 끄면 부르는 곳(경로·브리핑·예약 작업) 모두 새 요청·계산·저장 0건
 *  - 문구는 사실만 (holdingThemesCalc 금지어 검사)
 */

export interface HeldPosition {
  code: string;
  name: string;
  /** 원화 평가금액 (많이 속한 테마 순서에만 쓴다, 모르면 null) */
  value: number | null;
}

export type TvState = "final" | "partial" | "lastDay" | "collecting" | "none";

export interface HtStrength {
  changeRate: number | null;
  up: number | null;
  flat: number | null;
  down: number | null;
}

export interface HtTradingValue {
  today: number | null;
  avg: number | null;
  /** 평소에 쓴 기록 수 */
  days: number;
  /** days < 5 면 null */
  ratioPct: number | null;
  state: TvState;
  /** today 값의 거래일 (그 시장 날짜) */
  day: string | null;
  currency: "KRW" | "USD";
}

export interface HtHolding {
  code: string;
  name: string;
  via: Via | null;
  /** 정규장 기준 오늘 등락률 (거래정지·시세 없음은 null) */
  changeRate: number | null;
  /** 미국 테마: 등락률 계산(시가총액 상위 30종목)에 드는지. 그 밖은 null */
  inCalc: boolean | null;
}

export interface HtGroup {
  key: string;
  market: HtMarket;
  kind: HtKind;
  id: string;
  name: string;
  day: HtStrength;
  week: HtStrength | null;
  tradingValue: HtTradingValue;
  /** 발견 탭 목록에 있는 묶음인지 (미국 테마는 거래대금 100만 달러 미만이면 목록에서 빠짐) */
  inDiscoverList: boolean;
  holdings: HtHolding[];
}

export interface HtMarketInfo {
  session: DiscoverSession;
  marketOpen: boolean;
  asOf: string | null;
  tvDay: string | null;
  preparing: boolean;
  note: string | null;
  weekNote: string | null;
  /** 이 시장 보유 종목 원화 평가금액 합 (앱이 처음 고를 시장 칩 — 위젯 칩과 같은 규칙). 모르는 종목은 0 으로 셈 */
  heldValue: number;
}

export interface HoldingThemesResponse {
  enabled: true;
  asOf: string;
  markets: Partial<Record<HtMarket, HtMarketInfo>>;
  coverage: {
    held: number;
    mapped: number;
    unmapped: Array<{ code: string; name: string; market: HtMarket; reason: UnmappedReason; text: string }>;
  };
  mostHeld: MostHeld[];
  groups: HtGroup[];
  /** 종목별로 보기 (평가금액 큰 순): 그 종목이 든 묶음 키 */
  byHolding: Array<{ code: string; name: string; market: HtMarket; keys: string[] }>;
  basis: string[];
  krIndexAt: string | null;
  disclaimer: string;
}

/** 계좌 브리핑 저장본 (data.holdingThemes — 그때 값 그대로, 작게) */
export interface HoldingThemesSnapshot {
  asOf: string;
  coverage: { held: number; mapped: number };
  mostHeld: Array<{ name: string; count: number }>;
  markets: Partial<
    Record<
      HtMarket,
      {
        /** 값의 거래일 (미국은 뉴욕 날짜) */
        basisDay: string | null;
        session: DiscoverSession;
        split: boolean;
        top: Array<{ name: string; changeRate: number }>;
        bottom: Array<{ name: string; changeRate: number }>;
        /** 나누지 않았을 때 top 뒤에 더 있는 묶음 수 */
        more: number;
      }
    >
  >;
}

type BookQuotes = { book: UsThemeBookData; quotes: Map<string, UsQuote>; at: number; day: string; session: DiscoverSession; open: boolean };

export interface HoldingThemesDeps {
  features: { enabled(key: "holdingThemes"): Promise<boolean> };
  discover: {
    themes(market: HtMarket, kind: ThemeKind, period: ThemePeriod): Promise<ThemeList>;
    theme(market: HtMarket, kind: ThemeKind, id: string): Promise<ThemeDetail | null>;
    usThemeBookQuotes(): Promise<BookQuotes | null>;
  };
  naver: { krQuotes(codes: string[]): Promise<Map<string, KrQuote>>; usQuotes(reuters: string[]): Promise<Map<string, UsQuote>> };
  krIndex: KrThemeIndex;
  maps: HoldingThemeMaps;
  tv: ThemeTvHistory;
  /** 보유 종목 (수량 > 0) — 경로·예약 작업이 쓴다 (계좌 브리핑은 자기 positions 를 넘긴다) */
  holdings: () => Promise<HeldPosition[]>;
  /** 레버리지 단일 종목·한국 지수 레버리지의 기초 (analysis/leveraged productKindOf) */
  underlying?: ((code: string, name: string) => Promise<Underlying | null>) | null;
  disclaimer: string;
  now?: () => Date;
  log?: { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };
  /** 분류를 처음 받을 때 기다리는 시간 (기본 3초) */
  mapWaitMs?: number;
  /** 발견 탭 목록·상세 하나를 기다리는 시간 (기본 8초) */
  listWaitMs?: number;
  /** 직전 응답이 있을 때 새 계산을 기다리는 시간 (기본 2.5초) */
  staleWaitMs?: number;
}

/** 계좌 브리핑이 기다리는 최대 시간 — 넘으면 칸 없이 (브리핑·알림을 늦추지 않게) */
export const SNAPSHOT_BUDGET_MS = 8_000;

type Classified = { held: HeldPosition; market: HtMarket; r: ClassifyResult };

export class HoldingThemesService {
  private readonly now: () => Date;
  private cache = new Map<string, { at: number; open: boolean; value: HoldingThemesResponse }>();
  private inflight = new Map<string, Promise<HoldingThemesResponse>>();
  private krQuoteCache: { at: number; codes: Set<string>; value: Map<string, KrQuote> } | null = null;
  private membersOf: { builtAt: number; map: Map<string, string[]> } | null = null;
  private readonly warnings: string[] = [];

  constructor(private readonly deps: HoldingThemesDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  enabled(): Promise<boolean> {
    return this.deps.features.enabled("holdingThemes").catch(() => false);
  }

  /** 경로용: 지금 보유 종목으로 (보유 목록을 받지 못하면 던진다) */
  async current(): Promise<HoldingThemesResponse> {
    return this.forHoldings(await this.deps.holdings());
  }

  /**
   * 보유 종목들의 테마 강도. 같은 보유 목록이면 값이 바뀌는 시간 60초·아니면 10분 캐시, 직전 값이 있으면 새 계산을 2.5초만 기다린다
   */
  async forHoldings(held: readonly HeldPosition[]): Promise<HoldingThemesResponse> {
    const key = [...held].map((h) => h.code).sort().join(",");
    const t = this.now().getTime();
    const hit = this.cache.get(key);
    if (hit && t - hit.at < (hit.open ? 60_000 : 10 * 60_000)) return withValues(hit.value, held);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build(held)
        .then((value) => {
          const open = Object.values(value.markets).some((m) => m && (m.marketOpen || m.preparing));
          this.cache.set(key, { at: this.now().getTime(), open, value });
          if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
          return value;
        })
        .finally(() => this.inflight.delete(key));
      p.catch(() => undefined);
      this.inflight.set(key, p);
    }
    if (hit) {
      const r = await within(p, this.deps.staleWaitMs ?? 2_500, null);
      return withValues(r ?? hit.value, held);
    }
    return withValues(await p, held);
  }

  /** 계좌 브리핑 저장본 (최대 SNAPSHOT_BUDGET_MS — 넘거나 실패하면 null). 꺼져 있으면 부르지 않는다(부르는 쪽이 플래그 확인) */
  async snapshot(held: readonly HeldPosition[], budgetMs = SNAPSHOT_BUDGET_MS): Promise<HoldingThemesSnapshot | null> {
    const r = await within(this.forHoldings(held), budgetMs, null);
    return r ? toSnapshot(r) : null;
  }

  // ── 분류 ─────────────────────────────────────────────────

  private async underlyingOf(held: readonly HeldPosition[]): Promise<Map<string, Underlying | null>> {
    const out = new Map<string, Underlying | null>();
    const f = this.deps.underlying;
    await Promise.all(
      held.map(async (h) => {
        out.set(h.code, f ? await within(f(h.code, h.name), 3_000, null) : null);
      }),
    );
    return out;
  }

  private async classifyAll(
    held: readonly HeldPosition[],
    ctx: { idx: KrThemeIndexData | null; book: BookQuotes | null; bookBuilding: boolean },
  ): Promise<{ list: Classified[]; under: Map<string, Underlying | null>; maps: Map<string, MapLookup> }> {
    const under = await this.underlyingOf(held);
    const codes = new Set<string>();
    for (const h of held) {
      codes.add(h.code);
      const u = under.get(h.code);
      if (u) codes.add(u.code);
    }
    const maps = await this.deps.maps.lookup([...codes], this.deps.mapWaitMs ?? 3_000);
    const bookIds = ctx.book ? new Set(ctx.book.book.themes.map((x) => x.id)) : ctx.bookBuilding ? null : new Set<string>();
    const list = held.map((h): Classified => {
      const market: HtMarket = isKrCode(h.code) ? "KR" : "US";
      const u = under.get(h.code) ?? null;
      const src = u ? maps.get(u.code) : maps.get(h.code);
      const it = src?.item ?? null;
      const krThemes = market === "KR" ? (ctx.idx ? (ctx.idx.members[h.code] ?? []) : null) : undefined;
      const r = classifyHolding({
        code: h.code,
        name: h.name,
        market,
        underlying: u,
        bookIds,
        ...(market === "US" ? { usTics: it ? it.tics : src?.failed ? null : undefined, usIndustry: it ? it.industry : undefined } : { krThemes, krIndustry: it ? it.industry : undefined }),
        pending: !!src?.pending,
        failed: !!src?.failed,
      });
      return { held: h, market, r };
    });
    return { list, under, maps };
  }

  // ── 계산 ─────────────────────────────────────────────────

  private async build(held: readonly HeldPosition[]): Promise<HoldingThemesResponse> {
    const now = this.now();
    const listWait = this.deps.listWaitMs ?? 8_000;
    const idx = await this.deps.krIndex.get();
    // 한국 표가 없거나 8일 넘었으면 뒤에서 만든다 (이번 응답은 '준비 중')
    void this.deps.krIndex.ensure().catch(() => undefined);
    let bookBuilding = false;
    const hasUs = held.some((h) => !isKrCode(h.code));
    const hasKr = held.some((h) => isKrCode(h.code));
    const book: BookQuotes | null = hasUs
      ? await this.deps.discover.usThemeBookQuotes().catch((e: unknown) => {
          if (e instanceof UsThemesBuildingError) bookBuilding = true;
          else this.warn(`미국 테마 시세: ${String(e)}`);
          return null;
        })
      : null;
    const { list, under, maps } = await this.classifyAll(held, { idx, book, bookBuilding });

    // 묶음 모으기
    const groups = new Map<string, { ref: GroupRef; codes: string[] }>();
    for (const c of list)
      for (const g of c.r.groups) {
        const k = groupKey(g);
        const e = groups.get(k) ?? { ref: g, codes: [] };
        if (!e.codes.includes(c.held.code)) e.codes.push(c.held.code);
        groups.set(k, e);
      }
    const need = (m: HtMarket, kind: HtKind) => [...groups.values()].some((g) => g.ref.market === m && g.ref.kind === kind);
    const lists = new Map<string, ThemeList | null>();
    const want: Array<[HtMarket, ThemeKind, ThemePeriod]> = [];
    for (const m of ["KR", "US"] as const) {
      if (!(m === "KR" ? hasKr : hasUs)) continue;
      // 시장 상태 줄은 테마 목록(없으면 업종 목록)에서 — 묶음이 없는 시장도 한국 테마 목록으로 상태를 안다
      const kinds: ThemeKind[] = need(m, "sector") ? (need(m, "theme") ? ["theme", "sector"] : ["sector"]) : ["theme"];
      for (const kind of kinds) for (const period of ["day", "week"] as const) want.push([m, kind, period]);
    }
    await Promise.all(
      want.map(async ([m, kind, period]) => {
        const l = await within(this.deps.discover.themes(m, kind, period), listWait, null);
        lists.set(`${m}:${kind}:${period}`, l);
      }),
    );
    const listOf = (m: HtMarket, kind: HtKind, period: ThemePeriod): ThemeList | null => {
      const l = lists.get(`${m}:${kind}:${period}`) ?? null;
      // 미국 테마 목록을 못 만들어 산업 분류로 대신 준 목록은 테마 목록이 아니다
      return l && l.kind === kind ? l : null;
    };

    // 시장 정보
    const markets: Partial<Record<HtMarket, HtMarketInfo>> = {};
    for (const m of ["KR", "US"] as const) {
      if (!(m === "KR" ? hasKr : hasUs)) continue;
      const head = listOf(m, "theme", "day") ?? listOf(m, "sector", "day") ?? lists.get(`${m}:theme:day`) ?? null;
      const week = listOf(m, "theme", "week") ?? listOf(m, "sector", "week");
      const preparing = m === "KR" ? !idx : bookBuilding;
      const session: DiscoverSession = m === "US" && book ? book.session : (head?.session ?? "closed");
      markets[m] = {
        session,
        marketOpen: m === "US" && book ? book.open : (head?.marketOpen ?? false),
        asOf: head?.asOf ?? null,
        tvDay: null,
        preparing,
        note: [preparing ? (m === "KR" ? MARKET_NOTE_KR_INDEX : MARKET_NOTE_US_BOOK) : null, head?.note ?? null].filter(Boolean).join(" · ") || null,
        weekNote: week?.note ?? null,
        heldValue: heldValueOf(held, m),
      };
    }

    // 거래대금 (오늘) · 내 종목 시세
    const krCodes = list.filter((c) => c.market === "KR").map((c) => c.held.code);
    const krThemeIds = [...groups.values()].filter((g) => g.ref.market === "KR" && g.ref.kind === "theme").map((g) => g.ref.id);
    const members = idx ? this.themeMembers(idx) : new Map<string, string[]>();
    const krQuotes = hasKr ? await this.krQuotesFor([...new Set([...krCodes, ...krThemeIds.flatMap((id) => members.get(id) ?? [])])], markets.KR?.marketOpen ?? false) : new Map<string, KrQuote>();
    const krDay = latestDay([...krQuotes.values()].map((q) => q.tradedAt));
    if (markets.KR) markets.KR.tvDay = markets.KR.session === "pre" ? null : krDay;
    if (markets.US) markets.US.tvDay = book?.day || null;
    const symQuote = new Map<string, UsQuote>();
    if (book) for (const q of book.quotes.values()) if (!symQuote.has(q.code)) symQuote.set(q.code, q);
    // 테마북에 없는 미국 보유 종목(ETF·작은 종목)은 로이터 코드로 한 번에
    const missingUs = list.filter((c) => c.market === "US" && !symQuote.has(c.held.code)).map((c) => maps.get(c.held.code)?.item?.reuters).filter((x): x is string => !!x);
    if (missingUs.length) {
      const q = await within(this.deps.naver.usQuotes(missingUs), listWait, null);
      if (q) for (const v of q.values()) if (!symQuote.has(v.code)) symQuote.set(v.code, v);
    }
    const holdingRate = (code: string): number | null => {
      if (isKrCode(code)) {
        const q = krQuotes.get(code);
        return q && q.status !== "HALT" ? q.changeRate : null;
      }
      const q = symQuote.get(code);
      return q ? q.changeRate : null;
    };

    const tvDays: Partial<Record<HtMarket, TvDay[]>> = {};
    for (const m of ["KR", "US"] as const) if (markets[m]) tvDays[m] = await this.deps.tv.days(m).catch(() => []);
    const marketToday = (m: HtMarket) => (m === "KR" ? seoulDate(now) : nyDate(now));

    const bookTheme = new Map((book?.book.themes ?? []).map((x) => [x.id, x]));
    const out: HtGroup[] = [];
    await Promise.all(
      [...groups.values()].map(async ({ ref, codes }) => {
        const m = ref.market;
        const dayList = listOf(m, ref.kind, "day");
        const weekList = listOf(m, ref.kind, "week");
        const dayRow = dayList?.themes.find((x) => x.id === ref.id) ?? null;
        const weekRow = weekList?.themes.find((x) => x.id === ref.id) ?? null;
        let day: HtStrength = dayRow ? strength(dayRow) : { changeRate: null, up: null, flat: null, down: null };
        const inDiscoverList = !!dayRow;
        let tvToday: number | null = null;
        let name = dayRow?.name ?? weekRow?.name ?? ref.name ?? (m === "KR" && ref.kind === "theme" ? idx?.themes[ref.id] : undefined) ?? ref.id;
        const bt = m === "US" && ref.kind === "theme" ? bookTheme.get(ref.id) : undefined;
        if (bt && book) {
          name = dayRow?.name ?? bt.name;
          const s = usThemeSummary(bt, book.quotes, book.day);
          if (s) {
            tvToday = s.tradingValue;
            // 발견 탭 목록에서 빠진 테마(거래대금 100만 달러 미만)도 같은 식으로 계산해 보인다
            if (!dayRow) day = strength(s.summary);
          }
        } else if (m === "KR" && ref.kind === "theme") {
          const mem = members.get(ref.id) ?? [];
          tvToday = sumTv(mem.map((c) => krQuotes.get(c)).filter((q): q is KrQuote => !!q && (!krDay || (q.tradedAt ?? "").slice(0, 10) === krDay)).map((q) => q.tradingValue ?? null));
        } else if (ref.kind === "sector") {
          const d = await within(this.deps.discover.theme(m, "sector", ref.id), listWait, null);
          if (d) {
            tvToday = sumTv(d.items.filter((i) => !i.suspended).map((i) => i.tradingValue));
            if (!dayRow && d.theme) name = d.theme.name || name;
          }
        }
        const week: HtStrength | null = weekRow
          ? { changeRate: weekRow.changeRate, ...(m === "US" && ref.kind === "theme" ? { up: null, flat: null, down: null } : { up: weekRow.up, flat: weekRow.flat, down: weekRow.down }) }
          : null;
        const tvKeyName = `${ref.kind}:${ref.id}`;
        const info = markets[m]!;
        const tv = this.tradingValue(tvDays[m] ?? [], tvKeyName, tvToday, info, marketToday(m), m === "KR" ? "KRW" : "USD");
        const holdings: HtHolding[] = codes.map((code) => {
          const c = list.find((x) => x.held.code === code)!;
          const u = under.get(code) ?? null;
          const sym = u?.code ?? code;
          return { code, name: c.held.name, via: c.r.via, changeRate: holdingRate(code), inCalc: bt ? bt.members.some((mm) => mm.symbol === sym) : null };
        });
        out.push({ key: groupKey(ref), market: m, kind: ref.kind, id: ref.id, name, day, week, tradingValue: tv, inDiscoverList, holdings });
      }),
    );
    // 높은 순으로 (앱이 시장·기간별로 다시 나눈다)
    const sorted = topBottom(out.map((g) => ({ ...g, rate: g.day.changeRate }))).all.map(({ rate: _r, ...g }) => g as HtGroup);

    const valueOf = new Map(held.map((h) => [h.code, h.value]));
    const most = mostHeld(
      sorted.map((g) => ({ key: g.key, name: g.name, codes: g.holdings.map((h) => h.code) })),
      (c) => valueOf.get(c) ?? null,
    );
    const unmapped = list
      .filter((c) => !c.r.groups.length)
      .map((c) => ({ code: c.held.code, name: c.held.name, market: c.market, reason: c.r.reason ?? "none", text: unmappedText(c.r.reason ?? "none", { code: c.held.code, name: c.held.name, market: c.market, index: c.r.index }) }));
    const byHolding = [...list]
      .sort((a, b) => (b.held.value ?? 0) - (a.held.value ?? 0) || a.held.name.localeCompare(b.held.name, "ko"))
      .filter((c) => c.r.groups.length)
      .map((c) => ({ code: c.held.code, name: c.held.name, market: c.market, keys: c.r.groups.map(groupKey) }));
    const krIndexAt = idx ? koDateTime(seoulIso(new Date(idx.builtAt))) : null;
    return {
      enabled: true,
      asOf: seoulIso(now),
      markets,
      coverage: { held: held.length, mapped: list.filter((c) => c.r.groups.length).length, unmapped },
      mostHeld: most,
      groups: sorted,
      byHolding,
      basis: basisLines(krIndexAt),
      krIndexAt,
      disclaimer: this.deps.disclaimer,
    };
  }

  /** 거래대금 평소 대비 한 묶음 (설계 2-A 상태) */
  private tradingValue(days: readonly TvDay[], key: string, today: number | null, info: HtMarketInfo, marketToday: string, currency: "KRW" | "USD"): HtTradingValue {
    // 한국 장 시작 전(08:00~09:00)에는 출처가 값을 비우므로 마지막으로 적은 거래일 값을 쓴다
    if (info.session === "pre" || (today !== null && today <= 0 && info.session !== "regular")) {
      const last = [...days].filter((d) => typeof d.tv[key] === "number").sort((a, b) => (a.day < b.day ? 1 : -1))[0];
      if (!last) return { today: null, avg: null, days: 0, ratioPct: null, state: "none", day: null, currency };
      const b = tvBaseline(days, key, last.day);
      const ratio = tvRatio(last.tv[key]!, b.avg, b.days);
      return { today: last.tv[key]!, avg: b.avg, days: b.days, ratioPct: ratio, state: b.days < TV_MIN_DAYS ? "collecting" : "lastDay", day: last.day, currency };
    }
    const dayOf = info.tvDay;
    const b = tvBaseline(days, key, dayOf);
    if (today === null) return { today: null, avg: b.avg, days: b.days, ratioPct: null, state: "none", day: dayOf, currency };
    const ratio = tvRatio(today, b.avg, b.days);
    const state: TvState = b.days < TV_MIN_DAYS ? "collecting" : info.session === "regular" || info.session === "extended" ? "partial" : dayOf === marketToday ? "final" : "lastDay";
    return { today, avg: b.avg, days: b.days, ratioPct: ratio, state, day: dayOf, currency };
  }

  /** 한국 테마 id → 구성 종목 (표가 바뀔 때만 다시 만든다) */
  private themeMembers(idx: KrThemeIndexData): Map<string, string[]> {
    if (this.membersOf?.builtAt === idx.builtAt) return this.membersOf.map;
    const map = new Map<string, string[]>();
    for (const [code, ids] of Object.entries(idx.members)) for (const id of ids) (map.get(id) ?? map.set(id, []).get(id)!).push(code);
    this.membersOf = { builtAt: idx.builtAt, map };
    return map;
  }

  /** 한국 시세 (네이버 폴링 KRX, 60초 캐시 — 같은 종목 묶음이면) */
  private async krQuotesFor(codes: string[], open: boolean): Promise<Map<string, KrQuote>> {
    if (!codes.length) return new Map();
    const t = this.now().getTime();
    const c = this.krQuoteCache;
    if (c && t - c.at < (open ? 60_000 : 5 * 60_000) && codes.every((x) => c.codes.has(x))) return c.value;
    const value = await within(this.deps.naver.krQuotes(codes), this.deps.listWaitMs ?? 8_000, null);
    if (!value) return c?.value ?? new Map();
    this.krQuoteCache = { at: t, codes: new Set(codes), value };
    return value;
  }

  private warn(msg: string): void {
    this.warnings.push(msg);
    if (this.warnings.length > 5) this.warnings.shift();
    this.deps.log?.warn?.({ err: msg }, "내 종목 테마");
  }

  // ── 예약 작업 ─────────────────────────────────────────────

  /** 한국 테마 표 다시 만들기 (일요일 05:40 · 관리 경로). 꺼져 있으면 0건 */
  async rebuildKrIndex(): Promise<{ themes: number } | null> {
    if (!(await this.enabled())) return null;
    const d = await this.deps.krIndex.build();
    return { themes: Object.keys(d.themes).length };
  }

  /** 서버를 켤 때: 표가 없거나 8일 넘었으면 만든다 (꺼져 있으면 0건) */
  async warm(): Promise<void> {
    if (!(await this.enabled())) return;
    await this.deps.krIndex.ensure();
  }

  /**
   * 장 마감 뒤 거래대금 기록 (한국 20:10 KST · 미국 16:15 뉴욕, 평일). 그날이 거래일이 아니면(시세 날짜가 오늘이 아님) 적지 않는다.
   * 한국: 테마 표의 모든 종목 KRX 거래대금(폴링 500개씩) → 테마마다 합, 미국: 테마북 시세 → 테마마다 합(계산 30종목). 보유 종목이 든 업종은 업종 상세 합.
   * 꺼져 있으면 요청 0건
   */
  async recordTv(market: HtMarket): Promise<{ recorded: number; day: string | null; skipped: string | null }> {
    if (!(await this.enabled())) return { recorded: 0, day: null, skipped: "꺼짐" };
    const now = this.now();
    const tv: Record<string, number> = {};
    let day: string | null = null;
    let book: BookQuotes | null = null;
    if (market === "KR") {
      const idx = await this.deps.krIndex.get();
      if (!idx) return { recorded: 0, day: null, skipped: "한국 테마 표 없음" };
      const members = this.themeMembers(idx);
      const quotes = await this.deps.naver.krQuotes(Object.keys(idx.members));
      day = latestDay([...quotes.values()].map((q) => q.tradedAt));
      if (day !== seoulDate(now)) return { recorded: 0, day, skipped: "오늘 거래일 아님" };
      for (const [id, codes] of members) {
        const s = sumTv(codes.map((c) => quotes.get(c)).filter((q): q is KrQuote => !!q && (q.tradedAt ?? "").slice(0, 10) === day).map((q) => q.tradingValue ?? null));
        if (s !== null) tv[`theme:${id}`] = s;
      }
    } else {
      const b = await this.deps.discover.usThemeBookQuotes().catch(() => null);
      if (!b) return { recorded: 0, day: null, skipped: "미국 테마북 없음" };
      book = b;
      day = b.day;
      if (day !== nyDate(now) || b.open) return { recorded: 0, day, skipped: "오늘 정규장 값 아님" };
      for (const th of b.book.themes) {
        const s = usThemeSummary(th, b.quotes, b.day);
        if (s) tv[`theme:${th.id}`] = s.tradingValue;
      }
    }
    // 보유 종목이 든 업종 (보통 1~4개)
    const held = await this.deps.holdings().catch(() => [] as HeldPosition[]);
    const mine = held.filter((h) => (market === "KR") === isKrCode(h.code));
    if (mine.length) {
      const idx = market === "KR" ? await this.deps.krIndex.get() : null;
      const { list } = await this.classifyAll(mine, { idx, book, bookBuilding: false });
      const sectors = new Set(list.flatMap((c) => c.r.groups.filter((g) => g.kind === "sector" && g.market === market).map((g) => g.id)));
      for (const id of sectors) {
        const d = await within(this.deps.discover.theme(market, "sector", id), this.deps.listWaitMs ?? 8_000, null);
        const s = d ? sumTv(d.items.filter((i) => !i.suspended).map((i) => i.tradingValue)) : null;
        if (s !== null) tv[`sector:${id}`] = s;
      }
    }
    const n = await this.deps.tv.record(market, day!, tv);
    this.deps.log?.info?.({ market, day, groups: n }, "내 종목 테마 거래대금 기록");
    return { recorded: n, day, skipped: null };
  }

  health(): { krIndexAt: string | null; krThemes: number; krBuilding: boolean; mapsAt: string | null; tvDays: Record<HtMarket, string | null>; warnings: string[] } {
    const s = this.deps.krIndex.status();
    return {
      krIndexAt: s.builtAt ? seoulIso(new Date(s.builtAt)) : null,
      krThemes: s.themes,
      krBuilding: s.building,
      mapsAt: this.deps.maps.updatedAt ? seoulIso(new Date(this.deps.maps.updatedAt)) : null,
      tvDays: { KR: this.deps.tv.lastRecorded.KR ?? null, US: this.deps.tv.lastRecorded.US ?? null },
      warnings: [...(s.error ? [`한국 테마 표: ${s.error}`] : []), ...this.warnings],
    };
  }
}

function strength(s: ThemeSummary): HtStrength {
  // 출처가 요약을 확인하지 못한 묶음(unverified)은 수를 세지 않았다 (발견 탭과 같게 0 → 없음)
  if (s.unverified) return { changeRate: s.changeRate, up: null, flat: null, down: null };
  return { changeRate: s.changeRate, up: s.up, flat: s.flat, down: s.down };
}

function sumTv(vals: ReadonlyArray<number | null | undefined>): number | null {
  let any = false;
  let s = 0;
  for (const v of vals)
    if (typeof v === "number" && Number.isFinite(v)) {
      s += v;
      any = true;
    }
  return any ? s : null;
}

function latestDay(ts: ReadonlyArray<string | null>): string | null {
  let d = "";
  for (const x of ts) {
    const day = (x ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > d) d = day;
  }
  return d || null;
}

/** 뉴욕 날짜 YYYY-MM-DD */
export function nyDate(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function heldValueOf(held: readonly HeldPosition[], m: HtMarket): number {
  return held.filter((h) => (m === "KR") === isKrCode(h.code)).reduce((a, h) => a + (h.value ?? 0), 0);
}

/** 캐시한 응답에 이번 보유 목록의 평가금액 순서만 다시 (많이 속한 테마·종목별 보기) */
function withValues(r: HoldingThemesResponse, held: readonly HeldPosition[]): HoldingThemesResponse {
  const valueOf = new Map(held.map((h) => [h.code, h.value]));
  const most = mostHeld(
    r.groups.map((g) => ({ key: g.key, name: g.name, codes: g.holdings.map((h) => h.code) })),
    (c) => valueOf.get(c) ?? null,
  );
  const byHolding = [...r.byHolding].sort((a, b) => (valueOf.get(b.code) ?? 0) - (valueOf.get(a.code) ?? 0) || a.name.localeCompare(b.name, "ko"));
  const markets: HoldingThemesResponse["markets"] = {};
  for (const [m, info] of Object.entries(r.markets) as Array<[HtMarket, HtMarketInfo]>) markets[m] = { ...info, heldValue: heldValueOf(held, m) };
  return { ...r, markets, mostHeld: most, byHolding };
}

/** 응답 → 계좌 브리핑 저장본 (시장마다 등락률 높은·낮은 3개, 나누지 않으면 높은 순 5개 + 더 있는 수) */
export function toSnapshot(r: HoldingThemesResponse): HoldingThemesSnapshot {
  const markets: HoldingThemesSnapshot["markets"] = {};
  for (const m of ["US", "KR"] as const) {
    const info = r.markets[m];
    const gs = r.groups.filter((g) => g.market === m);
    if (!info || !gs.length) continue;
    const tb = topBottom(gs.map((g) => ({ name: g.name, rate: g.day.changeRate })));
    const pick = (x: { name: string; rate: number | null }) => ({ name: x.name, changeRate: x.rate! });
    const ranked = tb.all.filter((x) => x.rate !== null);
    markets[m] = {
      basisDay: m === "US" ? info.tvDay : info.asOf ? info.asOf.slice(0, 10) : null,
      session: info.session,
      split: tb.split,
      top: tb.split ? tb.top.map(pick) : ranked.slice(0, 5).map(pick),
      bottom: tb.split ? tb.bottom.map(pick) : [],
      more: tb.split ? 0 : Math.max(0, ranked.length - 5),
    };
  }
  return { asOf: r.asOf, coverage: { held: r.coverage.held, mapped: r.coverage.mapped }, mostHeld: r.mostHeld.map((x) => ({ name: x.name, count: x.count })), markets };
}
