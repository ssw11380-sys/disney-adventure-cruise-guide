import cron, { type ScheduledTask } from "node-cron";
import {
  buildKrReference,
  compactKrFacts,
  krAux,
  krAvailable,
  krCandidates,
  krCrossCheck,
  krDue,
  krExclusion,
  krInputs,
  krLiteMetrics,
  KR_FINANCIAL_UPJONG,
  KR_MIN_FILL,
  KR_NIGHT_CAP,
  KR_QUARTER_LAG_DAYS,
  KR_REIT_GROUP,
  KR_SOURCE,
  mergeKrFacts,
  monthEndOf,
  type KrFacts,
  type KrMember,
} from "../analysis/krValue.js";
import { addDays, daysBetween } from "../analysis/secFacts.js";
import { FISCAL_STALE_DAYS, PeerBook, roundScore, scoreValue, valueBand, valueFlags, VALUE_VERSION, type ValuePath, type ValueReferenceData } from "../analysis/valueScore.js";
import type { Db } from "../db/index.js";
import type { Candle } from "../domain/types.js";
import { isKrCode, normalizeCode } from "../lib/codes.js";
import { seoulIso } from "../lib/time.js";
import { parseNaverFinance, parseNaverIntegration, type NaverFinanceClient } from "../providers/market/naverFinance.js";
import type { NaverDiscover } from "../providers/market/naverDiscover.js";
import type { FeatureService } from "./featureService.js";
import { valueAboutOf } from "./indicatorScoreText.js";
import { REFERENCE_REBUILD_DAYS, REFERENCE_STALE_DAYS, referenceDrop } from "./valueReference.js";
import {
  baseBlock,
  closeGap,
  familyRow,
  finKindOf,
  flagRows,
  FACTS_CARRY_MS,
  FACTS_REFRESH_MS,
  lossStreak,
  priceNoteOf,
  sharesMismatch,
  weeklyValueChange,
  type Core,
  type RowExtra,
  type ValueBlock,
  type ValueEval,
  type ValueEvalArgs,
} from "./valueScoreService.js";
import {
  carriedBadge,
  carriedText,
  fiscalShort,
  krCauseQuarter,
  krDatesLine,
  krFewQuartersText,
  krFirstFillText,
  KR_LITE_NOTE,
  KR_QUARTER_GAP_TEXT,
  krPeerLine,
  krVersionLine,
  LITE_BADGE,
  lowCoverageText,
  PARTIAL_BADGE,
  peerFallbackText,
  preferredText,
  THIN_EQUITY_DEBT,
  thinEquityText,
  valueChangeText,
  valueHeadline,
  VALUE_BAND_LINE,
  VALUE_STATUS_TEXT,
} from "./valueScoreText.js";
import { readValueTextFlags, VALUE_TEXT_OFF, type ValueTextFlags } from "./valueTextFlags.js";

/**
 * 한국 간이 가치 지표 (3-44 3단계, 플래그 indicatorScores + valueScore + krValueScore). 설계 S4 · 가치지표-계산.md 18장.
 *  - 재무: 네이버 증권 재무 요약(연간 3개 결산 · 분기 5개, 실적 열만)을 줄여 value_fundamentals 에 저장 (cik 칸 'naver' — 미국 행과 같은 표, 새 표 없음)
 *  - 비교 회사: 네이버 업종 구성 종목(주 1회 — 시가총액·업종, 약 130~150번 요청) 가운데 보통주, 시가총액 하위 20% 를 뺀 것.
 *    재무는 분기에 한 번 돌아가며 받는다 — 새 분기 실적이 나올 때(분기 끝 + 45일)가 된 회사·120일 넘은 회사만, 밤마다 700종목까지(02:30 KST).
 *    첫 채우기(약 2,000종목)는 며칠 밤에 나눠지고, 후보의 60% 이상이 모이기 전에는 '비교할 한국 회사 재무를 처음 모으는 중'
 *  - 비교 기준: 일요일 05:00 KST (구성 종목 새로 받기 + 저장한 재무로 분포) → value_references market 'KR'. 없거나 7일 넘으면 밤 배치 뒤·켤 때 다시
 *  - 대상 종목(등록·화면에서 연 종목): 20시간 넘게 묵었으면 백그라운드로 다시 받는다 (화면 요청은 네이버를 기다리지 않는다). 받을 때 네이버가 보이는
 *    PER·PBR 과 같은 가격으로 견주어 20% 넘게 다르면 경고 기록 (설계 B9)
 *  - 점수 식·묶음 비중·띠·종합 규칙은 미국과 같고, 등급만 lite(배지 '간이 계산'). 한국 종목은 한국 회사끼리만 비교한다 (설계 B8)
 *  - 플래그 krValueScore 를 끄면 한국 가치 줄은 '지금 계산하지 않음'이고 네이버 재무·업종 요청 0건
 * DART 키가 생기면(지금은 없음) KrValueSources.finance 를 DART 전체 재무로 바꿔 끼우고 등급을 full 로 올릴 수 있다 — 저장·비교 기준·화면은 그대로
 */

export interface KrValueSources {
  /**
   * 연간·분기(+ summary 면 요약 지표) 원본 (네이버). 없는 종목이면 null, 받기 실패는 오류. 요약 지표(교차 점검·업종 번호)는 대상 종목(화면·등록)만 —
   * 밤 배치의 비교 회사는 두 번만 (첫 채우기 요청을 3분의 2로)
   */
  finance(code: string, opts?: { summary?: boolean }): Promise<{ annual: unknown; quarter: unknown; integration: unknown | null } | null>;
  /** 업종 구성 종목 전체 (주 1회) */
  members(): Promise<KrMember[]>;
}

export function defaultKrValueSources(client: NaverFinanceClient, discover: NaverDiscover): KrValueSources {
  return { finance: (code, opts) => client.finance(code, opts), members: () => discover.krUpjongMembers() };
}

export interface KrValueDeps {
  db: Db;
  features: Pick<FeatureService, "enabled">;
  sources: KrValueSources | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
  /** 테스트: 백그라운드 받기 사이 쉼 */
  pauseMs?: number;
  /** 밤마다 받는 종목 수 상한 (기본 700) */
  nightCap?: number;
  /** 구성 종목 보통주가 이보다 적으면 목록 모양이 바뀐 것으로 보고 저장하지 않는다 (기본 1,000 — 2026-09 실측 2,765) */
  minMembers?: number;
}

/** 업종 구성 종목 저장 (meta) — [코드, 이름, 시장, 종류, 현재가, 시가총액(원), 업종, 업종 번호] */
const MEMBERS_KEY = "krValueMembers";
type MemberRow = [string, string, string, string, number | null, number | null, string, string];
/** 구성 종목을 다시 받는 간격 (밤 배치가 쓰는 목록 — 일요일 새벽에 새로) */
const MEMBERS_MAX_DAYS = 8;
const PRICE_STALE_DAYS = 8;
const AVG_DAYS = 20;
const FAIL_BACKOFF_MS = 30 * 60_000;
const NOT_FOUND_BACKOFF_MS = 24 * 3_600_000;
export const KR_REFERENCE_KICK_MS = 30 * 60_000;
/** 등록하지 않은 한국 종목 재무를 지우는 기준: 후보 목록에서 빠졌고(상장 폐지·시가총액 하위) 30일 넘게 새로 받지 않음 */
const PRUNE_DAYS = 30;
const FILL_MEMO_MS = 10 * 60_000;

interface LoadedKr {
  code: string;
  fetchedAt: string;
  facts: KrFacts;
}

const pct1 = (v: number) => Math.round(v * 10) / 10;

export class KrValueService {
  private readonly now: () => Date;
  private readonly factsCache = new Map<string, LoadedKr>();
  private readonly refBooks = new Map<string, PeerBook>();
  private readonly failures = new Map<string, { at: number; kind: "notFound" | "failed" }>();
  private readonly queue = new Set<string>();
  private worker: Promise<void> | null = null;
  private active: string | null = null;
  private building: Promise<unknown> | null = null;
  private kicked: Promise<unknown> | null = null;
  private lastKick = Number.NEGATIVE_INFINITY;
  private night: Promise<unknown> | null = null;
  private tasks: ScheduledTask[] = [];
  private startTimer: NodeJS.Timeout | null = null;
  private fillMemo: { at: number; value: { candidates: number; withFacts: number; ratio: number } } | null = null;
  /** 마지막 비교 기준 만들기 (filling = 비교 회사 재무가 아직 모자라 만들지 않음 — 실패 아님) */
  lastBuild: { at: string; ok: boolean; filling?: boolean; refDate?: string; error?: string; counts?: ValueReferenceData["counts"] } | null = null;
  lastNight: { at: string; due: number; fetched: number; failed: number; notFound: number; built: string | null } | null = null;

  constructor(private readonly deps: KrValueDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private reitMemo: { at: number; codes: Set<string> } | null = null;
  /**
   * 종목 마스터의 리츠 코드 (listed_stocks.group_code 'RT' — 한국투자증권 종목 정보의 공식 분류, 1시간 기억). 마스터가 비었거나 읽지 못하면 빈 집합 —
   * 그때는 네이버 업종 280(부동산) 안의 '리츠' 이름으로 가린다 (krIsReit). 운영 서버는 토스 Open API 마스터(ETF 가 아니면 모두 'ST')라 늘 빈 집합이다
   */
  async reitCodes(): Promise<Set<string>> {
    const t = this.now().getTime();
    if (this.reitMemo && t - this.reitMemo.at < 3_600_000) return this.reitMemo.codes;
    const rows = await this.deps.db
      .selectFrom("listed_stocks")
      .select("code")
      .where("group_code", "=", KR_REIT_GROUP)
      .execute()
      .catch(() => [] as Array<{ code: string }>);
    const codes = new Set(rows.map((r) => r.code));
    this.reitMemo = { at: t, codes };
    return codes;
  }

  /** 세 플래그(indicatorScores · valueScore · krValueScore)와 출처가 있어야 */
  async enabled(): Promise<boolean> {
    if (!this.deps.sources) return false;
    const f = this.deps.features;
    return (await f.enabled("indicatorScores")) && (await f.enabled("valueScore")) && (await f.enabled("krValueScore"));
  }

  private today(): string {
    return seoulIso(this.now()).slice(0, 10);
  }

  // ── 재무 요약 받기 ───────────────────────────────────────

  /**
   * 한 종목 받아 저장 (연간·분기 + summary 면 요약 지표). 요약 지표를 받았으면 네이버가 보이는 PER·PBR 과 견주어 20% 넘게 다르면 경고 기록.
   * 요약 지표를 받지 않은 때(밤 배치)는 전에 받아 둔 요약 지표를 그대로 둔다
   */
  async refreshFacts(code: string, opts: { summary?: boolean } = {}): Promise<"ok" | "notFound" | "failed"> {
    const src = this.deps.sources;
    if (!src) return "failed";
    const c = normalizeCode(code);
    const summary = opts.summary !== false;
    try {
      const got = await src.finance(c, { summary });
      const old = await this.loadFacts(c).catch(() => null);
      const integ = got?.integration ? parseNaverIntegration(got.integration) : null;
      // 네이버 표에서 빠진 앞 결산·분기는 전에 저장한 것을 이어 둔다 (새 결산이 실적 열로 바뀌는 1~3월에 성장 묶음이 빠지지 않게)
      const made = got ? compactKrFacts(c, parseNaverFinance(got.annual, "annual"), parseNaverFinance(got.quarter, "quarter"), integ) : null;
      const merged = made ? mergeKrFacts(made, old?.facts) : null;
      const facts = merged && !integ && old?.facts.i ? { ...merged, i: old.facts.i } : merged;
      if (!facts) {
        this.failures.set(c, { at: this.now().getTime(), kind: "notFound" });
        return "notFound";
      }
      const check = integ ? krCrossCheck(facts) : { warnings: [] as string[], per: null, pbr: null };
      if (check.warnings.length) this.deps.log?.warn({ code: c, per: check.per, pbr: check.pbr }, `가치 지표(한국): 네이버가 보이는 PER·PBR 과 20% 넘게 다름 — ${check.warnings.join(" · ")}`);
      const at = seoulIso(this.now());
      const data = JSON.stringify(facts);
      const last = facts.q.at(-1)?.[0] ?? facts.a.at(-1)?.[0] ?? null;
      await this.deps.db
        .insertInto("value_fundamentals")
        .values({ code: c, cik: KR_SOURCE, sic: null, last_filed: last, fetched_at: at, data, created_at: at, updated_at: at })
        .onConflict((oc) => oc.column("code").doUpdateSet({ cik: KR_SOURCE, sic: null, last_filed: last, fetched_at: at, data, updated_at: at }))
        .execute();
      this.factsCache.set(c, { code: c, fetchedAt: at, facts });
      this.failures.delete(c);
      this.fillMemo = null;
      return "ok";
    } catch (e) {
      this.failures.set(c, { at: this.now().getTime(), kind: "failed" });
      this.deps.log?.warn({ code: c, err: e instanceof Error ? e.message : String(e) }, "가치 지표(한국): 재무 요약 받기 실패");
      return "failed";
    }
  }

  private async loadFacts(code: string): Promise<LoadedKr | null> {
    const c = normalizeCode(code);
    const row = await this.deps.db.selectFrom("value_fundamentals").select(["fetched_at", "cik"]).where("code", "=", c).executeTakeFirst();
    if (!row || row.cik !== KR_SOURCE) return null;
    const hit = this.factsCache.get(c);
    if (hit && hit.fetchedAt === row.fetched_at) return hit;
    const d = await this.deps.db.selectFrom("value_fundamentals").select("data").where("code", "=", c).executeTakeFirst();
    if (!d) return null;
    let facts: KrFacts;
    try {
      facts = JSON.parse(d.data) as KrFacts;
    } catch {
      return null;
    }
    if (facts.kind !== "kr") return null;
    const loaded = { code: c, fetchedAt: row.fetched_at, facts };
    this.factsCache.set(c, loaded);
    while (this.factsCache.size > 60) this.factsCache.delete(this.factsCache.keys().next().value!);
    return loaded;
  }

  /** 저장한 한국 재무 전부 (비교 기준 · 밤 배치) */
  private async allFacts(): Promise<Map<string, { fetchedAt: string; facts: KrFacts }>> {
    const rows = await this.deps.db.selectFrom("value_fundamentals").select(["code", "fetched_at", "data"]).where("cik", "=", KR_SOURCE).execute();
    const out = new Map<string, { fetchedAt: string; facts: KrFacts }>();
    for (const r of rows) {
      try {
        const f = JSON.parse(r.data) as KrFacts;
        if (f.kind === "kr") out.set(r.code, { fetchedAt: r.fetched_at, facts: f });
      } catch {
        // 깨진 줄은 다음에 다시 받는다
      }
    }
    return out;
  }

  /** 백그라운드 받기 (한 번에 하나). 받기를 걸었거나 받는 중이면 true (실패 뒤 쉬는 중이면 false) */
  requestRefresh(code: string): boolean {
    const c = normalizeCode(code);
    if (this.inFlight(c)) return true;
    const fail = this.failures.get(c);
    const t = this.now().getTime();
    if (fail && t - fail.at < (fail.kind === "notFound" ? NOT_FOUND_BACKOFF_MS : FAIL_BACKOFF_MS)) return false;
    this.queue.add(c);
    if (!this.worker) this.worker = this.drain().finally(() => (this.worker = null));
    return true;
  }

  private inFlight(code: string): boolean {
    return this.queue.has(code) || this.active === code;
  }

  private async drain(): Promise<void> {
    const pause = this.deps.pauseMs ?? 500;
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

  /** 테스트·관리용: 백그라운드 받기·비교 기준 만들기가 끝날 때까지 */
  async idle(): Promise<void> {
    while (this.worker || this.kicked || this.night) {
      await this.worker;
      await this.kicked;
      await this.night;
    }
  }

  /** 장 마감 뒤(한국 20:10) 계산 직전: 20시간 넘게 묵었으면 다시 받는다 */
  async refreshIfStale(code: string): Promise<void> {
    if (!(await this.enabled())) return;
    const f = await this.loadFacts(code);
    if (f && this.now().getTime() - Date.parse(f.fetchedAt) < FACTS_REFRESH_MS) return;
    const fail = this.failures.get(normalizeCode(code));
    if (fail?.kind === "notFound" && this.now().getTime() - fail.at < NOT_FOUND_BACKOFF_MS) return;
    await this.refreshFacts(code);
  }

  // ── 업종 구성 종목 (주 1회) ─────────────────────────────────

  /** 저장한 구성 종목 (maxAgeDays 보다 오래되었으면 새로 받는다 — 받지 못하면 저장한 것 그대로, 없으면 null) */
  async members(maxAgeDays = MEMBERS_MAX_DAYS): Promise<{ date: string; rows: KrMember[] } | null> {
    const snap = await this.readMembers();
    if (snap && daysBetween(snap.date, this.today()) <= maxAgeDays) return snap;
    try {
      return { date: this.today(), rows: await this.refreshMembers() };
    } catch (e) {
      this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, "가치 지표(한국): 업종 구성 종목 받기 실패 (저장한 목록을 씀)");
      return snap;
    }
  }

  private async readMembers(): Promise<{ date: string; rows: KrMember[] } | null> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", MEMBERS_KEY).executeTakeFirst();
    if (!row) return null;
    try {
      const j = JSON.parse(row.value) as { date: string; rows: MemberRow[] };
      return { date: j.date, rows: j.rows.map(([code, name, market, endType, price, marketCap, upjong, upjongCode]) => ({ code, name, market, endType, price, marketCap, upjong, upjongCode })) };
    } catch {
      return null;
    }
  }

  /** 업종 구성 종목 새로 받기 (약 130~150번 요청). 너무 적으면(목록 모양이 바뀜) 저장하지 않고 오류 */
  async refreshMembers(): Promise<KrMember[]> {
    const rows = await this.deps.sources!.members();
    const common = rows.filter((m) => m.endType === "stock").length;
    if (common < (this.deps.minMembers ?? 1000)) throw new Error(`업종 구성 종목이 너무 적습니다: 보통주 ${common}`);
    const value = JSON.stringify({ date: this.today(), rows: rows.map((m): MemberRow => [m.code, m.name, m.market, m.endType, m.price, m.marketCap, m.upjong, m.upjongCode]) });
    await this.deps.db.insertInto("meta").values({ key: MEMBERS_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    this.fillMemo = null;
    this.deps.log?.info({ rows: rows.length, common }, "가치 지표(한국): 업종 구성 종목 받음");
    return rows;
  }

  /** 첫 채우기 진행: 후보(보통주, 시가총액 하위 20% 뺌) 가운데 재무를 받아 둔 비율 (10분 기억) */
  async fillStatus(): Promise<{ candidates: number; withFacts: number; ratio: number }> {
    const t = this.now().getTime();
    if (this.fillMemo && t - this.fillMemo.at < FILL_MEMO_MS) return this.fillMemo.value;
    const snap = await this.readMembers();
    const cands = snap ? krCandidates(snap.rows, await this.reitCodes()) : [];
    const have = new Set((await this.deps.db.selectFrom("value_fundamentals").select("code").where("cik", "=", KR_SOURCE).execute()).map((r) => r.code));
    const withFacts = cands.filter((m) => have.has(m.code)).length;
    const value = { candidates: cands.length, withFacts, ratio: cands.length ? withFacts / cands.length : 0 };
    this.fillMemo = { at: t, value };
    return value;
  }

  // ── 밤 배치: 재무 돌려 받기 (분기에 한 번 — 공시가 났을 때) ─────────────

  /**
   * 밤 배치 (02:30 KST): 후보 + 등록 한국 종목 가운데 받을 때가 된 종목(krDue — 받은 적 없음 · 새 분기 · 사업보고서 · 120일)을
   * 우선순위·시가총액 큰 순으로 cap 개까지 받는다. 끝나면 비교 기준이 없거나 7일 넘었고 재무가 60% 넘게 모였으면 만든다
   */
  async nightly(opts: { cap?: number; registered?: readonly string[] } = {}): Promise<{ due: number; fetched: number; failed: number; notFound: number; built: string | null; skipped?: string }> {
    const empty = (skipped: string) => ({ due: 0, fetched: 0, failed: 0, notFound: 0, built: null, skipped });
    if (!(await this.enabled())) return empty("off");
    if (this.night) return empty("running");
    const run = (async () => {
      const snap = await this.members();
      if (!snap) return empty("noMembers");
      const today = this.today();
      const cands = krCandidates(snap.rows, await this.reitCodes());
      const capOf = new Map(cands.map((m) => [m.code, m.marketCap ?? 0]));
      const codes = [...new Set([...(opts.registered ?? []).filter(isKrCode).map(normalizeCode), ...cands.map((m) => m.code)])];
      const stored = await this.allFacts();
      const due = codes
        .map((code) => {
          const s = stored.get(code);
          const d = krDue(s ? { lastQuarter: s.facts.q.at(-1)?.[0] ?? null, annualEnd: s.facts.a.at(-1)?.[0] ?? null, fetchedAt: s.fetchedAt } : null, today);
          return { code, ...d };
        })
        .filter((d) => d.due && !this.backingOff(d.code))
        .sort((a, b) => a.priority - b.priority || (capOf.get(b.code) ?? Infinity) - (capOf.get(a.code) ?? Infinity));
      const take = due.slice(0, opts.cap ?? this.deps.nightCap ?? KR_NIGHT_CAP);
      let fetched = 0;
      let failed = 0;
      let notFound = 0;
      for (const [i, d] of take.entries()) {
        if (i % 50 === 49 && !(await this.enabled())) break; // 도중에 끄면 멈춘다
        const r = await this.refreshFacts(d.code, { summary: false });
        if (r === "ok") fetched++;
        else if (r === "notFound") notFound++;
        else failed++;
      }
      let built: string | null = null;
      const cur = await this.reference();
      if (!cur || daysBetween(cur.refDate, today) >= REFERENCE_REBUILD_DAYS) built = await this.buildReference();
      const out = { due: due.length, fetched, failed, notFound, built };
      this.lastNight = { at: seoulIso(this.now()), ...out };
      this.deps.log?.info({ ...out, cap: take.length }, "가치 지표(한국): 밤 재무 받기");
      return out;
    })();
    this.night = run;
    try {
      return await run;
    } finally {
      this.night = null;
    }
  }

  private backingOff(code: string): boolean {
    const f = this.failures.get(code);
    if (!f) return false;
    return this.now().getTime() - f.at < (f.kind === "notFound" ? NOT_FOUND_BACKOFF_MS : FAIL_BACKOFF_MS);
  }

  // ── 비교 기준 (주 1회, 일요일 새벽) ─────────────────────────────

  async reference(asOf?: string): Promise<PeerBook | null> {
    let q = this.deps.db.selectFrom("value_references").select(["ref_date"]).where("market", "=", "KR");
    if (asOf) q = q.where("ref_date", "<=", asOf);
    const row = await q.orderBy("ref_date", "desc").limit(1).executeTakeFirst();
    if (!row) return null;
    const hit = this.refBooks.get(row.ref_date);
    if (hit) return hit;
    const data = await this.deps.db.selectFrom("value_references").select("data").where("market", "=", "KR").where("ref_date", "=", row.ref_date).executeTakeFirst();
    if (!data) return null;
    const book = new PeerBook(JSON.parse(data.data) as ValueReferenceData);
    this.refBooks.set(row.ref_date, book);
    while (this.refBooks.size > 3) this.refBooks.delete(this.refBooks.keys().next().value!);
    return book;
  }

  async saveReference(data: ValueReferenceData): Promise<void> {
    const at = seoulIso(this.now());
    const json = JSON.stringify(data);
    await this.deps.db
      .insertInto("value_references")
      .values({ market: "KR", ref_date: data.refDate, method: data.method, data: json, created_at: at })
      .onConflict((oc) => oc.columns(["market", "ref_date"]).doUpdateSet({ method: data.method, data: json, created_at: at }))
      .execute();
    this.refBooks.delete(data.refDate);
    const old = await this.deps.db.selectFrom("value_references").select("ref_date").where("market", "=", "KR").orderBy("ref_date", "desc").offset(3).limit(100).execute();
    if (old.length) await this.deps.db.deleteFrom("value_references").where("market", "=", "KR").where("ref_date", "in", old.map((r) => r.ref_date)).execute();
  }

  /**
   * 비교 기준 만들기. force(일요일 새벽): 구성 종목을 새로 받고 만든다. 아니면 7일 안 기준이 있으면 그대로.
   * 비교 회사 재무가 후보의 60% 에 못 미치면 만들지 않는다('filling' — 첫 채우기 중). 지난 기준보다 크게 줄면(미국과 같은 규칙) 저장하지 않는다
   */
  async buildReference(opts: { force?: boolean } = {}): Promise<"built" | "fresh" | "off" | "failed" | "filling"> {
    if (!(await this.enabled())) return "off";
    if (this.building) {
      await this.building.catch(() => undefined);
      return "fresh";
    }
    const today = this.today();
    if (!opts.force) {
      const cur = await this.reference();
      if (cur && daysBetween(cur.refDate, today) < REFERENCE_REBUILD_DAYS) return "fresh";
    }
    const run = (async () => {
      const at = seoulIso(this.now());
      try {
        const snap = opts.force ? await this.refreshMembers().then((rows) => ({ date: today, rows })).catch(() => this.members(30)) : await this.members();
        if (!snap) throw new Error("업종 구성 종목을 받지 못했습니다");
        const stored = await this.allFacts();
        const facts = new Map([...stored].map(([k, v]) => [k, v.facts]));
        const prev = await this.reference(addDays(today, -1)).catch(() => null);
        const data = buildKrReference(snap.rows, facts, today, prev?.ref ?? null, await this.reitCodes());
        const fill = data.counts.mapped ? data.counts.withData / data.counts.mapped : 0;
        if (fill < KR_MIN_FILL) {
          this.lastBuild = { at, ok: false, filling: true, counts: data.counts };
          this.deps.log?.info({ ...data.counts, fill: pct1(100 * fill) }, "가치 지표(한국): 비교 회사 재무를 모으는 중이라 비교 기준을 아직 만들지 않음");
          return "filling" as const;
        }
        const drop = referenceDrop(prev?.ref ?? null, data);
        if (drop) throw new Error(drop);
        await this.saveReference(data);
        this.lastBuild = { at, ok: true, refDate: data.refDate, counts: data.counts };
        this.deps.log?.info({ refDate: data.refDate, ...data.counts }, "가치 지표(한국): 비교 기준 만듦");
        return "built" as const;
      } catch (e) {
        this.lastBuild = { at, ok: false, error: e instanceof Error ? e.message : String(e) };
        this.deps.log?.warn({ err: this.lastBuild.error }, "가치 지표(한국): 비교 기준 만들기 실패 (지난 기준을 그대로 씀)");
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

  referenceInProgress(): boolean {
    return this.building !== null || this.kicked !== null;
  }

  /** 화면 요청이 비교 기준 만들기를 건다 (없거나 2주 넘게 묵었을 때, 재무가 60% 넘게 모였을 때만 — 30분에 한 번까지) */
  private kickReference(): boolean {
    if (this.referenceInProgress()) return true;
    const t = this.now().getTime();
    if (t - this.lastKick < KR_REFERENCE_KICK_MS) return false;
    this.lastKick = t;
    const run: Promise<unknown> = this.buildReference()
      .catch(() => "failed")
      .finally(() => {
        if (this.kicked === run) this.kicked = null;
      });
    this.kicked = run;
    return true;
  }

  /** 오래된 한국 재무 정리: 후보·등록 종목이 아니고(상장 폐지·시가총액 하위로 빠짐) 30일 넘게 새로 받지 않은 줄 */
  async prune(registered: readonly string[]): Promise<number> {
    const snap = await this.readMembers();
    if (!snap) return 0;
    const keep = new Set([...krCandidates(snap.rows, await this.reitCodes()).map((m) => m.code), ...registered.map(normalizeCode)]);
    const cut = seoulIso(new Date(this.now().getTime() - PRUNE_DAYS * 86_400_000));
    const old = (await this.deps.db.selectFrom("value_fundamentals").select("code").where("cik", "=", KR_SOURCE).where("fetched_at", "<", cut).execute()).map((r) => r.code).filter((c) => !keep.has(c));
    if (!old.length) return 0;
    await this.deps.db.deleteFrom("value_fundamentals").where("code", "in", old).execute();
    for (const c of old) this.factsCache.delete(c);
    this.deps.log?.info({ removed: old.length }, "가치 지표(한국): 후보에서 빠진 종목 재무 정리");
    return old.length;
  }

  /** 켤 때: 등록 한국 종목 가운데 재무가 없거나 20시간 넘게 묵은 종목을 백그라운드로 받는다 */
  async warm(codes: readonly string[]): Promise<void> {
    if (!(await this.enabled())) return;
    for (const c of codes) {
      if (!isKrCode(c)) continue;
      const f = await this.loadFacts(c);
      if (!f || this.now().getTime() - Date.parse(f.fetchedAt) >= FACTS_REFRESH_MS) this.requestRefresh(c);
    }
  }

  start(registered: () => Promise<string[]>): void {
    this.stop();
    // 밤 02:30 KST: 재무 돌려 받기 (분기에 한 번 — 공시가 난 회사만, 첫 채우기는 며칠 밤에 나눠)
    this.tasks.push(
      cron.schedule("30 2 * * *", () => void (async () => this.nightly({ registered: await registered().catch(() => []) }))().catch(() => undefined), { timezone: "Asia/Seoul", name: "kr-value-nightly" }),
    );
    // 일요일 05:00 KST: 업종 구성 종목(시가총액) 새로 받고 비교 기준 → 후보에서 빠진 종목 재무 정리
    this.tasks.push(
      cron.schedule(
        "0 5 * * 0",
        () =>
          void (async () => {
            await this.buildReference({ force: true }).catch(() => undefined);
            const reg = (await this.enabled()) ? await registered().catch(() => null) : null;
            if (reg) await this.prune(reg).catch(() => 0);
          })(),
        { timezone: "Asia/Seoul", name: "kr-value-reference-weekly" },
      ),
    );
    // 켤 때(2분 30초 뒤): 등록 한국 종목 재무를 받아 두고, 구성 종목이 없으면 받고, 비교 기준이 없거나 묵었으면 (재무가 모였으면) 만든다
    this.startTimer = setTimeout(() => {
      void (async () => {
        await this.warm(await registered().catch(() => [])).catch(() => undefined);
        if (!(await this.enabled())) return;
        await this.members().catch(() => null);
        await this.buildReference().catch(() => undefined);
      })();
    }, 150_000);
    this.startTimer.unref?.();
  }

  stop(): void {
    for (const t of this.tasks) void t.destroy();
    this.tasks = [];
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  // ── 점수 ─────────────────────────────────────────────

  /** 한국 가치 줄. 네트워크(네이버) 없이 저장한 값만 읽는다 — 없으면 백그라운드로 받기를 걸고 '계산 준비 중' */
  async evaluate(a: ValueEvalArgs): Promise<ValueEval> {
    const code = normalizeCode(a.code);
    const plain = (block: ValueBlock, extra: Partial<ValueEval> = {}): ValueEval => ({ block, stored: null, fetchFailure: false, waiting: false, ...extra });
    const about = valueAboutOf("general", "KR");
    const block = (status: ValueBlock["status"], label: string, code2: string, text: string) => baseBlock(status, label, { code: code2, text }, about);
    const p = a.product;
    // 가치 점수 개선 1단계 글 플래그 (모두 글만 — 점수는 그대로)
    const tf = await readValueTextFlags(this.deps.features);
    // 저장한 재무 (네트워크 없음) — 리츠 판정의 네이버 업종 번호도 여기서 (마스터 분류를 모를 때만 씀)
    const facts = await this.loadFacts(code);
    // 리츠는 공식 분류로 (긴급 고침 — 이름 속 '리츠' 글자로 메리츠금융지주가 빠지던 것). 마스터 분류는 'RT' 일 때만 증거 — 토스 마스터의 'ST' 는 건너뛰고 네이버 업종·이름으로
    const hint = { reitCodes: await this.reitCodes(), groupCode: a.groupCode ?? null, upjongCode: facts?.facts.i?.industryCode ?? null };
    const ex = krExclusion(code, a.name, hint) ?? (p?.spac ? "spac" : p?.commonShare === false ? "preferred" : null);
    if (ex === "preferred" && tf.reasonDetail) return plain(block("excluded", "대상 아님", ex, preferredText(await this.commonScored(code, a))));
    if (ex) return plain(block("excluded", "대상 아님", ex, VALUE_STATUS_TEXT[ex]));
    if (p?.clearance) return plain(block("excluded", "대상 아님", "clearance", VALUE_STATUS_TEXT.clearance));

    const ref = await this.reference();
    const refOld = !!ref && daysBetween(ref.refDate, a.scoreDate) > REFERENCE_STALE_DAYS;
    const t = this.now().getTime();
    const fail = this.failures.get(code);
    if (!facts) {
      if (fail?.kind === "notFound" && t - fail.at < NOT_FOUND_BACKOFF_MS) return plain(block("insufficient", "점수 없음", "notListed", VALUE_STATUS_TEXT.krNotFound));
      if (fail?.kind === "failed" && t - fail.at < FAIL_BACKOFF_MS) return plain(block("unavailable", "점수 없음", "factsFailed", VALUE_STATUS_TEXT.factsFailed), { fetchFailure: true });
      if (!this.requestRefresh(code)) return plain(block("unavailable", "점수 없음", "factsFailed", VALUE_STATUS_TEXT.factsFailed), { fetchFailure: true });
      return plain(block("pending", "계산 준비 중", "pendingFacts", VALUE_STATUS_TEXT.krPendingFacts), { waiting: true });
    }
    const age = t - Date.parse(facts.fetchedAt);
    const failedSince = !!fail && fail.at > Date.parse(facts.fetchedAt);
    if (age >= FACTS_REFRESH_MS) this.requestRefresh(code);
    const refreshing = this.inFlight(code);

    if (!ref || refOld) {
      const fill = await this.fillStatus();
      if (fill.ratio >= KR_MIN_FILL) this.kickReference();
      if (this.referenceInProgress()) return plain(block("pending", "계산 준비 중", "pendingReference", ref ? VALUE_STATUS_TEXT.rebuildingReference : VALUE_STATUS_TEXT.pendingReference), { waiting: true });
      if (ref) return plain(block("insufficient", "점수 없음", "referenceOld", VALUE_STATUS_TEXT.referenceOld), { fetchFailure: true });
      // 첫 채우기 중 (밤마다 나눠 받음 — 며칠): 앱이 다시 묻지 않는 끝나는 상태, 서버는 5분만 기억
      if (fill.ratio < KR_MIN_FILL) return plain(block("pending", "계산 준비 중", "krFirstFill", krFirstFillText(Math.floor(100 * fill.ratio))), { fetchFailure: true });
      if (this.lastBuild && !this.lastBuild.ok && !this.lastBuild.filling) return plain(block("unavailable", "점수 없음", "referenceFailed", VALUE_STATUS_TEXT.referenceFailed), { fetchFailure: true });
      return plain(block("pending", "계산 준비 중", "referenceMissing", VALUE_STATUS_TEXT.referenceMissing), { fetchFailure: true });
    }
    if (a.candles === null) return plain(block("unavailable", "점수 없음", "priceFailed", VALUE_STATUS_TEXT.priceFailed), { fetchFailure: true });
    if (a.splitHold) return plain(block("hold", "잠시 보류", "split", VALUE_STATUS_TEXT.hold));

    const cls = this.classify(ref, code, facts.facts);
    const now = this.core(facts.facts, ref, cls, a.candles, a.scoreDate);
    // 주식 분할·병합 뒤 네이버 주당 값이 아직 분할 전이면: 되짚은 주식 수가 목록(시가총액 ÷ 현재가)과 크게 다르다 → 잠시 보류
    if (sharesMismatch(ref.quote(code), now.inputs?.shares ?? null, now.avgPrice)) return plain(block("hold", "잠시 보류", "sharesMismatch", VALUE_STATUS_TEXT.sharesMismatch));
    if (now.status !== "scored") {
      const reason = krReasonOf(now, tf);
      return plain(baseBlock("insufficient", "점수 없음", reason, valueAboutOf(now.path ?? "general", "KR")), { stored: { method: VALUE_VERSION, grade: "lite", status: "insufficient", reason: reason.code, reference: ref.refDate, fetchedAt: facts.fetchedAt } });
    }

    let change: ValueBlock["change"] = null;
    if (now.result!.shown !== null && a.candles.length > AVG_DAYS + 5) {
      const cut = a.candles.slice(0, -5);
      const prevDate = cut.at(-1)!.date;
      const prevRef = (await this.reference(prevDate)) ?? ref;
      const prev = this.core(facts.facts, prevRef, this.classify(prevRef, code, facts.facts), cut, prevDate);
      if (prev.status === "scored" && prev.result!.shown !== null) change = krWeeklyChange(now, prev, ref.refDate, prevRef.refDate);
    }
    const carried = age >= FACTS_CARRY_MS && failedSince;
    const lastBar = a.candles.filter((c) => c.date <= a.scoreDate).at(-1) ?? null;
    const out = krScoredBlock(now, { ref, industry: cls, change, carried, fetchedAt: facts.fetchedAt, code, text: tf, lastClose: lastBar ? { date: lastBar.date, close: lastBar.close } : null });
    return { block: out, stored: krStored(now, ref.refDate, facts.fetchedAt), fetchFailure: false, waiting: refreshing };
  }

  /**
   * 우선주의 같은 회사 보통주 이름 (가치 점수 개선 1단계 [9], 보고서 '점수가 있을 때만'): 보통주 코드(끝 자리 0)를 보통주 화면과 같은 계산
   * (저장한 재무 요약 · 이번 주 비교 기준 · 보통주 일봉 · 주식 수 확인)으로 실제로 점수가 나올 때만 이름, 아니면 null.
   * 예전에는 재무 요약에 EPS·BPS 가 있는지만 봐, 보통주가 '점수 없음'(묶음 부족·가격 기준 문제)·'잠시 보류'여도 '보통주 화면에 점수가 있습니다'가 나갈 수 있었다
   * (검토 지적). 네이버 재무 요청은 하지 않는다 (저장한 값만 — 보통주 일봉만 받는다)
   */
  private async commonScored(code: string, a: ValueEvalArgs): Promise<string | null> {
    const common = `${code.slice(0, 5)}0`;
    if (common === code || !a.candlesOf) return null;
    const f = await this.loadFacts(common).catch(() => null);
    if (!f) return null;
    const ref = await this.reference().catch(() => null);
    if (!ref || daysBetween(ref.refDate, a.scoreDate) > REFERENCE_STALE_DAYS) return null;
    const row = await this.deps.db.selectFrom("listed_stocks").select(["name", "group_code"]).where("code", "=", common).executeTakeFirst().catch(() => undefined);
    const name = row?.name ?? f.facts.i?.name ?? null;
    if (!name) return null;
    if (krExclusion(common, name, { reitCodes: await this.reitCodes(), groupCode: row?.group_code ?? null, upjongCode: f.facts.i?.industryCode ?? null })) return null;
    const candles = await a.candlesOf(common).catch(() => null);
    if (!candles?.length) return null;
    const now = this.core(f.facts, ref, this.classify(ref, common, f.facts), candles, a.scoreDate);
    if (now.status !== "scored" || now.result?.shown === null || now.result?.shown === undefined) return null;
    if (sharesMismatch(ref.quote(common), now.inputs?.shares ?? null, now.avgPrice)) return null;
    return name;
  }

  /** 업종: 이번 주 목록(비교 기준 symbols) → 네이버 요약 지표의 업종 번호 → 모름 */
  private classify(ref: PeerBook, code: string, facts: KrFacts): string | null {
    const hit = ref.classify(code);
    if (hit?.industry) return hit.industry;
    const ic = facts.i?.industryCode;
    return ic ? (ref.ref.industryCodes?.[ic] ?? null) : null;
  }

  /** 한 시점 계산 (순수 — 저장·네트워크 없음) */
  private core(facts: KrFacts, ref: PeerBook, industry: string | null, candles: Candle[], scoreDate: string): Core {
    const last = candles.at(-1);
    if (!last || daysBetween(last.date, scoreDate) > PRICE_STALE_DAYS) return { status: "insufficient", reason: { code: "priceStale", text: VALUE_STATUS_TEXT.priceStale } };
    const closes = candles.slice(-AVG_DAYS).map((c) => c.close).filter((v) => v > 0);
    if (closes.length < 10) return { status: "insufficient", reason: { code: "priceStale", text: VALUE_STATUS_TEXT.priceStale } };
    const avgPrice = closes.reduce((x, y) => x + y, 0) / closes.length;
    const inp = krInputs(facts, scoreDate);
    if (!inp || (inp.ttm.eps === null && inp.bps === null)) return { status: "insufficient", reason: { code: "krNoData", text: VALUE_STATUS_TEXT.krNoData } };
    if (daysBetween(monthEndOf(inp.quarter), scoreDate) > FISCAL_STALE_DAYS) return { status: "insufficient", reason: { code: "fiscalOld", text: VALUE_STATUS_TEXT.krFiscalOld } };
    const financial = !!industry && KR_FINANCIAL_UPJONG.has(industry);
    const path: ValuePath = financial ? "financial" : "general";
    const metrics = krLiteMetrics(inp, avgPrice, financial);
    const result = scoreValue({ grade: "lite", path, sector: null, industry, cik: facts.code, metrics, own: {}, peers: ref });
    const base = { result, metrics, aux: krAux(inp), avgPrice, path, cyclical: false, ownMonths: 0, priceThrough: last.date, quarter: inp.quarter, inputs: { flow: {}, bal: {}, balYearAgo: {}, annual: [], shares: inp.shares, period: null } };
    const kr = { krInputs: inp };
    if (result.status === "insufficient") {
      const r = result.reasons[0]!;
      const text = r.code === "priceInvalid" ? VALUE_STATUS_TEXT.priceInvalid : r.code === "lowCoverage" ? lowCoverageText(r.pct ?? 0) : VALUE_STATUS_TEXT.fewFamilies;
      // 속 까닭 (이유 글 — 플래그 valueReasonDetail 일 때만 씀): 최근 4분기 주당이익을 만들 수 없어 주가 수준이 빠진 것이면, 쓸 수 있는 분기 실적 수
      let detail: string | undefined;
      if (r.code === "priceInvalid" && inp.ttm.eps === null) {
        const qn = facts.q.filter((q) => krAvailable(q[0], KR_QUARTER_LAG_DAYS, scoreDate)).length;
        detail = qn < 4 ? `fewQuarters:${qn}` : "quarterGap";
      }
      return { status: "insufficient", reason: { code: r.code, text }, ...(detail ? { detail } : {}), ...base, ...kr } as Core;
    }
    return { status: "scored", ...base, ...kr } as Core;
  }
}

/** 한국 간이 입력을 Core 에 붙여 둔다 (scoredBlock·기록용) */
type KrCore = Core & { krInputs: NonNullable<ReturnType<typeof krInputs>> };

/** 지난주 대비 (한국): 미국과 같은 규칙, 까닭은 새 분기 실적 → 주가 → 비교 기준 */
export function krWeeklyChange(now: Core, prev: Core, refNow: string, refPrev: string): ValueBlock["change"] {
  const { period: _a, ...n } = now;
  const { period: _b, ...p } = prev;
  const c = weeklyValueChange(n, p, refNow, refPrev);
  if (!c || !now.quarter || !prev.quarter || now.quarter === prev.quarter) return c;
  const cause = krCauseQuarter(now.quarter);
  return { ...c, cause, text: valueChangeText({ from: c.from, diff: c.diff, family: c.family, familyDiff: c.familyDiff, cause }) };
}

/** 점수 없음 이유 (한국, 가치 점수 개선 1단계 [9] valueReasonDetail — 분기 실적 수 · 빈 값, 끄면 예전 글) */
export function krReasonOf(c: Core, t: ValueTextFlags): { code: string; text: string } {
  if (t.reasonDetail && c.detail?.startsWith("fewQuarters:")) return { code: "krFewQuarters", text: krFewQuartersText(Number(c.detail.slice("fewQuarters:".length))) };
  if (t.reasonDetail && c.detail === "quarterGap") return { code: "krQuarterGap", text: KR_QUARTER_GAP_TEXT };
  return c.reason!;
}

function krScoredBlock(
  c: Core,
  o: { ref: PeerBook; industry: string | null; change: ValueBlock["change"]; carried: boolean; fetchedAt: string; code: string; text?: ValueTextFlags; lastClose?: { date: string; close: number } | null },
): ValueBlock {
  const t = o.text ?? VALUE_TEXT_OFF;
  const r = c.result!;
  const inp = (c as KrCore).krInputs;
  const shown = r.shown!;
  const band = valueBand(shown);
  const flagsKeys = valueFlags(r, c.aux!, { cyclical: false, thresholds: o.ref.ref.thresholds, metrics: c.metrics! });
  const core = r.families.find((f) => f.key === "price")?.metrics.find((m) => m.peer && m.score !== null && (r.path === "financial" ? m.key === "A3" : m.key === "A1"));
  const level = core?.peer?.level ?? "market";
  const flags = flagRows(flagsKeys, t, {
    oneOffPct: null,
    lossYears: lossStreak(inp.annual.map((a) => ({ end: a.end, op: a.op }))),
    fallbackText: peerFallbackText(level === "sector" ? "market" : level, null, r.path).replace("시장 전체", "한국 시장 전체").replace("금융사 전체", "한국 금융사 전체"),
    carried: o.carried ? carriedText(o.fetchedAt) : null,
  });
  // [10] 자본이 아주 작은 회사 (부채비율 1,000% 이상, 금융사 제외): PBR·ROE 가 작은 변화에도 크게 바뀐다는 사실 (아시아나항공 5,496%)
  if (t.wordingFacts && r.path !== "financial" && typeof inp.debtRatio === "number" && inp.debtRatio >= THIN_EQUITY_DEBT) {
    const at = flags.findIndex((f) => f.key === "carriedForward");
    flags.splice(at < 0 ? flags.length : at, 0, { key: "thinEquity", text: thinEquityText(inp.debtRatio) });
  }
  const n = o.ref.groupSize(r.path, level, level === "industry" ? o.industry : null, o.code);
  const about = valueAboutOf(r.path, "KR");
  const end = monthEndOf(inp.quarter);
  const notes = [KR_LITE_NOTE, ...(r.status === "partial" ? [`계산에 쓴 묶음 비중 ${r.coverageWeight} (100 중)`] : [])];
  const extra: RowExtra = { unit: "KRW", finKind: r.path === "financial" ? finKindOf(o.industry) : null, groupName: level === "industry" ? o.industry : null };
  // [3] 가격 안내 (20거래일 평균과 마지막 종가 — 한국은 섞기 없음)
  const eps = inp.ttm.eps;
  const perAvg = typeof eps === "number" && eps > 0 && c.avgPrice ? c.avgPrice / eps : null;
  const pbrAvg = typeof inp.bps === "number" && inp.bps > 0 && c.avgPrice ? c.avgPrice / inp.bps : null;
  const close = t.priceNote2 ? closeGap(c.avgPrice, o.lastClose ?? null, perAvg, pbrAvg) : null;
  return {
    ...baseBlock(r.status, `${shown}점 · ${band}`, null, about),
    grade: "lite",
    score: shown,
    scoreExact: r.score,
    band,
    text: `${about}: ${VALUE_BAND_LINE[band]}`,
    badges: [LITE_BADGE, ...(r.status === "partial" ? [PARTIAL_BADGE] : []), ...(o.carried ? [carriedBadge(o.fetchedAt)] : [])],
    headline: valueHeadline(shown, band),
    peerLine: krPeerLine({ level, nameKo: level === "industry" ? o.industry : null, n, path: r.path }),
    datesLine: krDatesLine({ priceThrough: c.priceThrough!, quarter: inp.quarter, reference: o.ref.refDate }),
    priceNote: priceNoteOf(t, { blend: false, close }),
    path: r.path,
    coverageWeight: r.coverageWeight,
    families: r.families.map((f) => familyRow(f, { path: r.path, grade: "lite", annualEnd: inp.fiscalEnd, market: "KR", text: t, extra })),
    flags,
    notes,
    change: o.change,
    asOf: {
      priceThrough: c.priceThrough!,
      fiscalEnd: end,
      filed: null,
      form: null,
      basis: "TTM",
      fiscalLabel: `${inp.quarter.slice(0, 4)}년 ${Number(inp.quarter.slice(5, 7))}월까지 최근 4분기`,
      fiscalShort: fiscalShort(end, "TTM"),
      reference: o.ref.refDate,
      fetchedAt: o.fetchedAt,
    },
    versionLine: krVersionLine(o.ref.refDate),
  };
}

/** 하루 기록에 남길 값 (한국) */
function krStored(c: Core, refDate: string, fetchedAt: string): Record<string, unknown> {
  const r = c.result!;
  const inp = (c as KrCore).krInputs;
  return {
    method: VALUE_VERSION,
    grade: "lite",
    status: r.status,
    path: r.path,
    score: r.score,
    priceThrough: c.priceThrough,
    avgPrice: c.avgPrice,
    quarter: inp.quarter,
    fiscalEnd: inp.fiscalEnd,
    ttm: inp.ttm,
    bps: inp.bps,
    shares: inp.shares,
    reference: refDate,
    fetchedAt,
    families: Object.fromEntries(r.families.map((f) => [f.key, f.score === null ? null : roundScore(f.score)])),
    metrics: Object.fromEntries(r.families.flatMap((f) => f.metrics.map((m) => [m.key, { x: Number.isFinite(m.x ?? NaN) ? m.x : m.x === null ? null : String(m.x), score: m.score, rule: m.rule ?? null, level: m.peer?.level ?? null, pos: m.pos }]))),
  };
}
