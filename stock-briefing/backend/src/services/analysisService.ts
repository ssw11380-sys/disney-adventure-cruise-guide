import type { Db } from "../db/index.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulDateOf, seoulIso } from "../lib/time.js";
import type { GenerateRequest, TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptName, type PromptStore } from "../llm/prompts.js";
import { SCORE_BANNED_RE, SCORE_FUTURE_RE } from "../analysis/scoreWording.js";
import { RIEUL_FINAL } from "./accountNumbers.js";
import { BRIEFING_BANNED, cleanDetail } from "./briefingWording.js";
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
  /** 등록 종목·종목 마스터에 없을 때 이름·시장 찾기 (StockService.preview: 외부 검색으로 대신 찾는다 — 신규 상장 등). 모르면 null */
  lookup?: (code: string) => Promise<{ code: string; name: string; market: string } | null>;
  /**
   * 가치 점수 개선 1단계 [8] (플래그 valueAiSafeWording): AI 가치분석 글을 새 프롬프트(value_analysis_safe — '평가하는 애널리스트'·강점/리스크 없음)로
   * 만들고, 보일 때마다(전에 만든 글 포함 — 상태 확인 경로도) 가치분석 금지어 검사(VALUE_AI_BANNED)로 걸린 줄을 뺀다. 예전 프롬프트로 만든 7일 캐시 글('## 강점' 등)은
   * 쓰지 않고 새로 만든다. 의존성이 없거나 읽기가 실패하면 끔
   */
  valueSafe?: () => Promise<boolean>;
  now?: () => Date;
  /** 보고서 시간 기록 + AI 가치분석 문장 검사에서 뺀 줄 수 기록 (규정 검토 C-1·S-1 — 운영에서 걸린 비율을 보려고, 브리핑의 '종목 브리핑 문장 검사'와 같은 모양) */
  log?: ReportLog;
  jobs?: GenerationJobs;
}

/** 종목 상세 탭(회사 소개 / 가치투자 / 기술적 분석) 생성 + 캐시 */
export class AnalysisService {
  private readonly now: () => Date;
  private readonly inflight = new Map<string, Promise<Analysis>>();
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

  async get(code: string, kind: AnalysisKind, opts: { refresh?: boolean; requestKey?: string } = {}): Promise<Analysis> {
    if (this.shuttingDown) throw new AppError(503, "SERVER_CLOSING", "서버가 재시작 중입니다. 잠시 뒤 다시 시도해 주세요.");
    const work = this.getActive(code, kind, opts);
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
    const safe = kind === "value" && (await this.valueSafeOn());
    const key = `${code}:${kind}`;
    if (opts.requestKey) {
      const previous = await this.jobs.request<Analysis>(opts.requestKey);
      if (previous.status === "completed" && previous.result) return safe ? this.safeAnalysis(previous.result, "cache") : previous.result;
      if (previous.status === "failed") throw new AppError(409, "GENERATION_INTERRUPTED", "이전 생성이 중단됐습니다. 다시 만들기로 새로 요청해 주세요.");
    }
    const active = this.inflight.has(key) || (!!opts.requestKey && await this.jobs.running(`analysis:${key}`));
    // 예전 프롬프트로 만든 가치분석 캐시 글 (safe 일 때 새로 만든다 — 만들기에 실패하면 이 글을 검사해 보인다)
    let oldCached: Analysis | null = null;
    if (!opts.refresh && !active) {
      const cached = await this.latest(code, kind);
      if (cached && this.now().getTime() - Date.parse(cached.createdAt) < TTL_MS[kind]) {
        if (!safe || !isOldValueText(cached.content)) {
          const result = { ...cached, cached: true };
          if (opts.requestKey) await this.jobs.completeRequest(opts.requestKey, `analysis:${key}`, result);
          return safe ? this.safeAnalysis(result, "cache") : result;
        }
        oldCached = cached;
      }
    }
    const existing = this.inflight.get(key);
    if (existing && !opts.requestKey) return safe ? existing.then((a) => this.safeAnalysis(a, null)) : existing;
    const p = this.jobs.run<Analysis>(`analysis:${key}`, { ...(opts.requestKey ? { requestKey: opts.requestKey } : {}), retryUncertain: opts.refresh === true }, (context) => this.generate(code, kind, context, safe))
      .finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    if (!safe) return p;
    // 저장·작업 기록에는 원문을 두고, 돌려줄 때만 금지어 검사를 한다 (같은 작업에 합류한 요청은 기록 없이 같은 검사)
    const fallback = oldCached;
    return p.then(
      (a) => this.safeAnalysis(a, "new"),
      (e: unknown) => {
        if (fallback) return this.safeAnalysis({ ...fallback, cached: true }, "oldCache");
        throw e;
      },
    );
  }

  /**
   * 가치분석 금지어 검사를 한 글 + 기록. 새로 만든 글은 뺀 줄이 없어도(0줄) 남기고, 전에 만든 글은 뺀 줄이 있을 때만 남긴다
   * (같은 글을 볼 때마다 세지 않게). from: new 새로 만든 글 · cache 전에 만든 새 형식 글 · oldCache 새로 만들기에 실패해 보인 예전 형식 글 ·
   * null 기록 없음(진행 중인 작업에 합류한 요청·상태 확인 경로). 뺀 줄에만 있던 시세 대조 경고는 본문에 없으므로 뺀다
   */
  private safeAnalysis(a: Analysis, from: "new" | "cache" | "oldCache" | null): Analysis {
    const r = safeValueCheck(a.content);
    if (from && (from === "new" || r.dropped > 0)) this.deps.log?.info({ code: a.code, dropped: r.dropped, from }, "AI 가치분석 문장 검사");
    if (r.dropped === 0) return { ...a, content: r.text };
    const shown = r.text.replace(/[*_`#]/g, "");
    const verification = a.verification && Array.isArray(a.verification.issues) ? { ...a.verification, issues: a.verification.issues.filter((i) => shown.includes(i.reported)) } : a.verification;
    return { ...a, content: r.text, ...(verification ? { verification } : {}) };
  }

  /** 플래그 valueAiSafeWording (의존성이 없거나 읽기가 실패하면 끔) */
  private async valueSafeOn(): Promise<boolean> {
    const read = this.deps.valueSafe;
    if (!read) return false;
    return read().catch(() => false);
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

  private async generate(code: string, kind: AnalysisKind, context: GenerationContext, safe = false): Promise<Analysis> {
    const timing = new ReportTiming({ report: "분석", kind }, this.deps.log);
    let success = false;
    try {
      const stock = await context.step("stock", async () =>
        (await this.deps.db.selectFrom("registered_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
        (await this.deps.db.selectFrom("listed_stocks").select(["code", "name", "market"]).where("code", "=", code).executeTakeFirst()) ??
        // 마스터를 받은 뒤 상장한 종목도 상세 화면·뉴스 탭처럼 찾는다 (코드가 정확히 같은 종목만)
        (await this.lookup(code)));
      if (!stock) throw new NotFoundError(`종목 ${code} 을 찾을 수 없습니다`);

      const snapshot = await context.step("snapshot", () => this.deps.collector.collectAnalysis(stock, kind));
      timing.next("프롬프트");
      const prompt = await this.deps.prompts.load(safe && kind === "value" ? "value_analysis_safe" : PROMPT_FOR[kind]);
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
    let snapshot: unknown = null;
    try { snapshot = JSON.parse(r.data_snapshot); } catch { /* 예전 본문은 보존하고 자료 확인 불가로 표시한다. */ }
    return { id: r.id, code: r.code, kind: r.kind as AnalysisKind, content: r.content, missing, model: r.model, createdAt: r.created_at, cached: true, verification: verifyReport(r.content, snapshot) };
  }

  /** 저장된 결과와 이 서버의 진행 여부만 확인한다. 자료 수집·AI 생성은 시작하지 않는다. */
  async state(code: string, kind: AnalysisKind, requestId?: string): Promise<{ latest: Analysis | null; running: boolean; request?: AnalysisRequestState }> {
    // 가치분석 금지어 검사 (플래그 valueAiSafeWording): 상태 확인 경로로 회수한 글도 보이는 글은 같은 검사를 받는다 (기록 없이 — 화면이 여러 번 확인함)
    const safe = kind === "value" && (await this.valueSafeOn());
    const shown = (a: Analysis | null) => (a && safe ? this.safeAnalysis(a, null) : a);
    const latest = shown(await this.latest(code, kind));
    const running = this.inflight.has(`${code}:${kind}`) || await this.jobs.running(`analysis:${code}:${kind}`);
    if (requestId === undefined) return { latest, running };
    this.pruneRequests();
    const tracked = this.requests.get(`${code}:${kind}:${requestId}`);
    const request: AnalysisRequestState = tracked
      ? { id: requestId, status: tracked.status, result: tracked.result }
      : { id: requestId, ...await this.jobs.request<Analysis>(`${code}:${kind}:${requestId}`) };
    return { latest, running, request: { ...request, result: shown(request.result) } };
  }
}

/**
 * AI 가치분석 글에서 줄을 빼는 말 (가치 점수 개선 1단계 [8]). 브리핑 금지어(BRIEFING_BANNED — 뉴스 요약에 맞춰 느슨함)만으로는 가치분석 글에 흔한
 * 평가·권유·예측 말('적정 주가'·'과소평가'·'장기 보유에 적합'·'담아볼 만'·'전망이 밝'·'예상되며'·'강점'·'리스크')이 지나갔다(검토: 공격 문장 35개 중 29개 통과).
 * 그래서 점수 글 금지어(SCORE_BANNED_RE·SCORE_FUTURE_RE)와 가치분석 전용 말을 더한다. 표 줄(PER·부채비율·배당수익률 숫자)과
 * '늘었습니다·줄었습니다' 사실 문장은 걸리지 않게 낱말을 고른다 (시험: valueImprove1 '[8]').
 * 1단계 검토 3차: 가치 판정·시점·권유 말('내재가치보다 낮습니다'·'역사적 저점'·'바닥권'·'할인된 가격'·'재무구조가 건전'·'해자'·'관심을 가질 필요'·
 * 'Strong Buy' — 공격 문장 54개 중 37개가 지나갔다)과 규정 검토 C-11 의 계좌 목록 낱말(고점·저점·바닥·과열·유리·불리)을 더한다.
 * 사실 말과 겹치는 것은 좁혀 쓴다: '바닥재'·'피해자'·'유리 기판'·'재무 건전성'(묶음 이름)·'과도기'·'늘었고 PER은'·'Best Buy'는 걸리지 않게
 * 1단계 검토 4차: 같은 말의 활용형·돌려 말하기('쌉니다'·'쌌습니다'·'싼 주식'·'비쌉니다'·'나빠졌습니다'·'~ㄹ 수도 있습니다'·'들어갈 때입니다'·'사도 됩니다'·
 * '편이 낫습니다'·'매입할 시기'·'사들일 종목'·'상승 확률'·'배당을 늘릴 회사'·'것으로 봅니다'·'cheap' — 공격 문장 54개 중 45개가 지나갔다)를 더한다.
 * '둘러싼·감싼·휩싸인'(에워싸다)·'싼타페'·'싸움'·'12월 31일까지'·'자사주를 매입할 계획'·'되레'·'올해도 되풀이'·'것으로 보고했습니다'·'내야 했습니다'는 걸리지 않게
 * 1단계 검토 5차: 직접적인 지시·예측의 흔한 모양('지금 사면 됩니다'·'보유하시면 됩니다'·'갈아타면 됩니다'·'보유 의견입니다'·'비중 유지입니다'·'곧 오릅니다'·'10만원까지 갑니다'·
 * '오르게 되어 있습니다'·'늘게 됩니다'·영어 'Buy.'·'Hold.'·'Rating: Hold'·'Price target'·'recommend'·'Overweight'·'Accumulate'·'fairly valued'·'entry point' — 26개 모두 지나갔다)와
 * 걱정·평가 말('걱정됩니다'·'염려'·'조심스럽습니다'·'너무 높습니다'·'깔끔'·'든든'·'믿음직'·'값어치'·'제 가치'·'인정받지 못'·'반영되지 않은 가치'·'공정 가치는 10만원'·'Solid'·'great')를 더한다.
 * '올랐습니다'·'10만원까지 올랐습니다'·'늘게 되었습니다'(지난 일)·'매출 비중은 30%로 유지되었습니다'·'금융자산의 공정가치는 3.2조원'·'Best Buy'·'Holdings'·'Accumulated'는 걸리지 않게
 * 1단계 검토 6차: '나쁩니다'·존댓말 허락('사셔도 됩니다'·'보유하셔도'·'갖고 계셔도')·'사도 무방합니다'·'사도 문제없습니다'·'살 시기입니다'·'살 차례입니다'·'들어갈 때죠'·
 * '더 나은 선택'·'매입 구간'·'늦지 않았습니다' (5차 검사로는 27개 모두 지나갔다)를 더한다. '지급할 시기는'·'같은 시기에'·'네 차례 지급'·'자사주 매입 기간'은 걸리지 않게
 */
const VALUE_AI_EXTRA = [
  // 평가 말 (싸다·비싸다·강점·리스크·적정 주가·과소평가 …) — '싸'는 '둘러싸고·감싸·휩싸여'(에워싸다)·'싸움'·'싸이월드'·'싸늘'을 빼고 모든 활용
  "강점|약점|장점|단점|리스크|위험|호재|악재|메리트|디스카운트",
  "적정|과소 ?평가|과대 ?평가|평가(?:되|된|받)|비싸|(?<![러워감휩])싸(?![움우워운울웠이인늘])|저렴|싼 ?(?:편|값|가격)",
  "긍정|부정|우량|알짜|탄탄|견조|양호|우수|훌륭|뛰어|튼튼|취약|안정적|안정성|성장성|잠재력|성장 ?동력|알맞|적합|적절|바람직|합리|현명|부담|좋|나쁘|나쁜",
  // 권유·행동 (보유·투자·담기·사고팔 때)
  "보유(?:할|하기|해 ?볼|에 ?적합|하는 ?(?:것|게)|를 ?(?:권|추천|유지))|장기 ?보유|장기 ?투자|투자 ?(?:매력|가치|포인트|의견|판단|적기)|투자(?:할|해 ?볼|하기에)",
  "담아|담을|담기|사야|팔아|팔 (?:때|시점)|살 (?:때|시점)|지금이|판단|관점|목표",
  `[${RIEUL_FINAL}] ?(?:만(?:하|합|한|해|할)|여지)|여지`,
  // 예측·추측 (전망·예상·가능성·향후·내년 …)
  "전망|예상|예측|가능성|기대|향후|앞으로|내년|오를|내릴|밝(?:습|다|은 ?편)|어둡",
  "것 같|보입|보인다|보여집|수 있(?:습|다|어|을)",
  // 가치 판정 (내재가치·업사이드·할인된 가격·프리미엄·건전·견고·해자·경쟁력 …)
  "내재 ?가치|업사이드|다운사이드|리 ?레이팅|디 ?레이팅|(?<![피가])해자|경쟁력|시장 ?지배력|압도|탁월|돋보|친화",
  "할인(?:된|되|돼|받|거래)|프리미엄(?:을|이)? ?(?:받|붙|부여|구간|수준)|(?:낮게|높게) 형성|과도(?!기)|지나치|지나친|최고 수준|최저 수준",
  "건전(?!성)|건실|견고|건강(?:하|한|합|해)|불안(?:하|한|합|정)|열악|부진|체력|안정(?:된|되어|돼)",
  "가치주|성장주|배당주|고배당|저P[EB]R|고P[EB]R|유리(?:하|한|합|해)|불리(?:하|한|합|해)",
  // 시점 (역사적 저점·바닥권·과열·고점 부근·밸류에이션 하단)
  "저점|고점|바닥(?!재)|천장|과열|밸류에이션 ?(?:하단|상단|밴드)",
  // 권유·행동 (관심을 가질 필요·눈여겨·유의·신중·적당·살펴볼·들고 가·매집·노리는·포트폴리오)
  "관심을? ?가(?:질|져)|눈여겨|필요(?:가|성이)? ?있|필요합|유의(?:해|하|할)|신중|적당|살펴볼|들고 가|매집|노리(?:는|고|면|기)|포트폴리오|점쳐|점칠",
  // 영어 (Strong Buy·BUY rating·undervalued …) — 한 식에 한글 금지어와 함께 두므로 'i' 플래그 대신 대소문자를 따로 적는다.
  // 'Buy' 한 낱말은 회사 이름(Best Buy)에도 있어 여기서는 대문자 'BUY'·'Strong Buy'·'Buy rating'만 — 'Buy.'·'Hold.'는 아래 5차 줄('Best Buy'를 뺀 Buy)
  "[Ss]trong ?(?:[Bb]uy|[Ss]ell)|STRONG ?(?:BUY|SELL)|\\b(?:BUY|SELL)\\b|\\b(?:[Bb]uy|[Ss]ell) (?:rating|recommendation|signal)|[Uu]nder ?valued|[Oo]ver ?valued|UNDERVALUED|OVERVALUED|[Oo]utperform|[Uu]nderperform|OUTPERFORM|UNDERPERFORM",
  "[Cc]heap|[Ee]xpensive|[Bb]argain|[Aa]ttractive|[Uu]pside|[Dd]ownside|\\b[Bb]uy(?:ing)? (?:opportunity|now|the dip)",
  // ── 1단계 검토 4차: 활용형·돌려 말하기 ──
  // 싸다·비싸다·나쁘다의 활용 (쌉니다·쌌습니다·싼·비쌉니다·비쌌습니다·나빠졌습니다·나빴습니다) — '둘러싼·감싼·휩싼'·'싼타페'는 빼고
  "(?<![러워감휩])(?:쌉|쌌|싼(?!타))|나빠|나빴|나쁠|괜찮|가성비|헐값|바겐|제 ?값",
  // 추측·의견 (~ㄹ 수도 있습니다·확률·여력·~겠·~듯합니다·생각합니다·추정됩니다·것으로 봅니다·~까요) — '것으로 보고했습니다'는 빼고
  "수도 있|확률|여력|겠|듯(?:합|하|한|해|싶|보)|생각(?:합|됩|된다|한다|해|하)|추정(?:됩|된다|되며|되는|해 ?보)|것으로 (?:보(?!고)|봅|봐|판단|예상|추정|전망)|까요|않을까",
  // 받침 ㄹ + 때·가치·이유 (들어갈 때입니다·모을 때가 왔습니다·모아갈 가치·살 이유 — '환산할 때 쓴'은 빼고), ~ㄹ 것입니다(늘 것입니다), ~ㄹ 회사입니다(늘릴 회사·성장할 기업)
  `[${RIEUL_FINAL}] ?때(?:입|이|다|예|야|인|라|가 ?(?:왔|됐|되었|온|올|된))|[${RIEUL_FINAL}] (?:가치|이유)`,
  `[${RIEUL_FINAL}] ?(?:것(?:입니다|이다|이에요|으로|이라|이란|임)|겁니다|거예요|거다|거야|거라|거란|거로|걸로)`,
  `[${RIEUL_FINAL}] (?:회사|기업|종목|주식)(?:입니|이다|이에|예요|으로 ?(?:보|꼽|평가))`,
  // 앞일 (늘릴·키울·커질·좋아질·나아질·개선될·회복할·올라갈·떨어질·지속될·이어질)
  "늘릴|키울|올릴|높일|성장할|커질|좋아질|나아질|개선될|회복(?=할|될|하겠|세)|살아날|올라갈|내려갈|떨어질|지속될|이어질|이어갈",
  // 권유·행동 (편이 낫습니다·사도 됩니다·들어가도 됩니다·사는 게·사 두는·매입할·사들일·~해야 합니다·것도 방법·지켜봐·검토해 볼)
  // '되레'·'올해도 되풀이'·'회사도'·'자사주를 매입할 계획'(공시 사실)·'내야 했습니다'(지난 일)는 빼고
  "낫(?:습|다|겠|지|고|네)|나을 (?:것|겁|거|수)|편이 ?(?:낫|좋|나을|유리)",
  "(?:(?<!올)[어아여워와해]|(?<=[어아여져라])가|(?<![가-힣])사|(?<![가-힣])팔)도 ?(?:됩|되(?!레|풀|돌|살|찾)|돼|괜찮)",
  "(?<![가-힣])(?:사는|파는) ?(?:것|게|편)|(?<![가-힣])사 ?(?:두면|두기|두는|둘|둬|두어)|(?<![가-힣])팔(?:기|자)(?![가-힣])",
  "(?<!(?:자사주|자기 ?주식)[^.\\n]{0,20})(?:매입(?:할|하기|해 ?(?:볼|둘|두|야)|하는 ?(?:것|게|편))|사들일|사들이(?:기|는 ?(?:것|게|편))|사들여(?:야| ?(?:볼|둘|두)))",
  "(?<!분|시)야만? ?(?:합니|한다|하겠|할 )|것도 ?(?:한 ?)?방법|지켜(?:보|봐|볼|봅|본)|검토해 ?(?:볼|보)|검토할 ?(?:만|필요|가치)",
  // ── 1단계 검토 5차: '~면 됩니다' 권유 · 의견 말 · 현재형 예측 · 영어 투자 의견 · 걱정·평가 말 ──
  // '~면 됩니다'(지금 사면 됩니다·팔면 됩니다·보유하시면 됩니다·담으면·처분하면·갈아타면) — 사고팔기 낱말은 '되는·되고·좋'도
  "(?<![가-힣])(?:사|팔|파|담으|모으|보유하|처분하|정리하|매집하|갈아타|들어가|사 ?모으)(?:시|으시)?면 ?(?:됩|되|돼|좋)|(?<=[가-힣])면 ?(?:됩니|된다|돼요)",
  // 의견·보유 표현 (보유 의견입니다·중립 의견·비중 유지입니다) — '매출 비중은 30%로 유지되었습니다'는 그대로
  "(?:보유|중립|비중 ?(?:유지|확대|축소)?) ?의견|비중을? ?유지",
  // 현재형 예측 (곧 오릅니다·10만원까지 갑니다·오르게 되어 있습니다·늘게 됩니다) — 지난 사실('올랐습니다'·'10만원까지 올랐습니다'·'늘게 되었습니다')은 그대로
  "오릅니|오른다(?![가-힣])|내립니|떨어집니|떨어진다(?![가-힣])|뜁니|상승합니|상승한다(?![가-힣])|하락합니|하락한다(?![가-힣])|까지 ?(?:갑니|간다(?![가-힣])|가겠|갈 )",
  "(?:오르|올라가|내리|내려가|떨어지|늘|늘어나|줄|줄어들|커지|작아지|좋아지|나빠지|나아지|높아지|낮아지|상승하|하락하|증가하|감소하|회복하|개선되|악화되|반등하|성장하)게 ?(?:됩|되(?!었)|될|돼)",
  // 걱정·평가 말 (걱정됩니다·염려·조심스럽습니다·너무 높습니다·깔끔·든든·믿음직·값어치·제 가치·인정받지 못·반영되지 않은 가치)
  "걱정|염려|조심|너무|깔끔|든든|믿음직|값어치|(?<![가-힣])제 ?가치|인정받지 못|(?:반영되지 않은|반영 안 된|덜 반영된) ?가치",
  // 한 주의 공정 가치('공정 가치는 10만원입니다'·'주당 공정가치'·'공정가치보다 낮습니다') — 회계 말('공정가치로 평가된 금융자산'·'금융자산의 공정가치는 3.2조원')은 그대로
  "공정 ?가치(?:는|가|은|를)? ?(?:약 ?)?(?:주당 ?)?(?:[\\d,.]+ ?만? ?(?:원|달러)|\\$ ?\\d)|(?:주당|한 주의?|주식의?|주가의?) ?공정 ?가치|공정 ?가치(?:보다|에 비해|대비|에 못 미|를 밑|를 웃|를 넘)",
  // 영어 투자 의견 (Buy·Sell·Hold·Rating: Hold·Price target·recommend·Overweight·Accumulate·Worth buying·fairly valued·entry point) — 'Best Buy'·'Holdings'·'Accumulated'는 그대로
  "(?<!Best )\\bBuy\\b|\\b(?:Sell|Hold|HOLD|Accumulate|ACCUMULATE|Neutral|NEUTRAL)\\b|[Oo]ver ?weight|[Uu]nder ?weight|OVERWEIGHT|UNDERWEIGHT|[Ee]qual[- ]?[Ww]eight|[Mm]arket ?[Pp]erform|[Ss]ector ?[Pp]erform",
  "[Pp]rice ?target|[Tt]arget ?price|PRICE TARGET|[Rr]ecommend|RECOMMEND|[Ww]orth (?:buying|owning|holding|a look)|[Ff]airly (?:valued|priced)|[Ee]ntry (?:point|price)|[Gg]ood (?:buy|time to buy)",
  "\\b(?:[Ss]olid|[Rr]obust|[Hh]ealthy|[Ee]xcellent|[Gg]reat|[Ww]onderful)\\b|[Ss]trong (?:balance|company|business|fundamentals|financials|growth|dividend|cash)|[Ww]eak (?:balance|company|business|fundamentals|financials)",
  // ── 1단계 검토 6차: '나쁩니다' · 존댓말 허락 · '~도 무방' · '살 시기·차례' · '때죠' · '더 나은 선택' · '매입 구간' · '늦지 않' ──
  // 나쁘다의 '-ㅂ니다' 활용 (실적이 나쁩니다 — 4차 줄은 '나빠·나빴·나쁠'만)
  "나쁩",
  // 존댓말 허락 (사셔도 됩니다·보유하셔도 됩니다·사 두셔도·갖고 계셔도) · '~도 무방/문제없' (사도 무방합니다·보유해도 무방·사도 문제없습니다)
  "셔도 ?(?:됩|되|돼|괜찮|무방|좋)|도 ?(?:무방|문제 ?없)",
  // 받침 ㄹ + 시기·차례 (살 시기입니다·팔 시기입니다·모아갈 시기입니다·살 차례입니다 — '지급할 시기는'·'같은 시기에'·'네 차례 지급'은 그대로) · '때죠·때네요'(들어갈 때죠·모을 때네요)
  `[${RIEUL_FINAL}] ?(?:시기|차례)(?:입|이|예|라|로)|때(?:죠|네|고요)`,
  // 고르기·시점 말 (더 나은 선택·나은 투자처·매입 구간·아직 늦지 않았습니다 — '자사주 매입 기간'은 그대로)
  "나은 ?(?:선택|편|투자)|매입 ?구간|늦지 ?않",
].join("|");
export const VALUE_AI_BANNED = new RegExp([BRIEFING_BANNED.source, SCORE_BANNED_RE.source, SCORE_FUTURE_RE.source, VALUE_AI_EXTRA].join("|"), "g");

/**
 * 가치분석 금지어에 걸리지만 사실을 적는 말 (검토: '공정가치로 평가된 금융자산'·'이익 안정성'(앱 지표 이름)·'위험가중자산'(은행 지표)·
 * '장기투자자산'(계정 이름)·'영업이익은 2024년 반등해 12조원'·'환율에 따라 원화 금액이 달라질 수(도) 있습니다' · 1단계 검토 5차: '1년 안에 갚아야 할 빚'·'지급해야 할 배당금'·
 * '내야 할 법인세'('~야 할 ' 권유 말에 걸리던 것 — 뒤에 '때·시점·시기·차례'가 오면 그대로 걸린다)·'자회사를 팔아 생긴 이익'·'팔아 얻은'('팔아'에 걸리던 것)). 이 말은 빈칸으로 바꾼 뒤 검사한다 —
 * 같은 줄에 다른 금지어가 있으면 그대로 걸린다('이익 안정성이 높아 안정적입니다' → '안정적'). 보이는 글은 원문 그대로
 */
export const VALUE_AI_ALLOW =
  /공정 ?가치로 평가|이익 ?안정성|위험 ?가중|장기 ?투자(?:자산|증권|금융자산)|반등(?:했|하였)|반등해(?= ?\d)|달라질 수도? 있습니다|(?:갚아|지급해|지불해|납부해|상환해|돌려줘|(?<![가-힣])내)야(?= 할 (?!때|시점|시기|차례))|팔아(?:서)?(?= ?(?:생긴|생겼|얻은|얻었|번 |벌어|남긴|남겼|거둔|거뒀|마련))/g;

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
  return safeValueCheck(text).text;
}
/**
 * safeValueText + 뺀 줄 수 (기록용). 1단계 검토 7차: 줄마다 앱에 보이는 모양으로 바꾼 검사용 복사본(renderedForCheck — '*·_·`' 강조 표시를 빼고
 * 두 칸·NBSP·탭·전각 공백을 한 칸으로, 엔티티·태그·링크 꾸밈·보이지 않는 글자도)으로 예외 말·금지어를 본다 — '지금  사셔도  됩니다'·'지금 사셔도 **됩니다**'처럼
 * 화면에서는 같은 문장인데 금지어의 ' ?'(빈칸 0~1개)를 비껴가던 것. 보여 주는 글은 원문 그대로
 */
export function safeValueCheck(text: string): { text: string; dropped: number } {
  return cleanDetail(text, "", VALUE_AI_BANNED, VALUE_AI_ALLOW, { rendered: true });
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
