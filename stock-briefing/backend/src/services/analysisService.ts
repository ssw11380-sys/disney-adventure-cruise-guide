import type { Db } from "../db/index.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulDateOf, seoulIso } from "../lib/time.js";
import type { TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptName, type PromptStore } from "../llm/prompts.js";
import type { AnalysisSnapshot, DataCollector } from "./collector.js";

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
  /** 등록 종목·종목 마스터에 없을 때 이름·시장 찾기 (StockService.preview: 외부 검색으로 대신 찾는다 — 신규 상장 등). 모르면 null */
  lookup?: (code: string) => Promise<{ code: string; name: string; market: string } | null>;
  now?: () => Date;
}

/** 종목 상세 탭(회사 소개 / 가치투자 / 기술적 분석) 생성 + 캐시 */
export class AnalysisService {
  private readonly now: () => Date;
  private readonly inflight = new Map<string, Promise<Analysis>>();
  private readonly requests = new Map<string, TrackedAnalysisRequest>();

  constructor(private readonly deps: AnalysisServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async get(code: string, kind: AnalysisKind, opts: { refresh?: boolean } = {}): Promise<Analysis> {
    if (!opts.refresh) {
      const cached = await this.latest(code, kind);
      if (cached && this.now().getTime() - Date.parse(cached.createdAt) < TTL_MS[kind]) return { ...cached, cached: true };
    }
    const key = `${code}:${kind}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.generate(code, kind).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
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
    const work = this.inflight.get(`${code}:${kind}`) ?? this.get(code, kind, opts);
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

  private async generate(code: string, kind: AnalysisKind): Promise<Analysis> {
    const stock =
      (await this.deps.db.selectFrom("registered_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
      (await this.deps.db.selectFrom("listed_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
      // 마스터를 받은 뒤 상장한 종목도 상세 화면·뉴스 탭처럼 찾는다 (코드가 정확히 같은 종목만)
      (await this.lookup(code));
    if (!stock) throw new NotFoundError(`종목 ${code} 을 찾을 수 없습니다`);

    const snapshot = await this.deps.collector.collectAnalysis(stock, kind);
    const prompt = await this.deps.prompts.load(PROMPT_FOR[kind]);
    const result = await this.deps.generator.generate({
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
    });
    const createdAt = seoulIso(this.now());
    const inserted = await this.deps.db
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
    return { id: inserted.id, code, kind, content: result.text, missing: snapshot.missing, model: result.model, createdAt, cached: false };
  }

  private async lookup(code: string): Promise<{ code: string; name: string; market: string } | null> {
    const found = await this.deps.lookup?.(code).catch(() => null);
    return found && found.code === code ? { code: found.code, name: found.name, market: found.market } : null;
  }

  async latest(code: string, kind: AnalysisKind): Promise<Analysis | null> {
    const r = await this.deps.db
      .selectFrom("analyses")
      .selectAll()
      .where("code", "=", code)
      .where("kind", "=", kind)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!r) return null;
    let missing: string[] = [];
    try {
      missing = JSON.parse(r.missing_data) as string[];
    } catch {
      /* ignore */
    }
    return { id: r.id, code: r.code, kind: r.kind as AnalysisKind, content: r.content, missing, model: r.model, createdAt: r.created_at, cached: true };
  }

  /** 저장된 결과와 이 서버의 진행 여부만 확인한다. 자료 수집·AI 생성은 시작하지 않는다. */
  async state(code: string, kind: AnalysisKind, requestId?: string): Promise<{ latest: Analysis | null; running: boolean; request?: AnalysisRequestState }> {
    const latest = await this.latest(code, kind);
    const running = this.inflight.has(`${code}:${kind}`);
    if (requestId === undefined) return { latest, running };
    this.pruneRequests();
    const tracked = this.requests.get(`${code}:${kind}:${requestId}`);
    return {
      latest, running,
      request: tracked
        ? { id: requestId, status: tracked.status, result: tracked.result }
        : { id: requestId, status: "unknown", result: null },
    };
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
