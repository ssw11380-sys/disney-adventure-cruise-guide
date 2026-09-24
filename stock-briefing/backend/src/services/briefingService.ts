import type { Db } from "../db/index.js";
import type { RegisteredStock } from "../domain/types.js";
import { NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import { GenerationError, type TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptStore } from "../llm/prompts.js";
import type { BriefingSnapshot, DataCollector } from "./collector.js";

export type BriefingSession = "morning" | "afternoon";
export const SESSION_LABEL: Record<BriefingSession, string> = { morning: "오전 (장 시작 전)", afternoon: "오후 (장 마감 후)" };

export interface Briefing {
  id: number;
  code: string;
  name: string | null;
  session: BriefingSession;
  date: string;
  status: "ok" | "failed";
  summary: string;
  detail: string;
  missing: string[];
  model: string;
  error: string | null;
  createdAt: string;
}

export interface BriefingWithData extends Briefing {
  data: BriefingSnapshot | null;
}

export interface RunResult {
  session: BriefingSession;
  date: string;
  results: Array<{ code: string; name: string; status: "ok" | "failed" | "skipped"; briefingId: number | null; error: string | null; summary: string | null }>;
  startedAt: string;
  finishedAt: string;
}

/** 마지막 실행 요약 (/health 와 앱 상태 배너용) */
export interface LastRun {
  session: BriefingSession;
  date: string;
  startedAt: string;
  finishedAt: string;
  ok: number;
  failed: number;
  skipped: number;
  lastError: string | null;
  trigger: "schedule" | "manual";
}

export interface BriefingServiceDeps {
  db: Db;
  collector: DataCollector;
  generator: TextGenerator;
  prompts: PromptStore;
  /** 휴장일이면 해당 시장 종목을 건너뛴다 */
  calendar?: { isTradingDay(code: string): Promise<boolean> } | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

export interface BriefingListener {
  (briefing: Briefing): Promise<void> | void;
}

/** 한 번의 실행(세션)이 끝났을 때: 이번에 새로 만든 브리핑(성공만)과 브리핑 시점 등락률 (3-19 알림 묶음) */
export interface SessionDone {
  session: BriefingSession;
  date: string;
  trigger: "schedule" | "manual";
  created: Array<{ briefing: Briefing; changeRate: number | null }>;
}
export type SessionListener = (done: SessionDone) => Promise<void> | void;

/**
 * 브리핑 파이프라인: 수집 → 프롬프트 조립 → Claude(상세) → Claude(요약) → 저장.
 * 종목별로 순차 실행한다(외부 API rate limit). 실패도 저장해서 앱에서 "생성 실패" 를 볼 수 있게 한다.
 */
export class BriefingService {
  private readonly now: () => Date;
  private readonly listeners: BriefingListener[] = [];
  private readonly sessionListeners: SessionListener[] = [];
  /** generateOne 이 만든 브리핑의 등락률 (runSession 이 모아 알림 묶음에 쓴다) */
  private readonly rateOf = new Map<number, number | null>();
  private running = false;
  private _lastRun: LastRun | null = null;

  constructor(private readonly deps: BriefingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get lastRun(): LastRun | null {
    return this._lastRun;
  }

  /** 4단계(푸시)에서 알림 발송기를 여기에 붙인다. */
  onBriefing(listener: BriefingListener): void {
    this.listeners.push(listener);
  }

  /** 실행 한 번이 끝나면 (예약·수동 모두). 새로 만든 브리핑이 없으면 부르지 않는다 */
  onSessionDone(listener: SessionListener): void {
    this.sessionListeners.push(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runSession(session: BriefingSession, opts: { codes?: string[]; force?: boolean; trigger?: "schedule" | "manual" } = {}): Promise<RunResult> {
    if (this.running) throw new Error("브리핑이 이미 실행 중입니다");
    this.running = true;
    const startedAt = seoulIso(this.now());
    const date = seoulDate(this.now());
    const results: RunResult["results"] = [];
    const created: SessionDone["created"] = [];
    try {
      let stocks = await this.deps.db.selectFrom("registered_stocks").selectAll().orderBy("created_at").execute();
      if (opts.codes?.length) stocks = stocks.filter((s) => opts.codes!.includes(s.code));
      await this.deps.collector.warm?.(stocks.map((s) => s.code));
      for (const row of stocks) {
        const stock: RegisteredStock = {
          code: row.code, name: row.name, market: row.market as RegisteredStock["market"],
          quantity: row.quantity, avgPrice: row.avg_price, memo: row.memo, createdAt: row.created_at, updatedAt: row.updated_at,
        };
        if (!opts.force) {
          const existing = await this.find(stock.code, date, session);
          if (existing && existing.status === "ok") {
            results.push({ code: stock.code, name: stock.name, status: "ok", briefingId: existing.id, error: null, summary: existing.summary });
            continue;
          }
          // 휴장일(공휴일·주말)에는 시세가 움직이지 않아 의미 없는 브리핑이 되므로 건너뛴다 (강제 실행은 예외)
          if (this.deps.calendar) {
            const trading = await this.deps.calendar.isTradingDay(stock.code).catch(() => true);
            if (!trading) {
              this.deps.log?.info({ code: stock.code, session }, "휴장일이라 브리핑 건너뜀");
              results.push({ code: stock.code, name: stock.name, status: "skipped", briefingId: null, error: "휴장일", summary: null });
              continue;
            }
          }
        }
        const b = await this.generateOne(stock, session, date);
        if (b.status === "ok") created.push({ briefing: b, changeRate: this.rateOf.get(b.id) ?? null });
        this.rateOf.delete(b.id);
        results.push({ code: b.code, name: stock.name, status: b.status, briefingId: b.id, error: b.error, summary: b.status === "ok" ? b.summary : null });
      }
    } finally {
      this.running = false;
    }
    const finishedAt = seoulIso(this.now());
    this._lastRun = {
      session,
      date,
      startedAt,
      finishedAt,
      ok: results.filter((r) => r.status === "ok").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      lastError: results.find((r) => r.status === "failed")?.error ?? null,
      trigger: opts.trigger ?? "manual",
    };
    if (created.length > 0) {
      for (const l of this.sessionListeners) {
        try {
          await l({ session, date, trigger: opts.trigger ?? "manual", created });
        } catch (e) {
          this.deps.log?.warn({ err: (e as Error).message }, "세션 리스너 오류");
        }
      }
    }
    return { session, date, results, startedAt, finishedAt };
  }

  /** 직전 브리핑(오늘 이전 세션 또는 어제) 요약 — 같은 말 반복을 피하고 "달라진 점"을 쓰게 한다 */
  private async previousSummary(code: string, date: string, session: BriefingSession): Promise<string | null> {
    const rows = await this.deps.db
      .selectFrom("briefings")
      .select(["briefing_date", "session", "summary", "status"])
      .where("code", "=", code)
      .where("status", "=", "ok")
      .orderBy("briefing_date", "desc")
      .orderBy("created_at", "desc")
      .limit(3)
      .execute();
    const prev = rows.find((r) => r.briefing_date < date || (r.briefing_date === date && r.session !== session));
    return prev ? `${prev.briefing_date} ${prev.session === "morning" ? "오전" : "오후"}: ${prev.summary}` : null;
  }

  async generateOne(stock: RegisteredStock, session: BriefingSession, date = seoulDate(this.now())): Promise<Briefing> {
    const log = this.deps.log;
    const [snapshot, previous] = await Promise.all([this.deps.collector.collectBriefing(stock), this.previousSummary(stock.code, date, session)]);
    const vars = {
      stock_name: stock.name,
      stock_code: stock.code,
      session_label: SESSION_LABEL[session],
      date,
      quantity: stock.quantity === null ? "미입력" : `${stock.quantity}주`,
      avg_price: stock.avgPrice === null ? "미입력" : `${stock.avgPrice.toLocaleString("ko-KR")}원`,
      missing_list: snapshot.missing.length ? snapshot.missing.join(", ") : "없음",
      notes_list: snapshot.notes?.length ? snapshot.notes.join(" / ") : "없음",
      market_state: snapshot.marketState?.label ?? "확인 안 됨",
      previous_summary: previous ?? "없음 (첫 브리핑)",
      data_json: JSON.stringify(snapshotForPrompt(snapshot), null, 1),
    };

    let detail = "";
    let summary = "";
    let model = this.deps.generator.model;
    let error: string | null = null;
    try {
      const detailPrompt = await this.deps.prompts.load("briefing_detail");
      const d = await this.deps.generator.generate({
        system: detailPrompt.system,
        user: renderTemplate(detailPrompt.userTemplate, vars),
        maxTokens: 4096,
        effort: "medium",
        label: `briefing_detail:${stock.code}`,
      });
      detail = d.text;
      model = d.model;
      log?.info({ code: stock.code, usage: d.usage }, "상세 브리핑 생성");

      const summaryPrompt = await this.deps.prompts.load("briefing_summary");
      const s = await this.deps.generator.generate({
        system: summaryPrompt.system,
        user: renderTemplate(summaryPrompt.userTemplate, { ...vars, detail }),
        maxTokens: 512,
        effort: "low",
        label: `briefing_summary:${stock.code}`,
      });
      summary = normalizeSummary(s.text);
    } catch (e) {
      error = e instanceof GenerationError ? `${e.kind}: ${e.message}` : (e as Error).message;
      log?.warn({ code: stock.code, err: error }, "브리핑 생성 실패");
    }

    const status: "ok" | "failed" = error ? "failed" : "ok";
    const createdAt = seoulIso(this.now());
    const values = {
      code: stock.code,
      session,
      briefing_date: date,
      status,
      summary: status === "ok" ? summary : `브리핑 생성 실패: ${error}`,
      detail,
      data_snapshot: JSON.stringify(snapshot),
      missing_data: JSON.stringify(snapshot.missing),
      model,
      error,
      created_at: createdAt,
    };
    await this.deps.db
      .insertInto("briefings")
      .values(values)
      .onConflict((oc) => oc.columns(["code", "briefing_date", "session"]).doUpdateSet(values))
      .execute();
    const saved = (await this.find(stock.code, date, session))!;
    if (this.rateOf.size > 500) this.rateOf.clear();
    this.rateOf.set(saved.id, snapshot.quote?.changeRate ?? null);
    if (saved.status === "ok") {
      for (const l of this.listeners) {
        try {
          await l(saved);
        } catch (e) {
          log?.warn({ err: (e as Error).message }, "브리핑 리스너 오류");
        }
      }
    }
    return saved;
  }

  // ── 조회 ──────────────────────────────────────────────────────

  async find(code: string, date: string, session: BriefingSession): Promise<Briefing | null> {
    const r = await this.deps.db
      .selectFrom("briefings")
      .leftJoin("registered_stocks", "registered_stocks.code", "briefings.code")
      .select(BRIEFING_COLS)
      .where("briefings.code", "=", code)
      .where("briefing_date", "=", date)
      .where("session", "=", session)
      .executeTakeFirst();
    return r ? toBriefing(r) : null;
  }

  async list(filter: { code?: string; date?: string; session?: BriefingSession; limit?: number }): Promise<Briefing[]> {
    let q = this.deps.db
      .selectFrom("briefings")
      .leftJoin("registered_stocks", "registered_stocks.code", "briefings.code")
      .select(BRIEFING_COLS)
      .orderBy("briefing_date", "desc")
      .orderBy("briefings.created_at", "desc")
      .limit(filter.limit ?? 50);
    if (filter.code) q = q.where("briefings.code", "=", filter.code);
    if (filter.date) q = q.where("briefing_date", "=", filter.date);
    if (filter.session) q = q.where("session", "=", filter.session);
    return (await q.execute()).map(toBriefing);
  }

  async get(id: number): Promise<BriefingWithData> {
    const r = await this.deps.db
      .selectFrom("briefings")
      .leftJoin("registered_stocks", "registered_stocks.code", "briefings.code")
      .select([...BRIEFING_COLS, "briefings.data_snapshot as data_snapshot"])
      .where("briefings.id", "=", id)
      .executeTakeFirst();
    if (!r) throw new NotFoundError(`브리핑 ${id} 이 없습니다`);
    return { ...toBriefing(r), data: safeJson<BriefingSnapshot>(r.data_snapshot) };
  }

  /** 등록 종목별 가장 최근 브리핑 (앱 홈 화면용) */
  async latestPerStock(): Promise<Array<{ code: string; name: string; latest: Briefing | null }>> {
    const stocks = await this.deps.db.selectFrom("registered_stocks").select(["code", "name"]).orderBy("created_at").execute();
    const out = [];
    for (const s of stocks) {
      const [latest] = await this.list({ code: s.code, limit: 1 });
      out.push({ code: s.code, name: s.name, latest: latest ?? null });
    }
    return out;
  }
}

const BRIEFING_COLS = [
  "briefings.id as id",
  "briefings.code as code",
  "registered_stocks.name as name",
  "briefings.session as session",
  "briefings.briefing_date as briefing_date",
  "briefings.status as status",
  "briefings.summary as summary",
  "briefings.detail as detail",
  "briefings.missing_data as missing_data",
  "briefings.model as model",
  "briefings.error as error",
  "briefings.created_at as created_at",
] as const;

function toBriefing(r: {
  id: number; code: string; name: string | null; session: string; briefing_date: string; status: string;
  summary: string; detail: string; missing_data: string; model: string; error: string | null; created_at: string;
}): Briefing {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    session: r.session as BriefingSession,
    date: r.briefing_date,
    status: r.status as "ok" | "failed",
    summary: r.summary,
    detail: r.detail,
    missing: safeJson<string[]>(r.missing_data) ?? [],
    model: r.model,
    error: r.error,
    createdAt: r.created_at,
  };
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** 요약은 알림 본문이므로 마크다운 기호를 걷어내고 3줄로 제한 */
export function normalizeSummary(text: string): string {
  return text
    .split(/\r?\n/)
    // 앞의 글머리 기호(-, *, •)나 번호(1. / 2) / 3:)만 걷어낸다. "189만원…" 처럼 숫자로 시작하는 본문은 남겨야 한다.
    .map((l) => l.replace(/^\s*(?:[-*•]\s+|\d{1,2}\s*[.):]\s+)?/, "").replace(/[*_`#]/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 3)
    .join("\n");
}

function kstMinute(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 16) : new Date(t + 9 * 3_600_000).toISOString().slice(0, 16);
}

/** 프롬프트에 넣을 때 토큰을 아끼기 위해 불필요한 필드를 줄인다 */
export function snapshotForPrompt(s: BriefingSnapshot): Record<string, unknown> {
  return {
    stock: s.stock,
    marketState: s.marketState ? { phase: s.marketState.phase, label: s.marketState.label, lastRegularDate: s.marketState.lastRegularDate } : null,
    quote: s.quote,
    holding: s.holding,
    technical: s.technical,
    recentCandles: s.recentCandles,
    // 뉴스 시각은 한국 시간으로 맞춰 넣는다 (네이버는 +09:00, 구글은 Z 로 와서 섞이면 모델이 헷갈린다)
    news: s.news?.map((n) => ({ title: n.title, source: n.source, publishedAt: kstMinute(n.publishedAt), summary: n.summary })),
    disclosures: s.disclosures?.map((d) => ({ title: d.title, filedAt: d.filedAt, filer: d.filer })),
    investorFlow: s.investorFlow,
  };
}
