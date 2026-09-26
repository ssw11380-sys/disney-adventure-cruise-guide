import type { Db } from "../db/index.js";
import { isKrCode } from "../lib/codes.js";
import { isTimeoutError, NotFoundError } from "../lib/errors.js";
import { fetchWithTimeout } from "../lib/timedFetch.js";
import { seoulIso } from "../lib/time.js";
import type { MarketIndex } from "../providers/market/indices.js";
import type { ExchangeStatus, KrQuote } from "../providers/market/naverDiscover.js";
import type { FetchFn } from "../providers/market/types.js";
import type { NewsItem } from "../providers/news/types.js";
import type { DigestMarket } from "../notifications/digest.js";
import { reutersCandidates } from "../providers/market/tossTics.js";
import { briefingMarketDate } from "./briefingService.js";
import { eventsCoverage, nextOpenEvent, upcomingEvents, type OfficialKind } from "./marketEvents.js";
import {
  compareHoldings,
  digestLine,
  krSectors,
  marketOf,
  naverYield,
  NEWS_MAX,
  NEWS_QUERY,
  newsDays,
  newsWindow,
  parseTreasuryCsv,
  phaseOf,
  pickFx,
  pickIndices,
  pickNews,
  resolveDates,
  sessionClose,
  SUMMARY_WAIT_MS,
  summaryLines,
  treasuryYield,
  US_EXCHANGE_CODE,
  US_SECTOR_ETFS,
  usSectors,
  type HoldingInput,
  type MarketSummaryData,
  type QuoteInput,
  type SummaryMarket,
  type SummarySession,
  type SummaryYield,
} from "./marketSummaryCalc.js";

/** 저장한 시장 요약 한 건 (목록·상세 같은 모양 — data 가 크지 않아 목록에도 넣는다) */
export interface MarketSummary {
  id: number;
  date: string;
  session: SummarySession;
  market: SummaryMarket;
  status: "ok" | "failed";
  /** 만든 때의 요약 줄 (코드로 만든 문장). 화면은 data 로 볼 때 날짜에 맞춰 다시 그린다 */
  summary: string;
  createdAt: string;
  data: MarketSummaryData | null;
}

/** 미국 종목 시세 (NaverDiscover.usQuotes 의 필요한 칸) */
export interface UsQuoteLite {
  changeRate: number;
  tradedAt: string | null;
  name?: string;
  /** 네이버 거래소 이름 (NASDAQ · NYSE · AMEX) */
  market?: string;
  /** 앱 티커 */
  code?: string;
}

/** 요약이 쓰는 출처 (테스트는 가짜를 넣는다 — 네트워크 없음) */
export interface MarketSummarySources {
  /** 지수 띠와 같은 목록 (MarketIndices, 30초 캐시·stale 규칙) */
  indices(): Promise<MarketIndex[]>;
  /** 원/달러 일별 고시 (날짜만 쓴다) */
  fxDaily(): Promise<Array<{ date: string }>>;
  /** 네이버 거래소 장 상태 (today·latest.tradeBaseAt) */
  exchangeStatus(): Promise<Partial<Record<"KR" | "US", ExchangeStatus>>>;
  /** 토스 달력의 그 날짜 거래일 여부 */
  isTradingDate(market: "KR" | "US", date: string): Promise<boolean>;
  /** 미 재무부 Daily Treasury Par Yield Curve CSV (그해) */
  treasuryCsv(year: number): Promise<string>;
  /** 네이버 US10YT=RR (재무부 값이 없을 때만) */
  naverBond(): Promise<unknown>;
  /** 미국 정규장 종가 (로이터 코드 → 시세). 모르는 코드는 빠진다 */
  usQuotes(reuters: string[]): Promise<ReadonlyMap<string, UsQuoteLite>>;
  /** 한국 KRX 정규장 종가 */
  krQuotes(codes: string[]): Promise<ReadonlyMap<string, KrQuote>>;
  /** 네이버 한국 업종 (발견 탭과 같은 값: 시가총액 가중·상장 첫날 보정) */
  krSectors(): Promise<KrSectorList>;
  /** 뉴스 제목 검색 (구글 뉴스 RSS) */
  news(query: string): Promise<NewsItem[]>;
  /** 등록 종목 (수량·상장 시장·종목 마스터 분류) */
  holdings(): Promise<Array<HoldingInput & { quantity: number | null }>>;
}

export interface MarketSummaryDeps {
  db: Db;
  sources: MarketSummarySources;
  features: { enabled(key: "marketSummary"): Promise<boolean> };
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
  /** 출처 하나를 기다리는 최대 시간 (기본 8초) */
  sourceTimeoutMs?: number;
}

const SOURCE_WAIT_MS = 8_000;

/** p 를 ms 안에 끝내지 못하면 실패 (까닭을 남기려고 within 과 달리 오류로) */
function timed<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}: ${ms / 1000}초 안에 답이 없음`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };
async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 시장 전체 요약 (플래그 marketSummary, AI 문장 없음 · 모델 호출 0).
 * 세션(오전·오후) 종목 브리핑 실행이 끝나면 계좌 브리핑과 함께 만든다: 아침은 방금 끝난 미국 장, 오후는 오늘 한국 장.
 *  - 숫자는 모두 이름 붙은 출처에서 코드로 계산한다 (marketSummaryCalc). 뉴스는 언론사 제목 원문 그대로 + 언론사·시각·링크
 *  - 날짜·세션마다 1건 (다시 만들면 덮어쓴다). 이미 있으면 강제(수동 전체 실행) 때만 다시 만든다
 *  - 세션 알림은 기다리되 SUMMARY_WAIT_MS(20초) 를 넘으면 요약 줄 없이 보낸다 — 요약은 뒤에서 마저 만들어 저장한다(카드에 보인다)
 *  - 플래그를 끄면 아무것도 하지 않는다 (재무부·섹터 ETF·뉴스 요청 0, 조회도 0)
 */
export class MarketSummaryService {
  private running = 0;
  private inflight = new Map<string, Promise<MarketSummary | null>>();
  private readonly now: () => Date;
  private warnedUnknown = "";

  constructor(private readonly deps: MarketSummaryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get isRunning(): boolean {
    return this.running > 0;
  }

  enabled(): Promise<boolean> {
    return this.deps.features.enabled("marketSummary").catch(() => false);
  }

  /**
   * 종목 브리핑 실행이 끝났을 때 (BriefingService.onRunDone). 일부 종목 실행은 건너뛴다.
   * waitMs 안에 끝나면 저장한 요약(성공만)을, 늦으면 null 을 돌려준다 (알림은 첫 줄 없이) — 만드는 일은 계속된다.
   * 두 시장이 모두 쉬어 종목 브리핑이 모두 건너뛴 날도 만든다(카드에 보인다) — 새 알림은 만들지 않는다(알림은 부르는 쪽 규칙 그대로)
   */
  async afterRun(done: { session: SummarySession; date: string; partial: boolean; force?: boolean }, opts: { waitMs?: number } = {}): Promise<MarketSummary | null> {
    if (done.partial) return null;
    if (!(await this.enabled())) return null;
    const p = this.generate(done.session, { date: done.date, force: done.force === true }).catch((e: unknown) => {
      this.deps.log?.warn({ session: done.session, err: (e as Error).message }, "시장 요약 생성 오류");
      return null;
    });
    const wait = opts.waitMs ?? SUMMARY_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((res) => {
      timer = setTimeout(() => res("late"), wait);
    });
    const r = await Promise.race([p, late]).finally(() => clearTimeout(timer));
    if (r === "late") {
      this.deps.log?.warn({ session: done.session, waitMs: wait }, "시장 요약이 늦어 세션 알림을 첫 줄 없이 보냄 (요약은 이어서 만든다)");
      return null;
    }
    return r?.status === "ok" ? r : null;
  }

  /**
   * 한 건 만들기. 이미 성공한 건이 있고 force 가 아니면 그것을 돌려준다(새로 부르지 않음). 같은 날짜·세션을 겹쳐 부르면 하나를 같이 기다린다.
   * 지수를 하나도 받지 못하면 실패로 저장한다 (카드에 '생성 실패', 다음 실행에서 다시 만든다)
   */
  async generate(session: SummarySession, opts: { date: string; force?: boolean }): Promise<MarketSummary | null> {
    if (!(await this.enabled())) return null;
    const key = `${opts.date}|${session}`;
    const cur = this.inflight.get(key);
    if (cur) return cur;
    const p = (async () => {
      if (!opts.force) {
        const existing = await this.find(opts.date, session);
        if (existing?.status === "ok" && !this.outdated(existing)) return existing;
      }
      this.running++;
      try {
        return await this.build(session, opts.date);
      } finally {
        this.running--;
      }
    })();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * 장중·최종값 전에 만든 요약인데 지금은 확정된 뒤인지 (수동 실행을 브리핑 시각보다 먼저 돌린 경우 등) —
   * 그러면 예약 실행이 '이미 있음'으로 건너뛰지 않고 확정 값으로 다시 만든다
   */
  private outdated(s: MarketSummary): boolean {
    const d = s.data;
    return !!d && d.phase !== "final" && phaseOf(d.market, d.basisDate, this.now()) === "final";
  }

  private src<T>(p: () => Promise<T>, label: string): Promise<Settled<T>> {
    return settle(timed(Promise.resolve().then(p), this.deps.sourceTimeoutMs ?? SOURCE_WAIT_MS, label));
  }

  private async build(session: SummarySession, date: string): Promise<MarketSummary> {
    const s = this.deps.sources;
    const now = this.now();
    const market = marketOf(session);
    const notes: string[] = [];
    const candidate = market === "US" ? briefingMarketDate("US", "morning", date) : date;
    // 1) 날짜·휴장 판단에 필요한 것과 지수·보유 종목을 함께
    const [ex, cal, idx, held] = await Promise.all([
      this.src(() => s.exchangeStatus(), "네이버 장 상태"),
      this.src(() => s.isTradingDate(market, candidate), "토스 달력"),
      this.src(() => s.indices(), "지수"),
      this.src(() => s.holdings(), "보유 종목"),
    ]);
    const kr = ex.ok ? ex.value.KR : undefined;
    const dates = resolveDates({
      session,
      date,
      kr: kr ? { todayDate: kr.today?.date ?? null, isTradingDay: kr.isTradingDay, isWeekdayHoliday: kr.today?.isWeekdayHoliday ?? null, holidayDescription: kr.today?.holidayDescription ?? null, latestTradeBaseAt: kr.latest.tradeBaseAt } : null,
      calendarTrading: cal.ok ? cal.value : null,
    });
    for (const c of dates.conflicts) this.deps.log?.warn({ session, date }, `휴장 판단이 출처마다 다름: ${c}`);
    const { basisDate } = dates;
    const close = sessionClose(market, basisDate);
    const indices = pickIndices(idx.ok ? idx.value : [], market, basisDate);
    if (!idx.ok) notes.push(`지수를 받지 못함 (${idx.error})`);
    for (const i of indices) if (i.missing) notes.push(`${i.name}: ${i.missing}`);
    const holdings = (held.ok ? held.value : []).filter((h) => (h.quantity ?? 0) > 0 && (market === "KR" ? isKrCode(h.code) : !isKrCode(h.code)));
    if (!held.ok) notes.push(`보유 종목을 읽지 못함 (${held.error})`);

    // 2) 값의 날짜를 알았으니 환율 고시일·금리·업종·종목 시세·뉴스를 함께
    const usCands = new Map<string, string[]>();
    if (market === "US") for (const h of holdings) usCands.set(h.code, reutersCandidates(h.code, US_EXCHANGE_CODE[h.market] ?? h.market));
    const window = newsWindow(market, basisDate, now);
    const [fxDaily, yieldR, usQ, krQ, krSec, news] = await Promise.all([
      this.src(() => s.fxDaily(), "원/달러 일별"),
      market === "US" ? this.yieldFor(basisDate) : Promise.resolve({ ok: true as const, value: null }),
      market === "US" ? this.src(() => s.usQuotes([...US_SECTOR_ETFS.map((e) => e.reuters), ...[...usCands.values()].flat()]), "미국 시세") : Promise.resolve(null),
      market === "KR" && holdings.length ? this.src(() => s.krQuotes(holdings.map((h) => h.code)), "한국 시세") : Promise.resolve(null),
      market === "KR" ? this.src(() => s.krSectors(), "한국 업종") : Promise.resolve(null),
      this.newsFor(market, basisDate, window),
    ]);

    const fxRow = (idx.ok ? idx.value : []).find((i) => i.code === "USDKRW");
    const fx = pickFx(fxRow, fxDaily.ok ? fxDaily.value : null, date);
    if (!fx) notes.push("원/달러를 받지 못함");
    else if (!fxDaily.ok) notes.push("원/달러 고시 날짜를 확인하지 못함");
    const yield10y: SummaryYield | null = yieldR.ok ? yieldR.value : null;
    if (market === "US" && !yield10y) notes.push(`미 10년물을 받지 못함${yieldR.ok ? "" : ` (${yieldR.error})`}`);

    let sectors: MarketSummaryData["sectors"] = null;
    const quotes = new Map<string, QuoteInput>();
    if (market === "US") {
      const q = usQ && usQ.ok ? usQ.value : new Map<string, UsQuoteLite>();
      if (usQ && !usQ.ok) notes.push(`미국 시세를 받지 못함 (${usQ.error})`);
      const sec = usSectors(q, basisDate);
      if ("reason" in sec) notes.push(sec.reason);
      else sectors = sec;
      for (const [code, cands] of usCands) {
        const hit = cands.map((c) => q.get(c)).find((x) => x);
        if (hit) quotes.set(code, { changeRate: hit.changeRate, tradedAt: hit.tradedAt, ...(hit.name ? { name: hit.name } : {}), ...(hit.market ? { exchange: hit.market } : {}) });
      }
    } else {
      if (krQ && !krQ.ok) notes.push(`한국 시세를 받지 못함 (${krQ.error})`);
      for (const [code, q] of krQ && krQ.ok ? krQ.value : []) quotes.set(code, { changeRate: q.changeRate, tradedAt: q.tradedAt, name: q.name, exchange: q.exchange });
      // 업종 목록에는 날짜 칸이 없어 네이버 장 상태의 직전·현재 거래일로 확인한다 (확인하지 못하면 줄을 뺀다)
      const tradeBase = kr?.latest.tradeBaseAt ?? null;
      if (!krSec || !krSec.ok) notes.push(`한국 업종을 받지 못함${krSec && !krSec.ok ? ` (${krSec.error})` : ""}`);
      else if (tradeBase !== basisDate) notes.push(`한국 업종 날짜를 확인하지 못해 업종 줄을 뺌 (네이버 거래일 ${tradeBase ?? "모름"})`);
      else if (krSectorsStale(krSec.value, basisDate)) notes.push(`한국 업종: ${krSec.value.note ?? "저장해 둔 값"} — 기준 거래일(${basisDate}) 값인지 확인하지 못해 업종 줄을 뺌`);
      else {
        const sec = krSectors(krSec.value.themes, basisDate);
        if ("reason" in sec) notes.push(sec.reason);
        else sectors = sec;
      }
    }
    const holdCmp = compareHoldings({ market, basisDate, holdings, quotes, indices });
    if (!holdCmp) notes.push(`${market === "US" ? "미국" : "국내"} 보유 종목이 없어 내 종목 줄을 뺌`);
    else if (holdCmp.compared === 0) notes.push("지수 또는 종목 시세를 받지 못해 내 종목을 비교하지 못함");

    const ev = upcomingEvents(now);
    const within = [...ev.within];
    // 오늘 한국 휴장(오후 요약)이면 다음 개장을 맨 앞에 (시각까지)
    if (market === "KR" && dates.holiday) {
      const open = nextOpenEvent(date);
      if (!within.some((e) => e.kind === "kr-open" && e.date === open.date)) within.unshift(open);
      else within.splice(within.findIndex((e) => e.kind === "kr-open" && e.date === open.date), 1, open);
    }
    this.warnUnknownEvents(ev.unknown, date);

    const data: MarketSummaryData = {
      version: 1,
      session,
      market,
      date,
      marketDate: dates.marketDate,
      basisDate,
      asOf: seoulIso(now),
      holiday: dates.holiday,
      weekendGap: dates.weekendGap,
      earlyClose: close.early,
      closeTime: close.time,
      phase: phaseOf(market, basisDate, now),
      indices,
      fx,
      yield10y,
      sectors,
      holdings: holdCmp,
      events: { within, next: ev.next, unknown: ev.unknown },
      news: { query: news.query, from: window.from, to: window.to, items: news.items, fresh: !dates.holiday && basisDate === dates.marketDate },
      notes: [...notes, ...news.notes],
    };
    const ok = indices.some((i) => i.changeRate !== null);
    const summary = ok ? summaryLines(data, now).map((l) => l.text).join("\n") : "지수를 받지 못해 시장 요약을 만들지 못했습니다";
    return this.save(data, ok ? "ok" : "failed", summary);
  }

  /** 미 10년물: 재무부 CSV(기준 거래일 행, 1월 초는 전년 파일도) → 없으면 네이버(로이터) → 둘 다 없으면 null */
  private async yieldFor(basisDate: string): Promise<Settled<SummaryYield | null>> {
    const s = this.deps.sources;
    const year = Number(basisDate.slice(0, 4));
    const cur = await this.src(() => s.treasuryCsv(year), "미 재무부 금리");
    if (cur.ok) {
      const rows = parseTreasuryCsv(cur.value);
      const hasPrev = rows.some((r) => r.date < basisDate);
      let prevYear: Array<{ date: string; value: number }> = [];
      if (rows.some((r) => r.date === basisDate) && !hasPrev) {
        const prev = await this.src(() => s.treasuryCsv(year - 1), "미 재무부 금리(전년)");
        if (prev.ok) prevYear = parseTreasuryCsv(prev.value);
      }
      const t = treasuryYield(rows, basisDate, prevYear);
      if (t) return { ok: true, value: t };
    }
    const nv = await this.src(() => s.naverBond(), "네이버 미 10년물");
    if (nv.ok) {
      const y = naverYield(nv.value, basisDate);
      if (y) return { ok: true, value: y };
    }
    return { ok: false, error: `${cur.ok ? "재무부 값에 그날이 없음" : cur.error}${nv.ok ? "" : ` · ${nv.error}`}` };
  }

  /** 뉴스: 질의 순서대로 모아 고른다 (앞 질의로 3건이 차면 다음 질의는 부르지 않는다) */
  private async newsFor(market: SummaryMarket, basisDate: string, window: { from: string; to: string }): Promise<{ query: string; items: MarketSummaryData["news"]["items"]; notes: string[] }> {
    const queries = NEWS_QUERY[market];
    const notes: string[] = [];
    const got: NewsItem[] = [];
    let items: MarketSummaryData["news"]["items"] = [];
    const used: string[] = [];
    for (const q of queries) {
      const r = await this.src(() => this.deps.sources.news(q), `뉴스(${q})`);
      used.push(q);
      if (!r.ok) {
        notes.push(`뉴스(${q})를 받지 못함 (${r.error})`);
        continue;
      }
      got.push(...r.value);
      items = pickNews(got, { ...window, days: newsDays(market, basisDate) });
      if (items.length >= NEWS_MAX) break;
    }
    return { query: used.join(" · "), items, notes };
  }

  /** 일정 목록이 끝난 종류가 있으면 하루 한 번 경고 (틀린 일정보다 없는 일정 — 줄은 만들지 않는다) */
  private warnUnknownEvents(unknown: OfficialKind[], date: string): void {
    if (!unknown.length || this.warnedUnknown === date) return;
    this.warnedUnknown = date;
    this.deps.log?.warn({ unknown, coverage: eventsCoverage() }, "일정 목록이 끝난 종류가 있어 그 일정은 빼고 요약함 — marketEvents.ts 에 새 일정을 넣어 주세요");
  }

  private async save(data: MarketSummaryData, status: "ok" | "failed", summary: string): Promise<MarketSummary> {
    const values = { summary_date: data.date, session: data.session, market: data.market, status, summary, data: JSON.stringify(data), created_at: seoulIso(this.now()) };
    await this.deps.db
      .insertInto("market_summaries")
      .values(values)
      .onConflict((oc) => oc.columns(["summary_date", "session"]).doUpdateSet(values))
      .execute();
    this.deps.log?.info({ date: data.date, session: data.session, status, notes: data.notes.length }, "시장 요약 저장");
    return (await this.find(data.date, data.session))!;
  }

  // ── 조회 (플래그를 끄면 0건) ─────────────────────────────────────

  async find(date: string, session: SummarySession): Promise<MarketSummary | null> {
    const r = await this.deps.db.selectFrom("market_summaries").selectAll().where("summary_date", "=", date).where("session", "=", session).executeTakeFirst();
    return r ? toSummary(r) : null;
  }

  /** 최신 순 (날짜 내림차순, 같은 날은 오후 먼저). 플래그가 꺼져 있으면 빈 목록 */
  async list(limit = 4): Promise<MarketSummary[]> {
    if (!(await this.enabled())) return [];
    const rows = await this.deps.db
      .selectFrom("market_summaries")
      .selectAll()
      .orderBy("summary_date", "desc")
      .orderBy("session", "asc") // 'afternoon' < 'morning'
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toSummary);
  }

  async get(id: number): Promise<MarketSummary> {
    if (!(await this.enabled())) throw new NotFoundError("시장 요약이 꺼져 있습니다");
    const r = await this.deps.db.selectFrom("market_summaries").selectAll().where("id", "=", id).executeTakeFirst();
    if (!r) throw new NotFoundError(`시장 요약 ${id} 이 없습니다`);
    return toSummary(r);
  }

  /** /health 에 보이는 일정 목록 범위 (종류별 마지막 날짜) */
  eventsCoverage(): Record<OfficialKind, string | null> {
    return eventsCoverage();
  }
}

/** 한국 업종 목록 (발견 탭 계산 결과). asOf 는 값의 기준 시각(서울 ISO) — 출처가 값을 비워 저장본을 줄 때 그 저장본의 날짜를 보려고 */
export interface KrSectorList {
  themes: Array<{ id: string; name: string; changeRate: number; up: number; flat: number; down: number }>;
  note: string | null;
  asOf?: string | null;
}

/**
 * 한국 업종 값을 쓰면 안 되는지.
 *  - 출처가 등락률을 0으로 비운 값('0으로 비웠습니다') → 쓰지 않는다
 *  - 출처가 값을 비워 저장해 둔 직전 값('값을 비워 저장해 둔 직전 값') → 그 저장본이 기준 거래일 값일 때만 쓴다 (전날 저장본이 오늘 업종처럼 보이지 않게)
 */
export function krSectorsStale(l: Pick<KrSectorList, "note" | "asOf">, basisDate: string): boolean {
  const note = l.note ?? "";
  if (/0으로|비웠/.test(note)) return true;
  if (/비워|저장해 둔/.test(note)) return (l.asOf ?? "").slice(0, 10) !== basisDate;
  return false;
}

/** 세션 알림 첫 줄 (보내는 순간 at 의 문구). 성공한 요약이고 지수가 있을 때만 */
export function digestMarket(s: MarketSummary | null | undefined, at: Date): DigestMarket | null {
  if (!s || s.status !== "ok" || !s.data) return null;
  const line = digestLine(s.data, at);
  return line ? { id: s.id, line, market: s.market, holiday: s.data.holiday !== null } : null;
}

function toSummary(r: { id: number; summary_date: string; session: string; market: string; status: string; summary: string; data: string; created_at: string }): MarketSummary {
  let data: MarketSummaryData | null = null;
  try {
    data = JSON.parse(r.data) as MarketSummaryData;
  } catch {
    data = null;
  }
  return {
    id: r.id,
    date: r.summary_date,
    session: r.session === "afternoon" ? "afternoon" : "morning",
    market: r.market === "KR" ? "KR" : "US",
    status: r.status === "ok" ? "ok" : "failed",
    summary: r.summary,
    createdAt: r.created_at,
    data,
  };
}

// ── 실제 출처 (app.ts 가 조립한다) ─────────────────────────────

const TREASURY_URL = (y: number) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
const NAVER_BOND_URL = "https://api.stock.naver.com/marketindex/bond/US10YT=RR";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";
const NEWS_CACHE_MS = 10 * 60_000;

/**
 * 실제 출처 묶음. 새로 부르는 곳은 재무부 CSV·네이버 미 10년물(대체)·섹터 ETF 시세·종목 시세·구글 뉴스뿐이고,
 * 지수·환율은 지수 띠와 같은 인스턴스(30초 캐시), 한국 업종은 발견 탭과 같은 계산(DiscoverService)을 쓴다.
 * 구글 뉴스는 연달아 부르면 503 을 내므로 질의마다 10분 캐시 + 1.5초 뒤 한 번 다시 (시간 초과는 다시 부르지 않는다)
 */
export function defaultSummarySources(d: {
  db: Db;
  indices: { list(opts: { stale?: boolean }): Promise<MarketIndex[]>; candles(code: string, period: "D", count: number): Promise<{ candles: Array<{ date: string }> } | null> };
  naver: { marketStatus(): ReturnType<MarketSummarySources["exchangeStatus"]>; usQuotes(r: string[]): Promise<ReadonlyMap<string, { changeRate: number; tradedAt: string | null; name: string; market: string; code: string }>>; krQuotes(c: string[]): Promise<ReadonlyMap<string, KrQuote>> };
  calendar: { isTradingDate(market: "KR" | "US", date: string): Promise<boolean> };
  krSectors: () => Promise<KrSectorList>;
  news: { search(query: string, limit: number): Promise<NewsItem[]> };
  fetchFn?: FetchFn;
  now?: () => number;
  retryDelayMs?: number;
}): MarketSummarySources {
  const fetchFn = d.fetchFn ?? fetch;
  const now = d.now ?? (() => Date.now());
  const newsCache = new Map<string, { at: number; items: NewsItem[] }>();
  return {
    indices: () => d.indices.list({ stale: true }),
    fxDaily: async () => (await d.indices.candles("USDKRW", "D", 10))?.candles ?? [],
    exchangeStatus: () => d.naver.marketStatus(),
    isTradingDate: (m, date) => d.calendar.isTradingDate(m, date),
    treasuryCsv: async (y) => {
      const res = await fetchWithTimeout(fetchFn, TREASURY_URL(y), { headers: { "user-agent": UA, accept: "text/csv" } }, SOURCE_WAIT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} (미 재무부)`);
      return res.text();
    },
    naverBond: async () => {
      const res = await fetchWithTimeout(fetchFn, NAVER_BOND_URL, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } }, SOURCE_WAIT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} (네이버 미 10년물)`);
      return res.json();
    },
    usQuotes: async (r) => d.naver.usQuotes(r),
    krQuotes: (c) => d.naver.krQuotes(c),
    krSectors: () => d.krSectors(),
    news: async (q) => {
      const t = now();
      const hit = newsCache.get(q);
      if (hit && t - hit.at < NEWS_CACHE_MS) return hit.items;
      // 구글 RSS 는 최신 순이라 넉넉히 받는다 (40개만 받으면 장 마감 직후 기사가 잘린다 — 2026-09-26 실측: 마감 뒤 6시간에 약 60건)
      const once = () => d.news.search(q, 100);
      const items = await once().catch(async (e: unknown) => {
        if (isTimeoutError(e) || isTimeoutError((e as { cause?: unknown })?.cause)) throw e;
        await new Promise((res) => setTimeout(res, d.retryDelayMs ?? 1_500));
        return once();
      });
      for (const [k, v] of newsCache) if (t - v.at >= NEWS_CACHE_MS) newsCache.delete(k);
      newsCache.set(q, { at: t, items });
      return items;
    },
    holdings: async () => {
      const rows = await d.db
        .selectFrom("registered_stocks")
        .leftJoin("listed_stocks", "listed_stocks.code", "registered_stocks.code")
        .select(["registered_stocks.code as code", "registered_stocks.name as name", "registered_stocks.market as market", "registered_stocks.quantity as quantity", "listed_stocks.group_code as groupCode"])
        .execute();
      return rows.map((r) => ({ code: r.code, name: r.name, market: r.market, quantity: r.quantity, groupCode: r.groupCode ?? null }));
    },
  };
}
