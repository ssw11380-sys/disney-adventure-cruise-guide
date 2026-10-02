import type { Db } from "../db/index.js";
import type { RegisteredStock } from "../domain/types.js";
import { isKrCode, type Currency } from "../lib/codes.js";
import { NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import { GenerationError, type TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptStore } from "../llm/prompts.js";
import type { TechnicalSummary } from "../analysis/indicators.js";
import { cleanDetail, cleanPrevious, codeSummaryLine, normalizeSummary, secondLine, sourceText, unknownNumbers } from "./briefingWording.js";
import type { BriefingSnapshot, DataCollector } from "./collector.js";

// 요약 정리(normalizeSummary)는 검사기(briefingWording.ts)와 함께 쓰므로 그쪽에 두고, 예전 이름 그대로 여기서도 내보낸다
export { normalizeSummary };

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
  /** 세션이 다루는 그 시장의 거래일(briefingMarketDate)이 휴장일이면 해당 시장 종목을 건너뛴다 (providers/market/calendar.MarketCalendar) */
  calendar?: { isTradingDate(market: "KR" | "US", date: string): Promise<boolean> } | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
  /**
   * 종목 브리핑 AI 글 안전하게 (브리핑 2차 6, 플래그 briefingSafeWording): 새 프롬프트·지지/저항 후보 빼기·가격 줄 요약·금지어 검사.
   * 브리핑 한 건을 만들 때 한 번 읽는다. 없거나 읽기가 실패하면 끔 (예전 프롬프트·요약 그대로)
   */
  safeWording?: () => Promise<boolean>;
  /** 한 실행에서 한 번 읽는다. 켜면 두 종목을 준비하고 저장·알림은 등록 순서를 지킨다. 없거나 읽기 실패 시 순차 실행 */
  parallel?: () => Promise<boolean>;
}

export interface BriefingListener {
  (briefing: Briefing): Promise<void> | void;
}

/** 한 번의 실행(세션)이 끝났을 때: 이번에 새로 만든 브리핑(성공만)과 브리핑 시점 등락률 (3-19 알림 묶음) */
export interface SessionDone {
  session: BriefingSession;
  date: string;
  trigger: "schedule" | "manual";
  /** 일부 종목만 실행(codes 지정, 예: 상세의 "이 종목 다시 만들기") */
  partial: boolean;
  created: Array<{ briefing: Briefing; changeRate: number | null }>;
  /** 이미 만든 브리핑도 다시 만들었는지 (수동 실행의 force). 계좌 브리핑(3-31)도 이때만 덮어쓴다 */
  force?: boolean;
  /** 브리핑 3차 2 (늦음·실패 안내 실행 기록): 이 실행을 시작한 시각 */
  startedAt?: string;
  /** 정기 실행: 스케줄러가 부른 시각 · 그 cron 의 예약 시각(ISO, 모르면 null). 수동 실행이면 null */
  firedAt?: string | null;
  scheduledAt?: string | null;
}
export type SessionListener = (done: SessionDone) => Promise<void> | void;
/** 실행 한 번이 끝날 때마다 (새로 만든 브리핑이 없어도, 도중에 예외로 끝나도). 계좌 브리핑(3-31)과 세션 알림이 여기에 붙는다 */
export type RunDoneListener = (done: SessionDone & { force: boolean; results: RunResult["results"] }) => Promise<void> | void;
/** 실행 한 번이 시작될 때 (알림이 이 실행 동안 쓸 플래그 값을 여기서 정한다) */
export type SessionStartListener = (start: { session: BriefingSession; trigger: "schedule" | "manual"; partial: boolean }) => Promise<void> | void;

/** 지금 도는 실행 (브리핑 3차 2 '아직 만드는 중' 안내). 실행 완료 리스너(계좌 브리핑·알림)가 끝날 때까지 남는다 */
export interface RunProgress {
  session: BriefingSession;
  date: string;
  trigger: "schedule" | "manual";
  partial: boolean;
  startedAt: string;
  /** 이번 실행의 종목 수 (목록을 읽기 전에는 0) */
  total: number;
  /** 끝난 종목 수 (성공·실패·건너뜀·이미 있음 모두) */
  done: number;
}

/**
 * 브리핑 파이프라인: 수집 → 프롬프트 조립 → Claude(상세) → Claude(요약) → 저장.
 * 병렬 플래그가 켜지면 최대 두 종목을 준비한다. 저장·알림은 등록 순서를 지키며 실패도 저장한다.
 */
export class BriefingService {
  private readonly now: () => Date;
  private readonly listeners: BriefingListener[] = [];
  private readonly sessionListeners: SessionListener[] = [];
  private readonly startListeners: SessionStartListener[] = [];
  private readonly runDoneListeners: RunDoneListener[] = [];
  private running = false;
  /** 지금 실행이 끝나기를 기다리는 정기 실행 (wait) */
  private idleWaiters: Array<() => void> = [];
  private _lastRun: LastRun | null = null;
  private _progress: RunProgress | null = null;

  constructor(private readonly deps: BriefingServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get lastRun(): LastRun | null {
    return this._lastRun;
  }

  /** 지금 도는 실행 (없으면 null) — 브리핑 3차 2 '아직 만드는 중' 안내 */
  get progress(): RunProgress | null {
    return this._progress;
  }

  /** 4단계(푸시)에서 알림 발송기를 여기에 붙인다. */
  onBriefing(listener: BriefingListener): void {
    this.listeners.push(listener);
  }

  /** 실행 한 번이 끝나면 (예약·수동 모두). 새로 만든 브리핑이 없으면 부르지 않는다 */
  onSessionDone(listener: SessionListener): void {
    this.sessionListeners.push(listener);
  }

  onSessionStart(listener: SessionStartListener): void {
    this.startListeners.push(listener);
  }

  /**
   * 실행 한 번이 끝나면 늘 (예약·수동, 새로 만든 브리핑이 없어도). 리스너가 끝날 때까지 실행 중(isRunning)으로 본다 —
   * 계좌 브리핑을 만드는 동안 앱 백그라운드 알림이 기다렸다가 한 번에 알리고, 다른 실행이 겹쳐 시작하지 않게
   */
  onRunDone(listener: RunDoneListener): void {
    this.runDoneListeners.push(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * wait: 다른 실행(수동)이 도는 중이면 오류 대신 끝날 때까지 기다렸다가 이어서 돈다 (정기 실행용 — 예약 시각에 겹쳐도 회차가 사라지지 않게)
   * staleBefore: 이 시각보다 먼저 만든 성공 브리핑은 이미 있어도 다시 만든다 (정기 실행이 예약 시각을 넘긴다 —
   *   예약 시각 전에 수동으로 미리 만든 장중·장전 브리핑이 그날 회차로 남거나 회차 알림에서 빠지지 않게)
   */
  async runSession(
    session: BriefingSession,
    opts: { codes?: string[]; force?: boolean; trigger?: "schedule" | "manual"; wait?: boolean; staleBefore?: Date; firedAt?: Date; scheduledAt?: string | null } = {},
  ): Promise<RunResult> {
    if (this.running && !opts.wait) throw new Error("브리핑이 이미 실행 중입니다");
    // 끝나는 순간 여럿이 깨어나도 먼저 잡은 쪽만 돌고 나머지는 다시 기다린다 (검사와 잡기 사이에 await 없음)
    while (this.running) await new Promise<void>((r) => this.idleWaiters.push(r));
    this.running = true;
    const startedAt = seoulIso(this.now());
    const date = seoulDate(this.now());
    const results: RunResult["results"] = [];
    const created: SessionDone["created"] = [];
    const trigger = opts.trigger ?? "manual";
    const partial = !!opts.codes?.length;
    const progress: RunProgress = { session, date, trigger, partial, startedAt, total: 0, done: 0 };
    this._progress = progress;
    // 휴장 판단은 세션마다 시장별로 한 번 — 세션 날짜(date)가 다루는 현지 거래일로 (자정을 넘겨도, 달력을 다시 받아도 종목마다 달라지지 않게)
    const trading = new Map<"KR" | "US", Promise<boolean>>();
    const tradingFor = (code: string): Promise<boolean> => {
      const market = isKrCode(code) ? "KR" : "US";
      let p = trading.get(market);
      if (!p) {
        const cal = this.deps.calendar;
        p = cal ? Promise.resolve().then(() => cal.isTradingDate(market, briefingMarketDate(market, session, date))).catch(() => true) : Promise.resolve(true);
        trading.set(market, p);
      }
      return p;
    };
    for (const l of this.startListeners) {
      try {
        await l({ session, trigger, partial });
      } catch (e) {
        this.deps.log?.warn({ err: (e as Error).message }, "세션 시작 리스너 오류");
      }
    }
    try {
      const parallel = await this.parallelOn();
      let stocks = await this.deps.db.selectFrom("registered_stocks").selectAll().orderBy("created_at").execute();
      if (opts.codes?.length) stocks = stocks.filter((s) => opts.codes!.includes(s.code));
      progress.total = stocks.length;
      await this.deps.collector.warm?.(stocks.map((s) => s.code));
      const runStock = async (row: (typeof stocks)[number], waitTurn?: () => Promise<void>): Promise<void> => {
        const stock: RegisteredStock = {
          code: row.code, name: row.name, market: row.market as RegisteredStock["market"],
          quantity: row.quantity, avgPrice: row.avg_price, memo: row.memo, createdAt: row.created_at, updatedAt: row.updated_at,
        };
        if (!opts.force) {
          const existing = await this.find(stock.code, date, session);
          if (existing && existing.status === "ok" && !madeBefore(existing, opts.staleBefore)) {
            if (waitTurn) await waitTurn();
            results.push({ code: stock.code, name: stock.name, status: "ok", briefingId: existing.id, error: null, summary: existing.summary });
            return;
          }
          // 휴장일(공휴일·주말)에는 시세가 움직이지 않아 의미 없는 브리핑이 되므로 건너뛴다 (강제 실행은 예외)
          if (!(await tradingFor(stock.code))) {
            if (waitTurn) await waitTurn();
            this.deps.log?.info({ code: stock.code, session }, "휴장일이라 브리핑 건너뜀");
            results.push({ code: stock.code, name: stock.name, status: "skipped", briefingId: null, error: "휴장일", summary: null });
            return;
          }
        }
        const { briefing: b, changeRate, error } = await this.generate(stock, session, date, waitTurn);
        if (!error) created.push({ briefing: b, changeRate });
        results.push({ code: b.code, name: stock.name, status: error ? "failed" : "ok", briefingId: b.id, error, summary: error ? null : b.summary });
      };
      if (parallel) {
        await runTwoOrdered(stocks, async (row, waitTurn) => {
          await runStock(row, waitTurn);
          progress.done = results.length;
        });
      } else {
        for (const row of stocks) {
          progress.done = results.length;
          await runStock(row);
        }
      }
    } finally {
      // 도중에 예외로 끝나도 이미 만든 브리핑은 알린다
      progress.done = results.length;
      const done = {
        session, date, trigger, partial, created, force: opts.force === true, results,
        // 브리핑 3차 2 실행 기록 (더하기만 — 다른 리스너는 모르는 칸)
        startedAt, firedAt: opts.firedAt ? seoulIso(opts.firedAt) : null, scheduledAt: opts.scheduledAt ?? null,
      };
      if (created.length > 0) {
        for (const l of this.sessionListeners) {
          try {
            await l(done);
          } catch (e) {
            this.deps.log?.warn({ err: (e as Error).message }, "세션 리스너 오류");
          }
        }
      }
      for (const l of this.runDoneListeners) {
        try {
          await l(done);
        } catch (e) {
          this.deps.log?.warn({ err: (e as Error).message }, "실행 완료 리스너 오류");
        }
      }
      this._progress = null;
      this.running = false;
      for (const w of this.idleWaiters.splice(0)) w();
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
      trigger,
    };
    return { session, date, results, startedAt, finishedAt };
  }

  private async parallelOn(): Promise<boolean> {
    try {
      return (await this.deps.parallel?.()) === true;
    } catch {
      return false;
    }
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

  /** 플래그 briefingSafeWording (브리핑 2차 6). 의존성이 없거나 읽기가 실패하면 끔 */
  private async safeWordingOn(): Promise<boolean> {
    const read = this.deps.safeWording;
    if (!read) return false;
    try {
      return (await read()) === true;
    } catch {
      return false;
    }
  }

  async generateOne(stock: RegisteredStock, session: BriefingSession, date = seoulDate(this.now())): Promise<Briefing> {
    return (await this.generate(stock, session, date)).briefing;
  }

  /**
   * 브리핑 한 건 + 브리핑 시점 등락률 (알림 묶음용). error 는 이번 생성이 실패했을 때의 사유.
   * 실패해도 같은 날짜·회차에 성공 브리핑이 이미 있으면(강제 다시 만들기) 그 본문을 지우지 않고 그대로 둔다 — briefing 은 남은 성공 브리핑
   */
  private async generate(
    stock: RegisteredStock,
    session: BriefingSession,
    date: string,
    waitTurn?: () => Promise<void>,
  ): Promise<{ briefing: Briefing; changeRate: number | null; error: string | null }> {
    const log = this.deps.log;
    // 브리핑 2차 6: 한 건을 만드는 동안 같은 값을 쓴다 (꺼져 있으면 프롬프트·데이터·요약·상세가 예전과 한 글자도 같다)
    const safe = await this.safeWordingOn();
    const [snapshot, previous] = await Promise.all([this.deps.collector.collectBriefing(stock), this.previousSummary(stock.code, date, session)]);
    // 평균 단가는 종목 통화로 저장된다 (미국은 달러). JSON 의 quote.currency 와 맞추고, 시세를 못 받았으면 코드 규칙으로
    const currency: Currency = snapshot.quote?.currency ?? (isKrCode(stock.code) ? "KRW" : "USD");
    const source = safe ? sourceText(snapshot) : "";
    const vars = {
      stock_name: stock.name,
      stock_code: stock.code,
      session_label: SESSION_LABEL[session],
      date,
      quantity: stock.quantity === null ? "미입력" : `${stock.quantity}주`,
      avg_price: stock.avgPrice === null ? "미입력" : promptPrice(stock.avgPrice, currency),
      missing_list: snapshot.missing.length ? snapshot.missing.join(", ") : "없음",
      notes_list: snapshot.notes?.length ? snapshot.notes.join(" / ") : "없음",
      market_state: snapshot.marketState?.label ?? "확인 안 됨",
      // 켜져 있으면 예전 형식 요약의 '체크포인트·저항' 줄을 빼고 넘긴다
      previous_summary: previous === null ? "없음 (첫 브리핑)" : safe ? cleanPrevious(previous, source) : previous,
      data_json: JSON.stringify(snapshotForPrompt(snapshot, { safe }), null, 1),
    };

    let detail = "";
    let summary = "";
    let model = this.deps.generator.model;
    let error: string | null = null;
    try {
      // 모델 호출 label 은 켜도 꺼도 같다 (briefing_detail:코드 · briefing_summary:코드)
      const detailPrompt = await this.deps.prompts.load(safe ? "briefing_detail_safe" : "briefing_detail");
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
      // 켜져 있으면 걸린 줄을 뺀 상세를 저장하고 요약 모델에도 그것을 넘긴다
      const cleaned = safe ? cleanDetail(d.text, source) : null;
      if (cleaned) detail = cleaned.text;

      const summaryPrompt = await this.deps.prompts.load(safe ? "briefing_summary_safe" : "briefing_summary");
      const s = await this.deps.generator.generate({
        system: summaryPrompt.system,
        user: renderTemplate(summaryPrompt.userTemplate, { ...vars, detail }),
        maxTokens: 512,
        effort: "low",
        label: `briefing_summary:${stock.code}`,
      });
      if (cleaned) {
        // 첫 줄은 시세로 만든 가격 줄, 둘째 줄은 검사를 통과한 모델 한 줄 또는 개수 줄
        const second = secondLine(snapshot, s.text);
        summary = `${codeSummaryLine(snapshot.quote)}\n${second.line}`;
        // 숫자 대조는 로그만 (거절하지 않는다). 브리핑 1건에 1줄
        const known = [vars.data_json, vars.avg_price, vars.quantity, vars.date].join("\n");
        log?.info({ code: stock.code, dropped: cleaned.dropped, secondLine: second.from, unknownNumbers: unknownNumbers(detail, known) }, "종목 브리핑 문장 검사");
      } else {
        summary = normalizeSummary(s.text);
      }
    } catch (e) {
      error = e instanceof GenerationError ? `${e.kind}: ${e.message}` : (e as Error).message;
      log?.warn({ code: stock.code, err: error }, "브리핑 생성 실패");
    }

    const status: "ok" | "failed" = error ? "failed" : "ok";
    // 자료·상세·요약 준비만 겹친다. 앞 종목의 저장과 알림이 끝나야 시각을 정하고 저장한다.
    // 앞 종목에서 예상 밖 예외가 나면 뒤 종목의 준비 결과를 저장하지 않는다.
    if (waitTurn) await waitTurn();
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
      .onConflict((oc) => {
        const update = oc.columns(["code", "briefing_date", "session"]).doUpdateSet(values);
        // 실패 기록은 성공 브리핑을 덮어쓰지 않는다 (없거나 실패였던 행만)
        return status === "ok" ? update : update.where("briefings.status", "<>", "ok");
      })
      .execute();
    const saved = (await this.find(stock.code, date, session))!;
    if (status === "ok") {
      for (const l of this.listeners) {
        try {
          await l(saved);
        } catch (e) {
          log?.warn({ err: (e as Error).message }, "브리핑 리스너 오류");
        }
      }
    } else if (saved.status === "ok") {
      log?.info({ code: stock.code, session, date }, "다시 만들기 실패 — 이전 브리핑을 그대로 둠");
      error = `${error} (이전 브리핑은 그대로 둡니다)`;
    }
    return { briefing: saved, changeRate: snapshot.quote?.changeRate ?? null, error };
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

/** 두 종목까지 준비하되 저장 차례를 지킨다. 예외가 나면 새 작업을 멈추고 이미 시작한 작업을 모두 회수한다. */
async function runTwoOrdered<T>(items: readonly T[], run: (item: T, waitTurn: () => Promise<void>) => Promise<void>): Promise<void> {
  const turns = items.map(() => {
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    return { done, release };
  });
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      const previous = turns[index - 1]?.done;
      const waitTurn = async () => {
        await previous;
        const earlier = failures.find((failure) => failure.index < index);
        if (earlier) throw earlier.error;
      };
      try {
        await run(items[index]!, waitTurn);
      } catch (error) {
        failures.push({ index, error });
        stopped = true;
      } finally {
        // 뒤 종목의 수집이 먼저 실패해도 앞 종목이 끝날 때까지 세션 잠금을 놓지 않는다.
        await previous;
        turns[index]!.release();
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(2, items.length) }, worker));
  const first = failures.sort((a, b) => a.index - b.index)[0];
  if (first) throw first.error;
  const unexpected = settled.find((result) => result.status === "rejected");
  if (unexpected?.status === "rejected") throw unexpected.reason;
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

/** cutoff(정기 실행 시각)보다 먼저 만든 브리핑인지. 저장 시각은 초 단위라 cutoff 도 초로 내려 비교한다 */
function madeBefore(b: Briefing, cutoff: Date | undefined): boolean {
  if (!cutoff) return false;
  const t = Date.parse(b.createdAt);
  return !Number.isNaN(t) && t < Math.floor(cutoff.getTime() / 1000) * 1000;
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * 브리핑 세션(서울 날짜 date)이 다루는 그 시장의 현지 거래일 — 휴장 판단 기준 ("지금"의 현지 날짜가 아니다).
 *  - 한국: 세션 날짜 그대로 (오전은 장 시작 전, 오후는 장 마감 후)
 *  - 미국 오후: 세션 날짜 (한국 오후는 뉴욕 새벽, 그날 밤 열릴 정규장에 딸린 주간거래 중)
 *  - 미국 오전: 지난밤(세션 날짜 전날) 정규장. 월요일은 주말을 건너 금요일 — 금요일 정규장은 토요일 새벽(한국)에 끝나
 *    평일 오전 브리핑이 아직 보지 못했다 (뉴욕 날짜로 오늘을 보면 일요일이라 휴장으로 빠졌다)
 */
export function briefingMarketDate(market: "KR" | "US", session: BriefingSession, date: string): string {
  if (market === "KR" || session === "afternoon") return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() === 1 ? 3 : 1));
  return d.toISOString().slice(0, 10);
}

/** 프롬프트에 넣는 가격 표기. 시스템 프롬프트의 통화 규칙과 같게 KRW "184,000원", USD "$340.22" */
function promptPrice(n: number, currency: Currency): string {
  return currency === "USD" ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : `${n.toLocaleString("ko-KR")}원`;
}

function kstMinute(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 16) : new Date(t + 9 * 3_600_000).toISOString().slice(0, 16);
}

/**
 * 프롬프트에 넣을 때 토큰을 아끼기 위해 불필요한 필드를 줄인다.
 * safe(브리핑 2차 6): 기술 지표에서 지지·저항 후보(supportResistance)·RSI 구간 이름(rsiZone)·MACD 교차 이름(macdCross)을 뺀다 —
 * 모델이 가격 신호로 옮겨 쓰지 않게 (나머지 수치와 maAlignment 는 그대로). 옵션이 없으면 예전과 같은 객체
 */
export function snapshotForPrompt(s: BriefingSnapshot, opts: { safe?: boolean } = {}): Record<string, unknown> {
  return {
    stock: s.stock,
    marketState: s.marketState ? { phase: s.marketState.phase, label: s.marketState.label, lastRegularDate: s.marketState.lastRegularDate } : null,
    quote: s.quote,
    holding: s.holding,
    technical: opts.safe ? withoutSignals(s.technical) : s.technical,
    recentCandles: s.recentCandles,
    // 뉴스 시각은 한국 시간으로 맞춰 넣는다 (네이버는 +09:00, 구글은 Z 로 와서 섞이면 모델이 헷갈린다)
    news: s.news?.map((n) => ({ title: n.title, source: n.source, publishedAt: kstMinute(n.publishedAt), summary: n.summary })),
    disclosures: s.disclosures?.map((d) => ({ title: d.title, filedAt: d.filedAt, filer: d.filer })),
    investorFlow: s.investorFlow,
  };
}

/** 기술 지표에서 신호 이름·후보 가격(지지·저항 후보, RSI 구간, MACD 교차)을 뺀 사본 */
function withoutSignals(t: TechnicalSummary | null): Omit<TechnicalSummary, "supportResistance" | "rsiZone" | "macdCross"> | null {
  if (!t) return null;
  const out: Partial<TechnicalSummary> = { ...t };
  delete out.supportResistance;
  delete out.rsiZone;
  delete out.macdCross;
  return out as Omit<TechnicalSummary, "supportResistance" | "rsiZone" | "macdCross">;
}
