import { within } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { fallbackState, type MarketCalendar, type MarketState } from "../providers/market/calendar.js";
import { isMostlyZero, isPreopenQuotes, type DiscoverMarket, type ExchangeSession, type ExchangeStatus, type DiscoverStock, type NaverDiscover, type RankCategory, type SectorDetail, type ThemeKind, type ThemePeriod, type ThemeSummary, type UsQuote } from "../providers/market/naverDiscover.js";
import type { CodeStore } from "../providers/market/toss.js";
import type { TicsRankRow, TossTics } from "../providers/market/tossTics.js";
import { latestTradeDay, pool, usThemeSummary, UsThemesBuildingError, type UsThemeBook, type UsThemeBookData } from "./usThemes.js";

/**
 * 발견 탭 서비스: 순위(거래대금·거래량·급상승·급하락)와 테마·업종(오늘/1주/1개월), 테마 구성 종목.
 *  - 캐시: 값이 바뀌는 시간(한국 08:00~20:00, 미국 정규장)이면 30초, 아니면 5분 (주·월 등락률은 장중에도 2분)
 *  - 조회가 실패하면 직전 값을 그대로 준다(stale). 직전 값도 없으면 오류
 *  - 급상승·급하락은 거래대금 한국 10억 원·미국 100만 달러 미만을 빼서 동전주가 뜨지 않게 한다
 *  - ETF·ETN·스팩은 순위에서 뺀다 (종목만)
 *  - 미국 테마는 토스 테마 분류에 네이버 정규장 시세를 붙여 직접 계산한다 (usThemes.ts)
 */

/**
 * 발견 탭 값의 장 상태 (앱 상태 줄 문구)
 *  - regular: 정규장 (한국 KRX 09:00~15:30, 미국 뉴욕 09:30~16:00)
 *  - extended: 한국 정규장 뒤 시간외(15:30~20:00) — 시간외 거래로 값이 계속 바뀐다
 *  - pre: 한국 정규장 전(08:00~09:00) — 값은 직전 거래일
 *  - closed: 장 마감·휴장. 미국은 프리·애프터도 여기 (네이버 미국 값은 정규장 값이라 바뀌지 않는다)
 */
export type DiscoverSession = "regular" | "extended" | "pre" | "closed";
type Session = { session: DiscoverSession; open: boolean; lastClose: string | null };

export interface DiscoverRank {
  market: DiscoverMarket;
  category: RankCategory;
  items: DiscoverStock[];
  page: number;
  hasMore: boolean;
  /** 값이 바뀌는 시간이라 자주(30초) 갱신하는지 */
  marketOpen: boolean;
  session: DiscoverSession;
  /** 이 쪽이 나온 목록의 판 — 앱이 다음 쪽을 받을 때 돌려주면 같은 목록에서 이어 준다 */
  ver: number;
  /**
   * 뒤 쪽 요청의 판(v)을 더 갖고 있지 않아(재시작·최근 5판 밖) 이어 줄 수 없다 — 첫 쪽부터 다시 받아야 한다.
   * 이때 items 는 비고 hasMore 는 false. restart 를 안다고 알린 요청(r=1)에만 준다 — 모르는 옛 앱은 빈 쪽을 붙이고
   * 더 보기·자동 갱신이 말없이 멈추므로, 예전 서버처럼 지금 목록의 쪽을 준다
   */
  restart?: boolean;
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
  session: DiscoverSession;
  /** 장 밖인데 정규장 값이 없어 지금(주간·프리·애프터 섞인) 값을 준 경우 */
  live?: boolean;
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
  session: DiscoverSession;
  asOf: string | null;
  fxRate: number | null;
  source: string;
  basis: string;
  note: string | null;
  updatedAt?: string | null;
}

/** 순위 원본: 정렬된 전체 목록을 앞에서부터 한 쪽씩 (없으면 빈 목록, hasNext 로 끝) */
export type RankSource = (category: RankCategory, index: number) => Promise<{ items: DiscoverStock[]; hasNext: boolean; tradedAt?: string | null; preopen?: boolean }>;

/**
 * 순위 누적 상태. at = 값을 받은 시각(기준 시각), checkedAt = 마지막으로 출처를 확인한 시각(다음 확인 시점 계산).
 * stale = 출처가 비어 직전 목록을 유지 중, fromSnapshot = 재시작 뒤 저장본에서 복원 (둘 다 더 이어 받지 않는다)
 */
type RankState = {
  at: number;
  checkedAt: number;
  /** 목록 판 (새 목록을 받을 때마다 바뀐다) */
  ver: number;
  items: DiscoverStock[];
  next: number;
  hasNext: boolean;
  source: string;
  tradedAt: string | null;
  preopen?: boolean;
  stale?: boolean;
  fromSnapshot?: boolean;
};

/** 네이버가 잠시 값을 비운 시간(장 시작 전 초기화)인데 저장해 둔 직전 값도 없을 때 */
export class PreopenError extends Error {
  constructor(what: string) {
    super(`${what}: 출처가 잠시 값을 비운 시간이고 저장해 둔 직전 값도 없습니다`);
    this.name = "PreopenError";
  }
}

export const MIN_TRADING_VALUE: Record<DiscoverMarket, number> = { KR: 1_000_000_000, US: 1_000_000 };
const MAX_SOURCE_PAGES = 12;
/** 미국 순위 원본을 쪽마다 받는 벌 수, 묶음의 가장 새 값보다 이만큼 늦은 쪽은 묵은 쪽으로 본다 (다시 받는다) */
const US_RANK_COPIES = 2;
const STALE_PAGE_MS = 2_000;
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
const SNAP_MAX_AGE_MS = 14 * 24 * 3_600_000; // 긴 연휴(열흘) 뒤 첫 장 시작 전에도 쓸 수 있게
const SNAP_PERSIST_EVERY_MS = 10 * 60_000;
/** 순위 저장본에 남기는 줄 수 */
const SNAP_RANK_ITEMS = 600;
/** 뒤 쪽(2쪽~) 요청은 첫 쪽이 받은 목록을 이만큼(TTL 배수) 더 쓴다 — 쪽마다 목록이 바뀌어 종목이 빠지거나 두 번 나오지 않게 */
const PAGE_TTL_FACTOR = 3;
/** 장 상태·환율·테마 설명을 기다리는 최대 시간 (느리면 추정값·없음으로) */
const CAL_WAIT_MS = 2_500;
const FX_WAIT_MS = 2_000;
const SUMMARY_WAIT_MS = 2_000;
/** 미국 테마별 직전 정규장 거래대금 (meta 표 키) */
const US_THEME_TV_KEY = "discover:us-theme-tv";
/** 미국 개장 뒤 이 시간(분) 동안은 직전 정규장 거래대금으로도 테마를 남긴다 */
const US_OPEN_GRACE_MIN = 60;
/** 테마 상세에 목록의 상승·보합·하락 수를 붙일 때, 장중 목록이 이보다 오래되면 쓰지 않는다 */
const LISTED_MAX_AGE_MS = 10 * 60_000;

type Cached<T> = { at: number; value: T };

export class DiscoverService {
  private readonly cache = new Map<string, Cached<unknown>>();
  /** 순위는 쪽을 이어 받으므로 (시장, 분류)별로 누적 상태를 둔다 */
  private readonly ranks = new Map<string, RankState>();
  /** 지난 목록들(최근 5판) — 첫 쪽을 옛 목록으로 받은 앱이 뒤 쪽도 같은 목록(ver)에서 이어 받게 */
  private readonly prevRanks = new Map<string, RankState[]>();
  /** 네이버 거래소 장 상태 (다음 세션 경계 또는 5분까지 쓴다) */
  private exStatus: { until: number; value: Partial<Record<DiscoverMarket, ExchangeStatus>>; fetchedAt: Partial<Record<DiscoverMarket, number>> } | null = null;
  private exInflight: Promise<Partial<Record<DiscoverMarket, ExchangeStatus>> | null> | null = null;
  private exFailedAt = 0;
  /**
   * 한국 마지막 거래일과 그날 마감. 장 시작 전(08:00~09:00)에는 출처가 직전 마감을 알려 주지 않아, 거래일 세션을 볼 때마다
   * 기억한다(더 늦은 거래일로만 바꾼다, meta 표에도). exact = 마감 뒤 출처가 준 실제 마감, 아니면 그날 20:00(NXT 끝) 추정
   */
  private krTrade: KrTrade | null = null;
  private krTradeLoad: Promise<void> | null = null;
  /** 미국 가장 최근 정규장 마감 (조기 폐장일 13:00 포함) — 정규장·애프터마켓 세션을 볼 때 기억한다 */
  private usRegularClose: string | null = null;
  private usCloseLoad: Promise<void> | null = null;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly failures = new Map<string, { at: number; error: unknown }>();
  /**
   * 미국 테마별 구성 종목 거래대금 합 — 장이 닫혀 있을 때(프리·애프터·휴장) 본 값, 곧 직전 정규장 하루치 (meta 표에도).
   * 개장 직후에는 오늘 누적 거래대금이 거의 0 이라, 이 값으로도 거래대금 기준을 넘으면 테마를 남긴다
   */
  private usThemeTv: { day: string; tv: Map<string, number> } | null = null;
  /** meta 표에 저장하는 데 성공한 값의 지문 (값이 바뀌면 다시 쓴다, 실패하면 다음에 다시) */
  private usThemeTvSaved = "";
  private usThemeTvLoad: Promise<void> | null = null;
  /** 미국 테마 기간 등락률의 정규장 중 스냅숏 */
  private readonly periodSnaps = new Map<ThemePeriod, UsPeriodSnapshot>();
  /** 직전 값 저장본 (메모리 + meta 표). 네이버가 잠시 값을 비운 시간(장 시작 전 초기화)과 재시작 직후에 쓴다 */
  private readonly snaps = new Map<string, { savedAt: number; sig: string; persistedAt: number; persistedSig: string; value: unknown }>();

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
   * 장 상태. open 이면 값이 바뀌는 시간이라 30초마다 새로 받는다.
   * 값의 출처(네이버)가 주는 거래소 장 상태를 먼저 쓴다 — 휴장일·특수일(수능 10:00 개장, 미국 조기 폐장)과 세션 경계가 값과 맞는다.
   *  - 한국: 개장 전·프리마켓 = pre, 정규장 = regular, 정규장 뒤(15:30~20:00, 시간외·NXT 애프터마켓) = extended, 그 밖 = closed
   *  - 미국: 네이버 미국 값은 정규장 값이라 정규장만 open, 나머지(프리·애프터 포함)는 closed
   * 직전에 받은 장 상태가 지금도 유효하면 기다리지 않고 쓰며(새 값은 뒤에서), 아니면 네이버와 토스 달력을 함께 물어 2.5초까지만 기다린다.
   * 둘 다 없으면 요일·시각 추정.
   */
  private async session(market: DiscoverMarket): Promise<Session> {
    const now = this.now;
    const t = now.getTime();
    // 토스 달력은 필요할 때만 묻는다 (네이버를 기다려야 하면 함께 시작해 대기를 한 번으로)
    let calP: Promise<MarketState | null> | null = null;
    const calendar = () => (calP ??= this.calendarState(market));
    let cur = this.currentExchange(market, t);
    if (!this.exStatus || t >= this.exStatus.until) {
      const p = this.refreshExchange();
      if (!cur) {
        void calendar();
        await within(p, CAL_WAIT_MS, null);
        cur = this.currentExchange(market, t);
      }
    }
    if (cur) return market === "KR" ? this.krSession(cur, t) : this.usSession(cur.session, t, calendar);
    const st: MarketState | null = await calendar();
    // 장 상태를 못 받았어도, 기억한 한국 마감과 그때 알려 준 다음 개장 사이면 마감이다 (연휴 중 두 출처가 모두 멈춘 경우)
    if (market === "KR" && !st?.source?.startsWith("toss")) {
      await this.loadKrTrade();
      const m = this.krTrade;
      if (m?.exact && m.nextOpen && Date.parse(m.close) <= t && t < Date.parse(m.nextOpen)) return { session: "closed", open: false, lastClose: m.close };
    }
    if (!st && !this.deps.calendar) return { session: "closed", open: false, lastClose: null };
    const cal = st ?? fallbackState(market, now);
    if (market === "US") {
      const regular = cal.isOpen && isUsRegularHours(now);
      return { session: regular ? "regular" : "closed", open: regular, lastClose: regular ? null : this.latestUsClose(t, cal.lastClose ?? null) };
    }
    // 토스 달력이 실제로 준 값만 기억한다 (요일 추정은 휴장일을 모른다)
    const real = cal.source === "toss";
    if (!cal.isOpen) {
      if (real && cal.lastClose) this.noteKrTradeSoon({ day: seoulIso(new Date(cal.lastClose)).slice(0, 10), close: cal.lastClose, exact: true, nextOpen: cal.opensAt ?? null });
      return { session: "closed", open: false, lastClose: cal.lastClose ?? null };
    }
    const m = seoulMinutes(now);
    const session: DiscoverSession = m < 9 * 60 ? "pre" : isKrxRegularHours(now) ? "regular" : "extended";
    if (real && session !== "pre") this.noteKrTradeSoon({ day: seoulIso(now).slice(0, 10), close: null, exact: false, nextOpen: null });
    return { session, open: true, lastClose: session === "pre" ? await this.recallKrClose(t, null) : null };
  }

  /** 받아 둔 네이버 장 상태 중 지금 유효한 세션 (없으면 null) */
  private currentExchange(market: DiscoverMarket, t: number): { session: ExchangeSession; status: ExchangeStatus } | null {
    const st = this.exStatus?.value[market];
    const cur = st ? currentSession(st, t, this.exStatus?.fetchedAt[market]) : null;
    return st && cur ? { session: cur, status: st } : null;
  }

  private async krSession({ session: cur, status }: { session: ExchangeSession; status: ExchangeStatus }, t: number): Promise<Session> {
    // 정규장 마감(15:30) 뒤 같은 날 애프터마켓(16:00~)까지의 틈도 시간외다 (NXT 애프터마켓 15:40~·장후 시간외 종가가 진행 중)
    const gap = cur.kind === "closed" && status.next?.kind === "after" && status.next.tradeBaseAt === cur.tradeBaseAt;
    if (cur.kind === "regular" || cur.kind === "after" || gap) return { session: cur.kind === "regular" ? "regular" : "extended", open: true, lastClose: null };
    if (cur.kind === "closed") {
      const began = cur.openAt ? Date.parse(cur.openAt) : NaN;
      const lastClose = !Number.isNaN(began) && began <= t ? new Date(began).toISOString() : null;
      return { session: "closed", open: false, lastClose: lastClose ?? (await this.recallKrClose(t, null)) };
    }
    // 개장 전: 기억한 마감이 바로 앞 거래일 것인지 오늘 개장 시각으로 확인한다
    return { session: "pre", open: true, lastClose: await this.recallKrClose(t, cur.openAt) };
  }

  /**
   * 받은 장 상태에서 기억할 것을 배운다 (어느 시장 요청이든, 매일 뉴욕 15:50 저장 크론 포함 — 한국 새벽에도 한국 마감을 배운다).
   *  - 한국: 정규장·시간외·틈이면 그날이 거래일(마감 20:00 추정), 마감이면 실제 마감과 다음 개장
   *  - 미국: 정규장이면 그날 정규장 끝(조기 폐장 13:00), 애프터마켓이면 그 시작
   */
  private learn(value: Partial<Record<DiscoverMarket, ExchangeStatus>>, at: number): void {
    const kr = value.KR;
    const k = kr ? currentSession(kr, at, at) : null;
    if (kr && k?.tradeBaseAt) {
      const gap = k.kind === "closed" && kr.next?.kind === "after" && kr.next.tradeBaseAt === k.tradeBaseAt;
      if (k.kind === "regular" || k.kind === "after" || gap) {
        this.noteKrTradeSoon({ day: k.tradeBaseAt, close: k.kind === "after" ? k.closeAt : kr.next?.kind === "after" ? kr.next.closeAt : null, exact: false, nextOpen: null });
      } else if (k.kind === "closed" && k.openAt && Date.parse(k.openAt) <= at) {
        this.noteKrTradeSoon({ day: k.tradeBaseAt, close: k.openAt, exact: true, nextOpen: kr.next?.kind === "preopen" || kr.next?.kind === "pre" || kr.next?.kind === "regular" ? kr.next.openAt : null });
      }
    }
    const us = value.US;
    const u = us ? currentSession(us, at, at) : null;
    if (u?.kind === "regular" && u.closeAt) this.noteUsCloseSoon(u.closeAt);
    if (u?.kind === "after" && u.openAt) this.noteUsCloseSoon(u.openAt);
    // 마감(20:00 ET~프리마켓 전) 세션의 거래일 = 마지막 정규장 날 → 그날 16:00 (조기 폐장 13:00 은 이미 기억한 값이 더 늦지 않으므로 그대로 둔다)
    if (u?.kind === "closed" && u.tradeBaseAt && /^\d{4}-\d{2}-\d{2}$/.test(u.tradeBaseAt)) this.noteUsCloseSoon(new Date(nyCloseOf(u.tradeBaseAt)).toISOString(), true);
  }

  private async usSession(cur: ExchangeSession, t: number, calendar: () => Promise<MarketState | null>): Promise<Session> {
    if (cur.kind === "regular") return { session: "regular", open: true, lastClose: null };
    await this.loadUsClose();
    const mem = this.usRegularClose && Date.parse(this.usRegularClose) <= t ? this.usRegularClose : null;
    // 애프터마켓이면 그 시작이 오늘 정규장 마감 (조기 폐장 13:00 포함)
    if (cur.kind === "after" && cur.openAt) return { session: "closed", open: false, lastClose: new Date(cur.openAt).toISOString() };
    // 마감(20:00 ET~다음 프리마켓)은 tradeBaseAt 이 마지막 거래일: 그날 기억한 마감(조기 폐장)이 있으면 그것, 아니면 그날 16:00
    if (cur.kind === "closed" && cur.tradeBaseAt && /^\d{4}-\d{2}-\d{2}$/.test(cur.tradeBaseAt)) {
      const lastClose = mem && nyParts(new Date(mem)).date === cur.tradeBaseAt ? mem : new Date(nyCloseOf(cur.tradeBaseAt)).toISOString();
      return { session: "closed", open: false, lastClose };
    }
    // 프리마켓(04:00~09:30 ET): 기억이 가장 최근 평일 것이면 그대로, 아니면 토스 달력 (휴장일 확인).
    // 달력도 답이 없으면 기억(밤사이 마감 세션에서 배운 마지막 거래일)을 쓴다
    const cal = this.recentUsClose(t) ? null : await calendar();
    return { session: "closed", open: false, lastClose: this.latestUsClose(t, cal?.lastClose ?? null) ?? mem };
  }

  /** 기억한 미국 정규장 마감이 가장 최근 평일의 것이면 그 값 */
  private recentUsClose(t: number): string | null {
    const mem = this.usRegularClose && Date.parse(this.usRegularClose) <= t ? this.usRegularClose : null;
    return mem && nyParts(new Date(mem)).date >= lastUsRegularDay(this.now, null) ? mem : null;
  }

  /**
   * 미국 가장 최근 정규장 마감: 기억한 값(조기 폐장 반영)과 달력 값 중 늦은 날, 같은 날이면 기억한 값.
   * 달력이 없으면 기억이 최근일 때만 쓴다 (오래된 기억보다 평일 추정이 낫다)
   */
  private latestUsClose(t: number, calendarClose: string | null): string | null {
    const mem = this.usRegularClose && Date.parse(this.usRegularClose) <= t ? this.usRegularClose : null;
    if (!calendarClose) return this.recentUsClose(t);
    if (!mem) return calendarClose;
    return nyParts(new Date(calendarClose)).date > nyParts(new Date(mem)).date ? calendarClose : mem;
  }

  /**
   * 미국 정규장 마감을 기억한다 (더 늦은 값으로만, meta 표에도 — 재시작해도 조기 폐장 13:00 을 잃지 않게).
   * estimate = 거래일만 알고 16:00 으로 추정한 값: 같은 날 이미 아는 마감(조기 폐장 13:00)은 덮지 않는다
   */
  private async noteUsClose(iso: string, estimate = false): Promise<void> {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    await this.loadUsClose();
    const cur = this.usRegularClose;
    if (cur && t <= Date.parse(cur)) return;
    if (cur && estimate && nyParts(new Date(cur)).date === nyParts(new Date(t)).date) return;
    this.usRegularClose = new Date(t).toISOString();
    await this.deps.store?.set("discover:us-regular-close", this.usRegularClose).catch(() => undefined);
  }

  private loadUsClose(): Promise<void> {
    this.usCloseLoad ??= (async () => {
      const v = await this.deps.store?.get("discover:us-regular-close").catch(() => null);
      if (v && !Number.isNaN(Date.parse(v)) && (!this.usRegularClose || Date.parse(v) > Date.parse(this.usRegularClose))) this.usRegularClose = v;
    })();
    return this.usCloseLoad;
  }

  /** 토스 달력 상태 (2.5초까지만 기다린다) */
  private async calendarState(market: DiscoverMarket): Promise<MarketState | null> {
    if (!this.deps.calendar) return null;
    return (await within(this.deps.calendar.status(), CAL_WAIT_MS, null))?.[market] ?? null;
  }

  /**
   * 네이버 거래소 장 상태를 새로 받는다 (같은 때 한 번만). 다음 세션 경계(끝·다음 개장) 또는 5분까지 쓰고,
   * 실패하면 30초 동안 다시 묻지 않는다. 받아 둔 옛 값은 그대로 둔다 — 쓸 수 있는지는 currentSession 이 가린다.
   */
  private refreshExchange(): Promise<Partial<Record<DiscoverMarket, ExchangeStatus>> | null> {
    if (this.now.getTime() - this.exFailedAt < 30_000) return Promise.resolve(null);
    this.exInflight ??= this.deps.naver
      .marketStatus()
      .then((value) => {
        if (!Object.keys(value).length) throw new Error("네이버 장 상태가 비어 있습니다");
        const at = this.now.getTime();
        const bounds = Object.values(value)
          .flatMap((x) => [x.latest.closeAt, x.next?.openAt])
          .map((b) => Date.parse(b ?? ""))
          .filter((b) => !Number.isNaN(b) && b > at);
        // 한 시장만 온 응답이 다른 시장의 아직 유효한 값을 지우지 않게 시장별로 합친다
        const fetchedAt = { ...this.exStatus?.fetchedAt };
        for (const k of Object.keys(value) as DiscoverMarket[]) fetchedAt[k] = at;
        this.exStatus = { until: Math.min(at + 5 * 60_000, ...bounds), value: { ...this.exStatus?.value, ...value }, fetchedAt };
        try {
          this.learn(value, at);
        } catch {
          /* 기억은 부수 효과 — 요청을 실패시키지 않는다 */
        }
        return value;
      })
      .catch(() => {
        this.exFailedAt = this.now.getTime();
        return null;
      })
      .finally(() => {
        this.exInflight = null;
      });
    return this.exInflight;
  }

  /** 기억 갱신은 부수 효과 — 실패해도 요청·프로세스에 번지지 않게 */
  private noteKrTradeSoon(v: { day: string; close: string | null; exact: boolean; nextOpen: string | null }): void {
    this.noteKrTrade(v).catch(() => undefined);
  }

  private noteUsCloseSoon(iso: string, estimate = false): void {
    this.noteUsClose(iso, estimate).catch(() => undefined);
  }

  /** 저장해 둔 한국 거래일 기억을 한 번만 읽는다 (동시 요청이 모두 같은 읽기를 기다린다) */
  private loadKrTrade(): Promise<void> {
    this.krTradeLoad ??= (async () => {
      try {
        const raw = await this.deps.store?.get("discover:kr-last-trade");
        const v = raw ? (JSON.parse(raw) as KrTrade) : null;
        if (v && typeof v.day === "string" && typeof v.close === "string" && !Number.isNaN(Date.parse(v.close)) && (!this.krTrade || v.day > this.krTrade.day)) this.krTrade = v;
      } catch {
        /* 기억이 깨졌으면 없는 것으로 */
      }
    })();
    return this.krTradeLoad;
  }

  /**
   * 한국 거래일을 기억한다: 더 늦은 거래일이거나, 같은 날의 실제 마감(추정보다 우선)일 때만 바꾸고 meta 표에 쓴다.
   * close 가 없으면 그날 20:00(NXT 애프터마켓 끝) 추정
   */
  private async noteKrTrade(v: { day: string; close: string | null; exact: boolean; nextOpen: string | null }): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.day)) return;
    await this.loadKrTrade();
    const est = Date.parse(`${v.day}T20:00:00+09:00`);
    if (Number.isNaN(est)) return; // 형식만 맞고 없는 날짜(2026-13-01 등)
    const close = v.close && !Number.isNaN(Date.parse(v.close)) ? new Date(v.close).toISOString() : new Date(est).toISOString();
    const nextOpen = v.nextOpen && !Number.isNaN(Date.parse(v.nextOpen)) ? new Date(v.nextOpen).toISOString() : null;
    const cur = this.krTrade;
    if (cur && v.day < cur.day) return; // 더 이른 거래일로 되돌리지 않는다
    if (cur && v.day === cur.day) {
      if (cur.exact && !v.exact) return; // 실제 마감을 추정으로 덮지 않는다
      if (cur.close === close && cur.exact === v.exact && (cur.nextOpen ?? null) === nextOpen) return; // 같은 값
    }
    this.krTrade = { day: v.day, close, exact: v.exact, nextOpen };
    await this.deps.store?.set("discover:kr-last-trade", JSON.stringify(this.krTrade)).catch(() => undefined);
  }

  /**
   * 기억해 둔 한국 마지막 거래 마감. 지금보다 앞이고 14일 이내이며, 바로 앞 거래일의 것임이 확인될 때만 준다:
   * 기억한 '다음 개장'이 오늘 개장 시각과 같거나, 기억한 날과 오늘 사이에 평일이 없을 때. 아니면 null (틀린 날짜보다 낫다)
   */
  private async recallKrClose(t: number, todayOpen: string | null): Promise<string | null> {
    await this.loadKrTrade();
    const m = this.krTrade;
    const c = m ? Date.parse(m.close) : NaN;
    if (!m || Number.isNaN(c) || c > t || t - c >= SNAP_MAX_AGE_MS) return null;
    const sameOpen = !!todayOpen && !!m.nextOpen && Date.parse(todayOpen) === Date.parse(m.nextOpen);
    return sameOpen || !weekdayBetween(m.day, seoulIso(new Date(t)).slice(0, 10)) ? m.close : null;
  }

  /**
   * 지금 받은 값이 어느 시점 값인지: 장중·시간외는 지금, 장 시작 전·마감 뒤는 마지막 거래 마감(모르면 지금).
   * 이 시각을 목록에 붙여 두면, 나중에 출처가 비어 직전 목록을 보여 줄 때도 기준 시각이 맞다.
   */
  /** 장이 닫혀 있으면 마지막 마감 시각 (그 전에 받은 캐시 값은 새로 받는다), 아니면 undefined */
  private closedSince(ss: Session): number | undefined {
    const c = !ss.open && ss.lastClose ? Date.parse(ss.lastClose) : NaN;
    return Number.isNaN(c) ? undefined : c;
  }

  private dataTime(ss: Session, t: number): number {
    if (ss.session === "regular" || ss.session === "extended") return t;
    const c = ss.lastClose ? Date.parse(ss.lastClose) : NaN;
    return Number.isNaN(c) ? t : Math.min(t, c);
  }

  /**
   * 한국 값의 기준 시각: 장중·시간외는 값의 시각, 마감 뒤는 마지막 거래 마감(값의 시각이 더 이르면 그 시각).
   * 장 시작 전에 마지막 마감을 모르면(재시작 직후) 오늘 이전 값의 시각만 쓰고, 그것도 아니면 시각을 밝히지 않는다(틀린 날짜보다 낫다)
   */
  private krAsOf(ss: Session, at: number): string | null {
    if (ss.session === "regular" || ss.session === "extended") return seoulIso(new Date(at));
    if (ss.session === "pre" && !ss.lastClose) return at < Date.parse(`${seoulIso(this.now).slice(0, 10)}T00:00:00+09:00`) ? seoulIso(new Date(at)) : null;
    const close = Date.parse(ss.lastClose ?? lastKrClose(this.now));
    return seoulIso(new Date(Number.isNaN(close) ? at : Math.min(at, close)));
  }

  /** 미국 값(네이버 정규장 값)의 기준 시각: 정규장 중에는 받은 시각, 밖에서는 가장 최근 정규장 마감(보통 16:00 ET, 조기 폐장일 13:00) */
  private usAsOf(ss: Session, at: number): string {
    if (ss.session === "regular") return seoulIso(new Date(at));
    return seoulIso(new Date(Math.min(at, this.usCloseAt(ss))));
  }

  /** 가장 최근 미국 정규장 마감 시각: 달력이 준 마감이 정규장 시간(09:30~16:00) 안이면 그대로(조기 폐장 포함), 아니면 그날 16:00 */
  private usCloseAt(ss: Session): number {
    const lc = ss.lastClose ? new Date(ss.lastClose) : null;
    const m = lc && !Number.isNaN(lc.getTime()) ? nyParts(lc).minutes : -1;
    return lc && m > 9 * 60 + 30 && m <= 16 * 60 ? lc.getTime() : nyCloseOf(lastUsRegularDay(this.now, ss.lastClose));
  }

  /** "HH:MM" (서울) — 날짜가 오늘이 아니면 "M/D HH:MM" */
  private hm(t: number): string {
    const iso = seoulIso(new Date(t));
    const time = iso.slice(11, 16);
    return iso.slice(0, 10) === seoulIso(this.now).slice(0, 10) ? time : `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${time}`;
  }

  private ttl(open: boolean, slow = false): number {
    return open ? (slow ? 120_000 : 30_000) : 5 * 60_000;
  }

  private async fx(market: DiscoverMarket): Promise<number | null> {
    if (market !== "US" || !this.deps.usdKrw) return null;
    return within(this.deps.usdKrw(), FX_WAIT_MS, null);
  }

  /**
   * 캐시 → 없거나 오래되면 조회(같은 키는 한 번만) → 실패하면 직전 값.
   * 직전 값이 있으면 새 조회를 STALE_WAIT_MS 만 기다리고 직전 값을 준다(느린 출처가 화면을 붙잡지 않게, 새 값은 뒤에서 채운다).
   * 직전 값이 없는 실패는 잠시(기본 20초, 비싼 조회는 10분) 기억해 같은 오류를 바로 준다(상류 장애 때 요청마다 다시 부르지 않게).
   * 테마북을 만드는 중·출처 초기화처럼 곧 풀리는 실패는 기억하지 않는다.
   */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>, failCooldownMs = FAIL_RETRY_MS, staleBefore?: number): Promise<{ value: T; at: number }> {
    const hit = this.cache.get(key) as Cached<T> | undefined;
    const t = this.now.getTime();
    // 장이 닫힌 뒤(staleBefore = 마지막 마감)에는 마감 전에 받은 값을 TTL 과 상관없이 새로 받는다 (마감 직후 최종 값으로)
    if (hit && t - hit.at < ttl && !(staleBefore !== undefined && hit.at < staleBefore)) return { value: hit.value, at: hit.at };
    const failed = this.failures.get(key);
    if (!hit && failed && t - failed.at < failCooldownMs) throw failed.error;
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      const started = t;
      p = load()
        .then((value) => {
          this.cache.set(key, { at: started, value });
          this.failures.delete(key);
          this.prune();
          return value;
        })
        .catch((e: unknown) => {
          // 실패한 시각부터 센다 (느리게 실패한 조회가 바로 다시 불리지 않게)
          if (!(e instanceof UsThemesBuildingError || e instanceof PreopenError)) this.failures.set(key, { at: this.now.getTime(), error: e });
          throw e;
        })
        .finally(() => this.inflight.delete(key));
      p.catch(() => undefined); // 뒤에서 끝난 실패가 처리되지 않은 거부로 남지 않게
      this.inflight.set(key, p);
    }
    try {
      if (hit) {
        const r = await waitAtMost(p.then((v) => ({ v })), this.deps.staleWaitMs ?? STALE_WAIT_MS);
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

  /**
   * 캐시·실패 기억이 커지지 않게 (테마 id 는 요청마다 달라질 수 있다) — 400개를 넘으면 1시간 넘게 지난 것부터 지운다
   */
  private prune(): void {
    const t = this.now.getTime();
    for (const m of [this.cache, this.failures] as Map<string, { at: number }>[]) {
      if (m.size <= 400) continue;
      for (const [k, v] of m) if (t - v.at > 3_600_000) m.delete(k);
      if (m.size > 400) [...m.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, m.size - 400).forEach(([k]) => m.delete(k));
    }
  }

  /**
   * 직전 값 저장본 쓰기. savedAt 은 그 값을 처음 받은 시각(= 값의 시각)이다.
   * meta 표에는 값이 바뀌었을 때만, 10분에 한 번(장 마감 뒤 첫 값은 force 로 바로) 쓴다 — 장 밖에 같은 값을 5분마다 다시 쓰지 않게.
   */
  private async saveSnap(key: string, value: unknown, force = false, dataAt?: number): Promise<void> {
    const t = this.now.getTime();
    const sig = fingerprint(JSON.stringify(value));
    const prev = this.snaps.get(key);
    // 같은 값이면 처음 받은 시각을 두되, 마감 뒤(force)에 다시 확인했으면 값의 시각을 그 마감(dataAt)으로 올린다
    // (시간외에 본 값과 마감 뒤 값이 같으면 "마감 기준"이 맞다)
    const same = !!prev && prev.sig === sig;
    const savedAt = prev && same ? (force && dataAt !== undefined ? Math.max(prev.savedAt, dataAt) : prev.savedAt) : (dataAt ?? t);
    const persist = (prev?.persistedSig !== sig || (!!prev && same && savedAt !== prev.savedAt)) && (force || !prev || t - prev.persistedAt >= SNAP_PERSIST_EVERY_MS);
    this.snaps.set(key, { savedAt, sig, value, persistedAt: persist ? t : (prev?.persistedAt ?? 0), persistedSig: persist ? sig : (prev?.persistedSig ?? "") });
    if (persist) await this.deps.store?.set(`discover:snap:${key}`, JSON.stringify({ savedAt, value })).catch(() => undefined);
  }

  /** 직전 값 저장본 읽기 (14일 넘으면 버림) */
  private async loadSnap<T>(key: string): Promise<{ savedAt: number; value: T } | null> {
    const t = this.now.getTime();
    const mem = this.snaps.get(key);
    if (mem) return t - mem.savedAt < SNAP_MAX_AGE_MS ? { savedAt: mem.savedAt, value: mem.value as T } : null;
    try {
      const raw = await this.deps.store?.get(`discover:snap:${key}`);
      if (!raw) return null;
      const v = JSON.parse(raw) as { savedAt: number; value: T };
      if (typeof v.savedAt !== "number" || t - v.savedAt >= SNAP_MAX_AGE_MS) return null;
      const sig = fingerprint(JSON.stringify(v.value));
      this.snaps.set(key, { savedAt: v.savedAt, sig, persistedAt: v.savedAt, persistedSig: sig, value: v.value });
      return v;
    } catch {
      return null;
    }
  }

  /**
   * 순위 한 쪽. ver: 첫 쪽이 준 목록 판(뒤 쪽을 같은 목록에서 이어 받기).
   * opts.restart: 요청한 앱이 restart 를 안다 (r=1). 그때만 잃은 판의 뒤 쪽에 빈 쪽 + restart 를 준다 — 없으면 예전 서버처럼 지금 목록의 쪽
   */
  async rank(market: DiscoverMarket, category: RankCategory, page: number, size: number, ver?: number, opts: { restart?: boolean } = {}): Promise<DiscoverRank> {
    const ss = await this.session(market);
    const open = ss.open;
    const key = `${market}:${category}`;
    const t = this.now.getTime();
    const need = page * size + 1; // 다음 쪽이 있는지 알기 위해 하나 더
    // 뒤 쪽 요청이 첫 쪽의 목록 판(ver)을 가져오면 그 목록에서 이어 준다 (첫 쪽을 받은 뒤 새 목록이 들어왔어도)
    const pinned = page > 1 && ver !== undefined ? [this.ranks.get(key), ...(this.prevRanks.get(key) ?? [])].find((x) => x?.ver === ver) : undefined;
    // 그 판을 더 갖고 있지 않으면(재시작·최근 5판 밖) 지금 목록으로 대신 이어 주지 않는다 — 판이 다른 쪽을 붙이면
    // 순위가 바뀐 종목이 빠지고 순위 번호가 어긋난다. 빈 쪽 + restart 로 첫 쪽부터 다시 받게 한다.
    // restart 를 모르는 옛 앱(r=1 없음)은 빈 쪽을 붙이고 더 보기·자동 갱신이 말없이 멈추므로 예전처럼 지금 목록의 쪽을 준다 (아래)
    const gone = opts.restart === true && page > 1 && ver !== undefined && !pinned;
    if (gone) {
      // 원본은 받지 않고 바로 알린다 — 새 목록은 이어 올 첫 쪽 요청이 받는다 (깊은 쪽이라고 수백 줄을 받느라 늦거나, 원본 실패로 restart 대신 오류가 나지 않게)
      const cur = this.ranks.get(key);
      return {
        market,
        category,
        items: [],
        page,
        hasMore: false,
        marketOpen: open,
        session: ss.session,
        ver: cur?.ver ?? 0, // 가진 목록이 없으면(재시작 직후) 0
        restart: true,
        asOf: null,
        fxRate: null, // 앱은 첫 쪽의 환율을 쓴다
        source: cur?.source ?? "",
        note: "목록이 바뀌어 첫 쪽부터 다시 받습니다",
      };
    }
    let st = pinned ?? this.ranks.get(key);
    // 새 목록은 첫 쪽 요청 때 받는다. 뒤 쪽은 첫 쪽과 같은 목록에서 이어 줘야 종목이 빠지거나 두 번 나오지 않는다
    // (앱은 새로고침 때 첫 쪽부터 차례로 다시 받는다). 뒤 쪽만 너무 오래(TTL 3배) 요청되면 그때는 새로 받는다
    const maxAge = this.ttl(open) * (page === 1 ? 1 : PAGE_TTL_FACTOR);
    // 장이 닫힌 뒤에는 마감 전에 확인한 목록을 TTL 과 상관없이 새로 받는다 (마감 직후 최종 값·마감 기준 시각으로)
    const closeAt = !open && ss.lastClose ? Date.parse(ss.lastClose) : NaN;
    const beforeClose = !!st && !Number.isNaN(closeAt) && st.checkedAt < closeAt && t >= closeAt;
    if (!pinned && (!st || t - st.checkedAt >= maxAge || beforeClose)) {
      const failed = this.failures.get(`rank:${key}`);
      if (!st && failed && t - failed.at < FAIL_RETRY_MS) throw failed.error;
      const p = this.refreshRank(market, category, key, need, ss);
      if (st) {
        // 직전 목록이 있으면 새 조회를 잠깐만 기다린다 (느린 출처가 화면을 붙잡지 않게, 새 목록은 뒤에서 채운다)
        await waitAtMost(p.catch(() => undefined), this.deps.staleWaitMs ?? STALE_WAIT_MS);
      } else await p;
      st = this.ranks.get(key) ?? st;
    }
    if (st && st.items.length < need && st.hasNext && !st.stale && !st.fromSnapshot) {
      // 더 받기. 새 목록을 받는 중이면 그것부터 기다린다 (옛 목록 뒤에 새 목록 줄이 붙지 않게). 판을 고정한 요청은 그 목록에 이어 받는다
      const pending = this.inflight.get(`rank:${key}`);
      if (pending && !pinned) {
        await pending.catch(() => undefined);
        st = this.ranks.get(key) ?? st;
      }
      const base = st;
      if (base.items.length < need && base.hasNext && !base.stale && !base.fromSnapshot) {
        try {
          const more = await this.fillRank(market, category, base, need);
          if (this.ranks.get(key) === base) this.ranks.set(key, more);
          else {
            const prev = this.prevRanks.get(key);
            const i = prev?.indexOf(base) ?? -1;
            if (prev && i >= 0) prev[i] = more;
          }
          st = more;
        } catch {
          /* 더 받기 실패: 가진 만큼 */
        }
      }
    }
    const s = st!;
    const items = s.items.slice((page - 1) * size, page * size);
    // 기준 시각: 출처가 체결 시각을 주면 그 시각(미국), 한국은 장 상태에 따라 받은 시각 또는 마지막 거래 마감
    const asOf = s.tradedAt ? seoulIso(new Date(s.tradedAt)) : market === "KR" ? this.krAsOf(ss, s.at) : seoulIso(new Date(s.at));
    const movers = category === "gainers" || category === "losers";
    return {
      market,
      category,
      items,
      page,
      hasMore: page < MAX_PAGE && items.length > 0 && (s.items.length > page * size || s.hasNext),
      marketOpen: open,
      session: ss.session,
      ver: s.ver,
      asOf,
      fxRate: await this.fx(market),
      source: s.source,
      note: [
        !s.items.length ? "출처가 잠시 목록을 비웠습니다 (곧 다시 채워집니다)" : s.stale ? "출처가 잠시 목록을 비워 직전 목록을 보여 줍니다" : s.fromSnapshot ? "저장해 둔 직전 목록입니다" : null,
        market === "KR" ? (movers ? "KRX 시세 · ETF·ETN·스팩·정리매매 제외" : "KRX 시세 · ETF·ETN·스팩 제외") : "정규장 시세 · ETF·우선주·채권·권리주 제외",
        movers ? `거래대금 ${market === "KR" ? "10억 원" : "100만 달러"} 이상` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  /**
   * 순위 목록을 처음부터 새로 받는다 (같은 분류는 한 번만).
   * 출처가 비었거나(장 시작 전 초기화) 실패하면 가진 직전 목록을 유지하고, 없으면 저장본(재시작 뒤)으로 채운다.
   */
  private refreshRank(market: DiscoverMarket, category: RankCategory, key: string, need: number, ss: Session): Promise<void> {
    const ik = `rank:${key}`;
    const running = this.inflight.get(ik) as Promise<void> | undefined;
    if (running) return running;
    const t = this.now.getTime();
    const at = this.dataTime(ss, t); // 마감 뒤에 받은 목록은 마지막 거래 마감 시점 값
    const p = (async () => {
      try {
        const fresh = await this.fillRank(market, category, { at, checkedAt: t, ver: t, items: [], next: 0, hasNext: true, source: "", tradedAt: null }, need);
        this.failures.delete(ik);
        if (fresh.items.length && !fresh.preopen) {
          const old = this.ranks.get(key);
          if (old?.items.length) this.prevRanks.set(key, [old, ...(this.prevRanks.get(key) ?? []).filter((x) => x.ver !== old.ver)].slice(0, 5));
          this.ranks.set(key, fresh);
          // 값이 있을 때 저장본을 남긴다 (재시작 뒤·출처 초기화 때 직전 목록을 보여 주려고)
          // 시각 필드는 빼고 남긴다 (같은 목록이면 같은 지문 → 다시 쓰지 않게. 값의 시각은 저장본 시각으로)
          void this.saveSnap(`rank:${key}`, { items: fresh.items.slice(0, SNAP_RANK_ITEMS), source: fresh.source, tradedAt: fresh.tradedAt }, !ss.open, at);
          return;
        }
        // 출처가 비었다: 가진 직전 목록을 그대로 두고(더 이어 받지 않음) 다음 확인은 TTL 뒤. 없으면 저장본
        const cur = this.keptRank(key);
        if (cur) {
          this.ranks.set(key, { ...cur, checkedAt: t, stale: !cur.fromSnapshot, next: MAX_SOURCE_PAGES, hasNext: false });
          return;
        }
        this.ranks.set(key, (await this.rankSnapshot(key, t)) ?? { ...fresh, items: [], hasNext: false });
      } catch (e) {
        this.failures.set(ik, { at: this.now.getTime(), error: e });
        const cur = this.keptRank(key);
        if (cur) {
          this.ranks.set(key, { ...cur, checkedAt: this.now.getTime() });
          return;
        }
        const snap = await this.rankSnapshot(key, t);
        if (!snap) throw e;
        this.ranks.set(key, snap);
      }
    })().finally(() => this.inflight.delete(ik));
    p.catch(() => undefined); // 뒤에서 끝난 실패가 처리되지 않은 거부로 남지 않게
    this.inflight.set(ik, p);
    return p;
  }

  /** 메모리에 가진 직전 목록 (값이 있고 14일 이내일 때만) */
  private keptRank(key: string): RankState | null {
    const cur = this.ranks.get(key);
    return cur?.items.length && this.now.getTime() - cur.at < SNAP_MAX_AGE_MS ? cur : null;
  }

  /** 저장본 목록. 더 이어 받지 않고(지금 출처는 비어 있으므로), 기준 시각은 저장한 시각 */
  private async rankSnapshot(key: string, t: number): Promise<RankState | null> {
    const snap = await this.loadSnap<Pick<RankState, "items" | "source" | "tradedAt">>(`rank:${key}`);
    if (!snap?.value.items?.length) return null;
    const { items, source, tradedAt } = snap.value;
    return { items, source, tradedAt: tradedAt ?? null, at: snap.savedAt, checkedAt: t, ver: t, next: MAX_SOURCE_PAGES, hasNext: false, fromSnapshot: true };
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
    // 미국 원본(api.stock.naver.com)은 같은 쪽을 물어도 서버마다 다른 시점의 목록(최대 1분 전)을 주고, 가끔 한 종목이 빠진 채 온다.
    // 쪽마다 두 벌을 함께 받아 합치고, 묶음에서 가장 새 값보다 늦은 쪽은 한 번 더 받는다 (한국 원본은 한 벌)
    const copies = market === "US" ? US_RANK_COPIES : 1;
    const tau = (p: { tradedAt?: string | null }) => (p.tradedAt ? Date.parse(p.tradedAt) || 0 : 0);
    type Page = Awaited<ReturnType<RankSource>>;
    // 벌 하나가 실패해도 같은 쪽의 다른 벌이 오면 그 쪽은 받은 것으로 본다 (쪽의 모든 벌이 실패할 때만 실패)
    const fetchPage = async (i: number): Promise<Page[]> => {
      const rs = await Promise.allSettled(Array.from({ length: copies }, () => src.source(category, i)));
      const ok = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!ok.length) throw (rs[0] as PromiseRejectedResult).reason;
      return ok;
    };
    while (items.length < need && hasNext && next < MAX_SOURCE_PAGES) {
      // 이어 받을 때는 바로 앞 쪽도 다시 받는다 — 살아 있는 출처 목록에서 그 사이 한 쪽 위로 올라온 종목이 쪽 경계에서 빠지지 않게
      // (겹친 줄은 seen 이 거른다)
      const fresh = [next, next + 1, next + 2].filter((i) => i < MAX_SOURCE_PAGES);
      const batch = next > 0 ? [next - 1, ...fresh] : fresh;
      const got = await Promise.all(batch.map(fetchPage));
      const newest = Math.max(...got.flat().map(tau));
      const lagging = (cs: Page[]) => newest > 0 && newest - Math.max(...cs.map(tau)) > STALE_PAGE_MS;
      const late = batch.map((_, j) => j).filter((j) => lagging(got[j]!));
      if (market === "US" && late.length) {
        // 다시 받기가 실패하면 가진 벌로 간다
        const more = await Promise.all(late.map((j) => fetchPage(batch[j]!).catch(() => [] as Page[])));
        late.forEach((j, n) => got[j]!.push(...more[n]!));
      }
      // 쪽마다 초기화(PREOPEN) 벌은 빼고 쓴다 — 그 쪽의 모든 벌이 초기화일 때만 초기화로 본다
      // (초기화된 쪽의 줄(0%)은 넣지 않는다 — 직전 목록 뒤에 오늘 0% 줄이 섞이지 않게)
      const usable = got.map((cs) => cs.filter((p) => !p.preopen));
      if (usable.some((cs) => !cs.length)) preopen = true;
      // 받은 벌을 모두 합치되 새 값부터 넣는다 — seen 이 종목마다 가장 새 줄을 남기고, 묵은 벌은 새 벌에 없던 종목만 보탠다.
      // 가장 새 벌과 거래일(현지 날짜)이 다른 벌은 버린다 (개장 직후 묵은 서버가 주는 전날 목록이 오늘 목록 위에 섞이지 않게)
      const all = usable.flat().sort((a, b) => tau(b) - tau(a));
      const day = (p: Page) => p.tradedAt?.slice(0, 10) ?? "";
      const today = all[0] ? day(all[0]) : "";
      for (const p of all) {
        if (today && day(p) && day(p) !== today) continue;
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
      next += fresh.length;
      hasNext = usable.at(-1)?.some((p) => p.hasNext) ?? false;
      if (usable.some((cs) => cs.length > 0 && cs.every((p) => !p.hasNext))) hasNext = false;
      if (preopen) {
        hasNext = false; // 장 시작 전 초기화 — 더 받아도 쓸 값이 없다
        break;
      }
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
    return { ...start, items: [...start.items, ...added], next, hasNext, source: src.name, tradedAt, preopen };
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
    const ss = await this.session(market);
    if (market === "US" && kind === "theme" && this.deps.usThemes) {
      try {
        return await this.usThemeList(ss, period);
      } catch (e) {
        // 토스 테마를 못 받거나 처음 만드는 중이면 네이버 산업 분류로 대신 (빈 화면·긴 기다림보다 낫다)
        const alt = await this.naverThemes("US", "sector", period, ss);
        const why =
          e instanceof UsThemesBuildingError
            ? "미국 테마를 처음 준비하는 중이라(약 1분)"
            : e instanceof PreopenError
              ? "출처가 잠시 미국 시세를 비운 시간이라"
              : "미국 테마를 불러오지 못해";
        return { ...alt, note: `${why} 산업 분류로 대신 보여 줍니다` };
      }
    }
    return this.naverThemes(market, market === "US" ? "sector" : kind, period, ss);
  }

  private async naverThemes(market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod, ss: Session): Promise<ThemeList> {
    const snapKey = `themes:${market}:${kind}:${period}`;
    const { value } = await this.cached(snapKey, this.ttl(ss.open, period !== "day"), async (): Promise<ThemeListValue> => {
      const dataAt = this.dataTime(ss, this.now.getTime());
      const live = ss.session === "regular" || ss.session === "extended";
      const list = await this.deps.naver.sectors(market, kind, period);
      // 장 시작 전 초기화(거의 모든 등락률 0)면 직전 저장본을 쓴다
      if (list.length > 5 && isMostlyZero(list)) {
        const snap = await this.loadSnap<ThemeSummary[]>(snapKey);
        if (snap) return { themes: snap.value, dataAt: snap.savedAt, fromSnap: true, zero: false, live };
        return { themes: list, dataAt, fromSnap: false, zero: true, live };
      }
      // 오늘 목록에 출처가 잠깐 끼워 주는 빈 항목(등락률 0 · 상승·보합·하락 0/0/0, 미국 개장 직후 실측 137→150개)은 뺀다.
      // 빈 항목이 목록의 1/5 이상이면 출처가 값을 비우는 중이라 그대로 둔다 (목록이 통째로 줄지 않게)
      const empty = (t: ThemeSummary) => t.changeRate === 0 && t.up + t.flat + t.down === 0;
      const nEmpty = period === "day" ? list.filter(empty).length : 0;
      const shown = nEmpty && nEmpty * 5 < list.length ? list.filter((t) => !empty(t)) : list;
      // 오늘 등락률만 조정한다 (주·월은 상장 첫날 값이 섞여도 기간 수익률 계산 기준이 달라 네이버 값 그대로)
      const out = market === "KR" && period === "day" ? await this.adjustForNewListings(kind, shown, await this.newlyListed(ss.open)) : shown;
      void this.saveSnap(snapKey, out, !ss.open, dataAt);
      return { themes: out, dataAt, fromSnap: false, zero: false, live };
    }, FAIL_RETRY_MS, this.closedSince(ss));
    const dataAt = value.dataAt;
    return {
      market,
      kind,
      period,
      themes: value.themes,
      marketOpen: ss.open,
      session: ss.session,
      asOf: market === "KR" ? this.krAsOf(ss, dataAt) : this.usAsOf(ss, dataAt),
      source: "네이버 증권",
      basis: naverBasis(market, kind),
      note: value.zero ? "출처가 잠시 등락률을 0으로 비웠습니다 (곧 다시 채워집니다)" : value.fromSnap ? "출처가 잠시 값을 비워 저장해 둔 직전 값을 보여 줍니다" : null,
    };
  }

  /** 미국 테마북 구성 종목 전체의 정규장 시세 (한 번에, 캐시) */
  private async usThemeQuotes(book: UsThemeBookData, open: boolean): Promise<{ value: Map<string, UsQuote>; at: number }> {
    const codes = [...new Set(book.themes.flatMap((t) => t.members.map((m) => m.reuters)))];
    const key = `usq:${book.builtAt}`;
    // 테마북이 새로 만들어지면 옛 시세 묶음은 버린다 (하루에 하나씩 쌓이지 않게)
    for (const k of this.cache.keys()) if (k.startsWith("usq:") && k !== key) this.cache.delete(k);
    return this.cached(key, this.ttl(open), async () => {
      const q = await this.deps.naver.usQuotes(codes);
      if (isPreopenQuotes(q)) {
        // 뉴욕 03:40~04:00(한국 16:40~17:00): 네이버가 잠시 등락률·거래량을 0 으로 초기화한다 → 직전 정규장 저장본
        const snap = await this.loadSnap<[string, UsQuote][]>("usq");
        if (snap) return new Map(snap.value);
        throw new PreopenError("미국 테마 시세");
      }
      void this.saveSnap("usq", [...q.entries()], !open);
      return q;
    });
  }

  private async usThemeList(ss: Session, period: ThemePeriod): Promise<ThemeList> {
    const usThemes = this.deps.usThemes!;
    const open = ss.open;
    if (period === "day") {
      const book = await usThemes.get(this.deps.bookWaitMs ?? BOOK_WAIT_MS);
      const { value: quotes, at } = await this.usThemeQuotes(book, open);
      const day = latestTradeDay(quotes.values());
      // 구성 종목 거래대금 합이 100만 달러 미만인 테마(동전주 몇 개짜리)는 뺀다 — 급상승 순위와 같은 기준
      const rows = book.themes.map((t) => usThemeSummary(t, quotes, day)).filter((x): x is NonNullable<typeof x> => !!x);
      const { keep, withPrev } = await this.usTvFilter(new Map(rows.map((r) => [r.summary.id, r.tradingValue])), quotes, day, ss);
      const themes = rows.filter((r) => keep(r.summary.id)).map((r) => r.summary);
      const dropped = rows.length - themes.length;
      const tradedAt = [...quotes.values()].map((q) => q.tradedAt).filter((x): x is string => !!x && !Number.isNaN(Date.parse(x))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
      return {
        market: "US",
        kind: "theme",
        period,
        themes,
        marketOpen: open,
        session: ss.session,
        asOf: seoulIso(new Date(tradedAt ?? at)),
        source: "토스증권 테마 분류 · 네이버 증권 시세",
        basis: "테마별 시가총액 상위 종목의 시가총액 가중 평균 (정규장)",
        note: dropped ? (withPrev ? `오늘·직전 정규장 거래대금이 모두 100만 달러 미만인 테마 ${dropped}개 제외` : `거래대금 100만 달러 미만 테마 ${dropped}개 제외`) : null,
        updatedAt: seoulIso(new Date(book.builtAt)),
      };
    }
    const snap = await this.usPeriodRates(ss, period);
    const word = period === "week" ? "1주" : "1개월";
    // 지금 값이면 앱 상태 줄이 "장외 시간 · 현재가 기준"이라고 먼저 밝힌다
    const when = snap.inSession ? (open ? null : `직전 정규장 중 ${this.hm(snap.capturedAt)} 값`) : "주간·프리·애프터 가격이 섞일 수 있음";
    return {
      market: "US",
      kind: "theme",
      period,
      themes: snap.themes,
      marketOpen: open,
      session: ss.session,
      ...(snap.inSession ? {} : { live: true }),
      asOf: seoulIso(new Date(snap.capturedAt)),
      source: "토스증권",
      basis: `토스증권 테마 ${word} 등락률 (미국 종목, 시가총액 가중)`,
      note: [
        when,
        `${period === "week" ? "1주는" : "1개월은"} 상승·하락 종목 수 없이 등락률만`,
        snap.themes.length < snap.total ? `기간 등락률을 받은 테마만 (${snap.themes.length}/${snap.total}개)` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      updatedAt: seoulIso(new Date(snap.builtAt)),
    };
  }

  /**
   * 미국 테마를 거래대금으로 거르는 기준 (급상승 순위와 같은 100만 달러, 동전주 몇 개짜리 테마를 뺀다).
   * 개장 직후에는 오늘 누적 거래대금이 거의 0 이라 오늘 값만 보면 190개 중 4개만 남는다 →
   * 개장 뒤 US_OPEN_GRACE_MIN 동안은 직전 정규장 거래대금이 기준을 넘어도 남긴다(withPrev).
   * 직전 정규장 값은 장이 닫혀 있을 때, 끝난 정규장 하루치일 때만 기억한다 (모든 종목이 OPEN·PREOPEN 이 아니고 날짜가 마지막 정규장 날)
   */
  private async usTvFilter(today: Map<string, number>, quotes: Map<string, UsQuote>, day: string, ss: Session): Promise<{ keep: (id: string) => boolean; withPrev: boolean }> {
    const min = MIN_TRADING_VALUE.US;
    const todayOk = (id: string) => (today.get(id) ?? 0) >= min;
    if (!ss.open) {
      const settled = ![...quotes.values()].some((q) => q.status === "OPEN" || q.status === "PREOPEN");
      if (day && today.size && settled && day === lastUsRegularDay(this.now, ss.lastClose)) await this.rememberUsThemeTv(day, today);
      return { keep: todayOk, withPrev: false };
    }
    if (nyParts(this.now).minutes - (9 * 60 + 30) >= US_OPEN_GRACE_MIN) return { keep: todayOk, withPrev: false };
    await this.loadUsThemeTv();
    const prev = this.usThemeTv && this.usThemeTv.day < day ? this.usThemeTv.tv : null;
    if (!prev) return { keep: todayOk, withPrev: false };
    return { keep: (id) => todayOk(id) || (prev.get(id) ?? 0) >= min, withPrev: true };
  }

  private async rememberUsThemeTv(day: string, tv: Map<string, number>): Promise<void> {
    this.usThemeTv = { day, tv };
    const sig = `${day}:${tv.size}:${Math.round([...tv.values()].reduce((a, b) => a + b, 0))}`;
    if (sig === this.usThemeTvSaved || !this.deps.store) return;
    try {
      await this.deps.store.set(US_THEME_TV_KEY, JSON.stringify({ day, tv: [...tv] }));
      this.usThemeTvSaved = sig;
    } catch {
      /* 다음 호출에서 다시 쓴다 */
    }
  }

  private async loadUsThemeTv(): Promise<void> {
    if (this.usThemeTv || !this.deps.store) return;
    this.usThemeTvLoad ??= (async () => {
      try {
        const raw = await this.deps.store!.get(US_THEME_TV_KEY);
        const v = raw ? (JSON.parse(raw) as { day?: unknown; tv?: unknown }) : null;
        if (!this.usThemeTv && v && typeof v.day === "string" && Array.isArray(v.tv)) {
          const tv = new Map<string, number>();
          for (const e of v.tv) if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") tv.set(e[0], e[1]);
          this.usThemeTv = { day: v.day, tv };
        }
      } catch {
        this.usThemeTvLoad = null; // 읽기 실패는 다음 요청에서 다시 (그동안은 오늘 값으로만 거른다)
      }
    })();
    await this.usThemeTvLoad;
  }

  /**
   * 미국 테마 1주·1개월 등락률. 토스 값은 그때의 현재가 기준이라 장 밖(한국 낮)에는 주간거래·프리·애프터 가격이 섞인다.
   * 그래서 미국 정규장 중에 받은 값을 남겨 두고(meta, 매일 뉴욕 15:50 에도 받아 둔다), 장 밖에는 그 값을 쓴다.
   * 남긴 값이 가장 최근 정규장 것이 아니면(며칠 지난 값) 쓰지 않고 지금 값을 받아 그렇다고 밝힌다.
   */
  private async usPeriodRates(ss: Session, period: ThemePeriod): Promise<UsPeriodSnapshot> {
    const storeKey = `discover:us-tics-period:${period}`;
    const open = ss.open;
    if (!open) {
      const kept = this.periodSnaps.get(period) ?? (await this.loadPeriodSnap(storeKey));
      if (kept) this.periodSnaps.set(period, kept);
      if (kept?.inSession && nyParts(new Date(kept.capturedAt)).date === lastUsRegularDay(this.now, ss.lastClose)) return kept;
    }
    const { value } = await this.cached(`usperiod:${period}:${open ? "open" : "closed"}`, open ? 15 * 60_000 : 10 * 60_000, () => this.computePeriodRates(ss, period), FAIL_COOLDOWN_MS);
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

  /**
   * 미국 정규장 끝나기 직전(뉴욕 15:50) 1주·1개월 테마 등락률을 받아 남긴다 — 화면을 열지 않은 날에도
   * 장 밖(한국 낮)에 그날 정규장 값을 보여 줄 수 있게. 정규장이 아니면(휴장일) 아무것도 하지 않는다.
   */
  async captureUsPeriods(): Promise<number> {
    if (!this.deps.usThemes || !this.deps.tics) return 0;
    const ss = await this.session("US");
    if (ss.session !== "regular") return 0;
    let saved = 0;
    const errors: unknown[] = [];
    for (const period of ["week", "month"] as const) {
      // 캐시와 직전 실패 기억을 지우고 지금 값을 받는다 (10분 안의 실패에 막혀 건너뛰지 않게)
      this.cache.delete(`usperiod:${period}:open`);
      this.failures.delete(`usperiod:${period}:open`);
      try {
        if ((await this.usPeriodRates(ss, period)).inSession) saved++;
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length) throw new Error(`미국 테마 기간 등락률 저장 실패 ${errors.length}건: ${String(errors[0])}`);
    return saved;
  }

  private async computePeriodRates(ss: Session, period: ThemePeriod): Promise<UsPeriodSnapshot> {
    const open = ss.open;
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
    const keep = quotes ? (await this.usTvFilter(new Map(book.themes.map((t) => [t.id, usThemeSummary(t, quotes!, day)?.tradingValue ?? 0])), quotes, day, ss)).keep : null;
    const targets = keep ? book.themes.filter((t) => keep(t.id)) : book.themes;
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
    const ss = await this.session(market);
    const open = ss.open;
    if (market === "US" && kind === "theme" && this.deps.usThemes) return this.usTheme(ss, id);
    const k: ThemeKind = market === "US" ? "sector" : kind;
    // 목록의 상승·보합·하락 수는 구성 종목과 함께 받는다 (차례로 기다리지 않게)
    const listedP = this.listedTheme(market, k, id, ss, SUMMARY_WAIT_MS).catch(() => null);
    let got: { value: { detail: SectorDetail | null; dataAt: number }; at: number };
    try {
      got = await this.cached(
        `theme:${market}:${k}:${id}`,
        this.ttl(open),
        async () => {
          const dataAt = this.dataTime(ss, this.now.getTime());
          return { detail: await this.deps.naver.sectorDetail(market, k, id), dataAt };
        },
        FAIL_RETRY_MS,
        this.closedSince(ss),
      );
    } catch (e) {
      // 네이버 미국 업종은 없는 코드에 404 대신 500 을 준다 → 업종 목록(없으면 받아서)에 없으면 "없음"
      if (market === "US" && (await this.sectorIds("US", ss))?.has(id) === false) return null;
      throw e;
    }
    let dataAt = got.value.dataAt;
    let value = got.value.detail;
    if (!value) return null;
    let note: string | null = null;
    /** 종목 값을 저장본으로 덮었으면 그 저장본 시각과 비워진 종목을 모두 덮었는지 (업종 요약을 종목과 같은 시점으로 맞추려고) */
    let restored: { savedAt: number; all: boolean } | null = null;
    /** 출처가 미국 업종 값을 비웠다 (출처 요약도 비운 때 값) */
    const reset = market === "US" && !open && isMostlyZero(value.items, 0.8);
    if (reset) {
      // 출처 초기화(뉴욕 03:40~04:00): 종목 값이 0 — 미국 테마 시세 저장본(약 2,500종목)으로 0 인 종목만 덮는다
      const snap = await this.loadSnap<[string, UsQuote][]>("usq");
      const byTicker = new Map((snap?.value ?? []).map(([, q]) => [q.code, q] as const));
      let hit = 0;
      let blank = 0;
      const items = value.items.map((i) => {
        if (i.changeRate !== 0 || i.volume) return i;
        blank++;
        const q = byTicker.get(i.code);
        if (!q) return i;
        hit++;
        return { ...i, price: q.price, change: q.change, changeRate: q.changeRate, volume: q.volume, tradingValue: q.tradingValue };
      });
      value = { ...value, items };
      if (hit && snap) {
        dataAt = snap.savedAt;
        restored = { savedAt: snap.savedAt, all: hit === blank };
      }
      // 저장본에 없는 종목은 비워진 0% 그대로라고 밝힌다 (덮은 종목과 시점이 다르다)
      const rest = blank - hit;
      note = hit
        ? `출처가 잠시 값을 비워 종목 값은 저장해 둔 직전 정규장 값 (${hit}/${items.length}종목${rest ? ` · ${rest}종목은 비워진 0% 그대로` : ""})`
        : "출처가 잠시 종목별 등락률을 0으로 비웠습니다 (곧 다시 채워집니다)";
    }
    // 한국 장 시작 전: 출처가 종목 값을 0으로 비워 두면 그렇다고 밝힌다 (거래정지로 오해하지 않게)
    if (market === "KR" && ss.session === "pre" && isMostlyZero(value.items)) note = "장 시작 전이라 종목별 값이 비어 있습니다 (정규장부터 채워집니다)";
    // 목록과 같은 조건으로만 조정한다: 상장 첫날 종목이 등락률 상위 3(네이버 대표 종목)에 들 때
    const fresh = market === "KR" ? await this.newlyListed(open) : new Set<string>();
    const top3 = [...value.items].sort((a, b) => b.changeRate - a.changeRate).slice(0, 3);
    const truncated = value.items.length >= SECTOR_MAX_ITEMS;
    const adjust = top3.some((i) => fresh.has(i.code)) && !truncated;
    let theme = adjust ? recount(value.theme, value.items, fresh, k === "sector") : value.theme;
    // 상승·보합·하락 수는 목록(출처)과 같게: 받아 둔 목록에 이 테마가 있으면 그 수, 구성 종목이 잘렸는데 목록도 없으면 세지 않는다
    // 다시 센 값(adjust)이면 목록 수는 쓰지 않는다 (listedP 는 시작부터 SUMMARY_WAIT_MS 안에 끝난다)
    const listed = adjust ? null : await listedP;
    /** 상승·보합·하락 수를 가져온 목록 요약 (잘린 업종의 전체 종목 수) */
    let counted: ThemeSummary | null = null;
    /** 출처가 비웠는데 덮지 못했을 때 마감 뒤(비우기 전) 업종 목록의 요약 */
    const closed = reset && !restored ? await this.closeListed(id, this.usCloseAt(ss), listed) : null;
    if (restored) {
      // 종목 값을 저장본으로 덮었으면 출처 요약은 비운 때 값이라 종목과 시점이 다르다 → 같은 시점 요약으로 맞춘다
      const r = await this.restoredSummary(ss, value, restored, listed, truncated);
      theme = r.theme;
      counted = r.counted;
      if (r.note) note = [note, r.note].filter(Boolean).join(" · ");
    } else if (closed) {
      // 비워진 채인 종목과 달리 머리는 마감 뒤 목록 값 — 등락률까지 그 목록 값으로 (수만 가져오면 머리 안에서 시점이 섞인다)
      theme = { ...theme, changeRate: closed.changeRate, up: closed.up, flat: closed.flat, down: closed.down };
      counted = closed;
      note = [note, "업종 등락률·상승/하락 수는 비우기 전 업종 목록 값입니다"].filter(Boolean).join(" · ");
    } else if (!adjust && listed && listed.up + listed.flat + listed.down > 0) {
      theme = { ...theme, up: listed.up, flat: listed.flat, down: listed.down };
      counted = listed;
    } else if (!adjust && truncated) theme = { ...theme, up: 0, flat: 0, down: 0 };
    if (truncated) {
      const total = counted ? counted.up + counted.flat + counted.down : 0;
      note = [note, `등락률 상위 ${value.items.length}종목만 보여 줍니다${total > value.items.length ? ` (전체 ${total}종목)` : ""}`].filter(Boolean).join(" · ");
    }
    return {
      market,
      kind: k,
      theme,
      description: value.description,
      items: value.items,
      marketOpen: open,
      session: ss.session,
      asOf: market === "KR" ? this.krAsOf(ss, dataAt) : this.usAsOf(ss, dataAt),
      fxRate: await this.fx(market),
      source: "네이버 증권",
      basis: naverBasis(market, k),
      note,
    };
  }

  /**
   * 종목 값을 저장본으로 덮은 미국 업종의 요약(등락률·상승/보합/하락 수). 출처 요약은 비운 때 값이라 덮은 종목과 시점이 다르다:
   *  1) 저장본이 마지막 정규장 마감 뒤 값이면, 같은 마감 뒤에 받은 업종 목록(지금 목록 또는 목록 저장본)의 요약 — 잘린 업종도 전체 종목 수
   *  2) 없으면 구성 종목을 다 받았고(잘리지 않음) 비워진 종목을 모두 덮었을 때만 보이는 종목 값으로 다시 센다 (시가총액 가중, 모든 종목에 시가총액이 있을 때)
   *  3) 그 밖에는 확인하지 못한 요약: 상승·보합·하락 수는 세지 않고(0) 그렇다고 밝힌다 — 잘린 업종을 보이는 종목만으로 평균 내지 않는다
   */
  private async restoredSummary(
    ss: Session,
    detail: SectorDetail,
    restored: { savedAt: number; all: boolean },
    listed: ThemeSummary | null,
    truncated: boolean,
  ): Promise<{ theme: ThemeSummary; counted: ThemeSummary | null; note: string | null }> {
    const base = detail.theme;
    const close = this.usCloseAt(ss);
    if (restored.savedAt >= close) {
      const same = await this.closeListed(base.id, close, listed);
      if (same) return { theme: { ...base, changeRate: same.changeRate, up: same.up, flat: same.flat, down: same.down }, counted: same, note: null };
    }
    const live = detail.items.filter((i) => !i.suspended);
    if (!truncated && restored.all && live.length && live.every((i) => (i.marketCap ?? 0) > 0)) return { theme: summarize(base, live, true), counted: null, note: "업종 등락률·상승/하락 수는 이 종목 값으로 다시 셌습니다" };
    return { theme: { ...base, up: 0, flat: 0, down: 0, unverified: true }, counted: null, note: "업종 등락률·상승/하락 수는 종목 값과 같은 때 값을 확인하지 못했습니다" };
  }

  /**
   * 마지막 미국 정규장 마감(close) 뒤, 출처가 비우기 전에 받은 업종 목록의 이 업종 요약: 지금 목록(마감 뒤에 받은 것만 온다 — listIsCurrent),
   * 없으면 마감 뒤에 남긴 목록 저장본. 상승·보합·하락 수가 없으면 null
   */
  private async closeListed(id: string, close: number, listed: ThemeSummary | null): Promise<ThemeSummary | null> {
    const snap = listed ? null : await this.loadSnap<ThemeSummary[]>("themes:US:sector:day");
    const same = listed ?? (snap && snap.savedAt >= close ? (snap.value.find((t) => t.id === id) ?? null) : null);
    return same && same.up + same.flat + same.down > 0 ? same : null;
  }

  /**
   * 오늘 목록(출처 값)에서 이 테마·업종의 상승·보합·하락 수. 지금 세션의 목록일 때만 쓴다:
   * 장중·시간외면 장중·시간외에 받은 지 LISTED_MAX_AGE_MS 안의 목록(개장 직전에 받은 어제 목록은 안 됨),
   * 장이 닫혔으면 마지막 마감 뒤에 받은 목록. 저장본(출처 초기화)이나 0% 목록이면 null.
   * 받아 둔 목록이 이 조건에 맞으면 바로 쓰고(새 조회는 뒤에서), 아니면 새 목록을 waitMs 까지만 기다린다
   */
  private async listedTheme(market: DiscoverMarket, kind: ThemeKind, id: string, ss: Session, waitMs: number): Promise<ThemeSummary | null> {
    const pick = (): ThemeSummary | null | undefined => {
      const hit = this.cache.get(`themes:${market}:${kind}:day`) as Cached<ThemeListValue> | undefined;
      if (!hit || hit.value.fromSnap || hit.value.zero || !this.listIsCurrent(hit, ss)) return undefined;
      return hit.value.themes.find((t) => t.id === id) ?? null;
    };
    const load = this.naverThemes(market, kind, "day", ss);
    load.catch(() => undefined);
    const ready = pick();
    if (ready !== undefined) return ready;
    await within(load, waitMs, null);
    return pick() ?? null;
  }

  private listIsCurrent(hit: Cached<ThemeListValue>, ss: Session): boolean {
    const t = this.now.getTime();
    if (ss.session === "regular" || ss.session === "extended") return hit.value.live && t - hit.at <= LISTED_MAX_AGE_MS;
    const since = ss.lastClose ? Date.parse(ss.lastClose) : NaN;
    return Number.isNaN(since) ? t - hit.at <= LISTED_MAX_AGE_MS : hit.at >= since;
  }

  /** 업종 목록의 코드. 받아 둔 것이 없으면(재시작 직후) 받아 본다. 못 받으면 null */
  private async sectorIds(market: DiscoverMarket, ss: Session): Promise<Set<string> | null> {
    for (const period of ["day", "week", "month"] as const) {
      const hit = this.cache.get(`themes:${market}:sector:${period}`) as Cached<ThemeListValue> | undefined; // naverThemes 캐시
      if (hit) return new Set(hit.value.themes.map((t) => t.id));
    }
    try {
      return new Set((await this.naverThemes(market, "sector", "day", ss)).themes.map((t) => t.id));
    } catch {
      return null;
    }
  }

  private async usTheme(ss: Session, id: string): Promise<ThemeDetail | null> {
    const usThemes = this.deps.usThemes!;
    const open = ss.open;
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
      description: await within(usThemes.summary(id), SUMMARY_WAIT_MS, null),
      items: r.items,
      marketOpen: open,
      session: ss.session,
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
/** 한국 거래일 기억: day = 거래일, close = 그날 마감, exact = 출처가 준 실제 마감(아니면 20:00 추정), nextOpen = 그때 알려 준 다음 개장 */
type KrTrade = { day: string; close: string; exact: boolean; nextOpen?: string | null };

/** 두 날짜(YYYY-MM-DD) 사이(양 끝 제외)에 평일이 있는지 */
function weekdayBetween(a: string, b: string): boolean {
  for (let d = Date.parse(`${a}T12:00:00Z`) + 86_400_000; d < Date.parse(`${b}T12:00:00Z`); d += 86_400_000) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) return true;
  }
  return false;
}

/** 테마 목록 캐시 값. dataAt = 값의 시각(마감 뒤에 받았으면 마지막 거래 마감, 저장본이면 그 시각), fromSnap = 출처 초기화로 저장본, zero = 저장본도 없어 0% 목록 그대로 */
/** live: 장중·시간외에 받은 값인지 (개장 직전에 받은 어제 값과 가르려고) */
type ThemeListValue = { themes: ThemeSummary[]; dataAt: number; fromSnap: boolean; zero: boolean; live: boolean };

/** 네이버 테마·업종 등락률 산출 방식 (실측: 한국 테마 = 단순 평균, 업종 = 시가총액 가중) */
function naverBasis(market: DiscoverMarket, kind: ThemeKind): string {
  if (market === "US") return "산업 분류(TRBC)별 구성 종목 시가총액 가중 평균";
  return kind === "theme" ? "구성 종목 등락률 단순 평균(거래정지 제외)" : "구성 종목 시가총액 가중 평균";
}

/**
 * 네이버 장 상태에서 지금 유효한 세션. 마감 세션의 closeAt 은 휴장일과 상관없이 다음 달력 날 아침이라,
 * 다음 개장(next.openAt) 전이거나 오늘이 휴장일이면 여전히 마감으로 본다. 그 밖에 세션 끝이 지났으면 옛 값(null).
 */
export function currentSession(st: ExchangeStatus, t: number, fetchedAt?: number): ExchangeSession | null {
  const l = st.latest;
  const end = l.closeAt ? Date.parse(l.closeAt) : NaN;
  // 끝 시각을 모르면 받은 뒤 5분까지만 믿는다
  if (Number.isNaN(end)) return fetchedAt !== undefined && t - fetchedAt < 5 * 60_000 ? l : null;
  if (t < end) return l;
  if (l.kind !== "closed") return null;
  const nextOpen = st.next?.openAt ? Date.parse(st.next.openAt) : NaN;
  if (!Number.isNaN(nextOpen)) return t < nextOpen ? l : null;
  return st.isTradingDay === false ? l : null;
}

/** p 를 ms 까지만 기다린다 (넘으면 null). 타이머는 끝나면 지운다 */
async function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((res) => (timer = setTimeout(() => res(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** 문자열 지문 (FNV-1a 32비트 + 길이) — 저장본이 바뀌었는지만 본다 */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

/** 서울 시각의 하루 중 분 */
function seoulMinutes(d: Date): number {
  const iso = seoulIso(d);
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

/** 뉴욕 날짜(YYYY-MM-DD)와 하루 중 분 */
function nyParts(d: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** 뉴욕 날짜(YYYY-MM-DD)의 정규장 마감(16:00 ET) 시각 (서머타임 여부를 맞춰 본다) */
function nyCloseOf(date: string): number {
  for (const off of ["-04:00", "-05:00"]) {
    const t = Date.parse(`${date}T16:00:00${off}`);
    const p = nyParts(new Date(t));
    if (p.date === date && p.minutes === 16 * 60) return t;
  }
  return Date.parse(`${date}T16:00:00-05:00`);
}

/** 날짜(YYYY-MM-DD) 직전 평일 */
function prevWeekday(date: string): string {
  let d = new Date(`${date}T12:00:00Z`);
  do d = new Date(d.getTime() - 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * 가장 최근 미국 정규장 날짜(뉴욕 YYYY-MM-DD). 달력이 준 마지막 세션 종료(lastClose)가 있으면 그 날(휴장일을 건너뛴 실제 값),
 * 없으면(프리마켓 중 등) 오늘 09:30 이 지난 평일이면 오늘, 아니면 직전 평일 (휴장일은 모르는 근사)
 */
export function lastUsRegularDay(now: Date, lastClose: string | null): string {
  if (lastClose && !Number.isNaN(Date.parse(lastClose))) {
    const c = nyParts(new Date(lastClose));
    return c.minutes >= 9 * 60 + 30 ? c.date : prevWeekday(c.date);
  }
  const n = nyParts(now);
  const wd = new Date(`${n.date}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && n.minutes >= 9 * 60 + 30 ? n.date : prevWeekday(n.date);
}

/** 서울 평일 09:00~15:30 (KRX 정규장, 휴장일은 달력이 거른다) */
export function isKrxRegularHours(d: Date): boolean {
  const iso = seoulIso(d);
  const wd = new Date(`${iso.slice(0, 10)}T12:00:00+09:00`).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const m = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  return m >= 9 * 60 && m < 15 * 60 + 30;
}

/**
 * 직전 한국 거래 마감(서울 20:00, NXT 애프터마켓 끝) 근사 — 달력이 마지막 세션을 알려 주지 않을 때만 쓴다.
 * 오늘이 평일이고 20:00 이 지났으면 오늘, 아니면 직전 평일 (휴장일은 모른다)
 */
export function lastKrClose(now: Date): string {
  const iso = seoulIso(now);
  let day = iso.slice(0, 10);
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (!(wd !== 0 && wd !== 6 && seoulMinutes(now) >= 20 * 60)) day = prevWeekday(day);
  return `${day}T20:00:00+09:00`;
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
 * 구성 종목에서 상장 첫날 종목과 거래정지 종목을 빼고 등락률·상승/보합/하락 수를 다시 센다.
 * weighted 면 전일 시가총액 가중 평균(업종), 아니면 단순 평균(테마) — 네이버와 같은 방식.
 */
export function recount(th: ThemeSummary, items: DiscoverStock[], fresh: Set<string>, weighted = false): ThemeSummary {
  const live = items.filter((i) => !fresh.has(i.code) && !i.suspended);
  if (!live.length) return th;
  return { ...summarize(th, live, weighted), adjusted: true };
}

/** 종목 값으로 등락률(weighted 면 시가총액 가중, 아니면 단순 평균)·상승/보합/하락 수·대표 종목을 센다 (live 는 비어 있지 않다) */
function summarize(th: ThemeSummary, live: DiscoverStock[], weighted: boolean): ThemeSummary {
  let avg = live.reduce((s, i) => s + i.changeRate, 0) / live.length;
  if (weighted) {
    let w = 0;
    let wr = 0;
    // 네이버 업종 등락률과 같은 현재 시가총액 가중 (실측: 77개 업종 중 74개가 소수 둘째 자리까지 일치)
    for (const i of live) {
      if (!i.marketCap || i.marketCap <= 0) continue;
      w += i.marketCap;
      wr += i.marketCap * i.changeRate;
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
  };
}
