import { isKrCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import type { FlowTrendRow, FlowTrendSource, InvestorFlowDay } from "../providers/market/investorFlow.js";
import { NaverInvestorTrend, NAVER_TREND_SIZE } from "../providers/market/naverInvestorTrend.js";
import { OPENAPI_TREND_SIZE } from "../providers/market/tossOpenApiTrend.js";
import { TossTradingTrend, TOSS_TREND_SIZE } from "../providers/market/tossTradingTrend.js";
import type { FeatureService } from "./featureService.js";
import { FLOW_TEXT } from "./flowText.js";
import { buildFlowBody, compareFlows, FLOW_CHECK_DAYS, flowCacheTtlMs, kst, splitFlowRows, type FlowCheck, type FlowCompare, type FlowOrigin, type InvestorFlowResponse } from "./investorFlowCalc.js";

/**
 * 종목 상세 '수급' 탭 (3-33, 플래그 flowTab) 자료 서비스. 공용 경로 GET /api/investor-flow/:code 가 부른다 (시장 자료 — 계정마다 다른 값 없음).
 *
 * 출처 순서 (설계서 4.3): 토스 웹(KRX+NXT) → 실패·모양 바뀜이면 24시간 안 토스 웹 캐시(stale) → 네이버(KRX만) → 72시간 안 아무 캐시(stale) → 502.
 * 플래그 flowOpenApi 가 켜져 있고 공식 출처(sources.official)가 있으면 맨 앞에 토스 공식 Open API(KRX+NXT — 토스 웹과 같은 기준)를 둔다:
 * 공식 API → 실패·모양 바뀜이면 24시간 안 공식 API 캐시(stale) → 토스 웹 → … (토스 웹 주소는 2026-11 부터 막혀 있어, 이 플래그가 없으면 늘 네이버(KRX만)로 떨어진다).
 * 한 응답 안에서 두 출처를 섞지 않는다. 저장하지 않는다(메모리 캐시만 — 출처가 200일·60일을 다시 준다).
 * 캐시: 종목 300개까지(오래 안 쓴 것부터 버림), 평일 08:00~21:00 KST 10분 · 그 밖 60분 — 그 안의 다음 요청은 출처를 부르지 않는다.
 * 같은 종목 동시 요청은 하나로 묶는다.
 *
 * 대조: 토스 웹 자료를 준 뒤 뒤에서(응답을 기다리게 하지 않음) 종목마다 12시간에 한 번(실패면 1시간 뒤) 토스 Open API 수급 원자료를 받아
 * 최근 20일(오늘 빼고 · Open API 값이 빈 날 빼고) 세 값을 견주고 개수만 다음 응답의 check 에 싣는다. 원자료(날짜별 두 값)는 관리 경로에만 — 토스 Open API 정책(본인 목적, 제3자 배포 금지)
 */

export interface InvestorFlowSources {
  tossWeb: FlowTrendSource;
  naver: FlowTrendSource;
  /** 토스 Open API (키 있을 때만) — 토스 웹 자료와 대조하는 데만 */
  openApi?: { getInvestorFlow(code: string, days: number): Promise<InvestorFlowDay[]> } | null;
  /**
   * 화면 자료로 쓰는 토스 공식 Open API 출처 (키 있을 때만, 플래그 flowOpenApi 가 켜져 있을 때만 부른다).
   * 약관: 토스 Open API 자료는 본인 목적에만 쓴다(제3자 배포 금지) — 이 앱을 한 사람(키 주인)만 쓰는 동안만 켠다. 계정을 여럿 열기 전에 플래그를 끈다
   */
  official?: FlowTrendSource | null;
}

/** 실제 출처 묶음 (buildProviders 가 만든다). 토스 Open API 는 그 인스턴스만 (KIS 는 쓰지 않음) */
export function defaultInvestorFlowSources(openApi: InvestorFlowSources["openApi"], official: FlowTrendSource | null = null): InvestorFlowSources {
  return { tossWeb: new TossTradingTrend(), naver: new NaverInvestorTrend(), openApi: openApi ?? null, official };
}

interface FlowLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface Snap {
  at: number;
  rows: FlowTrendRow[];
  /** 상장 주식 수 (토스 종목 정보 — 외국인 한도율, 모르면 null) */
  listedShares?: number | null;
}

interface Entry {
  /** 토스 공식 Open API (플래그 flowOpenApi) */
  official: Snap | null;
  toss: Snap | null;
  naver: Snap | null;
  /** 마지막으로 응답을 정한 때와 그 출처 — 유효 시간 안에는 출처를 다시 부르지 않는다 */
  last: { at: number; source: FlowOrigin; stale: boolean } | null;
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
    const e = this.cache.get(code) ?? { official: null, toss: null, naver: null, last: null };
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
  private async pick(code: string): Promise<{ source: FlowOrigin; snap: Snap; stale: boolean }> {
    const sources = this.deps.sources;
    if (!sources) throw new AppError(404, "NOT_FOUND", FLOW_TEXT.off);
    const e = this.entry(code);
    const t = this.now().getTime();
    // 공식 Open API 는 플래그가 켜져 있을 때만 — 끄면 받아 둔 공식 자료도 주지 않는다 (끈 그 순간부터 예전 출처 순서 그대로)
    const official = sources.official && (await this.deps.features.enabled("flowOpenApi")) ? sources.official : null;
    const snapOf = (s: FlowOrigin): Snap | null => (s === "toss-openapi" ? (official ? e.official : null) : s === "toss-web" ? e.toss : e.naver);
    if (e.last && t - e.last.at < flowCacheTtlMs(this.now())) {
      const snap = snapOf(e.last.source);
      if (snap) return { source: e.last.source, snap, stale: e.last.stale };
    }
    const served = (source: FlowOrigin, snap: Snap, stale: boolean) => {
      e.last = { at: t, source, stale };
      return { source, snap, stale };
    };
    let why: string;
    if (official) {
      try {
        const rows = await official.trend(code, OPENAPI_TREND_SIZE);
        // 상장 주식 수: 공식 종목 정보(하루 캐시). 모르면 한도율을 보유율로 어림
        const listedShares = official.listedShares ? await official.listedShares(code).catch(() => null) : null;
        e.official = { at: t, rows, listedShares };
        return served("toss-openapi", e.official, false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.log?.warn({ code, source: "toss-openapi", err: msg }, /모양 바뀜/.test(msg) ? "수급 출처 모양 바뀜" : "수급 토스 Open API 출처 실패");
      }
      if (e.official && t - e.official.at < TOSS_KEEP_MS) return served("toss-openapi", e.official, true);
    }
    try {
      const rows = await sources.tossWeb.trend(code, TOSS_TREND_SIZE);
      // 상장 주식 수: trend 가 함께 받아 둔 종목 정보(캐시)라 보통 외부 호출이 늘지 않는다. 모르면 한도율을 보유율로 어림
      const listedShares = sources.tossWeb.listedShares ? await sources.tossWeb.listedShares(code).catch(() => null) : null;
      e.toss = { at: t, rows, listedShares };
      return served("toss-web", e.toss, false);
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
      if (/모양 바뀜/.test(why)) this.deps.log?.warn({ code, source: "toss-web", err: why }, "수급 출처 모양 바뀜");
    }
    if (e.toss && t - e.toss.at < TOSS_KEEP_MS) return served("toss-web", e.toss, true);
    this.deps.log?.warn({ code, reason: why }, "수급 출처를 네이버로 넘김");
    try {
      e.naver = { at: t, rows: await sources.naver.trend(code, NAVER_TREND_SIZE) };
      return served("naver", e.naver, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn({ code, source: "naver", err: msg }, /모양 바뀜/.test(msg) ? "수급 출처 모양 바뀜" : "수급 네이버 출처 실패");
    }
    const keep = [official && e.official ? { source: "toss-openapi" as const, snap: e.official } : null, e.toss ? { source: "toss-web" as const, snap: e.toss } : null, e.naver ? { source: "naver" as const, snap: e.naver } : null]
      .filter((x): x is { source: FlowOrigin; snap: Snap } => x !== null && t - x.snap.at < ANY_KEEP_MS)
      .sort((a, b) => b.snap.at - a.snap.at)[0];
    if (keep) return served(keep.source, keep.snap, true);
    throw new AppError(502, "UPSTREAM", FLOW_TEXT.upstream);
  }

  private async load(code: string): Promise<InvestorFlowResponse> {
    const { source, snap, stale } = await this.pick(code);
    const now = this.now();
    if (source === "toss-web") this.maybeCheck(code, snap);
    return buildFlowBody({ code, source, rows: snap.rows, fetchedAt: new Date(snap.at), stale, check: this.checks.get(code) ?? null, now, listedShares: snap.listedShares ?? null });
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

  /**
   * 대조 한 번: 결과 개수를 기억하고, 다른 날이 있으면 경고 로그(날짜·칸 이름만). 확정 줄은 그 자료를 받은 때 기준.
   * 오늘(한국 날짜)은 빼고 센다 — Open API 의 오늘 값은 저녁까지 잠정·빈 값일 수 있어 '19일 같음'으로 잘못 보이지 않게
   */
  private async compare(code: string, snap: Snap): Promise<FlowCompare> {
    const api = this.deps.sources?.openApi;
    if (!api) throw new Error("토스 Open API 없음");
    const at = this.now();
    const days = await api.getInvestorFlow(code, CHECK_FETCH_DAYS);
    const { final } = splitFlowRows(snap.rows, "toss-web", new Date(snap.at), this.now());
    const c = compareFlows(final, days, FLOW_CHECK_DAYS, { today: kst(at).date });
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
    // 화면 자료가 이미 공식 Open API 면 견줄 것이 없다 (대조는 토스 웹 자료 ↔ Open API)
    if (source === "toss-openapi") return { enabled: true, code, available: false, reason: FLOW_TEXT.sameSource };
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
