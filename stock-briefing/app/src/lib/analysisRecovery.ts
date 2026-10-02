import type { QueryClient } from "@tanstack/react-query";
import type { Api } from "@/api/client";
import type { Analysis, AnalysisKind, FeatureFlags } from "@/api/types";
import { featureOn } from "@/lib/features";
import { sessionFor } from "@/lib/session";

export interface AnalysisWait {
  phase: "idle" | "checking" | "generating" | "recovering" | "unknown";
  startedAt: number;
  requestId?: string;
  message?: string;
  requestError?: string;
}
const IDLE: AnalysisWait = { phase: "idle", startedAt: 0 };
const POLL_MS = 5_000;
const RECOVERY_MS = 10 * 60_000;
// 인증값이 아닌 요청 식별자. 앱 실행마다 임의 접두사, 같은 실행에서는 증가하는 번호를 쓴다.
const REQUEST_SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let requestSequence = 0;
const nextRequestId = () => `a-${REQUEST_SESSION}-${(++requestSequence).toString(36)}`;
export const analysisBusy = (s: AnalysisWait) => s.phase === "checking" || s.phase === "generating" || s.phase === "recovering";

/** 화면을 나갔다 돌아와도 같은 작업을 기다린다. 결과 확인은 생성 API를 다시 부르지 않는다. */
export class AnalysisRecovery {
  private states = new Map<string, AnalysisWait>();
  private jobs = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  private resume = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  disposed = false;

  constructor(private qc: QueryClient, private api: Pick<Api, "getAnalysis" | "analysisState">, private apiUrl: string, private enabled: () => boolean = () => true) {
    this.unsubscribe = qc.getQueryCache().subscribe(() => { if (!this.enabled()) this.dispose(); });
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = (code: string, kind: AnalysisKind): AnalysisWait => this.states.get(`${code}:${kind}`) ?? IDLE;
  private key(code: string, kind: AnalysisKind) { return [this.apiUrl, "analysis", code, kind]; }
  private active() { return !this.disposed && this.enabled(); }
  private update(code: string, kind: AnalysisKind, state: AnalysisWait) {
    if (!this.active()) return;
    this.states.set(`${code}:${kind}`, state);
    for (const listener of this.listeners) listener();
  }
  private save(data: Analysis) { if (this.active()) this.qc.setQueryData(this.key(data.code, data.kind), data); }
  /** 이전 본문을 보존할 뿐 완료로 처리하지 않는다. 다른 종목·종류나 더 오래된 본문은 쓰지 않는다. */
  private preserve(code: string, kind: AnalysisKind, data: Analysis | null) {
    if (!data || data.code !== code || data.kind !== kind) return;
    const shown = this.qc.getQueryData<Analysis>(this.key(code, kind));
    if (!shown || data.id > shown.id) this.save(data);
  }
  private pause() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.waits.delete(timer); resolve(); }, POLL_MS);
      this.waits.set(timer, resolve);
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    for (const [timer, resolve] of this.waits) { clearTimeout(timer); resolve(); }
    this.waits.clear();
  }

  /** 기능을 다시 켤 때 중단했던 요청 ID를 이어받아 새 생성 없이 확인한다. */
  restore(previous: AnalysisRecovery) {
    for (const [key, state] of previous.states) {
      if (state.phase === "idle") continue;
      this.states.set(key, { ...state, phase: "unknown", message: state.message ?? "중단했던 분석의 완료 여부를 다시 확인합니다." });
      if (analysisBusy(state)) this.resume.add(key);
    }
  }

  ensure(code: string, kind: AnalysisKind) {
    if (this.resume.delete(`${code}:${kind}`)) { void this.start(code, kind, false, true); return; }
    const state = this.snapshot(code, kind);
    const cachedAt = this.qc.getQueryState(this.key(code, kind))?.dataUpdatedAt ?? 0;
    if (state.phase !== "idle" || Date.now() - cachedAt < 10 * 60_000) return;
    void this.start(code, kind);
  }

  /** refresh는 사용자가 누른 갱신에만 쓴다. 확인 버튼은 checkOnly로 들어온다. */
  start(code: string, kind: AnalysisKind, refresh = false, checkOnly = false): Promise<void> {
    const key = `${code}:${kind}`;
    const existing = this.jobs.get(key);
    if (existing) return existing;
    if (!this.active()) return Promise.resolve();
    const before = this.snapshot(code, kind);
    const state: AnalysisWait = { phase: checkOnly ? "checking" : "generating", startedAt: Date.now(), requestId: checkOnly ? before.requestId : nextRequestId(), ...(checkOnly ? { requestError: before.requestError } : {}) };
    this.update(code, kind, state);
    // 다음 마이크로태스크에서 실행해 동시 화면 두 개도 같은 Promise를 받게 한다.
    const job = Promise.resolve().then(() => this.run(code, kind, refresh, checkOnly, state)).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }

  private async run(code: string, kind: AnalysisKind, refresh: boolean, checkOnly: boolean, state: AnalysisWait) {
    try {
      if (!this.active()) return;
      if (!state.requestId) {
        this.unknown(code, kind, state);
        return;
      }
      if (!checkOnly) {
        // 생성은 즉시 시작한다. 이전 본문 조회가 느리거나 실패해도 생성과 정상 응답은 기다리지 않는다.
        const request = this.api.getAnalysis(code, kind, refresh, state.requestId);
        let requestSettled = false;
        const completedPeek = new Promise<Analysis>((resolve) => {
          void this.api.analysisState(code, kind, state.requestId).then((peek) => {
            if (!this.active() || this.snapshot(code, kind).requestId !== state.requestId) return;
            const tracked = peek.request;
            if (!requestSettled && tracked && tracked.id === state.requestId && tracked.status === "completed" && tracked.result?.code === code && tracked.result.kind === kind) {
              resolve(tracked.result);
              return;
            }
            // 생성 실패 뒤 도착한 이전 본문도 남긴다. 성공·새 요청 뒤에는 위 요청 ID 검사에서 막힌다.
            this.preserve(code, kind, peek.latest);
          }).catch(() => undefined);
        });
        try {
          // 본 응답이 늦어도 같은 요청의 완료가 확인되면 먼저 받은 결과를 바로 보여 준다.
          const result = await Promise.race([request, completedPeek]);
          requestSettled = true;
          if (!this.active()) return;
          this.save(result);
          this.update(code, kind, IDLE);
          return;
        } catch (error) {
          requestSettled = true;
          state = { ...state, requestError: error instanceof Error ? error.message : "분석 요청에 실패했습니다" };
          // 응답이 끊겨도 서버는 계속 처리할 수 있다. 새 요청 대신 저장된 결과만 확인한다.
        }
      }
      state = { ...state, phase: "recovering" };
      this.update(code, kind, state);
      const deadline = Date.now() + RECOVERY_MS;
      let errors = 0;
      while (this.active()) {
        // 앱이 오래 가려져 타이머가 기한을 넘겼어도 마지막으로 한 번만 읽는다. 새 생성은 하지 않는다.
        const finalCheck = Date.now() >= deadline;
        try {
          const next = await this.api.analysisState(code, kind, state.requestId);
          if (!this.active()) return;
          errors = 0;
          this.preserve(code, kind, next.latest);
          const tracked = next.request;
          if (!tracked || tracked.id !== state.requestId) break;
          if (tracked.status === "completed" && tracked.result?.code === code && tracked.result.kind === kind) {
            this.save(tracked.result);
            this.update(code, kind, IDLE);
            return;
          }
          if (tracked.status === "failed") state = { ...state, requestError: state.requestError ?? "서버에서 분석 요청을 완료하지 못했습니다" };
          if (tracked.status !== "pending") break;
        } catch (error) {
          state = { ...state, requestError: state.requestError ?? (error instanceof Error ? error.message : "서버 상태를 확인하지 못했습니다") };
          if (++errors >= 3) break;
        }
        // 읽는 동안 기한을 넘겼다면 방금 받은 응답이 마지막 확인이다. 기한 뒤 반복은 하지 않는다.
        if (finalCheck || Date.now() >= deadline) break;
        await this.pause();
      }
      this.unknown(code, kind, state);
    } catch (error) {
      this.unknown(code, kind, { ...state, requestError: error instanceof Error ? error.message : "서버 상태를 확인하지 못했습니다" });
    }
  }

  private unknown(code: string, kind: AnalysisKind, state: AnalysisWait) {
    this.update(code, kind, { ...state, phase: "unknown", message: `${state.requestError ? `${state.requestError} · ` : ""}완료 여부를 확인하지 못했습니다. 결과 확인은 AI 분석을 새로 만들지 않습니다.` });
  }
}

const scopes = new WeakMap<QueryClient, { apiUrl: string; credential: string; sessionIdentity: string; recovery: AnalysisRecovery }>();
export function invalidateAnalysisRecoveryScope(qc: QueryClient, apiUrl: string, credential: string) {
  const old = scopes.get(qc);
  if (old && (old.apiUrl !== apiUrl || old.credential !== credential || old.sessionIdentity !== (sessionFor(apiUrl)?.token ?? ""))) old.recovery.dispose();
}
/** 서버·로그인 정보가 바뀌면 이전 요청은 현재 캐시에 쓰거나 추가 조회하지 못한다. */
export function analysisRecoveryFor(qc: QueryClient, api: Api, apiUrl: string, credential: string, sessionIdentity = sessionFor(apiUrl)?.token ?? "") {
  const old = scopes.get(qc);
  const sameScope = old?.apiUrl === apiUrl && old.credential === credential && old.sessionIdentity === sessionIdentity;
  if (old && sameScope && !old.recovery.disposed) return old.recovery;
  old?.recovery.dispose();
  // 계정 정보(/me)만 갱신될 때는 계속 기다리고, 실제 세션이 바뀔 때만 멈춘다. 식별값은 캐시 키에 넣지 않는다.
  const recovery = new AnalysisRecovery(qc, api, apiUrl, () => (sessionFor(apiUrl)?.token ?? "") === sessionIdentity && featureOn(qc.getQueryData<FeatureFlags>([apiUrl, "features"]), "analysisWaitRecovery", false));
  if (old && sameScope) recovery.restore(old.recovery);
  scopes.set(qc, { apiUrl, credential, sessionIdentity, recovery });
  return recovery;
}
