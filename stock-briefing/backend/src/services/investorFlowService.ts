import { isKrCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import type { FlowTrendRow, FlowTrendSource, InvestorFlowDay } from "../providers/market/investorFlow.js";
import { NaverInvestorTrend, NAVER_TREND_MAX } from "../providers/market/naverInvestorTrend.js";
import { TossTradingTrend, TOSS_TREND_SIZE } from "../providers/market/tossTradingTrend.js";
import type { FeatureService } from "./featureService.js";
import { FLOW_TEXT } from "./flowText.js";
import { buildFlowBody, compareFlows, FLOW_CHECK_DAYS, flowCacheTtlMs, splitFlowRows, type FlowCheck, type FlowCompare, type FlowSourceName, type InvestorFlowResponse } from "./investorFlowCalc.js";

/**
 * 종목 상세 '수급' 탭 (3-33, 플래그 flowTab) 자료 서비스. 공용 경로 GET /api/investor-flow/:code 가 부른다 (시장 자료 — 계정마다 다른 값 없음).
 *
 * 출처 순서 (설계서 4.3): 토스 웹(KRX+NXT) → 실패·모양 바뀜이면 24시간 안 토스 웹 캐시(stale) → 네이버(KRX만) → 72시간 안 아무 캐시(stale) → 502.
 * 한 응답 안에서 두 출처를 섞지 않는다. 저장하지 않는다(메모리 캐시만 — 출처가 200일·60일을 다시 준다).
 * 캐시: 종목 300개까지(오래 안 쓴 것부터 버림), 평일 08:00~21:00 KST 10분 · 그 밖 60분 — 그 안의 다음 요청은 출처를 부르지 않는다.
 * 같은 종목 동시 요청은 하나로 묶는다.
 *
 * 대조: 토스 웹 자료를 준 뒤 뒤에서(응답을 기다리게 하지 않음) 종목마다 12시간에 한 번(실패면 1시간 뒤) 토스 Open API 수급 원자료를 받아
 * 최근 20일 세 값을 견주고 개수만 다음 응답의 check 에 싣는다. 원자료(날짜별 두 값)는 관리 경로에만 — 토스 Open API 정책(본인 목적, 제3자 배포 금지)
 */

export interface InvestorFlowSources {
  tossWeb: FlowTrendSource;
  naver: FlowTrendSource;
  /** 토스 Open API (키 있을 때만) — 화면 자료로 쓰지 않고 대조에만 */
  openApi?: { getInvestorFlow(code: string, days: number): Promise<InvestorFlowDay[]> } | null;
}

/** 실제 출처 묶음 (buildProviders 가 만든다). 토스 Open API 는 그 인스턴스만 (KIS 는 쓰지 않음) */
export function defaultInvestorFlowSources(openApi: InvestorFlowSources["openApi"]): InvestorFlowSources {
  return { tossWeb: new TossTradingTrend(), naver: new NaverInvestorTrend(), openApi: openApi ?? null };
}

interface FlowLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface Snap {
  at: number;
  rows: FlowTrendRow[];
}

interface Entry {
  toss: Snap | null;
  naver: Snap | null;
  /** 마지막으로 응답을 정한 때와 그 출처 — 유효 시간 안에는 출처를 다시 부르지 않는다 */
  last: { at: number; source: FlowSourceName; stale: boolean } | null;
}

/** 캐시에 두는 종목 수 */
export const FLOW_CACHE_MAX = 300;
/** 토스 웹이 실패하면 이만큼 된 토스 웹 캐시까지 준다 */
const TOSS_KEEP_MS = 24 * 3_600_000;
/** 두 출처가 모두 실패하면 이만큼 된 캐시까지 준다 */
const ANY_KEEP_MS = 72 * 3_600_000;
/** 대조 간격 (성공) · 실패 뒤 다시 해 보기까지 */
const CHECK_EVERY_MS = 12 * 3_600_000;
const CHECK_RETRY_MS = 3_600_000;
/** 대조에 받는 Open API 줄 수 (최근 20 확정 날 + 오늘·여유) */
const CHECK_FETCH_DAYS = FLOW_CHECK_DAYS + 2;

export class InvestorFlowService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<InvestorFlowResponse>>();
  private readonly checks = new Map<string, FlowCheck>();
  private readonly checkTried = new Map<string, { at: number; ok: boolean }>();
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      features: FeatureService;
      sources: InvestorFlowSources | null;
      now?: () => Date;
      log?: FlowLog;
    },
  ) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** 플래그가 켜져 있고 출처 묶음이 있을 때만 (아니면 경로 404, 외부 호출 0) */
  async enabled(): Promise<boolean> {
    return this.deps.sources !== null && (await this.deps.features.enabled("flowTab"));
  }

  /** 종목 하나의 수급 (미국은 외부 호출 없이 supported: false). 두 출처 모두 실패하고 캐시도 없으면 502 */
  get(code: string): Promise<InvestorFlowResponse> {
    if (!isKrCode(code)) return Promise.resolve({ code, supported: false, reason: FLOW_TEXT.usReason });
    const running = this.inflight.get(code);
    if (running) return running;
    const p = this.load(code).finally(() => this.inflight.delete(code));
    this.inflight.set(code, p);
    return p;
  }

  private entry(code: string): Entry {
    const e = this.cache.get(code) ?? { toss: null, naver: null, last: null };
    // 오래 안 쓴 것부터 버리도록 쓸 때마다 맨 뒤로
    this.cache.delete(code);
    this.cache.set(code, e);
    while (this.cache.size > FLOW_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return e;
  }

  /** 응답에 쓸 줄 고르기 (출처를 부르는 곳은 여기뿐) */
  private async pick(code: string): Promise<{ source: FlowSourceName; snap: Snap; stale: boolean }> {
    const sources = this.deps.sources;
    if (!sources) throw new AppError(404, "NOT_FOUND", FLOW_TEXT.off);
    const e = this.entry(code);
    const t = this.now().getTime();
    if (e.last && t - e.last.at < flowCacheTtlMs(this.now())) {
      const snap = e.last.source === "toss-web" ? e.toss : e.naver;
      if (snap) return { source: e.last.source, snap, stale: e.last.stale };
    }
    const served = (source: FlowSourceName, snap: Snap, stale: boolean) => {
      e.last = { at: t, source, stale };
      return { source, snap, stale };
    };
    let why: string;
    try {
      e.toss = { at: t, rows: await sources.tossWeb.trend(code, TOSS_TREND_SIZE) };
      return served("toss-web", e.toss, false);
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
      if (/모양 바뀜/.test(why)) this.deps.log?.warn({ code, source: "toss-web", err: why }, "수급 출처 모양 바뀜");
    }
    if (e.toss && t - e.toss.at < TOSS_KEEP_MS) return served("toss-web", e.toss, true);
    this.deps.log?.warn({ code, reason: why }, "수급 출처를 네이버로 넘김");
    try {
      e.naver = { at: t, rows: await sources.naver.trend(code, NAVER_TREND_MAX) };
      return served("naver", e.naver, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn({ code, source: "naver", err: msg }, /모양 바뀜/.test(msg) ? "수급 출처 모양 바뀜" : "수급 네이버 출처 실패");
    }
    const keep = [e.toss ? { source: "toss-web" as const, snap: e.toss } : null, e.naver ? { source: "naver" as const, snap: e.naver } : null]
      .filter((x): x is { source: FlowSourceName; snap: Snap } => x !== null && t - x.snap.at < ANY_KEEP_MS)
      .sort((a, b) => b.snap.at - a.snap.at)[0];
    if (keep) return served(keep.source, keep.snap, true);
    throw new AppError(502, "UPSTREAM", FLOW_TEXT.upstream);
  }

  private async load(code: string): Promise<InvestorFlowResponse> {
    const { source, snap, stale } = await this.pick(code);
    const now = this.now();
    if (source === "toss-web") this.maybeCheck(code, snap);
    return buildFlowBody({ code, source, rows: snap.rows, fetchedAt: new Date(snap.at), stale, check: this.checks.get(code) ?? null, now });
  }

  /** 뒤에서 대조 (응답은 기다리지 않는다). 키가 없거나 12시간(실패면 1시간) 안에 해 봤으면 하지 않는다 */
  private maybeCheck(code: string, snap: Snap): void {
    const api = this.deps.sources?.openApi;
    if (!api) return;
    const tried = this.checkTried.get(code);
    const t = this.now().getTime();
    if (tried && t - tried.at < (tried.ok ? CHECK_EVERY_MS : CHECK_RETRY_MS)) return;
    this.checkTried.set(code, { at: t, ok: false });
    const job = this.compare(code, snap)
      .then(() => this.checkTried.set(code, { at: t, ok: true }))
      .catch((err: unknown) => this.deps.log?.warn({ code, err: err instanceof Error ? err.message : String(err) }, "수급 대조: 토스 Open API 를 받지 못함"));
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
  }

  /** 대조 한 번: 결과 개수를 기억하고, 다른 날이 있으면 경고 로그(날짜·칸 이름만). 확정 줄은 그 자료를 받은 때 기준 */
  private async compare(code: string, snap: Snap): Promise<FlowCompare> {
    const api = this.deps.sources?.openApi;
    if (!api) throw new Error("토스 Open API 없음");
    const at = this.now();
    const days = await api.getInvestorFlow(code, CHECK_FETCH_DAYS);
    const { final } = splitFlowRows(snap.rows, "toss-web", new Date(snap.at), this.now());
    const c = compareFlows(final, days);
    this.checks.set(code, { at: seoulIso(at), days: c.days, same: c.same });
    if (c.same < c.days) this.deps.log?.warn({ code, days: c.days, same: c.same, diffs: c.diffs }, "수급 대조: 토스 Open API 와 다른 날이 있음");
    return c;
  }

  /**
   * 관리 경로: 그 자리에서 대조를 다시 돌려 날짜별 두 값을 준다 (토스 Open API 원자료가 담겨 서버 주인만).
   * 결과 개수는 공용 응답의 check 에도 쓴다
   */
  async adminCheck(code: string): Promise<Record<string, unknown>> {
    if (!(await this.enabled())) return { enabled: false };
    if (!this.deps.sources?.openApi) return { enabled: true, code, available: false, reason: FLOW_TEXT.noOpenApi };
    const { source, snap } = await this.pick(code);
    if (source !== "toss-web") return { enabled: true, code, available: false, reason: FLOW_TEXT.noTossWeb };
    const at = seoulIso(this.now());
    const c = await this.compare(code, snap);
    this.checkTried.set(code, { at: this.now().getTime(), ok: true });
    return { enabled: true, code, available: true, at, days: c.days, same: c.same, rows: c.rows };
  }

  /** 뒤에서 도는 대조가 모두 끝날 때까지 (테스트·종료용) */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}
