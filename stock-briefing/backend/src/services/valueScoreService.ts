import cron, { type ScheduledTask } from "node-cron";
import type { ProductFacts } from "../analysis/leveraged.js";
import { compactCompanyFacts, FactBook, mergeCompanyFacts, PREDECESSOR_CIK, type CompactFacts, type PeriodInfo, type ValueInputs } from "../analysis/secFacts.js";
import { computeAux, computeMetrics, type MetricAux, type MetricKey, type MetricSet, type MetricValue } from "../analysis/valueMetrics.js";
import {
  coreOf,
  FAMILY_METRICS,
  FISCAL_STALE_DAYS,
  isCyclical,
  isFinancial,
  OWN_MONTHS,
  PeerBook,
  REIT_INDUSTRY,
  roundScore,
  scoreValue,
  SPAC_INDUSTRY,
  VALUE_CHANGE_MIN,
  VALUE_FAMILIES,
  VALUE_VERSION,
  VALUE_WEIGHTS,
  valueBand,
  valueFlags,
  type CompareKey,
  type FamilyScore,
  type MetricScore,
  type ValueBand,
  type ValueFamilyKey,
  type ValueFlagKey,
  type ValueGrade,
  type ValuePath,
  type ValueReferenceData,
  type ValueScoreResult,
} from "../analysis/valueScore.js";
import type { Db } from "../db/index.js";
import type { Candle } from "../domain/types.js";
import { isKrCode, normalizeCode } from "../lib/codes.js";
import { seoulIso } from "../lib/time.js";
import type { FeatureService } from "./featureService.js";
import { STATUS_TEXT, VALUE_ABOUT, valueAboutOf } from "./indicatorScoreText.js";
import { addDays, daysBetween } from "../analysis/secFacts.js";
import { buildReferenceData, parseFrame, REFERENCE_REBUILD_DAYS, REFERENCE_STALE_DAYS, referenceDrop, type ReferenceSources } from "./valueReference.js";
import type { EdgarProvider } from "../providers/dart/edgar.js";
import type { NasdaqScreener } from "../providers/market/nasdaqScreener.js";
import { NotListedError } from "../lib/errors.js";
import { KR_SOURCE } from "../analysis/krValue.js";
import type { KrValueService } from "./krValueService.js";
import {
  BLEND_NOTE,
  carriedBadge,
  carriedText,
  causeFiling,
  causePrice,
  causeReference,
  fiscalLabel,
  fiscalShort,
  formatMetric,
  industryKo,
  annualBasis,
  levelName,
  lowCoverageText,
  medianText,
  metricName,
  metricMeaning,
  mixText,
  NO_DATA,
  NOT_ADOPTED,
  PARTIAL_BADGE,
  peerFallbackText,
  peerLine,
  PEER_TIMING_NOTE,
  positionSentence,
  positionText,
  PRICE_NOTE,
  RULE_TEXT,
  sectorKo,
  TIE_NOTE,
  tieSentence,
  topTieNote,
  VALUE_BAND_LINE,
  familyAbout,
  VALUE_FAMILY_NAME,
  VALUE_FLAG_TEXT,
  VALUE_STATUS_TEXT,
  valueChangeText,
  valueDatesLine,
  valueHeadline,
  valueVersionLine,
  type NameMarket,
} from "./valueScoreText.js";

/**
 * 가치 지표 점수 (3-44 2단계, 플래그 indicatorScores + valueScore). 미국 보통주 — 한국 보통주는 3단계 간이 계산(krValueService), ETF·스팩·우선주·리츠는 '대상 아님'.
 *  - 재무: SEC companyfacts 를 줄여 value_fundamentals 에 저장. 등록 종목은 장 마감 뒤(뉴욕 17:30, 추세 계산 직전)에 20시간 넘게 묵었으면 다시 받고,
 *    미등록 종목은 처음 열 때 백그라운드로 받는다. 화면 요청은 SEC 를 기다리지 않는다 (저장한 값만 읽음 — 없으면 '계산 준비 중')
 *  - 비교 기준: 주 1회(토요일 09:00 KST) Nasdaq 스크리너 + SEC frames → value_references (최근 3줄). 없거나 7일 넘게 묵으면 매일 09:15 · 켤 때 다시
 *  - 점수: 최근 20거래일 평균 종가 × 최신 희석 주식 수 = 시가총액, 공시일까지의 최근 4분기 재무 → 지표 → 업종·시장·자기 지난 5년 순위 → 5묶음 → 0~100
 *  - 받기 실패: 재무를 받지 못해도 7일까지 지난 값('지난 값 M/D'), 그 뒤 '점수 없음 — 재무제표를 받지 못했습니다'.
 *    재무를 받은 뒤 SEC 목록에서 빠졌으면(notListed) 실패와 같이 세고, 7일 뒤 '점수 없음 — SEC 재무제표를 찾지 못했습니다'로 끝난다.
 *    받은 지 오래됐다는 것만으로는 실패라고 하지 않는다 (미등록 종목은 열 때만 받는다 — 7일 넘게 묵었으면 '재무제표를 새로 받는 중')
 *  - '… 받는 중·만드는 중'(앱이 1분마다 다시 묻는 대기)은 실제로 받는·만드는 중일 때만. 비교 기준이 없거나 2주 넘게 묵었으면 화면 요청이
 *    백그라운드로 만들기를 건다 (30분에 한 번까지 — 플래그를 나중에 켰거나 첫 만들기가 실패한 서버가 다음 날 09:15 까지 기다리지 않게)
 *  - 정리: 등록하지 않은 종목의 재무는 30일 넘게 새로 받지 않았으면(= 30일 넘게 열지 않음) 매일 09:15 에 지운다 (표·백업이 끝없이 커지지 않게)
 *  - 주식 수 확인: SEC 주식 수가 비교 기준(Nasdaq 시가총액 ÷ 가격)과 크게 다르면(마지막 보고서 뒤 분할·병합 등) '잠시 보류'
 *  - 문구는 valueScoreText 의 틀 (금지어 검사 analysis/scoreWording). AI 프롬프트·브리핑·알림·위젯·잔고 목록에는 넣지 않는다
 */

export interface ValueSources {
  /** companyfacts 원본. SEC 목록에 없으면 null (ETF·외국 회사 등) */
  companyFacts(code: string): Promise<{ cik: string; raw: Record<string, unknown> } | null>;
  /** SIC (리츠 6798 · 스팩 6770). 모르면 null */
  sic(cik: string): Promise<number | null>;
  reference: ReferenceSources;
}

export type ValueStatus = "ok" | "partial" | "insufficient" | "unavailable" | "excluded" | "pending" | "hold";

export interface ValueMetricRow {
  key: MetricKey;
  name: string;
  /** 화면 값 ('32.1배', '12.3%', '순현금') */
  value: string | null;
  /** 연간 재무로 계산한 지표의 기준 ('2026년 1월 결산 연간 기준' — 성장·이익 안정성·ROE 안정성·주식 수 변화). 그 밖은 null (최근 4분기·최근 분기말) */
  basis: string | null;
  /** '업종 가운데값 25.0배' */
  peerMedian: string | null;
  /** '업종 안 위치 72/100 · 시장 안 64/100 · 지난 5년 중 31/100' */
  positions: string | null;
  /** 쓴 비교 비중 '업종 50 · 시장 20 · 지난 5년 30' */
  mix: string | null;
  score: number | null;
  /** 이 지표 문장 (위치 문장 · 규칙 문장 · 쓰지 않음) */
  text: string;
  /** 100에 가까울수록 … */
  meaning: string;
  used: boolean;
  /** 계산 방법 안내 (경기 민감 회사의 PER 섞기 등) */
  note: string | null;
}
export interface ValueFamilyRow {
  key: ValueFamilyKey;
  name: string;
  about: string;
  weight: number;
  score: number | null;
  scoreExact: number | null;
  text: string;
  metrics: ValueMetricRow[];
}
export interface ValueBlock {
  method: string;
  /** 계산 등급 — full = 미국(SEC 재무 전체), lite = 한국 간이(네이버 재무 요약, 배지 '간이 계산'). 점수를 냈을 때만, 그 밖은 null */
  grade: ValueGrade | null;
  status: ValueStatus;
  label: string;
  score: number | null;
  scoreExact: number | null;
  band: ValueBand | null;
  about: string;
  /** 요약 카드 설명 줄 (점수가 있으면 뜻, 없으면 이유) */
  text: string;
  reason: { code: string; text: string } | null;
  badges: string[];
  headline: string | null;
  peerLine: string | null;
  datesLine: string | null;
  priceNote: string | null;
  path: ValuePath | null;
  coverageWeight: number | null;
  families: ValueFamilyRow[];
  flags: Array<{ key: ValueFlagKey; text: string }>;
  notes: string[];
  change: { from: string; prev: number; now: number; diff: number; family: ValueFamilyKey; familyName: string; familyDiff: number; cause: string; text: string } | null;
  asOf: { priceThrough: string | null; fiscalEnd: string | null; filed: string | null; form: string | null; basis: "FY" | "TTM" | null; fiscalLabel: string | null; fiscalShort: string | null; reference: string | null; fetchedAt: string | null };
  /** '계산 방식 VALUE-1 · 재무 SEC … · 비교 기준 M월 D일' — 점수를 계산했을 때만 (한국·ETF·점수 없음은 null — SEC 자료로 계산한 것처럼 읽히지 않게) */
  versionLine: string | null;
}

export interface ValueEvalArgs {
  code: string;
  /** ETF·ETN (추세 쪽 판정과 같은 값) */
  etf: boolean;
  product: (ProductFacts & { commonShare?: boolean | null; spac?: boolean | null; clearance?: boolean | null }) | null;
  /** 끝난 정규장 일봉 (기준 거래일까지 자름). 받기 실패면 null */
  candles: Candle[] | null;
  /** 월봉 (자기 지난 5년 비교) — 필요할 때만 부른다 */
  monthly: () => Promise<Candle[] | null>;
  scoreDate: string;
  /** 추세 쪽이 분할·병합을 의심해 보류 중 */
  splitHold: boolean;
  /** 종목 이름 (한국: 스팩·리츠 판정) */
  name?: string;
}
export interface ValueEval {
  block: ValueBlock;
  /** 하루 기록에 남길 입력·결과 (점수를 냈을 때만) */
  stored: Record<string, unknown> | null;
  /** 받기 실패(잠시 뒤 다시) */
  fetchFailure: boolean;
  /** 백그라운드 받기를 기다리는 중 (짧게만 기억) */
  waiting: boolean;
}

export interface ValueScoreDeps {
  db: Db;
  features: Pick<FeatureService, "enabled">;
  sources: ValueSources | null;
  /** 한국 간이 가치 (3단계, 플래그 krValueScore). 없으면 한국은 '지금 계산하지 않음' */
  kr?: KrValueService | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
  /** 테스트: 백그라운드 받기 사이 쉼·비교 기준 frames 사이 쉼 */
  pauseMs?: number;
  referencePauseMs?: number;
}

/** 재무를 다시 받는 간격 (장 마감 뒤 계산 전) */
export const FACTS_REFRESH_MS = 20 * 3_600_000;
/** 이보다 오래 받지 못했으면 '지난 값' 배지 */
export const FACTS_CARRY_MS = 36 * 3_600_000;
/** 이보다 오래 받지 못했으면 점수 없음 */
export const FACTS_STALE_MS = 7 * 86_400_000;
/** 비교 기준: 7일 넘으면 다시 만들고, 14일 넘으면 점수 없음 (새 기준 거절 규칙과 한곳에 — valueReference) */
export { REFERENCE_REBUILD_DAYS, REFERENCE_STALE_DAYS };
/** 주가: 마지막 봉이 기준 거래일보다 이만큼(달력 일) 넘게 앞서면 점수 없음 (5거래일) */
const PRICE_STALE_DAYS = 8;
const AVG_DAYS = 20;
/** 받기 실패를 기억하는 시간 (그동안 다시 받지 않음) */
const FAIL_BACKOFF_MS = 30 * 60_000;
const NOT_LISTED_BACKOFF_MS = 24 * 3_600_000;
/** 비교 기준이 없을 때 화면 요청이 만들기를 거는 간격 (실패가 이어져도 30분에 한 번까지) */
export const REFERENCE_KICK_MS = 30 * 60_000;
/** 등록하지 않은 종목의 재무를 지우는 기준 (이만큼 새로 받지 않았으면 = 이만큼 열지 않았으면) */
export const FACTS_PRUNE_DAYS = 30;
/** 줄여서 저장할 기간 (최근 약 8년) */
const KEEP_YEARS = 8;
/**
 * 주식 수 확인 (마지막 보고서 뒤 분할·병합 등 — 봉은 이미 보정됐는데 SEC 주식 수는 그 전 값인 때):
 *  - SEC 주식 수 ÷ Nasdaq 주식 수(시가총액 ÷ 가격, 비교 기준을 만든 날) < 0.6 (정분할) 또는 > 8 (큰 병합)
 *  - 점수용 시가총액 ÷ Nasdaq 시가총액 < 0.4 (비교 기준을 만든 뒤 생긴 정분할 — 가격이 이만큼 움직이는 일은 드물다)
 * 여러 종류 주식(상장한 종류만 시가총액에 넣는 회사)은 SEC 주식 수가 더 크게 나오므로 '크다' 쪽은 넉넉히 둔다
 */
export const SHARES_RATIO_LOW = 0.6;
export const SHARES_RATIO_HIGH = 8;
export const CAP_RATIO_LOW = 0.4;
export function sharesMismatch(q: { cap: number; price: number } | null, shares: number | null | undefined, avgPrice: number | null | undefined): { shares: number; cap: number } | null {
  if (!q || !shares || !(shares > 0) || !avgPrice || !(avgPrice > 0)) return null;
  const rs = shares / (q.cap / q.price);
  const rc = (avgPrice * shares) / q.cap;
  return rs < SHARES_RATIO_LOW || rs > SHARES_RATIO_HIGH || rc < CAP_RATIO_LOW ? { shares: rs, cap: rc } : null;
}
/** 같은 값이 많은 지표: 비교 회사의 이 비율 이상이 같은 값이면 (무배당 0% 등) */
export const TIE_SHARE = 0.5;

interface LoadedFacts {
  code: string;
  cik: string;
  sic: number | null;
  fetchedAt: string;
  lastFiled: string | null;
  book: FactBook;
}

/** 대상 종목 한 시점의 계산 (지금 · 지난주) — 한국 간이(krValueService)도 같은 모양 */
export interface Core {
  status: "scored" | "insufficient";
  reason?: { code: string; text: string };
  result?: ValueScoreResult;
  metrics?: MetricSet;
  aux?: MetricAux;
  inputs?: ValueInputs;
  period?: PeriodInfo;
  mcap?: number;
  avgPrice?: number;
  path?: ValuePath;
  cyclical?: boolean;
  ownMonths?: number;
  priceThrough?: string;
  /** 한국 간이: 쓴 최근 분기 'YYYY-MM' (지난주 대비 까닭 — 새 분기 실적) */
  quarter?: string;
}

const pct1 = (v: number) => Math.round(v * 10) / 10;

export class ValueScoreService {
  private readonly now: () => Date;
  private readonly factsCache = new Map<string, LoadedFacts>();
  private readonly refBooks = new Map<string, PeerBook>();
  private readonly ownMemo = new Map<string, Partial<Record<MetricKey, Array<number | null>>>>();
  private readonly failures = new Map<string, { at: number; kind: "notListed" | "failed" }>();
  private readonly queue = new Set<string>();
  private worker: Promise<void> | null = null;
  /** 백그라운드 받기에서 지금 받는 종목 */
  private active: string | null = null;
  private building: Promise<unknown> | null = null;
  /** 화면 요청이 건 비교 기준 만들기 (끝나면 null) · 마지막으로 건 때 */
  private kicked: Promise<unknown> | null = null;
  private lastKick = Number.NEGATIVE_INFINITY;
  private tasks: ScheduledTask[] = [];
  private startTimer: NodeJS.Timeout | null = null;
  /** 마지막 비교 기준 만들기 결과 (관리·로그용) */
  lastBuild: { at: string; ok: boolean; refDate?: string; error?: string; counts?: ValueReferenceData["counts"]; missing?: number } | null = null;

  constructor(private readonly deps: ValueScoreDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 한국 간이 가치가 켜져 있는지 (구성·계산 방법 줄) */
  async krEnabled(): Promise<boolean> {
    return !!this.deps.kr && (await this.deps.kr.enabled());
  }

  /** 가치 부분이 켜져 있는지: 두 플래그 + 출처가 있어야 (없으면 1단계 그대로) */
  async enabled(): Promise<boolean> {
    if (!this.deps.sources) return false;
    return (await this.deps.features.enabled("indicatorScores")) && (await this.deps.features.enabled("valueScore"));
  }

  // ── 재무 받기 (SEC, 백그라운드·장 마감 뒤만) ─────────────────────

  /** 재무 한 번 받아 저장. 'ok' | 'notListed' | 'failed' */
  async refreshFacts(code: string): Promise<"ok" | "notListed" | "failed"> {
    const src = this.deps.sources;
    if (!src) return "failed";
    const c = normalizeCode(code);
    try {
      const got = await src.companyFacts(c);
      if (!got) {
        this.failures.set(c, { at: this.now().getTime(), kind: "notListed" });
        return "notListed";
      }
      const since = addDays(seoulIso(this.now()).slice(0, 10), -Math.round(KEEP_YEARS * 365.25));
      const facts = compactCompanyFacts(got.raw, since);
      const sic = await src.sic(got.cik).catch(() => null);
      const at = seoulIso(this.now());
      const data = JSON.stringify(facts);
      await this.deps.db
        .insertInto("value_fundamentals")
        .values({ code: c, cik: got.cik, sic, last_filed: facts.lastFiled, fetched_at: at, data, created_at: at, updated_at: at })
        .onConflict((oc) => oc.column("code").doUpdateSet({ cik: got.cik, sic, last_filed: facts.lastFiled, fetched_at: at, data, updated_at: at }))
        .execute();
      this.factsCache.set(c, { code: c, cik: got.cik, sic, fetchedAt: at, lastFiled: facts.lastFiled, book: new FactBook(facts) });
      this.failures.delete(c);
      return "ok";
    } catch (e) {
      this.failures.set(c, { at: this.now().getTime(), kind: "failed" });
      this.deps.log?.warn({ code: c, err: e instanceof Error ? e.message : String(e) }, "가치 지표: 재무 받기 실패");
      return "failed";
    }
  }

  /** 장 마감 뒤 계산 직전: 저장한 재무가 20시간 넘게 묵었으면 다시 받는다 (플래그·출처가 없으면 아무것도 안 함) */
  async refreshIfStale(code: string): Promise<void> {
    if (isKrCode(code)) {
      if (this.deps.kr && (await this.deps.kr.enabled())) await this.deps.kr.refreshIfStale(code);
      return;
    }
    if (!(await this.enabled())) return;
    const f = await this.loadFacts(code);
    if (f && this.now().getTime() - Date.parse(f.fetchedAt) < FACTS_REFRESH_MS) return;
    const fail = this.failures.get(normalizeCode(code));
    if (fail?.kind === "notListed" && this.now().getTime() - fail.at < NOT_LISTED_BACKOFF_MS) return;
    await this.refreshFacts(code);
  }

  /** 백그라운드 받기 (한 번에 하나, 사이 쉼). 화면 요청은 이것을 기다리지 않는다. 받기를 걸었거나 이미 받는 중이면 true (실패 뒤 쉬는 중이면 false) */
  requestRefresh(code: string): boolean {
    const c = normalizeCode(code);
    if (this.inFlight(c)) return true;
    const fail = this.failures.get(c);
    const t = this.now().getTime();
    if (fail && t - fail.at < (fail.kind === "notListed" ? NOT_LISTED_BACKOFF_MS : FAIL_BACKOFF_MS)) return false;
    this.queue.add(c);
    if (!this.worker) this.worker = this.drain().finally(() => (this.worker = null));
    return true;
  }

  /** 이 종목 재무를 지금 받는 중이거나 받을 차례인지 */
  private inFlight(code: string): boolean {
    return this.queue.has(code) || this.active === code;
  }

  /** 테스트·관리용: 백그라운드 받기와 화면 요청이 건 비교 기준 만들기가 끝날 때까지 */
  async idle(): Promise<void> {
    while (this.worker || this.kicked) {
      await this.worker;
      await this.kicked;
    }
  }

  private async drain(): Promise<void> {
    const pause = this.deps.pauseMs ?? 1_000;
    while (this.queue.size) {
      const c = this.queue.values().next().value as string;
      this.queue.delete(c);
      this.active = c;
      try {
        if (await this.enabled()) await this.refreshFacts(c);
      } finally {
        this.active = null;
      }
      if (this.queue.size && pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
  }

  private async loadFacts(code: string): Promise<LoadedFacts | null> {
    const c = normalizeCode(code);
    const row = await this.deps.db.selectFrom("value_fundamentals").select(["cik", "sic", "fetched_at", "last_filed"]).where("code", "=", c).executeTakeFirst();
    if (!row) return null;
    const hit = this.factsCache.get(c);
    if (hit && hit.fetchedAt === row.fetched_at) return hit;
    const data = await this.deps.db.selectFrom("value_fundamentals").select("data").where("code", "=", c).executeTakeFirst();
    if (!data) return null;
    let facts: CompactFacts;
    try {
      facts = JSON.parse(data.data) as CompactFacts;
    } catch {
      return null;
    }
    const loaded = { code: c, cik: row.cik, sic: row.sic, fetchedAt: row.fetched_at, lastFiled: row.last_filed, book: new FactBook(facts) };
    this.factsCache.set(c, loaded);
    while (this.factsCache.size > 60) this.factsCache.delete(this.factsCache.keys().next().value!);
    return loaded;
  }

  // ── 비교 기준 (주 1회) ────────────────────────────────────

  /** 가장 최근 비교 기준 (asOf 가 있으면 그날 이전에 만든 것 중 가장 최근) */
  async reference(asOf?: string): Promise<PeerBook | null> {
    let q = this.deps.db.selectFrom("value_references").select(["ref_date"]).where("market", "=", "US");
    if (asOf) q = q.where("ref_date", "<=", asOf);
    const row = await q.orderBy("ref_date", "desc").limit(1).executeTakeFirst();
    if (!row) return null;
    const hit = this.refBooks.get(row.ref_date);
    if (hit) return hit;
    const data = await this.deps.db.selectFrom("value_references").select("data").where("market", "=", "US").where("ref_date", "=", row.ref_date).executeTakeFirst();
    if (!data) return null;
    const book = new PeerBook(JSON.parse(data.data) as ValueReferenceData);
    this.refBooks.set(row.ref_date, book);
    while (this.refBooks.size > 3) this.refBooks.delete(this.refBooks.keys().next().value!);
    return book;
  }

  /** 비교 기준 저장 (같은 날이면 덮어씀, 최근 3줄만 남김) */
  async saveReference(data: ValueReferenceData): Promise<void> {
    const at = seoulIso(this.now());
    const json = JSON.stringify(data);
    await this.deps.db
      .insertInto("value_references")
      .values({ market: data.market, ref_date: data.refDate, method: data.method, data: json, created_at: at })
      .onConflict((oc) => oc.columns(["market", "ref_date"]).doUpdateSet({ method: data.method, data: json, created_at: at }))
      .execute();
    this.refBooks.delete(data.refDate);
    const old = await this.deps.db.selectFrom("value_references").select("ref_date").where("market", "=", data.market).orderBy("ref_date", "desc").offset(3).limit(100).execute();
    if (old.length) await this.deps.db.deleteFrom("value_references").where("market", "=", data.market).where("ref_date", "in", old.map((r) => r.ref_date)).execute();
  }

  /** 비교 기준 만들기 (플래그가 꺼져 있으면 아무것도 안 함). 실패하면 지난 기준을 그대로 쓴다 */
  async buildReference(opts: { force?: boolean } = {}): Promise<"built" | "fresh" | "off" | "failed"> {
    if (!(await this.enabled())) return "off";
    if (this.building) {
      await this.building.catch(() => undefined);
      return "fresh";
    }
    const today = seoulIso(this.now()).slice(0, 10);
    if (!opts.force) {
      const cur = await this.deps.db.selectFrom("value_references").select("ref_date").where("market", "=", "US").orderBy("ref_date", "desc").limit(1).executeTakeFirst();
      if (cur && daysBetween(cur.ref_date, today) < REFERENCE_REBUILD_DAYS) return "fresh";
    }
    const run = (async () => {
      const at = seoulIso(this.now());
      try {
        // 지난 기준 (오늘 전에 만든 것): 업종 자리 층을 두 주 연속 조건이 바뀌었을 때만 바꾸고, 회사 수가 크게 줄면 저장하지 않는다
        const prev = await this.reference(addDays(today, -1)).catch(() => null);
        const data = await buildReferenceData(this.deps.sources!.reference, today, {
          pauseMs: this.deps.referencePauseMs ?? 250,
          log: (msg) => this.deps.log?.info({}, `가치 지표: ${msg}`),
          prev: prev?.ref ?? null,
        });
        const drop = referenceDrop(prev?.ref ?? null, data);
        if (drop) throw new Error(drop);
        await this.saveReference(data);
        this.lastBuild = { at, ok: true, refDate: data.refDate, counts: data.counts, missing: data.missingFrames.length };
        this.deps.log?.info({ refDate: data.refDate, ...data.counts, missing: data.missingFrames.length }, "가치 지표: 비교 기준 만듦");
        return "built" as const;
      } catch (e) {
        this.lastBuild = { at, ok: false, error: e instanceof Error ? e.message : String(e) };
        this.deps.log?.warn({ err: this.lastBuild.error }, "가치 지표: 비교 기준 만들기 실패 (지난 기준을 그대로 씀)");
        return "failed" as const;
      }
    })();
    this.building = run;
    try {
      return await run;
    } finally {
      this.building = null;
    }
  }

  /**
   * 화면 요청이 비교 기준 만들기를 건다 (비교 기준이 없거나 2주 넘게 묵었을 때, 백그라운드 — 응답은 기다리지 않음).
   * 이미 만드는 중이면 그대로, 30분 안에 건 적이 있으면 걸지 않는다. 지금 만드는 중이면 true
   */
  private kickReference(): boolean {
    if (this.referenceInProgress()) return true;
    const t = this.now().getTime();
    if (t - this.lastKick < REFERENCE_KICK_MS) return false;
    this.lastKick = t;
    const run: Promise<unknown> = this.buildReference()
      .catch(() => "failed")
      .finally(() => {
        if (this.kicked === run) this.kicked = null;
      });
    this.kicked = run;
    return true;
  }

  /** 비교 기준을 지금 만드는 중인지 (예약·켤 때·화면 요청이 건 것 모두) */
  referenceInProgress(): boolean {
    return this.building !== null || this.kicked !== null;
  }

  /**
   * 등록하지 않은 종목의 재무 정리: 30일 넘게 새로 받지 않은 줄을 지운다. 미등록 종목은 열 때(20시간 넘게 묵었으면) 다시 받으므로
   * 받은 때가 곧 마지막으로 연 때다 — 30일 넘게 열지 않은 종목. 등록 종목은 그대로. 지운 줄 수
   */
  async prune(registered: readonly string[]): Promise<number> {
    const cut = seoulIso(new Date(this.now().getTime() - FACTS_PRUNE_DAYS * 86_400_000));
    const keep = registered.map(normalizeCode);
    // 한국 행(cik 'naver' — 비교 회사 재무)은 한국 서비스가 따로 정리한다 (분기에 한 번 받으므로 30일 규칙이면 비교 회사가 지워진다)
    let q = this.deps.db.selectFrom("value_fundamentals").select("code").where("fetched_at", "<", cut).where("cik", "!=", KR_SOURCE);
    if (keep.length) q = q.where("code", "not in", keep);
    const old = (await q.execute()).map((r) => r.code);
    if (!old.length) return 0;
    await this.deps.db.deleteFrom("value_fundamentals").where("code", "in", old).execute();
    for (const c of old) this.factsCache.delete(c);
    this.deps.log?.info({ removed: old.length }, "가치 지표: 오래 열지 않은 미등록 종목 재무 정리");
    return old.length;
  }

  /** 등록 종목 가운데 재무가 없거나 20시간 넘게 묵은 종목을 백그라운드로 받는다 (켤 때) */
  async warm(codes: readonly string[]): Promise<void> {
    if (!(await this.enabled())) return;
    for (const c of codes) {
      if (isKrCode(c)) continue;
      const f = await this.loadFacts(c);
      if (!f || this.now().getTime() - Date.parse(f.fetchedAt) >= FACTS_REFRESH_MS) this.requestRefresh(c);
    }
  }

  start(registered: () => Promise<string[]>): void {
    this.stop();
    // 한국 간이 가치 (3단계): 밤마다 재무 돌려 받기 · 일요일 새벽 비교 기준 (플래그가 꺼져 있으면 아무것도 하지 않음)
    this.deps.kr?.start(registered);
    // 주 1회: 토요일 09:00 KST (미국 금요일 장 마감 뒤). 매일 09:15 에 7일 넘게 묵었으면 다시 (실패한 주 대비) + 오래 열지 않은 미등록 종목 재무 정리
    this.tasks.push(cron.schedule("0 9 * * 6", () => void this.buildReference({ force: true }).catch(() => undefined), { timezone: "Asia/Seoul", name: "value-reference-weekly" }));
    this.tasks.push(
      cron.schedule(
        "15 9 * * *",
        () =>
          void (async () => {
            await this.buildReference().catch(() => undefined);
            // 등록 목록을 읽지 못하면 지우지 않는다 (등록 종목 재무까지 지우지 않게)
            const reg = (await this.enabled()) ? await registered().catch(() => null) : null;
            if (reg) await this.prune(reg).catch(() => 0);
          })(),
        { timezone: "Asia/Seoul", name: "value-reference-check" },
      ),
    );
    // 켤 때(배포 뒤) 2분 뒤: 비교 기준이 없거나 묵었으면 만들고, 등록 종목 재무를 받아 둔다
    this.startTimer = setTimeout(() => {
      void (async () => {
        await this.warm(await registered().catch(() => [])).catch(() => undefined);
        await this.buildReference().catch(() => undefined);
      })();
    }, 120_000);
    this.startTimer.unref?.();
  }

  stop(): void {
    this.deps.kr?.stop();
    for (const t of this.tasks) void t.destroy();
    this.tasks = [];
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  // ── 점수 ─────────────────────────────────────────────

  /**
   * 가치 부분이 꺼진 서버의 가치 줄 (되돌리기 스위치 valueScore 꺼짐·출처 없음): 1단계와 같은 모양 — ETF 는 '대상 아님', 그 밖은
   * '지금 계산하지 않음 · 가치 지표 점수는 지금 계산하지 않습니다.' (2단계가 나간 뒤라 '다음 단계에서'라고 쓰지 않고, 상태 글도 이유 글과 맞춘다)
   */
  static stage1Block(etf: boolean, text: string = VALUE_STATUS_TEXT.off): ValueBlock {
    return etf ? baseBlock("excluded", "대상 아님", { code: "etf", text: STATUS_TEXT.valueEtf }) : baseBlock("pending", VALUE_STATUS_TEXT.offLabel, { code: "off", text });
  }

  /**
   * 종목 하나의 가치 줄. 네트워크(SEC) 없이 저장한 값만 읽는다 — 없으면 백그라운드로 받기를 걸고 '계산 준비 중'.
   * waiting(앱이 1분마다 다시 묻는 대기)은 실제로 받는·만드는 중일 때만 (쉬는 중이면 끝나는 상태 글)
   */
  async evaluate(a: ValueEvalArgs): Promise<ValueEval> {
    const code = normalizeCode(a.code);
    const plain = (block: ValueBlock, extra: Partial<ValueEval> = {}): ValueEval => ({ block, stored: null, fetchFailure: false, waiting: false, ...extra });
    if (a.etf) return plain(ValueScoreService.stage1Block(true));
    // 한국 (3단계): 간이 계산 서비스가 켜져 있으면 그쪽으로, 아니면 '지금 계산하지 않음' (네이버 재무 요청 0건)
    if (isKrCode(code)) {
      if (this.deps.kr && (await this.deps.kr.enabled())) return this.deps.kr.evaluate(a);
      return plain(baseBlock("pending", VALUE_STATUS_TEXT.offLabel, { code: "krOff", text: VALUE_STATUS_TEXT.krOff }, valueAboutOf("general", "KR")));
    }
    const p = a.product;
    if (p?.spac) return plain(baseBlock("excluded", "대상 아님", { code: "spac", text: VALUE_STATUS_TEXT.spac }));
    if (p?.commonShare === false) return plain(baseBlock("excluded", "대상 아님", { code: "preferred", text: VALUE_STATUS_TEXT.preferred }));
    if (p?.clearance) return plain(baseBlock("excluded", "대상 아님", { code: "clearance", text: VALUE_STATUS_TEXT.clearance }));

    const ref = await this.reference();
    // 비교 기준이 없거나 2주 넘게 묵었으면 백그라운드로 만들기를 건다 (재무 받기와 함께 진행 — 30분에 한 번까지)
    const refOld = !!ref && daysBetween(ref.refDate, a.scoreDate) > REFERENCE_STALE_DAYS;
    if (!ref || refOld) this.kickReference();
    const cls = ref?.classify(code) ?? null;
    if (cls?.industry === REIT_INDUSTRY) return plain(baseBlock("excluded", "대상 아님", { code: "reit", text: VALUE_STATUS_TEXT.reit }));
    if (cls?.industry === SPAC_INDUSTRY) return plain(baseBlock("excluded", "대상 아님", { code: "spac", text: VALUE_STATUS_TEXT.spac }));

    const facts = await this.loadFacts(code);
    const t = this.now().getTime();
    const notListed = baseBlock("insufficient", "점수 없음", { code: "notListed", text: VALUE_STATUS_TEXT.notListed });
    const factsFailed = baseBlock("unavailable", "점수 없음", { code: "factsFailed", text: VALUE_STATUS_TEXT.factsFailed });
    if (!facts) {
      const fail = this.failures.get(code);
      if (fail?.kind === "notListed" && t - fail.at < NOT_LISTED_BACKOFF_MS) return plain(notListed);
      if (fail?.kind === "failed" && t - fail.at < FAIL_BACKOFF_MS) return plain(factsFailed, { fetchFailure: true });
      if (!this.requestRefresh(code)) return plain(factsFailed, { fetchFailure: true });
      return plain(baseBlock("pending", "계산 준비 중", { code: "pendingFacts", text: VALUE_STATUS_TEXT.pendingFacts }), { waiting: true });
    }
    const age = t - Date.parse(facts.fetchedAt);
    // 마지막으로 받은 뒤 실제로 받기에 실패했는지 — 받은 지 오래됐다는 것만으로는 실패가 아니다 (미등록 종목은 열 때만 받는다).
    // 받은 뒤 SEC 목록에서 빠진 것(notListed)도 실패처럼 센다 — '새로 받는 중'이 끝나지 않던 것 (검토 지적)
    const fail = this.failures.get(code);
    const failedSince = !!fail && fail.at > Date.parse(facts.fetchedAt);
    if (age >= FACTS_REFRESH_MS) this.requestRefresh(code);
    const refreshing = this.inFlight(code);
    if (facts.sic === 6798) return plain(baseBlock("excluded", "대상 아님", { code: "reit", text: VALUE_STATUS_TEXT.reit }));
    if (facts.sic === 6770) return plain(baseBlock("excluded", "대상 아님", { code: "spac", text: VALUE_STATUS_TEXT.spac }));
    if (age >= FACTS_STALE_MS) {
      // 받은 뒤 목록에서 빠진 것은 처음부터 없던 것(외국 회사 등)과 까닭 글을 달리한다 (상장 폐지·합병·티커 변경 등, 검토 지적)
      if (failedSince) return fail!.kind === "notListed" ? plain(baseBlock("insufficient", "점수 없음", { code: "notListed", text: VALUE_STATUS_TEXT.notListedAfter })) : plain(factsFailed, { fetchFailure: true });
      // 오랜만에 연 종목: 뒤에서 새로 받는 중 (앱은 1분마다 다시 묻는다). 받는 중이 아니면(쉬는 중) 끝나는 상태로
      if (refreshing) return plain(baseBlock("pending", "계산 준비 중", { code: "pendingRefresh", text: VALUE_STATUS_TEXT.pendingRefresh }), { waiting: true });
      return plain(factsFailed, { fetchFailure: true });
    }
    if (!ref || refOld) {
      // 지금 만드는 중일 때만 '만드는 중'(앱이 1분마다 다시 묻는다). 아니면 끝나는 상태 — 다음에 열 때(30분 뒤부터)·매일 09:15 에 다시 만든다
      if (this.referenceInProgress())
        return plain(baseBlock("pending", "계산 준비 중", { code: "pendingReference", text: ref ? VALUE_STATUS_TEXT.rebuildingReference : VALUE_STATUS_TEXT.pendingReference }), { waiting: true });
      if (ref) return plain(baseBlock("insufficient", "점수 없음", { code: "referenceOld", text: VALUE_STATUS_TEXT.referenceOld }), { fetchFailure: true });
      if (this.lastBuild && !this.lastBuild.ok) return plain(baseBlock("unavailable", "점수 없음", { code: "referenceFailed", text: VALUE_STATUS_TEXT.referenceFailed }), { fetchFailure: true });
      return plain(baseBlock("pending", "계산 준비 중", { code: "referenceMissing", text: VALUE_STATUS_TEXT.referenceMissing }), { fetchFailure: true });
    }
    if (a.candles === null) return plain(baseBlock("unavailable", "점수 없음", { code: "priceFailed", text: VALUE_STATUS_TEXT.priceFailed }), { fetchFailure: true });
    if (a.splitHold) return plain(baseBlock("hold", "잠시 보류", { code: "split", text: VALUE_STATUS_TEXT.hold }));

    const monthly = await a.monthly().catch(() => null);
    const now = this.core(facts, ref, cls, a.candles, monthly, a.scoreDate);
    // 마지막 보고서 뒤 주식 분할·병합 등: SEC 주식 수로 만든 시가총액이 틀리므로 점수를 내지 않는다
    if (sharesMismatch(ref.quote(code), now.inputs?.shares, now.avgPrice)) return plain(baseBlock("hold", "잠시 보류", { code: "sharesMismatch", text: VALUE_STATUS_TEXT.sharesMismatch }));
    if (now.status !== "scored") return plain(baseBlock("insufficient", "점수 없음", now.reason!), { stored: { method: VALUE_VERSION, status: "insufficient", reason: now.reason!.code, reference: ref.refDate, fetchedAt: facts.fetchedAt } });

    // 지난주 (5거래일 전 봉까지 · 그날까지 제출된 재무 · 그날 쓰던 비교 기준)
    let change: ValueBlock["change"] = null;
    if (now.result!.shown !== null && a.candles.length > AVG_DAYS + 5) {
      const cut = a.candles.slice(0, -5);
      const prevDate = cut.at(-1)!.date;
      const prevRef = (await this.reference(prevDate)) ?? ref;
      const prev = this.core(facts, prevRef, prevRef.classify(code), cut, monthly, prevDate);
      if (prev.status === "scored" && prev.result!.shown !== null) change = weeklyValueChange(now, prev, ref.refDate, prevRef.refDate);
    }
    // '지난 값' 배지는 실제로 받기에 실패했을 때만. 받는 중이면 점수는 그대로 보이고 응답만 짧게 기억한다
    const carried = age >= FACTS_CARRY_MS && failedSince;
    const block = scoredBlock(now, { ref, cls, change, carried, fetchedAt: facts.fetchedAt, cik: facts.cik });
    return { block, stored: storedOf(now, ref.refDate, facts), fetchFailure: false, waiting: refreshing };
  }

  /** 한 시점 계산 (순수 — 저장·네트워크 없음) */
  private core(facts: LoadedFacts, ref: PeerBook, cls: { sector: string | null; industry: string | null } | null, candles: Candle[], monthly: Candle[] | null, scoreDate: string): Core {
    const last = candles.at(-1);
    if (!last || daysBetween(last.date, scoreDate) > PRICE_STALE_DAYS) return { status: "insufficient", reason: { code: "priceStale", text: VALUE_STATUS_TEXT.priceStale } };
    const closes = candles.slice(-AVG_DAYS).map((c) => c.close).filter((v) => v > 0);
    if (closes.length < 10) return { status: "insufficient", reason: { code: "priceStale", text: VALUE_STATUS_TEXT.priceStale } };
    const avgPrice = closes.reduce((x, y) => x + y, 0) / closes.length;
    const inputs = facts.book.inputs(scoreDate);
    if (!inputs || !inputs.period) return { status: "insufficient", reason: { code: "noUsGaap", text: VALUE_STATUS_TEXT.noUsGaap } };
    const lastFy = inputs.annual.at(-1)?.end ?? null;
    if (!lastFy || daysBetween(lastFy, scoreDate) > FISCAL_STALE_DAYS) return { status: "insufficient", reason: { code: "fiscalOld", text: VALUE_STATUS_TEXT.fiscalOld } };
    if (!inputs.shares || inputs.shares <= 0) return { status: "insufficient", reason: { code: "priceInvalid", text: VALUE_STATUS_TEXT.priceInvalid } };
    const mcap = avgPrice * inputs.shares;
    const aux = computeAux(inputs);
    const th = ref.ref.thresholds;
    const industry = cls?.industry ?? null;
    const financial = isFinancial(industry, inputs.bal, facts.sic);
    const path: ValuePath = financial ? "financial" : "general";
    const cyclical = !financial && isCyclical(industry, aux.opMarginStd, th);
    const ctx = { financial, cyclical, medianTaxRate: th.taxRateP50, smallEquityCut: th.equityToAssetsP5, medianCoverage: th.coverageP50 };
    const metrics = computeMetrics(inputs, mcap, ctx);
    const own = this.ownHistory(facts, monthly, scoreDate, ctx, path);
    const result = scoreValue({ path, sector: cls?.sector ?? null, industry, cik: facts.cik, metrics, own, peers: ref });
    const ownMonths = Math.max(0, ...Object.values(own).map((xs) => (xs ?? []).filter((v) => v !== null).length));
    if (result.status === "insufficient") {
      const r = result.reasons[0]!;
      const text = r.code === "priceInvalid" ? VALUE_STATUS_TEXT.priceInvalid : r.code === "lowCoverage" ? lowCoverageText(r.pct ?? 0) : VALUE_STATUS_TEXT.fewFamilies;
      return { status: "insufficient", reason: { code: r.code, text }, result, metrics, aux, inputs, period: inputs.period, mcap, avgPrice, path, cyclical, ownMonths, priceThrough: last.date };
    }
    return { status: "scored", result, metrics, aux, inputs, period: inputs.period, mcap, avgPrice, path, cyclical, ownMonths, priceThrough: last.date };
  }

  /**
   * 자기 지난 5년 (주가 수준 지표만): 최근 60개 월말마다 그때 이미 제출된 재무 ÷ 그 월말 시가총액.
   * 한 달 사이 주식 수가 50% 넘게 바뀌었거나(분할·병합) 1년 사이 총자산이 50% 넘게 바뀐(합병·대형 인수) 곳보다 앞은 뺀다
   */
  private ownHistory(facts: LoadedFacts, monthly: Candle[] | null, scoreDate: string, ctx: Parameters<typeof computeMetrics>[2], path: ValuePath): Partial<Record<MetricKey, Array<number | null>>> {
    if (!monthly?.length) return {};
    const month = scoreDate.slice(0, 7);
    const bars = monthly.filter((b) => b.date.slice(0, 7) < month && b.close > 0).slice(-OWN_MONTHS);
    if (!bars.length) return {};
    const key = `${facts.code}|${facts.fetchedAt}|${bars.at(-1)!.date}|${bars.length}|${path}|${ctx.cyclical}|${ctx.medianTaxRate}`;
    const hit = this.ownMemo.get(key);
    if (hit) return hit;
    const keys = FAMILY_METRICS[path].price;
    const pts: Array<{ shares: number; assets: number | null; x: Partial<Record<MetricKey, number | null>> }> = [];
    for (const b of bars) {
      const me = monthEnd(b.date);
      const inp = facts.book.inputs(me);
      if (!inp?.shares) {
        pts.push({ shares: NaN, assets: null, x: {} });
        continue;
      }
      const m = computeMetrics(inp, b.close * inp.shares, ctx);
      pts.push({ shares: inp.shares, assets: inp.bal.assets ?? null, x: Object.fromEntries(keys.map((k) => [k, m[k]?.x ?? null])) });
    }
    // 끊는 곳: 최신부터 거슬러 가며 주식 수가 한 달에 50% 넘게, 총자산이 12개월에 50% 넘게 바뀐 달
    let start = 0;
    for (let i = pts.length - 1; i > 0; i--) {
      const a = pts[i]!;
      const b = pts[i - 1]!;
      if (!Number.isFinite(b.shares)) {
        start = i;
        break;
      }
      const r = a.shares / b.shares;
      if (r > 1.5 || r < 1 / 1.5) {
        start = i;
        break;
      }
      const yearAgo = pts[i - 12];
      if (i - 12 >= 0 && yearAgo && a.assets && yearAgo.assets && (a.assets / yearAgo.assets > 1.5 || a.assets / yearAgo.assets < 1 / 1.5)) {
        start = i - 11;
        break;
      }
    }
    const kept = pts.slice(start);
    const out: Partial<Record<MetricKey, Array<number | null>>> = {};
    for (const k of keys) out[k] = kept.map((p) => p.x[k] ?? null);
    this.ownMemo.set(key, out);
    while (this.ownMemo.size > 200) this.ownMemo.delete(this.ownMemo.keys().next().value!);
    return out;
  }
}

/** 월봉 날짜 → 그달 말일 */
function monthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function baseBlock(status: ValueStatus, label: string, reason: { code: string; text: string } | null, about: string = VALUE_ABOUT): ValueBlock {
  return {
    method: VALUE_VERSION,
    grade: null,
    status,
    label,
    score: null,
    scoreExact: null,
    band: null,
    about,
    text: reason?.text ?? about,
    reason,
    badges: [],
    headline: null,
    peerLine: null,
    datesLine: null,
    priceNote: null,
    path: null,
    coverageWeight: null,
    families: [],
    flags: [],
    notes: [],
    change: null,
    asOf: { priceThrough: null, fiscalEnd: null, filed: null, form: null, basis: null, fiscalLabel: null, fiscalShort: null, reference: null, fetchedAt: null },
    versionLine: null,
  };
}

/**
 * 같은 값이 많은 지표인지: 업종 자리 비교 회사의 절반 이상이 한 값이고(무배당 0% 등) 이 회사 값은 그 값과 다름 —
 * 위치가 그 덩어리에 크게 좌우되어 '많은 편·적은 편' 문장이 실제보다 크게 읽힌다 (규칙 값 — 적자·순현금 덩어리 — 은 뺀다: 그 순위는 규칙대로)
 */
function tieDriven(m: MetricScore): boolean {
  return !m.rule && m.x !== null && !!m.peer && m.peer.tie >= TIE_SHARE && m.peer.tieX !== null && Number.isFinite(m.peer.tieX) && m.x !== m.peer.tieX;
}

/** 지표 한 줄의 화면 값 (규칙은 이름으로) */
function metricValueText(m: MetricScore): string | null {
  if (m.rule === "topTie") return m.key === "D2" ? "순현금" : m.key === "D3" ? "이자 없음" : m.key === "A2" ? "순현금이 시가총액보다 큼" : null;
  if (m.rule === "zeroLoss") {
    if (m.key === "A1") return "적자";
    if (m.key === "A2" || m.key === "D2" || m.key === "D3") return "영업적자";
    if (m.key === "D1") return "자본잠식";
    if (m.key === "B5") return "영업손실이 매출보다 큰 해가 많음";
  }
  if (m.rule === "notComputed") return null;
  return formatMetric(m.key, m.show);
}

/** 지표 줄을 만들 때 필요한 것: 경로(금융사면 '시장' 대신 '금융사 전체'), 연간 재무 기준(가장 최근 회계연도 끝) */
export interface RowCtx {
  path: ValuePath;
  /** 계산 등급 (lite = 한국 간이 — 성장 지표 이름이 '2년') */
  grade?: ValueGrade;
  /** 연간 이력의 가장 최근 회계연도 끝 — 연간 재무로 계산한 지표의 기준 글 ('2026년 1월 결산 연간 기준') */
  annualEnd: string | null;
  /** 비교 시장 (KR 이면 위치·가운데값·비중 글의 무리 이름이 '한국 시장'·'한국 금융사 전체' — 없으면 미국) */
  market?: NameMarket;
}
/** 연간 재무로 계산한 지표 (최근 4분기 값이 아님): 성장 3년 · 이익·ROE 안정성 5년 · 주식 수 변화 3년 */
export const ANNUAL_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>(["C1", "C2", "C3", "B5", "F2", "E2"]);

/** 지표 한 줄의 문장: 쓰지 않음 · 규칙 · 같은 값 덩어리(중립 문장) · 위치 문장 */
function metricSentence(m: MetricScore, grade?: ValueGrade): string {
  if (!m.adopted) return NOT_ADOPTED;
  if (m.rule && m.why) return RULE_TEXT[m.why];
  if (m.score === null || m.x === null) return NO_DATA;
  // 같은 값이 많아 위치가 부풀려진 지표: '많은 편·적은 편' 대신 중립 문장 (검토 지적 — NVDA 배당 0.1% '많은 편')
  if (tieDriven(m)) return tieSentence(Math.round(100 * m.peer!.tie), medianText(m.key, m.peer!.tieX) ?? "", m.score >= 50);
  return positionSentence(m.key, m.score, grade);
}

export function metricRow(m: MetricScore, ctx: RowCtx = { path: "general", annualEnd: null }): ValueMetricRow {
  const level = m.peer?.level ?? null;
  const lname = levelName(level, ctx.path, ctx.market);
  const median = m.peer ? medianText(m.key, m.peer.median) : null;
  const positions = m.score !== null && m.rule !== "zeroLoss" ? positionText(m.pos, level, ctx.path, ctx.market) || null : null;
  const notes: Array<string | null> = [m.blend && m.adopted ? BLEND_NOTE : null];
  if (m.adopted && m.score !== null && tieDriven(m)) notes.push(TIE_NOTE);
  // 맨 위 규칙(순현금 등): 같은 규칙 회사끼리 같은 순위라 보이는 위치는 그 무리의 가운데 — 그 무리 비율을 보이는 위치에서 되짚어 적는다
  if (m.adopted && m.rule === "topTie" && m.pos.industry !== undefined && m.pos.industry < 99.5) {
    const pos = Math.floor(m.pos.industry + 0.5);
    notes.push(topTieNote(lname, Math.round(2 * (100 - m.pos.industry)), pos));
  }
  return {
    key: m.key,
    name: metricName(m.key, ctx.grade),
    value: m.adopted ? metricValueText(m) : null,
    basis: m.adopted && m.score !== null && ANNUAL_METRICS.has(m.key) && ctx.annualEnd ? annualBasis(ctx.annualEnd) : null,
    peerMedian: median && m.score !== null ? `${lname} 가운데값 ${median}` : null,
    positions,
    mix: m.score !== null ? mixText(m.mix, level, ctx.path, ctx.market) : null,
    score: m.score === null ? null : roundScore(m.score),
    text: metricSentence(m, ctx.grade),
    meaning: metricMeaning(m.key, ctx.grade),
    used: m.adopted && m.score !== null,
    note: notes.filter(Boolean).join(" ") || null,
  };
}

export function familyRow(f: FamilyScore, ctx: RowCtx = { path: "general", annualEnd: null }): ValueFamilyRow {
  const present = f.metrics.filter((m) => m.adopted && m.score !== null);
  let text: string;
  if (!f.valid) text = f.why === "noCore" ? "핵심 지표 값이 없어 이 묶음은 빠졌습니다." : "값이 있는 지표가 절반보다 적어 이 묶음은 빠졌습니다.";
  else {
    // 머리 문장: 가운데(50)에서 가장 먼 지표 — 같은 값이 많아 위치가 부풀려진 지표(무배당 0% 사이의 0.1% 등)는 되도록 고르지 않는다
    const pool = present.filter((m) => !tieDriven(m));
    const top = [...(pool.length ? pool : present)].sort((a, b) => Math.abs(b.score! - 50) - Math.abs(a.score! - 50))[0]!;
    text = `${metricName(top.key, ctx.grade)} — ${metricSentence(top, ctx.grade)}`;
  }
  return {
    key: f.key,
    name: VALUE_FAMILY_NAME[f.key],
    about: familyAbout(f.key, ctx.grade),
    weight: f.weight,
    score: f.score === null ? null : roundScore(f.score),
    scoreExact: f.score,
    text,
    metrics: f.metrics.map((m) => metricRow(m, ctx)),
  };
}

function scoredBlock(c: Core, o: { ref: PeerBook; cls: { sector: string | null; industry: string | null } | null; change: ValueBlock["change"]; carried: boolean; fetchedAt: string; cik: string | null }): ValueBlock {
  const r = c.result!;
  const shown = r.shown!;
  const band = valueBand(shown);
  const period = c.period!;
  const flagsKeys = valueFlags(r, c.aux!, { cyclical: c.cyclical!, thresholds: o.ref.ref.thresholds, metrics: c.metrics! });
  const flags: ValueBlock["flags"] = [];
  const core = r.families.find((f) => f.key === "price")?.metrics.find((m) => m.peer && coreOf(r.grade, r.path).price.includes(m.key) && m.score !== null);
  for (const k of flagsKeys) {
    if (k === "peerFallback") flags.push({ key: k, text: peerFallbackText(core?.peer?.level ?? "market", sectorKo(o.cls?.sector ?? null), r.path) });
    else if (k !== "carriedForward") flags.push({ key: k, text: VALUE_FLAG_TEXT[k] });
  }
  if (o.carried) flags.push({ key: "carriedForward", text: carriedText(o.fetchedAt) });
  const level = core?.peer?.level ?? "market";
  const groupName = level === "industry" ? (o.cls?.industry ?? null) : level === "sector" ? (o.cls?.sector ?? null) : null;
  // 비교한 회사 수 (대상 종목 자신은 빼고 — 검토 지적)
  const n = o.ref.groupSize(r.path, level, groupName, o.cik);
  const ownUsed = r.families.find((f) => f.key === "price")!.metrics.some((m) => m.pos.own !== undefined);
  const badges = [...(r.status === "partial" ? [PARTIAL_BADGE] : []), ...(o.carried ? [carriedBadge(o.fetchedAt)] : [])];
  const notes: string[] = [];
  if (period.basis === "TTM") notes.push(PEER_TIMING_NOTE);
  if (r.status === "partial") notes.push(`계산에 쓴 묶음 비중 ${r.coverageWeight} (100 중)`);
  const rowCtx: RowCtx = { path: r.path, annualEnd: c.inputs?.annual.at(-1)?.end ?? null };
  return {
    // 요약 줄 글: 예전 앱(1단계)은 점수 칸을 모르고 label 만 굵게 보이므로 숫자까지 넣는다 ('66점 · 가운데쯤'). 새 앱은 score·band 를 쓴다
    ...baseBlock(r.status, `${shown}점 · ${band}`, null),
    grade: "full",
    score: shown,
    scoreExact: r.score,
    band,
    about: valueAboutOf(r.path),
    text: `${valueAboutOf(r.path)}: ${VALUE_BAND_LINE[band]}`,
    badges,
    headline: valueHeadline(shown, band),
    peerLine: peerLine({ level, nameKo: level === "industry" ? industryKo(groupName) : level === "sector" ? sectorKo(groupName) : null, n, own: ownUsed, path: r.path }),
    datesLine: valueDatesLine({ priceThrough: c.priceThrough!, fiscalEnd: period.end, basis: period.basis, filed: period.filed, reference: o.ref.refDate }),
    priceNote: PRICE_NOTE,
    path: r.path,
    coverageWeight: r.coverageWeight,
    families: r.families.map((f) => familyRow(f, rowCtx)),
    flags,
    notes,
    change: o.change,
    asOf: {
      priceThrough: c.priceThrough!,
      fiscalEnd: period.end,
      filed: period.filed,
      form: period.form,
      basis: period.basis,
      fiscalLabel: fiscalLabel(period.end, period.basis),
      fiscalShort: fiscalShort(period.end, period.basis),
      reference: o.ref.refDate,
      fetchedAt: o.fetchedAt,
    },
    versionLine: valueVersionLine(o.ref.refDate),
  };
}

/** 지난주 대비 (화면 정수 차이가 5점 넘을 때만): 같은 쪽으로 움직인 묶음 가운데 비중 × 변화가 가장 큰 것 + 까닭 */
export function weeklyValueChange(now: Core, prev: Core, refNow: string, refPrev: string): ValueBlock["change"] {
  const a = now.result!;
  const b = prev.result!;
  const diff = a.shown! - b.shown!;
  if (Math.abs(diff) <= VALUE_CHANGE_MIN) return null;
  const pick = (sameWay: boolean): ValueFamilyKey | null => {
    let best: ValueFamilyKey | null = null;
    let bestV = -1;
    for (const f of VALUE_FAMILIES) {
      const x = a.families.find((q) => q.key === f)?.score;
      const y = b.families.find((q) => q.key === f)?.score;
      if (x === null || x === undefined || y === null || y === undefined) continue;
      const d = VALUE_WEIGHTS[a.path][f] * (x - y);
      if (sameWay && Math.sign(d) !== Math.sign(diff)) continue;
      if (Math.abs(d) > bestV) {
        bestV = Math.abs(d);
        best = f;
      }
    }
    return best;
  };
  const fam = pick(true) ?? pick(false);
  if (!fam) return null;
  const fx = a.families.find((q) => q.key === fam)!.score!;
  const fy = b.families.find((q) => q.key === fam)!.score!;
  const familyDiff = roundScore(fx) - roundScore(fy);
  const pricePct = now.avgPrice && prev.avgPrice ? (100 * (now.avgPrice - prev.avgPrice)) / prev.avgPrice : 0;
  const cause =
    now.period && prev.period && now.period.filed !== prev.period.filed
      ? causeFiling(now.period.form, now.period.filed)
      : fam === "price" && Math.abs(pricePct) >= 3
        ? causePrice(pct1(pricePct))
        : refNow !== refPrev
          ? causeReference(refNow)
          : causePrice(pct1(pricePct));
  return {
    from: prev.priceThrough!,
    prev: b.shown!,
    now: a.shown!,
    diff,
    family: fam,
    familyName: VALUE_FAMILY_NAME[fam],
    familyDiff,
    cause,
    text: valueChangeText({ from: prev.priceThrough!, diff, family: fam, familyDiff, cause }),
  };
}

/** 하루 기록에 남길 값 (재현·확인용) */
function storedOf(c: Core, refDate: string, facts: LoadedFacts): Record<string, unknown> {
  const r = c.result!;
  return {
    method: VALUE_VERSION,
    status: r.status,
    path: r.path,
    score: r.score,
    priceThrough: c.priceThrough,
    avgPrice: c.avgPrice,
    shares: c.inputs?.shares ?? null,
    mcap: c.mcap,
    period: c.period,
    reference: refDate,
    fetchedAt: facts.fetchedAt,
    cyclical: c.cyclical,
    ownMonths: c.ownMonths,
    families: Object.fromEntries(r.families.map((f) => [f.key, f.score])),
    metrics: Object.fromEntries(
      r.families.flatMap((f) => f.metrics.map((m) => [m.key, { x: Number.isFinite(m.x ?? NaN) ? m.x : m.x === null ? null : String(m.x), score: m.score, rule: m.rule ?? null, level: m.peer?.level ?? null, pos: m.pos }])),
    ),
  };
}

/** 실제 출처: SEC(EdgarProvider — 연락처 있는 User-Agent·요청 간격) + Nasdaq 스크리너 */
export function defaultValueSources(edgar: EdgarProvider, screener: NasdaqScreener): ValueSources {
  return {
    companyFacts: async (code) => {
      let got: { cik: string; raw: Record<string, unknown> };
      try {
        got = await edgar.companyFactsRaw(code);
      } catch (e) {
        if (e instanceof NotListedError) return null;
        throw e;
      }
      // 지주회사 전환으로 CIK 가 바뀐 회사(XOM 2026): 예전 CIK 의 재무를 이어 붙인다 (새 CIK 에는 전환 뒤 보고서만 있어 연간 이력이 비었다)
      const old = PREDECESSOR_CIK[got.cik];
      if (old) got = { cik: got.cik, raw: mergeCompanyFacts(got.raw, await edgar.companyFactsRawByCik(old)) };
      return got;
    },
    sic: async (cik) => (await edgar.sicOf(cik)).sic,
    reference: {
      screener: () => screener.rows(),
      tickers: () => edgar.tickerMap(),
      frame: async (tag, period) => parseFrame(await edgar.frameRaw(tag.name, tag.unit, period)),
    },
  };
}

export type { MetricValue, CompareKey };
