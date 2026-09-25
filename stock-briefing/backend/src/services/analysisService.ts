import type { Db } from "../db/index.js";
import { NotFoundError } from "../lib/errors.js";
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
