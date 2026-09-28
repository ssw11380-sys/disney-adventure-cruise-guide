import cron, { type ScheduledTask } from "node-cron";
import { isHighDistribution, leverageFacts, productKindOf, verifyUnderlying, type LeverageFacts, type ProductFacts, type ProductKind } from "../analysis/leveraged.js";
import { FAMILY_KEYS, TREND_CAL, TREND_VERSION, TREND_WEIGHTS, shownScore, trendBand, trendDisplayed, type FamilyKey, type TrendBand, type TrendResult, type TrendShown } from "../analysis/trendScore.js";
import type { Db } from "../db/index.js";
import type { Candle, CandleSeries } from "../domain/types.js";
import { isKrCode, normalizeCode } from "../lib/codes.js";
import { seoulIso } from "../lib/time.js";
import type { FeatureService } from "./featureService.js";
import type { StockService } from "./stockService.js";
import { isKrTradingDate, isUsTradingDate } from "./marketContext.js";
import { benchmarkOf } from "./marketSummaryCalc.js";
import { ValueScoreService, type ValueBlock, type ValueEval } from "./valueScoreService.js";
import { gapText, howLinesV2, VALUE_DETAIL_NOTE } from "./valueScoreText.js";
import {
  BAND_LINE,
  basisSentence,
  benchFetchFailed,
  CARD_TITLE_NOTE,
  changeText,
  DETAIL_NOTE,
  DISCLAIMER_SHORT,
  DISTRIBUTION_NOTE,
  FAMILY_NAME,
  familyRows,
  howLines,
  leverageBox,
  leverageWhy,
  NOT_FORECAST,
  priceDateLine,
  proxyNote,
  referenceText,
  STATUS_TEXT,
  TREND_ABOUT,
  trendHeadline,
  underlyingFetchFailed,
  trendMeaning,
  trendNoteText,
  trendReasonText,
  versionLine,
  type RichLine,
  type ScoreMarket,
} from "./indicatorScoreText.js";

/**
 * 지표 점수 (3-44 1단계, 플래그 indicatorScores): 종목 상세의 '지표 점수' — 이번 단계는 추세 지표 점수만 계산한다
 * (가치 지표 점수는 '계산 준비 중', 종합 지표 점수는 두 점수가 모두 있을 때만 — 지금은 없음).
 *  - 계산: 끝난 정규장 일봉 310개(토스 웹 → 네이버 → 야후, 차트와 같은 CandleCache) + 비교 지수(네이버) → analysis/trendScore (5거래일 평균)
 *  - 갱신: 장 마감 뒤 하루 한 번. 한국 20:10(KRX+NXT 통합 봉이 20:00 에 확정된 뒤) · 미국 뉴욕 17:30(정규장 16:00, 네이버 지수 최종값 17:15 뒤).
 *    그 전에는 지난 거래일 봉까지만 쓴다(latestScoreDate) → 장중에는 바뀌지 않고, 휴장일에는 마지막 거래일 값 그대로
 *  - 등록 종목은 그 시각에 미리 계산해 하루 한 줄씩 저장(indicator_scores, 재현·기록용). 미등록 종목(발견 탭)은 열 때 계산
 *  - 레버리지 상품: 이 상품 자체 점수 없음 → 기초자산 점수를 '참고' 한 줄로 + 레버리지 주의 사실 상자. 기초자산은 일봉으로 확인(analysis/leveraged)
 *  - 인버스·채권형: 대상 아님. 자료가 모자라면 0점·50점으로 채우지 않고 '점수 없음 — 이유'
 *  - 받기 실패(일봉·비교 지수·기초자산 일봉)는 '원래 없음'·'계산 불가'와 따로(설계 5.4): 빠진 채 다른 점수를 내지 않고 reason 'fetchFailed',
 *    5분만 기억하고 하루 기록에 남기지 않는다(장 마감 뒤 40분에 빠진 종목만 다시 계산)
 *  - 문장은 모두 indicatorScoreText 의 틀 (금지어 검사 analysis/scoreWording). AI 프롬프트·브리핑·알림·위젯·잔고 목록에는 넣지 않는다
 *  - 플래그를 끄면 계산·외부 요청·저장·화면이 모두 0건 (경로는 404)
 */

export type BenchCode = "NASDAQ" | "SPX" | "KOSPI" | "KOSDAQ";
export const BENCH_NAME: Record<BenchCode, string> = { NASDAQ: "나스닥", SPX: "S&P500", KOSPI: "코스피", KOSDAQ: "코스닥" };

/** 일봉 요청 개수 (300봉 + 5일 평균 4 + 지난주 비교 5 + 휴장·정리 여유) */
export const SCORE_CANDLES = 310;
const BENCH_CANDLES = 400;

/** 점수가 새 봉으로 바뀌는 시각 (그 시장 현지, 자정부터 분) */
export const SCORE_READY: Record<ScoreMarket, { tz: string; minutes: number; cron: string; retryCron: string }> = {
  KR: { tz: "Asia/Seoul", minutes: 20 * 60 + 10, cron: "10 20 * * 1-5", retryCron: "50 20 * * 1-5" },
  US: { tz: "America/New_York", minutes: 17 * 60 + 30, cron: "30 17 * * 1-5", retryCron: "10 18 * * 1-5" },
};

function localParts(now: Date, tz: string): { date: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, minutes: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}
const isTrading = (m: ScoreMarket, date: string) => (m === "KR" ? isKrTradingDate(date) : isUsTradingDate(date));
function prevDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 지금 점수에 쓸 마지막 봉 날짜 = 점수가 확정된 가장 최근 거래일 (그 시장 현지 날짜).
 * 오늘이 거래일이고 준비 시각(한국 20:10 · 뉴욕 17:30)이 지났으면 오늘, 아니면 그 전 거래일 (주말·휴장일 건너뜀)
 */
export function latestScoreDate(market: ScoreMarket, now: Date): string {
  const r = SCORE_READY[market];
  const p = localParts(now, r.tz);
  if (isTrading(market, p.date) && p.minutes >= r.minutes) return p.date;
  let d = prevDate(p.date);
  for (let i = 0; i < 15 && !isTrading(market, d); i++) d = prevDate(d);
  return d;
}

/** 장 마감 뒤 미리 계산할 때인지: 그 시장 거래일이고 준비 시각이 지났다 (휴장일·주말의 예약은 건너뜀) */
export function dailyRunDue(market: ScoreMarket, now: Date): boolean {
  const r = SCORE_READY[market];
  const p = localParts(now, r.tz);
  return isTrading(market, p.date) && p.minutes >= r.minutes;
}

export interface ScoreStock {
  code: string;
  name: string;
  /** registered_stocks.market (KOSPI · KOSDAQ · NASDAQ · NYSE · AMEX · US …) */
  market: string;
  /** 종목 마스터 분류 (EF = ETF, EN = ETN) */
  groupCode?: string | null;
  /** 등록 종목인지 (false = 발견 탭 등에서 연 미등록 종목 — 계산은 하되 하루 기록은 남기지 않음). 모르면 등록 종목으로 본다 */
  registered?: boolean;
}

/** 점수에 필요한 자료 (app.ts 가 실제 출처로 채운다, 테스트는 기록한 일봉으로) */
export interface ScoreSources {
  /** 등록 종목 또는 종목 마스터·검색의 이름·시장. 모르는 코드면 null */
  stock(code: string): Promise<ScoreStock | null>;
  /**
   * 등록 표를 보지 않는 이름 (종목 마스터·검색 — 종목 상세 미리 보기와 같음). 주인 아닌 계정에게 보이는 이름 (계정 A단계, #95 합친 뒤).
   * 모르는 코드면 null. 없으면(테스트 출처) stock 의 이름
   */
  publicStock?(code: string): Promise<{ name: string } | null>;
  /** 일봉 (오래된 → 최신). 출처 이름은 series.source. fresh = 장 마감 뒤 미리 계산 — 차트 캐시에 1분 넘게 묵은 봉을 쓰지 않고 새로 받는다 */
  candles(code: string, count: number, opts?: { fresh?: boolean }): Promise<CandleSeries>;
  /** 비교 지수 일봉 (네이버) */
  benchmark(code: BenchCode, count: number): Promise<Candle[] | null>;
  /** 토스 웹 상품 정보 (ETF·레버리지 배수). 없으면 null */
  product(code: string): Promise<ProductFacts | null>;
  /** 등록 종목 (장 마감 뒤 미리 계산할 목록) */
  registered(): Promise<ScoreStock[]>;
  /** 월봉 (가치 지표의 자기 지난 5년 비교, 오래된 → 최신). 없으면 자기 비교 없이 계산 */
  monthly?(code: string, count: number): Promise<Candle[] | null>;
}

export interface FamilyRow {
  key: FamilyKey;
  name: string;
  about: string;
  weight: number;
  score: number | null;
  scoreExact: number | null;
  text: string;
  facts: Array<{ label: string; value: string }>;
  items: Array<{ key: string; name: string; score: number | null }>;
}

export interface TrendBlock {
  version: string;
  cal: string;
  status: "ok" | "unavailable" | "hold" | "excluded";
  /** 요약 카드 줄의 글: 띠 이름 · 점수 없음 · 잠시 보류 · 대상 아님 · 이 상품 자체 점수 없음 */
  label: string;
  reason: { code: string; text: string } | null;
  /** 화면 정수 (5거래일 평균의 반올림) */
  score: number | null;
  scoreExact: number | null;
  scoreToday: number | null;
  band: TrendBand | null;
  /** 요약 카드 설명 줄 */
  meaning: string | null;
  /** 상세 카드: 머리 · 기준 문장 · 띠 한 줄 */
  headline: string | null;
  basisLine: string | null;
  bandLine: string | null;
  basis: { kind: "self" | "underlying"; code: string; name: string };
  benchmark: { code: BenchCode; name: string } | null;
  candleSource: string | null;
  bars: number | null;
  daysAveraged: number | null;
  coverage: number | null;
  families: FamilyRow[];
  notes: string[];
  /** 지난주(5거래일 전) 대비 화면 정수가 5점 넘게 바뀌었을 때만 (상세 카드) */
  change: { from: string; prev: number; now: number; diff: number; family: FamilyKey; familyName: string; familyDiff: number; text: string } | null;
  /** 레버리지 상품: 기초자산 점수 참고 줄 */
  reference: { code: string; name: string; status: "ok" | "unavailable" | "hold"; score: number | null; band: TrendBand | null; text: string; note: string | null } | null;
  leveraged: { L: number; underlying: string | null; tracks: string | null; check: { days: number; corr: number | null; beta: number | null } | null; facts: LeverageFacts | null; box: { title: string; lines: RichLine[] } } | null;
  versionLine: string;
}

export interface ScoresResponse {
  code: string;
  name: string;
  market: ScoreMarket;
  asOf: { priceDate: string | null; scoreDate: string; market: ScoreMarket; line: string | null };
  /** 가치 지표 (2단계: 미국 보통주 점수, 한국 '계산 준비 중', ETF 등 '대상 아님') */
  value: ValueBlock;
  trend: TrendBlock;
  /** 종합 = 화면에 보이는 두 정수의 평균 (두 점수가 모두 있고 가격 기준일이 같을 때만). |V − T| ≥ 30 이면 차이 안내 */
  composite: { status: "ok" | "none"; score: number | null; reason: "valueMissing" | "trendMissing" | "bothMissing" | "dateMismatch" | null; text: string; gap: number | null; gapNote: boolean; gapText: string | null };
  text: { titleNote: string; notForecast: string; how: string[]; disclaimerShort: string; detailNote: string; trendAbout: string; valueAbout: string; valueDetailNote: string };
  computedAt: string;
}

export interface IndicatorScoreDeps {
  db: Db;
  features: Pick<FeatureService, "enabled">;
  sources: ScoreSources;
  /** 가치 지표 (2단계). 없으면 1단계 그대로 */
  value?: ValueScoreService | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

/**
 * 계산 결과를 이만큼 기억 (같은 기준 거래일이면 다시 계산하지 않는다). 받기 실패는 5분,
 * 마지막 봉이 기준 거래일보다 앞이면(출처가 아직 오늘 봉을 안 줌·거래정지) 30분 — 지수 날짜는 받기 실패 규칙이 종목 마지막 봉과 같게 맞춘다
 */
const CACHE_OK_MS = 6 * 3_600_000;
const CACHE_LAG_MS = 30 * 60_000;
const CACHE_FAIL_MS = 5 * 60_000;
/** 가치 지표가 백그라운드 받기(재무·첫 비교 기준)를 기다리는 동안 */
const CACHE_WAIT_MS = 60_000;
const CACHE_MAX = 300;
/** 가치 지표 자기 지난 5년 비교용 월봉 수 */
const MONTHLY_CANDLES = 72;
/** 종합 차이 안내 기준 (|V − T| 이 이 이상) */
export const COMPOSITE_GAP_NOTE = 30;

const marketOf = (code: string): ScoreMarket => (isKrCode(code) ? "KR" : "US");
const cutTo = <T extends { date: string }>(cs: readonly T[], date: string) => cs.filter((c) => c.date <= date);
/** 받기 실패 (잠시 뒤 다시 계산, 기록하지 않음) */
export const isFetchFailure = (resp: ScoresResponse): boolean => resp.trend.reason?.code === "fetchFailed";

/** 주인 아닌 계정의 점수 요청이 재무 받기를 기다리는 최대 시간 (검증 6차 M2 — 앱의 점수 요청 시간 초과 20초 안에서 넉넉히) */
export const MEMBER_VALUE_WAIT_MS = 8_000;
/** 가치 칸이 이 종목 재무를 받는 중이라 '계산 준비 중'인지 (처음 받기 · 오랜만에 새로 받기 — 종목마다 캐시에 따라 갈리는 상태) */
export const factsPending = (v: ValueBlock): boolean => v.status === "pending" && (v.reason?.code === "pendingFacts" || v.reason?.code === "pendingRefresh");
/** 가치 쪽 받기 실패·백그라운드 받기 대기 (응답을 짧게만 기억, 가치 기록은 남기지 않음) */
const valueWaits = new WeakMap<ScoresResponse, ValueEval>();

interface Ctx {
  scoreDate: string;
  /** 장 마감 뒤 미리 계산: 차트 캐시의 묵은 봉을 쓰지 않는다 */
  fresh: boolean;
}
/** 추세 쪽 결과 + 가치 지표가 함께 쓰는 일봉 (기준 거래일까지, 받기 실패면 null) */
type TrendOut = { block: TrendBlock; priceDate: string | null; stored: Record<string, unknown>; candles: Candle[] | null };
type ValueEvalProduct = Parameters<ValueScoreService["evaluate"]>[0]["product"];
type SelfTrend = { r: TrendResult; prev: TrendResult | null; bench: TrendBlock["benchmark"]; benchName: string | null; benchMissing: "overseas" | "none" | null };

export class IndicatorScoreService {
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; ttl: number; resp: ScoresResponse }>();
  private readonly inflight = new Map<string, Promise<ScoresResponse | null>>();
  private tasks: ScheduledTask[] = [];
  private catchUpTimer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  /** 마지막 미리 계산 결과 (관리·로그용) */
  lastRun: { market: ScoreMarket; at: string; computed: number; failed: number; skipped?: string } | null = null;

  constructor(private readonly deps: IndicatorScoreDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  enabled(): Promise<boolean> {
    return this.deps.features.enabled("indicatorScores");
  }

  /** 종목 하나의 지표 점수. 모르는 종목이면 null. 플래그는 부르는 쪽(경로)이 먼저 본다 */
  async get(code: string, opts: { store?: boolean; fresh?: boolean } = {}): Promise<ScoresResponse | null> {
    const c = normalizeCode(code);
    const scoreDate = latestScoreDate(marketOf(c), this.now());
    const key = `${c}|${scoreDate}`;
    const t = this.now().getTime();
    const hit = this.cache.get(key);
    if (!opts.fresh && hit && t - hit.at < hit.ttl) return hit.resp;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.compute(c, { scoreDate, fresh: opts.fresh === true }, opts.store !== false)
      .then((resp) => {
        if (resp) {
          const lagging = resp.asOf.priceDate !== null && resp.asOf.priceDate < scoreDate;
          this.cache.delete(key);
          const v = valueWaits.get(resp);
          const ttl = isFetchFailure(resp) ? CACHE_FAIL_MS : v?.waiting ? CACHE_WAIT_MS : v?.fetchFailure ? CACHE_FAIL_MS : lagging ? CACHE_LAG_MS : CACHE_OK_MS;
          this.cache.set(key, { at: t, ttl, resp });
          while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        }
        return resp;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 주인 아닌 계정에게 보일 종목 이름 — 등록 표를 보지 않는다 (ScoreSources.publicStock, 없으면 stock). 모르면 null */
  async publicName(code: string): Promise<string | null> {
    const src = this.deps.sources;
    const c = normalizeCode(code);
    const s = src.publicStock ? await src.publicStock(c) : await src.stock(c);
    return s?.name ?? null;
  }

  /**
   * 주인 아닌 계정용 (계정 A단계 검증 6차 M2): 가치 칸이 '재무 받는 중'(pendingFacts · pendingRefresh)이면 받기가 끝날 때까지 waitMs 까지 기다렸다가
   * 다시 계산한다. 주인 등록 종목은 서버가 재무를 매일 미리 받아 두어 바로 점수가 나오고, 처음 보는 종목만 '계산 준비 중'으로 시작해
   * **본문만으로** 주인 등록 종목이 드러났다 (응답 속도보다 확실한 신호). 받기가 waitMs 안에 끝나지 않으면(출처가 느림·줄이 김) 그대로 '계산 준비 중'.
   * 주인은 예전처럼 기다리지 않는다 (get)
   */
  async getShared(code: string, waitMs: number = MEMBER_VALUE_WAIT_MS): Promise<ScoresResponse | null> {
    const r = await this.get(code);
    if (!r || !this.deps.value || !factsPending(r.value)) return r;
    if (!(await this.deps.value.waitFacts(code, waitMs))) return r;
    // 받아 둔 '계산 준비 중' 응답(짧게 기억)을 버리고 다시 — 방금 받은 재무로
    const c = normalizeCode(code);
    this.cache.delete(`${c}|${latestScoreDate(marketOf(c), this.now())}`);
    return (await this.get(code)) ?? r;
  }

  /**
   * 장 마감 뒤 미리 계산 (예약: 한국 20:10 · 뉴욕 17:30, 평일). 플래그가 꺼져 있거나 휴장일이면 아무것도 하지 않는다.
   * 그 시장의 등록 종목(관심 포함)을 차례로 계산해 저장한다 (한 번에 하나 — 출처에 몰리지 않게)
   */
  async runDaily(market: ScoreMarket, opts: { codes?: readonly string[] } = {}): Promise<{ computed: number; failed: number; skipped?: string }> {
    const at = seoulIso(this.now());
    if (!(await this.enabled())) return this.done({ market, at, computed: 0, failed: 0, skipped: "off" });
    if (!dailyRunDue(market, this.now())) return this.done({ market, at, computed: 0, failed: 0, skipped: "closed" });
    if (this.running) await this.running.catch(() => undefined);
    const work = (async () => {
      const only = opts.codes ? new Set(opts.codes) : null;
      const list = (await this.deps.sources.registered()).filter((s) => marketOf(s.code) === market && (!only || only.has(s.code)));
      let computed = 0;
      let failed = 0;
      for (const s of list) {
        try {
          // 가치 지표: 저장한 재무(미국 SEC · 한국 네이버 재무 요약)가 20시간 넘게 묵었으면 먼저 다시 받는다 (화면 요청은 기다리지 않음)
          await this.deps.value?.refreshIfStale(s.code).catch(() => undefined);
          const r = await this.get(s.code, { fresh: true, store: true });
          if (r && !isFetchFailure(r)) computed++;
          else failed++;
        } catch (e) {
          failed++;
          this.deps.log?.warn({ code: s.code, err: e instanceof Error ? e.message : String(e) }, "지표 점수: 미리 계산 실패");
        }
      }
      return this.done({ market, at, computed, failed });
    })();
    this.running = work;
    try {
      return await work;
    } finally {
      if (this.running === work) this.running = null;
    }
  }

  private done(r: { market: ScoreMarket; at: string; computed: number; failed: number; skipped?: string }) {
    this.lastRun = r;
    if (!r.skipped) this.deps.log?.info({ ...r }, "지표 점수: 장 마감 뒤 계산");
    const { market: _m, at: _a, ...out } = r;
    return out;
  }

  start(): void {
    this.stop();
    for (const m of ["KR", "US"] as const) {
      const r = SCORE_READY[m];
      this.tasks.push(cron.schedule(r.cron, () => void this.runDaily(m).catch(() => undefined), { timezone: r.tz, name: `indicator-scores-${m.toLowerCase()}` }));
      // 40분 뒤 한 번 더: 받기 실패로 기록이 빠진 종목만 (받기 실패는 기록하지 않으므로)
      this.tasks.push(cron.schedule(r.retryCron, () => void this.catchUp([m]).catch(() => undefined), { timezone: r.tz, name: `indicator-scores-${m.toLowerCase()}-retry` }));
    }
    // 준비 시각 뒤에 서버가 다시 켜졌으면(배포 등) 1분 뒤 그날 몫을 따라잡는다 — 예약은 다음 날까지 오지 않으므로
    this.catchUpTimer = setTimeout(() => void this.catchUp().catch(() => undefined), 60_000);
    this.catchUpTimer.unref?.();
    // 가치 지표: 주 1회 비교 기준 · 켤 때 등록 종목 재무 받아 두기 (플래그가 꺼져 있으면 아무것도 하지 않음)
    this.deps.value?.start(async () => (await this.deps.sources.registered()).map((s) => s.code));
  }

  stop(): void {
    this.deps.value?.stop();
    for (const t of this.tasks) void t.destroy();
    this.tasks = [];
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
  }

  /**
   * 따라잡기: 지금이 그 시장 준비 시각 뒤(같은 현지 거래일 안)인데 등록 종목 가운데 오늘(기준 거래일) 기록이 없는 종목이 있으면 그 종목만 미리 계산한다.
   * 서버를 준비 시각 뒤에 다시 켰을 때(1분 뒤)와 준비 시각 40분 뒤(받기 실패로 빠진 종목) 부른다. 플래그가 꺼져 있으면 아무것도 하지 않는다. 돌린 시장 목록
   */
  async catchUp(markets: readonly ScoreMarket[] = ["KR", "US"]): Promise<ScoreMarket[]> {
    if (!(await this.enabled())) return [];
    const ran: ScoreMarket[] = [];
    for (const m of markets) {
      if (!dailyRunDue(m, this.now())) continue;
      const date = latestScoreDate(m, this.now());
      const codes = (await this.deps.sources.registered()).filter((s) => marketOf(s.code) === m).map((s) => s.code);
      if (!codes.length) continue;
      const have = new Set((await this.deps.db.selectFrom("indicator_scores").select("code").where("score_date", "=", date).where("kind", "=", "trend").where("code", "in", codes).execute()).map((r) => r.code));
      const missing = codes.filter((c) => !have.has(c));
      if (!missing.length) continue;
      await this.runDaily(m, { codes: missing });
      ran.push(m);
    }
    return ran;
  }

  // ── 계산 ───────────────────────────────────────────────

  private async compute(code: string, ctx: Ctx, store: boolean): Promise<ScoresResponse | null> {
    const { sources } = this.deps;
    const { scoreDate } = ctx;
    const stock = await sources.stock(code);
    if (!stock) return null;
    const market = marketOf(code);
    const facts = await sources.product(code).catch(() => null);
    // 토스 상품 정보가 없거나 분류 칸이 비면 종목 마스터 분류(ST·EF·EN)를 쓴다 — 보통 주식 이름의 'Bear'·'Short' 로 인버스를 짐작하지 않게 (계좌 비중 한 줄과 같은 함수)
    const kind = productKindOf(code, stock.name, facts, stock.groupCode);
    const etf = kind.etf || stock.groupCode === "EF" || stock.groupCode === "EN";
    const trend = await this.trendBlock(stock, market, ctx, kind, facts, isHighDistribution(stock.name, facts, etf));
    const priceDate = trend.priceDate;
    // 가치 (2단계): 플래그·출처가 있으면 저장한 SEC 재무·비교 기준으로 (SEC 요청 없음), 아니면 1단계 줄 그대로
    const valueOn = this.deps.value ? await this.deps.value.enabled() : false;
    const v: ValueEval = valueOn
      ? await this.deps.value!.evaluate({
          code,
          name: stock.name,
          etf,
          product: facts as ValueEvalProduct,
          candles: trend.candles,
          monthly: () => (this.deps.sources.monthly ? this.deps.sources.monthly(code, MONTHLY_CANDLES) : Promise.resolve(null)),
          scoreDate,
          splitHold: trend.block.status === "hold",
        })
      : { block: ValueScoreService.stage1Block(etf), stored: null, fetchFailure: false, waiting: false };
    const composite = compositeOf(v.block, trend.block, priceDate);
    const krOn = valueOn && (await this.deps.value!.krEnabled());
    const line = priceDate ? `${priceDateLine(priceDate, market)}${v.block.asOf.fiscalShort ? ` · ${v.block.asOf.fiscalShort}` : ""}` : null;
    const resp: ScoresResponse = {
      code,
      name: stock.name,
      market,
      asOf: { priceDate, scoreDate, market, line },
      value: v.block,
      trend: trend.block,
      composite,
      text: { titleNote: CARD_TITLE_NOTE, notForecast: NOT_FORECAST, how: valueOn ? howLinesV2(krOn) : howLines(), disclaimerShort: DISCLAIMER_SHORT, detailNote: DETAIL_NOTE, trendAbout: TREND_ABOUT, valueAbout: v.block.about, valueDetailNote: VALUE_DETAIL_NOTE },
      computedAt: seoulIso(this.now()),
    };
    if (v.waiting || v.fetchFailure) valueWaits.set(resp, v);
    // 받기 실패는 기록하지 않는다 (그날 기록이 빠진 채로 두고 40분 뒤·다음에 열 때 다시 계산해 채운다)
    if (store && stock.registered !== false && !isFetchFailure(resp)) await this.save(resp, trend.stored).catch((e: unknown) => this.deps.log?.warn({ code, err: e instanceof Error ? e.message : String(e) }, "지표 점수: 기록 저장 실패"));
    if (store && stock.registered !== false && v.stored && !v.fetchFailure && !v.waiting) await this.saveValue(resp, v.stored).catch((e: unknown) => this.deps.log?.warn({ code, err: e instanceof Error ? e.message : String(e) }, "지표 점수: 가치 기록 저장 실패"));
    return resp;
  }

  private async fetchCut(code: string, ctx: Ctx): Promise<{ candles: Candle[]; source: string } | null> {
    try {
      const s = await this.deps.sources.candles(code, SCORE_CANDLES, ctx.fresh ? { fresh: true } : undefined);
      return { candles: cutTo(s.candles, ctx.scoreDate), source: s.source };
    } catch {
      return null;
    }
  }

  /**
   * 종목 자체 추세 (비교 지수·지난주 대비 포함).
   * 비교 지수가 있어야 하는 종목인데 지수 일봉을 받지 못했으면(오류·빈 응답·종목 마지막 봉보다 늦은 지수) 지수 대비 항목을 뺀 다른 점수를 내지 않고
   * benchFailed 를 돌려준다 — '비교 지수가 원래 없음'(noBench 안내)과 다르다. 단 기록 부족·거래정지·분할 의심·가격 변화 없음처럼 지수와 상관없는 이유면 그 이유를 그대로
   */
  private async selfTrend(stock: ScoreStock, market: ScoreMarket, ctx: Ctx, facts: ProductFacts | null, candles: Candle[]): Promise<SelfTrend | { benchFailed: { code: BenchCode; name: string } }> {
    const { scoreDate } = ctx;
    const b = benchmarkOf(market, { code: stock.code, name: stock.name, market: stock.market, groupCode: stock.groupCode ?? null }, { changeRate: 0, tradedAt: null, ...(facts?.exchange || stock.market ? { exchange: facts?.exchange ?? stock.market } : {}) });
    const benchCode = "code" in b ? (b.code as BenchCode) : null;
    let bench: Candle[] | null = null;
    if (benchCode) {
      const got = await this.deps.sources.benchmark(benchCode, BENCH_CANDLES).then(
        (cs) => (cs ? cutTo(cs, scoreDate) : null),
        () => null,
      );
      const lastStock = candles.at(-1)?.date ?? null;
      if (!got?.length || (lastStock !== null && got.at(-1)!.date < lastStock)) {
        const alone = trendDisplayed(candles, null, { expectedLast: scoreDate });
        if (alone.status !== "ok" && ["short", "stale", "split", "flat"].includes(alone.reason.code)) return { r: alone, prev: null, bench: null, benchName: null, benchMissing: null };
        return { benchFailed: { code: benchCode, name: BENCH_NAME[benchCode] } };
      }
      bench = got;
    }
    const r = trendDisplayed(candles, bench, { expectedLast: scoreDate });
    const benchName = benchCode && bench ? BENCH_NAME[benchCode] : null;
    const benchMissing = "exclude" in b && b.exclude === "overseas" ? "overseas" : benchCode ? null : "none";
    // 지난주 = 5거래일 전 봉까지로 같은 식 (저장한 기록이 없어도 같은 봉이면 같은 값)
    let prev: TrendResult | null = null;
    if (r.status === "ok" && candles.length > 5) {
      const cut = candles.slice(0, -5);
      const last = cut[cut.length - 1]!.date;
      prev = trendDisplayed(cut, bench ? bench.filter((x) => x.date <= last) : null, { expectedLast: null });
    }
    return { r, prev, bench: benchCode && bench ? { code: benchCode, name: BENCH_NAME[benchCode] } : null, benchName, benchMissing: benchMissing as "overseas" | "none" | null };
  }

  private async trendBlock(
    stock: ScoreStock,
    market: ScoreMarket,
    ctx: Ctx,
    kind: ProductKind,
    facts: ProductFacts | null,
    distribution: boolean,
  ): Promise<TrendOut> {
    const base = {
      version: TREND_VERSION,
      cal: TREND_CAL.version,
      score: null,
      scoreExact: null,
      scoreToday: null,
      band: null,
      meaning: null,
      headline: null,
      basisLine: null,
      bandLine: null,
      basis: { kind: "self" as const, code: stock.code, name: stock.name },
      benchmark: null,
      candleSource: null,
      bars: null,
      daysAveraged: null,
      coverage: null,
      families: [],
      notes: [],
      change: null,
      reference: null,
      leveraged: null,
      versionLine: versionLine(null, null),
    };
    if (kind.kind === "inverse" || kind.kind === "bond") {
      const text = kind.kind === "inverse" ? STATUS_TEXT.inverse : STATUS_TEXT.bond;
      const got = await this.fetchCut(stock.code, ctx);
      const priceDate = got?.candles.at(-1)?.date ?? null;
      return { block: { ...base, status: "excluded", label: "대상 아님", reason: { code: kind.kind, text } }, priceDate, stored: { status: "excluded", reason: kind.kind }, candles: got?.candles ?? null };
    }
    if (kind.kind === "leveraged") return this.leveragedBlock(stock, ctx, kind, base);

    const got = await this.fetchCut(stock.code, ctx);
    if (!got) return { block: { ...base, status: "unavailable", label: "점수 없음", reason: { code: "fetchFailed", text: STATUS_TEXT.fetchFailed } }, priceDate: null, stored: {}, candles: null };
    const t = await this.selfTrend(stock, market, ctx, facts, got.candles);
    const priceDate = got.candles.at(-1)?.date ?? null;
    if ("benchFailed" in t)
      return {
        block: { ...base, status: "unavailable", label: "점수 없음", reason: { code: "fetchFailed", text: benchFetchFailed(t.benchFailed.name) }, candleSource: got.source, versionLine: versionLine(got.source, null) },
        priceDate,
        stored: {},
        candles: got.candles,
      };
    const block = this.fromResult(base, t, got.source, market);
    if (distribution && block.status === "ok") block.notes = [...block.notes, DISTRIBUTION_NOTE];
    return { block, priceDate: block.status === "ok" ? (t.r as TrendShown).asOf : priceDate, stored: storedOf(t.r, t.prev, got.source, t.bench), candles: got.candles };
  }

  private fromResult(base: Omit<TrendBlock, "status" | "label" | "reason">, t: SelfTrend, source: string, market: ScoreMarket): TrendBlock {
    const r = t.r;
    const common = { ...base, benchmark: t.bench, candleSource: source, versionLine: versionLine(source, t.benchName) };
    if (r.status !== "ok") {
      const hold = r.status === "hold";
      // 상태 글('잠시 보류')은 label 에 따로 — 이유 글 앞에 다시 쓰지 않는다 (요약 카드가 상태 글 옆에 이유 글을 둔다, 검토 지적)
      return { ...common, status: r.status, label: hold ? "잠시 보류" : "점수 없음", reason: { code: r.reason.code, text: trendReasonText(r.reason) } };
    }
    const score = shownScore(r.score);
    const band = trendBand(r.score)!;
    return {
      ...common,
      status: "ok",
      label: band,
      reason: null,
      score,
      scoreExact: r.score,
      scoreToday: r.scoreToday,
      band,
      meaning: trendMeaning(band),
      headline: trendHeadline(score, band),
      basisLine: basisSentence(r.asOf, market),
      bandLine: BAND_LINE[band],
      bars: r.bars,
      daysAveraged: r.daysAveraged,
      coverage: r.coverage,
      families: familyRows(r, t.benchName),
      notes: [...r.notes.map((n) => trendNoteText(n, t.benchMissing)), ...(r.coverage < 1 ? [`계산에 쓴 항목 비중 ${Math.round(r.coverage * 100)}%`] : [])],
      change: t.prev?.status === "ok" ? weeklyChange(r, t.prev) : null,
    };
  }

  /**
   * 레버리지 상품: 이 상품 자체 점수 없음 + 기초자산 참고 줄 + 사실 상자.
   * 받기 실패(상품 일봉·기초자산 일봉·기초자산의 비교 지수)는 '기초자산을 확인하지 못함'과 따로 reason 'fetchFailed' 로 (5분 뒤 다시, 기록 안 함).
   * 정적 표의 기초자산은 상품 일봉이 없어도 참고 줄을 두고, 이름으로 짐작한 기초자산은 두 일봉으로 확인된 때만 쓴다
   */
  private async leveragedBlock(
    stock: ScoreStock,
    ctx: Ctx,
    kind: Extract<ProductKind, { kind: "leveraged" }>,
    base: Omit<TrendBlock, "status" | "label" | "reason">,
  ): Promise<TrendOut> {
    const own = await this.fetchCut(stock.code, ctx);
    const L = kind.L;
    const cand = kind.underlying;
    const fromTable = kind.source === "table";
    const und = cand ? await this.fetchCut(cand, ctx) : null;
    let failed: string | null = null;
    if (!own && cand && !und) failed = STATUS_TEXT.fetchFailed;
    else if (!own) failed = STATUS_TEXT.productFetchFailed;
    else if (cand && !und) failed = fromTable ? underlyingFetchFailed(cand) : STATUS_TEXT.underlyingFetchFailed;
    let underlying: string | null = null;
    let check: { days: number; corr: number | null; beta: number | null; ok: boolean | null } | null = null;
    if (cand && und) {
      if (own) {
        check = verifyUnderlying(own.candles, und.candles, L);
        // 하루 수익이 L배를 따라가지 않으면 기초자산을 모르는 것으로 (이름으로 짐작한 기초는 확인되어야만 쓴다)
        underlying = check.ok === true || (check.ok === null && fromTable) ? cand : null;
      } else if (fromTable) underlying = cand; // 상품 일봉이 없어 확인할 수 없음 — 정적 표만 믿는다
    }
    // 사실 상자의 '따르는 것': 확인된 기초자산, 또는 받기 실패일 때 정적 표 (이름 짐작은 확인 전이라 쓰지 않음)
    const tracks = underlying || (failed && fromTable) ? kind.tracks : null;
    const facts = own ? leverageFacts(own.candles, underlying && und ? und.candles : null, L) : null;
    const box = leverageBox(facts, L, tracks);
    let reference: TrendBlock["reference"] = null;
    let refStored: Record<string, unknown> | null = null;
    if (underlying && und) {
      const uStock = (await this.deps.sources.stock(underlying).catch(() => null)) ?? { code: underlying, name: underlying, market: isKrCode(underlying) ? "KOSPI" : "US" };
      const uFacts = await this.deps.sources.product(underlying).catch(() => null);
      const t = await this.selfTrend(uStock, marketOf(underlying), ctx, uFacts, und.candles);
      const note = kind.tracks && /지수/.test(kind.tracks) ? proxyNote(underlying, kind.tracks) : null;
      if ("benchFailed" in t) failed ??= benchFetchFailed(t.benchFailed.name, underlying);
      else {
        if (t.r.status === "ok") {
          const s = shownScore(t.r.score);
          const b = trendBand(t.r.score)!;
          reference = { code: underlying, name: uStock.name, status: "ok", score: s, band: b, text: referenceText(underlying, s, b), note };
        } else reference = { code: underlying, name: uStock.name, status: t.r.status, score: null, band: null, text: `참고: 기초자산 ${underlying} 추세 지표 점수 없음 — ${trendReasonText(t.r.reason)}`, note };
        refStored = storedOf(t.r, null, und.source, t.bench);
      }
    }
    const reason = failed
      ? { code: "fetchFailed", text: failed }
      : underlying
        ? { code: "leveraged", text: leverageWhy(L) }
        : { code: "underlyingUnknown", text: STATUS_TEXT.underlyingUnknown };
    const block: TrendBlock = {
      ...base,
      status: "excluded",
      label: "이 상품 자체 점수 없음",
      reason,
      basis: underlying ? { kind: "underlying", code: underlying, name: reference?.name ?? underlying } : base.basis,
      candleSource: own?.source ?? null,
      reference,
      leveraged: { L, underlying, tracks, check: check ? { days: check.days, corr: check.corr, beta: check.beta } : null, facts, box },
      versionLine: versionLine(own?.source ?? null, null),
    };
    const priceDate = own?.candles.at(-1)?.date ?? null;
    return { block, priceDate, stored: { status: "excluded", reason: reason.code, leveraged: { L, underlying, check, facts }, reference: refStored }, candles: own?.candles ?? null };
  }

  /**
   * 하루 한 줄: 기준 거래일(scoreDate) 로 적는다 — 거래정지 종목을 나중에 다시 계산해도 마지막 봉 날짜의 예전 기록을 덮지 않고,
   * 따라잡기가 '오늘 기록'을 같은 날짜로 센다. 봉 날짜는 data.priceDate
   */
  private async save(resp: ScoresResponse, stored: Record<string, unknown>): Promise<void> {
    const at = seoulIso(this.now());
    const t = resp.trend;
    const row = {
      score_date: resp.asOf.scoreDate,
      code: resp.code,
      market: resp.market,
      kind: "trend",
      version: `${TREND_VERSION}/${TREND_CAL.version}`,
      status: t.status,
      score: t.scoreExact,
      score_today: t.scoreToday,
      band: t.band,
      data: JSON.stringify({ ...stored, priceDate: resp.asOf.priceDate, basis: t.basis, benchmark: t.benchmark, reason: t.reason?.code ?? null }),
      created_at: at,
      updated_at: at,
    };
    await this.deps.db
      .insertInto("indicator_scores")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["code", "score_date", "kind"]).doUpdateSet({ market: row.market, version: row.version, status: row.status, score: row.score, score_today: row.score_today, band: row.band, data: row.data, updated_at: at }),
      )
      .execute();
  }

  /** 가치 지표 하루 한 줄 (kind 'value', 같은 기준 거래일이면 덮어씀). 점수·묶음·지표 순위·재무 기준·비교 기준 날짜 */
  private async saveValue(resp: ScoresResponse, stored: Record<string, unknown>): Promise<void> {
    const at = seoulIso(this.now());
    const v = resp.value;
    const row = {
      score_date: resp.asOf.scoreDate,
      code: resp.code,
      market: resp.market,
      kind: "value",
      version: v.method,
      status: v.status,
      score: v.scoreExact,
      score_today: null,
      band: v.band,
      data: JSON.stringify({ ...stored, reason: v.reason?.code ?? null }),
      created_at: at,
      updated_at: at,
    };
    await this.deps.db
      .insertInto("indicator_scores")
      .values(row)
      .onConflict((oc) => oc.columns(["code", "score_date", "kind"]).doUpdateSet({ market: row.market, version: row.version, status: row.status, score: row.score, score_today: row.score_today, band: row.band, data: row.data, updated_at: at }))
      .execute();
  }

  /** 저장한 기록 (관리·확인용, 최근 순). kind 'trend'(기본) · 'value' */
  async history(code: string, limit = 30, kind: "trend" | "value" = "trend"): Promise<Array<{ date: string; status: string; score: number | null; band: string | null }>> {
    const rows = await this.deps.db
      .selectFrom("indicator_scores")
      .select(["score_date", "status", "score", "band"])
      .where("code", "=", normalizeCode(code))
      .where("kind", "=", kind)
      .orderBy("score_date", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => ({ date: r.score_date, status: r.status, score: r.score, band: r.band }));
  }
}

/** 종목 마스터 분류 (listed_stocks.group_code — ST 주권 · EF ETF · EN ETN). 모르면 null. 지표 점수·계좌 비중 한 줄(브리핑 3차 4)이 같이 쓴다 */
export async function groupCodeOf(db: Db, code: string): Promise<string | null> {
  return (await db.selectFrom("listed_stocks").select("group_code").where("code", "=", code).executeTakeFirst())?.group_code ?? null;
}

/**
 * 실제 출처로 만든 자료 묶음: 일봉은 차트와 같은 캐시(stockService.getCandles — 토스 웹 → 네이버 → 야후, 한 종목은 한 출처),
 * 비교 지수는 지수 띠와 같은 네이버 일봉(10분 캐시), 상품 정보는 토스 웹 v2/stock-infos(24시간 캐시), 이름·시장은 등록 종목 → 종목 마스터·검색
 */
export function defaultScoreSources(deps: {
  db: Db;
  stocks: Pick<StockService, "get" | "preview" | "getCandles" | "list">;
  indices: { candles(code: string, period: "D", count: number): Promise<CandleSeries | null> };
  product: { productFacts(code: string): Promise<ProductFacts | null> } | null;
}): ScoreSources {
  const group = (code: string) => groupCodeOf(deps.db, code);
  return {
    stock: async (code) => {
      const reg = await deps.stocks.get(code);
      const s = reg ?? (await deps.stocks.preview(code));
      return s ? { code: s.code, name: s.name, market: s.market, groupCode: await group(s.code).catch(() => null), registered: !!reg } : null;
    },
    // 주인 아닌 계정에게 보이는 이름: 등록 표를 보지 않는 미리 보기 (GET /api/stocks/:code 의 주인 아닌 계정과 같은 이름)
    publicStock: async (code) => {
      const p = await deps.stocks.preview(code);
      return p ? { name: p.name } : null;
    },
    // 장 마감 뒤 미리 계산(fresh)은 차트 캐시에 1분 넘게 묵은 봉을 쓰지 않는다 — 미국은 16:00~20:00 ET 가 한 장 구간이라 마감 직후 받아 둔 봉이 17:30 까지 남을 수 있음
    candles: (code, count, opts) => deps.stocks.getCandles(code, "D", count, opts?.fresh ? { maxAgeMs: 60_000 } : undefined),
    benchmark: async (code, count) => (await deps.indices.candles(code, "D", count))?.candles ?? null,
    product: (code) => (deps.product ? deps.product.productFacts(code) : Promise.resolve(null)),
    registered: async () => (await deps.stocks.list()).map((s) => ({ code: s.code, name: s.name, market: s.market })),
    // 가치 지표의 자기 지난 5년 비교: 차트와 같은 캐시의 월봉
    monthly: async (code, count) => (await deps.stocks.getCandles(code, "M", count)).candles,
  };
}

/**
 * 지난주(5거래일 전 봉까지) 대비 화면 정수가 5점 넘게 바뀌었을 때 한 줄. 묶음은 점수와 같은 쪽으로 움직인 묶음 가운데 비중 × 변화가 가장 큰 것
 * (반대로 움직인 묶음을 '가장 크게 바뀐 묶음'으로 들면 점수 변화를 설명하지 못하므로). 같은 쪽 묶음이 없으면(항목 비중이 바뀐 때) 전체에서 가장 큰 것
 */
export function weeklyChange(r: TrendShown, prevR: TrendShown): TrendBlock["change"] {
  const score = shownScore(r.score);
  const prev = shownScore(prevR.score);
  const diff = score - prev;
  if (Math.abs(diff) <= 5) return null;
  const pick = (sameWay: boolean): FamilyKey | null => {
    let best: FamilyKey | null = null;
    let bestV = -1;
    for (const f of FAMILY_KEYS) {
      const a = r.families[f].score;
      const b = prevR.families[f].score;
      if (a === null || b === null) continue;
      const d = TREND_WEIGHTS[f].w * (a - b);
      if (sameWay && Math.sign(d) !== Math.sign(diff)) continue;
      if (Math.abs(d) > bestV) {
        bestV = Math.abs(d);
        best = f;
      }
    }
    return best;
  };
  const best = pick(true) ?? pick(false);
  if (!best) return null;
  const familyDiff = shownScore(r.families[best].score!) - shownScore(prevR.families[best].score!);
  return { from: prevR.asOf, prev, now: score, diff, family: best, familyName: FAMILY_NAME[best], familyDiff, text: changeText({ from: prevR.asOf, diff, family: best, familyDiff }) };
}

/**
 * 종합 지표 (설계 5.2·5.4): 화면에 보이는 두 정수의 평균 C = floor((V + T) / 2 + 0.5).
 * 가치가 ok·partial 이고 추세가 본인 봉으로 ok 이며 두 가격 기준일이 같을 때만. 없는 점수를 0점·50점으로 채우지 않는다.
 * 레버리지(기초자산 참고)는 추세 점수가 '있는' 쪽으로 보아 '가치 지표 점수가 없어'를 쓴다 (1단계와 같음)
 */
export function compositeOf(value: Pick<ValueBlock, "status" | "score" | "asOf">, trend: Pick<TrendBlock, "status" | "score" | "reason">, priceDate: string | null): ScoresResponse["composite"] {
  const vOk = (value.status === "ok" || value.status === "partial") && value.score !== null;
  const tOk = trend.status === "ok" && trend.score !== null;
  const trendPresent = tOk || trend.reason?.code === "leveraged";
  const none = (reason: "valueMissing" | "trendMissing" | "bothMissing" | "dateMismatch", text: string): ScoresResponse["composite"] => ({ status: "none", score: null, reason, text: `없음 · ${text}`, gap: null, gapNote: false, gapText: null });
  if (!vOk && !trendPresent) return none("bothMissing", STATUS_TEXT.compositeBothMissing);
  if (!vOk) return none("valueMissing", STATUS_TEXT.compositeValueMissing);
  if (!tOk) return none("trendMissing", STATUS_TEXT.compositeTrendMissing);
  if (!priceDate || value.asOf.priceThrough !== priceDate) return none("dateMismatch", STATUS_TEXT.compositeDateMismatch);
  const V = value.score!;
  const T = trend.score!;
  const gap = Math.abs(V - T);
  const gapNote = gap >= COMPOSITE_GAP_NOTE;
  return { status: "ok", score: Math.floor((V + T) / 2 + 0.5), reason: null, text: "두 점수의 평균", gap, gapNote, gapText: gapNote ? gapText(gap) : null };
}

/** 하루 기록에 남길 입력·결과 (재현·확인용 — 봉 자체는 남기지 않고 원값·묶음·항목 점수만) */
function storedOf(r: TrendResult, prev: TrendResult | null, source: string, bench: { code: BenchCode } | null): Record<string, unknown> {
  if (r.status !== "ok") return { status: r.status, reason: r.reason, source, bench: bench?.code ?? null };
  return {
    status: "ok",
    source,
    bench: bench?.code ?? null,
    asOf: r.asOf,
    bars: r.bars,
    daysAveraged: r.daysAveraged,
    coverage: r.coverage,
    scoreToday: r.scoreToday,
    families: Object.fromEntries(FAMILY_KEYS.map((f) => [f, r.families[f].score])),
    subs: r.subs,
    raw: r.raw,
    notes: r.notes,
    prev: prev?.status === "ok" ? { asOf: prev.asOf, score: prev.score } : null,
  };
}
