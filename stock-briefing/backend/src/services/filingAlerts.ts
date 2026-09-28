import type { Selectable } from "kysely";
import { productKindOf } from "../analysis/leveraged.js";
import type { Db } from "../db/index.js";
import type { SecFilingTable } from "../db/schema.js";
import { isKrCode } from "../lib/codes.js";
import { NotListedError } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import { FilingShapeError, filingUrl, isoSec, parseRecentFilings, type SecFilingRow } from "../providers/dart/edgarFilings.js";
import { filingDetail, filingTitle } from "./filingTitles.js";

/**
 * 3-38 새 공시 알림 (플래그 filingAlerts) — SEC EDGAR 확인 작업.
 *  - 대상: 보유(수량 > 0) 미국 종목 중 ETF·ETN 이 아니고 SEC 티커 목록에 있는 것 (같은 CIK 는 한 번 — GOOG·GOOGL, 이름은 등록 순 첫 종목)
 *  - 5분마다(미국 동부 평일 06:00~22:59 — SEC 가 공시를 받는 시간, app.ts cron) CIK 마다 차례로 submissions 를 받아(EdgarProvider 의 gate — 요청 사이 160ms)
 *    알림 서식 줄만 표 sec_filings 에 넣는다 (cik·접수 번호마다 한 줄, 이미 있으면 그대로)
 *  - 기준 잡기(알림 폭탄 막기): 처음 보는 CIK(새로 산 종목·기능을 처음 켬)의 첫 확인에서 넣는 줄은 모두 baseline 1(알리지 않음, 화면에는 보임).
 *    그 뒤 새 줄도 접수 시각이 24시간보다 오래됐으면 baseline 1 (서버가 오래 멈췄거나 팔았다 다시 산 종목의 밀린 공시를 한꺼번에 알리지 않게)
 *  - 한 번 도는 전체 한도 90초 (넘으면 남은 CIK 는 다음 번), 이미 도는 중이면 건너뜀, 플래그가 꺼져 있으면 SEC 호출 0
 *  - 보관: 하루 첫 번째 돌기에서 제출일 90일 넘은 줄을 지운다
 * 표·확인 작업은 공용(SEC 공개 자료), 경로(/api/filings/alerts·/api/schedule)는 그 사람 보유 종목으로 거른다 (routes/filings.ts)
 */

/** 받은 공시 보관 일수 (제출일 기준) */
export const FILING_KEEP_DAYS = 90;
/** 접수 뒤 이 시간이 지난 공시는 알리지 않는다 (서버·앱 같은 규칙) */
export const ALERT_MAX_AGE_MS = 24 * 3_600_000;
/** 한 번 도는 전체 한도 */
export const SWEEP_BUDGET_MS = 90_000;
/** SEC 접수 시간 중 마지막으로 모두 받은 뒤 이만큼 지나면 '멈춤' */
export const STALE_AFTER_MS = 30 * 60_000;
/** 화면의 '새 공시' 칩: 서버가 처음 본 뒤 이 시간 안 */
export const NEW_FOR_MS = 24 * 3_600_000;
/** SEC 티커 목록을 받지 못했을 때 다시 묻기까지 (위젯 요청마다 큰 목록을 다시 받지 않게) */
const RESOLVE_RETRY_MS = 10 * 60_000;
/** 찾은 CIK 를 다시 찾아보기까지 (티커 목록은 EdgarProvider 가 하루 캐시) */
const CIK_TTL_MS = 24 * 3_600_000;
/** SEC 목록에 없는 종목을 다시 찾아보기까지 */
const NOT_LISTED_TTL_MS = 24 * 3_600_000;
/**
 * 화면·위젯 요청이 CIK 를 찾느라 기다리는 최대 시간 (티커 목록 약 800KB 를 처음 받거나 하루 만에 다시 받을 때). 넘으면 그 종목은 이번엔 '모름'으로 두고
 * 받기는 뒤에서 끝나 다음 요청부터 쓴다 — 위젯 응답(앱 제한 12초)이 SEC 를 기다리지 않게. 확인 작업(sweep)은 기다린다
 */
export const REQUEST_RESOLVE_BUDGET_MS = 2_000;
/** 아직 확인하지 않은 종목을 화면이 열릴 때 뒤에서 한 번 받는 최소 간격 */
const PENDING_KICK_MS = 10 * 60_000;
/** 한 번에 넣는 줄 수 (SQLite 변수 한도 아래로) */
const INSERT_CHUNK = 50;

export interface FilingHolding {
  code: string;
  name: string;
  /** 종목 마스터 분류 (ST·EF·EN). 모르면 null */
  groupCode?: string | null;
}

/** SEC 받기 (EdgarProvider — 같은 User-Agent·요청 간격) */
export interface FilingSource {
  /** 티커 → CIK 10자리. SEC 목록에 없으면 NotListedError */
  resolveCik(code: string): Promise<{ cik: string }>;
  /** submissions JSON 원본 한 번 */
  submissionsJson(cik: string): Promise<unknown>;
}

export interface FilingLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info?(obj: Record<string, unknown>, msg: string): void;
}

export interface FilingWatchDeps {
  db: Db;
  features: { enabled(k: "filingAlerts"): Promise<boolean> };
  source: FilingSource;
  /** 보유 종목 (수량 > 0, 등록 순) */
  holdings: () => Promise<FilingHolding[]>;
  now?: () => Date;
  /** 한도를 재는 시계 (기본 Date.now — 테스트는 가짜 시계) */
  clock?: () => number;
  log?: FilingLogger;
  budgetMs?: number;
  /** 화면·위젯 요청이 CIK 를 찾느라 기다리는 최대 시간 (기본 REQUEST_RESOLVE_BUDGET_MS — 테스트는 짧게) */
  resolveBudgetMs?: number;
}

export interface WatchPlan {
  /** CIK 마다 (등록 순 첫 종목의 코드·이름, 그 CIK 의 보유 종목 코드들) */
  watched: Array<{ cik: string; code: string; name: string; codes: string[] }>;
  /** 확인하지 않는 종목: ETF·ETN · SEC 목록에 없음 */
  notCovered: Array<{ code: string; name: string; reason: "etf" | "notFound" }>;
  /** SEC 티커 목록을 받지 못해 CIK 를 모름 (다음 확인 때 다시) */
  unresolved: Array<{ code: string; name: string }>;
}

/** 알림·화면의 공시 한 줄 */
export interface FilingItem {
  accession: string;
  code: string;
  name: string;
  form: string;
  items: string[];
  /** '실적 발표(8-K 2.02)' */
  title: string;
  /** SEC 접수 시각 UTC (모르면 null — 화면은 날짜만) */
  acceptedAt: string | null;
  /** 접수 시각의 한국 벽시계 'YYYY-MM-DDTHH:MM' (앱 Hermes 시간대 차이를 피해 서버가 만든다) */
  kst: string | null;
  /** 접수 시각의 미국 동부 벽시계 */
  et: string | null;
  filingDate: string;
  /** 서버가 처음 본 때 UTC */
  firstSeenAt: string;
  /** SEC 원문 (주 문서) */
  url: string;
}

/** '일정·공시' 화면 줄: 펼친 내용·새 공시 여부 */
export interface ScheduleFilingItem extends FilingItem {
  /** 들어 있는 항목 '2.02 실적 발표 — …' (8-K 만) */
  detail: string[];
  /** 한 줄 설명 (8-K 외 서식 · 6-K · 정정) */
  note: string | null;
  /** 서버가 처음 본 뒤 24시간 안이고 기준 잡기 줄이 아님 */
  isNew: boolean;
}

export type FilingWarning = "stale" | "partial" | "shape" | "blocked";

export interface FilingStatus {
  /** 확인하는 종목 수 */
  watched: number;
  notCovered: WatchPlan["notCovered"];
  /** 마지막 확인이 실패한 종목 (이름 — 다음 확인 때 다시) */
  failed: Array<{ code: string; name: string }>;
  /** 아직 한 번도 확인하지 않은 종목 (새로 산 종목 · 기능을 막 켬) */
  pending: Array<{ code: string; name: string }>;
  /** 확인하는 모든 종목을 마지막으로 받은 시각 (한국 시간 ISO, 모르면 null) */
  lastOkAt: string | null;
  warning: FilingWarning | null;
}

export interface SweepResult {
  ran: boolean;
  reason?: "off" | "running";
  checked: number;
  inserted: number;
  failed: string[];
  /** 한도(90초)를 넘어 다음 번으로 미룬 CIK 수 */
  deferred: number;
}

type SecFilingRowDb = Selectable<SecFilingTable>;

// ── 순수 함수 ──────────────────────────────────────────────────────

const ET = "America/New_York";

/** 순간 → 그 시간대 벽시계 { date: 'YYYY-MM-DD', hm: 'HH:MM', weekday: 0(일)~6 } */
function wall(t: number, timeZone: string): { date: string; hm: string; weekday: number } {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(t)) p[x.type] = x.value;
  const hour = p["hour"] === "24" ? "00" : p["hour"];
  return { date: `${p["year"]}-${p["month"]}-${p["day"]}`, hm: `${hour}:${p["minute"]}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p["weekday"] ?? "") };
}

/** ISO 순간 → 그 시간대 벽시계 'YYYY-MM-DDTHH:MM' (읽지 못하면 null) */
export function localMinute(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const w = wall(t, timeZone);
  return `${w.date}T${w.hm}`;
}

/** SEC 가 새 공시를 받는 시간인지: 미국 동부 평일 06:00~22:59 (cron '*\/5 6-22 * * 1-5' 와 같은 창, 서머타임 자동) */
export function inEdgarHours(now: Date): boolean {
  const w = wall(now.getTime(), ET);
  const h = Number(w.hm.slice(0, 2));
  return w.weekday >= 1 && w.weekday <= 5 && h >= 6 && h <= 22;
}

/** 오늘 SEC 접수 시간이 열린 뒤 지난 분 (시간 밖이면 -1) */
function minutesIntoEdgarDay(now: Date): number {
  if (!inEdgarHours(now)) return -1;
  const w = wall(now.getTime(), ET);
  return Number(w.hm.slice(0, 2)) * 60 + Number(w.hm.slice(3, 5)) - 6 * 60;
}

/**
 * ETF·ETN 인지 (네트워크 없음): 종목 마스터 분류(EF·EN) · 레버리지 정적 표(SOXL·TQQQ 등) · 이름의 낱말 'ETF'/'ETN'.
 * 이름의 Bear·Short·2X 같은 짐작은 쓰지 않는다 — 'Build-A-Bear Workshop' 같은 회사를 빼지 않게. 가려지지 않은 ETF 는 SEC 목록에 없어 'SEC 목록에 없음'으로 빠진다
 */
export function isExchangeProduct(h: FilingHolding): boolean {
  if (h.groupCode === "EF" || h.groupCode === "EN") return true;
  if (h.groupCode === "ST") return false;
  if (/\bET[FN]s?\b/i.test(h.name)) return true;
  const k = productKindOf(h.code, h.name, null, null);
  return k.kind === "leveraged" && k.source === "table";
}

/** 이 줄을 알리지 않을 만큼 오래됐는지 (접수 시각, 모르면 그 제출일 끝) */
export function tooOldToAlert(r: Pick<SecFilingRow, "acceptedAt" | "filingDate">, now: Date): boolean {
  const ref = Date.parse(r.acceptedAt ?? `${r.filingDate}T23:59:59Z`);
  return Number.isNaN(ref) || now.getTime() - ref > ALERT_MAX_AGE_MS;
}

/** 줄의 순서 키: 접수 시각(모르면 제출일 끝) — 최신 먼저로 정렬할 때 */
const sortKey = (r: { acceptedAt: string | null; filingDate: string }) => r.acceptedAt ?? `${r.filingDate}T23:59:59Z`;

const errorText = (e: unknown) => (e instanceof FilingShapeError ? `shape: ${e.message}` : e instanceof Error ? e.message : String(e)).slice(0, 300);

// ── 확인 작업 ──────────────────────────────────────────────────────

export class FilingWatchService {
  private readonly now: () => Date;
  private readonly clock: () => number;
  private running = false;
  private prunedOn: string | null = null;
  private lastPendingKick = Number.NEGATIVE_INFINITY;
  /** 티커 → CIK (null = SEC 목록에 없음). 위젯·화면 요청이 SEC 티커 목록을 다시 받지 않게 */
  private readonly cikMemo = new Map<string, { cik: string | null; at: number }>();
  private resolveFailedAt = 0;
  /** 지금 CIK 를 찾는 중인 일 (한 번에 하나) */
  private resolving: Promise<void> | null = null;

  /** p 를 deadline(한도 시계)까지 기다린다. null 이면 끝까지. 늦으면 timeout (p 는 뒤에서 끝난다) */
  private async waitUntil(p: Promise<unknown>, deadline: number | null): Promise<"ok" | "timeout"> {
    const settled = p.then(
      () => "ok" as const,
      () => "ok" as const,
    );
    if (deadline === null) return settled;
    const ms = deadline - this.clock();
    if (ms <= 0) return "timeout";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), ms);
    });
    try {
      return await Promise.race([settled, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(private readonly deps: FilingWatchDeps) {
    this.now = deps.now ?? (() => new Date());
    this.clock = deps.clock ?? (() => Date.now());
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 기억한 값이 아직 쓸 만하면 그 값 (undefined = 없음·지남) */
  private memoFresh(code: string, t: number): string | null | undefined {
    const hit = this.cikMemo.get(code);
    if (!hit) return undefined;
    return (hit.cik !== null ? t - hit.at < CIK_TTL_MS : t - hit.at < NOT_LISTED_TTL_MS) ? hit.cik : undefined;
  }

  /** 한 종목 찾기 (기억에 적음). 티커 목록을 받지 못하면 10분 동안 다시 묻지 않는다 */
  private async resolveOne(code: string): Promise<string | null | undefined> {
    const t = this.now().getTime();
    try {
      const { cik } = await this.deps.source.resolveCik(code);
      this.cikMemo.set(code, { cik, at: t });
      return cik;
    } catch (e) {
      if (e instanceof NotListedError) {
        this.cikMemo.set(code, { cik: null, at: t });
        return null;
      }
      this.resolveFailedAt = t;
      this.deps.log?.warn({ code, err: errorText(e) }, "SEC 티커 목록을 받지 못함 (10분 뒤 다시)");
      return this.cikMemo.get(code)?.cik;
    }
  }

  /**
   * 티커 → CIK. undefined = 모름(티커 목록을 받지 못함·기다리는 시간이 다 됨 — 다음에 다시), null = SEC 목록에 없음.
   * 찾기는 한 번에 하나만 (티커 목록 약 800KB 를 여러 번 겹쳐 받지 않게). deadline(실제 시계)이 있으면 그때까지만 기다리고, 받기는 뒤에서 끝나 기억에 남는다
   */
  private async cikOf(code: string, deadline: number | null): Promise<string | null | undefined> {
    const t = this.now().getTime();
    const fresh = this.memoFresh(code, t);
    if (fresh !== undefined) return fresh;
    const stale = this.cikMemo.get(code)?.cik;
    if (t - this.resolveFailedAt < RESOLVE_RETRY_MS) return stale;
    // 다른 종목을 찾는 중이면(티커 목록을 받는 중) 그것부터 기다린다 — 끝나면 대개 기억·캐시로 바로 찾는다
    while (this.resolving) {
      if ((await this.waitUntil(this.resolving, deadline)) === "timeout") return stale;
      const again = this.memoFresh(code, this.now().getTime());
      if (again !== undefined) return again;
      if (this.now().getTime() - this.resolveFailedAt < RESOLVE_RETRY_MS) return stale;
    }
    const p = this.resolveOne(code);
    const mark = p.then(
      () => undefined,
      () => undefined,
    );
    this.resolving = mark;
    void mark.then(() => {
      if (this.resolving === mark) this.resolving = null;
    });
    if ((await this.waitUntil(p, deadline)) === "timeout") return stale;
    return p;
  }

  /**
   * 보유 → 미국 · ETF 가리기 · CIK (같은 CIK 는 하나로, 이름은 등록 순 첫 종목).
   * budgetMs: CIK 를 찾느라 기다리는 최대 시간 (화면·위젯 요청 — 넘으면 그 종목은 이번엔 '모름'). 확인 작업은 null(기다림)
   */
  async watchPlan(budgetMs: number | null = this.deps.resolveBudgetMs ?? REQUEST_RESOLVE_BUDGET_MS): Promise<WatchPlan> {
    const deadline = budgetMs === null ? null : this.clock() + budgetMs;
    const plan: WatchPlan = { watched: [], notCovered: [], unresolved: [] };
    const byCik = new Map<string, WatchPlan["watched"][number]>();
    const seen = new Set<string>();
    for (const h of await this.deps.holdings()) {
      if (isKrCode(h.code) || seen.has(h.code)) continue;
      seen.add(h.code);
      if (isExchangeProduct(h)) {
        plan.notCovered.push({ code: h.code, name: h.name, reason: "etf" });
        continue;
      }
      const cik = await this.cikOf(h.code, deadline);
      if (cik === undefined) plan.unresolved.push({ code: h.code, name: h.name });
      else if (cik === null) plan.notCovered.push({ code: h.code, name: h.name, reason: "notFound" });
      else {
        const w = byCik.get(cik);
        if (w) w.codes.push(h.code);
        else {
          const row = { cik, code: h.code, name: h.name, codes: [h.code] };
          byCik.set(cik, row);
          plan.watched.push(row);
        }
      }
    }
    return plan;
  }

  /** cron 이 부른다. 플래그가 꺼져 있으면 SEC 호출 0, 이미 도는 중이면 건너뜀 */
  async sweep(only?: ReadonlySet<string>): Promise<SweepResult> {
    const skipped = (reason: "off" | "running"): SweepResult => ({ ran: false, reason, checked: 0, inserted: 0, failed: [], deferred: 0 });
    if (this.running) return skipped("running");
    this.running = true;
    try {
      if (!(await this.deps.features.enabled("filingAlerts").catch(() => false))) return skipped("off");
      return await this.sweepNow(only);
    } finally {
      this.running = false;
    }
  }

  private async sweepNow(only?: ReadonlySet<string>): Promise<SweepResult> {
    const started = this.clock();
    const budget = this.deps.budgetMs ?? SWEEP_BUDGET_MS;
    const plan = await this.watchPlan(null);
    const since = seoulDateDaysAgo(this.now(), FILING_KEEP_DAYS);
    const out: SweepResult = { ran: true, checked: 0, inserted: 0, failed: [], deferred: 0 };
    const targets = only ? plan.watched.filter((w) => only.has(w.cik)) : plan.watched;
    for (let i = 0; i < targets.length; i++) {
      const w = targets[i]!;
      if (this.clock() - started >= budget) {
        out.deferred = targets.length - i;
        this.deps.log?.warn({ deferred: out.deferred }, "SEC 공시 확인 한도(90초)를 넘어 남은 종목은 다음 번에");
        break;
      }
      try {
        const rows = parseRecentFilings(await this.deps.source.submissionsJson(w.cik), since);
        out.inserted += await this.store(w.cik, rows);
        out.checked++;
      } catch (e) {
        const msg = errorText(e);
        out.failed.push(w.code);
        const at = isoSec(this.now());
        await this.deps.db
          .insertInto("sec_filing_watch")
          .values({ cik: w.cik, first_ok_at: null, last_try_at: at, last_ok_at: null, last_error: msg })
          .onConflict((oc) => oc.column("cik").doUpdateSet({ last_try_at: at, last_error: msg }))
          .execute()
          .catch(() => undefined);
        this.deps.log?.warn({ code: w.code, cik: w.cik, err: msg }, "SEC 공시를 받지 못함 (다음 확인 때 다시)");
      }
    }
    await this.pruneDaily();
    return out;
  }

  /** 한 CIK 의 새 줄 넣기 (이미 있는 접수 번호는 건너뜀) + 확인 기록. 넣은 줄 수 */
  private async store(cik: string, rows: SecFilingRow[]): Promise<number> {
    const db = this.deps.db;
    const now = this.now();
    const at = isoSec(now);
    const watch = await db.selectFrom("sec_filing_watch").select(["first_ok_at"]).where("cik", "=", cik).executeTakeFirst();
    // 처음 보는 CIK: 이번에 넣는 줄은 모두 기준 (알리지 않음)
    const baselineAll = !watch?.first_ok_at;
    const have = new Set((await db.selectFrom("sec_filings").select("accession").where("cik", "=", cik).execute()).map((r) => r.accession));
    const values: Array<Omit<SecFilingTable, "id">> = [];
    for (const r of rows) {
      if (have.has(r.accession)) continue;
      have.add(r.accession);
      values.push({
        cik,
        accession: r.accession,
        form: r.form,
        items: r.items.join(","),
        accepted_at: r.acceptedAt,
        filing_date: r.filingDate,
        report_date: r.reportDate,
        primary_doc: r.primaryDoc,
        description: r.description,
        baseline: baselineAll || tooOldToAlert(r, now) ? 1 : 0,
        first_seen_at: at,
      });
    }
    for (let i = 0; i < values.length; i += INSERT_CHUNK) {
      await db
        .insertInto("sec_filings")
        .values(values.slice(i, i + INSERT_CHUNK))
        .onConflict((oc) => oc.columns(["cik", "accession"]).doNothing())
        .execute();
    }
    const first = watch?.first_ok_at ?? at;
    await db
      .insertInto("sec_filing_watch")
      .values({ cik, first_ok_at: first, last_try_at: at, last_ok_at: at, last_error: null })
      .onConflict((oc) => oc.column("cik").doUpdateSet({ first_ok_at: first, last_try_at: at, last_ok_at: at, last_error: null }))
      .execute();
    if (values.some((v) => v.baseline === 0)) this.deps.log?.info?.({ cik, fresh: values.filter((v) => v.baseline === 0).map((v) => `${v.form} ${v.accession}`) }, "SEC 새 공시");
    return values.length;
  }

  /** 하루(한국 날짜) 첫 번째 돌기에서 제출일 90일 넘은 줄을 지운다 */
  private async pruneDaily(): Promise<void> {
    const now = this.now();
    const today = seoulDate(now);
    if (this.prunedOn === today) return;
    this.prunedOn = today;
    await this.deps.db
      .deleteFrom("sec_filings")
      .where("filing_date", "<", seoulDateDaysAgo(now, FILING_KEEP_DAYS))
      .execute()
      .catch((e: unknown) => this.deps.log?.warn({ err: errorText(e) }, "오래된 SEC 공시 지우기 실패"));
  }

  /** 표의 줄 → 공시 한 줄 (같은 접수 번호는 하나로 — 공동 제출) · 접수 시각 최신 먼저 */
  private rowsToItems<T>(rows: readonly SecFilingRowDb[], plan: WatchPlan, extra: (r: SecFilingRowDb) => T): Array<FilingItem & T> {
    const byCik = new Map(plan.watched.map((w, i) => [w.cik, { w, i }]));
    const sorted = [...rows].sort((a, b) => {
      const ka = sortKey({ acceptedAt: a.accepted_at, filingDate: a.filing_date });
      const kb = sortKey({ acceptedAt: b.accepted_at, filingDate: b.filing_date });
      return ka < kb ? 1 : ka > kb ? -1 : (byCik.get(a.cik)?.i ?? 0) - (byCik.get(b.cik)?.i ?? 0);
    });
    const out: Array<FilingItem & T> = [];
    const seen = new Set<string>();
    for (const r of sorted) {
      const w = byCik.get(r.cik)?.w;
      if (!w || seen.has(r.accession)) continue;
      seen.add(r.accession);
      const items = r.items ? r.items.split(",").filter(Boolean) : [];
      out.push({
        accession: r.accession,
        code: w.code,
        name: w.name,
        form: r.form,
        items,
        title: filingTitle(r.form, items),
        acceptedAt: r.accepted_at,
        kst: localMinute(r.accepted_at, "Asia/Seoul"),
        et: localMinute(r.accepted_at, ET),
        filingDate: r.filing_date,
        firstSeenAt: r.first_seen_at,
        url: filingUrl(r.cik, r.accession, r.primary_doc),
        ...extra(r),
      });
    }
    return out;
  }

  /** 알림용: 기준 잡기 줄 제외 · 서버가 처음 본 때가 days 일 안 · 지금 보유한 종목만 · 최신 먼저 limit 개 */
  async alerts(opts: { days: number; limit: number }): Promise<FilingItem[]> {
    const plan = await this.watchPlan();
    if (!plan.watched.length) return [];
    const since = isoSec(this.now().getTime() - opts.days * 86_400_000);
    const rows = await this.deps.db
      .selectFrom("sec_filings")
      .selectAll()
      .where("baseline", "=", 0)
      .where("first_seen_at", ">=", since)
      .where("cik", "in", plan.watched.map((w) => w.cik))
      .execute();
    return this.rowsToItems(rows, plan, () => ({})).slice(0, opts.limit);
  }

  /** 위젯 응답의 filingIds: 알림 대상 접수 번호 (최근 3일, 최신 limit 개) */
  async newIds(limit = 10): Promise<string[]> {
    return (await this.alerts({ days: 3, limit })).map((i) => i.accession);
  }

  /** 화면용: 기준 잡기 줄 포함 · 제출일 days 일 안 · 펼친 내용·새 공시 여부 + 확인 상태 */
  async list(opts: { days: number; limit: number }): Promise<{ items: ScheduleFilingItem[]; total: number; status: FilingStatus }> {
    const plan = await this.watchPlan();
    const status = await this.status(plan);
    if (!plan.watched.length) return { items: [], total: 0, status };
    const now = this.now().getTime();
    const rows = await this.deps.db
      .selectFrom("sec_filings")
      .selectAll()
      .where("filing_date", ">=", seoulDateDaysAgo(this.now(), opts.days))
      .where("cik", "in", plan.watched.map((w) => w.cik))
      .execute();
    const all = this.rowsToItems(rows, plan, (r) => {
      const d = filingDetail(r.form, r.items ? r.items.split(",").filter(Boolean) : []);
      const seenAt = Date.parse(r.first_seen_at);
      return { detail: d.lines, note: d.note, isNew: r.baseline === 0 && Number.isFinite(seenAt) && now - seenAt < NEW_FOR_MS };
    });
    if (status.pending.length) this.kickPending(plan, status);
    return { items: all.slice(0, opts.limit), total: all.length, status };
  }

  /** 확인 상태 (화면 작은 글 · /health): 마지막으로 모두 받은 시각 · 실패 · 멈춤 */
  async status(plan?: WatchPlan): Promise<FilingStatus> {
    const p = plan ?? (await this.watchPlan());
    const ciks = p.watched.map((w) => w.cik);
    const rows = ciks.length ? await this.deps.db.selectFrom("sec_filing_watch").selectAll().where("cik", "in", ciks).execute() : [];
    const byCik = new Map(rows.map((r) => [r.cik, r]));
    const failed: FilingStatus["failed"] = [...p.unresolved];
    const pending: FilingStatus["pending"] = [];
    let lastOk: string | null = null;
    let allOk = ciks.length > 0;
    let shape = false;
    let blocked = false;
    for (const w of p.watched) {
      const r = byCik.get(w.cik);
      if (r?.last_error && (!r.last_ok_at || (r.last_try_at ?? "") > r.last_ok_at)) {
        failed.push({ code: w.code, name: w.name });
        if (r.last_error.startsWith("shape:")) shape = true;
        if (/HTTP 403/.test(r.last_error)) blocked = true;
      }
      if (!r?.last_ok_at) {
        // 아직 한 번도 확인하지 않은 종목(새로 삼)은 '아직 확인 전'으로 따로 밝히고, 다른 종목의 마지막 확인 시각은 그대로 보인다
        if (!r?.last_error) pending.push({ code: w.code, name: w.name });
        else allOk = false;
        continue;
      }
      if (lastOk === null || r.last_ok_at < lastOk) lastOk = r.last_ok_at;
    }
    const now = this.now();
    const into = minutesIntoEdgarDay(now);
    const okAt = allOk ? lastOk : null;
    // 멈춤: SEC 접수 시간이 열린 지 30분 넘었는데 30분 넘게 모두 받지 못함 (접수 시간 밖·월요일 아침 첫 5분은 아님)
    const stale = ciks.length > 0 && into >= STALE_AFTER_MS / 60_000 && (lastOk === null || now.getTime() - Date.parse(lastOk) > STALE_AFTER_MS);
    const warning: FilingWarning | null = shape ? "shape" : blocked ? "blocked" : stale ? "stale" : failed.length ? "partial" : null;
    return {
      watched: p.watched.reduce((n, w) => n + w.codes.length, 0),
      notCovered: p.notCovered,
      failed,
      pending,
      lastOkAt: okAt ? seoulIso(new Date(okAt)) : null,
      warning,
    };
  }

  /** /health 에 보일 값 (플래그가 켜져 있을 때만 app.ts 가 넣는다) */
  async health(): Promise<{ lastOkAt: string | null; watched: number; notCovered: number; failed: string[]; warning: FilingWarning | null }> {
    const s = await this.status();
    return { lastOkAt: s.lastOkAt, watched: s.watched, notCovered: s.notCovered.length, failed: s.failed.map((f) => f.code), warning: s.warning };
  }

  /**
   * 아직 한 번도 확인하지 않은 종목(새로 산 종목 · 기능을 막 켬)이 있으면 화면이 열릴 때 뒤에서 그 종목만 한 번 받는다 (10분에 한 번까지).
   * 첫 확인은 기준 잡기라 알림은 생기지 않는다 — 주말에 켜도 화면에 최근 공시가 보이게
   */
  private kickPending(plan: WatchPlan, status: FilingStatus): void {
    const t = this.clock();
    if (this.running || t - this.lastPendingKick < PENDING_KICK_MS) return;
    this.lastPendingKick = t;
    const codes = new Set(status.pending.map((p) => p.code));
    const only = new Set(plan.watched.filter((w) => codes.has(w.code)).map((w) => w.cik));
    void this.sweep(only).catch((e: unknown) => this.deps.log?.warn({ err: errorText(e) }, "SEC 공시 첫 확인 실패"));
  }
}

/** 한국 날짜로 n일 전 'YYYY-MM-DD' */
function seoulDateDaysAgo(now: Date, days: number): string {
  return seoulDate(new Date(now.getTime() - days * 86_400_000));
}
