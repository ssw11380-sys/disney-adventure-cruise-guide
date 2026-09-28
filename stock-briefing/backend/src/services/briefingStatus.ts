import type { Db } from "../db/index.js";
import { isKrCode } from "../lib/codes.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import type { NotificationSettings } from "../notifications/settings.js";
import { briefingMarketDate, type BriefingSession, type RunDoneListener, type RunProgress } from "./briefingService.js";

/**
 * 브리핑 늦음·실패 안내 (브리핑 3차 2, 플래그 briefingStatus).
 * 브리핑 탭 맨 위 한 덩어리: 오늘 예약 시각이 지난 가장 최근 회차가 늦었는지·일부/전부 못 만들었는지·실행되지 않았는지·아직 만드는 중인지.
 *  - 실행 기록: 실행이 끝날 때마다(알림을 보낸 뒤) meta `briefing_run_log` 에 한 줄 (최근 20건, 서버를 다시 켜도 남음)
 *  - 못 만든 종목은 지금 briefings 표에서 센다 — 수동으로 다시 만들어 성공하면 안내에서 빠진다. 시각은 실행 기록에서
 *  - 오류 원문은 보내지 않는다: 저장된 오류 글에서 종류만 뽑는다 (failureKind — 앱도 같은 표를 쓴다, shared/fixtures/briefingFailure.json)
 *  - 스케줄러는 실패 종목을 다시 만들지 않고 놓친 회차를 따라잡지 않는다 → '잠시 뒤 다시 만들어집니다'라고 말하지 않는다 (retryAt 은 늘 null)
 * 플래그가 꺼지면 경로는 404, 실행 기록을 쓰지 않고 계산·달력 조회도 하지 않는다
 */

/** 오류 글의 종류: 붐빔(429·529) · 장애(그 밖 5xx·연결·시간 초과) · 설정(키·크레딧·권한·모델) · 끝까지 못 씀(거절·잘림) · 그 밖 */
export type FailureKind = "busy" | "outage" | "setup" | "cutoff" | "other";
/** 안내 이유: 오류 종류 + 서버가 도중에 다시 켜져 줄이 없는 종목 */
export type ReasonKind = FailureKind | "restart";

export type StatusState = "ok" | "late" | "partial" | "allFailed" | "slow" | "missed" | "llmOff" | "none";

/**
 * 저장된 오류 글(`${kind}: ${message}` — briefingService.generate) → 종류. 요약 글('브리핑 생성 실패: …')이 와도 읽는다.
 * 원문은 화면에 보내지 않고 이 종류만 쓴다
 */
export function failureKind(error: string | null | undefined): FailureKind {
  const e = (error ?? "").trim().replace(/^브리핑 생성 실패:\s*/, "");
  if (e.startsWith("config:")) return "setup";
  if (e.startsWith("refusal:") || e.startsWith("truncated:")) return "cutoff";
  if (e.startsWith("api:")) {
    if (/\(429\)|사용량 제한|\(529\)/.test(e)) return "busy";
    if (/\(5\d\d\)|서버 장애|모델 호출 실패/.test(e)) return "outage";
  }
  return "other";
}

/** 완료가 예약 + 이만큼 뒤면 '늦음' (평소 17종목 약 8분: 08:30 → 08:38) */
export const LATE_AFTER_MS = 20 * 60_000;
/** 시작 뒤 이만큼 넘게 실행 중이면 '아직 만드는 중' */
export const SLOW_AFTER_MS = 20 * 60_000;
/** 예약 + 이만큼 지나도 그 회차 줄·실행 기록이 없으면 '빠짐' (30분 늦게까지 돌 수 있음 + 실행 10분 + 여유) */
export const MISSED_AFTER_MS = 45 * 60_000;
/** 서버가 예약 시각 뒤에 켜졌으면 그 회차는 돌 수 없다 — 켜진 뒤 이만큼 지나면 '빠짐' (08:31 에 켜짐 → 08:36) */
export const MISSED_BOOT_MS = 5 * 60_000;
/** 이름을 보이는 최대 개수 (넘으면 '외 N종목' — 앱이 자른다) */
export const NAMES_MAX = 5;
export const RUN_LOG_KEY = "briefing_run_log";
export const RUN_LOG_MAX = 20;

/** 실행 기록 한 줄 (실행이 끝날 때) */
export interface RunLogEntry {
  session: BriefingSession;
  date: string;
  trigger: "schedule" | "manual";
  /** 일부 종목만 실행 (상세의 '이 종목 다시 만들기') */
  partial: boolean;
  /** 스케줄러가 부른 그때의 cron 시·분 (ISO). 수동 실행·모름이면 null — 나중에 설정 시각을 바꿔도 그날 기준이 흔들리지 않게 */
  scheduledAt: string | null;
  firedAt: string | null;
  startedAt: string;
  finishedAt: string;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  /** 휴장으로 건너뛴 종목 (못 만든 것으로 세지 않는다) */
  skippedCodes: string[];
}

export interface StatusProblem {
  code: string;
  name: string;
  /** 누르면 열 브리핑: 실패 브리핑, 줄이 없으면 같은 회차의 가장 최근 브리핑(없으면 가장 최근) — 거기 '이 종목 다시 만들기'가 그 회차를 만든다 */
  briefingId: number | null;
  kind: ReasonKind;
  /** 이번 회차 줄이 아예 없음 (서버가 도중에 다시 켜짐 등) */
  missing: boolean;
}

/** GET /api/briefings/status 응답 */
export interface BriefingStatus {
  session: BriefingSession | null;
  date: string;
  scheduledAt: string | null;
  state: StatusState;
  /** 완료가 예약 + 20분 뒤 (일부·모두 못 만듦과 같이 올 수 있음) */
  late: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** 이번 회차 대상 종목 수 (만드는 중이면 실행 중인 종목 수) */
  total: number;
  /** 끝난 종목 수 (만드는 중) · 만든 종목 수 (그 밖) */
  done: number;
  problems: StatusProblem[];
  /** 못 만든 이유가 한 가지면 그 종류, 여럿이면 null */
  reasonKind: ReasonKind | null;
  /** 다음 예약 브리핑 시각 (없으면 null) */
  nextRunAt: string | null;
  /** 자동으로 한 번 더 만드는 시각 — 지금은 그런 동작이 없어 늘 null */
  retryAt: null;
  /** 상세의 '이 종목 다시 만들기'가 있는지 (플래그 briefingManualRun) */
  manualRun: boolean;
}

export type ScheduleSettings = Pick<NotificationSettings, "morningTime" | "afternoonTime" | "morningEnabled" | "afternoonEnabled" | "weekdaysOnly">;

const SESSIONS: BriefingSession[] = ["morning", "afternoon"];
const timeOf = (s: ScheduleSettings, session: BriefingSession) => (session === "morning" ? s.morningTime : s.afternoonTime);
const enabledOf = (s: ScheduleSettings, session: BriefingSession) => (session === "morning" ? s.morningEnabled : s.afternoonEnabled);
/** 한국 날짜의 요일 (0 일 ~ 6 토) */
const weekdayOf = (date: string) => new Date(`${date}T12:00:00+09:00`).getUTCDay();
const addDays = (date: string, n: number) => seoulDate(new Date(Date.parse(`${date}T12:00:00+09:00`) + n * 86_400_000));
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+09:00`;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * 안내할 회차: 오늘(한국) 켜진 세션 중 예약 시각이 지난 가장 최근 것. 주말(평일만)·세션 끔·예약 전이면 null.
 * 오늘 정기 실행 기록이 있으면 그 기록의 예약 시각을 쓴다 (그날 브리핑 시각을 바꿔도 기준이 흔들리지 않게)
 */
export function pickSession(now: Date, settings: ScheduleSettings, runs: RunLogEntry[]): { session: BriefingSession; date: string; scheduledAt: string } | null {
  const date = seoulDate(now);
  const dow = weekdayOf(date);
  if (settings.weekdaysOnly && (dow === 0 || dow === 6)) return null;
  let best: { session: BriefingSession; date: string; scheduledAt: string } | null = null;
  for (const session of SESSIONS) {
    if (!enabledOf(settings, session)) continue;
    const logged = runs.filter((r) => r.date === date && r.session === session && r.trigger === "schedule" && r.scheduledAt).at(-1)?.scheduledAt;
    const scheduledAt = logged ?? at(date, timeOf(settings, session));
    if (ms(scheduledAt) > now.getTime()) continue;
    if (!best || ms(scheduledAt) > ms(best.scheduledAt)) best = { session, date, scheduledAt };
  }
  return best;
}

/** 다음 예약 브리핑 시각 (지금 뒤, 평일만이면 주말 건너뜀). 두 세션이 모두 꺼져 있으면 null */
export function nextRunAt(now: Date, settings: ScheduleSettings): string | null {
  const today = seoulDate(now);
  for (let n = 0; n <= 7; n++) {
    const date = addDays(today, n);
    const dow = weekdayOf(date);
    if (settings.weekdaysOnly && (dow === 0 || dow === 6)) continue;
    const times = SESSIONS.filter((s) => enabledOf(settings, s))
      .map((s) => at(date, timeOf(settings, s)))
      .sort();
    const next = times.find((t) => ms(t) > now.getTime());
    if (next) return next;
  }
  return null;
}

export interface JudgeInput {
  now: Date;
  llmConfigured: boolean;
  pick: { session: BriefingSession; date: string; scheduledAt: string } | null;
  /** 지금 도는 실행 (없으면 null) */
  running: RunProgress | null;
  /** 이 서버가 켜진 시각 */
  bootAt: Date;
  /** 등록 종목 (등록순) */
  stocks: Array<{ code: string; name: string; createdAt: string }>;
  /** 그 회차(날짜·세션)의 브리핑 줄 */
  rows: Array<{ id: number; code: string; status: string; error: string | null; createdAt: string }>;
  /** 그 회차가 다루는 거래일(briefingMarketDate)이 시장별로 거래일인지 */
  trading: { KR: boolean; US: boolean };
  runs: RunLogEntry[];
  nextRunAt: string | null;
  manualRun: boolean;
}

/**
 * 판단 (순수). 순서: 모델 없음 → 오늘 회차 없음 → 도는 중(20분 넘으면 만드는 중) → 대상 종목 없음(모두 휴장·등록 없음)
 * → 빠짐(줄·실행 기록 없음 + 예약 뒤 45분 지남 또는 서버가 예약 뒤에 켜지고 5분 지남) → 모두/일부 못 만듦 → 늦음 → 정상.
 * 줄이 없는 종목(briefingId null)은 부르는 쪽이 같은 회차의 가장 최근 브리핑으로 채운다
 */
export function judgeStatus(i: JudgeInput): BriefingStatus {
  const base: BriefingStatus = {
    session: i.pick?.session ?? null,
    date: i.pick?.date ?? seoulDate(i.now),
    scheduledAt: i.pick?.scheduledAt ?? null,
    state: "none",
    late: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    done: 0,
    problems: [],
    reasonKind: null,
    nextRunAt: i.nextRunAt,
    retryAt: null,
    manualRun: i.manualRun,
  };
  if (!i.llmConfigured) return { ...base, state: "llmOff" };
  const pick = i.pick;
  if (!pick) return base;
  const now = i.now.getTime();
  const sched = ms(pick.scheduledAt);

  // 이 회차를 도는 실행이 있으면 판단하지 않는다 (줄이 아직 없는 종목을 못 만든 것으로 세지 않게). 한 종목만 다시 만드는 중이어도 마찬가지
  const run = i.running && i.running.session === pick.session && i.running.date === pick.date ? i.running : null;
  if (run) {
    if (!run.partial && now - ms(run.startedAt) > SLOW_AFTER_MS) return { ...base, state: "slow", startedAt: run.startedAt, total: run.total, done: run.done };
    return { ...base, state: "ok" };
  }

  const mine = i.runs.filter((r) => r.date === pick.date && r.session === pick.session);
  const full = mine.filter((r) => !r.partial);
  const latestFull = full.at(-1) ?? null;
  const schedRun = full.filter((r) => r.trigger === "schedule").at(-1) ?? null;
  const shown = schedRun ?? latestFull;
  const times = { startedAt: shown?.startedAt ?? null, finishedAt: shown?.finishedAt ?? null };
  // 수동으로 다시 만든 전체 실행이 정기 실행 뒤에 있으면 숫자 기준이 바뀌었으므로 '늦음'을 말하지 않는다
  const late = !!schedRun && latestFull === schedRun && ms(schedRun.finishedAt) > sched + LATE_AFTER_MS;

  const marketOf = (code: string): "KR" | "US" => (isKrCode(code) ? "KR" : "US");
  const trading = i.stocks.filter((s) => i.trading[marketOf(s.code)]);
  // 모두 휴장이라 건너뛴 날·등록 종목 없음 → 탭 휴장 줄이 이미 말한다
  if (trading.length === 0) return base;

  const firstRow = i.rows.length ? Math.min(...i.rows.map((r) => ms(r.createdAt)).filter((t) => !Number.isNaN(t))) : Number.NaN;
  // 실행 기록 없이 줄만 있고 서버가 그 뒤에 켜졌으면 도중에 다시 켜진 것 (기록은 실행이 끝날 때 쓰므로)
  const restarted = !latestFull && i.rows.length > 0 && i.bootAt.getTime() > firstRow;
  if (!latestFull && !restarted) {
    // 전체 실행 기록이 없다: 아직 돌지 않았거나(늦게 알아챈 예약 — 30분까지 돈다) 빠졌다
    // 서버가 예약 뒤에 켜졌으면 켜진 지 5분 뒤부터 (08:31 에 켜짐 → 08:36)
    const boot = i.bootAt.getTime();
    const due = now >= sched + MISSED_AFTER_MS || (boot > sched && now >= boot + MISSED_BOOT_MS);
    const before = trading.filter((s) => !(ms(s.createdAt) >= sched));
    if (due && before.length > 0) return { ...base, state: "missed", total: before.length };
    return { ...base, state: "ok" };
  }

  // 대상: 실행 시작 전에 등록한 종목 (그 뒤에 추가한 종목은 이번 회차 대상이 아니다). 휴장으로 건너뛴 종목은 뺀다
  const runStart = latestFull ? ms(latestFull.startedAt) : firstRow;
  const skipped = new Set(latestFull?.skippedCodes ?? []);
  const eligible = trading.filter((s) => !(ms(s.createdAt) >= runStart) && !skipped.has(s.code));
  if (eligible.length === 0) return { ...base, ...times, state: "none" };
  const rowBy = new Map(i.rows.map((r) => [r.code, r]));
  const problems: StatusProblem[] = [];
  for (const s of eligible) {
    const r = rowBy.get(s.code);
    if (r?.status === "ok") continue;
    if (r) problems.push({ code: s.code, name: s.name, briefingId: r.id, kind: failureKind(r.error), missing: false });
    else problems.push({ code: s.code, name: s.name, briefingId: null, kind: latestFull ? "other" : "restart", missing: true });
  }
  const counts = { ...times, late, total: eligible.length, done: eligible.length - problems.length };
  if (problems.length > 0) {
    const kinds = new Set(problems.map((p) => p.kind));
    const reasonKind = kinds.size === 1 ? [...kinds][0]! : null;
    return { ...base, ...counts, state: problems.length === eligible.length ? "allFailed" : "partial", problems, reasonKind };
  }
  return { ...base, ...counts, state: late ? "late" : "ok" };
}

/** 실행 결과 → 실행 기록 한 줄 */
export function runLogEntry(done: Parameters<RunDoneListener>[0], finishedAt: string): RunLogEntry {
  const r = done.results;
  return {
    session: done.session,
    date: done.date,
    trigger: done.trigger,
    partial: done.partial,
    scheduledAt: done.scheduledAt ?? null,
    firedAt: done.firedAt ?? null,
    startedAt: done.startedAt ?? finishedAt,
    finishedAt,
    total: r.length,
    ok: r.filter((x) => x.status === "ok").length,
    failed: r.filter((x) => x.status === "failed").length,
    skipped: r.filter((x) => x.status === "skipped").length,
    skippedCodes: r.filter((x) => x.status === "skipped").map((x) => x.code),
  };
}

export interface BriefingStatusDeps {
  db: Db;
  /** 플래그 briefingStatus · briefingManualRun (FeatureService) */
  features: { enabled(key: "briefingStatus" | "briefingManualRun"): Promise<boolean> };
  settings: () => Promise<ScheduleSettings>;
  calendar: { isTradingDate(market: "KR" | "US", date: string): Promise<boolean> } | null;
  /** 지금 도는 실행 (BriefingService.progress) */
  progress: () => RunProgress | null;
  llmConfigured: () => boolean;
  now: () => Date;
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

export class BriefingStatusService {
  /** 이 서버가 켜진 시각 (예약 시각 뒤에 켜졌으면 그 회차는 돌 수 없다) */
  private readonly bootAt: Date;
  /** 기록 쓰기는 한 줄로 (읽고-고쳐-쓰기 사이에 다른 기록이 사라지지 않게) */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BriefingStatusDeps) {
    this.bootAt = deps.now();
  }

  enabled(): Promise<boolean> {
    return this.deps.features.enabled("briefingStatus").catch(() => false);
  }

  /** BriefingService.onRunDone 에 붙인다 (알림을 보낸 뒤 — 등록 순서). 플래그가 꺼져 있으면 쓰지 않는다 */
  readonly onRunDone: RunDoneListener = async (done) => {
    if (!(await this.enabled())) return;
    const entry = runLogEntry(done, seoulIso(this.deps.now()));
    const write = this.queue.then(async () => {
      const list = [...(await this.runs()), entry].slice(-RUN_LOG_MAX);
      const value = JSON.stringify(list);
      await this.deps.db.insertInto("meta").values({ key: RUN_LOG_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    });
    this.queue = write.catch((e: unknown) => this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, "브리핑 실행 기록 저장 실패"));
    await this.queue;
  };

  /** 최근 실행 기록 (오래된 것부터). 없거나 깨졌으면 빈 목록 */
  async runs(): Promise<RunLogEntry[]> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", RUN_LOG_KEY).executeTakeFirst();
    if (!row) return [];
    try {
      const v = JSON.parse(row.value) as unknown;
      return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && typeof (x as RunLogEntry).date === "string") as RunLogEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** 지금 안내 (플래그 확인은 부르는 쪽 — 경로) */
  async status(): Promise<BriefingStatus> {
    const now = this.deps.now();
    const [settings, runs, manualRun] = await Promise.all([this.deps.settings(), this.runs(), this.deps.features.enabled("briefingManualRun").catch(() => false)]);
    const llmConfigured = this.deps.llmConfigured();
    const pick = pickSession(now, settings, runs);
    const next = nextRunAt(now, settings);
    const empty = { stocks: [], rows: [], trading: { KR: false, US: false } };
    if (!llmConfigured || !pick) {
      return judgeStatus({ now, llmConfigured, pick, running: null, bootAt: this.bootAt, runs, nextRunAt: next, manualRun, ...empty });
    }
    const db = this.deps.db;
    const [stockRows, rows] = await Promise.all([
      db.selectFrom("registered_stocks").select(["code", "name", "created_at"]).orderBy("created_at").execute(),
      db.selectFrom("briefings").select(["id", "code", "status", "error", "created_at"]).where("briefing_date", "=", pick.date).where("session", "=", pick.session).execute(),
    ]);
    const stocks = stockRows.map((s) => ({ code: s.code, name: s.name, createdAt: s.created_at }));
    // 등록 종목이 있는 시장만 묻는다 (달력은 5분 캐시). 못 물으면 거래일로 본다 (브리핑 실행과 같게)
    const cal = this.deps.calendar;
    const tradingOf = async (market: "KR" | "US") => {
      if (!stocks.some((s) => (isKrCode(s.code) ? "KR" : "US") === market)) return false;
      if (!cal) return true;
      return cal.isTradingDate(market, briefingMarketDate(market, pick.session, pick.date)).catch(() => true);
    };
    const [KR, US] = await Promise.all([tradingOf("KR"), tradingOf("US")]);
    const judged = judgeStatus({
      now,
      llmConfigured,
      pick,
      running: this.deps.progress(),
      bootAt: this.bootAt,
      stocks,
      rows: rows.map((r) => ({ id: r.id, code: r.code, status: r.status, error: r.error, createdAt: r.created_at })),
      trading: { KR, US },
      runs,
      nextRunAt: next,
      manualRun,
    });
    // 줄이 없는 종목: 같은 회차의 가장 최근 브리핑(없으면 가장 최근) — 상세의 '이 종목 다시 만들기'가 그 회차를 오늘 것으로 만든다
    for (const p of judged.problems) {
      if (p.briefingId !== null) continue;
      const recent = await db.selectFrom("briefings").select(["id", "session"]).where("code", "=", p.code).orderBy("briefing_date", "desc").orderBy("created_at", "desc").limit(10).execute();
      p.briefingId = (recent.find((r) => r.session === pick.session) ?? recent[0])?.id ?? null;
    }
    return judged;
  }
}
