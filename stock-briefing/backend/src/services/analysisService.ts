import type { Db } from "../db/index.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulDateOf, seoulIso } from "../lib/time.js";
import type { GenerateRequest, TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptName, type PromptStore } from "../llm/prompts.js";
import type { AnalysisSnapshot, DataCollector } from "./collector.js";
import { verifyReport, type ReportVerification } from "./reportVerification.js";
import { ReportTiming, type ReportLog } from "./reportTiming.js";
import { checkpointGenerator, GenerationJobs, type GenerationContext } from "./generationJobs.js";

export type AnalysisKind = "company" | "value" | "technical";

const PROMPT_FOR: Record<AnalysisKind, PromptName> = {
  company: "company_overview",
  value: "value_analysis",
  technical: "technical_analysis",
};

/** 캐시 유효 시간. 회사 소개는 잘 안 바뀌고, 기술적 분석은 매일 달라진다. */
const TTL_MS: Record<AnalysisKind, number> = {
  company: 30 * 86_400_000,
  value: 7 * 86_400_000,
  technical: 1 * 86_400_000,
};

export interface Analysis {
  id: number;
  code: string;
  kind: AnalysisKind;
  content: string;
  missing: string[];
  model: string;
  createdAt: string;
  cached: boolean;
  verification?: ReportVerification;
}

export interface AnalysisRequestState {
  id: string;
  status: "pending" | "completed" | "failed" | "unknown";
  result: Analysis | null;
}

interface TrackedAnalysisRequest extends AnalysisRequestState {
  promise: Promise<Analysis>;
  settledAt: number | null;
}
const REQUEST_LIMIT = 256;
const REQUEST_TTL_MS = 30 * 60_000;

export interface AnalysisServiceDeps {
  db: Db;
  collector: DataCollector;
  generator: TextGenerator;
  prompts: PromptStore;
  /** 종목 마스터에 없을 때 이름·시장 찾기 (StockService.preview: 외부 검색으로 대신 찾는다 — 신규 상장 등). 모르면 null */
  lookup?: (code: string) => Promise<{ code: string; name: string; market: string } | null>;
  now?: () => Date;
  log?: ReportLog;
  jobs?: GenerationJobs;
}

/** 종목 상세 탭(회사 소개 / 가치투자 / 기술적 분석) 생성 + 캐시 */
export class AnalysisService {
  private readonly now: () => Date;
  /** 이 서버에서 만드는 중인 분석 (종목·종류마다 하나 — 서명은 이름·시장까지, 계정 A단계) */
  private readonly inflight = new Map<string, { signature: string; promise: Promise<Analysis> }>();
  private readonly requests = new Map<string, TrackedAnalysisRequest>();
  private readonly activeGets = new Set<Promise<Analysis>>();
  private shuttingDown = false;
  private readonly jobs: GenerationJobs;
  private readonly generator: TextGenerator;

  constructor(private readonly deps: AnalysisServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.jobs = deps.jobs ?? new GenerationJobs(deps.db, { recordNow: this.now });
    this.generator = checkpointGenerator(deps.generator);
  }

  /**
   * 분석 글의 종목 이름·시장은 **공개 이름**(종목 마스터 → 코드가 정확히 같은 검색 결과)으로 만든다 — 캐시(analyses)는 모든 계정이 같이 쓰므로
   * 주인 등록 표의 이름(토스 동기화 이름 등)이 글·뉴스 검색에 실리면 이름만으로 주인 등록 종목이 드러난다 (계정 A단계 검증 8차).
   * 등록 표는 공개 이름을 못 찾을 때 주인에게만 쓴다.
   * publicOnly (주인 아닌 계정): 공개 이름을 못 찾으면 처음 보는 모르는 종목과 같은 404, 캐시는 **지금 공개 이름·시장으로 만든 글**만 준다
   * (고치기 전에 등록 표 이름으로 만든 캐시·공개 이름을 잠깐 못 찾아 등록 표 이름으로 만든 캐시는 공개 이름으로 새로 만든다). refresh·요청 추적은 보지 않는다
   */
  async get(code: string, kind: AnalysisKind, opts: { refresh?: boolean; requestKey?: string; publicOnly?: boolean } = {}): Promise<Analysis> {
    if (this.shuttingDown) throw new AppError(503, "SERVER_CLOSING", "서버가 재시작 중입니다. 잠시 뒤 다시 시도해 주세요.");
    const work = opts.publicOnly ? this.getPublic(code, kind) : this.getActive(code, kind, opts);
    this.activeGets.add(work);
    try {
      return await work;
    } finally {
      this.activeGets.delete(work);
    }
  }

  /** 연결이 끊겨도 시작한 조회·생성·저장은 DB 정리 전에 끝낸다. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled(this.activeGets);
  }

  private async getActive(code: string, kind: AnalysisKind, opts: { refresh?: boolean; requestKey?: string }): Promise<Analysis> {
    const key = `${code}:${kind}`;
    if (opts.requestKey) {
      const previous = await this.jobs.request<Analysis>(opts.requestKey);
      if (previous.status === "completed" && previous.result) return previous.result;
      if (previous.status === "failed") throw new AppError(409, "GENERATION_INTERRUPTED", "이전 생성이 중단됐습니다. 다시 만들기로 새로 요청해 주세요.");
    }
    const active = this.inflight.has(key) || (!!opts.requestKey && await this.jobs.running(`analysis:${key}`));
    if (!opts.refresh && !active) {
      const cached = await this.latest(code, kind);
      if (cached && this.fresh(cached.createdAt, kind)) {
        const result = { ...cached, cached: true };
        if (opts.requestKey) await this.jobs.completeRequest(opts.requestKey, `analysis:${key}`, result);
        return result;
      }
    }
    // 주인 보기: 공개 이름, 못 찾으면 등록 표 이름 (계정 A단계 검증 8차)
    const stock =
      (await this.publicStock(code)) ??
      (await this.deps.db.selectFrom("registered_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
      null;
    if (!stock) throw new NotFoundError(`종목 ${code} 을 찾을 수 없습니다`);
    return this.run(code, kind, stock, opts);
  }

  private async getPublic(code: string, kind: AnalysisKind): Promise<Analysis> {
    const stock = await this.publicStock(code);
    if (!stock) throw new NotFoundError(`종목 ${code} 을 찾을 수 없습니다`);
    const cached = await this.latestRow(code, kind);
    if (cached && this.fresh(cached.created_at, kind) && madeFor(cached.data_snapshot, stock)) return toAnalysis(cached);
    return this.run(code, kind, stock, {});
  }

  private fresh(createdAt: string, kind: AnalysisKind): boolean {
    return this.now().getTime() - Date.parse(createdAt) < TTL_MS[kind];
  }

  /**
   * 생성 작업 하나 (작업 키는 종목·종류마다 하나). 이름·시장을 작업 서명에 넣는다 (계정 A단계 — 등록 표 이름으로 만드는 중인 글에
   * 주인 아닌 계정이 붙지 않게): 같은 이름·시장이면 진행 중인 생성에 합류하고, 다르면 그 생성이 끝나기를 기다렸다가 따로 만든다
   */
  private run(code: string, kind: AnalysisKind, stock: StockIdentity, opts: { refresh?: boolean; requestKey?: string }): Promise<Analysis> {
    const key = `${code}:${kind}`;
    const signature = JSON.stringify(["analysis", code, kind, stock.name, stock.market]);
    const existing = this.inflight.get(key);
    if (existing && existing.signature === signature && !opts.requestKey) return existing.promise;
    const p = this.jobs
      .run<Analysis>(`analysis:${key}`, { signature, waitForDifferent: true, ...(opts.requestKey ? { requestKey: opts.requestKey } : {}), retryUncertain: opts.refresh === true }, (context) => this.generate(code, kind, stock, context))
      .finally(() => { if (this.inflight.get(key)?.promise === p) this.inflight.delete(key); });
    this.inflight.set(key, { signature, promise: p });
    return p;
  }

  /** 공개 이름·시장: 종목 마스터, 없으면 코드가 정확히 같은 검색 결과 (마스터를 받은 뒤 상장한 종목도 상세 화면·뉴스 탭처럼). 등록 표는 보지 않는다 */
  private async publicStock(code: string): Promise<StockIdentity | null> {
    return (await this.deps.db.selectFrom("listed_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ?? (await this.lookup(code));
  }

  /** 생성 요청을 즉시 시작한다. 같은 요청은 재생성하지 않고, 진행 중인 같은 종목 분석에도 합류한다. */
  getTracked(code: string, kind: AnalysisKind, requestId: string, opts: { refresh?: boolean } = {}): Promise<Analysis> {
    this.pruneRequests();
    const key = `${code}:${kind}:${requestId}`;
    const existing = this.requests.get(key);
    if (existing) return existing.promise;
    // 진행 중이거나 아직 회수할 수 있는 기록을 지우면 같은 요청이 AI를 다시 부를 수 있다.
    if (this.requests.size >= REQUEST_LIMIT) throw new AppError(429, "ANALYSIS_TRACKING_BUSY", "분석 결과 확인 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.");
    // 다른 화면이 갱신 중이면 유효한 예전 캐시보다 그 진행 결과를 먼저 기다린다.
    const work = this.get(code, kind, { ...opts, requestKey: key });
    const tracked: TrackedAnalysisRequest = { id: requestId, status: "pending", result: null, settledAt: null, promise: work };
    tracked.promise = work.then((result) => {
      tracked.status = "completed";
      tracked.result = result;
      tracked.settledAt = this.now().getTime();
      return result;
    }, (error: unknown) => {
      tracked.status = "failed";
      tracked.settledAt = this.now().getTime();
      throw error;
    });
    this.requests.set(key, tracked);
    return tracked.promise;
  }

  private pruneRequests(): void {
    const now = this.now().getTime();
    for (const [key, request] of this.requests) {
      if (request.settledAt !== null && now - request.settledAt >= REQUEST_TTL_MS) this.requests.delete(key);
    }
  }

  private async generate(code: string, kind: AnalysisKind, identity: StockIdentity, context: GenerationContext): Promise<Analysis> {
    const timing = new ReportTiming({ report: "분석", kind }, this.deps.log);
    let success = false;
    try {
      // 이름·시장은 작업을 시작할 때 정한 값 (공개 이름 — 계정 A단계 검증 8차). 서명에 들어 있어 이어 받은 작업도 같은 값이다
      const stock = await context.step("stock", async () => identity);

      const snapshot = await context.step("snapshot", () => this.deps.collector.collectAnalysis(stock, kind));
      timing.next("프롬프트");
      const prompt = await this.deps.prompts.load(PROMPT_FOR[kind]);
      const request: GenerateRequest = await context.step("request", async () => ({
        system: prompt.system,
        user: renderTemplate(prompt.userTemplate, {
          stock_name: stock.name,
          stock_code: stock.code,
          date: seoulDate(this.now()),
          missing_list: snapshot.missing.length ? snapshot.missing.join(", ") : "없음",
          notes_list: snapshot.notes?.length ? snapshot.notes.join(" / ") : "없음",
          market_state: snapshot.marketState?.label ?? "확인 안 됨",
          data_json: JSON.stringify(snapshotForPrompt(snapshot, kind), null, 1),
        }),
        maxTokens: 4096,
        effort: kind === "technical" ? "medium" : "high",
        label: `${PROMPT_FOR[kind]}:${code}`,
      }));
      timing.next("모델 생성");
      const result = await this.generator.generate(request);
      timing.next("저장");
      const createdAt = await context.step("createdAt", async () => seoulIso(this.now()));
      const analysis = await context.commit(async (db) => {
      const inserted = await db
        .insertInto("analyses")
        .values({
          code,
          kind,
          content: result.text,
          data_snapshot: JSON.stringify(snapshot),
          missing_data: JSON.stringify(snapshot.missing),
          model: result.model,
          created_at: createdAt,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { id: inserted.id, code, kind, content: result.text, missing: snapshot.missing, model: result.model, createdAt, cached: false, verification: verifyReport(result.text, snapshot) } satisfies Analysis;
      });
      success = true;
      return analysis;
    } finally {
      timing.finish(success);
    }
  }

  private async lookup(code: string): Promise<StockIdentity | null> {
    const found = await this.deps.lookup?.(code).catch(() => null);
    return found && found.code === code ? { code: found.code, name: found.name, market: found.market } : null;
  }

  private latestRow(code: string, kind: AnalysisKind): Promise<AnalysisRow | undefined> {
    return this.deps.db
      .selectFrom("analyses")
      .select(["id", "code", "kind", "content", "data_snapshot", "missing_data", "model", "created_at"])
      .where("code", "=", code)
      .where("kind", "=", kind)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  async latest(code: string, kind: AnalysisKind): Promise<Analysis | null> {
    const r = await this.latestRow(code, kind);
    return r ? toAnalysis(r) : null;
  }

  /** 저장된 결과와 이 서버의 진행 여부만 확인한다. 자료 수집·AI 생성은 시작하지 않는다. */
  async state(code: string, kind: AnalysisKind, requestId?: string): Promise<{ latest: Analysis | null; running: boolean; request?: AnalysisRequestState }> {
    const latest = await this.latest(code, kind);
    const running = this.inflight.has(`${code}:${kind}`) || await this.jobs.running(`analysis:${code}:${kind}`);
    if (requestId === undefined) return { latest, running };
    this.pruneRequests();
    const tracked = this.requests.get(`${code}:${kind}:${requestId}`);
    return {
      latest, running,
      request: tracked
        ? { id: requestId, status: tracked.status, result: tracked.result }
        : { id: requestId, ...await this.jobs.request<Analysis>(`${code}:${kind}:${requestId}`) },
    };
  }
}

type StockIdentity = { code: string; name: string; market: string };
type AnalysisRow = { id: number; code: string; kind: string; content: string; data_snapshot: string; missing_data: string; model: string; created_at: string };

function toAnalysis(r: AnalysisRow): Analysis {
  let missing: string[] = [];
  try {
    missing = JSON.parse(r.missing_data) as string[];
  } catch {
    /* ignore */
  }
  let snapshot: unknown = null;
  try { snapshot = JSON.parse(r.data_snapshot); } catch { /* 예전 본문은 보존하고 자료 확인 불가로 표시한다. */ }
  return { id: r.id, code: r.code, kind: r.kind as AnalysisKind, content: r.content, missing, model: r.model, createdAt: r.created_at, cached: true, verification: verifyReport(r.content, snapshot) };
}

/** 캐시 글이 이 이름·시장으로 만든 것인지 (스냅샷의 stock — 만들 때 프롬프트·뉴스 검색에 쓴 값). 읽지 못하면 아니라고 본다 */
function madeFor(dataSnapshot: string, stock: StockIdentity): boolean {
  try {
    const s = (JSON.parse(dataSnapshot) as { stock?: { name?: unknown; market?: unknown } } | null)?.stock;
    return s?.name === stock.name && s?.market === stock.market;
  } catch {
    return false;
  }
}

function snapshotForPrompt(s: AnalysisSnapshot, kind: AnalysisKind): Record<string, unknown> {
  const base = { stock: s.stock, quote: s.quote };
  if (kind === "company") {
    return {
      ...base,
      company: s.company,
      financials: s.financials,
      ratios: s.ratios,
      disclosures: s.disclosures?.map((d) => ({ title: d.title, filedAt: d.filedAt })),
      // 뉴스 날짜는 한국 날짜로 (네이버는 +09:00, 구글·네이버 검색은 Z 로 와서 그냥 자르면 한국 오전 기사가 전날이 된다)
      news: s.news?.map((n) => ({ title: n.title, source: n.source, publishedAt: seoulDateOf(n.publishedAt) })),
    };
  }
  if (kind === "value") {
    return {
      ...base,
      financials: s.financials,
      ratios: s.ratios,
      dividends: s.dividends,
      disclosures: s.disclosures?.map((d) => ({ title: d.title, filedAt: d.filedAt })),
    };
  }
  return {
    ...base,
    technical: s.technical,
    weeklyCandles: s.weeklyCandles,
  };
}
