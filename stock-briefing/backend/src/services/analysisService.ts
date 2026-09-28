import type { Db } from "../db/index.js";
import { NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulDateOf, seoulIso } from "../lib/time.js";
import type { TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptName, type PromptStore } from "../llm/prompts.js";
import { SCORE_BANNED_RE, SCORE_FUTURE_RE } from "../analysis/scoreWording.js";
import { RIEUL_FINAL } from "./accountNumbers.js";
import { BRIEFING_BANNED, cleanDetail } from "./briefingWording.js";
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
  /**
   * 가치 점수 개선 1단계 [8] (플래그 valueAiSafeWording): AI 가치분석 글을 새 프롬프트(value_analysis_safe — '평가하는 애널리스트'·강점/리스크 없음)로
   * 만들고, 보일 때마다(전에 만든 글 포함) 가치분석 금지어 검사(VALUE_AI_BANNED)로 걸린 줄을 뺀다. 예전 프롬프트로 만든 7일 캐시 글('## 강점' 등)은 쓰지 않고
   * 새로 만든다. 의존성이 없거나 읽기가 실패하면 끔
   */
  valueSafe?: () => Promise<boolean>;
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
    const safe = kind === "value" && (await this.valueSafeOn());
    // 예전 프롬프트로 만든 가치분석 캐시 글 (safe 일 때 새로 만든다 — 만들기에 실패하면 이 글을 검사해 보인다)
    let oldCached: Analysis | null = null;
    if (!opts.refresh) {
      const cached = await this.latest(code, kind);
      if (cached && this.now().getTime() - Date.parse(cached.createdAt) < TTL_MS[kind]) {
        if (!safe) return { ...cached, cached: true };
        if (!isOldValueText(cached.content)) return safeAnalysis({ ...cached, cached: true });
        oldCached = cached;
      }
    }
    const key = `${code}:${kind}:${safe ? "safe" : "plain"}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const fallback = oldCached;
    const p = this.generate(code, kind, safe)
      .then((a) => (safe ? safeAnalysis(a) : a))
      .catch((e: unknown) => {
        if (fallback) return safeAnalysis({ ...fallback, cached: true });
        throw e;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 플래그 valueAiSafeWording (의존성이 없거나 읽기가 실패하면 끔) */
  private async valueSafeOn(): Promise<boolean> {
    const read = this.deps.valueSafe;
    if (!read) return false;
    return read().catch(() => false);
  }

  private async generate(code: string, kind: AnalysisKind, safe = false): Promise<Analysis> {
    const stock =
      (await this.deps.db.selectFrom("registered_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
      (await this.deps.db.selectFrom("listed_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
      // 마스터를 받은 뒤 상장한 종목도 상세 화면·뉴스 탭처럼 찾는다 (코드가 정확히 같은 종목만)
      (await this.lookup(code));
    if (!stock) throw new NotFoundError(`종목 ${code} 을 찾을 수 없습니다`);

    const snapshot = await this.deps.collector.collectAnalysis(stock, kind);
    const prompt = await this.deps.prompts.load(safe && kind === "value" ? "value_analysis_safe" : PROMPT_FOR[kind]);
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

/**
 * AI 가치분석 글에서 줄을 빼는 말 (가치 점수 개선 1단계 [8]). 브리핑 금지어(BRIEFING_BANNED — 뉴스 요약에 맞춰 느슨함)만으로는 가치분석 글에 흔한
 * 평가·권유·예측 말('적정 주가'·'과소평가'·'장기 보유에 적합'·'담아볼 만'·'전망이 밝'·'예상되며'·'강점'·'리스크')이 지나갔다(검토: 공격 문장 35개 중 29개 통과).
 * 그래서 점수 글 금지어(SCORE_BANNED_RE·SCORE_FUTURE_RE)와 가치분석 전용 말을 더한다. 표 줄(PER·부채비율·배당수익률 숫자)과
 * '늘었습니다·줄었습니다' 사실 문장은 걸리지 않게 낱말을 고른다 (시험: valueImprove1 '[8]')
 */
const VALUE_AI_EXTRA = [
  // 평가 말 (싸다·비싸다·강점·리스크·적정 주가·과소평가 …)
  "강점|약점|장점|단점|리스크|위험|호재|악재|메리트|디스카운트",
  "적정|과소 ?평가|과대 ?평가|평가(?:되|된|받)|비싸|싸(?:다|게|고|요|며|서|졌|진|지|보|$)|저렴|싼 ?(?:편|값|가격)",
  "긍정|부정|우량|알짜|탄탄|견조|양호|우수|훌륭|뛰어|튼튼|취약|안정적|안정성|성장성|잠재력|성장 ?동력|알맞|적합|적절|바람직|합리|현명|부담|좋(?:은|습|아|다|게|을)|나쁘|나쁜",
  // 권유·행동 (보유·투자·담기·사고팔 때)
  "보유(?:할|하기|해 ?볼|에 ?적합|하는 ?(?:것|게)|를 ?(?:권|추천|유지))|장기 ?보유|장기 ?투자|투자 ?(?:매력|가치|포인트|의견|판단|적기)|투자(?:할|해 ?볼|하기에)",
  "담아|담을|담기|사야|팔아|팔 (?:때|시점)|살 (?:때|시점)|지금이|판단|관점|목표",
  `[${RIEUL_FINAL}] ?(?:만(?:하|합|한|해|할)|여지)|여지`,
  // 예측·추측 (전망·예상·가능성·향후·내년 …)
  "전망|예상|예측|가능성|기대|향후|앞으로|내년|오를|내릴|밝(?:습|다|은 ?편)|어둡",
  "것 같|보입|보인다|보여집|수 있(?:습|다|어|을)",
].join("|");
export const VALUE_AI_BANNED = new RegExp([BRIEFING_BANNED.source, SCORE_BANNED_RE.source, SCORE_FUTURE_RE.source, VALUE_AI_EXTRA].join("|"), "g");

/** 예전 프롬프트(value_analysis — 평가하는 애널리스트)로 만든 글인지: 예전 형식의 평가 절 제목이 있으면 */
const OLD_VALUE_HEADING = /^##\s*(?:강점|리스크|가치투자 관점 요약)\s*$/m;
export const isOldValueText = (text: string) => OLD_VALUE_HEADING.test(text);

/**
 * AI 가치분석 글 금지어 검사 (가치 점수 개선 1단계 [8], 플래그 valueAiSafeWording): 가치분석 금지어(VALUE_AI_BANNED — 브리핑 금지어 + 점수 글 금지어 +
 * 평가·권유·예측 말)로 걸린 줄(제목이면 그 절 전체 — 예전 글의 '## 강점'·'## 리스크'·'## 가치투자 관점 요약' 절은 통째로)을 빼고 끝에
 * '(문장 검사에서 N줄을 뺐습니다)'. 걸린 것이 없으면 글자 하나 바꾸지 않는다. 출처 글(뉴스·공시 제목)은 없으므로 예외 없이 본다.
 * 저장한 원문은 그대로 두고 보일 때만 고친다 (전에 만든 글도 같은 검사를 받게)
 */
export function safeValueText(text: string): string {
  return cleanDetail(text, "", VALUE_AI_BANNED).text;
}
const safeAnalysis = (a: Analysis): Analysis => ({ ...a, content: safeValueText(a.content) });

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
